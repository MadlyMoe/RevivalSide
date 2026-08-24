"use strict";

const { readGameplayTableRecords } = require("../gameplay-jsons");
const { buildCommonProfileData, buildGuildSimpleData } = require("../leaderboard");
const {
  buildRewardData,
  dateTimeBinaryNow,
  readBool,
  readSignedVarInt,
  toBigInt,
  writeBool,
  writeInt64LE,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
  writeSignedVarInt,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");

const PACKETS = Object.freeze({
  RANK_LIST_REQ: 2606,
  RANK_LIST_ACK: 2607,
  WEEK_REWARD_REQ: 2610,
  WEEK_REWARD_ACK: 2611,
  SEASON_REWARD_REQ: 2612,
  SEASON_REWARD_ACK: 2613,
  ASYNC_RANK_LIST_REQ: 2619,
  ASYNC_RANK_LIST_ACK: 2620,
  ASYNC_SEASON_REWARD_REQ: 2624,
  ASYNC_SEASON_REWARD_ACK: 2625,
  ASYNC_WEEK_REWARD_REQ: 2626,
  ASYNC_WEEK_REWARD_ACK: 2627,
});

const ERRORS = Object.freeze({
  OK: 0,
  INVALID_RANK_TYPE: 337,
  INVALID_SEASON_DATA: 338,
  END_WEEK: 350,
  ALREADY_REWARDED_WEEK: 351,
  ALREADY_REWARDED_SEASON: 352,
  SEASON_ID_ZERO: 443,
  WEEK_ID_ZERO: 444,
  INVALID_REQUEST: 20191,
});

const RANK_TYPES = Object.freeze({ MY_LEAGUE: 0, ALL: 1, FRIEND: 2 });
const TOP_LIMIT = 10;
const ALL_LIMIT = 100;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_CALC_START_MS = 6 * 24 * 60 * 60 * 1000 + 18 * 60 * 60 * 1000;
const REGIONS = new Set(["GLOBAL", "KOR", "TWN", "SEA", "CHN", "JPN"]);
let cachedCatalog = null;

function createPvpRankHandlers() {
  return [
    { packetId: PACKETS.RANK_LIST_REQ, name: "PVP_RANK_LIST_REQ", handle: handleRankList },
    { packetId: PACKETS.WEEK_REWARD_REQ, name: "PVP_RANK_WEEK_REWARD_REQ", handle: handleWeekReward },
    { packetId: PACKETS.SEASON_REWARD_REQ, name: "PVP_RANK_SEASON_REWARD_REQ", handle: handleSeasonReward },
    { packetId: PACKETS.ASYNC_RANK_LIST_REQ, name: "ASYNC_PVP_RANK_LIST_REQ", handle: handleAsyncRankList },
    { packetId: PACKETS.ASYNC_SEASON_REWARD_REQ, name: "ASYNC_PVP_RANK_SEASON_REWARD_REQ", handle: handleAsyncSeasonReward },
    { packetId: PACKETS.ASYNC_WEEK_REWARD_REQ, name: "ASYNC_PVP_RANK_WEEK_REWARD_REQ", handle: handleAsyncWeekReward },
  ];
}

function handleRankList(ctx, socket, packet) {
  const request = decodeRankListRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = getRankList(ctx, user, request);
  send(ctx, socket, packet, PACKETS.RANK_LIST_ACK, buildRankListAckPayload(result), "pvp-rank-list");
  return true;
}

function handleWeekReward(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = request.valid
    ? claimWeekReward(ctx, user, { now: getNow(ctx) })
    : failedReward(ERRORS.INVALID_REQUEST);
  send(ctx, socket, packet, PACKETS.WEEK_REWARD_ACK, buildWeekRewardAckPayload(result), "pvp-rank-week-reward");
  persistSuccess(ctx, result, "pvp-rank-week-reward");
  return true;
}

function handleSeasonReward(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = request.valid
    ? claimSeasonReward(ctx, user, { now: getNow(ctx) })
    : failedReward(ERRORS.INVALID_REQUEST);
  send(ctx, socket, packet, PACKETS.SEASON_REWARD_ACK, buildSeasonRewardAckPayload(result), "pvp-rank-season-reward");
  persistSuccess(ctx, result, "pvp-rank-season-reward");
  return true;
}

function handleAsyncRankList(ctx, socket, packet) {
  const request = decodeRankListRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = getAsyncRankList(ctx, user, request);
  send(ctx, socket, packet, PACKETS.ASYNC_RANK_LIST_ACK, buildAsyncRankListAckPayload(result), "async-pvp-rank-list");
  return true;
}

function handleAsyncWeekReward(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = request.valid
    ? claimAsyncWeekReward(ctx, user, { now: getNow(ctx) })
    : failedAsyncReward(ERRORS.INVALID_REQUEST);
  send(ctx, socket, packet, PACKETS.ASYNC_WEEK_REWARD_ACK, buildAsyncWeekRewardAckPayload(result), "async-pvp-rank-week-reward");
  persistSuccess(ctx, result, "async-pvp-rank-week-reward");
  return true;
}

function handleAsyncSeasonReward(ctx, socket, packet) {
  const request = decodeEmptyRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = request.valid
    ? claimAsyncSeasonReward(ctx, user, { now: getNow(ctx) })
    : failedAsyncReward(ERRORS.INVALID_REQUEST);
  send(ctx, socket, packet, PACKETS.ASYNC_SEASON_REWARD_ACK, buildAsyncSeasonRewardAckPayload(result), "async-pvp-rank-season-reward");
  persistSuccess(ctx, result, "async-pvp-rank-season-reward");
  return true;
}

function decodeRankListRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const rankType = readSignedVarInt(payload, 0);
    if (rankType.offset + 1 !== payload.length || payload[rankType.offset] > 1) {
      return { valid: false, rankType: 0, isAll: false };
    }
    return {
      valid: true,
      rankType: rankType.value,
      isAll: readBool(payload, rankType.offset).value,
    };
  } catch (_) {
    return { valid: false, rankType: 0, isAll: false };
  }
}

function decodeEmptyRequest(ctx, encryptedPayload) {
  try {
    return { valid: decrypt(ctx, encryptedPayload).length === 0 };
  } catch (_) {
    return { valid: false };
  }
}

function getRankList(ctx, user, request) {
  const rankType = int(request && request.rankType);
  if (!request || !request.valid) return { errorCode: ERRORS.INVALID_REQUEST, rankType, profiles: [] };
  if (![RANK_TYPES.MY_LEAGUE, RANK_TYPES.ALL, RANK_TYPES.FRIEND].includes(rankType)) {
    return { errorCode: ERRORS.INVALID_RANK_TYPE, rankType, profiles: [] };
  }

  const allRanked = rankUsers(getUsers(ctx, user));
  const ownState = getPvpRankState(user);
  const friendUids = new Set(
    user && user.community && Array.isArray(user.community.friends)
      ? user.community.friends.map(String)
      : []
  );
  const filtered = allRanked.filter((entry) => {
    if (rankType === RANK_TYPES.ALL) return true;
    if (rankType === RANK_TYPES.FRIEND) return friendUids.has(String(userUid(entry.user)));
    return entry.state.leagueTierId === ownState.leagueTierId;
  });
  const limit = request.isAll ? ALL_LIMIT : TOP_LIMIT;
  return { errorCode: ERRORS.OK, rankType, profiles: filtered.slice(0, limit) };
}

function rankUsers(users) {
  return users
    .filter(hasPvpRankState)
    .map((user) => ({ user, state: getPvpRankState(user) }))
    .filter((entry) => entry.state.score > 0)
    .sort((left, right) => right.state.score - left.state.score || compareUid(left.user, right.user))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function getAsyncRankList(ctx, user, request) {
  const rankType = int(request && request.rankType);
  const isAll = Boolean(request && request.isAll);
  if (!request || !request.valid) return { errorCode: ERRORS.INVALID_REQUEST, rankType, isAll, profiles: [] };
  if (![RANK_TYPES.MY_LEAGUE, RANK_TYPES.ALL, RANK_TYPES.FRIEND].includes(rankType)) {
    return { errorCode: ERRORS.INVALID_RANK_TYPE, rankType, isAll, profiles: [] };
  }

  const allRanked = rankAsyncUsers(getUsers(ctx, user));
  const ownState = getAsyncPvpState(user);
  const friendUids = new Set(
    user && user.community && Array.isArray(user.community.friends)
      ? user.community.friends.map(String)
      : []
  );
  const filtered = allRanked.filter((entry) => {
    if (rankType === RANK_TYPES.ALL) return true;
    if (rankType === RANK_TYPES.FRIEND) return friendUids.has(String(userUid(entry.user)));
    return entry.state.leagueTierId === ownState.leagueTierId;
  });
  return { errorCode: ERRORS.OK, rankType, isAll, profiles: filtered.slice(0, isAll ? ALL_LIMIT : TOP_LIMIT) };
}

function rankAsyncUsers(users) {
  return users
    .filter(hasAsyncPvpState)
    .map((user) => ({ user, state: getAsyncPvpState(user) }))
    .filter((entry) => entry.state.score > 0)
    .sort((left, right) => right.state.score - left.state.score || compareUid(left.user, right.user))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function buildRankListAckPayload(result = {}) {
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    writeSignedVarInt(int(result.rankType)),
    writeNullableObjectList(profiles.map(buildUserSimpleProfileData)),
  ]);
}

function buildAsyncRankListAckPayload(result = {}) {
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    writeSignedVarInt(int(result.rankType)),
    writeBool(Boolean(result.isAll)),
    writeNullableObjectList(profiles.map(buildUserSimpleProfileData)),
  ]);
}

function buildUserSimpleProfileData(entry = {}) {
  const user = entry.user || {};
  const state = entry.state || getPvpRankState(user);
  return Buffer.concat([
    buildCommonProfileData(user),
    writeSignedVarInt(state.score),
    writeSignedVarInt(state.leagueTierId),
    writeNullableObject(buildGuildSimpleData(user)),
    writeInt64LE(lastLoginDate(user)),
  ]);
}

function claimWeekReward(ctx, user, options = {}) {
  const now = validDate(options.now);
  const season = getActiveSeason(ctx, user, now);
  const state = hasPvpRankState(user) ? getPvpRankState(user) : zeroPvpState();
  if (state.seasonId === 0) return failedReward(ERRORS.SEASON_ID_ZERO);
  if (!season || state.seasonId !== season.seasonId) return failedReward(ERRORS.INVALID_SEASON_DATA);
  if (state.weekId === 0) return failedReward(ERRORS.WEEK_ID_ZERO);
  const weekId = getWeekId(season, now);
  if (state.weekId === weekId) return failedReward(ERRORS.ALREADY_REWARDED_WEEK);
  if (isWeekCalculationWindow(season, now)) return failedReward(ERRORS.END_WEEK);

  const tier = getTierByTier(season.rankGroup, state.leagueTierId);
  if (!tier) return failedReward(ERRORS.INVALID_SEASON_DATA);
  const reward = grantTierRewards(ctx, user, tier, "Weekly");
  const nextState = { ...state, weekId };
  setPvpRankState(user, nextState);
  return {
    errorCode: ERRORS.OK,
    reward,
    pvpData: nextState,
    reducedPvpData: null,
    rankReward: null,
    isScoreChanged: false,
    changed: true,
  };
}

function claimSeasonReward(ctx, user, options = {}) {
  const now = validDate(options.now);
  const season = getActiveSeason(ctx, user, now);
  const previous = hasPvpRankState(user) ? getPvpRankState(user) : zeroPvpState();
  if (!season || previous.seasonId === 0 || previous.seasonId !== season.seasonId - 1) {
    return failedReward(ERRORS.INVALID_SEASON_DATA);
  }
  if (previous.seasonId === season.seasonId) return failedReward(ERRORS.ALREADY_REWARDED_SEASON);
  if (isWeekCalculationWindow(season, now)) return failedReward(ERRORS.END_WEEK);

  const previousSeason = getSeasonById(ctx, user, previous.seasonId);
  if (!previousSeason) return failedReward(ERRORS.INVALID_SEASON_DATA);
  const rewardTier = getTierByTier(previousSeason.rankGroup, previous.leagueTierId);
  const scoreTier = getTierByScore(previousSeason.rankGroup, previous.score);
  if (!rewardTier || !scoreTier) return failedReward(ERRORS.INVALID_SEASON_DATA);

  const rankRewardRow = getSeasonRankReward(previousSeason.seasonRewardGroup, previous.rank);
  const resetScore = getResetScore(scoreTier, previous.score);
  const currentTier = getTierByScore(season.rankGroup, resetScore);
  if (!currentTier) return failedReward(ERRORS.INVALID_SEASON_DATA);
  const reward = grantTierRewards(ctx, user, rewardTier, "Season");
  const rankReward = rankRewardRow ? grantRewardRow(ctx, user, rankRewardRow, "") : null;
  const nextState = {
    ...zeroPvpState(),
    seasonId: season.seasonId,
    score: resetScore,
    maxScore: resetScore,
    leagueTierId: currentTier.leagueTier,
    maxLeagueTierId: currentTier.leagueTier,
    rankOpen: previous.rankOpen,
  };
  setPvpRankState(user, nextState);
  return {
    errorCode: ERRORS.OK,
    reward,
    rankReward,
    pvpData: nextState,
    reducedPvpData: previous,
    isScoreChanged: resetScore !== previous.score,
    changed: true,
  };
}

function claimAsyncWeekReward(ctx, user, options = {}) {
  const now = validDate(options.now);
  const season = getActiveAsyncSeason(ctx, user, now);
  const state = hasAsyncPvpState(user) ? getAsyncPvpState(user) : zeroPvpState();
  if (state.seasonId === 0) return failedAsyncReward(ERRORS.SEASON_ID_ZERO);
  if (!season || state.seasonId !== season.seasonId) return failedAsyncReward(ERRORS.INVALID_SEASON_DATA);
  if (state.weekId === 0) return failedAsyncReward(ERRORS.WEEK_ID_ZERO);
  const weekId = getWeekId(season, now);
  if (state.weekId === weekId) return failedAsyncReward(ERRORS.ALREADY_REWARDED_WEEK);
  if (isWeekCalculationWindow(season, now)) return failedAsyncReward(ERRORS.END_WEEK);

  const tier = getTierByTier(season.rankGroup, state.leagueTierId);
  if (!tier) return failedAsyncReward(ERRORS.INVALID_SEASON_DATA);
  const reward = grantTierRewards(ctx, user, tier, "Weekly");
  setAsyncPvpState(user, { ...state, weekId });
  return { errorCode: ERRORS.OK, reward, weekId, pvpState: null, npcPvpData: null, changed: true };
}

function claimAsyncSeasonReward(ctx, user, options = {}) {
  const now = validDate(options.now);
  const season = getActiveAsyncSeason(ctx, user, now);
  const previous = hasAsyncPvpState(user) ? getAsyncPvpState(user) : zeroPvpState();
  if (!season || previous.seasonId === 0 || previous.seasonId !== season.seasonId - 1) {
    return failedAsyncReward(ERRORS.INVALID_SEASON_DATA);
  }
  if (previous.seasonId === season.seasonId) return failedAsyncReward(ERRORS.ALREADY_REWARDED_SEASON);
  if (isWeekCalculationWindow(season, now)) return failedAsyncReward(ERRORS.END_WEEK);

  const previousSeason = getAsyncSeasonById(ctx, user, previous.seasonId);
  if (!previousSeason) return failedAsyncReward(ERRORS.INVALID_SEASON_DATA);
  const rewardTier = getTierByTier(previousSeason.rankGroup, previous.leagueTierId);
  const scoreTier = getTierByScore(previousSeason.rankGroup, previous.score);
  if (!rewardTier || !scoreTier) return failedAsyncReward(ERRORS.INVALID_SEASON_DATA);
  const resetScore = getResetScore(scoreTier, previous.score);
  const currentTier = getTierByScore(season.rankGroup, resetScore);
  if (!currentTier) return failedAsyncReward(ERRORS.INVALID_SEASON_DATA);

  const reward = grantTierRewards(ctx, user, rewardTier, "Season");
  const nextState = {
    ...zeroPvpState(),
    seasonId: season.seasonId,
    score: resetScore,
    maxScore: resetScore,
    leagueTierId: currentTier.leagueTier,
    maxLeagueTierId: currentTier.leagueTier,
    rankOpen: previous.rankOpen,
  };
  const npcPvpData = zeroNpcPvpData();
  setAsyncPvpState(user, nextState);
  setNpcPvpData(user, npcPvpData);
  return { errorCode: ERRORS.OK, reward, weekId: 0, pvpState: nextState, npcPvpData, changed: true };
}

function buildWeekRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    nullablePayload(result.reward, buildRewardData),
    nullablePayload(result.pvpData, buildPvpStateData),
    writeBool(Boolean(result.isScoreChanged)),
  ]);
}

function buildSeasonRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    nullablePayload(result.reward, buildRewardData),
    nullablePayload(result.rankReward, buildRewardData),
    nullablePayload(result.pvpData, buildPvpStateData),
    nullablePayload(result.reducedPvpData, buildPvpStateData),
    writeBool(Boolean(result.isScoreChanged)),
  ]);
}

function buildAsyncWeekRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    nullablePayload(result.reward, buildRewardData),
    writeSignedVarInt(int(result.weekId)),
  ]);
}

function buildAsyncSeasonRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    nullablePayload(result.reward, buildRewardData),
    nullablePayload(result.pvpState, buildPvpStateData),
    nullablePayload(result.npcPvpData, buildNpcPvpData),
  ]);
}

function buildPvpStateData(value) {
  const state = normalizePvpState(value);
  return Buffer.concat([
    writeSignedVarInt(state.seasonId),
    writeSignedVarInt(state.weekId),
    writeSignedVarInt(state.winCount),
    writeSignedVarInt(state.loseCount),
    writeSignedVarInt(state.leagueTierId),
    writeSignedVarInt(state.maxLeagueTierId),
    writeSignedVarInt(state.score),
    writeSignedVarInt(state.maxScore),
    writeSignedVarInt(state.winStreak),
    writeSignedVarInt(state.maxWinStreak),
    writeSignedVarInt(state.rank),
    writeSignedVarInt(state.seasonPlayCount),
    writeSignedVarInt(state.seasonWinCount),
  ]);
}

function hasPvpRankState(user) {
  return Boolean(user && user.pvp && user.pvp.rank && typeof user.pvp.rank === "object");
}

function getPvpRankState(user) {
  return normalizePvpState(user && user.pvp && user.pvp.rank);
}

function setPvpRankState(user, state) {
  if (!user) return;
  if (!user.pvp || typeof user.pvp !== "object") user.pvp = {};
  user.pvp.rank = normalizePvpState(state);
}

function hasAsyncPvpState(user) {
  return Boolean(user && user.pvp && user.pvp.async && typeof user.pvp.async === "object");
}

function getAsyncPvpState(user) {
  return normalizePvpState(user && user.pvp && user.pvp.async);
}

function setAsyncPvpState(user, state) {
  if (!user) return;
  if (!user.pvp || typeof user.pvp !== "object") user.pvp = {};
  user.pvp.async = normalizePvpState(state);
}

function getNpcPvpData(user) {
  const data = user && user.pvp && user.pvp.npc && typeof user.pvp.npc === "object" ? user.pvp.npc : {};
  return {
    maxTierCount: stateInt(data, "maxTierCount", "MaxTierCount"),
    maxOpenedTier: stateInt(data, "maxOpenedTier", "MaxOpenedTier"),
  };
}

function setNpcPvpData(user, value) {
  if (!user) return;
  if (!user.pvp || typeof user.pvp !== "object") user.pvp = {};
  const data = value && typeof value === "object" ? value : {};
  user.pvp.npc = {
    maxTierCount: stateInt(data, "maxTierCount", "MaxTierCount"),
    maxOpenedTier: stateInt(data, "maxOpenedTier", "MaxOpenedTier"),
  };
}

function zeroNpcPvpData() {
  return { maxTierCount: 0, maxOpenedTier: 0 };
}

function buildNpcPvpData(value) {
  const data = value && typeof value === "object" ? value : {};
  return Buffer.concat([
    writeSignedVarInt(stateInt(data, "maxTierCount", "MaxTierCount")),
    writeSignedVarInt(stateInt(data, "maxOpenedTier", "MaxOpenedTier")),
  ]);
}

function isRankPvpOpen(user) {
  return hasPvpRankState(user) && getPvpRankState(user).rankOpen;
}

function normalizePvpState(value) {
  const data = value && typeof value === "object" ? value : {};
  return {
    seasonId: stateInt(data, "seasonId", "SeasonID"),
    weekId: stateInt(data, "weekId", "WeekID"),
    winCount: stateInt(data, "winCount", "WinCount"),
    loseCount: stateInt(data, "loseCount", "LoseCount"),
    leagueTierId: stateInt(data, "leagueTierId", "LeagueTierID"),
    maxLeagueTierId: stateInt(data, "maxLeagueTierId", "MaxLeagueTierID"),
    score: stateInt(data, "score", "Score"),
    maxScore: stateInt(data, "maxScore", "MaxScore"),
    winStreak: stateInt(data, "winStreak", "WinStreak"),
    maxWinStreak: stateInt(data, "maxWinStreak", "MaxWinStreak"),
    rank: stateInt(data, "rank", "Rank"),
    seasonPlayCount: stateInt(data, "seasonPlayCount", "SeasonPlayCount"),
    seasonWinCount: stateInt(data, "seasonWinCount", "SeasonWinCount"),
    rankOpen: data.rankOpen !== false,
  };
}

function zeroPvpState() {
  return normalizePvpState({ rankOpen: false });
}

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const seasons = readGameplayTableRecords("ab_script", "LUA_PVP_RANK_SEASON.json");
  const asyncSeasons = readGameplayTableRecords("ab_script", "LUA_PVP_ASYNC_SEASON.json");
  const tiers = readGameplayTableRecords("ab_script", "LUA_PVP_RANK.json");
  const seasonRewards = readGameplayTableRecords("ab_script", "LUA_PVP_RANK_SEASON_REWARD.json");
  const tiersByGroup = new Map();
  for (const row of tiers) {
    const group = int(row && row.m_RankGroup);
    if (!tiersByGroup.has(group)) tiersByGroup.set(group, []);
    tiersByGroup.get(group).push(row);
  }
  for (const rows of tiersByGroup.values()) rows.sort((left, right) => int(left.m_LeaguePointReq) - int(right.m_LeaguePointReq));
  cachedCatalog = { seasons, asyncSeasons, tiers, seasonRewards, tiersByGroup };
  return cachedCatalog;
}

function getActiveSeason(ctx, user, now = new Date()) {
  const candidates = loadCatalog().seasons.filter((row) => {
    const start = parseTableDate(row && row.m_SeasonDateStart);
    const end = parseTableDate(row && row.m_SeasonDateEnd);
    return start && end && start <= now && now <= end;
  });
  return normalizeSeason(selectRegionalRow(candidates, getRegion(ctx, user)));
}

function getSeasonById(ctx, user, seasonId) {
  const candidates = loadCatalog().seasons.filter((row) => int(row && row.m_Season) === int(seasonId));
  return normalizeSeason(selectRegionalRow(candidates, getRegion(ctx, user)));
}

function getActiveAsyncSeason(ctx, user, now = new Date()) {
  const candidates = loadCatalog().asyncSeasons.filter((row) => {
    const start = parseTableDate(row && row.m_SeasonDateStart);
    const end = parseTableDate(row && row.m_SeasonDateEnd);
    return start && end && start <= now && now <= end;
  });
  return normalizeSeason(selectRegionalRow(candidates, getRegion(ctx, user)));
}

function getAsyncSeasonById(ctx, user, seasonId) {
  const candidates = loadCatalog().asyncSeasons.filter((row) => int(row && row.m_Season) === int(seasonId));
  return normalizeSeason(selectRegionalRow(candidates, getRegion(ctx, user)));
}

function normalizeSeason(row) {
  if (!row) return null;
  return {
    row,
    seasonId: int(row.m_Season),
    rankGroup: int(row.m_RankGroup),
    seasonRewardGroup: int(row.m_RankSeasonRewardGroup),
    start: parseTableDate(row.m_SeasonDateStart),
    end: parseTableDate(row.m_SeasonDateEnd),
  };
}

function getTierByScore(rankGroup, score) {
  const rows = loadCatalog().tiersByGroup.get(int(rankGroup)) || [];
  let selected = null;
  for (const row of rows) {
    if (int(row.m_LeaguePointReq) > int(score)) break;
    selected = row;
  }
  return selected ? {
    row: selected,
    leagueTier: int(selected.m_LeagueTier),
    pointRequired: int(selected.m_LeaguePointReq),
    demotePoint: int(selected.LeagueDemotePoint),
  } : null;
}

function getTierByTier(rankGroup, leagueTier) {
  const row = (loadCatalog().tiersByGroup.get(int(rankGroup)) || [])
    .find((entry) => int(entry && entry.m_LeagueTier) === int(leagueTier));
  return row ? {
    row,
    leagueTier: int(row.m_LeagueTier),
    pointRequired: int(row.m_LeaguePointReq),
    demotePoint: int(row.LeagueDemotePoint),
  } : null;
}

function getSeasonRankReward(groupId, rank) {
  const value = int(rank);
  if (value <= 0) return null;
  return loadCatalog().seasonRewards.find((row) =>
    int(row && row.SeasonRewardGroupId) === int(groupId) &&
    int(row.MinRank) <= value && value <= int(row.MaxRank)
  ) || null;
}

function grantTierRewards(ctx, user, tier, suffix) {
  const reward = createEmptyReward();
  const cash = int(tier.row[`m_RewardCash${suffix}`]);
  const pvpPoint = int(tier.row[`m_RewardPVPPoint${suffix}`]);
  if (cash > 0) mergeReward(reward, grantRewardByType(ctx, user, "RT_MISC", 101, cash, null, 0, { expandPackages: false }));
  if (pvpPoint > 0) mergeReward(reward, grantRewardByType(ctx, user, "RT_MISC", 5, pvpPoint, null, 0, { expandPackages: false }));
  mergeReward(reward, grantRewardRow(ctx, user, tier.row, suffix));
  return reward;
}

function grantRewardRow(ctx, user, row, suffix) {
  const reward = createEmptyReward();
  for (let index = 1; index <= 3; index += 1) {
    const type = row && row[`m_RewardType${suffix}_${index}`];
    const id = int(row && row[`m_RewardID${suffix}_${index}`]);
    const value = int(row && row[`m_RewardValue${suffix}_${index}`]);
    if (!type || id <= 0 || value <= 0) continue;
    mergeReward(reward, grantRewardByType(ctx, user, type, id, value, null, 0, { expandPackages: false }));
  }
  return reward;
}

function getResetScore(previousTier, score) {
  const value = int(score);
  return previousTier && previousTier.demotePoint < value ? previousTier.demotePoint : value;
}

function getWeekId(season, now) {
  if (!season || !season.start) return 0;
  return Math.max(1, Math.floor((now.getTime() - season.start.getTime()) / WEEK_MS) + 1);
}

function isWeekCalculationWindow(season, now) {
  if (!season || !season.start) return false;
  const elapsed = now.getTime() - season.start.getTime();
  if (elapsed <= 0) return false;
  const weekOffset = elapsed % WEEK_MS;
  return WEEK_CALC_START_MS < weekOffset && weekOffset < WEEK_MS;
}

function failedReward(errorCode) {
  return {
    errorCode,
    reward: null,
    rankReward: null,
    pvpData: null,
    reducedPvpData: null,
    isScoreChanged: false,
    changed: false,
  };
}

function failedAsyncReward(errorCode) {
  return {
    errorCode,
    reward: null,
    weekId: 0,
    pvpState: null,
    npcPvpData: null,
    changed: false,
  };
}

function getUsers(ctx, activeUser) {
  const users = ctx && ctx.userDb && ctx.userDb.users ? Object.values(ctx.userDb.users) : [];
  if (activeUser && !users.some((entry) => String(userUid(entry)) === String(userUid(activeUser)))) users.push(activeUser);
  return users.filter((entry) => entry && typeof entry === "object");
}

function getRegion(ctx, user) {
  const explicit = String(user && (user.region || user.countryTag || user.countryCode) || "").toUpperCase();
  if (REGIONS.has(explicit)) return explicit;
  const tags = ctx && typeof ctx.getEffectiveOpenTags === "function"
    ? ctx.getEffectiveOpenTags(user && user.openTags ? user.openTags : [])
    : user && user.openTags;
  return (Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").toUpperCase()).find((tag) => REGIONS.has(tag)) || "GLOBAL";
}

function selectRegionalRow(rows, region) {
  return rows.find((row) => normalizedTags(row && row.listContentsTagAllow).includes(region)) ||
    rows.find((row) => normalizedTags(row && row.listContentsTagAllow).includes("GLOBAL")) ||
    rows[0] || null;
}

function normalizedTags(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map((entry) => String(entry || "").toUpperCase());
}

function parseTableDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value || ""));
  return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])) : null;
}

function stateInt(data, camel, frozen) {
  return int(data[camel] != null ? data[camel] : data[frozen]);
}

function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function userUid(user) {
  try { return toBigInt(user && user.userUid != null ? user.userUid : 0); } catch (_) { return 0n; }
}

function compareUid(left, right) {
  const a = userUid(left);
  const b = userUid(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function lastLoginDate(user) {
  try { return toBigInt(user && user.lastLoginDateBinary != null ? user.lastLoginDateBinary : dateTimeBinaryNow()); }
  catch (_) { return dateTimeBinaryNow(); }
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function getNow(ctx) {
  return ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date();
}

function decrypt(ctx, payload) {
  const value = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.from(payload || []);
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function nullablePayload(value, builder) {
  return value == null ? writeNullObject() : writeNullableObject(builder(value));
}

function persistSuccess(ctx, result, label) {
  if (!result || !result.changed) return;
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
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

module.exports = {
  ALL_LIMIT,
  ERRORS,
  PACKETS,
  RANK_TYPES,
  TOP_LIMIT,
  buildAsyncRankListAckPayload,
  buildAsyncSeasonRewardAckPayload,
  buildAsyncWeekRewardAckPayload,
  buildNpcPvpData,
  buildPvpStateData,
  buildRankListAckPayload,
  buildSeasonRewardAckPayload,
  buildUserSimpleProfileData,
  buildWeekRewardAckPayload,
  claimSeasonReward,
  claimWeekReward,
  claimAsyncSeasonReward,
  claimAsyncWeekReward,
  createPvpRankHandlers,
  decodeEmptyRequest,
  decodeRankListRequest,
  getActiveSeason,
  getActiveAsyncSeason,
  getAsyncPvpState,
  getAsyncRankList,
  getAsyncSeasonById,
  getNpcPvpData,
  getPvpRankState,
  getRankList,
  getResetScore,
  getSeasonById,
  getSeasonRankReward,
  getTierByScore,
  getTierByTier,
  getWeekId,
  hasPvpRankState,
  hasAsyncPvpState,
  isRankPvpOpen,
  isWeekCalculationWindow,
  loadCatalog,
  normalizePvpState,
  rankUsers,
  rankAsyncUsers,
  setAsyncPvpState,
  setNpcPvpData,
  setPvpRankState,
};
