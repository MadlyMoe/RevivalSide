"use strict";

const assert = require("assert");
const path = require("path");
const { createShopHandler, getFixedShopProductIds, loadShopCatalog } = require("../modules/shop");
const {
  readSignedVarInt,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "988000000000022",
  inventory: { misc: { "101": { itemId: 101, countFree: "7", countPaid: "0" } } },
};
const socket = { session: { user } };
const handler = createShopHandler(2405, "SHOP_FIXED_LIST_REQ");
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  socket,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
  saveUserDb() { saves += 1; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    wire.push([packetId, target.response.payload]);
  },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
};

const expectedIds = getFixedShopProductIds(ctx);
const catalog = loadShopCatalog();
assert(expectedIds.length > 0, "the frozen shop catalog must expose fixed products");
assert.deepStrictEqual(expectedIds, [...new Set(expectedIds)].sort((left, right) => left - right), "fixed products must be unique and sorted");
assert(!expectedIds.includes(3208), "the frozen-client-unregistered product must stay suppressed");
for (const productId of expectedIds) {
  assert(catalog.recordsByProductIdAll.has(productId), `advertised product ${productId} must exist in the frozen shop table`);
}

const beforeRead = JSON.stringify(user);
send(Buffer.alloc(0));
const valid = parseAck(socket.response.payload);
assert.strictEqual(valid.errorCode, 0);
assert.deepStrictEqual(valid.productIds, expectedIds);
assert.strictEqual(valid.instantProductCount, 0, "no local instant-product source exists");
assert.strictEqual(JSON.stringify(user), beforeRead, "fixed-list reads must not seed currency or mutate inventory");
assert.strictEqual(saves, 0, "fixed-list reads must not save");

send(Buffer.from([1]));
const malformed = parseAck(socket.response.payload);
assert.strictEqual(malformed.errorCode, 20191);
assert.deepStrictEqual(malformed.productIds, []);
assert.strictEqual(malformed.instantProductCount, 0);
assert.strictEqual(saves, 0, "malformed fixed-list reads must not save");

validateManagedSchemas();
console.log(`[shop-fixed-list-protocol-check] PASS products=${expectedIds.length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload) {
  wire.push([2405, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 2405, sequence: 2405, payload }), true);
  assert.strictEqual(socket.response.packetId, 2406);
}

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const products = readUnsignedVarInt(payload, error.offset);
  let offset = products.offset;
  const productIds = [];
  for (let index = 0; index < products.value; index += 1) {
    const productId = readSignedVarInt(payload, offset);
    offset = productId.offset;
    productIds.push(productId.value);
  }
  const instantProducts = readUnsignedVarInt(payload, offset);
  assert.strictEqual(instantProducts.value, 0, "test parser only supports the authoritative empty instant-product list");
  assert.strictEqual(instantProducts.offset, payload.length, "fixed-list ACK must not contain trailing bytes");
  return { errorCode: error.value, productIds, instantProductCount: instantProducts.value };
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated list count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
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
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected fixed-shop-list packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
