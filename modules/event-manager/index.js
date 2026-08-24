const fs = require("fs");
const path = require("path");
const { getGameplayTableRoots, listGameplayTableFiles, readGameplayTable } = require("../gameplay-jsons");

const DATE_PROFILES_FILE = path.join(__dirname, "date-profiles.json");
const DATE_PROFILE_TABLE_NAME = "EVENT_DATE_PROFILE";
const OFFICIAL_EVENT_SCHEDULE_FILE = path.join(__dirname, "official-event-schedules.json");
const OFFICIAL_EVENT_SCHEDULE_TABLE_NAME = "OFFICIAL_EVENT_SCHEDULE";
const EMPTY_OFFICIAL_SCHEDULE_SIGNALS = Object.freeze({
  openTags: Object.freeze([]),
  intervalTags: Object.freeze([]),
  contentsTagAllow: Object.freeze([]),
  counterPassIds: Object.freeze([]),
  entryCount: 0,
});

const DEFAULT_EVENT_TABLES = Object.freeze([
  table("interval", "ab_script", "LUA_INTERVAL_TEMPLET.json", { optional: true }),
  table("interval", "ab_script", "LUA_INTERVAL_TEMPLET_V2.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_BAR_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_TAB_TEMPLET.json"),
  table("event", "ab_script", "LUA_EVENT_LOBBY_INDEX_TEMPLET.json"),
  table("event", "ab_script", "LUA_EVENT_COLLECTION_INDEX_TEMPLET.json"),
  table("event", "ab_script", "LUA_EVENT_COLLECTION_MERGE_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_COLLECTION_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_PASS_TEMPLET.json"),
  table("event", "ab_script", "LUA_EVENT_PASS_MISSION_GROUP_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_PASS_REWARD_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_BINGO_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_BINGO_REWARD_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_BUFF_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_CONDITION_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_KILLCOUNT_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_MISSION_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_PAYBACK_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_RACE_TEMPLET.json", { optional: true }),
  table("event", "ab_script", "LUA_EVENT_RACE_ANIMATION_TEMPLET.json", { optional: true }),
  table("mission", "ab_script", "LUA_MISSION_TAB_TEMPLET.json"),
  table("reference", "ab_script", "LUA_MISSION_TEMPLET.json", { optional: true }),
  table("reference", "ab_script", "LUA_UNIT_MISSION_TEMPLET.json", { optional: true }),
  table("reference", "ab_script", "LUA_REWARD_TEMPLET_CL.json", { optional: true }),
  table("attendance", "ab_script", "LUA_ATTENDANCE_TAB_TEMPLET.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_TAB_TEMPLET_01.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_TAB_TEMPLET_02.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_CATEGORY_TEMPLET_01.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_CATEGORY_TEMPLET_02.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_TAB_CUSTOM_TEMPLET.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_FEATURED_TEMPLET.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_RECOMMEND_TEMPLET.json", { optional: true }),
  table("shop", "ab_script", "LUA_SHOP_TEMPLET_01.json"),
  table("shop", "ab_script", "LUA_SHOP_TEMPLET_02.json"),
  table("shop", "ab_script", "LUA_SHOP_BANNER_TEMPLET.json", { optional: true }),
  table("contract", "ab_script", "LUA_CONTRACT.json", { optional: true }),
  table("contract", "ab_script", "LUA_CONTRACT_TAB_TABLE.json", { optional: true }),
  table("contract", "ab_script", "LUA_CONTRACT_CATEGORY.json", { optional: true }),
  table("contract", "ab_script", "LUA_SELECTABLE_CONTRACT.json", { optional: true }),
  table("contract", "ab_script", "LUA_CONTRACT_UNIT_POOL.json", { optional: true }),
  table("contract", "ab_script", "LUA_SELECTABLE_CONTRACT_UNIT_POOL.json", { optional: true }),
  table("contract", "ab_script", "LUA_CONTRACT_CUSTOM_PICKUP.json", { optional: true }),
  table("contract", "ab_script", "LUA_MISC_CONTRACT.json", { optional: true }),
  table("contract", "ab_script", "LUA_RANDOM_GRADE_TABLE.json", { optional: true }),
  table("exchange", "ab_script", "LUA_POINT_EXCHANGE_TEMPLET.json", { optional: true }),
  table("exchange", "ab_script", "LUA_POINTEXCHANGE_TEMPLET.json", { optional: true }),
  table("pvp", "ab_script", "LUA_PVP_EVENTMATCH_SEASON.json", { optional: true }),
]);

const METADATA_KEYS = new Set([
  "source",
  "rootName",
  "recordCount",
  "records",
  "root",
  "unsupportedCount",
  "unsupported",
]);

const OPEN_TAG_FIELDS = Object.freeze([
  "m_OpenTag",
  "m_OpenTagName",
  "m_OpenTagStrID",
  "OpenTag",
  "openTag",
  "OpenTags",
  "openTags",
  "listOpenTag",
  "listOpenTags",
  "listOpenTagAllow",
]);

const INTERVAL_TAG_FIELDS = Object.freeze([
  "m_DateStrID",
  "m_DateStrId",
  "DateStrID",
  "DateStrId",
  "dateStrID",
  "dateStrId",
  "IntervalTag",
  "intervalTag",
  "m_IntervalTag",
  "m_IntervalStrID",
  "EventIntervalTag",
  "m_EventDateStrID",
  "m_DiscountDateStrID",
  "m_SeasonDateStrID",
  "m_RankGroupDateStrID",
  "m_RewardDateStrID",
  "EventRateDateStrID",
  "m_GameDateStrID",
  "ExchangeDateStrID",
  "RewardDateStrID",
  "m_EventRewardRateDateStrID",
  "Interval",
  "TournamentInterval",
]);

const CONTENTS_ALLOW_FIELDS = Object.freeze([
  "listContentsTagAllow",
  "contentsTagAllow",
  "ContentsTagAllow",
  "m_ContentsTagAllow",
  "m_ContentsTag",
  "listContentsTag",
]);

const CONTENTS_IGNORE_FIELDS = Object.freeze([
  "listContentsTagIgnore",
  "contentsTagIgnore",
  "ContentsTagIgnore",
  "m_ContentsTagIgnore",
]);

const FALLBACK_INTERVAL_START = Object.freeze(new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0)));
const FALLBACK_INTERVAL_END = Object.freeze(new Date(Date.UTC(2000, 0, 2, 0, 0, 0, 0)));
const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTER_PASS_MISSION_OPEN_TAG = "TAG_COMMON_MISSION_EVENT_PASS";
const COUNTER_PASS_DEFAULT_ANCHOR = "2021-05-26T04:00:00Z";

const START_DATE_FIELDS = Object.freeze([
  "startDate",
  "StartDate",
  "m_DateStart",
  "m_DateStart_UTC",
  "m_DateStart_KOR",
  "m_DateStart_JPN",
  "m_DateStart_SEA",
  "EventPassStartDate",
  "EventStartDate",
  "m_EventStartDate",
  "m_StartDate",
  "m_StartTime",
  "SeasonStartDate",
  "m_SeasonStartDate",
  "m_OpenDate",
]);

const END_DATE_FIELDS = Object.freeze([
  "endDate",
  "EndDate",
  "m_DateEnd",
  "m_DateEnd_UTC",
  "m_DateEnd_KOR",
  "m_DateEnd_JPN",
  "m_DateEnd_SEA",
  "EventPassEndDate",
  "EventEndDate",
  "m_EventEndDate",
  "m_EndDate",
  "m_EndTime",
  "SeasonEndDate",
  "m_SeasonEndDate",
  "m_CloseDate",
]);

const REPEAT_START_DATE_FIELDS = Object.freeze([
  "repeatStartDate",
  "RepeatStartDate",
  "m_RepeatDateStart",
  "m_RepeatStartDate",
]);

const REPEAT_END_DATE_FIELDS = Object.freeze([
  "repeatEndDate",
  "RepeatEndDate",
  "m_RepeatDateEnd",
  "m_RepeatEndDate",
]);

const ID_FIELDS = Object.freeze([
  "m_DateID",
  "DateID",
  "m_EventID",
  "EventID",
  "EventLobbyID",
  "EventPassID",
  "m_TabID",
  "m_MissionTabID",
  "m_MissionID",
  "m_ProductID",
  "ProductID",
  "ShopID",
  "ShopTabID",
  "m_ContractID",
  "ContractID",
  "SeasonID",
  "seasonID",
  "m_SeasonID",
  "m_ID",
  "ID",
  "idx",
  "IDX",
  "m_Idx",
  "id",
]);

const LABEL_FIELDS = Object.freeze([
  "m_EventTabDesc",
  "m_LobbyBannerText",
  "m_EventBannerPrefabName",
  "m_EventTabImage",
  "EventPassTitleStrID",
  "EventPassMainReward",
  "BannerID",
  "ShortCutParam",
  "m_MissionTabName",
  "m_MissionTabDesc",
  "m_TabStrID",
  "m_ShopName",
  "m_ProductName",
  "m_ContractName",
]);

function createEventManager(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "..", ".."));
  const env = options.env || process.env;
  const config = resolveEventManagerConfig({ rootDir, env });
  const reader = createEventTableReader({ rootDir, config, env });
  let cachedRegistry = null;

  function getRegistry() {
    if (!cachedRegistry) cachedRegistry = buildEventRegistry(reader.readTables(), config);
    return cachedRegistry;
  }

  function getSummary(date = config.eventDate || new Date()) {
    const registry = getRegistry();
    const targetDate = parseEventDateInput(date);
    const activeState = buildActiveEventState(registry, config, targetDate);
    return {
      enabled: config.enabled,
      mode: config.mode,
      dateInput: config.dateInput,
      dateIso: targetDate ? targetDate.toISOString() : "",
      timezone: config.timezone,
      profile: config.profile,
      officialScheduleEnabled: config.officialScheduleEnabled,
      dateProfilesEnabled: config.dateProfilesEnabled,
      tableScan: config.tableScan,
      tableRoots: config.tableRoots.slice(),
      tableCount: registry.tables.length,
      missingTableCount: registry.missingTables.length,
      entryCount: registry.entries.length,
      intervalCount: registry.intervals.length,
      requiredIntervalReferenceCount: registry.requiredIntervalRefs.length,
      activeEntryCount: activeState.entries.length,
      activeIntervalCount: activeState.intervalData.length,
      activeContentsTagCount: activeState.contentsTags.length,
      activeOpenTagCount: activeState.openTags.length,
      activeCounterPassCount: activeState.counterPasses.length,
      activeCounterPassContentsTagCount: activeState.counterPassContentsTags.length,
      activeOfficialScheduleCount: activeState.officialScheduleEntries.length,
      errors: registry.errors.slice(),
    };
  }

  return {
    config,
    reader,
    getRegistry,
    getSummary,
    getActiveEventState(date = config.eventDate || new Date()) {
      return buildActiveEventState(getRegistry(), config, date);
    },
    getKnownContentsTags() {
      return collectUsableTags(getRegistry().entries, "contentsTagAllow");
    },
    getKnownIntervalStrKeys() {
      const registry = getRegistry();
      return uniqueStrings([
        ...registry.requiredIntervalRefs.map((entry) => entry.strKey),
        ...registry.intervals.map((entry) => entry.strKey),
        ...registry.entries.flatMap((entry) => entry.intervalTags || []),
      ]);
    },
    getDiagnostics(date = config.eventDate || new Date(), options = {}) {
      return buildEventDiagnostics(getRegistry(), config, date, options);
    },
    formatDiagnostics(date = config.eventDate || new Date(), options = {}) {
      return formatEventDiagnostics(buildEventDiagnostics(getRegistry(), config, date, options));
    },
    selectEntriesForDate(date = config.eventDate || new Date()) {
      return selectRegistryEntriesForDate(getRegistry(), date);
    },
  };
}

function createEventTableReader(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "..", ".."));
  const env = options.env || process.env;
  const config = options.config || resolveEventManagerConfig({ rootDir, env });

  function readTables() {
    if (config.tableScan === "all" || config.tableScan === "recursive") return readAllGameplayTables();
    return readKnownEventTables();
  }

  function readKnownEventTables() {
    const tables = [];
    for (const definition of DEFAULT_EVENT_TABLES) {
      const tableData = readGameplayTable(definition.directory, definition.fileName, {
        rootDir,
        env,
        logLabel: "event-manager",
        optional: definition.optional,
      });
      if (tableData) {
        tables.push(attachTableDefinition(readGameplayTableData(tableData, definition), definition, rootDir));
      } else if (!definition.optional) {
        tables.push({
          category: definition.category,
          tableName: tableNameForFile(definition.fileName),
          fileName: definition.fileName,
          directory: definition.directory,
          filePath: "",
          relativePath: path.join(definition.directory, "luac", definition.fileName),
          records: [],
          root: null,
          missing: true,
          errors: [],
        });
      }
    }
    return tables;
  }

  function readAllGameplayTables() {
    const tables = [];
    for (const file of listGameplayTableFiles({ rootDir, env, explicitRoots: config.tableRoots })) {
      const category = categoryForTableName(tableNameForFile(file.fileName));
      const definition = {
        category,
        directory: file.directory,
        fileName: file.fileName,
        optional: true,
      };
      const tableData = readGameplayTable(file.directory, file.fileName, {
        rootDir,
        env,
        explicitRoots: [file.root],
        logLabel: "event-manager",
        optional: true,
        allowLuacWhenPackaged: true,
      });
      tables.push(
        attachTableDefinition(
          tableData
            ? readGameplayTableData(tableData, definition)
            : file.extension === ".json"
              ? readJsonTableFile(file.filePath)
              : missingGameplayTableFile(file, "luac export failed"),
          definition,
          file.root
        )
      );
    }
    return tables;
  }

  return {
    config,
    readTables,
    readKnownEventTables,
    readAllJsonTables: readAllGameplayTables,
    readAllGameplayTables,
  };
}

function buildEventRegistry(tables, config = {}) {
  const registry = {
    config,
    tables: [],
    missingTables: [],
    intervals: [],
    entries: [],
    requiredIntervalRefs: [],
    intervalsByStrKey: new Map(),
    entriesByOpenTag: new Map(),
    entriesByIntervalTag: new Map(),
    entriesByContentsTag: new Map(),
    errors: [],
  };
  const seenEntries = new Set();
  const seenIntervals = new Set();
  const seenIntervalRefs = new Set();

  for (const sourceTable of Array.isArray(tables) ? tables : []) {
    const tableInfo = summarizeTable(sourceTable);
    registry.tables.push(tableInfo);
    if (sourceTable.missing) {
      registry.missingTables.push(tableInfo);
      continue;
    }
    for (const error of sourceTable.errors || []) registry.errors.push(error);

    const records = Array.isArray(sourceTable.records) ? sourceTable.records : [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const source = makeRecordSource(sourceTable, index);
      for (const strKey of collectIntervalReferenceTags(record)) {
        if (!isRequiredIntervalKey(strKey) || seenIntervalRefs.has(strKey)) continue;
        seenIntervalRefs.add(strKey);
        registry.requiredIntervalRefs.push({
          kind: "interval-ref",
          strKey,
          startDate: null,
          endDate: null,
          repeatStartDay: 0,
          repeatEndDay: 0,
          source,
        });
      }

      if (sourceTable.category === "reference") continue;
      const entry = normalizeRegistryEntry(record, sourceTable, index);
      if (!entry) continue;

      if (entry.kind === "interval") {
        const key = `${entry.strKey || ""}:${entry.id || ""}:${entry.source.tableName}`;
        if (seenIntervals.has(key)) continue;
        seenIntervals.add(key);
        registry.intervals.push(entry);
        if (entry.strKey && !registry.intervalsByStrKey.has(entry.strKey)) {
          registry.intervalsByStrKey.set(entry.strKey, entry);
        }
        continue;
      }

      const key = [
        entry.source.tableName,
        entry.id || "",
        entry.openTags.join("|"),
        entry.intervalTags.join("|"),
        entry.contentsTagAllow.join("|"),
      ].join(":");
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);
      registry.entries.push(entry);
    }
  }

  hydrateEntriesWithIntervals(registry);
  indexEntries(registry);
  return registry;
}

function resolveEventManagerConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, "..", ".."));
  const env = options.env || process.env;
  const mode = String(env.CS_EVENT_MANAGER || "auto").trim().toLowerCase() || "auto";
  const dateInput = firstNonEmptyEnv(env, [
    "CS_EVENT_DATE",
    "CS_EVENT_MANAGER_DATE",
    "CS_LOAD_EVENT_FROM_DAY",
    "loadeventfromday",
    "LOADEVENTFROMDAY",
  ]);
  const eventDate = parseEventDateInput(dateInput);
  const disabled = ["0", "false", "off", "no", "disabled"].includes(mode);
  const enabled = !disabled && (["1", "true", "on", "yes", "enabled"].includes(mode) || mode === "auto");
  const tableScan = normalizeTableScan(env.CS_EVENT_TABLE_SCAN || "known");
  const counterPassMode = String(env.CS_EVENT_COUNTER_PASS || env.CS_COUNTER_PASS || "auto").trim().toLowerCase() || "auto";
  const counterPassDisabled = ["0", "false", "off", "no", "disabled"].includes(counterPassMode);

  return {
    enabled,
    mode,
    dateInput,
    eventDate,
    timezone: String(env.CS_EVENT_TIMEZONE || "UTC").trim() || "UTC",
    profile: String(env.CS_EVENT_PROFILE || "auto").trim() || "auto",
    tableScan,
    defaultWindowDays: readPositiveInt(env.CS_EVENT_DEFAULT_WINDOW_DAYS, 28),
    officialScheduleEnabled: parseEnvBool(env.CS_EVENT_OFFICIAL_SCHEDULE, true),
    dateProfilesEnabled: parseEnvBool(env.CS_EVENT_DATE_PROFILES, true),
    inferYearOnly: parseEnvBool(env.CS_EVENT_INFER_YEAR_ONLY, false),
    inferSeasonalIntervals: parseEnvBool(env.CS_EVENT_INFER_SEASONAL_INTERVALS, false),
    emitRequiredIntervals: parseEnvBool(env.CS_EVENT_EMIT_REQUIRED_INTERVALS, false),
    counterPassEnabled: !counterPassDisabled,
    counterPassMode,
    counterPassId: readOptionalPositiveInt(env.CS_EVENT_COUNTER_PASS_ID || env.CS_COUNTER_PASS_ID),
    counterPassAnchorDate: parseTableDate(env.CS_EVENT_COUNTER_PASS_ANCHOR_DATE || COUNTER_PASS_DEFAULT_ANCHOR) || parseTableDate(COUNTER_PASS_DEFAULT_ANCHOR),
    counterPassDurationDays: readPositiveInt(env.CS_EVENT_COUNTER_PASS_DURATION_DAYS, 35),
    counterPassCadenceDays: readPositiveInt(env.CS_EVENT_COUNTER_PASS_CADENCE_DAYS, readPositiveInt(env.CS_EVENT_COUNTER_PASS_DURATION_DAYS, 35)),
    counterPassRollingEnabled: parseEnvBool(env.CS_EVENT_COUNTER_PASS_ROLLING, false),
    tableRoots: resolveTableRoots(rootDir, env),
  };
}

function readJsonTableFile(filePath) {
  const result = {
    filePath,
    fileName: path.basename(filePath),
    tableName: tableNameForFile(path.basename(filePath)),
    rootName: "",
    source: "",
    root: null,
    records: [],
    errors: [],
    missing: false,
  };

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    result.source = typeof parsed.source === "string" ? parsed.source : "";
    result.rootName = typeof parsed.rootName === "string" ? parsed.rootName : result.tableName;
    result.root = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "root")
      ? parsed.root
      : null;
    result.records = extractRecords(parsed);
  } catch (error) {
    result.errors.push(`${filePath}: ${error.message}`);
  }

  return result;
}

function readGameplayTableData(parsed, definition) {
  return {
    filePath: "",
    fileName: definition.fileName,
    tableName: tableNameForFile(definition.fileName),
    rootName: parsed && typeof parsed.rootName === "string" ? parsed.rootName : tableNameForFile(definition.fileName),
    source: parsed && typeof parsed.source === "string" ? parsed.source : "",
    root: parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "root")
      ? parsed.root
      : null,
    records: extractRecords(parsed),
    errors: [],
    missing: false,
  };
}

function missingGameplayTableFile(file, message) {
  return {
    filePath: file.filePath || "",
    fileName: file.fileName || "",
    tableName: tableNameForFile(file.fileName || ""),
    rootName: "",
    source: "",
    root: null,
    records: [],
    errors: [message],
    missing: true,
  };
}

function parseEventDateInput(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = String(value || "").trim();
  if (!text) return null;

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12, 0, 0, 0));
    return isValidExactUtcDate(date, Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])) ? date : null;
  }

  return parseTableDate(text);
}

function loadDateProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATE_PROFILES_FILE, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.profiles)) return parsed.profiles;
  } catch {
    return [];
  }
  return [];
}

function loadOfficialEventSchedules() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OFFICIAL_EVENT_SCHEDULE_FILE, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.schedules)) return parsed.schedules;
  } catch {
    return [];
  }
  return [];
}

function normalizeDateProfileEntry(profile, index) {
  if (!profile || typeof profile !== "object" || profile.enabled === false) return null;
  const id = stringifyValue(profile.id || profile.name || `date-profile-${index + 1}`);
  const label = stringifyValue(profile.name || profile.id || id);
  const startDate = parseTableDate(profile.startDate || profile.start || profile.from);
  const endDate = parseTableDate(profile.endDate || profile.end || profile.to);
  const openTags = uniqueStrings([
    ...normalizeTags(profile.openTags),
    ...normalizeTags(profile.openTag),
    ...normalizeTags(profile.tags),
  ]);
  const intervalTags = uniqueStrings([
    ...normalizeTags(profile.intervalTags),
    ...normalizeTags(profile.intervalTag),
    ...normalizeTags(profile.intervalStrIDs),
    ...normalizeTags(profile.dateStrIDs),
    ...normalizeTags(profile.dateStrIds),
    ...normalizeTags(profile.intervals),
  ]);
  const contentsTagAllow = uniqueStrings([
    ...normalizeTags(profile.contentsTags),
    ...normalizeTags(profile.contentsTagAllow),
    ...normalizeTags(profile.contentsTag),
  ]);
  const contentsTagIgnore = uniqueStrings([
    ...normalizeTags(profile.contentsTagIgnore),
    ...normalizeTags(profile.ignoreContentsTags),
  ]);
  const counterPassIds = uniquePositiveInts([
    ...normalizeNumberValues(profile.counterPassIds),
    ...normalizeNumberValues(profile.counterPassId),
    ...normalizeNumberValues(profile.counterPasses),
    ...normalizeNumberValues(profile.eventPassIds),
    ...normalizeNumberValues(profile.eventPassId),
  ]);

  if (!startDate || !endDate || (!openTags.length && !intervalTags.length && !contentsTagAllow.length && !counterPassIds.length)) {
    return null;
  }

  return {
    kind: "entry",
    id,
    label,
    openTags,
    intervalTags,
    contentsTagAllow,
    contentsTagIgnore,
    counterPassIds,
    startDate,
    endDate,
    repeatStartDate: null,
    repeatEndDate: null,
    repeatStartDay: 0,
    repeatEndDay: 0,
    startDateText: stringifyValue(profile.startDate || profile.start || profile.from),
    endDateText: stringifyValue(profile.endDate || profile.end || profile.to),
    repeatStartDateText: "",
    repeatEndDateText: "",
    resolvedIntervalTag: "",
    resolvedStartDate: startDate,
    resolvedEndDate: endDate,
    resolvedRepeatStartDate: null,
    resolvedRepeatEndDate: null,
    resolvedRepeatStartDay: 0,
    resolvedRepeatEndDay: 0,
    source: {
      category: "profile",
      tableName: DATE_PROFILE_TABLE_NAME,
      fileName: path.basename(DATE_PROFILES_FILE),
      relativePath: path.join("modules", "event-manager", path.basename(DATE_PROFILES_FILE)),
      index,
    },
    raw: profile,
  };
}

function normalizeOfficialScheduleEntry(schedule, index, registry = null) {
  if (!schedule || typeof schedule !== "object" || schedule.enabled === false) return null;
  const id = stringifyValue(schedule.id || schedule.name || schedule.title || `official-schedule-${index + 1}`);
  const label = stringifyValue(schedule.name || schedule.title || schedule.id || id);
  const startDate = parseTableDate(schedule.startDate || schedule.start || schedule.from);
  const endDate = parseTableDate(schedule.endDate || schedule.end || schedule.to);
  const matchedSignals = schedule.runtimeMatch === true
    ? collectOfficialScheduleMatchedSignals(registry, schedule)
    : EMPTY_OFFICIAL_SCHEDULE_SIGNALS;
  const openTags = uniqueStrings([
    ...normalizeTags(schedule.openTags),
    ...normalizeTags(schedule.openTag),
    ...normalizeTags(schedule.tags),
    ...matchedSignals.openTags,
  ]);
  const intervalTags = uniqueStrings([
    ...normalizeTags(schedule.intervalTags),
    ...normalizeTags(schedule.intervalTag),
    ...normalizeTags(schedule.intervalStrIDs),
    ...normalizeTags(schedule.dateStrIDs),
    ...normalizeTags(schedule.dateStrIds),
    ...normalizeTags(schedule.intervals),
    ...matchedSignals.intervalTags,
  ]);
  const contentsTagAllow = uniqueStrings([
    ...normalizeTags(schedule.contentsTags),
    ...normalizeTags(schedule.contentsTagAllow),
    ...normalizeTags(schedule.contentsTag),
    ...matchedSignals.contentsTagAllow,
  ]);
  const contentsTagIgnore = uniqueStrings([
    ...normalizeTags(schedule.contentsTagIgnore),
    ...normalizeTags(schedule.ignoreContentsTags),
  ]);
  const counterPassIds = uniquePositiveInts([
    ...normalizeNumberValues(schedule.counterPassIds),
    ...normalizeNumberValues(schedule.counterPassId),
    ...normalizeNumberValues(schedule.counterPasses),
    ...normalizeNumberValues(schedule.eventPassIds),
    ...normalizeNumberValues(schedule.eventPassId),
    ...matchedSignals.counterPassIds,
  ]);

  if (!startDate || !endDate) {
    return null;
  }

  return {
    kind: "entry",
    id,
    label,
    openTags,
    intervalTags,
    contentsTagAllow,
    contentsTagIgnore,
    counterPassIds,
    startDate,
    endDate,
    repeatStartDate: null,
    repeatEndDate: null,
    repeatStartDay: 0,
    repeatEndDay: 0,
    startDateText: stringifyValue(schedule.startDate || schedule.start || schedule.from),
    endDateText: stringifyValue(schedule.endDate || schedule.end || schedule.to),
    repeatStartDateText: "",
    repeatEndDateText: "",
    resolvedIntervalTag: "",
    resolvedStartDate: startDate,
    resolvedEndDate: endDate,
    resolvedRepeatStartDate: null,
    resolvedRepeatEndDate: null,
    resolvedRepeatStartDay: 0,
    resolvedRepeatEndDay: 0,
    source: {
      category: "schedule",
      tableName: OFFICIAL_EVENT_SCHEDULE_TABLE_NAME,
      fileName: path.basename(OFFICIAL_EVENT_SCHEDULE_FILE),
      relativePath: path.join("modules", "event-manager", path.basename(OFFICIAL_EVENT_SCHEDULE_FILE)),
      index,
    },
    raw: {
      ...schedule,
      matchedEntryCount: matchedSignals.entryCount,
    },
  };
}

function collectOfficialScheduleMatchedSignals(registry, schedule) {
  const result = {
    openTags: [],
    intervalTags: [],
    contentsTagAllow: [],
    counterPassIds: [],
    entryCount: 0,
  };
  if (!registry || !Array.isArray(registry.entries)) return result;

  const tokens = normalizeTags(schedule.matchTokens)
    .map((token) => String(token || "").trim().toUpperCase())
    .filter(Boolean);
  if (!tokens.length) return result;

  const excludeTokens = normalizeTags(schedule.excludeTokens)
    .map((token) => String(token || "").trim().toUpperCase())
    .filter(Boolean);
  const matchMode = String(schedule.matchMode || "any").trim().toLowerCase();

  for (const entry of registry.entries) {
    const text = searchableEntryText(entry).toUpperCase();
    if (!text) continue;
    if (excludeTokens.some((token) => text.includes(token))) continue;
    const matched = matchMode === "all"
      ? tokens.every((token) => text.includes(token))
      : tokens.some((token) => text.includes(token));
    if (!matched) continue;

    result.entryCount += 1;
    result.openTags.push(...(entry.openTags || []));
    result.intervalTags.push(...(entry.intervalTags || []));
    result.contentsTagAllow.push(...(entry.contentsTagAllow || []));
    if (isCounterPassEntry(entry)) {
      const eventPassId = Number(entry.raw && entry.raw.EventPassID || entry.id || 0) || 0;
      if (eventPassId > 0) result.counterPassIds.push(eventPassId);
    }
  }

  result.openTags = uniqueStrings(result.openTags);
  result.intervalTags = uniqueStrings(result.intervalTags);
  result.contentsTagAllow = uniqueStrings(result.contentsTagAllow);
  result.counterPassIds = uniquePositiveInts(result.counterPassIds);
  return result;
}

function isDateProfileSelected(profile, requestedProfile) {
  const requested = String(requestedProfile || "auto").trim().toLowerCase();
  if (!requested || requested === "auto" || requested === "all" || requested === "*") return true;
  const candidates = [
    profile && profile.id,
    profile && profile.name,
    profile && profile.profile,
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  return candidates.includes(requested);
}

function selectRegistryEntriesForDate(registry, date) {
  const targetDate = parseEventDateInput(date);
  if (!targetDate || !registry || !Array.isArray(registry.entries)) return [];
  return registry.entries.filter((entry) => isEntryActiveAt(entry, targetDate));
}

function selectDateProfileEntries(date, config = {}) {
  if (!config.dateProfilesEnabled) return [];
  const targetDate = parseEventDateInput(date);
  if (!targetDate) return [];
  const requestedProfile = String(config.profile || "auto").trim().toLowerCase() || "auto";
  return loadDateProfiles()
    .map((profile, index) => normalizeDateProfileEntry(profile, index))
    .filter((entry) => entry && isDateProfileSelected(entry.raw, requestedProfile) && isEntryActiveAt(entry, targetDate));
}

function selectOfficialScheduleEntries(registry, date, config = {}) {
  if (!config.officialScheduleEnabled) return [];
  const targetDate = parseEventDateInput(date);
  if (!targetDate) return [];
  return loadOfficialEventSchedules()
    .map((schedule, index) => normalizeOfficialScheduleEntry(schedule, index, registry))
    .filter((entry) => entry && isEntryActiveAt(entry, targetDate));
}

function selectCounterPassEntriesForDate(registry, date, config = {}, profileSeeds = []) {
  const targetDate = parseEventDateInput(date);
  if (!config.counterPassEnabled || !targetDate || !registry || !Array.isArray(registry.entries)) return [];
  const passEntries = registry.entries.filter(isCounterPassEntry);
  if (!passEntries.length) return [];

  const forcedIds = uniquePositiveInts([
    Number(config.counterPassId || 0),
    ...profileSeeds.flatMap((entry) => (Array.isArray(entry.counterPassIds) ? entry.counterPassIds : [])),
  ]);
  if (forcedIds.length) {
    const selected = [];
    for (const passId of forcedIds) {
      const entry = findCounterPassEntryById(passEntries, passId);
      if (!entry) continue;
      selected.push(decorateCounterPassEntry(entry, counterPassWindowForForcedEntry(entry, targetDate, config, profileSeeds, passId)));
    }
    return selected;
  }

  const active = passEntries.filter((entry) => isEntryActiveAt(entry, targetDate));
  if (active.length) {
    return active.map((entry) => decorateCounterPassEntry(entry, resolveEntryWindow(entry, targetDate, config)));
  }

  const rollingMode = ["rolling", "legacy", "synthetic"].includes(String(config.counterPassMode || "").trim().toLowerCase());
  if (!rollingMode && !config.counterPassRollingEnabled) return [];
  const rolling = selectRollingCounterPassEntry(passEntries, targetDate, config);
  return rolling ? [rolling] : [];
}

function isCounterPassEntry(entry) {
  return Boolean(entry && entry.source && /EVENT_PASS_TEMPLET/i.test(String(entry.source.tableName || "")));
}

function findCounterPassEntryById(entries, passId) {
  const id = Number(passId || 0);
  if (!Number.isInteger(id) || id <= 0) return null;
  return (
    entries.find((entry) => Number(entry.raw && entry.raw.EventPassID) === id) ||
    entries.find((entry) => Number(entry.id || 0) === id) ||
    null
  );
}

function selectRollingCounterPassEntry(entries, targetDate, config = {}) {
  const anchor = config.counterPassAnchorDate instanceof Date ? config.counterPassAnchorDate : parseTableDate(COUNTER_PASS_DEFAULT_ANCHOR);
  if (!anchor || targetDate < anchor) return null;
  const cadenceDays = Math.max(1, Number(config.counterPassCadenceDays || 35) || 35);
  const durationDays = Math.max(1, Number(config.counterPassDurationDays || cadenceDays) || cadenceDays);
  const undated = entries
    .filter((entry) => !entry.startDate && !entry.endDate && !entry.resolvedStartDate && !entry.resolvedEndDate)
    .sort(compareCounterPassEntries);
  if (!undated.length) return null;

  const elapsedDays = Math.floor((targetDate.getTime() - anchor.getTime()) / DAY_MS);
  const index = Math.floor(elapsedDays / cadenceDays);
  if (index < 0 || index >= undated.length) return null;
  const startDate = new Date(anchor.getTime() + index * cadenceDays * DAY_MS);
  const endDate = new Date(startDate.getTime() + durationDays * DAY_MS);
  if (!isDateWithinWindow(targetDate, { startDate, endDate })) return null;
  return decorateCounterPassEntry(undated[index], { startDate, endDate });
}

function compareCounterPassEntries(left, right) {
  const leftId = Number(left && left.raw && left.raw.EventPassID) || Number(left && left.id) || 0;
  const rightId = Number(right && right.raw && right.raw.EventPassID) || Number(right && right.id) || 0;
  const leftIndex = left && left.source ? Number(left.source.index || 0) : 0;
  const rightIndex = right && right.source ? Number(right.source.index || 0) : 0;
  return leftIndex - rightIndex || leftId - rightId;
}

function counterPassWindowForForcedEntry(entry, targetDate, config = {}, profileSeeds = [], passId = 0) {
  for (const profile of profileSeeds) {
    if (!Array.isArray(profile.counterPassIds) || !profile.counterPassIds.includes(passId)) continue;
    if (profile.startDate && profile.endDate) return { startDate: profile.startDate, endDate: profile.endDate };
  }
  if (isEntryActiveAt(entry, targetDate)) return resolveEntryWindow(entry, targetDate, config);
  const startDate = startOfUtcDay(targetDate);
  const durationDays = Math.max(1, Number(config.counterPassDurationDays || config.defaultWindowDays || 35) || 35);
  return { startDate, endDate: new Date(startDate.getTime() + durationDays * DAY_MS) };
}

function decorateCounterPassEntry(entry, window) {
  if (!entry) return null;
  const startDate = window && window.startDate instanceof Date ? window.startDate : entry.resolvedStartDate || entry.startDate || null;
  const endDate = window && window.endDate instanceof Date ? window.endDate : entry.resolvedEndDate || entry.endDate || null;
  return {
    ...entry,
    openTags: uniqueStrings([...(entry.openTags || []), COUNTER_PASS_MISSION_OPEN_TAG]),
    contentsTagAllow: uniqueStrings([...(entry.contentsTagAllow || [])]),
    startDate: startDate || entry.startDate || null,
    endDate: endDate || entry.endDate || null,
    resolvedStartDate: startDate || entry.resolvedStartDate || null,
    resolvedEndDate: endDate || entry.resolvedEndDate || null,
    startDateText: entry.startDateText || dateIso(startDate),
    endDateText: entry.endDateText || dateIso(endDate),
    counterPassSynthetic: true,
  };
}

function summarizeCounterPass(entry, targetDate, config = {}) {
  if (!entry || !entry.raw) return null;
  const window = resolveEntryWindow(entry, targetDate, config) || {};
  const eventPassId = Number(entry.raw.EventPassID || entry.id || 0) || 0;
  if (!eventPassId) return null;
  return {
    eventPassId,
    title: stringifyValue(entry.raw.EventPassTitleStrID || entry.label),
    type: stringifyValue(entry.raw.EventPassType),
    mainRewardType: stringifyValue(entry.raw.EventPassMainRewardType),
    mainRewardId: Number(entry.raw.EventPassMainReward || 0) || 0,
    passRewardGroupId: Number(entry.raw.PassRewardGroupID || 0) || 0,
    dailyMissionGroupId: Number(entry.raw.DailyMissionGroupID || 0) || 0,
    weeklyMissionGroupId: Number(entry.raw.WeeklyMissionGroupID || 0) || 0,
    intervalTags: (entry.intervalTags || []).filter(isUsableTag),
    openTags: (entry.openTags || []).filter(isUsableTag),
    contentsTagAllow: (entry.contentsTagAllow || []).filter(isUsableTag),
    startDate: dateIso(window.startDate || entry.resolvedStartDate || entry.startDate),
    endDate: dateIso(window.endDate || entry.resolvedEndDate || entry.endDate),
    source: {
      tableName: entry.source && entry.source.tableName || "",
      relativePath: entry.source && entry.source.relativePath || "",
      index: entry.source && entry.source.index || 0,
    },
  };
}

function buildActiveEventState(registry, config = {}, date = config.eventDate) {
  const targetDate = parseEventDateInput(date);
  const empty = {
    enabled: Boolean(config.enabled),
    date: targetDate,
    seedEntries: [],
    entries: [],
    intervalData: [],
    requiredIntervalData: [],
    contentsTags: [],
    openTags: [],
    counterPasses: [],
    counterPassContentsTags: [],
    officialScheduleEntries: [],
  };
  if (!config.enabled || !targetDate || !registry || !Array.isArray(registry.entries)) return empty;

  const explicitSeeds = selectRegistryEntriesForDate(registry, targetDate);
  const officialScheduleSeeds = selectOfficialScheduleEntries(registry, targetDate, config);
  const profileSeeds = selectDateProfileEntries(targetDate, config);
  const intervalKeySeeds = selectIntervalKeySeedsForDate(registry, targetDate, config);
  const directInferredSeeds = config.inferYearOnly
    ? selectRegistryEntriesByDateToken(registry, targetDate, {
        allowYearOnly: true,
        allowSeasonal: Boolean(config.inferSeasonalIntervals),
        defaultWindowDays: config.defaultWindowDays,
      })
    : [];
  const counterPassSeeds = selectCounterPassEntriesForDate(registry, targetDate, config, [
    ...officialScheduleSeeds,
    ...profileSeeds,
  ]);
  const expandableSeeds = uniqueEntries([
    ...counterPassSeeds,
    ...explicitSeeds,
    ...profileSeeds,
    ...intervalKeySeeds,
    ...directInferredSeeds,
  ]);
  const seedEntries = uniqueEntries([
    ...officialScheduleSeeds,
    ...expandableSeeds,
  ]);
  const relatedSeeds = uniqueEntries([
    ...officialScheduleSeeds,
    ...expandableSeeds,
  ]);
  const entries = uniqueEntries([
    ...officialScheduleSeeds,
    ...expandableSeeds,
    ...expandRelatedEntries(registry, relatedSeeds, { inheritWindows: true }),
  ]).filter((entry) =>
    isEntryCompatibleWithTargetDate(entry, targetDate, config)
  );
  const counterPassEntries = entries.filter(isCounterPassEntry);
  const requiredIntervalData = ensureUniqueIntervalKeys(buildRequiredIntervalData(registry));
  const activeIntervalData = ensureUniqueIntervalKeys(buildActiveIntervalData(entries, targetDate, config));
  const intervalData = ensureUniqueIntervalKeys(
    config.emitRequiredIntervals ? mergeIntervalData(requiredIntervalData, activeIntervalData) : activeIntervalData
  );

  return {
    enabled: true,
    date: targetDate,
    seedEntries,
    entries,
    officialScheduleEntries: officialScheduleSeeds,
    intervalData,
    requiredIntervalData,
    contentsTags: collectActiveContentsTags(entries, targetDate, config),
    openTags: collectUsableTags(entries, "openTags"),
    counterPasses: counterPassEntries.map((entry) => summarizeCounterPass(entry, targetDate, config)).filter(Boolean),
    counterPassContentsTags: collectActiveContentsTags(counterPassEntries, targetDate, config),
  };
}

function buildEventDiagnostics(registry, config = {}, date = config.eventDate, options = {}) {
  const targetDate = parseEventDateInput(date);
  const activeState = buildActiveEventState(registry, config, targetDate);
  const limit = readPositiveInt(options.limit, 20);
  const missingTables = Array.isArray(registry.missingTables) ? registry.missingTables : [];
  const errors = Array.isArray(registry.errors) ? registry.errors : [];
  const warnings = [];

  if (!config.enabled) warnings.push("event manager is disabled; set CS_EVENT_MANAGER=auto or CS_EVENT_MANAGER=1");
  if (!targetDate) warnings.push("no valid server clock date is available");
  if (missingTables.length) warnings.push(`${missingTables.length} required event table(s) are missing`);
  if (errors.length) warnings.push(`${errors.length} table parse/read error(s) were reported`);
  if (config.enabled && targetDate && !activeState.entries.length) warnings.push("no active or inferred event entries matched the selected date");
  if (config.enabled && targetDate && activeState.entries.length && !activeState.intervalData.length) {
    warnings.push("matched entries did not produce JOIN_LOBBY_ACK intervalData rows");
  }
  if (config.enabled && targetDate && activeState.entries.length && !activeState.openTags.length && !activeState.contentsTags.length) {
    warnings.push("matched entries did not produce login open/content tags");
  }

  return {
    status: warnings.length ? "warning" : "ok",
    generatedAt: new Date().toISOString(),
    config: {
      enabled: Boolean(config.enabled),
      mode: config.mode || "",
      dateInput: config.dateInput || "",
      dateIso: targetDate ? targetDate.toISOString() : "",
      timezone: config.timezone || "",
      profile: config.profile || "",
      tableScan: config.tableScan || "",
      defaultWindowDays: Number(config.defaultWindowDays || 0) || 0,
      officialScheduleEnabled: Boolean(config.officialScheduleEnabled),
      dateProfilesEnabled: Boolean(config.dateProfilesEnabled),
      inferSeasonalIntervals: Boolean(config.inferSeasonalIntervals),
      emitRequiredIntervals: Boolean(config.emitRequiredIntervals),
      counterPassEnabled: Boolean(config.counterPassEnabled),
      counterPassMode: config.counterPassMode || "",
      counterPassId: Number(config.counterPassId || 0) || 0,
      counterPassAnchorDate: dateIso(config.counterPassAnchorDate),
      counterPassDurationDays: Number(config.counterPassDurationDays || 0) || 0,
      counterPassCadenceDays: Number(config.counterPassCadenceDays || 0) || 0,
      counterPassRollingEnabled: Boolean(config.counterPassRollingEnabled),
      tableRoots: (config.tableRoots || []).map((root) => ({
        path: root,
        exists: fs.existsSync(root),
      })),
    },
    tables: {
      count: registry.tables.length,
      missingCount: missingTables.length,
      errorCount: errors.length,
      missing: missingTables.slice(0, limit),
      errors: errors.slice(0, limit),
      byCategory: countBy(registry.tables, (tableInfo) => tableInfo.category || "table"),
    },
    registry: {
      entryCount: registry.entries.length,
      intervalTemplateCount: registry.intervals.length,
      requiredIntervalReferenceCount: registry.requiredIntervalRefs.length,
      entriesByCategory: countBy(registry.entries, (entry) => entry.source && entry.source.category || "table"),
    },
    active: {
      seedEntryCount: activeState.seedEntries.length,
      entryCount: activeState.entries.length,
      intervalCount: activeState.intervalData.length,
      requiredIntervalCount: activeState.requiredIntervalData.length,
      contentsTagCount: activeState.contentsTags.length,
      openTagCount: activeState.openTags.length,
      counterPassCount: activeState.counterPasses.length,
      counterPassContentsTagCount: activeState.counterPassContentsTags.length,
      officialScheduleCount: activeState.officialScheduleEntries.length,
      contentsTags: activeState.contentsTags.slice(0, limit),
      openTags: activeState.openTags.slice(0, limit),
      counterPassContentsTags: activeState.counterPassContentsTags.slice(0, limit),
      counterPasses: activeState.counterPasses.slice(0, limit),
      intervals: activeState.intervalData.slice(0, limit).map(summarizeIntervalData),
      seedEntries: activeState.seedEntries.slice(0, limit).map(summarizeEntry),
      entriesByCategory: countBy(activeState.entries, (entry) => entry.source && entry.source.category || "table"),
    },
    checks: {
      serverClockDateProvided: Boolean(config.enabled && targetDate),
      loginTagsEmitted: activeState.contentsTags.length > 0 || activeState.openTags.length > 0,
      lobbyIntervalsEmitted: activeState.intervalData.length > 0,
      packagedRootsAvailable: (config.tableRoots || []).some((root) => /gameplay-jsons/i.test(root) && fs.existsSync(root)),
    },
    warnings,
  };
}

function formatEventDiagnostics(diagnostics) {
  const lines = [];
  const diag = diagnostics || {};
  const config = diag.config || {};
  const tables = diag.tables || {};
  const registry = diag.registry || {};
  const active = diag.active || {};
  const checks = diag.checks || {};

  lines.push(`Event manager diagnostics: ${diag.status || "unknown"}`);
  lines.push(`clockDate=${config.dateIso || config.dateInput || "(unset)"} enabled=${config.enabled ? "yes" : "no"} mode=${config.mode || "(unset)"} scan=${config.tableScan || "(unset)"}`);
  lines.push(`tables=${tables.count || 0} missing=${tables.missingCount || 0} errors=${tables.errorCount || 0} entries=${registry.entryCount || 0} intervalTemplates=${registry.intervalTemplateCount || 0} intervalRefs=${registry.requiredIntervalReferenceCount || 0}`);
  lines.push(`active seeds=${active.seedEntryCount || 0} entries=${active.entryCount || 0} intervals=${active.intervalCount || 0} requiredIntervals=${active.requiredIntervalCount || 0} officialSchedules=${active.officialScheduleCount || 0} counterPasses=${active.counterPassCount || 0} contentsTags=${active.contentsTagCount || 0} openTags=${active.openTagCount || 0}`);
  lines.push(`checks serverClockDate=${checks.serverClockDateProvided ? "yes" : "no"} loginTags=${checks.loginTagsEmitted ? "yes" : "no"} lobbyIntervals=${checks.lobbyIntervalsEmitted ? "yes" : "no"} packagedRoots=${checks.packagedRootsAvailable ? "yes" : "no"}`);

  if (Array.isArray(diag.warnings) && diag.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of diag.warnings) lines.push(`- ${warning}`);
  }

  if (Array.isArray(active.intervals) && active.intervals.length) {
    lines.push("");
    lines.push("JOIN_LOBBY intervalData rows:");
    for (const interval of active.intervals) {
      lines.push(`- ${interval.strKey} ${interval.startDate || "(no start)"} -> ${interval.endDate || "(no end)"} source=${interval.sourceTable || "(unknown)"}`);
    }
  }

  if (Array.isArray(active.openTags) && active.openTags.length) {
    lines.push("");
    lines.push(`Open tags: ${active.openTags.join(", ")}`);
  }

  if (Array.isArray(active.contentsTags) && active.contentsTags.length) {
    lines.push("");
    lines.push(`Contents tags: ${active.contentsTags.join(", ")}`);
  }

  if (Array.isArray(active.counterPasses) && active.counterPasses.length) {
    lines.push("");
    lines.push("Counter passes:");
    for (const pass of active.counterPasses) {
      lines.push(
        `- id=${pass.eventPassId} reward=${pass.mainRewardId || "(none)"} ${pass.startDate || "(no start)"} -> ${
          pass.endDate || "(no end)"
        } intervals=${pass.intervalTags.join(",") || "(none)"} open=${pass.openTags.join(",") || "(none)"}`
      );
    }
  }

  if (Array.isArray(active.seedEntries) && active.seedEntries.length) {
    lines.push("");
    lines.push("Seed entries:");
    for (const entry of active.seedEntries) {
      lines.push(`- ${entry.source.tableName} id=${entry.id || "(none)"} intervals=${entry.intervalTags.join(",") || "(none)"} open=${entry.openTags.join(",") || "(none)"}`);
    }
  }

  if (Array.isArray(tables.missing) && tables.missing.length) {
    lines.push("");
    lines.push("Missing tables:");
    for (const tableInfo of tables.missing) lines.push(`- ${tableInfo.relativePath || tableInfo.fileName}`);
  }

  if (Array.isArray(tables.errors) && tables.errors.length) {
    lines.push("");
    lines.push("Table errors:");
    for (const error of tables.errors) lines.push(`- ${error}`);
  }

  return `${lines.join("\n")}\n`;
}

function table(category, directory, fileName, options = {}) {
  return Object.freeze({
    category,
    directory,
    fileName,
    optional: Boolean(options.optional),
  });
}

function attachTableDefinition(rawTable, definition, tableRoot) {
  const relativePath = rawTable.filePath ? path.relative(tableRoot, rawTable.filePath) : path.join(definition.directory, "luac", definition.fileName);
  return {
    ...rawTable,
    category: definition.category || rawTable.category || categoryForTableName(rawTable.tableName),
    tableName: rawTable.rootName || rawTable.tableName || tableNameForFile(definition.fileName),
    fileName: definition.fileName || rawTable.fileName,
    directory: definition.directory,
    tableRoot,
    relativePath,
  };
}

function summarizeTable(tableInfo) {
  return {
    category: tableInfo.category || categoryForTableName(tableInfo.tableName),
    tableName: tableInfo.tableName || tableNameForFile(tableInfo.fileName || ""),
    fileName: tableInfo.fileName || "",
    relativePath: tableInfo.relativePath || "",
    filePath: tableInfo.filePath || "",
    recordCount: Array.isArray(tableInfo.records) ? tableInfo.records.length : 0,
    missing: Boolean(tableInfo.missing),
    errorCount: Array.isArray(tableInfo.errors) ? tableInfo.errors.length : 0,
  };
}

function normalizeRegistryEntry(record, sourceTable, index) {
  const source = makeRecordSource(sourceTable, index);
  const tableName = source.tableName;
  const id = stringifyValue(firstFieldValue(record, ID_FIELDS));
  const label = stringifyValue(firstFieldValue(record, LABEL_FIELDS));
  const openTags = tagsFromFields(record, OPEN_TAG_FIELDS);
  const intervalTags = tagsFromFields(record, INTERVAL_TAG_FIELDS);
  const contentsTagAllow = tagsFromFields(record, CONTENTS_ALLOW_FIELDS);
  const contentsTagIgnore = tagsFromFields(record, CONTENTS_IGNORE_FIELDS);
  const startDateText = stringifyValue(firstFieldValue(record, START_DATE_FIELDS));
  const endDateText = stringifyValue(firstFieldValue(record, END_DATE_FIELDS));
  const repeatStartDateText = stringifyValue(firstFieldValue(record, REPEAT_START_DATE_FIELDS));
  const repeatEndDateText = stringifyValue(firstFieldValue(record, REPEAT_END_DATE_FIELDS));
  const startDate = parseTableDate(startDateText);
  const endDate = parseTableDate(endDateText);
  const repeatStartDate = parseTableDate(repeatStartDateText);
  const repeatEndDate = parseTableDate(repeatEndDateText);
  const repeatStartDay = parseRepeatDay(repeatStartDateText);
  const repeatEndDay = parseRepeatDay(repeatEndDateText);
  const hasEventSignal =
    openTags.length ||
    intervalTags.length ||
    contentsTagAllow.length ||
    contentsTagIgnore.length ||
    startDateText ||
    endDateText ||
    repeatStartDateText ||
    repeatEndDateText ||
    source.category !== "table";
  if (!hasEventSignal) return null;

  if (source.category === "interval" || /INTERVAL/i.test(tableName)) {
    const strKey = intervalTags[0] || stringifyValue(record.m_DateStrID || record.DateStrID || record.__key);
    return {
      kind: "interval",
      id,
      label,
      strKey,
      openTags,
      intervalTags,
      contentsTagAllow,
      contentsTagIgnore,
      startDate,
      endDate,
      repeatStartDate,
      repeatEndDate,
      repeatStartDay,
      repeatEndDay,
      startDateText,
      endDateText,
      repeatStartDateText,
      repeatEndDateText,
      source,
      raw: record,
    };
  }

  return {
    kind: "entry",
    id,
    label,
    openTags,
    intervalTags,
    contentsTagAllow,
    contentsTagIgnore,
    startDate,
    endDate,
    repeatStartDate,
    repeatEndDate,
    repeatStartDay,
    repeatEndDay,
    startDateText,
    endDateText,
    repeatStartDateText,
    repeatEndDateText,
    resolvedIntervalTag: "",
    resolvedStartDate: startDate,
    resolvedEndDate: endDate,
    resolvedRepeatStartDate: repeatStartDate,
    resolvedRepeatEndDate: repeatEndDate,
    resolvedRepeatStartDay: repeatStartDay,
    resolvedRepeatEndDay: repeatEndDay,
    source,
    raw: record,
  };
}

function makeRecordSource(sourceTable, index) {
  const tableName = sourceTable.tableName || tableNameForFile(sourceTable.fileName || "");
  return {
    category: sourceTable.category || categoryForTableName(tableName),
    tableName,
    fileName: sourceTable.fileName || "",
    relativePath: sourceTable.relativePath || "",
    index,
  };
}

function hydrateEntriesWithIntervals(registry) {
  for (const entry of registry.entries) {
    for (const tag of entry.intervalTags) {
      const interval = registry.intervalsByStrKey.get(tag);
      if (!interval) continue;
      entry.resolvedIntervalTag = interval.strKey || tag;
      entry.resolvedStartDate = interval.startDate || entry.resolvedStartDate || null;
      entry.resolvedEndDate = interval.endDate || entry.resolvedEndDate || null;
      entry.resolvedRepeatStartDate = interval.repeatStartDate || entry.resolvedRepeatStartDate || null;
      entry.resolvedRepeatEndDate = interval.repeatEndDate || entry.resolvedRepeatEndDate || null;
      entry.resolvedRepeatStartDay = interval.repeatStartDay || entry.resolvedRepeatStartDay || 0;
      entry.resolvedRepeatEndDay = interval.repeatEndDay || entry.resolvedRepeatEndDay || 0;
      break;
    }
  }
}

function indexEntries(registry) {
  for (const entry of registry.entries) {
    for (const tag of entry.openTags) addToMapList(registry.entriesByOpenTag, tag, entry);
    for (const tag of entry.intervalTags) addToMapList(registry.entriesByIntervalTag, tag, entry);
    for (const tag of entry.contentsTagAllow) addToMapList(registry.entriesByContentsTag, tag, entry);
  }
}

function isEntryActiveAt(entry, date) {
  if (!entry || !(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const startDate = entry.resolvedStartDate || entry.startDate || null;
  const endDate = entry.resolvedEndDate || entry.endDate || null;
  if (startDate || endDate) {
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  }
  const repeatStartDate = entry.resolvedRepeatStartDate || entry.repeatStartDate || null;
  const repeatEndDate = entry.resolvedRepeatEndDate || entry.repeatEndDate || null;
  if (repeatStartDate || repeatEndDate) {
    return isRepeatDateActive(date, repeatStartDate, repeatEndDate);
  }
  if (entry.resolvedRepeatStartDay || entry.resolvedRepeatEndDay || entry.repeatStartDay || entry.repeatEndDay) {
    return isRepeatDayActive(
      date,
      entry.resolvedRepeatStartDay || entry.repeatStartDay || 0,
      entry.resolvedRepeatEndDay || entry.repeatEndDay || 0
    );
  }
  return false;
}

function selectRegistryEntriesByDateToken(registry, date, options = {}) {
  const targetDate = parseEventDateInput(date);
  if (!targetDate || !registry || !Array.isArray(registry.entries)) return [];
  const candidates = [];

  for (const entry of registry.entries) {
    if (!entryHasClientSignals(entry)) continue;
    if (isEntryActiveAt(entry, targetDate)) continue;
    const text = searchableEntryText(entry);
    if (!hasDateSpecificTokenForTarget(text, targetDate, {
      allowYearOnly: options.allowYearOnly,
      allowSeasonal: options.allowSeasonal,
    })) continue;
    const inferredWindow = inferWindowFromEntryTokens(entry, targetDate, options);
    if (hasSeasonalDateToken(text) && !isDateWithinWindow(targetDate, inferredWindow)) continue;
    candidates.push(entry);
  }

  return candidates;
}

function selectIntervalKeySeedsForDate(registry, date, config = {}) {
  const targetDate = parseEventDateInput(date);
  if (!targetDate || !registry) return [];
  const seeds = [];

  for (const interval of Array.isArray(registry.intervals) ? registry.intervals : []) {
    if (isEntryActiveAt(interval, targetDate)) seeds.push(interval);
  }

  const inferredByStrKey = new Map();
  for (const [strKey, text] of collectReferencedIntervalKeyText(registry)) {
    if (inferredByStrKey.has(strKey)) continue;
    const intervalText = String(strKey || "").toUpperCase();
    if (!hasDateSpecificTokenForTarget(intervalText, targetDate, {
      allowYearOnly: Boolean(config.inferYearOnly),
      allowSeasonal: Boolean(config.inferSeasonalIntervals),
    })) continue;
    const window = inferWindowFromText(intervalText, targetDate, config);
    if (!isDateWithinWindow(targetDate, window)) continue;
    inferredByStrKey.set(strKey, makeInferredIntervalEntry(strKey, text, window, inferredByStrKey.size));
  }

  return uniqueEntries([...seeds, ...inferredByStrKey.values()]);
}

function collectReferencedIntervalKeyText(registry) {
  const byStrKey = new Map();
  const addText = (strKey, text) => {
    const key = stringifyValue(strKey);
    if (!isRequiredIntervalKey(key)) return;
    const existing = byStrKey.get(key);
    byStrKey.set(key, existing ? `${existing} ${text}` : `${key} ${text}`);
  };

  for (const reference of Array.isArray(registry.requiredIntervalRefs) ? registry.requiredIntervalRefs : []) {
    addText(reference && reference.strKey, reference && reference.source ? reference.source.tableName : "");
  }

  for (const entry of Array.isArray(registry.entries) ? registry.entries : []) {
    const text = searchableEntryText(entry);
    for (const strKey of entry.intervalTags || []) addText(strKey, text);
  }

  return byStrKey;
}

function makeInferredIntervalEntry(strKey, text, window, index) {
  const startDate = window && window.startDate instanceof Date ? window.startDate : null;
  const endDate = window && window.endDate instanceof Date ? window.endDate : null;
  return {
    kind: "interval",
    id: `inferred:${strKey}`,
    label: strKey,
    strKey,
    openTags: [],
    intervalTags: [strKey],
    contentsTagAllow: [],
    contentsTagIgnore: [],
    startDate,
    endDate,
    repeatStartDate: null,
    repeatEndDate: null,
    repeatStartDay: 0,
    repeatEndDay: 0,
    startDateText: dateIso(startDate),
    endDateText: dateIso(endDate),
    repeatStartDateText: "",
    repeatEndDateText: "",
    resolvedIntervalTag: strKey,
    resolvedStartDate: startDate,
    resolvedEndDate: endDate,
    resolvedRepeatStartDate: null,
    resolvedRepeatEndDate: null,
    resolvedRepeatStartDay: 0,
    resolvedRepeatEndDay: 0,
    source: {
      category: "interval",
      tableName: "INFERRED_INTERVAL",
      fileName: "",
      relativePath: `__inferred_interval__/${strKey}`,
      index,
    },
    raw: { strKey, inferredFromText: text },
  };
}

function hasDateSpecificTokenForTarget(text, targetDate, options = {}) {
  const normalized = String(text || "").toUpperCase();
  if (!normalized || !(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) return false;
  const year = String(targetDate.getUTCFullYear());
  if (!normalized.includes(year)) return false;

  const month = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
  const shortMonth = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ][targetDate.getUTCMonth()];
  const longMonth = [
    "JANUARY",
    "FEBRUARY",
    "MARCH",
    "APRIL",
    "MAY",
    "JUNE",
    "JULY",
    "AUGUST",
    "SEPTEMBER",
    "OCTOBER",
    "NOVEMBER",
    "DECEMBER",
  ][targetDate.getUTCMonth()];
  const hasMonth =
    normalized.includes(`${year}_${month}`) ||
    normalized.includes(`${year}${month}`) ||
    normalized.includes(`${year}_${shortMonth}`) ||
    normalized.includes(`${year}_${longMonth}`);
  const hasSeason =
    options.allowSeasonal === true &&
    seasonalTokensForMonth(targetDate.getUTCMonth() + 1).some((token) => normalized.includes(token));
  const yearOnly =
    options.allowYearOnly === true && /\b(COMMON|ANN|ANNIVERSARY|PROJECT|EVENT)\b/.test(normalized.replace(/_/g, " "));
  return hasMonth || hasSeason || yearOnly;
}

function expandRelatedEntries(registry, seedEntries, options = {}) {
  const related = [];
  if (!seedEntries.length) return related;
  const selected = uniqueEntries(seedEntries).slice();
  const selectedKeys = new Set(selected.map(eventEntryUniqueKey));

  for (let pass = 0; pass < 4; pass += 1) {
    const owners = collectRelatedOwners(selected);
    const next = [];
    for (const entry of registry.entries) {
      const key = eventEntryUniqueKey(entry);
      if (selectedKeys.has(key)) continue;
      const inheritedWindowSource = [
        findRelatedTagOwner(owners.openTags, entry.openTags),
        findRelatedTagOwner(owners.intervalTags, entry.intervalTags),
        findRelatedTagOwner(owners.contentsTags, entry.contentsTagAllow),
        findRelatedTabOwner(owners.shopTabs, entry),
      ].find((owner) => owner && canExpandRelatedEntry(owner, entry));
      if (!inheritedWindowSource) continue;
      const resolved = options.inheritWindows ? inheritEntryWindow(entry, inheritedWindowSource) : entry;
      selectedKeys.add(key);
      selected.push(resolved);
      related.push(resolved);
      next.push(resolved);
    }
    if (!next.length) break;
  }
  return related;
}

function collectRelatedOwners(entries) {
  const owners = {
    openTags: new Map(),
    intervalTags: new Map(),
    contentsTags: new Map(),
    shopTabs: new Map(),
  };
  for (const entry of entries) {
    for (const tag of entry.openTags || []) addRelatedTagOwner(owners.openTags, tag, entry);
    for (const tag of entry.intervalTags || []) addRelatedTagOwner(owners.intervalTags, tag, entry);
    for (const tag of entry.contentsTagAllow || []) addRelatedTagOwner(owners.contentsTags, tag, entry);
    addRelatedShopTabOwner(owners.shopTabs, entry);
  }
  return owners;
}

function addRelatedTagOwner(map, tag, entry) {
  if (!isUsableTag(tag)) return;
  const key = String(tag || "").toUpperCase();
  if (!map.has(key)) map.set(key, entry);
}

function findRelatedTagOwner(map, tags) {
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!isUsableTag(tag)) continue;
    const owner = map.get(String(tag || "").toUpperCase());
    if (owner) return owner;
  }
  return null;
}

function addRelatedShopTabOwner(map, entry) {
  const key = shopEntryTabKey(entry);
  if (!key || map.has(key)) return;
  map.set(key, entry);
}

function findRelatedTabOwner(map, entry) {
  const key = shopEntryTabKey(entry);
  return key ? map.get(key) || null : null;
}

function canExpandRelatedEntry(sourceEntry, targetEntry) {
  const sourceCategory = relationCategory(sourceEntry);
  const targetCategory = relationCategory(targetEntry);
  if (targetCategory === "shop") return sourceCategory === "shop";
  if (targetCategory === "contract") return sourceCategory === "contract";
  if (sourceCategory === "shop" || sourceCategory === "contract") return false;
  return true;
}

function relationCategory(entry) {
  const source = entry && entry.source ? entry.source : {};
  const tableName = String(source.tableName || "").toUpperCase();
  if (/SHOP/.test(tableName)) return "shop";
  if (/CONTRACT/.test(tableName)) return "contract";
  if (tableName === OFFICIAL_EVENT_SCHEDULE_TABLE_NAME) {
    const raw = entry && entry.raw && typeof entry.raw === "object" ? entry.raw : {};
    const scheduleType = String(raw.scheduleType || raw.type || "").toUpperCase();
    const signals = [
      scheduleType,
      ...(entry.openTags || []),
      ...(entry.intervalTags || []),
      ...(entry.contentsTagAllow || []),
    ].join("|");
    if (/SHOP/.test(signals)) return "shop";
    if (/CONTRACT|PICKUP|CLASSIFIED|FIRST_UNIT|FIRST_OPR/.test(signals)) return "contract";
  }
  return source.category || "";
}

function shopEntryTabKey(entry) {
  if (!isShopRegistryEntry(entry)) return "";
  const raw = entry && entry.raw && typeof entry.raw === "object" ? entry.raw : {};
  const tabId = stringifyValue(raw.m_TabID || raw.ShopTabID || raw.shopTabId).trim().toUpperCase();
  if (!tabId) return "";
  const subIndex = Number(raw.m_TabSubIndex || raw.ShopTabSubIndex || raw.shopTabSubIndex || 0) || 0;
  return `${tabId}:${subIndex}`;
}

function isShopRegistryEntry(entry) {
  const source = entry && entry.source ? entry.source : {};
  return source.category === "shop" || /SHOP/i.test(source.tableName || "");
}

function eventEntryUniqueKey(entry) {
  return `${entry && entry.source ? entry.source.relativePath : ""}:${entry && entry.source ? entry.source.index : ""}:${entry ? entry.id : ""}`;
}

function inheritEntryWindow(entry, sourceEntry) {
  if (!entry || !sourceEntry) return entry;
  const sourceWindow = {
    startDate: sourceEntry.resolvedStartDate || sourceEntry.startDate || null,
    endDate: sourceEntry.resolvedEndDate || sourceEntry.endDate || null,
  };
  if (!sourceWindow.startDate && !sourceWindow.endDate) return entry;
  return {
    ...entry,
    resolvedStartDate: entry.resolvedStartDate || entry.startDate || sourceWindow.startDate || null,
    resolvedEndDate: entry.resolvedEndDate || entry.endDate || sourceWindow.endDate || null,
    inheritedWindowSource: sourceEntry.source
      ? {
          tableName: sourceEntry.source.tableName || "",
          relativePath: sourceEntry.source.relativePath || "",
          index: sourceEntry.source.index || 0,
        }
      : null,
  };
}

function buildRequiredIntervalData(registry) {
  const byStrKey = new Map();
  if (!registry || !Array.isArray(registry.entries)) return [];

  for (const interval of registry.intervals || []) {
    const strKey = stringifyValue(interval.strKey);
    if (!isRequiredIntervalKey(strKey)) continue;
    byStrKey.set(strKey, buildIntervalDataFromEntry(interval, strKey, interval.source ? interval.source.tableName : ""));
  }

  for (const entry of registry.entries) {
    for (const strKey of entry.intervalTags || []) {
      if (!isRequiredIntervalKey(strKey) || byStrKey.has(strKey)) continue;
      const interval = registry.intervalsByStrKey && registry.intervalsByStrKey.get(strKey);
      byStrKey.set(
        strKey,
        buildIntervalDataFromEntry(interval || entry, strKey, interval && interval.source ? interval.source.tableName : entry.source ? entry.source.tableName : "")
      );
    }
  }

  for (const reference of registry.requiredIntervalRefs || []) {
    const strKey = stringifyValue(reference && reference.strKey);
    if (!isRequiredIntervalKey(strKey) || byStrKey.has(strKey)) continue;
    const interval = registry.intervalsByStrKey && registry.intervalsByStrKey.get(strKey);
    byStrKey.set(
      strKey,
      buildIntervalDataFromEntry(
        interval || reference,
        strKey,
        interval && interval.source ? interval.source.tableName : reference && reference.source ? reference.source.tableName : ""
      )
    );
  }

  return Array.from(byStrKey.values()).sort((left, right) => left.strKey.localeCompare(right.strKey));
}

function buildIntervalDataFromEntry(entry, strKey, sourceTable = "") {
  const useEntryWindow = isUsableTag(strKey);
  const startDate = useEntryWindow && entry && entry.startDate instanceof Date && !Number.isNaN(entry.startDate.getTime())
    ? entry.startDate
    : FALLBACK_INTERVAL_START;
  const endDate = useEntryWindow && entry && entry.endDate instanceof Date && !Number.isNaN(entry.endDate.getTime())
    ? entry.endDate
    : FALLBACK_INTERVAL_END;
  return {
    key: stablePositiveInt(strKey),
    strKey,
    startDate,
    endDate,
    repeatStartDate: useEntryWindow ? Number((entry && (entry.resolvedRepeatStartDay || entry.repeatStartDay)) || 0) || 0 : 0,
    repeatEndDate: useEntryWindow ? Number((entry && (entry.resolvedRepeatEndDay || entry.repeatEndDay)) || 0) || 0 : 0,
    sourceTable,
  };
}

function mergeIntervalData(baseIntervals, overrideIntervals) {
  const byStrKey = new Map();
  for (const interval of Array.isArray(baseIntervals) ? baseIntervals : []) {
    if (!interval || !isRequiredIntervalKey(interval.strKey)) continue;
    byStrKey.set(interval.strKey, interval);
  }
  for (const interval of Array.isArray(overrideIntervals) ? overrideIntervals : []) {
    if (!interval || !isRequiredIntervalKey(interval.strKey)) continue;
    byStrKey.set(interval.strKey, interval);
  }
  return Array.from(byStrKey.values()).sort((left, right) => left.strKey.localeCompare(right.strKey));
}

function buildActiveIntervalData(entries, targetDate, config = {}) {
  const byStrKey = new Map();
  for (const entry of entries) {
    const intervalTags = (entry.intervalTags || []).filter(isUsableTag);
    if (!intervalTags.length) continue;
    const window = resolveEntryWindow(entry, targetDate, config);
    if (!window || !window.startDate || !window.endDate) continue;
    for (const strKey of intervalTags) {
      if (!strKey || byStrKey.has(strKey)) continue;
      byStrKey.set(strKey, {
        key: stablePositiveInt(strKey),
        strKey,
        startDate: window.startDate,
        endDate: window.endDate,
        repeatStartDate: Number(entry.resolvedRepeatStartDay || entry.repeatStartDay || 0) || 0,
        repeatEndDate: Number(entry.resolvedRepeatEndDay || entry.repeatEndDay || 0) || 0,
        sourceTable: entry.source ? entry.source.tableName : "",
      });
    }
  }
  return Array.from(byStrKey.values()).sort((left, right) => left.strKey.localeCompare(right.strKey));
}

function resolveEntryWindow(entry, targetDate, config = {}) {
  if (entry.resolvedStartDate || entry.resolvedEndDate) {
    return {
      startDate: entry.resolvedStartDate || startOfUtcDay(targetDate),
      endDate: entry.resolvedEndDate || endOfUtcDay(targetDate),
    };
  }
  if (entry.startDate || entry.endDate) {
    return {
      startDate: entry.startDate || startOfUtcDay(targetDate),
      endDate: entry.endDate || endOfUtcDay(targetDate),
    };
  }
  return inferWindowFromEntryTokens(entry, targetDate, config);
}

function isEntryCompatibleWithTargetDate(entry, targetDate, config = {}) {
  if (!entry || !(targetDate instanceof Date) || Number.isNaN(targetDate.getTime())) return false;
  if (isEntryActiveAt(entry, targetDate)) return true;
  if (
    entry.resolvedStartDate || entry.startDate || entry.resolvedEndDate || entry.endDate ||
    entry.resolvedRepeatStartDate || entry.repeatStartDate || entry.resolvedRepeatEndDate || entry.repeatEndDate ||
    entry.resolvedRepeatStartDay || entry.repeatStartDay || entry.resolvedRepeatEndDay || entry.repeatEndDay
  ) return false;
  const text = searchableEntryText(entry);
  if (!hasSeasonalDateToken(text)) return true;
  return isDateWithinWindow(targetDate, inferWindowFromEntryTokens(entry, targetDate, config));
}

function collectActiveContentsTags(entries, targetDate, config = {}) {
  return uniqueStrings(
    entries
      .filter((entry) => shouldEmitContentsTagsForEntry(entry, targetDate, config))
      .flatMap((entry) => (Array.isArray(entry.contentsTagAllow) ? entry.contentsTagAllow : []))
      .filter(isUsableTag)
  );
}

function shouldEmitContentsTagsForEntry(entry, targetDate, config = {}) {
  if (!entry || !Array.isArray(entry.contentsTagAllow) || entry.contentsTagAllow.length <= 0) return false;
  if (isEntryActiveAt(entry, targetDate)) return true;

  const hasIntervalTags = Array.isArray(entry.intervalTags) && entry.intervalTags.some(isUsableTag);
  if (!hasIntervalTags) return false;

  const text = searchableEntryText(entry);
  if (!hasDateSpecificTokenForTarget(text, targetDate, {
    allowYearOnly: false,
    allowSeasonal: Boolean(config.inferSeasonalIntervals),
  })) return false;
  return isDateWithinWindow(targetDate, inferWindowFromEntryTokens(entry, targetDate, config));
}

function isDateWithinWindow(date, window) {
  if (!window || !(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const start = window.startDate instanceof Date && !Number.isNaN(window.startDate.getTime()) ? window.startDate : null;
  const end = window.endDate instanceof Date && !Number.isNaN(window.endDate.getTime()) ? window.endDate : null;
  if (start && date < start) return false;
  if (end && date >= end) return false;
  return true;
}

function inferWindowFromEntryTokens(entry, targetDate, config = {}) {
  return inferWindowFromText(searchableEntryText(entry), targetDate, config);
}

function inferWindowFromText(text, targetDate, config = {}) {
  const normalized = String(text || "").toUpperCase();
  const year = targetDate.getUTCFullYear();
  const defaultWindowDays = Math.max(1, Number(config.defaultWindowDays || 28) || 28);
  const month = targetDate.getUTCMonth() + 1;
  const monthStart = (monthValue) => new Date(Date.UTC(year, monthValue - 1, 1, 0, 0, 0, 0));
  const monthEnd = (monthValue) => new Date(Date.UTC(year, monthValue, 1, 0, 0, 0, 0));

  if (normalized.includes("NEWYEAR")) return { startDate: monthStart(1), endDate: monthEnd(2) };
  if (normalized.includes("VALEN")) return { startDate: monthStart(2), endDate: monthEnd(3) };
  if (normalized.includes("FOOLS")) return { startDate: monthStart(4), endDate: new Date(Date.UTC(year, 3, 15, 0, 0, 0, 0)) };
  if (normalized.includes("SPRING")) return { startDate: monthStart(3), endDate: monthEnd(6) };
  if (normalized.includes("SUMMER") || normalized.includes("VACANCE")) return { startDate: monthStart(7), endDate: monthEnd(9) };
  if (normalized.includes("AUTUMN")) return { startDate: monthStart(9), endDate: monthEnd(12) };
  if (normalized.includes("HALLOWEEN")) return { startDate: monthStart(10), endDate: monthEnd(11) };
  if (normalized.includes("BLACK_FRIDAY") || normalized.includes("BLACKFRIDAY")) return { startDate: monthStart(11), endDate: monthEnd(12) };
  if (normalized.includes("XMAS") || normalized.includes("CHRISTMAS") || normalized.includes("WINTER") || normalized.includes("HOLY_DAY")) {
    return { startDate: monthStart(12), endDate: new Date(Date.UTC(year + 1, 0, 15, 0, 0, 0, 0)) };
  }

  const startDate = startOfUtcDay(targetDate);
  const endDate = new Date(startDate.getTime() + defaultWindowDays * 24 * 60 * 60 * 1000);
  return { startDate, endDate };
}

function isRepeatDateActive(date, startDate, endDate) {
  if (!startDate && !endDate) return false;
  const current = repeatOrdinal(date);
  const start = startDate ? repeatOrdinal(startDate) : 0;
  const end = endDate ? repeatOrdinal(endDate) : 366 * 24 * 60 * 60 * 1000;
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function isRepeatDayActive(date, startDay, endDay) {
  const current = date.getUTCDate();
  const start = Number(startDay || 0);
  const end = Number(endDay || 0);
  if (!start || !end) return false;
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}

function repeatOrdinal(date) {
  const monthStart = Date.UTC(2000, date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
  return monthStart - Date.UTC(2000, 0, 1, 0, 0, 0, 0);
}

function extractRecords(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed.records)) return parsed.records;
  if (Array.isArray(parsed.root)) return parsed.root;
  if (parsed.root && typeof parsed.root === "object") return recordsFromObjectMap(parsed.root);
  if (looksLikeObjectMap(parsed)) return recordsFromObjectMap(parsed);
  return [];
}

function recordsFromObjectMap(value) {
  return Object.entries(value)
    .filter(([, entry]) => entry && typeof entry === "object")
    .map(([key, entry]) => (Array.isArray(entry) ? { __key: key, values: entry } : { __key: key, ...entry }));
}

function looksLikeObjectMap(value) {
  const entries = Object.entries(value).filter(([key]) => !METADATA_KEYS.has(key));
  if (!entries.length) return false;
  return entries.every(([, entry]) => entry && typeof entry === "object");
}

function resolveTableRoots(rootDir, env) {
  return getGameplayTableRoots({
    rootDir,
    env,
    explicitEnvName: "CS_EVENT_TABLE_ROOTS",
  });
}

function findJsonFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && /\.json$/i.test(entry.name)) {
        result.push(filePath);
      }
    }
  }
  result.sort((left, right) => left.localeCompare(right));
  return result;
}

function normalizeTableScan(value) {
  const normalized = String(value || "known").trim().toLowerCase();
  if (["all", "recursive", "everything"].includes(normalized)) return "all";
  return "known";
}

function collectIntervalReferenceTags(record) {
  const values = [];
  collectIntervalReferenceTagsFromValue(record, "", values);
  return uniqueStrings(values);
}

function collectIntervalReferenceTagsFromValue(value, fieldName, values) {
  if (value == null || value === false) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectIntervalReferenceTagsFromValue(entry, fieldName, values);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childFieldName, childValue] of Object.entries(value)) {
      collectIntervalReferenceTagsFromValue(childValue, childFieldName, values);
    }
    return;
  }
  if (!isIntervalReferenceField(fieldName)) return;
  values.push(...normalizeTags(value));
}

function isIntervalReferenceField(fieldName) {
  const text = String(fieldName || "").trim();
  if (!text) return false;
  if (INTERVAL_TAG_FIELDS.includes(text)) return true;
  const normalized = text.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("datestr") || normalized.includes("intervaltag") || normalized.includes("intervalstrid");
}

function firstNonEmptyEnv(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function tagsFromFields(record, fields) {
  const values = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    values.push(...normalizeTags(record[field]));
  }
  return uniqueStrings(values);
}

function normalizeTags(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeTags);
  if (typeof value === "string") {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry && entry !== "0" && entry.toUpperCase() !== "NONE");
  }
  if (typeof value === "number" || typeof value === "bigint") return [String(value)];
  return [];
}

function normalizeNumberValues(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeNumberValues);
  return String(value)
    .split(/[;,]/)
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function uniquePositiveInts(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    result.push(number);
  }
  return result;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function firstFieldValue(record, fields) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const value = record[field];
    if (Array.isArray(value)) {
      const first = value.find((entry) => entry != null && String(entry).trim() !== "");
      if (first != null) return first;
      continue;
    }
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

function stringifyValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return "";
}

function parseTableDate(value) {
  const text = String(value || "").trim();
  if (!text || text === "0") return null;
  const match = text.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?(?:\.(\d{1,7}))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/
  );
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    const millisecond = Number((match[7] || "").slice(0, 3).padEnd(3, "0") || 0);
    const offset = match[8] || "";
    if (offset && offset !== "Z") {
      const normalizedOffset = offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
      const parsed = new Date(
        `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.${String(millisecond).padStart(3, "0")}${normalizedOffset}`
      );
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    return isValidExactUtcDate(date, year, month, day) ? date : null;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseRepeatDay(value) {
  const text = String(value || "").trim();
  if (!/^\d{1,2}$/.test(text)) return 0;
  const day = Number(text);
  return day >= 1 && day <= 31 ? day : 0;
}

function isValidExactUtcDate(date, year, month, day) {
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function tableNameForFile(fileName) {
  return String(fileName || "")
    .replace(/\.(json|luac)$/i, "")
    .replace(/^LUA_/i, "");
}

function categoryForTableName(tableName) {
  const name = String(tableName || "").toUpperCase();
  if (name.includes("INTERVAL")) return "interval";
  if (name.includes("SHOP")) return "shop";
  if (name.includes("MISSION")) return "mission";
  if (name.includes("ATTENDANCE")) return "attendance";
  if (name.includes("CONTRACT")) return "contract";
  if (name.includes("PVP")) return "pvp";
  if (name.includes("EVENT") || name.includes("POINT_EXCHANGE")) return "event";
  return "table";
}

function entryHasClientSignals(entry) {
  return Boolean(
    (entry.openTags && entry.openTags.length) ||
      (entry.intervalTags && entry.intervalTags.length) ||
      (entry.contentsTagAllow && entry.contentsTagAllow.length)
  );
}

function searchableEntryText(entry) {
  const values = [
    entry.id,
    entry.label,
    ...(entry.openTags || []),
    ...(entry.intervalTags || []),
    ...(entry.contentsTagAllow || []),
    ...(entry.contentsTagIgnore || []),
    entry.raw && entry.raw.m_TabNameMain,
  ];
  return values.map((value) => String(value || "").toUpperCase()).join(" ");
}

function hasSeasonalDateToken(text) {
  const normalized = String(text || "").toUpperCase();
  return [
    "NEWYEAR",
    "VALEN",
    "FOOLS",
    "SPRING",
    "SUMMER",
    "VACANCE",
    "AUTUMN",
    "HALLOWEEN",
    "BLACK_FRIDAY",
    "BLACKFRIDAY",
    "XMAS",
    "CHRISTMAS",
    "WINTER",
    "HOLY_DAY",
  ].some((token) => normalized.includes(token));
}

function seasonalTokensForMonth(month) {
  if (month === 1) return ["NEWYEAR", "WINTER", "XMAS", "HOLY_DAY"];
  if (month === 2) return ["VALEN", "WINTER"];
  if (month >= 3 && month <= 5) return ["SPRING", "FOOLS"];
  if (month >= 6 && month <= 8) return ["SUMMER", "VACANCE"];
  if (month >= 9 && month <= 11) return ["AUTUMN", "HALLOWEEN"];
  return ["WINTER", "XMAS", "CHRISTMAS", "HOLY_DAY"];
}

function intersectsTagSet(set, tags) {
  if (!set || !set.size || !Array.isArray(tags)) return false;
  return tags.some((tag) => set.has(String(tag || "").toUpperCase()));
}

function collectUsableTags(entries, fieldName) {
  return uniqueStrings(
    entries.flatMap((entry) => (Array.isArray(entry[fieldName]) ? entry[fieldName] : [])).filter(isUsableTag)
  );
}

function summarizeEntry(entry) {
  return {
    id: entry.id || "",
    label: entry.label || "",
    source: {
      category: entry.source && entry.source.category || "",
      tableName: entry.source && entry.source.tableName || "",
      relativePath: entry.source && entry.source.relativePath || "",
      index: entry.source && entry.source.index || 0,
    },
    openTags: (entry.openTags || []).filter(isUsableTag),
    intervalTags: (entry.intervalTags || []).filter(isUsableTag),
    contentsTagAllow: (entry.contentsTagAllow || []).filter(isUsableTag),
    contentsTagIgnore: (entry.contentsTagIgnore || []).filter(isUsableTag),
    startDate: dateIso(entry.startDate),
    endDate: dateIso(entry.endDate),
    resolvedStartDate: dateIso(entry.resolvedStartDate),
    resolvedEndDate: dateIso(entry.resolvedEndDate),
  };
}

function summarizeIntervalData(interval) {
  return {
    key: interval.key,
    strKey: interval.strKey,
    startDate: dateIso(interval.startDate),
    endDate: dateIso(interval.endDate),
    repeatStartDate: Number(interval.repeatStartDate || 0) || 0,
    repeatEndDate: Number(interval.repeatEndDate || 0) || 0,
    sourceTable: interval.sourceTable || "",
  };
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(keyFn(value) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function dateIso(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : "";
}

function uniqueEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const key = `${entry.source ? entry.source.relativePath : ""}:${entry.source ? entry.source.index : ""}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function isUsableTag(tag) {
  const text = String(tag || "").trim().toUpperCase();
  if (!text || text === "0" || text === "NONE") return false;
  if (text.includes("NOT_USED") || text.includes("NO_USE") || text.includes("DUMMY")) return false;
  if (["GLOBAL", "KOR", "JPN", "CHN", "SEA", "TW", "KR"].includes(text)) return false;
  if (text.startsWith("LANGUAGE_") || text.startsWith("VOICE_")) return false;
  if (text === "CHECK_MAINTENANCE" || text === "MULTITASK_DOWNLOAD") return false;
  return true;
}

function isRequiredIntervalKey(tag) {
  const text = String(tag || "").trim().toUpperCase();
  return Boolean(text && text !== "0" && text !== "NONE");
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

function ensureUniqueIntervalKeys(intervals) {
  const usedKeys = new Set();
  let nextSyntheticKey = 2000000000;
  return (Array.isArray(intervals) ? intervals : []).map((interval) => {
    let key = Number(interval && interval.key);
    if (!Number.isInteger(key) || key === 0 || usedKeys.has(key)) {
      while (usedKeys.has(nextSyntheticKey)) nextSyntheticKey -= 1;
      key = nextSyntheticKey;
      nextSyntheticKey -= 1;
      interval = { ...interval, key };
    }
    usedKeys.add(key);
    return interval;
  });
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function endOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0));
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseEnvBool(value, fallback = false) {
  const text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "on", "yes", "enabled"].includes(text)) return true;
  if (["0", "false", "off", "no", "disabled"].includes(text)) return false;
  return fallback;
}

function addToMapList(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

module.exports = {
  DEFAULT_EVENT_TABLES,
  buildActiveEventState,
  buildEventDiagnostics,
  buildEventRegistry,
  createEventManager,
  createEventTableReader,
  formatEventDiagnostics,
  parseEventDateInput,
  readJsonTableFile,
  resolveEventManagerConfig,
  selectRegistryEntriesForDate,
};
