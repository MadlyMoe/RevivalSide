"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, ERRORS, RANGES, RANK_TYPES } = require("../modules/league-pvp");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const specialist = "modules\\league-pvp\\handlers\\0000-2701-league-pvp-season-info-req.js";
const registry = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = registry.get(PACKETS.RANK_LIST_REQ);
assert(handler, "League rank-list specialist must be registered");
assert.strictEqual(handler.fileName, specialist, "League rank-list specialist precedence");
assert.strictEqual(ERRORS.INVALID_RANGE, 20808);
assert.strictEqual(ERRORS.INVALID_RANK_TYPE, 20809);
assert.deepStrictEqual(RANK_TYPES, { MY_LEAGUE: 0, ALL: 1, FRIEND: 2 });
assert.deepStrictEqual(RANGES, { ALL: 0, TOP10: 1 });

const users = {};
for (let index = 1; index <= 12; index += 1) {
  const user = makeUser(index, 1700 - index * 50, index <= 5 ? 4 : 5);
  users[user.userUid] = user;
}
const activeUser = users["2635001"];
activeUser.community.friends.push("2635003", "2635006");
const snapshot = JSON.stringify(users);
const socket = { session: { user: activeUser } };
const managedPackets = [];
let response = null;
let saves = 0;
const ctx = {
  userDb: { users },
  decryptCopy(payload) { return payload; },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 35);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("League rank-list reads must not invalidate JOIN"); },
};

let result = invoke(RANK_TYPES.ALL, RANGES.TOP10);
assert.strictEqual(result.errorCode, ERRORS.OK);
assert.strictEqual(result.rankType, RANK_TYPES.ALL);
assert.strictEqual(result.myRank, 1);
assert.strictEqual(result.profiles.length, 10, "TOP10 must cap the local League board");
assert.deepStrictEqual(result.profiles.slice(0, 3).map((entry) => entry.nickname), ["League1", "League2", "League3"]);

result = invoke(RANK_TYPES.ALL, RANGES.ALL);
assert.strictEqual(result.profiles.length, 12, "ALL must include the complete local board below the 100-row cap");
result = invoke(RANK_TYPES.MY_LEAGUE, RANGES.ALL);
assert.strictEqual(result.profiles.length, 5, "MY_LEAGUE must filter by the requester's tier");
result = invoke(RANK_TYPES.FRIEND, RANGES.ALL);
assert.deepStrictEqual(result.profiles.map((entry) => entry.userUid), [2635003n, 2635006n]);

failure("invalid rank type", request(3, RANGES.ALL), ERRORS.INVALID_RANK_TYPE, 3);
failure("invalid range", request(RANK_TYPES.ALL, 2), ERRORS.INVALID_RANGE, RANK_TYPES.ALL);
failure("truncated", writeSignedVarInt(RANK_TYPES.ALL), ERRORS.INVALID_RANK_TYPE, 0, false);
failure("trailing", Buffer.concat([request(RANK_TYPES.ALL, RANGES.ALL), Buffer.from([0])]), ERRORS.INVALID_RANK_TYPE, RANK_TYPES.ALL, false);
failure("non-canonical rank enum", Buffer.from([0x80, 0x00, 0x00]), ERRORS.INVALID_RANK_TYPE, 0, false);

assert.strictEqual(saves, 0, "League rank-list reads must never save");
assert.strictEqual(JSON.stringify(users), snapshot, "League rank-list reads and failures must not mutate users");
verifyFrozenSources();
validateManagedSchemas();
console.log(
  `[league-pvp-rank-list-check] PASS users=${Object.keys(users).length} saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function invoke(rankType, range) {
  const payload = request(rankType, range);
  managedPackets.push([PACKETS.RANK_LIST_REQ, payload]);
  return send(payload);
}

function failure(name, payload, errorCode, rankType, managed = true) {
  if (managed) managedPackets.push([PACKETS.RANK_LIST_REQ, payload]);
  const value = send(payload);
  assert.strictEqual(value.errorCode, errorCode, `${name} error`);
  assert.strictEqual(value.rankType, rankType, `${name} rank type`);
  assert.strictEqual(value.myRank, 0, `${name} own rank`);
  assert.strictEqual(value.profiles.length, 0, `${name} profiles`);
}

function request(rankType, range) {
  return Buffer.concat([writeSignedVarInt(rankType), writeSignedVarInt(range)]);
}

function send(payload) {
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.RANK_LIST_REQ, sequence: 35, payload }), true);
  assert(response, "League rank-list request must return an ACK");
  assert.strictEqual(response.packetId, PACKETS.RANK_LIST_ACK);
  return parseAck(response.payload);
}

function parseAck(payload) {
  let value = readSignedVarInt(payload, 0);
  const errorCode = value.value;
  value = readSignedVarInt(payload, value.offset);
  const rankType = value.value;
  value = readSignedVarInt(payload, value.offset);
  const myRank = value.value;
  const count = readUnsignedVarInt(payload, value.offset);
  let offset = count.offset;
  const profiles = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true, "League profile entries must be non-null");
    value = readSignedVarLong(payload, present.offset);
    const userUid = value.value;
    value = readSignedVarLong(payload, value.offset);
    const friendCode = value.value;
    const nickname = readString(payload, value.offset);
    offset = nickname.offset;
    const ints = [];
    for (let field = 0; field < 8; field += 1) {
      value = readSignedVarInt(payload, offset);
      offset = value.offset;
      ints.push(value.value);
    }
    const guild = readBool(payload, offset);
    assert.strictEqual(guild.value, true, "League profile guild data must use the frozen non-null default");
    value = readSignedVarLong(payload, guild.offset);
    const guildName = readString(payload, value.offset);
    value = readSignedVarLong(payload, guildName.offset);
    offset = value.offset + 8;
    profiles.push({ userUid, friendCode, nickname: nickname.value, score: ints[6], tier: ints[7] });
  }
  assert.strictEqual(offset, payload.length, "League rank-list ACK must have exact framing");
  return { errorCode, rankType, myRank, profiles };
}

function makeUser(index, score, tier) {
  return {
    userUid: String(2635000 + index),
    friendCode: String(8635000 + index),
    nickname: `League${index}`,
    level: 100,
    lastLoginDateBinary: "638912880000000000",
    community: { friends: [] },
    pvp: {
      league: {
        seasonId: 19,
        weekId: 1,
        leagueTierId: tier,
        maxLeagueTierId: tier,
        score,
        maxScore: score,
      },
    },
  };
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(
    source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_RANK_LIST_REQ.cs"),
    /rankType[\s\S]*range/,
    "frozen League rank-list request field order changed"
  );
  assert.match(
    source("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_LEAGUE_PVP_RANK_LIST_ACK.cs"),
    /errorCode[\s\S]*rankType[\s\S]*myRank[\s\S]*list/,
    "frozen League rank-list ACK field order changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"),
    /NEC_FAIL_LEAGUE_PVP_RANKING_INVALID_RANGE_REQUEST,[\s\S]*NEC_FAIL_LEAGUE_PVP_RANKING_INVALID_TYPE_REQUEST/,
    "frozen League rank-list errors changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKC", "UI", "Gauntlet", "NKCUIGauntletLobbyLeague.cs"),
    /range = \(all \? LeaderBoardRangeType\.ALL : LeaderBoardRangeType\.TOP10\)/,
    "frozen ALL versus TOP10 request behavior changed"
  );
  assert.match(
    source("Assembly-CSharp", "NKC", "NKCLeaderBoardManager.cs"),
  /sPacket\.list[\s\S]*sPacket\.myRank/,
    "frozen client must continue consuming own rank and the profile list"
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
      assert(result.ok, `managed client schema rejected League rank-list packet ${packetId}: ${result.error || "unknown error"}`);
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
