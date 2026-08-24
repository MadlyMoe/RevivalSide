"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  readSignedVarInt,
  writeFloatLE,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { createPrivatePvpManager } = require("../modules/private-pvp");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const shipHandler = handlers.get(818);
const unitHandler = handlers.get(829);
assert.strictEqual(shipHandler.fileName, "packet-handlers\\0818-game-ship-skill-req.js");
assert.strictEqual(unitHandler.fileName, "packet-handlers\\0829-game-use-unit-skill-req.js");

const socket = { session: { user: { userUid: "818829001" }, gameReplay: null } };
const packets = [];
let shipCalls = 0;
let unitCalls = 0;
let dynamicHandled = true;
const ctx = {
  config: { DYNAMIC_BATTLE_MANAGER: true },
  constants: { GAME_SHIP_SKILL_ACK: 819, GAME_USE_UNIT_SKILL_ACK: 830 },
  decryptCopy(payload) { return payload; },
  decodeGameShipSkillReq,
  decodeGameUnitSkillReq,
  buildGameShipSkillAckPayload,
  buildGameUnitSkillAckPayload,
  sendGameResponse(_socket, _packet, packetId, payload, label) { packets.push({ packetId, payload, label }); },
  handleDynamicBattleShipSkill(_socket, req) {
    shipCalls += 1;
    if (dynamicHandled) packets.push({ packetId: 819, payload: buildGameShipSkillAckPayload(req.gameUnitUID, req.shipSkillID, req.skillPosX) });
    return dynamicHandled;
  },
  handleDynamicBattleUnitSkill(_socket, req) {
    unitCalls += 1;
    if (dynamicHandled) packets.push({ packetId: 830, payload: buildGameUnitSkillAckPayload(req.gameUnitUID, 17) });
    return dynamicHandled;
  },
};

const validShip = shipRequest(1, 2000612, -500.25);
for (const payload of [
  Buffer.alloc(0),
  Buffer.from([0x80]),
  validShip.subarray(0, validShip.length - 1),
  Buffer.concat([validShip, Buffer.from([0])]),
  shipRequest(40000, 2000612, -500.25),
  replaceShipPosition(validShip, Number.NaN),
  replaceShipPosition(validShip, Number.POSITIVE_INFINITY),
]) {
  sendShip(payload);
  assertShipAck(20191, 0, 0, 0, "malformed ship skill request");
}
assert.strictEqual(shipCalls, 0, "malformed ship requests must not reach combat authority");

const validUnit = unitRequest(2);
for (const payload of [Buffer.alloc(0), Buffer.from([0x80]), Buffer.concat([validUnit, Buffer.from([0])]), unitRequest(40000)]) {
  sendUnit(payload);
  assertUnitAck(20191, 0, 0, "malformed unit skill request");
}
assert.strictEqual(unitCalls, 0, "malformed unit requests must not reach combat authority");

sendShip(validShip);
assertShipAck(90, 1, 2000612, -500.25, "ship skill without an active battle");
sendUnit(validUnit);
assertUnitAck(20134, 2, 0, "unit skill without an active battle");

startBattle();
sendShip(validShip);
assertShipAck(0, 1, 2000612, -500.25, "active ship skill");
sendUnit(validUnit);
assertUnitAck(0, 2, 17, "active unit skill");

socket.session.gameReplay.battleState.finished = true;
sendShip(validShip);
assertShipAck(90, 1, 2000612, -500.25, "finished battle ship skill");
sendUnit(validUnit);
assertUnitAck(20134, 2, 0, "finished battle unit skill");
assert.strictEqual(shipCalls, 1);
assert.strictEqual(unitCalls, 1);

startBattle();
dynamicHandled = false;
sendShip(validShip);
assertShipAck(90, 1, 2000612, -500.25, "ship skill host unavailable");
sendUnit(validUnit);
assertUnitAck(20134, 2, 0, "unit skill host unavailable");

validateFrozenSources();
validateManagedRuntime();
console.log(`[battle-skills-protocol-check] PASS requests=21 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function startBattle() {
  socket.session.gameReplay = {
    dynamicGame: { gameType: 18, managedCombat: true },
    battleState: { gameState: { state: 3 }, finished: false },
  };
}

function sendShip(payload) {
  packets.length = 0;
  assert.strictEqual(shipHandler.handle(ctx, socket, { packetId: 818, sequence: 1, payload }), true);
}

function sendUnit(payload) {
  packets.length = 0;
  assert.strictEqual(unitHandler.handle(ctx, socket, { packetId: 829, sequence: 1, payload }), true);
}

function assertShipAck(errorCode, gameUnitUID, shipSkillID, skillPosX, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, 819, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  const unit = readSignedVarInt(packets[0].payload, error.offset);
  const skill = readSignedVarInt(packets[0].payload, unit.offset);
  const position = packets[0].payload.readFloatLE(skill.offset);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(unit.value, gameUnitUID, label);
  assert.strictEqual(skill.value, shipSkillID, label);
  assert.strictEqual(position, Math.fround(skillPosX), label);
  assert.strictEqual(skill.offset + 4, packets[0].payload.length, `${label} ACK must have no trailing fields`);
}

function assertUnitAck(errorCode, gameUnitUID, skillStateID, label) {
  assert.strictEqual(packets.length, 1, label);
  assert.strictEqual(packets[0].packetId, 830, label);
  const error = readSignedVarInt(packets[0].payload, 0);
  const unit = readSignedVarInt(packets[0].payload, error.offset);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(unit.value, gameUnitUID, label);
  assert.strictEqual(packets[0].payload.readInt8(unit.offset), skillStateID, label);
  assert.strictEqual(unit.offset + 1, packets[0].payload.length, `${label} ACK must have no trailing fields`);
}

function shipRequest(gameUnitUID, shipSkillID, skillPosX) {
  return Buffer.concat([writeSignedVarInt(gameUnitUID), writeSignedVarInt(shipSkillID), writeFloatLE(skillPosX)]);
}

function unitRequest(gameUnitUID) {
  return writeSignedVarInt(gameUnitUID);
}

function replaceShipPosition(payload, value) {
  const copy = Buffer.from(payload);
  const unit = readSignedVarInt(copy, 0);
  const skill = readSignedVarInt(copy, unit.offset);
  copy.writeFloatLE(value, skill.offset);
  return copy;
}

function decodeGameShipSkillReq(payload) {
  try {
    let offset = 0;
    const unit = readSignedVarInt(payload, offset);
    offset = unit.offset;
    const skill = readSignedVarInt(payload, offset);
    offset = skill.offset;
    const position = payload.readFloatLE(offset);
    offset += 4;
    if (offset !== payload.length || unit.value < -32768 || unit.value > 32767 || !Number.isFinite(position)) return null;
    return { gameUnitUID: unit.value, shipSkillID: skill.value, skillPosX: position };
  } catch (_) {
    return null;
  }
}

function decodeGameUnitSkillReq(payload) {
  try {
    const unit = readSignedVarInt(payload, 0);
    if (unit.offset !== payload.length || unit.value < -32768 || unit.value > 32767) return null;
    return { gameUnitUID: unit.value };
  } catch (_) {
    return null;
  }
}

function buildGameShipSkillAckPayload(gameUnitUID, shipSkillID, skillPosX, errorCode = 0) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(gameUnitUID),
    writeSignedVarInt(shipSkillID),
    writeFloatLE(skillPosX),
  ]);
}

function buildGameUnitSkillAckPayload(gameUnitUID, skillStateID = 0, errorCode = 0) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarInt(gameUnitUID), Buffer.from([skillStateID & 0xff])]);
}

function validateFrozenSources() {
  const shipReq = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_SHIP_SKILL_REQ.cs");
  const shipAck = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_SHIP_SKILL_ACK.cs");
  const unitReq = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_USE_UNIT_SKILL_REQ.cs");
  const unitAck = source("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_GAME_USE_UNIT_SKILL_ACK.cs");
  const server = source("Assembly-CSharp", "NKM", "NKMGameServerHost.cs");
  for (const field of ["gameUnitUID", "shipSkillID", "skillPosX"]) assert(shipReq.includes(`ref this.${field}`));
  assert(shipAck.includes("PutOrGetEnum<NKM_ERROR_CODE>(ref this.errorCode)"));
  assert(unitReq.includes("ref this.gameUnitUID"));
  assert(unitAck.includes("PutOrGetEnum<NKM_ERROR_CODE>(ref this.errorCode)"));
  assert(unitAck.includes("ref this.skillStateID"));
  assert(server.includes("unit.CanUseShipSkill(cPacket_GAME_SHIP_SKILL_REQ.shipSkillID)"));
  assert(server.includes("unit.UseShipSkill(cPacket_GAME_SHIP_SKILL_REQ.shipSkillID, cPacket_GAME_SHIP_SKILL_REQ.skillPosX)"));
  assert(server.includes("unit.CanUseManualSkill(true, out flag, out skillStateID)"));

  const listener = source("server", "listener.js");
  assert(listener.includes("(result.packets || []).some((packet) => packet.packetId === GAME_SHIP_SKILL_ACK)"));
  assert(listener.includes("(result.packets || []).some((packet) => packet.packetId === GAME_USE_UNIT_SKILL_ACK)"));
  assert(!listener.includes('buildGameUnitSkillAckPayload(req.gameUnitUID, 0, 0),\n    "battle-manager-unit-skill"'));
  assert(!listener.includes('buildGameShipSkillAckPayload(req.gameUnitUID, req.shipSkillID, req.skillPosX, 0),\n    "battle-manager-ship-skill"'));
}

function source(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}

function validateManagedRuntime() {
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
  let state = null;
  try {
    for (const [packetId, payload] of [
      [818, validShip],
      [819, buildGameShipSkillAckPayload(1, 2000612, -500.25, 88)],
      [829, validUnit],
      [830, buildGameUnitSkillAckPayload(2, 48)],
      [830, buildGameUnitSkillAckPayload(32767, 0, 20134)],
    ]) {
      const validation = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(validation.ok, validation.error || `managed client schema rejected battle skill packet ${packetId}`);
    }

    const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
    const sourceUser = JSON.parse(JSON.stringify(Object.values(db.users || {})[0]));
    assert(sourceUser && sourceUser.userUid, "managed battle skill check needs a local user fixture");
    const manager = createPrivatePvpManager({ logger() {} });
    const room = manager.createRoom({ session: {} }, sourceUser, {});
    const guest = manager.reserveRemote(room.code, JSON.parse(JSON.stringify(sourceUser))).member.user;
    const playerDeck = buildPlayerDeckForGameLoad(sourceUser, { selectDeckIndex: 0 });
    const playerDeckB = buildPlayerDeckForGameLoad(guest, { selectDeckIndex: 0 });
    assert(playerDeck && playerDeckB && playerDeck.units.length, "managed battle skill check needs two playable decks");
    // Keep this cooldown/gauge fixture at its original base skill strength.
    // Saved ship progression is covered by check:game-load; letting both
    // level-5 AI ships into this long-running timing check can kill the test
    // unit before its manual gauge becomes ready.
    playerDeck.shipSkillLevels = [1, 1, 1, 1, 1];
    playerDeckB.shipSkillLevels = [1, 1, 1, 1, 1];

    state = host.request("startBattle", {
      req: { stageID: 0, dungeonID: 0, gameType: 18 },
      stage: { stageId: 0, dungeonID: 0, mapID: 1002, gameType: 18, playerDeck, playerDeckB },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(state.ok && state.dynamicGame && state.dynamicGame.managedCombat, state.error || "managed battle skill battle did not start");
    state = mergeState(state, checked(host.request("buildInitialSync", stateData(state)), "managed battle skill initial sync"));
    state = mergeState(state, checked(host.request("buildTimeline", { ...stateData(state), delta: 1 / 30, maxFrames: 150, startIndex: 0 }), "managed battle skill play state"));

    let result = checked(host.request("handleShipSkill", {
      ...stateData(state), teamType: 1, req: { gameUnitUID: 32767, shipSkillID: 2000612, skillPosX: -500.25 },
    }), "managed invalid ship unit");
    assertManagedShipAck(result, 84, 32767, 2000612, -500.25, "unknown managed ship unit");
    state = mergeState(state, result);

    result = checked(host.request("handleShipSkill", {
      ...stateData(state), teamType: 1, req: { gameUnitUID: 1, shipSkillID: 2000612, skillPosX: -500.25 },
    }), "managed ship cooldown");
    assertManagedShipAck(result, 88, 1, 2000612, -500.25, "managed ship cooldown");
    state = mergeState(state, result);

    result = checked(host.request("handleDeploy", {
      ...stateData(state),
      teamType: 1,
      req: { unitUID: String(playerDeck.units[0].unitUid), assistUnit: false, respawnPosX: -1300, gameTime: 4 },
    }), "managed battle skill unit deploy");
    state = mergeState(state, result);

    result = checked(host.request("handleUnitSkill", {
      ...stateData(state), teamType: 1, req: { gameUnitUID: 32767 },
    }), "managed invalid unit skill");
    assertManagedUnitAck(result, 20134, 32767, 0, "unknown managed unit");
    state = mergeState(state, result);

    result = null;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      state = mergeState(state, checked(host.request("buildTimeline", { ...stateData(state), delta: 1 / 30, maxFrames: 100, startIndex: 0 }), "managed unit skill cooldown"));
      const candidate = checked(host.request("handleUnitSkill", {
        ...stateData(state), teamType: 1, req: { gameUnitUID: 2 },
      }), "managed unit skill attempt");
      state = mergeState(state, candidate);
      if (managedError(candidate, 830) === 0) {
        result = candidate;
        break;
      }
      assert.strictEqual(managedError(candidate, 830), 20133, "frozen host must reject the unit skill until its gauge is ready");
    }
    assert(result, "frozen managed unit skill did not become usable before its unit expired");
    const unitAck = assertManagedUnitAck(result, 0, 2, null, "valid managed unit skill");
    assert(unitAck.skillStateID > 0, "managed unit skill must return the frozen active skill-state id");

    result = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      state = mergeState(state, checked(host.request("buildTimeline", { ...stateData(state), delta: 1 / 30, maxFrames: 100, startIndex: 0 }), "managed ship skill cooldown"));
      const candidate = checked(host.request("handleShipSkill", {
        ...stateData(state), teamType: 1, req: { gameUnitUID: 1, shipSkillID: 2000612, skillPosX: -500.25 },
      }), "managed ship skill attempt");
      state = mergeState(state, candidate);
      if (managedError(candidate, 819) === 0) {
        result = candidate;
        break;
      }
      assert.strictEqual(managedError(candidate, 819), 88, "frozen host must reject the ship skill until its cooldown is ready");
    }
    assert(result, "frozen managed ship skill did not become usable before battle end");
    assertManagedShipAck(result, 0, 1, 2000612, -500.25, "valid managed ship skill");
  } finally {
    if (state && state.dynamicGame) {
      const disposed = host.request("disposeBattle", stateData(state));
      assert(disposed.ok, disposed.error || "managed battle skill battle did not dispose");
    }
    host.close();
  }
}

function checked(result, label) {
  assert(result.ok, result.error || `${label} failed`);
  return result;
}

function managedError(result, packetId) {
  const packet = (result.packets || []).find((entry) => Number(entry.packetId) === packetId);
  assert(packet, `managed command did not return packet ${packetId}`);
  return readSignedVarInt(packet.payload, 0).value;
}

function assertManagedShipAck(result, errorCode, gameUnitUID, shipSkillID, skillPosX, label) {
  const packet = (result.packets || []).find((entry) => Number(entry.packetId) === 819);
  assert(packet, `${label} did not return packet 819`);
  packets.length = 0;
  packets.push(packet);
  assertShipAck(errorCode, gameUnitUID, shipSkillID, skillPosX, label);
}

function assertManagedUnitAck(result, errorCode, gameUnitUID, skillStateID, label) {
  const packet = (result.packets || []).find((entry) => Number(entry.packetId) === 830);
  assert(packet, `${label} did not return packet 830`);
  const error = readSignedVarInt(packet.payload, 0);
  const unit = readSignedVarInt(packet.payload, error.offset);
  const state = packet.payload.readInt8(unit.offset);
  assert.strictEqual(error.value, errorCode, label);
  assert.strictEqual(unit.value, gameUnitUID, label);
  if (skillStateID != null) assert.strictEqual(state, skillStateID, label);
  assert.strictEqual(unit.offset + 1, packet.payload.length, label);
  return { skillStateID: state };
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
