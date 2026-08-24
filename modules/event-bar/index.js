"use strict";

const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  buildItemMiscData,
  buildRewardData,
  readSignedVarInt,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType } = require("../reward");
const { getMiscItem, spendMiscItem, toBigInt } = require("../inventory");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DAILY_RESET_HOUR_UTC = 4;
const MAX_CREATE_COUNT = 999;

const PACKETS = Object.freeze({
  DAILY_INFO_NOT: 3041,
  CREATE_COCKTAIL_REQ: 3042,
  CREATE_COCKTAIL_ACK: 3043,
  GET_REWARD_REQ: 3044,
  GET_REWARD_ACK: 3045,
});

const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_RESOURCE: 109,
  INVALID_ITEM_COUNT: 20362,
  EVENT_END: 21027,
  EVENT_TEMPLET_NOT_EXIST: 21028,
  EVENT_NO_DAILY_COCKTAIL: 21029,
  EVENT_DAILY_REWARD_END: 21030,
});

let cachedTables = null;

function createEventBarHandlers() {
  return [
    [PACKETS.CREATE_COCKTAIL_REQ, "EVENT_BAR_CREATE_COCKTAIL_REQ", handleCreateCocktail],
    [PACKETS.GET_REWARD_REQ, "EVENT_BAR_GET_REWARD_REQ", handleGetReward],
  ].map(([packetId, name, handle]) => ({ packetId, name, handle }));
}

function handleCreateCocktail(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeCreateRequest(ctx, packet.payload);
  const result = createCocktail(ctx, user, request);
  sendResponse(ctx, socket, packet, PACKETS.CREATE_COCKTAIL_ACK, buildCreateAck(result), "event-bar-create");
  finishMutation(ctx, user, result, "event-bar-create");
  return true;
}

function handleGetReward(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeSingleIntRequest(ctx, packet.payload, "cocktailItemId");
  const result = getDailyReward(ctx, user, request);
  sendResponse(ctx, socket, packet, PACKETS.GET_REWARD_ACK, buildRewardAck(result), "event-bar-reward");
  if (result.changed && socket && socket.session) socket.session.eventBarDailyInfoKey = notificationKey(result.state);
  finishMutation(ctx, user, result, "event-bar-reward");
  return true;
}

function createCocktail(ctx, user, request) {
  const base = emptyResult();
  if (!request || !request.valid || request.count < 1 || request.count > MAX_CREATE_COUNT) {
    return { ...base, errorCode: ERRORS.INVALID_ITEM_COUNT };
  }
  const row = loadTables().rowsByRewardItemId.get(request.cocktailItemId);
  if (!row) return { ...base, errorCode: ERRORS.EVENT_TEMPLET_NOT_EXIST };
  if (!activeEventIds(ctx).includes(row.eventId)) return { ...base, errorCode: ERRORS.EVENT_END };

  const costs = mergeCosts([
    { itemId: row.materialItemId1, count: row.materialItemValue1 * request.count },
    { itemId: row.materialItemId2, count: row.materialItemValue2 * request.count },
  ]);
  if (!hasCosts(user, costs)) return { ...base, errorCode: ERRORS.INSUFFICIENT_RESOURCE };

  const costItems = costs.map((cost) => spendMiscItem(user, cost.itemId, cost.count)).filter(Boolean);
  const rewardData = grantRewardByType(
    ctx,
    user,
    "RT_MISC",
    row.rewardItemId,
    request.count,
    request.count,
    0,
    { expandPackages: false }
  );
  return { ...base, changed: true, errorCode: ERRORS.OK, costItems, rewardData, resourceSpends: costs };
}

function getDailyReward(ctx, user, request) {
  const base = emptyResult();
  const row = request && request.valid ? loadTables().rowsByRewardItemId.get(request.cocktailItemId) : null;
  if (!row) return { ...base, errorCode: ERRORS.EVENT_TEMPLET_NOT_EXIST };
  if (!activeEventIds(ctx).includes(row.eventId)) return { ...base, errorCode: ERRORS.EVENT_END };

  const state = readDailyState(ctx, user, row.eventId);
  const result = { ...base, state, remainDeliveryLimitValue: state.remainDeliveryLimitValue };
  if (state.dailyCocktailItemId <= 0 || request.cocktailItemId !== state.dailyCocktailItemId) {
    return { ...result, errorCode: ERRORS.EVENT_NO_DAILY_COCKTAIL };
  }
  if (state.remainDeliveryLimitValue <= 0) return { ...result, errorCode: ERRORS.EVENT_DAILY_REWARD_END };
  if (miscTotal(getMiscItem(user, row.rewardItemId)) < BigInt(row.deliveryValue)) {
    return { ...result, errorCode: ERRORS.INSUFFICIENT_RESOURCE };
  }

  const costItem = spendMiscItem(user, row.rewardItemId, row.deliveryValue);
  const rewardData = grantRewardByType(
    ctx,
    user,
    "RT_MISC",
    row.deliveryRewardItemId,
    row.deliveryRewardValue,
    row.deliveryRewardValue,
    0,
    { expandPackages: false }
  );
  state.remainDeliveryLimitValue -= 1;
  commitDailyState(user, state);
  return {
    ...result,
    changed: true,
    errorCode: ERRORS.OK,
    state,
    remainDeliveryLimitValue: state.remainDeliveryLimitValue,
    costItems: costItem ? [costItem] : [],
    rewardData,
    resourceSpends: [{ itemId: row.rewardItemId, count: row.deliveryValue }],
  };
}

function buildDailyInfoPayload(state) {
  return Buffer.concat([
    writeSignedVarInt(Number(state && state.dailyCocktailItemId) || 0),
    writeSignedVarInt(Math.max(0, Number(state && state.remainDeliveryLimitValue) || 0)),
  ]);
}

function buildCreateAck(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    result.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
    writeNullableObjectList((result.errorCode === ERRORS.OK ? result.costItems : []).map(buildItemMiscData)),
  ]);
}

function buildRewardAck(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    result.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData(result.rewardData)) : writeNullObject(),
    writeNullableObjectList((result.errorCode === ERRORS.OK ? result.costItems : []).map(buildItemMiscData)),
    writeSignedVarInt(Math.max(0, Number(result.remainDeliveryLimitValue) || 0)),
  ]);
}

function sendEventBarDailyInfoNotification(ctx, socket, label = "event-bar-daily-info") {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  if (typeof ctx.isTutorialCapturedBootstrapActive === "function" && ctx.isTutorialCapturedBootstrapActive(socket)) return false;
  const user = socket && socket.session && socket.session.user;
  if (!user) return false;
  const eventId = selectDailyEventId(ctx);
  if (!eventId) return false;

  const state = readDailyState(ctx, user, eventId);
  const key = notificationKey(state);
  if (socket.session.eventBarDailyInfoKey === key) return false;
  const previous = storedDailyState(user, eventId);
  commitDailyState(user, state);
  ctx.sendServerGamePacket(socket, PACKETS.DAILY_INFO_NOT, buildDailyInfoPayload(state), label);
  socket.session.eventBarDailyInfoKey = key;
  if (!sameDailyState(previous, state) && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") {
    ctx.saveUserDb({ affectsJoinLobby: false });
  }
  return true;
}

function readDailyState(ctx, user, eventId) {
  const rows = loadTables().rowsByEventId.get(Number(eventId)) || [];
  if (!rows.length) return { eventId: Number(eventId) || 0, dailyResetKey: "", dailyCocktailItemId: 0, remainDeliveryLimitValue: 0 };
  const dailyResetKey = getDailyResetKey(getNowDate(ctx));
  const stored = storedDailyState(user, eventId);
  const validStoredItem = rows.some((row) => row.rewardItemId === Number(stored && stored.dailyCocktailItemId));
  if (stored && stored.dailyResetKey === dailyResetKey && validStoredItem) {
    return {
      eventId: Number(eventId),
      dailyResetKey,
      dailyCocktailItemId: Number(stored.dailyCocktailItemId),
      remainDeliveryLimitValue: clampInt(stored.remainDeliveryLimitValue, 0, deliveryLimitFor(rows, stored.dailyCocktailItemId)),
    };
  }
  const dailyCocktailItemId = chooseDailyCocktail(user, Number(eventId), dailyResetKey, rows);
  return {
    eventId: Number(eventId),
    dailyResetKey,
    dailyCocktailItemId,
    remainDeliveryLimitValue: deliveryLimitFor(rows, dailyCocktailItemId),
  };
}

function commitDailyState(user, state) {
  if (!user || !state || state.eventId <= 0) return;
  user.eventBar = user.eventBar && typeof user.eventBar === "object" && !Array.isArray(user.eventBar) ? user.eventBar : {};
  user.eventBar[String(state.eventId)] = {
    eventId: Number(state.eventId),
    dailyResetKey: String(state.dailyResetKey || ""),
    dailyCocktailItemId: Number(state.dailyCocktailItemId) || 0,
    remainDeliveryLimitValue: Math.max(0, Number(state.remainDeliveryLimitValue) || 0),
  };
}

function storedDailyState(user, eventId) {
  const store = user && user.eventBar && typeof user.eventBar === "object" ? user.eventBar : null;
  const value = store && store[String(eventId)];
  return value && typeof value === "object" ? value : null;
}

function chooseDailyCocktail(user, eventId, dailyResetKey, rows) {
  let hash = 2166136261;
  for (const byte of Buffer.from(`${String(user && user.userUid || "0")}:${eventId}:${dailyResetKey}`)) {
    hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  }
  return rows[hash % rows.length].rewardItemId;
}

function activeEventIds(ctx) {
  const tables = loadTables();
  const manager = ctx && ctx.eventManager;
  if (!manager || typeof manager.getActiveEventState !== "function") return tables.activeCapableIds.slice();
  try {
    const state = manager.getActiveEventState();
    const ids = new Set();
    for (const entry of Array.isArray(state && state.entries) ? state.entries : []) {
      const raw = entry && entry.raw;
      const eventId = Number(raw && (raw.m_EventID || raw.EventID || raw.eventId) || 0);
      if (tables.rowsByEventId.has(eventId)) ids.add(eventId);
    }
    return Array.from(ids).sort((left, right) => left - right);
  } catch (_) {
    return [];
  }
}

function selectDailyEventId(ctx) {
  const ids = activeEventIds(ctx);
  if (!ids.length) return 0;
  const tables = loadTables();
  return ids.slice().sort((left, right) => {
    const visibleDifference = Number(Boolean(tables.eventTabs.get(right) && tables.eventTabs.get(right).visible)) -
      Number(Boolean(tables.eventTabs.get(left) && tables.eventTabs.get(left).visible));
    return visibleDifference || left - right;
  })[0];
}

function decodeCreateRequest(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  const cocktailItemId = safeReadInt(buffer, 0);
  const count = safeReadInt(buffer, cocktailItemId.offset);
  return {
    cocktailItemId: cocktailItemId.value,
    count: count.value,
    valid: cocktailItemId.valid && count.valid && count.offset === buffer.length,
  };
}

function decodeSingleIntRequest(ctx, payload, key) {
  const buffer = decrypt(ctx, payload);
  const value = safeReadInt(buffer, 0);
  return { [key]: value.value, valid: value.valid && value.offset === buffer.length };
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
  if (typeof ctx.trackMissionEvent === "function") {
    for (const spend of result.resourceSpends || []) {
      ctx.trackMissionEvent(user, "USE_RESOURCE", spend.count, {
        itemId: spend.itemId,
        resourceId: spend.itemId,
        value: spend.itemId,
      });
    }
  }
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
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

function emptyResult() {
  return {
    changed: false,
    errorCode: ERRORS.EVENT_TEMPLET_NOT_EXIST,
    rewardData: null,
    costItems: [],
    remainDeliveryLimitValue: 0,
    resourceSpends: [],
    state: null,
  };
}

function mergeCosts(costs) {
  const totals = new Map();
  for (const cost of costs) {
    if (!cost || cost.itemId <= 0 || cost.count <= 0) continue;
    totals.set(cost.itemId, (totals.get(cost.itemId) || 0) + cost.count);
  }
  return Array.from(totals, ([itemId, count]) => ({ itemId, count })).sort((left, right) => left.itemId - right.itemId);
}

function hasCosts(user, costs) {
  return costs.every((cost) => miscTotal(getMiscItem(user, cost.itemId)) >= BigInt(cost.count));
}

function miscTotal(item) {
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function deliveryLimitFor(rows, itemId) {
  const row = rows.find((entry) => entry.rewardItemId === Number(itemId));
  return row ? row.deliveryLimitValue : 0;
}

function getNowDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const date = ctx.getServerNowDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function getDailyResetKey(date) {
  return new Date(date.getTime() - DAILY_RESET_HOUR_UTC * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function notificationKey(state) {
  return state ? `${state.eventId}:${state.dailyResetKey}:${state.dailyCocktailItemId}:${state.remainDeliveryLimitValue}` : "";
}

function sameDailyState(left, right) {
  return Boolean(left && right && Number(left.eventId) === Number(right.eventId) &&
    String(left.dailyResetKey || "") === String(right.dailyResetKey || "") &&
    Number(left.dailyCocktailItemId) === Number(right.dailyCocktailItemId) &&
    Number(left.remainDeliveryLimitValue) === Number(right.remainDeliveryLimitValue));
}

function clampInt(value, min, max) {
  const number = Math.trunc(Number(value) || 0);
  return Math.max(min, Math.min(max, number));
}

function loadTables() {
  if (cachedTables) return cachedTables;
  const rowsByRewardItemId = new Map();
  const rowsByEventId = new Map();
  for (const source of readGameplayTableRecords("ab_script", "LUA_EVENT_BAR_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-bar",
  })) {
    const row = {
      eventId: Number(source.m_EventID || 0),
      openTag: String(source.m_OpenTag || ""),
      materialItemId1: Number(source.MaterialID_1 || 0),
      materialItemValue1: Number(source.MaterialValue_1 || 0),
      materialItemId2: Number(source.MaterialID_2 || 0),
      materialItemValue2: Number(source.MaterialValue_2 || 0),
      technique: String(source.ManufacturingTechnique || ""),
      rewardItemId: Number(source.RewardItemID || 0),
      deliveryLimit: String(source.DeliveryLimit || ""),
      deliveryLimitValue: Number(source.DeliveryLimitValue || 0),
      deliveryValue: Number(source.DeliveryValue || 0),
      deliveryRewardItemId: Number(source.DeliveryRewardItemID || 0),
      deliveryRewardValue: Number(source.DeliveryRewardValue || 0),
    };
    row.valid = row.eventId > 0 && row.openTag && row.materialItemId1 > 0 && row.materialItemValue1 > 0 &&
      row.materialItemId2 > 0 && row.materialItemValue2 > 0 && ["stir", "shake"].includes(row.technique) &&
      row.rewardItemId > 0 && row.deliveryLimit === "Day" && row.deliveryLimitValue > 0 &&
      row.deliveryValue > 0 && row.deliveryRewardItemId > 0 && row.deliveryRewardValue > 0;
    if (!row.valid || rowsByRewardItemId.has(row.rewardItemId)) continue;
    rowsByRewardItemId.set(row.rewardItemId, row);
    if (!rowsByEventId.has(row.eventId)) rowsByEventId.set(row.eventId, []);
    rowsByEventId.get(row.eventId).push(row);
  }
  for (const rows of rowsByEventId.values()) rows.sort((left, right) => left.rewardItemId - right.rewardItemId);

  const eventTabs = new Map();
  for (const source of readGameplayTableRecords("ab_script", "LUA_EVENT_TAB_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "event-bar",
  })) {
    const eventId = Number(source.m_EventID || 0);
    if (!rowsByEventId.has(eventId) || String(source.m_EventType || "") !== "BAR") continue;
    eventTabs.set(eventId, {
      eventId,
      visible: source.m_Visible === true,
      enabled: source.m_Enable === true,
      intervalTag: String(source.m_DateStrID || ""),
      openTag: String(source.m_OpenTag || ""),
    });
  }
  cachedTables = {
    rowsByRewardItemId,
    rowsByEventId,
    eventTabs,
    activeCapableIds: Array.from(rowsByEventId.keys()).filter((eventId) => {
      const tab = eventTabs.get(eventId);
      return Boolean(tab && tab.enabled && tab.intervalTag && tab.openTag);
    }).sort((left, right) => left - right),
  };
  return cachedTables;
}

module.exports = {
  DAILY_RESET_HOUR_UTC,
  MAX_CREATE_COUNT,
  PACKETS,
  ERRORS,
  createEventBarHandlers,
  buildDailyInfoPayload,
  buildCreateAck,
  buildRewardAck,
  sendEventBarDailyInfoNotification,
  readDailyState,
  getDailyResetKey,
  activeEventIds,
  loadTables,
};
