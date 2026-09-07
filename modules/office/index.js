const {
  writeBool,
  writeInt64LE,
  writeIntList,
  writeLongArray,
  writeNullableObject,
  writeNullableObjectList,
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
const { spendMiscItem } = require("../inventory");
const { ensureArmy, getArmyUnits, getArmyUnitByUid } = require("../unit");
const { createEmptyReward } = require("../reward");
const { buildCommonProfileData, buildUserProfileData } = require("../profile");

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
  OFFICE_CHAT_REQ: 3637,
  OFFICE_CHAT_ACK: 3638,
  OFFICE_CHAT_NOT: 3639,
  OFFICE_CHAT_LIST_REQ: 3640,
  OFFICE_CHAT_LIST_ACK: 3641,
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
    handler(PACKETS.OFFICE_CHAT_REQ, "OFFICE_CHAT_REQ", handleChat),
    handler(PACKETS.OFFICE_CHAT_LIST_REQ, "OFFICE_CHAT_LIST_REQ", handleChatList),
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
      console.log(`[office:${name}] ACK packetId=${response.packetId} ${response.log || ""}`.trim());
      ctx.sendGameResponse(socket, packet, response.packetId, response.payload, `office-${packetId}`);
      if (response.persist !== false) persist(ctx);
      return true;
    },
  };
}

function handleOpenSection(ctx, user, req) {
  const state = ensureOfficeState(user);
  const sectionId = positiveInt(req.sectionId);
  const wasOpened = sectionId > 0 && state.openedSectionIds.includes(sectionId);
  if (sectionId && !state.openedSectionIds.includes(sectionId)) state.openedSectionIds.push(sectionId);
  state.openedSectionIds = uniquePositiveInts(state.openedSectionIds);
  const newRooms = openRoomsForSection(state, sectionId);
  const costItems = wasOpened ? [] : spendOfficeUnlockCost(ctx, user, getOfficeCatalog().sectionById.get(sectionId));
  return ack(PACKETS.OFFICE_OPEN_SECTION_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeSignedVarInt(sectionId),
    writeNullableObjectList(newRooms.map(buildOfficeRoomData)),
  ], `section=${sectionId} rooms=${newRooms.length}`);
}

function handleOpenRoom(ctx, user, req) {
  const state = ensureOfficeState(user);
  const roomId = positiveInt(req.roomId);
  const wasOpened = roomId > 0 && state.rooms.some((item) => item.id === roomId);
  const room = ensureOfficeRoom(user, roomId);
  openSectionForRoom(state, room.id);
  const costItems = wasOpened ? [] : spendOfficeUnlockCost(ctx, user, getOfficeCatalog().roomById.get(room.id));
  return ack(PACKETS.OFFICE_OPEN_ROOM_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObject(buildOfficeRoomData(room)),
  ], `room=${room.id}`);
}

function handleSetRoomName(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  room.name = sanitizeRoomName(req.roomName);
  return ack(PACKETS.OFFICE_SET_ROOM_NAME_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
  ], `room=${room.id}`);
}

function handleSetRoomUnit(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  room.unitUids = uniqueBigIntStrings(req.unitUids).slice(0, getRoomUnitLimit(room.id));
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_SET_ROOM_UNIT_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
    writeNullableObjectList(getOfficeRooms(user).map(buildOfficeRoomData)),
  ], `room=${room.id} units=${room.unitUids.length}`);
}

function handleSetRoomFloor(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  room.floorInteriorId = positiveInt(req.floorInteriorId) || DEFAULT_FLOOR_ID;
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_SET_ROOM_FLOOR_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id} floor=${room.floorInteriorId}`);
}

function handleSetRoomWall(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  room.wallInteriorId = positiveInt(req.wallInteriorId) || DEFAULT_WALL_ID;
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_SET_ROOM_WALL_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id} wall=${room.wallInteriorId}`);
}

function handleSetRoomBackground(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  room.backgroundId = positiveInt(req.backgroundId) || DEFAULT_BACKGROUND_ID;
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_SET_ROOM_BACKGROUND_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id} background=${room.backgroundId}`);
}

function handleAddFurniture(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const furniture = normalizeFurniture({
    uid: nextFurnitureUid(user),
    itemId: req.itemId,
    planeType: req.planeType,
    positionX: req.positionX,
    positionY: req.positionY,
    inverted: req.inverted,
  });
  room.furnitures.push(furniture);
  const changedInterior = adjustInteriorCount(user, furniture.itemId, -1, { allowNegative: false });
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

function handleUpdateFurniture(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const furniture = findFurniture(room, req.furnitureUid) || normalizeFurniture({ uid: req.furnitureUid, itemId: 0 });
  furniture.planeType = clampInt(req.planeType, 0, 11, 0);
  furniture.positionX = clampInt(req.positionX, -9999, 9999, 0);
  furniture.positionY = clampInt(req.positionY, -9999, 9999, 0);
  furniture.inverted = Boolean(req.inverted);
  if (!findFurniture(room, furniture.uid)) room.furnitures.push(furniture);
  return ack(PACKETS.OFFICE_UPDATE_FURNITURE_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObject(buildOfficeFurnitureData(furniture)),
  ], `room=${room.id} uid=${furniture.uid}`);
}

function handleRemoveFurniture(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const uid = normalizeUidString(req.furnitureUid);
  const index = room.furnitures.findIndex((furniture) => normalizeUidString(furniture.uid) === uid);
  const [removed] = index >= 0 ? room.furnitures.splice(index, 1) : [];
  const changedInterior = adjustInteriorCount(user, removed ? removed.itemId : 0, removed ? 1 : 0);
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

function handleClearAllFurniture(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const changed = [];
  for (const furniture of room.furnitures) {
    changed.push(adjustInteriorCount(user, furniture.itemId, 1));
  }
  room.furnitures = [];
  recalculateRoomGrade(room);
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_CLEAR_ALL_FURNITURE_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(dedupeInteriors(changed).map(buildInteriorData)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
  ], `room=${room.id}`);
}

function handleTakeHeart(ctx, user, req) {
  const unit = getArmyUnitByUid(user, req.unitUid) || getArmyUnits(user)[0] || null;
  if (unit) unit.officeGaugeStartTime = String(dateTimeBinaryNow());
  return ack(PACKETS.OFFICE_TAKE_HEART_ACK, [
    writeSignedVarInt(0),
    unit ? writeNullableObject(buildUnitData(unit)) : writeNullableObject(buildUnitData({})),
  ], `unit=${normalizeUidString(req.unitUid)}`);
}

function handleOfficeState(ctx, user, req) {
  const userUid = toBigInt(req.userUid || user.userUid || 0);
  return ack(PACKETS.OFFICE_STATE_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(userUid),
    writeNullableObject(buildOfficeVisitStateData(user)),
  ], `uid=${userUid}`);
}

function handlePostList(ctx, user) {
  const state = ensureOfficeState(user);
  return ack(PACKETS.OFFICE_POST_LIST_ACK, [
    writeSignedVarInt(0),
    writeNullableObjectList([]),
    writeSignedVarInt(0),
  ], "posts=0", false);
}

function handlePostRecv(ctx, user) {
  const state = ensureOfficeState(user);
  state.postState.recvCount = Number(state.postState.recvCount || 0) + 1;
  return ack(PACKETS.OFFICE_POST_RECV_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildRewardData(createEmptyReward())),
    writeNullableObjectList([]),
    writeSignedVarInt(0),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], "recv=0");
}

function handlePostBroadcast(ctx, user) {
  const state = ensureOfficeState(user);
  state.postState.broadcastExecution = true;
  return ack(PACKETS.OFFICE_POST_BROADCAST_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], "broadcast=1");
}

function handlePostSend(ctx, user, req) {
  const state = ensureOfficeState(user);
  state.postState.sendCount = Number(state.postState.sendCount || 0) + 1;
  return ack(PACKETS.OFFICE_POST_SEND_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(toBigInt(req.receiverUserUid || 0)),
    writeNullableObject(buildOfficePostStateData(state.postState)),
  ], `receiver=${normalizeUidString(req.receiverUserUid)}`);
}

function handleRandomVisit(ctx, user) {
  return ack(PACKETS.OFFICE_RANDOM_VISIT_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficeVisitStateData(user)),
  ], "self", false);
}

function handleChat(ctx, user, req) {
  const state = ensureOfficeState(user);
  const message = {
    messageUid: nextOfficeMessageUid(state),
    user,
    emotionId: positiveInt(req.emotionId),
    createdAt: dateTimeBinaryNow(),
  };
  state.chatMessages.push({
    messageUid: String(message.messageUid),
    emotionId: message.emotionId,
    createdAt: String(message.createdAt),
  });
  state.chatMessages = state.chatMessages.slice(-30);
  return ack(PACKETS.OFFICE_CHAT_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(message.messageUid),
    writeNullableObjectList([buildOfficeChatMessageData(message)]),
  ], `emotion=${message.emotionId}`);
}

function handleChatList(ctx, user, req) {
  const state = ensureOfficeState(user);
  const messages = state.chatMessages.map((message) => buildOfficeChatMessageData({ ...message, user }));
  return ack(PACKETS.OFFICE_CHAT_LIST_ACK, [
    writeSignedVarInt(0),
    writeSignedVarLong(toBigInt(req.userUid || user.userUid || 0)),
    writeNullableObjectList(messages),
  ], `messages=${messages.length}`, false);
}

function handleParty(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const units = room.unitUids.map((uid) => getArmyUnitByUid(user, uid)).filter(Boolean);
  return ack(PACKETS.OFFICE_PARTY_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(room.id),
    writeNullableObjectList(units.map(buildUnitData)),
    writeNullableObjectList([]),
    writeNullableObject(buildRewardData(createEmptyReward())),
  ], `room=${room.id} units=${units.length}`);
}

function handlePresetRegister(ctx, user, req) {
  const state = ensureOfficeState(user);
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const preset = ensureOfficePreset(state, nonNegativeInt(req.presetId));
  preset.name = preset.name || `Preset ${preset.presetId}`;
  preset.furnitures = room.furnitures.map(cloneFurniture);
  preset.floorInteriorId = room.floorInteriorId;
  preset.wallInteriorId = room.wallInteriorId;
  preset.backgroundId = room.backgroundId;
  return ack(PACKETS.OFFICE_PRESET_REGISTER_ACK, [
    writeSignedVarInt(0),
    writeNullableObject(buildOfficePresetData(preset)),
  ], `preset=${preset.presetId} room=${room.id}`);
}

function handlePresetApply(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  const preset = ensureOfficePreset(ensureOfficeState(user), nonNegativeInt(req.presetId));
  applyPresetToRoom(room, preset);
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_PRESET_APPLY_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(preset.presetId),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
    writeNullableObjectList(getOfficeInteriors(user).map(buildInteriorData)),
  ], `preset=${preset.presetId} room=${room.id}`);
}

function handlePresetAdd(ctx, user, req) {
  const state = ensureOfficeState(user);
  const count = clampInt(req.addPresetCount, 1, 20, 1);
  while (state.presets.length < DEFAULT_PRESET_COUNT + count) {
    const nextId = nextPresetId(state);
    state.presets.push(defaultPreset(nextId));
  }
  return ack(PACKETS.OFFICE_PRESET_ADD_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(state.presets.length),
    writeNullableObjectList([]),
  ], `total=${state.presets.length}`);
}

function handlePresetChangeName(ctx, user, req) {
  const preset = ensureOfficePreset(ensureOfficeState(user), nonNegativeInt(req.presetId));
  preset.name = sanitizeRoomName(req.newPresetName || `Preset ${preset.presetId}`);
  return ack(PACKETS.OFFICE_PRESET_CHANGE_NAME_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(preset.presetId),
    writeString(preset.name),
  ], `preset=${preset.presetId}`);
}

function handlePresetReset(ctx, user, req) {
  const state = ensureOfficeState(user);
  const presetId = nonNegativeInt(req.presetId);
  const index = state.presets.findIndex((preset) => nonNegativeInt(preset.presetId, -1) === presetId);
  if (index >= 0) state.presets[index] = defaultPreset(presetId);
  return ack(PACKETS.OFFICE_PRESET_RESET_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(presetId),
  ], `preset=${presetId}`);
}

function handlePresetApplyThema(ctx, user, req) {
  const room = ensureOfficeRoom(user, positiveInt(req.roomId));
  room.furnitures = [];
  room.floorInteriorId = DEFAULT_FLOOR_ID;
  room.wallInteriorId = DEFAULT_WALL_ID;
  room.backgroundId = DEFAULT_BACKGROUND_ID;
  recalculateRoomGrade(room);
  const updatedUnits = syncOfficeUnits(user, room);
  return ack(PACKETS.OFFICE_PRESET_APPLY_THEMA_ACK, [
    writeSignedVarInt(0),
    writeSignedVarInt(positiveInt(req.themaIndex)),
    writeNullableObject(buildOfficeRoomData(room)),
    writeNullableObjectList(updatedUnits.map(buildUnitData)),
    writeNullableObjectList(getOfficeInteriors(user).map(buildInteriorData)),
  ], `theme=${positiveInt(req.themaIndex)} room=${room.id}`);
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

function buildOfficeChatNotData(message = {}) {
  return writeNullableObject(buildOfficeChatMessageData(message));
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

function buildOfficeChatMessageData(message = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(message.messageUid || 0)),
    writeNullableObject(buildCommonProfileData(message.user || {})),
    writeSignedVarInt(positiveInt(message.emotionId)),
    writeInt64LE(toBigInt(message.createdAt || dateTimeBinaryNow())),
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
  state.presets = normalizePresets(state.presets);
  state.chatMessages = Array.isArray(state.chatMessages) ? state.chatMessages.slice(-30) : [];
  state.nextFurnitureUid = String(toBigInt(state.nextFurnitureUid || findMaxFurnitureUid(state.rooms) + 1n, 1n));
  state.nextMessageUid = String(toBigInt(state.nextMessageUid || 1, 1n));
  user.hasOffice = true;
  return state;
}

function defaultOfficeState() {
  return {
    openedSectionIds: DEFAULT_SECTION_IDS.slice(),
    rooms: DEFAULT_ROOM_IDS.map(defaultRoom),
    interiors: defaultInteriors(),
    postState: normalizePostState(),
    presets: Array.from({ length: DEFAULT_PRESET_COUNT }, (_, index) => defaultPreset(index)),
    chatMessages: [],
    nextFurnitureUid: "1",
    nextMessageUid: "1",
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
  };
}

function normalizePresets(presets) {
  const byId = new Map();
  for (const preset of Array.isArray(presets) ? presets : []) {
    const normalized = normalizePreset(preset);
    if (normalized.presetId >= 0) byId.set(normalized.presetId, normalized);
  }
  for (let id = 0; id < DEFAULT_PRESET_COUNT; id += 1) {
    if (!byId.has(id)) byId.set(id, defaultPreset(id));
  }
  return Array.from(byId.values()).sort((left, right) => left.presetId - right.presetId);
}

function normalizePreset(preset = {}) {
  const presetId = nonNegativeInt(preset.presetId);
  return {
    presetId,
    name: sanitizeRoomName(preset.name || `Preset ${presetId}`),
    furnitures: Array.isArray(preset.furnitures) ? preset.furnitures.map(cloneFurniture) : [],
    floorInteriorId: positiveInt(preset.floorInteriorId) || DEFAULT_FLOOR_ID,
    wallInteriorId: positiveInt(preset.wallInteriorId) || DEFAULT_WALL_ID,
    backgroundId: positiveInt(preset.backgroundId) || DEFAULT_BACKGROUND_ID,
  };
}

function defaultPreset(presetId) {
  const id = nonNegativeInt(presetId);
  return {
    presetId: id,
    name: `Preset ${id}`,
    furnitures: [],
    floorInteriorId: DEFAULT_FLOOR_ID,
    wallInteriorId: DEFAULT_WALL_ID,
    backgroundId: DEFAULT_BACKGROUND_ID,
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
  const limit = positiveInt(row && row.UnitLimit);
  return limit > 0 ? limit : 8;
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
  ensureArmy(user);
  const state = ensureOfficeState(user);
  const assigned = new Map();
  for (const room of state.rooms) {
    if (room.id !== targetRoom.id) {
      room.unitUids = (room.unitUids || []).filter((uid) => !targetRoom.unitUids.includes(uid));
    }
    for (const uid of room.unitUids || []) assigned.set(uid, room);
  }
  const updated = [];
  for (const unit of getArmyUnits(user)) {
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
  return getArmyUnits(user)
    .filter((unit) => assigned.has(normalizeUidString(unit.unitUid || unit.m_UnitUID)))
    .map((unit) => ({
      unitUid: unit.unitUid || unit.m_UnitUID,
      unitId: unit.unitId || unit.m_UnitID,
      skinId: unit.skinId || unit.m_SkinID || 0,
    }));
}

function applyPresetToRoom(room, preset) {
  room.furnitures = (preset.furnitures || []).map((furniture) => ({ ...cloneFurniture(furniture), uid: normalizeUidString(furniture.uid) }));
  room.floorInteriorId = positiveInt(preset.floorInteriorId) || DEFAULT_FLOOR_ID;
  room.wallInteriorId = positiveInt(preset.wallInteriorId) || DEFAULT_WALL_ID;
  room.backgroundId = positiveInt(preset.backgroundId) || DEFAULT_BACKGROUND_ID;
  recalculateRoomGrade(room);
}

function ensureOfficePreset(state, presetId) {
  const id = nonNegativeInt(presetId);
  let preset = state.presets.find((item) => nonNegativeInt(item.presetId, -1) === id);
  if (!preset) {
    preset = defaultPreset(id);
    state.presets.push(preset);
    state.presets.sort((left, right) => left.presetId - right.presetId);
  }
  return preset;
}

function nextFurnitureUid(user) {
  const state = user && user.office && typeof user.office === "object" ? user.office : ensureOfficeState(user);
  const value = toBigInt(state.nextFurnitureUid || 1, 1n);
  state.nextFurnitureUid = String(value + 1n);
  return String(value);
}

function nextOfficeMessageUid(state) {
  const value = toBigInt(state.nextMessageUid || 1, 1n);
  state.nextMessageUid = String(value + 1n);
  return value;
}

function nextPresetId(state) {
  return Math.max(-1, ...state.presets.map((preset) => nonNegativeInt(preset.presetId, -1))) + 1;
}

function findFurniture(room, uid) {
  const normalizedUid = normalizeUidString(uid);
  return (room.furnitures || []).find((furniture) => normalizeUidString(furniture.uid) === normalizedUid) || null;
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
  const sectionRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_SECTION_TEMPLET.json");
  const roomRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_ROOM_TEMPLET.json");
  const gradeRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_GRADE_TEMPLET.json");
  const interiorRows = readGameplayTableRecords("ab_script", "LUA_ITEM_INTERIOR_TEMPLET.json");
  officeCatalogCache = {
    defaultBackgroundId: positiveInt(officeConst.OfficeDefaultBackground) || DEFAULT_BACKGROUND_ID,
    defaultWallId: positiveInt(officeConst.OfficeDefaultWall) || DEFAULT_WALL_ID,
    defaultFloorId: positiveInt(officeConst.OfficeDefaultFloor) || DEFAULT_FLOOR_ID,
    sectionRows,
    roomRows,
    gradeRows,
    interiorRows,
    sectionById: new Map(sectionRows.map((row) => [positiveInt(row && row.SectionID), row]).filter(([id]) => id > 0)),
    roomById: new Map(roomRows.map((row) => [positiveInt(row && row.ID), row]).filter(([id]) => id > 0)),
    interiorById: new Map(interiorRows.map((row) => [positiveInt(row && row.m_ItemMiscID), row]).filter(([id]) => id > 0)),
  };
  return officeCatalogCache;
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  const reader = createReader(decryptPayload(ctx, encryptedPayload));
  try {
    switch (packetId) {
      case PACKETS.OFFICE_OPEN_SECTION_REQ:
        return { sectionId: reader.int() };
      case PACKETS.OFFICE_OPEN_ROOM_REQ:
      case PACKETS.OFFICE_CLEAR_ALL_FURNITURE_REQ:
      case PACKETS.OFFICE_PARTY_REQ:
        return { roomId: reader.int() };
      case PACKETS.OFFICE_SET_ROOM_NAME_REQ:
        return { roomId: reader.int(), roomName: reader.string() };
      case PACKETS.OFFICE_SET_ROOM_UNIT_REQ:
        return { roomId: reader.int(), unitUids: reader.longList() };
      case PACKETS.OFFICE_SET_ROOM_FLOOR_REQ:
        return { roomId: reader.int(), floorInteriorId: reader.int() };
      case PACKETS.OFFICE_SET_ROOM_WALL_REQ:
        return { roomId: reader.int(), wallInteriorId: reader.int() };
      case PACKETS.OFFICE_SET_ROOM_BACKGROUND_REQ:
        return { roomId: reader.int(), backgroundId: reader.int() };
      case PACKETS.OFFICE_ADD_FURNITURE_REQ:
        return {
          roomId: reader.int(),
          itemId: reader.int(),
          planeType: reader.int(),
          positionX: reader.int(),
          positionY: reader.int(),
          inverted: reader.bool(),
        };
      case PACKETS.OFFICE_UPDATE_FURNITURE_REQ:
        return {
          roomId: reader.int(),
          furnitureUid: reader.long(),
          planeType: reader.int(),
          positionX: reader.int(),
          positionY: reader.int(),
          inverted: reader.bool(),
        };
      case PACKETS.OFFICE_REMOVE_FURNITURE_REQ:
        return { roomId: reader.int(), furnitureUid: reader.long() };
      case PACKETS.OFFICE_TAKE_HEART_REQ:
        return { unitUid: reader.long() };
      case PACKETS.OFFICE_STATE_REQ:
      case PACKETS.OFFICE_CHAT_LIST_REQ:
        return { userUid: reader.long() };
      case PACKETS.OFFICE_POST_LIST_REQ:
        return { lastPostUid: reader.long() };
      case PACKETS.OFFICE_POST_SEND_REQ:
        return { receiverUserUid: reader.long() };
      case PACKETS.OFFICE_CHAT_REQ:
        return { userUid: reader.long(), emotionId: reader.int() };
      case PACKETS.OFFICE_PRESET_REGISTER_REQ:
      case PACKETS.OFFICE_PRESET_APPLY_REQ:
        return { roomId: reader.int(), presetId: reader.int() };
      case PACKETS.OFFICE_PRESET_ADD_REQ:
        return { addPresetCount: reader.int() };
      case PACKETS.OFFICE_PRESET_CHANGE_NAME_REQ:
        return { presetId: reader.int(), newPresetName: reader.string() };
      case PACKETS.OFFICE_PRESET_RESET_REQ:
        return { presetId: reader.int() };
      case PACKETS.OFFICE_PRESET_APPLY_THEMA_REQ:
        return { roomId: reader.int(), themaIndex: reader.int() };
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
    string() {
      const read = readString(buffer, offset);
      offset = read.offset;
      return read.value;
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
  buildOfficeChatNotData,
  buildOfficeRoomData,
  buildOfficeFurnitureData,
  buildInteriorData,
  buildOfficePostStateData,
  buildOfficePresetData,
  buildOfficeChatMessageData,
  isOfficeInteriorItem,
  grantOfficeInterior,
  loadOfficeCatalog: getOfficeCatalog,
};
