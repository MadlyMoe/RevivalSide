"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getTrophyUnitIds, getUnitRemoveRewards } = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureDeck, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000027", nickname: "UnitRemovalCheck" };
const excluded = grantUnit(user, 1001);
const locked = fixture();
const background = fixture();
const decked = fixture();
const equipped = fixture();
const leader = fixture();
const office = fixture();
const support = fixture();
const atomic = fixture();
const removable = fixture();
const trophy = grantUnit(user, getTrophyUnitIds()[0]);
assert([excluded, locked, background, decked, equipped, leader, office, support, atomic, removable, trophy].every(Boolean));
const socket = { session: { user } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.REMOVE_UNIT_REQ);
assert(handler, "unit-removal handler must be registered");
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "roster-removal");
    invalidations += 1;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(Buffer.concat([request([removable.unitUid]), Buffer.from([0])]), false);
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([]));
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([removable.unitUid, removable.unitUid]));
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([0]));
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([atomic.unitUid, 999999999n]));
assertAck(ERROR_CODES.UNIT_NOT_EXIST, [], {});
assert(getArmyUnitByUid(user, atomic.unitUid), "multi-unit failure must be atomic");
assertNoMutation();

send(request([excluded.unitUid]));
assertAck(ERROR_CODES.DELETE_EXCLUDE_UNIT, [], {});

user.army.units[String(locked.unitUid)].locked = true;
send(request([locked.unitUid]));
assertAck(ERROR_CODES.UNIT_LOCKED, [], {});

user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: String(background.unitUid) }] } };
send(request([background.unitUid]));
assertAck(ERROR_CODES.UNIT_IS_LOBBY_UNIT, [], {});

const deck = ensureDeck(user, { deckType: 1, index: 0 });
deck.unitUids[0] = String(decked.unitUid);
send(request([decked.unitUid]));
assertAck(ERROR_CODES.UNIT_IN_DECK, [], {});

user.army.units[String(equipped.unitUid)].equipItemUids[0] = "8800000000000001";
send(request([equipped.unitUid]));
assertAck(ERROR_CODES.UNIT_EQUIP_ITEM, [], {});

user.worldMap = { cities: { 1: { leaderUnitUID: String(leader.unitUid) } } };
send(request([leader.unitUid]));
assertAck(ERROR_CODES.UNIT_IS_WORLDMAP_LEADER, [], {});

user.office = { rooms: [{ id: 1, unitUids: [String(office.unitUid)] }] };
send(request([office.unitUid]));
assertAck(ERROR_CODES.OFFICE_UNIT_DELETE_IN_ROOM, [], {});

user.support = { mySupportUnitUid: String(support.unitUid) };
send(request([support.unitUid]));
assertAck(ERROR_CODES.CONTAIN_SUPPORT_UNIT, [], {});
assertNoMutation();

const expectedRewards = mergeRewards([
  ...getUnitRemoveRewards(removable.unitId, { fromContract: true }),
  ...getUnitRemoveRewards(trophy.unitId, { fromContract: true }),
]);
for (const itemId of Object.keys(expectedRewards)) setMiscItemBalance(user, itemId, 0);
send(request([removable.unitUid, trophy.unitUid]));
assertAck(ERROR_CODES.OK, [BigInt(removable.unitUid), BigInt(trophy.unitUid)], expectedRewards);
assert.strictEqual(getArmyUnitByUid(user, removable.unitUid), null);
assert.strictEqual(getArmyUnitByUid(user, trophy.unitUid), null);
for (const [itemId, count] of Object.entries(expectedRewards)) {
  assert.strictEqual(BigInt(getMiscItem(user, itemId).countFree), BigInt(count));
}
assert.strictEqual(saves, 1, "only successful unit dismissal should persist");
assert.strictEqual(invalidations, 1, "only successful unit dismissal should invalidate the lobby snapshot");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnitByUid(restarted, removable.unitUid), null);
assert.strictEqual(getArmyUnitByUid(restarted, trophy.unitUid), null);
for (const [itemId, count] of Object.entries(expectedRewards)) {
  assert.strictEqual(BigInt(getMiscItem(restarted, itemId).countFree), BigInt(count));
}

validateManagedSchemas();
console.log(`[unit-removal-protocol-check] PASS rewards=${Object.keys(expectedRewards).length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function fixture() {
  return grantUnit(user, 1004);
}

function request(uids) {
  const values = Array.isArray(uids) ? uids : [];
  return Buffer.concat([writeRawVarInt(values.length), ...values.map((uid) => writeSignedVarLong(BigInt(uid)))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.REMOVE_UNIT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.REMOVE_UNIT_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedRemoved, expectedRewards) {
  assert(response, "unit-removal handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.REMOVE_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const removedCount = readRawVarInt(response.payload, error.offset);
  let offset = removedCount.offset;
  const removed = [];
  for (let index = 0; index < removedCount.value; index += 1) {
    const uid = readSignedVarLong(response.payload, offset);
    removed.push(uid.value);
    offset = uid.offset;
  }
  assert.deepStrictEqual(removed, expectedRemoved);
  const rewardCount = readRawVarInt(response.payload, offset);
  offset = rewardCount.offset;
  const rewards = {};
  for (let index = 0; index < rewardCount.value; index += 1) {
    assert.strictEqual(response.payload[offset], 1, "reward list entries must be non-null");
    offset += 1;
    const itemId = readSignedVarInt(response.payload, offset);
    const countFree = readSignedVarLong(response.payload, itemId.offset);
    const countPaid = readSignedVarLong(response.payload, countFree.offset);
    const bonusRatio = readSignedVarInt(response.payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    rewards[String(itemId.value)] = String(BigInt(countFree.value) + BigInt(countPaid.value));
  }
  assert.deepStrictEqual(rewards, Object.fromEntries(Object.entries(expectedRewards).map(([id, count]) => [id, String(count)])));
  assert.strictEqual(offset, response.payload.length, "unit-removal ACK must not contain trailing fields");
}

function mergeRewards(rewards) {
  const result = {};
  for (const reward of rewards) result[String(reward.itemId)] = (result[String(reward.itemId)] || 0) + reward.count;
  return result;
}

function assertNoMutation() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
}

function writeRawVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function readRawVarInt(buffer, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (shift < 32) {
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
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
      assert(result.ok, `managed client schema rejected unit-removal packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
