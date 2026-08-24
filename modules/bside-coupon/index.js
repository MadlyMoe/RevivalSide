"use strict";

const { readSignedVarInt, writeSignedVarInt } = require("../packet-codec");

const PACKETS = Object.freeze({
  USE_REQ: 3051,
  USE_ACK: 3052,
});

const ERRORS = Object.freeze({
  INVALID_CODE: 22001,
});

function createBsideCouponHandlers() {
  return [{
    packetId: PACKETS.USE_REQ,
    name: "BSIDE_COUPON_USE_REQ",
    handle(ctx, socket, packet) {
      const request = decodeCouponRequest(ctx, packet && packet.payload);
      const payload = buildCouponAck(ERRORS.INVALID_CODE);
      if (ctx && typeof ctx.sendGameResponse === "function") {
        ctx.sendGameResponse(socket, packet, PACKETS.USE_ACK, payload, "bside-coupon");
      }
      console.log(`[bside-coupon] ACK valid=${request.valid} error=${ERRORS.INVALID_CODE}`);
      return true;
    },
  }];
}

function decodeCouponRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.alloc(0);
    const length = readSignedVarInt(payload, 0);
    if (length.value < 0 || !writeSignedVarInt(length.value).equals(payload.subarray(0, length.offset))) {
      return { valid: false, couponCode: "" };
    }
    const end = length.offset + length.value;
    if (end !== payload.length) return { valid: false, couponCode: "" };
    return { valid: true, couponCode: payload.subarray(length.offset, end).toString("utf8") };
  } catch (_) {
    return { valid: false, couponCode: "" };
  }
}

function buildCouponAck(errorCode = ERRORS.INVALID_CODE) {
  return writeSignedVarInt(Number(errorCode));
}

module.exports = {
  PACKETS,
  ERRORS,
  buildCouponAck,
  createBsideCouponHandlers,
  decodeCouponRequest,
};
