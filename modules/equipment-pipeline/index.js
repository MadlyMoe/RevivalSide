const {
  writeBool,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  writeNullableObject,
  writeNullableObjectOrNull,
  writeNullObject,
  writeObjectList,
  writeLongArray,
  buildEquipItemData,
  buildEquipTuningCandidateData,
  buildResetCountData,
  buildCraftSlotData,
  buildPotentialOptionCandidateData,
  buildEquipPresetData,
  buildEquipProfileInfoData,
  buildRewardData,
  buildItemMiscData,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarIntList,
  readSignedVarLongList,
  writeIntList,
  statTypeName,
  statTypeValue,
  toBigInt,
} = require("../packet-codec");
const {
  grantEquipItem,
  removeEquipItems,
  equipItemToUnit,
  unequipItem,
  lockEquipItem,
  enchantEquipItem,
  rollEquipPrecision,
  rollEquipSubstat,
  confirmEquipSubstat,
  cancelEquipTuning,
  rollSetOption,
  confirmSetOption,
  imprintEquip,
  upgradeEquipItem,
  openPotentialSocket,
  rollPotentialOption,
  confirmPotentialOption,
  cancelPotentialOption,
  getPotentialRerollCosts,
  startCraft,
  completeCraft,
  instantCraft,
  getEquipmentResetCounts,
  instantCompleteCraft,
  unlockCraftSlot,
  getEquipItems,
  getEquipItem,
  getEquipPresets,
  addEquipPresets,
  setEquipPresetName,
  registerEquipPreset,
  registerEquipPresetFromUnit,
  applyEquipPreset,
  clearEquipPresets,
  changeEquipPresetIndices,
} = require("../equipment");
const {
  getEquipEnchantFeedExp,
  getEquipEnchantMaterials,
  getEquipEnchantRequiredExp,
  getEquipPotentialOptionRecords,
  getEquipPrecisionWeightRecords,
  getEquipRandomStatRecords,
  getEquipSetOptionIds,
  getEquipTemplet,
  getEquipMoldTemplet,
  getEquipUpgradeTemplet,
  getIntervalTemplet,
  getMoldRewardRecords,
  parseGameTableDate,
  getCustomBoxTemplet,
  getMaxEquipEnchantLevel,
  getMiscItemTemplet,
  getOperatorSkillTemplet,
  getRandomBoxRewards,
  getUnitTemplet,
} = require("../game-data");
const { getMiscItem, grantMiscItem, spendMiscItem } = require("../inventory");
const { getArmyDeckSets, getArmyUnitByUid, getArmyUnits } = require("../unit");
const { grantRewardByType, createEmptyReward, getChoiceRewardRecords, grantChoiceItemReward } = require("../reward");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");
const { INVENTORY_TYPES, getInventoryCapacity, getInventoryUsage } = require("../inventory-capacity");

const EQUIP_PACKET_IDS = [
  1000, 1002, 1004, 1006, 1008, 1010, 1012, 1014, 1016, 1018,
  1020, 1022, 1024, 1026, 1028, 1030, 1032, 1034, 1036, 1040,
  1042, 1044, 1046, 1048, 1052, 1055, 1057, 1059, 1061, 1063,
  1066, 1068, 1070, 1072, 1074, 1076,
];
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CREDIT = 98;
const NEC_FAIL_UNIT_NOT_EXIST = 136;
const NEC_FAIL_UNIT_EQUIP_ITEM = 141;
const NEC_FAIL_WARFARE_DOING = 213;
const NEC_FAIL_INVALID_ITEM_ID = 244;
const NEC_FAIL_INVALID_ITEM_UID = 245;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const NEC_FAIL_CANNOT_EQUIP_ITEM = 248;
const NEC_FAIL_CANNOT_UNEQUIP_ITEM = 249;
const NEC_FAIL_ITEM_LOCKED = 250;
const NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX = 251;
const NEC_FAIL_EQUIP_TUNING_ALREADY_MAX_PRECISION = 305;
const NEC_FAIL_EQUIP_TUNING_RANDOM_STAT_GROUP_EMPTY = 307;
const NEC_FAIL_EQUIP_TUNING_RESERVED_STAT_EMPTY = 308;
const NEC_FAIL_DIVE_DOING = 330;
const NEC_FAIL_INVALID_ITEM_REWARD_GROUP_ID = 246;
const NEC_FAIL_RANDOM_ITEM_BOX_OPEN_COUNT_OVER_10 = 453;
const NEC_FAIL_UNIT_IS_SEIZED = 20316;
const NEC_FAIL_INVALID_REQUEST = 20191;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_REFINE_EQUIP_ITEM_OPTION = 20205;
const NEC_FAIL_INVALID_EQUIP_OPTION_ID = 20218;
const NEC_FAIL_SELECT_EQUIP_OPTION_DATA = 20240;
const NEC_FAIL_INVALID_SET_OPTION_ID = 20408;
const NEC_FAIL_NOT_EXIST_SET_OPTION = 20410;
const NEC_FAIL_ALREADY_APPLY_SET_OPTION = 20412;
const NEC_FAIL_EQUIP_PRESET_MAX_COUNT = 20730;
const NEC_FAIL_EQUIP_PRESET_INVALID_NAME = 20731;
const NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT = 20733;
const NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX = 20734;
const NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION = 20736;
const NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE = 20737;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA = 20738;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_TEMPLT = 20739;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_TYPE = 20740;
const NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS = 20741;
const NEC_FAIL_EQUIP_PRESET_DUPLICATE_EQUIP_UID = 20744;
const NEC_FAIL_EQUIP_PRIVATE = 20836;
const NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE = 21042;
const NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_DUPLICATE = 21043;
const NEC_FAIL_EQUIP_NOT_RELIC = 20987;
const NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX = 20988;
const NEC_FAIL_EQUIP_INVALID_POTENTIAL_OPTION_KEY = 20990;
const NEC_FAIL_EQUIP_INVALID_WEIGHT_ID = 20991;
const NEC_FAIL_EQUIP_NOT_ENOUGH_CHCHANT_LEVEL = 20992;
const NEC_FAIL_EQUIP_POTENTIAL_OPTION_LOGICAL_ERROR = 20993;
const NEC_FAIL_EQUIP_UPGRADE_TEMPLET = 20980;
const NEC_FAIL_EQUIP_UPGRADE_CONDITION = 20981;
const NEC_FAIL_EQUIP_UPGRADE_DATA = 20982;
const NEC_FAIL_EQUIP_UPGRADE_MATERIAL = 20983;
const NEC_FAIL_EQUIP_LEVEL_ALREADY_ENOUGH = 28003;
const NEC_FAIL_EQUIP_MULTIPLE_COUNT_MAX = 28004;
const NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP = 28005;
const NEC_FAIL_EQUIP_ITEM_FULL = 114;
const NEC_FAIL_CREAFT_MOLD_DATE_EXPIRED = 20345;
const NEC_FAIL_OPENTAG_CLOSED = 20768;
const NEC_FAIL_EQUIP_TUNING_OPTION_CHANGE_ALREADY_HAS_BONUS = 26109;
const NEC_FAIL_EQUIP_SET_OPTION_CHANGE_ALREADY_HAS_BONUS = 26110;
const NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS = 26111;
const NEC_FAIL_EQUIP_OPTION_BONUS_COUNT_NOT_ENOUGH_COUNT = 26112;
const NEC_FAIL_INVALID_EQUIP_OPTION_DUPLICATE = 26113;
const TUNING_MATERIAL_ITEM_ID = 1013;
const TUNING_BONUS_RESET_GROUP_ID = 1013;
const SET_BONUS_RESET_GROUP_ID = 1035;
const TUNING_BONUS_MAX_COUNT = 100;
const EQUIP_PRESET_MAX_COUNT = 100;
const EQUIP_PRESET_EXPAND_COST_ITEM_ID = 101;
const EQUIP_PRESET_EXPAND_COST_VALUE = 50;
const EQUIP_PRESET_NAME_MAX_LENGTH = 15;
const RELIC_REROLL_LIMIT_COUNT = 100;
const EQUIP_PRESET_NOT = 1050;
const EQUIP_PRESET_INVALIDATION_PACKET_IDS = new Set([1002, 1006, 1057]);

function createEquipmentPipelineHandlers() {
  return EQUIP_PACKET_IDS.map((packetId) => ({
    packetId,
    name: `EQUIPMENT_PIPELINE_${packetId}`,
    handle(ctx, socket, packet) {
      const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
      if (socket.session) socket.session.user = user;
      const request = decodeRequest(ctx, packetId, packet.payload);
      const presetBefore = EQUIP_PRESET_INVALIDATION_PACKET_IDS.has(packetId) ? buildEquipPresetNotPayload(user) : null;
      const response = buildResponse(ctx, user, packetId, request);
      const missionTracking = response.persist === false ? null : trackEquipmentMission(ctx, user, packetId, request, response);
      console.log(`[equipment:${packetId}] ACK packetId=${response.packetId} payloadSize=${response.payload.length}`);
      for (const preResponse of response.preResponses || []) {
        ctx.sendResponse(socket, packet.sequence, preResponse.packetId, () =>
          ctx.buildEncryptedPacket(packet.sequence, preResponse.packetId, preResponse.payload)
        );
      }
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      if (presetBefore && response.persist !== false && typeof ctx.sendServerGamePacket === "function") {
        const presetAfter = buildEquipPresetNotPayload(user);
        if (!presetBefore.equals(presetAfter)) {
          ctx.sendServerGamePacket(socket, EQUIP_PRESET_NOT, presetAfter, "equipment-preset-refresh");
        }
      }
      if (socket.session && socket.session.gameReplay && ctx.capturedGameFlow && typeof ctx.skipCapturedGameThroughPacketId === "function") {
        ctx.skipCapturedGameThroughPacketId(socket, response.packetId);
      }
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "equipment-mission-update" });
      if (response.persist !== false && ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
      return true;
    },
  }));
}

function trackEquipmentMission(ctx, user, packetId, request = {}, response = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const nowValue = now(ctx);
  const tracking = makeMissionTracking(nowValue);
  const track = (condition, amount = 1, details = {}) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now: nowValue, ...details });
    addMissionTrackingCondition(tracking, condition, tracked);
  };
  const trackResourceSpend = (itemId, amount) => {
    const numericItemId = Number(itemId || 0);
    const numericAmount = Math.max(0, Math.trunc(Number(amount || 0) || 0));
    if (numericItemId > 0 && numericAmount > 0) {
      track("USE_RESOURCE", numericAmount, { itemId: numericItemId, resourceId: numericItemId, value: numericItemId });
    }
  };

  switch (packetId) {
    case 1002:
    case 1057:
    case 1063:
      track("EQUIP_ENCHANT", 1, { equipUid: request.equipItemUID || request.equipUid });
      break;
    case 1076:
      track("EQUIP_ENCHANT", Math.max(1, (request.equipItemUIDList || []).length));
      break;
    case 1020:
    case 1024:
    case 1028:
    case 1032:
    case 1034:
      track("EQUIP_TUNING", 1, { equipUid: request.equipUID || request.equipUid });
      break;
    case 1014:
    case 1016:
      track("EQUIP_MAKE", 1);
      break;
    case 1066:
      track("EQUIP_MAKE", Math.max(1, Number(request.moldCount || 1) || 1), { itemId: request.moldId });
      for (const cost of response.resourceCosts || []) trackResourceSpend(cost.itemId, cost.count);
      break;
    case 1008:
      trackResourceSpend(request.itemID || request.itemId, request.count || 1);
      break;
    case 1026:
      trackResourceSpend(request.itemId, request.count || 1);
      break;
    default:
      break;
  }

  return tracking;
}

function buildResponse(ctx, user, packetId, req) {
  switch (packetId) {
    case 1000:
      return equipItemAck(user, req);
    case 1002:
      return enchantAck(user, req, 1003);
    case 1004:
      return lockAck(user, req);
    case 1006:
      return removeAck(user, req);
    case 1008:
      return randomBoxAck(ctx, user, req);
    case 1010:
      return craftUnlockAck(ctx, user, req);
    case 1012:
      return craftStartAck(ctx, user, req);
    case 1014:
      return craftCompleteAck(ctx, user, req);
    case 1016:
      return craftInstantCompleteAck(ctx, user, req);
    case 1018:
      return refineAck(user, req);
    case 1020:
      return statRollAck(user, req);
    case 1022:
      return statConfirmAck(user, req);
    case 1024:
      return statBonusConfirmAck(user, req);
    case 1026:
      return choiceItemAck(ctx, user, req);
    case 1028:
      return setOptionRollAck(user, req);
    case 1030:
      return setOptionConfirmAck(user, req);
    case 1032:
      return setOptionBonusConfirmAck(user, req);
    case 1034:
      return firstSetOptionAck(user, req);
    case 1036:
      return profileAck(user);
    case 1040:
      return presetAddAck(user, req);
    case 1042:
      return presetNameAck(user, req);
    case 1044:
      return presetRegisterAllAck(user, req);
    case 1046:
      return presetRegisterAck(user, req);
    case 1048:
      return presetApplyAck(user, req);
    case 1052:
      return tuningCancelAck(user, req);
    case 1055:
      return imprintAck(user, req);
    case 1057:
      return upgradeAck(user, req);
    case 1059:
      return openSocketAck(user, req);
    case 1061:
      return presetChangeIndexAck(user, req);
    case 1063:
      return enchantAck(user, req, 1064);
    case 1066:
      return craftInstantAck(ctx, user, req);
    case 1068:
      return potentialRollAck(user, req);
    case 1070:
      return potentialConfirmAck(user, req);
    case 1072:
      return potentialCancelAck(user, req);
    case 1074:
      return presetClearAck(user, req);
    case 1076:
      return multipleEnchantAck(user, req);
    default:
      return { packetId: packetId + 1, payload: writeSignedVarInt(0) };
  }
}

function equipItemAck(user, req) {
  const isEquip = req.isEquip === true;
  const unit = req.valid ? getArmyUnitByUid(user, req.unitUID) : null;
  const equip = req.valid ? getEquipItem(user, req.equipItemUID) : null;
  const templet = equip ? getEquipTemplet(equip.itemEquipId) : null;
  const unitTemplet = unit ? getUnitTemplet(unit.unitId) : null;
  const position = Number(req.equipPosition);
  const validPosition = Number.isInteger(position) && position >= 0 && position <= 3;
  const unitSlots = unit && Array.isArray(unit.equipItemUids) ? unit.equipItemUids.map((uid) => toBigInt(uid || 0)) : [];
  const alreadyEquipped = Boolean(
    isEquip
    && equip
    && unit
    && validPosition
    && unitSlots[position] === toBigInt(equip.equipUid)
    && String(toBigInt(equip.ownerUnitUid || 0)) === String(toBigInt(unit.unitUid))
  );

  let errorCode = NEC_OK;
  if (!req.valid || !equip) errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
  else if (!unit || !unitTemplet) errorCode = NEC_FAIL_UNIT_NOT_EXIST;
  else if (!validPosition || !isValidEquipPosition(templet, position)) {
    errorCode = isEquip ? NEC_FAIL_CANNOT_EQUIP_ITEM : NEC_FAIL_CANNOT_UNEQUIP_ITEM;
  } else if (isEquip && (unitTemplet.m_NKM_UNIT_TYPE !== "NUT_NORMAL" || unit.isSeized)) {
    errorCode = unit.isSeized ? NEC_FAIL_UNIT_IS_SEIZED : NEC_FAIL_CANNOT_EQUIP_ITEM;
  } else if (isEquip && position === 3 && Number(unit.limitBreakLevel || 0) < 3) {
    errorCode = NEC_FAIL_CANNOT_EQUIP_ITEM;
  } else if (isEquip && (
    String(templet.m_EquipUnitStyleType || "") !== String(unitTemplet.m_NKM_UNIT_STYLE_TYPE || "")
    || !isPrivateEquipForUnit(templet, unitTemplet)
  )) {
    errorCode = NEC_FAIL_CANNOT_EQUIP_ITEM;
  } else if (!isEquip && (
    unitSlots[position] !== toBigInt(equip.equipUid)
    || String(toBigInt(equip.ownerUnitUid || 0)) !== String(toBigInt(unit.unitUid))
  )) {
    errorCode = NEC_FAIL_CANNOT_UNEQUIP_ITEM;
  } else {
    errorCode = unitEquipDeckError(user, unit.unitUid);
  }

  if (errorCode !== NEC_OK) {
    return {
      ...buildEquipItemEquipAckPayload(
        errorCode,
        req.unitUID || 0,
        isEquip ? req.equipItemUID || 0 : 0,
        isEquip ? 0 : req.equipItemUID || 0,
        validPosition ? position : 0
      ),
      persist: false,
    };
  }

  if (alreadyEquipped) {
    return { ...buildEquipItemEquipAckPayload(NEC_OK, unit.unitUid, equip.equipUid, 0, position), persist: false };
  }

  const result = isEquip
    ? equipItemToUnit(user, unit.unitUid, equip.equipUid, position)
    : unequipItem(user, equip.equipUid);
  const equipItemUID = isEquip ? equip.equipUid : 0;
  const unequipItemUID = isEquip ? result.unequipItemUID || 0 : equip.equipUid;
  const response = buildEquipItemEquipAckPayload(NEC_OK, unit.unitUid, equipItemUID, unequipItemUID, position);
  response.persist = true;
  const previousOwnerUnitUid = result.previousOwnerUnit && result.previousOwnerUnit.unitUid;
  const previousOwnerPosition = Number(result.previousOwnerPosition);
  const movedFromAnotherSlot = isEquip
    && previousOwnerUnitUid
    && toBigInt(previousOwnerUnitUid) > 0n
    && (String(toBigInt(previousOwnerUnitUid)) !== String(toBigInt(unit.unitUid)) || previousOwnerPosition !== position);
  if (movedFromAnotherSlot) {
    response.preResponses = [
      buildEquipItemEquipAckPayload(NEC_OK, previousOwnerUnitUid, 0, equipItemUID, previousOwnerPosition),
    ];
  }
  return response;
}

function unitEquipDeckError(user, unitUid) {
  const key = String(toBigInt(unitUid || 0));
  for (const set of getArmyDeckSets(user)) {
    for (const deck of set.decks || []) {
      if (!(deck.unitUids || []).some((uid) => String(toBigInt(uid || 0)) === key)) continue;
      if (Number(deck.state || 0) === 2) return NEC_FAIL_WARFARE_DOING;
      if (Number(deck.state || 0) === 3) return NEC_FAIL_DIVE_DOING;
    }
  }
  return NEC_OK;
}

function buildEquipItemEquipAckPayload(errorCode, unitUID, equipItemUID, unequipItemUID, equipPosition) {
  const safeEquipPosition = normalizeEquipPosition(equipPosition);
  return {
    packetId: 1001,
    payload: Buffer.concat([
      writeSignedVarInt(Number(errorCode || 0) || 0),
      writeSignedVarLong(toBigInt(unitUID || 0)),
      writeSignedVarLong(toBigInt(equipItemUID)),
      writeSignedVarLong(toBigInt(unequipItemUID)),
      writeSignedVarInt(safeEquipPosition),
    ]),
  };
}

function normalizeEquipPosition(equipPosition) {
  const numeric = Number(equipPosition);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 3 ? numeric : 0;
}

function enchantAck(user, req, packetId) {
  if (packetId === 1003) return equipMaterialEnchantAck(user, req);
  if (packetId === 1064) return miscMaterialEnchantAck(user, req);
  const result = enchantEquipItem(user, req.equipItemUID, req.consumeEquipItemUIDList || req.equipItemUIDList || [], {
    miscItems: req.miscItemList || [],
    targetLevel: req.enchantLevel,
  });
  const equip = result && result.equip;
  const common = [
    writeSignedVarInt(0),
    writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
    writeSignedVarInt(Number(equip && equip.enchantLevel) || 0),
    writeSignedVarInt(Number(equip && equip.enchantExp) || 0),
  ];
  if (packetId === 1064) {
    common.push(writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))));
  } else {
    common.push(writeLongArray(result ? result.consumed : []));
    common.push(writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))));
  }
  return { packetId, payload: Buffer.concat(common) };
}

function miscMaterialEnchantAck(user, req) {
  const target = req.valid ? getEquipItem(user, req.equipItemUID) : null;
  const targetTemplet = target ? getEquipTemplet(target.itemEquipId) : null;
  const definitions = getEquipEnchantMaterials();
  const materials = Array.isArray(req.miscItemList) ? req.miscItemList : [];
  const targetOwner = getArmyUnits(user).find((unit) => (
    Array.isArray(unit.equipItemUids)
    && unit.equipItemUids.some((uid) => String(toBigInt(uid || 0)) === String(toBigInt(req.equipItemUID || 0)))
  ));
  const maxLevel = targetTemplet
    ? Math.min(Number(targetTemplet.m_MaxEnchantLevel || 10) || 10, getMaxEquipEnchantLevel(targetTemplet.m_NKM_ITEM_TIER) || 10, 10)
    : 0;
  const validMaterials = materials.length === definitions.length && materials.every((material, index) => (
    material
    && Number.isInteger(material.itemId)
    && material.itemId === Number(definitions[index].itemId)
    && Number.isInteger(material.count)
    && material.count >= 0
  ));
  const addedExp = validMaterials
    ? materials.reduce((total, material, index) => total + material.count * Number(definitions[index].exp || 0), 0)
    : 0;
  const creditCost = BigInt(Math.max(0, addedExp * 8));
  const credit = getMiscItem(user, 1);
  const creditBalance = toBigInt(credit && credit.countFree || 0) + toBigInt(credit && credit.countPaid || 0);

  let errorCode = NEC_OK;
  if (!req.valid || !target || !targetTemplet) errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
  else if (Number(target.enchantLevel || 0) >= maxLevel) errorCode = NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX;
  else if (!validMaterials || addedExp <= 0) errorCode = NEC_FAIL_INVALID_ITEM_ID;
  else {
    const deckError = targetOwner ? unitEquipDeckError(user, targetOwner.unitUid) : NEC_OK;
    if (deckError !== NEC_OK) errorCode = deckError;
    else if (materials.some((material) => {
      if (material.count <= 0) return false;
      const item = getMiscItem(user, material.itemId);
      return toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0) < BigInt(material.count);
    })) errorCode = NEC_FAIL_INSUFFICIENT_ITEM;
    else if (creditBalance < creditCost) errorCode = NEC_FAIL_INSUFFICIENT_CREDIT;
  }

  const result = errorCode === NEC_OK
    ? enchantEquipItem(user, target.equipUid, [], { miscItems: materials })
    : null;
  const updated = result && result.equip || target;
  return {
    packetId: 1064,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
      writeSignedVarInt(Number(updated && updated.enchantLevel) || 0),
      writeSignedVarInt(Number(updated && updated.enchantExp) || 0),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function equipMaterialEnchantAck(user, req) {
  const target = req.valid ? getEquipItem(user, req.equipItemUID) : null;
  const targetTemplet = target ? getEquipTemplet(target.itemEquipId) : null;
  const requested = req.valid && Array.isArray(req.consumeEquipItemUIDList)
    ? req.consumeEquipItemUIDList.map((uid) => toBigInt(uid || 0))
    : [];
  const keys = requested.map(String);
  const materials = requested.map((uid) => getEquipItem(user, uid));
  const equippedUids = new Set(getArmyUnits(user).flatMap((unit) => (
    Array.isArray(unit.equipItemUids) ? unit.equipItemUids.map((uid) => String(toBigInt(uid || 0))) : []
  )));
  const targetOwner = getArmyUnits(user).find((unit) => (
    Array.isArray(unit.equipItemUids)
    && unit.equipItemUids.some((uid) => String(toBigInt(uid || 0)) === String(toBigInt(req.equipItemUID || 0)))
  ));
  const maxLevel = targetTemplet
    ? Math.min(Number(targetTemplet.m_MaxEnchantLevel || 10) || 10, getMaxEquipEnchantLevel(targetTemplet.m_NKM_ITEM_TIER) || 10, 10)
    : 0;
  const addedExp = materials.reduce((total, material) => (
    total + (material ? getEquipEnchantFeedExp(material.itemEquipId, material.enchantLevel) : 0)
  ), 0);
  const creditCost = BigInt(Math.max(0, addedExp * 8));
  const credit = getMiscItem(user, 1);
  const creditBalance = toBigInt(credit && credit.countFree || 0) + toBigInt(credit && credit.countPaid || 0);

  let errorCode = NEC_OK;
  if (!req.valid || !target || !targetTemplet) errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
  else if (Number(target.enchantLevel || 0) >= maxLevel) errorCode = NEC_FAIL_EQUIP_ITEM_ENCHANT_MAX;
  else if (
    requested.length === 0
    || requested.some((uid) => uid <= 0n || uid === toBigInt(target.equipUid))
    || new Set(keys).size !== keys.length
    || materials.some((material) => !material)
  ) errorCode = NEC_FAIL_INVALID_ITEM_UID;
  else {
    const deckError = targetOwner ? unitEquipDeckError(user, targetOwner.unitUid) : NEC_OK;
    if (deckError !== NEC_OK) errorCode = deckError;
    else if (materials.some((material) => material.locked)) errorCode = NEC_FAIL_ITEM_LOCKED;
    else if (materials.some((material) => (
      String(toBigInt(material.ownerUnitUid || 0)) !== "-1" || equippedUids.has(String(material.equipUid))
    ))) errorCode = NEC_FAIL_UNIT_EQUIP_ITEM;
    else if (addedExp <= 0) errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
    else if (creditBalance < creditCost) errorCode = NEC_FAIL_INSUFFICIENT_CREDIT;
  }

  const result = errorCode === NEC_OK
    ? enchantEquipItem(user, target.equipUid, requested)
    : null;
  const updated = result && result.equip || target;
  return {
    packetId: 1003,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
      writeSignedVarInt(Number(updated && updated.enchantLevel) || 0),
      writeSignedVarInt(Number(updated && updated.enchantExp) || 0),
      writeLongArray(result ? result.consumed : []),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function lockAck(user, req) {
  const equip = req.valid ? getEquipItem(user, req.equipItemUID) : null;
  const changed = Boolean(equip && equip.locked) !== Boolean(req.isLock);
  if (equip && changed) lockEquipItem(user, req.equipItemUID, req.isLock);
  return {
    packetId: 1005,
    payload: Buffer.concat([
      writeSignedVarInt(equip ? NEC_OK : NEC_FAIL_INVALID_EQUIP_ITEM),
      writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
      writeBool(Boolean(req.isLock)),
    ]),
    persist: Boolean(equip && changed),
  };
}

function removeAck(user, req) {
  const requested = req.valid && Array.isArray(req.removeEquipItemUIDList)
    ? req.removeEquipItemUIDList.map((uid) => toBigInt(uid || 0))
    : [];
  const keys = requested.map(String);
  const equips = requested.map((uid) => getEquipItem(user, uid));
  const equippedUids = new Set(getArmyUnits(user).flatMap((unit) => (
    Array.isArray(unit.equipItemUids) ? unit.equipItemUids.map((uid) => String(toBigInt(uid || 0))) : []
  )));

  let errorCode = NEC_OK;
  if (!req.valid || requested.length === 0 || requested.some((uid) => uid <= 0n) || new Set(keys).size !== keys.length) {
    errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
  } else if (equips.some((equip) => !equip)) {
    errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
  } else if (equips.some((equip) => equip.locked)) {
    errorCode = NEC_FAIL_ITEM_LOCKED;
  } else if (equips.some((equip) => String(toBigInt(equip.ownerUnitUid || 0)) !== "-1" || equippedUids.has(String(equip.equipUid)))) {
    errorCode = NEC_FAIL_CANNOT_UNEQUIP_ITEM;
  }

  const rewards = new Map();
  if (errorCode === NEC_OK) {
    for (const equip of equips) {
      const templet = getEquipTemplet(equip.itemEquipId) || {};
      for (let index = 1; index <= 2; index += 1) {
        const itemId = Number(templet[`m_OnRemoveItemID_${index}`] || 0);
        const count = Math.max(0, Math.trunc(Number(templet[`m_OnRemoveItemCount_${index}`] || 0)));
        if (itemId > 0 && count > 0) rewards.set(itemId, (rewards.get(itemId) || 0n) + BigInt(count));
      }
    }
  }
  const removed = errorCode === NEC_OK ? removeEquipItems(user, requested) : [];
  const rewardItems = errorCode === NEC_OK
    ? Array.from(rewards, ([itemId, count]) => grantMiscItem(user, itemId, count, 0n)).filter(Boolean)
    : [];
  return {
    packetId: 1007,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeLongArray(removed),
      writeObjectList(rewardItems.map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function randomBoxAck(ctx, user, req) {
  const itemId = Number(req.itemID || 0);
  const count = Number(req.count || 0);
  if (!req.valid) return itemConsumptionFailure(1009, NEC_FAIL_INVALID_REQUEST);
  const item = getMiscItemTemplet(itemId);
  if (!item || String(item.m_ItemMiscType || "") !== "IMT_RANDOMBOX") {
    return itemConsumptionFailure(1009, NEC_FAIL_INVALID_ITEM_ID);
  }
  if (!Number.isInteger(count) || count <= 0 || count > 10000) {
    return itemConsumptionFailure(1009, NEC_FAIL_RANDOM_ITEM_BOX_OPEN_COUNT_OVER_10);
  }
  if (!getRandomBoxRewards(item.m_RewardGroupID).length) {
    return itemConsumptionFailure(1009, NEC_FAIL_INVALID_ITEM_REWARD_GROUP_ID);
  }
  if (miscItemBalance(user, itemId) < BigInt(count)) {
    return itemConsumptionFailure(1009, NEC_FAIL_INSUFFICIENT_ITEM);
  }

  const costItem = spendMiscItem(user, itemId, count, { regDate: now(ctx) });
  const reward = grantRewardByType(ctx, user, "RT_MISC", itemId, count, count, 0, {
    expandPackages: true,
    openRandomBoxes: true,
    randomInt: ctx && typeof ctx.randomInt === "function" ? ctx.randomInt : undefined,
    regDate: now(ctx),
  });
  return {
    packetId: 1009,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildRewardData(reward)),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
    ]),
    persist: true,
  };
}

function craftUnlockAck(ctx, user, req) {
  const result = req.valid
    ? unlockCraftSlot(user, { regDate: now(ctx) })
    : { errorCode: NEC_FAIL_INVALID_REQUEST, slot: null, costItems: [] };
  const errorCode = Number(result && result.errorCode) || 0;
  return {
    packetId: 1011,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function craftStartAck(ctx, user, req) {
  const moldTemplet = req.valid ? getEquipMoldTemplet(req.moldID) : null;
  const nowDate = getServerNowDate(ctx);
  let result;
  if (!req.valid || !Number.isInteger(Number(req.count)) || Number(req.count) <= 0) {
    result = { errorCode: NEC_FAIL_INVALID_REQUEST, slot: null, costItems: [] };
  } else if (moldTemplet && !isEffectiveOpenTag(ctx, user, moldTemplet.m_OpenTag)) {
    result = { errorCode: NEC_FAIL_OPENTAG_CLOSED, slot: null, costItems: [] };
  } else if (moldTemplet && moldTemplet.m_DateStrID && !isIntervalActive(moldTemplet.m_DateStrID, nowDate)) {
    result = { errorCode: NEC_FAIL_CREAFT_MOLD_DATE_EXPIRED, slot: null, costItems: [] };
  } else if (
    moldTemplet &&
    moldCreatesEquipment(moldTemplet) &&
    getInventoryUsage(user, INVENTORY_TYPES.EQUIP) + Number(req.count || 0) > getEquipCraftCapacity(user)
  ) {
    result = { errorCode: NEC_FAIL_EQUIP_ITEM_FULL, slot: null, costItems: [] };
  } else {
    result = startCraft(user, req.index, req.moldID, req.count, { regDate: now(ctx) });
  }
  const errorCode = Number(result && result.errorCode) || 0;
  return {
    packetId: 1013,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildResetCountData(result && result.resetCount)),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function craftCompleteAck(ctx, user, req) {
  const result = req.valid
    ? completeCraft(user, req.index, {
      regDate: now(ctx),
      randomInt: ctx && typeof ctx.randomInt === "function" ? ctx.randomInt : undefined,
    })
    : { errorCode: NEC_FAIL_INVALID_REQUEST, slot: null, reward: createEmptyReward() };
  const errorCode = Number(result && result.errorCode) || 0;
  return {
    packetId: 1015,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeNullableObject(buildRewardData((result && result.reward) || createEmptyReward())),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function craftInstantCompleteAck(ctx, user, req) {
  const result = req.valid
    ? instantCompleteCraft(user, req.index, {
      regDate: now(ctx),
      randomInt: ctx && typeof ctx.randomInt === "function" ? ctx.randomInt : undefined,
    })
    : { errorCode: NEC_FAIL_INVALID_REQUEST, slot: null, extraCostItem: null, reward: createEmptyReward() };
  const errorCode = Number(result && result.errorCode) || 0;
  return {
    packetId: 1017,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeNullableObjectOrNull(result && result.extraCostItem ? buildItemMiscData(result.extraCostItem) : null),
      writeNullableObject(buildRewardData((result && result.reward) || createEmptyReward())),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function refineAck(user, req) {
  const target = validateTuningTarget(user, req, { refine: true });
  if (target.errorCode !== NEC_OK) return refineFailure(target.errorCode);
  if (activeTuningCandidate(user)) return refineFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS);
  const precision = target.slot === 2 ? Number(target.equip.precision2 || 0) : Number(target.equip.precision || 0);
  if (precision >= 100) return refineFailure(NEC_FAIL_EQUIP_TUNING_ALREADY_MAX_PRECISION);
  const insufficient = tuningCostError(user, target.templet, "precision");
  if (insufficient !== NEC_OK) return refineFailure(insufficient);
  const result = rollEquipPrecision(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1019,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(Number(result && result.refineResult) || 0),
      writeSignedVarInt(Number(result && result.precision) || 0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: true,
  };
}

function statRollAck(user, req) {
  const target = validateTuningTarget(user, req);
  if (target.errorCode !== NEC_OK) return statRollFailure(target.errorCode, req.equipOptionID);
  const active = activeTuningCandidate(user);
  if (active && (active.equipUid !== String(target.equip.equipUid) || active.slot !== target.slot || active.setOptionId > 0)) {
    return statRollFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS, req.equipOptionID);
  }
  const resetCount = Number(user.equipResetCounts && user.equipResetCounts[String(TUNING_BONUS_RESET_GROUP_ID)] || 0);
  if (resetCount >= TUNING_BONUS_MAX_COUNT) {
    return statRollFailure(NEC_FAIL_EQUIP_TUNING_OPTION_CHANGE_ALREADY_HAS_BONUS, req.equipOptionID);
  }
  const insufficient = tuningCostError(user, target.templet, "stat");
  if (insufficient !== NEC_OK) return statRollFailure(insufficient, req.equipOptionID);
  const result = rollEquipSubstat(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1021,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(Number(req.equipOptionID || 0) || 0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
      writeNullableObject(buildResetCountData(result && result.resetCount)),
    ]),
    persist: true,
  };
}

function statConfirmAck(user, req) {
  const target = validateTuningTarget(user, req);
  if (target.errorCode !== NEC_OK) return statConfirmFailure(target.errorCode);
  const active = activeTuningCandidate(user);
  if (!active || active.equipUid !== String(target.equip.equipUid) || active.slot !== target.slot || active.setOptionId > 0) {
    return statConfirmFailure(NEC_FAIL_EQUIP_TUNING_RESERVED_STAT_EMPTY);
  }
  const result = confirmEquipSubstat(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1023,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
    ]),
    persist: true,
  };
}

function statBonusConfirmAck(user, req) {
  const target = validateTuningTarget(user, req);
  if (target.errorCode !== NEC_OK) return statBonusConfirmFailure(target.errorCode);
  if (activeTuningCandidate(user)) return statBonusConfirmFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS);
  const resetCount = Number(user.equipResetCounts && user.equipResetCounts[String(TUNING_BONUS_RESET_GROUP_ID)] || 0);
  if (resetCount < TUNING_BONUS_MAX_COUNT) {
    return statBonusConfirmFailure(NEC_FAIL_EQUIP_OPTION_BONUS_COUNT_NOT_ENOUGH_COUNT);
  }
  const selectedType = statTypeName(req.statType);
  if (!selectedType || !target.statRecords.some((record) => String(record.m_StatType) === selectedType)) {
    return statBonusConfirmFailure(NEC_FAIL_INVALID_EQUIP_OPTION_ID);
  }
  const other = target.equip.stats && target.equip.stats[target.slot === 1 ? 2 : 1];
  if (other && String(other.type || "") === selectedType) {
    return statBonusConfirmFailure(NEC_FAIL_INVALID_EQUIP_OPTION_DUPLICATE);
  }
  const rolled = rollEquipSubstat(user, req.equipUid, req.equipOptionId, req.statType);
  const result = confirmEquipSubstat(user, req.equipUid, req.equipOptionId);
  return {
    packetId: 1025,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : rolled && rolled.equip ? buildEquipItemData(rolled.equip) : null),
      writeNullableObject(buildResetCountData(rolled && rolled.resetCount)),
    ]),
    persist: true,
  };
}

function validateTuningTarget(user, req, options = {}) {
  if (!req.valid) return { errorCode: NEC_FAIL_INVALID_REQUEST };
  const equip = getEquipItem(user, req.equipUID != null ? req.equipUID : req.equipUid);
  if (!equip) return { errorCode: NEC_FAIL_INVALID_EQUIP_ITEM };
  const optionId = Number(req.equipOptionID != null ? req.equipOptionID : req.equipOptionId);
  if (optionId !== 1 && optionId !== 2) {
    return { errorCode: options.refine ? NEC_FAIL_REFINE_EQUIP_ITEM_OPTION : NEC_FAIL_INVALID_EQUIP_OPTION_ID };
  }
  const templet = getEquipTemplet(equip.itemEquipId);
  if (!templet) return { errorCode: NEC_FAIL_INVALID_EQUIP_ITEM };
  const slot = optionId;
  const groupId = Number((slot === 2 ? templet.m_StatGroupID_2 : templet.m_StatGroupID) || 0);
  const statRecords = getEquipRandomStatRecords(groupId);
  if (groupId <= 0 || statRecords.length === 0) {
    return { errorCode: options.refine ? NEC_FAIL_REFINE_EQUIP_ITEM_OPTION : NEC_FAIL_EQUIP_TUNING_RANDOM_STAT_GROUP_EMPTY };
  }
  return { errorCode: NEC_OK, equip, templet, slot, groupId, statRecords };
}

function activeTuningCandidate(user) {
  for (const equip of getEquipItems(user)) {
    const candidate = equip && equip.tuningCandidate;
    if (!candidate || toBigInt(candidate.equipUid || 0) <= 0n) continue;
    const option1 = String(candidate.option1 || "NST_RANDOM");
    const option2 = String(candidate.option2 || "NST_RANDOM");
    const setOptionId = Number(candidate.setOptionId || 0);
    if (option1 === "NST_RANDOM" && option2 === "NST_RANDOM" && setOptionId === 0) continue;
    return {
      equipUid: String(toBigInt(candidate.equipUid)),
      slot: option1 !== "NST_RANDOM" ? 1 : option2 !== "NST_RANDOM" ? 2 : 0,
      setOptionId,
      candidate,
    };
  }
  return null;
}

function tuningCostError(user, templet, kind) {
  const credit = Math.max(0, Math.trunc(Number(kind === "precision" ? templet.m_PrecisionReqResource : templet.m_RandomStatReqResource) || 0));
  const material = Math.max(0, Math.trunc(Number(kind === "precision" ? templet.m_PrecisionReqItem : templet.m_RandomStatReqItem) || 0));
  if (miscItemBalance(user, 1) < BigInt(credit)) return NEC_FAIL_INSUFFICIENT_CREDIT;
  if (miscItemBalance(user, TUNING_MATERIAL_ITEM_ID) < BigInt(material)) return NEC_FAIL_INSUFFICIENT_ITEM;
  return NEC_OK;
}

function refineFailure(errorCode) {
  return {
    packetId: 1019,
    payload: Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarInt(0), writeSignedVarInt(0), writeNullObject(), writeObjectList([])]),
    persist: false,
  };
}

function statRollFailure(errorCode, optionId) {
  return {
    packetId: 1021,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarInt(Number(optionId || 0)),
      writeNullObject(),
      writeObjectList([]),
      writeNullableObject(buildEquipTuningCandidateData()),
      writeNullableObject(buildResetCountData()),
    ]),
    persist: false,
  };
}

function statConfirmFailure(errorCode) {
  return {
    packetId: 1023,
    payload: Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeNullableObject(buildEquipTuningCandidateData())]),
    persist: false,
  };
}

function statBonusConfirmFailure(errorCode) {
  return {
    packetId: 1025,
    payload: Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeNullableObject(buildResetCountData())]),
    persist: false,
  };
}

function choiceItemAck(ctx, user, req) {
  const itemId = Number(req.itemId || 0);
  const rewardId = Number(req.rewardId || 0);
  const count = Number(req.count || 0);
  if (!req.valid) return itemConsumptionFailure(1027, NEC_FAIL_INVALID_REQUEST);
  const item = getMiscItemTemplet(itemId);
  if (!item || !String(item.m_ItemMiscType || "").startsWith("IMT_CHOICE_")) {
    return itemConsumptionFailure(1027, NEC_FAIL_INVALID_ITEM_ID);
  }
  if (!Number.isInteger(count) || count <= 0 || count > 10000 || (item.m_ItemMiscType !== "IMT_CHOICE_MISC" && count !== 1)) {
    return itemConsumptionFailure(1027, NEC_FAIL_INVALID_REQUEST);
  }
  const rewardRecord = getChoiceRewardRecords(itemId).find((record) => Number(record && record.m_RewardID) === rewardId);
  if (!rewardRecord) return itemConsumptionFailure(1027, NEC_FAIL_INVALID_ITEM_REWARD_GROUP_ID);
  const selector = validateChoiceSelector(item, rewardRecord, req);
  if (!selector.valid) return itemConsumptionFailure(1027, selector.errorCode);
  if (miscItemBalance(user, itemId) < BigInt(count)) {
    return itemConsumptionFailure(1027, NEC_FAIL_INSUFFICIENT_ITEM);
  }

  const costItem = spendMiscItem(user, itemId, count, { regDate: now(ctx) });
  const reward = grantChoiceItemReward(ctx, user, itemId, rewardId, count, {
    expandPackages: true,
    regDate: now(ctx),
    rewardId,
    setOptionId: selector.setOptionId,
    subSkillId: Number(req.subSkillId || 0),
    customSubstats: selector.customSubstats,
    potentialOptions: selector.potentialOptions,
  });
  return {
    packetId: 1027,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
      writeNullableObject(buildRewardData(reward)),
    ]),
    persist: true,
  };
}

function itemConsumptionFailure(packetId, errorCode) {
  return {
    packetId,
    payload: Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeNullObject()]),
    persist: false,
  };
}

function miscItemBalance(user, itemId) {
  const item = getMiscItem(user, itemId) || {};
  return toBigInt(item.countFree || 0) + toBigInt(item.countPaid || 0);
}

function validateChoiceSelector(item, rewardRecord, req) {
  const type = String(item.m_ItemMiscType || "");
  const rewardType = String(rewardRecord.m_RewardType || "");
  const setOptionId = Number(req.setOptionId || 0);
  const statTypes = Array.isArray(req.statTypes) ? req.statTypes : [];
  const potentialOptionId = Number(req.potentialOptionId || 0);
  const potentialOption2Id = Number(req.potentialOption2Id || 0);

  if (type !== "IMT_CHOICE_EQUIP") {
    if (setOptionId !== 0 || statTypes.length || potentialOptionId !== 0 || potentialOption2Id !== 0) {
      return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
    }
    if (type === "IMT_CHOICE_OPERATOR") {
      const customBox = getCustomBoxTemplet(item.m_CustomBoxID);
      const allowedSkills = Array.isArray(customBox && customBox.CustomOprSkill) ? customBox.CustomOprSkill.map(Number) : [];
      if (allowedSkills.length ? !allowedSkills.includes(Number(req.subSkillId)) : Number(req.subSkillId) !== 0) {
        return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
      }
      if (req.subSkillId > 0 && !getOperatorSkillTemplet(req.subSkillId)) {
        return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
      }
    } else if (Number(req.subSkillId) !== 0) {
      return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
    }
    return { valid: true, setOptionId: 0, customSubstats: [], potentialOptions: undefined };
  }

  if (rewardType !== "RT_EQUIP") return { valid: false, errorCode: NEC_FAIL_INVALID_ITEM_REWARD_GROUP_ID };
  const equip = getEquipTemplet(rewardRecord.m_RewardID);
  if (!equip) return { valid: false, errorCode: NEC_FAIL_INVALID_ITEM_ID };
  const flags = parseChoiceEquipOptions(item.m_Option);

  if (flags.stat) {
    if (statTypes.length !== 2) return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
    const groups = [equip.m_StatGroupID, equip.m_StatGroupID_2];
    for (let index = 0; index < 2; index += 1) {
      const name = statTypeName(statTypes[index]);
      const allowed = getEquipRandomStatRecords(groups[index]).some((record) => record.m_StatType === name);
      if (!name || !allowed) return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
    }
  } else if (statTypes.length) {
    return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
  }

  if (flags.setOption) {
    if (!getEquipSetOptionIds(equip).includes(setOptionId)) {
      return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
    }
  } else if (setOptionId !== 0) {
    return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
  }

  const potentialGroups = [Number(equip.m_PotentialOptionGroupID || 0), Number(equip.m_SubPotentialOptionGroupID || 0)];
  const potentialIds = [potentialOptionId, potentialOption2Id];
  const potentialOptions = [];
  if (flags.potential) {
    for (let index = 0; index < potentialGroups.length; index += 1) {
      const groupId = potentialGroups[index];
      const optionId = potentialIds[index];
      if (groupId <= 0) {
        if (optionId !== 0) return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
        continue;
      }
      const record = getEquipPotentialOptionRecords(groupId).find((entry) => Number(entry.OptionKey) === optionId);
      if (!record) return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
      potentialOptions.push(buildSelectedPotentialOption(record, flags.potentialMax && index === 0));
    }
  } else if (potentialIds.some((value) => value !== 0)) {
    return { valid: false, errorCode: NEC_FAIL_INVALID_REQUEST };
  }

  return {
    valid: true,
    setOptionId,
    customSubstats: statTypes.map((value, index) => ({ slot: index + 1, type: statTypeName(value) })),
    potentialOptions: flags.potential ? potentialOptions : undefined,
  };
}

function parseChoiceEquipOptions(value) {
  const flags = { stat: false, setOption: false, potential: false, potentialMax: false };
  for (const part of String(value || "").split(";")) {
    const [rawKey, rawValue] = part.split("=");
    const enabled = String(rawValue || "").trim().toLowerCase() === "true";
    switch (String(rawKey || "").trim()) {
      case "Stat": flags.stat = enabled; break;
      case "SetOption": flags.setOption = enabled; break;
      case "PotenOption": flags.potential = enabled; break;
      case "PotenOptionMax": flags.potentialMax = enabled; break;
      default: break;
    }
  }
  return flags;
}

function buildSelectedPotentialOption(record, maximumFirstSocket) {
  const statType = String(record.Socket1_StatType || "NST_RANDOM");
  const max = Number(record.Socket1_MaxStat != null ? record.Socket1_MaxStat : record.Socket1_MaxStatRate || 0);
  return {
    optionKey: Number(record.OptionKey || 0),
    statType,
    sockets: maximumFirstSocket ? [{ statValue: max, precision: 100 }, null, null] : [null, null, null],
    precisionChangeCount: 0,
  };
}

function setOptionRollAck(user, req) {
  const target = validateSetOptionTarget(user, req);
  if (target.errorCode !== NEC_OK) return setOptionRollFailure(target.errorCode, req.equipUID);
  if (Number(target.equip.setOptionId || 0) <= 0) return setOptionRollFailure(NEC_FAIL_NOT_EXIST_SET_OPTION, req.equipUID);
  if (target.setOptionIds.length <= 1) return setOptionRollFailure(NEC_FAIL_INVALID_EQUIP_OPTION_ID, req.equipUID);
  const active = activeTuningCandidate(user);
  if (active && (active.equipUid !== String(target.equip.equipUid) || active.setOptionId <= 0 || active.slot !== 0)) {
    return setOptionRollFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS, req.equipUID);
  }
  const resetCount = Number(user.equipResetCounts && user.equipResetCounts[String(SET_BONUS_RESET_GROUP_ID)] || 0);
  if (resetCount >= TUNING_BONUS_MAX_COUNT) {
    return setOptionRollFailure(NEC_FAIL_EQUIP_SET_OPTION_CHANGE_ALREADY_HAS_BONUS, req.equipUID);
  }
  const insufficient = setOptionCostError(user, target.templet);
  if (insufficient !== NEC_OK) return setOptionRollFailure(insufficient, req.equipUID);
  const result = rollSetOption(user, req.equipUID);
  return {
    packetId: 1029,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
      writeNullableObject(buildResetCountData(result && result.resetCount)),
    ]),
    persist: true,
  };
}

function setOptionConfirmAck(user, req) {
  const target = validateSetOptionTarget(user, req);
  if (target.errorCode !== NEC_OK) return setOptionConfirmFailure(target.errorCode, req.equipUID);
  const active = activeTuningCandidate(user);
  if (!active || active.equipUid !== String(target.equip.equipUid) || active.setOptionId <= 0 || active.slot !== 0) {
    return setOptionConfirmFailure(NEC_FAIL_SELECT_EQUIP_OPTION_DATA, req.equipUID);
  }
  const result = confirmSetOption(user, req.equipUID);
  return {
    packetId: 1031,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
    ]),
    persist: true,
  };
}

function setOptionBonusConfirmAck(user, req) {
  const target = validateSetOptionTarget(user, req);
  if (target.errorCode !== NEC_OK) return setOptionBonusFailure(target.errorCode, req.equipUid, req.setOptionId);
  if (activeTuningCandidate(user)) return setOptionBonusFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS, req.equipUid, req.setOptionId);
  const resetCount = Number(user.equipResetCounts && user.equipResetCounts[String(SET_BONUS_RESET_GROUP_ID)] || 0);
  if (resetCount < TUNING_BONUS_MAX_COUNT) {
    return setOptionBonusFailure(NEC_FAIL_EQUIP_OPTION_BONUS_COUNT_NOT_ENOUGH_COUNT, req.equipUid, req.setOptionId);
  }
  const setOptionId = Number(req.setOptionId || 0);
  if (!target.setOptionIds.includes(setOptionId)) {
    return setOptionBonusFailure(NEC_FAIL_INVALID_SET_OPTION_ID, req.equipUid, req.setOptionId);
  }
  if (setOptionId === Number(target.equip.setOptionId || 0)) {
    return setOptionBonusFailure(NEC_FAIL_INVALID_EQUIP_OPTION_DUPLICATE, req.equipUid, req.setOptionId);
  }
  const rolled = rollSetOption(user, req.equipUid, setOptionId);
  const result = confirmSetOption(user, req.equipUid, setOptionId);
  return {
    packetId: 1033,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUid || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeNullableObject(buildResetCountData((rolled && rolled.resetCount) || (result && result.resetCount))),
    ]),
    persist: true,
  };
}

function firstSetOptionAck(user, req) {
  const target = validateSetOptionTarget(user, req);
  if (target.errorCode !== NEC_OK) return firstSetOptionFailure(target.errorCode, req.equipUID);
  if (Number(target.equip.setOptionId || 0) > 0) {
    return firstSetOptionFailure(NEC_FAIL_ALREADY_APPLY_SET_OPTION, req.equipUID);
  }
  if (activeTuningCandidate(user)) return firstSetOptionFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS, req.equipUID);
  const rolled = rollSetOption(user, req.equipUID, null, { free: true, skipResetCount: true });
  const result = confirmSetOption(user, req.equipUID, rolled && rolled.setOptionId);
  return {
    packetId: 1035,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
    ]),
    persist: true,
  };
}

function validateSetOptionTarget(user, req) {
  if (!req.valid) return { errorCode: NEC_FAIL_INVALID_REQUEST };
  const equip = getEquipItem(user, req.equipUID != null ? req.equipUID : req.equipUid);
  if (!equip) return { errorCode: NEC_FAIL_INVALID_EQUIP_ITEM };
  const templet = getEquipTemplet(equip.itemEquipId);
  if (!templet) return { errorCode: NEC_FAIL_INVALID_EQUIP_ITEM };
  const setOptionIds = getEquipSetOptionIds(templet);
  if (!setOptionIds.length) return { errorCode: NEC_FAIL_NOT_EXIST_SET_OPTION };
  return { errorCode: NEC_OK, equip, templet, setOptionIds };
}

function setOptionCostError(user, templet) {
  const credit = Math.max(0, Math.trunc(Number(templet.m_RandomSetReqResource) || 0));
  const itemId = Number(templet.m_RandomSetReqItemID || 0);
  const itemCount = Math.max(0, Math.trunc(Number(templet.m_RandomSetReqItemValue) || 0));
  if (miscItemBalance(user, 1) < BigInt(credit)) return NEC_FAIL_INSUFFICIENT_CREDIT;
  if (itemId <= 0 || miscItemBalance(user, itemId) < BigInt(itemCount)) return NEC_FAIL_INSUFFICIENT_ITEM;
  return NEC_OK;
}

function setOptionRollFailure(errorCode, equipUid) {
  return {
    packetId: 1029,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarLong(toBigInt(equipUid || 0)),
      writeSignedVarInt(0),
      writeObjectList([]),
      writeNullableObject(buildEquipTuningCandidateData()),
      writeNullableObject(buildResetCountData()),
    ]),
    persist: false,
  };
}

function setOptionConfirmFailure(errorCode, equipUid) {
  return {
    packetId: 1031,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarLong(toBigInt(equipUid || 0)),
      writeSignedVarInt(0),
      writeNullableObject(buildEquipTuningCandidateData()),
    ]),
    persist: false,
  };
}

function setOptionBonusFailure(errorCode, equipUid, setOptionId) {
  return {
    packetId: 1033,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarLong(toBigInt(equipUid || 0)),
      writeSignedVarInt(Number(setOptionId || 0)),
      writeNullableObject(buildResetCountData()),
    ]),
    persist: false,
  };
}

function firstSetOptionFailure(errorCode, equipUid) {
  return {
    packetId: 1035,
    payload: Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarLong(toBigInt(equipUid || 0)), writeSignedVarInt(0)]),
    persist: false,
  };
}

function profileAck(user) {
  return {
    packetId: 1037,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(getEquipItems(user).map((equip) => writeNullableObject(buildEquipProfileInfoData(equip)))),
    ]),
  };
}

function presetListAck(user) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeObjectList(getEquipPresets(user).map((preset) => writeNullableObject(buildEquipPresetData(preset)))),
  ]);
}

function buildEquipPresetNotPayload(user) {
  return writeObjectList(getEquipPresets(user).map((preset) => writeNullableObject(buildEquipPresetData(preset))));
}

function presetAddAck(user, req) {
  const currentCount = getEquipPresets(user).length;
  const addCount = Number(req.addPresetCount);
  let errorCode = NEC_OK;
  if (!req.valid || !Number.isInteger(addCount) || addCount <= 0) {
    errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_ADD_COUNT;
  } else if (currentCount + addCount > EQUIP_PRESET_MAX_COUNT) {
    errorCode = NEC_FAIL_EQUIP_PRESET_MAX_COUNT;
  }
  const cost = addCount * EQUIP_PRESET_EXPAND_COST_VALUE;
  const balance = getMiscItem(user, EQUIP_PRESET_EXPAND_COST_ITEM_ID);
  const available = toBigInt(balance && balance.countFree) + toBigInt(balance && balance.countPaid);
  if (errorCode === NEC_OK && available < BigInt(cost)) errorCode = NEC_FAIL_INSUFFICIENT_ITEM;

  const costItem = errorCode === NEC_OK ? spendMiscItem(user, EQUIP_PRESET_EXPAND_COST_ITEM_ID, cost) : null;
  const totalCount = errorCode === NEC_OK ? addEquipPresets(user, addCount) : currentCount;
  return {
    packetId: 1041,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarInt(totalCount),
      writeObjectList(costItem ? [writeNullableObject(buildItemMiscData(costItem))] : []),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function presetNameAck(user, req) {
  const presets = getEquipPresets(user);
  const validIndex = Boolean(req.valid && Number.isInteger(req.presetIndex) && req.presetIndex >= 0 && req.presetIndex < presets.length);
  const validName = typeof req.newPresetName === "string" && req.newPresetName.length <= EQUIP_PRESET_NAME_MAX_LENGTH;
  const errorCode = validIndex
    ? (validName ? NEC_OK : NEC_FAIL_EQUIP_PRESET_INVALID_NAME)
    : NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX;
  const changed = errorCode === NEC_OK && presets[req.presetIndex].presetName !== req.newPresetName;
  if (changed) setEquipPresetName(user, req.presetIndex, req.newPresetName);
  return {
    packetId: 1043,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarInt(Number(req.presetIndex || 0) || 0),
      writeString(req.newPresetName || ""),
    ]),
    persist: Boolean(changed),
  };
}

function presetRegisterAllAck(user, req) {
  const presets = getEquipPresets(user);
  const validIndex = Boolean(
    req.valid
    && Number.isInteger(req.presetIndex)
    && req.presetIndex >= 0
    && req.presetIndex < presets.length
  );
  const unit = validIndex ? getArmyUnitByUid(user, req.unitUid) : null;
  const unitTemplet = unit ? getUnitTemplet(unit.unitId) : null;
  const unitStyle = String((unitTemplet && unitTemplet.m_NKM_UNIT_STYLE_TYPE) || "");
  const supportedStyle = new Set(["NUST_COUNTER", "NUST_SOLDIER", "NUST_MECHANIC"]);
  const equipUids = unit && Array.isArray(unit.equipItemUids) ? unit.equipItemUids.map((uid) => toBigInt(uid || 0)) : [];
  const nonzeroUids = equipUids.filter((uid) => uid > 0n);
  const uniqueUids = new Set(nonzeroUids.map(String));
  const equippedItems = equipUids.map((uid) => uid > 0n ? getEquipItem(user, uid) : null);
  const validEquips = equipUids.length === 4 && nonzeroUids.length > 0 && equippedItems.every((equip, index) => {
    if (equipUids[index] === 0n) return true;
    if (!equip) return false;
    const templet = getEquipTemplet(equip.itemEquipId);
    return Boolean(
      templet
      && isValidEquipPosition(templet, index)
      && String(templet.m_EquipUnitStyleType || "") === unitStyle
    );
  });

  let errorCode = NEC_OK;
  if (!validIndex) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX;
  else if (!unit) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA;
  else if (!unitTemplet) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_TEMPLT;
  else if (unitTemplet.m_NKM_UNIT_TYPE !== "NUT_NORMAL" || !supportedStyle.has(unitStyle)) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_TYPE;
  else if (uniqueUids.size !== nonzeroUids.length) errorCode = NEC_FAIL_EQUIP_PRESET_DUPLICATE_EQUIP_UID;
  else if (!validEquips) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS;

  const current = validIndex ? presets[req.presetIndex] : null;
  const changed = errorCode === NEC_OK && current.equipUids.some((uid, index) => toBigInt(uid || 0) !== equipUids[index]);
  const preset = changed ? registerEquipPresetFromUnit(user, req.unitUid, req.presetIndex) : current;
  return {
    packetId: 1045,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      errorCode === NEC_OK ? writeNullableObject(buildEquipPresetData(preset)) : writeNullObject(),
    ]),
    persist: Boolean(changed),
  };
}

function presetRegisterAck(user, req) {
  const presets = getEquipPresets(user);
  const validIndex = Boolean(
    req.valid
    && Number.isInteger(req.presetIndex)
    && req.presetIndex >= 0
    && req.presetIndex < presets.length
  );
  const validPosition = Number.isInteger(req.equipPosition) && req.equipPosition >= 0 && req.equipPosition <= 3;
  const requestedUid = toBigInt(req.equipUid || 0);
  const equip = requestedUid > 0n ? getEquipItem(user, requestedUid) : null;
  const templet = equip ? getEquipTemplet(equip.itemEquipId) : null;
  const preset = validIndex ? presets[req.presetIndex] : null;
  const slots = preset ? preset.equipUids.map((uid) => String(toBigInt(uid || 0))) : [];
  const requestedStyle = String((templet && templet.m_EquipUnitStyleType) || "");
  const presetStyles = slots
    .map((uid, index) => index === req.equipPosition ? null : getEquipItem(user, uid))
    .filter(Boolean)
    .map((item) => getEquipTemplet(item.itemEquipId))
    .filter(Boolean)
    .map((itemTemplet) => String(itemTemplet.m_EquipUnitStyleType || ""));
  const supportedStyle = new Set(["NUST_COUNTER", "NUST_SOLDIER", "NUST_MECHANIC"]);
  const typeMismatch = equip && (!supportedStyle.has(requestedStyle) || presetStyles.some((style) => style !== requestedStyle));

  let errorCode = NEC_OK;
  if (!validIndex) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX;
  else if (!validPosition) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION;
  else if (requestedUid > 0n && !equip) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS;
  else if (equip && !isValidEquipPosition(templet, req.equipPosition)) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION;
  else if (typeMismatch) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE;

  const changed = errorCode === NEC_OK && slots[req.equipPosition] !== String(requestedUid);
  const updated = changed ? registerEquipPreset(user, req.presetIndex, req.equipPosition, requestedUid) : preset;
  return {
    packetId: 1047,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      errorCode === NEC_OK ? writeNullableObject(buildEquipPresetData(updated)) : writeNullObject(),
    ]),
    persist: Boolean(changed),
  };
}

function equipPositionValue(value) {
  return ({ IEP_WEAPON: 0, IEP_DEFENCE: 1, IEP_ACC: 2, IEP_ACC2: 3 })[String(value || "")] ?? -1;
}

function isValidEquipPosition(templet, position) {
  const numeric = Number(position);
  const expected = String((templet && templet.m_ItemEquipPosition) || "");
  if (numeric === 2 || numeric === 3) return expected === "IEP_ACC";
  return equipPositionValue(expected) === numeric;
}

function presetApplyAck(user, req) {
  const presets = getEquipPresets(user);
  const validIndex = Boolean(
    req.valid
    && Number.isInteger(req.presetIndex)
    && req.presetIndex >= 0
    && req.presetIndex < presets.length
  );
  const unit = validIndex ? getArmyUnitByUid(user, req.applyUnitUid) : null;
  const unitTemplet = unit ? getUnitTemplet(unit.unitId) : null;
  const unitStyle = String((unitTemplet && unitTemplet.m_NKM_UNIT_STYLE_TYPE) || "");
  const supportedStyle = new Set(["NUST_COUNTER", "NUST_SOLDIER", "NUST_MECHANIC"]);
  const preset = validIndex ? presets[req.presetIndex] : null;
  const equipUids = preset ? preset.equipUids.map((uid) => toBigInt(uid || 0)) : [];
  const nonzeroUids = equipUids.filter((uid) => uid > 0n);
  const equipTemplets = equipUids.map((uid) => {
    const equip = uid > 0n ? getEquipItem(user, uid) : null;
    return equip ? getEquipTemplet(equip.itemEquipId) : null;
  });
  const validEquips = equipUids.length === 4 && nonzeroUids.length > 0 && equipTemplets.every((templet, index) => (
    equipUids[index] === 0n
    || Boolean(templet && isValidEquipPosition(templet, index))
  ));
  const typeMismatch = validEquips && equipTemplets.some((templet) => templet && String(templet.m_EquipUnitStyleType || "") !== unitStyle);
  const privateMismatch = validEquips && equipTemplets.some((templet) => templet && !isPrivateEquipForUnit(templet, unitTemplet));

  let errorCode = NEC_OK;
  if (!validIndex) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX;
  else if (!unit) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_DATA;
  else if (!unitTemplet) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_TEMPLT;
  else if (unitTemplet.m_NKM_UNIT_TYPE !== "NUT_NORMAL" || !supportedStyle.has(unitStyle)) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_TYPE;
  else if (!validEquips) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_UNIT_EQUIP_UIDS;
  else if (equipUids[3] > 0n && Number(unit.limitBreakLevel || 0) < 3) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_POSITION;
  else if (typeMismatch) errorCode = NEC_FAIL_EQUIP_PRESET_INVALID_EQUIP_TYPE;
  else if (privateMismatch) errorCode = NEC_FAIL_EQUIP_PRIVATE;

  const currentSlots = unit && Array.isArray(unit.equipItemUids) ? unit.equipItemUids.map((uid) => toBigInt(uid || 0)) : [];
  const changed = errorCode === NEC_OK && equipUids.some((uid, index) => uid !== currentSlots[index]);
  const update = changed ? applyEquipPreset(user, req.presetIndex, req.applyUnitUid) : null;
  const updates = errorCode !== NEC_OK
    ? []
    : (update && Array.isArray(update.updates) && update.updates.length
      ? update.updates
      : [{ unitUid: String(toBigInt(req.applyUnitUid)), equipUids: currentSlots }]);
  return {
    packetId: 1049,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarInt(Number(req.presetIndex || 0) || 0),
      writeObjectList(updates.map((entry) => writeNullableObject(Buffer.concat([
        writeSignedVarLong(toBigInt(entry.unitUid || 0)),
        writeLongArray(entry.equipUids || []),
      ])))),
    ]),
    persist: Boolean(changed),
  };
}

function isPrivateEquipForUnit(equipTemplet, unitTemplet) {
  const privateUnitIds = Array.isArray(equipTemplet && equipTemplet.m_lstPrivateUnitID)
    ? equipTemplet.m_lstPrivateUnitID.map(Number).filter((unitId) => unitId > 0)
    : [];
  if (!privateUnitIds.length) return true;
  if (!unitTemplet) return false;
  const targetBaseId = Number(unitTemplet.m_BaseUnitID || unitTemplet.m_UnitID || 0);
  return privateUnitIds.some((unitId) => {
    const privateTemplet = getUnitTemplet(unitId);
    return Number((privateTemplet && privateTemplet.m_BaseUnitID) || unitId) === targetBaseId;
  });
}

function tuningCancelAck(user, req) {
  if (!req.valid) {
    return {
      packetId: 1053,
      payload: Buffer.concat([writeSignedVarInt(NEC_FAIL_INVALID_REQUEST), writeNullableObject(buildEquipTuningCandidateData())]),
      persist: false,
    };
  }
  const active = activeTuningCandidate(user);
  const candidate = active ? cancelEquipTuning(user) : {};
  return {
    packetId: 1053,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipTuningCandidateData(candidate))]),
    persist: Boolean(active),
  };
}

function imprintAck(user, req) {
  const equip = imprintEquip(user, req.equipUid, req.unitId);
  return {
    packetId: 1056,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
  };
}

function upgradeAck(user, req) {
  const equip = req.valid ? getEquipItem(user, req.equipUid) : null;
  const upgrade = equip ? getEquipUpgradeTemplet(equip.itemEquipId) : null;
  const requestedMaterials = Array.isArray(req.consumeEquipItemUidList) ? req.consumeEquipItemUidList.map((uid) => toBigInt(uid || 0)) : [];
  const requirements = getEquipUpgradeRequirements(upgrade);
  const materialItems = requestedMaterials.map((uid) => getEquipItem(user, uid));

  let errorCode = NEC_OK;
  if (!req.valid || !equip) {
    errorCode = req.valid ? NEC_FAIL_INVALID_EQUIP_ITEM : NEC_FAIL_EQUIP_UPGRADE_DATA;
  } else if (!upgrade || !getEquipTemplet(upgrade.UpgradeEquipID)) {
    errorCode = NEC_FAIL_EQUIP_UPGRADE_TEMPLET;
  } else if (Number(equip.enchantLevel || 0) < Number(getEquipTemplet(equip.itemEquipId).m_MaxEnchantLevel || 0) || Number(equip.precision || 0) < 100 || Number(equip.precision2 || 0) < 100) {
    errorCode = NEC_FAIL_EQUIP_UPGRADE_CONDITION;
  } else if (
    requestedMaterials.some((uid) => uid <= 0n || uid === toBigInt(equip.equipUid))
    || new Set(requestedMaterials.map(String)).size !== requestedMaterials.length
    || requestedMaterials.length !== requirements.equipIds.length
    || materialItems.some((item) => !item || item.locked || toBigInt(item.ownerUnitUid || -1) > 0n)
    || !sameNumberMultiset(materialItems.map((item) => item && item.itemEquipId), requirements.equipIds)
  ) {
    errorCode = NEC_FAIL_EQUIP_UPGRADE_MATERIAL;
  }

  if (errorCode === NEC_OK) {
    for (const cost of requirements.miscCosts) {
      const item = getMiscItem(user, cost.itemId);
      const balance = toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0);
      if (balance >= BigInt(cost.count)) continue;
      errorCode = cost.itemId === 1 ? NEC_FAIL_INSUFFICIENT_CREDIT : NEC_FAIL_INSUFFICIENT_ITEM;
      break;
    }
  }

  const result = errorCode === NEC_OK ? upgradeEquipItem(user, equip.equipUid, requestedMaterials) : null;
  return {
    packetId: 1058,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeLongArray(result ? result.consumed : []),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function getEquipUpgradeRequirements(upgrade) {
  const equipIds = [];
  const miscCosts = [{ itemId: 1, count: Number(upgrade && upgrade.UpgradeReqResource || 0) }];
  for (let index = 1; index <= 10; index += 1) {
    const type = String(upgrade && upgrade[`Material${index}_ItemType`] || "");
    if (!type) break;
    const itemId = Number(upgrade[`Material${index}_ItemID`] || 0);
    const count = Math.max(0, Math.trunc(Number(upgrade[`Material${index}_ItemCount`] || 0)));
    if (type === "RT_MISC") miscCosts.push({ itemId, count });
    if (type === "RT_EQUIP") for (let amount = 0; amount < count; amount += 1) equipIds.push(itemId);
  }
  return {
    equipIds,
    miscCosts: miscCosts.filter((cost) => cost.itemId > 0 && cost.count > 0),
  };
}

function sameNumberMultiset(actual, expected) {
  const sort = (values) => values.map(Number).sort((left, right) => left - right);
  return JSON.stringify(sort(actual)) === JSON.stringify(sort(expected));
}

function openSocketAck(user, req) {
  const equip = req.valid ? getEquipItem(user, req.equipUid) : null;
  const templet = equip ? getEquipTemplet(equip.itemEquipId) : null;
  const socketIndex = Number(req.socketIndex);
  const sockets = (((equip && equip.potentialOptions || [])[0] || {}).sockets || []);
  const openedCount = sockets.filter(Boolean).length;
  const sequential = sockets.slice(0, openedCount).every(Boolean) && sockets.slice(openedCount).every((socket) => !socket);
  const costs = templet ? getEquipSocketCosts(templet, socketIndex) : [];

  let errorCode = NEC_OK;
  if (!req.valid || !equip || !templet) {
    errorCode = NEC_FAIL_INVALID_EQUIP_ITEM;
  } else if (templet.m_bRelic !== true) {
    errorCode = NEC_FAIL_EQUIP_NOT_RELIC;
  } else if (!Number.isInteger(socketIndex) || socketIndex < 0 || socketIndex > 2 || !sequential || socketIndex !== openedCount) {
    errorCode = NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX;
  } else if (Number(equip.enchantLevel || 0) < [2, 5, 7][socketIndex]) {
    errorCode = NEC_FAIL_EQUIP_NOT_ENOUGH_CHCHANT_LEVEL;
  }

  if (errorCode === NEC_OK) {
    for (const cost of costs) {
      const item = getMiscItem(user, cost.itemId);
      const balance = toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0);
      if (balance >= BigInt(cost.count)) continue;
      errorCode = cost.itemId === 1 ? NEC_FAIL_INSUFFICIENT_CREDIT : NEC_FAIL_INSUFFICIENT_ITEM;
      break;
    }
  }

  const result = errorCode === NEC_OK ? openPotentialSocket(user, equip.equipUid, socketIndex) : null;
  return {
    packetId: 1060,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function presetChangeIndexAck(user, req) {
  const current = getEquipPresets(user);
  const changes = Array.isArray(req.changeIndices) ? req.changeIndices : [];
  const from = changes.map((change) => Number(change.from));
  const to = changes.map((change) => Number(change.to));
  const inRange = Boolean(
    req.valid
    && changes.length > 0
    && changes.every((change) => (
      Number.isInteger(change.from)
      && Number.isInteger(change.to)
      && change.from >= 0
      && change.to >= 0
      && change.from < current.length
      && change.to < current.length
      && change.from !== change.to
    ))
  );
  const uniqueFrom = new Set(from);
  const uniqueTo = new Set(to);
  const balanced = uniqueFrom.size === uniqueTo.size && [...uniqueFrom].every((index) => uniqueTo.has(index));
  const unique = uniqueFrom.size === changes.length && uniqueTo.size === changes.length && balanced;
  const errorCode = inRange
    ? (unique ? NEC_OK : NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_DUPLICATE)
    : NEC_FAIL_EQUIP_PRESET_INVALID_INDEX_RANGE;
  const presets = errorCode === NEC_OK ? changeEquipPresetIndices(user, changes) : current;
  return {
    packetId: 1062,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeObjectList(errorCode === NEC_OK ? presets.map((preset) => writeNullableObject(buildEquipPresetData(preset))) : []),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function craftInstantAck(ctx, user, req) {
  const moldId = Number(req && req.moldId || 0);
  const moldCount = Number(req && req.moldCount || 0);
  if (!req.valid || !Number.isInteger(moldId) || moldId <= 0 || !Number.isInteger(moldCount) || moldCount <= 0) {
    return craftInstantFailure(NEC_FAIL_INVALID_REQUEST, moldId, moldCount);
  }
  const moldTemplet = getEquipMoldTemplet(moldId);
  if (moldTemplet && !isEffectiveOpenTag(ctx, user, moldTemplet.m_OpenTag)) {
    return craftInstantFailure(NEC_FAIL_OPENTAG_CLOSED, moldId, moldCount);
  }
  const nowDate = getServerNowDate(ctx);
  if (moldTemplet && moldTemplet.m_DateStrID && !isIntervalActive(moldTemplet.m_DateStrID, nowDate)) {
    return craftInstantFailure(NEC_FAIL_CREAFT_MOLD_DATE_EXPIRED, moldId, moldCount);
  }
  if (moldTemplet && moldCreatesEquipment(moldTemplet)) {
    const capacity = getEquipCraftCapacity(user);
    if (getInventoryUsage(user, INVENTORY_TYPES.EQUIP) + moldCount > capacity) {
      return craftInstantFailure(NEC_FAIL_EQUIP_ITEM_FULL, moldId, moldCount);
    }
  }
  const result = instantCraft(user, moldId, moldCount, {
    regDate: now(ctx),
    nowDate,
    randomInt: ctx && typeof ctx.randomInt === "function" ? ctx.randomInt : undefined,
    isResetGroupActive: (templet) => isResetGroupActive(ctx, user, templet, nowDate),
  });
  const errorCode = Number(result && result.errorCode) || 0;
  return {
    packetId: 1067,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarInt(Number(result && result.moldId || moldId) || 0),
      writeSignedVarInt(Number.isInteger(Number(result && result.moldCount)) ? Number(result.moldCount) : moldCount),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildResetCountData(result && result.resetCount)),
      writeNullableObject(buildRewardData((result && result.reward) || createEmptyReward())),
    ]),
    persist: errorCode === NEC_OK,
    resourceCosts: errorCode === NEC_OK ? result.materialCosts : [],
  };
}

function craftInstantFailure(errorCode, moldId, moldCount) {
  return {
    packetId: 1067,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarInt(Number.isInteger(moldId) ? moldId : 0),
      writeSignedVarInt(Number.isInteger(moldCount) ? moldCount : 0),
      writeObjectList([]),
      writeNullableObject(buildResetCountData()),
      writeNullableObject(buildRewardData(createEmptyReward())),
    ]),
    persist: false,
  };
}

function buildResetGroupCountNotPayload(ctx, user) {
  const nowDate = getServerNowDate(ctx);
  return writeObjectList(getEquipmentResetCounts(user, {
    nowDate,
    isResetGroupActive: (templet) => isResetGroupActive(ctx, user, templet, nowDate),
  }).map((entry) => writeNullableObject(buildResetCountData(entry))));
}

function isResetGroupActive(ctx, user, templet, nowDate) {
  if (!templet || !isEffectiveOpenTag(ctx, user, templet.OpenTag)) return false;
  return !templet.IntervalStrId || isIntervalActive(templet.IntervalStrId, nowDate);
}

function isEffectiveOpenTag(ctx, user, requiredTag) {
  const expected = String(requiredTag || "").trim().toUpperCase();
  if (!expected) return true;
  const own = Array.isArray(user && user.openTags) ? user.openTags : [];
  if (own.some((tag) => String(tag || "").toUpperCase() === expected)) return true;
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return true;
  return (ctx.getEffectiveOpenTags(own) || []).some((tag) => String(tag || "").toUpperCase() === expected);
}

function isIntervalActive(strId, date) {
  const interval = getIntervalTemplet(strId);
  const start = parseGameTableDate(interval && interval.m_DateStart);
  const end = parseGameTableDate(interval && interval.m_DateEnd);
  return Boolean(start && end && date >= start && date < end);
}

function moldCreatesEquipment(moldTemplet) {
  return getMoldRewardRecords(moldTemplet && moldTemplet.m_RewardGroupID)
    .some((record) => String(record && record.m_RewardType || "").toUpperCase() === "RT_EQUIP");
}

function getEquipCraftCapacity(user) {
  const state = user && user.inventoryExpansion && typeof user.inventoryExpansion === "object" ? user.inventoryExpansion : {};
  for (const value of [state[String(INVENTORY_TYPES.EQUIP)], state.equip, user && user.maxEquipCount, user && user.maxItemEquipCount, user && user.m_MaxItemEqipCount]) {
    const capacity = Number(value);
    if (Number.isInteger(capacity) && capacity > 0) return capacity;
  }
  return getInventoryCapacity(user, INVENTORY_TYPES.EQUIP);
}

function getServerNowDate(ctx) {
  const value = ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : null;
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
}

function potentialRollAck(user, req) {
  const target = validatePotentialTarget(user, req);
  if (target.errorCode !== NEC_OK) return potentialRollFailure(target.errorCode);
  const active = activePotentialCandidate(user);
  if (active && (active.equipUid !== String(target.equip.equipUid) || active.socketIndex !== target.socketIndex)) {
    return potentialRollFailure(NEC_FAIL_ANOTHER_EQUIP_IN_PROGRESS);
  }
  const committedCount = Math.max(0, Number(target.equip.potentialOptions[0].precisionChangeCount || 0));
  const pendingCount = Math.max(0, Number(active && active.candidate.accumulateCount || 0));
  if (Math.max(committedCount, pendingCount) >= RELIC_REROLL_LIMIT_COUNT) {
    return potentialRollFailure(NEC_FAIL_EQUIP_POTENTIAL_OPTION_LOGICAL_ERROR);
  }
  const costs = getPotentialRerollCosts(target.templet, target.equip).filter((cost) => cost.itemId > 0 && cost.count > 0);
  for (const cost of costs) {
    if (miscItemBalance(user, cost.itemId) >= BigInt(cost.count)) continue;
    return potentialRollFailure(cost.itemId === 1 ? NEC_FAIL_INSUFFICIENT_CREDIT : NEC_FAIL_INSUFFICIENT_ITEM);
  }
  const result = rollPotentialOption(user, target.equip.equipUid, target.socketIndex);
  return {
    packetId: 1069,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildPotentialOptionCandidateData((result && result.candidate) || {})),
    ]),
    persist: true,
  };
}

function potentialConfirmAck(user, req) {
  const target = validatePotentialTarget(user, req);
  if (target.errorCode !== NEC_OK) return potentialConfirmFailure(target.errorCode);
  const active = activePotentialCandidate(user);
  if (!active || active.equipUid !== String(target.equip.equipUid) || active.socketIndex !== target.socketIndex) {
    return potentialConfirmFailure(NEC_FAIL_EQUIP_POTENTIAL_OPTION_LOGICAL_ERROR);
  }
  const equip = confirmPotentialOption(user, target.equip.equipUid, target.socketIndex);
  return {
    packetId: 1071,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
    persist: true,
  };
}

function potentialCancelAck(user, req) {
  if (!req.valid) return potentialCancelFailure(NEC_FAIL_INVALID_REQUEST);
  const active = activePotentialCandidate(user);
  if (!active) return potentialCancelFailure(NEC_FAIL_EQUIP_POTENTIAL_OPTION_LOGICAL_ERROR);
  const equip = cancelPotentialOption(user);
  return {
    packetId: 1073,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
    persist: true,
  };
}

function validatePotentialTarget(user, req) {
  if (!req.valid) return { errorCode: NEC_FAIL_INVALID_REQUEST };
  const equip = getEquipItem(user, req.equipUid);
  if (!equip) return { errorCode: NEC_FAIL_INVALID_EQUIP_ITEM };
  const templet = getEquipTemplet(equip.itemEquipId);
  if (!templet) return { errorCode: NEC_FAIL_INVALID_EQUIP_ITEM };
  if (templet.m_bRelic !== true) return { errorCode: NEC_FAIL_EQUIP_NOT_RELIC };
  const socketIndex = Number(req.socketIndex);
  if (!Number.isInteger(socketIndex) || socketIndex < 0 || socketIndex > 2) {
    return { errorCode: NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX };
  }
  if (Number(equip.enchantLevel || 0) < 7) return { errorCode: NEC_FAIL_EQUIP_NOT_ENOUGH_CHCHANT_LEVEL };
  const options = Array.isArray(equip.potentialOptions) ? equip.potentialOptions : [];
  if (!options.length || options.some((option) => !option || !Array.isArray(option.sockets) || option.sockets.length !== 3 || option.sockets.some((socket) => !socket))) {
    return { errorCode: NEC_FAIL_EQUIP_INVALID_SOCKET_INDEX };
  }
  const groupIds = [Number(templet.m_PotentialOptionGroupID || 0), Number(templet.m_SubPotentialOptionGroupID || 0)];
  for (let index = 0; index < options.length; index += 1) {
    const record = getEquipPotentialOptionRecords(groupIds[index]).find((entry) => Number(entry.OptionKey) === Number(options[index].optionKey));
    if (!record) return { errorCode: NEC_FAIL_EQUIP_INVALID_POTENTIAL_OPTION_KEY };
    const weightId = Number(record.PrecisionWeightId || record.FirstPrecisionWeightId || 0);
    if (!getEquipPrecisionWeightRecords(weightId).some((entry) => Number(entry.Weight || 0) > 0)) {
      return { errorCode: NEC_FAIL_EQUIP_INVALID_WEIGHT_ID };
    }
  }
  return { errorCode: NEC_OK, equip, templet, socketIndex };
}

function activePotentialCandidate(user) {
  for (const equip of getEquipItems(user)) {
    const candidate = equip && equip.potentialCandidate;
    if (!candidate || toBigInt(candidate.equipUid || 0) <= 0n) continue;
    return {
      equipUid: String(toBigInt(candidate.equipUid)),
      socketIndex: Number(candidate.socketIndex),
      candidate,
    };
  }
  return null;
}

function potentialRollFailure(errorCode) {
  return {
    packetId: 1069,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeObjectList([]),
      writeNullableObject(buildPotentialOptionCandidateData()),
    ]),
    persist: false,
  };
}

function potentialConfirmFailure(errorCode) {
  return { packetId: 1071, payload: Buffer.concat([writeSignedVarInt(errorCode), writeNullObject()]), persist: false };
}

function potentialCancelFailure(errorCode) {
  return { packetId: 1073, payload: Buffer.concat([writeSignedVarInt(errorCode), writeNullObject()]), persist: false };
}

function presetClearAck(user, req) {
  const current = getEquipPresets(user);
  const indices = Array.isArray(req.presetIndices) ? req.presetIndices.map(Number) : [];
  const unique = new Set(indices);
  const valid = Boolean(
    req.valid
    && indices.length > 0
    && unique.size === indices.length
    && indices.every((index) => Number.isInteger(index) && index >= 0 && index < current.length)
  );
  const changed = valid && indices.some((index) => {
    const preset = current[index];
    return Boolean(
      preset
      && (preset.presetName || Number(preset.presetType) !== 1 || preset.equipUids.some((uid) => toBigInt(uid || 0) > 0n))
    );
  });
  const presets = changed ? clearEquipPresets(user, indices) : current;
  return {
    packetId: 1075,
    payload: Buffer.concat([
      writeSignedVarInt(valid ? NEC_OK : NEC_FAIL_EQUIP_PRESET_INVALID_PRESET_INDEX),
      writeObjectList(valid ? presets.map((preset) => writeNullableObject(buildEquipPresetData(preset))) : []),
    ]),
    persist: Boolean(changed),
  };
}

function multipleEnchantAck(user, req) {
  const definitions = getEquipEnchantMaterials();
  const requested = req.valid && Array.isArray(req.equipItemUIDList) ? req.equipItemUIDList.map((uid) => toBigInt(uid || 0)) : [];
  const keys = requested.map(String);
  const entries = Array.isArray(req.equipMiscCostEntries) ? req.equipMiscCostEntries : [];
  const entryKeys = entries.map((entry) => String(toBigInt(entry.equipUid || 0)));
  const targetLevel = Number(req.enchantLevel);
  const validTargetLevel = [2, 5, 7, 10].includes(targetLevel);
  const plans = [];
  const totalCosts = new Map();
  const addCost = (itemId, count) => {
    const numericId = Number(itemId || 0);
    const numericCount = Math.max(0, Math.trunc(Number(count || 0)));
    if (numericId > 0 && numericCount > 0) totalCosts.set(numericId, (totalCosts.get(numericId) || 0n) + BigInt(numericCount));
  };

  let errorCode = NEC_OK;
  if (!req.valid || requested.length === 0 || requested.some((uid) => uid <= 0n) || new Set(keys).size !== keys.length) {
    errorCode = NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP;
  } else if (requested.length > 10) {
    errorCode = NEC_FAIL_EQUIP_MULTIPLE_COUNT_MAX;
  } else if (!validTargetLevel || entries.length !== requested.length || new Set(entryKeys).size !== entryKeys.length || entryKeys.some((key) => !keys.includes(key))) {
    errorCode = NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP;
  }

  if (errorCode === NEC_OK) {
    for (const equipUid of requested) {
      const equip = getEquipItem(user, equipUid);
      const templet = equip ? getEquipTemplet(equip.itemEquipId) : null;
      const entry = entries.find((candidate) => String(toBigInt(candidate.equipUid || 0)) === String(equipUid));
      const materials = entry && Array.isArray(entry.materials) ? entry.materials : [];
      const validMaterials = materials.length === definitions.length && materials.every((material, index) => (
        material
        && material.itemId === Number(definitions[index].itemId)
        && Number.isInteger(material.count)
        && material.count >= 0
      ));
      const maxLevel = templet
        ? Math.min(Number(templet.m_MaxEnchantLevel || 10) || 10, getMaxEquipEnchantLevel(templet.m_NKM_ITEM_TIER) || 10, 10)
        : 0;
      const desiredLevel = Math.min(targetLevel, maxLevel);
      const addedExp = validMaterials
        ? materials.reduce((total, material, index) => total + material.count * Number(definitions[index].exp || 0), 0)
        : 0;
      const expected = equip && templet ? calculateEquipEnchantProgress(equip, templet, addedExp) : null;
      const owner = getArmyUnits(user).find((unit) => (
        Array.isArray(unit.equipItemUids)
        && unit.equipItemUids.some((uid) => String(toBigInt(uid || 0)) === String(equipUid))
      ));
      const deckError = owner ? unitEquipDeckError(user, owner.unitUid) : NEC_OK;
      if (!equip || !templet || !validMaterials || addedExp <= 0 || !expected || expected.level < desiredLevel) {
        errorCode = NEC_FAIL_EQUIP_MULTIPLE_NOT_VALID_EQUIP;
        break;
      }
      if (Number(equip.enchantLevel || 0) >= desiredLevel) {
        errorCode = NEC_FAIL_EQUIP_LEVEL_ALREADY_ENOUGH;
        break;
      }
      if (deckError !== NEC_OK) {
        errorCode = deckError;
        break;
      }
      for (const material of materials) addCost(material.itemId, material.count);
      addCost(1, addedExp * 8);
      const socketIndices = [];
      if (req.openEquipSocket && templet.m_bRelic === true) {
        const currentSockets = (((equip.potentialOptions || [])[0] || {}).sockets || []).filter(Boolean).length;
        const eligibleSockets = expected.level >= 7 ? 3 : expected.level >= 5 ? 2 : expected.level >= 2 ? 1 : 0;
        for (let index = currentSockets; index < eligibleSockets; index += 1) {
          socketIndices.push(index);
          for (const cost of getEquipSocketCosts(templet, index)) addCost(cost.itemId, cost.count);
        }
      }
      plans.push({ equip, materials, expected, socketIndices });
    }
  }

  if (errorCode === NEC_OK) {
    for (const [itemId, count] of totalCosts) {
      const item = getMiscItem(user, itemId);
      const balance = toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0);
      if (balance >= count) continue;
      errorCode = itemId === 1 ? NEC_FAIL_INSUFFICIENT_CREDIT : NEC_FAIL_INSUFFICIENT_ITEM;
      break;
    }
  }

  const updated = [];
  const opened = [];
  if (errorCode === NEC_OK) {
    for (const plan of plans) {
      const result = enchantEquipItem(user, plan.equip.equipUid, [], { miscItems: plan.materials });
      let equip = result && result.equip;
      for (const socketIndex of plan.socketIndices) {
        const openResult = openPotentialSocket(user, plan.equip.equipUid, socketIndex);
        if (openResult && openResult.equip) equip = openResult.equip;
      }
      if (plan.socketIndices.length) opened.push(plan.equip.equipUid);
      if (equip) updated.push(equip);
    }
  }
  const costItems = errorCode === NEC_OK
    ? Array.from(totalCosts.keys(), (itemId) => getMiscItem(user, itemId)).filter(Boolean)
    : [];
  return {
    packetId: 1077,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeObjectList(updated.map((equip) => writeNullableObject(buildEquipItemData(equip)))),
      writeObjectList(costItems.map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeLongArray(opened),
    ]),
    persist: errorCode === NEC_OK,
  };
}

function calculateEquipEnchantProgress(equip, templet, addedExp) {
  const tier = Number(templet.m_NKM_ITEM_TIER || 1);
  const grade = templet.m_NKM_ITEM_GRADE || "NIG_N";
  const maxLevel = Math.min(Number(templet.m_MaxEnchantLevel || 10) || 10, getMaxEquipEnchantLevel(tier) || 10, 10);
  let level = Math.max(0, Number(equip.enchantLevel || 0) || 0);
  let exp = Math.max(0, Number(equip.enchantExp || 0) || 0) + Math.max(0, Math.trunc(Number(addedExp) || 0));
  while (level < maxLevel) {
    const required = getEquipEnchantRequiredExp(tier, level, grade);
    if (!Number.isFinite(required) || required <= 0 || exp < required) break;
    exp -= required;
    level += 1;
  }
  if (level >= maxLevel) exp = 0;
  return { level, exp };
}

function getEquipSocketCosts(templet, socketIndex) {
  const number = Number(socketIndex) + 1;
  return [
    { itemId: 1, count: Number(templet && templet[`Socket${number}_ReqResource`] || 0) },
    { itemId: Number(templet && templet[`Socket${number}_OpenItemID`] || 0), count: Number(templet && templet[`Socket${number}_OpenCount`] || 0) },
  ].filter((cost) => cost.itemId > 0 && cost.count > 0);
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
      case 1000: {
        const isEquip = reader.bool();
        const unitUID = reader.long();
        const equipItemUID = reader.long();
        const equipPosition = reader.int();
        return { isEquip, unitUID, equipItemUID, equipPosition, valid: reader.done() };
      }
      case 1002: {
        const equipItemUID = reader.long();
        const consumeEquipItemUIDList = reader.longList();
        return { equipItemUID, consumeEquipItemUIDList, valid: reader.done() };
      }
      case 1004: {
        const equipItemUID = reader.long();
        const isLock = reader.bool();
        return { equipItemUID, isLock, valid: reader.done() };
      }
      case 1006: {
        const removeEquipItemUIDList = reader.longList();
        return { removeEquipItemUIDList, valid: reader.done() };
      }
      case 1008: {
        const itemID = reader.int();
        const count = reader.int();
        const request = { itemID, count, valid: reader.done() };
        request.valid = request.valid && Buffer.concat([writeSignedVarInt(itemID), writeSignedVarInt(count)]).equals(payload);
        return request;
      }
      case 1010:
        return { valid: reader.done() };
      case 1012: {
        const index = reader.byte();
        const moldID = reader.int();
        const count = reader.int();
        const request = { index, moldID, count, valid: reader.done() };
        request.valid = request.valid && Buffer.concat([
          writeByte(index),
          writeSignedVarInt(moldID),
          writeSignedVarInt(count),
        ]).equals(payload);
        return request;
      }
      case 1014:
      case 1016: {
        const index = reader.byte();
        return { index, valid: reader.done() };
      }
      case 1018:
      case 1020:
      case 1022: {
        const equipUID = reader.long();
        const equipOptionID = reader.int();
        const request = { equipUID, equipOptionID, valid: reader.done() };
        request.valid = request.valid && Buffer.concat([writeSignedVarLong(equipUID), writeSignedVarInt(equipOptionID)]).equals(payload);
        return request;
      }
      case 1024: {
        const equipUid = reader.long();
        const equipOptionId = reader.int();
        const statType = reader.int();
        const request = { equipUid, equipOptionId, statType, valid: reader.done() };
        request.valid = request.valid && Buffer.concat([
          writeSignedVarLong(equipUid),
          writeSignedVarInt(equipOptionId),
          writeSignedVarInt(statType),
        ]).equals(payload);
        return request;
      }
      case 1026: {
        const itemId = reader.int();
        const rewardId = reader.int();
        const count = reader.int();
        const setOptionId = reader.int();
        const subSkillId = reader.int();
        const statTypes = reader.intList();
        const potentialOptionId = reader.int();
        const potentialOption2Id = reader.int();
        const request = { itemId, rewardId, count, setOptionId, subSkillId, statTypes, potentialOptionId, potentialOption2Id, valid: reader.done() };
        const canonical = Buffer.concat([
          writeSignedVarInt(itemId),
          writeSignedVarInt(rewardId),
          writeSignedVarInt(count),
          writeSignedVarInt(setOptionId),
          writeSignedVarInt(subSkillId),
          writeIntList(statTypes),
          writeSignedVarInt(potentialOptionId),
          writeSignedVarInt(potentialOption2Id),
        ]);
        request.valid = request.valid && canonical.equals(payload);
        return request;
      }
      case 1028:
      case 1030:
      case 1034: {
        const equipUID = reader.long();
        const request = { equipUID, valid: reader.done() };
        request.valid = request.valid && writeSignedVarLong(equipUID).equals(payload);
        return request;
      }
      case 1032: {
        const equipUid = reader.long();
        const setOptionId = reader.int();
        const request = { equipUid, setOptionId, valid: reader.done() };
        request.valid = request.valid && Buffer.concat([writeSignedVarLong(equipUid), writeSignedVarInt(setOptionId)]).equals(payload);
        return request;
      }
      case 1036:
        return { equipUID: reader.long(), unitUid: toBigInt(payload.length ? 0 : 0) };
      case 1040: {
        const addPresetCount = reader.int();
        return { addPresetCount, valid: reader.done() };
      }
      case 1042: {
        const presetIndex = reader.int();
        const newPresetName = reader.string();
        return { presetIndex, newPresetName, valid: reader.done() };
      }
      case 1044: {
        const unitUid = reader.long();
        const presetIndex = reader.int();
        return { unitUid, presetIndex, valid: reader.done() };
      }
      case 1046: {
        const presetIndex = reader.int();
        const equipPosition = reader.int();
        const equipUid = reader.long();
        return { presetIndex, equipPosition, equipUid, valid: reader.done() };
      }
      case 1048: {
        const presetIndex = reader.int();
        const applyUnitUid = reader.long();
        return { presetIndex, applyUnitUid, valid: reader.done() };
      }
      case 1052:
        return { valid: reader.done() && payload.length === 0 };
      case 1055:
        return { equipUid: reader.long(), unitId: reader.int() };
      case 1057: {
        const equipUid = reader.long();
        const consumeEquipItemUidList = reader.longList();
        return { equipUid, consumeEquipItemUidList, valid: reader.done() };
      }
      case 1059: {
        const equipUid = reader.long();
        const socketIndex = reader.int();
        return { equipUid, socketIndex, valid: reader.done() };
      }
      case 1061: {
        const changeIndices = reader.presetIndexChanges();
        return { changeIndices, valid: reader.done() };
      }
      case 1063: {
        const equipItemUID = reader.long();
        const miscItemList = reader.miscItemListExact();
        return { equipItemUID, miscItemList, valid: reader.done() };
      }
      case 1066: {
        const moldId = reader.int();
        const moldCount = reader.int();
        return { moldId, moldCount, valid: reader.done() };
      }
      case 1068:
      case 1070: {
        const equipUid = reader.long();
        const socketIndex = reader.int();
        return { equipUid, socketIndex, valid: reader.done() };
      }
      case 1072:
        return { valid: reader.done() && payload.length === 0 };
      case 1074: {
        const presetIndices = reader.intList();
        return { presetIndices, valid: reader.done() };
      }
      case 1076:
        {
          const equipItemUIDList = reader.longList();
          const equipMiscCostEntries = reader.equipMiscCostEntriesExact();
          const enchantLevel = reader.short();
          const openEquipSocket = reader.bool();
          return { equipItemUIDList, equipMiscCostEntries, enchantLevel, openEquipSocket, valid: reader.done() };
        }
      default:
        return {};
    }
  } catch (err) {
    console.log(`[equipment:${packetId}] request decode failed: ${err.message}`);
    if (packetId === 1000) return { isEquip: false, unitUID: 0n, equipItemUID: 0n, equipPosition: 0, valid: false };
    if (packetId === 1002) return { equipItemUID: 0n, consumeEquipItemUIDList: [], valid: false };
    if (packetId === 1004) return { equipItemUID: 0n, isLock: false, valid: false };
    if (packetId === 1018 || packetId === 1020 || packetId === 1022) return { equipUID: 0n, equipOptionID: 0, valid: false };
    if (packetId === 1024) return { equipUid: 0n, equipOptionId: 0, statType: 0, valid: false };
    if (packetId === 1028 || packetId === 1030 || packetId === 1034) return { equipUID: 0n, valid: false };
    if (packetId === 1032) return { equipUid: 0n, setOptionId: 0, valid: false };
    if (packetId === 1014 || packetId === 1016) return { index: 0, valid: false };
    if (packetId === 1040) return { addPresetCount: 0, valid: false };
    if (packetId === 1042) return { presetIndex: 0, newPresetName: "", valid: false };
    if (packetId === 1044) return { unitUid: 0n, presetIndex: 0, valid: false };
    if (packetId === 1046) return { presetIndex: 0, equipPosition: 0, equipUid: 0n, valid: false };
    if (packetId === 1048) return { presetIndex: 0, applyUnitUid: 0n, valid: false };
    if (packetId === 1052) return { valid: false };
    if (packetId === 1057) return { equipUid: 0n, consumeEquipItemUidList: [], valid: false };
    if (packetId === 1059) return { equipUid: 0n, socketIndex: 0, valid: false };
    if (packetId === 1063) return { equipItemUID: 0n, miscItemList: [], valid: false };
    if (packetId === 1066) return { moldId: 0, moldCount: 0, valid: false };
    if (packetId === 1068 || packetId === 1070) return { equipUid: 0n, socketIndex: 0, valid: false };
    if (packetId === 1072) return { valid: false };
    if (packetId === 1061) return { changeIndices: [], valid: false };
    if (packetId === 1074) return { presetIndices: [], valid: false };
    if (packetId === 1076) return { equipItemUIDList: [], equipMiscCostEntries: [], enchantLevel: 0, openEquipSocket: false, valid: false };
    return {};
  }
}

function createReader(payload) {
  let offset = 0;
  return {
    bool() {
      if (offset >= payload.length || (payload[offset] !== 0 && payload[offset] !== 1)) throw new Error("noncanonical bool");
      const read = readBool(payload, offset);
      offset = read.offset;
      return read.value;
    },
    byte() {
      const read = readByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    short() {
      return this.int();
    },
    int() {
      const start = offset;
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      if (!payload.subarray(start, offset).equals(writeSignedVarInt(read.value))) throw new Error("noncanonical varint");
      return read.value;
    },
    long() {
      const start = offset;
      const read = readSignedVarLong(payload, offset);
      offset = read.offset;
      if (!payload.subarray(start, offset).equals(writeSignedVarLong(read.value))) throw new Error("noncanonical varlong");
      return read.value;
    },
    string() {
      const length = readSignedVarInt(payload, offset);
      offset = length.offset;
      if (length.value < 0) return "";
      const end = offset + length.value;
      if (end > payload.length) throw new Error("truncated string");
      const value = payload.subarray(offset, end).toString("utf8");
      offset = end;
      return value;
    },
    intList() {
      const read = readSignedVarIntList(payload, offset);
      offset = read.offset;
      return read.value;
    },
    longList() {
      const read = readSignedVarLongList(payload, offset);
      offset = read.offset;
      return read.value;
    },
    unsignedCount() {
      const start = offset;
      let result = 0;
      let shift = 0;
      while (shift < 32) {
        if (offset >= payload.length) throw new Error("truncated varint");
        const byte = payload.readUInt8(offset++);
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
          const value = result >>> 0;
          if (!payload.subarray(start, offset).equals(writeUnsignedVarInt(value))) throw new Error("noncanonical unsigned varint");
          return value;
        }
        shift += 7;
      }
      throw new Error("varint too long");
    },
    nullableMarker() {
      if (offset >= payload.length || (payload[offset] !== 0 && payload[offset] !== 1)) throw new Error("noncanonical nullable marker");
      return payload.readUInt8(offset++) !== 0;
    },
    miscItemList() {
      const count = this.unsignedCount();
      const items = [];
      for (let index = 0; index < count; index += 1) {
        if (!this.nullableMarker()) continue;
        items.push({ itemId: this.int(), count: this.int() });
      }
      return items;
    },
    miscItemListExact() {
      const count = this.unsignedCount();
      const items = [];
      for (let index = 0; index < count; index += 1) {
        if (!this.nullableMarker()) {
          items.push(null);
          continue;
        }
        items.push({ itemId: this.int(), count: this.int() });
      }
      return items;
    },
    equipMiscCostEntriesExact() {
      const count = this.unsignedCount();
      const entries = [];
      for (let index = 0; index < count; index += 1) {
        const equipUid = this.long();
        const materials = this.nullableMarker() ? this.miscItemListExact() : null;
        entries.push({ equipUid, materials });
      }
      return entries;
    },
    presetIndexChanges() {
      const count = this.unsignedCount();
      const changes = [];
      for (let index = 0; index < count; index += 1) {
        if (!this.bool()) continue; // nullable object marker
        changes.push({ from: this.int(), to: this.int() });
      }
      return changes;
    },
    done() {
      return offset === payload.length;
    },
  };
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

function now(ctx) {
  return ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
}

module.exports = {
  buildEquipPresetNotPayload,
  createEquipmentPipelineHandlers,
  buildResetGroupCountNotPayload,
  parseChoiceEquipOptions,
  presetListAck,
  validateChoiceSelector,
};
