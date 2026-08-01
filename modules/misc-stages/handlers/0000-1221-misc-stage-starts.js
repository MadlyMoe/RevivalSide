const {
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarIntList,
  readBool,
} = require("../../packet-codec");
const { buildPlayerDeckForGameLoad } = require("../../unit");

const SHADOW_PALACE_START_ACK = 1222;
const PHASE_START_ACK = 1228;
const TRIM_START_ACK = 1235;
const TRIM_END_ACK = 1241;
const FIERCE_DATA_ACK = 845;
const FIERCE_PROFILE_ACK = 847;
const FIERCE_RANK_REWARD_ACK = 849;
const FIERCE_POINT_REWARD_ACK = 851;
const FIERCE_POINT_REWARD_ALL_ACK = 853;
const FIERCE_PENALTY_ACK = 858;
const EXPLORE_INFO_ACK = 1256;
const EXPLORE_ENTER_ACK = 1258;
const LEADERBOARD_FIERCE_LIST_ACK = 3205;
const LEADERBOARD_FIERCE_BOSSGROUP_LIST_ACK = 3207;
const DEFENCE_GAME_START_ACK = 3901;

module.exports = [
  {
    packetId: 844,
    name: "FIERCE_DATA_REQ",
    handle(ctx, socket, packet) {
      ctx.sendGameResponse(socket, packet, FIERCE_DATA_ACK, ctx.buildFierceDataAckPayload(socket.session && socket.session.user), "fierce-data");
      return true;
    },
  },
  {
    packetId: 857,
    name: "FIERCE_PENALTY_REQ",
    handle(ctx, socket, packet) {
      const req = decodeFiercePenaltyReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_PENALTY_ACK, ctx.buildFiercePenaltyAckPayload(req, socket.session && socket.session.user), "fierce-penalty");
      return true;
    },
  },
  {
    packetId: 846,
    name: "FIERCE_PROFILE_REQ",
    handle(ctx, socket, packet) {
      const req = decodeFierceProfileReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_PROFILE_ACK, ctx.buildFierceProfileAckPayload(req, socket.session && socket.session.user), "fierce-profile");
      return true;
    },
  },
  {
    packetId: 848,
    name: "FIERCE_COMPLETE_RANK_REWARD_REQ",
    handle(ctx, socket, packet) {
      ctx.sendGameResponse(socket, packet, FIERCE_RANK_REWARD_ACK, ctx.buildFierceRankRewardAckPayload(socket.session && socket.session.user), "fierce-rank-reward");
      return true;
    },
  },
  {
    packetId: 850,
    name: "FIERCE_COMPLETE_POINT_REWARD_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "fiercePointRewardId");
      ctx.sendGameResponse(socket, packet, FIERCE_POINT_REWARD_ACK, ctx.buildFiercePointRewardAckPayload(req, socket.session && socket.session.user), "fierce-point-reward");
      return true;
    },
  },
  {
    packetId: 852,
    name: "FIERCE_COMPLETE_POINT_REWARD_ALL_REQ",
    handle(ctx, socket, packet) {
      ctx.sendGameResponse(socket, packet, FIERCE_POINT_REWARD_ALL_ACK, ctx.buildFiercePointRewardAllAckPayload(socket.session && socket.session.user), "fierce-point-reward-all");
      return true;
    },
  },
  {
    packetId: 3204,
    name: "LEADERBOARD_FIERCE_LIST_REQ",
    handle(ctx, socket, packet) {
      const req = decodeLeaderboardFierceListReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, LEADERBOARD_FIERCE_LIST_ACK, ctx.buildLeaderboardFierceListAckPayload(req, socket.session && socket.session.user), "leaderboard-fierce-list");
      return true;
    },
  },
  {
    packetId: 3206,
    name: "LEADERBOARD_FIERCE_BOSSGROUP_LIST_REQ",
    handle(ctx, socket, packet) {
      const req = decodeLeaderboardFierceBossGroupListReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, LEADERBOARD_FIERCE_BOSSGROUP_LIST_ACK, ctx.buildLeaderboardFierceBossGroupListAckPayload(req, socket.session && socket.session.user), "leaderboard-fierce-bossgroup-list");
      return true;
    },
  },
  {
    packetId: 1221,
    name: "SHADOW_PALACE_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "palaceId");
      ctx.sendGameResponse(
        socket,
        packet,
        SHADOW_PALACE_START_ACK,
        ctx.buildShadowPalaceStartAckPayload(req, socket.session && socket.session.user),
        "shadow-palace-start"
      );
      return true;
    },
  },
  {
    packetId: 1227,
    name: "PHASE_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodePhaseStartReq(ctx, packet.payload);
      ctx.sendGameResponse(
        socket,
        packet,
        PHASE_START_ACK,
        ctx.buildPhaseStartAckPayload(req, socket.session && socket.session.user),
        "phase-start"
      );
      return true;
    },
  },
  {
    packetId: 1234,
    name: "TRIM_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodeTrimStartReq(ctx, packet.payload);
      console.log(`[TRIM_START_REQ] trimId=${req.trimId} trimLevel=${req.trimLevel} eventDeckCount=${req.eventDeckList ? req.eventDeckList.length : 0}`);
      if (req.eventDeckList && req.eventDeckList.length > 0) {
        req.eventDeckList.forEach((deck, idx) => {
          const unitCount = deck.units ? Object.keys(deck.units).length : 0;
          console.log(`[TRIM_START_REQ]   eventDeck[${idx}]: units=${unitCount} shipUid=${deck.shipUid} operatorUid=${deck.operatorUid} leaderIndex=${deck.leaderIndex}`);
        });
      }
      const ackPayload = ctx.buildTrimStartAckPayload(req, socket.session && socket.session.user);
      console.log(`[TRIM_START_ACK] sending response: payloadSize=${ackPayload.length}`);
      ctx.sendGameResponse(
        socket,
        packet,
        TRIM_START_ACK,
        ackPayload,
        "trim-start"
      );
      return true;
    },
  },
  {
    packetId: 1240,
    name: "TRIM_END_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "trimId");
      const payload = ctx.buildTrimEndAckPayload(req, socket.session && socket.session.user);
      console.log(`[TRIM_END_ACK] trimId=${req.trimId} payloadSize=${payload.length}`);
      ctx.sendGameResponse(socket, packet, TRIM_END_ACK, payload, "trim-end");
      ctx.sendServerGamePacket(socket, 1242, ctx.buildTrimIntervalInfoNotPayload(socket.session && socket.session.user), "trim-interval-info");
      return true;
    },
  },
  {
    packetId: 1255,
    name: "EXPLORE_INFO_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "templetId");
      ctx.sendGameResponse(socket, packet, EXPLORE_INFO_ACK, ctx.buildExploreInfoAckPayload(req, socket.session && socket.session.user), "explore-info");
      return true;
    },
  },
  {
    packetId: 1257,
    name: "EXPLORE_ENTER_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "templetId");
      ctx.sendGameResponse(socket, packet, EXPLORE_ENTER_ACK, ctx.buildExploreEnterAckPayload(req, socket.session && socket.session.user), "explore-enter");
      return true;
    },
  },
  {
    packetId: 3900,
    name: "DEFENCE_GAME_START_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "defenceTempletId");
      const stage = ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest({ defenceTempletId: req.defenceTempletId }) : null;
      const user = socket.session && socket.session.user;
      const loadReq = {
        selectDeckIndex: 0,
        stageID: Number((stage && stage.stageId) || 0),
        dungeonID: Number((stage && stage.dungeonID) || 0),
        defenceTempletId: req.defenceTempletId,
      };
      const playerDeck = stage && !stage.cutsceneOnly
        ? buildPlayerDeckForGameLoad(user, loadReq) || buildPlayerIdentityForGameLoad(user)
        : null;
      const payload = ctx.buildDefenceGameStartAckPayload(socket, loadReq, {
        stage: stage && playerDeck ? { ...stage, playerDeck } : stage,
      });
      ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, payload, "defence-game-start");
      return true;
    },
  },
];

function decodeSingleIntReq(ctx, payload, fieldName) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    return { [fieldName]: readSignedVarInt(decrypted, 0).value };
  } catch (_) {
    return { [fieldName]: 0 };
  }
}

function decodePhaseStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const stageId = readSignedVarInt(decrypted, 0);
    let supportingUserUid = 0n;
    try {
      supportingUserUid = readSignedVarLong(decrypted, Math.max(stageId.offset, decrypted.length - 10)).value;
    } catch (_) {
      supportingUserUid = 0n;
    }
    return { stageId: stageId.value, supportingUserUid };
  } catch (_) {
    return { stageId: 0, supportingUserUid: 0n };
  }
}

function decodeTrimStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    console.log(`[decodeTrimStartReq] decrypted payload length: ${decrypted.length} bytes: ${decrypted.slice(0, Math.min(50, decrypted.length)).toString('hex')}`);
    
    const trimId = readSignedVarInt(decrypted, 0);
    console.log(`[decodeTrimStartReq] trimId=${trimId.value} offset=${trimId.offset}`);
    
    const trimLevel = readSignedVarInt(decrypted, trimId.offset);
    console.log(`[decodeTrimStartReq] trimLevel=${trimLevel.value} offset=${trimLevel.offset}`);
    
    // Decode eventDeckList using the ctx helper methods
    let offset = trimLevel.offset;
    console.log(`[decodeTrimStartReq] about to read eventDeckList count at offset=${offset}, remaining bytes=${decrypted.length - offset}`);
    
    if (offset >= decrypted.length) {
      console.log(`[decodeTrimStartReq] offset beyond buffer length, no eventDeckList`);
      return { trimId: trimId.value, trimLevel: trimLevel.value, eventDeckList: [] };
    }
    
    const eventDeckListCount = ctx.readVarInt(decrypted, offset);
    console.log(`[decodeTrimStartReq] eventDeckList count=${eventDeckListCount.value} offset=${eventDeckListCount.offset}`);
    
    offset = eventDeckListCount.offset;
    const eventDeckList = [];
    
    for (let i = 0; i < eventDeckListCount.value; i++) {
      // Read nullable object marker (0x00 = null, 0x01 = has value)
      const hasValue = decrypted.readUInt8(offset) !== 0;
      offset += 1;
      console.log(`[decodeTrimStartReq] eventDeck[${i}] hasValue=${hasValue} at offset=${offset - 1}`);
      
      if (!hasValue) {
        console.log(`[decodeTrimStartReq] eventDeck[${i}] is null, skipping`);
        continue;
      }
      
      const eventDeck = ctx.readNkmEventDeckData(decrypted, offset);
      offset = eventDeck.offset;
      eventDeckList.push(eventDeck.value);
      console.log(`[decodeTrimStartReq] decoded eventDeck[${i}]: units=${Object.keys(eventDeck.value.units || {}).length}`);
    }
    
    console.log(`[decodeTrimStartReq] successfully decoded ${eventDeckList.length} event decks`);
    return { 
      trimId: trimId.value, 
      trimLevel: trimLevel.value,
      eventDeckList 
    };
  } catch (err) {
    console.log(`[decodeTrimStartReq] decode failed: ${err.message}`);
    console.log(`[decodeTrimStartReq] stack: ${err.stack}`);
    return { trimId: 0, trimLevel: 1, eventDeckList: [] };
  }
}

function decodeFiercePenaltyReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const boss = readSignedVarInt(decrypted, 0);
    const penalties = readSignedVarIntList(decrypted, boss.offset);
    return { fierceBossId: boss.value, penaltyIds: penalties.value };
  } catch (_) {
    return { fierceBossId: 0, penaltyIds: [] };
  }
}

function decodeFierceProfileReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const userUid = readSignedVarLong(decrypted, 0);
    const isForce = readBool(decrypted, userUid.offset);
    return { userUid: userUid.value, isForce: isForce.value };
  } catch (_) {
    return { userUid: 0n, isForce: false };
  }
}

function decodeLeaderboardFierceListReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    return { isAll: readBool(decrypted, 0).value };
  } catch (_) {
    return { isAll: false };
  }
}

function decodeLeaderboardFierceBossGroupListReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const group = readSignedVarInt(decrypted, 0);
    const isAll = readBool(decrypted, group.offset);
    return { fierceBossGroupId: group.value, isAll: isAll.value };
  } catch (_) {
    return { fierceBossGroupId: 0, isAll: false };
  }
}

function buildPlayerIdentityForGameLoad(user) {
  if (!user) return null;
  return {
    userUid: String(user.userUid || "0"),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    units: [],
  };
}
