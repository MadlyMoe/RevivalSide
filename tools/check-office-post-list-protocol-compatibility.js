"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers } = require("../modules/office");
const { readSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handler = createOfficeHandlers().find((entry) => entry.packetId === 3626);
assert(handler, "the specialist Office post-list handler must be registered");

const user = {
  userUid: "9880000000003626",
  nickname: "Post Reader",
  office: { openedSectionIds: [101] },
};
const socket = { session: { user } };
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("a post-list read must not invalidate JOIN"); },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

const before = JSON.stringify(user);
assertAck(Buffer.alloc(0), 20191, false);
assertAck(Buffer.concat([postListRequest(0n), Buffer.from([0])]), 20191, false);
assertAck(postListRequest(-1n), 20191);
assertAck(postListRequest(0n), 0);
assertAck(postListRequest(987654321n), 0);
assert.strictEqual(JSON.stringify(user), before, "Office post-list reads must not normalize or mutate the profile");
assert.strictEqual(saves, 0, "Office post-list reads must never save");

validateManagedSchemas();
console.log(`[office-post-list-protocol-check] PASS requests=${wire.filter(([id]) => id === 3626).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function postListRequest(lastPostUid) {
  return writeSignedVarLong(lastPostUid);
}

function assertAck(payload, expectedError, schemaValid = true) {
  wire.push([3626, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3626, sequence: 3626, payload }), true);
  assert.strictEqual(socket.response.packetId, 3627);
  const error = readSignedVarInt(socket.response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(socket.response.payload[error.offset], 0, "the local server must return an empty post list");
  assert.strictEqual(readSignedVarInt(socket.response.payload, error.offset + 1).value, 0, "empty local post source must report zero total posts");
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
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Office post-list packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
