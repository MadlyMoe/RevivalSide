"use strict";

const assert = require("assert");
const path = require("path");
const {
  ITEM_IDS,
  PVP_CHARGE_POINT_NOT_FOUND_ERROR,
  PVP_CHARGE_POINT_REFRESH_ACK,
  PVP_CHARGE_POINT_REFRESH_REQ,
  createStaminaHandlers,
  getTimedStaminaRoutes,
} = require("../modules/stamina");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "986000000000005",
  nickname: "PvpChargeCheck",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
};
const socket = { session: { user } };
const handler = createStaminaHandlers().find((entry) => entry.packetId === PVP_CHARGE_POINT_REFRESH_REQ);
assert(handler, "PvP charge refresh handler must be registered");
const managedWire = [];
let saves = 0;
let response = null;
let now = 5250083637907387904n;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => now,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(target, sequence, packetId, build) { build(); },
};

send(Buffer.alloc(0), false);
assertAck(PVP_CHARGE_POINT_NOT_FOUND_ERROR, true);
send(Buffer.concat([writeSignedVarInt(ITEM_IDS.PVP_CHARGE_POINT), Buffer.from([0])]), false);
assertAck(PVP_CHARGE_POINT_NOT_FOUND_ERROR, true);
send(writeSignedVarInt(ITEM_IDS.ETERNIUM));
assertAck(PVP_CHARGE_POINT_NOT_FOUND_ERROR, true);
assert.strictEqual(user.stamina, undefined, "invalid PvP refreshes must not create stamina state");
assert.strictEqual(saves, 0, "invalid PvP refreshes must not persist");

const pvpRoute = getTimedStaminaRoutes(user).find((route) => route.itemId === ITEM_IDS.PVP_CHARGE_POINT);
assert(pvpRoute && pvpRoute.intervalSeconds > 0 && pvpRoute.amount > 0 && pvpRoute.max > pvpRoute.amount);
const intervalTicks = BigInt(pvpRoute.intervalSeconds) * 10000000n;
setMiscItemBalance(user, ITEM_IDS.PVP_CHARGE_POINT, pvpRoute.max - pvpRoute.amount);
user.stamina = {
  chargeItems: {
    [ITEM_IDS.PVP_CHARGE_POINT]: { lastUpdateDate: String(now - intervalTicks) },
  },
};

send(writeSignedVarInt(ITEM_IDS.PVP_CHARGE_POINT));
assertAck(0, false);
assert.strictEqual(getMiscItem(user, ITEM_IDS.PVP_CHARGE_POINT).countFree, String(pvpRoute.max));
assert.strictEqual(saves, 1, "elapsed ranked-PvP charge must persist once");

setMiscItemBalance(user, ITEM_IDS.PVP_CHARGE_POINT, pvpRoute.max - pvpRoute.amount);
send(writeSignedVarInt(ITEM_IDS.PVP_CHARGE_POINT));
assertAck(0, false);
assert.strictEqual(
  getMiscItem(user, ITEM_IDS.PVP_CHARGE_POINT).countFree,
  String(pvpRoute.max - pvpRoute.amount),
  "ranked-PvP points must not refresh before the interval"
);
assert.strictEqual(saves, 1, "early refreshes must not persist");

now += intervalTicks;
send(writeSignedVarInt(ITEM_IDS.PVP_CHARGE_POINT));
assertAck(0, false);
assert.strictEqual(getMiscItem(user, ITEM_IDS.PVP_CHARGE_POINT).countFree, String(pvpRoute.max));
assert.strictEqual(saves, 2, "the next elapsed ranked-PvP interval must persist");

const practiceRoute = getTimedStaminaRoutes(user).find((route) => route.itemId === ITEM_IDS.PVP_PRACTICE_CHARGE_POINT);
assert(practiceRoute && practiceRoute.max > 0);
send(writeSignedVarInt(ITEM_IDS.PVP_PRACTICE_CHARGE_POINT));
assertAck(0, false);
assert.strictEqual(getMiscItem(user, ITEM_IDS.PVP_PRACTICE_CHARGE_POINT).countFree, String(practiceRoute.max));
assert.strictEqual(saves, 3, "missing practice-PvP state must initialize and persist once");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getMiscItem(restarted, ITEM_IDS.PVP_CHARGE_POINT).countFree, String(pvpRoute.max));
assert.strictEqual(getMiscItem(restarted, ITEM_IDS.PVP_PRACTICE_CHARGE_POINT).countFree, String(practiceRoute.max));
assert(restarted.stamina.chargeItems[String(ITEM_IDS.PVP_CHARGE_POINT)].lastUpdateDate);
assert(restarted.stamina.chargeItems[String(ITEM_IDS.PVP_PRACTICE_CHARGE_POINT)].lastUpdateDate);

validateManagedSchemas();
console.log(`[pvp-charge-refresh-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PVP_CHARGE_POINT_REFRESH_REQ, payload]);
  assert.strictEqual(
    handler.handle(ctx, socket, { packetId: PVP_CHARGE_POINT_REFRESH_REQ, sequence: 1, payload }),
    true
  );
}

function assertAck(expectedError, expectNullItem) {
  assert(response, "PvP charge refresh handler must send an ACK");
  assert.strictEqual(response.packetId, PVP_CHARGE_POINT_REFRESH_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  if (expectNullItem) assert.strictEqual(response.payload[error.offset], 0, "failed refresh ACK must contain a null item");
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
      assert(result.ok, `managed client schema rejected PvP charge packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
