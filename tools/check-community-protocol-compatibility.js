"use strict";

const assert = require("assert");
const {
  createCommunityHandlers,
  ensureCommunityUser,
  ensureReviewStore,
  handleEmoticonData,
  handleFriendList,
} = require("../modules/community");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");

const alice = {
  userUid: "1001",
  friendCode: "2001",
  nickname: "Alice",
  level: 20,
  inventory: { emoticons: [101, 104101] },
};
const bob = { userUid: "1002", friendCode: "2002", nickname: "Bob", level: 30, inventory: { emoticons: [] } };
const userDb = { users: { [alice.userUid]: alice, [bob.userUid]: bob } };
const sockets = new Map();
const pushes = [];
let saveCount = 0;
const ctx = {
  userDb,
  config: { USE_LOCAL_USER_DB: true },
  saveUserDb() { saveCount += 1; },
  invalidateJoinLobbyAckPayloadCache() {},
  buildEncryptedPacket(sequence, packetId, payload) { return payload; },
  sendResponse(socket, sequence, packetId, builder) {
    socket.response = { sequence, packetId, payload: builder() };
  },
  sendServerGamePacket(socket, packetId, payload) {
    pushes.push({ socket, packetId, payload });
  },
  findClientSocketByUserUid(userUid) { return sockets.get(String(userUid)) || null; },
};
const aliceSocket = socketFor(alice);
const bobSocket = socketFor(bob);
sockets.set(alice.userUid, aliceSocket);
sockets.set(bob.userUid, bobSocket);
const handlers = new Map(createCommunityHandlers().map((handler) => [handler.packetId, handler]));

send(402, aliceSocket, Buffer.alloc(0));
assertAck(aliceSocket, 403, 0);
send(404, aliceSocket, writeString("Bob"));
assertAck(aliceSocket, 405, 0);

send(406, aliceSocket, writeSignedVarLong(2002n));
assertAck(aliceSocket, 407, 0);
assert.equal(pushes.at(-1).packetId, 408, "friend request must push FRIEND_REQUEST_NOT");
assert.equal(pushes.at(-1).payload[0], 1, "FRIEND_REQUEST_NOT object must include its nullable marker");
assert.deepEqual(ensureCommunityUser(alice).outgoingRequests, [bob.userUid]);
assert.deepEqual(ensureCommunityUser(bob).incomingRequests, [alice.userUid]);

send(406, aliceSocket, writeSignedVarLong(2002n));
assertAck(aliceSocket, 407, 20154);

send(417, bobSocket, Buffer.concat([writeSignedVarLong(2001n), writeBool(true)]));
assertAck(bobSocket, 418, 0);
assert.equal(pushes.at(-1).packetId, 419, "friend accept must push FRIEND_ACCEPT_NOT");
assert.deepEqual(ensureCommunityUser(alice).friends, [bob.userUid]);
assert.deepEqual(ensureCommunityUser(bob).friends, [alice.userUid]);

handleFriendList(ctx, aliceSocket, { packetId: 400, sequence: 1, payload: writeSignedVarInt(0) });
assertAck(aliceSocket, 401, 0);

send(409, aliceSocket, writeSignedVarLong(2002n));
assertAck(aliceSocket, 410, 0);
assert.equal(pushes.at(-1).packetId, 411, "friend delete must push FRIEND_DELETE_NOT");
send(406, aliceSocket, writeSignedVarLong(2002n));
send(414, aliceSocket, writeSignedVarLong(2002n));
assertAck(aliceSocket, 415, 0);
assert.equal(pushes.at(-1).packetId, 416, "request cancellation must push FRIEND_CANCEL_REQUEST_NOT");
send(406, aliceSocket, writeSignedVarLong(2002n));
send(417, bobSocket, Buffer.concat([writeSignedVarLong(2001n), writeBool(true)]));
send(412, aliceSocket, Buffer.concat([writeSignedVarLong(2002n), writeBool(false)]));
assertAck(aliceSocket, 413, 0);
assert.equal(pushes.at(-1).packetId, 411, "blocking a friend must push FRIEND_DELETE_NOT");
assert.deepEqual(ensureCommunityUser(alice).blocked, [bob.userUid]);
send(412, aliceSocket, Buffer.concat([writeSignedVarLong(2002n), writeBool(true)]));
assertAck(aliceSocket, 413, 0);
assert.deepEqual(ensureCommunityUser(alice).blocked, []);

send(433, aliceSocket, Buffer.concat([writeSignedVarInt(1001), writeString("Reliable defender"), writeBool(false)]));
assertAck(aliceSocket, 434, 0);
const store = ensureReviewStore(ctx);
const comment = Object.values(store.comments["1001"])[0];
assert.equal(comment.content, "Reliable defender");

send(433, aliceSocket, Buffer.concat([writeSignedVarInt(1001), writeString("Duplicate"), writeBool(false)]));
assertAck(aliceSocket, 434, 367);

send(437, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarLong(BigInt(comment.commentUid))]));
assertAck(bobSocket, 438, 0);
assert.deepEqual(comment.votes, [bob.userUid]);
send(439, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarLong(BigInt(comment.commentUid))]));
assertAck(bobSocket, 440, 0);
assert.deepEqual(comment.votes, []);
send(437, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarLong(BigInt(comment.commentUid))]));
send(437, aliceSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarLong(BigInt(comment.commentUid))]));
assertAck(aliceSocket, 438, 369);

send(441, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarInt(5)]));
assertAck(bobSocket, 442, 0);
assert.equal(store.scores["1001"][bob.userUid], 5);

send(443, bobSocket, writeSignedVarInt(1001));
assertAck(bobSocket, 444, 0);
send(445, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarInt(1)]));
assertAck(bobSocket, 446, 0);
assert.deepEqual(store.tags["1001"]["1"], [bob.userUid]);
send(447, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeSignedVarInt(1)]));
assertAck(bobSocket, 448, 0);
assert.deepEqual(store.tags["1001"]["1"], []);
send(449, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeBool(true), writeSignedVarInt(1)]));
assertAck(bobSocket, 450, 0);

send(461, bobSocket, writeSignedVarLong(1001n));
assertAck(bobSocket, 462, 0);
send(431, bobSocket, Buffer.concat([writeSignedVarInt(1001), writeBool(false), writeSignedVarInt(1)]));
assertAck(bobSocket, 432, 0);
assert.equal(bobSocket.response.payload[1], 0, "banned review author must be absent from comment list");
send(465, bobSocket, Buffer.alloc(0));
assertAck(bobSocket, 466, 0);
send(463, bobSocket, writeSignedVarLong(1001n));
assertAck(bobSocket, 464, 0);
send(435, aliceSocket, writeSignedVarInt(1001));
assertAck(aliceSocket, 436, 0);
assert.equal(Object.keys(store.comments["1001"]).length, 0);

const textEmoticonId = ensureCommunityUser(alice).emoticons.textList[0];
handleEmoticonData(ctx, aliceSocket, { packetId: 455, sequence: 1, payload: Buffer.alloc(0) });
assertAck(aliceSocket, 456, 0);
send(457, aliceSocket, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(textEmoticonId)]));
assertAck(aliceSocket, 458, 20287);
send(457, aliceSocket, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(104101)]));
assertAck(aliceSocket, 458, 0);
send(459, aliceSocket, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(textEmoticonId)]));
assertAck(aliceSocket, 460, 0);
send(497, aliceSocket, Buffer.concat([writeSignedVarInt(textEmoticonId), writeBool(true)]));
assertAck(aliceSocket, 498, 0);
assert(ensureCommunityUser(alice).emoticons.favorites.includes(textEmoticonId));

const restarted = JSON.parse(JSON.stringify(userDb));
assert.deepEqual(restarted.users[alice.userUid].community.blocked, []);
assert.equal(Object.keys(restarted.community.comments["1001"]).length, 0);
assert(saveCount >= 16, "mutations must persist through the shared user database");

console.log(`[community-protocol-compatibility] PASS pushes=${pushes.length} saves=${saveCount}`);

function socketFor(user) {
  return { destroyed: false, session: { user, gameReplay: { nextServerSequence: 1 }, nextServerSequence: 1 } };
}

function send(packetId, socket, payload) {
  handlers.get(packetId).handle(ctx, socket, { packetId, sequence: 1, payload });
}

function assertAck(socket, packetId, errorCode) {
  assert.equal(socket.response.packetId, packetId);
  assert.equal(readSignedVarInt(socket.response.payload, 0).value, errorCode);
}
