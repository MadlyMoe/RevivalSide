"use strict";

const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getReceivedRewardIds, CONTENT: SCORE_REWARD_CONTENT } = require("../score-reward");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeIntList,
  writeNullObject,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");

const PACKETS = Object.freeze({
  MINI_GAME_LIST_NOT: 3072,
  MINI_GAME_INFO_REQ: 3073,
  MINI_GAME_INFO_ACK: 3074,
  MINI_GAME_RESULT_REQ: 3075,
  MINI_GAME_RESULT_ACK: 3076,
});

const MINI_GAME_TYPES = Object.freeze({ TEN: 10, SWORD_TRAINING: 20 });
const ERROR_CODES = Object.freeze({
  OK: 0,
  TEMPLET_IS_NULL: 27906,
  INVALID_SCORE: 27907,
  INVALID_GAME_INFO: 27908,
  NOT_PLAYING_HISTORY: 27909,
});

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const catalog = loadCatalog();

function createMiniGameHandlers() {
  return [
    {
      packetId: PACKETS.MINI_GAME_INFO_REQ,
      name: "MINI_GAME_INFO_REQ",
      handle(ctx, socket, packet) {
        const request = decodeMiniGameInfoRequest(ctx, packet && packet.payload);
        const result = getMiniGameInfo(socket, request);
        send(ctx, socket, packet, PACKETS.MINI_GAME_INFO_ACK, buildMiniGameInfoAckPayload(result), "mini-game-info");
        if (result.errorCode === ERROR_CODES.OK) {
          sendListNotification(ctx, socket, packet);
        }
        console.log(
          `[mini-game:MINI_GAME_INFO_REQ] ACK packetId=${PACKETS.MINI_GAME_INFO_ACK} type=${request.type} templetId=${request.templetId} error=${result.errorCode}`
        );
        return true;
      },
    },
    {
      packetId: PACKETS.MINI_GAME_RESULT_REQ,
      name: "MINI_GAME_RESULT_REQ",
      handle(ctx, socket, packet) {
        const request = decodeMiniGameResultRequest(ctx, packet && packet.payload);
        const result = applyMiniGameResult(socket, request);
        send(ctx, socket, packet, PACKETS.MINI_GAME_RESULT_ACK, buildMiniGameResultAckPayload(result), "mini-game-result");
        if (result.errorCode === ERROR_CODES.OK) commit(ctx);
        console.log(
          `[mini-game:MINI_GAME_RESULT_REQ] ACK packetId=${PACKETS.MINI_GAME_RESULT_ACK} templetId=${request.data ? request.data.templetId : 0} error=${result.errorCode}`
        );
        return true;
      },
    },
  ];
}

function decodeMiniGameInfoRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const type = readSignedVarInt(payload, 0);
    const templet = readSignedVarInt(payload, type.offset);
    return { valid: templet.offset === payload.length, type: type.value, templetId: templet.value };
  } catch (_) {
    return { valid: false, type: 0, templetId: 0 };
  }
}

function decodeMiniGameResultRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const present = readBool(payload, 0);
    if (!present.value) return { valid: present.offset === payload.length, data: null };
    const type = readSignedVarInt(payload, present.offset);
    const templet = readSignedVarInt(payload, type.offset);
    const score = readSignedVarLong(payload, templet.offset);
    const gameInfo = readStrictString(payload, score.offset);
    return {
      valid: gameInfo.offset === payload.length,
      data: { type: type.value, templetId: templet.value, score: score.value, gameInfo: gameInfo.value },
    };
  } catch (_) {
    return { valid: false, data: null };
  }
}

function getMiniGameInfo(socket, request = {}) {
  const templet = request.valid ? catalog.templetsById.get(positiveInt(request.templetId)) : null;
  if (!templet || request.type !== templet.type) return infoResult(ERROR_CODES.TEMPLET_IS_NULL);
  const user = socket && socket.session && socket.session.user;
  if (!user || typeof user !== "object") return infoResult(ERROR_CODES.NOT_PLAYING_HISTORY);

  const data = getMiniGameData(user, templet);
  socket.session.miniGamePlaying = { type: templet.type, templetId: templet.templetId };
  return infoResult(
    ERROR_CODES.OK,
    data,
    getReceivedRewardIds(user, SCORE_REWARD_CONTENT.MINI_GAME)
  );
}

function applyMiniGameResult(socket, request = {}) {
  if (!request.valid || !request.data || request.data.gameInfo == null) {
    return { errorCode: ERROR_CODES.INVALID_GAME_INFO, changed: false };
  }
  const templet = catalog.templetsById.get(positiveInt(request.data.templetId));
  if (!templet || request.data.type !== templet.type) {
    return { errorCode: ERROR_CODES.TEMPLET_IS_NULL, changed: false };
  }
  if (request.data.gameInfo.length >= 100) {
    return { errorCode: ERROR_CODES.INVALID_GAME_INFO, changed: false };
  }
  if (request.data.score <= 0n || request.data.score > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { errorCode: ERROR_CODES.INVALID_SCORE, changed: false };
  }

  const user = socket && socket.session && socket.session.user;
  const playing = socket && socket.session && socket.session.miniGamePlaying;
  if (!user || !playing || playing.type !== templet.type || playing.templetId !== templet.templetId) {
    return { errorCode: ERROR_CODES.NOT_PLAYING_HISTORY, changed: false };
  }

  const current = getMiniGameData(user, templet);
  if (BigInt(current.score) >= request.data.score) {
    return { errorCode: ERROR_CODES.INVALID_SCORE, changed: false };
  }

  const updated = {
    type: templet.type,
    templetId: templet.templetId,
    score: Number(request.data.score),
    gameInfo: request.data.gameInfo,
  };
  setMiniGameData(user, updated);
  return { errorCode: ERROR_CODES.OK, data: updated, changed: true };
}

function getMiniGameData(user, templetOrId) {
  const templet = typeof templetOrId === "object"
    ? templetOrId
    : catalog.templetsById.get(positiveInt(templetOrId));
  if (!templet) return null;
  for (const source of [user && user.miniGames, user && user.miniGameData, user && user.miniGameDatas]) {
    for (const entry of objectValues(source)) {
      const templetId = positiveInt(entry && (entry.templetId ?? entry.templetID ?? entry.id));
      if (templetId !== templet.templetId) continue;
      const score = safeScore(entry && (entry.score ?? entry.bestScore));
      return {
        type: templet.type,
        templetId: templet.templetId,
        score,
        gameInfo: typeof entry.gameInfo === "string" ? entry.gameInfo.slice(0, 99) : "",
      };
    }
  }
  return { type: templet.type, templetId: templet.templetId, score: 0, gameInfo: "" };
}

function setMiniGameData(user, data) {
  user.miniGames = user.miniGames && typeof user.miniGames === "object" && !Array.isArray(user.miniGames)
    ? user.miniGames
    : {};
  user.miniGames[String(data.templetId)] = { ...data };
}

function buildMiniGameListPayload() {
  return writeIntList(catalog.activeTempletIds);
}

function buildMiniGameData(data = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(data.type) || 0),
    writeSignedVarInt(Number(data.templetId) || 0),
    writeSignedVarLong(BigInt(data.score || 0)),
    writeString(typeof data.gameInfo === "string" ? data.gameInfo : ""),
  ]);
}

function buildMiniGameInfoAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(nonNegativeInt(result.errorCode)),
    result.data ? writeNullableObject(buildMiniGameData(result.data)) : writeNullObject(),
    writeIntList(Array.isArray(result.rewardIds) ? result.rewardIds : []),
  ]);
}

function buildMiniGameResultAckPayload(result = {}) {
  return writeSignedVarInt(nonNegativeInt(result.errorCode));
}

function loadCatalog() {
  const templetsById = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_MINIGAME_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "mini-game",
  })) {
    const templetId = positiveInt(raw && raw.m_Id);
    const type = miniGameTypeValue(raw && raw.m_GameType);
    const rewardGroupId = positiveInt(raw && raw.m_ScoreRewardGroupID);
    if (templetId && type) templetsById.set(templetId, { templetId, type, rewardGroupId });
  }
  return { templetsById, activeTempletIds: [...templetsById.keys()].sort((left, right) => left - right) };
}

function readStrictString(buffer, offset) {
  const length = readSignedVarInt(buffer, offset);
  if (length.value < 0) return { value: null, offset: length.offset };
  const end = length.offset + length.value;
  if (end > buffer.length) throw new Error("truncated string");
  return { value: buffer.subarray(length.offset, end).toString("utf8"), offset: end };
}

function infoResult(errorCode, data = null, rewardIds = []) {
  return { errorCode, data, rewardIds };
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function sendListNotification(ctx, socket, packet) {
  const payload = buildMiniGameListPayload();
  if (ctx && typeof ctx.sendServerGamePacket === "function") {
    ctx.sendServerGamePacket(socket, PACKETS.MINI_GAME_LIST_NOT, payload, "mini-game-list");
    return;
  }
  send(ctx, socket, packet, PACKETS.MINI_GAME_LIST_NOT, payload, "mini-game-list");
}

function commit(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function decrypt(ctx, payload) {
  return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload || Buffer.alloc(0)) : Buffer.alloc(0);
}

function miniGameTypeValue(value) {
  if (typeof value === "number") return Number(value);
  return MINI_GAME_TYPES[String(value || "").trim()] || 0;
}

function objectValues(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if ("score" in value || "templetId" in value || "templetID" in value) return [value];
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
  return Number.isFinite(number) && number > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number)) : 0;
}

module.exports = {
  PACKETS,
  MINI_GAME_TYPES,
  ERROR_CODES,
  applyMiniGameResult,
  buildMiniGameData,
  buildMiniGameInfoAckPayload,
  buildMiniGameListPayload,
  buildMiniGameResultAckPayload,
  createMiniGameHandlers,
  decodeMiniGameInfoRequest,
  decodeMiniGameResultRequest,
  getMiniGameData,
  getMiniGameInfo,
  loadCatalog,
};
