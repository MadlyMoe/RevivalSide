"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, grantEquipItem } = require("../modules/equipment");
const {
  getAllEquipIds,
  getEquipEnchantRequiredExp,
  getEquipTemplet,
  getEquipUpgradeTemplet,
  getMaxEquipEnchantLevel,
} = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeLongArray, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const UPGRADE_REQ = 1057;
const UPGRADE_ACK = 1058;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CREDIT = 98;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_EQUIP_UPGRADE_TEMPLET = 20980;
const NEC_FAIL_EQUIP_UPGRADE_CONDITION = 20981;
const NEC_FAIL_EQUIP_UPGRADE_DATA = 20982;
const NEC_FAIL_EQUIP_UPGRADE_MATERIAL = 20983;
const rootDir = path.resolve(__dirname, "..");
const upgradeRecords = JSON.parse(fs.readFileSync(path.join(
  rootDir,
  "gameplay-jsons",
  "StreamingAssets",
  "ab_script",
  "luac",
  "LUA_ITEM_EQUIP_UPGRADE.json"
), "utf8")).records;
const record = upgradeRecords.find((entry) => (
  getEquipTemplet(entry.CoreEquipID)
  && getEquipTemplet(entry.UpgradeEquipID)
  && Array.from({ length: 10 }, (_, index) => entry[`Material${index + 1}_ItemType`]).filter(Boolean).every((type) => type === "RT_MISC")
));
assert(record, "frozen tables must contain a misc-only equipment upgrade fixture");
const upgrade = getEquipUpgradeTemplet(record.CoreEquipID);
const coreTemplet = getEquipTemplet(record.CoreEquipID);
const resultTemplet = getEquipTemplet(record.UpgradeEquipID);
const maxLevel = Number(coreTemplet.m_MaxEnchantLevel || getMaxEquipEnchantLevel(coreTemplet.m_NKM_ITEM_TIER));
const costs = upgradeCosts(upgrade);
const nonCreditCost = costs.find((cost) => cost.itemId !== 1);
assert(upgrade && costs.length > 1 && nonCreditCost, "upgrade fixture must expose credit and misc costs");

const user = { userUid: "986000000000021", nickname: "EquipUpgradeCheck" };
const target = grantEquipItem(user, record.CoreEquipID, { enchantLevel: maxLevel, precision: 100, precision2: 100, setOptionId: 101 });
const lowEnchant = grantEquipItem(user, record.CoreEquipID, { enchantLevel: maxLevel - 1, precision: 100, precision2: 100 });
const lowPrecision = grantEquipItem(user, record.CoreEquipID, { enchantLevel: maxLevel, precision: 99, precision2: 100 });
const noUpgradeId = getAllEquipIds().find((id) => getEquipTemplet(id) && !getEquipUpgradeTemplet(id));
const noUpgrade = grantEquipItem(user, noUpgradeId);
const unexpectedMaterial = grantEquipItem(user, noUpgradeId);
assert(target && lowEnchant && lowPrecision && noUpgrade && unexpectedMaterial);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === UPGRADE_REQ);
assert(handler, "equipment upgrade handler must be registered");
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
assertFailure(NEC_FAIL_EQUIP_UPGRADE_DATA);
send(Buffer.concat([request(target.equipUid), Buffer.from([0])]), false);
assertFailure(NEC_FAIL_EQUIP_UPGRADE_DATA);
send(request(999999999n));
assertFailure(NEC_FAIL_INVALID_EQUIP_ITEM);
send(request(noUpgrade.equipUid));
assertFailure(NEC_FAIL_EQUIP_UPGRADE_TEMPLET);
send(request(lowEnchant.equipUid));
assertFailure(NEC_FAIL_EQUIP_UPGRADE_CONDITION);
send(request(lowPrecision.equipUid));
assertFailure(NEC_FAIL_EQUIP_UPGRADE_CONDITION);
send(request(target.equipUid, [unexpectedMaterial.equipUid]));
assertFailure(NEC_FAIL_EQUIP_UPGRADE_MATERIAL);
send(request(target.equipUid, [unexpectedMaterial.equipUid, unexpectedMaterial.equipUid]));
assertFailure(NEC_FAIL_EQUIP_UPGRADE_MATERIAL);

setExactBalances();
setMiscItemBalance(user, 1, 0);
send(request(target.equipUid));
assertFailure(NEC_FAIL_INSUFFICIENT_CREDIT);
setMiscItemBalance(user, 1, BigInt(costFor(1)));
setMiscItemBalance(user, nonCreditCost.itemId, 0);
send(request(target.equipUid));
assertFailure(NEC_FAIL_INSUFFICIENT_ITEM);
assert.strictEqual(saves, 0, "failed upgrades must not persist");
assert.strictEqual(getEquipItem(user, target.equipUid).itemEquipId, record.CoreEquipID);

for (const cost of costs) setMiscItemBalance(user, cost.itemId, BigInt(cost.count) + 100n);
const expectedProgress = upgradedProgress(coreTemplet, resultTemplet, maxLevel, 0);
send(request(target.equipUid));
assertSuccess();
const upgraded = getEquipItem(user, target.equipUid);
assert.strictEqual(upgraded.itemEquipId, record.UpgradeEquipID);
assert.strictEqual(upgraded.enchantLevel, expectedProgress.level);
assert.strictEqual(upgraded.enchantExp, expectedProgress.exp);
assert.strictEqual(upgraded.precision, 100);
assert.strictEqual(upgraded.precision2, 100);
assert.strictEqual(upgraded.setOptionId, 101);
for (const cost of costs) assert.strictEqual(getMiscItem(user, cost.itemId).countFree, "100");
assert(getEquipItem(user, unexpectedMaterial.equipUid), "unrequested equipment must remain owned");
assert.strictEqual(saves, 1, "successful upgrade must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, target.equipUid).itemEquipId, record.UpgradeEquipID);
assert.strictEqual(getEquipItem(restarted, target.equipUid).enchantLevel, expectedProgress.level);
validateManagedSchemas();
console.log(`[equip-upgrade-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(equipUid, materialUids = []) {
  return Buffer.concat([writeSignedVarLong(BigInt(equipUid)), writeLongArray(materialUids.map(BigInt))]);
}

function upgradeCosts(entry) {
  const result = [{ itemId: 1, count: Number(entry.UpgradeReqResource || 0) }];
  for (let index = 1; index <= 10; index += 1) {
    if (entry[`Material${index}_ItemType`] !== "RT_MISC") continue;
    result.push({
      itemId: Number(entry[`Material${index}_ItemID`] || 0),
      count: Number(entry[`Material${index}_ItemCount`] || 0),
    });
  }
  return result.filter((cost) => cost.itemId > 0 && cost.count > 0);
}

function setExactBalances() {
  for (const cost of costs) setMiscItemBalance(user, cost.itemId, cost.count);
}

function costFor(itemId) {
  const cost = costs.find((entry) => entry.itemId === itemId);
  return cost ? cost.count : 0;
}

function upgradedProgress(oldTemplet, nextTemplet, oldLevel, oldExp) {
  let total = Number(oldExp || 0);
  for (let level = 0; level < oldLevel; level += 1) {
    total += getEquipEnchantRequiredExp(oldTemplet.m_NKM_ITEM_TIER, level, oldTemplet.m_NKM_ITEM_GRADE);
  }
  const max = Math.min(Number(nextTemplet.m_MaxEnchantLevel || 10), getMaxEquipEnchantLevel(nextTemplet.m_NKM_ITEM_TIER), 10);
  let level = 0;
  while (level < max) {
    const required = getEquipEnchantRequiredExp(nextTemplet.m_NKM_ITEM_TIER, level, nextTemplet.m_NKM_ITEM_GRADE);
    if (required <= 0 || total < required) break;
    total -= required;
    level += 1;
  }
  return { level, exp: level >= max ? 0 : total };
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([UPGRADE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: UPGRADE_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response && response.packetId === UPGRADE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  assert.deepStrictEqual(Array.from(response.payload.subarray(error.offset)), [0, 0, 0], "failure ACK must contain null equipment and empty consumed and cost lists");
}

function assertSuccess() {
  assert(response && response.packetId === UPGRADE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, NEC_OK);
  assert.strictEqual(response.payload[error.offset], 1, "success ACK must contain authoritative upgraded equipment");
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
      assert(result.ok, `managed client schema rejected equipment-upgrade packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
