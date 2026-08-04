const fs = require("fs");
const path = require("path");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { createAdminRewardPosts } = require("../admin");
const {
  writeString,
  writeSignedVarInt,
  writeSignedVarLong,
  writeInt64LE,
  writeNullableObject,
  writeObjectList,
  farFutureDateTimeBinary,
  toBigInt,
} = require("../packet-codec");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const ATTENDANCE_STATE_VERSION = 1;
const DEFAULT_REWARD_TITLE = "Attendance Check-In Reward";
const ATTENDANCE_RESET_HOUR_UTC = 19;
const NEWBIE_ALWAYS_TAG = "ATTEND_NEWBIE_ALWAYS_V2";
const ACTIVE_EVENT_INTERVALS = [
  {
    tags: ["TAG_ATTEND_EVENT_BONUS_V4", "DATE_ATTEND_EVENT_BONUS_V4"],
    start: "2026-05-06T00:00:00.000Z",
    end: "2026-05-13T19:00:00.000Z",
  },
];

let cachedCatalog = null;
let cachedCatalogKey = "";

function ensureAttendanceRewardPosts(user, options = {}) {
  return claimDailyAttendance(user, options).createdPosts;
}

function claimDailyAttendance(user, options = {}) {
  const result = {
    createdPosts: 0,
    checkedIn: false,
    dateKey: "",
    tabIdx: 0,
    tabIds: [],
    count: 0,
    rewardCount: 0,
  };
  if (!user || typeof user !== "object") return result;
  if (process.env.CS_DISABLE_ATTENDANCE_REWARD_MAIL === "1") return result;

  const now = getAttendanceNow(options);
  const clockNow = getAttendanceClockNow(options);
  const dateKey = normalizeDateKey(options.dateKey || now);
  const catalog = loadAttendanceCatalog();
  const state = ensureAttendanceState(user, catalog);
  const activeTabs = resolveActiveAttendanceTabs(user, state, catalog, now);
  if (!activeTabs.length) return result;

  result.dateKey = dateKey;
  const nowBinary = dateTimeBinaryForDate(clockNow);
  state.activeTabIdx = activeTabs[0].idx;
  state.lastUpdateDate = String(nowBinary);

  for (const tab of activeTabs) {
    const entry = ensureAttendanceEntry(state, tab);
    result.tabIds.push(tab.idx);
    if (!result.tabIdx) result.tabIdx = tab.idx;
    if (entry.lastClaimDate === dateKey) {
      result.count = Math.max(result.count, Number(entry.count || 0));
      continue;
    }
    if (Number(entry.count || 0) >= Number(tab.maxAttCount || 1)) {
      result.count = Math.max(result.count, Number(entry.count || 0));
      continue;
    }

    const nextCount = Math.max(0, Number(entry.count || 0)) + 1;
    const rewards = getAttendanceRewardSpecs(catalog, tab.rewardGroup, nextCount);

    entry.count = nextCount;
    entry.rewardGroup = tab.rewardGroup;
    entry.maxAttCount = tab.maxAttCount;
    entry.eventEndDate = String(tab.eventEndDate || entry.eventEndDate || farFutureDateTimeBinary());
    entry.lastClaimDate = dateKey;
    entry.lastClaimedAt = clockNow.toISOString();
    state.lastRewardDate = dateKey;

    if (rewards.length) {
      const title = process.env.CS_ATTENDANCE_REWARD_TITLE || DEFAULT_REWARD_TITLE;
      const contents =
        process.env.CS_ATTENDANCE_REWARD_CONTENTS ||
        `Day ${nextCount} reward from attendance group ${tab.rewardGroup}.`;
      result.createdPosts += createAdminRewardPosts(user, rewards, title, contents).length;
    }

    result.checkedIn = true;
    result.tabIdx = tab.idx;
    result.count = nextCount;
    result.rewardCount += rewards.length;
  }

  return result;
}

function buildAttendanceData(user, options = {}) {
  if (!user || typeof user !== "object") return Buffer.concat([writeInt64LE(0n), writeObjectList([])]);
  const now = getAttendanceNow(options);
  const clockNow = getAttendanceClockNow(options);
  const dateKey = normalizeDateKey(options.dateKey || now);
  const catalog = loadAttendanceCatalog();
  const state = ensureAttendanceState(user, catalog);
  const activeTabs = resolveActiveAttendanceTabs(user, state, catalog, now);
  if (activeTabs.length) state.activeTabIdx = activeTabs[0].idx;
  if (state.lastRewardDate === dateKey || state.lastPromptDate === dateKey) {
    state.lastUpdateDate = String(dateTimeBinaryForDate(clockNow));
  }
  return Buffer.concat([
    writeInt64LE(toBigInt(state.lastUpdateDate || 0, 0n)),
    writeObjectList(getSerializableAttendanceEntries(state, activeTabs).map((entry) => writeNullableObject(buildAttendanceEntryData(entry)))),
  ]);
}

function buildAttendanceNotifyPayload(user, options = {}) {
  if (!user || typeof user !== "object") return null;
  const now = getAttendanceNow(options);
  const clockNow = getAttendanceClockNow(options);
  const dateKey = normalizeDateKey(options.dateKey || now);
  const catalog = loadAttendanceCatalog();
  const state = ensureAttendanceState(user, catalog);
  if (!options.force && state.lastPromptDate === dateKey) return null;

  const activeTabs = resolveActiveAttendanceTabs(user, state, catalog, now);
  const entries = activeTabs
    .map((tab) => ensureAttendanceEntry(state, tab))
    .filter((entry) => Number(entry.count || 0) > 0 && entry.lastClaimDate === dateKey);
  if (!entries.length) return null;

  if (options.consumePrompt) {
    state.lastPromptDate = dateKey;
    state.lastPromptedAt = clockNow.toISOString();
    state.lastUpdateDate = String(dateTimeBinaryForDate(clockNow));
  }

  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarLong(rawDateTimeTicks(clockNow)),
    writeObjectList(entries.map((entry) => writeNullableObject(buildAttendanceEntryData(entry)))),
  ]);
}

function buildAttendanceIntervalDataList(user, options = {}) {
  if (!user || typeof user !== "object") return [];
  const now = getAttendanceNow(options);
  const catalog = loadAttendanceCatalog();
  const state = ensureAttendanceState(user, catalog);
  const seenStrKeys = new Set();
  return resolveActiveAttendanceTabs(user, state, catalog, now)
    .filter((tab) => {
      const strKey = attendanceIntervalStrKey(tab);
      if (seenStrKeys.has(strKey)) return false;
      seenStrKeys.add(strKey);
      return true;
    })
    .map(buildAttendanceIntervalData);
}

function ensureAttendanceState(user, catalog = loadAttendanceCatalog()) {
  user.attendance =
    user.attendance && typeof user.attendance === "object" && !Array.isArray(user.attendance)
      ? user.attendance
      : {};
  const state = user.attendance;
  state.schemaVersion = ATTENDANCE_STATE_VERSION;
  state.tabs = state.tabs && typeof state.tabs === "object" && !Array.isArray(state.tabs) ? state.tabs : {};
  state.rotationIndex = normalizeRotationIndex(state.rotationIndex, catalog.tabs.length);
  state.activeTabIdx = Number(state.activeTabIdx || 0) || 0;
  state.lastRewardDate = normalizeStoredDateKey(state.lastRewardDate);
  state.lastPromptDate = normalizeStoredDateKey(state.lastPromptDate);
  if (!state.promptTrackingInitialized && !state.lastPromptDate && state.lastRewardDate) {
    state.lastPromptDate = state.lastRewardDate;
  }
  state.promptTrackingInitialized = true;
  state.lastPromptedAt = state.lastPromptedAt ? String(state.lastPromptedAt) : "";
  state.lastUpdateDate = String(toBigInt(state.lastUpdateDate || 0, 0n));
  return state;
}

function resolveActiveAttendanceTabs(user, state, catalog, now = getAttendanceNow()) {
  if (!catalog.tabs.length) return [];

  const explicitTabIds = parseNumberSet(
    process.env.CS_ACTIVE_ATTENDANCE_TAB_IDS || process.env.CS_ATTENDANCE_ACTIVE_TAB_IDS || ""
  );
  const activeTabs = [];
  if (explicitTabIds.size) {
    for (const tab of catalog.tabs) {
      if (!explicitTabIds.has(tab.idx)) continue;
      addActiveAttendanceTab(activeTabs, tab, eventIntervalForTab(tab, now, user, state));
    }
    return sortActiveAttendanceTabs(activeTabs);
  }

  for (const tab of catalog.tabs) {
    addActiveAttendanceTab(activeTabs, tab, eventIntervalForTab(tab, now, user, state));
  }

  return sortActiveAttendanceTabs(activeTabs);
}

function ensureAttendanceEntry(state, tab, options = {}) {
  const key = String(tab.idx);
  const existing =
    !options.reset && state.tabs[key] && typeof state.tabs[key] === "object" && !Array.isArray(state.tabs[key])
      ? state.tabs[key]
      : {};
  const entry = {
    idx: tab.idx,
    count: clampAttendanceCount(existing.count, tab.maxAttCount),
    rewardGroup: tab.rewardGroup,
    maxAttCount: tab.maxAttCount,
    eventEndDate: String(
      toBigInt(tab.eventEndDate || existing.eventEndDate || farFutureDateTimeBinary(), farFutureDateTimeBinary())
    ),
    lastClaimDate: normalizeStoredDateKey(existing.lastClaimDate),
    lastClaimedAt: existing.lastClaimedAt ? String(existing.lastClaimedAt) : "",
  };
  state.tabs[key] = entry;
  return entry;
}

function getSerializableAttendanceEntries(state, activeTabs) {
  return activeTabs.map((tab) => ensureAttendanceEntry(state, tab)).filter((entry) => Number(entry.count || 0) > 0);
}

function buildAttendanceEntryData(entry) {
  return Buffer.concat([
    writeSignedVarInt(Number(entry.idx || 0)),
    writeSignedVarInt(Number(entry.count || 0)),
    writeInt64LE(toBigInt(entry.eventEndDate || farFutureDateTimeBinary(), farFutureDateTimeBinary())),
  ]);
}

function getAttendanceRewardSpecs(catalog, rewardGroup, loginDate) {
  const byDate = catalog.rewardsByGroup.get(Number(rewardGroup));
  if (!byDate) return [];
  const records = byDate.get(Number(loginDate)) || [];
  return records
    .map((record) => ({
      rewardType: String(record.m_RewardType || ""),
      id: Number(record.m_RewardID || 0),
      count: Number(record.m_RewardValue || 0),
    }))
    .filter((reward) => reward.rewardType && Number.isInteger(reward.id) && reward.id > 0 && reward.count > 0);
}

function loadAttendanceCatalog() {
  const tabPath = attendanceTabTablePath();
  const rewardPath = attendanceRewardTablePath();
  const cacheKey = `${tabPath || "luac:LUA_ATTENDANCE_TAB_TEMPLET"}\n${rewardPath || "luac:LUA_ATTENDANCE_REWARD_TEMPLET"}\n${process.env.CS_ATTENDANCE_TAB_IDX || ""}\n${process.env.CS_ATTENDANCE_TAB_IDS || ""}\n${process.env.CS_ATTENDANCE_REWARD_GROUP || ""}\n${process.env.CS_ATTENDANCE_REWARD_GROUPS || ""}\n${process.env.CS_ACTIVE_ATTENDANCE_TAB_IDS || ""}\n${process.env.CS_ATTENDANCE_ACTIVE_TAB_IDS || ""}`;
  if (cachedCatalog && cachedCatalogKey === cacheKey) return cachedCatalog;

  const rewardRecords = rewardPath
    ? readJsonRecords(rewardPath)
    : readGameplayTableRecords("ab_script", "LUA_ATTENDANCE_REWARD_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "attendance" });
  const rewardsByGroup = new Map();
  for (const record of rewardRecords) {
    const group = Number(record && record.m_RewardGroup);
    const day = Number(record && record.m_LoginDate);
    if (!Number.isInteger(group) || group <= 0 || !Number.isInteger(day) || day <= 0) continue;
    if (!rewardsByGroup.has(group)) rewardsByGroup.set(group, new Map());
    const byDate = rewardsByGroup.get(group);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push(record);
  }

  const explicitTabIds = parseNumberSet(process.env.CS_ATTENDANCE_TAB_IDX || process.env.CS_ATTENDANCE_TAB_IDS);
  const explicitGroups = parseNumberSet(process.env.CS_ATTENDANCE_REWARD_GROUP || process.env.CS_ATTENDANCE_REWARD_GROUPS);
  const tabRecords = tabPath
    ? readJsonRecords(tabPath)
    : readGameplayTableRecords("ab_script", "LUA_ATTENDANCE_TAB_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "attendance" });
  const allTabs = tabRecords.map((record) => normalizeAttendanceTab(record, rewardsByGroup)).filter(Boolean);
  let tabs = allTabs;
  if (explicitTabIds.size) tabs = tabs.filter((tab) => explicitTabIds.has(tab.idx));
  if (explicitGroups.size) tabs = tabs.filter((tab) => explicitGroups.has(tab.rewardGroup));
  if (!tabs.length) tabs = allTabs;

  cachedCatalog = {
    tabs: tabs.sort((a, b) => a.idx - b.idx),
    rewardsByGroup,
  };
  cachedCatalogKey = cacheKey;
  return cachedCatalog;
}

function addActiveAttendanceTab(activeTabs, tab, interval) {
  if (!interval || !(interval.end instanceof Date) || Number.isNaN(interval.end.getTime())) return;
  if (!(interval.start instanceof Date) || Number.isNaN(interval.start.getTime())) return;
  if (activeTabs.some((candidate) => candidate.idx === tab.idx)) return;
  activeTabs.push({
    ...tab,
    eventStartDate: rawDateTimeTicks(interval.start),
    eventStartDateIso: interval.start.toISOString(),
    eventEndDate: rawDateTimeTicks(interval.end),
    eventEndDateIso: interval.end.toISOString(),
  });
}

function sortActiveAttendanceTabs(tabs) {
  return tabs.sort((left, right) => {
    const tabOrder = Number(left.tabId || 0) - Number(right.tabId || 0);
    return tabOrder || Number(left.idx || 0) - Number(right.idx || 0);
  });
}

function eventIntervalForTab(tab, now, user, state) {
  if (!tab) return null;
  const monthlyInterval = monthlyEventInterval(tab, now);
  if (monthlyInterval) return monthlyInterval;
  const configuredInterval = configuredEventInterval(tab, now);
  if (configuredInterval) return configuredInterval;
  const newbieInterval = newbieEventInterval(tab, now, user, state);
  if (newbieInterval) return newbieInterval;
  return null;
}

function monthlyEventInterval(tab, now) {
  const key = String(tab.dateStrId || tab.openTag || "");
  const match = key.match(/^ATTEND_MONTHLY_(\d{2})(\d{2})$/);
  if (!match) return null;
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const serviceDate = attendanceServiceDate(now);
  if (serviceDate.getUTCFullYear() !== year || serviceDate.getUTCMonth() + 1 !== month) return null;

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = endOfUtcMonthAtReset(year, month);
  if (now >= end) return null;
  return { start, end };
}

function configuredEventInterval(tab, now) {
  const tabTags = new Set([tab.openTag, tab.dateStrId].filter(Boolean).map(String));
  for (const interval of ACTIVE_EVENT_INTERVALS) {
    if (!interval.tags.some((tag) => tabTags.has(tag))) continue;
    const start = new Date(interval.start);
    const end = new Date(interval.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (now >= start && now < end) return { start, end };
  }
  return null;
}

function newbieEventInterval(tab, now, user, state) {
  const isNewbieTab = tab.openTag === NEWBIE_ALWAYS_TAG || tab.dateStrId === NEWBIE_ALWAYS_TAG || tab.idx === 40000;
  if (!isNewbieTab) return null;
  if (process.env.CS_DISABLE_NEW_ATTENDANCE === "1") return null;

  const entry = state && state.tabs ? state.tabs[String(tab.idx)] : null;
  if (entry && Number(entry.count || 0) >= Number(tab.maxAttCount || 1)) return null;

  const registerTime = getUserRegisterDate(user);
  const limitDays = Math.max(0, Number(tab.limitDayCount || 0) || 0);
  const loadedEventDay = getLoadEventFromDayDate();
  if (!loadedEventDay && limitDays > 0 && registerTime) {
    const ageMs = now.getTime() - registerTime.getTime();
    if (ageMs > limitDays * 24 * 60 * 60 * 1000) return null;
  }

  const sourceDate = loadedEventDay || registerTime || now;
  const start = startOfUtcDay(sourceDate);
  const end = endOfUtcMonthAtReset(sourceDate.getUTCFullYear(), sourceDate.getUTCMonth() + 1);
  return now >= start && now < end ? { start, end } : null;
}

function buildAttendanceIntervalData(tab) {
  const strKey = attendanceIntervalStrKey(tab);
  return Buffer.concat([
    writeSignedVarInt(stablePositiveInt(strKey)),
    writeString(strKey),
    writeInt64LE(toBigInt(tab.eventStartDate || 0, 0n)),
    writeInt64LE(toBigInt(tab.eventEndDate || farFutureDateTimeBinary(), farFutureDateTimeBinary())),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
  ]);
}

function attendanceIntervalStrKey(tab) {
  return String(tab && (tab.dateStrId || tab.openTag || `ATTENDANCE_${tab.idx}`) || "");
}

function stablePositiveInt(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 1) || 1;
}

function endOfUtcMonthAtReset(year, month) {
  return new Date(Date.UTC(year, month, 0, ATTENDANCE_RESET_HOUR_UTC, 0, 0, 0));
}

function getUserRegisterDate(user) {
  if (!user || typeof user !== "object") return null;
  const candidates = [
    user.registeredAt,
    user.registerTime,
    user.createdAt,
    user.joinedAt,
    user.firstLoginAt,
    user.m_RegisterTime,
    user.userDateData && user.userDateData.registerTime,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function normalizeAttendanceTab(record, rewardsByGroup) {
  if (!record || typeof record !== "object") return null;
  const idx = Number(record.IDX || 0);
  const rewardGroup = Number(record.m_RewardGroup || 0);
  const eventType = String(record.m_EventType || "").toUpperCase();
  const rewards = rewardsByGroup.get(rewardGroup);
  const rewardDayCount = rewards ? rewards.size : 0;
  const maxAttCount = Number(record.m_MaxAttCount || rewardDayCount || 0);
  if (!Number.isInteger(idx) || idx <= 0) return null;
  if (!Number.isInteger(rewardGroup) || rewardGroup <= 0 || !rewardDayCount) return null;
  if (eventType && !["NORMAL", "NEW"].includes(eventType)) return null;
  if (!Number.isInteger(maxAttCount) || maxAttCount <= 0) return null;
  return {
    idx,
    rewardGroup,
    maxAttCount,
    eventType,
    dateStrId: String(record.m_DateStrID || ""),
    openTag: String(record.m_OpenTag || ""),
    tabId: Number(record.m_TabID || 0) || 0,
    limitDayCount: Number(record.m_LimitDayCount || 0) || 0,
  };
}

function attendanceTabTablePath() {
  return process.env.CS_ATTENDANCE_TAB_TABLE_PATH || "";
}

function attendanceRewardTablePath() {
  return process.env.CS_ATTENDANCE_REWARD_TABLE_PATH || "";
}

function readJsonRecords(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch (err) {
    console.log(`[attendance] failed to load ${filePath}: ${err.message}`);
    return [];
  }
}

function parseNumberSet(value) {
  return new Set(
    String(value || "")
      .split(/[;,]/)
      .map((part) => Number(String(part).trim()))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
}

function normalizeRotationIndex(value, length) {
  const count = Math.max(0, Number(length) || 0);
  if (count <= 0) return 0;
  const index = Number(value || 0);
  if (!Number.isFinite(index)) return 0;
  return ((Math.trunc(index) % count) + count) % count;
}

function clampAttendanceCount(value, maxAttCount) {
  const max = Math.max(1, Number(maxAttCount) || 1);
  const count = Number(value || 0);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(count)));
}

function rawDateTimeTicks(date) {
  const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return BigInt(source.getTime()) * 10000n + TICKS_AT_UNIX_EPOCH;
}

function getAttendanceNow(options = {}) {
  if (options.now instanceof Date && !Number.isNaN(options.now.getTime())) return options.now;
  return getLoadEventFromDayDate() || new Date();
}

function getAttendanceClockNow(options = {}) {
  if (options.clockNow instanceof Date && !Number.isNaN(options.clockNow.getTime())) return options.clockNow;
  if (options.now instanceof Date && !Number.isNaN(options.now.getTime())) return options.now;
  return new Date();
}

function getLoadEventFromDayDate() {
  const value = firstNonEmptyEnv([
    "loadeventfromday",
    "LOADEVENTFROMDAY",
    "CS_EVENT_DATE",
    "CS_EVENT_MANAGER_DATE",
    "CS_LOAD_EVENT_FROM_DAY",
    "CS_ATTENDANCE_LOAD_EVENT_FROM_DAY",
  ]);
  return value ? parseUtcDay(value) : null;
}

function firstNonEmptyEnv(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function parseUtcDay(value) {
  const text = String(value || "").trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return validUtcDay(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return validUtcDay(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

function validUtcDay(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function dateTimeBinaryForDate(date) {
  return rawDateTimeTicks(date) | DATE_TIME_LOCAL_MASK;
}

function normalizeDateKey(value) {
  if (value instanceof Date) return formatAttendanceDateKey(value);
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? formatAttendanceDateKey(getAttendanceNow()) : formatAttendanceDateKey(date);
}

function normalizeStoredDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function formatAttendanceDateKey(date) {
  const shifted = attendanceServiceDate(date);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function attendanceServiceDate(date) {
  const shifted = new Date(date.getTime());
  if (shifted.getUTCHours() >= ATTENDANCE_RESET_HOUR_UTC) {
    shifted.setUTCDate(shifted.getUTCDate() + 1);
  }
  return shifted;
}

module.exports = {
  ensureAttendanceRewardPosts,
  claimDailyAttendance,
  buildAttendanceData,
  buildAttendanceNotifyPayload,
  buildAttendanceIntervalDataList,
  loadAttendanceCatalog,
};
