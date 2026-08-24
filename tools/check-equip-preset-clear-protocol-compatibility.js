"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipPresets, grantEquipItem } = require("../modules/equipment");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLongList,
  readString,
  writeIntList,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const CLEAR_REQ = 1074;
const CLEAR_ACK = 1075;
const NEC_OK = 0;
const NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX = 20734;
const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000008", nickname: "EquipPresetClearCheck" };
const firstEquip = grantEquipItem(user, 0);
const secondEquip = grantEquipItem(user, 0);
assert(firstEquip && secondEquip, "frozen equipment table must contain grantable items");
user.inventory.equipPresets = [
  { presetIndex: 0, presetType: 2, presetName: "First", equipUids: [firstEquip.equipUid, 0, 0, 0] },
  { presetIndex: 1, presetType: 2, presetName: "Second", equipUids: [secondEquip.equipUid, 0, 0, 0] },
];
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === CLEAR_REQ);
assert(handler, "equipment preset clear handler must be registered");
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
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, []);
send(Buffer.concat([writeIntList([0]), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, []);
send(writeIntList([]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, []);
send(writeIntList([0, 0]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, []);
send(writeIntList([2]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, []);
assert.strictEqual(saves, 0, "invalid preset clears must not persist");

send(writeIntList([0]));
let presets = assertAck(NEC_OK, [0, 1]);
assertCleared(presets[0]);
assert.strictEqual(presets[1].presetName, "Second");
assert.strictEqual(saves, 1, "a changed preset clear must persist once");

send(writeIntList([0]));
presets = assertAck(NEC_OK, [0, 1]);
assertCleared(presets[0]);
assert.strictEqual(saves, 1, "an idempotent preset clear must not persist");

send(writeIntList([1]));
presets = assertAck(NEC_OK, [0, 1]);
assertCleared(presets[0]);
assertCleared(presets[1]);
assert.strictEqual(saves, 2);

const restarted = JSON.parse(JSON.stringify(user));
getEquipPresets(restarted).forEach(assertCleared);

validateManagedSchemas();
console.log(`[equip-preset-clear-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([CLEAR_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: CLEAR_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedIndices) {
  assert(response, "equipment preset clear handler must send an ACK");
  assert.strictEqual(response.packetId, CLEAR_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const parsed = readPresetList(response.payload, error.offset);
  assert.deepStrictEqual(parsed.values.map((preset) => preset.presetIndex), expectedIndices);
  assert.strictEqual(parsed.offset, response.payload.length, "equipment preset clear ACK must not contain trailing fields");
  return parsed.values;
}

function readPresetList(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    let read = readSignedVarInt(payload, present.offset);
    const presetIndex = read.value;
    read = readSignedVarInt(payload, read.offset);
    const presetType = read.value;
    read = readString(payload, read.offset);
    const presetName = read.value;
    const equipUids = readSignedVarLongList(payload, read.offset);
    offset = equipUids.offset;
    values.push({ presetIndex, presetType, presetName, equipUids: equipUids.value });
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

function assertCleared(preset) {
  assert.strictEqual(preset.presetType, 1);
  assert.strictEqual(preset.presetName, "");
  assert.deepStrictEqual(preset.equipUids.map(BigInt), [0n, 0n, 0n, 0n]);
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
      assert(result.ok, `managed client schema rejected equipment preset clear packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
