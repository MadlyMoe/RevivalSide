"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getShipUpgradeCosts } = require("../modules/game-data");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const { readBool, readSignedVarInt, readSignedVarLong, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.SHIP_UPGRADE_REQ);
assert(handler, "ship-upgrade handler must be registered");

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
    assert.strictEqual(reason, "ship-upgrade");
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

failure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.SHIP_INVALID_SHIP_ID, false);
failure("trailing", makeFixture, (user) => Buffer.concat([request(user.ship.unitUid, 22001), Buffer.from([0])]), ERROR_CODES.SHIP_INVALID_SHIP_ID, false);
failure("unknown target precedes ship lookup", createUser, () => request(999999999, 999999999), ERROR_CODES.SHIP_INVALID_SHIP_ID);
failure("missing ship", createUser, () => request(999999999, 22001), ERROR_CODES.SHIP_INVALID_SHIP_UID);
failure("normal unit UID", makeUnitFixture, (user) => request(user.unit.unitUid, 22001), ERROR_CODES.SHIP_INVALID_SHIP_UID);
failure("seized ship", () => makeFixture({ seized: true }), (user) => request(user.ship.unitUid, 22001), ERROR_CODES.SHIP_IS_SEIZED);
failure("world-map deck", () => makeFixture({ deckState: 1 }), (user) => request(user.ship.unitUid, 22001), ERROR_CODES.WORLDMAP_MISSION_DOING);
failure("warfare deck", () => makeFixture({ deckState: 2 }), (user) => request(user.ship.unitUid, 22001), ERROR_CODES.WARFARE_DOING);
failure("dive deck", () => makeFixture({ deckState: 3 }), (user) => request(user.ship.unitUid, 22001), ERROR_CODES.DIVE_DOING);
failure("below remodel level", () => makeFixture({ level: 14 }), (user) => request(user.ship.unitUid, 22001), ERROR_CODES.SHIP_REMODEL_NOT_ENOUGH_LEVEL);
failure("target outside current chain", makeFixture, (user) => request(user.ship.unitUid, 23001), ERROR_CODES.SHIP_INVALID_SHIP_ID);
failure("insufficient target cost", () => makeFixture({ underfund: true }), (user) => request(user.ship.unitUid, 22001), ERROR_CODES.INSUFFICIENT_ITEM);
assertNoCommits();

const first = makeFixture({ balances: { 1: [5000, 3000], 1201: [1, 0] } });
success(first, 22001, [
  { itemId: 1, countFree: 0, countPaid: 500 },
  { itemId: 1201, countFree: 0, countPaid: 0 },
]);

const second = makeFixture({ shipId: 22001, level: 30, targetShipId: 23001 });
const secondCosts = getShipUpgradeCosts(23001);
success(second, 23001, secondCosts.map((cost) => ({ itemId: cost.itemId, countFree: 1, countPaid: 0 })));

assert.strictEqual(saves, 2, "only successful ship upgrades may save");
assert.strictEqual(invalidations, 2, "only successful ship upgrades may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["SHIP_UPGRADE", 1, undefined],
    ["USE_RESOURCE", 7500, 1],
    ["USE_RESOURCE", 1, 1201],
    ["SHIP_UPGRADE", 1, undefined],
    ...secondCosts.map((cost) => ["USE_RESOURCE", cost.count, cost.itemId]),
  ]
);

for (const [user, shipId, level] of [[first, 22001, 15], [second, 23001, 30]]) {
  const restarted = JSON.parse(JSON.stringify(user));
  const ship = getArmyUnitByUid(restarted, user.ship.unitUid);
  assert.strictEqual(ship.unitId, shipId);
  assert.strictEqual(ship.level, level);
  assert(restarted.collection.ships.includes(shipId), `upgraded ship ${shipId} must remain collected after restart`);
}

validateManagedSchemas();
console.log(`[ship-upgrade-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(983000000000000n + fixtureId), nickname: "ShipUpgradeCheck" };
  ensureArmy(user);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  const shipId = options.shipId || 21001;
  const level = options.level == null ? 15 : options.level;
  const targetShipId = options.targetShipId || 22001;
  user.ship = grantUnit(user, shipId, { level, fromContract: false });
  assert(user.ship, "ship-upgrade fixture must exist");
  const costs = getShipUpgradeCosts(targetShipId) || [];
  const balances = options.balances || Object.fromEntries(costs.map((cost) => [cost.itemId, [cost.count + 1, 0]]));
  if (options.underfund && costs.length) balances[costs[0].itemId] = [Math.max(0, costs[0].count - 1), 0];
  for (const [itemId, counts] of Object.entries(balances)) grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  ensureArmy(user);
  user.ship = user.army.ships[String(user.ship.unitUid)];
  user.ship.isSeized = options.seized === true;
  user.targetShipId = targetShipId;
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

function success(user, targetShipId, expectedItems) {
  socket.session.user = user;
  send(request(user.ship.unitUid, targetShipId));
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.ship.unitUid.toString(), String(user.ship.unitUid));
  assert.strictEqual(ack.ship.unitId, targetShipId);
  assert.strictEqual(ack.ship.level, Number(user.ship.level));
  assert.deepStrictEqual(ack.costItems, expectedItems);
  assertBalances(user, expectedItems);
  assert.strictEqual(getArmyUnitByUid(user, user.ship.unitUid).unitId, targetShipId);
  assert(user.collection.ships.includes(targetShipId));
}

function request(shipUid, nextShipId) {
  return Buffer.concat([writeSignedVarLong(BigInt(shipUid)), writeSignedVarInt(nextShipId)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.SHIP_UPGRADE_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.SHIP_UPGRADE_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response, "ship-upgrade handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_UPGRADE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const shipPresent = readBool(response.payload, error.offset);
  assert.strictEqual(shipPresent.value, false);
  const items = readMiscItemList(response.payload, shipPresent.offset);
  assert.deepStrictEqual(items.values, []);
  assert.strictEqual(items.offset, response.payload.length, "failed ship-upgrade ACK must contain no trailing fields");
}

function readAck() {
  assert(response, "ship-upgrade handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_UPGRADE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, true);
  const ship = readUnitData(response.payload, present.offset);
  const items = readMiscItemList(response.payload, ship.offset);
  assert.strictEqual(items.offset, response.payload.length, "successful ship-upgrade ACK must contain no trailing fields");
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
      assert(result.ok, `managed client schema rejected ship-upgrade packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
