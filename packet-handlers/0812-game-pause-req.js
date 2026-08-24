const { readByte } = require("../modules/packet-codec");

const GAME_PAUSE_ACK = 813;
const OK = 0;
const GAME_IS_PAUSE = 445;
const GAME_NOT_IN_PLAY = 20128;
const INVALID_REQUEST = 20191;

module.exports = {
  packetId: 812,
  name: "GAME_PAUSE_REQ",
  handle(ctx, socket, packet) {
    const replay = socket.session.gameReplay;
    const req = decodePauseRequest(ctx, packet);
    if (!req) {
      sendPauseAck(ctx, socket, packet, currentPause(replay), false, INVALID_REQUEST, "game-pause-invalid");
      return true;
    }
    if (ctx.isTutorialCapturedBootstrapActive(socket)) {
      if (ctx.peekCapturedTutorialPacketId(socket) === ctx.constants.HEART_BIT_ACK) {
        console.log("[official-missing] GAME_PAUSE_REQ arrived before tutorial heartbeat sync window; no response sent");
        return true;
      }
      if (!ctx.sendCapturedTutorialThroughPacketId(socket, ctx.constants.GAME_PAUSE_ACK, "tutorial-game-pause")) {
        console.log(
          `[official-missing] no sniffed tutorial GAME_PAUSE_ACK for pauseCount=${replay.pauseCount + 1} nextServerIndex=${
            replay.nextServerIndex
          }; no response sent`
        );
      }
      replay.pauseCount += 1;
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      if (!replay || !replay.dynamicGame) {
        sendPauseAck(ctx, socket, packet, req.isPause, req.isPauseEvent, GAME_NOT_IN_PLAY, "game-pause-not-in-play");
        return true;
      }
      if (req.isPause && isFinished(replay)) {
        sendPauseAck(ctx, socket, packet, req.isPause, req.isPauseEvent, GAME_IS_PAUSE, "game-pause-finished");
        return true;
      }
      if (!ctx.handleDynamicBattlePause(socket, req)) {
        sendPauseAck(ctx, socket, packet, req.isPause, req.isPauseEvent, GAME_NOT_IN_PLAY, "game-pause-host-unavailable");
      }
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;

    if (ctx.peekCapturedGamePacketId(socket) === ctx.constants.HEART_BIT_ACK) {
      console.log(
        "[official-missing] GAME_PAUSE_REQ arrived before captured heartbeat sync window; no response sent"
      );
      return true;
    }

    if (!ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_PAUSE_ACK, "game-pause")) {
      console.log(
        `[official-missing] no sniffed GAME_PAUSE_ACK for pauseCount=${replay.pauseCount + 1} nextServerIndex=${
          replay.nextServerIndex
        }; no response sent`
      );
    }

    replay.pauseCount += 1;
    return true;
  },
};

function decodePauseRequest(ctx, packet) {
  try {
    const payload = ctx.decryptCopy(packet.payload || Buffer.alloc(0));
    const pause = readByte(payload, 0);
    const pauseEvent = readByte(payload, pause.offset);
    if (pauseEvent.offset !== payload.length) return null;
    if ((pause.value !== 0 && pause.value !== 1) || (pauseEvent.value !== 0 && pauseEvent.value !== 1)) return null;
    return { isPause: pause.value === 1, isPauseEvent: pauseEvent.value === 1 };
  } catch (_) {
    return null;
  }
}

function sendPauseAck(ctx, socket, packet, isPause, isPauseEvent, errorCode, label) {
  ctx.sendGameResponse(
    socket,
    packet,
    GAME_PAUSE_ACK,
    ctx.buildGamePauseAckPayload(isPause, isPauseEvent, errorCode),
    label
  );
}

function currentPause(replay) {
  return Boolean(replay && replay.dynamicBattlePaused);
}

function isFinished(replay) {
  const state = Number(replay && replay.battleState && replay.battleState.gameState && replay.battleState.gameState.state);
  return Boolean(replay && replay.battleState && (replay.battleState.finished || replay.battleState.Finished)) || state === 4 || state === 5;
}
