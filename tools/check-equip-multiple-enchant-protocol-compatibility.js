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
  readSignedVarInt,
  writeBool,
  writeLongArray,
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeVarInt,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ENCHANT_REQ = 1076;
const ENCHANT_ACK = 1077;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CREDIT = 98;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_WARFARE_DOING = 213;
const NEC_FAIL_EQUIP_LEVEL_ALREADY_ENOUGH = 28003;
const NEC_FAIL_EQUIP_MULTIPLE_COUNT_MAX = 28004;
const NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP = 28005;
const rootDir = path.resolve(__dirname, "..");
const definitions = getEquipEnchantMaterials();
const equipId = getAllEquipIds().find((id) => {
  const item = getEquipTemplet(id);
  return item && item.m_bRelic !== true && getMaxEquipEnchantLevel(item.m_NKM_ITEM_TIER) >= 2;
});
const relicId = getAllEquipIds().find((id) => {
  const item = getEquipTemplet(id);
  return item && item.m_bRelic === true && !Number(item.Socket1_OpenItemID || 0) && getMaxEquipEnchantLevel(item.m_NKM_ITEM_TIER) >= 2;
});
assert(equipId && relicId && definitions.length === 4, "frozen tables must contain multi-enchant fixtures");
const user = { userUid: "986000000000019", nickname: "EquipMultipleEnchantCheck" };
const first = grantEquipItem(user, equipId);
const second = grantEquipItem(user, equipId);
const already = grantEquipItem(user, equipId, { enchantLevel: 2 });
const deckTarget = grantEquipItem(user, equipId);
const relic = grantEquipItem(user, relicId);
const overflow = Array.from({ length: 11 }, () => grantEquipItem(user, equipId));
const warfareUnit = grantUnit(user, 1001);
assert(first && second && already && deckTarget && relic && overflow.every(Boolean) && warfareUnit);
assert(equipItemToUnit(user, warfareUnit.unitUid, deckTarget.equipUid, 0).equip);
const warfareDeck = ensureDeck(user, { deckType: 1, index: 0 });
warfareDeck.unitUids[0] = warfareUnit.unitUid;
warfareDeck.state = 2;
for (const definition of definitions) setMiscItemBalance(user, definition.itemId, 100000);
setMiscItemBalance(user, 1, 0);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === ENCHANT_REQ);
assert(handler, "multiple equipment enchant handler must be registered");
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
const firstMaterials = materialsToLevel(first, 2);
const secondMaterials = materialsToLevel(second, 2);
const validEntries = [[first.equipUid, firstMaterials], [second.equipUid, secondMaterials]];

send(Buffer.alloc(0), false);
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(Buffer.concat([multipleRequest([first.equipUid], [[first.equipUid, firstMaterials]], 2, false), Buffer.from([0])]), false);
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([], [], 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest(overflow.map((equip) => equip.equipUid), overflow.map((equip) => [equip.equipUid, materialsToLevel(equip, 2)]), 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_COUNT_MAX);
send(multipleRequest([first.equipUid, first.equipUid], validEntries, 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([999999999n], [[999999999n, firstMaterials]], 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([first.equipUid, second.equipUid], [[first.equipUid, firstMaterials]], 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([first.equipUid], [[first.equipUid, firstMaterials], [first.equipUid, firstMaterials]], 2, false), false);
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([first.equipUid], [[first.equipUid, firstMaterials.slice(0, 3)]], 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([first.equipUid], [[first.equipUid, firstMaterials]], 3, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([already.equipUid], [[already.equipUid, firstMaterials]], 2, false));
assertFailure(NEC_FAIL_EQUIP_LEVEL_ALREADY_ENOUGH);
send(multipleRequest([first.equipUid], [[first.equipUid, zeroMaterials()]], 2, false));
assertFailure(NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP);
send(multipleRequest([deckTarget.equipUid], [[deckTarget.equipUid, materialsToLevel(deckTarget, 2)]], 2, false));
assertFailure(NEC_FAIL_WARFARE_DOING);

const materialId = definitions[2].itemId;
setMiscItemBalance(user, materialId, 0);
send(multipleRequest([first.equipUid, second.equipUid], validEntries, 2, false));
assertFailure(NEC_FAIL_INSUFFICIENT_ITEM);
const totalMaterial = firstMaterials[2].count + secondMaterials[2].count;
setMiscItemBalance(user, materialId, totalMaterial);
send(multipleRequest([first.equipUid, second.equipUid], validEntries, 2, false));
assertFailure(NEC_FAIL_INSUFFICIENT_CREDIT);
assert.strictEqual(saves, 0, "failed multiple enchants must not persist");

const totalExp = totalMaterial * definitions[2].exp;
const creditCost = BigInt(totalExp * 8);
setMiscItemBalance(user, 1, creditCost + 100n);
send(multipleRequest([first.equipUid, second.equipUid], validEntries, 2, false));
assertSuccess(2);
assert(getEquipItem(user, first.equipUid).enchantLevel >= 2);
assert(getEquipItem(user, second.equipUid).enchantLevel >= 2);
assert.strictEqual(getMiscItem(user, materialId).countFree, "0");
assert.strictEqual(getMiscItem(user, 1).countFree, "100");
assert.strictEqual(saves, 1);

const relicMaterials = materialsToLevel(relic, 2);
const relicMaterialCount = relicMaterials[2].count;
const relicTemplet = getEquipTemplet(relicId);
const relicCreditCost = BigInt(relicMaterialCount * definitions[2].exp * 8 + Number(relicTemplet.Socket1_ReqResource || 0));
setMiscItemBalance(user, materialId, relicMaterialCount);
setMiscItemBalance(user, 1, relicCreditCost + 100n);
send(multipleRequest([relic.equipUid], [[relic.equipUid, relicMaterials]], 2, true));
assertSuccess(1);
const openedRelic = getEquipItem(user, relic.equipUid);
assert(openedRelic.enchantLevel >= 2);
assert((((openedRelic.potentialOptions || [])[0] || {}).sockets || [])[0], "eligible relic socket must open");
assert.strictEqual(getMiscItem(user, 1).countFree, "100");
assert.strictEqual(saves, 2, "each successful multiple enchant must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert(getEquipItem(restarted, first.equipUid).enchantLevel >= 2);
assert(((((getEquipItem(restarted, relic.equipUid).potentialOptions || [])[0] || {}).sockets || [])[0]));

validateManagedSchemas();
console.log(`[equip-multiple-enchant-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function materialsToLevel(equip, targetLevel) {
  const item = getEquipTemplet(equip.itemEquipId);
  let needed = -Number(equip.enchantExp || 0);
  for (let level = Number(equip.enchantLevel || 0); level < targetLevel; level += 1) {
    needed += getEquipEnchantRequiredExp(item.m_NKM_ITEM_TIER, level, item.m_NKM_ITEM_GRADE);
  }
  const result = zeroMaterials();
  result[2].count = Math.ceil(needed / definitions[2].exp);
  return result;
}

function zeroMaterials() {
  return definitions.map((definition) => ({ itemId: definition.itemId, count: 0 }));
}

function multipleRequest(equipUids, entries, targetLevel, openSocket) {
  return Buffer.concat([
    writeLongArray(equipUids.map(BigInt)),
    writeDictionary(entries),
    writeSignedVarInt(targetLevel),
    writeBool(openSocket),
  ]);
}

function writeDictionary(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([equipUid, materials]) => [
      writeSignedVarLong(BigInt(equipUid)),
      materials == null ? writeNullObject() : writeNullableObject(writeObjectList(materials.map((material) => (
        material == null ? writeNullObject() : writeNullableObject(Buffer.concat([
          writeSignedVarInt(material.itemId),
          writeSignedVarInt(material.count),
        ]))
      )))),
    ]),
  ]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([ENCHANT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: ENCHANT_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response && response.packetId === ENCHANT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  assert.deepStrictEqual(Array.from(response.payload.subarray(error.offset)), [0, 0, 0], "failure ACK collections must be empty");
}

function assertSuccess(expectedEquipCount) {
  assert(response && response.packetId === ENCHANT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, NEC_OK);
  const count = readUnsignedVarInt(response.payload, error.offset);
  assert.strictEqual(count.value, expectedEquipCount);
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
      assert(result.ok, `managed client schema rejected multiple equipment enchant packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
