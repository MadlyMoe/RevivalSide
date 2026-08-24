"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItems } = require("../modules/equipment");
const {
  getCustomBoxTemplet,
  getEquipPotentialOptionRecords,
  getEquipRandomStatRecords,
  getEquipSetOptionIds,
  getEquipTemplet,
  getMiscItemTemplet,
  getRandomBoxRewards,
} = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  statTypeValue,
  writeIntList,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { getChoiceRewardRecords } = require("../modules/reward");

const RANDOM_REQ = 1008;
const RANDOM_ACK = 1009;
const CHOICE_REQ = 1026;
const CHOICE_ACK = 1027;
const ERROR = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  INVALID_ITEM_ID: 244,
  INVALID_REWARD_GROUP: 246,
  RANDOM_COUNT: 453,
  INVALID_REQUEST: 20191,
});
const rootDir = path.resolve(__dirname, "..");
const handlers = new Map(createEquipmentPipelineHandlers().filter((handler) => [RANDOM_REQ, CHOICE_REQ].includes(handler.packetId)).map((handler) => [handler.packetId, handler]));
assert.deepStrictEqual(Array.from(handlers.keys()), [RANDOM_REQ, CHOICE_REQ], "the real frozen item request IDs must use the equipment pipeline");

const randomItemId = 621;
const miscChoiceItemId = 1060;
const operatorChoiceItemId = 40192;
const customStatItemId = 40170;
const customPotentialItemId = 49163;
const user = { userUid: "988000000000031", nickname: "ItemConsumptionCheck" };
for (const itemId of [randomItemId, miscChoiceItemId, operatorChoiceItemId, customStatItemId, customPotentialItemId]) {
  setMiscItemBalance(user, itemId, 5);
}
const socket = { session: { user } };
const wire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 525085452000000000n,
  randomInt: () => 0,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    wire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

failure(RANDOM_REQ, Buffer.alloc(0), RANDOM_ACK, ERROR.INVALID_REQUEST, false);
failure(RANDOM_REQ, Buffer.concat([randomRequest(randomItemId, 1), Buffer.from([0])]), RANDOM_ACK, ERROR.INVALID_REQUEST, false);
failure(RANDOM_REQ, Buffer.from([0x80, 0x00, 0x02]), RANDOM_ACK, ERROR.INVALID_REQUEST, false);
failure(RANDOM_REQ, randomRequest(1, 1), RANDOM_ACK, ERROR.INVALID_ITEM_ID);
failure(RANDOM_REQ, randomRequest(randomItemId, 0), RANDOM_ACK, ERROR.RANDOM_COUNT);
failure(RANDOM_REQ, randomRequest(randomItemId, 10001), RANDOM_ACK, ERROR.RANDOM_COUNT);
setMiscItemBalance(user, randomItemId, 0);
failure(RANDOM_REQ, randomRequest(randomItemId, 1), RANDOM_ACK, ERROR.INSUFFICIENT_ITEM);
setMiscItemBalance(user, randomItemId, 5);

failure(CHOICE_REQ, Buffer.alloc(0), CHOICE_ACK, ERROR.INVALID_REQUEST, false);
failure(CHOICE_REQ, Buffer.concat([choiceRequest(miscChoiceItemId, 15, 1), Buffer.from([0])]), CHOICE_ACK, ERROR.INVALID_REQUEST, false);
failure(CHOICE_REQ, choiceRequest(miscChoiceItemId, 999999, 1), CHOICE_ACK, ERROR.INVALID_REWARD_GROUP);
failure(CHOICE_REQ, choiceRequest(miscChoiceItemId, 15, 1, { subSkillId: 1001 }), CHOICE_ACK, ERROR.INVALID_REQUEST);
failure(CHOICE_REQ, choiceRequest(operatorChoiceItemId, choiceRewardId(operatorChoiceItemId), 1, { subSkillId: 1006 }), CHOICE_ACK, ERROR.INVALID_REQUEST);
failure(CHOICE_REQ, choiceRequest(customStatItemId, choiceRewardId(customStatItemId), 1), CHOICE_ACK, ERROR.INVALID_REQUEST);

const statRecord = choiceEquipRecord(customStatItemId);
const statEquip = getEquipTemplet(statRecord.m_RewardID);
const statTypes = [
  getEquipRandomStatRecords(statEquip.m_StatGroupID)[0].m_StatType,
  getEquipRandomStatRecords(statEquip.m_StatGroupID_2)[0].m_StatType,
];
const setOptionId = getEquipSetOptionIds(statEquip)[0];
failure(
  CHOICE_REQ,
  choiceRequest(customStatItemId, statRecord.m_RewardID, 1, { setOptionId: 999999, statTypes: statTypes.map(statTypeValue) }),
  CHOICE_ACK,
  ERROR.INVALID_REQUEST
);
failure(
  CHOICE_REQ,
  choiceRequest(customStatItemId, statRecord.m_RewardID, 1, { setOptionId, statTypes: [999999, statTypeValue(statTypes[1])] }),
  CHOICE_ACK,
  ERROR.INVALID_REQUEST
);

const potentialRecord = choiceEquipRecord(customPotentialItemId);
const potentialEquip = getEquipTemplet(potentialRecord.m_RewardID);
const potentialSetId = getEquipSetOptionIds(potentialEquip)[0];
const potential = getEquipPotentialOptionRecords(potentialEquip.m_PotentialOptionGroupID)[0];
failure(
  CHOICE_REQ,
  choiceRequest(customPotentialItemId, potentialRecord.m_RewardID, 1, { setOptionId: potentialSetId, potentialOptionId: 999999 }),
  CHOICE_ACK,
  ERROR.INVALID_REQUEST
);
assert.strictEqual(saves, 0, "all malformed and rejected item requests must be save-free");

send(RANDOM_REQ, randomRequest(randomItemId, 2));
assertSuccess(RANDOM_ACK);
assert.strictEqual(getMiscItem(user, randomItemId).countFree, "3");
assert.strictEqual(getMiscItem(user, 622).countFree, "4", "two deterministic frozen boxes must grant two copies of the first 2-count row");

send(CHOICE_REQ, choiceRequest(miscChoiceItemId, 15, 2));
assertSuccess(CHOICE_ACK);
assert.strictEqual(getMiscItem(user, miscChoiceItemId).countFree, "3");
assert.strictEqual(getMiscItem(user, 15).countFree, "2");

send(CHOICE_REQ, choiceRequest(operatorChoiceItemId, choiceRewardId(operatorChoiceItemId), 1, { subSkillId: 1015 }));
assertSuccess(CHOICE_ACK);
const operator = Object.values(user.army.operators)[0];
assert.deepStrictEqual(
  [operator.id, operator.level, operator.mainSkill.level, operator.subSkill.id, operator.subSkill.level],
  [choiceRewardId(operatorChoiceItemId), 100, 1, 1015, 11],
  "custom operator boxes must preserve their frozen level and selected passive skill contract"
);

send(
  CHOICE_REQ,
  choiceRequest(customStatItemId, statRecord.m_RewardID, 1, { setOptionId, statTypes: statTypes.map(statTypeValue) })
);
assertSuccess(CHOICE_ACK);
const customStatEquip = getEquipItems(user).find((equip) => equip.itemEquipId === statRecord.m_RewardID);
assert(customStatEquip, "custom-stat selector must grant the chosen equipment");
assert.deepStrictEqual(customStatEquip.stats.slice(1, 3).map((stat) => stat.type), statTypes);
assert(customStatEquip.stats.slice(1, 3).every((stat) => Number(stat.value) > 0), "chosen substats must use rolled precision values, not zero placeholders");
assert.strictEqual(customStatEquip.setOptionId, setOptionId);

send(
  CHOICE_REQ,
  choiceRequest(customPotentialItemId, potentialRecord.m_RewardID, 1, { setOptionId: potentialSetId, potentialOptionId: potential.OptionKey })
);
assertSuccess(CHOICE_ACK);
const customPotentialEquip = getEquipItems(user).find((equip) => equip.itemEquipId === potentialRecord.m_RewardID);
assert(customPotentialEquip, "custom-potential selector must grant the chosen equipment");
assert.strictEqual(customPotentialEquip.setOptionId, potentialSetId);
assert.strictEqual(customPotentialEquip.potentialOptions[0].optionKey, potential.OptionKey);
assert.deepStrictEqual(
  customPotentialEquip.potentialOptions[0].sockets[0],
  { statValue: Number(potential.Socket1_MaxStat || potential.Socket1_MaxStatRate), precision: 100 },
  "PotenOptionMax must grant the selected first socket at its frozen maximum"
);
assert.strictEqual(saves, 5, "each successful item request must save exactly once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getMiscItem(restarted, randomItemId).countFree, "3");
assert.strictEqual(getMiscItem(restarted, 15).countFree, "2");
assert.strictEqual(getEquipItems(restarted).filter((equip) => [statRecord.m_RewardID, potentialRecord.m_RewardID].includes(equip.itemEquipId)).length, 2);
assert.strictEqual(Object.values(restarted.army.operators)[0].subSkill.id, 1015);

const tableEvidence = assertFrozenTablesAndSources();
validateManagedSchemas();
console.log(`[item-consumption-protocol-check] PASS randomItems=${tableEvidence.randomItems} choiceItems=${tableEvidence.choiceItems} customBoxes=${tableEvidence.customBoxes} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function randomRequest(itemId, count) {
  return Buffer.concat([writeSignedVarInt(itemId), writeSignedVarInt(count)]);
}

function choiceRequest(itemId, rewardId, count, options = {}) {
  return Buffer.concat([
    writeSignedVarInt(itemId),
    writeSignedVarInt(rewardId),
    writeSignedVarInt(count),
    writeSignedVarInt(options.setOptionId || 0),
    writeSignedVarInt(options.subSkillId || 0),
    writeIntList(options.statTypes || []),
    writeSignedVarInt(options.potentialOptionId || 0),
    writeSignedVarInt(options.potentialOption2Id || 0),
  ]);
}

function choiceRewardId(itemId) {
  const record = getChoiceRewardRecords(itemId)[0];
  assert(record, `choice item ${itemId} must have a frozen reward row`);
  return Number(record.m_RewardID);
}

function choiceEquipRecord(itemId) {
  const record = getChoiceRewardRecords(itemId)[0];
  assert(record && record.m_RewardType === "RT_EQUIP", `choice item ${itemId} must grant equipment`);
  return record;
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) wire.push([packetId, payload]);
  response = null;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `item request ${packetId} must send an ACK`);
}

function failure(packetId, payload, ackId, errorCode, validateRequest = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  send(packetId, payload, validateRequest);
  assert.strictEqual(response.packetId, ackId);
  assert.deepStrictEqual(response.payload, Buffer.concat([writeSignedVarInt(errorCode), Buffer.from([0, 0])]));
  assert.strictEqual(JSON.stringify(user), before, `failed item request ${packetId} must be mutation-free`);
  assert.strictEqual(saves, beforeSaves, `failed item request ${packetId} must not save`);
}

function assertSuccess(packetId) {
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, ERROR.OK);
  const firstObject = readBool(response.payload, error.offset);
  assert.strictEqual(firstObject.value, true, "successful item ACK must contain its authoritative first object");
}

function assertFrozenTablesAndSources() {
  const itemTable = JSON.parse(fs.readFileSync(path.join(rootDir, "gameplay-jsons", "Assetbundles", "ab_script_item_templet", "luac", "LUA_ITEM_MISC_TEMPLET.json"), "utf8")).records;
  const unique = new Map();
  for (const record of itemTable) if (!unique.has(Number(record.m_ItemMiscID))) unique.set(Number(record.m_ItemMiscID), record);
  const randomItems = Array.from(unique.values()).filter((item) => item.m_ItemMiscType === "IMT_RANDOMBOX");
  const choiceItems = Array.from(unique.values()).filter((item) => String(item.m_ItemMiscType || "").startsWith("IMT_CHOICE_"));
  assert.strictEqual(randomItems.length, 217);
  assert(randomItems.every((item) => getRandomBoxRewards(item.m_RewardGroupID).length > 0));
  assert.strictEqual(choiceItems.length, 394);
  assert(choiceItems.every((item) => getChoiceRewardRecords(item.m_ItemMiscID).length > 0));
  const customBoxTable = JSON.parse(fs.readFileSync(path.join(rootDir, "gameplay-jsons", "Assetbundles", "ab_script_item_templet", "luac", "LUA_CUSTOM_BOX_TEMPLET.json"), "utf8")).records;
  assert.strictEqual(customBoxTable.length, 31);
  assert(customBoxTable.every((record) => getCustomBoxTemplet(record.CustomBoxID)));

  const requestSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_RANDOM_ITEM_BOX_OPEN_REQ.cs"), "utf8");
  const choiceSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_CHOICE_ITEM_USE_REQ.cs"), "utf8");
  const senderSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "NKCPacketSender.cs"), "utf8");
  const itemBoxSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "UI", "NKCPopupItemBox.cs"), "utf8");
  const receiverSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  assert(/itemID[\s\S]*count/.test(requestSource));
  for (const field of ["itemId", "rewardId", "count", "setOptionId", "subSkillId", "statTypes", "potentialOptionId", "potentialOption2Id"]) {
    assert(choiceSource.includes(`this.${field}`), `frozen choice request must serialize ${field}`);
  }
  assert(senderSource.includes("Send_NKMPacket_RANDOM_ITEM_BOX_OPEN_REQ(int id, int count)"));
  assert(itemBoxSource.includes("Math.Min(this.currentItemData.Count, 10000L)"));
  assert(receiverSource.includes("OnRecv(NKMPacket_RANDOM_ITEM_BOX_OPEN_ACK"));
  assert(receiverSource.includes("OnRecv(NKMPacket_CHOICE_ITEM_USE_ACK"));
  return { randomItems: randomItems.length, choiceItems: choiceItems.length, customBoxes: customBoxTable.length };
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
      assert(result.ok, `managed schema rejected item packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
