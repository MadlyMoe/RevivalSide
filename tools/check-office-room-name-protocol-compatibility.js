"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const {
  readBool,
  readSignedVarInt,
  readString,
  writeSignedVarInt,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handler = createOfficeHandlers().find((entry) => entry.packetId === 3604);
const socket = { session: { user: makeUser("Old Name") } };
const wire = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

assert(handler, "missing Office room-name handler");
assertFailure(Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(writeSignedVarInt(1), 20191, makeUser(), false);
assertFailure(Buffer.concat([request(1, "Room"), Buffer.from([0])]), 20191);
assertFailure(request(10202, "Locked"), 20847);
assertFailure(request(1, "123456789"), 20848);
assertFailure(request(1, "Bad\nName"), 20848);

const user = makeUser("Old Name");
const beforeSaves = saves;
const beforeInvalidations = invalidations;
assert.strictEqual(send(request(1, "My Room"), user), 0);
assert.strictEqual(user.office.rooms.find((room) => room.id === 1).name, "My Room");
assert.deepStrictEqual(readAckRoom(socket.response.payload), { id: 1, name: "My Room" });
assert.strictEqual(saves, beforeSaves + 1);
assert.strictEqual(invalidations, beforeInvalidations + 1);

assert.strictEqual(send(request(1, ""), user), 0, "empty room name must restore the frozen template-name fallback");
assert.strictEqual(user.office.rooms.find((room) => room.id === 1).name, "");
assert.deepStrictEqual(readAckRoom(socket.response.payload), { id: 1, name: "" });
assert.strictEqual(saves, beforeSaves + 2);
assert.strictEqual(invalidations, beforeInvalidations + 2);

validateManagedSchemas();
console.log(`[office-room-name-protocol-check] PASS failures=6 successes=2 saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(name = "") {
  const user = {
    userUid: "9880000000003604",
    nickname: "Office Owner",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, operators: {}, squads: {} },
  };
  ensureOfficeState(user);
  user.office.rooms.find((room) => room.id === 1).name = name;
  return user;
}

function request(roomId, roomName) {
  return Buffer.concat([writeSignedVarInt(roomId), writeString(roomName)]);
}

function send(payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([3604, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3604, sequence: 3604, payload }), true);
  assert.strictEqual(socket.response.packetId, 3605);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(send(payload, user, schemaValid), expectedError);
  assert.strictEqual(readBool(socket.response.payload, readSignedVarInt(socket.response.payload, 0).offset).value, false);
  assert.strictEqual(JSON.stringify(user), before, `Office room-name error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
}

function readAckRoom(payload) {
  let offset = readSignedVarInt(payload, 0).offset;
  const present = readBool(payload, offset);
  assert.strictEqual(present.value, true);
  offset = present.offset;
  const id = readSignedVarInt(payload, offset);
  const name = readString(payload, id.offset);
  return { id: id.value, name: name.value };
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
      assert(result.ok, `managed client schema rejected Office room-name packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
