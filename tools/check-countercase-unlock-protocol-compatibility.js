"use strict";

const assert = require("assert");
const path = require("path");
const {
  createSimulationHandlers,
  getAllCounterCaseStages,
  getCounterCaseStageByDungeonId,
  buildCounterCaseDataEntries,
} = require("../modules/simulation");
const { grantUnit } = require("../modules/unit");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, readSignedVarLong, writeSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const UNLOCK_REQ = 1204;
const UNLOCK_ACK = 1205;
const NEC_OK = 0;
const NEC_FAIL_INVALID_DUNGEON_ID = 64;
const NEC_FAIL_LOCKED_EPISODE = 67;
const NEC_FAIL_INSUFFICIENT_INFORMATION = 99;
const NEC_FAIL_COUNTERCASE_ALREADY_UNLOCKED = 292;
const NEC_FAIL_INVALID_REQUEST = 20191;
const INFORMATION_ITEM_ID = 3;
const rootDir = path.resolve(__dirname, "..");
const stages = getAllCounterCaseStages();
assert.strictEqual(stages.length, 199, "all frozen Counter Case stages must map to dungeons");
assert.deepStrictEqual(
  [...new Set(stages.map((stage) => stage.m_UnlockReqType))].sort(),
  [
    "SURT_ALWAYS_UNLOCKED",
    "SURT_CLEAR_DUNGEON",
    "SURT_UNIT_GET",
    "SURT_UNIT_LEVEL_100",
    "SURT_UNIT_LEVEL_25",
    "SURT_UNIT_LEVEL_50",
    "SURT_UNIT_LEVEL_80",
  ]
);
assert(stages.every((stage) => getCounterCaseStageByDungeonId(stage.dungeonID) === stage));
assert(stages.every((stage) => !stage.m_UnlockItemID || Number(stage.m_UnlockItemID) === INFORMATION_ITEM_ID));

const alwaysStage = findStage("SURT_ALWAYS_UNLOCKED");
const clearStage = findStage("SURT_CLEAR_DUNGEON");
const unitGetStage = findStage("SURT_UNIT_GET");
const levelStages = [25, 50, 80, 100].map((level) => [level, findStage(`SURT_UNIT_LEVEL_${level}`)]);
const user = { userUid: "986000000000024", nickname: "CounterCaseUnlockCheck", collection: { units: [] } };
setMiscItemBalance(user, INFORMATION_ITEM_ID, 0);
const socket = { session: { user } };
const handler = createSimulationHandlers().find((entry) => entry.packetId === UNLOCK_REQ);
assert(handler, "Counter Case unlock handler must be registered");
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "countercase-unlock");
    invalidations += 1;
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};

send(Buffer.alloc(0), false);
assertAck(NEC_FAIL_INVALID_REQUEST, 0, false);
send(Buffer.concat([request(alwaysStage.dungeonID), Buffer.from([0])]), false);
assertAck(NEC_FAIL_INVALID_REQUEST, 0, false);
send(request(1));
assertAck(NEC_FAIL_INVALID_DUNGEON_ID, 1, false);
assertNoSuccessfulMutation(0);

send(request(clearStage.dungeonID));
assertAck(NEC_FAIL_LOCKED_EPISODE, clearStage.dungeonID, false);
user.dungeonClear = { [String(clearStage.m_UnlockReqValue)]: { dungeonId: Number(clearStage.m_UnlockReqValue) } };
send(request(clearStage.dungeonID));
assertAck(NEC_OK, clearStage.dungeonID, false);
assertSuccessfulUnlock(clearStage.dungeonID, 1);

send(request(alwaysStage.dungeonID));
assertAck(NEC_OK, alwaysStage.dungeonID, false);
assertSuccessfulUnlock(alwaysStage.dungeonID, 2);
send(request(alwaysStage.dungeonID));
assertAck(NEC_FAIL_COUNTERCASE_ALREADY_UNLOCKED, alwaysStage.dungeonID, false);
assertNoSuccessfulMutation(2);

user.collection.units.push(Number(unitGetStage.m_UnlockReqValue));
send(request(unitGetStage.dungeonID));
assertAck(NEC_FAIL_INSUFFICIENT_INFORMATION, unitGetStage.dungeonID, false);
assertNoSuccessfulMutation(2);
setMiscItemBalance(user, INFORMATION_ITEM_ID, 2000);
send(request(unitGetStage.dungeonID));
assertAck(NEC_OK, unitGetStage.dungeonID, true);
assertSuccessfulUnlock(unitGetStage.dungeonID, 3);
assert.strictEqual(totalInformation(), 2000n - BigInt(unitGetStage.m_UnlockItemPrice));
send(request(unitGetStage.dungeonID));
assertAck(NEC_FAIL_COUNTERCASE_ALREADY_UNLOCKED, unitGetStage.dungeonID, false);
assertNoSuccessfulMutation(3);

for (const [level, stage] of levelStages) {
  const ownedUnit = grantUnit(user, Number(stage.m_UnlockReqValue), { level: level - 1 });
  assert(ownedUnit, `frozen Counter Case unit ${stage.m_UnlockReqValue} must exist`);
  const unitKey = String(ownedUnit.unitUid);
  const beforeSaves = saves;
  send(request(stage.dungeonID));
  assertAck(NEC_FAIL_LOCKED_EPISODE, stage.dungeonID, false);
  assertNoSuccessfulMutation(beforeSaves);
  user.army.units[unitKey].level = level;
  const before = totalInformation();
  send(request(stage.dungeonID));
  assertAck(NEC_OK, stage.dungeonID, true);
  assert.strictEqual(totalInformation(), before - BigInt(stage.m_UnlockItemPrice));
  assertSuccessfulUnlock(stage.dungeonID, beforeSaves + 1);
}

assert.strictEqual(saves, 7, "only seven successful unlocks should persist");
assert.strictEqual(invalidations, saves, "only successful unlocks should invalidate the lobby snapshot");
const restarted = JSON.parse(JSON.stringify(user));
const unlockedIds = buildCounterCaseDataEntries(restarted).map(([dungeonID]) => dungeonID);
for (const dungeonID of [clearStage.dungeonID, alwaysStage.dungeonID, unitGetStage.dungeonID, ...levelStages.map(([, stage]) => stage.dungeonID)]) {
  assert(unlockedIds.includes(dungeonID), `Counter Case ${dungeonID} must survive restart`);
}
assert.strictEqual(BigInt(getMiscItem(restarted, INFORMATION_ITEM_ID).countFree), totalInformation());
validateManagedSchemas();
console.log(
  `[countercase-unlock-protocol-check] PASS stages=${stages.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function findStage(type) {
  const stage = stages.find((entry) => entry.m_UnlockReqType === type);
  assert(stage, `frozen Counter Case stage ${type} must exist`);
  return stage;
}

function request(dungeonID) {
  return writeSignedVarInt(dungeonID);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([UNLOCK_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: UNLOCK_REQ, sequence: 1, payload }), true);
}

function assertAck(errorCode, dungeonID, hasCostItem) {
  assert(response && response.packetId === UNLOCK_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const dungeon = readSignedVarInt(response.payload, error.offset);
  assert.strictEqual(error.value, errorCode);
  assert.strictEqual(dungeon.value, dungeonID);
  assert.strictEqual(response.payload[dungeon.offset], hasCostItem ? 1 : 0);
  if (!hasCostItem) return;
  const itemId = readSignedVarInt(response.payload, dungeon.offset + 1);
  const free = readSignedVarLong(response.payload, itemId.offset);
  const paid = readSignedVarLong(response.payload, free.offset);
  assert.strictEqual(itemId.value, INFORMATION_ITEM_ID);
  assert.strictEqual(BigInt(free.value) + BigInt(paid.value), totalInformation());
}

function assertSuccessfulUnlock(dungeonID, expectedSaves) {
  assert(buildCounterCaseDataEntries(user).some(([id]) => id === dungeonID));
  assert.strictEqual(saves, expectedSaves);
  assert.strictEqual(invalidations, expectedSaves);
}

function assertNoSuccessfulMutation(expectedSaves) {
  assert.strictEqual(saves, expectedSaves);
  assert.strictEqual(invalidations, expectedSaves);
}

function totalInformation() {
  const item = getMiscItem(user, INFORMATION_ITEM_ID);
  return BigInt(item.countFree) + BigInt(item.countPaid);
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
      assert(result.ok, `managed client schema rejected Counter Case packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
