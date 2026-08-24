const { readByte, readSignedVarInt, writeBool, writeSignedVarInt } = require("../modules/packet-codec");

const GAME_AUTO_RESPAWN_REQ = 820;
const GAME_AUTO_RESPAWN_ACK = 821;
const GAME_SPEED_2X_REQ = 825;
const GAME_SPEED_2X_ACK = 826;
const GAME_AUTO_SKILL_CHANGE_REQ = 827;
const GAME_AUTO_SKILL_CHANGE_ACK = 828;
const OK = 0;
const NO_AUTO = 94;
const PVP_SPEED_UNSUPPORTED = 20139;
const INVALID_REQUEST = 20191;
const EVENT_PVP_MANUAL_DISABLED = 24012;
const PVP_SYNC_GAME_TYPES = new Set([6, 18, 19, 24, 28]);

module.exports = [
  {
    packetId: GAME_AUTO_RESPAWN_REQ,
    name: "GAME_AUTO_RESPAWN_REQ",
    handle(ctx, socket, packet) {
      const requested = readBoolRequest(ctx, packet);
      const replay = activeReplay(socket);
      const current = currentControl(socket, "autoRespawnEnabled", false);
      let errorCode = OK;
      if (requested == null) errorCode = INVALID_REQUEST;
      else if (!replay || !canUseAutoRespawn(replay.dynamicGame, requested)) errorCode = NO_AUTO;
      if (errorCode === OK) rememberCombatControl(ctx, socket, { autoRespawnEnabled: requested });
      ctx.sendGameResponse(
        socket,
        packet,
        GAME_AUTO_RESPAWN_ACK,
        Buffer.concat([writeSignedVarInt(errorCode), writeBool(errorCode === OK ? requested : current)]),
        "game-auto-respawn"
      );
      return true;
    },
  },
  {
    packetId: GAME_SPEED_2X_REQ,
    name: "GAME_SPEED_2X_REQ",
    handle(ctx, socket, packet) {
      const requested = readEnumRequest(ctx, packet, 0, 5);
      const replay = activeReplay(socket);
      const current = currentControl(socket, "gameSpeedType", 0);
      let errorCode = OK;
      if (requested == null) errorCode = INVALID_REQUEST;
      else if (!replay) errorCode = NO_AUTO;
      else if (PVP_SYNC_GAME_TYPES.has(gameType(replay.dynamicGame))) errorCode = PVP_SPEED_UNSUPPORTED;
      if (errorCode === OK) rememberCombatControl(ctx, socket, { gameSpeedType: requested });
      ctx.sendGameResponse(
        socket,
        packet,
        GAME_SPEED_2X_ACK,
        Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarInt(errorCode === OK ? requested : current)]),
        "game-speed"
      );
      return true;
    },
  },
  {
    packetId: GAME_AUTO_SKILL_CHANGE_REQ,
    name: "GAME_AUTO_SKILL_CHANGE_REQ",
    handle(ctx, socket, packet) {
      const requested = readEnumRequest(ctx, packet, 0, 1);
      const replay = activeReplay(socket);
      const current = currentControl(socket, "autoSkillType", 1);
      let errorCode = OK;
      if (requested == null) errorCode = INVALID_REQUEST;
      else if (!replay) errorCode = NO_AUTO;
      else if (gameType(replay.dynamicGame) === 24 && forcedAuto(replay.dynamicGame)) {
        errorCode = EVENT_PVP_MANUAL_DISABLED;
      }
      if (errorCode === OK) rememberCombatControl(ctx, socket, { autoSkillType: requested });
      ctx.sendGameResponse(
        socket,
        packet,
        GAME_AUTO_SKILL_CHANGE_ACK,
        Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarInt(errorCode === OK ? requested : current)]),
        "game-auto-skill"
      );
      return true;
    },
  },
];

function readBoolRequest(ctx, packet) {
  try {
    const payload = ctx.decryptCopy(packet.payload || Buffer.alloc(0));
    const read = readByte(payload, 0);
    return read.offset === payload.length && (read.value === 0 || read.value === 1) ? read.value === 1 : null;
  } catch (_) {
    return null;
  }
}

function readEnumRequest(ctx, packet, min, max) {
  try {
    const payload = ctx.decryptCopy(packet.payload || Buffer.alloc(0));
    const read = readSignedVarInt(payload, 0);
    return read.offset === payload.length && read.value >= min && read.value <= max ? read.value : null;
  } catch (_) {
    return null;
  }
}

function rememberCombatControl(ctx, socket, controls) {
  if (ctx && typeof ctx.applyCombatControls === "function") {
    ctx.applyCombatControls(socket, controls, { persist: false });
    return;
  }
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay) return;
  Object.assign(replay, controls);
  if (replay.dynamicGame) Object.assign(replay.dynamicGame, controls);
  if (replay.battleState) Object.assign(replay.battleState, controls);
}

function activeReplay(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || (replay.battleState && replay.battleState.finished)) return null;
  return replay;
}

function gameType(dynamicGame) {
  return Number(dynamicGame && (dynamicGame.gameType ?? dynamicGame.GameType)) || 0;
}

function forcedAuto(dynamicGame) {
  return Boolean(dynamicGame && (dynamicGame.forcedAuto ?? dynamicGame.isForcedAuto ?? dynamicGame.ForcedAuto));
}

function canUseAutoRespawn(dynamicGame, requested) {
  if (gameType(dynamicGame) === 24 && forcedAuto(dynamicGame)) return false;
  if (!requested) return true;
  const type = gameType(dynamicGame);
  const dungeonId = Number(dynamicGame && (dynamicGame.dungeonID ?? dynamicGame.dungeonId)) || 0;
  if (type === 7) return false;
  if (type === 4) return Number(dynamicGame && (dynamicGame.warfareID ?? dynamicGame.warfareId)) > 0;
  if ([3, 15, 23].includes(type)) return dungeonId > 0 && (dungeonId < 20001 || dungeonId > 20005);
  return true;
}

function currentControl(socket, key, fallback) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const dynamicGame = replay && replay.dynamicGame;
  const teamB = Number(socket && socket.session && socket.session.privatePvpTeamType) === 3;
  const dynamicKey = teamB && key === "autoRespawnEnabled"
    ? "autoRespawnEnabledB"
    : teamB && key === "autoSkillType"
      ? "autoSkillTypeB"
      : key;
  const value = dynamicGame && dynamicGame[dynamicKey] != null
    ? dynamicGame[dynamicKey]
    : replay && replay[key] != null
      ? replay[key]
      : fallback;
  return key === "autoRespawnEnabled" ? Boolean(value) : Number(value);
}
