"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, getPotentialRerollCosts, grantEquipItem } = require("../modules/equipment");
const {
  getAllEquipIds,
  getEquipPotentialOptionRecords,
  getEquipPrecisionWeightRecords,
  getEquipTemplet,
} = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");

const PACKETS = Object.freeze({
  CHANGE_REQ: 1068,
  CHANGE_ACK: 1069,
  CONFIRM_REQ: 1070,
  CONFIRM_ACK: 1071,
  CANCEL_REQ: 1072,
  CANCEL_ACK: 1073,
});
const ERROR = Object.freeze({
  OK: 0,
  CREDIT: 98,
  ITEM: 111,
  INVALID_EQUIP: 247,
  INVALID_REQUEST: 20191,
  NOT_RELIC: 20987,
  INVALID_SOCKET: 20988,
  INVALID_OPTION_KEY: 20990,
  NOT_ENOUGH_ENCHANT: 20992,
  LOGICAL: 20993,
  ANOTHER_EQUIP: 26111,
});
const rootDir = path.resolve(__dirname, "..");
const requestIds = [PACKETS.CHANGE_REQ, PACKETS.CONFIRM_REQ, PACKETS.CANCEL_REQ];
const handlers = new Map(createEquipmentPipelineHandlers().filter((handler) => requestIds.includes(handler.packetId)).map((handler) => [handler.packetId, handler]));
assert.deepStrictEqual(Array.from(handlers.keys()), requestIds);

const dualRelicId = getAllEquipIds().find((id) => {
  const record = getEquipTemplet(id);
  return record && record.m_bRelic === true && Number(record.m_SubPotentialOptionGroupID || 0) > 0;
});
const ordinaryId = getAllEquipIds().find((id) => getEquipTemplet(id).m_bRelic !== true);
assert(dualRelicId && ordinaryId, "frozen tables must contain dual-potential relic and ordinary equipment fixtures");
const templet = getEquipTemplet(dualRelicId);
const user = { userUid: "988000000000034", nickname: "EquipPotentialCheck" };
const equip = grantEquipItem(user, dualRelicId, { enchantLevel: 10 });
const secondEquip = grantEquipItem(user, dualRelicId, { enchantLevel: 10 });
const ordinary = grantEquipItem(user, ordinaryId, { enchantLevel: 10 });
assert(equip && secondEquip && ordinary);
assert.strictEqual(getEquipItem(user, equip.equipUid).potentialOptions.length, 2, "dual frozen potential groups must both materialize");
openAllSockets(getEquipItem(user, equip.equipUid));
openAllSockets(getEquipItem(user, secondEquip.equipUid));

const socket = { session: { user } };
const wire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    wire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

failure(PACKETS.CHANGE_REQ, Buffer.alloc(0), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, Buffer.concat([request(equip.equipUid, 0), Buffer.from([0])]), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, Buffer.from([0x80, 0x00, 0x00]), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, request(999999999n, 0), PACKETS.CHANGE_ACK, ERROR.INVALID_EQUIP);
failure(PACKETS.CHANGE_REQ, request(ordinary.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.NOT_RELIC);
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, -1), PACKETS.CHANGE_ACK, ERROR.INVALID_SOCKET);
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 3), PACKETS.CHANGE_ACK, ERROR.INVALID_SOCKET);

getEquipItem(user, equip.equipUid).enchantLevel = 6;
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.NOT_ENOUGH_ENCHANT);
getEquipItem(user, equip.equipUid).enchantLevel = 10;
const savedSocket = getEquipItem(user, equip.equipUid).potentialOptions[0].sockets[2];
getEquipItem(user, equip.equipUid).potentialOptions[0].sockets[2] = null;
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.INVALID_SOCKET);
getEquipItem(user, equip.equipUid).potentialOptions[0].sockets[2] = savedSocket;
const savedOptionKey = getEquipItem(user, equip.equipUid).potentialOptions[0].optionKey;
getEquipItem(user, equip.equipUid).potentialOptions[0].optionKey = 999999999;
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.INVALID_OPTION_KEY);
getEquipItem(user, equip.equipUid).potentialOptions[0].optionKey = savedOptionKey;

const firstCosts = getPotentialRerollCosts(templet, getEquipItem(user, equip.equipUid));
setCostBalances(firstCosts, 0n);
setMiscItemBalance(user, 1, 0);
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.CREDIT);
setMiscItemBalance(user, 1, BigInt(costFor(firstCosts, 1)));
setMiscItemBalance(user, materialId(firstCosts), 0);
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.ITEM);

setCostBalances(firstCosts, 1000000n);
const firstBefore = balances(firstCosts);
const originalSockets = getEquipItem(user, equip.equipUid).potentialOptions.map((option) => ({ ...option.sockets[0] }));
send(PACKETS.CHANGE_REQ, request(equip.equipUid, 0));
assertSuccess(PACKETS.CHANGE_ACK);
let current = getEquipItem(user, equip.equipUid);
assert(current.potentialCandidate && current.potentialCandidate.equipUid === current.equipUid);
assert.strictEqual(current.potentialCandidate.socketIndex, 0);
assert.strictEqual(current.potentialCandidate.accumulateCount, 1);
assert.deepStrictEqual(current.potentialOptions.map((option) => option.sockets[0]), originalSockets, "reroll must remain pending");
assertSpent(firstCosts, firstBefore);
assert.strictEqual(saves, 1);
const restartedWithCandidate = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restartedWithCandidate, equip.equipUid).potentialCandidate.accumulateCount, 1);

failure(PACKETS.CHANGE_REQ, request(secondEquip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.ANOTHER_EQUIP);
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 1), PACKETS.CHANGE_ACK, ERROR.ANOTHER_EQUIP);
failure(PACKETS.CONFIRM_REQ, request(equip.equipUid, 1), PACKETS.CONFIRM_ACK, ERROR.LOGICAL);

const secondCosts = getPotentialRerollCosts(templet, current);
setCostBalances(secondCosts, 1000000n);
const secondBefore = balances(secondCosts);
send(PACKETS.CHANGE_REQ, request(equip.equipUid, 0));
assertSuccess(PACKETS.CHANGE_ACK);
current = getEquipItem(user, equip.equipUid);
assert.strictEqual(current.potentialCandidate.accumulateCount, 2, "pending rerolls must advance the durable counter");
assertSpent(secondCosts, secondBefore);
const confirmedPrecision = current.potentialCandidate.precision;

send(PACKETS.CONFIRM_REQ, request(equip.equipUid, 0));
assertSuccess(PACKETS.CONFIRM_ACK);
current = getEquipItem(user, equip.equipUid);
assert.strictEqual(current.potentialCandidate, null);
for (const option of current.potentialOptions) {
  assert.strictEqual(option.sockets[0].precision, confirmedPrecision);
  assert.strictEqual(option.precisionChangeCount, 2);
}
failure(PACKETS.CONFIRM_REQ, request(equip.equipUid, 0), PACKETS.CONFIRM_ACK, ERROR.LOGICAL);

const cancelCosts = getPotentialRerollCosts(templet, current);
setCostBalances(cancelCosts, 1000000n);
send(PACKETS.CHANGE_REQ, request(equip.equipUid, 2));
assertSuccess(PACKETS.CHANGE_ACK);
failure(PACKETS.CANCEL_REQ, Buffer.from([0]), PACKETS.CANCEL_ACK, ERROR.INVALID_REQUEST, false);
send(PACKETS.CANCEL_REQ, Buffer.alloc(0));
assertSuccess(PACKETS.CANCEL_ACK);
assert.strictEqual(getEquipItem(user, equip.equipUid).potentialCandidate, null);
failure(PACKETS.CANCEL_REQ, Buffer.alloc(0), PACKETS.CANCEL_ACK, ERROR.LOGICAL);

for (const option of getEquipItem(user, equip.equipUid).potentialOptions) option.precisionChangeCount = 100;
failure(PACKETS.CHANGE_REQ, request(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.LOGICAL);
assert.strictEqual(saves, 5, "two rolls, confirm, another roll, and cancel must each save once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, equip.equipUid).potentialOptions[0].precisionChangeCount, 100);
assert.strictEqual(getEquipItem(restarted, equip.equipUid).potentialCandidate, null);
const evidence = assertFrozenTablesAndSources();
validateManagedSchemas();
console.log(`[equip-potential-protocol-check] PASS equips=${evidence.equips} relics=${evidence.relics} dual=${evidence.dual} options=${evidence.options} weights=${evidence.weights} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(equipUid, socketIndex) {
  return Buffer.concat([writeSignedVarLong(BigInt(equipUid)), writeSignedVarInt(socketIndex)]);
}

function openAllSockets(item) {
  for (const option of item.potentialOptions) {
    option.sockets = [0, 1, 2].map((index) => ({ statValue: index + 1, precision: 50 }));
    option.precisionChangeCount = 0;
  }
}

function balance(itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
}

function balances(costs) {
  return new Map(costs.filter((cost) => cost.itemId > 0 && cost.count > 0).map((cost) => [cost.itemId, balance(cost.itemId)]));
}

function setCostBalances(costs, remainder) {
  for (const cost of costs) {
    if (cost.itemId > 0 && cost.count > 0) setMiscItemBalance(user, cost.itemId, BigInt(cost.count) + remainder);
  }
}

function costFor(costs, itemId) {
  const cost = costs.find((entry) => entry.itemId === itemId);
  return cost ? cost.count : 0;
}

function materialId(costs) {
  const cost = costs.find((entry) => entry.itemId !== 1 && entry.count > 0);
  assert(cost, "frozen relic fixture must require a non-credit reroll item");
  return cost.itemId;
}

function assertSpent(costs, before) {
  for (const cost of costs.filter((entry) => entry.itemId > 0 && entry.count > 0)) {
    assert.strictEqual(balance(cost.itemId), before.get(cost.itemId) - BigInt(cost.count));
  }
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) wire.push([packetId, payload]);
  response = null;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `potential request ${packetId} must send an ACK`);
}

function responseError() {
  return readSignedVarInt(response.payload, 0).value;
}

function assertSuccess(ackId) {
  assert.strictEqual(response.packetId, ackId);
  assert.strictEqual(responseError(), ERROR.OK);
}

function failure(packetId, payload, ackId, errorCode, validateRequest = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  send(packetId, payload, validateRequest);
  assert.strictEqual(response.packetId, ackId);
  assert.strictEqual(responseError(), errorCode);
  assert.strictEqual(JSON.stringify(user), before, `failed potential request ${packetId} must be mutation-free`);
  assert.strictEqual(saves, beforeSaves, `failed potential request ${packetId} must not save`);
}

function assertFrozenTablesAndSources() {
  const equipIds = getAllEquipIds();
  const relics = equipIds.map(getEquipTemplet).filter((record) => record && record.m_bRelic === true);
  const dual = relics.filter((record) => Number(record.m_SubPotentialOptionGroupID || 0) > 0);
  const potentialRows = readRecords("gameplay-jsons/StreamingAssets/ab_script/luac/LUA_ITEM_EQUIP_POTENTIAL_OPTION.json");
  const precisionRows = readRecords("gameplay-jsons/StreamingAssets/ab_script_item_templet/luac/LUA_ITEM_EQUIP_PRECISION_WEIGHT.json");
  assert.strictEqual(equipIds.length, 1675);
  assert.strictEqual(relics.length, 698);
  assert.strictEqual(dual.length, 3);
  assert.strictEqual(potentialRows.length, 775);
  assert.strictEqual(precisionRows.length, 707);
  for (const record of relics) {
    for (const groupId of [record.m_PotentialOptionGroupID, record.m_SubPotentialOptionGroupID].map(Number).filter((id) => id > 0)) {
      const options = getEquipPotentialOptionRecords(groupId);
      assert(options.length > 0, `relic group ${groupId} must have frozen potential rows`);
      for (const option of options) {
        const weightId = Number(option.PrecisionWeightId || option.FirstPrecisionWeightId || 0);
        assert(getEquipPrecisionWeightRecords(weightId).some((weight) => Number(weight.Weight || 0) > 0), `weight ${weightId} must be usable`);
      }
    }
  }

  const senderSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "NKCPacketSender.cs"), "utf8");
  const uiSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "UI", "NKCUIForgeHiddenOption.cs"), "utf8");
  const userSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKM", "NKMUserData.cs"), "utf8");
  const receiverSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
  assert(senderSource.includes("Send_NKMPacket_EQUIP_POTENTIAL_OPTION_CHANGE_REQ(long equipUid, int socketIndex)"));
  assert(senderSource.includes("Send_NKMPacket_EQUIP_POTENTIAL_OPTION_CHANGE_CANCLE_REQ()"));
  assert(uiSource.includes("Mathf.Max(itemEquip.potentialOptions[0].precisionChangeCount, myUserData.GetPotentialData().accumulateCount)"));
  assert(uiSource.includes("potentialData.accumulateCount >= NKMCommonConst.RelicRerollLimitCount"));
  assert(userSource.includes("return this.m_PotentialOptionCandidate != null && this.m_PotentialOptionCandidate.equipUid > 0L"));
  assert(receiverSource.includes("SetEquipPotentialData(sPacket.potentialOptionCandidate)"));
  assert(listenerSource.includes("writeNullableObject(buildPotentialOptionCandidateData(user)), // potentialOptionCandidate"));
  assert(listenerSource.includes("return buildSerializedPotentialOptionCandidateData(equip && equip.potentialCandidate);"));
  return { equips: equipIds.length, relics: relics.length, dual: dual.length, options: potentialRows.length, weights: precisionRows.length };
}

function readRecords(relativePath) {
  const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
  return Array.isArray(parsed) ? parsed : Object.values(parsed.records || parsed);
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
    for (const [packetId, payload] of wire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected potential packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
