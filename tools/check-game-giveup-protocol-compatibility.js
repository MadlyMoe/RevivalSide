"use strict";

const assert = require("assert");
const path = require("path");
const handler = require("../packet-handlers/0823-game-giveup-req");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "823001", tutorial: { phases: {} } };
const socket = { session: { user } };
const packets = [];
let room = null;
let member = null;
let finishPvpCalls = 0;
let finishSyncCalls = 0;
let finalizeCalls = 0;
let raidRefreshCalls = 0;
let abandonCalls = 0;
let managedEndCalls = 0;
let buildResult = Buffer.from([0xaa]);
let buildInput = null;
const ctx = {
  constants: { GAME_GIVEUP_ACK: 824, GAME_END_NOT: 811 },
  decryptCopy(payload) { return payload; },
  writeSignedVarInt,
  sendGameResponse(_socket, _packet, packetId, payload) { packets.push({ packetId, payload }); },
  sendServerGamePacket(_socket, packetId, payload) { packets.push({ packetId, payload }); },
  sendManagedOrImmediatePacket(_socket, packetId, payload) {
    managedEndCalls += 1;
    assert.strictEqual(packetId, 811);
    packets.push({ packetId: 3906, payload });
  },
  privatePvp: {
    getRoom() { return room; },
    getMember() { return member; },
  },
  finishPrivatePvpGiveup() { finishPvpCalls += 1; return true; },
  buildDynamicGameEndNotPayload(_replay, input) { buildInput = input; return buildResult; },
  sendDynamicFinishStateSync(_socket, state) {
    finishSyncCalls += 1;
    assert.strictEqual(state.finished, true);
    packets.push({ packetId: 822, payload: Buffer.from([0xbb]) });
    return true;
  },
  maybeRecordDynamicBattleClear(_socket, state) {
    finalizeCalls += 1;
    assert.strictEqual(state.giveup, true);
    return true;
  },
  sendRaidStateDataForSocket() { raidRefreshCalls += 1; return true; },
  abandonDynamicBattle() { abandonCalls += 1; return true; },
};

send(Buffer.alloc(0));
assertOnlyAck(78, "no active battle");
send(Buffer.from([0]));
assertOnlyAck(78, "trailing request data");

startBattle({ gameType: 3, stageID: 10111, dungeonID: 101 });
send(Buffer.alloc(0));
assert.deepStrictEqual(packets.map((entry) => entry.packetId), [824, 822, 811]);
assertAckAt(0, 0, "active PvE giveup");
assert.strictEqual(buildInput.giveup, true);
assert.strictEqual(buildInput.win, false);
assert.strictEqual(buildInput.battleState.finished, true);
assert.strictEqual(buildInput.battleState.gameState.state, 4);
assert.strictEqual(buildInput.battleState.gameState.winTeam, 3);
assert.strictEqual(socket.session.gameReplay.battleState.giveup, true);
assert.strictEqual(socket.session.gameReplay.dynamicBattleResultSent, true);
assert.strictEqual(finishSyncCalls, 1);
assert.strictEqual(finalizeCalls, 1);
assert.strictEqual(raidRefreshCalls, 1);
assert.strictEqual(abandonCalls, 1);

startBattle({ gameType: 26, stageID: 10111, dungeonID: 101 });
send(Buffer.alloc(0));
assert.deepStrictEqual(packets.map((entry) => entry.packetId), [824, 822, 3906]);
assert.strictEqual(managedEndCalls, 1, "Defence giveup must use the managed end wrapper");

startBattle({ gameType: 3, stageID: 10111, dungeonID: 101 });
buildResult = null;
send(Buffer.alloc(0));
assertOnlyAck(78, "unserializable battle result");
assert.strictEqual(socket.session.gameReplay.battleState.finished, undefined, "failed giveup must not finish the battle");
buildResult = Buffer.from([0xaa]);

startBattle({ gameType: 7, stageID: 11211, dungeonID: 1004 });
send(Buffer.alloc(0));
assertOnlyAck(78, "uncleared prologue dungeon");
user.tutorial.phases["1004"] = { completed: true };
send(Buffer.alloc(0));
assert.deepStrictEqual(packets.map((entry) => entry.packetId), [824, 822, 811]);
assertAckAt(0, 0, "cleared tutorial replay giveup");

socket.session.gameReplay = null;
room = { matchStarted: false };
member = { teamType: 1 };
send(Buffer.alloc(0));
assertOnlyAck(78, "inactive private PvP room");
room.matchStarted = true;
send(Buffer.alloc(0));
assertOnlyAck(0, "active private PvP room");
assert.strictEqual(finishPvpCalls, 1);

assert.strictEqual(handler.packetId, 823);
validateManagedSchemas();
console.log(`[game-giveup-protocol-check] PASS managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function startBattle(dynamicGame) {
  room = null;
  member = null;
  socket.session.gameReplay = {
    dynamicGame,
    battleState: { gameState: { waveId: 1 } },
    dynamicBattleResultSent: false,
    pendingGameStartBootstrap: true,
    pendingGameStartPackets: [1],
  };
}

function send(payload) {
  packets.length = 0;
  buildInput = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 823, sequence: 1, payload }), true);
}

function assertOnlyAck(errorCode, label) {
  assert.strictEqual(packets.length, 1, label);
  assertAckAt(0, errorCode, label);
}

function assertAckAt(index, errorCode, label) {
  assert.strictEqual(packets[index].packetId, 824, label);
  const error = readSignedVarInt(packets[index].payload, 0);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(error.offset, packets[index].payload.length, `${label} ACK must have no trailing fields`);
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
    for (const [packetId, payload] of [[823, Buffer.alloc(0)], [824, writeSignedVarInt(0)]]) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected giveup packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
