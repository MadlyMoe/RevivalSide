"use strict";

const assert = require("assert");
const path = require("path");
const {
  COLLECTION_ERRORS,
  PACKETS,
  buildTeamCollectionEntries,
  createCollectionHandlers,
} = require("../modules/collection");
const { getMiscItem } = require("../modules/inventory");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const rows = readGameplayTableRecords("ab_script", "LUA_COLLECTION_TEAMUP_TEMPLET.json", {
  rootDir,
  logLabel: "team-collection-check",
});
const byTeam = new Map();
for (const row of rows) {
  const teamId = Number(row && row.m_TeamID);
  const unitId = Number(row && row.m_UnitID);
  if (!teamId || !unitId) continue;
  const team = byTeam.get(teamId) || {
    teamId,
    unitIds: [],
    criteria: Number(row.m_RewardCriteria || 0),
    rewardId: Number(row.m_RewardID || 0),
    rewardValue: Number(row.m_RewardValue || 0),
  };
  if (!team.unitIds.includes(unitId)) team.unitIds.push(unitId);
  byTeam.set(teamId, team);
}
const fixture = Array.from(byTeam.values()).find(
  (team) => team.criteria > 0 && team.unitIds.length >= team.criteria && team.rewardId > 0 && team.rewardValue > 0
);
assert(fixture, "frozen team collection table must contain a claimable reward fixture");

const user = {
  userUid: "986000000000001",
  nickname: "TeamCollectionCheck",
  army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [] },
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
};
const socket = { session: { user } };
const handler = createCollectionHandlers().find((entry) => entry.packetId === PACKETS.TEAM_COLLECTION_REWARD_REQ);
assert(handler, "team collection handler must be registered");
const managedWire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 5250083637907387904n,
  sendGameResponse(target, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(Buffer.alloc(0), false);
assertAck(COLLECTION_ERRORS.TEAM_INVALID_ID);
send(Buffer.concat([writeSignedVarInt(fixture.teamId), Buffer.from([0])]), false);
assertAck(COLLECTION_ERRORS.TEAM_INVALID_ID);
send(writeSignedVarInt(999999999));
assertAck(COLLECTION_ERRORS.TEAM_INVALID_ID);
send(writeSignedVarInt(fixture.teamId));
assertAck(COLLECTION_ERRORS.TEAM_NOT_ENOUGH_COUNT);
assert.strictEqual(saves, 0, "rejected team collection claims must not persist");

fixture.unitIds.slice(0, fixture.criteria).forEach((unitId, index) => {
  const unitUid = String(9000000000000001n + BigInt(index));
  user.army.units[unitUid] = { unitUid, userUid: user.userUid, unitId, level: 1 };
});

send(writeSignedVarInt(fixture.teamId));
assertAck(COLLECTION_ERRORS.OK);
assert.strictEqual(getMiscItem(user, fixture.rewardId).countFree, String(fixture.rewardValue));
assert.deepStrictEqual(buildTeamCollectionEntries(user).map(([teamId]) => teamId), [fixture.teamId]);
assert.strictEqual(saves, 1, "a successful team collection claim must persist once");

send(writeSignedVarInt(fixture.teamId));
assertAck(COLLECTION_ERRORS.TEAM_ALREADY_GIVEN);
assert.strictEqual(getMiscItem(user, fixture.rewardId).countFree, String(fixture.rewardValue));
assert.strictEqual(saves, 1, "duplicate team collection claims must not grant or persist");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(buildTeamCollectionEntries(restarted).map(([teamId]) => teamId), [fixture.teamId]);
assert.strictEqual(getMiscItem(restarted, fixture.rewardId).countFree, String(fixture.rewardValue));

validateManagedSchemas();
console.log(`[team-collection-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.TEAM_COLLECTION_REWARD_REQ, payload]);
  assert.strictEqual(
    handler.handle(ctx, socket, { packetId: PACKETS.TEAM_COLLECTION_REWARD_REQ, sequence: 1, payload }),
    true
  );
}

function assertAck(expectedError) {
  assert(response, "team collection handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.TEAM_COLLECTION_REWARD_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  if (expectedError !== COLLECTION_ERRORS.OK) {
    assert.deepStrictEqual(
      Array.from(response.payload.subarray(error.offset)),
      [0, 0],
      "failed team collection ACKs must carry null reward and collection objects"
    );
  }
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
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected team collection packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
