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
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const cashTag = "TAG_COMMON_SHOP_TAB_CASH_6_0A_KOR";
const activeProductId = 2307;
const handler = createShopHandler(2410, "SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ");
const socket = { session: { user: makeUser() } };
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true, CONTENTS_TAGS: [cashTag] },
  decryptCopy: (payload) => payload,
  socket,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
  dateTimeBinaryNow: () => 639228400000000000n,
  getActiveEventState: () => ({ intervalData: [], openTags: [], contentsTags: [cashTag] }),
  getEffectiveContentsTags: (tags) => Array.from(new Set([...(tags || []), cashTag])),
  saveUserDb() { saves += 1; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    wire.push([packetId, target.response.payload, true]);
  },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
};

const catalog = loadShopCatalog();
const activeIds = new Set(getFixedShopProductIds(ctx));
const activeRecord = catalog.records.find((record) => Number(record.m_ProductID) === activeProductId);
const inactiveCashRecord = catalog.records.find((record) => (
  Number(record.m_PriceItemID) === 0 &&
  !activeIds.has(Number(record.m_ProductID)) &&
  String(record.m_MarketID || "")
));
const currencyRecord = catalog.records.find((record) => (
  Number(record.m_PriceItemID) > 0 && String(record.m_MarketID || "")
));
assert(activeRecord && activeIds.has(activeProductId), "the frozen starter Admin Coin SKU must be active under its content tag");
assert(inactiveCashRecord, "the frozen catalog must expose a gated inactive cash SKU");
assert(currencyRecord, "the frozen catalog must expose a cash-route-invalid currency SKU");

assertFailure(Buffer.alloc(0), 20191, 2411, false);
assertFailure(Buffer.concat([cashRequest(String(activeRecord.m_MarketID), []), Buffer.from([0])]), 20191, 2411, false);
assertFailure(Buffer.concat([writeSignedVarInt(5), Buffer.from("x")]), 20191, 2411, false);
assertFailure(cashRequest("999999999", []), 252, 2411);
assertFailure(cashRequest(String(currencyRecord.m_MarketID), []), 252, 2411);
assertFailure(cashRequest(String(inactiveCashRecord.m_MarketID), []), 260, 2411);
assertFailure(cashRequest(String(activeRecord.m_MarketID), [0]), 20703, 2411);

const purchaser = makeUser();
const beforeSaves = saves;
assert.strictEqual(send(cashRequest(String(activeRecord.m_MarketID), []), purchaser).errorCode, 0);
assert.strictEqual(socket.response.packetId, 2402, "a valid local cash preflight must bypass the unavailable platform store");
assert.strictEqual(saves, beforeSaves + 1, "a successful local cash purchase must persist exactly once");
assert.strictEqual(miscCount(purchaser, 102), 200n, "the exact starter SKU free and paid Admin Coin split must be granted");
assert.strictEqual(purchaser.shopPurchaseHistory[String(activeProductId)].shopId, activeProductId);
assert.strictEqual(purchaser.shopPurchaseHistory[String(activeProductId)].purchaseCount, 1);
assert.strictEqual(purchaser.shopPurchaseHistory[String(activeProductId)].purchaseTotalCount, 1);
assert(BigInt(purchaser.shopPurchaseHistory[String(activeProductId)].nextResetDate) > 639228400000000000n, "a fixed limit must carry a future reset sentinel");

const afterSuccess = JSON.stringify(purchaser);
assert.strictEqual(send(cashRequest(String(activeRecord.m_MarketID), []), purchaser).errorCode, 254);
assert.strictEqual(socket.response.packetId, 2411, "a sold-out retry must fail during preflight, before a second grant");
assert.strictEqual(JSON.stringify(purchaser), afterSuccess, "a sold-out cash retry must not mutate the profile");
assert.strictEqual(saves, beforeSaves + 1, "a sold-out cash retry must not persist");

validateManagedSchemas();
console.log(`[shop-cash-preflight-protocol-check] PASS requests=${wire.filter(([id]) => id === 2410).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser() {
  return {
    userUid: "988000000000241",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  };
}

function cashRequest(marketId, selectIndices) {
  return Buffer.concat([writeString(marketId), writeIntList(selectIndices)]);
}

function send(payload, user = makeUser(), schemaValid = true) {
  socket.session.user = user;
  wire.push([2410, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 2410, sequence: 2410, payload }), true);
  return { errorCode: readSignedVarInt(socket.response.payload, 0).value };
}

function assertFailure(payload, expectedError, expectedPacketId, schemaValid = true) {
  const user = makeUser();
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  assert.strictEqual(send(payload, user, schemaValid).errorCode, expectedError);
  assert.strictEqual(socket.response.packetId, expectedPacketId);
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
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected cash preflight packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
