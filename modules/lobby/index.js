const {
  writeBool,
  writeFloatLE,
  writeNullableObject,
  writeNullableObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  buildItemMiscData,
  toBigInt,
} = require("../packet-codec");
const { applyInventoryExpansion } = require("../inventory-capacity");
const { getMiscItem } = require("../inventory");
const { getArmyUnits, getArmyShips, getArmyTrophies, getArmyOperators } = require("../unit");
const { readGameplayTableRecords } = require("../gameplay-jsons");

const GAME_OPTION_PLAY_CUTSCENE_REQ = 1634;
const GAME_OPTION_PLAY_CUTSCENE_ACK = 1635;
const INVENTORY_EXPAND_REQ = 1638;
const INVENTORY_EXPAND_ACK = 1639;
const BACKGROUND_CHANGE_REQ = 1646;
const BACKGROUND_CHANGE_ACK = 1647;
const UPDATE_PVP_INVITATION_OPTION_REQ = 1654;
const UPDATE_PVP_INVITATION_OPTION_ACK = 1655;
const JUKEBOX_CHANGE_BGM_REQ = 1660;
const JUKEBOX_CHANGE_BGM_ACK = 1661;
const MAX_BACKGROUND_UNIT_SLOTS = 8;
const JUKEBOX_CHANGE_COOLDOWN_MS = 1000;

const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  UNKNOWN_EXPAND_TYPE: 333,
  CANNOT_EXPAND_INVENTORY: 334,
  INVALID_REQUEST: 20190,
  INVALID_BACKGROUND_INFO: 21072,
  JUKEBOX_CHANGE_COOLDOWN: 26602,
});

let lobbyCatalog;

function createLobbyCustomizationHandlers() {
  return [
    {
      packetId: GAME_OPTION_PLAY_CUTSCENE_REQ,
      name: "GAME_OPTION_PLAY_CUTSCENE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodePlayCutsceneReq(ctx, packet.payload);
        user.options = user.options && typeof user.options === "object" ? user.options : {};
        if (req.valid) user.options.playCutscene = req.isPlayCutscene;
        const isPlayCutscene = Boolean(user.options.playCutscene);
        const errorCode = req.valid ? ERROR_CODES.OK : ERROR_CODES.INVALID_REQUEST;
        const payload = Buffer.concat([writeSignedVarInt(errorCode), writeBool(isPlayCutscene)]);
        console.log(
          `[lobby:GAME_OPTION_PLAY_CUTSCENE_REQ] ACK packetId=${GAME_OPTION_PLAY_CUTSCENE_ACK} play=${isPlayCutscene ? 1 : 0} error=${errorCode}`
        );
        ctx.sendGameResponse(socket, packet, GAME_OPTION_PLAY_CUTSCENE_ACK, payload, "game-option-play-cutscene");
        if (errorCode === ERROR_CODES.OK) saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: INVENTORY_EXPAND_REQ,
      name: "INVENTORY_EXPAND_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeInventoryExpandReq(ctx, packet.payload);
        const result = req.valid
          ? applyInventoryExpansion(user, req.inventoryType, req.count)
          : {
            errorCode: ERROR_CODES.INVALID_REQUEST,
            inventoryType: req.inventoryType,
            expandedCount: 0,
            costItems: [],
          };
        const payload = Buffer.concat([
          writeSignedVarInt(result.errorCode),
          writeSignedVarInt(result.inventoryType),
          writeSignedVarInt(result.expandedCount),
          writeNullableObjectList(result.costItems.map(buildItemMiscData)),
        ]);
        console.log(
          `[lobby:INVENTORY_EXPAND_REQ] ACK packetId=${INVENTORY_EXPAND_ACK} type=${req.inventoryType} count=${req.count} expanded=${result.expandedCount} error=${result.errorCode} costs=${result.costItems.length}`
        );
        ctx.sendGameResponse(socket, packet, INVENTORY_EXPAND_ACK, payload, "inventory-expand");
        if (result.errorCode === ERROR_CODES.OK) saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: BACKGROUND_CHANGE_REQ,
      name: "BACKGROUND_CHANGE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeBackgroundChangeReq(ctx, packet.payload);
        const errorCode = req.valid && isValidBackgroundInfo(user, req.backgroundInfo)
          ? ERROR_CODES.OK
          : ERROR_CODES.INVALID_BACKGROUND_INFO;
        if (errorCode === ERROR_CODES.OK) setBackgroundInfo(user, req.backgroundInfo);
        const payload = Buffer.concat([writeSignedVarInt(errorCode), writeNullableObject(buildBackgroundInfoData(user))]);
        console.log(
          `[lobby:BACKGROUND_CHANGE_REQ] ACK packetId=${BACKGROUND_CHANGE_ACK} bg=${
            getBackgroundInfo(user).backgroundItemId
          } bgm=${getBackgroundInfo(user).backgroundBgmId} units=${getBackgroundInfo(user).unitInfoList.length} error=${errorCode}`
        );
        ctx.sendGameResponse(socket, packet, BACKGROUND_CHANGE_ACK, payload, "background-change");
        if (errorCode === ERROR_CODES.OK) saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: UPDATE_PVP_INVITATION_OPTION_REQ,
      name: "UPDATE_PVP_INVITATION_OPTION_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodePvpInvitationOptionReq(ctx, packet.payload);
        user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
        const errorCode = req.valid && req.value >= 0 && req.value <= 3 ? ERROR_CODES.OK : ERROR_CODES.INVALID_REQUEST;
        if (errorCode === ERROR_CODES.OK) user.pvp.invitationOption = req.value;
        const value = clampInt(user.pvp.invitationOption, 0, 3, 0);
        const payload = Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarInt(value)]);
        console.log(
          `[lobby:UPDATE_PVP_INVITATION_OPTION_REQ] ACK packetId=${UPDATE_PVP_INVITATION_OPTION_ACK} value=${value} error=${errorCode}`
        );
        ctx.sendGameResponse(socket, packet, UPDATE_PVP_INVITATION_OPTION_ACK, payload, "pvp-invitation-option");
        if (errorCode === ERROR_CODES.OK) saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: JUKEBOX_CHANGE_BGM_REQ,
      name: "JUKEBOX_CHANGE_BGM_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeJukeboxChangeBgmReq(ctx, packet.payload);
        const state = ensureLobbyCustomization(user);
        const now = getServerNow(ctx);
        const errorCode = !req.valid || !isValidJukeboxSelection(req.bgmType, req.bgmId)
          ? ERROR_CODES.INVALID_REQUEST
          : isJukeboxCooldownActive(state, now)
            ? ERROR_CODES.JUKEBOX_CHANGE_COOLDOWN
            : ERROR_CODES.OK;
        if (errorCode === ERROR_CODES.OK) setJukeboxBgm(user, req.bgmType, req.bgmId, now);

        const payload = Buffer.concat([writeSignedVarInt(errorCode), writeNullableObject(buildJukeboxData(user))]);
        console.log(
          `[lobby:JUKEBOX_CHANGE_BGM_REQ] ACK packetId=${JUKEBOX_CHANGE_BGM_ACK} type=${req.bgmType} bgm=${req.bgmId} error=${errorCode}`
        );
        ctx.sendGameResponse(socket, packet, JUKEBOX_CHANGE_BGM_ACK, payload, "jukebox-change-bgm");
        if (errorCode === ERROR_CODES.OK) saveIfLocal(ctx);
        return true;
      },
    },
  ];
}

function decodePlayCutsceneReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return { valid: true, isPlayCutscene: reader.bool() };
  } catch (err) {
    console.log(`[lobby:GAME_OPTION_PLAY_CUTSCENE_REQ] request decode failed: ${err.message}`);
    return { valid: false, isPlayCutscene: false };
  }
}

function decodeInventoryExpandReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  const reader = createReader(payload);
  try {
    const inventoryType = reader.int();
    const count = reader.int();
    return {
      valid: reader.done() && Buffer.concat([
        writeSignedVarInt(inventoryType),
        writeSignedVarInt(count),
      ]).equals(payload),
      inventoryType,
      count,
    };
  } catch (err) {
    console.log(`[lobby:INVENTORY_EXPAND_REQ] request decode failed: ${err.message}`);
    return { valid: false, inventoryType: 0, count: 0 };
  }
}

function decodePvpInvitationOptionReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return { valid: true, value: reader.int() };
  } catch (err) {
    console.log(`[lobby:UPDATE_PVP_INVITATION_OPTION_REQ] request decode failed: ${err.message}`);
    return { valid: false, value: 0 };
  }
}

function ensureLobbyCustomization(user) {
  if (!user || typeof user !== "object") return { backgroundInfo: defaultBackgroundInfo(), jukeboxBgmIds: {} };
  user.lobbyCustomization = user.lobbyCustomization && typeof user.lobbyCustomization === "object" ? user.lobbyCustomization : {};
  const state = user.lobbyCustomization;
  state.backgroundInfo = normalizeBackgroundInfo(state.backgroundInfo || user.backgroundInfo || user.backGroundInfo);
  state.jukeboxBgmIds = normalizeBgmMap(state.jukeboxBgmIds || user.jukeboxBgmIds || user.jukeboxData);
  state.jukeboxChangedAt = normalizeDate(state.jukeboxChangedAt);
  return state;
}

function hasLobbyCustomization(user) {
  if (!user || typeof user !== "object" || !user.lobbyCustomization) return false;
  const state = ensureLobbyCustomization(user);
  if (state.updatedAt) return true;
  const info = state.backgroundInfo;
  if (Number(info.backgroundItemId || 0) !== 0 || Number(info.backgroundBgmId || 0) !== 0) return true;
  if (info.unitInfoList.some((unit) => hasCustomizedBackgroundUnit(unit))) return true;
  return Object.keys(state.jukeboxBgmIds || {}).length > 0;
}

function getBackgroundInfo(user) {
  return ensureLobbyCustomization(user).backgroundInfo;
}

function setBackgroundInfo(user, backgroundInfo) {
  const state = ensureLobbyCustomization(user);
  state.backgroundInfo = normalizeBackgroundInfo(backgroundInfo);
  state.updatedAt = new Date().toISOString();
  return state.backgroundInfo;
}

function setJukeboxBgm(user, bgmType, bgmId, changedAt = new Date()) {
  const state = ensureLobbyCustomization(user);
  const type = nonNegativeInt(bgmType);
  const id = nonNegativeInt(bgmId);
  if (id > 0) {
    state.jukeboxBgmIds[String(type)] = id;
  } else {
    delete state.jukeboxBgmIds[String(type)];
  }
  state.jukeboxChangedAt = changedAt.toISOString();
  state.updatedAt = state.jukeboxChangedAt;
  return state.jukeboxBgmIds;
}

function buildBackgroundInfoData(source) {
  const info = source && isBackgroundInfoLike(source) ? normalizeBackgroundInfo(source) : getBackgroundInfo(source);
  return Buffer.concat([
    writeSignedVarInt(info.backgroundItemId),
    writeSignedVarInt(info.backgroundBgmId),
    writeNullableObjectList(info.unitInfoList.map(buildBackgroundUnitInfoData)),
  ]);
}

function buildBackgroundUnitInfoData(unit) {
  const data = normalizeBackgroundUnitInfo(unit);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid)),
    writeSignedVarInt(data.unitType),
    writeFloatLE(data.unitSize),
    writeSignedVarInt(data.unitFace),
    writeFloatLE(data.unitPosX),
    writeFloatLE(data.unitPosY),
    writeBool(data.backImage),
    writeSignedVarInt(data.skinOption),
    writeFloatLE(data.rotation),
    writeBool(data.flip),
    writeFloatLE(data.animTime),
  ]);
}

function buildJukeboxData(user) {
  const state = ensureLobbyCustomization(user);
  const entries = Object.entries(state.jukeboxBgmIds || {})
    .map(([type, id]) => [nonNegativeInt(type), nonNegativeInt(id)])
    .filter(([, id]) => id > 0)
    .sort((left, right) => left[0] - right[0]);
  return Buffer.concat([
    writeUnsignedVarInt(entries.length),
    ...entries.flatMap(([type, id]) => [writeSignedVarInt(type), writeSignedVarInt(id)]),
  ]);
}

function decodeBackgroundChangeReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return { valid: true, backgroundInfo: reader.nullableBackgroundInfo() };
  } catch (err) {
    console.log(`[lobby:BACKGROUND_CHANGE_REQ] request decode failed: ${err.message}`);
    return { valid: false, backgroundInfo: null };
  }
}

function decodeJukeboxChangeBgmReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return {
      valid: true,
      bgmType: reader.int(),
      bgmId: reader.int(),
    };
  } catch (err) {
    console.log(`[lobby:JUKEBOX_CHANGE_BGM_REQ] request decode failed: ${err.message}`);
    return { valid: false, bgmType: 0, bgmId: 0 };
  }
}

function decryptPayload(ctx, encryptedPayload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function createReader(payload) {
  let offset = 0;
  return {
    bool() {
      const read = readBool(payload, offset);
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
    float() {
      if (offset + 4 > payload.length) throw new Error("truncated float");
      const value = payload.readFloatLE(offset);
      offset += 4;
      return value;
    },
    uvar() {
      const read = readUnsignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    },
    nullableBackgroundInfo() {
      if (!this.bool()) return null;
      return this.backgroundInfo();
    },
    backgroundInfo() {
      return {
        backgroundItemId: this.int(),
        backgroundBgmId: this.int(),
        unitInfoList: this.backgroundUnitList(),
      };
    },
    backgroundUnitList() {
      const count = this.uvar();
      if (count > MAX_BACKGROUND_UNIT_SLOTS) throw new Error(`too many background units: ${count}`);
      const units = [];
      for (let index = 0; index < count; index += 1) {
        units.push(this.nullableBackgroundUnitInfo());
      }
      return units;
    },
    nullableBackgroundUnitInfo() {
      if (!this.bool()) return null;
      return this.backgroundUnitInfo();
    },
    backgroundUnitInfo() {
      return {
        unitUid: this.long().toString(),
        unitType: this.int(),
        unitSize: this.float(),
        unitFace: this.int(),
        unitPosX: this.float(),
        unitPosY: this.float(),
        backImage: this.bool(),
        skinOption: this.int(),
        rotation: this.float(),
        flip: this.bool(),
        animTime: this.float(),
      };
    },
    done() {
      return offset === payload.length;
    },
  };
}

function isValidBackgroundInfo(user, backgroundInfo) {
  if (!backgroundInfo || typeof backgroundInfo !== "object") return false;
  const backgroundItemId = Number(backgroundInfo.backgroundItemId);
  const backgroundBgmId = Number(backgroundInfo.backgroundBgmId);
  const units = backgroundInfo.unitInfoList;
  const catalog = getLobbyCatalog();
  if (!Number.isInteger(backgroundItemId) || backgroundItemId < 0) return false;
  if (backgroundItemId > 0 && (!catalog.backgroundIds.has(backgroundItemId) || !ownsBackground(user, backgroundItemId))) return false;
  if (!Number.isInteger(backgroundBgmId) || backgroundBgmId < 0) return false;
  if (backgroundBgmId > 0 && !catalog.bgmIds.has(backgroundBgmId)) return false;
  if (!Array.isArray(units) || units.length > MAX_BACKGROUND_UNIT_SLOTS) return false;

  const ownedUids = getOwnedBackgroundUnitUids(user);
  const seenUids = new Set();
  for (const unit of units) {
    if (!isValidBackgroundUnit(unit, ownedUids, seenUids)) return false;
  }
  return true;
}

function isValidBackgroundUnit(unit, ownedUids, seenUids) {
  if (!unit || typeof unit !== "object") return false;
  const uid = toBigInt(unit.unitUid, -1n);
  const unitType = Number(unit.unitType);
  if (uid < 0n || !Number.isInteger(unitType) || unitType < 2 || unitType > 4) return false;
  if (!Number.isFinite(Number(unit.unitSize)) || Number(unit.unitSize) <= 0) return false;
  if (!Number.isInteger(Number(unit.unitFace)) || Number(unit.unitFace) < 0) return false;
  if (!Number.isFinite(Number(unit.unitPosX)) || !Number.isFinite(Number(unit.unitPosY))) return false;
  if (!Number.isInteger(Number(unit.skinOption)) || Number(unit.skinOption) < 0) return false;
  if (!Number.isFinite(Number(unit.rotation)) || !Number.isFinite(Number(unit.animTime))) return false;
  if (uid === 0n) return true;

  const key = uid.toString();
  if (seenUids.has(key) || !ownedUids[unitType].has(key)) return false;
  seenUids.add(key);
  return true;
}

function getOwnedBackgroundUnitUids(user) {
  return {
    2: new Set([...getArmyUnits(user), ...getArmyTrophies(user)].map((unit) => String(toBigInt(unit.unitUid || unit.uid)))),
    3: new Set(getArmyShips(user).map((unit) => String(toBigInt(unit.unitUid || unit.uid)))),
    4: new Set(getArmyOperators(user).map((unit) => String(toBigInt(unit.uid || unit.operatorUid)))),
  };
}

function ownsBackground(user, backgroundItemId) {
  const item = getMiscItem(user, backgroundItemId);
  if (toBigInt(item && item.countFree) + toBigInt(item && item.countPaid) > 0n) return true;
  const interiors = user && user.office && Array.isArray(user.office.interiors) ? user.office.interiors : [];
  return interiors.some(
    (interior) => Number(interior && (interior.itemId || interior.id)) === backgroundItemId && toBigInt(interior.count) > 0n
  );
}

function isValidJukeboxSelection(bgmType, bgmId) {
  const type = Number(bgmType);
  const id = Number(bgmId);
  return type === 0 && Number.isInteger(id) && id >= 0 && (id === 0 || getLobbyCatalog().bgmIds.has(id));
}

function getLobbyCatalog() {
  if (lobbyCatalog) return lobbyCatalog;
  const backgroundRows = readGameplayTableRecords("ab_script_item_templet", "LUA_ITEM_BACKGROUND_PREFAB.json");
  const bgmRows = readGameplayTableRecords("ab_script", "LUA_BGM_INFO_TEMPLETE.json");
  lobbyCatalog = {
    backgroundIds: new Set(backgroundRows.map((row) => Number(row && row.m_ItemMiscID)).filter(Number.isInteger)),
    bgmIds: new Set(bgmRows.map((row) => Number(row && row.IDX)).filter(Number.isInteger)),
  };
  return lobbyCatalog;
}

function getServerNow(ctx) {
  const value = ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function isJukeboxCooldownActive(state, now) {
  const changedAt = Date.parse(state && state.jukeboxChangedAt);
  return Number.isFinite(changedAt) && now.getTime() - changedAt < JUKEBOX_CHANGE_COOLDOWN_MS;
}

function normalizeBackgroundInfo(backgroundInfo) {
  const data = backgroundInfo && typeof backgroundInfo === "object" ? backgroundInfo : {};
  const units = Array.isArray(data.unitInfoList) ? data.unitInfoList : Array.isArray(data.units) ? data.units : [];
  return {
    backgroundItemId: nonNegativeInt(data.backgroundItemId),
    backgroundBgmId: nonNegativeInt(data.backgroundBgmId),
    unitInfoList: units.slice(0, MAX_BACKGROUND_UNIT_SLOTS).map(normalizeBackgroundUnitInfo),
  };
}

function normalizeBackgroundUnitInfo(unit) {
  const data = unit && typeof unit === "object" ? unit : {};
  return {
    unitUid: toBigInt(data.unitUid != null ? data.unitUid : data.uid, 0n).toString(),
    unitType: clampInt(data.unitType, 0, 4, 2),
    unitSize: finiteNumber(data.unitSize, 1),
    unitFace: finiteInt(data.unitFace, 0),
    unitPosX: finiteNumber(data.unitPosX, 0),
    unitPosY: finiteNumber(data.unitPosY, 0),
    backImage: data.backImage == null ? true : Boolean(data.backImage),
    skinOption: finiteInt(data.skinOption, 0),
    rotation: finiteNumber(data.rotation, 0),
    flip: Boolean(data.flip),
    animTime: finiteNumber(data.animTime, -1),
  };
}

function defaultBackgroundInfo() {
  return { backgroundItemId: 0, backgroundBgmId: 0, unitInfoList: [] };
}

function defaultBackgroundUnitInfo() {
  return normalizeBackgroundUnitInfo(null);
}

function hasCustomizedBackgroundUnit(unit) {
  const data = normalizeBackgroundUnitInfo(unit);
  return (
    toBigInt(data.unitUid, 0n) !== 0n ||
    data.unitType !== 2 ||
    data.unitSize !== 1 ||
    data.unitFace !== 0 ||
    data.unitPosX !== 0 ||
    data.unitPosY !== 0 ||
    data.backImage !== true ||
    data.skinOption !== 0 ||
    data.rotation !== 0 ||
    data.flip !== false ||
    data.animTime !== -1
  );
}

function normalizeBgmMap(map) {
  const source = map && typeof map === "object" ? map : {};
  const normalized = {};
  for (const [type, id] of Object.entries(source)) {
    const bgmType = nonNegativeInt(type);
    const bgmId = nonNegativeInt(id);
    if (bgmId > 0) normalized[String(bgmType)] = bgmId;
  }
  return normalized;
}

function normalizeDate(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function isBackgroundInfoLike(value) {
  return Boolean(value && typeof value === "object" && ("backgroundItemId" in value || "backgroundBgmId" in value || "unitInfoList" in value));
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function saveIfLocal(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") {
    ctx.saveUserDb();
  }
}

function readUnsignedVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer.readUInt8(offset);
    offset += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function writeUnsignedVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function nonNegativeInt(value) {
  return Math.max(0, finiteInt(value, 0));
}

function finiteInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = finiteInt(value, fallback);
  return Math.min(max, Math.max(min, number));
}

module.exports = {
  BACKGROUND_CHANGE_REQ,
  BACKGROUND_CHANGE_ACK,
  JUKEBOX_CHANGE_BGM_REQ,
  JUKEBOX_CHANGE_BGM_ACK,
  createLobbyCustomizationHandlers,
  ensureLobbyCustomization,
  hasLobbyCustomization,
  getBackgroundInfo,
  setBackgroundInfo,
  setJukeboxBgm,
  buildBackgroundInfoData,
  buildBackgroundUnitInfoData,
  buildJukeboxData,
};
