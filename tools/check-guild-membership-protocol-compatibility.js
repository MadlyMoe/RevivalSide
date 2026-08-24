"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  buildGuildDataUpdatedNotPayload,
  buildPrivateGuildData,
  getGuildData,
  sendGuildLobbyBootstrap,
} = require("../modules/company-buff");
const {
  readBool,
  readInt64LE,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeBool,
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
const acceptJoinHandler = exactHandler(PACKETS.ACCEPT_JOIN_REQ, "modules\\company-buff\\handlers\\0000-3417-guild-accept-join-req.js");
const inviteHandler = exactHandler(PACKETS.INVITE_REQ, "modules\\company-buff\\handlers\\0000-3420-guild-invite-req.js");
const cancelInviteHandler = exactHandler(PACKETS.CANCEL_INVITE_REQ, "modules\\company-buff\\handlers\\0000-3423-guild-cancel-invite-req.js");
const acceptInviteHandler = exactHandler(PACKETS.ACCEPT_INVITE_REQ, "modules\\company-buff\\handlers\\0000-3426-guild-accept-invite-req.js");

const now = new Date("2026-08-20T12:00:00.000Z");
const users = {
  "7001": makeUser("7001", { guildUid: 77, grade: 0, guildName: "Approval Guild", joinType: 1, level: 3 }),
  "7002": makeUser("7002", { guildUid: 77, grade: 1, guildName: "Approval Guild", joinType: 1, level: 3 }),
  "7003": makeUser("7003", { guildUid: 77, grade: 2, guildName: "Approval Guild", joinType: 1, level: 3 }),
  "8001": makeUser("8001", { guildUid: 88, grade: 0, guildName: "Other Guild" }),
  "6100": makeUser("6100", { guildJoinRequests: [77] }),
  "6101": makeUser("6101", { guildJoinRequests: [77] }),
  "6200": makeUser("6200"),
  "6201": makeUser("6201"),
  "6300": makeUser("6300", { guildInvites: [77] }),
  "6301": makeUser("6301", { guildInvites: [77] }),
  "6500": makeUser("6500"),
};
for (let index = 0; index < 30; index += 1) {
  const uid = String(8400 + index);
  users[uid] = makeUser(uid, { guildInvites: [88] });
}
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
  dateTimeBinaryNow() { return dateTimeBinaryForDate(now); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 91);
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
verifyStrictFailures();
verifyJoinApprovalLifecycle();
verifyInviteLifecycle();
verifyInviteDecisionLifecycle();
verifyJoinHydrationAndRestart();
validateManagedSchemas();

console.log(
  `[guild-membership-check] PASS saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFailures() {
  reject(acceptJoinHandler, users["7001"], PACKETS.ACCEPT_JOIN_REQ, PACKETS.ACCEPT_JOIN_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
  reject(acceptJoinHandler, users["7001"], PACKETS.ACCEPT_JOIN_REQ, PACKETS.ACCEPT_JOIN_ACK, Buffer.concat([acceptJoinRequest(77n, 6100n, true), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
  reject(acceptJoinHandler, users["7001"], PACKETS.ACCEPT_JOIN_REQ, PACKETS.ACCEPT_JOIN_ACK, Buffer.concat([writeSignedVarLong(77n), writeSignedVarLong(6100n), Buffer.from([2])]), ERRORS.INVALID_REQUEST);
  reject(acceptJoinHandler, users["7003"], PACKETS.ACCEPT_JOIN_REQ, PACKETS.ACCEPT_JOIN_ACK, acceptJoinRequest(77n, 6100n, true), ERRORS.ACCEPT_NO_PERMISSION);
  reject(inviteHandler, users["7003"], PACKETS.INVITE_REQ, PACKETS.INVITE_ACK, inviteRequest(77n, 6200n), ERRORS.NOT_ENOUGH_GRADE);
  reject(inviteHandler, users["7001"], PACKETS.INVITE_REQ, PACKETS.INVITE_ACK, inviteRequest(77n, 8001n), ERRORS.INVITE_USER_IN_OTHER_GUILD);
  reject(inviteHandler, users["7001"], PACKETS.INVITE_REQ, PACKETS.INVITE_ACK, inviteRequest(77n, 6100n), ERRORS.JOIN_REQUEST_EXIST);
  reject(inviteHandler, users["8001"], PACKETS.INVITE_REQ, PACKETS.INVITE_ACK, inviteRequest(88n, 6500n), ERRORS.MAX_INVITE_COUNT);
  reject(cancelInviteHandler, users["7001"], PACKETS.CANCEL_INVITE_REQ, PACKETS.CANCEL_INVITE_ACK, inviteRequest(77n, 6200n), ERRORS.INVITE_DATA_NOT_FOUND);
  reject(acceptInviteHandler, users["6200"], PACKETS.ACCEPT_INVITE_REQ, PACKETS.ACCEPT_INVITE_ACK, acceptInviteRequest(77n, true), ERRORS.INVITE_DATA_NOT_FOUND);
}

function verifyJoinApprovalLifecycle() {
  const beforePushes = pushes.length;
  const ack = invoke(acceptJoinHandler, users["7001"], PACKETS.ACCEPT_JOIN_REQ, PACKETS.ACCEPT_JOIN_ACK, acceptJoinRequest(77n, 6100n, true));
  assert.deepStrictEqual(decodeAcceptJoinAck(ack), { errorCode: 0, isAllow: true, guildUid: 77n, userUid: 6100n });
  assert.strictEqual(users["6100"].guildUid, "77");
  assert.deepStrictEqual(users["6100"].guildJoinRequests, []);
  verifyFirstJoinReward(users["6100"]);
  const emitted = pushes.slice(beforePushes);
  const resultNot = emitted.find((push) => push.userUid === "6100" && push.packetId === PACKETS.ACCEPT_JOIN_NOT);
  assert(resultNot, "accepted applicant must receive GUILD_ACCEPT_JOIN_NOT");
  assert.deepStrictEqual(decodeAcceptJoinNot(resultNot.payload), { isAllow: true, guildUid: 77n, guildName: "Approval Guild", privateGuildUid: 77n });
  assert(emitted.some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === "7001"));
  assert(emitted.some((push) => push.packetId === PACKETS.DATA_UPDATED_NOT && push.userUid === "6100"));

  const denyBefore = pushes.length;
  const deny = invoke(acceptJoinHandler, users["7002"], PACKETS.ACCEPT_JOIN_REQ, PACKETS.ACCEPT_JOIN_ACK, acceptJoinRequest(77n, 6101n, false));
  assert.deepStrictEqual(decodeAcceptJoinAck(deny), { errorCode: 0, isAllow: false, guildUid: 77n, userUid: 6101n });
  assert.strictEqual(users["6101"].guildUid, "0");
  assert.deepStrictEqual(users["6101"].guildJoinRequests, []);
  const deniedNot = pushes.slice(denyBefore).find((push) => push.userUid === "6101" && push.packetId === PACKETS.ACCEPT_JOIN_NOT);
  assert.deepStrictEqual(decodeAcceptJoinNot(deniedNot.payload), { isAllow: false, guildUid: 77n, guildName: "Approval Guild", privateGuildUid: 0n });
}

function verifyInviteLifecycle() {
  const before = pushes.length;
  const inviteAck = invoke(inviteHandler, users["7001"], PACKETS.INVITE_REQ, PACKETS.INVITE_ACK, inviteRequest(77n, 6200n));
  assert.deepStrictEqual(decodeUidAck(inviteAck), { errorCode: 0, userUid: 6200n });
  assert.deepStrictEqual(users["6200"].guildInvites, ["77"]);
  assert(pushes.slice(before).some((push) => push.userUid === "6200" && push.packetId === PACKETS.INVITE_NOT && readSignedVarLong(push.payload, 0).value === 77n));

  const cancelBefore = pushes.length;
  const cancelAck = invoke(cancelInviteHandler, users["7002"], PACKETS.CANCEL_INVITE_REQ, PACKETS.CANCEL_INVITE_ACK, inviteRequest(77n, 6200n));
  assert.deepStrictEqual(decodeUidAck(cancelAck), { errorCode: 0, userUid: 6200n });
  assert.deepStrictEqual(users["6200"].guildInvites, []);
  const cancelNot = pushes.slice(cancelBefore).find((push) => push.userUid === "6200" && push.packetId === PACKETS.CANCEL_REQUEST_NOT);
  assert(cancelNot);
  assert.deepStrictEqual(decodeCancelNot(cancelNot.payload), { guildUid: 77n, isRequest: false });
}

function verifyInviteDecisionLifecycle() {
  const reject = invoke(acceptInviteHandler, users["6300"], PACKETS.ACCEPT_INVITE_REQ, PACKETS.ACCEPT_INVITE_ACK, acceptInviteRequest(77n, false));
  assert.deepStrictEqual(decodeAcceptInviteAck(reject), { errorCode: 0, isAllow: false, guildUid: 77n, privateGuildUid: 0n });
  assert.deepStrictEqual(users["6300"].guildInvites, []);

  const accept = invoke(acceptInviteHandler, users["6301"], PACKETS.ACCEPT_INVITE_REQ, PACKETS.ACCEPT_INVITE_ACK, acceptInviteRequest(77n, true));
  assert.deepStrictEqual(decodeAcceptInviteAck(accept), { errorCode: 0, isAllow: true, guildUid: 77n, privateGuildUid: 77n });
  assert.strictEqual(users["6301"].guildUid, "77");
  assert.deepStrictEqual(users["6301"].guildInvites, []);
  verifyFirstJoinReward(users["6301"]);
}

function verifyJoinHydrationAndRestart() {
  const privateData = buildPrivateGuildData(ctx, users["6100"]);
  assert.strictEqual(readSignedVarLong(privateData, 0).value, 77n);
  const socket = online.get("6100");
  const before = pushes.length;
  assert.strictEqual(sendGuildLobbyBootstrap(ctx, socket, users["6100"], "check-guild-bootstrap"), true);
  const push = pushes[before];
  assert.strictEqual(push.packetId, PACKETS.DATA_UPDATED_NOT);
  assert(push.payload.equals(buildGuildDataUpdatedNotPayload(getGuildData(ctx, 77n))));
  const outsider = makeUser("9999");
  assert.strictEqual(sendGuildLobbyBootstrap(ctx, { session: { user: outsider } }, outsider), false);

  const restarted = { ...ctx, userDb: { users: JSON.parse(JSON.stringify(users)) } };
  assert.strictEqual(restarted.userDb.users["6100"].guildUid, "77");
  assert.strictEqual(restarted.userDb.users["6301"].admin.posts[0].rewards[0].id, 101);
  assert(buildGuildDataUpdatedNotPayload(getGuildData(restarted, 77n)).equals(push.payload));
}

function verifyFirstJoinReward(user) {
  assert.strictEqual(user.guildFirstJoinRewardQueued, true);
  assert(user.admin && user.admin.posts && user.admin.posts.length === 1);
  const post = user.admin.posts[0];
  assert.strictEqual(post.title, "SI_PF_CONSORTIUM_FIRST_JOIN_REWARD_POST_TITLE_TEXT");
  assert.strictEqual(post.contents, "SI_PF_CONSORTIUM_FIRST_JOIN_REWARD_POST_CONTENTS_TEXT");
  assert.deepStrictEqual(post.rewards, [{ rewardType: "RT_MISC", id: 101, count: 100 }]);
  assert.strictEqual(post.expirationDate, String(dateTimeBinaryForDate(new Date("2026-09-19T12:00:00.000Z"))));
}

function reject(handler, user, requestId, ackId, payload, expectedError) {
  const before = JSON.stringify(users);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  const ack = invoke(handler, user, requestId, ackId, payload, false);
  assert.strictEqual(readSignedVarInt(ack, 0).value, expectedError);
  assert.strictEqual(JSON.stringify(users), before);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(pushes.length, beforePushes);
}

function invoke(handler, user, requestId, ackId, payload, canonical = true) {
  if (canonical) managedPackets.push([requestId, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: requestId, sequence: 91, payload }), true);
  assert(socket.response && socket.response.packetId === ackId);
  return socket.response.payload;
}

function decodeAcceptJoinAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readBool(payload, field.offset);
  const isAllow = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readSignedVarLong(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, isAllow, guildUid, userUid: field.value };
}

function decodeAcceptJoinNot(payload) {
  let field = readBool(payload, 0);
  const isAllow = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readString(payload, field.offset);
  const guildName = field.value;
  assert.strictEqual(payload.readUInt8(field.offset), 1);
  field = readSignedVarLong(payload, field.offset + 1);
  return { isAllow, guildUid, guildName, privateGuildUid: field.value };
}

function decodeUidAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { errorCode, userUid: field.value };
}

function decodeCancelNot(payload) {
  let field = readSignedVarLong(payload, 0);
  const guildUid = field.value;
  field = readBool(payload, field.offset);
  assert.strictEqual(field.offset, payload.length);
  return { guildUid, isRequest: field.value };
}

function decodeAcceptInviteAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readBool(payload, field.offset);
  const isAllow = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  assert.strictEqual(payload.readUInt8(field.offset), 1);
  field = readSignedVarLong(payload, field.offset + 1);
  return { errorCode, isAllow, guildUid, privateGuildUid: field.value };
}

function acceptJoinRequest(guildUid, userUid, isAllow) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(userUid), writeBool(isAllow)]);
}

function inviteRequest(guildUid, userUid) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(userUid)]);
}

function acceptInviteRequest(guildUid, isAllow) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeBool(isAllow)]);
}

function exactHandler(packetId, fileName) {
  const handler = handlers.get(packetId);
  assert(handler, `specialist missing for ${packetId}`);
  assert.strictEqual(handler.fileName, fileName);
  return handler;
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_ACCEPT_JOIN_REQ.cs"), /guildUid[\s\S]*joinUserUid[\s\S]*isAllow/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_ACCEPT_JOIN_NOT.cs"), /isAllow[\s\S]*guildUid[\s\S]*guildName[\s\S]*privateGuildData/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_INVITE_REQ.cs"), /guildUid[\s\S]*userUid/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CANCEL_REQUEST_NOT.cs"), /guildUid[\s\S]*isRequest/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_ACCEPT_INVITE_ACK.cs"), /errorCode[\s\S]*isAllow[\s\S]*guildUid[\s\S]*privateGuildData/);
  assert.match(source("gameplay-jsons", "Assetbundles", "ab_script", "luac", "LUA_COMMON_CONST.json"), /"FirstJoinReward"[\s\S]*"MiscItemId": 101[\s\S]*"MiscItemCount": 100[\s\S]*"PostExpireDay": 30/);
  assert.match(source("server", "listener.js"), /buildGuildPrivateData\(\{ getServerNowDate \}, user\)/);
  assert.match(source("combat-host", "ManagedCombatBridge.cs"), /"privateGuildData"/);
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
      assert(result.ok, `managed client schema rejected guild membership packet ${packetId}: ${result.error || "unknown error"}`);
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
    guildLevelExp: "0",
    guildUnionPoint: "0",
    guildName: options.guildName || "",
    guildBadgeId: String(Number(options.guildUid || 0) + 300),
    guildJoinType: Number(options.joinType || 0),
    guildState: 1,
    lastLoginAt: "2026-08-20T11:00:00.000Z",
  };
  if (options.guildJoinRequests) user.guildJoinRequests = options.guildJoinRequests;
  if (options.guildInvites) user.guildInvites = options.guildInvites;
  return user;
}
