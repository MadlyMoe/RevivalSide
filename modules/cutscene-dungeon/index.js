"use strict";

const { readSignedVarInt, writeSignedVarInt } = require("../packet-codec");

const PACKETS = Object.freeze({
  START_REQ: 1200,
  START_ACK: 1201,
  CLEAR_REQ: 1202,
  CLEAR_ACK: 1203,
});
const ERRORS = Object.freeze({ OK: 0, INVALID_DUNGEON_ID: 64, INVALID_REQUEST: 20191 });

function decodeCutsceneDungeonRequest(ctx, encryptedPayload) {
  if ((!ctx || typeof ctx.decryptCopy !== "function") && ctx && typeof ctx.readCutsceneDungeonReq === "function") {
    const legacy = ctx.readCutsceneDungeonReq(encryptedPayload);
    if (legacy && typeof legacy === "object") return legacy;
    return { valid: Number(legacy) > 0, dungeonId: Number(legacy) || 0 };
  }
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
    const dungeon = readSignedVarInt(payload, 0);
    return {
      valid: dungeon.offset === payload.length && writeSignedVarInt(dungeon.value).equals(payload),
      dungeonId: Number(dungeon.value),
    };
  } catch (_) {
    return { valid: false, dungeonId: 0 };
  }
}

module.exports = { PACKETS, ERRORS, decodeCutsceneDungeonRequest };
