"use strict";

const assert = require("assert");
const path = require("path");
const handler = require("../packet-handlers/1643-refresh-company-buff-req");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: { userUid: "990000000000001" } } };
const wire = [];
let saves = 0;
const ctx = {
  writeSignedVarInt,
  sendGameResponse(target, packet, packetId, payload) { capture(target, packetId, payload); },
  sendServerGamePacket(target, packetId, payload) { capture(target, packetId, payload); },
  saveUserDb() { saves += 1; },
};

send();
assertEmptyBuffAck();
socket.session.gameReplay = {};
send();
assertEmptyBuffAck();
assert.strictEqual(saves, 0, "company buff refresh is read-only");

validateManagedSchemas();
console.log(`[company-buff-protocol-check] PASS packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send() {
  const payload = Buffer.alloc(0);
  wire.push([1643, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 1643, sequence: 1643, payload }), true);
}

function capture(target, packetId, payload) {
  target.response = { packetId, payload };
  wire.push([packetId, payload]);
}

function assertEmptyBuffAck() {
  assert.strictEqual(socket.response.packetId, 1644);
  const error = readSignedVarInt(socket.response.payload, 0);
  const count = readSignedVarInt(socket.response.payload, error.offset);
  assert.strictEqual(error.value, 0);
  assert.strictEqual(count.value, 0);
  assert.strictEqual(count.offset, socket.response.payload.length);
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
      assert(result.ok, `managed client schema rejected company-buff packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
