"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getPlayableShipIds } = require("../modules/game-data");
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
const user = { userUid: "986000000000005", nickname: "UnitLockCheck" };
const unit = grantUnit(user, 1001);
const ship = grantUnit(user, getPlayableShipIds()[0]);
assert(unit, "frozen unit table must contain unit 1001");
assert(ship, "frozen ship table must contain a playable ship");
const unitUid = BigInt(unit.unitUid);
const shipUid = BigInt(ship.unitUid);
const socket = { session: { user } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.LOCK_UNIT_REQ);
assert(handler, "unit lock handler must be registered");
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
assertAck(ERROR_CODES.UNIT_NOT_EXIST, 0n, false);
send(Buffer.concat([lockRequest(unitUid, true), Buffer.from([0])]), false);
assertAck(ERROR_CODES.UNIT_NOT_EXIST, unitUid, true);
send(lockRequest(999999999n, true));
assertAck(ERROR_CODES.UNIT_NOT_EXIST, 999999999n, true);
assert.strictEqual(saves, 0, "invalid unit lock requests must not persist");

send(lockRequest(unitUid, true));
assertAck(ERROR_CODES.OK, unitUid, true);
assert.strictEqual(getArmyUnitByUid(user, unitUid).locked, true);
assert.strictEqual(saves, 1, "changed unit lock state must persist once");
send(lockRequest(unitUid, true));
assertAck(ERROR_CODES.OK, unitUid, true);
assert.strictEqual(saves, 1, "idempotent unit lock state must not persist");

send(lockRequest(shipUid, true));
assertAck(ERROR_CODES.OK, shipUid, true);
assert.strictEqual(getArmyUnitByUid(user, shipUid).locked, true, "the frozen unit-lock packet also addresses owned ships");
assert.strictEqual(saves, 2);
send(lockRequest(shipUid, false));
assertAck(ERROR_CODES.OK, shipUid, false);
assert.strictEqual(getArmyUnitByUid(user, shipUid).locked, false);
assert.strictEqual(saves, 3);

send(lockRequest(unitUid, false));
assertAck(ERROR_CODES.OK, unitUid, false);
assert.strictEqual(getArmyUnitByUid(user, unitUid).locked, false);
assert.strictEqual(saves, 4);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnitByUid(restarted, unitUid).locked, false);
assert.strictEqual(getArmyUnitByUid(restarted, shipUid).locked, false);

validateManagedSchemas();
console.log(`[unit-lock-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function lockRequest(uid, locked) {
  return Buffer.concat([writeSignedVarLong(uid), writeBool(locked)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.LOCK_UNIT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.LOCK_UNIT_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedLocked) {
  assert(response, "unit lock handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.LOCK_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const locked = readBool(response.payload, uid.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(uid.value, expectedUid);
  assert.strictEqual(locked.value, expectedLocked);
  assert.strictEqual(locked.offset, response.payload.length, "unit lock ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected unit lock packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
