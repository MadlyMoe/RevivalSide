"use strict";

const assert = require("assert");
const path = require("path");
const handler = require("../modules/unit-growth/handlers/1418-set-unit-skin-req");
const { getPlayableShipIds } = require("../modules/game-data");
const { getSkinIds, grantSkin } = require("../modules/inventory");
const { getArmyUnitByUid, grantUnit } = require("../modules/unit");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const SET_SKIN_REQ = 1418;
const SET_SKIN_ACK = 1419;
const NEC_OK = 0;
const NEC_FAIL_UNIT_NOT_EXIST = 133;
const NEC_FAIL_SKIN_NOT_OWNED = 274;
const NEC_FAIL_SKIN_UNIT_NOT_MATCH = 275;
const NEC_FAIL_UNIT_IS_SEIZED = 20316;
const NEC_FAIL_INVALID_REQUEST = 20191;
const YOO_MINA_SKIN_ID = 100101;
const HILDE_SKIN_ID = 100202;
const rootDir = path.resolve(__dirname, "..");

const user = { userUid: "986000000000025", nickname: "UnitSkinCheck" };
const unit = grantUnit(user, 1001);
const rearmedUnit = grantUnit(user, 2001);
const ship = grantUnit(user, getPlayableShipIds()[0]);
assert(unit && rearmedUnit && ship, "frozen unit table must contain normal, rearmed, and ship fixtures");
const unitUid = BigInt(unit.unitUid);
const rearmedUnitUid = BigInt(rearmedUnit.unitUid);
const shipUid = BigInt(ship.unitUid);
const socket = { session: { user } };
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => user,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-skin");
    invalidations += 1;
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};

send(Buffer.alloc(0), false);
assertAck(NEC_FAIL_INVALID_REQUEST, 0n, 0);
send(Buffer.concat([skinRequest(unitUid, YOO_MINA_SKIN_ID), Buffer.from([0])]), false);
assertAck(NEC_FAIL_INVALID_REQUEST, unitUid, YOO_MINA_SKIN_ID);
send(skinRequest(999999999n, YOO_MINA_SKIN_ID));
assertAck(NEC_FAIL_UNIT_NOT_EXIST, 999999999n, YOO_MINA_SKIN_ID);
send(skinRequest(shipUid, 0));
assertAck(NEC_FAIL_UNIT_NOT_EXIST, shipUid, 0);
assertNoMutation(0);

send(skinRequest(unitUid, YOO_MINA_SKIN_ID));
assertAck(NEC_FAIL_SKIN_NOT_OWNED, unitUid, YOO_MINA_SKIN_ID);
assert(!getSkinIds(user).includes(YOO_MINA_SKIN_ID), "setting a skin must never grant ownership");
grantSkin(user, HILDE_SKIN_ID);
send(skinRequest(unitUid, HILDE_SKIN_ID));
assertAck(NEC_FAIL_SKIN_UNIT_NOT_MATCH, unitUid, HILDE_SKIN_ID);
assertNoMutation(0);

grantSkin(user, YOO_MINA_SKIN_ID);
user.army.units[String(unitUid)].isSeized = true;
send(skinRequest(unitUid, YOO_MINA_SKIN_ID));
assertAck(NEC_FAIL_UNIT_IS_SEIZED, unitUid, YOO_MINA_SKIN_ID);
assertNoMutation(0);

user.army.units[String(unitUid)].isSeized = false;
send(skinRequest(unitUid, YOO_MINA_SKIN_ID));
assertAck(NEC_OK, unitUid, YOO_MINA_SKIN_ID);
assert.strictEqual(getArmyUnitByUid(user, unitUid).skinId, YOO_MINA_SKIN_ID);
assertMutation(1);
send(skinRequest(unitUid, YOO_MINA_SKIN_ID));
assertAck(NEC_OK, unitUid, YOO_MINA_SKIN_ID);
assertMutation(1);

send(skinRequest(rearmedUnitUid, YOO_MINA_SKIN_ID));
assertAck(NEC_OK, rearmedUnitUid, YOO_MINA_SKIN_ID);
assert.strictEqual(getArmyUnitByUid(user, rearmedUnitUid).skinId, YOO_MINA_SKIN_ID, "same-base rearmed units must accept the frozen base-unit skin");
assertMutation(2);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyUnitByUid(restarted, unitUid).skinId, YOO_MINA_SKIN_ID);
assert.strictEqual(getArmyUnitByUid(restarted, rearmedUnitUid).skinId, YOO_MINA_SKIN_ID);
assert(getSkinIds(restarted).includes(YOO_MINA_SKIN_ID));

user.army.units[String(unitUid)].isSeized = true;
send(skinRequest(unitUid, 0));
assertAck(NEC_OK, unitUid, 0);
assert.strictEqual(getArmyUnitByUid(user, unitUid).skinId, 0, "frozen client allows seized units to reset to the default skin");
assertMutation(3);
send(skinRequest(unitUid, 0));
assertAck(NEC_OK, unitUid, 0);
assertMutation(3);

assert.strictEqual(saves, 3, "only three changed skin selections should persist");
assert.strictEqual(invalidations, saves, "only changed skin selections should invalidate the lobby snapshot");
validateManagedSchemas();
console.log(`[unit-skin-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function skinRequest(uid, skinID) {
  return Buffer.concat([writeSignedVarLong(uid), writeSignedVarInt(skinID)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([SET_SKIN_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: SET_SKIN_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedUid, expectedSkinID) {
  assert(response, "unit skin handler must send an ACK");
  assert.strictEqual(response.packetId, SET_SKIN_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const uid = readSignedVarLong(response.payload, error.offset);
  const skin = readSignedVarInt(response.payload, uid.offset);
  assert.strictEqual(error.value, expectedError);
  assert.strictEqual(uid.value, expectedUid);
  assert.strictEqual(skin.value, expectedSkinID);
  assert.strictEqual(skin.offset, response.payload.length, "unit skin ACK must not contain trailing fields");
}

function assertNoMutation(expectedSaves) {
  assert.strictEqual(saves, expectedSaves);
  assert.strictEqual(invalidations, expectedSaves);
}

function assertMutation(expectedSaves) {
  assert.strictEqual(saves, expectedSaves);
  assert.strictEqual(invalidations, expectedSaves);
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
      assert(result.ok, `managed client schema rejected unit skin packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
