"use strict";

const assert = require("assert");
const path = require("path");
const { createShopHandler, getFixedShopProductIds, loadShopCatalog } = require("../modules/shop");
const {
  readSignedVarInt,
  writeInt64LE,
  writeIntList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const customShopTag = "TAG_COMMON_SHOP_TAB_PACKAGE_CUSTOM_LAUNCHING";
const handler = createShopHandler(2400, "SHOP_FIX_SHOP_BUY_REQ");
const socket = { session: { user: makeUser() } };
const wire = [];
let saves = 0;
const now = 639228400000000000n;
const ctx = {
  config: { USE_LOCAL_USER_DB: true, CONTENTS_TAGS: [customShopTag] },
  decryptCopy: (payload) => payload,
  socket,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
  dateTimeBinaryNow: () => now,
  getActiveEventState: () => ({ intervalData: [], openTags: [], contentsTags: [customShopTag] }),
  getEffectiveContentsTags: (tags) => Array.from(new Set([...(tags || []), customShopTag])),
  saveUserDb() { saves += 1; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    wire.push([packetId, target.response.payload]);
  },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
};

const activeProductIds = new Set(getFixedShopProductIds(ctx));
const catalog = loadShopCatalog();
assert(activeProductIds.has(160209), "the frozen custom Admin Coin package must activate with its content tag");
const realMoneyProduct = catalog.records.find((record) => Number(record.m_PriceItemID) === 0);
assert(realMoneyProduct, "the frozen catalog must expose a real-money product for routing validation");
const inactiveProduct = catalog.records.find((record) => (
  record.m_bEnabled !== false &&
  Number(record.m_PriceItemID) > 0 &&
  !activeProductIds.has(Number(record.m_ProductID))
));
assert(inactiveProduct, "the frozen catalog must expose an inactive product for event-gate validation");

assertFailure(Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(Buffer.concat([buyRequest(160209, 1, [0, 0, 0]), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(buyRequest(160209, 0, [0, 0, 0]), 20191);
assertFailure(buyRequest(999999999, 1, []), 252);
assertFailure(buyRequest(Number(realMoneyProduct.m_ProductID), 1, []), 252);
assertFailure(buyRequest(Number(inactiveProduct.m_ProductID), 1, []), 260);
assertFailure(buyRequest(160209, 1, [0, 0]), 20703);
assertFailure(buyRequest(160209, 1, [99, 0, 0]), 20703);
assertFailure(buyRequest(160209, 2, [0, 0, 0]), 254);
assertFailure(buyRequest(160209, 1, [0, 0, 0]), 96, makeUser(789));

const purchaser = makeUser();
const beforeSaves = saves;
assert.strictEqual(send(buyRequest(160209, 1, [0, 0, 0]), purchaser), 0);
assert.strictEqual(saves, beforeSaves + 1, "only a successful fixed-shop purchase may persist");
assert.strictEqual(miscCount(purchaser, 102), 4210n, "the exact 790 Admin Coin price must be spent");
assert.strictEqual(miscCount(purchaser, 1), 750000n, "the selected first custom reward must be granted");
assert.strictEqual(miscCount(purchaser, 1033), 50n, "the selected second custom reward must be granted");
assert.strictEqual(miscCount(purchaser, 31049), 2n, "the selected third custom reward must be granted");
assert.strictEqual(miscCount(purchaser, 2), 0n, "unselected custom-package choices must not be granted");
assert.deepStrictEqual(purchaser.shopPurchaseHistory["160209"], {
  shopId: 160209,
  purchaseCount: 1,
  purchaseTotalCount: 1,
  nextResetDate: "639238176000000000",
});
assert.strictEqual(purchaser.shopTotalPaidAmount, 790, "Admin Coin spend must update the frozen total-payment field");

const afterSuccess = JSON.stringify(purchaser);
assert.strictEqual(send(buyRequest(160209, 1, [0, 0, 0]), purchaser), 254);
assert.strictEqual(JSON.stringify(purchaser), afterSuccess, "a sold-out retry must not mutate the profile");
assert.strictEqual(saves, beforeSaves + 1, "a sold-out retry must not persist");

validateManagedSchemas();
console.log(`[shop-fixed-purchase-protocol-check] PASS requests=${wire.filter(([id]) => id === 2400).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(adminCoin = 5000) {
  return {
    userUid: "988000000000240",
    inventory: {
      misc: {
        "102": { itemId: 102, countFree: String(adminCoin), countPaid: "0", bonusRatio: 0, regDate: "0" },
      },
      equips: {},
      skins: [],
      emoticons: [],
    },
  };
}

function buyRequest(productId, productCount, selectIndices) {
  return Buffer.concat([
    writeSignedVarInt(productId),
    writeSignedVarInt(productCount),
    writeIntList(selectIndices),
  ]);
}

function send(payload, user = makeUser(), schemaValid = true) {
  socket.session.user = user;
  wire.push([2400, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 2400, sequence: 2400, payload }), true);
  assert.strictEqual(socket.response.packetId, 2402);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  assert.strictEqual(send(payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves, `error ${expectedError} persisted the profile`);
}

function miscCount(user, itemId) {
  const item = user && user.inventory && user.inventory.misc && user.inventory.misc[String(itemId)];
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
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
    for (const [packetId, payload, schemaValid = true] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected fixed-shop purchase packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
