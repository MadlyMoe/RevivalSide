"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { ensureArmy } = require("../modules/unit");
const {
  readSignedVarInt,
  writeLongArray,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handler = createOfficeHandlers().find((entry) => entry.packetId === 3606);
const socket = { session: { user: makeUser() } };
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

assert(handler, "missing Office room-unit handler");
assertFailure(Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(writeSignedVarInt(1), 20191, makeUser(), false);
assertFailure(Buffer.concat([request(1, []), Buffer.from([0])]), 20191);
assertFailure(request(10202, [9001n]), 20847);
assertFailure(request(20101, [9001n]), 20874, makeUser(), true);
assertFailure(request(1, [9001n, 9002n, 9003n]), 20874);
assertFailure(request(1, [9001n, 9001n]), 20875);
assertFailure(request(1, [999999n]), 133);
assertFailure(request(1, [9901n]), 133);
assertFailure(request(1, []), 20873);

const sameSetUser = makeUser();
sameSetUser.office.rooms.find((room) => room.id === 1).unitUids = ["9001", "11001"];
sameSetUser.army.units["9001"].officeRoomId = 1;
sameSetUser.army.trophies["11001"].officeRoomId = 1;
assertFailure(request(1, [11001n, 9001n]), 20873, sameSetUser);

const user = makeUser();
const beforeSaves = saves;
const beforeInvalidations = invalidations;
assert.strictEqual(send(request(1, [9001n, 11001n]), user), 0);
assert.deepStrictEqual(room(user, 1).unitUids, ["9001", "11001"]);
assert.strictEqual(user.army.units["9001"].officeRoomId, 1);
assert.strictEqual(user.army.trophies["11001"].officeRoomId, 1, "client-selectable trophies must synchronize their physical Office state");

assert.strictEqual(send(request(10201, [9001n]), user), 0);
assert.deepStrictEqual(room(user, 1).unitUids, ["11001"], "moving a unit must remove it from the former room");
assert.deepStrictEqual(room(user, 10201).unitUids, ["9001"]);
assert.strictEqual(user.army.units["9001"].officeRoomId, 10201);
assert.strictEqual(user.army.trophies["11001"].officeRoomId, 1);

assert.strictEqual(send(request(10201, []), user), 0);
assert.deepStrictEqual(room(user, 10201).unitUids, []);
assert.strictEqual(user.army.units["9001"].officeRoomId, 0);
assert.strictEqual(saves, beforeSaves + 3);
assert.strictEqual(invalidations, beforeInvalidations + 3);
const afterClear = JSON.stringify(user);
assert.strictEqual(send(request(10201, []), user), 20873);
assert.strictEqual(JSON.stringify(user), afterClear);
assert.strictEqual(saves, beforeSaves + 3);

const restarted = JSON.parse(JSON.stringify(user));
ensureArmy(restarted);
ensureOfficeState(restarted);
assert.strictEqual(restarted.army.units["9001"].officeRoomId, 0);
assert.strictEqual(restarted.army.trophies["11001"].officeRoomId, 1);
assert.deepStrictEqual(room(restarted, 1).unitUids, ["11001"]);

validateManagedSchemas();
console.log(`[office-room-unit-protocol-check] PASS failures=11 transitions=3 saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser() {
  const user = {
    userUid: "9880000000003606",
    nickname: "Office Owner",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: {
      units: {
        "9001": unit(9001, 1001),
        "9002": unit(9002, 1002),
        "9003": unit(9003, 1003),
      },
      ships: { "9901": unit(9901, 201) },
      trophies: { "11001": unit(11001, 11001) },
      operators: {},
      squads: {},
    },
  };
  ensureArmy(user);
  ensureOfficeState(user);
  return user;
}

function unit(uid, unitId) {
  return {
    unitUid: String(uid),
    userUid: "9880000000003606",
    unitId,
    level: 1,
    exp: 0,
    limitBreakLevel: 0,
    skillLevels: [1, 1, 1, 1, 1],
    statExp: [0, 0, 0, 0, 0, 0],
    equipItemUids: [0, 0, 0, 0],
    officeRoomId: 0,
    officeGrade: 0,
    officeGaugeStartTime: "0",
  };
}

function request(roomId, unitUids) {
  return Buffer.concat([writeSignedVarInt(roomId), writeLongArray(unitUids)]);
}

function send(payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([3606, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3606, sequence: 3606, payload }), true);
  assert.strictEqual(socket.response.packetId, 3607);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(send(payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office room-unit error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
}

function room(user, roomId) {
  return user.office.rooms.find((entry) => entry.id === roomId);
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
      assert(result.ok, `managed client schema rejected Office room-unit packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
