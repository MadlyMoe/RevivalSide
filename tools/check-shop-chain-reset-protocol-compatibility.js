"use strict";

const assert = require("assert");
const path = require("path");
const {
  createShopHandler,
  buildShopChainTabNextResetListPayload,
  getShopChainTabNextResetEntries,
} = require("../modules/shop");
const {
  readBool,
  readSignedVarInt,
  readString,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const fixedNow = new Date("2026-08-20T12:00:00.000Z");
const ctx = createContext(fixedNow);
const socket = { session: { user: { userUid: "988000000000021" } } };
const handler = createShopHandler(2412, "SHOP_CHAIN_TAB_RESET_TIME_REQ");
const wire = [];
let saves = 0;
ctx.socket = socket;
ctx.saveUserDb = () => { saves += 1; };
ctx.sendResponse = (target, sequence, packetId, build) => {
  target.response = { packetId, payload: build() };
  wire.push([packetId, target.response.payload]);
};
ctx.buildEncryptedPacket = (_sequence, _packetId, payload) => payload;

const entries = getShopChainTabNextResetEntries(ctx);
assert.deepStrictEqual(entries, [{
  tabType: "TAB_SEASON_GAUNTLET",
  subIndex: 1,
  nextResetUtc: ticksForDate(new Date("2026-09-01T00:00:00.000Z")),
}], "the frozen monthly day-1 chain tab must expose its next UTC reset");
assert.strictEqual(
  getShopChainTabNextResetEntries(createContext(new Date("2026-09-01T00:00:00.000Z")))[0].nextResetUtc,
  ticksForDate(new Date("2026-09-01T00:00:00.000Z")),
  "the exact reset instant must follow the frozen inclusive boundary"
);
assert.strictEqual(
  getShopChainTabNextResetEntries(createContext(new Date("2026-09-01T00:00:00.001Z")))[0].nextResetUtc,
  ticksForDate(new Date("2026-10-01T00:00:00.000Z")),
  "a passed reset instant must advance to the next configured month"
);

send(Buffer.alloc(0));
const valid = parseAck(socket.response.payload);
assert.strictEqual(valid.errorCode, 0);
assert.deepStrictEqual(valid.entries, entries);
assert.deepStrictEqual(
  socket.response.payload.subarray(readSignedVarInt(socket.response.payload, 0).offset),
  buildShopChainTabNextResetListPayload(ctx),
  "the refresh ACK and JOIN_LOBBY list serializer must be identical"
);
assert.strictEqual(saves, 0, "shop reset reads must not save");

send(Buffer.from([1]));
const malformed = parseAck(socket.response.payload);
assert.strictEqual(malformed.errorCode, 20191);
assert.deepStrictEqual(malformed.entries, []);
assert.strictEqual(saves, 0, "malformed shop reset reads must not save");

validateManagedSchemas();
console.log(`[shop-chain-reset-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createContext(now) {
  return {
    config: { USE_LOCAL_USER_DB: true },
    decryptCopy: (payload) => payload,
    dateTimeBinaryNow: () => ticksForDate(now) | 0x4000000000000000n,
    writeInt64LE,
    writeSignedVarInt,
    writeSignedVarLong,
  };
}

function send(payload) {
  wire.push([2412, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 2412, sequence: 2412, payload }), true);
  assert.strictEqual(socket.response.packetId, 2413);
}

function parseAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const list = readUnsignedVarInt(payload, error.offset);
  let offset = list.offset;
  const entries = [];
  for (let index = 0; index < list.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true, "chain reset entries must be present");
    const tabType = readString(payload, present.offset);
    const subIndex = readSignedVarInt(payload, tabType.offset);
    assert(subIndex.offset + 8 <= payload.length, "truncated chain reset UTC time");
    entries.push({
      tabType: tabType.value,
      subIndex: subIndex.value,
      nextResetUtc: payload.readBigInt64LE(subIndex.offset),
    });
    offset = subIndex.offset + 8;
  }
  assert.strictEqual(offset, payload.length, "shop chain reset ACK must not contain trailing bytes");
  return { errorCode: error.value, entries };
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
      assert(result.ok, `managed client schema rejected shop chain reset packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
