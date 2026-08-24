"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const simulation = require("../modules/simulation");
const defence = require("../modules/defence");
const {
  readSignedVarInt,
  writeNullObject,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { buildPlayerDeckForGameLoad, ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
assert.strictEqual(
  handlers.get(simulation.START_SIMULATED_PVP_TEST_REQ).fileName,
  "modules\\simulation\\handlers\\0855-2684-simulation-reqs.js"
);

const user = makeUser(1);
const target = makeUser(2);
const requestPayload = Buffer.concat([
  writeSignedVarLong(BigInt(user.userUid)),
  writeSignedVarLong(BigInt(target.userUid)),
]);
const decodeCtx = { decryptCopy: (payload) => payload };
assert.deepStrictEqual(simulation.decodeStartSimulatedPvpTestReq(decodeCtx, requestPayload), {
  valid: true,
  playerUserUidA: BigInt(user.userUid),
  playerUserUidB: BigInt(target.userUid),
});
for (const payload of [
  Buffer.alloc(0),
  requestPayload.subarray(0, requestPayload.length - 1),
  Buffer.concat([requestPayload, Buffer.from([0])]),
  Buffer.concat([Buffer.from([0x80, 0]), writeSignedVarLong(BigInt(target.userUid))]),
]) {
  assert.strictEqual(simulation.decodeStartSimulatedPvpTestReq(decodeCtx, payload).valid, false);
}

let saves = 0;
let invalidations = 0;
let missions = 0;
const sent = [];
const socket = { session: { user } };
const handler = handlers.get(simulation.START_SIMULATED_PVP_TEST_REQ);
const ctx = {
  ...decodeCtx,
  config: { USE_LOCAL_USER_DB: true },
  createEphemeralUser: () => user,
  dateTimeBinaryNow: () => 5250508610427387904n,
  buildSimulatedPvpTestResult(_socket, _user, req) {
    return req.valid
      ? { errorCode: 0, changed: true, payload: Buffer.from([0]) }
      : { errorCode: 20191, changed: false, payload: simulation.buildStartSimulatedPvpTestAckPayload(ctx, user, req, { errorCode: 20191 }) };
  },
  sendGameResponse(_socket, _packet, packetId, payload) { sent.push({ packetId, payload }); },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  trackMissionEvent() { missions += 1; },
};
handler.handle(ctx, socket, { packetId: simulation.START_SIMULATED_PVP_TEST_REQ, sequence: 1, payload: Buffer.alloc(0) });
assert.strictEqual(readSignedVarInt(sent.pop().payload, 0).value, 20191);
assert.deepStrictEqual([saves, invalidations, missions], [0, 0, 0]);
handler.handle(ctx, socket, { packetId: simulation.START_SIMULATED_PVP_TEST_REQ, sequence: 2, payload: requestPayload });
assert.strictEqual(sent.pop().packetId, simulation.START_SIMULATED_PVP_TEST_ACK);
assert.deepStrictEqual([saves, invalidations, missions], [1, 1, 1]);

assertFrozenSources();
const managed = validateManagedReplay(user, target, requestPayload);
console.log(
  `[simulated-pvp-check] PASS frames=${managed.frames} syncs=${managed.syncs} packets=${managed.packets} replayBytes=${managed.replayBytes} managed=on`
);

function validateManagedReplay(userA, userB, reqPayload) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for simulated-PvP validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 60000,
  });
  let state = null;
  try {
    const playerDeck = buildPlayerDeckForGameLoad(userA, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 6, index: 0 }, strictSelection: true,
    });
    const playerDeckB = buildPlayerDeckForGameLoad(userB, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 6, index: 0 }, strictSelection: true,
    });
    assert(playerDeck && playerDeckB);
    state = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: simulation.NGT_PVE_SIMULATED, selectDeckIndex: 0 },
      stage: {
        stageId: 0,
        dungeonID: 0,
        mapID: 1002,
        gameType: simulation.NGT_PVE_SIMULATED,
        miscMode: "pve-simulated",
        initialRemainGameTime: 180,
        respawnCostA1: 10,
        respawnCostB1: 10,
        playerDeck,
        playerDeckB,
      },
      gameUID: "2684000000001",
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed simulated PvP start failed");
    state.dynamicGame.autoRespawnEnabled = true;
    state.dynamicGame.autoRespawnEnabledB = true;
    state.dynamicGame.autoSkillType = 1;
    state.dynamicGame.autoSkillTypeB = 1;

    const packets = [];
    let timeline = null;
    let frames = 0;
    for (let index = 0; index < 8; index += 1) {
      const chunk = host.request("buildReplayChunk", {
        dynamicGame: state.dynamicGame,
        battleState: state.battleState,
        delta: 0.1,
        maxFrames: 600,
        startIndex: frames,
      });
      assert(chunk.ok && chunk.timeline, chunk.error || "managed simulated PvP replay chunk failed");
      timeline = chunk.timeline;
      packets.push(...(chunk.packets || []));
      state.battleState = chunk.battleState || state.battleState;
      frames += 600;
      if (timeline.finished) break;
    }
    assert(timeline && timeline.finished, "managed simulated PvP must reach a real terminal state");
    assert([1, 3].includes(Number(timeline.winTeam)), `unexpected simulated PvP win team ${timeline.winTeam}`);
    const loadComplete = packets.find((packet) => packet.packetId === 808);
    const gameStart = packets.find((packet) => packet.packetId === 809);
    const syncs = packets.filter((packet) => packet.packetId === 822);
    assert(
      loadComplete && gameStart && syncs.length > 0,
      `managed replay must contain the frozen 808/809/822 stream; got ${[...new Set(packets.map((packet) => packet.packetId))].join(",")}`
    );
    for (const packet of [loadComplete, gameStart, syncs[0], syncs[Math.floor(syncs.length / 2)], syncs[syncs.length - 1]]) {
      validatePacket(host, packet.packetId, packet.payload);
    }

    const finalFrame = timeline.frames[timeline.frames.length - 1];
    const history = {
      gameUid: state.dynamicGame.gameUID,
      myUserLevel: userA.level,
      targetUserLevel: userB.level,
      targetNickName: userB.nickname,
      result: Number(timeline.winTeam) === 1 ? 0 : 1,
      regdateTick: "639176400000000000",
      myDeckPayloadBase64: defence.buildAsyncDeckData({ ...userA, defenceDeck: userA.army.deckSets["6"][0] }).toString("base64"),
      targetDeckPayloadBase64: defence.buildAsyncDeckData({ ...userB, defenceDeck: userB.army.deckSets["6"][0] }).toString("base64"),
      gameType: simulation.NGT_PVE_SIMULATED,
      targetFriendCode: userB.friendCode,
    };
    const ack = simulation.buildStartSimulatedPvpTestAckPayload(
      { dateTimeBinaryNow: () => 5250508610427387904n },
      userA,
      simulation.decodeStartSimulatedPvpTestReq(decodeCtx, reqPayload),
      {
        gameDataPayload: extractGameData(state.payload),
        gameRuntimeDataPayload: extractRuntimeData(loadComplete.payload),
        syncPayloads: syncs.map((packet) => packet.payload),
        pvpResult: history.result,
        gameEndTime: Number(finalFrame.playTime || finalFrame.gameTime || 0),
        gameRecordPayload: writeNullObject(),
        history,
      }
    );
    validatePacket(host, simulation.START_SIMULATED_PVP_TEST_REQ, reqPayload);
    validatePacket(host, simulation.START_SIMULATED_PVP_TEST_ACK, ack);
    return { frames, syncs: syncs.length, packets: packets.length + 2, replayBytes: ack.length };
  } finally {
    if (state && state.dynamicGame) host.request("disposeBattle", { dynamicGame: state.dynamicGame, battleState: state.battleState });
    host.close();
  }
}

function extractGameData(payload) {
  const raw = Buffer.from(payload);
  const error = readSignedVarInt(raw, 0);
  assert.strictEqual(error.value, 0);
  assert.strictEqual(raw[raw.length - 1], 0);
  return raw.subarray(error.offset, raw.length - 1);
}

function extractRuntimeData(payload) {
  const raw = Buffer.from(payload);
  const error = readSignedVarInt(raw, 0);
  assert.strictEqual(error.value, 0);
  assert([0, 1].includes(raw[error.offset]));
  return raw.subarray(error.offset + 1, raw.length - 1);
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: Buffer.from(payload).toString("base64") });
  assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
}

function makeUser(index) {
  const value = {
    userUid: String(2684000 + index),
    friendCode: String(26840000 + index),
    nickname: `SimulatedPvp${index}`,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2684000000000n + BigInt(index) * 100n),
  };
  ensureArmy(value);
  const units = uniqueBaseUnitIds(8).map((unitId) => grantUnit(value, unitId, { level: 100 }));
  const ships = getPlayableShipIds();
  const operators = getPlayableOperatorIds();
  const ship = grantUnit(value, ships[index % ships.length], { level: 100 });
  const operator = grantOperator(value, operators[index % operators.length], { level: 100 });
  const deck = ensureDeck(value, { deckType: 6, index: 0 });
  deck.unitUids = units.map((unit) => unit.unitUid);
  deck.shipUid = ship.unitUid;
  deck.operatorUid = operator.uid;
  deck.leaderIndex = 0;
  deck.state = 0;
  deck.operationPower = 800000 + index * 1000;
  return value;
}

function uniqueBaseUnitIds(count) {
  const selected = [];
  const bases = new Set();
  for (const unitId of getPlayableUnitIds()) {
    const template = getUnitTemplet(unitId);
    const baseId = Number(template && template.m_BaseUnitID) || unitId;
    if (bases.has(baseId)) continue;
    bases.add(baseId);
    selected.push(unitId);
    if (selected.length === count) break;
  }
  assert.strictEqual(selected.length, count);
  return selected;
}

function assertFrozenSources() {
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_START_SIMULATED_PVP_TEST_REQ.cs"), /playerUserUidA[\s\S]*playerUserUidB/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_START_SIMULATED_PVP_TEST_ACK.cs"), /errorCode[\s\S]*replayData[\s\S]*history/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "ReplayData.cs"), /gameData[\s\S]*gameRuntimeData[\s\S]*syncList[\s\S]*pvpResult[\s\S]*gameEndTime[\s\S]*gameRecord/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Friend", "NKCPopupFriendInfo.cs"), /OnClickSimulatedPvpTest[\s\S]*Send_NKMPacket_START_SIMULATED_PVP_TEST_REQ/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /WriteReplayDataToFile[\s\S]*m_AsyncPvpHistory\.Add/);
  assert.match(source("server", "listener.js"), /buildSimulatedPvpTestResult[\s\S]*buildReplayChunk/);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
