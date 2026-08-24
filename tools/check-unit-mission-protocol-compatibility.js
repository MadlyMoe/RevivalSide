"use strict";

const assert = require("assert");
const path = require("path");
const {
  COLLECTION_ERRORS,
  PACKETS,
  buildCompletedUnitMissionPayloads,
  buildRewardEnableUnitMissionPayloads,
  createCollectionHandlers,
  sendUnitMissionUpdatedNot,
} = require("../modules/collection");
const { getMiscItem } = require("../modules/inventory");
const { ensureArmy } = require("../modules/unit");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const missionRows = readGameplayTableRecords("ab_script", "LUA_UNIT_MISSION_TEMPLET.json", {
  rootDir,
  logLabel: "unit-mission-check",
}).map((row) => ({
  grade: String(row.Unit_Grade || ""),
  missionId: Number(row.MissionID || 0),
  stepId: Number(row.StepID || 0),
  condition: String(row.Mission_Condition || ""),
  value: Number(row.Mission_Value || 0),
  rewardType: String(row.m_RewardType || ""),
  rewardId: Number(row.m_RewardID || 0),
  rewardValue: Number(row.m_RewardValue || 0),
}));
assert.strictEqual(missionRows.length, 20, "all frozen unit-mission rows must load");
assert(missionRows.every((row) => row.condition === "UNIT_GROWTH_LEVEL"), "frozen missions must use level growth");
assert(missionRows.every((row) => row.rewardType === "RT_MISC" && row.rewardId === 101), "frozen rewards must be item 101");
assert.deepStrictEqual(
  [...new Set(missionRows.map((row) => row.grade))].sort(),
  ["NUG_N", "NUG_R", "NUG_SR", "NUG_SSR"]
);
assert.strictEqual(COLLECTION_ERRORS.UNIT_MISSION_INVALID_MISSION_ID, 20958);
assert.strictEqual(COLLECTION_ERRORS.UNIT_MISSION_NOT_FOUND_UNIT_HISTORY, 20960);
assert.strictEqual(COLLECTION_ERRORS.UNIT_MISSION_NOT_ENOUGH_VALUE, 20961);
assert.strictEqual(COLLECTION_ERRORS.UNIT_MISSION_INVALID_STEP_ID, 20963);
assert.strictEqual(COLLECTION_ERRORS.UNIT_MISSION_UNSUPPORTED_CONDITION, 20966);

const unitRows = ["LUA_UNIT_TEMPLET_BASE.json", "LUA_UNIT_TEMPLET_BASE2.json"]
  .flatMap((fileName) => readGameplayTableRecords("ab_script_unit_data", fileName, { rootDir, logLabel: "unit-mission-check" }))
  .filter((row) => row.m_NKM_UNIT_TYPE === "NUT_NORMAL" && row.m_bMonster !== true && Number(row.m_UnitID) > 0);
const unitByGrade = new Map();
for (const row of unitRows) {
  const grade = String(row.m_NKM_UNIT_GRADE || "");
  if (!unitByGrade.has(grade)) unitByGrade.set(grade, Number(row.m_UnitID));
}
for (const grade of ["NUG_N", "NUG_R", "NUG_SR", "NUG_SSR"]) {
  assert(unitByGrade.has(grade), `frozen unit table must contain ${grade}`);
}

const handlers = new Map(createCollectionHandlers().map((entry) => [entry.packetId, entry]));
assert(handlers.has(PACKETS.UNIT_MISSION_REWARD_REQ));
assert(handlers.has(PACKETS.UNIT_MISSION_REWARD_ALL_REQ));

const socket = { session: { user: null, gameReplay: {} } };
const managedWire = [];
const notices = [];
let runtimeOpenTags = ["TAG_COLLECTION_MISSION"];
let response = null;
let saves = 0;
let invalidations = 0;
const invalidationReasons = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 5250083637907387904n,
  getEffectiveOpenTags(base) { return [...new Set([...(Array.isArray(base) ? base : []), ...runtimeOpenTags])]; },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  sendServerGamePacket(_socket, packetId, payload, label) {
    assert.strictEqual(label, "unit-mission-updated");
    notices.push({ packetId, payload });
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    invalidations += 1;
    invalidationReasons.push(reason);
  },
  saveUserDb() { saves += 1; },
};

const ssrRows = rowsForGrade("NUG_SSR");
const srRows = rowsForGrade("NUG_SR");
const firstSsr = ssrRows[0];

failure("truncated single", PACKETS.UNIT_MISSION_REWARD_REQ, makeUser("NUG_SSR", 120), Buffer.alloc(0), COLLECTION_ERRORS.INVALID_REQUEST, false);
failure(
  "trailing single",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  Buffer.concat([singleRequest(unitByGrade.get("NUG_SSR"), firstSsr), Buffer.from([0])]),
  COLLECTION_ERRORS.INVALID_REQUEST,
  false
);
failure("zero single", PACKETS.UNIT_MISSION_REWARD_REQ, makeUser("NUG_SSR", 120), singleRequest(0, firstSsr), COLLECTION_ERRORS.INVALID_REQUEST);
runtimeOpenTags = [];
failure(
  "closed tag",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  singleRequest(unitByGrade.get("NUG_SSR"), firstSsr),
  COLLECTION_ERRORS.OPENTAG_CLOSED
);
runtimeOpenTags = ["TAG_COLLECTION_MISSION"];
failure(
  "unknown unit",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  singleRequest(999999999, firstSsr),
  COLLECTION_ERRORS.UNIT_MISSION_NOT_FOUND_UNIT_HISTORY
);
failure(
  "ship unit",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  singleRequest(21001, firstSsr),
  COLLECTION_ERRORS.UNIT_MISSION_NOT_FOUND_UNIT_HISTORY
);
failure(
  "missing history",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120, { owned: false }),
  singleRequest(unitByGrade.get("NUG_SSR"), firstSsr),
  COLLECTION_ERRORS.UNIT_MISSION_NOT_FOUND_UNIT_HISTORY
);
failure(
  "unknown mission",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  request3(unitByGrade.get("NUG_SSR"), 999999999, firstSsr.stepId),
  COLLECTION_ERRORS.UNIT_MISSION_INVALID_MISSION_ID
);
failure(
  "wrong grade mission",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  singleRequest(unitByGrade.get("NUG_SSR"), srRows[0]),
  COLLECTION_ERRORS.UNIT_MISSION_INVALID_MISSION_ID
);
failure(
  "unknown step",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  request3(unitByGrade.get("NUG_SSR"), firstSsr.missionId, 999999999),
  COLLECTION_ERRORS.UNIT_MISSION_INVALID_STEP_ID
);
failure(
  "wrong mission step",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", 120),
  request3(unitByGrade.get("NUG_SSR"), firstSsr.missionId, srRows[0].stepId),
  COLLECTION_ERRORS.UNIT_MISSION_INVALID_STEP_ID
);
failure(
  "not enough level",
  PACKETS.UNIT_MISSION_REWARD_REQ,
  makeUser("NUG_SSR", firstSsr.value - 1),
  singleRequest(unitByGrade.get("NUG_SSR"), firstSsr),
  COLLECTION_ERRORS.UNIT_MISSION_NOT_ENOUGH_VALUE
);
failure("truncated all", PACKETS.UNIT_MISSION_REWARD_ALL_REQ, makeUser("NUG_SSR", 120), Buffer.alloc(0), COLLECTION_ERRORS.INVALID_REQUEST, false);
failure("zero all", PACKETS.UNIT_MISSION_REWARD_ALL_REQ, makeUser("NUG_SSR", 120), writeSignedVarInt(0), COLLECTION_ERRORS.INVALID_REQUEST);
failure(
  "missing history all",
  PACKETS.UNIT_MISSION_REWARD_ALL_REQ,
  makeUser("NUG_SSR", 120, { owned: false }),
  writeSignedVarInt(unitByGrade.get("NUG_SSR")),
  COLLECTION_ERRORS.UNIT_MISSION_NOT_FOUND_UNIT_HISTORY
);
assert.strictEqual(saves, 0, "rejected mission claims must not save");
assert.strictEqual(invalidations, 0, "rejected mission claims must not invalidate JOIN");

const singleUser = makeUser("NUG_SSR", firstSsr.value);
const singleBefore = totalItem(singleUser, 101);
send(PACKETS.UNIT_MISSION_REWARD_REQ, singleUser, singleRequest(singleUser.unitId, firstSsr));
let ack = readSingleAck(response.payload);
assert.strictEqual(ack.errorCode, COLLECTION_ERRORS.OK);
assert.deepStrictEqual(ack.missionData, missionShape(singleUser.unitId, firstSsr));
assert.strictEqual(ack.rewardItems["101"], String(singleBefore + BigInt(firstSsr.rewardValue)));
assert.strictEqual(totalItem(singleUser, 101), singleBefore + BigInt(firstSsr.rewardValue));
assert.strictEqual(buildCompletedUnitMissionPayloads(singleUser).length, 1);
assert.strictEqual(buildRewardEnableUnitMissionPayloads(singleUser, { unitIds: [singleUser.unitId] }).length, 0);
const afterSingle = JSON.stringify(singleUser);
send(PACKETS.UNIT_MISSION_REWARD_REQ, singleUser, singleRequest(singleUser.unitId, firstSsr));
ack = readSingleAck(response.payload);
assert.strictEqual(ack.errorCode, COLLECTION_ERRORS.UNIT_MISSION_INVALID_STEP_ID);
assert.strictEqual(ack.rewardPresent, false);
assert.strictEqual(JSON.stringify(singleUser), afterSingle, "duplicate single claims must not mutate state");
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);

for (const grade of ["NUG_N", "NUG_R", "NUG_SR", "NUG_SSR"]) {
  const rows = rowsForGrade(grade);
  const user = makeUser(grade, 120);
  const expectedReward = rows.reduce((sum, row) => sum + BigInt(row.rewardValue), 0n);
  send(PACKETS.UNIT_MISSION_REWARD_ALL_REQ, user, writeSignedVarInt(user.unitId));
  const bulkAck = readAllAck(response.payload);
  assert.strictEqual(bulkAck.errorCode, COLLECTION_ERRORS.OK);
  assert.deepStrictEqual(bulkAck.missionData, rows.map((row) => missionShape(user.unitId, row)));
  assert.strictEqual(bulkAck.rewardItems["101"], String(expectedReward));
  assert.strictEqual(totalItem(user, 101), expectedReward);
  assert.strictEqual(buildCompletedUnitMissionPayloads(user).length, 5);
  assert.strictEqual(buildRewardEnableUnitMissionPayloads(user, { unitIds: [user.unitId] }).length, 0);
  const restarted = JSON.parse(JSON.stringify(user));
  assert.strictEqual(buildCompletedUnitMissionPayloads(restarted).length, 5);
  send(PACKETS.UNIT_MISSION_REWARD_ALL_REQ, restarted, writeSignedVarInt(user.unitId));
  const repeated = readAllAck(response.payload);
  assert.strictEqual(repeated.errorCode, COLLECTION_ERRORS.UNIT_MISSION_NOT_ENOUGH_VALUE);
  assert.strictEqual(repeated.missionData.length, 0);
  assert.strictEqual(repeated.rewardPresent, false);
  assert.strictEqual(totalItem(restarted, 101), expectedReward);
}

const historyUser = makeUser("NUG_SSR", 120);
assert.strictEqual(buildRewardEnableUnitMissionPayloads(historyUser, { unitIds: [historyUser.unitId] }).length, 5);
assert.strictEqual(historyUser.collection.unitMissionMaxLevels[String(historyUser.unitId)], 120);
historyUser.army.units = {};
const historyRestarted = JSON.parse(JSON.stringify(historyUser));
send(PACKETS.UNIT_MISSION_REWARD_REQ, historyRestarted, singleRequest(historyRestarted.unitId, firstSsr));
ack = readSingleAck(response.payload);
assert.strictEqual(ack.errorCode, COLLECTION_ERRORS.OK, "durable max-level history must survive physical removal and restart");

const noticeUser = makeUser("NUG_SR", 90);
socket.session.user = noticeUser;
const noticeStart = notices.length;
sendUnitMissionUpdatedNot(ctx, socket, noticeUser, { unitIds: [noticeUser.unitId] });
assert.strictEqual(notices.length, noticeStart + 1);
assert.strictEqual(notices.at(-1).packetId, PACKETS.UNIT_MISSION_UPDATED_NOT);
assert.deepStrictEqual(
  readMissionList(notices.at(-1).payload, 0),
  rowsForGrade("NUG_SR").slice(0, 2).map((row) => missionShape(noticeUser.unitId, row))
);
runtimeOpenTags = [];
sendUnitMissionUpdatedNot(ctx, socket, noticeUser, { unitIds: [noticeUser.unitId] });
assert.strictEqual(notices.length, noticeStart + 1, "closed mission tag must suppress update notifications");
runtimeOpenTags = ["TAG_COLLECTION_MISSION"];

assert.strictEqual(saves, 6, "one single, four rarity bulk claims, and one history claim must save exactly once each");
assert.strictEqual(invalidations, 6);
assert.deepStrictEqual(invalidationReasons, [
  "unit-mission-reward",
  "unit-mission-reward-all",
  "unit-mission-reward-all",
  "unit-mission-reward-all",
  "unit-mission-reward-all",
  "unit-mission-reward",
]);

validateManagedSchemas();
console.log(
  `[unit-mission-protocol-check] PASS rows=${missionRows.length} saves=${saves} packets=${managedWire.length} notices=${notices.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function rowsForGrade(grade) {
  return missionRows.filter((row) => row.grade === grade).sort((a, b) => a.value - b.value || a.stepId - b.stepId);
}

function makeUser(grade, level, options = {}) {
  const unitId = unitByGrade.get(grade);
  const unitUid = "9100000000000001";
  const owned = options.owned !== false;
  const user = {
    userUid: "9860000000001438",
    nickname: "UnitMissionCheck",
    unitId,
    army: {
      units: owned ? { [unitUid]: { unitUid, userUid: "9860000000001438", unitId, level, exp: 0 } } : {},
      ships: {},
      trophies: {},
      operators: {},
      decks: [],
    },
    collection: {
      units: owned ? [unitId] : [],
      ships: [],
      trophies: [],
      operators: [],
      skins: [],
      unitMissionsClaimed: {},
      unitMissionMaxLevels: {},
      teamRewards: {},
      miscRewards: {},
      episodeRewards: {},
    },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  };
  ensureArmy(user);
  return user;
}

function failure(label, packetId, user, payload, expectedError, validateRequest = true) {
  const before = JSON.stringify(user);
  send(packetId, user, payload, validateRequest);
  if (packetId === PACKETS.UNIT_MISSION_REWARD_REQ) {
    const failed = readSingleAck(response.payload);
    assert.strictEqual(failed.errorCode, expectedError, label);
    assert.strictEqual(failed.rewardPresent, false, `${label} reward must be null`);
  } else {
    const failed = readAllAck(response.payload);
    assert.strictEqual(failed.errorCode, expectedError, label);
    assert.deepStrictEqual(failed.missionData, [], `${label} mission list must be empty`);
    assert.strictEqual(failed.rewardPresent, false, `${label} reward must be null`);
  }
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate user state`);
}

function send(packetId, user, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing unit mission handler ${packetId}`);
  socket.session.user = user;
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `unit mission handler ${packetId} must ACK`);
}

function singleRequest(unitId, row) {
  return request3(unitId, row.missionId, row.stepId);
}

function request3(unitId, missionId, stepId) {
  return Buffer.concat([writeSignedVarInt(unitId), writeSignedVarInt(missionId), writeSignedVarInt(stepId)]);
}

function missionShape(unitId, row) {
  return { unitId: Number(unitId), missionId: Number(row.missionId), stepId: Number(row.stepId) };
}

function readSingleAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const present = readBool(payload, error.offset);
  assert.strictEqual(present.value, true, "single mission ACK must carry its default mission object");
  const mission = readMission(payload, present.offset);
  const reward = readNullableReward(payload, mission.offset);
  assert.strictEqual(reward.offset, payload.length, "single mission ACK must have no trailing bytes");
  return { errorCode: error.value, missionData: mission.value, rewardPresent: reward.present, rewardItems: reward.values };
}

function readAllAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const missions = readMissionListAt(payload, error.offset);
  const reward = readNullableReward(payload, missions.offset);
  assert.strictEqual(reward.offset, payload.length, "bulk mission ACK must have no trailing bytes");
  return { errorCode: error.value, missionData: missions.values, rewardPresent: reward.present, rewardItems: reward.values };
}

function readMission(payload, startOffset) {
  const unitId = readSignedVarInt(payload, startOffset);
  const missionId = readSignedVarInt(payload, unitId.offset);
  const stepId = readSignedVarInt(payload, missionId.offset);
  return { value: { unitId: unitId.value, missionId: missionId.value, stepId: stepId.value }, offset: stepId.offset };
}

function readMissionList(payload, startOffset) {
  const parsed = readMissionListAt(payload, startOffset);
  assert.strictEqual(parsed.offset, payload.length, "mission notification must have no trailing bytes");
  return parsed.values;
}

function readMissionListAt(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  const values = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true, "mission list entries must be non-null");
    const mission = readMission(payload, present.offset);
    values.push(mission.value);
    offset = mission.offset;
  }
  return { values, offset };
}

function readNullableReward(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { present: false, values: {}, offset: present.offset };
  let offset = present.offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  const miscItems = readItemList(payload, offset);
  offset = miscItems.offset;
  for (let index = 0; index < 7; index += 1) offset = readEmptyList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readEmptyList(payload, offset);
  return { present: true, values: miscItems.values, offset };
}

function readItemList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  const values = {};
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true, "mission reward items must be non-null");
    const itemId = readSignedVarInt(payload, present.offset);
    const free = readSignedVarLong(payload, itemId.offset);
    const paid = readSignedVarLong(payload, free.offset);
    const bonus = readSignedVarInt(payload, paid.offset);
    offset = bonus.offset + 8;
    const key = String(itemId.value);
    values[key] = String(BigInt(values[key] || 0) + BigInt(free.value) + BigInt(paid.value));
  }
  return { values, offset };
}

function readEmptyList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0, "unused mission reward list must be empty");
  return count.offset;
}

function readRawVarInt(payload, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < payload.length && shift <= 28) {
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("invalid raw varint");
}

function totalItem(user, itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
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
      assert(result.ok, `managed client schema rejected unit mission packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
