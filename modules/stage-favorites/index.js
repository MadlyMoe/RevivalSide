const {
  writeVarInt,
  writeSignedVarInt,
  readSignedVarInt,
} = require("../packet-codec");

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
        const stageId = decodeStageIdReq(ctx, packet.payload, "FAVORITES_STAGE_ADD_REQ");
        const result = addFavoriteStage(user, stageId);
        const payload = buildFavoritesStageAckPayload(user, result.errorCode);
        console.log(
          `[stage-favorites:FAVORITES_STAGE_ADD_REQ] ACK packetId=${PACKETS.FAVORITES_STAGE_ADD_ACK} stageId=${stageId} count=${result.count} changed=${result.changed ? 1 : 0}`
        );
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITES_STAGE_ADD_ACK, payload, "favorites-stage-add");
        if (result.changed) saveIfLocal(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.FAVORITES_STAGE_DELETE_REQ,
      name: "FAVORITES_STAGE_DELETE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const stageId = decodeStageIdReq(ctx, packet.payload, "FAVORITES_STAGE_DELETE_REQ");
        const result = deleteFavoriteStage(user, stageId);
        const payload = buildFavoritesStageAckPayload(user, result.errorCode);
        console.log(
          `[stage-favorites:FAVORITES_STAGE_DELETE_REQ] ACK packetId=${PACKETS.FAVORITE_STAGE_DELETE_ACK} stageId=${stageId} count=${result.count} changed=${result.changed ? 1 : 0}`
        );
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITE_STAGE_DELETE_ACK, payload, "favorites-stage-delete");
        if (result.changed) saveIfLocal(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.FAVORITES_STAGE_UPDATE_REQ,
      name: "FAVORITES_STAGE_UPDATE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const entries = decodeFavoritesStageUpdateReq(ctx, packet.payload);
        const result = entries
          ? replaceFavoriteStages(user, entries)
          : { changed: false, count: getStageFavoriteEntries(user).length, errorCode: NKM_ERROR_CODE_OK };
        const payload = buildFavoritesStageAckPayload(user, result.errorCode);
        console.log(
          `[stage-favorites:FAVORITES_STAGE_UPDATE_REQ] ACK packetId=${PACKETS.FAVORITES_STAGE_UPDATE_ACK} requested=${entries ? entries.length : 0} count=${result.count} changed=${result.changed ? 1 : 0}`
        );
        ctx.sendGameResponse(socket, packet, PACKETS.FAVORITES_STAGE_UPDATE_ACK, payload, "favorites-stage-update");
        if (result.changed) saveIfLocal(ctx, user);
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
  if (!normalizedStageId || entries.some(([, existingStageId]) => existingStageId === normalizedStageId)) {
    return { changed: false, count: entries.length, errorCode: NKM_ERROR_CODE_OK };
  }
  if (entries.length >= MAX_STAGE_FAVORITE_COUNT) {
    return { changed: false, count: entries.length, errorCode: NKM_ERROR_CODE_OK };
  }
  const nextEntries = entries.concat([[entries.length, normalizedStageId]]);
  setStageFavoriteEntries(user, nextEntries);
  return { changed: true, count: nextEntries.length, errorCode: NKM_ERROR_CODE_OK };
}

function deleteFavoriteStage(user, stageId) {
  const normalizedStageId = positiveInt(stageId);
  const entries = getStageFavoriteEntries(user);
  const nextEntries = entries.filter(([, existingStageId]) => existingStageId !== normalizedStageId);
  const changed = nextEntries.length !== entries.length;
  if (changed) setStageFavoriteEntries(user, nextEntries);
  return { changed, count: nextEntries.length, errorCode: NKM_ERROR_CODE_OK };
}

function replaceFavoriteStages(user, entries) {
  const current = getStageFavoriteEntries(user);
  const nextEntries = normalizeFavoriteEntries(entries);
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
    return positiveInt(readSignedVarInt(payload, 0).value);
  } catch (err) {
    console.log(`[stage-favorites:${label}] request decode failed: ${err.message}`);
    return 0;
  }
}

function decodeFavoritesStageUpdateReq(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    let offset = 0;
    const count = readUnsignedVarInt(payload, offset);
    offset = count.offset;
    const limit = Math.min(Number(count.value || 0), MAX_STAGE_FAVORITE_COUNT * 4);
    const entries = [];
    for (let index = 0; index < limit && offset < payload.length; index += 1) {
      const key = readSignedVarInt(payload, offset);
      offset = key.offset;
      const value = readSignedVarInt(payload, offset);
      offset = value.offset;
      entries.push([key.value, value.value]);
    }
    return entries;
  } catch (err) {
    console.log(`[stage-favorites:FAVORITES_STAGE_UPDATE_REQ] request decode failed: ${err.message}`);
    return null;
  }
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

function saveIfLocal(ctx, user) {
  if (!ctx || (ctx.config && ctx.config.USE_LOCAL_USER_DB === false)) return;
  const userUid = user && (user.userUid || user.m_UserUID);
  if (typeof ctx.scheduleDebouncedUserSave === "function") {
    ctx.scheduleDebouncedUserSave(userUid);
  } else if (typeof ctx.saveUserDb === "function") {
    ctx.saveUserDb(userUid);
  }
}

function normalizeFavoriteEntries(input) {
  const raw = toRawEntries(input);
  const seenStages = new Set();
  const entries = [];
  raw
    .map(([slot, stageId]) => [nonNegativeInt(slot), positiveInt(stageId)])
    .filter(([, stageId]) => stageId > 0)
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
  createStageFavoritesHandlers,
  ensureStageFavorites,
  getStageFavoriteEntries,
  addFavoriteStage,
  deleteFavoriteStage,
  replaceFavoriteStages,
  buildFavoritesStageAckPayload,
  writeIntIntMap,
};
