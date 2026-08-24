"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const {
  ERRORS,
  PACKETS,
  buildGuildDungeonRewardInfoData,
  buildInfoAckPayload,
  buildMemberInfoAckPayload,
  buildSeasonRewardAckPayload,
  buildSessionRewardAckPayload,
  buildTicketBuyAckPayload,
  buyArenaTicket,
  claimSeasonReward,
  claimSessionReward,
  commitBattleResult,
  commitBattleStart,
  getGuildDungeonInfo,
  getGuildDungeonMemberInfo,
  loadTables,
  prepareArenaGameLoad,
  prepareBossGameLoad,
  serializeGuildDungeonRewardInfo,
  updateArenaFlag,
  updateBossOrder,
  updateDungeonNotice,
} = require("../modules/guild-dungeon");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { grantMiscItem } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeBool,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const registry = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const expectedRequests = [3471, 3473, 3475, 3477, 3483, 3485, 3491, 3494, 3497];
for (const packetId of expectedRequests) {
  const loaded = registry.get(packetId);
  assert(loaded && loaded.fileName.endsWith("modules\\guild-dungeon\\handlers\\0000-3499-guild-dungeon-reqs.js"), `specialist missing for ${packetId}`);
}

const sourceDb = JSON.parse(fs.readFileSync(path.join(rootDir, "server-data", "users.json"), "utf8"));
const fixture = JSON.parse(JSON.stringify(Object.values(sourceDb.users || {})[0]));
assert(fixture && fixture.userUid, "Guild dungeon check needs a local profile with a daily deck");
const master = makeGuildUser(fixture, "77001", 7700, 0, "GuildMaster");
const member = makeGuildUser(fixture, "77002", 7700, 2, "GuildMember");
grantMiscItem(master, 101, 10000);
const users = { [master.userUid]: master, [member.userUid]: member };
const online = new Map(Object.values(users).map((user) => [String(user.userUid), { session: { user, gameReplay: {} } }]));
const responses = [];
const pushes = [];
let saves = 0;
let invalidations = 0;
let now = new Date("2026-08-21T12:00:00.000Z");
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  getGenericStageForRequest(request) {
    return { stageId: Number(request.stageID || request.dungeonID), dungeonID: Number(request.dungeonID), mapID: 1, gameType: 0, eventDeckId: 0 };
  },
  sendGameResponse(socket, packet, packetId, payload, label) {
    assert.strictEqual(packet.sequence, 71);
    socket.lastResponse = { packetId, payload, label };
    responses.push({ packetId, payload, label });
  },
  sendServerGamePacket(socket, packetId, payload, label) {
    socket.lastResponse = { packetId, payload, label };
    pushes.push({ userUid: String(socket.session.user.userUid), packetId, payload, label });
  },
  findClientSocketByUserUid(uid) { return online.get(String(uid)) || null; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

const tables = loadTables();
const activeSeason = tables.seasons.find((season) => season.id === 100021);
assert(activeSeason && activeSeason.dungeonGroup === 100021 && activeSeason.raidGroup === 10001);
assert.deepStrictEqual(activeSeason.schedules.get(3), [8010801, 8010502, 8010703, 8010303]);
assert.strictEqual(activeSeason.rewards.length, 19);
assert.strictEqual(tables.raidByIndex.size, 16);
assert(tables.artifactsByGroup.size > 40);

verifyStrictFraming();
verifyReadModels();
verifyTicketAndArena();
verifyFlagsOrderNotice();
verifyBoss();
verifyRewardsAndRestart();
validateManagedSchemas();

assert.strictEqual(saves, invalidations, "every successful mutation must save and invalidate once");
assert(saves >= 8);
console.log(`[guild-dungeon-check] PASS seasons=${tables.seasons.length} arenas=${tables.arenaByDungeonId.size} raidStages=${tables.raidByIndex.size} saves=${saves} packets=${responses.length + pushes.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function verifyStrictFraming() {
  reject(3471, master, Buffer.alloc(0), 3472, ERRORS.INVALID_REQUEST);
  reject(3471, master, Buffer.concat([writeSignedVarLong(7700n), Buffer.from([0])]), 3472, ERRORS.INVALID_REQUEST);
  reject(3471, master, nonCanonical(writeSignedVarLong(7700n)), 3472, ERRORS.INVALID_REQUEST);
  reject(3475, master, Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(15000), Buffer.from([0])]), 3476, ERRORS.INVALID_REQUEST);
  reject(3477, master, Buffer.from([0]), 3478, ERRORS.INVALID_REQUEST);
  reject(3483, master, Buffer.from([0]), 3484, ERRORS.INVALID_REQUEST);
  reject(3491, master, Buffer.concat([nonCanonical(writeSignedVarLong(7700n)), writeSignedVarInt(8), writeSignedVarInt(-1)]), 3492, ERRORS.INVALID_REQUEST);
  reject(3494, master, Buffer.concat([writeSignedVarLong(7700n), nonCanonical(writeSignedVarInt(1))]), 3495, ERRORS.INVALID_REQUEST);
  reject(3497, master, Buffer.concat([writeSignedVarLong(7700n), writeString("notice"), Buffer.from([0])]), 3498, ERRORS.INVALID_REQUEST);
  const socket = socketFor(master);
  invoke(registry.get(3485), socket, Buffer.concat([writeByte(0), writeSignedVarInt(8011301), Buffer.from([2])]));
  assert.strictEqual(socket.lastResponse.packetId, 804);
  assert.strictEqual(errorCode(socket.lastResponse.payload), ERRORS.INVALID_REQUEST);
}

function verifyReadModels() {
  const before = JSON.stringify(master);
  const info = getGuildDungeonInfo(ctx, master, 7700n);
  assert.strictEqual(info.errorCode, 0);
  assert.strictEqual(info.season.id, 100021);
  assert.strictEqual(info.session.id, 3);
  assert.deepStrictEqual(info.arenas.map((arena) => arena.index), [8, 5, 7, 3]);
  assert.strictEqual(info.boss.stageId, 8011301);
  assert(info.boss.remainHp > 20000000);
  assert.strictEqual(buildInfoAckPayload(info).length > 50, true);
  const memberInfo = getGuildDungeonMemberInfo(ctx, master, 7700n);
  assert.strictEqual(memberInfo.errorCode, 0);
  assert.strictEqual(memberInfo.members.length, 2);
  assert(buildMemberInfoAckPayload(memberInfo).length > 10);
  assert.deepStrictEqual(buildGuildDungeonRewardInfoData(master, { ctx }).rewards.map((row) => row.category), [0, 1]);
  assert(serializeGuildDungeonRewardInfo(buildGuildDungeonRewardInfoData(master, { ctx })).length > 5);
  assert.deepStrictEqual(buildGuildDungeonRewardInfoData({}, { ctx }), {
    currentSeasonId: 0,
    rewards: [
      { category: 0, totalValue: 0, receivedValue: 0 },
      { category: 1, totalValue: 0, receivedValue: 0 },
    ],
    canReward: false,
  });
  assert.strictEqual(JSON.stringify(master), before, "Guild dungeon reads must be pure");
  assert.strictEqual(getGuildDungeonInfo(ctx, member, 9999n).errorCode, ERRORS.INVALID_GUILD_DATA);
}

function verifyTicketAndArena() {
  let result = buyArenaTicket(ctx, master);
  assert.strictEqual(result.errorCode, 0);
  assert.strictEqual(result.currentTicketBuyCount, 1);
  assert(buildTicketBuyAckPayload(result).length > 4);
  persistDirect(result);
  result = buyArenaTicket(ctx, master);
  assert.strictEqual(result.errorCode, ERRORS.TICKET_MAX);

  const info = getGuildDungeonInfo(ctx, master, 7700n);
  const dungeonId = info.session.dungeonIds[0];
  const prepared = prepareArenaGameLoad(ctx, master, { dungeonID: dungeonId }, { stageId: dungeonId, dungeonID: dungeonId, mapID: 1, eventDeckId: dungeonId });
  assert(prepared && prepared.valid);
  const socket = socketFor(master);
  const saveBefore = saves;
  assert(commitBattleStart(ctx, socket, prepared.stage));
  assert.strictEqual(saves, saveBefore + 1);
  assert(pushes.some((packet) => packet.packetId === 3479));
  assert.strictEqual(prepareArenaGameLoad(ctx, member, { dungeonID: dungeonId }, prepared.stage).errorCode, ERRORS.ARENA_PLAYING);

  const replay = {
    dynamicGame: prepared.stage,
    lastDynamicGameEndResult: {
      win: true,
      giveup: false,
      battleState: { missionResult1: true, missionResult2: true, unitRecords: [{ teamType: 1, recordGiveDamage: 1000 }] },
    },
  };
  assert(commitBattleResult(ctx, socket, replay));
  assert.strictEqual(master.guildDungeon.sessions["100021:3"].arenaRuns.length, 1);
  assert.strictEqual(master.guildDungeon.sessions["100021:3"].arenaRuns[0].grade, 3);
  assert(pushes.some((packet) => packet.packetId === 3481));
  assert.strictEqual(commitBattleResult(ctx, socket, replay), false, "duplicate GAME_END must be pure");
}

function verifyFlagsOrderNotice() {
  const shared = master.guildDungeon.shared["100021:3"];
  shared.arenas["8"].totalMedalCount = 10;
  member.guildDungeon.shared["100021:3"] = JSON.parse(JSON.stringify(shared));
  let result = updateArenaFlag(ctx, master, { guildUid: 7700n, arenaIndex: 8, flagIndex: 0 });
  assert.strictEqual(result.errorCode, 0);
  assert(result.changed);
  persistDirect(result);
  assert.strictEqual(updateArenaFlag(ctx, master, { guildUid: 7700n, arenaIndex: 8, flagIndex: 1 }).errorCode, ERRORS.FLAG_INVALID_INDEX);
  const saveBefore = saves;
  result = updateArenaFlag(ctx, master, { guildUid: 7700n, arenaIndex: 8, flagIndex: 0 });
  assert.strictEqual(result.changed, false);
  assert.strictEqual(saves, saveBefore);

  result = updateBossOrder(ctx, master, { guildUid: 7700n, orderIndex: 2 });
  assert.strictEqual(result.errorCode, 0);
  persistDirect(result);
  assert.strictEqual(updateBossOrder(ctx, master, { guildUid: 7700n, orderIndex: 3 }).errorCode, ERRORS.ORDER_INVALID_INDEX);

  assert.strictEqual(updateDungeonNotice(ctx, member, { guildUid: 7700n, notice: "member" }).errorCode, ERRORS.NOT_ENOUGH_GRADE);
  result = updateDungeonNotice(ctx, master, { guildUid: 7700n, notice: "Focus the current boss" });
  assert.strictEqual(result.errorCode, 0);
  assert.strictEqual(member.guildDungeonNotice, "Focus the current boss");
  persistDirect(result);
}

function verifyBoss() {
  const request = { valid: true, deckIndex: 0, bossStageId: 8011301, isPractice: false };
  const prepared = prepareBossGameLoad(ctx, master, request);
  assert(prepared.valid, `boss load rejected: ${prepared.errorCode}`);
  const socket = socketFor(master);
  assert(commitBattleStart(ctx, socket, prepared.stage));
  assert(pushes.some((packet) => packet.packetId === 3480));
  const replay = {
    dynamicGame: prepared.stage,
    managedBattleRecords: [{ teamType: 1, recordGiveDamage: 99999999 }],
    lastDynamicGameEndResult: {
      win: true,
      giveup: false,
      battleState: { unitRecords: [{ teamType: 1, recordGiveDamage: 99999999 }] },
    },
  };
  assert(commitBattleResult(ctx, socket, replay));
  const shared = master.guildDungeon.shared["100021:3"];
  assert.strictEqual(shared.clearedBossStage, 1);
  assert.strictEqual(shared.boss.stageId, 8011302);
  assert.strictEqual(master.guildDungeon.sessions["100021:3"].bossRuns, 1);
  assert.strictEqual(master.guildDungeon.sessions["100021:3"].bossPoint, 12000);
  assert(pushes.some((packet) => packet.packetId === 3482));

  const practice = prepareBossGameLoad(ctx, master, { ...request, bossStageId: 8011302, isPractice: true });
  assert(practice.valid);
  const practiceReplay = { dynamicGame: practice.stage };
  const saveBefore = saves;
  assert.strictEqual(commitBattleResult(ctx, socket, practiceReplay), false);
  assert.strictEqual(saves, saveBefore);
}

function verifyRewardsAndRestart() {
  const shared = master.guildDungeon.shared["100021:3"];
  shared.boss.totalPoint = 15000;
  member.guildDungeon.shared["100021:3"] = JSON.parse(JSON.stringify(shared));
  let result = claimSeasonReward(ctx, master, { category: 0, rewardCountValue: 15000 });
  assert.strictEqual(result.errorCode, 0);
  assert(buildSeasonRewardAckPayload(result).length > 10);
  persistDirect(result);
  assert.strictEqual(claimSeasonReward(ctx, master, { category: 0, rewardCountValue: 30000 }).errorCode, ERRORS.INSUFFICIENT_POINT);
  result = claimSeasonReward(ctx, master, { category: 1, rewardCountValue: 1 });
  assert.strictEqual(result.errorCode, 0);
  persistDirect(result);

  master.guildDungeon.sessions["100021:1"] = { arenaRuns: [{ arenaId: 8010301, grade: 3, regDate: "1" }], bossRuns: 1, bossPoint: 12000, ticketBuyCount: 0, sessionRewardClaimed: false };
  const oldShared = { revision: 1, arenas: {}, boss: { stageId: 8011302, remainHp: 1000, totalPoint: 12000, extraPoint: 0, playUserUid: "0", orderIndex: 0 }, clearedBossStage: 1 };
  master.guildDungeon.shared["100021:1"] = oldShared;
  member.guildDungeon.shared["100021:1"] = JSON.parse(JSON.stringify(oldShared));
  result = claimSessionReward(ctx, master);
  assert.strictEqual(result.errorCode, 0);
  assert.strictEqual(result.stageIndex, 1);
  assert(result.rewardItems.some((item) => Number(item.itemId) === 21));
  assert(buildSessionRewardAckPayload(result).length > 10);
  persistDirect(result);
  assert.strictEqual(claimSessionReward(ctx, master).errorCode, ERRORS.SESSION_ALREADY_REWARD);

  const restartedUsers = JSON.parse(JSON.stringify(users));
  const restartCtx = { ...ctx, userDb: { users: restartedUsers } };
  const restarted = restartedUsers[master.userUid];
  const info = getGuildDungeonInfo(restartCtx, restarted, 7700n);
  assert.strictEqual(info.errorCode, 0);
  assert.strictEqual(info.boss.stageId, 8011302);
  assert.strictEqual(info.ticketBuyCount, 1);
  assert.strictEqual(info.arenas.find((arena) => arena.index === 8).flagIndex, 0);
  assert.strictEqual(buildGuildDungeonRewardInfoData(restarted, { ctx: restartCtx }).currentSeasonId, 100021);
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
    const info = getGuildDungeonInfo(ctx, master, 7700n);
    const memberInfo = getGuildDungeonMemberInfo(ctx, master, 7700n);
    const packets = [
      [3472, buildInfoAckPayload(info)],
      [3474, buildMemberInfoAckPayload(memberInfo)],
      [3476, buildSeasonRewardAckPayload({ errorCode: 0, category: 0, rewardCountValue: 15000, reward: { miscItems: [] } })],
      [3478, buildSessionRewardAckPayload({ errorCode: 0, stageIndex: 1, remainHp: 0, clearPoint: 12000, rewardItems: [], artifactItems: [] })],
      [3484, buildTicketBuyAckPayload({ errorCode: 0, currentTicketBuyCount: 1, costItem: null })],
      ...pushes.filter((packet) => [3479, 3480, 3481, 3482].includes(packet.packetId)).map((packet) => [packet.packetId, packet.payload]),
    ];
    for (const [packetId, payload] of packets) {
      const validation = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(validation.ok, validation.error || `managed schema rejected ${packetId}`);
    }
  } finally {
    host.close();
  }
}

function makeGuildUser(source, uid, guildUid, grade, nickname) {
  const user = JSON.parse(JSON.stringify(source));
  user.userUid = uid;
  user.friendCode = String(Number(uid) + 1000);
  user.nickname = nickname;
  user.guildUid = String(guildUid);
  user.guildMemberGrade = grade;
  user.guildName = "Frozen Guild";
  user.guild = { guildUid: String(guildUid), memberGrade: grade, name: "Frozen Guild", dungeonNotice: "" };
  delete user.guildDungeon;
  return user;
}

function socketFor(user) { return online.get(String(user.userUid)); }

function invoke(loaded, socket, payload) {
  socket.lastResponse = null;
  loaded.handle(ctx, socket, { packetId: loaded.packetId, sequence: 71, payload });
  assert(socket.lastResponse, `handler ${loaded.packetId} did not respond`);
  return socket.lastResponse;
}

function reject(packetId, user, payload, ackId, expectedError) {
  const before = JSON.stringify(user);
  const saveBefore = saves;
  const result = invoke(registry.get(packetId), socketFor(user), payload);
  assert.strictEqual(result.packetId, ackId);
  assert.strictEqual(errorCode(result.payload), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `failure ${packetId} mutated the user`);
  assert.strictEqual(saves, saveBefore, `failure ${packetId} saved`);
}

function errorCode(payload) { return readSignedVarInt(payload, 0).value; }
function nonCanonical(buffer) { const bytes = Buffer.from(buffer); bytes[bytes.length - 1] |= 0x80; return Buffer.concat([bytes, Buffer.from([0])]); }
function persistDirect(result) { if (!result || !result.changed) return; ctx.saveUserDb(); ctx.invalidateJoinLobbyAckPayloadCache(); }
