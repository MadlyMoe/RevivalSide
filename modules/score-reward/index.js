"use strict";

const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const {
  buildRewardData,
  readSignedVarInt,
  writeIntList,
  writeNullObject,
  writeNullableObject,
  writeSignedVarInt,
} = require("../packet-codec");

const PACKETS = Object.freeze({
  SCORE_REWARD_REQ: 3081,
  SCORE_REWARD_ACK: 3082,
  SCORE_REWARD_ALL_REQ: 3083,
  SCORE_REWARD_ALL_ACK: 3084,
});

const CONTENT = Object.freeze({ MINI_GAME: 0, EXPLORE: 1 });
const ERROR_CODES = Object.freeze({
  OK: 0,
  INVALID_TEMPLET: 28102,
  ALREADY_RECEIVED: 28103,
  GROUP_NOT_MATCHED: 28104,
  INVALID_CONTENT_TYPE: 28105,
});

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const catalog = loadCatalog();

function createScoreRewardHandlers() {
  return [
    {
      packetId: PACKETS.SCORE_REWARD_REQ,
      name: "SCORE_REWARD_REQ",
      handle(ctx, socket, packet) {
        const request = decodeScoreRewardRequest(ctx, packet && packet.payload);
        const result = claimScoreReward(ctx, socket && socket.session && socket.session.user, request);
        send(ctx, socket, packet, PACKETS.SCORE_REWARD_ACK, buildScoreRewardAckPayload(result), "score-reward");
        if (result.errorCode === ERROR_CODES.OK) commit(ctx, "score-reward");
        console.log(
          `[score-reward:SCORE_REWARD_REQ] ACK packetId=${PACKETS.SCORE_REWARD_ACK} content=${request.contentType} group=${request.rewardGroupId} reward=${request.rewardId} error=${result.errorCode}`
        );
        return true;
      },
    },
    {
      packetId: PACKETS.SCORE_REWARD_ALL_REQ,
      name: "SCORE_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const request = decodeScoreRewardAllRequest(ctx, packet && packet.payload);
        const result = claimAllScoreRewards(ctx, socket && socket.session && socket.session.user, request);
        send(ctx, socket, packet, PACKETS.SCORE_REWARD_ALL_ACK, buildScoreRewardAllAckPayload(result), "score-reward-all");
        if (result.errorCode === ERROR_CODES.OK) commit(ctx, "score-reward-all");
        console.log(
          `[score-reward:SCORE_REWARD_ALL_REQ] ACK packetId=${PACKETS.SCORE_REWARD_ALL_ACK} content=${request.contentType} group=${request.rewardGroupId} count=${result.rewardIds.length} error=${result.errorCode}`
        );
        return true;
      },
    },
  ];
}

function decodeScoreRewardRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const group = readSignedVarInt(payload, 0);
    const content = readSignedVarInt(payload, group.offset);
    const reward = readSignedVarInt(payload, content.offset);
    return {
      valid: reward.offset === payload.length,
      rewardGroupId: group.value,
      contentType: content.value,
      rewardId: reward.value,
    };
  } catch (_) {
    return { valid: false, rewardGroupId: 0, contentType: 0, rewardId: 0 };
  }
}

function decodeScoreRewardAllRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const group = readSignedVarInt(payload, 0);
    const content = readSignedVarInt(payload, group.offset);
    return {
      valid: content.offset === payload.length,
      rewardGroupId: group.value,
      contentType: content.value,
    };
  } catch (_) {
    return { valid: false, rewardGroupId: 0, contentType: 0 };
  }
}

function claimScoreReward(ctx, user, request = {}) {
  const checked = validateRequest(request);
  if (checked.errorCode) return singleResult(checked.errorCode, request.contentType, request.rewardId);
  const rows = catalog.rowsByGroup.get(checked.groupId) || [];
  const row = rows.find((entry) => entry.rewardId === positiveInt(request.rewardId));
  if (!row) return singleResult(ERROR_CODES.INVALID_TEMPLET, checked.contentType, request.rewardId);

  const received = getReceivedRewardIds(user, checked.contentType);
  if (received.includes(row.rewardId)) {
    return singleResult(ERROR_CODES.ALREADY_RECEIVED, checked.contentType, row.rewardId);
  }
  if (getContentScore(user, checked.contentType, checked.groupId) < row.score) {
    return singleResult(ERROR_CODES.INVALID_TEMPLET, checked.contentType, row.rewardId);
  }

  const reward = grantRow(ctx, user, row);
  setReceivedRewardIds(user, checked.contentType, [...received, row.rewardId]);
  return singleResult(ERROR_CODES.OK, checked.contentType, row.rewardId, reward, true);
}

function claimAllScoreRewards(ctx, user, request = {}) {
  const checked = validateRequest(request);
  if (checked.errorCode) return allResult(checked.errorCode, request.contentType);
  const rows = catalog.rowsByGroup.get(checked.groupId) || [];
  const received = getReceivedRewardIds(user, checked.contentType);
  const unclaimed = rows.filter((row) => !received.includes(row.rewardId));
  if (!unclaimed.length) return allResult(ERROR_CODES.ALREADY_RECEIVED, checked.contentType);
  const score = getContentScore(user, checked.contentType, checked.groupId);
  const eligible = unclaimed.filter((row) => score >= row.score);
  if (!eligible.length) return allResult(ERROR_CODES.INVALID_TEMPLET, checked.contentType);

  const reward = createEmptyReward();
  for (const row of eligible) mergeReward(reward, grantRow(ctx, user, row));
  const rewardIds = eligible.map((row) => row.rewardId);
  setReceivedRewardIds(user, checked.contentType, [...received, ...rewardIds]);
  return allResult(ERROR_CODES.OK, checked.contentType, rewardIds, reward, true);
}

function validateRequest(request = {}) {
  const contentType = Number(request.contentType);
  const groupId = positiveInt(request.rewardGroupId);
  if (!request.valid || (contentType !== CONTENT.MINI_GAME && contentType !== CONTENT.EXPLORE)) {
    return { errorCode: ERROR_CODES.INVALID_CONTENT_TYPE, contentType, groupId };
  }
  if (!catalog.rowsByGroup.has(groupId)) {
    return { errorCode: ERROR_CODES.INVALID_TEMPLET, contentType, groupId };
  }
  const allowedGroups = contentType === CONTENT.MINI_GAME ? catalog.miniGameGroups : catalog.exploreGroups;
  if (!allowedGroups.has(groupId)) {
    return { errorCode: ERROR_CODES.GROUP_NOT_MATCHED, contentType, groupId };
  }
  return { errorCode: ERROR_CODES.OK, contentType, groupId };
}

function buildScoreRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(nonNegativeInt(result.errorCode)),
    writeSignedVarInt(Number.isInteger(Number(result.contentType)) ? Number(result.contentType) : 0),
    result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
    writeSignedVarInt(nonNegativeInt(result.rewardId)),
  ]);
}

function buildScoreRewardAllAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(nonNegativeInt(result.errorCode)),
    writeSignedVarInt(Number.isInteger(Number(result.contentType)) ? Number(result.contentType) : 0),
    writeIntList(Array.isArray(result.rewardIds) ? result.rewardIds : []),
    result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
  ]);
}

function getContentScore(user, contentType, groupId) {
  if (contentType === CONTENT.MINI_GAME) return getMiniGameScore(user, groupId);
  if (contentType === CONTENT.EXPLORE) return getExploreScore(user, groupId);
  return 0;
}

function getMiniGameScore(user, groupId) {
  const templetId = catalog.miniGameTempletIdByGroup.get(groupId) || 0;
  const direct = user && user.miniGameScores && user.miniGameScores[String(groupId)];
  let best = safeScore(direct);
  const sources = [user && user.miniGames, user && user.miniGameData, user && user.miniGameDatas];
  for (const source of sources) {
    for (const entry of objectValues(source)) {
      const entryTempletId = positiveInt(entry && (entry.templetId ?? entry.templetID ?? entry.id));
      if (entryTempletId === templetId || entryTempletId === groupId) {
        best = Math.max(best, safeScore(entry && (entry.score ?? entry.bestScore)));
      }
    }
  }
  return best;
}

function getExploreScore(user, groupId) {
  const templetId = catalog.exploreTempletIdByGroup.get(groupId) || 0;
  const direct = user && user.exploreScores && user.exploreScores[String(groupId)];
  let best = safeScore(direct);
  const sources = [
    user && user.explore,
    user && user.exploreData,
    user && user.miscStages && user.miscStages.explore,
  ];
  for (const source of sources) {
    for (const entry of objectValues(source)) {
      if (!entry || typeof entry !== "object") continue;
      const entryTempletId = positiveInt(entry.templetId ?? entry.templetID ?? entry.exploreId ?? entry.ExploreID);
      if (!entryTempletId || entryTempletId === templetId || entryTempletId === groupId) {
        best = Math.max(best, safeScore(entry.seasonScore ?? entry.SeasonScore));
      }
    }
  }
  return best;
}

function getReceivedRewardIds(user, contentType) {
  const key = contentKey(contentType);
  const canonical = user && user.scoreRewards && Array.isArray(user.scoreRewards[key]) ? user.scoreRewards[key] : [];
  const legacy = contentType === CONTENT.MINI_GAME
    ? user && (user.miniGameReceivedRewardIds || user.receivedMiniGameRewardIds)
    : user && user.explore && user.explore.rewardIds;
  return uniqueIds([...canonical, ...(Array.isArray(legacy) ? legacy : [])]);
}

function setReceivedRewardIds(user, contentType, ids) {
  if (!user || typeof user !== "object") return;
  user.scoreRewards = user.scoreRewards && typeof user.scoreRewards === "object" ? user.scoreRewards : {};
  user.scoreRewards[contentKey(contentType)] = uniqueIds(ids);
}

function grantRow(ctx, user, row) {
  const reward = createEmptyReward();
  const regDate = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n;
  for (const entry of row.rewards) {
    mergeReward(
      reward,
      grantRewardByType(ctx, user, entry.type, entry.id, entry.quantity, entry.quantity, 0, {
        regDate,
        expandPackages: false,
      })
    );
  }
  return reward;
}

function loadCatalog() {
  const rowsByGroup = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_SCORE_REWARD_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "score-reward",
  })) {
    const groupId = positiveInt(raw && raw.m_ScoreRewardGroupID);
    const rewardId = positiveInt(raw && raw.m_ScoreRewardID);
    if (!groupId || !rewardId) continue;
    const rewards = [];
    for (let index = 1; index <= 3; index += 1) {
      const type = String(raw[`m_ScoreRewardType_${index}`] || "");
      const id = positiveInt(raw[`m_ScoreRewardID_${index}`]);
      const quantity = positiveInt(raw[`m_ScoreRewardQuantity_${index}`]);
      if (type && type !== "RT_NONE" && id && quantity) rewards.push({ type, id, quantity });
    }
    const rows = rowsByGroup.get(groupId) || [];
    rows.push({
      groupId,
      rewardId,
      step: positiveInt(raw.m_Step),
      score: nonNegativeInt(raw.m_Score),
      rewards,
    });
    rowsByGroup.set(groupId, rows);
  }
  for (const rows of rowsByGroup.values()) rows.sort((left, right) => left.step - right.step || left.rewardId - right.rewardId);

  const miniGameGroups = new Set();
  const miniGameTempletIdByGroup = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_MINIGAME_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "score-reward" })) {
    const groupId = positiveInt(raw && raw.m_ScoreRewardGroupID);
    const templetId = positiveInt(raw && raw.m_Id);
    if (groupId && templetId) {
      miniGameGroups.add(groupId);
      miniGameTempletIdByGroup.set(groupId, templetId);
    }
  }

  const exploreGroups = new Set();
  const exploreTempletIdByGroup = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_EXPLORE_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "score-reward" })) {
    const groupId = positiveInt(raw && raw.ExplorePointRewardGroupID);
    const templetId = positiveInt(raw && raw.ExploreID);
    if (groupId && templetId) {
      exploreGroups.add(groupId);
      exploreTempletIdByGroup.set(groupId, templetId);
    }
  }
  return { rowsByGroup, miniGameGroups, miniGameTempletIdByGroup, exploreGroups, exploreTempletIdByGroup };
}

function singleResult(errorCode, contentType = 0, rewardId = 0, reward = null, changed = false) {
  return { errorCode, contentType, rewardId: nonNegativeInt(rewardId), reward, changed };
}

function allResult(errorCode, contentType = 0, rewardIds = [], reward = null, changed = false) {
  return { errorCode, contentType, rewardIds, reward, changed };
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function commit(ctx, reason) {
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function decrypt(ctx, payload) {
  return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : Buffer.alloc(0);
}

function contentKey(contentType) {
  return contentType === CONTENT.EXPLORE ? "explore" : "miniGame";
}

function uniqueIds(values) {
  return Array.from(new Set((values || []).map(positiveInt).filter(Boolean))).sort((left, right) => left - right);
}

function objectValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if ("score" in value || "seasonScore" in value || "templetId" in value || "ExploreID" in value) return [value];
  return Object.values(value);
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

module.exports = {
  PACKETS,
  CONTENT,
  ERROR_CODES,
  buildScoreRewardAckPayload,
  buildScoreRewardAllAckPayload,
  claimAllScoreRewards,
  claimScoreReward,
  createScoreRewardHandlers,
  decodeScoreRewardAllRequest,
  decodeScoreRewardRequest,
  getContentScore,
  getReceivedRewardIds,
  loadCatalog,
};
