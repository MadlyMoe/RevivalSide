const INVALID_REQUEST = 20191;
const NO_GAME = 90;

module.exports = {
  packetId: 818,
  name: "GAME_SHIP_SKILL_REQ",
  handle(ctx, socket, packet) {
    const req = ctx.decodeGameShipSkillReq(packet.payload);
    if (!req) {
      sendAck(ctx, socket, packet, { gameUnitUID: 0, shipSkillID: 0, skillPosX: 0 }, INVALID_REQUEST, "game-ship-skill-invalid");
      return true;
    }
    console.log(
      `[GAME_SHIP_SKILL_REQ] gameUnitUID=${req.gameUnitUID} shipSkillID=${req.shipSkillID} posX=${req.skillPosX.toFixed(2)}`
    );
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      const replay = socket.session && socket.session.gameReplay;
      if (!replay || !replay.dynamicGame || isFinished(replay)) {
        sendAck(ctx, socket, packet, req, NO_GAME, "game-ship-skill-no-game");
        return true;
      }
      if (!ctx.handleDynamicBattleShipSkill(socket, req)) {
        sendAck(ctx, socket, packet, req, NO_GAME, "game-ship-skill-host-unavailable");
      }
      return true;
    }
    return false;
  },
};

function sendAck(ctx, socket, packet, req, errorCode, label) {
  ctx.sendGameResponse(
    socket,
    packet,
    ctx.constants.GAME_SHIP_SKILL_ACK,
    ctx.buildGameShipSkillAckPayload(req.gameUnitUID, req.shipSkillID, req.skillPosX, errorCode),
    label
  );
}

function isFinished(replay) {
  const state = Number(replay && replay.battleState && replay.battleState.gameState && replay.battleState.gameState.state);
  return Boolean(replay && replay.battleState && (replay.battleState.finished || replay.battleState.Finished)) || state === 4 || state === 5;
}
