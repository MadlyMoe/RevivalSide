"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  buildGuildDataUpdatedNotPayload,
  getGuildData,
  listRelatedGuilds,
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
const joinHandler = handlers.get(PACKETS.JOIN_REQ);
const cancelHandler = handlers.get(PACKETS.CANCEL_JOIN_REQ);
assert(joinHandler, "guild join specialist must be registered");
assert(cancelHandler, "guild cancel-join specialist must be registered");
assert.strictEqual(joinHandler.fileName, "modules\\company-buff\\handlers\\0000-3410-guild-join-req.js");
assert.strictEqual(cancelHandler.fileName, "modules\\company-buff\\handlers\\0000-3412-guild-cancel-join-req.js");

const now = new Date("2026-08-20T12:00:00.000Z");
const users = {
  "7001": makeUser("7001", { guildUid: 77, grade: 0, guildName: "Approval Guild", joinType: 1 }),
  "7002": makeUser("7002", { guildUid: 77, grade: 2, guildName: "Approval Guild", joinType: 1 }),
  "8001": makeUser("8001", { guildUid: 88, grade: 0, guildName: "Direct Guild", joinType: 0 }),
  "9001": makeUser("9001", { guildUid: 99, grade: 0, guildName: "Closed Guild", joinType: 2 }),
  "9801": makeUser("9801", { guildUid: 98, grade: 0, guildName: "Closing Guild", joinType: 0, guildState: 2 }),
  "5501": makeUser("5501", { guildUid: 55, grade: 0, guildName: "Busy Approval", joinType: 1 }),
  "6601": makeUser("6601", { guildUid: 66, grade: 0, guildName: "Full Direct", joinType: 0 }),
  "6100": makeUser("6100"),
  "6200": makeUser("6200"),
};
for (let index = 0; index < 30; index += 1) {
  users[String(5600 + index)] = makeUser(String(5600 + index), { guildJoinRequests: [55] });
}
for (let index = 1; index < 20; index += 1) {
  users[String(6601 + index)] = makeUser(String(6601 + index), { guildUid: 66, guildName: "Full Direct", joinType: 0 });
}

const online = new Map();
for (const userUid of ["7001", "7002", "8001"]) online.set(userUid, { session: { user: users[userUid] } });
const managedPackets = [];
const pushes = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  dateTimeBinaryNow() { return dateTimeBinaryForDate(now); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 75);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  sendServerGamePacket(socket, packetId, payload, label) {
    pushes.push({ userUid: socket.session.user.userUid, packetId, payload, label });
    managedPackets.push([packetId, payload]);
  },
  findClientSocketByUserUid(userUid) { return online.get(String(userUid)) || null; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(label) {
    assert(["guild-join", "guild-cancel-join"].includes(label));
    invalidations += 1;
  },
};

verifyFrozenSources();
verifyFailures();
verifyApprovalAndCancel();
verifyDirectJoin();
verifyRestart();
validateManagedSchemas();

console.log(
  `[guild-join-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyFailures() {
  joinRejects("empty", makeUser("10001"), Buffer.alloc(0), ERRORS.INVALID_REQUEST, 0n, false);
  joinRejects("trailing", makeUser("10002"), Buffer.concat([joinRequest(77n, 1), Buffer.from([0])]), ERRORS.INVALID_REQUEST, 0n, false);
  joinRejects("noncanonical uid", makeUser("10003"), Buffer.from([0x9a, 0x81, 0x00, 0x02]), ERRORS.INVALID_REQUEST, 0n, false);
  joinRejects("noncanonical enum", makeUser("10004"), Buffer.concat([writeSignedVarLong(77n), Buffer.from([0x82, 0x00])]), ERRORS.INVALID_REQUEST, 0n, false);
  joinRejects("invalid enum", makeUser("10005"), joinRequest(77n, 3), ERRORS.INVALID_REQUEST, 0n);
  joinRejects("zero uid", makeUser("10006"), joinRequest(0n, 0), ERRORS.INVALID_GUILD_UID, 0n);
  joinRejects("missing guild", makeUser("10007"), joinRequest(404n, 0), ERRORS.INVALID_GUILD_UID, 404n);
  joinRejects("already joined", makeUser("10008", { guildUid: 88 }), joinRequest(77n, 1), ERRORS.ALREADY_JOINED, 77n);
  joinRejects("stale join type", makeUser("10009"), joinRequest(77n, 0), ERRORS.INVALID_REQUEST, 77n);
  joinRejects("closed guild", makeUser("10010"), joinRequest(99n, 2), ERRORS.JOIN_DISABLED, 99n);
  joinRejects("closing guild", makeUser("10011"), joinRequest(98n, 0), ERRORS.JOIN_DISABLED, 98n);
  joinRejects("exit penalty", makeUser("10012", { guildJoinDisableTime: "2026-08-21T12:00:00.000Z" }), joinRequest(88n, 0), ERRORS.JOIN_DISABLE_PENALTY, 88n);
  joinRejects("already requested", makeUser("10013", { guildJoinRequests: [77] }), joinRequest(77n, 1), ERRORS.ALREADY_JOIN_REQUESTED, 77n);
  joinRejects("already invited", makeUser("10014", { guildInvites: [77] }), joinRequest(77n, 1), ERRORS.ALREADY_INVITED, 77n);
  joinRejects("outgoing request cap", makeUser("10015", { guildJoinRequests: [11, 12, 13] }), joinRequest(77n, 1), ERRORS.MAX_REQUEST_COUNT, 77n);
  joinRejects("incoming request cap", makeUser("10016"), joinRequest(55n, 1), ERRORS.MAX_REQUEST_RECEIVE_COUNT, 55n);
  joinRejects("member cap", makeUser("10017"), joinRequest(66n, 0), ERRORS.MAX_MEMBER_COUNT, 66n);

  cancelRejects("cancel empty", makeUser("10101"), Buffer.alloc(0), ERRORS.INVALID_REQUEST, 0n, false);
  cancelRejects("cancel trailing", makeUser("10102"), Buffer.concat([cancelRequest(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, 0n, false);
  cancelRejects("cancel zero", makeUser("10103"), cancelRequest(0n), ERRORS.INVALID_GUILD_UID, 0n);
  cancelRejects("cancel missing", makeUser("10104"), cancelRequest(77n), ERRORS.NOT_JOIN_REQUESTED, 77n);
}

function verifyApprovalAndCancel() {
  const applicant = users["6100"];
  const socket = { session: { user: applicant } };
  const beforePushes = pushes.length;
  managedPackets.push([PACKETS.JOIN_REQ, joinRequest(77n, 1)]);
  const ack = invoke(joinHandler, socket, PACKETS.JOIN_REQ, PACKETS.JOIN_ACK, joinRequest(77n, 1));
  const decoded = decodeJoinAck(ack);
  assert.deepStrictEqual([decoded.errorCode, decoded.needApproval, decoded.guildUid, decoded.privateGuildUid], [ERRORS.OK, true, 77n, 0n]);
  assert.deepStrictEqual(applicant.guildJoinRequests, ["77"]);
  assert.deepStrictEqual(listRelatedGuilds(ctx, applicant, 0).map((guild) => guild.guildUid), [77n]);
  assert.deepStrictEqual(getGuildData(ctx, 77n).joinWaitingList.map((user) => user.userUid), ["6100"]);
  assert.strictEqual(saves, 1);
  assert.strictEqual(invalidations, 1);
  const approvalPushes = pushes.slice(beforePushes);
  assert.deepStrictEqual(approvalPushes.map((push) => push.userUid), ["7001", "7002"]);
  assert(approvalPushes.every((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.label === "guild-join-data"));
  const expectedPush = buildGuildDataUpdatedNotPayload(getGuildData(ctx, 77n));
  assert(approvalPushes.every((push) => push.payload.equals(expectedPush)));

  joinRejects("duplicate approval", applicant, joinRequest(77n, 1), ERRORS.ALREADY_JOIN_REQUESTED, 77n);

  const cancelBeforePushes = pushes.length;
  managedPackets.push([PACKETS.CANCEL_JOIN_REQ, cancelRequest(77n)]);
  const cancelAck = invoke(cancelHandler, socket, PACKETS.CANCEL_JOIN_REQ, PACKETS.CANCEL_JOIN_ACK, cancelRequest(77n));
  const cancelled = decodeCancelAck(cancelAck);
  assert.deepStrictEqual(cancelled, { errorCode: ERRORS.OK, guildUid: 77n });
  assert.deepStrictEqual(applicant.guildJoinRequests, []);
  assert.deepStrictEqual(getGuildData(ctx, 77n).joinWaitingList, []);
  assert.strictEqual(saves, 2);
  assert.strictEqual(invalidations, 2);
  assert.deepStrictEqual(pushes.slice(cancelBeforePushes).map((push) => push.userUid), ["7001", "7002"]);
  cancelRejects("duplicate cancel", applicant, cancelRequest(77n), ERRORS.NOT_JOIN_REQUESTED, 77n);
}

function verifyDirectJoin() {
  const applicant = users["6200"];
  applicant.guildJoinRequests = [77];
  applicant.guildInvites = [99];
  const socket = { session: { user: applicant } };
  online.set(applicant.userUid, socket);
  const beforePushes = pushes.length;
  managedPackets.push([PACKETS.JOIN_REQ, joinRequest(88n, 0)]);
  const ack = invoke(joinHandler, socket, PACKETS.JOIN_REQ, PACKETS.JOIN_ACK, joinRequest(88n, 0));
  const decoded = decodeJoinAck(ack);
  assert.deepStrictEqual([decoded.errorCode, decoded.needApproval, decoded.guildUid, decoded.privateGuildUid], [ERRORS.OK, false, 88n, 88n]);
  assert.deepStrictEqual(
    [applicant.guildUid, applicant.guildName, applicant.guildMemberGrade, applicant.guildMemberCreatedAt],
    ["88", "Direct Guild", 2, now.toISOString()]
  );
  assert.deepStrictEqual(applicant.guildJoinRequests, []);
  assert.deepStrictEqual(applicant.guildInvites, []);
  assert.deepStrictEqual(getGuildData(ctx, 88n).members.map((member) => member.userUid), ["8001", "6200"]);
  assert.strictEqual(saves, 3);
  assert.strictEqual(invalidations, 3);
  const directPushes = pushes.slice(beforePushes);
  assert.deepStrictEqual(directPushes.map((push) => push.userUid), ["8001", "6200"]);
  assert(directPushes.every((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.label === "guild-join-data"));
  const expectedPush = buildGuildDataUpdatedNotPayload(getGuildData(ctx, 88n));
  assert(directPushes.every((push) => push.payload.equals(expectedPush)));
}

function verifyRestart() {
  const restarted = { userDb: { users: JSON.parse(JSON.stringify(users)) } };
  assert.deepStrictEqual(safe(getGuildData(restarted, 88n)), safe(getGuildData(ctx, 88n)));
  assert.strictEqual(restarted.userDb.users["6200"].guildUid, "88");
}

function joinRejects(name, user, payload, errorCode, guildUid, managed = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  if (managed) managedPackets.push([PACKETS.JOIN_REQ, payload]);
  const ack = invoke(joinHandler, { session: { user } }, PACKETS.JOIN_REQ, PACKETS.JOIN_ACK, payload);
  const decoded = decodeJoinAck(ack);
  assert.strictEqual(decoded.errorCode, errorCode, name);
  assert.strictEqual(decoded.needApproval, false, name);
  assert.strictEqual(decoded.guildUid, guildUid, name);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate`);
  assert.strictEqual(saves, beforeSaves, `${name} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${name} must not invalidate JOIN`);
  assert.strictEqual(pushes.length, beforePushes, `${name} must not push`);
}

function cancelRejects(name, user, payload, errorCode, guildUid, managed = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  if (managed) managedPackets.push([PACKETS.CANCEL_JOIN_REQ, payload]);
  const ack = invoke(cancelHandler, { session: { user } }, PACKETS.CANCEL_JOIN_REQ, PACKETS.CANCEL_JOIN_ACK, payload);
  assert.deepStrictEqual(decodeCancelAck(ack), { errorCode, guildUid }, name);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate`);
  assert.strictEqual(saves, beforeSaves, `${name} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${name} must not invalidate JOIN`);
  assert.strictEqual(pushes.length, beforePushes, `${name} must not push`);
}

function invoke(targetHandler, socket, requestId, ackId, payload) {
  assert.strictEqual(targetHandler.handle(ctx, socket, { packetId: requestId, sequence: 75, payload }), true);
  assert.strictEqual(socket.response.packetId, ackId);
  return socket.response.payload;
}

function decodeJoinAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  const needApproval = payload.readUInt8(field.offset) === 1;
  field = readSignedVarLong(payload, field.offset + 1);
  const guildUid = field.value;
  assert.strictEqual(payload.readUInt8(field.offset++), 1, "privateGuildData must be non-null");
  const privateGuildUid = readSignedVarLong(payload, field.offset);
  return { errorCode, needApproval, guildUid, privateGuildUid: privateGuildUid.value };
}

function decodeCancelAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, guildUid: field.value };
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_JOIN_REQ.cs"), /guildUid[\s\S]*guildJoinType/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_JOIN_ACK.cs"), /errorCode[\s\S]*needApproval[\s\S]*guildUid[\s\S]*privateGuildData/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CANCEL_JOIN_REQ.cs"), /guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CANCEL_JOIN_ACK.cs"), /errorCode[\s\S]*guildUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_DATA_UPDATED_NOT.cs"), /guildData/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_DATA_UPDATED_NOT[\s\S]*SetMyGuildData/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCGuildManager.cs"), /needApproval[\s\S]*Send_GUILD_LIST_REQ\(GuildListType\.SendRequest\)/);
  assert.match(source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_GUILD_ALREADY_JOIN_REQUESTED[\s\S]*NEC_FAIL_GUILD_NOT_JOIN_REQUESTED/);
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
      assert(result.ok, `managed client schema rejected guild join packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, options = {}) {
  const user = {
    userUid,
    friendCode: String(10000000 + Number(userUid)),
    nickname: options.nickname || `User${userUid}`,
    level: 50,
    guildUid: String(options.guildUid || 0),
    guildMemberGrade: options.grade == null ? 2 : options.grade,
    guildMemberCreatedAt: "2026-08-01T12:00:00.000Z",
    guildLevel: Number(options.level || 1),
    guildLevelExp: String(options.exp || 0),
    guildUnionPoint: "0",
    guildName: options.guildName || "",
    guildBadgeId: String(Number(options.guildUid || 0) + 300),
    guildJoinType: Number(options.joinType || 0),
    guildState: options.guildState == null ? 1 : options.guildState,
    lastLoginAt: "2026-08-20T11:00:00.000Z",
  };
  if (options.guildJoinRequests) user.guildJoinRequests = options.guildJoinRequests;
  if (options.guildInvites) user.guildInvites = options.guildInvites;
  if (options.guildJoinDisableTime) user.guildJoinDisableTime = String(dateTimeBinaryForDate(new Date(options.guildJoinDisableTime)));
  return user;
}

function joinRequest(guildUid, guildJoinType) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarInt(guildJoinType)]);
}

function cancelRequest(guildUid) {
  return writeSignedVarLong(guildUid);
}

function safe(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? String(entry) : entry));
}
