"use strict";

const assert = require("assert");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { readSignedVarInt, writeBool, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
for (const packetId of [820, 825, 827]) {
  assert.strictEqual(handlers.get(packetId).fileName, "packet-handlers\\0000-combat-control-reqs.js");
}

const user = { userUid: "820001" };
const socket = { session: { user } };
const packets = [];
let saves = 0;
let controlCalls = 0;
const ctx = {
  decryptCopy(payload) { return payload; },
  saveUserDb() { saves += 1; },
  applyCombatControls(target, controls, options) {
    controlCalls += 1;
    assert.deepStrictEqual(options, { persist: false });
    const replay = target.session.gameReplay;
    Object.assign(replay, controls);
    Object.assign(replay.battleState, controls);
    if (Number(target.session.privatePvpTeamType) === 3 && controls.autoRespawnEnabled != null) {
      replay.dynamicGame.autoRespawnEnabledB = controls.autoRespawnEnabled;
    } else if (Number(target.session.privatePvpTeamType) === 3 && controls.autoSkillType != null) {
      replay.dynamicGame.autoSkillTypeB = controls.autoSkillType;
    } else {
      Object.assign(replay.dynamicGame, controls);
    }
  },
  sendGameResponse(_socket, _packet, packetId, payload) { packets.push({ packetId, payload }); },
};

send(820, writeBool(true));
assertAck(821, 94, false, "auto respawn without a battle");
send(825, writeSignedVarInt(1));
assertAck(826, 94, 0, "speed without a battle");
send(827, writeSignedVarInt(0));
assertAck(828, 94, 1, "auto skill without a battle");

startBattle({ gameType: 3, dungeonID: 30000 });
send(820, writeBool(true));
assertAck(821, 0, true, "enable auto respawn");
send(820, writeBool(false));
assertAck(821, 0, false, "disable auto respawn");
assert.strictEqual(socket.session.gameReplay.dynamicGame.autoRespawnEnabled, false);

for (const payload of [Buffer.alloc(0), Buffer.from([2]), Buffer.from([1, 0])]) {
  send(820, payload);
  assertAck(821, 20191, false, "malformed auto-respawn request");
}
for (const dynamicGame of [
  { gameType: 7, dungeonID: 1004 },
  { gameType: 3, dungeonID: 20001 },
  { gameType: 4, warfareID: 0 },
  { gameType: 24, forcedAuto: true },
]) {
  startBattle(dynamicGame);
  send(820, writeBool(true));
  assertAck(821, 94, false, `blocked auto-respawn game type ${dynamicGame.gameType}`);
}
startBattle({ gameType: 7, dungeonID: 1004, autoRespawnEnabled: true });
send(820, writeBool(false));
assertAck(821, 0, false, "auto respawn may always be disabled outside forced-auto Event PvP");

startBattle({ gameType: 3, dungeonID: 30000 });
for (let speedType = 0; speedType <= 5; speedType += 1) {
  send(825, writeSignedVarInt(speedType));
  assertAck(826, 0, speedType, `speed type ${speedType}`);
}
for (const gameType of [6, 18, 19, 24, 28]) {
  startBattle({ gameType, gameSpeedType: 1 });
  send(825, writeSignedVarInt(2));
  assertAck(826, 20139, 1, `synchronous PvP speed type ${gameType}`);
}
startBattle({ gameType: 3, dungeonID: 30000, gameSpeedType: 1 });
for (const payload of [Buffer.alloc(0), writeSignedVarInt(6), Buffer.concat([writeSignedVarInt(2), Buffer.from([0])])]) {
  send(825, payload);
  assertAck(826, 20191, 1, "malformed speed request");
}

startBattle({ gameType: 3, dungeonID: 30000 });
for (const autoSkillType of [0, 1]) {
  send(827, writeSignedVarInt(autoSkillType));
  assertAck(828, 0, autoSkillType, `auto skill type ${autoSkillType}`);
}
startBattle({ gameType: 24, forcedAuto: true, autoSkillType: 0 });
send(827, writeSignedVarInt(1));
assertAck(828, 24012, 0, "forced-auto Event PvP");
startBattle({ gameType: 3, dungeonID: 30000, autoSkillType: 1 });
for (const payload of [Buffer.alloc(0), writeSignedVarInt(2), Buffer.concat([writeSignedVarInt(0), Buffer.from([0])])]) {
  send(827, payload);
  assertAck(828, 20191, 1, "malformed auto-skill request");
}

socket.session.privatePvpTeamType = 3;
startBattle({ gameType: 18, autoRespawnEnabledB: false, autoSkillTypeB: 1 });
send(820, writeBool(true));
assertAck(821, 0, true, "team-B auto respawn");
send(827, writeSignedVarInt(0));
assertAck(828, 0, 0, "team-B auto skill");
assert.strictEqual(socket.session.gameReplay.dynamicGame.autoRespawnEnabledB, true);
assert.strictEqual(socket.session.gameReplay.dynamicGame.autoSkillTypeB, 0);
delete socket.session.privatePvpTeamType;

socket.session.gameReplay.battleState.finished = true;
send(827, writeSignedVarInt(1));
assertAck(828, 94, 1, "finished battle");
assert.strictEqual(saves, 0, "battle controls must not persist profile preferences");
assert(controlCalls > 0, "valid battle controls must reach the shared runtime control path");
assert.deepStrictEqual(user, { userUid: "820001" }, "battle controls must not mutate user data");

validateManagedSchemas();
console.log(`[combat-control-protocol-check] PASS requests=3 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function startBattle(dynamicGame) {
  socket.session.gameReplay = {
    dynamicGame: { autoRespawnEnabled: false, gameSpeedType: 0, autoSkillType: 1, ...dynamicGame },
    battleState: {},
  };
}

function send(packetId, payload) {
  packets.length = 0;
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: 1, payload }), true);
}

function assertAck(packetId, errorCode, value, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, packetId, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  assert.strictEqual(error.value, errorCode, label);
  if (packetId === 821) {
    assert.strictEqual(packets[0].payload[error.offset] !== 0, value, label);
    assert.strictEqual(error.offset + 1, packets[0].payload.length, `${label} ACK must have no trailing fields`);
  } else {
    const control = readSignedVarInt(packets[0].payload, error.offset);
    assert.strictEqual(control.value, value, label);
    assert.strictEqual(control.offset, packets[0].payload.length, `${label} ACK must have no trailing fields`);
  }
}

function validateManagedSchemas() {
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
    for (const [packetId, payload] of [
      [820, writeBool(true)],
      [821, Buffer.concat([writeSignedVarInt(0), writeBool(true)])],
      [825, writeSignedVarInt(2)],
      [826, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(2)])],
      [827, writeSignedVarInt(0)],
      [828, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0)])],
    ]) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected combat-control packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
