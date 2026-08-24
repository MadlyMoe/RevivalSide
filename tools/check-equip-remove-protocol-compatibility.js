"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { equipItemToUnit, getEquipItem, grantEquipItem } = require("../modules/equipment");
const { getMiscItem } = require("../modules/inventory");
const { grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeLongArray,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const REMOVE_REQ = 1006;
const REMOVE_ACK = 1007;
const NEC_OK = 0;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_CANNOT_UNEQUIP_ITEM = 249;
const NEC_FAIL_ITEM_LOCKED = 250;
const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000015", nickname: "EquipRemoveCheck" };
const first = grantEquipItem(user, 101004);
const second = grantEquipItem(user, 101001);
const locked = grantEquipItem(user, 101002, { locked: true });
const equipped = grantEquipItem(user, 101001);
const unit = grantUnit(user, 1001);
assert(first && second && locked && equipped && unit, "frozen equipment and unit tables must contain removal fixtures");
assert(equipItemToUnit(user, unit.unitUid, equipped.equipUid, 1).equip);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === REMOVE_REQ);
assert(handler, "equipment removal handler must be registered");
const managedWire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM);
send(Buffer.concat([removeRequest([BigInt(first.equipUid)]), Buffer.from([0])]), false);
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM);
send(removeRequest([]));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM);
send(removeRequest([BigInt(first.equipUid), BigInt(first.equipUid)]));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM);
send(removeRequest([BigInt(first.equipUid), 999999999n]));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM);
send(removeRequest([BigInt(first.equipUid), BigInt(locked.equipUid)]));
assertAck(NEC_FAIL_ITEM_LOCKED);
send(removeRequest([BigInt(first.equipUid), BigInt(equipped.equipUid)]));
assertAck(NEC_FAIL_CANNOT_UNEQUIP_ITEM);
assert(getEquipItem(user, first.equipUid), "failed atomic removals must retain valid equipment");
assert.strictEqual(saves, 0, "failed removals must not persist");

send(removeRequest([BigInt(first.equipUid), BigInt(second.equipUid)]));
assertAck(NEC_OK, [BigInt(first.equipUid), BigInt(second.equipUid)], [[1, 600n], [31, 50n]]);
assert.strictEqual(getEquipItem(user, first.equipUid), null);
assert.strictEqual(getEquipItem(user, second.equipUid), null);
assert.strictEqual(getMiscItem(user, 1).countFree, "600");
assert.strictEqual(getMiscItem(user, 31).countFree, "50");
assert.strictEqual(saves, 1, "successful atomic removal must persist once");

send(removeRequest([BigInt(first.equipUid)]));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM);
assert.strictEqual(saves, 1, "repeated removal must not persist");
const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, first.equipUid), null);
assert.strictEqual(getMiscItem(restarted, 1).countFree, "600");
assert.strictEqual(getMiscItem(restarted, 31).countFree, "50");

validateManagedSchemas();
console.log(`[equip-remove-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function removeRequest(uids) {
  return writeLongArray(uids);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([REMOVE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: REMOVE_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUids = [], expectedRewards = []) {
  assert(response, "equipment removal handler must send an ACK");
  assert.strictEqual(response.packetId, REMOVE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uids = readLongList(response.payload, error.offset);
  const rewards = readRewardItems(response.payload, uids.offset);
  assert.strictEqual(error.value, expectedError);
  assert.deepStrictEqual(uids.values, expectedUids);
  assert.deepStrictEqual(rewards.values.map((item) => [item.itemId, item.countFree]), expectedRewards);
  assert.strictEqual(rewards.offset, response.payload.length, "equipment removal ACK must not contain trailing fields");
}

function readLongList(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readSignedVarLong(payload, offset);
    values.push(value.value);
    offset = value.offset;
  }
  return { values, offset };
}

function readRewardItems(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const itemId = readSignedVarInt(payload, present.offset);
    const countFree = readSignedVarLong(payload, itemId.offset);
    const countPaid = readSignedVarLong(payload, countFree.offset);
    const bonusRatio = readSignedVarInt(payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    assert.strictEqual(countPaid.value, 0n);
    assert.strictEqual(bonusRatio.value, 0);
    values.push({ itemId: itemId.value, countFree: countFree.value });
  }
  return { values, offset };
}

function readUnsignedVarInt(payload, offset) {
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated collection count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("collection count varint too long");
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
      assert(result.ok, `managed client schema rejected equipment removal packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
