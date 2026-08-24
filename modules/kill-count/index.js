"use strict";

const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const {
  buildRewardData,
  readSignedVarInt,
  toBigInt,
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../packet-codec");

const PACKETS = Object.freeze({
  SERVER_KILL_COUNT_NOT: 1229,
  KILL_COUNT_USER_REWARD_REQ: 1230,
  KILL_COUNT_USER_REWARD_ACK: 1231,
  KILL_COUNT_SERVER_REWARD_REQ: 1232,
  KILL_COUNT_SERVER_REWARD_ACK: 1233,
});

const ERROR_CODES = Object.freeze({
  OK: 0,
  INVALID_TEMPLET: 20935,
  REWARD_ALREADY_GIVEN: 20936,
  INVALID_STEP: 20937,
  NOT_ENOUGH_COUNT: 20938,
  REWARD_LOCKED: 20946,
});

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const catalog = loadCatalog();

function createKillCountHandlers() {
  return [
    createRewardHandler({
      requestPacketId: PACKETS.KILL_COUNT_USER_REWARD_REQ,
      ackPacketId: PACKETS.KILL_COUNT_USER_REWARD_ACK,
      name: "KILL_COUNT_USER_REWARD_REQ",
      kind: "user",
    }),
    createRewardHandler({
      requestPacketId: PACKETS.KILL_COUNT_SERVER_REWARD_REQ,
      ackPacketId: PACKETS.KILL_COUNT_SERVER_REWARD_ACK,
      name: "KILL_COUNT_SERVER_REWARD_REQ",
      kind: "server",
    }),
  ];
}

function createRewardHandler(options) {
  return {
    packetId: options.requestPacketId,
    name: options.name,
    handle(ctx, socket, packet) {
      const request = decodeRewardRequest(ctx, packet && packet.payload);
      const user = socket && socket.session && socket.session.user;
      const result = claimKillCountReward(ctx, user, request, options.kind);
      if (ctx && typeof ctx.sendGameResponse === "function") {
        ctx.sendGameResponse(
          socket,
          packet,
          options.ackPacketId,
          buildRewardAckPayload(result),
          options.kind === "user" ? "kill-count-user-reward" : "kill-count-server-reward"
        );
      }
      if (result.errorCode === ERROR_CODES.OK) commit(ctx, `kill-count-${options.kind}-reward`);
      console.log(
        `[kill-count:${options.name}] ACK packetId=${options.ackPacketId} templetId=${request.templetId} stepId=${request.stepId} error=${result.errorCode}`
      );
      return true;
    },
  };
}

function decodeRewardRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.alloc(0);
    const templet = readSignedVarInt(payload, 0);
    const step = readSignedVarInt(payload, templet.offset);
    return {
      valid: step.offset === payload.length,
      templetId: templet.value,
      stepId: step.value,
    };
  } catch (_) {
    return { valid: false, templetId: 0, stepId: 0 };
  }
}

function claimKillCountReward(ctx, user, request = {}, kind = "user") {
  const eventId = positiveInt(request.templetId);
  const stepId = positiveInt(request.stepId);
  const templet = request.valid ? catalog.eventsById.get(eventId) : null;
  if (!templet) return rewardResult(ERROR_CODES.INVALID_TEMPLET);

  const data = getUserKillCountData(user, eventId);
  const completeField = kind === "server" ? "serverCompleteStep" : "userCompleteStep";
  const completedStep = nonNegativeInt(data[completeField]);
  if (stepId > 0 && stepId <= completedStep) return rewardResult(ERROR_CODES.REWARD_ALREADY_GIVEN);
  if (stepId !== completedStep + 1) return rewardResult(ERROR_CODES.INVALID_STEP);

  const steps = kind === "server" ? templet.serverSteps : templet.userSteps;
  const step = steps.find((entry) => entry.stepId === stepId);
  if (!step) return rewardResult(ERROR_CODES.INVALID_STEP);
  if (!isRewardUnlocked(user, templet)) return rewardResult(ERROR_CODES.REWARD_LOCKED);

  const count = kind === "server" ? getServerKillCount(ctx, eventId) : data.killCount;
  if (count < step.killCount) return rewardResult(ERROR_CODES.NOT_ENOUGH_COUNT);

  const mutable = ensureUserKillCountData(user, eventId);
  const reward = createEmptyReward();
  mergeReward(
    reward,
    grantRewardByType(ctx, user, step.rewardType, step.rewardId, step.rewardQuantity, step.rewardQuantity, 0, {
      regDate: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n,
      expandPackages: false,
    })
  );
  mutable[completeField] = stepId;
  return rewardResult(ERROR_CODES.OK, reward, getAllUserKillCountData(user), true);
}

function recordBattleKillCount(ctx, user, options = {}) {
  const replay = options.replay && typeof options.replay === "object" ? options.replay : null;
  if (replay && replay.killCountBattleResult) return replay.killCountBattleResult;

  const stageId = positiveInt(options.stageId);
  const eventId = catalog.eventIdByStageId.get(stageId) || 0;
  if (!eventId) return cacheBattleResult(replay, battleResult());

  const delta = getBattleKillDelta(options.battleState);
  const mutable = ensureUserKillCountData(user, eventId);
  if (delta > 0) mutable.killCount = safeCount(mutable.killCount + delta);
  const result = battleResult({
    eligible: true,
    eventId,
    delta,
    data: normalizeKillCountData(mutable, eventId),
    serverData: { killCountId: eventId, killCount: getServerKillCount(ctx, eventId) },
    changed: delta > 0,
  });
  return cacheBattleResult(replay, result);
}

function getBattleKillDelta(battleState = {}) {
  const state = battleState && typeof battleState === "object" ? battleState : {};
  const explicit = nonNegativeInt(state.killCountDelta ?? state.KillCountDelta);
  if (explicit > 0) return explicit;

  const source = state.unitRecords || state.UnitRecords;
  const records = Array.isArray(source) ? source : source && typeof source === "object" ? Object.values(source) : [];
  const attackerKills = records.reduce((total, record) => {
    const team = positiveInt(record && (record.teamType ?? record.TeamType ?? record.team ?? record.Team));
    if (team !== 1 && team !== 2) return total;
    return total + nonNegativeInt(record && (record.recordKillCount ?? record.RecordKillCount));
  }, 0);
  if (attackerKills > 0) return safeCount(attackerKills);

  const enemyDeaths = nonNegativeInt(
    state.totalDieCountB ?? state.TotalDieCountB ??
    (state.gameRecord && (state.gameRecord.totalDieCountB ?? state.gameRecord.TotalDieCountB))
  );
  return safeCount(enemyDeaths);
}

function buildRewardAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(nonNegativeInt(result.errorCode)),
    result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
    writeObjectList((Array.isArray(result.killCountData) ? result.killCountData : []).map((entry) =>
      writeNullableObject(buildKillCountData(entry))
    )),
  ]);
}

function buildServerKillCountNotPayload(ctx) {
  return writeObjectList(getAllServerKillCountData(ctx).map((entry) => writeNullableObject(buildServerKillCountData(entry))));
}

function buildKillCountData(data = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(data.killCountId)),
    writeSignedVarLong(toBigInt(safeCount(data.killCount))),
    writeSignedVarInt(nonNegativeInt(data.userCompleteStep)),
    writeSignedVarInt(nonNegativeInt(data.serverCompleteStep)),
  ]);
}

function buildServerKillCountData(data = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(data.killCountId)),
    writeSignedVarLong(toBigInt(safeCount(data.killCount))),
  ]);
}

function getAllUserKillCountData(user) {
  return Array.from(catalog.eventsById.keys())
    .map((eventId) => getUserKillCountData(user, eventId))
    .filter((entry) => entry.killCount > 0 || entry.userCompleteStep > 0 || entry.serverCompleteStep > 0)
    .sort((left, right) => left.killCountId - right.killCountId);
}

function getAllServerKillCountData(ctx) {
  return Array.from(catalog.eventsById.keys())
    .map((eventId) => ({ killCountId: eventId, killCount: getServerKillCount(ctx, eventId) }))
    .sort((left, right) => left.killCountId - right.killCountId);
}

function getUserKillCountData(user, eventId) {
  const key = String(eventId);
  const direct = user && user.killCount && typeof user.killCount === "object" ? user.killCount[key] : null;
  const legacyObject = user && user.killCountData && typeof user.killCountData === "object" && !Array.isArray(user.killCountData)
    ? user.killCountData[key]
    : null;
  const legacyList = user && Array.isArray(user.killCountDataList)
    ? user.killCountDataList.find((entry) => positiveInt(entry && entry.killCountId) === eventId)
    : null;
  return normalizeKillCountData(direct || legacyObject || legacyList, eventId);
}

function ensureUserKillCountData(user, eventId) {
  if (!user || typeof user !== "object") return normalizeKillCountData(null, eventId);
  user.killCount = user.killCount && typeof user.killCount === "object" && !Array.isArray(user.killCount)
    ? user.killCount
    : {};
  const key = String(eventId);
  if (!user.killCount[key] || typeof user.killCount[key] !== "object") {
    user.killCount[key] = getUserKillCountData(user, eventId);
  }
  const data = user.killCount[key];
  data.killCountId = eventId;
  data.killCount = safeCount(data.killCount);
  data.userCompleteStep = nonNegativeInt(data.userCompleteStep);
  data.serverCompleteStep = nonNegativeInt(data.serverCompleteStep);
  return data;
}

function getServerKillCount(ctx, eventId) {
  const users = ctx && ctx.userDb && ctx.userDb.users && typeof ctx.userDb.users === "object"
    ? Object.values(ctx.userDb.users)
    : [];
  return safeCount(users.reduce((total, user) => total + getUserKillCountData(user, eventId).killCount, 0));
}

function isRewardUnlocked(user, templet) {
  const type = String(templet.unlockType || "");
  const value = positiveInt(templet.unlockValue);
  if (!type || !value) return true;
  if (type === "SURT_PLAYER_LEVEL") return positiveInt(user && user.level) >= value;
  if (type === "SURT_CLEAR_STAGE") {
    const stagePlay = user && user.stagePlayData && user.stagePlayData[String(value)];
    if (nonNegativeInt(stagePlay && (stagePlay.totalPlayCount || stagePlay.playCount)) > 0) return true;
    const clears = user && user.dungeonClear && typeof user.dungeonClear === "object" ? Object.values(user.dungeonClear) : [];
    return clears.some((entry) => positiveInt(entry && entry.stageId) === value);
  }
  return false;
}

function loadCatalog() {
  const eventsById = new Map();
  const eventIdByStageId = new Map();
  for (const raw of readGameplayTableRecords("ab_script", "LUA_EVENT_KILLCOUNT_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "kill-count",
  })) {
    const eventId = positiveInt(raw && raw.m_EventID);
    const stepId = positiveInt(raw && raw.Step);
    if (!eventId || !stepId) continue;
    let event = eventsById.get(eventId);
    if (!event) {
      event = {
        eventId,
        targetStageIds: [],
        unlockType: String(raw.m_UnlockReqType || ""),
        unlockValue: positiveInt(raw.m_UnlockReqValue),
        userSteps: [],
        serverSteps: [],
      };
      eventsById.set(eventId, event);
    }
    if (Array.isArray(raw.m_TargetStage)) {
      event.targetStageIds = raw.m_TargetStage.map(positiveInt).filter(Boolean);
      for (const stageId of event.targetStageIds) eventIdByStageId.set(stageId, eventId);
    }
    const step = {
      stepId,
      killCount: positiveInt(raw.m_KillCountValue),
      rewardType: String(raw.m_KillCountRewardType || ""),
      rewardId: positiveInt(raw.m_KillCountRewardID),
      rewardQuantity: positiveInt(raw.m_KillCountRewardQuantity),
    };
    (raw.m_bIndividual ? event.userSteps : event.serverSteps).push(step);
  }
  for (const event of eventsById.values()) {
    event.userSteps.sort((left, right) => left.stepId - right.stepId);
    event.serverSteps.sort((left, right) => left.stepId - right.stepId);
  }
  return { eventsById, eventIdByStageId };
}

function normalizeKillCountData(data, eventId) {
  const value = data && typeof data === "object" ? data : {};
  return {
    killCountId: positiveInt(value.killCountId) || eventId,
    killCount: safeCount(value.killCount),
    userCompleteStep: nonNegativeInt(value.userCompleteStep),
    serverCompleteStep: nonNegativeInt(value.serverCompleteStep),
  };
}

function rewardResult(errorCode, reward = null, killCountData = [], changed = false) {
  return { errorCode, reward, killCountData, changed };
}

function battleResult(overrides = {}) {
  return {
    eligible: false,
    eventId: 0,
    delta: 0,
    data: null,
    serverData: null,
    changed: false,
    persisted: false,
    pushed: false,
    ...overrides,
  };
}

function cacheBattleResult(replay, result) {
  if (replay) replay.killCountBattleResult = result;
  return result;
}

function commit(ctx, reason) {
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
    ctx.invalidateJoinLobbyAckPayloadCache(reason);
  }
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function safeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

module.exports = {
  PACKETS,
  ERROR_CODES,
  buildKillCountData,
  buildRewardAckPayload,
  buildServerKillCountData,
  buildServerKillCountNotPayload,
  claimKillCountReward,
  createKillCountHandlers,
  decodeRewardRequest,
  getAllServerKillCountData,
  getAllUserKillCountData,
  getBattleKillDelta,
  getServerKillCount,
  getUserKillCountData,
  loadCatalog,
  recordBattleKillCount,
};
