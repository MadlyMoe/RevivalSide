"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipSetOptionIds, getEquipTemplet } = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");

const PACKETS = Object.freeze({
  CHANGE_REQ: 1028,
  CHANGE_ACK: 1029,
  CONFIRM_REQ: 1030,
  CONFIRM_ACK: 1031,
  BONUS_REQ: 1032,
  BONUS_ACK: 1033,
  FIRST_REQ: 1034,
  FIRST_ACK: 1035,
});
const ERROR = Object.freeze({
  OK: 0,
  CREDIT: 98,
  ITEM: 111,
  INVALID_EQUIP: 247,
  INVALID_REQUEST: 20191,
  INVALID_OPTION: 20218,
  CANDIDATE_EMPTY: 20240,
  INVALID_SET: 20408,
  NO_SET: 20410,
  ALREADY_SET: 20412,
  BONUS_ACTIVE: 26110,
  ANOTHER_EQUIP: 26111,
  BONUS_COUNT: 26112,
  DUPLICATE: 26113,
});
const rootDir = path.resolve(__dirname, "..");
const requestIds = [PACKETS.CHANGE_REQ, PACKETS.CONFIRM_REQ, PACKETS.BONUS_REQ, PACKETS.FIRST_REQ];
const handlers = new Map(createEquipmentPipelineHandlers().filter((handler) => requestIds.includes(handler.packetId)).map((handler) => [handler.packetId, handler]));
assert.deepStrictEqual(Array.from(handlers.keys()), requestIds);

const user = { userUid: "988000000000033", nickname: "EquipSetOptionCheck" };
const equip = grantEquipItem(user, 101188);
const secondEquip = grantEquipItem(user, 101188);
const unassignedEquip = grantEquipItem(user, 101188);
const oneChoiceEquip = grantEquipItem(user, 651141);
assert(equip && secondEquip && unassignedEquip && oneChoiceEquip);
getEquipItem(user, unassignedEquip.equipUid).setOptionId = 0;
const templet = getEquipTemplet(equip.itemEquipId);
const allowedSetIds = getEquipSetOptionIds(templet);
const creditCost = Number(templet.m_RandomSetReqResource);
const materialId = Number(templet.m_RandomSetReqItemID);
const materialCost = Number(templet.m_RandomSetReqItemValue);
setMiscItemBalance(user, 1, 2000000);
setMiscItemBalance(user, materialId, 100);

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
failure(PACKETS.CHANGE_REQ, Buffer.concat([uidRequest(equip.equipUid), Buffer.from([0])]), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, Buffer.from([0x80, 0x00]), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, uidRequest(999999), PACKETS.CHANGE_ACK, ERROR.INVALID_EQUIP);
failure(PACKETS.CHANGE_REQ, uidRequest(unassignedEquip.equipUid), PACKETS.CHANGE_ACK, ERROR.NO_SET);
failure(PACKETS.CHANGE_REQ, uidRequest(oneChoiceEquip.equipUid), PACKETS.CHANGE_ACK, ERROR.INVALID_OPTION);
setMiscItemBalance(user, 1, 0);
failure(PACKETS.CHANGE_REQ, uidRequest(equip.equipUid), PACKETS.CHANGE_ACK, ERROR.CREDIT);
setMiscItemBalance(user, 1, 2000000);
setMiscItemBalance(user, materialId, 0);
failure(PACKETS.CHANGE_REQ, uidRequest(equip.equipUid), PACKETS.CHANGE_ACK, ERROR.ITEM);
setMiscItemBalance(user, materialId, 100);

const originalSetId = getEquipItem(user, equip.equipUid).setOptionId;
const creditBefore = balance(1);
const materialBefore = balance(materialId);
send(PACKETS.CHANGE_REQ, uidRequest(equip.equipUid));
assertSuccess(PACKETS.CHANGE_ACK);
let current = getEquipItem(user, equip.equipUid);
assert(current.tuningCandidate && current.tuningCandidate.setOptionId > 0);
assert.notStrictEqual(current.tuningCandidate.setOptionId, originalSetId);
assert.strictEqual(current.setOptionId, originalSetId, "set reroll must remain pending until confirmation");
assert.strictEqual(balance(1), creditBefore - BigInt(creditCost));
assert.strictEqual(balance(materialId), materialBefore - BigInt(materialCost));
assert.strictEqual(user.equipResetCounts["1035"], 1);
const restartedWithCandidate = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restartedWithCandidate, equip.equipUid).tuningCandidate.setOptionId, current.tuningCandidate.setOptionId);

failure(PACKETS.CHANGE_REQ, uidRequest(secondEquip.equipUid), PACKETS.CHANGE_ACK, ERROR.ANOTHER_EQUIP);
failure(PACKETS.FIRST_REQ, uidRequest(unassignedEquip.equipUid), PACKETS.FIRST_ACK, ERROR.ANOTHER_EQUIP);
failure(PACKETS.CONFIRM_REQ, uidRequest(secondEquip.equipUid), PACKETS.CONFIRM_ACK, ERROR.CANDIDATE_EMPTY);
const pendingSetId = current.tuningCandidate.setOptionId;
send(PACKETS.CONFIRM_REQ, uidRequest(equip.equipUid));
assertSuccess(PACKETS.CONFIRM_ACK);
current = getEquipItem(user, equip.equipUid);
assert.strictEqual(current.setOptionId, pendingSetId);
assert.strictEqual(current.tuningCandidate, null);

user.equipResetCounts["1035"] = 99;
const bonusSetId = allowedSetIds.find((setId) => setId !== current.setOptionId);
failure(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, bonusSetId), PACKETS.BONUS_ACK, ERROR.BONUS_COUNT);
user.equipResetCounts["1035"] = 100;
failure(PACKETS.CHANGE_REQ, uidRequest(equip.equipUid), PACKETS.CHANGE_ACK, ERROR.BONUS_ACTIVE);
failure(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, 999999), PACKETS.BONUS_ACK, ERROR.INVALID_SET);
failure(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, current.setOptionId), PACKETS.BONUS_ACK, ERROR.DUPLICATE);
send(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, bonusSetId));
assertSuccess(PACKETS.BONUS_ACK);
assert.strictEqual(getEquipItem(user, equip.equipUid).setOptionId, bonusSetId);
assert.strictEqual(user.equipResetCounts["1035"], 0);

failure(PACKETS.FIRST_REQ, Buffer.alloc(0), PACKETS.FIRST_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.FIRST_REQ, Buffer.concat([uidRequest(unassignedEquip.equipUid), Buffer.from([0])]), PACKETS.FIRST_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.FIRST_REQ, uidRequest(equip.equipUid), PACKETS.FIRST_ACK, ERROR.ALREADY_SET);
const creditBeforeFirst = balance(1);
const materialBeforeFirst = balance(materialId);
send(PACKETS.FIRST_REQ, uidRequest(unassignedEquip.equipUid));
assertSuccess(PACKETS.FIRST_ACK);
assert(allowedSetIds.includes(getEquipItem(user, unassignedEquip.equipUid).setOptionId));
assert.strictEqual(balance(1), creditBeforeFirst, "first set assignment must be free");
assert.strictEqual(balance(materialId), materialBeforeFirst, "first set assignment must not spend tuning material");
assert.strictEqual(saves, 4, "roll, confirm, bonus selection, and first assignment must each save once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, equip.equipUid).setOptionId, bonusSetId);
assert(allowedSetIds.includes(getEquipItem(restarted, unassignedEquip.equipUid).setOptionId));
assert.strictEqual(restarted.equipResetCounts["1035"], 0);

const evidence = assertFrozenTablesAndSources();
validateManagedSchemas();
console.log(`[equip-set-option-protocol-check] PASS equips=${evidence.equips} single=${evidence.single} multi=${evidence.multi} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function uidRequest(equipUid) {
  return writeSignedVarLong(BigInt(equipUid));
}

function bonusRequest(equipUid, setOptionId) {
  return Buffer.concat([uidRequest(equipUid), writeSignedVarInt(setOptionId)]);
}

function balance(itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item.countFree) + BigInt(item.countPaid);
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) wire.push([packetId, payload]);
  response = null;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `set-option request ${packetId} must send an ACK`);
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
  assert.strictEqual(JSON.stringify(user), before, `failed set-option request ${packetId} must be mutation-free`);
  assert.strictEqual(saves, beforeSaves, `failed set-option request ${packetId} must not save`);
}

function assertFrozenTablesAndSources() {
  const equipIds = getAllEquipIds();
  const counts = equipIds.map((id) => getEquipSetOptionIds(getEquipTemplet(id)).length);
  const single = counts.filter((count) => count === 1).length;
  const multi = counts.filter((count) => count > 1).length;
  assert.strictEqual(equipIds.length, 1675);
  assert.strictEqual(single, 166);
  assert.strictEqual(multi, 1509);
  assert(equipIds.every((id) => {
    const record = getEquipTemplet(id);
    return Number(record.m_RandomSetReqResource) > 0
      && Number(record.m_RandomSetReqItemID) > 0
      && Number(record.m_RandomSetReqItemValue) > 0;
  }));

  const senderSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "NKCPacketSender.cs"), "utf8");
  const uiSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "UI", "NKCUIForgeTuning.cs"), "utf8");
  const receiverSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  assert(senderSource.includes("Send_NKMPacket_EQUIP_ITEM_CHANGE_SET_OPTION_REQ(long equipUID)"));
  assert(senderSource.includes("if (itemEquip.m_SetOptionId > 0)"));
  assert(uiSource.includes("Send_NKMPacket_EQUIP_ITEM_FIRST_SET_OPTION_REQ(this.m_LeftEquipUID)"));
  assert(receiverSource.includes("OnRecv(NKMPacket_EQUIP_ITEM_CONFIRM_SET_OPTION_ACK"));
  return { equips: equipIds.length, single, multi };
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
      assert(result.ok, `managed schema rejected set-option packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
