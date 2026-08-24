"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ERRORS,
  PACKETS,
  STATE,
  buildExploreGameLoadFailurePayload,
  createExploreHandlers,
  enterExplore,
  getTables,
  prepareExploreGameLoad,
  recordExploreBattleResult,
} = require("../modules/explore");
const {
  readBool,
  readSignedVarInt,
  writeBool,
  writeNullableObject,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const tables = getTables();
assert.strictEqual(tables.rewardGroups.size, 112);
assert.strictEqual(tables.eventGroups.size, 68);
assert.strictEqual(tables.eventsById.size, 149);
assert.strictEqual(tables.pathsById.size, 107);
assert.deepStrictEqual(
  [...new Set([...tables.rewardGroups.values()].map((group) => group.rewardType))].sort(),
  ["RT_ARTIFACT", "RT_OPERATOR", "RT_SHIP", "RT_UNIT"]
);
const gameLoadHandlerSource = fs.readFileSync(path.join(rootDir, "packet-handlers", "0801-game-load-req.js"), "utf8");
const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert.match(gameLoadHandlerSource, /prepareExploreGameLoad\(user, req, stage\)/);
assert.match(gameLoadHandlerSource, /playerDeck = explorePlayerDeck/);
assert.match(listenerSource, /recordExploreBattleResult\(\{\}, override\.user/);
assert.match(listenerSource, /explore\.buildExploreData\(exploreBattleResult\.state\)/);

const handlers = new Map(createExploreHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [
  PACKETS.RESET_REQ,
  PACKETS.MOVE_FORWARD_REQ,
  PACKETS.REWARD_SELECT_REQ,
  PACKETS.EVENT_SELECT_REQ,
  PACKETS.REROLL_REQ,
]) assert(handlers.has(packetId), `missing Explore progression handler ${packetId}`);

let response = null;
let saves = 0;
let invalidations = 0;
let sequence = 1;
const managedWire = [];
managedWire.push([804, buildExploreGameLoadFailurePayload(ERRORS.INVALID_STAGE)]);
const socket = { session: { user: null } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  randomInt: () => 0,
  eventManager: {
    getActiveEventState() {
      return { entries: [{ raw: { m_Option: "ExploreTempletID = 3;" } }] };
    },
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(reason.startsWith("explore-"));
    invalidations += 1;
  },
  saveUserDb() { saves += 1; },
};

const user = makeUser();
assert.strictEqual(enterExplore(ctx, user, { valid: true, templetId: 3 }, false).errorCode, ERRORS.OK);
const initial = JSON.stringify(user.explore);
failure("truncated move", PACKETS.MOVE_FORWARD_REQ, user, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
failure("invalid first slot", PACKETS.MOVE_FORWARD_REQ, user, intRequest(9), ERRORS.INVALID_STAGE, true);
assert.strictEqual(JSON.stringify(user.explore), initial);

invoke(PACKETS.MOVE_FORWARD_REQ, user, intRequest(0), true);
assertStateAck(PACKETS.MOVE_FORWARD_ACK, ERRORS.OK, true);
assert.strictEqual(user.explore.state, STATE.SELECT_EVENT);
assert.deepStrictEqual(user.explore.selectionList, [{ id: 70, value: 0 }, { id: 71, value: 0 }]);
assert.deepStrictEqual(user.explore.clearStageIndexList, [0]);
failure("foreign event", PACKETS.EVENT_SELECT_REQ, user, selectableRequest({ id: 1, value: 0 }), ERRORS.INVALID_SELECTION_ITEM, true);

invoke(PACKETS.EVENT_SELECT_REQ, user, selectableRequest({ id: 71, value: 0 }), true);
assertStateAck(PACKETS.EVENT_SELECT_ACK, ERRORS.OK, true, true);
assert.strictEqual(user.explore.state, STATE.EXPLORING);
assert.strictEqual(user.explore.artifacts.length, 1);
assert.strictEqual(user.explore.currentHp, 100);
failure("unreachable path", PACKETS.MOVE_FORWARD_REQ, user, intRequest(2), ERRORS.MOVEABLE_PATH, true);

invoke(PACKETS.MOVE_FORWARD_REQ, user, intRequest(1), true);
assertStateAck(PACKETS.MOVE_FORWARD_ACK, ERRORS.OK, true);
assert.strictEqual(user.explore.state, STATE.BATTLE_READY);
assert.deepStrictEqual(user.explore.clearStageIndexList, [0, 1]);

const wrongLoad = prepareExploreGameLoad(user, { exploreID: 3, dungeonID: 1 }, { miscMode: "explore", gameType: 29 });
assert.deepStrictEqual([wrongLoad.valid, wrongLoad.errorCode], [false, ERRORS.INVALID_STAGE]);
const preparedLoad = prepareExploreGameLoad(user, { exploreID: 3, dungeonID: 5001001 }, { miscMode: "explore", gameType: 29, dungeonID: 5001001 });
assert.strictEqual(preparedLoad.valid, true);
assert.strictEqual(preparedLoad.stage.exploreStageId, 70202);
assert.strictEqual(preparedLoad.playerDeck.deckType, 10);
assert.deepStrictEqual(preparedLoad.playerDeck.units.map((unit) => unit.unitUid), user.explore.deck.unitUids.slice(0, 4));
const battleResult = recordExploreBattleResult(ctx, user, {
  dungeonId: 5001001,
  win: true,
  scoreDelta: 12,
  enhancePointDelta: 3,
});
assert.strictEqual(battleResult.valid, true);
assert.strictEqual(user.explore.state, STATE.SELECT_REWARD);
assert.strictEqual(user.explore.score, "12");
assert.strictEqual(user.explore.enhancePoint, 3);
assert.strictEqual(user.explore.zone.steps[1].stages[1].isClear, true);
assert.strictEqual(user.explore.selectionList.length, 4);

invoke(PACKETS.REROLL_REQ, user, Buffer.alloc(0), true);
assertRerollAck(ERRORS.OK, 9, 4);
assert.strictEqual(user.explore.selectionList.length, 4);
const unitChoice = { ...user.explore.selectionList[0] };
const unitCount = Object.keys(user.explore.squad.units).length;
invoke(PACKETS.REWARD_SELECT_REQ, user, selectableRequest(unitChoice, false), true);
assertStateAck(PACKETS.REWARD_SELECT_ACK, ERRORS.OK, true, true);
assert.strictEqual(Object.keys(user.explore.squad.units).length, unitCount + 1);
assert.strictEqual(user.explore.state, STATE.EXPLORING);

user.explore.state = STATE.SELECT_REWARD;
user.explore.selectionList = [unitChoice];
invoke(PACKETS.REWARD_SELECT_REQ, user, selectableRequest({ id: 0, value: 0 }, true), true);
assertStateAck(PACKETS.REWARD_SELECT_ACK, ERRORS.OK, true, true);
assert.strictEqual(Object.keys(user.explore.squad.units).length, unitCount + 1, "skip must not add a unit");

const artifactStage = findGeneratedStage(user.explore.zone, (row) => row.rewardGroupId && tables.rewardGroups.get(row.rewardGroupId).rewardType === "RT_ARTIFACT");
setCurrentStage(user.explore, artifactStage, STATE.SELECT_REWARD);
user.explore.rerollCount = 2;
invoke(PACKETS.REROLL_REQ, user, Buffer.alloc(0), true);
const artifactChoice = { ...user.explore.selectionList[0] };
const artifactsBefore = user.explore.artifacts.length;
invoke(PACKETS.REWARD_SELECT_REQ, user, selectableRequest(artifactChoice, false), true);
assert.strictEqual(user.explore.artifacts.length, artifactsBefore + 1);

const breakUser = makeEnteredUser();
invoke(PACKETS.MOVE_FORWARD_REQ, breakUser, intRequest(0), true);
invoke(PACKETS.EVENT_SELECT_REQ, breakUser, selectableRequest({ id: 70, value: 0 }), true);
assert.strictEqual(breakUser.explore.currentHp, 80);
assert.strictEqual(breakUser.explore.state, STATE.EXPLORING);

const upgradeUser = makeEnteredUser();
const upgradeStage = findGeneratedStage(upgradeUser.explore.zone, (row) => row.stageType === "EVENT_SELECTION" && row.eventValue === 80009);
setCurrentStage(upgradeUser.explore, upgradeStage, STATE.SELECT_EVENT);
upgradeUser.explore.selectionList = tables.eventGroups.get(80009).map((event) => ({ id: event.eventId, value: 0 }));
invoke(PACKETS.EVENT_SELECT_REQ, upgradeUser, selectableRequest({ id: 13, value: 0 }), true);
assert(Object.values(upgradeUser.explore.squad.units).every((unit) => unit.level === 101));

setCurrentStage(upgradeUser.explore, upgradeStage, STATE.SELECT_EVENT);
upgradeUser.explore.selectionList = tables.eventGroups.get(80009).map((event) => ({ id: event.eventId, value: 0 }));
invoke(PACKETS.EVENT_SELECT_REQ, upgradeUser, selectableRequest({ id: 14, value: 0 }), true);
assert.strictEqual(upgradeUser.explore.state, STATE.UPGRADE_SHIP);

const operatorUser = makeEnteredUser();
const operatorStage = findGeneratedStage(operatorUser.explore.zone, (row) => row.stageType === "EVENT_SELECTION" && row.eventValue === 80031);
setCurrentStage(operatorUser.explore, operatorStage, STATE.SELECT_EVENT);
operatorUser.explore.selectionList = tables.eventGroups.get(80031).map((event) => ({ id: event.eventId, value: 0 }));
invoke(PACKETS.EVENT_SELECT_REQ, operatorUser, selectableRequest({ id: 72, value: 0 }), true);
assert.strictEqual(operatorUser.explore.squad.operator.id, 31301);
assert.strictEqual(operatorUser.explore.squad.operator.subSkill.id, 1002);

const lockedEvent = tables.eventsById.get(130);
const lockedStageRow = [...tables.stagesById.values()].find((row) => row.stageType === "EVENT_SELECTION" && row.eventValue === lockedEvent.eventGroupId);
assert(lockedStageRow);
const lockedUser = makeEnteredUser();
lockedUser.explore.zone.steps[0].stages[0].stageId = lockedStageRow.stageId;
setCurrentStage(lockedUser.explore, { step: 0, slotIndex: 0 }, STATE.SELECT_EVENT);
lockedUser.explore.selectionList = tables.eventGroups.get(lockedEvent.eventGroupId).map((event) => ({ id: event.eventId, value: 0 }));
failure("locked event", PACKETS.EVENT_SELECT_REQ, lockedUser, selectableRequest({ id: 130, value: 0 }), ERRORS.INVALID_SELECTION_ITEM, true);

const battleEventUser = makeEnteredUser();
battleEventUser.explore.zone.steps[0].stages[0].stageId = 20206;
setCurrentStage(battleEventUser.explore, { step: 0, slotIndex: 0 }, STATE.SELECT_EVENT);
battleEventUser.explore.selectionList = tables.eventGroups.get(80016).map((event) => ({ id: event.eventId, value: 0 }));
const battleEventUnitCount = Object.keys(battleEventUser.explore.squad.units).length;
invoke(PACKETS.EVENT_SELECT_REQ, battleEventUser, selectableRequest({ id: 31, value: 0 }), true);
assert.strictEqual(battleEventUser.explore.state, STATE.BATTLE_READY);
assert(battleEventUser.explore.pendingEventReward);
assert.strictEqual(prepareExploreGameLoad(battleEventUser, { exploreID: 3, dungeonID: 5004003 }, { miscMode: "explore" }).valid, true);
assert.strictEqual(recordExploreBattleResult(ctx, battleEventUser, { dungeonId: 5004003, win: true }).valid, true);
assert.strictEqual(Object.keys(battleEventUser.explore.squad.units).length, battleEventUnitCount + 1);
assert.strictEqual(battleEventUser.explore.pendingEventReward, undefined);

const advanceUser = makeEnteredUser();
const zoneSevenSquad = JSON.stringify(advanceUser.explore.squad);
advanceUser.explore.currentStep = advanceUser.explore.zone.steps.length - 1;
advanceUser.explore.currentSlotIndex = 0;
advanceUser.explore.state = STATE.EXPLORING;
advanceUser.explore.currentHp = 77;
const advanced = enterExplore(ctx, advanceUser, { valid: true, templetId: 3 }, false);
assert.strictEqual(advanced.errorCode, ERRORS.OK);
assert.strictEqual(advanced.changed, true);
assert.deepStrictEqual([advanceUser.explore.currentZone, advanceUser.explore.currentStep, advanceUser.explore.currentHp], [8, -1, 77]);
assert.strictEqual(JSON.stringify(advanceUser.explore.squad), zoneSevenSquad);

const resetUser = makeEnteredUser();
resetUser.explore.score = "123";
resetUser.explore.seasonScore = "456";
failure("trailing reset", PACKETS.RESET_REQ, resetUser, Buffer.from([0]), ERRORS.INVALID_REQUEST);
invoke(PACKETS.RESET_REQ, resetUser, Buffer.alloc(0), true);
assertStateAck(PACKETS.RESET_ACK, ERRORS.OK, true);
assert.strictEqual(resetUser.explore.state, STATE.ANNIHILATION);
assert.strictEqual(resetUser.explore.seasonScore, "579");
const resetSnapshot = JSON.stringify(resetUser);
failure("repeat reset", PACKETS.RESET_REQ, resetUser, Buffer.alloc(0), ERRORS.STATE_IS_FINAL, true);
assert.strictEqual(JSON.stringify(resetUser), resetSnapshot);
assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(resetUser)).explore), JSON.stringify(resetUser.explore));

const noReroll = makeEnteredUser();
const noRerollStage = findGeneratedStage(noReroll.explore.zone, (row) => row.rewardGroupId > 0);
setCurrentStage(noReroll.explore, noRerollStage, STATE.SELECT_REWARD);
noReroll.explore.rerollCount = 0;
failure("reroll exhausted", PACKETS.REROLL_REQ, noReroll, Buffer.alloc(0), ERRORS.NOT_ENOUGH_REROLL_COUNT, true);
failure("trailing reroll", PACKETS.REROLL_REQ, noReroll, Buffer.from([0]), ERRORS.INVALID_REQUEST);
failure("null reward object", PACKETS.REWARD_SELECT_REQ, noReroll, Buffer.from([0, 0]), ERRORS.INVALID_REQUEST);
failure("trailing event", PACKETS.EVENT_SELECT_REQ, noReroll, Buffer.concat([selectableRequest({ id: 1, value: 0 }), Buffer.from([0])]), ERRORS.INVALID_REQUEST);

assert.strictEqual(invalidations, saves, "every Explore progression save must pair with one JOIN invalidation");
validateManagedSchemas();
console.log(
  `[explore-progress-protocol-check] PASS rewards=${tables.rewardGroups.size} events=${tables.eventsById.size} paths=${tables.pathsById.size} saves=${saves} packets=${managedWire.length} managed=on`
);

function makeUser() {
  return { userUid: "1000000001", nickname: "ExploreProgressCheck" };
}

function makeEnteredUser() {
  const value = makeUser();
  assert.strictEqual(enterExplore(ctx, value, { valid: true, templetId: 3 }, false).errorCode, ERRORS.OK);
  return value;
}

function intRequest(value) {
  return writeSignedVarInt(value);
}

function selectableRequest(item, skip) {
  const body = writeNullableObject(Buffer.concat([writeSignedVarInt(item.id), writeSignedVarInt(item.value)]));
  return skip === undefined ? body : Buffer.concat([body, writeBool(skip)]);
}

function invoke(packetId, userValue, payload, validateRequest = false) {
  socket.session.user = userValue;
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: sequence++, payload }), true);
  assert(response, `packet ${packetId} must respond`);
  return response;
}

function failure(label, packetId, userValue, payload, expectedError, validateRequest = false) {
  const before = JSON.stringify(userValue);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, userValue, payload, validateRequest);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError, `${label} error`);
  assert.strictEqual(JSON.stringify(userValue), before, `${label} must not mutate user state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
}

function assertStateAck(packetId, errorCode, expectState, expectSquad = false) {
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode);
  const state = readBool(response.payload, error.offset);
  assert.strictEqual(state.value, expectState);
  if (expectSquad) assert(response.payload.includes(Buffer.from([1])), "squad ACK must contain a non-null object");
}

function assertRerollAck(errorCode, rerollCount, selectionCount) {
  assert.strictEqual(response.packetId, PACKETS.REROLL_ACK);
  let read = readSignedVarInt(response.payload, 0);
  assert.strictEqual(read.value, errorCode);
  read = readSignedVarInt(response.payload, read.offset);
  assert.strictEqual(read.value, rerollCount);
  const count = readUnsignedVarInt(response.payload, read.offset);
  assert.strictEqual(count.value, selectionCount);
}

function readUnsignedVarInt(buffer, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (shift < 32) {
    assert(offset < buffer.length, "truncated varint");
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function findGeneratedStage(zone, predicate) {
  for (const step of zone.steps) {
    for (const stage of step.stages) {
      const row = tables.stagesById.get(stage.stageId);
      if (predicate(row)) return { step: step.step, slotIndex: stage.slotIndex };
    }
  }
  throw new Error("generated Explore zone lacks required stage type");
}

function setCurrentStage(explore, location, state) {
  explore.currentStep = location.step;
  explore.currentSlotIndex = location.slotIndex;
  explore.state = state;
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Explore progression schema validation");
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
