"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getPlayableShipIds } = require("../modules/game-data");
const { getMiscItem, grantMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const DOCUMENT_ITEM_ID = 1024;
const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000026", nickname: "PermanentContractCheck" };
const unit = grantUnit(user, 1001, { loyalty: 0 });
const ship = grantUnit(user, getPlayableShipIds()[0]);
assert(unit && ship, "frozen unit table must contain lifetime-contract and ship fixtures");
const unitUid = BigInt(unit.unitUid);
const shipUid = BigInt(ship.unitUid);
const socket = { session: { user } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.CONTRACT_PERMANENTLY_REQ);
assert(handler, "permanent-contract handler must be registered");
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
let missionEvents = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "permanent-contract");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition) {
    assert.strictEqual(condition, "UNIT_GROWTH_PERMANENT");
    missionEvents += 1;
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

setMiscItemBalance(user, DOCUMENT_ITEM_ID, 0);
send(Buffer.alloc(0), false);
assertAck(ERROR_CODES.INVALID_REQUEST, 0n, null);
send(Buffer.concat([request(unitUid), Buffer.from([0])]), false);
assertAck(ERROR_CODES.INVALID_REQUEST, unitUid, null);
send(request(999999999n));
assertAck(ERROR_CODES.UNIT_NOT_EXIST, 999999999n, null);
send(request(shipUid));
assertAck(ERROR_CODES.UNIT_NOT_EXIST, shipUid, null);
assertNoMutation();

send(request(unitUid));
assertAck(ERROR_CODES.INSUFFICIENT_ITEM, unitUid, null);
assertNoMutation();
grantMiscItem(user, DOCUMENT_ITEM_ID, 1);
send(request(unitUid));
assertAck(ERROR_CODES.PERMANENT_CONTRACT_INVALID_CONDITION, unitUid, null);
assert.strictEqual(documentCount(), 1n);
assertNoMutation();

user.army.units[String(unitUid)].loyalty = 10000;
send(request(unitUid));
assertAck(ERROR_CODES.OK, unitUid, 0n);
assert.strictEqual(getArmyUnitByUid(user, unitUid).isPermanentContract, true);
assert.strictEqual(getArmyUnitByUid(user, unitUid).loyalty, 10000);
assert.strictEqual(documentCount(), 0n);
assertMutation(1);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnitByUid(restarted, unitUid).isPermanentContract, true);
assert.strictEqual(BigInt(getMiscItem(restarted, DOCUMENT_ITEM_ID).countFree), 0n);

grantMiscItem(user, DOCUMENT_ITEM_ID, 1);
send(request(unitUid));
assertAck(ERROR_CODES.PERMANENT_CONTRACT_INVALID_CONDITION, unitUid, null);
assert.strictEqual(documentCount(), 1n, "duplicate lifetime contracts must not spend another document");
assertMutation(1);

validateManagedSchemas();
console.log(`[permanent-contract-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function request(uid) {
  return writeSignedVarLong(uid);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.CONTRACT_PERMANENTLY_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.CONTRACT_PERMANENTLY_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedDocumentCount) {
  assert(response, "permanent-contract handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.CONTRACT_PERMANENTLY_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(uid.value, expectedUid);
  const present = response.payload[uid.offset] !== 0;
  assert.strictEqual(present, expectedDocumentCount !== null);
  if (!present) {
    assert.strictEqual(uid.offset + 1, response.payload.length, "failed ACK must contain only a null cost item");
    return;
  }
  const itemId = readSignedVarInt(response.payload, uid.offset + 1);
  const countFree = readSignedVarLong(response.payload, itemId.offset);
  const countPaid = readSignedVarLong(response.payload, countFree.offset);
  const bonusRatio = readSignedVarInt(response.payload, countPaid.offset);
  assert.strictEqual(itemId.value, DOCUMENT_ITEM_ID);
  assert.strictEqual(BigInt(countFree.value) + BigInt(countPaid.value), expectedDocumentCount);
  assert.strictEqual(bonusRatio.offset + 8, response.payload.length, "successful ACK must contain one exact cost item");
}

function documentCount() {
  const item = getMiscItem(user, DOCUMENT_ITEM_ID);
  return BigInt(item.countFree) + BigInt(item.countPaid);
}

function assertNoMutation() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.strictEqual(missionEvents, 0);
}

function assertMutation(expectedCount) {
  assert.strictEqual(saves, expectedCount);
  assert.strictEqual(invalidations, expectedCount);
  assert.strictEqual(missionEvents, expectedCount);
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
      assert(result.ok, `managed client schema rejected permanent-contract packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
