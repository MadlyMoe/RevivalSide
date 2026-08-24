"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const {
  ERRORS,
  NGT_PVP_EVENT,
  PACKETS,
  createEventPvpHandlers,
  decodeMatchRequest,
  getEventPvpRewardInfo,
  getEventPvpState,
  getSeasonById,
  loadCatalog,
  recordEventPvpResult,
  validateEventDeck,
  validateSeasonRequest,
} = require("../modules/event-pvp");
const { createEventManager } = require("../modules/event-manager");
const {
  eventDeckHasFreeShipSlot,
  getEventDeckPlayerUnitSlots,
  getPlayableOperatorIds,
  getPlayableShipIds,
  getPlayableUnitIds,
  getUnitTemplet,
} = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readSignedVarInt,
  writeByte,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { buildPlayerDeckForGameLoad, ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const activeNow = new Date("2026-02-07T13:59:30.000Z");
const currentNow = new Date("2026-08-21T12:00:00.000Z");
const season = getSeasonById(2023086);
const hybridSeason = getSeasonById(2023001);
const catalog = loadCatalog();
assert(season && hybridSeason);
assert.strictEqual(catalog.seasons.length, 86);

const manager = createEventManager({
  rootDir,
  env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: activeNow.toISOString(), CS_EVENT_TABLE_SCAN: "known" },
});
const activeState = manager.getActiveEventState(activeNow);
assert(activeState.openTags.includes(season.OpenTag), "historical Event PvP open tag must follow CS_EVENT_DATE");
assert(activeState.intervalData.some((entry) => entry.strKey === season.Interval), "historical Event PvP interval must reach JOIN");

const activeCtx = {
  getServerNowDate: () => activeNow,
  getEffectiveOpenTags: () => activeState.openTags,
};
assert.strictEqual(validateSeasonRequest(activeCtx, season.seasonID), ERRORS.OK);
assert.strictEqual(validateSeasonRequest({ ...activeCtx, getServerNowDate: () => currentNow }, season.seasonID), ERRORS.SEASON_NOT_OPEN);

const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const specialist = "modules\\event-pvp\\handlers\\0000-000-event-pvp.js";
for (const packetId of [PACKETS.MATCH_REQ, PACKETS.CANCEL_REQ, PACKETS.SEASON_INFO_REQ, PACKETS.REWARD_REQ, PACKETS.EXIT_REQ]) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `Event PvP specialist precedence for ${packetId}`);
}
assert.deepStrictEqual(createEventPvpHandlers().map((handler) => handler.packetId), [2674, 2676, 2680, 2682, 2694]);

const user = makeUser(1);
const selection = selectionForSeason(user, season);
const hybridSelection = selectionForSeason(user, hybridSeason);
assert.strictEqual(validateEventDeck(user, season, selection), true, "all-free event deck must validate");
assert.strictEqual(validateEventDeck(user, hybridSeason, hybridSelection), true, "hybrid NPC/free event deck must validate");
assert.strictEqual(validateEventDeck(user, season, { ...selection, shipUid: 999999999n }), false);

const requestPayload = matchRequest(season.seasonID, selection, NGT_PVP_EVENT);
const decoded = decodeMatchRequest({ decryptCopy: (payload) => payload }, requestPayload);
assert.strictEqual(decoded.valid, true);
assert.strictEqual(decoded.seasonId, season.seasonID);
assert.strictEqual(decoded.gameType, NGT_PVP_EVENT);
assert.deepStrictEqual(decoded.eventDeckData, selection);
for (const payload of [Buffer.alloc(0), requestPayload.subarray(0, -1), Buffer.concat([requestPayload, Buffer.from([0])])]) {
  assert.strictEqual(decodeMatchRequest({ decryptCopy: (value) => value }, payload).valid, false, "malformed match must fail");
}

const socket = { destroyed: false, session: { user } };
const responses = [];
const serverPackets = [];
let saves = 0;
let invalidations = 0;
let starts = 0;
const handlerCtx = {
  ...activeCtx,
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => user,
  sendGameResponse(_socket, packet, packetId, payload) {
    assert(Number.isInteger(packet.sequence));
    responses.push({ packetId, payload });
  },
  sendServerGamePacket(_socket, packetId, payload) { serverPackets.push({ packetId, payload }); },
  startEventPvpMatch() { starts += 1; return true; },
  cancelEventPvpMatch() { return true; },
  exitEventPvpMatch() { return true; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

invoke(PACKETS.MATCH_REQ, requestPayload);
assertAck(responses.pop(), PACKETS.MATCH_ACK, ERRORS.OK);
assert.strictEqual(starts, 1);
invoke(PACKETS.MATCH_REQ, Buffer.concat([requestPayload, Buffer.from([0])]));
assertAck(responses.pop(), PACKETS.MATCH_ACK, ERRORS.INVALID_REQUEST);
invoke(PACKETS.SEASON_INFO_REQ, writeSignedVarInt(season.seasonID));
assertAck(responses.at(-1), PACKETS.SEASON_INFO_ACK, ERRORS.OK, false);
invoke(PACKETS.CANCEL_REQ, Buffer.alloc(0));
assertAck(responses.pop(), PACKETS.CANCEL_ACK, ERRORS.OK);
invoke(PACKETS.EXIT_REQ, Buffer.alloc(0));
assertAck(responses.pop(), PACKETS.EXIT_ACK, ERRORS.OK);

for (let index = 0; index < 5; index += 1) recordEventPvpResult(user, season, 0, { now: activeNow });
const earned = getEventPvpRewardInfo(user, season, activeNow);
assert(earned.every((entry) => entry.playCount >= (entry.groupId === 4018 ? 5 : 1)));
invoke(PACKETS.REWARD_REQ, writeSignedVarInt(season.seasonID));
assertAck(responses.at(-1), PACKETS.REWARD_ACK, ERRORS.OK, false);
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);
const inventoryAfterClaim = JSON.stringify(user.inventory);
invoke(PACKETS.REWARD_REQ, writeSignedVarInt(season.seasonID));
assertAck(responses.at(-1), PACKETS.REWARD_ACK, ERRORS.ALREADY_REWARDED, false);
assert.strictEqual(saves, 1, "duplicate reward claim must not save");
assert.strictEqual(JSON.stringify(user.inventory), inventoryAfterClaim, "duplicate reward claim must be pure");
assert.deepStrictEqual(getEventPvpState(JSON.parse(JSON.stringify(user)), season), getEventPvpState(user, season), "Event PvP state must survive restart");

const managed = validateManagedSchemas(user, selection, hybridSelection);
assertFrozenSources();
console.log(`[event-pvp-check] PASS seasons=${catalog.seasons.length} saves=${saves} packets=${managed.packets} gameLoadBytes=${managed.gameLoadBytes} managed=on`);

function invoke(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler && handler.handle(handlerCtx, socket, { packetId, sequence: packetId, payload }));
}

function validateManagedSchemas(sourceUser, latestSelection, firstSelection) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Event PvP validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  let started = null;
  let packets = 0;
  try {
    const wirePackets = [
      [PACKETS.MATCH_REQ, matchRequest(season.seasonID, latestSelection, NGT_PVP_EVENT)],
      [PACKETS.MATCH_ACK, writeSignedVarInt(0)],
      [PACKETS.CANCEL_REQ, Buffer.alloc(0)],
      [PACKETS.CANCEL_ACK, writeSignedVarInt(0)],
      [PACKETS.FAIL_NOT, writeSignedVarInt(ERRORS.GAME_LOAD_FAILED)],
      [PACKETS.SEASON_INFO_REQ, writeSignedVarInt(season.seasonID)],
      responses.find((entry) => entry.packetId === PACKETS.SEASON_INFO_ACK),
      [PACKETS.REWARD_REQ, writeSignedVarInt(season.seasonID)],
      responses.find((entry) => entry.packetId === PACKETS.REWARD_ACK),
      [PACKETS.EXIT_REQ, Buffer.alloc(0)],
      [PACKETS.EXIT_ACK, writeSignedVarInt(0)],
      [PACKETS.CANCEL_NOT, Buffer.concat([writeSignedVarLong(0n), writeSignedVarInt(0)])],
    ];
    for (const entry of wirePackets) {
      const packetId = Array.isArray(entry) ? entry[0] : entry.packetId;
      const payload = Array.isArray(entry) ? entry[1] : entry.payload;
      validatePacket(host, packetId, payload);
      packets += 1;
    }

    const eventDeckId = Number(hybridSeason.EventDeckID);
    const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 0, index: 0 },
      strictSelection: true,
      allowedUnitSlots: Object.keys(firstSelection.units).map(Number),
      slotUnitUids: firstSelection.units,
      shipUid: firstSelection.shipUid,
      operatorUid: firstSelection.operatorUid,
      leaderIndex: firstSelection.leaderIndex,
    });
    const playerDeckB = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 }, {
      deckIndex: { deckType: 2, index: 0 }, strictSelection: true,
    });
    assert(playerDeck && playerDeckB);
    started = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: NGT_PVP_EVENT },
      stage: {
        stageId: 0,
        dungeonID: 0,
        mapID: 1002,
        gameType: NGT_PVP_EVENT,
        eventDeckId,
        usesHybridEventDeck: true,
        eventDeckFreeUnitSlots: getEventDeckPlayerUnitSlots(eventDeckId),
        eventDeckFreeShipSlot: eventDeckHasFreeShipSlot(eventDeckId),
        playerDeck,
        playerDeckB,
      },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(started.ok && started.dynamicGame && started.dynamicGame.managedCombat, started.error || "Event PvP managed start failed");
    const error = readSignedVarInt(started.payload, 0);
    assert.strictEqual(error.value, 0);
    const gameData = started.payload.subarray(error.offset, started.payload.length - 1);
    validatePacket(host, PACKETS.COMPLETE_NOT, gameData);
    packets += 1;
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: started.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "Event PvP GAME_LOAD inspection failed");
    assert.match(inspected.summary || "", /gameType=NGT_PVP_EVENT/);
    return { packets, gameLoadBytes: started.payload.length };
  } finally {
    if (started && started.dynamicGame) host.request("disposeBattle", { dynamicGame: started.dynamicGame, battleState: started.battleState });
    host.close();
  }
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: Buffer.from(payload || []).toString("base64") });
  assert(result.ok, result.error || `managed schema rejected Event PvP packet ${packetId}`);
}

function selectionForSeason(sourceUser, targetSeason) {
  const slots = getEventDeckPlayerUnitSlots(Number(targetSeason.EventDeckID));
  const units = Object.values(sourceUser.army.units);
  const selection = { shipUid: 0n, units: {}, operatorUid: 0n, leaderIndex: -1 };
  for (let index = 0; index < slots.length; index += 1) selection.units[String(slots[index])] = BigInt(units[index].unitUid);
  if (eventDeckHasFreeShipSlot(Number(targetSeason.EventDeckID))) selection.shipUid = BigInt(Object.values(sourceUser.army.ships)[0].unitUid);
  const eventDeck = require("../modules/game-data").getEventDeckTemplet(Number(targetSeason.EventDeckID));
  if (["ST_FREE", "ST_FIXED"].includes(String(eventDeck.SLOT_TYPE_OPERATOR || ""))) {
    selection.operatorUid = BigInt(Object.values(sourceUser.army.operators)[0].uid);
  }
  selection.leaderIndex = slots[0] == null ? -1 : slots[0];
  return selection;
}

function makeUser(index) {
  const sourceUser = {
    userUid: String(2680000 + index),
    friendCode: String(26800000 + index),
    nickname: `Event${index}`,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2680000000000n + BigInt(index) * 100n),
  };
  ensureArmy(sourceUser);
  const units = uniqueBaseUnitIds(8).map((unitId) => grantUnit(sourceUser, unitId, { level: 110 }));
  const ship = grantUnit(sourceUser, getPlayableShipIds()[0], { level: 120 });
  const operator = grantOperator(sourceUser, getPlayableOperatorIds()[0], { level: 100 });
  for (const deckType of [0, 2]) {
    const deck = ensureDeck(sourceUser, { deckType, index: 0 });
    deck.unitUids = units.map((unit) => unit.unitUid);
    deck.shipUid = ship.unitUid;
    deck.operatorUid = operator.uid;
    deck.leaderIndex = 0;
    deck.state = 0;
  }
  return sourceUser;
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
  assert.strictEqual(ids.length, count);
  return ids;
}

function matchRequest(seasonId, selection, gameType) {
  const unitEntries = Object.entries(selection.units || {});
  return Buffer.concat([
    writeSignedVarInt(seasonId),
    Buffer.from([1]),
    writeSignedVarLong(selection.shipUid),
    writeUnsignedVarInt(unitEntries.length),
    ...unitEntries.flatMap(([slot, uid]) => [writeSignedVarInt(Number(slot)), writeSignedVarLong(uid)]),
    writeSignedVarLong(selection.operatorUid),
    writeSignedVarInt(selection.leaderIndex),
    writeByte(gameType),
  ]);
}

function writeUnsignedVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function assertAck(response, packetId, errorCode, exact = true) {
  assert(response, `missing ACK ${packetId}`);
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode);
  if (exact) assert.strictEqual(error.offset, response.payload.length);
}

function assertFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "NKM", "NKMEventDeckData.cs"), /m_ShipUID[\s\S]*m_dicUnit[\s\S]*m_OperatorUID[\s\S]*m_LeaderIndex/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCEventPvpMgr.cs"), /IsValidTime\(ServiceTime\.Recent\)/);
  assert.match(source("server", "listener.js"), /defaultDate: eventManager\.config && eventManager\.config\.eventDate/);
  assert.match(source("modules", "server-time", "index.js"), /defaultDateKey[\s\S]*combineUtcDateWithLocalTime/);
  assert.match(source("modules", "event-manager", "index.js"), /"Interval"[\s\S]*"TournamentInterval"/);
}
