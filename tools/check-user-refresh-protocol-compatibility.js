"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { claimDailyAttendance, buildAttendanceNotifyPayload } = require("../modules/attendance");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
} = require("../modules/packet-codec");
const { prepareUserRefreshNotifications } = require("../modules/user-refresh");

const ROOT_DIR = path.resolve(__dirname, "..");
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const TICKS_PER_MILLISECOND = 10000n;
const DAILY_REFRESH_NOT = 1629;
const ATTENDANCE_NOT = 1640;
const WEEKLY_REFRESH_NOT = 1648;
const DAILY_ITEM_IDS = [4, 9, 15, 16, 17, 203, 1065];
const WEEKLY_ITEM_IDS = [204];
const managedWire = [];

const user = {
  userUid: "986000000001629",
  registeredAt: "2026-08-01T00:00:00.000Z",
  dailyMissionPoint: 55,
  weeklyMissionPoint: 77,
  missionPointResetKeys: { daily: "daily:2026-08-19", weekly: "weekly:2026-33" },
  completedMissions: {},
  missionCounters: {},
};
setMiscItemBalance(user, 203, 55);
setMiscItemBalance(user, 204, 77);

const thursday = dateTimeBinary("2026-08-20T12:00:00.000Z");
const first = prepareUserRefreshNotifications(user, { now: thursday });
assert.deepStrictEqual(first.packets.map((packet) => packet.packetId), [DAILY_REFRESH_NOT, WEEKLY_REFRESH_NOT]);
assert.deepStrictEqual(first.dailyItems.map((item) => item.itemId), DAILY_ITEM_IDS);
assert.deepStrictEqual(first.weeklyItems.map((item) => item.itemId), WEEKLY_ITEM_IDS);
assert.strictEqual(user.dailyMissionPoint, 0);
assert.strictEqual(user.weeklyMissionPoint, 0);
assertPacketItems(first.packets[0], DAILY_ITEM_IDS, true);
assertPacketItems(first.packets[1], WEEKLY_ITEM_IDS, false);
managedWire.push(...first.packets.map((packet) => [packet.packetId, packet.payload]));
assert.strictEqual(first.commit(), true, "first delivery must consume durable daily and weekly cursors");
assert.strictEqual(first.commit(), false, "notification commit must be one-shot");

const duplicate = prepareUserRefreshNotifications(user, { now: thursday });
assert.strictEqual(duplicate.packets.length, 0, "same-period refresh must be notification-free");
assert.strictEqual(duplicate.commit(), false);
const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(prepareUserRefreshNotifications(restarted, { now: thursday }).packets.length, 0, "restart must preserve consumed cursors");

const friday = prepareUserRefreshNotifications(restarted, { now: dateTimeBinary("2026-08-21T12:00:00.000Z") });
assert.deepStrictEqual(friday.packets.map((packet) => packet.packetId), [DAILY_REFRESH_NOT]);
assert.deepStrictEqual(friday.dailyItems.map((item) => item.itemId), DAILY_ITEM_IDS);
assertPacketItems(friday.packets[0], DAILY_ITEM_IDS, true);
managedWire.push([friday.packets[0].packetId, friday.packets[0].payload]);
assert.strictEqual(friday.commit(), true);

const monday = prepareUserRefreshNotifications(restarted, { now: dateTimeBinary("2026-08-24T12:00:00.000Z") });
assert.deepStrictEqual(monday.packets.map((packet) => packet.packetId), [DAILY_REFRESH_NOT, WEEKLY_REFRESH_NOT]);
assertPacketItems(monday.packets[0], DAILY_ITEM_IDS, true);
assertPacketItems(monday.packets[1], WEEKLY_ITEM_IDS, false);
managedWire.push(...monday.packets.map((packet) => [packet.packetId, packet.payload]));
assert.strictEqual(monday.commit(), true);

const attendanceUser = { userUid: "986000000001640", registeredAt: "2026-08-20T00:00:00.000Z" };
const attendanceDayOne = new Date("2026-08-20T12:00:00.000Z");
assert.strictEqual(claimDailyAttendance(attendanceUser, { now: attendanceDayOne, clockNow: attendanceDayOne }).checkedIn, true);
const attendanceOne = buildAttendanceNotifyPayload(attendanceUser, {
  now: attendanceDayOne,
  clockNow: attendanceDayOne,
  consumePrompt: true,
});
assertAttendance(attendanceOne);
managedWire.push([ATTENDANCE_NOT, attendanceOne]);
assert.strictEqual(buildAttendanceNotifyPayload(attendanceUser, { now: attendanceDayOne, clockNow: attendanceDayOne }), null);
assert.strictEqual(
  buildAttendanceNotifyPayload(JSON.parse(JSON.stringify(attendanceUser)), { now: attendanceDayOne, clockNow: attendanceDayOne }),
  null,
  "attendance prompt cursor must survive restart"
);
const attendanceDayTwo = new Date("2026-08-21T12:00:00.000Z");
assert.strictEqual(claimDailyAttendance(attendanceUser, { now: attendanceDayTwo, clockNow: attendanceDayTwo }).checkedIn, true);
const attendanceTwo = buildAttendanceNotifyPayload(attendanceUser, {
  now: attendanceDayTwo,
  clockNow: attendanceDayTwo,
  consumePrompt: true,
});
assertAttendance(attendanceTwo);
managedWire.push([ATTENDANCE_NOT, attendanceTwo]);

assertFrozenSources();
validateManagedSchemas();
console.log(`[user-refresh-protocol-check] PASS dailyItems=${DAILY_ITEM_IDS.length} weeklyItems=${WEEKLY_ITEM_IDS.length} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function assertPacketItems(packet, expectedIds, hasErrorCode) {
  let offset = 0;
  if (hasErrorCode) {
    const error = readSignedVarInt(packet.payload, offset);
    assert.strictEqual(error.value, 0);
    offset = error.offset;
  }
  const count = readUnsignedVarInt(packet.payload, offset);
  offset = count.offset;
  const itemIds = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(packet.payload, offset);
    assert.strictEqual(present.value, true);
    const itemId = readSignedVarInt(packet.payload, present.offset);
    const countFree = readSignedVarLong(packet.payload, itemId.offset);
    const countPaid = readSignedVarLong(packet.payload, countFree.offset);
    const bonusRatio = readSignedVarInt(packet.payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    itemIds.push(itemId.value);
  }
  assert.strictEqual(offset, packet.payload.length, `packet ${packet.packetId} must have no trailing bytes`);
  assert.deepStrictEqual(itemIds, expectedIds);
}

function assertAttendance(payload) {
  assert(Buffer.isBuffer(payload) && payload.length > 0);
  const error = readSignedVarInt(payload, 0);
  assert.strictEqual(error.value, 0);
  const lastUpdate = readSignedVarLong(payload, error.offset);
  assert(lastUpdate.value > TICKS_AT_UNIX_EPOCH);
  const count = readUnsignedVarInt(payload, lastUpdate.offset);
  assert(count.value > 0);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const idx = readSignedVarInt(payload, present.offset);
    const attendanceCount = readSignedVarInt(payload, idx.offset);
    assert(idx.value > 0 && attendanceCount.value > 0);
    offset = attendanceCount.offset + 8;
  }
  assert.strictEqual(offset, payload.length, "attendance notification must have no trailing bytes");
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

function dateTimeBinary(iso) {
  return (TICKS_AT_UNIX_EPOCH + BigInt(new Date(iso).getTime()) * TICKS_PER_MILLISECOND) | DATE_TIME_LOCAL_MASK;
}

function assertFrozenSources() {
  const dailyPacket = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "User", "NKMPacket_CONTENTS_DAILY_REFRESH_NOT.cs"), "utf8");
  const attendancePacket = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "User", "NKMPacket_ATTENDANCE_NOT.cs"), "utf8");
  const weeklyPacket = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "User", "NKMPacket_WEEKLY_REFRESH_NOT.cs"), "utf8");
  const receiver = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  const join = fs.readFileSync(path.join(ROOT_DIR, "packet-handlers", "0204-join-lobby-req.js"), "utf8");
  const heartbeat = fs.readFileSync(path.join(ROOT_DIR, "packet-handlers", "0600-heart-bit-req.js"), "utf8");
  const listener = fs.readFileSync(path.join(ROOT_DIR, "server", "listener.js"), "utf8");
  assert(dailyPacket.includes("PutOrGetEnum<NKM_ERROR_CODE>(ref this.errorCode)") && dailyPacket.includes("PutOrGet<NKMItemMiscData>(ref this.refreshItemDataList)"));
  assert(attendancePacket.includes("stream.PutOrGet(ref this.lastUpdateDate)") && attendancePacket.includes("PutOrGet<NKMAttendance>(ref this.attendanceData)"));
  assert(weeklyPacket.includes("PutOrGet<NKMItemMiscData>(ref this.refreshItemDataList)"));
  assert(receiver.includes("m_InventoryData.RefreshDailyContens();") && receiver.includes("OnRecv(NKMPacket_WEEKLY_REFRESH_NOT"));
  assert(receiver.includes("ReserveAttendanceData(sPacket.attendanceData, sPacket.lastUpdateDate);"));
  assert(join.includes('sendCapturedGameTemplateRange(socket, 2, 5, "tutorial-join-lobby-boot"') && !join.includes('sendCapturedGameTemplateRange(socket, 2, 7, "tutorial-join-lobby-boot"'));
  assert(join.includes("sendAttendanceBootstrap(ctx, socket, user, \"tutorial-attendance-not\")"));
  assert(heartbeat.includes("ctx.sendStaminaChargeNotifications(socket, \"heart-bit-charge-item\")"));
  assert(listener.includes("userRefresh.prepareUserRefreshNotifications(user, { now })"));
  assert(fs.existsSync(path.join(ROOT_DIR, "server-data", "captured-game-flow", "server_006_1640.payload.bin")));
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
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected user-refresh packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
