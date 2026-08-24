const path = require("path");
const {
  buildItemMiscData,
  readSignedVarInt,
  toBigInt,
  writeInt64LE,
  writeNullableObject,
  writeNullObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../packet-codec");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getMiscItem, spendMiscItem } = require("../inventory");
const { dateFromDateTime, dateTimeBinaryForDate } = require("../server-time");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");

const PACKETS = Object.freeze({
  RESET_STAGE_PLAY_COUNT_REQ: 1219,
  RESET_STAGE_PLAY_COUNT_ACK: 1220,
});

const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_ITEM: 111,
  RESTORE_COUNT: 20358,
  EXIST_PLAY_COUNT: 20359,
  INVALID_PLAY_COUNT: 20383,
  UNRESTORABLE_STAGE_ID: 20384,
});

const stageTemplets = new Map(
  readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json", {
    rootDir: path.resolve(__dirname, "..", ".."),
    logLabel: "stage-play-reset",
  })
    .map((record) => [Number(record && record.m_StageID), record])
    .filter(([stageId]) => Number.isInteger(stageId) && stageId > 0)
);

function createStagePlayResetHandlers() {
  return [
    {
      packetId: PACKETS.RESET_STAGE_PLAY_COUNT_REQ,
      name: "RESET_STAGE_PLAY_COUNT_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeRequest(ctx, packet.payload);
        const result = resetStagePlayCount(ctx, user, request);
        send(ctx, socket, packet, PACKETS.RESET_STAGE_PLAY_COUNT_ACK, buildAckPayload(result), "reset-stage-play-count");
        if (result.errorCode === ERROR_CODES.OK) {
          trackResourceSpend(ctx, socket, user, result.itemId, result.cost);
          if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
            ctx.invalidateJoinLobbyAckPayloadCache("reset-stage-play-count");
          }
          saveIfLocal(ctx);
        }
        console.log(
          `[stage-play-reset:RESET_STAGE_PLAY_COUNT_REQ] ACK packetId=${PACKETS.RESET_STAGE_PLAY_COUNT_ACK} stageId=${request.stageId} restoreCount=${request.restoreCount} error=${result.errorCode}`
        );
        return true;
      },
    },
  ];
}

function resetStagePlayCount(ctx, user, request = {}) {
  const stage = request.valid ? stageTemplets.get(Number(request.stageId)) : null;
  const enterLimit = Number(stage && stage.m_EnterLimit || 0);
  const restoreLimit = Number(stage && stage.m_RestoreLimit || 0);
  const restoreEnterCount = Number(stage && stage.m_RestoreLimitEnterCount || 0);
  const itemId = Number(stage && stage.m_RestoreLimitReqItemID || 0);
  const itemCost = Number(stage && stage.m_RestoreLimitReqItemCount || 0);
  if (
    !stage ||
    enterLimit <= 0 ||
    restoreLimit <= 0 ||
    restoreEnterCount <= 0 ||
    itemId <= 0 ||
    itemCost <= 0
  ) {
    return stageResetResult(ERROR_CODES.UNRESTORABLE_STAGE_ID);
  }

  const requestedRestoreCount = Number(request.restoreCount);
  const maximumBatch = Math.ceil(enterLimit / restoreEnterCount);
  if (!Number.isInteger(requestedRestoreCount) || requestedRestoreCount <= 0 || requestedRestoreCount > maximumBatch) {
    return stageResetResult(ERROR_CODES.RESTORE_COUNT);
  }

  const state = getCurrentStagePlayState(ctx, user, stage);
  if (!state) return stageResetResult(ERROR_CODES.EXIST_PLAY_COUNT);
  if (!Number.isInteger(state.playCount) || state.playCount < 0 || state.playCount > enterLimit) {
    return stageResetResult(ERROR_CODES.INVALID_PLAY_COUNT);
  }
  if (!Number.isInteger(state.restoreCount) || state.restoreCount < 0 || state.restoreCount > restoreLimit) {
    return stageResetResult(ERROR_CODES.RESTORE_COUNT);
  }
  if (state.playCount < enterLimit) return stageResetResult(ERROR_CODES.EXIST_PLAY_COUNT);
  if (state.restoreCount + requestedRestoreCount > restoreLimit) return stageResetResult(ERROR_CODES.RESTORE_COUNT);

  const cost = itemCost * requestedRestoreCount;
  const currentItem = getMiscItem(user, itemId);
  if (toBigInt(currentItem && currentItem.countFree || 0) + toBigInt(currentItem && currentItem.countPaid || 0) < BigInt(cost)) {
    return stageResetResult(ERROR_CODES.INSUFFICIENT_ITEM);
  }

  const nextState = {
    ...state.source,
    stageId: Number(stage.m_StageID),
    playCount: Math.max(0, state.playCount - restoreEnterCount * requestedRestoreCount),
    restoreCount: state.restoreCount + requestedRestoreCount,
    bestKillCount: Math.max(0, Math.trunc(Number(state.source.bestKillCount || 0))),
    nextResetDate: String(state.nextResetDate || nextStageResetDate(ctx, stage)),
    bestClearTimeSec: Math.max(0, Math.trunc(Number(state.source.bestClearTimeSec || 0))),
    totalPlayCount: Math.max(0, Math.trunc(Number(state.source.totalPlayCount || state.playCount || 0))),
  };
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  user.stagePlayData[String(nextState.stageId)] = nextState;
  const costItem = spendMiscItem(user, itemId, cost);
  return stageResetResult(ERROR_CODES.OK, nextState, costItem, itemId, cost);
}

function getCurrentStagePlayState(ctx, user, stage) {
  const records = user && user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const source = records[String(stage.m_StageID)];
  if (!source || typeof source !== "object") return null;
  const nextResetDate = toBigInt(source.nextResetDate || 0, 0n);
  const resetDate = dateFromDateTime(nextResetDate);
  if (resetDate && resetDate.getTime() <= getServerNow(ctx).getTime()) {
    return { source, playCount: 0, restoreCount: 0, nextResetDate: 0n };
  }
  return {
    source,
    playCount: Number(source.playCount || 0),
    restoreCount: Number(source.restoreCount || 0),
    nextResetDate,
  };
}

function nextStageResetDate(ctx, stage) {
  const now = getServerNow(ctx);
  const resetType = String(stage && stage.m_EnterLimitCond || "DAY").toUpperCase();
  if (resetType === "MONTH") {
    return dateTimeBinaryForDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 4, 0, 0, 0)));
  }
  if (resetType === "WEEK") {
    const day = now.getUTCDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    return dateTimeBinaryForDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 4, 0, 0, 0)));
  }
  return dateTimeBinaryForDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 4, 0, 0, 0)));
}

function buildAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(result.errorCode),
    result.stagePlayData ? writeNullableObject(buildStagePlayData(result.stagePlayData)) : writeNullObject(),
    result.costItem ? writeNullableObject(buildItemMiscData(result.costItem)) : writeNullObject(),
  ]);
}

function buildStagePlayData(state = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(state.stageId || 0)),
    writeSignedVarLong(toBigInt(state.playCount || 0)),
    writeSignedVarLong(toBigInt(state.restoreCount || 0)),
    writeSignedVarLong(toBigInt(state.bestKillCount || 0)),
    writeInt64LE(toBigInt(state.nextResetDate || 0)),
    writeSignedVarInt(Math.max(0, Math.trunc(Number(state.bestClearTimeSec || 0)))),
    writeSignedVarLong(toBigInt(state.totalPlayCount || 0)),
  ]);
}

function stageResetResult(errorCode, stagePlayData = null, costItem = null, itemId = 0, cost = 0) {
  return { errorCode, stagePlayData, costItem, itemId, cost };
}

function decodeRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
    const stage = readSignedVarInt(payload, 0);
    const count = readSignedVarInt(payload, stage.offset);
    return { stageId: stage.value, restoreCount: count.value, valid: count.offset === payload.length };
  } catch (err) {
    console.log(`[stage-play-reset] request decode failed: ${err.message}`);
    return { stageId: 0, restoreCount: 0, valid: false };
  }
}

function trackResourceSpend(ctx, socket, user, itemId, amount) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const now = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  const tracked = ctx.trackMissionEvent(user, "USE_RESOURCE", amount, { now, itemId, resourceId: itemId, value: itemId });
  addMissionTrackingCondition(tracking, "USE_RESOURCE", tracked);
  completeMissionTracking(ctx, socket, user, tracking, { label: "stage-play-reset-mission-update" });
}

function getServerNow(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const date = ctx.getServerNowDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function saveIfLocal(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

module.exports = {
  PACKETS,
  ERROR_CODES,
  createStagePlayResetHandlers,
  resetStagePlayCount,
  buildStagePlayData,
};
