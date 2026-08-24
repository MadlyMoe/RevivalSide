"use strict";

const assert = require("assert");
const path = require("path");
const { buildOfficeGuestListNotData, getOfficeGuestProfiles } = require("../modules/office");
const { sendOfficeGuestListBootstrap } = require("../packet-handlers/0204-join-lobby-req");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const self = makeUser("9880000000003636", "Office Owner", true);
const users = { self };
for (let index = 1; index <= 5; index += 1) {
  const user = makeUser(String(9880000000003636n + BigInt(index)), `Guest ${index}`, true);
  users[`guest${6 - index}`] = user;
}
users.noOffice = makeUser("9880000000003699", "No Office", false);
const ctx = {
  userDb: { users },
  sendServerGamePacket(_socket, packetId, payload, label) {
    packets.push([packetId, payload]);
    assert.strictEqual(packetId, 3636);
    assert.strictEqual(label, "join-lobby-office-guest-list");
  },
  saveUserDb() { throw new Error("Office guest-list bootstrap must not save"); },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("Office guest-list bootstrap must not invalidate JOIN"); },
};
const socket = { session: { user: self } };
const packets = [];
const before = JSON.stringify(users);

const guests = getOfficeGuestProfiles(ctx, self, 4);
assert.deepStrictEqual(guests.map((entry) => entry.nickname), ["Guest 1", "Guest 2", "Guest 3", "Guest 4"]);
assert.strictEqual(guests.includes(self), false);
assert.strictEqual(guests.includes(users.noOffice), false);

sendOfficeGuestListBootstrap(ctx, socket);
assert.strictEqual(packets.length, 1);
assert.strictEqual(packets[0][1][0], 4, "the frozen nullable profile list must contain four guests");
assert.deepStrictEqual(
  packets[0][1],
  buildOfficeGuestListNotData(guests.map((entry) => structuredClone(entry))),
  "JOIN must publish the deterministic authoritative guest set"
);
assert.strictEqual(JSON.stringify(users), before, "guest serialization must not normalize stored profiles");

ctx.userDb.users = { self };
sendOfficeGuestListBootstrap(ctx, socket);
assert.deepStrictEqual(packets[1][1], Buffer.from([0]), "an empty local population must publish a non-null empty list");

validateManagedSchemas();
console.log(`[office-guest-list-protocol-check] PASS guests=${guests.length} packets=${packets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname, hasOffice) {
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
    for (const [packetId, payload] of packets) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Office guest-list packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
