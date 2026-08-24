"use strict";

const assert = require("assert");
const path = require("path");
const {
  ERRORS,
  PACKETS,
  STATE,
  createExploreHandlers,
  createZone,
  enterExplore,
  getExploreInfo,
  getTables,
} = require("../modules/explore");
const { readBool, readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createEventManager } = require("../modules/event-manager");

const rootDir = path.resolve(__dirname, "..");
const tables = getTables();
assert.strictEqual(tables.templetsById.size, 3);
assert.strictEqual(tables.zonesById.size, 10);
assert.strictEqual(tables.stagesByGroup.size, 122);
assert.strictEqual(tables.pathsByKey.size, 80);
assert.deepStrictEqual([...tables.templetsById.keys()], [1, 2, 3]);
assert.deepStrictEqual(tables.templetsById.get(3).zoneIds, [7, 8, 9]);
assert.strictEqual(tables.templetsById.get(3).exZoneId, 100);
assert.deepStrictEqual(tables.templetsById.get(3).defaultUnitIds, [1009, 1011, 1008, 1010]);
assert.strictEqual(ERRORS.TEMPLET_IS_NULL, 28200);
assert.strictEqual(ERRORS.DISABLED, 28201);
assert.strictEqual(ERRORS.ZONE_TEMPLET_IS_NULL, 28203);
assert.strictEqual(ERRORS.STAGE_TEMPLET_IS_NULL, 28204);
assert.strictEqual(ERRORS.IN_PROGRESS, 28241);
assert.strictEqual(ERRORS.ZONE_EX_NOT_OPEN, 28244);
assert.strictEqual(ERRORS.ZONE_EX_UNABLE_TO_ENTER, 28245);
const frozenExploreSeason = createEventManager({ rootDir, env: { ...process.env, CS_EVENT_DATE: "2026-04-20" } });
assert.strictEqual(getExploreInfo({ eventManager: frozenExploreSeason }, {}, { valid: true, templetId: 3 }).errorCode, ERRORS.OK);
assert.strictEqual(getExploreInfo({ eventManager: frozenExploreSeason }, {}, { valid: true, templetId: 2 }).errorCode, ERRORS.DISABLED);

for (const templet of tables.templetsById.values()) {
  for (const zoneId of [...templet.zoneIds, templet.exZoneId].filter(Boolean)) {
    validateZone(templet, createZone({ randomInt: () => 0 }, templet, zoneId).value);
    validateZone(templet, createZone({ randomInt: (max) => max - 1 }, templet, zoneId).value);
  }
}

const handlers = new Map(createExploreHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [PACKETS.INFO_REQ, PACKETS.ENTER_REQ, PACKETS.ENTER_EX_REQ]) assert(handlers.has(packetId));

let activeExploreIds = [3];
let response = null;
let saves = 0;
let invalidations = 0;
const managedWire = [];
const socket = { session: { user: null } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  randomInt: () => 0,
  eventManager: {
    getActiveEventState() {
      return { entries: activeExploreIds.map((id) => ({ raw: { m_Option: `ExploreTempletID = ${id};` } })) };
    },
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(["explore-enter", "explore-enter-ex"].includes(reason));
    invalidations += 1;
  },
  saveUserDb() { saves += 1; },
};

failure("truncated info", PACKETS.INFO_REQ, makeUser(), Buffer.alloc(0), ERRORS.INVALID_REQUEST);
failure("trailing enter", PACKETS.ENTER_REQ, makeUser(), Buffer.concat([request(3), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
failure("zero template", PACKETS.ENTER_REQ, makeUser(), request(0), ERRORS.INVALID_REQUEST);
failure("unknown template", PACKETS.ENTER_REQ, makeUser(), request(999), ERRORS.TEMPLET_IS_NULL, true);
activeExploreIds = [];
failure("disabled template", PACKETS.ENTER_REQ, makeUser(), request(3), ERRORS.DISABLED, true);
activeExploreIds = [3];
assert.deepStrictEqual([saves, invalidations], [0, 0]);

const user = makeUser();
user.scoreRewards = { explore: [12031] };
let info = getExploreInfo(ctx, user, { valid: true, templetId: 3 });
assert.strictEqual(info.errorCode, ERRORS.OK);
assert.strictEqual(info.state.state, STATE.NONE);
assert.deepStrictEqual([info.state.currentZone, info.state.currentStep, info.state.currentSlotIndex], [-1, -1, -1]);
assert.deepStrictEqual(info.state.rewardIds, [12031]);
invoke(PACKETS.INFO_REQ, user, request(3), true);
assertAck(PACKETS.INFO_ACK, ERRORS.OK, true);
assert.deepStrictEqual([saves, invalidations], [0, 0], "INFO must remain read-only");

invoke(PACKETS.ENTER_REQ, user, request(3), true);
assertAck(PACKETS.ENTER_ACK, ERRORS.OK, true);
assert.strictEqual(user.explore.state, STATE.START);
assert.deepStrictEqual([user.explore.currentZone, user.explore.currentStep, user.explore.currentSlotIndex], [7, -1, 0]);
assert.deepStrictEqual([user.explore.maxHp, user.explore.currentHp], [100, 100]);
assert.deepStrictEqual(Object.values(user.explore.squad.units).map((unit) => unit.unitId), [1009, 1011, 1008, 1010]);
assert(Object.values(user.explore.squad.units).every((unit) => unit.level === 100));
assert.strictEqual(user.explore.squad.ship.unitId, 26001);
assert.deepStrictEqual(user.explore.deck.unitUids.filter(Boolean), Object.keys(user.explore.squad.units));
validateZone(tables.templetsById.get(3), user.explore.zone);
assert.deepStrictEqual([saves, invalidations], [1, 1]);

const firstZoneSnapshot = JSON.stringify(user.explore);
invoke(PACKETS.ENTER_REQ, user, request(3), true);
assertAck(PACKETS.ENTER_ACK, ERRORS.OK, true);
assert.strictEqual(JSON.stringify(user.explore), firstZoneSnapshot, "active ENTER must resume without rerolling the zone");
assert.deepStrictEqual([saves, invalidations], [1, 1]);

const restarted = JSON.parse(JSON.stringify(user));
failure("EX before final zone", PACKETS.ENTER_EX_REQ, restarted, request(3), ERRORS.ZONE_EX_UNABLE_TO_ENTER, true);
invoke(PACKETS.ENTER_REQ, restarted, request(3), true);
assert.strictEqual(JSON.stringify(restarted.explore), firstZoneSnapshot, "JSON restart must resume exactly");
assert.deepStrictEqual([saves, invalidations], [1, 1]);

restarted.explore.state = STATE.CLEAR;
restarted.explore.currentStep = 14;
restarted.explore.currentSlotIndex = 0;
restarted.explore.currentHp = 73;
restarted.explore.score = "456";
restarted.explore.seasonScore = "789";
restarted.explore.artifacts = [7001];
restarted.explore.enhance = { 1: 2 };
restarted.explore.enhancePoint = 33;
invoke(PACKETS.ENTER_REQ, restarted, request(3), true);
assert.deepStrictEqual([restarted.explore.currentZone, restarted.explore.currentStep, restarted.explore.currentSlotIndex], [8, -1, 0]);
assert.deepStrictEqual([restarted.explore.currentHp, restarted.explore.score, restarted.explore.seasonScore], [73, "456", "789"]);
assert.deepStrictEqual(restarted.explore.artifacts, [7001]);
assert.deepStrictEqual(restarted.explore.enhance, { 1: 2 });
assert.strictEqual(restarted.explore.enhancePoint, 33);
assert.deepStrictEqual([saves, invalidations], [2, 2]);

restarted.explore.state = STATE.CLEAR;
restarted.explore.currentStep = 14;
invoke(PACKETS.ENTER_REQ, restarted, request(3), true);
assert.strictEqual(restarted.explore.currentZone, 9);
assert.deepStrictEqual([saves, invalidations], [3, 3]);

restarted.explore.state = STATE.CLEAR;
restarted.explore.currentStep = 14;
invoke(PACKETS.ENTER_EX_REQ, restarted, request(3), true);
assertAck(PACKETS.ENTER_EX_ACK, ERRORS.OK, true);
assert.deepStrictEqual([restarted.explore.currentZone, restarted.explore.currentStep, restarted.explore.currentSlotIndex], [100, -1, 0]);
assert.strictEqual(restarted.explore.currentHp, 73);
assert.deepStrictEqual([saves, invalidations], [4, 4]);

activeExploreIds = [1, 3];
const noEx = makeUser();
failure("season without EX zone", PACKETS.ENTER_EX_REQ, noEx, request(1), ERRORS.ZONE_EX_NOT_OPEN, true);
const otherSeason = makeUser();
let direct = enterExplore(ctx, otherSeason, { valid: true, templetId: 3 }, false);
assert.strictEqual(direct.errorCode, ERRORS.OK);
direct = enterExplore(ctx, otherSeason, { valid: true, templetId: 1 }, false);
assert.strictEqual(direct.errorCode, ERRORS.IN_PROGRESS);

activeExploreIds = [3];
restarted.explore.state = STATE.CLEAR;
restarted.explore.currentStep = 1;
restarted.explore.currentHp = 1;
invoke(PACKETS.ENTER_REQ, restarted, request(3), true);
assert.deepStrictEqual([restarted.explore.currentZone, restarted.explore.currentStep, restarted.explore.currentSlotIndex], [7, -1, 0]);
assert.deepStrictEqual([restarted.explore.currentHp, restarted.explore.score, restarted.explore.artifacts.length], [100, "0", 0]);
assert.strictEqual(restarted.explore.seasonScore, "789");
assert.deepStrictEqual(restarted.explore.rewardIds, [12031]);
assert.deepStrictEqual(restarted.explore.enhance, { 1: 2 });
assert.strictEqual(restarted.explore.enhancePoint, 33);
assert.deepStrictEqual([saves, invalidations], [5, 5]);

const canonical = getExploreInfo(ctx, restarted, { valid: true, templetId: 3 });
assert.deepStrictEqual(canonical.state.rewardIds, [12031]);
validateManagedSchemas();
console.log(`[explore-entry-protocol-check] PASS templates=3 zones=10 stages=122 saves=${saves} packets=${managedWire.length} managed=on`);

function makeUser() {
  return { userUid: "1000000001", nickname: "ExploreEntryCheck" };
}

function request(templetId) {
  return writeSignedVarInt(templetId);
}

function invoke(packetId, user, payload, validateRequest = false) {
  socket.session.user = user;
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: managedWire.length + 1, payload }), true);
  assert(response, `packet ${packetId} must respond`);
  return response;
}

function failure(label, packetId, user, payload, expectedError, validateRequest = false) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, user, payload, validateRequest);
  assertAck(packetId + 1, expectedError, false, label);
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate user state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
}

function assertAck(packetId, errorCode, expectState, label = "response") {
  assert.strictEqual(response.packetId, packetId, `${label} packet ID`);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode, `${label} error`);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, expectState, `${label} state presence`);
}

function validateZone(templet, zone) {
  assert(zone, "zone generation must succeed");
  const source = tables.zonesById.get(zone.zoneId);
  assert(source, `zone ${zone.zoneId} must be table-defined`);
  assert.strictEqual(zone.steps.length, source.stepCount);
  zone.steps.forEach((step, stepIndex) => {
    const definition = source.steps[stepIndex];
    assert.strictEqual(step.step, stepIndex);
    assert.strictEqual(step.stages.length, definition.slotCount);
    assert.strictEqual(new Set(step.stages.map((stage) => stage.stageId)).size, step.stages.length, "stage choices must be unique");
    step.stages.forEach((stage, slotIndex) => {
      assert((tables.stagesByGroup.get(definition.stageGroupId) || []).some((row) => row.stageId === stage.stageId));
      assert.strictEqual(stage.slotIndex, slotIndex);
      assert.strictEqual(stage.isClear, false);
      if (stepIndex + 1 === source.stepCount) {
        assert.strictEqual(stage.pathId, 0);
      } else {
        const targetCount = source.steps[stepIndex + 1].slotCount;
        const key = `${templet.pathGroupId}:${definition.slotCount}:${targetCount}:${slotIndex}`;
        assert((tables.pathsByKey.get(key) || []).some((row) => row.pathId === stage.pathId), `missing path ${key}:${stage.pathId}`);
      }
    });
  });
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Explore schema validation");
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
      assert(result.ok, `managed client schema rejected Explore packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
