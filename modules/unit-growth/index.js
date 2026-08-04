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
  getNextUnitLimitBreakRank,
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
  getPlayableShipIds,
  getShipLevelUpCosts,
  getShipMaxLevel,
  getUnitLimitBreakCosts,
  getUnitSkillIndex,
  getUnitSkillMaxLevel,
  getUnitSkillUpgradeCosts,
  getUnitRemoveRewards,
} = require("../game-data");
const { spendMiscItem, getMiscItem, grantMiscItem, RESOURCE_ITEM_IDS } = require("../inventory");
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

const OPERATOR_EXP_MATERIALS = Object.freeze({
  1044: { exp: 200 },
  1045: { exp: 500 },
  1046: { exp: 1200 },
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
  UNIT_EQUIP_ITEM: 141,
  UNIT_SKILL_NOT_EXIST: 147,
  UNIT_SKILL_TEMPLET_NOT_EXIST: 148,
  UNIT_SKILL_ALREADY_MAX: 149,
  UNIT_SKILL_NOT_ENOUGH_ITEM: 151,
  SHIP_MAX_LEVEL: 238,
  INVALID_ITEM_ID: 244,
  SHIP_INVALID_LEVEL: 1536,
});

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
      const missionTracking = trackUnitGrowthMission(ctx, user, packetId, request);
      console.log(`[unit-growth:${name}] ACK packetId=${response.packetId} ${formatRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      sendUnitMissionCollectionUpdate(ctx, socket, user, packetId, request);
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "unit-growth-mission-update" });
      persistUserDb(ctx);
      return true;
    },
  };
}

function sendUnitMissionCollectionUpdate(ctx, socket, user, packetId, request = {}) {
  if (packetId !== PACKETS.NEGOTIATE_REQ && packetId !== PACKETS.LIMIT_BREAK_UNIT_REQ) return;
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
      break;
    case PACKETS.UNIT_TACTIC_UPDATE_REQ:
      track("UNIT_GROWTH_TACTICAL", 1, { unitUid: request.unitUid });
      break;
    case PACKETS.UNIT_SKILL_UPGRADE_REQ:
      track("UNIT_TRAINING", 1, { unitUid: request.unitUid, value: request.skillId });
      track("UNIT_GROWTH_SKILL_LEVEL_3", 1, { unitUid: request.unitUid, value: request.skillId });
      track("UNIT_GROWTH_SKILL_LEVEL_MAX", 1, { unitUid: request.unitUid, value: request.skillId });
      break;
    case PACKETS.CONTRACT_PERMANENTLY_REQ:
      track("UNIT_GROWTH_PERMANENT", 1, { unitUid: request.unitUid });
      break;
    case PACKETS.SHIP_LEVELUP_REQ:
      track("SHIP_LEVELUP", 1, { unitUid: request.shipUid });
      break;
    case PACKETS.LIMIT_BREAK_SHIP_REQ:
      track("SHIP_LIMITBREAK", 1, { unitUid: request.shipUid });
      break;
    case PACKETS.OPERATOR_LEVELUP_REQ:
      for (const material of request.materials || []) trackResourceSpend(material.itemId, material.count);
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
  setUnitLock(user, request.unitUid, request.locked);
  return response(PACKETS.LOCK_UNIT_ACK, [ok(), writeSignedVarLong(request.unitUid), writeBool(request.locked)]);
}

function handleRemoveUnit(_ctx, user, request) {
  return removalResponse(
    PACKETS.REMOVE_UNIT_ACK,
    dismissArmyUnits(user, request.unitUids || [], { allowedKinds: new Set(["unit", "trophy"]) })
  );
}

function dismissArmyUnits(user, unitUids = [], options = {}) {
  const uidList = uniqueUidList(unitUids);
  const targets = [];
  for (const uid of uidList) {
    const unit = getArmyUnitByUid(user, uid);
    const kind = getArmyUnitStorageKind(user, uid);
    if (!unit) return removalResult(ERROR_CODES.UNIT_NOT_EXIST);
    if (options.allowedKinds && !options.allowedKinds.has(kind)) return removalResult(ERROR_CODES.UNIT_BAD_TYPE);
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
    if (!operator) return removalResult(ERROR_CODES.UNIT_NOT_EXIST);
    const errorCode = getDismissOperatorError(user, operator, uid);
    if (errorCode !== ERROR_CODES.OK) return removalResult(errorCode);
    targets.push(operator);
  }

  const rewards = collectRemoveRewards(targets);
  const removed = removeOperatorUids(user, uidList);
  return removalResult(ERROR_CODES.OK, removed, grantRewardItems(user, rewards));
}

function getDismissUnitError(user, unit, uid, kind) {
  if (isRosterEntryLocked(unit)) return ERROR_CODES.UNIT_LOCKED;
  if (kind !== "ship" && hasEquippedItems(unit)) return ERROR_CODES.UNIT_EQUIP_ITEM;
  if (isUidInDeck(user, uid, kind)) return ERROR_CODES.UNIT_IN_DECK;
  return ERROR_CODES.OK;
}

function getDismissOperatorError(user, operator, uid) {
  if (isRosterEntryLocked(operator)) return ERROR_CODES.UNIT_LOCKED;
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
  ]);
}

function handleLimitBreakUnit(_ctx, user, request) {
  const currentUnit = getArmyUnitByUid(user, request.unitUid);
  const costItems = currentUnit ? spendLimitBreakCosts(user, currentUnit) : [];
  const unit = limitBreakUnit(user, request.unitUid) || currentUnit;
  return response(PACKETS.LIMIT_BREAK_UNIT_ACK, [
    ok(),
    nullableUnit(unit),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
  ]);
}

function handleSkillUpgrade(_ctx, user, request) {
  const unit = getArmyUnitByUid(user, request.unitUid);
  if (!unit) return skillUpgradeResponse(request, ERROR_CODES.UNIT_NOT_EXIST, 1, []);

  const skillIndex = resolveRequestedSkillIndex(unit, request.skillId);
  if (skillIndex < 0) return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_NOT_EXIST, 1, []);

  const currentLevel = getCurrentSkillLevel(unit, skillIndex);
  const maxLevel = Math.max(1, getUnitSkillMaxLevel(request.skillId) || 5);
  if (currentLevel >= maxLevel) {
    return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_ALREADY_MAX, currentLevel, []);
  }

  const targetLevel = currentLevel + 1;
  const costs = getUnitSkillUpgradeCosts(request.skillId, targetLevel);
  if (!costs) return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_TEMPLET_NOT_EXIST, currentLevel, []);
  if (!hasEnoughSkillUpgradeItems(user, costs)) {
    return skillUpgradeResponse(request, ERROR_CODES.UNIT_SKILL_NOT_ENOUGH_ITEM, currentLevel, []);
  }

  const result = upgradeUnitSkill(user, request.unitUid, request.skillId, { maxSkillLevel: maxLevel }) || {};
  const costItems = spendSkillUpgradeCosts(user, costs);
  return skillUpgradeResponse(request, ERROR_CODES.OK, result.skillLevel || targetLevel, costItems);
}

function handleShipBuild(_ctx, user, request) {
  const shipId = Number(request.shipId || 0) || getPlayableShipIds()[0] || 0;
  const ship = grantUnit(user, shipId, { level: 1, fromContract: false });
  return response(PACKETS.SHIP_BUILD_ACK, [ok(), nullableUnit(ship), emptyItemList()]);
}

function handleShipLevelUp(_ctx, user, request) {
  const currentShip = getArmyUnitByUid(user, request.shipUid);
  if (!currentShip) return shipLevelUpResponse(ERROR_CODES.UNIT_NOT_EXIST, null, []);

  const currentLevel = Math.max(1, Math.trunc(Number(currentShip.level || 1) || 1));
  const nextLevel = Math.trunc(Number(request.nextLevel || 0) || 0);
  const maxLevel = getShipMaxLevel(currentShip);
  if (nextLevel < 1 || nextLevel < currentLevel) {
    return shipLevelUpResponse(ERROR_CODES.SHIP_INVALID_LEVEL, currentShip, []);
  }
  if (nextLevel > maxLevel) {
    return shipLevelUpResponse(ERROR_CODES.SHIP_MAX_LEVEL, currentShip, []);
  }

  const costs = getShipLevelUpCosts(currentShip, currentLevel, nextLevel);
  if (!hasEnoughShipLevelUpItems(user, costs)) {
    return shipLevelUpResponse(ERROR_CODES.INVALID_ITEM_ID, currentShip, []);
  }

  const costItems = spendShipLevelUpCosts(user, costs);
  const ship = setShipLevel(user, request.shipUid, nextLevel) || getArmyUnitByUid(user, request.shipUid) || currentShip;
  return shipLevelUpResponse(ERROR_CODES.OK, ship, costItems);
}

function handleShipUpgrade(_ctx, user, request) {
  const ship = upgradeShip(user, request.shipUid, request.nextShipId) || getArmyUnitByUid(user, request.shipUid);
  return response(PACKETS.SHIP_UPGRADE_ACK, [ok(), nullableUnit(ship), emptyItemList()]);
}

function handleShipDivision(_ctx, user, request) {
  return removalResponse(
    PACKETS.SHIP_DIVISION_ACK,
    dismissArmyUnits(user, request.shipUids || [], { allowedKinds: new Set(["ship"]) })
  );
}

function handlePermanentContract(_ctx, user, request) {
  permanentlyContractUnit(user, request.unitUid);
  return response(PACKETS.CONTRACT_PERMANENTLY_ACK, [ok(), writeSignedVarLong(request.unitUid), writeNullObject()]);
}

function handleOperatorLevelUp(_ctx, user, request) {
  const operator =
    addOperatorExp(user, request.operatorUid, calculateOperatorExpGain(request.materials)) ||
    getArmyOperatorByUid(user, request.operatorUid);
  return response(PACKETS.OPERATOR_LEVELUP_ACK, [ok(), emptyItemList(), nullableOperator(operator)]);
}

function handleOperatorEnhance(_ctx, user, request) {
  const operator =
    enhanceOperator(user, request.operatorUid, request.sourceOperatorUid, { transSkill: request.transSkill }) ||
    getArmyOperatorByUid(user, request.operatorUid);
  return response(PACKETS.OPERATOR_ENHANCE_ACK, [
    ok(),
    nullableOperator(operator),
    emptyItemList(),
    writeSignedVarLong(request.sourceOperatorUid || 0n),
    writeBool(request.transSkill),
    writeSignedVarInt(request.tokenItemId || 0),
  ]);
}

function handleOperatorLock(_ctx, user, request) {
  setOperatorLock(user, request.operatorUid, request.locked);
  return response(PACKETS.OPERATOR_LOCK_ACK, [ok(), writeSignedVarLong(request.operatorUid), writeBool(request.locked)]);
}

function handleOperatorRemove(_ctx, user, request) {
  return removalResponse(PACKETS.OPERATOR_REMOVE_ACK, dismissOperators(user, request.operatorUids || []));
}

function handleRecallUnit(_ctx, user, request) {
  const recalled = getArmyUnitByUid(user, request.unitUid);
  const exchanges = [];
  for (const exchange of Array.isArray(request.exchangeUnits) ? request.exchangeUnits : []) {
    const count = Math.min(16, Math.max(1, Math.trunc(Number(exchange.count || 1) || 1)));
    for (let index = 0; index < count; index += 1) {
      const unit = grantUnit(user, exchange.unitId, { level: 1, limitBreakLevel: 0, fromContract: false });
      if (unit) exchanges.push(unit);
    }
  }
  if (recalled) removeArmyUnitUids(user, [request.unitUid]);
  return response(PACKETS.RECALL_UNIT_ACK, [
    ok(),
    writeSignedVarLong(request.unitUid || 0n),
    writeNullableObjectList(exchanges.map(buildUnitData)),
    writeNullableObject(buildRecallHistoryInfo((recalled && recalled.unitId) || request.historyUnitId || 0)),
    emptyItemList(),
  ]);
}

function handleExtractUnit(_ctx, user, request) {
  const removed = removeArmyUnitUids(user, request.unitUids || []);
  return response(PACKETS.EXTRACT_UNIT_ACK, [
    ok(),
    writeSignedVarLongList(removed),
    writeNullableObject(buildRewardData({})),
    writeNullableObject(buildRewardData({})),
  ]);
}

function handleRearmUnit(_ctx, user, request) {
  const unit = rearmUnit(user, request.unitUid, request.rearmamentId) || getArmyUnitByUid(user, request.unitUid);
  return response(PACKETS.REARMAMENT_UNIT_ACK, [ok(), nullableUnit(unit), emptyItemList()]);
}

function handleFavoriteUnit(_ctx, user, request) {
  setUnitFavorite(user, request.unitUid, request.favorite);
  return response(PACKETS.FAVORITE_UNIT_ACK, [ok(), writeSignedVarLong(request.unitUid), writeBool(request.favorite)]);
}

function handleLimitBreakShip(_ctx, user, request) {
  const ship = limitBreakShip(user, request.shipUid, request.consumeShipUid) || getArmyUnitByUid(user, request.shipUid);
  return response(PACKETS.LIMIT_BREAK_SHIP_ACK, [
    ok(),
    nullableUnit(ship),
    writeSignedVarLong(request.consumeShipUid || 0n),
    emptyItemList(),
  ]);
}

function handleTacticUpdate(_ctx, user, request) {
  const unit = tacticUpdateUnit(user, request.unitUid, request.consumeUnitUids) || getArmyUnitByUid(user, request.unitUid);
  return response(PACKETS.UNIT_TACTIC_UPDATE_ACK, [
    ok(),
    nullableUnit(unit),
    writeSignedVarLongList(request.consumeUnitUids || []),
  ]);
}

function handleReactorLevelUp(_ctx, user, request) {
  const unit = reactorLevelUpUnit(user, request.unitUid) || getArmyUnitByUid(user, request.unitUid);
  return response(PACKETS.UNIT_REACTOR_LEVELUP_ACK, [ok(), nullableUnit(unit), emptyItemList()]);
}

function handleOperatorExtract(_ctx, user, request) {
  const removed = removeOperatorUids(user, request.operatorUids || []);
  return response(PACKETS.OPERATOR_EXTRACT_ACK, [ok(), writeSignedVarLongList(removed), emptyItemList(), emptyItemList()]);
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

function calculateOperatorExpGain(materials = []) {
  const exp = calculateMaterialExp(materials, OPERATOR_EXP_MATERIALS, 100);
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
  return response(PACKETS.UNIT_SKILL_UPGRADE_ACK, [
    writeSignedVarInt(errorCode),
    writeSignedVarLong(request.unitUid),
    writeSignedVarInt(request.skillId || 0),
    writeSignedVarInt(skillLevel || 1),
    writeNullableObjectList((Array.isArray(costItems) ? costItems : []).map(buildItemMiscData)),
  ]);
}

function shipLevelUpResponse(errorCode, ship, costItems) {
  return response(PACKETS.SHIP_LEVELUP_ACK, [
    writeSignedVarInt(errorCode),
    nullableUnit(ship),
    writeNullableObjectList((Array.isArray(costItems) ? costItems : []).map(buildItemMiscData)),
  ]);
}

function resolveRequestedSkillIndex(unit, skillId) {
  const mappedIndex = getUnitSkillIndex(unit && unit.unitId, skillId);
  if (mappedIndex >= 0) return mappedIndex;
  const numeric = Number(skillId || 0);
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 5 ? numeric - 1 : -1;
}

function getCurrentSkillLevel(unit, skillIndex) {
  const levels = Array.isArray(unit && unit.skillLevels) ? unit.skillLevels : [];
  return Math.max(1, Math.trunc(Number(levels[skillIndex]) || 1));
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

function spendLimitBreakCosts(user, unit) {
  if (!unit) return [];
  const currentRank = Math.max(0, Number(unit && unit.limitBreakLevel) || 0);
  const targetRank = getNextUnitLimitBreakRank(unit);
  if (targetRank <= currentRank) return [];
  const costs = getUnitLimitBreakCosts(unit.unitId, targetRank);
  const updatedByItem = new Map();
  for (const cost of costs) {
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
  const nextMiscList = () => {
    const read = readMiscItemDataList(payload, offset);
    offset = read.offset;
    return read.value;
  };

  try {
    switch (packetId) {
      case PACKETS.ENHANCE_UNIT_REQ:
        return { unitUid: nextLong(), consumeUnitUids: nextLongList() };
      case PACKETS.LOCK_UNIT_REQ:
        return { unitUid: nextLong(), locked: nextBool() };
      case PACKETS.REMOVE_UNIT_REQ:
      case PACKETS.EXTRACT_UNIT_REQ:
        return { unitUids: nextLongList() };
      case PACKETS.LIMIT_BREAK_UNIT_REQ:
      case PACKETS.CONTRACT_PERMANENTLY_REQ:
      case PACKETS.UNIT_REACTOR_LEVELUP_REQ:
        return { unitUid: nextLong() };
      case PACKETS.UNIT_SKILL_UPGRADE_REQ:
        return { unitUid: nextLong(), skillId: nextInt() };
      case PACKETS.SHIP_BUILD_REQ:
        return { shipId: nextInt() };
      case PACKETS.SHIP_LEVELUP_REQ:
        return { shipUid: nextLong(), nextLevel: nextInt() };
      case PACKETS.SHIP_UPGRADE_REQ:
        return { shipUid: nextLong(), nextShipId: nextInt() };
      case PACKETS.SHIP_DIVISION_REQ:
        return { shipUids: nextLongList() };
      case PACKETS.OPERATOR_LEVELUP_REQ:
        return { operatorUid: nextLong(), materials: nextMiscList() };
      case PACKETS.OPERATOR_ENHANCE_REQ:
        return { operatorUid: nextLong(), sourceOperatorUid: nextLong(), tokenItemId: nextInt(), transSkill: nextBool() };
      case PACKETS.OPERATOR_LOCK_REQ:
        return { operatorUid: nextLong(), locked: nextBool() };
      case PACKETS.OPERATOR_REMOVE_REQ:
      case PACKETS.OPERATOR_EXTRACT_REQ:
        return { operatorUids: nextLongList() };
      case PACKETS.RECALL_UNIT_REQ:
        return { unitUid: nextLong(), exchangeUnits: nextIntIntDictionary() };
      case PACKETS.REARMAMENT_UNIT_REQ:
        return { unitUid: nextLong(), rearmamentId: nextInt() };
      case PACKETS.FAVORITE_UNIT_REQ:
        return { unitUid: nextLong(), favorite: nextBool() };
      case PACKETS.LIMIT_BREAK_SHIP_REQ:
        return { shipUid: nextLong(), consumeShipUid: nextLong() };
      case PACKETS.UNIT_TACTIC_UPDATE_REQ:
        return { unitUid: nextLong(), consumeUnitUids: nextLongList() };
      case PACKETS.NEGOTIATE_REQ:
        return { unitUid: nextLong(), materials: nextMiscList(), negotiateBossSelection: safeReadInt(payload, offset, NEGOTIATE_BOSS_SELECTION.OK) };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[unit-growth] request decode failed packetId=${packetId}: ${err.message}`);
    return {};
  }
}

function readMiscItemDataList(buffer, offset = 0) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    if (offset < buffer.length && (buffer[offset] === 0 || buffer[offset] === 1)) {
      const present = buffer[offset] !== 0;
      offset += 1;
      if (!present) continue;
    }
    const itemId = readSignedVarInt(buffer, offset);
    offset = itemId.offset;
    const itemCount = readSignedVarInt(buffer, offset);
    offset = itemCount.offset;
    values.push({ itemId: itemId.value, count: itemCount.value });
  }
  return { value: values, offset };
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

function buildRecallHistoryInfo(unitId) {
  return Buffer.concat([writeSignedVarInt(Number(unitId || 0) || 0), writeInt64LE(toBigInt(dateTimeBinaryNow()))]);
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

function response(packetId, parts) {
  return { packetId, payload: Buffer.concat(parts) };
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
  createUnitGrowthHandlers,
};
