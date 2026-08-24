"use strict";

const assert = require("assert");
const path = require("path");
const heartbeatHandler = require("../packet-handlers/0600-heart-bit-req");
const serverTimeHandler = require("../packet-handlers/0604-server-time-req");
const sceneHandler = require("../packet-handlers/0606-ui-scene-changed-req");
const loadingHandler = require("../packet-handlers/0607-loading-progress-req");
const {
  readSignedVarLong,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const replay = {
  heartbeatCount: 0,
  nextServerSequence: 1,
  loadCompleteReceived: false,
  dynamicBattleResultSent: false,
  pendingGameStartBootstrap: false,
};
const socket = { session: { user: { userUid: "986000000000001" }, gameReplay: replay } };
const wire = [];
const managedWire = [];
let staminaNotifications = 0;
let abandoned = 0;
let repaired = 0;
let bootstrapped = 0;
let loadingCallbacks = 0;
const serverTicks = 638400000000000000n;
const ctx = {
  config: {
    REPLAY_CAPTURED_GAME_FLOW: false,
    DYNAMIC_BATTLE_MANAGER: false,
    VERBOSE_CAPTURE_LOGS: false,
  },
  constants: { HEART_BIT_ACK: 601, SERVER_TIME_ACK: 605 },
  capturedGameFlow: null,
  decryptCopy: (payload) => payload,
  safeReadSignedVarLong: (payload, offset) => readSignedVarLong(payload, offset),
  writeSignedVarLong,
  dateTimeTicksNow: () => serverTicks,
  isTutorialCapturedBootstrapActive: () => false,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { sequence: packet.sequence, packetId, payload };
    wire.push([packetId, payload]);
    managedWire.push([packetId, payload]);
  },
  sendStaminaChargeNotifications() { staminaNotifications += 1; },
  abandonDynamicBattle() {
    abandoned += 1;
    replay.dynamicBattleResultSent = true;
  },
  repairPostTutorialGuideMissionsForSocket() { repaired += 1; },
  sendPendingGameStartSync() { bootstrapped += 1; },
  onClientLoadingProgress(target, progress) {
    assert.strictEqual(target, socket);
    assert.strictEqual(progress, 50);
    loadingCallbacks += 1;
  },
};

send(heartbeatHandler, 600, writeSignedVarLong(123456789n));
assert.strictEqual(socket.response.packetId, 601);
assert.strictEqual(readSignedVarLong(socket.response.payload, 0).value, 123456789n, "heartbeat ACK must echo the client timestamp");
assert.strictEqual(replay.heartbeatCount, 1);
assert.strictEqual(staminaNotifications, 1);

send(serverTimeHandler, 604, Buffer.alloc(0));
assert.strictEqual(socket.response.packetId, 605);
assert.strictEqual(readSignedVarLong(socket.response.payload, 0).value, serverTicks, "server time must use current UTC ticks");

ctx.config.DYNAMIC_BATTLE_MANAGER = true;
replay.dynamicGame = { initialUnitsSent: true };
replay.dynamicBattleTimer = {};
replay.lastSceneId = 3;
const responseCount = wire.length;
send(sceneHandler, 606, writeSignedVarInt(9));
assert.strictEqual(replay.lastSceneId, 9);
assert.strictEqual(abandoned, 1, "leaving the game scene must abandon an active dynamic battle");
assert.strictEqual(repaired, 1, "entering operation must run the post-tutorial mission repair hook");
assert.strictEqual(wire.length, responseCount + 1, "scene notifications have no direct server response");

send(sceneHandler, 606, Buffer.alloc(0), false);
assert.strictEqual(replay.lastSceneId, 9, "malformed scene notifications must not mutate battle state");
assert.strictEqual(abandoned, 1);

replay.pendingGameStartBootstrap = true;
replay.loadCompleteReceived = true;
send(sceneHandler, 606, writeSignedVarInt(3));
assert.strictEqual(replay.lastSceneId, 3);
assert.strictEqual(bootstrapped, 1, "entering the game scene must release a ready pending bootstrap");

send(loadingHandler, 607, writeByte(50));
assert.strictEqual(replay.loadingProgress, 50);
assert.strictEqual(loadingCallbacks, 1);
send(loadingHandler, 607, writeByte(101));
assert.strictEqual(replay.loadingProgress, 50, "out-of-domain loading progress must be ignored");
send(loadingHandler, 607, Buffer.alloc(0), false);
assert.strictEqual(replay.loadingProgress, 50, "malformed loading progress must be ignored");

validateManagedSchemas();
console.log(`[service-presence-protocol-check] PASS packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(handler, packetId, payload, managed = true) {
  wire.push([packetId, payload]);
  if (managed) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
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
      assert(result.ok, `managed client schema rejected service packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
