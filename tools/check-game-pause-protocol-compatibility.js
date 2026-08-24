"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { readSignedVarInt, writeBool, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { createPrivatePvpManager } = require("../modules/private-pvp");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(812);
assert.strictEqual(handler.fileName, "packet-handlers\\0812-game-pause-req.js");

const socket = { session: { user: { userUid: "812001" }, gameReplay: null } };
const packets = [];
let dynamicCalls = 0;
let dynamicHandled = true;
let lastRequest = null;
const ctx = {
  config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: false },
  constants: { GAME_PAUSE_ACK: 813, HEART_BIT_ACK: 601 },
  capturedGameFlow: null,
  decryptCopy(payload) { return payload; },
  isTutorialCapturedBootstrapActive() { return false; },
  buildGamePauseAckPayload,
  sendGameResponse(_socket, _packet, packetId, payload, label) { packets.push({ packetId, payload, label }); },
  handleDynamicBattlePause(_socket, req) {
    dynamicCalls += 1;
    lastRequest = req;
    if (dynamicHandled) packets.push({ packetId: 813, payload: buildGamePauseAckPayload(req.isPause, req.isPauseEvent) });
    return dynamicHandled;
  },
};

for (const payload of [Buffer.alloc(0), Buffer.from([1]), Buffer.from([2, 0]), Buffer.from([0, 2]), Buffer.from([1, 0, 0])]) {
  send(payload);
  assertAck(20191, false, false, "malformed pause request");
}
assert.strictEqual(dynamicCalls, 0, "malformed requests must not reach the combat host");

send(Buffer.concat([writeBool(true), writeBool(true)]));
assertAck(20128, true, true, "pause without an active battle");
assert.strictEqual(dynamicCalls, 0);

startBattle();
send(Buffer.concat([writeBool(true), writeBool(false)]));
assertAck(0, true, false, "active battle pause");
assert.deepStrictEqual(lastRequest, { isPause: true, isPauseEvent: false });

send(Buffer.concat([writeBool(false), writeBool(true)]));
assertAck(0, false, true, "event-driven unpause");
assert.deepStrictEqual(lastRequest, { isPause: false, isPauseEvent: true });

socket.session.gameReplay.battleState.finished = true;
send(Buffer.concat([writeBool(true), writeBool(true)]));
assertAck(445, true, true, "finished battle cannot be paused");
assert.strictEqual(dynamicCalls, 2, "finished pause must not reach the combat host");

send(Buffer.concat([writeBool(false), writeBool(false)]));
assertAck(0, false, false, "finished battle may be unpaused");
assert.strictEqual(dynamicCalls, 3);

startBattle();
dynamicHandled = false;
send(Buffer.concat([writeBool(true), writeBool(false)]));
assertAck(20128, true, false, "managed host unavailable");

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert(listenerSource.includes("if (errorCode === 0) replay.dynamicBattlePaused = Boolean(req.isPause);"));
assert(!listenerSource.includes("replay.dynamicBattlePaused = Boolean(req.isPause);\n  const result"));

validateFrozenSources();
validateManagedRuntime();
console.log(`[game-pause-protocol-check] PASS requests=11 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function startBattle() {
  socket.session.gameReplay = {
    dynamicGame: { gameType: 3, dungeonID: 30000, managedCombat: true },
    battleState: { gameState: { state: 3 } },
    dynamicBattlePaused: false,
  };
}

function send(payload) {
  packets.length = 0;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 812, sequence: 1, payload }), true);
}

function assertAck(errorCode, isPause, isPauseEvent, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, 813, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(packets[0].payload[error.offset] !== 0, isPause, label);
  assert.strictEqual(packets[0].payload[error.offset + 1] !== 0, isPauseEvent, label);
  assert.strictEqual(error.offset + 2, packets[0].payload.length, `${label} ACK must have no trailing fields`);
}

function buildGamePauseAckPayload(isPause, isPauseEvent, errorCode = 0) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeBool(isPause), writeBool(isPauseEvent)]);
}

function validateFrozenSources() {
  const request = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_PAUSE_REQ.cs"), "utf8");
  const ack = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_PAUSE_ACK.cs"), "utf8");
  const server = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKM", "NKMGameServerHost.cs"), "utf8");
  assert.deepStrictEqual([...request.matchAll(/stream\.PutOrGet\(ref this\.(isPause(?:Event)?)\)/g)].map((match) => match[1]), ["isPause", "isPauseEvent"]);
  assert(ack.includes("PutOrGetEnum<NKM_ERROR_CODE>(ref this.errorCode)"));
  assert.deepStrictEqual([...ack.matchAll(/stream\.PutOrGet\(ref this\.(isPause(?:Event)?)\)/g)].map((match) => match[1]), ["isPause", "isPauseEvent"]);
  assert(server.includes("this.m_NKMGameRuntimeData.m_bPause = cNKMPacket_GAME_PAUSE_REQ.isPause;"));
  assert(server.includes("return NKM_ERROR_CODE.NEC_FAIL_GAME_IS_PAUSE;"));
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
    for (const [packetId, payload] of [
      [812, Buffer.concat([writeBool(true), writeBool(false)])],
      [813, buildGamePauseAckPayload(true, false)],
      [813, buildGamePauseAckPayload(true, true, 445)],
    ]) {
      const validation = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(validation.ok, validation.error || `managed client schema rejected pause packet ${packetId}`);
    }

    const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
    const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
    assert(sourceUser && sourceUser.userUid, "managed pause check needs a local user fixture");
    const manager = createPrivatePvpManager({ logger() {} });
    const room = manager.createRoom({ session: {} }, sourceUser, {});
    const guest = manager.reserveRemote(room.code, JSON.parse(JSON.stringify(sourceUser))).member.user;
    const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
    const playerDeckB = buildPlayerDeckForGameLoad(guest, { selectDeckIndex: 0 });
    assert(playerDeck && playerDeckB, "managed pause check needs two playable decks");

    let state = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 18 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 18, playerDeck, playerDeckB },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed pause battle did not start");

    for (const req of [{ isPause: true, isPauseEvent: false }, { isPause: false, isPauseEvent: true }]) {
      const result = host.request("handlePause", { ...stateData(state), req });
      assert(result.ok, result.error || "managed pause request failed");
      const packet = (result.packets || []).find((entry) => Number(entry.packetId) === 813);
      assert(packet, "managed pause request did not return packet 813");
      const error = readSignedVarInt(packet.payload, 0);
      assert.strictEqual(error.value, 0);
      assert.strictEqual(packet.payload[error.offset] !== 0, req.isPause);
      assert.strictEqual(packet.payload[error.offset + 1] !== 0, req.isPauseEvent);
      assert.strictEqual(error.offset + 2, packet.payload.length);
      state = mergeState(state, result);
    }

    const disposed = host.request("disposeBattle", stateData(state));
    assert(disposed.ok, disposed.error || "managed pause battle did not dispose");
  } finally {
    host.close();
  }
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
