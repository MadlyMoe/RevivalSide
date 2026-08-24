const {
  readBool,
  readSignedVarInt,
  writeBool,
  writeSignedVarInt,
} = require("../modules/packet-codec");

const GAME_OPTION_CHANGE_ACK = 1637;
const INVALID_REQUEST = 20191;
const DEFAULT_OPTIONS = Object.freeze({
  actionCameraType: 1,
  trackCamera: true,
  viewSkillCutIn: true,
  autoSyncFriendDeck: true,
  defaultPvpAutoRespawn: 0,
});

const handler = {
  packetId: 1636,
  name: "GAME_OPTION_CHANGE_REQ",
  handle(ctx, socket, packet) {
    const user = socket && socket.session && socket.session.user;
    const request = decodeGameOptions(ctx, packet.payload);
    const current = getGameOptions(user);
    const errorCode = request ? 0 : INVALID_REQUEST;
    const next = request || current;
    const changed = request ? saveGameOptions(user, request) : false;
    const payload = buildGameOptionAckPayload(next, errorCode);
    if (socket.session && socket.session.gameReplay) {
      ctx.sendServerGamePacket(socket, GAME_OPTION_CHANGE_ACK, payload, "game-option-change");
    } else {
      ctx.sendGameResponse(socket, packet, GAME_OPTION_CHANGE_ACK, payload, "game-option-change");
    }
    if (changed && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") {
      ctx.saveUserDb();
      if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
        ctx.invalidateJoinLobbyAckPayloadCache("game-option-change");
      }
    }
    return true;
  },
};

function decodeGameOptions(ctx, encryptedPayload) {
  try {
    const payload = ctx.decryptCopy(encryptedPayload);
    let read = readSignedVarInt(payload, 0);
    const actionCameraType = read.value;
    read = readBool(payload, read.offset);
    const trackCamera = read.value;
    read = readBool(payload, read.offset);
    const viewSkillCutIn = read.value;
    read = readBool(payload, read.offset);
    const autoSyncFriendDeck = read.value;
    read = readSignedVarInt(payload, read.offset);
    const defaultPvpAutoRespawn = read.value;
    if (read.offset !== payload.length || actionCameraType < 0 || actionCameraType > 2 || defaultPvpAutoRespawn < 0 || defaultPvpAutoRespawn > 2) {
      return null;
    }
    return { actionCameraType, trackCamera, viewSkillCutIn, autoSyncFriendDeck, defaultPvpAutoRespawn };
  } catch (_) {
    return null;
  }
}

function getGameOptions(user) {
  const options = user && user.options && typeof user.options === "object" ? user.options : {};
  return {
    actionCameraType: enumValue(options.actionCameraType, 0, 2, DEFAULT_OPTIONS.actionCameraType),
    trackCamera: boolValue(options.trackCamera, DEFAULT_OPTIONS.trackCamera),
    viewSkillCutIn: boolValue(options.viewSkillCutIn, DEFAULT_OPTIONS.viewSkillCutIn),
    autoSyncFriendDeck: boolValue(options.autoSyncFriendDeck, DEFAULT_OPTIONS.autoSyncFriendDeck),
    defaultPvpAutoRespawn: enumValue(options.defaultPvpAutoRespawn, 0, 2, DEFAULT_OPTIONS.defaultPvpAutoRespawn),
  };
}

function saveGameOptions(user, next) {
  if (!user || typeof user !== "object") return false;
  const current = getGameOptions(user);
  const changed = Object.keys(DEFAULT_OPTIONS).some((key) => current[key] !== next[key]);
  if (!changed) return false;
  user.options = { ...(user.options && typeof user.options === "object" ? user.options : {}), ...next };
  return true;
}

function buildGameOptionAckPayload(options, errorCode = 0) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(options.actionCameraType),
    writeBool(options.trackCamera),
    writeBool(options.viewSkillCutIn),
    writeBool(options.autoSyncFriendDeck),
    writeSignedVarInt(options.defaultPvpAutoRespawn),
  ]);
}

function enumValue(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function boolValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

handler.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
handler.INVALID_REQUEST = INVALID_REQUEST;
handler.buildGameOptionAckPayload = buildGameOptionAckPayload;
handler.getGameOptions = getGameOptions;

module.exports = handler;
