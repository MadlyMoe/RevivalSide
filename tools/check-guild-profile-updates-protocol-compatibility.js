"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  getGuildData,
} = require("../modules/company-buff");
const {
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const dataHandler = exactHandler(PACKETS.UPDATE_DATA_REQ, "modules\\company-buff\\handlers\\0000-3441-guild-update-data-req.js");
const noticeHandler = exactHandler(PACKETS.UPDATE_NOTICE_REQ, "modules\\company-buff\\handlers\\0000-3443-guild-update-notice-req.js");
const greetingHandler = exactHandler(PACKETS.UPDATE_MEMBER_GREETING_REQ, "modules\\company-buff\\handlers\\0000-3445-guild-update-member-greeting-req.js");

let now = new Date("2026-08-20T12:00:00.000Z");
const users = {
  "7001": makeUser("7001", 77, 0),
  "7002": makeUser("7002", 77, 1),
  "7003": makeUser("7003", 77, 2),
  "7999": makeUser("7999", 0, 2),
  "8001": makeUser("8001", 88, 0),
  "9001": makeUser("9001", 0, 2),
};
users["7999"].guildJoinRequests = ["77"];
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
verifyDataFailures();
verifyDataUpdate();
verifyNoticeFailures();
verifyNoticeUpdate();
verifyMemberGreeting();
verifyRestart();
validateManagedSchemas();

assert.strictEqual(saves, 3);
assert.strictEqual(invalidations, 3);
console.log(
  `[guild-profile-updates-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, Buffer.concat([dataRequest(77n, "Welcome", 1, badge(1, 1, 1, 1), 0), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, Buffer.concat([writeSignedVarLong(77n), writeString("Welcome"), nonCanonical(writeSignedVarInt(1)), writeSignedVarLong(badge(1, 1, 1, 1)), writeSignedVarInt(0)]), ERRORS.INVALID_REQUEST, false);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, dataRequest(77n, "Welcome", 3, badge(1, 1, 1, 1), 0), ERRORS.INVALID_REQUEST, false);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, dataRequest(77n, "Welcome", 1, badge(1, 1, 1, 1), 2), ERRORS.INVALID_REQUEST, false);

  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, Buffer.concat([textRequest(77n, "Notice"), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, Buffer.concat([nonCanonical(writeSignedVarLong(77n)), writeString("Notice")]), ERRORS.INVALID_REQUEST, false);
  reject(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, Buffer.concat([textRequest(77n, "Hi"), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
}

function verifyDataFailures() {
  const request = dataRequest(77n, "Welcome", 1, badge(1, 1, 1, 1), 0);
  reject(dataHandler, users["9001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, request, ERRORS.NOT_A_MEMBER);
  reject(dataHandler, users["8001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, request, ERRORS.INVALID_GUILD_UID);
  reject(dataHandler, users["7002"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, request, ERRORS.NOT_MASTER);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, dataRequest(77n, "x".repeat(41), 1, badge(1, 1, 1, 1), 0), ERRORS.INVALID_REQUEST);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, dataRequest(77n, "Welcome", 1, badge(13, 1, 1, 1), 0), ERRORS.CREATION_INVALID_UID);
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, dataRequest(77n, "Welcome", 2, badge(1, 1, 1, 1), 0), ERRORS.JOIN_REQUEST_EXIST);
  users["7001"].guildGreetingMuted = true;
  reject(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, request, ERRORS.GUILD_GREETING_MUTE);
  users["7001"].guildGreetingMuted = false;
}

function verifyDataUpdate() {
  users["7999"].guildJoinRequests = [];
  const beforePushes = pushes.length;
  const payload = dataRequest(77n, "Frozen welcome", 2, badge(2, 3, 4, 5), 1);
  const ack = invoke(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, payload);
  assert.deepStrictEqual(decodeDataAck(ack), {
    errorCode: 0,
    guildUid: 77n,
    greetingBefore: "Old greeting",
    greeting: "Frozen welcome",
    guildJoinType: 2,
    badgeId: badge(2, 3, 4, 5),
    chatNoticeType: 1,
  });
  const guild = getGuildData(ctx, 77n);
  assert.strictEqual(guild.greeting, "Frozen welcome");
  assert.strictEqual(guild.guildJoinType, 2);
  assert.strictEqual(guild.badgeId, badge(2, 3, 4, 5));
  assert.strictEqual(guild.chatNoticeType, 1);
  assert.deepStrictEqual(pushes.slice(beforePushes).filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT).map((push) => push.userUid).sort(), ["7001", "7002", "7003"]);

  const beforeSaves = saves;
  const beforeNoOpPushes = pushes.length;
  assert.strictEqual(decodeDataAck(invoke(dataHandler, users["7001"], PACKETS.UPDATE_DATA_REQ, PACKETS.UPDATE_DATA_ACK, payload)).errorCode, 0);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(pushes.length, beforeNoOpPushes);
}

function verifyNoticeFailures() {
  reject(noticeHandler, users["7003"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "Member notice"), ERRORS.NOT_ENOUGH_GRADE);
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(88n, "Wrong guild"), ERRORS.INVALID_GUILD_UID);
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "   "), ERRORS.INVALID_REQUEST);
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "x".repeat(37)), ERRORS.INVALID_REQUEST);
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "line\nbreak"), ERRORS.INVALID_REQUEST);
  users["7002"].guildNoticeMuted = true;
  reject(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "Muted notice"), ERRORS.GUILD_NOTICE_MUTE);
  users["7002"].guildNoticeMuted = false;
}

function verifyNoticeUpdate() {
  const beforePushes = pushes.length;
  const ack = invoke(noticeHandler, users["7002"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "Frozen notice"));
  assert.deepStrictEqual(decodeNoticeAck(ack), {
    errorCode: 0,
    guildUid: 77n,
    noticeBefore: "Old notice",
    notice: "Frozen notice",
  });
  assert.strictEqual(getGuildData(ctx, 77n).notice, "Frozen notice");
  const emitted = pushes.slice(beforePushes);
  assert.deepStrictEqual(emitted.filter((push) => push.packetId === PACKETS.UPDATE_NOTICE_NOT).map((push) => push.userUid).sort(), ["7001", "7003"]);
  assert.deepStrictEqual(emitted.filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT).map((push) => push.userUid).sort(), ["7001", "7002", "7003"]);
  for (const notification of emitted.filter((push) => push.packetId === PACKETS.UPDATE_NOTICE_NOT)) {
    assert.deepStrictEqual(decodeNoticeNot(notification.payload), { guildUid: 77n, notice: "Frozen notice" });
  }
  reject(noticeHandler, users["7001"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "Too soon"), ERRORS.GUILD_UPDATE_NOTICE);
  now = new Date("2026-08-20T12:01:01.000Z");
  reject(noticeHandler, users["7001"], PACKETS.UPDATE_NOTICE_REQ, PACKETS.UPDATE_NOTICE_ACK, textRequest(77n, "Frozen notice"), ERRORS.GUILD_UPDATE_NOTICE);
}

function verifyMemberGreeting() {
  reject(greetingHandler, users["9001"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(77n, "Hello"), ERRORS.NOT_A_MEMBER);
  reject(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(88n, "Hello"), ERRORS.INVALID_GUILD_UID);
  reject(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(77n, "x".repeat(14)), ERRORS.INVALID_REQUEST);
  reject(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(77n, "line\nbreak"), ERRORS.INVALID_REQUEST);
  users["7003"].guildMemberGreetingMuted = true;
  reject(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(77n, "Muted"), ERRORS.GUILD_MEMBER_GREETING_MUTE);
  users["7003"].guildMemberGreetingMuted = false;

  const beforePushes = pushes.length;
  const ack = invoke(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(77n, "Ready!"));
  assert.deepStrictEqual(decodeGreetingAck(ack), { errorCode: 0, greeting: "Ready!" });
  assert.strictEqual(users["7003"].guildMemberGreeting, "Ready!");
  assert.deepStrictEqual(pushes.slice(beforePushes).filter((push) => push.packetId === PACKETS.DATA_UPDATED_NOT).map((push) => push.userUid).sort(), ["7001", "7002", "7003"]);

  const beforeSaves = saves;
  const beforeNoOpPushes = pushes.length;
  assert.deepStrictEqual(decodeGreetingAck(invoke(greetingHandler, users["7003"], PACKETS.UPDATE_MEMBER_GREETING_REQ, PACKETS.UPDATE_MEMBER_GREETING_ACK, textRequest(77n, "Ready!"))), { errorCode: 0, greeting: "Ready!" });
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(pushes.length, beforeNoOpPushes);
}

function verifyRestart() {
  const restarted = { ...ctx, userDb: JSON.parse(JSON.stringify(ctx.userDb)) };
  const guild = getGuildData(restarted, 77n);
  assert.strictEqual(guild.greeting, "Frozen welcome");
  assert.strictEqual(guild.notice, "Frozen notice");
  assert.strictEqual(guild.guildJoinType, 2);
  assert.strictEqual(guild.chatNoticeType, 1);
  assert.strictEqual(restarted.userDb.users["7003"].guildMemberGreeting, "Ready!");
  assert.strictEqual(restarted.userDb.users["7001"].guildNoticeChangedAt, "2026-08-20T12:00:00.000Z");
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_DATA_REQ.cs"), /guildUid[\s\S]*greeting[\s\S]*guildJoinType[\s\S]*badgeId[\s\S]*chatNoticeType/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_DATA_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*greetingBefore[\s\S]*greeting[\s\S]*guildJoinType[\s\S]*badgeId[\s\S]*chatNoticeType/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_NOTICE_REQ.cs"), /guildUid[\s\S]*notice/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_NOTICE_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*noticeBefore[\s\S]*notice/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_MEMBER_GREETING_REQ.cs"), /guildUid[\s\S]*greeting/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_MEMBER_GREETING_ACK.cs"), /errorCode[\s\S]*greeting/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_UPDATE_NOTICE_NOT.cs"), /guildUid[\s\S]*notice/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyManage.cs"), /characterLimit = 40[\s\S]*GUILD_UPDATE_DATA_REQ/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyInfo.cs"), /characterLimit = 36[\s\S]*myGrade != GuildMemberGrade\.Member[\s\S]*myGrade == GuildMemberGrade\.Master[\s\S]*GuildTemplet\.NoticeCooltime/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyMember.cs"), /OnClickEditMyComment[\s\S]*false, 13\)[\s\S]*GUILD_UPDATE_MEMBER_GREETING_REQ/);
  assert.match(source("Assembly-CSharp", "NKM", "Guild", "GuildTemplet.cs"), /NoticeCooltime = TimeSpan\.FromMinutes\(1\.0\)/);
}

function verifyConstants() {
  assert.deepStrictEqual(
    {
      INVALID_REQUEST: ERRORS.INVALID_REQUEST,
      INVALID_GUILD_UID: ERRORS.INVALID_GUILD_UID,
      CREATION_INVALID_UID: ERRORS.CREATION_INVALID_UID,
      NOT_A_MEMBER: ERRORS.NOT_A_MEMBER,
      JOIN_REQUEST_EXIST: ERRORS.JOIN_REQUEST_EXIST,
      NOT_ENOUGH_GRADE: ERRORS.NOT_ENOUGH_GRADE,
      GREETING_MUTE: ERRORS.GUILD_GREETING_MUTE,
      MEMBER_GREETING_MUTE: ERRORS.GUILD_MEMBER_GREETING_MUTE,
      NOT_MASTER: ERRORS.NOT_MASTER,
      UPDATE_NOTICE: ERRORS.GUILD_UPDATE_NOTICE,
      NOTICE_MUTE: ERRORS.GUILD_NOTICE_MUTE,
    },
    {
      INVALID_REQUEST: 20191,
      INVALID_GUILD_UID: 20432,
      CREATION_INVALID_UID: 20435,
      NOT_A_MEMBER: 20443,
      JOIN_REQUEST_EXIST: 20478,
      NOT_ENOUGH_GRADE: 20480,
      GREETING_MUTE: 20614,
      MEMBER_GREETING_MUTE: 20615,
      NOT_MASTER: 20616,
      UPDATE_NOTICE: 20617,
      NOTICE_MUTE: 20618,
    }
  );
}

function invoke(handler, user, requestId, ackId, payload, canonical = true) {
  if (canonical) managedPackets.push([requestId, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: requestId, sequence: 95, payload }), true);
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

function decodeDataAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readString(payload, field.offset);
  const greetingBefore = field.value;
  field = readString(payload, field.offset);
  const greeting = field.value;
  field = readSignedVarInt(payload, field.offset);
  const guildJoinType = field.value;
  field = readSignedVarLong(payload, field.offset);
  const badgeId = field.value;
  field = readSignedVarInt(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, guildUid, greetingBefore, greeting, guildJoinType, badgeId, chatNoticeType: field.value };
}

function decodeNoticeAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readString(payload, field.offset);
  const noticeBefore = field.value;
  field = readString(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, guildUid, noticeBefore, notice: field.value };
}

function decodeGreetingAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readString(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, greeting: field.value };
}

function decodeNoticeNot(payload) {
  let field = readSignedVarLong(payload, 0);
  const guildUid = field.value;
  field = readString(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { guildUid, notice: field.value };
}

function dataRequest(guildUid, greeting, guildJoinType, badgeId, chatNoticeType) {
  return Buffer.concat([
    writeSignedVarLong(guildUid),
    writeString(greeting),
    writeSignedVarInt(guildJoinType),
    writeSignedVarLong(badgeId),
    writeSignedVarInt(chatNoticeType),
  ]);
}

function textRequest(guildUid, text) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeString(text)]);
}

function badge(frameId, frameColorId, markId, markColorId) {
  return BigInt(`${String(frameId).padStart(3, "0")}${String(frameColorId).padStart(3, "0")}${String(markId).padStart(3, "0")}${String(markColorId).padStart(3, "0")}`);
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
      assert(result.ok, `managed client schema rejected Guild profile-update packet ${packetId}: ${result.error || "unknown error"}`);
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
    guildMemberGreeting: "Old intro",
    guildLevel: 3,
    guildLevelExp: "0",
    guildUnionPoint: "1000",
    guildName: guildUid > 0 ? `Guild${guildUid}` : "",
    guildBadgeId: guildUid > 0 ? String(badge(1, 1, 1, 1)) : "0",
    guildJoinType: 1,
    guildState: 1,
    guildClosingTime: "0",
    guildGreeting: "Old greeting",
    guildNotice: "Old notice",
    guildChatNoticeType: 0,
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
