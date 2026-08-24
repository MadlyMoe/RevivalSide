const DEFAULT_LOCAL_SHOP_BALANCE = 999999999n;

const COMMON_RESOURCE_ITEM_IDS = Object.freeze([
  1, // credit
  2, // eternium
  5,
  8,
  14,
  101, // quartz
  102, // admin coin / paid medal
  401,
  655,
  694,
  698,
  1001,
  1034,
  19009,
  19011,
  19012,
  34003,
  34004,
  34005,
  34006,
  34007,
  34008,
  34009,
  34010,
]);

const RESOURCE_ITEM_IDS = Object.freeze({
  CREDIT: 1,
  ETERNIUM: 2,
  QUARTZ: 101,
  ADMIN_COIN: 102,
});

function ensureInventory(user) {
  if (!user || typeof user !== "object") return { misc: {}, equips: {}, skins: [] };
  user.inventory = user.inventory && typeof user.inventory === "object" ? user.inventory : {};
  user.inventory.misc = user.inventory.misc && typeof user.inventory.misc === "object" ? user.inventory.misc : {};
  user.inventory.equips = user.inventory.equips && typeof user.inventory.equips === "object" ? user.inventory.equips : {};
  user.inventory.skins = Array.isArray(user.inventory.skins) ? user.inventory.skins : [];
  user.inventory.emoticons = Array.isArray(user.inventory.emoticons) ? user.inventory.emoticons : [];

  for (const [key, value] of Object.entries(user.inventory.misc)) {
    const itemId = Number((value && value.itemId) || key);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      delete user.inventory.misc[key];
      continue;
    }
    const normalized = normalizeMiscItem(value, itemId);
    if (String(key) !== String(itemId)) delete user.inventory.misc[key];
    user.inventory.misc[String(itemId)] = normalized;
  }

  user.inventory.skins = uniquePositiveInts(user.inventory.skins);
  user.inventory.emoticons = uniquePositiveInts(user.inventory.emoticons);
  return user.inventory;
}

function getMiscItems(user) {
  const inventory = ensureInventory(user);
  return Object.values(inventory.misc)
    .map((item) => normalizeMiscItem(item, item.itemId))
    .sort((a, b) => a.itemId - b.itemId);
}

function getSkinIds(user) {
  return ensureInventory(user).skins.slice().sort((a, b) => a - b);
}

function seedShopCurrency(user, itemIds, options = {}) {
  const inventory = ensureInventory(user);
  const balance = toBigInt(options.balance, DEFAULT_LOCAL_SHOP_BALANCE);
  const regDate = String(options.regDate || "0");
  const seedMissingOnly = options.seedMissingOnly === true;
  const includeCommonResources = options.includeCommonResources === true;
  const commonResourceIds = new Set(COMMON_RESOURCE_ITEM_IDS);
  const seedIds = (Array.isArray(itemIds) ? itemIds : []).filter(
    (itemId) => includeCommonResources || !commonResourceIds.has(Number(itemId))
  );
  if (includeCommonResources) seedIds.push(...COMMON_RESOURCE_ITEM_IDS);
  const ids = uniquePositiveInts(seedIds);
  let changed = false;
  for (const itemId of ids) {
    const key = String(itemId);
    const hadExistingItem = Boolean(inventory.misc[key]);
    const current = normalizeMiscItem(inventory.misc[key], itemId);
    if (seedMissingOnly && hadExistingItem) {
      inventory.misc[key] = current;
      continue;
    }
    const total = toBigInt(current.countFree) + toBigInt(current.countPaid);
    if (total >= balance) {
      inventory.misc[key] = current;
      continue;
    }
    current.countFree = String(toBigInt(current.countFree) + (balance - total));
    current.regDate = current.regDate !== "0" ? current.regDate : regDate;
    inventory.misc[key] = current;
    changed = true;
  }
  return changed;
}

function removeDebugSeededCommonResources(user, options = {}) {
  const inventory = ensureInventory(user);
  const balance = toBigInt(options.balance, DEFAULT_LOCAL_SHOP_BALANCE);
  if (balance <= 0n) return [];
  const tolerance = nonNegativeBigInt(options.tolerance != null ? options.tolerance : 10000000n);
  const threshold = balance > tolerance ? balance - tolerance : balance;
  const ids = uniquePositiveInts(options.itemIds || COMMON_RESOURCE_ITEM_IDS);
  const repaired = [];

  for (const itemId of ids) {
    const key = String(itemId);
    if (!inventory.misc[key]) continue;

    const current = normalizeMiscItem(inventory.misc[key], itemId);
    const free = nonNegativeBigInt(current.countFree);
    if (free < threshold) {
      inventory.misc[key] = current;
      continue;
    }

    const reduction = free >= balance ? balance : free;
    current.countFree = String(free - reduction);
    inventory.misc[key] = current;
    repaired.push({
      itemId,
      previousFree: String(free),
      nextFree: current.countFree,
      countPaid: current.countPaid,
    });
  }

  return repaired;
}

function getMiscItem(user, itemId) {
  const numericItemId = Number(itemId);
  if (!Number.isInteger(numericItemId) || numericItemId <= 0) return null;
  const inventory = ensureInventory(user);
  return normalizeMiscItem(inventory.misc[String(numericItemId)], numericItemId);
}

function setMiscItemBalance(user, itemId, countFree, countPaid = 0, options = {}) {
  const numericItemId = Number(itemId);
  if (!Number.isInteger(numericItemId) || numericItemId <= 0) return null;
  const inventory = ensureInventory(user);
  const item = normalizeMiscItem(
    {
      itemId: numericItemId,
      countFree: String(nonNegativeBigInt(countFree)),
      countPaid: String(nonNegativeBigInt(countPaid)),
      bonusRatio: Number(options.bonusRatio || 0),
      regDate: String(options.regDate || "0"),
    },
    numericItemId
  );
  inventory.misc[String(numericItemId)] = item;
  markInventoryTouched(inventory);
  return item;
}

function grantMiscItem(user, itemId, countFree, countPaid = 0, options = {}) {
  const numericItemId = Number(itemId);
  if (!Number.isInteger(numericItemId) || numericItemId <= 0) return null;

  const free = toBigInt(countFree, 0n);
  const paid = toBigInt(countPaid, 0n);
  if (free <= 0n && paid <= 0n) return null;

  const inventory = ensureInventory(user);
  const key = String(numericItemId);
  const current = normalizeMiscItem(inventory.misc[key], numericItemId);
  current.countFree = String(toBigInt(current.countFree) + free);
  current.countPaid = String(toBigInt(current.countPaid) + paid);
  current.bonusRatio = Number(options.bonusRatio || current.bonusRatio || 0);
  current.regDate = String(options.regDate || current.regDate || "0");
  inventory.misc[key] = current;
  markInventoryTouched(inventory);

  return normalizeMiscItem(
    {
      itemId: numericItemId,
      countFree: String(free),
      countPaid: String(paid),
      bonusRatio: Number(options.bonusRatio || 0),
      regDate: String(options.regDate || current.regDate || "0"),
    },
    numericItemId
  );
}

function spendMiscItem(user, itemId, count, options = {}) {
  const numericItemId = Number(itemId);
  if (!Number.isInteger(numericItemId) || numericItemId <= 0) return null;

  const amount = nonNegativeBigInt(count);
  if (amount <= 0n) return getMiscItem(user, numericItemId);

  const current = getMiscItem(user, numericItemId);
  const currentFree = nonNegativeBigInt(current.countFree);
  const currentPaid = nonNegativeBigInt(current.countPaid);
  const actualSpend = amount < currentFree + currentPaid ? amount : currentFree + currentPaid;
  const freeSpend = currentFree >= amount ? amount : currentFree;
  const paidSpend = amount - freeSpend;
  const nextFree = currentFree - freeSpend;
  const nextPaid = currentPaid > paidSpend ? currentPaid - paidSpend : 0n;

  const updated = setMiscItemBalance(user, numericItemId, nextFree, nextPaid, {
    bonusRatio: current.bonusRatio,
    regDate: options.regDate || current.regDate,
  });
  trackConsumerPackageSpend(user, numericItemId, actualSpend);
  return updated;
}

function trackConsumerPackageSpend(user, itemId, amount) {
  if (!user || amount <= 0n) return;
  const source = user.consumerPackages;
  const packages = Array.isArray(source) ? source : source && typeof source === "object" ? Object.values(source) : [];
  for (const entry of packages) {
    if (!entry || Number(entry.requireItemId || 0) !== Number(itemId)) continue;
    entry.spendCount = String(nonNegativeBigInt(entry.spendCount) + amount);
    entry.pendingUpdate = true;
  }
}

function grantSkin(user, skinId) {
  const numericSkinId = Number(skinId);
  if (!Number.isInteger(numericSkinId) || numericSkinId <= 0) return null;
  const inventory = ensureInventory(user);
  if (!inventory.skins.includes(numericSkinId)) inventory.skins.push(numericSkinId);
  inventory.skins = uniquePositiveInts(inventory.skins);
  markInventoryTouched(inventory);
  return numericSkinId;
}

function grantEmoticon(user, emoticonId) {
  const numericEmoticonId = Number(emoticonId);
  if (!Number.isInteger(numericEmoticonId) || numericEmoticonId <= 0) return null;
  const inventory = ensureInventory(user);
  if (!inventory.emoticons.includes(numericEmoticonId)) inventory.emoticons.push(numericEmoticonId);
  inventory.emoticons = uniquePositiveInts(inventory.emoticons);
  markInventoryTouched(inventory);
  return numericEmoticonId;
}

function markInventoryTouched(inventory) {
  if (inventory && typeof inventory === "object") inventory.localTouchedAt = new Date().toISOString();
}

function normalizeMiscItem(value, fallbackItemId) {
  const item = value && typeof value === "object" ? value : {};
  const normalized = {
    itemId: Number(item.itemId || fallbackItemId) || 0,
    countFree: String(toBigInt(item.countFree != null ? item.countFree : item.count || 0)),
    countPaid: String(toBigInt(item.countPaid || 0)),
    bonusRatio: Number(item.bonusRatio || 0),
    regDate: String(item.regDate || "0"),
  };
  for (const [key, fieldValue] of Object.entries(item)) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) continue;
    if (isInventoryTimingKey(key)) normalized[key] = fieldValue;
  }
  return normalized;
}

function isInventoryTimingKey(key) {
  return /expire|expiration|validuntil|enddate|endtime|duration|period/i.test(String(key || ""));
}

function uniquePositiveInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function toBigInt(value, fallback = 0n) {
  try {
    if (value == null || value === "") return fallback;
    return BigInt(value);
  } catch (_) {
    return fallback;
  }
}

function nonNegativeBigInt(value) {
  const number = toBigInt(value, 0n);
  return number > 0n ? number : 0n;
}

module.exports = {
  DEFAULT_LOCAL_SHOP_BALANCE,
  COMMON_RESOURCE_ITEM_IDS,
  RESOURCE_ITEM_IDS,
  ensureInventory,
  getMiscItems,
  getMiscItem,
  getSkinIds,
  seedShopCurrency,
  removeDebugSeededCommonResources,
  setMiscItemBalance,
  grantMiscItem,
  spendMiscItem,
  grantSkin,
  grantEmoticon,
  toBigInt,
};
