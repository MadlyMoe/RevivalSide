"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeByte,
  writeFloatLE,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createPrivatePvpManager } = require("../modules/private-pvp");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
for (const packetId of [814, 835, 838, 842, 861, 882]) {
  assert.strictEqual(
    handlers.get(packetId).fileName,
    "packet-handlers\\0000-battle-actions.js",
    `battle packet ${packetId} must bypass the generic hydrator`
  );
}

const user = { userUid: "1001", inventory: { emoticons: [101] } };
const socket = { session: { user, gameReplay: {} } };
const packets = [];
const room = { matchStarted: true };
let roomForSocket = null;
let memberForSocket = null;
let managed = true;
let abandoned = false;
let finishedPvp = false;
let broadcast = null;
const ctx = {
  constants: {
    GAME_END_NOT: 811,
    GAME_CHECK_DIE_UNIT_ACK: 815,
    GAME_EMOTICON_ACK: 836,
    GAME_EMOTICON_NOT: 837,
    GAME_UNIT_RETREAT_ACK: 839,
    GAME_TACTICAL_COMMAND_ACK: 843,
    GAME_RESTART_ACK: 862,
    GAME_SURRENDER_ACK: 883,
    GAME_SURRENDER_NOT: 884,
  },
  decryptCopy(payload) { return payload; },
  sendGameResponse(_socket, _packet, packetId, payload) { packets.push({ packetId, payload }); },
  sendServerGamePacket(_socket, packetId, payload) { packets.push({ packetId, payload }); },
  handleDynamicBattleCheckDie() {
    if (!managed) return false;
    packets.push({ packetId: 815, payload: writeSignedVarInt(0) });
    return true;
  },
  handleDynamicBattleUnitRetreat(_socket, req) {
    if (!managed) return false;
    packets.push({ packetId: 839, payload: Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(BigInt(req.unitUID))]) });
    return true;
  },
  handleDynamicBattleTacticalCommand(_socket, req) {
    if (!managed) return false;
    packets.push({ packetId: 843, payload: Buffer.concat([writeSignedVarInt(0), tacticalData(req.TCID)]) });
    return true;
  },
  buildDynamicGameEndNotPayload() { return Buffer.from([0xaa]); },
  abandonDynamicBattle() { abandoned = true; return true; },
  finishPrivatePvpGiveup() { finishedPvp = true; return true; },
  privatePvp: {
    getRoom() { return roomForSocket; },
    getMember() { return memberForSocket; },
    broadcast(targetRoom, _ctx, packetId, payload, label, options) {
      broadcast = { targetRoom, packetId, payload, label, options };
      packets.push({ packetId, payload });
      return 1;
    },
  },
};

send(814, Buffer.alloc(0));
assert.deepStrictEqual(packetIds(), [815]);

send(838, writeSignedVarLong(4321n));
assert.deepStrictEqual(packetIds(), [839]);
assert.strictEqual(readSignedVarLong(packets[0].payload, 1).value, 4321n);

send(842, writeSignedVarInt(7));
assert.deepStrictEqual(packetIds(), [843]);

managed = false;
send(814, Buffer.alloc(0));
assertAck(815, 78);
send(838, writeSignedVarLong(4321n));
assertAck(839, 78);
send(842, writeSignedVarInt(7));
assertAck(843, 78);
assert.strictEqual(packets[0].payload.length, 19, "fallback tactical ACK must include a non-null data object");

roomForSocket = room;
send(835, writeSignedVarInt(101));
assert.deepStrictEqual(packetIds(), [836, 837]);
assertAckAt(0, 836, 0);
assert.strictEqual(broadcast.packetId, 837);
let read = readSignedVarLong(broadcast.payload, 0);
assert.strictEqual(read.value, 1001n);
read = readSignedVarInt(broadcast.payload, read.offset);
assert.strictEqual(read.value, 101);
assert.strictEqual(read.offset, broadcast.payload.length);

send(835, writeSignedVarInt(999999));
assertAck(836, 20286);
send(835, writeSignedVarInt(104101));
assertAck(836, 20583);

roomForSocket = null;
socket.session.gameReplay = { dynamicGame: { stageID: 1, dungeonID: 1 }, battleState: {} };
send(861, Buffer.alloc(0));
assert.deepStrictEqual(packetIds(), [862, 811]);
assertAckAt(0, 862, 0);
assert.strictEqual(socket.session.gameReplay.battleState.finished, true);
assert.strictEqual(abandoned, true);

roomForSocket = room;
memberForSocket = { teamType: 1 };
send(882, Buffer.alloc(0));
assert.deepStrictEqual(packetIds(), [883, 884]);
assertAckAt(0, 883, 0);
assert.strictEqual(broadcast.options.except, socket);
assert.strictEqual(finishedPvp, true);

roomForSocket = null;
memberForSocket = null;
send(882, Buffer.alloc(0));
assertAck(883, 78);

validateManagedSchemas([
  [815, writeSignedVarInt(0)],
  [836, writeSignedVarInt(0)],
  [837, Buffer.concat([writeSignedVarLong(1001n), writeSignedVarInt(101)])],
  [839, Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(4321n)])],
  [843, Buffer.concat([writeSignedVarInt(78), tacticalData(0)])],
  [862, writeSignedVarInt(0)],
  [883, writeSignedVarInt(0)],
  [884, Buffer.alloc(0)],
]);

console.log(`[battle-action-protocol-check] PASS packets=${[814, 835, 838, 842, 861, 882].length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload) {
  packets.length = 0;
  broadcast = null;
  const packet = { packetId, sequence: packetId, payload };
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, packet), true);
}

function packetIds() {
  return packets.map((packet) => packet.packetId);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(packets.length, 1);
  assertAckAt(0, packetId, errorCode);
}

function assertAckAt(index, packetId, errorCode) {
  assert.strictEqual(packets[index].packetId, packetId);
  assert.strictEqual(readSignedVarInt(packets[index].payload, 0).value, errorCode);
}

function tacticalData(tacticalCommandId) {
  return Buffer.concat([
    writeSignedVarInt(tacticalCommandId),
    writeByte(1),
    writeFloatLE(0),
    writeByte(0),
    writeByte(0),
    writeFloatLE(0),
    writeBool(true),
    writeFloatLE(0),
  ]);
}

function validateManagedSchemas(wire) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const combatHost = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected battle packet ${packetId}: ${result.error || "unknown error"}`);
    }
    validateManagedActions(combatHost);
  } finally {
    combatHost.close();
  }
}

function validateManagedActions(combatHost) {
  const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
  const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
  assert(sourceUser && sourceUser.userUid, "managed battle action check needs a local user fixture");
  const manager = createPrivatePvpManager({ logger() {} });
  const room = manager.createRoom({ session: {} }, sourceUser, {});
  const guest = manager.reserveRemote(room.code, JSON.parse(JSON.stringify(sourceUser))).member.user;
  const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
  const playerDeckB = buildPlayerDeckForGameLoad(guest, { selectDeckIndex: 0 });
  assert(playerDeck && playerDeckB, "managed battle action check needs two playable decks");

  let state = combatHost.request("startBattle", {
    req: { stageID: 0, dungeonID: 0, gameType: 18 },
    stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 18, playerDeck, playerDeckB },
    gameUID: String(BigInt(Date.now()) * 10000n),
    gameLoadAckPayloadBase64: "",
  });
  assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed battle did not start");
  const initial = combatHost.request("buildInitialSync", stateData(state));
  assert(initial.ok, initial.error || "managed battle initial sync failed");
  state = mergeState(state, initial);

  const deployed = combatHost.request("handleDeploy", {
    ...stateData(state),
    teamType: 1,
    req: { unitUID: playerDeck.units[0].unitUid, assistUnit: false, respawnPosX: -900, gameTime: 4 },
  });
  assert(deployed.ok, deployed.error || "managed battle deploy failed");
  state = mergeState(state, deployed);

  for (const [command, req, packetId] of [
    ["handleCheckDie", undefined, 815],
    ["handleUnitRetreat", { unitUID: playerDeck.units[0].unitUid }, 839],
    ["handleTacticalCommand", { TCID: playerDeck.operatorMainSkillId }, 843],
  ]) {
    const result = combatHost.request(command, { ...stateData(state), teamType: 1, ...(req ? { req } : {}) });
    assert(result.ok, result.error || `${command} failed`);
    const packet = (result.packets || []).find((item) => item.packetId === packetId);
    assert(packet, `${command} did not return packet ${packetId}`);
    if (command === "handleTacticalCommand") {
      assert.strictEqual(
        readSignedVarInt(packet.payload, 0).value,
        0,
        `selected operator tactical command ${playerDeck.operatorMainSkillId} must execute successfully`
      );
    }
    const validation = combatHost.request("validatePacket", { packetId, payloadBase64: packet.payload.toString("base64") });
    assert(validation.ok, validation.error || `managed action packet ${packetId} failed schema validation`);
    state = mergeState(state, result);
  }

  const disposed = combatHost.request("disposeBattle", stateData(state));
  assert(disposed.ok, disposed.error || "managed battle action session did not dispose");
}

function stateData(state) {
  return { dynamicGame: state.dynamicGame, battleState: state.battleState };
}

function mergeState(previous, next) {
  return {
    ...previous,
    ...next,
    dynamicGame: next.dynamicGame || previous.dynamicGame,
    battleState: next.battleState || previous.battleState,
  };
}
