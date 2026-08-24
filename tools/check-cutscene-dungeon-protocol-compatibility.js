"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { ERRORS, PACKETS } = require("../modules/cutscene-dungeon");
const { buildStagePlayData } = require("../modules/stage-play-reset");
const { buildRewardData } = require("../modules/packet-codec");
const { createEmptyReward } = require("../modules/reward");
const {
  readSignedVarInt,
  writeBool,
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { MAIN_STORY_STAGE_CHAIN } = require("../stages/mainStoryStage");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const stage = MAIN_STORY_STAGE_CHAIN.find((entry) => entry.cutsceneOnly && !entry.tutorial);
assert(stage, "frozen main-story table must contain a cutscene-only dungeon");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const startHandler = handlers.get(PACKETS.START_REQ);
const clearHandler = handlers.get(PACKETS.CLEAR_REQ);
assert.strictEqual(startHandler.fileName, "packet-handlers\\1200-cutscene-dungeon-start-req.js");
assert.strictEqual(clearHandler.fileName, "packet-handlers\\1202-cutscene-dungeon-clear-req.js");

const user = { userUid: "986000000000083", nickname: "CutsceneCheck" };
const socket = { session: { user } };
const packets = [];
const managedWire = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { REPLAY_CAPTURED_GAME_FLOW: false },
  capturedGameFlow: null,
  constants: { CUTSCENE_DUNGEON_START_ACK: PACKETS.START_ACK, CUTSCENE_DUNGEON_CLEAR_ACK: PACKETS.CLEAR_ACK },
  decryptCopy(payload) { return payload; },
  isValidCutsceneDungeonId(dungeonId) { return Number(dungeonId) === Number(stage.dungeonID); },
  buildCutsceneDungeonStartAckPayload(dungeonId) {
    return Buffer.concat([
      writeSignedVarInt(ERRORS.OK),
      writeNullableObject(buildStagePlayData({ stageId: stage.stageId, playCount: 0, totalPlayCount: 0 })),
    ]);
  },
  buildCutsceneDungeonClearAckPayload(dungeonId) {
    return Buffer.concat([
      writeSignedVarInt(ERRORS.OK),
      writeNullableObject(buildDungeonClearData(dungeonId)),
      writeNullObject(),
    ]);
  },
  commitCutsceneDungeonClear(_socket, dungeonId) {
    user.dungeonClear = user.dungeonClear || {};
    if (user.dungeonClear[String(dungeonId)]) return { changed: false, alreadyCleared: true };
    user.dungeonClear[String(dungeonId)] = { dungeonId, stageId: stage.stageId, missionResult1: false, missionResult2: false };
    saves += 1;
    invalidations += 1;
    return { changed: true, alreadyCleared: false };
  },
  sendGameResponse(_socket, _packet, packetId, payload, label) { packets.push({ packetId, payload, label }); },
};

for (const payload of [Buffer.alloc(0), Buffer.concat([request(stage.dungeonID), Buffer.from([0])]), Buffer.from([0x82, 0])]) {
  send(startHandler, PACKETS.START_REQ, payload, false);
  assertAck(PACKETS.START_ACK, ERRORS.INVALID_REQUEST);
  send(clearHandler, PACKETS.CLEAR_REQ, payload, false);
  assertAck(PACKETS.CLEAR_ACK, ERRORS.INVALID_REQUEST);
}
send(startHandler, PACKETS.START_REQ, request(999999));
assertAck(PACKETS.START_ACK, ERRORS.INVALID_DUNGEON_ID);
send(clearHandler, PACKETS.CLEAR_REQ, request(999999));
assertAck(PACKETS.CLEAR_ACK, ERRORS.INVALID_DUNGEON_ID);
assertWrites(0);

send(startHandler, PACKETS.START_REQ, request(stage.dungeonID));
assertAck(PACKETS.START_ACK, ERRORS.OK);
assertWrites(0);
send(clearHandler, PACKETS.CLEAR_REQ, request(stage.dungeonID));
assertAck(PACKETS.CLEAR_ACK, ERRORS.OK);
assert(user.dungeonClear[String(stage.dungeonID)]);
assertWrites(1);
send(clearHandler, PACKETS.CLEAR_REQ, request(stage.dungeonID));
assertAck(PACKETS.CLEAR_ACK, ERRORS.OK);
assertWrites(1);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(restarted.dungeonClear[String(stage.dungeonID)].stageId, stage.stageId);
validateListenerSource();
validateManagedSchemas();
console.log(`[cutscene-dungeon-protocol-check] PASS dungeon=${stage.dungeonID} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(dungeonId) {
  return writeSignedVarInt(dungeonId);
}

function send(handler, packetId, payload, validateRequest = true) {
  packets.length = 0;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert.strictEqual(packets.length, 1);
  managedWire.push([packets[0].packetId, packets[0].payload]);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(packets[0].packetId, packetId);
  assert.strictEqual(readSignedVarInt(packets[0].payload, 0).value, errorCode);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function buildDungeonClearData(dungeonId) {
  return Buffer.concat([
    writeSignedVarInt(dungeonId),
    writeBool(false),
    writeBool(false),
    writeNullObject(),
    writeBool(false),
    writeNullObject(),
    writeObjectList([]),
    writeNullableObject(buildRewardData(createEmptyReward())),
    writeSignedVarInt(0),
  ]);
}

function validateListenerSource() {
  const source = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
  assert(source.includes("function commitCutsceneDungeonClear(socket, dungeonId)"));
  assert(source.includes('invalidateJoinLobbyAckPayloadCache("cutscene-dungeon-clear")'));
  assert(source.includes("recordPersistentCutsceneViewForUser(user, stage.dungeonID, stage.stageId, { save: false })"));
  assert(source.includes("recordGameplayUnlockClearForUser(user, stage.dungeonID, stage.stageId, { save: false })"));
  assert(!fs.readFileSync(path.join(rootDir, "packet-handlers", "1200-cutscene-dungeon-start-req.js"), "utf8").includes("resolveCutsceneDungeonId"));
  assert(!fs.readFileSync(path.join(rootDir, "packet-handlers", "1202-cutscene-dungeon-clear-req.js"), "utf8").includes("resolveCutsceneClearDungeonId"));
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
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, result.error || `managed client schema rejected cutscene packet ${packetId}`);
    }
  } finally {
    host.close();
  }
}
