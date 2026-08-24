const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const {
  COMMON_RESOURCE_ITEM_IDS,
  DEFAULT_LOCAL_SHOP_BALANCE,
  getMiscItem,
  seedShopCurrency,
  spendMiscItem,
  toBigInt,
} = require("../inventory");
const { buildUnitData, buildOperatorData, buildEquipItemData, buildMoldItemData } = require("../packet-codec");
const { getMiscItemTemplet } = require("../game-data");
const { grantRewardByType, mergeReward, resolveCustomPackageRewardSelection } = require("../reward");
const {
  createEmptyReward,
  isRealMoneyProduct,
  grantShopProduct,
  spendShopPrice,
  grantFallbackResource,
  getPurchaseKey,
  getShopPurchaseHistories,
  getShopTotalPaidAmount,
  hasCompletedPurchase,
  markCompletedPurchase,
  makeLocalOrderId,
} = require("../resource");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking, queueMissionTracking } = require("../mission-tracking");
const { createAdminRewardPosts } = require("../admin");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MS = 10000n;
const TICKS_PER_HOUR = 60n * 60n * 10000000n;
const TICKS_PER_DAY = 24n * TICKS_PER_HOUR;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DATE_TIME_TICKS_MASK = 0x3fffffffffffffffn;
const RANDOM_SHOP_SLOT_COUNT = readPositiveIntEnv("CS_RANDOM_SHOP_SLOT_COUNT", 9);
const RANDOM_SHOP_REFRESH_INTERVAL_HOURS = readPositiveIntEnv("CS_RANDOM_SHOP_REFRESH_INTERVAL_HOURS", 6);
const RANDOM_SHOP_REFRESH_COST_ITEM_ID = readPositiveIntEnv("CS_RANDOM_SHOP_REFRESH_COST_ITEM_ID", 101);
const RANDOM_SHOP_REFRESH_COST = readNonNegativeIntEnv("CS_RANDOM_SHOP_REFRESH_COST", 15);
const RANDOM_SHOP_REFRESH_MAX_COUNT = readNonNegativeIntEnv("CS_RANDOM_SHOP_REFRESH_MAX_COUNT", 5);
const RANDOM_SHOP_STATE_VERSION = 1;
const EVENT_SHOP_SEED_CURRENCIES = process.env.CS_EVENT_SHOP_SEED_CURRENCIES !== "0";
const EVENT_SHOP_INCLUDE_ALL = process.env.CS_EVENT_SHOP_INCLUDE_ALL === "1";
const EVENT_SHOP_CURRENCY_BALANCE = toBigInt(
  process.env.CS_EVENT_SHOP_CURRENCY_BALANCE || process.env.CS_LOCAL_SHOP_BALANCE || process.env.CS_LOCAL_SHOP_CURRENCY_BALANCE,
  DEFAULT_LOCAL_SHOP_BALANCE
);
const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_CASH: 96,
  INSUFFICIENT_RESOURCE: 110,
  INVALID_SHOP_ID: 252,
  LIMITED_SHOP_COUNT: 254,
  NOT_EVENT_TIME: 260,
  NOT_ENOUGH_REFRESH_COUNT: 257,
  CANNOT_REFRESH: 256,
  INVALID_REQUEST: 20191,
  INVALID_CUSTOM_PACKAGE_SELECTION: 20703,
  CONSUMER_PACKAGE_ALREADY_PURCHASED: 21005,
});
const REWARD_TYPE_VALUES = Object.freeze({
  RT_NONE: 0,
  RT_UNIT: 1,
  RT_SHIP: 2,
  RT_MISC: 3,
  RT_USER_EXP: 4,
  RT_EQUIP: 5,
  RT_MOLD: 6,
  RT_SKIN: 7,
  RT_BUFF: 8,
  RT_EMOTICON: 9,
  RT_MISSION_POINT: 10,
  RT_BINGO_TILE: 11,
  RT_PASS_EXP: 12,
  RT_OPERATOR: 13,
});
const RANDOM_SHOP_POOL = Object.freeze([
  { itemType: "RT_MISC", itemId: 2, itemCount: 1200, priceItemId: 1, price: 18000, weight: 12 },
  { itemType: "RT_MISC", itemId: 2, itemCount: 3000, priceItemId: 1, price: 42000, weight: 7, discountRatio: 10 },
  { itemType: "RT_MISC", itemId: 3, itemCount: 600, priceItemId: 1, price: 16000, weight: 10 },
  { itemType: "RT_MISC", itemId: 1001, itemCount: 1, priceItemId: 1, price: 35000, weight: 8 },
  { itemType: "RT_MISC", itemId: 1001, itemCount: 3, priceItemId: 1, price: 90000, weight: 4, discountRatio: 15 },
  { itemType: "RT_MISC", itemId: 1013, itemCount: 8, priceItemId: 1, price: 26000, weight: 7 },
  { itemType: "RT_MISC", itemId: 1003, itemCount: 3, priceItemId: 1, price: 30000, weight: 5 },
  { itemType: "RT_MISC", itemId: 1005, itemCount: 3, priceItemId: 1, price: 30000, weight: 5 },
  { itemType: "RT_MISC", itemId: 1007, itemCount: 3, priceItemId: 1, price: 30000, weight: 5 },
  { itemType: "RT_MISC", itemId: 1034, itemCount: 1, priceItemId: 101, price: 80, weight: 3 },
  { itemType: "RT_UNIT", itemId: 101, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 102, itemCount: 1, priceItemId: 1, price: 28000, weight: 5 },
  { itemType: "RT_UNIT", itemId: 103, itemCount: 1, priceItemId: 1, price: 60000, weight: 3, discountRatio: 10 },
  { itemType: "RT_UNIT", itemId: 111, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 112, itemCount: 1, priceItemId: 1, price: 28000, weight: 5 },
  { itemType: "RT_UNIT", itemId: 121, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 131, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 141, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
]);
const PACKETS = Object.freeze({
  SHOP_FIX_SHOP_BUY_REQ: 2400,
  SHOP_FIX_SHOP_CASH_BUY_REQ: 2401,
  SHOP_FIX_SHOP_BUY_ACK: 2402,
  SHOP_RANDOM_SHOP_BUY_REQ: 2403,
  SHOP_RANDOM_SHOP_BUY_ACK: 2404,
  SHOP_FIXED_LIST_REQ: 2405,
  SHOP_FIXED_LIST_ACK: 2406,
  SHOP_REFRESH_REQ: 2407,
  SHOP_REFRESH_ACK: 2408,
  SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ: 2410,
  SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_ACK: 2411,
  SHOP_CHAIN_TAB_RESET_TIME_REQ: 2412,
  SHOP_CHAIN_TAB_RESET_TIME_ACK: 2413,
  SHOP_BUY_BUNDLE_TAB_REQ: 2414,
  SHOP_BUY_BUNDLE_TAB_ACK: 2415,
  ZLONG_USE_COUPON_REQ: 2417,
  ZLONG_USE_COUPON_ACK: 2418,
  ZLONG_USE_COUPON_REQ2: 2419,
  GAMEBASE_BUY_REQ: 2420,
  GAMEBASE_BUY_ACK: 2421,
  STEAM_BUY_INIT_REQ: 2424,
  STEAM_BUY_INIT_ACK: 2425,
  STEAM_BUY_REQ: 2426,
  SHOP_RANDOM_SHOP_BUY_LIST_REQ: 2428,
  SHOP_RANDOM_SHOP_BUY_LIST_ACK: 2429,
  FIRST_CASH_PURCHASE_NOT: 2409,
  CONSUMER_PACKAGE_UPDATED_NOT: 2422,
  CONSUMER_PACKAGE_REMOVED_NOT: 2423,
  SHOP_SUBSCRIPTION_NOT: 2427,
  POST_ARRIVE_NOT: 1618,
});

const SHOP_TEMPLET_FILES = ["LUA_SHOP_TEMPLET_01.json", "LUA_SHOP_TEMPLET_02.json"];
const SHOP_TAB_TEMPLET_FILES = ["LUA_SHOP_TAB_TEMPLET_01.json", "LUA_SHOP_TAB_TEMPLET_02.json"];
// This SKU is present in the shared Lua table but is rejected by the 9.21
// client content filter, so advertising it makes NKCUIShop dereference a
// missing ShopItemTemplet. Keep the server list within the client's registry.
const CLIENT_UNREGISTERED_PRODUCT_IDS = new Set([3208]);

let cachedCatalog = null;
let cachedConsumerPackageRows = null;
const INCLUDE_BEGINNER_PACKS = process.env.CS_SHOP_INCLUDE_BEGINNER_PACKS === "1";
function createShopHandler(packetId, name) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      ctx.socket = socket;
      const request = decodeShopRequest(ctx, packetId, packet.payload);
      const response = buildShopResponse(ctx, packetId, request);
      if (!response) return false;
      console.log(`[shop:${name}] ACK packetId=${response.packetId} ${formatShopRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      sendShopNotices(ctx, socket, response.notices);
      completeMissionTracking(ctx, socket, getSessionUser(ctx), null, { label: "shop-mission-update" });
      return true;
    },
  };
}

function buildCashBuyPossibleResponse(ctx, request) {
  const productMarketID = request.productMarketID || "";
  const productId = resolveProductId(findProductIdByMarketId(productMarketID), { fallbackToFirst: false });
  const purchaseOptions = {
    source: "cash",
    request,
    dedupe: false,
    requireActiveProduct: true,
    requireRealMoneyProduct: true,
  };
  const preflight = processProductPurchase(ctx, productId, 1, { ...purchaseOptions, preflightOnly: true });
  if (preflight.errorCode !== ERROR_CODES.OK) {
    return {
      packetId: PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_ACK,
      payload: buildCashBuyPossibleAck(ctx, productMarketID, request.selectIndices || [], productId, preflight.errorCode),
    };
  }
  console.log(`[resource] bypass external payment validation productId=${productId} marketId=${JSON.stringify(productMarketID)}`);
  return buildShopFixBuyResponse(ctx, request, productId, purchaseOptions);
}

function buildSteamBuyInitResponse(ctx, request) {
  const productId = resolveProductId(request.productId || 0, { fallbackToFirst: false });
  const purchaseOptions = {
    source: "steam",
    request,
    dedupe: false,
    requireActiveProduct: true,
    requireRealMoneyProduct: true,
  };
  const preflight = processProductPurchase(ctx, productId, 1, { ...purchaseOptions, preflightOnly: true });
  if (preflight.errorCode !== ERROR_CODES.OK) {
    return {
      packetId: PACKETS.STEAM_BUY_INIT_ACK,
      payload: buildSteamBuyInitAck(ctx, productId, preflight.errorCode),
    };
  }
  console.log(`[resource] bypass Steam overlay productId=${productId}`);
  return buildShopFixBuyResponse(ctx, request, productId, purchaseOptions);
}

function buildShopResponse(ctx, packetId, request) {
  switch (packetId) {
    case PACKETS.SHOP_FIXED_LIST_REQ:
      return {
        packetId: PACKETS.SHOP_FIXED_LIST_ACK,
        payload: buildShopFixedListAck(ctx, request),
      };
    default:
      return buildShopResponseInner(ctx, packetId, request);
  }
}

function buildShopResponseInner(ctx, packetId, request) {
  switch (packetId) {
    case PACKETS.SHOP_FIX_SHOP_BUY_REQ:
      return buildShopFixBuyResponse(ctx, request, resolveProductId(request.productID, { fallbackToFirst: false }));
    case PACKETS.SHOP_FIX_SHOP_CASH_BUY_REQ:
      return buildShopFixBuyResponse(
        ctx,
        request,
        resolveProductId(findProductIdByMarketId(request.productMarketID), { fallbackToFirst: false }),
        {
          source: "cash",
          dedupe: false,
        }
      );
    case PACKETS.GAMEBASE_BUY_REQ:
      return buildGamebaseBuyResponse(
        ctx,
        request,
        resolveProductId(
          findProductIdByPaymentId(request.paymentId) ||
            findProductIdByPaymentId(request.paymentSeq) ||
            findProductIdByMarketId(request.paymentId),
          { fallbackToFirst: false }
        )
      );
    case PACKETS.STEAM_BUY_REQ:
      return buildShopFixBuyResponse(ctx, request, resolveProductId(request.productId, { fallbackToFirst: false }), {
          source: "steam",
          requireActiveProduct: true,
          requireRealMoneyProduct: true,
        });
    case PACKETS.SHOP_RANDOM_SHOP_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_RANDOM_SHOP_BUY_ACK,
        payload: buildRandomShopBuyAck(ctx, request),
      };
    case PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ:
      return {
        packetId: PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_ACK,
        payload: buildRandomShopBuyListAck(ctx, request),
      };
    case PACKETS.SHOP_REFRESH_REQ:
      return {
        packetId: PACKETS.SHOP_REFRESH_ACK,
        payload: buildShopRefreshAck(ctx, request),
      };
    case PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ:
      return buildCashBuyPossibleResponse(ctx, request);
    case PACKETS.STEAM_BUY_INIT_REQ:
      return buildSteamBuyInitResponse(ctx, request);
    case PACKETS.SHOP_CHAIN_TAB_RESET_TIME_REQ:
      return {
        packetId: PACKETS.SHOP_CHAIN_TAB_RESET_TIME_ACK,
        payload: buildShopChainTabNextResetAck(ctx, request),
      };
    case PACKETS.SHOP_BUY_BUNDLE_TAB_REQ:
      return {
        packetId: PACKETS.SHOP_BUY_BUNDLE_TAB_ACK,
        payload: buildBundleTabBuyAck(ctx),
      };
    case PACKETS.ZLONG_USE_COUPON_REQ:
    case PACKETS.ZLONG_USE_COUPON_REQ2:
      return {
        packetId: PACKETS.ZLONG_USE_COUPON_ACK,
        payload: buildCouponAck(ctx),
      };
    default:
      return null;
  }
}

function buildShopFixedListAck(ctx, request = {}) {
  const errorCode = request.valid === false ? ERROR_CODES.INVALID_REQUEST : ERROR_CODES.OK;
  const productIds = errorCode ? [] : getFixedShopProductIds(ctx);
  return Buffer.concat([
    ctx.writeSignedVarInt(errorCode),
    writeIntList(ctx, productIds),
    writeObjectList([]), // InstantProductList
  ]);
}

function buildShopChainTabNextResetAck(ctx, request = {}) {
  const errorCode = request.valid === false ? ERROR_CODES.INVALID_REQUEST : ERROR_CODES.OK;
  return Buffer.concat([
    ctx.writeSignedVarInt(errorCode),
    errorCode ? writeObjectList([]) : buildShopChainTabNextResetListPayload(ctx),
  ]);
}

function buildShopChainTabNextResetListPayload(ctx) {
  return writeObjectList(getShopChainTabNextResetEntries(ctx).map((entry) => writeNullableObject(Buffer.concat([
    writeString(entry.tabType),
    writeSignedVarInt(entry.subIndex),
    writeInt64LE(entry.nextResetUtc),
  ]))));
}

function getShopChainTabNextResetEntries(ctx) {
  const now = currentRawTicks(ctx);
  return loadShopCatalog().tabRecords
    .filter((record) => record.m_bTabChain === true)
    .map((record) => ({
      tabType: String(record.m_TabID || ""),
      subIndex: Number(record.m_TabSubIndex || 0),
      nextResetUtc: nextShopTabResetTicks(now, parseResetDays(record.m_ResetDays)),
    }))
    .filter((entry) => entry.tabType && entry.nextResetUtc > 0n)
    .sort((left, right) => left.tabType.localeCompare(right.tabType) || left.subIndex - right.subIndex);
}

function parseResetDays(value) {
  return String(value || "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31)
    .sort((left, right) => left - right);
}

function nextShopTabResetTicks(now, resetDays) {
  if (!resetDays.length) return 0n;
  const currentTicks = toRawTicks(now);
  const currentMs = Number((currentTicks - DOTNET_TICKS_AT_UNIX_EPOCH) / TICKS_PER_MS);
  const current = new Date(currentMs);
  if (!Number.isFinite(current.getTime())) return 0n;
  for (const day of resetDays) {
    const target = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), day);
    const targetDate = new Date(target);
    if (targetDate.getUTCMonth() === current.getUTCMonth() && target >= currentMs) {
      return BigInt(target) * TICKS_PER_MS + DOTNET_TICKS_AT_UNIX_EPOCH;
    }
  }
  for (const day of resetDays) {
    const target = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, day);
    const targetDate = new Date(target);
    if (targetDate.getUTCDate() === day) return BigInt(target) * TICKS_PER_MS + DOTNET_TICKS_AT_UNIX_EPOCH;
  }
  return 0n;
}

function getFixedShopProductIds(ctxOrState = null) {
  const catalog = loadShopCatalog();
  const activeShop = getActiveEventShopState(ctxOrState);
  const activeTags = buildShopTagStateForCatalog(resolveEventShopActiveState(ctxOrState), catalog);
  const fixedProductIds = (catalog.productIds || []).filter((productId) => {
    const records = catalog.recordsByProductIdAll.get(productId) || [];
    return records.some((record) => (
      !shouldSuppressShopProduct(record) &&
      (isUngatedShopRecord(record) || isShopRecordActiveByState(record, activeTags))
    ));
  });
  return uniquePositiveInts([...fixedProductIds, ...(activeShop.productIds || [])]);
}

function isUngatedShopRecord(record) {
  return (
    getShopRecordAvailabilityIntervalTags(record).length === 0 &&
    getShopRecordOpenTags(record).length === 0 &&
    getShopRecordContentsTags(record).length === 0 &&
    getShopRecordContentsIgnoreTags(record).length === 0
  );
}

function buildShopFixBuyResponse(ctx, request, productId, options = {}) {
  const result = options.skipGrant
    ? {
        errorCode: ERROR_CODES.OK,
        reward: createEmptyReward(),
        costItem: null,
        history: null,
        totalPaidAmount: getShopTotalPaidAmount(getSessionUser(ctx)),
      }
    : processProductPurchase(ctx, productId, request && request.productCount, {
        source: options.source || "shop-buy",
        request,
        dedupe: options.dedupe,
        requireActiveProduct: options.requireActiveProduct,
        requireRealMoneyProduct: options.requireRealMoneyProduct,
      });
  return {
    packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
    payload: buildShopFixBuyAckPayload(ctx, request, productId, result),
    notices: result.notices || [],
  };
}

function buildShopFixBuyAckPayload(ctx, request, productId, result = {}) {
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode == null ? ERROR_CODES.OK : result.errorCode),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    ctx.writeSignedVarInt(productId || 0),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, request && request.productCount, result.history)),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null), // costItemData
    writeNullableObjectOrNull(result.subscriptionData ? buildShopSubscriptionData(result.subscriptionData) : null),
    writeDoubleLE(result.totalPaidAmount || 0),
  ]);
}

function buildGamebaseBuyResponse(ctx, request, productId) {
  const result = processProductPurchase(ctx, productId, request && request.productCount, {
    source: "gamebase",
    request,
  });
  return {
    packetId: PACKETS.GAMEBASE_BUY_ACK,
    payload: buildShopFixBuyAckPayload(ctx, request, productId, result),
    notices: result.notices || [],
  };
}

function buildRandomShopBuyAck(ctx, request = {}) {
  const slotIndex = Number(request.slotIndex || 0);
  const result = request.valid === false
    ? randomShopPurchaseResult(ERROR_CODES.INVALID_REQUEST)
    : processRandomShopPurchase(ctx, [slotIndex]);
  const success = result.errorCode === ERROR_CODES.OK;
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    ctx.writeSignedVarInt(slotIndex),
    success ? writeNullableObject(buildRewardData(ctx, result.reward)) : writeNullObject(),
    success && result.costItems[0] ? writeNullableObject(buildItemMiscData(ctx, result.costItems[0])) : writeNullObject(),
  ]);
}

function buildRandomShopBuyListAck(ctx, request = {}) {
  const slotIndexes = Array.isArray(request.slotIndexes) ? request.slotIndexes : [];
  const result = request.valid === false
    ? randomShopPurchaseResult(ERROR_CODES.INVALID_REQUEST)
    : processRandomShopPurchase(ctx, slotIndexes);
  const success = result.errorCode === ERROR_CODES.OK;
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    writeIntList(ctx, slotIndexes),
    success ? writeNullableObject(buildRewardData(ctx, result.reward)) : writeNullObject(),
    writeObjectList(success ? result.costItems.map((item) => writeNullableObject(buildItemMiscData(ctx, item))) : []),
  ]);
}

function buildShopRefreshAck(ctx, request = {}) {
  const result = request.valid === false
    ? { errorCode: ERROR_CODES.INVALID_REQUEST, randomShop: null, costItem: null }
    : refreshRandomShop(ctx, Boolean(request.isUseCash));
  const success = result.errorCode === ERROR_CODES.OK;
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    success && result.randomShop ? writeNullableObject(buildRandomShopData(result.randomShop)) : writeNullObject(),
    success && result.costItem ? writeNullableObject(buildItemMiscData(ctx, result.costItem)) : writeNullObject(),
  ]);
}

function buildCashBuyPossibleAck(ctx, productMarketID, selectIndices, productId = 0, errorCode = ERROR_CODES.OK) {
  return Buffer.concat([
    ctx.writeSignedVarInt(errorCode),
    writeString(productMarketID || ""),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, 0)),
    writeIntList(ctx, selectIndices),
  ]);
}

function buildBundleTabBuyAck(ctx) {
  const reward = grantFallbackReward(ctx);
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeNullableObject(buildRewardData(ctx, reward)),
    writeNullObject(), // costItemData
    writeObjectList([]), // history
    writeObjectList([]), // subscriptionData
  ]);
}

function buildCouponAck(ctx) {
  const reward = grantFallbackReward(ctx);
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    ctx.writeSignedVarInt(0), // zlongInfoCode
    writeNullableObject(buildRewardData(ctx, reward)),
  ]);
}

function buildSteamBuyInitAck(ctx, productId, errorCode = ERROR_CODES.OK) {
  return Buffer.concat([
    ctx.writeSignedVarInt(errorCode),
    ctx.writeSignedVarInt(productId || 0),
    writeString(errorCode === ERROR_CODES.OK ? makeLocalOrderId(productId) : ""),
  ]);
}

function buildSerializedRandomShopData(user, options = {}) {
  return buildRandomShopData(ensureRandomShopState(user, options));
}

function buildRandomShopData(randomShop) {
  const state = randomShop && typeof randomShop === "object" ? randomShop : createFreshRandomShopState(null, utcTicksNow());
  const slots = normalizeRandomShopSlots(state.slots);
  const entries = Object.entries(slots)
    .map(([index, slot]) => [Number(index), buildRandomShopListData(slot)])
    .sort((a, b) => a[0] - b[0]);
  return Buffer.concat([
    writeObjectMapInt(entries),
    writeSignedVarLong(toBigInt(state.nextRefreshDate || 0, 0n)),
    writeSignedVarInt(Number(state.refreshCount || 0)),
  ]);
}

function buildRandomShopListData(slot) {
  const data = slot || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.itemId || 0)),
    writeSignedVarInt(rewardTypeValue(data.itemType)),
    writeSignedVarInt(Number(data.itemCount || 0)),
    writeSignedVarInt(Number(data.priceItemId || 0)),
    writeSignedVarInt(Number(data.price || 0)),
    writeBool(Boolean(data.isBuy)),
    writeSignedVarInt(Number(data.discountRatio || 0)),
  ]);
}

function refreshRandomShop(ctx, useCash) {
  const user = getSessionUser(ctx);
  const now = currentRawTicks(ctx);
  const state = ensureRandomShopState(user, { now, autoRefresh: false });
  let costItem = null;

  if (useCash) {
    resetRandomShopRefreshCount(state, now);
    if (Number(state.refreshCount || 0) <= 0) {
      return { errorCode: ERROR_CODES.NOT_ENOUGH_REFRESH_COUNT, randomShop: state, costItem: null };
    }
    if (!hasEnoughMiscItem(user, RANDOM_SHOP_REFRESH_COST_ITEM_ID, RANDOM_SHOP_REFRESH_COST)) {
      return { errorCode: ERROR_CODES.INSUFFICIENT_CASH, randomShop: state, costItem: null };
    }
    costItem = spendMiscItem(user, RANDOM_SHOP_REFRESH_COST_ITEM_ID, RANDOM_SHOP_REFRESH_COST, {
      regDate: currentDateTimeBinary(ctx),
    });
    state.refreshCount = Math.max(0, Number(state.refreshCount || 0) - 1);
  } else if (!isRandomShopExpired(state, now) && Object.keys(normalizeRandomShopSlots(state.slots)).length > 0) {
    return { errorCode: ERROR_CODES.CANNOT_REFRESH, randomShop: null, costItem: null };
  }

  rotateRandomShopState(user, state, now);
  persistUserDb(ctx);
  return { errorCode: ERROR_CODES.OK, randomShop: state, costItem };
}

function processRandomShopPurchase(ctx, slotIndexes) {
  const user = getSessionUser(ctx);
  const now = currentRawTicks(ctx);
  const previousState = user && Object.prototype.hasOwnProperty.call(user, "randomShop")
    ? JSON.stringify(user.randomShop)
    : null;
  const state = ensureRandomShopState(user, { now, autoRefresh: false });
  const rawRequested = Array.isArray(slotIndexes) ? slotIndexes.map(Number) : [];
  const requested = uniquePositiveInts(rawRequested);
  const slots = normalizeRandomShopSlots(state.slots);
  const fail = (errorCode) => {
    restoreRandomShopState(user, previousState);
    return randomShopPurchaseResult(errorCode);
  };
  if (isRandomShopExpired(state, now)) return fail(ERROR_CODES.CANNOT_REFRESH);
  if (!requested.length) return fail(ERROR_CODES.INVALID_SHOP_ID);
  if (requested.length !== rawRequested.length) return fail(ERROR_CODES.INVALID_REQUEST);

  const selected = [];
  for (const index of requested) {
    const slot = slots[String(index)];
    if (!slot) return fail(ERROR_CODES.INVALID_SHOP_ID);
    if (slot.isBuy) return fail(ERROR_CODES.LIMITED_SHOP_COUNT);
    selected.push([index, slot]);
  }

  const pricesByItemId = new Map();
  for (const [, slot] of selected) {
    const priceItemId = Number(slot.priceItemId || 0);
    const price = getRandomShopSlotPrice(slot);
    if (priceItemId > 0 && price > 0) {
      pricesByItemId.set(priceItemId, (pricesByItemId.get(priceItemId) || 0) + price);
    }
  }
  for (const [priceItemId, totalPrice] of pricesByItemId) {
    if (!hasEnoughMiscItem(user, priceItemId, totalPrice)) {
      return fail(priceItemId === RANDOM_SHOP_REFRESH_COST_ITEM_ID ? ERROR_CODES.INSUFFICIENT_CASH : ERROR_CODES.INSUFFICIENT_RESOURCE);
    }
  }

  const reward = createEmptyReward();
  const regDate = currentDateTimeBinary(ctx);
  for (const [, slot] of selected) {
    mergeReward(
      reward,
      grantRewardByType(ctx, user, slot.itemType, slot.itemId, slot.itemCount, slot.itemCount, 0n, {
        regDate,
        expandPackages: false,
      })
    );
    slot.isBuy = true;
  }

  const costItems = [];
  for (const [priceItemId, totalPrice] of pricesByItemId) {
    const costItem = spendMiscItem(user, priceItemId, totalPrice, { regDate });
    if (costItem) costItems.push(costItem);
  }
  state.slots = slots;
  persistUserDb(ctx);
  return randomShopPurchaseResult(ERROR_CODES.OK, reward, costItems);
}

function restoreRandomShopState(user, serializedState) {
  if (!user || typeof user !== "object") return;
  if (serializedState == null) delete user.randomShop;
  else user.randomShop = JSON.parse(serializedState);
}

function randomShopPurchaseResult(errorCode, reward = createEmptyReward(), costItems = []) {
  return { errorCode, reward, costItems: Array.isArray(costItems) ? costItems : [] };
}

function ensureRandomShopState(user, options = {}) {
  const now = toRawTicks(options.now || utcTicksNow());
  const state = normalizeRandomShopState(user ? user.randomShop : null, user, now);
  resetRandomShopRefreshCount(state, now);
  if (options.autoRefresh !== false && isRandomShopExpired(state, now)) {
    rotateRandomShopState(user, state, now);
  }
  if (user && typeof user === "object") user.randomShop = state;
  return state;
}

function normalizeRandomShopState(existing, user, now) {
  const state = existing && typeof existing === "object" ? existing : {};
  state.version = RANDOM_SHOP_STATE_VERSION;
  state.generation = Math.max(0, Number(state.generation || 0));
  state.refreshCount = clampRefreshCount(state.refreshCount);
  state.refreshDay = state.refreshDay || utcDayKey(now);
  state.nextRefreshDate = String(toRawTicks(state.nextRefreshDate || 0n));
  state.slots = normalizeRandomShopSlots(state.slots);
  if (!Object.keys(state.slots).length || toRawTicks(state.nextRefreshDate) <= 0n) {
    rotateRandomShopState(user, state, now);
  }
  return state;
}

function rotateRandomShopState(user, state, now = utcTicksNow()) {
  const rawNow = toRawTicks(now);
  state.version = RANDOM_SHOP_STATE_VERSION;
  state.generation = Math.max(0, Number(state.generation || 0)) + 1;
  state.refreshDay = state.refreshDay || utcDayKey(rawNow);
  state.slots = createRandomShopSlots(user, state.generation, rawNow);
  state.nextRefreshDate = String(nextRandomShopRefreshTicks(rawNow));
  return state;
}

function createFreshRandomShopState(user, now = utcTicksNow()) {
  const state = {
    version: RANDOM_SHOP_STATE_VERSION,
    generation: 0,
    refreshCount: RANDOM_SHOP_REFRESH_MAX_COUNT,
    refreshDay: utcDayKey(now),
    nextRefreshDate: "0",
    slots: {},
  };
  return rotateRandomShopState(user, state, now);
}

function createRandomShopSlots(user, generation, now) {
  const seed = hashString(`${user && user.userUid ? user.userUid : "local"}:${generation}:${randomShopIntervalBucket(now)}`);
  const rng = mulberry32(seed);
  let pool = RANDOM_SHOP_POOL.map((entry) => ({ ...entry }));
  const slots = {};
  for (let index = 1; index <= RANDOM_SHOP_SLOT_COUNT; index += 1) {
    if (!pool.length) pool = RANDOM_SHOP_POOL.map((entry) => ({ ...entry }));
    const pickedIndex = pickWeightedIndex(pool, rng);
    const picked = pool.splice(pickedIndex, 1)[0] || RANDOM_SHOP_POOL[0];
    slots[String(index)] = normalizeRandomShopSlot(picked);
  }
  return slots;
}

function normalizeRandomShopSlots(slots) {
  const source = slots && typeof slots === "object" ? slots : {};
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index <= 0) continue;
    const slot = normalizeRandomShopSlot(value);
    if (slot.itemId <= 0 || rewardTypeValue(slot.itemType) <= 0) continue;
    normalized[String(index)] = slot;
  }
  return normalized;
}

function normalizeRandomShopSlot(slot) {
  const data = slot && typeof slot === "object" ? slot : {};
  return {
    itemId: Math.max(0, Number(data.itemId || data.itemID || 0) | 0),
    itemType: normalizeRewardType(data.itemType),
    itemCount: Math.max(1, Number(data.itemCount || data.count || 1) | 0),
    priceItemId: Math.max(0, Number(data.priceItemId || data.priceItemID || 0) | 0),
    price: Math.max(0, Number(data.price || 0) | 0),
    isBuy: Boolean(data.isBuy),
    discountRatio: Math.max(0, Math.min(100, Number(data.discountRatio || 0) | 0)),
  };
}

function resetRandomShopRefreshCount(state, now) {
  const day = utcDayKey(now);
  if (state.refreshDay !== day) {
    state.refreshDay = day;
    state.refreshCount = RANDOM_SHOP_REFRESH_MAX_COUNT;
  } else {
    state.refreshCount = clampRefreshCount(state.refreshCount);
  }
}

function clampRefreshCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return RANDOM_SHOP_REFRESH_MAX_COUNT;
  return Math.max(0, Math.min(RANDOM_SHOP_REFRESH_MAX_COUNT, Math.trunc(count)));
}

function isRandomShopExpired(state, now) {
  const nextRefreshDate = toRawTicks(state && state.nextRefreshDate);
  return nextRefreshDate <= 0n || nextRefreshDate <= toRawTicks(now);
}

function nextRandomShopRefreshTicks(now) {
  const intervalTicks = BigInt(Math.max(1, Math.trunc(RANDOM_SHOP_REFRESH_INTERVAL_HOURS))) * TICKS_PER_HOUR;
  const elapsed = toRawTicks(now) - DOTNET_TICKS_AT_UNIX_EPOCH;
  return DOTNET_TICKS_AT_UNIX_EPOCH + ((elapsed / intervalTicks) + 1n) * intervalTicks;
}

function randomShopIntervalBucket(now) {
  const intervalTicks = BigInt(Math.max(1, Math.trunc(RANDOM_SHOP_REFRESH_INTERVAL_HOURS))) * TICKS_PER_HOUR;
  return String((toRawTicks(now) - DOTNET_TICKS_AT_UNIX_EPOCH) / intervalTicks);
}

function utcDayKey(ticks) {
  const ms = Number((toRawTicks(ticks) - DOTNET_TICKS_AT_UNIX_EPOCH) / TICKS_PER_MS);
  return new Date(ms).toISOString().slice(0, 10);
}

function utcTicksNow() {
  return BigInt(Date.now()) * TICKS_PER_MS + DOTNET_TICKS_AT_UNIX_EPOCH;
}

function toRawTicks(value) {
  try {
    const raw = BigInt(value || 0);
    return raw > DATE_TIME_LOCAL_MASK ? raw & DATE_TIME_TICKS_MASK : raw;
  } catch (_) {
    return 0n;
  }
}

function currentRawTicks(ctx) {
  return toRawTicks(ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : utcTicksNow());
}

function currentDateTimeBinary(ctx) {
  return ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n;
}

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function readNonNegativeIntEnv(name, fallback) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function getRandomShopSlotPrice(slot) {
  const price = Math.max(0, Number(slot && slot.price) || 0);
  const discountRatio = Math.max(0, Math.min(100, Number(slot && slot.discountRatio) || 0));
  return Math.floor((price * (100 - discountRatio)) / 100);
}

function hasEnoughMiscItem(user, itemId, amount) {
  const required = toBigInt(amount, 0n);
  if (required <= 0n) return true;
  const item = getMiscItem(user, itemId);
  const available = toBigInt(item && item.countFree, 0n) + toBigInt(item && item.countPaid, 0n);
  return available >= required;
}

function rewardTypeValue(type) {
  return REWARD_TYPE_VALUES[normalizeRewardType(type)] || 0;
}

function normalizeRewardType(type) {
  const text = String(type || "RT_MISC").toUpperCase();
  return REWARD_TYPE_VALUES[text] == null ? "RT_MISC" : text;
}

function uniquePositiveInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function pickWeightedIndex(pool, rng) {
  const total = pool.reduce((sum, entry) => sum + Math.max(1, Number(entry.weight || 1)), 0);
  let roll = rng() * total;
  for (let index = 0; index < pool.length; index += 1) {
    roll -= Math.max(1, Number(pool[index].weight || 1));
    if (roll <= 0) return index;
  }
  return Math.max(0, pool.length - 1);
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = Number(seed) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function decodeShopRequest(ctx, packetId, encryptedPayload) {
  const payload = safeDecrypt(ctx, encryptedPayload);
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case PACKETS.SHOP_FIXED_LIST_REQ:
        return { valid: payload.length === 0 };
      case PACKETS.SHOP_FIX_SHOP_BUY_REQ:
      {
        const productID = reader.int();
        const productCount = reader.int();
        const selectIndices = reader.intList();
        return { productID, productCount, selectIndices, valid: reader.done() };
      }
      case PACKETS.SHOP_FIX_SHOP_CASH_BUY_REQ:
        return {
          productMarketID: reader.string(),
          validationToken: reader.string(),
          realCash: reader.double(),
          currencyType: reader.int(),
          currencyCode: reader.string(),
          selectIndices: reader.intList(),
        };
      case PACKETS.SHOP_RANDOM_SHOP_BUY_REQ:
      {
        const slotIndex = reader.int();
        return { slotIndex, valid: reader.done() };
      }
      case PACKETS.SHOP_REFRESH_REQ:
        return {
          isUseCash: payload.length === 1 && payload[0] !== 0,
          valid: payload.length === 1 && (payload[0] === 0 || payload[0] === 1),
        };
      case PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ:
      {
        const productMarketID = reader.string();
        const selectIndices = reader.intList();
        return { productMarketID, selectIndices, valid: reader.done() };
      }
      case PACKETS.SHOP_CHAIN_TAB_RESET_TIME_REQ:
        return { valid: payload.length === 0 };
      case PACKETS.SHOP_BUY_BUNDLE_TAB_REQ:
        return {
          tabType: reader.string(),
          subIndex: reader.int(),
        };
      case PACKETS.ZLONG_USE_COUPON_REQ:
        return { couponCode: reader.string() };
      case PACKETS.ZLONG_USE_COUPON_REQ2:
        return {
          couponCode: reader.string(),
          zlongServerId: reader.int(),
        };
      case PACKETS.GAMEBASE_BUY_REQ:
        return {
          paymentSeq: reader.string(),
          accessToken: reader.string(),
          selectIndices: reader.intList(),
          paymentId: reader.string(),
        };
      case PACKETS.STEAM_BUY_INIT_REQ:
      {
        const steamId = reader.string();
        const productId = reader.int();
        const language = reader.string();
        const country = reader.string();
        const itemShopDesc = reader.string();
        return { steamId, productId, language, country, itemShopDesc, valid: reader.done() };
      }
      case PACKETS.STEAM_BUY_REQ:
      {
        const steamId = reader.string();
        const orderId = reader.string();
        const productId = reader.int();
        const country = reader.string();
        const currency = reader.string();
        const selectIndices = reader.intList();
        return { steamId, orderId, productId, country, currency, selectIndices, valid: reader.done() && Boolean(orderId) };
      }
      case PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ:
      {
        const slotIndexes = reader.intList();
        return { slotIndexes, valid: reader.done() };
      }
      default:
        return {};
    }
  } catch (err) {
    console.log(`[shop] request decode failed packetId=${packetId}: ${err.message}`);
    if (
      packetId === PACKETS.SHOP_FIX_SHOP_BUY_REQ ||
      packetId === PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ ||
      packetId === PACKETS.STEAM_BUY_INIT_REQ ||
      packetId === PACKETS.STEAM_BUY_REQ ||
      packetId === PACKETS.SHOP_RANDOM_SHOP_BUY_REQ ||
      packetId === PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ
    ) {
      return { valid: false };
    }
    return {};
  }
}

function safeDecrypt(ctx, payload) {
  try {
    return ctx.decryptCopy(payload);
  } catch (_) {
    return Buffer.alloc(0);
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
    string() {
      const length = readSignedVarInt(buffer, offset);
      offset = length.offset;
      if (length.value < 0) return "";
      const end = offset + length.value;
      if (end > buffer.length) throw new Error("truncated string");
      const value = buffer.subarray(offset, end).toString("utf8");
      offset = end;
      return value;
    },
    intList() {
      const count = readVarInt(buffer, offset);
      offset = count.offset;
      const values = [];
      for (let index = 0; index < count.value; index += 1) {
        const read = readSignedVarInt(buffer, offset);
        offset = read.offset;
        values.push(read.value);
      }
      return values;
    },
    bool() {
      if (offset >= buffer.length) return false;
      return buffer.readUInt8(offset++) !== 0;
    },
    double() {
      if (offset + 8 > buffer.length) return 0;
      const value = buffer.readDoubleLE(offset);
      offset += 8;
      return value;
    },
    done() {
      return offset === buffer.length;
    },
  };
}

function loadShopCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const productIds = new Set();
  const marketToProductId = new Map();
  const recordsByProductId = new Map();
  const recordsByProductIdAll = new Map();
  const records = [];
  const priceItemIds = new Set();
  const tabRecords = [];
  let suppressedProducts = 0;

  for (const fileName of SHOP_TEMPLET_FILES) {
    try {
      for (const record of readGameplayTableRecords("ab_script", fileName, { rootDir: ROOT_DIR, logLabel: "shop" })) {
        const productId = Number(record && record.m_ProductID);
        if (!Number.isInteger(productId) || productId <= 0) continue;
        const priceItemId = Number(record && record.m_PriceItemID);
        addProductRecord(recordsByProductIdAll, productId, record);
        if (record.m_MarketID != null && String(record.m_MarketID).length > 0) {
          marketToProductId.set(String(record.m_MarketID), productId);
        }
        if (shouldSuppressShopProduct(record)) {
          suppressedProducts += 1;
          continue;
        }
        if (Number.isInteger(priceItemId) && priceItemId > 0) priceItemIds.add(priceItemId);
        records.push(record);
        recordsByProductId.set(productId, pickPreferredProductRecord(recordsByProductId.get(productId), record));
        if (shouldAdvertiseFixedShopProduct(record)) productIds.add(productId);
      }
    } catch (err) {
      console.log(`[shop] failed to load ${fileName}: ${err.message}`);
    }
  }

  for (const fileName of SHOP_TAB_TEMPLET_FILES) {
    try {
      for (const record of readGameplayTableRecords("ab_script", fileName, { rootDir: ROOT_DIR, logLabel: "shop" })) {
        if (!record || typeof record !== "object") continue;
        if (shouldSuppressShopTab(record)) continue;
        tabRecords.push(record);
      }
    } catch (err) {
      console.log(`[shop] failed to load ${fileName}: ${err.message}`);
    }
  }

  cachedCatalog = {
    productIds: Array.from(productIds).sort((a, b) => a - b),
    marketToProductId,
    recordsByProductId,
    recordsByProductIdAll,
    records,
    tabRecords,
    priceItemIds: Array.from(priceItemIds).sort((a, b) => a - b),
  };
  console.log(
    `[shop] catalog loaded products=${cachedCatalog.productIds.length} tabs=${tabRecords.length} marketIds=${marketToProductId.size} priceItems=${cachedCatalog.priceItemIds.length} suppressed=${suppressedProducts}`
  );
  return cachedCatalog;
}

function addProductRecord(map, productId, record) {
  const records = map.get(productId);
  if (records) {
    records.push(record);
  } else {
    map.set(productId, [record]);
  }
}

function pickPreferredProductRecord(existing, incoming) {
  if (!existing) return incoming;
  return productRecordScore(incoming) > productRecordScore(existing) ? incoming : existing;
}

function productRecordScore(record) {
  if (!record) return 0;
  let score = 0;
  if (record.m_bEnabled === true) score += 4;
  if (record.m_bVisible === true) score += 2;
  if (!String(record.m_TabID || "").includes("NO_USE")) score += 1;
  return score;
}

function shouldSuppressShopProduct(record) {
  if (!record) return true;
  if (CLIENT_UNREGISTERED_PRODUCT_IDS.has(Number(record.m_ProductID))) return true;
  if (record.m_bEnabled === false || record.m_bVisible === false) return true;
  if (isNoUseShopRecord(record)) return true;
  if (INCLUDE_BEGINNER_PACKS) return false;
  if (record && record.m_bUnlockBanner === true) return true;

  const searchableFields = [
    record && record.m_TabID,
    record && record.m_TabName,
    record && record.m_ItemName,
    record && record.m_Item_Desc,
    record && record.m_Item_Desc_Popup,
    record && record.m_TopBannerText,
    record && record.m_CardPrefab,
    ...(Array.isArray(record && record.listContentsTagAllow) ? record.listContentsTagAllow : []),
    ...(Array.isArray(record && record.listContentsTagIgnore) ? record.listContentsTagIgnore : []),
  ];

  const text = searchableFields.filter((value) => value != null).join(" ").toUpperCase();
  return text.includes("NEWBIE") || text.includes("BEGINNER") || text.includes("STARTER");
}

function shouldAdvertiseFixedShopProduct(record) {
  return Boolean(record) && !isEventLimitedShopRecord(record);
}

function shouldSuppressShopTab(record) {
  if (!record) return true;
  if (record.m_bEnabled === false || record.m_bVisible === false || record.m_Visible === false) return true;
  return isNoUseShopRecord(record);
}

function isNoUseShopRecord(record) {
  const tabId = String(record && (record.m_TabID || record.ShopTabID) || "").trim().toUpperCase();
  return !tabId || tabId === "TAB_NO_USE" || tabId.includes("NO_USE");
}

function findProductIdByMarketId(marketId) {
  const raw = String(marketId || "").trim();
  if (!raw) return 0;
  const catalog = loadShopCatalog();
  const exact = catalog.marketToProductId.get(raw);
  if (exact) return exact;

  const normalized = normalizeMarketId(raw);
  for (const [candidate, productId] of catalog.marketToProductId.entries()) {
    if (normalizeMarketId(candidate) === normalized) return productId;
  }

  const directProductId = parsePositiveInt(raw);
  if (hasCatalogProductId(catalog, directProductId)) return directProductId;

  const trailingMatch = raw.match(/(\d+)(?!.*\d)/);
  const trailingProductId = trailingMatch ? parsePositiveInt(trailingMatch[1]) : 0;
  if (hasCatalogProductId(catalog, trailingProductId)) return trailingProductId;
  return 0;
}

function findProductIdByPaymentId(paymentId) {
  const number = Number(paymentId);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function resolveProductId(productId, options = {}) {
  const number = Number(productId);
  if (Number.isInteger(number) && number > 0) return number;
  if (options.fallbackToFirst === false) return 0;
  return loadShopCatalog().productIds[0] || 0;
}

function normalizeMarketId(value) {
  return String(value || "").trim().toLowerCase();
}

function parsePositiveInt(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return 0;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function hasCatalogProductId(catalog, productId) {
  const id = Number(productId);
  return Number.isInteger(id) && id > 0 && (
    (catalog.recordsByProductIdAll && catalog.recordsByProductIdAll.has(id)) ||
    (catalog.recordsByProductId && catalog.recordsByProductId.has(id)) ||
    (Array.isArray(catalog.productIds) && catalog.productIds.includes(id))
  );
}

function findProductRecord(productId, ctxOrState = null) {
  const catalog = loadShopCatalog();
  const id = Number(productId);
  const records = catalog.recordsByProductIdAll.get(id) || [];
  if (!records.length) return catalog.recordsByProductId.get(id) || null;
  const activeTags = buildShopTagStateForCatalog(resolveEventShopActiveState(ctxOrState), catalog);
  const activeRecords = records.filter((record) => isShopRecordActiveByState(record, activeTags));
  return pickBestProductRecord(activeRecords.length ? activeRecords : records, activeTags) || catalog.recordsByProductId.get(id) || null;
}

function getActiveEventShopState(ctxOrState = null, options = {}) {
  const state = resolveEventShopActiveState(ctxOrState);
  const catalog = loadShopCatalog();
  const activeTags = buildActiveShopTagState(state);
  const includeAllEventShops = shouldIncludeAllEventShops(options);
  const allEventTabs = includeAllEventShops ? collectAllEventShopTags(catalog, activeTags) : new Set();
  const eventTabs = new Set(
    (catalog.tabRecords || []).filter(isEventLimitedShopRecord).map(shopRecordTabKey).filter(Boolean)
  );
  const activeTabs = new Set();
  const activeTabRecords = [];

  for (const tab of catalog.tabRecords || []) {
    const key = shopRecordTabKey(tab);
    if (isShopRecordActive(tab, activeTags) || (includeAllEventShops && isEventLimitedShopRecord(tab))) {
      if (key) activeTabs.add(key);
      activeTabRecords.push(tab);
    }
  }

  const productIds = [];
  const priceItemIds = new Set();
  const intervalTags = new Set();
  const openTags = new Set();
  const contentsTags = new Set();

  for (const tab of activeTabRecords) {
    for (const tag of getShopRecordIntervalTags(tab)) intervalTags.add(tag);
    for (const tag of getShopRecordOpenTags(tab)) openTags.add(tag);
    for (const tag of getShopRecordContentsTags(tab)) contentsTags.add(tag);
  }

  for (const record of catalog.records || []) {
    const tabKey = shopRecordTabKey(record);
    const eventLimited = isEventLimitedShopRecord(record) || allEventTabs.has(tabKey);
    const recordActive =
      isShopRecordActiveByState(record, activeTags) ||
      (activeTabs.has(tabKey) && isUngatedShopRecord(record));
    const active =
      (recordActive && (!eventTabs.has(tabKey) || activeTabs.has(tabKey))) ||
      (includeAllEventShops && eventLimited);
    if (!active) continue;
    const productId = Number(record && record.m_ProductID);
    if (Number.isInteger(productId) && productId > 0) productIds.push(productId);
    const priceItemId = Number(record && record.m_PriceItemID);
    if (Number.isInteger(priceItemId) && priceItemId > 0 && eventLimited) {
      priceItemIds.add(priceItemId);
    }
    for (const tag of getShopRecordIntervalTags(record)) intervalTags.add(tag);
    for (const tag of getShopRecordOpenTags(record)) openTags.add(tag);
    for (const tag of getShopRecordContentsTags(record)) contentsTags.add(tag);
  }

  return {
    productIds: uniquePositiveInts(productIds),
    priceItemIds: Array.from(priceItemIds).sort((a, b) => a - b),
    intervalTags: Array.from(intervalTags).sort(),
    openTags: Array.from(openTags).sort(),
    contentsTags: Array.from(contentsTags).sort(),
    tabCount: new Set([...activeTabs, ...allEventTabs]).size,
  };
}

function filterEventClockShopOpenTags(tags, ctxOrState = null) {
  const active = new Set(getActiveEventShopState(ctxOrState).openTags.map((tag) => tag.toUpperCase()));
  const event = new Set(
    getActiveEventShopState(ctxOrState, { includeAllEventShops: true }).openTags.map((tag) => tag.toUpperCase())
  );
  return (Array.isArray(tags) ? tags : []).filter((tag) => {
    const key = String(tag || "").toUpperCase();
    return !event.has(key) || active.has(key);
  });
}

function ensureActiveEventShopCurrencies(user, eventManagerOrState = null, options = {}) {
  if (!EVENT_SHOP_SEED_CURRENCIES || !user) return { seeded: [], active: getActiveEventShopState(eventManagerOrState, options) };
  const active = getActiveEventShopState(eventManagerOrState, options);
  const seedItemIds = (active.priceItemIds || []).filter((itemId) => itemId > 0 && !isCommonResourceItemId(itemId));
  if (!seedItemIds.length) return { seeded: [], active };
  seedShopCurrency(user, seedItemIds, {
    balance: options.balance || EVENT_SHOP_CURRENCY_BALANCE,
    regDate: options.regDate || 0n,
    seedMissingOnly: options.seedMissingOnly !== false,
    includeCommonResources: false,
  });
  return { seeded: seedItemIds, active };
}

function resolveEventShopActiveState(ctxOrState) {
  let state = null;
  if (ctxOrState && typeof ctxOrState.getActiveEventState === "function") state = ctxOrState.getActiveEventState();
  else if (ctxOrState && ctxOrState.eventManager && typeof ctxOrState.eventManager.getActiveEventState === "function") {
    state = ctxOrState.eventManager.getActiveEventState();
  } else if (ctxOrState && Array.isArray(ctxOrState.intervalData)) state = ctxOrState;

  if (!ctxOrState || typeof ctxOrState.getEffectiveContentsTags !== "function") return state;
  return {
    ...(state || {}),
    contentsTags: Array.from(new Set([
      ...((state && state.contentsTags) || []),
      ...ctxOrState.getEffectiveContentsTags((ctxOrState.config && ctxOrState.config.CONTENTS_TAGS) || []),
    ])),
  };
}

function shouldIncludeAllEventShops(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "includeAllEventShops")) return Boolean(options.includeAllEventShops);
  return EVENT_SHOP_INCLUDE_ALL;
}

function buildShopTagStateForCatalog(state, catalog, options = {}) {
  const activeTags = buildActiveShopTagState(state);
  if (shouldIncludeAllEventShops(options)) collectAllEventShopTags(catalog, activeTags);
  return activeTags;
}

function collectAllEventShopTags(catalog, activeTags = buildActiveShopTagState(null)) {
  const eventTabs = new Set();
  const addRecord = (record) => {
    if (!record) return;
    const key = shopRecordTabKey(record);
    if (key) eventTabs.add(key);
    addShopRecordTags(activeTags, record);
  };

  for (const tab of catalog && catalog.tabRecords || []) {
    if (isEventLimitedShopRecord(tab)) addRecord(tab);
  }
  for (const record of catalog && catalog.records || []) {
    if (isEventLimitedShopRecord(record)) addRecord(record);
  }
  for (const record of catalog && catalog.records || []) {
    if (eventTabs.has(shopRecordTabKey(record))) addRecord(record);
  }

  return eventTabs;
}

function addShopRecordTags(activeTags, record) {
  for (const tag of getShopRecordIntervalTags(record)) addUsableShopTag(activeTags.intervals, tag);
  for (const tag of getShopRecordOpenTags(record)) addUsableShopTag(activeTags.openTags, tag);
  for (const tag of getShopRecordContentsTags(record)) addUsableShopTag(activeTags.contentsTags, tag);
}

function buildActiveShopTagState(state) {
  const intervals = new Set();
  const openTags = new Set();
  const contentsTags = new Set();
  for (const interval of Array.isArray(state && state.intervalData) ? state.intervalData : []) {
    addUsableShopTag(intervals, interval && interval.strKey);
  }
  for (const tag of state && state.openTags || []) addUsableShopTag(openTags, tag);
  for (const tag of state && state.contentsTags || []) addUsableShopTag(contentsTags, tag);
  for (const tag of state && state.counterPassContentsTags || []) addUsableShopTag(contentsTags, tag);
  return { intervals, openTags, contentsTags };
}

function isShopRecordActive(record, activeTags) {
  if (!record || !activeTags) return false;
  return (
    isShopRecordActiveByState(record, activeTags)
  );
}

function isShopRecordActiveByState(record, activeTags) {
  if (!record || !activeTags) return false;
  if (hasUsableTagIntersection(activeTags.contentsTags, getShopRecordContentsIgnoreTags(record))) return false;
  const availabilityIntervalTags = getShopRecordAvailabilityIntervalTags(record);
  if (availabilityIntervalTags.length) {
    return hasUsableTagIntersection(activeTags.intervals, availabilityIntervalTags);
  }
  return (
    hasUsableTagIntersection(activeTags.intervals, getShopRecordIntervalTags(record)) ||
    hasUsableTagIntersection(activeTags.openTags, getShopRecordOpenTags(record)) ||
    hasUsableTagIntersection(activeTags.contentsTags, getShopRecordContentsTags(record))
  );
}

function isEventLimitedShopRecord(record) {
  if (!record) return false;
  const tabId = String(record.m_TabID || record.ShopTabID || "").trim().toUpperCase();
  const availabilityIntervalTags = getShopRecordAvailabilityIntervalTags(record);
  const text = [
    tabId,
    ...availabilityIntervalTags,
    ...getShopRecordOpenTags(record),
    ...getShopRecordContentsTags(record),
  ].join("|");
  return (
    availabilityIntervalTags.length > 0 ||
    tabId === "TAB_EVENT" ||
    tabId === "TAB_EVENT_V2" ||
    tabId.startsWith("TAB_PACKAGE_CLB") ||
    /\bCLB_\d+\b/.test(text) ||
    /SHOP_TAB_PACKAGE_CLB/i.test(text) ||
    /DATE_COMMON_SHOP_EVENT/i.test(text) ||
    /SHOP_EVENT|COMMON_EVENT|POINT_EXCHANGE|BINGO|COLLAB/i.test(text)
  );
}

function getShopRecordAvailabilityIntervalTags(record) {
  return normalizeShopTags([
    record && record.m_DateStrID,
    record && record.m_DateStrId,
    record && record.m_EventDateStrID,
  ]);
}

function getShopRecordIntervalTags(record) {
  return normalizeShopTags([
    record && record.m_DateStrID,
    record && record.m_DateStrId,
    record && record.m_EventDateStrID,
    record && record.m_DiscountDateStrID,
  ]);
}

function getShopRecordOpenTags(record) {
  return normalizeShopTags([record && record.m_OpenTag, record && record.OpenTag, record && record.openTag]);
}

function getShopRecordContentsTags(record) {
  return normalizeContentsVersionTags([
    ...(Array.isArray(record && record.listContentsTagAllow) ? record.listContentsTagAllow : []),
    record && record.contentsTagAllow,
    record && record.m_ContentsTag,
  ]);
}

function getShopRecordContentsIgnoreTags(record) {
  return normalizeContentsVersionTags([
    ...(Array.isArray(record && record.listContentsTagIgnore) ? record.listContentsTagIgnore : []),
    record && record.contentsTagIgnore,
  ]);
}

function normalizeContentsVersionTags(values) {
  const tags = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    if (Array.isArray(value)) {
      tags.push(...normalizeContentsVersionTags(value));
      continue;
    }
    const tag = String(value || "").trim().toUpperCase();
    if (tag) tags.push(tag);
  }
  return Array.from(new Set(tags));
}

function normalizeShopTags(values) {
  const tags = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    if (Array.isArray(value)) {
      tags.push(...normalizeShopTags(value));
      continue;
    }
    const tag = String(value || "").trim().toUpperCase();
    if (isUsableShopTag(tag)) tags.push(tag);
  }
  return Array.from(new Set(tags));
}

function addUsableShopTag(set, value) {
  const tag = String(value || "").trim().toUpperCase();
  if (isUsableShopTag(tag)) set.add(tag);
}

function isUsableShopTag(tag) {
  const text = String(tag || "").trim().toUpperCase();
  if (!text || text === "0" || text === "NONE") return false;
  if (text.includes("NOT_USED") || text.includes("NO_USE") || text.includes("DUMMY")) return false;
  if (["GLOBAL", "KOR", "JPN", "CHN", "SEA", "TW", "TWN", "KR"].includes(text)) return false;
  if (text.startsWith("LANGUAGE_") || text.startsWith("VOICE_")) return false;
  return true;
}

function hasUsableTagIntersection(activeSet, tags) {
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (activeSet && activeSet.has(tag)) return true;
  }
  return false;
}

function shopRecordTabKey(record) {
  if (!record) return "";
  const tabId = String(record.m_TabID || record.ShopTabID || "").trim().toUpperCase();
  const subIndex = Number(record.m_TabSubIndex || record.ShopTabSubIndex || 0) || 0;
  return tabId ? `${tabId}:${subIndex}` : "";
}

function processProductPurchase(ctx, productId, productCount, options = {}) {
  const record = findProductRecord(productId, ctx);
  const user = getSessionUser(ctx);
  const source = options.source || "shop-buy";
  const requestedCount = Number(productCount);
  const count = Number.isInteger(requestedCount) && requestedCount > 0 ? requestedCount : 1;
  const request = options.request || {};
  if (request.valid === false || (source === "shop-buy" && (!Number.isInteger(requestedCount) || requestedCount <= 0))) {
    return productPurchaseFailure(user, productId, ERROR_CODES.INVALID_REQUEST);
  }
  const shouldDedupe = options.dedupe !== false && (source === "steam" || source === "cash" || source === "gamebase");
  const purchaseKey = shouldDedupe ? getPurchaseKey(source, productId, request) : "";
  if (shouldDedupe && hasCompletedPurchase(ctx.socket, purchaseKey)) {
    return {
      errorCode: ERROR_CODES.OK,
      reward: createEmptyReward(),
      costItem: null,
      history: getPurchaseHistory(user, productId),
      totalPaidAmount: getShopTotalPaidAmount(user),
    };
  }
  if (!record) {
    console.log(`[shop] invalid product purchase source=${source} productId=${Number(productId) || 0}`);
    return productPurchaseFailure(user, productId, ERROR_CODES.INVALID_SHOP_ID);
  }
  if (options.requireRealMoneyProduct && !isRealMoneyProduct(record)) {
    return productPurchaseFailure(user, productId, ERROR_CODES.INVALID_SHOP_ID);
  }
  if (source === "shop-buy" && isRealMoneyProduct(record)) {
    return productPurchaseFailure(user, productId, ERROR_CODES.INVALID_SHOP_ID);
  }
  if ((source === "shop-buy" || options.requireActiveProduct) && !getFixedShopProductIds(ctx).includes(Number(productId))) {
    return productPurchaseFailure(user, productId, ERROR_CODES.NOT_EVENT_TIME);
  }
  if (isConsumerPackageRecord(record) && getConsumerPackage(user, productId)) {
    return productPurchaseFailure(user, productId, ERROR_CODES.CONSUMER_PACKAGE_ALREADY_PURCHASED);
  }

  const selection = validateShopProductSelection(ctx, record, request.selectIndices);
  if (!selection.valid) {
    return productPurchaseFailure(user, productId, ERROR_CODES.INVALID_CUSTOM_PACKAGE_SELECTION);
  }

  const purchasePolicy = getShopPurchasePolicy(ctx, record);
  const purchasedCount = getCurrentShopPurchaseCount(ctx, user, record, purchasePolicy);
  if (purchasePolicy.limit > 0 && purchasedCount + count > purchasePolicy.limit) {
    return productPurchaseFailure(user, productId, ERROR_CODES.LIMITED_SHOP_COUNT);
  }
  const priceItemId = Number(record && record.m_PriceItemID) || 0;
  const totalPrice = getShopProductTotalPrice(record, count, purchasedCount);
  if (record && priceItemId > 0 && totalPrice > 0n && !hasEnoughMiscItem(user, priceItemId, totalPrice)) {
    return productPurchaseFailure(
      user,
      productId,
      isCommonResourceItemId(priceItemId) ? ERROR_CODES.INSUFFICIENT_CASH : ERROR_CODES.INSUFFICIENT_RESOURCE
    );
  }
  if (options.preflightOnly) {
    return {
      errorCode: ERROR_CODES.OK,
      reward: createEmptyReward(),
      costItem: null,
      history: getPurchaseHistory(user, productId),
      totalPaidAmount: getShopTotalPaidAmount(user),
    };
  }
  const reward = grantShopProduct(ctx, user, record, count, {
    selectedCustomPackageRewards: selection.rewards,
    recordPurchase: purchasePolicy.tracksHistory,
    resetType: purchasePolicy.resetType,
    nextResetDate: purchasePolicy.nextResetDate,
  });
  const costItem = spendShopPrice(ctx, user, record, count, { totalPrice });
  trackShopPurchaseMission(ctx, user, record, productId, count, costItem, totalPrice);
  const history = getPurchaseHistory(user, productId);
  if (shouldDedupe) markCompletedPurchase(ctx.socket, purchaseKey);
  const lifecycle = applyShopPurchaseLifecycle(ctx, user, record);
  if ((lifecycle.notices.length || lifecycle.subscriptionData) && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
    ctx.invalidateJoinLobbyAckPayloadCache("shop-purchase-lifecycle");
  }
  persistUserDb(ctx);
  return {
    errorCode: ERROR_CODES.OK,
    reward,
    costItem,
    history,
    totalPaidAmount: getShopTotalPaidAmount(user),
    subscriptionData: lifecycle.subscriptionData,
    notices: lifecycle.notices,
  };
}

function applyShopPurchaseLifecycle(ctx, user, record) {
  const notices = [];
  let subscriptionData = null;
  if (!user || !record) return { notices, subscriptionData };

  if (isRealMoneyProduct(record) && user.firstCashPurchaseCompleted !== true) {
    const alreadyPaid = getShopTotalPaidAmount(user) > 0;
    user.firstCashPurchaseCompleted = true;
    if (!alreadyPaid) notices.push({ packetId: PACKETS.FIRST_CASH_PURCHASE_NOT, payload: Buffer.alloc(0), label: "first-cash-purchase" });
  }

  if (isConsumerPackageRecord(record)) {
    const rows = getConsumerPackageRows(Number(record.m_PurchaseEventValue || record.m_ProductID));
    const packages = ensureConsumerPackages(user);
    const productId = Number(record.m_ProductID);
    const data = {
      productId,
      rewardedLevel: 0,
      spendCount: "0",
      requireItemId: Number(rows[0] && rows[0].ConsumeRequireItemID || 0),
      pendingUpdate: false,
    };
    packages[String(productId)] = data;
    notices.push({
      packetId: PACKETS.CONSUMER_PACKAGE_UPDATED_NOT,
      payload: buildConsumerPackageUpdatedNot([data]),
      label: "consumer-package-created",
    });
  }

  if (isSubscriptionRecord(record)) {
    const subscriptions = ensureShopSubscriptions(user);
    const productId = Number(record.m_ProductID);
    const existing = subscriptions[String(productId)];
    const now = currentRawTicks(ctx);
    const existingEnd = existing ? toStoredDateTimeTicks(existing.endDate) : 0n;
    const isActiveRenewal = Boolean(existing && existingEnd > now);
    const endBase = isActiveRenewal ? existingEnd : now;
    subscriptionData = {
      productId,
      rewardCount: isActiveRenewal ? Math.max(0, Number(existing.rewardCount || 0) | 0) : 0,
      lastUpdateDate: String(isActiveRenewal ? toStoredDateTimeTicks(existing.lastUpdateDate, now) : now),
      startDate: String(isActiveRenewal ? toStoredDateTimeTicks(existing.startDate, now) : now),
      endDate: String(endBase + BigInt(subscriptionDays(record)) * TICKS_PER_DAY),
    };
    subscriptions[String(productId)] = subscriptionData;
  }

  return { notices, subscriptionData };
}

function refreshShopLifecycle(ctx, socket, user, label = "shop-lifecycle") {
  if (!user || typeof user !== "object") return { changed: false, notices: 0, posts: 0 };
  const notices = [];
  let postCount = 0;
  let changed = false;
  const activeProducts = new Set(getFixedShopProductIds(ctx));
  const packages = ensureConsumerPackages(user);
  const removedProductIds = [];

  for (const [key, data] of Object.entries(packages)) {
    const productId = Number(data.productId || key);
    const rows = getConsumerPackageRows(productId);
    if (!activeProducts.has(productId)) {
      delete packages[key];
      removedProductIds.push(productId);
      changed = true;
      continue;
    }
    if (!data.pendingUpdate) continue;
    const spendCount = toBigInt(data.spendCount || 0, 0n);
    const nextRewardedLevel = rows.filter((row) => toBigInt(row.ConsumeRequireItemValue || 0, 0n) <= spendCount).length;
    for (let level = Math.max(0, Number(data.rewardedLevel || 0)); level < nextRewardedLevel; level += 1) {
      const row = rows[level];
      const rewards = consumerPackageRewardSpecs(row);
      if (rewards.length) {
        postCount += createAdminRewardPosts(
          user,
          rewards,
          String(row.m_MailTitle || "Consumer Package Reward"),
          String(row.m_MailDesc || "Consumer package progress reward.")
        ).length;
      }
    }
    data.rewardedLevel = nextRewardedLevel;
    data.pendingUpdate = false;
    notices.push({
      packetId: PACKETS.CONSUMER_PACKAGE_UPDATED_NOT,
      payload: buildConsumerPackageUpdatedNot([data]),
      label: `${label}-consumer`,
    });
    changed = true;
  }

  if (removedProductIds.length) {
    notices.push({
      packetId: PACKETS.CONSUMER_PACKAGE_REMOVED_NOT,
      payload: writeIntList(ctx, removedProductIds),
      label: `${label}-consumer-removed`,
    });
  }

  const now = currentRawTicks(ctx);
  for (const data of Object.values(ensureShopSubscriptions(user))) {
    const productId = Number(data && data.productId || 0);
    const record = findProductRecord(productId, ctx);
    if (!productId || !record || !isSubscriptionRecord(record)) continue;
    const lastUpdate = toStoredDateTimeTicks(data.lastUpdateDate, now);
    const endDate = toStoredDateTimeTicks(data.endDate, now);
    if (lastUpdate >= now || endDate <= lastUpdate) continue;
    const due = Math.min(
      Math.max(0, Number((now - lastUpdate) / TICKS_PER_DAY)),
      Math.max(0, subscriptionEntitlementDays(data, record) - Math.max(0, Number(data.rewardCount || 0)))
    );
    if (due <= 0) continue;
    const rewardItemId = Number(record.m_PurchaseEventID || 0);
    const rewardCount = Math.max(0, Number(record.m_PurchaseEventValue || 0)) * due;
    if (rewardItemId > 0 && rewardCount > 0) {
      postCount += createAdminRewardPosts(
        user,
        [{ rewardType: "RT_MISC", id: rewardItemId, count: rewardCount }],
        String(record.m_MailTitle || "Subscription Reward"),
        String(record.m_MailDesc || "Daily subscription reward.")
      ).length;
    }
    data.rewardCount = Math.max(0, Number(data.rewardCount || 0)) + due;
    data.lastUpdateDate = String(lastUpdate + BigInt(due) * TICKS_PER_DAY);
    notices.push({
      packetId: PACKETS.SHOP_SUBSCRIPTION_NOT,
      payload: buildShopSubscriptionNot(data),
      label: `${label}-subscription`,
    });
    changed = true;
  }

  if (postCount > 0) {
    notices.push({ packetId: PACKETS.POST_ARRIVE_NOT, payload: writeSignedVarInt(postCount), label: `${label}-post` });
  }
  sendShopNotices(ctx, socket, notices);
  if (changed) {
    if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
    persistUserDb(ctx);
  }
  return { changed, notices: notices.length, posts: postCount };
}

function isConsumerPackageRecord(record) {
  return String(record && record.m_PurchaseEventType || "").toUpperCase() === "CONSUMER_PACKAGE";
}

function isSubscriptionRecord(record) {
  return /^SUBSCRIBE_\d+_DAYS$/.test(String(record && record.m_PurchaseEventType || "").toUpperCase());
}

function subscriptionDays(record) {
  const match = String(record && record.m_PurchaseEventType || "").toUpperCase().match(/^SUBSCRIBE_(\d+)_DAYS$/);
  return match ? Math.max(1, Number(match[1]) || 1) : 1;
}

function subscriptionEntitlementDays(data, record) {
  const startDate = toStoredDateTimeTicks(data && data.startDate);
  const endDate = toStoredDateTimeTicks(data && data.endDate);
  if (startDate <= 0n || endDate <= startDate) return subscriptionDays(record);
  return Math.max(0, Number((endDate - startDate) / TICKS_PER_DAY));
}

function getConsumerPackageRows(packageId) {
  if (!cachedConsumerPackageRows) {
    cachedConsumerPackageRows = new Map();
    for (const row of readGameplayTableRecords("ab_script", "LUA_ACQ_PACKAGE_TEMPLET.json")) {
      const id = Number(row && row.m_PackageID || 0);
      if (!id) continue;
      if (!cachedConsumerPackageRows.has(id)) cachedConsumerPackageRows.set(id, []);
      cachedConsumerPackageRows.get(id).push(row);
    }
    for (const rows of cachedConsumerPackageRows.values()) {
      rows.sort((left, right) => Number(left.ConsumeRequireItemValue || 0) - Number(right.ConsumeRequireItemValue || 0));
    }
  }
  return cachedConsumerPackageRows.get(Number(packageId)) || [];
}

function ensureConsumerPackages(user) {
  if (!user || typeof user !== "object") return {};
  const source = user.consumerPackages;
  const values = Array.isArray(source) ? source : source && typeof source === "object" ? Object.values(source) : [];
  const normalized = {};
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const productId = Number(value.productId || value.productID || 0);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    const rows = getConsumerPackageRows(productId);
    normalized[String(productId)] = {
      productId,
      rewardedLevel: Math.max(0, Number(value.rewardedLevel || 0) | 0),
      spendCount: String(toBigInt(value.spendCount || 0, 0n)),
      requireItemId: Number(value.requireItemId || rows[0] && rows[0].ConsumeRequireItemID || 0),
      pendingUpdate: value.pendingUpdate === true,
    };
  }
  user.consumerPackages = normalized;
  return normalized;
}

function getConsumerPackage(user, productId) {
  return ensureConsumerPackages(user)[String(Number(productId) || 0)] || null;
}

function getConsumerPackageList(user) {
  return Object.values(ensureConsumerPackages(user)).sort((left, right) => left.productId - right.productId);
}

function consumerPackageRewardSpecs(row) {
  const rewards = [];
  for (let index = 1; index <= 3; index += 1) {
    const rewardType = String(row && row[`m_RewardType_${index}`] || "RT_NONE");
    const id = Number(row && row[`m_RewardID_${index}`] || 0);
    const count = Number(row && (row[`m_RewardValue_${index}`] || row[`m_FreeValue_${index}`] || 0)) +
      Number(row && row[`m_PaidValue_${index}`] || 0);
    if (rewardType !== "RT_NONE" && id > 0 && count > 0) rewards.push({ rewardType, id, count });
  }
  return rewards;
}

function ensureShopSubscriptions(user) {
  if (!user || typeof user !== "object") return {};
  const source = user.shopSubscriptions;
  const values = Array.isArray(source) ? source : source && typeof source === "object" ? Object.values(source) : [];
  const normalized = {};
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const productId = Number(value.productId || value.productID || 0);
    if (!Number.isInteger(productId) || productId <= 0) continue;
    normalized[String(productId)] = {
      productId,
      rewardCount: Math.max(0, Number(value.rewardCount || 0) | 0),
      lastUpdateDate: String(toStoredDateTimeTicks(value.lastUpdateDate)),
      startDate: String(toStoredDateTimeTicks(value.startDate)),
      endDate: String(toStoredDateTimeTicks(value.endDate)),
    };
  }
  user.shopSubscriptions = normalized;
  return normalized;
}

function toStoredDateTimeTicks(value, fallback = 0n) {
  try {
    if (value != null && value !== "" && /^\d+$/.test(String(value))) return toRawTicks(value);
  } catch (_) {}
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? DOTNET_TICKS_AT_UNIX_EPOCH + BigInt(Math.trunc(parsed)) * TICKS_PER_MS : toRawTicks(fallback);
}

function buildConsumerPackageData(data) {
  return Buffer.concat([
    writeSignedVarInt(Number(data && data.productId || 0)),
    writeSignedVarInt(Number(data && data.rewardedLevel || 0)),
    writeSignedVarLong(toBigInt(data && data.spendCount || 0, 0n)),
  ]);
}

function buildConsumerPackageUpdatedNot(values) {
  return writeObjectList((values || []).map((value) => writeNullableObject(buildConsumerPackageData(value))));
}

function buildShopSubscriptionData(data) {
  return Buffer.concat([
    writeSignedVarInt(Number(data && data.productId || 0)),
    writeSignedVarInt(Number(data && data.rewardCount || 0)),
    writeInt64LE(toStoredDateTimeTicks(data && data.lastUpdateDate)),
    writeInt64LE(toStoredDateTimeTicks(data && data.startDate)),
    writeInt64LE(toStoredDateTimeTicks(data && data.endDate)),
  ]);
}

function buildShopSubscriptionEntries(user) {
  return Object.values(ensureShopSubscriptions(user))
    .sort((left, right) => left.productId - right.productId)
    .map((data) => [data.productId, buildShopSubscriptionData(data)]);
}

function buildShopSubscriptionNot(data) {
  return Buffer.concat([
    writeSignedVarInt(Number(data && data.productId || 0)),
    writeInt64LE(toStoredDateTimeTicks(data && data.lastUpdateDate)),
  ]);
}

function sendShopNotices(ctx, socket, notices) {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return;
  for (const notice of Array.isArray(notices) ? notices : []) {
    ctx.sendServerGamePacket(socket, notice.packetId, notice.payload || Buffer.alloc(0), notice.label || "shop-not");
  }
}

function productPurchaseFailure(user, productId, errorCode) {
  return {
    errorCode,
    reward: createEmptyReward(),
    costItem: null,
    history: getPurchaseHistory(user, productId),
    totalPaidAmount: getShopTotalPaidAmount(user),
  };
}

function validateShopProductSelection(ctx, record, selectIndices) {
  const selections = Array.isArray(selectIndices) ? selectIndices : [];
  const miscTemplet = String(record && record.m_ItemType || "") === "RT_MISC"
    ? getMiscItemTemplet(Number(record.m_ItemID || 0))
    : null;
  if (!miscTemplet || String(miscTemplet.m_ItemMiscType || "") !== "IMT_CUSTOM_PACKAGE") {
    return { valid: selections.length === 0, rewards: null };
  }
  const catalog = loadShopCatalog();
  const activeTags = buildShopTagStateForCatalog(resolveEventShopActiveState(ctx), catalog);
  const rewards = resolveCustomPackageRewardSelection(miscTemplet, selections, {
    countryTag: process.env.CS_COUNTRY_TAG || "KOR",
    isRecordEnabled(record) {
      const gated = [
        ...getShopRecordAvailabilityIntervalTags(record),
        ...getShopRecordOpenTags(record),
        ...getShopRecordContentsTags(record),
        ...getShopRecordContentsIgnoreTags(record),
      ].some(isUsableShopTag);
      return !gated || isShopRecordActiveByState(record, activeTags);
    },
  });
  return { valid: Array.isArray(rewards), rewards };
}

function getShopPurchasePolicy(ctx, record) {
  const resetType = String(record && (record.resetType || record.m_QuantityLimitCond) || "").trim().toUpperCase();
  const purchaseEventType = String(record && record.m_PurchaseEventType || "").trim().toUpperCase();
  const tab = loadShopCatalog().tabRecords.find((candidate) => (
    String(candidate.m_TabID || "") === String(record && record.m_TabID || "") &&
    Number(candidate.m_TabSubIndex || 0) === Number(record && record.m_TabSubIndex || 0)
  ));
  const tabResetDays = parseResetDays(tab && tab.m_ResetDays);
  const chainReset = tabResetDays.length > 0 && (Number(record && record.m_ChainIndex || 0) < 3 || Number(record && record.m_QuantityLimit || 0) > 0);
  const tracksHistory = (resetType && resetType !== "UNLIMITED") || (purchaseEventType && purchaseEventType !== "NONE") || chainReset;
  return {
    tracksHistory,
    limit: tracksHistory ? Math.max(0, Number(record && record.m_QuantityLimit || 0) | 0) : 0,
    resetType: chainReset && (!resetType || resetType === "UNLIMITED") ? "MONTH" : resetType,
    nextResetDate: chainReset ? String(nextShopTabResetTicks(currentRawTicks(ctx), tabResetDays)) : undefined,
  };
}

function getCurrentShopPurchaseCount(ctx, user, record, policy) {
  const history = getPurchaseHistory(user, Number(record && record.m_ProductID || 0));
  if (!history) return 0;
  const resetType = String(policy && policy.resetType || "").toUpperCase();
  const resets = resetType === "DAY" || resetType === "MONTH" || resetType.startsWith("WEEK");
  if (resets && toRawTicks(history.nextResetDate) > 0n && toRawTicks(history.nextResetDate) <= currentRawTicks(ctx)) return 0;
  return Math.max(0, Number(history.purchaseCount || 0) | 0);
}

function pickBestProductRecord(records, activeTags) {
  let best = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record) continue;
    if (!best || productRecordScoreForState(record, activeTags) > productRecordScoreForState(best, activeTags)) best = record;
  }
  return best;
}

function productRecordScoreForState(record, activeTags) {
  let score = productRecordScore(record);
  if (isShopRecordActiveByState(record, activeTags)) score += 1000;
  if (isEventLimitedShopRecord(record)) score += 100;
  const tabId = String(record && record.m_TabID || "").toUpperCase();
  if (tabId === "TAB_EVENT" || tabId === "TAB_EVENT_V2") score += 50;
  return score;
}

function getShopProductTotalPrice(record, productCount = 1, purchasedCount = 0) {
  if (!record || isRealMoneyProduct(record)) return 0n;
  const unitPrice = toBigInt(record.m_Price || 0, 0n);
  const count = Math.max(1, Number(productCount) || 1);
  if (String(record.m_PurchaseEventType || "").toUpperCase() === "INCREACE_PRICE_PER_PURCHASE_COUNT") {
    const before = Math.max(0, Number(purchasedCount) || 0);
    const after = before + count;
    return unitPrice * BigInt((after * (after + 1) - before * (before + 1)) / 2);
  }
  return unitPrice * BigInt(count);
}

function trackShopPurchaseMission(ctx, user, record, productId, productCount = 1, costItem = null, totalPrice = null) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const count = Math.max(1, Number(productCount) || 1);
  const nowValue = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(nowValue);
  const track = (condition, amount, details) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, details);
    addMissionTrackingCondition(tracking, condition, tracked);
  };
  const details = { now: nowValue, shopId: Number(productId || (record && record.m_ProductID) || 0), value: Number(productId || 0) };
  track("SHOP_BUY", count, details);
  track("SHOP_BOUGHT", count, details);
  if (costItem && record) {
    const itemId = Number(record.m_PriceItemID || 0);
    const amount = Number(totalPrice == null ? toBigInt(record.m_Price || 0, 0n) * BigInt(count) : totalPrice);
    if (itemId > 0 && amount > 0) {
      track("USE_RESOURCE", amount, {
        now: nowValue,
        itemId,
        resourceId: itemId,
        value: itemId,
      });
    }
  }
  queueMissionTracking(ctx, tracking);
}

function grantFallbackReward(ctx, multiplier = 1) {
  const reward = grantFallbackResource(ctx, getSessionUser(ctx), multiplier);
  persistUserDb(ctx);
  return reward;
}

function getSessionUser(ctx) {
  return ctx && ctx.socket && ctx.socket.session ? ctx.socket.session.user : null;
}

function persistUserDb(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function buildRewardData(ctx, reward) {
  const data = reward || createEmptyReward();
  const miscItems = Array.isArray(data.miscItems) ? data.miscItems : [];
  const skinIds = Array.isArray(data.skinIds) ? data.skinIds : [];
  const emoticonIds = Array.isArray(data.emoticonIds) ? data.emoticonIds : [];
  const units = Array.isArray(data.units) ? data.units : [];
  const operators = Array.isArray(data.operators) ? data.operators : [];
  const equips = Array.isArray(data.equips) ? data.equips : [];
  const moldItems = Array.isArray(data.moldItems) ? data.moldItems : [];
  const interiors = Array.isArray(data.interiors) ? data.interiors : [];

  return Buffer.concat([
    ctx.writeSignedVarInt(0), // userExp
    ctx.writeSignedVarInt(0), // bonusRatioOfUserExp
    writeObjectList(units.map((unit) => writeNullableObject(buildUnitData(unit)))),
    writeObjectList(miscItems.map((item) => writeNullableObject(buildItemMiscData(ctx, item)))),
    writeObjectList(equips.map((equip) => writeNullableObject(buildEquipItemData(equip)))),
    writeObjectList([]), // unitExpDataList
    writeIntList(ctx, skinIds),
    writeObjectList(moldItems.map((mold) => writeNullableObject(buildMoldItemData(mold)))), // moldItemDataList
    writeObjectList([]), // companyBuffDataList
    writeObjectList([]), // companyBuffDataList duplicate
    writeIntList(ctx, emoticonIds),
    ctx.writeSignedVarInt(0), // dailyMissionPoint
    ctx.writeSignedVarInt(0), // weeklyMissionPoint
    writeObjectList([]), // bingoTileList
    ctx.writeSignedVarLong(0n), // achievePoint
    writeObjectList(operators.map((operator) => writeNullableObject(buildOperatorData(operator)))),
    writeObjectList([]), // contractList
    writeObjectList(interiors.map((interior) => writeNullableObject(buildInteriorData(ctx, interior)))),
  ]);
}

function buildInteriorData(ctx, interior) {
  const data = interior || {};
  return Buffer.concat([
    ctx.writeSignedVarInt(Number(data.itemId || data.interiorId || 0) || 0),
    ctx.writeSignedVarLong(toBigInt(data.count || data.itemCount || 0)),
  ]);
}

function buildItemMiscData(ctx, item) {
  return Buffer.concat([
    ctx.writeSignedVarInt(Number(item.itemId) || 0),
    ctx.writeSignedVarLong(toBigInt(item.countFree || 0)),
    ctx.writeSignedVarLong(toBigInt(item.countPaid || 0)),
    ctx.writeSignedVarInt(Number(item.bonusRatio || 0)),
    ctx.writeInt64LE(toBigInt(item.regDate || 0)),
  ]);
}

function buildPurchaseHistory(ctx, productId, productCount, history = null) {
  const resolved = history || getPurchaseHistory(getSessionUser(ctx), productId) || {
    shopId: Number(productId) || 0,
    purchaseCount: 0,
    purchaseTotalCount: 0,
    nextResetDate: "0",
  };
  return Buffer.concat([
    ctx.writeSignedVarInt(Number(resolved.shopId || productId) || 0),
    ctx.writeSignedVarInt(Number(resolved.purchaseCount) || 0),
    ctx.writeSignedVarInt(Number(resolved.purchaseTotalCount) || 0),
    ctx.writeSignedVarLong(toBigInt(resolved.nextResetDate || 0, 0n)),
  ]);
}

function getPurchaseHistory(user, productId) {
  const id = Number(productId) || 0;
  if (!id) return null;
  return (getShopPurchaseHistories(user) || []).find((history) => Number(history.shopId) === id) || null;
}

function isCommonResourceItemId(itemId) {
  const id = Number(itemId) || 0;
  return COMMON_RESOURCE_ITEM_IDS.map((value) => Number(value)).includes(id);
}

function formatShopRequest(request) {
  if (!request || typeof request !== "object") return "";
  const fields = [];
  for (const key of ["productID", "productId", "productMarketID", "slotIndex", "slotIndexes", "tabType", "subIndex", "paymentId", "couponCode"]) {
    if (request[key] == null) continue;
    const value = Array.isArray(request[key]) ? request[key].join(",") : request[key];
    fields.push(`${key}=${JSON.stringify(value)}`);
  }
  return fields.join(" ");
}

function writeString(value) {
  if (value == null) return writeSignedVarInt(-1);
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([writeSignedVarInt(bytes.length), bytes]);
}

function writeInt64LE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(toBigInt(value));
  return buffer;
}

function writeIntList(ctx, values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list.map((value) => ctx.writeSignedVarInt(Number(value) || 0))]);
}

function writeObjectList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list]);
}

function writeObjectMapInt(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return Buffer.concat([
    writeVarInt(list.length),
    ...list.flatMap(([key, payload]) => [writeSignedVarInt(Number(key) || 0), writeNullableObject(payload)]),
  ]);
}

function writeNullableObject(payload) {
  return Buffer.concat([Buffer.from([1]), payload]);
}

function writeNullableObjectOrNull(payload) {
  return payload ? writeNullableObject(payload) : writeNullObject();
}

function writeNullObject() {
  return Buffer.from([0]);
}

function writeDoubleLE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(Number(value) || 0, 0);
  return buffer;
}

function writeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

function writeSignedVarInt(value) {
  return writeVarInt(zigZagEncode32(value));
}

function writeSignedVarLong(value) {
  let current = zigZagEncode64(toBigInt(value || 0, 0n));
  const bytes = [];
  while (current > 0x7fn) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function writeVarInt(value) {
  let v = Number(value) >>> 0;
  const bytes = [];
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: zigZagDecode32(raw.value), offset: raw.offset };
}

function readVarInt(buffer, offset) {
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

function zigZagEncode32(value) {
  const v = Number(value) | 0;
  return ((v << 1) ^ (v >> 31)) >>> 0;
}

function zigZagDecode32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagEncode64(value) {
  return (value << 1n) ^ (value >> 63n);
}

module.exports = {
  PACKETS,
  createShopHandler,
  loadShopCatalog,
  getFixedShopProductIds,
  getActiveEventShopState,
  filterEventClockShopOpenTags,
  ensureActiveEventShopCurrencies,
  buildShopChainTabNextResetListPayload,
  getShopChainTabNextResetEntries,
  buildSerializedRandomShopData,
  buildConsumerPackageData,
  buildConsumerPackageUpdatedNot,
  buildShopSubscriptionData,
  buildShopSubscriptionEntries,
  buildShopSubscriptionNot,
  getConsumerPackageRows,
  getConsumerPackageList,
  ensureConsumerPackages,
  ensureShopSubscriptions,
  refreshShopLifecycle,
  ensureRandomShopState,
};
