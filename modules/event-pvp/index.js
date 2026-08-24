"use strict";

const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  buildRewardData,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
} = require("../packet-codec");
const pvpRank = require("../pvp-rank");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const {
  getEventDeckTemplet,
  getEventDeckUnitSlotTypes,
  getUnitTemplet,
} = require("../game-data");

const PACKETS = Object.freeze({
  MATCH_REQ: 2674,
  MATCH_ACK: 2675,
  CANCEL_REQ: 2676,
  CANCEL_ACK: 2677,
  COMPLETE_NOT: 2678,
  FAIL_NOT: 2679,
  SEASON_INFO_REQ: 2680,
  SEASON_INFO_ACK: 2681,
  REWARD_REQ: 2682,
  REWARD_ACK: 2683,
  EXIT_REQ: 2694,
  EXIT_ACK: 2695,
  CANCEL_NOT: 2696,
});

const ERRORS = Object.freeze({
  OK: 0,
  GAME_LOAD_FAILED: 95,
  INVALID_STATE: 20118,
  INVALID_REQUEST: 20191,
  SEASON_NOT_OPEN: 24000,
  DAY_NOT_OPEN: 24001,
  TIME_NOT_OPEN: 24002,
  INVALID_REWARD: 24007,
  ALREADY_REWARDED: 24008,
  REWARD_BELOW_STANDARD: 24009,
  REWARD_EXPIRATION: 24010,
  REWARD_MISMATCH: 24011,
  EVENT_INVALID_REQUEST: 24013,
});

const NGT_PVP_EVENT = 24;
const DAYS = Object.freeze(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
let catalog;

function createEventPvpHandlers() {
  return [
    { packetId: PACKETS.MATCH_REQ, name: "EVENT_PVP_GAME_MATCH_REQ", handle: handleMatch },
    { packetId: PACKETS.CANCEL_REQ, name: "EVENT_PVP_GAME_MATCH_CANCEL_REQ", handle: handleCancel },
    { packetId: PACKETS.SEASON_INFO_REQ, name: "EVENT_PVP_SEASON_INFO_REQ", handle: handleSeasonInfo },
    { packetId: PACKETS.REWARD_REQ, name: "EVENT_PVP_REWARD_REQ", handle: handleReward },
    { packetId: PACKETS.EXIT_REQ, name: "EVENT_PVP_EXIT_REQ", handle: handleExit },
  ];
}

function handleMatch(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const request = decodeMatchRequest(ctx, packet && packet.payload);
  let errorCode = request.valid ? validateSeasonRequest(ctx, request.seasonId) : ERRORS.INVALID_REQUEST;
  const season = errorCode === ERRORS.OK ? getSeasonById(request.seasonId) : null;
  if (errorCode === ERRORS.OK && request.gameType !== NGT_PVP_EVENT) errorCode = ERRORS.EVENT_INVALID_REQUEST;
  if (errorCode === ERRORS.OK && !validateEventDeck(user, season, request.eventDeckData)) errorCode = ERRORS.EVENT_INVALID_REQUEST;
  if (errorCode === ERRORS.OK && hasActiveBattle(socket)) errorCode = ERRORS.INVALID_STATE;

  send(ctx, socket, packet, PACKETS.MATCH_ACK, writeSignedVarInt(errorCode), "event-pvp-match");
  if (errorCode === ERRORS.OK) {
    const started = typeof ctx.startEventPvpMatch === "function" && ctx.startEventPvpMatch(socket, user, request, season);
    if (!started && typeof ctx.sendServerGamePacket === "function") {
      ctx.sendServerGamePacket(socket, PACKETS.FAIL_NOT, writeSignedVarInt(ERRORS.GAME_LOAD_FAILED), "event-pvp-match-failed");
    }
  }
  return true;
}

function handleCancel(ctx, socket, packet) {
  const valid = decodeEmptyRequest(ctx, packet && packet.payload);
  const cancelled = valid && typeof ctx.cancelEventPvpMatch === "function" ? ctx.cancelEventPvpMatch(socket) : false;
  const errorCode = !valid ? ERRORS.INVALID_REQUEST : cancelled ? ERRORS.OK : ERRORS.INVALID_STATE;
  send(ctx, socket, packet, PACKETS.CANCEL_ACK, writeSignedVarInt(errorCode), "event-pvp-match-cancel");
  return true;
}

function handleSeasonInfo(ctx, socket, packet) {
  const request = decodeSeasonRequest(ctx, packet && packet.payload);
  const user = getSocketUser(ctx, socket);
  const errorCode = request.valid ? validateSeasonRequest(ctx, request.seasonId) : ERRORS.INVALID_REQUEST;
  const season = errorCode === ERRORS.OK ? getSeasonById(request.seasonId) : null;
  const result = {
    errorCode,
    state: season ? getEventPvpState(user, season) : null,
    rewards: season ? getEventPvpRewardInfo(user, season, getNow(ctx)) : [],
  };
  send(ctx, socket, packet, PACKETS.SEASON_INFO_ACK, buildSeasonInfoAckPayload(result), "event-pvp-season-info");
  return true;
}

function handleReward(ctx, socket, packet) {
  const request = decodeSeasonRequest(ctx, packet && packet.payload);
  const user = getSocketUser(ctx, socket);
  const errorCode = request.valid ? validateSeasonRequest(ctx, request.seasonId) : ERRORS.INVALID_REQUEST;
  const result = errorCode === ERRORS.OK
    ? claimEventPvpRewards(ctx, user, getSeasonById(request.seasonId), getNow(ctx))
    : { errorCode, rewardDatas: [], rewards: [], changed: false };
  send(ctx, socket, packet, PACKETS.REWARD_ACK, buildRewardAckPayload(result), "event-pvp-reward");
  persistSuccess(ctx, result, "event-pvp-reward");
  return true;
}

function handleExit(ctx, socket, packet) {
  const valid = decodeEmptyRequest(ctx, packet && packet.payload);
  const exited = valid && typeof ctx.exitEventPvpMatch === "function" ? ctx.exitEventPvpMatch(socket) : false;
  const errorCode = !valid ? ERRORS.INVALID_REQUEST : exited ? ERRORS.OK : ERRORS.INVALID_STATE;
  send(ctx, socket, packet, PACKETS.EXIT_ACK, writeSignedVarInt(errorCode), "event-pvp-exit");
  return true;
}

function decodeMatchRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    let offset = 0;
    const seasonId = readSignedVarInt(payload, offset); offset = seasonId.offset;
    if (offset >= payload.length || payload[offset++] !== 1) return invalidMatch();
    const eventDeck = readEventDeckData(payload, offset); offset = eventDeck.offset;
    const gameType = readByte(payload, offset); offset = gameType.offset;
    if (offset !== payload.length || seasonId.value <= 0) return invalidMatch();
    return { valid: true, seasonId: seasonId.value, eventDeckData: eventDeck.value, gameType: gameType.value };
  } catch (_) {
    return invalidMatch();
  }
}

function readEventDeckData(payload, startOffset) {
  let offset = startOffset;
  const shipUid = readSignedVarLong(payload, offset); offset = shipUid.offset;
  const count = readUnsignedVarInt(payload, offset); offset = count.offset;
  if (count.value > 8) throw new Error("too many event deck units");
  const units = {};
  for (let index = 0; index < count.value; index += 1) {
    const slot = readSignedVarInt(payload, offset); offset = slot.offset;
    const unitUid = readSignedVarLong(payload, offset); offset = unitUid.offset;
    if (slot.value < 0 || slot.value >= 8 || unitUid.value < 0n || Object.hasOwn(units, slot.value)) throw new Error("invalid event deck unit");
    units[slot.value] = unitUid.value;
  }
  const operatorUid = readSignedVarLong(payload, offset); offset = operatorUid.offset;
  const leaderIndex = readSignedVarInt(payload, offset); offset = leaderIndex.offset;
  if (shipUid.value < 0n || operatorUid.value < 0n || leaderIndex.value < -1 || leaderIndex.value >= 8) throw new Error("invalid event deck identity");
  return { value: { shipUid: shipUid.value, units, operatorUid: operatorUid.value, leaderIndex: leaderIndex.value }, offset };
}

function decodeSeasonRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const seasonId = readSignedVarInt(payload, 0);
    return { valid: seasonId.offset === payload.length && seasonId.value > 0, seasonId: seasonId.value };
  } catch (_) {
    return { valid: false, seasonId: 0 };
  }
}

function decodeEmptyRequest(ctx, encryptedPayload) {
  try { return decrypt(ctx, encryptedPayload).length === 0; }
  catch (_) { return false; }
}

function validateEventDeck(user, season, deck) {
  if (!user || !season || !deck) return false;
  const eventDeck = getEventDeckTemplet(int(season.EventDeckID));
  if (!eventDeck) return false;
  const army = user.army && typeof user.army === "object" ? user.army : {};
  const units = army.units && typeof army.units === "object" ? army.units : {};
  const ships = army.ships && typeof army.ships === "object" ? army.ships : {};
  const operators = army.operators && typeof army.operators === "object" ? army.operators : {};
  const slotTypes = getEventDeckUnitSlotTypes(int(season.EventDeckID));
  const seenUids = new Set();
  const seenBaseIds = new Set();
  for (let slot = 0; slot < 8; slot += 1) {
    const rawUid = deck.units && deck.units[String(slot)] || 0;
    const uid = String(rawUid || 0);
    const type = slotTypes[slot] || "ST_CLOSED";
    const owned = uid === "0" ? null : units[uid];
    if (!validateEventSlot(owned, uid, type, int(eventDeck[`SLOT_UNIT_ID_${slot + 1}`]), "unit")) return false;
    if (!owned) continue;
    const baseId = baseUnitId(owned.unitId || owned.m_UnitID);
    if (seenUids.has(uid) || (baseId > 0 && seenBaseIds.has(baseId))) return false;
    seenUids.add(uid);
    if (baseId > 0) seenBaseIds.add(baseId);
  }
  const shipUid = String(deck.shipUid || 0);
  const operatorUid = String(deck.operatorUid || 0);
  if (!validateEventSlot(ships[shipUid], shipUid, String(eventDeck.SLOT_TYPE_SHIP || "ST_CLOSED"), int(eventDeck.SLOT_UNIT_ID_SHIP), "ship")) return false;
  if (!validateEventSlot(operators[operatorUid], operatorUid, String(eventDeck.SLOT_TYPE_OPERATOR || "ST_CLOSED"), int(eventDeck.SLOT_UNIT_ID_OPERATOR), "operator")) return false;
  if (deck.leaderIndex < 0) return true;
  const leaderType = slotTypes[deck.leaderIndex] || "ST_CLOSED";
  return String(deck.units && deck.units[String(deck.leaderIndex)] || 0) !== "0" || ["ST_FIXED", "ST_GUEST", "ST_NPC"].includes(leaderType);
}

function validateEventSlot(owned, uid, slotType, requiredId, kind) {
  const type = String(slotType || "ST_CLOSED");
  const hasUid = uid !== "0";
  if (["ST_CLOSED", "ST_NPC", "ST_RANDOM"].includes(type)) return !hasUid;
  if (type === "ST_GUEST" && !hasUid) return true;
  if (!hasUid || !owned) return false;
  const ownedId = int(kind === "operator" ? owned.id || owned.unitId : owned.unitId || owned.m_UnitID);
  if (["ST_FIXED", "ST_GUEST"].includes(type) && requiredId > 0 && baseUnitId(ownedId) !== baseUnitId(requiredId)) return false;
  if (kind === "unit" && type.startsWith("ST_FREE_")) {
    const template = getUnitTemplet(ownedId) || {};
    const style = String(template.m_NKM_UNIT_STYLE_TYPE || template.m_UnitStyleType || "").toUpperCase();
    if (type === "ST_FREE_COUNTER" && !style.includes("COUNTER")) return false;
    if (type === "ST_FREE_SOLDIER" && !style.includes("SOLDIER")) return false;
    if (type === "ST_FREE_MECHANIC" && !style.includes("MECHANIC")) return false;
  }
  return true;
}

function baseUnitId(unitId) {
  const template = getUnitTemplet(int(unitId));
  return int(template && template.m_BaseUnitID) || int(unitId);
}

function validateSeasonRequest(ctx, seasonId) {
  const season = getSeasonById(seasonId);
  if (!season || !isIntervalActive(season, getNow(ctx))) return ERRORS.SEASON_NOT_OPEN;
  const now = getNow(ctx);
  const allowedDays = Array.isArray(season.EnterLimitDays) ? season.EnterLimitDays.map(String) : [];
  if (allowedDays.length && !allowedDays.includes(DAYS[now.getUTCDay()])) return ERRORS.DAY_NOT_OPEN;
  if (!isOpenTime(season, now)) return ERRORS.TIME_NOT_OPEN;
  const tags = ctx && typeof ctx.getEffectiveOpenTags === "function" ? ctx.getEffectiveOpenTags([]) : [];
  if (season.OpenTag && Array.isArray(tags) && tags.length && !tags.includes(season.OpenTag)) return ERRORS.SEASON_NOT_OPEN;
  return ERRORS.OK;
}

function getActiveEventPvpSeason(ctx) {
  const now = getNow(ctx);
  return loadCatalog().seasons.find((season) => isIntervalActive(season, now) && validateSeasonRequest(ctx, season.seasonID) === ERRORS.OK) || null;
}

function getSeasonById(seasonId) {
  return loadCatalog().seasonById.get(Number(seasonId)) || null;
}

function getEventPvpState(user, season) {
  const previous = pvpRank.normalizePvpState(user && user.pvp && user.pvp.event);
  if (!season || previous.seasonId !== Number(season.seasonID)) {
    return pvpRank.normalizePvpState({ seasonId: Number(season && season.seasonID || 0) });
  }
  return previous;
}

function setEventPvpState(user, state) {
  if (!user.pvp || typeof user.pvp !== "object") user.pvp = {};
  user.pvp.event = pvpRank.normalizePvpState(state);
  return user.pvp.event;
}

function recordEventPvpResult(user, season, result, options = {}) {
  const previous = getEventPvpState(user, season);
  const win = Number(result) === 0;
  const loss = Number(result) === 1;
  const next = setEventPvpState(user, {
    ...previous,
    seasonId: Number(season.seasonID),
    winCount: previous.winCount + (win ? 1 : 0),
    loseCount: previous.loseCount + (loss ? 1 : 0),
    score: previous.score + (win ? int(season.EventPVPWinPoint) : loss ? int(season.EventPVPLosePoint) : 0),
    maxScore: Math.max(previous.maxScore, previous.score + (win ? int(season.EventPVPWinPoint) : loss ? int(season.EventPVPLosePoint) : 0)),
    winStreak: win ? previous.winStreak + 1 : 0,
    maxWinStreak: win ? Math.max(previous.maxWinStreak, previous.winStreak + 1) : previous.maxWinStreak,
    seasonPlayCount: previous.seasonPlayCount + 1,
    seasonWinCount: previous.seasonWinCount + (win ? 1 : 0),
  });
  const rewards = ensureRewardState(user, season, validDate(options.now));
  for (const groupId of rewardGroupIds(season)) {
    const rows = loadCatalog().rewardsByGroup.get(groupId) || [];
    const current = rewards[String(groupId)];
    const row = rows.find((entry) => int(entry.Step) === current.step) || rows[0];
    const condition = String(row && row.PlayCountCondition || "Play").toLowerCase();
    if (condition === "play" || (condition === "win" && win) || (condition === "lose" && loss) || (condition === "draw" && !win && !loss)) {
      current.playCount += 1;
    }
  }
  return next;
}

function getEventPvpRewardInfo(user, season, now = new Date()) {
  const state = ensureRewardState(user, season, validDate(now), { persist: false });
  return rewardGroupIds(season).map((groupId) => {
    const value = state[String(groupId)];
    const rows = loadCatalog().rewardsByGroup.get(groupId) || [];
    const row = rows.find((entry) => int(entry.Step) === value.step) || rows[0] || {};
    return {
      seasonId: Number(season.seasonID),
      groupId,
      rewardId: int(row.RewardID),
      step: value.step,
      playCount: value.playCount,
      isReward: value.isReward,
    };
  });
}

function claimEventPvpRewards(ctx, user, season, now = new Date()) {
  if (!season) return { errorCode: ERRORS.SEASON_NOT_OPEN, rewardDatas: [], rewards: [], changed: false };
  const state = ensureRewardState(user, season, validDate(now));
  const rewardDatas = [];
  let claimed = false;
  for (const groupId of rewardGroupIds(season)) {
    const rows = loadCatalog().rewardsByGroup.get(groupId) || [];
    const current = state[String(groupId)];
    const index = rows.findIndex((row) => int(row.Step) === current.step);
    const row = index >= 0 ? rows[index] : null;
    if (!row || current.isReward || current.playCount < int(row.PlayTimes)) continue;
    const reward = createEmptyReward();
    for (let slot = 1; slot <= 3; slot += 1) {
      const type = String(row[`EventRewardType_${slot}`] || "RT_NONE");
      const id = int(row[`EventRewardID_${slot}`]);
      const count = int(row[`EventRewardValue_${slot}`]);
      if (type !== "RT_NONE" && id > 0 && count > 0) mergeReward(reward, grantRewardByType(ctx, user, type, id, count));
    }
    rewardDatas.push(reward);
    claimed = true;
    if (index + 1 < rows.length) {
      current.step = int(rows[index + 1].Step);
      current.isReward = false;
    } else {
      current.isReward = true;
    }
  }
  const rewards = getEventPvpRewardInfo(user, season, now);
  return {
    errorCode: claimed ? ERRORS.OK : rewards.some((entry) => entry.isReward) ? ERRORS.ALREADY_REWARDED : ERRORS.REWARD_BELOW_STANDARD,
    rewardDatas: claimed ? rewardDatas : [],
    rewards,
    changed: claimed,
  };
}

function buildSeasonInfoAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    result.state ? writeNullableObject(pvpRank.buildPvpStateData(result.state)) : Buffer.from([0]),
    writeNullableObjectList((result.rewards || []).map(buildEventPvpRewardData)),
  ]);
}

function buildRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(result.errorCode)),
    writeNullableObjectList((result.rewardDatas || []).map(buildRewardData)),
    writeNullableObjectList((result.rewards || []).map(buildEventPvpRewardData)),
  ]);
}

function buildEventPvpRewardData(value = {}) {
  return Buffer.concat([
    writeSignedVarInt(int(value.seasonId)),
    writeSignedVarInt(int(value.groupId)),
    writeSignedVarInt(int(value.rewardId)),
    writeSignedVarInt(int(value.step)),
    writeSignedVarInt(int(value.playCount)),
    writeBool(Boolean(value.isReward)),
  ]);
}

function ensureRewardState(user, season, now, options = {}) {
  const source = user && user.eventPvpRewards && typeof user.eventPvpRewards === "object" ? user.eventPvpRewards : {};
  const seasonKey = String(season.seasonID);
  const previous = source[seasonKey] && typeof source[seasonKey] === "object" ? source[seasonKey] : {};
  const next = {};
  for (const groupId of rewardGroupIds(season)) {
    const rows = loadCatalog().rewardsByGroup.get(groupId) || [];
    if (!rows.length) continue;
    const old = previous[String(groupId)] && typeof previous[String(groupId)] === "object" ? previous[String(groupId)] : {};
    const first = rows[0];
    const daily = String(first.ResetType || "").toLowerCase() === "daily";
    const dateKey = now.toISOString().slice(0, 10);
    const reset = daily && String(old.dateKey || "") !== dateKey;
    next[String(groupId)] = {
      step: reset ? int(first.Step) : Math.max(int(first.Step), int(old.step || first.Step)),
      playCount: reset ? 0 : Math.max(0, int(old.playCount)),
      isReward: reset ? false : old.isReward === true,
      dateKey,
    };
  }
  if (options.persist !== false && user) {
    user.eventPvpRewards = { ...source, [seasonKey]: next };
    return user.eventPvpRewards[seasonKey];
  }
  return next;
}

function loadCatalog() {
  if (catalog) return catalog;
  const seasons = readGameplayTableRecords("ab_script", "LUA_PVP_EVENTMATCH_SEASON.json").filter((row) => int(row && row.seasonID) > 0);
  const intervals = new Map(readGameplayTableRecords("ab_script", "LUA_INTERVAL_TEMPLET.json").map((row) => [String(row && row.m_DateStrID || ""), row]));
  const rewardsByGroup = new Map();
  for (const row of readGameplayTableRecords("ab_script", "LUA_PVP_EVENTMATCH_REWARD.json")) {
    const groupId = int(row && row.RewardGroupID);
    if (!groupId) continue;
    if (!rewardsByGroup.has(groupId)) rewardsByGroup.set(groupId, []);
    rewardsByGroup.get(groupId).push(row);
  }
  for (const rows of rewardsByGroup.values()) rows.sort((left, right) => int(left.Step) - int(right.Step));
  catalog = { seasons, seasonById: new Map(seasons.map((row) => [int(row.seasonID), row])), intervals, rewardsByGroup };
  return catalog;
}

function isIntervalActive(season, date) {
  const interval = loadCatalog().intervals.get(String(season && season.Interval || ""));
  if (!interval) return false;
  const start = parseTableDate(interval.m_DateStart);
  const end = parseTableDate(interval.m_DateEnd);
  const time = validDate(date).getTime();
  return start && end && time >= start.getTime() && time < end.getTime();
}

function isOpenTime(season, now) {
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = parseClock(season.OpenTimeStart);
  const end = parseClock(season.OpenTimeEnd);
  return start <= minute && (end === 1440 ? minute < 1440 : minute < end);
}

function parseClock(value) {
  const text = String(value == null ? "0000" : value).padStart(4, "0");
  const hour = Number(text.slice(0, 2));
  const minute = Number(text.slice(2, 4));
  return Number.isInteger(hour) && Number.isInteger(minute) ? Math.min(1440, hour * 60 + minute) : 0;
}

function parseTableDate(value) {
  const text = String(value || "").trim();
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(/Z$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function rewardGroupIds(season) {
  return (Array.isArray(season && season.RewardGroupID) ? season.RewardGroupID : []).map(int).filter((value) => value > 0);
}

function persistSuccess(ctx, result, label) {
  if (!result || !result.changed) return;
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function send(ctx, socket, packet, packetId, payload, label) {
  ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function getSocketUser(ctx, socket) {
  return socket && socket.session && socket.session.user || (ctx.createEphemeralUser ? ctx.createEphemeralUser() : {});
}

function getNow(ctx) {
  return validDate(ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date());
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function hasActiveBattle(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  return Boolean(replay && replay.dynamicGame && replay.dynamicBattleResultSent !== true);
}

function decrypt(ctx, payload) {
  const value = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : payload;
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function readUnsignedVarInt(buffer, start) {
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

function invalidMatch() {
  return { valid: false, seasonId: 0, eventDeckData: null, gameType: 0 };
}

function int(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

module.exports = {
  ERRORS,
  NGT_PVP_EVENT,
  PACKETS,
  buildEventPvpRewardData,
  buildRewardAckPayload,
  buildSeasonInfoAckPayload,
  claimEventPvpRewards,
  createEventPvpHandlers,
  decodeMatchRequest,
  getActiveEventPvpSeason,
  getEventPvpRewardInfo,
  getEventPvpState,
  getSeasonById,
  loadCatalog,
  recordEventPvpResult,
  setEventPvpState,
  validateEventDeck,
  validateSeasonRequest,
};
