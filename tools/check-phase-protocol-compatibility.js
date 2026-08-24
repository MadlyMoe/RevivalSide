"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir, readGameplayTableRecords } = require("../modules/gameplay-jsons");
const { decodeGameLoadRequest } = require("../modules/game-load/request-codec");
const {
  readSignedVarInt,
  readSignedVarLong,
  readBool,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
  writeVarInt,
} = require("../modules/packet-codec");

process.env.CS_LISTENER_TEST_MODE = "1";
process.env.CS_USE_LOCAL_USER_DB = "0";
const { createPacketContext } = require("../server/listener");

const ROOT = path.resolve(__dirname, "..");
const PHASE_START_REQ = 1227;
const PHASE_START_ACK = 1228;
const GAME_END_NOT = 811;
const STANDARD_STAGE_ID = 11663;
const EVENT_STAGE_ID = 6123563;
const INVALID_REQUEST = 20191;
const INVALID_STAGE = 66;
const INSUFFICIENT_ETERNIUM = 97;
const INVALID_EVENT_DECK = 20942;
const SUPPORT_NOT_FOUND = 27803;

const handler = require("../modules/misc-stages/handlers/0000-1221-misc-stage-starts")
  .find((entry) => entry.packetId === PHASE_START_REQ);
const gameLoadHandler = require("../packet-handlers/0801-game-load-req");
assert(handler, "phase checker needs the dedicated 1227 handler");

const ctx = createPacketContext();
ctx.config.USE_LOCAL_USER_DB = true;
ctx.decryptCopy = (payload) => payload;
ctx.decodeGameLoadReq = (payload) => decodeGameLoadRequest(payload);
ctx.logGameLoadReq = () => {};
let response = null;
let saves = 0;
let invalidations = 0;
const managedWire = [];
ctx.saveUserDb = () => { saves += 1; };
ctx.invalidateJoinLobbyAckPayloadCache = (reason) => {
  assert.match(String(reason), /^phase-/);
  invalidations += 1;
};
ctx.sendGameResponse = (_socket, _packet, packetId, payload) => {
  response = { packetId, payload };
  managedWire.push([packetId, payload]);
};

const phaseRows = records("LUA_PHASE_TEMPLET.json");
const orderRows = records("LUA_PHASE_ORDER_TEMPLET.json");
assert(phaseRows.length > 0 && orderRows.length > phaseRows.length, "frozen Phase tables must be populated");
const standardStage = ctx.getGenericStageForRequest({ stageID: STANDARD_STAGE_ID });
const eventStage = ctx.getGenericStageForRequest({ stageID: EVENT_STAGE_ID });
assertPhaseStage(standardStage, 100501, 1005564, 0);
assertPhaseStage(eventStage, 23501, 323612, 323602);

const user = loadUser();
resetPhaseState(user);
const socket = { session: { user, gameReplay: {} } };
const standardRequest = buildPhaseRequest({ stageId: STANDARD_STAGE_ID, deckType: 3, deckIndex: 0 });
const malformed = [
  Buffer.alloc(0),
  standardRequest.subarray(0, standardRequest.length - 1),
  Buffer.concat([standardRequest, Buffer.from([0])]),
  Buffer.concat([Buffer.from([0x81, 0x00]), standardRequest.subarray(1)]),
  buildPhaseRequest({ stageId: STANDARD_STAGE_ID, deckPresentByte: 0 }),
  buildPhaseRequest({ stageId: STANDARD_STAGE_ID, deckPresentByte: 2 }),
  buildPhaseRequest({ stageId: STANDARD_STAGE_ID, eventPresentByte: 2 }),
  buildPhaseRequest({ stageId: STANDARD_STAGE_ID, supportBytes: Buffer.from([0x80, 0x00]) }),
  buildPhaseRequest({ stageId: EVENT_STAGE_ID, deckType: 0, eventDeckEntries: nineEntries() }),
  buildPhaseRequest({ stageId: EVENT_STAGE_ID, deckType: 0, eventDeckEntries: [[0, 1n], [0, 2n]] }),
  buildPhaseRequest({ stageId: EVENT_STAGE_ID, deckType: 0, eventDeckEntries: [[8, 1n]] }),
  buildPhaseRequest({ stageId: EVENT_STAGE_ID, deckType: 0, eventDeckEntries: [[0, 1n]], leaderIndex: 8 }),
];
for (const payload of malformed) {
  const before = snapshot(user);
  send(socket, payload, false);
  assertStartError(INVALID_REQUEST);
  assert.deepStrictEqual(user, before, "malformed Phase start must be profile-pure");
}
assertWrites(0);

send(socket, buildPhaseRequest({ stageId: 999999999, deckType: 3 }), true);
assertStartError(INVALID_STAGE);
assertWrites(0);

const invalidDaily = cloneUser(user);
invalidDaily.army.deckSets["3"] = [];
send({ session: { user: invalidDaily } }, standardRequest, true);
assert.notStrictEqual(startError(), 0, "missing daily deck must fail");
assertWrites(0);

const insufficient = cloneUser(user);
setMiscCount(insufficient, 2, 0n);
send({ session: { user: insufficient } }, standardRequest, true);
assertStartError(INSUFFICIENT_ETERNIUM);
assertWrites(0);

send(socket, buildPhaseRequest({ stageId: STANDARD_STAGE_ID, deckType: 3, supportingUserUid: 999999999999n }), true);
assertStartError(SUPPORT_NOT_FOUND);
assertWrites(0);

const owned = eventSelection(user);
const invalidEvent = buildPhaseRequest({
  stageId: EVENT_STAGE_ID,
  deckType: 0,
  eventDeckEntries: owned.entries.slice(0, 5),
  operatorUid: owned.operatorUid,
  leaderIndex: 0,
});
send(socket, invalidEvent, true);
assertStartError(INVALID_EVENT_DECK);
assertWrites(0);

send(socket, standardRequest, true);
assertStartState({ stageId: STANDARD_STAGE_ID, phaseIndex: 0, dungeonId: 1005564, totalPlayTime: 0, supportingUserUid: 0n });
assertWrites(1);
const restartedAfterStart = cloneUser(user);
assert.deepStrictEqual(snapshot(restartedAfterStart.miscStages.phase), snapshot(user.miscStages.phase));
assert.strictEqual(prepareLoad(restartedAfterStart, STANDARD_STAGE_ID, 1005564).stage.phaseIndex, 0, "Phase state must survive JSON restart");

const invalidLoad = ctx.preparePhaseGameLoad(user, {
  stageID: STANDARD_STAGE_ID,
  dungeonID: 1005562,
  supportingUserUid: 0n,
}, ctx.getGenericStageForRequest({ stageID: STANDARD_STAGE_ID, dungeonID: 1005562 }));
assert(invalidLoad && !invalidLoad.valid && invalidLoad.errorCode === INVALID_REQUEST, "Phase GAME_LOAD must reject a skipped internal dungeon");

const firstLoad = prepareLoad(user, STANDARD_STAGE_ID, 1005564);
assert.strictEqual(firstLoad.stage.phaseIndex, 0);
assert.strictEqual(firstLoad.req.selectDeckIndex, 0);
validateGameLoadIntegration(user, STANDARD_STAGE_ID, 1005564, 0);

const startBalance = miscCount(user, 2);
let replay = phaseReplay(STANDARD_STAGE_ID, 1005564, 91001);
const firstEnd = endPhase(replay, user, true, 11);
assert(replay.phaseBattleResult && replay.phaseBattleResult.valid);
assert.strictEqual(replay.phaseBattleResult.completed, false);
assert.strictEqual(replay.phaseBattleResult.nextState.dungeonId, 1005562);
assert.strictEqual(replay.phaseBattleResult.nextState.phaseIndex, 1);
assert.strictEqual(replay.phaseBattleResult.nextState.totalPlayTime, 11);
assert.strictEqual(miscCount(user, 2), startBalance, "intermediate Phase wins must not spend entry cost");
assert.strictEqual(ctx.maybeRecordDynamicBattleClear(battleSocket(user, replay)), true);
assert.strictEqual(ctx.maybeRecordDynamicBattleClear(battleSocket(user, replay)), false);
assert.deepStrictEqual(ctx.buildDynamicGameEndNotPayload(replay, { user, win: true, managedBattlePlayTime: 11 }), firstEnd, "cached Phase GAME_END must be byte-stable");
prepareLoad(user, STANDARD_STAGE_ID, 1005562);

replay = phaseReplay(STANDARD_STAGE_ID, 1005562, 91002);
endPhase(replay, user, true, 13);
assert.strictEqual(replay.phaseBattleResult.nextState.dungeonId, 1005561);
assert.strictEqual(replay.phaseBattleResult.nextState.phaseIndex, 2);
assert.strictEqual(replay.phaseBattleResult.nextState.totalPlayTime, 24);
assert.strictEqual(miscCount(user, 2), startBalance);
ctx.maybeRecordDynamicBattleClear(battleSocket(user, replay));
prepareLoad(user, STANDARD_STAGE_ID, 1005561);

replay = phaseReplay(STANDARD_STAGE_ID, 1005561, 91003);
endPhase(replay, user, true, 17);
assert.strictEqual(replay.phaseBattleResult.completed, true);
assert.strictEqual(replay.phaseBattleResult.terminated, true);
assert.strictEqual(replay.phaseBattleResult.nextState, null);
assert.strictEqual(user.miscStages.phase, undefined);
assert(user.phaseClearData[String(STANDARD_STAGE_ID)], "terminal Phase win must persist aggregate clear data");
assert.strictEqual(user.phaseClearData[String(STANDARD_STAGE_ID)].bestClearTimeSec, 41);
assert(replay.phaseBattleResult.loot && hasReward(replay.phaseBattleResult.loot.reward), "terminal Phase win must grant frozen Phase rewards");
assert.strictEqual(miscCount(user, 2), startBalance - 610n, "Phase entry cost must be spent exactly once at termination");
assert.strictEqual(ctx.maybeRecordDynamicBattleClear(battleSocket(user, replay)), true);
assert.strictEqual(ctx.maybeRecordDynamicBattleClear(battleSocket(user, replay)), false);
assert.strictEqual(miscCount(user, 2), startBalance - 610n, "duplicate Phase terminal handling must not charge twice");

const lossUser = loadUser();
resetPhaseState(lossUser);
const lossAck = ctx.buildPhaseStartAckPayload({
  valid: true,
  stageId: STANDARD_STAGE_ID,
  deckIndex: { deckType: 3, index: 0 },
  eventDeckData: null,
  supportingUserUid: 0n,
}, lossUser, ctx);
managedWire.push([PHASE_START_ACK, lossAck]);
assert.strictEqual(readSignedVarInt(lossAck, 0).value, 0);
const lossBalance = miscCount(lossUser, 2);
const lossReplay = phaseReplay(STANDARD_STAGE_ID, 1005564, 92001);
endPhase(lossReplay, lossUser, false, 9);
assert.strictEqual(lossReplay.phaseBattleResult.completed, false);
assert.strictEqual(lossReplay.phaseBattleResult.terminated, true);
assert.strictEqual(lossUser.miscStages.phase, undefined);
assert.strictEqual(lossUser.phaseClearData && lossUser.phaseClearData[String(STANDARD_STAGE_ID)], undefined);
assert.strictEqual(miscCount(lossUser, 2), lossBalance - 610n, "failed Phase run must spend its entry cost once");

const eventUser = loadUser();
resetPhaseState(eventUser);
const selected = eventSelection(eventUser);
const eventRequest = buildPhaseRequest({
  stageId: EVENT_STAGE_ID,
  deckType: 0,
  eventDeckEntries: selected.entries,
  operatorUid: selected.operatorUid,
  leaderIndex: 0,
});
send({ session: { user: eventUser } }, eventRequest, true);
assertStartState({ stageId: EVENT_STAGE_ID, phaseIndex: 0, dungeonId: 323612, totalPlayTime: 0, supportingUserUid: 0n });
const eventLoad = prepareLoad(eventUser, EVENT_STAGE_ID, 323612);
assert(eventLoad.req.eventDeckData && Object.keys(eventLoad.req.eventDeckData.units).length === 6);
assert.strictEqual(eventLoad.deckValidation, null);

validateFrozenSources();
validateManagedSchemas();
assert.strictEqual(saves, invalidations, "every Phase start write must invalidate JOIN once");
console.log(`[phase-protocol-check] PASS phases=${phaseRows.length} orders=${orderRows.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(targetSocket, payload, validateRequest) {
  response = null;
  if (validateRequest) managedWire.push([PHASE_START_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, targetSocket, { packetId: PHASE_START_REQ, sequence: 1, payload }), true);
  assert(response && response.packetId === PHASE_START_ACK);
}

function startError() {
  return readSignedVarInt(response.payload, 0).value;
}

function assertStartError(errorCode) {
  assert.strictEqual(startError(), errorCode);
  const error = readSignedVarInt(response.payload, 0);
  const marker = readBool(response.payload, error.offset);
  assert.strictEqual(marker.value, false);
  assert.strictEqual(marker.offset, response.payload.length);
}

function assertStartState(expected) {
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, 0);
  const state = decodePhaseModeState(response.payload, error.offset);
  assert.deepStrictEqual(state.value, expected);
  assert.strictEqual(state.offset, response.payload.length);
}

function decodePhaseModeState(payload, startOffset) {
  const marker = readBool(payload, startOffset);
  assert.strictEqual(marker.value, true);
  const stage = readSignedVarInt(payload, marker.offset);
  const index = readSignedVarInt(payload, stage.offset);
  const dungeon = readSignedVarInt(payload, index.offset);
  assert(dungeon.offset + 4 <= payload.length, "Phase state float is truncated");
  const totalPlayTime = payload.readFloatLE(dungeon.offset);
  const support = readSignedVarLong(payload, dungeon.offset + 4);
  return {
    value: {
      stageId: stage.value,
      phaseIndex: index.value,
      dungeonId: dungeon.value,
      totalPlayTime,
      supportingUserUid: support.value,
    },
    offset: support.offset,
  };
}

function buildPhaseRequest(options = {}) {
  const deckPresentByte = options.deckPresentByte == null ? 1 : Number(options.deckPresentByte);
  const eventEntries = options.eventDeckEntries;
  const eventPresentByte = options.eventPresentByte == null ? (eventEntries ? 1 : 0) : Number(options.eventPresentByte);
  const fields = [writeSignedVarInt(Number(options.stageId || 0)), Buffer.from([deckPresentByte & 0xff])];
  if (deckPresentByte !== 0) {
    fields.push(writeSignedVarInt(Number(options.deckType == null ? 3 : options.deckType)));
    fields.push(Buffer.from([Number(options.deckIndex || 0) & 0xff]));
    fields.push(Buffer.from([eventPresentByte & 0xff]));
    if (eventPresentByte !== 0) {
      const entries = eventEntries || [];
      fields.push(writeSignedVarLong(options.shipUid || 0n));
      fields.push(writeVarInt(entries.length));
      for (const [slot, uid] of entries) {
        fields.push(writeSignedVarInt(Number(slot)));
        fields.push(writeSignedVarLong(uid));
      }
      fields.push(writeSignedVarLong(options.operatorUid || 0n));
      fields.push(writeSignedVarInt(options.leaderIndex == null ? -1 : Number(options.leaderIndex)));
    }
    fields.push(options.supportBytes || writeSignedVarLong(options.supportingUserUid || 0n));
  }
  return Buffer.concat(fields);
}

function prepareLoad(targetUser, stageId, dungeonId) {
  const stage = ctx.getGenericStageForRequest({ stageID: stageId, dungeonID: dungeonId });
  const result = ctx.preparePhaseGameLoad(targetUser, {
    stageID: stageId,
    dungeonID: dungeonId,
    supportingUserUid: 0n,
  }, stage);
  assert(result && result.valid, `Phase GAME_LOAD ${stageId}/${dungeonId} must be valid`);
  assert.strictEqual(result.stage.dungeonID, dungeonId);
  return result;
}

function validateGameLoadIntegration(targetUser, stageId, dungeonId, expectedPhaseIndex) {
  let captured = null;
  ctx.config.DYNAMIC_BATTLE_MANAGER = true;
  ctx.config.REPLAY_CAPTURED_GAME_FLOW = false;
  ctx.sendDynamicGameLoadAck = (_socket, req, stage) => {
    captured = { req, stage };
    return true;
  };
  const payload = buildGameLoadRequest(stageId, dungeonId);
  managedWire.push([801, payload]);
  assert.strictEqual(gameLoadHandler.handle(ctx, { session: { user: targetUser, gameReplay: {} }, write() {} }, {
    packetId: 801,
    sequence: 1,
    payload,
  }), true);
  assert(captured && captured.stage, "Phase GAME_LOAD must reach battle authority");
  assert.strictEqual(captured.req.stageID, stageId);
  assert.strictEqual(captured.req.dungeonID, dungeonId);
  assert.strictEqual(captured.stage.phaseIndex, expectedPhaseIndex);
  assert(captured.stage.playerDeck && captured.stage.playerDeck.units.length > 0, "Phase GAME_LOAD must use the saved daily deck");
}

function buildGameLoadRequest(stageId, dungeonId) {
  return Buffer.concat([
    Buffer.from([0, 0]),
    writeSignedVarInt(stageId),
    writeSignedVarInt(0),
    writeSignedVarInt(dungeonId),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarLong(0n),
    writeBool(false),
    writeSignedVarInt(1),
  ]);
}

function phaseReplay(stageId, dungeonId, gameUID) {
  return {
    dynamicGame: {
      gameUID: String(gameUID),
      gameType: 15,
      miscMode: "phase",
      stageID: stageId,
      dungeonID: dungeonId,
      rewardMultiply: 1,
      playerDeck: { deckType: 3, deckIndex: 0, units: [] },
    },
    battleState: {},
  };
}

function battleSocket(targetUser, replay) {
  return { session: { user: targetUser, gameReplay: replay }, write() {} };
}

function endPhase(replay, targetUser, win, playTime) {
  const payload = ctx.buildDynamicGameEndNotPayload(replay, {
    user: targetUser,
    win,
    managedBattlePlayTime: playTime,
    battleState: { shipHpDamagePercent: win ? 0 : 100 },
  });
  assert(Buffer.isBuffer(payload) && payload.length > 0);
  managedWire.push([GAME_END_NOT, payload]);
  return payload;
}

function eventSelection(targetUser) {
  const daily = targetUser.army.deckSets["3"][0];
  const entries = daily.unitUids.slice(0, 6).map((uid, index) => [index, BigInt(uid)]);
  const operatorUid = BigInt(daily.operatorUid || Object.keys(targetUser.army.operators)[0]);
  assert(entries.length === 6 && entries.every(([, uid]) => uid > 0n));
  assert(operatorUid > 0n);
  return { entries, operatorUid };
}

function assertPhaseStage(stage, phaseId, dungeonId, eventDeckId) {
  assert(stage && stage.gameType === 15 && stage.miscMode === "phase");
  assert.strictEqual(stage.phaseId, phaseId);
  assert.strictEqual(stage.dungeonID, dungeonId);
  assert.strictEqual(stage.eventDeckId, eventDeckId);
}

function loadUser() {
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, "server-data", "users.json"), "utf8"));
  const user = cloneUser(Object.values(db.users || {})[0]);
  assert(user && user.userUid && user.army && user.inventory, "Phase checker needs the local user fixture");
  user.tutorial = { enabled: false, completed: true, loginMode: "post-tutorial" };
  setMiscCount(user, 2, 1000000n);
  return user;
}

function resetPhaseState(targetUser) {
  targetUser.miscStages = targetUser.miscStages && typeof targetUser.miscStages === "object" ? targetUser.miscStages : {};
  delete targetUser.miscStages.phase;
  targetUser.phaseClearData = {};
}

function miscRecord(targetUser, itemId) {
  const misc = targetUser.inventory && targetUser.inventory.misc;
  if (Array.isArray(misc)) return misc.find((item) => Number(item && item.itemId) === Number(itemId));
  return misc && misc[String(itemId)];
}

function miscCount(targetUser, itemId) {
  const item = miscRecord(targetUser, itemId) || {};
  return BigInt(item.countFree || 0) + BigInt(item.countPaid || 0);
}

function setMiscCount(targetUser, itemId, count) {
  const item = miscRecord(targetUser, itemId);
  assert(item, `Phase checker needs inventory item ${itemId}`);
  item.countFree = BigInt(count).toString();
  item.countPaid = "0";
}

function hasReward(reward) {
  if (!reward || typeof reward !== "object") return false;
  return Object.entries(reward).some(([key, value]) => {
    if (key === "userExp") return Number(value || 0) > 0;
    return Array.isArray(value) && value.length > 0;
  });
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function nineEntries() {
  return Array.from({ length: 9 }, (_, index) => [index, BigInt(index + 1)]);
}

function cloneUser(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function records(fileName) {
  return readGameplayTableRecords("ab_script", fileName, { rootDir: ROOT, logLabel: "phase-check" });
}

function validateFrozenSources() {
  const req = read("Assembly-CSharp", "ClientPacket", "Mode", "NKMPacket_PHASE_START_REQ.cs");
  const ack = read("Assembly-CSharp", "ClientPacket", "Mode", "NKMPacket_PHASE_START_ACK.cs");
  const state = read("Assembly-CSharp", "ClientPacket", "Mode", "PhaseModeState.cs");
  for (const field of ["stageId", "deckIndex", "eventDeckData", "supportingUserUid"]) assert(req.includes(`ref this.${field}`));
  for (const field of ["errorCode", "state"]) assert(ack.includes(`ref this.${field}`));
  for (const field of ["stageId", "phaseIndex", "dungeonId", "totalPlayTime", "supportingUserUid"]) assert(state.includes(`ref this.${field}`));
  const sender = read("Assembly-CSharp", "NKC", "NKCPacketSender.cs");
  assert.match(sender, /Send_NKMPacket_PHASE_START_REQ\(int stageId, NKMDeckIndex[\s\S]*eventDeckData = null/);
  assert.match(sender, /Send_NKMPacket_PHASE_START_REQ\(int stageId, NKMEventDeckData[\s\S]*deckIndex = NKMDeckIndex\.None/);
  const receiver = read("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  assert.match(receiver, /OnRecv\(NKMPacket_PHASE_START_ACK[\s\S]*SetPhaseModeState\(sPacket\.state\)[\s\S]*PlayNextPhase\(\)/);
  assert.match(receiver, /SetPhaseModeState\(cPacket_GAME_END_NOT\.phaseModeState\)/);
  const manager = read("Assembly-CSharp", "NKC", "NKCPhaseManager.cs");
  assert.match(manager, /ShouldPlayNextPhase\(\)[\s\S]*PhaseModeState\.dungeonId/);
  assert.match(manager, /Send_NKMPacket_GAME_LOAD_REQ\(0, NKCPhaseManager\.PhaseModeState\.stageId[\s\S]*PhaseModeState\.supportingUserUid/);
  assert.match(read("combat-host", "ManagedCombatBridge.cs"), /"phaseModeState"/);
  const listener = read("server", "listener.js");
  assert.match(listener, /buildPhaseClearDataList\(user\)/);
  assert.match(listener, /const phaseModeState = getSavedPhaseModeState\(user\)/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected Phase packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
