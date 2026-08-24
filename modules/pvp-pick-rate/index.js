"use strict";

const { readSignedVarInt, writeObjectList, writeSignedVarInt } = require("../packet-codec");

const PACKETS = Object.freeze({ PVP_PICK_RATE_REQ: 2697, PVP_PICK_RATE_ACK: 2698 });
const GAME_TYPES = Object.freeze({ RANK: 6, LEAGUE: 19, UNLIMITED: 28 });
const ERROR_CODES = Object.freeze({ OK: 0, INVALID_GAME_TYPE: 20212 });
const SUPPORTED_GAME_TYPES = new Set(Object.values(GAME_TYPES));

function createPvpPickRateHandlers() {
  return [{
    packetId: PACKETS.PVP_PICK_RATE_REQ,
    name: "PVP_PICK_RATE_REQ",
    handle(ctx, socket, packet) {
      const request = decodePvpPickRateRequest(ctx, packet && packet.payload);
      const errorCode = request.valid && SUPPORTED_GAME_TYPES.has(request.gameType)
        ? ERROR_CODES.OK
        : ERROR_CODES.INVALID_GAME_TYPE;
      const payload = buildPvpPickRateAckPayload({ errorCode, gameType: request.gameType, pickRates: [] });
      if (ctx && typeof ctx.sendGameResponse === "function") {
        ctx.sendGameResponse(socket, packet, PACKETS.PVP_PICK_RATE_ACK, payload, "pvp-pick-rate");
      }
      console.log(`[pvp-pick-rate] ACK gameType=${request.gameType} records=0 error=${errorCode}`);
      return true;
    },
  }];
}

function decodePvpPickRateRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.alloc(0);
    const gameType = readSignedVarInt(payload, 0);
    return { valid: gameType.offset === payload.length, gameType: gameType.value };
  } catch (_) {
    return { valid: false, gameType: 0 };
  }
}

function buildPvpPickRateAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeSignedVarInt(Number(result.gameType) || 0),
    writeObjectList(Array.isArray(result.pickRates) ? result.pickRates : []),
  ]);
}

module.exports = {
  PACKETS,
  GAME_TYPES,
  ERROR_CODES,
  buildPvpPickRateAckPayload,
  createPvpPickRateHandlers,
  decodePvpPickRateRequest,
};
