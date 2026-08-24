"use strict";

const assert = require("assert");
const path = require("path");
const {
  createCombatRosterHandlers,
  ensureSupportUnit,
  getAvailableSupportUsers,
  buildDungeonSupportData,
  buildClearDungeonSupportPayload,
} = require("../modules/combat-roster");
const { grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeNullableObject,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = makeUser("988000000000001", "SupportOwner");
const friend = makeUser("988000000000002", "FriendSupport");
const stranger = makeUser("988000000000003", "LocalSupport");
const blocked = makeUser("988000000000004", "BlockedSupport");
const ownUnit = grantUnit(user, 1001);
const friendUnit = grantUnit(friend, 1002);
const strangerUnit = grantUnit(stranger, 1003);
const blockedUnit = grantUnit(blocked, 1004);
for (const [target, unit] of [[friend, friendUnit], [stranger, strangerUnit], [blocked, blockedUnit]]) {
  assert(unit, "support fixture unit must exist");
  target.support.mySupportUnitUid = unit.unitUid;
}
user.community.friends.push(friend.userUid);
user.community.blocked.push(blocked.userUid);

const userDb = { users: Object.fromEntries([user, friend, stranger, blocked].map((entry) => [entry.userUid, entry])) };
const socket = { session: { user } };
const handlers = new Map(createCombatRosterHandlers().filter((handler) => [1662, 1664, 1666].includes(handler.packetId)).map((handler) => [handler.packetId, handler]));
const wire = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb,
  decryptCopy: (payload) => payload,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

assert.deepStrictEqual(
  getAvailableSupportUsers(ctx, user).map((entry) => entry.user.userUid),
  [friend.userUid, stranger.userUid],
  "support list must prioritize friends, include real local helpers, and exclude blocked users"
);
send(1662, Buffer.alloc(0));
assert.strictEqual(socket.response.packetId, 1663);
assert.strictEqual(readSignedVarInt(socket.response.payload, 0).value, 0);
assert.strictEqual(saves, 0, "support list reads must not persist");

const availableAfterList = getAvailableSupportUsers(ctx, user);
const currentFriendUnit = availableAfterList.find((entry) => entry.user.userUid === friend.userUid).unit;
const currentStrangerUnit = availableAfterList.find((entry) => entry.user.userUid === stranger.userUid).unit;
const dungeonSelection = writeNullableObject(buildDungeonSupportData(friend, currentFriendUnit, { deckType: 1, index: 2 }));
send(1666, dungeonSelection);
assertDungeonSupportAck(0, dungeonSelection);
assert.strictEqual(user.support.dungeonSupportUserUid, friend.userUid);
assert.deepStrictEqual(user.support.dungeonSupportDeckIndex, { deckType: 1, index: 2 });
send(1666, dungeonSelection);
assertDungeonSupportAck(0, dungeonSelection);
assert.strictEqual(saves, 1, "unchanged dungeon support selection must not persist");

const mismatched = writeNullableObject(buildDungeonSupportData({ ...friend, army: stranger.army }, currentStrangerUnit, { deckType: 1, index: 2 }));
send(1666, mismatched);
assertDungeonSupportAck(27804, null);
const missingSupporter = writeNullableObject(buildDungeonSupportData({ ...friend, userUid: "999999999999999" }, currentFriendUnit, { deckType: 1, index: 2 }));
send(1666, missingSupporter);
assertDungeonSupportAck(27803, null);
assert.strictEqual(saves, 1, "invalid dungeon support requests must not persist");

const clearedDungeon = buildClearDungeonSupportPayload({ deckType: 0, index: 0 });
send(1666, clearedDungeon);
assertDungeonSupportAck(0, clearedDungeon);
send(1666, clearedDungeon);
assertDungeonSupportAck(0, clearedDungeon);
assert.strictEqual(saves, 2, "unchanged dungeon support clear must not persist");

send(1664, writeSignedVarLong(ownUnit.unitUid));
assertSupportAck(0, user.userUid);
assert.strictEqual(user.support.mySupportUnitUid, ownUnit.unitUid);
send(1664, writeSignedVarLong(ownUnit.unitUid));
assertSupportAck(0, user.userUid);
assert.strictEqual(saves, 3, "unchanged support selection must not persist");

send(1664, writeSignedVarLong(999999999n));
assertSupportAck(136, user.userUid);
assert.strictEqual(user.support.mySupportUnitUid, ownUnit.unitUid, "invalid selection must not silently fall back or mutate");
assert.strictEqual(saves, 3);

send(1664, writeSignedVarLong(0));
assertSupportAck(0, null);
assert.strictEqual(user.support.mySupportUnitUid, "0");
assert.strictEqual(ensureSupportUnit(user), null, "an explicit clear must survive normalization");
assert.strictEqual(saves, 4);
assert.strictEqual(invalidations, 4);

const restarted = JSON.parse(JSON.stringify(userDb));
assert.strictEqual(ensureSupportUnit(restarted.users[user.userUid]), null, "cleared support selection must survive restart");
assert.strictEqual(restarted.users[user.userUid].support.dungeonSupportUserUid, undefined, "cleared dungeon support must survive restart");

validateManagedSchemas();
console.log(`[support-unit-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

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

function send(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing support handler ${packetId}`);
  wire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertSupportAck(errorCode, expectedUserUid) {
  assert.strictEqual(socket.response.packetId, 1665);
  const error = readSignedVarInt(socket.response.payload, 0);
  assert.strictEqual(error.value, errorCode);
  const present = readBool(socket.response.payload, error.offset);
  assert.strictEqual(present.value, expectedUserUid != null);
  if (expectedUserUid != null) {
    assert.strictEqual(readSignedVarLong(socket.response.payload, present.offset).value, BigInt(expectedUserUid));
  }
}

function assertDungeonSupportAck(errorCode, expectedSelection) {
  assert.strictEqual(socket.response.packetId, 1667);
  const error = readSignedVarInt(socket.response.payload, 0);
  assert.strictEqual(error.value, errorCode);
  assert.deepStrictEqual(socket.response.payload.subarray(error.offset), expectedSelection || Buffer.from([0]));
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
      assert(result.ok, `managed client schema rejected support packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
