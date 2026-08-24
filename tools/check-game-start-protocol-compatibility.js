"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  readSignedVarInt,
  writeBool,
  writeNullObject,
  writeSignedVarInt,
} = require("../modules/packet-codec");
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
const handler = handlers.get(807);
assert.strictEqual(handler.fileName, "packet-handlers\\0807-game-load-complete-req.js");

const packets = [];
let initialPackets = [];
let intrudePackets = [];
let buildCalls = 0;
let startCalls = 0;
let managerStartCalls = 0;
let capturedCalls = 0;
let pendingResult = true;
const lifecycleEvents = [];
const privateState = { room: null, members: new Map() };
const socket = makeSocket("807001");
const ctx = {
  config: { DYNAMIC_BATTLE_MANAGER: true, REPLAY_CAPTURED_GAME_FLOW: false },
  constants: { HEART_BIT_ACK: 601 },
  capturedGameFlow: null,
  decryptCopy(payload) { return payload; },
  privatePvp: {
    getRoom(current) { return privateState.room && privateState.members.has(current) ? privateState.room : null; },
    getMember(current) { return privateState.members.get(current) || null; },
  },
  isTutorialCapturedBootstrapActive() { return false; },
  sendCapturedTutorialLoadCompleteBootstrap() { return false; },
  sendCapturedGameUntilBeforePacketIds() { capturedCalls += 1; },
  buildGameLoadCompleteAckPayload,
  buildInitialBattlePackets() {
    buildCalls += 1;
    return initialPackets;
  },
  buildIntrudeStartPackets() {
    buildCalls += 1;
    return intrudePackets;
  },
  ensureGameStartPackets(source) { return source.filter(Boolean); },
  sendPendingGameStartSync(current) {
    if (!pendingResult) return false;
    packets.push(...current.session.gameReplay.pendingGameStartPackets);
    current.session.gameReplay.pendingGameStartBootstrap = false;
    current.session.gameReplay.pendingGameStartPackets = [];
    startCalls += 1;
    return true;
  },
  sendGameResponse(current, _request, packetId, payload, label) {
    packets.push({ socket: current, packetId, payload, label });
  },
  sendServerGamePacket(current, packetId, payload, label) {
    packets.push({ socket: current, packetId, payload, label });
    lifecycleEvents.push(`packet:${packetId}`);
  },
  startDynamicBattleManager(current, label) {
    managerStartCalls += 1;
    lifecycleEvents.push(`start:${label}`);
    current.session.gameReplay.dynamicBattleTimer = { active: true };
  },
};

for (const payload of [Buffer.alloc(0), Buffer.from([2]), Buffer.from([0, 0])]) {
  reset();
  send(socket, payload);
  assertAck(packets[0], 20191, false, "malformed load-complete request");
  assert.strictEqual(buildCalls, 0, "malformed requests must not reach combat authority");
}

reset();
send(socket, writeBool(true));
assertAck(packets[0], 20118, true, "intrusion handshake without active battle");
assert.strictEqual(buildCalls, 0);

reset(activeReplay());
send(socket, writeBool(true));
assertAck(packets[0], 95, true, "managed intrusion handshake unavailable");
assert.strictEqual(socket.session.gameReplay.loadCompleteReceived, undefined);

reset(activeReplay());
intrudePackets = [
  { packetId: 808, payload: buildGameLoadCompleteAckPayload(null, null, { isIntrude: true }), label: "managed-load-complete" },
  { packetId: 810, payload: Buffer.from([1]), label: "managed-intrude-start" },
];
send(socket, writeBool(true));
assert.deepStrictEqual(packets.map((entry) => entry.packetId), [808, 810]);
assert.strictEqual(socket.session.gameReplay.loadCompleteReceived, true);
assert.strictEqual(managerStartCalls, 1, "managed battle re-entry must restart a missing battle loop exactly once");
assert.deepStrictEqual(lifecycleEvents, ["packet:808", "packet:810", "start:managed-intrude-start"], "re-entry packets must precede loop restart");

reset(activeReplay());
socket.session.gameReplay.dynamicBattleTimer = { active: true };
intrudePackets = [
  { packetId: 808, payload: buildGameLoadCompleteAckPayload(null, null, { isIntrude: true }) },
  { packetId: 810, payload: Buffer.from([1]) },
];
send(socket, writeBool(true));
assert.strictEqual(managerStartCalls, 0, "managed battle re-entry must not duplicate an existing battle loop");

reset(activeReplay());
socket.session.gameReplay.battleState.finished = true;
send(socket, writeBool(true));
assertAck(packets[0], 20118, true, "intrusion handshake after battle finish");
assert.strictEqual(managerStartCalls, 0, "finished battles must never restart their loop");

reset();
send(socket, writeBool(false));
assertAck(packets[0], 20118, false, "load complete without active battle");

reset(activeReplay());
socket.session.gameReplay.battleState.finished = true;
send(socket, writeBool(false));
assertAck(packets[0], 20118, false, "load complete after battle finish");

reset(activeReplay());
send(socket, writeBool(false));
assertAck(packets[0], 95, false, "managed initial handshake unavailable");
assert.strictEqual(socket.session.gameReplay.loadCompleteReceived, undefined);
assert.strictEqual(startCalls, 0);

reset(activeReplay());
initialPackets = [
  { packetId: 808, payload: buildGameLoadCompleteAckPayload(), label: "managed-load-complete" },
  { packetId: 809, payload: Buffer.alloc(0), label: "managed-game-start" },
  { packetId: 822, payload: Buffer.from([1]), label: "managed-game-sync" },
];
send(socket, writeBool(false));
assert.deepStrictEqual(packets.map((entry) => entry.packetId), [808, 809, 822]);
assert.strictEqual(socket.session.gameReplay.loadCompleteReceived, true);
assert.strictEqual(startCalls, 1);

reset({ battleState: {}, captureOnly: true });
ctx.config.DYNAMIC_BATTLE_MANAGER = false;
ctx.config.REPLAY_CAPTURED_GAME_FLOW = true;
ctx.capturedGameFlow = {};
send(socket, writeBool(false));
assert.strictEqual(capturedCalls, 1, "captured flow without dynamic state must remain reachable");
assert.strictEqual(socket.session.gameReplay.loadCompleteReceived, true);
assert.strictEqual(packets.length, 0);
ctx.config.DYNAMIC_BATTLE_MANAGER = true;
ctx.config.REPLAY_CAPTURED_GAME_FLOW = false;
ctx.capturedGameFlow = null;

validatePrivatePvpBarrier();
validateFrozenSources();
validateManagedRuntime();
console.log(`[game-start-protocol-check] PASS requests=14 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function reset(replay = null) {
  packets.length = 0;
  initialPackets = [];
  intrudePackets = [];
  buildCalls = 0;
  startCalls = 0;
  managerStartCalls = 0;
  capturedCalls = 0;
  lifecycleEvents.length = 0;
  pendingResult = true;
  socket.session.gameReplay = replay;
  privateState.room = null;
  privateState.members.clear();
}

function send(current, payload) {
  assert.strictEqual(handler.handle(ctx, current, { packetId: 807, sequence: 1, payload }), true);
}

function activeReplay() {
  return {
    dynamicGame: { gameType: 3, managedCombat: true },
    battleState: { gameState: { state: 2 }, finished: false },
  };
}

function makeSocket(userUid) {
  return { destroyed: false, session: { user: { userUid }, gameReplay: null } };
}

function buildGameLoadCompleteAckPayload(_replay = null, _user = null, options = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(options.errorCode || 0)),
    writeBool(Boolean(options.isIntrude)),
    writeNullObject(),
    writeSignedVarInt(Number(options.rewardMultiply || 0)),
  ]);
}

function assertAck(packet, errorCode, isIntrude, label) {
  assert(packet, label);
  assert.strictEqual(packet.packetId, 808, label);
  const error = readSignedVarInt(packet.payload, 0);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(packet.payload[error.offset] !== 0, isIntrude, label);
  assert.strictEqual(packet.payload[error.offset + 1], 0, `${label} runtime must be nullable`);
  const reward = readSignedVarInt(packet.payload, error.offset + 2);
  assert.strictEqual(reward.value, 0, label);
  assert.strictEqual(reward.offset, packet.payload.length, `${label} ACK must have no trailing fields`);
}

function validatePrivatePvpBarrier() {
  reset();
  const sharedReplay = activeReplay();
  const playerA = { socket: makeSocket("807101"), user: { userUid: "807101" }, observer: false, loaded: false };
  const playerB = { socket: makeSocket("807102"), user: { userUid: "807102" }, observer: false, loaded: false };
  playerA.socket.session.gameReplay = sharedReplay;
  playerB.socket.session.gameReplay = sharedReplay;
  privateState.room = { code: "START1", matchStarted: true, battleStarted: false, members: [playerA, playerB] };
  privateState.members.set(playerA.socket, playerA);
  privateState.members.set(playerB.socket, playerB);
  initialPackets = [
    { packetId: 808, payload: buildGameLoadCompleteAckPayload() },
    { packetId: 809, payload: Buffer.alloc(0) },
  ];

  send(playerA.socket, writeBool(false));
  assert.strictEqual(playerA.loaded, true);
  assert.strictEqual(playerB.loaded, false);
  assert.strictEqual(sharedReplay.loadCompleteReceived, undefined, "one private player must not start the shared battle");
  assert.strictEqual(buildCalls, 0);

  send(playerB.socket, writeBool(false));
  assert.strictEqual(privateState.room.battleStarted, true);
  assert.strictEqual(sharedReplay.loadCompleteReceived, true);
  assert.strictEqual(buildCalls, 1);
  assert.strictEqual(startCalls, 1);

  reset();
  const failedReplay = activeReplay();
  const failedA = { socket: makeSocket("807201"), user: { userUid: "807201" }, observer: false, loaded: false };
  const failedB = { socket: makeSocket("807202"), user: { userUid: "807202" }, observer: false, loaded: false };
  failedA.socket.session.gameReplay = failedReplay;
  failedB.socket.session.gameReplay = failedReplay;
  privateState.room = { code: "START2", matchStarted: true, battleStarted: false, members: [failedA, failedB] };
  privateState.members.set(failedA.socket, failedA);
  privateState.members.set(failedB.socket, failedB);
  send(failedA.socket, writeBool(false));
  send(failedB.socket, writeBool(false));
  assert.strictEqual(privateState.room.battleStarted, false);
  assert.strictEqual(failedReplay.loadCompleteReceived, undefined);
  assert.strictEqual(failedA.loaded, false);
  assert.strictEqual(failedB.loaded, false);
  assert.strictEqual(packets.length, 2, "host failure must notify both private players");
  for (const packet of packets) assertAck(packet, 95, false, "private host failure");
}

function validateFrozenSources() {
  const req = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_LOAD_COMPLETE_REQ.cs");
  const ack = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_LOAD_COMPLETE_ACK.cs");
  const start = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_START_NOT.cs");
  const intrude = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_INTRUDE_START_NOT.cs");
  const local = source("Assembly-CSharp", "NKC", "NKCLocalServerManager.cs");
  const client = source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  const listener = source("server", "listener.js");
  assert(req.includes("ref this.isIntrude"));
  for (const field of ["errorCode", "isIntrude", "gameRuntimeData", "rewardMultiply"]) assert(ack.includes(`ref this.${field}`));
  assert.match(start, /Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  for (const field of ["gameTime", "absoluteGameTime", "gameSyncDataPack", "gameTeamDeckDataA", "gameTeamDeckDataB", "usedRespawnCost", "respawnCount", "mainShipAStateCoolTimeMap", "mainShipBStateCoolTimeMap"]) {
    assert(intrude.includes(`ref this.${field}`));
  }
  assert(local.includes("SendPacketToClient(new NKMPacket_GAME_LOAD_COMPLETE_ACK"));
  assert(local.includes("m_NKCGameServerLocal.StartGame(false)"));
  assert(client.includes("NEC_FAIL_GAME_LOAD_INVALID_STATE"));
  assert(client.includes("OnRecv(NKMPacket_GAME_START_NOT"));
  assert(listener.includes("managed initial handshake missing GAME_LOAD_COMPLETE_ACK or GAME_START_NOT"));
  assert(listener.includes("sourceLoadComplete ||"));
  assert(listener.includes("sourceGameStart ||"));
  assert(listener.indexOf("sourceLoadComplete ||") < listener.indexOf("sourceGameStart ||"));
  assert(listener.includes("replay.pendingGameStartBootstrap = false;\n    replay.pendingGameStartPackets = [];\n    return false;"));
  assert(source("combat-host", "ManagedCombatBridge.cs").includes('runtime.Invoke(server, "MakeFullSyncData")'));
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
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
  let state = null;
  try {
    for (const [packetId, payload] of [
      [807, writeBool(false)],
      [807, writeBool(true)],
      [808, buildGameLoadCompleteAckPayload(null, null, { errorCode: 20118, isIntrude: true })],
      [809, Buffer.alloc(0)],
    ]) {
      const validation = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(validation.ok, validation.error || `managed client schema rejected game-start packet ${packetId}`);
    }

    const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
    const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
    assert(sourceUser && sourceUser.userUid, "managed game-start check needs a local user fixture");
    const manager = createPrivatePvpManager({ logger() {} });
    const room = manager.createRoom({ session: {} }, sourceUser, {});
    const guest = manager.reserveRemote(room.code, JSON.parse(JSON.stringify(sourceUser))).member.user;
    const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
    const playerDeckB = buildPlayerDeckForGameLoad(guest, { selectDeckIndex: 0 });
    assert(playerDeck && playerDeckB && playerDeck.units.length, "managed game-start check needs playable decks");

    state = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 18 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 18, playerDeck, playerDeckB },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed game-start battle did not start");
    const initial = host.request("buildInitialSync", stateData(state));
    assert(initial.ok, initial.error || "managed initial game-start handshake failed");
    state = mergeState(state, initial);
    const initialPackets = initial.packets || [];
    const ids = initialPackets.map((packet) => Number(packet.packetId));
    assert.strictEqual(ids.filter((id) => id === 808).length, 1, "managed host must emit one load-complete ACK");
    assert.strictEqual(ids.filter((id) => id === 809).length, 1, "managed host must emit one game-start notification");
    assert(ids.indexOf(808) < ids.indexOf(809), "load-complete ACK must precede game-start notification");
    const loadComplete = initialPackets.find((packet) => Number(packet.packetId) === 808);
    const gameStart = initialPackets.find((packet) => Number(packet.packetId) === 809);
    assert.strictEqual(gameStart.payload.length, 0, "GAME_START_NOT must be empty");
    const inspected = host.request("inspectGameLoadCompleteAck", {
      packetId: 808,
      payloadBase64: loadComplete.payload.toString("base64"),
    });
    assert(inspected.ok, inspected.error || "managed load-complete ACK inspection failed");
    assert.match(inspected.summary || "", /errorCode=NEC_OK/);
    assert.match(inspected.summary || "", /isIntrude=False/);
    assert.match(inspected.summary || "", /rewardMultiply=1/);

    const second = host.request("buildInitialSync", stateData(state));
    assert(second.ok, second.error || "managed post-start sync failed");
    const secondIds = (second.packets || []).map((packet) => Number(packet.packetId));
    assert(!secondIds.includes(808) && !secondIds.includes(809), "managed host must not replay the one-shot start handshake");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const intrude = host.request("buildIntrudeStart", stateData(state));
      assert(intrude.ok, intrude.error || "managed battle re-entry failed");
      state = mergeState(state, intrude);
      const intrudePackets = intrude.packets || [];
      assert.deepStrictEqual(
        intrudePackets.map((packet) => Number(packet.packetId)),
        [808, 810],
        "battle re-entry must emit ACK before the full-sync notification"
      );
      const inspectedIntrudeAck = host.request("inspectGameLoadCompleteAck", {
        packetId: 808,
        payloadBase64: intrudePackets[0].payload.toString("base64"),
      });
      assert(inspectedIntrudeAck.ok, inspectedIntrudeAck.error || "managed re-entry ACK inspection failed");
      assert.match(inspectedIntrudeAck.summary || "", /errorCode=NEC_OK/);
      assert.match(inspectedIntrudeAck.summary || "", /isIntrude=True/);
      const validatedIntrude = host.request("validatePacket", {
        packetId: 810,
        payloadBase64: intrudePackets[1].payload.toString("base64"),
      });
      assert(validatedIntrude.ok, validatedIntrude.error || "managed full-sync notification failed schema validation");
      assert(intrudePackets[1].payload.length > 100, "managed full-sync notification must carry authoritative battle state");
    }
  } finally {
    if (state && state.dynamicGame) host.request("disposeBattle", stateData(state));
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
