"use strict";

const assert = require("assert");
const path = require("path");
const { PACKETS, createContractHandler } = require("../modules/contract");
const { getPieceTemplet } = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance, toBigInt } = require("../modules/inventory");
const { getInventoryUsage, INVENTORY_TYPES } = require("../modules/inventory-capacity");
const { getArmyUnits, grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeNullableObjectList,
  writeNullObject,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ERRORS = Object.freeze({
  OK: 0,
  ARMY_FULL: 112,
  INVALID_ITEM_ID: 244,
  INVALID_REQUEST: 20191,
  ITEM_INSUFFICIENT_COUNT: 20332,
});
const PIECE_ITEM_ID = 901026;
const FIXED_NOW = 638500000000000000n;
const rootDir = path.resolve(__dirname, "..");
const piece = getPieceTemplet(PIECE_ITEM_ID);
assert(piece, "frozen piece table must contain the scout fixture");
assert.strictEqual(Number(piece.m_PieceReq_First), 100);
assert.strictEqual(Number(piece.m_PieceReq), 70);
const targetUnitId = Number(piece.m_PieceGetUnitID);

const user = createUser("986000000000031", "PieceExchangeCheck");
const socket = { session: { user } };
const handler = createContractHandler(PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ, "EXCHANGE_PIECE_TO_UNIT_REQ");
const managedWire = [];
const spends = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => FIXED_NOW,
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "piece-exchange");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition, amount, details) {
    assert.strictEqual(condition, "USE_RESOURCE");
    assert.strictEqual(details.itemId, PIECE_ITEM_ID);
    spends.push(Number(amount));
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertFailure(ERRORS.INVALID_REQUEST);
send(Buffer.concat([request(PIECE_ITEM_ID, 1), Buffer.from([0])]), false);
assertFailure(ERRORS.INVALID_REQUEST);
send(request(0, 1));
assertFailure(ERRORS.INVALID_ITEM_ID);
send(request(999999, 1));
assertFailure(ERRORS.INVALID_ITEM_ID);
send(request(PIECE_ITEM_ID, 0));
assertFailure(ERRORS.INVALID_REQUEST);
send(request(PIECE_ITEM_ID, -1));
assertFailure(ERRORS.INVALID_REQUEST);
assertNoMutation();

setMiscItemBalance(user, PIECE_ITEM_ID, 169);
send(request(PIECE_ITEM_ID, 2));
assertFailure(ERRORS.ITEM_INSUFFICIENT_COUNT);
assert.strictEqual(pieceBalance(user), 169n);
assert.strictEqual(getArmyUnits(user).length, 0);
assertNoMutation();

const capacityUser = createUser("986000000000032", "PieceCapacityCheck");
for (let index = 0; index < 199; index += 1) assert(grantUnit(capacityUser, 1001));
capacityUser.inventoryExpansion = { unit: 200 };
setMiscItemBalance(capacityUser, PIECE_ITEM_ID, 170);
socket.session.user = capacityUser;
send(request(PIECE_ITEM_ID, 2));
assertFailure(ERRORS.ARMY_FULL);
assert.strictEqual(getInventoryUsage(capacityUser, INVENTORY_TYPES.UNIT), 199);
assert.strictEqual(pieceBalance(capacityUser), 170n);
assertNoMutation();
socket.session.user = user;

setMiscItemBalance(user, PIECE_ITEM_ID, 180);
const firstBefore = new Set(rawArmyUnits(user).map((unit) => String(unit.unitUid)));
send(request(PIECE_ITEM_ID, 2));
const firstUnits = rawArmyUnits(user).filter((unit) => !firstBefore.has(String(unit.unitUid)));
assert.strictEqual(firstUnits.length, 2);
assert(firstUnits.every((unit) => Number(unit.unitId) === targetUnitId));
assert.strictEqual(pieceBalance(user), 10n, "first multi-scout must charge first-price once plus repeat-price once");
assert(user.collection.units.includes(targetUnitId));
assertSuccess(firstUnits, getMiscItem(user, PIECE_ITEM_ID));
assertMutation(1);
assert.deepStrictEqual(spends, [170]);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnits(restarted).filter((unit) => Number(unit.unitId) === targetUnitId).length, 2);
assert(restarted.collection.units.includes(targetUnitId));
assert.strictEqual(pieceBalance(restarted), 10n);

setMiscItemBalance(user, PIECE_ITEM_ID, 139);
send(request(PIECE_ITEM_ID, 2));
assertFailure(ERRORS.ITEM_INSUFFICIENT_COUNT);
assert.strictEqual(getArmyUnits(user).length, 2);
assertMutation(1);

setMiscItemBalance(user, PIECE_ITEM_ID, 150);
const repeatBefore = new Set(rawArmyUnits(user).map((unit) => String(unit.unitUid)));
send(request(PIECE_ITEM_ID, 2));
const repeatUnits = rawArmyUnits(user).filter((unit) => !repeatBefore.has(String(unit.unitUid)));
assert.strictEqual(repeatUnits.length, 2);
assert.strictEqual(pieceBalance(user), 10n, "repeat multi-scout must use only the repeat price");
assertSuccess(repeatUnits, getMiscItem(user, PIECE_ITEM_ID));
assertMutation(2);
assert.deepStrictEqual(spends, [170, 140]);

const repeatRestart = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnits(repeatRestart).filter((unit) => Number(unit.unitId) === targetUnitId).length, 4);
assert.strictEqual(pieceBalance(repeatRestart), 10n);

validateManagedSchemas();
console.log(`[piece-exchange-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser(userUid, nickname) {
  return { userUid, nickname, collection: { units: [] } };
}

function request(itemId, count) {
  return Buffer.concat([writeSignedVarInt(itemId), writeSignedVarInt(count)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(errorCode) {
  assert(response, "piece-exchange handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.EXCHANGE_PIECE_TO_UNIT_ACK);
  const expected = Buffer.concat([
    writeSignedVarInt(errorCode),
    writeNullableObjectList([]),
    writeNullObject(),
  ]);
  assert.deepStrictEqual(response.payload, expected);
}

function assertSuccess(units, costItem) {
  assert.strictEqual(response.packetId, PACKETS.EXCHANGE_PIECE_TO_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, ERRORS.OK);
  const count = readUnsignedVarInt(response.payload, error.offset);
  assert.strictEqual(count.value, units.length);
  let offset = count.offset;
  const unitUids = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(response.payload, offset);
    assert.strictEqual(present.value, true);
    const decoded = readUnitData(response.payload, present.offset);
    assert.strictEqual(decoded.unitId, targetUnitId);
    unitUids.push(String(decoded.unitUid));
    offset = decoded.offset;
  }
  assert.deepStrictEqual(unitUids.sort(), units.map((unit) => String(unit.unitUid)).sort());

  const costPresent = readBool(response.payload, offset);
  assert.strictEqual(costPresent.value, true);
  const itemId = readSignedVarInt(response.payload, costPresent.offset);
  const countFree = readSignedVarLong(response.payload, itemId.offset);
  const countPaid = readSignedVarLong(response.payload, countFree.offset);
  const bonusRatio = readSignedVarInt(response.payload, countPaid.offset);
  assert.strictEqual(itemId.value, PIECE_ITEM_ID);
  assert.strictEqual(countFree.value, toBigInt(costItem.countFree));
  assert.strictEqual(countPaid.value, toBigInt(costItem.countPaid));
  assert.strictEqual(bonusRatio.offset + 8, response.payload.length);
}

function readUnitData(payload, startOffset) {
  const uid = readSignedVarLong(payload, startOffset);
  let offset = uid.offset;
  offset = readSignedVarLong(payload, offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  offset = unitId.offset;
  for (let index = 0; index < 3; index += 1) offset = readSignedVarInt(payload, offset).offset;
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
  for (let index = 0; index < 3; index += 1) offset = readBool(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  const moduleCount = readUnsignedVarInt(payload, offset);
  assert.strictEqual(moduleCount.value, 0, "scouted normal units must not contain ship modules");
  offset = readSignedVarInt(payload, moduleCount.offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  return { unitUid: uid.value, unitId: unitId.value, offset };
}

function skipIntList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return offset;
}

function skipFloatList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  return count.offset + count.value * 4;
}

function skipLongList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(payload, offset).offset;
  return offset;
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated unsigned varint");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("unsigned varint too long");
}

function pieceBalance(targetUser) {
  const item = getMiscItem(targetUser, PIECE_ITEM_ID);
  return toBigInt(item.countFree) + toBigInt(item.countPaid);
}

function rawArmyUnits(targetUser) {
  return Object.values(targetUser && targetUser.army && targetUser.army.units || {});
}

function assertNoMutation() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.strictEqual(spends.length, 0);
}

function assertMutation(expectedCount) {
  assert.strictEqual(saves, expectedCount);
  assert.strictEqual(invalidations, expectedCount);
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
      assert(result.ok, `managed client schema rejected piece-exchange packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
