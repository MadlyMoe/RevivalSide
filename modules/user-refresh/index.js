"use strict";

const {
  clearMissionPointRefreshNotifications,
  getMissionPointRefreshNotifications,
} = require("../account-progression");
const stamina = require("../stamina");

function prepareUserRefreshNotifications(user, options = {}) {
  const now = options.now;
  const staminaResult = stamina.refreshTimedStamina(user, {
    now,
    itemIds: stamina.DAILY_REFRESH_ITEM_IDS,
    initializeMissing: options.initializeMissing === true,
  });
  const mission = getMissionPointRefreshNotifications(user, now);
  const dailyItems = uniqueItems([
    ...stamina.getPendingDailyRefreshItems(user),
    mission.daily,
  ]);
  const weeklyItems = uniqueItems([mission.weekly]);
  const packets = [];
  if (dailyItems.length > 0) {
    packets.push({
      packetId: stamina.CONTENTS_DAILY_REFRESH_NOT,
      payload: stamina.buildContentsDailyRefreshNotPayload(dailyItems),
      scope: "daily",
    });
  }
  if (weeklyItems.length > 0) {
    packets.push({
      packetId: stamina.WEEKLY_REFRESH_NOT,
      payload: stamina.buildWeeklyRefreshNotPayload(weeklyItems),
      scope: "weekly",
    });
  }

  let committed = false;
  return {
    changed: staminaResult.changed,
    dailyItems,
    weeklyItems,
    packets,
    commit() {
      if (committed) return false;
      committed = true;
      let changed = false;
      if (dailyItems.length > 0) {
        changed = stamina.clearPendingDailyRefreshItems(user, dailyItems.map((item) => item.itemId)) || changed;
        changed = clearMissionPointRefreshNotifications(user, ["daily"]) || changed;
      }
      if (weeklyItems.length > 0) {
        changed = clearMissionPointRefreshNotifications(user, ["weekly"]) || changed;
      }
      return changed;
    },
  };
}

function uniqueItems(items) {
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const itemId = Number(item && item.itemId || 0);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    byId.set(itemId, item);
  }
  return Array.from(byId.values()).sort((left, right) => Number(left.itemId) - Number(right.itemId));
}

module.exports = {
  prepareUserRefreshNotifications,
};
