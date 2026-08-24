"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  buildGuildData,
  getGuildData,
} = require("../modules/company-buff");
const {
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
const handler = handlers.get(PACKETS.DATA_REQ);
assert(handler, "guild data specialist must be registered");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3414-guild-data-req.js");

const users = {
  "7003": makeUser("7003", {
    guildUid: 77,
    grade: 0,
    nickname: "GuildMaster",
    guildName: "Revival",
    badgeId: 401,
    guildLevel: 2,
    guildLevelExp: 30,
    unionPoint: 500,
    guildJoinType: 1,
    guildState: 1,
    guildGreeting: "Welcome home",
    guildNotice: "Read the notice",
    guildDungeonNotice: "Hit the boss",
    guildChatNoticeType: 1,
    guildRenameCount: 2,
    guildLatestRenameDate: "2026-08-10T12:00:00.000Z",
    guildMemberGreeting: "Founder",
    weeklyContribution: 120,
    totalContribution: 900,
    lastAttendanceDate: "2026-08-19T12:00:00.000Z",
    attendanceHistory: { "2026-08-18": 2, "2026-08-19": 2 },
    hasOffice: true,
  }),
  "7001": makeUser("7001", {
    guildUid: 77,
    grade: 1,
    nickname: "Staff",
    guildLevel: 3,
    guildLevelExp: 10,
    unionPoint: 900,
    weeklyContribution: 80,
    totalContribution: 450,
    lastAttendanceDate: "2026-08-19T12:00:00.000Z",
  }),
  "7002": makeUser("7002", {
    guildUid: 77,
    grade: 2,
    nickname: "Member",
    guildLevel: 2,
    guildLevelExp: 1900,
    unionPoint: 700,
    lastAttendanceDate: "2026-08-20T12:00:00.000Z",
  }),
  "8001": makeUser("8001", {
    guildUid: 88,
    grade: 0,
    nickname: "OtherMaster",
    guildName: "Other Guild",
    badgeId: 402,
    guildLevel: 1,
    guildLevelExp: 55,
    unionPoint: 25,
  }),
};

const managedPackets = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 71);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

verifyFrozenSources();
verifyReadModel();
verifyRequests();
verifyRestart();
validateManagedSchemas();

console.log(
  `[guild-data-check] PASS guilds=2 members=4 saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyReadModel() {
  const guild = getGuildData(ctx, 77n);
  assert(guild, "local guild must resolve");
  assert.deepStrictEqual(
    {
      guildUid: guild.guildUid,
      name: guild.name,
      badgeId: guild.badgeId,
      level: guild.guildLevel,
      exp: guild.guildLevelExp,
      joinType: guild.guildJoinType,
      state: guild.guildState,
      greeting: guild.greeting,
      notice: guild.notice,
      unionPoint: guild.unionPoint,
      dungeonNotice: guild.dungeonNotice,
      chatNoticeType: guild.chatNoticeType,
      renameCount: guild.renameCount,
    },
    {
      guildUid: 77n,
      name: "Revival",
      badgeId: 401n,
      level: 3,
      exp: 10n,
      joinType: 1,
      state: 1,
      greeting: "Welcome home",
      notice: "Read the notice",
      unionPoint: 900n,
      dungeonNotice: "Hit the boss",
      chatNoticeType: 1,
      renameCount: 2,
    }
  );
  assert.deepStrictEqual(guild.members.map((member) => member.userUid), ["7003", "7001", "7002"]);
  assert.deepStrictEqual(guild.attendanceList.map((entry) => [entry.count, String(entry.date)]), [
    [2, String(dateTimeBinaryForDate(new Date("2026-08-18T00:00:00.000Z")))],
    [2, String(dateTimeBinaryForDate(new Date("2026-08-19T00:00:00.000Z")))],
    [1, String(dateTimeBinaryForDate(new Date("2026-08-20T00:00:00.000Z")))],
  ]);
  assert.deepStrictEqual(guild.inviteList, []);
  assert.deepStrictEqual(guild.joinWaitingList, []);
  assert.strictEqual(getGuildData(ctx, 999n), null);
}

function verifyRequests() {
  const before = JSON.stringify(users);
  succeeds(77n);
  succeeds(88n);
  rejects("empty", Buffer.alloc(0), ERRORS.INVALID_REQUEST, 0n, false);
  rejects("trailing", Buffer.concat([request(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, 0n, false);
  rejects("noncanonical", Buffer.from([0x9a, 0x81, 0x00]), ERRORS.INVALID_REQUEST, 0n, false);
  rejects("zero uid", request(0n), ERRORS.INVALID_GUILD_UID, 0n);
  rejects("unknown guild", request(999n), ERRORS.DATA_NOT_EXISTS, 999n);
  assert.strictEqual(JSON.stringify(users), before, "guild reads must not mutate user state");
  assert.strictEqual(saves, 0, "guild reads must not save");
  assert.strictEqual(invalidations, 0, "guild reads must not invalidate JOIN");
}

function verifyRestart() {
  const restarted = { userDb: { users: JSON.parse(JSON.stringify(users)) } };
  assert.deepStrictEqual(jsonSafe(getGuildData(restarted, 77n)), jsonSafe(getGuildData(ctx, 77n)));
}

function succeeds(guildUid) {
  const payload = request(guildUid);
  managedPackets.push([PACKETS.DATA_REQ, payload]);
  const socket = { session: { user: users["7002"] } };
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true);
  assert.strictEqual(socket.response.packetId, PACKETS.DATA_ACK);
  const header = decodeHeader(socket.response.payload);
  assert.strictEqual(header.errorCode, ERRORS.OK);
  assert.strictEqual(header.guildUid, guildUid);
  assert.strictEqual(header.hasGuildData, true);
  const expected = writeNullableObject(buildGuildData(getGuildData(ctx, guildUid)));
  assert(socket.response.payload.subarray(header.objectOffset - 1).equals(expected), "ACK must carry exact guild object");
}

function rejects(name, payload, expectedError, expectedGuildUid, canonical = true) {
  if (canonical) managedPackets.push([PACKETS.DATA_REQ, payload]);
  const socket = { session: { user: users["7002"] } };
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true, name);
  assert.strictEqual(socket.response.packetId, PACKETS.DATA_ACK, name);
  const header = decodeHeader(socket.response.payload);
  assert.strictEqual(header.errorCode, expectedError, name);
  assert.strictEqual(header.guildUid, expectedGuildUid, name);
  assert.strictEqual(header.hasGuildData, false, name);
  assert.strictEqual(header.objectOffset, socket.response.payload.length, name);
}

function decodeHeader(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  assert(field.offset < payload.length, "guildData nullability flag missing");
  const hasGuildData = payload.readUInt8(field.offset) === 1;
  return { errorCode, guildUid, hasGuildData, objectOffset: field.offset + 1 };
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_DATA_REQ.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_DATA_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*guildData/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMGuildData.cs"), /guildUid[\s\S]*name[\s\S]*badgeId[\s\S]*guildLevel[\s\S]*guildLevelExp[\s\S]*guildJoinType[\s\S]*guildState[\s\S]*closingTime[\s\S]*greeting[\s\S]*notice[\s\S]*inviteList[\s\S]*joinWaitingList[\s\S]*members[\s\S]*attendanceList[\s\S]*unionPoint[\s\S]*dungeonNotice[\s\S]*chatNoticeType[\s\S]*renameCount[\s\S]*latestRenameDate/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCPacketSender.cs"), /Send_NKMPacket_GUILD_DATA_REQ[\s\S]*guildUid/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_DATA_ACK[\s\S]*NKCPopupGuildInfo\.Instance\.Open/);
  assert.match(source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_GUILD_DATA_NOT_EXISTS/);
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
      assert(result.ok, `managed client schema rejected guild data packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, options = {}) {
  const joinedAt = options.joinedAt || "2026-08-01T12:00:00.000Z";
  const user = {
    userUid,
    friendCode: String(10000000 + Number(userUid)),
    nickname: options.nickname || `User${userUid}`,
    level: 50,
    mainUnitId: 1001,
    mainUnitSkinId: 0,
    frameId: 0,
    mainUnitTacticLevel: 2,
    titleId: 0,
    guildUid: String(options.guildUid || 0),
    guildMemberGrade: options.grade == null ? 2 : options.grade,
    guildMemberCreatedAt: joinedAt,
    guildLevel: Number(options.guildLevel || 1),
    guildLevelExp: String(options.guildLevelExp || 0),
    guildUnionPoint: String(options.unionPoint || 0),
    guildWeeklyContributionPoint: String(options.weeklyContribution || 0),
    guildTotalContributionPoint: String(options.totalContribution || 0),
    lastLoginAt: "2026-08-20T11:00:00.000Z",
  };
  for (const key of [
    "guildName", "guildBadgeId", "guildJoinType", "guildState", "guildGreeting", "guildNotice",
    "guildDungeonNotice", "guildChatNoticeType", "guildRenameCount", "guildLatestRenameDate", "guildMemberGreeting",
  ]) {
    const sourceKey = key === "guildBadgeId" ? "badgeId" : key;
    if (options[sourceKey] != null) user[key] = options[sourceKey];
  }
  if (options.lastAttendanceDate) user.guildLastAttendanceDate = String(dateTimeBinaryForDate(new Date(options.lastAttendanceDate)));
  if (options.attendanceHistory) user.guildAttendanceHistory = { ...options.attendanceHistory };
  if (options.hasOffice) user.hasOffice = true;
  return user;
}

function request(guildUid) {
  return writeSignedVarLong(guildUid);
}

function packet(payload) {
  return { packetId: PACKETS.DATA_REQ, sequence: 71, payload };
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? String(entry) : entry));
}
