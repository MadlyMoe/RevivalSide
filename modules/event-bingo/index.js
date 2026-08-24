"use strict";

const path = require("path");
const { randomInt } = require("crypto");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  buildItemMiscData,
  buildRewardData,
  readSignedVarInt,
  writeIntList,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const { getMiscItem, spendMiscItem, toBigInt } = require("../inventory");

const ROOT_DIR = path.resolve(__dirname, "..", "..");

const PACKETS = Object.freeze({
  RANDOM_MARK_REQ: 3000,
  RANDOM_MARK_ACK: 3001,
  INDEX_MARK_REQ: 3002,
  INDEX_MARK_ACK: 3003,
  REWARD_REQ: 3004,
  REWARD_ACK: 3005,
  REWARD_ALL_REQ: 3006,
  REWARD_ALL_ACK: 3007,
});

const ERRORS = Object.freeze({
  OK: 0,
  EVENT_INVALID_ID: 20365,
  EVENT_INVALID_REWARD_ID: 20366,
  EVENT_BINGO_CREATE: 20367,
  EVENT_NOT_ALL_CLEARED: 20368,
  EVENT_ALREADY_CLEARED: 20369,
  EVENT_END: 20371,
  EVENT_BINGO_ALREADY_MARKED: 20372,
  EVENT_BINGO_ALREADY_REWARD: 20373,
  EVENT_BINGO_NOT_ENOUGH_MILEAGE: 20374,
  EVENT_BINGO_NOT_ENOUGH_ITEM: 20375,
  EVENT_BINGO_INVALID_DATA: 20376,
  EVENT_BINGO_NO_EXIST_UPDATABLE_REWARD: 20377,
  EVENT_BINGO_INVALID_TILE_INDEX: 20905,
});

let cachedTables = null;

function createEventBingoHandlers() {
  return [
    [PACKETS.RANDOM_MARK_REQ, "EVENT_BINGO_RANDOM_MARK_REQ", handleRandomMark],
    [PACKETS.INDEX_MARK_REQ, "EVENT_BINGO_INDEX_MARK_REQ", handleIndexMark],
    [PACKETS.REWARD_REQ, "EVENT_BINGO_REWARD_REQ", handleReward],
    [PACKETS.REWARD_ALL_REQ, "EVENT_BINGO_REWARD_ALL_REQ", handleRewardAll],
  ].map(([packetId, name, handle]) => ({ packetId, name, handle }));
}

function handleRandomMark(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeSingleIntRequest(ctx, packet.payload, "eventId");
  const result = randomMark(ctx, user, request);
  send(ctx, socket, packet, PACKETS.RANDOM_MARK_ACK, buildRandomMarkAck(result));
  finishMutation(ctx, user, result, "event-bingo-random");
  return true;
}

function handleIndexMark(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeIndexMarkRequest(ctx, packet.payload);
  const result = indexMark(ctx, user, request);
  send(ctx, socket, packet, PACKETS.INDEX_MARK_ACK, buildIndexMarkAck(result));
  finishMutation(ctx, user, result, "event-bingo-index");
  return true;
}

function handleReward(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeRewardRequest(ctx, packet.payload);
  const result = claimReward(ctx, user, request);
  send(ctx, socket, packet, PACKETS.REWARD_ACK, buildRewardAck(result));
  finishMutation(ctx, user, result, "event-bingo-reward");
  return true;
}

function handleRewardAll(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeSingleIntRequest(ctx, packet.payload, "eventId");
  const result = claimAllRewards(ctx, user, request);
  send(ctx, socket, packet, PACKETS.REWARD_ALL_ACK, buildRewardAllAck(result));
  finishMutation(ctx, user, result, "event-bingo-reward-all");
  return true;
}

function randomMark(ctx, user, request) {
  const base = emptyResult(request && request.eventId);
  if (!request || !request.valid || request.eventId <= 0) return { ...base, errorCode: ERRORS.EVENT_BINGO_INVALID_DATA };
  const resolved = resolveEvent(ctx, request.eventId);
  if (resolved.errorCode) return { ...base, errorCode: resolved.errorCode };
  const state = readBingoState(user, resolved.row);
  if (!state) return { ...base, errorCode: ERRORS.EVENT_BINGO_CREATE };
  const remaining = remainingRandomTiles(state, resolved.row);
  if (!remaining.length) return { ...base, state, errorCode: ERRORS.EVENT_ALREADY_CLEARED };
  const cost = Math.max(1, Number(resolved.row.tryItemValue) || 1);
  const item = getMiscItem(user, resolved.row.tryItemId);
  if (miscTotal(item) < BigInt(cost)) return { ...base, state, errorCode: ERRORS.EVENT_BINGO_NOT_ENOUGH_ITEM };

  const cursor = pickRandomIndex(ctx, remaining.length);
  const tileIndex = remaining[cursor];
  state.markTileIndexList.push(tileIndex);
  state.markTileIndexList.sort((left, right) => left - right);
  state.mileage += 1;
  commitBingoState(user, state);
  const costItemData = spendMiscItem(user, resolved.row.tryItemId, cost);
  const rewardData = createEmptyReward();
  rewardData.bingoTiles = [{ eventId: resolved.row.eventId, tileIndex }];
  return {
    ...base,
    changed: true,
    state,
    errorCode: ERRORS.OK,
    costItemData,
    mileage: state.mileage,
    rewardData,
    resourceSpend: { itemId: resolved.row.tryItemId, count: cost },
  };
}

function indexMark(ctx, user, request) {
  const base = emptyResult(request && request.eventId);
  if (!request || !request.valid || request.eventId <= 0 || !request.tileIndexes.length) {
    return { ...base, errorCode: ERRORS.EVENT_BINGO_INVALID_DATA };
  }
  const resolved = resolveEvent(ctx, request.eventId);
  if (resolved.errorCode) return { ...base, errorCode: resolved.errorCode };
  const state = readBingoState(user, resolved.row);
  if (!state) return { ...base, errorCode: ERRORS.EVENT_BINGO_CREATE };
  const missionTiles = new Set(resolved.row.missionTiles);
  const marked = new Set(state.markTileIndexList);
  for (const tileIndex of request.tileIndexes) {
    if (tileIndex < 0 || tileIndex >= resolved.row.tileCount || missionTiles.has(tileIndex)) {
      return { ...base, state, mileage: state.mileage, errorCode: ERRORS.EVENT_BINGO_INVALID_TILE_INDEX };
    }
    if (marked.has(tileIndex)) {
      return { ...base, state, mileage: state.mileage, errorCode: ERRORS.EVENT_BINGO_ALREADY_MARKED };
    }
  }
  const mileageCost = resolved.row.specialTryCount * request.tileIndexes.length;
  if (state.mileage < mileageCost) {
    return { ...base, state, mileage: state.mileage, errorCode: ERRORS.EVENT_BINGO_NOT_ENOUGH_MILEAGE };
  }

  state.markTileIndexList.push(...request.tileIndexes);
  state.markTileIndexList.sort((left, right) => left - right);
  state.mileage -= mileageCost;
  commitBingoState(user, state);
  const rewardData = createEmptyReward();
  rewardData.bingoTiles = request.tileIndexes.map((tileIndex) => ({ eventId: resolved.row.eventId, tileIndex }));
  return { ...base, changed: true, state, errorCode: ERRORS.OK, mileage: state.mileage, rewardData };
}

function claimReward(ctx, user, request) {
  const base = emptyResult(request && request.eventId);
  base.rewardIndex = Number(request && request.rewardIndex) || 0;
  if (!request || !request.valid || request.eventId <= 0 || request.rewardIndex < 0) {
    return { ...base, errorCode: ERRORS.EVENT_BINGO_INVALID_DATA };
  }
  const resolved = resolveEvent(ctx, request.eventId);
  if (resolved.errorCode) return { ...base, errorCode: resolved.errorCode };
  const rewardRow = resolved.row.rewardsByIndex.get(request.rewardIndex);
  if (!rewardRow) return { ...base, errorCode: ERRORS.EVENT_INVALID_REWARD_ID };
  const state = readBingoState(user, resolved.row);
  if (!state) return { ...base, errorCode: ERRORS.EVENT_BINGO_CREATE };
  if (state.rewardList.includes(request.rewardIndex)) {
    return { ...base, state, errorCode: ERRORS.EVENT_BINGO_ALREADY_REWARD };
  }
  if (!isRewardEligible(state, resolved.row, rewardRow)) {
    return { ...base, state, errorCode: ERRORS.EVENT_NOT_ALL_CLEARED };
  }
  const rewardData = grantBingoRewardRow(ctx, user, rewardRow);
  state.rewardList.push(request.rewardIndex);
  state.rewardList.sort((left, right) => left - right);
  commitBingoState(user, state);
  return { ...base, changed: true, state, errorCode: ERRORS.OK, rewardData };
}

function claimAllRewards(ctx, user, request) {
  const base = emptyResult(request && request.eventId);
  if (!request || !request.valid || request.eventId <= 0) return { ...base, errorCode: ERRORS.EVENT_BINGO_INVALID_DATA };
  const resolved = resolveEvent(ctx, request.eventId);
  if (resolved.errorCode) return { ...base, errorCode: resolved.errorCode };
  const state = readBingoState(user, resolved.row);
  if (!state) return { ...base, errorCode: ERRORS.EVENT_BINGO_CREATE };
  const rewardRows = resolved.row.rewardRows.filter(
    (row) => !state.rewardList.includes(row.rewardIndex) && isRewardEligible(state, resolved.row, row)
  );
  if (!rewardRows.length) {
    return { ...base, state, errorCode: ERRORS.EVENT_BINGO_NO_EXIST_UPDATABLE_REWARD };
  }
  const rewardData = createEmptyReward();
  for (const row of rewardRows) mergeReward(rewardData, grantBingoRewardRow(ctx, user, row));
  const rewardIndexes = rewardRows.map((row) => row.rewardIndex).sort((left, right) => left - right);
  state.rewardList.push(...rewardIndexes);
  state.rewardList = uniqueInts(state.rewardList, 0, Number.MAX_SAFE_INTEGER);
  commitBingoState(user, state);
  return { ...base, changed: true, state, errorCode: ERRORS.OK, rewardIndexes, rewardData };
}

function buildRandomMarkAck(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    writeSignedVarInt(result.eventId),
    result.errorCode === ERRORS.OK && result.costItemData
      ? writeNullableObject(buildItemMiscData(result.costItemData))
      : writeNullObject(),
    writeSignedVarInt(result.mileage),
    result.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
  ]);
}

function buildIndexMarkAck(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    writeSignedVarInt(result.eventId),
    writeSignedVarInt(result.mileage),
    result.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
  ]);
}

function buildRewardAck(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    writeSignedVarInt(result.eventId),
    writeSignedVarInt(result.rewardIndex),
    result.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
  ]);
}

function buildRewardAllAck(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    writeSignedVarInt(result.eventId),
    writeIntList(result.rewardIndexes || []),
    result.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
  ]);
}

function buildEventInfoData(user, ctx = {}, options = {}) {
  const ids = options.eventIds || activeEventIds(ctx);
  const payloads = [];
  for (const eventId of ids) {
    const row = loadTables().bingoById.get(Number(eventId));
    if (!row || !row.valid) continue;
    const state = readBingoState(user, row);
    if (state) payloads.push(buildBingoInfoData(state));
  }
  return writeNullableObjectList(payloads);
}

function buildBingoInfoData(state) {
  return Buffer.concat([
    writeSignedVarInt(state.eventId),
    writeIntList(state.tileValueList),
    writeIntList(state.markTileIndexList),
    writeIntList(state.rewardList),
    writeSignedVarInt(state.mileage),
  ]);
}

function readBingoState(user, row) {
  if (!user || !row || !row.valid) return null;
  const source = user.eventBingo && typeof user.eventBingo === "object" ? user.eventBingo[String(row.eventId)] : null;
  const tileValueList = normalizeTileValues(source && source.tileValueList, user, row);
  const marks = uniqueInts(source && source.markTileIndexList, 0, row.tileCount - 1);
  const missionHistory = user.bingoTiles && Array.isArray(user.bingoTiles[String(row.eventId)])
    ? uniqueInts(user.bingoTiles[String(row.eventId)], 0, row.tileCount - 1)
    : [];
  const allowedMissionTiles = new Set(row.missionTiles);
  for (const tileIndex of missionHistory) if (allowedMissionTiles.has(tileIndex) && !marks.includes(tileIndex)) marks.push(tileIndex);
  marks.sort((left, right) => left - right);
  return {
    eventId: row.eventId,
    tileValueList,
    markTileIndexList: marks,
    rewardList: uniqueInts(source && source.rewardList, 0, row.rewardRows.length - 1),
    mileage: Math.max(0, Math.trunc(Number(source && source.mileage) || 0)),
  };
}

function commitBingoState(user, state) {
  user.eventBingo = user.eventBingo && typeof user.eventBingo === "object" && !Array.isArray(user.eventBingo)
    ? user.eventBingo
    : {};
  user.eventBingo[String(state.eventId)] = {
    eventId: state.eventId,
    tileValueList: state.tileValueList.slice(),
    markTileIndexList: state.markTileIndexList.slice(),
    rewardList: state.rewardList.slice(),
    mileage: state.mileage,
  };
}

function resolveEvent(ctx, eventId) {
  const row = loadTables().bingoById.get(Number(eventId));
  if (!row || !row.valid) return { errorCode: ERRORS.EVENT_INVALID_ID, row: null };
  if (!activeEventIds(ctx).includes(row.eventId)) return { errorCode: ERRORS.EVENT_END, row };
  return { errorCode: ERRORS.OK, row };
}

function activeEventIds(ctx) {
  const manager = ctx && ctx.eventManager;
  if (!manager || typeof manager.getActiveEventState !== "function") return loadTables().activeCapableIds.slice();
  try {
    const state = manager.getActiveEventState();
    const ids = new Set();
    for (const entry of Array.isArray(state && state.entries) ? state.entries : []) {
      const raw = entry && entry.raw;
      const eventId = Number(raw && (raw.m_EventID || raw.EventID || raw.eventId) || 0);
      if (eventId > 0 && loadTables().bingoById.has(eventId)) ids.add(eventId);
    }
    return Array.from(ids).sort((left, right) => left - right);
  } catch (_) {
    return [];
  }
}

function isRewardEligible(state, row, rewardRow) {
  const lines = completedLineIndexes(state.markTileIndexList, row.size);
  if (rewardRow.completeType === "LINE_SINGLE") return lines.includes(rewardRow.completeValue - 1);
  return rewardRow.completeType === "LINE_SET" && lines.length >= rewardRow.completeValue;
}

function completedLineIndexes(markedTiles, size) {
  const marked = new Set(markedTiles);
  const lines = [];
  for (let row = 0; row < size; row += 1) {
    if (Array.from({ length: size }, (_, column) => row * size + column).every((tile) => marked.has(tile))) lines.push(row);
  }
  for (let column = 0; column < size; column += 1) {
    if (Array.from({ length: size }, (_, row) => row * size + column).every((tile) => marked.has(tile))) lines.push(size + column);
  }
  if (Array.from({ length: size }, (_, index) => index * (size + 1)).every((tile) => marked.has(tile))) lines.push(size * 2);
  if (Array.from({ length: size }, (_, index) => (index + 1) * (size - 1)).every((tile) => marked.has(tile))) lines.push(size * 2 + 1);
  return lines;
}

function grantBingoRewardRow(ctx, user, row) {
  const reward = createEmptyReward();
  for (const item of row.rewards) {
    mergeReward(
      reward,
      grantRewardByType(ctx, user, item.type, item.id, item.value, item.value, 0, { expandPackages: true })
    );
  }
  return reward;
}

function remainingRandomTiles(state, row) {
  const marked = new Set(state.markTileIndexList);
  const missions = new Set(row.missionTiles);
  return Array.from({ length: row.tileCount }, (_, index) => index).filter((index) => !marked.has(index) && !missions.has(index));
}

function normalizeTileValues(values, user, row) {
  const list = Array.isArray(values) ? values.map(Number) : [];
  const expectedValues = Array.from({ length: row.tileCount - row.missionTiles.length }, (_, index) => index + 1);
  const actualValues = list.filter((value, index) => !row.missionTiles.includes(index)).slice().sort((left, right) => left - right);
  if (list.length === row.tileCount && expectedValues.every((value, index) => actualValues[index] === value)) return list;
  const shuffled = deterministicShuffle(expectedValues, `${String(user.userUid || "0")}:${row.eventId}`);
  const missionTiles = new Set(row.missionTiles);
  let cursor = 0;
  return Array.from({ length: row.tileCount }, (_, index) => missionTiles.has(index) ? 0 : shuffled[cursor++]);
}

function deterministicShuffle(values, seedText) {
  const result = values.slice();
  let seed = 2166136261;
  for (const byte of Buffer.from(String(seedText))) seed = Math.imul(seed ^ byte, 16777619) >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const cursor = seed % (index + 1);
    [result[index], result[cursor]] = [result[cursor], result[index]];
  }
  return result;
}

function pickRandomIndex(ctx, length) {
  if (ctx && typeof ctx.randomInt === "function") {
    const value = Math.trunc(Number(ctx.randomInt(length)) || 0);
    return Math.max(0, Math.min(length - 1, value));
  }
  return randomInt(length);
}

function decodeSingleIntRequest(ctx, payload, key) {
  const buffer = decrypt(ctx, payload);
  const value = safeReadInt(buffer, 0);
  return { [key]: value.value, valid: value.valid && value.offset === buffer.length };
}

function decodeRewardRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  const eventId = safeReadInt(buffer, 0);
  const rewardIndex = safeReadInt(buffer, eventId.offset);
  return {
    eventId: eventId.value,
    rewardIndex: rewardIndex.value,
    valid: eventId.valid && rewardIndex.valid && rewardIndex.offset === buffer.length,
  };
}

function decodeIndexMarkRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  const eventId = safeReadInt(buffer, 0);
  if (!eventId.valid) return { eventId: 0, tileIndexes: [], valid: false };
  try {
    const count = readUnsignedVarInt(buffer, eventId.offset);
    if (count.value > 36) return { eventId: eventId.value, tileIndexes: [], valid: false };
    let offset = count.offset;
    const tileIndexes = [];
    for (let index = 0; index < count.value; index += 1) {
      const tile = readSignedVarInt(buffer, offset);
      offset = tile.offset;
      tileIndexes.push(tile.value);
    }
    return {
      eventId: eventId.value,
      tileIndexes,
      valid: offset === buffer.length && new Set(tileIndexes).size === tileIndexes.length,
    };
  } catch (_) {
    return { eventId: eventId.value, tileIndexes: [], valid: false };
  }
}

function readUnsignedVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (shift <= 28) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function safeReadInt(buffer, offset) {
  try {
    return { ...readSignedVarInt(buffer, offset), valid: true };
  } catch (_) {
    return { value: 0, offset, valid: false };
  }
}

function decrypt(ctx, payload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function finishMutation(ctx, user, result, reason) {
  if (!result.changed) return;
  if (result.resourceSpend && typeof ctx.trackMissionEvent === "function") {
    ctx.trackMissionEvent(user, "USE_RESOURCE", result.resourceSpend.count, {
      itemId: result.resourceSpend.itemId,
      resourceId: result.resourceSpend.itemId,
      value: result.resourceSpend.itemId,
    });
  }
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function send(ctx, socket, packet, packetId, payload) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, "event-bingo");
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

function emptyResult(eventId) {
  return {
    changed: false,
    errorCode: ERRORS.EVENT_BINGO_INVALID_DATA,
    eventId: Number(eventId) || 0,
    rewardIndex: 0,
    rewardIndexes: [],
    mileage: 0,
    rewardData: null,
    costItemData: null,
  };
}

function miscTotal(item) {
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function uniqueInts(values, min, max) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= min && value <= max)
    )
  ).sort((left, right) => left - right);
}

function loadTables() {
  if (cachedTables) return cachedTables;
  const bingoRows = readGameplayTableRecords("ab_script", "LUA_EVENT_BINGO_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-bingo",
  });
  const rewardRows = readGameplayTableRecords("ab_script", "LUA_EVENT_BINGO_REWARD_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-bingo",
  });
  const missionRows = readGameplayTableRecords("ab_script", "LUA_MISSION_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-bingo",
  });
  const rewardsByGroup = new Map();
  for (const source of rewardRows) {
    const groupId = Number(source.m_BingoCompletRewardGroupID || 0);
    const rewardIndex = Number(source.m_index || 0) - 1;
    if (groupId <= 0 || rewardIndex < 0) continue;
    const rewards = [];
    for (let index = 1; index <= 3; index += 1) {
      const type = String(source[`m_BingoCompletRewardType_${index}`] || "");
      const id = Number(source[`m_BingoCompletRewardID_${index}`] || 0);
      const value = Number(source[`m_BingoCompletRewardValue_${index}`] || 0);
      if (type && id > 0 && value > 0) rewards.push({ type, id, value });
    }
    const row = {
      groupId,
      rewardIndex,
      completeType: String(source.m_BingoCompletType || ""),
      completeValue: Number(source.m_BingoCompletTypeValue || 0),
      rewards,
    };
    if (!rewardsByGroup.has(groupId)) rewardsByGroup.set(groupId, []);
    rewardsByGroup.get(groupId).push(row);
  }

  const bingoById = new Map();
  for (const source of bingoRows) {
    const eventId = Number(source.m_EventID || 0);
    const missionTabId = Number(source.m_BingoMissionTabID || 0);
    const missionTiles = [];
    for (const mission of missionRows) {
      if (Number(mission.m_MissionTabId || mission.m_MissionTabID || 0) !== missionTabId) continue;
      for (let index = 1; index <= 3; index += 1) {
        if (String(mission[`m_RewardType_${index}`] || "") !== "RT_BINGO_TILE") continue;
        if (Number(mission[`m_RewardID_${index}`] || 0) !== eventId) continue;
        missionTiles.push(Number(mission[`m_RewardValue_${index}`]));
      }
    }
    const size = Number(source.m_BingoSize || 0);
    const tileCount = size * size;
    const normalizedMissionTiles = uniqueInts(missionTiles, 0, tileCount - 1);
    const rewardGroupId = Number(source.m_BingoCompletRewardGroupID || 0);
    const rows = (rewardsByGroup.get(rewardGroupId) || []).slice().sort((left, right) => left.rewardIndex - right.rewardIndex);
    const row = {
      eventId,
      size,
      tileCount,
      tryItemId: Number(source.m_BingoTryItemID || 0),
      tryItemValue: Number(source.m_BingoTryItemValue || 0),
      specialTryCount: Number(source.m_BingoSpecialTryRequireCnt || 0),
      missionTabId,
      missionTiles: normalizedMissionTiles,
      rewardGroupId,
      rewardRows: rows,
      rewardsByIndex: new Map(rows.map((reward) => [reward.rewardIndex, reward])),
      valid: eventId > 0 && size > 0 && tileCount <= 64 && normalizedMissionTiles.length === 4 && rows.length > 0,
    };
    bingoById.set(eventId, row);
  }
  cachedTables = {
    bingoById,
    activeCapableIds: Array.from(bingoById.values()).filter((row) => row.valid).map((row) => row.eventId).sort((a, b) => a - b),
  };
  return cachedTables;
}

module.exports = {
  PACKETS,
  ERRORS,
  createEventBingoHandlers,
  buildEventInfoData,
  buildBingoInfoData,
  completedLineIndexes,
  readBingoState,
  loadTables,
};
