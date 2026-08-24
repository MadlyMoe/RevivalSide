"use strict";

const { buildAsyncDeckData } = require("../defence");
const {
  getPlayableShipIds,
  getPlayableUnitIds,
  getUnitTemplet,
  isCollectionVisibleUnitId,
} = require("../game-data");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { buildCommonProfileData, buildGuildSimpleData } = require("../leaderboard");
const {
  buildRewardData,
  readSignedVarInt,
  readSignedVarIntList,
  readSignedVarLong,
  readString,
  toBigInt,
  writeBool,
  writeFloatLE,
  writeIntList,
  writeLongArray,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeObjectMapInt,
  writeObjectMapLong,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");

const PACKETS = Object.freeze({
  INFO_NOT: 863,
  INFO_REQ: 864,
  INFO_ACK: 865,
  APPLY_REQ: 866,
  APPLY_ACK: 867,
  PRIVATE_INFO_REQ: 868,
  PRIVATE_INFO_ACK: 869,
  PREDICTION_REQ: 870,
  PREDICTION_ACK: 871,
  STATISTICS_REQ: 872,
  STATISTICS_ACK: 873,
  REWARD_REQ: 874,
  REWARD_ACK: 875,
  REPLAY_REQ: 876,
  REPLAY_ACK: 877,
  RANK_REQ: 878,
  RANK_ACK: 879,
  REWARD_INFO_REQ: 880,
  REWARD_INFO_ACK: 881,
  VOTE_UNIT_REQ: 2686,
  VOTE_UNIT_ACK: 2687,
  VOTE_SHIP_REQ: 2688,
  VOTE_SHIP_ACK: 2689,
});

const ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  INVALID_STATE: 26703,
  INVALID_DECK: 26704,
  ALREADY_REGISTERED: 26705,
  DECK_NOT_MODIFIED: 26707,
  INVALID_GROUP: 26708,
  INVALID_INDEX: 26709,
  INVALID_TEMPLET: 26710,
  INVALID_USER_UID: 26711,
  WRONG_SLOT_COUNT: 26712,
  REPLAY_NOT_EXIST: 26715,
  INVALID_ID: 26716,
  ALREADY_REWARDED: 26717,
  REWARD_RANK: 26719,
  REWARD_PREDICTION: 26720,
  INVALID_PREDICTION: 26721,
  NOT_PLAY: 26723,
  INVALID_SLOT_INDEX: 26724,
  VOTE_COUNT_ZERO: 26725,
  OUT_OF_BETTING_TIME: 26726,
  IS_NOT_ENABLE: 26728,
  CASTING_VOTE_INVALID_INTERVAL: 26729,
  DISABLE_CASTING_VOTE: 26730,
});

const STATE = Object.freeze({ ENDED: 0, PROGRESSING: 1, BAN_VOTE: 2, PRE_BOOKING: 10, TRYOUT: 20, FINAL_32: 30, FINAL_4: 40, CLOSING: 50 });
const GROUPS = new Set([1, 2, 3, 4, 5, 11, 12, 13, 14, 15]);
let catalog;
let eligibility;

function createTournamentHandlers() {
  return [
    handler(PACKETS.INFO_REQ, "TOURNAMENT_INFO_REQ", handleInfo),
    handler(PACKETS.APPLY_REQ, "TOURNAMENT_APPLY_REQ", handleApply),
    handler(PACKETS.PRIVATE_INFO_REQ, "TOURNAMENT_PREDICTION_PRIVATE_INFO_REQ", handlePrivateInfo),
    handler(PACKETS.PREDICTION_REQ, "TOURNAMENT_PREDICTION_REQ", handlePrediction),
    handler(PACKETS.STATISTICS_REQ, "TOURNAMENT_PREDICTION_STATISTICS_REQ", handleStatistics),
    handler(PACKETS.REWARD_REQ, "TOURNAMENT_REWARD_REQ", handleReward),
    handler(PACKETS.REPLAY_REQ, "TOURNAMENT_REPLAY_LINK_REQ", handleReplay),
    handler(PACKETS.RANK_REQ, "TOURNAMENT_RANK_REQ", handleRank),
    handler(PACKETS.REWARD_INFO_REQ, "TOURNAMENT_REWARD_INFO_REQ", handleRewardInfo),
    handler(PACKETS.VOTE_UNIT_REQ, "TOURNAMENT_CASTING_VOTE_UNIT_REQ", handleUnitVote),
    handler(PACKETS.VOTE_SHIP_REQ, "TOURNAMENT_CASTING_VOTE_SHIP_REQ", handleShipVote),
  ];
}

function handleInfo(ctx, socket, packet) {
  const valid = decodeEmpty(ctx, packet.payload);
  const tournament = valid ? getActiveTournament(ctx) : null;
  const errorCode = !valid ? ERRORS.INVALID_REQUEST : tournament ? ERRORS.OK : ERRORS.INVALID_TEMPLET;
  send(ctx, socket, packet, PACKETS.INFO_ACK, buildInfoAck(ctx, socketUser(ctx, socket), tournament, errorCode), "tournament-info");
  return true;
}

function handleApply(ctx, socket, packet) {
  const user = socketUser(ctx, socket);
  const tournament = getActiveTournament(ctx);
  const request = decodeDeckRequest(ctx, packet.payload);
  let errorCode = !request.valid ? ERRORS.INVALID_REQUEST : !tournament ? ERRORS.INVALID_TEMPLET : ERRORS.OK;
  if (errorCode === ERRORS.OK && getTournamentState(tournament, now(ctx)) !== STATE.PRE_BOOKING) errorCode = ERRORS.INVALID_STATE;
  if (errorCode === ERRORS.OK) errorCode = validateDeck(user, request.deck);
  let state = tournament ? getUserTournamentState(user, tournament, true) : null;
  let changed = false;
  if (errorCode === ERRORS.OK && state && sameDeck(state.deck, request.deck)) errorCode = ERRORS.DECK_NOT_MODIFIED;
  if (errorCode === ERRORS.OK) {
    state = getUserTournamentState(user, tournament, false);
    state.deck = request.deck;
    changed = true;
  }
  const deckPayload = tournament ? buildTournamentDeck(user, tournament) : buildAsyncDeckData({});
  send(ctx, socket, packet, PACKETS.APPLY_ACK, Buffer.concat([writeSignedVarInt(errorCode), writeNullableObject(deckPayload)]), "tournament-apply");
  persist(ctx, changed, "tournament-apply");
  return true;
}

function handlePrivateInfo(ctx, socket, packet) {
  const request = decodeExactInt(ctx, packet.payload);
  const tournament = request.valid ? getTournamentById(request.value) : null;
  const active = tournament && isTournamentActive(tournament, now(ctx));
  const errorCode = !request.valid ? ERRORS.INVALID_REQUEST : !active ? ERRORS.INVALID_TEMPLET : ERRORS.OK;
  const infos = errorCode === ERRORS.OK ? buildTournamentInfos(ctx, tournament) : [];
  send(ctx, socket, packet, PACKETS.PRIVATE_INFO_ACK, Buffer.concat([
    writeSignedVarInt(errorCode), writeNullableObjectList(infos.map(buildTournamentInfoData)),
  ]), "tournament-private-info");
  return true;
}

function handlePrediction(ctx, socket, packet) {
  const request = decodePrediction(ctx, packet.payload);
  const user = socketUser(ctx, socket);
  const tournament = request.valid ? getTournamentById(request.tournamentId) : null;
  let errorCode = !request.valid ? ERRORS.INVALID_REQUEST : !tournament || !isTournamentActive(tournament, now(ctx)) ? ERRORS.INVALID_TEMPLET : ERRORS.OK;
  if (errorCode === ERRORS.OK && !isBettingOpen(tournament, request.group, now(ctx))) errorCode = ERRORS.OUT_OF_BETTING_TIME;
  const info = errorCode === ERRORS.OK ? buildTournamentInfos(ctx, tournament).find((entry) => entry.groupIndex === request.group) : null;
  if (errorCode === ERRORS.OK && !info) errorCode = ERRORS.INVALID_GROUP;
  if (errorCode === ERRORS.OK && (request.userUids.length === 0 || request.userUids.some((uid) => !info.userInfo.has(String(uid))))) {
    errorCode = ERRORS.INVALID_USER_UID;
  }
  let state = tournament ? getUserTournamentState(user, tournament, true) : null;
  let changed = false;
  if (errorCode === ERRORS.OK) {
    state = getUserTournamentState(user, tournament, false);
    const key = String(request.group);
    if (!sameList(state.predictions[key], request.userUids)) {
      state.predictions[key] = request.userUids.map(String);
      changed = true;
    }
  }
  const responseInfo = info ? { ...info, slotUserUid: request.userUids.map(String) } : emptyTournamentInfo(request.group);
  send(ctx, socket, packet, PACKETS.PREDICTION_ACK, Buffer.concat([
    writeNullableObject(buildTournamentInfoData(responseInfo)),
    writeNullObject(),
    writeSignedVarInt(errorCode),
  ]), "tournament-prediction");
  persist(ctx, changed, "tournament-prediction");
  return true;
}

function handleStatistics(ctx, socket, packet) {
  const request = decodeTournamentGroup(ctx, packet.payload);
  const tournament = request.valid ? getTournamentById(request.tournamentId) : null;
  let errorCode = !request.valid ? ERRORS.INVALID_REQUEST : !tournament || !isTournamentActive(tournament, now(ctx)) ? ERRORS.INVALID_TEMPLET : ERRORS.OK;
  const info = errorCode === ERRORS.OK ? buildTournamentInfos(ctx, tournament).find((entry) => entry.groupIndex === request.group) : null;
  if (errorCode === ERRORS.OK && !info) errorCode = ERRORS.INVALID_GROUP;
  const statistics = info ? buildPredictionStatistics(ctx, tournament, info) : { values: [], profiles: [] };
  send(ctx, socket, packet, PACKETS.STATISTICS_ACK, Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(request.tournamentId || 0),
    writeSignedVarInt(request.group || 0),
    writeNullableObject(buildPredictionStatisticsData(statistics)),
  ]), "tournament-statistics");
  return true;
}

function handleReward(ctx, socket, packet) {
  const request = decodeExactInt(ctx, packet.payload);
  const user = socketUser(ctx, socket);
  const tournament = request.valid ? getTournamentById(request.value) : null;
  const result = claimTournamentReward(ctx, user, tournament);
  const errorCode = !request.valid ? ERRORS.INVALID_REQUEST : result.errorCode;
  send(ctx, socket, packet, PACKETS.REWARD_ACK, buildRewardResultPayload(tournament, { ...result, errorCode }), "tournament-reward");
  persist(ctx, result.changed, "tournament-reward");
  return true;
}

function handleReplay(ctx, socket, packet) {
  const request = decodeReplay(ctx, packet.payload);
  const tournament = request.valid ? getTournamentById(request.tournamentId) : null;
  const errorCode = !request.valid ? ERRORS.INVALID_REQUEST : !tournament ? ERRORS.INVALID_TEMPLET : ERRORS.REPLAY_NOT_EXIST;
  send(ctx, socket, packet, PACKETS.REPLAY_ACK, Buffer.concat([
    writeSignedVarInt(errorCode),
    writeNullableObject(buildReplayLinkData(request)),
  ]), "tournament-replay");
  return true;
}

function handleRank(ctx, socket, packet) {
  const valid = decodeEmpty(ctx, packet.payload);
  const tournament = valid ? getActiveTournament(ctx) : null;
  const errorCode = !valid ? ERRORS.INVALID_REQUEST : !tournament ? ERRORS.INVALID_TEMPLET : ERRORS.OK;
  const rank = tournament ? buildRankInfo(ctx, tournament) : null;
  send(ctx, socket, packet, PACKETS.RANK_ACK, Buffer.concat([
    writeSignedVarInt(errorCode),
    writeNullableObjectList(rank ? [buildTournamentRankInfoData(rank)] : []),
  ]), "tournament-rank");
  return true;
}

function handleRewardInfo(ctx, socket, packet) {
  const request = decodeExactInt(ctx, packet.payload);
  const user = socketUser(ctx, socket);
  const tournament = request.valid ? getTournamentById(request.value) : null;
  const result = tournament ? getTournamentRewardInfo(ctx, user, tournament) : { errorCode: ERRORS.INVALID_TEMPLET };
  send(ctx, socket, packet, PACKETS.REWARD_INFO_ACK, buildRewardResultPayload(tournament, {
    ...result,
    errorCode: request.valid ? result.errorCode : ERRORS.INVALID_REQUEST,
  }), "tournament-reward-info");
  return true;
}

function handleUnitVote(ctx, socket, packet) {
  return handleVote(ctx, socket, packet, "unitIdList", PACKETS.VOTE_UNIT_ACK, "tournament-unit-vote");
}

function handleShipVote(ctx, socket, packet) {
  return handleVote(ctx, socket, packet, "shipGroupIdList", PACKETS.VOTE_SHIP_ACK, "tournament-ship-vote");
}

function handleVote(ctx, socket, packet, field, ackId, label) {
  const request = decodeTournamentVote(ctx, packet.payload);
  const user = socketUser(ctx, socket);
  const tournament = request.valid ? getTournamentById(request.tournamentId) : null;
  let errorCode = !request.valid ? ERRORS.INVALID_REQUEST : !tournament ? ERRORS.INVALID_TEMPLET : ERRORS.OK;
  if (errorCode === ERRORS.OK && tournament.bUnitBan !== true) errorCode = ERRORS.DISABLE_CASTING_VOTE;
  if (errorCode === ERRORS.OK && !isIntervalActive(tournament.CastingBanInterval, now(ctx))) errorCode = ERRORS.CASTING_VOTE_INVALID_INTERVAL;
  if (errorCode === ERRORS.OK && request.ids.length === 0) errorCode = ERRORS.VOTE_COUNT_ZERO;
  if (errorCode === ERRORS.OK && (request.ids.length !== 3 || new Set(request.ids).size !== request.ids.length)) errorCode = ERRORS.INVALID_ID;
  const allowed = getVoteEligibility()[field];
  if (errorCode === ERRORS.OK && request.ids.some((id) => !allowed.has(id))) errorCode = ERRORS.INVALID_ID;
  let state = tournament ? getUserTournamentState(user, tournament, true) : null;
  let changed = false;
  if (errorCode === ERRORS.OK) {
    state = getUserTournamentState(user, tournament, false);
  }
  if (errorCode === ERRORS.OK && !sameList(state.votes[field], request.ids)) {
    state.votes[field] = request.ids.slice();
    changed = true;
  }
  send(ctx, socket, packet, ackId, Buffer.concat([
    writeSignedVarInt(errorCode),
    writeNullableObject(buildCastingVoteData(state && state.votes)),
  ]), label);
  persist(ctx, changed, label);
  return true;
}

function buildInfoAck(ctx, user, tournament, errorCode = ERRORS.OK) {
  const state = tournament ? getUserTournamentState(user, tournament, true) : null;
  const infos = tournament ? buildTournamentInfos(ctx, tournament) : [];
  const canRecvReward = Boolean(tournament && getTournamentState(tournament, now(ctx)) === STATE.CLOSING && state && state.deck && !state.rewardClaimed);
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(tournament ? int(tournament.TournamentID) : 0),
    writeSignedVarInt(tournament ? getTournamentState(tournament, now(ctx)) : STATE.ENDED),
    writeNullableObjectList([]),
    writeNullableObjectList(infos.map(buildTournamentInfoData)),
    writeBool(canRecvReward),
    writeNullableObject(tournament ? buildTournamentDeck(user, tournament) : buildAsyncDeckData({})),
    writeSignedVarLong(BigInt(tournament ? tournamentUsers(ctx, tournament).length : 0)),
    writeNullableObject(buildCastingVoteData(state && state.votes)),
    writeObjectMapInt(buildTournamentBanResults(ctx, tournament)),
  ]);
}

function buildTournamentInfoData(info) {
  return Buffer.concat([
    writeSignedVarInt(int(info.groupIndex)),
    writeObjectMapLong(Array.from(info.userInfo.entries()).map(([uid, profile]) => [uid, buildTournamentProfileData(profile)])),
    writeLongArray((info.slotUserUid || []).map(toBigInt)),
  ]);
}

function buildTournamentProfileData(user) {
  const source = user && user.user || user;
  const tournament = user && user.tournament || null;
  return Buffer.concat([
    writeSignedVarInt(2),
    writeNullableObject(buildCommonProfileData(source)),
    writeNullableObject(buildGuildSimpleData(source)),
    writeNullableObject(buildTournamentDeck(source, tournament)),
  ]);
}

function buildPredictionStatisticsData(data) {
  return Buffer.concat([
    writePrimitiveLongFloatMap(data.values),
    writeNullableObjectList(data.profiles.map(buildTournamentProfileData)),
  ]);
}

function buildTournamentRankInfoData(rank) {
  return Buffer.concat([
    writeSignedVarInt(rank.tournamentId),
    writeLongArray(rank.ranks.map(BigInt)),
    writeNullableObjectList(rank.profiles.map(buildTournamentProfileData)),
  ]);
}

function buildReplayLinkData(request = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(request.tournamentId)),
    writeSignedVarInt(int(request.group)),
    writeSignedVarInt(int(request.slotIndex)),
    writeNullableObject(Buffer.concat([writeString(""), writeString("")])),
  ]);
}

function buildRewardResultPayload(tournament, result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    writeSignedVarInt(tournament ? int(tournament.TournamentID) : 0),
    writeSignedVarInt(int(result.hitCount)),
    result.predictionReward ? writeNullableObject(buildRewardData(result.predictionReward)) : writeNullObject(),
    writeSignedVarInt(int(result.groupIndex)),
    writeSignedVarInt(int(result.winData)),
    result.rankReward ? writeNullableObject(buildRewardData(result.rankReward)) : writeNullObject(),
  ]);
}

function buildCastingVoteData(value) {
  const data = value && typeof value === "object" ? value : {};
  return Buffer.concat([
    writeIntList(ids(data.unitIdList)),
    writeIntList(ids(data.shipGroupIdList)),
    writeIntList([]),
  ]);
}

function buildTournamentInfos(ctx, tournament) {
  if (!tournament) return [];
  const users = tournamentUsers(ctx, tournament);
  const state = getTournamentState(tournament, now(ctx));
  const globalOffset = tournament.bUnify === true ? 10 : 0;
  if (state >= STATE.FINAL_4) return [makeTournamentInfo(5 + globalOffset, users.slice(0, 4), tournament)];
  const groups = [[], [], [], []];
  users.forEach((user, index) => groups[index % 4].push(user));
  return groups.map((group, index) => makeTournamentInfo(index + 1 + globalOffset, group, tournament));
}

function makeTournamentInfo(groupIndex, users, tournament) {
  return {
    groupIndex,
    userInfo: new Map(users.map((user) => [String(user.userUid), { user, tournament }])),
    slotUserUid: users.map((user) => String(user.userUid)),
  };
}

function emptyTournamentInfo(groupIndex = 0) {
  return { groupIndex, userInfo: new Map(), slotUserUid: [] };
}

function buildPredictionStatistics(ctx, tournament, info) {
  const counts = new Map();
  let total = 0;
  for (const user of allUsers(ctx)) {
    const state = getUserTournamentState(user, tournament, true);
    for (const uid of state && state.predictions[String(info.groupIndex)] || []) {
      counts.set(String(uid), (counts.get(String(uid)) || 0) + 1);
      total += 1;
    }
  }
  return {
    values: Array.from(info.userInfo.keys()).map((uid) => [uid, total ? (counts.get(uid) || 0) / total : 0]),
    profiles: Array.from(info.userInfo.values()),
  };
}

function buildRankInfo(ctx, tournament) {
  const users = tournamentUsers(ctx, tournament);
  return {
    tournamentId: int(tournament.TournamentID),
    ranks: users.map((_, index) => index + 1),
    profiles: users.map((user) => ({ user, tournament })),
  };
}

function getTournamentRewardInfo(ctx, user, tournament) {
  if (!tournament || !isTournamentActive(tournament, now(ctx))) return { errorCode: ERRORS.INVALID_TEMPLET };
  const state = getUserTournamentState(user, tournament, true);
  if (!state || !state.deck) return { errorCode: ERRORS.NOT_PLAY };
  const users = tournamentUsers(ctx, tournament);
  const rank = Math.max(1, users.findIndex((entry) => String(entry.userUid) === String(user.userUid)) + 1);
  const row = selectRankRewardRow(tournament, rank);
  return {
    errorCode: ERRORS.OK,
    hitCount: 0,
    predictionReward: null,
    groupIndex: tournament.bUnify === true ? 15 : 5,
    winData: Math.max(0, users.length - rank),
    rankReward: row ? previewReward(row) : null,
    rankRow: row,
  };
}

function claimTournamentReward(ctx, user, tournament) {
  const info = getTournamentRewardInfo(ctx, user, tournament);
  if (info.errorCode !== ERRORS.OK) return { ...info, changed: false };
  if (getTournamentState(tournament, now(ctx)) !== STATE.CLOSING) return { ...info, errorCode: ERRORS.INVALID_STATE, changed: false };
  const state = getUserTournamentState(user, tournament, false);
  if (state.rewardClaimed) return { ...info, errorCode: ERRORS.ALREADY_REWARDED, changed: false };
  const rankReward = info.rankRow ? grantRow(ctx, user, info.rankRow) : null;
  state.rewardClaimed = true;
  return { ...info, rankReward, changed: true };
}

function selectRankRewardRow(tournament, rank) {
  const rows = loadCatalog().rankRewards.filter((row) => int(row.RankRewardGroupID) === int(tournament.ResultRewardGroupID));
  return rows.find((row) => String(row.RankRewardType) === "RANK" && int(row.RankValue) === rank)
    || rows.filter((row) => String(row.RankRewardType) === "COUNT").sort((a, b) => int(a.GroupMatchCount) - int(b.GroupMatchCount))[0]
    || null;
}

function previewReward(row) {
  const reward = createEmptyReward();
  for (let index = 1; index <= 5; index += 1) {
    if (String(row[`RewardType_${index}`] || "") !== "RT_MISC") continue;
    const itemId = int(row[`RewardID_${index}`]);
    const count = int(row[`RewardValue_${index}`]);
    if (itemId > 0 && count > 0) reward.miscItems.push({ itemId, countFree: String(count), countPaid: "0", bonusRatio: 0, regDate: "0" });
  }
  return reward;
}

function grantRow(ctx, user, row) {
  const reward = createEmptyReward();
  for (let index = 1; index <= 5; index += 1) {
    const type = String(row[`RewardType_${index}`] || "");
    const itemId = int(row[`RewardID_${index}`]);
    const count = int(row[`RewardValue_${index}`]);
    if (type && itemId > 0 && count > 0) mergeReward(reward, grantRewardByType(ctx, user, type, itemId, count));
  }
  return reward;
}

function buildTournamentBanResults(ctx, tournament) {
  if (!tournament || tournament.bUnitBan !== true) return [];
  const unitCounts = new Map();
  const shipCounts = new Map();
  for (const user of allUsers(ctx)) {
    const state = getUserTournamentState(user, tournament, true);
    for (const id of state && state.votes.unitIdList || []) unitCounts.set(id, (unitCounts.get(id) || 0) + 1);
    for (const id of state && state.votes.shipGroupIdList || []) shipCounts.set(id, (shipCounts.get(id) || 0) + 1);
  }
  const top = (counts, limit) => Array.from(counts).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit).map(([id]) => id);
  const result = Buffer.concat([writeIntList(top(unitCounts, int(tournament.UnitBanCount))), writeIntList(top(shipCounts, int(tournament.ShipBanCount)))]);
  return [[2, result]];
}

function getTournamentState(tournament, date) {
  if (!tournament || !isTournamentActive(tournament, date)) return STATE.ENDED;
  if (isIntervalActive(tournament.CastingBanInterval, date)) return STATE.BAN_VOTE;
  if (isIntervalActive(tournament.DeckEnterInterval, date)) return STATE.PRE_BOOKING;
  if (isIntervalActive(tournament.QualifyInterval, date)) return STATE.TRYOUT;
  if (isIntervalActive(tournament.GroupRoundInterval, date)) return STATE.FINAL_32;
  if (isIntervalActive(tournament.FinalRoundInterval, date)) return STATE.FINAL_4;
  if (isIntervalActive(tournament.RewardInterval, date)) return STATE.CLOSING;
  return STATE.PROGRESSING;
}

function isBettingOpen(tournament, group, date) {
  const base = group > 10 ? group - 10 : group;
  if (base >= 1 && base <= 4) return isIntervalActive(tournament[`GroupBettingInterval_0${base}`], date);
  if (base === 5) return isIntervalActive(tournament.FinalBettingInterval, date);
  return false;
}

function getActiveTournament(ctx) {
  const date = now(ctx);
  const tags = ctx && typeof ctx.getEffectiveOpenTags === "function" ? ctx.getEffectiveOpenTags([]) : [];
  return loadCatalog().tournaments.find((entry) => isTournamentActive(entry, date) && (!entry.OpenTag || !tags.length || tags.includes(entry.OpenTag))) || null;
}

function getTournamentById(id) {
  return loadCatalog().byId.get(int(id)) || null;
}

function isTournamentActive(tournament, date) {
  return Boolean(tournament && isIntervalActive(tournament.TournamentInterval, date));
}

function isIntervalActive(key, date) {
  const interval = loadCatalog().intervals.get(String(key || ""));
  if (!interval) return false;
  const time = nowDate(date).getTime();
  const start = tableDate(interval.m_DateStart);
  const end = tableDate(interval.m_DateEnd);
  return Boolean(start && end && time >= start.getTime() && time < end.getTime());
}

function loadCatalog() {
  if (catalog) return catalog;
  const tournaments = readGameplayTableRecords("ab_script", "LUA_TOURNAMENT_TEMPLET.json").filter((row) => int(row.TournamentID) > 0);
  const intervals = new Map(readGameplayTableRecords("ab_script", "LUA_INTERVAL_TEMPLET.json").map((row) => [String(row.m_DateStrID || ""), row]));
  const rankRewards = readGameplayTableRecords("ab_script", "LUA_TOURNAMENT_RANK_REWARD.json");
  const predictRewards = readGameplayTableRecords("ab_script", "LUA_TOURNAMENT_PREDICT_REWARD.json");
  catalog = { tournaments, intervals, rankRewards, predictRewards, byId: new Map(tournaments.map((row) => [int(row.TournamentID), row])) };
  return catalog;
}

function getUserTournamentState(user, tournament, readOnly) {
  if (!user || !tournament) return null;
  const source = user.tournament && typeof user.tournament === "object" ? user.tournament : {};
  const key = String(tournament.TournamentID);
  const existing = source[key];
  if (existing && typeof existing === "object") {
    return readOnly ? normalizedStateCopy(existing) : normalizeState(existing);
  }
  if (readOnly) return null;
  if (!user.tournament || typeof user.tournament !== "object") user.tournament = {};
  user.tournament[key] = normalizeState(null);
  return user.tournament[key];
}

function normalizedStateCopy(value) {
  return {
    ...value,
    predictions: value.predictions && typeof value.predictions === "object" ? { ...value.predictions } : {},
    votes: {
      unitIdList: ids(value.votes && value.votes.unitIdList),
      shipGroupIdList: ids(value.votes && value.votes.shipGroupIdList),
    },
    rewardClaimed: value.rewardClaimed === true,
  };
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  if (!state.predictions || typeof state.predictions !== "object") state.predictions = {};
  if (!state.votes || typeof state.votes !== "object") state.votes = {};
  state.votes = { unitIdList: ids(state.votes.unitIdList), shipGroupIdList: ids(state.votes.shipGroupIdList) };
  state.rewardClaimed = state.rewardClaimed === true;
  return state;
}

function tournamentUsers(ctx, tournament) {
  return allUsers(ctx)
    .filter((user) => getUserTournamentState(user, tournament, true)?.deck)
    .sort((left, right) => deckPower(right, tournament) - deckPower(left, tournament) || compareUid(left.userUid, right.userUid));
}

function allUsers(ctx) {
  const users = ctx && ctx.userDb && ctx.userDb.users;
  return users && typeof users === "object" ? Object.values(users).filter(Boolean) : [];
}

function deckPower(user, tournament) {
  const deck = getUserTournamentState(user, tournament, true)?.deck;
  const units = user && user.army && user.army.units || {};
  return (deck && deck.unitUids || []).reduce((sum, uid) => sum + Math.max(1, int(units[String(uid)]?.level)) * 1000, 0);
}

function buildTournamentDeck(user, tournament) {
  const state = tournament ? getUserTournamentState(user, tournament, true) : null;
  if (tournament) {
    return buildAsyncDeckData(state && state.deck ? { ...user, defenceDeck: state.deck } : {});
  }
  return buildAsyncDeckData(user || {});
}

function validateDeck(user, deck) {
  if (!user || !deck) return ERRORS.INVALID_DECK;
  if (deck.unitUids.length !== 8 || deck.unitUids.some((uid) => uid === "0")) return ERRORS.WRONG_SLOT_COUNT;
  const army = user.army || {};
  const units = army.units || {};
  const ships = army.ships || {};
  const operators = army.operators || {};
  if (!ships[String(deck.shipUid)] || (deck.operatorUid !== "0" && !operators[String(deck.operatorUid)])) return ERRORS.INVALID_DECK;
  if (deck.unitUids.some((uid) => !units[String(uid)])) return ERRORS.INVALID_DECK;
  if (new Set(deck.unitUids.map(String)).size !== deck.unitUids.length) return ERRORS.INVALID_DECK;
  if (deck.leaderIndex < 0 || deck.leaderIndex >= deck.unitUids.length || deck.state !== 0) return ERRORS.INVALID_DECK;
  return ERRORS.OK;
}

function decodeDeckRequest(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    let offset = 0;
    if (payload[offset++] !== 1) return { valid: false };
    const name = readString(payload, offset); offset = name.offset;
    const ship = readSignedVarLong(payload, offset); offset = ship.offset;
    const operator = readSignedVarLong(payload, offset); offset = operator.offset;
    const count = readUnsigned(payload, offset); offset = count.offset;
    if (count.value > 8) return { valid: false };
    const unitUids = [];
    for (let index = 0; index < count.value; index += 1) {
      const unit = readSignedVarLong(payload, offset); offset = unit.offset; unitUids.push(String(unit.value));
    }
    const leader = readSignedVarInt(payload, offset); offset = leader.offset;
    const state = readSignedVarInt(payload, offset); offset = state.offset;
    const deck = { name: name.value || "", shipUid: String(ship.value), operatorUid: String(operator.value), unitUids, leaderIndex: leader.value, state: state.value };
    return { valid: offset === payload.length && encodeDeckRequest(deck).equals(payload), deck };
  } catch (_) { return { valid: false }; }
}

function decodePrediction(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    let offset = 0;
    const id = readSignedVarInt(payload, offset); offset = id.offset;
    const group = readSignedVarInt(payload, offset); offset = group.offset;
    const list = readLongList(payload, offset); offset = list.offset;
    const canonical = Buffer.concat([writeSignedVarInt(id.value), writeSignedVarInt(group.value), writeLongList(list.value)]);
    return { valid: offset === payload.length && canonical.equals(payload) && id.value > 0 && GROUPS.has(group.value), tournamentId: id.value, group: group.value, userUids: list.value.map(String) };
  } catch (_) { return { valid: false, tournamentId: 0, group: 0, userUids: [] }; }
}

function decodeTournamentGroup(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    const id = readSignedVarInt(payload, 0);
    const group = readSignedVarInt(payload, id.offset);
    const canonical = Buffer.concat([writeSignedVarInt(id.value), writeSignedVarInt(group.value)]);
    return { valid: group.offset === payload.length && canonical.equals(payload) && id.value > 0 && GROUPS.has(group.value), tournamentId: id.value, group: group.value };
  } catch (_) { return { valid: false, tournamentId: 0, group: 0 }; }
}

function decodeReplay(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    const id = readSignedVarInt(payload, 0);
    const group = readSignedVarInt(payload, id.offset);
    const slot = readSignedVarInt(payload, group.offset);
    const canonical = Buffer.concat([writeSignedVarInt(id.value), writeSignedVarInt(group.value), writeSignedVarInt(slot.value)]);
    return { valid: slot.offset === payload.length && canonical.equals(payload) && id.value > 0 && GROUPS.has(group.value) && slot.value >= 0, tournamentId: id.value, group: group.value, slotIndex: slot.value };
  } catch (_) { return { valid: false, tournamentId: 0, group: 0, slotIndex: 0 }; }
}

function decodeTournamentVote(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    const id = readSignedVarInt(payload, 0);
    const list = readSignedVarIntList(payload, id.offset);
    const canonical = Buffer.concat([writeSignedVarInt(id.value), writeIntList(list.value)]);
    return { valid: list.offset === payload.length && canonical.equals(payload) && id.value > 0, tournamentId: id.value, ids: list.value };
  } catch (_) { return { valid: false, tournamentId: 0, ids: [] }; }
}

function decodeExactInt(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    const value = readSignedVarInt(payload, 0);
    return { valid: value.offset === payload.length && writeSignedVarInt(value.value).equals(payload) && value.value > 0, value: value.value };
  } catch (_) { return { valid: false, value: 0 }; }
}

function decodeEmpty(ctx, encrypted) {
  try { return decrypt(ctx, encrypted).length === 0; }
  catch (_) { return false; }
}

function getVoteEligibility() {
  if (eligibility) return eligibility;
  const unitIdList = new Set(getPlayableUnitIds({ includeNonContractable: true }).filter(isCollectionVisibleUnitId));
  const shipGroupIdList = new Set();
  for (const shipId of getPlayableShipIds({ includeNonContractable: true })) {
    const template = getUnitTemplet(shipId);
    const groupId = int(template && template.m_ShipGroupID);
    if (groupId && isCollectionVisibleUnitId(shipId) && ["NUG_SSR", "NUG_AWAKEN"].includes(String(template.m_NKM_UNIT_GRADE || ""))) shipGroupIdList.add(groupId);
  }
  eligibility = { unitIdList, shipGroupIdList };
  return eligibility;
}

function encodeDeckRequest(deck) {
  const units = Array.isArray(deck.unitUids) ? deck.unitUids : [];
  return Buffer.concat([
    Buffer.from([1]),
    writeString(deck.name || ""),
    writeSignedVarLong(toBigInt(deck.shipUid)),
    writeSignedVarLong(toBigInt(deck.operatorUid)),
    writeLongList(units.map(toBigInt)),
    writeSignedVarInt(int(deck.leaderIndex)),
    writeSignedVarInt(int(deck.state)),
  ]);
}

function writeLongList(values) {
  return Buffer.concat([writeUnsigned(values.length), ...values.map(writeSignedVarLong)]);
}

function readLongList(buffer, offset) {
  const count = readUnsigned(buffer, offset);
  offset = count.offset;
  const value = [];
  if (count.value > 64) throw new Error("too many tournament UIDs");
  for (let index = 0; index < count.value; index += 1) {
    const entry = readSignedVarLong(buffer, offset); offset = entry.offset; value.push(entry.value);
  }
  return { value, offset };
}

function readUnsigned(buffer, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (shift < 35) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function writePrimitiveLongFloatMap(entries) {
  return Buffer.concat([writeUnsigned(entries.length), ...entries.flatMap(([key, value]) => [writeSignedVarLong(toBigInt(key)), writeFloatLE(value)])]);
}

function writeUnsigned(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) { bytes.push((current & 0x7f) | 0x80); current >>>= 7; }
  bytes.push(current);
  return Buffer.from(bytes);
}

function tableDate(value) {
  const normalized = String(value || "").replace(/\.(\d{3})\d*$/, ".$1Z");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function now(ctx) {
  return nowDate(ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date());
}

function nowDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function handler(packetId, name, handle) { return { packetId, name, handle }; }
function decrypt(ctx, payload) { return Buffer.from(ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : payload || []); }
function socketUser(ctx, socket) { return socket?.session?.user || (ctx.createEphemeralUser ? ctx.createEphemeralUser() : {}); }
function send(ctx, socket, packet, packetId, payload, label) { ctx.sendGameResponse(socket, packet, packetId, payload, label); }
function persist(ctx, changed, label) {
  if (!changed) return;
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}
function ids(value) { return (Array.isArray(value) ? value : []).map(int).filter((entry) => entry > 0); }
function int(value) { const number = Number(value); return Number.isFinite(number) ? Math.trunc(number) : 0; }
function sameList(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => String(value) === String(right[index])); }
function sameDeck(left, right) { return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right)); }
function compareUid(left, right) { const a = toBigInt(left || 0); const b = toBigInt(right || 0); return a === b ? 0 : a < b ? -1 : 1; }

module.exports = {
  ERRORS,
  GROUPS,
  PACKETS,
  STATE,
  buildInfoAck,
  buildTournamentBanResults,
  buildTournamentInfos,
  createTournamentHandlers,
  decodeDeckRequest,
  getActiveTournament,
  getTournamentById,
  getTournamentState,
  getUserTournamentState,
  isIntervalActive,
  loadCatalog,
  validateDeck,
};
