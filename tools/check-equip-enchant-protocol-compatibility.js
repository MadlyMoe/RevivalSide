"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { equipItemToUnit, getEquipItem, grantEquipItem } = require("../modules/equipment");
const {
  getAllEquipIds,
  getEquipEnchantFeedExp,
  getEquipEnchantRequiredExp,
  getEquipTemplet,
  getMaxEquipEnchantLevel,
} = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureDeck, grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeLongArray,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ENCHANT_REQ = 1002;
const ENCHANT_ACK = 1003;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CREDIT = 98;
const NEC_FAIL_UNIT_EQUIP_ITEM = 141;
const NEC_FAIL_WARFARE_DOING = 213;
const NEC_FAIL_INVALID_ITEM_UID = 245;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_ITEM_LOCKED = 250;
const NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX = 251;
const rootDir = path.resolve(__dirname, "..");
const equipId = getAllEquipIds().find((id) => {
  const templet = getEquipTemplet(id);
  if (!templet || Number(templet.m_FeedEXP || 0) <= 0) return false;
  const feed = getEquipEnchantFeedExp(id, 0);
  const required = getEquipEnchantRequiredExp(templet.m_NKM_ITEM_TIER, 0, templet.m_NKM_ITEM_GRADE);
  return feed > 0 && required > feed;
});
assert(equipId, "frozen equipment tables must contain an enchant fixture");
const templet = getEquipTemplet(equipId);
const maxLevel = Math.min(Number(templet.m_MaxEnchantLevel || 10), getMaxEquipEnchantLevel(templet.m_NKM_ITEM_TIER), 10);
const user = { userUid: "986000000000017", nickname: "EquipEnchantCheck" };
const target = grantEquipItem(user, equipId);
const first = grantEquipItem(user, equipId);
const second = grantEquipItem(user, equipId);
const locked = grantEquipItem(user, equipId, { locked: true });
const equippedMaterial = grantEquipItem(user, equipId);
const maxTarget = grantEquipItem(user, equipId, { enchantLevel: maxLevel });
const deckTarget = grantEquipItem(user, equipId);
const materialUnit = grantUnit(user, 1001);
const warfareUnit = grantUnit(user, 1001);
assert(target && first && second && locked && equippedMaterial && maxTarget && deckTarget && materialUnit && warfareUnit);
assert(equipItemToUnit(user, materialUnit.unitUid, equippedMaterial.equipUid, 0).equip);
assert(equipItemToUnit(user, warfareUnit.unitUid, deckTarget.equipUid, 0).equip);
const warfareDeck = ensureDeck(user, { deckType: 1, index: 0 });
warfareDeck.unitUids[0] = warfareUnit.unitUid;
warfareDeck.state = 2;
setMiscItemBalance(user, 1, 0);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === ENCHANT_REQ);
assert(handler, "equipment enchant handler must be registered");
const managedWire = [];
let response = null;
let saves = 0;
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
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, 0n, 0, 0);
send(Buffer.concat([enchantRequest(target.equipUid, [first.equipUid]), Buffer.from([0])]), false);
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, BigInt(target.equipUid), 0, 0);
send(enchantRequest(999999999n, [first.equipUid]));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, 999999999n, 0, 0);
send(enchantRequest(maxTarget.equipUid, [first.equipUid]));
assertAck(NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX, BigInt(maxTarget.equipUid), maxLevel, 0);
send(enchantRequest(target.equipUid, []));
assertAck(NEC_FAIL_INVALID_ITEM_UID, BigInt(target.equipUid), 0, 0);
send(enchantRequest(target.equipUid, [target.equipUid]));
assertAck(NEC_FAIL_INVALID_ITEM_UID, BigInt(target.equipUid), 0, 0);
send(enchantRequest(target.equipUid, [first.equipUid, first.equipUid]));
assertAck(NEC_FAIL_INVALID_ITEM_UID, BigInt(target.equipUid), 0, 0);
send(enchantRequest(target.equipUid, [999999999n]));
assertAck(NEC_FAIL_INVALID_ITEM_UID, BigInt(target.equipUid), 0, 0);
send(enchantRequest(target.equipUid, [locked.equipUid]));
assertAck(NEC_FAIL_ITEM_LOCKED, BigInt(target.equipUid), 0, 0);
send(enchantRequest(target.equipUid, [equippedMaterial.equipUid]));
assertAck(NEC_FAIL_UNIT_EQUIP_ITEM, BigInt(target.equipUid), 0, 0);
send(enchantRequest(deckTarget.equipUid, [first.equipUid]));
assertAck(NEC_FAIL_WARFARE_DOING, BigInt(deckTarget.equipUid), 0, 0);
send(enchantRequest(target.equipUid, [first.equipUid]));
assertAck(NEC_FAIL_INSUFFICIENT_CREDIT, BigInt(target.equipUid), 0, 0);
assert(getEquipItem(user, first.equipUid) && getEquipItem(user, second.equipUid));
assert.strictEqual(saves, 0, "failed enchant requests must not persist");

const addedExp = getEquipEnchantFeedExp(equipId, 0) * 2;
const creditCost = BigInt(addedExp * 8);
setMiscItemBalance(user, 1, creditCost + 100n);
const expected = applyExpectedExp(0, 0, addedExp);
send(enchantRequest(target.equipUid, [first.equipUid, second.equipUid]));
assertAck(NEC_OK, BigInt(target.equipUid), expected.level, expected.exp, [BigInt(first.equipUid), BigInt(second.equipUid)], [[1, 100n]]);
assert.strictEqual(getEquipItem(user, first.equipUid), null);
assert.strictEqual(getEquipItem(user, second.equipUid), null);
assert.strictEqual(getEquipItem(user, target.equipUid).enchantLevel, expected.level);
assert.strictEqual(getEquipItem(user, target.equipUid).enchantExp, expected.exp);
assert.strictEqual(getMiscItem(user, 1).countFree, "100");
assert.strictEqual(saves, 1, "successful enchant must persist once");

send(enchantRequest(target.equipUid, [first.equipUid]));
assertAck(NEC_FAIL_INVALID_ITEM_UID, BigInt(target.equipUid), expected.level, expected.exp);
assert.strictEqual(saves, 1);
const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, first.equipUid), null);
assert.strictEqual(getEquipItem(restarted, target.equipUid).enchantLevel, expected.level);
assert.strictEqual(getEquipItem(restarted, target.equipUid).enchantExp, expected.exp);
assert.strictEqual(getMiscItem(restarted, 1).countFree, "100");

validateManagedSchemas();
console.log(`[equip-enchant-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function enchantRequest(targetUid, materialUids) {
  return Buffer.concat([writeSignedVarLong(BigInt(targetUid)), writeLongArray(materialUids.map(BigInt))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([ENCHANT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: ENCHANT_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedLevel, expectedExp, expectedConsumed = [], expectedCosts = []) {
  assert(response, "equipment enchant handler must send an ACK");
  assert.strictEqual(response.packetId, ENCHANT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const level = readSignedVarInt(response.payload, uid.offset);
  const exp = readSignedVarInt(response.payload, level.offset);
  const consumed = readLongList(response.payload, exp.offset);
  const costs = readItemList(response.payload, consumed.offset);
  assert.deepStrictEqual([error.value, uid.value, level.value, exp.value], [expectedError, expectedUid, expectedLevel, expectedExp]);
  assert.deepStrictEqual(consumed.values, expectedConsumed);
  assert.deepStrictEqual(costs.values.map((item) => [item.itemId, item.countFree]), expectedCosts);
  assert.strictEqual(costs.offset, response.payload.length, "equipment enchant ACK must not contain trailing fields");
}

function applyExpectedExp(level, exp, addedExp) {
  exp += addedExp;
  while (level < maxLevel) {
    const required = getEquipEnchantRequiredExp(templet.m_NKM_ITEM_TIER, level, templet.m_NKM_ITEM_GRADE);
    if (required <= 0 || exp < required) break;
    exp -= required;
    level += 1;
  }
  if (level >= maxLevel) exp = 0;
  return { level, exp };
}

function readLongList(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readSignedVarLong(payload, offset);
    values.push(item.value);
    offset = item.offset;
  }
  return { values, offset };
}

function readItemList(payload, offset) {
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
      assert(result.ok, `managed client schema rejected equipment enchant packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
