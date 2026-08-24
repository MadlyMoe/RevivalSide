const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");

const {
  writeBool,
  writeNullableObject,
  writeNullableObjectOrNull,
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

const COLLECTION_ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  OPENTAG_CLOSED: 20768,
  UNIT_MISSION_INVALID_MISSION_ID: 20958,
  UNIT_MISSION_NOT_FOUND_UNIT_HISTORY: 20960,
  UNIT_MISSION_NOT_ENOUGH_VALUE: 20961,
  UNIT_MISSION_INVALID_STEP_ID: 20963,
  UNIT_MISSION_UNSUPPORTED_CONDITION: 20966,
  TEAM_INVALID_ID: 361,
  TEAM_ALREADY_GIVEN: 362,
  TEAM_NOT_ENOUGH_COUNT: 363,
  EPISODE_NOT_ENOUGH_COUNT: 308,
  EPISODE_ALREADY_GIVEN: 309,
  EPISODE_INVALID_REWARD: 310,
  MISC_INVALID_ID: 26002,
  MISC_ALREADY_GIVEN: 26003,
  MISC_NOT_EXISTS_ITEM_HISTORY: 26004,
  MISC_INVALID_TYPE: 26006,
  MISC_DEFAULT_COLLECTION: 26007,
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
          `[collection:unit-mission] claim unitId=${result.missionData.unitId} missionId=${result.missionData.missionId} stepId=${result.missionData.stepId} error=${result.errorCode}`
        );
        send(ctx, socket, packet, PACKETS.UNIT_MISSION_REWARD_ACK, buildUnitMissionRewardAckPayload(result));
        if (result.changed) {
          invalidateLobby(ctx, "unit-mission-reward");
          persist(ctx);
        }
        return true;
      },
    },
    {
      packetId: PACKETS.UNIT_MISSION_REWARD_ALL_REQ,
      name: "UNIT_MISSION_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeUnitMissionRewardAllReq(ctx, packet.payload);
        const result = claimAllUnitMissions(ctx, user, req);
        console.log(
          `[collection:unit-mission] claim-all unitId=${req.unitId} count=${result.missionData.length} error=${result.errorCode}`
        );
        send(ctx, socket, packet, PACKETS.UNIT_MISSION_REWARD_ALL_ACK, buildUnitMissionRewardAllAckPayload(result));
        if (result.changed) {
          invalidateLobby(ctx, "unit-mission-reward-all");
          persist(ctx);
        }
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
          `[collection:episode] claim episodeID=${req.episodeID} difficulty=${req.episodeDifficulty} rewardIndex=${req.rewardIndex} error=${result.errorCode}`
        );
        send(ctx, socket, packet, PACKETS.EPISODE_COMPLETE_REWARD_ACK, buildEpisodeRewardAckPayload(result));
        if (result.changed) persist(ctx);
        return true;
      },
    },
    {
      packetId: PACKETS.EPISODE_COMPLETE_REWARD_ALL_REQ,
      name: "EPISODE_COMPLETE_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeEpisodeCompleteRewardAllReq(ctx, packet.payload);
        const result = claimAllEpisodeRewards(ctx, user, req);
        console.log(
          `[collection:episode] claim-all episodeID=${req.episodeID} count=${result.episodeCompleteData.length} error=${result.errorCode}`
        );
        send(ctx, socket, packet, PACKETS.EPISODE_COMPLETE_REWARD_ALL_ACK, buildEpisodeRewardAllAckPayload(result));
        if (result.changed) persist(ctx);
        return true;
      },
    },
    {
      packetId: PACKETS.TEAM_COLLECTION_REWARD_REQ,
      name: "TEAM_COLLECTION_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeSingleIntReq(ctx, packet.payload, "teamID");
        const result = claimTeamCollectionReward(ctx, user, req.valid ? req.teamID : 0);
        console.log(`[collection:team] claim teamID=${req.teamID} error=${result.errorCode}`);
        send(ctx, socket, packet, PACKETS.TEAM_COLLECTION_REWARD_ACK, buildTeamCollectionRewardAckPayload(result));
        if (result.changed) persist(ctx);
        return true;
      },
    },
    {
      packetId: PACKETS.MISC_COLLECTION_REWARD_REQ,
      name: "MISC_COLLECTION_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeSingleIntReq(ctx, packet.payload, "miscId");
        const result = claimMiscCollectionReward(ctx, user, req.valid ? req.miscId : 0);
        console.log(`[collection:misc] claim miscId=${req.miscId} error=${result.errorCode}`);
        send(ctx, socket, packet, PACKETS.MISC_COLLECTION_REWARD_ACK, buildMiscCollectionRewardAckPayload(result));
        if (result.changed) persist(ctx);
        return true;
      },
    },
    {
      packetId: PACKETS.MISC_COLLECTION_REWARD_ALL_REQ,
      name: "MISC_COLLECTION_REWARD_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeMiscCollectionRewardAllReq(ctx, packet.payload);
        const result = claimAllMiscCollectionRewards(ctx, user, req.valid ? req.miscType : -1);
        console.log(
          `[collection:misc] claim-all miscType=${req.miscType} count=${result.miscCollectionDatas.length} error=${result.errorCode}`
        );
        send(ctx, socket, packet, PACKETS.MISC_COLLECTION_REWARD_ALL_ACK, buildMiscCollectionRewardAllAckPayload(result));
        if (result.changed) persist(ctx);
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
  user.collection.unitMissionMaxLevels = normalizePositiveIntMap(user.collection.unitMissionMaxLevels);
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
    Object.keys(state.unitMissionMaxLevels).length > 0 ||
    Object.keys(state.teamRewards).length > 0 ||
    Object.keys(state.miscRewards).length > 0 ||
    Object.keys(state.episodeRewards).length > 0
  );
}

function claimUnitMission(ctx, user, req) {
  const state = ensureCollectionState(user);
  const missionData = buildUnitMissionState(req);
  if (!req || req.valid !== true || missionData.unitId <= 0 || missionData.missionId <= 0 || missionData.stepId <= 0) {
    return unitMissionResult(COLLECTION_ERRORS.INVALID_REQUEST, missionData);
  }
  if (!isCollectionMissionOpen(ctx, user)) {
    return unitMissionResult(COLLECTION_ERRORS.OPENTAG_CLOSED, missionData);
  }
  const context = resolveUnitMissionContext(user, missionData);
  if (context.errorCode !== COLLECTION_ERRORS.OK) return unitMissionResult(context.errorCode, missionData);
  const { row } = context;
  const key = unitMissionKey(missionData);
  if (state.unitMissionsClaimed[key]) {
    return unitMissionResult(COLLECTION_ERRORS.UNIT_MISSION_INVALID_STEP_ID, missionData);
  }
  if (!isUnitMissionEligible(user, missionData, row)) {
    return unitMissionResult(COLLECTION_ERRORS.UNIT_MISSION_NOT_ENOUGH_VALUE, missionData);
  }
  captureUnitMissionProgress(user, { unitIds: [missionData.unitId] });
  state.unitMissionsClaimed[key] = completedUnitMissionState(missionData);
  return unitMissionResult(
    COLLECTION_ERRORS.OK,
    missionData,
    grantTableReward(ctx, user, row, "m_Reward"),
    true
  );
}

function claimAllUnitMissions(ctx, user, req) {
  const state = ensureCollectionState(user);
  const unitId = Number(req && req.unitId) || 0;
  if (!req || req.valid !== true || unitId <= 0) return unitMissionAllResult(COLLECTION_ERRORS.INVALID_REQUEST);
  if (!isCollectionMissionOpen(ctx, user)) return unitMissionAllResult(COLLECTION_ERRORS.OPENTAG_CLOSED);
  const unitContext = resolveUnitMissionUnit(user, unitId);
  if (unitContext.errorCode !== COLLECTION_ERRORS.OK) return unitMissionAllResult(unitContext.errorCode);
  const reward = createEmptyReward();
  const missionData = [];
  for (const entry of getRewardEnableUnitMissionStates(user, { unitIds: [unitId], capture: false })) {
    const key = unitMissionKey(entry);
    if (state.unitMissionsClaimed[key]) continue;
    state.unitMissionsClaimed[key] = completedUnitMissionState(entry);
    missionData.push(entry);
    mergeReward(reward, grantTableReward(ctx, user, entry.row, "m_Reward"));
  }
  if (!missionData.length) return unitMissionAllResult(COLLECTION_ERRORS.UNIT_MISSION_NOT_ENOUGH_VALUE);
  captureUnitMissionProgress(user, { unitIds: [unitId] });
  return unitMissionAllResult(COLLECTION_ERRORS.OK, missionData, reward, true);
}

function unitMissionResult(errorCode, missionData = null, reward = null, changed = false) {
  return { errorCode, missionData: buildUnitMissionState(missionData), reward, changed };
}

function unitMissionAllResult(errorCode, missionData = [], reward = null, changed = false) {
  return { errorCode, missionData, reward, changed };
}

function completedUnitMissionState(data) {
  const mission = buildUnitMissionState(data);
  return { ...mission, claimedAt: new Date().toISOString() };
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
  if (options.capture !== false) captureUnitMissionProgress(user, options);
  const illustratedUnitIds = buildIllustratedUnitIds(user);
  const wantedUnitIds = options.unitIds
    ? new Set((Array.isArray(options.unitIds) ? options.unitIds : [options.unitIds]).map(Number).filter((id) => id > 0))
    : null;
  const result = [];

  for (const unitId of illustratedUnitIds) {
    if (wantedUnitIds && !wantedUnitIds.has(unitId)) continue;
    const templet = getUnitTemplet(unitId) || {};
    if (String(templet.m_NKM_UNIT_TYPE || "") !== "NUT_NORMAL" || templet.m_bMonster === true) continue;
    const grade = String(templet.m_NKM_UNIT_GRADE || "");
    const level = getUnitMissionLevel(user, unitId);
    const rows = tables.unitMissionsByGrade.get(grade) || [];
    for (const row of rows) {
      const entry = buildUnitMissionState({ unitId, missionId: row.missionId, stepId: row.stepId });
      const key = unitMissionKey(entry);
      if (state.unitMissionsClaimed[key]) continue;
      if (!isSupportedUnitMissionCondition(row.condition)) continue;
      if (level < Number(row.value || 0)) continue;
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
  if (!isCollectionMissionOpen(ctx, user)) return;
  const payload = buildUnitMissionUpdatedNotPayload(user, options);
  ctx.sendServerGamePacket(socket, PACKETS.UNIT_MISSION_UPDATED_NOT, payload, "unit-mission-updated");
}

function claimTeamCollectionReward(ctx, user, teamID) {
  const tables = loadCollectionTables();
  const team = tables.teamGroups.get(Number(teamID));
  if (!team) return teamCollectionResult(COLLECTION_ERRORS.TEAM_INVALID_ID);
  const state = ensureCollectionState(user);
  const key = String(team.teamID);
  if (state.teamRewards[key]) return teamCollectionResult(COLLECTION_ERRORS.TEAM_ALREADY_GIVEN);
  if (!isTeamCollectionEligible(user, team)) return teamCollectionResult(COLLECTION_ERRORS.TEAM_NOT_ENOUGH_COUNT);

  state.teamRewards[key] = { teamID: team.teamID, claimedAt: new Date().toISOString() };
  return teamCollectionResult(
    COLLECTION_ERRORS.OK,
    { teamID: team.teamID, reward: true },
    grantTeamReward(ctx, user, team),
    true
  );
}

function teamCollectionResult(errorCode, teamCollectionData = null, reward = null, changed = false) {
  return { errorCode, teamCollectionData, reward, changed };
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
  const tables = loadCollectionTables();
  const row = tables.miscById.get(Number(miscId));
  if (!row) return miscCollectionResult(COLLECTION_ERRORS.MISC_INVALID_ID, Number(miscId) || 0);
  if (row.defaultCollection) return miscCollectionResult(COLLECTION_ERRORS.MISC_DEFAULT_COLLECTION, row.miscId);
  const state = ensureCollectionState(user);
  const key = String(row.miscId);
  if (state.miscRewards[key]) return miscCollectionResult(COLLECTION_ERRORS.MISC_ALREADY_GIVEN, row.miscId);
  if (!isMiscCollectionEligible(user, row)) {
    return miscCollectionResult(COLLECTION_ERRORS.MISC_NOT_EXISTS_ITEM_HISTORY, row.miscId);
  }

  state.miscRewards[key] = { miscId: row.miscId, claimedAt: new Date().toISOString() };
  return miscCollectionResult(COLLECTION_ERRORS.OK, row.miscId, grantMiscCollectionReward(ctx, user, row), true);
}

function claimAllMiscCollectionRewards(ctx, user, miscType) {
  const tables = loadCollectionTables();
  const numericType = Number(miscType);
  const rows = Number.isInteger(numericType) ? tables.miscByType.get(numericType) || [] : [];
  if (!rows.length) return miscCollectionAllResult(COLLECTION_ERRORS.MISC_INVALID_TYPE, numericType);
  const state = ensureCollectionState(user);
  const unclaimed = rows.filter((row) => !row.defaultCollection && !state.miscRewards[String(row.miscId)]);
  if (!unclaimed.length) return miscCollectionAllResult(COLLECTION_ERRORS.MISC_ALREADY_GIVEN, numericType);
  const eligible = unclaimed.filter((row) => isMiscCollectionEligible(user, row));
  if (!eligible.length) {
    return miscCollectionAllResult(COLLECTION_ERRORS.MISC_NOT_EXISTS_ITEM_HISTORY, numericType);
  }
  const reward = createEmptyReward();
  const miscCollectionDatas = [];
  for (const row of eligible) {
    state.miscRewards[String(row.miscId)] = { miscId: row.miscId, claimedAt: new Date().toISOString() };
    miscCollectionDatas.push({ miscId: row.miscId, reward: true });
    mergeReward(reward, grantMiscCollectionReward(ctx, user, row));
  }
  return miscCollectionAllResult(COLLECTION_ERRORS.OK, numericType, miscCollectionDatas, reward, true);
}

function miscCollectionResult(errorCode, miscId, reward = null, changed = false) {
  return {
    errorCode,
    miscCollectionData: errorCode === COLLECTION_ERRORS.OK ? { miscId, reward: true } : null,
    reward,
    changed,
  };
}

function miscCollectionAllResult(errorCode, miscType, miscCollectionDatas = [], reward = null, changed = false) {
  return { errorCode, miscType: Number.isInteger(miscType) && miscType >= 0 ? miscType : 0, miscCollectionDatas, reward, changed };
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
  const episodeID = Number(req && req.episodeID);
  const difficulty = Number(req && req.episodeDifficulty);
  const rewardIndex = Number(req && req.rewardIndex);
  if (
    !req ||
    req.valid !== true ||
    Number(req.errorCode) !== COLLECTION_ERRORS.OK ||
    !Number.isInteger(episodeID) ||
    episodeID <= 0 ||
    (difficulty !== 0 && difficulty !== 1) ||
    !Number.isInteger(rewardIndex) ||
    rewardIndex < 0 ||
    rewardIndex > 2
  ) {
    return episodeCollectionResult(COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
  }
  const row = findEpisodeRewardRow(episodeID, difficulty);
  const configuredReward = row && row.rewards && row.rewards[rewardIndex];
  if (!configuredReward || !configuredReward.type || configuredReward.id <= 0 || configuredReward.value <= 0) {
    return episodeCollectionResult(COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
  }
  const state = ensureCollectionState(user);
  const key = episodeRewardKey(episodeID, difficulty);
  const flags = normalizeRewardFlags(state.episodeRewards[key]);
  if (flags[rewardIndex]) return episodeCollectionResult(COLLECTION_ERRORS.EPISODE_ALREADY_GIVEN);
  if (!isEpisodeRewardEligible(user, row, rewardIndex)) {
    return episodeCollectionResult(COLLECTION_ERRORS.EPISODE_NOT_ENOUGH_COUNT);
  }
  flags[rewardIndex] = true;
  state.episodeRewards[key] = flags;
  return episodeCollectionResult(
    COLLECTION_ERRORS.OK,
    buildEpisodeCompleteState(user, episodeID, difficulty),
    grantEpisodeReward(ctx, user, row, rewardIndex),
    true
  );
}

function claimAllEpisodeRewards(ctx, user, req) {
  const episodeID = Number(req && req.episodeID);
  if (!req || req.valid !== true || Number(req.errorCode) !== COLLECTION_ERRORS.OK || !Number.isInteger(episodeID) || episodeID <= 0) {
    return episodeCollectionAllResult(COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
  }
  const tables = loadCollectionTables();
  const rows = tables.episodeRows.filter(
    (row) => row.episodeID === episodeID && row.rewards.some((entry) => entry && entry.type && entry.id > 0 && entry.value > 0)
  );
  if (!rows.length) return episodeCollectionAllResult(COLLECTION_ERRORS.EPISODE_INVALID_REWARD);
  const state = ensureCollectionState(user);
  const unclaimed = [];
  for (const row of rows) {
    const flags = normalizeRewardFlags(state.episodeRewards[episodeRewardKey(row.episodeID, row.difficulty)]);
    for (let rewardIndex = 0; rewardIndex < 3; rewardIndex += 1) {
      const entry = row.rewards[rewardIndex];
      if (entry && entry.type && entry.id > 0 && entry.value > 0 && !flags[rewardIndex]) {
        unclaimed.push({ row, rewardIndex, flags });
      }
    }
  }
  if (!unclaimed.length) return episodeCollectionAllResult(COLLECTION_ERRORS.EPISODE_ALREADY_GIVEN);
  const eligible = unclaimed.filter(({ row, rewardIndex }) => isEpisodeRewardEligible(user, row, rewardIndex));
  if (!eligible.length) return episodeCollectionAllResult(COLLECTION_ERRORS.EPISODE_NOT_ENOUGH_COUNT);

  const reward = createEmptyReward();
  const changedRows = new Set();
  for (const { row, rewardIndex, flags } of eligible) {
    const key = episodeRewardKey(row.episodeID, row.difficulty);
    flags[rewardIndex] = true;
    state.episodeRewards[key] = flags;
    changedRows.add(key);
    mergeReward(reward, grantEpisodeReward(ctx, user, row, rewardIndex));
  }
  const episodeCompleteData = rows
    .filter((row) => changedRows.has(episodeRewardKey(row.episodeID, row.difficulty)))
    .map((row) => buildEpisodeCompleteState(user, row.episodeID, row.difficulty));
  return episodeCollectionAllResult(COLLECTION_ERRORS.OK, episodeCompleteData, reward, true);
}

function episodeCollectionResult(errorCode, episodeCompleteData = null, reward = null, changed = false) {
  return { errorCode, episodeCompleteData, reward, changed };
}

function episodeCollectionAllResult(errorCode, episodeCompleteData = [], reward = null, changed = false) {
  return { errorCode, episodeCompleteData, reward, changed };
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
  if (!row || !isSupportedUnitMissionCondition(row.condition)) return false;
  return getUnitMissionLevel(user, missionData && missionData.unitId) >= Number(row.value || 0);
}

function resolveUnitMissionContext(user, missionData) {
  const unitContext = resolveUnitMissionUnit(user, missionData.unitId);
  if (unitContext.errorCode !== COLLECTION_ERRORS.OK) return unitContext;
  const tables = loadCollectionTables();
  const mission = tables.unitMissionsById.get(Number(missionData.missionId));
  if (!mission || mission.grade !== unitContext.grade) {
    return { errorCode: COLLECTION_ERRORS.UNIT_MISSION_INVALID_MISSION_ID };
  }
  const row = tables.unitMissionByKey.get(`${Number(missionData.missionId)}:${Number(missionData.stepId)}`);
  if (!row || row.grade !== unitContext.grade) {
    return { errorCode: COLLECTION_ERRORS.UNIT_MISSION_INVALID_STEP_ID };
  }
  if (!isSupportedUnitMissionCondition(row.condition)) {
    return { errorCode: COLLECTION_ERRORS.UNIT_MISSION_UNSUPPORTED_CONDITION };
  }
  return { ...unitContext, row };
}

function resolveUnitMissionUnit(user, unitId) {
  const id = Number(unitId);
  const templet = getUnitTemplet(id);
  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !templet ||
    String(templet.m_NKM_UNIT_TYPE || "") !== "NUT_NORMAL" ||
    templet.m_bMonster === true ||
    !buildIllustratedUnitIds(user).includes(id)
  ) {
    return { errorCode: COLLECTION_ERRORS.UNIT_MISSION_NOT_FOUND_UNIT_HISTORY };
  }
  return { errorCode: COLLECTION_ERRORS.OK, templet, grade: String(templet.m_NKM_UNIT_GRADE || "") };
}

function isSupportedUnitMissionCondition(condition) {
  return String(condition || "") === "UNIT_GROWTH_LEVEL";
}

function isCollectionMissionOpen(ctx, user) {
  const expected = "TAG_COLLECTION_MISSION";
  if ((user && Array.isArray(user.openTags) ? user.openTags : []).some((tag) => String(tag || "").toUpperCase() === expected)) {
    return true;
  }
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return false;
  const tags = ctx.getEffectiveOpenTags(Array.isArray(user && user.openTags) ? user.openTags : []);
  return Array.isArray(tags) && tags.some((tag) => String(tag || "").toUpperCase() === expected);
}

function captureUnitMissionProgress(user, options = {}) {
  const state = ensureCollectionState(user);
  const wantedUnitIds = options.unitIds
    ? new Set((Array.isArray(options.unitIds) ? options.unitIds : [options.unitIds]).map(Number).filter((id) => id > 0))
    : null;
  for (const unit of getArmyUnits(user)) {
    const unitId = Number(unit && unit.unitId);
    if (!Number.isInteger(unitId) || unitId <= 0 || (wantedUnitIds && !wantedUnitIds.has(unitId))) continue;
    const level = Math.max(1, Number(unit.level || 1) || 1);
    state.unitMissionMaxLevels[String(unitId)] = Math.max(Number(state.unitMissionMaxLevels[String(unitId)] || 0), level);
  }
  return state.unitMissionMaxLevels;
}

function getUnitMissionLevel(user, unitId) {
  const id = Number(unitId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const state = ensureCollectionState(user);
  let level = Number(state.unitMissionMaxLevels[String(id)] || 0);
  for (const unit of getArmyUnits(user)) {
    if (Number(unit && unit.unitId) === id) level = Math.max(level, Math.max(1, Number(unit.level || 1) || 1));
  }
  return level;
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
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObject(buildUnitMissionData(result.missionData)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
  ]);
}

function buildUnitMissionRewardAllAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectList((result.missionData || []).map(buildUnitMissionData)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
  ]);
}

function buildEpisodeRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
    writeNullableObjectOrNull(result.episodeCompleteData ? buildEpisodeCompleteData(result.episodeCompleteData) : null),
  ]);
}

function buildEpisodeRewardAllAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
    writeNullableObjectList((result.episodeCompleteData || []).map(buildEpisodeCompleteData)),
  ]);
}

function buildTeamCollectionRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
    writeNullableObjectOrNull(result.teamCollectionData ? buildTeamCollectionData(result.teamCollectionData) : null),
  ]);
}

function buildMiscCollectionRewardAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
    writeNullableObjectOrNull(result.miscCollectionData ? buildMiscCollectionData(result.miscCollectionData) : null),
  ]);
}

function buildMiscCollectionRewardAllAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode || 0)),
    writeSignedVarInt(Number(result.miscType || 0)),
    writeNullableObjectOrNull(result.reward ? buildRewardData(result.reward) : null),
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
  offset = stepId.offset;
  return {
    unitId: unitId.value,
    missionId: missionId.value,
    stepId: stepId.value,
    valid: unitId.valid && missionId.valid && stepId.valid && offset === buffer.length,
  };
}

function decodeUnitMissionRewardAllReq(ctx, payload) {
  return decodeSingleIntReq(ctx, payload, "unitId");
}

function decodeEpisodeCompleteRewardReq(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  let offset = 0;
  const errorCode = safeReadInt(buffer, offset);
  offset = errorCode.offset;
  const episodeID = safeReadInt(buffer, offset);
  offset = episodeID.offset;
  const episodeDifficulty = safeReadInt(buffer, offset);
  offset = episodeDifficulty.offset;
  const rewardIndex = safeReadSByte(buffer, offset);
  return {
    errorCode: errorCode.value,
    episodeID: episodeID.value,
    episodeDifficulty: episodeDifficulty.value,
    rewardIndex: rewardIndex.value,
    valid:
      errorCode.valid &&
      episodeID.valid &&
      episodeDifficulty.valid &&
      rewardIndex.valid &&
      rewardIndex.offset === buffer.length,
  };
}

function decodeEpisodeCompleteRewardAllReq(ctx, payload) {
  const buffer = decrypt(ctx, payload);
  const errorCode = safeReadInt(buffer, 0);
  const episodeID = safeReadInt(buffer, errorCode.offset);
  return {
    errorCode: errorCode.value,
    episodeID: episodeID.value,
    valid: errorCode.valid && episodeID.valid && episodeID.offset === buffer.length,
  };
}

function decodeSingleIntReq(ctx, payload, key) {
  const buffer = decrypt(ctx, payload);
  const value = safeReadInt(buffer, 0);
  return { [key]: value.value, valid: value.valid && value.offset === buffer.length };
}

function decodeMiscCollectionRewardAllReq(ctx, payload) {
  const req = decodeSingleIntReq(ctx, payload, "miscType");
  return { miscType: Number(req.miscType || 0), valid: req.valid };
}

function safeReadInt(buffer, offset) {
  try {
    return { ...readSignedVarInt(buffer, offset), valid: true };
  } catch (_) {
    return { value: 0, offset, valid: false };
  }
}

function safeReadSByte(buffer, offset) {
  try {
    return { ...readSByte(buffer, offset), valid: true };
  } catch (_) {
    return { value: 0, offset, valid: false };
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

function persist(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function invalidateLobby(ctx, reason) {
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
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
  const unitMissionsById = new Map();
  const unitMissionByKey = new Map();
  for (const row of unitMissions) {
    if (!row.grade || !row.missionId || !row.stepId) continue;
    if (!unitMissionsByGrade.has(row.grade)) unitMissionsByGrade.set(row.grade, []);
    unitMissionsByGrade.get(row.grade).push(row);
    if (!unitMissionsById.has(row.missionId)) unitMissionsById.set(row.missionId, { missionId: row.missionId, grade: row.grade });
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

  cachedTables = { unitMissionsByGrade, unitMissionsById, unitMissionByKey, teamGroups, miscById, miscByType, episodeRows, episodeByKey };
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

function normalizePositiveIntMap(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = Number(rawKey);
    const numericValue = Number(rawValue);
    if (!Number.isInteger(key) || key <= 0 || !Number.isInteger(numericValue) || numericValue <= 0) continue;
    result[String(key)] = numericValue;
  }
  return result;
}

function writeBoolList(values) {
  return writeObjectList((Array.isArray(values) ? values : []).map(writeBool));
}

module.exports = {
  PACKETS,
  COLLECTION_ERRORS,
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
};
