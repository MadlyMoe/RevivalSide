"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  CASTING_VOTE_COUNT,
  ERRORS,
  PACKETS,
  buildPvpCastingVoteData,
  getStandardEligibility,
} = require("../modules/pvp-votes");
const {
  readBool,
  readSignedVarInt,
  readSignedVarIntList,
  writeIntList,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const specialist = "modules\\pvp-votes\\handlers\\0000-000-draft-pvp-casting-votes.js";
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
for (const packetId of [PACKETS.CASTING_UNIT_REQ, PACKETS.CASTING_SHIP_REQ, PACKETS.CASTING_OPERATOR_REQ]) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `packet ${packetId} specialist precedence`);
}
assert.deepStrictEqual(
  { count: CASTING_VOTE_COUNT, ...pickErrors() },
  { count: 3, invalidCount: 20977, duplicate: 20978, invalidId: 20979 }
);
const common = require("../gameplay-jsons/StreamingAssets/ab_script/luac/LUA_COMMON_CONST.json");
assert.deepStrictEqual(common.globals.CastingBan, { MaxBanCount: 3, MaxBanLevel: 1 });

const allTags = [...new Set([
  ...getPlayableUnitIds({ includeNonContractable: true }),
  ...getPlayableShipIds({ includeNonContractable: true }),
  ...getPlayableOperatorIds(),
].map((id) => String(getUnitTemplet(id).m_FirstOpenTag || "")).filter(Boolean))];
const user = {
  userUid: "2661001",
  openTags: allTags.slice(),
  pvpCastingVoteData: { unitIdList: [], shipGroupIdList: [], operatorIdList: [] },
};
const socket = { session: { user } };
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  getEffectiveOpenTags(tags) { return tags; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(_socket, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};
const eligibility = getStandardEligibility(ctx, user);
assert.strictEqual(eligibility.unitIds.size, 299, "frozen standard-vote unit count changed");
assert.strictEqual(eligibility.shipGroupIds.size, 33, "frozen standard-vote ship-group count changed");
assert.strictEqual(eligibility.operatorIds.size, 41, "frozen standard-vote operator count changed");
const unitIds = [...eligibility.unitIds];
const shipGroupIds = [...eligibility.shipGroupIds];
const operatorIds = [...eligibility.operatorIds];

failure("truncated list", PACKETS.CASTING_UNIT_REQ, Buffer.from([0x80]), ERRORS.INVALID_REQUEST, false);
failure("trailing list", PACKETS.CASTING_UNIT_REQ, Buffer.concat([writeIntList(unitIds.slice(0, 3)), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
failure("noncanonical list", PACKETS.CASTING_UNIT_REQ, noncanonicalList(unitIds.slice(0, 3)), ERRORS.INVALID_REQUEST, false);
failure("short list", PACKETS.CASTING_UNIT_REQ, writeIntList(unitIds.slice(0, 2)), ERRORS.INVALID_VOTE_COUNT);
failure("long list", PACKETS.CASTING_UNIT_REQ, writeIntList(unitIds.slice(0, 4)), ERRORS.INVALID_VOTE_COUNT);
failure("duplicate units", PACKETS.CASTING_UNIT_REQ, writeIntList([unitIds[0], unitIds[0], unitIds[1]]), ERRORS.DUPLICATED_VOTE);
failure("invalid unit", PACKETS.CASTING_UNIT_REQ, writeIntList([unitIds[0], unitIds[1], 999999]), ERRORS.INVALID_UNIT_ID);
failure("invalid ship group", PACKETS.CASTING_SHIP_REQ, writeIntList([shipGroupIds[0], shipGroupIds[1], 999999]), ERRORS.INVALID_UNIT_ID);
failure("invalid operator", PACKETS.CASTING_OPERATOR_REQ, writeIntList([operatorIds[0], operatorIds[1], 999999]), ERRORS.INVALID_UNIT_ID);

const closedTag = String(getUnitTemplet(unitIds[0]).m_FirstOpenTag || "");
const closedCtx = { ...ctx, getEffectiveOpenTags(tags) { return tags.filter((tag) => tag !== closedTag); } };
failure("closed content tag", PACKETS.CASTING_UNIT_REQ, writeIntList(unitIds.slice(0, 3)), ERRORS.INVALID_UNIT_ID, true, closedCtx);
assert.deepStrictEqual([saves, invalidations], [0, 0]);

invoke(PACKETS.CASTING_UNIT_REQ, writeIntList(unitIds.slice(0, 3)));
assertVoteAck(PACKETS.CASTING_UNIT_ACK, ERRORS.OK, unitIds.slice(0, 3), [], []);
assert.deepStrictEqual([saves, invalidations], [1, 1]);
invoke(PACKETS.CASTING_UNIT_REQ, writeIntList(unitIds.slice(0, 3)));
assert.deepStrictEqual([saves, invalidations], [1, 1], "identical vote must be save-free");

invoke(PACKETS.CASTING_SHIP_REQ, writeIntList(shipGroupIds.slice(0, 3)));
assertVoteAck(PACKETS.CASTING_SHIP_ACK, ERRORS.OK, unitIds.slice(0, 3), shipGroupIds.slice(0, 3), []);
invoke(PACKETS.CASTING_OPERATOR_REQ, writeIntList(operatorIds.slice(0, 3)));
assertVoteAck(PACKETS.CASTING_OPERATOR_ACK, ERRORS.OK, unitIds.slice(0, 3), shipGroupIds.slice(0, 3), operatorIds.slice(0, 3));
assert.deepStrictEqual([saves, invalidations], [3, 3]);

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(
  buildPvpCastingVoteData(restarted.pvpCastingVoteData),
  buildPvpCastingVoteData(user.pvpCastingVoteData),
  "standard vote state must survive JSON restart"
);
socket.session.user = restarted;
invoke(PACKETS.CASTING_OPERATOR_REQ, writeIntList(operatorIds.slice(3, 6)));
assertVoteAck(PACKETS.CASTING_OPERATOR_ACK, ERRORS.OK, unitIds.slice(0, 3), shipGroupIds.slice(0, 3), operatorIds.slice(3, 6));
assert.deepStrictEqual([saves, invalidations], [4, 4]);

assertJoinHydrationSources();
validateManagedSchemas();
console.log(`[pvp-casting-vote-check] PASS units=${eligibility.unitIds.size} shipGroups=${eligibility.shipGroupIds.size} operators=${eligibility.operatorIds.size} saves=${saves} packets=${managedWire.length} managed=on`);

function invoke(packetId, payload, validateRequest = true, context = ctx) {
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(context, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `packet ${packetId} must respond`);
}

function failure(label, packetId, payload, expectedError, validateRequest = true, context = ctx) {
  const before = JSON.stringify(socket.session.user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, payload, validateRequest, context);
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

function noncanonicalList(ids) {
  return Buffer.concat([Buffer.from([0x83, 0]), ...ids.map(writeSignedVarInt)]);
}

function pickErrors() {
  return {
    invalidCount: ERRORS.INVALID_VOTE_COUNT,
    duplicate: ERRORS.DUPLICATED_VOTE,
    invalidId: ERRORS.INVALID_UNIT_ID,
  };
}

function assertJoinHydrationSources() {
  const listener = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
  assert.match(
    listener,
    /writeNullableObject\(draftPvpVotes\.buildPvpCastingVoteData\(user && user\.pvpCastingVoteData\)\), \/\/ pvpCastingVoteData/,
    "shared JOIN_LOBBY must publish persisted standard vote state"
  );
  const bridge = fs.readFileSync(path.join(rootDir, "combat-host", "ManagedCombatBridge.cs"), "utf8");
  assert.match(
    bridge,
    /LocalJoinLobbyFields\s*=\s*\[[\s\S]*?"pvpCastingVoteData"[\s\S]*?"pvpDraftVoteData"[\s\S]*?\];/,
    "managed official-payload merge must retain both local casting-vote fields"
  );
  const popup = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "UI", "Gauntlet", "NKCPopupGauntletCastingBan.cs"), "utf8");
  assert.match(popup, /private const int MAX_CASTING_BAN_CNT = 3/);
  assert.match(popup, /iMaxMultipleSelect = 3/);
  assert.match(popup, /PickupEnableByTag[\s\S]*Send_NKMPacket_PVP_CASTING_VOTE_UNIT_REQ[\s\S]*Send_NKMPacket_PVP_CASTING_VOTE_SHIP_REQ[\s\S]*Send_NKMPacket_PVP_CASTING_VOTE_OPERATOR_REQ/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for standard PvP vote schema validation");
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
      assert(result.ok, `managed client schema rejected PvP casting-vote packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
