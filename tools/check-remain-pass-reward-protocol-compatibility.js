"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createEventPassHandlers, hasRemainingPassReward } = require("../modules/event-pass");
const { getMiscItem } = require("../modules/inventory");
const { readSignedVarInt, readSignedVarIntList } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const now = new Date("2021-02-02T12:00:00Z");
const user = {
  userUid: "1668001",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  counterPass: {
    passes: {
      500: {
        eventPassId: 500,
        startDate: "2020-12-25T04:00:00.000Z",
        endDate: "2021-02-01T02:00:00.000Z",
        totalExp: 1200,
        rewardNormalLevel: 0,
        rewardCoreLevel: 0,
        isCorePassPurchased: true,
      },
    },
  },
};
const eventState = {
  counterPasses: [{ eventPassId: 500, startDate: "2021-01-01T04:00:00Z", endDate: "2021-02-10T02:00:00Z" }],
};
const socket = { session: { user } };
const handlers = new Map(createEventPassHandlers().map((handler) => [handler.packetId, handler]));
const handler = handlers.get(1668);
assert(handler, "REMAIN_PASS_REWARD_REQ must belong to the Event Pass handler family");

let saves = 0;
let invalidations = 0;
const managedPackets = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  eventManager: { getActiveEventState: () => eventState },
  getServerNowDate: () => now,
  dateTimeBinaryNow: () => 0n,
  decryptCopy: (payload) => payload,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    if (packet.payload.length === 0) managedPackets.push([packet.packetId, packet.payload]);
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

assert.strictEqual(hasRemainingPassReward(ctx, user), false, "an active pass must never be treated as expired remainder state");
eventState.counterPasses = [];
assert.strictEqual(hasRemainingPassReward(ctx, user), true, "expired unclaimed pass levels must raise JOIN hasRemainReward");

send(Buffer.from([0]));
assertAck(20191, 0);
assert.strictEqual(saves, 0, "malformed requests must not persist");
assert.strictEqual(user.counterPass.passes["500"].rewardNormalLevel, 0, "malformed requests must not advance rewards");

send(Buffer.alloc(0));
assertAck(0, 1, 0);
assert.strictEqual(user.counterPass.passes["500"].rewardNormalLevel, 2, "normal remainder cursor must reach earned level");
assert.strictEqual(user.counterPass.passes["500"].rewardCoreLevel, 2, "purchased core remainder cursor must reach earned level");
assert.strictEqual(getMiscItem(user, 1).countFree, "100000", "level-one normal credits must be granted exactly");
assert.strictEqual(getMiscItem(user, 2).countFree, "9000", "normal and core level rewards must aggregate exactly");
assert.strictEqual(getMiscItem(user, 101).countFree, "100", "level-two core reward must be granted exactly");
assert.strictEqual(saves, 1, "all expired-pass rewards must persist atomically once");
assert.strictEqual(invalidations, 1, "successful claim must invalidate JOIN hasRemainReward once");
assert.strictEqual(hasRemainingPassReward(ctx, user), false, "claimed levels must clear JOIN hasRemainReward");

send(Buffer.alloc(0));
assertAck(20679, 0);
assert.strictEqual(saves, 1, "duplicate claims must not persist");
assert.strictEqual(invalidations, 1, "duplicate claims must not invalidate JOIN");

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(hasRemainingPassReward(ctx, restarted), false, "claimed remainder state must survive JSON restart");

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert.match(
  listenerSource,
  /writeBool\(eventPass\.hasRemainingPassReward\(clockCtx, user\)\), \/\/ hasRemainReward/,
  "JOIN_LOBBY must publish the authoritative remaining-pass predicate"
);
const rosterSource = fs.readFileSync(path.join(rootDir, "modules", "combat-roster", "index.js"), "utf8");
assert(!rosterSource.includes("REMAIN_PASS_REWARD_REQ"), "the old empty-success roster handler must stay removed");

validateManagedSchemas();
console.log(
  `[remain-pass-reward-check] PASS saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function send(payload) {
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 1668, sequence: 1668, payload }), true);
  assert.strictEqual(socket.response.packetId, 1669);
}

function assertAck(errorCode, contentCount, firstContent = null) {
  const error = readSignedVarInt(socket.response.payload, 0);
  assert.strictEqual(error.value, errorCode, "remaining-pass ACK error code");
  const contents = readSignedVarIntList(socket.response.payload, error.offset);
  assert.strictEqual(contents.value.length, contentCount, "remaining-pass ACK content count");
  if (contentCount > 0) {
    assert.strictEqual(contents.value[0], firstContent, "remaining-pass ACK content enum");
  }
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
    for (const [packetId, payload] of managedPackets) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected remaining-pass packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
