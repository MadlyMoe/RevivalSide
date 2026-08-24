const { readSignedVarLong } = require("../modules/packet-codec");

const INVALID_REQUEST = 20191;
const NO_GAME_STATE = 78;

module.exports = {
  packetId: 816,
  name: "GAME_RESPAWN_REQ",
  handle(ctx, socket, packet) {
    const req = decodeRespawnRequest(ctx, packet);
    if (!req) {
      sendRespawnAck(ctx, socket, packet, { unitUID: "0", assistUnit: false }, INVALID_REQUEST, "game-respawn-invalid");
      return true;
    }
    const replay = socket.session.gameReplay;
    console.log(
      `[GAME_RESPAWN_REQ] unitUID=${req.unitUID} assist=${req.assistUnit ? 1 : 0} posX=${req.respawnPosX.toFixed(
        2
      )} gameTime=${req.gameTime.toFixed(2)}`
    );
    if (ctx.isTutorialCapturedBootstrapActive(socket)) {
      if (!ctx.sendCapturedTutorialThroughPacketId(socket, ctx.constants.GAME_RESPAWN_ACK, "tutorial-game-respawn")) {
        console.log(
          `[official-missing] no sniffed tutorial GAME_RESPAWN_ACK for nextServerIndex=${socket.session.gameReplay.nextServerIndex}; no response sent`
        );
        return true;
      }
      replay.lastRespawnReq = req;
      ctx.sendCapturedTutorialUntilBeforePacketIds(
        socket,
        [ctx.constants.HEART_BIT_ACK, ctx.constants.GAME_PAUSE_ACK, ctx.constants.GAME_RESPAWN_ACK],
        "tutorial-game-respawn-sync"
      );
      ctx.maybeTransitionTutorialReplayToDynamic(socket, "game-respawn");
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      if (!replay || !replay.dynamicGame || isFinished(replay)) {
        sendRespawnAck(ctx, socket, packet, req, NO_GAME_STATE, "game-respawn-no-game-state");
        return true;
      }
      if (!ctx.handleDynamicBattleRespawn(socket, req)) {
        sendRespawnAck(ctx, socket, packet, req, NO_GAME_STATE, "game-respawn-host-unavailable");
      }
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;
    if (!ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_RESPAWN_ACK, "game-respawn")) {
      console.log(
        `[official-missing] no sniffed GAME_RESPAWN_ACK for nextServerIndex=${socket.session.gameReplay.nextServerIndex}; no response sent`
      );
      return true;
    }
    replay.lastRespawnReq = req;
    ctx.sendCapturedGameUntilBeforePacketIds(
      socket,
      [ctx.constants.HEART_BIT_ACK, ctx.constants.GAME_PAUSE_ACK, ctx.constants.GAME_RESPAWN_ACK],
      "game-respawn-sync"
    );
    return true;
  },
};

function decodeRespawnRequest(ctx, packet) {
  try {
    const payload = ctx.decryptCopy(packet.payload || Buffer.alloc(0));
    const unitUID = readSignedVarLong(payload, 0);
    if (payload.length - unitUID.offset !== 9) return null;
    const assistUnitValue = payload.readUInt8(unitUID.offset);
    if (assistUnitValue !== 0 && assistUnitValue !== 1) return null;
    const respawnPosX = payload.readFloatLE(unitUID.offset + 1);
    const gameTime = payload.readFloatLE(unitUID.offset + 5);
    if (!Number.isFinite(respawnPosX) || !Number.isFinite(gameTime)) return null;
    return {
      unitUID: unitUID.value.toString(),
      assistUnit: assistUnitValue === 1,
      respawnPosX,
      gameTime,
    };
  } catch (_) {
    return null;
  }
}

function sendRespawnAck(ctx, socket, packet, req, errorCode, label) {
  ctx.sendGameResponse(
    socket,
    packet,
    ctx.constants.GAME_RESPAWN_ACK,
    ctx.buildGameRespawnAckPayload(req.unitUID, req.assistUnit, errorCode),
    label
  );
}

function isFinished(replay) {
  const state = Number(replay && replay.battleState && replay.battleState.gameState && replay.battleState.gameState.state);
  return Boolean(replay && replay.battleState && (replay.battleState.finished || replay.battleState.Finished)) || state === 4 || state === 5;
}
