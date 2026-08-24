"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  getGuildChatMuteEndDate,
  listGuildChat,
  loadTables,
  sendGuildLobbyBootstrap,
} = require("../modules/company-buff");
const {
  readSignedVarInt,
  readSignedVarLong,
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
const sendHandler = exactHandler(PACKETS.CHAT_REQ, "modules\\company-buff\\handlers\\0000-3451-guild-chat-req.js");
const listHandler = exactHandler(PACKETS.CHAT_LIST_REQ, "modules\\company-buff\\handlers\\0000-3454-guild-chat-list-req.js");
const complaintHandler = exactHandler(PACKETS.CHAT_COMPLAIN_REQ, "modules\\company-buff\\handlers\\0000-3468-guild-chat-complain-req.js");

const now = new Date("2026-08-21T12:00:00.000Z");
const nowBinary = dateTimeBinaryForDate(now);
const memberUids = ["7001", "7002", "7003", "7004", "7005", "7006", "7007"];
const users = Object.fromEntries(memberUids.map((uid, index) => [uid, makeUser(uid, 77, index === 0 ? 0 : 2)]));
users["8001"] = makeUser("8001", 88, 0);
users["9001"] = makeUser("9001", 0, 2);
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
    assert.strictEqual(packet.sequence, 97);
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
verifySendFailures();
const messageUids = verifySendsAndList();
verifyComplaints(messageUids);
verifyBootstrap();
verifyRestart();
validateManagedSchemas();

assert.strictEqual(saves, 8);
assert.strictEqual(invalidations, 1);
console.log(
  `[guild-chat-check] PASS messages=3 saves=${saves} invalidations=${invalidations} pushes=${pushes.length} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CHAT_REQ.cs"), /guildUid[\s\S]*messageType[\s\S]*emotionId[\s\S]*message/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Common", "NKMChatMessageData.cs"), /messageUid[\s\S]*messageType[\s\S]*commonProfile[\s\S]*emotionId[\s\S]*message[\s\S]*createdAt[\s\S]*typeParam[\s\S]*blocked/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "NKCUIComChat.cs"), /str\.Length > 70[\s\S]*ChatMessageType\.Normal/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCChatManager.cs"), /Count > 100[\s\S]*MAX_CHAT_COUNT = 100/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "NKCPopupChatSlotText.cs"), /GUILD_CHAT_COMPLAIN_REQ[\s\S]*OnClickTranslate/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /GUILD_CHAT_LIST_NOT[\s\S]*BLOCK_MUTE_NOT[\s\S]*GUILD_CHAT_ACK[\s\S]*GUILD_CHAT_COMPLAIN_ACK/);
  assert.match(source("server", "listener.js"), /getGuildChatMuteEndDate\(user\).*blockMuteEndDate/);
}

function verifyConstants() {
  assert.deepStrictEqual(loadTables().guildChatConfig, { complainCountToBlock: 5, autoBlockHours: 24 });
  assert.deepStrictEqual(
    {
      EMOTICON: ERRORS.EMOTICON_NOT_OWNED,
      MISSING: ERRORS.CHAT_MESSAGE_UID_NOT_FOUND,
      DUPLICATE: ERRORS.CHAT_COMPLAIN_DUPLICATED,
      INVALID_TYPE: ERRORS.CHAT_COMPLAIN_INVALID_TYPE,
      ALREADY_BLOCKED: ERRORS.CHAT_COMPLAIN_ALREADY_BLOCKED,
      MUTED: ERRORS.GUILD_CHAT_BLOCK_MUTE,
    },
    { EMOTICON: 20583, MISSING: 20584, DUPLICATE: 20586, INVALID_TYPE: 20588, ALREADY_BLOCKED: 20589, MUTED: 20592 }
  );
}

function verifyStrictFraming() {
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, Buffer.concat([chatRequest(77n, 0, 0, "hello"), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(listHandler, users["7001"], PACKETS.CHAT_LIST_REQ, PACKETS.CHAT_LIST_ACK, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
  reject(listHandler, users["7001"], PACKETS.CHAT_LIST_REQ, PACKETS.CHAT_LIST_ACK, Buffer.concat([guildRequest(77n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  reject(complaintHandler, users["7003"], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, guildRequest(77n), ERRORS.INVALID_REQUEST, false);
  reject(complaintHandler, users["7003"], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, Buffer.concat([complaintRequest(77n, 1n), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
}

function verifySendFailures() {
  reject(sendHandler, users["9001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 0, "hello"), ERRORS.NOT_A_MEMBER);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(88n, 0, 0, "hello"), ERRORS.INVALID_GUILD_UID);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 1, 0, "system"), ERRORS.INVALID_REQUEST);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 0, ""), ERRORS.INVALID_REQUEST);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 0, "x".repeat(71)), ERRORS.INVALID_REQUEST);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 999999, ""), ERRORS.EMOTICON_NOT_OWNED);
  reject(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 101, "spoof"), ERRORS.EMOTICON_NOT_OWNED);
}

function verifySendsAndList() {
  const beforePushes = pushes.length;
  const first = invoke(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 0, "hello guild"));
  const firstAck = decodeChatAck(first);
  assert.strictEqual(firstAck.errorCode, 0);
  assert(firstAck.messageUid > 0n);

  const second = invoke(sendHandler, users["7002"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 0, "report me"));
  const secondAck = decodeChatAck(second);
  assert(secondAck.messageUid > firstAck.messageUid);
  const third = invoke(sendHandler, users["7001"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 101, ""));
  const thirdAck = decodeChatAck(third);
  assert(thirdAck.messageUid > secondAck.messageUid);

  const chatPushes = pushes.slice(beforePushes).filter((push) => push.packetId === PACKETS.CHAT_NOT);
  assert.strictEqual(chatPushes.length, memberUids.length * 3);
  assert.deepStrictEqual([...new Set(chatPushes.map((push) => push.userUid))].sort(), memberUids);

  const before = JSON.stringify(users);
  const listAck = invoke(listHandler, users["7003"], PACKETS.CHAT_LIST_REQ, PACKETS.CHAT_LIST_ACK, guildRequest(77n));
  const error = readSignedVarInt(listAck, 0);
  const guild = readSignedVarLong(listAck, error.offset);
  assert.strictEqual(error.value, 0);
  assert.strictEqual(guild.value, 77n);
  assert.strictEqual(listAck.readUInt8(guild.offset), 3);
  assert.strictEqual(JSON.stringify(users), before);
  assert.deepStrictEqual(listGuildChat(ctx, users["7003"], 77n).messages.map((message) => message.message), ["hello guild", "report me", ""]);
  return { first: firstAck.messageUid, reportable: secondAck.messageUid, emoticon: thirdAck.messageUid };
}

function verifyComplaints(messageUids) {
  reject(complaintHandler, users["7003"], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, complaintRequest(77n, 99999n), ERRORS.CHAT_MESSAGE_UID_NOT_FOUND);
  reject(complaintHandler, users["7001"], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, complaintRequest(77n, messageUids.first), ERRORS.CHAT_COMPLAIN_INVALID_TYPE);
  reject(complaintHandler, users["7003"], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, complaintRequest(77n, messageUids.emoticon), ERRORS.CHAT_COMPLAIN_INVALID_TYPE);

  const reporters = ["7003", "7004", "7005", "7006", "7007"];
  const beforeMutePushes = pushes.length;
  for (const uid of reporters) {
    const ack = invoke(complaintHandler, users[uid], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, complaintRequest(77n, messageUids.reportable));
    assert.deepStrictEqual(decodeComplaintAck(ack), { errorCode: 0, guildUid: 77n, messageUid: messageUids.reportable });
    if (uid === "7003") {
      reject(complaintHandler, users[uid], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, complaintRequest(77n, messageUids.reportable), ERRORS.CHAT_COMPLAIN_DUPLICATED);
    }
  }
  const mutePushes = pushes.slice(beforeMutePushes).filter((push) => push.packetId === PACKETS.BLOCK_MUTE_NOT);
  assert.strictEqual(mutePushes.length, 1);
  assert.strictEqual(mutePushes[0].userUid, "7002");
  assert(getGuildChatMuteEndDate(users["7002"]) > nowBinary);
  reject(complaintHandler, users["7003"], PACKETS.CHAT_COMPLAIN_REQ, PACKETS.CHAT_COMPLAIN_ACK, complaintRequest(77n, messageUids.reportable), ERRORS.CHAT_COMPLAIN_ALREADY_BLOCKED);
  reject(sendHandler, users["7002"], PACKETS.CHAT_REQ, PACKETS.CHAT_ACK, chatRequest(77n, 0, 0, "muted"), ERRORS.GUILD_CHAT_BLOCK_MUTE);
}

function verifyBootstrap() {
  const before = pushes.length;
  assert.strictEqual(sendGuildLobbyBootstrap(ctx, online.get("7001"), users["7001"], "guild-chat-bootstrap"), true);
  const emitted = pushes.slice(before);
  assert.deepStrictEqual(emitted.map((push) => push.packetId), [
    PACKETS.DATA_UPDATED_NOT,
    ...Array(memberUids.length - 1).fill(PACKETS.USER_PROFILE_UPDATED_NOT),
    PACKETS.CHAT_LIST_NOT,
  ]);
  assert.deepStrictEqual(
    emitted.filter((push) => push.packetId === PACKETS.USER_PROFILE_UPDATED_NOT).map((push) => push.userUid).sort(),
    memberUids.filter((uid) => uid !== "7001")
  );
}

function verifyRestart() {
  const restarted = { ...ctx, userDb: JSON.parse(JSON.stringify(ctx.userDb)) };
  assert.strictEqual(listGuildChat(restarted, restarted.userDb.users["7001"], 77n).messages.length, 3);
  assert(getGuildChatMuteEndDate(restarted.userDb.users["7002"]) > nowBinary);
  assert.strictEqual(Object.keys(restarted.userDb.guildChatComplaints).length, 1);
}

function invoke(handler, user, requestId, ackId, payload, canonical = true) {
  if (canonical) managedPackets.push([requestId, payload]);
  const socket = online.get(String(user.userUid)) || { session: { user } };
  socket.response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: requestId, sequence: 97, payload }), true);
  assert(socket.response && socket.response.packetId === ackId);
  return socket.response.payload;
}

function reject(handler, user, requestId, ackId, payload, expectedError, canonical = true) {
  const before = JSON.stringify(ctx.userDb);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforePushes = pushes.length;
  const ack = invoke(handler, user, requestId, ackId, payload, canonical);
  assert.strictEqual(readSignedVarInt(ack, 0).value, expectedError);
  assert.strictEqual(JSON.stringify(ctx.userDb), before);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(pushes.length, beforePushes);
}

function decodeChatAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const message = readSignedVarLong(payload, error.offset);
  assert.strictEqual(message.offset, payload.length);
  return { errorCode: error.value, messageUid: message.value };
}

function decodeComplaintAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const guild = readSignedVarLong(payload, error.offset);
  const message = readSignedVarLong(payload, guild.offset);
  assert.strictEqual(message.offset, payload.length);
  return { errorCode: error.value, guildUid: guild.value, messageUid: message.value };
}

function chatRequest(guildUid, messageType, emotionId, message) {
  return Buffer.concat([
    writeSignedVarLong(guildUid),
    writeSignedVarInt(messageType),
    writeSignedVarInt(emotionId),
    writeString(message),
  ]);
}

function guildRequest(guildUid) {
  return writeSignedVarLong(guildUid);
}

function complaintRequest(guildUid, messageUid) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(messageUid)]);
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
      assert(result.ok, `managed client schema rejected Guild chat packet ${packetId}: ${result.error || "unknown error"}`);
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
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [101] },
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
    lastLoginAt: "2026-08-21T11:00:00.000Z",
  };
}
