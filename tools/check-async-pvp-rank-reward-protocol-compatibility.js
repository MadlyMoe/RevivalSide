"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { getMiscItem } = require("../modules/inventory");
const {
  ERRORS,
  PACKETS,
  RANK_TYPES,
  buildNpcPvpData,
  buildPvpStateData,
  claimAsyncSeasonReward,
  claimAsyncWeekReward,
  getActiveAsyncSeason,
  getAsyncPvpState,
  getAsyncRankList,
  getAsyncSeasonById,
  getNpcPvpData,
  getTierByScore,
  getWeekId,
  isWeekCalculationWindow,
  loadCatalog,
  setAsyncPvpState,
  setNpcPvpData,
} = require("../modules/pvp-rank");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeBool,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const now = new Date("2026-08-20T12:00:00Z");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const specialist = "modules\\pvp-rank\\handlers\\0000-000-pvp-rank-rewards.js";
for (const packetId of [PACKETS.ASYNC_RANK_LIST_REQ, PACKETS.ASYNC_SEASON_REWARD_REQ, PACKETS.ASYNC_WEEK_REWARD_REQ]) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `packet ${packetId} must use the PvP rank specialist`);
}

const catalog = loadCatalog();
assert.strictEqual(catalog.asyncSeasons.length, 162, "frozen async-PvP season table count changed");
assert.strictEqual(catalog.tiers.length, 1406, "frozen PvP rank table count changed");
const activeSeason = getActiveAsyncSeason({}, { region: "GLOBAL" }, now);
const previousSeason = getAsyncSeasonById({}, { region: "GLOBAL" }, 36);
assert.deepStrictEqual(
  [activeSeason.seasonId, activeSeason.rankGroup, getWeekId(activeSeason, now)],
  [37, 902, 8],
  "2026-08-20 must resolve the frozen GLOBAL async-PvP season"
);
assert.deepStrictEqual(
  [previousSeason.seasonId, previousSeason.rankGroup],
  [36, 902],
  "previous GLOBAL async-PvP season must be table-driven"
);
assert.strictEqual(catalog.tiersByGroup.get(902).length, 20, "async-PvP rank group tier count changed");

const users = {};
const activeUser = makeUser(1, 6000, 20);
users[activeUser.userUid] = activeUser;
for (let index = 2; index <= 12; index += 1) {
  const peer = makeUser(index, 6100 - index * 100, index === 2 ? 20 : 14);
  users[peer.userUid] = peer;
}
activeUser.community.friends.push(users["2619003"].userUid, users["2619005"].userUid);

const socket = { session: { user: activeUser } };
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  dateTimeBinaryNow: () => 638912880000000000n,
  getServerNowDate: () => now,
  getEffectiveOpenTags: () => ["GLOBAL"],
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(_socket, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};

const rankSnapshot = JSON.stringify(users);
invoke(PACKETS.ASYNC_RANK_LIST_REQ, rankRequest(RANK_TYPES.ALL, false));
let profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.ALL, false);
assert.strictEqual(profiles.length, 10, "initial async rank request must use the frozen simple-rank page size");
assert.deepStrictEqual(profiles.slice(0, 2).map((profile) => profile.nickname), ["AsyncRanker1", "AsyncRanker2"]);

invoke(PACKETS.ASYNC_RANK_LIST_REQ, rankRequest(RANK_TYPES.ALL, true));
profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.ALL, true);
assert.strictEqual(profiles.length, 12, "expanded async rank request must return the local board below the 100-row cap");

invoke(PACKETS.ASYNC_RANK_LIST_REQ, rankRequest(RANK_TYPES.MY_LEAGUE, true));
profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.MY_LEAGUE, true);
assert.deepStrictEqual(profiles.map((profile) => profile.nickname), ["AsyncRanker1", "AsyncRanker2"]);

invoke(PACKETS.ASYNC_RANK_LIST_REQ, rankRequest(RANK_TYPES.FRIEND, true));
profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.FRIEND, true);
assert.deepStrictEqual(profiles.map((profile) => profile.nickname), ["AsyncRanker3", "AsyncRanker5"]);
assert.strictEqual(JSON.stringify(users), rankSnapshot, "async rank list reads must be pure");

rankFailure("truncated enum", Buffer.from([0x80]), ERRORS.INVALID_REQUEST, false);
rankFailure("noncanonical bool", Buffer.concat([writeSignedVarInt(0), Buffer.from([2])]), ERRORS.INVALID_REQUEST, false);
rankFailure("trailing byte", Buffer.concat([rankRequest(0, false), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
rankFailure("invalid enum", rankRequest(3, true), ERRORS.INVALID_RANK_TYPE, true, 3, true);

assertRewardGate("zero season", claimAsyncWeekReward(ctx, withAsync({ seasonId: 0, weekId: 7 }), { now }), ERRORS.SEASON_ID_ZERO);
assertRewardGate("wrong season", claimAsyncWeekReward(ctx, withAsync({ seasonId: 36, weekId: 7 }), { now }), ERRORS.INVALID_SEASON_DATA);
assertRewardGate("zero week", claimAsyncWeekReward(ctx, withAsync({ seasonId: 37, weekId: 0 }), { now }), ERRORS.WEEK_ID_ZERO);
assertRewardGate("duplicate week", claimAsyncWeekReward(ctx, withAsync({ seasonId: 37, weekId: 8 }), { now }), ERRORS.ALREADY_REWARDED_WEEK);
const calcNow = new Date("2026-08-23T23:00:00Z");
assert.strictEqual(isWeekCalculationWindow(activeSeason, calcNow), true, "frozen async calculation window changed");
assertRewardGate("calculation window", claimAsyncWeekReward(ctx, withAsync({ seasonId: 37, weekId: 7 }), { now: calcNow }), ERRORS.END_WEEK);

const weeklyUser = withAsync({ seasonId: 37, weekId: 7, score: 6000, maxScore: 6000, leagueTierId: 15, maxLeagueTierId: 15, rank: 1 });
socket.session.user = weeklyUser;
rewardFailure(PACKETS.ASYNC_WEEK_REWARD_REQ, Buffer.from([0]), ERRORS.INVALID_REQUEST, false);
invoke(PACKETS.ASYNC_WEEK_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.ASYNC_WEEK_REWARD_ACK, ERRORS.OK, true);
assert.strictEqual(getAsyncPvpState(weeklyUser).weekId, 8, "weekly claim must advance the durable async cursor");
assertItem(weeklyUser, 101, 60);
assertItem(weeklyUser, 5, 280);
assertItem(weeklyUser, 2, 4000);
assert.deepStrictEqual([saves, invalidations], [1, 1], "weekly async claim must save and invalidate once");

invoke(PACKETS.ASYNC_WEEK_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.ASYNC_WEEK_REWARD_ACK, ERRORS.ALREADY_REWARDED_WEEK, false);
assert.deepStrictEqual([saves, invalidations], [1, 1], "duplicate weekly async claim must be pure");
assert.deepStrictEqual(
  buildPvpStateData(getAsyncPvpState(JSON.parse(JSON.stringify(weeklyUser)))),
  buildPvpStateData(getAsyncPvpState(weeklyUser)),
  "weekly async state must survive JSON restart"
);

assertRewardGate("wrong previous season", claimAsyncSeasonReward(ctx, withAsync({ seasonId: 35, weekId: 13 }), { now }), ERRORS.INVALID_SEASON_DATA);
assertRewardGate("season calculation window", claimAsyncSeasonReward(ctx, withAsync({ seasonId: 36, weekId: 13 }), { now: calcNow }), ERRORS.END_WEEK);

const seasonUser = withAsync({
  seasonId: 36,
  weekId: 13,
  score: 6000,
  maxScore: 6000,
  leagueTierId: 15,
  maxLeagueTierId: 15,
  rank: 1,
  winCount: 80,
  loseCount: 20,
  seasonPlayCount: 100,
  seasonWinCount: 80,
});
setNpcPvpData(seasonUser, { maxTierCount: 9, maxOpenedTier: 7 });
socket.session.user = seasonUser;
rewardFailure(PACKETS.ASYNC_SEASON_REWARD_REQ, Buffer.from([0]), ERRORS.INVALID_REQUEST, false);
invoke(PACKETS.ASYNC_SEASON_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.ASYNC_SEASON_REWARD_ACK, ERRORS.OK, true);
const rolled = getAsyncPvpState(seasonUser);
assert.deepStrictEqual(
  [rolled.seasonId, rolled.weekId, rolled.score, rolled.maxScore, rolled.leagueTierId, rolled.rank],
  [37, 0, 3200, 3200, 14, 0],
  "async season claim must apply the frozen score reset and clear season counters"
);
assert.deepStrictEqual(getNpcPvpData(seasonUser), { maxTierCount: 0, maxOpenedTier: 0 }, "async season rollover must reset NPC progression");
assertItem(seasonUser, 101, 240);
assertItem(seasonUser, 14, 17);
assert.deepStrictEqual([saves, invalidations], [2, 2], "season async claim must save and invalidate once");

invoke(PACKETS.ASYNC_SEASON_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.ASYNC_SEASON_REWARD_ACK, ERRORS.INVALID_SEASON_DATA, false);
assert.deepStrictEqual([saves, invalidations], [2, 2], "duplicate async season claim must be pure");
const restartedSeason = JSON.parse(JSON.stringify(seasonUser));
assert.deepStrictEqual(buildPvpStateData(getAsyncPvpState(restartedSeason)), buildPvpStateData(getAsyncPvpState(seasonUser)));
assert.deepStrictEqual(buildNpcPvpData(getNpcPvpData(restartedSeason)), buildNpcPvpData(getNpcPvpData(seasonUser)));
assert.strictEqual(getTierByScore(activeSeason.rankGroup, rolled.score).leagueTier, rolled.leagueTierId);

assertJoinOverlaySource();
validateManagedSchemas();
console.log(`[async-pvp-rank-reward-check] PASS seasons=${catalog.asyncSeasons.length} tiers=${catalog.tiers.length} saves=${saves} packets=${managedWire.length} managed=on`);

function makeUser(index, score, tier) {
  const user = {
    userUid: String(2619000 + index),
    friendCode: String(26100000 + index),
    nickname: `AsyncRanker${index}`,
    level: 100,
    mainUnitId: 1001,
    mainUnitSkinId: 0,
    frameId: 0,
    mainUnitTacticLevel: 0,
    titleId: 0,
    region: "GLOBAL",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    community: { friends: [], blocked: [] },
  };
  setAsyncPvpState(user, { seasonId: 37, weekId: 7, score, maxScore: score, leagueTierId: tier, maxLeagueTierId: tier, rankOpen: true });
  return user;
}

function withAsync(overrides) {
  const user = makeUser(99, 1000, 7);
  setAsyncPvpState(user, { ...getAsyncPvpState(user), ...overrides, rankOpen: true });
  return user;
}

function rankRequest(rankType, isAll) {
  return Buffer.concat([writeSignedVarInt(rankType), writeBool(isAll)]);
}

function invoke(packetId, payload, validateRequest = true) {
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `packet ${packetId} must respond`);
}

function rankFailure(label, payload, errorCode, validateRequest, rankType = 0, isAll = false) {
  const before = JSON.stringify(socket.session.user);
  const beforeSaves = saves;
  invoke(PACKETS.ASYNC_RANK_LIST_REQ, payload, validateRequest);
  assert.deepStrictEqual(decodeRankListAck(errorCode, rankType, isAll), [], `${label} must return no profiles`);
  assert.strictEqual(JSON.stringify(socket.session.user), before, `${label} must not mutate state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
}

function rewardFailure(packetId, payload, errorCode, validateRequest) {
  const before = JSON.stringify(socket.session.user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, payload, validateRequest);
  assertRewardAck(packetId + 1, errorCode, false);
  assert.strictEqual(JSON.stringify(socket.session.user), before, `failed ${packetId} must not mutate state`);
  assert.strictEqual(saves, beforeSaves, `failed ${packetId} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `failed ${packetId} must not invalidate JOIN`);
}

function decodeRankListAck(errorCode, rankType, isAll) {
  assert.strictEqual(response.packetId, PACKETS.ASYNC_RANK_LIST_ACK);
  let field = readSignedVarInt(response.payload, 0);
  assert.strictEqual(field.value, errorCode, "async rank ACK errorCode");
  field = readSignedVarInt(response.payload, field.offset);
  assert.strictEqual(field.value, rankType, "async rank ACK rankType");
  const all = readBool(response.payload, field.offset);
  assert.strictEqual(all.value, isAll, "async rank ACK isAll echo");
  const count = readUnsignedVarInt(response.payload, all.offset);
  let offset = count.offset;
  const profiles = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(response.payload, offset);
    assert.strictEqual(present.value, true, "async rank profile entries must be non-null");
    field = readSignedVarLong(response.payload, present.offset);
    const userUid = field.value;
    field = readSignedVarLong(response.payload, field.offset);
    const friendCode = field.value;
    const nickname = readString(response.payload, field.offset);
    offset = nickname.offset;
    const ints = [];
    for (let fieldIndex = 0; fieldIndex < 8; fieldIndex += 1) {
      const value = readSignedVarInt(response.payload, offset);
      ints.push(value.value);
      offset = value.offset;
    }
    const guildPresent = readBool(response.payload, offset);
    assert.strictEqual(guildPresent.value, true, "async rank guild data must be non-null");
    field = readSignedVarLong(response.payload, guildPresent.offset);
    const guildName = readString(response.payload, field.offset);
    field = readSignedVarLong(response.payload, guildName.offset);
    offset = field.offset + 8;
    profiles.push({ userUid, friendCode, nickname: nickname.value, score: ints[6], tier: ints[7] });
  }
  assert.strictEqual(offset, response.payload.length, "async rank ACK must have exact framing");
  return profiles;
}

function assertRewardAck(packetId, errorCode, success) {
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode, `async reward ACK ${packetId} errorCode`);
  const rewardPresent = readBool(response.payload, error.offset);
  assert.strictEqual(rewardPresent.value, success, `async reward ACK ${packetId} reward nullability`);
  if (success) return;
  if (packetId === PACKETS.ASYNC_WEEK_REWARD_ACK) {
    const weekId = readSignedVarInt(response.payload, rewardPresent.offset);
    assert.strictEqual(weekId.value, 0);
    assert.strictEqual(weekId.offset, response.payload.length, "failed async week ACK exact framing");
    return;
  }
  const pvpState = readBool(response.payload, rewardPresent.offset);
  const npcData = readBool(response.payload, pvpState.offset);
  assert.strictEqual(pvpState.value, false);
  assert.strictEqual(npcData.value, false);
  assert.strictEqual(npcData.offset, response.payload.length, "failed async season ACK exact framing");
}

function assertRewardGate(label, result, errorCode) {
  assert.strictEqual(result.errorCode, errorCode, label);
  assert.strictEqual(result.changed, false, `${label} must be pure`);
  assert.strictEqual(result.reward, null, `${label} must not expose rewards`);
}

function assertItem(user, itemId, count) {
  const item = getMiscItem(user, itemId);
  assert(item, `missing reward item ${itemId}`);
  assert.strictEqual(String(item.countFree), String(count), `reward item ${itemId}`);
}

function readUnsignedVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length && shift <= 28) {
    const byte = buffer[cursor++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset: cursor };
    shift += 7;
  }
  throw new Error("invalid unsigned varint");
}

function assertJoinOverlaySource() {
  const listener = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
  assert.match(listener, /writeNullableObject\(pvpRank\.buildPvpStateData\(pvpRank\.getAsyncPvpState\(user\)\)\), \/\/ asyncPvpState/);
  assert.match(listener, /writeNullableObject\(pvpRank\.buildNpcPvpData\(pvpRank\.getNpcPvpData\(user\)\)\)/);
  assert.match(listener, /overlayLocalAsyncPvpData: pvpRank\.hasAsyncPvpState\(user\)/);

  const handler = fs.readFileSync(path.join(rootDir, "combat-handler", "index.js"), "utf8");
  assert.match(handler, /overlayLocalAsyncPvpData: Boolean\(options\.overlayLocalAsyncPvpData\)/);
  const protocol = fs.readFileSync(path.join(rootDir, "combat-host", "Protocol.cs"), "utf8");
  assert.match(protocol, /public bool OverlayLocalAsyncPvpData \{ get; set; \}/);
  const bridge = fs.readFileSync(path.join(rootDir, "combat-host", "ManagedCombatBridge.cs"), "utf8");
  const staticFields = /LocalJoinLobbyFields\s*=\s*\[([\s\S]*?)\];/.exec(bridge);
  assert(staticFields && !staticFields[1].includes("asyncPvpState") && !staticFields[1].includes("npcPvpData"), "official async state must not be overwritten unconditionally");
  assert.match(bridge, /if \(data\.OverlayLocalAsyncPvpData\)[\s\S]*?"asyncPvpState"[\s\S]*?"npcPvpData"/);
  assert.match(bridge, /CopyField\(runtime, local, normalized, "asyncPvpState"\);[\s\S]*?CopyField\(runtime, local, normalized, "npcPvpData"\);/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for async-PvP schema validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected async-PvP packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
