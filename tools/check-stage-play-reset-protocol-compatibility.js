"use strict";

const assert = require("assert");
const path = require("path");
const { PACKETS, ERROR_CODES, createStagePlayResetHandlers } = require("../modules/stage-play-reset");
const { ensureInventory, getMiscItem, grantMiscItem } = require("../modules/inventory");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { readBool, readSignedVarInt, readSignedVarLong, writeSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createStagePlayResetHandlers()[0];
const now = new Date("2026-08-20T12:00:00.000Z");
const nowBinary = dateTimeBinaryForDate(now);
const futureReset = dateTimeBinaryForDate(new Date("2099-01-01T04:00:00.000Z"));
const expiredReset = dateTimeBinaryForDate(new Date("2020-01-01T04:00:00.000Z"));

const managedWire = [];
let userSequence = 0;
let response = null;
let saves = 0;
let invalidations = 0;
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getServerNowDate: () => new Date(now),
  dateTimeBinaryNow: () => nowBinary,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "reset-stage-play-count");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
  sendGameResponse(_socket, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    assert.strictEqual(packet.sequence, 1);
  },
};

failure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.UNRESTORABLE_STAGE_ID, false);
failure("trailing", makeFixture, () => Buffer.concat([request(2504263, 1), Buffer.from([0])]), ERROR_CODES.UNRESTORABLE_STAGE_ID, false);
failure("unknown stage", createUser, () => request(999999999, 1), ERROR_CODES.UNRESTORABLE_STAGE_ID);
failure("unrestorable stage", createUser, () => request(11211, 1), ERROR_CODES.UNRESTORABLE_STAGE_ID);
failure("zero restore count", makeFixture, () => request(2504263, 0), ERROR_CODES.RESTORE_COUNT);
failure("negative restore count", makeFixture, () => request(2504263, -1), ERROR_CODES.RESTORE_COUNT);
failure("batch exceeds one exhaustion", makeFixture, () => request(2504263, 2), ERROR_CODES.RESTORE_COUNT);
failure("no play history", createUser, () => request(2504263, 1), ERROR_CODES.EXIST_PLAY_COUNT);
failure("play count remains", () => makeFixture({ playCount: 2 }), () => request(2504263, 1), ERROR_CODES.EXIST_PLAY_COUNT);
failure("invalid play count", () => makeFixture({ playCount: 4 }), () => request(2504263, 1), ERROR_CODES.INVALID_PLAY_COUNT);
failure("invalid stored restore count", () => makeFixture({ restoreCount: 3 }), () => request(2504263, 1), ERROR_CODES.RESTORE_COUNT);
failure("cumulative restore limit", () => makeFixture({ restoreCount: 2 }), () => request(2504263, 1), ERROR_CODES.RESTORE_COUNT);
failure("expired counters", () => makeFixture({ nextResetDate: expiredReset }), () => request(2504263, 1), ERROR_CODES.EXIST_PLAY_COUNT);
failure("insufficient quartz", () => makeFixture({ balance: [79, 0] }), () => request(2504263, 1), ERROR_CODES.INSUFFICIENT_ITEM);
assertNoCommits();

const daily = makeFixture({ balance: [30, 100] });
success(daily, 2504263, 1, {
  stageId: 2504263,
  playCount: 0n,
  restoreCount: 1n,
  bestKillCount: 7n,
  nextResetDate: futureReset,
  bestClearTimeSec: 88,
  totalPlayCount: 9n,
}, { itemId: 101, countFree: 0n, countPaid: 50n });

const weekly = makeFixture({ stageId: 9999989, playCount: 12, restoreCount: 1, balance: [100, 200] });
success(weekly, 9999989, 3, {
  stageId: 9999989,
  playCount: 3n,
  restoreCount: 4n,
  bestKillCount: 7n,
  nextResetDate: futureReset,
  bestClearTimeSec: 88,
  totalPlayCount: 9n,
}, { itemId: 101, countFree: 0n, countPaid: 60n });

assert.strictEqual(saves, 2, "only successful resets may save");
assert.strictEqual(invalidations, 2, "only successful resets may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details.itemId]),
  [["USE_RESOURCE", 80, 101], ["USE_RESOURCE", 240, 101]]
);

for (const [user, stageId, playCount, restoreCount] of [
  [daily, 2504263, 0, 1],
  [weekly, 9999989, 3, 4],
]) {
  const restarted = JSON.parse(JSON.stringify(user));
  const state = restarted.stagePlayData[String(stageId)];
  assert.strictEqual(state.playCount, playCount);
  assert.strictEqual(state.restoreCount, restoreCount);
  assert.strictEqual(state.bestKillCount, 7);
  assert.strictEqual(state.bestClearTimeSec, 88);
  assert.strictEqual(state.totalPlayCount, 9);
  assert.strictEqual(state.nextResetDate, String(futureReset));
}

validateManagedSchemas();
console.log(`[stage-play-reset-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  userSequence += 1;
  const user = { userUid: String(981000000000000 + userSequence), nickname: "StagePlayResetCheck", stagePlayData: {} };
  ensureInventory(user);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  const stageId = options.stageId || 2504263;
  user.stagePlayData[String(stageId)] = {
    stageId,
    playCount: options.playCount == null ? 3 : options.playCount,
    restoreCount: options.restoreCount == null ? 0 : options.restoreCount,
    bestKillCount: 7,
    nextResetDate: String(options.nextResetDate == null ? futureReset : options.nextResetDate),
    bestClearTimeSec: 88,
    totalPlayCount: 9,
  };
  const balance = options.balance || [100, 0];
  grantMiscItem(user, 101, balance[0], balance[1]);
  return user;
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  socket.session.user = user;
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  const ack = readAck();
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.strictEqual(ack.stagePlayData, null);
  assert.strictEqual(ack.costItem, null);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function success(user, stageId, restoreCount, expectedStage, expectedItem) {
  socket.session.user = user;
  send(request(stageId, restoreCount));
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.deepStrictEqual(ack.stagePlayData, expectedStage);
  assert.deepStrictEqual(ack.costItem, expectedItem);
  const item = getMiscItem(user, 101);
  assert.strictEqual(item.countFree, String(expectedItem.countFree));
  assert.strictEqual(item.countPaid, String(expectedItem.countPaid));
}

function request(stageId, restoreCount) {
  return Buffer.concat([writeSignedVarInt(stageId), writeSignedVarInt(restoreCount)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.RESET_STAGE_PLAY_COUNT_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.RESET_STAGE_PLAY_COUNT_REQ, sequence: 1, payload }), true);
}

function readAck() {
  assert(response, "stage-play-reset handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.RESET_STAGE_PLAY_COUNT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const stagePresent = readBool(response.payload, error.offset);
  let offset = stagePresent.offset;
  let stagePlayData = null;
  if (stagePresent.value) {
    stagePlayData = readStagePlayData(response.payload, offset);
    offset = stagePlayData.offset;
    delete stagePlayData.offset;
  }
  const itemPresent = readBool(response.payload, offset);
  offset = itemPresent.offset;
  let costItem = null;
  if (itemPresent.value) {
    costItem = readItem(response.payload, offset);
    offset = costItem.offset;
    delete costItem.offset;
  }
  assert.strictEqual(offset, response.payload.length, "stage-play-reset ACK must contain no trailing fields");
  return { errorCode: error.value, stagePlayData, costItem };
}

function readStagePlayData(payload, startOffset) {
  const stageId = readSignedVarInt(payload, startOffset);
  const playCount = readSignedVarLong(payload, stageId.offset);
  const restoreCount = readSignedVarLong(payload, playCount.offset);
  const bestKillCount = readSignedVarLong(payload, restoreCount.offset);
  const nextResetDate = payload.readBigInt64LE(bestKillCount.offset);
  const bestClearTimeSec = readSignedVarInt(payload, bestKillCount.offset + 8);
  const totalPlayCount = readSignedVarLong(payload, bestClearTimeSec.offset);
  return {
    stageId: stageId.value,
    playCount: playCount.value,
    restoreCount: restoreCount.value,
    bestKillCount: bestKillCount.value,
    nextResetDate,
    bestClearTimeSec: bestClearTimeSec.value,
    totalPlayCount: totalPlayCount.value,
    offset: totalPlayCount.offset,
  };
}

function readItem(payload, startOffset) {
  const itemId = readSignedVarInt(payload, startOffset);
  const countFree = readSignedVarLong(payload, itemId.offset);
  const countPaid = readSignedVarLong(payload, countFree.offset);
  const bonusRatio = readSignedVarInt(payload, countPaid.offset);
  return { itemId: itemId.value, countFree: countFree.value, countPaid: countPaid.value, offset: bonusRatio.offset + 8 };
}

function assertNoCommits() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
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
      assert(result.ok, `managed client schema rejected stage-play-reset packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
