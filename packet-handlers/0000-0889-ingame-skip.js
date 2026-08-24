const { writeSignedVarInt } = require("../modules/packet-codec");

const INGAME_SKIP_REQ = 889;
const INGAME_SKIP_ACK = 890;
const OK = 0;
const INVALID_GAME_TYPE = 28400;
const NGST_80 = 5;
const SKIPPABLE_GAME_TYPES = new Set([11, 20, 21, 22]);

module.exports = {
  packetId: INGAME_SKIP_REQ,
  name: "INGAME_SKIP_REQ",
  handle(ctx, socket, packet) {
    const replay = socket && socket.session && socket.session.gameReplay;
    const dynamicGame = replay && replay.dynamicGame;
    const gameType = Number(dynamicGame && (dynamicGame.gameType ?? dynamicGame.GameType));
    const valid = emptyRequest(ctx, packet) && dynamicGame && SKIPPABLE_GAME_TYPES.has(gameType);

    if (valid) {
      if (typeof ctx.applyCombatControls === "function") {
        ctx.applyCombatControls(socket, { gameSpeedType: NGST_80 }, { persist: false });
      } else {
        replay.gameSpeedType = NGST_80;
        dynamicGame.gameSpeedType = NGST_80;
        if (replay.battleState) replay.battleState.gameSpeedType = NGST_80;
      }
    }

    ctx.sendGameResponse(
      socket,
      packet,
      INGAME_SKIP_ACK,
      writeSignedVarInt(valid ? OK : INVALID_GAME_TYPE),
      "ingame-skip"
    );
    return true;
  },
};

function emptyRequest(ctx, packet) {
  try {
    return ctx.decryptCopy(packet.payload || Buffer.alloc(0)).length === 0;
  } catch (_) {
    return false;
  }
}
