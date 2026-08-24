"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { ensureArmy } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const NOW = 639228400000000000n;
const TICKS_PER_HOUR = 36_000_000_000n;
const FULL_GRADE_F_CHARGE = 72n * TICKS_PER_HOUR;
const handler = createOfficeHandlers().find((entry) => entry.packetId === 3622);
const socket = { session: { user: makeUser() } };
const wire = [];
const missions = [];
let saves = 0;
let invalidations = 0;
let missionPushes = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => NOW,
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  trackMissionEvent(_user, condition, amount, details) {
    missions.push({ condition, amount, details });
    return true;
  },
  refreshMissionProgress() {},
  sendTrackedMissionUpdate() {
    missionPushes += 1;
    return true;
  },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

assert(handler, "missing Office take-heart handler");
assertFailure(Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(Buffer.from([0x80]), 20191, makeUser(), false);
assertFailure(Buffer.concat([request(9001n), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(request(999999n), 133);
assertFailure(request(9901n), 133);
assertFailure(request(11001n), 23009);
assertFailure(request(9001n), 20890, makeUser({ assigned: false }));
assertFailure(request(9001n), 20891, makeUser({ start: NOW - FULL_GRADE_F_CHARGE + 1n }));
assertFailure(request(9001n), 20892, makeUser({ loyalty: 10000 }));
assertFailure(request(9001n), 20892, makeUser({ permanent: true }));

const user = makeUser({ loyalty: 9800 });
const beforeSaves = saves;
const beforeInvalidations = invalidations;
assert.strictEqual(send(request(9001n), user), 0);
assert.strictEqual(user.army.units["9001"].loyalty, 9900, "one collected heart must grant one displayed Loyalty point");
assert.strictEqual(user.army.units["9001"].officeGaugeStartTime, String(NOW), "success must restart the room-heart timer");
assert.strictEqual(saves, beforeSaves + 1);
assert.strictEqual(invalidations, beforeInvalidations + 1);
assert.strictEqual(missions.length, 1);
assert.strictEqual(missions[0].condition, "GET_OFFICE_HEART");
assert.strictEqual(missions[0].amount, 1);
assert.strictEqual(missions[0].details.unitUid, "9001");
assert.strictEqual(missionPushes, 1);
assertFailure(request(9001n), 20891, user);

const capUser = makeUser({ loyalty: 9950 });
assert.strictEqual(send(request(9001n), capUser), 0);
assert.strictEqual(capUser.army.units["9001"].loyalty, 10000, "heart Loyalty must cap at the frozen maximum");
assert.strictEqual(missions.length, 2);
assert.strictEqual(missionPushes, 2);
assertFailure(request(9001n), 20892, capUser);

const restarted = JSON.parse(JSON.stringify(user));
ensureArmy(restarted);
ensureOfficeState(restarted);
assert.strictEqual(restarted.army.units["9001"].loyalty, 9900);
assert.strictEqual(restarted.army.units["9001"].officeGaugeStartTime, String(NOW));

validateManagedSchemas();
console.log(`[office-heart-protocol-check] PASS failures=12 successes=2 saves=${saves} missions=${missions.length} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(options = {}) {
  const user = {
    userUid: "9880000000003622",
    nickname: "Office Owner",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: {
      units: { "9001": unit(9001, 1001) },
      ships: { "9901": unit(9901, 201) },
      trophies: { "11001": unit(11001, 11001) },
      operators: {},
      squads: {},
    },
  };
  ensureArmy(user);
  ensureOfficeState(user);
  const assigned = options.assigned !== false;
  const target = user.army.units["9001"];
  target.loyalty = options.loyalty == null ? 5000 : options.loyalty;
  target.isPermanentContract = options.permanent === true;
  target.officeRoomId = assigned ? 1 : 0;
  target.officeGrade = 0;
  target.officeGaugeStartTime = String(options.start == null ? NOW - FULL_GRADE_F_CHARGE : options.start);
  user.office.rooms.find((room) => room.id === 1).unitUids = assigned ? ["9001"] : [];
  return user;
}

function unit(uid, unitId) {
  return {
    unitUid: String(uid),
    userUid: "9880000000003622",
    unitId,
    level: 1,
    exp: 0,
    limitBreakLevel: 0,
    skillLevels: [1, 1, 1, 1, 1],
    statExp: [0, 0, 0, 0, 0, 0],
    equipItemUids: [0, 0, 0, 0],
    loyalty: 0,
    officeRoomId: 0,
    officeGrade: 0,
    officeGaugeStartTime: "0",
  };
}

function request(unitUid) {
  return writeSignedVarLong(unitUid);
}

function send(payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([3622, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3622, sequence: 3622, payload }), true);
  assert.strictEqual(socket.response.packetId, 3623);
  const error = readSignedVarInt(socket.response.payload, 0);
  const unitPresent = readBool(socket.response.payload, error.offset).value;
  assert.strictEqual(unitPresent, error.value === 0, "take-heart ACK unit nullability must match success");
  return error.value;
}

function assertFailure(payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeMissions = missions.length;
  const beforePushes = missionPushes;
  assert.strictEqual(send(payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office heart error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(missions.length, beforeMissions);
  assert.strictEqual(missionPushes, beforePushes);
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
      assert(result.ok, `managed client schema rejected Office heart packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
