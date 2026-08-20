const {
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
} = require("../../packet-codec");
const { buildUserProfileData } = require("../../profile");
const { createReader, ERRORS } = require("..");

const REQUESTS = {
  4100: "PRIVATE_PVP_LOBBY_CREATE_REQ",
  4102: "PRIVATE_PVP_LOBBY_READY_REQ",
  4104: "PRIVATE_PVP_LOBBY_INVITE_REQ",
  4107: "PRIVATE_PVP_LOBBY_CANCEL_INVITE_REQ",
  4110: "PRIVATE_PVP_LOBBY_ACCEPT_INVITE_REQ",
  4113: "PRIVATE_PVP_LOBBY_EXIT_REQ",
  4115: "PRIVATE_PVP_LOBBY_CHANGE_ROLE_REQ",
  4117: "PRIVATE_PVP_LOBBY_SYNC_DECK_INDEX_REQ",
  4119: "PRIVATE_PVP_LOBBY_SEARCH_USER_REQ",
  4121: "PRIVATE_PVP_LOBBY_CHANGE_OPTION_REQ",
  4123: "PRIVATE_PVP_LOBBY_ACCEPT_CODE_REQ",
  4125: "PRIVATE_PVP_LOBBY_KICK_REQ",
  4130: "PRIVATE_PVP_LOBBY_START_GAME_SETTING_REQ",
  4133: "PRIVATE_PVP_LOBBY_DRAFT_GIVEUP_REQ",
  4136: "PRIVATE_PVP_STATE_REQ",
};

module.exports = Object.entries(REQUESTS).map(([packetIdText, name]) => ({
  packetId: Number(packetIdText),
  name,
  handle(ctx, socket, packet) {
    const manager = ctx.privatePvp;
    if (!manager || !manager.enabled) return false;
    const packetId = Number(packetIdText);
    const reader = createReader(ctx.decryptCopy(packet.payload));
    const user = socket.session.user || ctx.createEphemeralUser();
    const room = manager.getRoom(socket);
    const member = manager.getMember(socket);

    if (packetId === 4100) {
      const request = { isObserverMode: reader.bool(), inviteFriendCode: reader.long(), config: reader.config() };
      const created = manager.createRoom(socket, user, request);
      ctx.sendGameResponse(socket, packet, 4101, Buffer.concat([writeSignedVarInt(0), writeNullableObject(manager.buildLobbyData(created))]), "private-pvp-create");
      return true;
    }
    if (packetId === 4123) {
      const code = reader.string();
      const local = manager.joinLocal(code, socket, user);
      if (!local.errorCode) {
        sendAcceptCode(ctx, socket, packet, local);
        manager.broadcastState(local.room, ctx);
        return true;
      }
      manager.requestRemoteJoin(code, user).then((result) => sendAcceptCode(ctx, socket, packet, result));
      return true;
    }
    if (!room || !member) {
      return sendNotInRoom(ctx, socket, packet, packetId);
    }
    if (packetId === 4102) {
      member.deckIndex = reader.deckIndex();
      member.ready = reader.bool();
      user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
      user.pvp.privateLobbyDeckIndex = member.deckIndex;
      ctx.sendGameResponse(socket, packet, 4103, writeSignedVarInt(0), "private-pvp-ready");
      manager.broadcastState(room, ctx);
      return true;
    }
    if (packetId === 4113) {
      ctx.sendGameResponse(socket, packet, 4114, writeSignedVarInt(0), "private-pvp-exit");
      manager.leave(socket, ctx);
      return true;
    }
    if (packetId === 4117) {
      member.deckIndex = reader.deckIndex();
      user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
      user.pvp.privateLobbyDeckIndex = member.deckIndex;
      ctx.sendGameResponse(socket, packet, 4118, writeSignedVarInt(0), "private-pvp-deck");
      manager.broadcastState(room, ctx);
      return true;
    }
    if (packetId === 4121) {
      if (!member.host) return sendError(ctx, socket, packet, 4122, ERRORS.NOT_JOINED);
      room.config = reader.config();
      ctx.sendGameResponse(socket, packet, 4122, Buffer.concat([writeSignedVarInt(0), writeNullableObject(manager.buildLobbyData(room))]), "private-pvp-option");
      manager.broadcast(room, ctx, 4129, writeNullableObject(require("..").buildConfig(room.config)), "private-pvp-config", { except: socket });
      return true;
    }
    if (packetId === 4125) {
      const targetUid = String(reader.long());
      const target = room.members.find((entry) => String(entry.user.userUid) === targetUid && entry !== member);
      if (!member.host || !target) return sendError(ctx, socket, packet, 4126, ERRORS.INVALID_TARGET);
      room.members = room.members.filter((entry) => entry !== target);
      ctx.sendGameResponse(socket, packet, 4126, Buffer.concat([writeSignedVarInt(0), writeNullableObject(manager.buildLobbyData(room))]), "private-pvp-kick");
      if (target.socket && !target.socket.destroyed) {
        ctx.sendServerGamePacket(target.socket, 4127, writeSignedVarInt(0), "private-pvp-kicked");
        delete target.socket.session.privatePvpRoom;
        delete target.socket.session.privatePvpMember;
      }
      manager.broadcastState(room, ctx);
      return true;
    }
    if (packetId === 4130) {
      if (!member.host) return sendError(ctx, socket, packet, 4131, ERRORS.NOT_JOINED);
      ctx.sendGameResponse(socket, packet, 4131, writeSignedVarInt(0), "private-pvp-start-setting");
      ctx.startPrivatePvpMatch(room);
      return true;
    }
    if (packetId === 4136) {
      member.playerState = reader.int();
      ctx.sendGameResponse(socket, packet, 4137, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(member.playerState)]), "private-pvp-player-state");
      if (room.matchFinished && member.playerState === 1 && room.members.filter((entry) => !entry.observer).every((entry) => entry.playerState === 1)) {
        ctx.resetPrivatePvpMatch(room);
        return true;
      }
      manager.broadcastState(room, ctx);
      return true;
    }
    if (packetId === 4119) {
      const keyword = reader.string().toLowerCase();
      const found = Object.values(ctx.userDb.users || {}).filter((entry) => !keyword || String(entry.nickname || "").toLowerCase().includes(keyword) || String(entry.friendCode || "").includes(keyword)).slice(0, 20);
      ctx.sendGameResponse(socket, packet, 4120, Buffer.concat([writeSignedVarInt(0), writeNullableObjectList(found.map(buildUserProfileData))]), "private-pvp-search");
      return true;
    }
    if (packetId === 4104) {
      reader.long();
      ctx.sendGameResponse(socket, packet, 4105, writeSignedVarInt(0), "private-pvp-invite");
      return true;
    }
    if (packetId === 4107) {
      const targetUid = reader.long();
      ctx.sendGameResponse(socket, packet, 4108, Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(targetUid)]), "private-pvp-cancel-invite");
      return true;
    }
    if (packetId === 4110) {
      reader.long();
      reader.bool();
      ctx.sendGameResponse(socket, packet, 4111, Buffer.concat([writeSignedVarInt(ERRORS.INVALID_TARGET), writeSignedVarInt(0), writeString(""), writeSignedVarInt(0), writeString("")]), "private-pvp-accept-invite");
      return true;
    }
    if (packetId === 4115) {
      const targetUid = String(reader.long());
      const role = reader.int();
      const target = room.members.find((entry) => String(entry.user.userUid) === targetUid);
      if (!member.host || !target || role < 0 || role > 2 || (role === 2 && !room.observerMode)) {
        ctx.sendGameResponse(socket, packet, 4116, Buffer.concat([writeSignedVarInt(ERRORS.INVALID_TARGET), writeNullableObject(manager.buildLobbyData(room))]), "private-pvp-change-role");
        return true;
      }
      const desiredTeam = role === 0 ? 1 : role === 1 ? 3 : 0;
      const occupied = desiredTeam ? room.members.find((entry) => entry !== target && !entry.observer && entry.teamType === desiredTeam) : null;
      if (occupied) {
        occupied.teamType = target.teamType || (desiredTeam === 1 ? 3 : 1);
        occupied.observer = false;
        if (occupied.socket) occupied.socket.session.privatePvpTeamType = occupied.teamType;
      }
      target.teamType = desiredTeam;
      target.observer = role === 2;
      target.ready = false;
      if (target.socket) target.socket.session.privatePvpTeamType = target.teamType;
      ctx.sendGameResponse(socket, packet, 4116, Buffer.concat([writeSignedVarInt(0), writeNullableObject(manager.buildLobbyData(room))]), "private-pvp-change-role");
      manager.broadcastState(room, ctx);
      return true;
    }
    if (packetId === 4133) {
      ctx.sendGameResponse(socket, packet, 4134, writeSignedVarInt(0), "private-pvp-draft-giveup");
      manager.broadcast(room, ctx, 4135, Buffer.alloc(0), "private-pvp-draft-giveup", { except: socket });
      return true;
    }
    return false;
  },
}));

function sendAcceptCode(ctx, socket, packet, result) {
  const errorCode = Number(result && result.errorCode || 0);
  ctx.sendGameResponse(socket, packet, 4124, Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(0),
    writeString(result && result.serverIp || ""),
    writeSignedVarInt(Number(result && result.port || 0)),
    writeString(result && result.accessToken || ""),
  ]), errorCode ? "private-pvp-code-failed" : "private-pvp-code-accepted");
}

function sendError(ctx, socket, packet, ackId, errorCode) {
  ctx.sendGameResponse(socket, packet, ackId, writeSignedVarInt(errorCode), "private-pvp-error");
  return true;
}

function sendNotInRoom(ctx, socket, packet, packetId) {
  let payload = writeSignedVarInt(ERRORS.NOT_IN_ROOM);
  if (packetId === 4107) payload = Buffer.concat([payload, writeSignedVarLong(0n)]);
  if (packetId === 4110) {
    payload = Buffer.concat([payload, writeSignedVarInt(0), writeString(""), writeSignedVarInt(0), writeString("")]);
  }
  if (packetId === 4115 || packetId === 4121 || packetId === 4125) {
    payload = Buffer.concat([payload, writeNullObject()]);
  }
  if (packetId === 4119) payload = Buffer.concat([payload, writeNullableObjectList([])]);
  if (packetId === 4136) payload = Buffer.concat([payload, writeSignedVarInt(0)]);
  ctx.sendGameResponse(socket, packet, packetId + 1, payload, "private-pvp-not-in-room");
  return true;
}
