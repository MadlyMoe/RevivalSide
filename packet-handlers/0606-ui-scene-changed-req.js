const { readSignedVarInt } = require("../modules/packet-codec");

const NSI_GAME = 3;
const NSI_OPERATION = 9;
const MAX_SCENE_ID = 45;

module.exports = {
  packetId: 606,
  name: "UI_SCEN_CHANGED_REQ",
  handle(ctx, socket, packet) {
    const sceneId = readSceneId(ctx, packet);
    if (sceneId == null) {
      if (ctx.config.VERBOSE_CAPTURE_LOGS) console.log("[capture-game] malformed UI_SCEN_CHANGED_REQ ignored");
      return true;
    }
    if (ctx.config.VERBOSE_CAPTURE_LOGS) {
      console.log(`[capture-game] UI_SCEN_CHANGED_REQ observed scene=${sceneId}; official flow sends no direct ACK`);
    }
    const replay = socket.session && socket.session.gameReplay;
    const previousSceneId = replay ? Number(replay.lastSceneId || 0) : 0;
    if (replay) replay.lastSceneId = sceneId;
    if (
      ctx.config.DYNAMIC_BATTLE_MANAGER &&
      replay &&
      replay.dynamicGame &&
      sceneId !== NSI_GAME &&
      !replay.dynamicBattleResultSent &&
      (previousSceneId === NSI_GAME ||
        replay.dynamicBattleTimer ||
        (replay.loadCompleteReceived && replay.dynamicGame.initialUnitsSent))
    ) {
      if (typeof ctx.abandonDynamicBattle === "function") {
        ctx.abandonDynamicBattle(socket, `scene-${previousSceneId}-to-${sceneId}`);
      } else if (typeof ctx.stopGameSyncTimers === "function") {
        ctx.stopGameSyncTimers(socket);
        replay.dynamicBattleResultSent = true;
      }
    }
    if (sceneId === NSI_OPERATION && typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
      ctx.repairPostTutorialGuideMissionsForSocket(socket, {
        label: "operation-post-tutorial-guide-mission-complete",
        notify: true,
      });
    }
    if (
      ctx.config.DYNAMIC_BATTLE_MANAGER &&
      replay &&
      replay.pendingGameStartBootstrap &&
      replay.loadCompleteReceived &&
      replay.dynamicGame
    ) {
      if (sceneId !== NSI_GAME) {
        console.log(`[battle-manager:scene-ready] pending bootstrap; scene=${sceneId} not NSI_GAME`);
        return true;
      }
      ctx.sendPendingGameStartSync(socket, "scene-ready");
    }
    return true;
  },
};

function readSceneId(ctx, packet) {
  try {
    const payload = packet && packet.payload ? ctx.decryptCopy(packet.payload) : Buffer.alloc(0);
    const read = readSignedVarInt(payload, 0);
    const sceneId = Number(read.value);
    return read.offset === payload.length && Number.isInteger(sceneId) && sceneId >= 0 && sceneId <= MAX_SCENE_ID
      ? sceneId
      : null;
  } catch (_) {
    return null;
  }
}
