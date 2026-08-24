"use strict";

const { parseGameTableDate } = require("../game-data");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");
const { getMiscItems, spendMiscItem, toBigInt } = require("../inventory");
const { buildCommonProfileData } = require("../leaderboard");
const {
  buildItemMiscData,
  buildRewardData,
  dateTimeBinaryNow,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeBool,
  writeFloatLE,
  writeInt64LE,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const { buildPlayerDeckForGameLoad } = require("../unit");

const PACKETS = Object.freeze({
  INFO_REQ: 3471,
  INFO_ACK: 3472,
  MEMBER_INFO_REQ: 3473,
  MEMBER_INFO_ACK: 3474,
  SEASON_REWARD_REQ: 3475,
  SEASON_REWARD_ACK: 3476,
  SESSION_REWARD_REQ: 3477,
  SESSION_REWARD_ACK: 3478,
  ARENA_PLAY_NOT: 3479,
  BOSS_PLAY_NOT: 3480,
  ARENA_PLAY_END_NOT: 3481,
  BOSS_PLAY_END_NOT: 3482,
  TICKET_BUY_REQ: 3483,
  TICKET_BUY_ACK: 3484,
  BOSS_GAME_LOAD_REQ: 3485,
  ARENA_CANCEL_NOT: 3486,
  BOSS_CANCEL_NOT: 3487,
  FLAG_REQ: 3491,
  FLAG_ACK: 3492,
  ARENA_FLAG_NOT: 3493,
  BOSS_ORDER_REQ: 3494,
  BOSS_ORDER_ACK: 3495,
  BOSS_ORDER_NOT: 3496,
  NOTICE_UPDATE_REQ: 3497,
  NOTICE_UPDATE_ACK: 3498,
  NOTICE_UPDATE_NOT: 3499,
  GAME_LOAD_ACK: 804,
});

const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_RESOURCE: 110,
  INVALID_REQUEST: 20191,
  NOT_A_MEMBER: 20443,
  NOT_ENOUGH_GRADE: 20480,
  GUILD_UPDATE_NOTICE: 20617,
  GUILD_NOTICE_MUTE: 20618,
  INVALID_GUILD_DATA: 20627,
  INVALID_DATE: 20628,
  DATA_ERROR: 20629,
  INVALID_STATE: 20630,
  INVALID_PLAYABLE_TIME: 20631,
  SESSION_OUT: 20632,
  INVALID_SEASON: 20633,
  INVALID_SESSION: 20634,
  SEASON_REWARD_TEMPLET: 20636,
  DUNGEON_INFO_TEMPLET: 20637,
  SEASON_OUT: 20638,
  SEASON_TEMPLET: 20639,
  SEASON_ID: 20640,
  INVALID_SESSION_DUNGEON_ID: 20641,
  INVALID_SEASON_DUNGEON_ID: 20642,
  INVALID_ARENA_INDEX: 20643,
  ARENA_PLAYING: 20644,
  ARENA_OVER_PLAY_COUNT: 20645,
  ARENA_MAX_ARTIFACT: 20646,
  TICKET_OVER: 20647,
  TICKET_MAX: 20648,
  TIME_OVER: 20649,
  ARENA_INVALID_PLAYER: 20650,
  BOSS_INVALID_INDEX: 20651,
  BOSS_INVALID_STAGE_ID: 20652,
  BOSS_ALL_CLEAR: 20653,
  BOSS_INVALID_PLAYER: 20654,
  BOSS_PLAYABLE: 20655,
  BOSS_INVALID_PACKET: 20656,
  BOSS_PLAYING: 20657,
  INVALID_SEASON_REWARD_REQUEST: 20668,
  INSUFFICIENT_PLAY_COUNT: 20669,
  INSUFFICIENT_POINT: 20670,
  EXISTS_PREVIOUS_REWARD: 20671,
  SESSION_ALREADY_REWARD: 20672,
  INVALID_REWARD_REQ: 20673,
  FLAG_INVALID_INDEX: 23902,
  ORDER_INVALID_INDEX: 23903,
});

const NGT_GUILD_DUNGEON_ARENA = 16;
const NGT_GUILD_DUNGEON_BOSS = 17;
const NGT_GUILD_DUNGEON_BOSS_PRACTICE = 25;
const SESSION_PLAY_DAYS = 5;
const SESSION_CYCLE_DAYS = 7;
const MS_PER_DAY = 86400000;
let cachedTables = null;

function createGuildDungeonHandlers() {
  return [
    handler(PACKETS.INFO_REQ, "GUILD_DUNGEON_INFO_REQ", (ctx, socket, packet) => {
      const req = decodeLongRequest(ctx, packet && packet.payload, "guildUid");
      const result = req.valid ? getGuildDungeonInfo(ctx, userFor(socket), req.guildUid) : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.INFO_ACK, buildInfoAckPayload(result), "guild-dungeon-info");
    }),
    handler(PACKETS.MEMBER_INFO_REQ, "GUILD_DUNGEON_MEMBER_INFO_REQ", (ctx, socket, packet) => {
      const req = decodeLongRequest(ctx, packet && packet.payload, "guildUid");
      const result = req.valid ? getGuildDungeonMemberInfo(ctx, userFor(socket), req.guildUid) : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.MEMBER_INFO_ACK, buildMemberInfoAckPayload(result), "guild-dungeon-member-info");
    }),
    handler(PACKETS.SEASON_REWARD_REQ, "GUILD_DUNGEON_SEASON_REWARD_REQ", (ctx, socket, packet) => {
      const req = decodeTwoIntRequest(ctx, packet && packet.payload, "category", "rewardCountValue");
      const result = req.valid ? claimSeasonReward(ctx, userFor(socket), req) : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.SEASON_REWARD_ACK, buildSeasonRewardAckPayload(result), "guild-dungeon-season-reward");
      persistResult(ctx, result, "guild-dungeon-season-reward");
    }),
    handler(PACKETS.SESSION_REWARD_REQ, "GUILD_DUNGEON_SESSION_REWARD_REQ", (ctx, socket, packet) => {
      const result = isEmptyRequest(ctx, packet && packet.payload)
        ? claimSessionReward(ctx, userFor(socket))
        : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.SESSION_REWARD_ACK, buildSessionRewardAckPayload(result), "guild-dungeon-session-reward");
      persistResult(ctx, result, "guild-dungeon-session-reward");
    }),
    handler(PACKETS.TICKET_BUY_REQ, "GUILD_DUNGEON_TICKET_BUY_REQ", (ctx, socket, packet) => {
      const result = isEmptyRequest(ctx, packet && packet.payload)
        ? buyArenaTicket(ctx, userFor(socket))
        : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.TICKET_BUY_ACK, buildTicketBuyAckPayload(result), "guild-dungeon-ticket-buy");
      persistResult(ctx, result, "guild-dungeon-ticket-buy");
    }),
    handler(PACKETS.BOSS_GAME_LOAD_REQ, "GUILD_DUNGEON_BOSS_GAME_LOAD_REQ", handleBossGameLoad),
    handler(PACKETS.FLAG_REQ, "GUILD_DUNGEON_FLAG_REQ", (ctx, socket, packet) => {
      const req = decodeFlagRequest(ctx, packet && packet.payload);
      const result = req.valid ? updateArenaFlag(ctx, userFor(socket), req) : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.FLAG_ACK, buildFlagAckPayload(result), "guild-dungeon-flag");
      if (result.changed) {
        notifyGuild(ctx, socket, result.guildUid, PACKETS.ARENA_FLAG_NOT, buildArenaFlagNotPayload(result), "guild-dungeon-flag-not");
        persistResult(ctx, result, "guild-dungeon-flag");
      }
    }),
    handler(PACKETS.BOSS_ORDER_REQ, "GUILD_DUNGEON_BOSS_ORDER_REQ", (ctx, socket, packet) => {
      const req = decodeOrderRequest(ctx, packet && packet.payload);
      const result = req.valid ? updateBossOrder(ctx, userFor(socket), req) : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.BOSS_ORDER_ACK, buildBossOrderAckPayload(result), "guild-dungeon-boss-order");
      if (result.changed) {
        notifyGuild(ctx, socket, result.guildUid, PACKETS.BOSS_ORDER_NOT, buildBossOrderNotPayload(result), "guild-dungeon-boss-order-not");
        persistResult(ctx, result, "guild-dungeon-boss-order");
      }
    }),
    handler(PACKETS.NOTICE_UPDATE_REQ, "GUILD_DUNGEON_NOTICE_UPDATE_REQ", (ctx, socket, packet) => {
      const req = decodeNoticeRequest(ctx, packet && packet.payload);
      const result = req.valid ? updateDungeonNotice(ctx, userFor(socket), req) : failure(ERRORS.INVALID_REQUEST);
      respond(ctx, socket, packet, PACKETS.NOTICE_UPDATE_ACK, buildNoticeUpdateAckPayload(result), "guild-dungeon-notice-update");
      if (result.changed) {
        notifyGuild(ctx, socket, result.guildUid, PACKETS.NOTICE_UPDATE_NOT, buildNoticeUpdateNotPayload(result), "guild-dungeon-notice-not", true);
        persistResult(ctx, result, "guild-dungeon-notice-update");
      }
    }),
  ];
}

function handler(packetId, name, run) {
  return { packetId, name, handle(ctx, socket, packet) { run(ctx, socket, packet); return true; } };
}

function getGuildDungeonInfo(ctx, user, requestedGuildUid) {
  const base = validateGuildAndSeason(ctx, user, requestedGuildUid);
  if (base.errorCode) return base;
  const shared = readSharedSession(ctx, base.guildUid, base.season, base.session);
  const arenas = buildArenaStates(base, shared);
  const boss = normalizeBossState(base, shared && shared.boss);
  const personal = getPersonalSession(user, base, false);
  boss.playCount = Math.max(0, base.tables.config.bossPlayCount - personal.bossRuns);
  return {
    ...base,
    errorCode: ERRORS.OK,
    state: 1,
    arenas,
    rewards: buildRewardProgress(user, base, shared),
    boss,
    ticketBuyCount: personal.ticketBuyCount,
    notice: readDungeonNotice(ctx, base.guildUid),
    canReward: hasClaimableReward(user, base, shared),
  };
}

function getGuildDungeonMemberInfo(ctx, user, requestedGuildUid) {
  const base = validateGuildAndSeason(ctx, user, requestedGuildUid);
  if (base.errorCode) return base;
  return {
    ...base,
    errorCode: ERRORS.OK,
    members: guildMembers(ctx, base.guildUid, user).map((member) => {
      const personal = getPersonalSession(member, base, false);
      return {
        profile: member,
        arenas: personal.arenaRuns,
        bossPoint: personal.bossPoint,
      };
    }),
  };
}

function claimSeasonReward(ctx, user, request) {
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return { ...base, category: request.category, rewardCountValue: request.rewardCountValue };
  const category = Number(request.category);
  if (category !== 0 && category !== 1) return seasonRewardFailure(ERRORS.INVALID_SEASON_REWARD_REQUEST, request);
  const categoryName = category === 0 ? "RANK" : "DUNGEON_TRY";
  const rows = base.season.rewards.filter((row) => row.category === categoryName);
  const rowIndex = rows.findIndex((row) => row.count === request.rewardCountValue);
  if (rowIndex < 0) return seasonRewardFailure(ERRORS.SEASON_REWARD_TEMPLET, request);
  const row = rows[rowIndex];
  const shared = readSharedSession(ctx, base.guildUid, base.season, base.session);
  const progress = getSeasonProgress(user, base, true);
  const total = category === 0 ? totalSeasonGuildPoints(base) : totalSeasonAttempts(user, base.season.id);
  if (total < request.rewardCountValue) {
    return seasonRewardFailure(category === 0 ? ERRORS.INSUFFICIENT_POINT : ERRORS.INSUFFICIENT_PLAY_COUNT, request);
  }
  const receivedKey = category === 0 ? "rank" : "try";
  const previous = rowIndex > 0 ? rows[rowIndex - 1].count : 0;
  if (progress.received[receivedKey] >= request.rewardCountValue) return seasonRewardFailure(ERRORS.INVALID_REWARD_REQ, request);
  if (progress.received[receivedKey] !== previous) return seasonRewardFailure(ERRORS.EXISTS_PREVIOUS_REWARD, request);
  const reward = grantRewardByType(ctx, user, row.type, row.itemId, row.value);
  progress.received[receivedKey] = request.rewardCountValue;
  return { changed: true, errorCode: ERRORS.OK, category, rewardCountValue: request.rewardCountValue, reward };
}

function claimSessionReward(ctx, user) {
  if (!user || guildUid(user) <= 0n) {
    return { ...failure(ERRORS.NOT_A_MEMBER), stageIndex: 0, remainHp: 0, clearPoint: 0, rewardItems: [], artifactItems: [] };
  }
  const tables = loadTables();
  const now = getNow(ctx);
  const seasons = tables.seasons
    .filter((season) => season.start <= now)
    .sort((left, right) => right.start - left.start);
  for (const season of seasons) {
    const maxSession = Math.ceil((season.end - season.start) / (SESSION_CYCLE_DAYS * MS_PER_DAY));
    for (let index = maxSession; index >= 1; index -= 1) {
      const session = sessionForIndex(season, index);
      if (session.end > now) continue;
      const base = { tables, season, session, guildUid: guildUid(user) };
      const personal = getPersonalSession(user, base, true);
      if (!personal.sessionRewardClaimed && (personal.arenaRuns.length || personal.bossRuns)) {
        const shared = readSharedSession(ctx, base.guildUid, season, session);
        const reward = buildSessionReward(ctx, user, base, shared);
        personal.sessionRewardClaimed = true;
        return { changed: true, errorCode: ERRORS.OK, ...reward };
      }
    }
  }
  return { ...failure(ERRORS.SESSION_ALREADY_REWARD), stageIndex: 0, remainHp: 0, clearPoint: 0, rewardItems: [], artifactItems: [] };
}

function buyArenaTicket(ctx, user) {
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return { ...base, currentTicketBuyCount: 0, costItem: null };
  const personal = getPersonalSession(user, base, true);
  if (personal.ticketBuyCount >= base.tables.config.ticketBuyCount) {
    return { ...failure(ERRORS.TICKET_MAX), currentTicketBuyCount: personal.ticketBuyCount, costItem: null };
  }
  const balance = getMiscItems(user).find((item) => Number(item.itemId) === 101);
  if (toBigInt(balance && balance.countFree || 0) + toBigInt(balance && balance.countPaid || 0) < BigInt(base.tables.config.ticketCost)) {
    return { ...failure(ERRORS.INSUFFICIENT_RESOURCE), currentTicketBuyCount: personal.ticketBuyCount, costItem: null };
  }
  const costItem = spendMiscItem(user, 101, base.tables.config.ticketCost);
  personal.ticketBuyCount += 1;
  return { changed: true, errorCode: ERRORS.OK, currentTicketBuyCount: personal.ticketBuyCount, costItem };
}

function prepareArenaGameLoad(ctx, user, request, stage) {
  const dungeonId = Number(request && request.dungeonID || stage && stage.dungeonID || 0);
  const tables = loadTables();
  if (!tables.arenaByDungeonId.has(dungeonId)) return null;
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return { valid: false, errorCode: base.errorCode };
  const arena = arenaInfoFor(base, dungeonId);
  if (!arena) return { valid: false, errorCode: ERRORS.INVALID_SEASON_DUNGEON_ID };
  if (!base.session.dungeonIds.includes(dungeonId) || arena.group !== base.season.dungeonGroup) {
    return { valid: false, errorCode: ERRORS.INVALID_SESSION_DUNGEON_ID };
  }
  const shared = readSharedSession(ctx, base.guildUid, base.season, base.session);
  const arenaState = normalizeArenaState(arena.index, shared && shared.arenas && shared.arenas[String(arena.index)]);
  if (arenaState.playUserUid !== 0n) return { valid: false, errorCode: ERRORS.ARENA_PLAYING };
  const personal = getPersonalSession(user, base, false);
  if (personal.arenaRuns.length >= tables.config.arenaPlayCount + personal.ticketBuyCount) {
    return { valid: false, errorCode: ERRORS.ARENA_OVER_PLAY_COUNT };
  }
  return {
    valid: true,
    base,
    arena,
    stage: {
      ...stage,
      stageId: Number(stage && stage.stageId || dungeonId),
      dungeonID: dungeonId,
      gameType: NGT_GUILD_DUNGEON_ARENA,
      miscMode: "guild-dungeon-arena",
      guildDungeonArenaIndex: arena.index,
      guildDungeonSeasonId: base.season.id,
      guildDungeonSessionId: base.session.id,
    },
  };
}

function handleBossGameLoad(ctx, socket, packet) {
  const request = decodeBossGameLoadRequest(ctx, packet && packet.payload);
  const user = userFor(socket);
  const result = request.valid ? prepareBossGameLoad(ctx, user, request) : { valid: false, errorCode: ERRORS.INVALID_REQUEST };
  if (!result.valid) {
    if (ctx && typeof ctx.sendServerGamePacket === "function") {
      ctx.sendServerGamePacket(socket, PACKETS.GAME_LOAD_ACK, buildGameLoadFailurePayload(result.errorCode), "guild-dungeon-boss-load-rejected");
    }
    return;
  }
  const sent = ctx && typeof ctx.sendDynamicGameLoadAck === "function" && ctx.sendDynamicGameLoadAck(socket, result.request, result.stage);
  if (!sent) {
    ctx.sendServerGamePacket(socket, PACKETS.GAME_LOAD_ACK, buildGameLoadFailurePayload(ERRORS.DATA_ERROR), "guild-dungeon-boss-load-failed");
    return;
  }
  commitBattleStart(ctx, socket, result.stage);
}

function prepareBossGameLoad(ctx, user, request) {
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return { valid: false, errorCode: base.errorCode };
  const shared = readSharedSession(ctx, base.guildUid, base.season, base.session);
  const boss = normalizeBossState(base, shared && shared.boss);
  if (boss.stageId !== request.bossStageId) return { valid: false, errorCode: ERRORS.BOSS_INVALID_STAGE_ID };
  if (boss.remainHp <= 0) return { valid: false, errorCode: ERRORS.BOSS_ALL_CLEAR };
  if (!request.isPractice && boss.playUserUid !== 0n) return { valid: false, errorCode: ERRORS.BOSS_PLAYING };
  const personal = getPersonalSession(user, base, false);
  if (!request.isPractice && personal.bossRuns >= base.tables.config.bossPlayCount) {
    return { valid: false, errorCode: ERRORS.BOSS_PLAYABLE };
  }
  const deck = buildPlayerDeckForGameLoad(user, { selectDeckIndex: request.deckIndex }, {
    deckIndex: { deckType: 3, index: request.deckIndex },
    strictSelection: true,
  });
  if (!deck) return { valid: false, errorCode: ERRORS.BOSS_INVALID_PACKET };
  const stage = ctx && typeof ctx.getGenericStageForRequest === "function"
    ? ctx.getGenericStageForRequest({ stageID: request.bossStageId, dungeonID: request.bossStageId })
    : null;
  if (!stage) return { valid: false, errorCode: ERRORS.DUNGEON_INFO_TEMPLET };
  const gameType = request.isPractice ? NGT_GUILD_DUNGEON_BOSS_PRACTICE : NGT_GUILD_DUNGEON_BOSS;
  return {
    valid: true,
    request: { selectDeckIndex: request.deckIndex, stageID: stage.stageId, dungeonID: request.bossStageId, gameType },
    stage: {
      ...stage,
      dungeonID: request.bossStageId,
      gameType,
      miscMode: request.isPractice ? "guild-dungeon-boss-practice" : "guild-dungeon-boss",
      playerDeck: deck,
      guildDungeonSeasonId: base.season.id,
      guildDungeonSessionId: base.session.id,
      guildDungeonBossStageId: request.bossStageId,
      guildDungeonPractice: request.isPractice,
    },
  };
}

function commitBattleStart(ctx, socket, stage) {
  const user = userFor(socket);
  if (!user || !stage || !String(stage.miscMode || "").startsWith("guild-dungeon")) return false;
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return false;
  const shared = ensureSharedSession(ctx, base.guildUid, base);
  const uid = userUid(user);
  if (stage.miscMode === "guild-dungeon-arena") {
    const index = Number(stage.guildDungeonArenaIndex || 0);
    const arena = normalizeArenaState(index, shared.arenas[String(index)]);
    arena.playUserUid = uid;
    shared.arenas[String(index)] = storeArenaState(arena);
    syncSharedSession(ctx, base.guildUid, base, shared);
    notifyGuild(ctx, socket, base.guildUid, PACKETS.ARENA_PLAY_NOT, buildArenaPlayNotPayload(index, uid), "guild-dungeon-arena-play");
  } else if (stage.miscMode === "guild-dungeon-boss" && !stage.guildDungeonPractice) {
    const boss = normalizeBossState(base, shared.boss);
    boss.playUserUid = uid;
    shared.boss = storeBossState(boss);
    syncSharedSession(ctx, base.guildUid, base, shared);
    notifyGuild(ctx, socket, base.guildUid, PACKETS.BOSS_PLAY_NOT, buildBossPlayNotPayload(uid), "guild-dungeon-boss-play");
  } else {
    return false;
  }
  persist(ctx, "guild-dungeon-battle-start");
  return true;
}

function commitBattleResult(ctx, socket, replay, overrideState) {
  const dynamic = replay && replay.dynamicGame;
  const mode = String(dynamic && dynamic.miscMode || "");
  if (!mode.startsWith("guild-dungeon") || replay.guildDungeonResultPersisted) return false;
  if (mode === "guild-dungeon-boss-practice" || dynamic.guildDungeonPractice) {
    replay.guildDungeonResultPersisted = true;
    return false;
  }
  const user = userFor(socket);
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return false;
  const last = replay.lastDynamicGameEndResult || {};
  const battleState = last.battleState || overrideState || replay.battleState || {};
  const win = last.win === true && !last.giveup;
  const shared = ensureSharedSession(ctx, base.guildUid, base);
  const personal = getPersonalSession(user, base, true);
  if (mode === "guild-dungeon-arena") {
    const arenaInfo = arenaInfoFor(base, Number(dynamic.dungeonID || 0));
    if (!arenaInfo) return false;
    const arena = normalizeArenaState(arenaInfo.index, shared.arenas[String(arenaInfo.index)]);
    if (arena.playUserUid !== userUid(user)) return false;
    const grade = win ? 1 + Number(Boolean(battleState.missionResult1)) + Number(Boolean(battleState.missionResult2)) : 0;
    arena.playUserUid = 0n;
    arena.totalMedalCount += grade;
    shared.arenas[String(arena.index)] = storeArenaState(arena);
    personal.arenaRuns.push({ arenaId: arenaInfo.dungeonId, grade, regDate: String(dateTimeBinaryNow()) });
    bumpShared(shared);
    syncSharedSession(ctx, base.guildUid, base, shared);
    notifyGuild(ctx, socket, base.guildUid, PACKETS.ARENA_PLAY_END_NOT, buildArenaPlayEndNotPayload({
      errorCode: ERRORS.OK,
      playedUserUid: userUid(user),
      arenaId: arenaInfo.dungeonId,
      totalGrade: arena.totalMedalCount,
    }), "guild-dungeon-arena-end");
  } else if (mode === "guild-dungeon-boss") {
    const boss = normalizeBossState(base, shared.boss);
    if (boss.playUserUid !== userUid(user)) return false;
    const raid = base.tables.raidByStageId.get(boss.stageId);
    if (!raid) return false;
    const damage = win ? boss.remainHp : Math.min(boss.remainHp, Math.max(0, Math.round(totalPlayerDamage(battleState, replay))));
    boss.remainHp = Math.max(0, boss.remainHp - damage);
    const point = boss.remainHp === 0 ? raid.rewardPoint : 0;
    boss.totalPoint += point;
    personal.bossPoint += point;
    personal.bossRuns += 1;
    if (boss.remainHp === 0) {
      shared.clearedBossStage = Math.max(Number(shared.clearedBossStage || 0), raid.index);
      const next = base.tables.raidByIndex.get(raid.index + 1);
      if (next) {
        boss.stageId = next.stageId;
        boss.remainHp = bossMaxHp(next.stageId);
      }
    }
    boss.playUserUid = 0n;
    shared.boss = storeBossState(boss);
    bumpShared(shared);
    syncSharedSession(ctx, base.guildUid, base, shared);
    notifyGuild(ctx, socket, base.guildUid, PACKETS.BOSS_PLAY_END_NOT, buildBossPlayEndNotPayload({
      playedUserUid: userUid(user),
      bossStageId: raid.stageId,
      damage,
      remainHp: boss.stageId === raid.stageId ? boss.remainHp : 0,
      totalPoint: boss.totalPoint,
      extraPoint: boss.extraPoint,
      point,
    }), "guild-dungeon-boss-end");
  } else {
    return false;
  }
  replay.guildDungeonResultPersisted = true;
  persist(ctx, "guild-dungeon-battle-result");
  return true;
}

function abandonBattle(ctx, socket, dynamic) {
  const mode = String(dynamic && dynamic.miscMode || "");
  if (!mode.startsWith("guild-dungeon") || mode === "guild-dungeon-boss-practice") return false;
  const user = userFor(socket);
  const base = validateGuildAndSeason(ctx, user, guildUid(user));
  if (base.errorCode) return false;
  const shared = ensureSharedSession(ctx, base.guildUid, base);
  if (mode === "guild-dungeon-arena") {
    const arenaInfo = arenaInfoFor(base, Number(dynamic.dungeonID || 0));
    const arenaIndex = Number(dynamic.guildDungeonArenaIndex || arenaInfo && arenaInfo.index || 0);
    const arena = normalizeArenaState(arenaIndex, shared.arenas[String(arenaIndex)]);
    if (arena.playUserUid !== userUid(user)) return false;
    arena.playUserUid = 0n;
    shared.arenas[String(arena.index)] = storeArenaState(arena);
    syncSharedSession(ctx, base.guildUid, base, shared);
    notifyGuild(ctx, socket, base.guildUid, PACKETS.ARENA_CANCEL_NOT, writeSignedVarInt(arena.index), "guild-dungeon-arena-cancel");
  } else {
    const boss = normalizeBossState(base, shared.boss);
    if (boss.playUserUid !== userUid(user)) return false;
    boss.playUserUid = 0n;
    shared.boss = storeBossState(boss);
    syncSharedSession(ctx, base.guildUid, base, shared);
    notifyGuild(ctx, socket, base.guildUid, PACKETS.BOSS_CANCEL_NOT, writeSignedVarLong(userUid(user)), "guild-dungeon-boss-cancel");
  }
  persist(ctx, "guild-dungeon-battle-cancel");
  return true;
}

function updateArenaFlag(ctx, user, request) {
  const base = validateGuildAndSeason(ctx, user, request.guildUid);
  if (base.errorCode) return { ...base, arenaIndex: request.arenaIndex, flagIndex: request.flagIndex };
  const arenaInfo = base.session.dungeonIds
    .map((dungeonId) => arenaInfoFor(base, dungeonId))
    .find((item) => item && item.index === request.arenaIndex);
  if (!arenaInfo || !base.session.dungeonIds.includes(arenaInfo.dungeonId)) return flagFailure(ERRORS.INVALID_ARENA_INDEX, base, request);
  const shared = ensureSharedSession(ctx, base.guildUid, base);
  const arena = normalizeArenaState(request.arenaIndex, shared.arenas[String(request.arenaIndex)]);
  const unlocked = Math.floor(arena.totalMedalCount / base.tables.config.artifactFulfillmentCount);
  if (request.flagIndex < -1 || request.flagIndex >= unlocked) return flagFailure(ERRORS.FLAG_INVALID_INDEX, base, request);
  if (arena.flagIndex === request.flagIndex) return { ...flagFailure(ERRORS.OK, base, request), changed: false };
  arena.flagIndex = request.flagIndex;
  shared.arenas[String(request.arenaIndex)] = storeArenaState(arena);
  bumpShared(shared);
  syncSharedSession(ctx, base.guildUid, base, shared);
  return { changed: true, errorCode: ERRORS.OK, guildUid: base.guildUid, arenaIndex: request.arenaIndex, flagIndex: request.flagIndex };
}

function updateBossOrder(ctx, user, request) {
  const base = validateGuildAndSeason(ctx, user, request.guildUid);
  if (base.errorCode) return { ...base, orderIndex: request.orderIndex };
  if (request.orderIndex < 0 || request.orderIndex > 2) return { ...failure(ERRORS.ORDER_INVALID_INDEX), guildUid: base.guildUid, orderIndex: request.orderIndex };
  const shared = ensureSharedSession(ctx, base.guildUid, base);
  const boss = normalizeBossState(base, shared.boss);
  if (boss.orderIndex === request.orderIndex) return { changed: false, errorCode: ERRORS.OK, guildUid: base.guildUid, orderIndex: request.orderIndex };
  boss.orderIndex = request.orderIndex;
  shared.boss = storeBossState(boss);
  bumpShared(shared);
  syncSharedSession(ctx, base.guildUid, base, shared);
  return { changed: true, errorCode: ERRORS.OK, guildUid: base.guildUid, orderIndex: request.orderIndex };
}

function updateDungeonNotice(ctx, user, request) {
  const ownGuildUid = guildUid(user);
  if (ownGuildUid <= 0n) return noticeFailure(ERRORS.NOT_A_MEMBER, request);
  if (request.guildUid !== ownGuildUid) return noticeFailure(ERRORS.INVALID_GUILD_DATA, request);
  if (guildGrade(user) > 1) return noticeFailure(ERRORS.NOT_ENOUGH_GRADE, request);
  if (request.notice.length > 200) return noticeFailure(ERRORS.GUILD_NOTICE_MUTE, request);
  const before = readDungeonNotice(ctx, ownGuildUid);
  if (before === request.notice) return { changed: false, errorCode: ERRORS.OK, guildUid: ownGuildUid, noticeBefore: before, notice: request.notice };
  for (const member of guildMembers(ctx, ownGuildUid, user)) {
    member.guildDungeonNotice = request.notice;
    if (member.guild && typeof member.guild === "object") member.guild.dungeonNotice = request.notice;
  }
  return { changed: true, errorCode: ERRORS.OK, guildUid: ownGuildUid, noticeBefore: before, notice: request.notice };
}

function buildGuildDungeonRewardInfoData(user, options = {}) {
  const ctx = options.ctx || {};
  const base = validateGuildAndSeason(ctx, user, guildUid(user), { now: options.now });
  if (base.errorCode) {
    return {
      currentSeasonId: 0,
      rewards: [
        { category: 0, totalValue: 0, receivedValue: 0 },
        { category: 1, totalValue: 0, receivedValue: 0 },
      ],
      canReward: false,
    };
  }
  const shared = readSharedSession(ctx, base.guildUid, base.season, base.session);
  return {
    currentSeasonId: base.season.id,
    rewards: buildRewardProgress(user, base, shared),
    canReward: hasClaimableReward(user, base, shared),
  };
}

function serializeGuildDungeonRewardInfo(data) {
  const value = data || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.currentSeasonId || 0)),
    writeNullableObjectList((value.rewards || []).map(buildSeasonRewardProgressData)),
    writeBool(Boolean(value.canReward)),
  ]);
}

function buildInfoAckPayload(result) {
  const value = result || failure(ERRORS.DATA_ERROR);
  return Buffer.concat([
    writeSignedVarInt(value.errorCode),
    writeSignedVarInt(Number(value.state || 0)),
    writeSignedVarInt(Number(value.season && value.season.id || 0)),
    writeSignedVarInt(Number(value.session && value.session.id || 0)),
    writeInt64LE(dateTime(value.session && value.session.end)),
    writeInt64LE(dateTime(value.session && value.session.nextStart)),
    writeNullableObjectList((value.arenas || []).map(buildArenaData)),
    writeNullableObjectList((value.rewards || []).map(buildSeasonRewardProgressData)),
    value.boss ? writeNullableObject(buildBossData(value.boss)) : writeNullObject(),
    writeSignedVarInt(Number(value.ticketBuyCount || 0)),
    writeBool(Boolean(value.canReward)),
  ]);
}

function buildMemberInfoAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result && result.errorCode || 0)),
    writeNullableObjectList((result && result.members || []).map(buildMemberInfoData)),
  ]);
}

function buildMemberInfoData(value) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(value.profile || {})),
    writeNullableObjectList((value.arenas || []).map(buildMemberArenaData)),
    writeSignedVarInt(Number(value.bossPoint || 0)),
  ]);
}

function buildMemberArenaData(value) {
  return Buffer.concat([
    writeSignedVarInt(Number(value.arenaId || 0)),
    writeSignedVarInt(Number(value.grade || 0)),
    writeInt64LE(toBigInt(value.regDate || 0)),
  ]);
}

function buildArenaData(value) {
  return Buffer.concat([
    writeSignedVarInt(Number(value.index || 0)),
    writeSignedVarInt(Number(value.totalMedalCount || 0)),
    writeSignedVarLong(toBigInt(value.playUserUid || 0)),
    writeSignedVarInt(Number(value.flagIndex == null ? -1 : value.flagIndex)),
  ]);
}

function buildBossData(value) {
  return Buffer.concat([
    writeSignedVarInt(Number(value.stageId || 0)),
    writeSignedVarInt(Number(value.playCount || 0)),
    writeFloatLE(Number(value.remainHp || 0)),
    writeSignedVarInt(Number(value.totalPoint || 0)),
    writeSignedVarInt(Number(value.extraPoint || 0)),
    writeSignedVarLong(toBigInt(value.playUserUid || 0)),
    writeSignedVarInt(Number(value.orderIndex || 0)),
  ]);
}

function buildSeasonRewardProgressData(value) {
  return Buffer.concat([
    writeSignedVarInt(Number(value.category || 0)),
    writeSignedVarInt(Number(value.totalValue || 0)),
    writeSignedVarInt(Number(value.receivedValue || 0)),
  ]);
}

function buildSeasonRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result && result.errorCode || 0)),
    writeSignedVarInt(Number(result && result.category || 0)),
    writeSignedVarInt(Number(result && result.rewardCountValue || 0)),
    result && result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
  ]);
}

function buildSessionRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result && result.errorCode || 0)),
    writeSignedVarInt(Number(result && result.stageIndex || 0)),
    writeSignedVarLong(toBigInt(Math.round(Number(result && result.remainHp || 0)))),
    writeSignedVarInt(Number(result && result.clearPoint || 0)),
    writeNullableObjectList((result && result.rewardItems || []).map(buildItemMiscData)),
    writeNullableObjectList((result && result.artifactItems || []).map(buildItemMiscData)),
  ]);
}

function buildTicketBuyAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result && result.errorCode || 0)),
    writeSignedVarInt(Number(result && result.currentTicketBuyCount || 0)),
    result && result.costItem ? writeNullableObject(buildItemMiscData(result.costItem)) : writeNullObject(),
  ]);
}

function buildFlagAckPayload(result) {
  return Buffer.concat([writeSignedVarInt(Number(result && result.errorCode || 0)), writeSignedVarInt(Number(result && result.arenaIndex || 0)), writeSignedVarInt(Number(result && result.flagIndex == null ? -1 : result.flagIndex))]);
}

function buildArenaFlagNotPayload(result) {
  return Buffer.concat([writeSignedVarInt(Number(result.arenaIndex || 0)), writeSignedVarInt(Number(result.flagIndex == null ? -1 : result.flagIndex))]);
}

function buildBossOrderAckPayload(result) {
  return Buffer.concat([writeSignedVarInt(Number(result && result.errorCode || 0)), writeSignedVarInt(Number(result && result.orderIndex || 0))]);
}

function buildBossOrderNotPayload(result) { return writeSignedVarInt(Number(result && result.orderIndex || 0)); }
function buildArenaPlayNotPayload(arenaId, uid) { return Buffer.concat([writeSignedVarInt(arenaId), writeSignedVarLong(uid)]); }
function buildBossPlayNotPayload(uid) { return writeSignedVarLong(uid); }
function buildArenaPlayEndNotPayload(value) { return Buffer.concat([writeSignedVarInt(value.errorCode), writeSignedVarLong(value.playedUserUid), writeSignedVarInt(value.arenaId), writeSignedVarInt(value.totalGrade)]); }
function buildBossPlayEndNotPayload(value) { return Buffer.concat([writeSignedVarLong(value.playedUserUid), writeSignedVarInt(value.bossStageId), writeFloatLE(value.damage), writeFloatLE(value.remainHp), writeSignedVarInt(value.totalPoint), writeSignedVarInt(value.extraPoint), writeSignedVarInt(value.point)]); }
function buildNoticeUpdateAckPayload(value) { return Buffer.concat([writeSignedVarInt(Number(value && value.errorCode || 0)), writeSignedVarLong(toBigInt(value && value.guildUid || 0)), writeString(value && value.noticeBefore || ""), writeString(value && value.notice || "")]); }
function buildNoticeUpdateNotPayload(value) { return Buffer.concat([writeSignedVarLong(toBigInt(value && value.guildUid || 0)), writeString(value && value.notice || "")]); }
function buildGameLoadFailurePayload(errorCode) { return Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeSignedVarInt(0)]); }

function buildRewardProgress(user, base, shared) {
  const progress = getSeasonProgress(user, base, false);
  return [
    { category: 0, totalValue: totalSeasonGuildPoints(base), receivedValue: progress.received.rank },
    { category: 1, totalValue: totalSeasonAttempts(user, base.season.id), receivedValue: progress.received.try },
  ];
}

function hasClaimableReward(user, base, shared) {
  return buildRewardProgress(user, base, shared).some((progress) => base.season.rewards.some((row) =>
    row.category === (progress.category === 0 ? "RANK" : "DUNGEON_TRY") &&
    row.count > progress.receivedValue && row.count <= progress.totalValue
  ));
}

function buildSessionReward(ctx, user, base, shared) {
  const cleared = Math.max(0, Number(shared && shared.clearedBossStage || 0));
  const raidTotals = new Map();
  for (let index = 1; index <= cleared; index += 1) {
    const row = base.tables.raidByIndex.get(index);
    if (row && row.itemId > 0 && row.itemValue > 0) raidTotals.set(row.itemId, Number(raidTotals.get(row.itemId) || 0) + row.itemValue);
  }
  const artifactTotals = new Map();
  for (const arena of buildArenaStates(base, shared)) {
    const info = base.session.dungeonIds
      .map((dungeonId) => arenaInfoFor(base, dungeonId))
      .find((item) => item && item.index === arena.index);
    const rows = info ? base.tables.artifactsByGroup.get(info.artifactGroup) || [] : [];
    const count = Math.min(rows.length, Math.floor(arena.totalMedalCount / base.tables.config.artifactFulfillmentCount));
    for (const row of rows.slice(0, count)) artifactTotals.set(row.itemId, Number(artifactTotals.get(row.itemId) || 0) + row.value);
  }
  const reward = createEmptyReward();
  for (const [itemId, count] of raidTotals) mergeReward(reward, grantRewardByType(ctx, user, "RT_MISC", itemId, count));
  const artifactReward = createEmptyReward();
  for (const [itemId, rawCount] of artifactTotals) {
    const limit = base.tables.config.sessionRewardLimits.get(itemId);
    const count = limit ? Math.min(rawCount, limit) : rawCount;
    mergeReward(artifactReward, grantRewardByType(ctx, user, "RT_MISC", itemId, count));
  }
  return {
    stageIndex: cleared,
    remainHp: Math.round(normalizeBossState(base, shared && shared.boss).remainHp),
    clearPoint: normalizeBossState(base, shared && shared.boss).totalPoint,
    rewardItems: reward.miscItems,
    artifactItems: artifactReward.miscItems,
  };
}

function validateGuildAndSeason(ctx, user, requestedGuildUid, options = {}) {
  const ownGuildUid = guildUid(user);
  if (!user || ownGuildUid <= 0n) return failure(ERRORS.NOT_A_MEMBER);
  if (toBigInt(requestedGuildUid || 0) !== ownGuildUid) return failure(ERRORS.INVALID_GUILD_DATA);
  const tables = loadTables();
  const now = options.now instanceof Date ? options.now : getNow(ctx);
  const season = tables.seasons.find((item) => item.start <= now && now < item.end);
  if (!season) return failure(ERRORS.SEASON_OUT);
  const session = currentSession(season, now);
  if (!session) return failure(ERRORS.SESSION_OUT);
  return { errorCode: ERRORS.OK, ctx, tables, now, season, session, guildUid: ownGuildUid };
}

function currentSession(season, now) {
  const index = Math.floor((now - season.start) / (SESSION_CYCLE_DAYS * MS_PER_DAY)) + 1;
  const session = sessionForIndex(season, index);
  return session.start <= now && now < session.end ? session : null;
}

function sessionForIndex(season, index) {
  const start = new Date(season.start.getTime() + (index - 1) * SESSION_CYCLE_DAYS * MS_PER_DAY);
  const end = new Date(Math.min(season.end.getTime(), start.getTime() + SESSION_PLAY_DAYS * MS_PER_DAY));
  const nextStartDate = new Date(start.getTime() + SESSION_CYCLE_DAYS * MS_PER_DAY);
  return {
    id: index,
    start,
    end,
    nextStart: nextStartDate < season.end ? nextStartDate : season.end,
    dungeonIds: season.schedules.get(index) || [],
  };
}

function loadTables() {
  if (cachedTables) return cachedTables;
  const intervals = new Map(readGameplayTableRecords("ab_script", "LUA_INTERVAL_TEMPLET").map((row) => [String(row.m_DateStrID || ""), row]));
  const schedulesByGroup = new Map();
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_DUNGEON_SCHEDULE_TEMPLET")) {
    const group = Number(row.m_SeasonDungeonGroup || 0);
    if (!schedulesByGroup.has(group)) schedulesByGroup.set(group, new Map());
    schedulesByGroup.get(group).set(Number(row.m_SeasonSessionIndex || 0), [1, 2, 3, 4].map((index) => Number(row[`m_UseSeasonDungeonID_${index}`] || 0)).filter(Boolean));
  }
  const seasons = readGameplayTableRecords("ab_script", "LUA_GUILD_SEASON_TEMPLET").map((row) => {
    const interval = intervals.get(String(row.m_DateStrID || "")) || {};
    return {
      id: Number(row.m_SeasonID || 0),
      dungeonGroup: Number(row.m_SeasonDungeonGroup || 0),
      raidGroup: Number(row.m_SeasonRaidGroup || 0),
      rewardGroup: Number(row.m_SeasonRewardGroup || 0),
      start: parseGameTableDate(interval.m_DateStart),
      end: parseGameTableDate(interval.m_DateEnd),
      schedules: schedulesByGroup.get(Number(row.m_SeasonDungeonGroup || 0)) || new Map(),
    };
  }).filter((row) => row.id && row.start && row.end);
  const arenaByDungeonId = new Map();
  const arenaByGroupDungeonId = new Map();
  const arenaByIndex = new Map();
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_DUNGEON_INFO_TEMPLET")) {
    const item = { group: Number(row.m_SeasonDungeonGroup || 0), index: Number(row.m_StageArenaIndex || 0), dungeonId: Number(row.m_SeasonDungeonID || 0), artifactGroup: Number(row.m_StageRewardArtifactGroup || 0) };
    if (!arenaByDungeonId.has(item.dungeonId)) arenaByDungeonId.set(item.dungeonId, item);
    arenaByGroupDungeonId.set(`${item.group}:${item.dungeonId}`, item);
  }
  for (const item of arenaByDungeonId.values()) {
    const existing = arenaByIndex.get(item.index);
    if (!existing || item.dungeonId % 10 === 1) arenaByIndex.set(item.index, item);
  }
  const raidByStageId = new Map();
  const raidByIndex = new Map();
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_RAID_TEMPLET")) {
    if (Number(row.m_SeasonRaidGroup || 0) !== 10001) continue;
    const item = { index: Number(row.m_RaidStageIndex || 0), stageId: Number(row.m_StageID || 0), rewardPoint: Number(row.m_RaidRewardPoint || 0), itemId: Number(row.m_RaidRewardID || 0), itemValue: Number(row.m_RaidRewardValue || 0) };
    raidByStageId.set(item.stageId, item);
    raidByIndex.set(item.index, item);
  }
  const artifactsByGroup = new Map();
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_DUNGEON_ARTIFACT_TEMPLET")) {
    const group = Number(row.m_StageRewardArtifactGroup || 0);
    if (!artifactsByGroup.has(group)) artifactsByGroup.set(group, []);
    artifactsByGroup.get(group).push({ order: Number(row.m_ArtifactOrder || 0), itemId: Number(row.m_ReturnPriceID || 0), value: Number(row.m_ReturnPriceValue || 0) });
  }
  for (const rows of artifactsByGroup.values()) rows.sort((left, right) => left.order - right.order);
  const seasonRewards = readGameplayTableRecords("ab_script", "LUA_GUILD_SEASON_REWARD_TEMPLET").map((row) => ({ group: Number(row.m_SeasonRewardGroup || 0), category: String(row.m_RewardCategory || ""), count: Number(row.m_RewardCountValue || 0), type: String(row.m_RewardItemType || ""), itemId: Number(row.m_RewardItemID || 0), value: Number(row.m_RewardItemValue || 0) }));
  const common = readGameplayTable("ab_script", "LUA_COMMON_CONST") || {};
  const constants = common.globals && common.globals.GUILD_DUNGEON || {};
  const basic = constants.BASIC_CONST || {};
  const config = {
    ticketBuyCount: Number(basic.ARENA_TICKET_BUY_COUNT || 1),
    arenaPlayCount: Number(basic.ARENA_PLAY_COUNT_BASIC || 5),
    bossPlayCount: Number(basic.BOSS_PLAY_COUNT_BASIC || 5),
    artifactFulfillmentCount: Number(basic.ARTIFACT_FULIFICATION_COUNT || 10),
    ticketCost: Number(basic.TICKET_COST || 200),
    sessionRewardLimits: new Map((constants.SESSION_REWARD_LIMIT || []).map((row) => [Number(row.ITEM_ID || 0), Number(row.ITEM_LIMIT_VALUE || 0)])),
  };
  cachedTables = { seasons, arenaByDungeonId, arenaByGroupDungeonId, arenaByIndex, raidByStageId, raidByIndex, artifactsByGroup, seasonRewards, config };
  for (const season of seasons) seasonRewardsForSeason(season, cachedTables);
  return cachedTables;
}

function seasonRewardsForSeason(season, tables) {
  const rows = tables.seasonRewards.filter((row) => row.group === season.rewardGroup).sort((left, right) => left.count - right.count);
  season.rewards = rows;
  return rows;
}

function buildArenaStates(base, shared) {
  return base.session.dungeonIds.map((id) => arenaInfoFor(base, id)).filter(Boolean).map((info) => normalizeArenaState(info.index, shared && shared.arenas && shared.arenas[String(info.index)]));
}

function arenaInfoFor(base, dungeonId) {
  return base.tables.arenaByGroupDungeonId.get(`${base.season.dungeonGroup}:${Number(dungeonId || 0)}`) || null;
}

function normalizeArenaState(index, source) {
  return { index: Number(index || 0), totalMedalCount: Math.max(0, Number(source && source.totalMedalCount || 0)), playUserUid: toBigInt(source && source.playUserUid || 0), flagIndex: Number(source && source.flagIndex != null ? source.flagIndex : -1) };
}

function storeArenaState(value) { return { totalMedalCount: value.totalMedalCount, playUserUid: String(value.playUserUid), flagIndex: value.flagIndex }; }

function normalizeBossState(base, source) {
  const first = base.tables.raidByIndex.get(1);
  const stageId = Number(source && source.stageId || first && first.stageId || 0);
  return { stageId, playCount: base.tables.config.bossPlayCount, remainHp: Math.max(0, Number(source && source.remainHp != null ? source.remainHp : bossMaxHp(stageId))), totalPoint: Math.max(0, Number(source && source.totalPoint || 0)), extraPoint: Math.max(0, Number(source && source.extraPoint || 0)), playUserUid: toBigInt(source && source.playUserUid || 0), orderIndex: Math.max(0, Number(source && source.orderIndex || 0)) };
}

function storeBossState(value) { return { stageId: value.stageId, remainHp: value.remainHp, totalPoint: value.totalPoint, extraPoint: value.extraPoint, playUserUid: String(value.playUserUid), orderIndex: value.orderIndex }; }
function bossMaxHp(stageId) { return Math.max(1, 3004054 + 360487 * (Math.max(60, 50 + (Number(stageId || 8011301) - 8011300) * 10) - 1)); }

function getPersonalSession(user, base, create) {
  const root = user && user.guildDungeon && typeof user.guildDungeon === "object" ? user.guildDungeon : {};
  const sessions = root.sessions && typeof root.sessions === "object" ? root.sessions : {};
  const key = `${base.season.id}:${base.session.id}`;
  const source = sessions[key] && typeof sessions[key] === "object" ? sessions[key] : {};
  const value = { arenaRuns: Array.isArray(source.arenaRuns) ? source.arenaRuns : [], bossRuns: Math.max(0, Number(source.bossRuns || 0)), bossPoint: Math.max(0, Number(source.bossPoint || 0)), ticketBuyCount: Math.max(0, Number(source.ticketBuyCount || 0)), sessionRewardClaimed: source.sessionRewardClaimed === true };
  if (create && user) {
    user.guildDungeon = root;
    root.sessions = sessions;
    sessions[key] = value;
  }
  return value;
}

function getSeasonProgress(user, base, create) {
  const root = user && user.guildDungeon && typeof user.guildDungeon === "object" ? user.guildDungeon : {};
  const seasons = root.seasons && typeof root.seasons === "object" ? root.seasons : {};
  const source = seasons[String(base.season.id)] && typeof seasons[String(base.season.id)] === "object" ? seasons[String(base.season.id)] : {};
  const value = { received: { rank: Math.max(0, Number(source.received && source.received.rank || 0)), try: Math.max(0, Number(source.received && source.received.try || 0)) } };
  if (create && user) { user.guildDungeon = root; root.seasons = seasons; seasons[String(base.season.id)] = value; }
  return value;
}

function totalSeasonAttempts(user, seasonId) {
  const sessions = user && user.guildDungeon && user.guildDungeon.sessions || {};
  return Object.entries(sessions).filter(([key]) => key.startsWith(`${seasonId}:`)).reduce((total, [, state]) => total + (Array.isArray(state.arenaRuns) ? state.arenaRuns.length : 0) + Math.max(0, Number(state.bossRuns || 0)), 0);
}

function totalSeasonGuildPoints(base) {
  const prefix = `${base.season.id}:`;
  const bestBySession = new Map();
  for (const member of guildMembers(base.ctx, base.guildUid, null)) {
    const shared = member && member.guildDungeon && member.guildDungeon.shared || {};
    for (const [key, state] of Object.entries(shared)) {
      if (!key.startsWith(prefix) || !state) continue;
      const current = bestBySession.get(key);
      if (!current || Number(state.revision || 0) > Number(current.revision || 0)) bestBySession.set(key, state);
    }
  }
  return [...bestBySession.values()].reduce((total, state) => total + Math.max(0, Number(state && state.boss && state.boss.totalPoint || 0)), 0);
}

function readSharedSession(ctx, uid, season, session) {
  const key = `${season.id}:${session.id}`;
  return guildMembers(ctx, uid, null).map((member) => member.guildDungeon && member.guildDungeon.shared && member.guildDungeon.shared[key]).filter(Boolean).sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0))[0] || null;
}

function ensureSharedSession(ctx, uid, base) {
  const existing = readSharedSession(ctx, uid, base.season, base.session);
  if (existing) return JSON.parse(JSON.stringify(existing));
  return { revision: 0, arenas: {}, boss: storeBossState(normalizeBossState(base, null)), clearedBossStage: 0 };
}

function bumpShared(shared) { shared.revision = Math.max(0, Number(shared.revision || 0)) + 1; }

function syncSharedSession(ctx, uid, base, shared) {
  bumpShared(shared);
  const key = `${base.season.id}:${base.session.id}`;
  for (const member of guildMembers(ctx, uid, null)) {
    if (!member.guildDungeon || typeof member.guildDungeon !== "object") member.guildDungeon = {};
    if (!member.guildDungeon.shared || typeof member.guildDungeon.shared !== "object") member.guildDungeon.shared = {};
    member.guildDungeon.shared[key] = JSON.parse(JSON.stringify(shared));
  }
}

function totalPlayerDamage(battleState, replay) {
  const records = Array.isArray(battleState)
    ? battleState
    : Array.isArray(battleState.unitRecords)
      ? battleState.unitRecords
      : Array.isArray(battleState.battleRecords)
        ? battleState.battleRecords
        : Array.isArray(replay && replay.managedBattleRecords)
          ? replay.managedBattleRecords
          : [];
  return records.reduce((total, record) => total + ([1, 2].includes(Number(record.teamType || record.TeamType || 0)) ? Math.max(0, Number(record.recordGiveDamage || record.RecordGiveDamage || 0)) : 0), 0);
}

function decodeLongRequest(ctx, encrypted, name) {
  try { const payload = decrypt(ctx, encrypted); const field = canonicalLong(payload, 0); if (field.offset !== payload.length) throw new Error(); return { valid: true, [name]: field.value }; } catch (_) { return { valid: false, [name]: 0n }; }
}

function decodeTwoIntRequest(ctx, encrypted, firstName, secondName) {
  try { const payload = decrypt(ctx, encrypted); const first = canonicalInt(payload, 0); const second = canonicalInt(payload, first.offset); if (second.offset !== payload.length) throw new Error(); return { valid: true, [firstName]: first.value, [secondName]: second.value }; } catch (_) { return { valid: false, [firstName]: 0, [secondName]: 0 }; }
}

function decodeFlagRequest(ctx, encrypted) {
  try { const payload = decrypt(ctx, encrypted); const guild = canonicalLong(payload, 0); const arena = canonicalInt(payload, guild.offset); const flag = canonicalInt(payload, arena.offset); if (flag.offset !== payload.length) throw new Error(); return { valid: true, guildUid: guild.value, arenaIndex: arena.value, flagIndex: flag.value }; } catch (_) { return { valid: false, guildUid: 0n, arenaIndex: 0, flagIndex: -1 }; }
}

function decodeOrderRequest(ctx, encrypted) {
  try { const payload = decrypt(ctx, encrypted); const guild = canonicalLong(payload, 0); const order = canonicalInt(payload, guild.offset); if (order.offset !== payload.length) throw new Error(); return { valid: true, guildUid: guild.value, orderIndex: order.value }; } catch (_) { return { valid: false, guildUid: 0n, orderIndex: 0 }; }
}

function decodeNoticeRequest(ctx, encrypted) {
  try { const payload = decrypt(ctx, encrypted); const guild = canonicalLong(payload, 0); const notice = readString(payload, guild.offset); if (!writeString(notice.value).equals(payload.subarray(guild.offset, notice.offset)) || notice.offset !== payload.length) throw new Error(); return { valid: true, guildUid: guild.value, notice: notice.value }; } catch (_) { return { valid: false, guildUid: 0n, notice: "" }; }
}

function decodeBossGameLoadRequest(ctx, encrypted) {
  try {
    const payload = decrypt(ctx, encrypted);
    const deck = readByte(payload, 0);
    if (!Buffer.from([deck.value]).equals(payload.subarray(0, deck.offset))) throw new Error();
    const boss = canonicalInt(payload, deck.offset);
    const practice = readBool(payload, boss.offset);
    if ((payload[practice.offset - 1] !== 0 && payload[practice.offset - 1] !== 1) || practice.offset !== payload.length) throw new Error();
    return { valid: true, deckIndex: deck.value, bossStageId: boss.value, isPractice: practice.value };
  } catch (_) { return { valid: false, deckIndex: 0, bossStageId: 0, isPractice: false }; }
}

function decrypt(ctx, payload) { return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : Buffer.from(payload || Buffer.alloc(0)); }
function canonicalInt(payload, offset) { const read = readSignedVarInt(payload, offset); if (!writeSignedVarInt(read.value).equals(payload.subarray(offset, read.offset))) throw new Error(); return read; }
function canonicalLong(payload, offset) { const read = readSignedVarLong(payload, offset); if (!writeSignedVarLong(read.value).equals(payload.subarray(offset, read.offset))) throw new Error(); return read; }
function isEmptyRequest(ctx, encrypted) { try { return decrypt(ctx, encrypted).length === 0; } catch (_) { return false; } }

function guildUid(user) { const guild = user && user.guild && typeof user.guild === "object" ? user.guild : {}; return toBigInt(user && user.guildUid != null ? user.guildUid : guild.guildUid || 0); }
function userUid(user) { return toBigInt(user && (user.userUid != null ? user.userUid : user.uid) || 0); }
function guildGrade(user) { const guild = user && user.guild && typeof user.guild === "object" ? user.guild : {}; const value = user && user.guildMemberGrade != null ? user.guildMemberGrade : guild.memberGrade != null ? guild.memberGrade : guild.grade; if (typeof value === "string") return value.toUpperCase() === "MASTER" ? 0 : value.toUpperCase() === "STAFF" ? 1 : 2; const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= 2 ? number : 2; }
function guildMembers(ctx, uid, fallback) { const members = Object.values(ctx && ctx.userDb && ctx.userDb.users || {}).filter((user) => guildUid(user) === uid); if (fallback && !members.includes(fallback)) members.push(fallback); return members; }
function userFor(socket) { return socket && socket.session && socket.session.user; }
function getNow(ctx) { const value = ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date(); return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(); }
function dateTime(date) { return date instanceof Date ? BigInt(date.getTime()) * 10000n + 621355968000000000n | 0x4000000000000000n : 0n; }
function failure(errorCode) { return { changed: false, errorCode, guildUid: 0n, arenas: [], rewards: [], members: [] }; }
function seasonRewardFailure(errorCode, request) { return { ...failure(errorCode), category: Number(request.category || 0), rewardCountValue: Number(request.rewardCountValue || 0), reward: null }; }
function flagFailure(errorCode, base, request) { return { changed: false, errorCode, guildUid: base.guildUid, arenaIndex: request.arenaIndex, flagIndex: request.flagIndex }; }
function noticeFailure(errorCode, request) { return { changed: false, errorCode, guildUid: request.guildUid, noticeBefore: "", notice: request.notice }; }
function readDungeonNotice(ctx, uid) { const member = guildMembers(ctx, uid, null).sort((left, right) => guildGrade(left) - guildGrade(right))[0]; return String(member && (member.guildDungeonNotice != null ? member.guildDungeonNotice : member.guild && member.guild.dungeonNotice) || ""); }

function respond(ctx, socket, packet, packetId, payload, label) { if (ctx && typeof ctx.sendGameResponse === "function") ctx.sendGameResponse(socket, packet, packetId, payload, label); }
function notifyGuild(ctx, requestSocket, uid, packetId, payload, label, excludeActor = false) { for (const member of guildMembers(ctx, uid, null)) { if (excludeActor && userUid(member) === userUid(userFor(requestSocket))) continue; const socket = requestSocket && userFor(requestSocket) === member ? requestSocket : ctx && typeof ctx.findClientSocketByUserUid === "function" ? ctx.findClientSocketByUserUid(member.userUid) : null; if (socket && !socket.destroyed && ctx && typeof ctx.sendServerGamePacket === "function") ctx.sendServerGamePacket(socket, packetId, payload, label); } }
function persist(ctx, label) { if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb(); if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label); }
function persistResult(ctx, result, label) { if (result && result.changed) persist(ctx, label); }

module.exports = {
  PACKETS,
  ERRORS,
  NGT_GUILD_DUNGEON_ARENA,
  NGT_GUILD_DUNGEON_BOSS,
  NGT_GUILD_DUNGEON_BOSS_PRACTICE,
  abandonBattle,
  buildArenaPlayEndNotPayload,
  buildBossPlayEndNotPayload,
  buildGameLoadFailurePayload,
  buildGuildDungeonRewardInfoData,
  buildInfoAckPayload,
  buildMemberInfoAckPayload,
  buildSeasonRewardAckPayload,
  buildSessionRewardAckPayload,
  buildTicketBuyAckPayload,
  buyArenaTicket,
  claimSeasonReward,
  claimSessionReward,
  commitBattleResult,
  commitBattleStart,
  createGuildDungeonHandlers,
  getGuildDungeonInfo,
  getGuildDungeonMemberInfo,
  loadTables,
  prepareArenaGameLoad,
  prepareBossGameLoad,
  serializeGuildDungeonRewardInfo,
  updateArenaFlag,
  updateBossOrder,
  updateDungeonNotice,
};
