"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getArmyUnitByUid, grantUnit } = require("../modules/unit");
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
const user = { userUid: "986000000000004", nickname: "UnitFavoriteCheck" };
const unit = grantUnit(user, 1001);
assert(unit, "frozen unit table must contain unit 1001");
const unitUid = BigInt(unit.unitUid);
const socket = { session: { user } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.FAVORITE_UNIT_REQ);
assert(handler, "unit favorite handler must be registered");
const managedWire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(target, sequence, packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertAck(ERROR_CODES.UNIT_NOT_EXIST, 0n, false);
send(Buffer.concat([favoriteRequest(unitUid, true), Buffer.from([0])]), false);
assertAck(ERROR_CODES.UNIT_NOT_EXIST, unitUid, true);
send(favoriteRequest(999999999n, true));
assertAck(ERROR_CODES.UNIT_NOT_EXIST, 999999999n, true);
assert.strictEqual(saves, 0, "invalid favorite requests must not persist");

send(favoriteRequest(unitUid, true));
assertAck(ERROR_CODES.OK, unitUid, true);
assert.strictEqual(getArmyUnitByUid(user, unitUid).isFavorite, true);
assert.strictEqual(saves, 1, "changed favorite state must persist once");

send(favoriteRequest(unitUid, true));
assertAck(ERROR_CODES.OK, unitUid, true);
assert.strictEqual(saves, 1, "idempotent favorite state must not persist");

send(favoriteRequest(unitUid, false));
assertAck(ERROR_CODES.OK, unitUid, false);
assert.strictEqual(getArmyUnitByUid(user, unitUid).isFavorite, false);
assert.strictEqual(saves, 2, "changed unfavorite state must persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnitByUid(restarted, unitUid).isFavorite, false);

validateManagedSchemas();
console.log(`[unit-favorite-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function favoriteRequest(uid, favorite) {
  return Buffer.concat([writeSignedVarLong(uid), writeBool(favorite)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.FAVORITE_UNIT_REQ, payload]);
  assert.strictEqual(
    handler.handle(ctx, socket, { packetId: PACKETS.FAVORITE_UNIT_REQ, sequence: 1, payload }),
    true
  );
}

function assertAck(expectedError, expectedUid, expectedFavorite) {
  assert(response, "unit favorite handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.FAVORITE_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const favorite = readBool(response.payload, uid.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(uid.value, expectedUid);
  assert.strictEqual(favorite.value, expectedFavorite);
  assert.strictEqual(favorite.offset, response.payload.length, "favorite ACK must not contain trailing fields");
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
      assert(result.ok, `managed client schema rejected unit favorite packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
