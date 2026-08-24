"use strict";

const assert = require("assert");
const path = require("path");
const {
  buildOfficeVisitStateData,
  createOfficeHandlers,
  ensureOfficeState,
} = require("../modules/office");
const {
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handler = createOfficeHandlers().find((entry) => entry.packetId === 3624);
assert(handler, "the specialist Office state handler must be registered");

const self = makeUser("9880000000003624", "Requester");
const friend = makeUser("9880000000003625", "Office Friend");
const closed = makeUser("9880000000003626", "Closed Office", false);
const legacy = { ...makeUser("9880000000003627", "Legacy Office"), office: { openedSectionIds: [101] } };
ensureOfficeState(self);
ensureOfficeState(friend);
friend.office.openedSectionIds = [101];
friend.office.rooms[0].name = "Friend Room";
buildOfficeVisitStateData(self);
buildOfficeVisitStateData(friend);

const socket = { session: { user: self } };
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  userDb: { users: { self, friend, closed, legacy } },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("a read-only Office state request must not invalidate JOIN"); },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

const before = JSON.stringify({ self, friend, closed, legacy });
assertFailure(Buffer.alloc(0), 20191, 0n, false);
assertFailure(Buffer.concat([officeStateRequest(friend.userUid), Buffer.from([0])]), 20191, friend.userUid, false);
assertFailure(officeStateRequest("9880000000003999"), 20893, "9880000000003999");
assertFailure(officeStateRequest(closed.userUid), 20893, closed.userUid);

assertSuccess(officeStateRequest(friend.userUid), friend.userUid);
assertSuccess(officeStateRequest(self.userUid), self.userUid);
assertSuccess(officeStateRequest(legacy.userUid), legacy.userUid);
assert.strictEqual(JSON.stringify({ self, friend, closed, legacy }), before, "Office state reads must not normalize or mutate any profile");
assert.strictEqual(saves, 0, "Office state reads must never save");

validateManagedSchemas();
console.log(`[office-state-protocol-check] PASS requests=${wire.filter(([id]) => id === 3624).length} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname, hasOffice = true) {
  return {
    userUid,
    friendCode: String(BigInt(userUid) % 1000000000n),
    nickname,
    level: 50,
    hasOffice,
    army: { units: {}, ships: {}, operators: {}, squads: {} },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  };
}

function officeStateRequest(userUid) {
  return writeSignedVarLong(BigInt(userUid));
}

function send(payload, schemaValid = true) {
  wire.push([3624, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 3624, sequence: 3624, payload }), true);
  assert.strictEqual(socket.response.packetId, 3625);
  return decodeAckHeader(socket.response.payload);
}

function assertFailure(payload, errorCode, echoedUid, schemaValid = true) {
  const response = send(payload, schemaValid);
  assert.strictEqual(response.errorCode, errorCode);
  assert.strictEqual(response.userUid, BigInt(echoedUid));
  assert.strictEqual(socket.response.payload[response.offset], 0, "a failed Office state ACK must carry a null state");
}

function assertSuccess(payload, userUid) {
  const response = send(payload);
  assert.strictEqual(response.errorCode, 0);
  assert.strictEqual(response.userUid, BigInt(userUid));
  let offset = response.offset;
  assert.strictEqual(socket.response.payload[offset++], 1, "Office state must be present on success");
  assert.strictEqual(socket.response.payload[offset++], 1, "Office common profile must be present on success");
  const commonUid = readSignedVarLong(socket.response.payload, offset);
  assert.strictEqual(commonUid.value, BigInt(userUid), "Office state must belong to the requested user, not the requester");
}

function decodeAckHeader(payload) {
  const error = readSignedVarInt(payload, 0);
  const userUid = readSignedVarLong(payload, error.offset);
  return { errorCode: error.value, userUid: userUid.value, offset: userUid.offset };
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
      assert(result.ok, `managed client schema rejected Office state packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
