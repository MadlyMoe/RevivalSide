"use strict";

const { randomInt: cryptoRandomInt } = require("node:crypto");
const path = require("path");
const {
  buildItemMiscData,
  buildRewardData,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  toBigInt,
  writeBool,
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeInt64LE,
} = require("../packet-codec");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getRewardGroupRecords } = require("../game-data");
const { spendMiscItem } = require("../inventory");
const { grantUserExp } = require("../account-progression");
const { createEmptyReward, grantRewardByType, grantRewardRecord, mergeReward } = require("../reward");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const MAX_SKIP_COUNT = 99;
const MAX_DECK_UNITS = 8;
const REQUIRED_DECK_COUNT = 3;

const PACKETS = Object.freeze({
  TRIM_DUNGEON_SKIP_REQ: 859,
  TRIM_DUNGEON_SKIP_ACK: 860,
  TRIM_START_REQ: 1234,
  TRIM_START_ACK: 1235,
  TRIM_RETRY_REQ: 1236,
  TRIM_RETRY_ACK: 1237,
  TRIM_RESTORE_REQ: 1238,
  TRIM_RESTORE_ACK: 1239,
  TRIM_END_REQ: 1240,
  TRIM_END_ACK: 1241,
  TRIM_INTERVAL_INFO_NOT: 1242,
});

const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  INVALID_REQUEST: 20191,
  NEED_DUNGEON_CLEAR: 20799,
  INVALID_SKIP_COUNT: 20805,
  INVALID_TRIM_INTERVAL: 22800,
  EVENT_DECK_LIST_SETTING: 22804,
  INVALID_TRIM_ID: 22805,
  INVALID_TRIM_DUNGEON: 22806,
  OUT_RANGE_TRIM_LEVEL: 22807,
  INVALID_TRIM_TRY_COUNT: 22808,
});

const LIFECYCLE_ERRORS = Object.freeze({
  ...ERRORS,
  INVALID_TRIM_RETRY_COUNT: 22809,
  INVALID_TRIM_RESTORE_COUNT: 22810,
  TRIM_END_PROCESSING: 22811,
  OUT_RANGE_TRIM_INDEX: 22813,
});

let tablesCache = null;

function createTrimHandlers() {
  return [{
    packetId: PACKETS.TRIM_DUNGEON_SKIP_REQ,
    name: "TRIM_DUNGEON_SKIP_REQ",
    handle(ctx, socket, packet) {
      const user = getSocketUser(ctx, socket);
      const request = decodeTrimDungeonSkipReq(ctx, packet.payload);
      const result = skipTrimDungeon(ctx, user, request);
      send(ctx, socket, packet, PACKETS.TRIM_DUNGEON_SKIP_ACK, buildTrimDungeonSkipAckPayload(result));
      if (result.errorCode === ERRORS.OK) {
        trackSkipMissions(ctx, socket, user, result);
        if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
          ctx.invalidateJoinLobbyAckPayloadCache("trim-dungeon-skip");
        }
        if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
      }
      console.log(
        `[trim:TRIM_DUNGEON_SKIP_REQ] ACK packetId=${PACKETS.TRIM_DUNGEON_SKIP_ACK} trimId=${request.trimId} level=${request.trimLevel} skip=${request.skipCount} error=${result.errorCode}`
      );
      return true;
    },
  }, {
    packetId: PACKETS.TRIM_START_REQ,
    name: "TRIM_START_REQ",
    handle(ctx, socket, packet) {
      const user = getSocketUser(ctx, socket);
      const request = decodeTrimStartReq(ctx, packet.payload);
      const result = startTrim(ctx, user, request);
      send(ctx, socket, packet, PACKETS.TRIM_START_ACK, buildTrimStartAckPayload(result), "trim-start");
      commitLifecycleMutation(ctx, socket, user, result, "trim-start");
      return true;
    },
  }, {
    packetId: PACKETS.TRIM_RETRY_REQ,
    name: "TRIM_RETRY_REQ",
    handle(ctx, socket, packet) {
      const user = getSocketUser(ctx, socket);
      const request = decodeEmptyReq(ctx, packet.payload);
      const result = retryTrim(ctx, user, request);
      send(ctx, socket, packet, PACKETS.TRIM_RETRY_ACK, buildTrimRetryAckPayload(result), "trim-retry");
      commitLifecycleMutation(ctx, socket, user, result, "trim-retry");
      return true;
    },
  }, {
    packetId: PACKETS.TRIM_RESTORE_REQ,
    name: "TRIM_RESTORE_REQ",
    handle(ctx, socket, packet) {
      const user = getSocketUser(ctx, socket);
      const request = decodeSingleIntReq(ctx, packet.payload, "trimIntervalId");
      const result = restoreTrim(ctx, user, request);
      send(ctx, socket, packet, PACKETS.TRIM_RESTORE_ACK, buildTrimRestoreAckPayload(result), "trim-restore");
      commitLifecycleMutation(ctx, socket, user, result, "trim-restore");
      return true;
    },
  }, {
    packetId: PACKETS.TRIM_END_REQ,
    name: "TRIM_END_REQ",
    handle(ctx, socket, packet) {
      const user = getSocketUser(ctx, socket);
      const request = decodeSingleIntReq(ctx, packet.payload, "trimId");
      const result = endTrim(ctx, user, request);
      send(ctx, socket, packet, PACKETS.TRIM_END_ACK, buildTrimEndAckPayload(result), "trim-end");
      commitLifecycleMutation(ctx, socket, user, result, "trim-end");
      return true;
    },
  }];
}

function decodeTrimDungeonSkipReq(ctx, encryptedPayload) {
  const invalid = { valid: false, trimId: 0, trimLevel: 0, skipCount: 0, eventDeckList: [] };
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
    let offset = 0;
    const trimId = readSignedVarInt(payload, offset); offset = trimId.offset;
    const trimLevel = readSignedVarInt(payload, offset); offset = trimLevel.offset;
    const skipCount = readSignedVarInt(payload, offset); offset = skipCount.offset;
    const list = readRawVarInt(payload, offset); offset = list.offset;
    if (list.value > REQUIRED_DECK_COUNT) return invalid;
    const eventDeckList = [];
    for (let index = 0; index < list.value; index += 1) {
      const present = readBool(payload, offset); offset = present.offset;
      if (!present.value) return invalid;
      const deck = decodeEventDeckData(payload, offset);
      offset = deck.offset;
      eventDeckList.push(deck.value);
    }
    return {
      valid: offset === payload.length,
      trimId: trimId.value,
      trimLevel: trimLevel.value,
      skipCount: skipCount.value,
      eventDeckList,
    };
  } catch (_) {
    return invalid;
  }
}

function decodeTrimStartReq(ctx, encryptedPayload) {
  const invalid = { valid: false, trimId: 0, trimLevel: 0, eventDeckList: [] };
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    let offset = 0;
    const trimId = readSignedVarInt(payload, offset); offset = trimId.offset;
    const trimLevel = readSignedVarInt(payload, offset); offset = trimLevel.offset;
    const decks = decodeEventDeckList(payload, offset); offset = decks.offset;
    return {
      valid: offset === payload.length,
      trimId: trimId.value,
      trimLevel: trimLevel.value,
      eventDeckList: decks.value,
    };
  } catch (_) {
    return invalid;
  }
}

function decodeEmptyReq(ctx, encryptedPayload) {
  try {
    return { valid: decryptPayload(ctx, encryptedPayload).length === 0 };
  } catch (_) {
    return { valid: false };
  }
}

function decodeSingleIntReq(ctx, encryptedPayload, field) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const value = readSignedVarInt(payload, 0);
    return { valid: value.offset === payload.length, [field]: value.value };
  } catch (_) {
    return { valid: false, [field]: 0 };
  }
}

function decryptPayload(ctx, encryptedPayload) {
  return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
}

function decodeEventDeckList(payload, startOffset) {
  let offset = startOffset;
  const list = readRawVarInt(payload, offset); offset = list.offset;
  if (list.value > REQUIRED_DECK_COUNT) throw new Error("too many TRIM event decks");
  const eventDeckList = [];
  for (let index = 0; index < list.value; index += 1) {
    const present = readBool(payload, offset); offset = present.offset;
    if (!present.value) throw new Error("null TRIM event deck");
    const deck = decodeEventDeckData(payload, offset); offset = deck.offset;
    eventDeckList.push(deck.value);
  }
  return { value: eventDeckList, offset };
}

function decodeEventDeckData(payload, startOffset) {
  let offset = startOffset;
  const ship = readSignedVarLong(payload, offset); offset = ship.offset;
  const count = readRawVarInt(payload, offset); offset = count.offset;
  if (count.value > MAX_DECK_UNITS) throw new Error("too many event-deck units");
  const units = [];
  const slots = new Set();
  for (let index = 0; index < count.value; index += 1) {
    const slot = readSignedVarInt(payload, offset); offset = slot.offset;
    const uid = readSignedVarLong(payload, offset); offset = uid.offset;
    if (slots.has(slot.value)) throw new Error("duplicate event-deck slot");
    slots.add(slot.value);
    units.push({ slotIndex: slot.value, unitUid: String(toBigInt(uid.value || 0)) });
  }
  const operator = readSignedVarLong(payload, offset); offset = operator.offset;
  const leader = readSignedVarInt(payload, offset); offset = leader.offset;
  return {
    value: {
      shipUid: String(toBigInt(ship.value || 0)),
      units,
      operatorUid: String(toBigInt(operator.value || 0)),
      leaderIndex: leader.value,
    },
    offset,
  };
}

function skipTrimDungeon(ctx, user, request, options = {}) {
  const snapshot = cloneUser(user);
  try {
    const validation = validateTrimDungeonSkip(ctx, user, request, options);
    if (validation.errorCode !== ERRORS.OK) {
      restoreUser(user, snapshot);
      return validation;
    }

    const state = ensureTrimState(user, { now: validation.now, tables: validation.tables });
    const totalCost = validation.costPerRun * validation.skipCount;
    const costItem = spendMiscItem(user, validation.costItemId, BigInt(totalCost));
    if (!costItem) throw new Error("TRIM cost could not be committed");

    const rewardDatas = [];
    for (let index = 0; index < validation.skipCount; index += 1) {
      rewardDatas.push(grantTrimReward(ctx, user, validation.rewardRow));
    }
    state.trimTryCount += validation.skipCount;

    return {
      errorCode: ERRORS.OK,
      changed: true,
      trimId: validation.trimId,
      trimLevel: validation.trimLevel,
      skipCount: validation.skipCount,
      trimClearData: validation.clear,
      rewardDatas,
      costItems: [costItem],
      updatedUnits: validation.units,
      costItemId: validation.costItemId,
      totalCost,
    };
  } catch (error) {
    restoreUser(user, snapshot);
    return failure(ERRORS.INVALID_REQUEST, error);
  }
}

function validateTrimDungeonSkip(ctx, user, request, options = {}) {
  if (!request || request.valid !== true) return failure(ERRORS.INVALID_REQUEST);
  const trimId = Number(request.trimId);
  const trimLevel = Number(request.trimLevel);
  const skipCount = Number(request.skipCount);
  const tables = options.tables || loadTables();
  const now = options.now || getNow(ctx);
  const template = tables.templatesById.get(trimId);
  if (!template) return failure(ERRORS.INVALID_TRIM_ID);
  if (!Number.isInteger(trimLevel) || trimLevel < 1 || trimLevel > 20) return failure(ERRORS.OUT_RANGE_TRIM_LEVEL);
  if (!tables.dungeonsByTrimAndLevel.has(`${trimId}:${trimLevel}`)) return failure(ERRORS.INVALID_TRIM_DUNGEON);
  if (!Number.isInteger(skipCount) || skipCount < 1 || skipCount > MAX_SKIP_COUNT) return failure(ERRORS.INVALID_SKIP_COUNT);
  if (template.activeBattleSkip !== true) return failure(ERRORS.INVALID_REQUEST);

  const interval = options.interval || getActiveTrimInterval(now, tables);
  if (!interval || !interval.trimIds.includes(trimId) || !isEffectiveTagOpen(ctx, user, template.openTag)) {
    return failure(ERRORS.INVALID_TRIM_INTERVAL);
  }

  const state = readTrimState(user, { now, tables });
  const clear = state.clears[`${trimId}:${trimLevel}`];
  if (!clear || clear.isWin !== true) return failure(ERRORS.NEED_DUNGEON_CLEAR);
  if (interval.weeklyEnterLimit > 0 && state.trimTryCount + skipCount > interval.weeklyEnterLimit) {
    return failure(ERRORS.INVALID_TRIM_TRY_COUNT);
  }

  const decks = validateEventDeckList(user, request.eventDeckList);
  if (!decks.valid) return failure(ERRORS.EVENT_DECK_LIST_SETTING);

  const costItemId = template.stageReqItemId;
  const costPerRun = template.stageReqItemCount;
  const balance = getItemBalance(user, costItemId);
  if (balance < BigInt(costPerRun) * BigInt(skipCount)) return failure(ERRORS.INSUFFICIENT_ITEM);
  const rewardRow = tables.rewardsByTrimAndLevel.get(`${trimId}:${trimLevel}`);
  if (!rewardRow) return failure(ERRORS.INVALID_TRIM_DUNGEON);

  return {
    errorCode: ERRORS.OK,
    valid: true,
    trimId,
    trimLevel,
    skipCount,
    template,
    interval,
    clear,
    decks: decks.decks,
    units: decks.units,
    costItemId,
    costPerRun,
    rewardRow,
    tables,
    now,
  };
}

function validateEventDeckList(user, eventDeckList) {
  if (!Array.isArray(eventDeckList) || eventDeckList.length !== REQUIRED_DECK_COUNT) return { valid: false };
  const seenShips = new Set();
  const seenUnits = new Set();
  const seenOperators = new Set();
  const units = [];

  for (const deck of eventDeckList) {
    const shipUid = uidString(deck && deck.shipUid);
    const operatorUid = uidString(deck && deck.operatorUid);
    const deckUnits = Array.isArray(deck && deck.units) ? deck.units : [];
    if (toBigInt(shipUid) <= 0n || seenShips.has(shipUid) || !findOwned(user, "ships", shipUid)) return { valid: false };
    if (deckUnits.length < 1 || deckUnits.length > MAX_DECK_UNITS) return { valid: false };
    seenShips.add(shipUid);
    const deckSlots = new Set();
    for (const entry of deckUnits) {
      const slotIndex = Number(entry && entry.slotIndex);
      const unitUid = uidString(entry && entry.unitUid);
      const unit = findOwned(user, "units", unitUid);
      if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_DECK_UNITS || deckSlots.has(slotIndex)) return { valid: false };
      if (toBigInt(unitUid) <= 0n || seenUnits.has(unitUid) || !unit) return { valid: false };
      deckSlots.add(slotIndex);
      seenUnits.add(unitUid);
      units.push(unit);
    }
    const leaderIndex = Number(deck && deck.leaderIndex);
    if (!Number.isInteger(leaderIndex) || leaderIndex < -1 || leaderIndex >= MAX_DECK_UNITS) return { valid: false };
    if (leaderIndex >= 0 && !deckSlots.has(leaderIndex)) return { valid: false };
    if (toBigInt(operatorUid) > 0n) {
      if (seenOperators.has(operatorUid) || !findOwned(user, "operators", operatorUid)) return { valid: false };
      seenOperators.add(operatorUid);
    }
  }
  return { valid: true, decks: eventDeckList, units };
}

function startTrim(ctx, user, request, options = {}) {
  const snapshot = cloneUser(user);
  try {
    const validation = validateTrimStart(ctx, user, request, options);
    if (validation.errorCode !== ERRORS.OK) return restoreFailure(user, snapshot, validation);
    const state = ensureTrimState(user, { now: validation.now, tables: validation.tables });
    const costItem = spendMiscItem(user, validation.template.stageReqItemId, BigInt(validation.template.stageReqItemCount));
    if (!costItem) throw new Error("TRIM entry cost could not be committed");
    state.trimTryCount += 1;
    state.current = {
      trimId: validation.trimId,
      trimLevel: validation.trimLevel,
      intervalIndex: validation.interval.index,
      eventDeckList: validation.decks,
      dungeonIds: validation.dungeonIds,
      stageList: [],
      lastClearStage: null,
      nextDungeonId: validation.dungeonIds[0],
      costItemId: validation.template.stageReqItemId,
      costItemCount: validation.template.stageReqItemCount,
      startedAt: new Date(validation.now).toISOString(),
    };
    return {
      errorCode: ERRORS.OK,
      changed: true,
      current: state.current,
      costItem,
      costItemId: validation.template.stageReqItemId,
      totalCost: validation.template.stageReqItemCount,
    };
  } catch (error) {
    restoreUser(user, snapshot);
    return failure(ERRORS.INVALID_REQUEST, error);
  }
}

function validateTrimStart(ctx, user, request, options = {}) {
  if (!request || request.valid !== true) return failure(ERRORS.INVALID_REQUEST);
  const trimId = Number(request.trimId);
  const trimLevel = Number(request.trimLevel);
  const tables = options.tables || loadTables();
  const now = options.now || getNow(ctx);
  const template = tables.templatesById.get(trimId);
  if (!template) return failure(ERRORS.INVALID_TRIM_ID);
  if (!Number.isInteger(trimLevel) || trimLevel < 1 || trimLevel > 20) return failure(ERRORS.OUT_RANGE_TRIM_LEVEL);
  const dungeonIds = tables.dungeonsByTrimAndLevel.get(`${trimId}:${trimLevel}`) || [];
  if (dungeonIds.length !== REQUIRED_DECK_COUNT) return failure(ERRORS.INVALID_TRIM_DUNGEON);
  const interval = options.interval || getActiveTrimInterval(now, tables);
  if (!interval || !interval.trimIds.includes(trimId) || !isEffectiveTagOpen(ctx, user, template.openTag)) {
    return failure(ERRORS.INVALID_TRIM_INTERVAL);
  }
  if (!isTrimUnlocked(user, template)) return failure(ERRORS.NEED_DUNGEON_CLEAR);
  const state = readTrimState(user, { now, tables });
  if (state.current) return failure(LIFECYCLE_ERRORS.TRIM_END_PROCESSING);
  if (interval.weeklyEnterLimit > 0 && state.trimTryCount >= interval.weeklyEnterLimit) {
    return failure(ERRORS.INVALID_TRIM_TRY_COUNT);
  }
  const decks = validateEventDeckList(user, request.eventDeckList);
  if (!decks.valid) return failure(ERRORS.EVENT_DECK_LIST_SETTING);
  if (getItemBalance(user, template.stageReqItemId) < BigInt(template.stageReqItemCount)) {
    return failure(ERRORS.INSUFFICIENT_ITEM);
  }
  return { errorCode: ERRORS.OK, trimId, trimLevel, tables, now, template, interval, dungeonIds, decks: decks.decks };
}

function retryTrim(ctx, user, request, options = {}) {
  const snapshot = cloneUser(user);
  try {
    if (!request || request.valid !== true) return restoreFailure(user, snapshot, failure(ERRORS.INVALID_REQUEST));
    const tables = options.tables || loadTables();
    const now = options.now || getNow(ctx);
    const interval = options.interval || getActiveTrimInterval(now, tables);
    const state = ensureTrimState(user, { now, tables });
    if (!interval || !state.current || !state.current.lastClearStage) {
      return restoreFailure(user, snapshot, failure(LIFECYCLE_ERRORS.INVALID_TRIM_RETRY_COUNT));
    }
    if (interval.resultResetLimit > 0 && state.trimRetryCount <= 0) {
      return restoreFailure(user, snapshot, failure(LIFECYCLE_ERRORS.INVALID_TRIM_RETRY_COUNT));
    }
    if (interval.resultResetLimit > 0) state.trimRetryCount -= 1;
    state.trimTryCount = Math.max(0, state.trimTryCount - 1);
    state.current = null;
    return { errorCode: ERRORS.OK, changed: true, rewardData: null };
  } catch (error) {
    restoreUser(user, snapshot);
    return failure(ERRORS.INVALID_REQUEST, error);
  }
}

function restoreTrim(ctx, user, request, options = {}) {
  const snapshot = cloneUser(user);
  try {
    if (!request || request.valid !== true) return restoreFailure(user, snapshot, failure(ERRORS.INVALID_REQUEST));
    const tables = options.tables || loadTables();
    const now = options.now || getNow(ctx);
    const interval = options.interval || getActiveTrimInterval(now, tables);
    if (!interval || Number(request.trimIntervalId) !== interval.index) {
      return restoreFailure(user, snapshot, failure(ERRORS.INVALID_TRIM_INTERVAL));
    }
    const state = ensureTrimState(user, { now, tables });
    if (state.current || interval.weeklyEnterLimit <= 0 || state.trimTryCount < interval.weeklyEnterLimit) {
      return restoreFailure(user, snapshot, failure(LIFECYCLE_ERRORS.INVALID_TRIM_RESTORE_COUNT));
    }
    if (interval.restoreLimitCount <= 0 || state.trimRestoreCount >= interval.restoreLimitCount) {
      return restoreFailure(user, snapshot, failure(LIFECYCLE_ERRORS.INVALID_TRIM_RESTORE_COUNT));
    }
    const cost = nonNegativeInt(interval.restoreLimitReqItemCounts[state.trimRestoreCount]);
    if (!interval.restoreLimitReqItemId || !cost) {
      return restoreFailure(user, snapshot, failure(LIFECYCLE_ERRORS.INVALID_TRIM_RESTORE_COUNT));
    }
    if (getItemBalance(user, interval.restoreLimitReqItemId) < BigInt(cost)) {
      return restoreFailure(user, snapshot, failure(ERRORS.INSUFFICIENT_ITEM));
    }
    const costItem = spendMiscItem(user, interval.restoreLimitReqItemId, BigInt(cost));
    if (!costItem) throw new Error("TRIM restore cost could not be committed");
    state.trimRestoreCount += 1;
    state.trimTryCount = Math.max(0, state.trimTryCount - 1);
    return {
      errorCode: ERRORS.OK,
      changed: true,
      costItem,
      costItemId: interval.restoreLimitReqItemId,
      totalCost: cost,
    };
  } catch (error) {
    restoreUser(user, snapshot);
    return failure(ERRORS.INVALID_REQUEST, error);
  }
}

function endTrim(ctx, user, request, options = {}) {
  const snapshot = cloneUser(user);
  try {
    if (!request || request.valid !== true) return restoreFailure(user, snapshot, failure(ERRORS.INVALID_REQUEST));
    const tables = options.tables || loadTables();
    const now = options.now || getNow(ctx);
    const state = ensureTrimState(user, { now, tables });
    const current = normalizeCurrentState(state.current, tables);
    if (!current || Number(request.trimId) !== current.trimId) {
      return restoreFailure(user, snapshot, failure(ERRORS.INVALID_TRIM_ID));
    }
    if (!current.lastClearStage || current.nextDungeonId > 0) {
      return restoreFailure(user, snapshot, failure(LIFECYCLE_ERRORS.TRIM_END_PROCESSING));
    }
    const stages = [...current.stageList, current.lastClearStage];
    const isWin = stages.length === REQUIRED_DECK_COUNT && stages.every((stage) => stage.isWin === true);
    const score = stages.reduce((total, stage) => total + nonNegativeInt(stage.score), 0);
    const key = `${current.trimId}:${current.trimLevel}`;
    const previous = state.clears[key] || null;
    const bestScore = previous && previous.isWin ? nonNegativeInt(previous.score) : 0;
    const isFirst = isWin && !(previous && previous.isWin);
    let rewardData = null;
    if (isWin) {
      const rewardRow = tables.rewardsByTrimAndLevel.get(key);
      if (!rewardRow) return restoreFailure(user, snapshot, failure(ERRORS.INVALID_TRIM_DUNGEON));
      rewardData = grantTrimReward(ctx, user, rewardRow);
      if (!previous || !previous.isWin || score > bestScore) {
        state.clears[key] = { isWin: true, trimId: current.trimId, trimLevel: current.trimLevel, score, rewardData: null };
      }
    }
    const trimClearData = {
      isWin,
      trimId: current.trimId,
      trimLevel: current.trimLevel,
      score,
      rewardData,
    };
    state.current = null;
    return {
      errorCode: ERRORS.OK,
      changed: true,
      isFirst,
      bestScore,
      modeState: current,
      trimClearData,
      costItems: [],
      trimId: current.trimId,
      trimLevel: current.trimLevel,
      completed: isWin,
    };
  } catch (error) {
    restoreUser(user, snapshot);
    return failure(ERRORS.INVALID_REQUEST, error);
  }
}

function recordTrimBattleResult(user, result = {}, options = {}) {
  const tables = options.tables || loadTables();
  const now = options.now || new Date();
  const state = ensureTrimState(user, { now, tables });
  const current = normalizeCurrentState(state.current, tables);
  const dungeonId = nonNegativeInt(result.dungeonId || result.dungeonID);
  if (!current || !dungeonId || dungeonId !== current.nextDungeonId) return { valid: false, changed: false, modeState: current };
  const index = current.dungeonIds.indexOf(dungeonId);
  if (index < 0 || index >= REQUIRED_DECK_COUNT) return { valid: false, changed: false, modeState: current };
  if (current.lastClearStage && current.lastClearStage.dungeonId === dungeonId) {
    return { valid: true, changed: false, modeState: current, stage: current.lastClearStage };
  }
  if (current.lastClearStage) current.stageList.push(current.lastClearStage);
  const isWin = result.win === true && result.giveup !== true;
  const stage = {
    index,
    dungeonId,
    score: resolveTrimStageScore(current, index, isWin, result, tables),
    isWin,
  };
  current.lastClearStage = stage;
  current.nextDungeonId = isWin && index + 1 < current.dungeonIds.length ? current.dungeonIds[index + 1] : 0;
  state.current = current;
  return { valid: true, changed: true, modeState: current, stage };
}

function prepareTrimGameLoad(user, req = {}, stage = {}, options = {}) {
  const isTrim = String(stage.miscMode || "").toLowerCase() === "trim" || Number(stage.gameType || 0) === 23;
  if (!isTrim) return null;
  const state = readTrimState(user, options);
  const current = normalizeCurrentState(state.current, options.tables || loadTables());
  const requestedDungeonId = nonNegativeInt(req.dungeonID || req.dungeonId || stage.dungeonID || stage.dungeonId);
  if (!current || !requestedDungeonId || requestedDungeonId !== current.nextDungeonId) {
    return { valid: false, errorCode: ERRORS.INVALID_TRIM_DUNGEON };
  }
  if (!validateEventDeckList(user, current.eventDeckList).valid) {
    return { valid: false, errorCode: ERRORS.EVENT_DECK_LIST_SETTING };
  }
  const index = current.dungeonIds.indexOf(requestedDungeonId);
  if (index < 0 || index >= current.eventDeckList.length) {
    return { valid: false, errorCode: LIFECYCLE_ERRORS.OUT_RANGE_TRIM_INDEX };
  }
  return {
    valid: true,
    eventDeckData: {
      ...current.eventDeckList[index],
      units: Object.fromEntries(current.eventDeckList[index].units.map((unit) => [unit.slotIndex, unit.unitUid])),
    },
    stage: { ...stage, trimId: current.trimId, trimLevel: current.trimLevel, miscMode: "trim", gameType: 23 },
    current,
  };
}

function grantTrimReward(ctx, user, row) {
  const reward = createEmptyReward();
  const regDate = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n;
  const fixedType = String(row.fixRewardType || "");
  if (fixedType && fixedType !== "RT_NONE" && row.fixRewardId > 0) {
    mergeReward(reward, grantRewardByType(ctx, user, fixedType, row.fixRewardId, 1, 1, 0, { regDate, expandPackages: false }));
  }
  if (row.creditMax > 0) {
    const credit = row.creditMin + nextInt(ctx, row.creditMax - row.creditMin + 1);
    mergeReward(reward, grantRewardByType(ctx, user, "RT_MISC", 1, credit, credit, 0, { regDate, expandPackages: false }));
  }
  for (const groupId of row.rewardGroupIds) {
    const records = getRewardGroupRecords(groupId);
    const record = records[nextInt(ctx, records.length)];
    if (record) mergeReward(reward, grantRewardRecord(ctx, user, record, { regDate, expandPackages: false }));
  }
  if (row.userExp > 0) {
    grantUserExp(user, row.userExp, { reason: `trim:${row.trimId}:${row.trimLevel}` });
    reward.userExp = row.userExp;
  }
  return reward;
}

function readTrimState(user, options = {}) {
  const tables = options.tables || loadTables();
  const now = options.now || new Date();
  const interval = getActiveTrimInterval(now, tables);
  const stored = user && user.miscStages && user.miscStages.trim && typeof user.miscStages.trim === "object"
    ? user.miscStages.trim
    : {};
  const storedIntervalMatches = !interval || !stored.intervalTag || String(stored.intervalTag) === interval.dateStrId;
  const officialInterval = user && user.officialSnapshot && user.officialSnapshot.packet && user.officialSnapshot.packet.trimIntervalData || {};
  const clears = {};
  mergeClearList(clears, officialTrimClears(user));
  mergeClearList(clears, Object.values(stored.clears && typeof stored.clears === "object" ? stored.clears : {}));
  if (stored.lastClear) mergeClearList(clears, [{ ...stored.lastClear, isWin: true }]);
  const officialHasRetryCount = Object.prototype.hasOwnProperty.call(officialInterval, "trimRetryCount");
  const initialRetryCount = interval ? interval.resultResetLimit : 0;
  return {
    intervalTag: interval ? interval.dateStrId : String(stored.intervalTag || ""),
    intervalIndex: interval ? interval.index : nonNegativeInt(stored.intervalIndex),
    trimTryCount: storedIntervalMatches ? nonNegativeInt(stored.trimTryCount != null ? stored.trimTryCount : officialInterval.trimTryCount) : 0,
    trimRetryCount: storedIntervalMatches
      ? nonNegativeInt(stored.trimRetryCount != null
        ? stored.trimRetryCount
        : officialHasRetryCount
          ? officialInterval.trimRetryCount
          : initialRetryCount)
      : initialRetryCount,
    trimRestoreCount: storedIntervalMatches ? nonNegativeInt(stored.trimRestoreCount != null ? stored.trimRestoreCount : officialInterval.trimRestoreCount) : 0,
    clears,
    current: storedIntervalMatches ? normalizeCurrentState(stored.current, tables) : null,
  };
}

function ensureTrimState(user, options = {}) {
  const normalized = readTrimState(user, options);
  user.miscStages = user.miscStages && typeof user.miscStages === "object" ? user.miscStages : {};
  const previous = user.miscStages.trim && typeof user.miscStages.trim === "object" ? user.miscStages.trim : {};
  user.miscStages.trim = { ...previous, ...normalized };
  return user.miscStages.trim;
}

function buildTrimIntervalData(user, options = {}) {
  const state = readTrimState(user, options);
  return Buffer.concat([
    writeSignedVarInt(state.trimTryCount),
    writeSignedVarInt(state.trimRetryCount),
    writeSignedVarInt(state.trimRestoreCount),
  ]);
}

function buildTrimModeState(userOrState, options = {}) {
  const tables = options.tables || loadTables();
  const current = userOrState && (userOrState.current || userOrState.trimId)
    ? normalizeCurrentState(userOrState.current || userOrState, tables)
    : normalizeCurrentState(readTrimState(userOrState, { ...options, tables }).current, tables);
  return current ? serializeTrimModeState(current) : null;
}

function serializeTrimModeState(current) {
  return Buffer.concat([
    writeSignedVarInt(current.trimId),
    writeSignedVarInt(current.trimLevel),
    writeSignedVarInt(current.nextDungeonId),
    current.lastClearStage ? writeNullableObject(buildTrimStageData(current.lastClearStage)) : writeNullObject(),
    writeObjectList(current.stageList.map((stage) => writeNullableObject(buildTrimStageData(stage)))),
  ]);
}

function buildTrimStageData(stage = {}) {
  return Buffer.concat([
    writeSignedVarInt(nonNegativeInt(stage.index)),
    writeSignedVarInt(nonNegativeInt(stage.dungeonId || stage.dungeonID)),
    writeSignedVarInt(nonNegativeInt(stage.score)),
    writeBool(stage.isWin === true),
  ]);
}

function buildTrimClearDataList(user, options = {}) {
  return Object.values(readTrimState(user, options).clears)
    .sort((left, right) => left.trimId - right.trimId || left.trimLevel - right.trimLevel)
    .map(buildTrimClearData);
}

function buildTrimClearData(clear = {}) {
  return Buffer.concat([
    writeBool(Boolean(clear.isWin)),
    writeSignedVarInt(nonNegativeInt(clear.trimId)),
    writeSignedVarInt(nonNegativeInt(clear.trimLevel)),
    writeSignedVarInt(nonNegativeInt(clear.score)),
    clear.rewardData ? writeNullableObject(buildRewardData(clear.rewardData)) : writeNullObject(),
  ]);
}

function buildTrimDungeonSkipAckPayload(result = {}) {
  const success = Number(result.errorCode) === ERRORS.OK;
  const clear = success ? result.trimClearData : { isWin: false, trimId: 0, trimLevel: 0, score: 0 };
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeNullableObject(buildTrimClearData(clear)),
    writeObjectList((success && Array.isArray(result.rewardDatas) ? result.rewardDatas : []).map((reward) => writeNullableObject(buildRewardData(reward)))),
    writeObjectList((success && Array.isArray(result.costItems) ? result.costItems : []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    writeObjectList((success && Array.isArray(result.updatedUnits) ? result.updatedUnits : []).map((unit) => writeNullableObject(buildUnitLoyaltyUpdateData(unit)))),
  ]);
}

function buildTrimGameLoadFailurePayload(errorCode) {
  return Buffer.concat([writeSignedVarInt(Number(errorCode) || ERRORS.INVALID_TRIM_DUNGEON), writeNullObject()]);
}

function buildTrimStartAckPayload(result = {}) {
  const success = Number(result.errorCode) === ERRORS.OK;
  const modeState = success ? buildTrimModeState(result.current) : null;
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    modeState ? writeNullableObject(modeState) : writeNullObject(),
  ]);
}

function buildTrimRetryAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    result.rewardData ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
  ]);
}

function buildTrimRestoreAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    Number(result.errorCode) === ERRORS.OK && result.costItem
      ? writeNullableObject(buildItemMiscData(result.costItem))
      : writeNullObject(),
  ]);
}

function buildTrimEndAckPayload(result = {}) {
  const success = Number(result.errorCode) === ERRORS.OK;
  const modeState = success ? buildTrimModeState(result.modeState) : null;
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeBool(success && result.isFirst === true),
    writeSignedVarInt(success ? nonNegativeInt(result.bestScore) : 0),
    modeState ? writeNullableObject(modeState) : writeNullObject(),
    success && result.trimClearData ? writeNullableObject(buildTrimClearData(result.trimClearData)) : writeNullObject(),
    writeObjectList((success && Array.isArray(result.costItems) ? result.costItems : []).map((item) => writeNullableObject(buildItemMiscData(item)))),
  ]);
}

function buildTrimIntervalInfoNotPayload(user, options = {}) {
  const tables = options.tables || loadTables();
  const interval = options.interval || getActiveTrimInterval(options.now || new Date(), tables);
  return Buffer.concat([
    writeSignedVarInt(interval ? interval.index : 0),
    writeNullableObject(buildTrimIntervalData(user, { ...options, tables })),
    writeObjectList(buildTrimClearDataList(user, { ...options, tables }).map(writeNullableObject)),
  ]);
}

function buildUnitLoyaltyUpdateData(unit = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(unit.unitUid || unit.m_UnitUID || 0)),
    writeSignedVarInt(nonNegativeInt(unit.loyalty)),
    writeSignedVarInt(nonNegativeInt(unit.officeRoomId)),
    writeSignedVarInt(nonNegativeInt(unit.officeGrade)),
    writeInt64LE(toBigInt(unit.officeGaugeStartTime || unit.heartGaugeStartTime || 0)),
  ]);
}

function loadTables() {
  if (tablesCache) return tablesCache;
  const records = (fileName) => readGameplayTableRecords("ab_script", fileName, { rootDir: ROOT_DIR, logLabel: "trim" });
  const templateRows = records("LUA_TRIM_TEMPLET.json");
  const dungeonRows = records("LUA_TRIM_DUNGEON.json");
  const pointRows = records("LUA_TRIM_POINT.json");
  const rewardRows = records("LUA_TRIM_REWARD_CL.json");
  const intervalRows = records("LUA_TRIM_INTERVAL.json");
  const intervalDates = new Map(records("LUA_INTERVAL_TEMPLET.json").map((row) => [String(row.m_DateStrID || ""), row]));
  const templatesById = new Map(templateRows.map((row) => [Number(row.TrimID), {
    trimId: Number(row.TrimID),
    openTag: String(row.m_OpenTag || ""),
    activeBattleSkip: row.m_bActiveBattleSkip === true,
    stageReqItemId: nonNegativeInt(row.m_StageReqItemID),
    stageReqItemCount: nonNegativeInt(row.m_StageReqItemCount),
    pointGroup: nonNegativeInt(row.TrimPointGroup),
    unlockReqType: String(row.m_UnlockReqType || ""),
    unlockReqValue: nonNegativeInt(row.m_UnlockReqValue),
  }]));
  const dungeonsByTrimAndLevel = new Map();
  for (const row of dungeonRows) {
    for (let level = nonNegativeInt(row.TrimLevel_Low); level <= nonNegativeInt(row.TrimLevel_High); level += 1) {
      const key = `${Number(row.TrimID)}:${level}`;
      const list = dungeonsByTrimAndLevel.get(key) || [];
      list.push(Number(row.DungeonID));
      dungeonsByTrimAndLevel.set(key, list);
    }
  }
  const rewardsByTrimAndLevel = new Map(rewardRows.map((row) => {
    const normalized = {
      trimId: Number(row.TrimID),
      trimLevel: Number(row.TrimLevel),
      fixRewardType: String(row.FixRewardType || ""),
      fixRewardId: nonNegativeInt(row.FixRewardID),
      creditMin: nonNegativeInt(row.m_RewardCredit_Min),
      creditMax: nonNegativeInt(row.m_RewardCredit_Max),
      rewardGroupIds: [1, 2, 3, 4, 5].map((index) => nonNegativeInt(row[`m_RewardGroupID_${index}`])).filter(Boolean),
      userExp: nonNegativeInt(row.m_RewardUserEXP),
    };
    return [`${normalized.trimId}:${normalized.trimLevel}`, normalized];
  }));
  const pointsByGroupAndLevel = new Map(pointRows.map((row) => {
    const group = nonNegativeInt(row.TrimPointGroup);
    const level = nonNegativeInt(row.TrimLevel);
    return [`${group}:${level}`, {
      group,
      level,
      points: [1, 2, 3].map((index) => ({
        maxDamagePoint: nonNegativeInt(row[`TrimMaxDamagePoint_${index}`]),
        maxTimePoint: nonNegativeInt(row[`TrimMaxTimePoint_${index}`]),
        stageClearPoint: nonNegativeInt(row[`TrimStageClearPoint_${index}`]),
      })),
    }];
  }));
  const intervals = intervalRows.map((row) => {
    const dateStrId = String(row.m_DateStrID || "");
    const date = intervalDates.get(dateStrId) || {};
    return {
      index: nonNegativeInt(row.INDEX),
      dateStrId,
      start: parseTableDate(date.m_DateStart),
      end: parseTableDate(date.m_DateEnd),
      trimIds: [1, 2, 3].map((index) => nonNegativeInt(row[`TrimSlotID_${index}`])).filter(Boolean),
      weeklyEnterLimit: nonNegativeInt(row.WeeklyEnterLimit),
      resultResetLimit: nonNegativeInt(row.ResultResetLimit),
      restoreLimitCount: nonNegativeInt(row.RestoreLimitCount),
      restoreLimitReqItemId: nonNegativeInt(row.RestoreLimitReqItemID),
      restoreLimitReqItemCounts: [1, 2, 3].map((index) => nonNegativeInt(row[`RestoreLimitReqItemCount_${index}`])),
    };
  }).filter((row) => row.start && row.end && row.trimIds.length);
  tablesCache = {
    templateRows,
    dungeonRows,
    pointRows,
    rewardRows,
    intervalRows,
    templatesById,
    dungeonsByTrimAndLevel,
    pointsByGroupAndLevel,
    rewardsByTrimAndLevel,
    intervals,
  };
  return tablesCache;
}

function getActiveTrimInterval(now = new Date(), tables = loadTables()) {
  const time = new Date(now).getTime();
  return tables.intervals
    .filter((row) => row.start.getTime() <= time && time < row.end.getTime())
    .sort((left, right) => right.index - left.index)[0] || null;
}

function normalizeCurrentState(value, tables = loadTables()) {
  if (!value || typeof value !== "object") return null;
  const trimId = nonNegativeInt(value.trimId);
  const trimLevel = nonNegativeInt(value.trimLevel);
  const dungeonIds = (tables.dungeonsByTrimAndLevel.get(`${trimId}:${trimLevel}`) || []).map(nonNegativeInt);
  if (!trimId || !trimLevel || dungeonIds.length !== REQUIRED_DECK_COUNT) return null;
  const stageList = normalizeStageList(value.stageList, dungeonIds);
  const lastClearStage = normalizeStage(value.lastClearStage, dungeonIds);
  const nextDungeonId = nonNegativeInt(value.nextDungeonId);
  return {
    ...value,
    trimId,
    trimLevel,
    intervalIndex: nonNegativeInt(value.intervalIndex),
    eventDeckList: Array.isArray(value.eventDeckList) ? value.eventDeckList.map(cloneDeck) : [],
    dungeonIds,
    stageList,
    lastClearStage,
    nextDungeonId: dungeonIds.includes(nextDungeonId) ? nextDungeonId : 0,
    costItemId: nonNegativeInt(value.costItemId),
    costItemCount: nonNegativeInt(value.costItemCount),
  };
}

function normalizeStageList(value, dungeonIds) {
  const seen = new Set();
  const output = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const stage = normalizeStage(entry, dungeonIds);
    if (!stage || seen.has(stage.index)) continue;
    seen.add(stage.index);
    output.push(stage);
  }
  return output.sort((left, right) => left.index - right.index);
}

function normalizeStage(value, dungeonIds) {
  if (!value || typeof value !== "object") return null;
  const index = nonNegativeInt(value.index);
  const dungeonId = nonNegativeInt(value.dungeonId || value.dungeonID);
  if (index >= REQUIRED_DECK_COUNT || dungeonIds[index] !== dungeonId) return null;
  return { index, dungeonId, score: nonNegativeInt(value.score), isWin: value.isWin === true };
}

function cloneDeck(deck = {}) {
  return {
    shipUid: uidString(deck.shipUid),
    units: Array.isArray(deck.units)
      ? deck.units.map((unit) => ({ slotIndex: Number(unit && unit.slotIndex), unitUid: uidString(unit && unit.unitUid) }))
      : [],
    operatorUid: uidString(deck.operatorUid),
    leaderIndex: Number(deck.leaderIndex),
  };
}

function resolveTrimStageScore(current, index, isWin, result, tables) {
  const battleState = result && result.battleState && typeof result.battleState === "object" ? result.battleState : {};
  const explicit = [
    result && result.trimPoint,
    result && result.gamePoint,
    battleState.trimPoint,
    battleState.TrimPoint,
    battleState.gamePoint,
    battleState.GamePoint,
  ].map(Number).find((value) => Number.isFinite(value) && value >= 0);
  if (explicit != null && (explicit > 0 || !isWin)) return Math.round(explicit);
  if (!isWin) return 0;
  const template = tables.templatesById.get(current.trimId) || {};
  const pointRow = tables.pointsByGroupAndLevel.get(`${template.pointGroup || current.trimId}:${current.trimLevel}`);
  return nonNegativeInt(pointRow && pointRow.points && pointRow.points[index] && pointRow.points[index].stageClearPoint);
}

function isTrimUnlocked(user, template) {
  if (String(template.unlockReqType || "") !== "SURT_CLEAR_DUNGEON" || !template.unlockReqValue) return true;
  const key = String(template.unlockReqValue);
  if (user && user.dungeonClear && user.dungeonClear[key]) return true;
  if (user && user.clearConditions && user.clearConditions.dungeons && user.clearConditions.dungeons[key]) return true;
  return Array.isArray(user && user.unlockedStageIds) && user.unlockedStageIds.includes(template.unlockReqValue);
}

function officialTrimClears(user) {
  const list = user && user.officialSnapshot && user.officialSnapshot.packet && user.officialSnapshot.packet.trimClearList;
  return Array.isArray(list) ? list : [];
}

function mergeClearList(target, entries) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    const clear = normalizeClear(entry);
    if (!clear) continue;
    const key = `${clear.trimId}:${clear.trimLevel}`;
    const previous = target[key];
    if (!previous || (clear.isWin && !previous.isWin) || clear.score > previous.score) target[key] = clear;
  }
}

function normalizeClear(entry) {
  const trimId = nonNegativeInt(entry && entry.trimId);
  const trimLevel = nonNegativeInt(entry && entry.trimLevel);
  if (!trimId || !trimLevel) return null;
  return { isWin: entry.isWin === true, trimId, trimLevel, score: nonNegativeInt(entry.score), rewardData: entry.rewardData || null };
}

function findOwned(user, bucketName, uid) {
  const bucket = user && user.army && user.army[bucketName] && typeof user.army[bucketName] === "object" ? user.army[bucketName] : {};
  if (bucket[uid]) return bucket[uid];
  return Object.values(bucket).find((entry) => uidString(entry && (entry.unitUid != null ? entry.unitUid : entry.uid)) === uid) || null;
}

function isEffectiveTagOpen(ctx, user, tag) {
  const expected = String(tag || "").toUpperCase();
  if (!expected) return true;
  const own = Array.isArray(user && user.openTags) ? user.openTags : [];
  if (own.some((value) => String(value || "").toUpperCase() === expected)) return true;
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return false;
  return (ctx.getEffectiveOpenTags(own) || []).some((value) => String(value || "").toUpperCase() === expected);
}

function trackSkipMissions(ctx, socket, user, result) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const now = typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  const cleared = ctx.trackMissionEvent(user, "TRIM_DUNGEON_CLEARED", result.skipCount, {
    now, trimId: result.trimId, trimLevel: result.trimLevel, value: result.trimId,
  });
  addMissionTrackingCondition(tracking, "TRIM_DUNGEON_CLEARED", cleared);
  const spent = ctx.trackMissionEvent(user, "USE_RESOURCE", result.totalCost, {
    now, itemId: result.costItemId, resourceId: result.costItemId, value: result.costItemId,
  });
  addMissionTrackingCondition(tracking, "USE_RESOURCE", spent);
  completeMissionTracking(ctx, socket, user, tracking, { label: "trim-dungeon-skip-mission-update" });
}

function commitLifecycleMutation(ctx, socket, user, result, label) {
  if (!result || result.errorCode !== ERRORS.OK || result.changed !== true) return false;
  trackLifecycleMissions(ctx, socket, user, result, label);
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
    ctx.invalidateJoinLobbyAckPayloadCache(label);
  }
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  if (ctx && typeof ctx.sendServerGamePacket === "function") {
    ctx.sendServerGamePacket(socket, PACKETS.TRIM_INTERVAL_INFO_NOT, buildTrimIntervalInfoNotPayload(user, {
      now: getNow(ctx),
    }), `${label}-interval-info`);
  }
  return true;
}

function trackLifecycleMissions(ctx, socket, user, result, label) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const now = typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  if (result.completed === true) {
    addMissionTrackingCondition(tracking, "TRIM_DUNGEON_CLEARED", ctx.trackMissionEvent(user, "TRIM_DUNGEON_CLEARED", 1, {
      now,
      trimId: result.trimId,
      trimLevel: result.trimLevel,
      value: result.trimId,
    }));
  }
  if (result.totalCost > 0 && result.costItemId > 0) {
    addMissionTrackingCondition(tracking, "USE_RESOURCE", ctx.trackMissionEvent(user, "USE_RESOURCE", result.totalCost, {
      now,
      itemId: result.costItemId,
      resourceId: result.costItemId,
      value: result.costItemId,
    }));
  }
  completeMissionTracking(ctx, socket, user, tracking, { label: `${label}-mission-update` });
}

function send(ctx, socket, packet, packetId, payload, label = "trim-dungeon-skip") {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
    return;
  }
  if (ctx && typeof ctx.sendResponse === "function") {
    ctx.sendResponse(socket, packet.sequence, packetId, () => ctx.buildEncryptedPacket(packet.sequence, packetId, payload));
  }
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function getNow(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") return new Date(ctx.getServerNowDate());
  return new Date();
}

function getItemBalance(user, itemId) {
  const misc = user && user.inventory && user.inventory.misc && typeof user.inventory.misc === "object" ? user.inventory.misc : {};
  const item = misc[String(Number(itemId))] || {};
  return toBigInt(item.countFree != null ? item.countFree : item.count || 0) + toBigInt(item.countPaid || 0);
}

function nextInt(ctx, max) {
  if (!Number.isInteger(max) || max <= 1) return 0;
  const value = ctx && typeof ctx.randomInt === "function" ? Number(ctx.randomInt(max)) : cryptoRandomInt(max);
  return Math.max(0, Math.min(max - 1, Math.trunc(value) || 0));
}

function parseTableDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number((match[7] || "").slice(0, 3).padEnd(3, "0") || 0)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function readRawVarInt(buffer, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (shift <= 28) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function failure(errorCode, error = null) {
  return { errorCode, changed: false, error: error ? String(error.message || error) : "" };
}

function restoreFailure(user, snapshot, result) {
  restoreUser(user, snapshot);
  return result;
}

function uidString(value) {
  return String(toBigInt(value || 0));
}

function nonNegativeInt(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function cloneUser(user) {
  return user && typeof user === "object" ? JSON.parse(JSON.stringify(user)) : null;
}

function restoreUser(user, snapshot) {
  if (!user || typeof user !== "object" || !snapshot) return;
  for (const key of Object.keys(user)) delete user[key];
  Object.assign(user, snapshot);
}

module.exports = {
  ERRORS,
  LIFECYCLE_ERRORS,
  MAX_SKIP_COUNT,
  PACKETS,
  REQUIRED_DECK_COUNT,
  buildTrimClearData,
  buildTrimClearDataList,
  buildTrimDungeonSkipAckPayload,
  buildTrimEndAckPayload,
  buildTrimGameLoadFailurePayload,
  buildTrimIntervalInfoNotPayload,
  buildTrimIntervalData,
  buildTrimModeState,
  buildTrimRestoreAckPayload,
  buildTrimRetryAckPayload,
  buildTrimStartAckPayload,
  createTrimHandlers,
  decodeTrimDungeonSkipReq,
  decodeTrimStartReq,
  endTrim,
  ensureTrimState,
  getActiveTrimInterval,
  loadTables,
  prepareTrimGameLoad,
  readTrimState,
  recordTrimBattleResult,
  restoreTrim,
  retryTrim,
  skipTrimDungeon,
  startTrim,
  validateTrimDungeonSkip,
  validateTrimStart,
};
