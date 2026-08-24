const { getMiscItem, spendMiscItem, toBigInt } = require("../inventory");
const { getArmyUnits, getArmyShips, getArmyTrophies, getArmyOperators } = require("../unit");
const { getEquipItems } = require("../equipment");

const INVENTORY_EXPAND_ITEM_ID = 101;
const MAX_INVENTORY_CAPACITY = 2147483647;

const INVENTORY_TYPES = Object.freeze({
  EQUIP: 1,
  UNIT: 2,
  SHIP: 3,
  OPERATOR: 4,
  TROPHY: 5,
});

const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  ARMY_FULL: 112,
  SHIP_FULL: 113,
  EQUIP_ITEM_FULL: 114,
  OPERATOR_FULL: 115,
  UNKNOWN_EXPAND_TYPE: 333,
  CANNOT_EXPAND_INVENTORY: 334,
  TROPHY_FULL: 22500,
});

const INVENTORY_DEFINITIONS = Object.freeze({
  [INVENTORY_TYPES.EQUIP]: Object.freeze({
    key: "equip",
    min: 300,
    max: MAX_INVENTORY_CAPACITY,
    step: 5,
    cost: 50,
    fullErrorCode: ERROR_CODES.EQUIP_ITEM_FULL,
    aliases: ["equip", "maxEquipCount", "maxItemEquipCount", "m_MaxItemEqipCount"],
  }),
  [INVENTORY_TYPES.UNIT]: Object.freeze({
    key: "unit",
    min: 200,
    max: MAX_INVENTORY_CAPACITY,
    step: 5,
    cost: 100,
    fullErrorCode: ERROR_CODES.ARMY_FULL,
    aliases: ["unit", "maxUnitCount", "m_MaxUnitCount"],
  }),
  [INVENTORY_TYPES.SHIP]: Object.freeze({
    key: "ship",
    min: 10,
    max: MAX_INVENTORY_CAPACITY,
    step: 1,
    cost: 100,
    fullErrorCode: ERROR_CODES.SHIP_FULL,
    aliases: ["ship", "maxShipCount", "m_MaxShipCount"],
  }),
  [INVENTORY_TYPES.OPERATOR]: Object.freeze({
    key: "operator",
    min: 10,
    max: MAX_INVENTORY_CAPACITY,
    step: 5,
    cost: 100,
    fullErrorCode: ERROR_CODES.OPERATOR_FULL,
    aliases: ["operator", "maxOperatorCount", "m_MaxOperatorCount"],
  }),
  [INVENTORY_TYPES.TROPHY]: Object.freeze({
    key: "trophy",
    min: 2000,
    max: MAX_INVENTORY_CAPACITY,
    step: 10,
    cost: 50,
    fullErrorCode: ERROR_CODES.TROPHY_FULL,
    aliases: ["trophy", "maxTrophyCount", "m_MaxTrophyCount"],
  }),
});

function getInventoryDefinition(inventoryType) {
  return INVENTORY_DEFINITIONS[Number(inventoryType || 0)] || null;
}

function ensureInventoryExpansion(user) {
  if (!user || typeof user !== "object") return {};
  user.inventoryExpansion = user.inventoryExpansion && typeof user.inventoryExpansion === "object" ? user.inventoryExpansion : {};
  return user.inventoryExpansion;
}

function getInventoryCapacity(user, inventoryType) {
  const type = Number(inventoryType || 0);
  const definition = getInventoryDefinition(type);
  if (!definition) return 0;
  const stored = getStoredInventoryCapacity(user, type);
  return stored > 0 ? clampInt(stored, definition.min, definition.max) : definition.min;
}

function initializeInventoryCapacities(user) {
  const state = ensureInventoryExpansion(user);
  for (const [typeText, definition] of Object.entries(INVENTORY_DEFINITIONS)) {
    const type = Number(typeText);
    const stored = getStoredInventoryCapacity(user, type);
    const usage = getInventoryUsage(user, type);
    const step = Math.max(1, Number(definition.step) || 1);
    const usageSafe = usage > stored
      ? Math.ceil((usage + 1) / step) * step
      : stored;
    const initial = clampInt(Math.max(definition.min, usageSafe), definition.min, definition.max);
    state[String(type)] = initial;
    state[definition.key] = initial;
  }
  return state;
}

function getInventoryCapacities(user) {
  return {
    equip: getInventoryCapacity(user, INVENTORY_TYPES.EQUIP),
    unit: getInventoryCapacity(user, INVENTORY_TYPES.UNIT),
    ship: getInventoryCapacity(user, INVENTORY_TYPES.SHIP),
    operator: getInventoryCapacity(user, INVENTORY_TYPES.OPERATOR),
    trophy: getInventoryCapacity(user, INVENTORY_TYPES.TROPHY),
  };
}

function applyInventoryExpansion(user, inventoryType, count) {
  const type = Number(inventoryType || 0);
  const definition = getInventoryDefinition(type);
  if (!definition) {
    return inventoryExpansionResult(ERROR_CODES.UNKNOWN_EXPAND_TYPE, type, 0, []);
  }

  const requestedCount = Math.max(0, Math.trunc(Number(count || 0) || 0));
  const current = getInventoryCapacity(user, type);
  if (requestedCount <= 0) return inventoryExpansionResult(ERROR_CODES.CANNOT_EXPAND_INVENTORY, type, current, []);

  const expandedCount = current + definition.step * requestedCount;
  if (expandedCount > definition.max) {
    return inventoryExpansionResult(definition.fullErrorCode, type, current, []);
  }

  const cost = definition.cost * requestedCount;
  const balance = getMiscItem(user, INVENTORY_EXPAND_ITEM_ID);
  const total = toBigInt(balance && balance.countFree) + toBigInt(balance && balance.countPaid);
  if (total < BigInt(cost)) return inventoryExpansionResult(ERROR_CODES.INSUFFICIENT_ITEM, type, current, []);

  const costItem = spendMiscItem(user, INVENTORY_EXPAND_ITEM_ID, cost);
  setInventoryCapacity(user, type, expandedCount);
  return inventoryExpansionResult(ERROR_CODES.OK, type, expandedCount, costItem ? [costItem] : []);
}

function setInventoryCapacity(user, inventoryType, count) {
  const type = Number(inventoryType || 0);
  const definition = getInventoryDefinition(type);
  if (!definition || !user || typeof user !== "object") return 0;
  const capacity = clampInt(count, definition.min, definition.max);
  const state = ensureInventoryExpansion(user);
  state[String(type)] = capacity;
  state[definition.key] = capacity;
  state.updatedAt = new Date().toISOString();
  return capacity;
}

function getInventoryUsage(user, inventoryType) {
  switch (Number(inventoryType || 0)) {
    case INVENTORY_TYPES.EQUIP:
      return getEquipItems(user).length;
    case INVENTORY_TYPES.UNIT:
      return getArmyUnits(user).length;
    case INVENTORY_TYPES.SHIP:
      return getArmyShips(user).length;
    case INVENTORY_TYPES.OPERATOR:
      return getArmyOperators(user).length;
    case INVENTORY_TYPES.TROPHY:
      return getArmyTrophies(user).length;
    default:
      return 0;
  }
}

function getStoredInventoryCapacity(user, inventoryType) {
  if (!user || typeof user !== "object") return 0;
  const type = Number(inventoryType || 0);
  const definition = getInventoryDefinition(type);
  if (!definition) return 0;

  const state = user.inventoryExpansion && typeof user.inventoryExpansion === "object" ? user.inventoryExpansion : {};
  const candidates = [state[String(type)], ...definition.aliases.map((key) => state[key]), ...definition.aliases.map((key) => user[key])];
  for (const value of candidates) {
    const capacity = Number(value);
    if (Number.isInteger(capacity) && capacity > 0) return capacity;
  }
  return 0;
}

function inventoryExpansionResult(errorCode, inventoryType, expandedCount, costItems) {
  return {
    errorCode: Number(errorCode || 0) || 0,
    inventoryType: Number(inventoryType || 0) || 0,
    expandedCount: Math.max(0, Math.trunc(Number(expandedCount || 0) || 0)),
    costItems: Array.isArray(costItems) ? costItems.filter(Boolean) : [],
  };
}

function clampInt(value, min, max) {
  const numeric = Math.trunc(Number(value || 0) || 0);
  return Math.max(Number(min) || 0, Math.min(Number(max) || 0, numeric));
}

module.exports = {
  INVENTORY_EXPAND_ITEM_ID,
  MAX_INVENTORY_CAPACITY,
  INVENTORY_TYPES,
  INVENTORY_DEFINITIONS,
  ERROR_CODES,
  applyInventoryExpansion,
  ensureInventoryExpansion,
  getInventoryCapacity,
  getInventoryCapacities,
  getInventoryDefinition,
  getInventoryUsage,
  initializeInventoryCapacities,
  setInventoryCapacity,
};
