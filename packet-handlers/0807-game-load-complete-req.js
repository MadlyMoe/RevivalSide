const { readByte } = require("../modules/packet-codec");

const GAME_LOAD_COMPLETE_ACK = 808;
const GAME_LOAD_FAILED = 95;
const GAME_LOAD_INVALID_STATE = 20118;
const INVALID_REQUEST = 20191;

module.exports = {
  packetId: 807,
  name: "GAME_LOAD_COMPLETE_REQ",
  handle(ctx, socket, packet) {
    const req = decodeRequest(ctx, packet);
    const replay = socket.session && socket.session.gameReplay;
    if (!req) return sendFailure(ctx, socket, packet, replay, INVALID_REQUEST, false, "game-load-complete-invalid");
    if (req.isIntrude) {
      if (!replay || isFinished(replay) || !replay.dynamicGame || !replay.dynamicGame.managedCombat) {
        return sendFailure(ctx, socket, packet, replay, GAME_LOAD_INVALID_STATE, true, "game-load-complete-intrude-invalid-state");
      }
      const packets = ctx.buildIntrudeStartPackets(replay).filter(Boolean);
      if (!packets.some((entry) => entry.packetId === GAME_LOAD_COMPLETE_ACK) || !packets.some((entry) => entry.packetId === 810)) {
        return sendFailure(ctx, socket, packet, replay, GAME_LOAD_FAILED, true, "game-load-complete-intrude-host-failure");
      }
      replay.loadCompleteReceived = true;
      for (const entry of packets) {
        ctx.sendServerGamePacket(socket, entry.packetId, entry.payload, entry.label || "managed-intrude-start");
      }
      if (!replay.dynamicBattleResultSent && !replay.dynamicBattleTimer) {
        ctx.startDynamicBattleManager(socket, "managed-intrude-start");
      }
      return true;
    }
    if (!replay || isFinished(replay) || (ctx.config.DYNAMIC_BATTLE_MANAGER && !replay.dynamicGame)) {
      return sendFailure(ctx, socket, packet, replay, GAME_LOAD_INVALID_STATE, false, "game-load-complete-invalid-state");
    }
    const privatePvpRoom = ctx.privatePvp && ctx.privatePvp.getRoom(socket);
    const privatePvpMember = ctx.privatePvp && ctx.privatePvp.getMember(socket);
    if (privatePvpRoom && privatePvpRoom.matchStarted && privatePvpMember) {
      privatePvpMember.loaded = true;
      const players = privatePvpRoom.members.filter((entry) => !entry.observer);
      if (!privatePvpRoom.battleStarted && players.length === 2 && players.every((entry) => entry.loaded)) {
        const packets = ctx.ensureGameStartPackets(ctx.buildInitialBattlePackets(replay), replay, socket);
        if (!packets.length) {
          for (const player of players) {
            player.loaded = false;
            if (player.socket && !player.socket.destroyed) {
              ctx.sendServerGamePacket(
                player.socket,
                GAME_LOAD_COMPLETE_ACK,
                ctx.buildGameLoadCompleteAckPayload(replay, player.user, {
                  errorCode: GAME_LOAD_FAILED,
                  isIntrude: false,
                }),
                "private-pvp-load-complete-host-failure"
              );
            }
          }
          return true;
        }
        privatePvpRoom.battleStarted = true;
        replay.loadCompleteReceived = true;
        replay.pendingGameStartPackets = packets.filter(Boolean);
        replay.pendingGameStartBootstrap = true;
        if (!ctx.sendPendingGameStartSync(socket, "private-pvp-load-complete")) {
          privatePvpRoom.battleStarted = false;
          replay.loadCompleteReceived = false;
        }
      } else {
        console.log(`[private-pvp] room=${privatePvpRoom.code} loaded=${players.filter((entry) => entry.loaded).length}/${players.length}`);
      }
      return true;
    }
    if (ctx.isTutorialCapturedBootstrapActive(socket)) {
      if (ctx.sendCapturedTutorialLoadCompleteBootstrap(socket, "tutorial-load-complete")) return true;
      console.log("[capture-game] tutorial captured bootstrap missing load-complete window; no dynamic fallback sent");
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      const packets = ctx.ensureGameStartPackets(ctx.buildInitialBattlePackets(replay), replay, socket);
      if (!packets.length) {
        return sendFailure(ctx, socket, packet, replay, GAME_LOAD_FAILED, false, "game-load-complete-host-failure");
      }
      replay.loadCompleteReceived = true;
      replay.pendingGameStartPackets = packets.filter(Boolean);
      replay.pendingGameStartBootstrap = true;
      if (!ctx.sendPendingGameStartSync(socket, "load-complete")) {
        replay.loadCompleteReceived = false;
        return sendFailure(ctx, socket, packet, replay, GAME_LOAD_FAILED, false, "game-load-complete-send-failure");
      }
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;
    replay.loadCompleteReceived = true;
    ctx.sendCapturedGameUntilBeforePacketIds(socket, [ctx.constants.HEART_BIT_ACK], "game-load-complete");
    return true;
  },
};

function decodeRequest(ctx, packet) {
  try {
    const payload = ctx.decryptCopy(packet && packet.payload ? packet.payload : Buffer.alloc(0));
    const value = readByte(payload, 0);
    if (value.offset !== payload.length || (value.value !== 0 && value.value !== 1)) return null;
    return { isIntrude: value.value === 1 };
  } catch (_) {
    return null;
  }
}

function sendFailure(ctx, socket, packet, replay, errorCode, isIntrude, label) {
  ctx.sendGameResponse(
    socket,
    packet,
    GAME_LOAD_COMPLETE_ACK,
    ctx.buildGameLoadCompleteAckPayload(replay, socket.session && socket.session.user, { errorCode, isIntrude }),
    label
  );
  return true;
}

function isFinished(replay) {
  const state = Number(replay && replay.battleState && replay.battleState.gameState && replay.battleState.gameState.state);
  return Boolean(replay && replay.battleState && (replay.battleState.finished || replay.battleState.Finished)) || state === 4 || state === 5;
}
