"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  completeDiveBattle,
  createWorldMapHandlers,
  ensureWorldMapState,
  prepareDiveGameLoad,
} = require("../modules/world-map");
const {
  buildPlayerDeckForGameLoad,
  ensureArmy,
  ensureDefaultLineup,
  grantOperator,
  grantUnit,
} = require("../modules/unit");
const { getPlayableOperatorIds } = require("../modules/game-data");
const { grantMiscItem, getMiscItem, setMiscItemBalance, toBigInt } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeBool,
  writeByte,
  writeIntList,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ROOT = path.resolve(__dirname, "..");
const FIXED_NOW = 638500000000000000n;
const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  INVALID_STAGE: 314,
  NOT_CLEARED: 318,
  NOT_STARTED: 321,
  CANNOT_MOVE: 322,
  SQUAD_MISSING: 326,
  CANNOT_GIVE_UP: 324,
  NOT_READY: 325,
  SQUAD_DEAD: 336,
  INVALID_REQUEST: 20191,
  CANNOT_SELECT_ARTIFACT: 20194,
  MAX_ARTIFACT: 20195,
  INVALID_ARTIFACT: 20197,
  DUPLICATE_ARTIFACT: 20198,
  SKIP_TEMPLATE: 25600,
  SKIP_RESOURCE: 25601,
});

const diveRows = readGameplayTableRecords("ab_script", "LUA_DIVE_TEMPLET.json", { logLabel: "dive-check" });
const artifactRows = readGameplayTableRecords("ab_script", "LUA_DIVE_ARTIFACT.json", { logLabel: "dive-check" });
const stage = diveRows.find((row) =>
  Number(row.STAGE_ID) > 0 &&
  row.EVENT_DIVE === false &&
  String(row.STAGE_UNLOCK_REQ_TYPE) === "SURT_CLEAR_DIVE" &&
  Number(row.STAGE_LEVEL_SCALE || 0) > 0 &&
  Number(row.SAFE_MINE_REQ_ITEM_ID) > 0 &&
  Number(row.SAFE_MINE_REQ_ITEM_COUNT) > 0
);
assert(stage, "frozen Dive table must expose a normal player-level stage with safe mining");
assert(diveRows.length === 160, "frozen Dive template count drifted");
assert(artifactRows.length === 116, "frozen Dive artifact count drifted");

const handlers = new Map(createWorldMapHandlers().map((entry) => [entry.packetId, entry]));
for (const packetId of [1206, 1208, 1210, 1212, 1215, 1217, 1249]) {
  assert(handlers.has(packetId), `Dive specialist missing packet ${packetId}`);
}

const user = {
  userUid: "986000000000120",
  nickname: "DiveCheck",
  level: 100,
};
ensureArmy(user);
grantUnit(user, 1001, { level: 100 });
grantUnit(user, 21001, { level: 100 });
const diveOperator = grantOperator(user, getPlayableOperatorIds()[0], { level: 100 });
assert(diveOperator, "frozen operator table must expose a Dive operator fixture");
const diveDeck = ensureDefaultLineup(user, { deckType: 8, index: 0 });
assert(diveDeck && toBigInt(diveDeck.shipUid) > 0n && diveDeck.unitUids.some((uid) => toBigInt(uid) > 0n));
assert.strictEqual(diveDeck.operatorUid, diveOperator.uid, "Dive fixture must equip its operator");
grantMiscItem(user, Number(stage.STAGE_REQ_ITEM_ID), 100, 0, { regDate: String(FIXED_NOW) });
ensureWorldMapState(user, { now: FIXED_NOW });
const unlockStageID = Number(stage.STAGE_UNLOCK_REQ_VALUE);
user.worldMap.diveClearStages = [unlockStageID];

const socket = { session: { user } };
let response = null;
let pushes = [];
let saves = 0;
let invalidations = 0;
const managedWire = [];
let managedDiveBattle = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => FIXED_NOW,
  decryptCopy: (payload) => payload,
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_socket, _sequence, _packetId, build) {
    build();
  },
  sendServerGamePacket(_socket, packetId, payload) {
    pushes.push({ packetId, payload });
    managedWire.push([packetId, payload]);
  },
  saveUserDb() {
    saves += 1;
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.match(reason, /^dive-\d+$/);
    invalidations += 1;
  },
  trackMissionEvent() {
    return false;
  },
};

verifyStrictFraming();
verifyStartMoveGiveUp();
verifyAutoMode();
verifyArtifacts();
verifySuicide();
verifySkip();
verifyExpiry();
verifyBattleLifecycle();
verifyRestart();
validateFrozenSources();
validateManagedSchemas();

console.log(
  `[dive-check] PASS stages=${diveRows.length} artifacts=${artifactRows.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  for (const [packetId, payload] of [
    [1206, Buffer.alloc(0)],
    [1206, Buffer.concat([startReq([0]), Buffer.from([0])])],
    [1208, Buffer.alloc(0)],
    [1210, Buffer.from([0])],
    [1212, Buffer.from([2])],
    [1215, Buffer.alloc(0)],
    [1217, Buffer.from([0, 0])],
    [1249, Buffer.alloc(0)],
    [1249, skipReq(Number(stage.STAGE_ID), 0, 0)],
  ]) expectPureError(packetId, payload, ERRORS.INVALID_REQUEST);
  assertWrites(0);
}

function verifyStartMoveGiveUp() {
  expectPureError(1206, startReq([0], 999999), ERRORS.INVALID_STAGE);
  const beforePermit = miscCount(Number(stage.STAGE_REQ_ITEM_ID));
  send(1206, startReq([0]));
  assertError(ERRORS.OK);
  assert(activeDive(), "successful Dive start must persist active game data");
  assert.strictEqual(activeDive().cityID, 0, "normal Dive must preserve cityID=0");
  assert.strictEqual(currentDiveDeck().state, 3, "selected Dive deck must be marked DIVE");
  assert.strictEqual(miscCount(Number(stage.STAGE_REQ_ITEM_ID)), beforePermit, "normal non-jump Dive start without a city is free");
  assertWrites(1);

  expectPureError(1206, startReq([0]), 316);
  expectPureError(1208, writeSignedVarInt(99), ERRORS.CANNOT_MOVE);
  send(1208, writeSignedVarInt(0));
  assertError(ERRORS.OK);
  assert.strictEqual(activeDive().player.base.distance, 1);
  assertWrites(2);

  activeDive().player.base.state = 2;
  expectPureError(1210, Buffer.alloc(0), ERRORS.CANNOT_GIVE_UP);
  activeDive().player.base.state = 1;
  send(1210, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assert.strictEqual(activeDive(), null);
  assert.strictEqual(currentDiveDeck().state, 0, "Dive give-up must release deck state");
  assertWrites(3);
}

function verifyAutoMode() {
  send(1212, writeBool(true));
  assertError(ERRORS.OK);
  assert.strictEqual(user.worldMap.dive.isAuto, true);
  assertWrites(4);
  send(1212, writeBool(true));
  assertError(ERRORS.OK);
  assertWrites(4);
  send(1212, writeBool(false));
  assertError(ERRORS.OK);
  assert.strictEqual(user.worldMap.dive.isAuto, false);
  assertWrites(5);
  assert.match(read("server", "listener.js"), /worldMap\.dive\.isAuto\)\), \/\/ m_bAutoDive/);
}

function verifyArtifacts() {
  send(1206, startReq([0]));
  assertError(ERRORS.OK);
  assertWrites(6);
  const base = activeDive().player.base;
  base.state = 4;
  base.reservedArtifacts = [1, 2, 3];
  expectPureError(1215, writeSignedVarInt(999999), ERRORS.INVALID_ARTIFACT);
  send(1215, writeSignedVarInt(1));
  assertError(ERRORS.OK);
  assert.deepStrictEqual(activeDive().player.base.artifacts, [1]);
  assertWrites(7);

  activeDive().player.base.state = 4;
  activeDive().player.base.reservedArtifacts = [1];
  expectPureError(1215, writeSignedVarInt(1), ERRORS.DUPLICATE_ARTIFACT);
  activeDive().player.base.artifacts = artifactRows.slice(0, 50).map((row) => Number(row.m_ArtifactID));
  activeDive().player.base.reservedArtifacts = [Number(artifactRows[50].m_ArtifactID)];
  expectPureError(1215, writeSignedVarInt(Number(artifactRows[50].m_ArtifactID)), ERRORS.MAX_ARTIFACT);

  activeDive().player.base.artifacts = [1];
  activeDive().player.base.reservedArtifacts = [2];
  send(1215, writeSignedVarInt(0));
  assertError(ERRORS.OK);
  assert.deepStrictEqual(activeDive().player.base.artifacts, [1]);
  assertWrites(8);
}

function verifySuicide() {
  activeDive().player.base.state = 0;
  expectPureError(1217, writeByte(0), ERRORS.NOT_READY);
  activeDive().player.base.state = 1;
  expectPureError(1217, writeByte(9), ERRORS.SQUAD_MISSING);
  activeDive().player.squads["0"].state = 1;
  activeDive().player.squads["0"].curHp = 0;
  expectPureError(1217, writeByte(0), ERRORS.SQUAD_DEAD);
  activeDive().player.squads["0"].state = 0;
  activeDive().player.squads["0"].curHp = 100000;
  send(1217, writeByte(0));
  assertError(ERRORS.OK);
  assert.strictEqual(activeDive(), null, "last-squad suicide must annihilate and clear active Dive");
  assert.strictEqual(currentDiveDeck().state, 0);
  assertWrites(9);
}

function verifySkip() {
  const stageID = Number(stage.STAGE_ID);
  expectPureError(1249, skipReq(stageID, 1, 0), ERRORS.NOT_CLEARED);
  expectPureError(1249, skipReq(999999, 1, 0), ERRORS.SKIP_TEMPLATE);
  user.worldMap.diveClearStages = [unlockStageID, stageID];
  const permitId = Number(stage.SAFE_MINE_REQ_ITEM_ID);
  const before = miscCount(permitId);
  send(1249, skipReq(stageID, 2, 0));
  assertError(ERRORS.OK);
  assert.strictEqual(before - miscCount(permitId), BigInt(Number(stage.SAFE_MINE_REQ_ITEM_COUNT) * 2));
  assert(user.worldMap.diveHistoryStages.includes(stageID));
  assertWrites(10);

  setMiscItemBalance(user, permitId, 0, 0, { regDate: String(FIXED_NOW) });
  expectPureError(1249, skipReq(stageID, 1, 0), ERRORS.SKIP_RESOURCE);
  grantMiscItem(user, permitId, 10, 0, { regDate: String(FIXED_NOW) });
}

function verifyExpiry() {
  send(1206, startReq([0]));
  assertError(ERRORS.OK);
  assertWrites(11);
  activeDive().floor.expireDate = String(FIXED_NOW - 1n);
  send(1208, writeSignedVarInt(0));
  assertError(ERRORS.NOT_STARTED);
  assert.strictEqual(activeDive(), null);
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].packetId, 1214);
  assert.strictEqual(readSignedVarInt(pushes[0].payload, 0).value, Number(stage.STAGE_ID));
  assertWrites(12);
}

function verifyBattleLifecycle() {
  const stageID = Number(stage.STAGE_ID);
  user.worldMap.diveClearStages = [unlockStageID];
  const rewardBefore = miscCount(Number(stage.FIRSTREWARD_ID_1));
  send(1206, startReq([0]));
  assertError(ERRORS.OK);
  assertWrites(13);

  for (let step = 0; step < Number(stage.RANDOM_SET_COUNT) + 1; step += 1) {
    send(1208, writeSignedVarInt(0));
    assertError(ERRORS.OK);
    assertWrites(14 + step);
    const prepared = prepareDiveGameLoad(user, { selectDeckIndex: 0 }, { now: FIXED_NOW });
    assert(prepared && prepared.dungeonID > 0, "each selected Dive battle sector must resolve a real dungeon");
    const expectedLevelAdd = Number(stage.STAGE_LEVEL_SCALE) +
      (Number(prepared.selectedSlot && prepared.selectedSlot.eventType) === 2 ? Number(stage.SET_LEVEL_SCALE) : 0);
    assert.strictEqual(prepared.teamBLevelAdd, expectedLevelAdd, "Dive battle must apply frozen stage and boss-set level scaling");
    managedDiveBattle = {
      diveStageID: prepared.diveStageID,
      dungeonID: prepared.dungeonID,
      teamBLevelAdd: prepared.teamBLevelAdd,
      playerDeck: buildPlayerDeckForGameLoad(user, { selectDeckIndex: 0 }, { deckIndex: { deckType: 8, index: 0 }, strictSelection: true }),
    };
    assert(managedDiveBattle.playerDeck && managedDiveBattle.playerDeck.units.length > 0, "Dive managed check needs its real squad deck");
    assert.strictEqual(managedDiveBattle.playerDeck.operatorUid, diveOperator.uid, "Dive managed deck must preserve its operator UID");
    const result = completeDiveBattle(user, { diveStageID: stageID, deckIndex: 0 }, { win: true }, { win: true, now: FIXED_NOW });
    assert(result, "managed Dive battle completion must resolve the active run");
    assert.strictEqual(result.cleared, step === Number(stage.RANDOM_SET_COUNT));
  }

  assert.strictEqual(activeDive(), null, "boss victory must clear the active Dive");
  assert.strictEqual(currentDiveDeck().state, 0, "terminal Dive completion must release the deck");
  assert(user.worldMap.diveClearStages.includes(stageID));
  assert(user.worldMap.diveHistoryStages.includes(stageID));
  assert.strictEqual(
    miscCount(Number(stage.FIRSTREWARD_ID_1)) - rewardBefore,
    BigInt(Number(stage.FIRSTREWARD_QUANTITY_1)),
    "first terminal clear must grant the exact frozen reward"
  );
}

function verifyRestart() {
  const restarted = snapshot(user);
  assert.strictEqual(restarted.worldMap.dive.active, null);
  assert.strictEqual(restarted.worldMap.dive.isAuto, false);
  assert(restarted.worldMap.diveClearStages.includes(Number(stage.STAGE_ID)));
  assert(restarted.worldMap.diveHistoryStages.includes(Number(stage.STAGE_ID)));
}

function send(packetId, payload, validateRequest = true) {
  response = null;
  pushes = [];
  if (validateRequest) managedWire.push([packetId, payload]);
  const handler = handlers.get(packetId);
  assert(handler, `missing Dive handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `Dive packet ${packetId} must respond`);
  return response;
}

function expectPureError(packetId, payload, errorCode) {
  const before = snapshot(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  send(packetId, payload, false);
  assertError(errorCode);
  assert.deepStrictEqual(user, before, `failed Dive packet ${packetId} mutated state`);
  assert.strictEqual(saves, beforeSaves, `failed Dive packet ${packetId} saved state`);
  assert.strictEqual(invalidations, beforeInvalidations, `failed Dive packet ${packetId} invalidated JOIN`);
  assert.strictEqual(pushes.length, 0, `failed Dive packet ${packetId} emitted a push`);
  managedWire.push([response.packetId, response.payload]);
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function startReq(deckIndexes, stageID = Number(stage.STAGE_ID)) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(stageID),
    writeIntList(deckIndexes),
    writeBool(false),
  ]);
}

function skipReq(stageID, count, cityID) {
  return Buffer.concat([writeSignedVarInt(stageID), writeSignedVarInt(count), writeSignedVarInt(cityID)]);
}

function activeDive() {
  return user.worldMap && user.worldMap.dive && user.worldMap.dive.active || null;
}

function currentDiveDeck() {
  return user.army.deckSets["8"][0];
}

function miscCount(itemId) {
  const item = getMiscItem(user, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateFrozenSources() {
  assert.match(read("Assembly-CSharp", "NKM", "NKMDiveGameManager.cs"), /CanStart[\s\S]*CanMoveForward[\s\S]*CanGiveUp/);
  assert.match(read("Assembly-CSharp", "NKC", "NKCDiveManager.cs"), /CanStart[\s\S]*GetDiveCost/);
  assert.match(read("Assembly-CSharp", "NKC", "NKCPacketSender.cs"), /Send_NKMPacket_DIVE_START_REQ[\s\S]*Send_NKMPacket_DIVE_SKIP_REQ/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected Dive packet ${packetId}: ${result.error || "unknown error"}`);
    }
    assert(managedDiveBattle, "Dive lifecycle must capture a managed battle fixture");
    let state = host.request("startBattle", {
      req: {
        stageID: managedDiveBattle.diveStageID,
        dungeonID: managedDiveBattle.dungeonID,
        gameType: 5,
      },
      stage: {
        stageId: managedDiveBattle.diveStageID,
        dungeonID: managedDiveBattle.dungeonID,
        gameType: 5,
        miscMode: "dive",
        teamBLevelAdd: managedDiveBattle.teamBLevelAdd,
        playerDeck: managedDiveBattle.playerDeck,
      },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat && state.payload, state.error || "managed Dive battle did not start");
    const loadValidation = host.request("validatePacket", { packetId: 804, payloadBase64: state.payload.toString("base64") });
    assert(loadValidation.ok, loadValidation.error || "managed Dive GAME_LOAD_ACK failed schema validation");
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: state.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "managed Dive GAME_LOAD_ACK inspection failed");
    assert.match(inspected.summary || "", /gameType=NGT_DIVE/);
    assert.match(inspected.summary || "", new RegExp(`teamBLevelAdd=${managedDiveBattle.teamBLevelAdd}`));
    assert.match(
      inspected.summary || "",
      new RegExp(`operator=${managedDiveBattle.playerDeck.operatorId}:${managedDiveBattle.playerDeck.operatorUid}`),
      "managed Dive team must instantiate the selected operator"
    );
    const initial = host.request("buildInitialSync", { dynamicGame: state.dynamicGame, battleState: state.battleState });
    assert(initial.ok, initial.error || "managed Dive initial sync failed");
    state = {
      ...state,
      dynamicGame: initial.dynamicGame || state.dynamicGame,
      battleState: initial.battleState || state.battleState,
    };
    const timeline = host.request("buildTimeline", {
      dynamicGame: state.dynamicGame,
      battleState: state.battleState,
      delta: 1 / 30,
      maxFrames: 90,
      startIndex: 0,
    });
    assert(timeline.ok, timeline.error || "managed Dive combat timeline failed");
    host.request("disposeBattle", {
      dynamicGame: timeline.dynamicGame || state.dynamicGame,
      battleState: timeline.battleState || state.battleState,
    });
  } finally {
    host.close();
  }
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
