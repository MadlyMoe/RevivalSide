const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createPrivatePvpManager } = require("../modules/private-pvp");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const handlers = require("../modules/private-pvp/handlers/0000-000-private-pvp-reqs");

const rootDir = path.resolve(__dirname, "..");
const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
const fixture = Object.values(db.users || {})[0];
assert(fixture && fixture.userUid, "private PvP invitation check needs one local user fixture");

const host = clone(fixture, "910000000000001", "7654321", "InviteHost");
const target = clone(fixture, "910000000000002", "7654322", "InviteTarget");
const offline = clone(fixture, "910000000000003", "7654323", "InviteOffline");
const hostSocket = fakeSocket(host);
const targetSocket = fakeSocket(target);
const manager = createPrivatePvpManager({ logger() {} });
const room = manager.createRoom(hostSocket, host, {});
const responses = [];
const pushes = [];
const context = {
  privatePvp: manager,
  userDb: { users: { [host.userUid]: host, [target.userUid]: target, [offline.userUid]: offline } },
  decryptCopy: (payload) => payload,
  createEphemeralUser() { throw new Error("authenticated invitation flow must not create an ephemeral user"); },
  findClientSocketByUserUid(userUid) {
    return String(userUid) === String(target.userUid) ? targetSocket : null;
  },
  sendGameResponse(socket, _packet, packetId, payload) { responses.push({ socket, packetId, payload }); },
  sendServerGamePacket(socket, packetId, payload) { pushes.push({ socket, packetId, payload }); },
};

invoke(4104, hostSocket, writeSignedVarLong(9999999n));
assert.strictEqual(responseError(4105), 20749, "unknown friend code must return TARGET_NOT_FOUND");
invoke(4104, hostSocket, writeSignedVarLong(BigInt(offline.friendCode)));
assert.strictEqual(responseError(4105), 21016, "offline local user must return TARGET_NOT_CONNECTED");

inviteTarget();
assert(pushes.some((entry) => entry.socket === targetSocket && entry.packetId === 4106), "target must receive PRIVATE_PVP_LOBBY_INVITE_NOT");
let invitation = manager.getInvitation(host.userUid, target.userUid);
assert(invitation, "successful invitation must remain pending");
invitation.expiresAt = 0;
assert.strictEqual(manager.getInvitation(host.userUid, target.userUid), null, "expired invitation must be removed");
assertCancelPush(hostSocket, target.userUid, 6, "host timeout notification");
assertCancelPush(targetSocket, host.userUid, 6, "target timeout notification");

inviteTarget();
invoke(4107, hostSocket, writeSignedVarLong(BigInt(target.userUid)));
const cancelAck = last(responses, hostSocket, 4108).payload;
const cancelError = readSignedVarInt(cancelAck, 0);
assert.strictEqual(cancelError.value, 0, "host cancel must succeed");
assert.strictEqual(readSignedVarLong(cancelAck, cancelError.offset).value, BigInt(target.userUid));
assertCancelPush(targetSocket, host.userUid, 1, "target host-cancel notification");

inviteTarget();
invoke(4110, targetSocket, Buffer.concat([writeSignedVarLong(BigInt(host.userUid)), writeBool(false)]));
assertInviteAck(0, 5, "target rejection");
assert.strictEqual(manager.getRoom(targetSocket), null, "rejection must leave target outside the room");
assertCancelPush(hostSocket, target.userUid, 4, "host rejection notification");

inviteTarget();
invoke(4110, targetSocket, Buffer.concat([writeSignedVarLong(BigInt(host.userUid)), writeBool(true)]));
assertInviteAck(0, 0, "target acceptance");
assert.strictEqual(manager.getRoom(targetSocket), room, "acceptance must attach target to the host room");
assert(pushes.some((entry) => entry.socket === hostSocket && entry.packetId === 4112), "host must receive invitation-accepted lobby data");
assert(pushes.some((entry) => entry.socket === hostSocket && entry.packetId === 4132), "host must receive refreshed lobby state");
assert(pushes.some((entry) => entry.socket === targetSocket && entry.packetId === 4132), "target must receive refreshed lobby state");

invoke(4104, hostSocket, writeSignedVarLong(BigInt(target.friendCode)));
assert.strictEqual(responseError(4105), 20748, "inviting a user already in a lobby must be rejected");

console.log(`[private-pvp-invitations-check] PASS responses=${responses.length} pushes=${pushes.length}`);

function inviteTarget() {
  invoke(4104, hostSocket, writeSignedVarLong(BigInt(target.friendCode)));
  assert.strictEqual(responseError(4105), 0, "online invitation must succeed");
}

function invoke(packetId, socket, payload) {
  const handler = handlers.find((entry) => entry.packetId === packetId);
  assert(handler, `missing private PvP handler ${packetId}`);
  assert.strictEqual(handler.handle(context, socket, { packetId, payload }), true);
}

function responseError(packetId) {
  return readSignedVarInt(last(responses, hostSocket, packetId).payload, 0).value;
}

function assertInviteAck(expectedError, expectedCancel, label) {
  const payload = last(responses, targetSocket, 4111).payload;
  const error = readSignedVarInt(payload, 0);
  const cancel = readSignedVarInt(payload, error.offset);
  assert.strictEqual(error.value, expectedError, `${label} error code`);
  assert.strictEqual(cancel.value, expectedCancel, `${label} cancel type`);
}

function assertCancelPush(socket, expectedUid, expectedType, label) {
  const payload = last(pushes, socket, 4109).payload;
  const uid = readSignedVarLong(payload, 0);
  const type = readSignedVarInt(payload, uid.offset);
  assert.strictEqual(uid.value, BigInt(expectedUid), `${label} user UID`);
  assert.strictEqual(type.value, expectedType, `${label} cancel type`);
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
  return user;
}

function fakeSocket(user) {
  return { destroyed: false, session: { user, gameReplay: { nextServerSequence: 1 }, nextServerSequence: 1 }, write() {} };
}
