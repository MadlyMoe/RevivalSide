"use strict";

const assert = require("assert");
const path = require("path");
const { createEventPassHandlers } = require("../modules/event-pass");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readSignedVarInt, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "950000000000001",
  nickname: "PassCheck",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  completedMissions: {},
};
setMiscItemBalance(user, 1, 20000);
setMiscItemBalance(user, 102, 0);

const eventState = {
  counterPasses: [{ eventPassId: 500, startDate: "2020-12-25T04:00:00Z", endDate: "2021-02-01T02:00:00Z" }],
};
const socket = { session: { user, gameReplay: {} } };
const handlers = new Map(createEventPassHandlers().map((handler) => [handler.packetId, handler]));
const wire = [];
const pushes = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  eventManager: { getActiveEventState: () => eventState },
  getServerNowDate: () => new Date("2021-01-05T12:00:00Z"),
  decryptCopy: (payload) => payload,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { sequence: packet.sequence, packetId, payload };
    wire.push([packetId, payload]);
  },
  sendServerGamePacket(_target, packetId, payload) {
    pushes.push([packetId, payload]);
    wire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(3010);
assertAck(3011, 0);
send(3012, 0);
assertAck(3013, 0);
assert.strictEqual(saves, 2, "active pass and mission initialization must persist");
let state = user.counterPass.passes["500"];
assert.strictEqual(state.missions.Daily.length, 10, "daily pass missions must fill the configured slots");

send(3017, 99999999);
assertAck(3018, 20690);
assert.strictEqual(saves, 2, "unknown rerolls must not persist");
for (let index = 0; index < 3; index += 1) {
  send(3017, state.missions.Daily[0].missionId);
  assertAck(3018, 0);
}
assert.strictEqual(getMiscItem(user, 1).countFree, "20000", "the first three daily rerolls must be free");
send(3017, state.missions.Daily[0].missionId);
assertAck(3018, 0);
assert.strictEqual(getMiscItem(user, 1).countFree, "0", "paid daily rerolls must spend exactly 20000 credits");
send(3017, state.missions.Daily[0].missionId);
assertAck(3018, 109);

setMiscItemBalance(user, 1, 80000);
for (let index = 0; index < 4; index += 1) {
  send(3017, state.missions.Daily[0].missionId);
  assertAck(3018, 0);
}
assert.strictEqual(state.missions.Daily[0].retryCount, 8);
send(3017, state.missions.Daily[0].missionId);
assertAck(3018, 20709);

send(3015, 0);
assertAck(3016, 20682);
for (const mission of state.missions.Daily.slice(0, 8)) user.completedMissions[String(mission.missionId)] = { rewardClaimed: true };
send(3015, 0);
assertAck(3016, 0);
state = user.counterPass.passes["500"];
assert.strictEqual(state.totalExp, 200, "daily final mission must grant its configured pass experience");
send(3015, 0);
assertAck(3016, 20683);

send(3008);
assertAck(3009, 0);
state = user.counterPass.passes["500"];
assert.strictEqual(state.rewardNormalLevel, 1, "level reward claim must advance the normal reward cursor");
send(3008);
assertAck(3009, 20679);

send(3024, 0);
assertAck(3025, 20696);
send(3024, 1);
assertAck(3025, 109);
setMiscItemBalance(user, 102, 10000);
send(3024, 1);
assertAck(3025, 0);
state = user.counterPass.passes["500"];
assert.strictEqual(state.totalExp, 1200);
assert.strictEqual(getMiscItem(user, 102).countFree, "9900", "direct pass levels must spend the configured per-level cost");

send(3019);
assertAck(3020, 0);
state = user.counterPass.passes["500"];
assert.strictEqual(getMiscItem(user, 102).countFree, "7730", "core pass must spend its configured price");
send(3019);
assertAck(3020, 20693);
send(3021);
assertAck(3022, 0);
state = user.counterPass.passes["500"];
assert.strictEqual(getMiscItem(user, 102).countFree, "4360", "core-plus upgrade must apply the frozen client discount");
assert.strictEqual(state.totalExp, 16200, "core-plus purchase must grant configured pass experience");
send(3021);
assertAck(3022, 20693);

const successfulSaves = saves;
eventState.counterPasses = [];
for (const [packetId, ackId, payload] of [
  [3008, 3009], [3012, 3013, 0], [3015, 3016, 0], [3017, 3018, 1],
  [3019, 3020], [3021, 3022], [3024, 3025, 1],
]) {
  send(packetId, payload);
  assertAck(ackId, 20716);
}
assert.strictEqual(saves, successfulSaves, "inactive pass mutations must not persist");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(restarted.counterPass.passes["500"].corePassPlusPurchased, true);
assert.strictEqual(restarted.counterPass.passes["500"].totalExp, 16200);
assert(pushes.some(([packetId]) => packetId === 3023), "successful pass mutations must refresh dot state");

validateManagedSchemas();
console.log(`[event-pass-protocol-check] PASS saves=${saves} pushes=${pushes.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, value) {
  const handler = handlers.get(packetId);
  assert(handler, `missing event-pass handler ${packetId}`);
  const payload = value == null ? Buffer.alloc(0) : writeSignedVarInt(value);
  wire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(socket.response.packetId, packetId, `unexpected ACK for ${packetId}`);
  assert.strictEqual(readSignedVarInt(socket.response.payload, 0).value, errorCode, `packet ${packetId} error code`);
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
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected event-pass packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
