"use strict";

const assert = require("assert");
const path = require("path");
const {
  PACKETS,
  GAME_TYPES,
  ERROR_CODES,
  createPvpPickRateHandlers,
} = require("../modules/pvp-pick-rate");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "2697001" };
const socket = { session: { user } };
const handler = createPvpPickRateHandlers()[0];
const managedPackets = [];
let response = null;
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  saveUserDb() { saves += 1; },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 1);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
};

failure("truncated", Buffer.alloc(0), 0, false);
failure("trailing", Buffer.concat([request(GAME_TYPES.RANK), Buffer.from([0])]), GAME_TYPES.RANK, false);
failure("invalid game type", request(3), 3);

for (const gameType of [GAME_TYPES.RANK, GAME_TYPES.LEAGUE, GAME_TYPES.UNLIMITED]) {
  send(request(gameType));
  const ack = parseAck(response.payload);
  assert.strictEqual(response.packetId, PACKETS.PVP_PICK_RATE_ACK);
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.gameType, gameType);
  assert.strictEqual(ack.count, 0, "no local ranked/league histories means no fabricated statistics");
}

assert.strictEqual(saves, 0, "pick-rate reads must never save");
assert.deepStrictEqual(user, { userUid: "2697001" }, "pick-rate reads must not mutate the profile");
validateManagedSchemas();
console.log(
  `[pvp-pick-rate-protocol-check] PASS packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function request(gameType) {
  return writeSignedVarInt(gameType);
}

function send(payload, validateRequest = true) {
  response = null;
  if (validateRequest) managedPackets.push([PACKETS.PVP_PICK_RATE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.PVP_PICK_RATE_REQ, sequence: 1, payload }), true);
  assert(response, "pick-rate handler must send an ACK");
}

function failure(name, payload, expectedGameType, validateRequest = true) {
  send(payload, validateRequest);
  const ack = parseAck(response.payload);
  assert.strictEqual(ack.errorCode, ERROR_CODES.INVALID_GAME_TYPE, name);
  assert.strictEqual(ack.gameType, expectedGameType, `${name} game type must be authoritative`);
  assert.strictEqual(ack.count, 0, `${name} must return no records`);
}

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const gameType = readSignedVarInt(payload, error.offset);
  const count = readUnsignedVarInt(payload, gameType.offset);
  assert.strictEqual(count.offset, payload.length, "empty pick-rate ACK must contain no trailing fields");
  return { errorCode: error.value, gameType: gameType.value, count: count.value };
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated list count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected PvP pick-rate packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
