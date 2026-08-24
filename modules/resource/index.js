const {
  RESOURCE_ITEM_IDS,
  spendMiscItem,
  toBigInt,
} = require("../inventory");
const {
  FALLBACK_RESOURCE_ITEM_ID,
  FALLBACK_RESOURCE_COUNT,
  createEmptyReward,
  grantRewardByType,
} = require("../reward");

const PURCHASE_DEDUPE_MS = Number(process.env.CS_RESOURCE_PURCHASE_DEDUPE_MS || 10000);
const TRACK_SHOP_PURCHASE_LIMITS = readEnvBool(process.env.CS_SHOP_TRACK_PURCHASE_LIMITS, true);
const TRACK_ADMIN_COIN_TOTAL_PAYMENT = readEnvBool(process.env.CS_SHOP_TRACK_ADMIN_COIN_TOTAL_PAYMENT, true);
const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MS = 10000n;
const TICKS_PER_DAY = 24n * 60n * 60n * 10000000n;

function isRealMoneyProduct(record) {
  return Boolean(record) && Number(record.m_PriceItemID) === 0;
}

function isRealMoneyResourceProduct(record) {
  return isRealMoneyProduct(record) && String(record && record.m_ItemType) === "RT_MISC";
}

function isCoreResourceItemId(itemId) {
  const id = Number(itemId);
  return Object.values(RESOURCE_ITEM_IDS).includes(id);
}

function grantShopProduct(ctx, user, record, productCount = 1, options = {}) {
  if (!record) return grantFallbackResource(ctx, user, productCount);

  const count = Math.max(1, Number(productCount) || 1);
  const itemType = String(record.m_ItemType || "");
  const itemId = Number(record.m_ItemID);
  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
  const reward = createEmptyReward();

  if (!Number.isInteger(itemId) || itemId <= 0) return grantFallbackResource(ctx, user, count);

  const granted = grantRewardByType(
    ctx,
    user,
    itemType,
    itemId,
    toBigInt(record.m_FreeValue != null ? record.m_FreeValue : record.m_Value || 1, 1n) * BigInt(count),
    toBigInt(record.m_FreeValue != null ? record.m_FreeValue : record.m_Value || 1, 1n) * BigInt(count),
    toBigInt(record.m_PaidValue || 0, 0n) * BigInt(count),
    { ...options, regDate, expandPackages: true }
  );
  for (const key of ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "moldItems", "interiors"]) {
    if (Array.isArray(granted[key])) reward[key].push(...granted[key]);
  }

  if (options.recordPurchase !== false) {
    recordShopPurchase(user, Number(record.m_ProductID) || 0, count, {
      now: getCurrentRawTicks(ctx),
      nextResetDate: options.nextResetDate || getNextShopResetDate(ctx, record),
      resetType: options.resetType || record.resetType || record.m_QuantityLimitCond || "",
    });
  }
  return reward;
}

function spendShopPrice(ctx, user, record, productCount = 1, options = {}) {
  if (!record || isRealMoneyProduct(record)) return null;
  const itemId = Number(record.m_PriceItemID);
  const unitPrice = toBigInt(record.m_Price || 0, 0n);
  const count = Math.max(1, Number(productCount) || 1);
  const totalPrice = options.totalPrice == null ? unitPrice * BigInt(count) : toBigInt(options.totalPrice, 0n);
  if (!Number.isInteger(itemId) || itemId <= 0 || totalPrice <= 0n) return null;

  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
  const updated = spendMiscItem(user, itemId, totalPrice, { regDate });
  if (updated && isCoreResourceItemId(itemId)) {
    console.log(
      `[resource] spend itemId=${itemId} amount=${totalPrice.toString()} balanceFree=${updated.countFree} balancePaid=${updated.countPaid}`
    );
  }
  if (updated && itemId === RESOURCE_ITEM_IDS.ADMIN_COIN) {
    const totalPaidAmount = recordShopTotalPaidAmount(user, totalPrice);
    if (TRACK_ADMIN_COIN_TOTAL_PAYMENT) {
      console.log(`[resource] totalPaidAmount=${totalPaidAmount} adminCoinSpend=${totalPrice.toString()}`);
    }
  }
  return updated;
}

function grantFallbackResource(ctx, user, multiplier = 1) {
  const reward = createEmptyReward();
  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
  const grant = grantRewardByType(ctx, user, "RT_MISC", FALLBACK_RESOURCE_ITEM_ID, FALLBACK_RESOURCE_COUNT * BigInt(Math.max(1, Number(multiplier) || 1)), null, 0n, { regDate, expandPackages: false });
  for (const key of ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "moldItems", "interiors"]) {
    if (Array.isArray(grant[key])) reward[key].push(...grant[key]);
  }
  return reward;
}

function recordShopPurchase(user, productId, productCount = 1, options = {}) {
  if (!user || !Number.isInteger(Number(productId)) || Number(productId) <= 0) return null;
  if (!TRACK_SHOP_PURCHASE_LIMITS) {
    return {
      shopId: Number(productId),
      purchaseCount: 0,
      purchaseTotalCount: 0,
      nextResetDate: "0",
    };
  }
  user.shopPurchaseHistory =
    user.shopPurchaseHistory && typeof user.shopPurchaseHistory === "object" ? user.shopPurchaseHistory : {};
  const key = String(Number(productId));
  const existing = user.shopPurchaseHistory[key] || {};
  const now = toBigInt(options.now || 0, 0n);
  const existingNextReset = toBigInt(existing.nextResetDate || 0, 0n);
  const countReset = isCountResetShopType(options.resetType || existing.resetType || "");
  const resetExpired = countReset && existingNextReset > 0n && now > 0n && existingNextReset <= now;
  const previousPurchaseCount = resetExpired ? 0 : Number(existing.purchaseCount || 0);
  const purchaseCount = previousPurchaseCount + Math.max(1, Number(productCount) || 1);
  const nextResetDate = String(options.nextResetDate || (resetExpired ? 0 : existing.nextResetDate) || "0");
  const history = {
    shopId: Number(productId),
    purchaseCount,
    purchaseTotalCount: Number(existing.purchaseTotalCount || 0) + Math.max(1, Number(productCount) || 1),
    nextResetDate,
  };
  user.shopPurchaseHistory[key] = history;
  return history;
}

function getShopPurchaseHistories(user) {
  const history = user && user.shopPurchaseHistory && typeof user.shopPurchaseHistory === "object" ? user.shopPurchaseHistory : {};
  if (!TRACK_SHOP_PURCHASE_LIMITS && !Object.keys(history).length) return [];
  return Object.values(history)
    .map((entry) => ({
      shopId: Number(entry.shopId || 0),
      purchaseCount: Number(entry.purchaseCount || 0),
      purchaseTotalCount: Number(entry.purchaseTotalCount || 0),
      nextResetDate: String(entry.nextResetDate || "0"),
    }))
    .filter((entry) => entry.shopId > 0);
}

function getShopTotalPaidAmount(user) {
  if (!user || typeof user !== "object") return 0;
  const existing = Number(
    user.shopTotalPaidAmount != null
      ? user.shopTotalPaidAmount
      : user.totalPaidAmount != null
        ? user.totalPaidAmount
        : user.totalPayment || 0
  );
  return Number.isFinite(existing) && existing > 0 ? existing : 0;
}

function recordShopTotalPaidAmount(user, amount) {
  const current = getShopTotalPaidAmount(user);
  if (!TRACK_ADMIN_COIN_TOTAL_PAYMENT || !user || typeof user !== "object") return current;
  const increment = Number(toBigInt(amount || 0, 0n));
  if (!Number.isFinite(increment) || increment <= 0) return current;
  const next = current + increment;
  user.shopTotalPaidAmount = next;
  return next;
}

function getCurrentRawTicks(ctx) {
  const value = ctx && typeof ctx.dateTimeBinaryNow === "function" ? toBigInt(ctx.dateTimeBinaryNow(), 0n) : 0n;
  if (value > 0n) return value & 0x3fffffffffffffffn;
  return DOTNET_TICKS_AT_UNIX_EPOCH + BigInt(Date.now()) * TICKS_PER_MS;
}

function getNextShopResetDate(ctx, record) {
  const resetType = String(record && (record.resetType || record.m_QuantityLimitCond) || "").trim().toUpperCase();
  const nowTicks = getCurrentRawTicks(ctx);
  if (!resetType || resetType === "UNLIMITED") return "0";
  if (resetType === "FIXED") return String(nowTicks + 36525n * TICKS_PER_DAY);

  const nowDate = new Date(Number((nowTicks - DOTNET_TICKS_AT_UNIX_EPOCH) / TICKS_PER_MS));
  let nextDate;
  if (resetType === "DAY") {
    nextDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1, 0, 0, 0, 0));
  } else if (resetType === "MONTH") {
    nextDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  } else if (resetType.startsWith("WEEK")) {
    const day = nowDate.getUTCDay();
    const daysUntilMonday = ((8 - day) % 7) || 7;
    nextDate = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + daysUntilMonday, 0, 0, 0, 0));
  } else {
    return "0";
  }
  return String(DOTNET_TICKS_AT_UNIX_EPOCH + BigInt(nextDate.getTime()) * TICKS_PER_MS);
}

function isCountResetShopType(resetType) {
  const text = String(resetType || "").trim().toUpperCase();
  return text === "DAY" || text === "MONTH" || text.startsWith("WEEK");
}

function readEnvBool(value, fallback = false) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function getPurchaseKey(source, productId, request = {}) {
  const normalizedSource = source || "shop";
  let explicit = "";
  if (normalizedSource === "steam") {
    const resolvedProductId = request.productId || productId;
    explicit = request.orderId ? `${request.orderId}:${resolvedProductId}` : resolvedProductId;
  } else if (normalizedSource === "cash") {
    explicit = request.productMarketID || request.productId || request.productID || productId;
  } else if (normalizedSource === "gamebase") {
    explicit = request.paymentId || request.paymentSeq || productId;
  } else {
    explicit =
      request.orderId ||
      request.paymentSeq ||
      request.paymentId ||
      request.validationToken ||
      request.productMarketID ||
      request.productId ||
      request.productID ||
      productId;
  }
  return `${normalizedSource}:${String(explicit || productId || "unknown")}`;
}

function hasCompletedPurchase(socket, key) {
  const state = getResourcePurchaseState(socket);
  if (!key || !state.completed[key]) return false;
  const completedAt = Number(state.completed[key] || 0);
  if (Date.now() - completedAt <= PURCHASE_DEDUPE_MS) return true;
  delete state.completed[key];
  return false;
}

function markCompletedPurchase(socket, key) {
  if (!key) return;
  const state = getResourcePurchaseState(socket);
  state.completed[key] = Date.now();
}

function getResourcePurchaseState(socket) {
  if (!socket || !socket.session) return { completed: {} };
  socket.session.resourcePurchases =
    socket.session.resourcePurchases && typeof socket.session.resourcePurchases === "object"
      ? socket.session.resourcePurchases
      : { completed: {} };
  socket.session.resourcePurchases.completed =
    socket.session.resourcePurchases.completed && typeof socket.session.resourcePurchases.completed === "object"
      ? socket.session.resourcePurchases.completed
      : {};
  return socket.session.resourcePurchases;
}

function makeLocalOrderId(productId) {
  return `local-resource-${Number(productId) || 0}-${Date.now()}`;
}

module.exports = {
  createEmptyReward,
  isRealMoneyProduct,
  isRealMoneyResourceProduct,
  isCoreResourceItemId,
  grantShopProduct,
  spendShopPrice,
  grantFallbackResource,
  recordShopPurchase,
  getShopPurchaseHistories,
  getShopTotalPaidAmount,
  recordShopTotalPaidAmount,
  getPurchaseKey,
  hasCompletedPurchase,
  markCompletedPurchase,
  makeLocalOrderId,
};
