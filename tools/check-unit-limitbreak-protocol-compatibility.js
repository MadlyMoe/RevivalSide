"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getUnitLimitBreakCosts } = require("../modules/game-data");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const { readBool, readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.LIMIT_BREAK_UNIT_REQ);
assert(handler, "unit-limitbreak handler must be registered");

const YOO_MINA_ID = 1001;
const TRAINER_ID = 101;
const managedWire = [];
let fixtureId = 0n;
let response = null;
let saves = 0;
let invalidations = 0;
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags(tags) { return Array.isArray(tags) ? tags.slice() : []; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-limit-break");
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

failure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure(
  "trailing",
  makeFixture,
  (user) => Buffer.concat([request(user.unit.unitUid), Buffer.from([0])]),
  ERROR_CODES.INVALID_REQUEST,
  false
);
failure("missing unit", createUser, () => request(999999999), ERROR_CODES.UNIT_NOT_EXIST);
failure("ship UID", makeShipFixture, (user) => request(user.ship.unitUid), ERROR_CODES.UNIT_NOT_EXIST);
failure("trainer UID", () => makeFixture({ unitId: TRAINER_ID }), (user) => request(user.unit.unitUid), ERROR_CODES.UNIT_NOT_EXIST);
failure("seized unit", () => makeFixture({ seized: true }), (user) => request(user.unit.unitUid), ERROR_CODES.UNIT_IS_SEIZED);
failure("warfare deck", () => makeFixture({ deckState: 2 }), (user) => request(user.unit.unitUid), ERROR_CODES.WARFARE_DOING);
failure("dive deck", () => makeFixture({ deckState: 3 }), (user) => request(user.unit.unitUid), ERROR_CODES.DIVE_DOING);
failure(
  "maximum rank",
  () => makeFixture({ limitBreakLevel: 13 }),
  (user) => request(user.unit.unitUid),
  ERROR_CODES.LIMITBREAK_ALREADY_MAX_LEVEL
);
failure(
  "closed transcendence tag",
  () => makeFixture({ limitBreakLevel: 3 }),
  (user) => request(user.unit.unitUid),
  ERROR_CODES.GET_UNIT_LIMIT_BREAK_TEMPLET_NULL
);
failure(
  "insufficient credit",
  () => makeFixture({ balances: { 1: [9999, 0], 1074: [20, 0] } }),
  (user) => request(user.unit.unitUid),
  ERROR_CODES.INSUFFICIENT_CREDIT
);
failure(
  "insufficient material",
  () => makeFixture({ balances: { 1: [10000, 0], 1074: [19, 0] } }),
  (user) => request(user.unit.unitUid),
  ERROR_CODES.INSUFFICIENT_ITEM
);
assertNoCommits();

const first = makeFixture({ balances: { 1: [2500, 17500], 1074: [5, 20] } });
socket.session.user = first;
send(request(first.unit.unitUid));
assertSuccess(first.unit.unitUid, 1, [
  { itemId: 1, countFree: 0, countPaid: 10000 },
  { itemId: 1074, countFree: 0, countPaid: 5 },
]);
assertBalances(first, [
  { itemId: 1, countFree: 0, countPaid: 10000 },
  { itemId: 1074, countFree: 0, countPaid: 5 },
]);

const rankTwoCosts = getUnitLimitBreakCosts(YOO_MINA_ID, 2);
assert.deepStrictEqual(rankTwoCosts, [
  { itemId: 1, count: 50000 },
  { itemId: 1074, count: 20 },
  { itemId: 1075, count: 3 },
], "rank-two costs must use frozen substitute counts without obsolete multipliers");
const second = makeFixture({
  limitBreakLevel: 1,
  balances: { 1: [60000, 0], 1074: [25, 0], 1075: [5, 0] },
});
socket.session.user = second;
send(request(second.unit.unitUid));
assertSuccess(second.unit.unitUid, 2, [
  { itemId: 1, countFree: 10000, countPaid: 0 },
  { itemId: 1074, countFree: 5, countPaid: 0 },
  { itemId: 1075, countFree: 2, countPaid: 0 },
]);

const transcendence = makeFixture({
  limitBreakLevel: 3,
  openTags: ["SYSTEM_TRANSCENDENCE"],
  balances: { 1: [200000, 0], 1016: [1, 0] },
});
socket.session.user = transcendence;
send(request(transcendence.unit.unitUid));
assertSuccess(transcendence.unit.unitUid, 4, [
  { itemId: 1, countFree: 0, countPaid: 0 },
  { itemId: 1016, countFree: 0, countPaid: 0 },
]);

assert.strictEqual(saves, 3, "only successful unit limit breaks may save");
assert.strictEqual(invalidations, 3, "only successful unit limit breaks may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["UNIT_LIMITBREAK", 1, undefined],
    ["UNIT_GROWTH_LIMIT", 1, undefined],
    ["USE_RESOURCE", 10000, 1],
    ["USE_RESOURCE", 20, 1074],
    ["UNIT_LIMITBREAK", 1, undefined],
    ["UNIT_GROWTH_LIMIT", 1, undefined],
    ["USE_RESOURCE", 50000, 1],
    ["USE_RESOURCE", 20, 1074],
    ["USE_RESOURCE", 3, 1075],
    ["UNIT_LIMITBREAK", 1, undefined],
    ["UNIT_GROWTH_LIMIT", 1, undefined],
    ["USE_RESOURCE", 200000, 1],
    ["USE_RESOURCE", 1, 1016],
  ]
);

for (const [user, rank] of [[first, 1], [second, 2], [transcendence, 4]]) {
  const restarted = JSON.parse(JSON.stringify(user));
  assert.strictEqual(getArmyUnitByUid(restarted, user.unit.unitUid).limitBreakLevel, rank);
}

validateManagedSchemas();
console.log(`[unit-limitbreak-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(982000000000000n + fixtureId), nickname: "UnitLimitbreakCheck" };
  ensureArmy(user);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  user.openTags = Array.isArray(options.openTags) ? options.openTags.slice() : [];
  user.unit = grantUnit(user, options.unitId || YOO_MINA_ID, {
    level: options.level == null ? 100 : options.level,
    limitBreakLevel: options.limitBreakLevel || 0,
  });
  assert(user.unit, "unit-limitbreak fixture must exist");
  const costs = getUnitLimitBreakCosts(user.unit.unitId, Number(user.unit.limitBreakLevel || 0) + 1);
  const balances = options.balances === undefined
    ? Object.fromEntries(costs.map((cost) => [cost.itemId, [cost.count + 1, 0]]))
    : options.balances;
  for (const [itemId, counts] of Object.entries(balances)) grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  const unitUid = user.unit.unitUid;
  const army = ensureArmy(user);
  const storedUnit = army.units[String(unitUid)] || army.trophies[String(unitUid)] || army.ships[String(unitUid)];
  assert(storedUnit, "unit-limitbreak fixture must remain stored after normalization");
  storedUnit.isSeized = options.seized === true;
  user.unit = getArmyUnitByUid(user, unitUid);
  assert(user.unit, "unit-limitbreak fixture must remain addressable after normalization");
  if (options.deckState) {
    const deck = user.army.deckSets["1"][0];
    deck.unitUids[0] = user.unit.unitUid;
    deck.leaderIndex = 0;
    deck.state = options.deckState;
  }
  return user;
}

function makeShipFixture() {
  const user = createUser();
  user.ship = grantUnit(user, 26001, { level: 1 });
  assert(user.ship, "ship fixture must exist");
  ensureArmy(user);
  user.ship = user.army.ships[String(user.ship.unitUid)];
  return user;
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  socket.session.user = user;
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function request(unitUid) {
  return writeSignedVarLong(BigInt(unitUid));
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.LIMIT_BREAK_UNIT_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.LIMIT_BREAK_UNIT_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(expectedError) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, expectedError);
  assert.strictEqual(ack.unit, null);
  assert.deepStrictEqual(ack.costItems, []);
}

function assertSuccess(unitUid, rank, expectedItems) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.unit.unitUid.toString(), String(unitUid));
  assert.strictEqual(ack.unit.limitBreakLevel, rank);
  assert.deepStrictEqual(ack.costItems, expectedItems);
}

function readAck() {
  assert(response, "unit-limitbreak handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.LIMIT_BREAK_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  let unit = null;
  let offset = present.offset;
  if (present.value) {
    unit = readUnitData(response.payload, offset);
    offset = unit.offset;
  }
  const costItems = readMiscItemList(response.payload, offset);
  assert.strictEqual(costItems.offset, response.payload.length, "unit-limitbreak ACK must contain no trailing fields");
  return { errorCode: error.value, unit, costItems: costItems.values };
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = readSignedVarLong(payload, unitUid.offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  const level = readSignedVarInt(payload, unitId.offset);
  offset = readSignedVarInt(payload, level.offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 4;
  const limitBreakLevel = readSignedVarInt(payload, offset);
  offset = readBool(payload, limitBreakLevel.offset).offset;
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
  offset = readSignedVarInt(payload, offset).offset;
  return { unitUid: unitUid.value, unitId: unitId.value, level: level.value, limitBreakLevel: limitBreakLevel.value, offset };
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

function assertBalances(user, expectedItems) {
  for (const expected of expectedItems) {
    const item = getMiscItem(user, expected.itemId);
    assert.strictEqual(item.countFree, String(expected.countFree));
    assert.strictEqual(item.countPaid, String(expected.countPaid));
  }
}

function assertNoCommits() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.deepStrictEqual(missionEvents, []);
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
      assert(result.ok, `managed client schema rejected unit-limitbreak packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
