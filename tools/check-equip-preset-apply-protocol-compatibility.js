"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { equipItemToUnit, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipTemplet, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { getArmyUnitByUid, grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const APPLY_REQ = 1048;
const APPLY_ACK = 1049;
const NEC_OK = 0;
const NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX = 20734;
const NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE = 20737;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA = 20738;
const rootDir = path.resolve(__dirname, "..");
const equipIds = getAllEquipIds();
const soldierUnitId = getPlayableUnitIds().find((unitId) => getUnitTemplet(unitId)?.m_NKM_UNIT_STYLE_TYPE === "NUST_SOLDIER");
assert(soldierUnitId, "frozen unit table must contain a playable soldier");
const user = {
  userUid: "986000000000014",
  nickname: "EquipPresetApplyCheck",
  inventory: { equips: {}, equipPresets: [] },
};
const sourceUnit = grantUnit(user, 1001);
const targetUnit = grantUnit(user, 1001);
const soldierUnit = grantUnit(user, soldierUnitId);
const weapon = grantEquipItem(user, findEquipId("NUST_COUNTER", "IEP_WEAPON"));
const defence = grantEquipItem(user, findEquipId("NUST_COUNTER", "IEP_DEFENCE"));
assert(sourceUnit && targetUnit && soldierUnit && weapon && defence);
assert(equipItemToUnit(user, sourceUnit.unitUid, weapon.equipUid, 0));
assert(equipItemToUnit(user, sourceUnit.unitUid, defence.equipUid, 1));
user.inventory.equipPresets = [{
  presetIndex: 0,
  presetType: 2,
  presetName: "Transfer",
  equipUids: [weapon.equipUid, defence.equipUid, 0, 0],
}];
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === APPLY_REQ);
assert(handler, "equipment preset apply handler must be registered");
const managedWire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 0, []);
send(Buffer.concat([applyRequest(0, BigInt(targetUnit.unitUid)), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 0, []);
send(applyRequest(1, BigInt(targetUnit.unitUid)));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 1, []);
send(applyRequest(0, 999999999n));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA, 0, []);
send(applyRequest(0, BigInt(soldierUnit.unitUid)));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE, 0, []);
assert.strictEqual(saves, 0, "invalid preset applications must not persist");

send(applyRequest(0, BigInt(targetUnit.unitUid)));
let updates = assertAck(NEC_OK, 0, [BigInt(sourceUnit.unitUid), BigInt(targetUnit.unitUid)]);
assert.deepStrictEqual(updates[0].equipUids, [0n, 0n, 0n, 0n]);
assert.deepStrictEqual(updates[1].equipUids.slice(0, 2), [BigInt(weapon.equipUid), BigInt(defence.equipUid)]);
assert.deepStrictEqual(getArmyUnitByUid(user, sourceUnit.unitUid).equipItemUids.map(BigInt), [0n, 0n, 0n, 0n]);
assert.deepStrictEqual(
  getArmyUnitByUid(user, targetUnit.unitUid).equipItemUids.slice(0, 2).map(BigInt),
  [BigInt(weapon.equipUid), BigInt(defence.equipUid)]
);
assert.strictEqual(saves, 1, "changed preset application must persist once");

send(applyRequest(0, BigInt(targetUnit.unitUid)));
updates = assertAck(NEC_OK, 0, [BigInt(targetUnit.unitUid)]);
assert.deepStrictEqual(updates[0].equipUids.slice(0, 2), [BigInt(weapon.equipUid), BigInt(defence.equipUid)]);
assert.strictEqual(saves, 1, "idempotent preset application must not persist");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(
  getArmyUnitByUid(restarted, targetUnit.unitUid).equipItemUids.slice(0, 2).map(BigInt),
  [BigInt(weapon.equipUid), BigInt(defence.equipUid)]
);

validateManagedSchemas();
console.log(`[equip-preset-apply-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function findEquipId(style, position) {
  const id = equipIds.find((equipId) => {
    const templet = getEquipTemplet(equipId);
    return templet
      && templet.m_EquipUnitStyleType === style
      && templet.m_ItemEquipPosition === position
      && !templet.m_bRelic
      && (!Array.isArray(templet.m_lstPrivateUnitID) || templet.m_lstPrivateUnitID.length === 0);
  });
  assert(id, `frozen table must contain ${style} ${position} equipment`);
  return id;
}

function applyRequest(presetIndex, unitUid) {
  return Buffer.concat([writeSignedVarInt(presetIndex), writeSignedVarLong(unitUid)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([APPLY_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: APPLY_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedIndex, expectedUnitUids) {
  assert(response, "equipment preset apply handler must send an ACK");
  assert.strictEqual(response.packetId, APPLY_ACK);
  let read = readSignedVarInt(response.payload, 0);
  assert.strictEqual(read.value, expectedError);
  read = readSignedVarInt(response.payload, read.offset);
  assert.strictEqual(read.value, expectedIndex);
  const updates = readUpdates(response.payload, read.offset);
  assert.deepStrictEqual(updates.values.map((entry) => entry.unitUid), expectedUnitUids);
  assert.strictEqual(updates.offset, response.payload.length, "equipment preset apply ACK must not contain trailing fields");
  return updates.values;
}

function readUpdates(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const unitUid = readSignedVarLong(payload, present.offset);
    const equipUids = readSignedVarLongList(payload, unitUid.offset);
    offset = equipUids.offset;
    values.push({ unitUid: unitUid.value, equipUids: equipUids.value });
  }
  return { values, offset };
}

function readUnsignedVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer.readUInt8(offset++);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
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
      assert(result.ok, `managed client schema rejected equipment preset apply packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
