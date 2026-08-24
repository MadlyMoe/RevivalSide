"use strict";

const path = require("path");
const { randomInt: cryptoRandomInt } = require("crypto");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  buildRewardData,
  readSignedVarInt,
  readSignedVarLongList,
  writeIntList,
  writeLongArray,
  writeNullObject,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../packet-codec");
const { createEmptyReward } = require("../reward");
const { ensureArmy, grantUnit, removeArmyUnitUids } = require("../unit");
const { getUnitTemplet } = require("../game-data");
const { toBigInt } = require("../inventory");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const MAX_CONSUME_TROPHIES = 100;

const PACKETS = Object.freeze({
  EVENT_POINT_NOT: 3053,
  EVENT_COLLECTION_NOT: 3054,
  MERGE_REQ: 3055,
  MERGE_ACK: 3056,
});

const ERRORS = Object.freeze({
  OK: 0,
  UNIT_LOCKED: 135,
  UNIT_IN_DECK: 136,
  UNIT_IS_LOBBY_UNIT: 137,
  OFFICE_UNIT_DELETE_IN_ROOM: 20921,
  EVENT_END: 23000,
  INVALID_INDEX_TEMPLET: 23001,
  INVALID_MERGE_TEMPLET: 23002,
  INVALID_MERGE_GROUP_ID: 23003,
  MERGE_RECIPE_TEMPLET: 23004,
  MERGE_INVALID_INPUT_VALUE: 23005,
  MERGE_NOT_IN_COLLECTION_TEMPLET: 23006,
  MERGE_INVALID_INPUT_GROUP_ID: 23007,
  DB_FAIL_DELETE_TROPHY: 23008,
});

let cachedTables = null;

function createEventCollectionHandlers() {
  return [{ packetId: PACKETS.MERGE_REQ, name: "EVENT_COLLECTION_MERGE_REQ", handle: handleMerge }];
}

function handleMerge(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeMergeRequest(ctx, packet.payload);
  const result = mergeTrophies(ctx, user, request);
  sendResponse(ctx, socket, packet, PACKETS.MERGE_ACK, buildMergeAckPayload(result), "event-collection-merge");
  if (result.changed) {
    sendCollectionNotification(ctx, socket, user, result.index, "event-collection-update");
    if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
      ctx.invalidateJoinLobbyAckPayloadCache("event-collection-merge");
    }
    if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  }
  return true;
}

function mergeTrophies(ctx, user, request) {
  const base = emptyResult(request && request.collectionMergeId);
  if (!request || !request.valid) return { ...base, errorCode: ERRORS.MERGE_INVALID_INPUT_VALUE };

  const index = getActiveCollectionIndex(ctx);
  if (!index) return { ...base, errorCode: ERRORS.EVENT_END };
  const tables = loadTables();
  if (!tables.indexByMergeId.has(request.collectionMergeId)) {
    return { ...base, errorCode: ERRORS.INVALID_MERGE_TEMPLET };
  }
  if (index.collectionMergeId !== request.collectionMergeId) {
    return { ...base, errorCode: ERRORS.INVALID_MERGE_GROUP_ID };
  }
  const recipe = tables.recipeByKey.get(recipeKey(request.collectionMergeId, request.mergeRecipeGroupId));
  if (!recipe) return { ...base, errorCode: ERRORS.MERGE_RECIPE_TEMPLET };
  if (
    request.consumeTrophyUids.length !== recipe.inputValue ||
    request.consumeTrophyUids.length < 1 ||
    request.consumeTrophyUids.length > MAX_CONSUME_TROPHIES ||
    new Set(request.consumeTrophyUids.map(String)).size !== request.consumeTrophyUids.length ||
    request.consumeTrophyUids.some((uid) => uid <= 0n)
  ) {
    return { ...base, errorCode: ERRORS.MERGE_INVALID_INPUT_VALUE };
  }

  const army = ensureArmy(user);
  const consumed = [];
  for (const uid of request.consumeTrophyUids) {
    const key = uid.toString();
    const trophy = army.trophies[key];
    if (!trophy) return { ...base, errorCode: ERRORS.MERGE_NOT_IN_COLLECTION_TEMPLET };
    const detail = tables.detailByGoodsId.get(Number(trophy.unitId));
    if (!detail || detail.collectionMergeId !== recipe.collectionMergeId) {
      return { ...base, errorCode: ERRORS.MERGE_NOT_IN_COLLECTION_TEMPLET };
    }
    if (detail.gradeGroupId !== recipe.inputGradeGroupId) {
      return { ...base, errorCode: ERRORS.MERGE_INVALID_INPUT_GROUP_ID };
    }
    const statusError = getConsumeStatusError(user, trophy, key);
    if (statusError !== ERRORS.OK) return { ...base, errorCode: statusError };
    consumed.push(key);
  }

  const outputRows = tables.detailsByGradeGroup.get(recipe.outputGradeGroupId) || [];
  if (!outputRows.length) return { ...base, errorCode: ERRORS.MERGE_RECIPE_TEMPLET };
  const rewardData = createEmptyReward();
  for (let outputIndex = 0; outputIndex < recipe.outputValue; outputIndex += 1) {
    const output = pickWeighted(ctx, outputRows);
    const unit = output && grantUnit(user, output.goodsId, { fromContract: false });
    if (!unit) return { ...base, errorCode: ERRORS.MERGE_RECIPE_TEMPLET };
    rewardData.units.push(unit);
  }
  const removed = removeArmyUnitUids(user, consumed);
  if (removed.length !== consumed.length) {
    for (const unit of rewardData.units) delete ensureArmy(user).trophies[String(unit.unitUid)];
    return { ...base, errorCode: ERRORS.DB_FAIL_DELETE_TROPHY };
  }
  commitCollectionState(user, index);
  return {
    ...base,
    changed: true,
    errorCode: ERRORS.OK,
    index,
    rewardData,
    consumeTrophyUids: consumed.map(BigInt),
  };
}

function buildMergeAckPayload(result = {}) {
  const success = Number(result.errorCode) === ERRORS.OK;
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(Number(result.collectionMergeId) || 0),
    success ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
    writeLongArray(success ? result.consumeTrophyUids : []),
  ]);
}

function buildEventCollectionInfoData(user, ctx = {}, options = {}) {
  const index = options.index || getActiveCollectionIndex(ctx);
  if (!index) return Buffer.concat([writeSignedVarInt(0), writeIntList([])]);
  return Buffer.concat([writeSignedVarInt(index.eventId), writeIntList(getCollectedGoods(user, index))]);
}

function buildCollectionNotificationPayload(user, ctx = {}, options = {}) {
  return writeNullableObject(buildEventCollectionInfoData(user, ctx, options));
}

function sendCollectionNotification(ctx, socket, user, index = null, label = "event-collection-info") {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  const resolvedUser = user || socket && socket.session && socket.session.user;
  if (!resolvedUser) return false;
  ctx.sendServerGamePacket(
    socket,
    PACKETS.EVENT_COLLECTION_NOT,
    buildCollectionNotificationPayload(resolvedUser, ctx, { index: index || getActiveCollectionIndex(ctx) }),
    label
  );
  return true;
}

function buildEventPointPayload(totalEventPoint, additionalReward = null) {
  return Buffer.concat([
    writeSignedVarLong(nonNegativeBigInt(totalEventPoint)),
    additionalReward ? writeNullableObject(buildRewardData(additionalReward)) : writeNullObject(),
  ]);
}

function sendEventPointNotification(ctx, socket, totalEventPoint, additionalReward = null, label = "event-point-reward") {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  ctx.sendServerGamePacket(socket, PACKETS.EVENT_POINT_NOT, buildEventPointPayload(totalEventPoint, additionalReward), label);
  return true;
}

function getCollectedGoods(user, index) {
  const allowed = new Set(index.goodsIds);
  const values = [];
  const stored = user && user.eventCollection && user.eventCollection[String(index.eventId)];
  if (stored && Array.isArray(stored.goodsCollection)) values.push(...stored.goodsCollection);
  if (user && user.collection && Array.isArray(user.collection.trophies)) values.push(...user.collection.trophies);
  for (const trophy of Object.values(ensureArmy(user).trophies)) values.push(Number(trophy && trophy.unitId));
  return Array.from(new Set(values.map(Number).filter((value) => allowed.has(value)))).sort((left, right) => left - right);
}

function commitCollectionState(user, index) {
  if (!user || !index) return;
  user.eventCollection = user.eventCollection && typeof user.eventCollection === "object" && !Array.isArray(user.eventCollection)
    ? user.eventCollection
    : {};
  user.eventCollection[String(index.eventId)] = {
    eventId: index.eventId,
    goodsCollection: getCollectedGoods(user, index),
  };
}

function getActiveCollectionIndex(ctx = {}) {
  const tables = loadTables();
  const manager = ctx && ctx.eventManager;
  if (!manager || typeof manager.getActiveEventState !== "function") return tables.indexes[0] || null;
  let state;
  try {
    state = manager.getActiveEventState();
  } catch (_) {
    return null;
  }
  const eventIds = new Set();
  const openTags = new Set((state && state.openTags || []).map(normalizeTag));
  const intervalTags = new Set((state && state.intervalTags || []).map(normalizeTag));
  for (const entry of Array.isArray(state && state.entries) ? state.entries : []) {
    const raw = entry && entry.raw;
    const eventId = Number(raw && (raw.EventID || raw.m_EventID || raw.eventId) || 0);
    if (eventId > 0) eventIds.add(eventId);
    const openTag = normalizeTag(raw && (raw.OpenTag || raw.m_OpenTag));
    const intervalTag = normalizeTag(raw && (raw.DateStrID || raw.m_DateStrID));
    if (openTag) openTags.add(openTag);
    if (intervalTag) intervalTags.add(intervalTag);
  }
  return tables.indexes.find((index) =>
    eventIds.has(index.eventId) || openTags.has(normalizeTag(index.openTag)) || intervalTags.has(normalizeTag(index.intervalTag))
  ) || null;
}

function decodeMergeRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  try {
    const mergeId = readSignedVarInt(buffer, 0);
    const recipeGroupId = readSignedVarInt(buffer, mergeId.offset);
    const trophyUids = readSignedVarLongList(buffer, recipeGroupId.offset);
    return {
      collectionMergeId: mergeId.value,
      mergeRecipeGroupId: recipeGroupId.value,
      consumeTrophyUids: trophyUids.value,
      valid: trophyUids.offset === buffer.length && trophyUids.value.length <= MAX_CONSUME_TROPHIES,
    };
  } catch (_) {
    return { collectionMergeId: 0, mergeRecipeGroupId: 0, consumeTrophyUids: [], valid: false };
  }
}

function getConsumeStatusError(user, trophy, uid) {
  if (Boolean(trophy && (trophy.locked || trophy.bLock || trophy.m_bLock))) return ERRORS.UNIT_LOCKED;
  if (isUidInLobbyBackground(user, uid)) return ERRORS.UNIT_IS_LOBBY_UNIT;
  if (isUidInDeck(user, uid)) return ERRORS.UNIT_IN_DECK;
  if (isUidInOffice(user, trophy, uid)) return ERRORS.OFFICE_UNIT_DELETE_IN_ROOM;
  return ERRORS.OK;
}

function isUidInLobbyBackground(user, uid) {
  const key = String(uid);
  const state = user && user.lobbyCustomization;
  const info = state && state.backgroundInfo || user && (user.backGroundInfo || user.backgroundInfo);
  return Boolean(info && Array.isArray(info.unitInfoList) && info.unitInfoList.some(
    (entry) => String(toBigInt(entry && (entry.unitUid || entry.unitUID) || 0)) === key
  ));
}

function isUidInDeck(user, uid) {
  const key = String(uid);
  const army = ensureArmy(user);
  const decks = Object.values(army.deckSets || {}).filter(Array.isArray).concat([army.decks || []]).flat();
  return decks.some((deck) => {
    const values = deck && (deck.unitUids || deck.m_listDeckUnitUID || deck.m_UnitUIDList);
    return Array.isArray(values) && values.some((value) => String(toBigInt(value || 0)) === key);
  });
}

function isUidInOffice(user, trophy, uid) {
  if (Number(trophy && (trophy.officeRoomId || trophy.OfficeRoomId) || 0) > 0) return true;
  const key = String(uid);
  const rooms = user && user.office && Array.isArray(user.office.rooms) ? user.office.rooms : [];
  return rooms.some((room) => Array.isArray(room && room.unitUids) && room.unitUids.some(
    (value) => String(toBigInt(value || 0)) === key
  ));
}

function pickWeighted(ctx, rows) {
  const total = rows.reduce((sum, row) => sum + row.ratio, 0);
  if (total <= 0) return null;
  let roll;
  if (ctx && typeof ctx.randomInt === "function") {
    roll = Math.max(0, Math.min(total - 1, Math.trunc(Number(ctx.randomInt(total)) || 0)));
  } else {
    roll = cryptoRandomInt(total);
  }
  for (const row of rows) {
    if (roll < row.ratio) return row;
    roll -= row.ratio;
  }
  return rows[rows.length - 1] || null;
}

function loadTables() {
  if (cachedTables) return cachedTables;
  const indexes = readGameplayTableRecords("ab_script", "LUA_EVENT_COLLECTION_INDEX_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-collection",
  }).map((source) => ({
    eventId: Number(source.EventID || 0),
    openTag: String(source.OpenTag || ""),
    intervalTag: String(source.DateStrID || ""),
    collectionMergeId: Number(source.CollectionMergeID || 0),
    collectionGroupId: Number(source.EventCollectionGroupID || 0),
  })).filter((row) => row.eventId > 0 && row.openTag && row.intervalTag && row.collectionMergeId > 0 && row.collectionGroupId > 0);

  const details = readGameplayTableRecords("ab_script", "LUA_EVENT_COLLECTION_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-collection",
  }).map((source) => ({
    collectionGroupId: Number(source.EventCollectionGroupID || 0),
    collectionMergeId: Number(source.CollectionMergeID || 0),
    gradeGroupId: Number(source.CollectionGradeGroupID || 0),
    goodsType: String(source.CollectionGoodsType || ""),
    goodsId: Number(source.CollectionGoodsID || 0),
    ratio: Number(source.CollectionGoodsRatio || 0),
  })).filter((row) => row.collectionGroupId > 0 && row.collectionMergeId > 0 && row.gradeGroupId > 0 &&
    row.goodsType === "NUST_TRAINER" && row.goodsId > 0 && row.ratio > 0 && isTrainer(row.goodsId));

  const recipes = readGameplayTableRecords("ab_script", "LUA_EVENT_COLLECTION_MERGE_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-collection",
  }).map((source) => ({
    collectionMergeId: Number(source.CollectionMergeID || 0),
    recipeGroupId: Number(source.MergeRecipeGroupID || 0),
    inputGrade: String(source.MergeInputGrade || ""),
    inputGradeGroupId: Number(source.MergeInputGradeGroupID || 0),
    inputValue: Number(source.MergeInputValue || 0),
    outputGradeGroupId: Number(source.MergeOutputGradeGroupID || 0),
    outputValue: Number(source.MergeOutputValue || 0),
  })).filter((row) => row.collectionMergeId > 0 && row.recipeGroupId > 0 && row.inputGrade &&
    row.inputGradeGroupId > 0 && row.inputValue > 0 && row.outputGradeGroupId > 0 && row.outputValue > 0);

  const detailsByGradeGroup = new Map();
  for (const detail of details) {
    if (!detailsByGradeGroup.has(detail.gradeGroupId)) detailsByGradeGroup.set(detail.gradeGroupId, []);
    detailsByGradeGroup.get(detail.gradeGroupId).push(detail);
  }
  for (const rows of detailsByGradeGroup.values()) rows.sort((left, right) => left.goodsId - right.goodsId);
  for (const index of indexes) {
    index.goodsIds = details.filter((detail) =>
      detail.collectionGroupId === index.collectionGroupId && detail.collectionMergeId === index.collectionMergeId
    ).map((detail) => detail.goodsId).sort((left, right) => left - right);
  }

  cachedTables = {
    indexes: indexes.sort((left, right) => left.eventId - right.eventId),
    indexByMergeId: new Map(indexes.map((row) => [row.collectionMergeId, row])),
    recipes,
    recipeByKey: new Map(recipes.map((row) => [recipeKey(row.collectionMergeId, row.recipeGroupId), row])),
    details,
    detailByGoodsId: new Map(details.map((row) => [row.goodsId, row])),
    detailsByGradeGroup,
  };
  return cachedTables;
}

function isTrainer(unitId) {
  const templet = getUnitTemplet(unitId);
  return Boolean(templet && String(templet.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER");
}

function recipeKey(mergeId, groupId) {
  return `${Number(mergeId) || 0}:${Number(groupId) || 0}`;
}

function normalizeTag(value) {
  return String(value || "").trim().toUpperCase();
}

function nonNegativeBigInt(value) {
  try {
    const result = BigInt(value || 0);
    return result > 0n ? result : 0n;
  } catch (_) {
    return 0n;
  }
}

function decrypt(ctx, payload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function sendResponse(ctx, socket, packet, packetId, payload, label) {
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

function emptyResult(collectionMergeId = 0) {
  return {
    changed: false,
    errorCode: ERRORS.MERGE_INVALID_INPUT_VALUE,
    collectionMergeId: Number(collectionMergeId) || 0,
    consumeTrophyUids: [],
    rewardData: null,
    index: null,
  };
}

module.exports = {
  MAX_CONSUME_TROPHIES,
  PACKETS,
  ERRORS,
  createEventCollectionHandlers,
  decodeMergeRequest,
  mergeTrophies,
  buildMergeAckPayload,
  buildEventCollectionInfoData,
  buildCollectionNotificationPayload,
  sendCollectionNotification,
  buildEventPointPayload,
  sendEventPointNotification,
  getCollectedGoods,
  getActiveCollectionIndex,
  loadTables,
};
