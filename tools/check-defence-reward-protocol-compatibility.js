"use strict";

const assert = require("assert");
const path = require("path");
const {
  INVALID_SCORE_REWARD_TEMPLET,
  INVALID_TEMPLET,
  RANK_REWARD_ALREADY_GIVEN,
  REWARD_COUNT_ZERO,
  SCORE_REWARD_ALREADY_GIVEN,
  SCORE_REWARD_MAKE_FAIL,
  createDefenceHandlers,
} = require("../modules/defence");
const {
  dateTimeBinaryNow,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const defenceId = 999;
const alice = makeUser("1001", "Alice", 2000);
const bob = makeUser("1002", "Bob", 1500);
const carol = makeUser("1003", "Carol", 1000);
const userDb = { users: { [alice.userUid]: alice, [bob.userUid]: bob, [carol.userUid]: carol } };
const handlers = new Map(createDefenceHandlers().map((handler) => [handler.packetId, handler]));
const socket = { session: { user: alice } };
const managedPackets = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  userDb,
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow,
  decryptCopy(payload) { return payload; },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    managedPackets.push([packetId, target.response.payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

send(3904, writeSignedVarInt(defenceId), true);
let info = parseInfo(socket.response.payload);
assert.equal(info.errorCode, 0);
assert.equal(info.defenceId, defenceId);
assert.equal(info.bestScore, 2000);
assert.equal(info.rank, 1);
assert.equal(info.rankPercent, 34);
assert.equal(info.canReceiveRankReward, true);
assert.equal(info.topUserUid, "1001");
assert.deepStrictEqual(info.scoreRewardIds, []);
assert.equal(saves, 0, "info reads must not save");

send(3904, writeSignedVarInt(123456), true);
assert.equal(readSignedVarInt(socket.response.payload, 0).value, INVALID_TEMPLET);
send(3904, writeSignedVarInt(defenceId), true);

const beforeFailures = JSON.stringify(alice);
send(3911, writeSignedVarInt(999999), true);
assertError(INVALID_SCORE_REWARD_TEMPLET);
send(3911, writeSignedVarInt(10015), true);
assertError(SCORE_REWARD_MAKE_FAIL);
assert.equal(JSON.stringify(alice), beforeFailures, "failed score claims must be atomic");

send(3911, writeSignedVarInt(10011), true);
assertError(0);
assert.equal(itemCount(alice, 1), 1111n);
assert.deepStrictEqual(alice.miscStages.defence[String(defenceId)].scoreRewardIds, [10011]);
assert.equal(saves, 1);
send(3911, writeSignedVarInt(10011), true);
assertError(SCORE_REWARD_ALREADY_GIVEN);
assert.equal(saves, 1, "duplicate score claim must not save");

send(3913, Buffer.alloc(0), true);
assertError(0);
assert.equal(itemCount(alice, 1), 11110n, "claim-all must aggregate every remaining eligible table reward once");
assert.deepStrictEqual(alice.miscStages.defence[String(defenceId)].scoreRewardIds, [10011, 10012, 10013, 10014]);
assert.equal(saves, 2);
send(3913, Buffer.alloc(0), true);
assertError(REWARD_COUNT_ZERO);
assert.equal(saves, 2);

send(3907, Buffer.alloc(0), true);
assertError(0);
assert.equal(itemCount(alice, 101), 11n, "rank-one reward must come from the frozen rank table");
assert.equal(alice.miscStages.defence[String(defenceId)].rankRewardClaimed, true);
assert.equal(saves, 3);
send(3907, Buffer.alloc(0), true);
assertError(RANK_REWARD_ALREADY_GIVEN);
assert.equal(saves, 3);

send(3904, writeSignedVarInt(defenceId), true);
info = parseInfo(socket.response.payload);
assert.equal(info.canReceiveRankReward, false);
assert.deepStrictEqual(info.scoreRewardIds, [10011, 10012, 10013, 10014]);

const beforeMalformed = JSON.stringify(alice);
send(3907, Buffer.from([0]), false);
send(3911, Buffer.alloc(0), false);
send(3913, Buffer.from([0]), false);
assert.equal(JSON.stringify(alice), beforeMalformed, "malformed reward requests must not mutate state");
assert.equal(saves, 3);
assert.equal(invalidations, 3, "each successful claim must invalidate the lobby snapshot once");

const restarted = JSON.parse(JSON.stringify(userDb));
assert.deepStrictEqual(restarted.users[alice.userUid].miscStages.defence[String(defenceId)].scoreRewardIds, [10011, 10012, 10013, 10014]);
assert.equal(restarted.users[alice.userUid].miscStages.defence[String(defenceId)].rankRewardClaimed, true);
assert.equal(BigInt(restarted.users[alice.userUid].inventory.misc["1"].countFree), 11110n);
validateManagedSchemas();
console.log(`[defence-reward-protocol-check] PASS saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname, bestScore) {
  return {
    userUid,
    friendCode: String(9000 + Number(userUid)),
    nickname,
    level: 50,
    inventory: { misc: {}, equips: {}, skins: [] },
    miscStages: { defence: { [defenceId]: { defenceTempletId: defenceId, bestScore, missionResult1: true, missionResult2: true } } },
    army: { units: {}, ships: {}, operators: {}, trophies: {}, deckSets: {} },
  };
}

function send(packetId, payload, validateRequest) {
  const handler = handlers.get(packetId);
  assert(handler, `missing Defence handler ${packetId}`);
  if (validateRequest) managedPackets.push([packetId, payload]);
  assert.equal(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert.equal(socket.response.packetId, packetId + 1);
}

function assertError(expected) {
  assert.equal(readSignedVarInt(socket.response.payload, 0).value, expected);
}

function itemCount(user, itemId) {
  const item = user.inventory.misc[String(itemId)];
  return item ? BigInt(item.countFree || 0) + BigInt(item.countPaid || 0) : 0n;
}

function parseInfo(payload) {
  const error = readSignedVarInt(payload, 0);
  const defence = readSignedVarInt(payload, error.offset);
  const score = readSignedVarInt(payload, defence.offset);
  const mission1 = readBool(payload, score.offset);
  const mission2 = readBool(payload, mission1.offset);
  const rank = readSignedVarInt(payload, mission2.offset);
  const percent = readSignedVarInt(payload, rank.offset);
  const canReceive = readBool(payload, percent.offset);
  const topPresent = readBool(payload, canReceive.offset);
  let offset = topPresent.offset;
  let topUserUid = "0";
  if (topPresent.value) {
    const commonPresent = readBool(payload, offset);
    assert.equal(commonPresent.value, true);
    const uid = readSignedVarLong(payload, commonPresent.offset);
    topUserUid = String(uid.value);
    offset = readSignedVarLong(payload, uid.offset).offset;
    offset = readString(payload, offset).offset;
    for (let index = 0; index < 6; index += 1) offset = readSignedVarInt(payload, offset).offset;
    offset = readSignedVarInt(payload, offset).offset;
    const guildPresent = readBool(payload, offset);
    assert.equal(guildPresent.value, true);
    offset = readSignedVarLong(payload, guildPresent.offset).offset;
    offset = readString(payload, offset).offset;
    offset = readSignedVarLong(payload, offset).offset;
  }
  const rewards = readIntList(payload, offset);
  assert.equal(rewards.offset, payload.length, "Defence info ACK must not contain trailing bytes");
  return {
    errorCode: error.value,
    defenceId: defence.value,
    bestScore: score.value,
    rank: rank.value,
    rankPercent: percent.value,
    canReceiveRankReward: canReceive.value,
    topUserUid,
    scoreRewardIds: rewards.value,
  };
}

function readIntList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readSignedVarInt(payload, offset);
    value.push(item.value);
    offset = item.offset;
  }
  return { value, offset };
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated list count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Defence reward packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
