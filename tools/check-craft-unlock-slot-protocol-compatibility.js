"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getCraftSlots } = require("../modules/equipment");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const UNLOCK_REQ = 1010;
const UNLOCK_ACK = 1011;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_RESOURCE = 110;
const NEC_FAIL_CRAFT_SLOT_ALREADY_UNLOCKED_MAX = 300;
const NEC_FAIL_INVALID_REQUEST = 20191;
const UNLOCK_ITEM_ID = 101;
const UNLOCK_COST = 300n;
const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000022", nickname: "CraftUnlockSlotCheck" };
assert.deepStrictEqual(getCraftSlots(user).map((slot) => slot.index), [1], "new users must start with one craft slot");
setMiscItemBalance(user, UNLOCK_ITEM_ID, 0);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === UNLOCK_REQ);
assert(handler, "craft-slot unlock handler must be registered");
const managedWire = [];
let response = null;
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

send(Buffer.from([0]), false);
assertFailure(NEC_FAIL_INVALID_REQUEST);
send(Buffer.alloc(0));
assertFailure(NEC_FAIL_INSUFFICIENT_RESOURCE);
assert.strictEqual(saves, 0, "failed unlocks must not persist");
assert.deepStrictEqual(getCraftSlots(user).map((slot) => slot.index), [1]);

setMiscItemBalance(user, UNLOCK_ITEM_ID, UNLOCK_COST * 4n + 25n);
for (let expectedIndex = 2; expectedIndex <= 5; expectedIndex += 1) {
  send(Buffer.alloc(0));
  assertSuccess(expectedIndex);
  assert.strictEqual(saves, expectedIndex - 1);
}
assert.deepStrictEqual(getCraftSlots(user).map((slot) => slot.index), [1, 2, 3, 4, 5]);
assert.strictEqual(getMiscItem(user, UNLOCK_ITEM_ID).countFree, "25");
send(Buffer.alloc(0));
assertFailure(NEC_FAIL_CRAFT_SLOT_ALREADY_UNLOCKED_MAX);
assert.strictEqual(saves, 4, "full-slot failure must not persist");
assert.strictEqual(getMiscItem(user, UNLOCK_ITEM_ID).countFree, "25");

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(getCraftSlots(restarted).map((slot) => slot.index), [1, 2, 3, 4, 5]);
assert.strictEqual(getMiscItem(restarted, UNLOCK_ITEM_ID).countFree, "25");
validateManagedSchemas();
console.log(`[craft-unlock-slot-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([UNLOCK_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: UNLOCK_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response && response.packetId === UNLOCK_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  assert.deepStrictEqual(Array.from(response.payload.subarray(error.offset)), [0, 0], "failure ACK must contain a null slot and empty cost list");
}

function assertSuccess(expectedIndex) {
  assert(response && response.packetId === UNLOCK_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, NEC_OK);
  assert.strictEqual(response.payload[error.offset], 1, "success ACK must contain the opened slot");
  assert(getCraftSlots(user).some((slot) => slot.index === expectedIndex));
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
      assert(result.ok, `managed client schema rejected craft-slot packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
