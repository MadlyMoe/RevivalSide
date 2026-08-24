"use strict";

const path = require("path");
const { randomInt } = require("crypto");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getOperatorMainSkillId, getUnitTemplet } = require("../game-data");
const { createUnitData } = require("../unit");
const {
  buildDeckData,
  buildOperatorData,
  buildUnitData,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeFloatLE,
  writeIntList,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeObjectList,
  writeObjectMapLong,
  writeSignedVarInt,
  writeSignedVarLong,
  writeVarInt,
} = require("../packet-codec");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const EXPLORE_UID_BASE = 8700000000000000n;

const PACKETS = Object.freeze({
  INFO_REQ: 1255,
  INFO_ACK: 1256,
  ENTER_REQ: 1257,
  ENTER_ACK: 1258,
  ENTER_EX_REQ: 1259,
  ENTER_EX_ACK: 1260,
  RESET_REQ: 1261,
  RESET_ACK: 1262,
  MOVE_FORWARD_REQ: 1263,
  MOVE_FORWARD_ACK: 1264,
  REWARD_SELECT_REQ: 1265,
  REWARD_SELECT_ACK: 1266,
  EVENT_SELECT_REQ: 1267,
  EVENT_SELECT_ACK: 1268,
  UNIT_CHANGE_REQ: 1269,
  UNIT_CHANGE_ACK: 1270,
  OPERATOR_CHANGE_REQ: 1271,
  OPERATOR_CHANGE_ACK: 1272,
  SHIP_UPGRADE_REQ: 1273,
  SHIP_UPGRADE_ACK: 1274,
  ENHANCE_REQ: 1275,
  ENHANCE_ACK: 1276,
  ENHANCE_RESET_REQ: 1277,
  ENHANCE_RESET_ACK: 1278,
  REROLL_REQ: 1283,
  REROLL_ACK: 1284,
});

const ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  TEMPLET_IS_NULL: 28200,
  DISABLED: 28201,
  ZONE_TEMPLET_IS_NULL: 28203,
  STAGE_TEMPLET_IS_NULL: 28204,
  INVALID_ID: 28206,
  STATE_IS_FINAL: 28219,
  IS_EMPTY: 28220,
  PROCESSABLE_STATE: 28221,
  MOVEABLE_PATH: 28222,
  ZONE_CREATE: 28223,
  STAGE_CREATE: 28224,
  INVALID_STAGE: 28225,
  INVALID_STAGE_TYPE: 28226,
  INVALID_ZONE: 28227,
  INVALID_STATE: 28228,
  INVALID_PATH: 28229,
  INVALID_SQUAD: 28230,
  INVALID_REWARD_TYPE: 28231,
  UNIT_UPDATE: 28232,
  ADD_UNIT: 28233,
  ADD_ARTIFACT: 28234,
  INVALID_SELECTION_ITEM: 28235,
  INVALID_CHOICE_EFFECT_TYPE: 28236,
  REWARD_VALUE_NOT_MATCHED: 28237,
  SHIP_INVALID_GRADE: 28238,
  ENHANCE_MAX_LEVEL: 28239,
  INVALID_ENHANCE_GROUP_ID: 28240,
  IN_PROGRESS: 28241,
  ENHANCE_NOT_ENOUGH_POINT: 28242,
  NOT_ENOUGH_REROLL_COUNT: 28243,
  ZONE_EX_NOT_OPEN: 28244,
  ZONE_EX_UNABLE_TO_ENTER: 28245,
});

const STATE = Object.freeze({
  NONE: 0,
  START: 1,
  EXPLORING: 10,
  BATTLE_READY: 20,
  BATTLE_LOAD: 21,
  BATTLE: 22,
  SELECT_EVENT: 30,
  SELECT_REWARD: 40,
  SET_UNIT: 50,
  SET_OPERATOR: 60,
  UPGRADE_SHIP: 70,
  CLEAR: 80,
  ANNIHILATION: 90,
});

let cachedTables = null;

function createExploreHandlers() {
  return [
    { packetId: PACKETS.INFO_REQ, name: "EXPLORE_INFO_REQ", handle: handleInfo },
    { packetId: PACKETS.ENTER_REQ, name: "EXPLORE_ENTER_REQ", handle: handleEnter },
    { packetId: PACKETS.ENTER_EX_REQ, name: "EXPLORE_ENTER_EX_REQ", handle: handleEnterEx },
    { packetId: PACKETS.RESET_REQ, name: "EXPLORE_RESET_REQ", handle: handleReset },
    { packetId: PACKETS.MOVE_FORWARD_REQ, name: "EXPLORE_MOVE_FORWARD_REQ", handle: handleMoveForward },
    { packetId: PACKETS.REWARD_SELECT_REQ, name: "EXPLORE_REWARD_SELECT_REQ", handle: handleRewardSelect },
    { packetId: PACKETS.EVENT_SELECT_REQ, name: "EXPLORE_EVENT_SELECT_REQ", handle: handleEventSelect },
    { packetId: PACKETS.UNIT_CHANGE_REQ, name: "EXPLORE_UNIT_CHANGE_REQ", handle: handleUnitChange },
    { packetId: PACKETS.OPERATOR_CHANGE_REQ, name: "EXPLORE_OPERATOR_CHANGE_REQ", handle: handleOperatorChange },
    { packetId: PACKETS.SHIP_UPGRADE_REQ, name: "EXPLORE_SHIP_UPGRADE_REQ", handle: handleShipUpgrade },
    { packetId: PACKETS.ENHANCE_REQ, name: "EXPLORE_ENHANCE_REQ", handle: handleEnhance },
    { packetId: PACKETS.ENHANCE_RESET_REQ, name: "EXPLORE_ENHANCE_RESET_REQ", handle: handleEnhanceReset },
    { packetId: PACKETS.REROLL_REQ, name: "EXPLORE_REROLL_REQ", handle: handleReroll },
  ];
}

function handleInfo(ctx, socket, packet) {
  const request = decodeTempletRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = getExploreInfo(ctx, user, request);
  send(ctx, socket, packet, PACKETS.INFO_ACK, buildInfoAckPayload(result), "explore-info");
  return true;
}

function handleEnter(ctx, socket, packet) {
  const request = decodeTempletRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = enterExplore(ctx, user, request, false);
  send(ctx, socket, packet, PACKETS.ENTER_ACK, buildEnterAckPayload(result), "explore-enter");
  finishMutation(ctx, result.changed, "explore-enter");
  return true;
}

function handleEnterEx(ctx, socket, packet) {
  const request = decodeTempletRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = enterExplore(ctx, user, request, true);
  send(ctx, socket, packet, PACKETS.ENTER_EX_ACK, buildEnterAckPayload(result), "explore-enter-ex");
  finishMutation(ctx, result.changed, "explore-enter-ex");
  return true;
}

function handleReset(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = resetExplore(ctx, user, request);
  send(ctx, socket, packet, PACKETS.RESET_ACK, buildResetAckPayload(result), "explore-reset");
  finishMutation(ctx, result.changed, "explore-reset");
  return true;
}

function handleMoveForward(ctx, socket, packet) {
  const request = decodeIntRequest(ctx, packet.payload, "slotIndex");
  const user = getSocketUser(ctx, socket);
  const result = moveExploreForward(ctx, user, request);
  send(ctx, socket, packet, PACKETS.MOVE_FORWARD_ACK, buildStateAckPayload(result), "explore-move-forward");
  finishMutation(ctx, result.changed, "explore-move-forward");
  return true;
}

function handleRewardSelect(ctx, socket, packet) {
  const request = decodeSelectableRequest(ctx, packet.payload, true);
  const user = getSocketUser(ctx, socket);
  const result = selectExploreReward(ctx, user, request);
  send(ctx, socket, packet, PACKETS.REWARD_SELECT_ACK, buildSquadAckPayload(result), "explore-reward-select");
  finishMutation(ctx, result.changed, "explore-reward-select");
  return true;
}

function handleEventSelect(ctx, socket, packet) {
  const request = decodeSelectableRequest(ctx, packet.payload, false);
  const user = getSocketUser(ctx, socket);
  const result = selectExploreEvent(ctx, user, request);
  send(ctx, socket, packet, PACKETS.EVENT_SELECT_ACK, buildSquadAckPayload(result), "explore-event-select");
  finishMutation(ctx, result.changed, "explore-event-select");
  return true;
}

function handleUnitChange(ctx, socket, packet) {
  const request = decodeUnitChangeRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = changeExploreUnit(ctx, user, request);
  send(ctx, socket, packet, PACKETS.UNIT_CHANGE_ACK, buildUnitChangeAckPayload(result), "explore-unit-change");
  finishMutation(ctx, result.changed, "explore-unit-change");
  return true;
}

function handleOperatorChange(ctx, socket, packet) {
  const request = decodeOperatorChangeRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = changeExploreOperator(ctx, user, request);
  send(ctx, socket, packet, PACKETS.OPERATOR_CHANGE_ACK, buildOperatorChangeAckPayload(result), "explore-operator-change");
  finishMutation(ctx, result.changed, "explore-operator-change");
  return true;
}

function handleShipUpgrade(ctx, socket, packet) {
  const request = decodeShipUpgradeRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = upgradeExploreShip(ctx, user, request);
  send(ctx, socket, packet, PACKETS.SHIP_UPGRADE_ACK, buildShipUpgradeAckPayload(result), "explore-ship-upgrade");
  finishMutation(ctx, result.changed, "explore-ship-upgrade");
  return true;
}

function handleEnhance(ctx, socket, packet) {
  const request = decodeIntRequest(ctx, packet.payload, "enhanceGroup");
  const user = getSocketUser(ctx, socket);
  const result = enhanceExplore(ctx, user, request);
  send(ctx, socket, packet, PACKETS.ENHANCE_ACK, buildEnhanceAckPayload(result), "explore-enhance");
  finishMutation(ctx, result.changed, "explore-enhance");
  return true;
}

function handleEnhanceReset(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = resetExploreEnhance(ctx, user, request);
  send(ctx, socket, packet, PACKETS.ENHANCE_RESET_ACK, buildEnhanceResetAckPayload(result), "explore-enhance-reset");
  finishMutation(ctx, result.changed, "explore-enhance-reset");
  return true;
}

function handleReroll(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = rerollExploreReward(ctx, user, request);
  send(ctx, socket, packet, PACKETS.REROLL_ACK, buildRerollAckPayload(result), "explore-reroll");
  finishMutation(ctx, result.changed, "explore-reroll");
  return true;
}

function prepareExploreGameLoad(user, request = {}, stage = {}) {
  const isExplore = Number(request.exploreID || request.exploreId) > 0 || String(stage.miscMode || "").toLowerCase() === "explore";
  if (!isExplore) return null;
  const run = validateStoredRun({}, user);
  if (run.errorCode !== ERRORS.OK) return { valid: false, errorCode: run.errorCode };
  if (Number(run.state.state) !== STATE.BATTLE_READY) {
    return { valid: false, errorCode: ERRORS.PROCESSABLE_STATE };
  }
  const requestedExploreId = positiveInt(request.exploreID || request.exploreId);
  if (requestedExploreId && requestedExploreId !== run.templet.templetId) {
    return { valid: false, errorCode: ERRORS.INVALID_ID };
  }
  const currentStage = getCurrentStageRow(run.state);
  if (!currentStage) return { valid: false, errorCode: ERRORS.INVALID_STAGE };
  const expectedDungeonId = getExploreBattleDungeonId(run.state, currentStage);
  const requestedDungeonId = positiveInt(request.dungeonID || request.dungeonId || stage.dungeonID || stage.dungeonId);
  if (!expectedDungeonId || requestedDungeonId !== expectedDungeonId) {
    return { valid: false, errorCode: ERRORS.INVALID_STAGE };
  }
  return {
    valid: true,
    stage: {
      ...stage,
      dungeonID: expectedDungeonId,
      exploreID: run.templet.templetId,
      exploreStageId: currentStage.stageId,
      miscMode: "explore",
      gameType: 29,
    },
    playerDeck: buildExplorePlayerDeck(user, run.state),
  };
}

function recordExploreBattleResult(ctx, user, result = {}) {
  const run = validateStoredRun(ctx || {}, user);
  if (run.errorCode !== ERRORS.OK) return { valid: false, changed: false, errorCode: run.errorCode };
  const state = run.state;
  if (![STATE.BATTLE_READY, STATE.BATTLE_LOAD, STATE.BATTLE].includes(Number(state.state))) {
    return { valid: false, changed: false, errorCode: ERRORS.PROCESSABLE_STATE };
  }
  const stageRow = getCurrentStageRow(state);
  const dungeonId = positiveInt(result.dungeonId || result.dungeonID);
  if (!stageRow || !dungeonId || dungeonId !== getExploreBattleDungeonId(state, stageRow)) {
    return { valid: false, changed: false, errorCode: ERRORS.INVALID_STAGE };
  }

  const win = result.win === true && result.giveup !== true;
  if (!win) {
    const previousState = Number(state.state);
    if (Number.isFinite(Number(result.currentHp))) {
      state.currentHp = Math.max(0, Math.min(Number(state.maxHp) || 0, Number(result.currentHp)));
    }
    state.state = Number(state.currentHp) <= 0 ? STATE.ANNIHILATION : STATE.BATTLE_READY;
    return {
      valid: true,
      changed: previousState !== state.state || Number.isFinite(Number(result.currentHp)),
      state,
      squad: state.squad,
      enhancePoint: nonNegativeInt(state.enhancePoint),
    };
  }

  const stageNode = getCurrentStageNode(state);
  if (stageNode) stageNode.isClear = true;
  state.score = String(nonNegativeBigInt(state.score) + nonNegativeBigInt(result.scoreDelta));
  state.enhancePoint = Math.min(
    run.templet.enhancePointMax,
    nonNegativeInt(state.enhancePoint) + nonNegativeInt(result.enhancePointDelta)
  );
  if (stageRow.stageType === "EVENT_SELECTION") {
    const event = getTables().eventsById.get(Number(state.selectEvent));
    if (!event || event.eventType !== "DUNGEON_CLEAR") {
      return { valid: false, changed: false, errorCode: ERRORS.INVALID_CHOICE_EFFECT_TYPE };
    }
    applyEventOutcome(state, run.templet, { ...event, eventType: "INSTANT_REWARD" }, state.pendingEventReward || null);
    delete state.pendingEventReward;
  } else {
    const group = stageRow.rewardGroupId ? getTables().rewardGroups.get(stageRow.rewardGroupId) : null;
    const selectionList = group ? createRewardSelection(ctx || {}, state, group) : [];
    state.selectionList = selectionList;
    state.rewardValue = { id: 0, value: 0 };
    state.state = selectionList.length ? STATE.SELECT_REWARD : getPostStageState(state, run.templet);
  }
  return {
    valid: true,
    changed: true,
    state,
    squad: state.squad,
    enhancePoint: nonNegativeInt(state.enhancePoint),
  };
}

function buildExploreGameLoadFailurePayload(errorCode) {
  return Buffer.concat([
    writeSignedVarInt(Number(errorCode) || ERRORS.INVALID_STAGE),
    writeNullObject(),
    writeObjectList([]),
  ]);
}

function getExploreInfo(ctx, user, request) {
  const validated = validateRequest(ctx, request);
  if (validated.errorCode !== ERRORS.OK) return infoResult(validated.errorCode, null);
  const state = getStoredExplore(user, validated.templet.templetId) || createEmptyExplore(validated.templet.templetId);
  return infoResult(ERRORS.OK, withCanonicalRewardIds(user, state));
}

function enterExplore(ctx, user, request, enterEx) {
  const validated = validateRequest(ctx, request);
  if (validated.errorCode !== ERRORS.OK) return enterResult(validated.errorCode);
  const templet = validated.templet;
  const stored = getStoredExplore(user, templet.templetId);
  const existing = stored ? withCanonicalRewardIds(user, stored) : null;

  if (user && user.explore && !existing && isPlaying(user.explore)) {
    return enterResult(ERRORS.IN_PROGRESS);
  }

  if (enterEx) {
    if (!templet.exZoneId || !getTables().zonesById.has(templet.exZoneId)) {
      return enterResult(ERRORS.ZONE_EX_NOT_OPEN);
    }
    if (!canEnterEx(existing, templet)) return enterResult(ERRORS.ZONE_EX_UNABLE_TO_ENTER);
    const zone = createZone(ctx, templet, templet.exZoneId);
    if (!zone.ok) return enterResult(zone.errorCode);
    const state = startZone(existing, templet, zone.value, { preserveRun: true });
    user.explore = state;
    return enterResult(ERRORS.OK, state, true);
  }

  if (existing && isPlaying(existing) && !canAdvanceNormalZone(existing, templet)) {
    return enterResult(ERRORS.OK, existing, false);
  }

  const nextZoneId = getNextNormalZoneId(existing, templet);
  const zone = createZone(ctx, templet, nextZoneId);
  if (!zone.ok) return enterResult(zone.errorCode);
  const preserveRun = Boolean(
    existing &&
      (Number(existing.state) === STATE.CLEAR || canAdvanceNormalZone(existing, templet)) &&
      nextZoneId !== templet.zoneIds[0]
  );
  const state = startZone(existing, templet, zone.value, { preserveRun });
  user.explore = state;
  return enterResult(ERRORS.OK, state, true);
}

function resetExplore(ctx, user, request) {
  if (!request || !request.valid) return stateResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return stateResult(run.errorCode);
  if ([STATE.CLEAR, STATE.ANNIHILATION].includes(Number(run.state.state))) {
    return stateResult(ERRORS.STATE_IS_FINAL);
  }
  const state = run.state;
  state.seasonScore = String(nonNegativeBigInt(state.seasonScore) + nonNegativeBigInt(state.score));
  if (Number(state.currentZone) === Number(run.templet.exZoneId)) {
    state.scoreEX = String(nonNegativeBigInt(state.scoreEX) + nonNegativeBigInt(state.score));
  }
  state.selectionList = [];
  state.rewardValue = { id: 0, value: 0 };
  state.state = STATE.ANNIHILATION;
  return stateResult(ERRORS.OK, state, true, state.squad);
}

function moveExploreForward(ctx, user, request) {
  if (!request || !request.valid || request.slotIndex < 0) return stateResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return stateResult(run.errorCode);
  const state = run.state;
  if (![STATE.START, STATE.EXPLORING].includes(Number(state.state))) {
    return stateResult(ERRORS.PROCESSABLE_STATE);
  }
  const nextStep = Number(state.currentStep) + 1;
  const step = state.zone && Array.isArray(state.zone.steps) ? state.zone.steps[nextStep] : null;
  if (!step) return stateResult(ERRORS.INVALID_STAGE);
  const stage = (Array.isArray(step.stages) ? step.stages : []).find(
    (entry) => Number(entry && entry.slotIndex) === Number(request.slotIndex)
  );
  if (!stage) return stateResult(ERRORS.INVALID_STAGE);
  if (!isReachableSlot(state, request.slotIndex)) return stateResult(ERRORS.MOVEABLE_PATH);
  const stageRow = getTables().stagesById.get(Number(stage.stageId));
  if (!stageRow) return stateResult(ERRORS.STAGE_TEMPLET_IS_NULL);
  let selectionList = [];
  if (stageRow.stageType === "EVENT_SELECTION") {
    const events = getTables().eventGroups.get(stageRow.eventValue) || [];
    if (!events.length) return stateResult(ERRORS.INVALID_STAGE_TYPE);
    selectionList = events.map((event) => ({ id: event.eventId, value: 0 }));
  } else if (!isBattleStage(stageRow)) {
    return stateResult(ERRORS.INVALID_STAGE_TYPE);
  }

  state.currentStep = nextStep;
  state.currentSlotIndex = Number(request.slotIndex);
  state.clearStageIndexList = (Array.isArray(state.clearStageIndexList) ? state.clearStageIndexList : []).slice(0, nextStep);
  state.clearStageIndexList[nextStep] = Number(request.slotIndex);
  state.selectionList = selectionList;
  state.selectEvent = 0;
  state.rewardValue = { id: 0, value: 0 };
  state.state = stageRow.stageType === "EVENT_SELECTION" ? STATE.SELECT_EVENT : STATE.BATTLE_READY;
  return stateResult(ERRORS.OK, state, true, state.squad);
}

function selectExploreEvent(ctx, user, request) {
  if (!request || !request.valid || request.choice.id <= 0 || request.choice.value !== 0) {
    return stateResult(ERRORS.INVALID_REQUEST);
  }
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return stateResult(run.errorCode);
  const state = run.state;
  if (Number(state.state) !== STATE.SELECT_EVENT) return stateResult(ERRORS.PROCESSABLE_STATE);
  const stageRow = getCurrentStageRow(state);
  if (!stageRow || stageRow.stageType !== "EVENT_SELECTION") return stateResult(ERRORS.INVALID_STAGE_TYPE);
  if (!hasSelectableItem(state.selectionList, request.choice)) return stateResult(ERRORS.INVALID_SELECTION_ITEM);
  const event = getTables().eventsById.get(request.choice.id);
  if (!event || event.eventGroupId !== stageRow.eventValue) return stateResult(ERRORS.INVALID_SELECTION_ITEM);
  if (!canSelectEvent(state, event)) return stateResult(ERRORS.INVALID_SELECTION_ITEM);
  const rewardItem = prepareEventReward(ctx, state, event);
  if (!rewardItem.ok) return stateResult(rewardItem.errorCode);

  state.selectionList = [];
  state.selectEvent = event.eventId;
  state.rewardValue = { id: 0, value: 0 };
  applyEventOutcome(state, run.templet, event, rewardItem.value);
  return stateResult(ERRORS.OK, state, true, state.squad);
}

function selectExploreReward(ctx, user, request) {
  if (!request || !request.valid) return stateResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return stateResult(run.errorCode);
  const state = run.state;
  if (Number(state.state) !== STATE.SELECT_REWARD) return stateResult(ERRORS.PROCESSABLE_STATE);
  const group = getCurrentRewardGroup(state);
  if (!group) return stateResult(ERRORS.INVALID_REWARD_TYPE);
  if (request.skip) {
    if (request.choice.id !== 0 || request.choice.value !== 0) return stateResult(ERRORS.INVALID_SELECTION_ITEM);
    state.selectionList = [];
    state.rewardValue = { id: 0, value: 0 };
    state.state = getPostStageState(state, run.templet);
    return stateResult(ERRORS.OK, state, true, state.squad);
  }
  if (!hasSelectableItem(state.selectionList, request.choice)) return stateResult(ERRORS.INVALID_SELECTION_ITEM);
  const selected = group.rows.find((row) => rewardMatchesRow(row, request.choice));
  if (!selected) return stateResult(ERRORS.REWARD_VALUE_NOT_MATCHED);
  if (!["RT_UNIT", "RT_ARTIFACT", "RT_OPERATOR"].includes(group.rewardType)) {
    return stateResult(ERRORS.INVALID_REWARD_TYPE);
  }
  if (group.rewardType === "RT_ARTIFACT" && uniqueInts(state.artifacts).includes(request.choice.id)) {
    return stateResult(ERRORS.ADD_ARTIFACT);
  }

  state.selectionList = [];
  state.rewardValue = { ...request.choice };
  if (group.rewardType === "RT_UNIT") {
    state.state = addExploreUnit(state, run.templet, request.choice)
      ? getPostStageState(state, run.templet)
      : STATE.SET_UNIT;
  } else if (group.rewardType === "RT_ARTIFACT") {
    state.artifacts = uniqueInts([...(state.artifacts || []), request.choice.id]);
    state.state = getPostStageState(state, run.templet);
  } else if (group.rewardType === "RT_OPERATOR") {
    state.state = addExploreOperator(state, request.choice)
      ? getPostStageState(state, run.templet)
      : STATE.SET_OPERATOR;
  } else {
    return stateResult(ERRORS.INVALID_REWARD_TYPE);
  }
  return stateResult(ERRORS.OK, state, true, state.squad);
}

function rerollExploreReward(ctx, user, request) {
  if (!request || !request.valid) return rerollResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return rerollResult(run.errorCode);
  const state = run.state;
  if (Number(state.state) !== STATE.SELECT_REWARD) return rerollResult(ERRORS.PROCESSABLE_STATE);
  if (nonNegativeInt(state.rerollCount) <= 0) return rerollResult(ERRORS.NOT_ENOUGH_REROLL_COUNT);
  const group = getCurrentRewardGroup(state);
  if (!group) return rerollResult(ERRORS.INVALID_REWARD_TYPE);
  const selectionList = createRewardSelection(ctx, state, group);
  if (!selectionList.length) return rerollResult(ERRORS.INVALID_REWARD_TYPE);
  state.rerollCount = nonNegativeInt(state.rerollCount) - 1;
  state.selectionList = selectionList;
  return rerollResult(ERRORS.OK, state.rerollCount, selectionList, true);
}

function changeExploreUnit(ctx, user, request) {
  if (!request || !request.valid) return squadChangeResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return squadChangeResult(run.errorCode);
  const state = run.state;
  if (Number(state.state) !== STATE.SET_UNIT) return squadChangeResult(ERRORS.PROCESSABLE_STATE);
  if (!selectableEquals(request.choice, state.rewardValue)) {
    return squadChangeResult(ERRORS.REWARD_VALUE_NOT_MATCHED);
  }
  if (!getTables().unitRewardIds.has(Number(request.choice.id))) {
    return squadChangeResult(ERRORS.INVALID_SELECTION_ITEM);
  }

  if (request.skip) {
    if (request.targetUid !== 0n) return squadChangeResult(ERRORS.INVALID_SELECTION_ITEM);
  } else {
    if (request.targetUid <= 0n) return squadChangeResult(ERRORS.INVALID_SELECTION_ITEM);
    const uid = String(request.targetUid);
    const current = state.squad.units && state.squad.units[uid];
    if (!current) return squadChangeResult(ERRORS.UNIT_UPDATE);
    const skillLevel = getExploreUnitSkillLevel(request.choice.id);
    const replacement = createUnitData({ userUid: current.userUid || "0" }, request.choice.id, request.targetUid, {
      level: Math.max(1, positiveInt(current.level) || 1),
      exp: nonNegativeInt(current.exp),
      limitBreakLevel: nonNegativeInt(current.limitBreakLevel),
      skillLevels: [skillLevel, skillLevel, skillLevel, skillLevel, skillLevel],
      skinId: nonNegativeInt(request.choice.value),
      tacticLevel: nonNegativeInt(current.tacticLevel),
      reactorLevel: nonNegativeInt(current.reactorLevel),
      loyalty: nonNegativeInt(current.loyalty),
      fromContract: false,
      regDate: String(current.regDate || "5250083637907387904"),
    });
    state.squad.units[uid] = replacement;
    state.deck = createExploreDeck(state.squad);
  }

  finishPendingSquadChoice(state, run.templet);
  return squadChangeResult(ERRORS.OK, state, true);
}

function changeExploreOperator(ctx, user, request) {
  if (!request || !request.valid) return squadChangeResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return squadChangeResult(run.errorCode);
  const state = run.state;
  if (Number(state.state) !== STATE.SET_OPERATOR) return squadChangeResult(ERRORS.PROCESSABLE_STATE);
  if (!selectableEquals(request.choice, state.rewardValue)) {
    return squadChangeResult(ERRORS.REWARD_VALUE_NOT_MATCHED);
  }
  if (!getTables().operatorRewardIds.has(Number(request.choice.id))) {
    return squadChangeResult(ERRORS.INVALID_SELECTION_ITEM);
  }

  if (!request.skip) {
    const current = state.squad.operator;
    const currentUid = parsePositiveBigInt(current && current.uid);
    if (!current || positiveInt(current.id || current.unitId) <= 0 || currentUid <= 0n) {
      return squadChangeResult(ERRORS.UNIT_UPDATE);
    }
    const replacement = createDefaultOperator(request.choice.id, currentUid, request.choice.value);
    replacement.level = Math.max(1, positiveInt(current.level) || 1);
    replacement.exp = nonNegativeInt(current.exp);
    state.squad.operator = replacement;
    state.deck = createExploreDeck(state.squad);
  }

  finishPendingSquadChoice(state, run.templet);
  return squadChangeResult(ERRORS.OK, state, true);
}

function upgradeExploreShip(ctx, user, request) {
  if (!request || !request.valid) return shipUpgradeResult(ERRORS.INVALID_REQUEST);
  const run = validateStoredRun(ctx, user);
  if (run.errorCode !== ERRORS.OK) return shipUpgradeResult(run.errorCode);
  const state = run.state;
  if (Number(state.state) !== STATE.UPGRADE_SHIP) return shipUpgradeResult(ERRORS.PROCESSABLE_STATE);

  if (request.skip) {
    if (request.shipId !== 0) return shipUpgradeResult(ERRORS.INVALID_SELECTION_ITEM);
  } else {
    if (request.shipId <= 0) return shipUpgradeResult(ERRORS.INVALID_SELECTION_ITEM);
    const current = state.squad.ship;
    const currentUid = parsePositiveBigInt(current && current.unitUid);
    if (currentUid <= 0n) return shipUpgradeResult(ERRORS.INVALID_SQUAD);
    const choices = getNextShipUpgradeChoices(run.templet, positiveInt(current && current.unitId));
    if (!choices) return shipUpgradeResult(ERRORS.SHIP_INVALID_GRADE);
    if (!choices.has(request.shipId)) return shipUpgradeResult(ERRORS.INVALID_SELECTION_ITEM);
    const replacement = createUnitData({ userUid: current.userUid || "0" }, request.shipId, currentUid, {
      level: Math.max(1, positiveInt(current.level) || 1),
      exp: nonNegativeInt(current.exp),
      limitBreakLevel: nonNegativeInt(current.limitBreakLevel),
      skillLevels: Array.isArray(current.skillLevels) ? current.skillLevels : [5, 5, 5, 5, 5],
      skinId: 0,
      tacticLevel: nonNegativeInt(current.tacticLevel),
      reactorLevel: nonNegativeInt(current.reactorLevel),
      loyalty: nonNegativeInt(current.loyalty),
      fromContract: false,
      regDate: String(current.regDate || "5250083637907387904"),
    });
    state.squad.ship = replacement;
    state.deck = createExploreDeck(state.squad);
  }

  finishPendingSquadChoice(state, run.templet);
  return shipUpgradeResult(ERRORS.OK, state, true);
}

function enhanceExplore(ctx, user, request) {
  if (!request || !request.valid || request.enhanceGroup <= 0) return enhanceResult(ERRORS.INVALID_REQUEST);
  const season = validateEnhanceSeason(ctx, user);
  if (season.errorCode !== ERRORS.OK) return enhanceResult(season.errorCode);
  if (isPlaying(season.state)) return enhanceResult(ERRORS.IN_PROGRESS);
  const rows = getTables().enhanceGroups.get(`${season.templet.seasonEnhanceGroupId}:${request.enhanceGroup}`);
  if (!rows) return enhanceResult(ERRORS.INVALID_ENHANCE_GROUP_ID);
  const currentLevel = nonNegativeInt(season.state.enhance && season.state.enhance[String(request.enhanceGroup)]);
  const next = rows.find((row) => row.level === currentLevel + 1);
  if (!next) return enhanceResult(ERRORS.ENHANCE_MAX_LEVEL);
  if (nonNegativeInt(season.state.enhancePoint) < next.price) {
    return enhanceResult(ERRORS.ENHANCE_NOT_ENOUGH_POINT);
  }

  const state = attachEnhanceState(user, season);
  state.enhance = normalizeEnhance(state.enhance);
  state.enhance[String(request.enhanceGroup)] = next.level;
  state.enhancePoint = nonNegativeInt(state.enhancePoint) - next.price;
  return enhanceResult(ERRORS.OK, request.enhanceGroup, next.level, next.enhanceId, state.enhancePoint, true);
}

function resetExploreEnhance(ctx, user, request) {
  if (!request || !request.valid) return enhanceResetResult(ERRORS.INVALID_REQUEST);
  const season = validateEnhanceSeason(ctx, user);
  if (season.errorCode !== ERRORS.OK) return enhanceResetResult(season.errorCode);
  if (isPlaying(season.state)) return enhanceResetResult(ERRORS.IN_PROGRESS);
  let refund = 0;
  for (const [groupId, level] of Object.entries(normalizeEnhance(season.state.enhance))) {
    const rows = getTables().enhanceGroups.get(`${season.templet.seasonEnhanceGroupId}:${groupId}`);
    if (!rows || !rows.some((row) => row.level === level)) return enhanceResetResult(ERRORS.INVALID_ENHANCE_GROUP_ID);
    refund += rows.filter((row) => row.level <= level).reduce((sum, row) => sum + row.price, 0);
  }
  if (refund === 0) {
    return enhanceResetResult(ERRORS.OK, normalizeEnhance(season.state.enhance), season.state.enhancePoint, false);
  }

  const state = attachEnhanceState(user, season);
  state.enhance = {};
  state.enhancePoint = nonNegativeInt(state.enhancePoint) + refund;
  return enhanceResetResult(ERRORS.OK, state.enhance, state.enhancePoint, true);
}

function finishPendingSquadChoice(state, templet) {
  state.rewardValue = { id: 0, value: 0 };
  state.selectionList = [];
  state.state = getPostStageState(state, templet);
}

function getNextShipUpgradeChoices(templet, currentShipId) {
  const groups = Array.isArray(templet.shipUpgradeGroups) ? templet.shipUpgradeGroups : [];
  if (!groups.length) return null;
  let nextIndex = currentShipId === templet.defaultShipId ? 0 : -1;
  for (let index = 0; index < groups.length; index += 1) {
    const group = getTables().rewardGroups.get(groups[index]);
    if (group && group.rows.some((row) => row.rewardId === currentShipId)) nextIndex = index + 1;
  }
  if (nextIndex < 0 || nextIndex >= groups.length) return null;
  const next = getTables().rewardGroups.get(groups[nextIndex]);
  return next && next.rewardType === "RT_SHIP" ? new Set(next.rows.map((row) => row.rewardId)) : null;
}

function validateEnhanceSeason(ctx, user) {
  const stored = user && user.explore;
  let templet = stored && getTables().templetsById.get(Number(stored.templetId));
  if (templet && !isExploreActive(ctx, templet)) return { errorCode: ERRORS.DISABLED };
  if (!templet) {
    templet = Array.from(getTables().templetsById.values()).find((candidate) => isExploreActive(ctx, candidate));
  }
  if (!templet) return { errorCode: ERRORS.TEMPLET_IS_NULL };
  const state = stored && Number(stored.templetId) === templet.templetId ? stored : createEmptyExplore(templet.templetId);
  return { errorCode: ERRORS.OK, state, templet, attached: state === stored };
}

function attachEnhanceState(user, season) {
  if (!season.attached && user) user.explore = season.state;
  return season.state;
}

function validateRequest(ctx, request) {
  if (!request || !request.valid || request.templetId <= 0) return { errorCode: ERRORS.INVALID_REQUEST };
  const templet = getTables().templetsById.get(request.templetId);
  if (!templet) return { errorCode: ERRORS.TEMPLET_IS_NULL };
  if (!isExploreActive(ctx, templet)) return { errorCode: ERRORS.DISABLED };
  if (!templet.zoneIds.length || templet.zoneIds.some((zoneId) => !getTables().zonesById.has(zoneId))) {
    return { errorCode: ERRORS.ZONE_TEMPLET_IS_NULL };
  }
  return { errorCode: ERRORS.OK, templet };
}

function createEmptyExplore(templetId) {
  return {
    templetId,
    maxHp: 0,
    currentHp: 0,
    seasonScore: "0",
    score: "0",
    currentZone: -1,
    currentStep: -1,
    currentSlotIndex: -1,
    artifacts: [],
    selectionList: [],
    selectEvent: 0,
    rewardValue: { id: 0, value: 0 },
    clearStageIndexList: [],
    state: STATE.NONE,
    rerollCount: 0,
    scoreEX: "0",
    rewardIds: [],
    enhance: {},
    enhancePoint: 0,
    zone: null,
    squad: null,
    deck: null,
  };
}

function startZone(previous, templet, zone, options = {}) {
  const preserveRun = Boolean(options.preserveRun && previous);
  const seasonal = withCanonicalRewardIds(null, previous || createEmptyExplore(templet.templetId));
  const squad = preserveRun && validSquad(previous.squad) ? previous.squad : createDefaultSquad(templet);
  return {
    ...createEmptyExplore(templet.templetId),
    maxHp: preserveRun ? positiveNumber(previous.maxHp, 100) : 100,
    currentHp: preserveRun ? positiveNumber(previous.currentHp, 100) : 100,
    seasonScore: String(nonNegativeBigInt(seasonal.seasonScore)),
    score: preserveRun ? String(nonNegativeBigInt(previous.score)) : "0",
    currentZone: zone.zoneId,
    currentStep: -1,
    currentSlotIndex: 0,
    artifacts: preserveRun ? uniqueInts(previous.artifacts) : [],
    state: STATE.START,
    rerollCount: preserveRun ? nonNegativeInt(previous.rerollCount) : nonNegativeInt(templet.rerollCount),
    scoreEX: preserveRun ? String(nonNegativeBigInt(previous.scoreEX)) : "0",
    rewardIds: uniqueInts(seasonal.rewardIds),
    enhance: normalizeEnhance(seasonal.enhance),
    enhancePoint: nonNegativeInt(seasonal.enhancePoint),
    zone,
    squad,
    deck: createExploreDeck(squad),
  };
}

function getNextNormalZoneId(state, templet) {
  if (!state || (Number(state.state) !== STATE.CLEAR && !canAdvanceNormalZone(state, templet))) {
    return templet.zoneIds[0];
  }
  const index = templet.zoneIds.indexOf(Number(state.currentZone));
  return index >= 0 && index + 1 < templet.zoneIds.length ? templet.zoneIds[index + 1] : templet.zoneIds[0];
}

function canEnterEx(state, templet) {
  return Boolean(
    state &&
      Number(state.state) === STATE.CLEAR &&
      Number(state.currentZone) === templet.zoneIds[templet.zoneIds.length - 1] &&
      Number(state.currentStep) === Number(getTables().zonesById.get(Number(state.currentZone)).stepCount) - 1
  );
}

function canAdvanceNormalZone(state, templet) {
  if (!state || Number(state.state) !== STATE.EXPLORING || !isAtEndOfZone(state)) return false;
  const zoneId = Number(state.currentZone);
  return templet.zoneIds.includes(zoneId) && zoneId !== templet.zoneIds[templet.zoneIds.length - 1];
}

function validateStoredRun(ctx, user) {
  const state = user && user.explore;
  if (!state || Number(state.currentZone) < 0) return { errorCode: ERRORS.IS_EMPTY };
  const templet = getTables().templetsById.get(Number(state.templetId));
  if (!templet) return { errorCode: ERRORS.TEMPLET_IS_NULL };
  if (!isExploreActive(ctx, templet)) return { errorCode: ERRORS.DISABLED };
  const zone = getTables().zonesById.get(Number(state.currentZone));
  if (!zone || !state.zone || Number(state.zone.zoneId) !== Number(state.currentZone)) {
    return { errorCode: ERRORS.INVALID_ZONE };
  }
  if (!validSquad(state.squad)) return { errorCode: ERRORS.INVALID_SQUAD };
  return { errorCode: ERRORS.OK, state, templet, zone };
}

function isReachableSlot(state, targetSlot) {
  const currentStep = Number(state.currentStep);
  if (currentStep < 0) return true;
  const current = state.zone && state.zone.steps && state.zone.steps[currentStep];
  const currentStage = current && Array.isArray(current.stages)
    ? current.stages.find((stage) => Number(stage.slotIndex) === Number(state.currentSlotIndex))
    : null;
  const path = currentStage && getTables().pathsById.get(Number(currentStage.pathId));
  return Boolean(path && path.moveable.includes(Number(targetSlot)));
}

function getCurrentStageRow(state) {
  const step = state && state.zone && Array.isArray(state.zone.steps)
    ? state.zone.steps[Number(state.currentStep)]
    : null;
  const stage = step && Array.isArray(step.stages)
    ? step.stages.find((entry) => Number(entry.slotIndex) === Number(state.currentSlotIndex))
    : null;
  return stage ? getTables().stagesById.get(Number(stage.stageId)) || null : null;
}

function getCurrentStageNode(state) {
  const step = state && state.zone && Array.isArray(state.zone.steps)
    ? state.zone.steps[Number(state.currentStep)]
    : null;
  return step && Array.isArray(step.stages)
    ? step.stages.find((entry) => Number(entry.slotIndex) === Number(state.currentSlotIndex)) || null
    : null;
}

function getExploreBattleDungeonId(state, stageRow = getCurrentStageRow(state)) {
  if (!stageRow) return 0;
  if (isBattleStage(stageRow)) return positiveInt(stageRow.eventValue);
  if (stageRow.stageType !== "EVENT_SELECTION") return 0;
  const event = getTables().eventsById.get(Number(state.selectEvent));
  return event && event.eventType === "DUNGEON_CLEAR" ? positiveInt(event.eventValue) : 0;
}

function buildExplorePlayerDeck(user, state) {
  const squad = state && state.squad || {};
  const unitUids = Array.isArray(state && state.deck && state.deck.unitUids)
    ? state.deck.unitUids
    : Object.keys(squad.units || {});
  const units = unitUids.slice(0, 4).map((uid, slotIndex) => {
    const unit = squad.units && squad.units[String(uid)];
    if (!unit) return null;
    return {
      slotIndex,
      unitUid: String(unit.unitUid || uid),
      unitId: positiveInt(unit.unitId),
      level: Math.max(1, positiveInt(unit.level) || 1),
      skinId: nonNegativeInt(unit.skinId),
      limitBreakLevel: nonNegativeInt(unit.limitBreakLevel),
      tacticLevel: nonNegativeInt(unit.tacticLevel),
      tacticGroup: 0,
      skillLevels: Array.isArray(unit.skillLevels) ? unit.skillLevels.slice(0, 5).map((level) => Math.max(1, positiveInt(level))) : [5, 5, 5, 5, 5],
      equipItemUids: ["0", "0", "0", "0"],
    };
  }).filter(Boolean);
  const ship = squad.ship || {};
  const operator = squad.operator || {};
  const leaderIndex = units.length ? Math.max(0, Math.min(units.length - 1, nonNegativeInt(state.deck && state.deck.leaderIndex))) : -1;
  return units.length ? {
    userUid: String(user && user.userUid || "0"),
    nickname: String(user && user.nickname || "LocalAdmin"),
    userLevel: Math.max(1, positiveInt(user && user.level) || 1),
    deckType: 10,
    deckIndex: 0,
    leaderIndex,
    leaderUnitUid: leaderIndex >= 0 ? units[leaderIndex].unitUid : "0",
    shipUid: String(ship.unitUid || "0"),
    shipUnitId: positiveInt(ship.unitId),
    shipLevel: Math.max(1, positiveInt(ship.level) || 1),
    shipSkinId: nonNegativeInt(ship.skinId),
    operatorUid: String(operator.uid || "0"),
    operatorId: positiveInt(operator.id || operator.unitId),
    operatorLevel: Math.max(1, positiveInt(operator.level) || 1),
    equipItems: [],
    units,
  } : null;
}

function getCurrentRewardGroup(state) {
  const stage = getCurrentStageRow(state);
  return stage && stage.rewardGroupId ? getTables().rewardGroups.get(stage.rewardGroupId) || null : null;
}

function isBattleStage(stage) {
  return Boolean(stage && (stage.stageType === "DUNGEON" || stage.stageType === "BOSS_DUNGEON"));
}

function isAtEndOfZone(state) {
  const zone = getTables().zonesById.get(Number(state && state.currentZone));
  return Boolean(zone && Number(state.currentStep) === zone.stepCount - 1);
}

function getPostStageState(state, templet) {
  if (Number(state.currentHp) <= 0) return STATE.ANNIHILATION;
  if (!isAtEndOfZone(state)) return STATE.EXPLORING;
  const zoneId = Number(state.currentZone);
  if (zoneId === Number(templet.exZoneId) || zoneId === Number(templet.zoneIds[templet.zoneIds.length - 1])) {
    return STATE.CLEAR;
  }
  return STATE.EXPLORING;
}

function canSelectEvent(state, event) {
  if (!event.unlockReqType) return true;
  if (event.unlockReqType === "UNIT_CHECK") {
    return Object.values(state.squad && state.squad.units || {}).some(
      (unit) => Number(unit && unit.unitId) === event.unlockReqValue
    );
  }
  if (event.unlockReqType === "ARTIFACT_CHECK") {
    return uniqueInts(state.artifacts).includes(event.unlockReqValue);
  }
  return false;
}

function prepareEventReward(ctx, state, event) {
  if (!["UNIT_GET", "OPERATOR_GET", "ARTIFACT_GET"].includes(event.rewardType)) {
    return { ok: true, value: null };
  }
  const group = getTables().rewardGroups.get(event.rewardValue);
  if (!group) return { ok: false, errorCode: ERRORS.INVALID_REWARD_TYPE };
  const rows = group.rewardType === "RT_ARTIFACT"
    ? group.rows.filter((row) => !uniqueInts(state.artifacts).includes(row.rewardId))
    : group.rows;
  const row = pickWeighted(ctx, rows);
  return row
    ? { ok: true, value: makeSelectableItem(ctx, row) }
    : { ok: false, errorCode: group.rewardType === "RT_ARTIFACT" ? ERRORS.ADD_ARTIFACT : ERRORS.INVALID_REWARD_TYPE };
}

function applyEventOutcome(state, templet, event, rewardItem) {
  if (event.eventType === "DUNGEON_CLEAR") {
    state.pendingEventReward = rewardItem ? { ...rewardItem } : null;
    state.state = STATE.BATTLE_READY;
    return;
  }

  if (event.eventType === "SHIP_BREAK") {
    const damage = Math.max(0, Number(state.maxHp) || 0) * Math.max(0, event.eventValue) / 100;
    state.currentHp = Math.max(0, Number(state.currentHp) - damage);
  }
  const nextState = () => getPostStageState(state, templet);
  if (!event.rewardType || event.rewardType === "NONE") {
    state.state = nextState();
    return;
  }

  if (event.rewardType === "UNIT_GET" && rewardItem) {
    state.rewardValue = { ...rewardItem };
    state.state = addExploreUnit(state, templet, rewardItem) ? nextState() : STATE.SET_UNIT;
    return;
  }
  if (event.rewardType === "OPERATOR_GET" && rewardItem) {
    state.rewardValue = { ...rewardItem };
    state.state = addExploreOperator(state, rewardItem) ? nextState() : STATE.SET_OPERATOR;
    return;
  }
  if (event.rewardType === "ARTIFACT_GET" && rewardItem) {
    state.rewardValue = { ...rewardItem };
    state.artifacts = uniqueInts([...(state.artifacts || []), rewardItem.id]);
    state.state = nextState();
    return;
  }
  if (event.rewardType === "UNIT_UPGRADE") {
    for (const unit of Object.values(state.squad.units || {})) {
      unit.level = Math.min(120, nonNegativeInt(unit.level) + Math.max(1, event.rewardValue));
    }
    state.rewardValue = { id: 0, value: Math.max(1, event.rewardValue) };
    state.state = nextState();
    return;
  }
  if (event.rewardType === "SHIP_REPAIR") {
    const heal = Math.max(0, Number(state.maxHp) || 0) * Math.max(0, event.rewardValue) / 100;
    state.currentHp = Math.min(Number(state.maxHp) || 0, Number(state.currentHp) + heal);
    state.rewardValue = { id: Number(state.squad.ship && state.squad.ship.unitId) || 0, value: event.rewardValue };
    state.state = nextState();
    return;
  }
  if (event.rewardType === "SHIP_UPGRADE") {
    state.rewardValue = { id: 0, value: event.rewardValue };
    state.state = STATE.UPGRADE_SHIP;
    return;
  }
  state.state = STATE.ANNIHILATION;
}

function createRewardSelection(ctx, state, group) {
  const rows = group.rewardType === "RT_ARTIFACT"
    ? group.rows.filter((row) => !uniqueInts(state.artifacts).includes(row.rewardId))
    : group.rows;
  return pickDistinctWeighted(ctx, rows, Math.min(4, rows.length)).map((row) => makeSelectableItem(ctx, row));
}

function makeSelectableItem(ctx, row) {
  const skills = Array.isArray(row && row.randomOperatorSkills) ? row.randomOperatorSkills : [];
  return {
    id: Number(row && row.rewardId) || 0,
    value: skills.length ? skills[randomBelow(ctx, skills.length)] : 0,
  };
}

function rewardMatchesRow(row, choice) {
  if (Number(row && row.rewardId) !== Number(choice && choice.id)) return false;
  const skills = Array.isArray(row.randomOperatorSkills) ? row.randomOperatorSkills : [];
  return skills.length ? skills.includes(Number(choice.value)) : Number(choice.value) === 0;
}

function hasSelectableItem(list, choice) {
  return (Array.isArray(list) ? list : []).some((item) => selectableEquals(item, choice));
}

function selectableEquals(left, right) {
  return Boolean(left && right && Number(left.id) === Number(right.id) && Number(left.value) === Number(right.value));
}

function addExploreUnit(state, templet, item) {
  const units = state.squad && state.squad.units || {};
  if (Object.keys(units).length >= Math.max(1, templet.unitHaveCount)) return false;
  const first = Object.values(units)[0] || {};
  const uid = nextExploreUid(state);
  const unit = createUnitData({ userUid: "0" }, item.id, uid, {
    level: Math.max(1, nonNegativeInt(first.level) || 100),
    limitBreakLevel: nonNegativeInt(first.limitBreakLevel || first.limitBreak),
    skillLevels: [5, 5, 5, 5, 5],
    skinId: nonNegativeInt(item.value),
    fromContract: false,
    regDate: "5250083637907387904",
  });
  units[unit.unitUid] = unit;
  state.deck = createExploreDeck(state.squad);
  return true;
}

function addExploreOperator(state, item) {
  if (state.squad.operator) return false;
  state.squad.operator = createDefaultOperator(item.id, nextExploreUid(state), item.value);
  state.deck = createExploreDeck(state.squad);
  return true;
}

function nextExploreUid(state) {
  const values = [state.squad && state.squad.ship && state.squad.ship.unitUid, state.squad && state.squad.operator && state.squad.operator.uid];
  values.push(...Object.keys(state.squad && state.squad.units || {}));
  let maximum = EXPLORE_UID_BASE + BigInt(Number(state.templetId) || 0) * 100n;
  for (const value of values) {
    try {
      const uid = BigInt(value || 0);
      if (uid > maximum) maximum = uid;
    } catch (_) {}
  }
  return maximum + 1n;
}

function getExploreUnitSkillLevel(unitId) {
  const templet = getUnitTemplet(unitId) || {};
  if (positiveInt(templet.m_RearmGrade) > 0) return 10;
  return String(templet.m_NKM_UNIT_TYPE || "").toUpperCase() === "NUT_OPERATOR" ? 8 : 5;
}

function isPlaying(state) {
  const value = Number(state && state.state);
  return value !== STATE.NONE && value !== STATE.CLEAR && value !== STATE.ANNIHILATION;
}

function getStoredExplore(user, templetId) {
  const state = user && user.explore;
  return state && Number(state.templetId) === Number(templetId) ? state : null;
}

function createDefaultSquad(templet) {
  const base = EXPLORE_UID_BASE + BigInt(templet.templetId) * 100n;
  const user = { userUid: "0" };
  const regDate = "5250083637907387904";
  const ship = createUnitData(user, templet.defaultShipId, base + 1n, {
    level: 100,
    limitBreakLevel: 3,
    skillLevels: [5, 5, 5, 5, 5],
    fromContract: false,
    regDate,
  });
  const units = {};
  templet.defaultUnitIds.forEach((unitId, index) => {
    const unit = createUnitData(user, unitId, base + BigInt(index + 2), {
      level: 100,
      limitBreakLevel: 3,
      skillLevels: [5, 5, 5, 5, 5],
      fromContract: false,
      regDate,
    });
    units[unit.unitUid] = unit;
  });
  const operator = templet.defaultOperatorId > 0
    ? createDefaultOperator(templet.defaultOperatorId, base + BigInt(templet.defaultUnitIds.length + 2))
    : null;
  return { operator, ship, units };
}

function createDefaultOperator(unitId, uid, subSkillId = 1002) {
  return {
    id: unitId,
    uid: String(uid),
    level: 100,
    exp: 0,
    locked: false,
    mainSkill: { id: getOperatorMainSkillId(unitId) || 1001, level: 8, exp: 0 },
    subSkill: { id: positiveInt(subSkillId) || 1002, level: 8, exp: 0 },
    fromContract: false,
  };
}

function createExploreDeck(squad) {
  const unitUids = Object.keys(squad.units || {}).sort((left, right) => Number(BigInt(left) - BigInt(right)));
  return {
    name: "",
    shipUid: squad.ship ? squad.ship.unitUid : 0,
    operatorUid: squad.operator ? squad.operator.uid : 0,
    unitUids,
    leaderIndex: unitUids.length ? 0 : -1,
    state: 0,
  };
}

function createZone(ctx, templet, zoneId) {
  const tables = getTables();
  const zone = tables.zonesById.get(Number(zoneId));
  if (!zone) return { ok: false, errorCode: ERRORS.ZONE_TEMPLET_IS_NULL };
  const steps = [];
  for (let index = 0; index < zone.steps.length; index += 1) {
    const step = zone.steps[index];
    const candidates = tables.stagesByGroup.get(step.stageGroupId) || [];
    if (candidates.length < step.slotCount) return { ok: false, errorCode: ERRORS.STAGE_TEMPLET_IS_NULL };
    const selected = pickDistinctWeighted(ctx, candidates, step.slotCount);
    if (selected.length !== step.slotCount) return { ok: false, errorCode: ERRORS.STAGE_CREATE };
    const nextSlotCount = index + 1 < zone.steps.length ? zone.steps[index + 1].slotCount : 0;
    const stages = selected.map((row, slotIndex) => {
      const pathId = nextSlotCount > 0 ? pickPathId(ctx, templet.pathGroupId, step.slotCount, nextSlotCount, slotIndex) : 0;
      return pathId < 0 ? null : { stageId: row.stageId, slotIndex, pathId, isClear: false };
    });
    if (stages.some((stage) => !stage)) return { ok: false, errorCode: ERRORS.ZONE_CREATE };
    steps.push({ step: index, stages });
  }
  return { ok: true, value: { zoneId: zone.zoneId, steps } };
}

function pickPathId(ctx, groupId, sourceCount, targetCount, sourceIndex) {
  const rows = getTables().pathsByKey.get(`${groupId}:${sourceCount}:${targetCount}:${sourceIndex}`) || [];
  const selected = pickWeighted(ctx, rows);
  return selected ? selected.pathId : -1;
}

function pickDistinctWeighted(ctx, rows, count) {
  const remaining = rows.slice();
  const selected = [];
  while (selected.length < count && remaining.length) {
    const row = pickWeighted(ctx, remaining);
    if (!row) break;
    selected.push(row);
    remaining.splice(remaining.indexOf(row), 1);
  }
  return selected;
}

function pickWeighted(ctx, rows) {
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + Math.max(0, Number(row.ratio) || 0), 0);
  if (total <= 0) return rows[randomBelow(ctx, rows.length)];
  let roll = randomBelow(ctx, total);
  for (const row of rows) {
    roll -= Math.max(0, Number(row.ratio) || 0);
    if (roll < 0) return row;
  }
  return rows[rows.length - 1];
}

function randomBelow(ctx, max) {
  if (ctx && typeof ctx.randomInt === "function") {
    return Math.max(0, Math.min(max - 1, Math.trunc(Number(ctx.randomInt(max)) || 0)));
  }
  return randomInt(max);
}

function buildInfoAckPayload(result = {}) {
  const state = result.state;
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    state ? writeNullableObject(buildExploreData(state)) : writeNullObject(),
    writeIntList(state ? state.rewardIds : []),
    writeIntIntMap(Object.entries(state ? normalizeEnhance(state.enhance) : {})),
    writeSignedVarInt(state ? nonNegativeInt(state.enhancePoint) : 0),
  ]);
}

function buildEnterAckPayload(result = {}) {
  const state = result.state;
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    state ? writeNullableObject(buildExploreData(state)) : writeNullObject(),
    state && state.zone ? writeNullableObject(buildExploreZoneData(state.zone)) : writeNullObject(),
    state && state.squad ? writeNullableObject(buildExploreSquadData(state.squad)) : writeNullObject(),
    state && state.deck ? writeNullableObject(buildDeckData(state.deck)) : writeNullObject(),
  ]);
}

function buildResetAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    result.state ? writeNullableObject(buildExploreData(result.state)) : writeNullObject(),
    writeSignedVarInt(result.state ? nonNegativeInt(result.state.enhancePoint) : 0),
  ]);
}

function buildStateAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    result.state ? writeNullableObject(buildExploreData(result.state)) : writeNullObject(),
  ]);
}

function buildSquadAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    result.state ? writeNullableObject(buildExploreData(result.state)) : writeNullObject(),
    result.squad ? writeNullableObject(buildExploreSquadData(result.squad)) : writeNullObject(),
  ]);
}

function buildRerollAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(nonNegativeInt(result.rerollCount)),
    writeNullableObjectList((Array.isArray(result.selectionList) ? result.selectionList : []).map(buildSelectableItemData)),
  ]);
}

function buildUnitChangeAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    result.squad ? writeNullableObject(buildExploreSquadData(result.squad)) : writeNullObject(),
    writeSignedVarInt(Number(result.state) || 0),
  ]);
}

function buildOperatorChangeAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(Number(result.state) || 0),
    result.squad ? writeNullableObject(buildExploreSquadData(result.squad)) : writeNullObject(),
  ]);
}

function buildShipUpgradeAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(Number(result.state) || 0),
    result.squad ? writeNullableObject(buildExploreSquadData(result.squad)) : writeNullObject(),
    writeFloatLE(Number(result.maxHp) || 0),
    writeFloatLE(Number(result.currentHp) || 0),
  ]);
}

function buildEnhanceAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(nonNegativeInt(result.enhanceGroup)),
    writeSignedVarInt(nonNegativeInt(result.enhanceLevel)),
    writeSignedVarInt(nonNegativeInt(result.enhanceTempletId)),
    writeSignedVarInt(nonNegativeInt(result.enhancePoint)),
  ]);
}

function buildEnhanceResetAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeIntIntMap(Object.entries(normalizeEnhance(result.enhance))),
    writeSignedVarInt(nonNegativeInt(result.enhancePoint)),
  ]);
}

function buildExploreData(state = {}) {
  const rewardValue = state.rewardValue && typeof state.rewardValue === "object" ? state.rewardValue : { id: 0, value: 0 };
  return Buffer.concat([
    writeSignedVarInt(Number(state.templetId) || 0),
    writeFloatLE(Number(state.maxHp) || 0),
    writeFloatLE(Number(state.currentHp) || 0),
    writeSignedVarLong(nonNegativeBigInt(state.seasonScore)),
    writeSignedVarLong(nonNegativeBigInt(state.score)),
    writeSignedVarInt(integerOr(state.currentZone, -1)),
    writeSignedVarInt(integerOr(state.currentStep, -1)),
    writeSignedVarInt(integerOr(state.currentSlotIndex, -1)),
    writeIntList(uniqueInts(state.artifacts)),
    writeNullableObjectList((Array.isArray(state.selectionList) ? state.selectionList : []).map(buildSelectableItemData)),
    writeSignedVarInt(Number(state.selectEvent) || 0),
    writeNullableObject(buildSelectableItemData(rewardValue)),
    writeIntList(uniqueInts(state.clearStageIndexList)),
    writeSignedVarInt(Number(state.state) || 0),
    writeSignedVarInt(nonNegativeInt(state.rerollCount)),
    writeSignedVarLong(nonNegativeBigInt(state.scoreEX)),
  ]);
}

function buildSelectableItemData(value = {}) {
  return Buffer.concat([writeSignedVarInt(Number(value.id) || 0), writeSignedVarInt(Number(value.value) || 0)]);
}

function buildExploreZoneData(zone = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(zone.zoneId) || 0),
    writeNullableObjectList((Array.isArray(zone.steps) ? zone.steps : []).map(buildExploreStepData)),
  ]);
}

function buildExploreStepData(step = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(step.step) || 0),
    writeNullableObjectList((Array.isArray(step.stages) ? step.stages : []).map(buildExploreStageData)),
  ]);
}

function buildExploreStageData(stage = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(stage.stageId) || 0),
    writeSignedVarInt(Number(stage.slotIndex) || 0),
    writeSignedVarInt(Number(stage.pathId) || 0),
    writeBool(Boolean(stage.isClear)),
  ]);
}

function buildExploreSquadData(squad = {}) {
  const units = Object.entries(squad.units && typeof squad.units === "object" ? squad.units : {});
  return Buffer.concat([
    squad.operator ? writeNullableObject(buildOperatorData(squad.operator)) : writeNullObject(),
    squad.ship ? writeNullableObject(buildUnitData(squad.ship)) : writeNullObject(),
    writeObjectMapLong(units.map(([uid, unit]) => [BigInt(uid), buildUnitData(unit)])),
  ]);
}

function decodeTempletRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  try {
    const value = readSignedVarInt(buffer, 0);
    return { templetId: value.value, valid: value.offset === buffer.length };
  } catch (_) {
    return { templetId: 0, valid: false };
  }
}

function decodeEmptyRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  return { valid: buffer.length === 0 };
}

function decodeIntRequest(ctx, payload, field) {
  const buffer = decrypt(ctx, payload);
  try {
    const value = readSignedVarInt(buffer, 0);
    return { valid: value.offset === buffer.length, [field]: value.value };
  } catch (_) {
    return { valid: false, [field]: 0 };
  }
}

function decodeSelectableRequest(ctx, payload, hasSkip) {
  const buffer = decrypt(ctx, payload);
  try {
    let offset = 0;
    if (buffer[offset] !== 1) return { valid: false, choice: { id: 0, value: 0 }, skip: false };
    const present = readBool(buffer, offset);
    offset = present.offset;
    const id = readSignedVarInt(buffer, offset);
    offset = id.offset;
    const value = readSignedVarInt(buffer, offset);
    offset = value.offset;
    let skip = false;
    if (hasSkip) {
      if (buffer[offset] !== 0 && buffer[offset] !== 1) return { valid: false, choice: { id: 0, value: 0 }, skip: false };
      const read = readBool(buffer, offset);
      offset = read.offset;
      skip = read.value;
    }
    return { valid: offset === buffer.length, choice: { id: id.value, value: value.value }, skip };
  } catch (_) {
    return { valid: false, choice: { id: 0, value: 0 }, skip: false };
  }
}

function decodeUnitChangeRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  try {
    const choice = readSelectableItem(buffer, 0);
    const targetUid = readSignedVarLong(buffer, choice.offset);
    if (buffer[targetUid.offset] !== 0 && buffer[targetUid.offset] !== 1) throw new Error("invalid bool");
    const skip = readBool(buffer, targetUid.offset);
    return {
      valid: skip.offset === buffer.length,
      choice: choice.value,
      targetUid: targetUid.value,
      skip: skip.value,
    };
  } catch (_) {
    return { valid: false, choice: { id: 0, value: 0 }, targetUid: 0n, skip: false };
  }
}

function decodeOperatorChangeRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  try {
    const choice = readSelectableItem(buffer, 0);
    if (buffer[choice.offset] !== 0 && buffer[choice.offset] !== 1) throw new Error("invalid bool");
    const skip = readBool(buffer, choice.offset);
    return { valid: skip.offset === buffer.length, choice: choice.value, skip: skip.value };
  } catch (_) {
    return { valid: false, choice: { id: 0, value: 0 }, skip: false };
  }
}

function decodeShipUpgradeRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  try {
    const shipId = readSignedVarInt(buffer, 0);
    if (buffer[shipId.offset] !== 0 && buffer[shipId.offset] !== 1) throw new Error("invalid bool");
    const skip = readBool(buffer, shipId.offset);
    return { valid: skip.offset === buffer.length, shipId: shipId.value, skip: skip.value };
  } catch (_) {
    return { valid: false, shipId: 0, skip: false };
  }
}

function readSelectableItem(buffer, offset) {
  if (buffer[offset] !== 1) throw new Error("selectable item is required");
  const present = readBool(buffer, offset);
  const id = readSignedVarInt(buffer, present.offset);
  const value = readSignedVarInt(buffer, id.offset);
  return { value: { id: id.value, value: value.value }, offset: value.offset };
}

function decrypt(ctx, payload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function isExploreActive(ctx, templet) {
  const manager = ctx && ctx.eventManager;
  if (!manager || typeof manager.getActiveEventState !== "function") return true;
  let state;
  try {
    state = manager.getActiveEventState();
  } catch (_) {
    return false;
  }
  const openTags = new Set((state && state.openTags || []).map(normalizeTag));
  const intervalTags = new Set((state && state.intervalTags || []).map(normalizeTag));
  const ids = new Set();
  for (const entry of Array.isArray(state && state.entries) ? state.entries : []) {
    const raw = entry && entry.raw || {};
    const options = String(raw.m_Option || raw.Option || "");
    const match = options.match(/ExploreTempletID\s*=\s*(\d+)/i);
    if (match) ids.add(Number(match[1]));
    for (const key of ["OpenTag", "m_OpenTag", "openTag"]) if (raw[key]) openTags.add(normalizeTag(raw[key]));
    for (const key of ["DateStrID", "m_DateStrID", "IntervalTag"]) if (raw[key]) intervalTags.add(normalizeTag(raw[key]));
  }
  return ids.has(templet.templetId) || openTags.has(normalizeTag(templet.openTag)) || intervalTags.has(normalizeTag(templet.intervalTag));
}

function getTables() {
  if (cachedTables) return cachedTables;
  const templetRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const zoneRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_ZONE_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const stageRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_STAGE_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const pathRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_PATH_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const rewardRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_REWARD_GROUP.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const eventRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_EVENT_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const enhanceRows = readGameplayTableRecords("ab_script", "LUA_EXPLORE_ENHANCE_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const resetRows = readGameplayTableRecords("ab_script", "LUA_RESET_COUNT_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "explore" });
  const resetMaximumById = new Map(resetRows.map((row) => [positiveInt(row.GroupID), nonNegativeInt(row.MaxCount)]));

  const templetsById = new Map();
  for (const row of templetRows) {
    const templetId = positiveInt(row.ExploreID);
    if (!templetId) continue;
    templetsById.set(templetId, {
      templetId,
      openTag: String(row.OpenTag || ""),
      intervalTag: String(row.ExploreInterval || ""),
      zoneIds: [row.ZONE_ID_1, row.ZONE_ID_2, row.ZONE_ID_3].map(positiveInt).filter(Boolean),
      exZoneId: positiveInt(row.ZONE_ID_EX),
      pathGroupId: positiveInt(row.PathPatternGroupID),
      defaultShipId: positiveInt(row.FirstSquadShip),
      defaultOperatorId: positiveInt(row.FirstSquadOpr),
      defaultUnitIds: (Array.isArray(row.FirstSquadUnit) ? row.FirstSquadUnit : []).map(positiveInt).filter(Boolean),
      unitHaveCount: positiveInt(row.UnitHaveCount),
      rerollCount: nonNegativeInt(row.RerollCount),
      enhancePointMax: resetMaximumById.get(positiveInt(row.m_ResetGroupID)) || 0,
      seasonEnhanceGroupId: positiveInt(row.SeasonEnhanceGroupID),
      shipUpgradeGroups: uniqueInts(row.ShipUpgradeGroup),
    });
  }

  const zonesById = new Map();
  for (const row of zoneRows) {
    const zoneId = positiveInt(row.Zone);
    const stepCount = positiveInt(row.ZoneStageCount);
    if (!zoneId || !stepCount) continue;
    const steps = Array.from({ length: stepCount }, (_, index) => ({
      stageGroupId: positiveInt(row[`StageGroupID_${index + 1}`]),
      slotCount: positiveInt(row[`StageSlotCount_${index + 1}`]),
    }));
    zonesById.set(zoneId, { zoneId, stepCount, steps });
  }

  const stagesByGroup = new Map();
  const stagesById = new Map();
  for (const row of stageRows) {
    const groupId = positiveInt(row.StageGroupID);
    const stageId = positiveInt(row.StageID);
    if (!groupId || !stageId) continue;
    if (!stagesByGroup.has(groupId)) stagesByGroup.set(groupId, []);
    const stage = {
      groupId,
      stageId,
      stageType: String(row.StageType || "").toUpperCase(),
      eventValue: positiveInt(row.EventValue),
      rewardGroupId: positiveInt(row.RewardGroupID),
      ratio: nonNegativeInt(row.Ratio),
    };
    stagesByGroup.get(groupId).push(stage);
    stagesById.set(stageId, stage);
  }

  const pathsByKey = new Map();
  const pathsById = new Map();
  for (const row of pathRows) {
    const groupId = positiveInt(row.PathPatternGroupID);
    const sourceCount = positiveInt(row.SourceCount);
    const targetCount = positiveInt(row.TargetCount);
    const sourceIndex = nonNegativeInt(row.SourceIndex);
    const pathId = positiveInt(row.PathPatternID);
    if (!groupId || !sourceCount || !targetCount || !pathId) continue;
    const key = `${groupId}:${sourceCount}:${targetCount}:${sourceIndex}`;
    if (!pathsByKey.has(key)) pathsByKey.set(key, []);
    const pathRow = { pathId, ratio: nonNegativeInt(row.Ratio), moveable: uniqueInts(row.MoveAblePathList) };
    pathsByKey.get(key).push(pathRow);
    pathsById.set(pathId, pathRow);
  }

  const rewardGroups = new Map();
  const unitRewardIds = new Set();
  const operatorRewardIds = new Set();
  for (const row of rewardRows) {
    const groupId = positiveInt(row.RewardGroupID);
    const rewardId = positiveInt(row.RewardID);
    if (!groupId || !rewardId) continue;
    if (!rewardGroups.has(groupId)) {
      rewardGroups.set(groupId, { groupId, rewardType: String(row.RewardType || "").toUpperCase(), rows: [] });
    }
    rewardGroups.get(groupId).rows.push({
      groupId,
      rewardId,
      rewardType: String(row.RewardType || "").toUpperCase(),
      category: String(row.Category || "ETC").toUpperCase(),
      randomOperatorSkills: uniqueInts(row.RandomOprSkill),
      ratio: nonNegativeInt(row.Ratio),
    });
    const rewardType = String(row.RewardType || "").toUpperCase();
    if (rewardType === "RT_UNIT") unitRewardIds.add(rewardId);
    if (rewardType === "RT_OPERATOR") operatorRewardIds.add(rewardId);
  }

  const eventGroups = new Map();
  const eventsById = new Map();
  for (const row of eventRows) {
    const eventGroupId = positiveInt(row.EventGroupID);
    const eventId = positiveInt(row.EventID);
    if (!eventGroupId || !eventId) continue;
    const event = {
      eventGroupId,
      eventId,
      unlockReqType: String(row.UnlockReqType || "").toUpperCase(),
      unlockReqValue: positiveInt(row.UnlockReqValue),
      eventType: String(row.EventType || "").toUpperCase(),
      eventValue: nonNegativeInt(row.EventValue),
      rewardType: String(row.RewardType || "NONE").toUpperCase(),
      rewardValue: nonNegativeInt(row.RewardValue),
    };
    if (!eventGroups.has(eventGroupId)) eventGroups.set(eventGroupId, []);
    eventGroups.get(eventGroupId).push(event);
    eventsById.set(eventId, event);
  }

  const enhanceGroups = new Map();
  for (const row of enhanceRows) {
    const seasonGroupId = positiveInt(row.SeasonEnhanceGroupID);
    const enhanceGroupId = positiveInt(row.EnhanceGroupID);
    const enhanceId = positiveInt(row.EnhanceID);
    const level = positiveInt(row.EnhanceLevel);
    const price = nonNegativeInt(row.PriceEnhancePoint);
    if (!seasonGroupId || !enhanceGroupId || !enhanceId || !level) continue;
    const key = `${seasonGroupId}:${enhanceGroupId}`;
    if (!enhanceGroups.has(key)) enhanceGroups.set(key, []);
    enhanceGroups.get(key).push({ seasonGroupId, enhanceGroupId, enhanceId, level, price });
  }
  for (const rows of enhanceGroups.values()) rows.sort((left, right) => left.level - right.level);

  cachedTables = {
    templetsById,
    zonesById,
    stagesByGroup,
    stagesById,
    pathsByKey,
    pathsById,
    rewardGroups,
    unitRewardIds,
    operatorRewardIds,
    eventGroups,
    eventsById,
    enhanceGroups,
  };
  return cachedTables;
}

function infoResult(errorCode, state) {
  return { errorCode, state };
}

function enterResult(errorCode, state = null, changed = false) {
  return { errorCode, state, changed };
}

function stateResult(errorCode, state = null, changed = false, squad = null) {
  return { errorCode, state, changed, squad: squad || state && state.squad || null };
}

function rerollResult(errorCode, rerollCount = 0, selectionList = [], changed = false) {
  return { errorCode, rerollCount, selectionList, changed };
}

function squadChangeResult(errorCode, state = null, changed = false) {
  return {
    errorCode,
    state: state ? Number(state.state) || 0 : 0,
    squad: state && state.squad || null,
    changed,
  };
}

function shipUpgradeResult(errorCode, state = null, changed = false) {
  return {
    ...squadChangeResult(errorCode, state, changed),
    maxHp: state ? Number(state.maxHp) || 0 : 0,
    currentHp: state ? Number(state.currentHp) || 0 : 0,
  };
}

function enhanceResult(errorCode, enhanceGroup = 0, enhanceLevel = 0, enhanceTempletId = 0, enhancePoint = 0, changed = false) {
  return { errorCode, enhanceGroup, enhanceLevel, enhanceTempletId, enhancePoint, changed };
}

function enhanceResetResult(errorCode, enhance = {}, enhancePoint = 0, changed = false) {
  return { errorCode, enhance, enhancePoint, changed };
}

function finishMutation(ctx, changed, reason) {
  if (!changed) return;
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
    return;
  }
  ctx.sendResponse(socket, packet.sequence, packetId, () => ctx.buildEncryptedPacket(packet.sequence, packetId, payload));
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function validSquad(squad) {
  return Boolean(squad && squad.ship && squad.units && Object.keys(squad.units).length);
}

function withCanonicalRewardIds(user, state) {
  const canonical = user && user.scoreRewards && Array.isArray(user.scoreRewards.explore) ? user.scoreRewards.explore : [];
  return { ...state, rewardIds: uniqueInts([...(Array.isArray(state.rewardIds) ? state.rewardIds : []), ...canonical]) };
}

function writeIntIntMap(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return Buffer.concat([
    writeVarInt(list.length),
    ...list.flatMap(([key, value]) => [writeSignedVarInt(Number(key) || 0), writeSignedVarInt(Number(value) || 0)]),
  ]);
}

function normalizeEnhance(value) {
  const result = {};
  for (const [key, level] of Object.entries(value && typeof value === "object" ? value : {})) {
    const groupId = positiveInt(key);
    if (groupId) result[String(groupId)] = nonNegativeInt(level);
  }
  return result;
}

function normalizeTag(value) {
  return String(value || "").trim().toUpperCase();
}

function uniqueInts(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(Number).filter(Number.isInteger))).sort((a, b) => a - b);
}

function positiveInt(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function nonNegativeInt(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeBigInt(value) {
  try {
    const result = BigInt(value || 0);
    return result > 0n ? result : 0n;
  } catch (_) {
    return 0n;
  }
}

function parsePositiveBigInt(value) {
  try {
    const result = BigInt(value || 0);
    return result > 0n ? result : 0n;
  } catch (_) {
    return 0n;
  }
}

function integerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

module.exports = {
  PACKETS,
  ERRORS,
  STATE,
  createExploreHandlers,
  getExploreInfo,
  enterExplore,
  resetExplore,
  moveExploreForward,
  selectExploreReward,
  selectExploreEvent,
  rerollExploreReward,
  changeExploreUnit,
  changeExploreOperator,
  upgradeExploreShip,
  enhanceExplore,
  resetExploreEnhance,
  prepareExploreGameLoad,
  recordExploreBattleResult,
  buildExploreGameLoadFailurePayload,
  buildExplorePlayerDeck,
  buildInfoAckPayload,
  buildEnterAckPayload,
  buildResetAckPayload,
  buildStateAckPayload,
  buildSquadAckPayload,
  buildRerollAckPayload,
  buildUnitChangeAckPayload,
  buildOperatorChangeAckPayload,
  buildShipUpgradeAckPayload,
  buildEnhanceAckPayload,
  buildEnhanceResetAckPayload,
  buildExploreData,
  buildExploreZoneData,
  buildExploreSquadData,
  createZone,
  getTables,
  decodeTempletRequest,
  decodeEmptyRequest,
  decodeIntRequest,
  decodeSelectableRequest,
  decodeUnitChangeRequest,
  decodeOperatorChangeRequest,
  decodeShipUpgradeRequest,
};
