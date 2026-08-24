const {
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarIntList,
  readBool,
  writeSignedVarInt,
  writeSignedVarLong,
  writeBool,
  writeVarInt,
  writeIntList,
  writeNullObject,
  writeObjectList,
} = require("../../packet-codec");
const { buildPlayerDeckForGameLoad } = require("../../unit");
const {
  eventDeckHasFreeShipSlot,
  eventDeckHasGivenUnitSlots,
  getEventDeckPlayerUnitSlots,
} = require("../../game-data");

const PHASE_START_ACK = 1228;
const TRIM_START_ACK = 1235;
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
      const req = decodeEmptyReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_DATA_ACK, ctx.buildFierceDataAckPayload(socket.session && socket.session.user, req, ctx), "fierce-data");
      return true;
    },
  },
  {
    packetId: 857,
    name: "FIERCE_PENALTY_REQ",
    handle(ctx, socket, packet) {
      const req = decodeFiercePenaltyReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_PENALTY_ACK, ctx.buildFiercePenaltyAckPayload(req, socket.session && socket.session.user, ctx), "fierce-penalty");
      return true;
    },
  },
  {
    packetId: 846,
    name: "FIERCE_PROFILE_REQ",
    handle(ctx, socket, packet) {
      const req = decodeFierceProfileReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_PROFILE_ACK, ctx.buildFierceProfileAckPayload(req, socket.session && socket.session.user, ctx), "fierce-profile");
      return true;
    },
  },
  {
    packetId: 848,
    name: "FIERCE_COMPLETE_RANK_REWARD_REQ",
    handle(ctx, socket, packet) {
      const req = decodeEmptyReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_RANK_REWARD_ACK, ctx.buildFierceRankRewardAckPayload(socket.session && socket.session.user, req, ctx), "fierce-rank-reward");
      return true;
    },
  },
  {
    packetId: 850,
    name: "FIERCE_COMPLETE_POINT_REWARD_REQ",
    handle(ctx, socket, packet) {
      const req = decodeSingleIntReq(ctx, packet.payload, "fiercePointRewardId");
      ctx.sendGameResponse(socket, packet, FIERCE_POINT_REWARD_ACK, ctx.buildFiercePointRewardAckPayload(req, socket.session && socket.session.user, ctx), "fierce-point-reward");
      return true;
    },
  },
  {
    packetId: 852,
    name: "FIERCE_COMPLETE_POINT_REWARD_ALL_REQ",
    handle(ctx, socket, packet) {
      const req = decodeEmptyReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, FIERCE_POINT_REWARD_ALL_ACK, ctx.buildFiercePointRewardAllAckPayload(socket.session && socket.session.user, req, ctx), "fierce-point-reward-all");
      return true;
    },
  },
  {
    packetId: 3204,
    name: "LEADERBOARD_FIERCE_LIST_REQ",
    handle(ctx, socket, packet) {
      const req = decodeLeaderboardFierceListReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, LEADERBOARD_FIERCE_LIST_ACK, ctx.buildLeaderboardFierceListAckPayload(req, socket.session && socket.session.user, ctx), "leaderboard-fierce-list");
      return true;
    },
  },
  {
    packetId: 3206,
    name: "LEADERBOARD_FIERCE_BOSSGROUP_LIST_REQ",
    handle(ctx, socket, packet) {
      const req = decodeLeaderboardFierceBossGroupListReq(ctx, packet.payload);
      ctx.sendGameResponse(socket, packet, LEADERBOARD_FIERCE_BOSSGROUP_LIST_ACK, ctx.buildLeaderboardFierceBossGroupListAckPayload(req, socket.session && socket.session.user, ctx), "leaderboard-fierce-bossgroup-list");
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
        ctx.buildPhaseStartAckPayload(req, socket.session && socket.session.user, ctx),
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
      ctx.sendGameResponse(
        socket,
        packet,
        TRIM_START_ACK,
        ctx.buildTrimStartAckPayload(req, socket.session && socket.session.user),
        "trim-start"
      );
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
      const req = decodeDefenceGameStartReq(ctx, packet.payload);
      if (!req.valid) {
        ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, defenceStartFailure(25900), "defence-game-start-invalid");
        return true;
      }
      const stage = ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest({ defenceTempletId: req.defenceTempletId }) : null;
      const user = socket.session && socket.session.user;
      if (!stage || Number(stage.defenceTempletId || 0) !== req.defenceTempletId) {
        ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, defenceStartFailure(25900), "defence-game-start-missing");
        return true;
      }
      const eventDeckId = Number(stage.eventDeckId || stage.EventDeckId || 0);
      const playerSlots = eventDeckId > 0 ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
      if (!isValidDefenceSelection(user, req.eventDeckData, playerSlots)) {
        ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, defenceStartFailure(25905), "defence-game-start-team");
        return true;
      }
      const loadReq = {
        selectDeckIndex: 0,
        stageID: Number((stage && stage.stageId) || 0),
        dungeonID: Number((stage && stage.dungeonID) || 0),
        defenceTempletId: req.defenceTempletId,
        eventDeckData: req.eventDeckData,
      };
      const playerDeck = stage && !stage.cutsceneOnly
        ? playerSlots.length > 0
          ? buildPlayerDeckForGameLoad(user, loadReq, {
              allowedUnitSlots: playerSlots,
              slotUnitUids: req.eventDeckData && req.eventDeckData.units,
              shipUid: req.eventDeckData && req.eventDeckData.shipUid,
              operatorUid: req.eventDeckData && req.eventDeckData.operatorUid,
              leaderIndex: req.eventDeckData && req.eventDeckData.leaderIndex,
            })
          : buildPlayerIdentityForGameLoad(user)
        : null;
      if (!playerDeck) {
        ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, defenceStartFailure(25905), "defence-game-start-team");
        return true;
      }
      const payload = ctx.buildDefenceGameStartAckPayload(socket, loadReq, {
        stage: {
          ...stage,
          eventDeckFreeUnitSlots: playerSlots,
          usesHybridEventDeck: eventDeckId > 0 && eventDeckHasGivenUnitSlots(eventDeckId),
          eventDeckFreeShipSlot: eventDeckId > 0 && eventDeckHasFreeShipSlot(eventDeckId),
          playerDeck,
        },
      });
      ctx.sendGameResponse(socket, packet, DEFENCE_GAME_START_ACK, payload, "defence-game-start");
      return true;
    },
  },
];

function decodeSingleIntReq(ctx, payload, fieldName) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const value = canonicalInt(decrypted, 0);
    if (value.offset !== decrypted.length) throw new Error("trailing request data");
    return { valid: true, [fieldName]: value.value };
  } catch (_) {
    return { valid: false, [fieldName]: 0 };
  }
}

function decodeEmptyReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    return { valid: decrypted.length === 0 };
  } catch (_) {
    return { valid: false };
  }
}

function decodeDefenceGameStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const defenceTempletId = readSignedVarInt(decrypted, 0);
    let offset = defenceTempletId.offset;
    if (offset >= decrypted.length) throw new Error("missing event deck marker");
    const present = decrypted.readUInt8(offset++) !== 0;
    let eventDeckData = null;
    if (present) {
      const shipUid = readSignedVarLong(decrypted, offset);
      offset = shipUid.offset;
      const count = readUnsignedVarInt(decrypted, offset);
      offset = count.offset;
      if (count.value > 8) throw new Error("event deck unit map is too large");
      const units = {};
      for (let index = 0; index < count.value; index += 1) {
        const slot = readSignedVarInt(decrypted, offset);
        offset = slot.offset;
        const unitUid = readSignedVarLong(decrypted, offset);
        offset = unitUid.offset;
        if (Object.prototype.hasOwnProperty.call(units, String(slot.value))) throw new Error("duplicate event deck slot");
        units[slot.value] = unitUid.value;
      }
      const operatorUid = readSignedVarLong(decrypted, offset);
      offset = operatorUid.offset;
      const leaderIndex = readSignedVarInt(decrypted, offset);
      offset = leaderIndex.offset;
      eventDeckData = {
        shipUid: shipUid.value,
        units,
        operatorUid: operatorUid.value,
        leaderIndex: leaderIndex.value,
      };
    }
    return {
      valid: offset === decrypted.length && defenceTempletId.value > 0,
      defenceTempletId: defenceTempletId.value,
      eventDeckData,
    };
  } catch (_) {
    return { valid: false, defenceTempletId: 0, eventDeckData: null };
  }
}

function isValidDefenceSelection(user, selection, playerSlots) {
  if (!Array.isArray(playerSlots) || playerSlots.length === 0) return true;
  if (!user || !selection || !selection.units) return false;
  const allowed = new Set(playerSlots.map(Number));
  const army = user.army && typeof user.army === "object" ? user.army : {};
  const ownedUnits = army.units && typeof army.units === "object" ? army.units : {};
  const selected = Object.entries(selection.units)
    .filter(([, uid]) => BigInt(uid || 0) > 0n);
  if (selected.length === 0) return false;
  const seen = new Set();
  for (const [slotText, uid] of selected) {
    const slot = Number(slotText);
    const key = String(BigInt(uid));
    if (!allowed.has(slot) || seen.has(key) || !ownedUnits[key]) return false;
    seen.add(key);
  }
  if (BigInt(selection.shipUid || 0) > 0n && !(army.ships && army.ships[String(BigInt(selection.shipUid))])) return false;
  if (BigInt(selection.operatorUid || 0) > 0n && !(army.operators && army.operators[String(BigInt(selection.operatorUid))])) return false;
  return Number.isInteger(Number(selection.leaderIndex)) && Number(selection.leaderIndex) >= -1 && Number(selection.leaderIndex) < 8;
}

function readUnsignedVarInt(buffer, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32 && offset < buffer.length) {
    const byte = buffer.readUInt8(offset++);
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("invalid unsigned varint");
}

function defenceStartFailure(errorCode) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeObjectList([])]);
}

function decodePhaseStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const stageId = canonicalInt(decrypted, 0);
    const deckPresent = canonicalBool(decrypted, stageId.offset);
    if (!deckPresent.value) throw new Error("missing deck index");
    const deckType = canonicalInt(decrypted, deckPresent.offset);
    if (deckType.value < 0 || deckType.value > 10 || deckType.offset >= decrypted.length) {
      throw new Error("invalid deck type");
    }
    const deckIndex = decrypted.readUInt8(deckType.offset);
    let offset = deckType.offset + 1;
    const eventDeckPresent = canonicalBool(decrypted, offset);
    offset = eventDeckPresent.offset;
    let eventDeckData = null;
    if (eventDeckPresent.value) {
      const parsed = decodePhaseEventDeckData(decrypted, offset);
      eventDeckData = parsed.value;
      offset = parsed.offset;
    }
    const supportingUserUid = canonicalLong(decrypted, offset);
    offset = supportingUserUid.offset;
    const canonical = Buffer.concat([
      writeSignedVarInt(stageId.value),
      writeBool(true),
      writeSignedVarInt(deckType.value),
      Buffer.from([deckIndex]),
      writeBool(eventDeckPresent.value),
      eventDeckPresent.value ? encodePhaseEventDeckData(eventDeckData) : Buffer.alloc(0),
      writeSignedVarLong(supportingUserUid.value),
    ]);
    if (offset !== decrypted.length || !canonical.equals(decrypted)) throw new Error("invalid phase request");
    return {
      valid: true,
      stageId: stageId.value,
      deckIndex: { deckType: deckType.value, index: deckIndex },
      eventDeckData,
      supportingUserUid: supportingUserUid.value,
    };
  } catch (_) {
    return {
      valid: false,
      stageId: 0,
      deckIndex: { deckType: 0, index: 0 },
      eventDeckData: null,
      supportingUserUid: 0n,
    };
  }
}

function decodePhaseEventDeckData(payload, startOffset) {
  const ship = canonicalLong(payload, startOffset);
  const count = canonicalUnsignedInt(payload, ship.offset);
  if (count.value > 8) throw new Error("too many phase event-deck units");
  let offset = count.offset;
  const units = {};
  for (let index = 0; index < count.value; index += 1) {
    const slot = canonicalInt(payload, offset);
    const uid = canonicalLong(payload, slot.offset);
    offset = uid.offset;
    if (
      slot.value < 0 ||
      slot.value >= 8 ||
      uid.value < 0n ||
      Object.prototype.hasOwnProperty.call(units, String(slot.value))
    ) {
      throw new Error("invalid phase event-deck unit");
    }
    units[slot.value] = uid.value;
  }
  const operator = canonicalLong(payload, offset);
  const leader = canonicalInt(payload, operator.offset);
  if (ship.value < 0n || operator.value < 0n || leader.value < -1 || leader.value >= 8) {
    throw new Error("invalid phase event-deck identity");
  }
  return {
    value: {
      shipUid: ship.value,
      units,
      operatorUid: operator.value,
      leaderIndex: leader.value,
    },
    offset: leader.offset,
  };
}

function encodePhaseEventDeckData(deck = {}) {
  const entries = Object.entries(deck.units || {}).sort((left, right) => Number(left[0]) - Number(right[0]));
  return Buffer.concat([
    writeSignedVarLong(deck.shipUid || 0n),
    writeVarInt(entries.length),
    ...entries.flatMap(([slot, uid]) => [writeSignedVarInt(Number(slot)), writeSignedVarLong(uid)]),
    writeSignedVarLong(deck.operatorUid || 0n),
    writeSignedVarInt(Number(deck.leaderIndex == null ? -1 : deck.leaderIndex)),
  ]);
}

function canonicalUnsignedInt(payload, offset) {
  const read = readUnsignedVarInt(payload, offset);
  if (!writeVarInt(read.value).equals(payload.subarray(offset, read.offset))) throw new Error("noncanonical uint");
  return read;
}

function decodeTrimStartReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const trimId = readSignedVarInt(decrypted, 0);
    const trimLevel = readSignedVarInt(decrypted, trimId.offset);
    return { trimId: trimId.value, trimLevel: trimLevel.value };
  } catch (_) {
    return { trimId: 0, trimLevel: 1 };
  }
}

function decodeFiercePenaltyReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const boss = canonicalInt(decrypted, 0);
    const penalties = readSignedVarIntList(decrypted, boss.offset);
    const canonical = Buffer.concat([writeSignedVarInt(boss.value), writeIntList(penalties.value)]);
    if (penalties.offset !== decrypted.length || !canonical.equals(decrypted)) throw new Error("invalid penalty request");
    return { valid: true, fierceBossId: boss.value, penaltyIds: penalties.value };
  } catch (_) {
    return { valid: false, fierceBossId: 0, penaltyIds: [] };
  }
}

function decodeFierceProfileReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const userUid = canonicalLong(decrypted, 0);
    const isForce = canonicalBool(decrypted, userUid.offset);
    if (isForce.offset !== decrypted.length) throw new Error("trailing profile request data");
    return { valid: true, userUid: userUid.value, isForce: isForce.value };
  } catch (_) {
    return { valid: false, userUid: 0n, isForce: false };
  }
}

function decodeLeaderboardFierceListReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const isAll = canonicalBool(decrypted, 0);
    if (isAll.offset !== decrypted.length) throw new Error("trailing leaderboard request data");
    return { valid: true, isAll: isAll.value };
  } catch (_) {
    return { valid: false, isAll: false };
  }
}

function decodeLeaderboardFierceBossGroupListReq(ctx, payload) {
  try {
    const decrypted = ctx.decryptCopy(payload);
    const group = canonicalInt(decrypted, 0);
    const isAll = canonicalBool(decrypted, group.offset);
    if (isAll.offset !== decrypted.length) throw new Error("trailing boss-group request data");
    return { valid: true, fierceBossGroupId: group.value, isAll: isAll.value };
  } catch (_) {
    return { valid: false, fierceBossGroupId: 0, isAll: false };
  }
}

function canonicalInt(payload, offset) {
  const read = readSignedVarInt(payload, offset);
  if (!writeSignedVarInt(read.value).equals(payload.subarray(offset, read.offset))) throw new Error("noncanonical int");
  return read;
}

function canonicalLong(payload, offset) {
  const read = readSignedVarLong(payload, offset);
  if (!writeSignedVarLong(read.value).equals(payload.subarray(offset, read.offset))) throw new Error("noncanonical long");
  return read;
}

function canonicalBool(payload, offset) {
  const read = readBool(payload, offset);
  if (!writeBool(read.value).equals(payload.subarray(offset, read.offset))) throw new Error("noncanonical bool");
  return read;
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
