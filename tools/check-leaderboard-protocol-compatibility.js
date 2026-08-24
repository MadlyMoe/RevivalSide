"use strict";

const assert = require("assert");
const path = require("path");
const { createLeaderboardHandlers, INVALID_REQUEST } = require("../modules/leaderboard");
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
const seasonId = 210203;
const shadowId = 1001;
const stageId = 6180011;
const defenceId = 1;
const alice = makeUser("1001", "Alice", 500, { guildUid: "77", guildName: "Alpha", guildLevel: 10, unionPoint: 1000 });
const bob = makeUser("1002", "Bob", 700, { guildUid: "77", guildName: "Alpha", guildLevel: 10, unionPoint: 1000 });
const carol = makeUser("1003", "Carol", 300, { guildUid: "88", guildName: "Beta", guildLevel: 12, unionPoint: 2000 });
setShadow(alice, [10, 10, 10, 10, 10]);
setShadow(bob, [8, 8, 8, 8, 8]);
setShadow(carol, [5, 5, 5, 5]);
setStage(alice, 80);
setStage(bob, 90);
setStage(carol, 60);
setDefence(alice, 200);
setDefence(bob, 150);
setDefence(carol, 300);

const extras = Array.from({ length: 12 }, (_, index) => makeUser(String(2000 + index), `Extra${index}`, 100 - index));
const users = [alice, bob, carol, ...extras];
const userDb = { users: Object.fromEntries(users.map((user) => [user.userUid, user])) };
const handlers = new Map(createLeaderboardHandlers().map((handler) => [handler.packetId, handler]));
const socket = { session: { user: alice } };
const managedPackets = [];
let saves = 0;
const ctx = {
  userDb,
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    managedPackets.push([packetId, target.response.payload]);
  },
  saveUserDb() { saves += 1; },
};

const before = JSON.stringify(userDb);

send(3200, writeBool(false), true);
let board = parseProfileBoard(socket.response.payload, "long", false);
assert.equal(board.errorCode, 0);
assert.deepStrictEqual(board.entries.slice(0, 3).map((entry) => entry.userUid), ["1002", "1001", "1003"]);
assert.equal(board.entries.length, 10, "top request must respect the frozen top-ten range");
assert.equal(board.userRank, 2);
assert.equal(board.isAll, false);

send(3200, writeBool(true), true);
board = parseProfileBoard(socket.response.payload, "long", false);
assert.equal(board.entries.length, users.length, "all request must expose the complete local ranking");
assert.equal(board.isAll, true);

send(3202, intBool(shadowId, false), true);
board = parseProfileBoard(socket.response.payload, "int", true);
assert.deepStrictEqual(board.entries.map((entry) => [entry.userUid, entry.score]), [["1002", 40], ["1001", 50]]);
assert.equal(board.userRank, 2);
assert.equal(board.criteria, shadowId);

send(3212, intBool(stageId, false), true);
board = parseProfileBoard(socket.response.payload, "int", true);
assert.deepStrictEqual(board.entries.map((entry) => [entry.userUid, entry.score]), [["1003", 60], ["1001", 80], ["1002", 90]]);
assert.equal(board.userRank, 2);
assert.equal(board.criteria, stageId);

send(3214, intBool(defenceId, false), true);
board = parseProfileBoard(socket.response.payload, "int", true);
assert.deepStrictEqual(board.entries.map((entry) => [entry.userUid, entry.score]), [["1003", 300], ["1001", 200], ["1002", 150]]);
assert.equal(board.userRank, 2);
assert.equal(board.criteria, defenceId);

send(3208, writeSignedVarInt(seasonId), true);
let guild = parseGuildBoard(socket.response.payload, true);
assert.equal(guild.seasonId, seasonId);
assert.deepStrictEqual(guild.entries.map((entry) => [entry.guildUid, entry.rankValue]), [["88", 2000n], ["77", 1000n]]);
assert.equal(guild.entries[1].memberCount, 2);
assert.deepStrictEqual(guild.myRank, { rank: 2, score: 1000n });

send(3210, Buffer.alloc(0), true);
guild = parseGuildBoard(socket.response.payload, false);
assert.deepStrictEqual(guild.entries.map((entry) => [entry.guildUid, entry.rankValue]), [["88", 12n], ["77", 10n]]);
assert.deepStrictEqual(guild.myRank, { rank: 2, score: 10n });

for (const [packetId, payload, parse] of [
  [3200, Buffer.alloc(0), (value) => parseProfileBoard(value, "long", false)],
  [3200, Buffer.from([2]), (value) => parseProfileBoard(value, "long", false)],
  [3202, intBool(999999, false), (value) => parseProfileBoard(value, "int", true)],
  [3212, Buffer.concat([intBool(stageId, false), Buffer.from([0])]), (value) => parseProfileBoard(value, "int", true)],
  [3214, intBool(999999, false), (value) => parseProfileBoard(value, "int", true)],
]) {
  send(packetId, payload, false);
  const invalid = parse(socket.response.payload);
  assert.equal(invalid.errorCode, INVALID_REQUEST);
  assert.deepStrictEqual(invalid.entries, []);
  assert.equal(invalid.userRank, 0);
}

send(3208, Buffer.alloc(0), false);
guild = parseGuildBoard(socket.response.payload, true);
assert.equal(guild.seasonId, 0);
assert.deepStrictEqual(guild.entries, []);
assert.deepStrictEqual(guild.myRank, { rank: 0, score: 0n });
send(3210, Buffer.from([0]), false);
guild = parseGuildBoard(socket.response.payload, false);
assert.deepStrictEqual(guild.entries, []);

assert.equal(JSON.stringify(userDb), before, "leaderboard reads must not mutate any profile");
assert.equal(saves, 0, "leaderboard reads must never save");
validateManagedSchemas();
console.log(`[leaderboard-protocol-check] PASS users=${users.length} saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname, achievePoint, guild = null) {
  const user = {
    userUid,
    friendCode: String(900000 + Number(userUid)),
    nickname,
    level: 50,
    mainUnitId: 1001,
    mainUnitSkinId: 0,
    frameId: 0,
    mainUnitTacticLevel: 0,
    titleId: 0,
    achievePoint: String(achievePoint),
    miscStages: { shadow: { palaces: {} }, defence: {} },
    stagePlayData: {},
  };
  if (guild) {
    user.guildUid = guild.guildUid;
    user.guildName = guild.guildName;
    user.guildLevel = guild.guildLevel;
    user.guildUnionPointBySeason = { [seasonId]: String(guild.unionPoint) };
  }
  return user;
}

function setShadow(user, times) {
  user.miscStages.shadow.palaces[String(shadowId)] = {
    palaceId: shadowId,
    dungeonDataList: times.map((bestTime, index) => ({ dungeonId: 10000 + index, bestTime })),
  };
}

function setStage(user, bestClearTimeSec) {
  user.stagePlayData[String(stageId)] = { stageId, bestClearTimeSec };
}

function setDefence(user, bestScore) {
  user.miscStages.defence[String(defenceId)] = { defenceTempletId: defenceId, bestScore };
}

function intBool(value, bool) {
  return Buffer.concat([writeSignedVarInt(value), writeBool(bool)]);
}

function send(packetId, payload, validateRequest) {
  const handler = handlers.get(packetId);
  assert(handler, `missing leaderboard handler ${packetId}`);
  if (validateRequest) managedPackets.push([packetId, payload]);
  assert.equal(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert.equal(socket.response.packetId, packetId + 1);
}

function parseProfileBoard(payload, scoreType, hasCriteria) {
  const error = readSignedVarInt(payload, 0);
  const boardPresent = readBool(payload, error.offset);
  assert.equal(boardPresent.value, true, "leaderboard wrapper must be present");
  const list = readObjectList(payload, boardPresent.offset, (buffer, offset) => readProfileScore(buffer, offset, scoreType));
  const rank = readSignedVarInt(payload, list.offset);
  let offset = rank.offset;
  let criteria = null;
  if (hasCriteria) {
    const read = readSignedVarInt(payload, offset);
    criteria = read.value;
    offset = read.offset;
  }
  const all = readBool(payload, offset);
  assert.equal(all.offset, payload.length, "profile leaderboard ACK must not contain trailing bytes");
  return { errorCode: error.value, entries: list.value, userRank: rank.value, criteria, isAll: all.value };
}

function readProfileScore(payload, startOffset, scoreType) {
  const present = readBool(payload, startOffset);
  assert.equal(present.value, true, "leaderboard row must be present");
  const commonPresent = readBool(payload, present.offset);
  assert.equal(commonPresent.value, true, "common profile must be present");
  const profile = readCommonProfile(payload, commonPresent.offset);
  const score = scoreType === "long" ? readSignedVarLong(payload, profile.offset) : readSignedVarInt(payload, profile.offset);
  const guildPresent = readBool(payload, score.offset);
  assert.equal(guildPresent.value, true, "guild simple data must be present");
  const guild = readGuildSimple(payload, guildPresent.offset);
  return { value: { userUid: profile.userUid, score: score.value }, offset: guild.offset };
}

function readCommonProfile(payload, startOffset) {
  let offset = startOffset;
  const uid = readSignedVarLong(payload, offset);
  offset = uid.offset;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readString(payload, offset).offset;
  for (let index = 0; index < 6; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return { userUid: String(uid.value), offset };
}

function readGuildSimple(payload, startOffset) {
  let offset = readSignedVarLong(payload, startOffset).offset;
  offset = readString(payload, offset).offset;
  offset = readSignedVarLong(payload, offset).offset;
  return { offset };
}

function parseGuildBoard(payload, hasSeason) {
  let offset = 0;
  let parsedSeasonId = null;
  if (hasSeason) {
    const season = readSignedVarInt(payload, offset);
    parsedSeasonId = season.value;
    offset = season.offset;
  }
  const boardPresent = readBool(payload, offset);
  assert.equal(boardPresent.value, true, "guild leaderboard wrapper must be present");
  const list = readObjectList(payload, boardPresent.offset, readGuildRank);
  const rankPresent = readBool(payload, list.offset);
  assert.equal(rankPresent.value, true, "own guild rank must be present");
  const rank = readSignedVarInt(payload, rankPresent.offset);
  const score = readSignedVarLong(payload, rank.offset);
  assert.equal(score.offset, payload.length, "guild leaderboard ACK must not contain trailing bytes");
  return { seasonId: parsedSeasonId, entries: list.value, myRank: { rank: rank.value, score: score.value } };
}

function readGuildRank(payload, startOffset) {
  const present = readBool(payload, startOffset);
  assert.equal(present.value, true, "guild rank row must be present");
  const uid = readSignedVarLong(payload, present.offset);
  let offset = readSignedVarLong(payload, uid.offset).offset;
  const name = readString(payload, offset);
  offset = name.offset;
  offset = readString(payload, offset).offset;
  const level = readSignedVarInt(payload, offset);
  const members = readSignedVarInt(payload, level.offset);
  const score = readSignedVarLong(payload, members.offset);
  return {
    value: { guildUid: String(uid.value), guildName: name.value, guildLevel: level.value, memberCount: members.value, rankValue: score.value },
    offset: score.offset,
  };
}

function readObjectList(payload, startOffset, readEntry) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const entry = readEntry(payload, offset);
    value.push(entry.value);
    offset = entry.offset;
  }
  return { value, offset };
}

function readUnsignedVarInt(payload, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (shift < 32) {
    assert(offset < payload.length, "truncated list count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
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
      assert(result.ok, `managed client schema rejected leaderboard packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
