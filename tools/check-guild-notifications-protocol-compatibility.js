"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, sendGuildLobbyBootstrap } = require("../modules/company-buff");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const attendanceHandler = handlers.get(PACKETS.ATTENDANCE_REQ);
const exitHandler = handlers.get(PACKETS.EXIT_REQ);
assert(attendanceHandler && exitHandler);

const now = new Date("2026-08-21T12:00:00.000Z");
const nowBinary = dateTimeBinaryForDate(now);
const users = {
  8801: makeUser("8801", 77, 2),
  8802: makeUser("8802", 77, 0),
};
const online = new Map(Object.entries(users).map(([uid, user]) => [uid, { session: { user } }]));
const packets = [];
const pushes = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  dateTimeBinaryNow() { return nowBinary; },
  findClientSocketByUserUid(userUid) { return online.get(String(userUid)) || null; },
  sendGameResponse(socket, packet, packetId, payload) {
    socket.response = { packetId, payload };
    packets.push([packetId, payload]);
  },
  sendServerGamePacket(socket, packetId, payload, label) {
    pushes.push({ userUid: String(socket.session.user.userUid), packetId, payload, label });
    packets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

verifyFrozenSources();
verifyLevelUpNotification();
verifyProfileNotification();
verifyJoinDisableNotification();
assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);
validateManagedSchemas();

console.log(
  `[guild-notifications-check] PASS levelUps=2 profiles=1 disableTimes=1 saves=${saves} packets=${packets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyLevelUpNotification() {
  const payload = writeSignedVarLong(77n);
  packets.push([PACKETS.ATTENDANCE_REQ, payload]);
  const socket = online.get("8801");
  assert.strictEqual(attendanceHandler.handle(ctx, socket, { packetId: PACKETS.ATTENDANCE_REQ, sequence: 81, payload }), true);
  assert(socket.response && socket.response.packetId === PACKETS.ATTENDANCE_ACK);
  const levelUps = pushes.filter((push) => push.packetId === PACKETS.LEVEL_UP_NOT);
  assert.deepStrictEqual(levelUps.map((push) => push.userUid).sort(), ["8801", "8802"]);
  for (const push of levelUps) {
    let field = readSignedVarLong(push.payload, 0);
    assert.strictEqual(field.value, 77n);
    field = readSignedVarInt(push.payload, field.offset);
    assert.strictEqual(field.value, 2);
    field = readSignedVarLong(push.payload, field.offset);
    assert.strictEqual(field.value, 30n);
    field = readSignedVarLong(push.payload, field.offset);
    assert.strictEqual(field.value, 2030n);
    assert.strictEqual(push.payload.readBigInt64LE(field.offset), nowBinary);
    assert.strictEqual(field.offset + 8, push.payload.length);
  }
}

function verifyProfileNotification() {
  const before = pushes.length;
  assert.strictEqual(sendGuildLobbyBootstrap(ctx, online.get("8801"), users["8801"], "guild-notification-bootstrap"), true);
  const emitted = pushes.slice(before);
  assert.strictEqual(emitted[0].packetId, PACKETS.DATA_UPDATED_NOT);
  const profile = emitted.find((push) => push.packetId === PACKETS.USER_PROFILE_UPDATED_NOT);
  assert(profile && profile.userUid === "8802");
  assert.strictEqual(profile.payload.readBigInt64LE(profile.payload.length - 8), nowBinary);
}

function verifyJoinDisableNotification() {
  const before = pushes.length;
  const payload = writeSignedVarLong(77n);
  packets.push([PACKETS.EXIT_REQ, payload]);
  const socket = online.get("8801");
  assert.strictEqual(exitHandler.handle(ctx, socket, { packetId: PACKETS.EXIT_REQ, sequence: 81, payload }), true);
  assert(socket.response && socket.response.packetId === PACKETS.EXIT_ACK);
  const disable = pushes.slice(before).find((push) => push.packetId === PACKETS.JOIN_DISABLETIME_UPDATED_NOT);
  assert(disable && disable.userUid === "8801");
  assert.strictEqual(disable.payload.readBigInt64LE(0), dateTimeBinaryForDate(new Date("2026-08-22T12:00:00.000Z")));
  assert.strictEqual(disable.payload.length, 8);
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_LEVEL_UP_NOT.cs"), /guildUid[\s\S]*guildLevel[\s\S]*guildLevelExp[\s\S]*guildTotalExp[\s\S]*levelUpTime/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_USER_PROFILE_UPDATED_NOT.cs"), /commonProfile[\s\S]*lastOnlineTime/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_JOIN_DISABLETIME_UPDATED_NOT.cs"), /joinDisableTime/);
  const receiver = source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  assert.match(receiver, /GUILD_LEVEL_UP_NOT[\s\S]*GUILD_USER_PROFILE_UPDATED_NOT[\s\S]*GUILD_JOIN_DISABLETIME_UPDATED_NOT/);
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
    for (const [packetId, payload] of packets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Guild notification packet ${packetId}: ${result.error || "unknown error"}`);
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
    mainUnitId: 1001,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    guildUid: String(guildUid),
    guildMemberGrade: grade,
    guildMemberCreatedAt: "2026-08-01T12:00:00.000Z",
    guildLevel: 1,
    guildLevelExp: "1980",
    guildUnionPoint: "1000",
    guildName: `Guild${guildUid}`,
    guildBadgeId: String(guildUid + 300),
    guildJoinType: 1,
    guildState: 1,
    guildClosingTime: "0",
    guildJoinDisableTime: "0",
    guildJoinRequests: [],
    guildInvites: [],
    guildLastAttendanceDate: "0",
    guildAttendanceHistory: {},
    guildWeeklyContributionPoint: "0",
    guildTotalContributionPoint: "0",
    lastLoginAt: "2026-08-21T11:00:00.000Z",
  };
}
