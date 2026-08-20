module.exports = {
  packetId: 823,
  name: "GAME_GIVEUP_REQ",
  handle(ctx, socket, packet) {
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.GAME_GIVEUP_ACK,
      ctx.writeSignedVarInt(0),
      "game-giveup"
    );

    if (ctx.privatePvp && ctx.privatePvp.getRoom(socket) && typeof ctx.finishPrivatePvpGiveup === "function") {
      ctx.finishPrivatePvpGiveup(socket);
      return true;
    }

    const replay = socket.session && socket.session.gameReplay;
    if (!replay || !replay.dynamicGame) return true;
    const battleState = replay.battleState || {};
    battleState.finished = true;
    battleState.win = false;
    battleState.Win = false;
    battleState.gameState = { ...(battleState.gameState || {}), state: 4, winTeam: 3 };
    const payload = ctx.buildDynamicGameEndNotPayload(replay, {
      battleState,
      giveup: true,
      win: false,
      user: socket.session && socket.session.user,
    });
    if (payload) {
      ctx.sendServerGamePacket(socket, ctx.constants.GAME_END_NOT, payload, "game-giveup-end");
    }
    if (typeof ctx.sendRaidStateDataForSocket === "function") ctx.sendRaidStateDataForSocket(socket, "game-giveup-raid");
    replay.dynamicBattleResultSent = true;
    replay.pendingGameStartBootstrap = false;
    replay.pendingGameStartPackets = [];
    if (typeof ctx.abandonDynamicBattle === "function") ctx.abandonDynamicBattle(socket, "game-giveup");
    else if (typeof ctx.stopGameSyncTimers === "function") ctx.stopGameSyncTimers(socket);
    return true;
  },
};
