"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipPresets } = require("../modules/equipment");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ADD_REQ = 1040;
const ADD_ACK = 1041;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_EQUIP_PRESET_MAX_COUNT = 20730;
const NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT = 20733;
const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "986000000000010",
  nickname: "EquipPresetAddCheck",
  inventory: {
    equips: {},
    equipPresets: [
      { presetIndex: 0, presetType: 1, presetName: "", equipUids: [0, 0, 0, 0] },
      { presetIndex: 1, presetType: 1, presetName: "", equipUids: [0, 0, 0, 0] },
    ],
  },
};
setMiscItemBalance(user, 101, 200n);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === ADD_REQ);
assert(handler, "equipment preset add handler must be registered");
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
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT, 2, []);
send(Buffer.concat([writeSignedVarInt(1), Buffer.from([0])]), false);
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT, 2, []);
send(writeSignedVarInt(0));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT, 2, []);
send(writeSignedVarInt(-1));
assertAck(NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT, 2, []);
send(writeSignedVarInt(99));
assertAck(NEC_FAIL_EQUIP_PRESET_MAX_COUNT, 2, []);
send(writeSignedVarInt(5));
assertAck(NEC_FAIL_INSUFFICIENT_ITEM, 2, []);
assert.strictEqual(getEquipPresets(user).length, 2);
assert.strictEqual(BigInt(getMiscItem(user, 101).countFree), 200n);
assert.strictEqual(saves, 0, "invalid or unaffordable preset expansion must not persist");

send(writeSignedVarInt(2));
const costItems = assertAck(NEC_OK, 4, [{ itemId: 101, countFree: 100n, countPaid: 0n }]);
assert.strictEqual(costItems.length, 1);
assert.strictEqual(getEquipPresets(user).length, 4);
assert.strictEqual(BigInt(getMiscItem(user, 101).countFree), 100n);
assert.strictEqual(saves, 1, "successful preset expansion must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipPresets(restarted).length, 4);
assert.strictEqual(BigInt(getMiscItem(restarted, 101).countFree), 100n);

validateManagedSchemas();
console.log(`[equip-preset-add-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([ADD_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: ADD_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedCount, expectedCosts) {
  assert(response, "equipment preset add handler must send an ACK");
  assert.strictEqual(response.packetId, ADD_ACK);
  let read = readSignedVarInt(response.payload, 0);
  assert.strictEqual(read.value, expectedError);
  read = readSignedVarInt(response.payload, read.offset);
  assert.strictEqual(read.value, expectedCount);
  const costs = readItemList(response.payload, read.offset);
  assert.deepStrictEqual(costs.values, expectedCosts);
  assert.strictEqual(costs.offset, response.payload.length, "equipment preset add ACK must not contain trailing fields");
  return costs.values;
}

function readItemList(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    let read = readSignedVarInt(payload, present.offset);
    const itemId = read.value;
    read = readSignedVarLong(payload, read.offset);
    const countFree = read.value;
    read = readSignedVarLong(payload, read.offset);
    const countPaid = read.value;
    read = readSignedVarInt(payload, read.offset);
    offset = read.offset + 8;
    values.push({ itemId, countFree, countPaid });
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
      assert(result.ok, `managed client schema rejected equipment preset add packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
