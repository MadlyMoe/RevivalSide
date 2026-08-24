"use strict";

const { validateDefenceDeck } = require("../combat-roster");
const { buildAsyncDeckData } = require("../defence");
const { getMiscItem, grantMiscItem, spendMiscItem, toBigInt } = require("../inventory");
const { buildGuildSimpleData } = require("../leaderboard");
const {
  buildItemMiscData,
  dateTimeBinaryNow,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeByte,
  writeFloatLE,
  writeInt64LE,
  writeIntList,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");
const pvpRank = require("../pvp-rank");
const stamina = require("../stamina");
const { buildPlayerDeckForGameLoad, validatePlayerDeckForGameLoad } = require("../unit");

const PACKETS = Object.freeze({
  TARGET_LIST_REQ: 2615,
  TARGET_LIST_ACK: 2616,
  START_GAME_REQ: 2617,
  START_GAME_ACK: 2618,
  GAME_END_NOT: 2623,
  REVENGE_TARGET_LIST_REQ: 2669,
  REVENGE_TARGET_LIST_ACK: 2670,
  NPC_TARGET_LIST_REQ: 2671,
  NPC_TARGET_LIST_ACK: 2672,
  STRATEGY_REFRESH_NOT: 2673,
  MATCH_COMPLETE_NOT: 2604,
});

const ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  ITEM_INSUFFICIENT_COUNT: 20332,
  CANNOT_FOUND_TARGET: 20335,
  TARGET_SCORE_CHANGED: 20336,
  TARGET_NOT_FOUND: 20339,
  TARGET_OPERATION_POWER_CHANGED: 20340,
  INVALID_GAME_DATA: 20346,
  REVENGE_ALREADY: 22601,
});

const NGT_ASYNC_PVP = 11;
const NGT_PVP_STRATEGY = 20;
const NGT_PVP_STRATEGY_REVENGE = 21;
const NGT_PVP_STRATEGY_NPC = 22;
const NDT_PVP = 2;
const NDT_PVP_DEFENCE = 6;
const ASYNC_TICKET_ITEM_ID = 13;
const PVP_POINT_ITEM_ID = 6;
const WIN_POINT = 75;
const LOSE_POINT = 50;
const MAX_HISTORY_COUNT = 30;
const DATE_TIME_TICK_MASK = 0x3fffffffffffffffn;

function createAsyncPvpHandlers() {
  return [
    {
      packetId: PACKETS.TARGET_LIST_REQ,
      name: "ASYNC_PVP_TARGET_LIST_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const valid = decodeEmptyRequest(ctx, packet && packet.payload);
        const targets = valid ? refreshTargetSession(ctx, socket, user) : [];
        send(ctx, socket, packet, PACKETS.TARGET_LIST_ACK, buildTargetListAckPayload({
          errorCode: valid ? ERRORS.OK : ERRORS.INVALID_REQUEST,
          targets,
        }), "async-pvp-target-list");
        return true;
      },
    },
    {
      packetId: PACKETS.START_GAME_REQ,
      name: "ASYNC_PVP_START_GAME_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeStartRequest(ctx, packet && packet.payload);
        const prepared = prepareAsyncPvpStart(ctx, socket, user, req);
        if (!prepared.ok) {
          send(ctx, socket, packet, PACKETS.START_GAME_ACK, buildStartFailurePayload(prepared.errorCode), "async-pvp-start");
          return true;
        }

        const targetListAckPayload = buildTargetListAckPayload({ errorCode: ERRORS.OK, targets: prepared.targets });
        const started = typeof ctx.startAsyncPvpBattle === "function"
          ? ctx.startAsyncPvpBattle(socket, user, prepared.target.user, req, {
              target: prepared.target,
              targets: prepared.targets,
              targetListAckPayload,
            })
          : null;
        if (!started || !started.ok || !started.startAckPayload || !started.gameDataPayload || !started.replay) {
          send(ctx, socket, packet, PACKETS.START_GAME_ACK, buildStartFailurePayload(ERRORS.INVALID_GAME_DATA), "async-pvp-start");
          return true;
        }

        const costItem = spendMiscItem(user, ASYNC_TICKET_ITEM_ID, 1, { regDate: nowBinary(ctx) });
        started.replay.asyncPvpBattle = {
          gameUid: String(started.replay.dynamicGame && started.replay.dynamicGame.gameUID || 0),
          targetFriendCode: String(req.targetFriendCode),
          targetUserUid: String(prepared.target.user && prepared.target.user.userUid || 0),
          targetSnapshot: snapshotTarget(prepared.target),
          targetList: prepared.targets.map(snapshotTarget),
          revengeRecordId: prepared.revengeRecordId || "",
          selectDeckIndex: req.selectDeckIndex,
          gameType: req.gameType,
          simulationGame: req.simulationGame,
          costItem,
          resultRecorded: false,
        };
        if (typeof ctx.trackMissionEvent === "function") {
          ctx.trackMissionEvent(user, "USE_RESOURCE", 1, {
            itemId: ASYNC_TICKET_ITEM_ID,
            resourceId: ASYNC_TICKET_ITEM_ID,
            value: ASYNC_TICKET_ITEM_ID,
          });
        }
        persist(ctx, "async-pvp-start");

        ctx.sendServerGamePacket(socket, PACKETS.MATCH_COMPLETE_NOT, started.gameDataPayload, "async-pvp-match-complete");
        ctx.sendServerGamePacket(socket, PACKETS.START_GAME_ACK, started.startAckPayload, "async-pvp-start");
        if (req.simulationGame && typeof ctx.finishAsyncPvpSimulation === "function") {
          const timer = setTimeout(() => ctx.finishAsyncPvpSimulation(socket), 75);
          if (timer && typeof timer.unref === "function") timer.unref();
        }
        return true;
      },
    },
    {
      packetId: PACKETS.REVENGE_TARGET_LIST_REQ,
      name: "REVENGE_PVP_TARGET_LIST_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const valid = decodeEmptyRequest(ctx, packet && packet.payload);
        const targets = valid ? refreshRevengeTargetSession(ctx, socket, user) : [];
        send(ctx, socket, packet, PACKETS.REVENGE_TARGET_LIST_ACK, buildRevengeTargetListAckPayload({
          errorCode: valid ? ERRORS.OK : ERRORS.INVALID_REQUEST,
          targets,
        }), "async-pvp-revenge-list");
        return true;
      },
    },
    {
      packetId: PACKETS.NPC_TARGET_LIST_REQ,
      name: "NPC_PVP_TARGET_LIST_REQ",
      handle(ctx, socket, packet) {
        const req = decodeNpcTargetListRequest(ctx, packet && packet.payload);
        send(ctx, socket, packet, PACKETS.NPC_TARGET_LIST_ACK, buildNpcTargetListAckPayload({
          errorCode: req.valid ? ERRORS.OK : ERRORS.INVALID_REQUEST,
          targets: [],
        }), "async-pvp-npc-list");
        return true;
      },
    },
  ];
}

function decodeEmptyRequest(ctx, encryptedPayload) {
  try { return decrypt(ctx, encryptedPayload).length === 0; }
  catch (_) { return false; }
}

function decodeStartRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    let field = readSignedVarLong(payload, 0);
    const targetFriendCode = field.value;
    field = readByte(payload, field.offset);
    const selectDeckIndex = field.value;
    field = readByte(payload, field.offset);
    const gameType = field.value;
    if (field.offset >= payload.length || payload[field.offset] > 1) return invalidStartRequest();
    const simulationGame = readBool(payload, field.offset);
    if (simulationGame.offset !== payload.length) return invalidStartRequest();
    const canonical = Buffer.concat([
      writeSignedVarLong(targetFriendCode),
      writeByte(selectDeckIndex),
      writeByte(gameType),
      writeBool(simulationGame.value),
    ]);
    if (!canonical.equals(payload)) return invalidStartRequest();
    return { valid: true, targetFriendCode, selectDeckIndex, gameType, simulationGame: simulationGame.value };
  } catch (_) {
    return invalidStartRequest();
  }
}

function decodeNpcTargetListRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const field = readSignedVarInt(payload, 0);
    if (field.offset !== payload.length || !writeSignedVarInt(field.value).equals(payload)) return { valid: false, targetTier: 0 };
    return { valid: field.value >= 0, targetTier: field.value };
  } catch (_) {
    return { valid: false, targetTier: 0 };
  }
}

function invalidStartRequest() {
  return { valid: false, targetFriendCode: 0n, selectDeckIndex: 0, gameType: 0, simulationGame: false };
}

function prepareAsyncPvpStart(ctx, socket, user, req) {
  if (!req || !req.valid) return failure(ERRORS.INVALID_REQUEST);
  if (![NGT_ASYNC_PVP, NGT_PVP_STRATEGY, NGT_PVP_STRATEGY_REVENGE].includes(Number(req.gameType))) {
    return failure(ERRORS.INVALID_GAME_DATA);
  }
  if (hasActiveBattle(socket)) return failure(ERRORS.INVALID_GAME_DATA);

  const selectedDeck = validatePlayerDeckForGameLoad(user, req, {
    deckType: NDT_PVP,
    requiredState: 0,
    requireFullDeck: true,
  });
  if (!selectedDeck.valid) return failure(selectedDeck.errorCode);

  if (typeof ctx.refreshTimedStamina === "function") {
    ctx.refreshTimedStamina(user, { now: nowBinary(ctx), initializeMissing: false });
  }
  const ticket = getMiscItem(user, ASYNC_TICKET_ITEM_ID);
  if (!ticket || toBigInt(ticket.countFree || 0) + toBigInt(ticket.countPaid || 0) < 1n) {
    return failure(ERRORS.ITEM_INSUFFICIENT_COUNT);
  }

  const revenge = Number(req.gameType) === NGT_PVP_STRATEGY_REVENGE;
  const session = socket && socket.session && socket.session[
    revenge ? "asyncPvpRevengeSession" : "asyncPvpTargetSession"
  ];
  const key = String(req.targetFriendCode);
  const target = session && session.byFriendCode instanceof Map ? session.byFriendCode.get(key) : null;
  if (!target) return failure(ERRORS.CANNOT_FOUND_TARGET);
  if (revenge && target.revengeAble !== true) return failure(ERRORS.REVENGE_ALREADY);
  const currentUser = findUserByFriendCode(ctx, req.targetFriendCode);
  if (!currentUser || sameUser(currentUser, user)) return failure(ERRORS.TARGET_NOT_FOUND);
  const current = buildTargetEntry(ctx, currentUser, target.rank);
  if (!current) return failure(ERRORS.TARGET_NOT_FOUND);
  if (current.score !== target.score) return failure(ERRORS.TARGET_SCORE_CHANGED);
  if (current.operationPower !== target.operationPower) return failure(ERRORS.TARGET_OPERATION_POWER_CHANGED);
  const targets = session.targets.map((entry) => entry.friendCode === key ? current : entry);
  return {
    ok: true,
    target: { ...current, revengeRecordId: target.revengeRecordId, revengeAble: target.revengeAble },
    targets,
    selectedDeck,
    revengeRecordId: target.revengeRecordId || "",
  };
}

function failure(errorCode) {
  return { ok: false, errorCode: Number(errorCode || ERRORS.INVALID_REQUEST) };
}

function refreshTargetSession(ctx, socket, user) {
  const targets = getAsyncPvpTargets(ctx, user);
  if (socket && socket.session) {
    socket.session.asyncPvpTargetSession = {
      targets,
      byFriendCode: new Map(targets.map((entry) => [entry.friendCode, entry])),
    };
  }
  return targets;
}

function refreshRevengeTargetSession(ctx, socket, user) {
  const targets = getRevengePvpTargets(ctx, user);
  if (socket && socket.session) {
    socket.session.asyncPvpRevengeSession = {
      targets,
      byFriendCode: new Map(targets.map((entry) => [entry.friendCode, entry])),
    };
  }
  return targets;
}

function getRevengePvpTargets(ctx, user) {
  const records = ensureRevengeTargets(user);
  return records.map((record) => {
    const sourceUser = findUserByUid(ctx, record.sourceUserUid);
    const current = sourceUser ? buildTargetEntry(ctx, sourceUser, record.rank) : null;
    if (!current) return null;
    return {
      ...current,
      revengeRecordId: String(record.revengeRecordId || record.gameUid || ""),
      revengeAble: record.revengeAble === true,
      result: Math.max(0, Number(record.result || 0) || 0),
    };
  }).filter(Boolean).slice(0, MAX_HISTORY_COUNT);
}

function getAsyncPvpTargets(ctx, user) {
  const candidates = getUsers(ctx)
    .filter((candidate) => !sameUser(candidate, user))
    .map((candidate) => ({ user: candidate, state: pvpRank.getAsyncPvpState(candidate) }))
    .sort((left, right) => right.state.score - left.state.score || compareUserUid(left.user, right.user));
  const ranked = candidates.map((entry, index) => buildTargetEntry(ctx, entry.user, index + 1)).filter(Boolean);
  const ownScore = pvpRank.getAsyncPvpState(user).score;
  return ranked
    .sort((left, right) => Math.abs(left.score - ownScore) - Math.abs(right.score - ownScore) || left.rank - right.rank)
    .slice(0, 10);
}

function buildTargetEntry(ctx, user, rank = 0) {
  const deck = getDefenceDeck(user);
  if (!deck || validateDefenceDeck(user, toValidationDeck(deck)) !== 0) return null;
  const state = pvpRank.getAsyncPvpState(user);
  const mainUnit = getMainUnit(user, deck);
  const operationPower = getDeckOperationPower(user, deck);
  return {
    user,
    deck,
    friendCode: String(toBigInt(user && user.friendCode || 0)),
    rank: Math.max(0, Number(rank) || 0),
    score: state.score,
    tier: state.leagueTierId,
    operationPower,
    mainUnitId: Number(user && user.mainUnitId || mainUnit && mainUnit.unitId || 0),
    mainUnitSkinId: Number(user && user.mainUnitSkinId || mainUnit && mainUnit.skinId || 0),
    mainUnitTacticLevel: Number(user && user.mainUnitTacticLevel || mainUnit && mainUnit.tacticLevel || 0),
  };
}

function buildTargetListAckPayload(result = {}) {
  const targets = Array.isArray(result.targets) ? result.targets : [];
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectList(targets.map(buildAsyncPvpTargetData)),
  ]);
}

function buildAsyncPvpTargetData(entry = {}) {
  const user = entry.user || {};
  const deckUser = entry.deck ? { ...user, defenceDeck: entry.deck } : user;
  return Buffer.concat([
    writeSignedVarInt(Math.max(1, Number(user.level || 1) || 1)),
    writeString(user.nickname || ""),
    writeSignedVarLong(toBigInt(entry.friendCode != null ? entry.friendCode : user.friendCode || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.rank || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.score || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.tier || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.mainUnitId || user.mainUnitId || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.mainUnitSkinId || user.mainUnitSkinId || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(user.selfiFrameId || user.selfieFrameId || user.frameId || 0) || 0)),
    writeNullableObject(buildAsyncDeckData(deckUser)),
    writeNullableObject(buildGuildSimpleData(user)),
    writeSignedVarInt(Math.max(0, Number(entry.mainUnitTacticLevel || user.mainUnitTacticLevel || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(user.titleId || 0) || 0)),
  ]);
}

function buildRevengeTargetListAckPayload(result = {}) {
  const targets = Array.isArray(result.targets) ? result.targets : [];
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectList(targets.map(buildRevengePvpTargetData)),
  ]);
}

function buildRevengePvpTargetData(entry = {}) {
  const user = entry.user || {};
  const deckUser = entry.deck ? { ...user, defenceDeck: entry.deck } : user;
  return Buffer.concat([
    writeSignedVarInt(Math.max(1, Number(user.level || 1) || 1)),
    writeString(user.nickname || ""),
    writeSignedVarLong(toBigInt(entry.friendCode != null ? entry.friendCode : user.friendCode || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.rank || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.score || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.tier || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.mainUnitId || user.mainUnitId || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.mainUnitSkinId || user.mainUnitSkinId || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(user.selfiFrameId || user.selfieFrameId || user.frameId || 0) || 0)),
    writeBool(entry.revengeAble === true),
    writeSignedVarInt(Math.max(0, Number(entry.result || 0) || 0)),
    writeNullableObject(buildAsyncDeckData(deckUser)),
    writeNullableObject(buildGuildSimpleData(user)),
  ]);
}

function buildNpcTargetListAckPayload(result = {}) {
  const targets = Array.isArray(result.targets) ? result.targets : [];
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectList(targets.map(buildNpcPvpTargetData)),
  ]);
}

function buildNpcPvpTargetData(entry = {}) {
  const user = entry.user || {};
  const deckUser = entry.deck ? { ...user, defenceDeck: entry.deck } : user;
  return Buffer.concat([
    writeSignedVarInt(Math.max(1, Number(entry.userLevel || user.level || 1) || 1)),
    writeString(entry.userNickName || user.nickname || ""),
    writeSignedVarLong(toBigInt(entry.friendCode != null ? entry.friendCode : user.friendCode || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.score || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(entry.tier || 0) || 0)),
    writeNullableObject(buildAsyncDeckData(deckUser)),
    writeBool(entry.isOpened === true),
  ]);
}

function buildStrategyPvpRefreshNotPayload(user) {
  return Buffer.concat([
    writeSignedVarInt(ERRORS.OK),
    writeNullableObject(pvpRank.buildPvpStateData(pvpRank.getAsyncPvpState(user))),
  ]);
}

function buildStartFailurePayload(errorCode) {
  return Buffer.concat([
    writeSignedVarInt(Number(errorCode || ERRORS.INVALID_REQUEST)),
    writeNullObject(),
    writeNullObject(),
    writeNullableObject(buildAsyncPvpTargetData()),
    writeNullableObjectList([]),
    writeBool(false),
  ]);
}

function buildAsyncPvpGameEndNotPayload(ctx, socket, replay, options = {}) {
  const user = socket && socket.session && socket.session.user;
  const meta = replay && replay.asyncPvpBattle;
  if (!user || !meta || !replay || !replay.dynamicGame) return null;
  const result = recordAsyncPvpResult(ctx, user, replay, options);
  if (!result) return null;
  const battleState = options.battleState || replay.battleState || {};
  const playTime = Math.max(0, Number(options.playTime || options.battlePlayTime || battleState.gameTime || 0) || 0);
  const gameRecord = typeof ctx.buildBattleGameRecordData === "function"
    ? ctx.buildBattleGameRecordData(replay, battleState, { playTime })
    : null;
  const targets = refreshTargetSession(ctx, socket, user);
  return Buffer.concat([
    writeSignedVarInt(result.result),
    writeNullableObject(pvpRank.buildPvpStateData(result.pvpState)),
    writeNullableObject(buildItemMiscData(result.gainPointItem)),
    gameRecord ? writeNullableObject(gameRecord) : writeNullObject(),
    writeNullableObjectList([result.costItem].filter(Boolean).map(buildItemMiscData)),
    writeNullableObject(buildPvpSingleHistoryData(result.history)),
    writeNullableObjectList(targets.map(buildAsyncPvpTargetData)),
    writeInt64LE(stamina.getChargeItemLastUpdateDate(user, PVP_POINT_ITEM_ID, nowBinary(ctx))),
    writeBool(pvpRank.isRankPvpOpen(user)),
    writeBool(false),
    writeSignedVarInt(pvpRank.getNpcPvpData(user).maxOpenedTier),
    writeFloatLE(playTime),
    writeBool(Boolean(meta.simulationGame)),
  ]);
}

function recordAsyncPvpResult(ctx, user, replay, options = {}) {
  const meta = replay.asyncPvpBattle;
  if (meta.resultRecorded && replay.asyncPvpResult) return replay.asyncPvpResult;
  const targetUser = findUserByUid(ctx, meta.targetUserUid) || null;
  const target = restoreTargetSnapshot(meta.targetSnapshot, targetUser);
  if (!target) return null;
  const previous = initializeAsyncPvpState(ctx, user);
  const win = resolveWin(options);
  const draw = options.draw === true;
  const giveup = options.giveup === true;
  const result = giveup ? 3 : draw ? 2 : win ? 0 : 1;
  const ownUpdate = updateAsyncPvpResultState(ctx, user, previous, result, target.score);
  const targetPrevious = targetUser ? initializeAsyncPvpState(ctx, targetUser) : null;
  const targetResult = invertPvpResult(result);
  if (targetUser && Number(meta.gameType) !== NGT_PVP_STRATEGY_NPC) {
    updateAsyncPvpResultState(ctx, targetUser, targetPrevious, targetResult, previous.score);
  }
  const ranked = pvpRank.rankAsyncUsers(getUsers(ctx, user));
  for (const rankedUser of [user, targetUser].filter(Boolean)) {
    const rank = ranked.find((entry) => sameUser(entry.user, rankedUser));
    if (!rank) continue;
    const state = pvpRank.getAsyncPvpState(rankedUser);
    pvpRank.setAsyncPvpState(rankedUser, { ...state, rank: rank.rank });
  }
  const savedState = pvpRank.getAsyncPvpState(user);
  const pointAmount = result === 0 ? WIN_POINT : LOSE_POINT;
  const gainPointItem = grantMiscItem(user, PVP_POINT_ITEM_ID, pointAmount, 0, { regDate: nowBinary(ctx) });
  const history = buildHistorySnapshot(ctx, user, target, meta, result, ownUpdate.gainScore, savedState);
  const historyList = ensureHistory(user);
  historyList.unshift(history);
  historyList.length = Math.min(historyList.length, MAX_HISTORY_COUNT);
  if (Number(meta.gameType) === NGT_PVP_STRATEGY && targetUser) {
    recordIncomingStrategyBattle(ctx, targetUser, user, meta, targetResult);
  } else if (Number(meta.gameType) === NGT_PVP_STRATEGY_REVENGE) {
    markRevengeUsed(user, meta.revengeRecordId, result);
  }
  const output = { result, pvpState: savedState, gainPointItem, costItem: meta.costItem, history };
  meta.resultRecorded = true;
  replay.asyncPvpResult = output;
  persist(ctx, "async-pvp-result");
  if (targetUser && Number(meta.gameType) !== NGT_PVP_STRATEGY_NPC) pushStrategyPvpRefresh(ctx, targetUser);
  return output;
}

function updateAsyncPvpResultState(ctx, user, previous, result, opponentScore) {
  const tier = getCurrentTier(ctx, user, previous);
  const scoreMagnitude = calculateScoreDelta(tier, previous.score, opponentScore);
  const requestedDelta = result === 0 ? scoreMagnitude : result === 2 || !tierAllowsLoseScore(tier) ? 0 : -scoreMagnitude;
  const nextScore = Math.max(0, previous.score + requestedDelta);
  const gainScore = nextScore - previous.score;
  const nextTier = getTierForScore(ctx, user, nextScore) || tier;
  const state = {
    ...previous,
    winCount: previous.winCount + (result === 0 ? 1 : 0),
    loseCount: previous.loseCount + (result === 1 || result === 3 ? 1 : 0),
    leagueTierId: nextTier ? nextTier.leagueTier : previous.leagueTierId,
    maxLeagueTierId: Math.max(previous.maxLeagueTierId, nextTier ? nextTier.leagueTier : 0),
    score: nextScore,
    maxScore: Math.max(previous.maxScore, nextScore),
    winStreak: result === 0 ? previous.winStreak + 1 : 0,
    maxWinStreak: result === 0 ? Math.max(previous.maxWinStreak, previous.winStreak + 1) : previous.maxWinStreak,
    seasonPlayCount: previous.seasonPlayCount + 1,
    seasonWinCount: previous.seasonWinCount + (result === 0 ? 1 : 0),
    rankOpen: true,
  };
  pvpRank.setAsyncPvpState(user, state);
  return { state, gainScore };
}

function invertPvpResult(result) {
  if (result === 0) return 1;
  if (result === 1 || result === 3) return 0;
  return 2;
}

function recordIncomingStrategyBattle(ctx, defender, attacker, meta, result) {
  const attackerEntry = buildTargetEntry(ctx, attacker, pvpRank.getAsyncPvpState(attacker).rank);
  if (!attackerEntry) return false;
  const records = ensureRevengeTargets(defender);
  const revengeRecordId = String(replayGameUid(meta, ctx));
  records.unshift({
    revengeRecordId,
    gameUid: revengeRecordId,
    sourceUserUid: String(attacker.userUid || 0),
    revengeAble: true,
    result,
    regdateTick: String(nowRawTicks(ctx)),
  });
  records.length = Math.min(records.length, MAX_HISTORY_COUNT);
  return true;
}

function markRevengeUsed(user, revengeRecordId, result) {
  const key = String(revengeRecordId || "");
  const record = ensureRevengeTargets(user).find((entry) => String(entry.revengeRecordId || entry.gameUid || "") === key);
  if (!record || record.revengeAble !== true) return false;
  record.revengeAble = false;
  record.result = result;
  return true;
}

function pushStrategyPvpRefresh(ctx, user) {
  if (!ctx || typeof ctx.findClientSocketByUserUid !== "function" || typeof ctx.sendServerGamePacket !== "function") return false;
  const socket = ctx.findClientSocketByUserUid(user && user.userUid);
  if (!socket || socket.destroyed) return false;
  ctx.sendServerGamePacket(socket, PACKETS.STRATEGY_REFRESH_NOT, buildStrategyPvpRefreshNotPayload(user), "async-pvp-strategy-refresh");
  return true;
}

function buildHistorySnapshot(ctx, user, target, meta, result, gainScore, state) {
  const ownDeck = getDeckByType(user, NDT_PVP, meta.selectDeckIndex);
  const targetDeck = target.deck || getDefenceDeck(target.user);
  const nowTicks = nowRawTicks(ctx);
  const sourceGuild = guildIdentity(user);
  const targetGuild = guildIdentity(target.user);
  return {
    gameUid: String(replayGameUid(meta, ctx)),
    myUserLevel: Math.max(1, Number(user.level || 1) || 1),
    targetUserLevel: Math.max(1, Number(target.user && target.user.level || 1) || 1),
    targetNickName: String(target.user && target.user.nickname || ""),
    result,
    gainScore,
    myTier: state.leagueTierId,
    myScore: state.score,
    targetTier: target.tier,
    targetScore: target.score,
    regdateTick: String(nowTicks),
    myDeckPayloadBase64: buildAsyncDeckData({ ...user, defenceDeck: ownDeck }).toString("base64"),
    targetDeckPayloadBase64: buildAsyncDeckData({ ...(target.user || {}), defenceDeck: targetDeck }).toString("base64"),
    gameType: Number(meta.gameType || NGT_PVP_STRATEGY),
    targetFriendCode: String(meta.targetFriendCode || 0),
    sourceGuildUid: String(sourceGuild.guildUid),
    sourceGuildName: sourceGuild.guildName,
    sourceGuildBadgeId: String(sourceGuild.badgeId),
    targetGuildUid: String(targetGuild.guildUid),
    targetGuildName: targetGuild.guildName,
    targetGuildBadgeId: String(targetGuild.badgeId),
    forfeitured: result === 3,
    targetTitleId: Math.max(0, Number(target.user && target.user.titleId || 0) || 0),
  };
}

function buildPvpSingleHistoryData(history = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(history.gameUid || 0)),
    writeSignedVarInt(Math.max(1, Number(history.myUserLevel || 1) || 1)),
    writeSignedVarInt(Math.max(1, Number(history.targetUserLevel || 1) || 1)),
    writeString(history.targetNickName || ""),
    writeSignedVarInt(Number(history.result || 0)),
    writeSignedVarInt(Number(history.gainScore || 0)),
    writeSignedVarInt(Math.max(0, Number(history.myTier || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(history.myScore || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(history.targetTier || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(history.targetScore || 0) || 0)),
    writeSignedVarLong(toBigInt(history.regdateTick || 0)),
    nullableBase64(history.myDeckPayloadBase64),
    nullableBase64(history.targetDeckPayloadBase64),
    writeByte(Number(history.gameType || NGT_PVP_STRATEGY)),
    writeSignedVarLong(toBigInt(history.targetFriendCode || 0)),
    writeSignedVarLong(toBigInt(history.sourceGuildUid || 0)),
    writeString(history.sourceGuildName || ""),
    writeSignedVarLong(toBigInt(history.sourceGuildBadgeId || 0)),
    writeSignedVarLong(toBigInt(history.targetGuildUid || 0)),
    writeString(history.targetGuildName || ""),
    writeSignedVarLong(toBigInt(history.targetGuildBadgeId || 0)),
    writeIntList(history.myBanUnitIds || []),
    writeIntList(history.targetBanUnitIds || []),
    writeBool(Boolean(history.forfeitured)),
    writeSignedVarInt(Math.max(0, Number(history.targetTitleId || 0) || 0)),
    writeIntList(history.myBanShipIds || []),
    writeIntList(history.targetBanShipIds || []),
  ]);
}

function buildPvpHistoryListData(user) {
  return writeNullableObjectList(ensureHistory(user).map(buildPvpSingleHistoryData));
}

function initializeAsyncPvpState(ctx, user) {
  const previous = pvpRank.getAsyncPvpState(user);
  const season = pvpRank.getActiveAsyncSeason(ctx, user, nowDate(ctx));
  const scoreTier = season ? pvpRank.getTierByScore(season.rankGroup, previous.score) : null;
  return {
    ...previous,
    seasonId: previous.seasonId || season && season.seasonId || 0,
    weekId: previous.weekId || season && pvpRank.getWeekId(season, nowDate(ctx)) || 0,
    leagueTierId: previous.leagueTierId || scoreTier && scoreTier.leagueTier || 0,
    maxLeagueTierId: previous.maxLeagueTierId || scoreTier && scoreTier.leagueTier || 0,
    rankOpen: true,
  };
}

function getCurrentTier(ctx, user, state) {
  const season = pvpRank.getActiveAsyncSeason(ctx, user, nowDate(ctx));
  return season && (pvpRank.getTierByTier(season.rankGroup, state.leagueTierId) || pvpRank.getTierByScore(season.rankGroup, state.score));
}

function getTierForScore(ctx, user, score) {
  const season = pvpRank.getActiveAsyncSeason(ctx, user, nowDate(ctx));
  return season ? pvpRank.getTierByScore(season.rankGroup, score) : null;
}

function calculateScoreDelta(tier, myScore, targetScore) {
  const leagueType = String(tier && tier.row && tier.row.m_LeagueType || "").toUpperCase();
  if (leagueType.includes("START") || leagueType.includes("NEWBIE")) return 25;
  if (leagueType && !leagueType.includes("NORMAL")) return 0;
  const difference = Math.trunc((Number(targetScore || 0) - Number(myScore || 0)) / 12);
  return Math.max(5, Math.min(45, 25 + difference));
}

function tierAllowsLoseScore(tier) {
  return Boolean(tier && tier.row && tier.row.m_bLoseScore);
}

function resolveWin(options) {
  if (typeof options.win === "boolean") return options.win;
  if (typeof options.battleWin === "boolean") return options.battleWin;
  const team = Number(options.battleWinTeam || options.managedBattleWinTeam || 0);
  return team === 1;
}

function snapshotTarget(entry) {
  return {
    friendCode: entry.friendCode,
    rank: entry.rank,
    score: entry.score,
    tier: entry.tier,
    operationPower: entry.operationPower,
    mainUnitId: entry.mainUnitId,
    mainUnitSkinId: entry.mainUnitSkinId,
    mainUnitTacticLevel: entry.mainUnitTacticLevel,
    userUid: String(entry.user && entry.user.userUid || 0),
  };
}

function restoreTargetSnapshot(snapshot, user) {
  if (!snapshot || !user) return null;
  const deck = getDefenceDeck(user);
  return { ...snapshot, user, deck };
}

function getDefenceDeck(user) {
  const decks = user && user.army && user.army.deckSets && user.army.deckSets[String(NDT_PVP_DEFENCE)];
  return Array.isArray(decks) && decks[0] && typeof decks[0] === "object" ? decks[0] : null;
}

function getDeckByType(user, deckType, index) {
  const decks = user && user.army && user.army.deckSets && user.army.deckSets[String(deckType)];
  return Array.isArray(decks) && decks[index] && typeof decks[index] === "object" ? decks[index] : null;
}

function toValidationDeck(deck) {
  return {
    ...deck,
    shipUid: toBigInt(deck.shipUid || 0),
    operatorUid: toBigInt(deck.operatorUid || 0),
    unitUids: (Array.isArray(deck.unitUids) ? deck.unitUids : []).map((uid) => toBigInt(uid || 0)),
  };
}

function getMainUnit(user, deck) {
  const army = user && user.army || {};
  const uid = deck && Array.isArray(deck.unitUids) ? deck.unitUids[Math.max(0, Number(deck.leaderIndex || 0))] : 0;
  return army.units && army.units[String(toBigInt(uid || 0))] || null;
}

function getDeckOperationPower(user, deck) {
  const explicit = Math.max(0, Number(deck && deck.operationPower || user && user.defenceOperationPower || 0) || 0);
  if (explicit) return explicit;
  const units = user && user.army && user.army.units || {};
  return (Array.isArray(deck && deck.unitUids) ? deck.unitUids : [])
    .map((uid) => units[String(toBigInt(uid || 0))])
    .filter(Boolean)
    .reduce((sum, unit) => sum + Math.max(1, Number(unit.level || 1) || 1) * 1000, 0);
}

function ensureHistory(user) {
  if (!user || typeof user !== "object") return [];
  user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
  user.pvp.asyncHistory = Array.isArray(user.pvp.asyncHistory) ? user.pvp.asyncHistory : [];
  return user.pvp.asyncHistory;
}

function ensureRevengeTargets(user) {
  if (!user || typeof user !== "object") return [];
  user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
  user.pvp.revengeTargets = Array.isArray(user.pvp.revengeTargets) ? user.pvp.revengeTargets : [];
  return user.pvp.revengeTargets;
}

function findUserByFriendCode(ctx, friendCode) {
  const key = String(toBigInt(friendCode || 0));
  return getUsers(ctx).find((user) => String(toBigInt(user && user.friendCode || 0)) === key) || null;
}

function findUserByUid(ctx, uid) {
  const key = String(toBigInt(uid || 0));
  return getUsers(ctx).find((user) => String(toBigInt(user && user.userUid || 0)) === key) || null;
}

function getUsers(ctx) {
  return ctx && ctx.userDb && ctx.userDb.users ? Object.values(ctx.userDb.users).filter(Boolean) : [];
}

function sameUser(left, right) {
  return String(toBigInt(left && left.userUid || 0)) === String(toBigInt(right && right.userUid || 0));
}

function compareUserUid(left, right) {
  const a = toBigInt(left && left.userUid || 0);
  const b = toBigInt(right && right.userUid || 0);
  return a === b ? 0 : a < b ? -1 : 1;
}

function hasActiveBattle(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  return Boolean(replay && replay.dynamicGame && replay.dynamicBattleResultSent !== true);
}

function guildIdentity(user) {
  const nested = user && user.guildData && typeof user.guildData === "object" ? user.guildData : {};
  return {
    guildUid: toBigInt(user && user.guildUid != null ? user.guildUid : nested.guildUid || 0),
    guildName: String(user && user.guildName || nested.guildName || nested.name || ""),
    badgeId: toBigInt(user && user.guildBadgeId != null ? user.guildBadgeId : nested.badgeId || 0),
  };
}

function nullableBase64(value) {
  if (!value) return writeNullObject();
  try { return writeNullableObject(Buffer.from(String(value), "base64")); }
  catch (_) { return writeNullObject(); }
}

function replayGameUid(meta, ctx) {
  const value = meta && meta.gameUid;
  if (toBigInt(value || 0) > 0n) return toBigInt(value);
  return nowRawTicks(ctx);
}

function nowBinary(ctx) {
  return ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
}

function nowRawTicks(ctx) {
  if (ctx && typeof ctx.dateTimeTicksNow === "function") return toBigInt(ctx.dateTimeTicksNow());
  return toBigInt(nowBinary(ctx)) & DATE_TIME_TICK_MASK;
}

function nowDate(ctx) {
  return ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date();
}

function persist(ctx, label) {
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function decrypt(ctx, payload) {
  const value = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : payload;
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function send(ctx, socket, packet, packetId, payload, label) {
  ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

module.exports = {
  ASYNC_TICKET_ITEM_ID,
  ERRORS,
  LOSE_POINT,
  NDT_PVP,
  NDT_PVP_DEFENCE,
  NGT_ASYNC_PVP,
  NGT_PVP_STRATEGY,
  NGT_PVP_STRATEGY_NPC,
  NGT_PVP_STRATEGY_REVENGE,
  PACKETS,
  PVP_POINT_ITEM_ID,
  WIN_POINT,
  buildAsyncPvpGameEndNotPayload,
  buildAsyncPvpTargetData,
  buildNpcPvpTargetData,
  buildNpcTargetListAckPayload,
  buildPvpHistoryListData,
  buildPvpSingleHistoryData,
  buildRevengePvpTargetData,
  buildRevengeTargetListAckPayload,
  buildStartFailurePayload,
  buildStrategyPvpRefreshNotPayload,
  buildTargetListAckPayload,
  calculateScoreDelta,
  createAsyncPvpHandlers,
  decodeEmptyRequest,
  decodeNpcTargetListRequest,
  decodeStartRequest,
  getAsyncPvpTargets,
  getRevengePvpTargets,
  prepareAsyncPvpStart,
  recordAsyncPvpResult,
  refreshRevengeTargetSession,
  refreshTargetSession,
};
