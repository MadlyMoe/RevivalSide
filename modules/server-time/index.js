const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MS = 10000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DATE_TIME_TICKS_MASK = 0x3fffffffffffffffn;

function createServerTime(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "..", ".."));
  const statePath = path.resolve(options.statePath || path.join(rootDir, "server-data", "server-time.json"));
  const logger = typeof options.logger === "function" ? options.logger : null;
  const defaultDate = coerceDate(options.defaultDate || options.eventDate);
  const defaultDateKey = defaultDate ? utcDateKey(defaultDate) : "";
  let state = loadState(statePath, logger);

  function now(localNowInput = new Date()) {
    const localNow = validDate(localNowInput) || new Date();
    const manualNow = getManualNow(state, localNow);
    if (manualNow) return manualNow;
    if (defaultDateKey) return combineUtcDateWithLocalTime(defaultDateKey, localNow);
    return new Date(localNow.getTime());
  }

  function getSummary() {
    const current = now();
    const manualCurrent = getManualNow(state, new Date());
    return {
      enabled: true,
      mode: manualCurrent ? "manual" : defaultDateKey ? "event-date" : "local",
      manual: Boolean(manualCurrent),
      defaultDateKey,
      statePath,
      currentIso: current.toISOString(),
      eventDateKey: utcDateKey(current),
      state: { ...state },
    };
  }

  function setManualTime(serverDateInput, localNowInput = new Date()) {
    const serverDate = coerceDate(serverDateInput);
    if (!serverDate) throw new Error("Invalid server time.");
    const localNow = validDate(localNowInput) || new Date();
    const serverDateKey = utcDateKey(serverDate);
    state = {
      ...createAnchoredState(serverDateKey, localDayKey(localNow)),
      manualServerIso: serverDate.toISOString(),
      manualLocalIso: localNow.toISOString(),
      manualSetAt: new Date().toISOString(),
    };
    saveState(statePath, state, logger);
    return now(localNow);
  }

  function clearManualTime(localNowInput = new Date()) {
    const localNow = validDate(localNowInput) || new Date();
    state = {};
    saveState(statePath, state, logger);
    return now(localNow);
  }

  return {
    now,
    setManualTime,
    set: setManualTime,
    clearManualTime,
    clearManual: clearManualTime,
    dateTimeTicksNow(localNowInput) {
      return dateTimeTicksForDate(now(localNowInput));
    },
    dateTimeBinaryNow(localNowInput) {
      return dateTimeBinaryForDate(now(localNowInput));
    },
    eventDateKey(localNowInput) {
      return utcDateKey(now(localNowInput));
    },
    getSummary,
    getState() {
      return { ...state };
    },
  };
}

function createAnchoredState(eventDateKey, localDayKeyValue) {
  return {
    version: STATE_VERSION,
    eventDateKey,
    anchorServerDateKey: eventDateKey,
    anchorLocalDayKey: localDayKeyValue,
    lastLocalDayKey: localDayKeyValue,
    lastServerDateKey: eventDateKey,
    updatedAt: new Date().toISOString(),
  };
}

function isUsableState(value) {
  return (
    value &&
    typeof value === "object" &&
    Number(value.version || 0) === STATE_VERSION &&
    isDateKey(value.eventDateKey) &&
    isDateKey(value.anchorServerDateKey) &&
    isDateKey(value.anchorLocalDayKey)
  );
}

function isManualState(value) {
  return (
    value &&
    typeof value === "object" &&
    Number(value.version || 0) === STATE_VERSION &&
    coerceDate(value.manualServerIso) &&
    coerceDate(value.manualLocalIso)
  );
}

function getManualNow(value, localNowInput = new Date()) {
  if (!isManualState(value)) return null;
  const serverDate = coerceDate(value.manualServerIso);
  const localAnchor = coerceDate(value.manualLocalIso);
  const localNow = validDate(localNowInput) || new Date();
  const elapsedMs = Math.max(0, localNow.getTime() - localAnchor.getTime());
  return new Date(serverDate.getTime() + elapsedMs);
}

function loadState(statePath, logger) {
  try {
    if (!statePath || !fs.existsSync(statePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (logger) logger(`[server-time] failed to read ${statePath}: ${error.message}`);
    return {};
  }
}

function saveState(statePath, state, logger) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmpPath = `${statePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, statePath);
  } catch (error) {
    if (logger) logger(`[server-time] failed to save ${statePath}: ${error.message}`);
  }
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

function coerceDate(value) {
  if (validDate(value)) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return validDate(date);
  }
  return null;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function utcDateKey(date) {
  const source = validDate(date) || new Date();
  return [
    source.getUTCFullYear(),
    pad2(source.getUTCMonth() + 1),
    pad2(source.getUTCDate()),
  ].join("-");
}

function localDayKey(date) {
  const source = validDate(date) || new Date();
  return [source.getFullYear(), pad2(source.getMonth() + 1), pad2(source.getDate())].join("-");
}

function daysBetweenDateKeys(startKey, endKey) {
  const start = dateKeyToUtcMs(startKey);
  const end = dateKeyToUtcMs(endKey);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.trunc((end - start) / DAY_MS);
}

function addDaysToDateKey(dateKey, days) {
  const ms = dateKeyToUtcMs(dateKey);
  if (!Number.isFinite(ms)) return dateKey;
  return utcDateKey(new Date(ms + Math.trunc(Number(days) || 0) * DAY_MS));
}

function compareDateKeys(left, right) {
  const leftMs = dateKeyToUtcMs(left);
  const rightMs = dateKeyToUtcMs(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return 0;
  return leftMs === rightMs ? 0 : leftMs < rightMs ? -1 : 1;
}

function dateKeyToUtcMs(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return Number.NaN;
  }
  return date.getTime();
}

function combineUtcDateWithLocalTime(dateKey, localNow) {
  const ms = dateKeyToUtcMs(dateKey);
  const source = validDate(localNow) || new Date();
  if (!Number.isFinite(ms)) return new Date(source.getTime());
  const date = new Date(ms);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      source.getHours(),
      source.getMinutes(),
      source.getSeconds(),
      source.getMilliseconds()
    )
  );
}

function dateTimeTicksForDate(date) {
  const source = validDate(date) || new Date();
  return BigInt(source.getTime()) * TICKS_PER_MS + DOTNET_TICKS_AT_UNIX_EPOCH;
}

function dateTimeBinaryForDate(date) {
  return dateTimeTicksForDate(date) | DATE_TIME_LOCAL_MASK;
}

function rawTicksFromDateTime(value) {
  try {
    const raw = BigInt(value || 0);
    return raw > DATE_TIME_LOCAL_MASK ? raw & DATE_TIME_TICKS_MASK : raw;
  } catch (_) {
    return 0n;
  }
}

function dateFromDateTime(value) {
  try {
    const ticks = rawTicksFromDateTime(value);
    if (ticks <= DOTNET_TICKS_AT_UNIX_EPOCH) return null;
    const ms = (ticks - DOTNET_TICKS_AT_UNIX_EPOCH) / TICKS_PER_MS;
    const maxDateMs = 8640000000000000n;
    if (ms < -maxDateMs || ms > maxDateMs) return null;
    const date = new Date(Number(ms));
    return Number.isNaN(date.getTime()) ? null : date;
  } catch (_) {
    return null;
  }
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

module.exports = {
  createServerTime,
  dateFromDateTime,
  dateTimeBinaryForDate,
  dateTimeTicksForDate,
  rawTicksFromDateTime,
  utcDateKey,
};
