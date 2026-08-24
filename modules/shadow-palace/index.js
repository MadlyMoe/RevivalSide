const path = require("path");
const {
  buildItemMiscData,
  buildRewardData,
  readSignedVarInt,
  toBigInt,
  writeBool,
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
} = require("../packet-codec");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getMiscItem, spendMiscItem } = require("../inventory");
const { createEmptyReward, grantRewardByType, mergeReward } = require("../reward");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");

const PACKETS = Object.freeze({
  SHADOW_PALACE_START_REQ: 1221,
  SHADOW_PALACE_START_ACK: 1222,
  SHADOW_PALACE_GIVEUP_REQ: 1223,
  SHADOW_PALACE_GIVEUP_ACK: 1224,
  SHADOW_PALACE_SKIP_REQ: 1251,
  SHADOW_PALACE_SKIP_ACK: 1252,
});

const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  INVALID_REQUEST: 20191,
  REWARD_MULTIPLY_OVER_MAX: 20394,
  INVALID_MAIN_ID: 20422,
  DOING: 20423,
  DUNGEON_NOT_MATCHED: 20424,
  CANNOT_FOUND_NEXT_DUNGEON: 20425,
  NOT_ENOUGH_LIFE: 20428,
  MULTIPLY_CLEAR_DUNGEON: 20429,
});

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const palaceById = new Map(
  readGameplayTableRecords("ab_script", "LUA_SHADOW_PALACE_TEMPLET.json", {
    rootDir: ROOT_DIR,
    logLabel: "shadow-palace",
  })
    .map((row) => [positiveInt(row && row.PALACE_ID), row])
    .filter(([palaceId]) => palaceId > 0)
);
const battleRowsByGroup = new Map();
for (const row of readGameplayTableRecords("ab_script", "LUA_SHADOW_BATTLE_TEMPLET.json", {
  rootDir: ROOT_DIR,
  logLabel: "shadow-palace",
})) {
  const groupId = positiveInt(row && row.BATTLE_GROUP);
  const dungeonId = positiveInt(row && row.DUNGEON_ID);
  if (!groupId || !dungeonId) continue;
  const rows = battleRowsByGroup.get(groupId) || [];
  rows.push({ dungeonId, order: positiveInt(row && row.BATTLE_ORDER) });
  battleRowsByGroup.set(groupId, rows);
}
const battleIdsByGroup = new Map(
  Array.from(battleRowsByGroup, ([groupId, rows]) => [
    groupId,
    rows
      .slice()
      .sort((left, right) => left.order - right.order || left.dungeonId - right.dungeonId)
      .map((row) => row.dungeonId),
  ])
);

function createShadowPalaceHandlers() {
  return [
    {
      packetId: PACKETS.SHADOW_PALACE_START_REQ,
      name: "SHADOW_PALACE_START_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeSinglePalaceRequest(ctx, packet.payload, "start");
        const result = startShadowPalace(ctx, user, request);
        send(ctx, socket, packet, PACKETS.SHADOW_PALACE_START_ACK, buildStartAckPayload(result), "shadow-palace-start");
        if (result.errorCode === ERROR_CODES.OK) {
          trackResourceMission(ctx, socket, user, result, "shadow-palace-start-mission-update");
          commit(ctx, "shadow-palace-start");
        }
        console.log(
          `[shadow-palace:SHADOW_PALACE_START_REQ] ACK packetId=${PACKETS.SHADOW_PALACE_START_ACK} palaceId=${request.palaceId} error=${result.errorCode}`
        );
        return true;
      },
    },
    {
      packetId: PACKETS.SHADOW_PALACE_GIVEUP_REQ,
      name: "SHADOW_PALACE_GIVEUP_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeSinglePalaceRequest(ctx, packet.payload, "giveup");
        const result = giveupShadowPalace(user, request);
        send(
          ctx,
          socket,
          packet,
          PACKETS.SHADOW_PALACE_GIVEUP_ACK,
          buildGiveupAckPayload(result),
          "shadow-palace-giveup"
        );
        if (result.errorCode === ERROR_CODES.OK) commit(ctx, "shadow-palace-giveup");
        console.log(
          `[shadow-palace:SHADOW_PALACE_GIVEUP_REQ] ACK packetId=${PACKETS.SHADOW_PALACE_GIVEUP_ACK} palaceId=${request.palaceId} error=${result.errorCode}`
        );
        return true;
      },
    },
    {
      packetId: PACKETS.SHADOW_PALACE_SKIP_REQ,
      name: "SHADOW_PALACE_SKIP_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeSkipRequest(ctx, packet.payload);
        const result = skipShadowPalace(ctx, user, request);
        send(
          ctx,
          socket,
          packet,
          PACKETS.SHADOW_PALACE_SKIP_ACK,
          buildSkipAckPayload(result),
          "shadow-palace-skip"
        );
        if (result.errorCode === ERROR_CODES.OK) {
          trackSkipMissions(ctx, socket, user, result);
          commit(ctx, "shadow-palace-skip");
        }
        console.log(
          `[shadow-palace:SHADOW_PALACE_SKIP_REQ] ACK packetId=${PACKETS.SHADOW_PALACE_SKIP_ACK} palaceId=${request.palaceId} skipCount=${request.skipCount} error=${result.errorCode}`
        );
        return true;
      },
    },
  ];
}

function startShadowPalace(ctx, user, request = {}) {
  if (!request.valid) return startResult(ERROR_CODES.INVALID_REQUEST);
  const palaceId = positiveInt(request.palaceId);
  const palace = palaceById.get(palaceId);
  if (!palace) return startResult(ERROR_CODES.INVALID_MAIN_ID);
  const shadow = getShadowState(user);
  if (positiveInt(shadow.currentPalaceId) > 0) return startResult(ERROR_CODES.DOING);
  if (!isPalaceUnlocked(user, shadow, palace)) return startResult(ERROR_CODES.INVALID_MAIN_ID);

  const itemId = positiveInt(palace.STAGE_REQ_ITEM_ID);
  const totalCost = positiveInt(palace.STAGE_REQ_ITEM_COUNT);
  if (!itemId || !totalCost || !hasMiscItem(user, itemId, totalCost)) {
    return startResult(ERROR_CODES.INSUFFICIENT_ITEM);
  }

  const costItem = spendMiscItem(user, itemId, totalCost, {
    regDate: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n,
  });
  const mutableShadow = ensureShadowState(user);
  const key = String(palaceId);
  const previous = mutableShadow.palaces[key] && typeof mutableShadow.palaces[key] === "object"
    ? mutableShadow.palaces[key]
    : {};
  mutableShadow.currentPalaceId = palaceId;
  mutableShadow.life = 3;
  mutableShadow.rewardMultiply = 1;
  mutableShadow.palaces[key] = {
    ...previous,
    palaceId,
    currentDungeonId: 0,
    dungeonDataList: (Array.isArray(previous.dungeonDataList) ? previous.dungeonDataList : []).map((entry) => ({
      ...entry,
      recentTime: 0,
    })),
  };
  return startResult(ERROR_CODES.OK, palaceId, costItem ? [costItem] : [], 1, itemId, totalCost);
}

function giveupShadowPalace(user, request = {}) {
  const palaceId = positiveInt(request.palaceId);
  if (!request.valid) return giveupResult(ERROR_CODES.INVALID_REQUEST, palaceId);
  if (!palaceById.has(palaceId)) return giveupResult(ERROR_CODES.INVALID_MAIN_ID, palaceId);
  const shadow = getShadowState(user);
  if (positiveInt(shadow && shadow.currentPalaceId) !== palaceId) {
    return giveupResult(ERROR_CODES.INVALID_MAIN_ID, palaceId);
  }
  shadow.currentPalaceId = 0;
  return giveupResult(ERROR_CODES.OK, palaceId);
}

function skipShadowPalace(ctx, user, request = {}) {
  if (!request.valid) return skipResult(ERROR_CODES.INVALID_REQUEST);
  const palaceId = positiveInt(request.palaceId);
  const palace = palaceById.get(palaceId);
  if (!palace) return skipResult(ERROR_CODES.INVALID_MAIN_ID);
  const shadow = getShadowState(user);
  if (positiveInt(shadow && shadow.currentPalaceId) > 0) return skipResult(ERROR_CODES.DOING);

  const skipCount = Number(request.skipCount);
  if (!Number.isInteger(skipCount) || skipCount <= 0) return skipResult(ERROR_CODES.INVALID_REQUEST);
  const maximum = positiveInt(palace.m_RewardMultiplyMax) || 1;
  if (skipCount > maximum) return skipResult(ERROR_CODES.REWARD_MULTIPLY_OVER_MAX);
  if (!hasCompletePalace(shadow, palace)) return skipResult(ERROR_CODES.MULTIPLY_CLEAR_DUNGEON);

  const itemId = positiveInt(palace.STAGE_REQ_ITEM_ID);
  const perClearCost = positiveInt(palace.STAGE_REQ_ITEM_COUNT);
  const totalCost = perClearCost * skipCount;
  if (!itemId || !perClearCost || !hasMiscItem(user, itemId, totalCost)) {
    return skipResult(ERROR_CODES.INSUFFICIENT_ITEM);
  }

  const costItem = spendMiscItem(user, itemId, totalCost, {
    regDate: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n,
  });
  const rewards = [];
  for (let index = 0; index < skipCount; index += 1) rewards.push(grantPalaceReward(ctx, user, palace));
  return skipResult(ERROR_CODES.OK, rewards, costItem ? [costItem] : [], palaceId, skipCount, itemId, totalCost);
}

function validateShadowPalaceBattleSelection(user, palaceIdValue, requestedDungeonIdValue = 0) {
  const palaceId = positiveInt(palaceIdValue);
  const palace = palaceById.get(palaceId);
  if (!palace) return battleSelection(ERROR_CODES.INVALID_MAIN_ID, palaceId);
  const shadow = getShadowState(user);
  if (positiveInt(shadow.currentPalaceId) !== palaceId) {
    return battleSelection(ERROR_CODES.INVALID_MAIN_ID, palaceId);
  }
  if (Math.max(0, Number(shadow.life || 0) || 0) <= 0) {
    return battleSelection(ERROR_CODES.NOT_ENOUGH_LIFE, palaceId);
  }
  const dungeonIds = battleIdsByGroup.get(positiveInt(palace.BATTLE_GROUP_ID)) || [];
  if (!dungeonIds.length) return battleSelection(ERROR_CODES.CANNOT_FOUND_NEXT_DUNGEON, palaceId);
  const saved = shadow.palaces && shadow.palaces[String(palaceId)];
  const expectedDungeonId = positiveInt(saved && saved.currentDungeonId) || dungeonIds[0];
  if (!expectedDungeonId) return battleSelection(ERROR_CODES.CANNOT_FOUND_NEXT_DUNGEON, palaceId);
  const requestedDungeonId = positiveInt(requestedDungeonIdValue);
  if (requestedDungeonId && requestedDungeonId !== expectedDungeonId) {
    return battleSelection(ERROR_CODES.DUNGEON_NOT_MATCHED, palaceId, expectedDungeonId, dungeonIds);
  }
  return battleSelection(ERROR_CODES.OK, palaceId, expectedDungeonId, dungeonIds);
}

function recordShadowPalaceBattleResult(ctx, user, options = {}) {
  const palaceId = positiveInt(options.palaceId);
  const dungeonId = positiveInt(options.dungeonId);
  const win = options.win === true;
  const replay = options.replay && typeof options.replay === "object" ? options.replay : null;
  const cacheKey = `${palaceId}:${dungeonId}:${win ? 1 : 0}`;
  if (replay && replay.shadowPalaceBattleResult && replay.shadowPalaceBattleResult.cacheKey === cacheKey) {
    return replay.shadowPalaceBattleResult;
  }

  const selection = validateShadowPalaceBattleSelection(user, palaceId, dungeonId);
  if (!selection.valid) {
    return cacheBattleResult(replay, {
      cacheKey,
      valid: false,
      changed: false,
      errorCode: selection.errorCode,
      palaceId,
      dungeonData: null,
      reward: null,
      newRecord: false,
      currentDungeonId: selection.dungeonId,
      life: Math.max(0, Number(getShadowState(user).life || 0) || 0),
      completed: false,
      win,
    });
  }

  const shadow = ensureShadowState(user);
  const palaceKey = String(palaceId);
  const previousPalace = shadow.palaces[palaceKey] && typeof shadow.palaces[palaceKey] === "object"
    ? shadow.palaces[palaceKey]
    : {};
  const dungeonDataList = Array.isArray(previousPalace.dungeonDataList)
    ? previousPalace.dungeonDataList.map((entry) => ({ ...entry }))
    : [];
  const existingIndex = dungeonDataList.findIndex((entry) => positiveInt(entry && entry.dungeonId) === dungeonId);
  const previousDungeon = existingIndex >= 0 ? dungeonDataList[existingIndex] : {};
  const playTime = Math.max(0, Math.round(Number(options.playTime || 0) || 0));
  const dungeonData = {
    ...previousDungeon,
    dungeonId,
    recentTime: win ? Math.max(1, playTime) : playTime,
    bestTime: Math.max(0, Number(previousDungeon.bestTime || 0) || 0),
  };
  if (existingIndex >= 0) dungeonDataList[existingIndex] = dungeonData;
  else dungeonDataList.push(dungeonData);

  if (!win) {
    const life = Math.max(0, Math.max(1, Number(shadow.life || 0) || 3) - 1);
    shadow.life = life;
    if (life === 0) shadow.currentPalaceId = 0;
    shadow.palaces[palaceKey] = {
      ...previousPalace,
      palaceId,
      currentDungeonId: dungeonId,
      dungeonDataList,
    };
    return cacheBattleResult(replay, {
      cacheKey,
      valid: true,
      changed: true,
      errorCode: ERROR_CODES.OK,
      palaceId,
      dungeonData,
      reward: null,
      newRecord: false,
      currentDungeonId: dungeonId,
      life,
      completed: false,
      win: false,
    });
  }

  const currentIndex = selection.dungeonIds.indexOf(dungeonId);
  const nextDungeonId = currentIndex >= 0 && currentIndex + 1 < selection.dungeonIds.length
    ? selection.dungeonIds[currentIndex + 1]
    : 0;
  let reward = null;
  let newRecord = false;
  if (!nextDungeonId) {
    const dataByDungeonId = new Map(dungeonDataList.map((entry) => [positiveInt(entry && entry.dungeonId), entry]));
    const orderedData = selection.dungeonIds.map((id) => dataByDungeonId.get(id)).filter(Boolean);
    const currentRunComplete =
      orderedData.length === selection.dungeonIds.length && orderedData.every((entry) => Number(entry.recentTime) > 0);
    const previousRecordComplete =
      orderedData.length === selection.dungeonIds.length && orderedData.every((entry) => Number(entry.bestTime) > 0);
    const recentTotal = orderedData.reduce((total, entry) => total + Math.max(0, Number(entry.recentTime) || 0), 0);
    const bestTotal = orderedData.reduce((total, entry) => total + Math.max(0, Number(entry.bestTime) || 0), 0);
    newRecord = currentRunComplete && (!previousRecordComplete || recentTotal < bestTotal);
    if (newRecord) {
      for (const entry of orderedData) entry.bestTime = Math.max(1, Number(entry.recentTime) || 0);
    }
    const palace = palaceById.get(palaceId);
    const maximum = positiveInt(palace && palace.m_RewardMultiplyMax) || 1;
    const rewardMultiply = Math.min(maximum, Math.max(1, positiveInt(shadow.rewardMultiply) || 1));
    reward = createEmptyReward();
    for (let index = 0; index < rewardMultiply; index += 1) {
      mergeReward(reward, grantPalaceReward(ctx, user, palace));
    }
    shadow.currentPalaceId = 0;
  }

  shadow.palaces[palaceKey] = {
    ...previousPalace,
    palaceId,
    currentDungeonId: nextDungeonId,
    dungeonDataList,
  };
  const finalDungeonData = dungeonDataList.find((entry) => positiveInt(entry && entry.dungeonId) === dungeonId) || dungeonData;
  return cacheBattleResult(replay, {
    cacheKey,
    valid: true,
    changed: true,
    errorCode: ERROR_CODES.OK,
    palaceId,
    dungeonData: finalDungeonData,
    reward,
    newRecord,
    currentDungeonId: nextDungeonId,
    life: Math.max(0, Number(shadow.life || 0) || 0),
    completed: !nextDungeonId,
    win: true,
  });
}

function buildShadowPalaceBattleResultPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(result.palaceId)),
    result.dungeonData ? writeNullableObject(buildPalaceDungeonData(result.dungeonData)) : writeNullObject(),
    result.reward ? writeNullableObject(buildRewardData(result.reward)) : writeNullObject(),
    writeBool(result.newRecord === true),
    writeSignedVarInt(positiveInt(result.currentDungeonId)),
    writeSignedVarInt(Math.max(0, Number(result.life || 0) || 0)),
  ]);
}

function buildShadowPalaceGameLoadFailurePayload(errorCode) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeObjectList([])]);
}

function hasCompletePalace(shadow, palace) {
  const groupId = positiveInt(palace && palace.BATTLE_GROUP_ID);
  const requiredDungeonIds = battleIdsByGroup.get(groupId) || [];
  if (!requiredDungeonIds.length) return false;
  const saved = shadow && shadow.palaces && shadow.palaces[String(positiveInt(palace.PALACE_ID))];
  const cleared = new Set(
    (saved && Array.isArray(saved.dungeonDataList) ? saved.dungeonDataList : [])
      .filter((entry) => Number(entry && entry.bestTime) > 0)
      .map((entry) => positiveInt(entry && entry.dungeonId))
      .filter(Boolean)
  );
  return requiredDungeonIds.every((dungeonId) => cleared.has(dungeonId));
}

function hasCompletePalaceId(user, palaceId) {
  const palace = palaceById.get(positiveInt(palaceId));
  return Boolean(palace && hasCompletePalace(getShadowState(user), palace));
}

function isPalaceUnlocked(user, shadow, palace) {
  const type = String(palace && palace.STAGE_UNLOCK_REQ_TYPE || "");
  const value = positiveInt(palace && palace.STAGE_UNLOCK_REQ_VALUE);
  if (type === "SURT_PLAYER_LEVEL") return positiveInt(user && user.level) >= value;
  if (type === "SURT_CLEAR_PALACE") return hasCompletePalace(shadow, palaceById.get(value));
  return false;
}

function grantPalaceReward(ctx, user, palace) {
  const reward = createEmptyReward();
  const regDate = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n;
  for (let index = 1; index <= 3; index += 1) {
    const type = String(palace[`COMPLETE_REWARD_TYPE_${index}`] || "");
    const id = positiveInt(palace[`COMPLETE_REWARD_ID_${index}`]);
    const quantity = positiveInt(palace[`COMPLETE_REWARD_QUANTITY_${index}`]);
    if (!type || type === "RT_NONE" || !id || !quantity) continue;
    mergeReward(
      reward,
      grantRewardByType(ctx, user, type, id, quantity, quantity, 0, { regDate, expandPackages: false })
    );
  }
  return reward;
}

function buildPalaceDungeonData(data = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(data.dungeonId)),
    writeSignedVarInt(Math.max(0, Number(data.recentTime || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(data.bestTime || 0) || 0)),
  ]);
}

function buildGiveupAckPayload(result) {
  return Buffer.concat([writeSignedVarInt(result.errorCode), writeSignedVarInt(result.palaceId)]);
}

function buildStartAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    writeSignedVarInt(result.palaceId),
    writeObjectList(result.costItems.map((item) => writeNullableObject(buildItemMiscData(item)))),
    writeSignedVarInt(result.rewardMultiply),
  ]);
}

function buildSkipAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    writeObjectList(result.rewards.map((reward) => writeNullableObject(buildRewardData(reward)))),
    writeObjectList(result.costItems.map((item) => writeNullableObject(buildItemMiscData(item)))),
  ]);
}

function decodeSinglePalaceRequest(ctx, encryptedPayload, operation) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const palace = readSignedVarInt(payload, 0);
    return { palaceId: palace.value, valid: palace.offset === payload.length };
  } catch (err) {
    console.log(`[shadow-palace] ${operation} request decode failed: ${err.message}`);
    return { palaceId: 0, valid: false };
  }
}

function decodeSkipRequest(ctx, encryptedPayload) {
  try {
    const payload = decrypt(ctx, encryptedPayload);
    const palace = readSignedVarInt(payload, 0);
    const count = readSignedVarInt(payload, palace.offset);
    return { palaceId: palace.value, skipCount: count.value, valid: count.offset === payload.length };
  } catch (err) {
    console.log(`[shadow-palace] skip request decode failed: ${err.message}`);
    return { palaceId: 0, skipCount: 0, valid: false };
  }
}

function decrypt(ctx, payload) {
  return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
}

function getShadowState(user) {
  return user && user.miscStages && user.miscStages.shadow && typeof user.miscStages.shadow === "object"
    ? user.miscStages.shadow
    : {};
}

function ensureShadowState(user) {
  user.miscStages = user.miscStages && typeof user.miscStages === "object" ? user.miscStages : {};
  user.miscStages.shadow = user.miscStages.shadow && typeof user.miscStages.shadow === "object" ? user.miscStages.shadow : {};
  user.miscStages.shadow.palaces =
    user.miscStages.shadow.palaces && typeof user.miscStages.shadow.palaces === "object"
      ? user.miscStages.shadow.palaces
      : {};
  return user.miscStages.shadow;
}

function hasMiscItem(user, itemId, count) {
  const item = getMiscItem(user, itemId);
  return toBigInt(item && item.countFree || 0) + toBigInt(item && item.countPaid || 0) >= BigInt(count);
}

function trackSkipMissions(ctx, socket, user, result) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const now = typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  for (const condition of ["PALACE_CLEAR", "PALACE_CLEARED"]) {
    const tracked = ctx.trackMissionEvent(user, condition, result.skipCount, {
      now,
      value: result.palaceId,
      palaceId: result.palaceId,
    });
    addMissionTrackingCondition(tracking, condition, tracked);
  }
  addResourceMission(ctx, user, tracking, result);
  completeMissionTracking(ctx, socket, user, tracking, { label: "shadow-palace-skip-mission-update" });
}

function trackResourceMission(ctx, socket, user, result, label) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const now = typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  addResourceMission(ctx, user, tracking, result);
  completeMissionTracking(ctx, socket, user, tracking, { label });
}

function addResourceMission(ctx, user, tracking, result) {
  const resourceTracked = ctx.trackMissionEvent(user, "USE_RESOURCE", result.totalCost, {
    now: tracking.now,
    value: result.itemId,
    itemId: result.itemId,
    resourceId: result.itemId,
  });
  addMissionTrackingCondition(tracking, "USE_RESOURCE", resourceTracked);
}

function commit(ctx, reason) {
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
    ctx.invalidateJoinLobbyAckPayloadCache(reason);
  }
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function giveupResult(errorCode, palaceId = 0) {
  return { errorCode, palaceId };
}

function startResult(errorCode, palaceId = 0, costItems = [], rewardMultiply = 1, itemId = 0, totalCost = 0) {
  return { errorCode, palaceId, costItems, rewardMultiply, itemId, totalCost };
}

function skipResult(errorCode, rewards = [], costItems = [], palaceId = 0, skipCount = 0, itemId = 0, totalCost = 0) {
  return { errorCode, rewards, costItems, palaceId, skipCount, itemId, totalCost };
}

function battleSelection(errorCode, palaceId = 0, dungeonId = 0, dungeonIds = []) {
  return { errorCode, valid: errorCode === ERROR_CODES.OK, palaceId, dungeonId, dungeonIds };
}

function cacheBattleResult(replay, result) {
  if (replay) replay.shadowPalaceBattleResult = result;
  return result;
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

module.exports = {
  PACKETS,
  ERROR_CODES,
  createShadowPalaceHandlers,
  startShadowPalace,
  giveupShadowPalace,
  skipShadowPalace,
  hasCompletePalace,
  hasCompletePalaceId,
  validateShadowPalaceBattleSelection,
  recordShadowPalaceBattleResult,
  buildShadowPalaceBattleResultPayload,
  buildShadowPalaceGameLoadFailurePayload,
};
