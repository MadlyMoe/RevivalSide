"use strict";

const {
  readBool,
  readByte,
  writeSignedVarInt,
} = require("../packet-codec");
const { validatePlayerDeckForGameLoad } = require("../unit");

const PACKETS = Object.freeze({
  MATCH_REQ: 2600,
  MATCH_ACK: 2601,
  CANCEL_REQ: 2602,
  CANCEL_ACK: 2603,
  COMPLETE_NOT: 2604,
  FAIL_NOT: 2605,
});

const ERRORS = Object.freeze({
  OK: 0,
  ALREADY_BEGIN: 106,
  ALREADY_MATCHING: 107,
  INVALID_MATCH_TYPE: 108,
  CANCEL_FAIL: 109,
  INVALID_REQUEST: 20191,
});

const NGT_PVP_RANK = 6;
const NDT_PVP = 2;

function createPvpMatchmaker(options = {}) {
  const waiting = [];
  const tickets = new Map();
  let nextMatchId = 1;
  const logger = typeof options.logger === "function" ? options.logger : () => {};

  function request(socket, user, req) {
    purgeDisconnected();
    if (hasActiveGame(socket)) return { errorCode: ERRORS.ALREADY_BEGIN };
    if (tickets.has(socket)) return { errorCode: ERRORS.ALREADY_MATCHING };
    if (!req || !req.valid || req.gameType !== NGT_PVP_RANK) {
      return { errorCode: req && req.valid ? ERRORS.INVALID_MATCH_TYPE : ERRORS.INVALID_REQUEST };
    }
    const deck = validatePlayerDeckForGameLoad(user, req, { deckType: NDT_PVP, requiredState: 0 });
    if (!deck.valid) return { errorCode: deck.errorCode };

    const ticket = { socket, user, req, deckIndex: deck.deckIndex, state: "waiting", match: null };
    tickets.set(socket, ticket);
    if (req.usingBot) {
      const match = createMatch(ticket, null, true);
      logger(`[pvp-match] bot match=${match.id} uid=${userUid(user)}`);
      return { errorCode: ERRORS.OK, ticket, match };
    }

    const peer = waiting.shift() || null;
    if (!peer) {
      waiting.push(ticket);
      logger(`[pvp-match] queued uid=${userUid(user)} deck=${req.selectDeckIndex}`);
      return { errorCode: ERRORS.OK, ticket, match: null };
    }
    const match = createMatch(peer, ticket, false);
    logger(`[pvp-match] paired match=${match.id} A=${userUid(peer.user)} B=${userUid(user)}`);
    return { errorCode: ERRORS.OK, ticket, peer, match };
  }

  function cancel(socket) {
    purgeDisconnected();
    const ticket = tickets.get(socket);
    if (!ticket || ticket.state !== "waiting" || ticket.match) return { errorCode: ERRORS.CANCEL_FAIL };
    removeWaiting(ticket);
    tickets.delete(socket);
    ticket.state = "cancelled";
    logger(`[pvp-match] cancelled uid=${userUid(ticket.user)}`);
    return { errorCode: ERRORS.OK, ticket };
  }

  function complete(match) {
    if (!match || !["matched", "active"].includes(match.state)) return false;
    match.state = "active";
    for (const member of match.members) {
      if (!member.ticket) continue;
      member.ticket.state = "complete";
      tickets.delete(member.socket);
    }
    return true;
  }

  function fail(match) {
    if (!match || match.state === "failed") return false;
    match.state = "failed";
    for (const member of match.members) {
      if (!member.ticket) continue;
      member.ticket.state = "failed";
      tickets.delete(member.socket);
    }
    return true;
  }

  function handleSocketClose(socket) {
    const ticket = tickets.get(socket);
    if (!ticket) return false;
    removeWaiting(ticket);
    tickets.delete(socket);
    ticket.state = "disconnected";
    return true;
  }

  function getMatch(socket) {
    return socket && socket.session && socket.session.standardPvpMatch || null;
  }

  function getMember(socket) {
    const match = getMatch(socket);
    return match && match.members.find((entry) => entry.socket === socket) || null;
  }

  function createMatch(first, second, bot) {
    const match = {
      id: nextMatchId++,
      code: `rank-${Date.now()}-${nextMatchId}`,
      standardPvp: true,
      bot: Boolean(bot),
      state: "matched",
      matchStarted: false,
      matchFinished: false,
      battleStarted: false,
      replay: null,
      gameDataPayload: null,
      members: [],
    };
    attach(first, match, 1);
    if (second) attach(second, match, 3);
    return match;
  }

  function attach(ticket, match, teamType) {
    removeWaiting(ticket);
    ticket.state = "matched";
    ticket.match = match;
    match.members.push({
      socket: ticket.socket,
      user: ticket.user,
      ticket,
      teamType,
      observer: false,
      loaded: false,
      playerState: 2,
    });
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

  return { request, cancel, complete, fail, handleSocketClose, getMatch, getMember, waiting, tickets };
}

function createPvpMatchmakingHandlers() {
  return [
    {
      packetId: PACKETS.MATCH_REQ,
      name: "PVP_GAME_MATCH_REQ",
      handle(ctx, socket, packet) {
        const req = decodeMatchRequest(ctx, packet && packet.payload);
        const user = getSocketUser(ctx, socket);
        const result = ctx.pvpMatchmaking.request(socket, user, req);
        ctx.sendGameResponse(socket, packet, PACKETS.MATCH_ACK, writeSignedVarInt(result.errorCode), "pvp-match");
        if (result.errorCode === ERRORS.OK && result.match) ctx.startStandardPvpMatch(result.match);
        return true;
      },
    },
    {
      packetId: PACKETS.CANCEL_REQ,
      name: "PVP_GAME_MATCH_CANCEL_REQ",
      handle(ctx, socket, packet) {
        const valid = decodeEmptyRequest(ctx, packet && packet.payload);
        const result = valid ? ctx.pvpMatchmaking.cancel(socket) : { errorCode: ERRORS.INVALID_REQUEST };
        ctx.sendGameResponse(socket, packet, PACKETS.CANCEL_ACK, writeSignedVarInt(result.errorCode), "pvp-match-cancel");
        return true;
      },
    },
  ];
}

function decodeMatchRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const selectDeckIndex = readByte(payload, 0);
    const gameType = readByte(payload, selectDeckIndex.offset);
    if (gameType.offset >= payload.length || payload[gameType.offset] > 1) return invalidRequest();
    const usingBot = readBool(payload, gameType.offset);
    if (usingBot.offset !== payload.length) return invalidRequest();
    return {
      valid: true,
      selectDeckIndex: selectDeckIndex.value,
      gameType: gameType.value,
      usingBot: usingBot.value,
    };
  } catch (_) {
    return invalidRequest();
  }
}

function decodeEmptyRequest(ctx, encryptedPayload) {
  try { return decrypt(ctx, encryptedPayload).length === 0; }
  catch (_) { return false; }
}

function invalidRequest() {
  return { valid: false, selectDeckIndex: 0, gameType: 0, usingBot: false };
}

function decrypt(ctx, payload) {
  const value = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : payload;
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function hasActiveGame(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  return Boolean(replay && replay.dynamicGame && replay.dynamicBattleResultSent !== true);
}

function userUid(user) {
  return String(user && user.userUid || "0");
}

module.exports = {
  ERRORS,
  NDT_PVP,
  NGT_PVP_RANK,
  PACKETS,
  createPvpMatchmaker,
  createPvpMatchmakingHandlers,
  decodeEmptyRequest,
  decodeMatchRequest,
};
