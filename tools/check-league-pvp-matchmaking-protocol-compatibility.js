"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  ERRORS,
  NDT_PVP,
  NGT_PVP_LEAGUE,
  NGT_PVP_UNLIMITED,
  PACKETS,
  buildLeagueRoomNotification,
  createLeaguePvpMatchmaker,
  decodeMatchRequest,
} = require("../modules/league-pvp");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const decryptCtx = { decryptCopy: (payload) => payload };
const specialist = "modules\\league-pvp\\handlers\\0000-2701-league-pvp-season-info-req.js";
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });

assert.strictEqual(handlers.get(PACKETS.MATCH_REQ).fileName, specialist);
assert.strictEqual(handlers.get(PACKETS.MATCH_CANCEL_REQ).fileName, specialist);
assert.deepStrictEqual(
  {
    OK: ERRORS.OK,
    ALREADY_BEGIN: ERRORS.ALREADY_BEGIN,
    ALREADY_MATCHING: ERRORS.ALREADY_MATCHING,
    INVALID_MATCH_TYPE: ERRORS.INVALID_MATCH_TYPE,
    CANCEL_FAIL: ERRORS.CANCEL_FAIL,
    LEAGUE_MISS_MATCH: ERRORS.LEAGUE_MISS_MATCH,
    INVALID_REQUEST: ERRORS.INVALID_REQUEST,
  },
  { OK: 0, ALREADY_BEGIN: 106, ALREADY_MATCHING: 107, INVALID_MATCH_TYPE: 108, CANCEL_FAIL: 109, LEAGUE_MISS_MATCH: 360, INVALID_REQUEST: 20191 }
);
assert.strictEqual(NDT_PVP, 2);
assert.strictEqual(NGT_PVP_LEAGUE, 19);
assert.strictEqual(NGT_PVP_UNLIMITED, 28);

assert.deepStrictEqual(decodeMatchRequest(decryptCtx, Buffer.from([3, 19])), {
  valid: true,
  selectDeckIndex: 3,
  gameType: 19,
});
for (const payload of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0, 19, 0])]) {
  assert.strictEqual(decodeMatchRequest(decryptCtx, payload).valid, false, "malformed League match request must fail");
}

const users = [makeUser(1, 19), makeUser(2, 19), makeUser(3, 28), makeUser(4, 19)];
const sockets = users.map(fakeSocket);
const manager = createLeaguePvpMatchmaker();
const leagueReq = { valid: true, selectDeckIndex: 0, gameType: 19 };

assert.strictEqual(manager.request(sockets[0], users[0], { ...leagueReq, valid: false }).errorCode, ERRORS.INVALID_REQUEST);
assert.strictEqual(manager.request(sockets[0], users[0], { ...leagueReq, gameType: 6 }).errorCode, ERRORS.INVALID_MATCH_TYPE);
assert.strictEqual(manager.request(sockets[0], users[0], leagueReq).errorCode, ERRORS.OK);
assert.strictEqual(manager.request(sockets[0], users[0], leagueReq).errorCode, ERRORS.ALREADY_MATCHING);
assert.strictEqual(manager.cancel(sockets[0]).errorCode, ERRORS.OK);
assert.strictEqual(manager.cancel(sockets[0]).errorCode, ERRORS.CANCEL_FAIL);

const unlimited = manager.request(sockets[2], users[2], { ...leagueReq, gameType: 28 });
const first = manager.request(sockets[0], users[0], leagueReq);
assert.strictEqual(unlimited.match, null);
assert.strictEqual(first.match, null);
assert.strictEqual(manager.waiting.length, 2, "League and Unlimited queues must not cross-pair");
const second = manager.request(sockets[1], users[1], leagueReq);
assert(second.match && second.match.members.length === 2, "second League user must complete a two-player pair");
assert.strictEqual(second.match.gameType, 19);
assert.strictEqual(manager.getMatch(sockets[0]), second.match);
assert.strictEqual(manager.getMember(sockets[1]).teamType, 3);

const active = fakeSocket(users[3]);
active.session.gameReplay = { dynamicGame: { gameType: 19 }, dynamicBattleResultSent: false };
assert.strictEqual(manager.request(active, users[3], leagueReq).errorCode, ERRORS.ALREADY_BEGIN);

const wire = validateHandlerWire(users[0], users[1]);
const disconnect = validateDisconnectFailure(users[0], users[1]);
assertFrozenSources();
const managed = validateManagedSchemas(second.match);
console.log(`[league-pvp-matchmaking-check] PASS queues=2 failures=${disconnect} packets=${managed.packets} managed=on roomBytes=${managed.roomBytes} pushes=${wire.pushes}`);

function validateHandlerWire(userA, userB) {
  const local = createLeaguePvpMatchmaker();
  const socketA = fakeSocket(userA);
  const socketB = fakeSocket(userB);
  const responses = [];
  const pushes = [];
  const ctx = {
    ...decryptCtx,
    leaguePvpMatchmaking: local,
    sendGameResponse(socket, _packet, packetId, payload) { responses.push({ socket, packetId, payload }); },
    sendServerGamePacket(socket, packetId, payload) { pushes.push({ socket, packetId, payload }); },
  };
  const match = handlers.get(PACKETS.MATCH_REQ);
  const cancel = handlers.get(PACKETS.MATCH_CANCEL_REQ);
  match.handle(ctx, socketA, { packetId: PACKETS.MATCH_REQ, sequence: 1, payload: Buffer.from([0, 19]) });
  assertAck(responses.pop(), PACKETS.MATCH_ACK, ERRORS.OK);
  match.handle(ctx, socketB, { packetId: PACKETS.MATCH_REQ, sequence: 2, payload: Buffer.from([0, 19]) });
  assertAck(responses.pop(), PACKETS.MATCH_ACK, ERRORS.OK);
  assert.strictEqual(pushes.length, 2);
  assert(pushes.every((entry) => entry.packetId === PACKETS.ACCEPT_NOT));
  assert(pushes[0].payload.equals(pushes[1].payload), "both clients must receive the identical authoritative room");

  const malformed = fakeSocket(makeUser(9, 19));
  match.handle(ctx, malformed, { packetId: PACKETS.MATCH_REQ, sequence: 3, payload: Buffer.from([0]) });
  assertAck(responses.pop(), PACKETS.MATCH_ACK, ERRORS.INVALID_REQUEST);
  cancel.handle(ctx, malformed, { packetId: PACKETS.MATCH_CANCEL_REQ, sequence: 4, payload: Buffer.from([0]) });
  assertAck(responses.pop(), PACKETS.MATCH_CANCEL_ACK, ERRORS.INVALID_REQUEST);
  return { pushes: pushes.length };
}

function validateDisconnectFailure(userA, userB) {
  const local = createLeaguePvpMatchmaker({ disconnectGraceMs: 1000 });
  const socketA = fakeSocket(userA);
  const socketB = fakeSocket(userB);
  local.request(socketA, userA, { valid: true, selectDeckIndex: 0, gameType: 19 });
  const paired = local.request(socketB, userB, { valid: true, selectDeckIndex: 0, gameType: 19 });
  const sent = [];
  socketB.destroyed = true;
  assert.strictEqual(local.handleSocketClose(socketB, {
    sendServerGamePacket(socket, packetId, payload) { sent.push({ socket, packetId, payload }); },
  }), true);
  assert.strictEqual(sent.length, 0, "disconnect grace must preserve a reconnectable draft");
  const replacement = fakeSocket(userB);
  const reattached = local.reattachUser(userB, replacement);
  assert(reattached && reattached.match === paired.match, "same user must reattach to the in-progress room");
  assert.strictEqual(local.getMatch(replacement), paired.match);
  assert.strictEqual(local.fail(paired.match, {
    sendServerGamePacket(socket, packetId, payload) { sent.push({ socket, packetId, payload }); },
  }, ERRORS.LEAGUE_MISS_MATCH, replacement), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].socket, socketA);
  assert.strictEqual(sent[0].packetId, PACKETS.MATCH_FAIL_NOT);
  assert.strictEqual(readSignedVarInt(sent[0].payload, 0).value, ERRORS.LEAGUE_MISS_MATCH);
  assert.strictEqual(paired.match.state, "failed");
  assert.strictEqual(local.tickets.size, 0);
  return sent.length;
}

function validateManagedSchemas(match) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for League matchmaking validation");
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
    const room = buildLeagueRoomNotification(match);
    for (const [packetId, payload] of [
      [PACKETS.MATCH_REQ, Buffer.from([0, 19])],
      [PACKETS.MATCH_ACK, writeSignedVarInt(0)],
      [PACKETS.MATCH_CANCEL_REQ, Buffer.alloc(0)],
      [PACKETS.MATCH_CANCEL_ACK, writeSignedVarInt(0)],
      [PACKETS.MATCH_FAIL_NOT, writeSignedVarInt(360)],
      [PACKETS.ACCEPT_NOT, room],
      [PACKETS.UPDATED_NOT, room],
    ]) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, result.error || `managed schema rejected packet ${packetId}`);
      packets += 1;
    }
    return { packets, roomBytes: room.length };
  } finally {
    host.close();
  }
}

function assertFrozenSources() {
  const request = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_MATCH_REQ.cs");
  const cancel = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_MATCH_CANCEL_REQ.cs");
  const accept = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_ACCEPT_NOT.cs");
  const updated = source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_UPDATED_NOT.cs");
  const sender = source("Assembly-CSharp", "NKC", "UI", "Gauntlet", "NKCUIGauntletMatch.cs");
  const receiver = source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  const manager = source("Assembly-CSharp", "NKC", "NKCLeaguePVPMgr.cs");
  const errors = source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs");
  assert.match(request, /selectDeckIndex[\s\S]*gameType/);
  assert.match(cancel, /Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  assert.match(accept, /PutOrGet<DraftPvpRoomData>\(ref this\.roomData\)/);
  assert.match(updated, /PutOrGet<DraftPvpRoomData>\(ref this\.roomData\)/);
  assert.match(sender, /NGT_PVP_LEAGUE[\s\S]*NGT_PVP_UNLIMITED[\s\S]*NKMPacket_LEAGUE_PVP_MATCH_REQ/);
  assert.match(receiver, /OnRecv\(NKMPacket_LEAGUE_PVP_ACCEPT_NOT[\s\S]*NKCLeaguePVPMgr\.OnRecv/);
  assert.match(manager, /InitDraftRoom\(sPacket\.roomData\)/);
  assert.match(errors, /NEC_FAIL_PVP_LEAGUE_MISS_MATCH/);
  const bridge = source("combat-host", "ManagedCombatBridge.cs");
  assert.match(bridge, /19\s*=>\s*"NGT_PVP_LEAGUE"/);
  assert.match(bridge, /28\s*=>\s*"NGT_PVP_UNLIMITED"/);
  assert.match(bridge, /"leaguePvpRoomData"/);
  assert.match(bridge, /OverlayLocalLeaguePvpData[\s\S]*"leaguePvpState"[\s\S]*"leaguePvpOpen"/);
  const listener = source("server", "listener.js");
  assert.match(listener, /leaguePvp\.getLeaguePvpState\(user\)/);
  assert.match(listener, /overlayLocalLeaguePvpData:\s*leaguePvp\.hasLeaguePvpState\(user\)/);
  const join = source("packet-handlers", "0204-join-lobby-req.js");
  assert.match(join, /leaguePvpMatchmaking\.reattachUser\(user, socket\)/);
  assert.match(join, /leaguePvpRoomDataPayload:\s*ctx\.leaguePvpMatchmaking\.buildRoomData/);
}

function makeUser(index, gameType) {
  const user = {
    userUid: String(2630000 + index),
    friendCode: String(26300000 + index),
    nickname: `League${index}`,
    level: 100,
    pvp: { league: { seasonId: 1, leagueTierId: 1, score: 100 + index, rankOpen: true } },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(2630000000000n + BigInt(index) * 100n),
  };
  ensureArmy(user);
  const units = uniqueBaseUnitIds(30).map((unitId) => grantUnit(user, unitId, { level: 100 }));
  const shipIds = getPlayableShipIds();
  const ships = [0, 1, 2].map((offset) => grantUnit(user, shipIds[(index + offset) % shipIds.length], { level: 100 }));
  const ship = ships[0];
  const operator = grantOperator(user, getPlayableOperatorIds()[index % getPlayableOperatorIds().length], { level: 100 });
  const deck = ensureDeck(user, { deckType: 2, index: 0 });
  deck.unitUids = units.slice(0, 8).map((unit) => unit.unitUid);
  deck.shipUid = ship.unitUid;
  deck.operatorUid = operator.uid;
  deck.leaderIndex = 0;
  deck.state = 0;
  user.requestedLeagueGameType = gameType;
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
  assert.strictEqual(ids.length, count);
  return ids;
}

function fakeSocket(user) {
  return { destroyed: false, session: { user } };
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
