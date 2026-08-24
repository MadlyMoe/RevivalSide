const path = require("path");
const {
  writeVarInt,
  writeSignedVarInt,
  readSignedVarInt,
} = require("../packet-codec");
const { readGameplayTableRecords } = require("../gameplay-jsons");

const PACKETS = Object.freeze({
  FAVORITES_STAGE_REQ: 1243,
  FAVORITES_STAGE_ACK: 1244,
  FAVORITES_STAGE_ADD_REQ: 1245,
  FAVORITES_STAGE_ADD_ACK: 1246,
  FAVORITES_STAGE_DELETE_REQ: 1247,
  FAVORITE_STAGE_DELETE_ACK: 1248,
  FAVORITES_STAGE_UPDATE_REQ: 1253,
  FAVORITES_STAGE_UPDATE_ACK: 1254,
});

const NKM_ERROR_CODE_OK = 0;
const MAX_STAGE_FAVORITE_COUNT = 30;
const FAVORITE_ERRORS = Object.freeze({
  DUPLICATE: 23504,
  COUNT_MAX: 23505,
  COUNT_DIFFERENT: 23506,
  INVALID_STAGE_ID: 23507,
});
const stageIds = new Set(
  readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json", {
    rootDir: path.resolve(__dirname, "..", ".."),
    logLabel: "stage-favorites",
  }).map((row) => Number(row && row.m_StageID)).filter(Number.isSafeInteger)
);

function createStageFavoritesHandlers() {
  return [
    {
      packetId: PACKETS.FAVORITES_STAGE_REQ,
      name: "FAVORITES_STAGE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const payload = buildFavoritesStageAckPayload(user);
        console.log(`[stage-favorites:FAVORITES_STAGE_REQ] ACK packetId=${PACKETS.FAVORITES_STAGE_ACK} count=${getStageFavoriteEntries(user).length}`);
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITES_STAGE_ACK, payload, "favorites-stage");
        return true;
      },
    },
    {
      packetId: PACKETS.FAVORITES_STAGE_ADD_REQ,
      name: "FAVORITES_STAGE_ADD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeStageIdReq(ctx, packet.payload, "FAVORITES_STAGE_ADD_REQ");
        const stageId = request.valid ? request.stageId : 0;
        const result = request.valid
          ? addFavoriteStage(user, stageId)
          : favoriteResult(user, FAVORITE_ERRORS.INVALID_STAGE_ID);
        const payload = buildFavoritesStageAckPayload(user, result.errorCode);
        console.log(
          `[stage-favorites:FAVORITES_STAGE_ADD_REQ] ACK packetId=${PACKETS.FAVORITES_STAGE_ADD_ACK} stageId=${stageId} count=${result.count} changed=${result.changed ? 1 : 0}`
        );
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITES_STAGE_ADD_ACK, payload, "favorites-stage-add");
        if (result.changed) saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: PACKETS.FAVORITES_STAGE_DELETE_REQ,
      name: "FAVORITES_STAGE_DELETE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeStageIdReq(ctx, packet.payload, "FAVORITES_STAGE_DELETE_REQ");
        const stageId = request.valid ? request.stageId : 0;
        const result = request.valid
          ? deleteFavoriteStage(user, stageId)
          : favoriteResult(user, FAVORITE_ERRORS.INVALID_STAGE_ID);
        const payload = buildFavoritesStageAckPayload(user, result.errorCode);
        console.log(
          `[stage-favorites:FAVORITES_STAGE_DELETE_REQ] ACK packetId=${PACKETS.FAVORITE_STAGE_DELETE_ACK} stageId=${stageId} count=${result.count} changed=${result.changed ? 1 : 0}`
        );
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITE_STAGE_DELETE_ACK, payload, "favorites-stage-delete");
        if (result.changed) saveIfLocal(ctx);
        return true;
      },
    },
    {
      packetId: PACKETS.FAVORITES_STAGE_UPDATE_REQ,
      name: "FAVORITES_STAGE_UPDATE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeFavoritesStageUpdateReq(ctx, packet.payload);
        const result = request.valid
          ? replaceFavoriteStages(user, request.entries)
          : favoriteResult(user, request.errorCode);
        const payload = buildFavoritesStageAckPayload(user, result.errorCode);
        console.log(
          `[stage-favorites:FAVORITES_STAGE_UPDATE_REQ] ACK packetId=${PACKETS.FAVORITES_STAGE_UPDATE_ACK} requested=${request.entries ? request.entries.length : 0} count=${result.count} changed=${result.changed ? 1 : 0}`
        );
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITES_STAGE_UPDATE_ACK, payload, "favorites-stage-update");
        if (result.changed) saveIfLocal(ctx);
        return true;
      },
    },
  ];
}

function ensureStageFavorites(user) {
  if (!user || typeof user !== "object") return {};
  const source =
    user.stageFavorites != null
      ? user.stageFavorites
      : user.favoriteStages != null
        ? user.favoriteStages
        : user.favoritesStage;
  user.stageFavorites = entriesToObject(normalizeFavoriteEntries(source));
  return user.stageFavorites;
}

function getStageFavoriteEntries(user) {
  if (!user || typeof user !== "object") return [];
  return normalizeFavoriteEntries(ensureStageFavorites(user));
}

function addFavoriteStage(user, stageId) {
  const normalizedStageId = positiveInt(stageId);
  const entries = getStageFavoriteEntries(user);
  if (!stageIds.has(normalizedStageId)) return favoriteResult(user, FAVORITE_ERRORS.INVALID_STAGE_ID);
  if (entries.some(([, existingStageId]) => existingStageId === normalizedStageId)) {
    return favoriteResult(user, FAVORITE_ERRORS.DUPLICATE);
  }
  if (entries.length >= MAX_STAGE_FAVORITE_COUNT) {
    return favoriteResult(user, FAVORITE_ERRORS.COUNT_MAX);
  }
  const nextEntries = entries.concat([[entries.length, normalizedStageId]]);
  setStageFavoriteEntries(user, nextEntries);
  return { changed: true, count: nextEntries.length, errorCode: NKM_ERROR_CODE_OK };
}

function deleteFavoriteStage(user, stageId) {
  const normalizedStageId = positiveInt(stageId);
  const entries = getStageFavoriteEntries(user);
  if (!stageIds.has(normalizedStageId)) return favoriteResult(user, FAVORITE_ERRORS.INVALID_STAGE_ID);
  const nextEntries = entries.filter(([, existingStageId]) => existingStageId !== normalizedStageId);
  const changed = nextEntries.length !== entries.length;
  if (changed) setStageFavoriteEntries(user, nextEntries);
  return { changed, count: nextEntries.length, errorCode: NKM_ERROR_CODE_OK };
}

function replaceFavoriteStages(user, entries) {
  const current = getStageFavoriteEntries(user);
  const validationError = validateFavoriteEntries(entries);
  if (validationError) return favoriteResult(user, validationError);
  const nextEntries = entries.slice().sort((left, right) => left[0] - right[0]);
  const changed = !sameFavoriteEntries(current, nextEntries);
  if (changed) setStageFavoriteEntries(user, nextEntries);
  return { changed, count: nextEntries.length, errorCode: NKM_ERROR_CODE_OK };
}

function buildFavoritesStageAckPayload(user, errorCode = NKM_ERROR_CODE_OK) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeIntIntMap(user ? getStageFavoriteEntries(user) : []),
  ]);
}

function writeIntIntMap(entries) {
  const list = normalizeFavoriteEntries(entries);
  return Buffer.concat([
    writeVarInt(list.length),
    ...list.flatMap(([key, value]) => [writeSignedVarInt(key), writeSignedVarInt(value)]),
  ]);
}

function decodeStageIdReq(ctx, encryptedPayload, label) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const read = readSignedVarInt(payload, 0);
    const stageId = positiveInt(read.value);
    return { valid: read.offset === payload.length && stageId > 0, stageId };
  } catch (err) {
    console.log(`[stage-favorites:${label}] request decode failed: ${err.message}`);
    return { valid: false, stageId: 0 };
  }
}

function decodeFavoritesStageUpdateReq(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    let offset = 0;
    const count = readUnsignedVarInt(payload, offset);
    offset = count.offset;
    if (count.value > MAX_STAGE_FAVORITE_COUNT) {
      return { valid: false, entries: [], errorCode: FAVORITE_ERRORS.COUNT_MAX };
    }
    const entries = [];
    for (let index = 0; index < count.value; index += 1) {
      const key = readSignedVarInt(payload, offset);
      offset = key.offset;
      const value = readSignedVarInt(payload, offset);
      offset = value.offset;
      entries.push([key.value, value.value]);
    }
    return offset === payload.length
      ? { valid: true, entries, errorCode: NKM_ERROR_CODE_OK }
      : { valid: false, entries: [], errorCode: FAVORITE_ERRORS.COUNT_DIFFERENT };
  } catch (err) {
    console.log(`[stage-favorites:FAVORITES_STAGE_UPDATE_REQ] request decode failed: ${err.message}`);
    return { valid: false, entries: [], errorCode: FAVORITE_ERRORS.COUNT_DIFFERENT };
  }
}

function validateFavoriteEntries(entries) {
  if (!Array.isArray(entries)) return FAVORITE_ERRORS.COUNT_DIFFERENT;
  if (entries.length > MAX_STAGE_FAVORITE_COUNT) return FAVORITE_ERRORS.COUNT_MAX;
  const keys = new Set();
  const values = new Set();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2 || !Number.isInteger(entry[0]) || entry[0] < 0) {
      return FAVORITE_ERRORS.COUNT_DIFFERENT;
    }
    const stageId = positiveInt(entry[1]);
    if (!stageIds.has(stageId)) return FAVORITE_ERRORS.INVALID_STAGE_ID;
    if (keys.has(entry[0])) return FAVORITE_ERRORS.COUNT_DIFFERENT;
    if (values.has(stageId)) return FAVORITE_ERRORS.DUPLICATE;
    keys.add(entry[0]);
    values.add(stageId);
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (!keys.has(index)) return FAVORITE_ERRORS.COUNT_DIFFERENT;
  }
  return NKM_ERROR_CODE_OK;
}

function favoriteResult(user, errorCode) {
  return { changed: false, count: getStageFavoriteEntries(user).length, errorCode };
}

function decryptPayload(ctx, encryptedPayload) {
  return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) {
    ensureStageFavorites(socket.session.user);
    return socket.session.user;
  }
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  ensureStageFavorites(user);
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function saveIfLocal(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") {
    ctx.saveUserDb();
  }
}

function normalizeFavoriteEntries(input) {
  const raw = toRawEntries(input);
  const seenStages = new Set();
  const entries = [];
  raw
    .map(([slot, stageId]) => [nonNegativeInt(slot), positiveInt(stageId)])
    .filter(([, stageId]) => stageIds.has(stageId))
    .sort((left, right) => left[0] - right[0])
    .forEach(([, stageId]) => {
      if (seenStages.has(stageId) || entries.length >= MAX_STAGE_FAVORITE_COUNT) return;
      seenStages.add(stageId);
      entries.push([entries.length, stageId]);
    });
  return entries;
}

function toRawEntries(input) {
  if (!input) return [];
  if (input instanceof Map) return Array.from(input.entries());
  if (Array.isArray(input)) {
    return input.map((entry, index) => {
      if (Array.isArray(entry)) return [entry[0], entry[1]];
      if (entry && typeof entry === "object") {
        return [
          entry.slot != null ? entry.slot : entry.index != null ? entry.index : index,
          entry.stageId != null ? entry.stageId : entry.stageID != null ? entry.stageID : entry.value,
        ];
      }
      return [index, entry];
    });
  }
  const source = input && typeof input === "object" && input.stages && typeof input.stages === "object" ? input.stages : input;
  if (source && typeof source === "object") return Object.entries(source);
  return [];
}

function setStageFavoriteEntries(user, entries) {
  if (!user || typeof user !== "object") return;
  user.stageFavorites = entriesToObject(normalizeFavoriteEntries(entries));
}

function entriesToObject(entries) {
  const output = {};
  for (const [slot, stageId] of entries) output[String(nonNegativeInt(slot))] = positiveInt(stageId);
  return output;
}

function sameFavoriteEntries(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (Number(left[index][0]) !== Number(right[index][0]) || Number(left[index][1]) !== Number(right[index][1])) {
      return false;
    }
  }
  return true;
}

function readUnsignedVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length && shift < 32) {
    const byte = buffer.readUInt8(cursor);
    cursor += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: cursor };
    shift += 7;
  }
  throw new Error("malformed varint32");
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

module.exports = {
  PACKETS,
  MAX_STAGE_FAVORITE_COUNT,
  FAVORITE_ERRORS,
  createStageFavoritesHandlers,
  ensureStageFavorites,
  getStageFavoriteEntries,
  addFavoriteStage,
  deleteFavoriteStage,
  replaceFavoriteStages,
  buildFavoritesStageAckPayload,
  writeIntIntMap,
};
