"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCombatRosterHandlers } = require("../modules/combat-roster");
const { ensureArmy, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const PACKETS = Object.freeze({ ROLL: 1449, ROLL_ACK: 1450, CONFIRM: 1451, CONFIRM_ACK: 1452, FIRST: 1453, FIRST_ACK: 1454, CANCEL: 1455, CANCEL_ACK: 1456 });
const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  WARFARE_DOING: 213,
  DIVE_DOING: 330,
  INVALID_REQUEST: 20191,
  SHIP_IS_SEIZED: 20315,
  SHIP_NOT_EXISTS: 22702,
  MODULE_UNLOCK: 22707,
  INVALID_MODULE_INDEX: 22708,
  SLOT_NULL: 22710,
  COMMAND_MODULE_TEMPLET: 22711,
  SLOT_LOCK_ALL: 22713,
  CANDIDATE_INVALID_REQUEST: 22718,
  SLOT_NOT_NULL: 22719,
});
const rootDir = path.resolve(__dirname, "..");
const handlers = new Map(createCombatRosterHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [PACKETS.ROLL, PACKETS.CONFIRM, PACKETS.FIRST, PACKETS.CANCEL]) {
  assert(handlers.has(packetId), `ship-module option handler ${packetId} must be registered`);
}

const moduleRows = readGameplayTableRecords("ab_script", "LUA_COMMANDMODULE_TEMPLET");
const passiveRows = readGameplayTableRecords("ab_script", "LUA_COMMANDMODULE_PASSIVE_TEMPLET");
const statRows = readGameplayTableRecords("ab_script", "LUA_COMMANDMODULE_RANDOM_STAT");
assert.strictEqual(moduleRows.length, 48, "frozen command-module table row count changed");
assert.strictEqual(passiveRows.length, 30, "frozen command-module passive row count changed");
assert.strictEqual(statRows.length, 150, "frozen command-module stat row count changed");
for (const row of moduleRows) {
  for (const slot of [1, 2]) assert(passiveRows.some((passive) => Number(passive.CMDPassiveGroupID) === Number(row[`CommandModuleSlot${slot}`])));
  for (const cost of [1, 2]) {
    assert(Number(row[`ModuleReqItemID${cost}`]) > 0);
    assert(Number(row[`ModuleReqItemValue${cost}`]) > 0);
  }
}
for (const passive of passiveRows) assert(statRows.some((stat) => Number(stat.StatGroupID) === Number(passive.StatGroupID)));

const socket = { session: { user: null } };
const managedWire = [];
const missionEvents = [];
let fixtureId = 0n;
let response = null;
let saves = 0;
let invalidations = 0;
let runtimeOpenTags = [];
let randomBoundary = "min";
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags],
  randomInt(max) { return randomBoundary === "max" ? max - 1 : 0; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "combat-roster-update");
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

failure("truncated first request", PACKETS.FIRST, createUser, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
failure("trailing first request", PACKETS.FIRST, emptyFixture, (user) => Buffer.concat([optionRequest(user.ship.unitUid, 0), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
failure("zero ship UID", PACKETS.FIRST, emptyFixture, () => optionRequest(0, 0), ERRORS.INVALID_REQUEST);
failure("missing ship", PACKETS.FIRST, emptyFixture, () => optionRequest(999999999, 0), ERRORS.SHIP_NOT_EXISTS);
failure("negative module", PACKETS.FIRST, emptyFixture, standardRequest(-1), ERRORS.INVALID_MODULE_INDEX);
failure("module over maximum", PACKETS.FIRST, emptyFixture, standardRequest(3), ERRORS.INVALID_MODULE_INDEX);
failure("module not unlocked", PACKETS.FIRST, () => makeFixture({ limitBreakLevel: 0, modules: [] }), standardRequest(0), ERRORS.MODULE_UNLOCK);
failure("closed content tag", PACKETS.FIRST, emptyFixture, standardRequest(0), ERRORS.COMMAND_MODULE_TEMPLET, true, []);
failure("seized ship", PACKETS.FIRST, () => makeFixture({ isSeized: true }), standardRequest(0), ERRORS.SHIP_IS_SEIZED);
failure("warfare ship", PACKETS.FIRST, () => makeFixture({ deckState: 2 }), standardRequest(0), ERRORS.WARFARE_DOING);
failure("dive ship", PACKETS.FIRST, () => makeFixture({ deckState: 3 }), standardRequest(0), ERRORS.DIVE_DOING);
failure("first option already opened", PACKETS.FIRST, openedFixture, standardRequest(0), ERRORS.SLOT_NOT_NULL);
failure("roll with null slot", PACKETS.ROLL, () => makeFixture({ modules: [{ slots: [null, slot()] }] }), standardRequest(0), ERRORS.SLOT_NULL);
failure("roll with all slots locked", PACKETS.ROLL, () => makeFixture({ modules: [{ slots: [slot(true), slot(true)] }] }), standardRequest(0), ERRORS.SLOT_LOCK_ALL);
failure("roll with insufficient first item", PACKETS.ROLL, () => openedFixture({ firstBalance: 0 }), standardRequest(0), ERRORS.INSUFFICIENT_ITEM);
failure("roll with insufficient second item", PACKETS.ROLL, () => openedFixture({ secondBalance: 0 }), standardRequest(0), ERRORS.INSUFFICIENT_ITEM);
failure("confirm without candidate", PACKETS.CONFIRM, openedFixture, standardRequest(0), ERRORS.CANDIDATE_INVALID_REQUEST);
failure("confirm mismatched candidate", PACKETS.CONFIRM, () => {
  const user = openedFixture();
  user.pendingShipModuleCandidate = { shipUid: user.ship.unitUid, moduleId: 1, module: { slots: [slot(), slot()] } };
  return user;
}, standardRequest(0), ERRORS.CANDIDATE_INVALID_REQUEST);
failure("trailing cancel request", PACKETS.CANCEL, openedFixture, Buffer.from([0]), ERRORS.INVALID_REQUEST);
assert.deepStrictEqual([saves, invalidations, missionEvents.length], [0, 0, 0]);

runtimeOpenTags = ["SHIP_COMMANDMODULE"];
randomBoundary = "min";
const user = emptyFixture({ firstBalance: 3, secondBalance: 45 });
socket.session.user = user;
send(PACKETS.FIRST, optionRequest(user.ship.unitUid, 0));
let ack = readShipAck(PACKETS.FIRST_ACK);
assert.strictEqual(ack.errorCode, ERRORS.OK);
assert.strictEqual(ack.ship.unitUid.toString(), String(user.ship.unitUid));
assert.deepStrictEqual(ack.ship.modules[0].slots[0], { targetStyleType: [1], targetRoleType: [], statType: 10001, statValue: 0.005, isLock: false });
assert.deepStrictEqual(ack.ship.modules[0].slots[1], { targetStyleType: [], targetRoleType: [1], statType: 10001, statValue: 0.015, isLock: false });
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);
assert.strictEqual(missionEvents.length, 0, "first option must be free");

const originalSlot = { targetStyleType: [2], targetRoleType: [], statType: "NST_HP_FACTOR", statValue: 0.014, isLock: true };
refreshShip(user);
user.ship.shipCommandModules[0].slots[0] = originalSlot;
assert(user.ship.shipCommandModules[0].slots.every(Boolean), "opened module must contain two slots before reroll");
send(PACKETS.ROLL, optionRequest(user.ship.unitUid, 0));
ack = readRollAck();
assert.strictEqual(ack.errorCode, ERRORS.OK);
assert.deepStrictEqual(ack.candidate.module.slots[0], { ...originalSlot, statType: 10000 });
assert.deepStrictEqual(ack.candidate.module.slots[1], { targetStyleType: [], targetRoleType: [1], statType: 10001, statValue: 0.015, isLock: false });
const rolledCandidateWireSlots = ack.candidate.module.slots;
assert.deepStrictEqual(ack.ship.modules[0].slots[0], { ...originalSlot, statType: 10000 }, "reroll must not commit candidate to the ship");
assert.deepStrictEqual(ack.costItems.map((item) => [item.itemId, item.countFree]), [[1201, 2], [1011, 30]]);
assert.strictEqual(getMiscItem(user, 1201).countFree, "2");
assert.strictEqual(getMiscItem(user, 1011).countFree, "30");
assert.deepStrictEqual(missionEvents.map((event) => [event.condition, event.amount, event.details.itemId]), [["USE_RESOURCE", 1, 1201], ["USE_RESOURCE", 15, 1011]]);
assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);

const restarted = JSON.parse(JSON.stringify(user));
assert(restarted.pendingShipModuleCandidate, "candidate must survive JSON restart");
const expectedPendingModule = restarted.pendingShipModuleCandidate.module;
refreshShip(restarted);
socket.session.user = restarted;
send(PACKETS.CONFIRM, optionRequest(restarted.ship.unitUid, 0));
ack = readShipAck(PACKETS.CONFIRM_ACK);
assert.strictEqual(ack.errorCode, ERRORS.OK);
assert.strictEqual(restarted.pendingShipModuleCandidate, undefined);
assert.deepStrictEqual(restarted.ship.shipCommandModules[0], expectedPendingModule);
assert.deepStrictEqual(ack.ship.modules[0].slots, rolledCandidateWireSlots);
assert.strictEqual(saves, 3);
assert.strictEqual(invalidations, 3);

send(PACKETS.CANCEL, Buffer.alloc(0));
assertCancelAck(ERRORS.OK);
assert.strictEqual(saves, 3, "empty cancel must be idempotent");
restarted.pendingShipModuleCandidate = { shipUid: restarted.ship.unitUid, moduleId: 0, module: { slots: [slot(), slot()] } };
send(PACKETS.CANCEL, Buffer.alloc(0));
assertCancelAck(ERRORS.OK);
assert.strictEqual(restarted.pendingShipModuleCandidate, undefined);
assert.strictEqual(saves, 4);
assert.strictEqual(invalidations, 4);

randomBoundary = "max";
const maxBoundaryUser = emptyFixture();
socket.session.user = maxBoundaryUser;
send(PACKETS.FIRST, optionRequest(maxBoundaryUser.ship.unitUid, 0));
ack = readShipAck(PACKETS.FIRST_ACK);
assert.deepStrictEqual(ack.ship.modules[0].slots[0], { targetStyleType: [3], targetRoleType: [], statType: 42, statValue: 0.03, isLock: false });
assert.deepStrictEqual(ack.ship.modules[0].slots[1], { targetStyleType: [], targetRoleType: [7], statType: 12, statValue: 0.03, isLock: false });
assert.strictEqual(saves, 5);
assert.strictEqual(invalidations, 5);

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert(listenerSource.includes("writeNullableObject(buildShipModuleCandidateData(user)), // shipSlotCandidate"));
assert(listenerSource.includes("buildSerializedShipModuleCandidateData(user && user.pendingShipModuleCandidate)"));

validateManagedSchemas();
console.log(`[ship-module-options-protocol-check] PASS saves=${saves} packets=${managedWire.length} tables=${moduleRows.length}/${passiveRows.length}/${statRows.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(985000000000000n + fixtureId), nickname: "ShipModuleOptionsCheck" };
  ensureArmy(user);
  return user;
}

function emptyFixture(options = {}) {
  return makeFixture({ ...options, modules: [{ slots: [null, null] }] });
}

function openedFixture(options = {}) {
  return makeFixture({ ...options, modules: [{ slots: [slot(false), slot(false)] }] });
}

function makeFixture(options = {}) {
  const user = createUser();
  user.ship = grantUnit(user, 21001, {
    level: 100,
    limitBreakLevel: options.limitBreakLevel == null ? 1 : options.limitBreakLevel,
    shipCommandModules: options.modules || [{ slots: [null, null] }],
  });
  assert(user.ship);
  user.ship.isSeized = Boolean(options.isSeized);
  if (options.firstBalance !== 0) grantMiscItem(user, 1201, options.firstBalance == null ? 1 : options.firstBalance);
  if (options.secondBalance !== 0) grantMiscItem(user, 1011, options.secondBalance == null ? 15 : options.secondBalance);
  getMiscItem(user, 1201);
  getMiscItem(user, 1011);
  if (options.firstBalance === 0) setMiscItemBalance(user, 1201, 0);
  if (options.secondBalance === 0) setMiscItemBalance(user, 1011, 0);
  ensureArmy(user);
  user.ship = user.army.ships[String(user.ship.unitUid)];
  if (options.deckState) {
    user.army.deckSets["0"] = [{ shipUid: user.ship.unitUid, state: options.deckState, unitUids: [] }];
    ensureArmy(user);
    user.ship = user.army.ships[String(user.ship.unitUid)];
  }
  return user;
}

function slot(isLock = false) {
  return { targetStyleType: [], targetRoleType: [], statType: "NST_HP", statValue: 0.01, isLock };
}

function refreshShip(user) {
  user.ship = user.army.ships[String(user.ship.unitUid)];
  return user.ship;
}

function standardRequest(moduleId) {
  return (user) => optionRequest(user.ship.unitUid, moduleId);
}

function optionRequest(shipUid, moduleId) {
  return Buffer.concat([writeSignedVarLong(BigInt(shipUid)), writeSignedVarInt(moduleId)]);
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) managedWire.push([packetId, payload]);
  response = null;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: 1, payload }), true);
}

function failure(name, packetId, makeUser, makePayload, expectedError, validateRequest = true, tags = ["SHIP_COMMANDMODULE"]) {
  const user = makeUser();
  socket.session.user = user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(user));
  const counters = [saves, invalidations, missionEvents.length];
  send(packetId, typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  const ackPacket = packetId + 1;
  if (ackPacket === PACKETS.ROLL_ACK) {
    const decoded = readRollAck();
    assert.strictEqual(decoded.errorCode, expectedError, name);
    assert.strictEqual(decoded.ship, null);
    assert.strictEqual(decoded.candidate, null);
    assert.deepStrictEqual(decoded.costItems, []);
  } else if (ackPacket === PACKETS.CANCEL_ACK) {
    assertCancelAck(expectedError);
  } else {
    const decoded = readShipAck(ackPacket);
    assert.strictEqual(decoded.errorCode, expectedError, name);
    assert.strictEqual(decoded.ship, null);
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
  assert.deepStrictEqual([saves, invalidations, missionEvents.length], counters, `${name} must not commit`);
}

function readShipAck(packetId) {
  assert(response);
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  const ship = readNullableUnit(response.payload, error.offset);
  assert.strictEqual(ship.offset, response.payload.length);
  return { errorCode: error.value, ship: ship.value };
}

function readRollAck() {
  assert(response);
  assert.strictEqual(response.packetId, PACKETS.ROLL_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const ship = readNullableUnit(response.payload, error.offset);
  const candidate = readNullableCandidate(response.payload, ship.offset);
  const costItems = readMiscItemList(response.payload, candidate.offset);
  assert.strictEqual(costItems.offset, response.payload.length);
  return { errorCode: error.value, ship: ship.value, candidate: candidate.value, costItems: costItems.values };
}

function assertCancelAck(errorCode) {
  assert(response);
  assert.strictEqual(response.packetId, PACKETS.CANCEL_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode);
  assert.strictEqual(error.offset, response.payload.length);
}

function readNullableUnit(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { value: null, offset: present.offset };
  const value = readUnitData(payload, present.offset);
  return { value, offset: value.offset };
}

function readNullableCandidate(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { value: null, offset: present.offset };
  const shipUid = readSignedVarLong(payload, present.offset);
  const moduleId = readSignedVarInt(payload, shipUid.offset);
  const module = readNullableShipModule(payload, moduleId.offset);
  return { value: { shipUid: shipUid.value, moduleId: moduleId.value, module: module.value }, offset: module.offset };
}

function readNullableShipModule(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { value: null, offset: present.offset };
  const value = readShipModule(payload, present.offset);
  return { value, offset: value.offset };
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = readSignedVarLong(payload, unitUid.offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
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
  offset = readSignedVarInt(payload, offset).offset + 8;
  offset = readSignedVarInt(payload, offset).offset + 8;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  const modules = readShipModuleList(payload, offset);
  offset = readSignedVarInt(payload, modules.offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  return { unitUid: unitUid.value, modules: modules.values, offset };
}

function readShipModuleList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readNullableShipModule(payload, offset);
    values.push(value.value);
    offset = value.offset;
  }
  return { values, offset };
}

function readShipModule(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const slots = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    offset = present.offset;
    if (!present.value) {
      slots.push(null);
      continue;
    }
    const styles = readIntList(payload, offset);
    const roles = readIntList(payload, styles.offset);
    const statType = readSignedVarInt(payload, roles.offset);
    const statValue = payload.readFloatLE(statType.offset);
    const isLock = readBool(payload, statType.offset + 4);
    offset = isLock.offset;
    slots.push({ targetStyleType: styles.values, targetRoleType: roles.values, statType: statType.value, statValue: rounded(statValue), isLock: isLock.value });
  }
  return { slots, offset };
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
    offset = readSignedVarInt(payload, countPaid.offset).offset + 8;
    values.push({ itemId: itemId.value, countFree: Number(countFree.value), countPaid: Number(countPaid.value) });
  }
  return { values, offset };
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

function skipIntList(payload, startOffset) { return readIntList(payload, startOffset).offset; }

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

function rounded(value) { return Math.round(value * 1000000) / 1000000; }

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
      assert(result.ok, `managed client schema rejected ship-module option packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
