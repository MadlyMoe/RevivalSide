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
  buildItemMiscData,
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
  ensureArmy,
  swapDeckUnits,
  setDeckLeader,
  unlockDeck,
  setDeckUnit,
  autoSetDeck,
  setDeckShip,
  setDeckOperator,
  updateDeckName,
} = require("../unit");
const { getMiscItem, spendMiscItem } = require("../inventory");

const DECK_PACKET_IDS = [1600, 1602, 1604, 1606, 1608, 1610, 1612, 1652];
const DECK_UNLOCK_ITEM_ID = 101;
const DECK_UNLOCK_COST = 600n;
const DECK_MAX_COUNTS = Object.freeze({ 1: 10, 2: 4, 3: 20, 4: 6, 5: 1, 6: 1, 8: 4 });
const DECK_ERRORS = Object.freeze({
  INVALID_INDEX: 54,
  INVALID_DATA: 55,
  INVALID_UNIT: 57,
  INVALID_TYPE: 62,
  MAX_UNLOCKED: 101,
  DUPLICATE_UNIT: 102,
  UNIT_UID: 131,
  SHIP_UID: 239,
  DECK_STATE: 449,
  OPERATOR_UID: 20700,
  NAME: 20928,
  INSUFFICIENT_RESOURCE: 109,
});

function createDeckPipelineHandlers() {
  return DECK_PACKET_IDS.map((packetId) => ({
    packetId,
    name: `DECK_PIPELINE_${packetId}`,
    handle(ctx, socket, packet) {
      const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
      if (socket.session) socket.session.user = user;
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildResponse(user, packetId, request);
      console.log(
        `[deck:${packetId}] ${describeDeckRequest(packetId, request)} ACK packetId=${response.packetId} error=${response.errorCode}`
      );
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      if (response.changed && ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
      return true;
    },
  }));
}

function buildResponse(user, packetId, req) {
  if (packetId !== 1604) {
    const deck = getExistingDeck(user, req.deckIndex);
    if (!deck) return buildErrorResponse(user, packetId, req, DECK_ERRORS.INVALID_INDEX);
    if (Number(deck.state || 0) !== 0) return buildErrorResponse(user, packetId, req, DECK_ERRORS.DECK_STATE);
    const errorCode = validateDeckRequest(user, deck, packetId, req);
    if (errorCode) return buildErrorResponse(user, packetId, req, errorCode);
  }

  switch (packetId) {
    case 1600: {
      const result = swapDeckUnits(user, req.deckIndex, req.slotIndexFrom, req.slotIndexTo);
      return {
        packetId: 1601,
        errorCode: 0,
        changed: result.slotIndexFrom !== result.slotIndexTo,
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
        errorCode: 0,
        changed: true,
        payload: Buffer.concat([writeSignedVarInt(0), writeDeckIndex(req.deckIndex), writeSByte(deck.leaderIndex)]),
      };
    }
    case 1604: {
      const type = Number(req.deckType);
      const maxCount = DECK_MAX_COUNTS[type] || 0;
      if (!maxCount) return buildErrorResponse(user, packetId, req, DECK_ERRORS.INVALID_TYPE);
      const army = ensureArmy(user);
      const currentCount = army.deckSets[String(type)].length;
      if (currentCount >= maxCount) return buildErrorResponse(user, packetId, req, DECK_ERRORS.MAX_UNLOCKED);
      const balance = getMiscItem(user, DECK_UNLOCK_ITEM_ID);
      if (toBigInt(balance && balance.countFree) + toBigInt(balance && balance.countPaid) < DECK_UNLOCK_COST) {
        return buildErrorResponse(user, packetId, req, DECK_ERRORS.INSUFFICIENT_RESOURCE);
      }
      const costItem = spendMiscItem(user, DECK_UNLOCK_ITEM_ID, DECK_UNLOCK_COST);
      const unlockedDeckSize = unlockDeck(user, req.deckType);
      return {
        packetId: 1605,
        errorCode: 0,
        changed: true,
        payload: Buffer.concat([
          writeSignedVarInt(0),
          writeSignedVarInt(Number(req.deckType || 0) || 0),
          writeByte(unlockedDeckSize),
          writeNullableObject(buildItemMiscData(costItem)),
        ]),
      };
    }
    case 1606: {
      const result = setDeckUnit(user, req.deckIndex, req.slotIndex, req.unitUID);
      return {
        packetId: 1607,
        errorCode: 0,
        changed: true,
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
        errorCode: 0,
        changed: true,
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
        errorCode: 0,
        changed: true,
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
        errorCode: 0,
        changed: true,
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
        errorCode: 0,
        changed: true,
        payload: Buffer.concat([writeSignedVarInt(0), writeDeckIndex(req.deckIndex), writeString(deck.name || "")]),
      };
    }
    default:
      return { packetId: packetId + 1, errorCode: DECK_ERRORS.INVALID_DATA, changed: false, payload: writeSignedVarInt(DECK_ERRORS.INVALID_DATA) };
  }
}

function getExistingDeck(user, deckIndex) {
  const type = Number(deckIndex && deckIndex.deckType);
  const index = Number(deckIndex && deckIndex.index);
  if (!Number.isInteger(type) || type <= 0 || type > 10 || !Number.isInteger(index) || index < 0) return null;
  const decks = ensureArmy(user).deckSets[String(type)];
  return Array.isArray(decks) && index < decks.length ? decks[index] : null;
}

function validateDeckRequest(user, deck, packetId, req) {
  const army = ensureArmy(user);
  const slotCount = deck.unitUids.length;
  if (packetId === 1600 && (!isSlot(req.slotIndexFrom, slotCount) || !isSlot(req.slotIndexTo, slotCount))) {
    return DECK_ERRORS.INVALID_DATA;
  }
  if (packetId === 1602) {
    if (!isSlot(req.leaderSlotIndex, slotCount)) return DECK_ERRORS.INVALID_DATA;
    if (toBigInt(deck.unitUids[req.leaderSlotIndex] || 0) <= 0n) return DECK_ERRORS.INVALID_UNIT;
  }
  if (packetId === 1606) {
    if (!isSlot(req.slotIndex, slotCount)) return DECK_ERRORS.INVALID_DATA;
    if (toBigInt(req.unitUID || 0) > 0n && !army.units[String(toBigInt(req.unitUID))]) return DECK_ERRORS.UNIT_UID;
  }
  if (packetId === 1608) {
    if (!Array.isArray(req.unitUIDList) || req.unitUIDList.length > slotCount) return DECK_ERRORS.INVALID_DATA;
    const unitUids = req.unitUIDList.filter((uid) => toBigInt(uid || 0) > 0n).map((uid) => String(toBigInt(uid)));
    if (new Set(unitUids).size !== unitUids.length) return DECK_ERRORS.DUPLICATE_UNIT;
    if (unitUids.some((uid) => !army.units[uid])) return DECK_ERRORS.UNIT_UID;
    if (toBigInt(req.shipUID || 0) > 0n && !army.ships[String(toBigInt(req.shipUID))]) return DECK_ERRORS.SHIP_UID;
    if (toBigInt(req.operatorUid || 0) > 0n && !army.operators[String(toBigInt(req.operatorUid))]) {
      return DECK_ERRORS.OPERATOR_UID;
    }
  }
  if (packetId === 1610 && toBigInt(req.shipUID || 0) > 0n && !army.ships[String(toBigInt(req.shipUID))]) {
    return DECK_ERRORS.SHIP_UID;
  }
  if (packetId === 1612 && toBigInt(req.operatorUid || 0) > 0n && !army.operators[String(toBigInt(req.operatorUid))]) {
    return DECK_ERRORS.OPERATOR_UID;
  }
  if (packetId === 1652) {
    const name = String(req.name == null ? "" : req.name);
    if (name.length > 32 || /[\r\n\u0000-\u001f]/.test(name)) return DECK_ERRORS.NAME;
  }
  return 0;
}

function isSlot(value, length) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 0 && slot < length;
}

function buildErrorResponse(user, packetId, req, errorCode) {
  const deckIndex = req.deckIndex || { deckType: 0, index: 0 };
  const none = { deckType: 0, index: 0 };
  const common = { packetId: packetId + 1, errorCode, changed: false };
  switch (packetId) {
    case 1600:
      return { ...common, payload: Buffer.concat([
        writeSignedVarInt(errorCode), writeDeckIndex(deckIndex), writeSByte(-1), writeByte(req.slotIndexFrom || 0),
        writeByte(req.slotIndexTo || 0), writeSignedVarLong(0n), writeSignedVarLong(0n),
      ]) };
    case 1602:
      return { ...common, payload: Buffer.concat([writeSignedVarInt(errorCode), writeDeckIndex(deckIndex), writeSByte(-1)]) };
    case 1604: {
      const type = Number(req.deckType || 0);
      const decks = type > 0 && type <= 10 ? ensureArmy(user).deckSets[String(type)] : null;
      return { ...common, payload: Buffer.concat([
        writeSignedVarInt(errorCode), writeSignedVarInt(type), writeByte(Array.isArray(decks) ? decks.length : 0), writeNullMiscItem(),
      ]) };
    }
    case 1606:
      return { ...common, payload: Buffer.concat([
        writeSignedVarInt(errorCode), writeDeckIndex(deckIndex), writeByte(req.slotIndex || 0), writeSignedVarLong(0n),
        writeDeckIndex(none), writeSByte(-1), writeSByte(-1), writeSByte(-1),
      ]) };
    case 1608:
      return { ...common, payload: Buffer.concat([writeDeckIndex(deckIndex), writeSignedVarInt(errorCode), writeNullObject()]) };
    case 1610:
      return { ...common, payload: Buffer.concat([
        writeSignedVarInt(errorCode), writeDeckIndex(deckIndex), writeDeckIndex(none), writeSignedVarLong(0n),
      ]) };
    case 1612:
      return { ...common, payload: Buffer.concat([
        writeSignedVarInt(errorCode), writeDeckIndex(deckIndex), writeSignedVarLong(0n), writeDeckIndex(none),
      ]) };
    case 1652:
      return { ...common, payload: Buffer.concat([writeSignedVarInt(errorCode), writeDeckIndex(deckIndex), writeString("")]) };
    default:
      return { ...common, payload: writeSignedVarInt(errorCode) };
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
