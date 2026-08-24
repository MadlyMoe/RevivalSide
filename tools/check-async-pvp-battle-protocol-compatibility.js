"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const asyncPvp = require("../modules/async-pvp");
const pvpRank = require("../modules/pvp-rank");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeBool,
  writeByte,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { buildPlayerDeckForGameLoad, ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const specialist = "modules\\async-pvp\\handlers\\0000-000-async-pvp.js";
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
for (const packetId of [asyncPvp.PACKETS.TARGET_LIST_REQ, asyncPvp.PACKETS.START_GAME_REQ]) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `packet ${packetId} must use the async-PvP specialist`);
}
assert.deepStrictEqual(asyncPvp.ERRORS, {
  OK: 0,
  INVALID_REQUEST: 20191,
  ITEM_INSUFFICIENT_COUNT: 20332,
  CANNOT_FOUND_TARGET: 20335,
  TARGET_SCORE_CHANGED: 20336,
  TARGET_NOT_FOUND: 20339,
  TARGET_OPERATION_POWER_CHANGED: 20340,
  INVALID_GAME_DATA: 20346,
  REVENGE_ALREADY: 22601,
});

const now = new Date("2026-08-20T12:00:00Z");
const user = makeUser(1, 2);
const target = makeUser(2, 6);
pvpRank.setAsyncPvpState(user, { seasonId: 37, weekId: 8, score: 6000, maxScore: 6000, leagueTierId: 20, maxLeagueTierId: 20 });
pvpRank.setAsyncPvpState(target, { seasonId: 37, weekId: 8, score: 6100, maxScore: 6100, leagueTierId: 20, maxLeagueTierId: 20 });
grantMiscItem(user, asyncPvp.ASYNC_TICKET_ITEM_ID, 3);

const socket = { destroyed: false, session: { user } };
const sent = [];
let saves = 0;
let invalidations = 0;
let missionEvents = 0;
let startCalls = 0;
let startedReplay = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users: { [user.userUid]: user, [target.userUid]: target } },
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => user,
  dateTimeBinaryNow: () => 5250508610427387904n,
  dateTimeTicksNow: () => 639176400000000000n,
  getServerNowDate: () => now,
  getEffectiveOpenTags: () => ["GLOBAL"],
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  trackMissionEvent() { missionEvents += 1; },
  sendGameResponse(_socket, _packet, packetId, payload) { sent.push({ packetId, payload, response: true }); },
  sendServerGamePacket(_socket, packetId, payload) { sent.push({ packetId, payload, response: false }); },
  startAsyncPvpBattle(_socket, _user, _target, req) {
    startCalls += 1;
    startedReplay = { dynamicGame: { gameUID: "2617000000001", gameType: req.gameType } };
    return {
      ok: true,
      replay: startedReplay,
      gameDataPayload: Buffer.from([1, 2, 3]),
      startAckPayload: Buffer.from([4, 5, 6]),
    };
  },
};

assert.strictEqual(asyncPvp.decodeEmptyRequest(ctx, Buffer.alloc(0)), true);
assert.strictEqual(asyncPvp.decodeEmptyRequest(ctx, Buffer.from([0])), false);
assert.deepStrictEqual(asyncPvp.decodeStartRequest(ctx, startRequest(target.friendCode, 0, 20, false)), {
  valid: true,
  targetFriendCode: BigInt(target.friendCode),
  selectDeckIndex: 0,
  gameType: 20,
  simulationGame: false,
});
for (const payload of [
  Buffer.alloc(0),
  startRequest(target.friendCode, 0, 20, false).subarray(0, -1),
  Buffer.concat([startRequest(target.friendCode, 0, 20, false), Buffer.from([0])]),
  Buffer.concat([writeSignedVarLong(BigInt(target.friendCode)), writeByte(0), writeByte(20), Buffer.from([2])]),
]) {
  assert.strictEqual(asyncPvp.decodeStartRequest(ctx, payload).valid, false, "malformed async start must fail");
}

invoke(asyncPvp.PACKETS.START_GAME_REQ, startRequest(target.friendCode, 0, 20, false));
assertAck(asyncPvp.PACKETS.START_GAME_ACK, asyncPvp.ERRORS.CANNOT_FOUND_TARGET);
assert.strictEqual(startCalls, 0, "start without a target-list snapshot must not create a battle");

invoke(asyncPvp.PACKETS.TARGET_LIST_REQ, Buffer.alloc(0));
assertAck(asyncPvp.PACKETS.TARGET_LIST_ACK, 0, false);
assert.strictEqual(socket.session.asyncPvpTargetSession.targets.length, 1);

const originalScore = pvpRank.getAsyncPvpState(target);
pvpRank.setAsyncPvpState(target, { ...originalScore, score: originalScore.score + 1 });
invoke(asyncPvp.PACKETS.START_GAME_REQ, startRequest(target.friendCode, 0, 20, false));
assertAck(asyncPvp.PACKETS.START_GAME_ACK, asyncPvp.ERRORS.TARGET_SCORE_CHANGED);
pvpRank.setAsyncPvpState(target, originalScore);

invoke(asyncPvp.PACKETS.TARGET_LIST_REQ, Buffer.alloc(0));
sent.pop();
target.army.deckSets["6"][0].operationPower += 1;
invoke(asyncPvp.PACKETS.START_GAME_REQ, startRequest(target.friendCode, 0, 20, false));
assertAck(asyncPvp.PACKETS.START_GAME_ACK, asyncPvp.ERRORS.TARGET_OPERATION_POWER_CHANGED);
target.army.deckSets["6"][0].operationPower -= 1;

invoke(asyncPvp.PACKETS.TARGET_LIST_REQ, Buffer.alloc(0));
sent.pop();
const ticketKey = String(asyncPvp.ASYNC_TICKET_ITEM_ID);
user.inventory.misc[ticketKey].countFree = "0";
user.inventory.misc[ticketKey].countPaid = "0";
invoke(asyncPvp.PACKETS.START_GAME_REQ, startRequest(target.friendCode, 0, 20, false));
assertAck(asyncPvp.PACKETS.START_GAME_ACK, asyncPvp.ERRORS.ITEM_INSUFFICIENT_COUNT);
user.inventory.misc[ticketKey].countFree = "3";
assert.strictEqual(getMiscItem(user, asyncPvp.ASYNC_TICKET_ITEM_ID).countFree, "3");

const beforeSaves = saves;
const beforeInvalidations = invalidations;
invoke(asyncPvp.PACKETS.TARGET_LIST_REQ, Buffer.alloc(0));
sent.pop();
invoke(asyncPvp.PACKETS.START_GAME_REQ, startRequest(target.friendCode, 0, 20, false));
assert.strictEqual(startCalls, 1, `valid async start was rejected with ${readSignedVarInt(sent[sent.length - 1].payload, 0).value}`);
assert.deepStrictEqual(sent.filter((entry) => !entry.response).slice(-2).map((entry) => entry.packetId), [2604, 2618], "frozen start order must be 2604 then 2618");
assert.strictEqual(getMiscItem(user, asyncPvp.ASYNC_TICKET_ITEM_ID).countFree, "2");
assert.deepStrictEqual([saves - beforeSaves, invalidations - beforeInvalidations, missionEvents], [1, 1, 1]);
assert.strictEqual(startedReplay.asyncPvpBattle.gameUid, "2617000000001");

const resultReplay = {
  dynamicGame: { gameUID: "2623000000001", gameType: 20 },
  battleState: { gameTime: 30, units: [] },
  asyncPvpBattle: {
    gameUid: "2623000000001",
    targetFriendCode: target.friendCode,
    targetUserUid: target.userUid,
    targetSnapshot: socket.session.asyncPvpTargetSession.targets[0] && {
      ...socket.session.asyncPvpTargetSession.targets[0],
      user: undefined,
      deck: undefined,
      userUid: target.userUid,
    },
    selectDeckIndex: 0,
    gameType: 20,
    simulationGame: false,
    costItem: getMiscItem(user, asyncPvp.ASYNC_TICKET_ITEM_ID),
    resultRecorded: false,
  },
};
const endSocket = { session: { user, gameReplay: resultReplay, asyncPvpTargetSession: socket.session.asyncPvpTargetSession } };
const endPayload = asyncPvp.buildAsyncPvpGameEndNotPayload(ctx, endSocket, resultReplay, { win: true, playTime: 30 });
assert(endPayload && endPayload.length > 0, "async game end must serialize");
assert.strictEqual(readSignedVarInt(endPayload, 0).value, 0, "winning async result must use the frozen win enum");
assert.strictEqual(user.pvp.asyncHistory.length, 1);
assert.strictEqual(resultReplay.asyncPvpBattle.resultRecorded, true);
assert.strictEqual(getMiscItem(user, asyncPvp.PVP_POINT_ITEM_ID).countFree, "75");
assert.strictEqual(pvpRank.getAsyncPvpState(user).seasonPlayCount, 1);
assert.strictEqual(pvpRank.getAsyncPvpState(user).seasonWinCount, 1);
assert.deepStrictEqual([saves, invalidations], [2, 2], "start and result must each save and invalidate exactly once");
assert.strictEqual(asyncPvp.buildPvpHistoryListData(JSON.parse(JSON.stringify(user))).equals(asyncPvp.buildPvpHistoryListData(user)), true);

assertFrozenSources();
const managed = validateManagedSchemas(user, target, endPayload);
console.log(`[async-pvp-battle-check] PASS targets=1 saves=${saves} packets=${managed.packets} managed=on gameLoadBytes=${managed.gameLoadBytes}`);

function invoke(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, errorCode, pop = true) {
  const response = pop ? sent.pop() : sent[sent.length - 1];
  assert(response, `missing ACK ${packetId}`);
  assert.strictEqual(response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, errorCode);
}

function startRequest(friendCode, deckIndex, gameType, simulationGame) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(friendCode)),
    writeByte(deckIndex),
    writeByte(gameType),
    writeBool(simulationGame),
  ]);
}

function makeUser(index, deckType) {
  const value = {
    userUid: String(2615000 + index),
    friendCode: String(26150000 + index),
    nickname: `AsyncBattle${index}`,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2615000000000n + BigInt(index) * 100n),
  };
  ensureArmy(value);
  const units = uniqueBaseUnitIds(8).map((unitId) => grantUnit(value, unitId, { level: 100 }));
  const ship = grantUnit(value, getPlayableShipIds()[index % getPlayableShipIds().length], { level: 100 });
  const operator = grantOperator(value, getPlayableOperatorIds()[index % getPlayableOperatorIds().length], { level: 100 });
  const deck = ensureDeck(value, { deckType, index: 0 });
  deck.unitUids = units.map((unit) => unit.unitUid);
  deck.shipUid = ship.unitUid;
  deck.operatorUid = operator.uid;
  deck.leaderIndex = 0;
  deck.state = 0;
  deck.operationPower = 800000 + index * 1000;
  return value;
}

function uniqueBaseUnitIds(count) {
  const selected = [];
  const bases = new Set();
  for (const unitId of getPlayableUnitIds()) {
    const template = getUnitTemplet(unitId);
    const baseId = Number(template && template.m_BaseUnitID) || unitId;
    if (bases.has(baseId)) continue;
    bases.add(baseId);
    selected.push(unitId);
    if (selected.length === count) break;
  }
  assert.strictEqual(selected.length, count);
  return selected;
}

function validateManagedSchemas(userA, userB, endPayload) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for async-PvP validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  let started = null;
  let packets = 0;
  try {
    const targetListPayload = asyncPvp.buildTargetListAckPayload({
      errorCode: 0,
      targets: asyncPvp.getAsyncPvpTargets({ userDb: { users: { [userA.userUid]: userA, [userB.userUid]: userB } } }, userA),
    });
    for (const [packetId, payload] of [
      [2615, Buffer.alloc(0)],
      [2616, targetListPayload],
      [2617, startRequest(userB.friendCode, 0, 20, false)],
      [2618, asyncPvp.buildStartFailurePayload(asyncPvp.ERRORS.INVALID_REQUEST)],
      [2623, endPayload],
    ]) {
      validatePacket(host, packetId, payload);
      packets += 1;
    }
    const playerDeck = buildPlayerDeckForGameLoad(userA, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 2, index: 0 }, strictSelection: true,
    });
    const playerDeckB = buildPlayerDeckForGameLoad(userB, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 6, index: 0 }, strictSelection: true,
    });
    assert(playerDeck && playerDeckB);
    const legacy = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 11, selectDeckIndex: 0 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 11, playerDeck, playerDeckB },
      gameUID: "2617000000000",
      gameLoadAckPayloadBase64: "",
    });
    assert(legacy.ok && legacy.dynamicGame && legacy.dynamicGame.managedCombat, legacy.error || "legacy async CombatHost start failed");
    const legacyInspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: legacy.payload.toString("base64") });
    assert(legacyInspected.ok, legacyInspected.error || "legacy async GAME_LOAD_ACK inspection failed");
    assert.match(legacyInspected.summary || "", /gameType=NGT_ASYNC_PVP/);
    host.request("disposeBattle", { dynamicGame: legacy.dynamicGame, battleState: legacy.battleState });
    started = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 20, selectDeckIndex: 0 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 20, playerDeck, playerDeckB },
      gameUID: "2617000000001",
      gameLoadAckPayloadBase64: "",
    });
    assert(started.ok && started.dynamicGame && started.dynamicGame.managedCombat, started.error || "async CombatHost start failed");
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: started.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "async GAME_LOAD_ACK inspection failed");
    assert.match(inspected.summary || "", /gameType=NGT_PVP_STRATEGY/);
    const startAck = host.request("buildAsyncPvpStartAck", {
      dynamicGame: started.dynamicGame,
      battleState: started.battleState,
      targetListAckPayloadBase64: targetListPayload.toString("base64"),
      targetFriendCode: userB.friendCode,
      simulationGame: false,
    });
    assert(startAck.ok && startAck.payload, startAck.error || "managed async start ACK failed");
    validatePacket(host, 2618, startAck.payload);
    packets += 1;
    return { packets, gameLoadBytes: started.payload.length };
  } finally {
    if (started && started.dynamicGame) host.request("disposeBattle", { dynamicGame: started.dynamicGame, battleState: started.battleState });
    host.close();
  }
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
  assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
}

function assertFrozenSources() {
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_ASYNC_PVP_TARGET_LIST_REQ.cs"), /Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_ASYNC_PVP_START_GAME_REQ.cs"), /targetFriendCode[\s\S]*selectDeckIndex[\s\S]*gameType[\s\S]*simulationGame/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_ASYNC_PVP_START_GAME_ACK.cs"), /gameData[\s\S]*gameRuntimeData[\s\S]*refreshedTargetData[\s\S]*targetList[\s\S]*skip/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_ASYNC_PVP_GAME_END_NOT.cs"), /result[\s\S]*pvpState[\s\S]*gainPointItem[\s\S]*history[\s\S]*targetList[\s\S]*pointChargeTime[\s\S]*simulationGame/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCPacketSender.cs"), /Send_NKMPacket_ASYNC_PVP_START_GAME_REQ[\s\S]*targetFriendCode[\s\S]*selectDeckIndex[\s\S]*gameType[\s\S]*simulationGame/);
  assert.match(source("combat-host", "ManagedCombatBridge.cs"), /11\s*=>\s*"NGT_ASYNC_PVP"[\s\S]*20\s*=>\s*"NGT_PVP_STRATEGY"/);
  assert.match(source("server", "listener.js"), /asyncPvp\.PACKETS\.GAME_END_NOT[\s\S]*buildAsyncPvpGameEndNotPayload/);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
