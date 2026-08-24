"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getShipLimitBreakCosts } = require("../modules/game-data");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const { readBool, readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.LIMIT_BREAK_SHIP_REQ);
assert(handler, "ship-limit-break handler must be registered");

const managedWire = [];
let fixtureId = 0n;
let runtimeOpenTags = [];
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
    assert.strictEqual(reason, "ship-limitbreak");
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

failure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.SHIP_NOT_EXISTS, false);
failure("trailing", makeFixture, (user) => Buffer.concat([request(user.target.unitUid, user.consumed.unitUid), Buffer.from([0])]), ERROR_CODES.SHIP_NOT_EXISTS, false);
failure("missing target", createUser, () => request(999999999, 888888888), ERROR_CODES.SHIP_NOT_EXISTS);
failure("normal-unit target", makeNormalTargetFixture, (user) => request(user.target.unitUid, 888888888), ERROR_CODES.SHIP_NOT_EXISTS);
failure("seized target", () => makeFixture({ seized: true }), standardRequest, ERROR_CODES.SHIP_IS_SEIZED);
failure("warfare target", () => makeFixture({ deckState: 2 }), standardRequest, ERROR_CODES.WARFARE_DOING);
failure("dive target", () => makeFixture({ deckState: 3 }), standardRequest, ERROR_CODES.DIVE_DOING);
failure("target below current maximum", () => makeFixture({ targetLevel: 99 }), standardRequest, ERROR_CODES.SHIP_REMODEL_NOT_ENOUGH_LEVEL);
failure("negative consumed UID", makeFixture, (user) => request(user.target.unitUid, -1), ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
failure("zero consumed UID", makeFixture, (user) => request(user.target.unitUid, 0), ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
failure("missing consumed ship", makeFixture, (user) => request(user.target.unitUid, 888888888), ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
failure("normal-unit consumed UID", () => makeFixture({ consumeId: 1001 }), standardRequest, ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
failure("self consumption", makeFixture, (user) => request(user.target.unitUid, user.target.unitUid), ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
failure("locked consumed ship", () => makeFixture({ consumeLocked: true }), standardRequest, ERROR_CODES.SHIP_LIMITBREAK_LOCKED_CONSUMED_SHIP);
failure("closed system tag", makeFixture, standardRequest, ERROR_CODES.SHIP_LIMITBREAK_TEMPLET, true, []);
failure("already at maximum grade", () => makeFixture({ targetLevel: 130, limitBreakLevel: 3 }), standardRequest, ERROR_CODES.SHIP_LIMITBREAK_TEMPLET);
failure("consumed ship outside material group", () => makeFixture({ consumeId: 21002 }), standardRequest, ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
failure("insufficient configured cost", () => makeFixture({ underfund: true }), standardRequest, ERROR_CODES.INSUFFICIENT_ITEM);
assertNoCommits();

const first = makeFixture({ deckState: 1, balances: { 1: [100000, 250001] } });
success(first, 1, [{ itemId: 1, countFree: 0, countPaid: 50001 }]);
assert.strictEqual(first.army.deckSets["1"][0].shipUid, first.target.unitUid, "world-map target assignment must remain intact");

const second = makeFixture({ targetLevel: 110, limitBreakLevel: 1, consumeId: 26001 });
const secondCosts = getShipLimitBreakCosts(26001, 2);
success(second, 2, secondCosts.map((cost) => ({ itemId: cost.itemId, countFree: 1, countPaid: 0 })));

assert.strictEqual(saves, 2, "only successful ship limit breaks may save");
assert.strictEqual(invalidations, 2, "only successful ship limit breaks may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["SHIP_LIMITBREAK", 1, undefined],
    ["USE_RESOURCE", 300000, 1],
    ["SHIP_LIMITBREAK", 1, undefined],
    ["USE_RESOURCE", 600000, 1],
  ]
);

for (const [user, grade] of [[first, 1], [second, 2]]) {
  const restarted = JSON.parse(JSON.stringify(user));
  const target = getArmyUnitByUid(restarted, user.target.unitUid);
  assert(target, "limit-broken target ship must survive restart");
  assert.strictEqual(target.limitBreakLevel, grade);
  assert.strictEqual(target.shipCommandModules.length, grade, "unlocked command modules must survive restart");
  assert.deepStrictEqual(target.shipCommandModules[grade - 1], { slots: [null, null] });
  assert.strictEqual(getArmyUnitByUid(restarted, user.consumed.unitUid), null, "consumed ship must remain removed after restart");
}

validateManagedSchemas();
console.log(`[ship-limitbreak-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(982000000000000n + fixtureId), nickname: "ShipLimitBreakCheck" };
  ensureArmy(user);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  user.target = grantUnit(user, 26001, {
    level: options.targetLevel == null ? 100 : options.targetLevel,
    limitBreakLevel: options.limitBreakLevel || 0,
    fromContract: false,
  });
  user.consumed = grantUnit(user, options.consumeId || 21001, { level: 1, fromContract: false });
  assert(user.target && user.consumed, "ship-limit-break fixture entries must exist");
  const costs = getShipLimitBreakCosts(26001, Number(options.limitBreakLevel || 0) + 1) || [];
  const balances = options.balances || Object.fromEntries(costs.map((cost) => [cost.itemId, [cost.count + 1, 0]]));
  if (options.underfund && costs.length) balances[costs[0].itemId] = [Math.max(0, costs[0].count - 1), 0];
  for (const [itemId, counts] of Object.entries(balances)) grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  ensureArmy(user);
  user.consumed =
    user.army.ships[String(user.consumed.unitUid)] ||
    user.army.units[String(user.consumed.unitUid)];
  user.target = user.army.ships[String(user.target.unitUid)];
  user.target.isSeized = options.seized === true;
  user.consumed.locked = options.consumeLocked === true;
  if (options.deckState) {
    const deck = user.army.deckSets["1"][0];
    deck.shipUid = user.target.unitUid;
    deck.state = options.deckState;
  }
  return user;
}

function makeNormalTargetFixture() {
  const user = createUser();
  user.target = grantUnit(user, 1001, { level: 100 });
  ensureArmy(user);
  user.target = user.army.units[String(user.target.unitUid)];
  return user;
}

function standardRequest(user) {
  return request(user.target.unitUid, user.consumed.unitUid);
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true, tags = ["SHIP_LIMITBREAK"]) {
  const user = makeUser();
  socket.session.user = user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function success(user, expectedGrade, expectedItems) {
  socket.session.user = user;
  runtimeOpenTags = ["SHIP_LIMITBREAK"];
  const consumedUid = user.consumed.unitUid;
  send(request(user.target.unitUid, consumedUid));
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.ship.unitUid.toString(), String(user.target.unitUid));
  assert.strictEqual(ack.ship.unitId, 26001);
  assert.strictEqual(ack.ship.limitBreakLevel, expectedGrade);
  assert.strictEqual(ack.consumeShipUid.toString(), String(consumedUid));
  assert.deepStrictEqual(ack.costItems, expectedItems);
  const storedTarget = getArmyUnitByUid(user, user.target.unitUid);
  assert.strictEqual(storedTarget.limitBreakLevel, expectedGrade);
  assert.strictEqual(storedTarget.shipCommandModules.length, expectedGrade, "limit break must unlock exactly one command module");
  assert.deepStrictEqual(
    storedTarget.shipCommandModules[expectedGrade - 1],
    { slots: [null, null] },
    "newly unlocked command module sockets must remain empty until rolled"
  );
  assert.strictEqual(getArmyUnitByUid(user, consumedUid), null);
  assertBalances(user, expectedItems);
}

function request(shipUid, consumeShipUid) {
  return Buffer.concat([writeSignedVarLong(BigInt(shipUid)), writeSignedVarLong(BigInt(consumeShipUid))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.LIMIT_BREAK_SHIP_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.LIMIT_BREAK_SHIP_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  const ack = readAck(false);
  assert.strictEqual(ack.errorCode, expectedError);
  assert.strictEqual(ack.ship, null);
  assert.deepStrictEqual(ack.costItems, []);
}

function readAck(expectShip = true) {
  assert(response, "ship-limit-break handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.LIMIT_BREAK_SHIP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  let offset = present.offset;
  let ship = null;
  if (present.value) {
    ship = readUnitData(response.payload, offset);
    offset = ship.offset;
  }
  assert.strictEqual(Boolean(ship), expectShip);
  const consumeShipUid = readSignedVarLong(response.payload, offset);
  const items = readMiscItemList(response.payload, consumeShipUid.offset);
  assert.strictEqual(items.offset, response.payload.length, "ship-limit-break ACK must contain no trailing fields");
  return { errorCode: error.value, ship, consumeShipUid: consumeShipUid.value, costItems: items.values };
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
      assert(result.ok, `managed client schema rejected ship-limit-break packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
