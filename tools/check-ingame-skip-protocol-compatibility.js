"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { readSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createPrivatePvpManager } = require("../modules/private-pvp");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(889);
assert(handler, "INGAME_SKIP_REQ handler must be registered");
assert.strictEqual(handler.fileName, "packet-handlers\\0000-0889-ingame-skip.js");

const socket = { session: { user: { userUid: "889001" } } };
const packets = [];
let saves = 0;
let controlCalls = 0;
const ctx = {
  decryptCopy(payload) { return payload; },
  saveUserDb() { saves += 1; },
  applyCombatControls(target, controls, options) {
    controlCalls += 1;
    assert.deepStrictEqual(options, { persist: false });
    const replay = target.session.gameReplay;
    replay.gameSpeedType = controls.gameSpeedType;
    replay.dynamicGame.gameSpeedType = controls.gameSpeedType;
    replay.battleState.gameSpeedType = controls.gameSpeedType;
  },
  sendGameResponse(_socket, _packet, packetId, payload) { packets.push({ packetId, payload }); },
};

send(Buffer.alloc(0));
assertAck(28400, "no active battle");

for (const gameType of [11, 20, 21, 22]) {
  socket.session.gameReplay = { dynamicGame: { gameType }, battleState: {} };
  send(Buffer.alloc(0));
  assertAck(0, `game type ${gameType}`);
  assert.strictEqual(socket.session.gameReplay.gameSpeedType, 5);
  assert.strictEqual(socket.session.gameReplay.dynamicGame.gameSpeedType, 5);
  assert.strictEqual(socket.session.gameReplay.battleState.gameSpeedType, 5);
}

for (const gameType of [3, 6, 18, 26]) {
  socket.session.gameReplay = { dynamicGame: { gameType, gameSpeedType: 1 }, battleState: { gameSpeedType: 1 } };
  send(Buffer.alloc(0));
  assertAck(28400, `ineligible game type ${gameType}`);
  assert.strictEqual(socket.session.gameReplay.dynamicGame.gameSpeedType, 1);
}

socket.session.gameReplay = { dynamicGame: { gameType: 20, gameSpeedType: 1 }, battleState: { gameSpeedType: 1 } };
send(Buffer.from([0]));
assertAck(28400, "trailing request data");
assert.strictEqual(socket.session.gameReplay.dynamicGame.gameSpeedType, 1);
assert.strictEqual(controlCalls, 4, "only valid requests may alter runtime controls");
assert.strictEqual(saves, 0, "in-game skip must never persist a profile preference");

validateManagedRuntime();
console.log(`[ingame-skip-protocol-check] PASS packets=2 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload) {
  packets.length = 0;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 889, sequence: 1, payload }), true);
}

function assertAck(errorCode, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, 890, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(error.offset, packets[0].payload.length, `${label} ACK must have no trailing fields`);
}

function validateManagedRuntime() {
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
    for (const [packetId, payload] of [[889, Buffer.alloc(0)], [890, Buffer.from([0])]]) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected in-game skip packet ${packetId}: ${result.error || "unknown error"}`);
    }
    assertManagedSpeed(host);
  } finally {
    host.close();
  }
}

function assertManagedSpeed(host) {
  const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
  const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
  assert(sourceUser && sourceUser.userUid, "managed skip check needs a local user fixture");
  const manager = createPrivatePvpManager({ logger() {} });
  const room = manager.createRoom({ session: {} }, sourceUser, {});
  const guest = manager.reserveRemote(room.code, JSON.parse(JSON.stringify(sourceUser))).member.user;
  const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
  const playerDeckB = buildPlayerDeckForGameLoad(guest, { selectDeckIndex: 0 });
  assert(playerDeck && playerDeckB, "managed skip check needs two playable decks");

  let state = host.request("startBattle", {
    req: { stageID: 0, dungeonID: 0, gameType: 20 },
    stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 20, playerDeck, playerDeckB },
    gameUID: String(BigInt(Date.now()) * 10000n),
    gameLoadAckPayloadBase64: "",
  });
  assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed skip battle did not start");
  let initial = host.request("buildInitialSync", stateData(state));
  assert(initial.ok, initial.error || "managed skip initial sync failed");
  state = mergeState(state, initial);
  state.dynamicGame.gameSpeedType = 0;
  const normal = host.request("buildSync", { ...stateData(state), delta: 0.02 });
  assert(normal.ok, normal.error || "managed normal-speed sync failed");
  state = mergeState(state, normal);
  const before = summaryTime(normal);
  state.dynamicGame.gameSpeedType = 5;
  const advanced = host.request("buildSync", { ...stateData(state), delta: 0.02 });
  assert(advanced.ok, advanced.error || "managed skip sync failed");
  state = mergeState(state, advanced);
  const elapsed = summaryTime(advanced) - before;
  assert(elapsed >= 1, `NGST_80 must accelerate the authoritative managed runtime (elapsed=${elapsed}, before=${before}, summary=${advanced.summary})`);
  const disposed = host.request("disposeBattle", stateData(state));
  assert(disposed.ok, disposed.error || "managed skip battle did not dispose");
}

function summaryTime(response) {
  const value = Number(/\btime=([0-9.]+)/.exec(String(response.summary || ""))?.[1]);
  assert(Number.isFinite(value), `managed combat summary is missing runtime time: ${response.summary}`);
  return value;
}

function stateData(state) {
  return { dynamicGame: state.dynamicGame, battleState: state.battleState };
}

function mergeState(previous, next) {
  return {
    ...previous,
    ...next,
    dynamicGame: next.dynamicGame || previous.dynamicGame,
    battleState: next.battleState || previous.battleState,
  };
}
