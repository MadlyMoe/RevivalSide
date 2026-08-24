"use strict";

const { readSignedVarInt, readSignedVarLong } = require("../packet-codec");

function decodeGameLoadRequest(payload, decryptCopy = identity) {
  try {
    const decrypted = decryptCopy(Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []));
    let offset = 0;
    const isDevValue = decrypted.readUInt8(offset++);
    if (isDevValue !== 0 && isDevValue !== 1) return null;
    const selectDeckIndex = decrypted.readUInt8(offset++);
    const stageID = readSignedVarInt(decrypted, offset);
    offset = stageID.offset;
    const diveStageID = readSignedVarInt(decrypted, offset);
    offset = diveStageID.offset;
    const dungeonID = readSignedVarInt(decrypted, offset);
    offset = dungeonID.offset;
    const palaceID = readSignedVarInt(decrypted, offset);
    offset = palaceID.offset;
    const fierceBossId = readSignedVarInt(decrypted, offset);
    offset = fierceBossId.offset;
    const exploreID = readSignedVarInt(decrypted, offset);
    offset = exploreID.offset;
    const supportingUserUid = readSignedVarLong(decrypted, offset);
    offset = supportingUserUid.offset;
    const hasEventDeckDataValue = decrypted.readUInt8(offset++);
    if (hasEventDeckDataValue !== 0 && hasEventDeckDataValue !== 1) return null;
    let eventDeckData = null;
    if (hasEventDeckDataValue === 1) {
      const parsed = readEventDeckData(decrypted, offset);
      eventDeckData = parsed.value;
      offset = parsed.offset;
    }
    const rewardMultiply = readSignedVarInt(decrypted, offset);
    offset = rewardMultiply.offset;
    if (
      offset !== decrypted.length ||
      stageID.value < 0 ||
      diveStageID.value < 0 ||
      dungeonID.value < 0 ||
      palaceID.value < 0 ||
      fierceBossId.value < 0 ||
      exploreID.value < 0 ||
      supportingUserUid.value < 0n ||
      rewardMultiply.value < 0
    ) {
      return null;
    }
    return {
      isDev: isDevValue === 1,
      selectDeckIndex,
      stageID: stageID.value,
      diveStageID: diveStageID.value,
      dungeonID: dungeonID.value,
      palaceID: palaceID.value,
      fierceBossId: fierceBossId.value,
      exploreID: exploreID.value,
      supportingUserUid: supportingUserUid.value,
      hasEventDeckData: hasEventDeckDataValue === 1,
      eventDeckData,
      rewardMultiply: rewardMultiply.value,
    };
  } catch (_) {
    return null;
  }
}

function readEventDeckData(buffer, offset) {
  const shipUid = readSignedVarLong(buffer, offset);
  const unitMap = readUnitMap(buffer, shipUid.offset);
  const operatorUid = readSignedVarLong(buffer, unitMap.offset);
  const leaderIndex = readSignedVarInt(buffer, operatorUid.offset);
  if (shipUid.value < 0n || operatorUid.value < 0n || leaderIndex.value < -1 || leaderIndex.value >= 8) {
    throw new Error("invalid event deck identity");
  }
  return {
    value: {
      shipUid: shipUid.value,
      units: unitMap.value,
      operatorUid: operatorUid.value,
      leaderIndex: leaderIndex.value,
    },
    offset: leaderIndex.offset,
  };
}

function readUnitMap(buffer, offset) {
  const count = readUnsignedVarInt(buffer, offset);
  if (count.value > 8) throw new Error("event deck unit count exceeds eight");
  offset = count.offset;
  const entries = {};
  for (let index = 0; index < count.value; index += 1) {
    const key = readSignedVarInt(buffer, offset);
    const value = readSignedVarLong(buffer, key.offset);
    offset = value.offset;
    if (key.value < 0 || key.value >= 8 || value.value < 0n || Object.prototype.hasOwnProperty.call(entries, key.value)) {
      throw new Error("invalid event deck unit entry");
    }
    entries[key.value] = value.value;
  }
  return { value: entries, offset };
}

function readUnsignedVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  while (shift < 35) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer.readUInt8(offset++);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function identity(value) {
  return value;
}

module.exports = { decodeGameLoadRequest };
