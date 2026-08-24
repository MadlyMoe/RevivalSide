const { writeNullObject, writeSignedVarInt } = require("../modules/packet-codec");
const { decodeCutsceneDungeonRequest } = require("../modules/cutscene-dungeon");

module.exports = {
  packetId: 1202,
  name: "CUTSCENE_DUNGEON_CLEAR_REQ",
  handle(ctx, socket, packet) {
    const request = decodeCutsceneDungeonRequest(ctx, packet.payload);
    const valid = request.valid === true;
    const dungeonId = Number(request.dungeonId) || 0;
    const known = typeof ctx.isValidCutsceneDungeonId === "function" ? ctx.isValidCutsceneDungeonId(dungeonId) : valid;
    if (!valid || !known) {
      ctx.sendGameResponse(
        socket,
        packet,
        ctx.constants.CUTSCENE_DUNGEON_CLEAR_ACK,
        Buffer.concat([writeSignedVarInt(valid ? 64 : 20191), writeNullObject(), writeNullObject()]),
        `cutscene-clear-rejected dungeonID=${dungeonId}`
      );
      return true;
    }
    const user = socket && socket.session && socket.session.user;
    const alreadyCleared = Boolean(
      user && (user.dungeonClear && user.dungeonClear[String(dungeonId)] || user.clearConditions && user.clearConditions.dungeons && user.clearConditions.dungeons[String(dungeonId)] && user.clearConditions.dungeons[String(dungeonId)].cleared)
    );
    if (typeof ctx.commitCutsceneDungeonClear === "function") ctx.commitCutsceneDungeonClear(socket, dungeonId);
    else {
      ctx.recordPersistentCutsceneView(socket, dungeonId);
      if (!alreadyCleared) {
        ctx.recordGameplayUnlockClear(socket, dungeonId);
        ctx.recordTutorialCutsceneClear(socket, dungeonId);
        ctx.recordMainStoryDungeonClear(socket, dungeonId);
      }
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendServerGamePacket(
        socket,
        ctx.constants.CUTSCENE_DUNGEON_CLEAR_ACK,
        ctx.buildCutsceneDungeonClearAckPayload(dungeonId, alreadyCleared ? null : user),
        `cutscene-clear dungeonID=${dungeonId}`
      );
      return true;
    }
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.CUTSCENE_DUNGEON_CLEAR_ACK,
      ctx.buildCutsceneDungeonClearAckPayload(dungeonId, alreadyCleared ? null : user),
      `cutscene-clear dungeonID=${dungeonId}`
    );
    return true;
  },
};
