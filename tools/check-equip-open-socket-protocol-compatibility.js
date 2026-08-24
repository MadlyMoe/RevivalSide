"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipTemplet } = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const OPEN_REQ = 1059;
const OPEN_ACK = 1060;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CREDIT = 98;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_EQUIP_NOT_RELIC = 20987;
const NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX = 20988;
const NEC_FAIL_EQUIP_NOT_ENOUGH_CHCHANT_LEVEL = 20992;
const rootDir = path.resolve(__dirname, "..");
const relicId = getAllEquipIds().find((id) => {
  const item = getEquipTemplet(id);
  return item && item.m_bRelic === true && Number(item.Socket1_OpenItemID || 0) > 0;
});
const ordinaryId = getAllEquipIds().find((id) => {
  const item = getEquipTemplet(id);
  return item && item.m_bRelic !== true;
});
assert(relicId && ordinaryId, "frozen tables must contain relic and ordinary equipment fixtures");
const templet = getEquipTemplet(relicId);
const user = { userUid: "986000000000020", nickname: "EquipOpenSocketCheck" };
const relic = grantEquipItem(user, relicId, { enchantLevel: 1 });
const ordinary = grantEquipItem(user, ordinaryId, { enchantLevel: 10 });
assert(relic && ordinary);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === OPEN_REQ);
assert(handler, "equipment socket-open handler must be registered");
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
assertFailure(NEC_FAIL_INVALID_EQUIP_ITEM);
send(Buffer.concat([request(relic.equipUid, 0), Buffer.from([0])]), false);
assertFailure(NEC_FAIL_INVALID_EQUIP_ITEM);
send(request(999999999n, 0));
assertFailure(NEC_FAIL_INVALID_EQUIP_ITEM);
send(request(ordinary.equipUid, 0));
assertFailure(NEC_FAIL_EQUIP_NOT_RELIC);
send(request(relic.equipUid, -1));
assertFailure(NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX);
send(request(relic.equipUid, 3));
assertFailure(NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX);
send(request(relic.equipUid, 1));
assertFailure(NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX);
send(request(relic.equipUid, 0));
assertFailure(NEC_FAIL_EQUIP_NOT_ENOUGH_CHCHANT_LEVEL);

getEquipItem(user, relic.equipUid).enchantLevel = 2;
const firstCosts = socketCosts(0);
setBalances(firstCosts, 0n);
setMiscItemBalance(user, 1, 0);
send(request(relic.equipUid, 0));
assertFailure(NEC_FAIL_INSUFFICIENT_CREDIT);
setMiscItemBalance(user, 1, BigInt(costFor(firstCosts, 1)));
setMiscItemBalance(user, costItemId(firstCosts), 0);
send(request(relic.equipUid, 0));
assertFailure(NEC_FAIL_INSUFFICIENT_ITEM);
assert.strictEqual(saves, 0, "failed socket opens must not persist");

setBalances(firstCosts, 100n);
send(request(relic.equipUid, 0));
assertSuccess();
assert(socketAt(getEquipItem(user, relic.equipUid), 0), "first eligible socket must open");
assertFinalBalances(firstCosts, 100n);
assert.strictEqual(saves, 1);
send(request(relic.equipUid, 0));
assertFailure(NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX);
getEquipItem(user, relic.equipUid).enchantLevel = 4;
send(request(relic.equipUid, 1));
assertFailure(NEC_FAIL_EQUIP_NOT_ENOUGH_CHCHANT_LEVEL);

getEquipItem(user, relic.equipUid).enchantLevel = 5;
const secondCosts = socketCosts(1);
setBalances(secondCosts, 200n);
send(request(relic.equipUid, 1));
assertSuccess();
assert(socketAt(getEquipItem(user, relic.equipUid), 1), "second eligible socket must open in sequence");
assertFinalBalances(secondCosts, 200n);
assert.strictEqual(saves, 2, "each successful socket open must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert(socketAt(getEquipItem(restarted, relic.equipUid), 0));
assert(socketAt(getEquipItem(restarted, relic.equipUid), 1));
validateManagedSchemas();
console.log(`[equip-open-socket-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(equipUid, socketIndex) {
  return Buffer.concat([writeSignedVarLong(BigInt(equipUid)), writeSignedVarInt(socketIndex)]);
}

function socketCosts(index) {
  const number = index + 1;
  return [
    { itemId: 1, count: Number(templet[`Socket${number}_ReqResource`] || 0) },
    { itemId: Number(templet[`Socket${number}_OpenItemID`] || 0), count: Number(templet[`Socket${number}_OpenCount`] || 0) },
  ].filter((cost) => cost.itemId > 0 && cost.count > 0);
}

function costFor(costs, itemId) {
  const cost = costs.find((entry) => entry.itemId === itemId);
  return cost ? cost.count : 0;
}

function costItemId(costs) {
  const cost = costs.find((entry) => entry.itemId !== 1);
  assert(cost, "fixture must require a non-credit socket item");
  return cost.itemId;
}

function setBalances(costs, remainder) {
  for (const cost of costs) setMiscItemBalance(user, cost.itemId, BigInt(cost.count) + remainder);
}

function assertFinalBalances(costs, remainder) {
  for (const cost of costs) assert.strictEqual(getMiscItem(user, cost.itemId).countFree, String(remainder));
}

function socketAt(equip, index) {
  return Boolean((((equip && equip.potentialOptions || [])[0] || {}).sockets || [])[index]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([OPEN_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: OPEN_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response && response.packetId === OPEN_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  assert.deepStrictEqual(Array.from(response.payload.subarray(error.offset)), [0, 0], "failure ACK must contain null equipment and no cost items");
}

function assertSuccess() {
  assert(response && response.packetId === OPEN_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, NEC_OK);
  assert.strictEqual(response.payload[error.offset], 1, "success ACK must contain authoritative equipment");
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
      assert(result.ok, `managed client schema rejected socket-open packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
