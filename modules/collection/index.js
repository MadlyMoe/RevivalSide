const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");

const {
  writeBool,
  writeNullableObject,
  writeNullableObjectList,
  writeObjectList,
  writeSignedVarInt,
  readSignedVarInt,
  readSByte,
  buildRewardData,
} = require("../packet-codec");
const { createEmptyReward, mergeReward, grantRewardByType } = require("../reward");
const { getMiscItem, getSkinIds, toBigInt } = require("../inventory");
const { getArmyUnits, getArmyShips, getArmyTrophies, getArmyOperators } = require("../unit");
const { getUnitTemplet } = require("../game-data");
const { MAIN_STORY_STAGE_CHAIN, ensureMainStoryState, isSuppressedStoryOpenTag } = require("../../stages/mainStoryStage");

const ROOT_DIR = path.resolve(__dirname, "..", "..");

const PACKETS = Object.freeze({
  UNIT_MISSION_REWARD_REQ: 1438,
  UNIT_MISSION_REWARD_ACK: 1439,
  UNIT_MISSION_REWARD_ALL_REQ: 1440,
  UNIT_MISSION_REWARD_ALL_ACK: 1441,
  UNIT_MISSION_UPDATED_NOT: 1442,
  EPISODE_COMPLETE_REWARD_REQ: 1630,
  EPISODE_COMPLETE_REWARD_ACK: 1631,
  EPISODE_COMPLETE_REWARD_ALL_REQ: 1632,
  EPISODE_COMPLETE_REWARD_ALL_ACK: 1633,
  TEAM_COLLECTION_REWARD_REQ: 1641,
  TEAM_COLLECTION_REWARD_ACK: 1642,
  MISC_COLLECTION_REWARD_REQ: 1656,
  MISC_COLLECTION_REWARD_ACK: 1657,
  MISC_COLLECTION_REWARD_ALL_REQ: 1658,
  MISC_COLLECTION_REWARD_ALL_ACK: 1659,
});

const MISC_TYPE_ENUM = Object.freeze({
  MISC: 0,
  PACKAGE: 1,
  RANDOMBOX: 2,
  RESOURCE: 3,
  EMBLEM: 4,
  EMBLEM_RANK: 5,
  VIEW: 6,
  CHOICE_UNIT: 7,
  CHOICE_SHIP: 8,
  CHOICE_EQUIP: 9,
  CHOICE_MISC: 10,
  CHOICE_MOLD: 11,
  CHOICE_OPERATOR: 12,
  PIECE: 13,
  BACKGROUND: 14,
  FRAME: 15,
  SELFIE_FRAME: 15,
  CUSTOM_PACKAGE: 16,
  CONTRACT: 17,
  INTERIOR: 18,
  CHOICE_FURNITURE: 19,
  CHOICE_SKIN: 20,
  TITLE: 21,
});

let cachedTables = null;

function createCollectionHandlers() {
  return [
    {
      packetId: PACKETS.UNIT_MISSION_REWARD_REQ,
      name: "UNIT_MISSION_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeUnitMissionRewardReq(ctx, packet.payload);
        const result = claimUnitMission(ctx, user, req);
        console.log(
          `[collection:unit-mission] claim unitId=${result.missionData.unitId} missionId=${result.missionData.missionId} stepId=${result.missionData.stepId}`
        );
        send(ctx, socket, packet, PACKETS.UNIT_MISSION_REWARD_ACK, buildUnitMissionRewardAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.UNIT_MISSION_REWARD_ALL_REQ,
      name: "UNIT_MISSION_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeUnitMissionRewardAllReq(ctx, packet.payload);
        const result = claimAllUnitMissions(ctx, user, req.unitId);
        console.log(`[collection:unit-mission] claim-all unitId=${req.unitId} count=${result.missionData.length}`);
        send(ctx, socket, packet, PACKETS.UNIT_MISSION_REWARD_ALL_ACK, buildUnitMissionRewardAllAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.EPISODE_COMPLETE_REWARD_REQ,
      name: "EPISODE_COMPLETE_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeEpisodeCompleteRewardReq(ctx, packet.payload);
        const result = claimEpisodeReward(ctx, user, req);
        console.log(
          `[collection:episode] claim episodeID=${req.episodeID} difficulty=${req.episodeDifficulty} rewardIndex=${req.rewardIndex}`
        );
        send(ctx, socket, packet, PACKETS.EPISODE_COMPLETE_REWARD_ACK, buildEpisodeRewardAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.EPISODE_COMPLETE_REWARD_ALL_REQ,
      name: "EPISODE_COMPLETE_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeEpisodeCompleteRewardAllReq(ctx, packet.payload);
        const result = claimAllEpisodeRewards(ctx, user, req.episodeID);
        console.log(`[collection:episode] claim-all episodeID=${req.episodeID} count=${result.episodeCompleteData.length}`);
        send(ctx, socket, packet, PACKETS.EPISODE_COMPLETE_REWARD_ALL_ACK, buildEpisodeRewardAllAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.TEAM_COLLECTION_REWARD_REQ,
      name: "TEAM_COLLECTION_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeSingleIntReq(ctx, packet.payload, "teamID");
        const result = claimTeamCollectionReward(ctx, user, req.teamID);
        console.log(`[collection:team] claim teamID=${req.teamID}`);
        send(ctx, socket, packet, PACKETS.TEAM_COLLECTION_REWARD_ACK, buildTeamCollectionRewardAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.MISC_COLLECTION_REWARD_REQ,
      name: "MISC_COLLECTION_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeSingleIntReq(ctx, packet.payload, "miscId");
        const result = claimMiscCollectionReward(ctx, user, req.miscId);
        console.log(`[collection:misc] claim miscId=${req.miscId}`);
        send(ctx, socket, packet, PACKETS.MISC_COLLECTION_REWARD_ACK, buildMiscCollectionRewardAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
    {
      packetId: PACKETS.MISC_COLLECTION_REWARD_ALL_REQ,
      name: "MISC_COLLECTION_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeMiscCollectionRewardAllReq(ctx, packet.payload);
        const result = claimAllMiscCollectionRewards(ctx, user, req.miscType);
        console.log(`[collection:misc] claim-all miscType=${req.miscType} count=${result.miscCollectionDatas.length}`);
        send(ctx, socket, packet, PACKETS.MISC_COLLECTION_REWARD_ALL_ACK, buildMiscCollectionRewardAllAckPayload(result));
        persist(ctx, user);
        return true;
      },
    },
  ];
}

function ensureCollectionState(user) {
  if (!user || typeof user !== "object") return {};
  user.collection = user.collection && typeof user.collection === "object" ? user.collection : {};
  user.collection.units = uniquePositiveInts(user.collection.units);
  user.collection.ships = uniquePositiveInts(user.collection.ships);
  user.collection.trophies = uniquePositiveInts(user.collection.trophies);
  user.collection.operators = uniquePositiveInts(user.collection.operators);
  user.collection.skins = uniquePositiveInts(user.collection.skins);
  user.collection.unitMissionsClaimed =
    user.collection.unitMissionsClaimed && typeof user.collection.unitMissionsClaimed === "object"
      ? user.collection.unitMissionsClaimed
      : {};
  user.collection.teamRewards =
    user.collection.teamRewards && typeof user.collection.teamRewards === "object" ? user.collection.teamRewards : {};
  user.collection.miscRewards =
    user.collection.miscRewards && typeof user.collection.miscRewards === "object" ? user.collection.miscRewards : {};
  user.collection.episodeRewards =
    user.collection.episodeRewards && typeof user.collection.episodeRewards === "object" ? user.collection.episodeRewards : {};
  return user.collection;
}

function hasCollectionState(user) {
  if (!user || typeof user !== "object" || !user.collection) return false;
  const state = ensureCollectionState(user);
  return (
    state.units.length > 0 ||
    state.ships.length > 0 ||
    state.trophies.length > 0 ||
    state.operators.length > 0 ||
    state.skins.length > 0 ||
    Object.keys(state.unitMissionsClaimed).length > 0 ||
    Object.keys(state.teamRewards).length > 0 ||
    Object.keys(state.miscRewards).length > 0 ||
    Object.keys(state.episodeRewards).length > 0
  );
}

function claimUnitMission(ctx, user, req) {
  const state = ensureCollectionState(user);
  const row = findUnitMissionRow(req);
  const missionData = buildUnitMissionState({
    unitId: req.unitId,
    missionId: row ? row.missionId : req.missionId,
    stepId: row ? row.stepId : req.stepId,
  });
  const key = unitMissionKey(missionData);
  const reward = createEmptyReward();
  if (row && !state.unitMissionsClaimed[key] && isUnitMissionEligible(user, missionData, row)) {
    state.unitMissionsClaimed[key] = {
      unitId: missionData.unitId,
      missionId: missionData.missionId,
      stepId: missionData.stepId,
      claimedAt: new Date().toISOString(),
    };
    mergeReward(reward, grantTableReward(ctx, user, row, "m_Reward"));
  }
  return { missionData, reward };
}

function claimAllUnitMissions(ctx, user, unitId = 0) {
  const state = ensureCollectionState(user);
  const reward = createEmptyReward();
  const missionData = [];
  for (const entry of getRewardEnableUnitMissionStates(user, { unitIds: unitId > 0 ? [unitId] : null })) {
    const key = unitMissionKey(entry);
    if (state.unitMissionsClaimed[key]) continue;
    state.unitMissionsClaimed[key] = {
      unitId: entry.unitId,
      missionId: entry.missionId,
      stepId: entry.stepId,
      claimedAt: new Date().toISOString(),
    };
    missionData.push(entry);
    mergeReward(reward, grantTableReward(ctx, user, entry.row, "m_Reward"));
  }
  return { missionData, reward };
}

function getCompletedUnitMissionStates(user) {
  const state = ensureCollectionState(user);
  return Object.values(state.unitMissionsClaimed)
    .map(buildUnitMissionState)
    .filter((entry) => entry.unitId > 0 && entry.missionId > 0 && entry.stepId > 0)
    .sort(compareUnitMissionState);
}

function getRewardEnableUnitMissionStates(user, options = {}) {
  const state = ensureCollectionState(user);
  const tables = loadCollectionTables();
  const wantedUnitIds = options.unitIds
    ? new Set((Array.isArray(options.unitIds) ? options.unitIds : [options.unitIds]).map(Number).filter((id) => id > 0))
    : null;
  const result = [];

  let unitEntries;
  if (wantedUnitIds && wantedUnitIds.size > 0) {
    const levelsByUnitId = new Map();
    const units = user && user.army && user.army.units ? Object.values(user.army.units) : [];
    for (const unit of units) {
      const uid = Number(unit && unit.unitId);
      if (wantedUnitIds.has(uid)) {
        levelsByUnitId.set(uid, Math.max(levelsByUnitId.get(uid) || 1, Number(unit.level || 1) || 1));
      }
    }
    unitEntries = Array.from(levelsByUnitId.entries());
  } else {
    const owned = buildOwnedCollectionIds(user);
    unitEntries = Array.from(owned.normalUnitLevels.entries());
  }

  for (const [unitId, level] of unitEntries) {
    if (wantedUnitIds && !wantedUnitIds.has(unitId)) continue;
    const templet = getUnitTemplet(unitId) || {};
    const grade = String(templet.m_NKM_UNIT_GRADE || "");
    const rows = tables.unitMissionsByGrade.get(grade) || [];
    for (const row of rows) {
      const entry = buildUnitMissionState({ unitId, missionId: row.missionId, stepId: row.stepId });
      const key = unitMissionKey(entry);
      if (state.unitMissionsClaimed[key]) continue;
      if (String(row.condition || "") === "UNIT_GROWTH_LEVEL" && level < Number(row.value || 0)) continue;
      result.push({ ...entry, row });
    }
  }
  return result.sort(compareUnitMissionState);
}

function buildCompletedUnitMissionPayloads(user) {
  return getCompletedUnitMissionStates(user).map(buildUnitMissionData);
}

function buildRewardEnableUnitMissionPayloads(user, options = {}) {
  return getRewardEnableUnitMissionStates(user, options).map(buildUnitMissionData);
}

function buildUnitMissionUpdatedNotPayload(user, options = {}) {
  return writeNullableObjectList(buildRewardEnableUnitMissionPayloads(user, options));
}

function sendUnitMissionUpdatedNot(ctx, socket, user, options = {}) {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function" || !socket || !socket.session || !socket.session.gameReplay) return;
  const missionStates = getRewardEnableUnitMissionStates(user, options);
  if (missionStates.length === 0) return;
  const payload = writeNullableObjectList(missionStates.map(buildUnitMissionData));
  ctx.sendServerGamePacket(socket, PACKETS.UNIT_MISSION_UPDATED_NOT, payload, "unit-mission-updated");
}

function claimTeamCollectionReward(ctx, user, teamID) {
  const state = ensureCollectionState(user);
  const tables = loadCollectionTables();
  const team = tables.teamGroups.get(Number(teamID));
  const data = { teamID: Number(teamID) || 0, reward: false };
  const reward = createEmptyReward();
  if (team) {
    data.teamID = team.teamID;
    data.reward = true;
    if (!state.teamRewards[String(team.teamID)] && isTeamCollectionEligible(user, team)) {
      state.teamRewards[String(team.teamID)] = { teamID: team.teamID, claimedAt: new Date().toISOString() };
      mergeReward(reward, grantTeamReward(ctx, user, team));
    }
  }
  data.reward = Boolean(state.teamRewards[String(data.teamID)]);
  return { teamCollectionData: data, reward };
}

function buildTeamCollectionEntries(user) {
  const state = ensureCollectionState(user);
  return Object.keys(state.teamRewards)
    .map((key) => Number(key))
    .filter((teamID) => Number.isInteger(teamID) && teamID > 0)
    .sort((a, b) => a - b)
    .map((teamID) => [teamID, buildTeamCollectionData({ teamID, reward: true })]);
}

function claimMiscCollectionReward(ctx, user, miscId) {
  const state = ensureCollectionState(user);
  const tables = loadCollectionTables();
  const row = tables.miscById.get(Number(miscId));
  const data = { miscId: Number(miscId) || 0, reward: false };
  const reward = createEmptyReward();
  if (row) {
    data.miscId = row.miscId;
    data.reward = true;
    if (!state.miscRewards[String(row.miscId)] && isMiscCollectionEligible(user, row)) {
      state.miscRewards[String(row.miscId)] = { miscId: row.miscId, claimedAt: new Date().toISOString() };
      mergeReward(reward, grantMiscCollectionReward(ctx, user, row));
    }
  }
  data.reward = Boolean(state.miscRewards[String(data.miscId)]);
  return { miscCollectionData: data, reward };
}

function claimAllMiscCollectionRewards(ctx, user, miscType) {
  const state = ensureCollectionState(user);
  const tables = loadCollectionTables();
  const numericType = Number(miscType || 0);
  const rows = tables.miscByType.get(numericType) || [];
  const reward = createEmptyReward();
  const miscCollectionDatas = [];
  for (const row of rows) {
    if (state.miscRewards[String(row.miscId)] || !isMiscCollectionEligible(user, row)) continue;
    state.miscRewards[String(row.miscId)] = { miscId: row.miscId, claimedAt: new Date().toISOString() };
    miscCollectionDatas.push({ miscId: row.miscId, reward: true });
    mergeReward(reward, grantMiscCollectionReward(ctx, user, row));
  }
  return { miscType: numericType, miscCollectionDatas, reward };
}

function buildMiscCollectionEntries(user) {
  const state = ensureCollectionState(user);
  return Object.keys(state.miscRewards)
    .map((key) => Number(key))
    .filter((miscId) => Number.isInteger(miscId) && miscId > 0)
    .sort((a, b) => a - b)
    .map((miscId) => [miscId, buildMiscCollectionData({ miscId, reward: true })]);
}

function claimEpisodeReward(ctx, user, req) {
  const row = findEpisodeRewardRow(req.episodeID, req.episodeDifficulty);
  const difficulty = row ? row.difficulty : normalizeEpisodeDifficulty(req.episodeDifficulty);
  const rewardIndex = normalizeRewardIndex(req.rewardIndex);
  const state = ensureCollectionState(user);
  const key = episodeRewardKey(req.episodeID, difficulty);
  const flags = normalizeRewardFlags(state.episodeRewards[key]);
  const reward = createEmptyReward();
  if (row && rewardIndex >= 0 && rewardIndex < 3 && isEpisodeRewardEligible(user, row, rewardIndex) && !flags[rewardIndex]) {
    flags[rewardIndex] = true;
    state.episodeRewards[key] = flags;
    mergeReward(reward, grantEpisodeReward(ctx, user, row, rewardIndex));
  } else {
    state.episodeRewards[key] = flags;
  }
  return {
    reward,
    episodeCompleteData: buildEpisodeCompleteState(user, Number(req.episodeID || 0), difficulty),
  };
}

function claimAllEpisodeRewards(ctx, user, episodeID = 0) {
  const tables = loadCollectionTables();
  const state = ensureCollectionState(user);
  const reward = createEmptyReward();
  const episodeCompleteData = [];
  const wantedEpisodeID = Number(episodeID || 0);
  for (const row of tables.episodeRows) {
    if (wantedEpisodeID > 0 && row.episodeID !== wantedEpisodeID) continue;
    if (!row.rewards.some((rewardEntry) => rewardEntry && rewardEntry.type && rewardEntry.id && rewardEntry.value)) continue;
    const key = episodeRewardKey(row.episodeID, row.difficulty);
    const flags = normalizeRewardFlags(state.episodeRewards[key]);
    let changed = false;
    for (let rewardIndex = 0; rewardIndex < 3; rewardIndex += 1) {
      if (flags[rewardIndex] || !isEpisodeRewardEligible(user, row, rewardIndex)) continue;
      flags[rewardIndex] = true;
      changed = true;
      mergeReward(reward, grantEpisodeReward(ctx, user, row, rewardIndex));
    }
    if (changed) state.episodeRewards[key] = flags;
    const data = buildEpisodeCompleteState(user, row.episodeID, row.difficulty);
    if (data && data.completeCount > 0) episodeCompleteData.push(data);
  }
  return { reward, episodeCompleteData };
}

function getEpisodeRewardFlags(user, episodeID, difficulty = 0) {
  const state = ensureCollectionState(user);
  return normalizeRewardFlags(state.episodeRewards[episodeRewardKey(episodeID, difficulty)]);
}

function buildEpisodeCompleteState(user, episodeID, difficulty = 0) {
  const episodeId = Number(episodeID || 0);
  const numericDifficulty = normalizeEpisodeDifficulty(difficulty);
  const completeCount = getMainStoryEpisodeCompleteMedalCount(user, episodeId, numericDifficulty);
  if (completeCount <= 0) {
    return {
      episodeID: episodeId,
      difficulty: numericDifficulty,
      completeCount: 0,
      rewardFlags: getEpisodeRewardFlags(user, episodeId, numericDifficulty),
    };
  }
  return {
    episodeID: episodeId,
    difficulty: numericDifficulty,
    completeCount,
    rewardFlags: getEpisodeRewardFlags(user, episodeId, numericDifficulty),
  };
}

function buildEpisodeCompleteData(dataOrEpisodeId, difficulty = 0, completeCount = 0, rewardFlags = []) {
  const data =
    dataOrEpisodeId && typeof dataOrEpisodeId === "object"
      ? dataOrEpisodeId
      : { episodeID: dataOrEpisodeId, difficulty, completeCount, rewardFlags };
  return Buffer.concat([
    writeSignedVarInt(Number(data.episodeID || data.episodeId || 0)),
    writeSignedVarInt(normalizeEpisodeDifficulty(data.difficulty)),
    writeSignedVarInt(Math.max(0, Number(data.completeCount || 0) || 0)),
    writeBoolList(normalizeRewardFlags(data.rewardFlags)),
  ]);
}

function getMainStoryEpisodeCompleteMedalCount(user, episodeID, difficulty = 0) {
  if (!user || typeof user !== "object") return 0;
  const mainStory = ensureMainStoryState(user);
  const states = mainStory && mainStory.stages && typeof mainStory.stages === "object" ? mainStory.stages : {};
  const numericDifficulty = normalizeEpisodeDifficulty(difficulty);
  return MAIN_STORY_STAGE_CHAIN.reduce((total, stage) => {
    if (Number(stage.episodeId || 0) !== Number(episodeID || 0)) return total;
    if (Number(stage.difficulty || 0) !== numericDifficulty) return total;
    if (isSuppressedStoryOpenTag(stage.openTag)) return total;
    const state = states[String(stage.stageId)] || {};
    if (state.completed !== true) return total;
    return total + mainStoryEpisodeMedalValue(stage, state);
  }, 0);
}

function getMainStoryEpisodeTotalMedalCount(episodeID, difficulty = 0) {
  const numericDifficulty = normalizeEpisodeDifficulty(difficulty);
  return MAIN_STORY_STAGE_CHAIN.reduce(
    (total, stage) =>
      Number(stage.episodeId || 0) === Number(episodeID || 0) &&
      Number(stage.difficulty || 0) === numericDifficulty &&
      !isSuppressedStoryOpenTag(stage.openTag)
        ? total + mainStoryEpisodeMedalValue(stage)
        : total,
    0
  );
}

function mainStoryStageMedalValue(stage, state = {}) {
  if (!stage) return 0;
  if (stage.cutsceneOnly || stage.tutorial) return 1;
  if (state && state.completed === true) {
    return 1 + (state.missionResult1 !== false ? 1 : 0) + (state.missionResult2 !== false ? 1 : 0);
  }
  return 3;
}

function mainStoryEpisodeMedalValue(stage, state = {}) {
  if (!stage) return 0;
  return mainStoryStageMedalValue(stage, state);
}

function isEpisodeRewardEligible(user, row, rewardIndex) {
  if (!row) return false;
  const reward = row.rewards[rewardIndex];
  if (!reward || !reward.type || !reward.id || !reward.value) return false;
  const requiredRate = Number(row.completeRates[rewardIndex] || 0);
  if (requiredRate <= 0) return false;
  const total = getMainStoryEpisodeTotalMedalCount(row.episodeID, row.difficulty);
  if (total <= 0) return false;
  const complete = getMainStoryEpisodeCompleteMedalCount(user, row.episodeID, row.difficulty);
  return Math.floor((complete * 100) / total) >= requiredRate;
}

function isUnitMissionEligible(user, missionData, row) {
  if (!row) return false;
  const owned = buildOwnedCollectionIds(user);
  const level = Number(owned.normalUnitLevels.get(Number(missionData.unitId)) || 0);
  if (String(row.condition || "") === "UNIT_GROWTH_LEVEL") return level >= Number(row.value || 0);
  return level > 0;
}

function isTeamCollectionEligible(user, team) {
  if (!team) return false;
  const owned = buildOwnedCollectionIds(user);
  let count = 0;
  for (const unitId of team.unitIds) {
    if (owned.allIds.has(Number(unitId))) count += 1;
  }
  return count >= Math.max(1, Number(team.rewardCriteria || team.unitIds.length || 1));
}

function isMiscCollectionEligible(user, row) {
  if (!row) return false;
  if (row.defaultCollection) return true;
  const itemType = String(row.collectionItemType || "");
  const itemId = Number(row.collectionItemId || 0);
  if (!itemId) return false;
  if (itemType === "RT_MISC" || itemType === "RT_ITEM_MISC" || itemType === "RT_RESOURCE") {
    const item = getMiscItem(user, itemId);
    return toBigInt(item && item.countFree, 0n) + toBigInt(item && item.countPaid, 0n) > 0n;
  }
  if (itemType === "RT_SKIN") return getSkinIds(user).includes(itemId);
  if (itemType === "RT_UNIT" || itemType === "RT_SHIP" || itemType === "RT_OPERATOR") {
    return buildOwnedCollectionIds(user).allIds.has(itemId);
  }
  return false;
}

function buildOwnedCollectionIds(user) {
  const state = ensureCollectionState(user);
  const normalUnitLevels = new Map();
  const shipLevels = new Map();
  const operatorLevels = new Map();
  const allIds = new Set();

  for (const unit of getArmyUnits(user)) {
    const unitId = Number(unit && unit.unitId);
    if (!Number.isInteger(unitId) || unitId <= 0) continue;
    const level = Math.max(1, Number(unit.level || 1) || 1);
    normalUnitLevels.set(unitId, Math.max(Number(normalUnitLevels.get(unitId) || 0), level));
    addIllustratedUnitId(allIds, unitId);
  }
  for (const ship of getArmyShips(user)) {
    const unitId = Number(ship && ship.unitId);
    if (!Number.isInteger(unitId) || unitId <= 0) continue;
    const level = Math.max(1, Number(ship.level || 1) || 1);
    shipLevels.set(unitId, Math.max(Number(shipLevels.get(unitId) || 0), level));
    addIllustratedUnitId(allIds, unitId);
  }
  for (const trophy of getArmyTrophies(user)) {
    addIllustratedUnitId(allIds, trophy && trophy.unitId);
  }
  for (const operator of getArmyOperators(user)) {
    const unitId = Number((operator && (operator.id || operator.unitId)) || 0);
    if (!Number.isInteger(unitId) || unitId <= 0) continue;
    const level = Math.max(1, Number(operator.level || 1) || 1);
    operatorLevels.set(unitId, Math.max(Number(operatorLevels.get(unitId) || 0), level));
    addIllustratedUnitId(allIds, unitId);
  }
  for (const unitId of state.units) addIllustratedUnitId(allIds, unitId);
  for (const unitId of state.ships) addIllustratedUnitId(allIds, unitId);
  for (const unitId of state.trophies) addIllustratedUnitId(allIds, unitId);
  for (const unitId of state.operators) addIllustratedUnitId(allIds, unitId);

  return { normalUnitLevels, shipLevels, operatorLevels, allIds };
}

function buildIllustratedUnitIds(user) {
  const state = ensureCollectionState(user);
  const ids = new Set();

  for (const unit of getArmyUnits(user)) addIllustratedUnitId(ids, unit && unit.unitId);
  for (const ship of getArmyShips(user)) addIllustratedUnitId(ids, ship && ship.unitId);
  for (const trophy of getArmyTrophies(user)) addIllustratedUnitId(ids, trophy && trophy.unitId);
  for (const operator of getArmyOperators(user)) {
    addIllustratedUnitId(ids, operator && (operator.id || operator.unitId));
  }
  for (const unitId of state.units) addIllustratedUnitId(ids, unitId);
  for (const unitId of state.ships) addIllustratedUnitId(ids, unitId);
  for (const unitId of state.trophies) addIllustratedUnitId(ids, unitId);
  for (const unitId of state.operators) addIllustratedUnitId(ids, unitId);

  return Array.from(ids).sort((a, b) => a - b);
}

function addIllustratedUnitId(ids, unitId) {
  const id = Number(unitId);
  if (!Number.isInteger(id) || id <= 0) return;
  const templet = getUnitTemplet(id);
  if (!templet) return;
  const baseId = Number(templet.m_BaseUnitID || 0);
  if (Number.isInteger(baseId) && baseId > 0) ids.add(baseId);
  ids.add(id);
}

function findUnitMissionRow(req) {
  const tables = loadCollectionTables();
  const missionId = Number(req && req.missionId);
  const stepId = Number(req && req.stepId);
  return tables.unitMissionByKey.get(`${missionId}:${stepId}`) || null;
}

function findEpisodeRewardRow(episodeID, difficulty = 0) {
  const tables = loadCollectionTables();
  return tables.episodeByKey.get(episodeRewardKey(episodeID, difficulty)) || null;
}

function grantTableReward(ctx, user, row, prefix) {
  if (!row) return createEmptyReward();
  return grantRewardByType(
    ctx,
    user,
    row[`${prefix}Type`] || row.rewardType,
    row[`${prefix}ID`] || row.rewardId,
    row[`${prefix}Value`] || row.rewardValue || 1,
    null,
    0,
    { regDate: ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n }
  );
}

function grantTeamReward(ctx, user, team) {
  return grantRewardByType(ctx, user, team.rewardType, team.rewardId, team.rewardValue || 1, null, 0, {
    regDate: ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n,
  });
}

function grantMiscCollectionReward(ctx, user, row) {
  return grantRewardByType(ctx, user, row.collectionRewardType, row.collectionRewardId, row.collectionRewardValue || 1, null, 0, {
    regDate: ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n,
  });
}

function grantEpisodeReward(ctx, user, row, rewardIndex) {
  const reward = row && row.rewards && row.rewards[rewardIndex];
  if (!reward) return createEmptyReward();
  return grantRewardByType(ctx, user, reward.type, reward.id, reward.value || 1, null, 0, {
    regDate: ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n,
  });
}

function buildUnitMissionRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildUnitMissionData(result.missionData)),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
  ]);
}

function buildUnitMissionRewardAllAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList((result.missionData || []).map(buildUnitMissionData)),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
  ]);
}

function buildEpisodeRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
    writeNullableObject(buildEpisodeCompleteData(result.episodeCompleteData)),
  ]);
}

function buildEpisodeRewardAllAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
    writeNullableObjectList((result.episodeCompleteData || []).map(buildEpisodeCompleteData)),
  ]);
}

function buildTeamCollectionRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
    writeNullableObject(buildTeamCollectionData(result.teamCollectionData)),
  ]);
}

function buildMiscCollectionRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
    writeNullableObject(buildMiscCollectionData(result.miscCollectionData)),
  ]);
}

function buildMiscCollectionRewardAllAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(result.miscType || 0)),
    writeNullableObject(buildRewardData(result.reward || createEmptyReward())),
    writeNullableObjectList((result.miscCollectionDatas || []).map(buildMiscCollectionData)),
  ]);
}

function buildUnitMissionData(data) {
  const mission = buildUnitMissionState(data);
  return Buffer.concat([
    writeSignedVarInt(mission.unitId),
    writeSignedVarInt(mission.missionId),
    writeSignedVarInt(mission.stepId),
  ]);
}

function buildTeamCollectionData(data) {
  return Buffer.concat([writeSignedVarInt(Number(data && data.teamID) || 0), writeBool(Boolean(data && data.reward))]);
}

function buildMiscCollectionData(data) {
  return Buffer.concat([writeSignedVarInt(Number(data && data.miscId) || 0), writeBool(Boolean(data && data.reward))]);
}

function decodeUnitMissionRewardReq(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  let offset = 0;
  const unitId = safeReadInt(buffer, offset);
  offset = unitId.offset;
  const missionId = safeReadInt(buffer, offset);
  offset = missionId.offset;
  const stepId = safeReadInt(buffer, offset);
  return { unitId: unitId.value, missionId: missionId.value, stepId: stepId.value };
}

function decodeUnitMissionRewardAllReq(ctx, payload) {
  return decodeSingleIntReq(ctx, payload, "unitId");
}

function decodeEpisodeCompleteRewardReq(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  let offset = 0;
  const first = safeReadInt(buffer, offset);
  offset = first.offset;
  const second = safeReadInt(buffer, offset);
  if (first.value > 1) {
    const reward = safeReadSByte(buffer, second.offset);
    return {
      episodeID: first.value,
      episodeDifficulty: normalizeEpisodeDifficulty(second.value),
      rewardIndex: reward.value,
    };
  }
  offset = second.offset;
  const third = safeReadInt(buffer, offset);
  offset = third.offset;
  const reward = safeReadSByte(buffer, offset);
  return {
    episodeID: second.value,
    episodeDifficulty: normalizeEpisodeDifficulty(third.value),
    rewardIndex: reward.value,
  };
}

function decodeEpisodeCompleteRewardAllReq(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  let offset = 0;
  const first = safeReadInt(buffer, offset);
  offset = first.offset;
  const second = safeReadInt(buffer, offset);
  return { episodeID: first.value > 1 ? first.value : second.value };
}

function decodeSingleIntReq(ctx, payload, key) {
  const buffer = decrypt(ctx, payload);
  const value = safeReadInt(buffer, 0);
  return { [key]: value.value };
}

function decodeMiscCollectionRewardAllReq(ctx, payload) {
  const req = decodeSingleIntReq(ctx, payload, "miscType");
  return { miscType: Number(req.miscType || 0) };
}

function safeReadInt(buffer, offset) {
  try {
    return readSignedVarInt(buffer, offset);
  } catch (_) {
    return { value: 0, offset };
  }
}

function safeReadSByte(buffer, offset) {
  try {
    return readSByte(buffer, offset);
  } catch (_) {
    return { value: 0, offset };
  }
}

function decrypt(ctx, payload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function send(ctx, socket, packet, packetId, payload) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, "collection");
    return;
  }
  ctx.sendResponse(socket, packet.sequence, packetId, () => ctx.buildEncryptedPacket(packet.sequence, packetId, payload));
}

function persist(ctx, user) {
  if (!ctx || (ctx.config && ctx.config.USE_LOCAL_USER_DB === false)) return;
  const userUid = user && (user.userUid || user.m_UserUID);
  if (typeof ctx.scheduleDebouncedUserSave === "function") {
    ctx.scheduleDebouncedUserSave(userUid);
  } else if (typeof ctx.saveUserDb === "function") {
    ctx.saveUserDb(userUid);
  }
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function loadCollectionTables() {
  if (cachedTables) return cachedTables;

  const unitMissions = readRecords("ab_script", "LUA_UNIT_MISSION_TEMPLET.json").map((row) => ({
    grade: String(row.Unit_Grade || ""),
    missionId: Number(row.MissionID || 0),
    stepId: Number(row.StepID || 0),
    condition: String(row.Mission_Condition || ""),
    value: Number(row.Mission_Value || 0),
    m_RewardType: row.m_RewardType,
    m_RewardID: Number(row.m_RewardID || 0),
    m_RewardValue: Number(row.m_RewardValue || 0),
  }));
  const unitMissionsByGrade = new Map();
  const unitMissionByKey = new Map();
  for (const row of unitMissions) {
    if (!row.grade || !row.missionId || !row.stepId) continue;
    if (!unitMissionsByGrade.has(row.grade)) unitMissionsByGrade.set(row.grade, []);
    unitMissionsByGrade.get(row.grade).push(row);
    unitMissionByKey.set(`${row.missionId}:${row.stepId}`, row);
  }
  for (const rows of unitMissionsByGrade.values()) rows.sort((a, b) => a.missionId - b.missionId || a.stepId - b.stepId);

  const teamGroups = new Map();
  for (const row of readRecords("ab_script", "LUA_COLLECTION_TEAMUP_TEMPLET.json")) {
    const teamID = Number(row.m_TeamID || 0);
    const unitID = Number(row.m_UnitID || 0);
    if (!teamID || !unitID) continue;
    if (!teamGroups.has(teamID)) {
      teamGroups.set(teamID, {
        teamID,
        unitIds: [],
        rewardCriteria: Number(row.m_RewardCriteria || 0),
        rewardType: row.m_RewardType,
        rewardId: Number(row.m_RewardID || 0),
        rewardValue: Number(row.m_RewardValue || 0),
      });
    }
    const team = teamGroups.get(teamID);
    if (!team.unitIds.includes(unitID)) team.unitIds.push(unitID);
  }

  const miscById = new Map();
  const miscByType = new Map();
  for (const row of readRecords("ab_script", "LUA_COLLECTION_V2_MISC.json")) {
    const tableId = Number(row.ID || 0);
    const collectionItemId = Number(row.CollectionItemID || 0);
    if (!collectionItemId) continue;
    const misc = {
      tableId,
      miscId: collectionItemId,
      miscType: mapCollectionMiscType(row.MiscType),
      miscTypeName: String(row.MiscType || ""),
      collectionItemType: String(row.CollectionItemType || ""),
      collectionItemId,
      collectionRewardType: String(row.CollectionRewardType || ""),
      collectionRewardId: Number(row.CollectionRewardID || 0),
      collectionRewardValue: Number(row.CollectionRewardValue || 0),
      defaultCollection: Boolean(row.DefaultCollection),
    };
    miscById.set(collectionItemId, misc);
    if (!miscByType.has(misc.miscType)) miscByType.set(misc.miscType, []);
    miscByType.get(misc.miscType).push(misc);
  }

  const episodeRows = readRecords("ab_script", "LUA_EPISODE_TEMPLET_V2.json")
    .map((row) => ({
      episodeID: Number(row.m_EpisodeID || 0),
      difficulty: normalizeEpisodeDifficulty(row.m_Difficulty),
      completeRates: [Number(row.m_CompleteRate_1 || 0), Number(row.m_CompleteRate_2 || 0), Number(row.m_CompleteRate_3 || 0)],
      rewards: [1, 2, 3].map((index) => ({
        type: row[`m_RewardType_${index}`],
        id: Number(row[`m_RewardID_${index}`] || 0),
        value: Number(row[`m_RewardValue_${index}`] || 0),
      })),
    }))
    .filter((row) => row.episodeID > 0);
  const episodeByKey = new Map();
  for (const row of episodeRows) episodeByKey.set(episodeRewardKey(row.episodeID, row.difficulty), row);

  cachedTables = { unitMissionsByGrade, unitMissionByKey, teamGroups, miscById, miscByType, episodeRows, episodeByKey };
  return cachedTables;
}

function readRecords(directory, fileName) {
  return readGameplayTableRecords(directory, fileName, { rootDir: ROOT_DIR, logLabel: "collection" });
}

function mapCollectionMiscType(value) {
  const key = String(value || "").replace(/^IMT_/i, "").toUpperCase();
  return Number(MISC_TYPE_ENUM[key] != null ? MISC_TYPE_ENUM[key] : MISC_TYPE_ENUM.MISC);
}

function normalizeEpisodeDifficulty(value) {
  if (String(value || "").toUpperCase() === "HARD") return 1;
  const numeric = Number(value || 0);
  return numeric === 1 ? 1 : 0;
}

function normalizeRewardIndex(value) {
  const numeric = Number(value || 0);
  return numeric >= 0 && numeric <= 2 ? numeric : -1;
}

function normalizeRewardFlags(values) {
  const list = Array.isArray(values) ? values : [];
  return [Boolean(list[0]), Boolean(list[1]), Boolean(list[2])];
}

function episodeRewardKey(episodeID, difficulty = 0) {
  return `${Number(episodeID || 0)}:${normalizeEpisodeDifficulty(difficulty)}`;
}

function unitMissionKey(data) {
  const mission = buildUnitMissionState(data);
  return `${mission.unitId}:${mission.missionId}:${mission.stepId}`;
}

function buildUnitMissionState(data) {
  return {
    unitId: Number(data && data.unitId) || 0,
    missionId: Number(data && data.missionId) || 0,
    stepId: Number(data && data.stepId) || 0,
  };
}

function compareUnitMissionState(left, right) {
  return left.unitId - right.unitId || left.missionId - right.missionId || left.stepId - right.stepId;
}

function uniquePositiveInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ).sort((a, b) => a - b);
}

function writeBoolList(values) {
  return writeObjectList((Array.isArray(values) ? values : []).map(writeBool));
}

module.exports = {
  PACKETS,
  createCollectionHandlers,
  ensureCollectionState,
  hasCollectionState,
  buildCompletedUnitMissionPayloads,
  buildRewardEnableUnitMissionPayloads,
  buildUnitMissionUpdatedNotPayload,
  sendUnitMissionUpdatedNot,
  buildIllustratedUnitIds,
  buildTeamCollectionEntries,
  buildMiscCollectionEntries,
  buildEpisodeCompleteData,
  buildEpisodeCompleteState,
  getEpisodeRewardFlags,
  getMainStoryEpisodeCompleteMedalCount,
  getMainStoryEpisodeTotalMedalCount,
  loadCollectionTables,
};
