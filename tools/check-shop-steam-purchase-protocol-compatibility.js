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
const initHandler = createShopHandler(2424, "STEAM_BUY_INIT_REQ");
const finalHandler = createShopHandler(2426, "STEAM_BUY_REQ");
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
const inactiveCashRecord = catalog.records.find((record) => (
  Number(record.m_PriceItemID) === 0 &&
  !activeIds.has(Number(record.m_ProductID)) &&
  String(record.m_MarketID || "")
));
const currencyRecord = catalog.records.find((record) => Number(record.m_PriceItemID) > 0);
assert(activeIds.has(2301) && activeIds.has(2307), "the frozen standard and starter Steam Admin Coin SKUs must be active");
assert(inactiveCashRecord && currencyRecord, "the frozen catalog must expose inactive-cash and currency-route controls");

assertInitFailure(Buffer.alloc(0), 20191, false);
assertInitFailure(Buffer.concat([steamInitRequest(2307), Buffer.from([0])]), 20191, false);
assertInitFailure(steamInitRequest(999999999), 252);
assertInitFailure(steamInitRequest(Number(currencyRecord.m_ProductID)), 252);
assertInitFailure(steamInitRequest(Number(inactiveCashRecord.m_ProductID)), 260);

const initPurchaser = makeUser();
const beforeInitSaves = saves;
assert.strictEqual(send(initHandler, 2424, steamInitRequest(2307), initPurchaser).errorCode, 0);
assert.strictEqual(socket.response.packetId, 2402, "valid local Steam init must bypass the unavailable overlay");
assert.strictEqual(miscCount(initPurchaser, 102), 200n, "Steam init bypass must grant the exact starter Admin Coin SKU");
assert.strictEqual(saves, beforeInitSaves + 1, "Steam init bypass must save exactly once");
const afterInit = JSON.stringify(initPurchaser);
assert.strictEqual(send(initHandler, 2424, steamInitRequest(2307), initPurchaser).errorCode, 254);
assert.strictEqual(socket.response.packetId, 2425, "sold-out Steam init must fail before overlay or grant");
assert.strictEqual(JSON.stringify(initPurchaser), afterInit);
assert.strictEqual(saves, beforeInitSaves + 1);

assertFinalFailure(Buffer.alloc(0), 20191, false);
assertFinalFailure(steamFinalRequest("", 2301, []), 20191);
assertFinalFailure(steamFinalRequest("wrong-route", Number(currencyRecord.m_ProductID), []), 252);
assertFinalFailure(steamFinalRequest("inactive", Number(inactiveCashRecord.m_ProductID), []), 260);
assertFinalFailure(steamFinalRequest("bad-selection", 2301, [0]), 20703);

const finalPurchaser = makeUser();
const beforeFinalSaves = saves;
assert.strictEqual(send(finalHandler, 2426, steamFinalRequest("order-a", 2301, []), finalPurchaser).errorCode, 0);
assert.strictEqual(socket.response.packetId, 2402);
assert.strictEqual(miscCount(finalPurchaser, 102), 100n);
assert.strictEqual(saves, beforeFinalSaves + 1);
const afterFirstOrder = JSON.stringify(finalPurchaser);
assert.strictEqual(send(finalHandler, 2426, steamFinalRequest("order-a", 2301, []), finalPurchaser).errorCode, 0);
assert.strictEqual(JSON.stringify(finalPurchaser), afterFirstOrder, "a replayed Steam order must not grant twice");
assert.strictEqual(saves, beforeFinalSaves + 1, "a replayed Steam order must not save");
assert.strictEqual(send(finalHandler, 2426, steamFinalRequest("order-b", 2301, []), finalPurchaser).errorCode, 0);
assert.strictEqual(miscCount(finalPurchaser, 102), 200n, "a distinct Steam order may buy the same unlimited SKU");
assert.strictEqual(saves, beforeFinalSaves + 2);

validateManagedSchemas();
console.log(`[shop-steam-purchase-protocol-check] PASS init=${wire.filter(([id]) => id === 2424).length} final=${wire.filter(([id]) => id === 2426).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser() {
  return {
    userUid: "988000000000242",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  };
}

function steamInitRequest(productId) {
  return Buffer.concat([
    writeString("local-steam-user"),
    writeSignedVarInt(productId),
    writeString("english"),
    writeString("KR"),
    writeString("RevivalSide local purchase"),
  ]);
}

function steamFinalRequest(orderId, productId, selectIndices) {
  return Buffer.concat([
    writeString("local-steam-user"),
    writeString(orderId),
    writeSignedVarInt(productId),
    writeString("KR"),
    writeString("KRW"),
    writeIntList(selectIndices),
  ]);
}

function send(handler, packetId, payload, user = makeUser(), schemaValid = true) {
  socket.session.user = user;
  wire.push([packetId, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  return { errorCode: readSignedVarInt(socket.response.payload, 0).value };
}

function assertInitFailure(payload, expectedError, schemaValid = true) {
  assertFailure(initHandler, 2424, 2425, payload, expectedError, schemaValid);
}

function assertFinalFailure(payload, expectedError, schemaValid = true) {
  assertFailure(finalHandler, 2426, 2402, payload, expectedError, schemaValid);
}

function assertFailure(handler, packetId, responsePacketId, payload, expectedError, schemaValid) {
  const user = makeUser();
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  assert.strictEqual(send(handler, packetId, payload, user, schemaValid).errorCode, expectedError);
  assert.strictEqual(socket.response.packetId, responsePacketId);
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
      assert(result.ok, `managed client schema rejected Steam shop packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
