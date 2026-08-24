const { randomInt: cryptoRandomInt } = require("crypto");
const {
  writeSignedVarInt,
  writeSignedVarLong,
  writeInt64LE,
  writeBool,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  buildUnitData,
  buildOperatorData,
  buildItemMiscData,
  buildRewardData,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  readBool,
  dateTimeBinaryNow,
  toBigInt,
} = require("../packet-codec");
const {
  ensureArmy,
  grantUnit,
  getArmyUnitByUid,
  getArmyOperatorByUid,
  addUnitExp,
  enhanceUnitStats,
  limitBreakUnit,
  upgradeUnitSkill,
  tacticUpdateUnit,
  reactorLevelUpUnit,
  permanentlyContractUnit,
  rearmUnit,
  setShipLevel,
  upgradeShip,
  limitBreakShip,
  setUnitLock,
  setUnitFavorite,
  setOperatorLock,
  addOperatorExp,
  enhanceOperator,
  removeArmyUnitUids,
  removeOperatorUids,
} = require("../unit");
const {
  getCollectionUnitTemplet,
  getMiscItemTemplet,
  getShipLevelUpCosts,
  getShipMaxLevel,
  getShipBuildTemplet,
  getShipBuildCosts,
  getShipUpgradeCosts,
  getShipLimitBreakTemplet,
  getShipLimitBreakCosts,
  getUnitTemplet,
  getLimitBreakInfo,
  getLimitBreakMaxLevel,
  getMaxLimitBreakRank,
  getTotalExpForUnitLevel,
  getUnitLimitBreakSubstituteRecord,
  getUnitLimitBreakCosts,
  getUnitSkillIndex,
  getUnitSkillTemplet,
  getUnitSkillMaxLevel,
  getUnitSkillMaxLevelFromLimitBreakLevel,
  getUnitSkillMaxLevelByStrId,
  getUnitSkillUpgradeCosts,
  getUnitReactorTemplet,
  getReactorSkillTemplet,
  getUnitRearmamentTemplet,
  getUnitRearmamentCosts,
  getActiveRecallTemplet,
  getRecallTemplets,
  getRecallExchangeUnitIds,
  getFirstLevelShipId,
  getRecallRewardUnitPieceToPoint,
  getOperatorExtractTokenItemId,
  getOperatorExtractPrice,
  getOperatorSkillTemplet,
  getOperatorEnhanceCost,
  getOperatorEnhanceRates,
  getOperatorPassiveToken,
  getOperatorLevelUpConfig,
  getUnitRemoveRewards,
  getUnitExtractRewards,
  getUnitExtractConfig,
  getUnitExtractBonusRewards,
} = require("../game-data");
const { spendMiscItem, getMiscItem, grantMiscItem, RESOURCE_ITEM_IDS } = require("../inventory");
const { INVENTORY_TYPES, getInventoryCapacity, getInventoryUsage } = require("../inventory-capacity");
const { dateFromDateTime, dateTimeBinaryForDate } = require("../server-time");
const collection = require("../collection");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");

const PACKETS = Object.freeze({
  ENHANCE_UNIT_REQ: 1400,
  ENHANCE_UNIT_ACK: 1401,
  LOCK_UNIT_REQ: 1402,
  LOCK_UNIT_ACK: 1403,
  REMOVE_UNIT_REQ: 1404,
  REMOVE_UNIT_ACK: 1405,
  LIMIT_BREAK_UNIT_REQ: 1406,
  LIMIT_BREAK_UNIT_ACK: 1407,
  UNIT_SKILL_UPGRADE_REQ: 1408,
  UNIT_SKILL_UPGRADE_ACK: 1409,
  SHIP_BUILD_REQ: 1410,
  SHIP_BUILD_ACK: 1411,
  SHIP_LEVELUP_REQ: 1412,
  SHIP_LEVELUP_ACK: 1413,
  SHIP_UPGRADE_REQ: 1414,
  SHIP_UPGRADE_ACK: 1415,
  SHIP_DIVISION_REQ: 1416,
  SHIP_DIVISION_ACK: 1417,
  CONTRACT_PERMANENTLY_REQ: 1420,
  CONTRACT_PERMANENTLY_ACK: 1421,
  OPERATOR_LEVELUP_REQ: 1424,
  OPERATOR_LEVELUP_ACK: 1425,
  OPERATOR_ENHANCE_REQ: 1426,
  OPERATOR_ENHANCE_ACK: 1427,
  OPERATOR_LOCK_REQ: 1428,
  OPERATOR_LOCK_ACK: 1429,
  OPERATOR_REMOVE_REQ: 1430,
  OPERATOR_REMOVE_ACK: 1431,
  RECALL_UNIT_REQ: 1432,
  RECALL_UNIT_ACK: 1433,
  EXTRACT_UNIT_REQ: 1434,
  EXTRACT_UNIT_ACK: 1435,
  REARMAMENT_UNIT_REQ: 1436,
  REARMAMENT_UNIT_ACK: 1437,
  FAVORITE_UNIT_REQ: 1443,
  FAVORITE_UNIT_ACK: 1444,
  LIMIT_BREAK_SHIP_REQ: 1445,
  LIMIT_BREAK_SHIP_ACK: 1446,
  UNIT_TACTIC_UPDATE_REQ: 1457,
  UNIT_TACTIC_UPDATE_ACK: 1458,
  UNIT_REACTOR_LEVELUP_REQ: 1461,
  UNIT_REACTOR_LEVELUP_ACK: 1462,
  OPERATOR_EXTRACT_REQ: 1463,
  OPERATOR_EXTRACT_ACK: 1464,
  NEGOTIATE_REQ: 1804,
  NEGOTIATE_ACK: 1805,
});

const UNIT_NEGOTIATION_MATERIALS = Object.freeze({
  1031: { exp: 150, loyalty: 1, credit: 1000 },
  1032: { exp: 750, loyalty: 5, credit: 5000 },
  1033: { exp: 2100, loyalty: 14, credit: 14000 },
});

const NEGOTIATE_RESULT = Object.freeze({
  SUCCESS: 0,
  COMPLETE: 1,
});

const NEGOTIATE_BOSS_SELECTION = Object.freeze({
  RAISE: 0,
  OK: 1,
  PASSION: 2,
});

const NEGOTIATION_OPTIONS = Object.freeze({
  MAX_MATERIAL_USAGE_LIMIT: 1000,
  PASSION_CREDIT_DECREASE_PERCENT: 10,
  RAISE_CREDIT_INCREASE_PERCENT: 30,
  RAISE_LOYALTY_INCREASE_PERCENT: 10,
  SUCCESS_ADDITIONAL_EXP_PERCENT: 20,
  PERMANENT_CONTRACT_EXP_BONUS_PERCENT: 20,
});

const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  UNIT_NOT_EXIST: 133,
  UNIT_BAD_TYPE: 134,
  UNIT_LOCKED: 135,
  UNIT_IN_DECK: 136,
  UNIT_IS_LOBBY_UNIT: 137,
  UNIT_IS_WORLDMAP_LEADER: 139,
  UNIT_EQUIP_ITEM: 141,
  UNIT_SKILL_NOT_EXIST: 147,
  UNIT_SKILL_TEMPLET_NOT_EXIST: 148,
  UNIT_SKILL_ALREADY_MAX: 149,
  UNIT_SKILL_NOT_ENOUGH_ITEM: 151,
  UNIT_SKILL_NEED_LIMIT_BREAK: 152,
  LIMITBREAK_ALREADY_MAX_LEVEL: 143,
  LIMITBREAK_LOW_LEVEL: 145,
  INSUFFICIENT_CREDIT: 98,
  GET_UNIT_LIMIT_BREAK_TEMPLET_NULL: 432,
  GET_ITEM_LIMIT_BREAK_TEMPLET_NULL: 433,
  SHIP_FULL: 113,
  WORLDMAP_MISSION_DOING: 162,
  WARFARE_DOING: 213,
  DIVE_DOING: 330,
  SHIP_IS_SEIZED: 20315,
  UNIT_IS_SEIZED: 20316,
  EXTRACT_UNIT_CONDITION: 20943,
  CANNOT_EXTRACT_UNIT: 20944,
  PERMANENT_CONTRACT_INVALID_CONDITION: 119,
  SHIP_INVALID_SHIP_ID: 239,
  SHIP_INVALID_SHIP_UID: 240,
  SHIP_NOT_UNLOCKED: 243,
  SHIP_MAX_LEVEL: 238,
  INVALID_ITEM_ID: 244,
  SHIP_INVALID_LEVEL: 1536,
  SHIP_REMODEL_NOT_ENOUGH_LEVEL: 242,
  GET_UNIT_BASE_TEMPLET_NULL: 429,
  SHIP_NOT_EXISTS: 22702,
  SHIP_LIMITBREAK_TEMPLET: 22703,
  SHIP_LIMITBREAK_LOCKED_CONSUMED_SHIP: 22704,
  SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP: 22705,
  OFFICE_UNIT_DELETE_IN_ROOM: 20921,
  DELETE_EXCLUDE_UNIT: 20956,
  UNIT_MAX_LEVEL: 313,
  OPERATOR_NOT_ENOUGH_MATERIAL: 20697,
  OPERATOR_INVALID_SKILL_ID: 20698,
  OPERATOR_INVALID_UNIT_ID: 20699,
  OPERATOR_INVALID_UNIT_UID: 20700,
  OPERATOR_ENHANCE_TOKEN_INVALID_ITEM_ID: 27204,
  NEGOTIATION_INVALID_MATERIAL: 20309,
  NEGOTIATION_INVALID_MATERIAL_COUNT: 20310,
  CONTAIN_SUPPORT_UNIT: 27805,
  INVALID_REQUEST: 20191,
  TACTIC_ALREADY_MAX_LEVEL: 23300,
  TACTIC_INVALID_BASE_UNIT: 23301,
  TACTIC_NOT_AVAILABLE: 23304,
  REACTOR_INVALID_ID: 25800,
  REACTOR_OVER_MAX_LEVEL: 25801,
  REACTOR_INVALID_TEMPLET: 25802,
  REACTOR_INVALID_SKILL_TEMPLET: 25803,
  REACTOR_NOT_AVAILABLE: 25804,
  REACTOR_INVALID_SKILL_CONDITION: 25805,
  REACTOR_DB_INVALID_LEVEL: 25806,
  OPENTAG_CLOSED: 20768,
  OPERATOR_EXTRACT_INVALID_DATA: 27200,
  OPERATOR_SKILL_TEMPLET_NOT_EXISTS: 27201,
  RECALL_NOT_AVAILABLE: 20862,
  RECALL_ALREADY_USED: 20863,
  RECALL_HISTORY_ADD: 20864,
  RECALL_PERIOD_EXPIRED: 20865,
  RECALL_INVALID_ACQUIRE_TIME: 20866,
  RECALL_UNIT_UNEQUIP_ITEM: 20867,
  RECALL_TEMPLET_EMPTY: 20870,
  RECALL_SHIP_INVALID_ID: 21081,
  RECALL_INVALID_EXCHANGE_DATA: 21082,
  REARMAMENT_INVALID_ID: 20953,
  REARMAMENT_CONDITION_LIMITBREAK: 20954,
  REARMAMENT_CONDITION_LEVEL: 20955,
});

const PERMANENT_CONTRACT_DOCUMENT_ID = 1024;
const ALWAYS_EXCLUDED_UNIT_IDS = new Set([21001, 22001, 23001, 24001, 25001, 26001, 21022, 22022, 23022, 24022, 25022, 26022]);
const CONDITIONAL_EXCLUDED_UNIT_TAGS = new Map([
  [1001, "TAG_DELETE_YOO_MI_NA"],
  [1002, "TAG_DELETE_TEAM_FENRIR"],
  [1003, "TAG_DELETE_JOO_SHI_YOON"],
]);

function createUnitGrowthHandlers() {
  return [
    handler(PACKETS.ENHANCE_UNIT_REQ, "ENHANCE_UNIT_REQ", handleEnhanceUnit),
    handler(PACKETS.LOCK_UNIT_REQ, "LOCK_UNIT_REQ", handleLockUnit),
    handler(PACKETS.REMOVE_UNIT_REQ, "REMOVE_UNIT_REQ", handleRemoveUnit),
    handler(PACKETS.LIMIT_BREAK_UNIT_REQ, "LIMIT_BREAK_UNIT_REQ", handleLimitBreakUnit),
    handler(PACKETS.UNIT_SKILL_UPGRADE_REQ, "UNIT_SKILL_UPGRADE_REQ", handleSkillUpgrade),
    handler(PACKETS.SHIP_BUILD_REQ, "SHIP_BUILD_REQ", handleShipBuild),
    handler(PACKETS.SHIP_LEVELUP_REQ, "SHIP_LEVELUP_REQ", handleShipLevelUp),
    handler(PACKETS.SHIP_UPGRADE_REQ, "SHIP_UPGRADE_REQ", handleShipUpgrade),
    handler(PACKETS.SHIP_DIVISION_REQ, "SHIP_DIVISION_REQ", handleShipDivision),
    handler(PACKETS.CONTRACT_PERMANENTLY_REQ, "CONTRACT_PERMANENTLY_REQ", handlePermanentContract),
    handler(PACKETS.OPERATOR_LEVELUP_REQ, "OPERATOR_LEVELUP_REQ", handleOperatorLevelUp),
    handler(PACKETS.OPERATOR_ENHANCE_REQ, "OPERATOR_ENHANCE_REQ", handleOperatorEnhance),
    handler(PACKETS.OPERATOR_LOCK_REQ, "OPERATOR_LOCK_REQ", handleOperatorLock),
    handler(PACKETS.OPERATOR_REMOVE_REQ, "OPERATOR_REMOVE_REQ", handleOperatorRemove),
    handler(PACKETS.RECALL_UNIT_REQ, "RECALL_UNIT_REQ", handleRecallUnit),
    handler(PACKETS.EXTRACT_UNIT_REQ, "EXTRACT_UNIT_REQ", handleExtractUnit),
    handler(PACKETS.REARMAMENT_UNIT_REQ, "REARMAMENT_UNIT_REQ", handleRearmUnit),
    handler(PACKETS.FAVORITE_UNIT_REQ, "FAVORITE_UNIT_REQ", handleFavoriteUnit),
    handler(PACKETS.LIMIT_BREAK_SHIP_REQ, "LIMIT_BREAK_SHIP_REQ", handleLimitBreakShip),
    handler(PACKETS.UNIT_TACTIC_UPDATE_REQ, "UNIT_TACTIC_UPDATE_REQ", handleTacticUpdate),
    handler(PACKETS.UNIT_REACTOR_LEVELUP_REQ, "UNIT_REACTOR_LEVELUP_REQ", handleReactorLevelUp),
    handler(PACKETS.OPERATOR_EXTRACT_REQ, "OPERATOR_EXTRACT_REQ", handleOperatorExtract),
    handler(PACKETS.NEGOTIATE_REQ, "NEGOTIATE_REQ", handleNegotiate),
  ];
}

function handler(packetId, name, buildResponse) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      const user = getSessionUser(ctx, socket);
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildResponse(ctx, user, request);
      if (!response) return false;
      const committed = response.persist !== false;
      const missionTracking = committed ? trackUnitGrowthMission(ctx, user, packetId, request) : null;
      console.log(`[unit-growth:${name}] ACK packetId=${response.packetId} ${formatRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      if (committed) sendUnitMissionCollectionUpdate(ctx, socket, user, packetId, request);
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "unit-growth-mission-update" });
      if (committed) {
        if (response.invalidateLobby && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
          ctx.invalidateJoinLobbyAckPayloadCache(response.invalidateLobby);
        }
        persistUserDb(ctx);
      }
      return true;
    },
  };
}

function sendUnitMissionCollectionUpdate(ctx, socket, user, packetId, request = {}) {
  if (![PACKETS.NEGOTIATE_REQ, PACKETS.LIMIT_BREAK_UNIT_REQ, PACKETS.REARMAMENT_UNIT_REQ].includes(packetId)) return;
  const unit = getArmyUnitByUid(user, request.unitUid);
  if (!unit || !collection || typeof collection.sendUnitMissionUpdatedNot !== "function") return;
  collection.sendUnitMissionUpdatedNot(ctx, socket, user, { unitIds: [unit.unitId] });
}

function trackUnitGrowthMission(ctx, user, packetId, request = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const now = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  const track = (condition, amount = 1, details = {}) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now, ...details });
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
    case PACKETS.ENHANCE_UNIT_REQ:
      track("UNIT_TRAINING", 1, { unitUid: request.unitUid });
      break;
    case PACKETS.LIMIT_BREAK_UNIT_REQ:
      track("UNIT_LIMITBREAK", 1, { unitUid: request.unitUid });
      track("UNIT_GROWTH_LIMIT", 1, { unitUid: request.unitUid });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.UNIT_TACTIC_UPDATE_REQ:
      track("UNIT_GROWTH_TACTICAL", 1, { unitUid: request.unitUid });
      break;
    case PACKETS.UNIT_REACTOR_LEVELUP_REQ:
      track("UNLOCKED_UNIT_REACTOR", 1, { unitUid: request.unitUid, unitId: request.unitId });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.UNIT_SKILL_UPGRADE_REQ:
      track("UNIT_TRAINING", 1, { unitUid: request.unitUid, value: request.skillId });
      track("UNIT_GROWTH_SKILL_LEVEL_3", 1, { unitUid: request.unitUid, value: request.skillId });
      track("UNIT_GROWTH_SKILL_LEVEL_MAX", 1, { unitUid: request.unitUid, value: request.skillId });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.CONTRACT_PERMANENTLY_REQ:
      track("UNIT_GROWTH_PERMANENT", 1, { unitUid: request.unitUid });
      break;
    case PACKETS.SHIP_LEVELUP_REQ:
      track("SHIP_LEVELUP", 1, { unitUid: request.shipUid });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.SHIP_UPGRADE_REQ:
      track("SHIP_UPGRADE", 1, { unitUid: request.shipUid, unitId: request.nextShipId, value: request.nextShipId });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.SHIP_BUILD_REQ:
      track("SHIP_MAKE", 1, { unitId: request.shipId, value: request.shipId });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.LIMIT_BREAK_SHIP_REQ:
      track("SHIP_LIMITBREAK", 1, { unitUid: request.shipUid });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.OPERATOR_LEVELUP_REQ:
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.OPERATOR_ENHANCE_REQ:
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.OPERATOR_EXTRACT_REQ:
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.REARMAMENT_UNIT_REQ:
      track("UNIT_USE_GO_UNIT_ID", 1, {
        unitUid: request.unitUid,
        unitId: request.rearmamentId,
        value: request.rearmamentId,
      });
      for (const item of request.resourceSpends || []) trackResourceSpend(item.itemId, item.count);
      break;
    case PACKETS.NEGOTIATE_REQ: {
      const unit = getArmyUnitByUid(user, request.unitUid);
      const materials = normalizeMaterialList(request.materials, UNIT_NEGOTIATION_MATERIALS, {
        maxCount: NEGOTIATION_OPTIONS.MAX_MATERIAL_USAGE_LIMIT,
      });
      const selection = normalizeNegotiationSelection(request.negotiateBossSelection);
      track("NEGOTIATION_TRY", 1, { unitUid: request.unitUid });
      for (const material of materials) trackResourceSpend(material.itemId, material.count);
      if (unit) trackResourceSpend(RESOURCE_ITEM_IDS.CREDIT, calculateNegotiationSalary(materials, selection));
      break;
    }
    default:
      break;
  }

  return tracking;
}

function handleEnhanceUnit(_ctx, user, request) {
  const unit = enhanceUnitStats(user, request.unitUid, request.consumeUnitUids);
  return response(PACKETS.ENHANCE_UNIT_ACK, [
    ok(),
    writeSignedVarLong(request.unitUid),
    writeSignedVarIntList((unit && unit.statExp) || [0, 0, 0, 0, 0, 0]),
    writeSignedVarLongList(request.consumeUnitUids || []),
    writeNullObject(),
  ]);
}

function handleLockUnit(_ctx, user, request) {
  const unit = request.valid ? getArmyUnitByUid(user, request.unitUid) : null;
  if (!unit) {
    return response(
      PACKETS.LOCK_UNIT_ACK,
      [writeSignedVarInt(ERROR_CODES.UNIT_NOT_EXIST), writeSignedVarLong(request.unitUid || 0n), writeBool(Boolean(request.locked))],
      { persist: false }
    );
  }
  const changed = Boolean(unit.locked) !== Boolean(request.locked);
  if (changed) setUnitLock(user, request.unitUid, request.locked);
  return response(
    PACKETS.LOCK_UNIT_ACK,
    [ok(), writeSignedVarLong(request.unitUid), writeBool(Boolean(request.locked))],
    { persist: changed }
  );
}

function handleRemoveUnit(_ctx, user, request) {
  const unitUids = validateRemovalUidList(request);
  if (!unitUids) return removalResponse(PACKETS.REMOVE_UNIT_ACK, removalResult(ERROR_CODES.INVALID_REQUEST));
  return removalResponse(
    PACKETS.REMOVE_UNIT_ACK,
    dismissArmyUnits(user, unitUids, { allowedKinds: new Set(["unit", "trophy"]) })
  );
}

function validateRemovalUidList(request) {
  if (!request || request.valid !== true || !Array.isArray(request.unitUids) || request.unitUids.length < 1 || request.unitUids.length > 1000) {
    return null;
  }
  const result = request.unitUids.map((uid) => String(toBigInt(uid || 0)));
  if (result.some((uid) => uid === "0") || new Set(result).size !== result.length) return null;
  return result;
}

function dismissArmyUnits(user, unitUids = [], options = {}) {
  const uidList = uniqueUidList(unitUids);
  const targets = [];
  for (const uid of uidList) {
    const unit = getArmyUnitByUid(user, uid);
    const kind = getArmyUnitStorageKind(user, uid);
    if (!unit) return removalResult(options.missingError || ERROR_CODES.UNIT_NOT_EXIST);
    if (options.allowedKinds && !options.allowedKinds.has(kind)) return removalResult(options.badTypeError || ERROR_CODES.UNIT_BAD_TYPE);
    const errorCode = getDismissUnitError(user, unit, uid, kind);
    if (errorCode !== ERROR_CODES.OK) return removalResult(errorCode);
    targets.push(unit);
  }

  const rewards = collectRemoveRewards(targets);
  const removed = removeArmyUnitUids(user, uidList);
  return removalResult(ERROR_CODES.OK, removed, grantRewardItems(user, rewards));
}

function dismissOperators(user, operatorUids = []) {
  const uidList = uniqueUidList(operatorUids);
  const targets = [];
  for (const uid of uidList) {
    const operator = getArmyOperatorByUid(user, uid);
    if (!operator) return removalResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
    const errorCode = getDismissOperatorError(user, operator, uid);
    if (errorCode !== ERROR_CODES.OK) return removalResult(errorCode);
    targets.push(operator);
  }

  const rewards = collectRemoveRewards(targets);
  const removed = removeOperatorUids(user, uidList);
  return removalResult(ERROR_CODES.OK, removed, grantRewardItems(user, rewards));
}

function getDismissUnitError(user, unit, uid, kind) {
  if (kind === "ship") return getDismissShipError(user, unit, uid);
  if (isExcludedDismissUnit(user, unit)) return ERROR_CODES.DELETE_EXCLUDE_UNIT;
  if (isRosterEntryLocked(unit)) return ERROR_CODES.UNIT_LOCKED;
  if (isUidInLobbyBackground(user, uid)) return ERROR_CODES.UNIT_IS_LOBBY_UNIT;
  if (isUidInDeck(user, uid, kind)) return ERROR_CODES.UNIT_IN_DECK;
  if (kind !== "ship" && hasEquippedItems(unit)) return ERROR_CODES.UNIT_EQUIP_ITEM;
  if (isUidWorldMapLeader(user, uid)) return ERROR_CODES.UNIT_IS_WORLDMAP_LEADER;
  if (isUidInOffice(user, unit, uid)) return ERROR_CODES.OFFICE_UNIT_DELETE_IN_ROOM;
  if (isUidSupportUnit(user, uid)) return ERROR_CODES.CONTAIN_SUPPORT_UNIT;
  return ERROR_CODES.OK;
}

function getDismissShipError(user, ship, uid) {
  const templet = getUnitTemplet(ship && ship.unitId);
  const groupId = Number(templet && templet.m_ShipGroupID || 0);
  if ([20001, 20022].includes(groupId) && !hasOpenTag(user, "TAG_DELETE_BASIC_SHIP")) {
    return ERROR_CODES.SHIP_INVALID_SHIP_ID;
  }
  if (isUidInDeck(user, uid, "ship")) return ERROR_CODES.UNIT_IN_DECK;
  if (isRosterEntryLocked(ship)) return ERROR_CODES.UNIT_LOCKED;
  return ERROR_CODES.OK;
}

function isExcludedDismissUnit(user, unit) {
  const unitId = Number(unit && unit.unitId || 0);
  if (ALWAYS_EXCLUDED_UNIT_IDS.has(unitId)) return true;
  const requiredTag = CONDITIONAL_EXCLUDED_UNIT_TAGS.get(unitId);
  if (!requiredTag) return false;
  return !hasOpenTag(user, requiredTag);
}

function hasOpenTag(user, requiredTag) {
  const expected = String(requiredTag || "").toUpperCase();
  return Array.isArray(user && user.openTags) && user.openTags.some((tag) => String(tag || "").toUpperCase() === expected);
}

function isUidInLobbyBackground(user, uid) {
  const key = String(toBigInt(uid || 0));
  const state = user && user.lobbyCustomization;
  const info = state && state.backgroundInfo || user && (user.backGroundInfo || user.backgroundInfo);
  const units = info && Array.isArray(info.unitInfoList) ? info.unitInfoList : [];
  return units.some((entry) => String(toBigInt(entry && (entry.unitUid || entry.unitUID) || 0)) === key);
}

function isUidWorldMapLeader(user, uid) {
  const key = String(toBigInt(uid || 0));
  const cities = user && user.worldMap && user.worldMap.cities;
  return Object.values(cities && typeof cities === "object" ? cities : {}).some(
    (city) => String(toBigInt(city && (city.leaderUnitUID || city.leaderUID) || 0)) === key
  );
}

function isUidInOffice(user, unit, uid) {
  if (Number(unit && (unit.officeRoomId || unit.OfficeRoomId) || 0) > 0) return true;
  const key = String(toBigInt(uid || 0));
  const rooms = user && user.office && Array.isArray(user.office.rooms) ? user.office.rooms : [];
  return rooms.some((room) => Array.isArray(room && room.unitUids) && room.unitUids.some((roomUid) => String(toBigInt(roomUid || 0)) === key));
}

function isUidSupportUnit(user, uid) {
  const key = String(toBigInt(uid || 0));
  const supportUid = user && user.support && user.support.mySupportUnitUid;
  return supportUid != null && String(toBigInt(supportUid || 0)) === key;
}

function getDismissOperatorError(user, operator, uid) {
  if (isRosterEntryLocked(operator)) return ERROR_CODES.UNIT_LOCKED;
  if (isUidInLobbyBackground(user, uid)) return ERROR_CODES.UNIT_IS_LOBBY_UNIT;
  if (isUidInDeck(user, uid, "operator")) return ERROR_CODES.UNIT_IN_DECK;
  return ERROR_CODES.OK;
}

function collectRemoveRewards(entries) {
  const byItem = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const unitId = Number(entry && (entry.unitId || entry.id || entry.m_UnitID)) || 0;
    for (const reward of getUnitRemoveRewards(unitId, { fromContract: isFromContract(entry) })) {
      byItem.set(reward.itemId, (byItem.get(reward.itemId) || 0) + reward.count);
    }
  }
  return Array.from(byItem.entries())
    .map(([itemId, count]) => ({ itemId, count }))
    .sort((a, b) => a.itemId - b.itemId);
}

function grantRewardItems(user, rewards) {
  return (Array.isArray(rewards) ? rewards : [])
    .map((reward) => grantMiscItem(user, reward.itemId, reward.count))
    .filter(Boolean);
}

function getArmyUnitStorageKind(user, uid) {
  const army = ensureArmy(user);
  const key = String(toBigInt(uid || 0));
  if (army.ships[key]) return "ship";
  if (army.trophies[key]) return "trophy";
  if (army.units[key]) return "unit";
  return "";
}

function isRosterEntryLocked(entry) {
  return Boolean(entry && (entry.locked || entry.bLock || entry.m_bLock));
}

function hasEquippedItems(unit) {
  const equipUids = unit && (unit.equipItemUids || unit.m_EquipItemList || unit.equipItems);
  return Array.isArray(equipUids) && equipUids.some((uid) => toBigInt(uid || 0) > 0n);
}

function isFromContract(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.fromContract === false || entry.FromContract === false || entry.m_bFromContract === false) return false;
  return entry.fromContract === true || entry.FromContract === true || entry.m_bFromContract === true || entry.fromContract == null;
}

function isUidInDeck(user, uid, kind) {
  const army = ensureArmy(user);
  const normalizedUid = String(toBigInt(uid || 0));
  for (const deck of getAllDecks(army)) {
    if (kind === "ship" && String(toBigInt(deck.shipUid || deck.m_ShipUID || 0)) === normalizedUid) return true;
    if (kind === "operator" && String(toBigInt(deck.operatorUid || deck.m_OperatorUID || 0)) === normalizedUid) return true;
    if (kind === "unit" || kind === "trophy") {
      const unitUids = deck.unitUids || deck.m_listDeckUnitUID || deck.m_UnitUIDList || [];
      if (Array.isArray(unitUids) && unitUids.some((deckUid) => String(toBigInt(deckUid || 0)) === normalizedUid)) return true;
    }
  }
  return false;
}

function getAllDecks(army) {
  const deckSets = Object.values((army && army.deckSets) || {}).filter(Array.isArray);
  const legacyDecks = Array.isArray(army && army.decks) ? [army.decks] : [];
  return deckSets.concat(legacyDecks).flat();
}

function uniqueUidList(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const uid = toBigInt(value || 0);
    if (uid <= 0n) continue;
    const key = uid.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function removalResult(errorCode, removed = [], rewardItems = []) {
  return {
    errorCode: Number(errorCode || 0) || 0,
    removed: Array.isArray(removed) ? removed : [],
    rewardItems: Array.isArray(rewardItems) ? rewardItems : [],
  };
}

function removalResponse(packetId, result) {
  return response(packetId, [
    writeSignedVarInt(result.errorCode),
    writeSignedVarLongList(result.removed),
    writeNullableObjectList(result.rewardItems.map(buildItemMiscData)),
  ], {
    persist: result.errorCode === ERROR_CODES.OK && result.removed.length > 0,
    invalidateLobby: result.removed.length > 0 ? "roster-removal" : undefined,
  });
}

function handleLimitBreakUnit(ctx, user, request) {
  const result = executeUnitLimitBreak(ctx, user, request);
  if (result.errorCode === ERROR_CODES.OK) request.resourceSpends = result.resourceSpends;
  return response(
    PACKETS.LIMIT_BREAK_UNIT_ACK,
    [
      writeSignedVarInt(result.errorCode),
      nullableUnit(result.unit),
      writeNullableObjectList(result.costItems.map(buildItemMiscData)),
    ],
    {
      persist: result.errorCode === ERROR_CODES.OK,
      invalidateLobby: result.errorCode === ERROR_CODES.OK ? "unit-limit-break" : undefined,
    }
  );
}

function executeUnitLimitBreak(ctx, user, request = {}) {
  if (!request.valid) return unitLimitBreakResult(ERROR_CODES.INVALID_REQUEST);
  const unit = getArmyUnitByUid(user, request.unitUid);
  if (!unit || getArmyUnitStorageKind(user, request.unitUid) !== "unit") {
    return unitLimitBreakResult(ERROR_CODES.UNIT_NOT_EXIST);
  }
  if (unit.isSeized) return unitLimitBreakResult(ERROR_CODES.UNIT_IS_SEIZED);
  const deckError = unitSkillDeckError(user, request.unitUid);
  if (deckError !== ERROR_CODES.OK) return unitLimitBreakResult(deckError);

  const unitTemplet = getUnitTemplet(unit.unitId);
  if (!isTacticUnitTemplet(unitTemplet)) return unitLimitBreakResult(ERROR_CODES.UNIT_BAD_TYPE);

  const currentRank = Math.max(0, Math.trunc(Number(unit.limitBreakLevel || 0) || 0));
  if (currentRank >= getMaxLimitBreakRank()) {
    return unitLimitBreakResult(ERROR_CODES.LIMITBREAK_ALREADY_MAX_LEVEL);
  }
  const targetRank = currentRank + 1;
  const limitBreakInfo = getLimitBreakInfo(targetRank);
  if (!limitBreakInfo || !isContentsVersionRecordActive(ctx, user, limitBreakInfo)) {
    return unitLimitBreakResult(ERROR_CODES.GET_UNIT_LIMIT_BREAK_TEMPLET_NULL);
  }
  if (Number(unit.level || 0) < Math.max(1, Number(limitBreakInfo.m_iRequiredLevel) || 1)) {
    return unitLimitBreakResult(ERROR_CODES.LIMITBREAK_LOW_LEVEL);
  }

  const substitute = getUnitLimitBreakSubstituteRecord(unit.unitId, targetRank);
  if (!substitute || !isContentsVersionRecordActive(ctx, user, substitute)) {
    return unitLimitBreakResult(ERROR_CODES.GET_ITEM_LIMIT_BREAK_TEMPLET_NULL);
  }
  const costs = getUnitLimitBreakCosts(unit.unitId, targetRank);
  for (const cost of costs) {
    if (hasEnoughMiscItem(user, cost.itemId, cost.count)) continue;
    return unitLimitBreakResult(
      Number(cost.itemId) === RESOURCE_ITEM_IDS.CREDIT ? ERROR_CODES.INSUFFICIENT_CREDIT : ERROR_CODES.INSUFFICIENT_ITEM
    );
  }

  const costItems = spendShipLevelUpCosts(user, costs);
  const updated = limitBreakUnit(user, request.unitUid, { maxLimitBreakLevel: targetRank });
  if (!updated || Number(updated.limitBreakLevel || 0) !== targetRank) {
    return unitLimitBreakResult(ERROR_CODES.INVALID_REQUEST);
  }
  return unitLimitBreakResult(ERROR_CODES.OK, updated, costItems, costs);
}

function isContentsVersionRecordActive(ctx, user, record) {
  const allow = Array.isArray(record && record.listContentsTagAllow) ? record.listContentsTagAllow : [];
  const ignore = Array.isArray(record && record.listContentsTagIgnore) ? record.listContentsTagIgnore : [];
  return (allow.length === 0 || allow.some((tag) => isEffectiveTagOpen(ctx, user, tag))) &&
    !ignore.some((tag) => isEffectiveTagOpen(ctx, user, tag));
}

function unitLimitBreakResult(errorCode, unit = null, costItems = [], resourceSpends = []) {
  return { errorCode, unit, costItems, resourceSpends };
}

function handleSkillUpgrade(_ctx, user, request) {
  if (!request || request.valid !== true) {
    return skillUpgradeResponse(request, ERROR_CODES.INVALID_REQUEST, 1, []);
  }
  const unit = getArmyUnitByUid(user, request.unitUid);
  if (!unit || getArmyUnitStorageKind(user, request.unitUid) !== "unit") {
    return skillUpgradeResponse(request, ERROR_CODES.UNIT_NOT_EXIST, 1, []);
  }
  if (unit.isSeized) return skillUpgradeResponse(request, ERROR_CODES.UNIT_IS_SEIZED, 1, []);
  const deckError = unitSkillDeckError(user, request.unitUid);
  if (deckError !== ERROR_CODES.OK) return skillUpgradeResponse(request, deckError, 1, []);

  const skillIndex = resolveRequestedSkillIndex(unit, request.skillId);
  if (skillIndex < 0) return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_NOT_EXIST, 1, []);

  const currentLevel = getCurrentSkillLevel(unit, skillIndex);
  const currentTemplet = getUnitSkillTemplet(request.skillId, currentLevel);
  if (!currentTemplet) return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_NOT_EXIST, currentLevel, []);
  const targetLevel = currentLevel + 1;
  const nextTemplet = getUnitSkillTemplet(request.skillId, targetLevel);
  if (!nextTemplet) {
    return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_ALREADY_MAX, currentLevel, []);
  }

  const limitBreakLevel = Math.max(0, Math.trunc(Number(unit.limitBreakLevel || 0) || 0));
  const unlockRequired = Math.max(0, Math.trunc(Number(currentTemplet.m_UnlockReqUpgrade || 0) || 0));
  const maxLevel = getUnitSkillMaxLevelFromLimitBreakLevel(request.skillId, limitBreakLevel);
  if (unlockRequired > limitBreakLevel || targetLevel > maxLevel) {
    return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_NEED_LIMIT_BREAK, currentLevel, []);
  }

  const costs = getUnitSkillUpgradeCosts(request.skillId, targetLevel);
  if (!costs) return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_TEMPLET_NOT_EXIST, currentLevel, []);
  if (!hasEnoughSkillUpgradeItems(user, costs)) {
    return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_NOT_ENOUGH_ITEM, currentLevel, []);
  }

  const result = upgradeUnitSkill(user, request.unitUid, request.skillId, { maxSkillLevel: maxLevel }) || {};
  const costItems = spendSkillUpgradeCosts(user, costs);
  request.resourceSpends = costs;
  return skillUpgradeResponse(request, ERROR_CODES.OK, result.skillLevel || targetLevel, costItems);
}

function handleShipBuild(ctx, user, request) {
  const result = buildShip(ctx, user, request);
  if (result.errorCode === ERROR_CODES.OK) request.resourceSpends = result.resourceSpends;
  return response(
    PACKETS.SHIP_BUILD_ACK,
    [
      writeSignedVarInt(result.errorCode),
      nullableUnit(result.ship),
      writeNullableObjectList(result.costItems.map(buildItemMiscData)),
    ],
    {
      persist: result.errorCode === ERROR_CODES.OK,
      invalidateLobby: result.errorCode === ERROR_CODES.OK ? "ship-build" : undefined,
    }
  );
}

function buildShip(ctx, user, request = {}) {
  if (!request.valid) return shipBuildResult(ERROR_CODES.INVALID_REQUEST);
  if (getInventoryUsage(user, INVENTORY_TYPES.SHIP) >= getInventoryCapacity(user, INVENTORY_TYPES.SHIP)) {
    return shipBuildResult(ERROR_CODES.SHIP_FULL);
  }

  const shipId = Number(request.shipId || 0);
  const unitTemplet = getUnitTemplet(shipId);
  const buildTemplet = getShipBuildTemplet(shipId);
  if (
    !Number.isInteger(shipId) ||
    shipId <= 0 ||
    !unitTemplet ||
    String(unitTemplet.m_NKM_UNIT_TYPE || "") !== "NUT_SHIP" ||
    !buildTemplet ||
    !isShipBuildTempletActive(ctx, user, buildTemplet)
  ) {
    return shipBuildResult(ERROR_CODES.SHIP_INVALID_SHIP_ID);
  }

  const costs = getShipBuildCosts(buildTemplet);
  if (!costs) return shipBuildResult(ERROR_CODES.SHIP_INVALID_SHIP_ID);
  if (!costs.every((cost) => hasEnoughMiscItem(user, cost.itemId, cost.count))) {
    return shipBuildResult(ERROR_CODES.INSUFFICIENT_ITEM);
  }
  if (!isShipBuildUnlocked(user, buildTemplet)) return shipBuildResult(ERROR_CODES.SHIP_NOT_UNLOCKED);

  const ship = grantUnit(user, shipId, { level: 1, fromContract: false });
  if (!ship) return shipBuildResult(ERROR_CODES.SHIP_INVALID_SHIP_ID);
  const costItems = costs.map((cost) => spendMiscItem(user, cost.itemId, cost.count)).filter(Boolean);
  return shipBuildResult(ERROR_CODES.OK, ship, costItems, costs);
}

function isShipBuildTempletActive(ctx, user, templet) {
  const allow = Array.isArray(templet && templet.listContentsTagAllow) ? templet.listContentsTagAllow : [];
  const ignore = Array.isArray(templet && templet.listContentsTagIgnore) ? templet.listContentsTagIgnore : [];
  return (allow.length === 0 || allow.some((tag) => isEffectiveTagOpen(ctx, user, tag))) &&
    !ignore.some((tag) => isEffectiveTagOpen(ctx, user, tag));
}

function isShipBuildUnlocked(user, templet) {
  const type = String(templet && templet.m_ShipBuildUnlockType || "");
  const value = Number(templet && templet.m_ShipBuildUnlockValue || 0);
  switch (type) {
    case "BUT_ALWAYS":
      return true;
    case "BUT_PLAYER_LEVEL":
      return Math.max(1, Number(user && (user.level || user.userLevel) || 1)) >= value;
    case "BUT_DUNGEON_CLEAR":
      return hasDungeonClear(user, value);
    case "BUT_WARFARE_CLEAR":
      return hasWarfareClear(user, value);
    case "BUT_SHIP_GET":
      return Boolean(user && user.collection && Array.isArray(user.collection.ships) && user.collection.ships.some((id) => Number(id) === value));
    case "BUT_SHIP_LV100":
      return Object.values(ensureArmy(user).ships).some((ship) => Number(ship && ship.unitId) === value && Number(ship.level || 0) >= 100);
    case "BUT_WORLDMAP_CITY_COUNT":
      return Object.keys(user && user.worldMap && user.worldMap.cities || {}).length >= value;
    case "BUT_SHADOW_CLEAR":
      return hasShadowPalaceClear(user, value);
    default:
      return false;
  }
}

function hasDungeonClear(user, dungeonId) {
  const key = String(Number(dungeonId || 0));
  return Boolean(
    user && user.dungeonClear && user.dungeonClear[key] ||
    user && user.clearConditions && user.clearConditions.dungeons && user.clearConditions.dungeons[key]
  );
}

function hasWarfareClear(user, warfareId) {
  const key = String(Number(warfareId || 0));
  return Boolean(
    user && user.warfareClear && user.warfareClear[key] ||
    user && user.clearConditions && user.clearConditions.warfares && user.clearConditions.warfares[key]
  );
}

function hasShadowPalaceClear(user, palaceId) {
  return require("../shadow-palace").hasCompletePalaceId(user, palaceId);
}

function shipBuildResult(errorCode, ship = null, costItems = [], resourceSpends = []) {
  return { errorCode, ship, costItems, resourceSpends };
}

function handleShipLevelUp(_ctx, user, request) {
  const currentShip = request.valid ? getPhysicalShipByUid(user, request.shipUid) : null;
  if (!currentShip) return shipLevelUpResponse(ERROR_CODES.UNIT_NOT_EXIST, null, []);
  if (currentShip.isSeized) return shipLevelUpResponse(ERROR_CODES.SHIP_IS_SEIZED, null, []);

  const currentLevel = Math.max(1, Math.trunc(Number(currentShip.level || 1) || 1));
  const nextLevel = Math.trunc(Number(request.nextLevel || 0) || 0);
  const busyError = shipDeckError(user, request.shipUid);
  if (busyError !== ERROR_CODES.OK) return shipLevelUpResponse(busyError, null, []);

  const maxLevel = getShipMaxLevel(currentShip);
  if (nextLevel > maxLevel) {
    return shipLevelUpResponse(ERROR_CODES.SHIP_MAX_LEVEL, null, []);
  }
  if (nextLevel < 1 || nextLevel < currentLevel) {
    return shipLevelUpResponse(ERROR_CODES.SHIP_INVALID_LEVEL, null, []);
  }

  const costs = getShipLevelUpCosts(currentShip, currentLevel, nextLevel);
  if (!hasEnoughShipLevelUpItems(user, costs)) {
    return shipLevelUpResponse(ERROR_CODES.INVALID_ITEM_ID, null, []);
  }
  if (nextLevel === currentLevel) return shipLevelUpResponse(ERROR_CODES.OK, currentShip, [], { persist: false });

  const costItems = spendShipLevelUpCosts(user, costs);
  const ship = setShipLevel(user, request.shipUid, nextLevel) || getArmyUnitByUid(user, request.shipUid) || currentShip;
  request.resourceSpends = costs;
  return shipLevelUpResponse(ERROR_CODES.OK, ship, costItems, { invalidateLobby: "ship-levelup" });
}

function handleShipUpgrade(_ctx, user, request) {
  const nextTemplet = request.valid ? getUnitTemplet(request.nextShipId) : null;
  if (!nextTemplet) return shipUpgradeResponse(ERROR_CODES.SHIP_INVALID_SHIP_ID, null, []);

  const currentShip = getPhysicalShipByUid(user, request.shipUid);
  if (!currentShip) return shipUpgradeResponse(ERROR_CODES.SHIP_INVALID_SHIP_UID, null, []);
  if (currentShip.isSeized) return shipUpgradeResponse(ERROR_CODES.SHIP_IS_SEIZED, null, []);
  const busyError = shipDeckError(user, request.shipUid);
  if (busyError !== ERROR_CODES.OK) return shipUpgradeResponse(busyError, null, []);

  const currentTemplet = getUnitTemplet(currentShip.unitId);
  if (!currentTemplet) return shipUpgradeResponse(ERROR_CODES.GET_UNIT_BASE_TEMPLET_NULL, null, []);
  const currentForMax = {
    ...currentShip,
    starGrade: Number(currentTemplet.m_StarGradeMax || currentTemplet.m_StarGrade || 0),
    grade: currentTemplet.m_NKM_UNIT_GRADE,
  };
  if (Number(currentShip.level || 1) < getShipMaxLevel(currentForMax)) {
    return shipUpgradeResponse(ERROR_CODES.SHIP_REMODEL_NOT_ENOUGH_LEVEL, null, []);
  }

  const currentBuild = getShipBuildTemplet(currentShip.unitId);
  if (
    !currentBuild ||
    ![Number(currentBuild.m_ShipUpgradeTarget1 || 0), Number(currentBuild.m_ShipUpgradeTarget2 || 0)].includes(Number(request.nextShipId))
  ) {
    return shipUpgradeResponse(ERROR_CODES.SHIP_INVALID_SHIP_ID, null, []);
  }
  const nextBuild = getShipBuildTemplet(request.nextShipId);
  if (!nextBuild) return shipUpgradeResponse(ERROR_CODES.SHIP_INVALID_SHIP_ID, null, []);

  const costs = getShipUpgradeCosts(nextBuild) || [];
  if (!hasEnoughShipLevelUpItems(user, costs)) return shipUpgradeResponse(ERROR_CODES.INSUFFICIENT_ITEM, null, []);

  const costItems = spendShipLevelUpCosts(user, costs);
  const ship = upgradeShip(user, request.shipUid, request.nextShipId) || getArmyUnitByUid(user, request.shipUid) || currentShip;
  request.resourceSpends = costs;
  return shipUpgradeResponse(ERROR_CODES.OK, ship, costItems, { invalidateLobby: "ship-upgrade" });
}

function handleShipDivision(_ctx, user, request) {
  const shipUids = validateRemovalUidList({ valid: request.valid, unitUids: request.shipUids });
  if (!shipUids) return removalResponse(PACKETS.SHIP_DIVISION_ACK, removalResult(ERROR_CODES.INVALID_REQUEST));
  return removalResponse(
    PACKETS.SHIP_DIVISION_ACK,
    dismissArmyUnits(user, shipUids, {
      allowedKinds: new Set(["ship"]),
      missingError: ERROR_CODES.SHIP_INVALID_SHIP_UID,
      badTypeError: ERROR_CODES.SHIP_INVALID_SHIP_UID,
    })
  );
}

function handlePermanentContract(_ctx, user, request) {
  if (!request.valid) return permanentContractResponse(request, ERROR_CODES.INVALID_REQUEST);
  const unit = getArmyUnitByUid(user, request.unitUid);
  const unitTemplet = getUnitTemplet(unit && unit.unitId);
  if (!unit || !unitTemplet || String(unitTemplet.m_NKM_UNIT_TYPE || "") !== "NUT_NORMAL") {
    return permanentContractResponse(request, ERROR_CODES.UNIT_NOT_EXIST);
  }
  const collectionTemplet = getCollectionUnitTemplet(unit.unitId);
  if (!collectionTemplet || !String(collectionTemplet.m_CutsceneLifetime_Start || "")) {
    return permanentContractResponse(request, ERROR_CODES.PERMANENT_CONTRACT_INVALID_CONDITION);
  }
  if (!hasEnoughMiscItem(user, PERMANENT_CONTRACT_DOCUMENT_ID, 1)) {
    return permanentContractResponse(request, ERROR_CODES.INSUFFICIENT_ITEM);
  }
  if (Number(unit.loyalty || 0) < 10000 || unit.isPermanentContract) {
    return permanentContractResponse(request, ERROR_CODES.PERMANENT_CONTRACT_INVALID_CONDITION);
  }
  const costItem = spendMiscItem(user, PERMANENT_CONTRACT_DOCUMENT_ID, 1);
  permanentlyContractUnit(user, request.unitUid);
  return permanentContractResponse(request, ERROR_CODES.OK, costItem, { persist: true, invalidateLobby: "permanent-contract" });
}

function permanentContractResponse(request, errorCode, costItem = null, options = {}) {
  return response(
    PACKETS.CONTRACT_PERMANENTLY_ACK,
    [
      writeSignedVarInt(errorCode),
      writeSignedVarLong(request.unitUid || 0n),
      costItem ? writeNullableObject(buildItemMiscData(costItem)) : writeNullObject(),
    ],
    { persist: false, ...options }
  );
}

function handleOperatorLevelUp(_ctx, user, request) {
  const result = executeOperatorLevelUp(user, request);
  if (result.errorCode === ERROR_CODES.OK) request.resourceSpends = result.resourceSpends;
  return response(
    PACKETS.OPERATOR_LEVELUP_ACK,
    [
      writeSignedVarInt(result.errorCode),
      writeNullableObjectList(result.costItems.map(buildItemMiscData)),
      nullableOperator(result.operator),
    ],
    {
      persist: result.errorCode === ERROR_CODES.OK,
      invalidateLobby: result.errorCode === ERROR_CODES.OK ? "operator-levelup" : undefined,
    }
  );
}

function executeOperatorLevelUp(user, request = {}) {
  if (!request.valid) return operatorLevelUpResult(ERROR_CODES.INVALID_REQUEST);
  const operator = getArmyOperatorByUid(user, request.operatorUid);
  if (!operator) return operatorLevelUpResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);

  const templet = getUnitTemplet(operator.id);
  if (!templet || String(templet.m_NKM_UNIT_TYPE || "") !== "NUT_OPERATOR") {
    return operatorLevelUpResult(ERROR_CODES.OPERATOR_INVALID_UNIT_ID);
  }
  const config = getOperatorLevelUpConfig();
  if (!config) return operatorLevelUpResult(ERROR_CODES.INVALID_REQUEST);
  if (Number(operator.level || 0) >= config.maxLevel) {
    return operatorLevelUpResult(ERROR_CODES.UNIT_MAX_LEVEL);
  }

  const materialResult = validateOperatorLevelUpMaterials(request, config);
  if (materialResult.errorCode !== ERROR_CODES.OK) return operatorLevelUpResult(materialResult.errorCode);
  for (const material of materialResult.materials) {
    if (!hasEnoughMiscItem(user, material.itemId, material.count)) {
      return operatorLevelUpResult(ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL);
    }
  }
  if (!hasEnoughMiscItem(user, RESOURCE_ITEM_IDS.CREDIT, materialResult.credit)) {
    return operatorLevelUpResult(ERROR_CODES.INSUFFICIENT_CREDIT);
  }

  const costs = mergeItemAmounts([
    ...materialResult.materials,
    { itemId: RESOURCE_ITEM_IDS.CREDIT, count: materialResult.credit },
  ]);
  const updated = addOperatorExp(user, request.operatorUid, materialResult.exp, { maxLevel: config.maxLevel });
  if (!updated) return operatorLevelUpResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
  const costItems = spendShipLevelUpCosts(user, costs);
  return operatorLevelUpResult(ERROR_CODES.OK, updated, costItems, costs);
}

function validateOperatorLevelUpMaterials(request, config) {
  const materials = Array.isArray(request.materials) ? request.materials : [];
  const declaredCount = Number(request.materialEntryCount);
  if (request.nullMaterialCount > 0 || declaredCount !== materials.length) {
    return { errorCode: ERROR_CODES.NEGOTIATION_INVALID_MATERIAL };
  }
  if (materials.length <= 0) return { errorCode: ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL };

  const materialById = new Map(config.materials.map((material) => [material.itemId, material]));
  const normalized = [];
  const seen = new Set();
  let totalCount = 0;
  let exp = 0;
  let credit = 0;
  for (const material of materials) {
    const itemId = Number(material && material.itemId);
    const count = Number(material && material.count);
    const definition = materialById.get(itemId);
    if (!definition || seen.has(itemId)) {
      return { errorCode: ERROR_CODES.NEGOTIATION_INVALID_MATERIAL };
    }
    if (!Number.isInteger(count) || count <= 0) {
      return { errorCode: ERROR_CODES.NEGOTIATION_INVALID_MATERIAL_COUNT };
    }
    seen.add(itemId);
    totalCount += count;
    if (totalCount > config.maxMaterialUsageLimit) {
      return { errorCode: ERROR_CODES.NEGOTIATION_INVALID_MATERIAL_COUNT };
    }
    normalized.push({ itemId, count });
    exp += definition.exp * count;
    credit += definition.credit * count;
  }
  return { errorCode: ERROR_CODES.OK, materials: normalized, exp, credit };
}

function operatorLevelUpResult(errorCode, operator = null, costItems = [], resourceSpends = []) {
  return { errorCode, operator, costItems, resourceSpends };
}

function handleOperatorEnhance(ctx, user, request) {
  const result = executeOperatorEnhance(ctx, user, request);
  if (result.errorCode === ERROR_CODES.OK) request.resourceSpends = result.resourceSpends;
  return response(
    PACKETS.OPERATOR_ENHANCE_ACK,
    [
      writeSignedVarInt(result.errorCode),
      nullableOperator(result.operator),
      writeNullableObjectList(result.costItems.map(buildItemMiscData)),
      writeSignedVarLong(request.sourceOperatorUid || 0n),
      writeBool(Boolean(request.transSkill)),
      writeSignedVarInt(request.tokenItemId || 0),
    ],
    {
      persist: result.errorCode === ERROR_CODES.OK,
      invalidateLobby: result.errorCode === ERROR_CODES.OK ? "operator-enhance" : undefined,
    }
  );
}

function executeOperatorEnhance(ctx, user, request = {}) {
  if (!request.valid) return operatorEnhanceResult(ERROR_CODES.INVALID_REQUEST);
  const target = getArmyOperatorByUid(user, request.operatorUid);
  if (!target) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
  const targetTemplet = getUnitTemplet(target.id);
  if (!isOperatorTemplet(targetTemplet)) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_ID);

  const targetMainSkill = getOperatorSkillTemplet(target.mainSkill && target.mainSkill.id);
  const targetSubSkill = getOperatorSkillTemplet(target.subSkill && target.subSkill.id);
  if (!targetMainSkill || !targetSubSkill) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_SKILL_ID);

  const sourceUid = toBigInt(request.sourceOperatorUid || 0);
  const tokenItemId = Number(request.tokenItemId || 0);
  if ((sourceUid > 0n) === (tokenItemId > 0)) return operatorEnhanceResult(ERROR_CODES.INVALID_REQUEST);

  const enhanceCost = getOperatorEnhanceCost(targetTemplet);
  if (!enhanceCost) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_ID);

  let nextMainSkillLevel = Number(target.mainSkill.level || 1);
  let nextSubSkillId = Number(target.subSkill.id || 0);
  let nextSubSkillLevel = Number(target.subSkill.level || 1);
  const resourceSpends = [enhanceCost];

  if (sourceUid > 0n) {
    if (sourceUid === toBigInt(request.operatorUid || 0)) {
      return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
    }
    const source = getArmyOperatorByUid(user, sourceUid);
    if (!source) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
    const sourceStateError = getDismissOperatorError(user, source, sourceUid);
    if (sourceStateError !== ERROR_CODES.OK) return operatorEnhanceResult(sourceStateError);
    const sourceTemplet = getUnitTemplet(source.id);
    if (!isOperatorTemplet(sourceTemplet)) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_ID);
    const sourceMainSkill = getOperatorSkillTemplet(source.mainSkill && source.mainSkill.id);
    const sourceSubSkill = getOperatorSkillTemplet(source.subSkill && source.subSkill.id);
    const rates = getOperatorEnhanceRates(sourceTemplet);
    if (!sourceMainSkill || !sourceSubSkill || !rates) {
      return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
    }

    const canMain = Number(target.mainSkill.id) === Number(source.mainSkill.id) &&
      nextMainSkillLevel < getOperatorSkillMaxLevel(targetMainSkill);
    const canSub = Number(target.subSkill.id) === Number(source.subSkill.id) &&
      nextSubSkillLevel < getOperatorSkillMaxLevel(targetSubSkill);
    const canTransfer = Number(target.subSkill.id) !== Number(source.subSkill.id) &&
      operatorGradeRank(sourceTemplet.m_NKM_UNIT_GRADE) >= operatorGradeRank(targetTemplet.m_NKM_UNIT_GRADE);
    if (request.transSkill ? !canTransfer : !canMain && !canSub) {
      return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
    }
    if (!hasEnoughMiscItem(user, enhanceCost.itemId, enhanceCost.count)) {
      return operatorEnhanceResult(ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL);
    }

    if (canMain) {
      const sameOperator = Number(target.id) === Number(source.id);
      const chance = sameOperator ? rates.commandLevelUpPercent : rates.levelUpSuccessRatePercent;
      if (rollOperatorEnhance(ctx, chance)) {
        const gain = isEffectiveTagOpen(ctx, user, "LIMITBREAK_KEEP_LEVEL") ? Number(source.mainSkill.level || 1) : 1;
        nextMainSkillLevel = Math.min(getOperatorSkillMaxLevel(targetMainSkill), nextMainSkillLevel + Math.max(1, gain));
      }
    }
    if (request.transSkill) {
      if (rollOperatorEnhance(ctx, rates.transportSuccessRatePercent)) {
        nextSubSkillId = Number(source.subSkill.id);
        nextSubSkillLevel = 1;
      }
    } else if (canSub && rollOperatorEnhance(ctx, rates.levelUpSuccessRatePercent)) {
      nextSubSkillLevel = Math.min(getOperatorSkillMaxLevel(targetSubSkill), nextSubSkillLevel + 1);
    }

    const updated = enhanceOperator(user, request.operatorUid, sourceUid, {
      nextMainSkillLevel,
      nextSubSkillId,
      nextSubSkillLevel,
    });
    if (!updated) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
    const costs = mergeItemAmounts(resourceSpends);
    return operatorEnhanceResult(ERROR_CODES.OK, updated, spendShipLevelUpCosts(user, costs), costs);
  }

  const token = getOperatorPassiveToken(tokenItemId);
  if (!token || !getOperatorSkillTemplet(token.skillId)) {
    return operatorEnhanceResult(ERROR_CODES.OPERATOR_ENHANCE_TOKEN_INVALID_ITEM_ID);
  }
  const canSub = Number(target.subSkill.id) === token.skillId &&
    nextSubSkillLevel < getOperatorSkillMaxLevel(targetSubSkill);
  const canTransfer = Number(target.subSkill.id) !== token.skillId &&
    operatorGradeRank(token.itemGrade) >= operatorGradeRank(targetTemplet.m_NKM_UNIT_GRADE);
  if (request.transSkill ? !canTransfer : !canSub) {
    return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
  }
  if (!hasEnoughMiscItem(user, enhanceCost.itemId, enhanceCost.count) || !hasEnoughMiscItem(user, tokenItemId, 1)) {
    return operatorEnhanceResult(ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL);
  }
  if (request.transSkill) {
    if (rollOperatorEnhance(ctx, token.transportSuccessRatePercent)) {
      nextSubSkillId = token.skillId;
      nextSubSkillLevel = 1;
    }
  } else if (rollOperatorEnhance(ctx, token.levelUpSuccessRatePercent)) {
    nextSubSkillLevel = Math.min(getOperatorSkillMaxLevel(targetSubSkill), nextSubSkillLevel + 1);
  }

  resourceSpends.push({ itemId: tokenItemId, count: 1 });
  const updated = enhanceOperator(user, request.operatorUid, 0, {
    nextMainSkillLevel,
    nextSubSkillId,
    nextSubSkillLevel,
    consumeSource: false,
  });
  if (!updated) return operatorEnhanceResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
  const costs = mergeItemAmounts(resourceSpends);
  return operatorEnhanceResult(ERROR_CODES.OK, updated, spendShipLevelUpCosts(user, costs), costs);
}

function isOperatorTemplet(templet) {
  return Boolean(templet) && String(templet.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR";
}

function getOperatorSkillMaxLevel(skillTemplet) {
  return Math.max(1, Math.trunc(Number(skillTemplet && skillTemplet.m_MaxSkillLevel) || 1));
}

function operatorGradeRank(grade) {
  const normalized = String(grade || "").toUpperCase().replace(/^NI[GM]_/, "").replace(/^NUG_/, "");
  return { N: 0, R: 1, SR: 2, SSR: 3 }[normalized] ?? -1;
}

function rollOperatorEnhance(ctx, chance) {
  const percent = Math.max(0, Math.min(100, Math.trunc(Number(chance) || 0)));
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const roll = ctx && typeof ctx.randomInt === "function" ? Number(ctx.randomInt(100)) : cryptoRandomInt(100);
  return Math.max(0, Math.trunc(roll)) % 100 < percent;
}

function operatorEnhanceResult(errorCode, operator = null, costItems = [], resourceSpends = []) {
  return { errorCode, operator, costItems, resourceSpends };
}

function handleOperatorLock(_ctx, user, request) {
  const operator = request.valid ? getArmyOperatorByUid(user, request.operatorUid) : null;
  if (!operator) {
    return response(
      PACKETS.OPERATOR_LOCK_ACK,
      [writeSignedVarInt(ERROR_CODES.OPERATOR_INVALID_UNIT_UID), writeSignedVarLong(request.operatorUid || 0n), writeBool(Boolean(request.locked))],
      { persist: false }
    );
  }
  const changed = Boolean(operator.locked) !== Boolean(request.locked);
  if (changed) setOperatorLock(user, request.operatorUid, request.locked);
  return response(
    PACKETS.OPERATOR_LOCK_ACK,
    [ok(), writeSignedVarLong(request.operatorUid), writeBool(Boolean(request.locked))],
    { persist: changed }
  );
}

function handleOperatorRemove(_ctx, user, request) {
  const operatorUids = validateRemovalUidList({ valid: request.valid, unitUids: request.operatorUids });
  if (!operatorUids) return removalResponse(PACKETS.OPERATOR_REMOVE_ACK, removalResult(ERROR_CODES.INVALID_REQUEST));
  return removalResponse(PACKETS.OPERATOR_REMOVE_ACK, dismissOperators(user, operatorUids));
}

function handleRecallUnit(ctx, user, request) {
  const result = recallUnit(ctx, user, request);
  return response(PACKETS.RECALL_UNIT_ACK, [
    writeSignedVarInt(result.errorCode),
    writeSignedVarLong(result.removeUnitUid),
    writeNullableObjectList(result.exchangeUnits.map(buildUnitData)),
    result.history ? writeNullableObject(buildRecallHistoryInfo(result.history.unitId, result.history.lastUpdateDate)) : writeNullObject(),
    writeNullableObjectList(result.rewardItems.map(buildItemMiscData)),
  ], {
    persist: result.errorCode === ERROR_CODES.OK,
    invalidateLobby: result.errorCode === ERROR_CODES.OK ? "unit-recall" : undefined,
  });
}

function recallUnit(ctx, user, request = {}) {
  if (!request.valid || toBigInt(request.unitUid || 0) <= 0n) return recallResult(ERROR_CODES.INVALID_REQUEST);
  const source = getArmyUnitByUid(user, request.unitUid);
  if (!source) return recallResult(ERROR_CODES.UNIT_NOT_EXIST);

  const sourceTemplet = getUnitTemplet(source.unitId);
  const kind = getArmyUnitStorageKind(user, request.unitUid);
  const unitType = String(sourceTemplet && sourceTemplet.m_NKM_UNIT_TYPE || "");
  if (!sourceTemplet || !["NUT_NORMAL", "NUT_SHIP"].includes(unitType)) {
    return recallResult(ERROR_CODES.RECALL_NOT_AVAILABLE);
  }
  if ((unitType === "NUT_NORMAL" && kind !== "unit") || (unitType === "NUT_SHIP" && kind !== "ship")) {
    return recallResult(ERROR_CODES.RECALL_NOT_AVAILABLE);
  }

  const historyUnitId = unitType === "NUT_SHIP" ? getFirstLevelShipId(source.unitId) : Number(source.unitId);
  if (unitType === "NUT_SHIP" && historyUnitId <= 0) return recallResult(ERROR_CODES.RECALL_SHIP_INVALID_ID);
  const now = getRecallNow(ctx);
  const recallTemplets = getRecallTemplets(historyUnitId);
  if (recallTemplets.length === 0) return recallResult(ERROR_CODES.RECALL_NOT_AVAILABLE);
  const recallTemplet = getActiveRecallTemplet(historyUnitId, now);
  if (!recallTemplet) return recallResult(ERROR_CODES.RECALL_PERIOD_EXPIRED);

  const history = user && user.recallHistory && typeof user.recallHistory === "object"
    ? user.recallHistory[String(historyUnitId)]
    : null;
  if (history && isDateInRecallWindow(dateFromDateTime(history.lastUpdateDate), recallTemplet)) {
    return recallResult(ERROR_CODES.RECALL_ALREADY_USED);
  }
  const acquiredAt = dateFromDateTime(source.regDate);
  if (!acquiredAt || isDateInRecallWindow(acquiredAt, recallTemplet)) {
    return recallResult(ERROR_CODES.RECALL_INVALID_ACQUIRE_TIME);
  }
  if (source.isSeized) {
    return recallResult(unitType === "NUT_SHIP" ? ERROR_CODES.SHIP_IS_SEIZED : ERROR_CODES.UNIT_IS_SEIZED);
  }
  const stateError = getDismissUnitError(user, source, request.unitUid, kind);
  if (stateError !== ERROR_CODES.OK) {
    return recallResult(stateError === ERROR_CODES.UNIT_EQUIP_ITEM ? ERROR_CODES.RECALL_UNIT_UNEQUIP_ITEM : stateError);
  }

  const exchanges = validateRecallExchanges(ctx, user, source, recallTemplet, request.exchangeUnits);
  if (!exchanges) return recallResult(ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);
  const rewardAmounts = unitType === "NUT_SHIP"
    ? collectShipRecallRewards(source)
    : collectNormalRecallRewards(ctx, user, source, sourceTemplet, recallTemplet);
  const historyAt = getRecallDateTimeBinary(ctx, now);

  removeArmyUnitUids(user, [request.unitUid]);
  const exchangeUnits = [];
  for (const exchange of exchanges) {
    for (let index = 0; index < exchange.count; index += 1) {
      const granted = grantUnit(user, exchange.unitId, unitType === "NUT_SHIP"
        ? {
            level: Number(source.level || 1),
            exp: Number(source.exp || 0),
            limitBreakLevel: Number(source.limitBreakLevel || 0),
            fromContract: isFromContract(source),
            shipCommandModules: source.shipCommandModules,
            regDate: historyAt,
          }
        : { level: 1, limitBreakLevel: 0, fromContract: true, regDate: historyAt });
      if (granted) exchangeUnits.push(granted);
    }
  }
  const rewardItems = grantRewardItems(user, rewardAmounts);
  const nextHistory = { unitId: historyUnitId, lastUpdateDate: String(historyAt) };
  ensureRecallHistory(user)[String(historyUnitId)] = nextHistory;
  return recallResult(ERROR_CODES.OK, request.unitUid, exchangeUnits, nextHistory, rewardItems);
}

function validateRecallExchanges(ctx, user, source, recallTemplet, values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 7) return null;
  const unitType = String(recallTemplet.m_NKM_UNIT_TYPE || "");
  const expectedCount = unitType === "NUT_SHIP"
    ? 1
    : String(recallTemplet.RecallItemCondition || "") === "TACTIC_UPDATE"
      ? 1
      : Math.min(7, Math.max(1, Math.trunc(Number(source.tacticLevel || 0)) + 1));
  const allowedIds = new Set(getRecallTargetUnitIds(ctx, user, source, recallTemplet));
  const seen = new Set();
  const result = [];
  let total = 0;
  for (const value of values) {
    const unitId = Number(value && value.unitId);
    const count = Number(value && value.count);
    if (!Number.isInteger(unitId) || unitId <= 0 || !Number.isInteger(count) || count <= 0 || count > expectedCount) return null;
    if (seen.has(unitId) || !allowedIds.has(unitId)) return null;
    const templet = getUnitTemplet(unitId);
    if (!templet || String(templet.m_NKM_UNIT_TYPE || "") !== unitType || templet.m_bMonster === true) return null;
    seen.add(unitId);
    total += count;
    result.push({ unitId, count });
  }
  return total === expectedCount ? result : null;
}

function getRecallTargetUnitIds(ctx, user, source, recallTemplet) {
  const baseIds = getRecallExchangeUnitIds(recallTemplet.UnitExchangeGroupID);
  if (String(recallTemplet.m_NKM_UNIT_TYPE || "") !== "NUT_SHIP") return baseIds;
  const sourceText = String(source.unitId || "");
  if (sourceText.length < 2) return [];
  const result = [];
  for (const baseId of baseIds) {
    const baseTemplet = getUnitTemplet(baseId);
    if (!baseTemplet || !isEffectiveTagOpen(ctx, user, baseTemplet.m_FirstOpenTag)) continue;
    const chars = String(baseId).split("");
    if (chars.length < 2) continue;
    chars[1] = sourceText[1];
    const targetId = Number(chars.join(""));
    const target = getUnitTemplet(targetId);
    if (target && String(target.m_NKM_UNIT_TYPE || "") === "NUT_SHIP") result.push(targetId);
  }
  return result;
}

function collectNormalRecallRewards(ctx, user, source, templet, recallTemplet) {
  const rewards = [];
  let totalExp = getTotalExpForUnitLevel(source.level) + Math.max(0, Math.trunc(Number(source.exp || 0)));
  if (Number(templet.m_BaseUnitID || 0) > 0 && Number(templet.m_BaseUnitID) !== Number(templet.m_UnitID)) {
    totalExp += getTotalExpForUnitLevel(110);
  }
  if (totalExp > 0) {
    const material = Object.entries(UNIT_NEGOTIATION_MATERIALS)
      .map(([itemId, data]) => ({ itemId: Number(itemId), ...data }))
      .sort((left, right) => right.exp - left.exp)[0];
    const count = Math.ceil(totalExp / material.exp);
    rewards.push({ itemId: material.itemId, count }, { itemId: 1, count: material.credit * count });
  }

  for (let rank = Math.max(0, Math.trunc(Number(source.limitBreakLevel || 0))); rank > 0; rank -= 1) {
    const info = getLimitBreakInfo(rank);
    const substitute = getUnitLimitBreakSubstituteRecord(source.unitId, rank);
    if (!info || !substitute) continue;
    const requirement = Math.max(0, Math.trunc(Number(info.m_iUnitRequirement || 0)));
    for (let index = 1; index <= 2; index += 1) {
      const itemId = Number(substitute[`m_ItemID_${index}`] || 0);
      const count = Math.max(0, Math.trunc(Number(substitute[`m_ItemCount_${index}`] || 0))) * requirement;
      if (itemId > 0 && count > 0) rewards.push({ itemId, count });
    }
    const credit = Math.max(0, Math.trunc(Number(substitute.m_CreditReq || 0)));
    if (credit > 0) rewards.push({ itemId: 1, count: credit });
  }

  let pieceCount = 0;
  const skillLevels = Array.isArray(source.skillLevels) ? source.skillLevels : [];
  for (let index = 1; index <= 5; index += 1) {
    const skillStrId = String(templet[`m_SkillStrID${index}`] || "");
    for (let level = Math.max(1, Math.trunc(Number(skillLevels[index - 1] || 1))); skillStrId && level > 1; level -= 1) {
      for (const cost of getUnitSkillUpgradeCosts(skillStrId, level) || []) {
        const item = getMiscItemTemplet(cost.itemId);
        if (String(item && item.m_ItemMiscType || "") === "IMT_PIECE") pieceCount += cost.count;
        else rewards.push(cost);
      }
    }
  }
  if (pieceCount > 0) rewards.push({ itemId: 401, count: Math.ceil(pieceCount * getRecallRewardUnitPieceToPoint()) });
  if (source.isPermanentContract) rewards.push({ itemId: PERMANENT_CONTRACT_DOCUMENT_ID, count: 1 });

  const reactor = getUnitReactorTemplet(templet);
  for (let level = 1; reactor && level <= Math.max(0, Math.trunc(Number(source.reactorLevel || 0))); level += 1) {
    const skill = getReactorSkillTemplet(Number(reactor[`Level${level}`] || 0));
    for (let index = 1; skill && index <= 4; index += 1) {
      const itemId = Number(skill[`LevelUpReqItemID_${index}`] || 0);
      const count = Math.max(0, Math.trunc(Number(skill[`LevelUpReqItemValue_${index}`] || 0)));
      if (itemId > 0 && count > 0) rewards.push({ itemId, count });
    }
  }
  rewards.push(...getUnitRearmamentCosts(templet));

  if (isEffectiveTagOpen(ctx, user, templet.m_BasicOpenTag) && Number(source.tacticLevel || 0) > 0) {
    const condition = String(recallTemplet.RecallItemCondition || "");
    const count = condition === "TACTIC_UPDATE" ? Math.trunc(Number(source.tacticLevel)) : condition === "DEFAULT" ? 1 : 0;
    const itemId = Number(recallTemplet.RecallItemID || 0);
    const quantity = Math.max(0, Math.trunc(Number(recallTemplet.RecallItemQuantity || 0)));
    if (itemId > 0 && quantity > 0 && count > 0) rewards.push({ itemId, count: quantity * count });
  }
  return mergeItemAmounts(rewards);
}

function collectShipRecallRewards(source) {
  const rewards = [];
  for (let shipId = Number(source.unitId); getShipBuildTemplet(shipId); shipId -= 1000) {
    rewards.push(...(getShipUpgradeCosts(shipId) || []));
  }
  rewards.push(...getShipLevelUpCosts(source, 1, source.level, { limitBreakLevel: source.limitBreakLevel }));
  for (let rank = 1; rank <= Math.max(0, Math.trunc(Number(source.limitBreakLevel || 0))); rank += 1) {
    const limitBreak = getShipLimitBreakTemplet(source.unitId, rank);
    if (!limitBreak) continue;
    rewards.push(...(getShipLimitBreakCosts(limitBreak) || []));
    const materialIds = Array.isArray(limitBreak.ListMaterialShipID) ? limitBreak.ListMaterialShipID : [];
    const materialId = materialIds.map(Number).filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b)[0];
    if (materialId) rewards.push(...(getShipBuildCosts(getFirstLevelShipId(materialId)) || []));
  }
  return mergeItemAmounts(rewards);
}

function ensureRecallHistory(user) {
  if (!user.recallHistory || typeof user.recallHistory !== "object" || Array.isArray(user.recallHistory)) user.recallHistory = {};
  return user.recallHistory;
}

function getRecallNow(ctx) {
  const value = ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : null;
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
}

function getRecallDateTimeBinary(ctx, now) {
  if (ctx && typeof ctx.dateTimeBinaryNow === "function") {
    const value = toBigInt(ctx.dateTimeBinaryNow());
    if (value > 0n) return value;
  }
  return dateTimeBinaryForDate(now);
}

function isDateInRecallWindow(date, recallTemplet) {
  return date instanceof Date && !Number.isNaN(date.getTime()) && date >= recallTemplet.startDate && date < recallTemplet.endDate;
}

function recallResult(errorCode, removeUnitUid = 0n, exchangeUnits = [], history = null, rewardItems = []) {
  return { errorCode, removeUnitUid, exchangeUnits, history, rewardItems };
}

function handleExtractUnit(ctx, user, request) {
  const result = extractUnits(ctx, user, request);
  return response(PACKETS.EXTRACT_UNIT_ACK, [
    writeSignedVarInt(result.errorCode),
    writeSignedVarLongList(result.unitUids),
    result.errorCode === ERROR_CODES.OK ? writeNullableObject(buildRewardData({ miscItems: result.rewardItems })) : writeNullObject(),
    result.synergyItems.length > 0 ? writeNullableObject(buildRewardData({ miscItems: result.synergyItems })) : writeNullObject(),
  ], {
    persist: result.errorCode === ERROR_CODES.OK,
    invalidateLobby: result.errorCode === ERROR_CODES.OK ? "unit-extract" : undefined,
  });
}

function extractUnits(ctx, user, request = {}) {
  const config = getUnitExtractConfig();
  const unitUids = validateExtractUidList(request, config.maxUnitSelect);
  if (!unitUids) return unitExtractResult(ERROR_CODES.INVALID_REQUEST);
  if (!isEffectiveTagOpen(ctx, user, "REARMAMENT_EXTRACT")) {
    return unitExtractResult(ERROR_CODES.OPENTAG_CLOSED);
  }

  const targets = [];
  for (const uid of unitUids) {
    const unit = getArmyUnitByUid(user, uid);
    if (!unit) return unitExtractResult(ERROR_CODES.UNIT_NOT_EXIST);
    if (getArmyUnitStorageKind(user, uid) !== "unit") return unitExtractResult(ERROR_CODES.EXTRACT_UNIT_CONDITION);
    const templet = getUnitTemplet(unit.unitId);
    if (!isUnitExtractTemplet(templet)) return unitExtractResult(ERROR_CODES.EXTRACT_UNIT_CONDITION);
    if (getUnitExtractRewards(unit.unitId, { fromContract: isFromContract(unit) }).length === 0) {
      return unitExtractResult(ERROR_CODES.CANNOT_EXTRACT_UNIT);
    }
    if (unit.isSeized) return unitExtractResult(ERROR_CODES.UNIT_IS_SEIZED);
    const stateError = getDismissUnitError(user, unit, uid, "unit");
    if (stateError !== ERROR_CODES.OK) return unitExtractResult(stateError);
    targets.push({ unit, templet });
  }

  const baseRewards = mergeItemAmounts(targets.flatMap(({ unit }) =>
    getUnitExtractRewards(unit.unitId, { fromContract: isFromContract(unit) })
  ));
  const synergyReward = rollUnitExtractSynergy(ctx, targets, config);
  const removed = removeArmyUnitUids(user, unitUids);
  return unitExtractResult(
    ERROR_CODES.OK,
    removed,
    grantRewardItems(user, baseRewards),
    synergyReward ? grantRewardItems(user, [synergyReward]) : []
  );
}

function validateExtractUidList(request, maxUnitSelect) {
  if (!request || request.valid !== true || !Array.isArray(request.unitUids)) return null;
  if (request.unitUids.length < 1 || request.unitUids.length > maxUnitSelect) return null;
  const result = request.unitUids.map((uid) => String(toBigInt(uid || 0)));
  return result.some((uid) => uid === "0") || new Set(result).size !== result.length ? null : result;
}

function isUnitExtractTemplet(templet) {
  return Boolean(
    templet &&
    String(templet.m_NKM_UNIT_TYPE || "") === "NUT_NORMAL" &&
    templet.m_bMonster !== true &&
    String(templet.m_NKM_UNIT_STYLE_TYPE || "") !== "NUST_TRAINER" &&
    operatorGradeRank(templet.m_NKM_UNIT_GRADE) >= operatorGradeRank("NUG_SR")
  );
}

function rollUnitExtractSynergy(ctx, targets, config) {
  if (!hasUnitExtractSynergy(targets, config.maxUnitSelect)) return null;
  const chance = Math.min(100, targets.reduce((total, { templet }) => {
    if (templet.m_bAwaken === true) return total + config.awakenRatePercent;
    return total + (operatorGradeRank(templet.m_NKM_UNIT_GRADE) >= operatorGradeRank("NUG_SSR")
      ? config.ssrRatePercent
      : config.srRatePercent);
  }, 0));
  if (chance <= 0 || randomUnitExtractInt(ctx, 100) >= chance) return null;

  const rewards = getUnitExtractBonusRewards();
  const totalWeight = rewards.reduce((total, reward) => total + reward.weight, 0);
  if (totalWeight <= 0) return null;
  let roll = randomUnitExtractInt(ctx, totalWeight);
  for (const reward of rewards) {
    if (roll < reward.weight) return { itemId: reward.itemId, count: reward.count };
    roll -= reward.weight;
  }
  return null;
}

function hasUnitExtractSynergy(targets, maxUnitSelect) {
  if (!Array.isArray(targets) || targets.length !== maxUnitSelect) return false;
  const roles = targets.map(({ templet }) => String(templet.m_NKM_UNIT_ROLE_TYPE || ""));
  if (roles.some((role) => !role || role === "NURT_INVALID")) return false;
  const uniqueRoles = new Set(roles).size;
  return uniqueRoles === 1 || uniqueRoles === roles.length;
}

function randomUnitExtractInt(ctx, maxExclusive) {
  const max = Math.max(1, Math.trunc(Number(maxExclusive) || 1));
  const roll = ctx && typeof ctx.randomInt === "function" ? Number(ctx.randomInt(max)) : cryptoRandomInt(max);
  return Math.max(0, Math.trunc(roll)) % max;
}

function unitExtractResult(errorCode, unitUids = [], rewardItems = [], synergyItems = []) {
  return { errorCode, unitUids, rewardItems, synergyItems };
}

function handleRearmUnit(ctx, user, request) {
  const result = rearmamentUnit(ctx, user, request);
  return response(PACKETS.REARMAMENT_UNIT_ACK, [
    writeSignedVarInt(result.errorCode),
    nullableUnit(result.unit),
    writeNullableObjectList(result.costItems.map(buildItemMiscData)),
  ], {
    persist: result.errorCode === ERROR_CODES.OK,
    invalidateLobby: result.errorCode === ERROR_CODES.OK ? "unit-rearmament" : undefined,
  });
}

function rearmamentUnit(ctx, user, request = {}) {
  if (!request.valid || toBigInt(request.unitUid || 0) <= 0n || !Number.isInteger(Number(request.rearmamentId)) || Number(request.rearmamentId) <= 0) {
    return rearmamentResult(ERROR_CODES.INVALID_REQUEST);
  }
  if (!isEffectiveTagOpen(ctx, user, "REARMAMENT_BASE")) return rearmamentResult(ERROR_CODES.OPENTAG_CLOSED);

  const templet = getUnitRearmamentTemplet(request.rearmamentId);
  if (
    !templet ||
    Number(templet.m_RearmID || 0) !== Number(request.rearmamentId) ||
    Number(templet.m_RearmUnitID || 0) !== Number(request.rearmamentId) ||
    !isEffectiveTagOpen(ctx, user, templet.m_OpenTag)
  ) {
    return rearmamentResult(ERROR_CODES.REARMAMENT_INVALID_ID);
  }

  const unit = getArmyUnitByUid(user, request.unitUid);
  const sourceTemplet = getUnitTemplet(unit && unit.unitId);
  if (!unit || getArmyUnitStorageKind(user, request.unitUid) !== "unit" || !sourceTemplet) {
    return rearmamentResult(ERROR_CODES.UNIT_NOT_EXIST);
  }
  if (
    String(sourceTemplet.m_NKM_UNIT_TYPE || "") !== "NUT_NORMAL" ||
    Number(unit.unitId || 0) !== Number(templet.m_RearmTargetUnitID || 0) ||
    Number(sourceTemplet.m_BaseUnitID || sourceTemplet.m_UnitID || 0) !== Number(templet.m_BaseUnitID || 0)
  ) {
    return rearmamentResult(ERROR_CODES.REARMAMENT_INVALID_ID);
  }
  if (unit.isSeized) return rearmamentResult(ERROR_CODES.UNIT_IS_SEIZED);
  if (getLimitBreakMaxLevel(unit.limitBreakLevel, 100) < 110) {
    return rearmamentResult(ERROR_CODES.REARMAMENT_CONDITION_LIMITBREAK);
  }
  if (Number(unit.level || 1) < 110) return rearmamentResult(ERROR_CODES.REARMAMENT_CONDITION_LEVEL);
  if (hasEquippedItems(unit)) return rearmamentResult(ERROR_CODES.UNIT_EQUIP_ITEM);

  const costs = getUnitRearmamentCosts(templet);
  if (!costs.length || !costs.every((cost) => hasEnoughMiscItem(user, cost.itemId, cost.count))) {
    return rearmamentResult(ERROR_CODES.INSUFFICIENT_ITEM);
  }

  const costItems = costs.map((cost) => spendMiscItem(user, cost.itemId, cost.count));
  const rearmed = rearmUnit(user, request.unitUid, request.rearmamentId);
  if (!rearmed || Number(rearmed.unitId || 0) !== Number(request.rearmamentId)) {
    throw new Error(`unit rearmament commit failed uid=${request.unitUid} target=${request.rearmamentId}`);
  }
  request.resourceSpends = costs;
  return rearmamentResult(ERROR_CODES.OK, rearmed, costItems);
}

function rearmamentResult(errorCode, unit = null, costItems = []) {
  return { errorCode, unit, costItems: costItems.filter(Boolean) };
}

function handleFavoriteUnit(_ctx, user, request) {
  const unit = request.valid ? getArmyUnitByUid(user, request.unitUid) : null;
  if (!unit) {
    return response(
      PACKETS.FAVORITE_UNIT_ACK,
      [writeSignedVarInt(ERROR_CODES.UNIT_NOT_EXIST), writeSignedVarLong(request.unitUid || 0n), writeBool(Boolean(request.favorite))],
      { persist: false }
    );
  }
  const changed = Boolean(unit.isFavorite) !== Boolean(request.favorite);
  if (changed) setUnitFavorite(user, request.unitUid, request.favorite);
  return response(
    PACKETS.FAVORITE_UNIT_ACK,
    [ok(), writeSignedVarLong(request.unitUid), writeBool(Boolean(request.favorite))],
    { persist: changed }
  );
}

function handleLimitBreakShip(ctx, user, request) {
  const result = limitBreakPhysicalShip(ctx, user, request);
  if (result.errorCode === ERROR_CODES.OK) request.resourceSpends = result.resourceSpends;
  return response(
    PACKETS.LIMIT_BREAK_SHIP_ACK,
    [
      writeSignedVarInt(result.errorCode),
      nullableUnit(result.ship),
      writeSignedVarLong(request.consumeShipUid || 0n),
      writeNullableObjectList(result.costItems.map(buildItemMiscData)),
    ],
    {
      persist: result.errorCode === ERROR_CODES.OK,
      invalidateLobby: result.errorCode === ERROR_CODES.OK ? "ship-limitbreak" : undefined,
    }
  );
}

function limitBreakPhysicalShip(ctx, user, request = {}) {
  const target = request.valid ? getPhysicalShipByUid(user, request.shipUid) : null;
  if (!target) return shipLimitBreakResult(ERROR_CODES.SHIP_NOT_EXISTS);
  if (target.isSeized) return shipLimitBreakResult(ERROR_CODES.SHIP_IS_SEIZED);

  const targetDeckError = shipDeckError(user, request.shipUid);
  if (targetDeckError === ERROR_CODES.WARFARE_DOING || targetDeckError === ERROR_CODES.DIVE_DOING) {
    return shipLimitBreakResult(targetDeckError);
  }

  const consumeUid = toBigInt(request.consumeShipUid || 0);
  if (consumeUid < 0n) return shipLimitBreakResult(ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);

  const targetTemplet = getUnitTemplet(target.unitId);
  if (!targetTemplet) return shipLimitBreakResult(ERROR_CODES.GET_UNIT_BASE_TEMPLET_NULL);
  const targetForMax = {
    ...target,
    starGrade: Number(targetTemplet.m_StarGradeMax || targetTemplet.m_StarGrade || 0),
    grade: targetTemplet.m_NKM_UNIT_GRADE,
  };
  if (Number(target.level || 1) < getShipMaxLevel(targetForMax)) {
    return shipLimitBreakResult(ERROR_CODES.SHIP_REMODEL_NOT_ENOUGH_LEVEL);
  }

  const consumed = getPhysicalShipByUid(user, consumeUid);
  if (!consumed || consumeUid === toBigInt(target.unitUid || 0)) {
    return shipLimitBreakResult(ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
  }
  if (isRosterEntryLocked(consumed)) {
    return shipLimitBreakResult(ERROR_CODES.SHIP_LIMITBREAK_LOCKED_CONSUMED_SHIP);
  }

  const nextGrade = Math.max(0, Math.trunc(Number(target.limitBreakLevel || 0))) + 1;
  const limitBreakTemplet = isEffectiveTagOpen(ctx, user, "SHIP_LIMITBREAK")
    ? getShipLimitBreakTemplet(target.unitId, nextGrade)
    : null;
  if (!limitBreakTemplet) return shipLimitBreakResult(ERROR_CODES.SHIP_LIMITBREAK_TEMPLET);

  const allowedShipIds = Array.isArray(limitBreakTemplet.ListMaterialShipID)
    ? limitBreakTemplet.ListMaterialShipID.map(Number)
    : [];
  if (!allowedShipIds.includes(Number(consumed.unitId))) {
    return shipLimitBreakResult(ERROR_CODES.SHIP_LIMITBREAK_INVALID_CONSUMED_SHIP);
  }

  const costs = getShipLimitBreakCosts(limitBreakTemplet) || [];
  if (!hasEnoughShipLevelUpItems(user, costs)) return shipLimitBreakResult(ERROR_CODES.INSUFFICIENT_ITEM);

  const costItems = spendShipLevelUpCosts(user, costs);
  const ship = limitBreakShip(user, target.unitUid, consumed.unitUid, { nextLimitBreakLevel: nextGrade });
  if (!ship) return shipLimitBreakResult(ERROR_CODES.SHIP_LIMITBREAK_TEMPLET);
  return shipLimitBreakResult(ERROR_CODES.OK, ship, costItems, costs);
}

function shipLimitBreakResult(errorCode, ship = null, costItems = [], resourceSpends = []) {
  return { errorCode, ship, costItems, resourceSpends };
}

function handleTacticUpdate(ctx, user, request) {
  const result = updateUnitTactic(ctx, user, request);
  return response(PACKETS.UNIT_TACTIC_UPDATE_ACK, [
    writeSignedVarInt(result.errorCode),
    nullableUnit(result.unit),
    writeSignedVarLongList(result.consumeUnitUids),
  ], {
    persist: result.errorCode === ERROR_CODES.OK,
    invalidateLobby: result.errorCode === ERROR_CODES.OK ? "tactic-update" : undefined,
  });
}

function updateUnitTactic(ctx, user, request = {}) {
  const targetUid = toBigInt(request.unitUid || 0);
  const consumeValues = Array.isArray(request.consumeUnitUids) ? request.consumeUnitUids : [];
  if (!request.valid || targetUid <= 0n || consumeValues.length <= 0) return tacticResult(ERROR_CODES.INVALID_REQUEST);

  const target = getArmyUnitByUid(user, targetUid);
  if (!target) return tacticResult(ERROR_CODES.UNIT_NOT_EXIST);
  const targetTemplet = getUnitTemplet(target.unitId);
  if (getArmyUnitStorageKind(user, targetUid) !== "unit" || !isTacticUnitTemplet(targetTemplet)) {
    return tacticResult(ERROR_CODES.UNIT_BAD_TYPE);
  }
  const currentTacticLevel = Math.max(0, Math.trunc(Number(target.tacticLevel) || 0));
  if (currentTacticLevel >= 6) return tacticResult(ERROR_CODES.TACTIC_ALREADY_MAX_LEVEL);
  if (target.isSeized) return tacticResult(ERROR_CODES.TACTIC_NOT_AVAILABLE);
  if (consumeValues.length > 6 - currentTacticLevel) return tacticResult(ERROR_CODES.INVALID_REQUEST);

  const targetKey = targetUid.toString();
  const consumeKeys = [];
  const seen = new Set();
  for (const rawUid of consumeValues) {
    const consumeUid = toBigInt(rawUid || 0);
    const key = consumeUid.toString();
    if (consumeUid <= 0n || key === targetKey || seen.has(key)) return tacticResult(ERROR_CODES.INVALID_REQUEST);
    seen.add(key);
    const consumeUnit = getArmyUnitByUid(user, consumeUid);
    if (!consumeUnit) return tacticResult(ERROR_CODES.UNIT_NOT_EXIST);
    const consumeTemplet = getUnitTemplet(consumeUnit.unitId);
    if (getArmyUnitStorageKind(user, consumeUid) !== "unit" || !isTacticUnitTemplet(consumeTemplet)) {
      return tacticResult(ERROR_CODES.TACTIC_INVALID_BASE_UNIT);
    }
    if (!isSameBaseUnit(targetTemplet, consumeTemplet)) return tacticResult(ERROR_CODES.TACTIC_INVALID_BASE_UNIT);
    if (consumeUnit.isSeized) return tacticResult(ERROR_CODES.TACTIC_NOT_AVAILABLE);
    const statusError = getTacticConsumeStatusError(user, consumeUnit, key);
    if (statusError !== ERROR_CODES.OK) return tacticResult(statusError);
    consumeKeys.push(key);
  }

  const preserveGrowth = hasOpenTag(user, "LIMITBREAK_KEEP_LEVEL") || hasEffectiveOpenTag(ctx, user, "LIMITBREAK_KEEP_LEVEL");
  const unit = tacticUpdateUnit(user, targetKey, consumeKeys, { preserveGrowth });
  return unit ? tacticResult(ERROR_CODES.OK, unit, consumeKeys) : tacticResult(ERROR_CODES.TACTIC_NOT_AVAILABLE);
}

function isTacticUnitTemplet(templet) {
  return Boolean(
    templet &&
    String(templet.m_NKM_UNIT_TYPE || "") === "NUT_NORMAL" &&
    templet.m_bMonster !== true &&
    String(templet.m_NKM_UNIT_STYLE_TYPE || "") !== "NUST_TRAINER"
  );
}

function hasEffectiveOpenTag(ctx, user, requiredTag) {
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return false;
  const expected = String(requiredTag || "").toUpperCase();
  const tags = ctx.getEffectiveOpenTags(Array.isArray(user && user.openTags) ? user.openTags : []);
  return Array.isArray(tags) && tags.some((tag) => String(tag || "").toUpperCase() === expected);
}

function isSameBaseUnit(source, target) {
  if (!source || !target) return false;
  const sourceId = Number(source.m_UnitID || 0);
  const targetId = Number(target.m_UnitID || 0);
  if (sourceId === targetId) return true;
  const sourceBaseId = Number(source.m_BaseUnitID || 0);
  const targetBaseId = Number(target.m_BaseUnitID || 0);
  return (
    (sourceBaseId > 0 && sourceBaseId === targetId) ||
    (targetBaseId > 0 && targetBaseId === sourceId) ||
    (sourceBaseId > 0 && sourceBaseId === targetBaseId)
  );
}

function getTacticConsumeStatusError(user, unit, uid) {
  if (isRosterEntryLocked(unit)) return ERROR_CODES.UNIT_LOCKED;
  if (isUidInLobbyBackground(user, uid)) return ERROR_CODES.UNIT_IS_LOBBY_UNIT;
  if (isUidInDeck(user, uid, "unit")) return ERROR_CODES.UNIT_IN_DECK;
  if (hasEquippedItems(unit)) return ERROR_CODES.UNIT_EQUIP_ITEM;
  if (isUidWorldMapLeader(user, uid)) return ERROR_CODES.UNIT_IS_WORLDMAP_LEADER;
  if (isUidInOffice(user, unit, uid)) return ERROR_CODES.OFFICE_UNIT_DELETE_IN_ROOM;
  if (isUidSupportUnit(user, uid)) return ERROR_CODES.CONTAIN_SUPPORT_UNIT;
  return ERROR_CODES.OK;
}

function tacticResult(errorCode, unit = null, consumeUnitUids = []) {
  return { errorCode, unit, consumeUnitUids };
}

function handleReactorLevelUp(ctx, user, request) {
  const result = levelUpUnitReactor(ctx, user, request);
  if (result.errorCode !== ERROR_CODES.OK) return reactorResponse(result, { persist: false });
  request.unitId = result.unit.unitId;
  request.resourceSpends = result.resourceSpends;
  return reactorResponse(result, { invalidateLobby: "unit-reactor-levelup" });
}

function levelUpUnitReactor(ctx, user, request = {}) {
  if (!request.valid || toBigInt(request.unitUid || 0) <= 0n) return reactorResult(ERROR_CODES.INVALID_REQUEST);
  const unit = getArmyUnitByUid(user, request.unitUid);
  if (!unit) return reactorResult(ERROR_CODES.REACTOR_INVALID_ID);

  const currentLevel = Number(unit.reactorLevel || 0);
  if (!Number.isInteger(currentLevel) || currentLevel < 0 || currentLevel > 5) {
    return reactorResult(ERROR_CODES.REACTOR_DB_INVALID_LEVEL);
  }

  const unitTemplet = getUnitTemplet(unit.unitId);
  const reactorTemplet = getUnitReactorTemplet(unitTemplet);
  if (
    !unitTemplet ||
    String(unitTemplet.m_NKM_UNIT_TYPE || "") !== "NUT_NORMAL" ||
    unitTemplet.m_bMonster === true ||
    String(unitTemplet.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER" ||
    Number(unitTemplet.m_RearmGrade || 0) > 0 ||
    !reactorTemplet
  ) {
    return reactorResult(ERROR_CODES.REACTOR_INVALID_TEMPLET);
  }

  const maxLevel = getReactorMaxLevel(reactorTemplet);
  if (currentLevel > maxLevel) return reactorResult(ERROR_CODES.REACTOR_DB_INVALID_LEVEL);
  if (currentLevel >= maxLevel) return reactorResult(ERROR_CODES.REACTOR_OVER_MAX_LEVEL);

  const skillId = Number(reactorTemplet[`Level${currentLevel + 1}`] || 0);
  const skillTemplet = getReactorSkillTemplet(skillId);
  if (!skillTemplet || Number(skillTemplet.ReactorID || 0) !== Number(reactorTemplet.ReactorID || 0)) {
    return reactorResult(ERROR_CODES.REACTOR_INVALID_SKILL_TEMPLET);
  }
  if (
    Number(unit.level || 0) < 110 ||
    unit.isSeized === true ||
    !isEffectiveTagOpen(ctx, user, "UNIT_REACTOR") ||
    !isEffectiveTagOpen(ctx, user, reactorTemplet.OpenTag) ||
    !isEffectiveTagOpen(ctx, user, skillTemplet.OpenTag)
  ) {
    return reactorResult(ERROR_CODES.REACTOR_NOT_AVAILABLE);
  }
  if (!hasMaximumBaseSkills(unit, unitTemplet)) {
    return reactorResult(ERROR_CODES.REACTOR_INVALID_SKILL_CONDITION);
  }

  const costs = getReactorLevelUpCosts(skillTemplet);
  if (!costs.length) return reactorResult(ERROR_CODES.REACTOR_INVALID_SKILL_TEMPLET);
  for (const cost of costs) {
    const item = getMiscItem(user, cost.itemId);
    if (toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0) < BigInt(cost.count)) {
      return reactorResult(ERROR_CODES.INSUFFICIENT_ITEM);
    }
  }

  const updatedUnit = reactorLevelUpUnit(user, unit.unitUid, { nextLevel: currentLevel + 1, maxLevel });
  if (!updatedUnit) return reactorResult(ERROR_CODES.REACTOR_DB_INVALID_LEVEL);
  const costItems = costs.map((cost) => spendMiscItem(user, cost.itemId, cost.count));
  return reactorResult(ERROR_CODES.OK, updatedUnit, costItems, costs);
}

function getReactorMaxLevel(reactorTemplet) {
  let level = 0;
  while (level < 5 && Number(reactorTemplet && reactorTemplet[`Level${level + 1}`] || 0) > 0) level += 1;
  return level;
}

function getReactorLevelUpCosts(skillTemplet) {
  const costs = [];
  for (let index = 1; index <= 3; index += 1) {
    const itemId = Number(skillTemplet && skillTemplet[`LevelUpReqItemID_${index}`] || 0);
    const count = Math.trunc(Number(skillTemplet && skillTemplet[`LevelUpReqItemValue_${index}`] || 0));
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return costs;
}

function hasMaximumBaseSkills(unit, unitTemplet) {
  const levels = Array.isArray(unit && unit.skillLevels) ? unit.skillLevels : [];
  const skillStrIds = [];
  for (let index = 1; index <= 5; index += 1) {
    const skillStrId = String(unitTemplet && unitTemplet[`m_SkillStrID${index}`] || "");
    if (skillStrId) skillStrIds.push(skillStrId);
  }
  return skillStrIds.length > 0 && skillStrIds.every((skillStrId, index) => {
    const maxLevel = getUnitSkillMaxLevelByStrId(skillStrId);
    return maxLevel > 0 && Number(levels[index] || 0) >= maxLevel;
  });
}

function isEffectiveTagOpen(ctx, user, requiredTag) {
  const tag = String(requiredTag || "");
  return !tag || hasOpenTag(user, tag) || hasEffectiveOpenTag(ctx, user, tag);
}

function reactorResult(errorCode, unit = null, costItems = [], resourceSpends = []) {
  return { errorCode, unit, costItems, resourceSpends };
}

function reactorResponse(result, options = {}) {
  return response(
    PACKETS.UNIT_REACTOR_LEVELUP_ACK,
    [
      writeSignedVarInt(result.errorCode),
      nullableUnit(result.unit),
      writeNullableObjectList((result.costItems || []).map(buildItemMiscData)),
    ],
    options
  );
}

function handleOperatorExtract(ctx, user, request) {
  const result = extractOperators(ctx, user, request);
  if (result.errorCode === ERROR_CODES.OK) request.resourceSpends = result.resourceSpends;
  return response(
    PACKETS.OPERATOR_EXTRACT_ACK,
    [
      writeSignedVarInt(result.errorCode),
      writeSignedVarLongList(result.operatorUids),
      writeNullableObjectList(result.costItems.map(buildItemMiscData)),
      writeNullableObjectList(result.rewardItems.map(buildItemMiscData)),
    ],
    {
      persist: result.errorCode === ERROR_CODES.OK,
      invalidateLobby: result.errorCode === ERROR_CODES.OK ? "operator-extract" : undefined,
    }
  );
}

function extractOperators(ctx, user, request = {}) {
  const operatorUids = validateRemovalUidList({ valid: request.valid, unitUids: request.operatorUids });
  if (!operatorUids) return operatorExtractResult(ERROR_CODES.INVALID_REQUEST);
  if (!isEffectiveTagOpen(ctx, user, "OPERATOR_EXTRACT")) {
    return operatorExtractResult(ERROR_CODES.OPENTAG_CLOSED);
  }

  const operators = [];
  const costs = [];
  const tokenRewards = [];
  for (const uid of operatorUids) {
    const operator = getArmyOperatorByUid(user, uid);
    if (!operator) return operatorExtractResult(ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
    const stateError = getDismissOperatorError(user, operator, uid);
    if (stateError !== ERROR_CODES.OK) return operatorExtractResult(stateError);
    const templet = getUnitTemplet(operator.id);
    if (!templet || String(templet.m_NKM_UNIT_TYPE || "") !== "NUT_OPERATOR") {
      return operatorExtractResult(ERROR_CODES.OPERATOR_EXTRACT_INVALID_DATA);
    }
    const subSkillId = Number(operator.subSkill && operator.subSkill.id || 0);
    const tokenItemId = getOperatorExtractTokenItemId(templet, subSkillId);
    if (subSkillId <= 0 || tokenItemId <= 0) {
      return operatorExtractResult(ERROR_CODES.OPERATOR_SKILL_TEMPLET_NOT_EXISTS);
    }
    const cost = getOperatorExtractPrice(templet);
    if (!cost) return operatorExtractResult(ERROR_CODES.OPERATOR_EXTRACT_INVALID_DATA);
    operators.push(operator);
    costs.push(cost);
    tokenRewards.push({ itemId: tokenItemId, count: 1 });
  }

  const mergedCosts = mergeItemAmounts(costs);
  for (const cost of mergedCosts) {
    const item = getMiscItem(user, cost.itemId);
    if (toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0) < BigInt(cost.count)) {
      return operatorExtractResult(ERROR_CODES.INSUFFICIENT_ITEM);
    }
  }

  const rewardAmounts = mergeItemAmounts([...collectRemoveRewards(operators), ...tokenRewards]);
  const costItems = mergedCosts.map((cost) => spendMiscItem(user, cost.itemId, cost.count));
  const removed = removeOperatorUids(user, operatorUids);
  const rewardItems = grantRewardItems(user, rewardAmounts);
  return operatorExtractResult(ERROR_CODES.OK, removed, costItems, rewardItems, mergedCosts);
}

function mergeItemAmounts(items) {
  const byItem = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const itemId = Number(item && item.itemId || 0);
    const count = Math.max(0, Math.trunc(Number(item && item.count || 0)));
    if (itemId > 0 && count > 0) byItem.set(itemId, (byItem.get(itemId) || 0) + count);
  }
  return Array.from(byItem.entries())
    .map(([itemId, count]) => ({ itemId, count }))
    .sort((left, right) => left.itemId - right.itemId);
}

function operatorExtractResult(errorCode, operatorUids = [], costItems = [], rewardItems = [], resourceSpends = []) {
  return { errorCode, operatorUids, costItems, rewardItems, resourceSpends };
}

function handleNegotiate(_ctx, user, request) {
  const currentUnit = getArmyUnitByUid(user, request.unitUid);
  const materials = normalizeMaterialList(request.materials, UNIT_NEGOTIATION_MATERIALS, {
    maxCount: NEGOTIATION_OPTIONS.MAX_MATERIAL_USAGE_LIMIT,
  });
  const selection = normalizeNegotiationSelection(request.negotiateBossSelection);
  const result = decideNegotiationResult(selection);
  const expGain = calculateNegotiationExpGain(currentUnit, materials, result);
  const finalSalary = currentUnit ? calculateNegotiationSalary(materials, selection) : 0;
  const costItems = currentUnit ? spendNegotiationCosts(user, materials, finalSalary) : [];
  const nextLoyalty = currentUnit ? calculateNegotiationLoyalty(currentUnit, materials, selection) : 10000;
  const unit = addUnitExp(user, request.unitUid, expGain, { loyalty: nextLoyalty }) || getArmyUnitByUid(user, request.unitUid);
  return response(PACKETS.NEGOTIATE_ACK, [
    ok(),
    writeSignedVarInt(result),
    writeSignedVarInt(finalSalary),
    writeSignedVarLong(request.unitUid),
    writeSignedVarInt(Number(unit && unit.level) || 1),
    writeSignedVarInt(Number(unit && unit.loyalty) || 10000),
    writeSignedVarInt(Number(unit && unit.exp) || 0),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
  ]);
}

function calculateNegotiationExpGain(unit, materials = [], result = NEGOTIATE_RESULT.COMPLETE) {
  let exp = calculateMaterialExp(materials, UNIT_NEGOTIATION_MATERIALS, 0);
  let bonusPercent = 0;
  if (unit && unit.isPermanentContract) {
    bonusPercent += NEGOTIATION_OPTIONS.PERMANENT_CONTRACT_EXP_BONUS_PERCENT;
  }
  if (result === NEGOTIATE_RESULT.SUCCESS) {
    bonusPercent += NEGOTIATION_OPTIONS.SUCCESS_ADDITIONAL_EXP_PERCENT;
  }
  if (bonusPercent > 0) exp = Math.floor((exp * (100 + bonusPercent)) / 100);
  return Math.max(0, exp);
}

function calculateMaterialExp(materials, table, fallbackPerItem) {
  if (!Array.isArray(materials)) return 0;
  const normalized = normalizeMaterialList(materials, table);
  return normalized.reduce((total, item) => {
    const itemId = Number(item && item.itemId);
    const count = Math.max(0, Number(item && item.count) || 0);
    const entry = table[itemId];
    return total + Math.max(0, Number(entry && entry.exp) || fallbackPerItem || 0) * count;
  }, 0);
}

function calculateNegotiationSalary(materials, selection = NEGOTIATE_BOSS_SELECTION.OK) {
  const baseSalary = normalizeMaterialList(materials, UNIT_NEGOTIATION_MATERIALS).reduce((total, item) => {
    const entry = UNIT_NEGOTIATION_MATERIALS[Number(item.itemId)];
    return total + Math.max(0, Number(entry && entry.credit) || 0) * Math.max(0, Number(item.count) || 0);
  }, 0);
  if (selection === NEGOTIATE_BOSS_SELECTION.RAISE) {
    return Math.floor((baseSalary * (100 + NEGOTIATION_OPTIONS.RAISE_CREDIT_INCREASE_PERCENT)) / 100);
  }
  if (selection === NEGOTIATE_BOSS_SELECTION.PASSION) {
    return Math.floor((baseSalary * (100 - NEGOTIATION_OPTIONS.PASSION_CREDIT_DECREASE_PERCENT)) / 100);
  }
  return baseSalary;
}

function calculateNegotiationLoyalty(unit, materials, selection = NEGOTIATE_BOSS_SELECTION.OK) {
  const current = Math.max(0, Number(unit && unit.loyalty) || 0);
  let gain = normalizeMaterialList(materials, UNIT_NEGOTIATION_MATERIALS).reduce((total, item) => {
    const entry = UNIT_NEGOTIATION_MATERIALS[Number(item.itemId)];
    return total + Math.max(0, Number(entry && entry.loyalty) || 0) * Math.max(0, Number(item.count) || 0);
  }, 0);
  if (selection === NEGOTIATE_BOSS_SELECTION.PASSION) gain = 0;
  if (selection === NEGOTIATE_BOSS_SELECTION.RAISE) {
    gain = Math.floor((gain * (100 + NEGOTIATION_OPTIONS.RAISE_LOYALTY_INCREASE_PERCENT)) / 100);
  }
  return Math.min(10000, current + gain);
}

function skillUpgradeResponse(request, errorCode, skillLevel, costItems) {
  const result = response(PACKETS.UNIT_SKILL_UPGRADE_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarLong(request && request.unitUid || 0),
    writeSignedVarInt(request && request.skillId || 0),
    writeSignedVarInt(skillLevel || 1),
    writeNullableObjectList((Array.isArray(costItems) ? costItems : []).map(buildItemMiscData)),
  ]);
  if (errorCode !== ERROR_CODES.OK) result.persist = false;
  else result.invalidateLobby = "unit-skill-upgrade";
  return result;
}

function shipLevelUpResponse(errorCode, ship, costItems, options = {}) {
  const result = response(PACKETS.SHIP_LEVELUP_ACK, [
    writeSignedVarInt(errorCode),
    nullableUnit(ship),
    writeNullableObjectList((Array.isArray(costItems) ? costItems : []).map(buildItemMiscData)),
  ]);
  if (errorCode !== ERROR_CODES.OK) result.persist = false;
  return Object.assign(result, options);
}

function shipUpgradeResponse(errorCode, ship, costItems, options = {}) {
  const result = response(PACKETS.SHIP_UPGRADE_ACK, [
    writeSignedVarInt(errorCode),
    nullableUnit(ship),
    writeNullableObjectList((Array.isArray(costItems) ? costItems : []).map(buildItemMiscData)),
  ]);
  if (errorCode !== ERROR_CODES.OK) result.persist = false;
  return Object.assign(result, options);
}

function resolveRequestedSkillIndex(unit, skillId) {
  return getUnitSkillIndex(unit && unit.unitId, skillId);
}

function getCurrentSkillLevel(unit, skillIndex) {
  const levels = Array.isArray(unit && unit.skillLevels) ? unit.skillLevels : [];
  return Math.max(1, Math.trunc(Number(levels[skillIndex]) || 1));
}

function unitSkillDeckError(user, unitUid) {
  const key = String(toBigInt(unitUid || 0));
  const army = ensureArmy(user);
  for (const deck of getAllDecks(army)) {
    if (!(deck.unitUids || []).some((uid) => String(toBigInt(uid || 0)) === key)) continue;
    if (Number(deck.state || 0) === 2) return ERROR_CODES.WARFARE_DOING;
    if (Number(deck.state || 0) === 3) return ERROR_CODES.DIVE_DOING;
  }
  return ERROR_CODES.OK;
}

function getPhysicalShipByUid(user, shipUid) {
  const army = ensureArmy(user);
  const key = String(toBigInt(shipUid || 0));
  return army.ships && army.ships[key] ? getArmyUnitByUid(user, shipUid) : null;
}

function shipDeckError(user, shipUid) {
  const key = String(toBigInt(shipUid || 0));
  const army = ensureArmy(user);
  for (const deck of getAllDecks(army)) {
    if (String(toBigInt(deck.shipUid || deck.m_ShipUID || 0)) !== key) continue;
    const state = Number(deck.state != null ? deck.state : deck.m_DeckState || 0);
    if (state === 1) return ERROR_CODES.WORLDMAP_MISSION_DOING;
    if (state === 2) return ERROR_CODES.WARFARE_DOING;
    if (state === 3) return ERROR_CODES.DIVE_DOING;
  }
  return ERROR_CODES.OK;
}

function hasEnoughSkillUpgradeItems(user, costs) {
  return (Array.isArray(costs) ? costs : []).every((cost) => hasEnoughMiscItem(user, cost.itemId, cost.count));
}

function hasEnoughShipLevelUpItems(user, costs) {
  return (Array.isArray(costs) ? costs : []).every((cost) => hasEnoughMiscItem(user, cost.itemId, cost.count));
}

function hasEnoughMiscItem(user, itemId, count) {
  const amount = Math.max(0, Math.trunc(Number(count || 0)));
  if (amount <= 0) return true;
  const item = getMiscItem(user, itemId);
  if (!item) return false;
  return toBigInt(item.countFree, 0n) + toBigInt(item.countPaid, 0n) >= BigInt(amount);
}

function spendSkillUpgradeCosts(user, costs) {
  const updatedByItem = new Map();
  for (const cost of Array.isArray(costs) ? costs : []) {
    const item = spendMiscItem(user, cost.itemId, cost.count);
    if (item) updatedByItem.set(Number(item.itemId), item);
  }
  return Array.from(updatedByItem.values()).sort((a, b) => Number(a.itemId) - Number(b.itemId));
}

function spendShipLevelUpCosts(user, costs) {
  const updatedByItem = new Map();
  for (const cost of Array.isArray(costs) ? costs : []) {
    const item = spendMiscItem(user, cost.itemId, cost.count);
    if (item) updatedByItem.set(Number(item.itemId), item);
  }
  return Array.from(updatedByItem.values()).sort((a, b) => Number(a.itemId) - Number(b.itemId));
}

function spendNegotiationCosts(user, materials, finalSalary) {
  const updated = [];
  const seen = new Set();
  for (const material of normalizeMaterialList(materials, UNIT_NEGOTIATION_MATERIALS)) {
    const item = spendMiscItem(user, material.itemId, material.count);
    if (item) {
      updated.push(item);
      seen.add(Number(item.itemId));
    }
  }
  if (finalSalary > 0) {
    const credit = spendMiscItem(user, RESOURCE_ITEM_IDS.CREDIT, finalSalary);
    if (credit && !seen.has(Number(credit.itemId))) updated.push(credit);
  }
  return updated.sort((a, b) => Number(a.itemId) - Number(b.itemId));
}

function decideNegotiationResult(selection) {
  if (selection === NEGOTIATE_BOSS_SELECTION.RAISE) return NEGOTIATE_RESULT.SUCCESS;
  return NEGOTIATE_RESULT.COMPLETE;
}

function normalizeNegotiationSelection(selection) {
  const value = Number(selection);
  if (value === NEGOTIATE_BOSS_SELECTION.RAISE) return NEGOTIATE_BOSS_SELECTION.RAISE;
  if (value === NEGOTIATE_BOSS_SELECTION.PASSION) return NEGOTIATE_BOSS_SELECTION.PASSION;
  return NEGOTIATE_BOSS_SELECTION.OK;
}

function normalizeMaterialList(materials, table, options = {}) {
  if (!Array.isArray(materials)) return [];
  const maxCount = options.maxCount == null ? Infinity : Math.max(0, Number(options.maxCount) || 0);
  const byItem = new Map();
  let remaining = maxCount;

  for (const item of materials) {
    const itemId = Number(item && (item.itemId || item.id || item.ItemID || 0));
    if (!Number.isInteger(itemId) || itemId <= 0 || !table[itemId]) continue;
    const count = Math.max(0, Math.trunc(Number(item && item.count) || 0));
    if (count <= 0 || remaining <= 0) continue;
    const accepted = Math.min(count, remaining);
    byItem.set(itemId, (byItem.get(itemId) || 0) + accepted);
    remaining -= accepted;
  }

  return Array.from(byItem.entries())
    .map(([itemId, count]) => ({ itemId, count }))
    .sort((a, b) => a.itemId - b.itemId);
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  let offset = 0;
  const nextInt = () => {
    const read = readSignedVarInt(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const nextLong = () => {
    const read = readSignedVarLong(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const nextBool = () => {
    const read = readBool(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const nextLongList = () => {
    const read = readSignedVarLongList(payload, offset);
    offset = read.offset;
    return read.value.map((value) => value.toString());
  };
  const nextIntIntDictionary = () => {
    const read = readIntIntDictionary(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const nextMiscListData = () => {
    const read = readMiscItemDataList(payload, offset);
    offset = read.offset;
    return read;
  };
  const nextMiscList = () => nextMiscListData().value;

  try {
    switch (packetId) {
      case PACKETS.ENHANCE_UNIT_REQ:
        return { unitUid: nextLong(), consumeUnitUids: nextLongList() };
      case PACKETS.LOCK_UNIT_REQ:
        return { unitUid: nextLong(), locked: nextBool(), valid: offset === payload.length };
      case PACKETS.REMOVE_UNIT_REQ:
        return { unitUids: nextLongList(), valid: offset === payload.length };
      case PACKETS.EXTRACT_UNIT_REQ:
        return { unitUids: nextLongList(), valid: offset === payload.length };
      case PACKETS.LIMIT_BREAK_UNIT_REQ:
        return { unitUid: nextLong(), valid: offset === payload.length };
      case PACKETS.UNIT_REACTOR_LEVELUP_REQ:
        return { unitUid: nextLong(), valid: offset === payload.length };
      case PACKETS.CONTRACT_PERMANENTLY_REQ:
        return { unitUid: nextLong(), valid: offset === payload.length };
      case PACKETS.UNIT_SKILL_UPGRADE_REQ:
        return { unitUid: nextLong(), skillId: nextInt(), valid: offset === payload.length };
      case PACKETS.SHIP_BUILD_REQ:
        return { shipId: nextInt(), valid: offset === payload.length };
      case PACKETS.SHIP_LEVELUP_REQ:
        return { shipUid: nextLong(), nextLevel: nextInt(), valid: offset === payload.length };
      case PACKETS.SHIP_UPGRADE_REQ:
        return { shipUid: nextLong(), nextShipId: nextInt(), valid: offset === payload.length };
      case PACKETS.SHIP_DIVISION_REQ:
        return { shipUids: nextLongList(), valid: offset === payload.length };
      case PACKETS.OPERATOR_LEVELUP_REQ: {
        const operatorUid = nextLong();
        const materials = nextMiscListData();
        return {
          operatorUid,
          materials: materials.value,
          materialEntryCount: materials.declaredCount,
          nullMaterialCount: materials.nullCount,
          valid: offset === payload.length,
        };
      }
      case PACKETS.OPERATOR_ENHANCE_REQ:
        return {
          operatorUid: nextLong(),
          sourceOperatorUid: nextLong(),
          tokenItemId: nextInt(),
          transSkill: nextBool(),
          valid: offset === payload.length,
        };
      case PACKETS.OPERATOR_LOCK_REQ:
        return { operatorUid: nextLong(), locked: nextBool(), valid: offset === payload.length };
      case PACKETS.OPERATOR_REMOVE_REQ:
        return { operatorUids: nextLongList(), valid: offset === payload.length };
      case PACKETS.OPERATOR_EXTRACT_REQ:
        return { operatorUids: nextLongList(), valid: offset === payload.length };
      case PACKETS.RECALL_UNIT_REQ:
        return { unitUid: nextLong(), exchangeUnits: nextIntIntDictionary(), valid: offset === payload.length };
      case PACKETS.REARMAMENT_UNIT_REQ:
        return { unitUid: nextLong(), rearmamentId: nextInt(), valid: offset === payload.length };
      case PACKETS.FAVORITE_UNIT_REQ:
        return { unitUid: nextLong(), favorite: nextBool(), valid: offset === payload.length };
      case PACKETS.LIMIT_BREAK_SHIP_REQ:
        return { shipUid: nextLong(), consumeShipUid: nextLong(), valid: offset === payload.length };
      case PACKETS.UNIT_TACTIC_UPDATE_REQ:
        return { unitUid: nextLong(), consumeUnitUids: nextLongList(), valid: offset === payload.length };
      case PACKETS.NEGOTIATE_REQ:
        return { unitUid: nextLong(), materials: nextMiscList(), negotiateBossSelection: safeReadInt(payload, offset, NEGOTIATE_BOSS_SELECTION.OK) };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[unit-growth] request decode failed packetId=${packetId}: ${err.message}`);
    if (packetId === PACKETS.LOCK_UNIT_REQ) return { unitUid: 0n, locked: false, valid: false };
    if (packetId === PACKETS.OPERATOR_LOCK_REQ) return { operatorUid: 0n, locked: false, valid: false };
    if (packetId === PACKETS.REMOVE_UNIT_REQ) return { unitUids: [], valid: false };
    if (packetId === PACKETS.OPERATOR_REMOVE_REQ) return { operatorUids: [], valid: false };
    if (packetId === PACKETS.OPERATOR_EXTRACT_REQ) return { operatorUids: [], valid: false };
    if (packetId === PACKETS.RECALL_UNIT_REQ) return { unitUid: 0n, exchangeUnits: [], valid: false };
    if (packetId === PACKETS.REARMAMENT_UNIT_REQ) return { unitUid: 0n, rearmamentId: 0, valid: false };
    if (packetId === PACKETS.OPERATOR_LEVELUP_REQ) {
      return { operatorUid: 0n, materials: [], materialEntryCount: 0, nullMaterialCount: 0, valid: false };
    }
    if (packetId === PACKETS.OPERATOR_ENHANCE_REQ) {
      return { operatorUid: 0n, sourceOperatorUid: 0n, tokenItemId: 0, transSkill: false, valid: false };
    }
    if (packetId === PACKETS.SHIP_DIVISION_REQ) return { shipUids: [], valid: false };
    if (packetId === PACKETS.UNIT_TACTIC_UPDATE_REQ) return { unitUid: 0n, consumeUnitUids: [], valid: false };
    if (packetId === PACKETS.UNIT_REACTOR_LEVELUP_REQ) return { unitUid: 0n, valid: false };
    if (packetId === PACKETS.UNIT_SKILL_UPGRADE_REQ) return { unitUid: 0n, skillId: 0, valid: false };
    if (packetId === PACKETS.LIMIT_BREAK_UNIT_REQ) return { unitUid: 0n, valid: false };
    if (packetId === PACKETS.SHIP_BUILD_REQ) return { shipId: 0, valid: false };
    if (packetId === PACKETS.SHIP_LEVELUP_REQ) return { shipUid: 0n, nextLevel: 0, valid: false };
    if (packetId === PACKETS.SHIP_UPGRADE_REQ) return { shipUid: 0n, nextShipId: 0, valid: false };
    if (packetId === PACKETS.LIMIT_BREAK_SHIP_REQ) return { shipUid: 0n, consumeShipUid: 0n, valid: false };
    return packetId === PACKETS.FAVORITE_UNIT_REQ ? { unitUid: 0n, favorite: false, valid: false } : {};
  }
}

function readMiscItemDataList(buffer, offset = 0) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  let nullCount = 0;
  for (let index = 0; index < count.value; index += 1) {
    if (offset < buffer.length && (buffer[offset] === 0 || buffer[offset] === 1)) {
      const present = buffer[offset] !== 0;
      offset += 1;
      if (!present) {
        nullCount += 1;
        continue;
      }
    }
    const itemId = readSignedVarInt(buffer, offset);
    offset = itemId.offset;
    const itemCount = readSignedVarInt(buffer, offset);
    offset = itemCount.offset;
    values.push({ itemId: itemId.value, count: itemCount.value });
  }
  return { value: values, offset, declaredCount: count.value, nullCount };
}

function readIntIntDictionary(buffer, offset = 0) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const key = readSignedVarInt(buffer, offset);
    offset = key.offset;
    const value = readSignedVarInt(buffer, offset);
    offset = value.offset;
    values.push({ unitId: key.value, count: value.value });
  }
  return { value: values, offset };
}

function readVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer.readUInt8(offset++);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function safeReadInt(buffer, offset = 0, fallback = 0) {
  try {
    return readSignedVarInt(buffer, offset).value;
  } catch (_) {
    return fallback;
  }
}

function decryptPayload(ctx, encryptedPayload) {
  try {
    return ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function nullableUnit(unit) {
  return unit ? writeNullableObject(buildUnitData(unit)) : writeNullObject();
}

function nullableOperator(operator) {
  return operator ? writeNullableObject(buildOperatorData(operator)) : writeNullObject();
}

function buildRecallHistoryInfo(unitId, lastUpdateDate = dateTimeBinaryNow()) {
  return Buffer.concat([writeSignedVarInt(Number(unitId || 0) || 0), writeInt64LE(toBigInt(lastUpdateDate))]);
}

function emptyItemList() {
  return writeNullableObjectList([]);
}

function writeSignedVarIntList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeRawVarInt(list.length), ...list.map((value) => writeSignedVarInt(Number(value) || 0))]);
}

function writeSignedVarLongList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeRawVarInt(list.length), ...list.map((value) => writeSignedVarLong(toBigInt(value || 0)))]);
}

function writeRawVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function ok() {
  return writeSignedVarInt(0);
}

function response(packetId, parts, options = {}) {
  return { packetId, payload: Buffer.concat(parts), ...options };
}

function getSessionUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function persistUserDb(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function formatRequest(request) {
  const fields = [];
  for (const key of [
    "unitUid",
    "shipUid",
    "operatorUid",
    "skillId",
    "nextLevel",
    "nextShipId",
    "shipId",
    "rearmamentId",
  ]) {
    if (request && request[key] != null) fields.push(`${key}=${request[key]}`);
  }
  if (request && Array.isArray(request.consumeUnitUids)) fields.push(`consume=${request.consumeUnitUids.length}`);
  if (request && Array.isArray(request.unitUids)) fields.push(`units=${request.unitUids.length}`);
  if (request && Array.isArray(request.operatorUids)) fields.push(`operators=${request.operatorUids.length}`);
  if (request && Array.isArray(request.exchangeUnits)) {
    fields.push(`exchange=${request.exchangeUnits.map((unit) => `${unit.unitId}:${unit.count}`).join(",") || "0"}`);
  }
  if (request && Array.isArray(request.materials)) {
    fields.push(`materials=${request.materials.map((item) => `${item.itemId}:${item.count}`).join(",") || "0"}`);
  }
  if (request && request.negotiateBossSelection != null) fields.push(`selection=${request.negotiateBossSelection}`);
  return fields.join(" ");
}

module.exports = {
  PACKETS,
  ERROR_CODES,
  createUnitGrowthHandlers,
  isShipBuildUnlocked,
};
