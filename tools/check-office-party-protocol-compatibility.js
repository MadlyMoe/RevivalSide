"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { ensureArmy } = require("../modules/unit");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const NOW = 639228400000000000n;
const gradeRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_GRADE_TEMPLET.json");
assert.deepStrictEqual(gradeRows.map((row) => row.ChargingTime), [72, 60, 48, 36, 24, 12]);
assert.deepStrictEqual(gradeRows.map((row) => row.PartyRewardLoyalty), [5, 20, 40, 60, 80, 100]);
assert.deepStrictEqual(gradeRows.map((row) => [row.PartyRewardValue_Min, row.PartyRewardValue_Max]), [
  [80, 280], [120, 280], [160, 280], [280, 400], [400, 480], [480, 560],
]);

const handler = createOfficeHandlers().find((entry) => entry.packetId === 3642);
const socket = { session: { user: makeUser() } };
const wire = [];
const missions = [];
let saves = 0;
let invalidations = 0;
let missionPushes = 0;
let randomCalls = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => NOW,
  decryptCopy: (payload) => payload,
  randomInt(maxExclusive) {
    randomCalls += 1;
    assert.strictEqual(maxExclusive, 201, "grade-F reward must roll the inclusive 80-280 range");
    return maxExclusive - 1;
  },
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

assert(handler, "missing Office party handler");
assertFailure(Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(Buffer.from([0x80]), 20191, makeUser(), false);
assertFailure(Buffer.concat([request(1), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(request(999999), 20847);
assertFailure(request(1), 21019, makeUser({ assigned: false }));
assertFailure(request(1), 21019, makeUser({ staleAssignment: true }));
assertFailure(request(1), 111, makeUser({ partyItemCount: 0 }));

const user = makeUser();
const beforeSaves = saves;
const beforeInvalidations = invalidations;
assert.strictEqual(send(request(1), user), 0);
assert.strictEqual(user.army.units["9001"].loyalty, 5005, "grade-F party must add the frozen five Loyalty units");
assert.strictEqual(user.army.units["9002"].loyalty, 10000, "party Loyalty must cap at the frozen maximum");
assert.deepStrictEqual(
  [getMiscItem(user, 37).countFree, getMiscItem(user, 37).countPaid],
  ["0", "1"],
  "party must spend one free resource before paid balance"
);
assert.strictEqual(getMiscItem(user, 3).countFree, "290", "inclusive upper roll must grant 280 item 3");
assert.strictEqual(randomCalls, 1);
assert.strictEqual(saves, beforeSaves + 1);
assert.strictEqual(invalidations, beforeInvalidations + 1);
assert.deepStrictEqual(
  missions.map(({ condition, amount, details }) => [condition, amount, details.itemId]),
  [["USE_RESOURCE", 1, 37]]
);
assert.strictEqual(missionPushes, 1);

const restarted = JSON.parse(JSON.stringify(user));
ensureArmy(restarted);
ensureOfficeState(restarted);
assert.strictEqual(restarted.army.units["9001"].loyalty, 5005);
assert.strictEqual(restarted.army.units["9002"].loyalty, 10000);
assert.strictEqual(getMiscItem(restarted, 37).countPaid, "1");
assert.strictEqual(getMiscItem(restarted, 3).countFree, "290");

validateManagedSchemas();
console.log(`[office-party-protocol-check] PASS failures=7 successes=1 saves=${saves} missions=${missions.length} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(options = {}) {
  const user = {
    userUid: "9880000000003642",
    nickname: "Office Owner",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: {
      units: {
        "9001": unit(9001, 1001, 5000),
        "9002": unit(9002, 1002, 9998),
      },
      ships: {},
      trophies: {},
      operators: {},
      squads: {},
    },
  };
  ensureArmy(user);
  ensureOfficeState(user);
  const assigned = options.assigned !== false;
  const room = user.office.rooms.find((entry) => entry.id === 1);
  room.unitUids = assigned ? ["9001", "9002"] : [];
  for (const uid of ["9001", "9002"]) {
    user.army.units[uid].officeRoomId = assigned ? 1 : 0;
    user.army.units[uid].officeGrade = 0;
  }
  if (options.staleAssignment) {
    room.unitUids = ["9001"];
    delete user.army.units["9001"];
    delete user.army.units["9002"];
  }
  const partyItemCount = options.partyItemCount == null ? 2 : options.partyItemCount;
  setMiscItemBalance(user, 37, partyItemCount > 0 ? 1 : 0, partyItemCount > 1 ? partyItemCount - 1 : 0, { regDate: NOW });
  setMiscItemBalance(user, 3, 10, 0, { regDate: NOW });
  return user;
}

function unit(uid, unitId, loyalty) {
  return {
    unitUid: String(uid),
    userUid: "9880000000003642",
    unitId,
    level: 1,
    exp: 0,
    limitBreakLevel: 0,
    skillLevels: [1, 1, 1, 1, 1],
    statExp: [0, 0, 0, 0, 0, 0],
    equipItemUids: [0, 0, 0, 0],
    loyalty,
    officeRoomId: 0,
    officeGrade: 0,
    officeGaugeStartTime: "0",
  };
}

function request(roomId) {
  return writeSignedVarInt(roomId);
}

function send(payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([3642, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3642, sequence: 3642, payload }), true);
  assert.strictEqual(socket.response.packetId, 3643);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeMissions = missions.length;
  const beforePushes = missionPushes;
  const beforeRandom = randomCalls;
  assert.strictEqual(send(payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office party error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  assert.strictEqual(missions.length, beforeMissions);
  assert.strictEqual(missionPushes, beforePushes);
  assert.strictEqual(randomCalls, beforeRandom);
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
      assert(result.ok, `managed client schema rejected Office party packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
