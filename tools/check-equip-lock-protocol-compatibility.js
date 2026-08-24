"use strict";

const assert = require("assert");
const path = require("path");
const { createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, grantEquipItem } = require("../modules/equipment");
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

const LOCK_REQ = 1004;
const LOCK_ACK = 1005;
const NEC_OK = 0;
const NEC_FAIL_INVALID_EQUIP_ITEM = 247;
const rootDir = path.resolve(__dirname, "..");
const user = { userUid: "986000000000007", nickname: "EquipLockCheck" };
const equip = grantEquipItem(user, 0);
assert(equip, "frozen equipment table must contain a grantable item");
const equipUid = BigInt(equip.equipUid);
const socket = { session: { user } };
const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === LOCK_REQ);
assert(handler, "equipment lock handler must be registered");
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
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, 0n, false);
send(Buffer.concat([lockRequest(equipUid, true), Buffer.from([0])]), false);
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, equipUid, true);
send(lockRequest(999999999n, true));
assertAck(NEC_FAIL_INVALID_EQUIP_ITEM, 999999999n, true);
assert.strictEqual(saves, 0, "invalid equipment lock requests must not persist");

send(lockRequest(equipUid, true));
assertAck(NEC_OK, equipUid, true);
assert.strictEqual(getEquipItem(user, equipUid).locked, true);
assert.strictEqual(saves, 1, "changed equipment lock state must persist once");
send(lockRequest(equipUid, true));
assertAck(NEC_OK, equipUid, true);
assert.strictEqual(saves, 1, "idempotent equipment lock state must not persist");
send(lockRequest(equipUid, false));
assertAck(NEC_OK, equipUid, false);
assert.strictEqual(getEquipItem(user, equipUid).locked, false);
assert.strictEqual(saves, 2, "changed equipment unlock state must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getEquipItem(restarted, equipUid).locked, false);

validateManagedSchemas();
console.log(`[equip-lock-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function lockRequest(uid, locked) {
  return Buffer.concat([writeSignedVarLong(uid), writeBool(locked)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([LOCK_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: LOCK_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedLocked) {
  assert(response, "equipment lock handler must send an ACK");
  assert.strictEqual(response.packetId, LOCK_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const locked = readBool(response.payload, uid.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(uid.value, expectedUid);
  assert.strictEqual(locked.value, expectedLocked);
  assert.strictEqual(locked.offset, response.payload.length, "equipment lock ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected equipment lock packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
