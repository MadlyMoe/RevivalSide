"use strict";

const assert = require("assert");
const path = require("path");
const handler = require("../modules/equipment-pipeline/handlers/1038-equip-preset-list-req");
const { getEquipPresets } = require("../modules/equipment");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLongList,
  readString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "989000000000001",
  inventory: {
    equips: {},
    equipPresets: [
      { presetIndex: 0, presetType: 1, presetName: "Raid", equipUids: [11, 12, 13, 14] },
      { presetIndex: 1, presetType: 2, presetName: "PvP", equipUids: [21, 22, 23, 24] },
    ],
  },
};
const socket = { session: { user, gameReplay: {} } };
const wire = [];
let skipped = 0;
let saves = 0;
const ctx = {
  constants: { EQUIP_PRESET_LIST_ACK: 1039 },
  capturedGameFlow: {},
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload]);
  },
  skipCapturedGameThroughPacketId(target, packetId) {
    assert.strictEqual(target, socket);
    assert.strictEqual(packetId, 1039);
    skipped += 1;
  },
  saveUserDb() { saves += 1; },
};

wire.push([1038, Buffer.alloc(0)]);
assert.strictEqual(handler.handle(ctx, socket, { packetId: 1038, sequence: 1038, payload: Buffer.alloc(0) }), true);
assert.strictEqual(socket.response.packetId, 1039);
const authoritative = getEquipPresets(user).map((preset) => ({
  presetIndex: preset.presetIndex,
  presetType: preset.presetType,
  presetName: preset.presetName,
  equipUids: preset.equipUids.map(BigInt),
}));
assert.deepStrictEqual(parseAck(socket.response.payload), authoritative);
assert(authoritative.every((preset) => preset.equipUids.every((uid) => uid === 0n)), "stale equipment references must be normalized out");
assert.strictEqual(skipped, 1, "captured replay cursor must skip the replaced ACK");
assert.strictEqual(saves, 0, "preset list reads must never save");

validateManagedSchemas();
console.log(`[equip-preset-list-protocol-check] PASS presets=2 packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  assert.strictEqual(error.value, 0);
  const count = readUnsignedVarInt(payload, error.offset);
  let offset = count.offset;
  const presets = [];
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
    presets.push({ presetIndex, presetType, presetName, equipUids: equipUids.value });
  }
  assert.strictEqual(offset, payload.length);
  return presets;
}

function readUnsignedVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length && shift < 32) {
    const byte = buffer.readUInt8(cursor++);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: cursor };
    shift += 7;
  }
  throw new Error("malformed varint32");
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
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected equip-preset packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
