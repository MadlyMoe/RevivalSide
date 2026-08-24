"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  listRecommendedGuildInvites,
} = require("../modules/company-buff");
const { readSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.RECOMMEND_INVITE_LIST_REQ);
assert(handler, "Guild recommend-invite specialist missing");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3459-guild-recommend-invite-list-req.js");

const now = new Date("2026-08-20T12:00:00.000Z");
const users = {
  "7001": makeUser("7001", 77, 0, "2026-08-20T10:00:00.000Z"),
  "7002": makeUser("7002", 77, 1, "2026-08-20T09:00:00.000Z"),
  "7003": makeUser("7003", 77, 2, "2026-08-20T08:00:00.000Z"),
  "8001": makeUser("8001", 0, 2, "2026-08-20T11:30:00.000Z"),
  "8002": makeUser("8002", 0, 2, "2026-08-19T11:30:00.000Z"),
  "8101": makeUser("8101", 88, 0, "2026-08-20T11:45:00.000Z"),
  "8201": makeUser("8201", 0, 2, "2026-08-20T11:40:00.000Z", { guildInvites: ["77"] }),
  "8301": makeUser("8301", 0, 2, "2026-08-20T11:35:00.000Z", { guildJoinRequests: ["77"] }),
  "8401": makeUser("8401", 0, 2, "2026-08-20T11:50:00.000Z", { guildJoinDisableTime: String(dateTimeBinaryForDate(new Date("2026-08-21T12:00:00.000Z"))) }),
  "8501": makeUser("8501", 0, 2, "2026-08-20T11:25:00.000Z", { guildInvites: ["88"], guildJoinRequests: ["99"] }),
  "9901": makeUser("9901", 0, 2, "2026-08-20T07:00:00.000Z"),
};
const online = new Map(Object.entries(users).map(([uid, user]) => [uid, { session: { user } }]));
const managedPackets = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  dateTimeBinaryNow() { return dateTimeBinaryForDate(now); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 96);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

verifyFrozenSources();
verifyStrictFraming();
verifyFailures();
verifyRecommendation();
verifyRestart();
validateManagedSchemas();

assert.strictEqual(saves, 0);
assert.strictEqual(invalidations, 0);
console.log(
  `[guild-recommend-invite-check] PASS candidates=4 saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_RECOMMEND_INVITE_LIST_REQ.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_RECOMMEND_INVITE_LIST_ACK.cs"), /errorCode[\s\S]*List<FriendListData>/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCPopupGuildInvite.cs"), /GUILD_RECOMMEND_INVITE_LIST_REQ[\s\S]*OnRecv\(List<FriendListData> list\)/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyMember.cs"), /m_btnInvite[\s\S]*grade != GuildMemberGrade\.Member/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /GUILD_RECOMMEND_INVITE_LIST_ACK[\s\S]*OnRecv\(cNKMPacket_GUILD_RECOMMEND_INVITE_LIST_ACK\.list\)/);
}

function verifyStrictFraming() {
  reject(users["7001"], Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(users["7001"], Buffer.concat([request(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(users["7001"], Buffer.from([0x9a, 0x81, 0x00]), ERRORS.INVALID_REQUEST, false);
}

function verifyFailures() {
  reject(users["9901"], request(77n), ERRORS.NOT_A_MEMBER);
  reject(users["7001"], request(88n), ERRORS.INVALID_GUILD_UID);
  reject(users["7003"], request(77n), ERRORS.NOT_ENOUGH_GRADE);
}

function verifyRecommendation() {
  const before = JSON.stringify(users);
  const result = listRecommendedGuildInvites(ctx, users["7001"], 77n);
  assert.strictEqual(result.errorCode, 0);
  assert.deepStrictEqual(result.list.map((user) => String(user.userUid)), ["8001", "8501", "9901", "8002"]);
  const ack = invoke(users["7001"], request(77n));
  const error = readSignedVarInt(ack, 0);
  assert.strictEqual(error.value, 0);
  assert.strictEqual(ack.readUInt8(error.offset), 4);
  assert.strictEqual(JSON.stringify(users), before);
}

function verifyRestart() {
  const restarted = { ...ctx, userDb: JSON.parse(JSON.stringify(ctx.userDb)) };
  assert.deepStrictEqual(
    listRecommendedGuildInvites(restarted, restarted.userDb.users["7002"], 77n).list.map((user) => String(user.userUid)),
    ["8001", "8501", "9901", "8002"]
  );
}

function invoke(user, payload, canonical = true) {
  if (canonical) managedPackets.push([PACKETS.RECOMMEND_INVITE_LIST_REQ, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.RECOMMEND_INVITE_LIST_REQ, sequence: 96, payload }), true);
  assert(socket.response && socket.response.packetId === PACKETS.RECOMMEND_INVITE_LIST_ACK);
  return socket.response.payload;
}

function reject(user, payload, expectedError, canonical = true) {
  const before = JSON.stringify(users);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const ack = invoke(user, payload, canonical);
  assert.strictEqual(readSignedVarInt(ack, 0).value, expectedError);
  assert.strictEqual(JSON.stringify(users), before);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
}

function request(guildUid) {
  return writeSignedVarLong(guildUid);
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
      assert(result.ok, `managed client schema rejected Guild recommend-invite packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, guildUid, grade, lastLoginAt, overrides = {}) {
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
    guildState: 1,
    guildClosingTime: "0",
    guildJoinDisableTime: "0",
    guildJoinRequests: [],
    guildInvites: [],
    guildLastAttendanceDate: "0",
    guildAttendanceHistory: [],
    guildWeeklyContributionPoint: 0,
    guildTotalContributionPoint: 0,
    lastLoginAt,
    ...overrides,
  };
}
