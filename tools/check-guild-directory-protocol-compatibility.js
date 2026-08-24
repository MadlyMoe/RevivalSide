"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  buildGuildListAckPayload,
  getGuildDirectory,
  listRelatedGuilds,
  searchGuilds,
} = require("../modules/company-buff");
const {
  readSignedVarInt,
  writeSignedVarInt,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const searchHandler = handlers.get(PACKETS.SEARCH_REQ);
const listHandler = handlers.get(PACKETS.LIST_REQ);
assert(searchHandler, "guild search specialist must be registered");
assert(listHandler, "guild list specialist must be registered");
assert.strictEqual(searchHandler.fileName, "modules\\company-buff\\handlers\\0000-3406-guild-search-req.js");
assert.strictEqual(listHandler.fileName, "modules\\company-buff\\handlers\\0000-3408-guild-list-req.js");

const users = {
  "6000": makeUser("6000", { guildJoinRequests: [77, 77, 404], guildInvites: [{ guildUid: 99 }, { guildUid: 88 }] }),
  "7001": makeUser("7001", { guildUid: 77, grade: 0, nickname: "MasterA", guildName: "Revival Knights", level: 2, exp: 100, joinType: 1, greeting: "Approval guild" }),
  "7002": makeUser("7002", { guildUid: 77, nickname: "MemberA", level: 3, exp: 10 }),
  "8001": makeUser("8001", { guildUid: 88, grade: 0, nickname: "MasterB", guildName: "Alpha Guild", level: 4, exp: 5, joinType: 0, greeting: "Open guild" }),
  "9001": makeUser("9001", { guildUid: 99, grade: 0, nickname: "MasterC", guildName: "Closed Guild", level: 5, exp: 1, joinType: 2, greeting: "Closed" }),
};

const managedPackets = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 73);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

verifyFrozenSources();
verifyDirectoryModel();
verifySearch();
verifyLists();
verifyRestart();
validateManagedSchemas();

console.log(
  `[guild-directory-check] PASS guilds=3 searches=4 lists=2 saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyDirectoryModel() {
  const directory = getGuildDirectory(ctx);
  assert.deepStrictEqual(directory.map((guild) => [guild.guildUid, guild.guildLevel, guild.name]), [
    [99n, 5, "Closed Guild"],
    [88n, 4, "Alpha Guild"],
    [77n, 3, "Revival Knights"],
  ]);
  assert.deepStrictEqual(searchGuilds(ctx, users["6000"], "").map((guild) => guild.guildUid), [88n, 77n]);
  assert.deepStrictEqual(searchGuilds(ctx, users["6000"], "vival KN").map((guild) => guild.guildUid), [77n]);
  assert.deepStrictEqual(searchGuilds(ctx, users["8001"], "").map((guild) => guild.guildUid), [77n]);
  assert.deepStrictEqual(listRelatedGuilds(ctx, users["6000"], 0).map((guild) => guild.guildUid), [77n]);
  assert.deepStrictEqual(listRelatedGuilds(ctx, users["6000"], 1).map((guild) => guild.guildUid), [99n, 88n]);
}

function verifySearch() {
  searchSucceeds("", users["6000"], searchGuilds(ctx, users["6000"], ""));
  searchSucceeds("REVIVAL", users["6000"], searchGuilds(ctx, users["6000"], "REVIVAL"));
  searchSucceeds("missing", users["6000"], []);
  searchSucceeds("", users["8001"], searchGuilds(ctx, users["8001"], ""));
  searchRejects("empty payload", Buffer.alloc(0));
  searchRejects("null string", writeSignedVarInt(-1));
  searchRejects("trailing", Buffer.concat([writeString("Revival"), Buffer.from([0])]));
  searchRejects("noncanonical", Buffer.from([0x82, 0x00, 0x61]));
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
}

function verifyLists() {
  listSucceeds(0, users["6000"], listRelatedGuilds(ctx, users["6000"], 0));
  listSucceeds(1, users["6000"], listRelatedGuilds(ctx, users["6000"], 1));
  listRejects("empty", Buffer.alloc(0));
  listRejects("trailing", Buffer.concat([writeSignedVarInt(0), Buffer.from([0])]));
  listRejects("noncanonical", Buffer.from([0x80, 0x00]));
  listRejects("invalid type", writeSignedVarInt(2), true);
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
}

function verifyRestart() {
  const restarted = { userDb: { users: JSON.parse(JSON.stringify(users)) } };
  assert.deepStrictEqual(safe(getGuildDirectory(restarted)), safe(getGuildDirectory(ctx)));
  assert.deepStrictEqual(safe(listRelatedGuilds(restarted, restarted.userDb.users["6000"], 1)), safe(listRelatedGuilds(ctx, users["6000"], 1)));
}

function searchSucceeds(keyword, user, guilds) {
  const payload = writeString(keyword);
  managedPackets.push([PACKETS.SEARCH_REQ, payload]);
  const response = invoke(searchHandler, PACKETS.SEARCH_REQ, PACKETS.SEARCH_ACK, user, payload);
  assert(response.equals(buildGuildListAckPayload(ERRORS.OK, guilds)));
  assert.strictEqual(readSignedVarInt(response, 0).value, ERRORS.OK);
}

function searchRejects(name, payload) {
  const before = JSON.stringify(users);
  const response = invoke(searchHandler, PACKETS.SEARCH_REQ, PACKETS.SEARCH_ACK, users["6000"], payload);
  assert(response.equals(buildGuildListAckPayload(ERRORS.INVALID_REQUEST, [])), name);
  assert.strictEqual(JSON.stringify(users), before, `${name} must be pure`);
}

function listSucceeds(listType, user, guilds) {
  const payload = writeSignedVarInt(listType);
  managedPackets.push([PACKETS.LIST_REQ, payload]);
  const response = invoke(listHandler, PACKETS.LIST_REQ, PACKETS.LIST_ACK, user, payload);
  assert(response.equals(buildGuildListAckPayload(ERRORS.OK, guilds)));
}

function listRejects(name, payload, managed = false) {
  const before = JSON.stringify(users);
  if (managed) managedPackets.push([PACKETS.LIST_REQ, payload]);
  const response = invoke(listHandler, PACKETS.LIST_REQ, PACKETS.LIST_ACK, users["6000"], payload);
  assert(response.equals(buildGuildListAckPayload(ERRORS.INVALID_REQUEST, [])), name);
  assert.strictEqual(JSON.stringify(users), before, `${name} must be pure`);
}

function invoke(targetHandler, requestPacketId, ackPacketId, user, payload) {
  const socket = { session: { user } };
  assert.strictEqual(targetHandler.handle(ctx, socket, { packetId: requestPacketId, sequence: 73, payload }), true);
  assert.strictEqual(socket.response.packetId, ackPacketId);
  return socket.response.payload;
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_SEARCH_REQ.cs"), /keyword/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_SEARCH_ACK.cs"), /errorCode[\s\S]*list/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_LIST_REQ.cs"), /guildListType/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_LIST_ACK.cs"), /errorCode[\s\S]*list/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "GuildListData.cs"), /guildUid[\s\S]*name[\s\S]*badgeId[\s\S]*guildLevel[\s\S]*guildJoinType[\s\S]*masterNickname[\s\S]*memberCount[\s\S]*greeting/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildJoin.cs"), /Send_NKMPacket_GUILD_SEARCH_REQ\(""\)[\s\S]*GuildListType\.SendRequest[\s\S]*GuildListType\.ReceiveInvite/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_SEARCH_ACK[\s\S]*OnRecv\(NKMPacket_GUILD_LIST_ACK/);
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
      assert(result.ok, `managed client schema rejected guild directory packet ${packetId}: ${result.error || "unknown error"}`);
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
    guildName: options.guildName || "",
    guildBadgeId: String(options.badgeId || Number(options.guildUid || 0) + 300),
    guildJoinType: Number(options.joinType || 0),
    guildState: 1,
    guildGreeting: options.greeting || "",
    guildUnionPoint: "0",
    lastLoginAt: "2026-08-20T11:00:00.000Z",
  };
  if (options.guildJoinRequests) user.guildJoinRequests = options.guildJoinRequests;
  if (options.guildInvites) user.guildInvites = options.guildInvites;
  return user;
}

function safe(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? String(entry) : entry));
}
