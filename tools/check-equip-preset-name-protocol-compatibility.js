"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipPresets } = require("../modules/equipment");
const {
  readSignedVarInt,
  readString,
  writeSignedVarInt,
  writeString,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const NAME_REQ = 1042;
const NAME_ACK = 1043;
const NEC_OK = 0;
const NEC_FAIL_EQUIP_PRESET_INVALID_NAME = 20731;
const NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX = 20734;
const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "986000000000009",
  nickname: "EquipPresetNameCheck",
  inventory: {
    equips: {},
    equipPresets: [{ presetIndex: 0, presetType: 1, presetName: "Old", equipUids: [0, 0, 0, 0] }],
  },
};
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === NAME_REQ);
assert(handler, "equipment preset name handler must be registered");
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
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 0, "");
send(Buffer.concat([nameRequest(0, "Valid"), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 0, "Valid");
send(Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(20), Buffer.from("short")]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 0, "");
send(nameRequest(1, "Valid"));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX, 1, "Valid");
send(nameRequest(0, "1234567890123456"));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_NAME, 0, "1234567890123456");
assert.strictEqual(getEquipPresets(user)[0].presetName, "Old");
assert.strictEqual(saves, 0, "invalid preset names must not persist");

send(nameRequest(0, "123456789012345"));
assertAck(NEC_OK, 0, "123456789012345");
assert.strictEqual(getEquipPresets(user)[0].presetName, "123456789012345");
assert.strictEqual(saves, 1, "a changed preset name must persist once");
send(nameRequest(0, "123456789012345"));
assertAck(NEC_OK, 0, "123456789012345");
assert.strictEqual(saves, 1, "an idempotent preset name must not persist");
send(nameRequest(0, ""));
assertAck(NEC_OK, 0, "");
assert.strictEqual(getEquipPresets(user)[0].presetName, "");
assert.strictEqual(saves, 2);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipPresets(restarted)[0].presetName, "");

validateManagedSchemas();
console.log(`[equip-preset-name-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function nameRequest(index, name) {
  return Buffer.concat([writeSignedVarInt(index), writeString(name)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([NAME_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: NAME_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedIndex, expectedName) {
  assert(response, "equipment preset name handler must send an ACK");
  assert.strictEqual(response.packetId, NAME_ACK);
  let read = readSignedVarInt(response.payload, 0);
  assert.strictEqual(read.value, expectedError);
  read = readSignedVarInt(response.payload, read.offset);
  assert.strictEqual(read.value, expectedIndex);
  read = readString(response.payload, read.offset);
  assert.strictEqual(read.value, expectedName);
  assert.strictEqual(read.offset, response.payload.length, "equipment preset name ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected equipment preset name packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
