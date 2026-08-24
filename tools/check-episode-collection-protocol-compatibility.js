"use strict";

const assert = require("assert");
const path = require("path");
const {
  COLLECTION_ERRORS,
  PACKETS,
  createCollectionHandlers,
  getEpisodeRewardFlags,
} = require("../modules/collection");
const { getMiscItem } = require("../modules/inventory");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, writeSByte, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { MAIN_STORY_STAGE_CHAIN } = require("../stages/mainStoryStage");

const rootDir = path.resolve(__dirname, "..");
const episodeRows = readGameplayTableRecords("ab_script", "LUA_EPISODE_TEMPLET_V2.json", {
  rootDir,
  logLabel: "episode-collection-check",
}).map((row) => ({
  episodeID: Number(row && row.m_EpisodeID),
  difficulty: String(row && row.m_Difficulty).toUpperCase() === "HARD" ? 1 : 0,
  rates: [1, 2, 3].map((index) => Number(row && row[`m_CompleteRate_${index}`])),
  rewards: [1, 2, 3].map((index) => ({
    itemId: Number(row && row[`m_RewardID_${index}`]),
    value: Number(row && row[`m_RewardValue_${index}`]),
  })),
}));
const fixture = episodeRows.find((row) => {
  const stages = MAIN_STORY_STAGE_CHAIN.filter(
    (stage) => Number(stage.episodeId) === row.episodeID && Number(stage.difficulty || 0) === row.difficulty
  );
  return stages.length > 0 && row.rates.every((rate) => rate > 0) && row.rewards.every((reward) => reward.itemId > 0 && reward.value > 0);
});
assert(fixture, "frozen episode table and main-story chain must contain a three-reward fixture");
const fixtureStages = MAIN_STORY_STAGE_CHAIN.filter(
  (stage) => Number(stage.episodeId) === fixture.episodeID && Number(stage.difficulty || 0) === fixture.difficulty
);

const user = {
  userUid: "986000000000003",
  nickname: "EpisodeCollectionCheck",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
};
const socket = { session: { user } };
const handlers = new Map(createCollectionHandlers().map((entry) => [entry.packetId, entry]));
const managedWire = [];
let saves = 0;
let response = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => 5250083637907387904n,
  sendGameResponse(target, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, Buffer.alloc(0), false);
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
send(
  PACKETS.EPISODE_COMPLETE_REWARD_REQ,
  Buffer.concat([singleRequest(fixture.episodeID, fixture.difficulty, 0), Buffer.from([0])]),
  false
);
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, singleRequest(999999999, 0, 0));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, singleRequest(fixture.episodeID, 2, 0));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, singleRequest(fixture.episodeID, fixture.difficulty, 3));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, singleRequest(fixture.episodeID, fixture.difficulty, 0));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_NOT_ENOUGH_COUNT);
assert.strictEqual(saves, 0, "invalid and incomplete episode rewards must not persist");

user.mainStory.stages = user.mainStory.stages || {};
for (const stage of fixtureStages) {
  user.mainStory.stages[String(stage.stageId)] = { completed: true, missionResult1: true, missionResult2: true };
}

const singleBefore = BigInt(getMiscItem(user, fixture.rewards[0].itemId).countFree);
send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, singleRequest(fixture.episodeID, fixture.difficulty, 0));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.OK);
assert.strictEqual(
  BigInt(getMiscItem(user, fixture.rewards[0].itemId).countFree),
  singleBefore + BigInt(fixture.rewards[0].value)
);
send(PACKETS.EPISODE_COMPLETE_REWARD_REQ, singleRequest(fixture.episodeID, fixture.difficulty, 0));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ACK, COLLECTION_ERRORS.EPISODE_ALREADY_GIVEN);
assert.strictEqual(saves, 1, "single episode reward must save exactly once");

send(PACKETS.EPISODE_COMPLETE_REWARD_ALL_REQ, Buffer.alloc(0), false);
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ALL_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
send(PACKETS.EPISODE_COMPLETE_REWARD_ALL_REQ, allRequest(999999999));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ALL_ACK, COLLECTION_ERRORS.EPISODE_INVALID_REWARD);

const allRewardBefore = new Map();
const allRewardIncrements = new Map();
for (const reward of fixture.rewards.slice(1)) {
  if (!allRewardBefore.has(reward.itemId)) {
    allRewardBefore.set(reward.itemId, BigInt(getMiscItem(user, reward.itemId).countFree));
  }
  allRewardIncrements.set(reward.itemId, (allRewardIncrements.get(reward.itemId) || 0n) + BigInt(reward.value));
}
send(PACKETS.EPISODE_COMPLETE_REWARD_ALL_REQ, allRequest(fixture.episodeID));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ALL_ACK, COLLECTION_ERRORS.OK);
for (const [itemId, increment] of allRewardIncrements) {
  assert.strictEqual(BigInt(getMiscItem(user, itemId).countFree), allRewardBefore.get(itemId) + increment);
}
send(PACKETS.EPISODE_COMPLETE_REWARD_ALL_REQ, allRequest(fixture.episodeID));
assertAck(PACKETS.EPISODE_COMPLETE_REWARD_ALL_ACK, COLLECTION_ERRORS.EPISODE_ALREADY_GIVEN);
assert.strictEqual(saves, 2, "bulk episode rewards must save only the successful transition");
assert.deepStrictEqual(getEpisodeRewardFlags(user, fixture.episodeID, fixture.difficulty), [true, true, true]);

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(getEpisodeRewardFlags(restarted, fixture.episodeID, fixture.difficulty), [true, true, true]);

validateManagedSchemas();
console.log(`[episode-collection-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function singleRequest(episodeID, difficulty, rewardIndex) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(episodeID),
    writeSignedVarInt(difficulty),
    writeSByte(rewardIndex),
  ]);
}

function allRequest(episodeID) {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(episodeID)]);
}

function send(packetId, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing episode collection handler ${packetId}`);
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, expectedError) {
  assert(response, "episode collection handler must send an ACK");
  assert.strictEqual(response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expectedError);
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
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected episode collection packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
