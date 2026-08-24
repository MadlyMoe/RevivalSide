"use strict";

const assert = require("assert");
const path = require("path");
const { createShopHandler, ensureRandomShopState } = require("../modules/shop");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const fixedDate = new Date("2026-08-20T12:00:00.000Z");
const fixedTicks = ticksForDate(fixedDate);
const user = { userUid: "988000000000023" };
ensureRandomShopState(user, { now: fixedTicks });
setMiscItemBalance(user, 101, 200, 0, { regDate: fixedTicks });
const socket = { session: { user } };
const handler = createShopHandler(2407, "SHOP_REFRESH_REQ");
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

const beforeEarly = JSON.stringify(user);
send(Buffer.from([0]));
assertAck(256, false, false);
assert.strictEqual(JSON.stringify(user), beforeEarly, "an early free refresh must not rotate or mutate state");
assert.strictEqual(saves, 0);

send(Buffer.alloc(0), false);
assertAck(20191, false, false);
send(Buffer.from([1, 0]), false);
assertAck(20191, false, false);
assert.strictEqual(saves, 0, "malformed refreshes must not save");

for (let expectedCount = 4; expectedCount >= 0; expectedCount -= 1) {
  const previousGeneration = user.randomShop.generation;
  send(Buffer.from([1]));
  const ack = assertAck(0, true, true);
  assert.strictEqual(ack.randomShop.refreshCount, expectedCount);
  assert.strictEqual(user.randomShop.generation, previousGeneration + 1);
  assert.strictEqual(ack.costItem.itemId, 101);
  assert.strictEqual(ack.costItem.countFree, BigInt(125 + expectedCount * 15));
}
assert.strictEqual(saves, 5, "each paid rotation must save exactly once");
assert.strictEqual(getMiscItem(user, 101).countFree, "125");

const beforeNoCount = JSON.stringify(user);
send(Buffer.from([1]));
assertAck(257, false, false);
assert.strictEqual(JSON.stringify(user), beforeNoCount, "an exhausted paid refresh must not mutate state");
assert.strictEqual(saves, 5);

user.randomShop.refreshCount = 1;
setMiscItemBalance(user, 101, 0);
const beforeNoCash = JSON.stringify(user);
send(Buffer.from([1]));
assertAck(96, false, false);
assert.strictEqual(JSON.stringify(user), beforeNoCash, "an unaffordable paid refresh must not mutate state");
assert.strictEqual(saves, 5);

const previousGeneration = user.randomShop.generation;
user.randomShop.nextRefreshDate = String(fixedTicks - 1n);
send(Buffer.from([0]));
const freeRefresh = assertAck(0, true, false);
assert.strictEqual(user.randomShop.generation, previousGeneration + 1);
assert.strictEqual(freeRefresh.randomShop.refreshCount, 1);
assert.strictEqual(saves, 6, "an elapsed free rotation must save once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(restarted.randomShop.generation, user.randomShop.generation);
assert.strictEqual(restarted.randomShop.refreshCount, 1);
assert.strictEqual(getMiscItem(restarted, 101).countFree, "0");

validateManagedSchemas();
console.log(`[shop-refresh-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, validateRequest = true) {
  if (validateRequest) wire.push([2407, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 2407, sequence: 2407, payload }), true);
  assert.strictEqual(socket.response.packetId, 2408);
}

function assertAck(errorCode, hasRandomShop, hasCostItem) {
  const parsed = parseAck(socket.response.payload);
  assert.strictEqual(parsed.errorCode, errorCode);
  assert.strictEqual(Boolean(parsed.randomShop), hasRandomShop);
  assert.strictEqual(Boolean(parsed.costItem), hasCostItem);
  return parsed;
}

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const randomPresent = readBool(payload, error.offset);
  let offset = randomPresent.offset;
  let randomShop = null;
  if (randomPresent.value) {
    const slots = readUnsignedVarInt(payload, offset);
    offset = slots.offset;
    for (let index = 0; index < slots.value; index += 1) {
      offset = readSignedVarInt(payload, offset).offset;
      const slotPresent = readBool(payload, offset);
      assert.strictEqual(slotPresent.value, true);
      offset = slotPresent.offset;
      for (let field = 0; field < 5; field += 1) offset = readSignedVarInt(payload, offset).offset;
      offset = readBool(payload, offset).offset;
      offset = readSignedVarInt(payload, offset).offset;
    }
    const nextRefreshDate = readSignedVarLong(payload, offset);
    const refreshCount = readSignedVarInt(payload, nextRefreshDate.offset);
    offset = refreshCount.offset;
    randomShop = { slotCount: slots.value, nextRefreshDate: nextRefreshDate.value, refreshCount: refreshCount.value };
  }
  const costPresent = readBool(payload, offset);
  offset = costPresent.offset;
  let costItem = null;
  if (costPresent.value) {
    const itemId = readSignedVarInt(payload, offset);
    const countFree = readSignedVarLong(payload, itemId.offset);
    const countPaid = readSignedVarLong(payload, countFree.offset);
    const bonusRatio = readSignedVarInt(payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    costItem = { itemId: itemId.value, countFree: countFree.value, countPaid: countPaid.value };
  }
  assert.strictEqual(offset, payload.length, "shop refresh ACK must not contain trailing bytes");
  return { errorCode: error.value, randomShop, costItem };
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
      assert(result.ok, `managed client schema rejected shop refresh packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
