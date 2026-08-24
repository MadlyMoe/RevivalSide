const {
  readSignedVarInt,
  readSignedVarLong,
  toBigInt,
  writeBool,
  writeByte,
  writeFloatLE,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { ERR, ensureCommunityUser } = require("../modules/community");
const { getEmoticonTemplet } = require("../modules/game-data");

const OK = 0;
const NO_GAME_STATE = 78;

module.exports = [
  handler(814, "GAME_CHECK_DIE_UNIT_REQ", (ctx, socket, packet) => {
    if (!emptyRequest(ctx, packet) || !ctx.handleDynamicBattleCheckDie(socket)) {
      ack(ctx, socket, packet, ctx.constants.GAME_CHECK_DIE_UNIT_ACK, NO_GAME_STATE, "game-check-die");
    }
  }),
  handler(835, "GAME_EMOTICON_REQ", (ctx, socket, packet) => {
    const emoticonId = readSingleInt(ctx, packet);
    const user = socket.session && socket.session.user;
    const community = user && ensureCommunityUser(user);
    let errorCode = OK;
    if (emoticonId == null || !getEmoticonTemplet(emoticonId)) errorCode = ERR.EMOTICON_ID;
    else if (!community.emoticons.collections.includes(emoticonId)) errorCode = ERR.EMOTICON_NOT_OWNED;
    ack(ctx, socket, packet, ctx.constants.GAME_EMOTICON_ACK, errorCode, "game-emoticon");
    if (errorCode) return;

    const payload = Buffer.concat([
      writeSignedVarLong(toBigInt(user.userUid)),
      writeSignedVarInt(emoticonId),
    ]);
    const room = ctx.privatePvp && ctx.privatePvp.getRoom(socket);
    if (room) ctx.privatePvp.broadcast(room, ctx, ctx.constants.GAME_EMOTICON_NOT, payload, "game-emoticon");
    else ctx.sendServerGamePacket(socket, ctx.constants.GAME_EMOTICON_NOT, payload, "game-emoticon");
  }),
  handler(838, "GAME_UNIT_RETREAT_REQ", (ctx, socket, packet) => {
    const unitUid = readSingleLong(ctx, packet);
    if (unitUid != null && ctx.handleDynamicBattleUnitRetreat(socket, { unitUID: unitUid.toString() })) return;
    const payload = Buffer.concat([writeSignedVarInt(NO_GAME_STATE), writeSignedVarLong(unitUid || 0n)]);
    ctx.sendGameResponse(socket, packet, ctx.constants.GAME_UNIT_RETREAT_ACK, payload, "game-unit-retreat");
  }),
  handler(842, "GAME_TACTICAL_COMMAND_REQ", (ctx, socket, packet) => {
    const tacticalCommandId = readSingleInt(ctx, packet);
    if (
      tacticalCommandId != null &&
      ctx.handleDynamicBattleTacticalCommand(socket, { TCID: tacticalCommandId })
    ) return;
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.GAME_TACTICAL_COMMAND_ACK,
      Buffer.concat([writeSignedVarInt(NO_GAME_STATE), emptyTacticalCommandData()]),
      "game-tactical-command"
    );
  }),
  handler(861, "GAME_RESTART_REQ", (ctx, socket, packet) => {
    const replay = socket.session && socket.session.gameReplay;
    if (
      !emptyRequest(ctx, packet) ||
      !replay ||
      !replay.dynamicGame ||
      [11, 20, 21, 22].includes(Number(replay.dynamicGame.gameType || 0)) ||
      ctx.privatePvp.getRoom(socket) ||
      (ctx.pvpMatchmaking && ctx.pvpMatchmaking.getMatch(socket))
    ) {
      ack(ctx, socket, packet, ctx.constants.GAME_RESTART_ACK, NO_GAME_STATE, "game-restart");
      return;
    }

    const battleState = replay.battleState || {};
    battleState.finished = true;
    battleState.win = false;
    battleState.Win = false;
    battleState.gameState = { ...(battleState.gameState || {}), state: 4, winTeam: 3 };
    const endPayload = ctx.buildDynamicGameEndNotPayload(replay, {
      battleState,
      giveup: true,
      restart: true,
      win: false,
      user: socket.session.user,
    });
    if (!endPayload) {
      ack(ctx, socket, packet, ctx.constants.GAME_RESTART_ACK, NO_GAME_STATE, "game-restart");
      return;
    }

    ack(ctx, socket, packet, ctx.constants.GAME_RESTART_ACK, OK, "game-restart");
    ctx.sendServerGamePacket(socket, ctx.constants.GAME_END_NOT, endPayload, "game-restart-end");
    replay.dynamicBattleResultSent = true;
    replay.pendingGameStartBootstrap = false;
    replay.pendingGameStartPackets = [];
    ctx.abandonDynamicBattle(socket, "game-restart");
  }),
  handler(882, "GAME_SURRENDER_REQ", (ctx, socket, packet) => {
    const room = ctx.privatePvp.getRoom(socket);
    const member = ctx.privatePvp.getMember(socket);
    if (!emptyRequest(ctx, packet) || !room || !member || !room.matchStarted) {
      ack(ctx, socket, packet, ctx.constants.GAME_SURRENDER_ACK, NO_GAME_STATE, "game-surrender");
      return;
    }

    ack(ctx, socket, packet, ctx.constants.GAME_SURRENDER_ACK, OK, "game-surrender");
    ctx.privatePvp.broadcast(
      room,
      ctx,
      ctx.constants.GAME_SURRENDER_NOT,
      Buffer.alloc(0),
      "game-surrender",
      { except: socket }
    );
    ctx.finishPrivatePvpGiveup(socket);
  }),
];

function handler(packetId, name, handleAction) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      handleAction(ctx, socket, packet);
      return true;
    },
  };
}

function ack(ctx, socket, packet, packetId, errorCode, label) {
  ctx.sendGameResponse(socket, packet, packetId, writeSignedVarInt(errorCode), label);
}

function emptyRequest(ctx, packet) {
  return ctx.decryptCopy(packet.payload || Buffer.alloc(0)).length === 0;
}

function readSingleInt(ctx, packet) {
  try {
    const payload = ctx.decryptCopy(packet.payload || Buffer.alloc(0));
    const value = readSignedVarInt(payload, 0);
    return value.offset === payload.length ? value.value : null;
  } catch (_) {
    return null;
  }
}

function readSingleLong(ctx, packet) {
  try {
    const payload = ctx.decryptCopy(packet.payload || Buffer.alloc(0));
    const value = readSignedVarLong(payload, 0);
    return value.offset === payload.length ? value.value : null;
  } catch (_) {
    return null;
  }
}

function emptyTacticalCommandData() {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeByte(1),
    writeFloatLE(0),
    writeByte(0),
    writeByte(0),
    writeFloatLE(0),
    writeBool(true),
    writeFloatLE(0),
  ]);
}
