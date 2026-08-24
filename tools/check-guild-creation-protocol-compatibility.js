"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  getGuildData,
  getGuildDirectory,
  loadTables,
  sendGuildLobbyBootstrap,
} = require("../modules/company-buff");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const createHandler = exactHandler(PACKETS.CREATE_REQ, "modules\\company-buff\\handlers\\0000-3400-guild-create-req.js");
const closeHandler = exactHandler(PACKETS.CLOSE_REQ, "modules\\company-buff\\handlers\\0000-3402-guild-close-req.js");
const cancelHandler = exactHandler(PACKETS.CLOSE_CANCEL_REQ, "modules\\company-buff\\handlers\\0000-3404-guild-close-cancel-req.js");

let now = new Date("2026-08-20T12:00:00.000Z");
const users = {
  "7001": makeUser("7001", { guildUid: 77, grade: 0, guildName: "ExistingGuild" }),
  "7002": makeUser("7002", { guildUid: 77, grade: 1, guildName: "ExistingGuild" }),
  "7101": makeUser("7101", { guildUid: 88, grade: 0, guildName: "OtherGuild" }),
  "8001": makeUser("8001", { level: 50, quartz: 5000 }),
  "8002": makeUser("8002", { level: 14, quartz: 5000 }),
  "8003": makeUser("8003", { level: 50, quartz: 999 }),
  "8004": makeUser("8004", { level: 50, quartz: 5000 }),
};
const online = new Map();
refreshOnline(users);
const managedPackets = [];
const pushes = [];
const missions = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { nextGuildUid: "100", users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 93);
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
  trackMissionEvent(user, type, count, metadata) { missions.push({ userUid: String(user.userUid), type, count, metadata }); },
};

verifyFrozenSources();
verifyConstants();
verifyStrictFraming();
verifyCreationFailures();
verifyCreationSuccess();
verifyClosureLifecycle();
verifyRestartedDeletion();
validateManagedSchemas();

assert.strictEqual(saves, 5);
assert.strictEqual(invalidations, 5);
assert.deepStrictEqual(missions, [{
  userUid: "8001",
  type: "USE_RESOURCE",
  count: 1000,
  metadata: { itemId: 101, resourceId: 101, value: 101 },
}]);
console.log(
  `[guild-creation-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} filters=${loadTables().guildNameFilterWords.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, Buffer.concat([createRequest("StrictGuild", 0, badge(1, 1, 1, 1), "Hello"), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, Buffer.concat([
    writeString("StrictGuild"),
    Buffer.from([0x80, 0x00]),
    writeSignedVarLong(badge(1, 1, 1, 1)),
    writeString("Hello"),
  ]), ERRORS.INVALID_REQUEST);
  reject(closeHandler, users["7001"], PACKETS.CLOSE_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
  reject(closeHandler, users["7001"], PACKETS.CLOSE_ACK, Buffer.concat([writeSignedVarLong(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
  reject(closeHandler, users["7001"], PACKETS.CLOSE_ACK, Buffer.from([0x9a, 0x81, 0x00]), ERRORS.INVALID_REQUEST);
  reject(cancelHandler, users["7001"], PACKETS.CLOSE_CANCEL_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
  reject(cancelHandler, users["7001"], PACKETS.CLOSE_CANCEL_ACK, Buffer.concat([writeSignedVarLong(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
}

function verifyCreationFailures() {
  reject(createHandler, users["7001"], PACKETS.CREATE_ACK, createRequest("AlreadyGuild", 0, badge(1, 1, 1, 1), ""), ERRORS.ALREADY_JOINED);
  reject(createHandler, users["8002"], PACKETS.CREATE_ACK, createRequest("LowLevel", 0, badge(1, 1, 1, 1), ""), ERRORS.CREATION_USER_LEVEL);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, createRequest("A", 0, badge(1, 1, 1, 1), ""), ERRORS.CREATION_INVALID_NAME);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, createRequest("Bad Name", 0, badge(1, 1, 1, 1), ""), ERRORS.CREATION_INVALID_NAME);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, createRequest("Hentai", 0, badge(1, 1, 1, 1), ""), ERRORS.CREATION_INVALID_NAME);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, createRequest("BadBadge", 0, badge(13, 1, 1, 1), ""), ERRORS.CREATION_INVALID_UID);
  reject(createHandler, users["8001"], PACKETS.CREATE_ACK, createRequest("BadGreeting", 0, badge(1, 1, 1, 1), "x".repeat(41)), ERRORS.INVALID_REQUEST);
  reject(createHandler, users["8003"], PACKETS.CREATE_ACK, createRequest("PoorGuild", 0, badge(1, 1, 1, 1), ""), ERRORS.INSUFFICIENT_RESOURCE);
}

function verifyCreationSuccess() {
  const beforePushes = pushes.length;
  const response = invoke(
    createHandler,
    users["8001"],
    PACKETS.CREATE_ACK,
    createRequest("RevivalOne", 1, badge(2, 3, 4, 5), "Frozen greeting")
  );
  const decoded = decodeCreateAckPrefix(response.payload);
  assert.deepStrictEqual(decoded, {
    errorCode: 0,
    costCount: 1,
    costItemId: 101,
    costFree: 4000n,
    costPaid: 0n,
    guildUid: 100n,
    name: "RevivalOne",
    badgeId: badge(2, 3, 4, 5),
    level: 1,
    exp: 0n,
    joinType: 1,
    state: 1,
    closingTime: 0n,
    greeting: "Frozen greeting",
    notice: "",
  });
  const creator = ctx.userDb.users["8001"];
  assert.strictEqual(creator.guildUid, "100");
  assert.strictEqual(creator.guildMemberGrade, 0);
  assert.strictEqual(creator.inventory.misc["101"].countFree, "4000");
  assert.strictEqual(creator.admin.posts.length, 1);
  assert.deepStrictEqual(creator.admin.posts[0].rewards[0], { rewardType: "RT_MISC", id: 101, count: 100 });
  assert.strictEqual(getGuildData(ctx, 100n).members.length, 1);
  assert.strictEqual(pushes.length, beforePushes);
  assert.strictEqual(saves, 1);
  assert.strictEqual(invalidations, 1);
  reject(createHandler, ctx.userDb.users["8004"], PACKETS.CREATE_ACK, createRequest("revivalone", 0, badge(1, 1, 1, 1), ""), ERRORS.CREATION_DUPLICATED_NAME);
}

function verifyClosureLifecycle() {
  reject(closeHandler, ctx.userDb.users["8004"], PACKETS.CLOSE_ACK, writeSignedVarLong(100n), ERRORS.NOT_A_MEMBER);
  reject(closeHandler, ctx.userDb.users["7101"], PACKETS.CLOSE_ACK, writeSignedVarLong(100n), ERRORS.INVALID_GUILD_UID);
  reject(closeHandler, ctx.userDb.users["7002"], PACKETS.CLOSE_ACK, writeSignedVarLong(77n), ERRORS.NOT_MASTER);

  const closePushes = pushes.length;
  const close = invoke(closeHandler, ctx.userDb.users["8001"], PACKETS.CLOSE_ACK, writeSignedVarLong(100n));
  assert.deepStrictEqual(decodeCloseAck(close.payload), {
    errorCode: 0,
    closingTime: dateTimeBinaryForDate(new Date("2026-08-22T12:00:00.000Z")),
  });
  assert.strictEqual(getGuildData(ctx, 100n).guildState, 2);
  assert.strictEqual(getGuildData(ctx, 100n).closingTime, dateTimeBinaryForDate(new Date("2026-08-22T12:00:00.000Z")));
  assert(pushes.slice(closePushes).some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === "8001"));
  reject(closeHandler, ctx.userDb.users["8001"], PACKETS.CLOSE_ACK, writeSignedVarLong(100n), ERRORS.CLOSE_INVALID_STATE);

  const cancelPushes = pushes.length;
  const cancel = invoke(cancelHandler, ctx.userDb.users["8001"], PACKETS.CLOSE_CANCEL_ACK, writeSignedVarLong(100n));
  assert.deepStrictEqual(decodeCancelAck(cancel.payload), { errorCode: 0 });
  assert.strictEqual(getGuildData(ctx, 100n).guildState, 1);
  assert.strictEqual(getGuildData(ctx, 100n).closingTime, 0n);
  assert(pushes.slice(cancelPushes).some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === "8001"));
  reject(cancelHandler, ctx.userDb.users["8001"], PACKETS.CLOSE_CANCEL_ACK, writeSignedVarLong(100n), ERRORS.CLOSE_INVALID_STATE);

  invoke(closeHandler, ctx.userDb.users["8001"], PACKETS.CLOSE_ACK, writeSignedVarLong(100n));
  assert.strictEqual(saves, 4);
  assert.strictEqual(invalidations, 4);
}

function verifyRestartedDeletion() {
  ctx.userDb.users["8004"].guildJoinRequests = ["100"];
  ctx.userDb.users["8004"].guildInvites = ["100"];
  ctx.userDb = JSON.parse(JSON.stringify(ctx.userDb));
  refreshOnline(ctx.userDb.users);
  now = new Date("2026-08-22T12:00:01.000Z");
  const creator = ctx.userDb.users["8001"];
  const socket = online.get("8001");
  const beforePushes = pushes.length;
  assert.strictEqual(sendGuildLobbyBootstrap(ctx, socket, creator, "restart-guild-bootstrap"), true);
  const emitted = pushes.slice(beforePushes);
  const deleted = emitted.find((push) => push.packetId === PACKETS.DELETED_NOT && push.userUid === "8001");
  assert(deleted, "expired guild deletion notification missing");
  assert.deepStrictEqual(decodeDeletedNot(deleted.payload), { guildUid: 100n });
  assert.strictEqual(creator.guildUid, "0");
  assert.strictEqual(creator.guildName, "");
  assert.strictEqual(creator.guildClosingTime, "0");
  assert.deepStrictEqual(ctx.userDb.users["8004"].guildJoinRequests, []);
  assert.deepStrictEqual(ctx.userDb.users["8004"].guildInvites, []);
  assert.strictEqual(getGuildData(ctx, 100n), null);
  assert.strictEqual(getGuildDirectory(ctx).some((guild) => guild.guildUid === 100n), false);
  assert.strictEqual(saves, 5);
  assert.strictEqual(invalidations, 5);
}

function createRequest(name, joinType, badgeId, greeting) {
  return Buffer.concat([
    writeString(name),
    writeSignedVarInt(joinType),
    writeSignedVarLong(badgeId),
    writeString(greeting),
  ]);
}

function badge(frameId, frameColorId, markId, markColorId) {
  return BigInt(`${String(frameId).padStart(3, "0")}${String(frameColorId).padStart(3, "0")}${String(markId).padStart(3, "0")}${String(markColorId).padStart(3, "0")}`);
}

function invoke(handler, user, ackPacketId, payload) {
  const socket = online.get(String(user && user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { sequence: 93, payload }), true);
  assert(socket.response, `missing ACK ${ackPacketId}`);
  assert.strictEqual(socket.response.packetId, ackPacketId);
  return socket.response;
}

function reject(handler, user, ackPacketId, payload, expectedError) {
  const before = JSON.stringify(ctx.userDb);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  const response = invoke(handler, user, ackPacketId, payload);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expectedError);
  assert.strictEqual(JSON.stringify(ctx.userDb), before);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(pushes.length, beforePushes);
}

function decodeCreateAckPrefix(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readVarInt(payload, field.offset);
  const costCount = field.value;
  let costItemId = 0;
  let costFree = 0n;
  let costPaid = 0n;
  for (let index = 0; index < costCount; index += 1) {
    const present = readBool(payload, field.offset);
    assert.strictEqual(present.value, true);
    field = readSignedVarInt(payload, present.offset);
    costItemId = field.value;
    field = readSignedVarLong(payload, field.offset);
    costFree = field.value;
    field = readSignedVarLong(payload, field.offset);
    costPaid = field.value;
    field = readSignedVarInt(payload, field.offset);
    field = { value: 0, offset: field.offset + 8 };
  }
  let present = readBool(payload, field.offset);
  assert.strictEqual(present.value, true);
  field = readSignedVarLong(payload, present.offset);
  const guildUid = field.value;
  field = readString(payload, field.offset);
  const name = field.value;
  field = readSignedVarLong(payload, field.offset);
  const badgeId = field.value;
  field = readSignedVarInt(payload, field.offset);
  const level = field.value;
  field = readSignedVarLong(payload, field.offset);
  const exp = field.value;
  field = readSignedVarInt(payload, field.offset);
  const joinType = field.value;
  field = readSignedVarInt(payload, field.offset);
  const state = field.value;
  const closingTime = payload.readBigInt64LE(field.offset);
  field = readString(payload, field.offset + 8);
  const greeting = field.value;
  field = readString(payload, field.offset);
  const notice = field.value;
  return { errorCode, costCount, costItemId, costFree, costPaid, guildUid, name, badgeId, level, exp, joinType, state, closingTime, greeting, notice };
}

function decodeCloseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  assert.strictEqual(error.offset + 8, payload.length);
  return { errorCode: error.value, closingTime: payload.readBigInt64LE(error.offset) };
}

function decodeCancelAck(payload) {
  const error = readSignedVarInt(payload, 0);
  assert.strictEqual(error.offset, payload.length);
  return { errorCode: error.value };
}

function decodeDeletedNot(payload) {
  const guildUid = readSignedVarLong(payload, 0);
  assert.strictEqual(guildUid.offset, payload.length);
  return { guildUid: guildUid.value };
}

function readVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    const byte = buffer.readUInt8(offset++);
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function exactHandler(packetId, fileName) {
  const handler = handlers.get(packetId);
  assert(handler, `specialist missing for ${packetId}`);
  assert.strictEqual(handler.fileName, fileName);
  return handler;
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CREATE_REQ.cs"), /guildName[\s\S]*guildJoinType[\s\S]*badgeId[\s\S]*greeting/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CREATE_ACK.cs"), /errorCode[\s\S]*costItemDataList[\s\S]*guildData[\s\S]*privateGuildData/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CLOSE_ACK.cs"), /errorCode[\s\S]*closingTime/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_DELETED_NOT.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildCreate.cs"), /CheckNameLength\(this\.m_GuildName, 2, 16\)[\s\S]*UserMinLevel[\s\S]*ReqMiscItems/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyManage.cs"), /guildState != GuildState\.Closing[\s\S]*guildState == GuildState\.Closing[\s\S]*Send_NKMPacket_GUILD_CLOSE_REQ[\s\S]*Send_NKMPacket_GUILD_CLOSE_CANCEL_REQ/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_DELETED_NOT[\s\S]*SetMyData\(new PrivateGuildData\(\)\)[\s\S]*SetMyGuildData\(null\)/);
}

function verifyConstants() {
  const tables = loadTables();
  assert.strictEqual(tables.guildConfig.creationUserMinLevel, 15);
  assert.deepStrictEqual(tables.guildConfig.creationCosts, [{ itemId: 101, count: 1000 }]);
  assert.strictEqual(tables.guildConfig.closingDelayHours, 48);
  assert.strictEqual(tables.guildBadgeFrameIds.size, 12);
  assert.strictEqual(tables.guildBadgeColorIds.size, 12);
  assert.strictEqual(tables.guildBadgeMarkIds.size, 12);
  assert(tables.guildNameFilterWords.includes("HENTAI"));
  assert.deepStrictEqual({
    INVALID_UID: ERRORS.CREATION_INVALID_UID,
    INVALID_NAME: ERRORS.CREATION_INVALID_NAME,
    USER_LEVEL: ERRORS.CREATION_USER_LEVEL,
    DUPLICATE: ERRORS.CREATION_DUPLICATED_NAME,
    CLOSE_STATE: ERRORS.CLOSE_INVALID_STATE,
  }, { INVALID_UID: 20435, INVALID_NAME: 20436, USER_LEVEL: 20437, DUPLICATE: 20442, CLOSE_STATE: 20477 });
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
      assert(result.ok, `managed client schema rejected Guild creation packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function refreshOnline(sourceUsers) {
  online.clear();
  for (const [userUid, user] of Object.entries(sourceUsers)) online.set(userUid, { session: { user } });
}

function makeUser(userUid, options = {}) {
  const guildUid = Number(options.guildUid || 0);
  return {
    userUid,
    friendCode: String(10000000 + Number(userUid)),
    nickname: `User${userUid}`,
    level: Number(options.level == null ? 50 : options.level),
    guildUid: String(guildUid),
    guildMemberGrade: Number(options.grade == null ? 2 : options.grade),
    guildMemberCreatedAt: guildUid > 0 ? "2026-08-01T12:00:00.000Z" : "",
    guildLevel: 1,
    guildLevelExp: "0",
    guildUnionPoint: "0",
    guildName: options.guildName || "",
    guildBadgeId: guildUid > 0 ? String(badge(1, 1, 1, 1)) : "0",
    guildJoinType: 0,
    guildState: 1,
    guildClosingTime: "0",
    guildGreeting: "",
    guildNotice: "",
    guildJoinDisableTime: "0",
    guildJoinRequests: [],
    guildInvites: [],
    guildLastAttendanceDate: "0",
    guildAttendanceHistory: [],
    guildWeeklyContributionPoint: 0,
    guildTotalContributionPoint: 0,
    inventory: {
      misc: {
        "101": { itemId: 101, countFree: String(options.quartz == null ? 5000 : options.quartz), countPaid: "0", bonusRatio: 0, regDate: "0" },
      },
      equips: {},
      skins: [],
    },
  };
}
