"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipPresets, grantEquipItem } = require("../modules/equipment");
const { getAllEquipIds, getEquipTemplet } = require("../modules/game-data");
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

const REGISTER_REQ = 1046;
const REGISTER_ACK = 1047;
const NEC_OK = 0;
const NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX = 20734;
const NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION = 20736;
const NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE = 20737;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS = 20741;
const rootDir = path.resolve(__dirname, "..");
const ids = getAllEquipIds();
const counterWeaponId = findEquipId("NUST_COUNTER", "IEP_WEAPON");
const counterDefenceId = findEquipId("NUST_COUNTER", "IEP_DEFENCE");
const soldierWeaponId = findEquipId("NUST_SOLDIER", "IEP_WEAPON");
const user = {
  userUid: "986000000000012",
  nickname: "EquipPresetRegisterCheck",
  inventory: { equips: {}, equipPresets: [{ presetIndex: 0, presetType: 1, presetName: "Set", equipUids: [0, 0, 0, 0] }] },
};
const counterWeapon = grantEquipItem(user, counterWeaponId);
const counterDefence = grantEquipItem(user, counterDefenceId);
const soldierWeapon = grantEquipItem(user, soldierWeaponId);
assert(counterWeapon && counterDefence && soldierWeapon, "frozen equipment table must contain counter and soldier preset items");
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === REGISTER_REQ);
assert(handler, "equipment preset register handler must be registered");
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
send(Buffer.concat([registerRequest(0, 0, BigInt(counterWeapon.equipUid)), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, null);
send(registerRequest(1, 0, BigInt(counterWeapon.equipUid)));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, null);
send(registerRequest(0, 4, BigInt(counterWeapon.equipUid)));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION, null);
send(registerRequest(0, 0, 999999999n));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS, null);
send(registerRequest(0, 1, BigInt(counterWeapon.equipUid)));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION, null);
assert.strictEqual(saves, 0, "invalid preset registrations must not persist");

send(registerRequest(0, 0, BigInt(counterWeapon.equipUid)));
let preset = assertAck(NEC_OK, "Set");
assert.strictEqual(preset.equipUids[0], BigInt(counterWeapon.equipUid));
assert.strictEqual(saves, 1);
send(registerRequest(0, 0, BigInt(counterWeapon.equipUid)));
preset = assertAck(NEC_OK, "Set");
assert.strictEqual(saves, 1, "idempotent preset registration must not persist");

send(registerRequest(0, 1, BigInt(counterDefence.equipUid)));
preset = assertAck(NEC_OK, "Set");
assert.strictEqual(preset.equipUids[1], BigInt(counterDefence.equipUid));
assert.strictEqual(saves, 2);
send(registerRequest(0, 0, BigInt(soldierWeapon.equipUid)));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE, null);
assert.strictEqual(saves, 2);

send(registerRequest(0, 0, 0n));
preset = assertAck(NEC_OK, "Set");
assert.strictEqual(preset.equipUids[0], 0n);
assert.strictEqual(saves, 3);
send(registerRequest(0, 0, 0n));
assertAck(NEC_OK, "Set");
assert.strictEqual(saves, 3, "idempotent preset clear-slot must not persist");

const restarted = JSON.parse(JSON.stringify(user));
const restartedPreset = getEquipPresets(restarted)[0];
assert.strictEqual(BigInt(restartedPreset.equipUids[0]), 0n);
assert.strictEqual(BigInt(restartedPreset.equipUids[1]), BigInt(counterDefence.equipUid));

validateManagedSchemas();
console.log(`[equip-preset-register-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function findEquipId(style, position) {
  const id = ids.find((equipId) => {
    const templet = getEquipTemplet(equipId);
    return templet && templet.m_EquipUnitStyleType === style && templet.m_ItemEquipPosition === position && !templet.m_bRelic;
  });
  assert(id, `frozen table must contain ${style} ${position} equipment`);
  return id;
}

function registerRequest(index, position, uid) {
  return Buffer.concat([writeSignedVarInt(index), writeSignedVarInt(position), writeSignedVarLong(uid)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([REGISTER_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: REGISTER_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedName) {
  assert(response, "equipment preset register handler must send an ACK");
  assert.strictEqual(response.packetId, REGISTER_ACK);
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
  assert.strictEqual(equipUids.offset, response.payload.length, "equipment preset register ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected equipment preset register packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
