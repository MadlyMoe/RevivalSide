"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { equipItemToUnit, getEquipItem, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipTemplet } = require("../modules/game-data");
const { ensureDeck, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const EQUIP_REQ = 1000;
const EQUIP_ACK = 1001;
const NEC_OK = 0;
const NEC_FAIL_UNIT_NOT_EXIST = 136;
const NEC_FAIL_WARFARE_DOING = 213;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_CANNOT_EQUIP_ITEM = 248;
const NEC_FAIL_CANNOT_UNEQUIP_ITEM = 249;
const NEC_FAIL_DIVE_DOING = 330;
const NEC_FAIL_UNIT_IS_SEIZED = 20316;
const rootDir = path.resolve(__dirname, "..");
const counterWeaponId = findEquipId("NUST_COUNTER", "IEP_WEAPON");
const counterAccessoryId = findEquipId("NUST_COUNTER", "IEP_ACC");
const soldierWeaponId = findEquipId("NUST_SOLDIER", "IEP_WEAPON");
const user = { userUid: "986000000000016", nickname: "EquipItemCheck" };
const target = grantUnit(user, 1001, { limitBreakLevel: 0 });
const source = grantUnit(user, 1001, { limitBreakLevel: 3 });
const seized = grantUnit(user, 1001);
const warfare = grantUnit(user, 1001);
const dive = grantUnit(user, 1001);
const first = grantEquipItem(user, counterWeaponId);
const second = grantEquipItem(user, counterWeaponId);
const mover = grantEquipItem(user, counterWeaponId);
const accessory = grantEquipItem(user, counterAccessoryId);
const wrongStyle = grantEquipItem(user, soldierWeaponId);
const privateEquip = grantEquipItem(user, 101003);
assert(target && source && seized && warfare && dive && first && second && mover && accessory && wrongStyle && privateEquip);
getArmyUnitByUid(user, seized.unitUid);
user.army.units[String(seized.unitUid)].isSeized = true;
const warfareDeck = ensureDeck(user, { deckType: 1, index: 0 });
warfareDeck.unitUids[0] = warfare.unitUid;
warfareDeck.state = 2;
const diveDeck = ensureDeck(user, { deckType: 8, index: 0 });
diveDeck.unitUids[0] = dive.unitUid;
diveDeck.state = 3;
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === EQUIP_REQ);
assert(handler, "equipment equip handler must be registered");
const managedWire = [];
let responses = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    responses.push({ packetId, payload });
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertOnlyAck(NEC_FAIL_INVALID_EQUIP_ITEM, 0n, 0n, 0n, 0);
send(Buffer.concat([equipRequest(true, target.unitUid, first.equipUid, 0), Buffer.from([0])]), false);
assertOnlyAck(NEC_FAIL_INVALID_EQUIP_ITEM, BigInt(target.unitUid), BigInt(first.equipUid), 0n, 0);
send(equipRequest(true, target.unitUid, 999999999n, 0));
assertOnlyAck(NEC_FAIL_INVALID_EQUIP_ITEM, BigInt(target.unitUid), 999999999n, 0n, 0);
send(equipRequest(true, 999999999n, first.equipUid, 0));
assertOnlyAck(NEC_FAIL_UNIT_NOT_EXIST, 999999999n, BigInt(first.equipUid), 0n, 0);
send(equipRequest(true, target.unitUid, first.equipUid, 1));
assertOnlyAck(NEC_FAIL_CANNOT_EQUIP_ITEM, BigInt(target.unitUid), BigInt(first.equipUid), 0n, 1);
send(equipRequest(true, target.unitUid, wrongStyle.equipUid, 0));
assertOnlyAck(NEC_FAIL_CANNOT_EQUIP_ITEM, BigInt(target.unitUid), BigInt(wrongStyle.equipUid), 0n, 0);
send(equipRequest(true, target.unitUid, privateEquip.equipUid, 0));
assertOnlyAck(NEC_FAIL_CANNOT_EQUIP_ITEM, BigInt(target.unitUid), BigInt(privateEquip.equipUid), 0n, 0);
send(equipRequest(true, target.unitUid, accessory.equipUid, 3));
assertOnlyAck(NEC_FAIL_CANNOT_EQUIP_ITEM, BigInt(target.unitUid), BigInt(accessory.equipUid), 0n, 3);
send(equipRequest(true, seized.unitUid, first.equipUid, 0));
assertOnlyAck(NEC_FAIL_UNIT_IS_SEIZED, BigInt(seized.unitUid), BigInt(first.equipUid), 0n, 0);
send(equipRequest(true, warfare.unitUid, first.equipUid, 0));
assertOnlyAck(NEC_FAIL_WARFARE_DOING, BigInt(warfare.unitUid), BigInt(first.equipUid), 0n, 0);
send(equipRequest(true, dive.unitUid, first.equipUid, 0));
assertOnlyAck(NEC_FAIL_DIVE_DOING, BigInt(dive.unitUid), BigInt(first.equipUid), 0n, 0);
assert.strictEqual(saves, 0, "rejected equip requests must not persist");

send(equipRequest(true, target.unitUid, first.equipUid, 0));
assertOnlyAck(NEC_OK, BigInt(target.unitUid), BigInt(first.equipUid), 0n, 0);
assert.deepStrictEqual(getArmyUnitByUid(user, target.unitUid).equipItemUids.map(BigInt), [BigInt(first.equipUid), 0n, 0n, 0n]);
assert.strictEqual(saves, 1);
send(equipRequest(true, target.unitUid, first.equipUid, 0));
assertOnlyAck(NEC_OK, BigInt(target.unitUid), BigInt(first.equipUid), 0n, 0);
assert.strictEqual(saves, 1, "idempotent equip must not persist");

send(equipRequest(true, target.unitUid, second.equipUid, 0));
assertOnlyAck(NEC_OK, BigInt(target.unitUid), BigInt(second.equipUid), BigInt(first.equipUid), 0);
assert.strictEqual(getEquipItem(user, first.equipUid).ownerUnitUid, "-1");
assert.strictEqual(saves, 2);
send(equipRequest(true, source.unitUid, mover.equipUid, 0));
assertOnlyAck(NEC_OK, BigInt(source.unitUid), BigInt(mover.equipUid), 0n, 0);
assert.strictEqual(saves, 3);

send(equipRequest(true, target.unitUid, mover.equipUid, 0));
assert.strictEqual(responses.length, 2, "cross-unit transfer must detach the old owner before updating the target");
assertAck(responses[0], NEC_OK, BigInt(source.unitUid), 0n, BigInt(mover.equipUid), 0);
assertAck(responses[1], NEC_OK, BigInt(target.unitUid), BigInt(mover.equipUid), BigInt(second.equipUid), 0);
assert.deepStrictEqual(getArmyUnitByUid(user, source.unitUid).equipItemUids.map(BigInt), [0n, 0n, 0n, 0n]);
assert.strictEqual(getEquipItem(user, second.equipUid).ownerUnitUid, "-1");
assert.strictEqual(saves, 4);

send(equipRequest(false, source.unitUid, mover.equipUid, 0));
assertOnlyAck(NEC_FAIL_CANNOT_UNEQUIP_ITEM, BigInt(source.unitUid), 0n, BigInt(mover.equipUid), 0);
send(equipRequest(false, target.unitUid, mover.equipUid, 1));
assertOnlyAck(NEC_FAIL_CANNOT_UNEQUIP_ITEM, BigInt(target.unitUid), 0n, BigInt(mover.equipUid), 1);
assert.strictEqual(saves, 4, "rejected unequip requests must not persist");
send(equipRequest(false, target.unitUid, mover.equipUid, 0));
assertOnlyAck(NEC_OK, BigInt(target.unitUid), 0n, BigInt(mover.equipUid), 0);
assert.deepStrictEqual(getArmyUnitByUid(user, target.unitUid).equipItemUids.map(BigInt), [0n, 0n, 0n, 0n]);
assert.strictEqual(getEquipItem(user, mover.equipUid).ownerUnitUid, "-1");
assert.strictEqual(saves, 5);

user.army.units[String(target.unitUid)].limitBreakLevel = 3;
send(equipRequest(true, target.unitUid, accessory.equipUid, 3));
assertOnlyAck(NEC_OK, BigInt(target.unitUid), BigInt(accessory.equipUid), 0n, 3);
assert.strictEqual(BigInt(getArmyUnitByUid(user, target.unitUid).equipItemUids[3]), BigInt(accessory.equipUid));
send(equipRequest(false, target.unitUid, accessory.equipUid, 3));
assertOnlyAck(NEC_OK, BigInt(target.unitUid), 0n, BigInt(accessory.equipUid), 3);
assert.strictEqual(saves, 7, "unlocked second-accessory equip and unequip must each persist");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(getArmyUnitByUid(restarted, target.unitUid).equipItemUids.map(BigInt), [0n, 0n, 0n, 0n]);
assert.strictEqual(getEquipItem(restarted, mover.equipUid).ownerUnitUid, "-1");

validateManagedSchemas();
console.log(`[equip-item-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function findEquipId(style, position) {
  const id = getAllEquipIds().find((equipId) => {
    const templet = getEquipTemplet(equipId);
    return templet
      && templet.m_EquipUnitStyleType === style
      && templet.m_ItemEquipPosition === position
      && (!Array.isArray(templet.m_lstPrivateUnitID) || templet.m_lstPrivateUnitID.length === 0);
  });
  assert(id, `frozen table must contain non-private ${style} ${position} equipment`);
  return id;
}

function equipRequest(isEquip, unitUid, equipUid, position) {
  return Buffer.concat([
    writeBool(isEquip),
    writeSignedVarLong(BigInt(unitUid)),
    writeSignedVarLong(BigInt(equipUid)),
    writeSignedVarInt(position),
  ]);
}

function send(payload, validateRequest = true) {
  responses = [];
  if (validateRequest) managedWire.push([EQUIP_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: EQUIP_REQ, sequence: 1, payload }), true);
}

function assertOnlyAck(error, unitUid, equipUid, unequipUid, position) {
  assert.strictEqual(responses.length, 1);
  assertAck(responses[0], error, unitUid, equipUid, unequipUid, position);
}

function assertAck(response, expectedError, expectedUnitUid, expectedEquipUid, expectedUnequipUid, expectedPosition) {
  assert.strictEqual(response.packetId, EQUIP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const unitUid = readSignedVarLong(response.payload, error.offset);
  const equipUid = readSignedVarLong(response.payload, unitUid.offset);
  const unequipUid = readSignedVarLong(response.payload, equipUid.offset);
  const position = readSignedVarInt(response.payload, unequipUid.offset);
  assert.deepStrictEqual(
    [error.value, unitUid.value, equipUid.value, unequipUid.value, position.value],
    [expectedError, expectedUnitUid, expectedEquipUid, expectedUnequipUid, expectedPosition]
  );
  assert.strictEqual(position.offset, response.payload.length, "equipment equip ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected equipment equip packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
