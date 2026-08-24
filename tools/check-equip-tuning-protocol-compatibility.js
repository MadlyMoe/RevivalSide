"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, getEquipItems, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipRandomStatRecords, getEquipTemplet } = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  buildEquipTuningCandidateData,
  readSignedVarInt,
  statTypeValue,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");

const PACKETS = Object.freeze({
  REFINE_REQ: 1018,
  REFINE_ACK: 1019,
  CHANGE_REQ: 1020,
  CHANGE_ACK: 1021,
  CONFIRM_REQ: 1022,
  CONFIRM_ACK: 1023,
  BONUS_REQ: 1024,
  BONUS_ACK: 1025,
  CANCEL_REQ: 1052,
  CANCEL_ACK: 1053,
  TUNING_NOT: 1054,
});
const ERROR = Object.freeze({
  OK: 0,
  CREDIT: 98,
  ITEM: 111,
  INVALID_EQUIP: 247,
  MAX_PRECISION: 305,
  GROUP_EMPTY: 307,
  CANDIDATE_EMPTY: 308,
  INVALID_REQUEST: 20191,
  REFINE_OPTION: 20205,
  INVALID_OPTION: 20218,
  BONUS_ACTIVE: 26109,
  ANOTHER_EQUIP: 26111,
  BONUS_COUNT: 26112,
  DUPLICATE: 26113,
});
const rootDir = path.resolve(__dirname, "..");
const requestIds = [PACKETS.REFINE_REQ, PACKETS.CHANGE_REQ, PACKETS.CONFIRM_REQ, PACKETS.BONUS_REQ, PACKETS.CANCEL_REQ];
const handlers = new Map(createEquipmentPipelineHandlers().filter((handler) => requestIds.includes(handler.packetId)).map((handler) => [handler.packetId, handler]));
assert.deepStrictEqual(Array.from(handlers.keys()), requestIds);

const user = { userUid: "988000000000032", nickname: "EquipTuningCheck" };
const equip = grantEquipItem(user, 101188, { precision: 50, precision2: 60 });
const secondEquip = grantEquipItem(user, 101188, { precision: 40, precision2: 40 });
const oneSlotEquip = grantEquipItem(user, 211111, { precision: 50 });
const duplicateEquip = grantEquipItem(user, 101002, { precision: 50, precision2: 50 });
assert(equip && secondEquip && oneSlotEquip && duplicateEquip);
const templet = getEquipTemplet(equip.itemEquipId);
const precisionCredit = Number(templet.m_PrecisionReqResource);
const precisionMaterial = Number(templet.m_PrecisionReqItem);
const statCredit = Number(templet.m_RandomStatReqResource);
const statMaterial = Number(templet.m_RandomStatReqItem);
setMiscItemBalance(user, 1, 1000000);
setMiscItemBalance(user, 1013, 1000);

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

failure(PACKETS.REFINE_REQ, Buffer.alloc(0), PACKETS.REFINE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.REFINE_REQ, Buffer.concat([tuningRequest(equip.equipUid, 1), Buffer.from([0])]), PACKETS.REFINE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.REFINE_REQ, Buffer.from([0x80, 0x00, 0x02]), PACKETS.REFINE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.REFINE_REQ, tuningRequest(999999, 1), PACKETS.REFINE_ACK, ERROR.INVALID_EQUIP);
failure(PACKETS.REFINE_REQ, tuningRequest(equip.equipUid, 0), PACKETS.REFINE_ACK, ERROR.REFINE_OPTION);
getEquipItem(user, equip.equipUid).precision = 100;
failure(PACKETS.REFINE_REQ, tuningRequest(equip.equipUid, 1), PACKETS.REFINE_ACK, ERROR.MAX_PRECISION);
getEquipItem(user, equip.equipUid).precision = 50;
setMiscItemBalance(user, 1, 0);
failure(PACKETS.REFINE_REQ, tuningRequest(equip.equipUid, 1), PACKETS.REFINE_ACK, ERROR.CREDIT);
setMiscItemBalance(user, 1, 1000000);
setMiscItemBalance(user, 1013, 0);
failure(PACKETS.REFINE_REQ, tuningRequest(equip.equipUid, 1), PACKETS.REFINE_ACK, ERROR.ITEM);
setMiscItemBalance(user, 1013, 1000);

const creditBeforeRefine = balance(1);
const materialBeforeRefine = balance(1013);
send(PACKETS.REFINE_REQ, tuningRequest(equip.equipUid, 1));
assertSuccess(PACKETS.REFINE_ACK);
assert(Number(getEquipItem(user, equip.equipUid).precision) > 50, "refinement must use the frozen increasing-precision table");
assert.strictEqual(balance(1), creditBeforeRefine - BigInt(precisionCredit));
assert.strictEqual(balance(1013), materialBeforeRefine - BigInt(precisionMaterial));

failure(PACKETS.CHANGE_REQ, Buffer.alloc(0), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, Buffer.concat([tuningRequest(equip.equipUid, 1), Buffer.from([0])]), PACKETS.CHANGE_ACK, ERROR.INVALID_REQUEST, false);
failure(PACKETS.CHANGE_REQ, tuningRequest(equip.equipUid, 0), PACKETS.CHANGE_ACK, ERROR.INVALID_OPTION);
failure(PACKETS.CHANGE_REQ, tuningRequest(oneSlotEquip.equipUid, 2), PACKETS.CHANGE_ACK, ERROR.GROUP_EMPTY);
setMiscItemBalance(user, 1, 0);
failure(PACKETS.CHANGE_REQ, tuningRequest(equip.equipUid, 1), PACKETS.CHANGE_ACK, ERROR.CREDIT);
setMiscItemBalance(user, 1, 1000000);
setMiscItemBalance(user, 1013, 0);
failure(PACKETS.CHANGE_REQ, tuningRequest(equip.equipUid, 1), PACKETS.CHANGE_ACK, ERROR.ITEM);
setMiscItemBalance(user, 1013, 1000);

const originalType = getEquipItem(user, equip.equipUid).stats[1].type;
const creditBeforeRoll = balance(1);
const materialBeforeRoll = balance(1013);
send(PACKETS.CHANGE_REQ, tuningRequest(equip.equipUid, 1));
assertSuccess(PACKETS.CHANGE_ACK);
let current = getEquipItem(user, equip.equipUid);
assert(current.tuningCandidate && current.tuningCandidate.option1 !== "NST_RANDOM");
assert.strictEqual(current.stats[1].type, originalType, "reroll must remain pending until confirmation");
assert.strictEqual(balance(1), creditBeforeRoll - BigInt(statCredit));
assert.strictEqual(balance(1013), materialBeforeRoll - BigInt(statMaterial));
assert.strictEqual(user.equipResetCounts["1013"], 1);
const restartedWithCandidate = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restartedWithCandidate, equip.equipUid).tuningCandidate.option1, current.tuningCandidate.option1);

failure(PACKETS.CHANGE_REQ, tuningRequest(secondEquip.equipUid, 1), PACKETS.CHANGE_ACK, ERROR.ANOTHER_EQUIP);
failure(PACKETS.REFINE_REQ, tuningRequest(secondEquip.equipUid, 1), PACKETS.REFINE_ACK, ERROR.ANOTHER_EQUIP);
failure(PACKETS.CONFIRM_REQ, tuningRequest(equip.equipUid, 2), PACKETS.CONFIRM_ACK, ERROR.CANDIDATE_EMPTY);
send(PACKETS.CONFIRM_REQ, tuningRequest(equip.equipUid, 1));
assertSuccess(PACKETS.CONFIRM_ACK);
current = getEquipItem(user, equip.equipUid);
assert.notStrictEqual(current.stats[1].type, originalType);
assert.strictEqual(current.tuningCandidate, null);

send(PACKETS.CANCEL_REQ, Buffer.alloc(0));
assertSuccess(PACKETS.CANCEL_ACK);
assert.strictEqual(saves, 3, "empty cancel must ACK without a write");

send(PACKETS.CHANGE_REQ, tuningRequest(equip.equipUid, 2));
assertSuccess(PACKETS.CHANGE_ACK);
failure(PACKETS.CANCEL_REQ, Buffer.from([0]), PACKETS.CANCEL_ACK, ERROR.INVALID_REQUEST);
send(PACKETS.CANCEL_REQ, Buffer.alloc(0));
assertSuccess(PACKETS.CANCEL_ACK);
assert.strictEqual(getEquipItem(user, equip.equipUid).tuningCandidate, null);

user.equipResetCounts["1013"] = 99;
const validBonusType = getEquipRandomStatRecords(templet.m_StatGroupID)[0].m_StatType;
failure(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, 1, validBonusType), PACKETS.BONUS_ACK, ERROR.BONUS_COUNT);
user.equipResetCounts["1013"] = 100;
failure(PACKETS.CHANGE_REQ, tuningRequest(equip.equipUid, 1), PACKETS.CHANGE_ACK, ERROR.BONUS_ACTIVE);
failure(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, 1, "NST_RANDOM"), PACKETS.BONUS_ACK, ERROR.INVALID_OPTION);

const duplicateType = "NST_CC_RESIST_RATE";
assert.strictEqual(getEquipItem(user, duplicateEquip.equipUid).stats[1].type, duplicateType);
failure(PACKETS.BONUS_REQ, bonusRequest(duplicateEquip.equipUid, 2, duplicateType), PACKETS.BONUS_ACK, ERROR.DUPLICATE);

const replacementType = getEquipRandomStatRecords(templet.m_StatGroupID).find((record) => record.m_StatType !== current.stats[2].type).m_StatType;
send(PACKETS.BONUS_REQ, bonusRequest(equip.equipUid, 1, replacementType));
assertSuccess(PACKETS.BONUS_ACK);
assert.strictEqual(getEquipItem(user, equip.equipUid).stats[1].type, replacementType);
assert.strictEqual(user.equipResetCounts["1013"], 0);
assert.strictEqual(saves, 6, "refine, roll, confirm, roll, cancel, and bonus confirmation must each save once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, equip.equipUid).stats[1].type, replacementType);
assert.strictEqual(restarted.equipResetCounts["1013"], 0);
assert(getEquipItems(restarted).every((item) => !item.tuningCandidate));

wire.push([
  PACKETS.TUNING_NOT,
  Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipTuningCandidateData({ equipUid: equip.equipUid, option1: replacementType }))]),
]);
const evidence = assertFrozenTablesAndSources();
validateManagedSchemas();
console.log(`[equip-tuning-protocol-check] PASS equips=${evidence.equips} tunable=${evidence.tunable} dual=${evidence.dual} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function tuningRequest(equipUid, optionId) {
  return Buffer.concat([writeSignedVarLong(BigInt(equipUid)), writeSignedVarInt(optionId)]);
}

function bonusRequest(equipUid, optionId, statType) {
  return Buffer.concat([tuningRequest(equipUid, optionId), writeSignedVarInt(statTypeValue(statType))]);
}

function balance(itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item.countFree) + BigInt(item.countPaid);
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) wire.push([packetId, payload]);
  response = null;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `tuning request ${packetId} must send an ACK`);
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
  assert.strictEqual(JSON.stringify(user), before, `failed tuning request ${packetId} must be mutation-free`);
  assert.strictEqual(saves, beforeSaves, `failed tuning request ${packetId} must not save`);
}

function assertFrozenTablesAndSources() {
  const equipIds = getAllEquipIds();
  const tunable = equipIds.filter((id) => {
    const record = getEquipTemplet(id);
    return getEquipRandomStatRecords(record.m_StatGroupID).length > 0;
  });
  const dual = tunable.filter((id) => {
    const record = getEquipTemplet(id);
    return getEquipRandomStatRecords(record.m_StatGroupID_2).length > 0;
  });
  assert.strictEqual(equipIds.length, 1675);
  assert.strictEqual(tunable.length, 1675);
  assert.strictEqual(dual.length, 1519);
  assert(tunable.every((id) => {
    const record = getEquipTemplet(id);
    return Number(record.m_PrecisionReqResource) > 0
      && Number(record.m_PrecisionReqItem) > 0
      && Number(record.m_RandomStatReqResource) > 0
      && Number(record.m_RandomStatReqItem) > 0;
  }));

  const requestSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_EQUIP_TUNING_STAT_CHANGE_REQ.cs"), "utf8");
  const bonusSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_EQUIP_TUNING_STAT_CHANGE_BONUS_CONFIRM_REQ.cs"), "utf8");
  const uiSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "UI", "NKCUIForgeTuning.cs"), "utf8");
  const receiverSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
  assert(/equipUID[\s\S]*equipOptionID/.test(requestSource));
  assert(/equipUid[\s\S]*equipOptionId[\s\S]*statType/.test(bonusSource));
  assert(uiSource.includes("private int m_iSelectOptionIdx = 1"));
  assert(uiSource.includes("Send_NKMPacket_EQUIP_TUNING_STAT_CHANGE_BONUS_CONFIRM_REQ"));
  assert(receiverSource.includes("OnRecv(NKMPacket_EQUIP_TUNING_NOT"));
  assert(listenerSource.includes("writeNullableObject(buildEquipTuningCandidateData(user)), // equipTuningCandidate"));
  assert(/function buildEquipTuningCandidateData\(user\)[\s\S]*?getEquipItems\(user\)\.find\(\(item\) => item && item\.tuningCandidate\)[\s\S]*?buildSerializedEquipTuningCandidateData/.test(listenerSource));
  return { equips: equipIds.length, tunable: tunable.length, dual: dual.length };
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
      assert(result.ok, `managed schema rejected tuning packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
