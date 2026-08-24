"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const {
  ensureCraftData,
  getCraftSlots,
  getEquipItems,
  getMoldMaterialCosts,
  grantEquipItem,
  grantMoldItem,
} = require("../modules/equipment");
const { getAllEquipMoldTemplets, getEquipTemplet, getMoldRewardRecords } = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeByte, writeSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const COMPLETE_REQ = 1014;
const COMPLETE_ACK = 1015;
const INSTANT_REQ = 1016;
const INSTANT_ACK = 1017;
const START_REQ = 1012;
const START_ACK = 1013;
const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_EQUIP_ITEM_FULL = 114;
const NEC_FAIL_CRAFT_INVALID_SLOT_INDEX = 295;
const NEC_FAIL_CRAFT_SLOT_ALREADY_COMPLETED = 298;
const NEC_FAIL_CRAFT_SLOT_NOT_COMPLETED = 301;
const NEC_FAIL_CRAFT_SLOT_NOT_CREATING = 303;
const NEC_FAIL_INVALID_REQUEST = 20191;
const INSTANT_ITEM_ID = 1012;
const NOW = 638000000000000000n;
const rootDir = path.resolve(__dirname, "..");
const mold = getAllEquipMoldTemplets().find((entry) => {
  const records = getMoldRewardRecords(entry.m_RewardGroupID);
  return records.length > 0 && records[0].m_RewardType === "RT_EQUIP" && getEquipTemplet(records[0].m_RewardID);
});
assert(mold, "frozen tables must contain an equipment-reward craft mold");
const user = { userUid: "986000000000023", nickname: "CraftCompletionCheck" };
ensureCraftData(user);
setMiscItemBalance(user, INSTANT_ITEM_ID, 0);
const socket = { session: { user } };
const handlers = createEquipmentPipelineHandlers();
const completeHandler = handlers.find((entry) => entry.packetId === COMPLETE_REQ);
const instantHandler = handlers.find((entry) => entry.packetId === INSTANT_REQ);
const startHandler = handlers.find((entry) => entry.packetId === START_REQ);
assert(completeHandler && instantHandler && startHandler, "craft start and completion handlers must be registered");
const managedWire = [];
let response = null;
let saves = 0;
let randomCalls = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow() { return NOW; },
  randomInt(max) {
    randomCalls += 1;
    return Math.max(0, Number(max) - 1);
  },
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

validateCraftStart();

send(COMPLETE_REQ, Buffer.alloc(0), false);
assertFailure(COMPLETE_ACK, NEC_FAIL_INVALID_REQUEST);
send(INSTANT_REQ, Buffer.from([1, 0]), false);
assertFailure(INSTANT_ACK, NEC_FAIL_INVALID_REQUEST);
send(COMPLETE_REQ, request(0));
assertFailure(COMPLETE_ACK, NEC_FAIL_CRAFT_INVALID_SLOT_INDEX);
send(COMPLETE_REQ, request(1));
assertFailure(COMPLETE_ACK, NEC_FAIL_CRAFT_SLOT_NOT_CREATING);

seedSlot(NOW + 10000000n);
send(COMPLETE_REQ, request(1));
assertFailure(COMPLETE_ACK, NEC_FAIL_CRAFT_SLOT_NOT_COMPLETED);
assert.strictEqual(saves, 0);
const beforeNormal = getEquipItems(user).length;
seedSlot(NOW - 1n);
send(COMPLETE_REQ, request(1));
assertSuccess(COMPLETE_ACK);
assert.strictEqual(getCraftSlots(user)[0].moldId, 0);
assert.strictEqual(getEquipItems(user).length, beforeNormal + 1, "normal completion must grant the table reward");
assert.strictEqual(saves, 1);

seedSlot(NOW - 1n);
send(INSTANT_REQ, request(1));
assertFailure(INSTANT_ACK, NEC_FAIL_CRAFT_SLOT_ALREADY_COMPLETED);
assert.strictEqual(getMiscItem(user, INSTANT_ITEM_ID).countFree, "0");
seedSlot(NOW + 10000000n);
send(INSTANT_REQ, request(1));
assertFailure(INSTANT_ACK, NEC_FAIL_INSUFFICIENT_ITEM);
assert.strictEqual(saves, 1);
setMiscItemBalance(user, INSTANT_ITEM_ID, 2);
const beforeInstant = getEquipItems(user).length;
send(INSTANT_REQ, request(1));
assertSuccess(INSTANT_ACK);
assert.strictEqual(getCraftSlots(user)[0].moldId, 0);
assert.strictEqual(getEquipItems(user).length, beforeInstant + 1, "instant completion must grant the table reward");
assert.strictEqual(getMiscItem(user, INSTANT_ITEM_ID).countFree, "1");
assert.strictEqual(saves, 2);
assert(randomCalls >= 4, "craft completion must use runtime randomness for reward and equipment rolls");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getCraftSlots(restarted)[0].moldId, 0);
assert.strictEqual(getEquipItems(restarted).length, getEquipItems(user).length);
assert.strictEqual(getMiscItem(restarted, INSTANT_ITEM_ID).countFree, "1");
validateManagedSchemas();
console.log(`[craft-completion-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(index) {
  return Buffer.from([index]);
}

function seedSlot(completeDate) {
  ensureCraftData(user).slots["1"] = {
    index: 1,
    moldId: Number(mold.m_MoldID),
    count: 1,
    completeDate: String(completeDate),
  };
}

function send(packetId, payload, validateRequest = true) {
  if (validateRequest) managedWire.push([packetId, payload]);
  const handler = packetId === COMPLETE_REQ ? completeHandler : instantHandler;
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
}

function validateCraftStart() {
  const startUser = { userUid: "986000000000024", nickname: "CraftStartCheck", inventoryExpansion: { equip: 1 } };
  ensureCraftData(startUser);
  grantMoldItem(startUser, Number(mold.m_MoldID), 3);
  for (const cost of getMoldMaterialCosts(mold, 3)) setMiscItemBalance(startUser, cost.itemId, cost.count);
  grantEquipItem(startUser, Number(getMoldRewardRecords(mold.m_RewardGroupID)[0].m_RewardID));
  const startSocket = { session: { user: startUser } };
  let startSaves = 0;
  const startCtx = { ...ctx, saveUserDb() { startSaves += 1; } };
  const canonical = Buffer.concat([
    writeByte(1),
    writeSignedVarInt(Number(mold.m_MoldID)),
    writeSignedVarInt(1),
  ]);

  const beforeTrailing = JSON.stringify(startUser);
  sendStart(Buffer.concat([canonical, Buffer.from([0])]));
  assertFailure(START_ACK, NEC_FAIL_INVALID_REQUEST);
  assert.strictEqual(JSON.stringify(startUser), beforeTrailing, "trailing craft-start bytes must not mutate state");
  assert.strictEqual(startSaves, 0);

  const beforeFull = JSON.stringify(startUser);
  sendStart(canonical);
  assertFailure(START_ACK, NEC_FAIL_EQUIP_ITEM_FULL);
  assert.strictEqual(JSON.stringify(startUser), beforeFull, "full equipment inventory must not consume a mold or materials");
  assert.strictEqual(startSaves, 0);

  startUser.inventory.equips = {};
  sendStart(canonical);
  assertSuccess(START_ACK);
  assert.strictEqual(getCraftSlots(startUser)[0].moldId, Number(mold.m_MoldID));
  assert.strictEqual(startSaves, 1, "only a successful craft start may persist");

  function sendStart(payload) {
    managedWire.push([START_REQ, payload]);
    response = null;
    assert.strictEqual(startHandler.handle(startCtx, startSocket, { packetId: START_REQ, sequence: 1, payload }), true);
  }
}

function assertFailure(packetId, expectedError) {
  assert(response && response.packetId === packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expectedError);
}

function assertSuccess(packetId) {
  assert(response && response.packetId === packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, NEC_OK);
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
      assert(result.ok, `managed client schema rejected craft-completion packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
