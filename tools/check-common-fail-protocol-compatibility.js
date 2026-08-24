"use strict";

process.env.CS_LISTENER_TEST_MODE = "1";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildCommonFailAckPayload, handleFallbackPacket } = require("../server/listener");
const { readSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const responses = [];
const ctx = {
  sendGameResponse(_socket, packet, packetId, payload, label) {
    responses.push({ sequence: packet.sequence, packetId, payload, label });
  },
};
const socket = {};

assert.strictEqual(handleFallbackPacket(ctx, socket, { packetId: 9999, sequence: 77, payloadSize: 0 }), true);
assert.deepStrictEqual(responses.map(({ sequence, packetId, label }) => ({ sequence, packetId, label })), [
  { sequence: 77, packetId: 610, label: "common-fail" },
]);
assert.strictEqual(readSignedVarInt(responses[0].payload, 0).value, 20136, "unsupported requests must return frozen NEC_FAIL_UNKNOWN_REQUEST");
assert.strictEqual(buildCommonFailAckPayload().equals(responses[0].payload), true);

const beforeAccount = responses.length;
assert.strictEqual(handleFallbackPacket(ctx, socket, { packetId: 211, sequence: 78, payloadSize: 0 }), true);
assert.strictEqual(responses.length, beforeAccount, "the protected Account protocol must remain untouched");

const packetSource = read("Assembly-CSharp", "ClientPacket", "Service", "NKMPacket_COMMON_FAIL_ACK.cs");
const receiverSource = read("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
const errorsSource = read("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs");
assert.match(packetSource, /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)/);
assert.match(receiverSource, /OnRecv\(NKMPacket_COMMON_FAIL_ACK ack\)[\s\S]*Check_NKM_ERROR_CODE\(ack\.errorCode, true/);
assert.match(errorsSource, /NEC_FAIL_UNKNOWN_REQUEST/);

validateManagedSchema(responses[0]);
console.log(`[common-fail-protocol-check] PASS errorCode=20136 responses=${responses.length} accountProtected=1 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function read(...parts) {
  return fs.readFileSync(path.join(rootDir, ...parts), "utf8");
}

function validateManagedSchema(entry) {
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
    const result = combatHost.request("validatePacket", {
      packetId: entry.packetId,
      payloadBase64: entry.payload.toString("base64"),
    });
    assert(result.ok, `managed client schema rejected COMMON_FAIL_ACK: ${result.error || "unknown error"}`);
  } finally {
    combatHost.close();
  }
}
