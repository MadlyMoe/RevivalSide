"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, ERRORS, loadTables } = require("../modules/company-buff");
const {
  buildRewardData,
  readSignedVarInt,
  readSignedVarLong,
  writeNullableObject,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.ATTENDANCE_REQ);
assert(handler, "guild attendance specialist must be registered");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3447-guild-attendance-req.js");

let now = new Date("2026-08-20T12:00:00.000Z");
const yesterday = dateTimeBinaryForDate(new Date("2026-08-19T12:00:00.000Z"));
const today = dateTimeBinaryForDate(now);
const users = {
  "9001": makeUser("9001", { guildUid: 77, item21: 10, guildLevelExp: 1980, joinedAt: "2026-08-10T12:00:00.000Z" }),
};
for (let index = 0; index < 15; index += 1) {
  users[String(9100 + index)] = makeUser(String(9100 + index), { guildUid: 77, guildLevelExp: 1980, lastAttendanceDate: yesterday });
}
for (let index = 0; index < 2; index += 1) {
  users[String(9200 + index)] = makeUser(String(9200 + index), { guildUid: 77, guildLevelExp: 1980, lastAttendanceDate: today });
}

const managedPackets = [];
const missionEvents = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  dateTimeBinaryNow() { return dateTimeBinaryForDate(now); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 69);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(label) {
    assert.strictEqual(label, "guild-attendance");
    invalidations += 1;
  },
  trackMissionEvent(user, condition, amount, details) {
    missionEvents.push({ userUid: user.userUid, condition, amount, details });
    return true;
  },
};

verifyFrozenSources();
verifyTables();
verifyFailures();
verifyAttendanceAndRestart();
validateManagedSchemas();

console.log(
  `[guild-attendance-check] PASS rewards=${loadTables().attendanceAdditionalRewards.length + loadTables().attendanceBasicRewards.length} saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyTables() {
  const tables = loadTables();
  assert.strictEqual(tables.guildConfig.attendanceExp, 50);
  assert.deepStrictEqual(tables.attendanceBasicRewards, [{ itemId: 21, count: 50 }]);
  assert.deepStrictEqual(tables.attendanceAdditionalRewards, [
    { attendanceCount: 3, itemId: 21, count: 30 },
    { attendanceCount: 5, itemId: 21, count: 50 },
    { attendanceCount: 10, itemId: 21, count: 100 },
    { attendanceCount: 15, itemId: 21, count: 150 },
  ]);
}

function verifyFailures() {
  const member = makeUser("9301", { guildUid: 77 });
  rejects("empty", member, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  rejects("trailing", member, Buffer.concat([request(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  rejects("noncanonical", member, Buffer.from([0x9a, 0x81, 0x00]), ERRORS.INVALID_REQUEST, false);
  rejects("guild mismatch", member, request(88n), ERRORS.INVALID_GUILD_UID);
  rejects("not a member", makeUser("9302", { guildUid: 0 }), request(77n), ERRORS.NOT_A_MEMBER);
}

function verifyAttendanceAndRestart() {
  const user = users["9001"];
  let ack = succeeds(user, request(77n), {
    rewardItems: [{ itemId: 21, countFree: 200n, countPaid: 0n }],
    guildExpDelta: 50n,
  });
  assert.strictEqual(ack.guildUid, 77n);
  assert.strictEqual(ack.lastAttendanceDate, dateTimeBinaryForDate(now));
  assert.strictEqual(ack.memberJoinDate, dateTimeBinaryForDate(new Date("2026-08-10T12:00:00.000Z")));
  assert.deepStrictEqual([ack.yesterdayAttendanceCount, ack.todayAttendanceCount], [15, 3]);
  assert.strictEqual(user.inventory.misc[21].countFree, "210");
  assert.deepStrictEqual([user.guildLevel, user.guildLevelExp], [2, "30"]);
  assert.strictEqual(users["9100"].guildLevel, 2);
  assert.strictEqual(users["9100"].guildLevelExp, "30");
  assert.deepStrictEqual([user.guildWeeklyContributionPoint, user.guildTotalContributionPoint], ["50", "50"]);
  assert.deepStrictEqual(missionEvents, [{ userUid: "9001", condition: "GUILD_ATTENDANCE", amount: 1, details: { guildUid: "77" } }]);
  assert.strictEqual(saves, 1);
  assert.strictEqual(invalidations, 1);
  rejects("same-day duplicate", user, request(77n), ERRORS.ATTENDANCE_DUPLICATE_REQUEST);

  const restarted = JSON.parse(JSON.stringify(user));
  assert.strictEqual(restarted.guildLastAttendanceDate, String(dateTimeBinaryForDate(now)));
  assert.deepStrictEqual(restarted.guildAttendanceHistory, { "2026-08-19": 15, "2026-08-20": 3 });

  now = new Date("2026-08-21T12:00:00.000Z");
  ack = succeeds(user, request(77n), {
    rewardItems: [{ itemId: 21, countFree: 80n, countPaid: 0n }],
    guildExpDelta: 50n,
  });
  assert.deepStrictEqual([ack.yesterdayAttendanceCount, ack.todayAttendanceCount], [3, 1]);
  assert.strictEqual(user.inventory.misc[21].countFree, "290");
  assert.strictEqual(user.guildLevelExp, "80");
  assert.strictEqual(saves, 2);
  assert.strictEqual(invalidations, 2);
  assert.strictEqual(missionEvents.length, 2);
}

function succeeds(user, payload, expected) {
  const socket = { session: { user } };
  managedPackets.push([PACKETS.ATTENDANCE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true);
  assert.strictEqual(socket.response.packetId, PACKETS.ATTENDANCE_ACK);
  const ack = decodeAck(socket.response.payload, expected);
  assert.strictEqual(ack.errorCode, ERRORS.OK);
  return ack;
}

function rejects(name, user, payload, expectedError, canonical = true) {
  const socket = { session: { user } };
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeMissions = missionEvents.length;
  if (canonical) managedPackets.push([PACKETS.ATTENDANCE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true, name);
  assert.strictEqual(socket.response.packetId, PACKETS.ATTENDANCE_ACK, name);
  const ack = decodeAck(socket.response.payload, null);
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate`);
  assert.strictEqual(saves, beforeSaves, `${name} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${name} must not invalidate JOIN`);
  assert.strictEqual(missionEvents.length, beforeMissions, `${name} must not track missions`);
  return ack;
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_ATTENDANCE_REQ.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_ATTENDANCE_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*lastAttendanceDate[\s\S]*memberJoinDate[\s\S]*rewardData[\s\S]*additionalReward[\s\S]*yesterdayAttendanceCount[\s\S]*todayAttendanceCount/);
  assert.match(source("Assembly-CSharp", "NKM", "Guild", "GuildAttendanceTemplet.cs"), /BasicRewards[\s\S]*AdditionalRewards[\s\S]*GetRewards[\s\S]*yestardayAttendanceCount/);
  assert.match(source("Assembly-CSharp", "NKM", "Guild", "GuildTypeExt.cs"), /GetYesterdayAttendance[\s\S]*GetTodayAttendance[\s\S]*HasAttendanceData/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_ATTENDANCE_ACK[\s\S]*GetReward[\s\S]*lastAttendanceDate[\s\S]*OpenRewardGain/);
  assert.match(source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_GUILD_ATTENDANCE_DUPLICATE_REQUEST/);
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
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected guild attendance packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, options = {}) {
  const user = {
    userUid,
    guildUid: String(options.guildUid || 0),
    guildLevel: Number(options.guildLevel || 1),
    guildLevelExp: String(options.guildLevelExp || 0),
    guildUnionPoint: "0",
    guildWeeklyContributionPoint: "0",
    guildTotalContributionPoint: "0",
    inventory: {
      misc: { 21: { itemId: 21, countFree: String(options.item21 || 0), countPaid: "0", bonusRatio: 0, regDate: "0" } },
      equips: {},
      skins: [],
    },
  };
  if (options.lastAttendanceDate) user.guildLastAttendanceDate = String(options.lastAttendanceDate);
  if (options.joinedAt) user.guildMemberCreatedAt = options.joinedAt;
  return user;
}

function request(guildUid) {
  return writeSignedVarLong(guildUid);
}

function packet(payload) {
  return { packetId: PACKETS.ATTENDANCE_REQ, sequence: 69, payload };
}

function decodeAck(payload, expected) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  let offset = field.offset;
  const lastAttendanceDate = payload.readBigInt64LE(offset); offset += 8;
  const memberJoinDate = payload.readBigInt64LE(offset); offset += 8;
  const rewardBytes = expected
    ? writeNullableObject(buildRewardData({ miscItems: expected.rewardItems }))
    : Buffer.from([0]);
  assert(payload.subarray(offset, offset + rewardBytes.length).equals(rewardBytes), "guild attendance rewardData schema");
  offset += rewardBytes.length;
  assert.strictEqual(payload.readUInt8(offset++), 1, "additionalReward must be non-null");
  const guildExp = readSignedVarLong(payload, offset); offset = guildExp.offset;
  const unionPoint = readSignedVarLong(payload, offset); offset = unionPoint.offset;
  const eventPass = readSignedVarLong(payload, offset); offset = eventPass.offset;
  assert.strictEqual(guildExp.value, expected ? expected.guildExpDelta : 0n);
  assert.strictEqual(unionPoint.value, 0n);
  assert.strictEqual(eventPass.value, 0n);
  const yesterdayAttendanceCount = readSignedVarInt(payload, offset); offset = yesterdayAttendanceCount.offset;
  const todayAttendanceCount = readSignedVarInt(payload, offset); offset = todayAttendanceCount.offset;
  assert.strictEqual(offset, payload.length);
  return {
    errorCode,
    guildUid,
    lastAttendanceDate,
    memberJoinDate,
    yesterdayAttendanceCount: yesterdayAttendanceCount.value,
    todayAttendanceCount: todayAttendanceCount.value,
  };
}
