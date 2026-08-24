"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeFloatLE,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { createDeployHandler } = require("../combat-handler/deploy");
const syncBuilder = require("../combat-handler/syncBuilder");
const { createPrivatePvpManager } = require("../modules/private-pvp");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(816);
assert.strictEqual(handler.fileName, "packet-handlers\\0816-game-respawn-req.js");

const socket = { session: { user: { userUid: "816001" }, gameReplay: null } };
const packets = [];
let dynamicCalls = 0;
let dynamicHandled = true;
let lastRequest = null;
const ctx = {
  config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: false },
  constants: { GAME_RESPAWN_ACK: 817, HEART_BIT_ACK: 601, GAME_PAUSE_ACK: 813 },
  capturedGameFlow: null,
  decryptCopy(payload) { return payload; },
  isTutorialCapturedBootstrapActive() { return false; },
  buildGameRespawnAckPayload,
  sendGameResponse(_socket, _packet, packetId, payload, label) { packets.push({ packetId, payload, label }); },
  handleDynamicBattleRespawn(_socket, req) {
    dynamicCalls += 1;
    lastRequest = req;
    if (dynamicHandled) packets.push({ packetId: 817, payload: buildGameRespawnAckPayload(req.unitUID, req.assistUnit) });
    return dynamicHandled;
  },
};

const valid = respawnRequest(123456789n, false, -812.5, 4.25);
for (const payload of [
  Buffer.alloc(0),
  Buffer.from([0x80]),
  valid.subarray(0, valid.length - 1),
  Buffer.concat([valid, Buffer.from([0])]),
  replaceAssist(valid, 2),
  replaceFloat(valid, 1, Number.NaN),
  replaceFloat(valid, 5, Number.POSITIVE_INFINITY),
]) {
  send(payload);
  assertAck(20191, 0n, false, "malformed respawn request");
}
assert.strictEqual(dynamicCalls, 0, "malformed requests must not reach combat authority");

send(valid);
assertAck(78, 123456789n, false, "respawn without an active battle");

startBattle();
socket.session.gameReplay.battleState.finished = true;
send(valid);
assertAck(78, 123456789n, false, "respawn after battle finish");
assert.strictEqual(dynamicCalls, 0);

startBattle();
send(respawnRequest(-1n, true, 250, 8));
assertAck(0, -1n, true, "active assist respawn");
assert.deepStrictEqual(lastRequest, { unitUID: "-1", assistUnit: true, respawnPosX: 250, gameTime: 8 });
assert.strictEqual(socket.session.gameReplay.lastRespawnReq, undefined, "packet routing must not pre-commit respawn state");

startBattle();
dynamicHandled = false;
send(valid);
assertAck(78, 123456789n, false, "managed host unavailable");

validateFallbackRejection();
validateFrozenSources();
validateManagedRuntime();
console.log(`[game-respawn-protocol-check] PASS requests=11 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function startBattle() {
  socket.session.gameReplay = {
    dynamicGame: { gameType: 3, dungeonID: 30000, managedCombat: true },
    battleState: { gameState: { state: 3 } },
  };
}

function send(payload) {
  packets.length = 0;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 816, sequence: 1, payload }), true);
}

function assertAck(errorCode, unitUID, assistUnit, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, 817, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  const unit = readSignedVarLong(packets[0].payload, error.offset);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(unit.value, unitUID, label);
  assert.strictEqual(packets[0].payload[unit.offset] !== 0, assistUnit, label);
  assert.strictEqual(unit.offset + 1, packets[0].payload.length, `${label} ACK must have no trailing fields`);
}

function buildGameRespawnAckPayload(unitUID, assistUnit, errorCode = 0) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarLong(BigInt(unitUID || 0)), writeBool(assistUnit)]);
}

function respawnRequest(unitUID, assistUnit, respawnPosX, gameTime) {
  return Buffer.concat([
    writeSignedVarLong(unitUID),
    writeBool(assistUnit),
    writeFloatLE(respawnPosX),
    writeFloatLE(gameTime),
  ]);
}

function replaceAssist(payload, value) {
  const copy = Buffer.from(payload);
  const unit = readSignedVarLong(copy, 0);
  copy[unit.offset] = value;
  return copy;
}

function replaceFloat(payload, relativeOffset, value) {
  const copy = Buffer.from(payload);
  const unit = readSignedVarLong(copy, 0);
  copy.writeFloatLE(value, unit.offset + relativeOffset);
  return copy;
}

function validateFallbackRejection() {
  const deploy = createDeployHandler({
    tick: {},
    syncBuilder,
  });
  const replay = {
    dynamicGame: {
      unitPools: { byUnitUID: new Map(), ordered: [], unassignedGameUnitUIDs: [] },
      usedPooledGameUnitUIDs: new Set(),
    },
    battleState: { units: [] },
  };
  const result = deploy.handleDeploy(replay, { unitUID: "999", assistUnit: false, respawnPosX: 0, gameTime: 0 });
  assert.strictEqual(result.handled, true);
  assert.strictEqual(result.errorCode, 78);
  assert.strictEqual(result.deployed, null);
  assert.strictEqual(replay.battleState.units.length, 0);
  const error = readSignedVarInt(result.ackPayload, 0);
  assert.strictEqual(error.value, 78, "fallback must reject when no real runtime unit can be deployed");
}

function validateFrozenSources() {
  const request = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_RESPAWN_REQ.cs"), "utf8");
  const ack = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_RESPAWN_ACK.cs"), "utf8");
  const server = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKM", "NKMGameServerHost.cs"), "utf8");
  for (const field of ["unitUID", "assistUnit", "respawnPosX", "gameTime"]) assert(request.includes(`ref this.${field}`));
  assert(ack.includes("PutOrGetEnum<NKM_ERROR_CODE>(ref this.errorCode)"));
  assert(ack.includes("ref this.unitUID"));
  assert(ack.includes("ref this.assistUnit"));
  assert(server.includes("NEC_FAIL_NPT_GAME_RESPAWN_ACK_UNIT_NULL"));
  assert(server.includes("NEC_FAIL_NPT_GAME_RESPAWN_ACK_NO_RESPAWN_COST"));
  assert(server.includes("NEC_FAIL_NPT_GAME_RESPAWN_ACK_MAX_UNIT_COUNT_SAME_TIME"));

  const combatSource = fs.readFileSync(path.join(rootDir, "combat-handler", "index.js"), "utf8");
  assert(combatSource.includes("if (errorCode === 0) mirrorManagedDeployToBattleState(replay, request.req);"));
  assert(!combatSource.includes("applyHostState(replay, response);\n        mirrorManagedDeployToBattleState(replay, request.req);"));
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
      [816, valid],
      [817, buildGameRespawnAckPayload(123456789n, false)],
      [817, buildGameRespawnAckPayload(123456789n, false, 72)],
    ]) {
      const validation = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(validation.ok, validation.error || `managed client schema rejected respawn packet ${packetId}`);
    }

    const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
    const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
    assert(sourceUser && sourceUser.userUid, "managed respawn check needs a local user fixture");
    const manager = createPrivatePvpManager({ logger() {} });
    const room = manager.createRoom({ session: {} }, sourceUser, {});
    const guest = manager.reserveRemote(room.code, JSON.parse(JSON.stringify(sourceUser))).member.user;
    const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
    const playerDeckB = buildPlayerDeckForGameLoad(guest, { selectDeckIndex: 0 });
    assert(playerDeck && playerDeckB && playerDeck.units.length, "managed respawn check needs two playable decks");

    let state = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 18 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 18, playerDeck, playerDeckB },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed respawn battle did not start");
    const initial = host.request("buildInitialSync", stateData(state));
    assert(initial.ok, initial.error || "managed respawn initial sync failed");
    state = mergeState(state, initial);
    const primed = host.request("buildTimeline", { ...stateData(state), delta: 1 / 30, maxFrames: 150, startIndex: 0 });
    assert(primed.ok, primed.error || "managed respawn battle did not reach play state");
    state = mergeState(state, primed);

    let result = host.request("handleDeploy", {
      ...stateData(state),
      teamType: 1,
      req: { unitUID: "999999999999", assistUnit: false, respawnPosX: -900, gameTime: 4 },
    });
    assert(result.ok, result.error || "managed invalid respawn request failed");
    assertManagedAck(result, 72, 999999999999n, false, "unknown managed unit");
    state = mergeState(state, result);

    const unitUID = BigInt(playerDeck.units[0].unitUid);
    result = host.request("handleDeploy", {
      ...stateData(state),
      teamType: 1,
      req: { unitUID: unitUID.toString(), assistUnit: false, respawnPosX: -900, gameTime: 4 },
    });
    assert(result.ok, result.error || "managed valid respawn request failed");
    assertManagedAck(result, 0, unitUID, false, "valid managed unit");
    state = mergeState(state, result);

    const disposed = host.request("disposeBattle", stateData(state));
    assert(disposed.ok, disposed.error || "managed respawn battle did not dispose");
  } finally {
    host.close();
  }
}

function assertManagedAck(result, errorCode, unitUID, assistUnit, label) {
  const packet = (result.packets || []).find((entry) => Number(entry.packetId) === 817);
  assert(packet, `${label} did not return packet 817`);
  const error = readSignedVarInt(packet.payload, 0);
  const unit = readSignedVarLong(packet.payload, error.offset);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(unit.value, unitUID, label);
  assert.strictEqual(packet.payload[unit.offset] !== 0, assistUnit, label);
  assert.strictEqual(unit.offset + 1, packet.payload.length, label);
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
