"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildGameSync, buildSyntheticGameSyncPayload } = require("../combat-handler/syncBuilder");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const unit = { gameUnitUID: 101, hp: 1000, x: -2, z: 1, stateId: 1, respawn: true };
const battleState = {
  gameTime: 4,
  absoluteGameTime: 4,
  remainGameTime: 180,
  respawnCostA1: 10,
  respawnCostB1: 10,
  units: [unit],
  pendingDieUnitUIDs: [[99]],
  pendingDeckSyncs: [{ team: 1, unitDeckIndex: 0, unitDeckUID: 5001n }],
  pendingGameStates: [{ state: 3, winTeam: 0, waveId: 1 }],
  pendingDungeonEvents: [{ actionType: 1, eventId: 7, actionValue: 2 }],
};
let simulated = 0;
const first = buildGameSync({ battleState, delta: 0.5 }, {
  continueBattleStateUnits(state, delta) {
    simulated += 1;
    assert.strictEqual(state, battleState);
    assert.strictEqual(delta, 0.5);
  },
});
assert.strictEqual(battleState.gameTime, 4.5);
assert.strictEqual(battleState.absoluteGameTime, 4.5);
assert.strictEqual(battleState.remainGameTime, 179.5);
assert.strictEqual(unit.respawn, false);
assert.strictEqual(battleState.pendingDieUnitUIDs.length, 0);
assert.strictEqual(battleState.pendingDeckSyncs.length, 0);
assert.strictEqual(battleState.pendingGameStates.length, 0);
assert.strictEqual(battleState.pendingDungeonEvents.length, 0);

const second = buildGameSync({ battleState, delta: 0.25 }, { continueBattleStateUnits() { simulated += 1; } });
assert.strictEqual(battleState.gameTime, 4.75);
assert.strictEqual(battleState.remainGameTime, 179.25);
assert.strictEqual(simulated, 2);
const synthetic = buildSyntheticGameSyncPayload(8.5);

const listener = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert(listener.includes("sendDynamicFinishStateSync(socket, finishedState, \"dynamic-finish-state\")"));
assert(listener.includes("sendManagedOrImmediatePacket(socket, NPT_GAME_SYNC_DATA_PACK_NOT, payload, label)"));
assert(listener.includes("startDynamicBattleManager(socket, label)"));

validateManagedSchemas([first, second, synthetic]);
console.log(`[battle-sync-protocol-check] PASS syncs=3 simulated=${simulated} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function validateManagedSchemas(payloads) {
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
    for (const payload of payloads) {
      const result = host.request("validatePacket", { packetId: 822, payloadBase64: payload.toString("base64") });
      assert(result.ok, result.error || "managed client schema rejected GAME_SYNC notification");
    }
  } finally {
    host.close();
  }
}
