"use strict";

const assert = require("assert");
const path = require("path");
const { createCombatRosterHandlers, getWarfareSupportUsers } = require("../modules/combat-roster");
const { ensureArmy, grantUnit } = require("../modules/unit");
const {
  readBool,
  readSByte,
  readSignedVarInt,
  readSignedVarLong,
  readString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const owner = makeUser("988000000000011", "WarfareOwner");
const friend = makeUser("988000000000012", "WarfareFriend");
const guest = makeUser("988000000000013", "WarfareGuest");
const blocked = makeUser("988000000000014", "BlockedGuest");
const reverseBlocked = makeUser("988000000000015", "ReverseBlockedGuest");
const noSupport = makeUser("988000000000016", "NoSupportGuest");
const candidates = [friend, guest, blocked, reverseBlocked];
for (let index = 0; index < candidates.length; index += 1) {
  const unit = grantUnit(candidates[index], 1002 + index);
  assert(unit, "warfare supporter fixture unit must exist");
  candidates[index].support.mySupportUnitUid = unit.unitUid;
}
owner.community.friends.push(friend.userUid);
owner.community.blocked.push(blocked.userUid);
reverseBlocked.community.blocked.push(owner.userUid);
friend.lastLoginAt = "2026-08-19T12:00:00.000Z";

const users = [owner, friend, guest, blocked, reverseBlocked, noSupport];
for (const user of users) ensureArmy(user);
const userDb = { users: Object.fromEntries(users.map((user) => [user.userUid, user])) };
const socket = { session: { user: owner } };
const handler = createCombatRosterHandlers().find((entry) => entry.packetId === 15);
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb,
  decryptCopy: (payload) => payload,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

assert(handler, "missing warfare friend-list handler");
assert.deepStrictEqual(
  getWarfareSupportUsers(ctx, owner).friends.map((entry) => entry.user.userUid),
  [friend.userUid],
  "accepted friends must be separated from guests"
);
assert.deepStrictEqual(
  getWarfareSupportUsers(ctx, owner).guests.map((entry) => entry.user.userUid),
  [guest.userUid],
  "guests must be real opted-in local users with bidirectional blocks applied"
);

const beforeRead = JSON.stringify(userDb);
send(Buffer.alloc(0));
const valid = parseAck(socket.response.payload);
assert.strictEqual(valid.errorCode, 0);
assert.deepStrictEqual(valid.friends.map((entry) => entry.userUid), [friend.userUid]);
assert.deepStrictEqual(valid.guests.map((entry) => entry.userUid), [guest.userUid]);
assert.strictEqual(valid.friends[0].unitIds[0], 1002, "friend deck must contain a real owned unit");
assert.strictEqual(valid.guests[0].unitIds[0], 1003, "guest deck must contain a real owned unit");
assert.strictEqual(JSON.stringify(userDb), beforeRead, "warfare supporter reads must not mutate candidate state");
assert.strictEqual(saves, 0, "warfare supporter reads must not save");

send(Buffer.from([1]));
const malformed = parseAck(socket.response.payload);
assert.strictEqual(malformed.errorCode, 20190);
assert.deepStrictEqual(malformed.friends, []);
assert.deepStrictEqual(malformed.guests, []);
assert.strictEqual(saves, 0, "malformed reads must not save");

validateManagedSchemas();
console.log(`[warfare-support-list-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname) {
  return {
    userUid,
    friendCode: userUid.slice(-8),
    nickname,
    inventory: { equips: {} },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [] },
    community: { friends: [], blocked: [] },
    support: { mySupportUnitUid: "0" },
  };
}

function send(payload) {
  wire.push([15, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 15, sequence: 15, payload }), true);
  assert.strictEqual(socket.response.packetId, 16);
}

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const friends = readSupporterList(payload, error.offset);
  const guests = readSupporterList(payload, friends.offset);
  assert.strictEqual(guests.offset, payload.length, "warfare ACK must not contain trailing bytes");
  return { errorCode: error.value, friends: friends.value, guests: guests.value };
}

function readSupporterList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true, "supporter list entries must be present");
    const supporter = readSupporter(payload, present.offset);
    offset = supporter.offset;
    value.push(supporter.value);
  }
  return { value, offset };
}

function readSupporter(payload, startOffset) {
  let offset = startOffset;
  const commonPresent = readBool(payload, offset);
  assert.strictEqual(commonPresent.value, true);
  offset = commonPresent.offset;
  const userUid = readSignedVarLong(payload, offset);
  offset = userUid.offset;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readString(payload, offset).offset;
  for (let index = 0; index < 6; index += 1) offset = readSignedVarInt(payload, offset).offset;

  const deckPresent = readBool(payload, offset);
  assert.strictEqual(deckPresent.value, true);
  offset = readSByte(payload, deckPresent.offset).offset;
  offset = readDummyUnit(payload, offset).offset;
  offset = readDummyUnit(payload, offset).offset;
  const unitCount = readUnsignedVarInt(payload, offset);
  offset = unitCount.offset;
  const unitIds = [];
  for (let index = 0; index < unitCount.value; index += 1) {
    const unit = readDummyUnit(payload, offset);
    offset = unit.offset;
    if (unit.value != null) unitIds.push(unit.value);
  }
  offset += 16;
  offset = readString(payload, offset).offset;
  const guildPresent = readBool(payload, offset);
  offset = guildPresent.offset;
  if (guildPresent.value) {
    offset = readSignedVarLong(payload, offset).offset;
    offset = readString(payload, offset).offset;
    offset = readSignedVarLong(payload, offset).offset;
  }
  return { value: { userUid: String(userUid.value), unitIds }, offset };
}

function readDummyUnit(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { value: null, offset: present.offset };
  let offset = present.offset;
  const unitId = readSignedVarInt(payload, offset);
  offset = unitId.offset;
  for (let index = 0; index < 5; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return { value: unitId.value, offset };
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated list count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
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
      assert(result.ok, `managed client schema rejected warfare supporter packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
