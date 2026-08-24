"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, ERRORS, decodeGuildChatTranslateRequest } = require("../modules/company-buff");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.CHAT_TRANSLATE_REQ);
assert(handler, "Guild chat translation specialist must be registered");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3488-guild-chat-translate-req.js");
assert.deepStrictEqual(
  {
    NOT_FOUND: ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_FOUND,
    NOT_INITIALIZED: ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_INITIALIZED,
    API_EXCEPTION: ERRORS.GUILD_TRANSLATE_MESSAGE_API_EXCEPTION,
  },
  { NOT_FOUND: 20721, NOT_INITIALIZED: 20722, API_EXCEPTION: 20723 }
);

const member = makeUser("3488001", 77);
const peer = makeUser("3488002", 77);
const outsider = makeUser("3488003", 0);
const users = { [member.userUid]: member, [peer.userUid]: peer, [outsider.userUid]: outsider };
const userDb = {
  users,
  guildChats: {
    77: [
      { messageUid: "101", messageType: 0, emotionId: 0, message: "hello", author: { userUid: peer.userUid } },
      { messageUid: "102", messageType: 0, emotionId: 101, message: "", author: { userUid: peer.userUid } },
    ],
  },
};
const originalDb = JSON.stringify(userDb);
const managedPackets = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb,
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 88);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

const validRequest = request(77n, 101n, "en");
assert.deepStrictEqual(decodeGuildChatTranslateRequest(ctx, validRequest), {
  valid: true,
  guildUid: 77n,
  messageUid: 101n,
  targetLanguage: "en",
});
managedPackets.push([PACKETS.CHAT_TRANSLATE_REQ, validRequest]);
expect(member, validRequest, ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_INITIALIZED, 101n);
expect(member, request(77n, 999n, "en"), ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_FOUND, 999n);
expect(member, request(77n, 102n, "en"), ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_FOUND, 102n);
expect(member, request(88n, 101n, "en"), ERRORS.INVALID_GUILD_UID, 101n);
expect(outsider, request(77n, 101n, "en"), ERRORS.NOT_A_MEMBER, 101n);
expect(member, Buffer.alloc(0), ERRORS.INVALID_REQUEST, 0n, false);
expect(member, Buffer.concat([validRequest, Buffer.from([0])]), ERRORS.INVALID_REQUEST, 0n, false);
expect(member, Buffer.concat([writeSignedVarLong(77n), writeSignedVarLong(101n), writeString("")]), ERRORS.INVALID_REQUEST, 0n, false);
expect(member, Buffer.concat([writeSignedVarLong(77n), writeSignedVarLong(101n), writeSignedVarInt(5), Buffer.from("e")]), ERRORS.INVALID_REQUEST, 0n, false);

assert.strictEqual(saves, 0);
assert.strictEqual(invalidations, 0);
assert.strictEqual(JSON.stringify(userDb), originalDb, "translation compatibility failures must be read-only");
verifyFrozenBoundary();
validateManagedSchemas();

console.log(
  `[guild-chat-translation-check] PASS externalTranslator=absent saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function request(guildUid, messageUid, targetLanguage) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarLong(messageUid), writeString(targetLanguage)]);
}

function expect(user, payload, expectedError, expectedMessageUid, canonical = true) {
  if (canonical) managedPackets.push([PACKETS.CHAT_TRANSLATE_REQ, payload]);
  response = null;
  const before = JSON.stringify(userDb);
  assert.strictEqual(handler.handle(ctx, { session: { user } }, {
    packetId: PACKETS.CHAT_TRANSLATE_REQ,
    sequence: 88,
    payload,
  }), true);
  assert(response && response.packetId === PACKETS.CHAT_TRANSLATE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const messageUid = readSignedVarLong(response.payload, error.offset);
  const translated = readString(response.payload, messageUid.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(messageUid.value, expectedMessageUid);
  assert.strictEqual(translated.value, "");
  assert.strictEqual(translated.offset, response.payload.length);
  assert.strictEqual(JSON.stringify(userDb), before);
}

function verifyFrozenBoundary() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CHAT_TRANSLATE_REQ.cs"), /guildUid[\s\S]*messageUid[\s\S]*targetLanguage/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_CHAT_TRANSLATE_ACK.cs"), /errorCode[\s\S]*messageUid[\s\S]*textTranslated/);
  assert.match(source("Assembly-CSharp", "NKC", "Publisher", "NKCPublisherModule.cs"), /USE_CHAT_TRANSLATION[\s\S]*Send_NKMPacket_GUILD_CHAT_TRANSLATE_REQ/);
  assert.match(source("prebuilt", "local-install-sync-win-arm64", "server-data", "captured-tcp", "official-login-template.json"), /"USE_CHAT_TRANSLATION"/);
  assert.match(source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_GUILD_TRANSLATE_MESSAGE_NOT_FOUND,[\s\S]*NEC_FAIL_GUILD_TRANSLATE_MESSAGE_NOT_INITIALIZED,[\s\S]*NEC_FAIL_GUILD_TRANSLATE_MESSAGE_API_EXCEPTION/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /GUILD_CHAT_TRANSLATE_ACK[\s\S]*OnTranslateCompleteFromCS_Server/);
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
      assert(result.ok, `managed client schema rejected Guild chat translation packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, guildUid) {
  return {
    userUid,
    nickname: `User${userUid}`,
    level: 50,
    guildUid: String(guildUid),
    guildMemberGrade: 2,
    guildLevel: 3,
    guildName: guildUid > 0 ? `Guild${guildUid}` : "",
    guildBadgeId: guildUid > 0 ? String(guildUid + 300) : "0",
    guildJoinType: 1,
    guildState: 1,
    guildClosingTime: "0",
    guildJoinRequests: [],
    guildInvites: [],
  };
}
