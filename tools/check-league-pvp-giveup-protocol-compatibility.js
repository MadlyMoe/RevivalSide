"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const {
  DRAFT_STATE,
  ERRORS,
  NGT_PVP_LEAGUE,
  PACKETS,
  createLeaguePvpMatchmaker,
  getDraftBanLimits,
} = require("../modules/league-pvp");
const {
  getPlayableOperatorIds,
  getPlayableShipIds,
  getPlayableUnitIds,
  getUnitTemplet,
  isCollectionVisibleUnitId,
} = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const specialist = "modules\\league-pvp\\handlers\\0000-2701-league-pvp-season-info-req.js";
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.GIVEUP_REQ);
assert(handler && handler.fileName === specialist, "League give-up specialist precedence");
assert.deepStrictEqual(getDraftBanLimits(), { minUnitCount: 30, minShipCount: 3 });

const catalog = buildCatalog();
const userA = makeUser(1, catalog);
const userB = makeUser(2, catalog);
const socketA = fakeSocket(userA);
const socketB = fakeSocket(userB);
const manager = createLeaguePvpMatchmaker({ timersEnabled: false });
const events = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  decryptCopy: (payload) => payload,
  leaguePvpMatchmaking: manager,
  sendGameResponse(socket, _packet, packetId, payload) { events.push({ kind: "ack", socket, packetId, payload }); },
  sendServerGamePacket(socket, packetId, payload) { events.push({ kind: "push", socket, packetId, payload }); },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

assert.strictEqual(
  invoke(handler, ctx, fakeSocket(makeUser(3, catalog)), Buffer.alloc(0)),
  ERRORS.NOT_IN_GAME_ROOM,
  "give-up outside a room must use the frozen room error"
);
events.length = 0;
assert.strictEqual(manager.request(socketA, userA, matchRequest()).errorCode, ERRORS.OK);
const paired = manager.request(socketB, userB, matchRequest());
assert.strictEqual(paired.errorCode, ERRORS.OK);
assert.strictEqual(invoke(handler, ctx, socketA, Buffer.alloc(0)), ERRORS.DRAFT_INVALID_STATE);
assert.strictEqual(manager.getMatch(socketA), paired.match, "invalid-state give-up must preserve the room");
assert.strictEqual(invoke(handler, ctx, socketA, Buffer.from([0])), ERRORS.INVALID_REQUEST);
assert.strictEqual(manager.getMatch(socketA), paired.match, "malformed give-up must preserve the room");

assert(manager.advanceDraftState(paired.match, DRAFT_STATE.BAN_ALL, null));
events.length = 0;
const beforeA = JSON.stringify(userA);
const beforeB = JSON.stringify(userB);
assert.strictEqual(invoke(handler, ctx, socketA, Buffer.alloc(0)), ERRORS.OK);
assert.deepStrictEqual(events.map((entry) => [entry.kind, entry.packetId]), [
  ["ack", PACKETS.GIVEUP_ACK],
  ["push", PACKETS.MATCH_FAIL_NOT],
  ["push", PACKETS.MATCH_FAIL_NOT],
]);
assert.strictEqual(events[0].socket, socketA, "quitter must receive the ACK first");
assert(events.slice(1).some((entry) => entry.socket === socketA), "quitter must receive the client exit notification");
assert(events.slice(1).some((entry) => entry.socket === socketB), "peer must receive the client exit notification");
for (const event of events.slice(1)) assert.strictEqual(readError(event.payload), ERRORS.LEAGUE_MISS_MATCH);
assert.strictEqual(manager.getMatch(socketA), null);
assert.strictEqual(manager.getMatch(socketB), null);
assert.strictEqual(paired.match.state, "failed");
assert.strictEqual(manager.matches.size, 0);
assert.strictEqual(manager.tickets.size, 0);
assert.strictEqual(JSON.stringify(userA), beforeA, "give-up must not mutate the quitter save");
assert.strictEqual(JSON.stringify(userB), beforeB, "give-up must not mutate the peer save");
assert.strictEqual(saves, 0);
assert.strictEqual(invalidations, 0);

events.length = 0;
assert.strictEqual(invoke(handler, ctx, socketA, Buffer.alloc(0)), ERRORS.NOT_IN_GAME_ROOM);
assert.deepStrictEqual(events.map((entry) => entry.packetId), [PACKETS.GIVEUP_ACK]);

assertFrozenSources();
const packets = validateManagedSchemas();
console.log(`[league-pvp-giveup-check] PASS saves=${saves} invalidations=${invalidations} packets=${packets} managed=on`);

function invoke(target, context, socket, payload) {
  const start = events.length;
  assert.strictEqual(target.handle(context, socket, { packetId: PACKETS.GIVEUP_REQ, sequence: start + 1, payload }), true);
  const ack = events.slice(start).find((entry) => entry.kind === "ack");
  assert(ack && ack.packetId === PACKETS.GIVEUP_ACK);
  return readError(ack.payload);
}

function readError(payload) {
  const result = readSignedVarInt(payload, 0);
  assert.strictEqual(result.offset, payload.length);
  return result.value;
}

function matchRequest() {
  return { valid: true, selectDeckIndex: 0, gameType: NGT_PVP_LEAGUE };
}

function buildCatalog() {
  const units = getPlayableUnitIds().filter((unitId) => {
    const row = getUnitTemplet(unitId);
    return row && String(row.m_NKM_UNIT_TYPE || "") === "NUT_NORMAL" && !row.m_bMonster && isCollectionVisibleUnitId(unitId);
  }).slice(0, getDraftBanLimits().minUnitCount);
  assert.strictEqual(units.length, 30);
  const ships = [];
  const groups = new Set();
  for (const unitId of getPlayableShipIds()) {
    const row = getUnitTemplet(unitId);
    const groupId = Number(row && (row.m_ShipGroupID || row.m_UnitID)) || 0;
    if (!groupId || groups.has(groupId)) continue;
    groups.add(groupId);
    ships.push(unitId);
    if (ships.length === getDraftBanLimits().minShipCount) break;
  }
  assert.strictEqual(ships.length, 3);
  const operatorId = getPlayableOperatorIds()[0];
  assert(operatorId > 0);
  return { units, ships, operatorId };
}

function makeUser(index, fixture) {
  const user = {
    userUid: String(2659000 + index),
    friendCode: String(26590000 + index),
    nickname: `Giveup${index}`,
    level: 100,
    pvp: { league: { seasonId: 1, leagueTierId: 1, score: 1000, rankOpen: true } },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2659000000000n + BigInt(index) * 100n),
  };
  ensureArmy(user);
  const units = fixture.units.map((unitId) => grantUnit(user, unitId, { level: 100 }));
  const ships = fixture.ships.map((unitId) => grantUnit(user, unitId, { level: 100 }));
  const operator = grantOperator(user, fixture.operatorId, { level: 100 });
  const deck = ensureDeck(user, { deckType: 2, index: 0 });
  deck.unitUids = units.slice(0, 8).map((unit) => unit.unitUid);
  deck.shipUid = ships[0].unitUid;
  deck.operatorUid = operator.uid;
  deck.leaderIndex = 0;
  deck.state = 0;
  return user;
}

function fakeSocket(user) {
  return { destroyed: false, session: { user } };
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for League give-up validation");
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
    validatePacket(host, PACKETS.GIVEUP_REQ, Buffer.alloc(0));
    packets += 1;
    for (const errorCode of [ERRORS.OK, ERRORS.INVALID_REQUEST, ERRORS.DRAFT_INVALID_STATE, ERRORS.NOT_IN_GAME_ROOM]) {
      validatePacket(host, PACKETS.GIVEUP_ACK, writeSignedVarInt(errorCode));
      packets += 1;
    }
    validatePacket(host, PACKETS.MATCH_FAIL_NOT, writeSignedVarInt(ERRORS.LEAGUE_MISS_MATCH));
    return packets + 1;
  } finally {
    host.close();
  }
}

function validatePacket(host, packetId, payload) {
  const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
  assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
}

function assertFrozenSources() {
  const request = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_GIVEUP_REQ.cs");
  const ack = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_GIVEUP_ACK.cs");
  const manager = source("Assembly-CSharp", "NKC", "NKCLeaguePVPMgr.cs");
  const handlersSource = source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  const mainUi = source("Assembly-CSharp", "NKC", "UI", "Gauntlet", "NKCUIGauntletLeagueMain.cs");
  const banUi = source("Assembly-CSharp", "NKC", "UI", "Gauntlet", "NKCUIGauntletLeagueGlobalBan.cs");
  assert.match(request, /Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  assert.match(ack, /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)/);
  assert.match(manager, /CanLeaveRoom\(\)[\s\S]*roomState\s*>=\s*DRAFT_PVP_ROOM_STATE\.BAN_ALL[\s\S]*roomState\s*<\s*DRAFT_PVP_ROOM_STATE\.PICK_ETC/);
  assert.match(manager, /OnRecv\(NKMPacket_LEAGUE_PVP_GIVEUP_ACK sPacket\)\s*\{\s*\}/);
  assert.match(handlersSource, /OnRecv\(NKMPacket_LEAGUE_PVP_MATCH_FAIL_NOT sPacket\)[\s\S]*ScenChangeFade\(NKM_SCEN_ID\.NSI_HOME/);
  assert.match(mainUi, /OnClickGiveup\(\)[\s\S]*Send_NKMPacket_LEAGUE_PVP_GIVEUP_REQ/);
  assert.match(banUi, /OnClickGiveup\(\)[\s\S]*Send_NKMPacket_LEAGUE_PVP_GIVEUP_REQ/);
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}
