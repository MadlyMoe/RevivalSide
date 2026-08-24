"use strict";

const { buildCommonProfileData, buildGuildSimpleData } = require("../leaderboard");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const {
  buildRewardData,
  buildEquipItemData,
  buildOperatorData,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  toBigInt,
  writeIntList,
  writeLongArray,
  writeBool,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeObjectMapInt,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");

const DEFENCE_PROFILE_ACK = 3910;
const DEFENCE_INFO_ACK = 3905;
const DEFENCE_RANK_REWARD_ACK = 3908;
const DEFENCE_SCORE_REWARD_ACK = 3912;
const DEFENCE_SCORE_REWARD_ALL_ACK = 3914;
const INVALID_TEMPLET = 25900;
const PROFILE_NOT_EXISTS = 25909;
const RANK_REWARD_ALREADY_GIVEN = 25913;
const RANK_HAVE_NOT_REWARD_TEMPLET = 25914;
const SCORE_REWARD_ALREADY_GIVEN = 25915;
const SCORE_REWARD_MAKE_FAIL = 25916;
const INVALID_SCORE_REWARD_TEMPLET = 25917;
const REWARD_COUNT_ZERO = 25918;

let cachedDefenceCatalog = null;

function createDefenceHandlers() {
  return [
    createDefenceInfoHandler(),
    createDefenceRankRewardHandler(),
    createDefenceProfileHandler(),
    createDefenceScoreRewardHandler(),
    createDefenceScoreRewardAllHandler(),
  ];
}

function createDefenceInfoHandler() {
  return createHandler(3904, "DEFENCE_INFO_REQ", DEFENCE_INFO_ACK, (ctx, socket, packet) => {
    const req = decodeExactInt(ctx, packet.payload || Buffer.alloc(0), "defenceTempletId");
    if (req.valid && socket && socket.session) socket.session.defenceTempletId = req.defenceTempletId;
    return buildDefenceInfoAck(ctx, socket && socket.session && socket.session.user, req);
  });
}

function createDefenceRankRewardHandler() {
  return createHandler(3907, "DEFENCE_RANK_REWARD_REQ", DEFENCE_RANK_REWARD_ACK, (ctx, socket, packet) => {
    const valid = decodeExactEmpty(ctx, packet.payload || Buffer.alloc(0));
    return claimDefenceRankReward(ctx, socket, valid);
  });
}

function createDefenceScoreRewardHandler() {
  return createHandler(3911, "DEFENCE_SCORE_REWARD_REQ", DEFENCE_SCORE_REWARD_ACK, (ctx, socket, packet) => {
    const req = decodeExactInt(ctx, packet.payload || Buffer.alloc(0), "scoreRewardId");
    return claimDefenceScoreReward(ctx, socket, req);
  });
}

function createDefenceScoreRewardAllHandler() {
  return createHandler(3913, "DEFENCE_SCORE_REWARD_ALL_REQ", DEFENCE_SCORE_REWARD_ALL_ACK, (ctx, socket, packet) => {
    const valid = decodeExactEmpty(ctx, packet.payload || Buffer.alloc(0));
    return claimAllDefenceScoreRewards(ctx, socket, valid);
  });
}

function createHandler(packetId, name, ackPacketId, build) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      const response = build(ctx, socket, packet);
      ctx.sendResponse(socket, packet.sequence, ackPacketId, () =>
        ctx.buildEncryptedPacket(packet.sequence, ackPacketId, response.payload)
      );
      if (response.persist) persist(ctx);
      console.log(`[defence:${name}] ACK packetId=${ackPacketId} errorCode=${response.errorCode}`);
      return true;
    },
  };
}

function createDefenceProfileHandler() {
  return {
    packetId: 3909,
    name: "DEFENCE_PROFILE_REQ",
    handle(ctx, socket, packet) {
      const req = decodeDefenceProfileRequest(ctx, packet.payload || Buffer.alloc(0));
      const response = buildDefenceProfileAck(ctx, req);
      ctx.sendResponse(socket, packet.sequence, DEFENCE_PROFILE_ACK, () =>
        ctx.buildEncryptedPacket(packet.sequence, DEFENCE_PROFILE_ACK, response.payload)
      );
      console.log(`[defence:DEFENCE_PROFILE_REQ] ACK packetId=${DEFENCE_PROFILE_ACK} errorCode=${response.errorCode}`);
      return true;
    },
  };
}

function decodeDefenceProfileRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx.decryptCopy(encryptedPayload);
    const uid = readSignedVarLong(payload, 0);
    if (uid.offset + 1 !== payload.length || payload[uid.offset] > 1) return { valid: false };
    return { valid: true, userUid: uid.value, isForce: readBool(payload, uid.offset).value };
  } catch (_) {
    return { valid: false };
  }
}

function buildDefenceProfileAck(ctx, req = {}) {
  const target = req.valid ? findUser(ctx, req.userUid) : null;
  const record = target ? getBestDefenceRecord(target) : null;
  if (!target || !record || record.bestScore <= 0) return failedProfileAck();

  const ranking = getDefenceRanking(ctx, record.defenceId);
  const rank = ranking.findIndex((entry) => userUid(entry.user) === userUid(target)) + 1;
  const rankPercent = rank > 0 ? Math.max(1, Math.ceil(rank * 100 / ranking.length)) : 0;
  return {
    errorCode: 0,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildCommonProfileData(target)),
      writeNullableObject(buildGuildSimpleData(target)),
      writeString(target.friendIntro || ""),
      writeNullableObject(buildDefenceProfileData(target, record)),
      writeSignedVarInt(rank),
      writeSignedVarInt(rankPercent),
    ]),
  };
}

function failedProfileAck() {
  return {
    errorCode: PROFILE_NOT_EXISTS,
    payload: Buffer.concat([
      writeSignedVarInt(PROFILE_NOT_EXISTS),
      writeNullObject(),
      writeNullObject(),
      writeString(""),
      writeNullObject(),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
    ]),
  };
}

function buildDefenceInfoAck(ctx, user, req = {}) {
  const catalog = loadDefenceCatalog();
  const defence = req.valid ? catalog.defenceById.get(Number(req.defenceTempletId)) : null;
  if (!defence) {
    return {
      errorCode: INVALID_TEMPLET,
      payload: Buffer.concat([
        writeSignedVarInt(INVALID_TEMPLET),
        writeSignedVarInt(Number(req.defenceTempletId) || 0),
        writeSignedVarInt(0), writeBool(false), writeBool(false),
        writeSignedVarInt(0), writeSignedVarInt(0), writeBool(false),
        writeNullObject(), writeIntList([]),
      ]),
    };
  }
  const record = findDefenceRecord(user, defence.id) || emptyDefenceRecord(defence.id);
  const ranking = getDefenceRanking(ctx, defence.id);
  const rank = ranking.findIndex((entry) => userUid(entry.user) === userUid(user)) + 1;
  const rankPercent = rank > 0 ? Math.max(1, Math.ceil(rank * 100 / ranking.length)) : 0;
  const top = ranking[0] || null;
  const claimedScoreIds = getClaimedScoreRewardIds(record);
  const rankRows = catalog.rankRewardsByGroup.get(defence.rankRewardGroupId) || [];
  const canReceiveRankReward = rank > 0 && rankRows.length > 0 && !Boolean(record.rankRewardClaimed);
  return {
    errorCode: 0,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(defence.id),
      writeSignedVarInt(record.bestScore),
      writeBool(Boolean(record.missionResult1)),
      writeBool(Boolean(record.missionResult2)),
      writeSignedVarInt(rank),
      writeSignedVarInt(rankPercent),
      writeBool(canReceiveRankReward),
      top ? writeNullableObject(buildDefenceRankData(top.user, top.record.bestScore)) : writeNullObject(),
      writeIntList(claimedScoreIds),
    ]),
  };
}

function claimDefenceRankReward(ctx, socket, valid) {
  const user = socket && socket.session && socket.session.user;
  const defenceId = Number(socket && socket.session && socket.session.defenceTempletId) || getBestDefenceRecord(user)?.defenceId || 0;
  const catalog = loadDefenceCatalog();
  const defence = valid ? catalog.defenceById.get(defenceId) : null;
  const record = defence ? findDefenceRecord(user, defenceId) : null;
  if (!defence || !record || record.bestScore <= 0) return rankRewardAck(RANK_HAVE_NOT_REWARD_TEMPLET);
  if (record.rankRewardClaimed) return rankRewardAck(RANK_REWARD_ALREADY_GIVEN);
  const ranking = getDefenceRanking(ctx, defenceId);
  const rank = ranking.findIndex((entry) => userUid(entry.user) === userUid(user)) + 1;
  const rankPercent = rank > 0 ? Math.max(1, Math.ceil(rank * 100 / ranking.length)) : 0;
  const rows = catalog.rankRewardsByGroup.get(defence.rankRewardGroupId) || [];
  const row = rows.find((entry) => !entry.percentCheck && rank > 0 && rank <= entry.rankValue)
    || rows.find((entry) => entry.percentCheck && rankPercent > 0 && rankPercent <= entry.rankValue);
  if (!row) return rankRewardAck(RANK_HAVE_NOT_REWARD_TEMPLET);
  const reward = grantInlineRewards(ctx, user, row.raw, "RankReward");
  (record.source || record).rankRewardClaimed = true;
  return rankRewardAck(0, reward, true);
}

function rankRewardAck(errorCode, reward = null, persistState = false) {
  return {
    errorCode,
    persist: persistState,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      reward ? writeNullableObject(buildRewardData(reward)) : writeNullObject(),
    ]),
  };
}

function claimDefenceScoreReward(ctx, socket, req = {}) {
  const user = socket && socket.session && socket.session.user;
  const catalog = loadDefenceCatalog();
  const row = req.valid ? catalog.scoreRewardById.get(Number(req.scoreRewardId)) : null;
  if (!row) return scoreRewardAck(INVALID_SCORE_REWARD_TEMPLET, Number(req.scoreRewardId) || 0);
  const defence = findDefenceForScoreGroup(catalog, row.groupId, socket);
  const record = defence ? findDefenceRecord(user, defence.id) : null;
  if (!defence || !record || record.bestScore < row.score) return scoreRewardAck(SCORE_REWARD_MAKE_FAIL, row.id);
  const claimed = getClaimedScoreRewardIds(record);
  if (claimed.includes(row.id)) return scoreRewardAck(SCORE_REWARD_ALREADY_GIVEN, row.id);
  const reward = grantInlineRewards(ctx, user, row.raw, "ScoreReward");
  (record.source || record).scoreRewardIds = [...claimed, row.id].sort((left, right) => left - right);
  return scoreRewardAck(0, row.id, reward, true);
}

function scoreRewardAck(errorCode, scoreRewardId, reward = null, persistState = false) {
  return {
    errorCode,
    persist: persistState,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      reward ? writeNullableObject(buildRewardData(reward)) : writeNullObject(),
      writeSignedVarInt(Number(scoreRewardId) || 0),
    ]),
  };
}

function claimAllDefenceScoreRewards(ctx, socket, valid) {
  const user = socket && socket.session && socket.session.user;
  const catalog = loadDefenceCatalog();
  const requestedId = Number(socket && socket.session && socket.session.defenceTempletId) || getBestDefenceRecord(user)?.defenceId || 0;
  const defence = valid ? catalog.defenceById.get(requestedId) : null;
  const record = defence ? findDefenceRecord(user, defence.id) : null;
  const claimed = record ? getClaimedScoreRewardIds(record) : [];
  const rows = defence ? catalog.scoreRewardsByGroup.get(defence.scoreRewardGroupId) || [] : [];
  const eligible = record ? rows.filter((row) => record.bestScore >= row.score && !claimed.includes(row.id)) : [];
  if (!eligible.length) return allScoreRewardAck(REWARD_COUNT_ZERO);
  const reward = createEmptyReward();
  for (const row of eligible) mergeReward(reward, grantInlineRewards(ctx, user, row.raw, "ScoreReward"));
  const ids = eligible.map((row) => row.id);
  (record.source || record).scoreRewardIds = [...claimed, ...ids].sort((left, right) => left - right);
  return allScoreRewardAck(0, ids, reward, true);
}

function allScoreRewardAck(errorCode, ids = [], reward = null, persistState = false) {
  return {
    errorCode,
    persist: persistState,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeIntList(ids),
      reward ? writeNullableObject(buildRewardData(reward)) : writeNullObject(),
    ]),
  };
}

function grantInlineRewards(ctx, user, row, prefix) {
  const reward = createEmptyReward();
  for (let index = 1; index <= 8; index += 1) {
    const type = String(row && row[`${prefix}Type_${index}`] || "");
    const id = Math.max(0, Number(row && row[`${prefix}ID_${index}`]) || 0);
    const quantity = Math.max(0, Number(row && row[`${prefix}Quantity_${index}`]) || 0);
    if (!type || type === "RT_NONE" || !id || !quantity) continue;
    mergeReward(reward, grantRewardByType(ctx, user, type, id, quantity, quantity, 0, { expandPackages: false }));
  }
  return reward;
}

function buildDefenceRankData(user, bestScore) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeSignedVarInt(Math.max(0, Number(bestScore) || 0)),
    writeNullableObject(buildGuildSimpleData(user)),
  ]);
}

function decodeExactInt(ctx, encryptedPayload, fieldName) {
  try {
    const payload = ctx.decryptCopy(encryptedPayload);
    const value = readSignedVarInt(payload, 0);
    return value.offset === payload.length ? { valid: true, [fieldName]: value.value } : { valid: false };
  } catch (_) {
    return { valid: false };
  }
}

function decodeExactEmpty(ctx, encryptedPayload) {
  try {
    return ctx.decryptCopy(encryptedPayload).length === 0;
  } catch (_) {
    return false;
  }
}

function persist(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache("defence-reward");
}

function buildDefenceProfileData(user, record) {
  return Buffer.concat([
    writeSignedVarInt(record.defenceId),
    writeSignedVarInt(record.bestScore),
    writeNullableObject(buildAsyncDeckData(user)),
    writeNullableObjectList((user.profileEmblems || []).map((emblem) => Buffer.concat([
      writeSignedVarInt(Number(emblem && (emblem.id || emblem.itemId)) || 0),
      writeSignedVarLong(toBigInt(emblem && emblem.count != null ? emblem.count : 0)),
    ]))),
  ]);
}

function buildAsyncDeckData(user) {
  const army = user && user.army && typeof user.army === "object" ? user.army : {};
  const deck = findProfileDeck(user, army) || {};
  const unitsByUid = army.units && typeof army.units === "object" ? army.units : {};
  const shipsByUid = army.ships && typeof army.ships === "object" ? army.ships : {};
  const ship = findOwned(shipsByUid, deck.shipUid);
  const operator = findOwned(army.operators, deck.operatorUid);
  const units = (Array.isArray(deck.unitUids) ? deck.unitUids : [])
    .map((uid) => findOwned(unitsByUid, uid))
    .filter(Boolean);
  const equipsByUid = user && user.inventory && user.inventory.equips && typeof user.inventory.equips === "object"
    ? user.inventory.equips
    : {};
  const equipUids = new Set(units.flatMap((unit) => Array.isArray(unit.equipItemUids) ? unit.equipItemUids.map(String) : []));
  const equips = Array.from(equipUids).map((uid) => findOwned(equipsByUid, uid)).filter(Boolean);
  const operationPower = Math.max(0, Number(deck.operationPower || user.defenceOperationPower || 0) || 0)
    || units.reduce((sum, unit) => sum + Math.max(1, Number(unit.level || 1) || 1) * 1000, 0);
  return Buffer.concat([
    writeSignedVarInt(Number(deck.leaderIndex != null ? deck.leaderIndex : -1)),
    writeNullableObject(buildAsyncUnitData(ship)),
    writeNullableObjectList(units.map(buildAsyncUnitData)),
    writeNullableObjectList(equips.map(buildEquipItemData)),
    writeSignedVarInt(operationPower),
    operator ? writeNullableObject(buildOperatorData(operator)) : writeNullObject(),
    writeNullableObject(buildAsyncUnitData(null)),
    writeObjectMapInt([]),
    writeObjectMapInt([]),
  ]);
}

function buildAsyncUnitData(unit) {
  const data = unit || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid || 0)),
    writeSignedVarInt(Number(data.unitId || data.id || 0) || 0),
    writeSignedVarInt(Number(data.level || data.unitLevel || 0) || 0),
    writeSignedVarInt(Number(data.skinId || 0) || 0),
    writeSignedVarInt(Number(data.limitBreakLevel || 0) || 0),
    writeIntList(Array.isArray(data.skillLevels) ? data.skillLevels : []),
    writeIntList(Array.isArray(data.statExp) ? data.statExp : []),
    writeLongArray(Array.isArray(data.equipItemUids) ? data.equipItemUids.map((uid) => toBigInt(uid || 0)) : []),
    writeObjectList([]),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function findProfileDeck(user, army) {
  const direct = user && (user.defenceDeck || user.profileDeck);
  if (direct && typeof direct === "object") return direct;
  const sets = army.deckSets && typeof army.deckSets === "object" ? army.deckSets : {};
  const index = user && (user.defenceDeckIndex || user.profileDeckIndex);
  if (index && sets[String(index.deckType)] && Array.isArray(sets[String(index.deckType)])) {
    const selected = sets[String(index.deckType)].find((deck) => Number(deck && deck.index) === Number(index.index || 0));
    if (selected) return selected;
  }
  for (const list of Object.values(sets)) {
    if (Array.isArray(list)) {
      const deck = list.find((entry) => entry && (entry.shipUid || (entry.unitUids || []).some(Boolean)));
      if (deck) return deck;
    }
  }
  return Array.isArray(army.decks) ? army.decks.find(Boolean) || null : null;
}

function loadDefenceCatalog() {
  if (cachedDefenceCatalog) return cachedDefenceCatalog;
  const defenceById = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_DEFENCE_TEMPLET.json", { optional: true })) {
    const id = Math.max(0, Number(raw && raw.m_Id) || 0);
    if (!id) continue;
    defenceById.set(id, {
      id,
      scoreRewardGroupId: Math.max(0, Number(raw.DefenceScoreRewardGroupID) || 0),
      rankRewardGroupId: Math.max(0, Number(raw.m_RankRewardGroupID) || 0),
      raw,
    });
  }
  const scoreRewardById = new Map();
  const scoreRewardsByGroup = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_DEFENCE_SCORE_REWARD_TEMPLET.json", { optional: true })) {
    const row = {
      id: Math.max(0, Number(raw && raw.DefenceScoreRewardID) || 0),
      groupId: Math.max(0, Number(raw && raw.DefenceScoreRewardGroupID) || 0),
      score: Math.max(0, Number(raw && raw.Score) || 0),
      step: Math.max(0, Number(raw && raw.Step) || 0),
      raw,
    };
    if (!row.id || !row.groupId) continue;
    scoreRewardById.set(row.id, row);
    pushGroup(scoreRewardsByGroup, row.groupId, row);
  }
  for (const rows of scoreRewardsByGroup.values()) rows.sort((left, right) => left.step - right.step || left.id - right.id);
  const rankRewardsByGroup = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_DEFENCE_RANK_REWARD_TEMPLET.json", { optional: true })) {
    const groupId = Math.max(0, Number(raw && raw.DefenceRankRewardGroupID) || 0);
    if (!groupId) continue;
    pushGroup(rankRewardsByGroup, groupId, {
      id: Math.max(0, Number(raw.DefenceRankRewardID) || 0),
      showIndex: Math.max(0, Number(raw.ShowIndex) || 0),
      percentCheck: Boolean(raw.PercentCheck),
      rankValue: Math.max(0, Number(raw.RankValue) || 0),
      raw,
    });
  }
  for (const rows of rankRewardsByGroup.values()) rows.sort((left, right) => left.showIndex - right.showIndex || left.id - right.id);
  cachedDefenceCatalog = { defenceById, scoreRewardById, scoreRewardsByGroup, rankRewardsByGroup };
  return cachedDefenceCatalog;
}

function pushGroup(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function findDefenceForScoreGroup(catalog, groupId, socket) {
  const requestedId = Number(socket && socket.session && socket.session.defenceTempletId) || 0;
  const requested = requestedId ? catalog.defenceById.get(requestedId) : null;
  if (requested && requested.scoreRewardGroupId === groupId) return requested;
  return Array.from(catalog.defenceById.values()).find((entry) => entry.scoreRewardGroupId === groupId) || null;
}

function getClaimedScoreRewardIds(record) {
  const state = record && (record.source || record);
  return Array.from(new Set((Array.isArray(state && state.scoreRewardIds) ? state.scoreRewardIds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)))
    .sort((left, right) => left - right);
}

function emptyDefenceRecord(defenceId) {
  return { defenceTempletId: defenceId, defenceId, bestScore: 0, missionResult1: false, missionResult2: false };
}

function getBestDefenceRecord(user) {
  const records = user && ((user.miscStages && user.miscStages.defence) || user.defence || user.defenceData);
  return objectValues(records)
    .map((entry, index) => normalizeDefenceRecord(entry, index))
    .filter((entry) => entry.defenceId > 0)
    .sort((left, right) => right.bestScore - left.bestScore || right.defenceId - left.defenceId)[0] || null;
}

function getDefenceRanking(ctx, defenceId) {
  const users = ctx && ctx.userDb && ctx.userDb.users ? Object.values(ctx.userDb.users) : [];
  return users
    .map((user) => ({ user, record: findDefenceRecord(user, defenceId) }))
    .filter((entry) => entry.record && entry.record.bestScore > 0)
    .sort((left, right) => right.record.bestScore - left.record.bestScore || compareUid(left.user, right.user));
}

function findDefenceRecord(user, defenceId) {
  const records = user && ((user.miscStages && user.miscStages.defence) || user.defence || user.defenceData);
  const direct = records && !Array.isArray(records) ? records[String(defenceId)] : null;
  if (direct) return normalizeDefenceRecord(direct, defenceId);
  return objectValues(records)
    .map((entry) => normalizeDefenceRecord(entry, 0))
    .find((entry) => entry.defenceId === Number(defenceId)) || null;
}

function normalizeDefenceRecord(entry, fallbackId) {
  const source = entry && typeof entry === "object" ? entry : {};
  return {
    source,
    defenceId: Math.max(0, Number(source.defenceTempletId || source.defenceId || source.m_Id || fallbackId) || 0),
    bestScore: Math.max(0, Number(source.bestScore || source.BestScore) || 0),
    missionResult1: Boolean(source.missionResult1),
    missionResult2: Boolean(source.missionResult2),
    rankRewardClaimed: Boolean(source.rankRewardClaimed),
    scoreRewardIds: getClaimedScoreRewardIds(source),
  };
}

function findUser(ctx, uid) {
  const key = String(toBigInt(uid || 0));
  return ctx && ctx.userDb && ctx.userDb.users ? ctx.userDb.users[key] || null : null;
}

function findOwned(collection, uid) {
  const key = String(toBigInt(uid || 0));
  if (key === "0") return null;
  return collection[key] || objectValues(collection).find((entry) => String(entry && (entry.unitUid || entry.equipUid || entry.m_ItemUid)) === key) || null;
}

function objectValues(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

function userUid(user) {
  return toBigInt(user && user.userUid || 0);
}

function compareUid(left, right) {
  const a = userUid(left);
  const b = userUid(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

module.exports = {
  DEFENCE_INFO_ACK,
  DEFENCE_PROFILE_ACK,
  INVALID_SCORE_REWARD_TEMPLET,
  INVALID_TEMPLET,
  PROFILE_NOT_EXISTS,
  RANK_HAVE_NOT_REWARD_TEMPLET,
  RANK_REWARD_ALREADY_GIVEN,
  REWARD_COUNT_ZERO,
  SCORE_REWARD_ALREADY_GIVEN,
  SCORE_REWARD_MAKE_FAIL,
  buildAsyncDeckData,
  buildDefenceInfoAck,
  buildDefenceProfileAck,
  createDefenceHandlers,
  createDefenceProfileHandler,
  decodeDefenceProfileRequest,
  getBestDefenceRecord,
  getDefenceRanking,
  loadDefenceCatalog,
};
