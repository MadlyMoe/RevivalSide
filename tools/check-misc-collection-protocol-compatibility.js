"use strict";

const assert = require("assert");
const path = require("path");
const {
  COLLECTION_ERRORS,
  PACKETS,
  buildMiscCollectionEntries,
  createCollectionHandlers,
} = require("../modules/collection");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const miscTypes = { EMBLEM: 4, EMBLEM_RANK: 5, BACKGROUND: 14, FRAME: 15, SELFIE_FRAME: 15 };
const rows = readGameplayTableRecords("ab_script", "LUA_COLLECTION_V2_MISC.json", {
  rootDir,
  logLabel: "misc-collection-check",
}).map((row) => ({
  miscId: Number(row && row.CollectionItemID),
  miscType: miscTypes[String(row && row.MiscType).toUpperCase()],
  rewardId: Number(row && row.CollectionRewardID),
  rewardValue: Number(row && row.CollectionRewardValue),
  defaultCollection: Boolean(row && row.DefaultCollection),
}));
const claimable = rows.filter(
  (row) => row.miscId > 0 && Number.isInteger(row.miscType) && row.rewardId > 0 && row.rewardValue > 0 && !row.defaultCollection
);
const byType = new Map();
for (const row of claimable) {
  const group = byType.get(row.miscType) || [];
  group.push(row);
  byType.set(row.miscType, group);
}
const bulkFixture = Array.from(byType.values()).find((group) => group.length >= 3);
assert(bulkFixture, "frozen misc collection table must contain a three-item claim fixture");
const singleFixture = bulkFixture[0];
const bulkRows = bulkFixture.slice(1, 3);
const unownedFixture = bulkFixture[3] || claimable.find((row) => row.miscId !== singleFixture.miscId);
const defaultFixture = rows.find((row) => row.defaultCollection);
assert(unownedFixture && defaultFixture, "frozen misc collection table must contain unowned and default fixtures");

const user = {
  userUid: "986000000000002",
  nickname: "MiscCollectionCheck",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
};
const socket = { session: { user } };
const handlers = new Map(createCollectionHandlers().map((entry) => [entry.packetId, entry]));
const managedWire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 5250083637907387904n,
  sendGameResponse(target, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(PACKETS.MISC_COLLECTION_REWARD_REQ, Buffer.alloc(0), false);
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.MISC_INVALID_ID);
send(PACKETS.MISC_COLLECTION_REWARD_REQ, Buffer.concat([writeSignedVarInt(singleFixture.miscId), Buffer.from([0])]), false);
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.MISC_INVALID_ID);
send(PACKETS.MISC_COLLECTION_REWARD_REQ, writeSignedVarInt(999999999));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.MISC_INVALID_ID);
send(PACKETS.MISC_COLLECTION_REWARD_REQ, writeSignedVarInt(defaultFixture.miscId));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.MISC_DEFAULT_COLLECTION);
send(PACKETS.MISC_COLLECTION_REWARD_REQ, writeSignedVarInt(unownedFixture.miscId));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.MISC_NOT_EXISTS_ITEM_HISTORY);
assert.strictEqual(saves, 0, "rejected misc collection claims must not persist");

setMiscItemBalance(user, singleFixture.miscId, 1);
const singleRewardBefore = BigInt(getMiscItem(user, singleFixture.rewardId).countFree);
send(PACKETS.MISC_COLLECTION_REWARD_REQ, writeSignedVarInt(singleFixture.miscId));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.OK);
assert.strictEqual(
  BigInt(getMiscItem(user, singleFixture.rewardId).countFree),
  singleRewardBefore + BigInt(singleFixture.rewardValue)
);
send(PACKETS.MISC_COLLECTION_REWARD_REQ, writeSignedVarInt(singleFixture.miscId));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ACK, COLLECTION_ERRORS.MISC_ALREADY_GIVEN);
assert.strictEqual(saves, 1, "single misc collection reward must save exactly once");

send(PACKETS.MISC_COLLECTION_REWARD_ALL_REQ, Buffer.alloc(0), false);
assertAck(PACKETS.MISC_COLLECTION_REWARD_ALL_ACK, COLLECTION_ERRORS.MISC_INVALID_TYPE);
send(PACKETS.MISC_COLLECTION_REWARD_ALL_REQ, writeSignedVarInt(0));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ALL_ACK, COLLECTION_ERRORS.MISC_INVALID_TYPE);

const expectedBulkRewards = new Map();
for (const row of bulkRows) {
  setMiscItemBalance(user, row.miscId, 1);
  expectedBulkRewards.set(row.rewardId, (expectedBulkRewards.get(row.rewardId) || 0n) + BigInt(row.rewardValue));
}
const bulkRewardBefore = new Map(
  Array.from(expectedBulkRewards.keys()).map((itemId) => [itemId, BigInt(getMiscItem(user, itemId).countFree)])
);
send(PACKETS.MISC_COLLECTION_REWARD_ALL_REQ, writeSignedVarInt(singleFixture.miscType));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ALL_ACK, COLLECTION_ERRORS.OK);
for (const [itemId, increment] of expectedBulkRewards) {
  assert.strictEqual(BigInt(getMiscItem(user, itemId).countFree), bulkRewardBefore.get(itemId) + increment);
}
send(PACKETS.MISC_COLLECTION_REWARD_ALL_REQ, writeSignedVarInt(singleFixture.miscType));
assertAck(PACKETS.MISC_COLLECTION_REWARD_ALL_ACK, COLLECTION_ERRORS.MISC_NOT_EXISTS_ITEM_HISTORY);
assert.strictEqual(saves, 2, "bulk misc collection rewards must save only the successful transition");

const expectedClaimIds = [singleFixture, ...bulkRows].map((row) => row.miscId).sort((a, b) => a - b);
assert.deepStrictEqual(buildMiscCollectionEntries(user).map(([miscId]) => miscId), expectedClaimIds);
const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(buildMiscCollectionEntries(restarted).map(([miscId]) => miscId), expectedClaimIds);

validateManagedSchemas();
console.log(`[misc-collection-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing misc collection handler ${packetId}`);
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, expectedError) {
  assert(response, "misc collection handler must send an ACK");
  assert.strictEqual(response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expectedError);
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
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected misc collection packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
