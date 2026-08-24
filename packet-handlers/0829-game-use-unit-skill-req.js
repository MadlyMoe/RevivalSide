const INVALID_REQUEST = 20191;
const CANT_FIND_UNIT = 20134;

module.exports = {
  packetId: 829,
  name: "GAME_USE_UNIT_SKILL_REQ",
  handle(ctx, socket, packet) {
    const req = ctx.decodeGameUnitSkillReq(packet.payload);
    if (!req) {
      sendAck(ctx, socket, packet, 0, INVALID_REQUEST, "game-unit-skill-invalid");
      return true;
    }
    console.log(`[GAME_USE_UNIT_SKILL_REQ] gameUnitUID=${req.gameUnitUID}`);
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      const replay = socket.session && socket.session.gameReplay;
      if (!replay || !replay.dynamicGame || isFinished(replay)) {
        sendAck(ctx, socket, packet, req.gameUnitUID, CANT_FIND_UNIT, "game-unit-skill-no-game");
        return true;
      }
      if (!ctx.handleDynamicBattleUnitSkill(socket, req)) {
        sendAck(ctx, socket, packet, req.gameUnitUID, CANT_FIND_UNIT, "game-unit-skill-host-unavailable");
      }
      return true;
    }
    return false;
  },
};

function sendAck(ctx, socket, packet, gameUnitUID, errorCode, label) {
  ctx.sendGameResponse(
    socket,
    packet,
    ctx.constants.GAME_USE_UNIT_SKILL_ACK,
    ctx.buildGameUnitSkillAckPayload(gameUnitUID, 0, errorCode),
    label
  );
}

function isFinished(replay) {
  const state = Number(replay && replay.battleState && replay.battleState.gameState && replay.battleState.gameState.state);
  return Boolean(replay && replay.battleState && (replay.battleState.finished || replay.battleState.Finished)) || state === 4 || state === 5;
}
