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

function createLobbyCustomizationHandlers() {
  return [
    {
      packetId: GAME_OPTION_PLAY_CUTSCENE_REQ,
      name: "GAME_OPTION_PLAY_CUTSCENE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const isPlayCutscene = decodePlayCutsceneReq(ctx, packet.payload);
        user.options = user.options && typeof user.options === "object" ? user.options : {};
        user.options.playCutscene = isPlayCutscene;
        const payload = Buffer.concat([writeSignedVarInt(0), writeBool(isPlayCutscene)]);
        console.log(`[lobby:GAME_OPTION_PLAY_CUTSCENE_REQ] ACK packetId=${GAME_OPTION_PLAY_CUTSCENE_ACK} play=${isPlayCutscene ? 1 : 0}`);
        ctx.sendGameResponse(socket, packet, GAME_OPTION_PLAY_CUTSCENE_ACK, payload, "game-option-play-cutscene");
        saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: INVENTORY_EXPAND_REQ,
      name: "INVENTORY_EXPAND_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeInventoryExpandReq(ctx, packet.payload);
        const result = applyInventoryExpansion(user, req.inventoryType, req.count);
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
        saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: BACKGROUND_CHANGE_REQ,
      name: "BACKGROUND_CHANGE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const decoded = decodeBackgroundChangeReq(ctx, packet.payload);
        if (decoded.backgroundInfo) {
          setBackgroundInfo(user, decoded.backgroundInfo);
        } else {
          ensureLobbyCustomization(user);
        }

        const payload = Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildBackgroundInfoData(user))]);
        console.log(
          `[lobby:BACKGROUND_CHANGE_REQ] ACK packetId=${BACKGROUND_CHANGE_ACK} bg=${
            getBackgroundInfo(user).backgroundItemId
          } bgm=${getBackgroundInfo(user).backgroundBgmId} units=${getBackgroundInfo(user).unitInfoList.length}`
        );
        ctx.sendGameResponse(socket, packet, BACKGROUND_CHANGE_ACK, payload, "background-change");
        saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: UPDATE_PVP_INVITATION_OPTION_REQ,
      name: "UPDATE_PVP_INVITATION_OPTION_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const value = decodePvpInvitationOptionReq(ctx, packet.payload);
        user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
        user.pvp.invitationOption = value;
        const payload = Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(value)]);
        console.log(`[lobby:UPDATE_PVP_INVITATION_OPTION_REQ] ACK packetId=${UPDATE_PVP_INVITATION_OPTION_ACK} value=${value}`);
        ctx.sendGameResponse(socket, packet, UPDATE_PVP_INVITATION_OPTION_ACK, payload, "pvp-invitation-option");
        saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: JUKEBOX_CHANGE_BGM_REQ,
      name: "JUKEBOX_CHANGE_BGM_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeJukeboxChangeBgmReq(ctx, packet.payload);
        setJukeboxBgm(user, req.bgmType, req.bgmId);

        const payload = Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildJukeboxData(user))]);
        console.log(`[lobby:JUKEBOX_CHANGE_BGM_REQ] ACK packetId=${JUKEBOX_CHANGE_BGM_ACK} type=${req.bgmType} bgm=${req.bgmId}`);
        ctx.sendGameResponse(socket, packet, JUKEBOX_CHANGE_BGM_ACK, payload, "jukebox-change-bgm");
        saveIfLocal(ctx);
        return true;
      },
    },
  ];
}

function decodePlayCutsceneReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return reader.bool();
  } catch (err) {
    console.log(`[lobby:GAME_OPTION_PLAY_CUTSCENE_REQ] request decode failed: ${err.message}`);
    return false;
  }
}

function decodeInventoryExpandReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return {
      inventoryType: clampInt(reader.int(), 0, 5, 0),
      count: clampInt(reader.int(), 0, 100, 0),
    };
  } catch (err) {
    console.log(`[lobby:INVENTORY_EXPAND_REQ] request decode failed: ${err.message}`);
    return { inventoryType: 0, count: 0 };
  }
}

function decodePvpInvitationOptionReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return clampInt(reader.int(), 0, 4, 0);
  } catch (err) {
    console.log(`[lobby:UPDATE_PVP_INVITATION_OPTION_REQ] request decode failed: ${err.message}`);
    return 0;
  }
}

function ensureLobbyCustomization(user) {
  if (!user || typeof user !== "object") return { backgroundInfo: defaultBackgroundInfo(), jukeboxBgmIds: {} };
  user.lobbyCustomization = user.lobbyCustomization && typeof user.lobbyCustomization === "object" ? user.lobbyCustomization : {};
  const state = user.lobbyCustomization;
  state.backgroundInfo = normalizeBackgroundInfo(state.backgroundInfo || user.backgroundInfo || user.backGroundInfo);
  state.jukeboxBgmIds = normalizeBgmMap(state.jukeboxBgmIds || user.jukeboxBgmIds || user.jukeboxData);
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

function setJukeboxBgm(user, bgmType, bgmId) {
  const state = ensureLobbyCustomization(user);
  const type = nonNegativeInt(bgmType);
  const id = nonNegativeInt(bgmId);
  if (id > 0) {
    state.jukeboxBgmIds[String(type)] = id;
  } else {
    delete state.jukeboxBgmIds[String(type)];
  }
  state.updatedAt = new Date().toISOString();
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
    return { backgroundInfo: reader.nullableBackgroundInfo() };
  } catch (err) {
    console.log(`[lobby:BACKGROUND_CHANGE_REQ] request decode failed: ${err.message}`);
    return { backgroundInfo: null };
  }
}

function decodeJukeboxChangeBgmReq(ctx, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    return {
      bgmType: reader.int(),
      bgmId: reader.int(),
    };
  } catch (err) {
    console.log(`[lobby:JUKEBOX_CHANGE_BGM_REQ] request decode failed: ${err.message}`);
    return { bgmType: 0, bgmId: 0 };
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
      return normalizeBackgroundInfo({
        backgroundItemId: this.int(),
        backgroundBgmId: this.int(),
        unitInfoList: this.backgroundUnitList(),
      });
    },
    backgroundUnitList() {
      const count = Math.min(this.uvar(), MAX_BACKGROUND_UNIT_SLOTS);
      const units = [];
      for (let index = 0; index < count; index += 1) {
        units.push(this.nullableBackgroundUnitInfo());
      }
      return units;
    },
    nullableBackgroundUnitInfo() {
      if (!this.bool()) return defaultBackgroundUnitInfo();
      return this.backgroundUnitInfo();
    },
    backgroundUnitInfo() {
      return normalizeBackgroundUnitInfo({
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
      });
    },
  };
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
