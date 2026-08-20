module.exports = {
  packetId: 807,
  name: "GAME_LOAD_COMPLETE_REQ",
  handle(ctx, socket) {
    socket.session.gameReplay.loadCompleteReceived = true;
    const privatePvpRoom = ctx.privatePvp && ctx.privatePvp.getRoom(socket);
    const privatePvpMember = ctx.privatePvp && ctx.privatePvp.getMember(socket);
    if (privatePvpRoom && privatePvpRoom.matchStarted && privatePvpMember) {
      privatePvpMember.loaded = true;
      const players = privatePvpRoom.members.filter((entry) => !entry.observer);
      if (!privatePvpRoom.battleStarted && players.length === 2 && players.every((entry) => entry.loaded)) {
        privatePvpRoom.battleStarted = true;
        const replay = socket.session.gameReplay;
        const packets = ctx.ensureGameStartPackets(ctx.buildInitialBattlePackets(replay), replay, socket);
        replay.pendingGameStartPackets = packets.filter(Boolean);
        replay.pendingGameStartBootstrap = true;
        ctx.sendPendingGameStartSync(socket, "private-pvp-load-complete");
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
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && socket.session.gameReplay.dynamicGame) {
      const replay = socket.session.gameReplay;
      const packets = ctx.ensureGameStartPackets(ctx.buildInitialBattlePackets(replay), replay, socket);
      replay.pendingGameStartPackets = packets.filter(Boolean);
      socket.session.gameReplay.pendingGameStartBootstrap = true;
      ctx.sendPendingGameStartSync(socket, "load-complete");
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      console.log("[combat-host] GAME_LOAD_COMPLETE_REQ has no dynamic battle state; captured battle bootstrap replay disabled");
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;
    ctx.sendCapturedGameUntilBeforePacketIds(socket, [ctx.constants.HEART_BIT_ACK], "game-load-complete");
    return true;
  },
};
