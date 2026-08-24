"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getUnitReactorTemplet } = require("../modules/game-data");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
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
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.UNIT_REACTOR_LEVELUP_REQ);
assert(handler, "unit-reactor-levelup handler must be registered");

const DEFAULT_TAGS = ["UNIT_REACTOR", "TAG_COMMON_REACTOR_001"];
const managedWire = [];
let fixtureId = 0n;
let runtimeOpenTags = DEFAULT_TAGS.slice();
let response = null;
let saves = 0;
let invalidations = 0;
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags],
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-reactor-levelup");
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

failure("truncated", () => createUser(), Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure("trailing", makeFixture, (user) => Buffer.concat([request(user.unit.unitUid), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("zero uid", makeFixture, () => request(0), ERROR_CODES.INVALID_REQUEST);
failure("missing unit", () => createUser(), () => request(999999999), ERROR_CODES.REACTOR_INVALID_ID);
failure("unit without reactor", () => makeFixture({ unitId: 1001 }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_INVALID_TEMPLET);
failure("invalid negative stored level", () => makeFixture({ mutate(unit) { unit.reactorLevel = -1; } }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_DB_INVALID_LEVEL);
failure("invalid excessive stored level", () => makeFixture({ mutate(unit) { unit.reactorLevel = 6; } }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_DB_INVALID_LEVEL);
failure("already maximum", () => makeFixture({ reactorLevel: 1 }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_OVER_MAX_LEVEL);
failure("unit below level 110", () => makeFixture({ level: 109 }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_NOT_AVAILABLE);
failure("seized unit", () => makeFixture({ mutate(unit) { unit.isSeized = true; } }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_NOT_AVAILABLE);
failure("reactor system closed", makeFixture, (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_NOT_AVAILABLE, true, []);
failure("reactor release tag closed", makeFixture, (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_NOT_AVAILABLE, true, ["UNIT_REACTOR"]);
failure("base skill below maximum", () => makeFixture({ skillLevels: [5, 5, 4, 5, 5] }), (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_INVALID_SKILL_CONDITION);
failure(
  "insufficient material",
  () => makeFixture({ balances: { 1: [1999999, 0], 1072: [100, 0], 1070: [1, 0] } }),
  (user) => request(user.unit.unitUid),
  ERROR_CODES.INSUFFICIENT_ITEM
);
failure(
  "second-level release tag closed",
  () => makeFixture({ unitId: 1099, reactorLevel: 1, balances: { 1: [1400000, 0], 1072: [70, 0] } }),
  (user) => request(user.unit.unitUid),
  ERROR_CODES.REACTOR_NOT_AVAILABLE,
  true,
  ["UNIT_REACTOR", "TAG_COMMON_REACTOR_002"]
);

const hildeReactor = getUnitReactorTemplet(1150);
assert(hildeReactor, "frozen Hilde reactor fixture must exist");
const originalSkillId = hildeReactor.Level1;
try {
  hildeReactor.Level1 = 999999999;
  failure("missing referenced skill", makeFixture, (user) => request(user.unit.unitUid), ERROR_CODES.REACTOR_INVALID_SKILL_TEMPLET);
} finally {
  hildeReactor.Level1 = originalSkillId;
}
assertNoMutations();

runtimeOpenTags = DEFAULT_TAGS.slice();
const hilde = makeFixture({ balances: { 1: [1500000, 1000000], 1072: [140, 0], 1070: [3, 2] } });
socket.session.user = hilde;
send(request(hilde.unit.unitUid));
const hildeUnit = getArmyUnitByUid(hilde, hilde.unit.unitUid);
assert.strictEqual(hildeUnit.reactorLevel, 1);
assertSuccess(hildeUnit, [
  { itemId: 1, countFree: 0, countPaid: 500000 },
  { itemId: 1072, countFree: 40, countPaid: 0 },
  { itemId: 1070, countFree: 2, countPaid: 2 },
]);
assertBalances(hilde, [
  { itemId: 1, countFree: 0, countPaid: 500000 },
  { itemId: 1072, countFree: 40, countPaid: 0 },
  { itemId: 1070, countFree: 2, countPaid: 2 },
]);

runtimeOpenTags = ["UNIT_REACTOR", "TAG_COMMON_REACTOR_002", "TAG_C_POLICE_LEE_YUMI_REACTOR_LEVEL2"];
const yumi = makeFixture({ unitId: 1099, reactorLevel: 1, balances: { 1: [2000000, 0], 1072: [100, 0] } });
socket.session.user = yumi;
send(request(yumi.unit.unitUid));
const yumiUnit = getArmyUnitByUid(yumi, yumi.unit.unitUid);
assert.strictEqual(yumiUnit.reactorLevel, 2);
assertSuccess(yumiUnit, [
  { itemId: 1, countFree: 600000, countPaid: 0 },
  { itemId: 1072, countFree: 30, countPaid: 0 },
]);

assert.strictEqual(saves, 2, "only successful reactor transitions may save");
assert.strictEqual(invalidations, 2, "only successful reactor transitions may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["UNLOCKED_UNIT_REACTOR", 1, undefined],
    ["USE_RESOURCE", 2000000, 1],
    ["USE_RESOURCE", 100, 1072],
    ["USE_RESOURCE", 1, 1070],
    ["UNLOCKED_UNIT_REACTOR", 1, undefined],
    ["USE_RESOURCE", 1400000, 1],
    ["USE_RESOURCE", 70, 1072],
  ]
);

const restartedHilde = JSON.parse(JSON.stringify(hilde));
assert.strictEqual(getArmyUnitByUid(restartedHilde, hildeUnit.unitUid).reactorLevel, 1);
assertBalances(restartedHilde, [
  { itemId: 1, countFree: 0, countPaid: 500000 },
  { itemId: 1072, countFree: 40, countPaid: 0 },
  { itemId: 1070, countFree: 2, countPaid: 2 },
]);
const restartedYumi = JSON.parse(JSON.stringify(yumi));
assert.strictEqual(getArmyUnitByUid(restartedYumi, yumiUnit.unitUid).reactorLevel, 2);

validateManagedSchemas();
console.log(`[unit-reactor-levelup-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  return { userUid: String(987000000000000n + fixtureId), nickname: "ReactorCheck" };
}

function makeFixture(options = {}) {
  const user = createUser();
  user.unit = grantUnit(user, options.unitId || 1150, {
    level: options.level == null ? 110 : options.level,
    limitBreakLevel: 5,
    skillLevels: options.skillLevels || [5, 5, 5, 5, 5],
    reactorLevel: options.reactorLevel || 0,
  });
  assert(user.unit, "reactor unit fixture must exist");
  const balances = options.balances || { 1: [3000000, 0], 1072: [200, 0], 1070: [2, 0] };
  for (const [itemId, counts] of Object.entries(balances)) {
    grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  }
  ensureArmy(user);
  const unitUid = String(user.unit.unitUid);
  user.unit = user.army.units[unitUid] || user.army.ships[unitUid] || user.army.trophies[unitUid];
  if (options.mutate) options.mutate(user.unit, user);
  return user;
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true, tags = DEFAULT_TAGS) {
  const user = makeUser();
  ensureArmy(user);
  socket.session.user = user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function request(unitUid) {
  return writeSignedVarLong(BigInt(unitUid));
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.UNIT_REACTOR_LEVELUP_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.UNIT_REACTOR_LEVELUP_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(expectedError) {
  assert(response, "unit-reactor-levelup handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.UNIT_REACTOR_LEVELUP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const unitPresent = readBool(response.payload, error.offset);
  assert.strictEqual(unitPresent.value, false);
  const itemCount = readRawVarInt(response.payload, unitPresent.offset);
  assert.strictEqual(itemCount.value, 0);
  assert.strictEqual(itemCount.offset, response.payload.length, "failed reactor ACK must contain no trailing fields");
}

function assertSuccess(expectedUnit, expectedItems) {
  assert.strictEqual(response.packetId, PACKETS.UNIT_REACTOR_LEVELUP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, ERROR_CODES.OK);
  const unitPresent = readBool(response.payload, error.offset);
  assert.strictEqual(unitPresent.value, true);
  const unit = readUnitData(response.payload, unitPresent.offset);
  assert.strictEqual(unit.unitUid.toString(), String(expectedUnit.unitUid));
  assert.strictEqual(unit.unitId, expectedUnit.unitId);
  assert.strictEqual(unit.level, expectedUnit.level);
  assert.strictEqual(unit.reactorLevel, expectedUnit.reactorLevel);
  const items = readMiscItemList(response.payload, unit.offset);
  assert.deepStrictEqual(items.values, expectedItems);
  assert.strictEqual(items.offset, response.payload.length, "successful reactor ACK must contain no trailing fields");
}

function assertBalances(user, expectedItems) {
  for (const expected of expectedItems) {
    const item = getMiscItem(user, expected.itemId);
    assert.strictEqual(item.countFree, String(expected.countFree));
    assert.strictEqual(item.countPaid, String(expected.countPaid));
  }
}

function assertNoMutations() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.deepStrictEqual(missionEvents, []);
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = unitUid.offset;
  offset = readSignedVarLong(payload, offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  const level = readSignedVarInt(payload, unitId.offset);
  offset = readSignedVarInt(payload, level.offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 4;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipFloatList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipLongList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipShipModuleList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  const reactorLevel = readSignedVarInt(payload, offset);
  return { unitUid: unitUid.value, unitId: unitId.value, level: level.value, reactorLevel: reactorLevel.value, offset: reactorLevel.offset };
}

function readMiscItemList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const itemId = readSignedVarInt(payload, present.offset);
    const countFree = readSignedVarLong(payload, itemId.offset);
    const countPaid = readSignedVarLong(payload, countFree.offset);
    const bonusRatio = readSignedVarInt(payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    values.push({ itemId: itemId.value, countFree: Number(countFree.value), countPaid: Number(countPaid.value) });
  }
  return { values, offset };
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

function skipIntList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return offset;
}

function skipLongList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(payload, offset).offset;
  return offset;
}

function skipFloatList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  return count.offset + count.value * 4;
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
      assert(result.ok, `managed client schema rejected reactor packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
