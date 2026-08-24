"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const {
  getPlayableShipIds,
  getTrophyUnitIds,
  getUnitExtractBonusRewards,
  getUnitExtractConfig,
  getUnitExtractRewards,
  getUnitTemplet,
  loadGameData,
} = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureArmy, ensureDeck, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const config = getUnitExtractConfig();
const bonusRewards = getUnitExtractBonusRewards();
const templets = Array.from(loadGameData().unitById.values());
const extractable = templets.filter(isExtractableFixture);
const srFixtureId = findFixture((record) => record.m_NKM_UNIT_GRADE === "NUG_SR" && record.m_bAwaken !== true).m_UnitID;
const ssrFixtureId = findFixture((record) => record.m_NKM_UNIT_GRADE === "NUG_SSR" && record.m_bAwaken !== true).m_UnitID;
const awakenFixtureId = findFixture((record) => record.m_bAwaken === true).m_UnitID;
const lowGradeId = templets.find((record) => record.m_NKM_UNIT_TYPE === "NUT_NORMAL" && record.m_NKM_UNIT_GRADE === "NUG_R").m_UnitID;
const noRewardId = templets.find((record) =>
  isEligibleShape(record) && getUnitExtractRewards(record.m_UnitID, { fromContract: false }).length === 0
).m_UnitID;
const shipId = getPlayableShipIds()[0];
const trophyId = getTrophyUnitIds()[0];
const roleFixtureIds = [];
for (const record of extractable) {
  if (!roleFixtureIds.some((unitId) => getUnitTemplet(unitId).m_NKM_UNIT_ROLE_TYPE === record.m_NKM_UNIT_ROLE_TYPE)) {
    roleFixtureIds.push(record.m_UnitID);
  }
}
assert.strictEqual(config.maxUnitSelect, 5, "frozen extraction selection limit must remain five");
assert.strictEqual(bonusRewards.reduce((total, reward) => total + reward.weight, 0), 10000);
assert(roleFixtureIds.length >= config.maxUnitSelect, "frozen unit table must expose five distinct extraction roles");
assert(srFixtureId && ssrFixtureId && awakenFixtureId && lowGradeId && noRewardId && shipId && trophyId);

const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.EXTRACT_UNIT_REQ);
assert(handler, "unit-extract handler must be registered");
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
let fixtureId = 0n;
let runtimeOpenTags = ["REARMAMENT_EXTRACT"];
let randomRolls = [];
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags],
  randomInt(max) {
    assert(randomRolls.length > 0, `unexpected extraction random roll max=${max}`);
    const value = randomRolls.shift();
    assert(value >= 0 && value < max, `queued extraction roll ${value} must be below ${max}`);
    return value;
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-extract");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

failure("truncated", () => ({ user: createUser() }), Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure("trailing", makeFixture, (state) => Buffer.concat([request([state.unit.unitUid]), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("empty", makeFixture, () => request([]), ERROR_CODES.INVALID_REQUEST);
failure("duplicate", makeFixture, (state) => request([state.unit.unitUid, state.unit.unitUid]), ERROR_CODES.INVALID_REQUEST);
failure("zero uid", makeFixture, () => request([0]), ERROR_CODES.INVALID_REQUEST);
failure("over client maximum", makeFixture, () => request(Array.from({ length: 6 }, (_, index) => 9000000 + index)), ERROR_CODES.INVALID_REQUEST);
failure("system tag closed", makeFixture, (state) => request([state.unit.unitUid]), ERROR_CODES.OPENTAG_CLOSED, true, []);
failure("missing unit atomicity", makeTwoFixture, (state) => request([state.first.unitUid, 999999999]), ERROR_CODES.UNIT_NOT_EXIST);
failure("ship roster type", () => makeFixture({ unitId: shipId }), (state) => request([state.unit.unitUid]), ERROR_CODES.EXTRACT_UNIT_CONDITION);
failure("trainer roster type", () => makeFixture({ unitId: trophyId }), (state) => request([state.unit.unitUid]), ERROR_CODES.EXTRACT_UNIT_CONDITION);
failure("grade below SR", () => makeFixture({ unitId: lowGradeId }), (state) => request([state.unit.unitUid]), ERROR_CODES.EXTRACT_UNIT_CONDITION);
failure("missing extraction reward", () => makeFixture({ unitId: noRewardId }), (state) => request([state.unit.unitUid]), ERROR_CODES.CANNOT_EXTRACT_UNIT);
failure("seized", () => makeFixture({ mutate(unit) { unit.isSeized = true; } }), (state) => request([state.unit.unitUid]), ERROR_CODES.UNIT_IS_SEIZED);
failure("protected starter", () => makeFixture({ unitId: 1001 }), (state) => request([state.unit.unitUid]), ERROR_CODES.DELETE_EXCLUDE_UNIT);
failure("locked", () => makeFixture({ mutate(unit) { unit.locked = true; } }), (state) => request([state.unit.unitUid]), ERROR_CODES.UNIT_LOCKED);
failure(
  "lobby background",
  () => makeFixture({ mutate(unit, user) { user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: unit.unitUid }] } }; } }),
  (state) => request([state.unit.unitUid]),
  ERROR_CODES.UNIT_IS_LOBBY_UNIT
);
failure(
  "decked",
  () => makeFixture({ mutate(unit, user) { ensureDeck(user, { deckType: 1, index: 0 }).unitUids[0] = unit.unitUid; } }),
  (state) => request([state.unit.unitUid]),
  ERROR_CODES.UNIT_IN_DECK
);
failure("equipped", () => makeFixture({ mutate(unit) { unit.equipItemUids[0] = "8800000000000001"; } }), (state) => request([state.unit.unitUid]), ERROR_CODES.UNIT_EQUIP_ITEM);
failure(
  "world-map leader",
  () => makeFixture({ mutate(unit, user) { user.worldMap = { cities: { 1: { leaderUnitUID: unit.unitUid } } }; } }),
  (state) => request([state.unit.unitUid]),
  ERROR_CODES.UNIT_IS_WORLDMAP_LEADER
);
failure(
  "office room",
  () => makeFixture({ mutate(unit, user) { user.office = { rooms: [{ id: 1, unitUids: [unit.unitUid] }] }; } }),
  (state) => request([state.unit.unitUid]),
  ERROR_CODES.OFFICE_UNIT_DELETE_IN_ROOM
);
failure(
  "support unit",
  () => makeFixture({ mutate(unit, user) { user.support = { mySupportUnitUid: unit.unitUid }; } }),
  (state) => request([state.unit.unitUid]),
  ERROR_CODES.CONTAIN_SUPPORT_UNIT
);
failure(
  "multi-unit state atomicity",
  () => makeTwoFixture({ mutateSecond(unit) { unit.locked = true; } }),
  (state) => request([state.first.unitUid, state.second.unitUid]),
  ERROR_CODES.UNIT_LOCKED
);
assertNoMutations();

const direct = makeFixture({ unitId: srFixtureId, fromContract: false });
success(direct, [direct.unit], [], []);

const contract = makeFixture({ unitId: srFixtureId, fromContract: true });
success(contract, [contract.unit], [], []);

const sameRoleFail = makeUnits(Array(config.maxUnitSelect).fill(srFixtureId), { fromContract: false });
success(sameRoleFail, sameRoleFail.units, [config.srRatePercent * config.maxUnitSelect], []);

const sameRoleFirst = makeUnits(Array(config.maxUnitSelect).fill(srFixtureId), { fromContract: false });
success(sameRoleFirst, sameRoleFirst.units, [config.srRatePercent * config.maxUnitSelect - 1, 0], [bonusRewards[0]]);

const sameRoleLast = makeUnits(Array(config.maxUnitSelect).fill(ssrFixtureId), { fromContract: false });
success(sameRoleLast, sameRoleLast.units, [0, 9999], [bonusRewards[bonusRewards.length - 1]]);

const uniqueRoles = makeUnits(roleFixtureIds.slice(0, config.maxUnitSelect), { fromContract: false });
success(uniqueRoles, uniqueRoles.units, [0, 100], [bonusRewards[1]]);

const mixedRoles = makeUnits([roleFixtureIds[0], roleFixtureIds[0], ...roleFixtureIds.slice(1, 4)], { fromContract: false });
success(mixedRoles, mixedRoles.units, [], []);

const awakenCap = makeUnits(Array(config.maxUnitSelect).fill(awakenFixtureId), { fromContract: false });
success(awakenCap, awakenCap.units, [99, 0], [bonusRewards[0]]);

assert.strictEqual(saves, 8, "only eight successful extraction requests should persist");
assert.strictEqual(invalidations, 8, "only eight successful extraction requests should invalidate the lobby snapshot");
assert.deepStrictEqual(missionEvents, [], "frozen extraction path has no unit-growth mission condition");
validateManagedSchemas();
console.log(`[unit-extract-protocol-check] PASS saves=${saves} packets=${managedWire.length} bonusRows=${bonusRewards.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  return { userUid: String(989000000000000n + fixtureId), nickname: "UnitExtractCheck" };
}

function makeFixture(options = {}) {
  const user = createUser();
  const unit = grantUnit(user, options.unitId || ssrFixtureId, { fromContract: options.fromContract !== false });
  assert(unit, "unit extraction fixture must resolve");
  ensureArmy(user);
  const stored = user.army.units[unit.unitUid] || user.army.ships[unit.unitUid] || user.army.trophies[unit.unitUid];
  if (options.mutate) options.mutate(stored, user);
  return { user, unit: stored };
}

function makeTwoFixture(options = {}) {
  const state = makeFixture(options);
  state.first = state.unit;
  state.second = grantUnit(state.user, ssrFixtureId, { fromContract: false });
  if (options.mutateSecond) options.mutateSecond(state.second, state.user);
  return state;
}

function makeUnits(unitIds, options = {}) {
  const user = createUser();
  const units = unitIds.map((unitId) => grantUnit(user, unitId, options));
  assert(units.every(Boolean));
  ensureArmy(user);
  return { user, units };
}

function failure(name, makeState, makePayload, expectedError, validateRequest = true, tags = ["REARMAMENT_EXTRACT"]) {
  const state = makeState();
  ensureArmy(state.user);
  socket.session.user = state.user;
  runtimeOpenTags = tags.slice();
  randomRolls = [];
  const before = JSON.parse(JSON.stringify(state.user));
  send(typeof makePayload === "function" ? makePayload(state) : makePayload, validateRequest);
  assertAck(expectedError, [], {}, {});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state.user)), before, `${name} must not mutate user state`);
  assert.deepStrictEqual(randomRolls, [], `${name} must not consume randomness`);
}

function success(state, units, rolls, expectedSynergy, expectedRemainingRolls = []) {
  socket.session.user = state.user;
  runtimeOpenTags = ["REARMAMENT_EXTRACT"];
  randomRolls = rolls.slice();
  const expectedBase = mergeRewards(units.flatMap((unit) =>
    getUnitExtractRewards(unit.unitId, { fromContract: unit.fromContract !== false })
  ));
  const expectedBonus = mergeRewards(expectedSynergy);
  for (const itemId of new Set([...Object.keys(expectedBase), ...Object.keys(expectedBonus)])) {
    setMiscItemBalance(state.user, itemId, 10);
  }
  send(request(units.map((unit) => unit.unitUid)));
  assertAck(ERROR_CODES.OK, units.map((unit) => BigInt(unit.unitUid)), expectedBase, expectedBonus);
  assert.deepStrictEqual(randomRolls, expectedRemainingRolls, "extraction must consume only the frozen synergy rolls");
  for (const unit of units) assert.strictEqual(getArmyUnitByUid(state.user, unit.unitUid), null);
  for (const [itemId, count] of Object.entries(mergeRewardMaps(expectedBase, expectedBonus))) {
    assert.strictEqual(getMiscItem(state.user, itemId).countFree, String(10 + count));
  }
  const restarted = JSON.parse(JSON.stringify(state.user));
  for (const unit of units) assert.strictEqual(getArmyUnitByUid(restarted, unit.unitUid), null);
  for (const [itemId, count] of Object.entries(mergeRewardMaps(expectedBase, expectedBonus))) {
    assert.strictEqual(getMiscItem(restarted, itemId).countFree, String(10 + count));
  }
}

function request(uids) {
  const values = Array.isArray(uids) ? uids : [];
  return Buffer.concat([writeRawVarInt(values.length), ...values.map((uid) => writeSignedVarLong(BigInt(uid)))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.EXTRACT_UNIT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.EXTRACT_UNIT_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedRemoved, expectedBase, expectedSynergy) {
  assert(response, "unit-extract handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.EXTRACT_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const removed = readLongList(response.payload, error.offset);
  assert.deepStrictEqual(removed.values, expectedRemoved);
  const base = readNullableReward(response.payload, removed.offset);
  const synergy = readNullableReward(response.payload, base.offset);
  assert.deepStrictEqual(base.values, Object.fromEntries(Object.entries(expectedBase).map(([id, count]) => [id, String(count)])));
  assert.deepStrictEqual(synergy.values, Object.fromEntries(Object.entries(expectedSynergy).map(([id, count]) => [id, String(count)])));
  assert.strictEqual(synergy.offset, response.payload.length, "unit-extract ACK must contain no trailing fields");
}

function readLongList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const uid = readSignedVarLong(payload, offset);
    values.push(uid.value);
    offset = uid.offset;
  }
  return { values, offset };
}

function readNullableReward(payload, startOffset) {
  const present = payload[startOffset];
  assert(present === 0 || present === 1, "reward-data nullable marker must be boolean");
  if (present === 0) return { values: {}, offset: startOffset + 1 };
  let offset = startOffset + 1;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  const miscItems = readItemList(payload, offset);
  offset = miscItems.offset;
  for (let index = 0; index < 4; index += 1) offset = readEmptyList(payload, offset);
  for (let index = 0; index < 2; index += 1) offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readEmptyList(payload, offset);
  return { values: miscItems.values, offset };
}

function readItemList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = {};
  for (let index = 0; index < count.value; index += 1) {
    assert.strictEqual(payload[offset++], 1, "reward item must be non-null");
    const itemId = readSignedVarInt(payload, offset);
    const free = readSignedVarLong(payload, itemId.offset);
    const paid = readSignedVarLong(payload, free.offset);
    const bonus = readSignedVarInt(payload, paid.offset);
    offset = bonus.offset + 8;
    values[String(itemId.value)] = String(BigInt(free.value) + BigInt(paid.value));
  }
  return { values, offset };
}

function readEmptyList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0, "unused reward-data list must be empty");
  return count.offset;
}

function mergeRewards(rewards) {
  const result = {};
  for (const reward of rewards) {
    assert(reward.itemId > 0 && reward.count > 0);
    result[String(reward.itemId)] = (result[String(reward.itemId)] || 0) + reward.count;
  }
  return result;
}

function mergeRewardMaps(left, right) {
  const result = { ...left };
  for (const [itemId, count] of Object.entries(right)) result[itemId] = (result[itemId] || 0) + count;
  return result;
}

function assertNoMutations() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.deepStrictEqual(missionEvents, []);
}

function isEligibleShape(record) {
  return Boolean(
    record && record.m_NKM_UNIT_TYPE === "NUT_NORMAL" && record.m_bMonster !== true &&
    record.m_NKM_UNIT_STYLE_TYPE !== "NUST_TRAINER" && ["NUG_SR", "NUG_SSR"].includes(record.m_NKM_UNIT_GRADE)
  );
}

function isExtractableFixture(record) {
  return isEligibleShape(record) && ![1001, 1002, 1003].includes(Number(record.m_UnitID)) &&
    getUnitExtractRewards(record.m_UnitID, { fromContract: false }).length > 0 &&
    String(record.m_NKM_UNIT_ROLE_TYPE || "") !== "NURT_INVALID";
}

function findFixture(predicate) {
  const record = extractable.find(predicate);
  assert(record, "frozen unit table must provide requested extraction fixture");
  return record;
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
      assert(result.ok, `managed client schema rejected unit-extract packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
