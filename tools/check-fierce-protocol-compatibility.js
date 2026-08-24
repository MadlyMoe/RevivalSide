"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  readSignedVarInt,
  writeSignedVarInt,
  writeSignedVarLong,
  writeBool,
  writeIntList,
} = require("../modules/packet-codec");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

process.env.CS_LISTENER_TEST_MODE = "1";
process.env.CS_USE_LOCAL_USER_DB = "1";
const { createPacketContext } = require("../server/listener");
const handlers = new Map(
  require("../modules/misc-stages/handlers/0000-1221-misc-stage-starts")
    .filter((handler) => [844, 846, 848, 850, 852, 857, 3204, 3206].includes(handler.packetId))
    .map((handler) => [handler.packetId, handler])
);

const ROOT = path.resolve(__dirname, "..");
const ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  ALREADY_GOT_REWARD: 20491,
  INVALID_POINT_REWARD_ID: 20496,
  INVALID_BOSS_ID: 20500,
  PROFILE_NOT_EXISTS: 20503,
  NO_MORE_RANK_REWARD: 20508,
  INVALID_LEADERBOARD_BOSS_ID: 20603,
  PENALTY_TYPE: 21036,
  PENALTY_DUPLICATE_GROUP: 21037,
});
const ACK_BY_REQUEST = new Map([[844, 845], [846, 847], [848, 849], [850, 851], [852, 853], [857, 858], [3204, 3205], [3206, 3207]]);

const ctx = createPacketContext();
let response = null;
let saves = 0;
let invalidations = 0;
const managedWire = [];
ctx.config.USE_LOCAL_USER_DB = true;
ctx.decryptCopy = (payload) => payload;
ctx.saveUserDb = () => { saves += 1; };
ctx.invalidateJoinLobbyAckPayloadCache = (reason) => {
  assert.match(String(reason), /^fierce-/);
  invalidations += 1;
};
ctx.sendGameResponse = (_socket, packet, packetId, payload) => {
  response = { packetId, payload };
  managedWire.push([packetId, payload]);
};

const seasonId = Number(ctx.getCurrentFierceSeasonId());
const season = records("LUA_FIERCE_TEMPLET.json").find((row) => Number(row.FierceID) === seasonId);
assert(season, `current Fierce season ${seasonId} must exist in the frozen table`);
const groupIds = Object.keys(season)
  .filter((key) => /^FierceBossGroupID_\d+$/.test(key))
  .map((key) => Number(season[key]))
  .filter((id) => id > 0);
const bosses = records("LUA_FIERCE_BOSS_GROUP_TEMPLET.json").filter((row) => groupIds.includes(Number(row.FierceBossGroupID)));
assert(bosses.length > 0, "current Fierce season must expose table-backed bosses");
const hardBoss = bosses.find((row) => row.UI_HellModeCheck === true && Array.isArray(row.BossPenaltyGroupID) && row.BossPenaltyGroupID.length > 0);
assert(hardBoss, "current Fierce season must expose a penalty-capable hard boss");
const penaltyRows = records("LUA_FIERCE_PENALTY.json").filter((row) => hardBoss.BossPenaltyGroupID.includes(Number(row.BossPenaltyGroupID)));
assert(penaltyRows.length > 1, "hard boss must expose frozen penalty rows");
const firstPenalty = penaltyRows[0];
const sameGroupPenalty = penaltyRows.find((row) => Number(row.PenaltyGroupID) === Number(firstPenalty.PenaltyGroupID) && Number(row.PenaltyID) !== Number(firstPenalty.PenaltyID));
assert(sameGroupPenalty, "penalty table must expose levels in the same exclusive group");
const pointRows = records("LUA_FIERCE_POINT_REWARD.json").filter((row) => Number(row.FiercePointRewardGroupID) === Number(season.PointRewardGroupID));
assert(pointRows.length > 1, "current Fierce season must expose point rewards");

const user = {
  userUid: "986000000000084",
  friendCode: "986000084",
  nickname: "FierceCheck",
  level: 100,
  miscStages: {
    fierce: {
      bosses: {},
      seasons: {
        [String(seasonId)]: { bosses: {}, pointRewardHistory: [] },
      },
    },
  },
};
for (const boss of bosses) {
  const state = { bossId: Number(boss.FierceBossID), point: 100000000, isCleared: true };
  user.miscStages.fierce.bosses[String(boss.FierceBossID)] = state;
  user.miscStages.fierce.seasons[String(seasonId)].bosses[String(boss.FierceBossID)] = state;
}
const socket = { session: { user } };

for (const packetId of handlers.keys()) {
  const before = snapshot(user);
  const malformed = [844, 848, 852].includes(packetId) ? Buffer.from([0]) : Buffer.alloc(0);
  send(packetId, malformed, false);
  assertError(ERRORS.INVALID_REQUEST);
  assert.deepStrictEqual(user, before, `malformed Fierce request ${packetId} must be pure`);
}
assertWrites(0);

send(844, Buffer.alloc(0));
assertError(ERRORS.OK);
send(846, Buffer.concat([writeSignedVarLong(BigInt(user.userUid)), writeBool(false)]));
assertError(ERRORS.OK);
send(846, Buffer.concat([writeSignedVarLong(999999999999n), writeBool(true)]));
assertError(ERRORS.PROFILE_NOT_EXISTS);
assertWrites(0);

send(857, Buffer.concat([writeSignedVarInt(999999999), writeIntList([])]));
assertError(ERRORS.INVALID_BOSS_ID);
send(857, Buffer.concat([writeSignedVarInt(Number(hardBoss.FierceBossID)), writeIntList([999999999])]));
assertError(ERRORS.PENALTY_TYPE);
send(857, Buffer.concat([writeSignedVarInt(Number(hardBoss.FierceBossID)), writeIntList([Number(firstPenalty.PenaltyID), Number(sameGroupPenalty.PenaltyID)])]));
assertError(ERRORS.PENALTY_DUPLICATE_GROUP);
send(857, Buffer.concat([writeSignedVarInt(Number(hardBoss.FierceBossID)), writeIntList([Number(firstPenalty.PenaltyID)])]));
assertError(ERRORS.OK);
assertWrites(1);
send(857, Buffer.concat([writeSignedVarInt(Number(hardBoss.FierceBossID)), writeIntList([Number(firstPenalty.PenaltyID)])]));
assertError(ERRORS.OK);
assertWrites(1);

send(850, writeSignedVarInt(999999999));
assertError(ERRORS.INVALID_POINT_REWARD_ID);
send(850, writeSignedVarInt(Number(pointRows[0].FiercePointRewardID)));
assertError(ERRORS.OK);
assertWrites(2);
send(850, writeSignedVarInt(Number(pointRows[0].FiercePointRewardID)));
assertError(ERRORS.ALREADY_GOT_REWARD);
assertWrites(2);
send(852, Buffer.alloc(0));
assertError(ERRORS.OK);
assertWrites(3);

send(848, Buffer.alloc(0));
assertError(ERRORS.OK);
assertWrites(4);
send(848, Buffer.alloc(0));
assertError(ERRORS.NO_MORE_RANK_REWARD);
assertWrites(4);

send(3204, writeBool(false));
assertError(ERRORS.OK);
send(3206, Buffer.concat([writeSignedVarInt(groupIds[0]), writeBool(true)]));
assertError(ERRORS.OK);
send(3206, Buffer.concat([writeSignedVarInt(999999999), writeBool(false)]));
assertError(ERRORS.INVALID_LEADERBOARD_BOSS_ID);
assertWrites(4);

managedWire.push([854, ctx.buildFierceSeasonNotPayload()]);
const restarted = snapshot(user);
assert.deepStrictEqual(restarted.miscStages.fierce.seasons[String(seasonId)].pointRewardHistory.sort((a, b) => a - b), pointRows.map((row) => Number(row.FiercePointRewardID)).sort((a, b) => a - b));
assert.strictEqual(restarted.miscStages.fierce.seasons[String(seasonId)].isRankRewardGotten, true);
assert.deepStrictEqual(restarted.miscStages.fierce.seasons[String(seasonId)].bosses[String(hardBoss.FierceBossID)].penaltyIds, [Number(firstPenalty.PenaltyID)]);

validateFrozenSources();
validateManagedSchemas();
console.log(`[fierce-protocol-check] PASS season=${seasonId} bosses=${bosses.length} pointRewards=${pointRows.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload, validateRequest = true) {
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  const handler = handlers.get(packetId);
  assert(handler, `handler ${packetId} must exist`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `handler ${packetId} must respond`);
  assert.strictEqual(response.packetId, ACK_BY_REQUEST.get(packetId));
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function records(fileName) {
  return readGameplayTableRecords("ab_script", fileName, { logLabel: "fierce-check" });
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateFrozenSources() {
  const packet = read("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_FIERCE_PENALTY_REQ.cs");
  assert.match(packet, /PutOrGet\(ref this\.fierceBossId\)[\s\S]*PutOrGet\(ref this\.penaltyIds\)/);
  const sender = read("Assembly-CSharp", "NKC", "NKCPacketSender.cs");
  assert.match(sender, /Send_NKMPacket_FIERCE_DATA_REQ\(\)[\s\S]*Send_NKMPacket_FIERCE_PENALTY_REQ/);
  const receiver = read("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
  assert.match(receiver, /OnRecv\(NKMPacket_FIERCE_SEASON_NOT sPacket\)[\s\S]*Init\(sPacket\.fierceId\)/);
  assert.match(read("packet-handlers", "0204-join-lobby-req.js"), /sendFierceSeasonBootstrap/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected Fierce packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
