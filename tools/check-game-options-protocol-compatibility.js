"use strict";

const assert = require("assert");
const path = require("path");
const handler = require("../packet-handlers/1636-game-option-change-req");
const {
  readBool,
  readSignedVarInt,
  writeBool,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "987000000000001", options: { playCutscene: true } };
const socket = { session: { user } };
const wire = [];
const managedWire = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  sendGameResponse(target, packet, packetId, payload) { capture(target, packetId, payload); },
  sendServerGamePacket(target, packetId, payload) { capture(target, packetId, payload); },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(label) {
    assert.strictEqual(label, "game-option-change");
    invalidations += 1;
  },
};

send(optionsPayload(2, true, false, false, 2));
assert.deepStrictEqual(parseAck(socket.response.payload), {
  errorCode: 0,
  actionCameraType: 2,
  trackCamera: true,
  viewSkillCutIn: false,
  autoSyncFriendDeck: false,
  defaultPvpAutoRespawn: 2,
});
assert.strictEqual(user.options.playCutscene, true, "unrelated lobby options must survive an in-battle option update");
assert.strictEqual(saves, 1);

send(optionsPayload(2, true, false, false, 2));
assert.strictEqual(saves, 1, "an unchanged option request must not save");
send(optionsPayload(3, true, true, true, 0));
assert.strictEqual(parseAck(socket.response.payload).errorCode, handler.INVALID_REQUEST);
send(optionsPayload(1, true, true, true, 3));
assert.strictEqual(parseAck(socket.response.payload).errorCode, handler.INVALID_REQUEST);
send(Buffer.alloc(0), false);
assert.strictEqual(parseAck(socket.response.payload).errorCode, handler.INVALID_REQUEST);
assert.strictEqual(saves, 1, "invalid option requests must not save");

socket.session.gameReplay = {};
send(optionsPayload(0, false, true, true, 1));
assert.deepStrictEqual(handler.getGameOptions(user), {
  actionCameraType: 0,
  trackCamera: false,
  viewSkillCutIn: true,
  autoSyncFriendDeck: true,
  defaultPvpAutoRespawn: 1,
});
assert.strictEqual(saves, 2);
assert.strictEqual(invalidations, 2);

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(handler.getGameOptions(restarted), handler.getGameOptions(user));

validateManagedSchemas();
console.log(`[game-options-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, managed = true) {
  wire.push([1636, payload]);
  if (managed) managedWire.push([1636, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 1636, sequence: 1636, payload }), true);
}

function capture(target, packetId, payload) {
  target.response = { packetId, payload };
  wire.push([packetId, payload]);
  managedWire.push([packetId, payload]);
}

function optionsPayload(actionCameraType, trackCamera, viewSkillCutIn, autoSyncFriendDeck, defaultPvpAutoRespawn) {
  return Buffer.concat([
    writeSignedVarInt(actionCameraType),
    writeBool(trackCamera),
    writeBool(viewSkillCutIn),
    writeBool(autoSyncFriendDeck),
    writeSignedVarInt(defaultPvpAutoRespawn),
  ]);
}

function parseAck(payload) {
  let read = readSignedVarInt(payload, 0);
  const result = { errorCode: read.value };
  read = readSignedVarInt(payload, read.offset);
  result.actionCameraType = read.value;
  read = readBool(payload, read.offset);
  result.trackCamera = read.value;
  read = readBool(payload, read.offset);
  result.viewSkillCutIn = read.value;
  read = readBool(payload, read.offset);
  result.autoSyncFriendDeck = read.value;
  read = readSignedVarInt(payload, read.offset);
  result.defaultPvpAutoRespawn = read.value;
  assert.strictEqual(read.offset, payload.length);
  return result;
}

function validateManagedSchemas() {
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
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected game-option packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
