"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, ERRORS, createLeaguePvpHandlers, getLeaguePvpState } = require("../modules/league-pvp");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readBool, readSignedVarInt } = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const specialist = "modules\\league-pvp\\handlers\\0000-2701-league-pvp-season-info-req.js";
const registry = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
assert.strictEqual(registry.get(PACKETS.SEASON_INFO_REQ).fileName, specialist, "season-info specialist precedence");
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
assert.strictEqual(ERRORS.SEASON_TEMPLET_NULL, 27400);

const user = {
  userUid: "2701001",
  pvp: {
    leagueSeasonRewardReceived: true,
    league: {
      seasonId: 19,
      weekId: 2,
      winCount: 8,
      loseCount: 3,
      leagueTierId: 4,
      maxLeagueTierId: 5,
      score: 1550,
      maxScore: 1700,
      winStreak: 2,
      maxWinStreak: 6,
      rank: 9,
      seasonPlayCount: 11,
      seasonWinCount: 8,
    },
  },
};
const originalUser = JSON.stringify(user);
const socket = { session: { user } };
const managedPackets = [];
let response = null;
let saves = 0;
const ctx = {
  decryptCopy(payload) { return payload; },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 71);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("season-info read must not invalidate JOIN"); },
};
const handler = registry.get(PACKETS.SEASON_INFO_REQ);

managedPackets.push([PACKETS.SEASON_INFO_REQ, Buffer.alloc(0)]);
send(Buffer.alloc(0));
const success = parseAck(response.payload);
assert.strictEqual(success.errorCode, ERRORS.OK);
assert.strictEqual(success.seasonRewardReceived, true);
assert.deepStrictEqual(success.state, Object.values(getLeaguePvpState(user)).slice(0, 13));
assert.strictEqual(success.rankerCount, 0, "no local League history means no fabricated Hall of Fame profiles");

send(Buffer.from([0]));
const malformed = parseAck(response.payload);
assert.strictEqual(malformed.errorCode, ERRORS.SEASON_TEMPLET_NULL);
assert.strictEqual(malformed.seasonRewardReceived, false);
assert.strictEqual(malformed.state, null);
assert.strictEqual(malformed.rankerCount, 0);

const restartedUser = JSON.parse(JSON.stringify(user));
socket.session.user = restartedUser;
send(Buffer.alloc(0));
assert.deepStrictEqual(parseAck(response.payload), success, "durable League state must survive JSON restart");
assert.strictEqual(saves, 0, "season-info reads must never save");
assert.strictEqual(JSON.stringify(user), originalUser, "season-info reads must not mutate the profile");

const tables = verifyFrozenSources();
validateManagedSchemas();
console.log(
  `[league-pvp-season-info-check] PASS seasons=${tables.seasons} modules=${tables.modules} saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function send(payload) {
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.SEASON_INFO_REQ, sequence: 71, payload }), true);
  assert(response, "season-info request must return an ACK");
  assert.strictEqual(response.packetId, PACKETS.SEASON_INFO_ACK);
}

function parseAck(payload) {
  let offset = 0;
  const error = readSignedVarInt(payload, offset);
  offset = error.offset;
  const reward = readBool(payload, offset);
  offset = reward.offset;
  const present = readBool(payload, offset);
  offset = present.offset;
  let state = null;
  if (present.value) {
    state = [];
    for (let index = 0; index < 13; index += 1) {
      const value = readSignedVarInt(payload, offset);
      offset = value.offset;
      state.push(value.value);
    }
  }
  const rankers = readUnsignedVarInt(payload, offset);
  offset = rankers.offset;
  assert.strictEqual(offset, payload.length, "empty League ranker list must end the ACK");
  return {
    errorCode: error.value,
    seasonRewardReceived: reward.value,
    state,
    rankerCount: rankers.value,
  };
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(
    source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_SEASON_INFO_REQ.cs"),
    /Serialize\(IPacketStream stream\)\s*\{\s*\}/,
    "frozen season-info request must remain empty"
  );
  assert.match(
    source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_SEASON_INFO_ACK.cs"),
    /errorCode[\s\S]*seasonRewardReceived[\s\S]*leaguePvpState[\s\S]*rankerDatas/,
    "frozen season-info ACK field order changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"),
    /m_LeagueData = sPacket\.leaguePvpState;[\s\S]*NKCPVPManager\.OnRecv\(sPacket\)/,
    "frozen receiver must continue replacing League state and forwarding Hall of Fame data"
  );
  assert.match(
    source("Assembly-CSharp", "NKM", "NKCPVPManager.cs"),
    /m_bLeagueSeasonRewardReceived = sPacket\.seasonRewardReceived;[\s\S]*sPacket\.rankerDatas\.Count/,
    "frozen manager must continue consuming reward and ranker fields"
  );

  const seasonTable = JSON.parse(source("gameplay-jsons", "StreamingAssets", "ab_script", "luac", "LUA_PVP_LEAGUE_SEASON.json"));
  const moduleTable = JSON.parse(source("gameplay-jsons", "StreamingAssets", "ab_script", "luac", "LUA_EVENT_COLLECTION_INDEX_TEMPLET.json"));
  const modules = moduleTable.records.filter((row) => /PvpLeagueSeasonID\s*=/.test(String(row && row.m_Option || "")));
  assert.strictEqual(seasonTable.records.length, 16, "frozen League season count changed");
  assert.strictEqual(modules.length, 12, "frozen League event-module count changed");
  assert(modules.every((row) => /PvpLeagueSeasonID\s*=\s*(?:8|9|1[0-9]);/.test(row.m_Option)));
  return { seasons: seasonTable.records.length, modules: modules.length };
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
      assert(result.ok, `managed client schema rejected League season-info packet ${packetId}: ${result.error || "unknown error"}`);
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
