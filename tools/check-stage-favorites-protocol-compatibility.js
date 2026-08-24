"use strict";

const assert = require("assert");
const path = require("path");
const {
  FAVORITE_ERRORS,
  MAX_STAGE_FAVORITE_COUNT,
  createStageFavoritesHandlers,
  getStageFavoriteEntries,
} = require("../modules/stage-favorites");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, writeSignedVarInt, writeVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const stages = readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json", { rootDir, logLabel: "stage-favorites-check" })
  .map((row) => Number(row && row.m_StageID))
  .filter(Number.isSafeInteger)
  .slice(0, MAX_STAGE_FAVORITE_COUNT + 1);
assert.strictEqual(stages.length, MAX_STAGE_FAVORITE_COUNT + 1, "frozen stage fixture must contain at least 31 stages");

const user = { userUid: "985000000000001", nickname: "FavoritesCheck" };
const socket = { session: { user } };
const handlers = new Map(createStageFavoritesHandlers().map((handler) => [handler.packetId, handler]));
const wire = [];
const managedWire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { sequence: packet.sequence, packetId, payload };
    wire.push([packetId, payload]);
    managedWire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(1243, Buffer.alloc(0));
assertAck(1244, 0, []);
assert.strictEqual(saves, 0, "favorite reads must not persist");

send(1245, Buffer.alloc(0), false);
assertAck(1246, FAVORITE_ERRORS.INVALID_STAGE_ID, []);
send(1245, writeSignedVarInt(999999999));
assertAck(1246, FAVORITE_ERRORS.INVALID_STAGE_ID, []);

send(1245, writeSignedVarInt(stages[0]));
assertAck(1246, 0, [[0, stages[0]]]);
send(1245, writeSignedVarInt(stages[0]));
assertAck(1246, FAVORITE_ERRORS.DUPLICATE, [[0, stages[0]]]);
send(1245, writeSignedVarInt(stages[1]));
assertAck(1246, 0, [[0, stages[0]], [1, stages[1]]]);

const savedTwo = { ...user.stageFavorites };
user.stageFavorites = Object.fromEntries(stages.slice(0, MAX_STAGE_FAVORITE_COUNT).map((stageId, index) => [index, stageId]));
send(1245, writeSignedVarInt(stages[MAX_STAGE_FAVORITE_COUNT]));
assertAck(1246, FAVORITE_ERRORS.COUNT_MAX);
user.stageFavorites = savedTwo;

send(1247, writeSignedVarInt(999999999));
assertAck(1248, FAVORITE_ERRORS.INVALID_STAGE_ID, [[0, stages[0]], [1, stages[1]]]);
send(1247, writeSignedVarInt(stages[0]));
assertAck(1248, 0, [[0, stages[1]]]);
send(1247, writeSignedVarInt(stages[0]));
assertAck(1248, 0, [[0, stages[1]]]);

send(1253, favoriteMap([[1, stages[0]]]));
assertAck(1254, FAVORITE_ERRORS.COUNT_DIFFERENT, [[0, stages[1]]]);
send(1253, favoriteMap([[0, stages[0]], [1, stages[0]]]));
assertAck(1254, FAVORITE_ERRORS.DUPLICATE, [[0, stages[1]]]);
send(1253, favoriteMap([[0, 999999999]]));
assertAck(1254, FAVORITE_ERRORS.INVALID_STAGE_ID, [[0, stages[1]]]);
send(1253, favoriteMap(stages.map((stageId, index) => [index, stageId])));
assertAck(1254, FAVORITE_ERRORS.COUNT_MAX, [[0, stages[1]]]);
send(1253, Buffer.concat([favoriteMap([[0, stages[0]]]), Buffer.from([0])]));
assertAck(1254, FAVORITE_ERRORS.COUNT_DIFFERENT, [[0, stages[1]]]);

const replacement = [[0, stages[2]], [1, stages[1]]];
send(1253, favoriteMap(replacement));
assertAck(1254, 0, replacement);
send(1253, favoriteMap(replacement));
assertAck(1254, 0, replacement);
assert.strictEqual(saves, 4, "only changed favorite state may persist");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(getStageFavoriteEntries(restarted), replacement);
send(1243, Buffer.alloc(0));
assertAck(1244, 0, replacement);

validateManagedSchemas();
console.log(`[stage-favorites-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload, managed = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing stage favorites handler ${packetId}`);
  wire.push([packetId, payload]);
  if (managed) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, errorCode, expectedEntries) {
  assert.strictEqual(socket.response.packetId, packetId);
  const parsed = parseAck(socket.response.payload);
  assert.strictEqual(parsed.errorCode, errorCode);
  if (expectedEntries) assert.deepStrictEqual(parsed.entries, expectedEntries);
}

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const map = readIntIntMap(payload, error.offset);
  assert.strictEqual(map.offset, payload.length, "favorite ACK must not contain trailing fields");
  return { errorCode: error.value, entries: map.entries };
}

function favoriteMap(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, value]) => [writeSignedVarInt(key), writeSignedVarInt(value)]),
  ]);
}

function readIntIntMap(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  const entries = [];
  for (let index = 0; index < count.value; index += 1) {
    const key = readSignedVarInt(payload, offset);
    const value = readSignedVarInt(payload, key.offset);
    entries.push([key.value, value.value]);
    offset = value.offset;
  }
  return { entries, offset };
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
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected stage-favorites packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
