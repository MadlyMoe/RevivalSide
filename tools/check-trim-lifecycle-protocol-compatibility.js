"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ERRORS,
  LIFECYCLE_ERRORS,
  PACKETS,
  buildTrimEndAckPayload,
  buildTrimIntervalInfoNotPayload,
  buildTrimRestoreAckPayload,
  buildTrimRetryAckPayload,
  buildTrimStartAckPayload,
  createTrimHandlers,
  endTrim,
  getActiveTrimInterval,
  loadTables,
  prepareTrimGameLoad,
  readTrimState,
  recordTrimBattleResult,
  restoreTrim,
  retryTrim,
  startTrim,
} = require("../modules/trim");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureArmy, grantOperator, grantUnit } = require("../modules/unit");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds } = require("../modules/game-data");
const {
  readSignedVarInt,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const now = new Date("2026-08-20T12:00:00.000Z");
const tables = loadTables();
const active = getActiveTrimInterval(now, tables);
assert(active && active.index === 178);
assert.strictEqual(tables.pointRows.length, 60);
assert.deepStrictEqual(LIFECYCLE_ERRORS, {
  ...ERRORS,
  INVALID_TRIM_RETRY_COUNT: 22809,
  INVALID_TRIM_RESTORE_COUNT: 22810,
  TRIM_END_PROCESSING: 22811,
  OUT_RANGE_TRIM_INDEX: 22813,
});

const handlers = new Map(createTrimHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [1234, 1236, 1238, 1240]) assert(handlers.has(packetId), `missing TRIM handler ${packetId}`);

let response = null;
let saves = 0;
let invalidations = 0;
let fixtureId = 0n;
const wire = [];
const pushes = [];
const missionEvents = [];
const socket = { session: { user: null } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getServerNowDate: () => new Date(now),
  getEffectiveOpenTags: () => ["TAG_COMMON_TRIM_JUNGLE", "TAG_COMMON_TRIM_VOLCANO", "TAG_COMMON_TRIM_RELIC"],
  randomInt: () => 0,
  dateTimeBinaryNow: () => 5250083637907387904n,
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    wire.push([packetId, payload]);
  },
  sendServerGamePacket(_socket, packetId, payload) {
    pushes.push({ packetId, payload });
    wire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  saveUserDb() { saves += 1; },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
};

const malformed = makeFixture();
invoke(malformed, PACKETS.TRIM_START_REQ, Buffer.alloc(0));
assert.strictEqual(ackError(), ERRORS.INVALID_REQUEST);
assert.strictEqual(saves, 0);

const run = makeFixture({ item2: 5000 });
const startPayload = buildStartReq(101, 1, run.decks);
wire.push([PACKETS.TRIM_START_REQ, startPayload]);
invoke(run, PACKETS.TRIM_START_REQ, startPayload);
assert.strictEqual(ackError(), ERRORS.OK);
assert.strictEqual(response.packetId, PACKETS.TRIM_START_ACK);
assert.strictEqual(totalItem(run.user, 2), 4340n, "START must charge the frozen 660 entry cost once");
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);
assert.strictEqual(pushes.at(-1).packetId, PACKETS.TRIM_INTERVAL_INFO_NOT);
assert.deepStrictEqual(missionEvents.map((entry) => [entry.condition, entry.amount]), [["USE_RESOURCE", 660]]);

let state = readTrimState(run.user, { now, tables });
assert.strictEqual(state.trimTryCount, 1);
assert.strictEqual(state.current.nextDungeonId, 7001001);
assert.strictEqual(state.current.lastClearStage, null, "START must leave lastClearStage null so the client plays index 0");
assert.deepStrictEqual(state.current.stageList, []);

const load = prepareTrimGameLoad(run.user, { dungeonID: 7001001 }, {
  dungeonID: 7001001,
  stageId: 7001001,
  miscMode: "trim",
  gameType: 23,
});
assert(load && load.valid);
assert.strictEqual(load.stage.trimLevel, 1);
assert.strictEqual(load.eventDeckData.shipUid, run.decks[0].shipUid);
assert.strictEqual(load.eventDeckData.units[0], run.decks[0].units[0].unitUid);
assert.strictEqual(prepareTrimGameLoad(run.user, { dungeonID: 7001002 }, { dungeonID: 7001002, miscMode: "trim", gameType: 23 }).errorCode, ERRORS.INVALID_TRIM_DUNGEON);

for (const [index, dungeonId, score] of [[0, 7001001, 1100], [1, 7001002, 1200], [2, 7001003, 2400]]) {
  const result = recordTrimBattleResult(run.user, { dungeonId, win: true, trimPoint: score }, { now, tables });
  assert(result.valid && result.changed);
  assert.strictEqual(result.stage.index, index);
  assert.strictEqual(result.stage.score, score);
  state = readTrimState(run.user, { now, tables });
  assert.strictEqual(state.current.lastClearStage.index, index);
  assert.strictEqual(state.current.stageList.length, index);
  assert.strictEqual(state.current.nextDungeonId, index < 2 ? [7001002, 7001003][index] : 0);
}

const beforeEndExp = Number(run.user.totalExp || 0);
const endPayload = writeSignedVarInt(101);
wire.push([PACKETS.TRIM_END_REQ, endPayload]);
invoke(run, PACKETS.TRIM_END_REQ, endPayload);
assert.strictEqual(ackError(), ERRORS.OK);
assert.strictEqual(response.packetId, PACKETS.TRIM_END_ACK);
state = readTrimState(run.user, { now, tables });
assert.strictEqual(state.current, null);
assert.strictEqual(state.clears["101:1"].score, 4700);
assert.strictEqual(Number(run.user.totalExp || 0) - beforeEndExp, 52);
assert.strictEqual(totalItem(run.user, 1062), 1n);
assert.deepStrictEqual(missionEvents.at(-1) && [missionEvents.at(-1).condition, missionEvents.at(-1).amount], ["TRIM_DUNGEON_CLEARED", 1]);
assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);

const restarted = JSON.parse(JSON.stringify(run.user));
assert.strictEqual(readTrimState(restarted, { now, tables }).clears["101:1"].score, 4700);

const failed = makeFixture();
const started = startTrim(ctx, failed.user, { valid: true, trimId: 101, trimLevel: 1, eventDeckList: failed.decks }, { now, tables });
assert.strictEqual(started.errorCode, ERRORS.OK);
const loss = recordTrimBattleResult(failed.user, { dungeonId: 7001001, win: false, trimPoint: 333 }, { now, tables });
assert(loss.valid);
assert.strictEqual(loss.modeState.nextDungeonId, 0);
const failedEnd = endTrim(ctx, failed.user, { valid: true, trimId: 101 }, { now, tables });
assert.strictEqual(failedEnd.errorCode, ERRORS.OK);
assert.strictEqual(failedEnd.trimClearData.isWin, false);
assert.strictEqual(failedEnd.trimClearData.rewardData, null);

const limited = { ...active, weeklyEnterLimit: 3, resultResetLimit: 2, restoreLimitCount: 3, restoreLimitReqItemId: 101, restoreLimitReqItemCounts: [800, 1600, 2400] };
const retry = makeFixture({ retryCount: 2 });
assert.strictEqual(startTrim(ctx, retry.user, { valid: true, trimId: 101, trimLevel: 1, eventDeckList: retry.decks }, { now, tables, interval: limited }).errorCode, ERRORS.OK);
assert(recordTrimBattleResult(retry.user, { dungeonId: 7001001, win: false }, { now, tables }).valid);
const retryResult = retryTrim(ctx, retry.user, { valid: true }, { now, tables, interval: limited });
assert.strictEqual(retryResult.errorCode, ERRORS.OK);
assert.strictEqual(readTrimState(retry.user, { now, tables }).trimRetryCount, 1);
assert.strictEqual(readTrimState(retry.user, { now, tables }).trimTryCount, 0);
assert.strictEqual(readTrimState(retry.user, { now, tables }).current, null);
wire.push([PACKETS.TRIM_RETRY_REQ, Buffer.alloc(0)], [PACKETS.TRIM_RETRY_ACK, buildTrimRetryAckPayload(retryResult)]);

const restore = makeFixture({ tryCount: 3, quartz: 5000 });
const restoreResult = restoreTrim(ctx, restore.user, { valid: true, trimIntervalId: active.index }, { now, tables, interval: limited });
assert.strictEqual(restoreResult.errorCode, ERRORS.OK);
assert.strictEqual(readTrimState(restore.user, { now, tables }).trimTryCount, 2);
assert.strictEqual(readTrimState(restore.user, { now, tables }).trimRestoreCount, 1);
assert.strictEqual(totalItem(restore.user, 101), 4200n);
wire.push(
  [PACKETS.TRIM_RESTORE_REQ, writeSignedVarInt(active.index)],
  [PACKETS.TRIM_RESTORE_ACK, buildTrimRestoreAckPayload(restoreResult)],
  [PACKETS.TRIM_INTERVAL_INFO_NOT, buildTrimIntervalInfoNotPayload(restore.user, { now, tables, interval: limited })]
);

const frozenFloor = makeFixture();
assert.strictEqual(startTrim(ctx, frozenFloor.user, { valid: true, trimId: 101, trimLevel: 1, eventDeckList: frozenFloor.decks }, { now, tables }).errorCode, ERRORS.OK);
assert.strictEqual(recordTrimBattleResult(frozenFloor.user, { dungeonId: 7001001, win: true }, { now, tables }).stage.score, 1000, "missing runtime point must use the frozen stage-clear floor");

wire.push(
  [PACKETS.TRIM_START_ACK, buildTrimStartAckPayload(started)],
  [PACKETS.TRIM_END_ACK, buildTrimEndAckPayload(failedEnd)]
);
validateManagedSchemas();

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert(listenerSource.includes("trim.recordTrimBattleResult(override.user"));
assert(listenerSource.includes("writeNullableObject(trim.buildTrimModeState(trimBattleResult.modeState))"));
assert(listenerSource.includes("trim.buildTrimModeState(user)"));
const gameLoadSource = fs.readFileSync(path.join(rootDir, "packet-handlers", "0801-game-load-req.js"), "utf8");
assert(gameLoadSource.includes("trim.prepareTrimGameLoad(user, req, stage)"));

console.log(`[trim-lifecycle-protocol-check] PASS saves=${saves} packets=${wire.length} pushes=${pushes.length} managed=on`);

function makeFixture(options = {}) {
  fixtureId += 1n;
  const user = {
    userUid: String(981000000000000n + fixtureId),
    nickname: "TrimLifecycleCheck",
    level: 1,
    exp: "0",
    totalExp: "0",
    dungeonClear: { "10806": { dungeonId: 10806 } },
  };
  ensureArmy(user);
  const ships = [0, 1, 2].map(() => grantUnit(user, getPlayableShipIds()[0]));
  const units = [0, 1, 2].map(() => grantUnit(user, getPlayableUnitIds()[0]));
  const operator = grantOperator(user, getPlayableOperatorIds()[0]);
  const decks = ships.map((ship, index) => ({
    shipUid: String(ship.unitUid),
    units: [{ slotIndex: 0, unitUid: String(units[index].unitUid) }],
    operatorUid: index === 0 ? String(operator.uid) : "0",
    leaderIndex: 0,
  }));
  user.miscStages = { trim: {
    intervalTag: active.dateStrId,
    intervalIndex: active.index,
    trimTryCount: options.tryCount || 0,
    trimRetryCount: options.retryCount || 0,
    trimRestoreCount: 0,
    clears: {},
  } };
  setMiscItemBalance(user, 2, options.item2 == null ? 5000 : options.item2);
  setMiscItemBalance(user, 101, options.quartz == null ? 5000 : options.quartz);
  return { user, decks };
}

function buildStartReq(trimId, trimLevel, decks) {
  return Buffer.concat([
    writeSignedVarInt(trimId),
    writeSignedVarInt(trimLevel),
    writeObjectList(decks.map((deck) => writeNullableObject(Buffer.concat([
      writeSignedVarLong(BigInt(deck.shipUid)),
      writeVarInt(deck.units.length),
      ...deck.units.flatMap((unit) => [writeSignedVarInt(unit.slotIndex), writeSignedVarLong(BigInt(unit.unitUid))]),
      writeSignedVarLong(BigInt(deck.operatorUid)),
      writeSignedVarInt(deck.leaderIndex),
    ])))),
  ]);
}

function invoke(fixture, packetId, payload) {
  socket.session.user = fixture.user;
  response = null;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: wire.length + 1, payload }), true);
  assert(response);
}

function ackError() {
  return readSignedVarInt(response.payload, 0).value;
}

function totalItem(user, itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item.countFree || 0) + BigInt(item.countPaid || 0);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for TRIM lifecycle schema validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of wire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected TRIM packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
