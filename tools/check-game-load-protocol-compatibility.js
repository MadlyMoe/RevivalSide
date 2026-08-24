"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { decodeGameLoadRequest } = require("../modules/game-load/request-codec");
const {
  readSignedVarInt,
  writeBool,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  buildAssistUnitForGameLoad,
  buildPlayerDeckForGameLoad,
  validatePlayerDeckForGameLoad,
} = require("../modules/unit");
const { getUnitTemplet } = require("../modules/game-data");
const { validateGameLoadRewardMultiply } = require("../modules/game-load/authority");
const { getAvailableSupportUsers } = require("../modules/combat-roster");
const { MAIN_STORY_STAGE_CHAIN } = require("../stages/mainStoryStage");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(801);
assert.strictEqual(handler.fileName, "packet-handlers\\0801-game-load-req.js");

const stage = MAIN_STORY_STAGE_CHAIN.find((entry) => !entry.tutorial && !entry.cutsceneOnly && !entry.eventDeckId);
const cutsceneStage = MAIN_STORY_STAGE_CHAIN.find((entry) => entry.cutsceneOnly);
assert(stage && stage.stageId && stage.dungeonID, "standard game-load check needs a playable frozen story stage");
assert(cutsceneStage, "standard game-load check needs a frozen cutscene stage");
const userDb = loadUserDb();
const user = loadUser(userDb);
const socket = { session: { user, gameReplay: {} } };
const packets = [];
let dynamicSucceeds = false;
let dynamicCalls = 0;
let capturedCalls = 0;
let scheduledCalls = 0;
let lastDynamic = null;
let authorityDescriptor = defaultAuthorityDescriptor();
const ctx = {
  constants: { GAME_LOAD_ACK: 804 },
  config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: false },
  capturedGameFlow: null,
  userDb,
  decryptCopy(payload) { return payload; },
  decodeGameLoadReq(payload) { return decodeGameLoadRequest(payload); },
  logGameLoadReq() {},
  getGenericStageForRequest() { return null; },
  getGameLoadStageAuthorityDescriptor() { return authorityDescriptor; },
  maybeSendTutorialCutsceneClear() {},
  logCapturedClientPacketMatch() {},
  sendServerGamePacket(_socket, packetId, payload, label) { packets.push({ packetId, payload, label }); },
  sendDynamicGameLoadAck(_socket, req, activeStage) {
    dynamicCalls += 1;
    lastDynamic = { req, activeStage };
    if (!dynamicSucceeds) return false;
    packets.push({ packetId: 804, payload: gameLoadFailure(0), label: "managed-game-load" });
    return true;
  },
  sendCapturedGameThroughPacketId(_socket, packetId, label) {
    capturedCalls += 1;
    packets.push({ packetId, payload: gameLoadFailure(0), label });
  },
  scheduleCapturedGameAutoAdvance() { scheduledCalls += 1; },
};

const valid = request({ stageID: stage.stageId, dungeonID: stage.dungeonID });
validateDeckAuthority();
validateRewardMultiplyAuthority();
const malformed = [
  Buffer.alloc(0),
  valid.subarray(0, valid.length - 1),
  Buffer.concat([valid, Buffer.from([0])]),
  request({ isDevByte: 2, stageID: stage.stageId, dungeonID: stage.dungeonID }),
  request({ eventPresenceByte: 2, stageID: stage.stageId, dungeonID: stage.dungeonID }),
  request({ stageID: -1, dungeonID: stage.dungeonID }),
  request({ stageID: stage.stageId, dungeonID: stage.dungeonID, rewardMultiply: -1 }),
  request({ stageID: stage.stageId, dungeonID: stage.dungeonID, eventDeckEntries: nineEntries() }),
  request({ stageID: stage.stageId, dungeonID: stage.dungeonID, eventDeckEntries: [[0, 1n], [0, 2n]] }),
  request({ stageID: stage.stageId, dungeonID: stage.dungeonID, eventDeckEntries: [[0, 1n]], leaderIndex: 8 }),
];
for (const payload of malformed) {
  assert.strictEqual(decodeGameLoadRequest(payload), null, "malformed GAME_LOAD_REQ must fail strict decoding");
  reset();
  const before = JSON.stringify(socket.session.user);
  send(payload);
  assertAck(20191, "malformed game load");
  assert.strictEqual(JSON.stringify(socket.session.user), before, "malformed game load must not mutate profile state");
  assert.strictEqual(dynamicCalls, 0);
}

const eventDeckPayload = request({
  stageID: stage.stageId,
  dungeonID: stage.dungeonID,
  eventDeckEntries: [[0, 1001n], [7, 1002n]],
  shipUid: 2001n,
  operatorUid: 3001n,
  leaderIndex: 7,
});
const eventDeckRequest = decodeGameLoadRequest(eventDeckPayload);
assert(eventDeckRequest && eventDeckRequest.hasEventDeckData);
assert.deepStrictEqual(eventDeckRequest.eventDeckData.units, { 0: 1001n, 7: 1002n });
assert.strictEqual(eventDeckRequest.eventDeckData.shipUid, 2001n);
assert.strictEqual(eventDeckRequest.eventDeckData.operatorUid, 3001n);
assert.strictEqual(eventDeckRequest.eventDeckData.leaderIndex, 7);

reset();
send(request({ isDevByte: 1, stageID: stage.stageId, dungeonID: stage.dungeonID }));
assertAck(20191, "network developer load");
assert.strictEqual(dynamicCalls, 0);

reset();
send(request({}));
assertAck(95, "unresolved game load");
assert.strictEqual(dynamicCalls, 0);

reset();
const beforeInvalidSupport = JSON.stringify(user);
send(request({ stageID: stage.stageId, dungeonID: stage.dungeonID, supportingUserUid: 999999999999n }));
assertAck(27803, "unknown support user");
assert.strictEqual(dynamicCalls, 0);
assert.strictEqual(JSON.stringify(user), beforeInvalidSupport, "unknown support user must not mutate the profile");

reset();
ctx.config.REPLAY_CAPTURED_GAME_FLOW = true;
ctx.capturedGameFlow = {};
send(valid);
assertAck(95, "managed host failure");
assert.strictEqual(dynamicCalls, 1);
assert.strictEqual(capturedCalls, 0, "managed host failure must not downgrade into captured 804 success");

reset();
dynamicSucceeds = true;
send(valid);
assert.strictEqual(packets.length, 1);
assert.strictEqual(packets[0].packetId, 804);
assert.strictEqual(dynamicCalls, 1);
assert(lastDynamic && lastDynamic.activeStage.playerDeck && lastDynamic.activeStage.playerDeck.units.length > 0);
assert.strictEqual(lastDynamic.req.stageID, stage.stageId);
assert.strictEqual(lastDynamic.req.dungeonID, stage.dungeonID);

for (const test of [
  {
    label: "reward multiply over maximum",
    rewardMultiply: 4,
    descriptor: { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 3 },
    errorCode: 20394,
  },
  {
    label: "reward multiply unavailable",
    rewardMultiply: 2,
    descriptor: { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 1 },
    errorCode: 20403,
  },
]) {
  assertHandlerFailure(test.label, loadUser(userDb), test.rewardMultiply, test.descriptor, test.errorCode);
}

const dailyLimitedUser = loadUser(userDb);
dailyLimitedUser.stagePlayData = dailyLimitedUser.stagePlayData && typeof dailyLimitedUser.stagePlayData === "object"
  ? dailyLimitedUser.stagePlayData
  : {};
dailyLimitedUser.stagePlayData[String(stage.stageId)] = { playCount: 2 };
assertHandlerFailure(
  "reward multiply daily entry limit",
  dailyLimitedUser,
  2,
  { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 3, enterLimit: 3 },
  20395
);

const insufficientUser = loadUser(userDb);
insufficientUser.inventory.misc["2"] = { itemId: 2, countFree: "3", countPaid: "0" };
assertHandlerFailure(
  "reward multiply insufficient eternium",
  insufficientUser,
  2,
  { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 3, cost: { itemId: 2, count: 2 } },
  97
);

reset();
dynamicSucceeds = true;
authorityDescriptor = { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 3 };
send(request({ stageID: stage.stageId, dungeonID: stage.dungeonID, rewardMultiply: 3 }));
assert.strictEqual(packets.length, 1, "valid reward multiply must reach the managed load path");
assert.strictEqual(lastDynamic.req.rewardMultiply, 3, "managed load must retain the validated reward multiplier");

const support = getAvailableSupportUsers(ctx, user)[0];
assert(support && support.unit, "game-load check needs an available local support unit");
reset();
dynamicSucceeds = true;
send(request({ stageID: stage.stageId, dungeonID: stage.dungeonID, supportingUserUid: support.user.userUid }));
assert.strictEqual(packets.length, 1);
assert.strictEqual(lastDynamic.activeStage.playerDeck.supportingUserUid, String(support.user.userUid));
assert.strictEqual(lastDynamic.activeStage.playerDeck.assistUnits.length, 1);
assert.strictEqual(lastDynamic.activeStage.playerDeck.assistUnits[0].unitUid, String(support.unit.unitUid));

reset();
ctx.config.REPLAY_CAPTURED_GAME_FLOW = true;
ctx.capturedGameFlow = {};
send(request({ stageID: cutsceneStage.stageId, dungeonID: cutsceneStage.dungeonID }));
assert.strictEqual(dynamicCalls, 0, "cutscene-only stage must not start combat authority");
assert.strictEqual(capturedCalls, 1);
assert.strictEqual(scheduledCalls, 1);
assert.strictEqual(packets[0].packetId, 804);

reset();
ctx.config.DYNAMIC_BATTLE_MANAGER = false;
send(valid);
assertAck(95, "missing game-load bootstrap");

validateFrozenSources();
validateManagedRuntime(request({ stageID: stage.stageId, dungeonID: stage.dungeonID, rewardMultiply: 3 }));
console.log(`[game-load-protocol-check] PASS requests=${malformed.length + 11} stage=${stage.stageId}/${stage.dungeonID} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function reset() {
  packets.length = 0;
  dynamicSucceeds = false;
  dynamicCalls = 0;
  capturedCalls = 0;
  scheduledCalls = 0;
  lastDynamic = null;
  ctx.config.DYNAMIC_BATTLE_MANAGER = true;
  ctx.config.REPLAY_CAPTURED_GAME_FLOW = false;
  ctx.capturedGameFlow = null;
  authorityDescriptor = defaultAuthorityDescriptor();
  socket.session.user = user;
  socket.session.gameReplay = {};
}

function defaultAuthorityDescriptor() {
  return {
    authoritative: true,
    allowZeroRewardMultiply: false,
    stageId: stage.stageId,
    dungeonId: stage.dungeonID,
    rewardMultiplyMax: 3,
    enterLimit: 0,
    cost: null,
  };
}

function assertHandlerFailure(label, profile, rewardMultiply, descriptor, errorCode) {
  reset();
  socket.session.user = profile;
  authorityDescriptor = descriptor;
  dynamicSucceeds = true;
  const before = JSON.stringify(profile);
  send(request({ stageID: stage.stageId, dungeonID: stage.dungeonID, rewardMultiply }));
  assertAck(errorCode, label);
  assert.strictEqual(dynamicCalls, 0, `${label} must not reach managed battle authority`);
  assert.strictEqual(JSON.stringify(profile), before, `${label} must not mutate profile state`);
}

function send(payload) {
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 801, sequence: 1, payload }), true);
}

function assertAck(errorCode, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, 804, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(packets[0].payload[error.offset], 0, `${label} gameData must be null`);
  assert.strictEqual(packets[0].payload[error.offset + 1], 0, `${label} cost list must be empty`);
  assert.strictEqual(error.offset + 2, packets[0].payload.length, `${label} ACK must have no trailing fields`);
}

function request(options = {}) {
  const entries = options.eventDeckEntries;
  const hasEventDeck = Array.isArray(entries);
  return Buffer.concat([
    Buffer.from([options.isDevByte == null ? 0 : options.isDevByte, Number(options.selectDeckIndex || 0) & 0xff]),
    writeSignedVarInt(Number(options.stageID || 0)),
    writeSignedVarInt(Number(options.diveStageID || 0)),
    writeSignedVarInt(Number(options.dungeonID || 0)),
    writeSignedVarInt(Number(options.palaceID || 0)),
    writeSignedVarInt(Number(options.fierceBossId || 0)),
    writeSignedVarInt(Number(options.exploreID || 0)),
    writeSignedVarLong(options.supportingUserUid == null ? 0n : BigInt(options.supportingUserUid)),
    Buffer.from([options.eventPresenceByte == null ? (hasEventDeck ? 1 : 0) : options.eventPresenceByte]),
    hasEventDeck ? eventDeck(options) : Buffer.alloc(0),
    writeSignedVarInt(options.rewardMultiply == null ? 1 : Number(options.rewardMultiply)),
  ]);
}

function eventDeck(options) {
  const entries = options.eventDeckEntries || [];
  return Buffer.concat([
    writeSignedVarLong(options.shipUid == null ? 0n : BigInt(options.shipUid)),
    writeVarInt(entries.length),
    ...entries.flatMap(([slot, uid]) => [writeSignedVarInt(slot), writeSignedVarLong(BigInt(uid))]),
    writeSignedVarLong(options.operatorUid == null ? 0n : BigInt(options.operatorUid)),
    writeSignedVarInt(options.leaderIndex == null ? -1 : options.leaderIndex),
  ]);
}

function nineEntries() {
  return Array.from({ length: 9 }, (_, index) => [index, BigInt(index + 1)]);
}

function gameLoadFailure(errorCode) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeObjectList([])]);
}

function loadUserDb() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
}

function loadUser(db = loadUserDb()) {
  const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
  assert(sourceUser && sourceUser.userUid, "game-load check needs a local user fixture");
  sourceUser.tutorial = { enabled: false, completed: true, loginMode: "post-tutorial" };
  return sourceUser;
}

function validateDeckAuthority() {
  assertDeckFailure("missing daily deck", (profile) => {
    profile.army.deckSets["3"] = [];
  }, 56);
  assertDeckFailure("daily deck without ship", (profile) => {
    dailyDeck(profile).shipUid = "0";
  }, 57);
  assertDeckFailure("daily deck with missing unit", (profile) => {
    dailyDeck(profile).unitUids[0] = "9999999999999999";
  }, 58);
  assertDeckFailure("daily deck with duplicate physical unit", (profile) => {
    dailyDeck(profile).unitUids[1] = dailyDeck(profile).unitUids[0];
  }, 59);
  assertDeckFailure("daily deck with duplicate base unit", (profile) => {
    const pair = findOwnedSameBaseUnitPair(profile);
    assert(pair, "game-load check needs two owned units that share a frozen base unit");
    dailyDeck(profile).unitUids = [pair[0], pair[1], 0, 0, 0, 0, 0, 0];
  }, 59);
  assertDeckFailure("daily deck with seized ship", (profile) => {
    profile.army.ships[String(dailyDeck(profile).shipUid)].isSeized = true;
  }, 20319);
  assertDeckFailure("daily deck with seized unit", (profile) => {
    profile.army.units[String(dailyDeck(profile).unitUids[0])].isSeized = true;
  }, 20320);
  assertDeckFailure("empty daily deck", (profile) => {
    dailyDeck(profile).unitUids = Array(8).fill(0);
  }, 61);
  for (const [state, errorCode] of [[1, 162], [2, 213], [3, 330], [99, 450]]) {
    assertDeckFailure(`daily deck state ${state}`, (profile) => {
      dailyDeck(profile).state = state;
    }, errorCode);
  }

  const partial = loadUser(userDb);
  const deck = dailyDeck(partial);
  deck.unitUids = [deck.unitUids[0], 0, 0, 0, 0, 0, 0, 0];
  deck.operatorUid = "0";
  const before = JSON.stringify(partial);
  const validation = validatePlayerDeckForGameLoad(partial, { selectDeckIndex: 0 }, { deckType: 3, requiredState: 0 });
  assert.strictEqual(validation.valid, true, "frozen PvE deck authority must accept a partial non-empty deck");
  assert.strictEqual(JSON.stringify(partial), before, "deck validation must be mutation-free");
  const serialized = buildPlayerDeckForGameLoad(partial, { selectDeckIndex: 0 }, {
    deckIndex: validation.deckIndex,
    strictSelection: true,
  });
  assert(serialized && serialized.units.length === 1, "strict GAME_LOAD serialization must retain the selected partial deck");
  assert.strictEqual(serialized.operatorUid, "0", "strict GAME_LOAD serialization must not inject a fallback operator");
  assert.strictEqual(String(dailyDeck(partial).operatorUid), "0", "strict GAME_LOAD serialization must not persist a fallback operator");
}

function validateRewardMultiplyAuthority() {
  const profile = loadUser(userDb);
  for (const [label, req, descriptor, errorCode] of [
    ["over max", { rewardMultiply: 4 }, { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 3 }, 20394],
    ["not available", { rewardMultiply: 2 }, { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 1 }, 20403],
    ["malformed", { rewardMultiply: -1 }, defaultAuthorityDescriptor(), 20191],
  ]) {
    const before = JSON.stringify(profile);
    const result = validateGameLoadRewardMultiply(profile, req, descriptor);
    assert.strictEqual(result.valid, false, label);
    assert.strictEqual(result.errorCode, errorCode, label);
    assert.strictEqual(JSON.stringify(profile), before, `${label} reward validation must be mutation-free`);
  }
  const accepted = validateGameLoadRewardMultiply(
    profile,
    { rewardMultiply: 3 },
    { ...defaultAuthorityDescriptor(), rewardMultiplyMax: 3 }
  );
  assert.deepStrictEqual(accepted, { valid: true, errorCode: 0, rewardMultiply: 3, cost: null });
}

function assertDeckFailure(label, mutate, errorCode) {
  const profile = loadUser(userDb);
  mutate(profile);
  const before = JSON.stringify(profile);
  const result = validatePlayerDeckForGameLoad(profile, { selectDeckIndex: 0 }, { deckType: 3, requiredState: 0 });
  assert.strictEqual(result.valid, false, label);
  assert.strictEqual(result.errorCode, errorCode, label);
  assert.strictEqual(JSON.stringify(profile), before, `${label} validation must be mutation-free`);
}

function dailyDeck(profile) {
  return profile.army.deckSets["3"][0];
}

function findOwnedSameBaseUnitPair(profile) {
  const byBase = new Map();
  for (const unit of Object.values(profile.army.units || {})) {
    const baseId = frozenBaseUnitId(unit.unitId);
    if (!baseId) continue;
    const previous = byBase.get(baseId);
    if (previous && previous !== String(unit.unitUid)) return [previous, String(unit.unitUid)];
    byBase.set(baseId, String(unit.unitUid));
  }
  return null;
}

function frozenBaseUnitId(unitId) {
  let current = Number(unitId || 0);
  const seen = new Set();
  while (current > 0 && !seen.has(current)) {
    seen.add(current);
    const templet = getUnitTemplet(current);
    if (!templet) return 0;
    const base = Number(templet.m_BaseUnitID || 0);
    if (!base || base === current) return current;
    current = base;
  }
  return 0;
}

function validateFrozenSources() {
  const req = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_LOAD_REQ.cs");
  const ack = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_LOAD_ACK.cs");
  const sender = source("Assembly-CSharp", "NKC", "NKCPacketSender.cs");
  const receiver = source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  for (const field of [
    "isDev", "selectDeckIndex", "stageID", "diveStageID", "dungeonID", "palaceID",
    "fierceBossId", "exploreID", "supportingUserUid", "eventDeckData", "rewardMultiply",
  ]) assert(req.includes(`ref this.${field}`));
  for (const field of ["errorCode", "gameData", "costItemDataList"]) assert(ack.includes(`ref this.${field}`));
  assert(sender.includes("nkmpacket_GAME_LOAD_REQ.isDev = false"));
  const loadReceiver = methodSource(receiver, "public static void OnRecv(NKMPacket_GAME_LOAD_ACK", "public static void OnRecv(NKMPacket_GAME_RESTART_ACK");
  assert(loadReceiver.includes("cNKMPacket_GAME_LOAD_ACK.costItemDataList.Count > 0"));
  assert(!loadReceiver.includes("m_InventoryData.UpdateItemInfo"), "804 must not be treated as an inventory update");
  const gameClient = source("Assembly-CSharp", "NKC", "NKCGameClient.cs");
  assert(gameClient.includes("this.MultiplyReward = cNKMPacket_GAME_LOAD_COMPLETE_ACK.rewardMultiply"));
  assert(gameClient.includes("this.GetGameHud().SetMultiply(this.MultiplyReward)"));
  const deckAuthority = source("Assembly-CSharp", "NKM", "NKMMain.cs");
  for (const token of [
    "NEC_FAIL_SELECT_DECK_INDEX_INVALID",
    "CheckHasDuplicateUnit",
    "NEC_FAIL_DECK_NO_SHIP",
    "NEC_FAIL_SEIZED_SHIP_IN_DECK",
    "NEC_FAIL_SEIZED_UNIT_IN_DECK",
    "NEC_FAIL_DECK_NOT_ENOUGH_UNIT_COUNT",
    "NKMGame.IsPVP(gameType) && num != 8",
  ]) assert(deckAuthority.includes(token));
  const readyScene = source("Assembly-CSharp", "NKC", "NKC_SCEN_DUNGEON_ATK_READY.cs");
  assert(readyScene.includes("this.m_UsedDeckType = NKM_DECK_TYPE.NDT_DAILY"));
  const listener = source("server", "listener.js");
  assert(listener.includes("return decodeGameLoadRequest(payload, decryptCopy);"));
  const handlerSource = source("packet-handlers", "0801-game-load-req.js");
  assert(handlerSource.includes("game-load-host-failure"));
  assert(handlerSource.includes("game-load-stage-unresolved"));
}

function methodSource(contents, startMarker, endMarker) {
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  assert(start >= 0 && end > start, `frozen method markers not found: ${startMarker}`);
  return contents.slice(start, end);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}

function validateManagedRuntime(validRequest) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    openTags: ["UNIT_REACTOR"],
    timeoutMs: 30000,
  });
  let state = null;
  try {
    for (const [packetId, payload] of [[801, validRequest], [804, gameLoadFailure(95)]]) {
      const validation = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(validation.ok, validation.error || `managed client schema rejected game-load packet ${packetId}`);
    }
    const managedDb = loadUserDb();
    const managedUser = loadUser(managedDb);
    managedDb.users[managedUser.userUid] = managedUser;
    const selectedUnitUid = String(dailyDeck(managedUser).unitUids[0]);
    const selectedUnit = managedUser.army.units[selectedUnitUid];
    assert(selectedUnit, "managed game-load check needs its selected physical unit");
    selectedUnit.loyalty = 10000;
    selectedUnit.isPermanentContract = true;
    selectedUnit.reactorLevel = 1;
    const selectedShipUid = String(dailyDeck(managedUser).shipUid);
    const selectedShip = managedUser.army.ships[selectedShipUid];
    assert(selectedShip, "managed game-load check needs its selected physical ship");
    selectedShip.shipCommandModules = [{ slots: [{
      targetStyleType: [],
      targetRoleType: [],
      statType: "NST_HP_FACTOR",
      statValue: 0.05,
      isLock: true,
    }, null] }];
    const playerDeck = buildPlayerDeckForGameLoad(managedUser, { selectDeckIndex: 0 });
    assert(playerDeck && playerDeck.units.length, "managed game-load check needs a playable deck");
    assert(playerDeck.operatorId > 0 && BigInt(playerDeck.operatorUid) > 0n, "managed game-load check needs an equipped operator");
    assert.strictEqual(playerDeck.units[0].loyalty, 10000, "GAME_LOAD must serialize unit loyalty");
    assert.strictEqual(playerDeck.units[0].isPermanentContract, true, "GAME_LOAD must serialize permanent-contract state");
    assert.strictEqual(playerDeck.units[0].reactorLevel, 1, "GAME_LOAD must serialize unit reactor level");
    assert(playerDeck.shipLimitBreakLevel > 0, "managed game-load check needs ship limit-break progression");
    assert(playerDeck.shipSkillLevels.some((level) => level > 1), "managed game-load check needs upgraded ship skills");
    assert(playerDeck.shipCommandModules.length > 0, "managed game-load check needs ship command modules");
    const managedSupport = getAvailableSupportUsers({ userDb: managedDb }, managedUser)[0];
    assert(managedSupport && managedSupport.unit, "managed game-load check needs an available support unit");
    const assist = buildAssistUnitForGameLoad(managedSupport.user, managedSupport.unit);
    assert(assist, "managed game-load check could not serialize its support unit");
    playerDeck.supportingUserUid = String(managedSupport.user.userUid);
    playerDeck.assistUnits = [assist.unit];
    playerDeck.equipItems = [...playerDeck.equipItems, ...assist.equipItems];
    state = host.request("startBattle", {
      req: decodeGameLoadRequest(validRequest),
      stage: { ...stage, playerDeck },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat && state.payload, state.error || "managed standard GAME_LOAD did not start");
    const validation = host.request("validatePacket", { packetId: 804, payloadBase64: state.payload.toString("base64") });
    assert(validation.ok, validation.error || "managed client schema rejected authoritative GAME_LOAD_ACK");
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: state.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "managed GAME_LOAD_ACK inspection failed");
    assert.match(inspected.summary || "", new RegExp(`dungeonID=${stage.dungeonID}`));
    assert.match(inspected.summary || "", /gameType=NGT_DUNGEON/);
    assert.match(inspected.summary || "", new RegExp(`assists=1\\[[^\\]]*${managedSupport.unit.unitUid}`));
    assert.match(
      inspected.summary || "",
      new RegExp(`ship=${playerDeck.shipUnitId}:${playerDeck.shipUid}[^;]*lv=${playerDeck.shipLevel} lb=${playerDeck.shipLimitBreakLevel} tactic=${playerDeck.shipTacticLevel}[^;]*skills=\\[${playerDeck.shipSkillLevels.join(",")}\\] modules=${playerDeck.shipCommandModules.length}\\[`),
      "managed GAME_LOAD must hydrate ship limit break, skills, and command modules"
    );
    assert.match(inspected.summary || "", /modules=3\[NST_HP_FACTOR:0\.05:True,null;/, "managed GAME_LOAD must hydrate an authentic command-module socket");
    assert.match(
      inspected.summary || "",
      new RegExp(`${playerDeck.units[0].unitId}:${playerDeck.units[0].unitUid}[^;]*loyalty=10000 permanent=True reactor=1:${playerDeck.units[0].unitId}:loaded:active=True[^;]*contract=0\\.02`),
      "managed GAME_LOAD must hydrate contract and a loaded reactor templet"
    );
    assert.match(
      inspected.summary || "",
      new RegExp(`operator=${playerDeck.operatorId}:${playerDeck.operatorUid} lv=${playerDeck.operatorLevel} main=${playerDeck.operatorMainSkillId}:${playerDeck.operatorMainSkillLevel} sub=${playerDeck.operatorSubSkillId}:${playerDeck.operatorSubSkillLevel}`),
      "managed GAME_LOAD must hydrate the equipped operator and exact skill levels"
    );
    assert.match(
      inspected.summary || "",
      new RegExp(`tactical=1\\[${playerDeck.operatorMainSkillId}:${playerDeck.operatorMainSkillLevel}\\]`),
      "managed GAME_LOAD must expose the selected operator tactical command"
    );
    assert.strictEqual(Number(state.dynamicGame.rewardMultiply), 3, "managed dynamic game must preserve rewardMultiply");
    const initial = host.request("buildInitialSync", { dynamicGame: state.dynamicGame, battleState: state.battleState });
    assert(initial.ok, initial.error || "managed standard GAME_LOAD initial sync failed");
    const loadComplete = (initial.packets || []).find((packet) => Number(packet.packetId) === 808);
    assert(loadComplete, "managed standard GAME_LOAD must emit load-complete ACK 808");
    const completed = host.request("inspectGameLoadCompleteAck", {
      packetId: 808,
      payloadBase64: loadComplete.payload.toString("base64"),
    });
    assert(completed.ok, completed.error || "managed load-complete ACK inspection failed");
    assert.match(completed.summary || "", /rewardMultiply=3/);
    state = {
      ...state,
      dynamicGame: initial.dynamicGame || state.dynamicGame,
      battleState: initial.battleState || state.battleState,
    };
    const primed = host.request("buildTimeline", { dynamicGame: state.dynamicGame, battleState: state.battleState, delta: 1 / 30, maxFrames: 150, startIndex: 0 });
    assert(primed.ok, primed.error || "managed operator battle did not reach play state");
    state = { ...state, dynamicGame: primed.dynamicGame || state.dynamicGame, battleState: primed.battleState || state.battleState };
    const deployed = host.request("handleDeploy", {
      dynamicGame: state.dynamicGame,
      battleState: state.battleState,
      teamType: 1,
      req: { unitUID: String(playerDeck.units[0].unitUid), assistUnit: false, respawnPosX: -900, gameTime: 4 },
    });
    assert(deployed.ok, deployed.error || "managed operator passive deployment failed");
    state = { ...state, dynamicGame: deployed.dynamicGame || state.dynamicGame, battleState: deployed.battleState || state.battleState };
    const live = host.request("buildSync", { dynamicGame: state.dynamicGame, battleState: state.battleState, delta: 1 / 30 });
    assert(live.ok, live.error || "managed operator live-state probe failed");
    assert.match(live.summary || "", /operator=\d+:\d+:main=\d+:sub=\d+:passive=ready:/, "managed runtime must resolve the operator passive condition");
    assert.match(
      live.summary || "",
      new RegExp(`tactical=1\\[${playerDeck.operatorMainSkillId}:${playerDeck.operatorMainSkillLevel}\\]`),
      "managed runtime must retain the operator tactical command after battle start"
    );
    assert.match(live.summary || "", /buffs=[1-9]\d*\[[^\]]*BUFF_OPR_[^\]]*\]/, "managed runtime must apply an operator passive buff");
  } finally {
    if (state && state.dynamicGame) host.request("disposeBattle", { dynamicGame: state.dynamicGame, battleState: state.battleState });
    host.close();
  }
}
