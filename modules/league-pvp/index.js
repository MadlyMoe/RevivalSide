"use strict";

const { parseGameTableDate } = require("../game-data");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  buildOperatorData,
  buildRewardData,
  buildShipCmdModuleData,
  dateTimeBinaryNow,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  toBigInt,
  writeBool,
  writeInt64LE,
  writeIntList,
  writeLongArray,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../packet-codec");
const { getPlayableUnitIds, getUnitTemplet, isCollectionVisibleUnitId } = require("../game-data");
const { buildPvpStateData, buildUserSimpleProfileData, normalizePvpState } = require("../pvp-rank");
const { buildUserProfileData } = require("../profile");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const {
  buildPlayerDeckForGameLoad,
  getArmyOperatorByUid,
  getArmyUnitByUid,
  getArmyUnits,
  getArmyShips,
  getArmyOperators,
  validatePlayerDeckForGameLoad,
} = require("../unit");

const PACKETS = Object.freeze({
  MATCH_REQ: 2630,
  MATCH_ACK: 2631,
  MATCH_CANCEL_REQ: 2632,
  MATCH_CANCEL_ACK: 2633,
  MATCH_FAIL_NOT: 2634,
  RANK_LIST_REQ: 2635,
  RANK_LIST_ACK: 2636,
  ACCEPT_NOT: 2637,
  UPDATED_NOT: 2638,
  GLOBAL_BAN_REQ: 2639,
  GLOBAL_BAN_ACK: 2640,
  PICK_UNIT_REQ: 2641,
  PICK_UNIT_ACK: 2642,
  OPPONENT_BAN_REQ: 2643,
  OPPONENT_BAN_ACK: 2644,
  PICK_SHIP_REQ: 2645,
  PICK_SHIP_ACK: 2646,
  PICK_OPERATOR_REQ: 2647,
  PICK_OPERATOR_ACK: 2648,
  PICK_LEADER_REQ: 2649,
  PICK_LEADER_ACK: 2650,
  SELECT_UNIT_REQ: 2651,
  SELECT_UNIT_ACK: 2652,
  SEASON_REWARD_REQ: 2655,
  SEASON_REWARD_ACK: 2656,
  WEEKLY_RANKER_REQ: 2657,
  WEEKLY_RANKER_ACK: 2658,
  GIVEUP_REQ: 2659,
  GIVEUP_ACK: 2660,
  SEASON_INFO_REQ: 2701,
  SEASON_INFO_ACK: 2702,
});

const ERRORS = Object.freeze({
  OK: 0,
  ALREADY_BEGIN: 106,
  ALREADY_MATCHING: 107,
  INVALID_MATCH_TYPE: 108,
  CANCEL_FAIL: 109,
  LEAGUE_MISS_MATCH: 360,
  INVALID_REQUEST: 20191,
  DRAFT_INVALID_STATE: 20824,
  GLOBAL_BAN_COMPLETED: 20825,
  GLOBAL_BAN_DUPLICATED: 20826,
  UNIT_FULL_ON_STEP: 20827,
  BANISHED_UNIT_ID: 20828,
  OTHER_PLAYER_PICKED_UNIT: 20829,
  OPPONENT_BAN_DUPLICATED: 20830,
  OPPONENT_BAN_INVALID_INDEX: 20831,
  MAIN_SHIP_DUPLICATED: 20832,
  OPERATOR_DUPLICATED: 20833,
  LEADER_UNIT_DUPLICATED: 20834,
  LEADER_INVALID_INDEX: 20835,
  NOT_ENOUGH_UNIT_COUNT: 20837,
  NOT_ENOUGH_SHIP_COUNT: 20838,
  DRAFT_INVALID_TIME: 20839,
  TARGET_NOT_ENOUGH_UNIT_COUNT: 21074,
  TARGET_NOT_ENOUGH_SHIP_COUNT: 21075,
  NOT_EXISTS_CASTING_BAN: 21076,
  BANISHED_SHIP: 21077,
  NOT_IN_GAME_ROOM: 21078,
  INVALID_RANGE: 20808,
  INVALID_RANK_TYPE: 20809,
  SEASON_TEMPLET_NULL: 27400,
  SEASON_REWARD_INVALID_INTERVAL: 27402,
  SEASON_REWARD_ALREADY_RECEIVED: 27403,
  SEASON_RANK_REWARD_TEMPLET_NULL: 27404,
  RANK_TEMPLET_NULL: 27407,
  PLAY_COUNT_ZERO: 27408,
});

const RANK_TYPES = Object.freeze({ MY_LEAGUE: 0, ALL: 1, FRIEND: 2 });
const RANGES = Object.freeze({ ALL: 0, TOP10: 1 });
const NDT_PVP = 2;
const NGT_PVP_LEAGUE = 19;
const NGT_PVP_UNLIMITED = 28;
const TEAM_A = 1;
const TEAM_B = 3;
const DRAFT_STATE = Object.freeze({
  INIT: 0,
  BAN_ALL: 1,
  BAN_COMPLETE: 2,
  PICK_UNIT_1: 3,
  PICK_UNIT_10: 12,
  BAN_OPPONENT: 13,
  PICK_ETC: 14,
  DRAFT_COMPLETE: 15,
});
const PICK_TARGET_COUNTS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
let cachedCatalog = null;
let cachedDraftBanLimits = null;

function createLeaguePvpMatchmaker(options = {}) {
  const waiting = [];
  const tickets = new Map();
  const matches = new Set();
  let nextMatchId = 1;
  const logger = typeof options.logger === "function" ? options.logger : () => {};
  const disconnectGraceMs = Math.max(1000, Number(options.disconnectGraceMs) || 30000);
  const draftStateMs = Math.max(1000, Number(options.draftStateMs) || 30000);
  const revealStateMs = Math.max(100, Number(options.revealStateMs) || 1200);
  const battleCountdownMs = Math.max(1000, Number(options.battleCountdownMs) || 3000);
  const timersEnabled = options.timersEnabled !== false;

  function request(socket, user, req) {
    purgeDisconnected();
    if (hasActiveGame(socket)) return { errorCode: ERRORS.ALREADY_BEGIN };
    if (tickets.has(socket) || getMatch(socket)) return { errorCode: ERRORS.ALREADY_MATCHING };
    if (!req || !req.valid) return { errorCode: ERRORS.INVALID_REQUEST };
    if (![NGT_PVP_LEAGUE, NGT_PVP_UNLIMITED].includes(req.gameType)) {
      return { errorCode: ERRORS.INVALID_MATCH_TYPE };
    }
    const deck = validatePlayerDeckForGameLoad(user, req, { deckType: NDT_PVP, requiredState: 0 });
    if (!deck.valid) return { errorCode: deck.errorCode };
    const limits = getDraftBanLimits();
    if (getArmyUnits(user).filter(isDraftEligibleUnit).length < limits.minUnitCount) {
      return { errorCode: ERRORS.NOT_ENOUGH_UNIT_COUNT };
    }
    if (getArmyShips(user).filter(isDraftEligibleShip).length < limits.minShipCount) {
      return { errorCode: ERRORS.NOT_ENOUGH_SHIP_COUNT };
    }

    const ticket = { socket, user, req, deckIndex: deck.deckIndex, state: "waiting", match: null };
    tickets.set(socket, ticket);
    const peerIndex = waiting.findIndex((entry) => entry.req.gameType === req.gameType);
    if (peerIndex < 0) {
      waiting.push(ticket);
      logger(`[league-pvp-match] queued uid=${String(userUid(user))} type=${req.gameType}`);
      return { errorCode: ERRORS.OK, ticket, match: null };
    }

    const peer = waiting.splice(peerIndex, 1)[0];
    const match = createMatch(peer, ticket);
    matches.add(match);
    logger(`[league-pvp-match] paired match=${match.id} A=${String(userUid(peer.user))} B=${String(userUid(user))}`);
    return { errorCode: ERRORS.OK, ticket, peer, match };
  }

  function cancel(socket) {
    purgeDisconnected();
    const ticket = tickets.get(socket);
    if (!ticket || ticket.state !== "waiting" || ticket.match) return { errorCode: ERRORS.CANCEL_FAIL };
    removeWaiting(ticket);
    tickets.delete(socket);
    ticket.state = "cancelled";
    return { errorCode: ERRORS.OK, ticket };
  }

  function giveup(socket) {
    const match = getMatch(socket);
    const member = getMember(socket);
    if (!match || !member) return { errorCode: ERRORS.NOT_IN_GAME_ROOM, match, member };
    if (
      match.state !== "draft" ||
      match.roomState < DRAFT_STATE.BAN_ALL ||
      match.roomState >= DRAFT_STATE.PICK_ETC
    ) return { errorCode: ERRORS.DRAFT_INVALID_STATE, match, member };
    return { errorCode: ERRORS.OK, match, member };
  }

  function startDraft(match, ctx) {
    if (!match || match.state !== "draft") return false;
    armDraftTimeout(match, ctx);
    return true;
  }

  function globalBan(socket, request) {
    const draft = requireDraft(socket, [DRAFT_STATE.INIT]);
    if (draft.errorCode) return draft;
    if (!request || !request.valid || !isGlobalBanCandidate(request.value)) {
      return draftFailure(ERRORS.INVALID_REQUEST, draft);
    }
    const bans = draft.member.globalBanUnitIdList;
    if (bans.length >= 2) return draftFailure(ERRORS.GLOBAL_BAN_COMPLETED, draft);
    if (bans.includes(request.value)) return draftFailure(ERRORS.GLOBAL_BAN_DUPLICATED, draft);
    bans.push(request.value);
    return draftSuccess(draft, draft.match.members.every((entry) => entry.globalBanUnitIdList.length >= 2)
      ? DRAFT_STATE.BAN_ALL
      : null);
  }

  function selectUnit(socket, request) {
    const draft = requireActivePick(socket);
    if (draft.errorCode) return draft;
    const candidate = validateDraftUnit(draft.match, draft.member, request);
    if (candidate.errorCode) return draftFailure(candidate.errorCode, draft);
    draft.match.selectedUnit = candidate.unit;
    return draftSuccess(draft);
  }

  function pickUnit(socket, request) {
    const draft = requireActivePick(socket);
    if (draft.errorCode) return draft;
    const targetCount = pickTargetCount(draft.match.roomState);
    if (draft.member.pickUnitList.length >= targetCount) {
      return draftFailure(ERRORS.UNIT_FULL_ON_STEP, draft);
    }
    const candidate = validateDraftUnit(draft.match, draft.member, request);
    if (candidate.errorCode) return draftFailure(candidate.errorCode, draft);
    draft.member.pickUnitList.push(candidate.unit);
    draft.match.selectedUnit = null;
    const complete = draft.member.pickUnitList.length >= targetCount;
    return draftSuccess(draft, complete ? nextPickState(draft.match.roomState) : null);
  }

  function opponentBan(socket, request) {
    const draft = requireDraft(socket, [DRAFT_STATE.BAN_OPPONENT]);
    if (draft.errorCode) return draft;
    const opponent = otherMember(draft.match, draft.member);
    if (!opponent) return draftFailure(ERRORS.NOT_IN_GAME_ROOM, draft);
    if (opponent.banishedUnitIndex >= 0) return draftFailure(ERRORS.OPPONENT_BAN_DUPLICATED, draft);
    if (!request || !request.valid || request.value < 0 || request.value >= opponent.pickUnitList.length) {
      return draftFailure(ERRORS.OPPONENT_BAN_INVALID_INDEX, draft);
    }
    opponent.banishedUnitIndex = request.value;
    return draftSuccess(draft, draft.match.members.every((entry) => entry.banishedUnitIndex >= 0)
      ? DRAFT_STATE.PICK_ETC
      : null);
  }

  function pickShip(socket, request) {
    const draft = requireDraft(socket, [DRAFT_STATE.PICK_ETC]);
    if (draft.errorCode) return draft;
    if (draft.member.mainShip) return draftFailure(ERRORS.MAIN_SHIP_DUPLICATED, draft);
    const ship = request && request.valid ? getArmyUnitByUid(draft.member.user, request.value) : null;
    const templet = ship && getUnitTemplet(ship.unitId);
    if (!ship || !templet || String(templet.m_NKM_UNIT_TYPE || "") !== "NUT_SHIP" || ship.isSeized) {
      return draftFailure(ERRORS.INVALID_REQUEST, draft);
    }
    const groupId = shipGroupId(templet);
    const globalShipBans = draft.match.members.flatMap((entry) => entry.globalBanShipGroupIdList);
    if (groupId > 0 && globalShipBans.includes(groupId)) return draftFailure(ERRORS.BANISHED_SHIP, draft);
    const opponent = otherMember(draft.match, draft.member);
    if (opponent && opponent.mainShip && sameShipGroup(opponent.mainShip, ship)) {
      return draftFailure(ERRORS.MAIN_SHIP_DUPLICATED, draft);
    }
    draft.member.mainShip = ship;
    return draftSuccess(draft);
  }

  function pickOperator(socket, request) {
    const draft = requireDraft(socket, [DRAFT_STATE.PICK_ETC]);
    if (draft.errorCode) return draft;
    if (!draft.member.mainShip) return draftFailure(ERRORS.DRAFT_INVALID_STATE, draft);
    if (draft.member.operatorChosen) return draftFailure(ERRORS.OPERATOR_DUPLICATED, draft);
    let operator = null;
    if (request && request.valid && request.value !== 0n) {
      operator = getArmyOperatorByUid(draft.member.user, request.value);
      if (!operator) return draftFailure(ERRORS.INVALID_REQUEST, draft);
      const opponent = otherMember(draft.match, draft.member);
      if (opponent && opponent.operatorUnit && operatorId(opponent.operatorUnit) === operatorId(operator)) {
        return draftFailure(ERRORS.OPERATOR_DUPLICATED, draft);
      }
    } else if (!request || !request.valid) {
      return draftFailure(ERRORS.INVALID_REQUEST, draft);
    }
    draft.member.operatorUnit = operator;
    draft.member.operatorChosen = true;
    return draftSuccess(draft);
  }

  function pickLeader(socket, request) {
    const draft = requireDraft(socket, [DRAFT_STATE.PICK_ETC]);
    if (draft.errorCode) return draft;
    if (!draft.member.mainShip || !draft.member.operatorChosen) {
      return draftFailure(ERRORS.DRAFT_INVALID_STATE, draft);
    }
    if (draft.member.leaderIndex >= 0) return draftFailure(ERRORS.LEADER_UNIT_DUPLICATED, draft);
    const index = request && request.valid ? request.value : -1;
    if (index < 0 || index >= draft.member.pickUnitList.length || index === draft.member.banishedUnitIndex) {
      return draftFailure(ERRORS.LEADER_INVALID_INDEX, draft);
    }
    draft.member.leaderIndex = index;
    return draftSuccess(draft, draft.match.members.every((entry) => entry.leaderIndex >= 0)
      ? DRAFT_STATE.DRAFT_COMPLETE
      : null);
  }

  function publishDraftResult(result, ctx) {
    if (!result || result.errorCode !== ERRORS.OK || !result.match) return false;
    if (result.nextState != null) return enterDraftState(result.match, result.nextState, ctx);
    broadcastDraftRoom(result.match, ctx);
    armDraftTimeout(result.match, ctx);
    return true;
  }

  function enterDraftState(match, roomState, ctx) {
    if (!match || match.state !== "draft") return false;
    clearDraftTimer(match);
    match.roomState = roomState;
    match.currentStateTeamType = activeTeamForState(roomState);
    match.selectedUnit = null;
    const durationMs = draftDurationMs(roomState);
    match.stateDeadlineMs = Date.now() + durationMs;
    match.stateEndTime = dateTimeBinaryNow() + BigInt(durationMs) * 10000n;
    broadcastDraftRoom(match, ctx);
    armDraftTimeout(match, ctx);
    return true;
  }

  function broadcastDraftRoom(match, ctx) {
    if (!ctx || typeof ctx.sendServerGamePacket !== "function") return 0;
    const payload = buildLeagueRoomNotification(match);
    let count = 0;
    for (const member of match.members) {
      if (!member.socket || member.socket.destroyed) continue;
      ctx.sendServerGamePacket(member.socket, PACKETS.UPDATED_NOT, payload, "league-pvp-draft-updated");
      count += 1;
    }
    return count;
  }

  function armDraftTimeout(match, ctx) {
    clearDraftTimer(match);
    if (!timersEnabled || !match || match.state !== "draft") return;
    const delayMs = Math.max(1, Number(match.stateDeadlineMs || 0) - Date.now());
    match.draftTimer = setTimeout(() => handleDraftTimeout(match, ctx), delayMs);
    if (match.draftTimer && typeof match.draftTimer.unref === "function") match.draftTimer.unref();
  }

  function handleDraftTimeout(match, ctx) {
    delete match.draftTimer;
    if (!match || match.state !== "draft") return;
    if (match.roomState === DRAFT_STATE.BAN_ALL) {
      enterDraftState(match, DRAFT_STATE.BAN_COMPLETE, ctx);
      return;
    }
    if (match.roomState === DRAFT_STATE.BAN_COMPLETE) {
      enterDraftState(match, DRAFT_STATE.PICK_UNIT_1, ctx);
      return;
    }
    if (match.roomState === DRAFT_STATE.DRAFT_COMPLETE) {
      const started = ctx && typeof ctx.startLeaguePvpMatch === "function" && ctx.startLeaguePvpMatch(match);
      if (!started) fail(match, ctx, ERRORS.LEAGUE_MISS_MATCH);
      return;
    }
    const result = autoCompleteDraftState(match);
    if (!result || result.errorCode !== ERRORS.OK) {
      fail(match, ctx, result && result.errorCode || ERRORS.LEAGUE_MISS_MATCH);
      return;
    }
    publishDraftResult(result, ctx);
  }

  function autoCompleteDraftState(match) {
    if (match.roomState === DRAFT_STATE.INIT) {
      const candidates = getGlobalBanCandidates();
      for (const member of match.members) {
        for (const unitId of candidates) {
          if (member.globalBanUnitIdList.length >= 2) break;
          if (!member.globalBanUnitIdList.includes(unitId)) member.globalBanUnitIdList.push(unitId);
        }
        if (member.globalBanUnitIdList.length < 2) return { errorCode: ERRORS.NOT_ENOUGH_UNIT_COUNT, match };
      }
      return { errorCode: ERRORS.OK, match, nextState: DRAFT_STATE.BAN_ALL };
    }
    if (isPickState(match.roomState)) {
      const member = memberForTeam(match, activeTeamForState(match.roomState));
      const target = pickTargetCount(match.roomState);
      while (member && member.pickUnitList.length < target) {
        const unit = getArmyUnits(member.user).find((candidate) => !validateDraftUnit(match, member, {
          valid: true,
          value: toBigInt(candidate.unitUid || 0),
        }).errorCode);
        if (!unit) return { errorCode: ERRORS.NOT_ENOUGH_UNIT_COUNT, match };
        member.pickUnitList.push(unit);
      }
      match.selectedUnit = null;
      return { errorCode: ERRORS.OK, match, nextState: nextPickState(match.roomState) };
    }
    if (match.roomState === DRAFT_STATE.BAN_OPPONENT) {
      for (const member of match.members) {
        const opponent = otherMember(match, member);
        if (opponent && opponent.banishedUnitIndex < 0) opponent.banishedUnitIndex = 0;
      }
      return { errorCode: ERRORS.OK, match, nextState: DRAFT_STATE.PICK_ETC };
    }
    if (match.roomState === DRAFT_STATE.PICK_ETC) {
      for (const member of match.members) {
        if (!member.mainShip) {
          member.mainShip = getArmyShips(member.user).find((ship) => {
            const opponent = otherMember(match, member);
            return !opponent || !opponent.mainShip || !sameShipGroup(opponent.mainShip, ship);
          }) || null;
        }
        if (!member.mainShip) return { errorCode: ERRORS.NOT_ENOUGH_SHIP_COUNT, match };
        if (!member.operatorChosen) {
          const opponent = otherMember(match, member);
          member.operatorUnit = getArmyOperators(member.user).find((operator) =>
            !opponent || !opponent.operatorUnit || operatorId(opponent.operatorUnit) !== operatorId(operator)
          ) || null;
          member.operatorChosen = true;
        }
        if (member.leaderIndex < 0) {
          member.leaderIndex = member.pickUnitList.findIndex((_unit, index) => index !== member.banishedUnitIndex);
        }
        if (member.leaderIndex < 0) return { errorCode: ERRORS.LEADER_INVALID_INDEX, match };
      }
      return { errorCode: ERRORS.OK, match, nextState: DRAFT_STATE.DRAFT_COMPLETE };
    }
    return { errorCode: ERRORS.DRAFT_INVALID_STATE, match };
  }

  function activate(match) {
    if (!match || match.state !== "draft" || match.roomState !== DRAFT_STATE.DRAFT_COMPLETE) return false;
    clearDraftTimer(match);
    match.state = "active";
    match.matchStarted = true;
    for (const member of match.members) if (member.ticket) member.ticket.state = "active";
    return true;
  }

  function requireDraft(socket, states) {
    const match = getMatch(socket);
    const member = getMember(socket);
    if (!match || !member) return { errorCode: ERRORS.NOT_IN_GAME_ROOM, match, member };
    if (match.state !== "draft" || !states.includes(match.roomState)) {
      return { errorCode: ERRORS.DRAFT_INVALID_STATE, match, member };
    }
    if (Number(match.stateDeadlineMs || 0) > 0 && Date.now() > Number(match.stateDeadlineMs)) {
      return { errorCode: ERRORS.DRAFT_INVALID_TIME, match, member };
    }
    return { errorCode: ERRORS.OK, match, member };
  }

  function requireActivePick(socket) {
    const match = getMatch(socket);
    const member = getMember(socket);
    if (!match || !member) return { errorCode: ERRORS.NOT_IN_GAME_ROOM, match, member };
    if (!isPickState(match.roomState) || match.state !== "draft" || activeTeamForState(match.roomState) !== member.teamType) {
      return { errorCode: ERRORS.DRAFT_INVALID_STATE, match, member };
    }
    if (Number(match.stateDeadlineMs || 0) > 0 && Date.now() > Number(match.stateDeadlineMs)) {
      return { errorCode: ERRORS.DRAFT_INVALID_TIME, match, member };
    }
    return { errorCode: ERRORS.OK, match, member };
  }

  function draftDurationMs(roomState) {
    if (roomState === DRAFT_STATE.BAN_ALL || roomState === DRAFT_STATE.BAN_COMPLETE) return revealStateMs;
    if (roomState === DRAFT_STATE.DRAFT_COMPLETE) return battleCountdownMs;
    return draftStateMs;
  }

  function clearDraftTimer(match) {
    if (match && match.draftTimer) clearTimeout(match.draftTimer);
    if (match) delete match.draftTimer;
  }

  function handleSocketClose(socket, ctx) {
    const ticket = tickets.get(socket);
    if (!ticket) return false;
    removeWaiting(ticket);
    tickets.delete(socket);
    if (!ticket.match) {
      ticket.state = "disconnected";
      return true;
    }
    const match = ticket.match;
    const member = match.members.find((entry) => entry.socket === socket);
    if (!member || match.state === "failed") return false;
    member.socket = null;
    member.disconnectedAt = Date.now();
    ticket.socket = null;
    clearMatchSession(socket, match);
    member.disconnectTimer = setTimeout(() => {
      if (!member.socket && match.state !== "failed") fail(match, ctx, ERRORS.LEAGUE_MISS_MATCH);
    }, disconnectGraceMs);
    if (member.disconnectTimer && typeof member.disconnectTimer.unref === "function") member.disconnectTimer.unref();
    return true;
  }

  function reattachUser(user, socket) {
    const uid = userUid(user);
    if (!socket || uid === 0n) return null;
    for (const match of matches) {
      if (!match || match.state === "failed") continue;
      const member = match.members.find((entry) => !entry.socket && userUid(entry.user) === uid);
      if (!member) continue;
      if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
      delete member.disconnectTimer;
      delete member.disconnectedAt;
      member.socket = socket;
      member.ticket.socket = socket;
      tickets.set(socket, member.ticket);
      if (socket.session) {
        socket.session.user = member.user;
        socket.session.leaguePvpMatch = match;
        socket.session.leaguePvpMember = member;
      }
      return { match, member };
    }
    return null;
  }

  function fail(match, ctx, errorCode = ERRORS.LEAGUE_MISS_MATCH, exceptSocket = null) {
    if (!match || match.state === "failed") return false;
    clearDraftTimer(match);
    match.state = "failed";
    matches.delete(match);
    for (const member of match.members) {
      const memberSocket = member.socket;
      if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
      if (member.ticket) {
        tickets.delete(memberSocket);
        member.ticket.state = "failed";
      }
      clearMatchSession(memberSocket, match);
      if (memberSocket && memberSocket !== exceptSocket && !memberSocket.destroyed && ctx && typeof ctx.sendServerGamePacket === "function") {
        ctx.sendServerGamePacket(memberSocket, PACKETS.MATCH_FAIL_NOT, writeSignedVarInt(errorCode), "league-pvp-match-failed");
      }
    }
    return true;
  }

  function getMatch(socket) {
    return socket && socket.session && socket.session.leaguePvpMatch || null;
  }

  function getMember(socket) {
    const match = getMatch(socket);
    return match && match.members.find((entry) => entry.socket === socket) || null;
  }

  function createMatch(first, second) {
    const stateDeadlineMs = Date.now() + draftStateMs;
    const match = {
      id: nextMatchId++,
      leaguePvp: true,
      gameType: first.req.gameType,
      state: "draft",
      roomState: 0,
      stateEndTime: dateTimeBinaryNow() + BigInt(draftStateMs) * 10000n,
      stateDeadlineMs,
      currentStateTeamType: TEAM_A,
      selectedUnit: null,
      members: [],
    };
    attach(first, match, TEAM_A);
    attach(second, match, TEAM_B);
    return match;
  }

  function attach(ticket, match, teamType) {
    removeWaiting(ticket);
    ticket.state = "matched";
    ticket.match = match;
    const member = {
      socket: ticket.socket,
      user: ticket.user,
      ticket,
      teamType,
      observer: false,
      loaded: false,
      playerState: 2,
      globalBanUnitIdList: [],
      globalBanShipGroupIdList: [],
      pickUnitList: [],
      banishedUnitIndex: -1,
      mainShip: null,
      operatorUnit: null,
      operatorChosen: false,
      leaderIndex: -1,
    };
    match.members.push(member);
    if (ticket.socket && ticket.socket.session) {
      ticket.socket.session.leaguePvpMatch = match;
      ticket.socket.session.leaguePvpMember = member;
    }
  }

  function removeWaiting(ticket) {
    const index = waiting.indexOf(ticket);
    if (index >= 0) waiting.splice(index, 1);
  }

  function purgeDisconnected() {
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const ticket = waiting[index];
      if (ticket.socket && !ticket.socket.destroyed) continue;
      waiting.splice(index, 1);
      tickets.delete(ticket.socket);
      ticket.state = "disconnected";
    }
  }

  return {
    activate,
    advanceDraftState: enterDraftState,
    globalBan,
    selectUnit,
    pickUnit,
    opponentBan,
    pickShip,
    pickOperator,
    pickLeader,
    publishDraftResult,
    startDraft,
    request,
    cancel,
    fail,
    handleSocketClose,
    reattachUser,
    getMatch,
    getMember,
    giveup,
    buildRoomData: buildLeagueRoomData,
    waiting,
    tickets,
    matches,
  };
}

function draftSuccess(draft, nextState = null) {
  return { errorCode: ERRORS.OK, match: draft.match, member: draft.member, nextState };
}

function draftFailure(errorCode, draft = {}) {
  return { errorCode, match: draft.match || null, member: draft.member || null, nextState: null };
}

function isPickState(roomState) {
  return roomState >= DRAFT_STATE.PICK_UNIT_1 && roomState <= DRAFT_STATE.PICK_UNIT_10;
}

function pickTargetCount(roomState) {
  return isPickState(roomState) ? PICK_TARGET_COUNTS[roomState - DRAFT_STATE.PICK_UNIT_1] : 0;
}

function activeTeamForState(roomState) {
  if (!isPickState(roomState)) return TEAM_A;
  return (roomState - DRAFT_STATE.PICK_UNIT_1) % 2 === 0 ? TEAM_A : TEAM_B;
}

function nextPickState(roomState) {
  return roomState < DRAFT_STATE.PICK_UNIT_10 ? roomState + 1 : DRAFT_STATE.BAN_OPPONENT;
}

function memberForTeam(match, teamType) {
  return match && Array.isArray(match.members)
    ? match.members.find((entry) => Number(entry.teamType) === Number(teamType)) || null
    : null;
}

function otherMember(match, member) {
  return match && Array.isArray(match.members) ? match.members.find((entry) => entry !== member) || null : null;
}

function validateDraftUnit(match, member, request) {
  if (!request || !request.valid) return { errorCode: ERRORS.INVALID_REQUEST, unit: null };
  const unit = getArmyUnitByUid(member && member.user, request.value);
  if (!unit || !isDraftEligibleUnit(unit)) return { errorCode: ERRORS.INVALID_REQUEST, unit: null };
  if ((match.members || []).some((entry) => entry.globalBanUnitIdList.includes(Number(unit.unitId)))) {
    return { errorCode: ERRORS.BANISHED_UNIT_ID, unit: null };
  }
  if ((match.members || []).some((entry) => entry.pickUnitList.some((picked) => Number(picked.unitId) === Number(unit.unitId)))) {
    return { errorCode: ERRORS.OTHER_PLAYER_PICKED_UNIT, unit: null };
  }
  return { errorCode: ERRORS.OK, unit };
}

function isGlobalBanCandidate(unitId) {
  const templet = getUnitTemplet(unitId);
  return Boolean(
    templet &&
    String(templet.m_NKM_UNIT_TYPE || "") === "NUT_NORMAL" &&
    ["NUG_SSR", "NUG_SR"].includes(String(templet.m_NKM_UNIT_GRADE || "")) &&
    !templet.m_bMonster &&
    isCollectionVisibleUnitId(templet.m_UnitID)
  );
}

function isDraftEligibleUnit(unit) {
  const templet = unit && getUnitTemplet(unit.unitId);
  return Boolean(
    unit && templet && !unit.isSeized &&
    String(templet.m_NKM_UNIT_TYPE || "") === "NUT_NORMAL" &&
    !templet.m_bMonster &&
    isCollectionVisibleUnitId(templet.m_UnitID)
  );
}

function isDraftEligibleShip(ship) {
  const templet = ship && getUnitTemplet(ship.unitId);
  return Boolean(ship && templet && !ship.isSeized && String(templet.m_NKM_UNIT_TYPE || "") === "NUT_SHIP");
}

function getDraftBanLimits() {
  if (cachedDraftBanLimits) return cachedDraftBanLimits;
  const row = readGameplayTableRecords("ab_script", "LUA_PVP_CONST.json")
    .find((entry) => String(entry && entry.__key || "") === "DraftBan") || {};
  cachedDraftBanLimits = Object.freeze({
    minUnitCount: Math.max(9, Number(row.MinUnitCount) || 30),
    minShipCount: Math.max(2, Number(row.MinShipCount) || 3),
  });
  return cachedDraftBanLimits;
}

function getLeagueBattlePoint(result) {
  const key = Number(result) === 0 ? "LeaguePvpWinPoint" : "LeaguePvpLosePoint";
  const row = readGameplayTableRecords("ab_script", "LUA_PVP_CONST.json")
    .find((entry) => String(entry && entry.__key || "") === key);
  return Math.max(0, Number(row && row.value) || 0);
}

function getGlobalBanCandidates() {
  return getPlayableUnitIds().filter(isGlobalBanCandidate);
}

function shipGroupId(templet) {
  return Number(templet && (templet.m_ShipGroupID || templet.m_UnitID)) || 0;
}

function sameShipGroup(left, right) {
  return shipGroupId(getUnitTemplet(left && left.unitId)) === shipGroupId(getUnitTemplet(right && right.unitId));
}

function operatorId(operator) {
  return Number(operator && (operator.id || operator.unitId)) || 0;
}

function buildDraftPlayerDeck(member) {
  if (!member || !member.user || !member.ticket || !member.mainShip || member.leaderIndex < 0) return null;
  const activePicks = member.pickUnitList
    .map((unit, index) => ({ unit, index }))
    .filter((entry) => entry.index !== member.banishedUnitIndex);
  if (activePicks.length !== 8) return null;
  const leaderIndex = activePicks.findIndex((entry) => entry.index === member.leaderIndex);
  if (leaderIndex < 0) return null;
  const slotUnitUids = Object.fromEntries(activePicks.map((entry, index) => [index, entry.unit.unitUid]));
  return buildPlayerDeckForGameLoad(
    member.user,
    { selectDeckIndex: member.ticket.req.selectDeckIndex },
    {
      deckIndex: { deckType: NDT_PVP, index: member.ticket.req.selectDeckIndex },
      strictSelection: true,
      allowedUnitSlots: activePicks.map((_entry, index) => index),
      slotUnitUids,
      shipUid: member.mainShip.unitUid,
      operatorUid: member.operatorUnit && (member.operatorUnit.uid || member.operatorUnit.operatorUid) || 0,
      leaderIndex,
    }
  );
}

function createLeaguePvpHandlers() {
  return [
    {
      packetId: PACKETS.MATCH_REQ,
      name: "LEAGUE_PVP_MATCH_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const req = decodeMatchRequest(ctx, packet && packet.payload);
        const result = ctx.leaguePvpMatchmaking.request(socket, user, req);
        ctx.sendGameResponse(socket, packet, PACKETS.MATCH_ACK, writeSignedVarInt(result.errorCode), "league-pvp-match");
        if (result.errorCode === ERRORS.OK && result.match) {
          const payload = buildLeagueRoomNotification(result.match);
          for (const member of result.match.members) {
            if (member.socket && !member.socket.destroyed) {
              ctx.sendServerGamePacket(member.socket, PACKETS.ACCEPT_NOT, payload, "league-pvp-accepted");
            }
          }
          ctx.leaguePvpMatchmaking.startDraft(result.match, ctx);
        }
        return true;
      },
    },
    {
      packetId: PACKETS.MATCH_CANCEL_REQ,
      name: "LEAGUE_PVP_MATCH_CANCEL_REQ",
      handle(ctx, socket, packet) {
        const result = decodeEmptyRequest(ctx, packet && packet.payload)
          ? ctx.leaguePvpMatchmaking.cancel(socket)
          : { errorCode: ERRORS.INVALID_REQUEST };
        ctx.sendGameResponse(socket, packet, PACKETS.MATCH_CANCEL_ACK, writeSignedVarInt(result.errorCode), "league-pvp-match-cancel");
        return true;
      },
    },
    createDraftActionHandler(PACKETS.GLOBAL_BAN_REQ, PACKETS.GLOBAL_BAN_ACK, "DRAFT_PVP_GLOBAL_BAN_REQ", "globalBan", decodeDraftIntRequest),
    createDraftActionHandler(PACKETS.PICK_UNIT_REQ, PACKETS.PICK_UNIT_ACK, "DRAFT_PVP_PICK_UNIT_REQ", "pickUnit", decodeDraftLongRequest),
    createDraftActionHandler(PACKETS.OPPONENT_BAN_REQ, PACKETS.OPPONENT_BAN_ACK, "DRAFT_PVP_OPPONENT_BAN_REQ", "opponentBan", decodeDraftIntRequest),
    createDraftActionHandler(PACKETS.PICK_SHIP_REQ, PACKETS.PICK_SHIP_ACK, "DRAFT_PVP_PICK_SHIP_REQ", "pickShip", decodeDraftLongRequest),
    createDraftActionHandler(PACKETS.PICK_OPERATOR_REQ, PACKETS.PICK_OPERATOR_ACK, "DRAFT_PVP_PICK_OPERATOR_REQ", "pickOperator", decodeDraftLongRequest),
    createDraftActionHandler(PACKETS.PICK_LEADER_REQ, PACKETS.PICK_LEADER_ACK, "DRAFT_PVP_PICK_LEADER_REQ", "pickLeader", decodeDraftIntRequest),
    createDraftActionHandler(PACKETS.SELECT_UNIT_REQ, PACKETS.SELECT_UNIT_ACK, "DRAFT_PVP_SELECT_UNIT_REQ", "selectUnit", decodeDraftLongRequest),
    {
      packetId: PACKETS.GIVEUP_REQ,
      name: "LEAGUE_PVP_GIVEUP_REQ",
      handle(ctx, socket, packet) {
        const manager = ctx && ctx.leaguePvpMatchmaking;
        const result = decodeEmptyRequest(ctx, packet && packet.payload) && manager && typeof manager.giveup === "function"
          ? manager.giveup(socket)
          : { errorCode: manager ? ERRORS.INVALID_REQUEST : ERRORS.NOT_IN_GAME_ROOM };
        ctx.sendGameResponse(socket, packet, PACKETS.GIVEUP_ACK, writeSignedVarInt(result.errorCode), "league-pvp-giveup");
        if (result.errorCode === ERRORS.OK) manager.fail(result.match, ctx, ERRORS.LEAGUE_MISS_MATCH);
        return true;
      },
    },
    {
      packetId: PACKETS.RANK_LIST_REQ,
      name: "LEAGUE_PVP_RANK_LIST_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const result = getLeagueRankList(ctx, user, decodeRankListRequest(ctx, packet && packet.payload));
        if (ctx && typeof ctx.sendGameResponse === "function") {
          ctx.sendGameResponse(socket, packet, PACKETS.RANK_LIST_ACK, buildRankListAck(result), "league-pvp-rank-list");
        }
        console.log(`[league-pvp] RANK_LIST_ACK error=${result.errorCode} rank=${result.myRank} profiles=${result.profiles.length}`);
        return true;
      },
    },
    {
      packetId: PACKETS.SEASON_REWARD_REQ,
      name: "LEAGUE_PVP_SEASON_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const result = decodeEmptyRequest(ctx, packet && packet.payload)
          ? claimLeagueSeasonReward(ctx, user, { now: getNow(ctx) })
          : failedSeasonReward(ERRORS.SEASON_TEMPLET_NULL);
        if (ctx && typeof ctx.sendGameResponse === "function") {
          ctx.sendGameResponse(socket, packet, PACKETS.SEASON_REWARD_ACK, buildSeasonRewardAck(result), "league-pvp-season-reward");
        }
        persistSuccess(ctx, result, "league-pvp-season-reward");
        console.log(`[league-pvp] SEASON_REWARD_ACK error=${result.errorCode}`);
        return true;
      },
    },
    {
      packetId: PACKETS.WEEKLY_RANKER_REQ,
      name: "LEAGUE_PVP_WEEKLY_RANKER_REQ",
      handle(ctx, socket, packet) {
        const valid = decodeEmptyRequest(ctx, packet && packet.payload);
        const result = { errorCode: valid ? ERRORS.OK : ERRORS.SEASON_TEMPLET_NULL, profiles: [] };
        if (ctx && typeof ctx.sendGameResponse === "function") {
          ctx.sendGameResponse(socket, packet, PACKETS.WEEKLY_RANKER_ACK, buildWeeklyRankerAck(result), "league-pvp-weekly-rankers");
        }
        console.log(`[league-pvp] WEEKLY_RANKER_ACK error=${result.errorCode} profiles=0`);
        return true;
      },
    },
    {
      packetId: PACKETS.SEASON_INFO_REQ,
      name: "LEAGUE_PVP_SEASON_INFO_REQ",
      handle(ctx, socket, packet) {
        const valid = decodeEmptyRequest(ctx, packet && packet.payload);
        const user = socket && socket.session && socket.session.user;
        const result = valid
          ? {
              errorCode: ERRORS.OK,
              seasonRewardReceived: hasLeagueSeasonReward(user),
              leaguePvpState: getLeaguePvpState(user),
              rankerDatas: [],
            }
          : { errorCode: ERRORS.SEASON_TEMPLET_NULL, leaguePvpState: null, rankerDatas: [] };
        if (ctx && typeof ctx.sendGameResponse === "function") {
          ctx.sendGameResponse(socket, packet, PACKETS.SEASON_INFO_ACK, buildSeasonInfoAck(result), "league-pvp-season-info");
        }
        console.log(`[league-pvp] SEASON_INFO_ACK error=${result.errorCode} rankers=${result.rankerDatas.length}`);
        return true;
      },
    },
  ];
}

function createDraftActionHandler(packetId, ackId, name, method, decoder) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      const request = decoder(ctx, packet && packet.payload);
      const manager = ctx && ctx.leaguePvpMatchmaking;
      const result = manager && typeof manager[method] === "function"
        ? manager[method](socket, request)
        : { errorCode: ERRORS.NOT_IN_GAME_ROOM };
      ctx.sendGameResponse(socket, packet, ackId, writeSignedVarInt(result.errorCode), `league-pvp-${method}`);
      if (result.errorCode === ERRORS.OK) manager.publishDraftResult(result, ctx);
      return true;
    },
  };
}

function decodeDraftIntRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const value = readSignedVarInt(payload, 0);
    if (value.offset !== payload.length || !writeSignedVarInt(value.value).equals(payload)) return invalidDraftRequest(0);
    return { valid: true, value: value.value };
  } catch (_) {
    return invalidDraftRequest(0);
  }
}

function decodeDraftLongRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const value = readSignedVarLong(payload, 0);
    if (value.offset !== payload.length || !writeSignedVarLong(value.value).equals(payload)) return invalidDraftRequest(0n);
    return { valid: true, value: value.value };
  } catch (_) {
    return invalidDraftRequest(0n);
  }
}

function invalidDraftRequest(value) {
  return { valid: false, value };
}

function decodeMatchRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const selectDeckIndex = readByte(payload, 0);
    const gameType = readByte(payload, selectDeckIndex.offset);
    if (gameType.offset !== payload.length) return invalidMatchRequest();
    return { valid: true, selectDeckIndex: selectDeckIndex.value, gameType: gameType.value };
  } catch (_) {
    return invalidMatchRequest();
  }
}

function invalidMatchRequest() {
  return { valid: false, selectDeckIndex: 0, gameType: 0 };
}

function decrypt(ctx, encryptedPayload) {
  const payload = ctx && typeof ctx.decryptCopy === "function"
    ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
    : encryptedPayload;
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
}

function buildLeagueRoomNotification(match) {
  return writeNullableObject(buildLeagueRoomData(match));
}

function buildLeagueRoomData(match = {}) {
  const teamA = (match.members || []).find((entry) => Number(entry.teamType) === TEAM_A) || null;
  const teamB = (match.members || []).find((entry) => Number(entry.teamType) === TEAM_B) || null;
  return Buffer.concat([
    writeSignedVarInt(Number(match.gameType) || NGT_PVP_LEAGUE),
    writeSignedVarInt(Number(match.roomState) || 0),
    writeInt64LE(toBigInt(match.stateEndTime || dateTimeBinaryNow())),
    writeSignedVarInt(Number(match.currentStateTeamType) || TEAM_A),
    match.selectedUnit ? writeNullableObject(buildAsyncUnitData(match.selectedUnit)) : writeNullObject(),
    writeNullableObject(buildDraftTeamData(teamA)),
    writeNullableObject(buildDraftTeamData(teamB)),
  ]);
}

function buildDraftTeamData(member) {
  const user = member && member.user || {};
  return Buffer.concat([
    writeSignedVarInt(Number(member && member.teamType) || 0),
    writeNullableObject(buildUserProfileData(user, null, { leaguePvpData: getLeaguePvpState(user) })),
    writeIntList(member && member.globalBanUnitIdList || []),
    writeIntList(member && member.globalBanShipGroupIdList || []),
    writeNullableObjectList((member && member.pickUnitList || []).map(buildAsyncUnitData)),
    writeSignedVarInt(Number.isInteger(member && member.banishedUnitIndex) ? member.banishedUnitIndex : -1),
    writeNullableObject(buildAsyncUnitData(member && member.mainShip)),
    member && member.operatorUnit ? writeNullableObject(buildOperatorData(member.operatorUnit)) : writeNullObject(),
    writeSignedVarInt(Number.isInteger(member && member.leaderIndex) ? member.leaderIndex : -1),
  ]);
}

function buildAsyncUnitData(unit) {
  const data = unit && typeof unit === "object" ? unit : {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid || 0)),
    writeSignedVarInt(Number(data.unitId || 0) || 0),
    writeSignedVarInt(Number(data.level || 0) || 0),
    writeSignedVarInt(Number(data.skinId || 0) || 0),
    writeSignedVarInt(Number(data.limitBreakLevel || 0) || 0),
    writeIntList(Array.isArray(data.skillLevels) ? data.skillLevels : []),
    writeIntList(Array.isArray(data.statExp) ? data.statExp : []),
    writeLongArray(Array.isArray(data.equipItemUids) ? data.equipItemUids : []),
    writeNullableObjectList(
      (data.shipCommandModules || data.ShipCommandModule || data.shipModules || []).map(buildShipCmdModuleData)
    ),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function hasActiveGame(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  return Boolean(replay && replay.dynamicGame && replay.dynamicBattleResultSent !== true);
}

function clearMatchSession(socket, match) {
  const session = socket && socket.session;
  if (!session) return;
  if (session.leaguePvpMatch === match) delete session.leaguePvpMatch;
  delete session.leaguePvpMember;
}

function decodeRankListRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.alloc(0);
    const rankType = readSignedVarInt(payload, 0);
    const range = readSignedVarInt(payload, rankType.offset);
    if (
      !writeSignedVarInt(rankType.value).equals(payload.subarray(0, rankType.offset)) ||
      !writeSignedVarInt(range.value).equals(payload.subarray(rankType.offset, range.offset)) ||
      range.offset !== payload.length
    ) return { valid: false, rankType: rankType.value, range: range.value };
    return { valid: true, rankType: rankType.value, range: range.value };
  } catch (_) {
    return { valid: false, rankType: 0, range: 0 };
  }
}

function decodeEmptyRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.alloc(0);
    return payload.length === 0;
  } catch (_) {
    return false;
  }
}

function getLeaguePvpState(user) {
  return normalizePvpState(user && user.pvp && user.pvp.league);
}

function recordLeaguePvpResult(user, result) {
  if (!user) return null;
  const previous = getLeaguePvpState(user);
  const win = Number(result) === 0;
  const loss = Number(result) === 1;
  const next = {
    ...previous,
    winCount: previous.winCount + (win ? 1 : 0),
    loseCount: previous.loseCount + (loss ? 1 : 0),
    winStreak: win ? previous.winStreak + 1 : 0,
    maxWinStreak: win ? Math.max(previous.maxWinStreak, previous.winStreak + 1) : previous.maxWinStreak,
    seasonPlayCount: previous.seasonPlayCount + 1,
    seasonWinCount: previous.seasonWinCount + (win ? 1 : 0),
  };
  user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
  user.pvp.league = next;
  return getLeaguePvpState(user);
}

function hasLeaguePvpState(user) {
  return Boolean(user && user.pvp && user.pvp.league && typeof user.pvp.league === "object");
}

function claimLeagueSeasonReward(ctx, user, options = {}) {
  const state = getLeaguePvpState(user);
  const season = getLeagueSeasonById(state.seasonId);
  if (!season) return failedSeasonReward(ERRORS.SEASON_TEMPLET_NULL);
  const now = validDate(options.now);
  if (
    season.gameType !== "NGT_PVP_LEAGUE" ||
    !isEffectiveTagOpen(ctx, user, season.openTag) ||
    !season.rewardStart ||
    !season.rewardEnd ||
    now < season.rewardStart ||
    now > season.rewardEnd
  ) return failedSeasonReward(ERRORS.SEASON_REWARD_INVALID_INTERVAL);
  if (hasLeagueSeasonReward(user)) {
    return failedSeasonReward(ERRORS.SEASON_REWARD_ALREADY_RECEIVED);
  }
  if (state.winCount + state.loseCount <= 0) return failedSeasonReward(ERRORS.PLAY_COUNT_ZERO);

  const catalog = loadLeagueCatalog();
  const tier = catalog.tiers.find((row) =>
    Number(row && row.m_RankGroup) === season.rankGroup &&
    Number(row && row.m_LeagueTier) === state.leagueTierId
  );
  if (!tier) return failedSeasonReward(ERRORS.RANK_TEMPLET_NULL);
  const rankRewardRow = state.rank > 0 && season.rankRewardGroup > 0
    ? catalog.seasonRewards.find((row) =>
        Number(row && row.SeasonRewardGroupId) === season.rankRewardGroup &&
        Number(row && row.MinRank) <= state.rank &&
        state.rank <= Number(row && row.MaxRank)
      )
    : null;
  if (state.rank > 0 && season.rankRewardGroup > 0 && !rankRewardRow) {
    return failedSeasonReward(ERRORS.SEASON_RANK_REWARD_TEMPLET_NULL);
  }

  const reward = grantLeagueRewardRow(ctx, user, tier, "Season");
  const rankReward = rankRewardRow ? grantLeagueRewardRow(ctx, user, rankRewardRow, "") : null;
  if (!user.pvp || typeof user.pvp !== "object") user.pvp = {};
  user.pvp.leagueSeasonRewardReceived = true;
  user.pvp.leagueSeasonRewardReceivedSeasonId = state.seasonId;
  return { errorCode: ERRORS.OK, reward, rankReward, pvpData: state, changed: true };
}

function getLeagueRankList(ctx, user, request) {
  const rankType = Number(request && request.rankType) || 0;
  const range = Number(request && request.range) || 0;
  if (!request || !request.valid || !Object.values(RANK_TYPES).includes(rankType)) {
    return { errorCode: ERRORS.INVALID_RANK_TYPE, rankType, myRank: 0, profiles: [] };
  }
  if (!Object.values(RANGES).includes(range)) {
    return { errorCode: ERRORS.INVALID_RANGE, rankType, myRank: 0, profiles: [] };
  }

  const ranked = getUsers(ctx, user)
    .filter((candidate) => candidate && candidate.pvp && candidate.pvp.league)
    .map((candidate) => ({ user: candidate, state: getLeaguePvpState(candidate) }))
    .filter((entry) => entry.state.score > 0)
    .sort((left, right) => right.state.score - left.state.score || compareUid(left.user, right.user))
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  const ownUid = userUid(user);
  const ownRank = ranked.find((entry) => userUid(entry.user) === ownUid);
  const ownState = getLeaguePvpState(user);
  const friendUids = new Set(
    user && user.community && Array.isArray(user.community.friends)
      ? user.community.friends.map(String)
      : []
  );
  const profiles = ranked.filter((entry) => {
    if (rankType === RANK_TYPES.ALL) return true;
    if (rankType === RANK_TYPES.FRIEND) return friendUids.has(String(userUid(entry.user)));
    return entry.state.leagueTierId === ownState.leagueTierId;
  }).slice(0, range === RANGES.TOP10 ? 10 : 100);
  return { errorCode: ERRORS.OK, rankType, myRank: ownRank ? ownRank.rank : 0, profiles };
}

function buildRankListAck(result = {}) {
  const profiles = Array.isArray(result.profiles) ? result.profiles : [];
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(Number(result.rankType) || 0),
    writeSignedVarInt(Number(result.myRank) || 0),
    writeNullableObjectList(profiles.map(buildUserSimpleProfileData)),
  ]);
}

function buildSeasonInfoAck(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeBool(Boolean(result.seasonRewardReceived)),
    result.leaguePvpState
      ? writeNullableObject(buildPvpStateData(result.leaguePvpState))
      : writeNullObject(),
    writeNullableObjectList(Array.isArray(result.rankerDatas) ? result.rankerDatas : []),
  ]);
}

function buildSeasonRewardAck(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
    result.rankReward ? writeNullableObject(buildRewardData(result.rankReward)) : writeNullObject(),
    result.pvpData ? writeNullableObject(buildPvpStateData(result.pvpData)) : writeNullObject(),
  ]);
}

function buildWeeklyRankerAck(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeNullableObjectList(Array.isArray(result.profiles) ? result.profiles : []),
  ]);
}

function loadLeagueCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const seasons = readGameplayTableRecords("ab_script", "LUA_PVP_LEAGUE_SEASON.json");
  const tiers = readGameplayTableRecords("ab_script", "LUA_PVP_LEAGUE.json");
  const seasonRewards = readGameplayTableRecords("ab_script", "LUA_PVP_LEAGUE_SEASON_REWARD.json");
  const intervals = readGameplayTableRecords("ab_script", "LUA_INTERVAL_TEMPLET.json");
  const intervalsById = new Map(intervals.map((row) => [String(row && row.m_DateStrID || ""), row]));
  cachedCatalog = { seasons, tiers, seasonRewards, intervalsById };
  return cachedCatalog;
}

function getLeagueSeasonById(seasonId) {
  const row = loadLeagueCatalog().seasons.find((entry) => Number(entry && entry.m_Season) === Number(seasonId));
  if (!row) return null;
  const rewardInterval = loadLeagueCatalog().intervalsById.get(String(row.m_RankGroupDateStrID || ""));
  return {
    row,
    seasonId: Number(row.m_Season) || 0,
    rankGroup: Number(row.m_RankGroup) || 0,
    rankRewardGroup: Number(row.m_RankSeasonRewardGroup) || 0,
    gameType: String(row.GameType || ""),
    openTag: String(row.OpenTag || ""),
    rewardStart: parseGameTableDate(rewardInterval && rewardInterval.m_DateStart),
    rewardEnd: parseGameTableDate(rewardInterval && rewardInterval.m_DateEnd),
  };
}

function grantLeagueRewardRow(ctx, user, row, suffix) {
  const reward = createEmptyReward();
  if (suffix) {
    const cash = Number(row && row[`m_RewardCash${suffix}`]) || 0;
    const pvpPoint = Number(row && row[`m_RewardPVPPoint${suffix}`]) || 0;
    if (cash > 0) mergeReward(reward, grantRewardByType(ctx, user, "RT_MISC", 101, cash, null, 0, { expandPackages: false }));
    if (pvpPoint > 0) mergeReward(reward, grantRewardByType(ctx, user, "RT_MISC", 5, pvpPoint, null, 0, { expandPackages: false }));
  }
  for (let index = 1; index <= 5; index += 1) {
    const type = row && row[`m_RewardType${suffix}_${index}`];
    const id = Number(row && row[`m_RewardID${suffix}_${index}`]) || 0;
    const value = Number(row && row[`m_RewardValue${suffix}_${index}`]) || 0;
    if (!type || id <= 0 || value <= 0) continue;
    mergeReward(reward, grantRewardByType(ctx, user, type, id, value, null, 0, { expandPackages: false }));
  }
  return reward;
}

function failedSeasonReward(errorCode) {
  return { errorCode, reward: null, rankReward: null, pvpData: null, changed: false };
}

function isEffectiveTagOpen(ctx, user, requiredTag) {
  const expected = String(requiredTag || "").trim().toUpperCase();
  if (!expected) return true;
  const own = Array.isArray(user && user.openTags) ? user.openTags : [];
  if (own.some((tag) => String(tag || "").toUpperCase() === expected)) return true;
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return false;
  const effective = ctx.getEffectiveOpenTags(own);
  return Array.isArray(effective) && effective.some((tag) => String(tag || "").toUpperCase() === expected);
}

function hasLeagueSeasonReward(user) {
  const pvp = user && user.pvp;
  if (!pvp || typeof pvp !== "object") return false;
  const cursor = Number(pvp.leagueSeasonRewardReceivedSeasonId) || 0;
  if (cursor > 0) return cursor === getLeaguePvpState(user).seasonId;
  return Boolean(pvp.leagueSeasonRewardReceived);
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function getNow(ctx) {
  return ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date();
}

function persistSuccess(ctx, result, label) {
  if (!result || !result.changed) return;
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function getUsers(ctx, activeUser) {
  const users = ctx && ctx.userDb && ctx.userDb.users ? Object.values(ctx.userDb.users) : [];
  if (activeUser && !users.some((entry) => userUid(entry) === userUid(activeUser))) users.push(activeUser);
  return users;
}

function userUid(user) {
  try { return toBigInt(user && user.userUid != null ? user.userUid : 0); }
  catch (_) { return 0n; }
}

function compareUid(left, right) {
  const a = userUid(left);
  const b = userUid(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

module.exports = {
  PACKETS,
  ERRORS,
  DRAFT_STATE,
  NDT_PVP,
  NGT_PVP_LEAGUE,
  NGT_PVP_UNLIMITED,
  RANGES,
  RANK_TYPES,
  buildLeagueRoomData,
  buildLeagueRoomNotification,
  buildDraftPlayerDeck,
  buildRankListAck,
  buildSeasonRewardAck,
  buildSeasonInfoAck,
  buildWeeklyRankerAck,
  claimLeagueSeasonReward,
  createLeaguePvpMatchmaker,
  createLeaguePvpHandlers,
  decodeMatchRequest,
  decodeDraftIntRequest,
  decodeDraftLongRequest,
  decodeEmptyRequest,
  decodeRankListRequest,
  getLeagueRankList,
  getLeaguePvpState,
  getDraftBanLimits,
  getLeagueBattlePoint,
  recordLeaguePvpResult,
  hasLeaguePvpState,
  getLeagueSeasonById,
  hasLeagueSeasonReward,
  loadLeagueCatalog,
};
