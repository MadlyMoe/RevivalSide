"use strict";

const assert = require("assert");
const path = require("path");
const {
  PACKETS,
  CONTENT,
  ERROR_CODES,
  createScoreRewardHandlers,
  getContentScore,
  getReceivedRewardIds,
  loadCatalog,
} = require("../modules/score-reward");
const { ensureInventory, getMiscItem } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const catalog = loadCatalog();
assert.strictEqual(catalog.rowsByGroup.size, 8, "frozen Score Reward group count changed");
assert.deepStrictEqual([...catalog.miniGameGroups], [1101, 1102, 1103]);
assert.deepStrictEqual([...catalog.exploreGroups], [1201, 1202, 1203]);
assert.strictEqual([...catalog.rowsByGroup.values()].reduce((total, rows) => total + rows.length, 0), 147);

const user = makeUser();
const socket = { session: { user } };
const handlers = new Map(createScoreRewardHandlers().map((handler) => [handler.packetId, handler]));
const managedPackets = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  dateTimeBinaryNow() { return 0n; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(["score-reward", "score-reward-all"].includes(reason));
    invalidations += 1;
  },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 1);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
};

singleFailure("truncated", Buffer.alloc(0), ERROR_CODES.INVALID_CONTENT_TYPE, false);
singleFailure("trailing", Buffer.concat([singleRequest(1101, CONTENT.MINI_GAME, 11011), Buffer.from([0])]), ERROR_CODES.INVALID_CONTENT_TYPE, false);
singleFailure("invalid content", singleRequest(1101, 2, 11011), ERROR_CODES.INVALID_CONTENT_TYPE);
singleFailure("unknown group", singleRequest(999999, CONTENT.MINI_GAME, 11011), ERROR_CODES.INVALID_TEMPLET);
singleFailure("group/content mismatch", singleRequest(1201, CONTENT.MINI_GAME, 12011), ERROR_CODES.GROUP_NOT_MATCHED);
singleFailure("unknown reward", singleRequest(1101, CONTENT.MINI_GAME, 999999), ERROR_CODES.INVALID_TEMPLET);
singleFailure("insufficient score", singleRequest(1101, CONTENT.MINI_GAME, 11011), ERROR_CODES.INVALID_TEMPLET);
allFailure("all invalid content", allRequest(1101, 2), ERROR_CODES.INVALID_CONTENT_TYPE);
allFailure("all group/content mismatch", allRequest(1101, CONTENT.EXPLORE), ERROR_CODES.GROUP_NOT_MATCHED);
allFailure("all insufficient score", allRequest(1101, CONTENT.MINI_GAME), ERROR_CODES.INVALID_TEMPLET);
assert.strictEqual(saves, 0);
assert.strictEqual(invalidations, 0);

user.miniGames = { "1101": { type: 0, templetId: 1101, score: 10, gameInfo: "" } };
assert.strictEqual(getContentScore(user, CONTENT.MINI_GAME, 1101), 10);
send(PACKETS.SCORE_REWARD_REQ, singleRequest(1101, CONTENT.MINI_GAME, 11011));
let ack = parseSingleAck(response.payload);
assert.strictEqual(response.packetId, PACKETS.SCORE_REWARD_ACK);
assert.deepStrictEqual(
  { errorCode: ack.errorCode, contentType: ack.contentType, rewardId: ack.rewardId, rewardPresent: ack.rewardPresent },
  { errorCode: 0, contentType: CONTENT.MINI_GAME, rewardId: 11011, rewardPresent: true }
);
assert.deepStrictEqual(getReceivedRewardIds(user, CONTENT.MINI_GAME), [11011]);
assert.strictEqual(itemCount(user, 101), 100n);
assert.strictEqual(itemCount(user, 1068), 20n);
singleFailure("duplicate", singleRequest(1101, CONTENT.MINI_GAME, 11011), ERROR_CODES.ALREADY_RECEIVED);

user.miniGames["1101"].score = 30;
const miniRows = catalog.rowsByGroup.get(1101).filter((row) => row.score <= 30 && row.rewardId !== 11011);
const expectedMiniDelta = rewardTotals(miniRows);
const miniBefore = inventoryCounts(user, expectedMiniDelta.keys());
send(PACKETS.SCORE_REWARD_ALL_REQ, allRequest(1101, CONTENT.MINI_GAME));
let allAck = parseAllAck(response.payload);
assert.strictEqual(response.packetId, PACKETS.SCORE_REWARD_ALL_ACK);
assert.strictEqual(allAck.errorCode, 0);
assert.strictEqual(allAck.contentType, CONTENT.MINI_GAME);
assert.deepStrictEqual(allAck.rewardIds, miniRows.map((row) => row.rewardId));
assert.strictEqual(allAck.rewardPresent, true);
assertRewardDelta(user, miniBefore, expectedMiniDelta);
allFailure("no newly eligible reward", allRequest(1101, CONTENT.MINI_GAME), ERROR_CODES.INVALID_TEMPLET);

user.miniGames["1101"].score = 1000;
send(PACKETS.SCORE_REWARD_ALL_REQ, allRequest(1101, CONTENT.MINI_GAME));
allAck = parseAllAck(response.payload);
assert.strictEqual(allAck.errorCode, 0);
assert.strictEqual(getReceivedRewardIds(user, CONTENT.MINI_GAME).length, 15);
allFailure("all already received", allRequest(1101, CONTENT.MINI_GAME), ERROR_CODES.ALREADY_RECEIVED);

user.explore = { templetId: 1, seasonScore: 10, rewardIds: [] };
assert.strictEqual(getContentScore(user, CONTENT.EXPLORE, 1201), 10);
const exploreItemBefore = itemCount(user, 1);
const exploreTokenBefore = itemCount(user, 1013);
send(PACKETS.SCORE_REWARD_REQ, singleRequest(1201, CONTENT.EXPLORE, 12011));
ack = parseSingleAck(response.payload);
assert.strictEqual(ack.errorCode, 0);
assert.strictEqual(ack.contentType, CONTENT.EXPLORE);
assert.strictEqual(ack.rewardId, 12011);
assert.deepStrictEqual(getReceivedRewardIds(user, CONTENT.EXPLORE), [12011]);
assert.strictEqual(itemCount(user, 1) - exploreItemBefore, 150000n);
assert.strictEqual(itemCount(user, 1013) - exploreTokenBefore, 10n);

assert.strictEqual(saves, 4, "four successful transactions must each save once");
assert.strictEqual(invalidations, 4, "four successful transactions must each invalidate once");
const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(restarted.scoreRewards.miniGame.length, 15);
assert.deepStrictEqual(restarted.scoreRewards.explore, [12011]);
assert.strictEqual(BigInt(restarted.inventory.misc["1"].countFree), itemCount(user, 1));

validateManagedSchemas();
console.log(
  `[score-reward-protocol-check] PASS saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function makeUser() {
  const value = { userUid: "3081001", inventory: { misc: {}, equips: {}, skins: [] } };
  ensureInventory(value);
  return value;
}

function singleRequest(groupId, contentType, rewardId) {
  return Buffer.concat([writeSignedVarInt(groupId), writeSignedVarInt(contentType), writeSignedVarInt(rewardId)]);
}

function allRequest(groupId, contentType) {
  return Buffer.concat([writeSignedVarInt(groupId), writeSignedVarInt(contentType)]);
}

function send(packetId, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing Score Reward handler ${packetId}`);
  response = null;
  if (validateRequest) managedPackets.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `handler ${packetId} must send an ACK`);
}

function singleFailure(name, payload, expectedError, validateRequest = true) {
  const before = JSON.stringify(user);
  const saveBefore = saves;
  send(PACKETS.SCORE_REWARD_REQ, payload, validateRequest);
  const parsed = parseSingleAck(response.payload);
  assert.strictEqual(parsed.errorCode, expectedError, name);
  assert.strictEqual(parsed.rewardPresent, false, `${name} must not return reward data`);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate state`);
  assert.strictEqual(saves, saveBefore, `${name} must not save`);
}

function allFailure(name, payload, expectedError, validateRequest = true) {
  const before = JSON.stringify(user);
  const saveBefore = saves;
  send(PACKETS.SCORE_REWARD_ALL_REQ, payload, validateRequest);
  const parsed = parseAllAck(response.payload);
  assert.strictEqual(parsed.errorCode, expectedError, name);
  assert.deepStrictEqual(parsed.rewardIds, [], `${name} must not return reward IDs`);
  assert.strictEqual(parsed.rewardPresent, false, `${name} must not return reward data`);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate state`);
  assert.strictEqual(saves, saveBefore, `${name} must not save`);
}

function parseSingleAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const content = readSignedVarInt(payload, error.offset);
  const rewardPresent = readBool(payload, content.offset);
  const rewardOffset = rewardPresent.value ? skipRewardData(payload, rewardPresent.offset) : rewardPresent.offset;
  const rewardId = readSignedVarInt(payload, rewardOffset);
  assert.strictEqual(rewardId.offset, payload.length, "single Score Reward ACK must contain no trailing fields");
  return { errorCode: error.value, contentType: content.value, rewardPresent: rewardPresent.value, rewardId: rewardId.value };
}

function parseAllAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const content = readSignedVarInt(payload, error.offset);
  const ids = readIntList(payload, content.offset);
  const rewardPresent = readBool(payload, ids.offset);
  const offset = rewardPresent.value ? skipRewardData(payload, rewardPresent.offset) : rewardPresent.offset;
  assert.strictEqual(offset, payload.length, "all Score Reward ACK must contain no trailing fields");
  return { errorCode: error.value, contentType: content.value, rewardIds: ids.values, rewardPresent: rewardPresent.value };
}

function readIntList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  const values = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const item = readSignedVarInt(payload, offset);
    values.push(item.value);
    offset = item.offset;
  }
  return { values, offset };
}

function skipRewardData(payload, startOffset) {
  let offset = readSignedVarInt(payload, startOffset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = skipEmptyList(payload, offset);
  offset = skipItemList(payload, offset);
  for (let index = 0; index < 7; index += 1) offset = skipEmptyList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = skipEmptyList(payload, offset);
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = skipEmptyList(payload, offset);
  return offset;
}

function skipItemList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const itemId = readSignedVarInt(payload, present.offset);
    const free = readSignedVarLong(payload, itemId.offset);
    const paid = readSignedVarLong(payload, free.offset);
    const bonus = readSignedVarInt(payload, paid.offset);
    offset = bonus.offset + 8;
  }
  return offset;
}

function skipEmptyList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0, "checker expects empty nested reward list");
  return count.offset;
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

function rewardTotals(rows) {
  const totals = new Map();
  for (const row of rows) {
    for (const reward of row.rewards) totals.set(reward.id, (totals.get(reward.id) || 0n) + BigInt(reward.quantity));
  }
  return totals;
}

function inventoryCounts(target, itemIds) {
  return new Map(Array.from(itemIds, (itemId) => [itemId, itemCount(target, itemId)]));
}

function assertRewardDelta(target, before, totals) {
  for (const [itemId, total] of totals) assert.strictEqual(itemCount(target, itemId) - before.get(itemId), total);
}

function itemCount(target, itemId) {
  const item = getMiscItem(target, itemId);
  return item ? BigInt(item.countFree || 0) + BigInt(item.countPaid || 0) : 0n;
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
      assert(result.ok, `managed client schema rejected Score Reward packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
