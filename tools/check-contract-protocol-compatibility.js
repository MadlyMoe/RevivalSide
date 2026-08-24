"use strict";

const assert = require("assert");
const path = require("path");
const {
  PACKETS,
  CONTRACT_ERRORS,
  createContractHandler,
  getActiveCustomPickupContractRecords,
  getSelectableContractState,
} = require("../modules/contract");
const {
  getContractPoolUnitEntries,
  getCustomPickupContractRecords,
  getMiscContractRecord,
  getMiscItemTemplet,
} = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance, toBigInt } = require("../modules/inventory");
const { getArmyUnits, getArmyOperators } = require("../modules/unit");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const FIXED_NOW = 638500000000000000n;
const STANDARD_CONTRACT_ID = 1999;
const SELECTABLE_CONTRACT_ID = 4001;
const MISC_ITEM_ID = 49006;
const TICKET_ITEM_ID = 1001;
const MONEY_ITEM_ID = 101;
const requestPacketIds = [
  PACKETS.CONTRACT_REQ,
  PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ,
  PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ,
  PACKETS.CONTRACT_STATE_LIST_REQ,
  PACKETS.MISC_CONTRACT_OPEN_REQ,
  PACKETS.INSTANT_CONTRACT_LIST_REQ,
  PACKETS.CUSTOM_PICKUP_REQ,
  PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ,
];
const handlers = new Map(requestPacketIds.map((packetId) => [packetId, createContractHandler(packetId, `CHECK_${packetId}`)]));

const user = { userUid: "986000000000082", nickname: "ContractCheck", collection: { units: [], operators: [] } };
const socket = { session: { user } };
const managedWire = [];
const missionEvents = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => FIXED_NOW,
  getServerNowDate: () => new Date("2026-08-21T12:00:00.000Z"),
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(reason && typeof reason === "string");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount: Number(amount), itemId: Number(details && details.itemId || 0) });
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

for (const packetId of requestPacketIds) {
  const before = snapshot(user);
  const malformed = packetId === PACKETS.CONTRACT_STATE_LIST_REQ || packetId === PACKETS.INSTANT_CONTRACT_LIST_REQ
    ? Buffer.from([0])
    : Buffer.alloc(0);
  send(packetId, malformed, false);
  assertError(CONTRACT_ERRORS.INVALID_REQUEST);
  assert.deepStrictEqual(user, before, `malformed packet ${packetId} must be pure`);
}
const noncanonical = Buffer.concat([Buffer.from([0x9e, 0x00]), writeSignedVarInt(1), writeSignedVarInt(1)]);
send(PACKETS.CONTRACT_REQ, noncanonical, false);
assertError(CONTRACT_ERRORS.INVALID_REQUEST);
assertNoWrites();

const readSnapshot = snapshot(user);
send(PACKETS.CONTRACT_STATE_LIST_REQ, Buffer.alloc(0));
assertError(CONTRACT_ERRORS.OK);
send(PACKETS.INSTANT_CONTRACT_LIST_REQ, Buffer.alloc(0));
assertError(CONTRACT_ERRORS.OK);
assert.deepStrictEqual(user, readSnapshot, "contract reads must not mutate durable state");
assertNoWrites();

send(PACKETS.CONTRACT_REQ, ints(999999, 1, 1));
assertError(CONTRACT_ERRORS.INVALID_CONTRACT_ID);
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 0, 1));
assertError(CONTRACT_ERRORS.INVALID_CONTRACT_COUNT);
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 11, 1));
assertError(CONTRACT_ERRORS.INVALID_CONTRACT_COUNT);
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 1, 99));
assertError(CONTRACT_ERRORS.INVALID_COST_TYPE);
send(PACKETS.CONTRACT_REQ, ints(1998, 1, 0));
assertError(CONTRACT_ERRORS.FREE_CHANCE_DISABLE);
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 1, 1));
assertError(CONTRACT_ERRORS.CANNOT_USE_TICKET_WHEN_FREE_CHANCE_REMAINED);
assertNoWrites();
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 1, 0));
assertError(CONTRACT_ERRORS.OK);
assert.strictEqual(getArmyUnits(user).length, 1);
assertWrites(1);
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 1, 1));
assertError(CONTRACT_ERRORS.INSUFFICIENT_RESOURCE);
assertWrites(1);

setMiscItemBalance(user, TICKET_ITEM_ID, 20);
setMiscItemBalance(user, MONEY_ITEM_ID, 5000);
send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 1, 2));
assertError(CONTRACT_ERRORS.CANNOT_USE_MONEY_WHEN_TICKET_REMAINED);
assert.strictEqual(itemCount(TICKET_ITEM_ID), 20n);
assert.strictEqual(getArmyUnits(user).length, 1);
assertWrites(1);

send(PACKETS.CONTRACT_REQ, ints(STANDARD_CONTRACT_ID, 10, 1));
assertError(CONTRACT_ERRORS.OK);
assert.strictEqual(getArmyUnits(user).length, 11);
assert.strictEqual(itemCount(TICKET_ITEM_ID), 10n);
assertWrites(2);

const activeCustom = getActiveCustomPickupContractRecords(ctx).find((record) => String(record.m_ContractType) === "BASIC");
assert(activeCustom, "frozen custom-pickup table must expose the always-on basic banner");
const customId = Number(activeCustom.customPickupId);
const target = getContractPoolUnitEntries(activeCustom.m_UnitPoolID).find((entry) => entry.pickupTarget);
assert(target && target.unitId > 0, "custom-pickup pool must contain a selectable unit");

send(PACKETS.CUSTOM_PICKUP_REQ, ints(customId, 1, 1));
assertError(CONTRACT_ERRORS.CUSTOM_PICKUP_NEED_TARGET);
send(PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ, ints(customId, 999999));
assertError(CONTRACT_ERRORS.CUSTOM_PICKUP_INVALID_UNIT);
assertWrites(2);
send(PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ, ints(customId, target.unitId));
assertError(CONTRACT_ERRORS.OK);
assertWrites(3);
send(PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ, ints(customId, target.unitId));
assertError(CONTRACT_ERRORS.CUSTOM_PICKUP_ALREADY_SELECTED);
assertWrites(3);
send(PACKETS.CUSTOM_PICKUP_REQ, ints(customId, 1, 1));
assertError(CONTRACT_ERRORS.OK);
assert.strictEqual(getArmyUnits(user).length, 12);
assert.strictEqual(itemCount(TICKET_ITEM_ID), 9n);
assertWrites(4);

user.selectableContractState = {
  contractId: SELECTABLE_CONTRACT_ID,
  unitIdList: Array(10).fill(1001),
  unitPoolChangeCount: 30,
  isActive: true,
};
send(PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ, ints(SELECTABLE_CONTRACT_ID));
assertError(CONTRACT_ERRORS.SELECTABLE_POOL_CHANGE_COUNT_OVER);
assertWrites(4);
user.selectableContractState = { contractId: SELECTABLE_CONTRACT_ID, unitIdList: [], unitPoolChangeCount: 0, isActive: true };
send(PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ, ints(SELECTABLE_CONTRACT_ID));
assertError(CONTRACT_ERRORS.SELECTABLE_POOL_IS_EMPTY);
assertWrites(4);
send(PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ, ints(SELECTABLE_CONTRACT_ID));
assertError(CONTRACT_ERRORS.OK);
assert.strictEqual(getSelectableContractState(user, SELECTABLE_CONTRACT_ID).unitIdList.length, 10);
assertWrites(5);
send(PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ, ints(SELECTABLE_CONTRACT_ID));
assertError(CONTRACT_ERRORS.OK);
assert.strictEqual(getArmyUnits(user).length, 22);
assert.strictEqual(getSelectableContractState(user, SELECTABLE_CONTRACT_ID).isActive, false);
assertWrites(6);
send(PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ, ints(SELECTABLE_CONTRACT_ID));
assertError(CONTRACT_ERRORS.CONTRACT_CLOSED);
assertWrites(6);

const miscTemplet = getMiscItemTemplet(MISC_ITEM_ID);
const miscRecord = miscTemplet && getMiscContractRecord(miscTemplet.m_typeValue);
assert(miscRecord && Number(miscRecord.m_UnitCount) === 1, "frozen misc-contract fixture must grant one unit per item");
send(PACKETS.MISC_CONTRACT_OPEN_REQ, ints(999999, 1));
assertError(CONTRACT_ERRORS.INVALID_ITEM_ID);
send(PACKETS.MISC_CONTRACT_OPEN_REQ, ints(MISC_ITEM_ID, 1));
assertError(CONTRACT_ERRORS.INSUFFICIENT_RESOURCE);
setMiscItemBalance(user, MISC_ITEM_ID, 2);
send(PACKETS.MISC_CONTRACT_OPEN_REQ, ints(MISC_ITEM_ID, 2));
assertError(CONTRACT_ERRORS.OK);
assert.strictEqual(getArmyUnits(user).length, 24);
assert.strictEqual(itemCount(MISC_ITEM_ID), 0n);
assertWrites(7);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnits(restarted).length, 24);
assert.strictEqual(getArmyOperators(restarted).length, 0);
assert.strictEqual(itemCountFrom(restarted, TICKET_ITEM_ID), 9n);
assert.strictEqual(restarted.customPickupContracts[String(customId)].customPickupTargetUnitId, target.unitId);
assert.strictEqual(restarted.selectableContractState.isActive, false);
assert(missionEvents.some((entry) => entry.condition === "UNIT_CONTRACT"));
assert(missionEvents.some((entry) => entry.condition === "USE_RESOURCE" && entry.itemId === TICKET_ITEM_ID));

validateManagedSchemas();
console.log(`[contract-protocol-check] PASS contracts=4 saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload, validateRequest = true) {
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  const handler = handlers.get(packetId);
  assert(handler, `handler ${packetId} must exist`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `handler ${packetId} must send a response`);
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function assertNoWrites() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function ints(...values) {
  return Buffer.concat(values.map(writeSignedVarInt));
}

function itemCount(itemId) {
  return itemCountFrom(user, itemId);
}

function itemCountFrom(owner, itemId) {
  const item = getMiscItem(owner, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
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
      assert(result.ok, `managed client schema rejected contract packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
