"use strict";

const assert = require("assert");
const path = require("path");
const { ADMIN_UID, createAdminHandler } = require("../modules/admin");
const { getAllEmoticonIds, getEmoticonTemplet } = require("../modules/game-data");
const { readSignedVarInt, readSignedVarLong, writeSignedVarInt, writeSignedVarLong, writeString } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const alice = createUser("970000000000001", "ChatAlice", "97000001");
const bob = createUser("970000000000002", "ChatBob", "97000002");
const guildMate = createUser("970000000000003", "GuildMate", "97000003");
alice.community.friends.push(bob.userUid);
bob.community.friends.push(alice.userUid);
alice.guildUid = "77";
guildMate.guildUid = "77";

const userDb = { users: { [alice.userUid]: alice, [bob.userUid]: bob, [guildMate.userUid]: guildMate } };
const aliceSocket = { session: { user: alice }, name: "alice" };
const bobSocket = { session: { user: bob }, name: "bob" };
const guildSocket = { session: { user: guildMate }, name: "guild" };
const online = new Map([[alice.userUid, aliceSocket], [bob.userUid, bobSocket], [guildMate.userUid, guildSocket]]);
const handlers = new Map([3800, 3803, 3805].map((packetId) => [packetId, createAdminHandler(packetId, `CHECK_${packetId}`)]));
const pushes = [];
const wire = [];
let saves = 0;
const timestamp = 637454448000000000n;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb,
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => timestamp,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { sequence: packet.sequence, packetId, payload };
    wire.push([packetId, payload]);
  },
  sendServerGamePacket(target, packetId, payload) {
    pushes.push({ target: target.name, packetId, payload });
    wire.push([packetId, payload]);
  },
  findClientSocketByUserUid: (userUid) => online.get(String(userUid)) || null,
  saveUserDb() { saves += 1; },
};

send(aliceSocket, 3800, chatRequest("0", 0, "hello"));
assertAck(aliceSocket, 3801, 22100);
send(aliceSocket, 3800, chatRequest(alice.userUid, 0, "hello"));
assertAck(aliceSocket, 3801, 22100);
send(aliceSocket, 3800, chatRequest(bob.userUid, 0, ""));
assertAck(aliceSocket, 3801, 20190);
send(aliceSocket, 3800, chatRequest(bob.userUid, 0, "x".repeat(71)));
assertAck(aliceSocket, 3801, 20190);
assert.strictEqual(saves, 0, "invalid private chat must not persist");

bob.community.blocked.push(alice.userUid);
send(aliceSocket, 3800, chatRequest(bob.userUid, 0, "blocked"));
assertAck(aliceSocket, 3801, 22101);
bob.community.blocked.length = 0;

send(aliceSocket, 3800, chatRequest(bob.userUid, 0, "hello Bob"));
assertAck(aliceSocket, 3801, 0);
const firstUid = readAckMessageUid(aliceSocket);
assert(firstUid > 0n);
assert.strictEqual(alice.admin.chats[bob.userUid].length, 1);
assert.strictEqual(bob.admin.chats[alice.userUid].length, 1);
assert.strictEqual(bob.admin.chats[alice.userUid][0].message, "hello Bob");
assert.deepStrictEqual(pushes.slice(-2).map((push) => push.target), ["alice", "bob"]);

send(bobSocket, 3800, chatRequest(alice.userUid, 0, "hello Alice"));
assertAck(bobSocket, 3801, 0);
const secondUid = readAckMessageUid(bobSocket);
assert(secondUid > firstUid, "shared message IDs must remain unique across both directions");
assert.strictEqual(alice.admin.chats[bob.userUid].length, 2);
assert.strictEqual(bob.admin.chats[alice.userUid].length, 2);

const aniId = getAllEmoticonIds().find((id) => getEmoticonTemplet(id)?.m_EmoticonType === "NET_ANI");
assert(aniId, "frozen animated emoticon fixture must exist");
alice.inventory.emoticons.push(aniId);
send(aliceSocket, 3800, chatRequest(bob.userUid, aniId, ""));
assertAck(aliceSocket, 3801, 0);
assert.strictEqual(bob.admin.chats[alice.userUid].at(-1).emotionId, aniId);

online.delete(bob.userUid);
const pushCount = pushes.length;
send(aliceSocket, 3800, chatRequest(bob.userUid, 0, "offline delivery"));
assertAck(aliceSocket, 3801, 0);
assert.strictEqual(pushes.length, pushCount + 1, "offline recipient must persist without a recipient push");
assert.strictEqual(bob.admin.chats[alice.userUid].at(-1).message, "offline delivery");
online.set(bob.userUid, bobSocket);

const postsBefore = bob.admin.posts.length;
send(bobSocket, 3800, chatRequest(alice.userUid, 0, "/give quartz 10"));
assertAck(bobSocket, 3801, 0);
assert.strictEqual(bob.admin.posts.length, postsBefore, "admin commands must execute only in the admin room");

send(aliceSocket, 3800, chatRequest(ADMIN_UID, 0, "/help"));
assertAck(aliceSocket, 3801, 0);
assert.strictEqual(pushes.at(-1).target, "alice");
assert.strictEqual(alice.admin.chats[String(ADMIN_UID)].length, 2);

const savesAfterMutations = saves;
send(aliceSocket, 3803, writeSignedVarLong(bob.userUid));
assertAck(aliceSocket, 3804, 0);
send(aliceSocket, 3803, writeSignedVarLong("999999999999999"));
assertAck(aliceSocket, 3804, 22100);
send(aliceSocket, 3805, Buffer.alloc(0));
assertAck(aliceSocket, 3806, 0);
assert.strictEqual(saves, savesAfterMutations, "chat reads must not save unchanged state");

const restarted = JSON.parse(JSON.stringify(userDb));
assert.strictEqual(restarted.users[alice.userUid].admin.chats[bob.userUid].length, 5);
assert.strictEqual(restarted.users[bob.userUid].admin.chats[alice.userUid].length, 5);
assert(BigInt(restarted.privateChat.nextMessageUid) > secondUid);

validateManagedSchemas();
console.log(`[private-chat-protocol-check] PASS saves=${saves} pushes=${pushes.length} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser(userUid, nickname, friendCode) {
  return {
    userUid,
    nickname,
    friendCode,
    level: 10,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    community: { friends: [], blocked: [] },
    admin: { posts: [], chats: {}, nextPostIndex: "1", nextMessageUid: "1" },
  };
}

function chatRequest(userUid, emotionId, message) {
  return Buffer.concat([writeSignedVarLong(userUid), writeSignedVarInt(emotionId), writeString(message)]);
}

function send(socket, packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing private-chat handler ${packetId}`);
  wire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(socket, packetId, errorCode) {
  assert.strictEqual(socket.response.packetId, packetId, `unexpected ACK for ${packetId}`);
  assert.strictEqual(readSignedVarInt(socket.response.payload, 0).value, errorCode, `packet ${packetId} error code`);
}

function readAckMessageUid(socket) {
  const error = readSignedVarInt(socket.response.payload, 0);
  return readSignedVarLong(socket.response.payload, error.offset).value;
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const combatHost = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected private-chat packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
