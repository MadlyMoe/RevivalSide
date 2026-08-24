const { randomInt: cryptoRandomInt } = require("node:crypto");
const {
  writeString,
  writeBool,
  writeByte,
  writeSByte,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeNullableObjectList,
  writeIntList,
  writeLongArray,
  buildItemMiscData,
  buildUnitData,
  buildOperatorData,
  buildEquipItemData,
  buildDeckIndexData,
  buildDeckData,
  buildRewardData,
  buildShipCmdModuleData,
  buildShipModuleCandidateData,
  dateTimeBinaryNow,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  readBool,
  readByte,
  readSByte,
  readString,
  toBigInt,
} = require("../packet-codec");
const {
  ensureArmy,
  getArmyUnits,
  getArmyShips,
  getArmyOperators,
  grantUnit,
  grantOperator,
  ensureDeck,
  normalizeShipCommandModules,
} = require("../unit");
const { getPlayableShipIds, getPlayableOperatorIds, getUnitTemplet } = require("../game-data");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getMiscItem, spendMiscItem } = require("../inventory");
const { getEquipItems } = require("../equipment");

const SHIP_MODULE_ERROR = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  INSUFFICIENT_ITEM: 111,
  WARFARE_DOING: 213,
  DIVE_DOING: 330,
  SHIP_IS_SEIZED: 20315,
  SHIP_NOT_EXISTS: 22702,
  MODULE_UNLOCK: 22707,
  INVALID_MODULE_INDEX: 22708,
  INVALID_SLOT_INDEX: 22709,
  SLOT_NULL: 22710,
  COMMAND_MODULE_TEMPLET: 22711,
  SLOT_LOCK_ALL: 22713,
  PASSIVE_TARGET: 22714,
  STAT_TARGET: 22715,
  CANDIDATE_INVALID_REQUEST: 22718,
  SLOT_NOT_NULL: 22719,
});
const DEFENCE_DECK_ERROR = Object.freeze({
  OK: 0,
  NO_SHIP: 57,
  UNIT_INVALID: 58,
  DUPLICATE_UNIT: 59,
  INVALID_GAME_TYPE: 62,
  SEIZED_SHIP: 20319,
  SEIZED_UNIT: 20320,
  NOT_EXIST: 20326,
  NOT_MODIFIED: 20327,
  EMPTY_SLOT: 20328,
  OPERATOR_INVALID: 20700,
  INVALID_REQUEST: 20191,
});

const SHIP_MODULE_STYLE = Object.freeze({ NUST_COUNTER: 1, NUST_SOLDIER: 2, NUST_MECHANIC: 3 });
const SHIP_MODULE_ROLE = Object.freeze({
  NURT_STRIKER: 1,
  NURT_RANGER: 2,
  NURT_DEFENDER: 3,
  NURT_SNIPER: 4,
  NURT_SUPPORTER: 5,
  NURT_SIEGE: 6,
  NURT_TOWER: 7,
});
const FACTOR_STAT_TYPE = Object.freeze({
  NST_HP: "NST_HP_FACTOR",
  NST_ATK: "NST_ATK_FACTOR",
  NST_DEF: "NST_DEF_FACTOR",
  NST_CRITICAL: "NST_CRITICAL_FACTOR",
  NST_HIT: "NST_HIT_FACTOR",
  NST_EVADE: "NST_EVADE_FACTOR",
});

const PACKET_NAMES = Object.freeze({
  15: "WARFARE_FRIEND_LIST_REQ",
  1447: "SHIP_SLOT_LOCK_REQ",
  1449: "SHIP_SLOT_OPTION_CHANGE_REQ",
  1451: "SHIP_SLOT_OPTION_CONFIRM_REQ",
  1453: "SHIP_SLOT_FIRST_OPTION_REQ",
  1455: "SHIP_SLOT_OPTION_CANCEL_REQ",
  1459: "RECALL_OPERATOR_REQ",
  1662: "SUPPORT_UNIT_LIST_REQ",
  1664: "SET_MY_SUPPORT_UNIT_REQ",
  1666: "SET_DUNGEON_SUPPORT_UNIT_REQ",
  2621: "UPDATE_DEFENCE_DECK_REQ",
});

function createCombatRosterHandlers() {
  return Object.keys(PACKET_NAMES).map((packetIdText) => {
    const packetId = Number(packetIdText);
    return {
      packetId,
      name: PACKET_NAMES[packetId],
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeRequest(ctx, packetId, packet.payload);
        const response = buildResponse(ctx, user, packetId, request);
        for (const spend of Array.isArray(response.resourceSpends) ? response.resourceSpends : []) {
          if (typeof ctx.trackMissionEvent === "function") {
            ctx.trackMissionEvent(user, "USE_RESOURCE", spend.count, {
              itemId: spend.itemId,
              resourceId: spend.itemId,
              value: spend.itemId,
            });
          }
        }
        console.log(`[roster:${PACKET_NAMES[packetId]}] ACK packetId=${response.packetId} ${response.log || ""}`.trim());
        sendRosterResponse(ctx, socket, packet, response);
        if (response.persist && ctx.config.USE_LOCAL_USER_DB) {
          ctx.saveUserDb();
          if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
            ctx.invalidateJoinLobbyAckPayloadCache("combat-roster-update");
          }
        }
        return true;
      },
    };
  });
}

function buildResponse(ctx, user, packetId, req) {
  switch (packetId) {
    case 15:
      return warfareFriendListAck(ctx, user, req);
    case 1410:
      return shipWithCost(1411, buildShip(user, req.shipID), `shipID=${req.shipID}`);
    case 1412:
      return shipWithCost(1413, levelShip(user, req.shipUID, req.nextLevel), `shipUID=${String(req.shipUID)} level=${req.nextLevel}`);
    case 1414:
      return shipWithCost(1415, upgradeShip(user, req.shipUID, req.nextShipID), `shipUID=${String(req.shipUID)} nextShipID=${req.nextShipID}`);
    case 1416:
      removeShips(user, req.removeShipUIDList);
      return ack(1417, Buffer.concat([writeSignedVarInt(0), writeLongArray(req.removeShipUIDList), writeNullableObjectList([])]), `removed=${req.removeShipUIDList.length}`);
    case 1424:
      return operatorLevelAck(user, req);
    case 1426:
      return operatorEnhanceAck(user, req);
    case 1428:
      return operatorLockAck(user, req);
    case 1430:
      removeOperators(user, req.removeUnitUIDList);
      return ack(1431, Buffer.concat([writeSignedVarInt(0), writeLongArray(req.removeUnitUIDList), writeNullableObjectList([])]), `removed=${req.removeUnitUIDList.length}`);
    case 1445:
      return limitBreakShipAck(user, req);
    case 1447:
      return shipModuleLockAck(ctx, user, req);
    case 1449:
      return shipModuleRollAck(ctx, user, req);
    case 1451:
      return shipModuleConfirmAck(ctx, user, req);
    case 1453:
      return shipModuleFirstOptionAck(ctx, user, req);
    case 1455:
      return shipModuleCancelAck(user, req);
    case 1459:
      return operatorRecallAck(user, req);
    case 1463:
      removeOperators(user, req.extractUnitUids);
      return ack(1464, Buffer.concat([writeSignedVarInt(0), writeLongArray(req.extractUnitUids), writeNullableObjectList([]), writeNullableObjectList([])]), `extracted=${req.extractUnitUids.length}`);
    case 1662:
      return supportListAck(ctx, user);
    case 1664:
      return setMySupportAck(user, req.unitUid);
    case 1666:
      return setDungeonSupportAck(ctx, user, req.raw);
    case 2621:
      return updateDefenceDeckAck(user, req);
    default:
      return ack(packetId + 1, writeSignedVarInt(0));
  }
}

function shipWithCost(packetId, ship, log) {
  return ack(packetId, Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildUnitData(ship)), writeNullableObjectList([])]), log);
}

function buildShip(user, shipID) {
  const shipIds = getPlayableShipIds();
  const fallbackId = shipIds[0] || 0;
  const ship = grantUnit(user, Number(shipID) || fallbackId, { level: 1 });
  return ensureShipModules(ship || ensureShip(user, 0, fallbackId));
}

function ensureShip(user, shipUid = 0, fallbackShipId = 0) {
  const army = ensureArmy(user);
  const key = String(toBigInt(shipUid));
  const existing = key !== "0" ? army.ships[key] : null;
  if (existing) return ensureShipModules(existing);
  const first = Object.values(army.ships || {})[0];
  if (first) return ensureShipModules(first);
  const shipId = Number(fallbackShipId) || (getPlayableShipIds()[0] || 0);
  return ensureShipModules(grantUnit(user, shipId, { level: 1 }));
}

function levelShip(user, shipUid, nextLevel) {
  const ship = ensureShip(user, shipUid);
  ship.level = Math.max(Number(ship.level || 1), Number(nextLevel || 1));
  return ensureShipModules(ship);
}

function upgradeShip(user, shipUid, nextShipID) {
  const ship = ensureShip(user, shipUid, nextShipID);
  if (Number(nextShipID) > 0) ship.unitId = Number(nextShipID);
  ship.level = Math.max(Number(ship.level || 1), 1);
  return ensureShipModules(ship);
}

function limitBreakShipAck(user, req) {
  const ship = ensureShip(user, req.shipUid);
  ship.limitBreakLevel = Math.max(Number(ship.limitBreakLevel || 0), Math.min(10, Number(ship.limitBreakLevel || 0) + 1));
  removeShips(user, [req.consumeShipUid]);
  return ack(
    1446,
    Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildUnitData(ensureShipModules(ship))),
      writeSignedVarLong(toBigInt(req.consumeShipUid || 0)),
      writeNullableObjectList([]),
    ]),
    `shipUID=${String(req.shipUid)} consume=${String(req.consumeShipUid)}`
  );
}

function removeShips(user, shipUids) {
  const army = ensureArmy(user);
  for (const uid of Array.isArray(shipUids) ? shipUids : []) {
    const key = String(toBigInt(uid));
    if (key === "0") continue;
    delete army.ships[key];
    for (const decks of Object.values(army.deckSets || {})) {
      for (const deck of decks) {
        if (String(toBigInt(deck.shipUid || 0)) === key) deck.shipUid = 0;
      }
    }
  }
}

function ensureShipModules(ship) {
  if (!ship) return ship;
  ship.shipCommandModules = normalizeShipCommandModules(
    ship.shipCommandModules || ship.shipModules || ship.ShipCommandModule,
    Number(ship.limitBreakLevel || 0)
  );
  return ship;
}

function shipModuleLockAck(ctx, user, req) {
  if (!req.valid) return shipModuleLockResult(SHIP_MODULE_ERROR.INVALID_REQUEST);
  const army = ensureArmy(user);
  const ship = army.ships[String(toBigInt(req.shipUid || 0))];
  if (!ship) return shipModuleLockResult(SHIP_MODULE_ERROR.SHIP_NOT_EXISTS);

  const moduleIndex = Number(req.moduleId);
  const modules = Array.isArray(ship.shipCommandModules) ? ship.shipCommandModules : [];
  if (!Number.isInteger(moduleIndex) || moduleIndex < 0 || moduleIndex >= 3) {
    return shipModuleLockResult(SHIP_MODULE_ERROR.INVALID_MODULE_INDEX);
  }
  if (moduleIndex >= modules.length || !modules[moduleIndex]) {
    return shipModuleLockResult(SHIP_MODULE_ERROR.MODULE_UNLOCK);
  }

  const slotIndex = Number(req.slotId);
  const slots = Array.isArray(modules[moduleIndex].slots) ? modules[moduleIndex].slots : [];
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 2) {
    return shipModuleLockResult(SHIP_MODULE_ERROR.INVALID_SLOT_INDEX);
  }
  if (slotIndex >= slots.length || !slots[slotIndex]) {
    return shipModuleLockResult(SHIP_MODULE_ERROR.SLOT_NULL);
  }

  const templet = getShipCommandModuleTemplet(ship, moduleIndex);
  if (!templet || !isEffectiveTagOpen(ctx, user, templet.OpenTag)) {
    return shipModuleLockResult(SHIP_MODULE_ERROR.COMMAND_MODULE_TEMPLET);
  }

  const locked = Boolean(req.locked);
  if (Boolean(slots[slotIndex].isLock) === locked) return shipModuleLockResult(0, ship);
  if (locked && slots.every((slot, index) => index === slotIndex || Boolean(slot && slot.isLock))) {
    return shipModuleLockResult(SHIP_MODULE_ERROR.SLOT_LOCK_ALL);
  }

  const costItems = [];
  const resourceSpends = [];
  if (locked) {
    const itemId = Number(templet[`ModuleSlot${slotIndex + 1}_LockItemID`] || 0);
    const count = Math.max(0, Number(templet[`ModuleSlot${slotIndex + 1}_LockItemValue`] || 0) || 0);
    if (itemId <= 0 || count <= 0) return shipModuleLockResult(SHIP_MODULE_ERROR.COMMAND_MODULE_TEMPLET);
    const balance = getMiscItem(user, itemId);
    if (toBigInt(balance.countFree) + toBigInt(balance.countPaid) < BigInt(count)) {
      return shipModuleLockResult(SHIP_MODULE_ERROR.INSUFFICIENT_ITEM);
    }
    costItems.push(spendMiscItem(user, itemId, count));
    resourceSpends.push({ itemId, count });
  }

  slots[slotIndex].isLock = locked;
  return shipModuleLockResult(0, ship, costItems, true, resourceSpends);
}

function shipModuleLockResult(errorCode, ship = null, costItems = [], changed = false, resourceSpends = []) {
  return {
    ...ack(1448, Buffer.concat([
      writeSignedVarInt(errorCode),
      ship ? writeNullableObject(buildUnitData(ship)) : writeNullObject(),
      writeNullableObjectList(costItems.filter(Boolean).map(buildItemMiscData)),
    ]), `error=${errorCode} shipUID=${String(ship && ship.unitUid || 0)}`, changed),
    resourceSpends,
  };
}

function getShipCommandModuleTemplet(ship, moduleIndex) {
  const unitTemplet = getUnitTemplet(ship && ship.unitId);
  if (!unitTemplet) return null;
  return readGameplayTableRecords("ab_script", "LUA_COMMANDMODULE_TEMPLET")
    .find((row) => String(row.ShipType || "") === String(unitTemplet.m_NKM_UNIT_STYLE_TYPE || "")
      && String(row.ShipGrade || "") === String(unitTemplet.m_NKM_UNIT_GRADE || "")
      && Number(row.ShipLimitBreakGrade) === moduleIndex + 1) || null;
}

function isEffectiveTagOpen(ctx, user, requiredTag) {
  const expected = String(requiredTag || "").toUpperCase();
  if (!expected) return true;
  const userTags = Array.isArray(user && user.openTags) ? user.openTags : [];
  if (userTags.some((tag) => String(tag || "").toUpperCase() === expected)) return true;
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return false;
  return (ctx.getEffectiveOpenTags(userTags) || []).some((tag) => String(tag || "").toUpperCase() === expected);
}

function shipModuleRollAck(ctx, user, req) {
  const target = validateShipModuleTarget(ctx, user, req);
  if (target.errorCode !== SHIP_MODULE_ERROR.OK) return shipModuleRollResult(target.errorCode);
  const { ship, moduleIndex, module, templet } = target;
  if (module.slots.some((slot) => !slot)) return shipModuleRollResult(SHIP_MODULE_ERROR.SLOT_NULL);
  if (module.slots.every((slot) => Boolean(slot.isLock))) return shipModuleRollResult(SHIP_MODULE_ERROR.SLOT_LOCK_ALL);

  const pending = user.pendingShipModuleCandidate;
  if (pending && !isMatchingShipModuleCandidate(pending, ship, moduleIndex)) {
    return shipModuleRollResult(SHIP_MODULE_ERROR.CANDIDATE_INVALID_REQUEST);
  }

  const rolled = rollShipModuleCandidate(ctx, templet, module);
  if (rolled.errorCode !== SHIP_MODULE_ERROR.OK) return shipModuleRollResult(rolled.errorCode);
  const costs = getShipModuleRollCosts(templet);
  if (!costs || !hasShipModuleRollCosts(user, costs)) {
    return shipModuleRollResult(costs ? SHIP_MODULE_ERROR.INSUFFICIENT_ITEM : SHIP_MODULE_ERROR.COMMAND_MODULE_TEMPLET);
  }

  const costItems = costs.map(({ itemId, count }) => spendMiscItem(user, itemId, count));
  const candidate = {
    shipUid: String(toBigInt(ship.unitUid)),
    moduleId: moduleIndex,
    module: rolled.module,
  };
  user.pendingShipModuleCandidate = candidate;
  return shipModuleRollResult(SHIP_MODULE_ERROR.OK, ship, candidate, costItems, true, costs);
}

function shipModuleConfirmAck(ctx, user, req) {
  const target = validateShipModuleTarget(ctx, user, req);
  if (target.errorCode !== SHIP_MODULE_ERROR.OK) return shipModuleShipResult(1452, target.errorCode);
  const pending = user.pendingShipModuleCandidate;
  if (!isMatchingShipModuleCandidate(pending, target.ship, target.moduleIndex) || !isCompleteShipModule(pending.module)) {
    return shipModuleShipResult(1452, SHIP_MODULE_ERROR.CANDIDATE_INVALID_REQUEST);
  }
  target.ship.shipCommandModules[target.moduleIndex] = normalizeCandidateModule(pending.module);
  clearPendingShipModuleCandidate(user);
  return shipModuleShipResult(1452, SHIP_MODULE_ERROR.OK, target.ship, true);
}

function shipModuleFirstOptionAck(ctx, user, req) {
  const target = validateShipModuleTarget(ctx, user, req);
  if (target.errorCode !== SHIP_MODULE_ERROR.OK) return shipModuleShipResult(1454, target.errorCode);
  if (target.module.slots.some((slot) => slot)) return shipModuleShipResult(1454, SHIP_MODULE_ERROR.SLOT_NOT_NULL);
  if (user.pendingShipModuleCandidate) return shipModuleShipResult(1454, SHIP_MODULE_ERROR.CANDIDATE_INVALID_REQUEST);
  const rolled = rollShipModuleCandidate(ctx, target.templet, target.module);
  if (rolled.errorCode !== SHIP_MODULE_ERROR.OK) return shipModuleShipResult(1454, rolled.errorCode);
  target.ship.shipCommandModules[target.moduleIndex] = rolled.module;
  return shipModuleShipResult(1454, SHIP_MODULE_ERROR.OK, target.ship, true);
}

function shipModuleCancelAck(user, req) {
  if (!req.valid) return ack(1456, writeSignedVarInt(SHIP_MODULE_ERROR.INVALID_REQUEST), "error=20191", false);
  const changed = Boolean(user && user.pendingShipModuleCandidate);
  clearPendingShipModuleCandidate(user);
  return ack(1456, writeSignedVarInt(SHIP_MODULE_ERROR.OK), `candidate=${changed ? "cleared" : "empty"}`, changed);
}

function clearPendingShipModuleCandidate(user) {
  if (user && Object.prototype.hasOwnProperty.call(user, "pendingShipModuleCandidate")) delete user.pendingShipModuleCandidate;
}

function validateShipModuleTarget(ctx, user, req) {
  if (!req || !req.valid) return { errorCode: SHIP_MODULE_ERROR.INVALID_REQUEST };
  const ship = ensureArmy(user).ships[String(toBigInt(req.shipUid || 0))];
  if (!ship) return { errorCode: SHIP_MODULE_ERROR.SHIP_NOT_EXISTS };
  const moduleIndex = Number(req.moduleId);
  if (!Number.isInteger(moduleIndex) || moduleIndex < 0 || moduleIndex >= 3) {
    return { errorCode: SHIP_MODULE_ERROR.INVALID_MODULE_INDEX };
  }
  const modules = Array.isArray(ship.shipCommandModules) ? ship.shipCommandModules : [];
  if (moduleIndex >= modules.length || !modules[moduleIndex]) return { errorCode: SHIP_MODULE_ERROR.MODULE_UNLOCK };
  const templet = getShipCommandModuleTemplet(ship, moduleIndex);
  if (!templet || !isEffectiveTagOpen(ctx, user, templet.OpenTag)) {
    return { errorCode: SHIP_MODULE_ERROR.COMMAND_MODULE_TEMPLET };
  }
  if (ship.isSeized) return { errorCode: SHIP_MODULE_ERROR.SHIP_IS_SEIZED };
  const deckError = shipModuleDeckError(user, ship.unitUid);
  if (deckError !== SHIP_MODULE_ERROR.OK) return { errorCode: deckError };
  const module = modules[moduleIndex];
  if (!Array.isArray(module.slots) || module.slots.length !== 2) return { errorCode: SHIP_MODULE_ERROR.SLOT_NULL };
  return { errorCode: SHIP_MODULE_ERROR.OK, ship, moduleIndex, module, templet };
}

function shipModuleDeckError(user, shipUid) {
  const key = String(toBigInt(shipUid || 0));
  const army = user && user.army && typeof user.army === "object" ? user.army : {};
  const deckSets = Object.values(army.deckSets || {}).filter(Array.isArray);
  const legacyDecks = Array.isArray(army.decks) ? [army.decks] : [];
  for (const deck of deckSets.concat(legacyDecks).flat()) {
    if (String(toBigInt(deck && (deck.shipUid || deck.m_ShipUID) || 0)) !== key) continue;
    const state = Number(deck && (deck.state != null ? deck.state : deck.m_DeckState) || 0);
    if (state === 2) return SHIP_MODULE_ERROR.WARFARE_DOING;
    if (state === 3) return SHIP_MODULE_ERROR.DIVE_DOING;
  }
  return SHIP_MODULE_ERROR.OK;
}

function shipModuleRollResult(errorCode, ship = null, candidate = null, costItems = [], changed = false, resourceSpends = []) {
  return {
    ...ack(1450, Buffer.concat([
      writeSignedVarInt(errorCode),
      ship ? writeNullableObject(buildUnitData(ship)) : writeNullObject(),
      candidate ? writeNullableObject(buildShipModuleCandidateData(candidate)) : writeNullObject(),
      writeNullableObjectList(costItems.filter(Boolean).map(buildItemMiscData)),
    ]), `error=${errorCode} shipUID=${String(ship && ship.unitUid || 0)}`, changed),
    resourceSpends,
  };
}

function shipModuleShipResult(packetId, errorCode, ship = null, changed = false) {
  return ack(packetId, Buffer.concat([
    writeSignedVarInt(errorCode),
    ship ? writeNullableObject(buildUnitData(ship)) : writeNullObject(),
  ]), `error=${errorCode} shipUID=${String(ship && ship.unitUid || 0)}`, changed);
}

function isMatchingShipModuleCandidate(candidate, ship, moduleIndex) {
  return Boolean(candidate && String(toBigInt(candidate.shipUid || 0)) === String(toBigInt(ship && ship.unitUid || 0))
    && Number(candidate.moduleId) === moduleIndex);
}

function isCompleteShipModule(module) {
  return Boolean(module && Array.isArray(module.slots) && module.slots.length === 2 && module.slots.every(Boolean));
}

function normalizeCandidateModule(module) {
  return {
    slots: module.slots.map((slot) => ({
      targetStyleType: Array.isArray(slot.targetStyleType) ? slot.targetStyleType.slice() : [],
      targetRoleType: Array.isArray(slot.targetRoleType) ? slot.targetRoleType.slice() : [],
      statType: slot.statType,
      statValue: Number(slot.statValue || 0),
      isLock: Boolean(slot.isLock),
    })),
  };
}

function getShipModuleRollCosts(templet) {
  const merged = new Map();
  for (let index = 1; index <= 2; index += 1) {
    const itemId = Number(templet && templet[`ModuleReqItemID${index}`] || 0);
    const count = Math.trunc(Number(templet && templet[`ModuleReqItemValue${index}`] || 0));
    if (itemId <= 0 || count <= 0) return null;
    merged.set(itemId, (merged.get(itemId) || 0) + count);
  }
  return Array.from(merged, ([itemId, count]) => ({ itemId, count }));
}

function hasShipModuleRollCosts(user, costs) {
  return costs.every(({ itemId, count }) => {
    const item = getMiscItem(user, itemId);
    return item && toBigInt(item.countFree) + toBigInt(item.countPaid) >= BigInt(count);
  });
}

function rollShipModuleCandidate(ctx, templet, currentModule) {
  const slots = [];
  for (let slotIndex = 0; slotIndex < 2; slotIndex += 1) {
    const current = currentModule && Array.isArray(currentModule.slots) ? currentModule.slots[slotIndex] : null;
    if (current && current.isLock) {
      slots.push(cloneShipModuleSlot(current));
      continue;
    }
    const passiveGroupId = Number(templet && templet[`CommandModuleSlot${slotIndex + 1}`] || 0);
    const passives = readGameplayTableRecords("ab_script", "LUA_COMMANDMODULE_PASSIVE_TEMPLET")
      .filter((row) => Number(row.CMDPassiveGroupID) === passiveGroupId && Number(row.Ratio) > 0);
    const passive = weightedShipModulePassive(ctx, passives);
    if (!passive) return { errorCode: SHIP_MODULE_ERROR.PASSIVE_TARGET };
    const stats = readGameplayTableRecords("ab_script", "LUA_COMMANDMODULE_RANDOM_STAT")
      .filter((row) => Number(row.StatGroupID) === Number(passive.StatGroupID));
    const stat = stats[shipModuleRandomInt(ctx, stats.length)];
    if (!stat) return { errorCode: SHIP_MODULE_ERROR.STAT_TARGET };
    const values = shipModuleCandidateValues(stat);
    if (values.length === 0) return { errorCode: SHIP_MODULE_ERROR.STAT_TARGET };
    slots.push({
      targetStyleType: enumValues(passive.ListRangeSonAllowStyleType, SHIP_MODULE_STYLE),
      targetRoleType: enumValues(passive.ListRangeSonAllowRoleType, SHIP_MODULE_ROLE),
      statType: factorShipModuleStatType(stat),
      statValue: values[shipModuleRandomInt(ctx, values.length)],
      isLock: false,
    });
  }
  return { errorCode: SHIP_MODULE_ERROR.OK, module: { slots } };
}

function cloneShipModuleSlot(slot) {
  return {
    targetStyleType: Array.isArray(slot.targetStyleType) ? slot.targetStyleType.slice() : [],
    targetRoleType: Array.isArray(slot.targetRoleType) ? slot.targetRoleType.slice() : [],
    statType: slot.statType,
    statValue: Number(slot.statValue || 0),
    isLock: Boolean(slot.isLock),
  };
}

function weightedShipModulePassive(ctx, passives) {
  const total = passives.reduce((sum, row) => sum + Math.max(0, Math.trunc(Number(row.Ratio) || 0)), 0);
  if (total <= 0) return null;
  const roll = shipModuleRandomInt(ctx, total);
  let cursor = 0;
  for (const passive of passives) {
    cursor += Math.max(0, Math.trunc(Number(passive.Ratio) || 0));
    if (roll < cursor) return passive;
  }
  return null;
}

function shipModuleCandidateValues(stat) {
  const hasFactor = Number(stat.MinStatFactor || 0) !== 0 || Number(stat.MaxStatFactor || 0) !== 0;
  const min = Number(hasFactor ? stat.MinStatFactor : stat.MinStatValue);
  const max = Number(hasFactor ? stat.MaxStatFactor : stat.MaxStatValue);
  const control = Number(hasFactor ? stat.StatFactorControl : stat.StatValueControl);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(control) || min === 0 || max === 0 || control <= 0) return [];
  const result = [];
  for (let value = min; value <= max + 0.0000001; value = Math.round((value + control) * 10000) / 10000) {
    result.push(value);
    if (result.length > 10000) return [];
  }
  return result;
}

function factorShipModuleStatType(stat) {
  const statType = String(stat && stat.StatType || "NST_RANDOM");
  return Number(stat && (stat.MinStatFactor || stat.MaxStatFactor) || 0) !== 0 ? FACTOR_STAT_TYPE[statType] || statType : statType;
}

function enumValues(values, mapping) {
  return (Array.isArray(values) ? values : []).map((value) => mapping[String(value)]).filter((value) => Number.isInteger(value));
}

function shipModuleRandomInt(ctx, max) {
  if (!Number.isInteger(max) || max <= 0) return 0;
  if (ctx && typeof ctx.randomInt === "function") {
    const value = Math.trunc(Number(ctx.randomInt(max)) || 0);
    return Math.max(0, Math.min(max - 1, value));
  }
  return cryptoRandomInt(max);
}

function operatorLevelAck(user, req) {
  const operator = ensureOperator(user, req.targetUnitUid);
  operator.level = Math.max(Number(operator.level || 1), Math.min(110, Number(operator.level || 1) + 1));
  return ack(1425, Buffer.concat([writeSignedVarInt(0), writeNullableObjectList([]), writeNullableObject(buildOperatorData(operator))]), `operatorUid=${String(operator.uid)} level=${operator.level}`);
}

function operatorEnhanceAck(user, req) {
  const army = ensureArmy(user);
  const operator = ensureOperator(user, req.targetUnitUid);
  if (req.transSkill && req.tokenItemId > 0) {
    operator.subSkill = operator.subSkill || { id: req.tokenItemId, level: 1, exp: 0 };
    operator.subSkill.id = req.tokenItemId;
  } else {
    operator.level = Math.max(Number(operator.level || 1), Math.min(110, Number(operator.level || 1) + 1));
  }
  if (toBigInt(req.sourceUnitUid) > 0n && String(toBigInt(req.sourceUnitUid)) !== String(toBigInt(operator.uid))) {
    delete army.operators[String(toBigInt(req.sourceUnitUid))];
  }
  return ack(
    1427,
    Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildOperatorData(operator)),
      writeNullableObjectList([]),
      writeSignedVarLong(toBigInt(req.sourceUnitUid || 0)),
      writeBool(Boolean(req.transSkill)),
      writeSignedVarInt(Number(req.tokenItemId || 0)),
    ]),
    `operatorUid=${String(operator.uid)} source=${String(req.sourceUnitUid)}`
  );
}

function operatorLockAck(user, req) {
  const operator = ensureOperator(user, req.unitUID);
  operator.locked = Boolean(req.locked);
  return ack(1429, Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(toBigInt(operator.uid)), writeBool(operator.locked)]), `operatorUid=${String(operator.uid)} locked=${operator.locked ? 1 : 0}`);
}

function operatorRecallAck(user, req) {
  const army = ensureArmy(user);
  const recalled = ensureOperator(user, req.recallOperatorUid);
  delete army.operators[String(toBigInt(recalled.uid))];
  const exchangeId = Number(req.exchangeOperatorId) || Number(recalled.id || 0) || (getPlayableOperatorIds()[0] || 0);
  const replacement = grantOperator(user, exchangeId, { subSkillId: Number(req.exchangeSubSkillId || 0) || undefined }) || ensureOperator(user, 0);
  const historyInfo = Buffer.concat([writeSignedVarInt(exchangeId), writeInt64LE(toBigInt(dateTimeBinaryNow()))]);
  return ack(
    1460,
    Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(recalled.uid || 0)),
      writeNullableObject(buildOperatorData(replacement)),
      writeNullableObject(historyInfo),
    ]),
    `removed=${String(recalled.uid)} exchange=${exchangeId}`
  );
}

function ensureOperator(user, operatorUid = 0) {
  const army = ensureArmy(user);
  const key = String(toBigInt(operatorUid));
  const existing = key !== "0" ? army.operators[key] : null;
  if (existing) return existing;
  const first = Object.values(army.operators || {})[0];
  if (first) return first;
  return grantOperator(user, getPlayableOperatorIds()[0] || 0, { level: 1 });
}

function removeOperators(user, operatorUids) {
  const army = ensureArmy(user);
  for (const uid of Array.isArray(operatorUids) ? operatorUids : []) {
    const key = String(toBigInt(uid));
    if (key === "0") continue;
    delete army.operators[key];
    for (const decks of Object.values(army.deckSets || {})) {
      for (const deck of decks) {
        if (String(toBigInt(deck.operatorUid || 0)) === key) deck.operatorUid = 0;
      }
    }
  }
}

function supportListAck(ctx, user) {
  const profiles = getAvailableSupportUsers(ctx, user).map(({ user: supporter, unit }) => buildSupportUnitProfileData(supporter, unit));
  return ack(1663, Buffer.concat([writeSignedVarInt(0), writeNullableObjectList(profiles)]), `supports=${profiles.length}`, false);
}

function setMySupportAck(user, unitUid) {
  const requestedUid = toBigInt(unitUid || 0);
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  const hadSavedSelection = Object.prototype.hasOwnProperty.call(user.support, "mySupportUnitUid");
  const previousUid = hadSavedSelection ? String(toBigInt(user.support.mySupportUnitUid)) : "0";
  const current = getUnitForSupport(user, previousUid) || (!hadSavedSelection ? getArmyUnits(user)[0] || null : null);
  if (requestedUid !== 0n && !getUnitForSupport(user, requestedUid)) {
    return ack(
      1665,
      Buffer.concat([writeSignedVarInt(136), current ? writeNullableObject(buildSupportUnitData(user, current)) : writeNullObject()]),
      `unitUid=${String(requestedUid)} error=136`,
      false
    );
  }
  const supportUnit = requestedUid === 0n ? null : getUnitForSupport(user, requestedUid);
  const nextUid = supportUnit ? String(toBigInt(supportUnit.unitUid)) : "0";
  const changed = !hadSavedSelection || previousUid !== nextUid;
  user.support.mySupportUnitUid = nextUid;
  if (changed) user.support.mySupportUnitUpdatedAt = new Date().toISOString();
  return ack(
    1665,
    Buffer.concat([writeSignedVarInt(0), supportUnit ? writeNullableObject(buildSupportUnitData(user, supportUnit)) : writeNullObject()]),
    `unitUid=${user.support.mySupportUnitUid}`,
    changed
  );
}

function setDungeonSupportAck(ctx, user, rawRequestPayload) {
  const raw = Buffer.isBuffer(rawRequestPayload) ? rawRequestPayload : Buffer.from(rawRequestPayload || []);
  const parsed = decodeDungeonSupportSelection(raw);
  if (parsed.userUid === "0" && parsed.deckIndex) {
    const payload = buildClearDungeonSupportPayload(parsed.deckIndex);
    if (!raw.equals(payload)) return dungeonSupportError(27804);
    return ack(1667, Buffer.concat([writeSignedVarInt(0), payload]), "support=cleared", persistDungeonSupportSelection(user, payload));
  }
  const supporter = getAvailableSupportUsers(ctx, user).find((entry) => String(entry.user.userUid) === parsed.userUid);
  if (!supporter) return dungeonSupportError(27803);
  if (!parsed.deckIndex || parsed.deckIndex.deckType < 0 || parsed.deckIndex.deckType > 10 || parsed.deckIndex.index < 0 || parsed.deckIndex.index > 255) {
    return dungeonSupportError(27804);
  }
  const payload = writeNullableObject(buildDungeonSupportData(supporter.user, supporter.unit, parsed.deckIndex));
  if (!raw.equals(payload)) return dungeonSupportError(27804);
  return ack(
    1667,
    Buffer.concat([writeSignedVarInt(0), payload]),
    `supportUserUid=${parsed.userUid} deck=${parsed.deckIndex.deckType}:${parsed.deckIndex.index}`,
    persistDungeonSupportSelection(user, payload)
  );
}

function dungeonSupportError(errorCode) {
  return ack(1667, Buffer.concat([writeSignedVarInt(errorCode), writeNullObject()]), `error=${errorCode}`, false);
}

function buildClearDungeonSupportPayload(deckIndex = { deckType: 0, index: 0 }) {
  return writeNullableObject(Buffer.concat([
    writeSignedVarLong(0n),
    writeNullObject(),
    writeNullableObject(buildDeckIndexData(deckIndex)),
  ]));
}

function persistDungeonSupportSelection(user, rawRequestPayload) {
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  const raw = Buffer.isBuffer(rawRequestPayload) ? rawRequestPayload : Buffer.from(rawRequestPayload || []);
  const parsed = decodeDungeonSupportSelection(raw);
  if (parsed.userUid === "0") {
    const changed = Boolean(user.support.dungeonSupportRaw || user.support.dungeonSupportUserUid || user.support.dungeonSupportDeckIndex);
    delete user.support.dungeonSupportRaw;
    delete user.support.dungeonSupportUserUid;
    delete user.support.dungeonSupportDeckIndex;
    if (changed) user.support.dungeonSupportUpdatedAt = new Date().toISOString();
    return changed;
  }
  const encoded = raw.toString("base64");
  const nextDeckIndex = parsed.deckIndex || null;
  const changed = user.support.dungeonSupportRaw !== encoded || user.support.dungeonSupportUserUid !== parsed.userUid ||
    JSON.stringify(user.support.dungeonSupportDeckIndex || null) !== JSON.stringify(nextDeckIndex);
  user.support.dungeonSupportRaw = encoded;
  if (parsed.userUid) user.support.dungeonSupportUserUid = parsed.userUid;
  if (nextDeckIndex) user.support.dungeonSupportDeckIndex = nextDeckIndex;
  if (changed) user.support.dungeonSupportUpdatedAt = new Date().toISOString();
  return changed;
}

function decodeDungeonSupportSelection(rawRequestPayload) {
  if (!rawRequestPayload || !rawRequestPayload.length) return { userUid: "", deckIndex: null };
  let objectOffset = 0;
  try {
    const present = readBool(rawRequestPayload, 0);
    if (!present.value && rawRequestPayload.length === present.offset) return { userUid: "0", deckIndex: null };
    if (present.value) objectOffset = present.offset;
  } catch (_) {
    objectOffset = 0;
  }

  try {
    const userUid = readSignedVarLong(rawRequestPayload, objectOffset);
    return {
      userUid: String(toBigInt(userUid.value || 0)),
      deckIndex: decodeDeckIndexFromTail(rawRequestPayload),
    };
  } catch (_) {
    if (objectOffset !== 0) {
      try {
        const userUid = readSignedVarLong(rawRequestPayload, 0);
        return {
          userUid: String(toBigInt(userUid.value || 0)),
          deckIndex: decodeDeckIndexFromTail(rawRequestPayload),
        };
      } catch (_) {
        return { userUid: "", deckIndex: null };
      }
    }
    return { userUid: "", deckIndex: null };
  }
}

function decodeDeckIndexFromTail(rawRequestPayload) {
  const start = Math.max(0, rawRequestPayload.length - 12);
  let nullDeckIndex = null;
  for (let offset = start; offset < rawRequestPayload.length; offset += 1) {
    try {
      const present = readBool(rawRequestPayload, offset);
      if (!present.value) {
        if (present.offset === rawRequestPayload.length) nullDeckIndex = { deckType: 0, index: 0 };
        continue;
      }
      const deckType = readSignedVarInt(rawRequestPayload, present.offset);
      const index = readByte(rawRequestPayload, deckType.offset);
      if (index.offset === rawRequestPayload.length) {
        return {
          deckType: Number(deckType.value || 0),
          index: Number(index.value || 0),
        };
      }
    } catch (_) {
      // Try the next possible tail offset.
    }
  }
  return nullDeckIndex;
}

function decodeDefenceDeckRequest(payload, decryptFailed = false) {
  try {
    if (decryptFailed || !Buffer.isBuffer(payload) || payload.length < 1 || payload[0] > 1) {
      return { valid: false, deck: null };
    }
    if (payload[0] === 0) return { valid: payload.length === 1, deck: null };
    let offset = 1;
    let field = readString(payload, offset);
    const name = field.value;
    offset = field.offset;
    field = readSignedVarLong(payload, offset);
    const shipUid = field.value;
    offset = field.offset;
    field = readSignedVarLong(payload, offset);
    const operatorUid = field.value;
    offset = field.offset;
    field = readSignedVarLongList(payload, offset);
    const unitUids = field.value;
    offset = field.offset;
    field = readSByte(payload, offset);
    const leaderIndex = field.value;
    offset = field.offset;
    field = readSignedVarInt(payload, offset);
    const state = field.value;
    offset = field.offset;
    const deck = { deckType: 6, index: 0, name, shipUid, operatorUid, unitUids, leaderIndex, state };
    const canonical = writeNullableObject(buildDeckData(deck));
    return { valid: offset === payload.length && canonical.equals(payload), deck };
  } catch (_) {
    return { valid: false, deck: null };
  }
}

function updateDefenceDeckAck(user, request) {
  if (!request || !request.valid) return defenceDeckFailure(DEFENCE_DECK_ERROR.INVALID_REQUEST);
  if (!request.deck) return defenceDeckFailure(DEFENCE_DECK_ERROR.NOT_EXIST);
  const errorCode = validateDefenceDeck(user, request.deck);
  if (errorCode !== DEFENCE_DECK_ERROR.OK) return defenceDeckFailure(errorCode);

  const current = user && user.army && user.army.deckSets && Array.isArray(user.army.deckSets["6"])
    ? user.army.deckSets["6"][0]
    : null;
  if (current && buildDeckData({ ...current, deckType: 6 }).equals(buildDeckData(request.deck))) {
    return defenceDeckFailure(DEFENCE_DECK_ERROR.NOT_MODIFIED);
  }

  const deck = ensureDeck(user, { deckType: 6, index: 0 });
  deck.name = request.deck.name;
  deck.shipUid = String(request.deck.shipUid);
  deck.operatorUid = request.deck.operatorUid > 0n ? String(request.deck.operatorUid) : 0;
  deck.unitUids = request.deck.unitUids.map(String);
  deck.leaderIndex = request.deck.leaderIndex;
  deck.state = request.deck.state;
  return ack(
    2622,
    Buffer.concat([writeSignedVarInt(DEFENCE_DECK_ERROR.OK), writeNullableObject(buildDeckData(deck))]),
    `ship=${deck.shipUid} units=${deck.unitUids.length}`
  );
}

function validateDefenceDeck(user, deck) {
  if (Number(deck.state) !== 0) return DEFENCE_DECK_ERROR.INVALID_GAME_TYPE;
  if (!Array.isArray(deck.unitUids) || deck.unitUids.length !== 8 || deck.unitUids.some((uid) => uid <= 0n)) {
    return DEFENCE_DECK_ERROR.EMPTY_SLOT;
  }
  if (!Number.isInteger(deck.leaderIndex) || deck.leaderIndex < 0 || deck.leaderIndex >= 8) {
    return DEFENCE_DECK_ERROR.UNIT_INVALID;
  }

  const army = user && user.army && typeof user.army === "object" ? user.army : {};
  const ship = army.ships && army.ships[String(deck.shipUid)];
  if (!ship) return DEFENCE_DECK_ERROR.NO_SHIP;
  if (isSeized(ship)) return DEFENCE_DECK_ERROR.SEIZED_SHIP;
  if (deck.operatorUid > 0n && !(army.operators && army.operators[String(deck.operatorUid)])) {
    return DEFENCE_DECK_ERROR.OPERATOR_INVALID;
  }

  const seenUids = new Set();
  const seenBaseUnits = new Set();
  for (const uid of deck.unitUids) {
    const key = String(uid);
    const unit = army.units && army.units[key];
    if (!unit) return DEFENCE_DECK_ERROR.UNIT_INVALID;
    if (isSeized(unit)) return DEFENCE_DECK_ERROR.SEIZED_UNIT;
    const baseId = getBaseUnitId(unit.unitId || unit.m_UnitID);
    if (seenUids.has(key) || seenBaseUnits.has(baseId)) return DEFENCE_DECK_ERROR.DUPLICATE_UNIT;
    seenUids.add(key);
    seenBaseUnits.add(baseId);
  }
  return DEFENCE_DECK_ERROR.OK;
}

function defenceDeckFailure(errorCode) {
  return ack(
    2622,
    Buffer.concat([writeSignedVarInt(errorCode), writeNullObject()]),
    `errorCode=${errorCode}`,
    false
  );
}

function getBaseUnitId(unitId) {
  let id = Number(unitId) || 0;
  const seen = new Set();
  while (id > 0 && !seen.has(id)) {
    seen.add(id);
    const templet = getUnitTemplet(id);
    const baseId = Number(templet && templet.m_BaseUnitID) || 0;
    if (baseId <= 0 || baseId === id) break;
    id = baseId;
  }
  return id;
}

function isSeized(unit) {
  return Boolean(unit && (unit.isSeized || unit.IsSeized));
}

function ensureSupportUnit(user) {
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  hydratePersistedDungeonSupportSelection(user);
  const saved = user.support.mySupportUnitUid;
  if (saved != null && String(toBigInt(saved)) === "0") return null;
  const unit = getUnitForSupport(user, saved) || (saved == null ? getArmyUnits(user)[0] || null : null);
  if (unit) {
    user.support.mySupportUnitUid = String(toBigInt(unit.unitUid));
  } else if (saved != null && String(toBigInt(saved)) !== "0") {
    user.support.mySupportUnitUid = "0";
  }
  return unit;
}

function getAvailableSupportUsers(ctx, user) {
  const selfUid = String(user && user.userUid || "0");
  const ownCommunity = user && user.community && typeof user.community === "object" ? user.community : {};
  const friends = new Set((Array.isArray(ownCommunity.friends) ? ownCommunity.friends : []).map(String));
  const blocked = new Set((Array.isArray(ownCommunity.blocked) ? ownCommunity.blocked : []).map(String));
  const users = ctx && ctx.userDb && ctx.userDb.users && typeof ctx.userDb.users === "object"
    ? Object.values(ctx.userDb.users)
    : [];
  return users
    .filter((candidate) => {
      const candidateUid = String(candidate && candidate.userUid || "0");
      const candidateCommunity = candidate && candidate.community && typeof candidate.community === "object" ? candidate.community : {};
      return candidateUid !== "0" && candidateUid !== selfUid && !blocked.has(candidateUid) &&
        !(Array.isArray(candidateCommunity.blocked) && candidateCommunity.blocked.map(String).includes(selfUid));
    })
    .map((candidate) => ({
      user: candidate,
      unit: getUnitForSupport(candidate, candidate && candidate.support && candidate.support.mySupportUnitUid),
    }))
    .filter((entry) => entry.unit)
    .sort((left, right) => {
      const leftFriend = friends.has(String(left.user.userUid)) ? 0 : 1;
      const rightFriend = friends.has(String(right.user.userUid)) ? 0 : 1;
      return leftFriend - rightFriend || String(left.user.userUid).localeCompare(String(right.user.userUid));
    });
}

function hydratePersistedDungeonSupportSelection(user) {
  const support = user && user.support && typeof user.support === "object" ? user.support : null;
  if (!support || !support.dungeonSupportRaw || support.dungeonSupportUserUid) return;
  try {
    const parsed = decodeDungeonSupportSelection(Buffer.from(String(support.dungeonSupportRaw), "base64"));
    if (parsed.userUid && parsed.userUid !== "0") support.dungeonSupportUserUid = parsed.userUid;
    if (parsed.deckIndex) support.dungeonSupportDeckIndex = parsed.deckIndex;
  } catch (_) {
    // Keep the legacy raw value; it can still be echoed back on the next selection.
  }
}

function getUnitForSupport(user, unitUid) {
  const army = ensureArmy(user);
  const key = String(toBigInt(unitUid));
  return key !== "0" ? army.units[key] || null : null;
}

function buildSupportUnitProfileData(user, unit) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeNullableObject(buildGuildSimpleData(user)),
    writeNullableObject(buildSupportUnitData(user, unit)),
  ]);
}

function buildSupportUnitData(user, unit) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeNullableObject(buildAsyncUnitEquipData(user, unit)),
    writeSignedVarLong(toBigInt(user.support && user.support.usedCount ? user.support.usedCount : 0)),
  ]);
}

function buildDungeonSupportData(user, unit, deckIndex) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeNullableObject(buildAsyncUnitEquipData(user, unit)),
    writeNullableObject(buildDeckIndexData(deckIndex || { deckType: 1, index: 0 })),
  ]);
}

function buildAsyncUnitEquipData(user, unit) {
  const unitUid = unit ? String(toBigInt(unit.unitUid || 0)) : "0";
  const equips = unitUid === "0" ? [] : getEquipItems(user).filter((equip) => String(toBigInt(equip.ownerUnitUid || 0)) === unitUid);
  return Buffer.concat([
    writeNullableObject(buildAsyncUnitData(unit)),
    writeNullableObjectList(equips.map(buildEquipItemData)),
  ]);
}

function buildAsyncUnitData(unit) {
  const data = unit || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid || 0)),
    writeSignedVarInt(Number(data.unitId || 0) || 0),
    writeSignedVarInt(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.skinId || 0) || 0),
    writeSignedVarInt(Number(data.limitBreakLevel || 0) || 0),
    writeIntList(normalizeFixedArray(data.skillLevels, 5, 1)),
    writeIntList(normalizeFixedArray(data.statExp, 6, 0)),
    writeLongArray(normalizeFixedArray(data.equipItemUids, 4, 0)),
    writeNullableObjectList((data.shipCommandModules || data.shipModules || []).map(buildShipCmdModuleData)),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function buildCommonProfileData(user) {
  user = user || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeSignedVarLong(toBigInt(user.friendCode || 0)),
    writeString(user.nickname || "LocalAdmin"),
    writeSignedVarInt(Number(user.level || 1) || 1),
    writeSignedVarInt(Number(user.mainUnitId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitSkinId || 0) || 0),
    writeSignedVarInt(Number(user.frameId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitTacticLevel || 0) || 0),
    writeSignedVarInt(Number(user.titleId || 0) || 0),
  ]);
}

function buildGuildSimpleData(user) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.guildUid || 0)),
    writeString(user.guildName || ""),
    writeSignedVarLong(toBigInt(user.guildBadgeId || 0)),
  ]);
}

function warfareFriendListAck(ctx, user, req) {
  const errorCode = req && req.valid === false ? 20190 : 0;
  const supporters = errorCode ? { friends: [], guests: [] } : getWarfareSupportUsers(ctx, user);
  return ack(16, Buffer.concat([
    writeSignedVarInt(errorCode),
    writeNullableObjectList(supporters.friends.map(({ user: supporter, unit }) => buildWarfareSupporter(supporter, unit))),
    writeNullableObjectList(supporters.guests.map(({ user: supporter, unit }) => buildWarfareSupporter(supporter, unit))),
  ]), `friends=${supporters.friends.length} guests=${supporters.guests.length}`, false);
}

function getWarfareSupportUsers(ctx, user) {
  const friendUids = new Set(
    (user && user.community && Array.isArray(user.community.friends) ? user.community.friends : []).map(String)
  );
  const friends = [];
  const guests = [];
  for (const supporter of getAvailableSupportUsers(ctx, user).slice(0, 60)) {
    (friendUids.has(String(supporter.user.userUid)) ? friends : guests).push(supporter);
  }
  return { friends, guests };
}

function buildWarfareSupporter(user, supportUnit) {
  const army = ensureArmy(user);
  const savedDeck = army.deckSets && Array.isArray(army.deckSets["1"]) ? army.deckSets["1"][0] : null;
  const units = getArmyUnits(user);
  const ships = getArmyShips(user);
  const operators = getArmyOperators(user);
  const savedUnitUids = savedDeck && Array.isArray(savedDeck.unitUids) ? savedDeck.unitUids : [];
  let deckUnits = normalizeFixedArray(savedUnitUids, 8, 0).map((uid) => army.units[String(toBigInt(uid))] || null);
  if (!deckUnits.some(Boolean)) {
    deckUnits = [supportUnit, ...units.filter((unit) => String(unit.unitUid) !== String(supportUnit.unitUid))].slice(0, 8);
    while (deckUnits.length < 8) deckUnits.push(null);
  }
  const ship = ships.find((entry) => String(entry.unitUid) === String(savedDeck && savedDeck.shipUid)) || ships[0] || null;
  const operator = operators.find((entry) => String(entry.uid || entry.operatorUid) === String(savedDeck && savedDeck.operatorUid)) || operators[0] || null;
  const savedLeaderIndex = Number(savedDeck && savedDeck.leaderIndex);
  const leaderIndex = Number.isInteger(savedLeaderIndex) && savedLeaderIndex >= 0 && savedLeaderIndex < deckUnits.length && deckUnits[savedLeaderIndex]
    ? savedLeaderIndex
    : deckUnits.findIndex(Boolean);
  const dummyDeck = Buffer.concat([
    writeSByte(leaderIndex),
    ship ? writeNullableObject(buildDummyUnitData(ship)) : writeNullObject(),
    operator ? writeNullableObject(buildDummyUnitData(operatorToDummyUnit(operator))) : writeNullObject(),
    writeObjectList(deckUnits.map((unit) => unit ? writeNullableObject(buildDummyUnitData(unit)) : writeNullObject())),
  ]);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeNullableObject(dummyDeck),
    writeInt64LE(lastLoginDate(user)),
    writeInt64LE(0n),
    writeString(user.friendIntro || ""),
    writeNullableObject(buildGuildSimpleData(user)),
  ]);
}

function lastLoginDate(user) {
  const stored = user && (user.lastLoginDate || user.lastJoinDate);
  if (stored != null && /^\d+$/.test(String(stored))) return toBigInt(stored);
  const timestamp = Date.parse(user && (user.lastLoginAt || user.lastJoinAt || user.createdAt) || "");
  if (!Number.isFinite(timestamp)) return dateTimeBinaryNow();
  return dateTimeBinaryNow() - BigInt(Date.now() - timestamp) * 10000n;
}

function operatorToDummyUnit(operator) {
  if (!operator) return null;
  return {
    unitId: Number(operator.id || operator.unitId || 0),
    level: Number(operator.level || 1),
    skinId: 0,
    limitBreakLevel: 0,
    tacticLevel: 0,
    reactorLevel: 0,
  };
}

function buildDummyUnitData(unit) {
  const data = unit || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.unitId || data.id || 0) || 0),
    writeSignedVarInt(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.skinId || 0) || 0),
    writeSignedVarInt(Number(data.limitBreakLevel || 0) || 0),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  let decryptFailed = false;
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    decryptFailed = true;
    payload = Buffer.alloc(0);
  }
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case 15:
        return { valid: !decryptFailed && payload.length === 0 };
      case 1410:
        return { shipID: reader.int() };
      case 1412:
        return { shipUID: reader.long(), nextLevel: reader.int() };
      case 1414:
        return { shipUID: reader.long(), nextShipID: reader.int() };
      case 1416:
        return { removeShipUIDList: reader.longList() };
      case 1424:
        return { targetUnitUid: reader.long() };
      case 1426:
        return { targetUnitUid: reader.long(), sourceUnitUid: reader.long(), tokenItemId: reader.int(), transSkill: reader.bool() };
      case 1428:
        return { unitUID: reader.long(), locked: reader.bool() };
      case 1430:
        return { removeUnitUIDList: reader.longList() };
      case 1445:
        return { shipUid: reader.long(), consumeShipUid: reader.long() };
      case 1447:
      {
        const shipUid = reader.long();
        const moduleId = reader.int();
        const slotId = reader.int();
        const locked = reader.bool();
        return { shipUid, moduleId, slotId, locked, valid: !decryptFailed && shipUid > 0n && reader.done() };
      }
      case 1449:
      case 1451:
      case 1453:
      {
        const shipUid = reader.long();
        const moduleId = reader.int();
        return { shipUid, moduleId, valid: !decryptFailed && shipUid > 0n && reader.done() };
      }
      case 1455:
        return { valid: !decryptFailed && reader.done() };
      case 1459:
        return { recallOperatorUid: reader.long(), exchangeOperatorId: reader.int(), exchangeSubSkillId: reader.int() };
      case 1463:
        return { extractUnitUids: reader.longList() };
      case 1664:
        return { unitUid: reader.long() };
      case 1666:
        return { raw: payload };
      case 2621:
        return decodeDefenceDeckRequest(payload, decryptFailed);
      default:
        return {};
    }
  } catch (err) {
    console.log(`[roster:${PACKET_NAMES[packetId] || packetId}] request decode failed: ${err.message}`);
    if ([1447, 1449, 1451, 1453, 1455].includes(packetId)) return { valid: false };
    if (packetId === 2621) return { valid: false, deck: null };
    return packetId === 1666 ? { raw: payload } : {};
  }
}

function createReader(payload) {
  let offset = 0;
  return {
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
    longList() {
      const read = readSignedVarLongList(payload, offset);
      offset = read.offset;
      return read.value;
    },
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
    sbyte() {
      const read = readSByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    string() {
      const read = readString(payload, offset);
      offset = read.offset;
      return read.value;
    },
    done() {
      return offset === payload.length;
    },
  };
}

function getSocketUser(ctx, socket) {
  const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
  if (socket.session) socket.session.user = user;
  ensureArmy(user);
  return user;
}

function ack(packetId, payload, log = "", persist = true) {
  return { packetId, payload, log, persist };
}

function sendRosterResponse(ctx, socket, packet, response) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, response.packetId, response.payload, `roster-${response.packetId}`);
    return;
  }
  ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
    ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
  );
}

function normalizeFixedArray(values, length, fallback) {
  const result = Array.isArray(values) ? values.slice(0, length) : [];
  while (result.length < length) result.push(fallback);
  return result;
}

function normalizeModuleIndex(moduleId, length) {
  const numeric = Number(moduleId);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < length) return numeric;
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= length) return numeric - 1;
  return 0;
}

function normalizeSlotIndex(slotId, length) {
  const numeric = Number(slotId);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < length) return numeric;
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= length) return numeric - 1;
  return 0;
}

module.exports = {
  DEFENCE_DECK_ERROR,
  createCombatRosterHandlers,
  decodeDefenceDeckRequest,
  updateDefenceDeckAck,
  validateDefenceDeck,
  ensureSupportUnit,
  getAvailableSupportUsers,
  getWarfareSupportUsers,
  buildSupportUnitData,
  buildSupportUnitProfileData,
  buildDungeonSupportData,
  buildClearDungeonSupportPayload,
  decodeDungeonSupportSelection,
};
