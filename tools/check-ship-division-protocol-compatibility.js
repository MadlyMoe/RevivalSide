"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getPlayableShipIds, getUnitRemoveRewards } = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureDeck, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const shipIds = getPlayableShipIds();
assert(shipIds.includes(21001) && shipIds.length >= 6, "frozen ship table must provide division fixtures");
const user = { userUid: "986000000000029", nickname: "ShipDivisionCheck" };
const basic = grantUnit(user, 21001);
const locked = grantUnit(user, shipIds[2]);
const atomic = grantUnit(user, shipIds[3]);
const removableA = grantUnit(user, shipIds[4]);
const removableB = grantUnit(user, shipIds[5]);
const normalUnit = grantUnit(user, 1004);
assert([basic, locked, atomic, removableA, removableB, normalUnit].every(Boolean));
const socket = { session: { user } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.SHIP_DIVISION_REQ);
assert(handler, "ship-division handler must be registered");
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
send(Buffer.concat([request([removableA.unitUid]), Buffer.from([0])]), false);
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([]));
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([removableA.unitUid, removableA.unitUid]));
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([0]));
assertAck(ERROR_CODES.INVALID_REQUEST, [], {});
send(request([atomic.unitUid, 999999999n]));
assertAck(ERROR_CODES.SHIP_INVALID_SHIP_UID, [], {});
assert(getArmyUnitByUid(user, atomic.unitUid), "multi-ship failure must be atomic");
send(request([normalUnit.unitUid]));
assertAck(ERROR_CODES.SHIP_INVALID_SHIP_UID, [], {});
assertNoMutation();

const deck = ensureDeck(user, { deckType: 1, index: 0 });
deck.shipUid = String(basic.unitUid);
send(request([basic.unitUid]));
assertAck(ERROR_CODES.SHIP_INVALID_SHIP_ID, [], {});
user.openTags = ["TAG_DELETE_BASIC_SHIP"];
send(request([basic.unitUid]));
assertAck(ERROR_CODES.UNIT_IN_DECK, [], {});

user.army.ships[String(locked.unitUid)].locked = true;
send(request([locked.unitUid]));
assertAck(ERROR_CODES.UNIT_LOCKED, [], {});
assertNoMutation();

const expectedRewards = mergeRewards([
  ...getUnitRemoveRewards(removableA.unitId, { fromContract: true }),
  ...getUnitRemoveRewards(removableB.unitId, { fromContract: true }),
]);
for (const itemId of Object.keys(expectedRewards)) setMiscItemBalance(user, itemId, 0);
send(request([removableA.unitUid, removableB.unitUid]));
assertAck(ERROR_CODES.OK, [BigInt(removableA.unitUid), BigInt(removableB.unitUid)], expectedRewards);
assert.strictEqual(getArmyUnitByUid(user, removableA.unitUid), null);
assert.strictEqual(getArmyUnitByUid(user, removableB.unitUid), null);
for (const [itemId, count] of Object.entries(expectedRewards)) {
  assert.strictEqual(BigInt(getMiscItem(user, itemId).countFree), BigInt(count));
}
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnitByUid(restarted, removableA.unitUid), null);
assert.strictEqual(getArmyUnitByUid(restarted, removableB.unitUid), null);
for (const [itemId, count] of Object.entries(expectedRewards)) {
  assert.strictEqual(BigInt(getMiscItem(restarted, itemId).countFree), BigInt(count));
}

validateManagedSchemas();
console.log(`[ship-division-protocol-check] PASS rewards=${Object.keys(expectedRewards).length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(uids) {
  const values = Array.isArray(uids) ? uids : [];
  return Buffer.concat([writeRawVarInt(values.length), ...values.map((uid) => writeSignedVarLong(BigInt(uid)))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.SHIP_DIVISION_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.SHIP_DIVISION_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedRemoved, expectedRewards) {
  assert(response, "ship-division handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_DIVISION_ACK);
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
    assert.strictEqual(response.payload[offset++], 1);
    const itemId = readSignedVarInt(response.payload, offset);
    const countFree = readSignedVarLong(response.payload, itemId.offset);
    const countPaid = readSignedVarLong(response.payload, countFree.offset);
    const bonusRatio = readSignedVarInt(response.payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    rewards[String(itemId.value)] = String(BigInt(countFree.value) + BigInt(countPaid.value));
  }
  assert.deepStrictEqual(rewards, Object.fromEntries(Object.entries(expectedRewards).map(([id, count]) => [id, String(count)])));
  assert.strictEqual(offset, response.payload.length);
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
      assert(result.ok, `managed client schema rejected ship-division packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
