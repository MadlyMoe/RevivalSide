"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const ROOT = path.resolve(__dirname, "..");
const FIXED_NOW = 638500000000000000n;
const TICKS_PER_DAY = 864000000000n;
const RAID_UID = 986000000002200n;
const FOREIGN_RAID_UID = RAID_UID + 1n;
const RESULT_RAID_UID = RAID_UID + 10n;
const ERRORS = Object.freeze({
  OK: 0,
  RAID_NOT_EXIST: 398,
  RAID_HAS_BEEN_DEFEATED: 399,
  RAID_NOT_ENDED: 404,
  RAID_NOT_OWNER: 405,
  ALREADY_REWARDED: 407,
  NOT_ENOUGH_RAID_POINT: 408,
  NO_REWARD_TEMPLET: 409,
  INVALID_REQUEST: 20191,
});

const seasonRows = readGameplayTableRecords("ab_script", "LUA_RAID_SEASON_TEMPLET.json", { logLabel: "raid-lifecycle-check" });
const rewardRows = readGameplayTableRecords("ab_script", "LUA_RAID_SEASON_REWARD_TEMPLET.json", { logLabel: "raid-lifecycle-check" });
const extraRow = rewardRows.find((row) => Number(row.ExtraReward_ID) > 0 && Number(row.ExtraReward_Point) > 0);
assert(extraRow, "frozen Raid season rewards must contain an extra reward");
const seasonRow = seasonRows.find((row) => Number(row.Reward_Board_ID) === Number(extraRow.Reward_Board_ID));
assert(seasonRow, "frozen Raid season table must own the extra-reward board");
process.env.CS_RAID_SEASON_ID = String(seasonRow.Raid_Season_ID);

const {
  createWorldMapHandlers,
  ensureWorldMapState,
  buildRaidSeasonNotPayload,
  getRaidSeasonRewardRows,
  sendRaidSnapshotData,
} = require("../modules/world-map");
const { ensureArmy } = require("../modules/unit");
const { getMiscItem, toBigInt } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const raidTemplet = readGameplayTableRecords("ab_script", "LUA_RAID_TEMPLET.json", { logLabel: "raid-lifecycle-check" })
  .find((row) => Number(row.m_StageID) > 0);
assert(raidTemplet, "frozen Raid table must expose a stage");

const handlers = new Map(createWorldMapHandlers().map((entry) => [entry.packetId, entry]));
for (const packetId of [2200, 2202, 2204, 2206, 2208, 2210, 2212, 2214, 2217, 2219]) {
  assert(handlers.has(packetId), `Raid specialist missing packet ${packetId}`);
}

const user = {
  userUid: "986000000000085",
  friendCode: "986000085",
  nickname: "RaidLifecycleCheck",
  level: 100,
};
ensureArmy(user);
ensureWorldMapState(user, { now: FIXED_NOW });
seedActiveRaid(RAID_UID, user.userUid, false);
seedActiveRaid(FOREIGN_RAID_UID, "986000000009999", false);
worldMapState().raidSeason = {
  seasonId: Number(seasonRow.Raid_Season_ID),
  monthlyPoint: 0,
  tryAssistCount: 0,
  recvRewardRaidPoint: 0,
  highestDamage: 0,
  latestUpdateTime: String(FIXED_NOW),
};

const socket = { session: { user } };
let response = null;
let pushes = [];
let saves = 0;
let invalidations = 0;
const managedWire = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => FIXED_NOW,
  decryptCopy: (payload) => payload,
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_socket, _sequence, _packetId, build) {
    build();
  },
  sendServerGamePacket(_socket, packetId, payload) {
    pushes.push({ packetId, payload });
    managedWire.push([packetId, payload]);
  },
  saveUserDb() {
    saves += 1;
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.match(reason, /^raid-\d+$/);
    invalidations += 1;
  },
  trackMissionEvent() {
    return false;
  },
};

verifyStrictFraming();
verifyReadOnlyLists();
verifyCoopLifecycle();
verifyResultLifecycle();
verifySeasonRewards();
verifySeasonPush();
verifyRestart();
validateFrozenSources();
validateManagedSchemas();

console.log(
  `[raid-lifecycle-check] PASS seasons=${seasonRows.length} rewardRows=${rewardRows.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  for (const packetId of [2200, 2202, 2206, 2210, 2214, 2219]) {
    expectPureError(packetId, Buffer.from([0]), ERRORS.INVALID_REQUEST);
  }
  for (const packetId of [2204, 2208, 2212]) {
    expectPureError(packetId, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
    expectPureError(packetId, Buffer.concat([writeSignedVarLong(RAID_UID), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
  }
  expectPureError(2217, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
  expectPureError(2217, Buffer.concat([writeSignedVarInt(1), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
  assertWrites(0);
}

function verifyReadOnlyLists() {
  for (const [packetId, payload, ackId] of [
    [2200, Buffer.alloc(0), 2201],
    [2202, Buffer.alloc(0), 2203],
    [2208, writeSignedVarLong(RAID_UID), 2209],
    [2210, Buffer.alloc(0), 2211],
  ]) {
    const before = snapshot(user);
    send(packetId, payload);
    assert.strictEqual(response.packetId, ackId);
    assertError(ERRORS.OK);
    assert.deepStrictEqual(user, before, `read-only Raid packet ${packetId} mutated state`);
    assert.strictEqual(pushes.length, 0, `Raid packet ${packetId} emitted an unsolicited push`);
  }
  expectPureError(2208, writeSignedVarLong(RAID_UID + 999n), ERRORS.RAID_NOT_EXIST);
  assertWrites(0);
}

function verifyCoopLifecycle() {
  expectPureError(2204, writeSignedVarLong(RAID_UID + 999n), ERRORS.RAID_NOT_EXIST);
  expectPureError(2204, writeSignedVarLong(FOREIGN_RAID_UID), ERRORS.RAID_NOT_OWNER);

  send(2204, writeSignedVarLong(RAID_UID));
  assertError(ERRORS.OK);
  assert.strictEqual(worldMapState().raids[String(RAID_UID)].isCoop, true);
  assert.strictEqual(pushes.length, 0, "RAID_SET_COOP must not emit undocumented follow-up packets");
  assertWrites(1);

  send(2204, writeSignedVarLong(RAID_UID));
  assertError(ERRORS.OK);
  assertWrites(1);

  const secondOwned = RAID_UID + 2n;
  seedActiveRaid(secondOwned, user.userUid, false);
  send(2206, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assert.strictEqual(worldMapState().raids[String(secondOwned)].isCoop, true);
  assert.strictEqual(worldMapState().raids[String(FOREIGN_RAID_UID)].isCoop, false);
  assertWrites(2);

  send(2206, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assertWrites(2);
}

function verifyResultLifecycle() {
  expectPureError(2212, writeSignedVarLong(RAID_UID + 999n), ERRORS.RAID_NOT_EXIST);
  expectPureError(2212, writeSignedVarLong(RAID_UID), ERRORS.RAID_NOT_ENDED);

  seedResultRaid(RESULT_RAID_UID);
  send(2210, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assertWrites(2);

  const monthlyBefore = worldMapState().raidSeason.monthlyPoint;
  send(2212, writeSignedVarLong(RESULT_RAID_UID));
  assertError(ERRORS.OK);
  assert(!worldMapState().raidResults[String(RESULT_RAID_UID)], "accepted Raid result must be removed");
  assert(worldMapState().raidSeason.monthlyPoint > monthlyBefore, "accepted Raid result must add exact table Raid points");
  assertWrites(3);

  expectPureError(2212, writeSignedVarLong(RESULT_RAID_UID), ERRORS.RAID_NOT_EXIST);
  seedResultRaid(RESULT_RAID_UID + 1n);
  seedResultRaid(RESULT_RAID_UID + 2n);
  send(2214, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assert(!worldMapState().raidResults[String(RESULT_RAID_UID + 1n)]);
  assert(!worldMapState().raidResults[String(RESULT_RAID_UID + 2n)]);
  assertWrites(4);

  send(2214, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assertWrites(4);
}

function verifySeasonRewards() {
  const rows = getRaidSeasonRewardRows(Number(seasonRow.Raid_Season_ID));
  assert(rows.length > 1, "selected frozen Raid reward board must contain point rows");
  const maxPoint = Math.max(...rows.map((row) => Number(row.Raid_Point) || 0));
  const extraPoint = Number(extraRow.ExtraReward_Point);
  const validPoint = Number(rows.find((row) => Number(row.Raid_Point) > 1).Raid_Point);

  worldMapState().raidSeason.recvRewardRaidPoint = 0;
  worldMapState().raidSeason.monthlyPoint = validPoint - 1;
  expectPureError(2217, writeSignedVarInt(validPoint), ERRORS.NOT_ENOUGH_RAID_POINT);
  expectPureError(2217, writeSignedVarInt(maxPoint + 1), ERRORS.NO_REWARD_TEMPLET);

  worldMapState().raidSeason.monthlyPoint = maxPoint + extraPoint * 2;
  send(2217, writeSignedVarInt(maxPoint));
  assertError(ERRORS.OK);
  assert.strictEqual(worldMapState().raidSeason.recvRewardRaidPoint, maxPoint);
  assertWrites(5);

  expectPureError(2217, writeSignedVarInt(maxPoint), ERRORS.ALREADY_REWARDED);

  const extraItemId = Number(extraRow.ExtraReward_ID);
  const before = miscCount(extraItemId);
  send(2219, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assert.strictEqual(worldMapState().raidSeason.recvRewardRaidPoint, maxPoint + extraPoint);
  assert.strictEqual(miscCount(extraItemId) - before, BigInt(Number(extraRow.ExtraReward_Value)));
  assertWrites(6);

  send(2219, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assert.strictEqual(worldMapState().raidSeason.recvRewardRaidPoint, maxPoint + extraPoint * 2);
  assertWrites(7);

  expectPureError(2219, Buffer.alloc(0), ERRORS.NOT_ENOUGH_RAID_POINT);
}

function verifySeasonPush() {
  const payload = buildRaidSeasonNotPayload(user, { now: FIXED_NOW });
  assert.strictEqual(payload.readUInt8(0), 1, "RAID_SEASON_NOT must serialize a non-null Raid season");
  managedWire.push([2216, payload]);

  const snapshotPushes = [];
  sendRaidSnapshotData(
    {
      config: { USE_LOCAL_USER_DB: false },
      sendServerGamePacket(_socket, packetId, packetPayload) {
        snapshotPushes.push(packetId);
        managedWire.push([packetId, packetPayload]);
      },
    },
    socket,
    user,
    { now: FIXED_NOW, includeSeason: true, includeWorldMap: false, includeEmpty: true, persist: false }
  );
  assert.strictEqual(snapshotPushes[0], 2216);
  assert(snapshotPushes.includes(2201) && snapshotPushes.includes(2203) && snapshotPushes.includes(2211));
  const joinSource = read("packet-handlers", "0204-join-lobby-req.js");
  assert.match(joinSource, /sendRaidSnapshotData[\s\S]*includeSeason:\s*true[\s\S]*persist:\s*false/);
}

function verifyRestart() {
  const restarted = snapshot(user);
  assert.strictEqual(restarted.worldMap.raidSeason.seasonId, Number(seasonRow.Raid_Season_ID));
  assert.strictEqual(restarted.worldMap.raidSeason.recvRewardRaidPoint, worldMapState().raidSeason.recvRewardRaidPoint);
  assert.strictEqual(miscCountFrom(restarted, Number(extraRow.ExtraReward_ID)), miscCount(Number(extraRow.ExtraReward_ID)));
}

function seedActiveRaid(raidUID, ownerUserUid, isCoop) {
  worldMapState().raids[String(raidUID)] = makeRaid(raidUID, ownerUserUid, {
    curHP: 100000,
    maxHP: 100000,
    isCoop,
  });
}

function seedResultRaid(raidUID) {
  worldMapState().raidResults[String(raidUID)] = makeRaid(raidUID, user.userUid, {
    curHP: 0,
    maxHP: 100000,
    damage: 100000,
    isCoop: true,
    win: true,
  });
}

function worldMapState() {
  return user.worldMap;
}

function makeRaid(raidUID, ownerUserUid, overrides = {}) {
  return {
    raidUID: String(raidUID),
    stageID: Number(raidTemplet.m_StageID),
    cityID: 1,
    curHP: 100000,
    maxHP: 100000,
    isCoop: false,
    isNew: false,
    expireDate: String((FIXED_NOW & 0x3fffffffffffffffn) + TICKS_PER_DAY),
    seasonID: Number(seasonRow.Raid_Season_ID),
    ownerUserUid: String(ownerUserUid),
    ownerFriendCode: user.friendCode,
    tryCount: 1,
    accepted: false,
    ...overrides,
  };
}

function send(packetId, payload, validateRequest = true) {
  response = null;
  pushes = [];
  if (validateRequest) managedWire.push([packetId, payload]);
  const handler = handlers.get(packetId);
  assert(handler, `missing Raid handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `Raid packet ${packetId} must respond`);
  return response;
}

function expectPureError(packetId, payload, errorCode) {
  const before = snapshot(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  send(packetId, payload, false);
  assertError(errorCode);
  assert.deepStrictEqual(user, before, `failed Raid packet ${packetId} mutated state`);
  assert.strictEqual(saves, beforeSaves, `failed Raid packet ${packetId} saved state`);
  assert.strictEqual(invalidations, beforeInvalidations, `failed Raid packet ${packetId} invalidated JOIN`);
  assert.strictEqual(pushes.length, 0, `failed Raid packet ${packetId} emitted a push`);
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function miscCount(itemId) {
  return miscCountFrom(user, itemId);
}

function miscCountFrom(owner, itemId) {
  const item = getMiscItem(owner, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateFrozenSources() {
  assert.match(read("Assembly-CSharp", "ClientPacket", "Raid", "NKMPacket_RAID_SEASON_NOT.cs"), /PutOrGet<NKMRaidSeason>\(ref this\.raidSeason\)/);
  assert.match(read("Assembly-CSharp", "ClientPacket", "Raid", "NKMPacket_RAID_POINT_REWARD_REQ.cs"), /PutOrGet\(ref this\.raidPointReward\)/);
  assert.match(read("Assembly-CSharp", "ClientPacket", "Raid", "NKMPacket_RAID_POINT_EXTRA_REWARD_REQ.cs"), /Serialize\(IPacketStream stream\)\s*\{\s*\}/);
  assert.match(read("Assembly-CSharp", "NKC", "UI", "Worldmap", "NKCPopupWorldMapEventList.cs"), /recvRewardRaidPoint[\s\S]*monthlyPoint[\s\S]*Send_NKMPacket_RAID_POINT_REWARD_REQ/);
  assert.match(read("Assembly-CSharp", "NKC", "UI", "NKCAlarmManager.cs"), /ExtraRewardPoint[\s\S]*monthlyPoint - NKCRaidSeasonManager\.RaidSeason\.recvRewardRaidPoint/);
  assert.match(read("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_ALREADY_GET_RAID_POINT_REWARD[\s\S]*NEC_FAIL_NOT_ENOUGH_RAID_POINT[\s\S]*NEC_FAIL_NOT_EXIST_RAID_POINT_REWARD_TEMPLET/);
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
      assert(result.ok, `managed schema rejected Raid packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
