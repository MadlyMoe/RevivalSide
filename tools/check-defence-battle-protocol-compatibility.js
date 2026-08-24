"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { buildDefenceGameEndNotPayload } = require("../modules/defence-battle");
const { ensureArmy } = require("../modules/unit");
const {
  readSignedVarInt,
  writeBool,
  writeFloatLE,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(3900);
assert(handler, "missing Defence battle start handler");
assert.strictEqual(handler.fileName, "modules\\misc-stages\\handlers\\0000-1221-misc-stage-starts.js");

const db = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
const fixture = Object.values(db.users || {}).find((entry) => String(entry && entry.nickname || "").startsWith("Admin_")) || Object.values(db.users || {})[0];
const user = JSON.parse(JSON.stringify(fixture));
assert(user && user.userUid, "Defence battle check needs a local user fixture");
const army = ensureArmy(user);
const unitUids = Object.keys(army.units || {}).slice(0, 8);
assert(unitUids.length > 0, "Defence battle check needs at least one owned unit");
const shipUid = Object.keys(army.ships || {})[0] || "0";
const operatorUid = Object.keys(army.operators || {})[0] || "0";
const validRequest = defenceStartRequest(999, unitUids, shipUid, operatorUid);
const responses = [];
let accepted = null;
const socket = { session: { user } };
const ctx = {
  decryptCopy(payload) { return payload; },
  getGenericStageForRequest(req) {
    return req.defenceTempletId === 999
      ? {
          stageId: 8030000,
          dungeonID: 8030000,
          defenceTempletId: 999,
          gameType: 26,
          miscMode: "defence",
          eventDeckId: 8030000,
          cutsceneOnly: false,
        }
      : null;
  },
  buildDefenceGameStartAckPayload(_socket, req, options) {
    accepted = { req, stage: options.stage };
    return Buffer.concat([writeSignedVarInt(0), writeNullObject(), writeObjectList([])]);
  },
  sendGameResponse(_socket, _packet, packetId, payload, label) {
    responses.push({ packetId, payload, label });
  },
};

send(validRequest);
assert.strictEqual(responses[0].packetId, 3901);
assert.strictEqual(readSignedVarInt(responses[0].payload, 0).value, 0);
const successAck = Buffer.from(responses[0].payload);
assert(accepted && accepted.req.eventDeckData, "valid Defence request must preserve its event deck");
assert.strictEqual(String(accepted.req.eventDeckData.shipUid), String(shipUid));
assert.strictEqual(accepted.stage.gameType, 26);
assert.strictEqual(accepted.stage.playerDeck.units.length, unitUids.length);
const validStage = JSON.parse(JSON.stringify(accepted.stage));

send(Buffer.concat([validRequest, Buffer.from([0])]));
assertError(25900);
send(defenceStartRequest(123456, unitUids, shipUid, operatorUid));
assertError(25900);
send(defenceStartRequest(999, ["999999999999"], shipUid, operatorUid));
assertError(25905);
send(defenceStartRequest(999, [unitUids[0], unitUids[0]], shipUid, operatorUid));
assertError(25905);

const gameEndData = Buffer.concat([
  writeBool(true),
  writeBool(false),
  writeBool(false),
  writeNullObject(),
  writeNullObject(),
  writeNullObject(),
  writeObjectList([]),
  writeObjectList([]),
  writeSignedVarLong(0n),
  writeNullObject(),
  writeFloatLE(12.5),
]);
const defenceEnd = buildDefenceGameEndNotPayload(gameEndData, 999, 12, 20);
const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
const managedSource = fs.readFileSync(path.join(rootDir, "combat-host", "ManagedCombatBridge.cs"), "utf8");
assert(listenerSource.includes("managedCombatPacketId(socket, packetId)"));
assert(listenerSource.includes("isDefenceDynamicGame(replay.dynamicGame)"));
assert(listenerSource.includes("defenceBattle.buildDefenceGameEndNotPayload"));
assert(listenerSource.includes('invalidateJoinLobbyAckPayloadCache("defence-battle-result")'));
assert(managedSource.includes("TryApplyDefenceScoreSync(syncBases)"));
validateManagedSchemas([[3900, validRequest], [3901, successAck], [3906, defenceEnd]], validStage);

console.log(`[defence-battle-protocol-check] PASS requests=5 packets=3 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload) {
  responses.length = 0;
  accepted = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3900, sequence: 1, payload }), true);
  assert.strictEqual(responses.length, 1);
}

function assertError(errorCode) {
  assert.strictEqual(responses[0].packetId, 3901);
  assert.strictEqual(readSignedVarInt(responses[0].payload, 0).value, errorCode);
  assert.strictEqual(accepted, null);
}

function defenceStartRequest(defenceTempletId, uids, selectedShipUid, selectedOperatorUid) {
  const entries = uids.map((uid, slot) => [slot, BigInt(uid)]);
  return Buffer.concat([
    writeSignedVarInt(defenceTempletId),
    writeBool(true),
    writeSignedVarLong(BigInt(selectedShipUid || 0)),
    writeVarInt(entries.length),
    ...entries.flatMap(([slot, uid]) => [writeSignedVarInt(slot), writeSignedVarLong(uid)]),
    writeSignedVarLong(BigInt(selectedOperatorUid || 0)),
    writeSignedVarInt(0),
  ]);
}

function validateManagedSchemas(wire, stage) {
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
    for (const [packetId, payload] of wire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Defence battle packet ${packetId}: ${result.error || "unknown error"}`);
    }
    const started = host.request("startBattle", {
      req: { stageID: stage.stageId, dungeonID: stage.dungeonID, gameType: 26 },
      stage: { ...stage, mapID: 1130 },
      gameUID: String(BigInt(Date.now()) * 10000n),
      gameLoadAckPayloadBase64: "",
    });
    assert(started.ok && started.dynamicGame && started.dynamicGame.managedCombat, started.error || "managed Defence battle did not start");
    const initial = host.request("buildInitialSync", {
      dynamicGame: started.dynamicGame,
      battleState: started.battleState,
    });
    assert(initial.ok, initial.error || "managed Defence initial sync failed");
    const synced = host.request("buildSync", {
      dynamicGame: initial.dynamicGame || started.dynamicGame,
      battleState: initial.battleState || started.battleState,
      delta: 0.033,
      skipSimulation: false,
    });
    assert(synced.ok, synced.error || "managed Defence score sync failed");
    const managedSync = [...(initial.packets || []), ...(synced.packets || [])]
      .find((packet) => Number(packet.packetId) === 822);
    assert(managedSync, "managed Defence startup must emit packet 822");
    const managedSyncValidation = host.request("validatePacket", {
      packetId: 822,
      payloadBase64: managedSync.payload.toString("base64"),
    });
    assert(managedSyncValidation.ok, managedSyncValidation.error || "managed Defence score sync failed schema validation");
  } finally {
    host.close();
  }
}
