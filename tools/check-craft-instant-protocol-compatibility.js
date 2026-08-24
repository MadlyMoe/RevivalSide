"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { adminHelpText, parseGiveCommand } = require("../modules/admin");
const { createEquipmentPipelineHandlers, buildResetGroupCountNotPayload } = require("../modules/equipment-pipeline");
const {
  getEquipItems,
  getEquipmentResetCounts,
  getMoldItems,
  getMoldMaterialCosts,
  grantEquipItem,
  grantMoldItem,
} = require("../modules/equipment");
const {
  getAllEquipMoldTemplets,
  getAllResetCounterGroupTemplets,
  getEquipMoldTemplet,
  getMoldRewardRecords,
} = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, readSignedVarLong, writeSignedVarInt } = require("../modules/packet-codec");

const PACKETS = Object.freeze({ RESET_NOT: 1065, CRAFT_REQ: 1066, CRAFT_ACK: 1067 });
const ERROR = Object.freeze({
  OK: 0,
  CREDIT: 110,
  ITEM: 111,
  EQUIP_FULL: 114,
  NOT_ENOUGH_MOLD: 296,
  MOLD_NOT_FOUND: 297,
  MAX_COUNT: 304,
  INVALID_REQUEST: 20191,
  DATE_EXPIRED: 20345,
  OPEN_TAG_CLOSED: 20768,
  RESET_COUNT: 24500,
});
const ROOT_DIR = path.resolve(__dirname, "..");
const NOW = new Date("2026-08-20T12:00:00.000Z");
const BASIC_MOLD_ID = 1011;
const RESET_MOLD_ID = 5002;
const STACK_MOLD_ID = 507;
const EXPIRED_MOLD_ID = 10001;
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === PACKETS.CRAFT_REQ);
assert(handler, "CRAFT_INSTANT must be owned by the equipment specialist");

let user;
let response;
let saves = 0;
const wire = [];
const missionEvents = [];
const runtimeTags = new Set();
const socket = { session: { user: null } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (own) => [...new Set([...(Array.isArray(own) ? own : []), ...runtimeTags])],
  getServerNowDate: () => new Date(NOW),
  dateTimeBinaryNow: () => 638913168000000000n,
  saveUserDb() { saves += 1; },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    wire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

resetUser("Failures");
openTags("LOW_TIER_EQUIP_MOLD");
failure(Buffer.alloc(0), ERROR.INVALID_REQUEST, false);
failure(Buffer.concat([request(BASIC_MOLD_ID, 1), Buffer.from([0])]), ERROR.INVALID_REQUEST, false);
failure(Buffer.from([0x82, 0x00, 0x02]), ERROR.INVALID_REQUEST, false);
failure(request(BASIC_MOLD_ID, 0), ERROR.INVALID_REQUEST);
failure(request(999999, 1), ERROR.MOLD_NOT_FOUND);
failure(request(BASIC_MOLD_ID, 11), ERROR.MAX_COUNT);

openTags();
failure(request(BASIC_MOLD_ID, 1), ERROR.OPEN_TAG_CLOSED);
openTags("LOW_TIER_EQUIP_MOLD");
failure(request(EXPIRED_MOLD_ID, 1), ERROR.DATE_EXPIRED);
failure(request(BASIC_MOLD_ID, 1), ERROR.NOT_ENOUGH_MOLD);

grantMoldItem(user, BASIC_MOLD_ID, 1);
setCosts(BASIC_MOLD_ID, 1, 100n);
setMiscItemBalance(user, 1, 0);
failure(request(BASIC_MOLD_ID, 1), ERROR.CREDIT);
setCosts(BASIC_MOLD_ID, 1, 100n);
const nonCredit = moldCosts(BASIC_MOLD_ID, 1).find((cost) => cost.itemId !== 1);
assert(nonCredit, "basic frozen mold must consume a non-credit item");
setMiscItemBalance(user, nonCredit.itemId, 0);
failure(request(BASIC_MOLD_ID, 1), ERROR.ITEM);

resetUser("ResetFailure");
openTags("SHADOW_MAZE_EQUIP_MOLD", "TAG_RESET_COUNT_MAZE");
user.equipResetCounts = { "102": 0 };
user.equipResetCountPeriods = { "102": "2026-08" };
setCosts(RESET_MOLD_ID, 1, 100n);
failure(request(RESET_MOLD_ID, 1), ERROR.RESET_COUNT);

resetUser("StackFailure");
openTags("OLD_RAID_EQUIP_MOLD", "LIMITBREAK_AWAKEN_S_STACK");
user.equipResetCounts = { "105": 100000 };
setCosts(STACK_MOLD_ID, 1, 100n);
failure(request(STACK_MOLD_ID, 1), ERROR.RESET_COUNT);
failure(request(STACK_MOLD_ID, 1000), ERROR.MAX_COUNT);

resetUser("CapacityFailure");
openTags("LOW_TIER_EQUIP_MOLD");
user.inventoryExpansion = { equip: 300 };
const rewardEquipId = Number(getMoldRewardRecords(getEquipMoldTemplet(BASIC_MOLD_ID).m_RewardGroupID)[0].m_RewardID);
const adminMold = parseGiveCommand(["mold", String(BASIC_MOLD_ID), "2"]);
assert.strictEqual(adminMold.ok, true, "admin delivery must make authentic craft molds obtainable");
assert.deepStrictEqual(adminMold.rewards, [{ rewardType: "RT_MOLD", id: BASIC_MOLD_ID, count: 2 }]);
assert.match(adminHelpText(), /\/give mold <id> \[count\]/);
for (let index = 0; index < 300; index += 1) assert(grantEquipItem(user, rewardEquipId));
assert.strictEqual(getEquipItems(user).length, 300);
grantMoldItem(user, BASIC_MOLD_ID, 1);
setCosts(BASIC_MOLD_ID, 1, 100n);
failure(request(BASIC_MOLD_ID, 1), ERROR.EQUIP_FULL);

resetUser("BasicSuccess");
openTags("LOW_TIER_EQUIP_MOLD");
grantMoldItem(user, BASIC_MOLD_ID, 2);
setCosts(BASIC_MOLD_ID, 2, 100n);
const basicCosts = moldCosts(BASIC_MOLD_ID, 2);
const basicBefore = balances(basicCosts);
const missionStart = missionEvents.length;
send(request(BASIC_MOLD_ID, 2));
let ack = parseCraftAck(response.payload);
assert.deepStrictEqual({ errorCode: ack.errorCode, moldId: ack.moldId, moldCount: ack.moldCount }, { errorCode: 0, moldId: BASIC_MOLD_ID, moldCount: 2 });
assert.strictEqual(ack.materialCount, basicCosts.length);
assert.deepStrictEqual(ack.resetCount, { groupId: 0, count: 0 });
assert.strictEqual(getMoldItems(user).find((mold) => mold.moldId === BASIC_MOLD_ID).count, "0");
assert.strictEqual(getEquipItems(user).length, 2);
assertSpent(basicCosts, basicBefore);
assert.deepStrictEqual(missionEvents.slice(missionStart).map((entry) => [entry.condition, entry.amount]), [
  ["EQUIP_MAKE", 2],
  ...basicCosts.map((cost) => ["USE_RESOURCE", cost.count]),
]);

resetUser("NormalResetSuccess");
openTags("SHADOW_MAZE_EQUIP_MOLD", "TAG_RESET_COUNT_MAZE");
setCosts(RESET_MOLD_ID, 1, 100n);
send(request(RESET_MOLD_ID, 1));
ack = parseCraftAck(response.payload);
assert.strictEqual(ack.errorCode, ERROR.OK);
assert.deepStrictEqual(ack.resetCount, { groupId: 102, count: 0 });
assert.strictEqual(user.equipResetCounts["102"], 0);
assert.strictEqual(user.equipResetCountPeriods["102"], "2026-08");
const normalRestart = JSON.parse(JSON.stringify(user));
assert.strictEqual(findResetCount(normalRestart, 102, NOW), 0);
assert.strictEqual(findResetCount(normalRestart, 102, new Date("2026-09-01T12:00:00.000Z")), 1);
failure(request(RESET_MOLD_ID, 1), ERROR.RESET_COUNT);

resetUser("StackResetSuccess");
openTags("OLD_RAID_EQUIP_MOLD", "LIMITBREAK_AWAKEN_S_STACK");
setCosts(STACK_MOLD_ID, 1, 100n);
send(request(STACK_MOLD_ID, 1));
ack = parseCraftAck(response.payload);
assert.strictEqual(ack.errorCode, ERROR.OK);
assert.deepStrictEqual(ack.resetCount, { groupId: 105, count: 1 });
assert.strictEqual(user.equipResetCounts["105"], 1, "stack molds persist cumulative consumption");
user.equipResetCounts["1013"] = 27;
const stackRestart = JSON.parse(JSON.stringify(user));
const resetPayload = buildResetGroupCountNotPayload(ctx, stackRestart);
wire.push([PACKETS.RESET_NOT, resetPayload]);
const resetPush = parseResetList(resetPayload);
assert(resetPush.some((entry) => entry.groupId === 105 && entry.count === 1));
assert(resetPush.some((entry) => entry.groupId === 1013 && entry.count === 27), "RESET_GROUP_COUNT_NOT must preserve tuning counters");

const evidence = assertFrozenTablesAndSources();
validateManagedSchemas();
console.log(`[craft-instant-protocol-check] PASS molds=${evidence.molds} rewards=${evidence.rewards} resetGroups=${evidence.resetGroups} resetMolds=${evidence.resetMolds} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function resetUser(nickname) {
  user = { userUid: String(988000000000100n + BigInt(saves)), nickname };
  socket.session.user = user;
  getEquipItems(user);
  getMoldItems(user);
  runtimeTags.clear();
}

function openTags(...tags) {
  runtimeTags.clear();
  for (const tag of tags) runtimeTags.add(tag);
}

function request(moldId, moldCount) {
  return Buffer.concat([writeSignedVarInt(moldId), writeSignedVarInt(moldCount)]);
}

function send(payload, trackRequest = true) {
  if (trackRequest) wire.push([PACKETS.CRAFT_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.CRAFT_REQ, sequence: PACKETS.CRAFT_REQ, payload }), true);
  assert(response, "CRAFT_INSTANT must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.CRAFT_ACK);
}

function failure(payload, errorCode, trackRequest = true) {
  const before = JSON.parse(JSON.stringify(user));
  const beforeSaves = saves;
  const beforeMissions = missionEvents.length;
  send(payload, trackRequest);
  assert.strictEqual(parseCraftAck(response.payload).errorCode, errorCode);
  assert.deepStrictEqual(user, before, `failed craft ${errorCode} must be mutation-free`);
  assert.strictEqual(saves, beforeSaves, `failed craft ${errorCode} must not save`);
  assert.strictEqual(missionEvents.length, beforeMissions, `failed craft ${errorCode} must not advance missions`);
}

function moldCosts(moldId, count) {
  return getMoldMaterialCosts(getEquipMoldTemplet(moldId), count).filter((cost) => cost.itemId > 0 && cost.count > 0);
}

function setCosts(moldId, count, surplus) {
  for (const cost of moldCosts(moldId, count)) setMiscItemBalance(user, cost.itemId, BigInt(cost.count) + surplus);
}

function balance(itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
}

function balances(costs) {
  return new Map(costs.map((cost) => [cost.itemId, balance(cost.itemId)]));
}

function assertSpent(costs, before) {
  for (const cost of costs) assert.strictEqual(balance(cost.itemId), before.get(cost.itemId) - BigInt(cost.count));
}

function findResetCount(target, groupId, nowDate) {
  const rows = getEquipmentResetCounts(target, { nowDate, isResetGroupActive: () => true });
  const row = rows.find((entry) => entry.groupId === groupId);
  return row && row.count;
}

function parseCraftAck(payload) {
  let offset = 0;
  const error = readSignedVarInt(payload, offset); offset = error.offset;
  const mold = readSignedVarInt(payload, offset); offset = mold.offset;
  const count = readSignedVarInt(payload, offset); offset = count.offset;
  const materialList = readObjectList(payload, offset, readItemMisc); offset = materialList.offset;
  assert.strictEqual(payload[offset++], 1, "resetCount must be non-null");
  const group = readSignedVarInt(payload, offset); offset = group.offset;
  const resetCount = readSignedVarInt(payload, offset); offset = resetCount.offset;
  assert.strictEqual(payload[offset], 1, "createdRewardData must be non-null");
  return {
    errorCode: error.value,
    moldId: mold.value,
    moldCount: count.value,
    materialCount: materialList.values.length,
    resetCount: { groupId: group.value, count: resetCount.value },
  };
}

function parseResetList(payload) {
  return readObjectList(payload, 0, (buffer, start) => {
    const group = readSignedVarInt(buffer, start);
    const count = readSignedVarInt(buffer, group.offset);
    return { value: { groupId: group.value, count: count.value }, offset: count.offset };
  }).values;
}

function readObjectList(payload, start, readObject) {
  const length = readUnsignedVarInt(payload, start);
  const values = [];
  let offset = length.offset;
  for (let index = 0; index < length.value; index += 1) {
    assert.strictEqual(payload[offset++], 1, "list object must be non-null");
    const value = readObject(payload, offset);
    values.push(value.value);
    offset = value.offset;
  }
  return { values, offset };
}

function readItemMisc(payload, start) {
  const itemId = readSignedVarInt(payload, start);
  const free = readSignedVarLong(payload, itemId.offset);
  const paid = readSignedVarLong(payload, free.offset);
  const bonus = readSignedVarInt(payload, paid.offset);
  return { value: { itemId: itemId.value }, offset: bonus.offset + 8 };
}

function readUnsignedVarInt(payload, start) {
  let offset = start;
  let value = 0;
  let shift = 0;
  while (shift < 35) {
    assert(offset < payload.length, "truncated unsigned varint");
    const byte = payload[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("unsigned varint too long");
}

function assertFrozenTablesAndSources() {
  const molds = getAllEquipMoldTemplets();
  const resetGroups = getAllResetCounterGroupTemplets();
  const rewards = molds.reduce((sum, mold) => sum + getMoldRewardRecords(mold.m_RewardGroupID).length, 0);
  const resetMolds = molds.filter((mold) => Number(mold.m_ResetGroupId || 0) > 0);
  assert.strictEqual(molds.length, 165);
  assert.strictEqual(resetGroups.length, 14);
  assert.strictEqual(resetMolds.length, 11);
  assert.strictEqual(molds.filter((mold) => mold.m_DateStrID).length, 2);
  assert(molds.every((mold) => getMoldRewardRecords(mold.m_RewardGroupID).length > 0));

  const requestSource = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_CRAFT_INSTANT_REQ.cs"), "utf8");
  const ackSource = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_CRAFT_INSTANT_ACK.cs"), "utf8");
  const resetSource = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_RESET_GROUP_COUNT_NOT.cs"), "utf8");
  const itemManagerSource = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "NKM", "NKMItemManager.cs"), "utf8");
  const receiverSource = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  const popupSource = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "NKC", "UI", "NKCPopupForgeCraft.cs"), "utf8");
  const joinSource = fs.readFileSync(path.join(ROOT_DIR, "packet-handlers", "0204-join-lobby-req.js"), "utf8");
  const firstCapturedReset = fs.readFileSync(path.join(ROOT_DIR, "server-data", "captured-game-flow", "server_001_1065.payload.bin"));
  const secondCapturedReset = fs.readFileSync(path.join(ROOT_DIR, "server-data", "captured-game-flow", "server_013_1065.payload.bin"));
  assert(requestSource.includes("stream.PutOrGet(ref this.moldId);") && requestSource.includes("stream.PutOrGet(ref this.moldCount);"));
  for (const field of ["materialItemDataList", "resetCount", "createdRewardData"]) assert(ackSource.includes(field));
  assert(resetSource.includes("resetCountList"));
  assert(itemManagerSource.includes("GetRemainResetCountStack") && itemManagerSource.includes("m_StackCount") && itemManagerSource.includes("CalcLastReset"));
  assert(receiverSource.includes("NKMItemManager.SetResetCount(sPacket.resetCount);") && receiverSource.includes("SetResetCount(sPacket.resetCountList)"));
  assert(popupSource.includes("nkmpacket_CRAFT_INSTANT_REQ.moldCount = this.m_CurrCountToMake;"));
  assert(firstCapturedReset.equals(secondCapturedReset), "captured JOIN must contain the same 1065 bootstrap at positions 1 and 13");
  assert(joinSource.includes('const { buildResetGroupCountNotPayload } = require("../modules/equipment-pipeline");'));
  const tutorialReset = joinSource.indexOf('sendResetCountBootstrap(ctx, socket, user, "tutorial-join-lobby-reset-count")');
  const tutorialBoot = joinSource.indexOf('sendCapturedGameTemplateRange(socket, 2, 5, "tutorial-join-lobby-boot"');
  const tutorialAttendance = joinSource.indexOf('sendAttendanceBootstrap(ctx, socket, user, "tutorial-attendance-not"');
  const tutorialBootTail = joinSource.indexOf('sendCapturedGameTemplateRange(socket, 7, 7, "tutorial-join-lobby-boot"');
  assert(tutorialReset >= 0 && tutorialReset < tutorialBoot && tutorialBoot < tutorialAttendance && tutorialAttendance < tutorialBootTail,
    "tutorial JOIN must preserve reset, captured boot, attendance, and captured tail ordering");
  const tutorialPost = joinSource.indexOf('sendCapturedGameTemplateRange(socket, 9, 9, "tutorial-join-lobby-post-boot"');
  const tutorialPostTail = joinSource.indexOf('sendCapturedGameTemplateRange(socket, 12, 12, "tutorial-join-lobby-post-boot"');
  const tutorialResetRefresh = joinSource.indexOf('sendResetCountBootstrap(ctx, socket, user, "tutorial-join-lobby-reset-count-refresh"');
  const tutorialFinal = joinSource.indexOf('sendCapturedGameTemplateRange(socket, 14, 18, "tutorial-join-lobby-post-boot"');
  assert(tutorialPost >= 0 && tutorialPost < tutorialPostTail && tutorialPostTail < tutorialResetRefresh && tutorialResetRefresh < tutorialFinal,
    "tutorial JOIN must preserve split post-boot and reset-refresh ordering");
  assert(joinSource.includes('sendCapturedGameTemplateRange(socket, 14, 18, "tutorial-join-lobby-post-boot"'));
  assert(joinSource.includes('sendCapturedGameTemplateRange(socket, 12, 12, "join-lobby-post-boot"'));
  assert(!joinSource.includes('sendCapturedGameTemplateRange(socket, 1, 7, "tutorial-join-lobby-boot"'));
  assert(!joinSource.includes('sendCapturedGameTemplateRange(socket, 12, 13, "join-lobby-post-boot"'));
  return { molds: molds.length, rewards, resetGroups: resetGroups.length, resetMolds: resetMolds.length };
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT_DIR, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT_DIR, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of wire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected craft packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
