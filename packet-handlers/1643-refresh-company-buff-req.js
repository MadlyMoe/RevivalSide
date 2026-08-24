const REFRESH_COMPANY_BUFF_ACK = 1644;
const {
  ERRORS,
  buildRefreshCompanyBuffAckPayload,
  isStrictEmptyRequest,
  pruneExpiredCompanyBuffs,
} = require("../modules/company-buff");

module.exports = {
  packetId: 1643,
  name: "REFRESH_COMPANY_BUFF_REQ",
  handle(ctx, socket, packet) {
    const user = socket && socket.session && socket.session.user;
    const valid = isStrictEmptyRequest(ctx, packet && packet.payload);
    const nowTicks = ctx && typeof ctx.dateTimeTicksNow === "function" ? ctx.dateTimeTicksNow() : undefined;
    const changed = valid && pruneExpiredCompanyBuffs(user, { nowTicks });
    const payload = buildRefreshCompanyBuffAckPayload(user, valid ? ERRORS.OK : ERRORS.INVALID_REQUEST, { nowTicks });
    if (socket.session && socket.session.gameReplay) {
      ctx.sendServerGamePacket(socket, REFRESH_COMPANY_BUFF_ACK, payload, "refresh-company-buff");
    } else {
      ctx.sendGameResponse(socket, packet, REFRESH_COMPANY_BUFF_ACK, payload, "refresh-company-buff");
    }
    if (changed && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") {
      ctx.saveUserDb();
      if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
        ctx.invalidateJoinLobbyAckPayloadCache("company-buff-expiry");
      }
    }
    return true;
  },
};
