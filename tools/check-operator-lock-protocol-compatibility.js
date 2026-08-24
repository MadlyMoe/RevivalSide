"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getArmyOperatorByUid, grantOperator } = require("../modules/unit");
const { getPlayableOperatorIds } = require("../modules/game-data");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000006", nickname: "OperatorLockCheck" };
const operator = grantOperator(user, getPlayableOperatorIds()[0]);
assert(operator, "frozen operator table must contain a playable operator");
const operatorUid = BigInt(operator.uid);
const socket = { session: { user } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.OPERATOR_LOCK_REQ);
assert(handler, "operator lock handler must be registered");
const managedWire = [];
let saves = 0;
let response = null;
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

send(Buffer.alloc(0), false);
assertAck(ERROR_CODES.OPERATOR_INVALID_UNIT_UID, 0n, false);
send(Buffer.concat([lockRequest(operatorUid, true), Buffer.from([0])]), false);
assertAck(ERROR_CODES.OPERATOR_INVALID_UNIT_UID, operatorUid, true);
send(lockRequest(999999999n, true));
assertAck(ERROR_CODES.OPERATOR_INVALID_UNIT_UID, 999999999n, true);
assert.strictEqual(saves, 0, "invalid operator lock requests must not persist");

send(lockRequest(operatorUid, true));
assertAck(ERROR_CODES.OK, operatorUid, true);
assert.strictEqual(getArmyOperatorByUid(user, operatorUid).locked, true);
assert.strictEqual(saves, 1, "changed operator lock state must persist once");
send(lockRequest(operatorUid, true));
assertAck(ERROR_CODES.OK, operatorUid, true);
assert.strictEqual(saves, 1, "idempotent operator lock state must not persist");
send(lockRequest(operatorUid, false));
assertAck(ERROR_CODES.OK, operatorUid, false);
assert.strictEqual(getArmyOperatorByUid(user, operatorUid).locked, false);
assert.strictEqual(saves, 2, "changed operator unlock state must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyOperatorByUid(restarted, operatorUid).locked, false);

validateManagedSchemas();
console.log(`[operator-lock-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function lockRequest(uid, locked) {
  return Buffer.concat([writeSignedVarLong(uid), writeBool(locked)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.OPERATOR_LOCK_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.OPERATOR_LOCK_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedLocked) {
  assert(response, "operator lock handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.OPERATOR_LOCK_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const locked = readBool(response.payload, uid.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(uid.value, expectedUid);
  assert.strictEqual(locked.value, expectedLocked);
  assert.strictEqual(locked.offset, response.payload.length, "operator lock ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected operator lock packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
