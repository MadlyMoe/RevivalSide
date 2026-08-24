"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipPresets } = require("../modules/equipment");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLongList,
  readString,
  writeBool,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const INDEX_REQ = 1061;
const INDEX_ACK = 1062;
const NEC_OK = 0;
const NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE = 21042;
const NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_DUPLICATE = 21043;
const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "986000000000011",
  nickname: "EquipPresetIndexCheck",
  inventory: {
    equips: {},
    equipPresets: [
      { presetIndex: 0, presetType: 1, presetName: "A", equipUids: [0, 0, 0, 0] },
      { presetIndex: 1, presetType: 1, presetName: "B", equipUids: [0, 0, 0, 0] },
      { presetIndex: 2, presetType: 1, presetName: "C", equipUids: [0, 0, 0, 0] },
    ],
  },
};
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === INDEX_REQ);
assert(handler, "equipment preset index handler must be registered");
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
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE, []);
send(Buffer.concat([indexRequest([{ from: 0, to: 1 }, { from: 1, to: 0 }]), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE, []);
send(indexRequest([]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE, []);
send(writeObjectList([writeBool(false)]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE, []);
send(indexRequest([{ from: 0, to: 3 }]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE, []);
send(indexRequest([{ from: 0, to: 0 }]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE, []);
send(indexRequest([{ from: 0, to: 1 }, { from: 0, to: 2 }]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_DUPLICATE, []);
send(indexRequest([{ from: 0, to: 1 }, { from: 2, to: 1 }]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_DUPLICATE, []);
send(indexRequest([{ from: 0, to: 1 }]));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_DUPLICATE, []);
assert.deepStrictEqual(getEquipPresets(user).map((preset) => preset.presetName), ["A", "B", "C"]);
assert.strictEqual(saves, 0, "invalid preset reorders must not persist");

send(indexRequest([{ from: 0, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 0 }]));
const presets = assertAck(NEC_OK, ["C", "A", "B"]);
assert.deepStrictEqual(presets.map((preset) => preset.presetIndex), [0, 1, 2]);
assert.deepStrictEqual(getEquipPresets(user).map((preset) => preset.presetName), ["C", "A", "B"]);
assert.strictEqual(saves, 1, "successful preset reorder must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(getEquipPresets(restarted).map((preset) => preset.presetName), ["C", "A", "B"]);

validateManagedSchemas();
console.log(`[equip-preset-index-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function indexRequest(changes) {
  return writeObjectList(changes.map((change) => writeNullableObject(Buffer.concat([
    writeSignedVarInt(change.from),
    writeSignedVarInt(change.to),
  ]))));
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([INDEX_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: INDEX_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedNames) {
  assert(response, "equipment preset index handler must send an ACK");
  assert.strictEqual(response.packetId, INDEX_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const presets = readPresetList(response.payload, error.offset);
  assert.deepStrictEqual(presets.values.map((preset) => preset.presetName), expectedNames);
  assert.strictEqual(presets.offset, response.payload.length, "equipment preset index ACK must not contain trailing fields");
  return presets.values;
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
      assert(result.ok, `managed client schema rejected equipment preset index packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
