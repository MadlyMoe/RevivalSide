"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getPlayableShipIds, getTrophyUnitIds } = require("../modules/game-data");
const { ensureArmy, ensureDeck, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.UNIT_TACTIC_UPDATE_REQ);
assert(handler, "unit-tactic-update handler must be registered");

const managedWire = [];
let fixtureId = 0n;
let runtimeOpenTags = [];
let response = null;
let saves = 0;
let invalidations = 0;
let missionEvents = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags],
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "tactic-update");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition) {
    assert.strictEqual(condition, "UNIT_GROWTH_TACTICAL");
    missionEvents += 1;
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

failure("truncated", normalFixture, Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure("trailing", normalFixture, (user) => Buffer.concat([request(user.target.unitUid, [user.donor.unitUid]), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("zero target", normalFixture, (user) => request(0, [user.donor.unitUid]), ERROR_CODES.INVALID_REQUEST);
failure("empty donors", normalFixture, (user) => request(user.target.unitUid, []), ERROR_CODES.INVALID_REQUEST);
failure("duplicate donor", normalFixture, (user) => request(user.target.unitUid, [user.donor.unitUid, user.donor.unitUid]), ERROR_CODES.INVALID_REQUEST);
failure("target as donor", normalFixture, (user) => request(user.target.unitUid, [user.target.unitUid]), ERROR_CODES.INVALID_REQUEST);
failure("missing target", normalFixture, (user) => request(999999999, [user.donor.unitUid]), ERROR_CODES.UNIT_NOT_EXIST);
failure("missing donor", normalFixture, (user) => request(user.target.unitUid, [999999999]), ERROR_CODES.UNIT_NOT_EXIST);
failure("mismatched base", () => normalFixture({ donorId: 1004 }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.TACTIC_INVALID_BASE_UNIT);
failure("already max", () => normalFixture({ targetOptions: { tacticLevel: 6 } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.TACTIC_ALREADY_MAX_LEVEL);
failure("seized target", () => normalFixture({ mutate(user) { rawUnit(user, user.target).isSeized = true; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.TACTIC_NOT_AVAILABLE);
failure("ship target", shipTargetFixture, (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.UNIT_BAD_TYPE);
failure("trainer donor", trophyDonorFixture, (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.TACTIC_INVALID_BASE_UNIT);
failure("seized donor", () => normalFixture({ mutate(user) { rawUnit(user, user.donor).isSeized = true; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.TACTIC_NOT_AVAILABLE);
failure("physical donor overflow", () => normalFixture({ targetOptions: { tacticLevel: 5 }, extraDonor: true }), (user) => request(user.target.unitUid, [user.donor.unitUid, user.extraDonor.unitUid]), ERROR_CODES.INVALID_REQUEST);
failure("locked donor", () => normalFixture({ mutate(user) { rawUnit(user, user.donor).locked = true; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.UNIT_LOCKED);
failure("lobby donor", () => normalFixture({ mutate(user) { user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: user.donor.unitUid }] } }; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.UNIT_IS_LOBBY_UNIT);
failure("deck donor", () => normalFixture({ mutate(user) { ensureDeck(user, { deckType: 1, index: 0 }).unitUids[0] = user.donor.unitUid; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.UNIT_IN_DECK);
failure("equipped donor", () => normalFixture({ mutate(user) { rawUnit(user, user.donor).equipItemUids[0] = "8800000000000001"; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.UNIT_EQUIP_ITEM);
failure("world-map donor", () => normalFixture({ mutate(user) { user.worldMap = { cities: { 1: { leaderUnitUID: user.donor.unitUid } } }; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.UNIT_IS_WORLDMAP_LEADER);
failure("office donor", () => normalFixture({ mutate(user) { user.office = { rooms: [{ id: 1, unitUids: [user.donor.unitUid] }] }; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.OFFICE_UNIT_DELETE_IN_ROOM);
failure("support donor", () => normalFixture({ mutate(user) { user.support = { mySupportUnitUid: user.donor.unitUid }; } }), (user) => request(user.target.unitUid, [user.donor.unitUid]), ERROR_CODES.CONTAIN_SUPPORT_UNIT);
failure("atomic donor validation", atomicFixture, (user) => request(user.target.unitUid, [user.donor.unitUid, user.blockedDonor.unitUid]), ERROR_CODES.UNIT_LOCKED);
assertNoMutations();

const legacy = normalFixture({
  targetOptions: { level: 10, exp: 5, limitBreakLevel: 1, loyalty: 100, skillLevels: [1, 2, 1, 1, 1], tacticLevel: 1 },
  donorOptions: { level: 20, exp: 7, limitBreakLevel: 3, loyalty: 700, skillLevels: [5, 5, 5, 5, 5], tacticLevel: 4 },
});
runtimeOpenTags = [];
socket.session.user = legacy;
send(request(legacy.target.unitUid, [legacy.donor.unitUid]));
const legacyUnit = getArmyUnitByUid(legacy, legacy.target.unitUid);
assertUnitGrowth(legacyUnit, { level: 10, exp: 5, limitBreakLevel: 1, loyalty: 100, skillLevels: [1, 2, 1, 1, 1], tacticLevel: 2 });
assert.strictEqual(getArmyUnitByUid(legacy, legacy.donor.unitUid), null);
assertSuccess(legacyUnit, [legacy.donor.unitUid]);
assertMutations(1);

const preserved = createUser("986000000000041", "TacticPreserveCheck");
runtimeOpenTags = ["LIMITBREAK_KEEP_LEVEL"];
preserved.target = grantUnit(preserved, 1001, {
  level: 10,
  exp: 5,
  limitBreakLevel: 1,
  loyalty: 100,
  skillLevels: [1, 2, 1, 1, 1],
  tacticLevel: 1,
});
preserved.donor = grantUnit(preserved, 1001, {
  level: 20,
  exp: 7,
  limitBreakLevel: 3,
  loyalty: 500,
  skillLevels: [2, 3, 1, 4, 1],
  tacticLevel: 2,
});
preserved.rearmDonor = grantUnit(preserved, 2001, {
  level: 15,
  exp: 9,
  limitBreakLevel: 2,
  loyalty: 700,
  skillLevels: [3, 2, 5, 1, 2],
  tacticLevel: 1,
});
assert(preserved.target && preserved.donor && preserved.rearmDonor, "frozen base/rearm fixtures must exist");
socket.session.user = preserved;
send(request(preserved.target.unitUid, [preserved.donor.unitUid, preserved.rearmDonor.unitUid]));
const preservedUnit = getArmyUnitByUid(preserved, preserved.target.unitUid);
assertUnitGrowth(preservedUnit, {
  level: 20,
  exp: 7,
  limitBreakLevel: 3,
  loyalty: 700,
  skillLevels: [3, 3, 5, 4, 2],
  tacticLevel: 6,
});
assert.strictEqual(getArmyUnitByUid(preserved, preserved.donor.unitUid), null);
assert.strictEqual(getArmyUnitByUid(preserved, preserved.rearmDonor.unitUid), null);
assertSuccess(preservedUnit, [preserved.donor.unitUid, preserved.rearmDonor.unitUid]);
assertMutations(2);

const restarted = JSON.parse(JSON.stringify(preserved));
const restartedUnit = getArmyUnitByUid(restarted, preserved.target.unitUid);
assertUnitGrowth(restartedUnit, {
  level: 20,
  exp: 7,
  limitBreakLevel: 3,
  loyalty: 700,
  skillLevels: [3, 3, 5, 4, 2],
  tacticLevel: 6,
});
assert.strictEqual(getArmyUnitByUid(restarted, preserved.donor.unitUid), null);
assert.strictEqual(getArmyUnitByUid(restarted, preserved.rearmDonor.unitUid), null);

validateManagedSchemas();
console.log(`[unit-tactic-update-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser(userUid, nickname) {
  return { userUid, nickname };
}

function normalFixture(options = {}) {
  fixtureId += 1n;
  const user = createUser(String(986000000000100n + fixtureId), "TacticFailureCheck");
  user.target = grantUnit(user, options.targetId || 1001, options.targetOptions || { tacticLevel: 1 });
  user.donor = grantUnit(user, options.donorId || 1001, options.donorOptions || {});
  if (options.extraDonor) user.extraDonor = grantUnit(user, options.donorId || 1001);
  assert(user.target && user.donor && (!options.extraDonor || user.extraDonor));
  if (options.mutate) options.mutate(user);
  return user;
}

function shipTargetFixture() {
  const user = createUser("986000000000042", "TacticShipCheck");
  user.target = grantUnit(user, getPlayableShipIds()[0]);
  user.donor = grantUnit(user, 1001);
  assert(user.target && user.donor);
  return user;
}

function trophyDonorFixture() {
  const user = createUser("986000000000043", "TacticTrophyCheck");
  user.target = grantUnit(user, 1001);
  user.donor = grantUnit(user, getTrophyUnitIds()[0]);
  assert(user.target && user.donor);
  return user;
}

function atomicFixture() {
  const user = normalFixture({ extraDonor: true });
  user.blockedDonor = user.extraDonor;
  rawUnit(user, user.blockedDonor).locked = true;
  return user;
}

function rawUnit(user, unit) {
  return user.army.units[String(unit.unitUid)] || user.army.ships[String(unit.unitUid)] || user.army.trophies[String(unit.unitUid)];
}

function failure(_name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  ensureArmy(user);
  socket.session.user = user;
  const before = JSON.parse(JSON.stringify(user));
  const payload = typeof makePayload === "function" ? makePayload(user) : makePayload;
  send(payload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${_name} must not mutate user state`);
}

function request(targetUid, donorUids) {
  const donors = Array.isArray(donorUids) ? donorUids : [];
  return Buffer.concat([
    writeSignedVarLong(BigInt(targetUid)),
    writeRawVarInt(donors.length),
    ...donors.map((uid) => writeSignedVarLong(BigInt(uid))),
  ]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.UNIT_TACTIC_UPDATE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.UNIT_TACTIC_UPDATE_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(expectedError) {
  assert(response, "unit-tactic-update handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.UNIT_TACTIC_UPDATE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, false);
  const count = readRawVarInt(response.payload, present.offset);
  assert.strictEqual(count.value, 0);
  assert.strictEqual(count.offset, response.payload.length, "failed tactic ACK must contain no trailing fields");
}

function assertSuccess(expectedUnit, expectedDonors) {
  assert.strictEqual(response.packetId, PACKETS.UNIT_TACTIC_UPDATE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, ERROR_CODES.OK);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, true);
  const decoded = readUnitData(response.payload, present.offset);
  assert.strictEqual(decoded.unitUid.toString(), String(expectedUnit.unitUid));
  assert.strictEqual(decoded.unitId, Number(expectedUnit.unitId));
  assertUnitGrowth(decoded, expectedUnit);
  const count = readRawVarInt(response.payload, decoded.offset);
  let offset = count.offset;
  const donors = [];
  for (let index = 0; index < count.value; index += 1) {
    const uid = readSignedVarLong(response.payload, offset);
    donors.push(uid.value.toString());
    offset = uid.offset;
  }
  assert.deepStrictEqual(donors, expectedDonors.map(String));
  assert.strictEqual(offset, response.payload.length, "successful tactic ACK must contain no trailing fields");
}

function assertUnitGrowth(actual, expected) {
  for (const field of ["level", "exp", "limitBreakLevel", "loyalty", "tacticLevel"]) {
    assert.strictEqual(Number(actual[field]), Number(expected[field]), `unexpected ${field}`);
  }
  assert.deepStrictEqual(actual.skillLevels.map(Number), expected.skillLevels.map(Number));
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = unitUid.offset;
  offset = readSignedVarLong(payload, offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  const level = readSignedVarInt(payload, unitId.offset);
  const exp = readSignedVarInt(payload, level.offset);
  offset = readSignedVarInt(payload, exp.offset).offset;
  offset += 4;
  const limitBreakLevel = readSignedVarInt(payload, offset);
  offset = readBool(payload, limitBreakLevel.offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipFloatList(payload, offset);
  const skills = readIntList(payload, offset);
  offset = skipLongList(payload, skills.offset);
  const loyalty = readSignedVarInt(payload, offset);
  offset = readBool(payload, loyalty.offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipShipModuleList(payload, offset);
  const tacticLevel = readSignedVarInt(payload, offset);
  const reactorLevel = readSignedVarInt(payload, tacticLevel.offset);
  return {
    unitUid: unitUid.value,
    unitId: unitId.value,
    level: level.value,
    exp: exp.value,
    limitBreakLevel: limitBreakLevel.value,
    skillLevels: skills.values,
    loyalty: loyalty.value,
    tacticLevel: tacticLevel.value,
    reactorLevel: reactorLevel.value,
    offset: reactorLevel.offset,
  };
}

function skipShipModuleList(payload, startOffset) {
  const modules = readRawVarInt(payload, startOffset);
  let offset = modules.offset;
  for (let moduleIndex = 0; moduleIndex < modules.value; moduleIndex += 1) {
    const modulePresent = readBool(payload, offset);
    offset = modulePresent.offset;
    if (!modulePresent.value) continue;
    const slots = readRawVarInt(payload, offset);
    offset = slots.offset;
    for (let slotIndex = 0; slotIndex < slots.value; slotIndex += 1) {
      const slotPresent = readBool(payload, offset);
      offset = slotPresent.offset;
      if (!slotPresent.value) continue;
      offset = skipIntList(payload, offset);
      offset = skipIntList(payload, offset);
      offset = readSignedVarInt(payload, offset).offset + 4;
      offset = readBool(payload, offset).offset;
    }
  }
  return offset;
}

function readIntList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readSignedVarInt(payload, offset);
    values.push(value.value);
    offset = value.offset;
  }
  return { values, offset };
}

function skipIntList(payload, startOffset) {
  return readIntList(payload, startOffset).offset;
}

function skipFloatList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  return count.offset + count.value * 4;
}

function skipLongList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(payload, offset).offset;
  return offset;
}

function writeRawVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function readRawVarInt(buffer, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (shift < 32) {
    assert(offset < buffer.length, "truncated unsigned varint");
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("unsigned varint too long");
}

function assertNoMutations() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.strictEqual(missionEvents, 0);
}

function assertMutations(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
  assert.strictEqual(missionEvents, expected);
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
      assert(result.ok, `managed client schema rejected tactic-update packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
