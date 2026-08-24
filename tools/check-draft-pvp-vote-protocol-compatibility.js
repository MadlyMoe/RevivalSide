"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  ERRORS,
  PACKETS,
  buildPvpCastingVoteData,
  getEligibility,
} = require("../modules/pvp-votes");
const {
  readBool,
  readSignedVarInt,
  readSignedVarIntList,
  writeIntList,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const specialist = "modules\\pvp-votes\\handlers\\0000-000-draft-pvp-casting-votes.js";
assert.strictEqual(handlers.get(PACKETS.UNIT_REQ).fileName, specialist);
assert.strictEqual(handlers.get(PACKETS.SHIP_REQ).fileName, specialist);

const eligibility = getEligibility();
assert.strictEqual(eligibility.unitIds.size, 253, "frozen eligible draft-unit count changed");
assert.strictEqual(eligibility.shipGroupIds.size, 21, "frozen eligible draft-ship-group count changed");
const unitIds = [...eligibility.unitIds];
const shipGroupIds = [...eligibility.shipGroupIds];
assert(unitIds.length >= 4 && shipGroupIds.length >= 2);

const user = {
  userUid: "2690001",
  pvpDraftVoteData: { unitIdList: [], shipGroupIdList: [], operatorIdList: [77] },
};
const socket = { session: { user } };
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(_socket, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};

failure("truncated unit list", PACKETS.UNIT_REQ, Buffer.from([0x80]), ERRORS.INVALID_REQUEST, false);
failure("trailing unit list", PACKETS.UNIT_REQ, Buffer.concat([writeIntList(unitIds.slice(0, 2)), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
failure("wrong unit count", PACKETS.UNIT_REQ, writeIntList([unitIds[0]]), ERRORS.INVALID_VOTE_COUNT);
failure("duplicate units", PACKETS.UNIT_REQ, writeIntList([unitIds[0], unitIds[0]]), ERRORS.DUPLICATED_VOTE);
failure("invalid unit", PACKETS.UNIT_REQ, writeIntList([unitIds[0], 999999]), ERRORS.INVALID_UNIT_ID);
failure("wrong ship count", PACKETS.SHIP_REQ, writeIntList([]), ERRORS.INVALID_VOTE_COUNT);
failure("invalid ship group", PACKETS.SHIP_REQ, writeIntList([999999]), ERRORS.INVALID_UNIT_ID);
assert.deepStrictEqual([saves, invalidations], [0, 0]);

invoke(PACKETS.UNIT_REQ, writeIntList(unitIds.slice(0, 2)));
assertVoteAck(PACKETS.UNIT_ACK, ERRORS.OK, unitIds.slice(0, 2), [], [77]);
assert.deepStrictEqual(user.pvpDraftVoteData, {
  unitIdList: unitIds.slice(0, 2),
  shipGroupIdList: [],
  operatorIdList: [77],
});
assert.deepStrictEqual([saves, invalidations], [1, 1]);

invoke(PACKETS.UNIT_REQ, writeIntList(unitIds.slice(0, 2)));
assertVoteAck(PACKETS.UNIT_ACK, ERRORS.OK, unitIds.slice(0, 2), [], [77]);
assert.deepStrictEqual([saves, invalidations], [1, 1], "identical vote must be save-free");

invoke(PACKETS.SHIP_REQ, writeIntList([shipGroupIds[0]]));
assertVoteAck(PACKETS.SHIP_ACK, ERRORS.OK, unitIds.slice(0, 2), [shipGroupIds[0]], [77]);
assert.deepStrictEqual([saves, invalidations], [2, 2]);

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(
  buildPvpCastingVoteData(restarted.pvpDraftVoteData),
  buildPvpCastingVoteData(user.pvpDraftVoteData),
  "draft vote state must survive JSON restart"
);
socket.session.user = restarted;
invoke(PACKETS.UNIT_REQ, writeIntList(unitIds.slice(2, 4)));
assertVoteAck(PACKETS.UNIT_ACK, ERRORS.OK, unitIds.slice(2, 4), [shipGroupIds[0]], [77]);
assert.deepStrictEqual([saves, invalidations], [3, 3]);

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert.match(
  listenerSource,
  /writeNullableObject\(draftPvpVotes\.buildPvpCastingVoteData\(user && user\.pvpDraftVoteData\)\), \/\/ pvpDraftVoteData/,
  "JOIN_LOBBY must publish persisted draft vote state"
);
const managedBridgeSource = fs.readFileSync(path.join(rootDir, "combat-host", "ManagedCombatBridge.cs"), "utf8");
assert.match(
  managedBridgeSource,
  /LocalJoinLobbyFields\s*=\s*\[[\s\S]*?"pvpDraftVoteData"[\s\S]*?\];/,
  "managed JOIN merge must retain local draft vote state"
);

validateManagedSchemas();
console.log(
  `[draft-pvp-vote-check] PASS units=${eligibility.unitIds.size} shipGroups=${eligibility.shipGroupIds.size} saves=${saves} packets=${managedWire.length} managed=on`
);

function invoke(packetId, payload, validateRequest = true) {
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `packet ${packetId} must respond`);
}

function failure(label, packetId, payload, expectedError, validateRequest = true) {
  const before = JSON.stringify(socket.session.user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, payload, validateRequest);
  assertVoteAck(packetId + 1, expectedError, [], [], []);
  assert.strictEqual(JSON.stringify(socket.session.user), before, `${label} must not mutate state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
}

function assertVoteAck(packetId, errorCode, units, ships, operators) {
  assert.strictEqual(response.packetId, packetId);
  let read = readSignedVarInt(response.payload, 0);
  assert.strictEqual(read.value, errorCode);
  const present = readBool(response.payload, read.offset);
  assert.strictEqual(present.value, true, "casting vote ACK data must be non-null");
  const decoded = [];
  read = present;
  for (let index = 0; index < 3; index += 1) {
    read = readSignedVarIntList(response.payload, read.offset);
    decoded.push(read.value);
  }
  assert.deepStrictEqual(decoded, [units, ships, operators]);
  assert.strictEqual(read.offset, response.payload.length, "casting vote ACK must have exact framing");
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Draft-PvP vote schema validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Draft-PvP packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
