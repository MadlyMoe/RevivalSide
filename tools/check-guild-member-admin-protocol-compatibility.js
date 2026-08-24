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
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const exitHandler = exactHandler(PACKETS.EXIT_REQ, "modules\\company-buff\\handlers\\0000-3428-guild-exit-req.js");
const gradeHandler = exactHandler(PACKETS.SET_MEMBER_GRADE_REQ, "modules\\company-buff\\handlers\\0000-3430-guild-set-member-grade-req.js");
const banHandler = exactHandler(PACKETS.BAN_REQ, "modules\\company-buff\\handlers\\0000-3433-guild-ban-req.js");

const now = new Date("2026-08-20T12:00:00.000Z");
const users = {
  "7001": makeUser("7001", 77, 0),
  "7002": makeUser("7002", 77, 1),
  "7003": makeUser("7003", 77, 2),
  "7004": makeUser("7004", 77, 1),
  "7005": makeUser("7005", 77, 2),
  "7010": makeUser("7010", 77, 1),
  "7011": makeUser("7011", 77, 1),
  "7012": makeUser("7012", 77, 1),
  "7100": makeUser("7100", 77, 2),
  "8001": makeUser("8001", 0, 2),
  "9001": makeUser("9001", 88, 0),
  "9002": makeUser("9002", 88, 2),
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
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 92);
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
verifyExitLifecycle();
verifyGradeLifecycle();
verifyBanLifecycle();
verifyRestart();
validateManagedSchemas();

assert.strictEqual(saves, 5);
assert.strictEqual(invalidations, 5);
console.log(
  `[guild-member-admin-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  reject(exitHandler, users["7100"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(exitHandler, users["7100"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, Buffer.concat([exitRequest(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(exitHandler, users["7100"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, nonCanonical(exitRequest(77n)), ERRORS.INVALID_REQUEST, false);

  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, Buffer.concat([gradeRequest(77n, 7005n, 1), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, Buffer.concat([writeSignedVarLong(77n), writeSignedVarLong(7005n), nonCanonical(writeSignedVarInt(1))]), ERRORS.INVALID_REQUEST, false);

  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, Buffer.concat([banRequest(77n, 7003n, 1), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, Buffer.concat([writeSignedVarLong(77n), nonCanonical(writeSignedVarLong(7003n)), writeSignedVarInt(1)]), ERRORS.INVALID_REQUEST, false);
}

function verifyExitLifecycle() {
  reject(exitHandler, users["8001"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, exitRequest(77n), ERRORS.NOT_A_MEMBER);
  reject(exitHandler, users["9002"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, exitRequest(77n), ERRORS.INVALID_GUILD_UID);
  reject(exitHandler, users["7001"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, exitRequest(77n), ERRORS.INVALID_GRADE);

  const beforeSaves = saves;
  const beforePushes = pushes.length;
  const ack = invoke(exitHandler, users["7100"], PACKETS.EXIT_REQ, PACKETS.EXIT_ACK, exitRequest(77n));
  const decoded = decodeExitAck(ack);
  assert.deepStrictEqual(decoded, {
    errorCode: 0,
    guildUid: 77n,
    joinDisableTime: dateTimeBinaryForDate(new Date("2026-08-21T12:00:00.000Z")),
  });
  assert.strictEqual(users["7100"].guildUid, "0");
  assert.strictEqual(users["7100"].guildMemberGrade, 2);
  assert.strictEqual(users["7100"].guildJoinDisableTime, String(decoded.joinDisableTime));
  assert.deepStrictEqual(users["7100"].guildJoinRequests, []);
  assert.deepStrictEqual(users["7100"].guildInvites, []);
  assert.strictEqual(saves, beforeSaves + 1);
  const emitted = pushes.slice(beforePushes);
  const disableTime = emitted.find((push) => push.packetId === PACKETS.JOIN_DISABLETIME_UPDATED_NOT && push.userUid === "7100");
  assert(disableTime);
  assert.strictEqual(disableTime.payload.readBigInt64LE(0), decoded.joinDisableTime);
  assert.strictEqual(disableTime.payload.length, 8);
  assert(emitted.filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT).every((push) => push.userUid !== "7100"));
  assert.strictEqual(getGuildData(ctx, 77n).members.some((user) => String(user.userUid) === "7100"), false);
}

function verifyGradeLifecycle() {
  reject(gradeHandler, users["7002"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7005n, 1), ERRORS.NOT_MASTER);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 8001n, 1), ERRORS.SET_GRADE_INVALID_TARGET);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7001n, 1), ERRORS.SET_GRADE_INVALID_TARGET);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7005n, 0), ERRORS.SET_GRADE_INVALID_VALUE);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7005n, 3), ERRORS.SET_GRADE_INVALID_VALUE);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7005n, 2), ERRORS.SET_GRADE_INVALID_VALUE);
  reject(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7005n, 1), ERRORS.SET_GRADE_MAX_STAFF_COUNT);

  const demotePushes = pushes.length;
  const demoteAck = invoke(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7004n, 2));
  assert.deepStrictEqual(decodeGradeAck(demoteAck), { errorCode: 0, guildUid: 77n, userUid: 7004n, grade: 2 });
  assert.strictEqual(users["7004"].guildMemberGrade, 2);
  const demoteNot = pushes.slice(demotePushes).find((push) => push.packetId === PACKETS.MEMBER_GRADE_UPDATED_NOT && push.userUid === "7004");
  assert.deepStrictEqual(decodeGradeNot(demoteNot.payload), { guildUid: 77n, gradeBefore: 1, gradeAfter: 2 });
  assert(pushes.slice(demotePushes).some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === "7004"));

  const promotePushes = pushes.length;
  const promoteAck = invoke(gradeHandler, users["7001"], PACKETS.SET_MEMBER_GRADE_REQ, PACKETS.SET_MEMBER_GRADE_ACK, gradeRequest(77n, 7005n, 1));
  assert.deepStrictEqual(decodeGradeAck(promoteAck), { errorCode: 0, guildUid: 77n, userUid: 7005n, grade: 1 });
  assert.strictEqual(users["7005"].guildMemberGrade, 1);
  const promoteNot = pushes.slice(promotePushes).find((push) => push.packetId === PACKETS.MEMBER_GRADE_UPDATED_NOT && push.userUid === "7005");
  assert.deepStrictEqual(decodeGradeNot(promoteNot.payload), { guildUid: 77n, gradeBefore: 2, gradeAfter: 1 });
}

function verifyBanLifecycle() {
  reject(banHandler, users["7003"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7010n, 1), ERRORS.NOT_ENOUGH_GRADE);
  reject(banHandler, users["7002"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7005n, 1), ERRORS.BAN_INVALID_TARGET);
  reject(banHandler, users["7002"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7001n, 1), ERRORS.BAN_INVALID_TARGET);
  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7001n, 1), ERRORS.BAN_INVALID_TARGET);
  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 9002n, 1), ERRORS.BAN_INVALID_TARGET);
  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7003n, 0), ERRORS.INVALID_REQUEST);
  reject(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7003n, 5), ERRORS.INVALID_REQUEST);

  const masterPushes = pushes.length;
  const masterAck = invoke(banHandler, users["7001"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7010n, 4));
  assert.deepStrictEqual(decodeBanAck(masterAck), { errorCode: 0, guildUid: 77n, userUid: 7010n });
  verifyBanResult(users["7010"], 4, masterPushes);

  const staffPushes = pushes.length;
  const staffAck = invoke(banHandler, users["7002"], PACKETS.BAN_REQ, PACKETS.BAN_ACK, banRequest(77n, 7003n, 2));
  assert.deepStrictEqual(decodeBanAck(staffAck), { errorCode: 0, guildUid: 77n, userUid: 7003n });
  verifyBanResult(users["7003"], 2, staffPushes);
}

function verifyBanResult(user, reason, beforePushes) {
  const userUid = String(user.userUid);
  assert.strictEqual(user.guildUid, "0");
  assert.strictEqual(user.guildJoinDisableTime, "0");
  assert.deepStrictEqual(user.guildLastBan && { guildUid: user.guildLastBan.guildUid, reason: user.guildLastBan.reason }, { guildUid: "77", reason });
  const emitted = pushes.slice(beforePushes);
  const notice = emitted.find((push) => push.packetId === PACKETS.BAN_NOT && push.userUid === userUid);
  assert.deepStrictEqual(decodeBanNot(notice.payload), { guildUid: 77n, banReason: reason });
  assert.strictEqual(emitted.some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === userUid), false);
  assert(emitted.some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === "7001"));
}

function verifyRestart() {
  const restartedUsers = JSON.parse(JSON.stringify(users));
  const restarted = { ...ctx, userDb: { users: restartedUsers } };
  assert.strictEqual(restartedUsers["7100"].guildUid, "0");
  assert.strictEqual(restartedUsers["7100"].guildJoinDisableTime, String(dateTimeBinaryForDate(new Date("2026-08-21T12:00:00.000Z"))));
  assert.strictEqual(restartedUsers["7004"].guildMemberGrade, 2);
  assert.strictEqual(restartedUsers["7005"].guildMemberGrade, 1);
  assert.deepStrictEqual(restartedUsers["7010"].guildLastBan && restartedUsers["7010"].guildLastBan.reason, 4);
  assert.deepStrictEqual(restartedUsers["7003"].guildLastBan && restartedUsers["7003"].guildLastBan.reason, 2);
  assert.strictEqual(getGuildData(restarted, 77n).members.some((user) => ["7100", "7010", "7003"].includes(String(user.userUid))), false);
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_EXIT_REQ.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_EXIT_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*joinDisableTime/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_SET_MEMBER_GRADE_REQ.cs"), /guildUid[\s\S]*targetUserUid[\s\S]*grade/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_SET_MEMBER_GRADE_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*targetUserUid[\s\S]*grade/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_MEMBER_GRADE_UPDATED_NOT.cs"), /guildUid[\s\S]*gradeBefore[\s\S]*gradeAfter/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BAN_REQ.cs"), /guildUid[\s\S]*targetUserUid[\s\S]*banReason/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BAN_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*targetUserUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BAN_NOT.cs"), /guildUid[\s\S]*banReason/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCPopupGuildUserInfo.cs"), /m_btnChangeGrade[\s\S]*myData\.grade == GuildMemberGrade\.Master[\s\S]*m_btnBan[\s\S]*myData\.grade != GuildMemberGrade\.Member && myData\.grade < userData\.grade[\s\S]*m_btnExit[\s\S]*myData\.grade > GuildMemberGrade\.Master/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCPopupGuildUserInfo.cs"), /OnBan\(int banReason\)[\s\S]*Send_NKMPacket_GUILD_BAN_REQ/);
  const errors = source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs");
  assert.match(errors, /NEC_FAIL_GUILD_INVALID_GRADE[\s\S]*NEC_FAIL_GUILD_NOT_A_MEMBER[\s\S]*NEC_FAIL_GUILD_SET_GRADE_INVALID_TARGET[\s\S]*NEC_FAIL_GUILD_SET_GRADE_INVALID_VALUE[\s\S]*NEC_FAIL_GUILD_SET_GRADE_MAX_STAFF_COUNT[\s\S]*NEC_FAIL_GUILD_BAN_INVALID_TARGET/);
  assert.match(errors, /NEC_FAIL_GUILD_NOT_ENOUGH_GRADE[\s\S]*NEC_FAIL_GUILD_NOT_MASTER/);
}

function verifyConstants() {
  const config = loadTables().guildConfig;
  assert.strictEqual(config.exitPenaltyHours, 24);
  assert.strictEqual(config.maxStaffCount, 5);
  assert.deepStrictEqual(
    {
      INVALID_REQUEST: ERRORS.INVALID_REQUEST,
      INVALID_GUILD_UID: ERRORS.INVALID_GUILD_UID,
      INVALID_MEMBER_UID: ERRORS.INVALID_MEMBER_UID,
      INVALID_GRADE: ERRORS.INVALID_GRADE,
      NOT_A_MEMBER: ERRORS.NOT_A_MEMBER,
      SET_GRADE_INVALID_TARGET: ERRORS.SET_GRADE_INVALID_TARGET,
      SET_GRADE_INVALID_VALUE: ERRORS.SET_GRADE_INVALID_VALUE,
      SET_GRADE_MAX_STAFF_COUNT: ERRORS.SET_GRADE_MAX_STAFF_COUNT,
      BAN_INVALID_TARGET: ERRORS.BAN_INVALID_TARGET,
      NOT_ENOUGH_GRADE: ERRORS.NOT_ENOUGH_GRADE,
      NOT_MASTER: ERRORS.NOT_MASTER,
    },
    {
      INVALID_REQUEST: 20191,
      INVALID_GUILD_UID: 20432,
      INVALID_MEMBER_UID: 20433,
      INVALID_GRADE: 20434,
      NOT_A_MEMBER: 20443,
      SET_GRADE_INVALID_TARGET: 20448,
      SET_GRADE_INVALID_VALUE: 20449,
      SET_GRADE_MAX_STAFF_COUNT: 20450,
      BAN_INVALID_TARGET: 20451,
      NOT_ENOUGH_GRADE: 20480,
      NOT_MASTER: 20616,
    }
  );
}

function invoke(handler, user, requestId, ackId, payload, canonical = true) {
  if (canonical) managedPackets.push([requestId, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: requestId, sequence: 92, payload }), true);
  assert(socket.response && socket.response.packetId === ackId);
  return socket.response.payload;
}

function reject(handler, user, requestId, ackId, payload, expectedError, canonical = true) {
  const before = JSON.stringify(users);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  const ack = invoke(handler, user, requestId, ackId, payload, canonical);
  assert.strictEqual(readSignedVarInt(ack, 0).value, expectedError);
  assert.strictEqual(JSON.stringify(users), before);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(pushes.length, beforePushes);
}

function decodeExitAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  const joinDisableTime = payload.readBigInt64LE(field.offset);
  assert.strictEqual(field.offset + 8, payload.length);
  return { errorCode, guildUid, joinDisableTime };
}

function decodeGradeAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  const userUid = field.value;
  field = readSignedVarInt(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, guildUid, userUid, grade: field.value };
}

function decodeGradeNot(payload) {
  let field = readSignedVarLong(payload, 0);
  const guildUid = field.value;
  field = readSignedVarInt(payload, field.offset);
  const gradeBefore = field.value;
  field = readSignedVarInt(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { guildUid, gradeBefore, gradeAfter: field.value };
}

function decodeBanAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, guildUid, userUid: field.value };
}

function decodeBanNot(payload) {
  let field = readSignedVarLong(payload, 0);
  const guildUid = field.value;
  field = readSignedVarInt(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { guildUid, banReason: field.value };
}

function exitRequest(guildUid) {
  return writeSignedVarLong(guildUid);
}

function gradeRequest(guildUid, userUid, grade) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(userUid), writeSignedVarInt(grade)]);
}

function banRequest(guildUid, userUid, banReason) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(userUid), writeSignedVarInt(banReason)]);
}

function nonCanonical(encoded) {
  const value = Buffer.from(encoded);
  value[value.length - 1] |= 0x80;
  return Buffer.concat([value, Buffer.from([0])]);
}

function exactHandler(packetId, fileName) {
  const handler = handlers.get(packetId);
  assert(handler, `specialist missing for ${packetId}`);
  assert.strictEqual(handler.fileName, fileName);
  return handler;
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
      assert(result.ok, `managed client schema rejected Guild member-admin packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, guildUid, grade) {
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
    guildUnionPoint: "1000",
    guildName: guildUid === 77 ? "Admin Guild" : guildUid === 88 ? "Other Guild" : "",
    guildBadgeId: guildUid > 0 ? String(guildUid + 300) : "0",
    guildJoinType: 1,
    guildState: 1,
    guildJoinDisableTime: "0",
    guildJoinRequests: guildUid > 0 ? [] : [77],
    guildInvites: guildUid > 0 ? [] : [77],
    guildLastAttendanceDate: "0",
    guildAttendanceHistory: [],
    guildWeeklyContributionPoint: 0,
    guildTotalContributionPoint: 0,
    lastLoginAt: "2026-08-20T11:00:00.000Z",
  };
}
