"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  getGuildData,
  loadTables,
} = require("../modules/company-buff");
const {
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeString,
} = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.RENAME_REQ);
assert(handler, "Guild rename specialist missing");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3500-guild-rename-req.js");

const now = new Date("2026-08-20T12:00:00.000Z");
const nowBinary = dateTimeBinaryForDate(now);
const recentRename = dateTimeBinaryForDate(new Date("2026-08-10T12:00:00.000Z"));
const oldRename = dateTimeBinaryForDate(new Date("2026-06-01T12:00:00.000Z"));
const users = {
  "7001": makeUser("7001", 77, 0, "Guild77", 0, 0n, 900000n),
  "7002": makeUser("7002", 77, 1, "Guild77", 0, 0n, 900000n),
  "7003": makeUser("7003", 77, 2, "Guild77", 0, 0n, 900000n),
  "8001": makeUser("8001", 88, 0, "Guild88", 1, oldRename, 400000n),
  "8002": makeUser("8002", 88, 2, "Guild88", 1, oldRename, 400000n),
  "9001": makeUser("9001", 99, 0, "PoorGuild", 1, oldRename, 299999n),
  "9101": makeUser("9101", 100, 0, "RecentGuild", 1, recentRename, 900000n),
  "9201": makeUser("9201", 200, 0, "Existing", 0, 0n, 900000n),
  "9301": makeUser("9301", 201, 0, "ClosingGuild", 0, 0n, 900000n, 2),
  "9901": makeUser("9901", 0, 2, "", 0, 0n, 0n),
};
const online = new Map(Object.entries(users).map(([uid, user]) => [uid, { session: { user } }]));
const managedPackets = [];
const pushes = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  dateTimeBinaryNow() { return nowBinary; },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 95);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  sendServerGamePacket(socket, packetId, payload, label) {
    pushes.push({ userUid: String(socket.session.user.userUid), packetId, payload, label });
    managedPackets.push([packetId, payload]);
  },
  findClientSocketByUserUid(userUid) { return online.get(String(userUid)) || null; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

verifyFrozenSources();
verifyConstants();
verifyStrictFraming();
verifyFailures();
verifyFreeRename();
verifyPaidRename();
verifyRestart();
validateManagedSchemas();

assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);
console.log(
  `[guild-rename-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_RENAME_REQ.cs"), /newName/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_RENAME_ACK.cs"), /errorCode[\s\S]*prevName[\s\S]*newName/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_RENAME_NOT.cs"), /guildUid[\s\S]*newName/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCPopupGuildNameChange.cs"), /characterLimit = 16[\s\S]*CheckNameLength\(this\.m_GuildName, 2, 16\)[\s\S]*ConsortiumNameChangeFree[\s\S]*ConsortiumNameChangeResourceValue/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyManage.cs"), /latestRenameDate\.AddDays[\s\S]*ConsortiumNameChangeLimitDay/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_RENAME_NOT[\s\S]*MyGuildData\.name = sPacket\.newName/);
}

function verifyConstants() {
  assert.deepStrictEqual(loadTables().guildRenameConfig, {
    freeCount: 1,
    limitDays: 30,
    resourceItemId: 24,
    resourceValue: 300000,
  });
  assert.deepStrictEqual(
    {
      FAILED: ERRORS.RENAME_FAILED,
      INVALID_NAME: ERRORS.RENAME_INVALID_NAME,
      SAME_NAME: ERRORS.RENAME_SAME_NAME,
      NO_PERMISSION: ERRORS.RENAME_NO_PERMISSION,
      CHANGE_COUNT: ERRORS.RENAME_CHANGE_COUNT,
      LIMIT_DAY: ERRORS.RENAME_LIMIT_DAY,
      INSUFFICIENT: ERRORS.RENAME_INSUFFICIENT_RESOURCE,
      DUPLICATE: ERRORS.RENAME_ALREADY_EXISTS_NAME,
    },
    { FAILED: 27000, INVALID_NAME: 27001, SAME_NAME: 27002, NO_PERMISSION: 27003, CHANGE_COUNT: 27004, LIMIT_DAY: 27005, INSUFFICIENT: 27006, DUPLICATE: 27007 }
  );
}

function verifyStrictFraming() {
  reject(users["7001"], Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(users["7001"], Buffer.concat([renameRequest("FreshName"), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(users["7001"], Buffer.concat([Buffer.from([0x92, 0x00]), Buffer.from("FreshName")]), ERRORS.INVALID_REQUEST, false);
}

function verifyFailures() {
  reject(users["9901"], renameRequest("FreshName"), ERRORS.RENAME_FAILED);
  reject(users["7002"], renameRequest("FreshName"), ERRORS.RENAME_NO_PERMISSION);
  reject(users["9301"], renameRequest("FreshName"), ERRORS.RENAME_FAILED);
  reject(users["7001"], renameRequest("A"), ERRORS.RENAME_INVALID_NAME);
  reject(users["7001"], renameRequest("Guild77"), ERRORS.RENAME_SAME_NAME);
  reject(users["7001"], renameRequest("existing"), ERRORS.RENAME_ALREADY_EXISTS_NAME);
  reject(users["9101"], renameRequest("AfterCooldown"), ERRORS.RENAME_LIMIT_DAY);
  reject(users["9001"], renameRequest("Fundless"), ERRORS.RENAME_INSUFFICIENT_RESOURCE);
}

function verifyFreeRename() {
  const beforePushes = pushes.length;
  const ack = invoke(users["7001"], renameRequest("FreshName"));
  assert.deepStrictEqual(decodeRenameAck(ack), { errorCode: 0, prevName: "Guild77", newName: "FreshName" });
  const guild = getGuildData(ctx, 77n);
  assert.strictEqual(guild.name, "FreshName");
  assert.strictEqual(guild.renameCount, 1);
  assert.strictEqual(guild.latestRenameDate, nowBinary);
  assert.strictEqual(guild.unionPoint, 900000n);
  for (const user of guild.members) assert.strictEqual(user.guildName, "FreshName");
  verifyPushes(beforePushes, ["7001", "7002", "7003"], 77n, "FreshName");
  reject(users["7001"], renameRequest("TooSoon"), ERRORS.RENAME_LIMIT_DAY);
}

function verifyPaidRename() {
  const beforePushes = pushes.length;
  const ack = invoke(users["8001"], renameRequest("PaidName"));
  assert.deepStrictEqual(decodeRenameAck(ack), { errorCode: 0, prevName: "Guild88", newName: "PaidName" });
  const guild = getGuildData(ctx, 88n);
  assert.strictEqual(guild.name, "PaidName");
  assert.strictEqual(guild.renameCount, 2);
  assert.strictEqual(guild.latestRenameDate, nowBinary);
  assert.strictEqual(guild.unionPoint, 100000n);
  for (const user of guild.members) assert.strictEqual(user.guildUnionPoint, "100000");
  verifyPushes(beforePushes, ["8001", "8002"], 88n, "PaidName");
}

function verifyPushes(beforePushes, expectedUsers, guildUid, newName) {
  const emitted = pushes.slice(beforePushes);
  const notices = emitted.filter((push) => push.packetId === PACKETS.RENAME_NOT);
  const updates = emitted.filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT);
  assert.deepStrictEqual(notices.map((push) => push.userUid).sort(), expectedUsers);
  assert.deepStrictEqual(updates.map((push) => push.userUid).sort(), expectedUsers);
  for (const notice of notices) assert.deepStrictEqual(decodeRenameNot(notice.payload), { guildUid, newName });
}

function verifyRestart() {
  const restarted = { ...ctx, userDb: JSON.parse(JSON.stringify(ctx.userDb)) };
  assert.strictEqual(getGuildData(restarted, 77n).name, "FreshName");
  assert.strictEqual(getGuildData(restarted, 77n).renameCount, 1);
  assert.strictEqual(getGuildData(restarted, 88n).name, "PaidName");
  assert.strictEqual(getGuildData(restarted, 88n).renameCount, 2);
  assert.strictEqual(getGuildData(restarted, 88n).unionPoint, 100000n);
}

function invoke(user, payload, canonical = true) {
  if (canonical) managedPackets.push([PACKETS.RENAME_REQ, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.RENAME_REQ, sequence: 95, payload }), true);
  assert(socket.response && socket.response.packetId === PACKETS.RENAME_ACK);
  return socket.response.payload;
}

function reject(user, payload, expectedError, canonical = true) {
  const before = JSON.stringify(users);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  const ack = invoke(user, payload, canonical);
  assert.strictEqual(readSignedVarInt(ack, 0).value, expectedError);
  assert.strictEqual(JSON.stringify(users), before);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(pushes.length, beforePushes);
}

function decodeRenameAck(payload) {
  const error = readSignedVarInt(payload, 0);
  let field = readString(payload, error.offset);
  const prevName = field.value;
  field = readString(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode: error.value, prevName, newName: field.value };
}

function decodeRenameNot(payload) {
  const guild = readSignedVarLong(payload, 0);
  const name = readString(payload, guild.offset);
  assert.strictEqual(name.offset, payload.length);
  return { guildUid: guild.value, newName: name.value };
}

function renameRequest(value) {
  return writeString(value);
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
      assert(result.ok, `managed client schema rejected Guild rename packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, guildUid, grade, guildName, renameCount, latestRenameDate, unionPoint, guildState = 1) {
  return {
    userUid,
    friendCode: String(10000000 + Number(userUid)),
    nickname: `User${userUid}`,
    level: 50,
    guildUid: String(guildUid),
    guildMemberGrade: grade,
    guildMemberCreatedAt: "2026-08-01T12:00:00.000Z",
    guildLevel: 3,
    guildLevelExp: "0",
    guildUnionPoint: String(unionPoint),
    guildName,
    guildBadgeId: guildUid > 0 ? String(guildUid + 300) : "0",
    guildJoinType: 1,
    guildState,
    guildClosingTime: "0",
    guildRenameCount: renameCount,
    guildLatestRenameDate: String(latestRenameDate),
    guildJoinDisableTime: "0",
    guildJoinRequests: [],
    guildInvites: [],
    guildLastAttendanceDate: "0",
    guildAttendanceHistory: [],
    guildWeeklyContributionPoint: 0,
    guildTotalContributionPoint: 0,
    lastLoginAt: "2026-08-20T11:00:00.000Z",
  };
}
