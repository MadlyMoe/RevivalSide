"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  ERRORS,
  NDT_PVP,
  NGT_PVP_RANK,
  PACKETS,
  createPvpMatchmaker,
  decodeEmptyRequest,
  decodeMatchRequest,
} = require("../modules/pvp-matchmaking");
const {
  buildDeckIndexData,
  readSignedVarInt,
  writeBool,
  writeFloatLE,
  writeInt64LE,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { buildPlayerDeckForGameLoad, ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const pvpRank = require("../modules/pvp-rank");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const decryptCtx = { decryptCopy: (payload) => payload };
const specialist = "modules\\pvp-matchmaking\\handlers\\0000-000-pvp-matchmaking.js";
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);

assert.strictEqual(handlers.get(PACKETS.MATCH_REQ).fileName, specialist);
assert.strictEqual(handlers.get(PACKETS.CANCEL_REQ).fileName, specialist);
assert.deepStrictEqual(ERRORS, {
  OK: 0,
  ALREADY_BEGIN: 106,
  ALREADY_MATCHING: 107,
  INVALID_MATCH_TYPE: 108,
  CANCEL_FAIL: 109,
  INVALID_REQUEST: 20191,
});
assert.strictEqual(NGT_PVP_RANK, 6);
assert.strictEqual(NDT_PVP, 2);

assert.deepStrictEqual(decodeMatchRequest(decryptCtx, matchRequest(3, 6, true)), {
  valid: true,
  selectDeckIndex: 3,
  gameType: 6,
  usingBot: true,
});
for (const payload of [
  Buffer.alloc(0),
  Buffer.from([0, 6]),
  Buffer.from([0, 6, 2]),
  Buffer.from([0, 6, 0, 0]),
]) {
  assert.strictEqual(decodeMatchRequest(decryptCtx, payload).valid, false, "malformed match request must fail");
}
assert.strictEqual(decodeEmptyRequest(decryptCtx, Buffer.alloc(0)), true);
assert.strictEqual(decodeEmptyRequest(decryptCtx, Buffer.from([0])), false);

const users = [makeUser(1), makeUser(2), makeUser(3), makeUser(4), makeUser(5)];
const sockets = users.map(fakeSocket);
const manager = createPvpMatchmaker();
const validReq = { valid: true, selectDeckIndex: 0, gameType: 6, usingBot: false };

assert.strictEqual(manager.request(sockets[0], users[0], { ...validReq, gameType: 3 }).errorCode, ERRORS.INVALID_MATCH_TYPE);
assert.strictEqual(manager.request(sockets[0], users[0], { ...validReq, valid: false }).errorCode, ERRORS.INVALID_REQUEST);
assert.strictEqual(manager.request(sockets[0], users[0], validReq).errorCode, ERRORS.OK);
assert.strictEqual(manager.waiting.length, 1);
assert.strictEqual(manager.request(sockets[0], users[0], validReq).errorCode, ERRORS.ALREADY_MATCHING);
assert.strictEqual(manager.cancel(sockets[0]).errorCode, ERRORS.OK);
assert.strictEqual(manager.cancel(sockets[0]).errorCode, ERRORS.CANCEL_FAIL);

const first = manager.request(sockets[1], users[1], validReq);
const second = manager.request(sockets[2], users[2], validReq);
assert.strictEqual(first.match, null);
assert(second.match && second.match.members.length === 2, "second human request must pair the waiting player");
assert.strictEqual(manager.complete(second.match), true);
assert.strictEqual(manager.tickets.size, 0, "completed match tickets must leave the waiting registry");

const bot = manager.request(sockets[3], users[3], { ...validReq, usingBot: true });
assert(bot.match && bot.match.bot && bot.match.members.length === 1);
bot.match.members.push({ socket: null, user: users[4], ticket: null, teamType: 3, bot: true });
assert.strictEqual(manager.complete(bot.match), true, "bot completion must tolerate its synthetic member");
const failedBot = manager.request(sockets[4], users[4], { ...validReq, usingBot: true });
failedBot.match.members.push({ socket: null, user: users[0], ticket: null, teamType: 3, bot: true });
assert.strictEqual(manager.fail(failedBot.match), true, "bot failure must tolerate its synthetic member");

sockets[0].session.gameReplay = { dynamicGame: { gameType: 6 }, dynamicBattleResultSent: false };
assert.strictEqual(manager.request(sockets[0], users[0], validReq).errorCode, ERRORS.ALREADY_BEGIN);

validateHandlerWire(users[0]);
assertFrozenSources();
const managed = validateManagedSchemas(users[1], users[2]);
console.log(`[pvp-matchmaking-check] PASS queues=2 packets=${managed.packets} managed=on gameLoadBytes=${managed.gameLoadBytes}`);

function validateHandlerWire(user) {
  const socket = fakeSocket(user);
  const localManager = createPvpMatchmaker();
  const sent = [];
  let starts = 0;
  const ctx = {
    ...decryptCtx,
    pvpMatchmaking: localManager,
    createEphemeralUser: () => user,
    sendGameResponse(_socket, _packet, packetId, payload) { sent.push({ packetId, payload }); },
    startStandardPvpMatch(match) { starts += 1; localManager.complete(match); },
  };
  const matchHandler = handlers.get(PACKETS.MATCH_REQ);
  const cancelHandler = handlers.get(PACKETS.CANCEL_REQ);
  assert.strictEqual(matchHandler.handle(ctx, socket, { packetId: 2600, sequence: 1, payload: matchRequest(0, 6, false) }), true);
  assertAck(sent.pop(), PACKETS.MATCH_ACK, ERRORS.OK);
  assert.strictEqual(starts, 0, "a lone human must remain queued");
  assert.strictEqual(cancelHandler.handle(ctx, socket, { packetId: 2602, sequence: 2, payload: Buffer.alloc(0) }), true);
  assertAck(sent.pop(), PACKETS.CANCEL_ACK, ERRORS.OK);
  assert.strictEqual(matchHandler.handle(ctx, socket, { packetId: 2600, sequence: 3, payload: matchRequest(0, 6, true) }), true);
  assertAck(sent.pop(), PACKETS.MATCH_ACK, ERRORS.OK);
  assert.strictEqual(starts, 1, "bot matchmaking must start after its success ACK");
}

function validateManagedSchemas(userA, userB) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for PvP matchmaking validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    openTags: ["UNIT_REACTOR", "PVP_BAN_UPDATE", "PVP_OPR_BAN"],
    timeoutMs: 30000,
  });
  let started = null;
  let packets = 0;
  try {
    for (const [packetId, payload] of [
      [2600, matchRequest(0, 6, false)],
      [2601, writeSignedVarInt(0)],
      [2602, Buffer.alloc(0)],
      [2603, writeSignedVarInt(0)],
      [2605, writeSignedVarInt(95)],
    ]) {
      validatePacket(host, packetId, payload);
      packets += 1;
    }

    const playerDeck = buildPlayerDeckForGameLoad(userA, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 2, index: 0 }, strictSelection: true,
    });
    const playerDeckB = buildPlayerDeckForGameLoad(userB, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 2, index: 0 }, strictSelection: true,
    });
    assert(playerDeck && playerDeckB, "both ranked players need a serializable PvP deck");
    playerDeck.units[0].reactorLevel = 2;
    const unitBanId = playerDeck.units[0].unitId;
    const unitUpId = playerDeck.units[1].unitId;
    const operatorBanId = playerDeck.operatorId;
    const shipGroupId = Number(getUnitTemplet(playerDeck.shipUnitId).m_ShipGroupID || 0);
    assert(shipGroupId > 0 && operatorBanId > 0, "ranked modifier check needs ship and operator identities");
    started = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 6, selectDeckIndex: 0 },
      stage: {
        stageId: 0,
        dungeonID: 0,
        mapID: 1002,
        gameType: 6,
        gameStatRateId: "PVP_STAT_DEFAULT",
        unitBans: [{ unitId: unitBanId, banLevel: 1 }],
        shipBans: [{ shipGroupId, banLevel: 1 }],
        operatorBans: [{ operatorId: operatorBanId, banLevel: 1 }],
        unitUps: [{ unitId: unitUpId, upLevel: 1 }],
        playerDeck,
        playerDeckB,
      },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(started.ok && started.dynamicGame && started.dynamicGame.managedCombat, started.error || "ranked CombatHost start failed");
    const error = readSignedVarInt(started.payload, 0);
    assert.strictEqual(error.value, 0);
    const gameData = started.payload.subarray(error.offset, started.payload.length - 1);
    validatePacket(host, 2604, gameData);
    packets += 1;
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: started.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "ranked GAME_LOAD_ACK inspection failed");
    assert.match(inspected.summary || "", /gameType=NGT_PVP_RANK/);
    assert.match(inspected.summary || "", /statRate=PVP_STAT_DEFAULT:loaded/, "ranked combat must load its game-stat-rate templet");
    assert.match(inspected.summary || "", new RegExp(`unitBans=1\\[${unitBanId}\\]`), "ranked combat must hydrate unit bans");
    assert.match(
      inspected.summary || "",
      new RegExp(`${unitBanId}:${playerDeck.units[0].unitUid}[^;]*reactor=1:`),
      "ranked combat must apply the native unit-ban reactor penalty before GAME_LOAD"
    );
    assert.match(inspected.summary || "", new RegExp(`shipBans=1\\[${shipGroupId}\\]`), "ranked combat must hydrate ship bans");
    assert.match(inspected.summary || "", new RegExp(`operatorBans=1\\[${operatorBanId}\\]`), "ranked combat must hydrate operator bans");
    assert.match(inspected.summary || "", new RegExp(`unitUps=1\\[${unitUpId}\\]`), "ranked combat must hydrate unit up modifiers");
    assert.match(inspected.summary || "", new RegExp(`teamB=.*user=${userB.userUid}`));
    const initial = host.request("buildInitialSync", { dynamicGame: started.dynamicGame, battleState: started.battleState });
    assert(initial.ok, initial.error || "ranked initial combat sync failed");
    const initialIds = (initial.packets || []).map((entry) => Number(entry.packetId));
    assert(initialIds.includes(808) && initialIds.includes(809), "ranked initial sync must include load-complete and game-start");
    validatePacket(host, 811, standardPvpGameEnd(userA));
    packets += 1;
    return { packets, gameLoadBytes: started.payload.length };
  } finally {
    if (started && started.dynamicGame) host.request("disposeBattle", { dynamicGame: started.dynamicGame, battleState: started.battleState });
    host.close();
  }
}

function standardPvpGameEnd(user) {
  const result = Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(pvpRank.buildPvpStateData(pvpRank.getPvpRankState(user))),
    writeNullObject(),
    writeNullObject(),
    writeInt64LE(638912880000000000n),
    writeBool(true),
    writeBool(false),
    writeObjectList([]),
  ]);
  return Buffer.concat([
    writeBool(true), writeBool(false), writeBool(false),
    writeNullObject(), writeNullObject(), writeNullObject(),
    writeNullableObject(buildDeckIndexData({ deckType: 2, index: 0 })),
    writeNullObject(), writeNullableObject(result), writeNullObject(), writeNullObject(), writeNullObject(),
    writeObjectList([]), writeObjectList([]), writeNullObject(), writeNullObject(), writeNullObject(), writeNullObject(),
    writeSignedVarLong(0n), writeNullObject(), writeNullObject(), writeFloatLE(30), writeNullObject(), writeNullObject(), writeSignedVarInt(0),
  ]);
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
  assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
}

function assertFrozenSources() {
  const request = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_PVP_GAME_MATCH_REQ.cs");
  const ack = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_PVP_GAME_MATCH_ACK.cs");
  const cancel = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_PVP_GAME_MATCH_CANCEL_REQ.cs");
  const complete = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_PVP_GAME_MATCH_COMPLETE_NOT.cs");
  const fail = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_PVP_GAME_MATCH_FAIL_NOT.cs");
  const sender = source("Assembly-CSharp", "NKC", "UI", "Gauntlet", "NKCUIGauntletMatch.cs");
  const receiver = source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  const gameTypes = source("Assembly-CSharp", "NKM", "NKM_GAME_TYPE.cs");
  const deckTypes = source("Assembly-CSharp", "NKM", "NKM_DECK_TYPE.cs");
  assert.match(request, /selectDeckIndex[\s\S]*gameType[\s\S]*usingBot/);
  assert.match(ack, /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)/);
  assert.match(cancel, /void ISerializable\.Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  assert.match(complete, /PutOrGet<NKMGameData>\(ref this\.gameData\)/);
  assert.match(fail, /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)/);
  assert.match(sender, /selectDeckIndex = NKCUIGauntletMatch\.m_sSelectDeckIndex[\s\S]*gameType = eNKM_GAME_TYPE[\s\S]*usingBot/);
  assert.match(receiver, /OnRecv\(NKMPacket_PVP_GAME_MATCH_COMPLETE_NOT[\s\S]*SetGameDataDummy/);
  assert.match(gameTypes, /NGT_DIVE,[\s\S]*NGT_PVP_RANK,/);
  assert.match(deckTypes, /NDT_NORMAL,[\s\S]*NDT_PVP,[\s\S]*NDT_DAILY,/);
  assert.match(source("combat-host", "ManagedCombatBridge.cs"), /6\s*=>\s*"NGT_PVP_RANK"/);
}

function makeUser(index) {
  const user = {
    userUid: String(2600000 + index),
    friendCode: String(26000000 + index),
    nickname: `Match${index}`,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2600000000000n + BigInt(index) * 100n),
  };
  ensureArmy(user);
  const unitIds = uniqueBaseUnitIds(8);
  const units = unitIds.map((unitId) => grantUnit(user, unitId, { level: 100 }));
  const ship = grantUnit(user, getPlayableShipIds()[index % getPlayableShipIds().length], { level: 100 });
  const operator = grantOperator(user, getPlayableOperatorIds()[index % getPlayableOperatorIds().length], { level: 100 });
  const deck = ensureDeck(user, { deckType: 2, index: 0 });
  deck.unitUids = units.map((unit) => unit.unitUid);
  deck.shipUid = ship.unitUid;
  deck.operatorUid = operator.uid;
  deck.leaderIndex = 0;
  deck.state = 0;
  return user;
}

function uniqueBaseUnitIds(count) {
  const ids = [];
  const bases = new Set();
  for (const unitId of getPlayableUnitIds()) {
    const template = getUnitTemplet(unitId);
    const baseId = Number(template && template.m_BaseUnitID) || unitId;
    if (bases.has(baseId)) continue;
    bases.add(baseId);
    ids.push(unitId);
    if (ids.length === count) break;
  }
  assert.strictEqual(ids.length, count, "eight unique-base units are required");
  return ids;
}

function fakeSocket(user) {
  return { destroyed: false, session: { user } };
}

function matchRequest(deckIndex, gameType, usingBot) {
  return Buffer.from([deckIndex, gameType, usingBot ? 1 : 0]);
}

function assertAck(response, packetId, errorCode) {
  assert(response, `missing ACK ${packetId}`);
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode);
  assert.strictEqual(error.offset, response.payload.length);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
