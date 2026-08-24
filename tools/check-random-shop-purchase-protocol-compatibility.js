"use strict";

const assert = require("assert");
const path = require("path");
const { createShopHandler, ensureRandomShopState } = require("../modules/shop");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
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
const fixedTicks = ticksForDate(new Date("2026-08-20T12:00:00.000Z"));
const user = {
  userUid: "988000000000024",
  randomShop: {
    version: 1,
    generation: 7,
    refreshCount: 5,
    refreshDay: "2026-08-20",
    nextRefreshDate: String(fixedTicks + 36000000000n),
    slots: {
      1: slot(2, 10, 101, 5),
      2: slot(3, 20, 101, 7),
      3: slot(1001, 1, 1, 100),
      4: slot(1003, 1, 1, 5000),
    },
  },
};
ensureRandomShopState(user, { now: fixedTicks, autoRefresh: false });
setMiscItemBalance(user, 101, 100, 0, { regDate: fixedTicks });
setMiscItemBalance(user, 1, 1000, 0, { regDate: fixedTicks });
const socket = { session: { user } };
const handlers = new Map([2403, 2428].map((packetId) => [packetId, createShopHandler(packetId, `RANDOM_SHOP_${packetId}`)]));
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => fixedTicks | 0x4000000000000000n,
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

send(2403, Buffer.alloc(0), false);
assertSingleFailure(20191, 0);
send(2403, Buffer.concat([writeSignedVarInt(1), Buffer.from([0])]), false);
assertSingleFailure(20191, 1);
send(2428, Buffer.alloc(0), false);
assertListFailure(20191, []);
send(2428, Buffer.concat([writeIntList([2]), Buffer.from([0])]), false);
assertListFailure(20191, [2]);
assert.strictEqual(saves, 0, "malformed purchases must not save");

const beforeInvalid = JSON.stringify(user);
send(2403, writeSignedVarInt(99));
assertSingleFailure(252, 99);
assert.strictEqual(JSON.stringify(user), beforeInvalid, "unknown slots must not normalize or mutate shop state");
send(2428, writeIntList([]));
assertListFailure(252, []);
assert.strictEqual(saves, 0);

send(2428, writeIntList([2, 2]));
assertListFailure(20191, [2, 2]);
assert.strictEqual(user.randomShop.slots["2"].isBuy, false);
assert.strictEqual(saves, 0, "duplicate multi-buy indexes must not purchase once silently");

send(2403, writeSignedVarInt(1));
assertSuccess(2404);
assert.strictEqual(user.randomShop.slots["1"].isBuy, true);
assert.strictEqual(getMiscItem(user, 2).countFree, "10");
assert.strictEqual(getMiscItem(user, 101).countFree, "95");
assert.strictEqual(saves, 1);

const beforeDuplicate = JSON.stringify(user);
send(2403, writeSignedVarInt(1));
assertSingleFailure(254, 1);
assert.strictEqual(JSON.stringify(user), beforeDuplicate, "sold slots must return the frozen limited-count error without mutation");
assert.strictEqual(saves, 1);

const beforeInsufficient = JSON.stringify(user);
send(2428, writeIntList([2, 4]));
assertListFailure(110, [2, 4]);
assert.strictEqual(JSON.stringify(user), beforeInsufficient, "multi-buy affordability must be atomic");
assert.strictEqual(getMiscItem(user, 3).countFree, "0");
assert.strictEqual(saves, 1);

send(2428, writeIntList([2, 3]));
assertSuccess(2429);
assert.strictEqual(user.randomShop.slots["2"].isBuy, true);
assert.strictEqual(user.randomShop.slots["3"].isBuy, true);
assert.strictEqual(getMiscItem(user, 3).countFree, "20");
assert.strictEqual(getMiscItem(user, 1001).countFree, "1");
assert.strictEqual(getMiscItem(user, 101).countFree, "88");
assert.strictEqual(getMiscItem(user, 1).countFree, "900");
assert.strictEqual(saves, 2, "single and multi success must each save once");

user.randomShop.nextRefreshDate = String(fixedTicks - 1n);
const beforeExpired = JSON.stringify(user);
send(2403, writeSignedVarInt(4));
assertSingleFailure(256, 4);
assert.strictEqual(JSON.stringify(user), beforeExpired, "an expired client view must not buy a newly rotated same-index item");
assert.strictEqual(saves, 2);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(restarted.randomShop.slots["1"].isBuy, true);
assert.strictEqual(restarted.randomShop.slots["2"].isBuy, true);
assert.strictEqual(restarted.randomShop.slots["3"].isBuy, true);
assert.strictEqual(getMiscItem(restarted, 101).countFree, "88");

validateManagedSchemas();
console.log(`[random-shop-purchase-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function slot(itemId, itemCount, priceItemId, price) {
  return { itemId, itemType: "RT_MISC", itemCount, priceItemId, price, isBuy: false, discountRatio: 0 };
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) wire.push([packetId, payload]);
  const handler = handlers.get(packetId);
  assert(handler, `missing random shop handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertSingleFailure(errorCode, slotIndex) {
  assert.strictEqual(socket.response.packetId, 2404);
  const error = readSignedVarInt(socket.response.payload, 0);
  const slotRead = readSignedVarInt(socket.response.payload, error.offset);
  const rewardPresent = readBool(socket.response.payload, slotRead.offset);
  const costPresent = readBool(socket.response.payload, rewardPresent.offset);
  assert.strictEqual(error.value, errorCode);
  assert.strictEqual(slotRead.value, slotIndex);
  assert.strictEqual(rewardPresent.value, false);
  assert.strictEqual(costPresent.value, false);
  assert.strictEqual(costPresent.offset, socket.response.payload.length);
}

function assertListFailure(errorCode, slotIndexes) {
  assert.strictEqual(socket.response.packetId, 2429);
  const error = readSignedVarInt(socket.response.payload, 0);
  const indexes = readIntList(socket.response.payload, error.offset);
  const rewardPresent = readBool(socket.response.payload, indexes.offset);
  const costs = readUnsignedVarInt(socket.response.payload, rewardPresent.offset);
  assert.strictEqual(error.value, errorCode);
  assert.deepStrictEqual(indexes.value, slotIndexes);
  assert.strictEqual(rewardPresent.value, false);
  assert.strictEqual(costs.value, 0);
  assert.strictEqual(costs.offset, socket.response.payload.length);
}

function assertSuccess(packetId) {
  assert.strictEqual(socket.response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(socket.response.payload, 0).value, 0);
}

function readIntList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const entry = readSignedVarInt(payload, offset);
    offset = entry.offset;
    value.push(entry.value);
  }
  return { value, offset };
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated collection count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("collection count varint too long");
}

function ticksForDate(date) {
  return BigInt(date.getTime()) * 10000n + 621355968000000000n;
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
      assert(result.ok, `managed client schema rejected random-shop purchase packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
