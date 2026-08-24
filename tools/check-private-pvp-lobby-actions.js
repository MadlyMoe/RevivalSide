const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildConfig, createPrivatePvpManager } = require("../modules/private-pvp");
const {
  buildDeckIndexData,
  readSignedVarInt,
  writeBool,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const handlers = require("../modules/private-pvp/handlers/0000-000-private-pvp-reqs");

const rootDir = path.resolve(__dirname, "..");
const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
const fixture = Object.values(db.users || {})[0];
assert(fixture && fixture.userUid, "private PvP lobby check needs one local user fixture");

const host = clone(fixture, "920000000000001", "7754321", "LobbyHost");
const guest = clone(fixture, "920000000000002", "7754322", "LobbyGuest");
const hostSocket = fakeSocket(host);
const guestSocket = fakeSocket(guest);
const manager = createPrivatePvpManager({ logger() {} });
const responses = [];
const pushes = [];
let saves = 0;
let starts = 0;
const context = {
  privatePvp: manager,
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users: { [host.userUid]: host, [guest.userUid]: guest } },
  decryptCopy: (payload) => payload,
  createEphemeralUser() { throw new Error("authenticated lobby flow must not create an ephemeral user"); },
  findClientSocketByUserUid(userUid) { return String(userUid) === String(guest.userUid) ? guestSocket : null; },
  saveUserDb() { saves += 1; },
  sendGameResponse(socket, _packet, packetId, payload) { responses.push({ socket, packetId, payload }); },
  sendServerGamePacket(socket, packetId, payload) { pushes.push({ socket, packetId, payload }); },
  requestRemoteJoin() { throw new Error("local room code must not use remote join"); },
  startPrivatePvpMatch(_room, onAccepted) {
    starts += 1;
    onAccepted();
    return true;
  },
};

const initialConfig = { applyEquipStat: true, applyAllUnitMaxLevel: false, applyBanUpSystem: false, draftBanMode: false };
invoke(4100, hostSocket, Buffer.concat([writeBool(false), writeSignedVarLong(0n), writeNullableObject(buildConfig(initialConfig))]));
assert.strictEqual(error(hostSocket, 4101), 0, "room create must succeed");
const room = manager.getRoom(hostSocket);
assert(room, "host must own the created room");

invoke(4123, guestSocket, writeString(room.code));
assert.strictEqual(error(guestSocket, 4124), 0, "guest must join by local code");
assert.strictEqual(manager.getRoom(guestSocket), room);
invoke(4123, guestSocket, writeString(room.code));
assert.strictEqual(error(guestSocket, 4124), 21018, "joined guest cannot join another lobby");

invoke(4119, hostSocket, writeString("LobbyGuest"));
assert.strictEqual(error(hostSocket, 4120), 0, "lobby user search must succeed");
assert(last(responses, hostSocket, 4120).payload.length > 20, "lobby search must serialize FriendListData");

const changedConfig = { applyEquipStat: false, applyAllUnitMaxLevel: true, applyBanUpSystem: true, draftBanMode: true };
invoke(4121, guestSocket, writeNullableObject(buildConfig(changedConfig)));
assert.strictEqual(error(guestSocket, 4122), 20771, "only the host may change lobby options");
assert.deepStrictEqual(room.config, initialConfig, "rejected option change must not mutate the room");
invoke(4121, hostSocket, writeNullableObject(buildConfig(changedConfig)));
assert.strictEqual(error(hostSocket, 4122), 0, "host option change must succeed");
assert.deepStrictEqual(room.config, changedConfig);
assert(pushes.some((entry) => entry.socket === guestSocket && entry.packetId === 4129), "guest must receive config notification");

invoke(4125, hostSocket, writeSignedVarLong(9999999n));
assert.strictEqual(error(hostSocket, 4126), 20762, "kick must reject unknown target");
invoke(4125, hostSocket, writeSignedVarLong(BigInt(guest.userUid)));
assert.strictEqual(error(hostSocket, 4126), 0, "host kick must succeed");
assert.strictEqual(manager.getRoom(guestSocket), null, "kick must clear guest room state");
assert(pushes.some((entry) => entry.socket === guestSocket && entry.packetId === 4127), "kicked guest must receive KICK_NOT");

invoke(4123, guestSocket, writeString(room.code));
assert.strictEqual(error(guestSocket, 4124), 0, "kicked guest may rejoin an open room by code");

invoke(4115, hostSocket, Buffer.concat([writeSignedVarLong(BigInt(guest.userUid)), writeSignedVarInt(0)]));
assert.strictEqual(error(hostSocket, 4116), 0, "host may move guest to Player A");
assert.strictEqual(manager.getMember(guestSocket).teamType, 1);
invoke(4115, hostSocket, Buffer.concat([writeSignedVarLong(BigInt(guest.userUid)), writeSignedVarInt(1)]));
assert.strictEqual(error(hostSocket, 4116), 0, "host may move guest back to Player B");
assert.strictEqual(manager.getMember(guestSocket).teamType, 3);
invoke(4115, guestSocket, Buffer.concat([writeSignedVarLong(BigInt(host.userUid)), writeSignedVarInt(0)]));
assert.strictEqual(error(guestSocket, 4116), 20762, "non-host role change must be rejected");

invoke(4117, hostSocket, writeNullableObject(buildDeckIndexData({ deckType: 1, index: 0 })));
assert.strictEqual(error(hostSocket, 4118), 0, "deck sync must succeed");

invoke(4102, hostSocket, readyPayload(0, true));
assert.strictEqual(error(hostSocket, 4103), 21017, "invalid deck type must be rejected");
invoke(4102, hostSocket, readyPayload(1, true));
invoke(4102, guestSocket, readyPayload(1, true));
assert.strictEqual(error(hostSocket, 4103), 0);
assert.strictEqual(error(guestSocket, 4103), 0);
assert.strictEqual(saves, 3, "deck sync and ready selections must persist");

invoke(4130, guestSocket, Buffer.alloc(0));
assert.strictEqual(error(guestSocket, 4131), 20771, "only the host may start");
invoke(4130, hostSocket, Buffer.alloc(0));
assert.strictEqual(error(hostSocket, 4131), 0, "ready host must start successfully");
assert.strictEqual(starts, 1, "valid start must reach the authoritative match host once");

invoke(4136, guestSocket, writeSignedVarInt(4));
assertStateAck(0, 4);
invoke(4136, guestSocket, writeSignedVarInt(9));
assertStateAck(27310, 4);

invoke(4113, guestSocket, Buffer.alloc(0));
assert.strictEqual(error(guestSocket, 4114), 0, "guest exit must succeed");
assert.strictEqual(manager.getRoom(guestSocket), null);

invoke(4123, guestSocket, writeString(room.code));
assert.strictEqual(error(guestSocket, 4124), 0, "guest may rejoin before host shutdown");
invoke(4113, hostSocket, Buffer.alloc(0));
assert.strictEqual(error(hostSocket, 4114), 0, "host exit must close the room");
assert.strictEqual(manager.getRoom(guestSocket), null, "host exit must clear the guest room");
assert(pushes.some((entry) => entry.socket === guestSocket && entry.packetId === 4128), "guest must receive host-cancel notification");

invoke(4100, hostSocket, Buffer.concat([writeBool(false), writeSignedVarLong(9999999n), writeNullableObject(buildConfig(initialConfig))]));
assert.strictEqual(error(hostSocket, 4101), 20749, "create-with-invite must reject an unknown friend code");
assert.strictEqual(manager.getRoom(hostSocket), null, "failed create-with-invite must not leave a fake room");
invoke(4100, hostSocket, Buffer.concat([writeBool(false), writeSignedVarLong(BigInt(guest.friendCode)), writeNullableObject(buildConfig(initialConfig))]));
assert.strictEqual(error(hostSocket, 4101), 0, "create-with-invite must create the room for an online friend");
assert(pushes.some((entry) => entry.socket === guestSocket && entry.packetId === 4106), "create-with-invite must deliver INVITE_NOT");

invoke(4110, guestSocket, Buffer.concat([writeSignedVarLong(BigInt(host.userUid)), writeBool(true)]));
assert.strictEqual(error(guestSocket, 4111), 0, "invited guest must enter the new room");
const draftRoom = manager.getRoom(hostSocket);
invoke(4121, hostSocket, writeNullableObject(buildConfig(changedConfig)));
assert.strictEqual(error(hostSocket, 4122), 0, "host must enable draft mode before draft giveup");
invoke(4133, guestSocket, Buffer.alloc(0));
assert.strictEqual(error(guestSocket, 4134), 0, "draft giveup must succeed in a draft room");
assert(pushes.some((entry) => entry.socket === hostSocket && entry.packetId === 4135), "other player must receive DRAFT_GIVEUP_NOT");
assert.strictEqual(manager.getRoom(hostSocket), null, "draft giveup must close the host room");
assert.strictEqual(manager.getRoom(guestSocket), null, "draft giveup must clear the guest room");
assert.strictEqual(manager.rooms.has(draftRoom.code), false, "draft room must be removed from the manager");

console.log(`[private-pvp-lobby-check] PASS responses=${responses.length} pushes=${pushes.length} saves=${saves}`);

function readyPayload(deckType, ready) {
  return Buffer.concat([writeNullableObject(buildDeckIndexData({ deckType, index: 0 })), writeBool(ready)]);
}

function invoke(packetId, socket, payload) {
  const handler = handlers.find((entry) => entry.packetId === packetId);
  assert(handler, `missing private PvP handler ${packetId}`);
  assert.strictEqual(handler.handle(context, socket, { packetId, payload }), true);
}

function error(socket, packetId) {
  return readSignedVarInt(last(responses, socket, packetId).payload, 0).value;
}

function assertStateAck(expectedError, expectedState) {
  const payload = last(responses, guestSocket, 4137).payload;
  const result = readSignedVarInt(payload, 0);
  assert.strictEqual(result.value, expectedError);
  assert.strictEqual(readSignedVarInt(payload, result.offset).value, expectedState);
}

function last(entries, socket, packetId) {
  const found = [...entries].reverse().find((entry) => entry.socket === socket && entry.packetId === packetId);
  assert(found, `missing packet ${packetId}`);
  return found;
}

function clone(source, userUid, friendCode, nickname) {
  const user = JSON.parse(JSON.stringify(source));
  user.userUid = userUid;
  user.friendCode = friendCode;
  user.nickname = nickname;
  delete user.pvp;
  return user;
}

function fakeSocket(user) {
  return { destroyed: false, session: { user, gameReplay: { nextServerSequence: 1 }, nextServerSequence: 1 }, write() {} };
}
