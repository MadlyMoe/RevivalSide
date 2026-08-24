"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { equipItemToUnit, getEquipPresets, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipTemplet } = require("../modules/game-data");
const { grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLongList,
  readString,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const REGISTER_ALL_REQ = 1044;
const REGISTER_ALL_ACK = 1045;
const NEC_OK = 0;
const NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX = 20734;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA = 20738;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS = 20741;
const rootDir = path.resolve(__dirname, "..");
const ids = getAllEquipIds();
const user = {
  userUid: "986000000000013",
  nickname: "EquipPresetRegisterAllCheck",
  inventory: { equips: {}, equipPresets: [{ presetIndex: 0, presetType: 1, presetName: "Unit Set", equipUids: [0, 0, 0, 0] }] },
};
const unit = grantUnit(user, 1001);
const emptyUnit = grantUnit(user, 1001);
assert(unit && emptyUnit, "frozen unit table must contain unit 1001");
const weapon = grantEquipItem(user, findEquipId("NUST_COUNTER", "IEP_WEAPON"));
const defence = grantEquipItem(user, findEquipId("NUST_COUNTER", "IEP_DEFENCE"));
assert(weapon && defence, "frozen equipment table must contain counter weapon and defence items");
assert(equipItemToUnit(user, unit.unitUid, weapon.equipUid, 0));
assert(equipItemToUnit(user, unit.unitUid, defence.equipUid, 1));
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === REGISTER_ALL_REQ);
assert(handler, "equipment preset register-all handler must be registered");
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
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, null);
send(Buffer.concat([registerAllRequest(BigInt(unit.unitUid), 0), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, null);
send(registerAllRequest(BigInt(unit.unitUid), 1));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, null);
send(registerAllRequest(999999999n, 0));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA, null);
send(registerAllRequest(BigInt(emptyUnit.unitUid), 0));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS, null);
assert.strictEqual(saves, 0, "invalid register-all requests must not persist");

send(registerAllRequest(BigInt(unit.unitUid), 0));
let preset = assertAck(NEC_OK, "Unit Set");
assert.deepStrictEqual(preset.equipUids.slice(0, 2), [BigInt(weapon.equipUid), BigInt(defence.equipUid)]);
assert.strictEqual(saves, 1);
send(registerAllRequest(BigInt(unit.unitUid), 0));
preset = assertAck(NEC_OK, "Unit Set");
assert.deepStrictEqual(preset.equipUids.slice(0, 2), [BigInt(weapon.equipUid), BigInt(defence.equipUid)]);
assert.strictEqual(saves, 1, "idempotent register-all must not persist");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(
  getEquipPresets(restarted)[0].equipUids.slice(0, 2).map(BigInt),
  [BigInt(weapon.equipUid), BigInt(defence.equipUid)]
);

validateManagedSchemas();
console.log(`[equip-preset-register-all-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function findEquipId(style, position) {
  const id = ids.find((equipId) => {
    const templet = getEquipTemplet(equipId);
    return templet && templet.m_EquipUnitStyleType === style && templet.m_ItemEquipPosition === position && !templet.m_bRelic;
  });
  assert(id, `frozen table must contain ${style} ${position} equipment`);
  return id;
}

function registerAllRequest(unitUid, presetIndex) {
  return Buffer.concat([writeSignedVarLong(unitUid), writeSignedVarInt(presetIndex)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([REGISTER_ALL_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: REGISTER_ALL_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedName) {
  assert(response, "equipment preset register-all handler must send an ACK");
  assert.strictEqual(response.packetId, REGISTER_ALL_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, expectedError === NEC_OK);
  if (!present.value) {
    assert.strictEqual(present.offset, response.payload.length);
    return null;
  }
  let read = readSignedVarInt(response.payload, present.offset);
  const presetIndex = read.value;
  read = readSignedVarInt(response.payload, read.offset);
  const presetType = read.value;
  read = readString(response.payload, read.offset);
  const presetName = read.value;
  const equipUids = readSignedVarLongList(response.payload, read.offset);
  assert.strictEqual(equipUids.offset, response.payload.length, "equipment preset register-all ACK must not contain trailing fields");
  assert.strictEqual(presetIndex, 0);
  assert.strictEqual(presetName, expectedName);
  return { presetIndex, presetType, presetName, equipUids: equipUids.value };
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
      assert(result.ok, `managed client schema rejected equipment preset register-all packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
