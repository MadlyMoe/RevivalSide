const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  readSignedVarInt,
  writeBool,
  writeInt64LE,
  writeIntList,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
  writeSignedVarInt,
  buildItemMiscData,
  buildRewardData,
  toBigInt,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const { getMiscItem, spendMiscItem } = require("../inventory");

const ROOT_DIR = path.resolve(__dirname, "..", "..");

const PACKETS = Object.freeze({
  EVENT_PASS_LEVEL_COMPLETE_REQ: 3008,
  EVENT_PASS_LEVEL_COMPLETE_ACK: 3009,
  EVENT_PASS_REQ: 3010,
  EVENT_PASS_ACK: 3011,
  EVENT_PASS_MISSION_REQ: 3012,
  EVENT_PASS_MISSION_ACK: 3013,
  EVENT_PASS_NOT: 3014,
  EVENT_PASS_FINAL_MISSION_COMPLETE_REQ: 3015,
  EVENT_PASS_FINAL_MISSION_COMPLETE_ACK: 3016,
  EVENT_PASS_DAILY_MISSION_RETRY_REQ: 3017,
  EVENT_PASS_DAILY_MISSION_RETRY_ACK: 3018,
  EVENT_PASS_PURCHASE_CORE_PASS_REQ: 3019,
  EVENT_PASS_PURCHASE_CORE_PASS_ACK: 3020,
  EVENT_PASS_PURCHASE_CORE_PASS_PLUS_REQ: 3021,
  EVENT_PASS_PURCHASE_CORE_PASS_PLUS_ACK: 3022,
  EVENT_PASS_DOT_NOT: 3023,
  EVENT_PASS_LEVEL_UP_REQ: 3024,
  EVENT_PASS_LEVEL_UP_ACK: 3025,
  REMAIN_PASS_REWARD_REQ: 1668,
  REMAIN_PASS_REWARD_ACK: 1669,
});

const ERROR_OK = 0;
const ERRORS = Object.freeze({
  NOT_ENABLED: 20716,
  NO_REWARD: 20679,
  INSUFFICIENT_MISSIONS: 20682,
  FINAL_DAILY_COMPLETE: 20683,
  FINAL_WEEKLY_COMPLETE: 20684,
  RETRY_DISABLED: 20687,
  INVALID_MISSION: 20690,
  ALREADY_PURCHASED: 20693,
  INVALID_OPERATION: 20694,
  ADD_EXP: 20696,
  MAX_RETRY: 20709,
  INSUFFICIENT_RESOURCE: 109,
  INVALID_REQUEST: 20191,
});
const REMAIN_REWARD_CONTENT = Object.freeze({ EventPass: 0, PrestigeMission: 1 });
const MISSION_TYPES = Object.freeze({
  Daily: 0,
  Weekly: 1,
});
const MISSION_TYPE_NAMES = Object.freeze(["Daily", "Weekly"]);
const GENERIC_EVENT_PASS_EXP_ID = 504;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DAY_MS = 24 * 60 * 60 * 1000;
let cachedTables = null;

function createEventPassHandlers() {
  const handlers = [
    [PACKETS.EVENT_PASS_REQ, "EVENT_PASS_REQ", handleEventPassReq],
    [PACKETS.EVENT_PASS_LEVEL_COMPLETE_REQ, "EVENT_PASS_LEVEL_COMPLETE_REQ", handleLevelCompleteReq],
    [PACKETS.EVENT_PASS_MISSION_REQ, "EVENT_PASS_MISSION_REQ", handleMissionReq],
    [PACKETS.EVENT_PASS_FINAL_MISSION_COMPLETE_REQ, "EVENT_PASS_FINAL_MISSION_COMPLETE_REQ", handleFinalMissionCompleteReq],
    [PACKETS.EVENT_PASS_DAILY_MISSION_RETRY_REQ, "EVENT_PASS_DAILY_MISSION_RETRY_REQ", handleDailyMissionRetryReq],
    [PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_REQ, "EVENT_PASS_PURCHASE_CORE_PASS_REQ", handlePurchaseCorePassReq],
    [PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_PLUS_REQ, "EVENT_PASS_PURCHASE_CORE_PASS_PLUS_REQ", handlePurchaseCorePassPlusReq],
    [PACKETS.EVENT_PASS_LEVEL_UP_REQ, "EVENT_PASS_LEVEL_UP_REQ", handleLevelUpReq],
    [PACKETS.REMAIN_PASS_REWARD_REQ, "REMAIN_PASS_REWARD_REQ", handleRemainingPassRewardReq],
  ];
  return handlers.map(([packetId, name, handle]) => ({
    packetId,
    name,
    handle(ctx, socket, packet) {
      return handle(ctx, socket, packet);
    },
  }));
}

function handleRemainingPassRewardReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const result = isStrictEmptyRequest(ctx, packet && packet.payload)
    ? claimRemainingPassRewards(ctx, user)
    : { errorCode: ERRORS.INVALID_REQUEST, contents: [], reward: null, changed: false };
  send(
    ctx,
    socket,
    packet,
    PACKETS.REMAIN_PASS_REWARD_ACK,
    buildRemainingPassRewardAckPayload(result),
    "remaining-pass-reward"
  );
  if (result.changed) {
    persist(ctx, { affectsJoinLobby: true });
    if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
      ctx.invalidateJoinLobbyAckPayloadCache("remaining-pass-reward");
    }
  }
  return true;
}

function handleEventPassReq(ctx, socket, packet) {
  if (shouldDeferCounterPassForTutorial(ctx, socket, { activeBootstrapOnly: true })) {
    console.log("[counter-pass:req] deferred during tutorial captured bootstrap");
    return true;
  }
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const payload = buildEventPassAckPayload(ctx, user, pass);
  if (pass) {
    const state = ensureCounterPassState(user, pass);
    console.log(
      `[counter-pass:req] eventPassId=${pass.eventPassId} level=${getCurrentPassLevel(pass, state)} exp=${state.totalExp}`
    );
  } else {
    console.log("[counter-pass:req] no active counter pass; sending empty ACK");
  }
  send(ctx, socket, packet, PACKETS.EVENT_PASS_ACK, payload, "counter-pass");
  if (pass) sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
  if (pass) persist(ctx);
  return true;
}

function handleLevelCompleteReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const result = completePassLevels(ctx, user, pass);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_LEVEL_COMPLETE_ACK, result.payload, "counter-pass-level-complete");
  if (result.changed) {
    sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
    persist(ctx);
  }
  return true;
}

function handleMissionReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const missionType = decodeMissionType(ctx, packet.payload);
  const payload = pass
    ? buildMissionAckPayload(ctx, user, pass, missionType)
    : buildMissionErrorPayload(ERRORS.NOT_ENABLED, missionType);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_MISSION_ACK, payload, "counter-pass-mission");
  if (pass) persist(ctx);
  return true;
}

function handleFinalMissionCompleteReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const missionType = decodeMissionType(ctx, packet.payload);
  const result = completeFinalMission(ctx, user, pass, missionType);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_FINAL_MISSION_COMPLETE_ACK, result.payload, "counter-pass-final-mission");
  if (result.changed) {
    sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
    persist(ctx);
  }
  return true;
}

function handleDailyMissionRetryReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const missionId = decodeSingleInt(ctx, packet.payload);
  const result = retryDailyMission(ctx, user, pass, missionId);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_DAILY_MISSION_RETRY_ACK, result.payload, "counter-pass-daily-retry");
  if (result.changed) persist(ctx);
  return true;
}

function handlePurchaseCorePassReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const result = purchaseCorePass(user, pass, false);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_ACK, result.payload, "counter-pass-core-pass");
  if (result.changed) {
    sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
    persist(ctx);
  }
  return true;
}

function handlePurchaseCorePassPlusReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const result = purchaseCorePass(user, pass, true);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_PURCHASE_CORE_PASS_PLUS_ACK, result.payload, "counter-pass-core-plus");
  if (result.changed) {
    sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
    persist(ctx);
  }
  return true;
}

function handleLevelUpReq(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const pass = resolveActiveCounterPass(ctx);
  const increaseLv = Number(decodeSingleInt(ctx, packet.payload));
  const result = purchasePassLevels(user, pass, increaseLv);
  send(ctx, socket, packet, PACKETS.EVENT_PASS_LEVEL_UP_ACK, result.payload, "counter-pass-level-up");
  if (result.changed) {
    sendCounterPassDotNotification(ctx, socket, user, pass, "counter-pass-dot");
    persist(ctx);
  }
  return true;
}

function sendCounterPassLobbyNotifications(ctx, socket, label = "counter-pass-not", options = {}) {
  if (shouldDeferCounterPassForTutorial(ctx, socket)) {
    console.log(`[counter-pass:not] deferred during tutorial label=${label}`);
    return false;
  }
  const session = socket && socket.session;
  const replay = session && session.gameReplay;
  const alreadySent = Boolean((session && session.counterPassNotSent) || (replay && replay.counterPassNotSent));
  if (alreadySent) return false;
  const pass = resolveActiveCounterPass(ctx);
  if (!pass || !ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  console.log(
    `[counter-pass:not] eventPassId=${pass.eventPassId} window=${formatDate(pass.startDate)}..${formatDate(pass.endDate)} label=${label}${alreadySent ? " resend=1" : ""}`
  );
  ctx.sendServerGamePacket(socket, PACKETS.EVENT_PASS_NOT, buildEventPassNotPayload(pass), label);
  if (session) session.counterPassNotSent = true;
  if (replay) replay.counterPassNotSent = true;
  return true;
}

function sendCounterPassDotNotification(ctx, socket, user, pass, label = "counter-pass-dot") {
  if (shouldDeferCounterPassForTutorial(ctx, socket)) {
    console.log(`[counter-pass:dot] deferred during tutorial label=${label}`);
    return false;
  }
  if (!pass || !ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  const state = ensureCounterPassState(user, pass);
  syncGenericMissionExp(user, state);
  ctx.sendServerGamePacket(socket, PACKETS.EVENT_PASS_DOT_NOT, buildDotPayload(user, pass, state), label);
  return true;
}

function buildEventPassAckPayload(ctx, user, pass) {
  if (!pass) {
    return Buffer.concat([
      writeSignedVarInt(ERROR_OK),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeBool(false),
    ]);
  }
  const state = ensureCounterPassState(user, pass);
  syncGenericMissionExp(user, state);
  return Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeSignedVarInt(state.totalExp),
    writeSignedVarInt(state.rewardNormalLevel),
    writeSignedVarInt(state.rewardCoreLevel),
    writeBool(Boolean(state.isCorePassPurchased)),
  ]);
}

function completePassLevels(ctx, user, pass) {
  const reward = createEmptyReward();
  let normalLevel = 0;
  let coreLevel = 0;
  if (!pass) return levelCompleteResult(ERRORS.NOT_ENABLED, normalLevel, coreLevel, reward, false);
  const state = ensureCounterPassState(user, pass);
  syncGenericMissionExp(user, state);
  const currentLevel = getCurrentPassLevel(pass, state);
  const normalRows = getRewardRows(pass, state.rewardNormalLevel + 1, currentLevel);
  const coreRows = state.isCorePassPurchased ? getRewardRows(pass, state.rewardCoreLevel + 1, currentLevel) : [];
  if (!normalRows.length && !coreRows.length) {
    return levelCompleteResult(ERRORS.NO_REWARD, state.rewardNormalLevel, state.rewardCoreLevel, reward, false);
  }
  for (const row of normalRows) grantCounterPassRewardRow(ctx, user, row, "Normal", reward);
  for (const row of coreRows) grantCounterPassRewardRow(ctx, user, row, "Core", reward);
  if (normalRows.length) state.rewardNormalLevel = currentLevel;
  if (coreRows.length) state.rewardCoreLevel = currentLevel;
  normalLevel = state.rewardNormalLevel;
  coreLevel = state.rewardCoreLevel;
  return levelCompleteResult(ERROR_OK, normalLevel, coreLevel, reward, true);
}

function levelCompleteResult(errorCode, normalLevel, coreLevel, reward, changed) {
  return { changed, payload: Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(normalLevel),
    writeSignedVarInt(coreLevel),
    writeNullableObject(buildRewardData(reward)),
  ]) };
}

function buildMissionAckPayload(ctx, user, pass, missionType) {
  const type = normalizeMissionType(missionType);
  let state = null;
  let missionInfos = [];
  if (pass) {
    state = ensureCounterPassState(user, pass);
    missionInfos = ensureMissionInfos(ctx, user, pass, state, type);
  }
  return Buffer.concat([
    writeSignedVarInt(ERROR_OK),
    writeBool(Boolean(state && state.finalMissionCompleted[missionTypeName(type)])),
    writeSignedVarInt(type),
    writeNullableObjectList(missionInfos.map(buildEventPassMissionInfoData)),
    writeInt64LE(dateTimeBinaryForDate(nextMissionResetDate(currentServerDate(ctx), type))),
  ]);
}

function buildMissionErrorPayload(errorCode, missionType) {
  const type = normalizeMissionType(missionType);
  return Buffer.concat([
    writeSignedVarInt(errorCode), writeBool(false), writeSignedVarInt(type), writeNullableObjectList([]),
    writeInt64LE(dateTimeBinaryForDate(nextMissionResetDate(new Date(), type))),
  ]);
}

function completeFinalMission(ctx, user, pass, missionType) {
  const type = normalizeMissionType(missionType);
  if (!pass) return finalMissionResult(ERRORS.NOT_ENABLED, 0, type, false);
  const state = ensureCounterPassState(user, pass);
  const typeName = missionTypeName(type);
  if (state.finalMissionCompleted[typeName]) {
    return finalMissionResult(type === MISSION_TYPES.Weekly ? ERRORS.FINAL_WEEKLY_COMPLETE : ERRORS.FINAL_DAILY_COMPLETE, state.totalExp, type, false);
  }
  const missions = ensureMissionInfos(ctx, user, pass, state, type);
  const required = type === MISSION_TYPES.Weekly ? pass.weeklyMissionClearCount : pass.dailyMissionClearCount;
  const completed = missions.filter((mission) => isMissionCompleted(user, mission.missionId)).length;
  if (completed < required) return finalMissionResult(ERRORS.INSUFFICIENT_MISSIONS, state.totalExp, type, false);
  const rewardExp = type === MISSION_TYPES.Weekly ? pass.weeklyMissionClearRewardExp : pass.dailyMissionClearRewardExp;
  addCounterPassExp(pass, state, Number(rewardExp || 0) || 0);
  state.finalMissionCompleted[typeName] = true;
  return finalMissionResult(ERROR_OK, state.totalExp, type, true);
}

function finalMissionResult(errorCode, totalExp, type, changed) {
  return { changed, payload: Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarInt(totalExp), writeSignedVarInt(type)]) };
}

function retryDailyMission(ctx, user, pass, missionId) {
  const empty = { missionId: Number(missionId || 0) || 0, slotIndex: 0, retryCount: 0 };
  if (!pass) return retryMissionResult(ERRORS.NOT_ENABLED, empty, [], false);
  const state = ensureCounterPassState(user, pass);
  const missions = ensureMissionInfos(ctx, user, pass, state, MISSION_TYPES.Daily);
  const existing = missions.find((entry) => Number(entry.missionId) === Number(missionId));
  if (!existing) return retryMissionResult(ERRORS.INVALID_MISSION, empty, [], false);
  if (existing.retryCount >= 8) return retryMissionResult(ERRORS.MAX_RETRY, existing, [], false);
  const replacement = findReplacementMissionId(ctx, pass, MISSION_TYPES.Daily, existing.slotIndex, missions.map((entry) => entry.missionId));
  if (!replacement) return retryMissionResult(ERRORS.RETRY_DISABLED, existing, [], false);
  let costItem = null;
  if (existing.retryCount >= 3) {
    costItem = spendIfAffordable(user, 1, 20000);
    if (!costItem) return retryMissionResult(ERRORS.INSUFFICIENT_RESOURCE, existing, [], false);
  }
  if (user.completedMissions && typeof user.completedMissions === "object") delete user.completedMissions[String(existing.missionId)];
  existing.retryCount += 1;
  existing.missionId = replacement;
  return retryMissionResult(ERROR_OK, existing, costItem ? [costItem] : [], true);
}

function retryMissionResult(errorCode, missionInfo, costItems, changed) {
  return { changed, payload: Buffer.concat([
    writeSignedVarInt(errorCode),
    writeNullableObject(buildEventPassMissionInfoData(missionInfo)),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
  ]) };
}

function purchaseCorePass(user, pass, plus) {
  if (!pass) return purchaseResult(plus, ERRORS.NOT_ENABLED, 0, [], false);
  const state = ensureCounterPassState(user, pass);
  if (!plus && state.isCorePassPurchased) return purchaseResult(false, ERRORS.ALREADY_PURCHASED, state.totalExp, [], false);
  if (plus && state.corePassPlusPurchased) return purchaseResult(true, ERRORS.ALREADY_PURCHASED, state.totalExp, [], false);
  const itemId = plus ? pass.corePassPlusPriceId : pass.corePassPriceId;
  let count = plus ? pass.corePassPlusPriceCount : pass.corePassPriceCount;
  if (plus && state.isCorePassPurchased) count = Math.max(0, count - pass.corePassPlusDiscountCount);
  const costItem = spendIfAffordable(user, itemId, count);
  if (!costItem) return purchaseResult(plus, ERRORS.INSUFFICIENT_RESOURCE, state.totalExp, [], false);
  state.isCorePassPurchased = true;
  if (plus) {
    state.corePassPlusPurchased = true;
    addCounterPassExp(pass, state, pass.corePassPlusExp);
  }
  return purchaseResult(plus, ERROR_OK, state.totalExp, [costItem], true);
}

function purchaseResult(plus, errorCode, totalExp, costItems, changed) {
  const parts = [writeSignedVarInt(errorCode)];
  if (plus) parts.push(writeSignedVarInt(totalExp));
  parts.push(writeNullableObjectList(costItems.map(buildItemMiscData)));
  return { changed, payload: Buffer.concat(parts) };
}

function purchasePassLevels(user, pass, increaseLv) {
  if (!pass) return passLevelResult(ERRORS.NOT_ENABLED, 0, [], false);
  const state = ensureCounterPassState(user, pass);
  const currentLevel = getCurrentPassLevel(pass, state);
  if (!Number.isInteger(increaseLv) || increaseLv <= 0 || currentLevel + increaseLv > pass.passMaxLevel) {
    return passLevelResult(ERRORS.ADD_EXP, state.totalExp, [], false);
  }
  const costItem = spendIfAffordable(user, pass.passLevelUpMiscId, increaseLv * pass.passLevelUpMiscCount);
  if (!costItem) return passLevelResult(ERRORS.INSUFFICIENT_RESOURCE, state.totalExp, [], false);
  addCounterPassExp(pass, state, increaseLv * pass.passLevelUpExp);
  return passLevelResult(ERROR_OK, state.totalExp, [costItem], true);
}

function passLevelResult(errorCode, totalExp, costItems, changed) {
  return { changed, payload: Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarInt(totalExp), writeNullableObjectList(costItems.map(buildItemMiscData)),
  ]) };
}

function spendIfAffordable(user, itemId, count) {
  const id = Number(itemId || 0);
  const amount = Math.max(0, Math.trunc(Number(count || 0)));
  if (id <= 0 || amount <= 0) return null;
  const item = getMiscItem(user, id);
  if (toBigInt(item && item.countFree) + toBigInt(item && item.countPaid) < BigInt(amount)) return null;
  return spendMiscItem(user, id, amount);
}

function isMissionCompleted(user, missionId) {
  const entry = user && user.completedMissions && user.completedMissions[String(missionId)];
  return Boolean(entry && (entry.completed === true || entry.rewardClaimed === true || Number(entry.completedCount || 0) > 0));
}

function buildEventPassNotPayload(pass) {
  return writeSignedVarInt(Number(pass && pass.eventPassId) || 0);
}

function buildDotPayload(user, pass, state) {
  const currentLevel = getCurrentPassLevel(pass, state);
  const passLevelDot =
    currentLevel > Number(state.rewardNormalLevel || 0) ||
    (state.isCorePassPurchased && currentLevel > Number(state.rewardCoreLevel || 0));
  return Buffer.concat([
    writeBool(passLevelDot),
    writeBool(!state.finalMissionCompleted.Daily),
    writeBool(!state.finalMissionCompleted.Weekly),
  ]);
}

function resolveActiveCounterPass(ctx = {}) {
  const activeState =
    ctx.eventManager && typeof ctx.eventManager.getActiveEventState === "function"
      ? ctx.eventManager.getActiveEventState()
      : null;
  const summary = activeState && Array.isArray(activeState.counterPasses) ? activeState.counterPasses[0] : null;
  if (!summary || !summary.eventPassId) return null;
  const row = getTableSet().passRows.find((entry) => Number(entry.EventPassID) === Number(summary.eventPassId));
  if (!row) return null;
  return normalizePass(row, summary);
}

function normalizePass(row, summary = {}) {
  const passLevelUpExp = Number(row.PassLevelUpExp || 0) || 1000;
  const passMaxLevel = Number(row.PassMaxLevel || 0) || 50;
  const startDate = parseDate(summary.startDate || row.EventPassStartDate);
  const endDate = parseDate(summary.endDate || row.EventPassEndDate);
  return {
    eventPassId: Number(row.EventPassID || summary.eventPassId || 0) || 0,
    raw: row,
    title: String(row.EventPassTitleStrID || ""),
    eventPassMainRewardType: String(row.EventPassMainRewardType || ""),
    eventPassMainReward: Number(row.EventPassMainReward || 0) || 0,
    passMaxLevel,
    passMaxExp: Math.max(0, (passMaxLevel - 1) * passLevelUpExp),
    passLevelUpExp,
    passLevelUpMiscId: Number(row.PassLevelUpMiscID || 0) || 0,
    passLevelUpMiscCount: Number(row.PassLevelUpMiscCount || 0) || 0,
    passRewardGroupId: Number(row.PassRewardGroupID || row.EventPassID || 0) || 0,
    dailyMissionGroupId: Number(row.DailyMissionGroupID || 0) || 0,
    dailyMissionMaxSlot: Number(row.DailyMissionMaxSlot || 0) || 10,
    dailyMissionClearCount: Number(row.DailyMissionClearCount || 0) || 0,
    dailyMissionClearRewardExp: Number(row.DailyMissionClearRewardExp || 0) || 0,
    weeklyMissionGroupId: Number(row.WeeklyMissionGroupID || 0) || 0,
    weeklyMissionMaxSlot: Number(row.WeeklyMissionMaxSlot || 0) || 10,
    weeklyMissionClearCount: Number(row.WeeklyMissionClearCount || 0) || 0,
    weeklyMissionClearRewardExp: Number(row.WeeklyMissionClearRewardExp || 0) || 0,
    corePassPriceId: Number(row.CorePassPriceID || 0) || 0,
    corePassPriceCount: Number(row.CorePassPriceCount || 0) || 0,
    corePassPlusPriceId: Number(row.CorePassPlusPriceID || 0) || 0,
    corePassPlusPriceCount: Number(row.CorePassPlusPriceCount || 0) || 0,
    corePassPlusExp: Number(row.CorePassPlusExp || 0) || 0,
    corePassPlusDiscountCount: Math.floor(
      (Number(row.CorePassPlusExp || 0) / passLevelUpExp) * (Number(row.PassLevelUpMiscCount || 0) || 0) *
      (Number(row.CorePassDiscountPercent || 0) || 0)
    ),
    dateStrId: String(row.m_DateStrID || ""),
    startDate,
    endDate,
  };
}

function ensureCounterPassState(user, pass) {
  const root = user && typeof user === "object" ? user : {};
  root.counterPass = root.counterPass && typeof root.counterPass === "object" ? root.counterPass : {};
  root.counterPass.passes = root.counterPass.passes && typeof root.counterPass.passes === "object" ? root.counterPass.passes : {};
  const key = String(Number(pass && pass.eventPassId) || 0);
  const existing = root.counterPass.passes[key] && typeof root.counterPass.passes[key] === "object" ? root.counterPass.passes[key] : {};
  const state = {
    eventPassId: Number(pass && pass.eventPassId) || Number(existing.eventPassId) || 0,
    startDate: dateIso(pass && pass.startDate) || String(existing.startDate || ""),
    endDate: dateIso(pass && pass.endDate) || String(existing.endDate || ""),
    totalExp: nonNegativeInt(existing.totalExp),
    rewardNormalLevel: nonNegativeInt(existing.rewardNormalLevel),
    rewardCoreLevel: nonNegativeInt(existing.rewardCoreLevel),
    isCorePassPurchased: Boolean(existing.isCorePassPurchased),
    corePassPlusPurchased: Boolean(existing.corePassPlusPurchased),
    genericExpSeen: existing.genericExpSeen == null ? getGenericMissionPassExp(root) : nonNegativeInt(existing.genericExpSeen),
    missions: existing.missions && typeof existing.missions === "object" ? existing.missions : {},
    missionWeeks: existing.missionWeeks && typeof existing.missionWeeks === "object" ? existing.missionWeeks : {},
    finalMissionCompleted:
      existing.finalMissionCompleted && typeof existing.finalMissionCompleted === "object"
        ? existing.finalMissionCompleted
        : {},
  };
  state.missions.Daily = Array.isArray(state.missions.Daily) ? state.missions.Daily : [];
  state.missions.Weekly = Array.isArray(state.missions.Weekly) ? state.missions.Weekly : [];
  state.finalMissionCompleted.Daily = Boolean(state.finalMissionCompleted.Daily);
  state.finalMissionCompleted.Weekly = Boolean(state.finalMissionCompleted.Weekly);
  root.counterPass.passes[key] = state;
  return state;
}

function hasRemainingPassReward(ctx, user) {
  return getRemainingPassRewardCandidates(ctx, user).length > 0;
}

function claimRemainingPassRewards(ctx, user) {
  const candidates = getRemainingPassRewardCandidates(ctx, user);
  if (!candidates.length) {
    return { errorCode: ERRORS.NO_REWARD, contents: [], reward: null, changed: false };
  }
  const reward = createEmptyReward();
  for (const candidate of candidates) {
    for (const row of candidate.normalRows) grantCounterPassRewardRow(ctx, user, row, "Normal", reward);
    for (const row of candidate.coreRows) grantCounterPassRewardRow(ctx, user, row, "Core", reward);
    if (candidate.normalRows.length) candidate.state.rewardNormalLevel = candidate.currentLevel;
    if (candidate.coreRows.length) candidate.state.rewardCoreLevel = candidate.currentLevel;
    candidate.state.remainingRewardsClaimedAt = currentServerDate(ctx).toISOString();
  }
  return {
    errorCode: ERROR_OK,
    contents: [REMAIN_REWARD_CONTENT.EventPass],
    reward,
    changed: true,
  };
}

function getRemainingPassRewardCandidates(ctx, user) {
  const passes = user && user.counterPass && user.counterPass.passes;
  if (!passes || typeof passes !== "object") return [];
  const activePass = resolveActiveCounterPass(ctx);
  const activeId = Number(activePass && activePass.eventPassId) || 0;
  const now = currentServerDate(ctx);
  const rows = getTableSet().passRows;
  const candidates = [];
  for (const [key, state] of Object.entries(passes)) {
    if (!state || typeof state !== "object") continue;
    const eventPassId = Number(state.eventPassId || key) || 0;
    if (!eventPassId || eventPassId === activeId) continue;
    const row = rows.find((entry) => Number(entry.EventPassID) === eventPassId);
    if (!row) continue;
    const pass = normalizePass(row, {
      eventPassId,
      startDate: state.startDate || row.EventPassStartDate,
      endDate: state.endDate || row.EventPassEndDate,
    });
    if (!(pass.endDate instanceof Date) || Number.isNaN(pass.endDate.getTime()) || now < pass.endDate) continue;
    const currentLevel = getCurrentPassLevel(pass, state);
    const normalRows = getRewardRows(pass, nonNegativeInt(state.rewardNormalLevel) + 1, currentLevel);
    const coreRows = state.isCorePassPurchased
      ? getRewardRows(pass, nonNegativeInt(state.rewardCoreLevel) + 1, currentLevel)
      : [];
    if (normalRows.length || coreRows.length) candidates.push({ state, pass, currentLevel, normalRows, coreRows });
  }
  return candidates.sort((left, right) => {
    const byEnd = left.pass.endDate.getTime() - right.pass.endDate.getTime();
    return byEnd || left.pass.eventPassId - right.pass.eventPassId;
  });
}

function buildRemainingPassRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeIntList(Array.isArray(result.contents) ? result.contents : []),
    result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
  ]);
}

function isStrictEmptyRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : encryptedPayload;
    return Buffer.from(payload || []).length === 0;
  } catch (_) {
    return false;
  }
}

function syncGenericMissionExp(user, state) {
  if (!user || !state) return;
  const total = getGenericMissionPassExp(user);
  const seen = nonNegativeInt(state.genericExpSeen);
  if (total > seen) {
    state.totalExp = nonNegativeInt(state.totalExp) + (total - seen);
  }
  state.genericExpSeen = Math.max(total, seen);
}

function getGenericMissionPassExp(user) {
  const eventPass = user && user.eventPass && typeof user.eventPass === "object" ? user.eventPass : {};
  const generic = eventPass[String(GENERIC_EVENT_PASS_EXP_ID)] && typeof eventPass[String(GENERIC_EVENT_PASS_EXP_ID)] === "object"
    ? eventPass[String(GENERIC_EVENT_PASS_EXP_ID)]
    : {};
  return Math.max(nonNegativeInt(user && user.eventPassExp), nonNegativeInt(generic.exp));
}

function addCounterPassExp(pass, state, amount) {
  const next = nonNegativeInt(state.totalExp) + Math.max(0, Number(amount || 0) || 0);
  state.totalExp = Math.min(next, Number(pass.passMaxExp || 0) || next);
}

function getCurrentPassLevel(pass, state) {
  const expPerLevel = Math.max(1, Number(pass && pass.passLevelUpExp) || 1000);
  return Math.max(1, Math.min(Number(pass && pass.passMaxLevel) || 50, Math.floor(nonNegativeInt(state && state.totalExp) / expPerLevel) + 1));
}

function ensureMissionInfos(ctx, user, pass, state, missionType) {
  const typeName = missionTypeName(missionType);
  const week = getWeekSinceEventStart(currentServerDate(ctx), pass.startDate);
  const current = Array.isArray(state.missions[typeName]) ? state.missions[typeName] : [];
  if (current.length && Number(state.missionWeeks[typeName] || 0) === week) return current;
  const missions = buildMissionInfos(pass, missionType, week);
  state.missions[typeName] = missions;
  state.missionWeeks[typeName] = week;
  state.finalMissionCompleted[typeName] = false;
  return missions;
}

function buildMissionInfos(pass, missionType, week) {
  const groupId = missionType === MISSION_TYPES.Weekly ? pass.weeklyMissionGroupId : pass.dailyMissionGroupId;
  const maxSlot = missionType === MISSION_TYPES.Weekly ? pass.weeklyMissionMaxSlot : pass.dailyMissionMaxSlot;
  const groupRows = getMissionGroupRows(missionType, groupId, week);
  const missions = [];
  const usedMissionIds = new Set();
  const usedSlots = new Set();
  for (const row of groupRows) {
    const missionIds = normalizeIntList(row.MissionID);
    const slots = normalizeIntList(row.MissionSlotIndex);
    for (const slotIndex of slots) {
      if (missions.length >= maxSlot || usedSlots.has(slotIndex)) continue;
      const missionId = missionIds.find((id) => !usedMissionIds.has(id)) || missionIds[0] || 0;
      if (!missionId) continue;
      missions.push({ missionId, slotIndex, retryCount: 0 });
      usedMissionIds.add(missionId);
      usedSlots.add(slotIndex);
    }
  }
  return missions.sort((left, right) => left.slotIndex - right.slotIndex);
}

function getMissionGroupRows(missionType, groupId, week) {
  const rows = getTableSet().missionGroupRows.filter(
    (row) => Number(row.MissionGroupID || 0) === Number(groupId || 0) && normalizeMissionType(row.GroupEnum) === missionType
  );
  const byWeek = rows.filter((row) => normalizeIntList(row.EventMissionWeek).includes(Number(week || 1)));
  if (byWeek.length) return byWeek;
  const availableWeeks = Array.from(new Set(rows.flatMap((row) => normalizeIntList(row.EventMissionWeek)))).sort((a, b) => a - b);
  const fallbackWeek = availableWeeks[availableWeeks.length - 1] || 0;
  return fallbackWeek ? rows.filter((row) => normalizeIntList(row.EventMissionWeek).includes(fallbackWeek)) : rows;
}

function findReplacementMissionId(ctx, pass, missionType, slotIndex, usedMissionIds) {
  const groupId = missionType === MISSION_TYPES.Weekly ? pass.weeklyMissionGroupId : pass.dailyMissionGroupId;
  const week = getWeekSinceEventStart(currentServerDate(ctx), pass.startDate);
  const used = new Set(usedMissionIds.map(Number));
  for (const row of getMissionGroupRows(missionType, groupId, week)) {
    if (!normalizeIntList(row.MissionSlotIndex).includes(Number(slotIndex))) continue;
    const replacement = normalizeIntList(row.MissionID).find((missionId) => !used.has(missionId));
    if (replacement) return replacement;
  }
  return 0;
}

function getRewardRows(pass, fromLevel, toLevel) {
  const groupId = Number(pass && pass.passRewardGroupId) || 0;
  return getTableSet().rewardRows
    .filter((row) => Number(row.PassRewardGroupID || 0) === groupId)
    .filter((row) => Number(row.PassLevel || 0) >= Number(fromLevel || 0) && Number(row.PassLevel || 0) <= Number(toLevel || 0))
    .sort((left, right) => Number(left.PassLevel || 0) - Number(right.PassLevel || 0));
}

function grantCounterPassRewardRow(ctx, user, row, lane, reward) {
  const prefix = lane === "Core" ? "Core" : "Normal";
  const type = row[`${prefix}RewardItemType`];
  const id = Number(row[`${prefix}RewardItemID`] || 0) || 0;
  const count = Number(row[`${prefix}RewardItemCount`] || 0) || 0;
  if (!type || String(type) === "RT_NONE" || id <= 0 || count <= 0) return;
  mergeReward(
    reward,
    grantRewardByType(ctx, user, type, id, count, count, 0, {
      regDate: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryForDate(currentServerDate(ctx)),
      expandPackages: true,
    })
  );
}

function shouldDeferCounterPassForTutorial(ctx, socket, options = {}) {
  if (ctx && typeof ctx.isTutorialCapturedBootstrapActive === "function" && ctx.isTutorialCapturedBootstrapActive(socket)) {
    return true;
  }
  if (options.activeBootstrapOnly) return false;
  const user = socket && socket.session && socket.session.user;
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  return Boolean(tutorial && tutorial.enabled !== false && tutorial.completed !== true && tutorial.loginMode !== "post-tutorial");
}

function buildEventPassMissionInfoData(info) {
  const data = info || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.missionId || 0) || 0),
    writeSignedVarInt(Number(data.slotIndex || 0) || 0),
    writeSignedVarInt(Number(data.retryCount || 0) || 0),
  ]);
}

function getTableSet() {
  if (cachedTables) return cachedTables;
  cachedTables = {
    passRows: readRecords("ab_script", "LUA_EVENT_PASS_TEMPLET.json"),
    missionGroupRows: readRecords("ab_script", "LUA_EVENT_PASS_MISSION_GROUP_TEMPLET.json"),
    rewardRows: readRecords("ab_script", "LUA_EVENT_PASS_REWARD_TEMPLET.json"),
  };
  return cachedTables;
}

function readRecords(directory, fileName) {
  return readGameplayTableRecords(directory, fileName, { rootDir: ROOT_DIR, logLabel: "counter-pass" });
}

function decodeMissionType(ctx, encryptedPayload) {
  return normalizeMissionType(decodeSingleInt(ctx, encryptedPayload));
}

function decodeSingleInt(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
    return readSignedVarInt(payload, 0).value;
  } catch (_) {
    return 0;
  }
}

function normalizeMissionType(value) {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "weekly" || text === "1") return MISSION_TYPES.Weekly;
    return MISSION_TYPES.Daily;
  }
  return Number(value) === MISSION_TYPES.Weekly ? MISSION_TYPES.Weekly : MISSION_TYPES.Daily;
}

function missionTypeName(value) {
  return MISSION_TYPE_NAMES[normalizeMissionType(value)] || "Daily";
}

function getWeekSinceEventStart(current, startDate) {
  const start = startDate instanceof Date && !Number.isNaN(startDate.getTime()) ? startDate : current;
  const timeSpan = current.getTime() - start.getTime();
  if (timeSpan <= 0) return 1;
  const totalDays = Math.floor(timeSpan / DAY_MS);
  let week = Math.floor(totalDays / 7);
  const dayRemainder = totalDays % 7;
  let currentDayFromMonday = current.getUTCDay() - 1;
  if (currentDayFromMonday < 0) currentDayFromMonday += 7;
  if (dayRemainder >= currentDayFromMonday) week += 1;
  if (start.getUTCDay() !== 1) week += 1;
  return Math.max(1, week);
}

function nextMissionResetDate(date, missionType) {
  const current = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  if (missionType === MISSION_TYPES.Weekly) {
    const day = current.getUTCDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + daysUntilMonday, 4, 0, 0, 0));
  }
  return new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 4, 0, 0, 0));
}

function currentServerDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const date = ctx.getServerNowDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  const date = ctx && ctx.eventManager && ctx.eventManager.config ? ctx.eventManager.config.eventDate : null;
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
}

function dateTimeBinaryForDate(date) {
  const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return BigInt(source.getTime()) * 10000n + TICKS_AT_UNIX_EPOCH | DATE_TIME_LOCAL_MASK;
}

function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateIso(value) {
  const date = value instanceof Date ? value : parseDate(value);
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
}

function normalizeIntList(value) {
  if (Array.isArray(value)) return value.map(Number).filter((entry) => Number.isInteger(entry) && entry > 0);
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? [number] : [];
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function formatDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : "n/a";
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
  }
}

function persist(ctx, options = {}) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") {
    if (options.affectsJoinLobby) ctx.saveUserDb();
    else ctx.saveUserDb({ affectsJoinLobby: false });
  }
}

module.exports = {
  PACKETS,
  createEventPassHandlers,
  resolveActiveCounterPass,
  sendCounterPassLobbyNotifications,
  buildEventPassAckPayload,
  buildMissionAckPayload,
  buildEventPassNotPayload,
  hasRemainingPassReward,
  claimRemainingPassRewards,
  buildRemainingPassRewardAckPayload,
};
