const { randomInt: cryptoRandomInt } = require("crypto");
const {
  writeBool,
  writeInt64LE,
  writeIntList,
  writeLongArray,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  readString,
  dateTimeBinaryNow,
  farFutureDateTimeBinary,
  toBigInt,
  buildItemMiscData,
  buildRewardData,
  buildUnitData,
} = require("../packet-codec");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");
const { COMMON_RESOURCE_ITEM_IDS, ensureInventory, spendMiscItem } = require("../inventory");
const { ensureArmy, getArmyUnits, getArmyTrophies, getArmyUnitByUid } = require("../unit");
const { createEmptyReward, grantRewardByType } = require("../reward");
const { buildCommonProfileData, buildUserProfileData } = require("../profile");
const { dateFromDateTime, dateTimeBinaryForDate, rawTicksFromDateTime } = require("../server-time");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");

const PACKETS = Object.freeze({
  OFFICE_OPEN_SECTION_REQ: 3600,
  OFFICE_OPEN_SECTION_ACK: 3601,
  OFFICE_OPEN_ROOM_REQ: 3602,
  OFFICE_OPEN_ROOM_ACK: 3603,
  OFFICE_SET_ROOM_NAME_REQ: 3604,
  OFFICE_SET_ROOM_NAME_ACK: 3605,
  OFFICE_SET_ROOM_UNIT_REQ: 3606,
  OFFICE_SET_ROOM_UNIT_ACK: 3607,
  OFFICE_SET_ROOM_FLOOR_REQ: 3608,
  OFFICE_SET_ROOM_FLOOR_ACK: 3609,
  OFFICE_SET_ROOM_WALL_REQ: 3610,
  OFFICE_SET_ROOM_WALL_ACK: 3611,
  OFFICE_SET_ROOM_BACKGROUND_REQ: 3612,
  OFFICE_SET_ROOM_BACKGROUND_ACK: 3613,
  OFFICE_ADD_FURNITURE_REQ: 3614,
  OFFICE_ADD_FURNITURE_ACK: 3615,
  OFFICE_UPDATE_FURNITURE_REQ: 3616,
  OFFICE_UPDATE_FURNITURE_ACK: 3617,
  OFFICE_REMOVE_FURNITURE_REQ: 3618,
  OFFICE_REMOVE_FURNITURE_ACK: 3619,
  OFFICE_CLEAR_ALL_FURNITURE_REQ: 3620,
  OFFICE_CLEAR_ALL_FURNITURE_ACK: 3621,
  OFFICE_TAKE_HEART_REQ: 3622,
  OFFICE_TAKE_HEART_ACK: 3623,
  OFFICE_STATE_REQ: 3624,
  OFFICE_STATE_ACK: 3625,
  OFFICE_POST_LIST_REQ: 3626,
  OFFICE_POST_LIST_ACK: 3627,
  OFFICE_POST_RECV_REQ: 3628,
  OFFICE_POST_RECV_ACK: 3629,
  OFFICE_POST_BROADCAST_REQ: 3630,
  OFFICE_POST_BROADCAST_ACK: 3631,
  OFFICE_POST_SEND_REQ: 3632,
  OFFICE_POST_SEND_ACK: 3633,
  OFFICE_RANDOM_VISIT_REQ: 3634,
  OFFICE_RANDOM_VISIT_ACK: 3635,
  OFFICE_GUEST_LIST_NOT: 3636,
  OFFICE_PARTY_REQ: 3642,
  OFFICE_PARTY_ACK: 3643,
  OFFICE_PRESET_REGISTER_REQ: 3644,
  OFFICE_PRESET_REGISTER_ACK: 3645,
  OFFICE_PRESET_APPLY_REQ: 3646,
  OFFICE_PRESET_APPLY_ACK: 3647,
  OFFICE_PRESET_ADD_REQ: 3648,
  OFFICE_PRESET_ADD_ACK: 3649,
  OFFICE_PRESET_CHANGE_NAME_REQ: 3650,
  OFFICE_PRESET_CHANGE_NAME_ACK: 3651,
  OFFICE_PRESET_RESET_REQ: 3652,
  OFFICE_PRESET_RESET_ACK: 3653,
  OFFICE_PRESET_APPLY_THEMA_REQ: 3654,
  OFFICE_PRESET_APPLY_THEMA_ACK: 3655,
});

const DEFAULT_SECTION_IDS = Object.freeze([101, 102, 201, 202, 203]);
const DEFAULT_ROOM_IDS = Object.freeze([1, 10201, 20101, 20102, 20201, 20301, 20302]);
const DEFAULT_BACKGROUND_ID = 800101;
const DEFAULT_WALL_ID = 800102;
const DEFAULT_FLOOR_ID = 800103;
const DEFAULT_PRESET_COUNT = 3;
const MAX_PRESET_COUNT = 20;
const PRESET_NAME_MAX_LENGTH = 20;
const PRESET_EXPAND_ITEM_ID = 101;
const PRESET_EXPAND_COST = 200;
const MAX_POST_COUNT_PER_PAGE = 50;
const NAME_CARD_SEND_DAILY_LIMIT = 5;
const OFFICE_DAILY_RESET_HOUR_UTC = 4;
const OFFICE_HEART_LOYALTY_GAIN = 100;
const TICKS_PER_HOUR = 36_000_000_000n;
const OFFICE_ERROR = Object.freeze({
  INVALID_REQUEST: 20191,
  FURNITURE_ROOM_NOT_FOUND: 20789,
  FURNITURE_OVERLAP: 20791,
  FURNITURE_OUT_OF_BOUND: 20792,
  FURNITURE_ROOM_FULL: 20793,
  FURNITURE_TYPE_MISMATCH: 20795,
  PROFILE_NOT_FOUND: 20893,
  POST_ALREADY_SEND_TARGET: 20895,
  POST_DAILY_LIMIT_FULL: 20896,
  POST_RECV_DAILY_LIMIT: 20902,
  POST_NOT_EXIST: 20903,
  POST_SEND_DAILY_LIMIT: 20905,
  POST_MYSELF: 20907,
  NO_VISITOR_AVAILABLE: 20908,
  POST_NO_FRIENDSHIP_EXIST: 20909,
  INVALID_SECTION_ID: 20842,
  INVALID_ROOM_ID: 20843,
  SECTION_ALREADY_OPEN: 20844,
  ROOM_ALREADY_OPEN: 20845,
  SECTION_NOT_OPEN: 20846,
  ROOM_NOT_OPEN: 20847,
  INVALID_ROOM_NAME: 20848,
  UNIT_NOT_EXIST: 133,
  SET_UNIT_NOT_CHANGED: 20873,
  SET_UNIT_MAX_LIMIT: 20874,
  SET_UNIT_UID_DUPLICATED: 20875,
  INTERIOR_INVALID_ID: 20879,
  INTERIOR_NOT_EXIST: 20880,
  INTERIOR_INVALID_TYPE: 20881,
  FURNITURE_INVALID_ID: 20877,
  FURNITURE_NOT_REMAINS: 20878,
  FURNITURE_INVALID_UID: 20885,
  UNIT_NOT_IN_ROOM: 20890,
  UNIT_HEART_NOT_FULL: 20891,
  UNIT_LOYALTY_FULL: 20892,
  TROPHY_CANNOT_TAKE_HEART: 23009,
  PARTY_NO_UNIT: 21019,
  PRESET_INVALID_INDEX: 21053,
  PRESET_DATA: 21054,
  PRESET_INVALID_NAME: 21055,
  PRESET_INVALID_ADD_COUNT: 21056,
  PRESET_THEME_TEMPLET: 21057,
  INSUFFICIENT_CASH: 96,
  INSUFFICIENT_RESOURCE: 110,
  INSUFFICIENT_ITEM: 111,
});

let officeCatalogCache = null;

function createOfficeHandlers() {
  return [
    handler(PACKETS.OFFICE_OPEN_SECTION_REQ, "OFFICE_OPEN_SECTION_REQ", handleOpenSection),
    handler(PACKETS.OFFICE_OPEN_ROOM_REQ, "OFFICE_OPEN_ROOM_REQ", handleOpenRoom),
    handler(PACKETS.OFFICE_SET_ROOM_NAME_REQ, "OFFICE_SET_ROOM_NAME_REQ", handleSetRoomName),
    handler(PACKETS.OFFICE_SET_ROOM_UNIT_REQ, "OFFICE_SET_ROOM_UNIT_REQ", handleSetRoomUnit),
    handler(PACKETS.OFFICE_SET_ROOM_FLOOR_REQ, "OFFICE_SET_ROOM_FLOOR_REQ", handleSetRoomFloor),
    handler(PACKETS.OFFICE_SET_ROOM_WALL_REQ, "OFFICE_SET_ROOM_WALL_REQ", handleSetRoomWall),
    handler(PACKETS.OFFICE_SET_ROOM_BACKGROUND_REQ, "OFFICE_SET_ROOM_BACKGROUND_REQ", handleSetRoomBackground),
    handler(PACKETS.OFFICE_ADD_FURNITURE_REQ, "OFFICE_ADD_FURNITURE_REQ", handleAddFurniture),
    handler(PACKETS.OFFICE_UPDATE_FURNITURE_REQ, "OFFICE_UPDATE_FURNITURE_REQ", handleUpdateFurniture),
    handler(PACKETS.OFFICE_REMOVE_FURNITURE_REQ, "OFFICE_REMOVE_FURNITURE_REQ", handleRemoveFurniture),
    handler(PACKETS.OFFICE_CLEAR_ALL_FURNITURE_REQ, "OFFICE_CLEAR_ALL_FURNITURE_REQ", handleClearAllFurniture),
    handler(PACKETS.OFFICE_TAKE_HEART_REQ, "OFFICE_TAKE_HEART_REQ", handleTakeHeart),
    handler(PACKETS.OFFICE_STATE_REQ, "OFFICE_STATE_REQ", handleOfficeState),
    handler(PACKETS.OFFICE_POST_LIST_REQ, "OFFICE_POST_LIST_REQ", handlePostList),
    handler(PACKETS.OFFICE_POST_RECV_REQ, "OFFICE_POST_RECV_REQ", handlePostRecv),
    handler(PACKETS.OFFICE_POST_BROADCAST_REQ, "OFFICE_POST_BROADCAST_REQ", handlePostBroadcast),
    handler(PACKETS.OFFICE_POST_SEND_REQ, "OFFICE_POST_SEND_REQ", handlePostSend),
    handler(PACKETS.OFFICE_RANDOM_VISIT_REQ, "OFFICE_RANDOM_VISIT_REQ", handleRandomVisit),
    handler(PACKETS.OFFICE_PARTY_REQ, "OFFICE_PARTY_REQ", handleParty),
    handler(PACKETS.OFFICE_PRESET_REGISTER_REQ, "OFFICE_PRESET_REGISTER_REQ", handlePresetRegister),
    handler(PACKETS.OFFICE_PRESET_APPLY_REQ, "OFFICE_PRESET_APPLY_REQ", handlePresetApply),
    handler(PACKETS.OFFICE_PRESET_ADD_REQ, "OFFICE_PRESET_ADD_REQ", handlePresetAdd),
    handler(PACKETS.OFFICE_PRESET_CHANGE_NAME_REQ, "OFFICE_PRESET_CHANGE_NAME_REQ", handlePresetChangeName),
    handler(PACKETS.OFFICE_PRESET_RESET_REQ, "OFFICE_PRESET_RESET_REQ", handlePresetReset),
    handler(PACKETS.OFFICE_PRESET_APPLY_THEMA_REQ, "OFFICE_PRESET_APPLY_THEMA_REQ", handlePresetApplyThema),
  ];
}

function handler(packetId, name, handleRequest) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      const user = getSocketUser(socket);
      const req = decodeRequest(ctx, packetId, packet.payload);
      const response = handleRequest(ctx, user, req);
      const missionTracking = response.persist === false ? null : trackOfficeMission(ctx, user, response.mission);
      console.log(`[office:${name}] ACK packetId=${response.packetId} ${response.log || ""}`.trim());
      ctx.sendGameResponse(socket, packet, response.packetId, response.payload, `office-${packetId}`);
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "office-mission-update" });
      if (response.persist !== false) persist(ctx);
      return true;
    },
  };
}

function handleOpenSection(ctx, user, req) {
  const sectionId = positiveInt(req.sectionId);
  const row = getOfficeCatalog().sectionById.get(sectionId);
  const preview = ensureOfficeState(structuredClone(user));
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !row
      ? OFFICE_ERROR.INVALID_SECTION_ID
      : preview.openedSectionIds.includes(sectionId)
        ? OFFICE_ERROR.SECTION_ALREADY_OPEN
        : officeUnlockCostError(user, row);
  if (errorCode) {
    return ack(PACKETS.OFFICE_OPEN_SECTION_ACK, [
      writeSignedVarInt(errorCode),
      writeNullableObjectList([]),
      writeSignedVarInt(sectionId),
      writeNullableObjectList([]),
    ], `section=${sectionId} error=${errorCode}`, false);
  }
  const costItems = spendOfficeUnlockCost(ctx, user, row);
  const state = ensureOfficeState(user);
  state.openedSectionIds.push(sectionId);
  state.openedSectionIds = uniquePositiveInts(state.openedSectionIds);
  const newRooms = openRoomsForSection(state, sectionId);
  return ack(PACKETS.OFFICE_OPEN_SECTION_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeSignedVarInt(sectionId),
    writeNullableObjectList(newRooms.map(buildOfficeRoomData)),
  ], `section=${sectionId} rooms=${newRooms.length}`);
}

function handleOpenRoom(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const row = getOfficeCatalog().roomById.get(roomId);
  const preview = ensureOfficeState(structuredClone(user));
  const sectionId = positiveInt(row && row.SectionID);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !row
      ? OFFICE_ERROR.INVALID_ROOM_ID
      : preview.rooms.some((item) => item.id === roomId)
        ? OFFICE_ERROR.ROOM_ALREADY_OPEN
        : !preview.openedSectionIds.includes(sectionId)
          ? OFFICE_ERROR.SECTION_NOT_OPEN
          : !isOfficeRoomUnlockRequirementMet(preview, row)
            ? OFFICE_ERROR.ROOM_NOT_OPEN
            : officeUnlockCostError(user, row);
  if (errorCode) {
    return ack(PACKETS.OFFICE_OPEN_ROOM_ACK, [
      writeSignedVarInt(errorCode),
      writeNullableObjectList([]),
      writeNullObject(),
    ], `room=${roomId} error=${errorCode}`, false);
  }
  const costItems = spendOfficeUnlockCost(ctx, user, row);
  const room = ensureOfficeRoom(user, roomId);
  return ack(PACKETS.OFFICE_OPEN_ROOM_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObject(buildOfficeRoomData(room)),
  ], `room=${room.id}`);
}

function handleSetRoomName(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const preview = ensureOfficeState(structuredClone(user));
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !preview.rooms.some((room) => room.id === roomId)
      ? OFFICE_ERROR.ROOM_NOT_OPEN
      : !isValidOfficeRoomName(req.roomName)
        ? OFFICE_ERROR.INVALID_ROOM_NAME
        : 0;
  if (errorCode) {
    return ack(PACKETS.OFFICE_SET_ROOM_NAME_ACK, [
      writeSignedVarInt(errorCode),
      writeNullObject(),
    ], `room=${roomId} error=${errorCode}`, false);
  }
  const room = ensureOfficeRoom(user, roomId);
  room.name = req.roomName;
  return ack(PACKETS.OFFICE_SET_ROOM_NAME_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
  ], `room=${room.id}`);
}

function handleSetRoomUnit(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const unitUids = (Array.isArray(req.unitUids) ? req.unitUids : []).map(normalizeUidString);
  const previewUser = structuredClone(user);
  const preview = ensureOfficeState(previewUser);
  const previewRoom = preview.rooms.find((room) => room.id === roomId);
  const limit = getRoomUnitLimit(roomId);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !previewRoom
      ? OFFICE_ERROR.ROOM_NOT_OPEN
      : unitUids.length > limit
        ? OFFICE_ERROR.SET_UNIT_MAX_LIMIT
        : new Set(unitUids).size !== unitUids.length
          ? OFFICE_ERROR.SET_UNIT_UID_DUPLICATED
          : unitUids.some((uid) => toBigInt(uid) <= 0n || !isOfficeAssignableUnit(previewUser, uid))
            ? OFFICE_ERROR.UNIT_NOT_EXIST
            : sameUidSet(previewRoom.unitUids, unitUids)
              ? OFFICE_ERROR.SET_UNIT_NOT_CHANGED
              : 0;
  if (errorCode) {
    return ack(PACKETS.OFFICE_SET_ROOM_UNIT_ACK, [
      writeSignedVarInt(errorCode),
      writeNullableObjectList([]),
      writeNullableObjectList([]),
    ], `room=${roomId} error=${errorCode}`, false);
  }
  const room = ensureOfficeRoom(user, roomId);
  room.unitUids = unitUids;
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_SET_ROOM_UNIT_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
    writeNullableObjectList(getOfficeRooms(user).map(buildOfficeRoomData)),
  ], `room=${room.id} units=${room.unitUids.length}`);
}

function handleSetRoomFloor(ctx, user, req) {
  return handleSetRoomInterior(user, req, {
    ackPacketId: PACKETS.OFFICE_SET_ROOM_FLOOR_ACK,
    requestField: "floorInteriorId",
    roomField: "floorInteriorId",
    target: "Floor",
  });
}

function handleSetRoomWall(ctx, user, req) {
  return handleSetRoomInterior(user, req, {
    ackPacketId: PACKETS.OFFICE_SET_ROOM_WALL_ACK,
    requestField: "wallInteriorId",
    roomField: "wallInteriorId",
    target: "Wall",
  });
}

function handleSetRoomBackground(ctx, user, req) {
  return handleSetRoomInterior(user, req, {
    ackPacketId: PACKETS.OFFICE_SET_ROOM_BACKGROUND_ACK,
    requestField: "backgroundId",
    roomField: "backgroundId",
    target: "Background",
  });
}

function handleSetRoomInterior(user, req, config) {
  const roomId = positiveInt(req.roomId);
  const interiorId = positiveInt(req[config.requestField]);
  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((room) => room.id === roomId);
  const row = getOfficeCatalog().interiorById.get(interiorId);
  const owned = preview.interiors.find((interior) => interior.itemId === interiorId);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !previewRoom
      ? OFFICE_ERROR.ROOM_NOT_OPEN
      : !row
        ? OFFICE_ERROR.INTERIOR_INVALID_ID
        : toBigInt(owned && owned.count) <= 0n
          ? OFFICE_ERROR.INTERIOR_NOT_EXIST
          : String(row.m_ItemMiscSubType || "") !== "IMST_INTERIOR_DECO" || String(row.Target || "") !== config.target
            ? OFFICE_ERROR.INTERIOR_INVALID_TYPE
            : 0;
  if (errorCode) {
    return ack(config.ackPacketId, [
      writeSignedVarInt(errorCode),
      writeNullObject(),
      writeNullableObjectList([]),
    ], `room=${roomId} interior=${interiorId} error=${errorCode}`, false);
  }
  const room = ensureOfficeRoom(user, roomId);
  const changed = room[config.roomField] !== interiorId;
  let updatedUnits = [];
  if (changed) {
    room[config.roomField] = interiorId;
    recalculateRoomGrade(room);
    updatedUnits = syncOfficeUnits(user, room);
  }
  return ack(config.ackPacketId, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id} interior=${interiorId}`, changed);
}

function handleAddFurniture(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  if (!req.valid) return addFurnitureAck(OFFICE_ERROR.INVALID_REQUEST, roomId);

  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((room) => room.id === roomId);
  if (!previewRoom) return addFurnitureAck(OFFICE_ERROR.ROOM_NOT_OPEN, roomId);
  const row = getOfficeCatalog().interiorById.get(positiveInt(req.itemId));
  if (!isFurnitureRow(row)) return addFurnitureAck(OFFICE_ERROR.FURNITURE_INVALID_ID, roomId);
  const owned = preview.interiors.find((interior) => interior.itemId === positiveInt(req.itemId));
  if (toBigInt(owned && owned.count) <= 0n) return addFurnitureAck(OFFICE_ERROR.FURNITURE_NOT_REMAINS, roomId);

  const candidate = {
    uid: "0",
    itemId: positiveInt(req.itemId),
    planeType: req.planeType,
    positionX: req.positionX,
    positionY: req.positionY,
    inverted: Boolean(req.inverted),
  };
  const placementError = furniturePlacementError(previewRoom, row, candidate, { checkRoomFull: true });
  if (placementError) return addFurnitureAck(placementError, roomId);

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const furniture = normalizeFurniture({
    uid: nextFurnitureUid(user),
    itemId: req.itemId,
    planeType: req.planeType,
    positionX: req.positionX,
    positionY: req.positionY,
    inverted: req.inverted,
  });
  room.furnitures.push(furniture);
  const changedInterior = adjustInteriorCountInState(state, furniture.itemId, -1, { allowNegative: false });
  recalculateRoomGrade(room);
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_ADD_FURNITURE_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObject(buildOfficeFurnitureData(furniture)),
    writeNullableObject(buildInteriorData(changedInterior)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id} item=${furniture.itemId} uid=${furniture.uid}`);
}

function addFurnitureAck(errorCode, roomId) {
  return ack(PACKETS.OFFICE_ADD_FURNITURE_ACK, [
    writeSignedVarInt(errorCode),
    writeNullObject(),
    writeNullObject(),
    writeNullObject(),
    writeNullableObjectList([]),
  ], `room=${roomId} error=${errorCode}`, false);
}

function handleUpdateFurniture(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const furnitureUid = normalizeUidString(req.furnitureUid);
  if (!req.valid) return updateFurnitureAck(OFFICE_ERROR.INVALID_REQUEST, roomId, furnitureUid);

  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((room) => room.id === roomId);
  if (!previewRoom) return updateFurnitureAck(OFFICE_ERROR.ROOM_NOT_OPEN, roomId, furnitureUid);
  const previewFurniture = toBigInt(furnitureUid) > 0n ? findFurniture(previewRoom, furnitureUid) : null;
  if (!previewFurniture) return updateFurnitureAck(OFFICE_ERROR.FURNITURE_INVALID_UID, roomId, furnitureUid);
  const row = getOfficeCatalog().interiorById.get(previewFurniture.itemId);
  if (!isFurnitureRow(row)) return updateFurnitureAck(OFFICE_ERROR.FURNITURE_INVALID_ID, roomId, furnitureUid);

  const candidate = {
    ...previewFurniture,
    planeType: req.planeType,
    positionX: req.positionX,
    positionY: req.positionY,
    inverted: Boolean(req.inverted),
  };
  const placementError = furniturePlacementError(previewRoom, row, candidate, { ignoreUid: furnitureUid });
  if (placementError) return updateFurnitureAck(placementError, roomId, furnitureUid);

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const furniture = findFurniture(room, furnitureUid);
  const changed = furniture.planeType !== candidate.planeType
    || furniture.positionX !== candidate.positionX
    || furniture.positionY !== candidate.positionY
    || furniture.inverted !== candidate.inverted;
  furniture.planeType = candidate.planeType;
  furniture.positionX = candidate.positionX;
  furniture.positionY = candidate.positionY;
  furniture.inverted = candidate.inverted;
  return ack(PACKETS.OFFICE_UPDATE_FURNITURE_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObject(buildOfficeFurnitureData(furniture)),
  ], `room=${room.id} uid=${furniture.uid}`, changed);
}

function updateFurnitureAck(errorCode, roomId, furnitureUid) {
  return ack(PACKETS.OFFICE_UPDATE_FURNITURE_ACK, [
    writeSignedVarInt(errorCode),
    writeNullObject(),
    writeNullObject(),
  ], `room=${roomId} uid=${furnitureUid} error=${errorCode}`, false);
}

function handleRemoveFurniture(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const uid = normalizeUidString(req.furnitureUid);
  if (!req.valid) return removeFurnitureAck(OFFICE_ERROR.INVALID_REQUEST, roomId, uid);

  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((room) => room.id === roomId);
  if (!previewRoom) return removeFurnitureAck(OFFICE_ERROR.ROOM_NOT_OPEN, roomId, uid);
  if (toBigInt(uid) <= 0n || !findFurniture(previewRoom, uid)) {
    return removeFurnitureAck(OFFICE_ERROR.FURNITURE_INVALID_UID, roomId, uid);
  }

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const index = room.furnitures.findIndex((furniture) => normalizeUidString(furniture.uid) === uid);
  const [removed] = room.furnitures.splice(index, 1);
  const changedInterior = adjustInteriorCountInState(state, removed.itemId, 1);
  recalculateRoomGrade(room);
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_REMOVE_FURNITURE_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(toBigInt(uid)),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObject(buildInteriorData(changedInterior)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id} uid=${uid}`);
}

function removeFurnitureAck(errorCode, roomId, furnitureUid) {
  return ack(PACKETS.OFFICE_REMOVE_FURNITURE_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarLong(toBigInt(furnitureUid)),
    writeNullObject(),
    writeNullObject(),
    writeNullableObjectList([]),
  ], `room=${roomId} uid=${furnitureUid} error=${errorCode}`, false);
}

function handleClearAllFurniture(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  if (!req.valid) return clearFurnitureAck(OFFICE_ERROR.INVALID_REQUEST, roomId);
  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((room) => room.id === roomId);
  if (!previewRoom) return clearFurnitureAck(OFFICE_ERROR.ROOM_NOT_OPEN, roomId);

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const changed = [];
  for (const furniture of room.furnitures) {
    changed.push(adjustInteriorCountInState(state, furniture.itemId, 1));
  }
  room.furnitures = [];
  recalculateRoomGrade(room);
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_CLEAR_ALL_FURNITURE_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(dedupeInteriors(changed).map(buildInteriorData)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id}`, changed.length > 0);
}

function clearFurnitureAck(errorCode, roomId) {
  return ack(PACKETS.OFFICE_CLEAR_ALL_FURNITURE_ACK, [
    writeSignedVarInt(errorCode),
    writeNullObject(),
    writeNullableObjectList([]),
    writeNullableObjectList([]),
  ], `room=${roomId} error=${errorCode}`, false);
}

function handleTakeHeart(ctx, user, req) {
  const unitUid = normalizeUidString(req.unitUid);
  if (!req.valid) return takeHeartAck(OFFICE_ERROR.INVALID_REQUEST, unitUid);

  const previewUser = structuredClone(user);
  const previewArmy = ensureArmy(previewUser);
  const previewUnit = previewArmy.units[unitUid] || null;
  if (previewArmy.trophies[unitUid]) return takeHeartAck(OFFICE_ERROR.TROPHY_CANNOT_TAKE_HEART, unitUid);
  if (!previewUnit) return takeHeartAck(OFFICE_ERROR.UNIT_NOT_EXIST, unitUid);

  const previewState = ensureOfficeState(previewUser);
  const roomId = positiveInt(previewUnit.officeRoomId);
  const isAssigned = previewState.rooms.some((room) => room.id === roomId && room.unitUids.includes(unitUid));
  const now = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
  if (!roomId || !isAssigned) return takeHeartAck(OFFICE_ERROR.UNIT_NOT_IN_ROOM, unitUid);
  if (previewUnit.isPermanentContract || Number(previewUnit.loyalty || 0) >= 10000) {
    return takeHeartAck(OFFICE_ERROR.UNIT_LOYALTY_FULL, unitUid);
  }
  if (!isOfficeHeartFull(previewUnit, now)) return takeHeartAck(OFFICE_ERROR.UNIT_HEART_NOT_FULL, unitUid);

  const unit = ensureArmy(user).units[unitUid];
  unit.loyalty = Math.min(10000, Math.max(0, Number(unit.loyalty || 0)) + OFFICE_HEART_LOYALTY_GAIN);
  unit.officeGaugeStartTime = String(toBigInt(now));
  const response = ack(PACKETS.OFFICE_TAKE_HEART_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildUnitData(unit)),
  ], `unit=${unitUid} loyalty=${unit.loyalty}`);
  response.mission = { condition: "GET_OFFICE_HEART", amount: 1, details: { unitUid, unitId: unit.unitId } };
  return response;
}

function takeHeartAck(errorCode, unitUid) {
  return ack(PACKETS.OFFICE_TAKE_HEART_ACK, [
    writeSignedVarInt(errorCode),
    writeNullObject(),
  ], `unit=${unitUid} error=${errorCode}`, false);
}

function isOfficeHeartFull(unit, now) {
  const row = getOfficeCatalog().gradeRows[clampInt(unit && unit.officeGrade, 0, 5, 0)];
  const chargingHours = Math.max(0, Number(row && row.ChargingTime || 0) || 0);
  const currentTicks = rawTicksFromDateTime(now);
  const startTicks = rawTicksFromDateTime(unit && unit.officeGaugeStartTime);
  return currentTicks >= startTicks && currentTicks - startTicks >= BigInt(chargingHours) * TICKS_PER_HOUR;
}

function trackOfficeMission(ctx, user, mission) {
  if (!mission || !ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const now = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  const tracked = ctx.trackMissionEvent(user, mission.condition, mission.amount, { now, ...(mission.details || {}) });
  addMissionTrackingCondition(tracking, mission.condition, tracked);
  return tracking;
}

function handleOfficeState(ctx, user, req) {
  const userUid = toBigInt(req.userUid || 0);
  if (!req.valid) {
    return ack(PACKETS.OFFICE_STATE_ACK, [
      writeSignedVarInt(OFFICE_ERROR.INVALID_REQUEST),
      writeSignedVarLong(userUid),
      writeNullObject(),
    ], `uid=${userUid} error=${OFFICE_ERROR.INVALID_REQUEST}`, false);
  }
  const target = findOfficeUser(ctx, user, userUid);
  if (!target || (!target.hasOffice && !target.office)) {
    return ack(PACKETS.OFFICE_STATE_ACK, [
      writeSignedVarInt(OFFICE_ERROR.PROFILE_NOT_FOUND),
      writeSignedVarLong(userUid),
      writeNullObject(),
    ], `uid=${userUid} error=${OFFICE_ERROR.PROFILE_NOT_FOUND}`, false);
  }
  return ack(PACKETS.OFFICE_STATE_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(userUid),
    writeNullableObject(buildOfficeVisitStateData(structuredClone(target))),
  ], `uid=${userUid}`, false);
}

function handlePostList(ctx, user, req) {
  if (!req.valid) {
    return ack(PACKETS.OFFICE_POST_LIST_ACK, [
      writeSignedVarInt(OFFICE_ERROR.INVALID_REQUEST),
      writeNullableObjectList([]),
      writeSignedVarInt(0),
    ], `posts=0 error=${OFFICE_ERROR.INVALID_REQUEST}`, false);
  }
  const state = ensureOfficeState(structuredClone(user));
  const activePosts = getActiveOfficePosts(state, officeNowBinary(ctx));
  const page = activePosts
    .filter((post) => req.lastPostUid === 0n || toBigInt(post.postUid) < req.lastPostUid)
    .slice(0, MAX_POST_COUNT_PER_PAGE);
  return ack(PACKETS.OFFICE_POST_LIST_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(page.map(buildOfficePostData)),
    writeSignedVarInt(activePosts.length),
  ], `posts=${page.length} total=${activePosts.length}`, false);
}

function handlePostRecv(ctx, user, req) {
  if (!req.valid) return postRecvAck(OFFICE_ERROR.INVALID_REQUEST, user);
  const previewUser = structuredClone(user);
  const previewState = ensureOfficeState(previewUser);
  resetOfficePostState(ctx, previewState);
  const activePosts = getActiveOfficePosts(previewState, officeNowBinary(ctx));
  const receiveLimit = getOfficeCatalog().nameCard.dailyLimit;
  const remainCount = Math.max(0, receiveLimit - previewState.postState.recvCount);
  const errorCode = remainCount <= 0
    ? OFFICE_ERROR.POST_RECV_DAILY_LIMIT
    : activePosts.length === 0
      ? OFFICE_ERROR.POST_NOT_EXIST
      : 0;
  if (errorCode) return postRecvAck(errorCode, user);

  const state = ensureOfficeState(user);
  resetOfficePostState(ctx, state);
  const currentPosts = getActiveOfficePosts(state, officeNowBinary(ctx));
  const receivedPosts = currentPosts.slice(0, remainCount);
  const receivedUids = new Set(receivedPosts.map((post) => String(post.postUid)));
  state.posts = currentPosts.filter((post) => !receivedUids.has(String(post.postUid)));
  state.postState.recvCount += receivedPosts.length;
  const nameCard = getOfficeCatalog().nameCard;
  const reward = grantRewardByType(
    ctx,
    user,
    "RT_MISC",
    nameCard.itemId,
    nameCard.itemValue * receivedPosts.length,
    null,
    0,
    { regDate: officeNowBinary(ctx), expandPackages: false }
  );
  const remainingPosts = state.posts.slice(0, MAX_POST_COUNT_PER_PAGE);
  return ack(PACKETS.OFFICE_POST_RECV_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildRewardData(reward)),
    writeNullableObjectList(remainingPosts.map(buildOfficePostData)),
    writeSignedVarInt(state.posts.length),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `recv=${receivedPosts.length} remain=${state.posts.length}`);
}

function handlePostBroadcast(ctx, user, req) {
  if (!req.valid) return postBroadcastAck(OFFICE_ERROR.INVALID_REQUEST, user);
  const previewUser = structuredClone(user);
  const previewState = ensureOfficeState(previewUser);
  resetOfficePostState(ctx, previewState);
  if (previewState.postState.broadcastExecution) return postBroadcastAck(OFFICE_ERROR.POST_SEND_DAILY_LIMIT, user);
  const targets = getOfficePostFriendTargets(ctx, user);
  if (!targets.length) return postBroadcastAck(OFFICE_ERROR.POST_NO_FRIENDSHIP_EXIST, user);

  const state = ensureOfficeState(user);
  resetOfficePostState(ctx, state);
  const alreadySent = new Set(state.postState.sentTargetUserUids);
  let sentCount = 0;
  for (const target of targets) {
    const targetUid = normalizeUidString(target.userUid);
    if (alreadySent.has(targetUid)) continue;
    appendOfficePost(target, user);
    state.postState.sentTargetUserUids.push(targetUid);
    alreadySent.add(targetUid);
    sentCount += 1;
  }
  state.postState.broadcastExecution = true;
  return ack(PACKETS.OFFICE_POST_BROADCAST_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `broadcast=1 sent=${sentCount}`);
}

function handlePostSend(ctx, user, req) {
  const receiverUserUid = toBigInt(req.receiverUserUid || 0);
  if (!req.valid || receiverUserUid <= 0n) return postSendAck(OFFICE_ERROR.INVALID_REQUEST, receiverUserUid, user);
  if (receiverUserUid === toBigInt(user && user.userUid || 0)) return postSendAck(OFFICE_ERROR.POST_MYSELF, receiverUserUid, user);
  const target = findOfficeUser(ctx, user, receiverUserUid);
  if (!target || (!target.hasOffice && !target.office)) return postSendAck(OFFICE_ERROR.PROFILE_NOT_FOUND, receiverUserUid, user);

  const previewUser = structuredClone(user);
  const previewState = ensureOfficeState(previewUser);
  resetOfficePostState(ctx, previewState);
  const receiverUid = String(receiverUserUid);
  const errorCode = previewState.postState.sentTargetUserUids.includes(receiverUid)
    ? OFFICE_ERROR.POST_ALREADY_SEND_TARGET
    : previewState.postState.sendCount >= NAME_CARD_SEND_DAILY_LIMIT
      ? OFFICE_ERROR.POST_DAILY_LIMIT_FULL
      : 0;
  if (errorCode) return postSendAck(errorCode, receiverUserUid, user);

  const state = ensureOfficeState(user);
  resetOfficePostState(ctx, state);
  appendOfficePost(target, user);
  state.postState.sendCount += 1;
  state.postState.sentTargetUserUids.push(receiverUid);
  return ack(PACKETS.OFFICE_POST_SEND_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(receiverUserUid),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `receiver=${receiverUid}`);
}

function postRecvAck(errorCode, user) {
  const state = ensureOfficeState(structuredClone(user));
  return ack(PACKETS.OFFICE_POST_RECV_ACK, [
    writeSignedVarInt(errorCode),
    writeNullableObject(buildRewardData(createEmptyReward())),
    writeNullableObjectList([]),
    writeSignedVarInt(getActiveOfficePosts(state).length),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `recv=0 error=${errorCode}`, false);
}

function postBroadcastAck(errorCode, user) {
  const state = ensureOfficeState(structuredClone(user));
  return ack(PACKETS.OFFICE_POST_BROADCAST_ACK, [
    writeSignedVarInt(errorCode),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `broadcast=0 error=${errorCode}`, false);
}

function postSendAck(errorCode, receiverUserUid, user) {
  const state = ensureOfficeState(structuredClone(user));
  return ack(PACKETS.OFFICE_POST_SEND_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarLong(toBigInt(receiverUserUid || 0)),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `receiver=${toBigInt(receiverUserUid || 0)} error=${errorCode}`, false);
}

function getOfficePostFriendTargets(ctx, user) {
  const ownUid = normalizeUidString(user && user.userUid);
  const friendUids = new Set(
    (user && user.community && Array.isArray(user.community.friends) ? user.community.friends : [])
      .map(normalizeUidString)
      .filter((uid) => uid !== "0" && uid !== ownUid)
  );
  return Object.values(ctx && ctx.userDb && ctx.userDb.users || {})
    .filter((target) => friendUids.has(normalizeUidString(target && target.userUid)) && Boolean(target && (target.hasOffice || target.office)))
    .sort((left, right) => normalizeUidString(left.userUid).localeCompare(normalizeUidString(right.userUid)));
}

function appendOfficePost(target, sender) {
  const state = ensureOfficeState(target);
  const postUid = toBigInt(state.nextPostUid || 1, 1n);
  state.nextPostUid = String(postUid + 1n);
  state.posts.push({
    postUid: String(postUid),
    senderProfile: snapshotOfficePostProfile(sender),
    senderGuildData: snapshotOfficePostGuild(sender),
    expirationDate: String(farFutureDateTimeBinary()),
  });
  state.posts.sort((left, right) => compareBigIntsDesc(left.postUid, right.postUid));
  return state.posts[0];
}

function snapshotOfficePostProfile(user) {
  return {
    userUid: normalizeUidString(user && user.userUid),
    friendCode: normalizeUidString(user && user.friendCode),
    nickname: String(user && user.nickname || "LocalAdmin"),
    level: Math.max(1, Number(user && user.level || 1) || 1),
    mainUnitId: positiveInt(user && user.mainUnitId),
    mainUnitSkinId: positiveInt(user && user.mainUnitSkinId),
    frameId: positiveInt(user && (user.frameId || user.selfiFrameId)),
    mainUnitTacticLevel: positiveInt(user && user.mainUnitTacticLevel),
    titleId: positiveInt(user && user.titleId),
  };
}

function snapshotOfficePostGuild(user) {
  const guild = user && user.guildData && typeof user.guildData === "object" ? user.guildData : {};
  return {
    guildUid: normalizeUidString(user && user.guildUid != null ? user.guildUid : guild.guildUid),
    guildName: String(user && user.guildName || guild.guildName || guild.name || ""),
    badgeId: normalizeUidString(user && user.guildBadgeId != null ? user.guildBadgeId : guild.badgeId),
  };
}

function getActiveOfficePosts(state, nowBinary = dateTimeBinaryNow()) {
  const nowTicks = rawTicksFromDateTime(nowBinary);
  return (Array.isArray(state && state.posts) ? state.posts : [])
    .filter((post) => rawTicksFromDateTime(post.expirationDate) > nowTicks)
    .sort((left, right) => compareBigIntsDesc(left.postUid, right.postUid));
}

function resetOfficePostState(ctx, state) {
  const now = getOfficeNowDate(ctx);
  const key = officeDailyResetKey(now);
  const postState = state.postState;
  const nextResetTicks = rawTicksFromDateTime(postState.nextResetDate);
  const nowTicks = rawTicksFromDateTime(dateTimeBinaryForDate(now));
  const expired = nextResetTicks <= nowTicks;
  if ((postState.dailyResetKey && postState.dailyResetKey !== key) || expired) {
    postState.broadcastExecution = false;
    postState.sendCount = 0;
    postState.recvCount = 0;
    postState.sentTargetUserUids = [];
  }
  postState.dailyResetKey = key;
  postState.nextResetDate = String(dateTimeBinaryForDate(nextOfficeDailyResetDate(now)));
}

function getOfficeNowDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const value = ctx.getServerNowDate();
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  }
  if (ctx && ctx.serverTime && typeof ctx.serverTime.now === "function") {
    const value = ctx.serverTime.now();
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  }
  const binary = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
  return dateFromDateTime(binary) || new Date();
}

function officeNowBinary(ctx) {
  return dateTimeBinaryForDate(getOfficeNowDate(ctx));
}

function officeDailyResetKey(date) {
  return new Date(date.getTime() - OFFICE_DAILY_RESET_HOUR_UTC * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nextOfficeDailyResetDate(date) {
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), OFFICE_DAILY_RESET_HOUR_UTC);
  return new Date(date.getTime() < today ? today : today + 24 * 60 * 60 * 1000);
}

function compareBigIntsDesc(left, right) {
  const a = toBigInt(left || 0);
  const b = toBigInt(right || 0);
  return a === b ? 0 : a > b ? -1 : 1;
}

function handleRandomVisit(ctx, user, req) {
  if (!req.valid) {
    return ack(PACKETS.OFFICE_RANDOM_VISIT_ACK, [
      writeSignedVarInt(OFFICE_ERROR.INVALID_REQUEST),
      writeNullObject(),
    ], `error=${OFFICE_ERROR.INVALID_REQUEST}`, false);
  }
  const ownUid = String(toBigInt(user && user.userUid || 0));
  const candidates = Object.values(ctx && ctx.userDb && ctx.userDb.users || {})
    .filter((entry) => String(toBigInt(entry && entry.userUid || 0)) !== ownUid && Boolean(entry && (entry.hasOffice || entry.office)))
    .sort((left, right) => String(toBigInt(left && left.userUid || 0)).localeCompare(String(toBigInt(right && right.userUid || 0))));
  const target = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  if (!target) {
    return ack(PACKETS.OFFICE_RANDOM_VISIT_ACK, [
      writeSignedVarInt(OFFICE_ERROR.NO_VISITOR_AVAILABLE),
      writeNullObject(),
    ], `error=${OFFICE_ERROR.NO_VISITOR_AVAILABLE}`, false);
  }
  return ack(PACKETS.OFFICE_RANDOM_VISIT_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeVisitStateData(structuredClone(target))),
  ], `uid=${toBigInt(target.userUid || 0)}`, false);
}

function handleParty(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  if (!req.valid) return partyAck(OFFICE_ERROR.INVALID_REQUEST, roomId);

  const previewUser = structuredClone(user);
  const previewState = ensureOfficeState(previewUser);
  const previewRoom = previewState.rooms.find((room) => room.id === roomId);
  if (!previewRoom) return partyAck(OFFICE_ERROR.ROOM_NOT_OPEN, roomId);
  const previewArmy = ensureArmy(previewUser);
  const previewUnits = previewRoom.unitUids
    .map((uid) => previewArmy.units[uid] || previewArmy.trophies[uid] || null)
    .filter(Boolean);
  if (!previewUnits.length) return partyAck(OFFICE_ERROR.PARTY_NO_UNIT, roomId);

  const catalog = getOfficeCatalog();
  const useItemId = catalog.partyUseItemId;
  const inventory = ensureInventory(previewUser);
  const useItem = inventory.misc[String(useItemId)];
  if (toBigInt(useItem && useItem.countFree) + toBigInt(useItem && useItem.countPaid) < 1n) {
    return partyAck(OFFICE_ERROR.INSUFFICIENT_ITEM, roomId);
  }

  const now = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
  const room = ensureOfficeState(user).rooms.find((entry) => entry.id === roomId);
  const army = ensureArmy(user);
  const units = room.unitUids.map((uid) => army.units[uid] || army.trophies[uid] || null).filter(Boolean);
  const grade = clampInt(room.grade, 0, catalog.gradeRows.length - 1, 0);
  const gradeRow = catalog.gradeRows[grade] || {};
  const loyaltyGain = Math.max(0, Number(gradeRow.PartyRewardLoyalty || 0) || 0);
  for (const unit of units) {
    if (!army.units[normalizeUidString(unit.unitUid || unit.m_UnitUID)] || unit.isPermanentContract) continue;
    unit.loyalty = Math.min(10000, Math.max(0, Number(unit.loyalty || 0)) + loyaltyGain);
  }

  const rewardMin = Math.max(0, Number(gradeRow.PartyRewardValue_Min || 0) || 0);
  const rewardMax = Math.max(rewardMin, Number(gradeRow.PartyRewardValue_Max || rewardMin) || rewardMin);
  const rewardValue = rewardMin + officeRandomInt(ctx, rewardMax - rewardMin + 1);
  const costItem = spendMiscItem(user, useItemId, 1n, { regDate: now });
  const reward = grantRewardByType(
    ctx,
    user,
    gradeRow.PartyRewardType,
    gradeRow.PartyRewardId,
    rewardValue,
    null,
    0,
    { regDate: now, expandPackages: false }
  );
  const response = ack(PACKETS.OFFICE_PARTY_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(room.id),
    writeNullableObjectList(units.map(buildUnitData)),
    writeNullableObjectList(costItem ? [buildItemMiscData(costItem)] : []),
    writeNullableObject(buildRewardData(reward)),
  ], `room=${room.id} units=${units.length} reward=${rewardValue}`);
  response.mission = {
    condition: "USE_RESOURCE",
    amount: 1,
    details: { itemId: useItemId, resourceId: useItemId, value: useItemId },
  };
  return response;
}

function partyAck(errorCode, roomId) {
  return ack(PACKETS.OFFICE_PARTY_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarInt(roomId),
    writeNullableObjectList([]),
    writeNullableObjectList([]),
    writeNullObject(),
  ], `room=${roomId} error=${errorCode}`, false);
}

function officeRandomInt(ctx, maxExclusive) {
  const max = Math.max(1, Math.trunc(Number(maxExclusive) || 1));
  if (ctx && typeof ctx.randomInt === "function") return clampInt(ctx.randomInt(max), 0, max - 1, 0);
  return cryptoRandomInt(max);
}

function handlePresetRegister(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const presetId = Number.isInteger(req.presetId) ? req.presetId : -1;
  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((entry) => entry.id === roomId);
  const previewPreset = getOfficePreset(preview, presetId);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !previewPreset
      ? OFFICE_ERROR.PRESET_INVALID_INDEX
      : !previewRoom
        ? OFFICE_ERROR.ROOM_NOT_OPEN
        : isEmptyOfficeRoom(previewRoom)
          ? OFFICE_ERROR.PRESET_DATA
          : 0;
  if (errorCode) return presetRegisterAck(errorCode, roomId, presetId);

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const preset = getOfficePreset(state, presetId);
  preset.furnitures = room.furnitures.map(cloneFurniture);
  preset.floorInteriorId = room.floorInteriorId;
  preset.wallInteriorId = room.wallInteriorId;
  preset.backgroundId = room.backgroundId;
  return ack(PACKETS.OFFICE_PRESET_REGISTER_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficePresetData(preset)),
  ], `preset=${preset.presetId} room=${room.id}`);
}

function presetRegisterAck(errorCode, roomId, presetId) {
  return ack(PACKETS.OFFICE_PRESET_REGISTER_ACK, [
    writeSignedVarInt(errorCode),
    writeNullObject(),
  ], `preset=${presetId} room=${roomId} error=${errorCode}`, false);
}

function handlePresetApply(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const presetId = Number.isInteger(req.presetId) ? req.presetId : -1;
  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((entry) => entry.id === roomId);
  const previewPreset = getOfficePreset(preview, presetId);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !previewPreset
      ? OFFICE_ERROR.PRESET_INVALID_INDEX
      : !previewRoom
        ? OFFICE_ERROR.ROOM_NOT_OPEN
        : isEmptyOfficePreset(previewPreset) || !isValidOfficePreset(previewRoom, previewPreset)
          ? OFFICE_ERROR.PRESET_DATA
          : 0;
  if (errorCode) return presetApplyAck(errorCode, roomId, presetId);

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const result = applyOfficePreset(user, room, getOfficePreset(state, presetId));
  return ack(PACKETS.OFFICE_PRESET_APPLY_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(presetId),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(result.updatedUnits.map(buildUnitData)),
    writeNullableObjectList(result.changedInteriors.map(buildInteriorData)),
  ], `preset=${presetId} room=${room.id} placed=${room.furnitures.length}`);
}

function presetApplyAck(errorCode, roomId, presetId) {
  return ack(PACKETS.OFFICE_PRESET_APPLY_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarInt(presetId),
    writeNullObject(),
    writeNullableObjectList([]),
    writeNullableObjectList([]),
  ], `preset=${presetId} room=${roomId} error=${errorCode}`, false);
}

function handlePresetAdd(ctx, user, req) {
  const addCount = Number.isInteger(req.addPresetCount) ? req.addPresetCount : 0;
  const previewUser = structuredClone(user);
  const preview = ensureOfficeState(previewUser);
  const config = getOfficeCatalog().preset;
  const total = preview.presets.length;
  const cost = BigInt(addCount > 0 ? addCount * config.expandCost : 0);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : addCount <= 0 || total + addCount > config.maxCount
      ? OFFICE_ERROR.PRESET_INVALID_ADD_COUNT
      : getMiscBalance(previewUser, config.expandItemId) < cost
        ? OFFICE_ERROR.INSUFFICIENT_CASH
        : 0;
  if (errorCode) return presetAddAck(errorCode, total);

  const state = ensureOfficeState(user);
  for (let index = 0; index < addCount; index += 1) state.presets.push(defaultPreset(state.presets.length));
  const costItem = spendMiscItem(user, config.expandItemId, cost, {
    regDate: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow(),
  });
  const response = ack(PACKETS.OFFICE_PRESET_ADD_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(state.presets.length),
    writeNullableObjectList(costItem ? [buildItemMiscData(costItem)] : []),
  ], `added=${addCount} total=${state.presets.length} cost=${cost}`);
  response.mission = {
    condition: "USE_RESOURCE",
    amount: Number(cost),
    details: { itemId: config.expandItemId, resourceId: config.expandItemId, value: config.expandItemId },
  };
  return response;
}

function presetAddAck(errorCode, totalPresetCount) {
  return ack(PACKETS.OFFICE_PRESET_ADD_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarInt(totalPresetCount),
    writeNullableObjectList([]),
  ], `total=${totalPresetCount} error=${errorCode}`, false);
}

function handlePresetChangeName(ctx, user, req) {
  const presetId = Number.isInteger(req.presetId) ? req.presetId : -1;
  const preview = ensureOfficeState(structuredClone(user));
  const previewPreset = getOfficePreset(preview, presetId);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !previewPreset
      ? OFFICE_ERROR.PRESET_INVALID_INDEX
      : !isValidPresetName(req.newPresetName)
        ? OFFICE_ERROR.PRESET_INVALID_NAME
        : 0;
  if (errorCode) return presetChangeNameAck(errorCode, presetId, req.newPresetName);

  const preset = getOfficePreset(ensureOfficeState(user), presetId);
  const changed = preset.name !== req.newPresetName;
  preset.name = req.newPresetName;
  return ack(PACKETS.OFFICE_PRESET_CHANGE_NAME_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(presetId),
    writeString(preset.name),
  ], `preset=${presetId}`, changed);
}

function presetChangeNameAck(errorCode, presetId, name) {
  return ack(PACKETS.OFFICE_PRESET_CHANGE_NAME_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarInt(presetId),
    writeString(typeof name === "string" ? name : ""),
  ], `preset=${presetId} error=${errorCode}`, false);
}

function handlePresetReset(ctx, user, req) {
  const presetId = Number.isInteger(req.presetId) ? req.presetId : -1;
  const preview = ensureOfficeState(structuredClone(user));
  if (!req.valid) return presetResetAck(OFFICE_ERROR.INVALID_REQUEST, presetId);
  if (!getOfficePreset(preview, presetId)) return presetResetAck(OFFICE_ERROR.PRESET_INVALID_INDEX, presetId);

  const state = ensureOfficeState(user);
  const preset = getOfficePreset(state, presetId);
  const changed = !isEmptyOfficePreset(preset);
  state.presets[presetId] = { ...defaultPreset(presetId), name: preset.name };
  return ack(PACKETS.OFFICE_PRESET_RESET_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(presetId),
  ], `preset=${presetId}`, changed);
}

function presetResetAck(errorCode, presetId) {
  return ack(PACKETS.OFFICE_PRESET_RESET_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarInt(presetId),
  ], `preset=${presetId} error=${errorCode}`, false);
}

function handlePresetApplyThema(ctx, user, req) {
  const roomId = positiveInt(req.roomId);
  const themeId = positiveInt(req.themaIndex);
  const preview = ensureOfficeState(structuredClone(user));
  const previewRoom = preview.rooms.find((entry) => entry.id === roomId);
  const theme = getOfficeCatalog().themeById.get(themeId);
  const errorCode = !req.valid
    ? OFFICE_ERROR.INVALID_REQUEST
    : !previewRoom
      ? OFFICE_ERROR.ROOM_NOT_OPEN
      : !theme || !theme.preset || !isEffectiveTagOpen(ctx, user, theme.OpenTag) || !isValidOfficePreset(previewRoom, theme.preset)
        ? OFFICE_ERROR.PRESET_THEME_TEMPLET
        : 0;
  if (errorCode) return presetApplyThemeAck(errorCode, roomId, themeId);

  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === roomId);
  const result = applyOfficePreset(user, room, theme.preset);
  return ack(PACKETS.OFFICE_PRESET_APPLY_THEMA_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(themeId),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(result.updatedUnits.map(buildUnitData)),
    writeNullableObjectList(result.changedInteriors.map(buildInteriorData)),
  ], `theme=${themeId} room=${room.id} placed=${room.furnitures.length}`);
}

function presetApplyThemeAck(errorCode, roomId, themeId) {
  return ack(PACKETS.OFFICE_PRESET_APPLY_THEMA_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarInt(themeId),
    writeNullObject(),
    writeNullableObjectList([]),
    writeNullableObjectList([]),
  ], `theme=${themeId} room=${roomId} error=${errorCode}`, false);
}

function buildMyOfficeStateData(user) {
  const state = ensureOfficeState(user);
  return Buffer.concat([
    writeIntList(state.openedSectionIds),
    writeNullableObjectList(state.rooms.map(buildOfficeRoomData)),
    writeNullableObjectList(state.interiors.map(buildInteriorData)),
    writeNullableObject(buildOfficePostStateData(state.postState)),
    writeNullableObjectList(state.presets.map(buildOfficePresetData)),
  ]);
}

function buildOfficeVisitStateData(user) {
  const state = ensureOfficeState(user);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeIntList(state.openedSectionIds),
    writeNullableObjectList(state.rooms.map(buildOfficeRoomData)),
    writeNullableObjectList(buildOfficeUnitDataList(user).map(buildOfficeUnitData)),
  ]);
}

function buildOfficeGuestListNotData(users = []) {
  const guestList = Array.isArray(users) ? users : [];
  return writeNullableObjectList(guestList.map(buildUserProfileData));
}

function getOfficeGuestProfiles(ctx, user, limit = 4) {
  const ownUid = normalizeUidString(user && user.userUid);
  return Object.values(ctx && ctx.userDb && ctx.userDb.users || {})
    .filter((entry) => {
      const uid = normalizeUidString(entry && entry.userUid);
      return uid !== "0" && uid !== ownUid && Boolean(entry && (entry.hasOffice || entry.office));
    })
    .sort((left, right) => normalizeUidString(left.userUid).localeCompare(normalizeUidString(right.userUid)))
    .slice(0, Math.max(0, Number(limit || 0) || 0));
}

function buildOfficeRoomData(room) {
  const data = normalizeRoom(room);
  return Buffer.concat([
    writeSignedVarInt(data.id),
    writeString(data.name),
    writeSignedVarInt(data.grade),
    writeSignedVarInt(data.interiorScore),
    writeNullableObjectList(data.furnitures.map(buildOfficeFurnitureData)),
    writeLongArray(data.unitUids.map(toBigInt)),
    writeSignedVarInt(data.floorInteriorId),
    writeSignedVarInt(data.wallInteriorId),
    writeSignedVarInt(data.backgroundId),
  ]);
}

function buildOfficeFurnitureData(furniture) {
  const data = normalizeFurniture(furniture);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.uid)),
    writeSignedVarInt(data.itemId),
    writeSignedVarInt(data.planeType),
    writeSignedVarInt(data.positionX),
    writeSignedVarInt(data.positionY),
    writeBool(data.inverted),
  ]);
}

function buildInteriorData(interior) {
  const data = normalizeInterior(interior);
  return Buffer.concat([
    writeSignedVarInt(data.itemId),
    writeSignedVarLong(toBigInt(data.count)),
  ]);
}

function buildOfficePostStateData(postState = {}) {
  return Buffer.concat([
    writeBool(Boolean(postState.broadcastExecution)),
    writeSignedVarInt(Number(postState.sendCount || 0) || 0),
    writeSignedVarInt(Number(postState.recvCount || 0) || 0),
    writeInt64LE(toBigInt(postState.nextResetDate || farFutureDateTimeBinary())),
  ]);
}

function buildOfficePostData(post = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(post.postUid || 0)),
    writeNullableObject(buildCommonProfileData(post.senderProfile || {})),
    writeNullableObject(buildOfficePostGuildData(post.senderGuildData)),
    writeInt64LE(toBigInt(post.expirationDate || farFutureDateTimeBinary())),
  ]);
}

function buildOfficePostGuildData(guild = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(guild.guildUid || 0)),
    writeString(String(guild.guildName || "")),
    writeSignedVarLong(toBigInt(guild.badgeId || 0)),
  ]);
}

function buildOfficePresetData(preset) {
  const data = normalizePreset(preset);
  return Buffer.concat([
    writeSignedVarInt(data.presetId),
    writeString(data.name),
    writeNullableObjectList(data.furnitures.map(buildOfficeFurnitureData)),
    writeSignedVarInt(data.floorInteriorId),
    writeSignedVarInt(data.wallInteriorId),
    writeSignedVarInt(data.backgroundId),
  ]);
}

function buildOfficeUnitData(unit) {
  const data = unit || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid || data.uid || 0)),
    writeSignedVarInt(positiveInt(data.unitId)),
    writeSignedVarInt(positiveInt(data.skinId)),
  ]);
}

function ensureOfficeState(user) {
  if (!user || typeof user !== "object") return defaultOfficeState();
  user.office = user.office && typeof user.office === "object" ? user.office : {};
  const state = user.office;
  state.openedSectionIds = uniquePositiveInts(state.openedSectionIds && state.openedSectionIds.length ? state.openedSectionIds : DEFAULT_SECTION_IDS);
  state.rooms = normalizeRooms(state.rooms);
  state.interiors = normalizeInteriors(state.interiors);
  state.postState = normalizePostState(state.postState);
  state.posts = normalizeOfficePosts(state.posts);
  state.presets = normalizePresets(state.presets);
  state.nextFurnitureUid = String(toBigInt(state.nextFurnitureUid || findMaxFurnitureUid(state.rooms) + 1n, 1n));
  state.nextPostUid = String(toBigInt(state.nextPostUid || findMaxOfficePostUid(state.posts) + 1n, 1n));
  user.hasOffice = true;
  return state;
}

function defaultOfficeState() {
  return {
    openedSectionIds: DEFAULT_SECTION_IDS.slice(),
    rooms: DEFAULT_ROOM_IDS.map(defaultRoom),
    interiors: defaultInteriors(),
    postState: normalizePostState(),
    posts: [],
    presets: Array.from({ length: DEFAULT_PRESET_COUNT }, (_, index) => defaultPreset(index)),
    nextFurnitureUid: "1",
    nextPostUid: "1",
  };
}

function normalizeRooms(rooms) {
  const byId = new Map();
  for (const room of Array.isArray(rooms) ? rooms : []) {
    const normalized = normalizeRoom(room);
    if (normalized.id > 0 && !byId.has(normalized.id)) byId.set(normalized.id, normalized);
  }
  for (const roomId of DEFAULT_ROOM_IDS) {
    if (!byId.has(roomId)) byId.set(roomId, defaultRoom(roomId));
  }
  return Array.from(byId.values()).sort((left, right) => left.id - right.id);
}

function normalizeRoom(room = {}) {
  const id = positiveInt(room.id || room.roomId || room.ID) || 1;
  const normalized = {
    id,
    name: normalizeRoomName(room.name),
    grade: clampInt(room.grade, 0, 5, 0),
    interiorScore: Math.max(0, Number(room.interiorScore || 0) || 0),
    furnitures: Array.isArray(room.furnitures) ? room.furnitures.map(normalizeFurniture).filter((furniture) => furniture.uid !== "0") : [],
    unitUids: uniqueBigIntStrings(room.unitUids),
    floorInteriorId: positiveInt(room.floorInteriorId) || DEFAULT_FLOOR_ID,
    wallInteriorId: positiveInt(room.wallInteriorId) || DEFAULT_WALL_ID,
    backgroundId: positiveInt(room.backgroundId) || DEFAULT_BACKGROUND_ID,
  };
  recalculateRoomGrade(normalized);
  return normalized;
}

function defaultRoom(roomId) {
  const id = positiveInt(roomId) || 1;
  const room = {
    id,
    name: "",
    grade: 0,
    interiorScore: 0,
    furnitures: [],
    unitUids: [],
    floorInteriorId: DEFAULT_FLOOR_ID,
    wallInteriorId: DEFAULT_WALL_ID,
    backgroundId: DEFAULT_BACKGROUND_ID,
  };
  recalculateRoomGrade(room);
  return room;
}

function normalizeFurniture(furniture = {}) {
  return {
    uid: normalizeUidString(furniture.uid || furniture.furnitureUid),
    itemId: positiveInt(furniture.itemId),
    planeType: clampInt(furniture.planeType, 0, 11, 0),
    positionX: clampInt(furniture.positionX, -9999, 9999, 0),
    positionY: clampInt(furniture.positionY, -9999, 9999, 0),
    inverted: Boolean(furniture.inverted),
  };
}

function normalizeInteriors(interiors) {
  const byId = new Map();
  for (const interior of Array.isArray(interiors) ? interiors : []) {
    const normalized = normalizeInterior(interior);
    if (normalized.itemId > 0) byId.set(normalized.itemId, normalized);
  }
  for (const interior of defaultInteriors()) {
    if (!byId.has(interior.itemId)) byId.set(interior.itemId, interior);
  }
  return Array.from(byId.values()).sort((left, right) => left.itemId - right.itemId);
}

function normalizeInterior(interior = {}) {
  return {
    itemId: positiveInt(interior.itemId || interior.id),
    count: String(toBigInt(interior.count != null ? interior.count : 0)),
  };
}

function normalizePostState(postState = {}) {
  return {
    broadcastExecution: Boolean(postState.broadcastExecution),
    sendCount: Math.max(0, Number(postState.sendCount || 0) || 0),
    recvCount: Math.max(0, Number(postState.recvCount || 0) || 0),
    nextResetDate: String(toBigInt(postState.nextResetDate || farFutureDateTimeBinary())),
    dailyResetKey: String(postState.dailyResetKey || ""),
    sentTargetUserUids: uniqueBigIntStrings(postState.sentTargetUserUids),
  };
}

function normalizeOfficePosts(posts) {
  const byUid = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    const postUid = normalizeUidString(post && post.postUid);
    if (postUid === "0") continue;
    byUid.set(postUid, {
      postUid,
      senderProfile: snapshotOfficePostProfile(post && post.senderProfile),
      senderGuildData: snapshotOfficePostGuild(post && post.senderGuildData),
      expirationDate: String(toBigInt(post && post.expirationDate || farFutureDateTimeBinary())),
    });
  }
  return Array.from(byUid.values()).sort((left, right) => compareBigIntsDesc(left.postUid, right.postUid));
}

function findMaxOfficePostUid(posts) {
  let max = 0n;
  for (const post of Array.isArray(posts) ? posts : []) {
    const uid = toBigInt(post && post.postUid || 0);
    if (uid > max) max = uid;
  }
  return max;
}

function normalizePresets(presets) {
  const byId = new Map();
  for (const preset of Array.isArray(presets) ? presets : []) {
    const normalized = normalizePreset(preset);
    if (normalized.presetId >= 0 && normalized.presetId < MAX_PRESET_COUNT) byId.set(normalized.presetId, normalized);
  }
  const highestId = Math.max(DEFAULT_PRESET_COUNT - 1, ...byId.keys());
  const count = Math.min(MAX_PRESET_COUNT, highestId + 1);
  for (let id = 0; id < count; id += 1) {
    if (!byId.has(id)) byId.set(id, defaultPreset(id));
  }
  return Array.from({ length: count }, (_, id) => byId.get(id));
}

function normalizePreset(preset = {}) {
  const presetId = nonNegativeInt(preset.presetId, -1);
  return {
    presetId,
    name: typeof preset.name === "string" ? preset.name.slice(0, PRESET_NAME_MAX_LENGTH) : "",
    furnitures: Array.isArray(preset.furnitures) ? preset.furnitures.map(cloneFurniture) : [],
    floorInteriorId: positiveInt(preset.floorInteriorId),
    wallInteriorId: positiveInt(preset.wallInteriorId),
    backgroundId: positiveInt(preset.backgroundId),
  };
}

function defaultPreset(presetId) {
  const id = nonNegativeInt(presetId);
  return {
    presetId: id,
    name: "",
    furnitures: [],
    floorInteriorId: 0,
    wallInteriorId: 0,
    backgroundId: 0,
  };
}

function defaultInteriors() {
  const rows = getOfficeCatalog().interiorRows;
  if (!rows.length) {
    return [
      { itemId: DEFAULT_BACKGROUND_ID, count: "1" },
      { itemId: DEFAULT_WALL_ID, count: "1" },
      { itemId: DEFAULT_FLOOR_ID, count: "1" },
    ];
  }
  return rows
    .filter((row) => positiveInt(row && row.m_ItemMiscID) > 0)
    .map((row) => {
      const itemId = positiveInt(row.m_ItemMiscID);
      const maxStack = positiveInt(row.MaxStack);
      const subtype = String(row.m_ItemMiscSubType || "");
      const isDefault = itemId === DEFAULT_BACKGROUND_ID || itemId === DEFAULT_WALL_ID || itemId === DEFAULT_FLOOR_ID;
      const count = isDefault ? 1 : subtype.includes("FURNITURE") ? Math.min(Math.max(maxStack || 20, 1), 20) : 1;
      return { itemId, count: String(count) };
    });
}

function ensureOfficeRoom(user, roomId) {
  const state = ensureOfficeState(user);
  const normalizedId = positiveInt(roomId) || 1;
  let room = state.rooms.find((item) => item.id === normalizedId);
  if (!room) {
    room = defaultRoom(normalizedId);
    state.rooms.push(room);
    state.rooms.sort((left, right) => left.id - right.id);
  }
  return room;
}

function getOfficeRooms(user) {
  return ensureOfficeState(user).rooms;
}

function getOfficeInteriors(user) {
  return ensureOfficeState(user).interiors;
}

function isOfficeInteriorItem(itemId) {
  return getOfficeCatalog().interiorById.has(positiveInt(itemId));
}

function grantOfficeInterior(user, itemId, count = 1) {
  return adjustInteriorCount(user, itemId, count);
}

function openRoomsForSection(state, sectionId) {
  const catalogRows = getSectionStarterRoomRows(sectionId);
  const roomIds = catalogRows.length ? catalogRows.map((row) => positiveInt(row.ID)) : [sectionId];
  const opened = [];
  for (const roomId of roomIds) {
    let room = state.rooms.find((item) => item.id === roomId);
    if (!room) {
      room = defaultRoom(roomId);
      state.rooms.push(room);
      opened.push(room);
    }
  }
  state.rooms.sort((left, right) => left.id - right.id);
  return opened;
}

function openSectionForRoom(state, roomId) {
  const row = getOfficeCatalog().roomById.get(positiveInt(roomId));
  const sectionId = positiveInt(row && row.SectionID);
  if (sectionId && !state.openedSectionIds.includes(sectionId)) {
    state.openedSectionIds.push(sectionId);
    state.openedSectionIds = uniquePositiveInts(state.openedSectionIds);
  }
}

function getRoomUnitLimit(roomId) {
  const row = getOfficeCatalog().roomById.get(positiveInt(roomId));
  return Math.max(0, Number(row && row.UnitLimit) || 0);
}

function isOfficeAssignableUnit(user, unitUid) {
  const army = ensureArmy(user);
  const uid = normalizeUidString(unitUid);
  return Boolean(army.units[uid] || army.trophies[uid]) && Boolean(getArmyUnitByUid(user, uid));
}

function sameUidSet(left, right) {
  const leftValues = (Array.isArray(left) ? left : []).map(normalizeUidString);
  const rightValues = (Array.isArray(right) ? right : []).map(normalizeUidString);
  if (leftValues.length !== rightValues.length) return false;
  const rightSet = new Set(rightValues);
  return leftValues.every((uid) => rightSet.has(uid));
}

function defaultRoomName(roomId) {
  const row = getOfficeCatalog().roomById.get(positiveInt(roomId));
  if (row && row.Name) return String(row.Name);
  return `Room ${positiveInt(roomId) || 1}`;
}

function getSectionStarterRoomRows(sectionId) {
  const catalogRows = getOfficeCatalog().roomRows
    .filter((row) => positiveInt(row.SectionID) === sectionId)
    .sort((left, right) => positiveInt(left && left.ID) - positiveInt(right && right.ID));
  const starterRows = catalogRows.filter((row) => !positiveInt(row && row.PriceItemID) && !hasUnlockRequirement(row));
  return starterRows.length ? starterRows : catalogRows.slice(0, 1);
}

function hasUnlockRequirement(row) {
  if (!row || typeof row !== "object") return false;
  const type = String(row.UnlockReqType || "");
  return type.length > 0 && type !== "SURT_CLEAR_WARFARE" && positiveInt(row.UnlockReqValue) > 0;
}

function isOfficeRoomUnlockRequirementMet(state, row) {
  const type = String(row && row.UnlockReqType || "");
  const value = positiveInt(row && row.UnlockReqValue);
  if (!type || !value) return true;
  if (type === "SURT_OPEN_ROOM") return state.rooms.some((room) => room.id === value);
  return false;
}

function officeUnlockCostError(user, row) {
  const itemId = positiveInt(row && row.PriceItemID);
  const price = toBigInt(row && row.Price || 0);
  if (!itemId || price <= 0n) return 0;
  const item = user && user.inventory && user.inventory.misc && user.inventory.misc[String(itemId)];
  const balance = toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
  if (balance >= price) return 0;
  return COMMON_RESOURCE_ITEM_IDS.includes(itemId) ? OFFICE_ERROR.INSUFFICIENT_CASH : OFFICE_ERROR.INSUFFICIENT_RESOURCE;
}

function spendOfficeUnlockCost(ctx, user, row) {
  const itemId = positiveInt(row && row.PriceItemID);
  const price = positiveInt(row && row.Price);
  if (!itemId || !price) return [];
  const regDate = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
  const item = spendMiscItem(user, itemId, BigInt(price), { regDate });
  return item ? [item] : [];
}

function adjustInteriorCount(user, itemId, delta, options = {}) {
  const state = ensureOfficeState(user);
  return adjustInteriorCountInState(state, itemId, delta, options);
}

function adjustInteriorCountInState(state, itemId, delta, options = {}) {
  const id = positiveInt(itemId);
  let interior = state.interiors.find((entry) => entry.itemId === id);
  if (!interior) {
    interior = { itemId: id, count: "0" };
    if (id > 0) state.interiors.push(interior);
  }
  const next = toBigInt(interior.count) + BigInt(Math.trunc(Number(delta || 0) || 0));
  interior.count = String(options.allowNegative ? next : next < 0n ? 0n : next);
  state.interiors.sort((left, right) => left.itemId - right.itemId);
  return interior;
}

function recalculateRoomGrade(room) {
  const catalog = getOfficeCatalog();
  const furnitureScore = (Array.isArray(room.furnitures) ? room.furnitures : []).reduce((sum, furniture) => {
    const row = catalog.interiorById.get(positiveInt(furniture.itemId));
    return sum + Math.max(0, Number(row && row.InteriorScore || 0) || 0);
  }, 0);
  const baseScore = [room.floorInteriorId, room.wallInteriorId, room.backgroundId].reduce((sum, itemId) => {
    const row = catalog.interiorById.get(positiveInt(itemId));
    return sum + Math.max(0, Number(row && row.InteriorScore || 0) || 0);
  }, 0);
  room.interiorScore = baseScore + furnitureScore;
  room.grade = gradeForScore(room.interiorScore);
}

function gradeForScore(score) {
  const value = Math.max(0, Number(score || 0) || 0);
  const rows = getOfficeCatalog().gradeRows;
  for (let index = 0; index < rows.length; index += 1) {
    if (value <= Math.max(0, Number(rows[index].ScoreMax || 0) || 0)) return index;
  }
  return 5;
}

function syncOfficeUnits(user, targetRoom) {
  const army = ensureArmy(user);
  const state = ensureOfficeState(user);
  const assigned = new Map();
  for (const room of state.rooms) {
    if (room.id !== targetRoom.id) {
      room.unitUids = (room.unitUids || []).filter((uid) => !targetRoom.unitUids.includes(uid));
    }
    for (const uid of room.unitUids || []) assigned.set(uid, room);
  }
  const updated = [];
  for (const unit of [...Object.values(army.units), ...Object.values(army.trophies)]) {
    const uid = normalizeUidString(unit.unitUid || unit.m_UnitUID);
    const room = assigned.get(uid);
    const nextRoomId = room ? room.id : 0;
    if (Number(unit.officeRoomId || 0) !== nextRoomId) {
      unit.officeRoomId = nextRoomId;
      unit.officeGrade = room ? room.grade : 0;
      unit.officeGaugeStartTime = room ? String(dateTimeBinaryNow()) : "0";
      updated.push(unit);
    } else if (room) {
      unit.officeGrade = room.grade;
      updated.push(unit);
    }
  }
  return updated;
}

function buildOfficeUnitDataList(user) {
  const state = ensureOfficeState(user);
  const assigned = new Set(state.rooms.flatMap((room) => room.unitUids || []));
  return [...getArmyUnits(user), ...getArmyTrophies(user)]
    .filter((unit) => assigned.has(normalizeUidString(unit.unitUid || unit.m_UnitUID)))
    .map((unit) => ({
      unitUid: unit.unitUid || unit.m_UnitUID,
      unitId: unit.unitId || unit.m_UnitID,
      skinId: unit.skinId || unit.m_SkinID || 0,
    }));
}

function applyOfficePreset(user, room, preset) {
  const state = user && user.office && typeof user.office === "object" ? user.office : ensureOfficeState(user);
  const changedIds = new Set();
  for (const furniture of room.furnitures || []) {
    adjustInteriorCountInState(state, furniture.itemId, 1);
    changedIds.add(furniture.itemId);
  }
  room.furnitures = [];

  for (const source of preset.furnitures || []) {
    const itemId = positiveInt(source.itemId);
    const interior = state.interiors.find((entry) => entry.itemId === itemId);
    if (toBigInt(interior && interior.count) <= 0n) continue;
    const furniture = { ...cloneFurniture(source), uid: nextFurnitureUid(user) };
    room.furnitures.push(furniture);
    adjustInteriorCountInState(state, itemId, -1);
    changedIds.add(itemId);
  }

  const catalog = getOfficeCatalog();
  room.floorInteriorId = usablePresetDecoration(state, preset.floorInteriorId, "Floor", catalog.defaultFloorId);
  room.wallInteriorId = usablePresetDecoration(state, preset.wallInteriorId, "Wall", catalog.defaultWallId);
  room.backgroundId = usablePresetDecoration(state, preset.backgroundId, "Background", catalog.defaultBackgroundId);
  recalculateRoomGrade(room);
  return {
    updatedUnits: syncOfficeUnits(user, room),
    changedInteriors: Array.from(changedIds)
      .map((itemId) => state.interiors.find((entry) => entry.itemId === itemId))
      .filter(Boolean),
  };
}

function usablePresetDecoration(state, itemId, target, fallbackId) {
  const id = positiveInt(itemId) || fallbackId;
  const row = getOfficeCatalog().interiorById.get(id);
  const owned = state.interiors.find((entry) => entry.itemId === id);
  return row
    && String(row.m_ItemMiscSubType || "") === "IMST_INTERIOR_DECO"
    && String(row.Target || "") === target
    && toBigInt(owned && owned.count) > 0n
    ? id
    : fallbackId;
}

function getOfficePreset(state, presetId) {
  if (!Number.isInteger(presetId) || presetId < 0 || presetId >= state.presets.length) return null;
  const preset = state.presets[presetId];
  return preset && preset.presetId === presetId ? preset : null;
}

function isEmptyOfficeRoom(room) {
  const catalog = getOfficeCatalog();
  return !room || (
    (!Array.isArray(room.furnitures) || room.furnitures.length === 0)
    && (!positiveInt(room.floorInteriorId) || room.floorInteriorId === catalog.defaultFloorId)
    && (!positiveInt(room.wallInteriorId) || room.wallInteriorId === catalog.defaultWallId)
    && (!positiveInt(room.backgroundId) || room.backgroundId === catalog.defaultBackgroundId)
  );
}

function isEmptyOfficePreset(preset) {
  return isEmptyOfficeRoom(preset);
}

function isValidOfficePreset(room, preset) {
  if (!room || !preset) return false;
  const catalog = getOfficeCatalog();
  const decorations = [
    [preset.floorInteriorId, "Floor"],
    [preset.wallInteriorId, "Wall"],
    [preset.backgroundId, "Background"],
  ];
  for (const [rawId, target] of decorations) {
    const id = positiveInt(rawId);
    if (!id) continue;
    const row = catalog.interiorById.get(id);
    if (!row || String(row.m_ItemMiscSubType || "") !== "IMST_INTERIOR_DECO" || String(row.Target || "") !== target) return false;
  }

  const virtualRoom = { ...room, furnitures: [] };
  for (let index = 0; index < (preset.furnitures || []).length; index += 1) {
    const furniture = { ...cloneFurniture(preset.furnitures[index]), uid: String(index + 1) };
    const row = catalog.interiorById.get(furniture.itemId);
    if (!isFurnitureRow(row) || furniturePlacementError(virtualRoom, row, furniture, { checkRoomFull: true })) return false;
    virtualRoom.furnitures.push(furniture);
  }
  return true;
}

function getMiscBalance(user, itemId) {
  const item = ensureInventory(user).misc[String(itemId)];
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function isValidPresetName(value) {
  return typeof value === "string" && value.length <= PRESET_NAME_MAX_LENGTH && !/[\r\n\t]/.test(value);
}

function isEffectiveTagOpen(ctx, user, requiredTag) {
  const expected = String(requiredTag || "").toUpperCase();
  if (!expected) return true;
  if ((user && Array.isArray(user.openTags) ? user.openTags : []).some((tag) => String(tag || "").toUpperCase() === expected)) return true;
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return false;
  const tags = ctx.getEffectiveOpenTags(Array.isArray(user && user.openTags) ? user.openTags : []);
  return Array.isArray(tags) && tags.some((tag) => String(tag || "").toUpperCase() === expected);
}

function nextFurnitureUid(user) {
  const state = user && user.office && typeof user.office === "object" ? user.office : ensureOfficeState(user);
  const used = new Set(state.rooms.flatMap((room) => (room.furnitures || []).map((furniture) => normalizeUidString(furniture.uid))));
  let value = toBigInt(state.nextFurnitureUid || 1, 1n);
  while (used.has(String(value))) value += 1n;
  state.nextFurnitureUid = String(value + 1n);
  return String(value);
}

function findFurniture(room, uid) {
  const normalizedUid = normalizeUidString(uid);
  return (room.furnitures || []).find((furniture) => normalizeUidString(furniture.uid) === normalizedUid) || null;
}

function isFurnitureRow(row) {
  return Boolean(row)
    && String(row.m_ItemMiscSubType || "") === "IMST_INTERIOR_FURNITURE"
    && ["Floor", "Tile", "Wall"].includes(String(row.Target || ""))
    && positiveInt(row.CellX) > 0
    && positiveInt(row.CellY) > 0;
}

function furniturePlacementError(room, row, furniture, options = {}) {
  const planeType = Number(furniture.planeType);
  if (!furnitureTargetMatchesPlane(row && row.Target, planeType)) return OFFICE_ERROR.FURNITURE_TYPE_MISMATCH;
  const roomRow = getOfficeCatalog().roomById.get(positiveInt(room && room.id));
  if (!roomRow) return OFFICE_ERROR.FURNITURE_ROOM_NOT_FOUND;

  const roomSize = furnitureRoomSize(roomRow, planeType);
  const furnitureSize = furnitureCellSize(row, furniture.inverted);
  if (!isFurnitureInBounds(furniture, furnitureSize, roomSize)) return OFFICE_ERROR.FURNITURE_OUT_OF_BOUND;

  if (options.checkRoomFull && String(row.Target) === "Floor") {
    const occupied = (room.furnitures || []).reduce((sum, current) => {
      if (Number(current.planeType) !== 0) return sum;
      const currentRow = getOfficeCatalog().interiorById.get(positiveInt(current.itemId));
      return sum + (isFurnitureRow(currentRow) ? positiveInt(currentRow.CellX) * positiveInt(currentRow.CellY) : 0);
    }, 0);
    const total = roomSize[0] * roomSize[1];
    if (occupied + positiveInt(row.CellX) * positiveInt(row.CellY) > Math.floor(total * 9 / 10)) {
      return OFFICE_ERROR.FURNITURE_ROOM_FULL;
    }
  }

  const ignoredUid = options.ignoreUid == null ? null : normalizeUidString(options.ignoreUid);
  for (const current of room.furnitures || []) {
    if (ignoredUid != null && normalizeUidString(current.uid) === ignoredUid) continue;
    if (Number(current.planeType) !== planeType) continue;
    const currentRow = getOfficeCatalog().interiorById.get(positiveInt(current.itemId));
    if (!isFurnitureRow(currentRow)) continue;
    if (furnitureOverlaps(furniture, furnitureSize, current, furnitureCellSize(currentRow, current.inverted))) {
      return OFFICE_ERROR.FURNITURE_OVERLAP;
    }
  }
  return 0;
}

function furnitureTargetMatchesPlane(target, planeType) {
  if (planeType === 0) return String(target) === "Floor";
  if (planeType === 1) return String(target) === "Tile";
  if (planeType === 10 || planeType === 11) return String(target) === "Wall";
  return false;
}

function furnitureRoomSize(roomRow, planeType) {
  if (planeType === 0 || planeType === 1) return [positiveInt(roomRow.CellX), positiveInt(roomRow.CellY)];
  if (planeType === 10) return [positiveInt(roomRow.CellX), positiveInt(roomRow.CellZ)];
  if (planeType === 11) return [positiveInt(roomRow.CellY), positiveInt(roomRow.CellZ)];
  return [0, 0];
}

function furnitureCellSize(row, inverted) {
  const cellX = positiveInt(row && row.CellX);
  const cellY = positiveInt(row && row.CellY);
  if (String(row && row.Target) === "Wall" || !inverted) return [cellX, cellY];
  return [cellY, cellX];
}

function isFurnitureInBounds(furniture, furnitureSize, roomSize) {
  const x = Number(furniture.positionX);
  const y = Number(furniture.positionY);
  return Number.isInteger(x)
    && Number.isInteger(y)
    && x >= 0
    && y >= 0
    && furnitureSize[0] > 0
    && furnitureSize[1] > 0
    && x + furnitureSize[0] - 1 < roomSize[0]
    && y + furnitureSize[1] - 1 < roomSize[1];
}

function furnitureOverlaps(left, leftSize, right, rightSize) {
  return left.positionX + leftSize[0] - 1 >= right.positionX
    && right.positionX + rightSize[0] - 1 >= left.positionX
    && left.positionY + leftSize[1] - 1 >= right.positionY
    && right.positionY + rightSize[1] - 1 >= left.positionY;
}

function findMaxFurnitureUid(rooms) {
  let max = 0n;
  for (const room of Array.isArray(rooms) ? rooms : []) {
    for (const furniture of Array.isArray(room.furnitures) ? room.furnitures : []) {
      const uid = toBigInt(furniture && furniture.uid || 0);
      if (uid > max) max = uid;
    }
  }
  return max;
}

function getOfficeCatalog() {
  if (officeCatalogCache) return officeCatalogCache;
  const commonConst = readGameplayTable("ab_script", "LUA_COMMON_CONST.json") || {};
  const officeConst = commonConst && commonConst.globals && commonConst.globals.Office || {};
  const presetConst = officeConst.OfficeUserPreset || {};
  const nameCardConst = officeConst.OfficeHostNameCard || {};
  const sectionRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_SECTION_TEMPLET.json");
  const roomRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_ROOM_TEMPLET.json");
  const gradeRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_GRADE_TEMPLET.json");
  const interiorRows = readGameplayTableRecords("ab_script", "LUA_ITEM_INTERIOR_TEMPLET.json");
  const themeRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_THEMA_PRESET_TEMPLET.json")
    .map((row) => ({ ...row, preset: decodeThemePreset(row) }));
  officeCatalogCache = {
    defaultBackgroundId: positiveInt(officeConst.OfficeDefaultBackground) || DEFAULT_BACKGROUND_ID,
    defaultWallId: positiveInt(officeConst.OfficeDefaultWall) || DEFAULT_WALL_ID,
    defaultFloorId: positiveInt(officeConst.OfficeDefaultFloor) || DEFAULT_FLOOR_ID,
    partyUseItemId: positiveInt(officeConst.OfficeParty && officeConst.OfficeParty.UseResourceId) || 37,
    nameCard: {
      itemId: positiveInt(nameCardConst.ItemId) || 8,
      itemValue: positiveInt(nameCardConst.ItemValue) || 10,
      dailyLimit: positiveInt(nameCardConst.DayLimit) || 50,
    },
    preset: {
      baseCount: positiveInt(presetConst.FREE_PRESET) || DEFAULT_PRESET_COUNT,
      maxCount: positiveInt(presetConst.MAX_PRESET) || MAX_PRESET_COUNT,
      expandItemId: PRESET_EXPAND_ITEM_ID,
      expandCost: positiveInt(presetConst.PRESET_PRICE_QUARTZ) || PRESET_EXPAND_COST,
    },
    sectionRows,
    roomRows,
    gradeRows,
    interiorRows,
    themeRows,
    sectionById: new Map(sectionRows.map((row) => [positiveInt(row && row.SectionID), row]).filter(([id]) => id > 0)),
    roomById: new Map(roomRows.map((row) => [positiveInt(row && row.ID), row]).filter(([id]) => id > 0)),
    interiorById: new Map(interiorRows.map((row) => [positiveInt(row && row.m_ItemMiscID), row]).filter(([id]) => id > 0)),
    themeById: new Map(themeRows.map((row) => [positiveInt(row && row.IDX), row]).filter(([id]) => id > 0)),
  };
  return officeCatalogCache;
}

function decodeThemePreset(row) {
  try {
    const reader = createReader(Buffer.from(String(row && row.ThemaPresetExportID || ""), "base64"));
    reader.int();
    const name = reader.string();
    const count = reader.count();
    const furnitures = [];
    for (let index = 0; index < count; index += 1) {
      if (!reader.bool()) continue;
      furnitures.push({
        uid: String(reader.long()),
        itemId: reader.int(),
        planeType: reader.int(),
        positionX: reader.int(),
        positionY: reader.int(),
        inverted: reader.bool(),
      });
    }
    const preset = normalizePreset({
      presetId: positiveInt(row && row.IDX),
      name,
      furnitures,
      floorInteriorId: reader.int(),
      wallInteriorId: reader.int(),
      backgroundId: reader.int(),
    });
    return reader.done() ? preset : null;
  } catch (_) {
    return null;
  }
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    switch (packetId) {
      case PACKETS.OFFICE_OPEN_SECTION_REQ:
      {
        const sectionId = reader.int();
        return { sectionId, valid: reader.done() };
      }
      case PACKETS.OFFICE_OPEN_ROOM_REQ:
      {
        const roomId = reader.int();
        return { roomId, valid: reader.done() };
      }
      case PACKETS.OFFICE_CLEAR_ALL_FURNITURE_REQ:
      {
        const roomId = reader.int();
        return { roomId, valid: reader.done() };
      }
      case PACKETS.OFFICE_PARTY_REQ:
      {
        const roomId = reader.int();
        return { roomId, valid: reader.done() };
      }
      case PACKETS.OFFICE_SET_ROOM_NAME_REQ:
      {
        const roomId = reader.int();
        const roomName = reader.string();
        return { roomId, roomName, valid: typeof roomName === "string" && reader.done() };
      }
      case PACKETS.OFFICE_SET_ROOM_UNIT_REQ:
      {
        const roomId = reader.int();
        const unitUids = reader.longList();
        return { roomId, unitUids, valid: reader.done() };
      }
      case PACKETS.OFFICE_SET_ROOM_FLOOR_REQ:
      {
        const roomId = reader.int();
        const floorInteriorId = reader.int();
        return { roomId, floorInteriorId, valid: reader.done() };
      }
      case PACKETS.OFFICE_SET_ROOM_WALL_REQ:
      {
        const roomId = reader.int();
        const wallInteriorId = reader.int();
        return { roomId, wallInteriorId, valid: reader.done() };
      }
      case PACKETS.OFFICE_SET_ROOM_BACKGROUND_REQ:
      {
        const roomId = reader.int();
        const backgroundId = reader.int();
        return { roomId, backgroundId, valid: reader.done() };
      }
      case PACKETS.OFFICE_ADD_FURNITURE_REQ:
      {
        const roomId = reader.int();
        const itemId = reader.int();
        const planeType = reader.int();
        const positionX = reader.int();
        const positionY = reader.int();
        const inverted = reader.bool();
        return { roomId, itemId, planeType, positionX, positionY, inverted, valid: reader.done() };
      }
      case PACKETS.OFFICE_UPDATE_FURNITURE_REQ:
      {
        const roomId = reader.int();
        const furnitureUid = reader.long();
        const planeType = reader.int();
        const positionX = reader.int();
        const positionY = reader.int();
        const inverted = reader.bool();
        return { roomId, furnitureUid, planeType, positionX, positionY, inverted, valid: reader.done() };
      }
      case PACKETS.OFFICE_REMOVE_FURNITURE_REQ:
      {
        const roomId = reader.int();
        const furnitureUid = reader.long();
        return { roomId, furnitureUid, valid: reader.done() };
      }
      case PACKETS.OFFICE_TAKE_HEART_REQ:
      {
        const unitUid = reader.long();
        return { unitUid, valid: reader.done() };
      }
      case PACKETS.OFFICE_STATE_REQ:
      {
        const userUid = reader.long();
        return { userUid, valid: reader.done() };
      }
      case PACKETS.OFFICE_POST_LIST_REQ:
      {
        const lastPostUid = reader.long();
        return { lastPostUid, valid: lastPostUid >= 0n && reader.done() };
      }
      case PACKETS.OFFICE_POST_RECV_REQ:
      case PACKETS.OFFICE_POST_BROADCAST_REQ:
        return { valid: reader.done() };
      case PACKETS.OFFICE_POST_SEND_REQ:
      {
        const receiverUserUid = reader.long();
        return { receiverUserUid, valid: reader.done() };
      }
      case PACKETS.OFFICE_RANDOM_VISIT_REQ:
        return { valid: reader.done() };
      case PACKETS.OFFICE_PRESET_REGISTER_REQ:
      case PACKETS.OFFICE_PRESET_APPLY_REQ:
      {
        const roomId = reader.int();
        const presetId = reader.int();
        return { roomId, presetId, valid: reader.done() };
      }
      case PACKETS.OFFICE_PRESET_ADD_REQ:
      {
        const addPresetCount = reader.int();
        return { addPresetCount, valid: reader.done() };
      }
      case PACKETS.OFFICE_PRESET_CHANGE_NAME_REQ:
      {
        const presetId = reader.int();
        const newPresetName = reader.string();
        return { presetId, newPresetName, valid: typeof newPresetName === "string" && reader.done() };
      }
      case PACKETS.OFFICE_PRESET_RESET_REQ:
      {
        const presetId = reader.int();
        return { presetId, valid: reader.done() };
      }
      case PACKETS.OFFICE_PRESET_APPLY_THEMA_REQ:
      {
        const roomId = reader.int();
        const themaIndex = reader.int();
        return { roomId, themaIndex, valid: reader.done() };
      }
      default:
        return {};
    }
  } catch (err) {
    console.log(`[office:${packetId}] request decode failed: ${err.message}`);
    return {};
  }
}

function createReader(buffer) {
  let offset = 0;
  return {
    int() {
      const read = readSignedVarInt(buffer, offset);
      offset = read.offset;
      return read.value;
    },
    long() {
      const read = readSignedVarLong(buffer, offset);
      offset = read.offset;
      return read.value;
    },
    longList() {
      const read = readSignedVarLongList(buffer, offset);
      offset = read.offset;
      return read.value;
    },
    bool() {
      const read = readBool(buffer, offset);
      offset = read.offset;
      return read.value;
    },
    count() {
      let value = 0;
      let shift = 0;
      while (shift < 32) {
        if (offset >= buffer.length) throw new Error("truncated list count");
        const byte = buffer.readUInt8(offset++);
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value >>> 0;
        shift += 7;
      }
      throw new Error("list count too long");
    },
    string() {
      const read = readString(buffer, offset);
      offset = read.offset;
      return read.value;
    },
    done() {
      return offset === buffer.length;
    },
  };
}

function decryptPayload(ctx, encryptedPayload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function ack(packetId, parts, log = "", persist = true) {
  return { packetId, payload: Buffer.concat(parts), log, persist };
}

function getSocketUser(socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return {};
}

function findOfficeUser(ctx, currentUser, userUid) {
  const id = String(toBigInt(userUid || 0));
  if (String(toBigInt(currentUser && currentUser.userUid || 0)) === id) return currentUser;
  return Object.values(ctx && ctx.userDb && ctx.userDb.users || {})
    .find((entry) => String(toBigInt(entry && entry.userUid || 0)) === id) || null;
}

function persist(ctx) {
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache("office");
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function cloneOfficeRoom(room) {
  return normalizeRoom(JSON.parse(JSON.stringify(room || {})));
}

function cloneFurniture(furniture) {
  return normalizeFurniture({ ...furniture });
}

function dedupeInteriors(interiors) {
  const byId = new Map();
  for (const interior of interiors) {
    const normalized = normalizeInterior(interior);
    if (normalized.itemId > 0) byId.set(normalized.itemId, normalized);
  }
  return Array.from(byId.values());
}

function uniquePositiveInts(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(positiveInt).filter((value) => value > 0))).sort((a, b) => a - b);
}

function uniqueBigIntStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map(normalizeUidString)
        .filter((value) => value !== "0")
    )
  );
}

function normalizeUidString(value) {
  return String(toBigInt(value || 0));
}

function sanitizeRoomName(value) {
  const text = String(value || "").replace(/[\r\n\t]/g, " ").trim();
  return text ? text.slice(0, 32) : "";
}

function isValidOfficeRoomName(value) {
  return typeof value === "string" && value.length <= 8 && !/[\r\n\t]/.test(value);
}

function normalizeRoomName(value) {
  const text = sanitizeRoomName(value);
  return /^SI_OFFICE_ROOM_NAME_/i.test(text) ? "" : text;
}

function positiveInt(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

module.exports = {
  PACKETS,
  createOfficeHandlers,
  ensureOfficeState,
  buildMyOfficeStateData,
  buildOfficeVisitStateData,
  buildOfficeGuestListNotData,
  getOfficeGuestProfiles,
  buildOfficeRoomData,
  buildOfficeFurnitureData,
  buildInteriorData,
  buildOfficePostStateData,
  buildOfficePresetData,
  isOfficeInteriorItem,
  grantOfficeInterior,
};
