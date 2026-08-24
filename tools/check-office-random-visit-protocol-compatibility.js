"use strict";

const assert = require("assert");
const path = require("path");
const { buildOfficeVisitStateData, createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { readSignedVarInt, readSignedVarLong } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handler = createOfficeHandlers().find((entry) => entry.packetId === 3634);
assert(handler, "the specialist Office random-visit handler must be registered");

const self = makeUser("9880000000003634", "Visitor");
const friend = makeUser("9880000000003635", "Random Host");
ensureOfficeState(self);
ensureOfficeState(friend);
buildOfficeVisitStateData(self);
buildOfficeVisitStateData(friend);
const socket = { session: { user: self } };
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  userDb: { users: { self } },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("a random-visit read must not invalidate JOIN"); },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

const before = JSON.stringify({ self, friend });
assertFailure(Buffer.from([0]), 20191, false);
assertFailure(Buffer.alloc(0), 20908);
ctx.userDb.users.friend = friend;
assertSuccess(Buffer.alloc(0), friend.userUid);
assert.strictEqual(JSON.stringify({ self, friend }), before, "random Office visits must not mutate either profile");
assert.strictEqual(saves, 0, "random Office visits must never save");

validateManagedSchemas();
console.log(`[office-random-visit-protocol-check] PASS requests=${wire.filter(([id]) => id === 3634).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname) {
  return {
    userUid,
    friendCode: String(BigInt(userUid) % 1000000000n),
    nickname,
    level: 50,
    hasOffice: true,
    army: { units: {}, ships: {}, operators: {}, squads: {} },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  };
}

function send(payload, schemaValid = true) {
  wire.push([3634, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3634, sequence: 3634, payload }), true);
  assert.strictEqual(socket.response.packetId, 3635);
  const error = readSignedVarInt(socket.response.payload, 0);
  return { errorCode: error.value, offset: error.offset };
}

function assertFailure(payload, errorCode, schemaValid = true) {
  const response = send(payload, schemaValid);
  assert.strictEqual(response.errorCode, errorCode);
  assert.strictEqual(socket.response.payload[response.offset], 0, "failed random visit must return a null Office state");
}

function assertSuccess(payload, userUid) {
  const response = send(payload);
  assert.strictEqual(response.errorCode, 0);
  let offset = response.offset;
  assert.strictEqual(socket.response.payload[offset++], 1, "successful random visit must return an Office state");
  assert.strictEqual(socket.response.payload[offset++], 1, "visited Office state must include a common profile");
  assert.strictEqual(readSignedVarLong(socket.response.payload, offset).value, BigInt(userUid), "random visit must not return the requester as host");
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
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Office random-visit packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
