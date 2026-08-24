"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ensureArmy } = require("../modules/unit");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

process.env.CS_LISTENER_TEST_MODE = "1";
process.env.CS_USE_LOCAL_USER_DB = "0";
const { createPacketContext } = require("../server/listener");

const rootDir = path.resolve(__dirname, "..");
const ctx = createPacketContext();
const user = makeUser();
const lossReplay = makeReplay("8110001");
const loss = ctx.buildDynamicGameEndNotPayload(lossReplay, {
  user,
  win: false,
  managedBattleWin: false,
  managedBattlePlayTime: 13.5,
  managedBattleRecords: battleRecords(),
});
assert(Buffer.isBuffer(loss) && loss.length > 0);
assert.deepStrictEqual([...loss.subarray(0, 3)], [0, 0, 0], "loss must preserve exact win/giveup/restart booleans");
assert.strictEqual(lossReplay.lastDynamicGameEndResult.win, false);
assert.strictEqual(lossReplay.lastDynamicGameEndResult.battleState.gameTime, 13.5);

const winReplay = makeReplay("8110002");
const win = ctx.buildDynamicGameEndNotPayload(winReplay, {
  user,
  win: true,
  managedBattleWin: true,
  managedBattlePlayTime: 21.25,
  managedBattleRecords: battleRecords(),
});
assert(Buffer.isBuffer(win) && win.length > 0);
assert.deepStrictEqual([...win.subarray(0, 3)], [1, 0, 0], "win must preserve exact win/giveup/restart booleans");
const afterFirstWin = JSON.stringify(user);
const duplicate = ctx.buildDynamicGameEndNotPayload(winReplay, {
  user,
  win: true,
  managedBattleWin: true,
  managedBattlePlayTime: 21.25,
  managedBattleRecords: battleRecords(),
});
assert.strictEqual(JSON.stringify(user), afterFirstWin, "duplicate terminal serialization must not grant again");

const giveupReplay = makeReplay("8110003");
const giveup = ctx.buildDynamicGameEndNotPayload(giveupReplay, { user, win: false, giveup: true, managedBattlePlayTime: 5 });
assert.deepStrictEqual([...giveup.subarray(0, 3)], [0, 1, 0]);
const restartReplay = makeReplay("8110004");
const restart = ctx.buildDynamicGameEndNotPayload(restartReplay, { user, win: false, restart: true, managedBattlePlayTime: 5 });
assert.deepStrictEqual([...restart.subarray(0, 3)], [0, 0, 1]);

assertFrozenSources();
validateManagedSchemas([loss, win, duplicate, giveup, restart]);
console.log(`[game-end-check] PASS payloads=5 winBytes=${win.length} duplicateGrant=0 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser() {
  const value = {
    userUid: "811001",
    friendCode: "8110001",
    nickname: "GameEnd",
    level: 100,
    exp: 0,
    nextUnitUid: "8110010000",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    collection: { units: [], ships: [], operators: [] },
    dungeonClear: {},
    stagePlayData: {},
  };
  ensureArmy(value);
  return value;
}

function makeReplay(gameUID) {
  return {
    dynamicGame: {
      gameUID,
      stageID: 10111,
      dungeonID: 101,
      gameType: 3,
      rewardMultiply: 1,
      playerDeck: { deckType: 1, deckIndex: 0, leaderIndex: 0, units: [] },
    },
    battleState: {
      gameTime: 1,
      gameState: { state: 4, winTeam: 0, waveId: 1 },
      units: [],
    },
  };
}

function battleRecords() {
  return [
    {
      gameUnitUID: 101,
      unitUid: "8110010101",
      unitId: 1001,
      unitLevel: 100,
      teamType: 1,
      recordGiveDamage: 1200,
      recordTakeDamage: 400,
      recordDieCount: 0,
      recordKillCount: 2,
      playtime: 21.25,
    },
    {
      gameUnitUID: 201,
      unitUid: "8110010201",
      unitId: 1002,
      unitLevel: 100,
      teamType: 3,
      recordGiveDamage: 400,
      recordTakeDamage: 1200,
      recordDieCount: 1,
      recordKillCount: 0,
      playtime: 21.25,
    },
  ];
}

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
      const result = host.request("validatePacket", { packetId: 811, payloadBase64: payload.toString("base64") });
      assert(result.ok, result.error || "managed schema rejected GAME_END_NOT");
    }
  } finally {
    host.close();
  }
}

function assertFrozenSources() {
  const packet = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_END_NOT.cs");
  assert.match(packet, /win[\s\S]*giveup[\s\S]*restart[\s\S]*dungeonClearData[\s\S]*phaseClearData[\s\S]*episodeCompleteData/);
  assert.match(packet, /gameRecord[\s\S]*stagePlayData[\s\S]*shadowGameResult[\s\S]*fierceResultData[\s\S]*phaseModeState/);
  assert.match(packet, /killCountDelta[\s\S]*killCountData[\s\S]*trimModeState[\s\S]*totalPlayTime[\s\S]*explore[\s\S]*exploreSquad/);
  assert.match(source("server", "listener.js"), /normalizeManagedCombatPayload[\s\S]*buildDynamicGameEndNotPayload/);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
