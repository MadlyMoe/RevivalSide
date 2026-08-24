"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const {
  readSignedVarInt,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = new Map(createOfficeHandlers().map((handler) => [handler.packetId, handler]));
const socket = { session: { user: makeUser() } };
const wire = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 639228400000000000n,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

assertFailure(3600, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(3600, Buffer.concat([request(103), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(3600, request(999999), 20842);
assertFailure(3600, request(101), 20844);
assertFailure(3600, request(103), 96, makeUser(1999));

const sectionUser = makeUser(5000);
const beforeSectionSaves = saves;
const beforeSectionInvalidations = invalidations;
assert.strictEqual(send(3600, request(103), sectionUser), 0);
assert.strictEqual(miscCount(sectionUser, 101), 3000n, "section 103 must spend its exact 2,000-quartz table price");
assert(sectionUser.office.openedSectionIds.includes(103), "section 103 must become authoritative Office state");
assert(sectionUser.office.rooms.some((room) => room.id === 10301), "opening section 103 must add its free starter room");
assert.strictEqual(saves, beforeSectionSaves + 1);
assert.strictEqual(invalidations, beforeSectionInvalidations + 1);
const afterSection = JSON.stringify(sectionUser);
assert.strictEqual(send(3600, request(103), sectionUser), 20844);
assert.strictEqual(JSON.stringify(sectionUser), afterSection, "duplicate section open must not mutate the profile");
assert.strictEqual(saves, beforeSectionSaves + 1);

assertFailure(3602, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(3602, Buffer.concat([request(10202), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(3602, request(999999), 20843);
assertFailure(3602, request(1), 20845);
assertFailure(3602, request(10303), 20846, makeUser(10000));
assertFailure(3602, request(10202), 96, makeUser(499));
const prerequisiteUser = makeUser(10000);
prerequisiteUser.office.openedSectionIds.push(103);
assertFailure(3602, request(10302), 20847, prerequisiteUser);

const roomUser = makeUser(1000);
const beforeRoomSaves = saves;
const beforeRoomInvalidations = invalidations;
assert.strictEqual(send(3602, request(10202), roomUser), 0);
assert.strictEqual(miscCount(roomUser, 101), 500n, "room 10202 must spend its exact 500-quartz table price");
assert(roomUser.office.rooms.some((room) => room.id === 10202));
assert.strictEqual(saves, beforeRoomSaves + 1);
assert.strictEqual(invalidations, beforeRoomInvalidations + 1);
const afterRoom = JSON.stringify(roomUser);
assert.strictEqual(send(3602, request(10202), roomUser), 20845);
assert.strictEqual(JSON.stringify(roomUser), afterRoom, "duplicate room open must not mutate the profile");
assert.strictEqual(saves, beforeRoomSaves + 1);

validateManagedSchemas();
console.log(`[office-unlock-protocol-check] PASS sections=${wire.filter(([id]) => id === 3600).length} rooms=${wire.filter(([id]) => id === 3602).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(quartz = 5000) {
  const user = {
    userUid: "9880000000003600",
    nickname: "Office Owner",
    inventory: {
      misc: {
        "101": { itemId: 101, countFree: String(quartz), countPaid: "0", bonusRatio: 0, regDate: "0" },
      },
      equips: {},
      skins: [],
      emoticons: [],
    },
    army: { units: {}, ships: {}, operators: {}, squads: {} },
  };
  ensureOfficeState(user);
  return user;
}

function request(id) {
  return writeSignedVarInt(id);
}

function send(packetId, payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([packetId, payload, schemaValid]);
  const handler = handlers.get(packetId);
  assert(handler, `missing Office handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert.strictEqual(socket.response.packetId, packetId + 1);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(packetId, payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(send(packetId, payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves, `Office error ${expectedError} saved the profile`);
  assert.strictEqual(invalidations, beforeInvalidations, `Office error ${expectedError} invalidated JOIN`);
}

function miscCount(user, itemId) {
  const item = user && user.inventory && user.inventory.misc && user.inventory.misc[String(itemId)];
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
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
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Office unlock packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
