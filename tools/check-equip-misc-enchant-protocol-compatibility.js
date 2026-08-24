"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { equipItemToUnit, getEquipItem, grantEquipItem } = require("../modules/equipment");
const {
  getAllEquipIds,
  getEquipEnchantMaterials,
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
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ENCHANT_REQ = 1063;
const ENCHANT_ACK = 1064;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CREDIT = 98;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_WARFARE_DOING = 213;
const NEC_FAIL_INVALID_ITEM_ID = 244;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX = 251;
const rootDir = path.resolve(__dirname, "..");
const definitions = getEquipEnchantMaterials();
assert.strictEqual(definitions.length, 4, "frozen misc enchant contract must expose four ordered materials");
const equipId = getAllEquipIds().find((id) => {
  const item = getEquipTemplet(id);
  return item && getEquipEnchantRequiredExp(item.m_NKM_ITEM_TIER, 0, item.m_NKM_ITEM_GRADE) > 0;
});
assert(equipId, "frozen equipment tables must contain an enchant target");
const templet = getEquipTemplet(equipId);
const maxLevel = Math.min(Number(templet.m_MaxEnchantLevel || 10), getMaxEquipEnchantLevel(templet.m_NKM_ITEM_TIER), 10);
const user = { userUid: "986000000000018", nickname: "EquipMiscEnchantCheck" };
const target = grantEquipItem(user, equipId);
const maxTarget = grantEquipItem(user, equipId, { enchantLevel: maxLevel });
const deckTarget = grantEquipItem(user, equipId);
const warfareUnit = grantUnit(user, 1001);
assert(target && maxTarget && deckTarget && warfareUnit);
assert(equipItemToUnit(user, warfareUnit.unitUid, deckTarget.equipUid, 0).equip);
const warfareDeck = ensureDeck(user, { deckType: 1, index: 0 });
warfareDeck.unitUids[0] = warfareUnit.unitUid;
warfareDeck.state = 2;
for (const material of definitions) setMiscItemBalance(user, material.itemId, 5);
setMiscItemBalance(user, 1, 0);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === ENCHANT_REQ);
assert(handler, "misc equipment enchant handler must be registered");
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
const zeroMaterials = definitions.map((material) => ({ itemId: material.itemId, count: 0 }));
const selectedMaterials = definitions.map((material, index) => ({ itemId: material.itemId, count: index === 0 ? 1 : index === 1 ? 2 : 0 }));

send(Buffer.alloc(0), false);
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, 0n, 0, 0);
send(Buffer.concat([miscRequest(target.equipUid, selectedMaterials), Buffer.from([0])]), false);
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, BigInt(target.equipUid), 0, 0);
send(miscRequest(999999999n, selectedMaterials));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, 999999999n, 0, 0);
send(miscRequest(maxTarget.equipUid, selectedMaterials));
assertAck(NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX, BigInt(maxTarget.equipUid), maxLevel, 0);
send(miscRequest(target.equipUid, selectedMaterials.slice(0, 3)));
assertAck(NEC_FAIL_INVALID_ITEM_ID, BigInt(target.equipUid), 0, 0);
send(miscRequest(target.equipUid, [null, ...selectedMaterials.slice(1)]));
assertAck(NEC_FAIL_INVALID_ITEM_ID, BigInt(target.equipUid), 0, 0);
send(miscRequest(target.equipUid, [selectedMaterials[1], selectedMaterials[0], ...selectedMaterials.slice(2)]));
assertAck(NEC_FAIL_INVALID_ITEM_ID, BigInt(target.equipUid), 0, 0);
send(miscRequest(target.equipUid, [{ ...selectedMaterials[0], count: -1 }, ...selectedMaterials.slice(1)]));
assertAck(NEC_FAIL_INVALID_ITEM_ID, BigInt(target.equipUid), 0, 0);
send(miscRequest(target.equipUid, zeroMaterials));
assertAck(NEC_FAIL_INVALID_ITEM_ID, BigInt(target.equipUid), 0, 0);
setMiscItemBalance(user, definitions[0].itemId, 0);
send(miscRequest(target.equipUid, selectedMaterials));
assertAck(NEC_FAIL_INSUFFICIENT_ITEM, BigInt(target.equipUid), 0, 0);
setMiscItemBalance(user, definitions[0].itemId, 5);
send(miscRequest(deckTarget.equipUid, selectedMaterials));
assertAck(NEC_FAIL_WARFARE_DOING, BigInt(deckTarget.equipUid), 0, 0);
send(miscRequest(target.equipUid, selectedMaterials));
assertAck(NEC_FAIL_INSUFFICIENT_CREDIT, BigInt(target.equipUid), 0, 0);
assert.strictEqual(saves, 0, "failed misc enchant requests must not persist");

const addedExp = definitions[0].exp + definitions[1].exp * 2;
const creditCost = BigInt(addedExp * 8);
setMiscItemBalance(user, 1, creditCost + 100n);
const expected = applyExpectedExp(0, 0, addedExp);
send(miscRequest(target.equipUid, selectedMaterials));
assertAck(NEC_OK, BigInt(target.equipUid), expected.level, expected.exp, [
  [definitions[0].itemId, 4n],
  [definitions[1].itemId, 3n],
  [1, 100n],
]);
assert.strictEqual(getMiscItem(user, definitions[0].itemId).countFree, "4");
assert.strictEqual(getMiscItem(user, definitions[1].itemId).countFree, "3");
assert.strictEqual(getMiscItem(user, 1).countFree, "100");
assert.strictEqual(getEquipItem(user, target.equipUid).enchantLevel, expected.level);
assert.strictEqual(getEquipItem(user, target.equipUid).enchantExp, expected.exp);
assert.strictEqual(saves, 1, "successful misc enchant must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getMiscItem(restarted, definitions[0].itemId).countFree, "4");
assert.strictEqual(getEquipItem(restarted, target.equipUid).enchantExp, expected.exp);

validateManagedSchemas();
console.log(`[equip-misc-enchant-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function miscRequest(targetUid, materials) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(targetUid)),
    writeObjectList(materials.map((material) => material ? writeNullableObject(Buffer.concat([
      writeSignedVarInt(material.itemId),
      writeSignedVarInt(material.count),
    ])) : writeNullObject())),
  ]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([ENCHANT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: ENCHANT_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedLevel, expectedExp, expectedCosts = []) {
  assert(response, "misc equipment enchant handler must send an ACK");
  assert.strictEqual(response.packetId, ENCHANT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const level = readSignedVarInt(response.payload, uid.offset);
  const exp = readSignedVarInt(response.payload, level.offset);
  const costs = readItemList(response.payload, exp.offset);
  assert.deepStrictEqual([error.value, uid.value, level.value, exp.value], [expectedError, expectedUid, expectedLevel, expectedExp]);
  assert.deepStrictEqual(costs.values.map((item) => [item.itemId, item.countFree]), expectedCosts);
  assert.strictEqual(costs.offset, response.payload.length, "misc equipment enchant ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected misc equipment enchant packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
