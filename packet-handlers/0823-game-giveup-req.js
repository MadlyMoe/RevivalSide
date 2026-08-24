const { TUTORIAL_STAGE_CHAIN } = require("../stages/tutorialStage");

const OK = 0;
const NO_GAME_STATE = 78;

module.exports = {
  packetId: 823,
  name: "GAME_GIVEUP_REQ",
  handle(ctx, socket, packet) {
    if (!emptyRequest(ctx, packet)) return ack(ctx, socket, packet, NO_GAME_STATE);

    const room = ctx.privatePvp && ctx.privatePvp.getRoom(socket);
    if (room) {
      const member = ctx.privatePvp.getMember(socket);
      if (!room.matchStarted || !member || typeof ctx.finishPrivatePvpGiveup !== "function") {
        return ack(ctx, socket, packet, NO_GAME_STATE);
      }
      ack(ctx, socket, packet, OK);
      ctx.finishPrivatePvpGiveup(socket);
      return true;
    }

    const replay = socket.session && socket.session.gameReplay;
    if (!activeBattle(replay) || tutorialGiveupBlocked(socket.session && socket.session.user, replay.dynamicGame)) {
      return ack(ctx, socket, packet, NO_GAME_STATE);
    }
    const battleState = {
      ...(replay.battleState || {}),
      finished: true,
      win: false,
      Win: false,
      giveup: true,
      Giveup: true,
      gameState: { ...((replay.battleState && replay.battleState.gameState) || {}), state: 4, winTeam: 3 },
    };
    const endOptions = {
      battleState,
      giveup: true,
      win: false,
      user: socket.session && socket.session.user,
    };
    const standardPvp = ctx.pvpMatchmaking && ctx.pvpMatchmaking.getMatch(socket);
    const gameType = Number(replay.dynamicGame.gameType ?? replay.dynamicGame.GameType);
    const asyncPvp = [11, 20, 21, 22].includes(gameType);
    const payload = standardPvp && typeof ctx.buildStandardPvpGameEndNotPayloadForSocket === "function"
      ? ctx.buildStandardPvpGameEndNotPayloadForSocket(socket, replay, { ...endOptions, battleWinTeam: 3 })
      : asyncPvp && typeof ctx.buildAsyncPvpGameEndNotPayload === "function"
        ? ctx.buildAsyncPvpGameEndNotPayload(ctx, socket, replay, { ...endOptions, battleWinTeam: 3 })
        : ctx.buildDynamicGameEndNotPayload(replay, endOptions);
    if (!payload) return ack(ctx, socket, packet, NO_GAME_STATE);

    Object.assign(replay.battleState, battleState);
    ack(ctx, socket, packet, OK);
    if (typeof ctx.sendDynamicFinishStateSync === "function") {
      ctx.sendDynamicFinishStateSync(socket, battleState, "game-giveup-finish");
    }
    if (
      (gameType === 26 || asyncPvp) &&
      typeof ctx.sendManagedOrImmediatePacket === "function"
    ) {
      ctx.sendManagedOrImmediatePacket(socket, ctx.constants.GAME_END_NOT, payload, "game-giveup-end", endOptions);
    } else {
      ctx.sendServerGamePacket(socket, ctx.constants.GAME_END_NOT, payload, "game-giveup-end");
    }
    if (typeof ctx.maybeRecordDynamicBattleClear === "function") ctx.maybeRecordDynamicBattleClear(socket, battleState);
    if (standardPvp && typeof ctx.markStandardPvpMatchFinished === "function") ctx.markStandardPvpMatchFinished(socket);
    if (typeof ctx.sendRaidStateDataForSocket === "function") ctx.sendRaidStateDataForSocket(socket, "game-giveup-raid");
    replay.dynamicBattleResultSent = true;
    replay.pendingGameStartBootstrap = false;
    replay.pendingGameStartPackets = [];
    if (typeof ctx.abandonDynamicBattle === "function") ctx.abandonDynamicBattle(socket, "game-giveup");
    else if (typeof ctx.stopGameSyncTimers === "function") ctx.stopGameSyncTimers(socket);
    return true;
  },
};

function ack(ctx, socket, packet, errorCode) {
  ctx.sendGameResponse(
    socket,
    packet,
    ctx.constants.GAME_GIVEUP_ACK,
    ctx.writeSignedVarInt(errorCode),
    "game-giveup"
  );
  return true;
}

function emptyRequest(ctx, packet) {
  try {
    return ctx.decryptCopy(packet.payload || Buffer.alloc(0)).length === 0;
  } catch (_) {
    return false;
  }
}

function activeBattle(replay) {
  return Boolean(
    replay &&
    replay.dynamicGame &&
    replay.battleState &&
    replay.battleState.finished !== true &&
    replay.dynamicBattleResultSent !== true
  );
}

function tutorialGiveupBlocked(user, dynamicGame) {
  if (Number(dynamicGame && (dynamicGame.gameType ?? dynamicGame.GameType)) !== 7) return false;
  const dungeonId = Number(dynamicGame && (dynamicGame.dungeonID ?? dynamicGame.dungeonId)) || 0;
  if (!TUTORIAL_STAGE_CHAIN.some((stage) => Number(stage.dungeonID) === dungeonId)) return false;
  const phases = user && user.tutorial && user.tutorial.phases;
  return !(phases && phases[String(dungeonId)] && phases[String(dungeonId)].completed === true);
}
