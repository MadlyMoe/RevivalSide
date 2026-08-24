"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  getGuildData,
} = require("../modules/company-buff");
const { readGameplayTable } = require("../modules/gameplay-jsons");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const recoveryHandler = exactHandler(
  PACKETS.MASTER_MIGRATION_REQ,
  "modules\\company-buff\\handlers\\0000-3436-guild-master-migration-req.js"
);
const specifiedHandler = exactHandler(
  PACKETS.MASTER_SPECIFIED_MIGRATION_REQ,
  "modules\\company-buff\\handlers\\0000-3438-guild-master-specified-migration-req.js"
);

const now = new Date("2026-08-20T12:00:00.000Z");
const closingTime = dateTimeBinaryForDate(new Date("2026-08-22T12:00:00.000Z"));
const users = {
  "7001": makeUser("7001", 77, 0, 1, 0n),
  "7002": makeUser("7002", 77, 1, 1, 0n),
  "7003": makeUser("7003", 77, 2, 1, 0n),
  "8001": makeUser("8001", 88, 0, 2, closingTime),
  "8002": makeUser("8002", 88, 1, 2, closingTime),
  "8003": makeUser("8003", 88, 2, 2, closingTime),
  "9001": makeUser("9001", 99, 1, 2, closingTime),
  "9002": makeUser("9002", 99, 2, 2, closingTime),
  "9101": makeUser("9101", 111, 0, 1, 0n),
  "9201": makeUser("9201", 0, 2, 1, 0n),
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
    assert.strictEqual(packet.sequence, 94);
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
verifySpecifiedMigration();
verifyClosingRecovery();
verifyRestart();
validateManagedSchemas();

assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);
console.log(
  `[guild-master-migration-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  reject(recoveryHandler, users["8003"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(recoveryHandler, users["8003"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, Buffer.concat([recoveryRequest(88n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(recoveryHandler, users["8003"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, nonCanonical(recoveryRequest(88n)), ERRORS.INVALID_REQUEST, false);

  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, recoveryRequest(77n), ERRORS.INVALID_REQUEST, false);
  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, Buffer.concat([specifiedRequest(77n, 7002n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, Buffer.concat([writeSignedVarLong(77n), nonCanonical(writeSignedVarLong(7002n))]), ERRORS.INVALID_REQUEST, false);
}

function verifyFailures() {
  reject(recoveryHandler, users["9201"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, recoveryRequest(88n), ERRORS.NOT_A_MEMBER);
  reject(recoveryHandler, users["8003"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, recoveryRequest(77n), ERRORS.INVALID_GUILD_UID);
  reject(recoveryHandler, users["7001"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, recoveryRequest(77n), ERRORS.MASTER_MIGRATION_INVALID_TARGET);
  reject(recoveryHandler, users["7003"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, recoveryRequest(77n), ERRORS.MASTER_MIGRATION_INVALID_GUILD_STATE);
  reject(recoveryHandler, users["9002"], PACKETS.MASTER_MIGRATION_REQ, PACKETS.MASTER_MIGRATION_ACK, recoveryRequest(99n), ERRORS.MASTER_NOT_FOUND);

  reject(specifiedHandler, users["7002"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, specifiedRequest(77n, 7003n), ERRORS.NOT_MASTER);
  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, specifiedRequest(77n, 7001n), ERRORS.MASTER_MIGRATION_INVALID_TARGET);
  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, specifiedRequest(77n, 9101n), ERRORS.MASTER_MIGRATION_INVALID_TARGET);
  reject(specifiedHandler, users["7001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, specifiedRequest(77n, 7003n), ERRORS.MASTER_MIGRATION_INVALID_TARGET_GRADE);
  reject(specifiedHandler, users["8001"], PACKETS.MASTER_SPECIFIED_MIGRATION_REQ, PACKETS.MASTER_SPECIFIED_MIGRATION_ACK, specifiedRequest(88n, 8002n), ERRORS.MASTER_MIGRATION_INVALID_GUILD_STATE);
}

function verifySpecifiedMigration() {
  const beforePushes = pushes.length;
  const ack = invoke(
    specifiedHandler,
    users["7001"],
    PACKETS.MASTER_SPECIFIED_MIGRATION_REQ,
    PACKETS.MASTER_SPECIFIED_MIGRATION_ACK,
    specifiedRequest(77n, 7002n)
  );
  assert.deepStrictEqual(decodeMigrationAck(ack), {
    errorCode: 0,
    guildUid: 77n,
    oldMasterUserUid: 7001n,
    newMasterUserUid: 7002n,
  });
  assert.strictEqual(users["7001"].guildMemberGrade, 1);
  assert.strictEqual(users["7002"].guildMemberGrade, 0);
  assert.strictEqual(getGuildData(ctx, 77n).members[0], users["7002"]);
  const emitted = pushes.slice(beforePushes);
  const notices = emitted.filter((push) => push.packetId === PACKETS.MASTER_SPECIFIED_MIGRATION_NOT);
  const updates = emitted.filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT);
  assert.deepStrictEqual(notices.map((push) => push.userUid).sort(), ["7001", "7002", "7003"]);
  assert.deepStrictEqual(updates.map((push) => push.userUid).sort(), ["7001", "7002", "7003"]);
  for (const notice of notices) {
    assert.deepStrictEqual(decodeMigrationNot(notice.payload), {
      guildUid: 77n,
      oldMasterUserUid: 7001n,
      newMasterUserUid: 7002n,
    });
  }
}

function verifyClosingRecovery() {
  const beforePushes = pushes.length;
  const ack = invoke(
    recoveryHandler,
    users["8003"],
    PACKETS.MASTER_MIGRATION_REQ,
    PACKETS.MASTER_MIGRATION_ACK,
    recoveryRequest(88n)
  );
  assert.deepStrictEqual(decodeMigrationAck(ack), {
    errorCode: 0,
    guildUid: 88n,
    oldMasterUserUid: 8001n,
    newMasterUserUid: 8003n,
  });
  assert.strictEqual(users["8001"].guildMemberGrade, 2);
  assert.strictEqual(users["8003"].guildMemberGrade, 0);
  for (const user of [users["8001"], users["8002"], users["8003"]]) {
    assert.strictEqual(user.guildState, 1);
    assert.strictEqual(user.guildClosingTime, "0");
  }
  const guild = getGuildData(ctx, 88n);
  assert.strictEqual(guild.guildState, 1);
  assert.strictEqual(guild.closingTime, 0n);
  assert.strictEqual(guild.members[0], users["8003"]);
  const emitted = pushes.slice(beforePushes);
  assert.strictEqual(emitted.some((push) => push.packetId === PACKETS.MASTER_SPECIFIED_MIGRATION_NOT), false);
  assert.deepStrictEqual(
    emitted.filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT).map((push) => push.userUid).sort(),
    ["8001", "8002", "8003"]
  );
}

function verifyRestart() {
  const restarted = { ...ctx, userDb: JSON.parse(JSON.stringify(ctx.userDb)) };
  assert.strictEqual(restarted.userDb.users["7001"].guildMemberGrade, 1);
  assert.strictEqual(restarted.userDb.users["7002"].guildMemberGrade, 0);
  assert.strictEqual(restarted.userDb.users["8001"].guildMemberGrade, 2);
  assert.strictEqual(restarted.userDb.users["8003"].guildMemberGrade, 0);
  assert.strictEqual(getGuildData(restarted, 88n).guildState, 1);
  assert.strictEqual(getGuildData(restarted, 88n).closingTime, 0n);
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_MASTER_MIGRATION_REQ.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_MASTER_MIGRATION_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*oldMasterUserUid[\s\S]*newMasterUserUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_MASTER_SPECIFIED_MIGRATION_REQ.cs"), /guildUid[\s\S]*targetUserUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_MASTER_SPECIFIED_MIGRATION_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*oldMasterUserUid[\s\S]*newMasterUserUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_MASTER_SPECIFIED_MIGRATION_NOT.cs"), /guildUid[\s\S]*oldMasterUserUid[\s\S]*newMasterUserUid/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobby.cs"), /GuildState\.Closing[\s\S]*GuildMemberGrade\.Master[\s\S]*GUILD_CLOSE_CANCEL_REQ[\s\S]*GUILD_MASTER_MIGRATION_REQ/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCPopupGuildUserInfo.cs"), /m_btnGiveMaster[\s\S]*myData\.grade == GuildMemberGrade\.Master && userData\.grade == GuildMemberGrade\.Staff[\s\S]*GUILD_MASTER_SPECIFIED_MIGRATION_REQ/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_MASTER_SPECIFIED_MIGRATION_NOT[\s\S]*GET_STRING_CONSORTIUM_MEMBER_CHANGE_MASTER/);
}

function verifyConstants() {
  const common = readGameplayTable("ab_script", "LUA_COMMON_CONST.json");
  assert.deepStrictEqual(common.globals.Guild.MasterMigration, {
    ReceiverPrecondition_LoginDays: 15,
    AutoMigrationDuration_LoginDays: 15,
  });
  assert.deepStrictEqual(
    {
      INVALID_REQUEST: ERRORS.INVALID_REQUEST,
      INVALID_GUILD_UID: ERRORS.INVALID_GUILD_UID,
      NOT_A_MEMBER: ERRORS.NOT_A_MEMBER,
      INVALID_TARGET: ERRORS.MASTER_MIGRATION_INVALID_TARGET,
      INVALID_GUILD_STATE: ERRORS.MASTER_MIGRATION_INVALID_GUILD_STATE,
      MASTER_NOT_FOUND: ERRORS.MASTER_NOT_FOUND,
      DB_FAIL: ERRORS.MASTER_MIGRATION_DB_FAIL,
      INVALID_TARGET_GRADE: ERRORS.MASTER_MIGRATION_INVALID_TARGET_GRADE,
      NOT_MASTER: ERRORS.NOT_MASTER,
    },
    {
      INVALID_REQUEST: 20191,
      INVALID_GUILD_UID: 20432,
      NOT_A_MEMBER: 20443,
      INVALID_TARGET: 20452,
      INVALID_GUILD_STATE: 20453,
      MASTER_NOT_FOUND: 20454,
      DB_FAIL: 20455,
      INVALID_TARGET_GRADE: 20457,
      NOT_MASTER: 20616,
    }
  );
}

function invoke(handler, user, requestId, ackId, payload, canonical = true) {
  if (canonical) managedPackets.push([requestId, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: requestId, sequence: 94, payload }), true);
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

function decodeMigrationAck(payload) {
  const error = readSignedVarInt(payload, 0);
  let field = readSignedVarLong(payload, error.offset);
  const guildUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  const oldMasterUserUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode: error.value, guildUid, oldMasterUserUid, newMasterUserUid: field.value };
}

function decodeMigrationNot(payload) {
  let field = readSignedVarLong(payload, 0);
  const guildUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  const oldMasterUserUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { guildUid, oldMasterUserUid, newMasterUserUid: field.value };
}

function recoveryRequest(guildUid) {
  return writeSignedVarLong(guildUid);
}

function specifiedRequest(guildUid, targetUserUid) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(targetUserUid)]);
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
      assert(result.ok, `managed client schema rejected Guild master-migration packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, guildUid, grade, guildState, guildClosingTime) {
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
    guildName: guildUid > 0 ? `Guild${guildUid}` : "",
    guildBadgeId: guildUid > 0 ? String(guildUid + 300) : "0",
    guildJoinType: 1,
    guildState,
    guildClosingTime: String(guildClosingTime),
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
