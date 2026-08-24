"use strict";

const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  readBool,
  readSignedVarInt,
  toBigInt,
  writeBool,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");

const OK = 0;
const INVALID_REQUEST = 20430; // NKM_ERROR_CODE.NEC_FAIL_LEADERBOARD_INVALID_REQUEST
const TOP_LIMIT = 10;
const ALL_LIMIT = 100;
const REQUEST_NAMES = Object.freeze({
  3200: "LEADERBOARD_ACHIEVE_LIST_REQ",
  3202: "LEADERBOARD_SHADOWPALACE_LIST_REQ",
  3208: "LEADERBOARD_GUILD_UNION_RANK_LIST_REQ",
  3210: "LEADERBOARD_GUILD_LEVEL_RANK_LIST_REQ",
  3212: "LEADERBOARD_TIMEATTACK_LIST_REQ",
  3214: "LEADERBOARD_DEFENCE_LIST_REQ",
});

let cachedCatalog = null;

function createLeaderboardHandlers() {
  return Object.keys(REQUEST_NAMES).map((packetIdText) => {
    const packetId = Number(packetIdText);
    return {
      packetId,
      name: REQUEST_NAMES[packetId],
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const req = decodeRequest(ctx, packetId, packet.payload || Buffer.alloc(0));
        const response = buildResponse(ctx, user, packetId, req);
        ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
          ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
        );
        console.log(`[leaderboard:${REQUEST_NAMES[packetId]}] ACK packetId=${response.packetId} errorCode=${response.errorCode}`);
        return true;
      },
    };
  });
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload;
  try {
    payload = ctx.decryptCopy(encryptedPayload);
    if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload || []);
  } catch (_) {
    return { valid: false };
  }

  try {
    switch (packetId) {
      case 3200:
        return readExactBool(payload, "isAll");
      case 3202:
        return readExactIntBool(payload, "actId");
      case 3208:
        return readExactInt(payload, "seasonId");
      case 3210:
        return { valid: payload.length === 0 };
      case 3212:
        return readExactIntBool(payload, "stageId");
      case 3214:
        return readExactIntBool(payload, "defenceId");
      default:
        return { valid: false };
    }
  } catch (_) {
    return { valid: false };
  }
}

function buildResponse(ctx, user, packetId, req = {}) {
  const catalog = loadLeaderboardCatalog();
  switch (packetId) {
    case 3200:
      return buildProfileBoardAck(ctx, user, req, {
        packetId: 3201,
        score: getAchieveScore,
        serialize: (entry) => buildProfileScoreData(entry.user, writeSignedVarLong(entry.score)),
      });
    case 3202:
      return buildProfileBoardAck(ctx, user, validateCriteria(req, catalog.shadowIds, "actId"), {
        packetId: 3203,
        score: (entry) => getShadowPalaceTime(entry, req.actId, catalog),
        ascending: true,
        serialize: (entry) => buildProfileScoreData(entry.user, writeSignedVarInt(toInt32(entry.score))),
        suffix: () => writeSignedVarInt(validInt(req.actId)),
      });
    case 3208:
      return buildGuildAck(ctx, user, validateCriteria(req, catalog.guildUnionIds, "seasonId"), false);
    case 3210:
      return buildGuildAck(ctx, user, req, true);
    case 3212:
      return buildProfileBoardAck(ctx, user, validateCriteria(req, catalog.timeAttackIds, "stageId"), {
        packetId: 3213,
        score: (entry) => getTimeAttackScore(entry, req.stageId),
        ascending: true,
        serialize: (entry) => buildProfileScoreData(entry.user, writeSignedVarInt(toInt32(entry.score))),
        suffix: () => writeSignedVarInt(validInt(req.stageId)),
      });
    case 3214:
      return buildProfileBoardAck(ctx, user, validateCriteria(req, catalog.defenceIds, "defenceId"), {
        packetId: 3215,
        score: (entry) => getDefenceScore(entry, req.defenceId),
        serialize: (entry) => buildProfileScoreData(entry.user, writeSignedVarInt(toInt32(entry.score))),
        suffix: () => writeSignedVarInt(validInt(req.defenceId)),
      });
    default:
      return { packetId: packetId + 1, payload: writeSignedVarInt(INVALID_REQUEST), errorCode: INVALID_REQUEST };
  }
}

function buildProfileBoardAck(ctx, user, req, options) {
  const valid = Boolean(req && req.valid);
  const ranked = valid ? rankUsers(getUsers(ctx, user), options.score, Boolean(options.ascending)) : [];
  const ownRank = valid ? findUserRank(ranked, user) : 0;
  const visible = ranked.slice(0, req && req.isAll ? ALL_LIMIT : TOP_LIMIT);
  const payload = Buffer.concat([
    writeSignedVarInt(valid ? OK : INVALID_REQUEST),
    writeNullableObject(writeNullableObjectList(visible.map(options.serialize))),
    writeSignedVarInt(ownRank),
    options.suffix ? options.suffix() : Buffer.alloc(0),
    writeBool(valid && Boolean(req.isAll)),
  ]);
  return { packetId: options.packetId, payload, errorCode: valid ? OK : INVALID_REQUEST };
}

function buildGuildAck(ctx, user, req, levelBoard) {
  const valid = Boolean(req && req.valid);
  const seasonId = levelBoard || !valid ? 0 : validInt(req.seasonId);
  const ranked = valid ? rankGuilds(getUsers(ctx, user), levelBoard, seasonId) : [];
  const ownGuildUid = getGuildIdentity(user).guildUid;
  const ownRank = ranked.findIndex((entry) => entry.guildUid === ownGuildUid) + 1;
  const own = ownRank > 0 ? ranked[ownRank - 1] : null;
  const payload = Buffer.concat([
    levelBoard ? Buffer.alloc(0) : writeSignedVarInt(seasonId),
    writeNullableObject(writeNullableObjectList(ranked.slice(0, ALL_LIMIT).map(buildGuildRankData))),
    writeNullableObject(Buffer.concat([
      writeSignedVarInt(ownRank),
      writeSignedVarLong(own ? own.rankValue : 0n),
    ])),
  ]);
  return { packetId: levelBoard ? 3211 : 3209, payload, errorCode: valid ? OK : INVALID_REQUEST };
}

function readExactBool(payload, fieldName) {
  if (payload.length !== 1 || payload[0] > 1) return { valid: false };
  return { valid: true, [fieldName]: readBool(payload, 0).value };
}

function readExactInt(payload, fieldName) {
  const value = readSignedVarInt(payload, 0);
  return value.offset === payload.length ? { valid: true, [fieldName]: value.value } : { valid: false };
}

function readExactIntBool(payload, fieldName) {
  const value = readSignedVarInt(payload, 0);
  if (value.offset + 1 !== payload.length || payload[value.offset] > 1) return { valid: false };
  return { valid: true, [fieldName]: value.value, isAll: readBool(payload, value.offset).value };
}

function validateCriteria(req, allowed, fieldName) {
  const value = validInt(req && req[fieldName]);
  return { ...req, valid: Boolean(req && req.valid && value > 0 && (!allowed.size || allowed.has(value))) };
}

function getUsers(ctx, activeUser) {
  const users = ctx && ctx.userDb && ctx.userDb.users ? Object.values(ctx.userDb.users) : [];
  if (activeUser && !users.some((entry) => sameUser(entry, activeUser))) users.push(activeUser);
  return users.filter((entry) => entry && typeof entry === "object");
}

function rankUsers(users, scoreOf, ascending) {
  return users
    .map((user) => ({ user, score: nonNegativeLong(scoreOf(user)) }))
    .filter((entry) => entry.score > 0n)
    .sort((left, right) => {
      if (left.score !== right.score) {
        const comparison = left.score < right.score ? -1 : 1;
        return ascending ? comparison : -comparison;
      }
      return compareLong(userUid(left.user), userUid(right.user));
    });
}

function findUserRank(ranked, user) {
  if (!user) return 0;
  const index = ranked.findIndex((entry) => sameUser(entry.user, user));
  return index < 0 ? 0 : index + 1;
}

function sameUser(left, right) {
  return userUid(left) === userUid(right);
}

function userUid(user) {
  return toBigInt(user && user.userUid != null ? user.userUid : 0);
}

function getAchieveScore(user) {
  return nonNegativeLong(user && (user.achievePoint != null ? user.achievePoint : user.achievementPoint));
}

function getShadowPalaceTime(user, palaceId, catalog) {
  const shadow = user && ((user.miscStages && user.miscStages.shadow) || user.shadowPalace || user.m_ShadowPalace);
  const palaces = objectValues(shadow && (shadow.palaces || shadow.palaceDataList));
  const palace = palaces.find((entry) => validInt(entry && (entry.palaceId || entry.PalaceId)) === validInt(palaceId));
  if (!palace) return 0;
  const dungeons = objectValues(palace.dungeonDataList || palace.DungeonDataList);
  const requiredCount = catalog.shadowBattleCounts.get(validInt(palaceId)) || 0;
  if ((requiredCount && dungeons.length !== requiredCount) || !dungeons.length) return 0;
  const times = dungeons.map((entry) => validInt(entry && (entry.bestTime || entry.BestTime)));
  if (times.some((value) => value <= 0)) return 0;
  return times.reduce((sum, value) => sum + value, 0);
}

function getTimeAttackScore(user, stageId) {
  const records = user && (user.stagePlayData || user.stagePlayDataById || user.stagePlayDataList);
  const row = findById(records, stageId, ["stageId", "stageID", "StageId"]);
  return validInt(row && (row.bestClearTimeSec || row.bestClearSec || row.bestTime));
}

function getDefenceScore(user, defenceId) {
  const records = user && ((user.miscStages && user.miscStages.defence) || user.defence || user.defenceData);
  const row = findById(records, defenceId, ["defenceTempletId", "defenceId", "m_Id"]);
  return validInt(row && (row.bestScore || row.BestScore));
}

function findById(records, id, names) {
  if (!records) return null;
  const key = String(validInt(id));
  if (!Array.isArray(records) && records[key]) return records[key];
  return objectValues(records).find((entry) => names.some((name) => validInt(entry && entry[name]) === validInt(id))) || null;
}

function buildProfileScoreData(user, scorePayload) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    scorePayload,
    writeNullableObject(buildGuildSimpleData(user)),
  ]);
}

function buildCommonProfileData(user) {
  const data = user || {};
  return Buffer.concat([
    writeSignedVarLong(userUid(data)),
    writeSignedVarLong(toBigInt(data.friendCode || 0)),
    writeString(data.nickname || ""),
    writeSignedVarInt(Math.max(1, validInt(data.level) || 1)),
    writeSignedVarInt(validInt(data.mainUnitId)),
    writeSignedVarInt(validInt(data.mainUnitSkinId)),
    writeSignedVarInt(validInt(data.frameId || data.selfiFrameId)),
    writeSignedVarInt(validInt(data.mainUnitTacticLevel)),
    writeSignedVarInt(validInt(data.titleId)),
  ]);
}

function buildGuildSimpleData(user) {
  const guild = getGuildIdentity(user);
  return Buffer.concat([
    writeSignedVarLong(guild.guildUid),
    writeString(guild.guildName),
    writeSignedVarLong(guild.badgeId),
  ]);
}

function getGuildIdentity(user) {
  const nested = user && user.guildData && typeof user.guildData === "object" ? user.guildData : {};
  return {
    guildUid: toBigInt(user && user.guildUid != null ? user.guildUid : nested.guildUid || 0),
    guildName: String((user && user.guildName) || nested.guildName || nested.name || ""),
    badgeId: toBigInt(user && user.guildBadgeId != null ? user.guildBadgeId : nested.badgeId || 0),
    guildLevel: Math.max(1, validInt((user && user.guildLevel) || nested.guildLevel) || 1),
    memberCount: Math.max(0, validInt((user && user.guildMemberCount) || nested.memberCount)),
    unionPoint: nonNegativeLong(user && (user.guildUnionPoint != null ? user.guildUnionPoint : nested.unionPoint)),
    masterNickname: String((user && user.guildMasterNickname) || nested.masterNickname || (user && user.nickname) || ""),
  };
}

function rankGuilds(users, levelBoard, seasonId) {
  const grouped = new Map();
  for (const user of users) {
    const guild = getGuildIdentity(user);
    if (guild.guildUid <= 0n) continue;
    const key = String(guild.guildUid);
    const group = grouped.get(key) || { ...guild, members: 0, rankValue: 0n };
    group.members += 1;
    group.guildLevel = Math.max(group.guildLevel, guild.guildLevel);
    group.memberCount = Math.max(group.memberCount, guild.memberCount, group.members);
    group.unionPoint = maxLong(group.unionPoint, getGuildUnionScore(user, seasonId), guild.unionPoint);
    if (!group.guildName && guild.guildName) group.guildName = guild.guildName;
    if (!group.masterNickname && guild.masterNickname) group.masterNickname = guild.masterNickname;
    if (group.badgeId <= 0n && guild.badgeId > 0n) group.badgeId = guild.badgeId;
    grouped.set(key, group);
  }
  return Array.from(grouped.values())
    .map((entry) => ({ ...entry, rankValue: levelBoard ? BigInt(entry.guildLevel) : entry.unionPoint }))
    .filter((entry) => entry.rankValue > 0n)
    .sort((left, right) => right.rankValue === left.rankValue
      ? compareLong(left.guildUid, right.guildUid)
      : right.rankValue > left.rankValue ? 1 : -1);
}

function getGuildUnionScore(user, seasonId) {
  const bySeason = user && (user.guildUnionPointBySeason || user.guildUnionPoints);
  if (bySeason && typeof bySeason === "object" && bySeason[String(seasonId)] != null) {
    return nonNegativeLong(bySeason[String(seasonId)]);
  }
  return nonNegativeLong(user && (user.guildUnionPoint || user.guildPoint));
}

function buildGuildRankData(entry) {
  return Buffer.concat([
    writeSignedVarLong(entry.guildUid),
    writeSignedVarLong(entry.badgeId),
    writeString(entry.guildName),
    writeString(entry.masterNickname),
    writeSignedVarInt(entry.guildLevel),
    writeSignedVarInt(entry.memberCount),
    writeSignedVarLong(entry.rankValue),
  ]);
}

function loadLeaderboardCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const boards = readGameplayTableRecords("ab_script", "LUA_LEADERBOARD_TEMPLET.json", { optional: true });
  const shadowPalaces = readGameplayTableRecords("ab_script", "LUA_SHADOW_PALACE_TEMPLET.json", { optional: true });
  const shadowBattles = readGameplayTableRecords("ab_script", "LUA_SHADOW_BATTLE_TEMPLET.json", { optional: true });
  const defenceRows = readGameplayTableRecords("ab_script", "LUA_DEFENCE_TEMPLET.json", { optional: true });
  const shadowBattleCountByGroup = new Map();
  for (const row of shadowBattles) {
    const groupId = validInt(row && row.BATTLE_GROUP);
    if (groupId > 0) shadowBattleCountByGroup.set(groupId, (shadowBattleCountByGroup.get(groupId) || 0) + 1);
  }
  const shadowBattleCounts = new Map();
  for (const row of shadowPalaces) {
    const palaceId = validInt(row && row.PALACE_ID);
    const groupId = validInt(row && row.BATTLE_GROUP_ID);
    if (palaceId > 0) shadowBattleCounts.set(palaceId, shadowBattleCountByGroup.get(groupId) || 0);
  }
  cachedCatalog = {
    shadowIds: criteriaSet(boards, "BT_SHADOW"),
    guildUnionIds: criteriaSet(boards, "BT_GUILD", (value) => value !== 1),
    timeAttackIds: criteriaSet(boards, "BT_TIMEATTACK"),
    defenceIds: new Set(defenceRows.map((row) => validInt(row && row.m_Id)).filter((value) => value > 0)),
    shadowBattleCounts,
  };
  return cachedCatalog;
}

function criteriaSet(rows, boardType, include = () => true) {
  return new Set(rows
    .filter((row) => row && row.m_BoardTab === boardType)
    .map((row) => validInt(row.m_BoardCriteria))
    .filter((value) => value > 0 && include(value)));
}

function objectValues(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

function validInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function toInt32(value) {
  const number = nonNegativeLong(value);
  return Number(number > 2147483647n ? 2147483647n : number);
}

function nonNegativeLong(value) {
  try {
    const number = toBigInt(value || 0);
    return number > 0n ? number : 0n;
  } catch (_) {
    return 0n;
  }
}

function maxLong(...values) {
  return values.map(nonNegativeLong).reduce((max, value) => value > max ? value : max, 0n);
}

function compareLong(left, right) {
  const a = toBigInt(left || 0);
  const b = toBigInt(right || 0);
  return a === b ? 0 : a < b ? -1 : 1;
}

module.exports = {
  ALL_LIMIT,
  INVALID_REQUEST,
  TOP_LIMIT,
  buildCommonProfileData,
  buildGuildSimpleData,
  buildResponse,
  createLeaderboardHandlers,
  decodeRequest,
  getDefenceScore,
  getShadowPalaceTime,
  getTimeAttackScore,
  loadLeaderboardCatalog,
};
