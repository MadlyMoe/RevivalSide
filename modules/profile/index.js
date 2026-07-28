const {
  writeString,
  writeBool,
  writeByte,
  writeSByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeNullableObjectList,
  writeIntList,
  readSignedVarInt,
  readSignedVarLong,
  readBool,
  readByte,
  readSByte,
  readString,
  buildEquipProfileInfoData,
  toBigInt,
} = require("../packet-codec");
const { getMiscItem } = require("../inventory");
const { ensureArmy, ensureDeck } = require("../unit");
const { getEquipItems } = require("../equipment");
const { buildSupportUnitData: buildPersistedSupportUnitData, ensureSupportUnit } = require("../combat-roster");
const {
  ensureAccountProgress,
  getAchievePoint,
  setProfileEmblem,
  setProfileFrame,
  setProfileIntro,
  setProfileMainUnit,
  setProfileTitle,
} = require("../account-progression");

const PROFILE_PACKET_NAMES = Object.freeze({
  226: "ACCOUNT_UPDATE_BIRTHDAY_REQ",
  420: "FRIEND_PROFILE_MODIFY_MAIN_CHAR_REQ",
  422: "FRIEND_PROFILE_MODIFY_INTRO_REQ",
  424: "FRIEND_PROFILE_MODIFY_DECK_REQ",
  426: "SET_EMBLEM_REQ",
  428: "USER_PROFILE_INFO_REQ",
  429: "USER_PROFILE_BY_FRIEND_CODE_REQ",
  451: "MY_USER_PROFILE_INFO_REQ",
  467: "USER_PROFILE_CHANGE_FRAME_REQ",
  495: "UPDATE_TITLE_REQ",
  3200: "LEADERBOARD_ACHIEVE_LIST_REQ",
});
const NEC_DB_FAIL_USER_DATA = 1;

function createProfileHandlers() {
  return Object.keys(PROFILE_PACKET_NAMES).map((packetIdText) => {
    const packetId = Number(packetIdText);
    return {
      packetId,
      name: PROFILE_PACKET_NAMES[packetId],
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeRequest(ctx, packetId, packet.payload);
        const response = buildResponse(ctx, user, packetId, req);
        console.log(`[profile:${PROFILE_PACKET_NAMES[packetId]}] ACK packetId=${response.packetId} ${response.log || ""}`.trim());
        ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
          ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
        );
        persistUserDb(ctx, response);
        return true;
      },
    };
  });
}

function buildResponse(ctx, user, packetId, req) {
  ensureAccountProgress(user);
  switch (packetId) {
    case 226: {
      if (!isValidBirthDayDate(req.birthDay)) {
        return ack(
          227,
          Buffer.concat([writeSignedVarInt(NEC_DB_FAIL_USER_DATA), writeNullObject()]),
          "invalid-birthday",
          false
        );
      }
      const birthDay = setBirthday(user, req.birthDay);
      return ack(
        227,
        Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildBirthDayDateData(birthDay))]),
        `birthday=${birthDay.month}/${birthDay.day}`
      );
    }
    case 420: {
      setProfileMainUnit(user, req.mainCharId, req.mainCharSkinId, findTacticLevel(user, req.mainCharId));
      return ack(
        421,
        Buffer.concat([
          writeSignedVarInt(0),
          writeSignedVarInt(Number(user.mainUnitId || 0)),
          writeSignedVarInt(Number(user.mainUnitSkinId || 0)),
          writeSignedVarInt(Number(user.mainUnitTacticLevel || 0)),
        ]),
        `mainUnit=${user.mainUnitId} skin=${user.mainUnitSkinId}`
      );
    }
    case 422: {
      setProfileIntro(user, req.intro);
      return ack(423, Buffer.concat([writeSignedVarInt(0), writeString(user.friendIntro || "")]), `introLen=${String(user.friendIntro || "").length}`);
    }
    case 424: {
      user.profileDeckIndex = normalizeDeckIndex(req.deckIndex);
      return ack(
        425,
        Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildDummyDeckData(user, user.profileDeckIndex))]),
        `deckType=${user.profileDeckIndex.deckType} index=${user.profileDeckIndex.index}`
      );
    }
    case 426: {
      const count = getEmblemCount(user, req.itemId);
      const emblem = setProfileEmblem(user, req.index, req.itemId, count);
      return ack(
        427,
        Buffer.concat([
          writeSignedVarInt(0),
          writeSByte(emblem.index),
          writeSignedVarInt(emblem.itemId),
          writeSignedVarLong(toBigInt(emblem.count || 0)),
        ]),
        `slot=${emblem.index} item=${emblem.itemId}`
      );
    }
    case 428:
    case 429:
      return ack(
        430,
        Buffer.concat([
          writeSignedVarInt(0),
          writeNullableObject(buildUserProfileData(user)),
          writeNullableObject(buildSupportUnitData(user)),
        ]),
        "profile"
      );
    case 451:
      return ack(452, Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildUserProfileData(user))]), "self");
    case 467:
      setProfileFrame(user, req.selfiFrameId);
      return ack(468, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(user.selfiFrameId || 0)]), `frame=${user.selfiFrameId || 0}`);
    case 495:
      setProfileTitle(user, req.titleId);
      return ack(496, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(user.titleId || 0)]), `title=${user.titleId || 0}`);
    case 3200:
      return ack(
        3201,
        Buffer.concat([
          writeSignedVarInt(0),
          writeNullableObject(buildLeaderBoardAchieveData(user)),
          writeSignedVarInt(1),
          writeBool(Boolean(req.isAll)),
        ]),
        `achievePoint=${getAchievePoint(user).toString()}`,
        false
      );
    default:
      return ack(packetId + 1, writeSignedVarInt(0));
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
      case 420:
        return { mainCharId: reader.int(), mainCharSkinId: reader.int() };
      case 422:
        return { intro: reader.string() };
      case 424:
        return { deckIndex: reader.deckIndex() };
      case 426:
        return { index: reader.sbyte(), itemId: reader.int() };
      case 428:
        return { userUid: reader.long(), deckType: reader.int() };
      case 429:
        return { friendCode: reader.long() };
      case 467:
        return { selfiFrameId: reader.int() };
      case 495:
        return { titleId: reader.int() };
      case 3200:
        return { isAll: reader.bool() };
      case 226:
        return { birthDay: reader.birthDayDate() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[profile:${PROFILE_PACKET_NAMES[packetId] || packetId}] request decode failed: ${err.message}`);
    return {};
  }
}

function buildUserProfileData(user) {
  ensureAccountProgress(user);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeString(String(user.friendIntro || "")),
    writeNullableObject(buildPvpProfileData()),
    writeNullableObject(buildPvpProfileData()),
    writeNullableObject(buildPvpProfileData()),
    user.profileDeckIndex ? writeNullableObject(buildDummyDeckData(user, user.profileDeckIndex)) : writeNullObject(),
    writeNullObject(),
    writeNullableObject(buildAsyncDeckData(user)),
    writeNullableObjectList((user.profileEmblems || []).map(buildEmblemData)),
    writeSignedVarInt(Number(user.selfiFrameId || user.frameId || 0) || 0),
    writeNullableObject(buildGuildSimpleData()),
    writeBool(Boolean(user.hasOffice || user.office)),
    writeSignedVarInt(0),
  ]);
}

function buildCommonProfileData(user) {
  ensureAccountProgress(user);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeSignedVarLong(toBigInt(user.friendCode || 0)),
    writeString(user.nickname || "LocalAdmin"),
    writeSignedVarInt(Number(user.level || 1) || 1),
    writeSignedVarInt(Number(user.mainUnitId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitSkinId || 0) || 0),
    writeSignedVarInt(Number(user.frameId || user.selfiFrameId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitTacticLevel || 0) || 0),
    writeSignedVarInt(Number(user.titleId || 0) || 0),
  ]);
}

function buildEmblemData(emblem) {
  return Buffer.concat([
    writeSignedVarInt(Number(emblem && emblem.id) || 0),
    writeSignedVarLong(toBigInt(emblem && emblem.count != null ? emblem.count : 0)),
  ]);
}

function buildPvpProfileData() {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeSignedVarInt(0)]);
}

function buildDummyDeckData(user, deckIndex) {
  const army = ensureArmy(user);
  const normalized = normalizeDeckIndex(deckIndex);
  const deck = ensureDeck(user, normalized);
  const ship = army.ships[String(toBigInt(deck.shipUid || 0))] || null;
  const operator = army.operators[String(toBigInt(deck.operatorUid || 0))] || null;
  const units = (deck.unitUids || []).slice(0, 8).map((uid) => army.units[String(toBigInt(uid || 0))] || null);
  while (units.length < 8) units.push(null);

  return Buffer.concat([
    writeSByte(Number(deck.leaderIndex != null ? deck.leaderIndex : -1)),
    ship ? writeNullableObject(buildDummyUnitData(ship)) : writeNullObject(),
    operator ? writeNullableObject(buildDummyUnitData(operator)) : writeNullObject(),
    writeObjectList(units.map((unit) => (unit ? writeNullableObject(buildDummyUnitData(unit)) : writeNullObject()))),
  ]);
}

function buildDummyUnitData(unit) {
  return Buffer.concat([
    writeSignedVarInt(Number(unit.unitId || unit.id || 0) || 0),
    writeSignedVarInt(Number(unit.level || 1) || 1),
    writeSignedVarInt(Number(unit.skinId || 0) || 0),
    writeSignedVarInt(Number(unit.limitBreakLevel || 0) || 0),
    writeSignedVarInt(Number(unit.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(unit.reactorLevel || 0) || 0),
  ]);
}

function buildAsyncDeckData(user) {
  const profileDeck = user.profileDeckIndex ? ensureDeck(user, user.profileDeckIndex) : null;
  return Buffer.concat([
    writeSignedVarInt(profileDeck ? Number(profileDeck.leaderIndex || 0) : 0),
    writeNullableObject(buildAsyncUnitData(null)),
    writeObjectList([]),
    writeObjectList([]),
    writeSignedVarInt(0),
    writeNullObject(),
    writeNullableObject(buildAsyncUnitData(null)),
    writeObjectList([]),
    writeObjectList([]),
  ]);
}

function buildAsyncUnitData(unit) {
  const equipUids = unit && Array.isArray(unit.equipItemUids) ? unit.equipItemUids : [];
  const equipMap = new Map(getEquipItems({ army: {}, inventory: {} }).map((equip) => [String(toBigInt(equip.equipUid || 0)), equip]));
  return Buffer.concat([
    writeSignedVarLong(toBigInt(unit && unit.unitUid ? unit.unitUid : 0)),
    writeSignedVarInt(Number(unit && unit.unitId) || 0),
    writeSignedVarInt(Number(unit && unit.level) || 0),
    writeSignedVarInt(Number(unit && unit.skinId) || 0),
    writeSignedVarInt(Number(unit && unit.limitBreakLevel) || 0),
    writeIntList(unit && unit.skillLevels ? unit.skillLevels : []),
    writeIntList([]),
    writeObjectList(equipUids.map((uid) => writeNullableObject(buildEquipProfileInfoData(equipMap.get(String(toBigInt(uid || 0))))))),
    writeObjectList([]),
    writeSignedVarInt(Number(unit && unit.tacticLevel) || 0),
    writeSignedVarInt(Number(unit && unit.reactorLevel) || 0),
  ]);
}

function buildSupportUnitData(user) {
  const supportUnit = ensureSupportUnit(user);
  if (supportUnit) return buildPersistedSupportUnitData(user, supportUnit);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeNullableObject(Buffer.concat([writeNullableObject(buildAsyncUnitData(null)), writeObjectList([])])),
    writeSignedVarLong(0n),
  ]);
}

function buildGuildSimpleData() {
  return Buffer.concat([writeSignedVarLong(0n), writeString(""), writeSignedVarLong(0n)]);
}

function buildLeaderBoardAchieveData(user) {
  return writeNullableObjectList([buildAchieveData(user)]);
}

function buildAchieveData(user) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeSignedVarLong(getAchievePoint(user)),
    writeNullableObject(buildGuildSimpleData()),
  ]);
}

function findTacticLevel(user, unitId) {
  const army = ensureArmy(user);
  const id = Number(unitId || 0);
  const unit = Object.values(army.units || {}).find((entry) => Number(entry && entry.unitId) === id);
  return Number(unit && unit.tacticLevel) || 0;
}

function getEmblemCount(user, itemId) {
  const item = getMiscItem(user, itemId);
  return toBigInt(item && (item.countFree || item.count || 0), 0n) + toBigInt(item && item.countPaid, 0n);
}

function normalizeDeckIndex(deckIndex) {
  const data = deckIndex && typeof deckIndex === "object" ? deckIndex : {};
  return {
    deckType: Number(data.deckType != null ? data.deckType : data.m_eDeckType || 1) || 1,
    index: Number(data.index != null ? data.index : data.m_iIndex || 0) || 0,
  };
}

function createReader(payload) {
  let offset = 0;
  return {
    bool() {
      const read = readBool(payload, offset);
      offset = read.offset;
      return read.value;
    },
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
    string() {
      const read = readString(payload, offset);
      offset = read.offset;
      return read.value;
    },
    deckIndex() {
      if (!this.bool()) return { deckType: 1, index: 0 };
      return { deckType: this.int(), index: this.byte() };
    },
    birthDayDate() {
      if (!this.bool()) return null;
      return { month: this.int(), day: this.int() };
    },
  };
}

function setBirthday(user, birthDay) {
  const normalized = normalizeBirthDayDate(birthDay);
  const existing = normalizeUserBirthDayData(user && user.birthDayData);
  user.birthDayData = {
    birthDay: normalized,
    years: existing ? existing.years : 0,
  };
  user.profileUpdatedAt = new Date().toISOString();
  return normalized;
}

function isValidBirthDayDate(value) {
  if (!value || typeof value !== "object") return false;
  const month = Number(value.month != null ? value.month : value.Month);
  const day = Number(value.day != null ? value.day : value.Day);
  return Number.isFinite(month) && Number.isFinite(day) && month >= 1 && month <= 12 && day >= 1 && day <= getMaxBirthdayDay(Math.trunc(month));
}

function normalizeUserBirthDayData(data) {
  if (!data || typeof data !== "object") return null;
  const birthDay = normalizeBirthDayDate(data.birthDay || data.BirthDay || data);
  return {
    birthDay,
    years: Math.max(0, Number(data.years != null ? data.years : data.Years || 0) || 0),
  };
}

function normalizeBirthDayDate(value) {
  const data = value && typeof value === "object" ? value : {};
  const month = Math.max(1, Math.min(12, Math.trunc(Number(data.month != null ? data.month : data.Month || 1) || 1)));
  const day = Math.max(1, Math.min(getMaxBirthdayDay(month), Math.trunc(Number(data.day != null ? data.day : data.Day || 1) || 1)));
  return { month, day };
}

function getMaxBirthdayDay(month) {
  if (month === 2) return 29;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function buildBirthDayDateData(birthDay) {
  const data = normalizeBirthDayDate(birthDay);
  return Buffer.concat([writeSignedVarInt(data.month), writeSignedVarInt(data.day)]);
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function persistUserDb(ctx, response = {}) {
  if (response.persist === false) return;
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache("profile-update");
}

function ack(packetId, payload, log = "", persist = true) {
  return { packetId, payload, log, persist };
}

module.exports = {
  createProfileHandlers,
  buildUserProfileData,
  buildCommonProfileData,
  buildSupportUnitData,
  buildDummyDeckData,
};
