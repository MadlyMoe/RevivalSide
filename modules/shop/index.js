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
const { grantRewardByType, mergeReward } = require("../reward");
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

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MS = 10000n;
const TICKS_PER_HOUR = 60n * 60n * 10000000n;
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
  NOT_ENOUGH_REFRESH_COUNT: 257,
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
});

const SHOP_TEMPLET_FILES = ["LUA_SHOP_TEMPLET_01.json", "LUA_SHOP_TEMPLET_02.json"];
const SHOP_TAB_TEMPLET_FILES = ["LUA_SHOP_TAB_TEMPLET_01.json", "LUA_SHOP_TAB_TEMPLET_02.json"];

let cachedCatalog = null;
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
      completeMissionTracking(ctx, socket, getSessionUser(ctx), null, { label: "shop-mission-update" });
      return true;
    },
  };
}

function buildCashBuyPossibleResponse(ctx, request) {
  const productMarketID = request.productMarketID || "";
  const productId = resolveProductId(findProductIdByMarketId(productMarketID), { fallbackToFirst: false });
  const record = findProductRecord(productId);
  if (isRealMoneyProduct(record)) {
    console.log(`[resource] bypass external payment validation productId=${productId} marketId=${JSON.stringify(productMarketID)}`);
    return {
      packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
      payload: buildShopFixBuyAck(ctx, request, productId, { source: "cash", dedupe: false }),
    };
  }
  return {
    packetId: PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_ACK,
    payload: buildCashBuyPossibleAck(ctx, productMarketID, request.selectIndices || [], productId, record ? ERROR_CODES.OK : ERROR_CODES.INVALID_SHOP_ID),
  };
}

function buildSteamBuyInitResponse(ctx, request) {
  const productId = resolveProductId(request.productId || 0, { fallbackToFirst: false });
  const record = findProductRecord(productId);
  if (isRealMoneyProduct(record)) {
    console.log(`[resource] bypass Steam overlay productId=${productId}`);
    return {
      packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
      payload: buildShopFixBuyAck(ctx, request, productId, { source: "steam", dedupe: false }),
    };
  }
  return {
    packetId: PACKETS.STEAM_BUY_INIT_ACK,
    payload: buildSteamBuyInitAck(ctx, productId),
  };
}

function buildShopResponse(ctx, packetId, request) {
  switch (packetId) {
    case PACKETS.SHOP_FIXED_LIST_REQ:
      return {
        packetId: PACKETS.SHOP_FIXED_LIST_ACK,
        payload: buildShopFixedListAck(ctx),
      };
    default:
      return buildShopResponseInner(ctx, packetId, request);
  }
}

function buildShopResponseInner(ctx, packetId, request) {
  switch (packetId) {
    case PACKETS.SHOP_FIX_SHOP_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
        payload: buildShopFixBuyAck(ctx, request, resolveProductId(request.productID, { fallbackToFirst: false })),
      };
    case PACKETS.SHOP_FIX_SHOP_CASH_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
        payload: buildShopFixBuyAck(ctx, request, resolveProductId(findProductIdByMarketId(request.productMarketID), { fallbackToFirst: false }), {
          source: "cash",
          dedupe: false,
        }),
      };
    case PACKETS.GAMEBASE_BUY_REQ:
      return {
        packetId: PACKETS.GAMEBASE_BUY_ACK,
        payload: buildGamebaseBuyAck(
          ctx,
          request,
          resolveProductId(
            findProductIdByPaymentId(request.paymentId) ||
              findProductIdByPaymentId(request.paymentSeq) ||
              findProductIdByMarketId(request.paymentId),
            { fallbackToFirst: false }
          )
        ),
      };
    case PACKETS.STEAM_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
        payload: buildShopFixBuyAck(ctx, request, resolveProductId(request.productId, { fallbackToFirst: false }), { source: "steam" }),
      };
    case PACKETS.SHOP_RANDOM_SHOP_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_RANDOM_SHOP_BUY_ACK,
        payload: buildRandomShopBuyAck(ctx, request.slotIndex || 0),
      };
    case PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ:
      return {
        packetId: PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_ACK,
        payload: buildRandomShopBuyListAck(ctx, request.slotIndexes || []),
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
        payload: Buffer.concat([ctx.writeSignedVarInt(0), writeObjectList([])]),
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

function buildShopFixedListAck(ctx) {
  const catalog = loadShopCatalog();
  const activeShop = getActiveEventShopState(ctx);
  const productIds = uniquePositiveInts([...(catalog.productIds || []), ...(activeShop.productIds || [])]);
  ensureActiveEventShopCurrencies(getSessionUser(ctx), ctx && ctx.eventManager, { regDate: currentDateTimeBinary(ctx) });
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeIntList(ctx, productIds),
    writeObjectList([]), // InstantProductList
  ]);
}

function buildShopFixBuyAck(ctx, request, productId, options = {}) {
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
      });
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode == null ? ERROR_CODES.OK : result.errorCode),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    ctx.writeSignedVarInt(productId || 0),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, request && request.productCount, result.history)),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null), // costItemData
    writeNullObject(), // subscriptionData
    writeDoubleLE(result.totalPaidAmount || 0),
  ]);
}

function buildGamebaseBuyAck(ctx, request, productId) {
  const result = processProductPurchase(ctx, productId, request && request.productCount, {
    source: "gamebase",
    request,
  });
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode == null ? ERROR_CODES.OK : result.errorCode),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    ctx.writeSignedVarInt(productId || 0),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, request && request.productCount, result.history)),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null), // costItemData
    writeNullObject(), // subscriptionData
    writeDoubleLE(result.totalPaidAmount || 0),
  ]);
}

function buildRandomShopBuyAck(ctx, slotIndex) {
  const result = processRandomShopPurchase(ctx, [slotIndex || 0]);
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    ctx.writeSignedVarInt(slotIndex || 0),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    writeNullableObjectOrNull(result.costItems[0] ? buildItemMiscData(ctx, result.costItems[0]) : null),
  ]);
}

function buildRandomShopBuyListAck(ctx, slotIndexes) {
  const result = processRandomShopPurchase(ctx, slotIndexes || []);
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    writeIntList(ctx, slotIndexes),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    writeObjectList(result.costItems.map((item) => writeNullableObject(buildItemMiscData(ctx, item)))),
  ]);
}

function buildShopRefreshAck(ctx, request = {}) {
  const result = refreshRandomShop(ctx, Boolean(request && request.isUseCash));
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    result.randomShop ? writeNullableObject(buildRandomShopData(result.randomShop)) : writeNullObject(),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null),
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

function buildSteamBuyInitAck(ctx, productId) {
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    ctx.writeSignedVarInt(productId || 0),
    writeString(makeLocalOrderId(productId)),
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
    return { errorCode: ERROR_CODES.OK, randomShop: state, costItem: null };
  }

  rotateRandomShopState(user, state, now);
  persistUserDb(ctx);
  return { errorCode: ERROR_CODES.OK, randomShop: state, costItem };
}

function processRandomShopPurchase(ctx, slotIndexes) {
  const user = getSessionUser(ctx);
  const state = ensureRandomShopState(user, { now: currentRawTicks(ctx) });
  const requested = uniquePositiveInts(slotIndexes);
  const slots = normalizeRandomShopSlots(state.slots);
  if (!requested.length) return randomShopPurchaseResult(ERROR_CODES.INVALID_SHOP_ID);

  const selected = [];
  for (const index of requested) {
    const slot = slots[String(index)];
    if (!slot || slot.isBuy) return randomShopPurchaseResult(ERROR_CODES.INVALID_SHOP_ID);
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
      return randomShopPurchaseResult(priceItemId === RANDOM_SHOP_REFRESH_COST_ITEM_ID ? ERROR_CODES.INSUFFICIENT_CASH : ERROR_CODES.INSUFFICIENT_RESOURCE);
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
      case PACKETS.SHOP_FIX_SHOP_BUY_REQ:
        return {
          productID: reader.int(),
          productCount: reader.int(),
          selectIndices: reader.intList(),
        };
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
        return { slotIndex: reader.int() };
      case PACKETS.SHOP_REFRESH_REQ:
        return { isUseCash: reader.bool() };
      case PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ:
        return {
          productMarketID: reader.string(),
          selectIndices: reader.intList(),
        };
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
        return {
          steamId: reader.string(),
          productId: reader.int(),
          language: reader.string(),
          country: reader.string(),
          itemShopDesc: reader.string(),
        };
      case PACKETS.STEAM_BUY_REQ:
        return {
          steamId: reader.string(),
          orderId: reader.string(),
          productId: reader.int(),
          country: reader.string(),
          currency: reader.string(),
          selectIndices: reader.intList(),
        };
      case PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ:
        return { slotIndexes: reader.intList() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[shop] request decode failed packetId=${packetId}: ${err.message}`);
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
      const end = Math.min(buffer.length, offset + length.value);
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
        if (Number.isInteger(priceItemId) && priceItemId > 0) priceItemIds.add(priceItemId);
        addProductRecord(recordsByProductIdAll, productId, record);
        if (record.m_MarketID != null && String(record.m_MarketID).length > 0) {
          marketToProductId.set(String(record.m_MarketID), productId);
        }
        if (shouldSuppressShopProduct(record)) {
          suppressedProducts += 1;
          continue;
        }
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
      (activeTabs.has(tabKey) && getShopRecordAvailabilityIntervalTags(record).length === 0);
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
  if (ctxOrState && typeof ctxOrState.getActiveEventState === "function") return ctxOrState.getActiveEventState();
  if (ctxOrState && ctxOrState.eventManager && typeof ctxOrState.eventManager.getActiveEventState === "function") {
    return ctxOrState.eventManager.getActiveEventState();
  }
  if (ctxOrState && Array.isArray(ctxOrState.intervalData)) return ctxOrState;
  return null;
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
  return normalizeShopTags([
    ...(Array.isArray(record && record.listContentsTagAllow) ? record.listContentsTagAllow : []),
    record && record.contentsTagAllow,
    record && record.m_ContentsTag,
  ]);
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
  if (["GLOBAL", "KOR", "JPN", "CHN", "SEA", "TW", "KR"].includes(text)) return false;
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
  const count = Math.max(1, Number(productCount) || 1);
  const source = options.source || "shop-buy";
  const shouldDedupe = options.dedupe !== false && (source === "steam" || source === "cash" || source === "gamebase");
  const purchaseKey = shouldDedupe ? getPurchaseKey(source, productId, options.request || {}) : "";
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
    return {
      errorCode: ERROR_CODES.INVALID_SHOP_ID,
      reward: createEmptyReward(),
      costItem: null,
      history: getPurchaseHistory(user, productId),
      totalPaidAmount: getShopTotalPaidAmount(user),
    };
  }
  const priceItemId = Number(record && record.m_PriceItemID) || 0;
  const totalPrice = getShopProductTotalPrice(record, count);
  if (record && priceItemId > 0 && totalPrice > 0n && !hasEnoughMiscItem(user, priceItemId, totalPrice)) {
    return {
      errorCode: isCommonResourceItemId(priceItemId) ? ERROR_CODES.INSUFFICIENT_CASH : ERROR_CODES.INSUFFICIENT_RESOURCE,
      reward: createEmptyReward(),
      costItem: null,
      history: getPurchaseHistory(user, productId),
      totalPaidAmount: getShopTotalPaidAmount(user),
    };
  }
  const reward = grantShopProduct(ctx, user, record, count);
  const costItem = spendShopPrice(ctx, user, record, count);
  trackShopPurchaseMission(ctx, user, record, productId, count, costItem);
  const history = getPurchaseHistory(user, productId);
  if (shouldDedupe) markCompletedPurchase(ctx.socket, purchaseKey);
  persistUserDb(ctx);
  return { errorCode: ERROR_CODES.OK, reward, costItem, history, totalPaidAmount: getShopTotalPaidAmount(user) };
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

function getShopProductTotalPrice(record, productCount = 1) {
  if (!record || isRealMoneyProduct(record)) return 0n;
  const unitPrice = toBigInt(record.m_Price || 0, 0n);
  return unitPrice * BigInt(Math.max(1, Number(productCount) || 1));
}

function trackShopPurchaseMission(ctx, user, record, productId, productCount = 1, costItem = null) {
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
    const amount = Number(toBigInt(record.m_Price || 0, 0n) * BigInt(count));
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
  getActiveEventShopState,
  filterEventClockShopOpenTags,
  ensureActiveEventShopCurrencies,
  buildSerializedRandomShopData,
  ensureRandomShopState,
};
