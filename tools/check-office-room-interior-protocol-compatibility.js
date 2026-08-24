"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { ensureArmy } = require("../modules/unit");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = new Map(createOfficeHandlers().map((entry) => [entry.packetId, entry]));
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

assertFailure(3608, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(3608, writeSignedVarInt(1), 20191, makeUser(), false);
assertFailure(3608, Buffer.concat([request(1, 800201), Buffer.from([0])]), 20191);
assertFailure(3608, request(10202, 800201), 20847);
assertFailure(3608, request(1, 999999), 20879);
assertFailure(3608, request(1, 800201), 20880, makeUser(800201));
assertFailure(3608, request(1, 800205), 20881);
assertFailure(3608, request(1, 800104), 20881);
assertFailure(3610, request(1, 800201), 20881);
assertFailure(3612, request(1, 800201), 20881);

const user = makeUser();
const beforeSaves = saves;
const beforeInvalidations = invalidations;
assert.strictEqual(send(3608, request(1, 800201), user), 0);
assert.strictEqual(room(user).floorInteriorId, 800201);
assert.strictEqual(send(3608, request(1, 800201), user), 0, "reapplying the current floor is an idempotent success");
assert.strictEqual(saves, beforeSaves + 1);

assert.strictEqual(send(3610, request(1, 800205), user), 0);
assert.strictEqual(room(user).wallInteriorId, 800205);
assert.strictEqual(send(3610, request(1, 800205), user), 0);
assert.strictEqual(saves, beforeSaves + 2);

assert.strictEqual(send(3612, request(1, 800801), user), 0);
assert.strictEqual(room(user).backgroundId, 800801);
assert.strictEqual(room(user).interiorScore, 500, "floor, wall, and background scores must be recomputed from frozen tables");
assert.strictEqual(user.army.units["9001"].officeGrade, room(user).grade, "assigned physical unit grade must follow the changed room");
assert.strictEqual(send(3612, request(1, 800801), user), 0);
assert.strictEqual(saves, beforeSaves + 3);
assert.strictEqual(invalidations, beforeInvalidations + 3);

const restarted = JSON.parse(JSON.stringify(user));
ensureArmy(restarted);
ensureOfficeState(restarted);
assert.strictEqual(room(restarted).floorInteriorId, 800201);
assert.strictEqual(room(restarted).wallInteriorId, 800205);
assert.strictEqual(room(restarted).backgroundId, 800801);
assert.strictEqual(restarted.army.units["9001"].officeGrade, room(restarted).grade);

validateManagedSchemas();
console.log(`[office-room-interior-protocol-check] PASS failures=10 transitions=3 saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(unownedInteriorId = 0) {
  const user = {
    userUid: "9880000000003608",
    nickname: "Office Owner",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: {
      units: { "9001": unit() },
      ships: {},
      trophies: {},
      operators: {},
      squads: {},
    },
  };
  ensureArmy(user);
  ensureOfficeState(user);
  room(user).unitUids = ["9001"];
  user.army.units["9001"].officeRoomId = 1;
  if (unownedInteriorId) {
    user.office.interiors.find((interior) => interior.itemId === unownedInteriorId).count = "0";
  }
  return user;
}

function unit() {
  return {
    unitUid: "9001",
    userUid: "9880000000003608",
    unitId: 1001,
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

function request(roomId, interiorId) {
  return Buffer.concat([writeSignedVarInt(roomId), writeSignedVarInt(interiorId)]);
}

function send(packetId, payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([packetId, payload, schemaValid]);
  const handler = handlers.get(packetId);
  assert(handler, `missing Office interior handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert.strictEqual(socket.response.packetId, packetId + 1);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(packetId, payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(send(packetId, payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office interior error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
}

function room(user) {
  return user.office.rooms.find((entry) => entry.id === 1);
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
      assert(result.ok, `managed client schema rejected Office interior packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
