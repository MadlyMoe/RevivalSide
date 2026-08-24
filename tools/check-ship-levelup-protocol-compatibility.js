"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getShipLevelUpCosts } = require("../modules/game-data");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const { readBool, readSignedVarInt, readSignedVarLong, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.SHIP_LEVELUP_REQ);
assert(handler, "ship-levelup handler must be registered");

const SHIP_ID = 26001;
const managedWire = [];
let fixtureId = 0n;
let response = null;
let saves = 0;
let invalidations = 0;
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "ship-levelup");
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

failure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.UNIT_NOT_EXIST, false);
failure("trailing", () => makeFixture({ level: 14 }), (user) => Buffer.concat([request(user.ship.unitUid, 16), Buffer.from([0])]), ERROR_CODES.UNIT_NOT_EXIST, false);
failure("missing ship", createUser, () => request(999999999, 2), ERROR_CODES.UNIT_NOT_EXIST);
failure("normal unit UID", makeUnitFixture, (user) => request(user.unit.unitUid, 2), ERROR_CODES.UNIT_NOT_EXIST);
failure("seized ship", () => makeFixture({ seized: true }), (user) => request(user.ship.unitUid, 2), ERROR_CODES.SHIP_IS_SEIZED);
failure("world-map deck", () => makeFixture({ deckState: 1 }), (user) => request(user.ship.unitUid, 2), ERROR_CODES.WORLDMAP_MISSION_DOING);
failure("warfare deck", () => makeFixture({ deckState: 2 }), (user) => request(user.ship.unitUid, 2), ERROR_CODES.WARFARE_DOING);
failure("dive deck", () => makeFixture({ deckState: 3 }), (user) => request(user.ship.unitUid, 2), ERROR_CODES.DIVE_DOING);
failure("above maximum", () => makeFixture({ level: 100 }), (user) => request(user.ship.unitUid, 101), ERROR_CODES.SHIP_MAX_LEVEL);
failure("zero level", makeFixture, (user) => request(user.ship.unitUid, 0), ERROR_CODES.SHIP_INVALID_LEVEL);
failure("below current level", () => makeFixture({ level: 20 }), (user) => request(user.ship.unitUid, 19), ERROR_CODES.SHIP_INVALID_LEVEL);
failure(
  "insufficient aggregate cost",
  () => makeFixture({ level: 14, underfund: true, targetLevel: 16 }),
  (user) => request(user.ship.unitUid, 16),
  ERROR_CODES.INVALID_ITEM_ID
);
assertNoCommits();

const idempotent = makeFixture({ level: 14, balances: {} });
socket.session.user = idempotent;
send(request(idempotent.ship.unitUid, 14));
assertSuccess(idempotent.ship.unitUid, 14, []);
assertNoCommits();

const normal = makeFixture({ level: 14, balances: { 1: [1000, 2500], 1009: [4, 0] } });
socket.session.user = normal;
send(request(normal.ship.unitUid, 16));
assertSuccess(normal.ship.unitUid, 16, [
  { itemId: 1, countFree: 0, countPaid: 500 },
  { itemId: 1009, countFree: 0, countPaid: 0 },
]);
assertBalances(normal, [{ itemId: 1, countFree: 0, countPaid: 500 }, { itemId: 1009, countFree: 0, countPaid: 0 }]);

const limitBreak = makeFixture({ level: 100, limitBreakLevel: 1, targetLevel: 101 });
socket.session.user = limitBreak;
send(request(limitBreak.ship.unitUid, 101));
const limitBreakCosts = getShipLevelUpCosts(limitBreak.ship, 100, 101);
const limitBreakBalances = limitBreakCosts.map((cost) => ({ itemId: cost.itemId, countFree: 1, countPaid: 0 }));
assertSuccess(limitBreak.ship.unitUid, 101, limitBreakBalances);
assertBalances(limitBreak, limitBreakBalances);

assert.strictEqual(saves, 2, "only mutating ship level-ups may save");
assert.strictEqual(invalidations, 2, "only mutating ship level-ups may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["SHIP_LEVELUP", 1, undefined],
    ["USE_RESOURCE", 3000, 1],
    ["USE_RESOURCE", 4, 1009],
    ["SHIP_LEVELUP", 1, undefined],
    ...limitBreakCosts.map((cost) => ["USE_RESOURCE", cost.count, cost.itemId]),
  ]
);

const restartedNormal = JSON.parse(JSON.stringify(normal));
assert.strictEqual(getArmyUnitByUid(restartedNormal, normal.ship.unitUid).level, 16);
assertBalances(restartedNormal, [{ itemId: 1, countFree: 0, countPaid: 500 }, { itemId: 1009, countFree: 0, countPaid: 0 }]);
const restartedLimitBreak = JSON.parse(JSON.stringify(limitBreak));
assert.strictEqual(getArmyUnitByUid(restartedLimitBreak, limitBreak.ship.unitUid).level, 101);

validateManagedSchemas();
console.log(`[ship-levelup-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(984000000000000n + fixtureId), nickname: "ShipLevelupCheck" };
  ensureArmy(user);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  user.ship = grantUnit(user, SHIP_ID, {
    level: options.level == null ? 1 : options.level,
    limitBreakLevel: options.limitBreakLevel || 0,
    fromContract: false,
  });
  assert(user.ship, "ship-levelup fixture must exist");
  const targetLevel = options.targetLevel == null ? Number(user.ship.level) + 1 : options.targetLevel;
  const costs = getShipLevelUpCosts(user.ship, user.ship.level, targetLevel);
  const balances = options.balances === undefined
    ? Object.fromEntries(costs.map((cost) => [cost.itemId, [cost.count + 1, 0]]))
    : options.balances;
  if (options.underfund && costs.length) balances[costs[0].itemId] = [Math.max(0, costs[0].count - 1), 0];
  for (const [itemId, counts] of Object.entries(balances)) grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  ensureArmy(user);
  user.ship = user.army.ships[String(user.ship.unitUid)];
  user.ship.isSeized = options.seized === true;
  if (options.deckState) {
    const deck = user.army.deckSets["1"][0];
    deck.shipUid = user.ship.unitUid;
    deck.state = options.deckState;
  }
  return user;
}

function makeUnitFixture() {
  const user = createUser();
  user.unit = grantUnit(user, 1001, { level: 1 });
  ensureArmy(user);
  user.unit = user.army.units[String(user.unit.unitUid)];
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

function request(shipUid, nextLevel) {
  return Buffer.concat([writeSignedVarLong(BigInt(shipUid)), writeSignedVarInt(nextLevel)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.SHIP_LEVELUP_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.SHIP_LEVELUP_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response, "ship-levelup handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_LEVELUP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const shipPresent = readBool(response.payload, error.offset);
  assert.strictEqual(shipPresent.value, false);
  const items = readMiscItemList(response.payload, shipPresent.offset);
  assert.deepStrictEqual(items.values, []);
  assert.strictEqual(items.offset, response.payload.length, "failed ship-levelup ACK must contain no trailing fields");
}

function assertSuccess(shipUid, level, expectedItems) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.ship.unitUid.toString(), String(shipUid));
  assert.strictEqual(ack.ship.level, level);
  assert.deepStrictEqual(ack.costItems, expectedItems);
}

function readAck() {
  assert(response, "ship-levelup handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_LEVELUP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, true);
  const ship = readUnitData(response.payload, present.offset);
  const items = readMiscItemList(response.payload, ship.offset);
  assert.strictEqual(items.offset, response.payload.length, "successful ship-levelup ACK must contain no trailing fields");
  return { errorCode: error.value, ship, costItems: items.values };
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = readSignedVarLong(payload, unitUid.offset).offset;
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
  offset = readSignedVarInt(payload, offset).offset;
  return { unitUid: unitUid.value, unitId: unitId.value, level: level.value, offset };
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
      assert(result.ok, `managed client schema rejected ship-levelup packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
