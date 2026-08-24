"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  DRAFT_STATE,
  ERRORS,
  NGT_PVP_LEAGUE,
  PACKETS,
  buildDraftPlayerDeck,
  buildLeagueRoomNotification,
  createLeaguePvpMatchmaker,
  decodeDraftIntRequest,
  decodeDraftLongRequest,
  getDraftBanLimits,
  getLeagueBattlePoint,
  getLeaguePvpState,
  recordLeaguePvpResult,
} = require("../modules/league-pvp");
const {
  readSignedVarInt,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");
const {
  getPlayableOperatorIds,
  getPlayableShipIds,
  getPlayableUnitIds,
  getUnitTemplet,
  isCollectionVisibleUnitId,
} = require("../modules/game-data");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const decryptCtx = { decryptCopy: (payload) => payload };
const specialist = "modules\\league-pvp\\handlers\\0000-2701-league-pvp-season-info-req.js";
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const requestIds = [2639, 2641, 2643, 2645, 2647, 2649, 2651];
const ackIds = [2640, 2642, 2644, 2646, 2648, 2650, 2652];

for (const packetId of requestIds) assert.strictEqual(handlers.get(packetId).fileName, specialist);
assert.deepStrictEqual(
  {
    INVALID_STATE: ERRORS.DRAFT_INVALID_STATE,
    GLOBAL_BAN_COMPLETED: ERRORS.GLOBAL_BAN_COMPLETED,
    GLOBAL_BAN_DUPLICATED: ERRORS.GLOBAL_BAN_DUPLICATED,
    UNIT_FULL_ON_STEP: ERRORS.UNIT_FULL_ON_STEP,
    BANISHED_UNIT_ID: ERRORS.BANISHED_UNIT_ID,
    OTHER_PLAYER_PICKED_UNIT: ERRORS.OTHER_PLAYER_PICKED_UNIT,
    OPPONENT_BAN_DUPLICATED: ERRORS.OPPONENT_BAN_DUPLICATED,
    OPPONENT_BAN_INVALID_INDEX: ERRORS.OPPONENT_BAN_INVALID_INDEX,
    MAIN_SHIP_DUPLICATED: ERRORS.MAIN_SHIP_DUPLICATED,
    OPERATOR_DUPLICATED: ERRORS.OPERATOR_DUPLICATED,
    LEADER_UNIT_DUPLICATED: ERRORS.LEADER_UNIT_DUPLICATED,
    LEADER_INVALID_INDEX: ERRORS.LEADER_INVALID_INDEX,
    INVALID_TIME: ERRORS.DRAFT_INVALID_TIME,
    NOT_IN_GAME_ROOM: ERRORS.NOT_IN_GAME_ROOM,
  },
  {
    INVALID_STATE: 20824,
    GLOBAL_BAN_COMPLETED: 20825,
    GLOBAL_BAN_DUPLICATED: 20826,
    UNIT_FULL_ON_STEP: 20827,
    BANISHED_UNIT_ID: 20828,
    OTHER_PLAYER_PICKED_UNIT: 20829,
    OPPONENT_BAN_DUPLICATED: 20830,
    OPPONENT_BAN_INVALID_INDEX: 20831,
    MAIN_SHIP_DUPLICATED: 20832,
    OPERATOR_DUPLICATED: 20833,
    LEADER_UNIT_DUPLICATED: 20834,
    LEADER_INVALID_INDEX: 20835,
    INVALID_TIME: 20839,
    NOT_IN_GAME_ROOM: 21078,
  }
);
assert.deepStrictEqual(getDraftBanLimits(), { minUnitCount: 30, minShipCount: 3 });
assert.deepStrictEqual([getLeagueBattlePoint(0), getLeagueBattlePoint(1)], [250, 120]);

assert.deepStrictEqual(decodeDraftIntRequest(decryptCtx, writeSignedVarInt(17)), { valid: true, value: 17 });
assert.deepStrictEqual(decodeDraftLongRequest(decryptCtx, writeSignedVarLong(17n)), { valid: true, value: 17n });
for (const payload of [Buffer.alloc(0), Buffer.from([0x80, 0]), Buffer.concat([writeSignedVarInt(1), Buffer.from([0])])]) {
  assert.strictEqual(decodeDraftIntRequest(decryptCtx, payload).valid, false);
}
for (const payload of [Buffer.alloc(0), Buffer.from([0x80, 0]), Buffer.concat([writeSignedVarLong(1n), Buffer.from([0])])]) {
  assert.strictEqual(decodeDraftLongRequest(decryptCtx, payload).valid, false);
}

const catalog = buildFixtureCatalog();
const userA = makeUser(1, catalog.unitsA, catalog.ships[0], catalog.operators[0]);
const userB = makeUser(2, catalog.unitsB, catalog.ships[1], catalog.operators[1]);
const duplicateUnitB = grantUnit(userB, catalog.unitsA[0], { level: 100 });
const bannedUnitA = grantUnit(userA, catalog.bans[0], { level: 100 });
const duplicateShipB = grantUnit(userB, catalog.ships[0], { level: 100 });
const duplicateOperatorB = grantOperator(userB, catalog.operators[0], { level: 100 });
const socketA = fakeSocket(userA);
const socketB = fakeSocket(userB);
const manager = createLeaguePvpMatchmaker({ timersEnabled: false });
const ctx = {
  sendServerGamePacket() {},
};
const underUnits = makeUser(21, catalog.unitsA, catalog.ships[0], catalog.operators[0]);
const underUnitDeck = new Set(underUnits.army.deckSets["2"][0].unitUids.map(String));
for (const uid of Object.keys(underUnits.army.units)) if (!underUnitDeck.has(uid)) delete underUnits.army.units[uid];
assert.strictEqual(manager.request(fakeSocket(underUnits), underUnits, { valid: true, selectDeckIndex: 0, gameType: 19 }).errorCode, ERRORS.NOT_ENOUGH_UNIT_COUNT);
const underShips = makeUser(22, catalog.unitsA, catalog.ships[0], catalog.operators[0]);
const selectedShipUid = String(underShips.army.deckSets["2"][0].shipUid);
for (const uid of Object.keys(underShips.army.ships)) if (uid !== selectedShipUid) delete underShips.army.ships[uid];
assert.strictEqual(manager.request(fakeSocket(underShips), underShips, { valid: true, selectDeckIndex: 0, gameType: 19 }).errorCode, ERRORS.NOT_ENOUGH_SHIP_COUNT);
manager.request(socketA, userA, { valid: true, selectDeckIndex: 0, gameType: NGT_PVP_LEAGUE });
const paired = manager.request(socketB, userB, { valid: true, selectDeckIndex: 0, gameType: NGT_PVP_LEAGUE });
const match = paired.match;
assert(match && match.roomState === DRAFT_STATE.INIT);
assert.strictEqual(manager.globalBan(fakeSocket(makeUser(9, catalog.unitsA, catalog.ships[0], catalog.operators[0])), intReq(catalog.bans[0])).errorCode, ERRORS.NOT_IN_GAME_ROOM);
match.stateDeadlineMs = Date.now() - 1;
assert.strictEqual(manager.globalBan(socketA, intReq(catalog.bans[0])).errorCode, ERRORS.DRAFT_INVALID_TIME);
match.stateDeadlineMs = Date.now() + 30000;

let result = manager.globalBan(socketA, intReq(catalog.bans[0]));
assertSuccess(result);
assert.strictEqual(manager.globalBan(socketA, intReq(catalog.bans[0])).errorCode, ERRORS.GLOBAL_BAN_DUPLICATED);
assertSuccess(manager.globalBan(socketA, intReq(catalog.bans[1])));
assert.strictEqual(manager.globalBan(socketA, intReq(catalog.bans[2])).errorCode, ERRORS.GLOBAL_BAN_COMPLETED);
assertSuccess(manager.globalBan(socketB, intReq(catalog.bans[2])));
result = manager.globalBan(socketB, intReq(catalog.bans[3]));
assert.strictEqual(result.nextState, DRAFT_STATE.BAN_ALL);
manager.publishDraftResult(result, ctx);
assert.strictEqual(match.roomState, DRAFT_STATE.BAN_ALL);
assert.strictEqual(manager.pickUnit(socketA, longReq(userA.army.units[catalog.unitUidsA[0]])).errorCode, ERRORS.DRAFT_INVALID_STATE);
assert(manager.advanceDraftState(match, DRAFT_STATE.BAN_COMPLETE, ctx));
assert(manager.advanceDraftState(match, DRAFT_STATE.PICK_UNIT_1, ctx));

assert.strictEqual(manager.selectUnit(socketB, longReq(catalog.unitUidsB[0])).errorCode, ERRORS.DRAFT_INVALID_STATE);
assert.strictEqual(manager.selectUnit(socketA, longReq(bannedUnitA.unitUid)).errorCode, ERRORS.BANISHED_UNIT_ID);
const pickedByTeam = { 1: 0, 3: 0 };
for (let roomState = DRAFT_STATE.PICK_UNIT_1; roomState <= DRAFT_STATE.PICK_UNIT_10; roomState += 1) {
  assert.strictEqual(match.roomState, roomState);
  const teamType = (roomState - DRAFT_STATE.PICK_UNIT_1) % 2 === 0 ? 1 : 3;
  const socket = teamType === 1 ? socketA : socketB;
  const uids = teamType === 1 ? catalog.unitUidsA : catalog.unitUidsB;
  const target = Math.min(roomState - DRAFT_STATE.PICK_UNIT_1 + 1, 9);
  if (roomState === DRAFT_STATE.PICK_UNIT_1) {
    result = manager.selectUnit(socket, longReq(uids[0]));
    assertSuccess(result);
    assert.strictEqual(match.selectedUnit.unitUid, String(uids[0]));
  }
  if (roomState === DRAFT_STATE.PICK_UNIT_1 + 1) {
    assert.strictEqual(manager.pickUnit(socketB, longReq(duplicateUnitB.unitUid)).errorCode, ERRORS.OTHER_PLAYER_PICKED_UNIT);
  }
  while (pickedByTeam[teamType] < target) {
    result = manager.pickUnit(socket, longReq(uids[pickedByTeam[teamType]]));
    assertSuccess(result);
    pickedByTeam[teamType] += 1;
  }
  assert.strictEqual(manager.pickUnit(socket, longReq(uids[Math.min(pickedByTeam[teamType], 8)])).errorCode, ERRORS.UNIT_FULL_ON_STEP);
  manager.publishDraftResult(result, ctx);
}
assert.strictEqual(match.roomState, DRAFT_STATE.BAN_OPPONENT);
assert.strictEqual(manager.opponentBan(socketA, intReq(99)).errorCode, ERRORS.OPPONENT_BAN_INVALID_INDEX);
assertSuccess(manager.opponentBan(socketA, intReq(0)));
assert.strictEqual(manager.opponentBan(socketA, intReq(1)).errorCode, ERRORS.OPPONENT_BAN_DUPLICATED);
result = manager.opponentBan(socketB, intReq(1));
assert.strictEqual(result.nextState, DRAFT_STATE.PICK_ETC);
manager.publishDraftResult(result, ctx);

assert.strictEqual(manager.pickOperator(socketA, longReq(0n)).errorCode, ERRORS.DRAFT_INVALID_STATE);
assert.strictEqual(manager.pickShip(socketA, longReq(catalog.unitUidsA[0])).errorCode, ERRORS.INVALID_REQUEST);
assertSuccess(manager.pickShip(socketA, longReq(catalog.shipUids[0])));
assert.strictEqual(manager.pickShip(socketA, longReq(catalog.shipUids[0])).errorCode, ERRORS.MAIN_SHIP_DUPLICATED);
assert.strictEqual(manager.pickShip(socketB, longReq(duplicateShipB.unitUid)).errorCode, ERRORS.MAIN_SHIP_DUPLICATED);
assertSuccess(manager.pickShip(socketB, longReq(catalog.shipUids[1])));
assertSuccess(manager.pickOperator(socketA, longReq(catalog.operatorUids[0])));
assert.strictEqual(manager.pickOperator(socketB, longReq(duplicateOperatorB.uid)).errorCode, ERRORS.OPERATOR_DUPLICATED);
assertSuccess(manager.pickOperator(socketB, longReq(catalog.operatorUids[1])));
assert.strictEqual(manager.pickLeader(socketA, intReq(1)).errorCode, ERRORS.LEADER_INVALID_INDEX);
assertSuccess(manager.pickLeader(socketA, intReq(0)));
assert.strictEqual(manager.pickLeader(socketA, intReq(2)).errorCode, ERRORS.LEADER_UNIT_DUPLICATED);
assert.strictEqual(manager.pickLeader(socketB, intReq(0)).errorCode, ERRORS.LEADER_INVALID_INDEX);
result = manager.pickLeader(socketB, intReq(1));
assert.strictEqual(result.nextState, DRAFT_STATE.DRAFT_COMPLETE);
manager.publishDraftResult(result, ctx);
assert.strictEqual(match.roomState, DRAFT_STATE.DRAFT_COMPLETE);

const deckA = buildDraftPlayerDeck(manager.getMember(socketA));
const deckB = buildDraftPlayerDeck(manager.getMember(socketB));
assert(deckA && deckB);
assert.strictEqual(deckA.units.length, 8);
assert.strictEqual(deckB.units.length, 8);
assert(deckA.shipUid !== "0" && deckB.shipUid !== "0");
assert(deckA.operatorUid !== "0" && deckB.operatorUid !== "0");
assert(deckA.leaderUnitUid !== "0" && deckB.leaderUnitUid !== "0");
const beforeA = getLeaguePvpState(userA);
const beforeB = getLeaguePvpState(userB);
assert.strictEqual(recordLeaguePvpResult(userA, 0).winCount, beforeA.winCount + 1);
assert.strictEqual(recordLeaguePvpResult(userB, 1).loseCount, beforeB.loseCount + 1);
assert.strictEqual(getLeaguePvpState(JSON.parse(JSON.stringify(userA))).seasonPlayCount, beforeA.seasonPlayCount + 1);

validateAckBeforeUpdate(catalog);
assertFrozenSources();
const managed = validateManagedSchemas(match, deckA, deckB);
console.log(`[league-pvp-draft-check] PASS units=18 decks=2 results=2 packets=${managed.packets} gameLoadBytes=${managed.gameLoadBytes} managed=on`);

function validateAckBeforeUpdate(catalogData) {
  const local = createLeaguePvpMatchmaker({ timersEnabled: false });
  const a = makeUser(11, catalogData.unitsA, catalogData.ships[0], catalogData.operators[0]);
  const b = makeUser(12, catalogData.unitsB, catalogData.ships[1], catalogData.operators[1]);
  const sa = fakeSocket(a);
  const sb = fakeSocket(b);
  local.request(sa, a, { valid: true, selectDeckIndex: 0, gameType: 19 });
  const pairedLocal = local.request(sb, b, { valid: true, selectDeckIndex: 0, gameType: 19 });
  local.advanceDraftState(pairedLocal.match, DRAFT_STATE.PICK_UNIT_1, null);
  const events = [];
  handlers.get(PACKETS.SELECT_UNIT_REQ).handle({
    ...decryptCtx,
    leaguePvpMatchmaking: local,
    sendGameResponse(_socket, _packet, packetId, payload) { events.push({ kind: "ack", packetId, payload }); },
    sendServerGamePacket(_socket, packetId) { events.push({ kind: "push", packetId }); },
  }, sa, { packetId: PACKETS.SELECT_UNIT_REQ, sequence: 1, payload: writeSignedVarLong(BigInt(a.army.deckSets["2"][0].unitUids[0])) });
  assert.deepStrictEqual(events.map((entry) => entry.kind), ["ack", "push", "push"]);
  assert.strictEqual(events[0].packetId, PACKETS.SELECT_UNIT_ACK);
  assert.strictEqual(readSignedVarInt(events[0].payload, 0).value, ERRORS.OK);
  assert(events.slice(1).every((entry) => entry.packetId === PACKETS.UPDATED_NOT));
}

function validateManagedSchemas(matchData, deckA, deckB) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for League draft validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  let packets = 0;
  try {
    validatePacket(host, PACKETS.UPDATED_NOT, buildLeagueRoomNotification(matchData));
    packets += 1;
    for (let index = 0; index < requestIds.length; index += 1) {
      const packetId = requestIds[index];
      const payload = [PACKETS.GLOBAL_BAN_REQ, PACKETS.OPPONENT_BAN_REQ, PACKETS.PICK_LEADER_REQ].includes(packetId)
        ? writeSignedVarInt(1)
        : writeSignedVarLong(1n);
      validatePacket(host, packetId, payload);
      validatePacket(host, ackIds[index], writeSignedVarInt(0));
      packets += 2;
    }
    const started = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: NGT_PVP_LEAGUE, selectDeckIndex: 0 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: NGT_PVP_LEAGUE, playerDeck: deckA, playerDeckB: deckB },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(started.ok && started.dynamicGame && started.dynamicGame.managedCombat, started.error || "League CombatHost start failed");
    const error = readSignedVarInt(started.payload, 0);
    assert.strictEqual(error.value, 0);
    const gameData = started.payload.subarray(error.offset, started.payload.length - 1);
    validatePacket(host, 2604, gameData);
    packets += 1;
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: started.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "League GAME_LOAD_ACK inspection failed");
    assert.match(inspected.summary || "", /gameType=NGT_PVP_LEAGUE/);
    return { packets, gameLoadBytes: started.payload.length };
  } finally {
    host.close();
  }
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
  assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
}

function buildFixtureCatalog() {
  const bans = getPlayableUnitIds().filter((unitId) => {
    const row = getUnitTemplet(unitId);
    return row && ["NUG_SSR", "NUG_SR"].includes(String(row.m_NKM_UNIT_GRADE || "")) && isDraftUnit(row);
  }).slice(0, 4);
  assert.strictEqual(bans.length, 4);
  const available = getPlayableUnitIds().filter((unitId) => !bans.includes(unitId) && isDraftUnit(getUnitTemplet(unitId)));
  assert(available.length >= 18);
  const ships = distinctShipGroups(3);
  const operators = [...new Set(getPlayableOperatorIds())].slice(0, 2);
  assert.strictEqual(ships.length, 3);
  assert.strictEqual(operators.length, 2);
  return { bans, unitsA: available.slice(0, 9), unitsB: available.slice(9, 18), ships, operators, unitUidsA: [], unitUidsB: [], shipUids: [], operatorUids: [] };
}

function isDraftUnit(row) {
  return Boolean(row && String(row.m_NKM_UNIT_TYPE || "") === "NUT_NORMAL" && !row.m_bMonster && isCollectionVisibleUnitId(row.m_UnitID));
}

function distinctShipGroups(count) {
  const ids = [];
  const groups = new Set();
  for (const unitId of getPlayableShipIds()) {
    const row = getUnitTemplet(unitId);
    const groupId = Number(row && (row.m_ShipGroupID || row.m_UnitID)) || 0;
    if (!groupId || groups.has(groupId)) continue;
    groups.add(groupId);
    ids.push(unitId);
    if (ids.length === count) break;
  }
  return ids;
}

function makeUser(index, unitIds, shipId, operatorId) {
  const user = {
    userUid: String(2638000 + index),
    friendCode: String(26380000 + index),
    nickname: `Draft${index}`,
    level: 100,
    pvp: { league: { seasonId: 1, leagueTierId: 1, score: 1000 + index, rankOpen: true } },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2638000000000n + BigInt(index) * 100n),
  };
  ensureArmy(user);
  const fillerIds = getPlayableUnitIds().filter((unitId) => !catalog.bans.includes(unitId) && isDraftUnit(getUnitTemplet(unitId)));
  const allUnitIds = [...new Set([...unitIds, ...fillerIds])].slice(0, getDraftBanLimits().minUnitCount);
  assert.strictEqual(allUnitIds.length, getDraftBanLimits().minUnitCount);
  const units = allUnitIds.map((unitId) => grantUnit(user, unitId, { level: 100 }));
  const shipIds = [...new Set([shipId, ...catalog.ships])].slice(0, getDraftBanLimits().minShipCount);
  const ships = shipIds.map((unitId) => grantUnit(user, unitId, { level: 100 }));
  const ship = ships[0];
  const operator = grantOperator(user, operatorId, { level: 100 });
  const deck = ensureDeck(user, { deckType: 2, index: 0 });
  deck.unitUids = units.slice(0, 8).map((unit) => unit.unitUid);
  deck.shipUid = ship.unitUid;
  deck.operatorUid = operator.uid;
  deck.leaderIndex = 0;
  deck.state = 0;
  if (index === 1) {
    catalog.unitUidsA = units.map((unit) => unit.unitUid);
    catalog.shipUids[0] = ship.unitUid;
    catalog.operatorUids[0] = operator.uid;
  } else if (index === 2) {
    catalog.unitUidsB = units.map((unit) => unit.unitUid);
    catalog.shipUids[1] = ship.unitUid;
    catalog.operatorUids[1] = operator.uid;
  }
  return user;
}

function fakeSocket(user) {
  return { destroyed: false, session: { user } };
}

function intReq(value) {
  return { valid: true, value: Number(value) };
}

function longReq(value) {
  return { valid: true, value: BigInt(value && value.unitUid != null ? value.unitUid : value) };
}

function assertSuccess(result) {
  assert.strictEqual(result.errorCode, ERRORS.OK);
}

function assertFrozenSources() {
  const room = source("Assembly-CSharp", "ClientPacket", "Pvp", "DraftPvpRoomData.cs");
  const states = source("Assembly-CSharp", "NKM", "DRAFT_PVP_ROOM_STATE.cs");
  const manager = source("Assembly-CSharp", "NKC", "NKCLeaguePVPMgr.cs");
  const errors = source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs");
  assert.match(room, /gameType[\s\S]*roomState[\s\S]*stateEndTime[\s\S]*selectedUnit[\s\S]*draftTeamDataA[\s\S]*draftTeamDataB/);
  assert.match(states, /INIT[\s\S]*BAN_ALL[\s\S]*BAN_COMPLETE[\s\S]*PICK_UNIT_1[\s\S]*PICK_UNIT_10[\s\S]*BAN_OPPONENT[\s\S]*PICK_ETC[\s\S]*DRAFT_COMPLETE/);
  assert.match(manager, /SelectGlobalBanUnit[\s\S]*NKMPacket_DRAFT_PVP_GLOBAL_BAN_REQ/);
  assert.match(manager, /Send_NKMPacket_DRAFT_PVP_SELECT_UNIT_REQ/);
  assert.match(manager, /OnRecv\(NKMPacket_PVP_GAME_MATCH_COMPLETE_NOT[\s\S]*m_DraftPvpRoomData\s*=\s*null/);
  assert.match(errors, /NEC_FAIL_DRAFT_PVP_INVALID_STATE[\s\S]*NEC_FAIL_DRAFT_PVP_NOT_IN_GAME_ROOM/);
  const listener = source("server", "listener.js");
  assert.match(listener, /function startLeaguePvpMatch[\s\S]*leaguePvp\.buildDraftPlayerDeck[\s\S]*gameType[\s\S]*"league-pvp"[\s\S]*2604/);
  assert.match(listener, /leaguePvp\.recordLeaguePvpResult\(member\.user, result\)/);
  assert.match(listener, /leaguePvp\.getLeagueBattlePoint\(result\)[\s\S]*grantMiscItem\(member\.user, 5/);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
