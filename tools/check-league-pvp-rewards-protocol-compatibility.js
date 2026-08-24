"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem } = require("../modules/inventory");
const {
  ERRORS,
  PACKETS,
  claimLeagueSeasonReward,
  createLeaguePvpHandlers,
  getLeaguePvpState,
  getLeagueSeasonById,
  loadLeagueCatalog,
} = require("../modules/league-pvp");
const { readSignedVarInt } = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const rewardNow = new Date("2025-04-18T12:00:00Z");
const specialist = "modules\\league-pvp\\handlers\\0000-2701-league-pvp-season-info-req.js";
const registry = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
for (const packetId of [PACKETS.SEASON_REWARD_REQ, PACKETS.WEEKLY_RANKER_REQ]) {
  assert.strictEqual(registry.get(packetId).fileName, specialist, `packet ${packetId} specialist precedence`);
}
assert.deepStrictEqual(
  createLeaguePvpHandlers().map((handler) => handler.packetId),
  [
    PACKETS.MATCH_REQ,
    PACKETS.MATCH_CANCEL_REQ,
    PACKETS.GLOBAL_BAN_REQ,
    PACKETS.PICK_UNIT_REQ,
    PACKETS.OPPONENT_BAN_REQ,
    PACKETS.PICK_SHIP_REQ,
    PACKETS.PICK_OPERATOR_REQ,
    PACKETS.PICK_LEADER_REQ,
    PACKETS.SELECT_UNIT_REQ,
    PACKETS.GIVEUP_REQ,
    PACKETS.RANK_LIST_REQ,
    PACKETS.SEASON_REWARD_REQ,
    PACKETS.WEEKLY_RANKER_REQ,
    PACKETS.SEASON_INFO_REQ,
  ]
);
assert.deepStrictEqual(
  {
    invalidInterval: ERRORS.SEASON_REWARD_INVALID_INTERVAL,
    alreadyReceived: ERRORS.SEASON_REWARD_ALREADY_RECEIVED,
    rankRewardMissing: ERRORS.SEASON_RANK_REWARD_TEMPLET_NULL,
    rankMissing: ERRORS.RANK_TEMPLET_NULL,
    playCountZero: ERRORS.PLAY_COUNT_ZERO,
  },
  { invalidInterval: 27402, alreadyReceived: 27403, rankRewardMissing: 27404, rankMissing: 27407, playCountZero: 27408 },
  "frozen League reward errors changed"
);

const catalog = loadLeagueCatalog();
assert.deepStrictEqual(
  [catalog.seasons.length, catalog.tiers.length, catalog.seasonRewards.length],
  [16, 108, 57],
  "frozen League reward tables changed"
);
const season = getLeagueSeasonById(10);
assert.deepStrictEqual(
  [season.rankGroup, season.rankRewardGroup, season.gameType, season.rewardStart.toISOString(), season.rewardEnd.toISOString()],
  [9005, 1003, "NGT_PVP_LEAGUE", "2025-04-16T10:00:00.000Z", "2025-04-23T10:00:00.000Z"],
  "League reward interval must come from the frozen interval table"
);

let response = null;
let saves = 0;
let invalidations = 0;
const managedPackets = [];
const socket = { session: { user: makeUser() } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  getServerNowDate() { return rewardNow; },
  getEffectiveOpenTags() { return ["TAG_COMMON_PVP_CHAMPIONSHIP_2"]; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
};

assertGate("unknown season", makeUser({ seasonId: 999 }), ERRORS.SEASON_TEMPLET_NULL);
assertGate("closed reward interval", makeUser(), ERRORS.SEASON_REWARD_INVALID_INTERVAL, { now: new Date("2025-04-10T12:00:00Z") });
const closedTagUser = makeUser();
closedTagUser.openTags = [];
assertGate("closed content tag", closedTagUser, ERRORS.SEASON_REWARD_INVALID_INTERVAL, {
  ctx: { getEffectiveOpenTags() { return []; } },
});
assertGate("zero play count", makeUser({ winCount: 0, loseCount: 0 }), ERRORS.PLAY_COUNT_ZERO);
assertGate("missing tier", makeUser({ leagueTierId: 99 }), ERRORS.RANK_TEMPLET_NULL);
assertGate("missing placement row", makeUser({ rank: 101 }), ERRORS.SEASON_RANK_REWARD_TEMPLET_NULL);

socket.session.user = makeUser();
invoke(PACKETS.SEASON_REWARD_REQ, Buffer.from([0]), false);
assertAck(PACKETS.SEASON_REWARD_ACK, ERRORS.SEASON_TEMPLET_NULL);
assert.deepStrictEqual([saves, invalidations], [0, 0], "malformed claim must be pure");

managedPackets.push([PACKETS.SEASON_REWARD_REQ, Buffer.alloc(0)]);
invoke(PACKETS.SEASON_REWARD_REQ, Buffer.alloc(0), false);
assertAck(PACKETS.SEASON_REWARD_ACK, ERRORS.OK);
assert.strictEqual(socket.session.user.pvp.leagueSeasonRewardReceived, true);
assert.deepStrictEqual(getLeaguePvpState(socket.session.user), makeState());
assertItem(socket.session.user, 1016, 10);
assertItem(socket.session.user, 1035, 50);
assertItem(socket.session.user, 1500245, 1);
assertItem(socket.session.user, 8108, 1);
assert.deepStrictEqual([saves, invalidations], [1, 1], "successful claim must save and invalidate once");

invoke(PACKETS.SEASON_REWARD_REQ, Buffer.alloc(0));
assertAck(PACKETS.SEASON_REWARD_ACK, ERRORS.SEASON_REWARD_ALREADY_RECEIVED);
assert.deepStrictEqual([saves, invalidations], [1, 1], "duplicate claim must be pure");
const restarted = JSON.parse(JSON.stringify(socket.session.user));
socket.session.user = restarted;
invoke(PACKETS.SEASON_REWARD_REQ, Buffer.alloc(0));
assertAck(PACKETS.SEASON_REWARD_ACK, ERRORS.SEASON_REWARD_ALREADY_RECEIVED);
assert.deepStrictEqual([saves, invalidations], [1, 1], "restart must preserve the claim cursor");

managedPackets.push([PACKETS.WEEKLY_RANKER_REQ, Buffer.alloc(0)]);
invoke(PACKETS.WEEKLY_RANKER_REQ, Buffer.alloc(0), false);
assertWeeklyAck(ERRORS.OK);
invoke(PACKETS.WEEKLY_RANKER_REQ, Buffer.from([0]), false);
assertWeeklyAck(ERRORS.SEASON_TEMPLET_NULL);
assert.deepStrictEqual([saves, invalidations], [1, 1], "weekly-ranker reads must never persist");

verifyFrozenSources();
validateManagedSchemas();
console.log(
  `[league-pvp-rewards-check] PASS seasons=${catalog.seasons.length} tiers=${catalog.tiers.length} placementRows=${catalog.seasonRewards.length} saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function makeState(overrides = {}) {
  return {
    seasonId: 10,
    weekId: 1,
    winCount: 8,
    loseCount: 2,
    leagueTierId: 4,
    maxLeagueTierId: 4,
    score: 450,
    maxScore: 500,
    winStreak: 2,
    maxWinStreak: 4,
    rank: 1,
    seasonPlayCount: 10,
    seasonWinCount: 8,
    rankOpen: true,
    ...overrides,
  };
}

function makeUser(overrides = {}) {
  const state = makeState(overrides);
  return {
    userUid: "2655001",
    friendCode: "26550001",
    nickname: "LeagueReward",
    level: 100,
    region: "GLOBAL",
    openTags: ["TAG_COMMON_PVP_CHAMPIONSHIP_2"],
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    pvp: { leagueSeasonRewardReceived: false, league: state },
  };
}

function assertGate(label, user, errorCode, options = {}) {
  const before = JSON.stringify(user);
  const result = claimLeagueSeasonReward(
    options.ctx ? { ...ctx, ...options.ctx } : ctx,
    user,
    { now: options.now || rewardNow }
  );
  assert.strictEqual(result.errorCode, errorCode, label);
  assert.strictEqual(result.changed, false, label);
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate`);
}

function invoke(packetId, payload, managedRequest = true) {
  response = null;
  if (managedRequest) managedPackets.push([packetId, payload]);
  const handler = registry.get(packetId);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert(response, `packet ${packetId} must respond`);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, errorCode);
}

function assertWeeklyAck(errorCode) {
  assertAck(PACKETS.WEEKLY_RANKER_ACK, errorCode);
  const error = readSignedVarInt(response.payload, 0);
  const count = readUnsignedVarInt(response.payload, error.offset);
  assert.strictEqual(count.value, 0, "no weekly League history means no fabricated rankers");
  assert.strictEqual(count.offset, response.payload.length);
}

function assertItem(user, itemId, count) {
  const item = getMiscItem(user, itemId);
  assert(item, `missing reward item ${itemId}`);
  assert.strictEqual(String(item.countFree), String(count), `reward item ${itemId}`);
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(
    source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_SEASON_REWARD_REQ.cs"),
    /Serialize\(IPacketStream stream\)\s*\{\s*\}/,
    "frozen League season-reward request must remain empty"
  );
  assert.match(
    source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_SEASON_REWARD_ACK.cs"),
    /errorCode[\s\S]*rewardData[\s\S]*rankRewardData[\s\S]*pvpData/,
    "frozen League season-reward ACK field order changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKC", "UI", "Module", "NKCUIModuleSubUIDraft.cs"),
    /!NKCPVPManager\.m_bLeagueSeasonRewardReceived[\s\S]*WinCount \+ [\s\S]*LoseCount > 0[\s\S]*SeasonRewardEnable[\s\S]*Send_NKMPacket_LEAGUE_PVP_SEASON_REWARD_REQ/,
    "frozen reward sender gates changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"),
    /m_bLeagueSeasonRewardReceived = true;[\s\S]*m_LeagueData = sPacket\.pvpData;[\s\S]*GetReward\(sPacket\.rewardData\)[\s\S]*GetReward\(sPacket\.rankRewardData\)/,
    "frozen reward receiver mutations changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKC", "NKC_SCEN_HOME.cs"),
    /Send_NKMPacket_LEAGUE_PVP_WEEKLY_RANKER_REQ[\s\S]*OnRecv\(NKMPacket_LEAGUE_PVP_WEEKLY_RANKER_ACK sPacket\)[\s\S]*m_bWaitGauntletLeagueTopAck = false/,
    "frozen weekly-ranker request and completion path changed"
  );
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected League reward packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function readUnsignedVarInt(buffer, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (shift < 32) {
    assert(offset < buffer.length, "truncated list count");
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
}
