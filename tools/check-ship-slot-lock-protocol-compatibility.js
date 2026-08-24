"use strict";

const assert = require("assert");
const path = require("path");
const { createCombatRosterHandlers } = require("../modules/combat-roster");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const PACKETS = Object.freeze({ REQ: 1447, ACK: 1448 });
const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  INVALID_REQUEST: 20191,
  SHIP_NOT_EXISTS: 22702,
  MODULE_UNLOCK: 22707,
  INVALID_MODULE_INDEX: 22708,
  INVALID_SLOT_INDEX: 22709,
  SLOT_NULL: 22710,
  COMMAND_MODULE_TEMPLET: 22711,
  SLOT_LOCK_ALL: 22713,
});
const LOCK_ITEM_ID = 1208;
const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createCombatRosterHandlers().find((entry) => entry.packetId === PACKETS.REQ);
assert(handler, "ship-slot-lock handler must be registered");

const managedWire = [];
const missionEvents = [];
let fixtureId = 0n;
let runtimeOpenTags = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags],
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

failure("truncated", createUser, Buffer.alloc(0), ERRORS.INVALID_REQUEST, false);
failure("trailing", makeFixture, (user) => Buffer.concat([request(user.ship.unitUid, 0, 0, true), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
failure("zero ship UID", makeFixture, () => request(0, 0, 0, true), ERRORS.INVALID_REQUEST);
failure("missing ship", makeFixture, () => request(999999999, 0, 0, true), ERRORS.SHIP_NOT_EXISTS);
failure("normal-unit UID", makeNormalUnitFixture, (user) => request(user.normal.unitUid, 0, 0, true), ERRORS.SHIP_NOT_EXISTS);
failure("negative module index", makeFixture, standardRequest(-1, 0, true), ERRORS.INVALID_MODULE_INDEX);
failure("module index above maximum", makeFixture, standardRequest(3, 0, true), ERRORS.INVALID_MODULE_INDEX);
failure("locked module not unlocked", () => makeFixture({ limitBreakLevel: 0, modules: [] }), standardRequest(0, 0, true), ERRORS.MODULE_UNLOCK);
failure("negative slot index", makeFixture, standardRequest(0, -1, true), ERRORS.INVALID_SLOT_INDEX);
failure("slot index above maximum", makeFixture, standardRequest(0, 2, true), ERRORS.INVALID_SLOT_INDEX);
failure("null slot", () => makeFixture({ modules: [{ slots: [null, slot()] }] }), standardRequest(0, 0, true), ERRORS.SLOT_NULL);
failure("closed system tag", makeFixture, standardRequest(0, 0, true), ERRORS.COMMAND_MODULE_TEMPLET, true, []);
failure("insufficient lock item", () => makeFixture({ balance: 0 }), standardRequest(0, 0, true), ERRORS.INSUFFICIENT_ITEM);
failure("locking both module slots", () => makeFixture({ modules: [{ slots: [slot(false), slot(true)] }] }), standardRequest(0, 0, true), ERRORS.SLOT_LOCK_ALL);

idempotent("already unlocked", makeFixture(), false);
idempotent("already locked", makeFixture({ modules: [{ slots: [slot(true), slot(false)] }] }), true);
assertNoCommits();

const user = makeFixture({ balance: 2 });
socket.session.user = user;
runtimeOpenTags = ["SHIP_COMMANDMODULE"];
send(request(user.ship.unitUid, 0, 0, true));
user.ship = getArmyUnitByUid(user, user.ship.unitUid);
const locked = readAck();
assert.strictEqual(locked.errorCode, ERRORS.OK);
assert.strictEqual(locked.ship.unitUid.toString(), String(user.ship.unitUid));
assert.strictEqual(locked.ship.modules[0].slots[0].isLock, true);
assert.deepStrictEqual(locked.costItems, [{ itemId: LOCK_ITEM_ID, countFree: 1, countPaid: 0 }]);
assert.strictEqual(getMiscItem(user, LOCK_ITEM_ID).countFree, "1");
assert.strictEqual(user.ship.shipCommandModules[0].slots[0].isLock, true);
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [["USE_RESOURCE", 1, LOCK_ITEM_ID]]
);
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);

const restartedLocked = JSON.parse(JSON.stringify(user));
const restartedShip = getArmyUnitByUid(restartedLocked, user.ship.unitUid);
assert(restartedShip, "locked ship must survive JSON restart");
assert.strictEqual(restartedShip.shipCommandModules[0].slots[0].isLock, true);
assert.strictEqual(getMiscItem(restartedLocked, LOCK_ITEM_ID).countFree, "1");

send(request(user.ship.unitUid, 0, 0, false));
user.ship = getArmyUnitByUid(user, user.ship.unitUid);
const unlocked = readAck();
assert.strictEqual(unlocked.errorCode, ERRORS.OK);
assert.strictEqual(unlocked.ship.modules[0].slots[0].isLock, false);
assert.deepStrictEqual(unlocked.costItems, []);
assert.strictEqual(getMiscItem(user, LOCK_ITEM_ID).countFree, "1", "unlocking must be free");
assert.strictEqual(user.ship.shipCommandModules[0].slots[0].isLock, false);
assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);
assert.strictEqual(missionEvents.length, 1, "unlocking must not track a resource spend");

validateManagedSchemas();
console.log(`[ship-slot-lock-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const created = { userUid: String(983000000000000n + fixtureId), nickname: "ShipSlotLockCheck" };
  ensureArmy(created);
  return created;
}

function makeFixture(options = {}) {
  const user = createUser();
  const modules = Object.prototype.hasOwnProperty.call(options, "modules")
    ? options.modules
    : [{ slots: [slot(false), slot(false)] }];
  user.ship = grantUnit(user, 21001, {
    level: 100,
    limitBreakLevel: options.limitBreakLevel == null ? 1 : options.limitBreakLevel,
    shipCommandModules: modules,
  });
  assert(user.ship, "ship-slot-lock fixture ship must exist");
  if (options.balance !== 0) grantMiscItem(user, LOCK_ITEM_ID, options.balance == null ? 1 : options.balance);
  getMiscItem(user, LOCK_ITEM_ID);
  ensureArmy(user);
  user.ship = user.army.ships[String(user.ship.unitUid)];
  return user;
}

function makeNormalUnitFixture() {
  const user = createUser();
  user.normal = grantUnit(user, 1001, { level: 1 });
  assert(user.normal, "normal-unit fixture must exist");
  ensureArmy(user);
  user.normal = user.army.units[String(user.normal.unitUid)];
  return user;
}

function slot(isLock = false) {
  return { targetStyleType: [], targetRoleType: [], statType: "NST_HP", statValue: 7.5, isLock };
}

function standardRequest(moduleId, slotId, locked) {
  return (user) => request(user.ship.unitUid, moduleId, slotId, locked);
}

function request(shipUid, moduleId, slotId, locked) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(shipUid)),
    writeSignedVarInt(moduleId),
    writeSignedVarInt(slotId),
    writeBool(locked),
  ]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.REQ, sequence: 1, payload }), true);
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true, tags = ["SHIP_COMMANDMODULE"]) {
  const user = makeUser();
  socket.session.user = user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(user));
  const beforeCounters = [saves, invalidations, missionEvents.length];
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  const decoded = readAck(false);
  assert.strictEqual(decoded.errorCode, expectedError, name);
  assert.deepStrictEqual(decoded.costItems, [], `${name} must not return costs`);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
  assert.deepStrictEqual([saves, invalidations, missionEvents.length], beforeCounters, `${name} must not commit`);
}

function idempotent(name, user, locked) {
  socket.session.user = user;
  runtimeOpenTags = ["SHIP_COMMANDMODULE"];
  const before = JSON.parse(JSON.stringify(user));
  const beforeCounters = [saves, invalidations, missionEvents.length];
  send(request(user.ship.unitUid, 0, 0, locked));
  const decoded = readAck();
  assert.strictEqual(decoded.errorCode, ERRORS.OK, name);
  assert.strictEqual(decoded.ship.modules[0].slots[0].isLock, locked);
  assert.deepStrictEqual(decoded.costItems, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate state`);
  assert.deepStrictEqual([saves, invalidations, missionEvents.length], beforeCounters, `${name} must not commit`);
}

function assertNoCommits() {
  assert.deepStrictEqual([saves, invalidations, missionEvents.length], [0, 0, 0]);
}

function readAck(expectShip = true) {
  assert(response, "ship-slot-lock handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  let offset = present.offset;
  let ship = null;
  if (present.value) {
    ship = readUnitData(response.payload, offset);
    offset = ship.offset;
  }
  assert.strictEqual(Boolean(ship), expectShip);
  const items = readMiscItemList(response.payload, offset);
  assert.strictEqual(items.offset, response.payload.length, "ship-slot-lock ACK must have no trailing fields");
  return { errorCode: error.value, ship, costItems: items.values };
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
  for (let moduleIndex = 0; moduleIndex < count.value; moduleIndex += 1) {
    const present = readBool(payload, offset);
    offset = present.offset;
    if (!present.value) {
      values.push(null);
      continue;
    }
    const slots = readRawVarInt(payload, offset);
    offset = slots.offset;
    const slotValues = [];
    for (let slotIndex = 0; slotIndex < slots.value; slotIndex += 1) {
      const slotPresent = readBool(payload, offset);
      offset = slotPresent.offset;
      if (!slotPresent.value) {
        slotValues.push(null);
        continue;
      }
      offset = skipIntList(payload, offset);
      offset = skipIntList(payload, offset);
      offset = readSignedVarInt(payload, offset).offset + 4;
      const locked = readBool(payload, offset);
      offset = locked.offset;
      slotValues.push({ isLock: locked.value });
    }
    values.push({ slots: slotValues });
  }
  return { values, offset };
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
      assert(result.ok, `managed client schema rejected ship-slot-lock packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
