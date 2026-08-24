"use strict";

const assert = require("assert");
const path = require("path");
const {
  PACKETS,
  createShopHandler,
  getConsumerPackageRows,
  getFixedShopProductIds,
  refreshShopLifecycle,
} = require("../modules/shop");
const { spendMiscItem } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeInt64LE,
  writeIntList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const now = 639228400000000000n;
let currentNow = now;
const day = 24n * 60n * 60n * 10000000n;
const contentsTags = [
  "TAG_COMMON_SHOP_TAB_PACKAGE_ACTIVITY_CONTRACT",
  "TAG_COMMON_SHOP_TAB_PACKAGE_FIXED_CHARGE_ETERNIUM",
  "TAG_COMMON_SHOP_TAB_PACKAGE_COMEBACK_V3_KOR",
];
const intervalData = [
  { strKey: "SHOP_TAB_PACKAGE_ACTIVITY_CONTRACT_160582" },
  { strKey: "SHOP_CASH_UNLIMITED_BASIC" },
];
const fixedHandler = createShopHandler(2400, "SHOP_FIX_SHOP_BUY_REQ");
const steamHandler = createShopHandler(2426, "STEAM_BUY_REQ");
const socket = { session: { user: null } };
const wire = [];
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true, CONTENTS_TAGS: contentsTags },
  decryptCopy: (payload) => payload,
  socket,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
  dateTimeBinaryNow: () => currentNow,
  getActiveEventState: () => ({ intervalData, openTags: [], contentsTags }),
  getEffectiveContentsTags: (tags) => Array.from(new Set([...(tags || []), ...contentsTags])),
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    wire.push([packetId, target.response.payload, true]);
  },
  sendServerGamePacket(_target, packetId, payload) {
    wire.push([packetId, payload, true]);
  },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
};

const activeIds = new Set(getFixedShopProductIds(ctx));
assert(activeIds.has(160582), "the frozen consumer-package contract must be active");
assert(activeIds.has(160492), "the frozen Eternium subscription must be active");
assert(activeIds.has(170289), "the frozen returning-user cash subscription must be active");
assert(!activeIds.has(160466), "the expired consumer package control must remain inactive");
assert.strictEqual(getConsumerPackageRows(160582).length, 4, "the frozen consumer package must expose all four thresholds");

const cashUser = makeUser();
const cashStart = wire.length;
assert.strictEqual(send(steamHandler, 2426, steamRequest("cash-order-a", 170289), cashUser), 0);
assert.deepStrictEqual(wire.slice(cashStart).map(([packetId]) => packetId), [2426, 2402, PACKETS.FIRST_CASH_PURCHASE_NOT]);
assert.strictEqual(cashUser.firstCashPurchaseCompleted, true);
assert.strictEqual(cashUser.shopSubscriptions["170289"].productId, 170289);
assert.strictEqual(invalidations, 1, "cash subscription purchase must invalidate JOIN once");

const consumerUser = makeUser({ adminCoin: 3000, eternium: 10000 });
const consumerStart = wire.length;
assert.strictEqual(send(fixedHandler, 2400, fixedRequest(160582), consumerUser), 0);
assert.deepStrictEqual(wire.slice(consumerStart).map(([packetId]) => packetId), [2400, 2402, PACKETS.CONSUMER_PACKAGE_UPDATED_NOT]);
assert.deepStrictEqual(consumerUser.consumerPackages["160582"], {
  productId: 160582,
  rewardedLevel: 0,
  spendCount: "0",
  requireItemId: 2,
  pendingUpdate: false,
});
assert.strictEqual(invalidations, 2, "consumer-package purchase must invalidate JOIN once");

spendMiscItem(consumerUser, 2, 10000n);
assert.strictEqual(consumerUser.consumerPackages["160582"].spendCount, "10000");
assert.strictEqual(consumerUser.consumerPackages["160582"].pendingUpdate, true);
const progressStart = wire.length;
const progress = refreshShopLifecycle(ctx, socket, consumerUser, "shop-lifecycle-check");
assert.deepStrictEqual(progress, { changed: true, notices: 2, posts: 1 });
assert.deepStrictEqual(wire.slice(progressStart).map(([packetId]) => packetId), [PACKETS.CONSUMER_PACKAGE_UPDATED_NOT, PACKETS.POST_ARRIVE_NOT]);
assert.strictEqual(consumerUser.consumerPackages["160582"].rewardedLevel, 1);
assert.strictEqual(consumerUser.consumerPackages["160582"].pendingUpdate, false);
assert.strictEqual(consumerUser.admin.posts.length, 1);
assert.deepStrictEqual(consumerUser.admin.posts[0].rewards, [{ rewardType: "RT_MISC", id: 101, count: 450 }]);

const removedUser = makeUser();
removedUser.consumerPackages = {
  "160466": { productId: 160466, rewardedLevel: 0, spendCount: "0", requireItemId: 2, pendingUpdate: false },
};
const removedStart = wire.length;
assert.deepStrictEqual(refreshShopLifecycle(ctx, socket, removedUser, "shop-lifecycle-check"), { changed: true, notices: 1, posts: 0 });
assert.deepStrictEqual(wire.slice(removedStart).map(([packetId]) => packetId), [PACKETS.CONSUMER_PACKAGE_REMOVED_NOT]);
assert.deepStrictEqual(removedUser.consumerPackages, {});

const subscriptionUser = makeUser();
subscriptionUser.shopSubscriptions = {
  "160492": {
    productId: 160492,
    rewardCount: 0,
    lastUpdateDate: String(now - 2n * day),
    startDate: String(now - 2n * day),
    endDate: String(now + 28n * day),
  },
};
const subscriptionStart = wire.length;
assert.deepStrictEqual(refreshShopLifecycle(ctx, socket, subscriptionUser, "shop-lifecycle-check"), { changed: true, notices: 2, posts: 1 });
assert.deepStrictEqual(wire.slice(subscriptionStart).map(([packetId]) => packetId), [PACKETS.SHOP_SUBSCRIPTION_NOT, PACKETS.POST_ARRIVE_NOT]);
assert.strictEqual(subscriptionUser.shopSubscriptions["160492"].rewardCount, 2);
assert.strictEqual(subscriptionUser.shopSubscriptions["160492"].lastUpdateDate, String(now));
assert.deepStrictEqual(subscriptionUser.admin.posts[0].rewards, [{ rewardType: "RT_MISC", id: 2, count: 6000 }]);

const activeRenewalUser = makeUser();
activeRenewalUser.firstCashPurchaseCompleted = true;
activeRenewalUser.shopSubscriptions = {
  "170289": {
    productId: 170289,
    rewardCount: 30,
    lastUpdateDate: String(now),
    startDate: String(now - 29n * day),
    endDate: String(now + day),
  },
};
assert.strictEqual(send(steamHandler, 2426, steamRequest("cash-order-renewed-full", 170289), activeRenewalUser), 0);
assert.deepStrictEqual(activeRenewalUser.shopSubscriptions["170289"], {
  productId: 170289,
  rewardCount: 30,
  lastUpdateDate: String(now),
  startDate: String(now - 29n * day),
  endDate: String(now + 31n * day),
});
currentNow = now + day;
assert.strictEqual(refreshShopLifecycle(ctx, socket, activeRenewalUser, "shop-renewed-full").changed, true);
assert.strictEqual(activeRenewalUser.shopSubscriptions["170289"].rewardCount, 31, "a fully claimed active term must earn day 31 after renewal");

currentNow = now;
const partialRenewalUser = makeUser();
partialRenewalUser.firstCashPurchaseCompleted = true;
partialRenewalUser.shopSubscriptions = {
  "170289": {
    productId: 170289,
    rewardCount: 10,
    lastUpdateDate: String(now),
    startDate: String(now - 10n * day),
    endDate: String(now + 20n * day),
  },
};
assert.strictEqual(send(steamHandler, 2426, steamRequest("cash-order-renewed-partial", 170289), partialRenewalUser), 0);
currentNow = now + 50n * day;
assert.strictEqual(refreshShopLifecycle(ctx, socket, partialRenewalUser, "shop-renewed-partial").changed, true);
assert.strictEqual(partialRenewalUser.shopSubscriptions["170289"].rewardCount, 60, "an early renewal must expose the full 60-day entitlement");

currentNow = now;
const expiredRepurchaseUser = makeUser();
expiredRepurchaseUser.firstCashPurchaseCompleted = true;
expiredRepurchaseUser.shopSubscriptions = {
  "170289": {
    productId: 170289,
    rewardCount: 30,
    lastUpdateDate: String(now),
    startDate: String(now - 30n * day),
    endDate: String(now),
  },
};
assert.strictEqual(send(steamHandler, 2426, steamRequest("cash-order-expired", 170289), expiredRepurchaseUser), 0);
assert.deepStrictEqual(expiredRepurchaseUser.shopSubscriptions["170289"], {
  productId: 170289,
  rewardCount: 0,
  lastUpdateDate: String(now),
  startDate: String(now),
  endDate: String(now + 30n * day),
});
currentNow = now + day;
assert.strictEqual(refreshShopLifecycle(ctx, socket, expiredRepurchaseUser, "shop-expired-repurchase").changed, true);
assert.strictEqual(expiredRepurchaseUser.shopSubscriptions["170289"].rewardCount, 1, "an expired repurchase must not backfill the inactive gap");

const restarted = JSON.parse(JSON.stringify({ cashUser, consumerUser, removedUser, subscriptionUser, activeRenewalUser, partialRenewalUser, expiredRepurchaseUser }));
assert.strictEqual(restarted.cashUser.shopSubscriptions["170289"].productId, 170289);
assert.strictEqual(restarted.consumerUser.consumerPackages["160582"].rewardedLevel, 1);
assert.deepStrictEqual(restarted.removedUser.consumerPackages, {});
assert.strictEqual(restarted.subscriptionUser.shopSubscriptions["160492"].rewardCount, 2);
assert.strictEqual(restarted.activeRenewalUser.shopSubscriptions["170289"].rewardCount, 31);
assert.strictEqual(restarted.partialRenewalUser.shopSubscriptions["170289"].rewardCount, 60);
assert.strictEqual(restarted.expiredRepurchaseUser.shopSubscriptions["170289"].rewardCount, 1);
assert.strictEqual(saves, 11, "five purchases and six lifecycle refreshes must save exactly once each");
assert.strictEqual(invalidations, 11, "five purchases and six lifecycle refreshes must invalidate JOIN exactly once each");

validateManagedSchemas();
console.log(`[shop-lifecycle-notifications-check] PASS thresholds=4 saves=${saves} invalidations=${invalidations} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(options = {}) {
  const adminCoin = Number(options.adminCoin || 0);
  const eternium = Number(options.eternium || 0);
  const misc = {};
  if (adminCoin > 0) misc["102"] = miscItem(102, adminCoin);
  if (eternium > 0) misc["2"] = miscItem(2, eternium);
  return {
    userUid: "988000000000409",
    inventory: { misc, equips: {}, skins: [], emoticons: [] },
  };
}

function miscItem(itemId, count) {
  return { itemId, countFree: String(count), countPaid: "0", bonusRatio: 0, regDate: "0" };
}

function fixedRequest(productId) {
  return Buffer.concat([writeSignedVarInt(productId), writeSignedVarInt(1), writeIntList([])]);
}

function steamRequest(orderId, productId) {
  return Buffer.concat([
    writeString("local-steam-user"),
    writeString(orderId),
    writeSignedVarInt(productId),
    writeString("KR"),
    writeString("KRW"),
    writeIntList([]),
  ]);
}

function send(handler, packetId, payload, user) {
  socket.session.user = user;
  wire.push([packetId, payload, true]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const combatHost = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected shop lifecycle packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
