"use strict";

const assert = require("assert");
const { createProfileHandlers } = require("../modules/profile");
const {
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeByte,
  writeNullableObject,
  writeSByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const greetingHandler = require("../packet-handlers/0453-greeting-message-req");

const alice = {
  userUid: "1001",
  friendCode: "2001",
  nickname: "Alice",
  level: 20,
  inventory: {
    misc: {
      "8001": { itemId: 8001, countFree: "1" },
      "1000001": { itemId: 1000001, countFree: "1" },
      "1500001": { itemId: 1500001, countFree: "1" },
    },
    skins: [],
  },
  army: {
    units: { "5001": { unitUid: "5001", unitId: 1001, level: 50, tacticLevel: 2, skillLevels: [] } },
    ships: {},
    operators: {},
    trophies: {},
    deckSets: {
      "1": [{ deckType: 1, index: 0, unitUids: ["5001", 0, 0, 0, 0, 0, 0, 0], leaderIndex: 0 }],
      "2": [{ deckType: 2, index: 0, unitUids: ["5001", 0, 0, 0, 0, 0, 0, 0], leaderIndex: 0 }],
    },
  },
};
const bob = { userUid: "1002", friendCode: "2002", nickname: "Bob", level: 30 };
let saveCount = 0;
const ctx = {
  userDb: { users: { [alice.userUid]: alice, [bob.userUid]: bob } },
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  saveUserDb() { saveCount += 1; },
  invalidateJoinLobbyAckPayloadCache() {},
  buildEncryptedPacket(sequence, packetId, payload) { return payload; },
  sendResponse(socket, sequence, packetId, builder) { socket.response = { packetId, payload: builder() }; },
  sendGameResponse(socket, packet, packetId, payload) { socket.response = { packetId, payload }; },
  constants: { GREETING_MESSAGE_ACK: 454 },
  buildGreetingMessageAckPayload(message) { return Buffer.concat([writeSignedVarInt(0), writeString(message)]); },
};
const socket = { session: { user: alice } };
const handlers = new Map(createProfileHandlers().map((handler) => [handler.packetId, handler]));

send(420, Buffer.concat([writeSignedVarInt(999999), writeSignedVarInt(0)]));
assertAck(421, 20177);
send(420, Buffer.concat([writeSignedVarInt(1001), writeSignedVarInt(0)]));
assertAck(421, 0);
assert.equal(alice.mainUnitId, 1001);
assert.equal(alice.mainUnitTacticLevel, 2);

send(422, writeString("1234567890123456789012345"));
assertAck(423, 0);
assert.equal(alice.friendIntro, "12345678901234567890");
assert.equal(readString(socket.response.payload, 1).value, alice.friendIntro);

send(424, writeNullableObject(Buffer.concat([writeSignedVarInt(1), writeByte(0)])));
assertAck(425, 0);
assert.deepEqual(alice.profileDeckIndex, { deckType: 1, index: 0 });
send(424, writeNullableObject(Buffer.concat([writeSignedVarInt(99), writeByte(0)])));
assertAck(425, 20181);

send(426, Buffer.concat([writeSByte(0), writeSignedVarInt(1000001)]));
assertAck(427, 0);
assert.equal(alice.profileEmblems[0].id, 1000001);
send(426, Buffer.concat([writeSByte(1), writeSignedVarInt(1000001)]));
assertAck(427, 20186);
send(426, Buffer.concat([writeSByte(5), writeSignedVarInt(0)]));
assertAck(427, 20184);

send(428, Buffer.concat([writeSignedVarLong(1002n), writeSignedVarInt(1)]));
assertAck(430, 0);
assert.equal(profileUid(socket.response.payload), 1002n, "UID lookup must return the requested profile");
send(429, writeSignedVarLong(2002n));
assertAck(430, 0);
assert.equal(profileUid(socket.response.payload), 1002n, "friend-code lookup must return the requested profile");
send(429, writeSignedVarLong(9999n));
assertAck(430, 20176);

send(451, Buffer.alloc(0));
assertAck(452, 0);
assert.equal(profileUid(socket.response.payload), 1001n);

send(467, writeSignedVarInt(9999));
assertAck(468, 20516);
send(467, writeSignedVarInt(8001));
assertAck(468, 0);
assert.equal(alice.selfiFrameId, 8001);

send(495, writeSignedVarInt(9999));
assertAck(496, 26202);
send(495, writeSignedVarInt(1500001));
assertAck(496, 0);
assert.equal(alice.titleId, 1500001);
send(495, writeSignedVarInt(1500001));
assertAck(496, 26205);

greetingHandler.handle(ctx, socket, { packetId: 453, sequence: 1, payload: Buffer.alloc(0) });
assertAck(454, 0);
assert.equal(readString(socket.response.payload, 1).value, alice.friendIntro);

const restarted = JSON.parse(JSON.stringify(ctx.userDb));
assert.equal(restarted.users[alice.userUid].mainUnitId, 1001);
assert.equal(restarted.users[alice.userUid].selfiFrameId, 8001);
assert.equal(restarted.users[alice.userUid].titleId, 1500001);
assert.equal(saveCount, 6, "only six successful profile mutations should persist");
console.log(`[community-profile-protocol-compatibility] PASS mutations=${saveCount}`);

function send(packetId, payload) {
  handlers.get(packetId).handle(ctx, socket, { packetId, sequence: 1, payload });
}

function assertAck(packetId, errorCode) {
  assert.equal(socket.response.packetId, packetId);
  assert.equal(readSignedVarInt(socket.response.payload, 0).value, errorCode);
}

function profileUid(payload) {
  let offset = readSignedVarInt(payload, 0).offset;
  assert.equal(payload[offset++], 1, "userProfileData must be present");
  assert.equal(payload[offset++], 1, "commonProfile must be present");
  return readSignedVarLong(payload, offset).value;
}
