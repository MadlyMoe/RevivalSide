"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ERRORS,
  PACKETS,
  buildTrimClearDataList,
  buildTrimIntervalData,
  createTrimHandlers,
  getActiveTrimInterval,
  loadTables,
  readTrimState,
  validateTrimDungeonSkip,
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
assert.strictEqual(tables.templateRows.length, 3, "frozen TRIM template row count changed");
assert.strictEqual(tables.dungeonRows.length, 30, "frozen TRIM dungeon row count changed");
assert.strictEqual(tables.rewardRows.length, 60, "frozen TRIM reward row count changed");
assert.strictEqual(tables.intervalRows.length, 178, "frozen TRIM interval row count changed");
assert.deepStrictEqual(tables.templateRows.map((row) => [row.TrimID, row.m_StageReqItemID, row.m_StageReqItemCount]), [
  [101, 2, 660],
  [102, 2, 660],
  [104, 2, 650],
]);
assert(tables.templateRows.every((row) => row.m_bActiveBattleSkip === true));
const active = getActiveTrimInterval(now, tables);
assert(active);
assert.strictEqual(active.index, 178);
assert.strictEqual(active.dateStrId, "DATE_COMMON_TRIM_175");
assert.deepStrictEqual(active.trimIds, [104, 101, 102]);
assert.strictEqual(active.weeklyEnterLimit, 0, "current frozen interval must remain unlimited");
assert.deepStrictEqual(ERRORS, {
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  INVALID_REQUEST: 20191,
  NEED_DUNGEON_CLEAR: 20799,
  INVALID_SKIP_COUNT: 20805,
  INVALID_TRIM_INTERVAL: 22800,
  EVENT_DECK_LIST_SETTING: 22804,
  INVALID_TRIM_ID: 22805,
  INVALID_TRIM_DUNGEON: 22806,
  OUT_RANGE_TRIM_LEVEL: 22807,
  INVALID_TRIM_TRY_COUNT: 22808,
});

const handlers = new Map(createTrimHandlers().map((handler) => [handler.packetId, handler]));
assert(handlers.has(PACKETS.TRIM_DUNGEON_SKIP_REQ));

let response = null;
let saves = 0;
let invalidations = 0;
let fixtureId = 0n;
const missionEvents = [];
const managedWire = [];
const socket = { session: { user: null } };
let effectiveTags = ["TAG_COMMON_TRIM_JUNGLE", "TAG_COMMON_TRIM_VOLCANO", "TAG_COMMON_TRIM_RELIC"];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getServerNowDate: () => new Date(now),
  getEffectiveOpenTags: () => effectiveTags.slice(),
  randomInt: () => 0,
  dateTimeBinaryNow: () => 5250083637907387904n,
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "trim-dungeon-skip");
    invalidations += 1;
  },
  saveUserDb() { saves += 1; },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
};

failure("truncated", makeFixture, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
failure("trailing", makeFixture, (fixture) => Buffer.concat([request(fixture, 101, 1, 1), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
failure("unknown TRIM", makeFixture, (fixture) => request(fixture, 999, 1, 1), ERRORS.INVALID_TRIM_ID);
failure("level zero", makeFixture, (fixture) => request(fixture, 101, 0, 1), ERRORS.OUT_RANGE_TRIM_LEVEL);
failure("level over max", makeFixture, (fixture) => request(fixture, 101, 21, 1), ERRORS.OUT_RANGE_TRIM_LEVEL);
failure("skip zero", makeFixture, (fixture) => request(fixture, 101, 1, 0), ERRORS.INVALID_SKIP_COUNT);
failure("skip over max", makeFixture, (fixture) => request(fixture, 101, 1, 100), ERRORS.INVALID_SKIP_COUNT);

effectiveTags = [];
failure("closed content tag", makeFixture, (fixture) => request(fixture, 101, 1, 1), ERRORS.INVALID_TRIM_INTERVAL);
effectiveTags = ["TAG_COMMON_TRIM_JUNGLE", "TAG_COMMON_TRIM_VOLCANO", "TAG_COMMON_TRIM_RELIC"];
failure("uncleared level", () => makeFixture({ cleared: false }), (fixture) => request(fixture, 101, 1, 1), ERRORS.NEED_DUNGEON_CLEAR);
failure("two decks", makeFixture, (fixture) => request(fixture, 101, 1, 1, fixture.decks.slice(0, 2)), ERRORS.EVENT_DECK_LIST_SETTING);
failure("missing ship", makeFixture, (fixture) => request(fixture, 101, 1, 1, replaceDeck(fixture, 0, { shipUid: "999999999" })), ERRORS.EVENT_DECK_LIST_SETTING);
failure("empty unit deck", makeFixture, (fixture) => request(fixture, 101, 1, 1, replaceDeck(fixture, 0, { units: [] })), ERRORS.EVENT_DECK_LIST_SETTING);
failure("foreign unit", makeFixture, (fixture) => request(fixture, 101, 1, 1, replaceDeck(fixture, 0, { units: [{ slotIndex: 0, unitUid: "999999999" }] })), ERRORS.EVENT_DECK_LIST_SETTING);
failure("duplicate cross-deck unit", makeFixture, (fixture) => request(fixture, 101, 1, 1, replaceDeck(fixture, 1, { units: fixture.decks[0].units })), ERRORS.EVENT_DECK_LIST_SETTING);
failure("leader outside selected slots", makeFixture, (fixture) => request(fixture, 101, 1, 1, replaceDeck(fixture, 0, { leaderIndex: 7 })), ERRORS.EVENT_DECK_LIST_SETTING);
failure("foreign operator", makeFixture, (fixture) => request(fixture, 101, 1, 1, replaceDeck(fixture, 0, { operatorUid: "999999999" })), ERRORS.EVENT_DECK_LIST_SETTING);
failure("insufficient stage item", () => makeFixture({ itemBalance: 1319 }), (fixture) => request(fixture, 101, 1, 2), ERRORS.INSUFFICIENT_ITEM);

const limited = makeFixture();
limited.user.miscStages.trim.trimTryCount = 2;
const limitedRequest = { valid: true, trimId: 101, trimLevel: 1, skipCount: 2, eventDeckList: limited.decks };
const limitedResult = validateTrimDungeonSkip(ctx, limited.user, limitedRequest, {
  now,
  tables,
  interval: { ...active, weeklyEnterLimit: 3 },
});
assert.strictEqual(limitedResult.errorCode, ERRORS.INVALID_TRIM_TRY_COUNT);

const success = makeFixture({ itemBalance: 3000 });
const beforeExp = Number(success.user.totalExp || 0);
const beforeSaves = saves;
const beforeInvalidations = invalidations;
const beforeMissions = missionEvents.length;
invoke(success, request(success, 101, 1, 2));
assert.strictEqual(ackError(), ERRORS.OK);
assert.strictEqual(saves, beforeSaves + 1, "success must save exactly once");
assert.strictEqual(invalidations, beforeInvalidations + 1, "success must invalidate JOIN exactly once");
assert.deepStrictEqual(missionEvents.slice(beforeMissions).map((entry) => [entry.condition, entry.amount]), [
  ["TRIM_DUNGEON_CLEARED", 2],
  ["USE_RESOURCE", 1320],
]);
assert.strictEqual(totalItem(success.user, 2), 1680n, "TRIM stage item cost must be template cost times skip count");
assert.strictEqual(readTrimState(success.user, { now, tables }).trimTryCount, 2);
assert.strictEqual(readTrimState(success.user, { now, tables }).clears["101:1"].score, 7488, "skip must preserve authoritative best score");
assert.strictEqual(Number(success.user.totalExp || 0) - beforeExp, 104, "two skips must grant the frozen user EXP twice");
assert.strictEqual(totalItem(success.user, 1062), 2n, "fixed TRIM reward must be one item per skip, not the first-clear quantity");
assert.strictEqual(totalItem(success.user, 1), 89400n, "minimum frozen credit boundary must be honored");
assert.strictEqual(totalItem(success.user, 1064), 2n, "first reward-group record must grant once per skip");
assert.strictEqual(totalItem(success.user, 1068), 2n);
assert.strictEqual(totalItem(success.user, 2013), 2n);
assert.strictEqual(totalItem(success.user, 2014), 2n);

const restarted = JSON.parse(JSON.stringify(success.user));
assert.strictEqual(readTrimState(restarted, { now, tables }).trimTryCount, 2, "TRIM interval state must survive JSON restart");
assert.strictEqual(readTrimState(restarted, { now, tables }).clears["101:1"].score, 7488);

const imported = makeFixture({ cleared: false });
imported.user.miscStages.trim = {};
imported.user.officialSnapshot = { packet: {
  trimIntervalData: { trimTryCount: 4, trimRetryCount: 1, trimRestoreCount: 2 },
  trimClearList: [
    { isWin: true, trimId: 101, trimLevel: 1, score: 7488, rewardData: null },
    { isWin: true, trimId: 104, trimLevel: 20, score: 9100, rewardData: null },
  ],
} };
const beforeImported = JSON.stringify(imported.user);
const importedState = readTrimState(imported.user, { now, tables });
assert.strictEqual(importedState.trimTryCount, 4);
assert.strictEqual(importedState.clears["104:20"].score, 9100);
assert.strictEqual(buildTrimClearDataList(imported.user, { now, tables }).length, 2);
assert.strictEqual(buildTrimIntervalData(imported.user, { now, tables }).length, 3);
assert.strictEqual(JSON.stringify(imported.user), beforeImported, "JOIN hydration builders must not mutate imported profiles");

const storedUsers = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
const capturedProfile = Object.values(storedUsers.users || {}).find(
  (user) => Array.isArray(user && user.officialSnapshot && user.officialSnapshot.packet && user.officialSnapshot.packet.trimClearList)
    && user.officialSnapshot.packet.trimClearList.length === 60
);
assert(capturedProfile, "captured imported profile with all 60 authoritative TRIM clears is required");
assert.strictEqual(buildTrimClearDataList(capturedProfile, { now, tables }).length, 60);

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert(listenerSource.includes("writeNullableObject(trim.buildTrimIntervalData(user)), // trimIntervalData"));
assert(listenerSource.includes("writeObjectList(trim.buildTrimClearDataList(user).map(writeNullableObject)), // trimClearList"));

validateManagedSchemas();
console.log(`[trim-dungeon-skip-protocol-check] PASS saves=${saves} packets=${managedWire.length} tables=${tables.templateRows.length}/${tables.dungeonRows.length}/${tables.rewardRows.length} managed=on`);

function makeFixture(options = {}) {
  fixtureId += 1n;
  const user = { userUid: String(980000000000000n + fixtureId), nickname: "TrimSkipCheck", level: 1, exp: "0", totalExp: "0" };
  ensureArmy(user);
  const shipId = getPlayableShipIds()[0];
  const unitId = getPlayableUnitIds()[0];
  const operatorId = getPlayableOperatorIds()[0];
  assert(shipId && unitId && operatorId, "frozen physical roster templates are required");
  const ships = [0, 1, 2].map(() => grantUnit(user, shipId));
  const units = [0, 1, 2].map(() => grantUnit(user, unitId));
  const operator = grantOperator(user, operatorId);
  const decks = ships.map((ship, index) => ({
    shipUid: String(ship.unitUid),
    units: [{ slotIndex: 0, unitUid: String(units[index].unitUid) }],
    operatorUid: index === 0 ? String(operator.uid) : "0",
    leaderIndex: 0,
  }));
  user.miscStages = { trim: {
    intervalTag: "DATE_COMMON_TRIM_175",
    intervalIndex: 178,
    trimTryCount: 0,
    trimRetryCount: 0,
    trimRestoreCount: 0,
    clears: options.cleared === false ? {} : { "101:1": { isWin: true, trimId: 101, trimLevel: 1, score: 7488, rewardData: null } },
  } };
  setMiscItemBalance(user, 2, options.itemBalance == null ? 3000 : options.itemBalance);
  return { user, decks };
}

function request(fixture, trimId, trimLevel, skipCount, decks = fixture.decks) {
  return Buffer.concat([
    writeSignedVarInt(trimId),
    writeSignedVarInt(trimLevel),
    writeSignedVarInt(skipCount),
    writeObjectList(decks.map((deck) => writeNullableObject(eventDeckData(deck)))),
  ]);
}

function eventDeckData(deck) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(deck.shipUid || 0)),
    writeVarInt(deck.units.length),
    ...deck.units.flatMap((unit) => [writeSignedVarInt(unit.slotIndex), writeSignedVarLong(BigInt(unit.unitUid || 0))]),
    writeSignedVarLong(BigInt(deck.operatorUid || 0)),
    writeSignedVarInt(deck.leaderIndex),
  ]);
}

function replaceDeck(fixture, index, patch) {
  return fixture.decks.map((deck, deckIndex) => deckIndex === index ? { ...deck, ...patch } : deck);
}

function failure(label, make, makePayload, expectedError, validateRequest = true) {
  const fixture = make();
  const before = JSON.stringify(fixture.user);
  const counters = [saves, invalidations, missionEvents.length];
  invoke(fixture, typeof makePayload === "function" ? makePayload(fixture) : makePayload, validateRequest);
  assert.strictEqual(ackError(), expectedError, label);
  assert.strictEqual(JSON.stringify(fixture.user), before, `${label} must not mutate profile state`);
  assert.deepStrictEqual([saves, invalidations, missionEvents.length], counters, `${label} must not commit`);
}

function invoke(fixture, payload, validateRequest = true) {
  socket.session.user = fixture.user;
  response = null;
  if (validateRequest) managedWire.push([PACKETS.TRIM_DUNGEON_SKIP_REQ, payload]);
  assert.strictEqual(handlers.get(PACKETS.TRIM_DUNGEON_SKIP_REQ).handle(ctx, socket, {
    packetId: PACKETS.TRIM_DUNGEON_SKIP_REQ,
    sequence: managedWire.length + 1,
    payload,
  }), true);
  assert(response);
  assert.strictEqual(response.packetId, PACKETS.TRIM_DUNGEON_SKIP_ACK);
}

function ackError() {
  return readSignedVarInt(response.payload, 0).value;
}

function totalItem(user, itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for TRIM schema validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected TRIM packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
