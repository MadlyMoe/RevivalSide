const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createPrivatePvpManager, buildConfig, PRIVATE_PVP_OPEN_TAGS } = require("../modules/private-pvp");
const {
  writeBool,
  writeFloatLE,
  writeInt64LE,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  writeNullableObject,
  writeNullObject,
  buildDeckIndexData,
  dateTimeBinaryNow,
  readSignedVarInt,
} = require("../modules/packet-codec");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const { buildUserProfileData } = require("../modules/profile");
const { writeFriendDataList } = require("../modules/community");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const privatePvpHandlers = require("../modules/private-pvp/handlers/0000-000-private-pvp-reqs");

const rootDir = path.resolve(__dirname, "..");
const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
assert(sourceUser && sourceUser.userUid, "private PvP check needs one local user fixture");

const manager = createPrivatePvpManager({ publicHost: "100.64.0.10", publicPort: 22000, logger() {} });
const hostSocket = fakeSocket(sourceUser);
const room = manager.createRoom(hostSocket, sourceUser, {
  config: { applyEquipStat: true, applyAllUnitMaxLevel: false, applyBanUpSystem: false, draftBanMode: false },
});
assert.deepStrictEqual(PRIVATE_PVP_OPEN_TAGS, ["PVP_FRIENDLY_MODE", "PVP_PRIVATE_ROOM"]);
assert.match(room.code, /^[A-F0-9]{8}$/);
assert.strictEqual(manager.getMember(hostSocket).teamType, 1);
assert.deepStrictEqual(manager.getPlayerSlots(room), [manager.getMember(hostSocket), null], "client lobby UI requires two stable player slots");
const hostOnlyLobbyData = manager.buildLobbyData(room);

const guestProjection = JSON.parse(JSON.stringify(sourceUser));
guestProjection.nickname = "PrivatePvpGuest";
const reservation = manager.reserveRemote(room.code, guestProjection);
assert.strictEqual(reservation.errorCode, 0);
assert.notStrictEqual(String(reservation.member.user.userUid), String(sourceUser.userUid), "guest account UID must be remapped");
assert.strictEqual(reservation.member.teamType, 3);
assert.deepStrictEqual(manager.getPlayerSlots(room), [manager.getMember(hostSocket), reservation.member]);

const guestSocket = fakeSocket(null);
const ticket = manager.consumeJoinTicket(reservation.accessToken, guestSocket);
assert(ticket && ticket.room === room);
assert.strictEqual(manager.getMember(guestSocket).teamType, 3);
assert.strictEqual(room.members.length, 2);

const readyHandler = privatePvpHandlers.find((handler) => handler.packetId === 4102);
const optionHandler = privatePvpHandlers.find((handler) => handler.packetId === 4121);
const startHandler = privatePvpHandlers.find((handler) => handler.packetId === 4130);
let startRequests = 0;
const gameResponses = [];
const serverPackets = [];
const handlerContext = {
  privatePvp: manager,
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => sourceUser,
  sendGameResponse(_socket, _packet, packetId, payload) { gameResponses.push({ packetId, payload }); },
  sendServerGamePacket(_socket, packetId, payload) { serverPackets.push({ packetId, payload }); },
  startPrivatePvpMatch(_room, onAccepted) {
    startRequests += 1;
    if (typeof onAccepted === "function") onAccepted();
    return true;
  },
};
guestSocket.session.user = reservation.member.user;
const changedConfig = {
  applyEquipStat: false,
  applyAllUnitMaxLevel: true,
  applyBanUpSystem: true,
  draftBanMode: true,
};
optionHandler.handle(handlerContext, hostSocket, {
  payload: writeNullableObject(buildConfig(changedConfig)),
});
assert.deepStrictEqual(room.config, changedConfig, "host friendly-match options must survive normalization");
assert(gameResponses.some((entry) => entry.packetId === 4122), "option change must acknowledge the host");
assert(serverPackets.some((entry) => entry.packetId === 4129), "option change must notify the guest");
startHandler.handle(handlerContext, hostSocket, { payload: Buffer.alloc(0) });
assert.strictEqual(readSignedVarInt(gameResponses.at(-1).payload, 0).value, 27307, "host cannot start before both players are ready");
assert.strictEqual(startRequests, 0, "invalid start request must not reach the match host");
const readyPayload = Buffer.concat([writeNullableObject(buildDeckIndexData({ deckType: 1, index: 0 })), writeBool(true)]);
readyHandler.handle(handlerContext, hostSocket, { payload: readyPayload });
readyHandler.handle(handlerContext, guestSocket, { payload: readyPayload });
assert.strictEqual(startRequests, 0, "ready toggles must leave the host Start button in control");
startHandler.handle(handlerContext, hostSocket, { payload: Buffer.alloc(0) });
assert.strictEqual(startRequests, 1, "host Start must be the only lobby action that starts the match");

const lobbyData = manager.buildLobbyData(room);
assert(lobbyData.length > 100, "serialized private lobby should include both profiles and decks");

const managedDir = findCounterSideManagedDir({ env: process.env });
if (!managedDir) {
  console.log(`[private-pvp-check] PASS room=${room.code} players=2 lobbyBytes=${lobbyData.length} managed=SKIP`);
  process.exit(0);
}

const combatHost = createCsharpCombatHost({
  enabled: true,
  projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
  dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
  managedDir,
  gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
  timeoutMs: 30000,
});

try {
  const hostOnlyCreateAck = Buffer.concat([writeSignedVarInt(0), writeNullableObject(hostOnlyLobbyData)]);
  const createAck = Buffer.concat([writeSignedVarInt(0), writeNullableObject(lobbyData)]);
  for (const [packetId, payload] of [[4101, hostOnlyCreateAck], [4101, createAck], [4132, writeNullableObject(lobbyData)]]) {
    const validation = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
    assert(validation.ok, `managed client schema rejected packet ${packetId}: ${validation.error || "unknown error"}`);
    if (payload === hostOnlyCreateAck) {
      const roundTrip = Buffer.from(validation.payloadBase64 || "", "base64");
      const firstDiff = payload.findIndex((byte, index) => roundTrip[index] !== byte);
      assert.strictEqual(roundTrip.equals(payload), true, `host-only lobby changed at byte ${firstDiff}: sent=${payload.subarray(firstDiff, firstDiff + 16).toString("hex")} decoded=${roundTrip.subarray(firstDiff, firstDiff + 16).toString("hex")}`);
      assert.match(validation.summary || "", new RegExp(`users=2\\[uid=${sourceUser.userUid},friend=${sourceUser.friendCode},ready=False,host=True,state=[^;]+;null\\] observers=0\\[\\] code=${room.code}`));
    }
  }
  for (const [packetId, payload] of [
    [4103, writeSignedVarInt(0)],
    [4105, writeSignedVarInt(0)],
    [4106, Buffer.concat([writeNullableObject(buildUserProfileData(sourceUser)), writeSignedVarInt(10), writeNullableObject(buildConfig(room.config))])],
    [4108, Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(BigInt(reservation.member.user.userUid))])],
    [4109, Buffer.concat([writeSignedVarLong(BigInt(reservation.member.user.userUid)), writeSignedVarInt(1)])],
    [4111, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeString(""), writeSignedVarInt(0), writeString("")])],
    [4112, writeNullableObject(lobbyData)],
    [4114, writeSignedVarInt(0)],
    [4116, Buffer.concat([writeSignedVarInt(0), writeNullableObject(lobbyData)])],
    [4118, writeSignedVarInt(0)],
    [4120, Buffer.concat([writeSignedVarInt(0), writeFriendDataList([reservation.member.user])])],
    [4122, Buffer.concat([writeSignedVarInt(0), writeNullableObject(lobbyData)])],
    [4124, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeString(""), writeSignedVarInt(0), writeString("")])],
    [4126, Buffer.concat([writeSignedVarInt(0), writeNullableObject(lobbyData)])],
    [4127, writeSignedVarInt(0)],
    [4128, Buffer.concat([writeSignedVarLong(BigInt(reservation.member.user.userUid)), writeSignedVarInt(2)])],
    [4129, writeNullableObject(buildConfig(room.config))],
    [4131, writeSignedVarInt(0)],
    [4134, writeSignedVarInt(0)],
    [4135, Buffer.alloc(0)],
    [4137, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(1)])],
  ]) {
    const validation = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
    assert(validation.ok, `managed client schema rejected invitation packet ${packetId}: ${validation.error || "unknown error"}`);
  }
  const deckIndex = writeNullableObject(buildDeckIndexData({ deckType: 1, index: 0 }));
  for (const [packetId, payload] of [
    [4100, Buffer.concat([writeBool(false), writeSignedVarLong(0n), writeNullableObject(buildConfig(room.config))])],
    [4102, Buffer.concat([deckIndex, writeBool(true)])],
    [4104, writeSignedVarLong(BigInt(reservation.member.user.friendCode))],
    [4107, writeSignedVarLong(BigInt(reservation.member.user.userUid))],
    [4110, Buffer.concat([writeSignedVarLong(BigInt(sourceUser.userUid)), writeBool(true)])],
    [4113, Buffer.alloc(0)],
    [4115, Buffer.concat([writeSignedVarLong(BigInt(reservation.member.user.userUid)), writeSignedVarInt(1)])],
    [4117, deckIndex],
    [4119, writeString(reservation.member.user.nickname)],
    [4121, writeNullableObject(buildConfig(room.config))],
    [4123, writeString(room.code)],
    [4125, writeSignedVarLong(BigInt(reservation.member.user.userUid))],
    [4130, Buffer.alloc(0)],
    [4133, Buffer.alloc(0)],
    [4136, writeSignedVarInt(1)],
  ]) {
    const validation = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
    assert(validation.ok, `managed client schema rejected request ${packetId}: ${validation.error || "unknown error"}`);
  }
  const pvpResult = Buffer.concat([
    writeSignedVarInt(0),
    writeNullObject(),
    writeNullObject(),
    writeNullObject(),
    writeInt64LE(dateTimeBinaryNow()),
    writeBool(false),
    writeBool(false),
    writeObjectList([]),
  ]);
  const gameEnd = Buffer.concat([
    writeBool(true), writeBool(false), writeBool(false),
    writeNullObject(), writeNullObject(), writeNullObject(),
    writeNullableObject(buildDeckIndexData({ deckType: 1, index: 0 })),
    writeNullObject(), writeNullableObject(pvpResult), writeNullObject(), writeNullObject(), writeNullObject(),
    writeObjectList([]), writeObjectList([]), writeNullObject(), writeNullObject(), writeNullObject(), writeNullObject(),
    writeSignedVarLong(0n), writeNullObject(), writeNullObject(), writeFloatLE(30), writeNullObject(), writeNullObject(), writeSignedVarInt(0),
  ]);
  const gameEndValidation = combatHost.request("validatePacket", { packetId: 811, payloadBase64: gameEnd.toString("base64") });
  assert(gameEndValidation.ok, gameEndValidation.error || "managed client schema rejected private PvP GAME_END_NOT");

  const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
  const playerDeckB = buildPlayerDeckForGameLoad(reservation.member.user, { selectDeckIndex: 0 });
  assert(playerDeck && playerDeckB, "both private PvP players need a serializable deck");
  const gameUID = String(BigInt(Date.now()) * 10000n);
  const started = combatHost.request("startBattle", {
    req: { stageID: 0, dungeonID: 0, gameType: 18 },
    stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 18, playerDeck, playerDeckB },
    gameUID,
    gameLoadAckPayloadBase64: "",
  });
  assert(started.ok && started.dynamicGame && started.dynamicGame.managedCombat, started.error || "CombatHost did not start private PvP");
  assert(started.payload && started.payload.length > 100, "CombatHost private PvP GAME_LOAD_ACK is empty");
  const gameLoadError = readSignedVarInt(started.payload, 0);
  const matchCompletePayload = started.payload.subarray(gameLoadError.offset, started.payload.length - 1);
  const matchComplete = combatHost.request("validatePacket", { packetId: 2604, payloadBase64: matchCompletePayload.toString("base64") });
  assert(matchComplete.ok, matchComplete.error || "managed client schema rejected private PvP match-complete gameData");
  const inspected = combatHost.request("inspectGameLoadAck", { packetId: 804, payloadBase64: started.payload.toString("base64") });
  assert(inspected.ok, inspected.error || "managed client schema rejected private PvP GAME_LOAD_ACK");
  assert.match(inspected.summary || "", /gameType=NGT_PVP_PRIVATE/);
  assert.match(inspected.summary || "", new RegExp(`teamB=.*user=${reservation.member.user.userUid}`));
  const initial = combatHost.request("buildInitialSync", {
    dynamicGame: started.dynamicGame,
    battleState: started.battleState,
  });
  assert(initial.ok, initial.error || "private PvP initial battle packets failed");
  const initialPacketIds = (initial.packets || []).map((packet) => packet.packetId);
  assert(initialPacketIds.includes(808), "private PvP initial stream is missing GAME_LOAD_COMPLETE_ACK");
  assert(initialPacketIds.includes(809), "private PvP initial stream is missing GAME_START_NOT");
  const guestUnit = playerDeckB.units[0];
  const deployB = combatHost.request("handleDeploy", {
    dynamicGame: initial.dynamicGame || started.dynamicGame,
    battleState: initial.battleState || started.battleState,
    teamType: 3,
    req: {
      unitUID: guestUnit.unitUid,
      assistUnit: false,
      respawnPosX: 900,
      gameTime: 4,
    },
  });
  assert(deployB.ok, deployB.error || "CombatHost rejected Team B deploy routing");
  assert((deployB.packets || []).some((packet) => packet.packetId === 817), "Team B deploy is missing GAME_RESPAWN_ACK");
  const disposed = combatHost.request("disposeBattle", { dynamicGame: started.dynamicGame });
  assert(disposed.ok, disposed.error || "private PvP managed session did not dispose");
  console.log(
    `[private-pvp-check] PASS room=${room.code} players=2 lobbyBytes=${lobbyData.length} managed=on gameLoadBytes=${started.payload.length}`
  );
} finally {
  combatHost.close();
}

function fakeSocket(user) {
  return {
    destroyed: false,
    session: { user, gameReplay: { nextServerSequence: 1 }, nextServerSequence: 1 },
    write() {},
  };
}
