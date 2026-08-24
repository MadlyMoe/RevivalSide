"use strict";

const assert = require("assert");
const path = require("path");
const {
  PACKETS,
  ERROR_CODES,
  buildShadowPalaceBattleResultPayload,
  createShadowPalaceHandlers,
  recordShadowPalaceBattleResult,
  validateShadowPalaceBattleSelection,
} = require("../modules/shadow-palace");
const gameLoadHandler = require("../packet-handlers/0801-game-load-req");
const { ensureInventory, getMiscItem, grantMiscItem } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir, readGameplayTableRecords } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const handlers = new Map(createShadowPalaceHandlers().map((handler) => [handler.packetId, handler]));
const socket = { session: { user: null } };
const managedWire = [];
const missionEvents = [];
let response = null;
let saves = 0;
let invalidations = 0;
let missionRefreshes = 0;
let missionNotifications = 0;
let userSequence = 0;

const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 0n,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(["shadow-palace-start", "shadow-palace-giveup", "shadow-palace-skip"].includes(reason));
    invalidations += 1;
  },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
  refreshMissionProgress() { missionRefreshes += 1; },
  sendTrackedMissionUpdate(_socket, _user, options) {
    assert(["shadow-palace-start-mission-update", "shadow-palace-skip-mission-update"].includes(options.label));
    missionNotifications += 1;
    return true;
  },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 1);
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};

const palaceRows = readGameplayTableRecords("ab_script", "LUA_SHADOW_PALACE_TEMPLET.json", { rootDir });
const battleRows = readGameplayTableRecords("ab_script", "LUA_SHADOW_BATTLE_TEMPLET.json", { rootDir });
assert.strictEqual(palaceRows.length, 5, "frozen Shadow Palace table count changed");
assert.strictEqual(battleRows.length, 25, "frozen Shadow Palace battle table count changed");
assert.strictEqual(Number(palaceRows[0].m_RewardMultiplyMax), 10);

startFailure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
startFailure("trailing", ticketedUser, () => Buffer.concat([startRequest(1001), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
startFailure("unknown palace", ticketedUser, () => startRequest(999999), ERROR_CODES.INVALID_MAIN_ID);
startFailure("active run", () => activeUser(1001, { complete: true }), () => startRequest(1001), ERROR_CODES.DOING);
startFailure("player level locked", () => ticketedUser({ level: 0 }), () => startRequest(1001), ERROR_CODES.INVALID_MAIN_ID);
startFailure("previous palace locked", ticketedUser, () => startRequest(1002), ERROR_CODES.INVALID_MAIN_ID);
startFailure("insufficient ticket", () => completeUser({ ticketBalance: [0, 0] }), () => startRequest(1001), ERROR_CODES.INSUFFICIENT_ITEM);

giveupFailure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
giveupFailure("trailing", () => activeUser(1001), () => Buffer.concat([giveupRequest(1001), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
giveupFailure("unknown palace", createUser, () => giveupRequest(999999), ERROR_CODES.INVALID_MAIN_ID);
giveupFailure("no active run", completeUser, () => giveupRequest(1001), ERROR_CODES.INVALID_MAIN_ID);
giveupFailure("active palace mismatch", () => activeUser(1002), () => giveupRequest(1001), ERROR_CODES.INVALID_MAIN_ID);

skipFailure("truncated", completeUser, Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
skipFailure("trailing", completeUser, () => Buffer.concat([skipRequest(1001, 1), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
skipFailure("unknown palace", completeUser, () => skipRequest(999999, 1), ERROR_CODES.INVALID_MAIN_ID);
skipFailure("active run", () => activeUser(1001, { complete: true }), () => skipRequest(1001, 1), ERROR_CODES.DOING);
skipFailure("zero count", completeUser, () => skipRequest(1001, 0), ERROR_CODES.INVALID_REQUEST);
skipFailure("negative count", completeUser, () => skipRequest(1001, -1), ERROR_CODES.INVALID_REQUEST);
skipFailure("over table maximum", completeUser, () => skipRequest(1001, 11), ERROR_CODES.REWARD_MULTIPLY_OVER_MAX);
skipFailure("no clear record", createUser, () => skipRequest(1001, 1), ERROR_CODES.MULTIPLY_CLEAR_DUNGEON);
skipFailure("incomplete palace", () => completeUser({ omitDungeonId: 2005 }), () => skipRequest(1001, 1), ERROR_CODES.MULTIPLY_CLEAR_DUNGEON);
skipFailure("zero best time", () => completeUser({ zeroTimeDungeonId: 2003 }), () => skipRequest(1001, 1), ERROR_CODES.MULTIPLY_CLEAR_DUNGEON);
skipFailure("insufficient ticket", () => completeUser({ ticketBalance: [1, 1] }), () => skipRequest(1001, 3), ERROR_CODES.INSUFFICIENT_ITEM);
assertNoCommits();

const lifecycleUser = completeUser({ ticketBalance: [2, 4] });
const previousBestTimes = lifecycleUser.miscStages.shadow.palaces["1001"].dungeonDataList.map((entry) => entry.bestTime);
send(PACKETS.SHADOW_PALACE_START_REQ, lifecycleUser, startRequest(1001));
const startAck = readStartAck();
assert.strictEqual(startAck.errorCode, ERROR_CODES.OK);
assert.strictEqual(startAck.palaceId, 1001);
assert.strictEqual(startAck.rewardMultiply, 1);
assert.deepStrictEqual(startAck.costItems.map(stripItemMetadata), [{ itemId: 19, countFree: 1n, countPaid: 4n }]);
assert.strictEqual(lifecycleUser.miscStages.shadow.currentPalaceId, 1001);
assert.strictEqual(lifecycleUser.miscStages.shadow.life, 3);
assert.strictEqual(lifecycleUser.miscStages.shadow.rewardMultiply, 1);
assert.strictEqual(lifecycleUser.miscStages.shadow.palaces["1001"].currentDungeonId, 0);
assert.deepStrictEqual(
  lifecycleUser.miscStages.shadow.palaces["1001"].dungeonDataList.map((entry) => entry.recentTime),
  [0, 0, 0, 0, 0]
);
assert.deepStrictEqual(
  lifecycleUser.miscStages.shadow.palaces["1001"].dungeonDataList.map((entry) => entry.bestTime),
  previousBestTimes
);

const giveupProgressBefore = JSON.parse(JSON.stringify(lifecycleUser.miscStages.shadow.palaces));
send(PACKETS.SHADOW_PALACE_GIVEUP_REQ, lifecycleUser, giveupRequest(1001));
const giveupAck = readGiveupAck();
assert.deepStrictEqual(giveupAck, { errorCode: ERROR_CODES.OK, palaceId: 1001 });
assert.strictEqual(lifecycleUser.miscStages.shadow.currentPalaceId, 0);
assert.deepStrictEqual(lifecycleUser.miscStages.shadow.palaces, giveupProgressBefore, "giveup must preserve recorded palace times");
assert.strictEqual(JSON.parse(JSON.stringify(lifecycleUser)).miscStages.shadow.currentPalaceId, 0, "giveup must survive restart");

const oneSkipUser = completeUser({ ticketBalance: [2, 4] });
skipSuccess(oneSkipUser, 1, {
  ticket: { itemId: 19, countFree: 1n, countPaid: 4n },
  totals: { 1: 108000n, 20: 15n, 2013: 20n },
});

const threeSkipUser = completeUser({ ticketBalance: [2, 4] });
skipSuccess(threeSkipUser, 3, {
  ticket: { itemId: 19, countFree: 0n, countPaid: 3n },
  totals: { 1: 324000n, 20: 45n, 2013: 60n },
});

const noActiveSelection = validateShadowPalaceBattleSelection(createUser(), 1001, 2001);
assert.strictEqual(noActiveSelection.errorCode, ERROR_CODES.INVALID_MAIN_ID);
const firstBattleUser = activeUser(1001);
assert.deepStrictEqual(
  validateShadowPalaceBattleSelection(firstBattleUser, 1001, 2001),
  { errorCode: ERROR_CODES.OK, valid: true, palaceId: 1001, dungeonId: 2001, dungeonIds: [2001, 2002, 2003, 2004, 2005] }
);
assert.strictEqual(
  validateShadowPalaceBattleSelection(firstBattleUser, 1001, 2005).errorCode,
  ERROR_CODES.DUNGEON_NOT_MATCHED
);
const noLifeUser = activeUser(1001);
noLifeUser.miscStages.shadow.life = 0;
assert.strictEqual(
  validateShadowPalaceBattleSelection(noLifeUser, 1001, 2001).errorCode,
  ERROR_CODES.NOT_ENOUGH_LIFE
);

let gameLoadFailure = null;
assert.strictEqual(
  gameLoadHandler.handle(
    {
      constants: { GAME_LOAD_ACK: 804 },
      decodeGameLoadReq: () => ({ stageID: 0, dungeonID: 2001, palaceID: 1001, fierceBossId: 0, diveStageID: 0 }),
      logGameLoadReq() {},
      sendServerGamePacket(_socket, packetId, payload, label) {
        gameLoadFailure = { packetId, payload, label };
      },
    },
    { session: { user: createUser() } },
    { payload: Buffer.alloc(0) }
  ),
  true
);
assert(gameLoadFailure, "invalid Shadow Palace game load must send an ACK");
assert.strictEqual(gameLoadFailure.packetId, 804);
assert.strictEqual(gameLoadFailure.label, "shadow-palace-game-load-rejected");
assert.deepStrictEqual(readGameLoadFailure(gameLoadFailure.payload), {
  errorCode: ERROR_CODES.INVALID_MAIN_ID,
  hasGameData: false,
  respawnCount: 0,
});
managedWire.push([804, gameLoadFailure.payload]);

const resumeUser = activeUser(1001);
resumeUser.miscStages.shadow.palaces["1001"] = { palaceId: 1001, currentDungeonId: 2002, dungeonDataList: [] };
let resumedRequest = null;
assert.strictEqual(
  gameLoadHandler.handle(
    {
      config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: false },
      decodeGameLoadReq: () => ({
        stageID: 0,
        dungeonID: 2002,
        palaceID: 1001,
        fierceBossId: 0,
        diveStageID: 0,
        eventDeckData: null,
        selectDeckIndex: 0,
      }),
      getGenericStageForRequest(req) {
        assert.strictEqual(req.dungeonID, 2002, "game load must resolve the saved next Shadow dungeon");
        return { stageId: 2002, dungeonID: 2002, gameType: 13, miscMode: "shadow", palaceID: 1001 };
      },
      logGameLoadReq() {},
      sendDynamicGameLoadAck(_socket, req, stage) {
        resumedRequest = { req: { ...req }, stage: { ...stage } };
        return true;
      },
    },
    { session: { user: resumeUser } },
    { payload: Buffer.alloc(0) }
  ),
  true
);
assert(resumedRequest, "valid Shadow Palace game load must reach dynamic battle startup");
assert.strictEqual(resumedRequest.req.dungeonID, 2002);
assert.strictEqual(resumedRequest.stage.dungeonID, 2002);

const fullRunUser = activeUser(1001);
const runTimes = [31, 32, 33, 34, 35];
let finalReplay = null;
let finalResult = null;
for (let index = 0; index < runTimes.length; index += 1) {
  const replay = {};
  const dungeonId = 2001 + index;
  const result = recordShadowPalaceBattleResult(ctx, fullRunUser, {
    palaceId: 1001,
    dungeonId,
    win: true,
    playTime: runTimes[index],
    replay,
  });
  const decoded = readShadowBattleResult(buildShadowPalaceBattleResultPayload(result));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(decoded.palaceId, 1001);
  assert.strictEqual(decoded.dungeonData.dungeonId, dungeonId);
  assert.strictEqual(decoded.dungeonData.recentTime, runTimes[index]);
  assert.strictEqual(decoded.currentDungeonId, index < 4 ? dungeonId + 1 : 0);
  assert.strictEqual(decoded.life, 3);
  assert.strictEqual(fullRunUser.miscStages.shadow.currentPalaceId, index < 4 ? 1001 : 0);
  if (index < 4) {
    assert.strictEqual(decoded.reward, null);
    assert.strictEqual(result.reward, null);
    assert.strictEqual(result.newRecord, false);
  } else {
    assert(decoded.reward, "final Shadow game result must serialize its completion reward");
    assert.strictEqual(decoded.newRecord, true);
    finalReplay = replay;
    finalResult = result;
  }
}
assert(finalResult && finalResult.completed, "fifth Shadow Palace win must complete the run");
assert.strictEqual(finalResult.newRecord, true);
assert.deepStrictEqual(
  fullRunUser.miscStages.shadow.palaces["1001"].dungeonDataList.map((entry) => entry.bestTime),
  runTimes
);
assert.deepStrictEqual(
  Object.fromEntries(finalResult.reward.miscItems.map((item) => [Number(item.itemId), BigInt(item.countFree)])),
  { 1: 108000n, 20: 15n, 2013: 20n }
);
const rewardBalancesAfterCompletion = Object.fromEntries(
  [1, 20, 2013].map((itemId) => [itemId, BigInt(getMiscItem(fullRunUser, itemId).countFree)])
);
assert.deepStrictEqual(rewardBalancesAfterCompletion, { 1: 108000n, 20: 15n, 2013: 20n });
assert.strictEqual(
  recordShadowPalaceBattleResult(ctx, fullRunUser, {
    palaceId: 1001,
    dungeonId: 2005,
    win: true,
    playTime: 35,
    replay: finalReplay,
  }),
  finalResult,
  "replayed final result must use the cached outcome"
);
assert.deepStrictEqual(
  Object.fromEntries([1, 20, 2013].map((itemId) => [itemId, BigInt(getMiscItem(fullRunUser, itemId).countFree)])),
  rewardBalancesAfterCompletion,
  "replayed final result must not duplicate rewards"
);
const restartedFullRun = JSON.parse(JSON.stringify(fullRunUser));
assert.strictEqual(restartedFullRun.miscStages.shadow.currentPalaceId, 0);
assert.deepStrictEqual(
  restartedFullRun.miscStages.shadow.palaces["1001"].dungeonDataList.map((entry) => entry.bestTime),
  runTimes
);

const slowerRunUser = JSON.parse(JSON.stringify(fullRunUser));
slowerRunUser.miscStages.shadow.currentPalaceId = 1001;
slowerRunUser.miscStages.shadow.life = 3;
slowerRunUser.miscStages.shadow.palaces["1001"].currentDungeonId = 0;
for (const entry of slowerRunUser.miscStages.shadow.palaces["1001"].dungeonDataList) entry.recentTime = 0;
let slowerFinal = null;
for (let index = 0; index < 5; index += 1) {
  slowerFinal = recordShadowPalaceBattleResult(ctx, slowerRunUser, {
    palaceId: 1001,
    dungeonId: 2001 + index,
    win: true,
    playTime: 101 + index,
    replay: {},
  });
}
assert.strictEqual(slowerFinal.newRecord, false);
assert.deepStrictEqual(
  slowerRunUser.miscStages.shadow.palaces["1001"].dungeonDataList.map((entry) => entry.bestTime),
  runTimes,
  "slower full run must preserve the previous synchronized record"
);

const outOfOrderUser = activeUser(1001);
const outOfOrderBefore = JSON.parse(JSON.stringify(outOfOrderUser));
const outOfOrder = recordShadowPalaceBattleResult(ctx, outOfOrderUser, {
  palaceId: 1001,
  dungeonId: 2005,
  win: true,
  playTime: 1,
  replay: {},
});
assert.strictEqual(outOfOrder.valid, false);
assert.strictEqual(outOfOrder.errorCode, ERROR_CODES.DUNGEON_NOT_MATCHED);
assert.deepStrictEqual(JSON.parse(JSON.stringify(outOfOrderUser)), outOfOrderBefore);

const defeatedUser = activeUser(1001);
for (const expectedLife of [2, 1, 0]) {
  const loss = recordShadowPalaceBattleResult(ctx, defeatedUser, {
    palaceId: 1001,
    dungeonId: 2001,
    win: false,
    playTime: 90,
    replay: {},
  });
  const decoded = readShadowBattleResult(buildShadowPalaceBattleResultPayload(loss));
  assert.strictEqual(loss.valid, true);
  assert.strictEqual(loss.reward, null);
  assert.strictEqual(decoded.life, expectedLife);
  assert.strictEqual(decoded.currentDungeonId, 2001);
  assert.strictEqual(defeatedUser.miscStages.shadow.currentPalaceId, expectedLife > 0 ? 1001 : 0);
}

assert.strictEqual(saves, 4, "start, giveup, and two successful skips must save exactly once each");
assert.strictEqual(invalidations, 4, "start, giveup, and two successful skips must invalidate exactly once each");
assert.strictEqual(missionRefreshes, 3);
assert.strictEqual(missionNotifications, 3);
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details.value]),
  [
    ["USE_RESOURCE", 1, 19],
    ["PALACE_CLEAR", 1, 1001],
    ["PALACE_CLEARED", 1, 1001],
    ["USE_RESOURCE", 1, 19],
    ["PALACE_CLEAR", 3, 1001],
    ["PALACE_CLEARED", 3, 1001],
    ["USE_RESOURCE", 3, 19],
  ]
);

validateManagedSchemas();
console.log(
  `[shadow-palace-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function createUser() {
  userSequence += 1;
  const user = {
    userUid: String(982000000000000 + userSequence),
    nickname: "ShadowPalaceCheck",
    level: 100,
    miscStages: {
      shadow: {
        currentPalaceId: 0,
        life: 3,
        rewardMultiply: 1,
        palaces: {},
      },
    },
  };
  ensureInventory(user);
  return user;
}

function ticketedUser(options = {}) {
  const user = createUser();
  if (options.level != null) user.level = options.level;
  grantMiscItem(user, 19, options.ticketFree == null ? 10 : options.ticketFree, options.ticketPaid || 0);
  return user;
}

function completeUser(options = {}) {
  const user = createUser();
  const dungeonDataList = [2001, 2002, 2003, 2004, 2005]
    .filter((dungeonId) => dungeonId !== options.omitDungeonId)
    .map((dungeonId) => ({
      dungeonId,
      recentTime: 100 + dungeonId,
      bestTime: dungeonId === options.zeroTimeDungeonId ? 0 : 80 + dungeonId,
    }));
  user.miscStages.shadow.palaces["1001"] = { palaceId: 1001, currentDungeonId: 0, dungeonDataList };
  const balance = options.ticketBalance || [10, 0];
  grantMiscItem(user, 19, balance[0], balance[1]);
  return user;
}

function activeUser(palaceId, options = {}) {
  const user = options.complete ? completeUser(options) : createUser();
  user.miscStages.shadow.currentPalaceId = palaceId;
  return user;
}

function startFailure(name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  const before = JSON.parse(JSON.stringify(user));
  send(
    PACKETS.SHADOW_PALACE_START_REQ,
    user,
    typeof makePayload === "function" ? makePayload(user) : makePayload,
    validateRequest
  );
  const ack = readStartAck();
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.strictEqual(ack.palaceId, 0);
  assert.deepStrictEqual(ack.costItems, []);
  assert.strictEqual(ack.rewardMultiply, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function giveupFailure(name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  const before = JSON.parse(JSON.stringify(user));
  send(
    PACKETS.SHADOW_PALACE_GIVEUP_REQ,
    user,
    typeof makePayload === "function" ? makePayload(user) : makePayload,
    validateRequest
  );
  const ack = readGiveupAck();
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function skipFailure(name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  const before = JSON.parse(JSON.stringify(user));
  send(
    PACKETS.SHADOW_PALACE_SKIP_REQ,
    user,
    typeof makePayload === "function" ? makePayload(user) : makePayload,
    validateRequest
  );
  const ack = readSkipAck();
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.deepStrictEqual(ack.rewards, []);
  assert.deepStrictEqual(ack.costItems, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function skipSuccess(user, count, expected) {
  send(PACKETS.SHADOW_PALACE_SKIP_REQ, user, skipRequest(1001, count));
  const ack = readSkipAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.rewards.length, count);
  for (const reward of ack.rewards) {
    assert.deepStrictEqual(
      Object.fromEntries(reward.miscItems.map((item) => [item.itemId, item.countFree])),
      { 1: 108000n, 20: 15n, 2013: 20n }
    );
  }
  assert.strictEqual(ack.costItems.length, 1);
  assert.deepStrictEqual(stripItemMetadata(ack.costItems[0]), expected.ticket);
  assert.deepStrictEqual(stripItemMetadata(getMiscItem(user, 19)), expected.ticket);
  for (const [itemId, total] of Object.entries(expected.totals)) {
    assert.strictEqual(BigInt(getMiscItem(user, Number(itemId)).countFree), total);
  }
  const restarted = JSON.parse(JSON.stringify(user));
  assert.deepStrictEqual(stripItemMetadata(getMiscItem(restarted, 19)), expected.ticket);
  assert.strictEqual(restarted.miscStages.shadow.currentPalaceId, 0);
  assert.strictEqual(restarted.miscStages.shadow.palaces["1001"].dungeonDataList.length, 5);
}

function giveupRequest(palaceId) {
  return writeSignedVarInt(palaceId);
}

function startRequest(palaceId) {
  return writeSignedVarInt(palaceId);
}

function skipRequest(palaceId, skipCount) {
  return Buffer.concat([writeSignedVarInt(palaceId), writeSignedVarInt(skipCount)]);
}

function send(packetId, user, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing Shadow Palace handler ${packetId}`);
  socket.session.user = user;
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `handler ${packetId} must send an ACK`);
}

function readGiveupAck() {
  assert.strictEqual(response.packetId, PACKETS.SHADOW_PALACE_GIVEUP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const palace = readSignedVarInt(response.payload, error.offset);
  assert.strictEqual(palace.offset, response.payload.length, "giveup ACK must contain no trailing fields");
  return { errorCode: error.value, palaceId: palace.value };
}

function readStartAck() {
  assert.strictEqual(response.packetId, PACKETS.SHADOW_PALACE_START_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const palace = readSignedVarInt(response.payload, error.offset);
  const costList = readObjectList(response.payload, palace.offset, readItem);
  const rewardMultiply = readSignedVarInt(response.payload, costList.offset);
  assert.strictEqual(rewardMultiply.offset, response.payload.length, "start ACK must contain no trailing fields");
  return {
    errorCode: error.value,
    palaceId: palace.value,
    costItems: costList.values,
    rewardMultiply: rewardMultiply.value,
  };
}

function readSkipAck() {
  assert.strictEqual(response.packetId, PACKETS.SHADOW_PALACE_SKIP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const rewardList = readObjectList(response.payload, error.offset, readRewardData);
  const costList = readObjectList(response.payload, rewardList.offset, readItem);
  assert.strictEqual(costList.offset, response.payload.length, "skip ACK must contain no trailing fields");
  return { errorCode: error.value, rewards: rewardList.values, costItems: costList.values };
}

function readGameLoadFailure(payload) {
  const error = readSignedVarInt(payload, 0);
  const gameData = readBool(payload, error.offset);
  assert.strictEqual(gameData.value, false);
  const respawnCount = readVarInt(payload, gameData.offset);
  assert.strictEqual(respawnCount.offset, payload.length, "failed game-load ACK must contain no trailing fields");
  return { errorCode: error.value, hasGameData: gameData.value, respawnCount: respawnCount.value };
}

function readShadowBattleResult(payload) {
  const palace = readSignedVarInt(payload, 0);
  const dungeonPresent = readBool(payload, palace.offset);
  let offset = dungeonPresent.offset;
  let dungeonData = null;
  if (dungeonPresent.value) {
    const dungeon = readSignedVarInt(payload, offset);
    const recent = readSignedVarInt(payload, dungeon.offset);
    const best = readSignedVarInt(payload, recent.offset);
    dungeonData = { dungeonId: dungeon.value, recentTime: recent.value, bestTime: best.value };
    offset = best.offset;
  }
  const rewardPresent = readBool(payload, offset);
  offset = rewardPresent.offset;
  let reward = null;
  if (rewardPresent.value) {
    const parsed = readRewardData(payload, offset);
    reward = parsed.value;
    offset = parsed.offset;
  }
  const newRecord = readBool(payload, offset);
  const currentDungeon = readSignedVarInt(payload, newRecord.offset);
  const life = readSignedVarInt(payload, currentDungeon.offset);
  assert.strictEqual(life.offset, payload.length, "Shadow game result must contain no trailing fields");
  return {
    palaceId: palace.value,
    dungeonData,
    reward,
    newRecord: newRecord.value,
    currentDungeonId: currentDungeon.value,
    life: life.value,
  };
}

function readRewardData(payload, startOffset) {
  let offset = startOffset;
  const userExp = readSignedVarInt(payload, offset); offset = userExp.offset;
  const bonus = readSignedVarInt(payload, offset); offset = bonus.offset;
  offset = readEmptyList(payload, offset);
  const misc = readObjectList(payload, offset, readItem); offset = misc.offset;
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  const daily = readSignedVarInt(payload, offset); offset = daily.offset;
  const weekly = readSignedVarInt(payload, offset); offset = weekly.offset;
  offset = readEmptyList(payload, offset);
  const achieve = readSignedVarLong(payload, offset); offset = achieve.offset;
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  return { value: { miscItems: misc.values }, offset };
}

function readObjectList(payload, startOffset, readValue) {
  const count = readVarInt(payload, startOffset);
  const values = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    offset = present.offset;
    assert.strictEqual(present.value, true, "Shadow Palace ACK lists must not contain null entries");
    const parsed = readValue(payload, offset);
    values.push(parsed.value);
    offset = parsed.offset;
  }
  return { values, offset };
}

function readEmptyList(payload, startOffset) {
  const count = readVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0, "expected empty nested reward list");
  return count.offset;
}

function readVarInt(payload, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < payload.length && shift <= 28) {
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("invalid varint");
}

function readItem(payload, startOffset) {
  const itemId = readSignedVarInt(payload, startOffset);
  const countFree = readSignedVarLong(payload, itemId.offset);
  const countPaid = readSignedVarLong(payload, countFree.offset);
  const bonus = readSignedVarInt(payload, countPaid.offset);
  return {
    value: {
      itemId: itemId.value,
      countFree: countFree.value,
      countPaid: countPaid.value,
      bonusRatio: bonus.value,
      regDate: payload.readBigInt64LE(bonus.offset),
    },
    offset: bonus.offset + 8,
  };
}

function stripItemMetadata(item) {
  return {
    itemId: Number(item.itemId),
    countFree: BigInt(item.countFree),
    countPaid: BigInt(item.countPaid),
  };
}

function assertNoCommits() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.strictEqual(missionRefreshes, 0);
  assert.strictEqual(missionNotifications, 0);
  assert.deepStrictEqual(missionEvents, []);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const combatHost = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Shadow Palace packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
