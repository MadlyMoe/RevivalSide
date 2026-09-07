const {
  writeByte,
  writeSByte,
  writeString,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeNullObject,
  buildDeckIndexData,
  buildDeckData,
  readBool,
  readByte,
  readSByte,
  readString,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  toBigInt,
} = require("../packet-codec");
const {
  swapDeckUnits,
  setDeckLeader,
  unlockDeck,
  setDeckUnit,
  autoSetDeck,
  setDeckShip,
  setDeckOperator,
  updateDeckName,
} = require("../unit");

const DECK_PACKET_IDS = [1600, 1602, 1604, 1606, 1608, 1610, 1612, 1652];

function createDeckPipelineHandlers() {
  return DECK_PACKET_IDS.map((packetId) => ({
    packetId,
    name: `DECK_PIPELINE_${packetId}`,
    handle(ctx, socket, packet) {
      const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
      if (socket.session) socket.session.user = user;
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildResponse(user, packetId, request);
      console.log(`[deck:${packetId}] ${describeDeckRequest(packetId, request)} ACK packetId=${response.packetId}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      if (ctx.config.USE_LOCAL_USER_DB) {
        const userUid = user && (user.userUid || user.m_UserUID);
        if (typeof ctx.scheduleDebouncedUserSave === "function") {
          ctx.scheduleDebouncedUserSave(userUid);
        } else if (typeof ctx.saveUserDb === "function") {
          ctx.saveUserDb(userUid);
        }
      }
      return true;
    },
  }));
}

function buildResponse(user, packetId, req) {
  switch (packetId) {
    case 1600: {
      const result = swapDeckUnits(user, req.deckIndex, req.slotIndexFrom, req.slotIndexTo);
      return {
        packetId: 1601,
        payload: Buffer.concat([
          writeSignedVarInt(0),
          writeDeckIndex(req.deckIndex),
          writeSByte(result.deck.leaderIndex),
          writeByte(result.slotIndexFrom),
          writeByte(result.slotIndexTo),
          writeSignedVarLong(toBigInt(result.slotUnitUidFrom || 0)),
          writeSignedVarLong(toBigInt(result.slotUnitUidTo || 0)),
        ]),
      };
    }
    case 1602: {
      const deck = setDeckLeader(user, req.deckIndex, req.leaderSlotIndex);
      return {
        packetId: 1603,
        payload: Buffer.concat([writeSignedVarInt(0), writeDeckIndex(req.deckIndex), writeSByte(deck.leaderIndex)]),
      };
    }
    case 1604: {
      const unlockedDeckSize = unlockDeck(user, req.deckType);
      return {
        packetId: 1605,
        payload: Buffer.concat([
          writeSignedVarInt(0),
          writeSignedVarInt(Number(req.deckType || 0) || 0),
          writeByte(unlockedDeckSize),
          writeNullMiscItem(),
        ]),
      };
    }
    case 1606: {
      const result = setDeckUnit(user, req.deckIndex, req.slotIndex, req.unitUID);
      return {
        packetId: 1607,
        payload: Buffer.concat([
          writeSignedVarInt(0),
          writeDeckIndex(req.deckIndex),
          writeByte(req.slotIndex),
          writeSignedVarLong(toBigInt(req.unitUID || 0)),
          writeDeckIndex(result.oldDeckIndex),
          writeSByte(result.oldSlotIndex),
          writeSByte(result.deck.leaderIndex),
          writeSByte(result.oldLeaderSlotIndex),
        ]),
      };
    }
    case 1608: {
      const deck = autoSetDeck(user, req.deckIndex, req.unitUIDList, req.shipUID, req.operatorUid);
      return {
        packetId: 1609,
        payload: Buffer.concat([
          writeDeckIndex(req.deckIndex),
          writeSignedVarInt(0),
          writeNullableDeck(deck),
        ]),
      };
    }
    case 1610: {
      const result = setDeckShip(user, req.deckIndex, req.shipUID);
      return {
        packetId: 1611,
        payload: Buffer.concat([
          writeSignedVarInt(0),
          writeDeckIndex(req.deckIndex),
          writeDeckIndex(result.oldDeckIndex),
          writeSignedVarLong(toBigInt(req.shipUID || 0)),
        ]),
      };
    }
    case 1612: {
      const result = setDeckOperator(user, req.deckIndex, req.operatorUid);
      return {
        packetId: 1613,
        payload: Buffer.concat([
          writeSignedVarInt(0),
          writeDeckIndex(req.deckIndex),
          writeSignedVarLong(toBigInt(req.operatorUid || 0)),
          writeDeckIndex(result.oldDeckIndex),
        ]),
      };
    }
    case 1652: {
      const deck = updateDeckName(user, req.deckIndex, req.name);
      return {
        packetId: 1653,
        payload: Buffer.concat([writeSignedVarInt(0), writeDeckIndex(req.deckIndex), writeString(deck.name || "")]),
      };
    }
    default:
      return { packetId: packetId + 1, payload: writeSignedVarInt(0) };
  }
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case 1600:
        return { deckIndex: reader.deckIndex(), slotIndexFrom: reader.byte(), slotIndexTo: reader.byte() };
      case 1602:
        return { deckIndex: reader.deckIndex(), leaderSlotIndex: reader.sbyte() };
      case 1604:
        return { deckType: reader.int() };
      case 1606:
        return { deckIndex: reader.deckIndex(), slotIndex: reader.byte(), unitUID: reader.long() };
      case 1608:
        return { deckIndex: reader.deckIndex(), unitUIDList: reader.longList(), shipUID: reader.long(), operatorUid: reader.long() };
      case 1610:
        return { deckIndex: reader.deckIndex(), shipUID: reader.long() };
      case 1612:
        return { deckIndex: reader.deckIndex(), operatorUid: reader.long() };
      case 1652:
        return { deckIndex: reader.deckIndex(), name: reader.string() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[deck:${packetId}] request decode failed: ${err.message}`);
    return { deckIndex: { deckType: 1, index: 0 } };
  }
}

function createReader(payload) {
  let offset = 0;
  return {
    byte() {
      const read = readByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    sbyte() {
      const read = readSByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    int() {
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    },
    long() {
      const read = readSignedVarLong(payload, offset);
      offset = read.offset;
      return read.value;
    },
    longList() {
      const read = readSignedVarLongList(payload, offset);
      offset = read.offset;
      return read.value;
    },
    bool() {
      const read = readBool(payload, offset);
      offset = read.offset;
      return read.value;
    },
    deckIndex() {
      if (!this.bool()) return { deckType: 0, index: 0 };
      return { deckType: this.int(), index: this.byte() };
    },
    string() {
      const read = readString(payload, offset);
      offset = read.offset;
      return read.value;
    },
  };
}

function writeDeckIndex(deckIndex) {
  return writeNullableObject(buildDeckIndexData(deckIndex || { deckType: 0, index: 0 }));
}

function writeNullableDeck(deck) {
  return writeNullableObject(buildDeckData(deck));
}

function writeNullMiscItem() {
  return writeNullObject();
}

function describeDeckRequest(packetId, request = {}) {
  switch (packetId) {
    case 1600:
      return `${formatDeckIndex(request.deckIndex)} swap ${request.slotIndexFrom}->${request.slotIndexTo}`;
    case 1602:
      return `${formatDeckIndex(request.deckIndex)} leader=${request.leaderSlotIndex}`;
    case 1604:
      return `unlock deckType=${Number(request.deckType || 0)}`;
    case 1606:
      return `${formatDeckIndex(request.deckIndex)} set slot=${request.slotIndex} unitUID=${String(request.unitUID || 0)}`;
    case 1608:
      return `${formatDeckIndex(request.deckIndex)} auto units=${(request.unitUIDList || []).length} shipUID=${String(
        request.shipUID || 0
      )} operatorUid=${String(request.operatorUid || 0)}`;
    case 1610:
      return `${formatDeckIndex(request.deckIndex)} shipUID=${String(request.shipUID || 0)}`;
    case 1612:
      return `${formatDeckIndex(request.deckIndex)} operatorUid=${String(request.operatorUid || 0)}`;
    case 1652:
      return `${formatDeckIndex(request.deckIndex)} name=${JSON.stringify(request.name || "")}`;
    default:
      return "request";
  }
}

function formatDeckIndex(deckIndex = {}) {
  return `deckType=${Number(deckIndex.deckType || 0)} index=${Number(deckIndex.index || 0)}`;
}

module.exports = {
  createDeckPipelineHandlers,
};
