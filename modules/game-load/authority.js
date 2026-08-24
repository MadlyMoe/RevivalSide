const GAME_LOAD_ERROR = Object.freeze({
  INVALID_REQUEST: 20191,
  INSUFFICIENT_CASH: 96,
  INSUFFICIENT_ETERNIUM: 97,
  INSUFFICIENT_CREDIT: 98,
  INSUFFICIENT_INFORMATION: 99,
  INSUFFICIENT_ITEM: 111,
  REWARD_MULTIPLY_OVER_MAX: 20394,
  REWARD_MULTIPLY_OVER_DAILY_ENTER_LIMIT: 20395,
  REWARD_MULTIPLY_NOT_AVAILABLE: 20403,
});

function validateGameLoadRewardMultiply(user, req = {}, stage = {}) {
  const raw = req.rewardMultiply == null ? 1 : Number(req.rewardMultiply);
  if (!Number.isInteger(raw) || raw < 0) return failure(GAME_LOAD_ERROR.INVALID_REQUEST);
  const rewardMultiply = raw === 0 && stage.allowZeroRewardMultiply === true ? 0 : Math.max(1, raw);
  if (stage.authoritative !== true || rewardMultiply <= 1) {
    return { valid: true, errorCode: 0, rewardMultiply };
  }

  const maximum = Math.max(0, Number(stage.rewardMultiplyMax || 0) || 0);
  if (maximum <= 1) return failure(GAME_LOAD_ERROR.REWARD_MULTIPLY_NOT_AVAILABLE);
  if (rewardMultiply > maximum) return failure(GAME_LOAD_ERROR.REWARD_MULTIPLY_OVER_MAX);

  const enterLimit = Math.max(0, Number(stage.enterLimit || 0) || 0);
  const playCount = getStagePlayCount(user, stage.stageId);
  if (enterLimit > 0 && playCount + rewardMultiply > enterLimit) {
    return failure(GAME_LOAD_ERROR.REWARD_MULTIPLY_OVER_DAILY_ENTER_LIMIT);
  }

  const cost = normalizeCost(stage.cost);
  if (cost && getItemBalance(user, cost.itemId) < BigInt(cost.count) * BigInt(rewardMultiply)) {
    return failure(insufficientItemError(cost.itemId));
  }
  return { valid: true, errorCode: 0, rewardMultiply, cost };
}

function getStagePlayCount(user, stageId) {
  const rows = user && user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const row = rows[String(Number(stageId || 0))] || {};
  return Math.max(0, Number(row.playCount || 0) || 0);
}

function getItemBalance(user, itemId) {
  const misc = user && user.inventory && user.inventory.misc && typeof user.inventory.misc === "object"
    ? user.inventory.misc
    : {};
  const item = misc[String(Number(itemId))] || {};
  return toNonNegativeBigInt(item.countFree != null ? item.countFree : item.count || 0) +
    toNonNegativeBigInt(item.countPaid || 0);
}

function normalizeCost(value) {
  const itemId = Number(value && value.itemId);
  const count = Number(value && value.count);
  return Number.isInteger(itemId) && itemId > 0 && Number.isInteger(count) && count > 0 ? { itemId, count } : null;
}

function insufficientItemError(itemId) {
  if (Number(itemId) === 1) return GAME_LOAD_ERROR.INSUFFICIENT_CASH;
  if (Number(itemId) === 2) return GAME_LOAD_ERROR.INSUFFICIENT_ETERNIUM;
  if (Number(itemId) === 3) return GAME_LOAD_ERROR.INSUFFICIENT_INFORMATION;
  if (Number(itemId) === 101) return GAME_LOAD_ERROR.INSUFFICIENT_CREDIT;
  return GAME_LOAD_ERROR.INSUFFICIENT_ITEM;
}

function toNonNegativeBigInt(value) {
  try {
    const numeric = BigInt(value || 0);
    return numeric > 0n ? numeric : 0n;
  } catch (_) {
    return 0n;
  }
}

function failure(errorCode) {
  return { valid: false, errorCode };
}

module.exports = {
  GAME_LOAD_ERROR,
  validateGameLoadRewardMultiply,
};
