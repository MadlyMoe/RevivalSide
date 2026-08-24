"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { getMiscItem, getSkinIds } = require("../modules/inventory");
const {
  ERRORS,
  PACKETS,
  RANK_TYPES,
  buildPvpStateData,
  claimSeasonReward,
  claimWeekReward,
  getActiveSeason,
  getPvpRankState,
  getRankList,
  getSeasonById,
  getTierByScore,
  getWeekId,
  isWeekCalculationWindow,
  loadCatalog,
  setPvpRankState,
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
assert.deepStrictEqual(
  ERRORS,
  {
    OK: 0,
    INVALID_RANK_TYPE: 337,
    INVALID_SEASON_DATA: 338,
    END_WEEK: 350,
    ALREADY_REWARDED_WEEK: 351,
    ALREADY_REWARDED_SEASON: 352,
    SEASON_ID_ZERO: 443,
    WEEK_ID_ZERO: 444,
    INVALID_REQUEST: 20191,
  },
  "frozen PvP reward error enum values changed"
);
for (const packetId of [PACKETS.RANK_LIST_REQ, PACKETS.WEEK_REWARD_REQ, PACKETS.SEASON_REWARD_REQ]) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `packet ${packetId} must use the PvP rank specialist`);
}

const catalog = loadCatalog();
assert.strictEqual(catalog.seasons.length, 170, "frozen PvP season table count changed");
assert.strictEqual(catalog.tiers.length, 1406, "frozen PvP rank table count changed");
assert.strictEqual(catalog.seasonRewards.length, 108, "frozen PvP season reward table count changed");
const activeSeason = getActiveSeason({}, { region: "GLOBAL" }, now);
const previousSeason = getSeasonById({}, { region: "GLOBAL" }, 36);
assert.deepStrictEqual(
  [activeSeason.seasonId, activeSeason.rankGroup, activeSeason.seasonRewardGroup, getWeekId(activeSeason, now)],
  [37, 1016, 111, 8],
  "2026-08-20 must resolve the frozen GLOBAL rank season"
);
assert.deepStrictEqual(
  [previousSeason.seasonId, previousSeason.rankGroup, previousSeason.seasonRewardGroup],
  [36, 1015, 110],
  "previous GLOBAL season must be table-driven"
);
assert.strictEqual(catalog.tiersByGroup.get(1016).length, 37, "active rank group tier count changed");

const users = {};
const activeUser = makeUser(1, 6000, 37);
users[activeUser.userUid] = activeUser;
for (let index = 2; index <= 12; index += 1) {
  const peer = makeUser(index, 6100 - index * 100, index === 2 ? 37 : 28);
  users[peer.userUid] = peer;
}
activeUser.community.friends.push(users["2606003"].userUid, users["2606005"].userUid);

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
invoke(PACKETS.RANK_LIST_REQ, rankRequest(RANK_TYPES.ALL, false));
let profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.ALL);
assert.strictEqual(profiles.length, 10, "initial all-rank request must use the frozen simple-rank page size");
assert.strictEqual(profiles[0].nickname, "Ranker1", "rank list must sort score descending");
assert.strictEqual(profiles[0].score, 6000);
assert.strictEqual(profiles[1].nickname, "Ranker2", "equal score ties must sort userUid ascending");

invoke(PACKETS.RANK_LIST_REQ, rankRequest(RANK_TYPES.ALL, true));
profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.ALL);
assert.strictEqual(profiles.length, 12, "all-rank expansion must return the complete local board below the 100-row cap");

invoke(PACKETS.RANK_LIST_REQ, rankRequest(RANK_TYPES.MY_LEAGUE, true));
profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.MY_LEAGUE);
assert.deepStrictEqual(profiles.map((profile) => profile.nickname), ["Ranker1", "Ranker2"]);

invoke(PACKETS.RANK_LIST_REQ, rankRequest(RANK_TYPES.FRIEND, true));
profiles = decodeRankListAck(ERRORS.OK, RANK_TYPES.FRIEND);
assert.deepStrictEqual(profiles.map((profile) => profile.nickname), ["Ranker3", "Ranker5"]);
assert.strictEqual(JSON.stringify(users), rankSnapshot, "rank list reads must be pure");

rankFailure("truncated rank enum", Buffer.from([0x80]), ERRORS.INVALID_REQUEST, false);
rankFailure("noncanonical rank bool", Buffer.concat([writeSignedVarInt(0), Buffer.from([2])]), ERRORS.INVALID_REQUEST, false);
rankFailure("trailing rank byte", Buffer.concat([rankRequest(0, false), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
rankFailure("invalid rank enum", rankRequest(3, false), ERRORS.INVALID_RANK_TYPE, true, 3);

assertRewardGate(
  "zero season",
  claimWeekReward(ctx, withRank({ seasonId: 0, weekId: 7 }), { now }),
  ERRORS.SEASON_ID_ZERO
);
assertRewardGate(
  "wrong season",
  claimWeekReward(ctx, withRank({ seasonId: 36, weekId: 7 }), { now }),
  ERRORS.INVALID_SEASON_DATA
);
assertRewardGate(
  "zero week",
  claimWeekReward(ctx, withRank({ seasonId: 37, weekId: 0 }), { now }),
  ERRORS.WEEK_ID_ZERO
);
assertRewardGate(
  "duplicate week",
  claimWeekReward(ctx, withRank({ seasonId: 37, weekId: 8 }), { now }),
  ERRORS.ALREADY_REWARDED_WEEK
);
const calcNow = new Date("2026-08-23T23:00:00Z");
assert.strictEqual(isWeekCalculationWindow(activeSeason, calcNow), true, "frozen Sunday 22:00-Monday 04:00 calculation window changed");
assertRewardGate(
  "weekly calculation window",
  claimWeekReward(ctx, withRank({ seasonId: 37, weekId: 7 }), { now: calcNow }),
  ERRORS.END_WEEK
);

const weeklyUser = withRank({ seasonId: 37, weekId: 7, score: 6000, maxScore: 6000, leagueTierId: 36, maxLeagueTierId: 36, rank: 1 });
socket.session.user = weeklyUser;
rewardFailure(PACKETS.WEEK_REWARD_REQ, Buffer.from([0]), ERRORS.INVALID_REQUEST, false);
invoke(PACKETS.WEEK_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.WEEK_REWARD_ACK, ERRORS.OK, true);
assert.strictEqual(getPvpRankState(weeklyUser).weekId, 8, "weekly claim must advance the persisted reward cursor");
assertItem(weeklyUser, 101, 350);
assertItem(weeklyUser, 5, 1400);
assertItem(weeklyUser, 2, 17200);
assert.deepStrictEqual([saves, invalidations], [1, 1], "weekly claim must save and invalidate JOIN once");

invoke(PACKETS.WEEK_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.WEEK_REWARD_ACK, ERRORS.ALREADY_REWARDED_WEEK, false);
assert.deepStrictEqual([saves, invalidations], [1, 1], "duplicate weekly claim must be pure");

const restartedWeekly = JSON.parse(JSON.stringify(weeklyUser));
assert.deepStrictEqual(
  buildPvpStateData(getPvpRankState(restartedWeekly)),
  buildPvpStateData(getPvpRankState(weeklyUser)),
  "weekly PvP state must survive JSON restart"
);

assertRewardGate(
  "wrong previous season",
  claimSeasonReward(ctx, withRank({ seasonId: 35, weekId: 13 }), { now }),
  ERRORS.INVALID_SEASON_DATA
);
assertRewardGate(
  "season calculation window",
  claimSeasonReward(ctx, withRank({ seasonId: 36, weekId: 13 }), { now: calcNow }),
  ERRORS.END_WEEK
);

const seasonUser = withRank({
  seasonId: 36,
  weekId: 13,
  score: 6000,
  maxScore: 6000,
  leagueTierId: 36,
  maxLeagueTierId: 36,
  rank: 1,
  winCount: 80,
  loseCount: 20,
  seasonPlayCount: 100,
  seasonWinCount: 80,
});
socket.session.user = seasonUser;
rewardFailure(PACKETS.SEASON_REWARD_REQ, Buffer.from([0]), ERRORS.INVALID_REQUEST, false);
invoke(PACKETS.SEASON_REWARD_REQ, Buffer.alloc(0));
assertRewardAck(PACKETS.SEASON_REWARD_ACK, ERRORS.OK, true);
const rolled = getPvpRankState(seasonUser);
assert.deepStrictEqual(
  [rolled.seasonId, rolled.weekId, rolled.score, rolled.maxScore, rolled.leagueTierId, rolled.rank],
  [37, 0, 4400, 4400, 28, 0],
  "season claim must apply the frozen demotion point and reset season counters"
);
assertItem(seasonUser, 101, 740);
assertItem(seasonUser, 1035, 95);
assertItem(seasonUser, 2000297, 1);
assertItem(seasonUser, 14, 100);
assertItem(seasonUser, 1500392, 1);
assert(getSkinIds(seasonUser).includes(130630), "tier 37 season skin must be granted exactly");
assert.deepStrictEqual([saves, invalidations], [2, 2], "season claim must save and invalidate JOIN once");

const restartedSeason = JSON.parse(JSON.stringify(seasonUser));
assert.deepStrictEqual(
  buildPvpStateData(getPvpRankState(restartedSeason)),
  buildPvpStateData(getPvpRankState(seasonUser)),
  "rolled season state must survive JSON restart"
);

assertJoinOverlaySource();
validateManagedSchemas();
console.log(
  `[pvp-rank-reward-check] PASS seasons=${catalog.seasons.length} tiers=${catalog.tiers.length} seasonRewards=${catalog.seasonRewards.length} saves=${saves} packets=${managedWire.length} managed=on`
);

function makeUser(index, score, tier) {
  const user = {
    userUid: String(2606000 + index),
    friendCode: String(26000000 + index),
    nickname: `Ranker${index}`,
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
  setPvpRankState(user, {
    seasonId: 37,
    weekId: 7,
    score,
    maxScore: score,
    leagueTierId: tier,
    maxLeagueTierId: tier,
    rankOpen: true,
  });
  return user;
}

function withRank(overrides) {
  const user = makeUser(99, 1000, 7);
  setPvpRankState(user, { ...getPvpRankState(user), ...overrides, rankOpen: true });
  return user;
}

function rankRequest(rankType, isAll) {
  return Buffer.concat([writeSignedVarInt(rankType), writeBool(isAll)]);
}

function invoke(packetId, payload, managedRequest = true) {
  response = null;
  if (managedRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `packet ${packetId} must respond`);
}

function rankFailure(label, payload, errorCode, managedRequest, rankType = 0) {
  const before = JSON.stringify(socket.session.user);
  const beforeSaves = saves;
  invoke(PACKETS.RANK_LIST_REQ, payload, managedRequest);
  const decoded = decodeRankListAck(errorCode, rankType);
  assert.deepStrictEqual(decoded, [], `${label} must return no profiles`);
  assert.strictEqual(JSON.stringify(socket.session.user), before, `${label} must not mutate state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
}

function rewardFailure(packetId, payload, errorCode, managedRequest) {
  const before = JSON.stringify(socket.session.user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, payload, managedRequest);
  assertRewardAck(packetId + 1, errorCode, false);
  assert.strictEqual(JSON.stringify(socket.session.user), before, `failed ${packetId} must not mutate state`);
  assert.strictEqual(saves, beforeSaves, `failed ${packetId} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `failed ${packetId} must not invalidate JOIN`);
}

function decodeRankListAck(errorCode, rankType) {
  assert.strictEqual(response.packetId, PACKETS.RANK_LIST_ACK);
  let read = readSignedVarInt(response.payload, 0);
  assert.strictEqual(read.value, errorCode, "rank ACK errorCode");
  read = readSignedVarInt(response.payload, read.offset);
  assert.strictEqual(read.value, rankType, "rank ACK rankType");
  const count = readUnsignedVarInt(response.payload, read.offset);
  let offset = count.offset;
  const profiles = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(response.payload, offset);
    assert.strictEqual(present.value, true, "rank profile entries must be non-null");
    let field = readSignedVarLong(response.payload, present.offset);
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
    assert.strictEqual(guildPresent.value, true, "rank guild data must match the frozen non-null default");
    field = readSignedVarLong(response.payload, guildPresent.offset);
    const guildName = readString(response.payload, field.offset);
    field = readSignedVarLong(response.payload, guildName.offset);
    offset = field.offset + 8;
    profiles.push({ userUid, friendCode, nickname: nickname.value, score: ints[6], tier: ints[7] });
  }
  assert.strictEqual(offset, response.payload.length, "rank ACK must have exact framing");
  return profiles;
}

function assertRewardAck(packetId, errorCode, success) {
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode, `reward ACK ${packetId} errorCode`);
  const rewardPresent = readBool(response.payload, error.offset);
  assert.strictEqual(rewardPresent.value, success, `reward ACK ${packetId} reward nullability`);
  if (!success) {
    let offset = rewardPresent.offset;
    const nullableFieldCount = packetId === PACKETS.WEEK_REWARD_ACK ? 1 : 3;
    for (let index = 0; index < nullableFieldCount; index += 1) {
      const field = readBool(response.payload, offset);
      assert.strictEqual(field.value, false, `failed reward ACK ${packetId} nullable field ${index}`);
      offset = field.offset;
    }
    const changed = readBool(response.payload, offset);
    assert.strictEqual(changed.value, false);
    assert.strictEqual(changed.offset, response.payload.length, `failed reward ACK ${packetId} exact framing`);
  }
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
  assert.match(listener, /writeNullableObject\(pvpRank\.buildPvpStateData\(pvpRank\.getPvpRankState\(user\)\)\), \/\/ m_PvpData/);
  assert.match(listener, /writeBool\(pvpRank\.isRankPvpOpen\(user\)\), \/\/ rankPvpOpen/);
  assert.match(listener, /overlayLocalPvpRankData: pvpRank\.hasPvpRankState\(user\)/);

  const handler = fs.readFileSync(path.join(rootDir, "combat-handler", "index.js"), "utf8");
  assert.match(handler, /overlayLocalPvpRankData: Boolean\(options\.overlayLocalPvpRankData\)/);
  const protocol = fs.readFileSync(path.join(rootDir, "combat-host", "Protocol.cs"), "utf8");
  assert.match(protocol, /public bool OverlayLocalPvpRankData \{ get; set; \}/);
  const bridge = fs.readFileSync(path.join(rootDir, "combat-host", "ManagedCombatBridge.cs"), "utf8");
  const staticUserFields = /LocalJoinLobbyUserDataFields\s*=\s*\[([\s\S]*?)\];/.exec(bridge);
  assert(staticUserFields && !staticUserFields[1].includes("m_PvpData"), "official imported PvP state must not be overwritten unconditionally");
  assert.match(bridge, /if \(overlayLocalPvpRankData\)[\s\S]*?CopyField\(runtime, localUserData, officialUserData, "m_PvpData"\)/);
  assert.match(bridge, /if \(data\.OverlayLocalPvpRankData\)[\s\S]*?CopyField\(runtime, local, official, "rankPvpOpen"\)/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for PvP rank/reward schema validation");
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
      assert(result.ok, `managed client schema rejected PvP packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
