"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const asyncPvp = require("../modules/async-pvp");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { grantMiscItem, getMiscItem } = require("../modules/inventory");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  readSignedVarInt,
  writeBool,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const pvpRank = require("../modules/pvp-rank");
const { buildPlayerDeckForGameLoad, ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const specialist = "modules\\async-pvp\\handlers\\0000-000-async-pvp.js";
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
for (const packetId of [2617, 2669, 2671]) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `packet ${packetId} must use the async-PvP specialist`);
}

const now = new Date("2026-08-20T12:00:00Z");
const attacker = makeUser(1);
const defender = makeUser(2);
pvpRank.setAsyncPvpState(attacker, { seasonId: 37, weekId: 8, score: 6000, maxScore: 6000, leagueTierId: 20, maxLeagueTierId: 20 });
pvpRank.setAsyncPvpState(defender, { seasonId: 37, weekId: 8, score: 6100, maxScore: 6100, leagueTierId: 20, maxLeagueTierId: 20 });
grantMiscItem(attacker, asyncPvp.ASYNC_TICKET_ITEM_ID, 3);
grantMiscItem(defender, asyncPvp.ASYNC_TICKET_ITEM_ID, 3);

const attackerSocket = { destroyed: false, session: { user: attacker } };
const defenderSocket = { destroyed: false, session: { user: defender } };
const responsePackets = [];
const pushPackets = [];
let saves = 0;
let invalidations = 0;
let startCalls = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users: { [attacker.userUid]: attacker, [defender.userUid]: defender } },
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => attacker,
  dateTimeBinaryNow: () => 5250508610427387904n,
  dateTimeTicksNow: () => 639176400000000000n,
  getServerNowDate: () => now,
  getEffectiveOpenTags: () => ["GLOBAL"],
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  trackMissionEvent() {},
  findClientSocketByUserUid(uid) {
    return String(uid) === String(defender.userUid) ? defenderSocket : attackerSocket;
  },
  sendGameResponse(socket, _packet, packetId, payload) { responsePackets.push({ socket, packetId, payload }); },
  sendServerGamePacket(socket, packetId, payload) { pushPackets.push({ socket, packetId, payload }); },
  startAsyncPvpBattle(socket, _user, _target, req) {
    startCalls += 1;
    const replay = { dynamicGame: { gameUID: "2617000000021", gameType: req.gameType } };
    socket.session.gameReplay = replay;
    return {
      ok: true,
      replay,
      gameDataPayload: Buffer.from([1, 2, 3]),
      startAckPayload: Buffer.from([4, 5, 6]),
    };
  },
};

assert.deepStrictEqual(asyncPvp.decodeNpcTargetListRequest(ctx, writeSignedVarInt(0)), { valid: true, targetTier: 0 });
assert.deepStrictEqual(asyncPvp.decodeNpcTargetListRequest(ctx, writeSignedVarInt(9)), { valid: true, targetTier: 9 });
for (const payload of [Buffer.alloc(0), writeSignedVarInt(-1), Buffer.concat([writeSignedVarInt(1), Buffer.from([0])])]) {
  assert.strictEqual(asyncPvp.decodeNpcTargetListRequest(ctx, payload).valid, false);
}

invoke(defenderSocket, 2669, Buffer.alloc(0));
assertAck(2670, 0);
assert.deepStrictEqual(defenderSocket.session.asyncPvpRevengeSession.targets, []);
invoke(defenderSocket, 2669, Buffer.from([0]));
assertAck(2670, asyncPvp.ERRORS.INVALID_REQUEST);
invoke(defenderSocket, 2671, writeSignedVarInt(0));
const emptyNpcAck = assertAck(2672, 0);
invoke(defenderSocket, 2671, Buffer.alloc(0));
assertAck(2672, asyncPvp.ERRORS.INVALID_REQUEST);

const standardTarget = asyncPvp.getAsyncPvpTargets(ctx, attacker).find((entry) => entry.user === defender);
assert(standardTarget, "valid defender must appear in the standard async target list");
const standardReplay = makeReplay(attacker, standardTarget, 20, "2623000000020");
const standardEnd = asyncPvp.buildAsyncPvpGameEndNotPayload(ctx, attackerSocket, standardReplay, { win: true, playTime: 20 });
assert(standardEnd && standardEnd.length > 0);
assert.strictEqual(defender.pvp.revengeTargets.length, 1, "a strategy defence must create one durable revenge opportunity");
assert.strictEqual(defender.pvp.revengeTargets[0].revengeAble, true);
assert.strictEqual(pushPackets.at(-1).packetId, 2673, "the online defender must receive the frozen refresh notification");
assert.strictEqual(pushPackets.at(-1).socket, defenderSocket);
assert.strictEqual(readSignedVarInt(pushPackets.at(-1).payload, 0).value, 0);
assert.strictEqual(pvpRank.getAsyncPvpState(defender).seasonPlayCount, 1);

invoke(defenderSocket, 2669, Buffer.alloc(0));
const revengeAck = assertAck(2670, 0);
assert.strictEqual(defenderSocket.session.asyncPvpRevengeSession.targets.length, 1);
assert.strictEqual(defenderSocket.session.asyncPvpRevengeSession.targets[0].revengeAble, true);

const ticketsBefore = BigInt(getMiscItem(defender, asyncPvp.ASYNC_TICKET_ITEM_ID).countFree);
invoke(defenderSocket, 2617, startRequest(attacker.friendCode, 0, 21, false));
assert.strictEqual(startCalls, 1);
assert.deepStrictEqual(pushPackets.slice(-2).map((entry) => entry.packetId), [2604, 2618]);
assert.strictEqual(BigInt(getMiscItem(defender, asyncPvp.ASYNC_TICKET_ITEM_ID).countFree), ticketsBefore - 1n);
const revengeMeta = defenderSocket.session.gameReplay && defenderSocket.session.gameReplay.asyncPvpBattle;
assert(revengeMeta && revengeMeta.revengeRecordId === defender.pvp.revengeTargets[0].revengeRecordId);

const revengeEnd = asyncPvp.buildAsyncPvpGameEndNotPayload(ctx, defenderSocket, defenderSocket.session.gameReplay, { win: true, playTime: 21 });
assert(revengeEnd && revengeEnd.length > 0);
assert.strictEqual(defender.pvp.revengeTargets[0].revengeAble, false, "a completed revenge may not be claimed twice");
assert.strictEqual(defender.pvp.revengeTargets[0].result, 0);
assert.strictEqual(pushPackets.at(-1).packetId, 2673, "the revenge target must receive the reciprocal state refresh");

const restarted = JSON.parse(JSON.stringify(defender));
const restartedTargets = asyncPvp.getRevengePvpTargets({ userDb: ctx.userDb }, restarted);
assert.strictEqual(restartedTargets.length, 1);
assert.strictEqual(restartedTargets[0].revengeAble, false);
const retrySocket = { destroyed: false, session: { user: restarted } };
asyncPvp.refreshRevengeTargetSession(ctx, retrySocket, restarted);
const retry = asyncPvp.prepareAsyncPvpStart(ctx, retrySocket, restarted, {
  valid: true,
  targetFriendCode: BigInt(attacker.friendCode),
  selectDeckIndex: 0,
  gameType: 21,
  simulationGame: false,
});
assert.deepStrictEqual(retry, { ok: false, errorCode: asyncPvp.ERRORS.REVENGE_ALREADY });
assert.strictEqual(saves, 3, "standard result, revenge start, and revenge result must each save once");
assert.strictEqual(invalidations, 3);

assertFrozenEvidence();
const managed = validateManagedSchemas(attacker, defender, revengeAck, emptyNpcAck, pushPackets.find((entry) => entry.packetId === 2673).payload);
console.log(`[async-pvp-opponents-check] PASS revenge=1 npcRows=0 saves=${saves} packets=${managed.packets} managed=on`);

function invoke(socket, packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, errorCode) {
  const response = responsePackets.pop();
  assert(response, `missing ACK ${packetId}`);
  assert.strictEqual(response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, errorCode);
  return response.payload;
}

function startRequest(friendCode, deckIndex, gameType, simulationGame) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(friendCode)),
    writeByte(deckIndex),
    writeByte(gameType),
    writeBool(simulationGame),
  ]);
}

function makeReplay(user, target, gameType, gameUid) {
  return {
    dynamicGame: { gameUID: gameUid, gameType },
    battleState: { gameTime: 20, units: [] },
    asyncPvpBattle: {
      gameUid,
      targetFriendCode: target.friendCode,
      targetUserUid: target.user.userUid,
      targetSnapshot: {
        friendCode: target.friendCode,
        rank: target.rank,
        score: target.score,
        tier: target.tier,
        operationPower: target.operationPower,
        mainUnitId: target.mainUnitId,
        mainUnitSkinId: target.mainUnitSkinId,
        mainUnitTacticLevel: target.mainUnitTacticLevel,
        userUid: target.user.userUid,
      },
      targetList: [target],
      selectDeckIndex: 0,
      gameType,
      simulationGame: false,
      costItem: getMiscItem(user, asyncPvp.ASYNC_TICKET_ITEM_ID),
      resultRecorded: false,
    },
  };
}

function makeUser(index) {
  const value = {
    userUid: String(2669000 + index),
    friendCode: String(26690000 + index),
    nickname: `AsyncOpponent${index}`,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2669000000000n + BigInt(index) * 100n),
  };
  ensureArmy(value);
  const units = uniqueBaseUnitIds(8).map((unitId) => grantUnit(value, unitId, { level: 100 }));
  const ship = grantUnit(value, getPlayableShipIds()[index % getPlayableShipIds().length], { level: 100 });
  const operator = grantOperator(value, getPlayableOperatorIds()[index % getPlayableOperatorIds().length], { level: 100 });
  for (const deckType of [2, 6]) {
    const deck = ensureDeck(value, { deckType, index: 0 });
    deck.unitUids = units.map((unit) => unit.unitUid);
    deck.shipUid = ship.unitUid;
    deck.operatorUid = operator.uid;
    deck.leaderIndex = 0;
    deck.state = 0;
    deck.operationPower = 800000 + index * 1000;
  }
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

function validateManagedSchemas(userA, userB, revengeAck, npcAck, refreshPayload) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for async opponent validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  let packets = 0;
  const started = [];
  try {
    for (const [packetId, payload] of [
      [2669, Buffer.alloc(0)],
      [2670, revengeAck],
      [2671, writeSignedVarInt(0)],
      [2672, npcAck],
      [2673, refreshPayload],
      [2617, startRequest(userA.friendCode, 0, 21, false)],
    ]) {
      validatePacket(host, packetId, payload);
      packets += 1;
    }
    const playerDeck = buildPlayerDeckForGameLoad(userA, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 2, index: 0 }, strictSelection: true,
    });
    const playerDeckB = buildPlayerDeckForGameLoad(userB, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 6, index: 0 }, strictSelection: true,
    });
    for (const [gameType, expected] of [[21, "NGT_PVP_STRATEGY_REVENGE"], [22, "NGT_PVP_STRATEGY_NPC"]]) {
      const battle = host.request("startBattle", {
        req: { stageID: 0, dungeonID: 0, gameType, selectDeckIndex: 0 },
        stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType, playerDeck, playerDeckB },
        gameUID: String(2617000000000n + BigInt(gameType)),
        gameLoadAckPayloadBase64: "",
      });
      assert(battle.ok && battle.dynamicGame && battle.dynamicGame.managedCombat, battle.error || `gameType ${gameType} start failed`);
      started.push(battle);
      const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: battle.payload.toString("base64") });
      assert(inspected.ok, inspected.error || `gameType ${gameType} inspection failed`);
      assert.match(inspected.summary || "", new RegExp(`gameType=${expected}`));
      if (gameType === 21) {
        const targetListPayload = asyncPvp.buildTargetListAckPayload({
          errorCode: 0,
          targets: asyncPvp.getAsyncPvpTargets({ userDb: { users: { [userA.userUid]: userA, [userB.userUid]: userB } } }, userA),
        });
        const ack = host.request("buildAsyncPvpStartAck", {
          dynamicGame: battle.dynamicGame,
          battleState: battle.battleState,
          targetListAckPayloadBase64: targetListPayload.toString("base64"),
          targetFriendCode: userB.friendCode,
          simulationGame: false,
        });
        assert(ack.ok && ack.payload, ack.error || "revenge start ACK build failed");
        validatePacket(host, 2618, ack.payload);
        packets += 1;
      }
    }
    return { packets };
  } finally {
    for (const battle of started) host.request("disposeBattle", { dynamicGame: battle.dynamicGame, battleState: battle.battleState });
    host.close();
  }
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
  assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
}

function assertFrozenEvidence() {
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_REVENGE_PVP_TARGET_LIST_REQ.cs"), /Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "RevengePvpTarget.cs"), /revengeAble[\s\S]*result[\s\S]*asyncDeck[\s\S]*guildData/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_NPC_PVP_TARGET_LIST_REQ.cs"), /targetTier/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NpcPvpTarget.cs"), /userLevel[\s\S]*userFriendCode[\s\S]*score[\s\S]*tier[\s\S]*asyncDeck[\s\S]*isOpened/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_STRATEGY_PVP_REFRESH_NOT.cs"), /errorCode[\s\S]*data/);
  assert.match(source("Assembly-CSharp", "NKM", "Templet", "NKMPvpNpcBotTemplet.cs"), /m_GainBaseScore[\s\S]*SLOT_UNIT_ID_SHIP[\s\S]*SLOT_UNIT_LIMIT_/);
  for (const base of ["StreamingAssets", "Assetbundles"]) {
    const table = path.join(rootDir, "gameplay-jsons", base, "ab_script", "luac", "LUA_PVP_NPC_BOT.json");
    assert.strictEqual(fs.existsSync(table), false, "the frozen client package must not be treated as containing server-only NPC bot rows");
  }
  assert.match(source("combat-host", "ManagedCombatBridge.cs"), /21\s*=>\s*"NGT_PVP_STRATEGY_REVENGE"[\s\S]*22\s*=>\s*"NGT_PVP_STRATEGY_NPC"/);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
