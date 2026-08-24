const { writeNullObject, writeSignedVarInt } = require("../modules/packet-codec");
const { decodeCutsceneDungeonRequest } = require("../modules/cutscene-dungeon");

module.exports = {
  packetId: 1200,
  name: "CUTSCENE_DUNGEON_START_REQ",
  handle(ctx, socket, packet) {
    const request = decodeCutsceneDungeonRequest(ctx, packet.payload);
    const valid = request.valid === true;
    const dungeonId = Number(request.dungeonId) || 0;
    const known = typeof ctx.isValidCutsceneDungeonId === "function" ? ctx.isValidCutsceneDungeonId(dungeonId) : valid;
    if (!valid || !known) {
      ctx.sendGameResponse(
        socket,
        packet,
        ctx.constants.CUTSCENE_DUNGEON_START_ACK,
        Buffer.concat([writeSignedVarInt(valid ? 64 : 20191), writeNullObject()]),
        `cutscene-start-rejected dungeonID=${dungeonId}`
      );
      return true;
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendServerGamePacket(
        socket,
        ctx.constants.CUTSCENE_DUNGEON_START_ACK,
        ctx.buildCutsceneDungeonStartAckPayload(dungeonId),
        `cutscene-start dungeonID=${dungeonId}`
      );
      return true;
    }
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.CUTSCENE_DUNGEON_START_ACK,
      ctx.buildCutsceneDungeonStartAckPayload(dungeonId),
      `cutscene-start dungeonID=${dungeonId}`
    );
    return true;
  },
};
