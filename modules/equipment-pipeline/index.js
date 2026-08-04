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
  readString,
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
  startCraft,
  completeCraft,
  instantCraft,
  instantCompleteCraft,
  unlockCraftSlot,
  getEquipItems,
  getEquipPresets,
  addEquipPresets,
  setEquipPresetName,
  registerEquipPreset,
  registerEquipPresetFromUnit,
  applyEquipPreset,
  clearEquipPresets,
  changeEquipPresetIndices,
} = require("../equipment");
const { grantMiscItem, spendMiscItem } = require("../inventory");
const { grantRewardByType, createEmptyReward, grantChoiceItemReward } = require("../reward");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");

const EQUIP_PACKET_IDS = [
  1000, 1002, 1004, 1006, 1008, 1010, 1012, 1014, 1016, 1018,
  1020, 1022, 1024, 1026, 1028, 1030, 1032, 1034, 1036, 1040,
  1042, 1044, 1046, 1048, 1052, 1055, 1057, 1059, 1061, 1063,
  1066, 1068, 1070, 1072, 1074, 1076,
];
const NEC_OK = 0;
const NEC_DB_FAIL_EQUIP_ITEM_DATA = 6;
const NEC_FAIL_UNIT_NOT_EXIST = 136;

function createEquipmentPipelineHandlers() {
  return EQUIP_PACKET_IDS.map((packetId) => ({
    packetId,
    name: `EQUIPMENT_PIPELINE_${packetId}`,
    handle(ctx, socket, packet) {
      const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
      if (socket.session) socket.session.user = user;
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildResponse(ctx, user, packetId, request);
      const missionTracking = trackEquipmentMission(ctx, user, packetId, request);
      console.log(`[equipment:${packetId}] ACK packetId=${response.packetId} payloadSize=${response.payload.length}`);
      for (const preResponse of response.preResponses || []) {
        ctx.sendResponse(socket, packet.sequence, preResponse.packetId, () =>
          ctx.buildEncryptedPacket(packet.sequence, preResponse.packetId, preResponse.payload)
        );
      }
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      if (socket.session && socket.session.gameReplay && ctx.capturedGameFlow && typeof ctx.skipCapturedGameThroughPacketId === "function") {
        ctx.skipCapturedGameThroughPacketId(socket, response.packetId);
      }
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "equipment-mission-update" });
      if (ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
      return true;
    },
  }));
}

function trackEquipmentMission(ctx, user, packetId, request = {}) {
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
      return craftUnlockAck(ctx, user);
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
      return tuningCancelAck(user);
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
      return potentialCancelAck(user);
    case 1074:
      return presetClearAck(user, req);
    case 1076:
      return multipleEnchantAck(user, req);
    default:
      return { packetId: packetId + 1, payload: writeSignedVarInt(0) };
  }
}

function equipItemAck(user, req) {
  const isUnequip = req.isEquip === false;
  const result = isUnequip
    ? unequipItem(user, req.equipItemUID)
    : equipItemToUnit(user, req.unitUID, req.equipItemUID, req.equipPosition);
  if (isUnequip && !result.equip) {
    console.warn(
      `[equipment:1000] unequip rejected error=${NEC_DB_FAIL_EQUIP_ITEM_DATA} unitUID=${String(req.unitUID || 0)} equipItemUID=${String(req.equipItemUID || 0)} position=${Number(req.equipPosition || 0)}`
    );
    return buildEquipItemEquipAckPayload(NEC_DB_FAIL_EQUIP_ITEM_DATA, req.unitUID, 0, req.equipItemUID, req.equipPosition);
  }
  if (isUnequip && !result.unit) {
    if (result.detachedOwnerCleared) {
      console.warn(
        `[equipment:1000] cleared detached equip owner equipItemUID=${String(req.equipItemUID || 0)} requestedUnitUID=${String(req.unitUID || 0)} position=${Number(result.position != null ? result.position : req.equipPosition || 0)}`
      );
    }
    return buildEquipItemEquipAckPayload(NEC_OK, req.unitUID || 0, 0, 0, result.position != null ? result.position : req.equipPosition || 0);
  }
  if (!isUnequip && (!result.equip || !result.unit)) {
    const errorCode = result.equip ? NEC_FAIL_UNIT_NOT_EXIST : NEC_DB_FAIL_EQUIP_ITEM_DATA;
    console.warn(
      `[equipment:1000] equip rejected error=${errorCode} unitUID=${String(req.unitUID || 0)} equipItemUID=${String(req.equipItemUID || 0)} position=${Number(req.equipPosition || 0)}`
    );
    return buildEquipItemEquipAckPayload(errorCode, req.unitUID, req.equipItemUID, 0, req.equipPosition);
  }
  const equipItemUID = isUnequip ? 0 : req.equipItemUID || (result.equip && result.equip.equipUid) || 0;
  const unequipItemUID = isUnequip
    ? result.unequipItemUID || req.equipItemUID || 0
    : result.unequipItemUID || 0;
  const responseUnitUid = isUnequip
    ? (result.unit && result.unit.unitUid) || req.unitUID || 0
    : (result.unit && result.unit.unitUid) || req.unitUID || 0;
  const response = buildEquipItemEquipAckPayload(NEC_OK, responseUnitUid, equipItemUID, unequipItemUID, result.position != null ? result.position : req.equipPosition || 0);
  const previousOwnerUnitUid = result.previousOwnerUnit && result.previousOwnerUnit.unitUid;
  const previousOwnerPosition = Number(result.previousOwnerPosition);
  const targetPosition = Number(result.position != null ? result.position : req.equipPosition || 0) || 0;
  const movedFromAnotherSlot = !isUnequip
    && previousOwnerUnitUid
    && toBigInt(previousOwnerUnitUid) > 0n
    && (String(toBigInt(previousOwnerUnitUid)) !== String(toBigInt(responseUnitUid)) || previousOwnerPosition !== targetPosition);
  if (movedFromAnotherSlot) {
    response.preResponses = [
      buildEquipItemEquipAckPayload(NEC_OK, previousOwnerUnitUid, 0, equipItemUID, previousOwnerPosition),
    ];
  }
  return response;
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

function lockAck(user, req) {
  const equip = lockEquipItem(user, req.equipItemUID, req.isLock);
  return {
    packetId: 1005,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipItemUID || 0)),
      writeBool(Boolean(equip && equip.locked)),
    ]),
  };
}

function removeAck(user, req) {
  const removed = removeEquipItems(user, req.removeEquipItemUIDList || []);
  const rewardItems = removed.length ? [grantMiscItem(user, 1, BigInt(removed.length * 1000), 0n)] : [];
  return {
    packetId: 1007,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeLongArray(removed),
      writeObjectList(rewardItems.filter(Boolean).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
  };
}

function randomBoxAck(ctx, user, req) {
  const itemId = Number(req.itemID || req.itemId || 0);
  const count = Math.max(1, Number(req.count || 1));
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, count, { regDate: now(ctx) }) : null;
  const reward = grantRewardByType(ctx, user, "RT_MISC", itemId, count, count, 0, {
    expandPackages: true,
    regDate: now(ctx),
  });
  return {
    packetId: 1009,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildRewardData(reward)),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
    ]),
  };
}

function craftUnlockAck(ctx, user) {
  const result = unlockCraftSlot(user, { regDate: now(ctx) });
  return {
    packetId: 1011,
    payload: Buffer.concat([
      writeSignedVarInt(Number(result && result.errorCode) || 0),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
  };
}

function craftStartAck(ctx, user, req) {
  const result = startCraft(user, req.index, req.moldID, req.count, { regDate: now(ctx) });
  return {
    packetId: 1013,
    payload: Buffer.concat([
      writeSignedVarInt(Number(result && result.errorCode) || 0),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildResetCountData(result && result.resetCount)),
    ]),
  };
}

function craftCompleteAck(ctx, user, req) {
  const result = completeCraft(user, req.index, { regDate: now(ctx) });
  return {
    packetId: 1015,
    payload: Buffer.concat([
      writeSignedVarInt(Number(result && result.errorCode) || 0),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeNullableObject(buildRewardData((result && result.reward) || createEmptyReward())),
    ]),
  };
}

function craftInstantCompleteAck(ctx, user, req) {
  const result = instantCompleteCraft(user, req.index, { regDate: now(ctx) });
  return {
    packetId: 1017,
    payload: Buffer.concat([
      writeSignedVarInt(Number(result && result.errorCode) || 0),
      writeNullableObjectOrNull(result && result.slot ? buildCraftSlotData(result.slot) : null),
      writeNullableObjectOrNull(result && result.extraCostItem ? buildItemMiscData(result.extraCostItem) : null),
      writeNullableObject(buildRewardData((result && result.reward) || createEmptyReward())),
    ]),
  };
}

function refineAck(user, req) {
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
  };
}

function statRollAck(user, req) {
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
  };
}

function statConfirmAck(user, req) {
  const result = confirmEquipSubstat(user, req.equipUID, req.equipOptionID);
  return {
    packetId: 1023,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
    ]),
  };
}

function statBonusConfirmAck(user, req) {
  const rolled = rollEquipSubstat(user, req.equipUid, req.equipOptionId, req.statType);
  const result = confirmEquipSubstat(user, req.equipUid, req.equipOptionId);
  return {
    packetId: 1025,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : rolled && rolled.equip ? buildEquipItemData(rolled.equip) : null),
      writeNullableObject(buildResetCountData(rolled && rolled.resetCount)),
    ]),
  };
}

function choiceItemAck(ctx, user, req) {
  const itemId = Number(req.itemId || 0);
  const rewardId = Number(req.rewardId || 0);
  const count = Math.max(1, Number(req.count || 1));
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, count, { regDate: now(ctx) }) : null;
  const reward = grantChoiceItemReward(ctx, user, itemId, rewardId, count, {
    expandPackages: true,
    regDate: now(ctx),
    rewardId,
    setOptionId: Number(req.setOptionId || 0),
    subSkillId: Number(req.subSkillId || 0),
  });
  return {
    packetId: 1027,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
      writeNullableObject(buildRewardData(reward)),
    ]),
  };
}

function setOptionRollAck(user, req) {
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
  };
}

function setOptionConfirmAck(user, req) {
  const result = confirmSetOption(user, req.equipUID);
  return {
    packetId: 1031,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeNullableObject(buildEquipTuningCandidateData((result && result.candidate) || {})),
    ]),
  };
}

function setOptionBonusConfirmAck(user, req) {
  const rolled = rollSetOption(user, req.equipUid, req.setOptionId);
  const result = confirmSetOption(user, req.equipUid, req.setOptionId);
  return {
    packetId: 1033,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUid || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
      writeNullableObject(buildResetCountData((rolled && rolled.resetCount) || (result && result.resetCount))),
    ]),
  };
}

function firstSetOptionAck(user, req) {
  const rolled = rollSetOption(user, req.equipUID, null, { free: true, skipResetCount: true });
  const result = confirmSetOption(user, req.equipUID, rolled && rolled.setOptionId);
  return {
    packetId: 1035,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(req.equipUID || 0)),
      writeSignedVarInt(Number(result && result.setOptionId) || 0),
    ]),
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

function presetAddAck(user, req) {
  const count = addEquipPresets(user, req.addPresetCount);
  return {
    packetId: 1041,
    payload: Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(count), writeObjectList([])]),
  };
}

function presetNameAck(user, req) {
  setEquipPresetName(user, req.presetIndex, req.newPresetName);
  return {
    packetId: 1043,
    payload: Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(Number(req.presetIndex || 0) || 0), writeString(req.newPresetName || "")]),
  };
}

function presetRegisterAllAck(user, req) {
  const preset = registerEquipPresetFromUnit(user, req.unitUid, req.presetIndex);
  return {
    packetId: 1045,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipPresetData(preset))]),
  };
}

function presetRegisterAck(user, req) {
  const preset = registerEquipPreset(user, req.presetIndex, req.equipPosition, req.equipUid);
  return {
    packetId: 1047,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipPresetData(preset))]),
  };
}

function presetApplyAck(user, req) {
  const update = applyEquipPreset(user, req.presetIndex, req.applyUnitUid);
  const updates = Array.isArray(update.updates) && update.updates.length ? update.updates : [update];
  return {
    packetId: 1049,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarInt(Number(req.presetIndex || 0) || 0),
      writeObjectList(updates.map((entry) => writeNullableObject(Buffer.concat([
        writeSignedVarLong(toBigInt(entry.unitUid || 0)),
        writeLongArray(entry.equipUids || []),
      ])))),
    ]),
  };
}

function tuningCancelAck(user) {
  const candidate = cancelEquipTuning(user);
  return {
    packetId: 1053,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildEquipTuningCandidateData(candidate))]),
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
  const result = upgradeEquipItem(user, req.equipUid, req.consumeEquipItemUidList || []);
  return {
    packetId: 1058,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeLongArray(result ? result.consumed : []),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
  };
}

function openSocketAck(user, req) {
  const result = openPotentialSocket(user, req.equipUid, req.socketIndex);
  return {
    packetId: 1060,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(result && result.equip ? buildEquipItemData(result.equip) : null),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
    ]),
  };
}

function presetChangeIndexAck(user, req) {
  const presets = changeEquipPresetIndices(user, req.changeIndices || []);
  return {
    packetId: 1062,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(presets.map((preset) => writeNullableObject(buildEquipPresetData(preset)))),
    ]),
  };
}

function craftInstantAck(ctx, user, req) {
  const result = instantCraft(user, req.moldId, req.moldCount, { regDate: now(ctx) });
  return {
    packetId: 1067,
    payload: Buffer.concat([
      writeSignedVarInt(Number(result && result.errorCode) || 0),
      writeSignedVarInt(Number((result && result.moldId) || req.moldId || 0) || 0),
      writeSignedVarInt(Number((result && result.moldCount) || req.moldCount || 1) || 1),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildResetCountData(result && result.resetCount)),
      writeNullableObject(buildRewardData((result && result.reward) || createEmptyReward())),
    ]),
  };
}

function potentialRollAck(user, req) {
  const result = rollPotentialOption(user, req.equipUid, req.socketIndex);
  return {
    packetId: 1069,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList((result && result.costItems || []).map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeNullableObject(buildPotentialOptionCandidateData((result && result.candidate) || {})),
    ]),
  };
}

function potentialConfirmAck(user, req) {
  const equip = confirmPotentialOption(user, req.equipUid, req.socketIndex);
  return {
    packetId: 1071,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
  };
}

function potentialCancelAck(user) {
  const equip = getEquipItems(user).find((item) => item.potentialCandidate) || null;
  if (equip) equip.potentialCandidate = null;
  return {
    packetId: 1073,
    payload: Buffer.concat([writeSignedVarInt(0), writeNullableObjectOrNull(equip ? buildEquipItemData(equip) : null)]),
  };
}

function presetClearAck(user, req) {
  const presets = clearEquipPresets(user, req.presetIndices || []);
  return {
    packetId: 1075,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(presets.map((preset) => writeNullableObject(buildEquipPresetData(preset)))),
    ]),
  };
}

function multipleEnchantAck(user, req) {
  const updated = [];
  const opened = [];
  const costItems = [];
  for (const equipUid of req.equipItemUIDList || []) {
    const result = enchantEquipItem(user, equipUid, [], {
      miscItems: (req.equipMiscCostList && req.equipMiscCostList[String(toBigInt(equipUid))]) || [],
      targetLevel: req.enchantLevel,
    });
    if (result && result.equip) {
      updated.push(result.equip);
      if (Array.isArray(result.costItems)) costItems.push(...result.costItems);
      if (req.openEquipSocket) {
        const openResult = openPotentialSocket(user, result.equip.equipUid, 0);
        if (openResult && openResult.equip) updated[updated.length - 1] = openResult.equip;
        if (openResult && Array.isArray(openResult.costItems)) costItems.push(...openResult.costItems);
        opened.push(result.equip.equipUid);
      }
    }
  }
  return {
    packetId: 1077,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(updated.map((equip) => writeNullableObject(buildEquipItemData(equip)))),
      writeObjectList(costItems.map((item) => writeNullableObject(buildItemMiscData(item)))),
      writeLongArray(opened),
    ]),
  };
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
      case 1000:
        return { isEquip: reader.bool(), unitUID: reader.long(), equipItemUID: reader.long(), equipPosition: reader.int() };
      case 1002:
        return { equipItemUID: reader.long(), consumeEquipItemUIDList: reader.longList() };
      case 1004:
        return { equipItemUID: reader.long(), isLock: reader.bool() };
      case 1006:
        return { removeEquipItemUIDList: reader.longList() };
      case 1008:
        return { itemID: reader.int(), count: reader.int() };
      case 1012:
        return { index: reader.byte(), moldID: reader.int(), count: reader.int() };
      case 1014:
      case 1016:
        return { index: reader.byte() };
      case 1018:
      case 1020:
      case 1022:
        return { equipUID: reader.long(), equipOptionID: reader.int() };
      case 1024:
        return { equipUid: reader.long(), equipOptionId: reader.int(), statType: reader.int() };
      case 1026:
        return { itemId: reader.int(), rewardId: reader.int(), count: reader.int(), setOptionId: reader.int(), subSkillId: reader.int() };
      case 1028:
      case 1030:
      case 1034:
      case 1036:
        return { equipUID: reader.long(), unitUid: toBigInt(payload.length ? 0 : 0) };
      case 1032:
        return { equipUid: reader.long(), setOptionId: reader.int() };
      case 1040:
        return { addPresetCount: reader.int() };
      case 1042:
        return { presetIndex: reader.int(), newPresetName: reader.string() };
      case 1044:
        return { unitUid: reader.long(), presetIndex: reader.int() };
      case 1046:
        return { presetIndex: reader.int(), equipPosition: reader.int(), equipUid: reader.long() };
      case 1048:
        return { presetIndex: reader.int(), applyUnitUid: reader.long() };
      case 1055:
        return { equipUid: reader.long(), unitId: reader.int() };
      case 1057:
        return { equipUid: reader.long(), consumeEquipItemUidList: reader.longList() };
      case 1059:
        return { equipUid: reader.long(), socketIndex: reader.int() };
      case 1061:
        return { changeIndices: reader.presetIndexChanges() };
      case 1063:
        return { equipItemUID: reader.long(), miscItemList: reader.miscItemList() };
      case 1066:
        return { moldId: reader.int(), moldCount: reader.int() };
      case 1068:
      case 1070:
        return { equipUid: reader.long(), socketIndex: reader.int() };
      case 1074:
        return { presetIndices: reader.intList() };
      case 1076:
        return {
          equipItemUIDList: reader.longList(),
          equipMiscCostList: reader.equipMiscCostMap(),
          enchantLevel: reader.short(),
          openEquipSocket: reader.bool(),
        };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[equipment:${packetId}] request decode failed: ${err.message}`);
    return {};
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
    byte() {
      const read = readByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    short() {
      return this.int();
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
      let result = 0;
      let shift = 0;
      while (shift < 32) {
        if (offset >= payload.length) throw new Error("truncated varint");
        const byte = payload.readUInt8(offset++);
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return result >>> 0;
        shift += 7;
      }
      throw new Error("varint too long");
    },
    nullableMarker() {
      if (offset >= payload.length) throw new Error("truncated nullable marker");
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
    equipMiscCostMap() {
      const count = this.unsignedCount();
      const map = {};
      for (let index = 0; index < count; index += 1) {
        const equipUid = this.long();
        if (!this.nullableMarker()) {
          map[String(toBigInt(equipUid))] = [];
          continue;
        }
        map[String(toBigInt(equipUid))] = this.miscItemList();
      }
      return map;
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
  };
}

function now(ctx) {
  return ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
}

module.exports = {
  createEquipmentPipelineHandlers,
  presetListAck,
};
