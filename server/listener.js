const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const ROOT_DIR = path.resolve(__dirname, "..");
loadDotEnv(path.join(ROOT_DIR, ".env"));
const { activateInstalledModRuntime } = require("../modules/mod-loader");
const modRuntime = activateInstalledModRuntime({ rootDir: ROOT_DIR, env: process.env });
const { loadPacketHandlers } = require("./packetHandlerLoader");
const { createUserManager } = require("./userManager");
const {
  createPrivatePvpManager,
  projectUser: projectPrivatePvpUser,
  remapGuestProjection,
  PRIVATE_PVP_OPEN_TAGS,
} = require("../modules/private-pvp");
const { createPvpMatchmaker } = require("../modules/pvp-matchmaking");
const leaguePvp = require("../modules/league-pvp");
const { decodeGameLoadRequest } = require("../modules/game-load/request-codec");
const { validateGameLoadRewardMultiply } = require("../modules/game-load/authority");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const {
  applyActiveUserSelection,
  getActiveOrIndexedUser,
  getActiveUser,
  resolveActiveUserPath,
  writeActiveUserSelection,
} = require("../modules/user-db-selection");
const {
  loadAndroidClientPayloadState,
  loadAndroidClientUpdateState,
  loadFrozenClientPatchState,
  resolveAndroidClientPayloadFile,
  resolveAndroidClientUpdateResponse,
  resolveFrozenClientPatchResponse,
} = require("../modules/frozen-client-update");
const {
  closeGameplayTableHost,
  getDefaultGameplayTablesDir,
  readGameplayTableRecords,
} = require("../modules/gameplay-jsons");
const {
  createCombatHandler,
  buildCapturedRespawnUnitPools: buildCombatCapturedRespawnUnitPools,
} = require("../combat-handler");
const { createOfficialProfileImporter } = require("../modules/official-profile-import");
const {
  isTutorialDungeonId,
  isTutorialStageId,
  mapIdForStageDungeon: tutorialMapIdForStageDungeon,
  stageIdForDungeonId: tutorialStageIdForDungeonId,
  hasTutorialCompletionMission,
  TUTORIAL_COMPLETION_MISSION_IDS,
  TUTORIAL_STAGE_CHAIN,
} = require("../stages/tutorialStage");
const {
  MAIN_STORY_STAGE_CHAIN,
  getMainStoryStageByDungeonId,
  getMainStoryStageByStageId,
  isMainStoryStageId,
  isMainStoryDungeonId,
  isMainStoryCutsceneDungeonId,
  mapIdForStageDungeon: mainStoryMapIdForStageDungeon,
  stageIdForDungeonId: mainStoryStageIdForDungeonId,
  ensureMainStoryState,
  recordMainStoryDungeonClearForUser,
  resetMainStoryPostTutorialProgress,
  getStoryOpenTags,
  normalizeStoryDifficulty,
  isSuppressedStoryOpenTag,
  getSuppressedStoryOpenTags,
} = require("../stages/mainStoryStage");
const {
  COMMON_RESOURCE_ITEM_IDS,
  DEFAULT_LOCAL_SHOP_BALANCE,
  RESOURCE_ITEM_IDS,
  ensureInventory,
  grantMiscItem,
  getMiscItems,
  getSkinIds,
  removeDebugSeededCommonResources,
  seedShopCurrency,
  spendMiscItem,
  toBigInt,
} = require("../modules/inventory");
const {
  ensureArmy,
  getArmyShips,
  getArmyTrophies,
  getArmyUnits,
  getArmyOperators,
  getArmyDeckSets,
  ensureDefaultLineup,
  getArmyUnitByUid,
  getArmyOperatorByUid,
  addUnitExp,
  addOperatorExp,
  grantUnit,
  buildPlayerDeckForGameLoad,
  validatePlayerDeckForGameLoad,
} = require("../modules/unit");
const {
  INVENTORY_TYPES,
  getInventoryCapacity,
  initializeInventoryCapacities,
} = require("../modules/inventory-capacity");
const {
  buildUnitData: buildSerializedUnitData,
  buildOperatorData: buildSerializedOperatorData,
  buildContractStateData: buildSerializedContractStateData,
  buildContractBonusStateData: buildSerializedContractBonusStateData,
  buildSelectableContractStateData: buildSerializedSelectableContractStateData,
  buildEquipItemData: buildSerializedEquipItemData,
  buildDeckIndexData: buildSerializedDeckIndexData,
  buildDeckData: buildSerializedDeckData,
  buildRewardData: buildSerializedRewardData,
  buildMoldItemData: buildSerializedMoldItemData,
  buildCraftSlotData: buildSerializedCraftSlotData,
  buildEquipTuningCandidateData: buildSerializedEquipTuningCandidateData,
  buildPotentialOptionCandidateData: buildSerializedPotentialOptionCandidateData,
  buildShipModuleCandidateData: buildSerializedShipModuleCandidateData,
} = require("../modules/packet-codec");
const { getEquipItems, getMoldItems, getCraftSlots } = require("../modules/equipment");
const {
  buildCompanyBuffList,
  buildPrivateGuildData: buildGuildPrivateData,
  getGuildChatMuteEndDate,
} = require("../modules/company-buff");
const {
  ensureAccountProgress,
  grantStageClearExp,
  completeMission: completeAccountMission,
  buildMissionDataEntries: buildAccountMissionDataEntries,
  getRandomMissionRefreshEntries,
  getRandomMissionTabIds,
  getAchievePoint,
  recordMissionLogin,
  refreshMissionProgress,
  trackMissionEvent,
} = require("../modules/account-progression");
const { ensureOfficialNewAccountDefaults } = require("../modules/new-account");
const {
  createEmptyReward,
  mergeReward,
  grantRewardByType,
  grantRewardRecord,
} = require("../modules/reward");

const {
  buildAttendanceData: buildSerializedAttendanceData,
  buildAttendanceIntervalDataList: buildSerializedAttendanceIntervalDataList,
  ensureAttendanceRewardPosts,
} = require("../modules/attendance");
const {
  loadShopCatalog,
  buildSerializedRandomShopData,
  getActiveEventShopState,
  filterEventClockShopOpenTags,
  ensureActiveEventShopCurrencies,
  buildShopChainTabNextResetListPayload,
  buildConsumerPackageData,
  getConsumerPackageList,
  buildShopSubscriptionEntries,
} = require("../modules/shop");
const { getShopPurchaseHistories, getShopTotalPaidAmount } = require("../modules/resource");
const {
  getContentUnlocksForDungeon,
  getEventDeckTemplet,
  getEventDeckUnitSlotTypes,
  getEventDeckPlayerUnitSlots,
  eventDeckHasFreeShipSlot,
  getMissionTabTemplets,
  getMissionTempletsByTabId,
  getRewardGroupRecords,
  getPlayerTotalExpForLevel,
} = require("../modules/game-data");
const {
  getAllContractStates,
  getAllContractBonusStates,
  getSelectableContractState,
  getAllCustomPickupContracts,
  buildCustomPickupContractData: buildSerializedCustomPickupContractData,
} = require("../modules/contract");
const { buildMyOfficeStateData: buildSerializedMyOfficeStateData } = require("../modules/office");
const lobbyCustomization = require("../modules/lobby");
const loginBackground = require("../modules/login-background");
const simulation = require("../modules/simulation");
const defence = require("../modules/defence");
const defenceBattle = require("../modules/defence-battle");
const stamina = require("../modules/stamina");
const userRefresh = require("../modules/user-refresh");
const collection = require("../modules/collection");
const worldMap = require("../modules/world-map");
const shadowPalace = require("../modules/shadow-palace");
const killCount = require("../modules/kill-count");
const eventBingo = require("../modules/event-bingo");
const eventCollection = require("../modules/event-collection");
const eventPass = require("../modules/event-pass");
const trim = require("../modules/trim");
const explore = require("../modules/explore");
const guildDungeon = require("../modules/guild-dungeon");
const draftPvpVotes = require("../modules/pvp-votes");
const pvpRank = require("../modules/pvp-rank");
const asyncPvp = require("../modules/async-pvp");
const eventPvp = require("../modules/event-pvp");
const { ensureLoginRewardPosts } = require("../modules/admin");
const {
  ensureStageFavorites,
  buildFavoritesStageAckPayload: buildStageFavoritesAckPayload,
} = require("../modules/stage-favorites");
const {
  buildSupportUnitData: buildPersistedSupportUnitData,
  ensureSupportUnit,
  getAvailableSupportUsers,
} = require("../modules/combat-roster");
const {
  createEventManager,
} = require("../modules/event-manager");
const { createServerTime } = require("../modules/server-time");
const {
  REQUIRED_CORE_OPEN_TAGS,
  getCapturedContentsTags,
  getCapturedOpenTags,
  getFrozenContentsTags,
  hasFrozenMissionSnapshot,
} = require("../modules/frozen-content-compat");

function envFlag(...keys) {
  return keys.some((key) => {
    const value = process.env[key];
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  });
}

function envFlagDefault(defaultValue, ...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value == null) continue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return Boolean(defaultValue);
}

function parseOptionalChanceEnv(value) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Math.trunc(parsed), 0, STAGE_REWARD_CHANCE_DENOMINATOR);
}

function parseChanceEnv(value, fallback) {
  const parsed = parseOptionalChanceEnv(value);
  return parsed == null ? fallback : parsed;
}

function resolveNewAccountRosterMode() {
  const explicit = String(process.env.CS_NEW_ACCOUNT_ROSTER_MODE || "").trim().toLowerCase();
  if (["all", "debug-all"].includes(explicit)) return "all";
  if (["starter", "safe"].includes(explicit)) return "starter";
  if (["none", "off", "official", "0", "false"].includes(explicit)) return "none";

  const legacy = String(process.env.CS_SEED_NEW_ACCOUNT_ROSTER || "").trim().toLowerCase();
  if (["all", "debug-all"].includes(legacy)) return "all";
  if (["starter", "safe"].includes(legacy)) return "starter";
  return "none";
}

function resolveGuideMissionTabs() {
  try {
    const tabs = getMissionTabTemplets()
      .filter((tab) => {
        const openTag = String(tab && tab.m_OpenTag || "").toUpperCase();
        const missionTab = String(tab && tab.m_MissionTab || "").toUpperCase();
        return openTag.includes("COMBINE_GUIDE_MISSION") || missionTab === "COMBINE_GUIDE_MISSION" || missionTab === "GROWTH_COMPLETE";
      })
      .map((tab) => Number(tab && tab.m_TabID || 0))
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0);
    return uniqueMissionTabs(tabs);
  } catch (_) {
    return [20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009, 20010, 20011, 20012, 20013];
  }
}

function resolvePaybackMissionTabs() {
  try {
    const tabs = getMissionTabTemplets()
      .filter((tab) => {
        const openTag = String(tab && tab.m_OpenTag || "").toUpperCase();
        const dateStrId = String(tab && tab.m_DateStrID || "").toUpperCase();
        return openTag.includes("EVENT_PAYBACK") || dateStrId.includes("EVENT_PAYBACK");
      })
      .map((tab) => Number(tab && tab.m_TabID || 0))
      .filter((tabId) => Number.isInteger(tabId) && tabId > 0);
    return uniqueMissionTabs(tabs);
  } catch (_) {
    return [8001, 8002, 8004, 8006, 8008, 8010, 8012, 8014];
  }
}

function uniqueMissionTabs(tabIds) {
  return Array.from(
    new Set(
      (Array.isArray(tabIds) ? tabIds : [])
        .map((tabId) => Number(tabId || 0))
        .filter((tabId) => Number.isInteger(tabId) && tabId > 0)
    )
  );
}

const PORT = Number(process.env.CS_PORT || 22000);
const HTTP_MIRROR_PORT = Number(process.env.CS_HTTP_MIRROR_PORT || 8088);
const GAME_LISTEN_HOST = String(process.env.CS_GAME_LISTEN_HOST || "127.0.0.1").trim();
const HTTP_LISTEN_HOST = String(process.env.CS_HTTP_LISTEN_HOST || "127.0.0.1").trim();
const PRIVATE_PVP_LISTEN_HOST = String(process.env.CS_PVP_LISTEN_HOST || "").trim();
const DEBUG_HEX = process.env.CS_DEBUG_HEX === "1";
const VERBOSE_CAPTURE_LOGS = process.env.CS_VERBOSE_CAPTURE === "1" || DEBUG_HEX;
const LOG_CONFIG_EACH_CONNECTION = process.env.CS_LOG_CONFIG_EACH_CONNECTION === "1";

const HEAD_FENCE = 0xaabbccdd;
const TAIL_FENCE = 0x11223344;
const DEFAULT_COMBAT_CONTROLS = Object.freeze({
  autoRespawnEnabled: false,
  gameSpeedType: 0,
  autoSkillType: 1,
});

const LOGIN_ACK = 203;
const JOIN_LOBBY_REQ = 204;
const JOIN_LOBBY_ACK = 205;
const RECONNECT_REQ = 213;
const RECONNECT_ACK = 214;
const CONTENTS_VERSION_REQ = 216;
const CONTENTS_VERSION_ACK = 217;
const GAMEBASE_LOGIN_ACK = 230;
const STEAM_LOGIN_REQ = 231;
const HEART_BIT_REQ = 600;
const HEART_BIT_ACK = 601;
const CONNECT_CHECK_REQ = 602;
const CONNECT_CHECK_ACK = 603;
const SERVER_TIME_REQ = 604;
const SERVER_TIME_ACK = 605;
const COMMON_FAIL_ACK = 610;
const GAME_LOAD_ACK = 804;
const GAME_LOAD_COMPLETE_ACK = 808;
const GAME_START_NOT = 809;
const GAME_END_NOT = 811;
const DEFENCE_GAME_END_NOT = 3906;
const GAME_PAUSE_ACK = 813;
const GAME_CHECK_DIE_UNIT_ACK = 815;
const GAME_RESPAWN_ACK = 817;
const GAME_SHIP_SKILL_REQ = 818;
const GAME_SHIP_SKILL_ACK = 819;
const GAME_GIVEUP_REQ = 823;
const GAME_GIVEUP_ACK = 824;
const GAME_USE_UNIT_SKILL_REQ = 829;
const GAME_USE_UNIT_SKILL_ACK = 830;
const GAME_EMOTICON_ACK = 836;
const GAME_EMOTICON_NOT = 837;
const GAME_UNIT_RETREAT_ACK = 839;
const GAME_TACTICAL_COMMAND_ACK = 843;
const GAME_RESTART_ACK = 862;
const GAME_SURRENDER_ACK = 883;
const GAME_SURRENDER_NOT = 884;
const CUTSCENE_DUNGEON_START_REQ = 1200;
const CUTSCENE_DUNGEON_START_ACK = 1201;
const CUTSCENE_DUNGEON_CLEAR_REQ = 1202;
const CUTSCENE_DUNGEON_CLEAR_ACK = 1203;
const FRIEND_LIST_ACK = 401;
const GREETING_MESSAGE_ACK = 454;
const EMOTICON_DATA_REQ = 455;
const EMOTICON_DATA_ACK = 456;
const EQUIP_PRESET_LIST_ACK = 1039;
const FAVORITES_STAGE_ACK = 1244;
const POST_LIST_ACK = 1615;
const MISSION_UPDATE_NOT = 1619;
const MISSION_COMPLETE_REQ = 1620;
const MISSION_COMPLETE_ACK = 1621;
const FIERCE_SEASON_NOT = 854;
const DEFENCE_INFO_ACK = 3905;
const NPT_GAME_SYNC_DATA_PACK_NOT = 822;
const NGT_DUNGEON = 3;
const NGT_DIVE = 5;
const NGT_RAID = 8;
const NGT_TUTORIAL = 7;
const NGT_CUTSCENE = 9;
const NGT_RAID_SOLO = 12;
const NGT_SHADOW_PALACE = 13;
const NGT_FIERCE = 14;
const NGT_PHASE = 15;
const NGT_TRIM = 23;
const NGT_PVE_DEFENCE = 26;
const NGT_EXPLORE = 29;
const NGS_FINISH = 4;
const PHASE_ERRORS = Object.freeze({
  OK: 0,
  INVALID_STAGE: 66,
  INSUFFICIENT_CASH: 96,
  INSUFFICIENT_ETERNIUM: 97,
  INSUFFICIENT_CREDIT: 98,
  INSUFFICIENT_INFORMATION: 99,
  INSUFFICIENT_ITEM: 111,
  INVALID_REQUEST: 20191,
  INVALID_EVENT_DECK: 20942,
  SUPPORT_NOT_FOUND: 27803,
});
const NTT_A1 = 1;
const NTT_B1 = 3;
const FIERCE_ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  ALREADY_GOT_REWARD: 20491,
  INVALID_POINT_REWARD_ID: 20496,
  INVALID_BOSS_ID: 20500,
  PROFILE_NOT_EXISTS: 20503,
  INSUFFICIENT_RANK_REWARD_CONDITION: 20505,
  INSUFFICIENT_POINT_REWARD_CONDITION: 20506,
  NO_MORE_RANK_REWARD: 20508,
  INVALID_LEADERBOARD_BOSS_ID: 20603,
  PENALTY_BOSS_LEVEL: 21033,
  PENALTY_BOSS_GROUP: 21034,
  PENALTY_COUNT: 21035,
  PENALTY_TYPE: 21036,
  PENALTY_DUPLICATE_GROUP: 21037,
});

const CAPTURED_FLOW_DIR =
  process.env.CS_CAPTURED_FLOW_DIR || path.join(ROOT_DIR, "server-data", "captured-flows");
const CAPTURED_TCP_DIR =
  process.env.CS_CAPTURED_TCP_DIR || path.join(ROOT_DIR, "server-data", "captured-tcp");
const CAPTURED_GAME_FLOW_DIR =
  process.env.CS_CAPTURED_GAME_FLOW_DIR || path.join(ROOT_DIR, "server-data", "captured-game-flow");
const PACKET_HANDLER_DIR = process.env.CS_PACKET_HANDLER_DIR || path.join(ROOT_DIR, "packet-handlers");
const MODULE_HANDLER_ROOT = path.join(ROOT_DIR, "modules");
const UNIT_TABLE_PATH = process.env.CS_UNIT_TABLE_PATH || path.join(ROOT_DIR, "server-data", "units.json");
const DUNGEON_TABLE_OVERRIDE_PATH = String(process.env.CS_DUNGEON_TABLE_PATH || "").trim();
const DUNGEON_TABLE_FALLBACK_PATH = path.join(ROOT_DIR, "server-data", "dungeons.json");
const STAGE_TABLE_PATH = process.env.CS_STAGE_TABLE_PATH || "";
const MAP_TABLE_PATH = process.env.CS_MAP_TABLE_PATH || "";
const USE_LOCAL_USER_DB = process.env.CS_USE_LOCAL_USER_DB !== "0";
const STAGE_REWARD_CHANCE_DENOMINATOR = 10000;
const FIERCE_DAY_MS = 24 * 60 * 60 * 1000;
const STAGE_FULL_ACTOR_REWARD_GROUP_CHANCE = parseChanceEnv(
  process.env.CS_STAGE_FULL_ACTOR_REWARD_GROUP_CHANCE || process.env.CS_STAGE_UNIT_DROP_CHANCE,
  500
);
const FIERCE_ROTATION_ANCHOR_ISO = process.env.CS_FIERCE_ROTATION_ANCHOR || "2025-10-01T03:00:00.000Z";
const FIERCE_ROTATION_CYCLE_DAYS = Math.max(1, Number(process.env.CS_FIERCE_ROTATION_CYCLE_DAYS || 14) || 14);
const FIERCE_ROTATION_GAME_DAYS = Math.min(
  FIERCE_ROTATION_CYCLE_DAYS,
  Math.max(1, Number(process.env.CS_FIERCE_ROTATION_GAME_DAYS || 7) || 7)
);
const SEND_FIERCE_SEASON_BOOTSTRAP = envFlagDefault(
  true,
  "CS_SEND_FIERCE_SEASON_BOOTSTRAP",
  "CS_FIERCE_SEASON_BOOTSTRAP"
);
const REPLAY_CAPTURED_CONTENTS_VERSION = process.env.CS_REPLAY_CAPTURED_CONTENTS_VERSION !== "0";
const REPLAY_CAPTURED_LOGIN_ACK = process.env.CS_REPLAY_CAPTURED_LOGIN_ACK !== "0";
const REPLAY_CAPTURED_GAME_FLOW = process.env.CS_REPLAY_CAPTURED_GAME_FLOW !== "0";
const REPLAY_CAPTURED_GAME_AUTO_ADVANCE = process.env.CS_REPLAY_CAPTURED_GAME_AUTO_ADVANCE === "1";
const REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS = 0;
const SYNTHETIC_SYNC_INTERVAL_MS = Number(process.env.CS_SYNTHETIC_SYNC_INTERVAL_MS || 200);
const DYNAMIC_BATTLE_MANAGER = process.env.CS_DYNAMIC_BATTLE_MANAGER !== "0";
const DYNAMIC_BATTLE_SYNC_INTERVAL_MS = Number(process.env.CS_DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
const MANAGED_HOST_TICK_INTERVAL_MS = Number(process.env.CS_MANAGED_HOST_TICK_INTERVAL_MS || 33);
const MANAGED_HOST_PRIME_FRAMES = Number(process.env.CS_MANAGED_HOST_PRIME_FRAMES || 1);
const DYNAMIC_BATTLE_GAME_UNIT_GROUPS = parseGameUnitGroups(process.env.CS_DYNAMIC_BATTLE_GAME_UNIT_GROUPS || "5,6;8,9;10,11;12,13");
const CSHARP_COMBAT_HOST = process.env.CS_CSHARP_COMBAT_HOST !== "0";
const REQUIRE_COMBAT_HOST = process.env.CS_REQUIRE_COMBAT_HOST === "1";
const CSHARP_COMBAT_HOST_PROJECT = process.env.CS_CSHARP_COMBAT_HOST_PROJECT || path.join(ROOT_DIR, "combat-host", "CombatHost.csproj");
const CSHARP_COMBAT_HOST_DLL =
  process.env.CS_CSHARP_COMBAT_HOST_DLL || process.env.CS_COMBAT_HOST_PATH || findDefaultCombatHostExecutable(CSHARP_COMBAT_HOST_PROJECT);
const CSHARP_COMBAT_HOST_TIMEOUT_MS = Number(process.env.CS_CSHARP_COMBAT_HOST_TIMEOUT_MS || 20000);
const CSHARP_COMBAT_HOST_DOTNET = process.env.CS_CSHARP_COMBAT_HOST_DOTNET || process.env.CS_DOTNET_PATH || findDefaultDotnetRuntime();
const COUNTERSIDE_MANAGED_DIR = process.env.CS_COUNTERSIDE_MANAGED_DIR || findCounterSideManagedDir({ env: process.env });
const REQUIRE_FROZEN_CLIENT_PATCH = process.env.CS_REQUIRE_FROZEN_CLIENT_PATCH === "1";
const GAMEPLAY_TABLES_DIR = getDefaultGameplayTablesDir({ rootDir: ROOT_DIR, env: process.env, managedDir: COUNTERSIDE_MANAGED_DIR });
const FROZEN_CLIENT_PATCH_STATE = loadFrozenClientPatchState(COUNTERSIDE_MANAGED_DIR, {
  gameplayTablesDir: GAMEPLAY_TABLES_DIR,
});
const ANDROID_CLIENT_UPDATE_STATE = loadAndroidClientUpdateState(
  process.env.CS_ANDROID_CLIENT_UPDATE_DIR || path.join(ROOT_DIR, "server-data", "android-client-update")
);
const ANDROID_CLIENT_PAYLOAD_STATE = loadAndroidClientPayloadState(process.env.CS_ANDROID_CLIENT_PAYLOAD_DIR || "");
if (REQUIRE_FROZEN_CLIENT_PATCH && (!FROZEN_CLIENT_PATCH_STATE || !FROZEN_CLIENT_PATCH_STATE.isFrozenClient)) {
  throw new Error("The controlled frozen client marker and version metadata could not be loaded.");
}
if (REQUIRE_FROZEN_CLIENT_PATCH && !FROZEN_CLIENT_PATCH_STATE.contentsVersion) {
  throw new Error("The frozen client content version could not be read from the extracted gameplay cache.");
}
const OFFICIAL_COMBAT_REPLAY = process.env.CS_OFFICIAL_COMBAT_REPLAY === "1";
const OFFICIAL_COMBAT_REPLAY_START_INDEX = Number(process.env.CS_OFFICIAL_COMBAT_REPLAY_START_INDEX || 64);
const OFFICIAL_COMBAT_REPLAY_INTERVAL_MS = Number(process.env.CS_OFFICIAL_COMBAT_REPLAY_INTERVAL_MS || 33);
const TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX = Number(process.env.CS_TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX || 98);
const ALLOW_SYNTHETIC_GAME_SYNC = process.env.CS_ALLOW_SYNTHETIC_GAME_SYNC === "1";
const REFRAME_CAPTURED_GAME_FLOW = process.env.CS_REFRAME_CAPTURED_GAME_FLOW === "1";
const SKIP_TUTORIAL_CUTSCENE = process.env.CS_SKIP_TUTORIAL_CUTSCENE === "1";
const SKIP_TUTORIAL_TO_WIN = process.env.CS_SKIP_TUTORIAL_TO_WIN === "1";
const RESET_LOCAL_PROGRESS_ON_LOGIN = process.env.CS_RESET_LOCAL_PROGRESS_ON_LOGIN === "1";
const RESET_TUTORIAL_PROGRESS_ON_LOGIN = process.env.CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN === "1";
const RESET_CAMPAIGN_PROGRESS_ON_LOGIN = envFlag("resetcampaignprogress", "RESETCAMPAIGNPROGRESS", "CS_RESET_CAMPAIGN_PROGRESS");
const CLEAR_ALL_MISSIONS_STATUS = envFlag(
  "clearAllMissionsStatus",
  "clearallmissionsstatus",
  "CLEARALLMISSIONSSTATUS",
  "CS_CLEAR_ALL_MISSIONS_STATUS",
  "CS_CLEAR_ALL_MISSION_STATUS"
);
const CLEAR_UNITS_LEVEL1 = envFlag("clearUnitsLevel1", "CLEARUNITSLEVEL1", "CS_CLEAR_UNITS_LEVEL1", "CS_CLEAR_UNITS_LEVEL_1");
const CLEAR_GEAR_UNENHANCED = envFlag("clearGearUnenhanced", "CLEARGEARUNENHANCED", "CS_CLEAR_GEAR_UNENHANCED");
const CLEAR_SHIPS_LEVEL1 = envFlag("clearShipsLevel1", "CLEARSHIPSLEVEL1", "CS_CLEAR_SHIPS_LEVEL1", "CS_CLEAR_SHIPS_LEVEL_1");
const CLEAR_OPERATORS_LEVEL1 = envFlag(
  "clearOperatorsLevel1",
  "CLEAROPERATORSLEVEL1",
  "CS_CLEAR_OPERATORS_LEVEL1",
  "CS_CLEAR_OPERATORS_LEVEL_1"
);
const LOCAL_JOIN_LOBBY_ACK_MODE = String(process.env.CS_USE_LOCAL_JOIN_LOBBY_ACK || "auto").trim().toLowerCase();
const USE_LOCAL_JOIN_LOBBY_ACK = LOCAL_JOIN_LOBBY_ACK_MODE === "1" || LOCAL_JOIN_LOBBY_ACK_MODE === "true";
const LOBBY_LOCAL_MISSION_DATA = envFlagDefault(true, "lobbyLocalMissionData", "LOBBYLOCALMISSIONDATA", "CS_LOBBY_LOCAL_MISSION_DATA");
const GUIDE_MISSION_TABS = Object.freeze(resolveGuideMissionTabs());
const PAYBACK_MISSION_TABS = Object.freeze(resolvePaybackMissionTabs());
const SIMULATION_MISSION_TABS = [6, 7, 8];
const FAST_LOBBY_MISSION_TABS = uniqueMissionTabs([1, 2, 3, ...SIMULATION_MISSION_TABS, ...GUIDE_MISSION_TABS]);
const POST_TUTORIAL_MIN_USER_LEVEL = Math.max(2, Number(process.env.CS_POST_TUTORIAL_MIN_USER_LEVEL || 2) || 2);
const DEFAULT_STARTER_SHIP_ID = 21001; // NKM_SHIP_A_COFFIN_1
const NEW_ACCOUNT_ROSTER_MODE = resolveNewAccountRosterMode();
const SEED_NEW_ACCOUNT_TROPHIES = process.env.CS_SEED_NEW_ACCOUNT_TROPHIES === "1";
const USE_STEAM_TOKEN_AS_ACCESS_TOKEN = process.env.CS_USE_STEAM_TOKEN_AS_ACCESS_TOKEN === "1";
let serverInfoMode = normalizeServerInfoMode(
  process.env.CS_SERVER_INFO_MODE ||
    (process.env.CS_REWRITE_CAPTURED_SERVER_INFO === "0" ? "official" : "revivalside")
);
const MIRROR_PUBLIC_HOST = process.env.CS_HTTP_MIRROR_HOST || "127.0.0.1";
const MIRROR_PUBLIC_BASE_URL =
  process.env.CS_HTTP_MIRROR_BASE_URL || `http://${MIRROR_PUBLIC_HOST}:${HTTP_MIRROR_PORT}`;
const ANDROID_CLIENT_CDN_BASE_URL = ensureTrailingSlash(
  process.env.CS_ANDROID_CLIENT_CDN_BASE_URL || `${MIRROR_PUBLIC_BASE_URL}/patchfiles/`
);
const USER_DB_PATH = process.env.CS_USER_DB_PATH || path.join(ROOT_DIR, "server-data", "users.json");
const ACTIVE_USER_PATH = resolveActiveUserPath(USER_DB_PATH, process.env.CS_ACTIVE_USER_PATH || "");
const SERVER_TIME_STATE_PATH = process.env.CS_SERVER_TIME_STATE_PATH || path.join(ROOT_DIR, "server-data", "server-time.json");
const USER_MANAGER_ENABLED = process.env.CS_USER_MANAGER !== "0";
const USER_MANAGER_BASE_PATH = process.env.CS_USER_MANAGER_BASE_PATH || "/user-manager";
const USER_MANAGER_ALLOW_REMOTE = process.env.CS_USER_MANAGER_ALLOW_REMOTE === "1";

const COMBAT_STATE_ID = Object.freeze({
  IDLE: 12,
  MOVE: 13,
  ATTACK: 45,
  DEAD: 18,
});
const DEFAULT_COMBAT_STATS = Object.freeze({
  damage: Number(process.env.CS_DEFAULT_UNIT_DAMAGE || 10),
  attackRange: Number(process.env.CS_DEFAULT_UNIT_ATTACK_RANGE || 130),
  moveSpeed: Number(process.env.CS_DEFAULT_UNIT_MOVE_SPEED || 55),
  attackCooldown: Number(process.env.CS_DEFAULT_UNIT_ATTACK_COOLDOWN || 1.2),
});
const DEFAULT_DEPLOYED_UNIT_HP = Number(process.env.CS_DEFAULT_DEPLOYED_UNIT_HP || 1989);
const STATIC_COMBAT_STATS = Object.freeze({
  damage: Number(process.env.CS_STATIC_UNIT_DAMAGE || 8),
  attackRange: Number(process.env.CS_STATIC_UNIT_ATTACK_RANGE || 180),
  moveSpeed: 0,
  attackCooldown: Number(process.env.CS_STATIC_UNIT_ATTACK_COOLDOWN || 1.6),
});
const POST_TUTORIAL_GUIDE_MISSION_IDS = Object.freeze([340, 341, 345, 610]);
const POST_TUTORIAL_GUIDE_REQUIREMENT_STAGE_IDS = Object.freeze({
  340: 11665, // Daily / Simulation guide after NKM_MAIN_BATTLE_EP1_2_4_ACT_BOSS_A
  341: 11665, // Daily challenge follow-up in the same tutorial mission group
  345: 11242, // DailyAdd / Anti-air Simulation prompt after NKM_MAIN_BATTLE_EP1_4_2_HARD_BOSS_A
  610: 11245, // SupplyGuide / NKM_DUNGEON_EP1_ACT4_EPLIOGUE
});

const GAME_SERVER_IP = process.env.CS_GAME_SERVER_IP || "127.0.0.1";
const GAME_SERVER_PORT = Number(process.env.CS_GAME_SERVER_PORT || PORT);
const PRIVATE_PVP_ENABLED = process.env.CS_PRIVATE_PVP !== "0";
const PRIVATE_PVP_PUBLIC_HOST = process.env.CS_PVP_PUBLIC_HOST || GAME_SERVER_IP;
const PRIVATE_PVP_HOST_URL = process.env.CS_PVP_HOST_URL || "";
const PRIVATE_PVP_RELAY_URL = String(process.env.CS_PVP_RELAY_URL || "").trim();
const PRIVATE_PVP_RELAY_SECRET = String(process.env.CS_PVP_RELAY_SECRET || "");
const PRIVATE_PVP_RELAY_HOST_ID = String(process.env.CS_PVP_RELAY_HOST_ID || "").trim();
const PRIVATE_PVP_RELAY_ROLE = String(process.env.CS_PVP_RELAY_ROLE || "off").trim().toLowerCase();
const PRIVATE_PVP_MAP_ID = Math.max(1, Number(process.env.CS_PVP_MAP_ID || 1002) || 1002);
const FROZEN_SOURCE_CONTENTS_VERSION =
  String(process.env.CS_FROZEN_SOURCE_CONTENTS_VERSION || "").trim() ||
  (FROZEN_CLIENT_PATCH_STATE && FROZEN_CLIENT_PATCH_STATE.isFrozenClient
    ? FROZEN_CLIENT_PATCH_STATE.contentsVersion
    : "");
const LOCK_CONTENTS_VERSION = Boolean(FROZEN_SOURCE_CONTENTS_VERSION) || process.env.CS_LOCK_CONTENTS_VERSION === "1";
const CONTENTS_VERSION = process.env.CS_CONTENTS_VERSION || FROZEN_SOURCE_CONTENTS_VERSION || "9.2.c";

const REQUIRED_CONTENTS_TAGS = Object.freeze([
  "TAG_COMMON_SHOP_TAB_SUPPLY",
  "TAG_COMMON_SHOP_TAB_PACKAGE_SUPER_PACK",
  "SYSTEM_TRANSCENDENCE_LV120",
]);
const REQUIRED_STORY_OPEN_TAGS = Object.freeze(getStoryOpenTags());
const SUPPRESSED_STORY_OPEN_TAGS = Object.freeze(getSuppressedStoryOpenTags());
const SUPPRESSED_STORY_OPEN_TAG_SET = new Set(SUPPRESSED_STORY_OPEN_TAGS.map((tag) => String(tag || "").toUpperCase()));
const EXPLICIT_OPEN_TAGS = Object.freeze(parseTags(process.env.CS_OPEN_TAGS || ""));
const EXPLICIT_OPEN_TAG_SET = new Set(EXPLICIT_OPEN_TAGS.map((tag) => String(tag || "").toUpperCase()));
const CUSTOM_OPERATOR_OPEN_TAG_SET = new Set(["TAG_GLOBAL_CONTRACT_CUSTOM_OPR", "TAG_GLOBAL_CONTRACT_CUSTOM_OPR_COMEBACK"]);
const OBSOLETE_CONTRACT_OPEN_TAG_SET = new Set([
  "TAG_GLOBAL_CONTRACT_OPERATOR_TUTORIAL",
  "TAG_GLOBAL_CONTRACT_CBT",
  "TAG_GLOBAL_CONTRACT_OBT",
  "TAG_KOR_CONTRACT_OLD_VERSION",
]);
const REQUIRED_INTERVAL_TAGS = Object.freeze([
  "DATE_GLOBAL_CONTRACT_SELECTABLE",
  "DATE_GLOBAL_CONTRACT_CUSTOM_SSR_V2",
  "DATE_GLOBAL_CONTRACT_CUSTOM_OPR",
  "DATE_GLOBAL_CONTRACT_CUSTOM_AWAKEN",
]);
const CONTENTS_TAGS = mergeTags(
  parseTags(
    process.env.CS_CONTENTS_TAGS ||
      "GLOBAL,LANGUAGE_KOR,LANGUAGE_ENG,LANGUAGE_DEU,LANGUAGE_FRA,LANGUAGE_JPN,LANGUAGE_TRADITIONAL_CHN,VOICE_KOR,VOICE_JPN,CHECK_MAINTENANCE,MULTITASK_DOWNLOAD"
  ),
  REQUIRED_CONTENTS_TAGS
);
const OPEN_TAGS = mergeTags(
  EXPLICIT_OPEN_TAGS,
  REQUIRED_CORE_OPEN_TAGS,
  REQUIRED_STORY_OPEN_TAGS,
  PRIVATE_PVP_ENABLED ? PRIVATE_PVP_OPEN_TAGS : []
);
const eventManager = createEventManager({ rootDir: ROOT_DIR, env: process.env });
const serverTime = createServerTime({
  rootDir: ROOT_DIR,
  statePath: SERVER_TIME_STATE_PATH,
  defaultDate: eventManager.config && eventManager.config.eventDate,
  logger: (message) => console.log(message),
});
const privatePvp = createPrivatePvpManager({
  enabled: PRIVATE_PVP_ENABLED,
  publicHost: PRIVATE_PVP_PUBLIC_HOST,
  publicPort: GAME_SERVER_PORT,
  peerHostUrl: PRIVATE_PVP_HOST_URL,
  relayUrl: PRIVATE_PVP_RELAY_URL,
  relaySecret: PRIVATE_PVP_RELAY_SECRET,
  relayHostId: PRIVATE_PVP_RELAY_HOST_ID,
  relayRole: PRIVATE_PVP_RELAY_ROLE,
  localGamePort: PORT,
  allowInsecureRelayLoopback: process.env.CS_PVP_RELAY_ALLOW_INSECURE_LOOPBACK === "1",
  logger: (message) => console.log(message),
  onRoomChanged(room) {
    privatePvp.broadcastState(room, createPacketContext());
  },
});
const pvpMatchmaking = createPvpMatchmaker({ logger: (message) => console.log(message) });
const leaguePvpMatchmaking = leaguePvp.createLeaguePvpMatchmaker({ logger: (message) => console.log(message) });
const runtimeEventManager = createRuntimeEventManager(eventManager);
const LOGIN_BACKGROUND_MODE = String(process.env.CS_LOGIN_BACKGROUND || loginBackground.AUTO).trim();
const LOGIN_BACKGROUND_CATALOG = loginBackground.getLoginBackgroundCatalog({ rootDir: ROOT_DIR, env: process.env });
const EVENT_MANAGER_DIAGNOSTICS = envFlag("CS_EVENT_DIAGNOSTICS");
const EVENT_CONTENTS_TAGS_ENABLED = envFlag("CS_EVENT_EMIT_CONTENTS_TAGS", "CS_EVENT_CONTENTS_TAGS");
const EVENT_COUNTER_PASS_CONTENTS_TAGS_ENABLED = envFlagDefault(
  true,
  "CS_EVENT_EMIT_COUNTER_PASS_CONTENTS_TAGS",
  "CS_COUNTER_PASS_CONTENTS_TAGS"
);
const EVENT_SHOP_CONTENTS_TAGS_ENABLED = envFlagDefault(
  true,
  "CS_EVENT_SHOP_EMIT_CONTENTS_TAGS",
  "CS_EVENT_SHOP_CONTENTS_TAGS"
);
const EVENT_SHOP_OPEN_TAGS_ENABLED = envFlagDefault(true, "CS_EVENT_SHOP_EMIT_OPEN_TAGS", "CS_EVENT_SHOP_OPEN_TAGS");

const CRYPTO_MASKS = [
  14170986657190717782n,
  15546886188969944187n,
  15913139373130964729n,
  3486779174683840252n,
];

const capturedTcpResponses = loadCapturedTcpResponses(CAPTURED_TCP_DIR);
const capturedTcpProfiles = buildCapturedTcpProfiles(capturedTcpResponses, CAPTURED_TCP_DIR);
const capturedGameTemplateFlow = loadCapturedGameFlow(CAPTURED_GAME_FLOW_DIR);
const capturedGameFlow = REPLAY_CAPTURED_GAME_FLOW ? capturedGameTemplateFlow : null;
const capturedRespawnUnitPools = buildCombatCapturedRespawnUnitPools(capturedGameFlow, {
  decodeGameRespawnReq,
  parseCapturedGameSyncPayload,
  gameRespawnAck: GAME_RESPAWN_ACK,
  gameSync: NPT_GAME_SYNC_DATA_PACK_NOT,
});
const capturedCombatReplayEntries = buildCapturedCombatReplayEntries(capturedGameFlow);
const capturedFlowMirror = loadCapturedFlowMirror(CAPTURED_FLOW_DIR);
const gameplayUnitStats = loadGameplayUnitStats(UNIT_TABLE_PATH);
let userDbRevision = 0;
const userDb = loadUserDb(USER_DB_PATH);
applyActiveUserSelection(userDb, ACTIVE_USER_PATH);
const repairedDeckReferenceProfiles = repairUserDbDeckReferences(userDb);
if (repairedDeckReferenceProfiles > 0 && USE_LOCAL_USER_DB) {
  console.log(`[user-db] repaired stale deck references profiles=${repairedDeckReferenceProfiles}`);
  saveUserDb();
}
const packetHandlers = loadPacketHandlers([PACKET_HANDLER_DIR, MODULE_HANDLER_ROOT], { rootDir: ROOT_DIR });
const joinLobbyAckPayloadCache = new Map();
const lobbySessionPreparationCache = new Map();
const prewarmedJoinLobbyAckPayloads = new Map();
const localProgressResetUsers = new Set();
const activeClientSockets = new Set();
let cachedDungeonCatalog = null;
let cachedStageCatalog = null;
let cachedMiscStageCatalog = null;
let cachedMapIdByStrId = null;

if (process.env.CS_DUMP_JOIN_LOBBY_ACK_PAYLOAD) {
  const dumpUserUid = String(process.env.CS_DUMP_USER_UID || "");
  const user = ensureUserDefaults(
    (dumpUserUid && userDb.users[dumpUserUid]) ||
      Object.values(userDb.users)[0] || {
        userUid: "1000000001",
        friendCode: "10000001",
        nickname: "LocalAdmin",
        accessToken: "local-access-token",
        reconnectKey: "",
      }
  );
  const payload = buildMinimalJoinLobbyPayload(user);
  fs.writeFileSync(process.env.CS_DUMP_JOIN_LOBBY_ACK_PAYLOAD, payload);
  console.log(
    `[debug] wrote JOIN_LOBBY_ACK payload uid=${user.userUid || "(ephemeral)"} bytes=${payload.length} path=${process.env.CS_DUMP_JOIN_LOBBY_ACK_PAYLOAD}`
  );
  process.exit(0);
}

// Combat simulation is isolated behind combat-handler. This listener keeps the
// networking responsibilities: packet routing, encryption/framing, capture replay
// ordering, and socket writes.
closeGameplayTableHost();
const combatHandler = createCombatHandler({
  constants: {
    HEART_BIT_ACK,
    GAME_END_NOT,
    NPT_GAME_SYNC_DATA_PACK_NOT,
  },
  config: {
    DYNAMIC_BATTLE_MANAGER,
    DYNAMIC_BATTLE_SYNC_INTERVAL_MS,
    MANAGED_HOST_TICK_INTERVAL_MS,
    DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
    CSHARP_COMBAT_HOST,
    CSHARP_COMBAT_HOST_PROJECT,
    CSHARP_COMBAT_HOST_DLL,
    CSHARP_COMBAT_HOST_TIMEOUT_MS,
    CSHARP_COMBAT_HOST_DOTNET,
    COUNTERSIDE_MANAGED_DIR,
    GAMEPLAY_TABLES_DIR,
    MOD_TABLES_DIR: modRuntime.currentRoot,
    CONTENTS_TAGS: getEffectiveContentsTags(CONTENTS_TAGS),
    OPEN_TAGS: getEffectiveOpenTags(OPEN_TAGS),
  },
  combatStateId: COMBAT_STATE_ID,
  defaultCombatStats: DEFAULT_COMBAT_STATS,
  staticCombatStats: STATIC_COMBAT_STATS,
  defaultDeployedUnitHp: DEFAULT_DEPLOYED_UNIT_HP,
  gameplayUnitStats,
  capturedGameFlow: capturedGameFlow || capturedGameTemplateFlow,
  capturedRespawnUnitPools,
  parseCapturedGameSyncPayload,
  extractGameLoadUnitPools,
  makeDynamicGameUid,
  mapIdForStageDungeon,
});

const userManager = USER_MANAGER_ENABLED
  ? createUserManager({
      basePath: USER_MANAGER_BASE_PATH,
      allowRemote: USER_MANAGER_ALLOW_REMOTE,
      userDb,
      userDbPath: USER_DB_PATH,
      activeUserPath: ACTIVE_USER_PATH,
      saveUserDb,
      ensureUserDefaults,
      makeAccessToken,
      makeToken,
      invalidateJoinLobbyAckPayloadCache,
      onActiveUserChanged: recycleClientSessionsForProfileSwitch,
    })
  : null;

if (process.env.CS_DUMP_MERGED_JOIN_LOBBY_ACK_PAYLOAD) {
  const dumpUserUid = String(process.env.CS_DUMP_USER_UID || "");
  const user = ensureUserDefaults(
    (dumpUserUid && userDb.users[dumpUserUid]) ||
      Object.values(userDb.users)[0] || {
        userUid: "1000000001",
        friendCode: "10000001",
        nickname: "LocalAdmin",
        accessToken: "local-access-token",
        reconnectKey: "",
      }
  );
  const payload = buildJoinLobbyAckPayload(user);
  fs.writeFileSync(process.env.CS_DUMP_MERGED_JOIN_LOBBY_ACK_PAYLOAD, payload);
  console.log(
    `[debug] wrote merged JOIN_LOBBY_ACK payload uid=${user.userUid || "(ephemeral)"} bytes=${payload.length} path=${process.env.CS_DUMP_MERGED_JOIN_LOBBY_ACK_PAYLOAD}`
  );
  process.exit(0);
}

let lastSteamAccessToken = "";
let lastEffectiveAccessToken = "";
// Android negotiates contents and logs in on consecutive TCP connections.
let lastAckContentsVersion = "";
let lastAckContentsTags = [];
let runtimeConfigPrinted = false;

if (process.env.CS_LISTENER_TEST_MODE !== "1") {
  startTcpServer();
  startHttpMirror();
}

module.exports = { createPacketContext, handleFallbackPacket, buildCommonFailAckPayload };

function startTcpServer() {
  const onConnection = (socket) => {
    // The Unity client reacts poorly to tiny TCP write stalls during load.
    // Send framed server packets immediately and batch deliberate bursts below.
    socket.setNoDelay(true);
    socket.recvBuffer = Buffer.alloc(0);
    socket.session = {
      user: null,
      steamLogin: null,
      gameReplay: createGameReplayState(),
      nextServerSequence: 1,
    };
    lastSteamAccessToken = "";
    activeClientSockets.add(socket);

    console.log(`\n[+] Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
    logRuntimeConfig();

    socket.on("data", (chunk) => {
      socket.recvBuffer = Buffer.concat([socket.recvBuffer, chunk]);
      processReceiveBuffer(socket);
    });

    socket.on("end", () => console.log("[*] Client ended socket"));
    socket.on("close", (hadError) => {
      activeClientSockets.delete(socket);
      pvpMatchmaking.handleSocketClose(socket);
      leaguePvpMatchmaking.handleSocketClose(socket, createPacketContext());
      const privatePvpRoom = privatePvp.getRoom(socket);
      stopGameSyncTimers(socket);
      privatePvp.handleSocketClose(socket, createPacketContext());
      if (privatePvpRoom && privatePvpRoom.battleStarted && !privatePvpRoom.replay.dynamicBattleResultSent) {
        const survivor = privatePvpRoom.members.find((entry) => entry.socket && !entry.socket.destroyed);
        if (survivor) startDynamicBattleManager(survivor.socket, "private-pvp-peer-disconnect");
      }
      console.log(`[-] Client disconnected hadError=${hadError}`);
    });
    socket.on("error", (err) => console.log(`[!] Socket error: ${err.message}`));
  };

  for (const host of [...new Set([GAME_LISTEN_HOST, PRIVATE_PVP_LISTEN_HOST].filter(Boolean))]) {
    net.createServer(onConnection).listen(PORT, host, () => console.log(`[+] Listening on ${host}:${PORT}`));
  }
}

function recycleClientSessionsForProfileSwitch(user) {
  const sockets = [...activeClientSockets].filter((socket) => socket && !socket.destroyed);
  console.log(`[user-db] active profile switched uid=${user && user.userUid || "(none)"}; recycling sockets=${sockets.length}`);
  for (const socket of sockets) {
    stopGameSyncTimers(socket);
    socket.destroy();
  }
}

function logRuntimeConfig() {
  if (runtimeConfigPrinted && !LOG_CONFIG_EACH_CONNECTION) return;
  runtimeConfigPrinted = true;

  console.log(`[cfg] localUserDb=${USE_LOCAL_USER_DB ? "on" : "off"} db=${USER_DB_PATH}`);
  console.log(
    `[cfg] userManager=${userManager ? "on" : "off"} path=${
      userManager ? userManager.basePath : "(disabled)"
    } remote=${USER_MANAGER_ALLOW_REMOTE ? "on" : "off"}`
  );
  console.log(
    `[cfg] tcpReplay contents=${REPLAY_CAPTURED_CONTENTS_VERSION ? "on" : "off"} login=${
      REPLAY_CAPTURED_LOGIN_ACK ? "on" : "off"
    } packets=${[...capturedTcpResponses.keys()].join(",") || "(none)"}`
  );
  console.log(
    `[cfg] gameReplay=${REPLAY_CAPTURED_GAME_FLOW && capturedGameFlow ? "on" : "off"} packets=${
      capturedGameFlow ? capturedGameFlow.server.length : 0
    } templates=${
      capturedGameTemplateFlow ? capturedGameTemplateFlow.server.length : 0
    } autoAdvance=${REPLAY_CAPTURED_GAME_AUTO_ADVANCE ? `${REPLAY_CAPTURED_GAME_AUTO_ADVANCE_MS}ms` : "off"} reframe=${
      REFRAME_CAPTURED_GAME_FLOW ? "on" : "off"
    }`
  );
  console.log(
    `[cfg] contentsVersion=${CONTENTS_VERSION} sourceVersion=${FROZEN_SOURCE_CONTENTS_VERSION || "(server)"} locked=${
      LOCK_CONTENTS_VERSION ? "yes" : "no"
    }`
  );
  console.log(`[cfg] contentsTags=${CONTENTS_TAGS.length}`);
  const eventSummary = runtimeEventManager.getSummary();
  const serverTimeSummary = serverTime.getSummary();
  const selectedLoginBackground = getActiveLoginBackground();
  console.log(
    `[cfg] loginBackground=${LOGIN_BACKGROUND_MODE || "auto"} resolved=${
      selectedLoginBackground ? `${selectedLoginBackground.id}:${selectedLoginBackground.contentTag}` : "none"
    } catalog=${LOGIN_BACKGROUND_CATALOG.length}`
  );
  console.log(
    `[cfg] eventManager=${eventSummary.enabled ? "on" : "off"} clockDate=${
      eventSummary.dateIso || serverTimeSummary.eventDateKey || "(unset)"
    } profile=${eventSummary.profile} schedule=${eventSummary.officialScheduleEnabled ? "on" : "off"} dateProfiles=${
      eventSummary.dateProfilesEnabled ? "on" : "off"
    } tableScan=${eventSummary.tableScan} tables=${eventSummary.tableCount} entries=${
      eventSummary.entryCount
    } active=${eventSummary.activeEntryCount} schedules=${eventSummary.activeOfficialScheduleCount} intervals=${eventSummary.activeIntervalCount} contentsTags=${
      eventSummary.activeContentsTagCount
    } emitContentsTags=${EVENT_CONTENTS_TAGS_ENABLED ? "on" : "off"} counterPasses=${
      eventSummary.activeCounterPassCount
    } counterPassContentsTags=${EVENT_COUNTER_PASS_CONTENTS_TAGS_ENABLED ? "on" : "off"} openTags=${eventSummary.activeOpenTagCount}`
  );
  const eventShopSummary = getActiveEventShopTags();
  console.log(
    `[cfg] eventShop=products:${eventShopSummary.productIds.length} tabs:${eventShopSummary.tabCount} currencies:${
      eventShopSummary.priceItemIds.length
    } contentsTags:${eventShopSummary.contentsTags.length} openTags:${eventShopSummary.openTags.length}`
  );
  console.log(
    `[cfg] serverTime=${serverTimeSummary.mode || "local"} current=${
      serverTimeSummary.currentIso
    } clockDate=${serverTimeSummary.eventDateKey || "(unset)"} state=${SERVER_TIME_STATE_PATH}`
  );
  if (EVENT_MANAGER_DIAGNOSTICS) {
    process.stdout.write(runtimeEventManager.formatDiagnostics(getServerNowDate(), { limit: 12 }));
  }
  if (capturedTcpProfiles.contentsVersionAck) {
    console.log(
      `[cfg] officialTcpVersion=${capturedTcpProfiles.contentsVersionAck.contentsVersion} tags=${capturedTcpProfiles.contentsVersionAck.contentsTag.length}`
    );
  }
  if (capturedTcpProfiles.loginAck) {
    console.log(
      `[cfg] officialLoginAck=on version=${capturedTcpProfiles.loginAck.contentsVersion} tags=${capturedTcpProfiles.loginAck.contentsTag.length} openTags=${capturedTcpProfiles.loginAck.openTag.length}`
    );
  }
  if (capturedTcpProfiles.gamebaseLoginAck) {
    console.log(
      `[cfg] officialGamebaseLoginAck=on version=${capturedTcpProfiles.gamebaseLoginAck.contentsVersion} tags=${capturedTcpProfiles.gamebaseLoginAck.contentsTag.length} openTags=${capturedTcpProfiles.gamebaseLoginAck.openTag.length}`
    );
  }
  if (FROZEN_SOURCE_CONTENTS_VERSION) {
    console.log(
      `[cfg] frozenCompatibility source=${FROZEN_SOURCE_CONTENTS_VERSION} target=${CONTENTS_VERSION} contentsTags=${
        getCapturedContentsVersionTags().length
      } openTags=${getFrozenClientOpenTags().length}`
    );
  }
  console.log(`[cfg] gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT}`);
  console.log(
    `[cfg] privatePvp=${PRIVATE_PVP_ENABLED ? "on" : "off"} public=${PRIVATE_PVP_PUBLIC_HOST}:${GAME_SERVER_PORT} peerHost=${PRIVATE_PVP_HOST_URL || "(local-host)"} relay=${PRIVATE_PVP_RELAY_URL ? PRIVATE_PVP_RELAY_ROLE : "off"} map=${PRIVATE_PVP_MAP_ID}`
  );
  console.log(`[cfg] accessTokenSource=${USE_STEAM_TOKEN_AS_ACCESS_TOKEN ? "steam" : "server-issued"}`);
  console.log(
    `[cfg] newAccountRosterMode=${NEW_ACCOUNT_ROSTER_MODE} trophies=${
      SEED_NEW_ACCOUNT_TROPHIES ? "on" : "off"
    }`
  );
  console.log(`[cfg] skipTutorialCutscene=${SKIP_TUTORIAL_CUTSCENE ? "on" : "off"}`);
  console.log(`[cfg] skipTutorialToWin=${SKIP_TUTORIAL_TO_WIN ? "on" : "off"}`);
  console.log(`[cfg] resetLocalProgressOnLogin=${RESET_LOCAL_PROGRESS_ON_LOGIN ? "on" : "off"}`);
  console.log(`[cfg] resetTutorialProgressOnLogin=${RESET_TUTORIAL_PROGRESS_ON_LOGIN ? "on" : "off"}`);
  console.log(`[cfg] resetCampaignProgressOnLogin=${RESET_CAMPAIGN_PROGRESS_ON_LOGIN ? "on" : "off"}`);
  console.log(`[cfg] clearAllMissionsStatus=${CLEAR_ALL_MISSIONS_STATUS ? "on" : "off"}`);
  console.log(
    `[cfg] cleanup clearUnitsLevel1=${CLEAR_UNITS_LEVEL1 ? "on" : "off"} clearGearUnenhanced=${
      CLEAR_GEAR_UNENHANCED ? "on" : "off"
    } clearShipsLevel1=${CLEAR_SHIPS_LEVEL1 ? "on" : "off"} clearOperatorsLevel1=${CLEAR_OPERATORS_LEVEL1 ? "on" : "off"}`
  );
  console.log(`[cfg] localJoinLobbyAck=${USE_LOCAL_JOIN_LOBBY_ACK ? "on" : LOCAL_JOIN_LOBBY_ACK_MODE === "0" || LOCAL_JOIN_LOBBY_ACK_MODE === "false" ? "off" : "auto"}`);
  console.log(`[cfg] lobbyLocalMissionData=${LOBBY_LOCAL_MISSION_DATA ? "on" : "off"}`);
  console.log(
    `[cfg] officialCombatReplay=${OFFICIAL_COMBAT_REPLAY ? "on" : "off"} packets=${
      capturedCombatReplayEntries.length
    } startIndex=${OFFICIAL_COMBAT_REPLAY_START_INDEX} interval=${OFFICIAL_COMBAT_REPLAY_INTERVAL_MS}ms`
  );
  console.log(`[cfg] jsBattleSimulator=removed syntheticSyncInterval=${SYNTHETIC_SYNC_INTERVAL_MS}ms`);
  console.log(
    `[cfg] dynamicBattleManager=${DYNAMIC_BATTLE_MANAGER ? "on" : "off"} syncInterval=${DYNAMIC_BATTLE_SYNC_INTERVAL_MS}ms managedTick=${MANAGED_HOST_TICK_INTERVAL_MS}ms managedPrimeFrames=${MANAGED_HOST_PRIME_FRAMES} spawnGroups=${DYNAMIC_BATTLE_GAME_UNIT_GROUPS.map((group) => group.join(",")).join(";")}`
  );
  console.log(
    `[cfg] csharpCombatHost=${CSHARP_COMBAT_HOST ? "on" : "off"} mode=${
      CSHARP_COMBAT_HOST_DLL ? "exe" : "project"
    } host=${CSHARP_COMBAT_HOST_DLL || CSHARP_COMBAT_HOST_PROJECT} dotnet=${CSHARP_COMBAT_HOST_DOTNET} managed=${
      COUNTERSIDE_MANAGED_DIR || "(none)"
    } tables=${GAMEPLAY_TABLES_DIR || "(none)"}`
  );
  console.log(`[cfg] verboseCaptureLogs=${VERBOSE_CAPTURE_LOGS ? "on" : "off"}`);
  console.log(
    `[cfg] frozenClientUpdate=${FROZEN_CLIENT_PATCH_STATE ? FROZEN_CLIENT_PATCH_STATE.standaloneVersion : "unavailable"} source=${
      FROZEN_CLIENT_PATCH_STATE ? FROZEN_CLIENT_PATCH_STATE.patchInfoPath : "(none)"
    } contents=${FROZEN_CLIENT_PATCH_STATE ? FROZEN_CLIENT_PATCH_STATE.contentsVersion || "unavailable" : "unavailable"} frozen=${
      FROZEN_CLIENT_PATCH_STATE && FROZEN_CLIENT_PATCH_STATE.isFrozenClient ? "yes" : "no"
    } required=${
      REQUIRE_FROZEN_CLIENT_PATCH ? "on" : "off"
    }`
  );
  console.log(
    `[cfg] androidClientUpdate=${ANDROID_CLIENT_UPDATE_STATE ? `${ANDROID_CLIENT_UPDATE_STATE.sourceVersion}->${ANDROID_CLIENT_UPDATE_STATE.version}` : "unavailable"}`
  );
  console.log(
    `[cfg] androidClientPayload=${ANDROID_CLIENT_PAYLOAD_STATE ? `${ANDROID_CLIENT_PAYLOAD_STATE.manifest.id} files=${ANDROID_CLIENT_PAYLOAD_STATE.manifest.fileCount}` : "unavailable"} cdn=${ANDROID_CLIENT_CDN_BASE_URL}`
  );
}

function startHttpMirror() {
  if (!capturedFlowMirror && !userManager && !ANDROID_CLIENT_UPDATE_STATE && !ANDROID_CLIENT_PAYLOAD_STATE && !PRIVATE_PVP_ENABLED) {
    console.log(`[mirror] disabled; no manifest at ${path.join(CAPTURED_FLOW_DIR, "manifest.json")}`);
    return;
  }

  const onRequest = async (req, res) => {
      try {
        if (await serveLauncherApi(req, res)) return;
        if (PRIVATE_PVP_ENABLED && (await privatePvp.handleHttpJoin(req, res))) return;
        if (userManager && (await userManager.handle(req, res))) return;
        if (serveEventManagerDiagnostics(req, res)) return;
        if (serveAndroidClientPayload(req, res)) return;
        if (serveFrozenClientPatchMetadata(req, res)) return;
        if (capturedFlowMirror) {
          serveCapturedFlow(req, res, capturedFlowMirror);
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("No captured HTTP mirror is configured.\n");
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`HTTP server error: ${err.message}\n`);
      }
    };
  let reportedServices = false;
  for (const host of [...new Set([HTTP_LISTEN_HOST, PRIVATE_PVP_LISTEN_HOST].filter(Boolean))]) {
    http.createServer(onRequest).listen(HTTP_MIRROR_PORT, host, () => {
      console.log(`[+] HTTP services listening on ${host}:${HTTP_MIRROR_PORT}`);
      if (reportedServices) return;
      reportedServices = true;
      if (capturedFlowMirror) {
        console.log(`[+] Captured HTTP mirror listening on ${MIRROR_PUBLIC_BASE_URL}`);
        console.log(`[+] Captured HTTP mirror fixtureDir=${CAPTURED_FLOW_DIR}`);
      } else {
        console.log(`[mirror] disabled; no manifest at ${path.join(CAPTURED_FLOW_DIR, "manifest.json")}`);
      }
      if (userManager) {
        console.log(`[+] User manager listening on ${MIRROR_PUBLIC_BASE_URL}${userManager.basePath}`);
      }
      if (PRIVATE_PVP_ENABLED) {
        console.log(`[+] Private PvP join endpoint listening on ${MIRROR_PUBLIC_BASE_URL}/private-pvp/join`);
      }
    });
  }
}

function serveAndroidClientPayload(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const requestUrl = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  const response = resolveAndroidClientPayloadFile(requestUrl.pathname, ANDROID_CLIENT_PAYLOAD_STATE);
  if (!response) return false;

  if (response.body) {
    res.writeHead(200, {
      "Content-Type": response.contentType,
      "Content-Length": response.body.length,
      "Cache-Control": "no-store",
      ETag: `"${response.sha256}"`,
      "X-RevivalSide-Asset-Update": response.label,
    });
    if (req.method === "HEAD") res.end();
    else res.end(response.body);
    return true;
  }

  const etag = `"${response.sha256}"`;
  if (!req.headers.range && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "public, max-age=31536000, immutable" });
    res.end();
    return true;
  }
  const range = parseHttpRange(req.headers.range, response.size);
  if (range === null) {
    res.writeHead(416, { "Content-Range": `bytes */${response.size}`, "Cache-Control": "no-store" });
    res.end();
    return true;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : response.size - 1;
  const length = response.size ? end - start + 1 : 0;
  const headers = {
    "Content-Type": response.contentType,
    "Content-Length": length,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
    "X-Content-SHA256": response.sha256,
    "X-RevivalSide-Asset-Update": response.label,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${response.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || response.size === 0) {
    res.end();
  } else {
    const input = fs.createReadStream(response.filePath, { start, end });
    input.on("error", (error) => res.destroy(error));
    input.pipe(res);
  }
  console.log(`[mirror] ANDROID ${requestUrl.pathname} ${length}b ${range ? "range" : "full"}`);
  return true;
}

function parseHttpRange(value, size) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || size <= 0) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function serveFrozenClientPatchMetadata(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const requestUrl = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  const response =
    resolveAndroidClientUpdateResponse(requestUrl.pathname, ANDROID_CLIENT_UPDATE_STATE) ||
    resolveFrozenClientPatchResponse(requestUrl.pathname, FROZEN_CLIENT_PATCH_STATE);
  if (!response) return false;

  res.writeHead(200, {
    "Content-Type": response.contentType,
    "Content-Length": response.body.length,
    "Cache-Control": "no-store",
    "X-RevivalSide-Asset-Update": response.label,
  });
  if (req.method === "HEAD") res.end();
  else res.end(response.body);
  console.log(`[mirror] FROZEN ${requestUrl.pathname} ${response.body.length}b ${response.label}`);
  return true;
}

async function serveLauncherApi(req, res) {
  const url = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  if (!url.pathname.startsWith("/launcher/api/")) return false;

  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJsonResponse(res, 403, { error: "Launcher API is restricted to loopback requests." });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/launcher/api/health") {
    const combatReadiness = combatHandler.getReadiness();
    sendJsonResponse(res, 200, {
      ok: !REQUIRE_COMBAT_HOST || combatReadiness.ready,
      port: PORT,
      httpPort: HTTP_MIRROR_PORT,
      serverInfoMode,
      combatHost: combatReadiness,
      androidClient: {
        payloadId: ANDROID_CLIENT_PAYLOAD_STATE ? ANDROID_CLIENT_PAYLOAD_STATE.manifest.id : "",
        patchVersion: ANDROID_CLIENT_PAYLOAD_STATE ? ANDROID_CLIENT_PAYLOAD_STATE.manifest.patchVersion : "",
        cdn: ANDROID_CLIENT_CDN_BASE_URL,
      },
      userManagerPath: userManager ? userManager.basePath : "",
      serverTime: serverTime.getSummary(),
    });
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/launcher/api/server-info-mode") {
    const requestedMode = url.searchParams.get("mode");
    if (requestedMode != null) {
      const normalizedMode = normalizeServerInfoMode(requestedMode);
      if (normalizedMode !== String(requestedMode).trim().toLowerCase()) {
        sendJsonResponse(res, 400, { ok: false, error: "mode must be revivalside or official" });
        return true;
      }
      serverInfoMode = normalizedMode;
      console.log(`[server-info] mode=${serverInfoMode}`);
    }
    sendJsonResponse(res, 200, { ok: true, serverInfoMode });
    return true;
  }

  if ((req.method === "POST" || req.method === "GET") && url.pathname === "/launcher/api/warmup") {
    sendJsonResponse(res, 200, warmLauncherRuntime());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/launcher/api/official-profile/sources") {
    sendJsonResponse(res, 200, { ok: true, sources: listOfficialProfileImportSources() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/launcher/api/official-profile/import-latest") {
    const body = await readJsonRequestBody(req);
    try {
      const imported = importLatestOfficialProfile(body || {});
      sendJsonResponse(res, 200, {
        ok: true,
        userUid: imported.user && imported.user.userUid,
        friendCode: imported.user && imported.user.friendCode,
        nickname: imported.user && imported.user.nickname,
        switched: imported.switched,
        source: imported.source,
        counts: imported.counts,
        packetType: imported.packetType,
        summary: imported.summary,
      });
    } catch (err) {
      sendJsonResponse(res, 500, { ok: false, error: summarizeErrorLine(err) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/launcher/api/server-time") {
    sendJsonResponse(res, 200, serverTime.getSummary());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/launcher/api/server-time") {
    const body = await readJsonRequestBody(req);
    const iso = body && (body.iso || body.serverTime || body.time);
    const current = serverTime.setManualTime(iso);
    sendJsonResponse(res, 200, { ok: true, currentIso: current.toISOString(), serverTime: serverTime.getSummary() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/launcher/api/server-time/clear") {
    const current = serverTime.clearManualTime();
    sendJsonResponse(res, 200, { ok: true, currentIso: current.toISOString(), serverTime: serverTime.getSummary() });
    return true;
  }

  sendJsonResponse(res, 404, { error: "Unknown launcher API route." });
  return true;
}

function sendJsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(body || {})}\n`);
}

function warmLauncherRuntime() {
  const startedAt = Date.now();
  const users = getJoinLobbyWarmupUsers();
  const warmed = [];
  const failed = [];

  for (const user of users) {
    const userUid = String((user && user.userUid) || "(ephemeral)");
    try {
      const preparedUser = ensureUserDefaults(user);
      const cachedPayload = takePrewarmedJoinLobbyAckPayload(preparedUser, { consume: false });
      if (cachedPayload) {
        warmed.push({ userUid, bytes: cachedPayload.length });
        continue;
      }
      prepareTutorialLogin(preparedUser);
      prepareUserLobbySession(preparedUser, { source: "launcher-warmup", force: true });
      const payload = prewarmJoinLobbyAckPayload(preparedUser, { source: "launcher-warmup" });
      warmed.push({
        userUid,
        bytes: Buffer.isBuffer(payload) ? payload.length : 0,
      });
    } catch (error) {
      failed.push({
        userUid,
        error: summarizeErrorLine(error && error.stack ? error.stack : error),
      });
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[launcher-warmup] joinLobby warmed=${warmed.length} failed=${failed.length} cache=${joinLobbyAckPayloadCache.size} durationMs=${durationMs}`
  );

  return {
    ok: failed.length === 0,
    joinLobbyAck: {
      warmed: warmed.length,
      failed: failed.length,
      cacheEntries: joinLobbyAckPayloadCache.size,
      durationMs,
      users: warmed,
      errors: failed,
    },
  };
}

function createOfficialProfileImporterForRuntime() {
  return createOfficialProfileImporter({
    rootDir: ROOT_DIR,
    captureDir: CAPTURED_GAME_FLOW_DIR,
    userDb,
    combatHandler,
    ensureUserDefaults,
    makeAccessToken,
    makeToken,
  });
}

function listOfficialProfileImportSources() {
  return createOfficialProfileImporterForRuntime().listSources();
}

function importLatestOfficialProfile(options = {}) {
  const importer = createOfficialProfileImporterForRuntime();
  const imported = importer.importLatest({
    switchActive: options.switchActive !== false,
    updateExisting: options.updateExisting !== false,
    preserveOfficialUid: options.preserveOfficialUid === true,
    preserveOfficialFriendCode: options.preserveOfficialFriendCode === true,
    nicknameSuffix: typeof options.nicknameSuffix === "string" ? options.nicknameSuffix : undefined,
  });
  normalizeUserDb(userDb);
  saveUserDb();
  invalidateJoinLobbyAckPayloadCache("official-profile-import");
  console.log(
    `[official-profile-import] imported uid=${imported.user && imported.user.userUid} nickname=${JSON.stringify(
      (imported.user && imported.user.nickname) || ""
    )} switched=${imported.switched ? 1 : 0}`
  );
  return imported;
}

function getJoinLobbyWarmupUsers() {
  const maxUsers = clampInt(process.env.CS_LAUNCHER_WARMUP_JOIN_LOBBY_USERS, 1, 16, 1);
  const selected = [];
  const seen = new Set();
  const addUser = (user) => {
    if (!user || typeof user !== "object") return;
    const key = String(user.userUid || user.accessToken || selected.length);
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(user);
  };

  if (userDb.activeUserUid && userDb.users[userDb.activeUserUid]) addUser(userDb.users[userDb.activeUserUid]);

  Object.values(userDb.users || {})
    .filter((user) => user && typeof user === "object")
    .sort(compareWarmupUsers)
    .forEach(addUser);

  if (selected.length === 0) addUser(createEphemeralUser());
  return selected.slice(0, maxUsers);
}

function compareWarmupUsers(left, right) {
  const leftTime = getWarmupUserTime(left);
  const rightTime = getWarmupUserTime(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(left && left.userUid ? left.userUid : "").localeCompare(String(right && right.userUid ? right.userUid : ""));
}

function getWarmupUserTime(user) {
  for (const field of ["lastJoinAt", "lastLoginAt", "lastTokenIssuedAt", "createdAt"]) {
    const value = user && user[field] ? Date.parse(user[field]) : 0;
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function prepareUserLobbySession(user, options = {}) {
  const result = {
    skipped: false,
    changed: false,
    rewardPosts: 0,
    attendancePosts: 0,
    loginMissionChanged: false,
  };
  if (!USE_LOCAL_USER_DB || !user || typeof user !== "object") return result;

  const source = String(options.source || "join-lobby");
  const nowDate = options.now instanceof Date ? options.now : getServerNowDate();
  const missionClock =
    options.missionClock && typeof options.missionClock === "object" ? options.missionClock : getMissionClockOptions();
  const cacheKey = getLobbyPreparationCacheKey(user);
  const stateKey = getLobbyPreparationStateKey(nowDate, missionClock);
  const previous = cacheKey ? lobbySessionPreparationCache.get(cacheKey) : null;
  const ttlMs = clampInt(process.env.CS_LOBBY_SESSION_PREP_TTL_MS, 1000, 600000, 300000);

  if (
    options.force !== true &&
    previous &&
    previous.stateKey === stateKey &&
    Date.now() - Number(previous.preparedAtMs || 0) <= ttlMs
  ) {
    result.skipped = true;
    return result;
  }

  try {
    result.loginMissionChanged = recordMissionLogin ? recordMissionLogin(user, missionClock) : false;
  } catch (error) {
    console.log(`[mission-login] skipped ${source} update: ${error && error.message ? error.message : error}`);
  }

  const previousLastJoinAt = String(user.lastJoinAt || "");
  user.lastJoinAt = nowDate.toISOString();
  result.changed = result.changed || previousLastJoinAt !== user.lastJoinAt || result.loginMissionChanged;
  result.rewardPosts = ensureLoginRewardPosts(user, { now: nowDate });
  result.attendancePosts = ensureAttendanceRewardPosts(user, { now: nowDate, clockNow: nowDate });

  if (result.rewardPosts > 0 || result.attendancePosts > 0) {
    console.log(
      `[user-db] queued inbox rewards uid=${user.userUid || "(ephemeral)"} loginPosts=${result.rewardPosts} attendancePosts=${result.attendancePosts}`
    );
  }
  if (result.loginMissionChanged) {
    console.log(`[user-db] login missions updated uid=${user.userUid || "(ephemeral)"} day=${String(missionClock.eventDateKey || "")}`);
  }

  if (cacheKey) {
    lobbySessionPreparationCache.set(cacheKey, {
      stateKey,
      preparedAtMs: Date.now(),
      source,
    });
  }

  if (options.save !== false) saveUserDb();
  return result;
}

function getLobbyPreparationCacheKey(user) {
  if (!user || typeof user !== "object") return "";
  return String(user.userUid || user.accessToken || user.reconnectKey || "ephemeral");
}

function getLobbyPreparationStateKey(nowDate, missionClock) {
  const serverDate = nowDate instanceof Date && !Number.isNaN(nowDate.getTime()) ? nowDate.toISOString().slice(0, 10) : "";
  const eventDate = missionClock && missionClock.eventDateKey ? String(missionClock.eventDateKey) : "";
  return `${serverDate}:${eventDate}`;
}

function prewarmJoinLobbyAckPayload(user, options = {}) {
  const startedAt = Date.now();
  const payload = buildJoinLobbyAckPayload(ensureUserDefaults(user));
  rememberPrewarmedJoinLobbyAckPayload(user, payload, options.source || "login");
  const durationMs = Date.now() - startedAt;
  if (durationMs >= Number(options.logThresholdMs || 250)) {
    console.log(
      `[JOIN_LOBBY_ACK warm-cache] source=${options.source || "login"} uid=${
        user && user.userUid ? user.userUid : "(ephemeral)"
      } bytes=${Buffer.isBuffer(payload) ? payload.length : 0} durationMs=${durationMs}`
    );
  }
  return payload;
}

function rememberPrewarmedJoinLobbyAckPayload(user, payload, source = "warmup") {
  if (!user || typeof user !== "object" || !Buffer.isBuffer(payload)) return false;
  const cacheKey = getLobbyPreparationCacheKey(user);
  if (!cacheKey) return false;
  if (prewarmedJoinLobbyAckPayloads.size >= 16) {
    const oldestKey = prewarmedJoinLobbyAckPayloads.keys().next().value;
    if (oldestKey) prewarmedJoinLobbyAckPayloads.delete(oldestKey);
  }
  prewarmedJoinLobbyAckPayloads.set(cacheKey, {
    payload,
    source,
    preparedAtMs: Date.now(),
    stateKey: getLobbyPreparationStateKey(getServerNowDate(), getMissionClockOptions()),
    userDbRevision,
  });
  return true;
}

function takePrewarmedJoinLobbyAckPayload(user, options = {}) {
  const cacheKey = getLobbyPreparationCacheKey(user);
  if (!cacheKey) return null;
  const entry = prewarmedJoinLobbyAckPayloads.get(cacheKey);
  if (!entry || !Buffer.isBuffer(entry.payload)) return null;
  // A clean Android install can spend hours downloading the client payload after
  // the launcher warmup. The entry is single-use, so keeping it for that install
  // window avoids rebuilding the large lobby ACK without leaving reusable state.
  const ttlMs = clampInt(process.env.CS_PREWARMED_JOIN_LOBBY_ACK_TTL_MS, 1000, 86400000, 14400000);
  const stateKey = getLobbyPreparationStateKey(getServerNowDate(), getMissionClockOptions());
  if (
    entry.stateKey !== stateKey ||
    Number(entry.userDbRevision) !== userDbRevision ||
    Date.now() - Number(entry.preparedAtMs || 0) > ttlMs
  ) {
    prewarmedJoinLobbyAckPayloads.delete(cacheKey);
    return null;
  }
  if (options.consume === true) prewarmedJoinLobbyAckPayloads.delete(cacheKey);
  console.log(
    `[JOIN_LOBBY_ACK prewarm] hit source=${entry.source || "warmup"} uid=${
      user && user.userUid ? user.userUid : "(ephemeral)"
    } bytes=${entry.payload.length}`
  );
  return entry.payload;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function readJsonRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function isLoopbackAddress(remoteAddress) {
  const remote = String(remoteAddress || "");
  return (
    remote === "::1" ||
    remote === "127.0.0.1" ||
    remote === "::ffff:127.0.0.1" ||
    /^127\./.test(remote) ||
    /^::ffff:127\./.test(remote)
  );
}

function serveEventManagerDiagnostics(req, res) {
  const url = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  if (url.pathname !== "/event-manager" && url.pathname !== "/event-manager/diagnostics") return false;

  const date = url.searchParams.get("date") || "";
  const diagnosticsDate = date || getServerNowDate();
  const limit = Number(url.searchParams.get("limit") || 50) || 50;
  const hasOverrides =
    url.searchParams.has("date") ||
    url.searchParams.has("scan") ||
    url.searchParams.has("roots") ||
    url.searchParams.has("manager") ||
    url.searchParams.has("packaged");
  const manager = hasOverrides ? createEventDiagnosticsManager(url) : runtimeEventManager;
  const diagnostics = manager.getDiagnostics(diagnosticsDate, { limit });
  const format = String(url.searchParams.get("format") || "json").toLowerCase();

  if (format === "text") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(manager.formatDiagnostics(diagnosticsDate, { limit }));
    return true;
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(diagnostics, null, 2)}\n`);
  return true;
}

function createEventDiagnosticsManager(url) {
  const env = { ...process.env };
  if (url.searchParams.has("scan")) env.CS_EVENT_TABLE_SCAN = url.searchParams.get("scan") || "";
  if (url.searchParams.has("roots")) env.CS_EVENT_TABLE_ROOTS = url.searchParams.get("roots") || "";
  if (url.searchParams.has("manager")) env.CS_EVENT_MANAGER = url.searchParams.get("manager") || "";
  if (url.searchParams.get("packaged") === "1" || url.searchParams.get("packaged") === "true") {
    env.CS_EVENT_TABLE_ROOTS = "gameplay-jsons/Assetbundles";
  }
  return createEventManager({ rootDir: ROOT_DIR, env });
}

function processReceiveBuffer(socket) {
  while (socket.recvBuffer.length >= 12) {
    const headOffset = socket.recvBuffer.indexOf(Buffer.from([0xdd, 0xcc, 0xbb, 0xaa]));
    if (headOffset < 0) {
      console.log(`[!] Dropping ${socket.recvBuffer.length} bytes without packet fence`);
      socket.recvBuffer = Buffer.alloc(0);
      return;
    }

    if (headOffset > 0) {
      console.log(`[!] Dropping ${headOffset} leading bytes before packet fence`);
      socket.recvBuffer = socket.recvBuffer.subarray(headOffset);
    }

    if (socket.recvBuffer.length < 8) {
      return;
    }

    const totalLength = socket.recvBuffer.readInt32LE(4);
    if (totalLength <= 12) {
      console.log(`[!] Invalid packet length ${totalLength}; closing socket`);
      socket.destroy();
      return;
    }

    if (socket.recvBuffer.length < totalLength) {
      return;
    }

    const raw = socket.recvBuffer.subarray(0, totalLength);
    socket.recvBuffer = socket.recvBuffer.subarray(totalLength);

    let parsed;
    try {
      parsed = parsePacket(raw);
    } catch (err) {
      console.log(`[!] Failed to parse packet: ${err.message}`);
      socket.destroy();
      return;
    }

    handlePacket(socket, parsed);
  }
}

function handlePacket(socket, packet) {
  console.log(
    `[RECV] packetId=${packet.packetId} sequence=${packet.sequence} compressed=${packet.compressed ? 1 : 0} payloadSize=${packet.payloadSize}`
  );
  if (DEBUG_HEX) printHex(packet.raw);

  const handler = packetHandlers.get(packet.packetId);
  if (handler) {
    try {
      const handled = handler.handle(createPacketContext(), socket, packet);
      if (handled !== false) return;
    } catch (err) {
      console.log(`[handler:${handler.name || packet.packetId}] failed: ${err.stack || err.message}`);
      socket.destroy();
      return;
    }
  }

  if (handleFallbackPacket(createPacketContext(), socket, packet)) {
    return;
  }
}

function handleFallbackPacket(ctx, socket, packet) {
  if (!isProtectedAccountProtocolPacket(packet && packet.packetId)) {
    console.log(
      `[common-fail] unsupported request packetId=${packet.packetId} sequence=${packet.sequence} payloadSize=${packet.payloadSize}; errorCode=20136`
    );
    ctx.sendGameResponse(socket, packet, COMMON_FAIL_ACK, buildCommonFailAckPayload(), "common-fail");
    return true;
  }
  console.log(
    `[official-missing] protected Account packetId=${packet.packetId} sequence=${packet.sequence} payloadSize=${packet.payloadSize}; no response sent`
  );
  return true;
}

function buildCommonFailAckPayload(errorCode = 20136) {
  return writeSignedVarInt(errorCode);
}

function isProtectedAccountProtocolPacket(packetId) {
  const id = Number(packetId);
  return Number.isInteger(id) && id >= 200 && id <= 254;
}

function sendResponse(socket, sequence, packetId, builder) {
  const response = builder();
  socket.write(response);
  const parsed = parsePacket(response);
  console.log(
    `[SEND] packetId=${packetId} sequence=${sequence} compressed=${parsed.compressed ? 1 : 0} payloadSize=${parsed.payloadSize}`
  );
  if (DEBUG_HEX) printHex(response);
  const replay = socket && socket.session && socket.session.gameReplay;
  if (replay) replay.nextServerSequence = Math.max(Number(replay.nextServerSequence || 1), Number(sequence || 0) + 1);
}

function sendGameResponse(socket, packet, packetId, payload, label) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (replay && replay.inGameFlow) {
    sendServerGamePacket(socket, packetId, payload || Buffer.alloc(0), label || `packet-${packetId}`);
    return;
  }
  const sequence = packet && typeof packet === "object" ? packet.sequence : Number(packet || 1);
  sendResponse(socket, sequence, packetId, () => buildEncryptedPacket(sequence, packetId, payload || Buffer.alloc(0)));
}

function createPacketContext() {
  return {
    privatePvp,
    pvpMatchmaking,
    leaguePvpMatchmaking,
    constants: {
      LOGIN_ACK,
      JOIN_LOBBY_REQ,
      JOIN_LOBBY_ACK,
      RECONNECT_ACK,
      CONTENTS_VERSION_ACK,
      GAMEBASE_LOGIN_ACK,
      HEART_BIT_ACK,
      CONNECT_CHECK_ACK,
      SERVER_TIME_ACK,
      COMMON_FAIL_ACK,
      GAME_LOAD_ACK,
      GAME_LOAD_COMPLETE_ACK,
      GAME_START_NOT,
      GAME_END_NOT,
      GAME_PAUSE_ACK,
      GAME_CHECK_DIE_UNIT_ACK,
      GAME_RESPAWN_ACK,
      GAME_SHIP_SKILL_REQ,
      GAME_SHIP_SKILL_ACK,
      GAME_GIVEUP_REQ,
      GAME_GIVEUP_ACK,
      GAME_USE_UNIT_SKILL_REQ,
      GAME_USE_UNIT_SKILL_ACK,
      GAME_EMOTICON_ACK,
      GAME_EMOTICON_NOT,
      GAME_UNIT_RETREAT_ACK,
      GAME_TACTICAL_COMMAND_ACK,
      GAME_RESTART_ACK,
      GAME_SURRENDER_ACK,
      GAME_SURRENDER_NOT,
      MISSION_COMPLETE_REQ,
      MISSION_COMPLETE_ACK,
      CUTSCENE_DUNGEON_START_ACK,
      CUTSCENE_DUNGEON_CLEAR_ACK,
      FRIEND_LIST_ACK,
      GREETING_MESSAGE_ACK,
      EMOTICON_DATA_REQ,
      EMOTICON_DATA_ACK,
      EQUIP_PRESET_LIST_ACK,
      FAVORITES_STAGE_ACK,
      POST_LIST_ACK,
      FIERCE_SEASON_NOT,
      DEFENCE_INFO_ACK,
      NPT_GAME_SYNC_DATA_PACK_NOT,
    },
    config: {
      USE_LOCAL_USER_DB,
      REPLAY_CAPTURED_CONTENTS_VERSION,
      REPLAY_CAPTURED_LOGIN_ACK,
      LOCK_CONTENTS_VERSION,
      REPLAY_CAPTURED_GAME_FLOW,
      DYNAMIC_BATTLE_MANAGER,
      DYNAMIC_BATTLE_SYNC_INTERVAL_MS,
      MANAGED_HOST_TICK_INTERVAL_MS,
      MANAGED_HOST_PRIME_FRAMES,
      DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
      OFFICIAL_COMBAT_REPLAY,
      VERBOSE_CAPTURE_LOGS,
      SKIP_TUTORIAL_CUTSCENE,
      SKIP_TUTORIAL_TO_WIN,
      RESET_LOCAL_PROGRESS_ON_LOGIN,
      RESET_TUTORIAL_PROGRESS_ON_LOGIN,
      RESET_CAMPAIGN_PROGRESS_ON_LOGIN,
      CLEAR_ALL_MISSIONS_STATUS,
      CLEAR_UNITS_LEVEL1,
      CLEAR_GEAR_UNENHANCED,
      CLEAR_SHIPS_LEVEL1,
      CLEAR_OPERATORS_LEVEL1,
      USE_LOCAL_JOIN_LOBBY_ACK,
      LOCAL_JOIN_LOBBY_ACK_MODE,
      SEND_FIERCE_SEASON_BOOTSTRAP,
      CONTENTS_VERSION,
      REQUIRED_CONTENTS_TAGS,
      CONTENTS_TAGS,
      EVENT_MANAGER_CONFIG: eventManager.config,
    },
    capturedTcpResponses,
    capturedTcpProfiles,
    capturedGameFlow,
    userDb,
    serverTime,
    eventManager: runtimeEventManager,
    setServerTime(date) {
      return serverTime && typeof serverTime.setManualTime === "function" ? serverTime.setManualTime(date) : null;
    },
    clearServerTime() {
      return serverTime && typeof serverTime.clearManualTime === "function" ? serverTime.clearManualTime() : null;
    },
    setLastAckContents(version, tags) {
      lastAckContentsVersion = version || "";
      lastAckContentsTags = Array.isArray(tags) ? tags.slice() : [];
    },
    setLastEffectiveAccessToken(token) {
      lastEffectiveAccessToken = token || "";
    },
    sendResponse,
    sendGameResponse,
    sendCapturedGameThrough,
    sendCapturedGameExact,
    sendCapturedGameTemplateRange,
    sendCapturedGamePacketIdOnly,
    sendCapturedGameThroughPacketId,
    sendCapturedGameUntilBeforePacketIds,
    skipCapturedGameThroughPacketId,
    skipCapturedGameUntilBeforePacketIds,
    sendCapturedHeartbeatReply,
    isTutorialCapturedBootstrapActive,
    peekCapturedTutorialPacketId,
    sendCapturedTutorialGameLoadAck,
    sendCapturedTutorialLoadCompleteBootstrap,
    sendCapturedTutorialHeartbeatReply,
    sendCapturedTutorialThroughPacketId,
    sendCapturedTutorialUntilBeforePacketIds,
    maybeTransitionTutorialReplayToDynamic,
    peekCapturedGamePacketId,
    sendServerGamePacket,
    findClientSocketByUserUid(userUid) {
      const target = String(userUid || "");
      return [...activeClientSockets].find((clientSocket) =>
        clientSocket && !clientSocket.destroyed && clientSocket.session && clientSocket.session.user &&
        String(clientSocket.session.user.userUid || "") === target
      ) || null;
    },
    buildDynamicGameLoadPayload,
    sendDynamicGameLoadAck,
    startDynamicBattleManager,
    handleDynamicBattleRespawn,
    handleDynamicBattlePause,
    handleDynamicBattleUnitSkill,
    handleDynamicBattleShipSkill,
    handleDynamicBattleCheckDie,
    handleDynamicBattleUnitRetreat,
    handleDynamicBattleTacticalCommand,
    startPrivatePvpMatch,
    startStandardPvpMatch,
    startLeaguePvpMatch,
    startEventPvpMatch,
    cancelEventPvpMatch,
    exitEventPvpMatch,
    startAsyncPvpBattle,
    buildSimulatedPvpTestResult,
    finishAsyncPvpSimulation,
    finishPrivatePvpGiveup,
    resetPrivatePvpMatch,
    applyCombatControls,
    sendManagedOrImmediatePacket,
    sendManagedOrImmediatePackets,
    sendPendingGameStartSync,
    startOfficialCombatReplay,
    startSyntheticGameSync,
    scheduleCapturedGameAutoAdvance,
    logCapturedClientPacketMatch,
    maybeSendTutorialCutsceneClear,
    logGameLoadReq,
    decodeGameLoadReq,
    validateGameLoadRewardMultiply,
    getGameLoadStageAuthorityDescriptor,
    validatePlayerDeckForGameLoad,
    preparePhaseGameLoad,
    decodeGameRespawnReq,
    decodeGameUnitSkillReq,
    decodeGameShipSkillReq,
    buildGameLoadAck,
    getCapturedServerPayloadTemplate,
    buildRespawnAck,
    buildGameSync,
    buildGameSyncPackets,
    buildInitialBattleSync,
    buildInitialBattlePackets,
    buildIntrudeStartPackets: (...args) => combatHandler.buildIntrudeStartPackets(...args),
    ensureGameStartPackets,
    deployStageLineup,
    buildGameRespawnAckPayload,
    buildGamePauseAckPayload,
    buildGameLoadCompleteAckPayload,
    buildDynamicGameEndNotPayload,
    buildAsyncPvpGameEndNotPayload: asyncPvp.buildAsyncPvpGameEndNotPayload,
    buildStandardPvpGameEndNotPayloadForSocket,
    buildBattleGameRecordData,
    markStandardPvpMatchFinished,
    sendDynamicFinishStateSync,
    maybeRecordDynamicBattleClear,
    sendRaidStateDataForSocket,
    stopGameSyncTimers,
    abandonDynamicBattle,
    buildFramedPacket,
    buildEncryptedPacket,
    buildContentsVersionAck,
    buildCapturedLoginAck,
    buildCapturedGamebaseLoginAck,
    buildCapturedReconnectAck,
    buildLoginAck,
    buildLoginLikePayload,
    getEffectiveOpenTags,
    buildJoinLobbyAckPayload,
    buildMinimalJoinLobbyPayload,
    extractNullableGameDataFromGameLoadAckPayload,
    invalidateJoinLobbyAckPayloadCache,
    prepareUserLobbySession,
    prewarmJoinLobbyAckPayload,
    rememberPrewarmedJoinLobbyAckPayload,
    takePrewarmedJoinLobbyAckPayload,
    hasTutorialProgress,
    shouldUseLocalJoinLobbyAck,
    ensureTutorialCompletionProgress,
    resetLocalProgressForUser,
    resetTutorialProgressForUser,
    resetCampaignProgressForUser,
    prepareTutorialLogin,
    skipStaleTutorialGameLoadReplay,
    decodeMissionCompleteReq,
    buildMissionCompleteAckPayload,
    recordMissionLogin,
    refreshMissionProgress,
    trackMissionEvent,
    refreshTimedStamina,
    sendStaminaChargeNotifications,
    buildEmoticonDataAckPayload,
    buildFriendListAckPayload,
    buildGreetingMessageAckPayload,
    buildFavoritesStageAckPayload,
    buildDefenceInfoAckPayload,
    buildPhaseStartAckPayload,
    buildTrimStartAckPayload,
    buildFierceDataAckPayload,
    buildFiercePenaltyAckPayload,
    buildFierceProfileAckPayload,
    buildFierceRankRewardAckPayload,
    buildFiercePointRewardAckPayload,
    buildFiercePointRewardAllAckPayload,
    buildLeaderboardFierceListAckPayload,
    buildLeaderboardFierceBossGroupListAckPayload,
    buildFierceSeasonNotPayload,
    getCurrentFierceSeasonId,
    buildDefenceGameStartAckPayload,
    buildExploreInfoAckPayload,
    buildExploreEnterAckPayload,
    extractNullableGameDataFromGameLoadAckPayload,
    recordMissionComplete,
    buildCutsceneDungeonStartAckPayload,
    buildCutsceneDungeonClearAckPayload,
    isValidCutsceneDungeonId,
    commitCutsceneDungeonClear,
    resolveCutsceneDungeonId,
    resolveCutsceneClearDungeonId,
    recordTutorialCutsceneClear,
    recordMainStoryDungeonClear,
    recordEpisode1DungeonClear: recordMainStoryDungeonClear,
    recordPersistentCutsceneView,
    recordGameplayUnlockClear,
    decodeSteamLoginReq,
    decodeJoinLobbyReq,
    getGenericStageForRequest,
    recordGenericDungeonClear,
    buildDungeonSkipAckPayload,
    sendTrackedMissionUpdate,
    sendMissionUpdateForTabs,
    sendStageClearMissionUpdate,
    repairPostTutorialGuideMissionsForSocket,
    readCutsceneDungeonReq,
    decryptCopy,
    safeReadString,
    safeReadSignedVarLong,
    writeSignedVarInt,
    writeSignedVarLong,
    writeInt64LE,
    dateTimeBinaryNow,
    dateTimeTicksNow,
    getServerNowDate,
    getServerEventDateKey,
    getMissionClockOptions,
    getEffectiveContentsTags,
    getRequiredContentsTags,
    getOrCreateUserForSteam,
    getOrCreateUserForGuest,
    issueUserTokens,
    saveUserDb,
    findUserByAccessToken,
    findUserByReconnectKey,
    createEphemeralUser,
  };
}

function createGameReplayState() {
  return {
    inGameFlow: false,
    localJoinLobbyAckSent: false,
    bootLobbyTemplateSent: false,
    bootPostListTemplateSent: false,
    friendListCount: 0,
    pauseCount: 0,
    pendingPauseCount: 0,
    heartbeatCount: 0,
    loadCompleteReceived: false,
    pendingGameStartBootstrap: false,
    lastSceneId: 0,
    postTutorialGuideMissionCompleteAckSent: false,
    firstPostLoadHeartbeatSyncSent: false,
    nextServerIndex: 1,
    nextServerSequence: 1,
    autoAdvanceTimer: null,
    syntheticSyncTimer: null,
    syntheticSyncCount: 0,
    officialCombatReplayTimer: null,
    officialCombatReplayCursor: 0,
    officialCombatReplayCount: 0,
    officialCaptureExhaustedLogged: false,
    syntheticGameTime: 0,
    lastRespawnReq: null,
    dynamicBattleTimer: null,
    dynamicBattlePaused: false,
    dynamicBattleResultSent: false,
    gameSpeedType: null,
    autoSkillType: null,
    autoRespawnEnabled: null,
    tutorialReplayPhase: "",
  };
}

function scheduleCapturedGameAutoAdvance(socket) {
  if (!REPLAY_CAPTURED_GAME_AUTO_ADVANCE) return;
  const replay = socket.session.gameReplay;
  if (replay.autoAdvanceTimer) {
    clearTimeout(replay.autoAdvanceTimer);
    replay.autoAdvanceTimer = null;
  }
  console.log("[capture-game:auto-advance] disabled; delayed packet replay has been removed");
}

function sendCapturedGameThrough(socket, endIndex, label) {
  const replay = socket.session.gameReplay;
  sendCapturedGameRange(socket, replay.nextServerIndex, endIndex, label);
}

function sendCapturedGameExact(socket, index, label) {
  const replay = socket.session.gameReplay;
  const entry = capturedGameFlow.server[index - 1];
  if (!entry || !entry.raw) {
    console.log(`[capture-game] missing server packet index=${index} label=${label}`);
    return;
  }
  sendCapturedGameEntry(socket, entry, index, label);
  replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
}

function sendCapturedGameTemplateRange(socket, startIndex, endIndex, label, options = {}) {
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return 0;
  const quietRange = !VERBOSE_CAPTURE_LOGS && endIndex > startIndex;
  let sentCount = 0;
  if (quietRange) {
    console.log(`[capture-game:${label}] SEND template range=${startIndex}-${endIndex}`);
  }
  withSocketPacketBurst(socket, () => {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const entry = capturedGameTemplateFlow.server[index - 1];
      if (!entry || !entry.raw) {
        console.log(`[capture-game] missing template server packet index=${index} label=${label}`);
        continue;
      }
      sendCapturedGameEntry(socket, entry, index, label, {
        quiet: quietRange,
        forceReframe: options.forceReframe !== false,
      });
      sentCount += 1;
    }
  });
  if (quietRange) {
    console.log(`[capture-game:${label}] sent=${sentCount}`);
  }
  return sentCount;
}

function sendCapturedGameTemplateRangeAndAdvance(socket, startIndex, endIndex, label, options = {}) {
  const replay = socket.session.gameReplay;
  if (endIndex < startIndex) return false;
  const sentCount = sendCapturedGameTemplateRange(socket, startIndex, endIndex, label, options);
  if (sentCount > 0) {
    replay.nextServerIndex = Math.max(replay.nextServerIndex || 1, endIndex + 1);
    return true;
  }
  return false;
}

function sendCapturedTutorialGameLoadAck(socket, label) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay || !isTutorialCapturedBootstrapActive(socket)) return false;
  const current = Math.max(1, replay.nextServerIndex || 1);
  const index =
    findCapturedTemplateServerIndexFrom(current, (entry) => entry.packetId === GAME_LOAD_ACK) ||
    findCapturedTemplateServerIndexFrom(1, (entry) => entry.packetId === GAME_LOAD_ACK);
  if (!index) return false;
  const entry = getCapturedTemplateServerEntry(index);
  if (!entry || !entry.raw) return false;
  sendCapturedGameEntry(socket, entry, index, label || "captured-tutorial-game-load", { forceReframe: false });
  replay.nextServerIndex = Math.max(current, index + 1);
  console.log(`[capture-game:${label || "tutorial-game-load"}] using captured tutorial timeline from serverIndex=${replay.nextServerIndex}`);
  return true;
}

function sendCapturedTutorialLoadCompleteBootstrap(socket, label) {
  if (!isTutorialCapturedBootstrapActive(socket)) return false;
  const replay = socket.session.gameReplay;
  const startIndex = findNextCapturedTemplateServerIndex(socket, (entry) => entry.packetId === GAME_LOAD_COMPLETE_ACK);
  if (!startIndex) {
    console.log(
      `[official-missing] no captured tutorial GAME_LOAD_COMPLETE_ACK from index=${replay.nextServerIndex}; no response sent`
    );
    return false;
  }
  const stopIndex = findCapturedTemplateServerIndexFrom(startIndex + 1, (entry) => entry.packetId === HEART_BIT_ACK);
  const endIndex = stopIndex ? stopIndex - 1 : startIndex;
  return sendCapturedGameTemplateRangeAndAdvance(socket, startIndex, endIndex, label || "tutorial-load-complete", {
    forceReframe: false,
  });
}

function sendCapturedTutorialHeartbeatReply(socket, time, label) {
  if (!isTutorialCapturedBootstrapActive(socket)) return false;
  const replay = socket.session.gameReplay;
  const next = getCapturedTemplateServerEntry(replay.nextServerIndex || 1);
  if (next && next.packetId === HEART_BIT_ACK) {
    sendCapturedTutorialThroughPacketId(socket, HEART_BIT_ACK, label || "heart-bit");
  } else if (next) {
    console.log(
      `[capture-game:${label || "heart-bit"}] expected captured tutorial HEART_BIT_ACK at index=${replay.nextServerIndex}, nextPacketId=${next.packetId}; using live ACK only`
    );
    sendServerGamePacket(socket, HEART_BIT_ACK, writeSignedVarLong(time), label || "heart-bit");
  } else {
    sendServerGamePacket(socket, HEART_BIT_ACK, writeSignedVarLong(time), label || "heart-bit");
  }

  const stopPacketIds =
    replay.nextServerIndex >= TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX - 8
      ? [HEART_BIT_ACK, GAME_PAUSE_ACK, GAME_RESPAWN_ACK, GAME_END_NOT]
      : [HEART_BIT_ACK, GAME_PAUSE_ACK, GAME_RESPAWN_ACK];
  sendCapturedTutorialUntilBeforePacketIds(socket, stopPacketIds, `${label || "heart-bit"}-post-sync`);
  maybeTransitionTutorialReplayToDynamic(socket, label || "heart-bit");
  return true;
}

function sendCapturedTutorialThroughPacketId(socket, packetId, label) {
  if (!isTutorialCapturedBootstrapActive(socket)) return false;
  const replay = socket.session.gameReplay;
  const index = findNextCapturedTemplateServerIndex(socket, (entry) => entry.packetId === packetId);
  if (!index) {
    console.log(
      `[official-missing] no captured tutorial server packetId=${packetId} from index=${replay.nextServerIndex} label=${label}; no response sent`
    );
    return false;
  }
  return sendCapturedGameTemplateRangeAndAdvance(socket, replay.nextServerIndex || 1, index, label || "tutorial-captured", {
    forceReframe: false,
  });
}

function sendCapturedTutorialUntilBeforePacketIds(socket, packetIds, label) {
  if (!isTutorialCapturedBootstrapActive(socket)) return false;
  const replay = socket.session.gameReplay;
  const stops = new Set(packetIds);
  const stopIndex = findNextCapturedTemplateServerIndex(socket, (entry) => stops.has(entry.packetId));
  const endIndex = stopIndex ? stopIndex - 1 : capturedGameTemplateFlow.server.length;
  if (endIndex >= (replay.nextServerIndex || 1)) {
    return sendCapturedGameTemplateRangeAndAdvance(socket, replay.nextServerIndex || 1, endIndex, label || "tutorial-sync", {
      forceReframe: false,
    });
  }
  return false;
}

function sendCapturedGamePacketIdOnly(socket, packetId, label) {
  const replay = socket.session.gameReplay;
  const index = findNextCapturedServerIndex(socket, (entry) => entry.packetId === packetId);
  if (!index) {
    console.log(`[official-missing] no captured server packetId=${packetId} label=${label}; no response sent`);
    return false;
  }
  sendCapturedGameEntry(socket, capturedGameFlow.server[index - 1], index, label, { forceReframe: true });
  replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
  return true;
}

function sendCapturedGameThroughPacketId(socket, packetId, label) {
  const replay = socket.session.gameReplay;
  const index = findNextCapturedServerIndex(socket, (entry) => entry.packetId === packetId);
  if (!index) {
    console.log(
      `[official-missing] no captured server packetId=${packetId} from index=${replay.nextServerIndex} label=${label}; no response sent`
    );
    return false;
  }
  sendCapturedGameRange(socket, replay.nextServerIndex, index, label);
  return true;
}

function sendCapturedGameUntilBeforePacketIds(socket, packetIds, label) {
  const replay = socket.session.gameReplay;
  const stops = new Set(packetIds);
  const stopIndex = findNextCapturedServerIndex(socket, (entry) => stops.has(entry.packetId));
  const endIndex = stopIndex ? stopIndex - 1 : capturedGameFlow.server.length;
  if (endIndex >= replay.nextServerIndex) {
    sendCapturedGameRange(socket, replay.nextServerIndex, endIndex, label);
    return true;
  }
  return false;
}

function skipCapturedGameThroughPacketId(socket, packetId) {
  const replay = socket.session.gameReplay;
  const index = findNextCapturedServerIndex(socket, (entry) => entry.packetId === packetId);
  if (index) replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
  return index;
}

function skipCapturedGameUntilBeforePacketIds(socket, packetIds) {
  const replay = socket.session.gameReplay;
  const stops = new Set(packetIds);
  const stopIndex = findNextCapturedServerIndex(socket, (entry) => stops.has(entry.packetId));
  const endIndex = stopIndex ? stopIndex - 1 : capturedGameFlow.server.length;
  if (endIndex >= replay.nextServerIndex) {
    replay.nextServerIndex = endIndex + 1;
    return true;
  }
  return false;
}

function skipStaleTutorialGameLoadReplay(socket, label) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const user = socket && socket.session && socket.session.user;
  if (!replay || replay.dynamicGame || !hasTutorialCompletionMarker(user)) return false;
  if (replay.lastGameLoadReq && (isTutorialStageId(replay.lastGameLoadReq.stageID) || isTutorialDungeonId(replay.lastGameLoadReq.dungeonID))) {
    return false;
  }
  const next = capturedGameFlow && capturedGameFlow.server && capturedGameFlow.server[replay.nextServerIndex - 1];
  if (!next || next.packetId !== GAME_LOAD_ACK) return false;
  replay.nextServerIndex += 1;
  console.log(`[capture-game:${label || "tutorial"}] skipped stale tutorial GAME_LOAD_ACK because tutorial is complete`);
  return true;
}

function sendCapturedHeartbeatReply(socket, time, label) {
  const replay = socket.session.gameReplay;
  sendServerGamePacket(socket, HEART_BIT_ACK, writeSignedVarLong(time), label);

  if (DYNAMIC_BATTLE_MANAGER && replay.dynamicGame) {
    return;
  }

  const next = capturedGameFlow && capturedGameFlow.server[replay.nextServerIndex - 1];
  if (next && next.packetId === HEART_BIT_ACK) {
    replay.nextServerIndex += 1;
  } else if (next) {
    console.log(
      `[capture-game:${label}] expected captured HEART_BIT_ACK at index=${replay.nextServerIndex}, nextPacketId=${next.packetId}; using live ACK only`
    );
  }

  const stopPacketIds =
    DYNAMIC_BATTLE_MANAGER &&
    replay.dynamicGame &&
    replay.dynamicGame.tutorial &&
    replay.nextServerIndex >= TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX - 8
      ? [HEART_BIT_ACK, 813, 817, GAME_END_NOT]
      : [HEART_BIT_ACK, 813, 817];
  sendCapturedGameUntilBeforePacketIds(socket, stopPacketIds, `${label}-post-sync`);
}

function maybeTransitionTutorialReplayToDynamic(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.tutorialReplayPhase || replay.tutorialReplayPhase === "dynamic") return false;
  if (replay.nextServerIndex < TUTORIAL_DYNAMIC_HANDOFF_SERVER_INDEX) return false;
  combatHandler.transitionTutorialReplayToDynamic(replay, replay.nextServerIndex);
  console.log(
    `[tutorial-replay:${label}] handoff to dynamic sync at serverIndex=${replay.nextServerIndex} units=${
      replay.battleState ? replay.battleState.units.map((unit) => unit.gameUnitUID).join(",") : ""
    }`
  );
  startDynamicBattleManager(socket, `tutorial-${label}`);
  return true;
}

function extractGameLoadUnitPools(rawPayload) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  if (!rawPayload || rawPayload.length === 0) return pools;
  try {
    let offset = 0;
    offset = readSignedVarInt(rawPayload, offset).offset; // errorCode
    if (rawPayload.readUInt8(offset) === 0) return pools;
    offset += 1;
    const parsed = parseCapturedNkmGameDataUnitPools(rawPayload, offset);
    return parsed.pools;
  } catch (err) {
    if (DEBUG_HEX) console.log(`[dynamic-game-load] 804 unit-pool parse failed: ${err.message}`);
    return pools;
  }
}

function parseCapturedNkmGameDataUnitPools(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset; // m_GameUID
  offset = readSignedVarInt(buffer, offset).offset; // m_GameUnitUIDIndex
  offset += 1; // m_bLocal
  offset = readSignedVarInt(buffer, offset).offset; // m_NKM_GAME_TYPE
  offset = readSignedVarInt(buffer, offset).offset; // m_DungeonID
  offset += 1; // m_bBossDungeon
  offset = readSignedVarInt(buffer, offset).offset; // m_WarfareID
  offset = readSignedVarLong(buffer, offset).offset; // m_RaidUID
  offset += 4; // m_fRespawnCostMinusPercentForTeamA
  offset = readSignedVarInt(buffer, offset).offset; // m_TeamASupply
  offset += 4; // m_fTeamAAttackPowerIncRateForWarfare
  offset = skipCapturedStringList(buffer, offset); // m_lstTeamABuffStrIDListForRaid
  offset += 4; // fExtraRespawnCostAddForA
  offset += 4; // fExtraRespawnCostAddForB
  offset = readSignedVarInt(buffer, offset).offset; // m_TeamBLevelAdd
  offset = readSignedVarInt(buffer, offset).offset; // m_TeamBLevelFix
  offset += 4; // m_fDoubleCostTime
  offset = readSignedVarInt(buffer, offset).offset; // m_MapID
  offset = skipCapturedSignedIntMap(buffer, offset); // m_BattleConditionIDs

  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  const teamA = readCapturedNullableObject(buffer, offset, (inner, innerOffset) =>
    parseCapturedGameTeamUnitPools(inner, innerOffset, 1)
  );
  offset = teamA.offset;
  mergeExtractedUnitPools(pools, teamA.value);

  const teamB = readCapturedNullableObject(buffer, offset, (inner, innerOffset) =>
    parseCapturedGameTeamUnitPools(inner, innerOffset, 3)
  );
  offset = teamB.offset;
  mergeExtractedUnitPools(pools, teamB.value);
  return { pools, offset };
}

function parseCapturedGameTeamUnitPools(buffer, offset, team) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  offset = readSignedVarInt(buffer, offset).offset; // m_eNKM_TEAM_TYPE
  offset = readSignedVarLong(buffer, offset).offset; // m_LeaderUnitUID
  offset = readSignedVarInt(buffer, offset).offset; // m_UserLevel
  offset = readString(buffer, offset).offset; // m_UserNickname
  offset = readSignedVarInt(buffer, offset).offset; // m_Tier
  offset = readSignedVarInt(buffer, offset).offset; // m_Score
  offset = readSignedVarInt(buffer, offset).offset; // m_WinStreak

  const mainShip = readCapturedNullableObject(buffer, offset, parseCapturedUnitDataPool);
  offset = mainShip.offset;
  mergeExtractedUnitPools(pools, mainShip.value, team);

  offset = skipCapturedNullableObject(buffer, offset, skipCapturedOperator);
  offset = readSignedVarLong(buffer, offset).offset; // m_user_uid

  const unitLists = [
    parseCapturedUnitDataPoolList,
    parseCapturedUnitDataPoolList,
    parseCapturedUnitDataPoolList,
    parseCapturedUnitDataPoolList,
    parseCapturedDynamicRespawnUnitPoolList,
    parseCapturedUnitDataPoolList,
  ];
  for (const parser of unitLists) {
    const parsed = parser(buffer, offset, team);
    offset = parsed.offset;
    mergeExtractedUnitPools(pools, parsed.pools, team);
  }

  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedTacticalCommand);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedGameTeamDeckData);
  offset += 4; // m_fInitHP
  offset = skipCapturedObjectMapLongGeneric(buffer, offset, skipCapturedEquipItemData);
  offset = readSignedVarLong(buffer, offset).offset; // m_FriendCode
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedEmoticonPresetData);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedGuildSimpleData);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedCommonProfile);

  return { value: pools, offset };
}

function parseCapturedUnitDataPoolList(buffer, offset, team) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const parsed = readCapturedNullableObject(buffer, offset, parseCapturedUnitDataPool);
    offset = parsed.offset;
    mergeExtractedUnitPools(pools, parsed.value, team);
  }
  return { pools, offset };
}

function parseCapturedDynamicRespawnUnitPoolList(buffer, offset, team) {
  const pools = { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [] };
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const parsed = readCapturedNullableObject(buffer, offset, (inner, innerOffset) => {
      const unit = readCapturedNullableObject(inner, innerOffset, parseCapturedUnitDataPool);
      innerOffset = unit.offset;
      innerOffset = readSignedVarInt(inner, innerOffset).offset; // m_MasterGameUnitUID
      innerOffset += 2; // m_bLoadedServer, m_bLoadedClient
      return { value: unit.value, offset: innerOffset };
    });
    offset = parsed.offset;
    mergeExtractedUnitPools(pools, parsed.value, team);
  }
  return { pools, offset };
}

function parseCapturedUnitDataPool(buffer, offset) {
  const unitUID = readSignedVarLong(buffer, offset);
  offset = unitUID.offset;
  offset = readSignedVarLong(buffer, offset).offset; // m_UserUID
  const unitID = readSignedVarInt(buffer, offset);
  offset = unitID.offset;
  offset = readSignedVarInt(buffer, offset).offset; // level
  offset = readSignedVarInt(buffer, offset).offset; // exp
  offset = readSignedVarInt(buffer, offset).offset; // skin
  offset += 4; // injury
  offset = readSignedVarInt(buffer, offset).offset; // limit break
  offset += 2; // lock, summon unit
  offset = skipCapturedSignedIntList(buffer, offset); // stat EXP
  const gameUnitUIDs = readCapturedShortList(buffer, offset);
  offset = gameUnitUIDs.offset;
  offset = readCapturedShortList(buffer, offset).offset; // changed UID list
  offset = skipCapturedFloatList(buffer, offset); // near target ranges
  offset = skipCapturedSignedIntArrayOrList(buffer, offset, 5); // skill levels
  offset = skipCapturedSignedLongArrayOrList(buffer, offset, 4); // equips
  offset = readSignedVarInt(buffer, offset).offset; // loyalty
  offset += 3; // permanent contract, seized, from contract
  offset = readSignedVarInt(buffer, offset).offset; // officeRoomId
  offset += 8; // m_regDate
  offset = readSignedVarInt(buffer, offset).offset; // officeGrade
  offset += 8; // officeGaugeStartTime
  offset = readSignedVarLong(buffer, offset).offset; // m_DungeonRespawnUnitTempletUID
  offset += 1; // isFavorite
  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedShipCmdModule);
  offset = readSignedVarInt(buffer, offset).offset; // tacticLevel
  offset = readSignedVarInt(buffer, offset).offset; // reactorLevel
  return {
    value: {
      unitUID: unitUID.value.toString(),
      unitID: unitID.value,
      gameUnitUIDs: gameUnitUIDs.value,
    },
    offset,
  };
}

function mergeExtractedUnitPools(target, source, team) {
  if (!target || !source) return;
  const entries = source.ordered
    ? source.ordered
    : source.gameUnitUIDs
      ? [{ unitUID: String(source.unitUID || ""), unitID: source.unitID || 0, gameUnitUIDs: source.gameUnitUIDs }]
      : [];
  for (const entry of entries) {
    const gameUnitUIDs = (entry.gameUnitUIDs || []).map(Number).filter((value) => Number.isInteger(value) && value > 0);
    for (const uid of gameUnitUIDs) {
      if (!target.allGameUnitUIDs.includes(uid)) target.allGameUnitUIDs.push(uid);
    }
    if (!entry.unitUID || gameUnitUIDs.length === 0) continue;
    const key = String(entry.unitUID);
    if (!target.byUnitUID.has(key)) {
      target.byUnitUID.set(key, { unitUID: key, unitID: entry.unitID || 0, team, gameUnitUIDs: [], cursor: 0 });
      target.ordered.push(target.byUnitUID.get(key));
    }
    const pool = target.byUnitUID.get(key);
    for (const uid of gameUnitUIDs) {
      if (!pool.gameUnitUIDs.includes(uid)) pool.gameUnitUIDs.push(uid);
    }
  }
}

function readCapturedNullableObject(buffer, offset, parser) {
  if (buffer.readUInt8(offset) === 0) return { value: null, offset: offset + 1 };
  return parser(buffer, offset + 1);
}

function skipCapturedNullableObject(buffer, offset, skipper) {
  if (buffer.readUInt8(offset) === 0) return offset + 1;
  return skipper(buffer, offset + 1);
}

function readCapturedShortList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readSignedVarInt(buffer, offset);
    offset = item.offset;
    value.push(item.value);
  }
  return { value, offset };
}

function skipCapturedSignedIntList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedSignedIntMap(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarInt(buffer, offset).offset;
    offset = readSignedVarInt(buffer, offset).offset;
  }
  return offset;
}

function skipCapturedStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readString(buffer, offset).offset;
  return offset;
}

function skipCapturedFloatList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset + count.value * 4;
  return offset;
}

function skipCapturedSignedIntArrayOrList(buffer, offset, fallbackCount) {
  const count = readVarInt(buffer, offset);
  if (count.value <= 32 && count.offset + count.value <= buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = readSignedVarInt(buffer, next).offset;
    return next;
  }
  let next = offset;
  for (let index = 0; index < fallbackCount; index += 1) next = readSignedVarInt(buffer, next).offset;
  return next;
}

function skipCapturedSignedLongArrayOrList(buffer, offset, fallbackCount) {
  const count = readVarInt(buffer, offset);
  if (count.value <= 32 && count.offset + count.value <= buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = readSignedVarLong(buffer, next).offset;
    return next;
  }
  let next = offset;
  for (let index = 0; index < fallbackCount; index += 1) next = readSignedVarLong(buffer, next).offset;
  return next;
}

function skipCapturedOperator(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 1;
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedOperatorSkill);
  offset = skipCapturedNullableObject(buffer, offset, skipCapturedOperatorSkill);
  offset += 1;
  return offset;
}

function skipCapturedOperatorSkill(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 1;
  offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedObjectListGeneric(buffer, offset, skipper) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = skipCapturedNullableObject(buffer, offset, skipper);
  }
  return offset;
}

function skipCapturedObjectMapLongGeneric(buffer, offset, skipper) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarLong(buffer, offset).offset;
    offset = skipCapturedNullableObject(buffer, offset, skipper);
  }
  return offset;
}

function skipCapturedGameTeamDeckData(buffer, offset) {
  offset += 1; // m_DataEncryptSeed
  offset = skipCapturedSignedLongList(buffer, offset);
  offset = readSignedVarLong(buffer, offset).offset; // m_NextDeck
  offset = skipCapturedSignedLongList(buffer, offset);
  offset = skipCapturedSignedLongList(buffer, offset);
  offset = readSignedVarInt(buffer, offset).offset; // m_AutoRespawnIndex
  offset = readSignedVarInt(buffer, offset).offset; // m_AutoRespawnIndexAssist
  offset = skipCapturedLongIntMap(buffer, offset); // m_dicRespawnLimitCount
  return offset;
}

function skipCapturedTacticalCommand(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 1;
  offset += 4;
  offset += 2;
  offset += 4;
  offset += 1;
  offset += 4;
  return offset;
}

function skipCapturedEquipItemData(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedEquipItemStat);
  offset = readSignedVarLong(buffer, offset).offset;
  offset += 1;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectListGeneric(buffer, offset, skipCapturedPotentialOption);
  return offset;
}

function skipCapturedEquipItemStat(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset += 8;
  return offset;
}

function skipCapturedPotentialOption(buffer, offset) {
  offset = readSignedVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectArrayOrList(buffer, offset, 3, skipCapturedPotentialSocketData);
  offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedPotentialSocketData(buffer, offset) {
  offset += 4;
  offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedEmoticonPresetData(buffer, offset) {
  offset = skipCapturedSignedIntList(buffer, offset);
  offset = skipCapturedSignedIntList(buffer, offset);
  return offset;
}

function skipCapturedGuildSimpleData(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readString(buffer, offset).offset;
  offset = readSignedVarLong(buffer, offset).offset;
  return offset;
}

function skipCapturedCommonProfile(buffer, offset) {
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readSignedVarLong(buffer, offset).offset;
  offset = readString(buffer, offset).offset;
  for (let index = 0; index < 6; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function skipCapturedSignedLongList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(buffer, offset).offset;
  return offset;
}

function skipCapturedLongIntMap(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarLong(buffer, offset).offset;
    offset = readSignedVarInt(buffer, offset).offset;
  }
  return offset;
}

function skipCapturedObjectArrayOrList(buffer, offset, fallbackCount, skipper) {
  const count = readVarInt(buffer, offset);
  if (count.value <= 32 && count.offset < buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = skipCapturedNullableObject(buffer, next, skipper);
    return next;
  }
  let next = offset;
  for (let index = 0; index < fallbackCount; index += 1) next = skipCapturedNullableObject(buffer, next, skipper);
  return next;
}

function skipCapturedShipCmdModule(buffer, offset) {
  // Ship command slots are either an object array with a small count or the fixed two-slot array
  // used by NKMShipCmdModule. Handle the normal counted representation first.
  const count = readVarInt(buffer, offset);
  if (count.value <= 4 && count.offset < buffer.length) {
    let next = count.offset;
    for (let index = 0; index < count.value; index += 1) next = skipCapturedNullableObject(buffer, next, skipCapturedShipCmdSlot);
    return next;
  }
  let next = offset;
  for (let index = 0; index < 2; index += 1) next = skipCapturedNullableObject(buffer, next, skipCapturedShipCmdSlot);
  return next;
}

function skipCapturedShipCmdSlot(buffer, offset) {
  offset = skipCapturedSignedIntList(buffer, offset); // targetStyleType HashSet
  offset = skipCapturedSignedIntList(buffer, offset); // targetRoleType HashSet
  offset = readSignedVarInt(buffer, offset).offset; // statType
  offset += 4; // statValue
  offset += 1; // isLock
  return offset;
}

function parseCapturedGameSyncPayload(entry) {
  const payload = entry.compressed ? lz4StreamDecompress(entry.payload) : decryptCopy(entry.payload);
  let offset = 0;
  const gameTime = payload.readFloatLE(offset);
  offset += 4;
  const absoluteGameTime = payload.readFloatLE(offset);
  offset += 4;
  if (payload.readUInt8(offset) === 0) return { gameTime, absoluteGameTime, units: [], remainGameTime: null };
  offset += 1;
  const baseList = readVarInt(payload, offset);
  offset = baseList.offset;
  const units = [];
  let remainGameTime = null;
  for (let index = 0; index < baseList.value; index += 1) {
    if (payload.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset += 1;
    const parsed = parseCapturedGameSyncBase(payload, offset);
    offset = parsed.offset;
    remainGameTime = parsed.remainGameTime == null ? remainGameTime : parsed.remainGameTime;
    units.push(...parsed.units);
  }
  return { gameTime, absoluteGameTime, units, remainGameTime };
}

function parseCapturedGameSyncBase(buffer, offset) {
  const gameTimeHalf = readVarInt(buffer, offset);
  offset = gameTimeHalf.offset;
  const remainHalf = readVarInt(buffer, offset);
  offset = remainHalf.offset;
  const remainGameTime = remainHalf.value / 100;

  for (let index = 0; index < 7; index += 1) offset = readVarInt(buffer, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  offset = skipCapturedObjectList(buffer, offset, skipCapturedDieUnit);

  const unitList = readVarInt(buffer, offset);
  offset = unitList.offset;
  const units = [];
  for (let index = 0; index < unitList.value; index += 1) {
    if (buffer.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset += 1;
    const unitObjectPresent = buffer.readUInt8(offset) !== 0;
    offset += 1;
    if (!unitObjectPresent) continue;
    const parsed = parseCapturedUnitSyncData(buffer, offset);
    offset = parsed.offset;
    units.push(parsed.unit);
  }

  return { offset, remainGameTime, units };
}

function skipCapturedObjectList(buffer, offset, skipItem) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    if (buffer.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset = skipItem(buffer, offset + 1);
  }
  return offset;
}

function skipCapturedDieUnit(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(buffer, offset).offset;
  return offset;
}

function parseCapturedUnitSyncData(buffer, offset) {
  const seed = buffer.readUInt8(offset);
  offset += 1;
  const playState = readSignedVarInt(buffer, offset);
  offset = playState.offset;
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject);
  const respawn = buffer.readUInt8(offset) !== 0;
  offset += 1;
  offset += 1; // m_bRespawnUsedRollback
  const gameUnitUID = readSignedVarInt(buffer, offset);
  offset = gameUnitUID.offset;
  const targetUID = readSignedVarInt(buffer, offset);
  offset = targetUID.offset;
  const subTargetUID = readSignedVarInt(buffer, offset);
  offset = subTargetUID.offset;
  const encryptedHp = buffer.readFloatLE(offset);
  offset += 4;
  const x = buffer.readFloatLE(offset);
  offset += 4;
  const z = buffer.readFloatLE(offset);
  offset += 4;
  const jumpY = buffer.readFloatLE(offset);
  offset += 4;
  const speedX = readVarInt(buffer, offset);
  offset = speedX.offset;
  const speedY = readVarInt(buffer, offset);
  offset = speedY.offset;
  const speedZ = readVarInt(buffer, offset);
  offset = speedZ.offset;
  const right = buffer.readUInt8(offset) !== 0;
  offset += 1;
  const stateId = buffer.readUInt8(offset);
  offset += 1;
  const stateChangeCount = buffer.readInt8(offset);
  offset += 1;
  offset += 2; // m_bDamageSpeedXNegative, m_bAttackerZUp
  for (let index = 0; index < 8; index += 1) offset = readVarInt(buffer, offset).offset;
  offset = readSignedVarInt(buffer, offset).offset; // m_CatcherGameUnitUID
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listDamageData
  offset = skipCapturedObjectMapShort(buffer, offset, skipUnsupportedCapturedObject); // m_dicBuffData
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listStatusTimeData
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listInvokedTrigger
  offset = skipCapturedStringIntMap(buffer, offset); // m_dicEventVariables
  offset = skipCapturedObjectList(buffer, offset, skipUnsupportedCapturedObject); // m_listUpdatedReaction
  const savedPosX = buffer.readFloatLE(offset);
  offset += 4;
  offset += 4; // m_fSavedPosY

  return {
    offset,
    unit: {
      gameUnitUID: gameUnitUID.value,
      hp: Math.max(0, encryptedHp - seed),
      maxHp: Math.max(1, encryptedHp - seed),
      x,
      z,
      jumpY,
      right,
      team: right ? 1 : 3,
      playState: playState.value,
      respawn,
      stateId,
      stateChangeCount,
      targetUID: targetUID.value,
      subTargetUID: subTargetUID.value,
      seed,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      savedPosX: Number.isFinite(savedPosX) ? savedPosX : x,
    },
  };
}

function skipCapturedObjectMapShort(buffer, offset, skipItem) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readSignedVarInt(buffer, offset).offset;
    if (buffer.readUInt8(offset) === 0) {
      offset += 1;
      continue;
    }
    offset = skipItem(buffer, offset + 1);
  }
  return offset;
}

function skipCapturedStringIntMap(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readString(buffer, offset).offset;
    offset = readSignedVarInt(buffer, offset).offset;
  }
  return offset;
}

function skipUnsupportedCapturedObject() {
  throw new Error("unsupported captured nested object in sync parser");
}

function peekCapturedGamePacketId(socket) {
  if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server)) return 0;
  const replay = socket.session.gameReplay;
  const next = capturedGameFlow.server[(replay.nextServerIndex || 1) - 1];
  return next ? next.packetId : 0;
}

function findNextCapturedServerIndex(socket, predicate) {
  if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server)) return 0;
  const startIndex = Math.max(1, socket.session.gameReplay.nextServerIndex || 1);
  for (let index = startIndex; index <= capturedGameFlow.server.length; index += 1) {
    const entry = capturedGameFlow.server[index - 1];
    if (entry && predicate(entry, index)) return index;
  }
  return 0;
}

function getCapturedTemplateServerEntry(index) {
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return null;
  return capturedGameTemplateFlow.server[index - 1] || null;
}

function findCapturedTemplateServerIndexFrom(startIndex, predicate) {
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return 0;
  const start = Math.max(1, Number(startIndex || 1));
  for (let index = start; index <= capturedGameTemplateFlow.server.length; index += 1) {
    const entry = capturedGameTemplateFlow.server[index - 1];
    if (entry && predicate(entry, index)) return index;
  }
  return 0;
}

function findNextCapturedTemplateServerIndex(socket, predicate) {
  const replay = socket && socket.session && socket.session.gameReplay;
  return findCapturedTemplateServerIndexFrom(replay ? replay.nextServerIndex || 1 : 1, predicate);
}

function isTutorialCapturedBootstrapActive(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const dynamicGame = replay && replay.dynamicGame;
  if (!replay || !dynamicGame || replay.tutorialReplayPhase !== "captured-bootstrap") return false;
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return false;
  return (
    dynamicGame.tutorial === true &&
    Number(dynamicGame.stageID || 0) === 11211 &&
    Number(dynamicGame.dungeonID || 0) === 1004
  );
}

function peekCapturedTutorialPacketId(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const next = replay ? getCapturedTemplateServerEntry(replay.nextServerIndex || 1) : null;
  return next ? next.packetId : 0;
}

function sendCapturedGameRange(socket, startIndex, endIndex, label) {
  const replay = socket.session.gameReplay;
  const quietRange = !VERBOSE_CAPTURE_LOGS && endIndex > startIndex;
  let sentCount = 0;
  if (quietRange) {
    console.log(`[capture-game:${label}] SEND range=${startIndex}-${endIndex}`);
  }
  withSocketPacketBurst(socket, () => {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const entry = capturedGameFlow.server[index - 1];
      if (!entry || !entry.raw) {
        console.log(`[capture-game] missing server packet index=${index} label=${label}`);
        continue;
      }
      sendCapturedGameEntry(socket, entry, index, label, { quiet: quietRange });
      sentCount += 1;
      replay.nextServerIndex = Math.max(replay.nextServerIndex, index + 1);
    }
  });
  if (quietRange) {
    console.log(`[capture-game:${label}] sent=${sentCount}`);
  }
}

function withSocketPacketBurst(socket, send) {
  const canCork = socket && typeof socket.cork === "function" && typeof socket.uncork === "function";
  if (canCork) socket.cork();
  try {
    return send();
  } finally {
    if (canCork) socket.uncork();
  }
}

function sendCapturedGameEntry(socket, entry, index, label, options = {}) {
  const replay = socket.session.gameReplay;
  const reframe =
    Object.prototype.hasOwnProperty.call(options, "forceReframe")
      ? Boolean(options.forceReframe)
      : REFRAME_CAPTURED_GAME_FLOW;
  const sendSequence = reframe ? replay.nextServerSequence : entry.sequence;
  const packet =
    reframe && entry.payload
      ? buildFramedPacket(sendSequence, entry.packetId, entry.payload, entry.compressed)
      : entry.raw;
  socket.write(packet);
  const quiet = options.quiet && !VERBOSE_CAPTURE_LOGS;
  if (!quiet) {
    console.log(
      `[capture-game:${label}] SEND index=${index} packetId=${entry.packetId} sequence=${sendSequence} sourceSequence=${entry.sequence} payloadSize=${entry.payloadSize}`
    );
  }
  if (DEBUG_HEX) printHex(packet);
  if (Number.isFinite(Number(sendSequence))) {
    replay.nextServerSequence = Math.max(replay.nextServerSequence, Number(sendSequence) + 1);
  }
}

function startOfficialCombatReplay(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || replay.officialCombatReplayTimer || replay.syntheticSyncTimer) return;
  if (!OFFICIAL_COMBAT_REPLAY || capturedCombatReplayEntries.length === 0) {
    if (ALLOW_SYNTHETIC_GAME_SYNC) {
      startSyntheticGameSync(socket, label);
    } else {
      console.log(`[capture-game:${label}] official combat replay unavailable; no synthetic fallback enabled`);
    }
    return;
  }

  replay.officialCombatReplayCursor = 0;
  replay.officialCombatReplayCount = 0;
  console.log(
    `[capture-game:${label}] starting official combat replay packets=${capturedCombatReplayEntries.length} interval=${OFFICIAL_COMBAT_REPLAY_INTERVAL_MS}ms`
  );
  replay.officialCombatReplayTimer = setInterval(() => {
    if (socket.destroyed) {
      stopGameSyncTimers(socket);
      return;
    }
    const item = capturedCombatReplayEntries[replay.officialCombatReplayCursor % capturedCombatReplayEntries.length];
    replay.officialCombatReplayCursor += 1;
    replay.officialCombatReplayCount += 1;
    sendCapturedGameEntry(socket, item.entry, item.index, "official-combat-replay", {
      forceReframe: true,
      quiet: true,
    });
  }, OFFICIAL_COMBAT_REPLAY_INTERVAL_MS);
  if (typeof replay.officialCombatReplayTimer.unref === "function") replay.officialCombatReplayTimer.unref();
}

function sendServerGamePacket(socket, packetId, payload, label) {
  const replay = socket.session.gameReplay;
  const room = privatePvp.getRoom(socket);
  const sequence = room && room.matchStarted
    ? Number(socket.session.nextServerSequence || 1)
    : Math.max(Number(socket.session.nextServerSequence || 1), Number(replay.nextServerSequence || 1));
  const packet = buildEncryptedPacket(sequence, packetId, payload);
  socket.write(packet);
  const parsed = parsePacket(packet);
  const labelText = String(label || "");
  const quietSynthetic =
    ((packetId === NPT_GAME_SYNC_DATA_PACK_NOT && labelText.toLowerCase().includes("sync")) ||
      label === "synthetic-game-sync" ||
      label === "battle-sim-sync" ||
      label === "battle-manager-sync") &&
    !DEBUG_HEX;
  if (!quietSynthetic || replay.syntheticSyncCount % 20 === 1) {
    console.log(`[capture-game:${label}] SEND packetId=${packetId} sequence=${sequence} payloadSize=${parsed.payloadSize}`);
  }
  if (DEBUG_HEX) printHex(packet);
  replay.nextServerSequence = Math.max(replay.nextServerSequence, Number(sequence) + 1);
  socket.session.nextServerSequence = Number(sequence) + 1;
}

function refreshTimedStamina(user, options = {}) {
  return stamina.refreshTimedStamina(user, options);
}

function sendStaminaChargeNotifications(socket, label = "stamina-charge", options = {}) {
  const user = socket && socket.session && socket.session.user;
  if (!user) return false;
  const now = dateTimeBinaryNow();
  const refreshBatch = userRefresh.prepareUserRefreshNotifications(user, { now });
  const selectedItemIds = (Array.isArray(options.itemIds) && options.itemIds.length > 0
    ? options.itemIds
    : stamina.getTimedStaminaRoutes(user).map((route) => route.itemId)
  )
    .map(Number)
    .filter((itemId) => !stamina.DAILY_REFRESH_ITEM_IDS.includes(itemId));
  const result = selectedItemIds.length > 0
    ? stamina.refreshTimedStamina(user, {
        now,
        itemIds: selectedItemIds,
        initializeMissing: false,
      })
    : { changed: false, updates: [] };
  const updates =
    options.includeUnchanged === true && selectedItemIds.length > 0
      ? stamina.getChargeItemNotifications(user, { now, itemIds: selectedItemIds })
      : result.updates || [];
  let sent = false;
  for (const notification of refreshBatch.packets) {
    sendServerGamePacket(socket, notification.packetId, notification.payload, `${label}-${notification.scope}-refresh`);
    sent = true;
  }
  const notificationStateChanged = refreshBatch.commit();
  for (const update of updates) {
    sendServerGamePacket(socket, stamina.CHARGE_ITEM_NOT, stamina.buildChargeItemNotPayload(update), label);
    sent = true;
  }
  if ((refreshBatch.changed || result.changed || notificationStateChanged) && USE_LOCAL_USER_DB) saveUserDb();
  return sent;
}

function sendManagedOrImmediatePackets(socket, packets) {
  const endIndex = (packets || []).findIndex((item) => item && item.packetId === GAME_END_NOT);
  const outbound = endIndex >= 0 ? packets.slice(0, endIndex + 1) : packets;
  withSocketPacketBurst(socket, () => {
    for (const item of outbound || []) {
      if (!item || !item.packetId || !item.payload) continue;
      sendManagedOrImmediatePacket(socket, item.packetId, item.payload, item.label || "managed-sync", item);
    }
  });
  if (endIndex >= 0) {
    const replay = socket.session && socket.session.gameReplay;
    if (replay) replay.dynamicBattleResultSent = true;
    maybeRecordDynamicBattleClear(socket);
    sendRaidStateDataForSocket(socket, "managed-raid-end");
    stopGameSyncTimers(socket);
    markPrivatePvpMatchFinished(socket);
    markStandardPvpMatchFinished(socket);
  }
}

function sendManagedOrImmediatePacket(socket, packetId, payload, label, meta = {}) {
  const room = privatePvp.getRoom(socket);
  if (room && room.matchStarted) {
    for (const member of room.members) {
      if (!member.socket || member.socket.destroyed) continue;
      sendServerGamePacket(
        member.socket,
        managedCombatPacketId(member.socket, packetId),
        normalizeManagedCombatPayload(member.socket, packetId, payload, label, meta),
        label
      );
    }
    return;
  }
  sendServerGamePacket(
    socket,
    managedCombatPacketId(socket, packetId),
    normalizeManagedCombatPayload(socket, packetId, payload, label, meta),
    label
  );
}

function managedCombatPacketId(socket, packetId) {
  if (packetId !== GAME_END_NOT) return packetId;
  const dynamicGame = socket && socket.session && socket.session.gameReplay && socket.session.gameReplay.dynamicGame;
  if ([asyncPvp.NGT_ASYNC_PVP, asyncPvp.NGT_PVP_STRATEGY, asyncPvp.NGT_PVP_STRATEGY_REVENGE, asyncPvp.NGT_PVP_STRATEGY_NPC].includes(Number(dynamicGame && dynamicGame.gameType || 0))) {
    return asyncPvp.PACKETS.GAME_END_NOT;
  }
  return isDefenceDynamicGame(dynamicGame) ? DEFENCE_GAME_END_NOT : packetId;
}

function sendPendingGameStartSync(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.pendingGameStartBootstrap || !replay.dynamicGame) return false;
  const queuedPackets = Array.isArray(replay.pendingGameStartPackets) ? replay.pendingGameStartPackets : [];
  const packets = ensureGameStartPackets(queuedPackets.length > 0 ? queuedPackets : buildInitialBattlePackets(replay), replay, socket).filter(Boolean);
  if (packets.length === 0) {
    replay.pendingGameStartBootstrap = false;
    replay.pendingGameStartPackets = [];
    return false;
  }
  replay.pendingGameStartBootstrap = false;
  replay.pendingGameStartPackets = [];
  sendManagedOrImmediatePackets(
    socket,
    packets.map((item) => ({
      ...item,
      label:
        item.label ||
        (item.packetId === NPT_GAME_SYNC_DATA_PACK_NOT
          ? "managed-game-sync"
          : item.packetId === GAME_LOAD_COMPLETE_ACK
            ? "managed-load-complete"
            : item.packetId === GAME_START_NOT
              ? "managed-game-start"
              : "managed-game-start"),
    }))
  );
  replay.tutorialReplayPhase = "dynamic";
  if (replay.dynamicGame) replay.dynamicGame.initialUnitsSent = true;
  startDynamicBattleManager(socket, label);
  console.log(`[battle-manager:${label}] game scene sync started`);
  return true;
}

function normalizeManagedCombatPayload(socket, packetId, payload, label, meta = {}) {
  if (packetId !== GAME_END_NOT) return payload;
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame) return payload;
  if ([asyncPvp.NGT_ASYNC_PVP, asyncPvp.NGT_PVP_STRATEGY, asyncPvp.NGT_PVP_STRATEGY_REVENGE, asyncPvp.NGT_PVP_STRATEGY_NPC].includes(Number(replay.dynamicGame.gameType || 0))) {
    const battleState = replay.battleState || {};
    const managedBattleRecords = extractManagedBattleRecords(meta);
    const managedBattleWin = extractManagedBattleWin(meta);
    const managedBattlePlayTime = extractManagedBattlePlayTime(meta);
    return asyncPvp.buildAsyncPvpGameEndNotPayload(createPacketContext(), socket, replay, {
      ...meta,
      battleState: buildBattleGameRecordState(battleState, { managedBattleRecords }),
      ...(typeof managedBattleWin === "boolean" ? { win: managedBattleWin } : {}),
      ...(managedBattlePlayTime > 0 ? { playTime: managedBattlePlayTime } : {}),
    }) || payload;
  }
  const standardPvpMatch = pvpMatchmaking.getMatch(socket) || leaguePvpMatchmaking.getMatch(socket);
  if (standardPvpMatch && [6, leaguePvp.NGT_PVP_LEAGUE, leaguePvp.NGT_PVP_UNLIMITED, eventPvp.NGT_PVP_EVENT].includes(Number(replay.dynamicGame.gameType || 0))) {
    return buildStandardPvpGameEndNotPayloadForSocket(socket, replay, meta) || payload;
  }
  const privatePvpRoom = privatePvp.getRoom(socket);
  const privatePvpMember = privatePvp.getMember(socket);
  if (privatePvpRoom && privatePvpMember && Number(replay.dynamicGame.gameType || 0) === 18) {
    const battleState = replay.battleState || {};
    let winTeam = Number(
      meta.battleWinTeam ?? meta.BattleWinTeam ?? meta.managedBattleWinTeam ?? meta.ManagedBattleWinTeam ??
      (battleState.gameState && (battleState.gameState.winTeam ?? battleState.gameState.WinTeam)) ?? 0
    );
    const managedWin = extractManagedBattleWin(meta);
    if (winTeam !== 1 && winTeam !== 3 && typeof managedWin === "boolean") winTeam = managedWin ? 1 : 3;
    return buildPrivatePvpGameEndNotPayload(replay, privatePvpMember, winTeam, meta);
  }
  const managedBattleRecords = extractManagedBattleRecords(meta);
  const managedBattleWin = extractManagedBattleWin(meta);
  const managedBattlePlayTime = extractManagedBattlePlayTime(meta);
  const managedFiercePoint = extractManagedFiercePoint(meta, "point");
  const managedFiercePenaltyPoint = extractManagedFiercePoint(meta, "penalty");
  const managedDefencePoint = extractManagedDefencePoint(meta);
  const managedTrimPoint = extractManagedTrimPoint(meta);
  const gameRecordOverride = {
    ...(managedBattleRecords.length > 0 ? { managedBattleRecords } : {}),
    ...(typeof managedBattleWin === "boolean" ? { managedBattleWin, win: managedBattleWin } : {}),
    ...(managedBattlePlayTime > 0 ? { managedBattlePlayTime } : {}),
    ...(managedFiercePoint >= 0 ? { managedFiercePoint, fiercePoint: managedFiercePoint } : {}),
    ...(managedFiercePenaltyPoint >= 0 ? { managedFiercePenaltyPoint, fiercePenaltyPoint: managedFiercePenaltyPoint } : {}),
    ...(managedDefencePoint >= 0 ? { managedDefencePoint, defencePoint: managedDefencePoint } : {}),
    ...(managedTrimPoint >= 0 ? { managedTrimPoint, trimPoint: managedTrimPoint } : {}),
  };
  if (managedBattleRecords.length > 0) replay.managedBattleRecords = managedBattleRecords;
  if (managedBattleRecords.length > 0) {
    console.log(
      `[dynamic-game-end] using managed battle records=${managedBattleRecords.length} win=${
        typeof managedBattleWin === "boolean" ? (managedBattleWin ? 1 : 0) : "unknown"
      } playTime=${managedBattlePlayTime || 0}`
    );
  }

  if (isDefenceDynamicGame(replay.dynamicGame)) {
    const defenceEnd = buildDefenceGameEndNotPayload(replay, {
      user: socket.session && socket.session.user,
      fallbackWin: false,
      preferFallbackWin: false,
      ...gameRecordOverride,
    });
    return defenceEnd || payload;
  }

  // NKCGameServerLocal flushes a local-only GAME_END_NOT. The online flow
  // needs server-owned clear data so result screens, mission medals, and local
  // progress all agree after the battle ends.
  if (replay.dynamicGame.tutorial) {
    const tutorialEnd = buildTutorialGameEndNotPayload(replay, {
      user: socket.session && socket.session.user,
      ...gameRecordOverride,
    });
    recordTutorialDungeonClear(socket, replay);
    return tutorialEnd || payload;
  }

  const gameEnd = buildDynamicGameEndNotPayload(replay, {
    user: socket.session && socket.session.user,
    fallbackWin: false,
    preferFallbackWin: false,
    ...gameRecordOverride,
  });
  return gameEnd || payload;
}

function extractManagedBattleRecords(meta = {}) {
  const records = meta && (meta.battleRecords || meta.BattleRecords || meta.managedBattleRecords || meta.ManagedBattleRecords);
  if (!Array.isArray(records)) return [];
  return records.filter((record) => record && typeof record === "object");
}

function extractManagedBattleWin(meta = {}) {
  const explicit = meta && (meta.battleWin ?? meta.BattleWin ?? meta.managedBattleWin ?? meta.ManagedBattleWin);
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "string") {
    const normalized = explicit.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "win") return true;
    if (normalized === "false" || normalized === "0" || normalized === "loss" || normalized === "lose") return false;
  }
  const team = Number(meta && (meta.battleWinTeam ?? meta.BattleWinTeam ?? meta.managedBattleWinTeam ?? meta.ManagedBattleWinTeam) || 0);
  if (team > 0) return isATeamType(team);
  return null;
}

function extractManagedBattlePlayTime(meta = {}) {
  const explicit = finiteNumber(meta && (meta.battlePlayTime ?? meta.BattlePlayTime ?? meta.managedBattlePlayTime ?? meta.ManagedBattlePlayTime));
  if (explicit > 0) return explicit;
  return getBattleRecordMaxPlayTime(extractManagedBattleRecords(meta));
}

function extractManagedFiercePoint(meta = {}, kind = "point") {
  const explicit =
    kind === "penalty"
      ? meta && (meta.fiercePenaltyPoint ?? meta.FiercePenaltyPoint ?? meta.managedFiercePenaltyPoint ?? meta.ManagedFiercePenaltyPoint)
      : meta && (meta.fiercePoint ?? meta.FiercePoint ?? meta.managedFiercePoint ?? meta.ManagedFiercePoint);
  const numeric = finiteNumber(explicit, -1);
  return numeric >= 0 ? Math.round(numeric) : -1;
}

function extractManagedDefencePoint(meta = {}) {
  const explicit = meta && (meta.defencePoint ?? meta.DefencePoint ?? meta.managedDefencePoint ?? meta.ManagedDefencePoint);
  const numeric = finiteNumber(explicit, -1);
  return numeric >= 0 ? Math.round(numeric) : -1;
}

function extractManagedTrimPoint(meta = {}) {
  const explicit = meta && (meta.trimPoint ?? meta.TrimPoint ?? meta.managedTrimPoint ?? meta.ManagedTrimPoint);
  const numeric = finiteNumber(explicit, -1);
  return numeric >= 0 ? Math.round(numeric) : -1;
}

function startSyntheticGameSync(socket, label) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || replay.syntheticSyncTimer) return;
  replay.syntheticGameTime = Math.max(Number(replay.syntheticGameTime || 0), 4);
  replay.syntheticSyncCount = 0;
  console.log(
    `[capture-game:${label}] starting synthetic empty 822 ticks interval=${SYNTHETIC_SYNC_INTERVAL_MS}ms`
  );
  replay.syntheticSyncTimer = setInterval(() => {
    if (socket.destroyed) {
      stopSyntheticGameSync(socket);
      return;
    }
    replay.syntheticSyncCount += 1;
    let syncPayload;
    let syncLabel;
    replay.syntheticGameTime += 0.5;
    syncPayload = combatHandler.buildSyntheticGameSyncPayload(replay.syntheticGameTime);
    syncLabel = "synthetic-game-sync";
    sendServerGamePacket(
      socket,
      NPT_GAME_SYNC_DATA_PACK_NOT,
      syncPayload,
      syncLabel
    );
  }, SYNTHETIC_SYNC_INTERVAL_MS);
  if (typeof replay.syntheticSyncTimer.unref === "function") replay.syntheticSyncTimer.unref();
}

function stopSyntheticGameSync(socket) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.syntheticSyncTimer) return;
  clearInterval(replay.syntheticSyncTimer);
  replay.syntheticSyncTimer = null;
}

function stopGameSyncTimers(socket) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay) return;
  if (replay.dynamicBattleTimer) {
    clearTimeout(replay.dynamicBattleTimer);
    replay.dynamicBattleTimer = null;
  }
  if (replay.syntheticSyncTimer) {
    clearInterval(replay.syntheticSyncTimer);
    replay.syntheticSyncTimer = null;
  }
  if (replay.officialCombatReplayTimer) {
    clearInterval(replay.officialCombatReplayTimer);
    replay.officialCombatReplayTimer = null;
  }
}

function abandonDynamicBattle(socket, label = "abandon") {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame) return false;
  const dynamicGame = replay.dynamicGame;
  guildDungeon.abandonBattle(createPacketContext(), socket, dynamicGame);
  const hadActiveTimer = Boolean(replay.dynamicBattleTimer || replay.syntheticSyncTimer || replay.officialCombatReplayTimer);
  stopGameSyncTimers(socket);
  combatHandler.disposeBattle(replay);
  replay.pendingGameStartBootstrap = false;
  replay.pendingGameStartPackets = [];
  replay.loadCompleteReceived = false;
  replay.dynamicBattlePaused = false;
  replay.dynamicBattleResultSent = true;
  replay.battleState = null;
  replay.dynamicGame = null;
  replay.tutorialReplayPhase = "";
  console.log(
    `[battle-manager:${label}] abandoned stageID=${dynamicGame.stageID || 0} dungeonID=${dynamicGame.dungeonID || 0} timer=${hadActiveTimer ? 1 : 0}`
  );
  return true;
}

function startDynamicBattleManager(socket, label) {
  // Networking adapter: combat-handler owns the timer logic and sync payloads;
  // callbacks keep socket writes and captured packet advancement in this file.
  return combatHandler.startBattleLoop(socket, label, {
    sendGamePacket(socket, packetId, payload, label, meta = {}) {
      if (packetId === GAME_END_NOT) {
        const managedBattleWin = extractManagedBattleWin(meta);
        const replay = socket && socket.session && socket.session.gameReplay;
        const finishState =
          typeof managedBattleWin === "boolean"
            ? { ...((replay && replay.battleState) || {}), win: managedBattleWin, Win: managedBattleWin }
            : null;
        sendDynamicFinishStateSync(socket, finishState, "dynamic-finish-state");
      }
      sendManagedOrImmediatePacket(socket, packetId, payload, label, meta);
    },
    onGameEndPacketSent(socket) {
      markPrivatePvpMatchFinished(socket);
      markStandardPvpMatchFinished(socket);
      maybeRecordDynamicBattleClear(socket);
      sendRaidStateDataForSocket(socket, "managed-raid-end");
    },
    sendBattleResult(socket, finishedState) {
      const replay = socket && socket.session && socket.session.gameReplay;
      const payload = buildDynamicGameEndNotPayload(replay, {
        battleState: finishedState,
        fallbackWin: false,
        preferFallbackWin: false,
        user: socket && socket.session && socket.session.user,
      });
      if (!payload) return false;
      withSocketPacketBurst(socket, () => {
        sendDynamicFinishStateSync(socket, finishedState, "dynamic-finish-state");
        sendManagedOrImmediatePacket(socket, GAME_END_NOT, payload, "dynamic-game-end");
      });
      maybeRecordDynamicBattleClear(socket, finishedState);
      sendRaidStateDataForSocket(socket, "dynamic-raid-end");
      return true;
    },
    stopTimers: stopGameSyncTimers,
  });
}

function sendDynamicFinishStateSync(socket, finishedState = null, label = "dynamic-finish-state") {
  const replay = socket && socket.session && socket.session.gameReplay;
  const payload = buildDynamicFinishStateSyncPayload(replay, finishedState);
  if (!payload) return false;
  sendManagedOrImmediatePacket(socket, NPT_GAME_SYNC_DATA_PACK_NOT, payload, label);
  return true;
}

function buildDynamicFinishStateSyncPayload(replay, finishedState = null) {
  if (!replay || !replay.dynamicGame) return null;
  const battleState = finishedState || replay.battleState || {};
  const playTime = getBattlePlayTime(battleState);
  const absoluteGameTime = Math.max(
    playTime,
    Number(battleState.absoluteGameTime ?? battleState.AbsoluteGameTime ?? playTime) || playTime
  );
  const finishSync = {
    dynamicGame: replay.dynamicGame,
    gameTime: playTime,
    absoluteGameTime,
    remainGameTime: Math.max(0, Number(battleState.remainGameTime ?? battleState.RemainGameTime ?? 0) || 0),
    gameSpeedType: replay.dynamicGame.gameSpeedType ?? battleState.gameSpeedType ?? battleState.GameSpeedType,
    autoSkillType: replay.dynamicGame.autoSkillType ?? battleState.autoSkillType ?? battleState.AutoSkillType,
    gameStates: [
      {
        state: NGS_FINISH,
        winTeam: resolveBattleWin(battleState, { fallbackWin: false, preferFallbackWin: false })
          ? NTT_A1
          : NTT_B1,
        waveId: Number(
          (battleState.gameState && (battleState.gameState.waveId ?? battleState.gameState.waveID)) ??
            battleState.waveId ??
            battleState.WaveId ??
            1
        ),
      },
    ],
  };
  if (battleState.respawnCostA1 != null || battleState.RespawnCostA1 != null) {
    finishSync.respawnCostA1 = Number(battleState.respawnCostA1 ?? battleState.RespawnCostA1);
  }
  if (battleState.respawnCostB1 != null || battleState.RespawnCostB1 != null) {
    finishSync.respawnCostB1 = Number(battleState.respawnCostB1 ?? battleState.RespawnCostB1);
  }
  return combatHandler.buildGameSync(finishSync);
}

function applyCombatControls(socket, controls = {}, options = {}) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay) return null;
  const dynamicGame = replay.dynamicGame && typeof replay.dynamicGame === "object" ? replay.dynamicGame : null;
  const battleState = replay.battleState && typeof replay.battleState === "object" ? replay.battleState : null;
  const applied = {};

  if (Object.prototype.hasOwnProperty.call(controls, "gameSpeedType")) {
    const gameSpeedType = clampCombatControlEnum(controls.gameSpeedType, 0, 5);
    replay.gameSpeedType = gameSpeedType;
    if (dynamicGame) dynamicGame.gameSpeedType = gameSpeedType;
    if (battleState) battleState.gameSpeedType = gameSpeedType;
    applied.gameSpeedType = gameSpeedType;
  }

  if (Object.prototype.hasOwnProperty.call(controls, "autoSkillType")) {
    const autoSkillType = clampCombatControlEnum(controls.autoSkillType, 0, 1);
    replay.autoSkillType = autoSkillType;
    if (dynamicGame) {
      if (Number(socket.session.privatePvpTeamType || 1) === 3) dynamicGame.autoSkillTypeB = autoSkillType;
      else dynamicGame.autoSkillType = autoSkillType;
    }
    if (battleState) battleState.autoSkillType = autoSkillType;
    applied.autoSkillType = autoSkillType;
  }

  if (Object.prototype.hasOwnProperty.call(controls, "autoRespawnEnabled")) {
    const autoRespawnEnabled = Boolean(controls.autoRespawnEnabled);
    replay.autoRespawnEnabled = autoRespawnEnabled;
    if (dynamicGame) {
      if (Number(socket.session.privatePvpTeamType || 1) === 3) dynamicGame.autoRespawnEnabledB = autoRespawnEnabled;
      else dynamicGame.autoRespawnEnabled = autoRespawnEnabled;
    }
    if (battleState) battleState.autoRespawnEnabled = autoRespawnEnabled;
    applied.autoRespawnEnabled = autoRespawnEnabled;
  }

  const user = socket && socket.session && socket.session.user;
  if (options.persist !== false && user && Object.keys(applied).length > 0 && saveUserCombatControls(user, applied) && USE_LOCAL_USER_DB) {
    saveUserDb();
  }
  return getReplayCombatControls(replay, user);
}

function clampCombatControlEnum(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric | 0));
}

function normalizeCombatControls(source = {}, fallback = DEFAULT_COMBAT_CONTROLS) {
  const controls = source && typeof source === "object" ? source : {};
  const base = fallback && typeof fallback === "object" ? fallback : DEFAULT_COMBAT_CONTROLS;
  return {
    autoRespawnEnabled: Object.prototype.hasOwnProperty.call(controls, "autoRespawnEnabled")
      ? Boolean(controls.autoRespawnEnabled)
      : Boolean(base.autoRespawnEnabled),
    gameSpeedType: Object.prototype.hasOwnProperty.call(controls, "gameSpeedType")
      ? clampCombatControlEnum(controls.gameSpeedType, 0, 5)
      : clampCombatControlEnum(base.gameSpeedType, 0, 5),
    autoSkillType: Object.prototype.hasOwnProperty.call(controls, "autoSkillType")
      ? clampCombatControlEnum(controls.autoSkillType, 0, 1)
      : clampCombatControlEnum(base.autoSkillType, 0, 1),
  };
}

function hasSavedCombatControls(user) {
  const controls = user && user.combatControls && typeof user.combatControls === "object" ? user.combatControls : null;
  if (!controls) return false;
  return ["autoRespawnEnabled", "gameSpeedType", "autoSkillType"].some((key) =>
    Object.prototype.hasOwnProperty.call(controls, key)
  );
}

function getSavedCombatControls(user) {
  const controls = user && user.combatControls && typeof user.combatControls === "object" ? user.combatControls : null;
  return normalizeCombatControls(controls, DEFAULT_COMBAT_CONTROLS);
}

function getReplayCombatControls(replay, user) {
  const source = {};
  if (replay && replay.autoRespawnEnabled != null) source.autoRespawnEnabled = replay.autoRespawnEnabled;
  if (replay && replay.gameSpeedType != null) source.gameSpeedType = replay.gameSpeedType;
  if (replay && replay.autoSkillType != null) source.autoSkillType = replay.autoSkillType;
  return normalizeCombatControls(source, getSavedCombatControls(user));
}

function saveUserCombatControls(user, partialControls) {
  if (!user || typeof user !== "object") return false;
  const current = getSavedCombatControls(user);
  const next = normalizeCombatControls(partialControls, current);
  const previous = user.combatControls && typeof user.combatControls === "object" ? user.combatControls : {};
  const changed =
    previous.autoRespawnEnabled !== next.autoRespawnEnabled ||
    previous.gameSpeedType !== next.gameSpeedType ||
    previous.autoSkillType !== next.autoSkillType;
  if (!changed && hasSavedCombatControls(user)) return false;
  user.combatControls = {
    ...previous,
    autoRespawnEnabled: next.autoRespawnEnabled,
    gameSpeedType: next.gameSpeedType,
    autoSkillType: next.autoSkillType,
    updatedAt: new Date().toISOString(),
  };
  return true;
}

function applySavedCombatControls(socket) {
  const user = socket && socket.session && socket.session.user;
  return applyCombatControls(socket, getSavedCombatControls(user), { persist: false });
}

function buildDynamicGameLoadPayload(socket, req, stage) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !req) return null;
  const user = socket && socket.session && socket.session.user;
  const activeStage = stage || {};
  // Every tutorial phase is a new battle load on the same socket/session.
  // Reset per-battle gates here so heartbeats during phase 2+ loading cannot
  // start managed 822 sync before GAME_LOAD_COMPLETE_REQ (807) arrives.
  stopGameSyncTimers(socket);
  replay.loadCompleteReceived = false;
  replay.dynamicBattlePaused = false;
  replay.dynamicBattleResultSent = false;
  replay.tutorialClearRecorded = false;
  replay.stageClearLoot = null;
  replay.lastDynamicGameEndResult = null;
  replay.shadowPalaceBattleResult = null;
  replay.killCountBattleResult = null;
  replay.trimBattleResult = null;
  replay.exploreBattleResult = null;
  replay.guildDungeonResultPersisted = false;
  replay.managedBattleRecords = null;
  replay.managedGameLoadAckPayload = null;
  const gameLoadAckTemplate = getCapturedServerPayloadTemplate(GAME_LOAD_ACK);
  const nativeTutorialLoad =
    activeStage.tutorial || isTutorialStageId(activeStage.stageId || req.stageID) || isTutorialDungeonId(activeStage.dungeonID || req.dungeonID);
  const usesEventDeck = Number(activeStage.eventDeckId || activeStage.EventDeckId || 0) > 0;
  const fierceLoad =
    String(activeStage.miscMode || "").toLowerCase() === "fierce" ||
    Number(activeStage.gameType || 0) === NGT_FIERCE ||
    positiveInt(req.fierceBossId || req.fierceBossID || req.bossId) > 0;
  const seedGameLoadTemplate = !activeStage.ignoreGameLoadTemplate && !nativeTutorialLoad && (!usesEventDeck || fierceLoad);
  const battleConditionIds = resolveGameLoadBattleConditionIds(activeStage, req, user);
  const fierceScorePlan = buildFierceScorePlanForStage(activeStage, req, user);
  const stageForBattle = {
    ...activeStage,
    ...(Array.isArray(battleConditionIds) ? { battleConditionIds } : {}),
    ...fierceScorePlan,
  };
  // Stage data enters combat-handler here, then the listener wraps the resulting
  // state in a managed GAME_LOAD_ACK when possible. Tutorial battles no longer
  // seed the managed bridge from captured 804; the bridge builds NKMGameData
  // from the local tables so phase routing is not coupled to stale captures.
  const dynamicGame = combatHandler.startBattle({
    replay,
    req,
    stage: stageForBattle,
    gameUID: stageForBattle.gameUID || stageForBattle.gameUid || req.gameUID || req.gameUid,
    gameLoadAckPayloadBase64: seedGameLoadTemplate && gameLoadAckTemplate ? gameLoadAckTemplate.toString("base64") : "",
  });
  if (!dynamicGame || !replay.dynamicGame) {
    console.log("[dynamic-game-load] battle state creation failed; no GAME_LOAD_ACK sent");
    return null;
  }
  if (replay.dynamicGame) {
    const raidUID = toBigInt(
      activeStage.raidUID || activeStage.raidUid || (req && (req.raidUID || req.raidUid)) || 0
    );
    if (raidUID > 0n) replay.dynamicGame.raidUID = String(raidUID);
    const gameType = Number(activeStage.gameType || (req && req.gameType) || replay.dynamicGame.gameType || 0);
    if (gameType) replay.dynamicGame.gameType = gameType;
    if (activeStage.playerDeck) replay.dynamicGame.playerDeck = activeStage.playerDeck;
    if (activeStage.worldmapEventID) replay.dynamicGame.worldmapEventID = Number(activeStage.worldmapEventID || 0);
    if (activeStage.diveStageID || (req && req.diveStageID)) replay.dynamicGame.diveStageID = Number(activeStage.diveStageID || req.diveStageID || 0);
    if (activeStage.miscMode) replay.dynamicGame.miscMode = String(activeStage.miscMode || "");
    if (Array.isArray(battleConditionIds)) replay.dynamicGame.battleConditionIds = battleConditionIds;
    Object.assign(replay.dynamicGame, fierceScorePlan);
    replay.dynamicGame.isTryAssist = Boolean(req && req.isTryAssist);
    replay.dynamicGame.buffList = Array.isArray(req && req.buffList) ? [...req.buffList] : [];
    replay.dynamicGame.raidCostItemId = Number(req && req.raidCostItemId || 0);
    replay.dynamicGame.raidCostCount = Number(req && req.raidCostCount || 0);
  }
  applySavedCombatControls(socket);
  const capturedTutorialBootstrap =
    replay.dynamicGame &&
    replay.dynamicGame.tutorial === true &&
    replay.tutorialReplayPhase === "captured-bootstrap" &&
    Number(replay.dynamicGame.stageID || 0) === 11211 &&
    Number(replay.dynamicGame.dungeonID || 0) === 1004;
  const capturedTutorialLoadPayload = capturedTutorialBootstrap ? gameLoadAckTemplate : null;
  let payload =
    replay.managedGameLoadAckPayload ||
    capturedTutorialLoadPayload ||
    buildGameLoadAck({
      ...replay.dynamicGame,
      // Phase 1 preserves the captured 804 layout exactly; later stages patch
      // dungeon/map so the client routes into the correct script.
      patchStageFields: !replay.dynamicGame.tutorial || Number(replay.dynamicGame.stageID) !== 11211,
    });
  if (replay.dynamicGame && Array.isArray(replay.dynamicGame.battleConditionIds)) {
    payload = patchGameLoadAckBattleConditionIds(payload, replay.dynamicGame.battleConditionIds);
    if (replay.managedGameLoadAckPayload) replay.managedGameLoadAckPayload = payload;
  }
  combatHandler.attachGameLoadUnitPools(replay, stageForBattle, payload);
  return {
    replay,
    payload,
    managed: Boolean(replay.managedGameLoadAckPayload),
    capturedTutorialBootstrap: Boolean(capturedTutorialLoadPayload),
  };
}

function sendDynamicGameLoadAck(socket, req, stage) {
  const result = buildDynamicGameLoadPayload(socket, req, stage);
  if (!result) return false;
  const replay = result.replay;
  const payload = result.payload;
  const raidHpChanged = syncRaidCombatHpForReplay(socket, replay, "raid-game-load");
  const label = result.capturedTutorialBootstrap
    ? "captured-tutorial-game-load"
    : replay.managedGameLoadAckPayload
      ? "managed-game-load"
      : "dynamic-game-load";
  if (result.capturedTutorialBootstrap) {
    if (!sendCapturedTutorialGameLoadAck(socket, label)) sendServerGamePacket(socket, GAME_LOAD_ACK, payload, label);
  } else {
    sendServerGamePacket(socket, GAME_LOAD_ACK, payload, label);
  }
  console.log(
    `[dynamic-game-load] stageID=${replay.dynamicGame.stageID} dungeonID=${replay.dynamicGame.dungeonID} mapID=${replay.dynamicGame.mapID} gameType=${replay.dynamicGame.gameType || 0} raidUID=${replay.dynamicGame.raidUID || 0} mode=${replay.dynamicGame.miscMode || "dungeon"} gameUID=${replay.dynamicGame.gameUID} battleUnits=${replay.battleState.units.map((unit) => unit.gameUnitUID).join(",")} deployPools=${combatHandler.describeRuntimeGameUnitPools(replay.dynamicGame.unitPools) || replay.dynamicGame.assignedGameUnitUIDs.join(",")}`
  );
  if (raidHpChanged) sendRaidStateDataForSocket(socket, "raid-game-load");
  return true;
}

function buildPvpCombatModifierFields(users, gameStatRateId, includeBanUp = true) {
  const candidates = Array.isArray(users) ? users : [users];
  const source = includeBanUp
    ? candidates.map(getStoredPvpBanResult).find((value) => value)
    : null;
  return {
    gameStatRateId: String(gameStatRateId || "PVP_STAT_DEFAULT"),
    unitBans: normalizePvpCombatModifiers(source && source.unitBanList, ["unitId", "m_UnitID"], ["banLevel", "m_BanLevel"]),
    shipBans: normalizePvpCombatModifiers(source && source.shipBanList, ["shipGroupId", "m_ShipGroupID"], ["banLevel", "m_BanLevel"]),
    operatorBans: normalizePvpCombatModifiers(source && source.operatorBanList, ["operatorId", "m_OperatorID"], ["banLevel", "m_BanLevel"]),
    unitUps: normalizePvpCombatModifiers(source && source.unitUpList, ["unitId", "m_UnitID"], ["upLevel", "m_UpLevel"]),
  };
}

function getStoredPvpBanResult(user) {
  const direct = user && user.pvpBanResult;
  if (direct && typeof direct === "object") return direct;
  const imported = user && user.officialSnapshot && user.officialSnapshot.packet && user.officialSnapshot.packet.pvpBanResult;
  return imported && typeof imported === "object" ? imported : null;
}

function normalizePvpCombatModifiers(values, idKeys, levelKeys) {
  const rows = Array.isArray(values) ? values : values && typeof values === "object" ? Object.values(values) : [];
  return rows.map((row) => {
    const data = row && typeof row === "object" ? row : {};
    const id = idKeys.map((key) => Number(data[key] || 0)).find((value) => Number.isInteger(value) && value > 0) || 0;
    const level = levelKeys.map((key) => Number(data[key] || 0)).find((value) => Number.isInteger(value) && value > 0) || 0;
    return id > 0 && level > 0 ? { id, level } : null;
  }).filter(Boolean).map((entry) => {
    if (idKeys.includes("shipGroupId")) return { shipGroupId: entry.id, banLevel: entry.level };
    if (idKeys.includes("operatorId")) return { operatorId: entry.id, banLevel: entry.level };
    if (levelKeys.includes("upLevel")) return { unitId: entry.id, upLevel: entry.level };
    return { unitId: entry.id, banLevel: entry.level };
  });
}

function getRankPvpGameStatRateId(user, asyncMode = false) {
  const state = asyncMode ? pvpRank.getAsyncPvpState(user) : pvpRank.getPvpRankState(user);
  const ctx = createPacketContext();
  const season = state.seasonId > 0
    ? (asyncMode ? pvpRank.getAsyncSeasonById(ctx, user, state.seasonId) : pvpRank.getSeasonById(ctx, user, state.seasonId))
    : (asyncMode ? pvpRank.getActiveAsyncSeason(ctx, user) : pvpRank.getActiveSeason(ctx, user));
  const tier = season && (
    pvpRank.getTierByTier(season.rankGroup, state.leagueTierId) ||
    pvpRank.getTierByScore(season.rankGroup, state.score)
  );
  return String(tier && tier.row && tier.row.m_GameStatRateID || "PVP_STAT_DEFAULT");
}

function getLeaguePvpGameStatRateId(user) {
  const state = leaguePvp.getLeaguePvpState(user);
  const season = leaguePvp.getLeagueSeasonById(state.seasonId);
  const tier = season && leaguePvp.loadLeagueCatalog().tiers.find((row) =>
    Number(row && row.m_RankGroup) === Number(season.rankGroup) &&
    Number(row && row.m_LeagueTier) === Number(state.leagueTierId)
  );
  return String(tier && tier.m_GameStatRateID || "PVP_STAT_DEFAULT");
}

function startPrivatePvpMatch(room, onAccepted) {
  if (!room || room.matchStarted) return false;
  const players = room.members.filter((entry) => !entry.observer);
  if (players.length !== 2 || players.some((entry) => !entry.socket || entry.socket.destroyed)) {
    console.log(`[private-pvp] room=${room && room.code || "?"} cannot start until both players are connected`);
    return false;
  }
  const playerA = players.find((entry) => Number(entry.teamType) === 1) || players[0];
  const playerB = players.find((entry) => Number(entry.teamType) === 3) || players[1];
  const playerDeck = buildPlayerDeckForGameLoad(playerA.user, { selectDeckIndex: playerA.deckIndex.index });
  const playerDeckB = buildPlayerDeckForGameLoad(playerB.user, { selectDeckIndex: playerB.deckIndex.index });
  if (!playerDeck || !playerDeckB) {
    console.log(`[private-pvp] room=${room.code} missing a playable deck`);
    return false;
  }
  if (!room.config.applyEquipStat) {
    for (const deck of [playerDeck, playerDeckB]) {
      deck.equipItems = [];
      for (const unit of deck.units || []) unit.equipItemUids = [];
    }
  }

  const replay = createGameReplayState();
  replay.inGameFlow = true;
  replay.privatePvpRoomCode = room.code;
  privatePvp.setReplay(room, replay);
  room.state = 7;
  for (const member of players) {
    member.playerState = 4;
    member.loaded = false;
  }
  privatePvp.broadcastState(room, createPacketContext());

  const req = { stageID: 0, dungeonID: 0, gameType: 18, selectDeckIndex: playerA.deckIndex.index };
  const stage = {
    stageId: 0,
    dungeonID: 0,
    mapID: PRIVATE_PVP_MAP_ID,
    gameType: 18,
    miscMode: "private-pvp",
    initialRemainGameTime: 180,
    respawnCostA1: 10,
    respawnCostB1: 10,
    playerDeck,
    playerDeckB,
    ...buildPvpCombatModifierFields([playerA.user, playerB.user], "PVP_STAT_DEFAULT", room.config.applyBanUpSystem),
    ignoreGameLoadTemplate: true,
  };
  const result = buildDynamicGameLoadPayload(playerA.socket, req, stage);
  if (!result || !result.replay || !result.replay.dynamicGame || !result.replay.dynamicGame.managedCombat) {
    room.state = 6;
    for (const member of players) member.playerState = 1;
    privatePvp.broadcastState(room, createPacketContext());
    console.log(`[private-pvp] room=${room.code} CombatHost failed to create the authoritative match`);
    return false;
  }
  if (typeof onAccepted === "function") onAccepted();
  room.replay = result.replay;
  room.gameDataPayload = extractNullableGameDataFromGameLoadAckPayload(result.payload);
  room.matchStarted = true;
  for (const member of players) member.playerState = 2;
  privatePvp.broadcast(room, createPacketContext(), 2604, room.gameDataPayload, "private-pvp-match-complete");
  console.log(
    `[private-pvp] started room=${room.code} gameUID=${String(result.replay.dynamicGame.gameUID || 0)} map=${PRIVATE_PVP_MAP_ID} A=${playerA.user.userUid} B=${playerB.user.userUid}`
  );
  return true;
}

function startStandardPvpMatch(match) {
  if (!match || match.matchStarted) return false;
  const playerA = match.members.find((entry) => Number(entry.teamType) === 1) || match.members[0];
  if (!playerA || !playerA.socket || playerA.socket.destroyed) return failStandardPvpMatch(match, 95);
  if (match.bot && match.members.length === 1) {
    const botUser = remapGuestProjection(projectPrivatePvpUser(playerA.user), { members: [{ user: playerA.user }] });
    if (!botUser) return failStandardPvpMatch(match, 95);
    botUser.nickname = `${String(playerA.user && playerA.user.nickname || "Player").slice(0, 20)} Bot`;
    match.members.push({
      socket: null,
      user: botUser,
      ticket: null,
      teamType: 3,
      observer: false,
      loaded: true,
      playerState: 2,
      bot: true,
    });
  }
  const playerB = match.members.find((entry) => Number(entry.teamType) === 3);
  if (!playerB || (!match.bot && (!playerB.socket || playerB.socket.destroyed))) {
    return failStandardPvpMatch(match, 95);
  }

  const playerDeck = buildPlayerDeckForGameLoad(
    playerA.user,
    { selectDeckIndex: playerA.ticket.req.selectDeckIndex },
    { deckIndex: { deckType: 2, index: playerA.ticket.req.selectDeckIndex }, strictSelection: true }
  );
  const playerBDeckIndex = playerB.ticket ? playerB.ticket.req.selectDeckIndex : playerA.ticket.req.selectDeckIndex;
  const playerDeckB = buildPlayerDeckForGameLoad(
    playerB.user,
    { selectDeckIndex: playerBDeckIndex },
    { deckIndex: { deckType: 2, index: playerBDeckIndex }, strictSelection: true }
  );
  if (!playerDeck || !playerDeckB) return failStandardPvpMatch(match, 95);

  const replay = createGameReplayState();
  replay.inGameFlow = true;
  match.replay = replay;
  for (const member of match.members) {
    if (!member.socket) continue;
    member.socket.session.standardPvpMatch = match;
    member.socket.session.standardPvpMember = member;
    member.socket.session.privatePvpTeamType = member.teamType;
    member.socket.session.gameReplay = replay;
    // The existing two-player combat transport is intentionally shared with
    // friendly PvP; only the matchmaking and result authority differ.
    if (!match.bot) {
      member.socket.session.privatePvpRoom = match;
      member.socket.session.privatePvpMember = member;
    }
  }

  const req = { stageID: 0, dungeonID: 0, gameType: 6, selectDeckIndex: playerA.ticket.req.selectDeckIndex };
  const stage = {
    stageId: 0,
    dungeonID: 0,
    mapID: PRIVATE_PVP_MAP_ID,
    gameType: 6,
    miscMode: "rank-pvp",
    initialRemainGameTime: 180,
    respawnCostA1: 10,
    respawnCostB1: 10,
    playerDeck,
    playerDeckB,
    ...buildPvpCombatModifierFields([playerA.user, playerB.user], getRankPvpGameStatRateId(playerA.user)),
    ignoreGameLoadTemplate: true,
  };
  const result = buildDynamicGameLoadPayload(playerA.socket, req, stage);
  if (!result || !result.replay || !result.replay.dynamicGame || !result.replay.dynamicGame.managedCombat) {
    clearStandardPvpSessions(match);
    return failStandardPvpMatch(match, 95);
  }
  match.replay = result.replay;
  match.gameDataPayload = extractNullableGameDataFromGameLoadAckPayload(result.payload);
  match.matchStarted = true;
  match.state = "active";
  result.replay.dynamicGame.standardPvp = true;
  result.replay.dynamicGame.botMatch = Boolean(match.bot);
  result.replay.dynamicGame.autoRespawnEnabledB = true;
  pvpMatchmaking.complete(match);
  for (const member of match.members) {
    if (!member.socket || member.socket.destroyed) continue;
    member.socket.session.gameReplay = result.replay;
    sendServerGamePacket(member.socket, 2604, match.gameDataPayload, "pvp-match-complete");
  }
  console.log(
    `[pvp-match] started match=${match.id} gameUID=${String(result.replay.dynamicGame.gameUID || 0)} bot=${match.bot ? 1 : 0} A=${playerA.user.userUid} B=${playerB.user.userUid}`
  );
  return true;
}

function startLeaguePvpMatch(match) {
  if (!match || match.matchStarted || match.roomState !== leaguePvp.DRAFT_STATE.DRAFT_COMPLETE) return false;
  const playerA = match.members.find((entry) => Number(entry.teamType) === 1);
  const playerB = match.members.find((entry) => Number(entry.teamType) === 3);
  if (
    !playerA || !playerB || !playerA.socket || playerA.socket.destroyed ||
    !playerB.socket || playerB.socket.destroyed
  ) return failLeaguePvpMatch(match, leaguePvp.ERRORS.LEAGUE_MISS_MATCH);

  const playerDeck = leaguePvp.buildDraftPlayerDeck(playerA);
  const playerDeckB = leaguePvp.buildDraftPlayerDeck(playerB);
  if (!playerDeck || !playerDeckB) return failLeaguePvpMatch(match, leaguePvp.ERRORS.LEAGUE_MISS_MATCH);

  const replay = createGameReplayState();
  replay.inGameFlow = true;
  match.replay = replay;
  match.standardPvp = true;
  for (const member of match.members) {
    const session = member.socket && member.socket.session;
    if (!session) continue;
    session.standardPvpMatch = match;
    session.standardPvpMember = member;
    session.privatePvpRoom = match;
    session.privatePvpMember = member;
    session.privatePvpTeamType = member.teamType;
    session.gameReplay = replay;
  }

  const gameType = Number(match.gameType) === leaguePvp.NGT_PVP_UNLIMITED
    ? leaguePvp.NGT_PVP_UNLIMITED
    : leaguePvp.NGT_PVP_LEAGUE;
  const req = {
    stageID: 0,
    dungeonID: 0,
    gameType,
    selectDeckIndex: playerA.ticket.req.selectDeckIndex,
  };
  const stage = {
    stageId: 0,
    dungeonID: 0,
    mapID: PRIVATE_PVP_MAP_ID,
    gameType,
    miscMode: "league-pvp",
    initialRemainGameTime: 180,
    respawnCostA1: 10,
    respawnCostB1: 10,
    playerDeck,
    playerDeckB,
    ...buildPvpCombatModifierFields([playerA.user, playerB.user], getLeaguePvpGameStatRateId(playerA.user)),
    ignoreGameLoadTemplate: true,
  };
  const result = buildDynamicGameLoadPayload(playerA.socket, req, stage);
  if (!result || !result.replay || !result.replay.dynamicGame || !result.replay.dynamicGame.managedCombat) {
    clearStandardPvpSessions(match);
    return failLeaguePvpMatch(match, leaguePvp.ERRORS.LEAGUE_MISS_MATCH);
  }

  match.replay = result.replay;
  match.gameDataPayload = extractNullableGameDataFromGameLoadAckPayload(result.payload);
  if (!leaguePvpMatchmaking.activate(match)) {
    clearStandardPvpSessions(match);
    return failLeaguePvpMatch(match, leaguePvp.ERRORS.LEAGUE_MISS_MATCH);
  }
  result.replay.dynamicGame.standardPvp = true;
  result.replay.dynamicGame.leaguePvp = true;
  result.replay.dynamicGame.autoRespawnEnabledB = false;
  for (const member of match.members) {
    if (!member.socket || member.socket.destroyed) continue;
    member.socket.session.gameReplay = result.replay;
    sendServerGamePacket(member.socket, 2604, match.gameDataPayload, "league-pvp-match-complete");
  }
  console.log(
    `[league-pvp] started match=${match.id} gameType=${gameType} gameUID=${String(result.replay.dynamicGame.gameUID || 0)} A=${playerA.user.userUid} B=${playerB.user.userUid}`
  );
  return true;
}

function startEventPvpMatch(socket, user, request, season) {
  if (!socket || !socket.session || !user || !request || !season) return false;
  const selection = request.eventDeckData || {};
  const selectedSlots = Object.keys(selection.units || {}).map(Number).filter(Number.isInteger);
  const playerDeck = buildPlayerDeckForGameLoad(
    user,
    { selectDeckIndex: 0 },
    {
      deckIndex: { deckType: 0, index: 0 },
      strictSelection: true,
      allowedUnitSlots: selectedSlots,
      slotUnitUids: selection.units,
      shipUid: selection.shipUid,
      operatorUid: selection.operatorUid,
      leaderIndex: selection.leaderIndex,
    }
  );
  const botUser = remapGuestProjection(projectPrivatePvpUser(user), { members: [{ user }] });
  if (botUser) botUser.nickname = `${String(user.nickname || "Player").slice(0, 20)} Bot`;
  const playerDeckB = botUser && buildPlayerDeckForGameLoad(
    botUser,
    { selectDeckIndex: 0 },
    { deckIndex: { deckType: 2, index: 0 }, strictSelection: true }
  );
  if (!playerDeck || !playerDeckB) return false;

  const previousReplay = socket.session.gameReplay;
  const replay = createGameReplayState();
  replay.inGameFlow = true;
  const member = { socket, user, ticket: null, teamType: 1, observer: false, loaded: true, playerState: 2 };
  const match = {
    id: `event-${String(user.userUid || 0)}-${Date.now()}`,
    standardPvp: true,
    eventPvp: true,
    bot: true,
    season,
    state: "matched",
    matchStarted: false,
    matchFinished: false,
    battleStarted: false,
    replay,
    gameDataPayload: null,
    resultStates: new Map(),
    members: [member, {
      socket: null,
      user: botUser,
      ticket: null,
      teamType: 3,
      observer: false,
      loaded: true,
      playerState: 2,
      bot: true,
    }],
  };
  socket.session.standardPvpMatch = match;
  socket.session.standardPvpMember = member;
  socket.session.privatePvpTeamType = 1;
  socket.session.gameReplay = replay;

  const req = { stageID: 0, dungeonID: 0, gameType: eventPvp.NGT_PVP_EVENT, selectDeckIndex: 0 };
  const stage = {
    stageId: 0,
    dungeonID: 0,
    mapID: PRIVATE_PVP_MAP_ID,
    gameType: eventPvp.NGT_PVP_EVENT,
    miscMode: "event-pvp",
    eventDeckId: Number(season.EventDeckID || 0),
    usesHybridEventDeck: true,
    eventDeckFreeUnitSlots: getEventDeckPlayerUnitSlots(Number(season.EventDeckID || 0)),
    eventDeckFreeShipSlot: eventDeckHasFreeShipSlot(Number(season.EventDeckID || 0)),
    battleConditionIds: (Array.isArray(season.BattleConditionID) ? season.BattleConditionID : [])
      .map(getBattleConditionIdByStrId)
      .filter((value) => value > 0),
    initialRemainGameTime: 180,
    respawnCostA1: 10,
    respawnCostB1: 10,
    playerDeck,
    playerDeckB,
    ...buildPvpCombatModifierFields(user, season.GameStateRateID, season.bForcedBanIgnore !== true),
    ignoreGameLoadTemplate: true,
  };
  const result = buildDynamicGameLoadPayload(socket, req, stage);
  if (!result || !result.replay || !result.replay.dynamicGame || !result.replay.dynamicGame.managedCombat) {
    if (result && result.replay && result.replay.dynamicGame) abandonDynamicBattle(socket, "event-pvp-start-failed");
    clearStandardPvpSessions(match);
    socket.session.gameReplay = previousReplay;
    return false;
  }

  match.replay = result.replay;
  match.gameDataPayload = extractNullableGameDataFromGameLoadAckPayload(result.payload);
  match.matchStarted = true;
  match.state = "active";
  result.replay.dynamicGame.standardPvp = true;
  result.replay.dynamicGame.eventPvp = true;
  result.replay.dynamicGame.eventPvpSeasonId = Number(season.seasonID || 0);
  result.replay.dynamicGame.autoRespawnEnabledB = true;
  socket.session.gameReplay = result.replay;
  sendServerGamePacket(socket, eventPvp.PACKETS.COMPLETE_NOT, match.gameDataPayload, "event-pvp-match-complete");
  return true;
}

function cancelEventPvpMatch(socket) {
  const match = pvpMatchmaking.getMatch(socket);
  if (!match || !match.eventPvp || match.matchStarted || match.matchFinished) return false;
  match.matchFinished = true;
  match.state = "cancelled";
  clearStandardPvpSessions(match);
  return true;
}

function exitEventPvpMatch(socket) {
  const match = pvpMatchmaking.getMatch(socket);
  if (!match || !match.eventPvp || match.matchFinished) return false;
  match.matchFinished = true;
  match.state = "exited";
  if (match.replay && match.replay.dynamicGame) abandonDynamicBattle(socket, "event-pvp-exit");
  clearStandardPvpSessions(match);
  return true;
}

function startAsyncPvpBattle(socket, user, targetUser, req, options = {}) {
  if (!socket || !socket.session || !user || !targetUser || !req) return null;
  const playerDeck = buildPlayerDeckForGameLoad(
    user,
    { selectDeckIndex: req.selectDeckIndex },
    { deckIndex: { deckType: asyncPvp.NDT_PVP, index: req.selectDeckIndex }, strictSelection: true }
  );
  const playerDeckB = buildPlayerDeckForGameLoad(
    targetUser,
    { selectDeckIndex: 0 },
    { deckIndex: { deckType: asyncPvp.NDT_PVP_DEFENCE, index: 0 }, strictSelection: true }
  );
  if (!playerDeck || !playerDeckB) return null;

  const previousReplay = socket.session.gameReplay;
  const replay = createGameReplayState();
  replay.inGameFlow = true;
  socket.session.gameReplay = replay;
  const stage = {
    stageId: 0,
    dungeonID: 0,
    mapID: PRIVATE_PVP_MAP_ID,
    gameType: Number(req.gameType),
    miscMode: "async-pvp",
    initialRemainGameTime: 180,
    respawnCostA1: 10,
    respawnCostB1: 10,
    playerDeck,
    playerDeckB,
    ...buildPvpCombatModifierFields([user, targetUser], getRankPvpGameStatRateId(user, true)),
    ignoreGameLoadTemplate: true,
  };
  const result = buildDynamicGameLoadPayload(socket, req, stage);
  if (!result || !result.replay || !result.replay.dynamicGame || !result.replay.dynamicGame.managedCombat) {
    if (result && result.replay && result.replay.dynamicGame) abandonDynamicBattle(socket, "async-pvp-start-failed");
    socket.session.gameReplay = previousReplay;
    return null;
  }
  result.replay.dynamicGame.asyncPvp = true;
  result.replay.dynamicGame.autoRespawnEnabledB = true;
  const startAckPayload = combatHandler.buildAsyncPvpStartAck(result.replay, {
    targetListAckPayload: options.targetListAckPayload,
    targetFriendCode: req.targetFriendCode,
    simulationGame: req.simulationGame,
  });
  if (!startAckPayload) {
    abandonDynamicBattle(socket, "async-pvp-start-ack-failed");
    socket.session.gameReplay = previousReplay;
    return null;
  }
  return {
    ok: true,
    replay: result.replay,
    gameDataPayload: extractNullableGameDataFromGameLoadAckPayload(result.payload),
    startAckPayload,
  };
}

function buildSimulatedPvpTestResult(socket, user, req = {}) {
  const failure = (errorCode = asyncPvp.ERRORS.INVALID_GAME_DATA) => ({
    errorCode,
    changed: false,
    payload: simulation.buildStartSimulatedPvpTestAckPayload(createPacketContext(), user, req, { errorCode }),
  });
  if (!socket || !socket.session || !user || !req.valid) return failure(asyncPvp.ERRORS.INVALID_REQUEST);

  const userUidA = toBigInt(req.playerUserUidA || 0);
  const userUidB = toBigInt(req.playerUserUidB || 0);
  if (userUidA <= 0n || userUidB <= 0n || userUidA === userUidB || userUidA !== toBigInt(user.userUid || 0)) {
    return failure(asyncPvp.ERRORS.INVALID_REQUEST);
  }
  const targetUser = Object.values(userDb.users || {}).find(
    (candidate) => candidate && toBigInt(candidate.userUid || 0) === userUidB
  );
  if (!targetUser) return failure(asyncPvp.ERRORS.TARGET_NOT_FOUND);

  const previousReplay = socket.session.gameReplay;
  if (previousReplay && previousReplay.dynamicGame && previousReplay.dynamicBattleResultSent !== true) {
    return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);
  }

  const deckReq = { selectDeckIndex: 0 };
  const validationOptions = { deckType: asyncPvp.NDT_PVP_DEFENCE, requiredState: 0, requireFullDeck: true };
  const ownValidation = validatePlayerDeckForGameLoad(user, deckReq, validationOptions);
  const targetValidation = validatePlayerDeckForGameLoad(targetUser, deckReq, validationOptions);
  if (!ownValidation.valid || !targetValidation.valid) return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);

  const buildOptions = {
    deckIndex: { deckType: asyncPvp.NDT_PVP_DEFENCE, index: 0 },
    strictSelection: true,
  };
  const playerDeck = buildPlayerDeckForGameLoad(user, deckReq, buildOptions);
  const playerDeckB = buildPlayerDeckForGameLoad(targetUser, deckReq, buildOptions);
  if (!playerDeck || !playerDeckB) return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);

  const replay = createGameReplayState();
  replay.inGameFlow = true;
  socket.session.gameReplay = replay;
  let activeReplay = replay;
  try {
    const loadReq = { stageID: 0, dungeonID: 0, gameType: simulation.NGT_PVE_SIMULATED, selectDeckIndex: 0 };
    const stage = {
      stageId: 0,
      dungeonID: 0,
      mapID: PRIVATE_PVP_MAP_ID,
      gameType: simulation.NGT_PVE_SIMULATED,
      miscMode: "pve-simulated",
      initialRemainGameTime: 180,
      respawnCostA1: 10,
      respawnCostB1: 10,
      playerDeck,
      playerDeckB,
      ignoreGameLoadTemplate: true,
    };
    const loaded = buildDynamicGameLoadPayload(socket, loadReq, stage);
    if (!loaded || !loaded.replay || !loaded.replay.dynamicGame || !loaded.replay.dynamicGame.managedCombat) {
      return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);
    }
    activeReplay = loaded.replay;
    activeReplay.dynamicGame.autoRespawnEnabled = true;
    activeReplay.dynamicGame.autoRespawnEnabledB = true;
    activeReplay.dynamicGame.autoSkillType = 1;
    activeReplay.dynamicGame.autoSkillTypeB = 1;

    const packets = [];
    let timeline = null;
    let nextFrameIndex = 0;
    for (let chunkIndex = 0; chunkIndex < 8; chunkIndex += 1) {
      const chunk = combatHandler.buildReplayChunk(activeReplay, {
        delta: 0.1,
        maxFrames: 600,
        startIndex: nextFrameIndex,
      });
      if (!chunk || !chunk.timeline) return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);
      timeline = chunk.timeline;
      packets.push(...chunk.packets);
      nextFrameIndex += 600;
      if (timeline.finished) break;
    }
    const loadComplete = packets.find((packet) => Number(packet.packetId) === GAME_LOAD_COMPLETE_ACK);
    const syncPayloads = packets
      .filter((packet) => Number(packet.packetId) === NPT_GAME_SYNC_DATA_PACK_NOT && Buffer.isBuffer(packet.payload))
      .map((packet) => packet.payload);
    const finalFrame = timeline && Array.isArray(timeline.frames) ? timeline.frames[timeline.frames.length - 1] : null;
    if (!timeline || !timeline.finished || !loadComplete || !syncPayloads.length || !finalFrame) {
      return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);
    }

    const winTeam = Number(timeline.winTeam || finalFrame.winTeam || 0);
    const pvpResult = winTeam === 1 ? 0 : winTeam === 3 ? 1 : 2;
    const playTime = Math.max(0, Number(finalFrame.playTime || finalFrame.gameTime || 0) || 0);
    const managedRecords = Array.isArray(timeline.records) ? timeline.records : [];
    const recordState = buildBattleGameRecordState(activeReplay.battleState || {}, { managedBattleRecords: managedRecords });
    const history = buildSimulatedPvpHistory(user, targetUser, activeReplay, pvpResult);
    const payload = simulation.buildStartSimulatedPvpTestAckPayload(createPacketContext(), user, req, {
      gameDataPayload: extractNullableGameDataFromGameLoadAckPayload(loaded.payload),
      gameRuntimeDataPayload: extractNullableGameRuntimeDataFromLoadCompletePayload(loadComplete.payload),
      syncPayloads,
      pvpResult,
      gameEndTime: playTime,
      gameRecordPayload: writeNullableObject(buildBattleGameRecordData(activeReplay, recordState, { playTime })),
      history,
    });
    user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
    user.pvp.asyncHistory = Array.isArray(user.pvp.asyncHistory) ? user.pvp.asyncHistory : [];
    user.pvp.asyncHistory.unshift(history);
    user.pvp.asyncHistory = user.pvp.asyncHistory.slice(0, 30);
    return { errorCode: 0, changed: true, payload };
  } catch (err) {
    console.log(`[simulated-pvp] managed replay failed: ${summarizeErrorLine(err)}`);
    return failure(asyncPvp.ERRORS.INVALID_GAME_DATA);
  } finally {
    if (activeReplay && activeReplay.dynamicGame) abandonDynamicBattle(socket, "simulated-pvp-replay");
    socket.session.gameReplay = previousReplay;
  }
}

function buildSimulatedPvpHistory(user, targetUser, replay, result) {
  const ownDeck = getProfileDefenceDeck(user);
  const targetDeck = getProfileDefenceDeck(targetUser);
  return {
    gameUid: String(replay && replay.dynamicGame && replay.dynamicGame.gameUID || 0),
    myUserLevel: Math.max(1, Number(user && user.level || 1) || 1),
    targetUserLevel: Math.max(1, Number(targetUser && targetUser.level || 1) || 1),
    targetNickName: String(targetUser && targetUser.nickname || ""),
    result: Number(result || 0),
    gainScore: 0,
    myTier: 0,
    myScore: 0,
    targetTier: 0,
    targetScore: 0,
    regdateTick: String(dateTimeTicksNow()),
    myDeckPayloadBase64: defence.buildAsyncDeckData({ ...user, defenceDeck: ownDeck }).toString("base64"),
    targetDeckPayloadBase64: defence.buildAsyncDeckData({ ...targetUser, defenceDeck: targetDeck }).toString("base64"),
    gameType: simulation.NGT_PVE_SIMULATED,
    targetFriendCode: String(targetUser && targetUser.friendCode || 0),
    sourceGuildUid: "0",
    sourceGuildName: "",
    sourceGuildBadgeId: "0",
    targetGuildUid: "0",
    targetGuildName: "",
    targetGuildBadgeId: "0",
    forfeitured: false,
    targetTitleId: Math.max(0, Number(targetUser && targetUser.titleId || 0) || 0),
  };
}

function getProfileDefenceDeck(user) {
  const decks = user && user.army && user.army.deckSets && user.army.deckSets[String(asyncPvp.NDT_PVP_DEFENCE)];
  return Array.isArray(decks) && decks[0] && typeof decks[0] === "object" ? decks[0] : null;
}

function extractNullableGameRuntimeDataFromLoadCompletePayload(payload) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const errorCode = readSignedVarInt(raw, 0);
  if (errorCode.value !== 0 || errorCode.offset >= raw.length) throw new Error("managed load-complete ACK failed");
  const isIntrude = raw.readUInt8(errorCode.offset);
  if (isIntrude !== 0 && isIntrude !== 1) throw new Error("managed load-complete ACK has a noncanonical bool");
  const start = errorCode.offset + 1;
  if (start >= raw.length || raw.readUInt8(start) === 0 || raw.length <= start + 1) {
    throw new Error("managed load-complete ACK has no runtime data");
  }
  const rewardMultiply = readSignedVarInt(raw, raw.length - 1);
  if (rewardMultiply.offset !== raw.length) throw new Error("managed load-complete ACK has an invalid reward multiplier");
  return raw.subarray(start, raw.length - 1);
}

function finishAsyncPvpSimulation(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const meta = replay && replay.asyncPvpBattle;
  if (!replay || !replay.dynamicGame || !meta || !meta.simulationGame || meta.resultRecorded) return false;
  const playerDeck = replay.dynamicGame.playerDeck || {};
  const playerPower = Math.max(0, Number(playerDeck.operationPower || 0) || 0) ||
    (Array.isArray(playerDeck.units) ? playerDeck.units : [])
      .reduce((sum, unit) => sum + Math.max(1, Number(unit && unit.level || 1) || 1) * 1000, 0);
  const win = playerPower >= Math.max(0, Number(meta.targetSnapshot && meta.targetSnapshot.operationPower || 0) || 0);
  const battleState = replay.battleState || {};
  normalizeBattleResultState(battleState, win);
  battleState.gameTime = 1;
  replay.battleState = battleState;
  const payload = asyncPvp.buildAsyncPvpGameEndNotPayload(createPacketContext(), socket, replay, {
    battleState,
    win,
    battleWinTeam: win ? 1 : 3,
    playTime: 1,
  });
  if (!payload) return false;
  sendServerGamePacket(socket, asyncPvp.PACKETS.GAME_END_NOT, payload, "async-pvp-simulation-end");
  replay.dynamicBattleResultSent = true;
  abandonDynamicBattle(socket, "async-pvp-simulation");
  return true;
}

function failStandardPvpMatch(match, errorCode) {
  pvpMatchmaking.fail(match);
  for (const member of match && match.members || []) {
    if (member.socket && !member.socket.destroyed) {
      sendServerGamePacket(member.socket, 2605, writeSignedVarInt(errorCode), "pvp-match-failed");
    }
  }
  return false;
}

function failLeaguePvpMatch(match, errorCode) {
  clearStandardPvpSessions(match);
  leaguePvpMatchmaking.fail(match, createPacketContext(), errorCode);
  return false;
}

function clearStandardPvpSessions(match) {
  for (const member of match && match.members || []) {
    const session = member.socket && member.socket.session;
    if (!session) continue;
    delete session.standardPvpMatch;
    delete session.standardPvpMember;
    if (session.privatePvpRoom === match) delete session.privatePvpRoom;
    if (session.privatePvpMember === member) delete session.privatePvpMember;
    delete session.privatePvpTeamType;
  }
}

function finishPrivatePvpGiveup(socket) {
  const room = privatePvp.getRoom(socket);
  const member = privatePvp.getMember(socket);
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!room || !member || !room.matchStarted || !replay) return false;
  const winTeam = Number(member.teamType) === 1 ? 3 : 1;
  replay.battleState = replay.battleState || {};
  replay.battleState.finished = true;
  replay.battleState.win = winTeam === 1;
  replay.battleState.gameState = { ...(replay.battleState.gameState || {}), state: 4, winTeam };
  sendDynamicFinishStateSync(socket, replay.battleState, "private-pvp-giveup-finish");
  for (const viewer of room.members) {
    if (!viewer.socket || viewer.socket.destroyed) continue;
    const payload = room.standardPvp
      ? buildStandardPvpGameEndNotPayload(replay, room, viewer, winTeam, { battleWinTeam: winTeam, giveup: true })
      : buildPrivatePvpGameEndNotPayload(replay, viewer, winTeam, { battleWinTeam: winTeam });
    sendServerGamePacket(
      viewer.socket,
      GAME_END_NOT,
      payload,
      room.standardPvp ? "pvp-match-giveup-end" : "private-pvp-giveup-end"
    );
  }
  markPrivatePvpMatchFinished(socket);
  markStandardPvpMatchFinished(socket);
  return true;
}

function markPrivatePvpMatchFinished(socket) {
  const room = privatePvp.getRoom(socket);
  if (!room || !room.matchStarted || room.matchFinished) return false;
  room.matchFinished = true;
  room.battleStarted = false;
  if (room.replay) {
    room.replay.dynamicBattleResultSent = true;
    combatHandler.disposeBattle(room.replay);
  }
  console.log(`[private-pvp] finished room=${room.code}`);
  return true;
}

function resetPrivatePvpMatch(room) {
  if (!room || !room.matchFinished) return false;
  room.state = 6;
  room.matchStarted = false;
  room.matchFinished = false;
  room.battleStarted = false;
  room.gameDataPayload = null;
  room.replay = null;
  for (const member of room.members) {
    member.ready = false;
    member.loaded = false;
    member.playerState = 1;
    if (member.socket) {
      const lobbyReplay = createGameReplayState();
      lobbyReplay.inGameFlow = true;
      member.socket.session.gameReplay = lobbyReplay;
    }
  }
  privatePvp.broadcastState(room, createPacketContext());
  return true;
}

function handleDynamicBattleRespawn(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleDeploy({ replay, req, teamType: socket.session.privatePvpTeamType || 1 });
  if (!result || !result.handled || !result.ackPayload) return false;
  const errorCode = Number(result.errorCode ?? readSignedVarInt(result.ackPayload, 0).value);
  if (result.mode === "managed-local-server") {
    const packets = Array.isArray(result.packets) ? result.packets : [];
    if (packets.length > 0) {
      sendManagedOrImmediatePackets(socket, packets);
    } else if (result.ackPayload) {
      sendServerGamePacket(socket, GAME_RESPAWN_ACK, result.ackPayload, "managed-respawn");
    }
    if (errorCode === 0) {
      replay.lastRespawnReq = req;
      startDynamicBattleManager(socket, "respawn");
    }
    console.log(`[combat-host] deploy ${errorCode === 0 ? "accepted" : `rejected error=${errorCode}`} unitUID=${req.unitUID} packets=${packets.length}`);
    return true;
  }
  const ackLabel = result.mode === "battleState" ? "battle-continuation-respawn" : "battle-manager-respawn";
  sendServerGamePacket(socket, GAME_RESPAWN_ACK, result.ackPayload, ackLabel);
  if (errorCode === 0) replay.lastRespawnReq = req;
  if (errorCode === 0 && result.syncPayload) {
    sendServerGamePacket(socket, NPT_GAME_SYNC_DATA_PACK_NOT, result.syncPayload, "battle-continuation-deploy-sync");
  }
  if (result.mode === "battleState") {
    if (errorCode === 0 && result.deployed) {
      console.log(
        `[battle-continuation] deploy unitUID=${req.unitUID} gameUnitUID=${result.deployed.gameUnitUID} x=${result.deployed.x.toFixed(
          2
        )} hp=${result.deployed.hp}`
      );
      startDynamicBattleManager(socket, "deploy");
    } else {
      console.log(`[battle-continuation] respawn rejected error=${errorCode} unitUID=${req.unitUID}`);
    }
  } else if (errorCode === 0 && result.spawned && result.spawned.length) {
    startDynamicBattleManager(socket, "respawn");
    console.log(
      `[battle-manager] deploy gameUnitUIDs=${result.spawned.map((unit) => unit.gameUnitUID).join(",")} unitUID=${req.unitUID} x=${result.spawned[0].x.toFixed(
        1
      )} cost=${result.spawned[0].cost}`
    );
  } else {
    console.log(`[battle-manager] no unused gameUnitUID available for deploy unitUID=${req.unitUID}`);
  }
  return true;
}

function handleDynamicBattlePause(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  // 812 is part of the combat timeline. Forward it to NKCGameServerLocal so
  // tutorial prompt pauses affect client and server together. The Node pump
  // stays alive; it must not add a second transport-level pause on top.
  const result = combatHandler.handlePause({ replay, req });
  if (result && result.handled && result.ackPayload) {
    const errorCode = readSignedVarInt(result.ackPayload, 0).value;
    sendManagedOrImmediatePackets(socket, result.packets);
    if (errorCode === 0) replay.dynamicBattlePaused = Boolean(req.isPause);
  } else if (!replay.dynamicGame.managedCombat) {
    replay.dynamicBattlePaused = Boolean(req.isPause);
    sendServerGamePacket(socket, GAME_PAUSE_ACK, buildGamePauseAckPayload(req.isPause, req.isPauseEvent), "battle-manager-pause");
  } else {
    return false;
  }
  replay.pauseCount += 1;
  console.log(`[battle-manager] pause=${req.isPause ? 1 : 0} pauseEvent=${req.isPauseEvent ? 1 : 0} pump=alive`);
  if (replay.dynamicGame && !replay.dynamicBattleTimer) {
    startDynamicBattleManager(socket, "pause-resume");
  }
  return true;
}

function handleDynamicBattleUnitSkill(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleUnitSkill({ replay, req, teamType: socket.session.privatePvpTeamType || 1 });
  if (result && result.handled && (result.packets || []).some((packet) => packet.packetId === GAME_USE_UNIT_SKILL_ACK)) {
    sendManagedOrImmediatePackets(socket, result.packets);
    console.log(
      `[combat-host] unit skill gameUnitUID=${req.gameUnitUID} packets=${(result.packets || []).length}`
    );
    return true;
  }
  return false;
}

function handleDynamicBattleShipSkill(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleShipSkill({ replay, req, teamType: socket.session.privatePvpTeamType || 1 });
  if (result && result.handled && (result.packets || []).some((packet) => packet.packetId === GAME_SHIP_SKILL_ACK)) {
    sendManagedOrImmediatePackets(socket, result.packets);
    console.log(
      `[combat-host] ship skill gameUnitUID=${req.gameUnitUID} shipSkillID=${req.shipSkillID} x=${req.skillPosX.toFixed(
        1
      )} packets=${(result.packets || []).length}`
    );
    return true;
  }
  return false;
}

function handleDynamicBattleCheckDie(socket) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER) return false;
  const result = combatHandler.handleCheckDie({ replay, teamType: socket.session.privatePvpTeamType || 1 });
  if (!result || !result.handled) return false;
  sendManagedOrImmediatePackets(socket, result.packets);
  return true;
}

function handleDynamicBattleUnitRetreat(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleUnitRetreat({ replay, req, teamType: socket.session.privatePvpTeamType || 1 });
  if (!result || !result.handled) return false;
  sendManagedOrImmediatePackets(socket, result.packets);
  return true;
}

function handleDynamicBattleTacticalCommand(socket, req) {
  const replay = socket.session && socket.session.gameReplay;
  if (!replay || !DYNAMIC_BATTLE_MANAGER || !req) return false;
  const result = combatHandler.handleTacticalCommand({ replay, req, teamType: socket.session.privatePvpTeamType || 1 });
  if (!result || !result.handled) return false;
  sendManagedOrImmediatePackets(socket, result.packets);
  return true;
}

function deployStageLineup(replay) {
  return combatHandler.deployStageLineup(replay);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function logCapturedClientPacketMatch(packet, clientIndex, label) {
  const entry = capturedGameFlow.client && capturedGameFlow.client[clientIndex - 1];
  if (!entry || !entry.payload) return;
  const actual = packet.payload.toString("hex");
  const expected = entry.payload.toString("hex");
  console.log(
    `[capture-game:${label}] clientPayloadMatch=${actual === expected ? 1 : 0} actualSize=${packet.payload.length} expectedSize=${
      entry.payload.length
    }`
  );
}

function maybeSendTutorialCutsceneClear(socket, payload) {
  if (!SKIP_TUTORIAL_CUTSCENE) return;
  const req = decodeGameLoadReq(payload);
  if (!req || !isTutorialDungeonId(req.dungeonID)) return;
  sendServerGamePacket(
    socket,
    CUTSCENE_DUNGEON_CLEAR_ACK,
    buildCutsceneDungeonClearAckPayload(req.dungeonID, socket && socket.session && socket.session.user),
    `tutorial-cutscene-clear dungeonID=${req.dungeonID}`
  );
}

function readCutsceneDungeonReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    const dungeon = readSignedVarInt(decrypted, 0);
    return {
      valid: dungeon.offset === decrypted.length && writeSignedVarInt(dungeon.value).equals(decrypted),
      dungeonId: Number(dungeon.value),
    };
  } catch (err) {
    console.log(`[CUTSCENE_DUNGEON_REQ] decode failed: ${err.message}`);
    return { valid: false, dungeonId: 0 };
  }
}

function getCutsceneStage(dungeonId) {
  const resolvedDungeonId = positiveInt(dungeonId);
  if (!resolvedDungeonId || !getDungeonTableEntry(resolvedDungeonId)) return null;
  const stage = getMainStoryStageByDungeonId(resolvedDungeonId) || getGenericStageForRequest({ dungeonID: resolvedDungeonId });
  const stageId = positiveInt(stage && stage.stageId) || stageIdForDungeonId(resolvedDungeonId);
  return isCutsceneOnlyDungeon(resolvedDungeonId, stageId) ? { ...stage, stageId, dungeonID: resolvedDungeonId } : null;
}

function isValidCutsceneDungeonId(dungeonId) {
  return Boolean(getCutsceneStage(dungeonId));
}

function commitCutsceneDungeonClear(socket, dungeonId) {
  const user = socket && socket.session && socket.session.user;
  const stage = getCutsceneStage(dungeonId);
  if (!user || !stage) return { changed: false, alreadyCleared: false };
  const key = String(stage.dungeonID);
  const alreadyCleared = Boolean(
    (user.dungeonClear && user.dungeonClear[key]) ||
      (user.clearConditions && user.clearConditions.dungeons && user.clearConditions.dungeons[key] && user.clearConditions.dungeons[key].cleared)
  );
  if (alreadyCleared) return { changed: false, alreadyCleared: true };

  let changed = recordPersistentCutsceneViewForUser(user, stage.dungeonID, stage.stageId, { save: false });
  if (recordGameplayUnlockClearForUser(user, stage.dungeonID, stage.stageId, { save: false })) changed = true;
  if (isTutorialDungeonId(stage.dungeonID)) {
    if (recordTutorialDungeonClearForUser(user, stage.dungeonID, stage.stageId, {}, { save: false })) changed = true;
  } else if (isMainStoryDungeonId(stage.dungeonID)) {
    if (recordMainStoryDungeonClearForUser(user, stage.dungeonID, stage.stageId, {}, { save: null })) changed = true;
    grantStageClearExp(user, stage.stageId, stage.dungeonID);
    trackStageClearMissionProgress(user, stage.dungeonID, stage.stageId, {});
    sendStageClearMissionUpdate(socket, user);
  }
  if (changed) {
    invalidateJoinLobbyAckPayloadCache("cutscene-dungeon-clear");
    if (USE_LOCAL_USER_DB) saveUserDb();
  }
  return { changed, alreadyCleared: false };
}

function isKnownNonTutorialDungeonId(dungeonId) {
  const resolvedDungeonId = positiveInt(dungeonId);
  return resolvedDungeonId > 0 && !isTutorialDungeonId(resolvedDungeonId) && Boolean(getDungeonTableEntry(resolvedDungeonId));
}

function isKnownNonTutorialCutsceneDungeonId(dungeonId) {
  const resolvedDungeonId = positiveInt(dungeonId);
  return (
    isKnownNonTutorialDungeonId(resolvedDungeonId) &&
    isCutsceneOnlyDungeon(resolvedDungeonId, stageIdForDungeonId(resolvedDungeonId))
  );
}

function resolveCutsceneDungeonId(socket, decodedDungeonId) {
  const decoded = Number(decodedDungeonId || 0);
  if (isMainStoryDungeonId(decoded) && !isTutorialDungeonId(decoded)) return decoded;
  if (isKnownNonTutorialCutsceneDungeonId(decoded)) return decoded;
  const replay = socket && socket.session && socket.session.gameReplay;
  const requestedDungeonId = Number(replay && replay.lastGameLoadReq && replay.lastGameLoadReq.dungeonID);
  if (!decoded && isMainStoryDungeonId(requestedDungeonId) && !isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  if (!decoded && isKnownNonTutorialCutsceneDungeonId(requestedDungeonId)) return requestedDungeonId;
  if (!decoded && isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  const activeBattleFinished =
    replay &&
    (replay.tutorialClearRecorded ||
      replay.dynamicBattleResultSent ||
      (replay.battleState && (replay.battleState.finished || replay.battleState.Finished)));
  const user = socket && socket.session && socket.session.user;
  if (isTutorialDungeonId(decoded)) {
    if ((!replay || activeBattleFinished) && isTutorialDungeonCleared(user, decoded)) {
      return nextTutorialDungeonIdForUser(user);
    }
    return decoded;
  }
  const activeDungeonId = Number(replay && replay.dynamicGame && replay.dynamicGame.dungeonID);
  if (isMainStoryDungeonId(activeDungeonId) && !isTutorialDungeonId(activeDungeonId)) return activeDungeonId;
  if (isKnownNonTutorialCutsceneDungeonId(activeDungeonId)) return activeDungeonId;
  if (isTutorialDungeonId(activeDungeonId) && !activeBattleFinished) return activeDungeonId;
  return nextTutorialDungeonIdForUser(user);
}

function resolveCutsceneClearDungeonId(socket, decodedDungeonId) {
  const decoded = Number(decodedDungeonId || 0);
  if (isMainStoryDungeonId(decoded) && !isTutorialDungeonId(decoded)) return decoded;
  if (isKnownNonTutorialCutsceneDungeonId(decoded)) return decoded;
  if (isTutorialDungeonId(decoded)) return decoded;
  const replay = socket && socket.session && socket.session.gameReplay;
  const requestedDungeonId = Number(replay && replay.lastGameLoadReq && replay.lastGameLoadReq.dungeonID);
  if (!decoded && isMainStoryDungeonId(requestedDungeonId) && !isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  if (!decoded && isKnownNonTutorialCutsceneDungeonId(requestedDungeonId)) return requestedDungeonId;
  if (!decoded && isTutorialDungeonId(requestedDungeonId)) return requestedDungeonId;
  const activeDungeonId = Number(replay && replay.dynamicGame && replay.dynamicGame.dungeonID);
  if (isMainStoryDungeonId(activeDungeonId) && !isTutorialDungeonId(activeDungeonId)) return activeDungeonId;
  if (isKnownNonTutorialCutsceneDungeonId(activeDungeonId)) return activeDungeonId;
  if (isTutorialDungeonId(activeDungeonId)) return activeDungeonId;
  return nextTutorialDungeonIdForUser(socket && socket.session && socket.session.user);
}

function nextTutorialDungeonIdForUser(user) {
  const tutorial = ensureTutorialState(user);
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[tutorialPhaseKey(stage)];
    if (!phase || phase.completed !== true) return stage.dungeonID;
  }
  return TUTORIAL_STAGE_CHAIN[0].dungeonID;
}

function isTutorialDungeonCleared(user, dungeonId) {
  const stage = TUTORIAL_STAGE_CHAIN.find((candidate) => candidate.dungeonID === Number(dungeonId));
  if (!stage) return false;
  const tutorial = ensureTutorialState(user);
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  const phase = phases[tutorialPhaseKey(stage)];
  return Boolean(phase && phase.completed === true);
}

function scrubTutorialEpisodeClearProgress(user) {
  if (!user || typeof user !== "object") return false;
  let changed = false;
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const tutorialDungeonIds = new Set(TUTORIAL_STAGE_CHAIN.map((stage) => Number(stage.dungeonID)));
  const tutorialStageIds = new Set(TUTORIAL_STAGE_CHAIN.map((stage) => Number(stage.stageId)));
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    if (Object.prototype.hasOwnProperty.call(user.dungeonClear, String(stage.dungeonID))) {
      delete user.dungeonClear[String(stage.dungeonID)];
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(user.stagePlayData, String(stage.stageId))) {
      delete user.stagePlayData[String(stage.stageId)];
      changed = true;
    }
  }
  if (user.clearConditions && typeof user.clearConditions === "object") {
    const clearDungeons =
      user.clearConditions.dungeons && typeof user.clearConditions.dungeons === "object" ? user.clearConditions.dungeons : null;
    const clearStages =
      user.clearConditions.stages && typeof user.clearConditions.stages === "object" ? user.clearConditions.stages : null;
    if (clearDungeons) {
      for (const dungeonId of tutorialDungeonIds) {
        const key = String(dungeonId);
        if (Object.prototype.hasOwnProperty.call(clearDungeons, key)) {
          delete clearDungeons[key];
          changed = true;
        }
      }
    }
    if (clearStages) {
      for (const stageId of tutorialStageIds) {
        const key = String(stageId);
        if (Object.prototype.hasOwnProperty.call(clearStages, key)) {
          delete clearStages[key];
          changed = true;
        }
      }
    }
  }
  if (user.gameplayUnlocks && typeof user.gameplayUnlocks === "object") {
    const removedUnlockKeys = new Set();
    const byDungeon =
      user.gameplayUnlocks.byDungeon && typeof user.gameplayUnlocks.byDungeon === "object" ? user.gameplayUnlocks.byDungeon : null;
    const byKey = user.gameplayUnlocks.byKey && typeof user.gameplayUnlocks.byKey === "object" ? user.gameplayUnlocks.byKey : null;
    if (byDungeon) {
      for (const dungeonId of tutorialDungeonIds) {
        const key = String(dungeonId);
        const unlockKeys = Array.isArray(byDungeon[key]) ? byDungeon[key] : [];
        for (const unlockKey of unlockKeys) removedUnlockKeys.add(String(unlockKey));
        if (Object.prototype.hasOwnProperty.call(byDungeon, key)) {
          delete byDungeon[key];
          changed = true;
        }
      }
    }
    if (byKey) {
      for (const [key, unlock] of Object.entries(byKey)) {
        const stageId = Number(unlock && unlock.stageId);
        const reqValue = Number(unlock && unlock.reqValue);
        if (removedUnlockKeys.has(String(key)) || tutorialStageIds.has(stageId) || tutorialDungeonIds.has(reqValue)) {
          delete byKey[key];
          changed = true;
        }
      }
    }
  }
  if (user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object") {
    for (const [key, view] of Object.entries(user.persistentCutsceneViews)) {
      const dungeonId = Number((view && view.dungeonId) || key);
      const stageId = Number((view && view.stageId) || key);
      if (tutorialDungeonIds.has(dungeonId) || tutorialStageIds.has(stageId)) {
        delete user.persistentCutsceneViews[key];
        changed = true;
      }
    }
  }
  if (normalizeTutorialPhaseOrder(user)) changed = true;
  if (user.mainStory && typeof user.mainStory === "object") {
    user.mainStory.completed = false;
  }
  if (user.episode1 && typeof user.episode1 === "object") {
    user.episode1.completed = false;
  }
  return changed;
}

function normalizeTutorialPhaseOrder(user) {
  if (!user || typeof user !== "object") return false;
  const tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : null;
  if (!tutorial || !phases) return false;
  if (user.loginFlow === "post-tutorial" || tutorial.loginMode === "post-tutorial" || tutorial.completed === true) return false;
  let changed = false;
  let foundOpenPhase = false;
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const key = tutorialPhaseKey(stage);
    const phase = phases[key] || phases[String(stage.stageId)];
    if (!phase || typeof phase !== "object") {
      foundOpenPhase = true;
      continue;
    }
    if (foundOpenPhase || phase.completed !== true) {
      if (phase.completed !== false || phase.completedAt || Number(phase.bestClearTimeSec || 0) !== 0) changed = true;
      phase.completed = false;
      phase.completedAt = "";
      phase.bestClearTimeSec = 0;
      foundOpenPhase = true;
    }
  }
  if (foundOpenPhase) {
    if (tutorial.completed !== false || tutorial.completedAt || tutorial.loginMode === "post-tutorial") changed = true;
    tutorial.completed = false;
    tutorial.completedAt = "";
    if (tutorial.loginMode === "post-tutorial") delete tutorial.loginMode;
  }
  return changed;
}

function isRaidDynamicGame(dynamicGame = {}) {
  if (!dynamicGame || typeof dynamicGame !== "object") return false;
  if (toBigInt(dynamicGame.raidUID || dynamicGame.raidUid || 0) > 0n) return true;
  const gameType = Number(dynamicGame.gameType || dynamicGame.GameType || 0);
  return gameType === NGT_RAID || gameType === NGT_RAID_SOLO;
}

function syncRaidCombatHpForReplay(socket, replay, label = "raid-hp") {
  const dynamicGame = replay && replay.dynamicGame;
  if (!isRaidDynamicGame(dynamicGame)) return false;
  const user = socket && socket.session && socket.session.user;
  if (!user || typeof worldMap.syncRaidCombatHpFromBattleState !== "function") return false;
  const raidUID = toBigInt(dynamicGame.raidUID || dynamicGame.raidUid || 0);
  if (raidUID <= 0n) return false;
  const result = worldMap.syncRaidCombatHpFromBattleState(user, raidUID, replay.battleState || {}, {
    now: dateTimeBinaryNow(),
  });
  if (!result || !result.changed) return false;
  const raid = result.raid || {};
  console.log(
    `[${label}] raidUID=${raidUID} stageID=${dynamicGame.stageID || 0} maxHP=${Number(raid.maxHP || raid.maxHp || 0)} curHP=${Number(raid.curHP || raid.curHp || 0)}`
  );
  if (USE_LOCAL_USER_DB) saveUserDb();
  return true;
}

function maybeRecordRaidBattleResultForReplay(replay, override = {}, resolvedWin = null) {
  const dynamicGame = replay && replay.dynamicGame;
  if (!isRaidDynamicGame(dynamicGame)) return null;
  const user = override.user;
  if (!user) return null;
  const raidUID = toBigInt(dynamicGame.raidUID || dynamicGame.raidUid || override.raidUID || override.raidUid || 0);
  if (raidUID <= 0n) return null;
  const gameUID = dynamicGame.gameUID || dynamicGame.gameUid || "";
  const battleKey = String(override.battleKey || `raid:${raidUID}:${gameUID || `${dynamicGame.stageID || 0}:${dynamicGame.dungeonID || 0}`}`);
  if (replay.raidBattleResult && replay.raidBattleResult.battleKey === battleKey) {
    return replay.raidBattleResult.result;
  }
  const battleState = override.battleState || replay.battleState || {};
  const win =
    typeof resolvedWin === "boolean"
      ? resolvedWin
      : resolveBattleWin(battleState, { ...override, fallbackWin: false, preferFallbackWin: false });
  const result = worldMap.recordRaidBattleResult(user, raidUID, {
    now: dateTimeBinaryNow(),
    win,
    giveup: Boolean(override.giveup || false),
    battleState,
    gameUID,
    battleKey,
    tryAssist: Boolean(dynamicGame.isTryAssist || override.isTryAssist),
    buffList: Array.isArray(dynamicGame.buffList) ? dynamicGame.buffList : [],
    raidCostItemId: dynamicGame.raidCostItemId == null ? undefined : Number(dynamicGame.raidCostItemId),
    raidCostCount: dynamicGame.raidCostCount == null ? undefined : Number(dynamicGame.raidCostCount),
  });
  replay.raidBattleResult = { battleKey, result };
  if (USE_LOCAL_USER_DB) saveUserDb();
  return result;
}

function sendRaidStateDataForSocket(socket, label = "raid-state") {
  const user = socket && socket.session && socket.session.user;
  if (!user) return false;
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!isRaidDynamicGame(replay && replay.dynamicGame)) return false;
  const ctx = {
    sendServerGamePacket,
    config: { USE_LOCAL_USER_DB },
    saveUserDb,
  };
  const now = dateTimeBinaryNow();
  return worldMap.sendRaidSnapshotData(ctx, socket, user, {
    now,
    includeWorldMap: true,
    worldMapLabel: `${label}-world-map-data`,
    label: `${label}-my-raid-list`,
    detailLabel: `${label}-raid-detail`,
    coopLabel: `${label}-raid-coop-list`,
    resultLabel: `${label}-raid-result-list`,
    eventCancelLabel: `${label}-raid-event-clear`,
    includeEmpty: true,
  });
}

function maybeRecordDynamicBattleClear(socket, overrideState = null) {
  const replay = socket && socket.session && socket.session.gameReplay;
  if (!replay || !replay.dynamicGame || replay.dynamicGame.tutorial) return false;
  if ([
    6,
    leaguePvp.NGT_PVP_LEAGUE,
    leaguePvp.NGT_PVP_UNLIMITED,
    eventPvp.NGT_PVP_EVENT,
    asyncPvp.NGT_ASYNC_PVP,
    asyncPvp.NGT_PVP_STRATEGY,
    asyncPvp.NGT_PVP_STRATEGY_REVENGE,
    asyncPvp.NGT_PVP_STRATEGY_NPC,
  ].includes(Number(replay.dynamicGame.gameType || 0))) return false;
  if (Number(replay.dynamicGame.diveStageID || 0) > 0 || Number(replay.dynamicGame.gameType || 0) === NGT_DIVE) return false;
  if (String(replay.dynamicGame.miscMode || "").startsWith("guild-dungeon")) {
    return guildDungeon.commitBattleResult(createPacketContext(), socket, replay, overrideState);
  }
  if (isRaidDynamicGame(replay.dynamicGame)) {
    const lastEnd = replay.lastDynamicGameEndResult || null;
    if (!lastEnd) return false;
    maybeRecordRaidBattleResultForReplay(replay, {
      user: socket && socket.session && socket.session.user,
      battleState: lastEnd.battleState || overrideState || replay.battleState || {},
      giveup: Boolean(lastEnd.giveup),
    }, typeof lastEnd.win === "boolean" ? lastEnd.win : null);
    return false;
  }
  const lastEnd = replay.lastDynamicGameEndResult || null;
  const dynamicDungeonId = Number(replay.dynamicGame.dungeonID || 0);
  const dynamicStageId = Number(replay.dynamicGame.stageID || stageIdForDungeonId(dynamicDungeonId) || 0);
  const lastEndMatches =
    lastEnd &&
    Number(lastEnd.dungeonId || 0) === dynamicDungeonId &&
    Number(lastEnd.stageId || 0) === dynamicStageId;
  const battleState = (lastEndMatches && lastEnd.battleState) || overrideState || replay.battleState || {};
  const authoritativeWin = Boolean(lastEndMatches && lastEnd.win === true && !lastEnd.giveup);
  const killCountSaved = commitKillCountBattleResult(socket);
  if (Number(replay.dynamicGame.gameType || 0) === NGT_PHASE || String(replay.dynamicGame.miscMode || "") === "phase") {
    const result = replay.phaseBattleResult;
    if (!result || result.valid !== true) return killCountSaved;
    if (result.changed && !result.persisted) {
      result.persisted = true;
      const user = socket && socket.session && socket.session.user;
      if (result.completed) {
        const progressState = {
          ...battleState,
          gameTime: result.totalPlayTime,
          GameTime: result.totalPlayTime,
          missionResult1: result.clearData.missionResult1,
          missionResult2: result.clearData.missionResult2,
          missionResults: {
            missionResult1: result.clearData.missionResult1,
            missionResult2: result.clearData.missionResult2,
          },
        };
        const storyStage = getMainStoryStageByStageId(result.stageId);
        const recorded = storyStage
          ? recordMainStoryDungeonClearForUser(user, result.dungeonId, result.stageId, progressState, { save: null })
          : recordGenericDungeonClearForUser(user, result.dungeonId, result.stageId, progressState, { save: false });
        if (recorded) {
          grantStageClearExp(user, result.stageId, result.dungeonId, { exp: result.loot.userExp });
          recordGameplayUnlockClearForUser(user, result.dungeonId, result.stageId, { save: false });
          trackStageClearMissionProgress(user, result.dungeonId, result.stageId, progressState);
          sendStageClearMissionUpdate(socket, user);
        }
      }
      replay.stageReqItemCostPersisted = replay.stageReqItemCostChanged === true;
      invalidateJoinLobbyAckPayloadCache("phase-battle-result");
      if (USE_LOCAL_USER_DB) saveUserDb();
      return true;
    }
    return killCountSaved;
  }
  if (String(replay.dynamicGame.miscMode || "").toLowerCase() === "trim" || Number(replay.dynamicGame.gameType || 0) === NGT_TRIM) {
    const result = replay.trimBattleResult;
    if (!result || result.valid !== true) return killCountSaved;
    if (result.changed && !result.persisted) {
      result.persisted = true;
      invalidateJoinLobbyAckPayloadCache("trim-battle-result");
      if (USE_LOCAL_USER_DB) saveUserDb();
      return true;
    }
    return killCountSaved;
  }
  if (String(replay.dynamicGame.miscMode || "").toLowerCase() === "explore" || Number(replay.dynamicGame.gameType || 0) === NGT_EXPLORE) {
    const result = replay.exploreBattleResult;
    if (!result || result.valid !== true) return killCountSaved;
    if (result.changed && !result.persisted) {
      result.persisted = true;
      invalidateJoinLobbyAckPayloadCache("explore-battle-result");
      if (USE_LOCAL_USER_DB) saveUserDb();
      return true;
    }
    return killCountSaved;
  }
  if (isDefenceDynamicGame(replay.dynamicGame) && !authoritativeWin) {
    const user = socket && socket.session && socket.session.user;
    const changed = recordMiscStageClearForUser(user, dynamicDungeonId, dynamicStageId, battleState);
    replay.stageReqItemCostPersisted = replay.stageReqItemCostChanged === true;
    invalidateJoinLobbyAckPayloadCache("defence-battle-result");
    if (USE_LOCAL_USER_DB) saveUserDb();
    return changed || killCountSaved;
  }
  const shadowBattleResult = replay.shadowPalaceBattleResult;
  if (shadowBattleResult && shadowBattleResult.persisted) return killCountSaved;
  if (shadowBattleResult && shadowBattleResult.valid === false) return killCountSaved;
  if (!authoritativeWin && !isBattleWin(battleState)) {
    if (!shadowBattleResult || !shadowBattleResult.changed) {
      return commitStageReqItemCostForReplay(replay) || killCountSaved;
    }
    shadowBattleResult.persisted = true;
    replay.stageReqItemCostPersisted = replay.stageReqItemCostChanged === true;
    invalidateJoinLobbyAckPayloadCache("shadow-palace-battle-result");
    if (USE_LOCAL_USER_DB) saveUserDb();
    console.log(
      `[shadow-palace-progress] loss uid=${socket && socket.session && socket.session.user && socket.session.user.userUid || "(none)"} palaceID=${shadowBattleResult.palaceId} dungeonID=${dynamicDungeonId} life=${shadowBattleResult.life}`
    );
    return true;
  }
  const saved =
    recordMainStoryDungeonClear(socket, lastEndMatches ? lastEnd.dungeonId : undefined, battleState) ||
    recordGenericDungeonClear(socket, lastEndMatches ? lastEnd.dungeonId : undefined, battleState);
  if (shadowBattleResult && saved) {
    shadowBattleResult.persisted = true;
    invalidateJoinLobbyAckPayloadCache("shadow-palace-battle-result");
  }
  return saved || killCountSaved;
}

function commitKillCountBattleResult(socket) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const result = replay && replay.killCountBattleResult;
  if (!result || !result.eligible) return false;
  if (result.changed && !result.persisted) {
    result.persisted = true;
    invalidateJoinLobbyAckPayloadCache("kill-count-battle-result");
    if (USE_LOCAL_USER_DB) saveUserDb();
  }
  if (!result.pushed) {
    result.pushed = true;
    sendServerGamePacket(
      socket,
      killCount.PACKETS.SERVER_KILL_COUNT_NOT,
      killCount.buildServerKillCountNotPayload({ userDb }),
      "kill-count-server-total"
    );
  }
  return result.changed;
}

function commitStageReqItemCostForReplay(replay) {
  if (!replay || replay.stageReqItemCostChanged !== true || replay.stageReqItemCostPersisted === true) return false;
  replay.stageReqItemCostPersisted = true;
  invalidateJoinLobbyAckPayloadCache("battle-entry-cost");
  if (USE_LOCAL_USER_DB) saveUserDb();
  return true;
}

function recordMainStoryDungeonClear(socket, dungeonId, battleState = null) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const resolvedDungeonId = Number(dungeonId || dynamicGame.dungeonID || 0);
  if (!resolvedDungeonId || !isMainStoryDungeonId(resolvedDungeonId) || isTutorialDungeonId(resolvedDungeonId)) return false;
  const resolvedStageId = stageIdForDungeonId(resolvedDungeonId);
  const user = socket && socket.session && socket.session.user;
  const rewardMultiply = Math.max(1, Math.trunc(Number(dynamicGame.rewardMultiply || 1)) || 1);
  const state = battleState || (replay && replay.battleState) || {};
  const missionResults = resolveDungeonMissionResults(resolvedDungeonId, {
    stageId: resolvedStageId,
    win: true,
    battleState: state,
    forceMissionSuccess: false,
  });
  if (state && typeof state === "object") {
    state.missionResult1 = missionResults.missionResult1;
    state.missionResult2 = missionResults.missionResult2;
    state.missionResults = { ...missionResults };
  }
  const saved = recordMainStoryDungeonClearForUser(user, resolvedDungeonId, resolvedStageId, state, {
    save: null,
    forceMissionSuccess: false,
    playCountDelta: rewardMultiply,
  });
  if (saved) {
    const stageLoot = maybeGrantBattleStageClearLoot(replay, user, resolvedDungeonId, resolvedStageId, state);
    const userExp = stageLoot ? stageLoot.userExp : getDungeonUserExpReward(resolvedDungeonId) * rewardMultiply;
    grantStageClearExp(user, resolvedStageId, resolvedDungeonId, userExp > 0 ? { exp: userExp } : undefined);
    recordGameplayUnlockClearForUser(user, resolvedDungeonId, resolvedStageId, { save: false });
    trackStageClearMissionProgress(user, resolvedDungeonId, resolvedStageId, state);
    sendStageClearMissionUpdate(socket, user);
    if (USE_LOCAL_USER_DB) saveUserDb();
    console.log(
      `[main-story-progress] clear uid=${user && user.userUid ? user.userUid : "(none)"} stageID=${resolvedStageId} dungeonID=${resolvedDungeonId}`
    );
  }
  return saved;
}

function recordGenericDungeonClear(socket, dungeonId, battleState = null) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const resolvedDungeonId = Number(dungeonId || dynamicGame.dungeonID || 0);
  if (!resolvedDungeonId || isTutorialDungeonId(resolvedDungeonId) || isMainStoryDungeonId(resolvedDungeonId)) return false;
  const resolvedStageId = Number(dynamicGame.stageID || stageIdForDungeonId(resolvedDungeonId) || 0);
  const user = socket && socket.session && socket.session.user;
  const rewardMultiply = Math.max(1, Math.trunc(Number(dynamicGame.rewardMultiply || 1)) || 1);
  if (!user || typeof user !== "object") return false;
  const state = battleState || (replay && replay.battleState) || {};
  const missionResults = resolveDungeonMissionResults(resolvedDungeonId, {
    stageId: resolvedStageId,
    win: true,
    battleState: state,
    forceMissionSuccess: false,
  });
  if (state && typeof state === "object") {
    state.missionResult1 = missionResults.missionResult1;
    state.missionResult2 = missionResults.missionResult2;
    state.missionResults = { ...missionResults };
  }
  const stageLoot = maybeGrantBattleStageClearLoot(replay, user, resolvedDungeonId, resolvedStageId, state);
  const userExp = stageLoot ? stageLoot.userExp : getDungeonUserExpReward(resolvedDungeonId) * rewardMultiply;
  grantStageClearExp(user, resolvedStageId, resolvedDungeonId, userExp > 0 ? { exp: userExp } : undefined);
  const saved = recordGenericDungeonClearForUser(user, resolvedDungeonId, resolvedStageId, state, {
    save: false,
    forceMissionSuccess: false,
    playCountDelta: rewardMultiply,
  });
  if (saved) {
    recordGameplayUnlockClearForUser(user, resolvedDungeonId, resolvedStageId, { save: false });
    trackStageClearMissionProgress(user, resolvedDungeonId, resolvedStageId, state);
    sendStageClearMissionUpdate(socket, user);
    if (USE_LOCAL_USER_DB) saveUserDb();
    console.log(
      `[stage-progress] clear uid=${user && user.userUid ? user.userUid : "(none)"} stageID=${resolvedStageId} dungeonID=${resolvedDungeonId}`
    );
  }
  return saved;
}

function recordGenericDungeonClearForUser(user, dungeonId, stageId, battleState = {}, options = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!resolvedDungeonId && !resolvedStageId) return false;
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};

  const previousClear = user.dungeonClear[String(resolvedDungeonId)] || {};
  const previousStagePlay = user.stagePlayData[String(resolvedStageId)] || {};
  const playCountDelta = Math.max(1, Math.trunc(Number(options.playCountDelta || 1)) || 1);
  const bestClearTimeSec = Math.max(0, Math.round(Number((battleState && (battleState.gameTime || battleState.GameTime)) || 0)));
  const missionResults =
    battleState && battleState.missionResults && typeof battleState.missionResults === "object"
      ? battleState.missionResults
      : battleState || {};
  const forceMissionSuccess =
    options.forceMissionSuccess === true ||
    (battleState && (battleState.forceMissionSuccess === true || battleState.ForceMissionSuccess === true));
  const missionResult1 =
    previousClear.missionResult1 === true ||
    forceMissionSuccess ||
    missionResults.missionResult1 === true ||
    missionResults.MissionResult1 === true ||
    (missionResults.missionResult1 !== false && missionResults.MissionResult1 !== false);
  const missionResult2 =
    previousClear.missionResult2 === true ||
    forceMissionSuccess ||
    missionResults.missionResult2 === true ||
    missionResults.MissionResult2 === true ||
    (missionResults.missionResult2 !== false && missionResults.MissionResult2 !== false);
  const clearTimeCandidates = [Number(previousStagePlay.bestClearTimeSec || 0), bestClearTimeSec].filter((value) => value > 0);
  const bestRecordedClearTimeSec = clearTimeCandidates.length > 0 ? Math.min(...clearTimeCandidates) : bestClearTimeSec;

  user.dungeonClear[String(resolvedDungeonId)] = {
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    missionResult1,
    missionResult2,
    clearedAt: previousClear.clearedAt || new Date().toISOString(),
  };
  if (resolvedStageId > 0) {
    user.stagePlayData[String(resolvedStageId)] = {
      stageId: resolvedStageId,
      playCount: Number(previousStagePlay.playCount || 0) + playCountDelta,
      restoreCount: Number(previousStagePlay.restoreCount || 0),
      bestKillCount: Number(previousStagePlay.bestKillCount || 0),
      nextResetDate: previousStagePlay.nextResetDate || "0",
      totalPlayCount: Number(previousStagePlay.totalPlayCount || 0) + playCountDelta,
      bestClearTimeSec: bestRecordedClearTimeSec,
    };
    user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
    if (!user.unlockedStageIds.includes(resolvedStageId)) user.unlockedStageIds.push(resolvedStageId);
  }
  recordMiscStageClearForUser(user, resolvedDungeonId, resolvedStageId, battleState);
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return true;
}

function recordMiscStageClearForUser(user, dungeonId, stageId, battleState = {}) {
  const miscStage = classifyMiscDungeon(dungeonId, null, getDungeonTableEntry(dungeonId)) || {};
  if (!miscStage.mode) return false;
  const state = ensureMiscStageState(user);
  if (!state) return false;
  const playTime = Math.max(0, Math.round(Number((battleState && (battleState.gameTime || battleState.GameTime)) || 0)));
  if (miscStage.mode === "shadow") {
    state.shadow = state.shadow && typeof state.shadow === "object" ? state.shadow : {};
    const palaceId = positiveInt(miscStage.palaceID);
    const nextDungeonId = nextShadowDungeonId(palaceId, dungeonId);
    state.shadow.currentPalaceId = nextDungeonId ? palaceId : 0;
    state.shadow.life = Math.max(0, Number(state.shadow.life == null ? 3 : state.shadow.life) || 0);
    state.shadow.rewardMultiply = Math.max(1, positiveInt(state.shadow.rewardMultiply) || 1);
    state.shadow.palaces = state.shadow.palaces && typeof state.shadow.palaces === "object" ? state.shadow.palaces : {};
    const palaceKey = String(palaceId);
    const palace = state.shadow.palaces[palaceKey] && typeof state.shadow.palaces[palaceKey] === "object" ? state.shadow.palaces[palaceKey] : {};
    const dungeonDataList = Array.isArray(palace.dungeonDataList) ? palace.dungeonDataList.slice() : [];
    const existingIndex = dungeonDataList.findIndex((entry) => positiveInt(entry && entry.dungeonId) === positiveInt(dungeonId));
    const previous = existingIndex >= 0 ? dungeonDataList[existingIndex] : {};
    const data = {
      dungeonId: positiveInt(dungeonId),
      recentTime: playTime,
      bestTime: Math.max(0, Number(previous.bestTime || 0) || 0),
    };
    if (existingIndex >= 0) dungeonDataList[existingIndex] = data;
    else dungeonDataList.push(data);
    state.shadow.palaces[palaceKey] = {
      ...palace,
      palaceId,
      currentDungeonId: nextDungeonId,
      dungeonDataList,
    };
    return true;
  }
  if (miscStage.mode === "fierce") {
    const bossId = positiveInt(miscStage.fierceBossId);
    const bossState = ensureFierceBossSeasonState(user, bossId);
    if (!bossState) return false;
    const result = buildFierceResultState({
      dynamicGame: {
        dungeonID: dungeonId,
        stageID: stageId,
        fierceBossId: bossId,
        miscMode: "fierce",
      },
      battleState,
      user,
      win: true,
    });
    const previousPoint = Math.max(0, Number(bossState.point || 0) || 0);
    const bestPoint = Math.max(previousPoint, Number(result.bestPoint || result.accquirePoint || 0) || 0);
    const updated = {
      ...bossState,
      bossId,
      isCleared: true,
      point: bestPoint,
      rankNumber: bestPoint > 0 ? 1 : Math.max(0, Number(bossState.rankNumber || 0) || 0),
      rankPercent: bestPoint > 0 ? 1 : Math.max(0, Number(bossState.rankPercent || 0) || 0),
      penaltyIds: uniquePositiveIntList(result.penaltyIds || bossState.penaltyIds || []),
      penaltyPoint: Math.max(0, Number(result.penaltyPoint || bossState.penaltyPoint || 0) || 0),
      lastAcquirePoint: Math.max(0, Number(result.accquirePoint || 0) || 0),
      lastRestTime: Math.max(0, Number(result.restTime || 0) || 0),
      updatedAt: new Date().toISOString(),
    };
    const seasonState = ensureFierceSeasonState(user);
    seasonState.season.bosses[String(bossId)] = updated;
    seasonState.fierce.bosses[String(bossId)] = updated;
    const totalPoint = getFierceSeasonTotalPoint(user);
    seasonState.season.totalPoint = totalPoint;
    seasonState.season.rankNumber = totalPoint > 0 ? 1 : 0;
    seasonState.season.rankPercent = totalPoint > 0 ? 1 : 0;
    seasonState.fierce.rankNumber = seasonState.season.rankNumber;
    seasonState.fierce.rankPercent = seasonState.season.rankPercent;
    return true;
  }
  if (miscStage.mode === "trim") {
    state.trim = state.trim && typeof state.trim === "object" ? state.trim : {};
    state.trim.lastClear = {
      trimId: positiveInt(miscStage.trimId),
      trimLevel: Math.max(1, positiveInt(miscStage.trimLevel) || 1),
      dungeonId: positiveInt(dungeonId),
      stageId: positiveInt(stageId),
      score: Math.max(1, 100000 - playTime),
    };
    return true;
  }
  if (miscStage.mode === "defence") {
    state.defence = state.defence && typeof state.defence === "object" ? state.defence : {};
    const defenceId = positiveInt(miscStage.defenceTempletId);
    const previous = state.defence[String(defenceId)] && typeof state.defence[String(defenceId)] === "object"
      ? state.defence[String(defenceId)]
      : {};
    const gameScore = Math.max(0, Number(battleState && (battleState.defenceScore ?? battleState.DefenceScore ?? battleState.killCount ?? 0)) || 0);
    const next = {
      ...previous,
      defenceTempletId: defenceId,
      bestScore: Math.max(Number(previous.bestScore || 0), gameScore),
      missionResult1: previous.missionResult1 === true || battleState.missionResult1 === true,
      missionResult2: previous.missionResult2 === true || battleState.missionResult2 === true,
    };
    state.defence[String(defenceId)] = next;
    return JSON.stringify(previous) !== JSON.stringify(next);
  }
  return false;
}

function buildDungeonSkipAckPayload(socket, req = {}) {
  const user = socket && socket.session && socket.session.user;
  const stage = getDungeonSkipStageDescriptor(req && req.dungeonId);
  if (stage && stage.cost && req && req.valid) {
    stamina.refreshTimedStamina(user, {
      now: dateTimeBinaryNow(),
      itemIds: [stage.cost.itemId],
      initializeMissing: true,
    });
  }
  const result = simulation.executeDungeonSkip(user, req, {
    stage,
    spendCost(validation) {
      return spendStageReqItemCost(user, validation.stage.stageId, {
        dungeonID: validation.dungeonId,
        multiplier: validation.skip,
      }).map(buildItemMiscData);
    },
    clearOnce(validation) {
      const battleState = {
        gameTime: 0,
        missionResult1: true,
        missionResult2: true,
        missionResults: { missionResult1: true, missionResult2: true },
        forceMissionSuccess: true,
      };
      const fakeReplay = {
        dynamicGame: {
          dungeonID: validation.dungeonId,
          stageID: validation.stage.stageId,
          playerDeck: {
            units: validation.unitUids.map((unitUid, slotIndex) => ({ unitUid, slotIndex })),
          },
        },
        battleState,
      };
      const loot = grantStageClearLoot(user, validation.dungeonId, validation.stage.stageId, {
        replay: fakeReplay,
        save: false,
      });
      grantStageClearExp(
        user,
        validation.stage.stageId,
        validation.dungeonId,
        loot.userExp > 0 ? { exp: loot.userExp } : undefined
      );
      if (isMainStoryDungeonId(validation.dungeonId) && !isTutorialDungeonId(validation.dungeonId)) {
        recordMainStoryDungeonClearForUser(user, validation.dungeonId, validation.stage.stageId, battleState, {
          save: null,
          forceMissionSuccess: true,
        });
      } else {
        recordGenericDungeonClearForUser(user, validation.dungeonId, validation.stage.stageId, battleState, {
          save: false,
          forceMissionSuccess: true,
        });
      }
      recordGameplayUnlockClearForUser(user, validation.dungeonId, validation.stage.stageId, { save: false });
      trackStageClearMissionProgress(user, validation.dungeonId, validation.stage.stageId, battleState);
      return buildDungeonRewardSet(user, validation.dungeonId, validation.stage.stageId, battleState, loot);
    },
    buildStagePlayData(validation) {
      const play = user && user.stagePlayData && user.stagePlayData[String(validation.stage.stageId)];
      return buildStagePlayData(validation.stage.stageId, play || {});
    },
    buildUpdatedUnits(validation) {
      return validation.ownedUnits.map(buildUnitLoyaltyUpdateData);
    },
  });
  if (!result.valid) {
    if (result.error) console.log(`[dungeon-skip] rejected: ${result.error}`);
    return simulation.buildDungeonSkipAckPayload(result.errorCode);
  }
  invalidateJoinLobbyAckPayloadCache("dungeon-skip");
  if (USE_LOCAL_USER_DB) saveUserDb();
  return simulation.buildDungeonSkipAckPayload(0, result);
}

function getDungeonSkipStageDescriptor(dungeonId) {
  const numericDungeonId = positiveInt(dungeonId);
  if (!numericDungeonId) return null;
  const stage =
    getGenericStageForRequest({ dungeonID: numericDungeonId }) ||
    getGenericStageForRequest({ stageID: stageIdForDungeonId(numericDungeonId), dungeonID: numericDungeonId });
  if (!stage) return null;
  const stageRow = getStageTableEntry(stage.stageId);
  const dungeon = getDungeonTableEntry(numericDungeonId);
  const cost = getStageReqItemCost(stage.stageId, { dungeonID: numericDungeonId });
  return {
    stageId: Number(stage.stageId || 0),
    dungeonId: numericDungeonId,
    stageType: String((stageRow && stageRow.m_StageType) || stage.stageType || ""),
    activeBattleSkip: stageRow && stageRow.m_bActiveBattleSkip === true,
    noAutoRepeat: stageRow && stageRow.m_bNoAutoRepeat === true,
    rewardMultiplyMax: Math.max(0, Number(dungeon && dungeon.m_RewardMultiplyMax) || 0),
    enterLimit: Math.max(0, Number(stageRow && stageRow.m_EnterLimit) || 0),
    eventDeckId: positiveInt(stage.eventDeckId),
    cost,
  };
}

function getGameLoadStageAuthorityDescriptor(stage = {}) {
  const stageId = positiveInt(stage.stageId || stage.stageID);
  const dungeonId = positiveInt(stage.dungeonID || stage.dungeonId);
  const stageRow = stageId ? getStageTableEntry(stageId) : null;
  const dungeon = dungeonId ? getDungeonTableEntry(dungeonId) : null;
  const gameType = Number(stage.gameType || 0);
  const mode = String(stage.miscMode || "").toLowerCase();
  const specialAuthority =
    stage.tutorial === true ||
    stage.cutsceneOnly === true ||
    [NGT_DIVE, NGT_RAID, NGT_RAID_SOLO, NGT_SHADOW_PALACE, NGT_FIERCE, NGT_TRIM, NGT_EXPLORE].includes(gameType) ||
    ["dive", "raid", "shadow", "fierce", "trim", "explore"].includes(mode);
  return {
    authoritative: !specialAuthority,
    allowZeroRewardMultiply: specialAuthority,
    stageId,
    dungeonId,
    rewardMultiplyMax: Math.max(0, Number(dungeon && dungeon.m_RewardMultiplyMax) || 0),
    enterLimit: Math.max(0, Number(stageRow && stageRow.m_EnterLimit) || 0),
    cost: getStageReqItemCost(stageId, { dungeonID: dungeonId }),
  };
}

function buildUnitLoyaltyUpdateData(unit = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(unit.unitUid || unit.m_UnitUID || 0)),
    writeSignedVarInt(Math.max(0, Number(unit.loyalty || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(unit.officeRoomId || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(unit.officeGrade || 0) || 0)),
    writeInt64LE(toBigInt(unit.officeGaugeStartTime || unit.heartGaugeStartTime || 0)),
  ]);
}

function buildDungeonRewardSet(user, dungeonId, stageId, battleState = {}, loot = null) {
  const episodeCompleteData = buildMainStoryEpisodeCompleteDataForStage(user, stageId);
  return Buffer.concat([
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(),
    writeNullableObject(
      buildDungeonClearData(dungeonId, {
        stageId,
        win: true,
        battleState,
        missionResult1: true,
        missionResult2: true,
        reward: loot && loot.reward,
        unitExp: loot ? loot.unitExp : undefined,
      })
    ),
  ]);
}

function buildCutsceneDungeonStartAckPayload(dungeonId) {
  const stage = getCutsceneStage(dungeonId);
  const stageId = positiveInt(stage && stage.stageId);
  return Buffer.concat([
    writeSignedVarInt(0),
    stageId ? writeNullableObject(buildStagePlayData(stageId)) : writeNullObject(),
  ]);
}

function buildTutorialGameEndNotPayload(replay, override = {}) {
  const dynamicGame = replay && replay.dynamicGame;
  if (!dynamicGame) return null;
  const dungeonId = Number(override.dungeonID || dynamicGame.dungeonID || 0);
  const stageId = Number(override.stageID || dynamicGame.stageID || stageIdForDungeonId(dungeonId));
  if (!isTutorialDungeonId(dungeonId) || !isTutorialStageId(stageId)) return null;
  const battleState = override.battleState || replay.battleState || {};
  const gameRecordState = buildBattleGameRecordState(battleState, override);
  const playTime = getBattleEndPlayTime(battleState, override);
  const episodeCompleteData = buildMainStoryEpisodeCompleteDataForStage(override.user, stageId);
  return Buffer.concat([
    writeBool(true), // win
    writeBool(false), // giveup
    writeBool(false), // restart
    writeNullableObject(buildDungeonClearData(dungeonId)),
    writeNullableObject(buildPhaseClearData(stageId)), // phaseClearData
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(), // episodeCompleteData
    writeNullableObject(buildBattleDeckIndexData(replay)), // deckIndex
    writeNullObject(), // warfareSyncData
    writeNullObject(), // pvpResultData
    writeNullObject(), // diveSyncData
    writeNullableObject(buildRaidBossResultData()), // raidBossResultData
    writeNullableObject(buildBattleGameRecordData(replay, gameRecordState, { playTime })), // gameRecord
    writeObjectList([]), // updatedUnits
    writeObjectList([]), // costItemDataList
    writeNullableObject(buildStagePlayData(stageId, { ...battleState, gameTime: playTime })),
    writeNullableObject(buildShadowGameResultData(dynamicGame, battleState)), // shadowGameResult
    writeNullableObject(buildFierceResultData()), // fierceResultData
    writeNullObject(), // phaseModeState
    writeSignedVarLong(0n), // killCountDelta
    writeNullObject(), // killCountData
    writeNullObject(), // trimModeState
    writeFloatLE(playTime), // totalPlayTime
    writeNullObject(), // explore
    writeNullObject(), // exploreSquad
    writeSignedVarInt(0), // exploreEnhancePoint
  ]);
}

function buildDynamicGameEndNotPayload(replay, override = {}) {
  const dynamicGame = replay && replay.dynamicGame;
  if (!dynamicGame) return null;
  const battleState = override.battleState || replay.battleState || {};
  const requestedDungeonId = Number(override.dungeonID || dynamicGame.dungeonID || 0);
  const requestedStageId = Number(override.stageID || dynamicGame.stageID || 0);
  const stageId = Number(requestedStageId || stageIdForDungeonId(requestedDungeonId) || 0);
  const dungeonId = Number(requestedDungeonId || resolveDungeonIdForStageProgress(stageId, dynamicGame) || 0);
  if (!dungeonId && !stageId) return null;
  const isRaidGame = isRaidDynamicGame(dynamicGame);
  const isShadowGame =
    positiveInt(dynamicGame.palaceID || dynamicGame.palaceId) > 0 ||
    Number(dynamicGame.gameType || 0) === NGT_SHADOW_PALACE ||
    String(dynamicGame.miscMode || "") === "shadow";
  const isTrimGame =
    Number(dynamicGame.gameType || 0) === NGT_TRIM ||
    String(dynamicGame.miscMode || "").toLowerCase() === "trim";
  const isExploreGame =
    Number(dynamicGame.gameType || 0) === NGT_EXPLORE ||
    String(dynamicGame.miscMode || "").toLowerCase() === "explore";
  const isGuildDungeonGame = String(dynamicGame.miscMode || "").startsWith("guild-dungeon");
  const isPhaseGame = Number(dynamicGame.gameType || 0) === NGT_PHASE || String(dynamicGame.miscMode || "") === "phase";
  const rewardMultiply = Math.max(1, Math.trunc(Number(dynamicGame.rewardMultiply || 1)) || 1);
  const gameRecordState = buildBattleGameRecordState(battleState, override);
  const playTime = getBattleEndPlayTime(battleState, override);
  const missionBattleState = buildBattleMissionState(gameRecordState, { playTime });
  const win = resolveBattleWin(
    missionBattleState,
    isRaidGame && override.giveup !== true
      ? {
          ...override,
          fallbackWin: typeof override.fallbackWin === "boolean" ? override.fallbackWin : false,
          preferFallbackWin: Boolean(override.preferFallbackWin),
        }
      : override
  );
  const missionResults = resolveDungeonMissionResults(dungeonId, {
    stageId,
    win,
    battleState: missionBattleState,
    forceMissionSuccess: override.forceMissionSuccess === true,
  });
  if (battleState && typeof battleState === "object") {
    normalizeBattleResultState(battleState, win);
    if (playTime > 0) {
      battleState.gameTime = playTime;
      battleState.GameTime = playTime;
      battleState.totalPlayTime = playTime;
      battleState.TotalPlayTime = playTime;
    }
    battleState.missionResult1 = missionResults.missionResult1;
    battleState.missionResult2 = missionResults.missionResult2;
    battleState.missionResults = { ...missionResults };
  }
  if (replay && typeof replay === "object") {
    replay.lastDynamicGameEndResult = {
      win,
      giveup: Boolean(override.giveup || false),
      dungeonId,
      stageId,
      battleState,
    };
  }
  console.log(
    `[dynamic-game-end] result=${win ? "win" : "loss"} dungeonID=${dungeonId} stageID=${stageId} medals=${
      missionResults.missionResult1 ? 1 : 0
    }/${missionResults.missionResult2 ? 1 : 0} raid=${isRaidGame ? 1 : 0} cutscene=${isCutsceneOnlyDungeon(dungeonId, stageId) ? 1 : 0} source=${
      override.preferFallbackWin ? "online-authoritative" : "battle-state"
    }`
  );
  const raidBattleResult = isRaidGame ? maybeRecordRaidBattleResultForReplay(replay, { ...override, battleState }, win) : null;
  const isDiveGame = !isRaidGame && (Number(dynamicGame.diveStageID || 0) > 0 || Number(dynamicGame.gameType || 0) === NGT_DIVE);
  const diveBattleResult = isDiveGame ? worldMap.completeDiveBattle(override.user, dynamicGame, battleState, { win, now: dateTimeBinaryNow() }) : null;
  let trimBattleResult = null;
  if (isTrimGame) {
    const battleKey = `${dynamicGame.gameUID || 0}:${dungeonId}`;
    if (replay.trimBattleResult && replay.trimBattleResult.battleKey === battleKey) {
      trimBattleResult = replay.trimBattleResult;
    } else {
      trimBattleResult = trim.recordTrimBattleResult(override.user, {
        dungeonId,
        win,
        giveup: Boolean(override.giveup),
        trimPoint: override.trimPoint ?? override.managedTrimPoint,
        battleState: missionBattleState,
      }, { now: getServerNowDate() });
      trimBattleResult.battleKey = battleKey;
      replay.trimBattleResult = trimBattleResult;
    }
  }
  let exploreBattleResult = null;
  if (isExploreGame) {
    const battleKey = `${dynamicGame.gameUID || 0}:${dungeonId}`;
    if (replay.exploreBattleResult && replay.exploreBattleResult.battleKey === battleKey) {
      exploreBattleResult = replay.exploreBattleResult;
    } else {
      exploreBattleResult = explore.recordExploreBattleResult({}, override.user, {
        dungeonId,
        win,
        giveup: Boolean(override.giveup),
        currentHp: override.exploreCurrentHp,
        scoreDelta: override.exploreScoreDelta,
        enhancePointDelta: override.exploreEnhancePointDelta,
      });
      exploreBattleResult.battleKey = battleKey;
      replay.exploreBattleResult = exploreBattleResult;
    }
  }
  const phaseBattleResult = isPhaseGame
    ? recordPhaseBattleResult(replay, override.user, {
        stageId,
        dungeonId,
        win,
        giveup: Boolean(override.giveup),
        playTime,
        battleState: missionBattleState,
      })
    : null;
  const stageLoot = !isRaidGame && !isDiveGame && !isTrimGame && !isExploreGame && !isGuildDungeonGame && !isPhaseGame && win
    ? getOrGrantStageClearLoot(replay, override.user, dungeonId, stageId, { save: false })
    : null;
  const costItems = isRaidGame
    ? (raidBattleResult && raidBattleResult.costItems) || []
    : isDiveGame
      ? []
      : isShadowGame || isTrimGame || isExploreGame || isGuildDungeonGame || (isPhaseGame && !phaseBattleResult.terminated)
        ? []
        : spendStageReqItemCostForReplay(replay, override.user, stageId);
  const episodeCompleteData = !isRaidGame && !isDiveGame && !isTrimGame && !isExploreGame && !isGuildDungeonGame &&
    (!isPhaseGame || phaseBattleResult.completed) && win
    ? buildMainStoryEpisodeCompleteDataForStage(override.user, stageId)
    : null;
  const fierceResult = buildFierceResultState({
    dynamicGame,
    battleState: missionBattleState,
    user: override.user,
    win,
    fiercePoint: override.fiercePoint ?? override.managedFiercePoint,
    fiercePenaltyPoint: override.fiercePenaltyPoint ?? override.managedFiercePenaltyPoint,
  });
  const killCountResult = isGuildDungeonGame
    ? { delta: 0n, data: null }
    : killCount.recordBattleKillCount(
        { userDb },
        override.user,
        { stageId, battleState: missionBattleState, replay }
      );
  return Buffer.concat([
    writeBool(win), // win
    writeBool(Boolean(override.giveup || false)), // giveup
    writeBool(Boolean(override.restart || false)), // restart
    !isRaidGame && !isDiveGame && dungeonId
      ? writeNullableObject(
          buildDungeonClearData(dungeonId, {
            stageId,
            win,
            battleState: missionBattleState,
            ...missionResults,
            reward: stageLoot && stageLoot.reward,
            unitExp: stageLoot ? stageLoot.unitExp : undefined,
          })
        )
      : writeNullObject(),
    !isRaidGame && isPhaseGame && phaseBattleResult.completed
      ? writeNullableObject(
          buildPhaseClearData(stageId, {
            ...phaseBattleResult.clearData,
            reward: phaseBattleResult.loot.reward,
            missionReward: phaseBattleResult.loot.missionReward,
            oneTimeRewards: phaseBattleResult.loot.oneTimeRewards,
          })
        )
      : writeNullObject(), // phaseClearData
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(), // episodeCompleteData
    writeNullableObject(buildBattleDeckIndexData(replay)), // deckIndex
    writeNullObject(), // warfareSyncData
    writeNullObject(), // pvpResultData
    diveBattleResult ? writeNullableObject(worldMap.buildDiveSyncData(diveBattleResult.syncData)) : writeNullObject(), // diveSyncData
    writeNullableObject(buildRaidBossResultData(raidBattleResult && raidBattleResult.bossResult)), // raidBossResultData
    writeNullableObject(buildBattleGameRecordData(replay, gameRecordState, { playTime, fiercePoint: fierceResult.accquirePoint })), // gameRecord
    writeObjectList([]), // updatedUnits
    writeObjectList(costItems.map((item) => writeNullableObject(buildItemMiscData(item)))), // costItemDataList
    stageId && (!isPhaseGame || phaseBattleResult.completed)
      ? writeNullableObject(
          buildProjectedStagePlayData(
            override.user,
            stageId,
            { ...missionBattleState, gameTime: playTime },
            win && !isRaidGame && !isDiveGame && !isShadowGame && !isTrimGame && !isExploreGame && !isGuildDungeonGame &&
              (!isPhaseGame || phaseBattleResult.completed) ? rewardMultiply : 1
          )
        )
      : writeNullObject(),
    writeNullableObject(
      buildShadowGameResultData(dynamicGame, missionBattleState, {
        user: override.user,
        replay,
        win,
      })
    ), // shadowGameResult
    writeNullableObject(buildFierceResultData(fierceResult)), // fierceResultData
    isPhaseGame && phaseBattleResult.nextState
      ? writeNullableObject(
          buildPhaseModeState(
            phaseBattleResult.nextState.stageId,
            phaseBattleResult.nextState.phaseIndex,
            phaseBattleResult.nextState.dungeonId,
            phaseBattleResult.nextState.totalPlayTime,
            phaseBattleResult.nextState.supportingUserUid
          )
        )
      : writeNullObject(), // phaseModeState
    writeSignedVarLong(toBigInt(killCountResult.delta)), // killCountDelta
    killCountResult.data
      ? writeNullableObject(killCount.buildKillCountData(killCountResult.data))
      : writeNullObject(), // killCountData
    trimBattleResult && trimBattleResult.modeState
      ? writeNullableObject(trim.buildTrimModeState(trimBattleResult.modeState))
      : writeNullObject(), // trimModeState
    writeFloatLE(playTime), // totalPlayTime
    exploreBattleResult && exploreBattleResult.valid && exploreBattleResult.state
      ? writeNullableObject(explore.buildExploreData(exploreBattleResult.state))
      : writeNullObject(), // explore
    exploreBattleResult && exploreBattleResult.valid && exploreBattleResult.squad
      ? writeNullableObject(explore.buildExploreSquadData(exploreBattleResult.squad))
      : writeNullObject(), // exploreSquad
    writeSignedVarInt(exploreBattleResult && exploreBattleResult.valid ? Number(exploreBattleResult.enhancePoint) || 0 : 0),
  ]);
}

function buildDefenceGameEndNotPayload(replay, override = {}) {
  const dynamicGame = replay && replay.dynamicGame;
  if (!isDefenceDynamicGame(dynamicGame)) return null;
  const battleState = override.battleState || replay.battleState || {};
  const dungeonId = positiveInt(override.dungeonID || dynamicGame.dungeonID);
  const stageId = positiveInt(override.stageID || dynamicGame.stageID || stageIdForDungeonId(dungeonId));
  const defenceId = positiveInt(dynamicGame.defenceTempletId || dynamicGame.DefenceTempletId);
  if (!dungeonId || !defenceId) return null;

  const managedBattleRecords = Array.isArray(override.managedBattleRecords) ? override.managedBattleRecords : [];
  const gameRecordState = buildBattleGameRecordState(battleState, override);
  const playTime = getBattleEndPlayTime(battleState, override);
  const managedWin = resolveBattleWin(gameRecordState, override);
  const defence = loadMiscStageCatalog().defenceById.get(defenceId) || {};
  const clearScore = Math.max(0, Number(defence.m_ClearScore || 0) || 0);
  const reportedScore = finiteNumber(override.defencePoint ?? override.managedDefencePoint, -1);
  const recordScore = calculateDefenceBattleScore(managedBattleRecords.length > 0 ? managedBattleRecords : gameRecordState);
  const gameScore = Math.max(0, Math.round(reportedScore >= 0 ? reportedScore : recordScore), managedWin && clearScore > 0 ? clearScore : 0);
  const win = clearScore > 0 ? gameScore >= clearScore : managedWin;
  const scoreState = {
    ...(battleState && typeof battleState === "object" ? battleState : {}),
    gameTime: playTime,
    GameTime: playTime,
    defenceScore: gameScore,
    killCount: gameScore,
    teamAKillCount: gameScore,
    win,
    Win: win,
  };
  const missionResults = resolveDungeonMissionResults(dungeonId, {
    stageId,
    win,
    battleState: scoreState,
  });
  scoreState.missionResult1 = missionResults.missionResult1;
  scoreState.missionResult2 = missionResults.missionResult2;
  scoreState.missionResults = { ...missionResults };
  if (battleState && typeof battleState === "object") Object.assign(battleState, scoreState);

  const user = override.user;
  const previous = getSavedDefenceRecord(user, defenceId);
  const bestScore = Math.max(gameScore, Number(previous && previous.bestScore || 0) || 0);
  const stageLoot = win ? getOrGrantStageClearLoot(replay, user, dungeonId, stageId, { save: false }) : null;
  const costItems = spendStageReqItemCostForReplay(replay, user, stageId);
  replay.lastDynamicGameEndResult = {
    win,
    giveup: Boolean(override.giveup || false),
    dungeonId,
    stageId,
    battleState: scoreState,
  };

  const gameEndData = Buffer.concat([
    writeBool(win),
    writeBool(Boolean(override.giveup || false)),
    writeBool(Boolean(override.restart || false)),
    writeNullableObject(buildDungeonClearData(dungeonId, {
      stageId,
      win,
      battleState: scoreState,
      ...missionResults,
      reward: stageLoot && stageLoot.reward,
      unitExp: stageLoot ? stageLoot.unitExp : 0,
    })),
    writeNullableObject(buildBattleDeckIndexData(replay)),
    writeNullableObject(buildBattleGameRecordData(replay, gameRecordState, { playTime })),
    writeObjectList([]),
    writeObjectList(costItems.map((item) => writeNullableObject(buildItemMiscData(item)))),
    writeSignedVarLong(0n),
    writeNullObject(),
    writeFloatLE(playTime),
  ]);
  console.log(`[defence-game-end] defenceID=${defenceId} score=${gameScore} best=${bestScore} win=${win ? 1 : 0}`);
  return defenceBattle.buildDefenceGameEndNotPayload(gameEndData, defenceId, gameScore, bestScore);
}

function calculateDefenceBattleScore(source = {}) {
  const records = Array.isArray(source)
    ? source
    : Array.isArray(source && (source.unitRecords || source.UnitRecords))
      ? source.unitRecords || source.UnitRecords
      : Object.values(source && (source.unitRecords || source.UnitRecords) || {});
  let teamAKills = 0;
  let teamBDeaths = 0;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const teamType = Number(record.teamType ?? record.TeamType ?? record.team ?? record.Team ?? 0);
    const kills = Math.max(0, Number(record.recordKillCount ?? record.RecordKillCount ?? 0) || 0);
    const deaths = Math.max(0, Number(record.recordDieCount ?? record.RecordDieCount ?? 0) || 0);
    if (isATeamType(teamType)) teamAKills += kills;
    else if (isBTeamType(teamType)) teamBDeaths += deaths;
  }
  return Math.max(teamAKills, teamBDeaths);
}

function getSavedDefenceRecord(user, defenceId) {
  const records = user && user.miscStages && user.miscStages.defence;
  return records && typeof records === "object" ? records[String(defenceId)] || null : null;
}

function isDefenceDynamicGame(dynamicGame = {}) {
  return Boolean(
    dynamicGame &&
      (Number(dynamicGame.gameType || dynamicGame.GameType || 0) === 27 ||
        String(dynamicGame.miscMode || dynamicGame.MiscMode || "").toLowerCase() === "defence" ||
        positiveInt(dynamicGame.defenceTempletId || dynamicGame.DefenceTempletId) > 0)
  );
}

function buildPrivatePvpGameEndNotPayload(replay, member, winTeam, meta = {}) {
  const battleState = replay && replay.battleState || {};
  const teamType = Number(member && member.teamType || 1);
  const resolvedWinTeam = winTeam === 1 || winTeam === 3 ? winTeam : 0;
  const win = resolvedWinTeam > 0 && teamType === resolvedWinTeam;
  const result = resolvedWinTeam === 0 ? 2 : win ? 0 : 1;
  const playTime = extractManagedBattlePlayTime(meta) || getBattlePlayTime(battleState);
  return Buffer.concat([
    writeBool(win),
    writeBool(false),
    writeBool(false),
    writeNullObject(), // dungeonClearData
    writeNullObject(), // phaseClearData
    writeNullObject(), // episodeCompleteData
    writeNullableObject(buildBattleDeckIndexData(replay)),
    writeNullObject(), // warfareSyncData
    writeNullableObject(Buffer.concat([
      writeSignedVarInt(result),
      writeNullObject(), // myInfo
      writeNullObject(), // history
      writeNullObject(), // pvpPoint
      writeInt64LE(dateTimeBinaryNow()),
      writeBool(false),
      writeBool(false),
      writeObjectList([]), // pvpChargePoint
    ])),
    writeNullObject(), // diveSyncData
    writeNullableObject(buildRaidBossResultData()),
    writeNullableObject(buildBattleGameRecordData(replay, battleState, { playTime })),
    writeObjectList([]), // updatedUnits
    writeObjectList([]), // costItemDataList
    writeNullObject(), // stagePlayData
    writeNullableObject(buildShadowGameResultData(replay.dynamicGame, battleState)),
    writeNullableObject(buildFierceResultData()),
    writeNullObject(), // phaseModeState
    writeSignedVarLong(0n),
    writeNullObject(), // killCountData
    writeNullObject(), // trimModeState
    writeFloatLE(playTime),
    writeNullObject(),
    writeNullObject(),
    writeSignedVarInt(0),
  ]);
}

function buildStandardPvpGameEndNotPayloadForSocket(socket, replay, meta = {}) {
  const match = pvpMatchmaking.getMatch(socket) || leaguePvpMatchmaking.getMatch(socket);
  const member = pvpMatchmaking.getMember(socket) || leaguePvpMatchmaking.getMember(socket);
  const gameType = Number(replay && replay.dynamicGame && replay.dynamicGame.gameType || 0);
  if (!match || !member || ![6, leaguePvp.NGT_PVP_LEAGUE, leaguePvp.NGT_PVP_UNLIMITED, eventPvp.NGT_PVP_EVENT].includes(gameType)) return null;
  const battleState = replay.battleState || {};
  let winTeam = Number(
    meta.battleWinTeam ?? meta.BattleWinTeam ?? meta.managedBattleWinTeam ?? meta.ManagedBattleWinTeam ??
    (battleState.gameState && (battleState.gameState.winTeam ?? battleState.gameState.WinTeam)) ?? 0
  );
  const managedWin = extractManagedBattleWin(meta);
  if (winTeam !== 1 && winTeam !== 3 && typeof managedWin === "boolean") winTeam = managedWin ? 1 : 3;
  return buildStandardPvpGameEndNotPayload(replay, match, member, winTeam, meta);
}

function buildStandardPvpGameEndNotPayload(replay, match, member, winTeam, meta = {}) {
  const battleState = replay && replay.battleState || {};
  const teamType = Number(member && member.teamType || 1);
  const resolvedWinTeam = winTeam === 1 || winTeam === 3 ? winTeam : 0;
  const win = resolvedWinTeam > 0 && teamType === resolvedWinTeam;
  const result = resolvedWinTeam === 0 ? 2 : win ? 0 : 1;
  const playTime = extractManagedBattlePlayTime(meta) || getBattlePlayTime(battleState);
  const recorded = recordStandardPvpResult(match, member, result);
  const state = recorded.state;
  replay.lastDynamicGameEndResult = {
    win,
    giveup: Boolean(meta.giveup),
    dungeonId: 0,
    stageId: 0,
    battleState,
  };
  return Buffer.concat([
    writeBool(win),
    writeBool(Boolean(meta.giveup)),
    writeBool(false),
    writeNullObject(), // dungeonClearData
    writeNullObject(), // phaseClearData
    writeNullObject(), // episodeCompleteData
    writeNullableObject(buildBattleDeckIndexData(replay)),
    writeNullObject(), // warfareSyncData
    writeNullableObject(Buffer.concat([
      writeSignedVarInt(result),
      writeNullableObject(pvpRank.buildPvpStateData(state)),
      writeNullObject(), // history; the replay/history packet family remains separately audited
      recorded.pvpPoint ? writeNullableObject(buildItemMiscData(recorded.pvpPoint)) : writeNullObject(),
      writeInt64LE(dateTimeBinaryNow()),
      writeBool(match && (match.leaguePvp || match.eventPvp) ? true : pvpRank.isRankPvpOpen(member.user)),
      writeBool(false),
      writeObjectList([]), // pvpChargePoint
    ])),
    writeNullObject(), // diveSyncData
    writeNullableObject(buildRaidBossResultData()),
    writeNullableObject(buildBattleGameRecordData(replay, battleState, { playTime })),
    writeObjectList([]),
    writeObjectList([]),
    writeNullObject(), // stagePlayData
    writeNullableObject(buildShadowGameResultData(replay.dynamicGame, battleState)),
    writeNullableObject(buildFierceResultData()),
    writeNullObject(), // phaseModeState
    writeSignedVarLong(0n),
    writeNullObject(), // killCountData
    writeNullObject(), // trimModeState
    writeFloatLE(playTime),
    writeNullObject(), // explore
    writeNullObject(), // exploreSquad
    writeSignedVarInt(0),
  ]);
}

function recordStandardPvpResult(match, member, result) {
  match.resultStates = match.resultStates instanceof Map ? match.resultStates : new Map();
  const key = String(member && member.user && member.user.userUid || member && member.teamType || 0);
  if (match.resultStates.has(key)) return match.resultStates.get(key);
  let saved;
  let pvpPoint = null;
  if (match && match.eventPvp) {
    saved = eventPvp.recordEventPvpResult(member.user, match.season, result, { now: getServerNowDate() });
  } else if (match && match.leaguePvp) {
    saved = leaguePvp.recordLeaguePvpResult(member.user, result);
    const amount = leaguePvp.getLeagueBattlePoint(result);
    if (amount > 0) pvpPoint = grantMiscItem(member.user, 5, amount, 0, { regDate: dateTimeBinaryNow() });
  } else {
    const previous = pvpRank.getPvpRankState(member.user);
    const win = result === 0;
    const loss = result === 1;
    const next = {
      ...previous,
      winCount: previous.winCount + (win ? 1 : 0),
      loseCount: previous.loseCount + (loss ? 1 : 0),
      winStreak: win ? previous.winStreak + 1 : 0,
      maxWinStreak: win ? Math.max(previous.maxWinStreak, previous.winStreak + 1) : previous.maxWinStreak,
      seasonPlayCount: previous.seasonPlayCount + 1,
      seasonWinCount: previous.seasonWinCount + (win ? 1 : 0),
    };
    pvpRank.setPvpRankState(member.user, next);
    saved = pvpRank.getPvpRankState(member.user);
  }
  const recorded = { state: saved, pvpPoint };
  match.resultStates.set(key, recorded);
  invalidateJoinLobbyAckPayloadCache("pvp-match-result");
  if (USE_LOCAL_USER_DB) saveUserDb();
  return recorded;
}

function markStandardPvpMatchFinished(socket) {
  const match = pvpMatchmaking.getMatch(socket) || leaguePvpMatchmaking.getMatch(socket);
  if (!match || match.matchFinished) return false;
  match.matchFinished = true;
  match.battleStarted = false;
  if (match.replay) match.replay.dynamicBattleResultSent = true;
  return true;
}

function buildBattleGameRecordState(battleState = {}, override = {}) {
  const managedBattleRecords = Array.isArray(override.managedBattleRecords) ? override.managedBattleRecords : [];
  if (managedBattleRecords.length === 0) return battleState;
  return {
    ...(battleState && typeof battleState === "object" ? battleState : {}),
    unitRecords: managedBattleRecords,
  };
}

function buildBattleMissionState(battleState = {}, options = {}) {
  const state = battleState && typeof battleState === "object" ? { ...battleState } : {};
  const playTime = finiteNumber(options.playTime);
  if (playTime > 0) {
    state.gameTime = playTime;
    state.GameTime = playTime;
    state.totalPlayTime = playTime;
    state.TotalPlayTime = playTime;
  }
  return state;
}

function getBattleEndPlayTime(battleState = {}, override = {}) {
  const managedPlayTime =
    finiteNumber(override.managedBattlePlayTime ?? override.ManagedBattlePlayTime) ||
    getBattleRecordMaxPlayTime(override.managedBattleRecords);
  if (managedPlayTime > 0) return managedPlayTime;
  return getBattlePlayTime(battleState);
}

function getBattleRecordMaxPlayTime(records = []) {
  if (!Array.isArray(records)) return 0;
  return records.reduce((max, record) => {
    if (!record || typeof record !== "object") return max;
    return Math.max(max, finiteNumber(record.playtime ?? record.Playtime ?? record.PlayTime));
  }, 0);
}

function buildBattleDeckIndexData(replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const playerDeck = dynamicGame.playerDeck && typeof dynamicGame.playerDeck === "object" ? dynamicGame.playerDeck : {};
  return buildSerializedDeckIndexData({
    deckType: Number(playerDeck.deckType || dynamicGame.deckType || 0),
    index: Number(
      playerDeck.deckIndex != null ? playerDeck.deckIndex : playerDeck.index != null ? playerDeck.index : dynamicGame.deckIndex || 0
    ),
  });
}

function buildBattleGameRecordData(replay, battleState = {}, options = {}) {
  const records = collectBattleGameRecords(replay, battleState, options);
  const fiercePoint = Math.max(0, Number(options.fiercePoint || 0) || 0);
  return Buffer.concat([
    writeObjectMapShort(records.map((record) => [record.gameUnitUID, buildBattleGameRecordUnitData(record)])),
    writeFloatLE(records.reduce((total, record) => total + (isATeamType(record.teamType) ? finiteNumber(record.recordGiveDamage) : 0), 0)),
    writeFloatLE(records.reduce((total, record) => total + (isBTeamType(record.teamType) ? finiteNumber(record.recordGiveDamage) : 0), 0)),
    writeSignedVarInt(records.reduce((total, record) => total + (isATeamType(record.teamType) ? positiveInt(record.recordDieCount) : 0), 0)),
    writeSignedVarInt(records.reduce((total, record) => total + (isBTeamType(record.teamType) ? positiveInt(record.recordDieCount) : 0), 0)),
    writeFloatLE(fiercePoint), // totalFiercePoint
  ]);
}

function collectBattleGameRecords(replay, battleState = {}, options = {}) {
  const entries = new Map();
  const sourceRecords = battleState && typeof battleState === "object" ? battleState.unitRecords || battleState.UnitRecords : null;
  if (sourceRecords && typeof sourceRecords === "object") {
    const iterable = Array.isArray(sourceRecords)
      ? sourceRecords.map((record) => [record && (record.gameUnitUID || record.GameUnitUID), record])
      : Object.entries(sourceRecords);
    for (const [key, record] of iterable) {
      const normalized = normalizeBattleGameRecord(record, { gameUnitUID: key });
      if (normalized) entries.set(normalized.gameUnitUID, normalized);
    }
  }

  for (const unit of Array.isArray(battleState && battleState.units) ? battleState.units : []) {
    const normalized = normalizeBattleGameRecord(unit);
    if (!normalized) continue;
    const existing = entries.get(normalized.gameUnitUID);
    entries.set(
      normalized.gameUnitUID,
      existing
        ? {
            ...normalized,
            ...existing,
            unitId: positiveInt(existing.unitId) || positiveInt(normalized.unitId),
            unitLevel: Math.max(positiveInt(existing.unitLevel), positiveInt(normalized.unitLevel), 1),
            isLeader: Boolean(existing.isLeader || normalized.isLeader),
            isAssistUnit: Boolean(existing.isAssistUnit || normalized.isAssistUnit),
            isSummonee: Boolean(existing.isSummonee || normalized.isSummonee),
            sourceUnitUID: existing.sourceUnitUID || normalized.sourceUnitUID || "",
            role: existing.role || normalized.role || "",
            teamType: normalizeBattleRecordTeam(existing.teamType || normalized.teamType),
          }
        : normalized
    );
  }

  applyBattleRecordDeckMetadata(entries, replay);
  const records = Array.from(entries.values()).filter((record) => positiveInt(record.gameUnitUID) > 0 && positiveInt(record.unitId) > 0);
  if (records.length === 0) return records;

  const playTime = Math.max(1, Math.round(finiteNumber(options.playTime ?? getBattlePlayTime(battleState)) || 1));
  const hasDamage = records.some((record) => finiteNumber(record.recordGiveDamage) > 0 || finiteNumber(record.recordTakeDamage) > 0);
  if (!hasDamage) synthesizeMinimalBattleDamage(records, battleState, playTime);
  for (const record of records) {
    record.recordSummonCount = Math.max(1, positiveInt(record.recordSummonCount));
    record.playtime = Math.max(1, Math.round(finiteNumber(record.playtime) || playTime));
  }
  return records.sort((left, right) => positiveInt(left.gameUnitUID) - positiveInt(right.gameUnitUID));
}

function normalizeBattleGameRecord(source, fallback = {}) {
  if (!source || typeof source !== "object") return null;
  const gameUnitUID = positiveInt(
    source.gameUnitUID ?? source.GameUnitUID ?? source.gameUnitUid ?? source.m_GameUnitUID ?? fallback.gameUnitUID
  );
  if (!gameUnitUID) return null;
  const teamType = normalizeBattleRecordTeam(source.teamType ?? source.TeamType ?? source.team ?? source.Team);
  return {
    gameUnitUID,
    sourceUnitUID: source.sourceUnitUID ?? source.sourceUnitUid ?? source.SourceUnitUID ?? source.SourceUnitUid ?? "",
    role: source.role ?? source.Role ?? "",
    unitId: positiveInt(source.unitId ?? source.unitID ?? source.UnitId ?? source.UnitID ?? source.m_UnitID),
    changeUnitName: source.changeUnitName ?? source.ChangeUnitName ?? "",
    unitLevel: Math.max(1, positiveInt(source.unitLevel ?? source.UnitLevel ?? source.level ?? source.Level) || 1),
    isSummonee: Boolean(source.isSummonee ?? source.IsSummonee ?? false),
    isAssistUnit: Boolean(source.isAssistUnit ?? source.IsAssistUnit ?? source.AssistUnit ?? source.assistUnit ?? false),
    isLeader: Boolean(source.isLeader ?? source.IsLeader ?? false),
    teamType,
    recordGiveDamage: finiteNumber(source.recordGiveDamage ?? source.RecordGiveDamage),
    recordTakeDamage: finiteNumber(source.recordTakeDamage ?? source.RecordTakeDamage),
    recordHeal: finiteNumber(source.recordHeal ?? source.RecordHeal),
    recordSummonCount: Math.max(1, positiveInt(source.recordSummonCount ?? source.RecordSummonCount)),
    recordDieCount: positiveInt(source.recordDieCount ?? source.RecordDieCount),
    recordKillCount: positiveInt(source.recordKillCount ?? source.RecordKillCount),
    playtime: finiteNumber(source.playtime ?? source.Playtime ?? source.PlayTime),
  };
}

function applyBattleRecordDeckMetadata(entries, replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const playerDeck = dynamicGame.playerDeck && typeof dynamicGame.playerDeck === "object" ? dynamicGame.playerDeck : {};
  const leaderUnitUid = String(playerDeck.leaderUnitUid || playerDeck.leaderUnitUID || playerDeck.LeaderUnitUid || "");
  const units = Array.isArray(playerDeck.units) ? playerDeck.units : [];
  const deckByUid = new Map(
    units
      .map((unit) => [String(unit && (unit.unitUid || unit.unitUID || unit.UnitUid || "")), unit])
      .filter(([key]) => key)
  );
  for (const record of entries.values()) {
    const sourceUnitUID = String(record.sourceUnitUID || record.SourceUnitUID || "");
    const deckUnit = sourceUnitUID ? deckByUid.get(sourceUnitUID) : null;
    if (!deckUnit) continue;
    record.unitId = positiveInt(record.unitId) || positiveInt(deckUnit.unitId ?? deckUnit.unitID ?? deckUnit.UnitID);
    record.unitLevel = Math.max(1, positiveInt(record.unitLevel) || positiveInt(deckUnit.level ?? deckUnit.Level) || 1);
    record.isLeader = Boolean(record.isLeader || (leaderUnitUid && sourceUnitUID === leaderUnitUid));
  }
}

function synthesizeMinimalBattleDamage(records, battleState = {}, playTime = 1) {
  const teamA = records.filter((record) => isATeamType(record.teamType));
  const teamB = records.filter((record) => isBTeamType(record.teamType));
  if (teamA.length === 0 || teamB.length === 0) return;
  const winnerDamage = Math.max(100, Math.round(finiteNumber(battleState.raidBossDamage ?? battleState.RaidBossDamage) || playTime * 25));
  const attacker = teamA.find((record) => !String(record.role || "").toLowerCase().includes("ship")) || teamA[0];
  const target = teamB[0];
  attacker.recordGiveDamage = Math.max(finiteNumber(attacker.recordGiveDamage), winnerDamage);
  target.recordTakeDamage = Math.max(finiteNumber(target.recordTakeDamage), winnerDamage);
}

function buildBattleGameRecordUnitData(record = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(record.unitId)),
    writeString(record.changeUnitName || ""),
    writeSignedVarInt(Math.max(1, positiveInt(record.unitLevel) || 1)),
    writeBool(Boolean(record.isSummonee)),
    writeBool(Boolean(record.isAssistUnit)),
    writeBool(Boolean(record.isLeader)),
    writeSignedVarInt(normalizeBattleRecordTeam(record.teamType)),
    writeFloatLE(finiteNumber(record.recordGiveDamage)),
    writeFloatLE(finiteNumber(record.recordTakeDamage)),
    writeFloatLE(finiteNumber(record.recordHeal)),
    writeSignedVarInt(Math.max(1, positiveInt(record.recordSummonCount))),
    writeSignedVarInt(positiveInt(record.recordDieCount)),
    writeSignedVarInt(positiveInt(record.recordKillCount)),
    writeSignedVarInt(Math.max(1, Math.round(finiteNumber(record.playtime) || 1))),
  ]);
}

function normalizeBattleRecordTeam(value) {
  const team = positiveInt(value);
  return team === 2 ? NTT_A1 : team === 4 ? NTT_B1 : team || NTT_A1;
}

function isATeamType(teamType) {
  const team = normalizeBattleRecordTeam(teamType);
  return team === NTT_A1 || team === 2;
}

function isBTeamType(teamType) {
  const team = normalizeBattleRecordTeam(teamType);
  return team === NTT_B1 || team === 4;
}

function buildRaidBossResultData(result = {}) {
  const data = result || {};
  return Buffer.concat([
    writeFloatLE(Number(data.initHp || data.initHP || 0) || 0),
    writeFloatLE(Number(data.curHP || data.curHp || 0) || 0),
    writeFloatLE(Number(data.maxHp || data.maxHP || 0) || 0),
    writeFloatLE(Number(data.damage || 0) || 0),
  ]);
}

function buildShadowGameResultData(dynamicGame = {}, battleState = {}, options = {}) {
  const palaceId = positiveInt(dynamicGame.palaceID || dynamicGame.palaceId);
  const dungeonId = palaceId ? positiveInt(dynamicGame.dungeonID) : 0;
  const recentTime = Math.max(0, Math.round(Number((battleState && (battleState.gameTime || battleState.GameTime)) || 0)));
  if (!palaceId || !options.user) {
    return shadowPalace.buildShadowPalaceBattleResultPayload({
      palaceId,
      dungeonData: { dungeonId, recentTime, bestTime: recentTime },
      reward: null,
      newRecord: false,
      currentDungeonId: nextShadowDungeonId(palaceId, dungeonId),
      life: 3,
    });
  }
  const result = shadowPalace.recordShadowPalaceBattleResult(
    { dateTimeBinaryNow },
    options.user,
    {
      palaceId,
      dungeonId,
      win: options.win === true,
      playTime: recentTime,
      replay: options.replay,
    }
  );
  return shadowPalace.buildShadowPalaceBattleResultPayload(result);
}

function buildPalaceDungeonData(dungeonId = 0, recentTime = 0, bestTime = 0) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(dungeonId)), // dungeonId
    writeSignedVarInt(Math.max(0, Number(recentTime || 0) || 0)), // recentTime
    writeSignedVarInt(Math.max(0, Number(bestTime || 0) || 0)), // bestTime
  ]);
}

function nextShadowDungeonId(palaceId, currentDungeonId) {
  const catalog = loadMiscStageCatalog();
  const palace = catalog.shadowPalaceById.get(positiveInt(palaceId));
  const battles = palace ? catalog.shadowBattlesByGroup.get(positiveInt(palace.BATTLE_GROUP_ID)) || [] : [];
  const currentIndex = battles.findIndex((battle) => positiveInt(battle && battle.DUNGEON_ID) === positiveInt(currentDungeonId));
  if (currentIndex >= 0 && currentIndex + 1 < battles.length) return positiveInt(battles[currentIndex + 1].DUNGEON_ID);
  return 0;
}

function buildFierceResultState(options = {}) {
  const dynamicGame = options.dynamicGame || {};
  const battleState = options.battleState || {};
  const classifiedStage = dynamicGame.dungeonID ? classifyMiscDungeon(dynamicGame.dungeonID) : null;
  const bossId = positiveInt(
    options.fierceBossId ||
      dynamicGame.fierceBossId ||
      dynamicGame.fierceBossID ||
      dynamicGame.bossId ||
      (classifiedStage && classifiedStage.fierceBossId)
  );
  const boss = bossId ? loadMiscStageCatalog().fierceBossById.get(bossId) : null;
  if (!boss || String(dynamicGame.miscMode || "") !== "fierce" && Number(dynamicGame.gameType || 0) !== NGT_FIERCE && !options.force) {
    return {
      hpPercent: 0,
      restTime: 0,
      accquirePoint: 0,
      bestPoint: 0,
      penaltyPoint: 0,
      penaltyIds: [],
    };
  }
  const saved = getFierceSavedBossState(options.user, bossId);
  const plannedPenaltyIds = uniquePositiveIntList(dynamicGame.fiercePenaltyIds || dynamicGame.FiercePenaltyIds);
  const penaltyIds = normalizeFiercePenaltyIdsForBoss(bossId, options.penaltyIds || plannedPenaltyIds || saved.penaltyIds || []);
  const win =
    typeof options.win === "boolean"
      ? options.win
      : resolveBattleWin(battleState, { fallbackWin: true, preferFallbackWin: false });
  const playTime = getBattlePlayTime(battleState);
  const maxTime = Math.max(
    1,
    Number(
      options.maxTime ||
        battleState.maxGameTime ||
        battleState.MaxGameTime ||
        battleState.initialRemainGameTime ||
        battleState.remainGameTime ||
        battleState.RemainGameTime ||
        dynamicGame.initialRemainGameTime ||
        180
    ) || 180
  );
  const restTime = win ? Math.max(0, Number(battleState.restTime ?? battleState.RestTime ?? maxTime - playTime) || 0) : 0;
  const explicitHpPercent = finiteNumber(battleState.bossHpPercent ?? battleState.BossHpPercent, NaN);
  const hpPercent = win
    ? 0
    : Number.isFinite(explicitHpPercent)
      ? Math.max(0, Math.min(100, Math.round(explicitHpPercent)))
      : 100;
  const explicitDamageRatio = finiteNumber(
    battleState.bossDamageRatio ??
      battleState.BossDamageRatio ??
      battleState.raidBossDamageRatio ??
      battleState.RaidBossDamageRatio,
    NaN
  );
  const damageRatio = win
    ? 1
    : Number.isFinite(explicitDamageRatio)
      ? Math.max(0, Math.min(1, explicitDamageRatio))
      : Math.max(0, Math.min(1, (100 - hpPercent) / 100));
  const basePoint = Math.max(0, Math.trunc(Number((dynamicGame.fierceBasePoint ?? dynamicGame.FierceBasePoint ?? boss.BasePoint) || 0) || 0));
  const maxDamagePoint = Math.max(
    0,
    Math.trunc(Number((dynamicGame.fierceMaxDamagePoint ?? dynamicGame.FierceMaxDamagePoint ?? boss.MaxDamagePoint) || 0) || 0)
  );
  const damagePoint = win
    ? maxDamagePoint
    : Math.round(maxDamagePoint * damageRatio);
  const maxTimePoint = Math.max(0, Math.trunc(Number((dynamicGame.fierceMaxTimePoint ?? dynamicGame.FierceMaxTimePoint ?? boss.MaxTimePoint) || 0) || 0));
  const timePoint = win ? Math.round(maxTimePoint * Math.min(1, restTime / maxTime)) : 0;
  const rawPoint = basePoint + damagePoint + timePoint;
  const penaltyRate = Math.max(
    0,
    Math.trunc(Number(dynamicGame.fiercePenaltyRate ?? dynamicGame.FiercePenaltyRate ?? getFiercePenaltyRate(penaltyIds)) || 0)
  );
  const calculatedPenaltyPoint = Math.round(rawPoint * penaltyRate / 10000);
  const managedPoint = Math.round(finiteNumber(options.fiercePoint ?? options.managedFiercePoint, -1));
  const managedPenaltyPoint = Math.round(finiteNumber(options.fiercePenaltyPoint ?? options.managedFiercePenaltyPoint, -1));
  const accquirePoint = managedPoint >= 0 ? managedPoint : Math.max(0, rawPoint + calculatedPenaltyPoint);
  const penaltyPoint = managedPoint >= 0 && managedPenaltyPoint >= 0 ? managedPenaltyPoint : calculatedPenaltyPoint;
  const previousBest = Math.max(0, Number(saved.point || 0) || 0);
  return {
    hpPercent,
    restTime,
    accquirePoint,
    bestPoint: Math.max(previousBest, accquirePoint),
    penaltyPoint,
    penaltyIds,
    bossId,
    fierceBossGroupId: positiveInt(boss.FierceBossGroupID),
  };
}

function buildFierceResultData(result = null) {
  const data = result && typeof result === "object" ? result : {};
  return Buffer.concat([
    writeSignedVarInt(Math.max(0, Number(data.hpPercent || 0) || 0)), // hpPercent
    writeFloatLE(Math.max(0, Number(data.restTime || 0) || 0)), // restTime
    writeSignedVarInt(Math.max(0, Number(data.accquirePoint || 0) || 0)), // accquirePoint
    writeSignedVarInt(Math.max(0, Number(data.bestPoint || 0) || 0)), // bestPoint
    writeNullObject(), // bestDeck
  ]);
}

function buildCutsceneDungeonClearAckPayload(dungeonId, user = null) {
  const stage = getCutsceneStage(dungeonId);
  const stageId = positiveInt(stage && stage.stageId);
  const episodeCompleteData = buildMainStoryEpisodeCompleteDataForStage(user, stageId);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(
      buildDungeonClearData(dungeonId, {
        stageId,
        missionResult1: false,
        missionResult2: false,
      })
    ),
    episodeCompleteData ? writeNullableObject(episodeCompleteData) : writeNullObject(),
  ]);
}

function buildGameLoadAck(data = {}) {
  const template = getCapturedServerPayloadTemplate(GAME_LOAD_ACK);
  if (!template) {
    console.log("[dynamic-game-load] no captured 804 template; sending null gameData fallback");
    return Buffer.concat([writeSignedVarInt(0), writeNullObject(), writeObjectList([])]);
  }

  const raw = Buffer.from(template);
  try {
    const spans = getGameLoadAckPatchSpans(raw);
    const replacements = [
      { ...spans.gameUID, payload: writeSignedVarLong(BigInt(data.gameUID || makeDynamicGameUid())) },
      { ...spans.gameUnitUIDIndex, payload: writeSignedVarInt(Number(data.gameUnitUIDIndex || nextGameUnitUidIndex(data))) },
    ];
    if (Number(data.gameType || 0) > 0) {
      replacements.push({ ...spans.gameType, payload: writeSignedVarInt(Number(data.gameType || 0)) });
    } else if (data.tutorial || isTutorialStageId(data.stageID) || isTutorialDungeonId(data.dungeonID)) {
      replacements.push({ ...spans.gameType, payload: writeSignedVarInt(NGT_TUTORIAL) });
    } else if (data.stageID || data.dungeonID) {
      replacements.push({ ...spans.gameType, payload: writeSignedVarInt(NGT_DUNGEON) });
    }
    if (data.raidUID != null && spans.raidUID) {
      replacements.push({ ...spans.raidUID, payload: writeSignedVarLong(toBigInt(data.raidUID || 0)) });
    }
    const teamBLevelFix = Number(data.teamBLevelFix || data.raidLevel || 0);
    const teamBLevelAdd = Number(data.teamBLevelAdd || 0);
    if (teamBLevelFix > 0 && spans.teamBLevelFix) {
      replacements.push({ ...spans.teamBLevelFix, payload: writeSignedVarInt(teamBLevelFix) });
      if (spans.teamBLevelAdd) {
        replacements.push({ ...spans.teamBLevelAdd, payload: writeSignedVarInt(0) });
      }
    } else if (teamBLevelAdd !== 0 && spans.teamBLevelAdd) {
      replacements.push({ ...spans.teamBLevelAdd, payload: writeSignedVarInt(teamBLevelAdd) });
      if (spans.teamBLevelFix) {
        replacements.push({ ...spans.teamBLevelFix, payload: writeSignedVarInt(0) });
      }
    }
    if (data.patchStageFields !== false) {
      replacements.push(
        { ...spans.dungeonID, payload: writeSignedVarInt(Number(data.dungeonID || 0)) },
        { ...spans.mapID, payload: writeSignedVarInt(Number(data.mapID || mapIdForStageDungeon(data.stageID, data.dungeonID))) }
      );
    }
    if (Array.isArray(data.battleConditionIds) && spans.battleConditionIds) {
      replacements.push({ ...spans.battleConditionIds, payload: writeIntIntMap(battleConditionLevelEntries(data.battleConditionIds)) });
    }
    replacements.sort((a, b) => b.start - a.start);

    return replacements.reduce(
      (buffer, replacement) => replaceBufferRange(buffer, replacement.start, replacement.end, replacement.payload),
      raw
    );
  } catch (err) {
    console.log(`[dynamic-game-load] template patch failed: ${err.message}; using captured 804 body`);
    return raw;
  }
}

function patchGameLoadAckBattleConditionIds(payload, battleConditionIds) {
  if (!payload || !Array.isArray(battleConditionIds)) return payload;
  try {
    const raw = Buffer.from(payload);
    const spans = getGameLoadAckPatchSpans(raw);
    if (!spans.battleConditionIds) return raw;
    return replaceBufferRange(raw, spans.battleConditionIds.start, spans.battleConditionIds.end, writeIntIntMap(battleConditionLevelEntries(battleConditionIds)));
  } catch (err) {
    console.log(`[dynamic-game-load] battle-condition patch failed: ${err.message}`);
    return payload;
  }
}

function resolveGameLoadBattleConditionIds(stage = {}, req = {}, user = null) {
  const gameType = Number(stage.gameType || (req && req.gameType) || 0);
  const bossId = positiveInt(stage.fierceBossId || req.fierceBossId || req.fierceBossID || req.bossId);
  if (String(stage.miscMode || "") !== "fierce" && gameType !== NGT_FIERCE && !bossId) {
    const explicit = uniquePositiveIntList(stage.battleConditionIds);
    return explicit.length ? explicit : null;
  }
  let resolvedBossId = bossId;
  if (!resolvedBossId) {
    const dungeonId = positiveInt(stage.dungeonID || stage.dungeonId || req.dungeonID || req.dungeonId);
    const bossByDungeon = dungeonId ? loadMiscStageCatalog().fierceBossByDungeonId.get(dungeonId) : null;
    resolvedBossId = positiveInt(bossByDungeon && bossByDungeon.FierceBossID);
  }
  if (!resolvedBossId) {
    const miscStage = resolveMiscStageRequest(req);
    resolvedBossId = positiveInt(miscStage && miscStage.fierceBossId);
  }
  if (!resolvedBossId) return uniquePositiveIntList(stage.battleConditionIds);
  const saved = getFierceSavedBossState(user, resolvedBossId);
  const penaltyIds = Array.isArray(saved.penaltyIds) ? saved.penaltyIds : [];
  const ids = getFierceBattleConditionIdsForBoss(resolvedBossId, penaltyIds);
  return ids.length ? ids : uniquePositiveIntList(stage.battleConditionIds);
}

function buildFierceScorePlanForStage(stage = {}, req = {}, user = null) {
  const gameType = Number(stage.gameType || (req && req.gameType) || 0);
  const catalog = loadMiscStageCatalog();
  let bossId = positiveInt(stage.fierceBossId || stage.fierceBossID || req.fierceBossId || req.fierceBossID || req.bossId);
  if (!bossId) {
    const dungeonId = positiveInt(stage.dungeonID || stage.dungeonId || req.dungeonID || req.dungeonId);
    const bossByDungeon = dungeonId ? catalog.fierceBossByDungeonId.get(dungeonId) : null;
    bossId = positiveInt(bossByDungeon && bossByDungeon.FierceBossID);
  }
  if (String(stage.miscMode || "").toLowerCase() !== "fierce" && gameType !== NGT_FIERCE && !bossId) return {};

  const boss = bossId ? catalog.fierceBossById.get(bossId) : null;
  if (!boss) return {};

  const saved = getFierceSavedBossState(user, bossId);
  const penaltyIds = normalizeFiercePenaltyIdsForBoss(bossId, saved.penaltyIds || []);
  return {
    fierceBossId: bossId,
    fierceBossGroupId: positiveInt(boss.FierceBossGroupID),
    fierceBasePoint: Math.max(0, Math.trunc(Number(boss.BasePoint || 0) || 0)),
    fierceMaxDamagePoint: Math.max(0, Math.trunc(Number(boss.MaxDamagePoint || 0) || 0)),
    fierceMaxTimePoint: Math.max(0, Math.trunc(Number(boss.MaxTimePoint || 0) || 0)),
    fiercePenaltyIds: penaltyIds,
    fiercePenaltyRate: getFiercePenaltyRate(penaltyIds),
  };
}

function buildRespawnAck(data = {}) {
  return combatHandler.buildRespawnAck(data);
}

function buildGameSync(data = {}) {
  return combatHandler.buildSync(data);
}

function buildGameSyncPackets(data = {}) {
  return combatHandler.buildGameSyncPackets(data);
}

function continueBattleStateUnits(battleState, delta) {
  return combatHandler.tick(delta, battleState);
}

function buildInitialBattleSync(replay) {
  return combatHandler.buildInitialBattleSync(replay);
}

function buildInitialBattlePackets(replay) {
  return combatHandler.buildInitialBattlePackets(replay);
}

function ensureGameStartPackets(packets = [], replay = null, socket = null) {
  const user = socket && socket.session && socket.session.user;
  const loadCompletePayload = buildGameLoadCompleteAckPayload(replay, user);
  const sourcePackets = (Array.isArray(packets) ? packets : []).filter(Boolean).map((packet) => {
    if (!packet || packet.packetId !== GAME_LOAD_COMPLETE_ACK) return packet;
    return {
      ...packet,
      payload: packet.payload || loadCompletePayload,
      label: packet.label || "dynamic-load-complete",
    };
  });
  const sourceLoadComplete = sourcePackets.find((packet) => packet.packetId === GAME_LOAD_COMPLETE_ACK);
  const sourceGameStart = sourcePackets.find((packet) => packet.packetId === GAME_START_NOT);
  if (replay && replay.dynamicGame && replay.dynamicGame.managedCombat && (!sourceLoadComplete || !sourceGameStart)) {
    console.log("[combat-host] managed initial handshake missing GAME_LOAD_COMPLETE_ACK or GAME_START_NOT");
    return [];
  }
  return [
    sourceLoadComplete || {
      packetId: GAME_LOAD_COMPLETE_ACK,
      payload: loadCompletePayload,
      label: "dynamic-load-complete",
    },
    sourceGameStart || {
      packetId: GAME_START_NOT,
      payload: Buffer.alloc(0),
      label: "dynamic-game-start",
    },
    ...sourcePackets.filter((packet) => packet.packetId !== GAME_LOAD_COMPLETE_ACK && packet.packetId !== GAME_START_NOT),
  ];
}

function getCapturedServerPayloadTemplate(packetId) {
  if (!capturedGameTemplateFlow || !Array.isArray(capturedGameTemplateFlow.server)) return null;
  const entry = capturedGameTemplateFlow.server.find((item) => item && item.packetId === packetId && item.payload);
  if (!entry) return null;
  return entry.compressed ? lz4StreamDecompress(entry.payload) : decryptCopy(entry.payload);
}

function getGameLoadAckPatchSpans(raw) {
  let offset = 0;
  const errorCode = readSignedVarInt(raw, offset);
  offset = errorCode.offset;
  if (raw.readUInt8(offset) === 0) throw new Error("captured GAME_LOAD_ACK has null gameData");
  offset += 1;

  const gameUID = readVarLong(raw, offset);
  const gameUIDSpan = { start: offset, end: gameUID.offset };
  offset = gameUID.offset;

  const gameUnitUIDIndex = readVarInt(raw, offset);
  const gameUnitUIDIndexSpan = { start: offset, end: gameUnitUIDIndex.offset };
  offset = gameUnitUIDIndex.offset;

  offset += 1; // m_bLocal
  const gameType = readSignedVarInt(raw, offset);
  const gameTypeSpan = { start: offset, end: gameType.offset };
  offset = gameType.offset;

  const dungeonID = readSignedVarInt(raw, offset);
  const dungeonIDSpan = { start: offset, end: dungeonID.offset };
  offset = dungeonID.offset;

  offset += 1; // m_bBossDungeon
  offset = readSignedVarInt(raw, offset).offset; // m_WarfareID
  const raidUID = readVarLong(raw, offset);
  const raidUIDSpan = { start: offset, end: raidUID.offset };
  offset = raidUID.offset; // m_RaidUID
  offset += 4; // m_fRespawnCostMinusPercentForTeamA
  offset = readSignedVarInt(raw, offset).offset; // m_TeamASupply
  offset += 4; // m_fTeamAAttackPowerIncRateForWarfare
  offset = skipStringList(raw, offset); // m_lstTeamABuffStrIDListForRaid
  offset += 4; // fExtraRespawnCostAddForA
  offset += 4; // fExtraRespawnCostAddForB
  const teamBLevelAdd = readSignedVarInt(raw, offset);
  const teamBLevelAddSpan = { start: offset, end: teamBLevelAdd.offset };
  offset = teamBLevelAdd.offset; // m_TeamBLevelAdd
  const teamBLevelFix = readSignedVarInt(raw, offset);
  const teamBLevelFixSpan = { start: offset, end: teamBLevelFix.offset };
  offset = teamBLevelFix.offset; // m_TeamBLevelFix
  offset += 4; // m_fDoubleCostTime

  const mapID = readSignedVarInt(raw, offset);
  const mapIDSpan = { start: offset, end: mapID.offset };
  offset = mapID.offset;
  const battleConditionIdsSpan = { start: offset, end: skipCapturedSignedIntMap(raw, offset) };

  return {
    gameUID: gameUIDSpan,
    gameUnitUIDIndex: gameUnitUIDIndexSpan,
    gameType: gameTypeSpan,
    dungeonID: dungeonIDSpan,
    raidUID: raidUIDSpan,
    teamBLevelAdd: teamBLevelAddSpan,
    teamBLevelFix: teamBLevelFixSpan,
    mapID: mapIDSpan,
    battleConditionIds: battleConditionIdsSpan,
  };
}

function skipStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    offset = readString(buffer, offset).offset;
  }
  return offset;
}

function replaceBufferRange(buffer, start, end, replacement) {
  return Buffer.concat([buffer.subarray(0, start), replacement, buffer.subarray(end)]);
}

function makeDynamicGameUid() {
  return BigInt(Date.now()) * 10000n + BigInt(process.pid % 10000);
}

function nextGameUnitUidIndex(data) {
  const values = Array.isArray(data.assignedGameUnitUIDs) ? data.assignedGameUnitUIDs.map(Number) : [];
  return Math.max(18, values.length ? Math.max(...values) + 1 : 18);
}

function mapIdForStageDungeon(stageID, dungeonID) {
  const mainStoryMapId = mainStoryMapIdForStageDungeon(stageID, dungeonID);
  if (mainStoryMapId || isMainStoryStageId(stageID) || isMainStoryDungeonId(dungeonID)) return mainStoryMapId;
  const tutorialMapId = tutorialMapIdForStageDungeon(stageID, dungeonID);
  if (tutorialMapId || isTutorialStageId(stageID) || isTutorialDungeonId(dungeonID)) return tutorialMapId;
  const stage = getGenericStageForRequest({ stageID, dungeonID });
  return Number((stage && stage.mapID) || 0);
}

function buildGameRespawnAckPayload(unitUID, assistUnit, errorCode = 0) {
  return combatHandler.buildGameRespawnAckPayload(unitUID, assistUnit, errorCode);
}

function buildGameUnitSkillAckPayload(gameUnitUID, skillStateID = 0, errorCode = 0) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(Number(gameUnitUID || 0)),
    Buffer.from([Number(skillStateID || 0) & 0xff]),
  ]);
}

function buildGameShipSkillAckPayload(gameUnitUID, shipSkillID, skillPosX, errorCode = 0) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(Number(gameUnitUID || 0)),
    writeSignedVarInt(Number(shipSkillID || 0)),
    writeFloatLE(Number(skillPosX || 0)),
  ]);
}

function buildGamePauseAckPayload(isPause, isPauseEvent, errorCode = 0) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeBool(Boolean(isPause)), writeBool(Boolean(isPauseEvent))]);
}

function buildGameLoadCompleteAckPayload(replay = null, user = null, options = {}) {
  const runtimeData = replay && replay.dynamicGame ? buildGameRuntimeData(replay, getReplayCombatControls(replay, user), user) : null;
  const rewardMultiply = options.rewardMultiply == null
    ? Math.max(0, Math.trunc(Number(replay && replay.dynamicGame && replay.dynamicGame.rewardMultiply || 0)))
    : Math.max(0, Math.trunc(Number(options.rewardMultiply || 0)));
  return Buffer.concat([
    writeSignedVarInt(Number(options.errorCode || 0)),
    writeBool(Boolean(options.isIntrude)),
    runtimeData ? writeNullableObject(runtimeData) : writeNullObject(), // gameRuntimeData
    writeSignedVarInt(rewardMultiply),
  ]);
}

function buildGameRuntimeData(replay, controls, user) {
  const dynamicGame = replay && replay.dynamicGame && typeof replay.dynamicGame === "object" ? replay.dynamicGame : {};
  const battleState = replay && replay.battleState && typeof replay.battleState === "object" ? replay.battleState : {};
  const gameState = battleState.gameState && typeof battleState.gameState === "object" ? battleState.gameState : {};
  const gameTime = finiteNumber(battleState.gameTime ?? replay.syntheticGameTime, 4);
  const remainGameTime = finiteNumber(battleState.remainGameTime ?? dynamicGame.remainGameTime, 180);
  const waveId = Math.max(0, Math.trunc(finiteNumber(gameState.waveId ?? gameState.waveID ?? battleState.waveId, 1)));
  const state = clampCombatControlEnum(gameState.state ?? battleState.gameStateType ?? 2, 0, 7);
  const respawnCostA1 = finiteNumber(battleState.respawnCostA1 ?? dynamicGame.respawnCostA1, 10);
  const respawnCostB1 = finiteNumber(battleState.respawnCostB1 ?? dynamicGame.respawnCostB1, 10);
  return Buffer.concat([
    writeFloatLE(gameTime),
    writeSignedVarInt(controls.gameSpeedType),
    writeFloatLE(0), // m_PrevWaveEndTime
    writeSignedVarInt(state), // NKM_GAME_STATE
    writeSignedVarInt(waveId),
    writeFloatLE(remainGameTime),
    writeFloatLE(0), // m_fShipDamage
    writeSignedVarInt(0), // NKM_TEAM_TYPE.NTT_INVALID
    writeBool(false), // m_bGameEnded
    writeBool(false), // m_bPause
    writeBool(false), // m_bGiveUp
    writeBool(false), // m_bRestart
    writeNullableObject(buildGameRuntimeTeamData(user && user.userUid, {
      autoRespawnEnabled: controls.autoRespawnEnabled,
      autoSkillType: controls.autoSkillType,
      respawnCost: respawnCostA1,
    })),
    writeNullableObject(buildGameRuntimeTeamData(0, {
      autoRespawnEnabled: false,
      autoSkillType: 0,
      respawnCost: respawnCostB1,
    })),
    writeObjectList([]), // m_lstPermanentDungeonEvent
  ]);
}

function buildGameRuntimeTeamData(userUid, options = {}) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(userUid || 0)),
    writeBool(Boolean(options.autoRespawnEnabled)),
    writeBool(false), // m_bAIDisable
    writeBool(false), // m_bGodMode
    writeFloatLE(finiteNumber(options.respawnCost, 10)),
    writeFloatLE(finiteNumber(options.respawnCostAssist, 0)),
    writeFloatLE(finiteNumber(options.usedRespawnCost, 0)),
    writeSignedVarInt(Math.max(0, Math.trunc(finiteNumber(options.respawnCount, 0)))),
    writeSignedVarInt(clampCombatControlEnum(options.autoSkillType, 0, 1)),
  ]);
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildStagePlayData(stageId, battleState = {}) {
  return Buffer.concat([
    writeSignedVarInt(stageId),
    writeSignedVarLong(toBigInt(battleState.playCount == null ? 1 : battleState.playCount)),
    writeSignedVarLong(toBigInt(battleState.restoreCount || 0)),
    writeSignedVarLong(toBigInt(battleState.bestKillCount || 0)),
    writeInt64LE(toBigInt(battleState.nextResetDate || dateTimeBinaryNow())),
    writeSignedVarInt(Math.max(0, Math.round(Number(battleState.bestClearTimeSec || battleState.gameTime || battleState.GameTime || 0)))),
    writeSignedVarLong(toBigInt(battleState.totalPlayCount == null ? 1 : battleState.totalPlayCount)),
  ]);
}

function buildProjectedStagePlayData(user, stageId, battleState = {}, playCountDelta = 1) {
  const saved = user && user.stagePlayData && typeof user.stagePlayData === "object"
    ? user.stagePlayData[String(Number(stageId || 0))] || {}
    : {};
  const delta = Math.max(1, Math.trunc(Number(playCountDelta || 1)) || 1);
  return buildStagePlayData(stageId, {
    ...saved,
    ...battleState,
    playCount: Math.max(0, Number(saved.playCount || 0) || 0) + delta,
    totalPlayCount: Math.max(0, Number(saved.totalPlayCount || 0) || 0) + delta,
  });
}

function stageIdForDungeonId(dungeonId) {
  return mainStoryStageIdForDungeonId(dungeonId) || tutorialStageIdForDungeonId(dungeonId) || findStageIdForDungeonId(dungeonId);
}

function loadDungeonCatalog() {
  if (cachedDungeonCatalog) return cachedDungeonCatalog;
  cachedDungeonCatalog = { byId: {}, byStrId: {} };
  if (DUNGEON_TABLE_OVERRIDE_PATH && fs.existsSync(DUNGEON_TABLE_OVERRIDE_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DUNGEON_TABLE_OVERRIDE_PATH, "utf8"));
      cachedDungeonCatalog = parsed && typeof parsed === "object" ? parsed : cachedDungeonCatalog;
      ensureDungeonCatalogIndexes(cachedDungeonCatalog);
      if (Object.keys(cachedDungeonCatalog.byId).length > 0) {
        console.log(
          `[dungeon-table] loaded override entries=${Object.keys(cachedDungeonCatalog.byId).length} source=${DUNGEON_TABLE_OVERRIDE_PATH}`
        );
        return cachedDungeonCatalog;
      }
    } catch (err) {
      console.log(`[dungeon-table] failed to load ${DUNGEON_TABLE_OVERRIDE_PATH}: ${summarizeErrorLine(err)}`);
    }
  }

  const frozenClientCatalog = buildDungeonCatalogFromGameplayJsons();
  if (Object.keys(frozenClientCatalog.byId).length > 0) {
    cachedDungeonCatalog = frozenClientCatalog;
    console.log(
      `[dungeon-table] loaded frozen-client entries=${Object.keys(cachedDungeonCatalog.byId).length} source=${GAMEPLAY_TABLES_DIR}`
    );
    return cachedDungeonCatalog;
  }

  if (fs.existsSync(DUNGEON_TABLE_FALLBACK_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DUNGEON_TABLE_FALLBACK_PATH, "utf8"));
      cachedDungeonCatalog = parsed && typeof parsed === "object" ? parsed : cachedDungeonCatalog;
      ensureDungeonCatalogIndexes(cachedDungeonCatalog);
      console.log(
        `[dungeon-table] frozen-client table unavailable; loaded fallback entries=${Object.keys(cachedDungeonCatalog.byId).length} source=${DUNGEON_TABLE_FALLBACK_PATH}`
      );
    } catch (err) {
      console.log(`[dungeon-table] failed to load ${DUNGEON_TABLE_FALLBACK_PATH}: ${summarizeErrorLine(err)}`);
    }
  }
  return cachedDungeonCatalog;
}

function buildDungeonCatalogFromGameplayJsons() {
  const catalog = { byId: {}, byStrId: {} };
  const records = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", {
    rootDir: ROOT_DIR,
    logLabel: "dungeon-table",
  });
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const dungeonId = Number(record.m_DungeonID || 0);
    const dungeonStrId = String(record.m_DungeonStrID || "");
    if (Number.isInteger(dungeonId) && dungeonId > 0) catalog.byId[String(dungeonId)] = record;
    if (dungeonStrId) catalog.byStrId[dungeonStrId] = record;
  }
  if (records.length) catalog.count = Object.keys(catalog.byId).length;
  return catalog;
}

function ensureDungeonCatalogIndexes(catalog) {
  if (!catalog || typeof catalog !== "object") return;
  catalog.byId = catalog.byId && typeof catalog.byId === "object" ? catalog.byId : {};
  catalog.byStrId = catalog.byStrId && typeof catalog.byStrId === "object" ? catalog.byStrId : {};
  for (const row of Object.values(catalog.byId)) {
    const strId = String(row && row.m_DungeonStrID ? row.m_DungeonStrID : "");
    if (strId && !catalog.byStrId[strId]) catalog.byStrId[strId] = row;
  }
}

function getDungeonTableEntry(dungeonId) {
  const catalog = loadDungeonCatalog();
  const byId = catalog && catalog.byId && typeof catalog.byId === "object" ? catalog.byId : {};
  return byId[String(Number(dungeonId || 0))] || null;
}

function readGameplayRecordsFromJsonPath(filePath, label) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.records)) return parsed.records;
  if (parsed && Array.isArray(parsed.root)) return parsed.root;
  if (parsed && parsed.root && typeof parsed.root === "object") return Object.values(parsed.root).filter((entry) => entry && typeof entry === "object");
  console.log(`[${label}] ${filePath} did not contain gameplay table records`);
  return [];
}

function loadStageCatalog() {
  if (cachedStageCatalog) return cachedStageCatalog;
  cachedStageCatalog = { byId: {}, byBattleStrId: {} };
  try {
    const records = STAGE_TABLE_PATH
      ? readGameplayRecordsFromJsonPath(STAGE_TABLE_PATH, "stage-table")
      : readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "stage-table" });
    const byId = {};
    const byBattleStrId = {};
    for (const record of records) {
      const stageId = Number(record && (record.m_StageID || record.StageID || record.stageId || 0));
      if (Number.isInteger(stageId) && stageId > 0) byId[String(stageId)] = record;
      const battleStrId = String((record && (record.m_StageBattleStrID || record.StageBattleStrID)) || "");
      if (battleStrId) {
        if (!byBattleStrId[battleStrId]) byBattleStrId[battleStrId] = [];
        byBattleStrId[battleStrId].push(record);
      }
    }
    cachedStageCatalog = { byId, byBattleStrId };
  } catch (err) {
    console.log(`[stage-table] failed to load stage table: ${summarizeErrorLine(err)}`);
  }
  return cachedStageCatalog;
}

function getStageTableEntry(stageId) {
  const catalog = loadStageCatalog();
  const byId = catalog && catalog.byId && typeof catalog.byId === "object" ? catalog.byId : {};
  return byId[String(Number(stageId || 0))] || null;
}

function getStageTableEntriesForBattleStrId(battleStrId) {
  const catalog = loadStageCatalog();
  const byBattleStrId =
    catalog && catalog.byBattleStrId && typeof catalog.byBattleStrId === "object" ? catalog.byBattleStrId : {};
  return Array.isArray(byBattleStrId[String(battleStrId || "")]) ? byBattleStrId[String(battleStrId || "")] : [];
}

function getDungeonTableEntryByStrId(dungeonStrId) {
  const strId = String(dungeonStrId || "");
  if (!strId) return null;
  const catalog = loadDungeonCatalog();
  const byStrId = catalog && catalog.byStrId && typeof catalog.byStrId === "object" ? catalog.byStrId : {};
  return byStrId[strId] || null;
}

function findStageRowForDungeonId(dungeonId) {
  const dungeon = getDungeonTableEntry(dungeonId);
  const dungeonStrId = String(dungeon && dungeon.m_DungeonStrID ? dungeon.m_DungeonStrID : "");
  if (!dungeonStrId) return null;
  const directStage = chooseStageRow(getStageTableEntriesForBattleStrId(dungeonStrId));
  if (directStage) return directStage;
  const phaseOrder = loadMiscStageCatalog().phaseOrderByDungeonId.get(positiveInt(dungeonId));
  if (!phaseOrder) return null;
  const phase = Array.from(loadMiscStageCatalog().phaseById.values()).find(
    (row) => positiveInt(row && row.m_PhaseGroupID) === positiveInt(phaseOrder.m_PhaseGroupID)
  );
  return phase ? chooseStageRow(getStageTableEntriesForBattleStrId(String(phase.m_PhaseStrID || ""))) : null;
}

function findStageIdForDungeonId(dungeonId) {
  const stage = findStageRowForDungeonId(dungeonId);
  return Number(stage && (stage.m_StageID || stage.StageID || stage.stageId || 0)) || 0;
}

function positiveInt(value) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function readMiscStageRecords(fileName) {
  try {
    return readGameplayTableRecords("ab_script", fileName, {
      rootDir: ROOT_DIR,
      logLabel: "misc-stage-table",
    });
  } catch (err) {
    console.log(`[misc-stage-table] failed to load ${fileName}: ${summarizeErrorLine(err)}`);
    return [];
  }
}

function mapListPush(map, key, value) {
  const normalizedKey = positiveInt(key);
  if (!normalizedKey || !value) return;
  if (!map.has(normalizedKey)) map.set(normalizedKey, []);
  map.get(normalizedKey).push(value);
}

function loadMiscStageCatalog() {
  if (cachedMiscStageCatalog) return cachedMiscStageCatalog;
  const catalog = {
    shadowPalaceById: new Map(),
    shadowPalaceByGroup: new Map(),
    shadowBattlesByGroup: new Map(),
    shadowBattleByDungeonId: new Map(),
    fierceSeasonRows: [],
    fierceBossById: new Map(),
    fierceBossByDungeonId: new Map(),
    fierceBossesByGroup: new Map(),
    fiercePenaltyById: new Map(),
    fiercePenaltiesByBossPenaltyGroup: new Map(),
    fiercePointRewardById: new Map(),
    fiercePointRewardsByGroup: new Map(),
    fierceRankRewardById: new Map(),
    fierceRankRewardsByGroup: new Map(),
    battleConditionByStrId: new Map(),
    trimById: new Map(),
    trimDungeonsByTrimId: new Map(),
    trimDungeonByDungeonId: new Map(),
    defenceById: new Map(),
    defenceByDungeonId: new Map(),
    exploreById: new Map(),
    exploreZoneById: new Map(),
    exploreStagesByGroup: new Map(),
    exploreStageByStageId: new Map(),
    exploreStageByDungeonId: new Map(),
    phaseById: new Map(),
    phaseByStrId: new Map(),
    phaseOrdersByGroup: new Map(),
    phaseOrderByDungeonId: new Map(),
  };

  for (const row of readMiscStageRecords("LUA_SHADOW_PALACE_TEMPLET.json")) {
    const palaceId = positiveInt(row && row.PALACE_ID);
    if (!palaceId) continue;
    catalog.shadowPalaceById.set(palaceId, row);
    const groupId = positiveInt(row.BATTLE_GROUP_ID);
    if (groupId) catalog.shadowPalaceByGroup.set(groupId, row);
  }
  for (const row of readMiscStageRecords("LUA_SHADOW_BATTLE_TEMPLET.json")) {
    const groupId = positiveInt(row && row.BATTLE_GROUP);
    const dungeonId = positiveInt(row && row.DUNGEON_ID);
    if (!groupId || !dungeonId) continue;
    mapListPush(catalog.shadowBattlesByGroup, groupId, row);
    catalog.shadowBattleByDungeonId.set(dungeonId, row);
  }
  for (const battles of catalog.shadowBattlesByGroup.values()) {
    battles.sort((left, right) => positiveInt(left.BATTLE_ORDER) - positiveInt(right.BATTLE_ORDER) || positiveInt(left.DUNGEON_ID) - positiveInt(right.DUNGEON_ID));
  }

  catalog.fierceSeasonRows = readMiscStageRecords("LUA_FIERCE_TEMPLET.json")
    .filter((row) => positiveInt(row && row.FierceID))
    .sort((left, right) => positiveInt(right.FierceID) - positiveInt(left.FierceID));
  const fierceBossRows = readMiscStageRecords("LUA_FIERCE_BOSS_GROUP_TEMPLET.json")
    .filter((row) => positiveInt(row && row.FierceBossID) && positiveInt(row && row.DungeonID))
    .sort(
      (left, right) =>
        positiveInt(left.Level) - positiveInt(right.Level) ||
        positiveInt(left.FierceBossID) - positiveInt(right.FierceBossID)
    );
  for (const row of fierceBossRows) {
    const bossId = positiveInt(row.FierceBossID);
    const groupId = positiveInt(row.FierceBossGroupID);
    const dungeonId = positiveInt(row.DungeonID);
    if (!catalog.fierceBossById.has(bossId)) catalog.fierceBossById.set(bossId, row);
    if (!catalog.fierceBossByDungeonId.has(dungeonId)) catalog.fierceBossByDungeonId.set(dungeonId, row);
    mapListPush(catalog.fierceBossesByGroup, groupId, row);
  }
  for (const row of readMiscStageRecords("LUA_FIERCE_PENALTY.json")) {
    const penaltyId = positiveInt(row && row.PenaltyID);
    const bossPenaltyGroupId = positiveInt(row && row.BossPenaltyGroupID);
    if (penaltyId) catalog.fiercePenaltyById.set(penaltyId, row);
    mapListPush(catalog.fiercePenaltiesByBossPenaltyGroup, bossPenaltyGroupId, row);
  }
  for (const rows of catalog.fiercePenaltiesByBossPenaltyGroup.values()) {
    rows.sort(
      (left, right) =>
        positiveInt(left.PenaltyGroupID) - positiveInt(right.PenaltyGroupID) ||
        positiveInt(left.PenaltyLevel) - positiveInt(right.PenaltyLevel) ||
        positiveInt(left.PenaltyID) - positiveInt(right.PenaltyID)
    );
  }
  for (const row of readMiscStageRecords("LUA_FIERCE_POINT_REWARD.json")) {
    const rewardId = positiveInt(row && row.FiercePointRewardID);
    const groupId = positiveInt(row && row.FiercePointRewardGroupID);
    if (rewardId) catalog.fiercePointRewardById.set(rewardId, row);
    mapListPush(catalog.fiercePointRewardsByGroup, groupId, row);
  }
  for (const rows of catalog.fiercePointRewardsByGroup.values()) {
    rows.sort(
      (left, right) =>
        positiveInt(left.Step) - positiveInt(right.Step) ||
        positiveInt(left.Point) - positiveInt(right.Point) ||
        positiveInt(left.FiercePointRewardID) - positiveInt(right.FiercePointRewardID)
    );
  }
  for (const row of readMiscStageRecords("LUA_FIERCE_RANK_REWARD.json")) {
    const rewardId = positiveInt(row && row.FierceRankRewardID);
    const groupId = positiveInt(row && row.FierceRankRewardGroupID);
    if (rewardId) catalog.fierceRankRewardById.set(rewardId, row);
    mapListPush(catalog.fierceRankRewardsByGroup, groupId, row);
  }
  for (const rows of catalog.fierceRankRewardsByGroup.values()) {
    rows.sort(
      (left, right) =>
        positiveInt(left.ShowIndex) - positiveInt(right.ShowIndex) ||
        positiveInt(left.RankValue) - positiveInt(right.RankValue) ||
        positiveInt(left.FierceRankRewardID) - positiveInt(right.FierceRankRewardID)
    );
  }
  for (const row of readMiscStageRecords("LUA_BATTLE_CONDITION_TEMPLET.json")) {
    const strId = String(row && row.m_BCondStrID || "");
    if (strId) catalog.battleConditionByStrId.set(strId, row);
  }

  for (const row of readMiscStageRecords("LUA_TRIM_TEMPLET.json")) {
    const trimId = positiveInt(row && row.TrimID);
    if (trimId) catalog.trimById.set(trimId, row);
  }
  for (const row of readMiscStageRecords("LUA_TRIM_DUNGEON.json")) {
    const trimId = positiveInt(row && row.TrimID);
    const dungeonId = positiveInt(row && row.DungeonID);
    if (!trimId || !dungeonId) continue;
    mapListPush(catalog.trimDungeonsByTrimId, trimId, row);
    catalog.trimDungeonByDungeonId.set(dungeonId, row);
  }
  for (const rows of catalog.trimDungeonsByTrimId.values()) {
    rows.sort((left, right) => positiveInt(left.TrimDungeonID) - positiveInt(right.TrimDungeonID) || positiveInt(left.DungeonID) - positiveInt(right.DungeonID));
  }

  for (const row of readMiscStageRecords("LUA_DEFENCE_TEMPLET.json")) {
    const defenceId = positiveInt(row && row.m_Id);
    const dungeonId = positiveInt(row && row.m_DungeonID);
    if (defenceId) catalog.defenceById.set(defenceId, row);
    if (dungeonId) catalog.defenceByDungeonId.set(dungeonId, row);
  }

  for (const row of readMiscStageRecords("LUA_EXPLORE_TEMPLET.json")) {
    const exploreId = positiveInt(row && row.ExploreID);
    if (exploreId) catalog.exploreById.set(exploreId, row);
  }
  for (const row of readMiscStageRecords("LUA_EXPLORE_ZONE_TEMPLET.json")) {
    const zoneId = positiveInt(row && row.Zone);
    if (zoneId) catalog.exploreZoneById.set(zoneId, row);
  }
  for (const row of readMiscStageRecords("LUA_EXPLORE_STAGE_TEMPLET.json")) {
    const stageId = positiveInt(row && row.StageID);
    const groupId = positiveInt(row && row.StageGroupID);
    const dungeonId = String(row && row.StageType || "").toUpperCase() === "DUNGEON" ? positiveInt(row && row.EventValue) : 0;
    mapListPush(catalog.exploreStagesByGroup, groupId, row);
    if (stageId) catalog.exploreStageByStageId.set(stageId, row);
    if (dungeonId) catalog.exploreStageByDungeonId.set(dungeonId, row);
  }
  for (const rows of catalog.exploreStagesByGroup.values()) {
    rows.sort((left, right) => positiveInt(left.StageID) - positiveInt(right.StageID));
  }

  for (const row of readMiscStageRecords("LUA_PHASE_TEMPLET.json")) {
    const phaseId = positiveInt(row && row.m_PhaseID);
    const phaseStrId = String(row && row.m_PhaseStrID || "");
    if (phaseId) catalog.phaseById.set(phaseId, row);
    if (phaseStrId) catalog.phaseByStrId.set(phaseStrId, row);
  }
  for (const row of readMiscStageRecords("LUA_PHASE_ORDER_TEMPLET.json")) {
    const groupId = positiveInt(row && row.m_PhaseGroupID);
    const dungeonStrId = String(row && row.m_DungeonStrID || "");
    if (!groupId || !dungeonStrId) continue;
    mapListPush(catalog.phaseOrdersByGroup, groupId, row);
    const dungeon = getDungeonTableEntryByStrId(dungeonStrId);
    const dungeonId = positiveInt(dungeon && dungeon.m_DungeonID);
    if (dungeonId) catalog.phaseOrderByDungeonId.set(dungeonId, row);
  }
  for (const orders of catalog.phaseOrdersByGroup.values()) {
    orders.sort((left, right) => positiveInt(left.m_PhaseOrder) - positiveInt(right.m_PhaseOrder));
  }

  cachedMiscStageCatalog = catalog;
  return cachedMiscStageCatalog;
}

function chooseTrimDungeon(trimId, trimLevel) {
  const catalog = loadMiscStageCatalog();
  const rows = catalog.trimDungeonsByTrimId.get(positiveInt(trimId)) || [];
  const level = Math.max(1, positiveInt(trimLevel) || 1);
  return (
    rows.find((row) => level >= Math.max(1, positiveInt(row.TrimLevel_Low) || 1) && level <= Math.max(1, positiveInt(row.TrimLevel_High) || level)) ||
    rows[0] ||
    null
  );
}

function choosePhaseOrder(phase, phaseIndex = 0) {
  const catalog = loadMiscStageCatalog();
  const orders = catalog.phaseOrdersByGroup.get(positiveInt(phase && phase.m_PhaseGroupID)) || [];
  return orders[Math.max(0, Number(phaseIndex || 0) || 0)] || null;
}

function getFierceRotationSeasonRows() {
  const catalog = loadMiscStageCatalog();
  const productionRows = catalog.fierceSeasonRows
    .filter((row) => isRotatableFierceSeason(row))
    .sort((left, right) => positiveInt(left.FierceID) - positiveInt(right.FierceID));
  if (productionRows.length) {
    const newestBucket = Math.max(...productionRows.map((row) => Math.floor(positiveInt(row && row.FierceID) / 100)));
    const newestRows = productionRows.filter((row) => Math.floor(positiveInt(row && row.FierceID) / 100) === newestBucket);
    return newestRows.length ? newestRows : productionRows;
  }
  return catalog.fierceSeasonRows
    .filter((row) => positiveInt(row && row.FierceID) < 9000)
    .sort((left, right) => positiveInt(left.FierceID) - positiveInt(right.FierceID));
}

function isRotatableFierceSeason(row) {
  const fierceId = positiveInt(row && row.FierceID);
  if (!fierceId || fierceId >= 9000) return false;
  const openTag = String(row && row.m_OpenTag || "").toUpperCase();
  const gameDateStrId = String(row && row.m_GameDateStrID || "").toUpperCase();
  if (!openTag.includes("GLOBAL") || openTag.startsWith("TAG_ZL") || openTag.includes("DEV") || gameDateStrId.includes("_ZL")) return false;
  const groupId = positiveInt(row && row.FierceBossGroupID_1);
  return groupId > 0;
}

function getCurrentFierceSeasonRow(now = getServerNowDate()) {
  const catalog = loadMiscStageCatalog();
  const forcedId = positiveInt(process.env.CS_FIERCE_SEASON_ID || process.env.CS_DANGER_CLOSE_SEASON_ID);
  if (forcedId && catalog.fierceSeasonRows.length) {
    return catalog.fierceSeasonRows.find((row) => positiveInt(row && row.FierceID) === forcedId) || catalog.fierceSeasonRows[0] || null;
  }
  const rows = getFierceRotationSeasonRows();
  if (!rows.length) return catalog.fierceSeasonRows[0] || null;
  const slot = getFierceRotationSlot(now);
  const index = positiveModulo(slot, rows.length);
  return rows[index] || rows[0] || null;
}

function getCurrentFierceSeasonId(now = getServerNowDate()) {
  const season = getCurrentFierceSeasonRow(now);
  return positiveInt(season && season.FierceID);
}

function getFierceRotationSlot(now = getServerNowDate()) {
  const anchor = coerceValidDate(FIERCE_ROTATION_ANCHOR_ISO) || new Date(Date.UTC(2025, 9, 1, 3, 0, 0, 0));
  const target = coerceValidDate(now) || getServerNowDate();
  const cycleMs = Math.max(1, FIERCE_ROTATION_CYCLE_DAYS) * FIERCE_DAY_MS;
  return Math.floor((target.getTime() - anchor.getTime()) / cycleMs);
}

function getCurrentFierceSeasonWindow(now = getServerNowDate()) {
  const anchor = coerceValidDate(FIERCE_ROTATION_ANCHOR_ISO) || new Date(Date.UTC(2025, 9, 1, 3, 0, 0, 0));
  const slot = getFierceRotationSlot(now);
  const startDate = new Date(anchor.getTime() + slot * FIERCE_ROTATION_CYCLE_DAYS * FIERCE_DAY_MS);
  const gameEndDate = new Date(startDate.getTime() + FIERCE_ROTATION_GAME_DAYS * FIERCE_DAY_MS);
  const rewardEndDate = new Date(startDate.getTime() + FIERCE_ROTATION_CYCLE_DAYS * FIERCE_DAY_MS);
  return {
    startDate,
    gameEndDate,
    rewardStartDate: gameEndDate,
    rewardEndDate,
  };
}

function getCurrentFierceSeasonTags(now = getServerNowDate()) {
  const season = getCurrentFierceSeasonRow(now);
  if (!season) return { contentsTags: [], openTags: [] };
  return {
    contentsTags: mergeTags(Array.isArray(season.listContentsTagAllow) ? season.listContentsTagAllow : []),
    openTags: mergeTags([season.m_OpenTag]),
  };
}

function buildFierceSeasonIntervalDataList(now = getServerNowDate()) {
  const season = getCurrentFierceSeasonRow(now);
  if (!season) return [];
  const window = getCurrentFierceSeasonWindow(now);
  const intervals = [];
  const gameStrKey = String(season.m_GameDateStrID || "");
  const rewardStrKey = String(season.m_RewardDateStrID || "");
  if (gameStrKey) {
    intervals.push({
      key: 940000,
      strKey: gameStrKey,
      startDate: window.startDate,
      endDate: window.gameEndDate,
      repeatStartDate: 0,
      repeatEndDate: 0,
    });
  }
  if (rewardStrKey) {
    intervals.push({
      key: 940001,
      strKey: rewardStrKey,
      startDate: window.rewardStartDate,
      endDate: window.rewardEndDate,
      repeatStartDate: 0,
      repeatEndDate: 0,
    });
  }
  return intervals;
}

function getFierceSeasonIntervalStrKeys(now = getServerNowDate()) {
  return buildFierceSeasonIntervalDataList(now)
    .map((interval) => String(interval && interval.strKey || ""))
    .filter(Boolean);
}

function positiveModulo(value, divisor) {
  const normalizedDivisor = Math.max(1, Number(divisor || 0) || 1);
  return ((Math.trunc(Number(value || 0)) % normalizedDivisor) + normalizedDivisor) % normalizedDivisor;
}

function coerceValidDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function getFierceSeasonBossRows(seasonRow = null) {
  const catalog = loadMiscStageCatalog();
  const season = seasonRow || getCurrentFierceSeasonRow() || catalog.fierceSeasonRows[0] || null;
  if (!season) return Array.from(catalog.fierceBossById.values()).slice(0, 3);
  const seen = new Set();
  const rows = [];
  for (const key of Object.keys(season).filter((name) => /^FierceBossGroupID_\d+$/.test(name)).sort(sortNumberedFieldNames)) {
    const groupRows = catalog.fierceBossesByGroup.get(positiveInt(season[key])) || [];
    for (const row of groupRows) {
      const bossId = positiveInt(row && row.FierceBossID);
      if (!row || !bossId || seen.has(bossId)) continue;
      seen.add(bossId);
      rows.push(row);
    }
  }
  return rows.length ? rows : Array.from(catalog.fierceBossById.values()).slice(0, 3);
}

function getFierceSeasonBossGroupIds(seasonRow = null) {
  const catalog = loadMiscStageCatalog();
  const season = seasonRow || getCurrentFierceSeasonRow() || catalog.fierceSeasonRows[0] || null;
  if (!season) return [];
  return Object.keys(season)
    .filter((name) => /^FierceBossGroupID_\d+$/.test(name))
    .sort(sortNumberedFieldNames)
    .map((key) => positiveInt(season[key]))
    .filter(Boolean);
}

function sortNumberedFieldNames(left, right) {
  const leftNumber = Number(String(left || "").match(/\d+$/)?.[0] || 0);
  const rightNumber = Number(String(right || "").match(/\d+$/)?.[0] || 0);
  return leftNumber - rightNumber || String(left).localeCompare(String(right));
}

function normalizePositiveIntList(value) {
  if (Array.isArray(value)) return value.map(positiveInt).filter(Boolean);
  if (value instanceof Set) return Array.from(value).map(positiveInt).filter(Boolean);
  const numeric = positiveInt(value);
  return numeric ? [numeric] : [];
}

function uniquePositiveIntList(values) {
  const seen = new Set();
  const output = [];
  for (const value of normalizePositiveIntList(values)) {
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function battleConditionLevelEntries(values) {
  return uniquePositiveIntList(values).map((battleConditionId) => [battleConditionId, 1]);
}

function getBattleConditionIdByStrId(strId) {
  const key = String(strId || "");
  if (!key) return 0;
  const row = loadMiscStageCatalog().battleConditionByStrId.get(key);
  return positiveInt(row && row.m_BCondID);
}

function getFiercePenaltyRowsForBoss(bossId) {
  const catalog = loadMiscStageCatalog();
  const boss = catalog.fierceBossById.get(positiveInt(bossId));
  const groupIds = uniquePositiveIntList(boss && boss.BossPenaltyGroupID);
  const rows = [];
  const seen = new Set();
  for (const groupId of groupIds) {
    for (const row of catalog.fiercePenaltiesByBossPenaltyGroup.get(groupId) || []) {
      const penaltyId = positiveInt(row && row.PenaltyID);
      if (!penaltyId || seen.has(penaltyId)) continue;
      seen.add(penaltyId);
      rows.push(row);
    }
  }
  return rows;
}

function normalizeFiercePenaltyIdsForBoss(bossId, penaltyIds = []) {
  const requested = uniquePositiveIntList(penaltyIds);
  if (!requested.length) return [];
  const allowedById = new Map(getFiercePenaltyRowsForBoss(bossId).map((row) => [positiveInt(row && row.PenaltyID), row]));
  const selectedByPenaltyGroup = new Map();
  for (const penaltyId of requested) {
    const row = allowedById.get(penaltyId);
    if (!row) continue;
    const groupId = positiveInt(row.PenaltyGroupID) || penaltyId;
    if (!selectedByPenaltyGroup.has(groupId)) selectedByPenaltyGroup.set(groupId, penaltyId);
  }
  return Array.from(selectedByPenaltyGroup.values());
}

function getFierceBattleConditionIdsForBoss(bossId, penaltyIds = []) {
  const catalog = loadMiscStageCatalog();
  const boss = catalog.fierceBossById.get(positiveInt(bossId));
  if (!boss) return [];
  const ids = [
    getBattleConditionIdByStrId(boss.BCondStrID_1),
    getBattleConditionIdByStrId(boss.BCondStrID_2),
  ];
  const selectedPenaltyIds = normalizeFiercePenaltyIdsForBoss(bossId, penaltyIds);
  for (const penaltyId of selectedPenaltyIds) {
    const row = catalog.fiercePenaltyById.get(penaltyId);
    ids.push(getBattleConditionIdByStrId(row && row.BCondStrID));
  }
  return uniquePositiveIntList(ids);
}

function getFiercePenaltyRate(penaltyIds = []) {
  const catalog = loadMiscStageCatalog();
  return uniquePositiveIntList(penaltyIds).reduce((total, penaltyId) => {
    const row = catalog.fiercePenaltyById.get(penaltyId);
    return total + Math.trunc(Number(row && row.FierceScoreRate) || 0);
  }, 0);
}

function resolveMiscStageRequest(req = {}) {
  const catalog = loadMiscStageCatalog();
  const palaceId = positiveInt(req.palaceID || req.palaceId);
  if (palaceId) {
    const palace = catalog.shadowPalaceById.get(palaceId);
    const battles = palace
      ? catalog.shadowBattlesByGroup.get(positiveInt(palace.BATTLE_GROUP_ID)) || []
      : [];
    const requestedDungeonId = positiveInt(req.dungeonID || req.dungeonId);
    const battle = requestedDungeonId
      ? battles.find((row) => positiveInt(row && row.DUNGEON_ID) === requestedDungeonId)
      : battles[0];
    const dungeonID = positiveInt(battle && battle.DUNGEON_ID);
    return {
      mode: "shadow",
      gameType: NGT_SHADOW_PALACE,
      palaceID: palaceId,
      dungeonID,
      stageID: dungeonID,
      shadowBattleOrder: positiveInt(battle && battle.BATTLE_ORDER) || 1,
      stageReqItemId: positiveInt(palace && palace.STAGE_REQ_ITEM_ID),
      stageReqItemCount: Math.max(0, Number(palace && palace.STAGE_REQ_ITEM_COUNT) || 0),
    };
  }

  const fierceBossId = positiveInt(req.fierceBossId || req.fierceBossID || req.bossId);
  if (fierceBossId) {
    const boss = catalog.fierceBossById.get(fierceBossId);
    const dungeonID = positiveInt(boss && boss.DungeonID);
    return {
      mode: "fierce",
      gameType: NGT_FIERCE,
      fierceBossId,
      fierceBossGroupId: positiveInt(boss && boss.FierceBossGroupID),
      fierceLevel: Math.max(1, positiveInt(boss && boss.Level) || 1),
      operationPower: positiveInt(boss && boss.OperationPower),
      battleConditionIds: getFierceBattleConditionIdsForBoss(fierceBossId, []),
      dungeonID,
      stageID: dungeonID,
    };
  }

  const trimId = positiveInt(req.trimId || req.TrimID);
  if (trimId) {
    const trimLevel = Math.max(1, positiveInt(req.trimLevel || req.TrimLevel) || 1);
    const trim = catalog.trimById.get(trimId);
    const trimDungeon = chooseTrimDungeon(trimId, trimLevel);
    const dungeonID = positiveInt(trimDungeon && trimDungeon.DungeonID);
    return {
      mode: "trim",
      gameType: NGT_TRIM,
      trimId,
      trimLevel,
      dungeonID,
      stageID: dungeonID,
      stageReqItemId: positiveInt(trim && trim.m_StageReqItemID),
      stageReqItemCount: Math.max(0, Number(trim && trim.m_StageReqItemCount) || 0),
      trimStageList: catalog.trimDungeonsByTrimId.get(trimId) || [],
    };
  }

  const defenceTempletId = positiveInt(req.defenceTempletId || req.defenceId || req.defenceID);
  if (defenceTempletId) {
    const defence = catalog.defenceById.get(defenceTempletId);
    const dungeonID = positiveInt(defence && defence.m_DungeonID);
    return {
      mode: "defence",
      gameType: NGT_PVE_DEFENCE,
      defenceTempletId,
      dungeonID,
      stageID: dungeonID,
    };
  }

  const exploreStageId = positiveInt(req.exploreStageId || req.exploreStageID || req.exploreStage);
  if (exploreStageId) {
    const exploreStage = catalog.exploreStageByStageId.get(exploreStageId);
    const dungeonID = String(exploreStage && exploreStage.StageType || "").toUpperCase() === "DUNGEON" ? positiveInt(exploreStage && exploreStage.EventValue) : 0;
    return {
      mode: "explore",
      gameType: NGT_EXPLORE,
      exploreID: positiveInt(req.exploreID || req.exploreId),
      exploreStageId,
      dungeonID,
      stageID: dungeonID || exploreStageId,
    };
  }

  const phaseId = positiveInt(req.phaseId || req.phaseID);
  if (phaseId) {
    const phase = catalog.phaseById.get(phaseId);
    const order = choosePhaseOrder(phase, positiveInt(req.phaseIndex || req.phaseOrder) - 1);
    const dungeon = order && order.m_DungeonStrID ? getDungeonTableEntryByStrId(order.m_DungeonStrID) : null;
    const dungeonID = positiveInt(dungeon && dungeon.m_DungeonID);
    return {
      mode: "phase",
      gameType: NGT_PHASE,
      phaseId,
      dungeonID,
      stageID: positiveInt(req.stageID) || findStageIdForDungeonId(dungeonID) || dungeonID,
      phaseIndex: Math.max(0, positiveInt(order && order.m_PhaseOrder) - 1),
      eventDeckId: positiveInt(phase && phase.m_UseEventDeck),
    };
  }

  return null;
}

function classifyMiscDungeon(dungeonID, stageRow = null, dungeon = null) {
  const resolvedDungeonId = positiveInt(dungeonID);
  const catalog = loadMiscStageCatalog();
  if (resolvedDungeonId && catalog.shadowBattleByDungeonId.has(resolvedDungeonId)) {
    const battle = catalog.shadowBattleByDungeonId.get(resolvedDungeonId);
    const palace = catalog.shadowPalaceByGroup.get(positiveInt(battle && battle.BATTLE_GROUP));
    return {
      mode: "shadow",
      gameType: NGT_SHADOW_PALACE,
      palaceID: positiveInt(palace && palace.PALACE_ID),
      shadowBattleOrder: positiveInt(battle && battle.BATTLE_ORDER) || 1,
      stageReqItemId: positiveInt(palace && palace.STAGE_REQ_ITEM_ID),
      stageReqItemCount: Math.max(0, Number(palace && palace.STAGE_REQ_ITEM_COUNT) || 0),
    };
  }
  if (resolvedDungeonId && catalog.fierceBossByDungeonId.has(resolvedDungeonId)) {
    const boss = catalog.fierceBossByDungeonId.get(resolvedDungeonId);
    const bossId = positiveInt(boss && boss.FierceBossID);
    return {
      mode: "fierce",
      gameType: NGT_FIERCE,
      fierceBossId: bossId,
      fierceBossGroupId: positiveInt(boss && boss.FierceBossGroupID),
      fierceLevel: Math.max(1, positiveInt(boss && boss.Level) || 1),
      operationPower: positiveInt(boss && boss.OperationPower),
      battleConditionIds: getFierceBattleConditionIdsForBoss(bossId, []),
    };
  }
  if (resolvedDungeonId && catalog.trimDungeonByDungeonId.has(resolvedDungeonId)) {
    const trimDungeon = catalog.trimDungeonByDungeonId.get(resolvedDungeonId);
    const trimId = positiveInt(trimDungeon && trimDungeon.TrimID);
    const trim = catalog.trimById.get(trimId);
    return {
      mode: "trim",
      gameType: NGT_TRIM,
      trimId,
      trimLevel: Math.max(1, positiveInt(trimDungeon && trimDungeon.TrimLevel_Low) || 1),
      trimStageList: catalog.trimDungeonsByTrimId.get(trimId) || [],
      stageReqItemId: positiveInt(trim && trim.m_StageReqItemID),
      stageReqItemCount: Math.max(0, Number(trim && trim.m_StageReqItemCount) || 0),
    };
  }
  if (resolvedDungeonId && catalog.defenceByDungeonId.has(resolvedDungeonId)) {
    const defence = catalog.defenceByDungeonId.get(resolvedDungeonId);
    return { mode: "defence", gameType: NGT_PVE_DEFENCE, defenceTempletId: positiveInt(defence && defence.m_Id) };
  }
  if (resolvedDungeonId && catalog.exploreStageByDungeonId.has(resolvedDungeonId)) {
    const exploreStage = catalog.exploreStageByDungeonId.get(resolvedDungeonId);
    return { mode: "explore", gameType: NGT_EXPLORE, exploreStageId: positiveInt(exploreStage && exploreStage.StageID) };
  }
  if (resolvedDungeonId && catalog.phaseOrderByDungeonId.has(resolvedDungeonId)) {
    const order = catalog.phaseOrderByDungeonId.get(resolvedDungeonId);
    const phase = Array.from(catalog.phaseById.values()).find((row) => positiveInt(row && row.m_PhaseGroupID) === positiveInt(order && order.m_PhaseGroupID));
    return {
      mode: "phase",
      gameType: NGT_PHASE,
      phaseId: positiveInt(phase && phase.m_PhaseID),
      phaseIndex: Math.max(0, positiveInt(order && order.m_PhaseOrder) - 1),
      eventDeckId: positiveInt(phase && phase.m_UseEventDeck),
    };
  }

  const stageType = String(stageRow && stageRow.m_StageType || "");
  const stageBattleStrId = String(stageRow && stageRow.m_StageBattleStrID || "");
  if (stageType === "ST_PHASE" || (stageBattleStrId && catalog.phaseByStrId.has(stageBattleStrId))) {
    const phase = catalog.phaseByStrId.get(stageBattleStrId);
    return {
      mode: "phase",
      gameType: NGT_PHASE,
      phaseId: positiveInt(phase && phase.m_PhaseID),
      eventDeckId: positiveInt(phase && phase.m_UseEventDeck),
    };
  }

  const dungeonType = String(dungeon && dungeon.m_DungeonType || "");
  if (dungeonType === "NDT_TRIM") return { mode: "trim", gameType: NGT_TRIM };
  if (dungeonType === "NDT_FIERCE") return { mode: "fierce", gameType: NGT_FIERCE };
  return null;
}

function chooseStageRow(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return null;
  const normalRows = list.filter((row) => String(row.m_Difficulty || row.Difficulty || "NORMAL") === "NORMAL");
  const candidates = normalRows.length ? normalRows : list;
  return candidates
    .slice()
    .sort(
      (left, right) =>
        Number(left.m_ActID || left.ActID || 0) - Number(right.m_ActID || right.ActID || 0) ||
        Number(left.m_StageIndex || left.StageIndex || 0) - Number(right.m_StageIndex || right.StageIndex || 0) ||
        Number(left.m_StageID || left.StageID || 0) - Number(right.m_StageID || right.StageID || 0)
    )[0];
}

function getGenericStageForRequest(req = {}) {
  const requestedStageId = positiveInt(req && req.stageID);
  let requestedDungeonId = positiveInt(req && req.dungeonID);
  const requestedMiscStage = resolveMiscStageRequest(req);
  if (!requestedDungeonId && requestedMiscStage && requestedMiscStage.dungeonID) {
    requestedDungeonId = positiveInt(requestedMiscStage.dungeonID);
  }
  let stageRow = requestedStageId > 0 ? getStageTableEntry(requestedStageId) : null;
  let dungeon = null;

  if (stageRow && stageRow.m_StageBattleStrID) {
    dungeon = getDungeonTableEntryByStrId(stageRow.m_StageBattleStrID);
  }
  if (!dungeon && stageRow && String(stageRow.m_StageType || "") === "ST_PHASE") {
    const phase = loadMiscStageCatalog().phaseByStrId.get(String(stageRow.m_StageBattleStrID || ""));
    const requestedOrder = loadMiscStageCatalog().phaseOrderByDungeonId.get(requestedDungeonId);
    const order = requestedOrder &&
      positiveInt(requestedOrder.m_PhaseGroupID) === positiveInt(phase && phase.m_PhaseGroupID)
      ? requestedOrder
      : choosePhaseOrder(phase, 0);
    if (order && order.m_DungeonStrID) dungeon = getDungeonTableEntryByStrId(order.m_DungeonStrID);
  }
  if (!dungeon && requestedDungeonId > 0) {
    dungeon = getDungeonTableEntry(requestedDungeonId);
  }
  if (!dungeon && !stageRow && requestedStageId > 0) {
    const dungeonByStageId = getDungeonTableEntry(requestedStageId);
    if (dungeonByStageId) {
      dungeon = dungeonByStageId;
      requestedDungeonId = requestedStageId;
    }
  }
  if (!stageRow && dungeon) {
    stageRow = findStageRowForDungeonId(Number(dungeon.m_DungeonID || requestedDungeonId || 0));
  }
  if (!dungeon) return null;

  const dungeonID = Number(dungeon.m_DungeonID || requestedDungeonId || 0);
  const miscStage = requestedMiscStage || classifyMiscDungeon(dungeonID, stageRow, dungeon) || {};
  const stageId = Number(
    (stageRow && (stageRow.m_StageID || stageRow.StageID)) ||
      requestedStageId ||
      miscStage.stageID ||
      findStageIdForDungeonId(dungeonID) ||
      dungeonID ||
      0
  );
  if (!stageId || !dungeonID) return null;

  const dungeonType = String(dungeon.m_DungeonType || "");
  const cutsceneOnly = dungeonType === "NDT_CUTSCENE";
  const mapStrID = String(dungeon.m_DungeonMapStrID || "");
  const stageType = String((stageRow && stageRow.m_StageType) || "");
  const gameType = cutsceneOnly
    ? NGT_CUTSCENE
    : positiveInt(miscStage.gameType) || (stageType === "ST_PHASE" ? NGT_PHASE : NGT_DUNGEON);
  return {
    stageId,
    stageStrID: String((stageRow && stageRow.m_StageStrID) || miscStage.stageStrID || ""),
    dungeonID,
    dungeonStrID: String(dungeon.m_DungeonStrID || (stageRow && stageRow.m_StageBattleStrID) || ""),
    mapID: cutsceneOnly ? 0 : mapIdForMapStrId(mapStrID),
    mapStrID,
    episodeId: Number((stageRow && stageRow.m_EpisodeID) || 0),
    actId: Number((stageRow && stageRow.m_ActID) || 0),
    stageIndex: Number((stageRow && stageRow.m_StageIndex) || 0),
    stageUINum: Number((stageRow && (stageRow.m_StageUINum || stageRow.m_StageIndex)) || 0),
    stageType,
    stageSubType: String((stageRow && stageRow.m_StageSubType) || ""),
    dungeonType,
    gameType,
    miscMode: String(miscStage.mode || ""),
    eventDeckId: cutsceneOnly ? 0 : resolveGenericEventDeckId(stageRow, dungeon, miscStage),
    palaceID: positiveInt(miscStage.palaceID),
    fierceBossId: positiveInt(miscStage.fierceBossId),
    fierceBossGroupId: positiveInt(miscStage.fierceBossGroupId),
    fierceLevel: Math.max(0, positiveInt(miscStage.fierceLevel)),
    operationPower: positiveInt(miscStage.operationPower),
    battleConditionIds: uniquePositiveIntList(miscStage.battleConditionIds),
    trimId: positiveInt(miscStage.trimId),
    trimLevel: positiveInt(miscStage.trimLevel),
    defenceTempletId: positiveInt(miscStage.defenceTempletId),
    exploreID: positiveInt(miscStage.exploreID),
    exploreStageId: positiveInt(miscStage.exploreStageId),
    phaseId: positiveInt(miscStage.phaseId),
    phaseIndex: Math.max(0, Number(miscStage.phaseIndex || 0) || 0),
    shadowBattleOrder: positiveInt(miscStage.shadowBattleOrder),
    trimStageList: Array.isArray(miscStage.trimStageList) ? miscStage.trimStageList : [],
    stageReqItemId: positiveInt(miscStage.stageReqItemId),
    stageReqItemCount: Math.max(0, Number(miscStage.stageReqItemCount || 0) || 0),
    tutorial: false,
    cutsceneOnly,
    initialUnits: [],
    autoDeployUnits: [],
  };
}

function resolveGenericEventDeckId(stageRow, dungeon, miscStage = null) {
  const miscEventDeckId = positiveInt(miscStage && miscStage.eventDeckId);
  if (miscEventDeckId) return miscEventDeckId;
  const explicit = Number(dungeon && dungeon.m_UseEventDeck);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const dungeonId = Number(dungeon && dungeon.m_DungeonID);
  if (dungeonId > 0 && getEventDeckTemplet(dungeonId)) return dungeonId;
  return 0;
}

function mapIdForMapStrId(mapStrId) {
  const strId = String(mapStrId || "");
  if (!strId) return 0;
  const map = loadMapIdByStrId();
  return Number(map.get(strId) || 0) || 0;
}

function loadMapIdByStrId() {
  if (cachedMapIdByStrId) return cachedMapIdByStrId;
  cachedMapIdByStrId = new Map();
  try {
    const records = MAP_TABLE_PATH
      ? readGameplayRecordsFromJsonPath(MAP_TABLE_PATH, "map-table")
      : readGameplayTableRecords("ab_script", "LUA_MAP_TEMPLET.json", { rootDir: ROOT_DIR, logLabel: "map-table" });
    for (const record of records) {
      const mapStrId = String(record && record.m_MapStrID ? record.m_MapStrID : "");
      const mapId = Number(record && record.m_MapID);
      if (mapStrId && Number.isInteger(mapId) && mapId > 0) cachedMapIdByStrId.set(mapStrId, mapId);
    }
  } catch (err) {
    console.log(`[map-table] failed to load map table: ${summarizeErrorLine(err)}`);
  }
  return cachedMapIdByStrId;
}

function getDungeonRewardGroupIds(dungeonEntry) {
  if (!dungeonEntry || typeof dungeonEntry !== "object") return [];
  return Object.keys(dungeonEntry)
    .filter((key) => /^m_RewardGroupID_\d+$/.test(key))
    .sort((left, right) => Number(left.match(/\d+$/)[0]) - Number(right.match(/\d+$/)[0]))
    .map((key) => Number(dungeonEntry[key] || 0))
    .filter((groupId) => Number.isInteger(groupId) && groupId > 0);
}

function getDungeonUnitExpReward(dungeonId) {
  const entry = getDungeonTableEntry(dungeonId);
  return Math.max(0, Number(entry && entry.m_RewardUnitEXP) || 0);
}

function getDungeonUserExpReward(dungeonId) {
  const entry = getDungeonTableEntry(dungeonId);
  return Math.max(0, Number(entry && entry.m_RewardUserEXP) || 0);
}

function getOrGrantStageClearLoot(replay, user, dungeonId, stageId, options = {}) {
  const userUid = user && user.userUid ? String(toBigInt(user.userUid || 0)) : "";
  const multiplier = Math.max(
    1,
    Math.trunc(Number(options.multiplier || replay && replay.dynamicGame && replay.dynamicGame.rewardMultiply || 1)) || 1
  );
  if (
    replay &&
    replay.stageClearLoot &&
    Number(replay.stageClearLoot.dungeonId) === Number(dungeonId) &&
    Number(replay.stageClearLoot.rewardMultiply || 1) === multiplier &&
    (!userUid || replay.stageClearLoot.userUid === userUid)
  ) {
    return replay.stageClearLoot;
  }

  const result = grantStageClearLoot(user, dungeonId, stageId, { ...options, replay, multiplier });
  if (replay && typeof replay === "object") replay.stageClearLoot = result;
  return result;
}

function maybeGrantBattleStageClearLoot(replay, user, dungeonId, stageId, battleState = null) {
  if (!user || !replay || !replay.dynamicGame || replay.dynamicGame.tutorial) return null;
  if (Number(replay.dynamicGame.dungeonID || 0) !== Number(dungeonId || 0)) return null;
  const state = battleState || replay.battleState || {};
  if (!isBattleWin(state)) return null;
  return getOrGrantStageClearLoot(replay, user, dungeonId, stageId, { save: false });
}

function grantStageClearLoot(user, dungeonId, stageId, options = {}) {
  const entry = getDungeonTableEntry(dungeonId);
  const reward = createEmptyReward();
  const rewardMultiply = Math.max(1, Math.trunc(Number(options.multiplier || 1)) || 1);
  const unitExp = getDungeonUnitExpReward(dungeonId) * rewardMultiply;
  const userExp = getDungeonUserExpReward(dungeonId) * rewardMultiply;
  const firstClear = !(
    user &&
    user.dungeonClear &&
    typeof user.dungeonClear === "object" &&
    user.dungeonClear[String(Number(dungeonId || 0))]
  );
  const result = {
    userUid: user && user.userUid ? String(toBigInt(user.userUid || 0)) : "",
    dungeonId: Number(dungeonId || 0),
    stageId: Number(stageId || 0),
    reward,
    unitExp,
    userExp,
    rewardGroupIds: [],
    rewardMultiply,
    changed: false,
  };
  if (!entry || !user || typeof user !== "object") return result;

  const ctx = { dateTimeBinaryNow };
  const regDate = dateTimeBinaryNow();
  const rewardGroupIds = getDungeonRewardGroupIds(entry);
  result.rewardGroupIds = rewardGroupIds;
  let creditAmount = 0;
  const mainRewardSummaries = [];
  for (let rewardIndex = 0; rewardIndex < rewardMultiply; rewardIndex += 1) {
    const rolledCredit = pickDungeonRewardQuantity(user, `credit:${dungeonId}`, entry.m_RewardCredit_Min, entry.m_RewardCredit_Max);
    creditAmount += rolledCredit;
    if (rolledCredit > 0) {
      mergeReward(
        reward,
        grantRewardByType(ctx, user, "RT_MISC", RESOURCE_ITEM_IDS.CREDIT, rolledCredit, rolledCredit, 0, {
          regDate,
          expandPackages: false,
        })
      );
    }
    if (firstClear && rewardIndex === 0) {
      mergeReward(reward, grantStageFirstClearReward(ctx, user, stageId, { regDate }));
    }
    const mainReward = grantStageMainReward(ctx, user, stageId, { regDate });
    mergeReward(reward, mainReward.reward);
    if (mainReward.summary) mainRewardSummaries.push(mainReward.summary);
    for (const groupId of rewardGroupIds) {
      const records = getRewardGroupRecords(groupId);
      if (!stageRewardGroupChancePass(user, groupId, records)) continue;
      const record = pickStageRewardRecord(records, user, groupId);
      if (!record) continue;
      mergeReward(reward, grantRewardRecord(ctx, user, record, { regDate }));
    }
  }

  reward.userExp = userExp;
  const combatExpResult = applyCombatExpToLocalRoster(user, options.replay, unitExp);
  const unitExpDataList = combatExpResult.unitExpDataList;
  if (unitExpDataList.length) reward.unitExpDataList = unitExpDataList;
  result.operatorExpApplied = combatExpResult.operatorExpApplied;
  result.changed = hasRewardPayload(reward) || combatExpResult.operatorExpApplied;
  if (result.changed && USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  console.log(
    `[stage-loot] dungeonID=${dungeonId} stageID=${stageId} multiply=${rewardMultiply} credits=${creditAmount} main=${
      mainRewardSummaries.join("+") || "-"
    } groups=${rewardGroupIds.join(",") || "-"} misc=${
      reward.miscItems.length
    } units=${reward.units.length} operators=${reward.operators.length} equips=${reward.equips.length} unitExpTargets=${unitExpDataList.length}`
  );
  return result;
}

function grantStageFirstClearReward(ctx, user, stageId, options = {}) {
  const stage = getStageTableEntry(stageId);
  const rewardType = String(stage && (stage.m_FirstReward_Type || stage.FirstRewardType || ""));
  const rewardId = Number(stage && (stage.m_FirstReward_ID || stage.FirstRewardID || 0));
  const rewardQuantity = Math.max(0, Number(stage && (stage.m_FirstRewardQuantity || stage.FirstRewardQuantity || 0)) || 0);
  if (!rewardType || rewardType === "RT_NONE" || rewardId <= 0 || rewardQuantity <= 0) return createEmptyReward();
  return grantRewardByType(ctx, user, rewardType, rewardId, rewardQuantity, rewardQuantity, 0, {
    regDate: options.regDate,
    expandPackages: false,
  });
}

function grantStageMainReward(ctx, user, stageId, options = {}) {
  const stage = getStageTableEntry(stageId);
  const rewardType = String(stage && (stage.m_MainRewardType || stage.MainRewardType || ""));
  const rewardId = Number(stage && (stage.m_MainRewardID || stage.MainRewardID || 0));
  const minQuantity = Math.max(0, Number(stage && (stage.m_MainRewardMin || stage.MainRewardMin || 0)) || 0);
  const maxQuantity = Math.max(minQuantity, Number(stage && (stage.m_MainRewardMax || stage.MainRewardMax || minQuantity)) || minQuantity);
  if (!rewardType || rewardType === "RT_NONE" || rewardId <= 0 || maxQuantity <= 0) {
    return { reward: createEmptyReward(), summary: "" };
  }
  if (!stageMainRewardProbabilityPass(user, stageId, stage && (stage.m_MainRewardProbability || stage.MainRewardProbability))) {
    return { reward: createEmptyReward(), summary: "" };
  }
  const quantity = pickDungeonRewardQuantity(user, `stage-main:${stageId}:${rewardType}:${rewardId}`, minQuantity, maxQuantity);
  if (quantity <= 0) return { reward: createEmptyReward(), summary: "" };
  return {
    reward: grantRewardByType(ctx, user, rewardType, rewardId, quantity, quantity, 0, {
      regDate: options.regDate,
      expandPackages: false,
    }),
    summary: `${rewardType}:${rewardId}x${quantity}`,
  };
}

function stageMainRewardProbabilityPass(user, stageId, probability) {
  const chance = Math.max(0, Math.trunc(Number(probability == null ? 10000 : probability) || 0));
  if (chance >= 10000) return true;
  if (chance <= 0) return false;
  return stableStageRewardRoll(user, `stage-main-prob:${stageId}`, 10000) < chance;
}

function hasRewardPayload(reward) {
  if (!reward || typeof reward !== "object") return false;
  if (Number(reward.userExp || 0) > 0) return true;
  return ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "unitExpDataList"].some(
    (key) => Array.isArray(reward[key]) && reward[key].length > 0
  );
}

function applyCombatExpToLocalRoster(user, replay, unitExp) {
  const exp = Math.max(0, Math.trunc(Number(unitExp || 0) || 0));
  if (!user || typeof user !== "object" || exp <= 0) return { unitExpDataList: [], operatorExpApplied: false };

  const unitUids = resolveCombatUnitExpTargets(replay);
  const unitExpDataList = [];
  for (const unitUid of unitUids) {
    const unit = getArmyUnitByUid(user, unitUid);
    if (!unit) continue;
    const updated = addUnitExp(user, unitUid, exp) || unit;
    if (!updated) continue;
    unitExpDataList.push({ unitUid, exp, bonusExp: 0, bonusRatio: 0 });
  }

  const operatorUid = resolveCombatOperatorExpTarget(replay);
  const operatorExpApplied = Boolean(operatorUid && getArmyOperatorByUid(user, operatorUid) && addOperatorExp(user, operatorUid, exp));
  return { unitExpDataList, operatorExpApplied };
}

function resolveCombatUnitExpTargets(replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const deckUnits = dynamicGame.playerDeck && Array.isArray(dynamicGame.playerDeck.units) ? dynamicGame.playerDeck.units : [];
  const fromDeck = deckUnits
    .map((unit) => unit && (unit.unitUid || unit.m_UnitUID || unit.sourceUnitUID))
    .filter(Boolean);
  const battleState = replay && replay.battleState ? replay.battleState : {};
  const fromBattleState = (Array.isArray(battleState.units) ? battleState.units : [])
    .map((unit) => unit && (unit.sourceUnitUID || unit.unitUID || unit.unitUid))
    .filter(Boolean);
  return uniquePositiveLongStrings(fromDeck.length ? fromDeck : fromBattleState);
}

function resolveCombatOperatorExpTarget(replay) {
  const dynamicGame = replay && replay.dynamicGame ? replay.dynamicGame : {};
  const operatorUid =
    dynamicGame.playerDeck &&
    (dynamicGame.playerDeck.operatorUid || dynamicGame.playerDeck.operatorUID || dynamicGame.playerDeck.operatorUIDString);
  const normalized = toBigInt(operatorUid || 0);
  return normalized > 0n ? normalized.toString() : "";
}

function uniquePositiveLongStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(toBigInt(value || 0)))
        .filter((value) => toBigInt(value) > 0n)
    )
  );
}

function pickStageRewardRecord(records, user, groupId) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return null;
  const totalWeight = list.reduce((sum, record) => sum + Math.max(0, Number(record.m_Ratio || 1)), 0);
  if (totalWeight <= 0) return list[0];

  let target = nextStageRewardCursor(user, `group:${groupId}`) % totalWeight;
  for (const record of list) {
    target -= Math.max(0, Number(record.m_Ratio || 1));
    if (target < 0) return record;
  }
  return list[0];
}

function stageRewardGroupChancePass(user, groupId, records) {
  const chance = getStageRewardGroupChance(groupId, records);
  if (chance >= STAGE_REWARD_CHANCE_DENOMINATOR) return true;
  if (chance <= 0) return false;
  return stableStageRewardRoll(user, `group:${groupId}`, STAGE_REWARD_CHANCE_DENOMINATOR) < chance;
}

function getStageRewardGroupChance(groupId, records) {
  const configured = getConfiguredStageRewardGroupChance(groupId);
  if (configured != null) return configured;
  if (isFullActorRewardGroup(records)) return STAGE_FULL_ACTOR_REWARD_GROUP_CHANCE;
  return STAGE_REWARD_CHANCE_DENOMINATOR;
}

function getConfiguredStageRewardGroupChance(groupId) {
  const normalizedGroupId = Math.max(0, Math.trunc(Number(groupId || 0) || 0));
  if (normalizedGroupId <= 0) return null;
  const keys = [
    `CS_STAGE_REWARD_GROUP_${normalizedGroupId}_CHANCE`,
    `CS_STAGE_REWARD_GROUP_CHANCE_${normalizedGroupId}`,
  ];
  for (const key of keys) {
    const parsed = parseOptionalChanceEnv(process.env[key]);
    if (parsed != null) return parsed;
  }
  return null;
}

function isFullActorRewardGroup(records) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  return list.length > 0 && list.every((record) => isFullActorRewardType(record.m_RewardType));
}

function isFullActorRewardType(type) {
  const normalized = String(type || "").trim().toUpperCase();
  return normalized === "RT_UNIT" || normalized === "RT_SHIP" || normalized === "RT_OPERATOR";
}

function stableStageRewardRoll(user, key, modulo = STAGE_REWARD_CHANCE_DENOMINATOR) {
  const denominator = Math.max(1, Math.trunc(Number(modulo || 1) || 1));
  const cursor = nextStageRewardCursor(user, `roll:${key}`);
  const userUid = user && user.userUid ? String(toBigInt(user.userUid || 0)) : "local";
  const hashHex = crypto.createHash("sha1").update(`${userUid}:${key}:${cursor}`).digest("hex").slice(0, 8);
  return Number.parseInt(hashHex, 16) % denominator;
}

function pickDungeonRewardQuantity(user, key, minValue, maxValue) {
  const min = Math.max(0, Math.floor(Number(minValue || 0)));
  const max = Math.max(min, Math.floor(Number(maxValue || min)));
  if (max <= min) return min;
  const cursor = nextStageRewardCursor(user, key);
  return min + (cursor % (max - min + 1));
}

function nextStageRewardCursor(user, key) {
  if (!user || typeof user !== "object") return 0;
  user.localStageRewardCursors =
    user.localStageRewardCursors && typeof user.localStageRewardCursors === "object" ? user.localStageRewardCursors : {};
  const cursor = Math.max(0, Number(user.localStageRewardCursors[key] || 0) || 0);
  user.localStageRewardCursors[key] = cursor + 1;
  return cursor;
}

function getBattlePlayTime(battleState = {}) {
  return Math.max(
    0,
    Number(
      battleState.gameTime ??
        battleState.GameTime ??
        battleState.totalPlayTime ??
        battleState.TotalPlayTime ??
        battleState.clearTimeSec ??
        battleState.ClearTimeSec ??
        0
    ) || 0
  );
}

function resolveBattleWin(battleState = {}, options = {}) {
  if (typeof options.win === "boolean") return options.win;
  if (options.preferFallbackWin && typeof options.fallbackWin === "boolean") return options.fallbackWin;

  const inferredWin = inferBattleWinFromUnits(battleState);
  if (typeof inferredWin === "boolean") return inferredWin;

  const stateWin = resolveBattleWinTeam(battleState);
  if (typeof stateWin === "boolean") return stateWin;

  if (battleState && typeof battleState === "object") {
    if (battleState.win != null) return Boolean(battleState.win);
    if (battleState.Win != null) return Boolean(battleState.Win);
  }

  if (typeof options.fallbackWin === "boolean") return options.fallbackWin;
  return false;
}

function resolveBattleWinTeam(battleState = {}) {
  const candidates = [
    battleState && battleState.gameState && battleState.gameState.winTeam,
    battleState && battleState.GameState && battleState.GameState.WinTeam,
    battleState && battleState.gameState && battleState.gameState.WinTeam,
    battleState && battleState.GameState && battleState.GameState.winTeam,
    battleState && battleState.winTeam,
    battleState && battleState.WinTeam,
  ];
  const pendingStates = []
    .concat(Array.isArray(battleState.pendingGameStates) ? battleState.pendingGameStates : [])
    .concat(Array.isArray(battleState.PendingGameStates) ? battleState.PendingGameStates : []);
  for (let index = pendingStates.length - 1; index >= 0; index -= 1) {
    const pending = pendingStates[index] || {};
    candidates.push(pending.winTeam, pending.WinTeam);
  }

  for (const value of candidates) {
    const winTeam = Number(value || 0);
    if (!winTeam) continue;
    if (winTeam === 1 || winTeam === 2) return true;
    if (winTeam === 3) return false;
  }
  return null;
}

function inferBattleWinFromUnits(battleState = {}) {
  const units = Array.isArray(battleState.units)
    ? battleState.units
    : Array.isArray(battleState.Units)
      ? battleState.Units
      : [];
  if (!units.length) return null;
  const liveUnits = units.filter((unit) => {
    const hp = Number(unit && (unit.hp ?? unit.Hp ?? 0));
    const playState = Number(unit && (unit.playState ?? unit.PlayState ?? 1));
    return hp > 0 && playState !== 0 && playState !== 2;
  });
  const liveEnemies = liveUnits.filter((unit) => Number(unit.team ?? unit.Team ?? 0) !== 1);
  const livePlayers = liveUnits.filter((unit) => Number(unit.team ?? unit.Team ?? 0) === 1);
  if (liveEnemies.length === 0) return true;
  if (livePlayers.length === 0 && liveEnemies.length > 0) return false;
  return null;
}

function normalizeBattleResultState(battleState, win) {
  if (!battleState || typeof battleState !== "object") return;
  const resolvedWin = Boolean(win);
  const waveId = Number(
    (battleState.gameState && (battleState.gameState.waveId ?? battleState.gameState.WaveId)) ??
      (battleState.GameState && (battleState.GameState.WaveId ?? battleState.GameState.waveId)) ??
      1
  ) || 1;
  const winTeam = resolvedWin ? 1 : 3;
  battleState.finished = true;
  battleState.Finished = true;
  battleState.win = resolvedWin;
  battleState.Win = resolvedWin;
  battleState.gameState = { ...(battleState.gameState || {}), state: 4, winTeam, waveId };
  battleState.GameState = { ...(battleState.GameState || {}), State: 4, WinTeam: winTeam, WaveId: waveId };
  normalizePendingBattleGameStates(battleState.pendingGameStates, { state: 4, winTeam, waveId });
  normalizePendingBattleGameStates(battleState.PendingGameStates, { State: 4, WinTeam: winTeam, WaveId: waveId });
}

function normalizePendingBattleGameStates(states, finalState) {
  if (!Array.isArray(states)) return;
  const last = states.length > 0 ? states[states.length - 1] : null;
  if (last && typeof last === "object") {
    Object.assign(last, finalState);
    return;
  }
  states.push({ ...finalState });
}

function isBattleWin(battleState = {}) {
  return resolveBattleWin(battleState);
}

function resolveDungeonMissionResults(dungeonId, options = {}) {
  const stageId = Number(options.stageId || options.stageID || 0);
  if (isCutsceneOnlyDungeon(dungeonId, stageId)) {
    return { missionResult1: false, missionResult2: false };
  }
  if (options.forceMissionSuccess) return { missionResult1: true, missionResult2: true };

  const hasMissionResult1 = typeof options.missionResult1 === "boolean";
  const hasMissionResult2 = typeof options.missionResult2 === "boolean";
  if (hasMissionResult1 && hasMissionResult2) {
    return {
      missionResult1: options.missionResult1,
      missionResult2: options.missionResult2,
    };
  }

  if (hasMissionResult1 || hasMissionResult2) {
    const fallback = resolveDungeonMissionResults(dungeonId, {
      ...options,
      missionResult1: undefined,
      missionResult2: undefined,
    });
    return {
      missionResult1: hasMissionResult1 ? options.missionResult1 : fallback.missionResult1,
      missionResult2: hasMissionResult2 ? options.missionResult2 : fallback.missionResult2,
    };
  }

  if (typeof options.win !== "boolean") {
    // Preserve legacy callers that only need a completed clear entry.
    return { missionResult1: true, missionResult2: true };
  }
  const win = Boolean(options.win);
  if (!win) return { missionResult1: false, missionResult2: false };
  const entry = getDungeonTableEntry(dungeonId);
  const battleState = options.battleState || {};
  return {
    missionResult1: evaluateDungeonMission(entry && entry.m_DGMissionType_1, entry && entry.m_DGMissionValue_1, battleState, win),
    missionResult2: evaluateDungeonMission(entry && entry.m_DGMissionType_2, entry && entry.m_DGMissionValue_2, battleState, win),
  };
}

function isCutsceneOnlyDungeon(dungeonId, stageId = 0) {
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || 0);
  if (resolvedDungeonId > 0 && isMainStoryCutsceneDungeonId(resolvedDungeonId)) return true;
  const mainStoryStage = resolvedStageId > 0 ? getMainStoryStageByStageId(resolvedStageId) : null;
  if (mainStoryStage && mainStoryStage.cutsceneOnly) return true;
  const genericStage = getGenericStageForRequest({ dungeonID: resolvedDungeonId, stageID: resolvedStageId });
  if (genericStage && genericStage.cutsceneOnly) return true;
  const dungeon = getDungeonTableEntry(resolvedDungeonId);
  return String(dungeon && dungeon.m_DungeonType || "") === "NDT_CUTSCENE";
}

function evaluateDungeonMission(type, value, battleState, win) {
  const missionType = String(type || "").trim();
  if (!missionType || missionType === "DGMT_NONE") return Boolean(win);
  if (!win) return false;
  const missionValue = Number(value || 0);
  switch (missionType) {
    case "DGMT_CLEAR":
      return true;
    case "DGMT_TIME":
      return missionValue <= 0 || getBattlePlayTime(battleState) <= missionValue;
    case "DGMT_COST": {
      const usedCost = Number(
        battleState.usedRespawnCostA1 ??
          battleState.UsedRespawnCostA1 ??
          battleState.usedRespawnCost ??
          battleState.UsedRespawnCost ??
          0
      );
      return missionValue <= 0 || usedCost <= missionValue;
    }
    case "DGMT_RESPAWN": {
      const deployCount = Number(battleState.deployCount ?? battleState.DeployCount ?? battleState.respawnCount ?? 0);
      return missionValue <= 0 || deployCount <= missionValue;
    }
    case "DGMT_SHIP_HP_DAMAGE": {
      const shipHpDamage = Number(battleState.shipHpDamagePercent ?? battleState.ShipHpDamagePercent ?? 0);
      return missionValue <= 0 || shipHpDamage <= missionValue;
    }
    case "DGMT_TEAM_A_KILL_COUNT":
      return missionValue <= 0 || Number(
        battleState.teamAKillCount ?? battleState.TeamAKillCount ?? battleState.killCount ?? battleState.defenceScore ?? 0
      ) >= missionValue;
    default:
      // Deck-count and kill-count objectives need richer combat bookkeeping.
      // Gate them on win for now so the normal result screen works without
      // inventing false negatives for missions we do not yet track.
      return true;
  }
}

function buildDungeonClearData(dungeonId, options = {}) {
  const missionResults = resolveDungeonMissionResults(dungeonId, options);
  const rewardData = options.reward || options.rewardData || null;
  const unitExp = options.unitExp != null ? options.unitExp : 0;
  return Buffer.concat([
    writeSignedVarInt(dungeonId),
    writeBool(missionResults.missionResult1),
    writeBool(missionResults.missionResult2),
    writeNullObject(),
    writeBool(false),
    writeNullObject(),
    writeBoolList([]),
    writeNullableObject(rewardData ? buildSerializedRewardData(rewardData) : buildEmptyRewardData()),
    writeSignedVarInt(Math.max(0, Number(unitExp || 0) || 0)),
  ]);
}

function trackStageClearMissionProgress(user, dungeonId, stageId, battleState = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!resolvedDungeonId && !resolvedStageId) return false;
  const now = dateTimeBinaryNow();
  const details = {
    now,
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    value: resolvedDungeonId || resolvedStageId,
  };
  let changed = false;
  const changedConditions = new Set();
  const track = (condition, amount, extraDetails = details) => {
    const tracked = trackMissionEvent(user, condition, amount, extraDetails);
    if (tracked) changedConditions.add(condition);
    changed = tracked || changed;
  };
  track("DUNGEON_CLEAR", 1);
  track("DUNGEON_CLEARED", 1);
  track("PHASE_CLEAR", 1);
  track("PHASE_CLEARED", 1);
  track("WARFARE_CLEAR", 1);
  track("WARFARE_CLEARED", 1);
  if (isDailySimulationStageClear(resolvedDungeonId, resolvedStageId)) {
    track("DAILY_DUNGEON_PLAY", 1);
  }
  if (isSupplyStageClear(resolvedDungeonId, resolvedStageId)) {
    track("EC_SUPPLY_CLEAR", 1);
    track("EC_SUPPLY_CLEARED", 1);
  }
  const shadowStage = classifyMiscDungeon(resolvedDungeonId);
  if (
    shadowStage &&
    shadowStage.mode === "shadow" &&
    nextShadowDungeonId(shadowStage.palaceID, resolvedDungeonId) === 0
  ) {
    const palaceId = positiveInt(shadowStage.palaceID);
    const palaceDetails = { ...details, value: palaceId, palaceId };
    track("PALACE_CLEAR", 1, palaceDetails);
    track("PALACE_CLEARED", 1, palaceDetails);
  }
  const missionResults = resolveDungeonMissionResults(resolvedDungeonId, {
    win: true,
    battleState,
    missionResult1: battleState && battleState.missionResult1,
    missionResult2: battleState && battleState.missionResult2,
  });
  if (missionResults.missionResult1 !== false && missionResults.missionResult2 !== false) {
    track("DUNGEON_CLEAR_PERFECT", 1);
    track("PHASE_CLEAR_PERFECT", 1);
    track("PHASE_CLEARED_PERFECT", 1);
    track("WARFARE_CLEAR_PERFECT", 1);
    track("WARFARE_CLEARED_PERFECT", 1);
  }
  const eterniumCost = getStageEterniumCost(resolvedStageId);
  if (eterniumCost > 0) {
    track("USE_ETERNIUM", eterniumCost, {
      ...details,
      itemId: RESOURCE_ITEM_IDS.ETERNIUM,
      resourceId: RESOURCE_ITEM_IDS.ETERNIUM,
    });
  }
  if (changed) refreshMissionProgress(user, { now, conditions: Array.from(changedConditions), eventDateKey: getServerEventDateKey() });
  return changed;
}

function isDailySimulationStageClear(dungeonId, stageId) {
  const text = stageMissionCounterText(dungeonId, stageId);
  return text.includes("DAILY") && !text.includes("SUPPLY");
}

function isSupplyStageClear(dungeonId, stageId) {
  return stageMissionCounterText(dungeonId, stageId).includes("SUPPLY");
}

function stageMissionCounterText(dungeonId, stageId) {
  const stage = getStageTableEntry(stageId) || findStageRowForDungeonId(dungeonId) || {};
  const dungeon = getDungeonTableEntry(dungeonId) || getDungeonTableEntryByStrId(stage.m_StageBattleStrID) || {};
  return [
    stage.m_OpenTag,
    stage.m_StageStrID,
    stage.m_StageBattleStrID,
    stage.m_StageDesc,
    dungeon.m_DungeonStrID,
    dungeon.m_DungeonType,
    dungeon.m_DungeonDesc,
  ]
    .map((value) => String(value || "").toUpperCase())
    .join(" ");
}

function sendStageClearMissionUpdate(socket, user, options = {}) {
  sendTrackedMissionUpdate(socket, user, {
    ...options,
    label: options.label || "stage-clear-mission-update",
  });
}

function sendTrackedMissionUpdate(socket, user, options = {}) {
  return sendMissionUpdateForTabs(socket, user, uniqueMissionTabs([...FAST_LOBBY_MISSION_TABS, ...getActiveEventMissionTabIds(), ...PAYBACK_MISSION_TABS]), {
    ...options,
    label: options.label || "mission-progress-update",
  });
}

function repairPostTutorialGuideMissionsForSocket(socket, options = {}) {
  const user = socket && socket.session && socket.session.user;
  if (!user || typeof user !== "object") return 0;
  if (CLEAR_ALL_MISSIONS_STATUS) return 0;
  const repaired = repairPostTutorialGuideMissionCompletions(user);
  if (repaired > 0 && USE_LOCAL_USER_DB) saveUserDb();
  if (options.notify !== false) sendPostTutorialGuideMissionCompleteAck(socket, user, options);
  return repaired;
}

function sendPostTutorialGuideMissionCompleteAck(socket, user, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!socket || !socket.session || !socket.session.gameReplay) return false;
  const replay = socket.session.gameReplay;
  if (options.once !== false && replay.postTutorialGuideMissionCompleteAckSent) return false;
  let sent = false;
  for (const missionId of POST_TUTORIAL_GUIDE_MISSION_IDS) {
    const mission = findCompletedMissionById(user, missionId);
    if (!mission || !(mission.rewardClaimed === true || mission.isComplete === true || mission.claimedAt)) continue;
    sendServerGamePacket(
      socket,
      MISSION_COMPLETE_ACK,
      buildMissionCompleteAckPayload({ missionID: Number(missionId) }),
      options.label || "post-tutorial-guide-mission-complete"
    );
    sent = true;
  }
  if (sent) replay.postTutorialGuideMissionCompleteAckSent = true;
  return sent;
}

function sendMissionUpdateForTabs(socket, user, tabIds, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!socket || !socket.session || !socket.session.gameReplay) return false;
  const clock = options.now && options.eventDateKey ? options : getMissionClockOptions();
  const now = options.now || clock.now || dateTimeBinaryNow();
  const eventDateKey = options.eventDateKey || clock.eventDateKey || getServerEventDateKey();
  const seen = new Set();
  const missions = [];
  for (const tabId of uniqueMissionTabs(tabIds)) {
    for (const [, mission] of buildAccountMissionDataEntries(user, {
      tabId,
      now,
      eventDateKey,
      conditions: options.conditions || options.condition,
    })) {
      const key = `${Number(mission && mission.groupId || 0)}:${Number(mission && mission.missionID || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      missions.push(mission);
    }
  }
  if (missions.length <= 0) return false;
  sendServerGamePacket(
    socket,
    MISSION_UPDATE_NOT,
    writeObjectList(missions.map((mission) => writeNullableObject(buildMissionData(Number(mission && mission.missionID || 0), mission)))),
    options.label || "mission-update"
  );
  return true;
}

function getStageEterniumCost(stageId) {
  const stage = getStageTableEntry(stageId);
  const reqItemId = Number(stage && (stage.m_StageReqItemID || stage.StageReqItemID || 0));
  if (reqItemId !== RESOURCE_ITEM_IDS.ETERNIUM) return 0;
  return Math.max(0, Number(stage && (stage.m_StageReqItemCount || stage.StageReqItemCount || 0)) || 0);
}

function getStageReqItemCost(stageId, options = {}) {
  const stage = getStageTableEntry(stageId);
  const itemId = Number(stage && (stage.m_StageReqItemID || stage.StageReqItemID || 0));
  const count = Math.max(0, Number(stage && (stage.m_StageReqItemCount || stage.StageReqItemCount || 0)) || 0);
  if (Number.isInteger(itemId) && itemId > 0 && count > 0) return { itemId, count };
  const dungeonId = positiveInt(options.dungeonID || options.dungeonId) || positiveInt(stageId);
  const genericStage = dungeonId ? getGenericStageForRequest({ dungeonID: dungeonId }) : null;
  const miscItemId = positiveInt(genericStage && genericStage.stageReqItemId);
  const miscCount = Math.max(0, Number(genericStage && genericStage.stageReqItemCount) || 0);
  if (!miscItemId || miscCount <= 0) return null;
  return { itemId: miscItemId, count: miscCount };
}

function spendStageReqItemCost(user, stageId, options = {}) {
  if (!user || typeof user !== "object") return [];
  const cost = getStageReqItemCost(stageId, options);
  if (!cost) return [];
  const multiplier = Math.max(1, Number(options.multiplier || 1) || 1);
  const totalCount = cost.count * multiplier;
  stamina.refreshTimedStamina(user, {
    now: dateTimeBinaryNow(),
    itemIds: [cost.itemId],
    initializeMissing: true,
  });
  const updated = spendMiscItem(user, cost.itemId, totalCount, { regDate: dateTimeBinaryNow() });
  return updated ? [updated] : [];
}

function spendStageReqItemCostForReplay(replay, user, stageId) {
  if (!replay || !user) return [];
  const dynamicGame = replay.dynamicGame && typeof replay.dynamicGame === "object" ? replay.dynamicGame : {};
  const key = `${Number(stageId || 0)}:${String(dynamicGame.gameUID || dynamicGame.gameUid || "")}`;
  replay.spentStageReqItemCosts = replay.spentStageReqItemCosts && typeof replay.spentStageReqItemCosts === "object" ? replay.spentStageReqItemCosts : {};
  if (replay.spentStageReqItemCosts[key]) return [];
  const costItems = spendStageReqItemCost(user, stageId, {
    dungeonID: dynamicGame.dungeonID,
    multiplier: Math.max(1, Math.trunc(Number(dynamicGame.rewardMultiply || 1)) || 1),
  });
  replay.spentStageReqItemCosts[key] = true;
  if (costItems.length > 0) replay.stageReqItemCostChanged = true;
  return costItems;
}

function buildPhaseClearData(stageId, options = {}) {
  const missionResult1 =
    typeof options.missionResult1 === "boolean"
      ? options.missionResult1
      : options.forceMissionSuccess
        ? true
        : options.win === false
          ? false
          : true;
  const missionResult2 =
    typeof options.missionResult2 === "boolean"
      ? options.missionResult2
      : options.forceMissionSuccess
        ? true
        : options.win === false
          ? false
          : true;
  return Buffer.concat([
    writeSignedVarInt(Number(stageId || 0)),
    writeBool(missionResult1), // missionResult1
    writeBool(missionResult2), // missionResult2
    options.missionReward ? writeNullableObject(buildSerializedRewardData(options.missionReward)) : writeNullObject(),
    writeBool(Boolean(options.missionRewardResult)),
    options.oneTimeRewards ? writeNullableObject(buildSerializedRewardData(options.oneTimeRewards)) : writeNullObject(),
    writeBoolList(Array.isArray(options.onetimeRewardResults) ? options.onetimeRewardResults.map(Boolean) : [false, false, false]),
    writeNullableObject(buildSerializedRewardData(options.reward || options.rewardData || createEmptyReward())),
  ]);
}

function episodeCompleteKey(episodeId, difficulty = 0) {
  return (BigInt(Number(episodeId || 0)) << 32n) | BigInt(Number(difficulty || 0) >>> 0);
}

function buildEpisodeCompleteData(episodeId, difficulty, completeCount, rewardFlags = []) {
  const flags = Array.isArray(rewardFlags) ? rewardFlags : [];
  return Buffer.concat([
    writeSignedVarInt(Number(episodeId || 0)),
    writeSignedVarInt(Number(difficulty || 0)),
    writeSignedVarInt(Math.max(0, Number(completeCount || 0) || 0)),
    writeBoolList([Boolean(flags[0]), Boolean(flags[1]), Boolean(flags[2])]),
  ]);
}

function mainStoryStageMedalValue(stage, state = null) {
  if (!stage) return 0;
  if (stage.cutsceneOnly || stage.tutorial) return 1;
  if (state && state.completed === true) {
    return 1 + (state.missionResult1 !== false ? 1 : 0) + (state.missionResult2 !== false ? 1 : 0);
  }
  return 3;
}

function mainStoryEpisodeMedalValue(stage, state = null) {
  if (!stage) return 0;
  return mainStoryStageMedalValue(stage, state);
}

function getMainStoryCompletedStageStates(user, extraStageIds = [], options = {}) {
  if (!user || typeof user !== "object") return [];
  const mainStory = ensureMainStoryState(user);
  const states = mainStory && mainStory.stages && typeof mainStory.stages === "object" ? mainStory.stages : {};
  const difficulty =
    options && options.difficulty != null ? normalizeStoryDifficulty(options.difficulty) : null;
  const forcedStageIds = new Set(
    (Array.isArray(extraStageIds) ? extraStageIds : [extraStageIds])
      .map(Number)
      .filter((stageId) => Number.isInteger(stageId) && stageId > 0)
  );
  return MAIN_STORY_STAGE_CHAIN.map((stage) => {
    if (difficulty != null && Number(stage.difficulty || 0) !== difficulty) return null;
    if (isSuppressedStoryOpenTag(stage.openTag) && !EXPLICIT_OPEN_TAG_SET.has(String(stage.openTag || "").toUpperCase())) return null;
    const stageId = Number(stage.stageId || 0);
    const state = states[String(stageId)] || {};
    if (state.completed !== true && !forcedStageIds.has(stageId)) return null;
    return {
      ...stage,
      ...state,
      stageId,
      dungeonID: Number(stage.dungeonID || state.dungeonId || 0),
      bestClearTimeSec: Number(state.bestClearTimeSec || 0),
    };
  }).filter(Boolean);
}

function getMainStoryEpisodeCompleteMedalCount(user, episodeId, extraStageIds = []) {
  const options = extraStageIds && typeof extraStageIds === "object" && !Array.isArray(extraStageIds) ? { ...extraStageIds } : {};
  if (!Object.prototype.hasOwnProperty.call(options, "difficulty")) options.difficulty = 0;
  const forcedIds = options.extraStageIds || extraStageIds;
  return getMainStoryCompletedStageStates(user, forcedIds, options).reduce(
    (total, stage) => (Number(stage.episodeId || 0) === Number(episodeId || 0) ? total + mainStoryEpisodeMedalValue(stage, stage) : total),
    0
  );
}

function buildMainStoryEpisodeCompleteData(user, episodeId, difficulty = 0, extraStageIds = []) {
  const numericDifficulty = normalizeStoryDifficulty(difficulty);
  const completeCount = getMainStoryEpisodeCompleteMedalCount(user, episodeId, {
    difficulty: numericDifficulty,
    extraStageIds,
  });
  if (completeCount <= 0) return null;
  return buildEpisodeCompleteData(
    episodeId,
    numericDifficulty,
    completeCount,
    collection.getEpisodeRewardFlags(user, episodeId, numericDifficulty)
  );
}

function buildMainStoryEpisodeCompleteDataForStage(user, stageId) {
  const stage = getMainStoryStageByStageId(stageId);
  if (!stage) return null;
  return buildMainStoryEpisodeCompleteData(user, stage.episodeId, stage.difficulty, [stage.stageId]);
}

function recordTutorialDungeonClear(socket, replay) {
  if (!socket || !socket.session || !replay || replay.tutorialClearRecorded) return;
  const dynamicGame = replay.dynamicGame || {};
  const dungeonId = Number(dynamicGame.dungeonID || 0);
  const stageId = Number(dynamicGame.stageID || stageIdForDungeonId(dungeonId));
  if (!isTutorialDungeonId(dungeonId) || !isTutorialStageId(stageId)) return;
  if (recordTutorialDungeonClearForUser(socket.session.user, dungeonId, stageId, replay.battleState)) {
    replay.tutorialClearRecorded = true;
  }
}

function recordGameplayUnlockClear(socket, dungeonId, stageId = 0) {
  const user = socket && socket.session && socket.session.user;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  const changed = recordGameplayUnlockClearForUser(user, resolvedDungeonId, resolvedStageId);
  if (changed) {
    console.log(
      `[unlock-progress] uid=${user && user.userUid ? user.userUid : "(none)"} stageID=${resolvedStageId} dungeonID=${resolvedDungeonId}`
    );
  }
  return changed;
}

function recordPersistentCutsceneView(socket, dungeonId, stageId = 0) {
  const user = socket && socket.session && socket.session.user;
  return recordPersistentCutsceneViewForUser(user, dungeonId, stageId);
}

function recordTutorialCutsceneClear(socket, dungeonId) {
  const replay = socket && socket.session && socket.session.gameReplay;
  const user = socket && socket.session && socket.session.user;
  const battleFinished =
    replay &&
    (replay.tutorialClearRecorded ||
      replay.dynamicBattleResultSent ||
      (replay.battleState && (replay.battleState.finished || replay.battleState.Finished)));
  const activeDungeonId = Number(replay && replay.dynamicGame && replay.dynamicGame.dungeonID);
  const decodedDungeonId = Number(dungeonId || 0);
  const resolvedDungeonId = isTutorialDungeonId(activeDungeonId) ? activeDungeonId : decodedDungeonId;
  const stageId = stageIdForDungeonId(resolvedDungeonId);
  if (!isTutorialDungeonId(resolvedDungeonId) || !isTutorialStageId(stageId)) return false;
  if (shouldSuppressPostTutorialProgressArtifact(user, resolvedDungeonId, stageId)) return false;
  if (!battleFinished && !isTutorialDungeonId(activeDungeonId)) return false;
  return recordTutorialDungeonClearForUser(user, resolvedDungeonId, stageId, replay && replay.battleState);
}

function tutorialPhaseKey(stage) {
  return String(stage && (stage.dungeonID || stage.dungeonId || stage.stageId || ""));
}

function ensureTutorialState(user) {
  if (!user) return null;
  user.tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
  ensureTutorialNicknameMissionMarker(user);
  user.tutorial.enabled = user.tutorial.enabled !== false;
  user.tutorial.firstStageId = Number(user.tutorial.firstStageId || TUTORIAL_STAGE_CHAIN[0].stageId);
  user.tutorial.firstDungeonId = Number(user.tutorial.firstDungeonId || TUTORIAL_STAGE_CHAIN[0].dungeonID);
  const existingPhases = user.tutorial.phases && typeof user.tutorial.phases === "object" ? user.tutorial.phases : null;
  const dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const persistedComplete = hasPersistedTutorialCompletion(user);
  const phases = {};
  for (let index = 0; index < TUTORIAL_STAGE_CHAIN.length; index += 1) {
    const stage = TUTORIAL_STAGE_CHAIN[index];
    const key = tutorialPhaseKey(stage);
    const existing = existingPhases && typeof existingPhases[key] === "object" ? existingPhases[key] : {};
    const clear = dungeonClear[String(stage.dungeonID)];
    const play = stagePlayData[String(stage.stageId)];
    const completed = persistedComplete || user.tutorial.completed === true || existing.completed === true || Boolean(!existingPhases && clear);
    phases[key] = {
      phase: index + 1,
      stageId: stage.stageId,
      dungeonId: stage.dungeonID,
      stageStrID: stage.stageStrID,
      dungeonStrID: stage.dungeonStrID,
      completed,
      completedAt: existing.completedAt || (clear && clear.clearedAt) || "",
      bestClearTimeSec: Number(existing.bestClearTimeSec || (play && play.bestClearTimeSec) || 0),
    };
  }
  user.tutorial.phases = phases;
  normalizeTutorialPhaseOrder(user);
  if (Object.values(phases).every((phase) => phase.completed)) {
    user.tutorial.completed = true;
    user.tutorial.completedAt = user.tutorial.completedAt || new Date().toISOString();
  } else if (user.tutorial.completed !== true) {
    user.tutorial.completed = false;
  }
  const nextStage = nextTutorialStageForUser(user);
  user.tutorial.nextStageId = nextStage ? nextStage.stageId : 0;
  user.tutorial.nextDungeonId = nextStage ? nextStage.dungeonID : 0;
  return user.tutorial;
}

function ensureTutorialNicknameMissionMarker(user) {
  if (!user || !user.tutorial || user.tutorial.nicknameChanged !== true) return false;
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  if (user.completedMissions["999"]) return false;
  user.completedMissions["999"] = {
    tabId: 1,
    groupId: 999,
    missionID: 999,
    times: 1,
    lastUpdateDate: String(dateTimeBinaryNow()),
    isComplete: true,
    rewardReady: true,
    completedAt: user.tutorial.nicknameChangedAt || new Date().toISOString(),
  };
  return true;
}

function nextTutorialStageForUser(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
  const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[tutorialPhaseKey(stage)];
    if (!phase || phase.completed !== true) return stage;
  }
  return null;
}

function isTutorialComplete(user) {
  const tutorial = ensureTutorialState(user);
  return Boolean(tutorial && tutorial.completed === true);
}

function hasPersistedTutorialCompletion(user) {
  if (!user || typeof user !== "object") return false;
  const tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  if (user.loginFlow === "post-tutorial" || (tutorial && tutorial.loginMode === "post-tutorial")) return true;
  if (tutorial && tutorial.completed === true) return true;
  if (hasTutorialCompletionMission(user)) return true;

  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : null;
  if (
    phases &&
    TUTORIAL_STAGE_CHAIN.every((stage) => {
      const phase = phases[tutorialPhaseKey(stage)];
      return Boolean(phase && phase.completed === true);
    })
  ) {
    return true;
  }

  const dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  return TUTORIAL_STAGE_CHAIN.every((stage) => {
    const clear = dungeonClear[String(stage.dungeonID)];
    return Boolean(clear && clear.cleared !== false);
  });
}

function unlockNextTutorialStageForUser(user) {
  if (!user) return false;
  const tutorial = ensureTutorialState(user);
  const nextStage = nextTutorialStageForUser(user);
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  const unlockStageId = nextStage ? nextStage.stageId : TUTORIAL_STAGE_CHAIN[TUTORIAL_STAGE_CHAIN.length - 1].stageId;
  if (!user.unlockedStageIds.includes(unlockStageId)) user.unlockedStageIds.push(unlockStageId);
  tutorial.nextStageId = nextStage ? nextStage.stageId : 0;
  tutorial.nextDungeonId = nextStage ? nextStage.dungeonID : 0;
  return true;
}

function resetLocalProgressForUser(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!options.force && hasPersistedTutorialCompletion(user)) {
    ensureTutorialState(user);
    return false;
  }
  user.dungeonClear = {};
  user.stagePlayData = {};
  user.completedMissions = {};
  user.unlockedStageIds = [];
  user.mainStory = {};
  user.episode1 = {};
  resetTutorialProgressForUser(user, { save: false, force: options.force === true });
  ensureMainStoryState(user);
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return true;
}

function resetCampaignProgressForUser(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  const changed = resetMainStoryPostTutorialProgress(user);
  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return changed;
}

function resetTutorialProgressForUser(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  if (!options.force && hasPersistedTutorialCompletion(user)) {
    ensureTutorialState(user);
    return false;
  }
  let changed = scrubTutorialEpisodeClearProgress(user);
  user.tutorial = {
    enabled: true,
    firstStageId: TUTORIAL_STAGE_CHAIN[0].stageId,
    firstDungeonId: TUTORIAL_STAGE_CHAIN[0].dungeonID,
    completed: false,
    completedAt: "",
    nextStageId: TUTORIAL_STAGE_CHAIN[0].stageId,
    nextDungeonId: TUTORIAL_STAGE_CHAIN[0].dungeonID,
    phases: {},
  };
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    user.tutorial.phases[tutorialPhaseKey(stage)] = {
      phase: TUTORIAL_STAGE_CHAIN.indexOf(stage) + 1,
      stageId: stage.stageId,
      dungeonId: stage.dungeonID,
      stageStrID: stage.stageStrID,
      dungeonStrID: stage.dungeonStrID,
      completed: false,
      completedAt: "",
      bestClearTimeSec: 0,
    };
  }
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  const tutorialStageIds = new Set(TUTORIAL_STAGE_CHAIN.map((stage) => Number(stage.stageId)));
  const nextUnlocked = user.unlockedStageIds.filter((stageId) => !tutorialStageIds.has(Number(stageId)));
  if (!nextUnlocked.includes(TUTORIAL_STAGE_CHAIN[0].stageId)) nextUnlocked.push(TUTORIAL_STAGE_CHAIN[0].stageId);
  if (nextUnlocked.length !== user.unlockedStageIds.length || nextUnlocked.some((stageId, index) => stageId !== user.unlockedStageIds[index])) {
    user.unlockedStageIds = nextUnlocked;
    changed = true;
  }
  if (user.completedMissions && typeof user.completedMissions === "object") {
    for (const [key, mission] of Object.entries(user.completedMissions)) {
      if (TUTORIAL_COMPLETION_MISSION_IDS.includes(Number((mission && mission.missionID) || key))) {
        delete user.completedMissions[key];
        changed = true;
      }
    }
  }
  changed = true;
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return changed;
}

function maybeResetCampaignProgressOnLogin(user, resetKey) {
  if (!RESET_CAMPAIGN_PROGRESS_ON_LOGIN || !user) return false;
  const userKey = String(resetKey || user.userUid || user.steamLoginKey || user.steamAccountId || "ephemeral");
  const campaignResetKey = `campaign:${userKey}`;
  if (localProgressResetUsers.has(campaignResetKey)) return false;
  const changed = resetCampaignProgressForUser(user, { save: false });
  localProgressResetUsers.add(campaignResetKey);
  console.log(
    `[campaign-progress] uid=${user.userUid || "(ephemeral)"} reset post-tutorial progress${changed ? "" : " (already clean)"}`
  );
  return changed;
}

function prepareTutorialLogin(user) {
  if (!user) return false;
  const resetKey = String(user.userUid || user.steamLoginKey || user.steamAccountId || "ephemeral");
  ensureTutorialState(user);
  maybeResetCampaignProgressOnLogin(user, resetKey);
  if (hasPersistedTutorialCompletion(user) || isTutorialComplete(user)) {
    return preparePostTutorialLogin(user, resetKey);
  }

  const alreadyReset = localProgressResetUsers.has(resetKey);
  if (RESET_LOCAL_PROGRESS_ON_LOGIN && !alreadyReset) {
    resetLocalProgressForUser(user, { save: false });
    localProgressResetUsers.add(resetKey);
    console.log(`[tutorial-login] uid=${user.userUid || "(ephemeral)"} reset local stage/mission progress`);
  } else if (RESET_TUTORIAL_PROGRESS_ON_LOGIN && !alreadyReset) {
    resetTutorialProgressForUser(user, { save: false });
    localProgressResetUsers.add(resetKey);
    console.log(`[tutorial-login] uid=${user.userUid || "(ephemeral)"} reset local tutorial progress`);
  } else {
    ensureTutorialState(user);
  }
  if (!isTutorialComplete(user)) {
    unlockNextTutorialStageForUser(user);
  } else {
    ensureTutorialState(user);
  }
  console.log(
    `[tutorial-login] uid=${user.userUid || "(ephemeral)"} completed=${user.tutorial.completed ? 1 : 0} nextStage=${
      user.tutorial.nextStageId || 0
    } nextDungeon=${user.tutorial.nextDungeonId || 0}`
  );
  return true;
}

function preparePostTutorialLogin(user, resetKey = "") {
  const tutorial = ensureTutorialState(user);
  ensureTutorialCompletionProgress(user, {}, { force: true });
  tutorial.loginMode = "post-tutorial";
  tutorial.nextStageId = 0;
  tutorial.nextDungeonId = 0;
  ensurePostTutorialUserLevel(user);
  user.loginFlow = "post-tutorial";
  if (resetKey) localProgressResetUsers.add(resetKey);
  ensureMainStoryState(user);
  const repairedTutorialMissions = CLEAR_ALL_MISSIONS_STATUS
    ? 0
    : repairStageGatedTutorialMissionCompletions(user) + repairPostTutorialGuideMissionCompletions(user);
  if (repairedTutorialMissions > 0 && USE_LOCAL_USER_DB) saveUserDb();
  console.log(
    `[post-tutorial-login] uid=${user.userUid || "(ephemeral)"} completed=1 nextStage=0 nextDungeon=0${
      repairedTutorialMissions > 0 ? ` repairedTutorialMissions=${repairedTutorialMissions}` : ""
    }`
  );
  return true;
}

function repairStageGatedTutorialMissionCompletions(user) {
  if (!user || typeof user !== "object" || !hasPersistedTutorialCompletion(user)) return 0;
  let repaired = 0;
  for (const row of getMissionTempletsByTabId(1)) {
    if (!row || String(row.m_MissionCond || "").toUpperCase() !== "TUTORIAL") continue;
    if (missionRowHasReward(row)) continue;
    const missionId = Number(row.m_MissionID || 0);
    const forceStageId = Number(row.m_ForceClearStage || 0);
    if (!missionId || !forceStageId || !isTutorialRepairStageCleared(user, forceStageId)) continue;
    const existing = findCompletedMissionById(user, missionId);
    if (existing && (existing.rewardClaimed === true || existing.isComplete === true || existing.claimedAt)) continue;
    if (
      markMissionCompleteForUser(user, missionId, {
        tabId: Number(row.m_MissionTabId || 1) || 1,
        groupId: Number(row.m_MissionCounterGroupID || row.m_GroupId || missionId) || missionId,
        times: Math.max(1, Number(row.m_Times || 0) || 1),
        rewardClaimed: true,
        rewardReady: true,
        save: false,
      })
    ) {
      repaired += 1;
    }
  }
  return repaired;
}

function repairPostTutorialGuideMissionCompletions(user) {
  if (!user || typeof user !== "object") return 0;
  let repaired = 0;
  const wanted = new Set(POST_TUTORIAL_GUIDE_MISSION_IDS);
  for (const row of getMissionTempletsByTabId(1)) {
    if (!row || String(row.m_MissionCond || "").toUpperCase() !== "TUTORIAL") continue;
    const missionId = Number(row.m_MissionID || 0);
    if (!wanted.has(missionId) || missionRowHasReward(row)) continue;
    if (!shouldPersistPostTutorialGuideMission(user, missionId)) continue;
    const existing = findCompletedMissionById(user, missionId);
    if (existing && (existing.rewardClaimed === true || existing.isComplete === true || existing.claimedAt)) continue;
    if (
      markMissionCompleteForUser(user, missionId, {
        tabId: Number(row.m_MissionTabId || 1) || 1,
        groupId: Number(row.m_MissionCounterGroupID || row.m_GroupId || missionId) || missionId,
        times: Math.max(1, Number(row.m_Times || 0) || 1),
        rewardClaimed: true,
        rewardReady: true,
        save: false,
      })
    ) {
      repaired += 1;
    }
  }
  return repaired;
}

function shouldPersistPostTutorialGuideMission(user, missionId) {
  if (hasPersistedTutorialCompletion(user)) return true;
  const stageId = Number(POST_TUTORIAL_GUIDE_REQUIREMENT_STAGE_IDS[Number(missionId)] || 0);
  if (!stageId) return false;
  if (isTutorialRepairStageCleared(user, stageId)) return true;

  const stage = getMainStoryStageByStageId(stageId);
  const dungeonId = Number(stage && stage.dungeonID || 0);
  const dungeonClear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const clear = dungeonId ? dungeonClear[String(dungeonId)] : null;
  return Boolean(clear && clear.cleared !== false);
}

function missionRowHasReward(row) {
  for (let index = 1; index <= 5; index += 1) {
    if (row && row[`m_RewardType_${index}`] && Number(row[`m_RewardID_${index}`] || 0) > 0) return true;
  }
  return false;
}

function findCompletedMissionById(user, missionId) {
  const completedMissions =
    user && user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const direct = completedMissions[String(missionId)];
  if (direct) return direct;
  return Object.values(completedMissions).find((mission) => Number(mission && mission.missionID) === Number(missionId)) || null;
}

function isTutorialRepairStageCleared(user, stageId) {
  const numericStageId = Number(stageId || 0);
  if (!numericStageId) return false;
  const stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  if (stagePlayData[String(numericStageId)]) return true;
  for (const containerName of ["mainStory", "episode1"]) {
    const container = user[containerName];
    const state = container && container.stages && typeof container.stages === "object" ? container.stages[String(numericStageId)] : null;
    if (state && state.completed === true) return true;
  }
  const tutorialStage = TUTORIAL_STAGE_CHAIN.find((stage) => Number(stage.stageId || 0) === numericStageId);
  if (tutorialStage) {
    const tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
    const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
    const phase = phases[tutorialPhaseKey(tutorialStage)] || phases[String(tutorialStage.stageId)];
    return Boolean(phase && phase.completed === true);
  }
  return false;
}

function recordTutorialDungeonClearForUser(user, dungeonId, stageId, battleState = {}, options = {}) {
  if (!user) return false;
  const stageMeta = TUTORIAL_STAGE_CHAIN.find((stage) => stage.dungeonID === Number(dungeonId) || stage.stageId === Number(stageId));
  if (!stageMeta) return false;
  if (!options.force && shouldSuppressPostTutorialProgressArtifact(user, stageMeta.dungeonID, stageMeta.stageId)) {
    const changed = scrubTutorialEpisodeClearProgress(user);
    ensureMainStoryState(user);
    if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
    return false;
  }
  const tutorial = ensureTutorialState(user);
  let changed = scrubTutorialEpisodeClearProgress(user);
  const expectedStage = nextTutorialStageForUser(user);
  if (
    !options.force &&
    expectedStage &&
    (Number(expectedStage.dungeonID) !== Number(stageMeta.dungeonID) || Number(expectedStage.stageId) !== Number(stageMeta.stageId))
  ) {
    console.log(
      `[tutorial-progress] ignored out-of-order clear uid=${user.userUid || "(ephemeral)"} gotStage=${
        stageMeta.stageId
      } gotDungeon=${stageMeta.dungeonID} expectedStage=${expectedStage.stageId} expectedDungeon=${expectedStage.dungeonID}`
    );
    ensureMainStoryState(user);
    if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
    return false;
  }
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  const bestClearTimeSec = Math.max(0, Math.round(Number((battleState && battleState.gameTime) || 0)));
  const phase = tutorial.phases[tutorialPhaseKey(stageMeta)];
  const firstStageClear = !phase || phase.completed !== true;
  if (phase) {
    if (phase.completed !== true || !phase.completedAt || Number(phase.bestClearTimeSec || 0) !== bestClearTimeSec) {
      changed = true;
    }
    phase.completed = true;
    phase.completedAt = phase.completedAt || new Date().toISOString();
    phase.bestClearTimeSec = bestClearTimeSec;
  }
  if (!user.unlockedStageIds.includes(stageMeta.stageId)) {
    user.unlockedStageIds.push(stageMeta.stageId);
    changed = true;
  }
  const nextStage = nextTutorialStageForUser(user);
  if (nextStage && !user.unlockedStageIds.includes(nextStage.stageId)) {
    user.unlockedStageIds.push(nextStage.stageId);
    changed = true;
  }
  const finalTutorialStage = TUTORIAL_STAGE_CHAIN[TUTORIAL_STAGE_CHAIN.length - 1];
  if (stageMeta.dungeonID === finalTutorialStage.dungeonID || stageMeta.stageId === finalTutorialStage.stageId) {
    for (const tutorialStage of TUTORIAL_STAGE_CHAIN) {
      const candidate = tutorial.phases[tutorialPhaseKey(tutorialStage)];
      if (!candidate) continue;
      if (candidate.completed !== true || !candidate.completedAt) changed = true;
      candidate.completed = true;
      candidate.completedAt = candidate.completedAt || new Date().toISOString();
      if (!Number(candidate.bestClearTimeSec || 0)) candidate.bestClearTimeSec = bestClearTimeSec;
      if (!user.unlockedStageIds.includes(tutorialStage.stageId)) {
        user.unlockedStageIds.push(tutorialStage.stageId);
        changed = true;
      }
    }
  }
  if (Object.values(tutorial.phases || {}).every((candidate) => candidate && candidate.completed === true)) {
    if (!tutorial.completed || !tutorial.completedAt || tutorial.nextStageId !== 0 || tutorial.nextDungeonId !== 0) changed = true;
    tutorial.completed = true;
    tutorial.completedAt = tutorial.completedAt || new Date().toISOString();
    tutorial.nextStageId = 0;
    tutorial.nextDungeonId = 0;
    tutorial.loginMode = "post-tutorial";
    user.loginFlow = "post-tutorial";
    if (ensurePostTutorialUserLevel(user)) changed = true;
  } else {
    const nextStageId = nextStage ? nextStage.stageId : 0;
    const nextDungeonId = nextStage ? nextStage.dungeonID : 0;
    if (tutorial.nextStageId !== nextStageId || tutorial.nextDungeonId !== nextDungeonId) changed = true;
    tutorial.nextStageId = nextStageId;
    tutorial.nextDungeonId = nextDungeonId;
  }
  if (firstStageClear) {
    grantStageClearExp(user, stageMeta.stageId, stageMeta.dungeonID);
    trackStageClearMissionProgress(user, stageMeta.dungeonID, stageMeta.stageId, battleState);
    changed = true;
  }
  if (recordGameplayUnlockClearForUser(user, stageMeta.dungeonID, stageMeta.stageId, { save: false })) changed = true;
  ensureMainStoryState(user);
  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return true;
}

function recordGameplayUnlockClearForUser(user, dungeonId, stageId = 0, options = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (!resolvedDungeonId && !resolvedStageId) return false;
  if (shouldSuppressPostTutorialProgressArtifact(user, resolvedDungeonId, resolvedStageId)) return false;
  let changed = false;
  const now = new Date().toISOString();
  user.clearConditions = user.clearConditions && typeof user.clearConditions === "object" ? user.clearConditions : {};
  user.clearConditions.dungeons =
    user.clearConditions.dungeons && typeof user.clearConditions.dungeons === "object" ? user.clearConditions.dungeons : {};
  user.clearConditions.stages =
    user.clearConditions.stages && typeof user.clearConditions.stages === "object" ? user.clearConditions.stages : {};

  if (resolvedDungeonId) {
    const key = String(resolvedDungeonId);
    const existing = user.clearConditions.dungeons[key] || {};
    if (!existing.cleared || Number(existing.stageId || 0) !== resolvedStageId) changed = true;
    user.clearConditions.dungeons[key] = {
      dungeonId: resolvedDungeonId,
      stageId: resolvedStageId,
      cleared: true,
      firstClearedAt: existing.firstClearedAt || now,
      lastClearedAt: now,
    };
  }

  if (resolvedStageId) {
    const key = String(resolvedStageId);
    const existing = user.clearConditions.stages[key] || {};
    if (!existing.cleared || Number(existing.dungeonId || 0) !== resolvedDungeonId) changed = true;
    user.clearConditions.stages[key] = {
      stageId: resolvedStageId,
      dungeonId: resolvedDungeonId,
      cleared: true,
      firstClearedAt: existing.firstClearedAt || now,
      lastClearedAt: now,
    };
  }

  const unlocks = getContentUnlocksForDungeon(resolvedDungeonId);
  if (unlocks.length) {
    user.gameplayUnlocks = user.gameplayUnlocks && typeof user.gameplayUnlocks === "object" ? user.gameplayUnlocks : {};
    user.gameplayUnlocks.byKey =
      user.gameplayUnlocks.byKey && typeof user.gameplayUnlocks.byKey === "object" ? user.gameplayUnlocks.byKey : {};
    user.gameplayUnlocks.byDungeon =
      user.gameplayUnlocks.byDungeon && typeof user.gameplayUnlocks.byDungeon === "object" ? user.gameplayUnlocks.byDungeon : {};
    const dungeonUnlockKeys = new Set(Array.isArray(user.gameplayUnlocks.byDungeon[String(resolvedDungeonId)])
      ? user.gameplayUnlocks.byDungeon[String(resolvedDungeonId)]
      : []);
    for (const unlock of unlocks) {
      const type = String(unlock.eContentsType || "");
      const contentsValue = Number(unlock.m_ContentsValue || 0);
      const key = `${type}:${contentsValue}`;
      const existing = user.gameplayUnlocks.byKey[key] || {};
      if (!existing.unlocked) changed = true;
      user.gameplayUnlocks.byKey[key] = {
        key,
        type,
        contentsValue,
        unlockIndex: Number(unlock.IDX || 0) || 0,
        reqType: String(unlock.m_UnlockReqType || ""),
        reqValue: resolvedDungeonId,
        stageId: resolvedStageId,
        unlocked: true,
        firstUnlockedAt: existing.firstUnlockedAt || now,
        lastUnlockedAt: now,
      };
      if (!dungeonUnlockKeys.has(key)) {
        dungeonUnlockKeys.add(key);
        changed = true;
      }
    }
    user.gameplayUnlocks.byDungeon[String(resolvedDungeonId)] = Array.from(dungeonUnlockKeys).sort();
  }

  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return changed;
}

function recordPersistentCutsceneViewForUser(user, dungeonId, stageId = 0, options = {}) {
  if (!user || typeof user !== "object") return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  if (shouldSuppressPostTutorialProgressArtifact(user, resolvedDungeonId, resolvedStageId)) return false;
  if (!shouldPersistCutsceneView(resolvedDungeonId, resolvedStageId)) return false;
  user.persistentCutsceneViews =
    user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object" ? user.persistentCutsceneViews : {};
  const key = String(resolvedDungeonId || resolvedStageId);
  const existing = user.persistentCutsceneViews[key] || {};
  const now = new Date().toISOString();
  user.persistentCutsceneViews[key] = {
    dungeonId: resolvedDungeonId,
    stageId: resolvedStageId,
    viewed: true,
    persistent: true,
    firstViewedAt: existing.firstViewedAt || now,
    lastViewedAt: now,
  };
  const changed = !existing.viewed;
  if (USE_LOCAL_USER_DB && options.save !== false && changed) saveUserDb();
  return changed;
}

function repairDungeonClearDataFromProgress(user) {
  if (!user || typeof user !== "object") return 0;
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  let repaired = 0;

  const addClear = (dungeonId, source = {}) => {
    if (source && source.cleared === false) return;
    const resolvedDungeonId = Number(dungeonId || source.dungeonId || source.dungeonID || source.m_DungeonID || 0);
    if (!Number.isInteger(resolvedDungeonId) || resolvedDungeonId <= 0) return;
    const resolvedStageId = Number(
      source.stageId || source.stageID || source.m_StageID || stageIdForDungeonId(resolvedDungeonId) || 0
    );
    if (shouldSuppressPostTutorialProgressArtifact(user, resolvedDungeonId, resolvedStageId)) return;
    const key = String(resolvedDungeonId);
    const existing = user.dungeonClear[key] && typeof user.dungeonClear[key] === "object" ? user.dungeonClear[key] : {};
    const nextStageId = resolvedStageId || Number(existing.stageId || 0);
    const cutsceneOnly = isCutsceneOnlyDungeon(resolvedDungeonId, nextStageId);
    const missionResult1 = cutsceneOnly ? false : true;
    const missionResult2 = cutsceneOnly ? false : true;
    const next = {
      ...existing,
      dungeonId: resolvedDungeonId,
      stageId: nextStageId,
      missionResult1,
      missionResult2,
      clearedAt:
        existing.clearedAt ||
        source.clearedAt ||
        source.completedAt ||
        source.firstClearedAt ||
        source.firstViewedAt ||
        new Date().toISOString(),
    };
    const changed =
      user.dungeonClear[key] !== next &&
      (!user.dungeonClear[key] ||
        Number(existing.dungeonId || key) !== resolvedDungeonId ||
        Number(existing.stageId || 0) !== Number(next.stageId || 0) ||
        existing.missionResult1 !== next.missionResult1 ||
        existing.missionResult2 !== next.missionResult2 ||
        !existing.clearedAt);
    user.dungeonClear[key] = next;
    if (nextStageId > 0) {
      if (!user.unlockedStageIds.includes(nextStageId)) {
        user.unlockedStageIds.push(nextStageId);
        repaired += 1;
      }
      const stageKey = String(nextStageId);
      if (!user.stagePlayData[stageKey] && source.recordStagePlay !== false) {
        user.stagePlayData[stageKey] = {
          stageId: nextStageId,
          playCount: Math.max(1, Number(source.playCount || 0)),
          totalPlayCount: Math.max(1, Number(source.totalPlayCount || source.playCount || 0)),
          bestClearTimeSec: Number(source.bestClearTimeSec || 0),
        };
        repaired += 1;
      }
    }
    if (changed) repaired += 1;
  };

  for (const [key, clear] of Object.entries(user.dungeonClear)) {
    addClear(Number((clear && clear.dungeonId) || key), { ...clear, recordStagePlay: false });
  }
  const clearConditions = user.clearConditions && typeof user.clearConditions === "object" ? user.clearConditions : {};
  const clearDungeons =
    clearConditions.dungeons && typeof clearConditions.dungeons === "object" ? clearConditions.dungeons : {};
  for (const [key, clear] of Object.entries(clearDungeons)) {
    addClear(Number((clear && clear.dungeonId) || key), clear);
  }
  const clearStages = clearConditions.stages && typeof clearConditions.stages === "object" ? clearConditions.stages : {};
  for (const [key, clear] of Object.entries(clearStages)) {
    const stageId = Number((clear && clear.stageId) || key);
    addClear(resolveDungeonIdForStageProgress(stageId, clear), { ...clear, stageId });
  }
  for (const [key, play] of Object.entries(user.stagePlayData)) {
    const stageId = Number((play && play.stageId) || key);
    addClear(resolveDungeonIdForStageProgress(stageId, play), { ...play, stageId, recordStagePlay: false });
  }
  const gameplayUnlocks = user.gameplayUnlocks && typeof user.gameplayUnlocks === "object" ? user.gameplayUnlocks : {};
  const gameplayByDungeon =
    gameplayUnlocks.byDungeon && typeof gameplayUnlocks.byDungeon === "object" ? gameplayUnlocks.byDungeon : {};
  for (const dungeonId of Object.keys(gameplayByDungeon)) addClear(Number(dungeonId), { recordStagePlay: false });
  const cutsceneViews =
    user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object" ? user.persistentCutsceneViews : {};
  for (const [key, view] of Object.entries(cutsceneViews)) {
    if (!view || view.viewed === false) continue;
    const stageId = Number(view.stageId || 0);
    const dungeonId = Number(view.dungeonId || 0) || Number(key) || resolveDungeonIdForStageProgress(stageId, view);
    addClear(dungeonId, { ...view, stageId });
  }
  return repaired;
}

function shouldSuppressPostTutorialProgressArtifact(user, dungeonId, stageId = 0) {
  if (!hasPersistedTutorialCompletion(user)) return false;
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || stageIdForDungeonId(resolvedDungeonId) || 0);
  return isTutorialDungeonId(resolvedDungeonId) || isTutorialStageId(resolvedStageId);
}

function resolveDungeonIdForStageProgress(stageId, source = {}) {
  const explicit = Number(source && (source.dungeonId || source.dungeonID || source.m_DungeonID));
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const numericStageId = Number(stageId || 0);
  if (!Number.isInteger(numericStageId) || numericStageId <= 0) return 0;
  const mainStoryStage = getMainStoryStageByStageId(numericStageId);
  if (mainStoryStage && Number(mainStoryStage.dungeonID) > 0) return Number(mainStoryStage.dungeonID);
  const tutorialStage = TUTORIAL_STAGE_CHAIN.find((stage) => Number(stage.stageId) === numericStageId);
  if (tutorialStage && Number(tutorialStage.dungeonID) > 0) return Number(tutorialStage.dungeonID);
  const genericStage = getGenericStageForRequest({ stageID: numericStageId });
  return Number(genericStage && genericStage.dungeonID) || 0;
}

function shouldPersistCutsceneView(dungeonId, stageId) {
  const resolvedDungeonId = Number(dungeonId || 0);
  const resolvedStageId = Number(stageId || 0);
  const mainStoryStage = getMainStoryStageByStageId(resolvedStageId);
  return (
    isTutorialDungeonId(resolvedDungeonId) ||
    isTutorialStageId(resolvedStageId) ||
    isMainStoryCutsceneDungeonId(resolvedDungeonId) ||
    isCutsceneOnlyDungeon(resolvedDungeonId, resolvedStageId) ||
    Boolean(mainStoryStage && mainStoryStage.cutsceneOnly)
  );
}

function hasTutorialCompletionMarker(user) {
  return hasPersistedTutorialCompletion(user) || isTutorialComplete(user);
}

function ensureTutorialCompletionProgress(user, battleState = {}, options = {}) {
  if (!user) return false;
  if (!options.force && !hasTutorialCompletionMarker(user)) return false;
  const tutorial = ensureTutorialState(user);
  let changed = scrubTutorialEpisodeClearProgress(user);
  const rawGameTime = Number((battleState && battleState.gameTime) || (battleState && battleState.GameTime) || 0);
  const hasBattleTime = Number.isFinite(rawGameTime) && rawGameTime > 0;
  const bestClearTimeSec = Math.max(0, Math.round(rawGameTime));
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = tutorial.phases[tutorialPhaseKey(stage)];
    if (!phase) continue;
    const nextBestClearTimeSec = hasBattleTime ? bestClearTimeSec : Number(phase.bestClearTimeSec || 0);
    if (phase.completed !== true || !phase.completedAt || Number(phase.bestClearTimeSec || 0) !== nextBestClearTimeSec) {
      changed = true;
    }
    phase.completed = true;
    phase.completedAt = phase.completedAt || new Date().toISOString();
    phase.bestClearTimeSec = nextBestClearTimeSec;
  }
  if (!tutorial.completed || !tutorial.completedAt || tutorial.nextStageId !== 0 || tutorial.nextDungeonId !== 0) {
    tutorial.completed = true;
    tutorial.completedAt = tutorial.completedAt || new Date().toISOString();
    tutorial.nextStageId = 0;
    tutorial.nextDungeonId = 0;
    changed = true;
  }
  if (ensurePostTutorialUserLevel(user)) changed = true;
  if (changed) {
    console.log(
      `[tutorial-progress] repaired tutorial-only completion uid=${user.userUid || "(ephemeral)"} phases=${TUTORIAL_STAGE_CHAIN.map(
        (stage) => stage.stageId
      ).join(",")}`
    );
    if (USE_LOCAL_USER_DB) saveUserDb();
  }
  return changed;
}

function ensurePostTutorialUserLevel(user) {
  if (!user || typeof user !== "object") return false;
  const beforeLevel = Math.max(1, Number(user.level || 1) || 1);
  const beforeExp = String(user.exp == null ? "0" : user.exp);
  const beforeTotalExp = String(user.totalExp == null ? "0" : user.totalExp);
  if (beforeLevel < POST_TUTORIAL_MIN_USER_LEVEL) {
    user.level = POST_TUTORIAL_MIN_USER_LEVEL;
    user.exp = "0";
    user.totalExp = getMinimumTotalExpForUserLevel(POST_TUTORIAL_MIN_USER_LEVEL).toString();
  }
  ensureAccountProgress(user);
  return (
    beforeLevel !== Number(user.level || 1) ||
    beforeExp !== String(user.exp == null ? "0" : user.exp) ||
    beforeTotalExp !== String(user.totalExp == null ? "0" : user.totalExp)
  );
}

function getMinimumTotalExpForUserLevel(level) {
  const targetLevel = Math.max(1, Number(level || 1) || 1);
  const tableTotal = Number(getPlayerTotalExpForLevel(targetLevel) || 0);
  if (tableTotal > 0 || targetLevel <= 1) return BigInt(Math.max(0, tableTotal));
  return BigInt((targetLevel - 1) * 100);
}

function getJoinLobbyUserLevel(user) {
  if (!user || typeof user !== "object") return 1;
  if (hasPersistedTutorialCompletion(user)) {
    ensurePostTutorialUserLevel(user);
  } else {
    ensureAccountProgress(user);
  }
  return Math.max(1, Number(user.level || 1) || 1);
}

function recordMissionComplete(socket, req) {
  const user = socket && socket.session && socket.session.user;
  if (!user || !req || !req.missionID) return null;
  const result = completeAccountMission(user, req, getMissionClockOptions());
  console.log(
    `[mission] complete uid=${user.userUid} missionID=${req.missionID} tabId=${req.tabId} groupId=${req.groupId} exp=${
      result && result.reward ? result.reward.userExp : 0
    } achievePoint=${result && result.reward ? result.reward.achievePoint : "0"}`
  );
  if (result && result.changed && USE_LOCAL_USER_DB) saveUserDb();
  return result;
}

function markMissionCompleteForUser(user, missionId, options = {}) {
  if (!user) return false;
  const numericMissionId = Number(missionId || 0);
  if (!Number.isInteger(numericMissionId) || numericMissionId <= 0) return false;
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const existing = user.completedMissions[String(numericMissionId)] || {};
  const tabId = Number(options.tabId || existing.tabId || 1);
  const groupId = Number(options.groupId || existing.groupId || numericMissionId);
  user.completedMissions[String(numericMissionId)] = {
    tabId,
    groupId,
    missionID: numericMissionId,
    times: Number(options.times || existing.times || 1),
    lastUpdateDate: String(options.lastUpdateDate || existing.lastUpdateDate || dateTimeBinaryNow()),
    isComplete: options.rewardClaimed === true,
    rewardReady: options.rewardReady !== false,
    rewardClaimed: options.rewardClaimed === true,
    completedAt: existing.completedAt || new Date().toISOString(),
    claimedAt: options.rewardClaimed === true ? existing.claimedAt || new Date().toISOString() : existing.claimedAt || "",
  };
  if (USE_LOCAL_USER_DB && options.save !== false) saveUserDb();
  return true;
}

function buildEmptyRewardData() {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeIntList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeIntList([]),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeObjectList([]),
    writeSignedVarLong(0n),
    writeObjectList([]),
    writeObjectList([]),
    writeObjectList([]),
  ]);
}

function buildAdditionalRewardData() {
  return Buffer.concat([writeSignedVarLong(0n), writeSignedVarLong(0n), writeSignedVarLong(0n)]);
}

function decodeMissionCompleteReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const tabId = readSignedVarInt(decrypted, offset);
    offset = tabId.offset;
    const groupId = readSignedVarInt(decrypted, offset);
    offset = groupId.offset;
    const missionID = readSignedVarInt(decrypted, offset);
    return {
      tabId: tabId.value,
      groupId: groupId.value,
      missionID: missionID.value,
    };
  } catch (err) {
    console.log(`[MISSION_COMPLETE_REQ] decode failed: ${err.message}`);
    return { tabId: 1, groupId: 0, missionID: 0 };
  }
}

function buildMissionCompleteAckPayload(req) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number((req && req.missionID) || 0)),
    writeNullableObject(buildSerializedRewardData({})),
    writeNullableObject(buildAdditionalRewardData()),
  ]);
}

function buildEmoticonDataAckPayload() {
  const emptyPresetData = Buffer.concat([
    writeIntList([]), // animationList
    writeIntList([]), // textList
  ]);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(emptyPresetData),
    writeIntList([]), // collections
    writeObjectList([]), // emoticonDatas
  ]);
}

function buildFriendListAckPayload(friendListType = 0) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(friendListType || 0)),
    writeObjectList([]),
  ]);
}

function buildGreetingMessageAckPayload(message = "") {
  return Buffer.concat([writeSignedVarInt(0), writeString(message || "")]);
}

function buildFavoritesStageAckPayload(user, errorCode = 0) {
  return buildStageFavoritesAckPayload(user, errorCode);
}

function buildDefenceInfoAckPayload(defenceTempletId = 0) {
  return Buffer.concat([
    writeSignedVarInt(0), // errorCode
    writeSignedVarInt(Number(defenceTempletId || 0)), // defenceTempletId
    writeSignedVarInt(0), // bestScore
    writeBool(false), // m_MissionResult1
    writeBool(false), // m_MissionResult2
    writeSignedVarInt(0), // rank
    writeSignedVarInt(0), // rankPercent
    writeBool(false), // canReceiveRankReward
    writeNullableObject(Buffer.concat([
      writeNullableObject(buildCommonProfileData(null, 0n, 0n, "")),
      writeSignedVarInt(0),
      writeNullableObject(buildGuildSimpleData()),
    ])), // topRankProfile
    writeIntList([]), // scoreRewardIds
  ]);
}

function ensureMiscStageState(user) {
  if (!user || typeof user !== "object") return null;
  user.miscStages = user.miscStages && typeof user.miscStages === "object" ? user.miscStages : {};
  return user.miscStages;
}

function ensureFierceSeasonState(user, options = {}) {
  const root = ensureMiscStageState(user);
  if (!root) return null;
  root.fierce = root.fierce && typeof root.fierce === "object" ? root.fierce : {};
  root.fierce.bosses = root.fierce.bosses && typeof root.fierce.bosses === "object" ? root.fierce.bosses : {};
  root.fierce.seasons = root.fierce.seasons && typeof root.fierce.seasons === "object" ? root.fierce.seasons : {};
  const seasonId = getCurrentFierceSeasonId();
  const seasonKey = String(seasonId || "default");
  const season = root.fierce.seasons[seasonKey] && typeof root.fierce.seasons[seasonKey] === "object"
    ? root.fierce.seasons[seasonKey]
    : {};
  season.bosses = season.bosses && typeof season.bosses === "object" ? season.bosses : {};
  season.pointRewardHistory = uniquePositiveIntList(season.pointRewardHistory);
  root.fierce.seasons[seasonKey] = season;
  if (seasonId) root.fierce.currentSeasonId = seasonId;
  return { root, fierce: root.fierce, season, seasonId, seasonKey };
}

function getFierceSeasonState(user) {
  const fierce = user && user.miscStages && user.miscStages.fierce && typeof user.miscStages.fierce === "object"
    ? user.miscStages.fierce
    : {};
  const seasonId = getCurrentFierceSeasonId();
  const seasonKey = String(seasonId || "default");
  const season = fierce.seasons && fierce.seasons[seasonKey] && typeof fierce.seasons[seasonKey] === "object"
    ? fierce.seasons[seasonKey]
    : {};
  return { fierce, season, seasonId, seasonKey };
}

function ensureFierceBossSeasonState(user, bossId) {
  const state = ensureFierceSeasonState(user);
  const resolvedBossId = positiveInt(bossId);
  if (!state || !resolvedBossId) return null;
  const key = String(resolvedBossId);
  const existing = state.season.bosses[key] && typeof state.season.bosses[key] === "object"
    ? state.season.bosses[key]
    : state.fierce.bosses[key] && typeof state.fierce.bosses[key] === "object"
      ? { ...state.fierce.bosses[key] }
      : {};
  existing.bossId = resolvedBossId;
  state.season.bosses[key] = existing;
  state.fierce.bosses[key] = existing;
  return existing;
}

function getFierceSavedBossState(user, bossId) {
  const resolvedBossId = positiveInt(bossId);
  if (!resolvedBossId) return {};
  const { fierce, season } = getFierceSeasonState(user);
  return (
    (season.bosses && season.bosses[String(resolvedBossId)]) ||
    (fierce.bosses && fierce.bosses[String(resolvedBossId)]) ||
    {}
  );
}

function getFierceSeasonTotalPoint(user, seasonRow = null) {
  const { season, fierce } = getFierceSeasonState(user);
  const rows = getFierceSeasonBossRows(seasonRow);
  const groupBest = new Map();
  for (const row of rows) {
    const bossId = positiveInt(row && row.FierceBossID);
    const groupId = positiveInt(row && row.FierceBossGroupID);
    if (!bossId || !groupId) continue;
    const saved =
      (season.bosses && season.bosses[String(bossId)]) ||
      (fierce.bosses && fierce.bosses[String(bossId)]) ||
      {};
    const point = Math.max(0, Math.trunc(Number(saved.point || 0) || 0));
    groupBest.set(groupId, Math.max(groupBest.get(groupId) || 0, point));
  }
  return Array.from(groupBest.values()).reduce((total, point) => total + point, 0);
}

function buildPhaseStartAckPayload(req = {}, user = null, ctx = null) {
  if (!req || req.valid === false) return phaseStartFailure(PHASE_ERRORS.INVALID_REQUEST);
  const stageId = positiveInt(req.stageId || req.stageID);
  const stage = getGenericStageForRequest({ stageID: stageId });
  if (!stage || Number(stage.gameType || 0) !== NGT_PHASE || !positiveInt(stage.phaseId)) {
    return phaseStartFailure(PHASE_ERRORS.INVALID_STAGE);
  }
  const dungeonId = positiveInt(stage && stage.dungeonID);
  const phaseIndex = Math.max(0, Number(stage && stage.phaseIndex) || 0);
  const supportingUserUid = toBigInt(req.supportingUserUid || 0);
  if (supportingUserUid < 0n || !isAvailablePhaseSupport(ctx, user, supportingUserUid)) {
    return phaseStartFailure(PHASE_ERRORS.SUPPORT_NOT_FOUND);
  }
  const selection = validatePhaseDeckSelection(user, stage, req);
  if (!selection.valid) return phaseStartFailure(selection.errorCode);
  const costError = validatePhaseStageCost(user, stageId);
  if (costError) return phaseStartFailure(costError);
  const state = ensureMiscStageState(user);
  if (state && stageId) {
    state.phase = {
      stageId,
      phaseId: positiveInt(stage.phaseId),
      phaseIndex,
      dungeonId,
      totalPlayTime: 0,
      supportingUserUid: supportingUserUid.toString(),
      deckIndex: {
        deckType: Number(req.deckIndex && req.deckIndex.deckType || 0),
        index: Number(req.deckIndex && req.deckIndex.index || 0),
      },
      eventDeckData: serializePhaseEventDeckSelection(req.eventDeckData),
    };
    persistPhaseState(ctx, "phase-start");
  }
  return Buffer.concat([
    writeSignedVarInt(PHASE_ERRORS.OK),
    writeNullableObject(buildPhaseModeState(stageId, phaseIndex, dungeonId, 0, supportingUserUid)),
  ]);
}

function phaseStartFailure(errorCode) {
  return Buffer.concat([writeSignedVarInt(Number(errorCode || PHASE_ERRORS.INVALID_REQUEST)), writeNullObject()]);
}

function validatePhaseStageCost(user, stageId) {
  const cost = getStageReqItemCost(stageId);
  if (!cost) return 0;
  const item = getMiscItems(user).find((entry) => Number(entry && entry.itemId) === cost.itemId) || {};
  const balance = toBigInt(item.countFree || 0) + toBigInt(item.countPaid || 0);
  if (balance >= BigInt(cost.count)) return 0;
  if (cost.itemId === 1) return PHASE_ERRORS.INSUFFICIENT_CASH;
  if (cost.itemId === 2) return PHASE_ERRORS.INSUFFICIENT_ETERNIUM;
  if (cost.itemId === 101) return PHASE_ERRORS.INSUFFICIENT_CREDIT;
  if (cost.itemId === 3) return PHASE_ERRORS.INSUFFICIENT_INFORMATION;
  return PHASE_ERRORS.INSUFFICIENT_ITEM;
}

function validatePhaseDeckSelection(user, stage, req) {
  const eventDeckId = positiveInt(stage && stage.eventDeckId);
  const deckIndex = req && req.deckIndex || {};
  const deckType = Number(deckIndex.deckType || 0);
  const index = Number(deckIndex.index || 0);
  if (eventDeckId <= 0) {
    if (req.eventDeckData || deckType !== 3) return { valid: false, errorCode: PHASE_ERRORS.INVALID_REQUEST };
    return validatePlayerDeckForGameLoad(user, { selectDeckIndex: index }, { deckType: 3, requiredState: 0 });
  }
  if (deckType !== 0 || index !== 0 || !req.eventDeckData || !getEventDeckTemplet(eventDeckId)) {
    return { valid: false, errorCode: PHASE_ERRORS.INVALID_EVENT_DECK };
  }
  return validatePhaseEventDeckSelection(user, eventDeckId, req.eventDeckData)
    ? { valid: true, errorCode: PHASE_ERRORS.OK }
    : { valid: false, errorCode: PHASE_ERRORS.INVALID_EVENT_DECK };
}

function validatePhaseEventDeckSelection(user, eventDeckId, selection) {
  if (!user || !selection || typeof selection !== "object") return false;
  const army = user.army && typeof user.army === "object" ? user.army : {};
  const ownedUnits = army.units && typeof army.units === "object" ? army.units : {};
  const ownedShips = army.ships && typeof army.ships === "object" ? army.ships : {};
  const ownedOperators = army.operators && typeof army.operators === "object" ? army.operators : {};
  const slotTypes = getEventDeckUnitSlotTypes(eventDeckId);
  const allowedSlots = new Set(getEventDeckPlayerUnitSlots(eventDeckId).map(Number));
  const requiredSlots = slotTypes
    .map((slotType, index) => (allowedSlots.has(index) && slotType !== "ST_GUEST" ? index : -1))
    .filter((index) => index >= 0);
  const selected = Object.entries(selection.units || {}).filter(([, uid]) => toBigInt(uid || 0) > 0n);
  const seen = new Set();
  for (const [slotText, rawUid] of selected) {
    const slot = Number(slotText);
    const uid = toBigInt(rawUid || 0);
    const key = uid.toString();
    if (!allowedSlots.has(slot) || seen.has(key) || !ownedUnits[key]) return false;
    seen.add(key);
  }
  if (requiredSlots.some((slot) => toBigInt(selection.units && selection.units[String(slot)] || 0) <= 0n)) return false;
  const shipUid = toBigInt(selection.shipUid || 0);
  if (eventDeckHasFreeShipSlot(eventDeckId)) {
    if (shipUid <= 0n || !ownedShips[shipUid.toString()]) return false;
  } else if (shipUid > 0n && !ownedShips[shipUid.toString()]) {
    return false;
  }
  const eventDeck = getEventDeckTemplet(eventDeckId) || {};
  const operatorUid = toBigInt(selection.operatorUid || 0);
  const operatorType = String(eventDeck.SLOT_TYPE_OPERATOR || "");
  const operatorRequired = operatorType === "ST_FREE" || operatorType === "ST_FIXED";
  if (operatorRequired && (operatorUid <= 0n || !ownedOperators[operatorUid.toString()])) return false;
  if (!operatorRequired && operatorUid > 0n && !ownedOperators[operatorUid.toString()]) return false;
  const leaderIndex = Number(selection.leaderIndex);
  return Number.isInteger(leaderIndex) && leaderIndex >= -1 && leaderIndex < 8 &&
    (leaderIndex < 0 || toBigInt(selection.units && selection.units[String(leaderIndex)] || 0) > 0n);
}

function serializePhaseEventDeckSelection(selection) {
  if (!selection) return null;
  return {
    shipUid: toBigInt(selection.shipUid || 0).toString(),
    units: Object.fromEntries(
      Object.entries(selection.units || {}).map(([slot, uid]) => [String(Number(slot)), toBigInt(uid || 0).toString()])
    ),
    operatorUid: toBigInt(selection.operatorUid || 0).toString(),
    leaderIndex: Number(selection.leaderIndex == null ? -1 : selection.leaderIndex),
  };
}

function isAvailablePhaseSupport(ctx, user, supportingUserUid) {
  if (supportingUserUid === 0n) return true;
  if (!ctx || !user) return false;
  return getAvailableSupportUsers(ctx, user).some(
    (entry) => toBigInt(entry && entry.user && entry.user.userUid || 0) === supportingUserUid && entry.unit
  );
}

function persistPhaseState(ctx, reason) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  else if (USE_LOCAL_USER_DB) saveUserDb();
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
  else invalidateJoinLobbyAckPayloadCache(reason);
}

function getSavedPhaseModeState(user) {
  const saved = user && user.miscStages && user.miscStages.phase;
  if (!saved || typeof saved !== "object") return null;
  const stage = getGenericStageForRequest({ stageID: positiveInt(saved.stageId) });
  if (!stage || Number(stage.gameType || 0) !== NGT_PHASE || positiveInt(saved.phaseId) !== positiveInt(stage.phaseId)) return null;
  const phase = loadMiscStageCatalog().phaseById.get(positiveInt(stage.phaseId));
  const phaseIndex = Math.max(0, Number(saved.phaseIndex || 0) || 0);
  const order = choosePhaseOrder(phase, phaseIndex);
  const dungeon = order && order.m_DungeonStrID ? getDungeonTableEntryByStrId(order.m_DungeonStrID) : null;
  const dungeonId = positiveInt(dungeon && dungeon.m_DungeonID);
  if (!dungeonId || dungeonId !== positiveInt(saved.dungeonId)) return null;
  return {
    ...saved,
    stageId: positiveInt(saved.stageId),
    phaseId: positiveInt(saved.phaseId),
    phaseIndex,
    dungeonId,
    totalPlayTime: Math.max(0, Number(saved.totalPlayTime || 0) || 0),
    supportingUserUid: toBigInt(saved.supportingUserUid || 0),
  };
}

function preparePhaseGameLoad(user, req = {}, stage = null) {
  if (!stage || Number(stage.gameType || 0) !== NGT_PHASE) return null;
  const saved = getSavedPhaseModeState(user);
  if (
    !saved ||
    positiveInt(req.stageID) !== saved.stageId ||
    positiveInt(req.dungeonID) !== saved.dungeonId ||
    toBigInt(req.supportingUserUid || 0) !== saved.supportingUserUid
  ) {
    return { valid: false, errorCode: PHASE_ERRORS.INVALID_REQUEST };
  }
  const nextReq = {
    ...req,
    selectDeckIndex: Number(saved.deckIndex && saved.deckIndex.index || 0),
    supportingUserUid: saved.supportingUserUid,
    eventDeckData: saved.eventDeckData || null,
  };
  const resolvedStage = getGenericStageForRequest({ stageID: saved.stageId, dungeonID: saved.dungeonId });
  if (!resolvedStage || Number(resolvedStage.gameType || 0) !== NGT_PHASE) {
    return { valid: false, errorCode: PHASE_ERRORS.INVALID_REQUEST };
  }
  const nextStage = { ...resolvedStage, phaseIndex: saved.phaseIndex, phaseId: saved.phaseId };
  const validation = validatePhaseDeckSelection(user, nextStage, {
    deckIndex: saved.deckIndex || { deckType: 0, index: 0 },
    eventDeckData: saved.eventDeckData || null,
  });
  return validation.valid
    ? { valid: true, errorCode: 0, req: nextReq, stage: nextStage, deckValidation: saved.eventDeckData ? null : validation }
    : { valid: false, errorCode: validation.errorCode };
}

function recordPhaseBattleResult(replay, user, options = {}) {
  const stageId = positiveInt(options.stageId);
  const dungeonId = positiveInt(options.dungeonId);
  const battleKey = `${String(replay && replay.dynamicGame && (replay.dynamicGame.gameUID || replay.dynamicGame.gameUid) || 0)}:${dungeonId}`;
  if (replay && replay.phaseBattleResult && replay.phaseBattleResult.battleKey === battleKey) {
    return replay.phaseBattleResult;
  }
  const saved = getSavedPhaseModeState(user);
  if (!saved || saved.stageId !== stageId || saved.dungeonId !== dungeonId) {
    const invalid = { valid: false, changed: false, terminated: false, completed: false, nextState: null, battleKey };
    if (replay && typeof replay === "object") replay.phaseBattleResult = invalid;
    return invalid;
  }

  const phase = loadMiscStageCatalog().phaseById.get(saved.phaseId);
  const playTime = Math.max(0, Number(options.playTime || 0) || 0);
  const totalPlayTime = saved.totalPlayTime + playTime;
  const shipHpDamagePercent = Math.max(
    0,
    Number(saved.shipHpDamagePercent || 0) || 0,
    Number(options.battleState && (options.battleState.shipHpDamagePercent ?? options.battleState.ShipHpDamagePercent) || 0) || 0
  );
  const win = options.win === true && options.giveup !== true;
  const state = ensureMiscStageState(user);
  const nextOrder = win ? choosePhaseOrder(phase, saved.phaseIndex + 1) : null;
  const nextDungeon = nextOrder && nextOrder.m_DungeonStrID ? getDungeonTableEntryByStrId(nextOrder.m_DungeonStrID) : null;
  const nextDungeonId = positiveInt(nextDungeon && nextDungeon.m_DungeonID);
  let nextState = null;
  let clearData = null;
  let loot = null;
  let completed = false;

  if (win && nextDungeonId) {
    state.phase = {
      ...saved,
      supportingUserUid: saved.supportingUserUid.toString(),
      phaseIndex: saved.phaseIndex + 1,
      dungeonId: nextDungeonId,
      totalPlayTime,
      shipHpDamagePercent,
    };
    nextState = {
      ...state.phase,
      supportingUserUid: saved.supportingUserUid,
    };
  } else {
    delete state.phase;
    if (win) {
      completed = true;
      user.phaseClearData = user.phaseClearData && typeof user.phaseClearData === "object" ? user.phaseClearData : {};
      const previous = user.phaseClearData[String(stageId)] && typeof user.phaseClearData[String(stageId)] === "object"
        ? user.phaseClearData[String(stageId)]
        : {};
      const aggregateState = {
        ...(options.battleState || {}),
        gameTime: totalPlayTime,
        GameTime: totalPlayTime,
        totalPlayTime,
        TotalPlayTime: totalPlayTime,
        shipHpDamagePercent,
        ShipHpDamagePercent: shipHpDamagePercent,
      };
      const currentMissionResult1 = evaluateDungeonMission(
        phase && phase.m_DGMissionType_1,
        phase && phase.m_DGMissionValue_1,
        aggregateState,
        true
      );
      const currentMissionResult2 = evaluateDungeonMission(
        phase && phase.m_DGMissionType_2,
        phase && phase.m_DGMissionValue_2,
        aggregateState,
        true
      );
      clearData = {
        stageId,
        missionResult1: previous.missionResult1 === true || currentMissionResult1,
        missionResult2: previous.missionResult2 === true || currentMissionResult2,
        missionRewardResult: previous.missionRewardResult === true,
        onetimeRewardResults: Array.from({ length: 3 }, (_, index) =>
          Boolean(Array.isArray(previous.onetimeRewardResults) && previous.onetimeRewardResults[index])
        ),
      };
      loot = grantPhaseClearLoot(replay, user, phase, stageId, clearData, previous);
      clearData.missionRewardResult = loot.missionRewardResult;
      clearData.onetimeRewardResults = loot.onetimeRewardResults;
      user.phaseClearData[String(stageId)] = {
        ...clearData,
        completedAt: previous.completedAt || new Date().toISOString(),
        lastCompletedAt: new Date().toISOString(),
        bestClearTimeSec: previous.bestClearTimeSec > 0
          ? Math.min(Number(previous.bestClearTimeSec), totalPlayTime)
          : totalPlayTime,
      };
    }
  }

  const result = {
    valid: true,
    changed: true,
    terminated: !nextState,
    completed,
    nextState,
    clearData,
    loot,
    stageId,
    dungeonId,
    totalPlayTime,
    battleKey,
  };
  if (replay && typeof replay === "object") replay.phaseBattleResult = result;
  return result;
}

function grantPhaseClearLoot(replay, user, phase, stageId, clearData, previous = {}) {
  const reward = createEmptyReward();
  const missionReward = createEmptyReward();
  const oneTimeRewards = createEmptyReward();
  const ctx = { dateTimeBinaryNow };
  const regDate = dateTimeBinaryNow();
  const phaseId = positiveInt(phase && phase.m_PhaseID);
  const firstClear = !positiveInt(previous && previous.stageId);
  const credit = pickDungeonRewardQuantity(
    user,
    `phase-credit:${phaseId}`,
    phase && phase.m_RewardCredit_Min,
    phase && phase.m_RewardCredit_Max
  );
  if (credit > 0) {
    mergeReward(
      reward,
      grantRewardByType(ctx, user, "RT_MISC", RESOURCE_ITEM_IDS.CREDIT, credit, credit, 0, { regDate, expandPackages: false })
    );
  }
  if (firstClear) mergeReward(reward, grantStageFirstClearReward(ctx, user, stageId, { regDate }));
  mergeReward(reward, grantStageMainReward(ctx, user, stageId, { regDate }).reward);
  for (let index = 1; index <= 10; index += 1) {
    const groupId = positiveInt(phase && phase[`m_RewardGroupID_${index}`]);
    const chance = Math.max(0, Math.min(10000, Number(phase && phase[`m_fRewardRate_${index}`]) || 0));
    if (!groupId || chance <= 0 || (chance < 10000 && stableStageRewardRoll(user, `phase:${phaseId}:${groupId}`, 10000) >= chance)) continue;
    const record = pickStageRewardRecord(getRewardGroupRecords(groupId), user, groupId);
    if (record) mergeReward(reward, grantRewardRecord(ctx, user, record, { regDate }));
  }

  const stage = getStageTableEntry(stageId) || {};
  let missionRewardResult = previous.missionRewardResult === true;
  if (!missionRewardResult && clearData.missionResult1 && clearData.missionResult2) {
    const rewardType = String(stage.m_allStarRewardType || "");
    const rewardId = positiveInt(stage.m_allStarRewardID);
    const count = Math.max(0, Number(stage.m_allStarRewardValue || 0) || 0);
    if (rewardType && rewardType !== "RT_NONE" && rewardId && count > 0) {
      mergeReward(missionReward, grantRewardByType(ctx, user, rewardType, rewardId, count, count, 0, { regDate, expandPackages: false }));
    }
    missionRewardResult = true;
  }

  const onetimeRewardResults = clearData.onetimeRewardResults.slice(0, 3);
  while (onetimeRewardResults.length < 3) onetimeRewardResults.push(false);
  for (let index = 1; index <= 3; index += 1) {
    if (onetimeRewardResults[index - 1]) continue;
    const rewardType = String(stage[`m_OneTimeRewardType_${index}`] || "");
    const rewardId = positiveInt(stage[`m_OneTimeRewardId_${index}`]);
    const count = Math.max(0, Number(stage[`m_OneTimeRewardCount_${index}`] || 0) || 0);
    const chance = Math.max(0, Math.min(10000, Number(stage[`m_OneTimeRewardProbability_${index}`] || 0) || 0));
    if (!rewardType || rewardType === "RT_NONE" || !rewardId || count <= 0 || chance <= 0) continue;
    if (chance < 10000 && stableStageRewardRoll(user, `phase-onetime:${stageId}:${index}`, 10000) >= chance) continue;
    mergeReward(oneTimeRewards, grantRewardByType(ctx, user, rewardType, rewardId, count, count, 0, { regDate, expandPackages: false }));
    onetimeRewardResults[index - 1] = true;
  }

  const unitExp = Math.max(0, Number(phase && phase.m_RewardUnitEXP) || 0);
  const userExp = Math.max(0, Number(phase && phase.m_RewardUserEXP) || 0);
  reward.userExp = userExp;
  const combatExp = applyCombatExpToLocalRoster(user, replay, unitExp);
  if (combatExp.unitExpDataList.length) reward.unitExpDataList = combatExp.unitExpDataList;
  return {
    reward,
    missionReward: hasRewardPayload(missionReward) ? missionReward : null,
    oneTimeRewards: hasRewardPayload(oneTimeRewards) ? oneTimeRewards : null,
    missionRewardResult,
    onetimeRewardResults,
    userExp,
    unitExp,
  };
}

function buildPhaseModeState(stageId, phaseIndex, dungeonId, totalPlayTime, supportingUserUid) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(stageId)),
    writeSignedVarInt(Math.max(0, Number(phaseIndex || 0) || 0)),
    writeSignedVarInt(positiveInt(dungeonId)),
    writeFloatLE(Number(totalPlayTime || 0)),
    writeSignedVarLong(toBigInt(supportingUserUid || 0)),
  ]);
}

function buildTrimStartAckPayload(req = {}, user = null) {
  const trimId = positiveInt(req.trimId || req.TrimID);
  const trimLevel = Math.max(1, positiveInt(req.trimLevel || req.TrimLevel) || 1);
  const stage = getGenericStageForRequest({ trimId, trimLevel });
  const state = ensureMiscStageState(user);
  if (state && trimId) {
    state.trim = state.trim && typeof state.trim === "object" ? state.trim : {};
    state.trim.current = {
      trimId,
      trimLevel,
      nextDungeonId: positiveInt(stage && stage.dungeonID),
    };
    if (USE_LOCAL_USER_DB) saveUserDb();
  }
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildTrimModeState(stage || { trimId, trimLevel })),
  ]);
}

function buildTrimModeState(stage = {}) {
  const trimId = positiveInt(stage.trimId);
  const trimLevel = Math.max(1, positiveInt(stage.trimLevel) || 1);
  const stageRows = Array.isArray(stage.trimStageList) && stage.trimStageList.length
    ? stage.trimStageList
    : loadMiscStageCatalog().trimDungeonsByTrimId.get(trimId) || [];
  const nextDungeonId = positiveInt(stage.dungeonID) || positiveInt((stageRows[0] || {}).DungeonID);
  return Buffer.concat([
    writeSignedVarInt(trimId),
    writeSignedVarInt(trimLevel),
    writeSignedVarInt(nextDungeonId),
    writeNullableObject(buildTrimStageData(0, 0, 0, false)),
    writeObjectList(
      stageRows.map((row, index) =>
        writeNullableObject(buildTrimStageData(index, positiveInt(row && row.DungeonID), 0, false))
      )
    ),
  ]);
}

function buildTrimStageData(index, dungeonId, score, isWin) {
  return Buffer.concat([
    writeSignedVarInt(Math.max(0, Number(index || 0) || 0)),
    writeSignedVarInt(positiveInt(dungeonId)),
    writeSignedVarInt(Math.max(0, Number(score || 0) || 0)),
    writeBool(Boolean(isWin)),
  ]);
}

function buildFierceDataAckPayload(user = null, req = null) {
  if (req && req.valid === false) {
    return Buffer.concat([
      writeSignedVarInt(FIERCE_ERRORS.INVALID_REQUEST),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeIntList([]),
      writeBool(false),
      writeObjectList([]),
    ]);
  }
  const season = getCurrentFierceSeasonRow();
  const seasonId = getCurrentFierceSeasonId();
  const { fierce: state, season: seasonState } = getFierceSeasonState(user);
  const totalPoint = getFierceSeasonTotalPoint(user, season);
  const bosses = getFierceSeasonBossRows(season).map((row) => {
    const bossId = positiveInt(row && row.FierceBossID);
    const saved =
      seasonState.bosses && seasonState.bosses[String(bossId)]
        ? seasonState.bosses[String(bossId)]
        : state.bosses && state.bosses[String(bossId)]
          ? state.bosses[String(bossId)]
          : {};
    return buildFierceBossData({
      bossId,
      point: Math.max(0, Number(saved.point || 0) || 0),
      rankNumber: Math.max(0, Number(saved.rankNumber || (Number(saved.point || 0) > 0 ? 1 : 0)) || 0),
      rankPercent: Math.max(0, Number(saved.rankPercent || (Number(saved.point || 0) > 0 ? 1 : 0)) || 0),
      isCleared: Boolean(saved.isCleared),
    });
  });
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Math.max(0, Number(seasonState.rankNumber || state.rankNumber || (totalPoint > 0 ? 1 : 0)) || 0)),
    writeSignedVarInt(Math.max(0, Number(seasonState.rankPercent || state.rankPercent || (totalPoint > 0 ? 1 : 0)) || 0)),
    writeIntList(Array.isArray(seasonState.pointRewardHistory) ? seasonState.pointRewardHistory : Array.isArray(state.pointRewardHistory) ? state.pointRewardHistory : []),
    writeBool(Boolean(seasonState.isRankRewardGotten || state.isRankRewardGotten)),
    writeObjectList(bosses.map((boss) => writeNullableObject(boss))),
  ]);
}

function buildFierceSeasonNotPayload(now = getServerNowDate()) {
  return writeSignedVarInt(getCurrentFierceSeasonId(now));
}

function buildFierceBossData(data = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(data.bossId)),
    writeSignedVarInt(Math.max(0, Number(data.point || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(data.rankNumber || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(data.rankPercent || 0) || 0)),
    writeNullObject(),
    writeBool(Boolean(data.isCleared)),
  ]);
}

function validateFiercePenaltySelection(req = {}) {
  if (req.valid === false) return { errorCode: FIERCE_ERRORS.INVALID_REQUEST, penaltyIds: [] };
  const bossId = positiveInt(req.fierceBossId || req.fierceBossID || req.bossId);
  const boss = getFierceSeasonBossRows().find((row) => positiveInt(row && row.FierceBossID) === bossId);
  if (!boss) return { errorCode: FIERCE_ERRORS.INVALID_BOSS_ID, penaltyIds: [] };
  const requested = Array.isArray(req.penaltyIds) ? req.penaltyIds.map(positiveInt) : [];
  if (requested.some((id) => id <= 0)) return { errorCode: FIERCE_ERRORS.PENALTY_TYPE, penaltyIds: [] };
  if (requested.length && boss.UI_HellModeCheck !== true) {
    return { errorCode: FIERCE_ERRORS.PENALTY_BOSS_LEVEL, penaltyIds: [] };
  }
  if (new Set(requested).size !== requested.length) {
    return { errorCode: FIERCE_ERRORS.PENALTY_DUPLICATE_GROUP, penaltyIds: [] };
  }
  const allowedRows = getFiercePenaltyRowsForBoss(bossId);
  const allowedById = new Map(allowedRows.map((row) => [positiveInt(row && row.PenaltyID), row]));
  const selectedGroups = new Set();
  for (const penaltyId of requested) {
    const row = allowedById.get(penaltyId);
    if (!row) return { errorCode: FIERCE_ERRORS.PENALTY_TYPE, penaltyIds: [] };
    const groupId = positiveInt(row.PenaltyGroupID);
    if (!groupId) return { errorCode: FIERCE_ERRORS.PENALTY_BOSS_GROUP, penaltyIds: [] };
    if (selectedGroups.has(groupId)) return { errorCode: FIERCE_ERRORS.PENALTY_DUPLICATE_GROUP, penaltyIds: [] };
    selectedGroups.add(groupId);
  }
  const availableGroups = new Set(allowedRows.map((row) => positiveInt(row && row.PenaltyGroupID)).filter(Boolean));
  if (requested.length > availableGroups.size) return { errorCode: FIERCE_ERRORS.PENALTY_COUNT, penaltyIds: [] };
  return { errorCode: FIERCE_ERRORS.OK, penaltyIds: requested };
}

function sameIntList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function commitFierceMutation(ctx, reason) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  else if (USE_LOCAL_USER_DB) saveUserDb();
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(reason);
  else invalidateJoinLobbyAckPayloadCache(reason);
}

function buildFiercePenaltyAckPayload(req = {}, user = null, ctx = null) {
  const bossId = positiveInt(req.fierceBossId || req.fierceBossID || req.bossId);
  const validation = validateFiercePenaltySelection(req);
  if (validation.errorCode !== FIERCE_ERRORS.OK || !user) {
    return Buffer.concat([
      writeSignedVarInt(validation.errorCode || FIERCE_ERRORS.PROFILE_NOT_EXISTS),
      writeSignedVarInt(bossId),
      writeIntList([]),
    ]);
  }
  const bossState = ensureFierceBossSeasonState(user, bossId);
  if (!bossState) {
    return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INVALID_BOSS_ID), writeSignedVarInt(bossId), writeIntList([])]);
  }
  const previous = uniquePositiveIntList(bossState.penaltyIds);
  const penaltyIds = validation.penaltyIds;
  if (!sameIntList(previous, penaltyIds)) {
    bossState.penaltyIds = penaltyIds;
    bossState.penaltyPoint = Math.max(0, Number(bossState.penaltyPoint || 0) || 0);
    bossState.updatedAt = getServerNowDate().toISOString();
    commitFierceMutation(ctx, "fierce-penalty");
  }
  return Buffer.concat([
    writeSignedVarInt(FIERCE_ERRORS.OK),
    writeSignedVarInt(bossId),
    writeIntList(penaltyIds),
  ]);
}

function buildFierceProfileAckPayload(req = {}, user = null) {
  const requestedUid = toBigInt(req.userUid || 0);
  const target = req.valid === false
    ? null
    : findFierceProfileUser(requestedUid) || (user && toBigInt(user.userUid || 0) === requestedUid ? user : null);
  const errorCode = req.valid === false
    ? FIERCE_ERRORS.INVALID_REQUEST
    : target
      ? FIERCE_ERRORS.OK
      : FIERCE_ERRORS.PROFILE_NOT_EXISTS;
  if (errorCode !== FIERCE_ERRORS.OK) {
    return Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullObject(),
      writeNullObject(),
      writeString(""),
      writeNullObject(),
    ]);
  }
  const profile = buildFierceProfileState(target);
  const identity = getUserProfileIdentity(target);
  return Buffer.concat([
    writeSignedVarInt(FIERCE_ERRORS.OK),
    writeNullableObject(buildCommonProfileData(target, identity.userUid, identity.friendCode, identity.nickname)),
    writeNullableObject(buildGuildSimpleData()),
    writeString(String((target && target.friendIntro) || "")),
    writeNullableObject(buildFierceProfileData(profile, target)),
  ]);
}

function buildFierceProfileState(user = null) {
  const season = getCurrentFierceSeasonRow();
  const rows = getFierceSeasonBossRows(season);
  const firstRow = rows[0] || {};
  let bestRow = firstRow;
  let bestSaved = {};
  let bestPoint = -1;
  for (const row of rows) {
    const saved = getFierceSavedBossState(user, positiveInt(row && row.FierceBossID));
    const point = Math.max(0, Number(saved.point || 0) || 0);
    if (point > bestPoint) {
      bestPoint = point;
      bestRow = row;
      bestSaved = saved;
    }
  }
  const bossId = positiveInt(bestRow && bestRow.FierceBossID);
  const penaltyIds = uniquePositiveIntList(bestSaved.penaltyIds);
  return {
    fierceBossGroupId: positiveInt(bestRow && bestRow.FierceBossGroupID),
    fierceBossId: bossId,
    operationPower: positiveInt(bestRow && bestRow.OperationPower),
    totalPoint: Math.max(0, Number(bestSaved.point || 0) || 0),
    penaltyPoint: Math.max(0, Number(bestSaved.penaltyPoint || 0) || 0),
    penaltyIds,
  };
}

function buildFierceProfileData(profile = {}, user = null) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(profile.fierceBossGroupId)),
    writeSignedVarInt(positiveInt(profile.fierceBossId)),
    writeNullObject(), // profileDeck
    writeSignedVarInt(positiveInt(profile.operationPower)),
    writeSignedVarInt(Math.max(0, Number(profile.totalPoint || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(profile.penaltyPoint || 0) || 0)),
    writeIntList(profile.penaltyIds || []),
    writeObjectList(((user && user.profileEmblems) || []).map((emblem) => writeNullableObject(buildProfileEmblemData(emblem)))),
  ]);
}

function buildFierceRankRewardAckPayload(user = null, req = null, ctx = null) {
  if (req && req.valid === false) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INVALID_REQUEST), writeNullObject()]);
  if (!user) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.PROFILE_NOT_EXISTS), writeNullObject()]);
  const saved = getFierceSeasonState(user);
  const totalPoint = getFierceSeasonTotalPoint(user);
  const alreadyClaimed = Boolean(saved.season.isRankRewardGotten || saved.fierce.isRankRewardGotten);
  if (alreadyClaimed) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.NO_MORE_RANK_REWARD), writeNullObject()]);
  if (totalPoint <= 0) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INSUFFICIENT_RANK_REWARD_CONDITION), writeNullObject()]);
  const row = selectFierceRankRewardRow(user);
  if (!row) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INSUFFICIENT_RANK_REWARD_CONDITION), writeNullObject()]);
  const state = ensureFierceSeasonState(user);
  const reward = grantFierceInlineRewardRow(user, row, "RankReward");
  state.season.isRankRewardGotten = true;
  state.fierce.isRankRewardGotten = true;
  commitFierceMutation(ctx, "fierce-rank-reward");
  return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.OK), writeNullableObject(buildSerializedRewardData(reward))]);
}

function buildFiercePointRewardAckPayload(req = {}, user = null, ctx = null) {
  const rewardId = positiveInt(req.pointRewardId || req.fiercePointRewardId || req.fiercePointRewardID);
  if (req.valid === false) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INVALID_REQUEST), writeNullObject(), writeSignedVarInt(rewardId)]);
  if (!user) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.PROFILE_NOT_EXISTS), writeNullObject(), writeSignedVarInt(rewardId)]);
  const row = getCurrentFiercePointRewardRows().find((entry) => positiveInt(entry && entry.FiercePointRewardID) === rewardId);
  if (!row) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INVALID_POINT_REWARD_ID), writeNullObject(), writeSignedVarInt(rewardId)]);
  const saved = getFierceSeasonState(user);
  const history = uniquePositiveIntList(saved.season.pointRewardHistory || saved.fierce.pointRewardHistory);
  if (history.includes(rewardId)) {
    return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.ALREADY_GOT_REWARD), writeNullObject(), writeSignedVarInt(rewardId)]);
  }
  const totalPoint = getFierceSeasonTotalPoint(user);
  if (totalPoint < Math.max(0, Number(row.Point || 0) || 0)) {
    return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INSUFFICIENT_POINT_REWARD_CONDITION), writeNullObject(), writeSignedVarInt(rewardId)]);
  }
  const state = ensureFierceSeasonState(user);
  const reward = grantFierceInlineRewardRow(user, row, "PointReward");
  history.push(rewardId);
  state.season.pointRewardHistory = uniquePositiveIntList(history);
  state.fierce.pointRewardHistory = uniquePositiveIntList(history);
  commitFierceMutation(ctx, "fierce-point-reward");
  return Buffer.concat([
    writeSignedVarInt(FIERCE_ERRORS.OK),
    writeNullableObject(buildSerializedRewardData(reward)),
    writeSignedVarInt(rewardId),
  ]);
}

function buildFiercePointRewardAllAckPayload(user = null, req = null, ctx = null) {
  if (req && req.valid === false) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INVALID_REQUEST), writeIntList([]), writeNullObject()]);
  if (!user) return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.PROFILE_NOT_EXISTS), writeIntList([]), writeNullObject()]);
  const saved = getFierceSeasonState(user);
  const totalPoint = getFierceSeasonTotalPoint(user);
  const history = uniquePositiveIntList(saved.season.pointRewardHistory || saved.fierce.pointRewardHistory);
  const rows = getCurrentFiercePointRewardRows();
  const eligibleRows = rows.filter((row) => totalPoint >= Math.max(0, Number(row.Point || 0) || 0));
  if (!eligibleRows.length) {
    return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.INSUFFICIENT_POINT_REWARD_CONDITION), writeIntList([]), writeNullObject()]);
  }
  const claimableRows = eligibleRows.filter((row) => !history.includes(positiveInt(row && row.FiercePointRewardID)));
  if (!claimableRows.length) {
    return Buffer.concat([writeSignedVarInt(FIERCE_ERRORS.ALREADY_GOT_REWARD), writeIntList([]), writeNullObject()]);
  }
  const state = ensureFierceSeasonState(user);
  const reward = createEmptyReward();
  const claimedIds = [];
  for (const row of claimableRows) {
    const rewardId = positiveInt(row && row.FiercePointRewardID);
    if (!rewardId) continue;
    mergeReward(reward, grantFierceInlineRewardRow(user, row, "PointReward"));
    history.push(rewardId);
    claimedIds.push(rewardId);
  }
  if (claimedIds.length) {
    state.season.pointRewardHistory = uniquePositiveIntList(history);
    state.fierce.pointRewardHistory = uniquePositiveIntList(history);
    commitFierceMutation(ctx, "fierce-point-reward-all");
  }
  return Buffer.concat([
    writeSignedVarInt(FIERCE_ERRORS.OK),
    writeIntList(claimedIds),
    writeNullableObject(buildSerializedRewardData(reward)),
  ]);
}

function buildLeaderboardFierceListAckPayload(req = {}, user = null) {
  const season = getCurrentFierceSeasonRow();
  if (req.valid === false) {
    return Buffer.concat([
      writeSignedVarInt(FIERCE_ERRORS.INVALID_REQUEST),
      writeNullObject(),
      writeSignedVarInt(0),
      writeSignedVarInt(0),
      writeSignedVarInt(positiveInt(season && season.FierceID)),
      writeObjectList([]),
      writeBool(false),
    ]);
  }
  const entries = getFierceLeaderboardEntries({ user, isAll: Boolean(req.isAll) });
  const rank = getFierceLeaderboardRank(entries, user);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildLeaderBoardFierceData(entries)),
    writeSignedVarInt(rank),
    writeSignedVarInt(rank ? 1 : 0),
    writeSignedVarInt(positiveInt(season && season.FierceID)),
    writeObjectList(buildFierceBossDataListForUser(user, season).map((boss) => writeNullableObject(boss))),
    writeBool(Boolean(req.isAll)),
  ]);
}

function buildLeaderboardFierceBossGroupListAckPayload(req = {}, user = null) {
  const season = getCurrentFierceSeasonRow();
  const groupId = positiveInt(req.fierceBossGroupId || req.fierceBossGroupID);
  const validGroups = getFierceSeasonBossGroupIds(season);
  const errorCode = req.valid === false
    ? FIERCE_ERRORS.INVALID_REQUEST
    : validGroups.includes(groupId)
      ? FIERCE_ERRORS.OK
      : FIERCE_ERRORS.INVALID_LEADERBOARD_BOSS_ID;
  if (errorCode !== FIERCE_ERRORS.OK) {
    return Buffer.concat([
      writeSignedVarInt(errorCode),
      writeNullObject(),
      writeSignedVarInt(0),
      writeSignedVarInt(positiveInt(season && season.FierceID)),
      writeSignedVarInt(groupId),
      writeBool(Boolean(req.isAll)),
    ]);
  }
  const entries = getFierceLeaderboardEntries({ user, isAll: Boolean(req.isAll), fierceBossGroupId: groupId });
  const rank = getFierceLeaderboardRank(entries, user);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildLeaderBoardFierceData(entries)),
    writeSignedVarInt(rank),
    writeSignedVarInt(positiveInt(season && season.FierceID)),
    writeSignedVarInt(groupId),
    writeBool(Boolean(req.isAll)),
  ]);
}

function findFierceProfileUser(userUid) {
  const uid = toBigInt(userUid || 0);
  if (uid <= 0n) return null;
  return userDb.users[String(uid)] || null;
}

function getUserProfileIdentity(user = null) {
  return {
    userUid: toBigInt(user && user.userUid ? user.userUid : 0),
    friendCode: toBigInt(user && user.friendCode ? user.friendCode : 0),
    nickname: String((user && user.nickname) || ""),
  };
}

function getCurrentFiercePointRewardRows() {
  const season = getCurrentFierceSeasonRow();
  return loadMiscStageCatalog().fiercePointRewardsByGroup.get(positiveInt(season && season.PointRewardGroupID)) || [];
}

function getCurrentFierceRankRewardRows() {
  const season = getCurrentFierceSeasonRow();
  return loadMiscStageCatalog().fierceRankRewardsByGroup.get(positiveInt(season && season.RankRewardGroupID)) || [];
}

function selectFierceRankRewardRow(user = null) {
  const totalPoint = getFierceSeasonTotalPoint(user);
  if (totalPoint <= 0) return null;
  const entries = getFierceLeaderboardEntries({ user, isAll: true });
  const rankNumber = getFierceLeaderboardRank(entries, user);
  const rankedCount = Math.max(1, entries.filter((entry) => Number(entry && entry.point || 0) > 0).length);
  const rankPercent = rankNumber > 0 ? Math.max(1, Math.ceil(rankNumber * 100 / rankedCount)) : 100;
  const rows = getCurrentFierceRankRewardRows();
  return (
    rows.find((row) => row && row.PercentCheck !== true && rankNumber <= Math.max(1, positiveInt(row.RankValue) || 1)) ||
    rows.find((row) => row && row.PercentCheck === true && rankPercent <= Math.max(1, positiveInt(row.RankValue) || 100)) ||
    rows[0] ||
    null
  );
}

function grantFierceInlineRewardRow(user, row, prefix) {
  const reward = createEmptyReward();
  if (!user || !row) return reward;
  const ctx = { dateTimeBinaryNow };
  const regDate = dateTimeBinaryNow();
  for (let index = 1; index <= 8; index += 1) {
    const rewardType = String(row[`${prefix}Type_${index}`] || "");
    const rewardId = positiveInt(row[`${prefix}ID_${index}`]);
    const quantity = Math.max(0, Number(row[`${prefix}Quantity_${index}`] || row[`${prefix}Count_${index}`] || 0) || 0);
    if (!rewardType || rewardType === "RT_NONE" || !rewardId || quantity <= 0) continue;
    mergeReward(
      reward,
      grantRewardByType(ctx, user, rewardType, rewardId, quantity, quantity, 0, {
        regDate,
        expandPackages: false,
      })
    );
  }
  return reward;
}

function buildFierceBossDataListForUser(user = null, seasonRow = null) {
  const { fierce, season } = getFierceSeasonState(user);
  return getFierceSeasonBossRows(seasonRow).map((row) => {
    const bossId = positiveInt(row && row.FierceBossID);
    const saved =
      (season.bosses && season.bosses[String(bossId)]) ||
      (fierce.bosses && fierce.bosses[String(bossId)]) ||
      {};
    const point = Math.max(0, Number(saved.point || 0) || 0);
    return buildFierceBossData({
      bossId,
      point,
      rankNumber: Math.max(0, Number(saved.rankNumber || (point > 0 ? 1 : 0)) || 0),
      rankPercent: Math.max(0, Number(saved.rankPercent || (point > 0 ? 1 : 0)) || 0),
      isCleared: Boolean(saved.isCleared),
    });
  });
}

function getFierceBossGroupPoint(user = null, groupId = 0) {
  const rows = loadMiscStageCatalog().fierceBossesByGroup.get(positiveInt(groupId)) || [];
  let best = 0;
  for (const row of rows) {
    const saved = getFierceSavedBossState(user, positiveInt(row && row.FierceBossID));
    best = Math.max(best, Math.max(0, Number(saved.point || 0) || 0));
  }
  return best;
}

function getFierceLeaderboardEntries(options = {}) {
  const targetUser = options.user || null;
  const isAll = Boolean(options.isAll);
  const groupId = positiveInt(options.fierceBossGroupId);
  const users = Object.values(userDb.users || {}).filter((entry) => entry && typeof entry === "object");
  if (targetUser && !users.some((entry) => String(entry.userUid || "") === String(targetUser.userUid || ""))) users.push(targetUser);
  const entries = users
    .map((entry) => {
      const point = groupId ? getFierceBossGroupPoint(entry, groupId) : getFierceSeasonTotalPoint(entry);
      return { user: entry, point };
    })
    .filter((entry) => entry.point > 0 || (targetUser && String(entry.user.userUid || "") === String(targetUser.userUid || "")))
    .sort((left, right) => right.point - left.point || String(left.user.nickname || "").localeCompare(String(right.user.nickname || "")));
  return isAll ? entries : entries.slice(0, 50);
}

function getFierceLeaderboardRank(entries = [], user = null) {
  if (!user) return 0;
  const targetUid = String(user.userUid || "");
  const index = entries.findIndex((entry) => String(entry && entry.user && entry.user.userUid || "") === targetUid);
  return index >= 0 && entries[index].point > 0 ? index + 1 : 0;
}

function buildLeaderBoardFierceData(entries = []) {
  return writeObjectList(entries.map((entry) => writeNullableObject(buildLeaderBoardFierceEntry(entry))));
}

function buildLeaderBoardFierceEntry(entry = {}) {
  const user = entry.user || null;
  const identity = getUserProfileIdentity(user);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user, identity.userUid, identity.friendCode, identity.nickname)),
    writeSignedVarLong(BigInt(Math.max(0, Number(entry.point || 0) || 0))),
    writeNullableObject(buildGuildSimpleData()),
  ]);
}

function buildDefenceGameStartAckPayload(socket, req = {}, options = {}) {
  const stage =
    options.stage ||
    getGenericStageForRequest({ defenceTempletId: positiveInt(req.defenceTempletId || req.defenceID || req.defenceId) });
  if (!stage || !stage.dungeonID) {
    return Buffer.concat([writeSignedVarInt(1), writeNullObject(), writeObjectList([])]);
  }
  const loadReq = {
    isDev: false,
    selectDeckIndex: Number(req.selectDeckIndex || 0) || 0,
    stageID: stage.stageId,
    dungeonID: stage.dungeonID,
    eventDeckData: req.eventDeckData || null,
    gameType: stage.gameType,
    rewardMultiply: 1,
  };
  const result = buildDynamicGameLoadPayload(socket, loadReq, stage);
  const gameData = extractNullableGameDataFromGameLoadAckPayload(result && result.payload);
  return Buffer.concat([writeSignedVarInt(0), gameData, writeObjectList([])]);
}

function buildExploreInfoAckPayload(req = {}, user = null) {
  const templetId = positiveInt(req.templetId || req.exploreID || req.exploreId) || firstExploreId();
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildExploreData(templetId, 1)),
    writeIntList([]),
    writeVarInt(0),
    writeSignedVarInt(0),
  ]);
}

function buildExploreEnterAckPayload(req = {}, user = null) {
  const templetId = positiveInt(req.templetId || req.exploreID || req.exploreId) || firstExploreId();
  const explore = loadMiscStageCatalog().exploreById.get(templetId) || {};
  const zoneId = positiveInt(explore.ZONE_ID_1) || firstExploreZoneId();
  const state = ensureMiscStageState(user);
  if (state && templetId) {
    state.explore = {
      templetId,
      currentZone: zoneId,
      currentStep: 0,
      currentSlotIndex: 0,
      state: 20,
    };
    if (USE_LOCAL_USER_DB) saveUserDb();
  }
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildExploreData(templetId, 20, { currentZone: zoneId, currentStep: 0, currentSlotIndex: 0 })),
    writeNullableObject(buildExploreZoneData(zoneId)),
    writeNullObject(),
    writeNullObject(),
  ]);
}

function firstExploreId() {
  const first = Array.from(loadMiscStageCatalog().exploreById.keys()).sort((left, right) => left - right)[0];
  return positiveInt(first) || 1;
}

function firstExploreZoneId() {
  const first = Array.from(loadMiscStageCatalog().exploreZoneById.keys()).sort((left, right) => left - right)[0];
  return positiveInt(first) || 1;
}

function buildExploreData(templetId, stateValue = 1, options = {}) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(templetId)),
    writeFloatLE(100),
    writeFloatLE(100),
    writeSignedVarLong(0n),
    writeSignedVarLong(0n),
    writeSignedVarInt(options.currentZone == null ? -1 : Number(options.currentZone)),
    writeSignedVarInt(options.currentStep == null ? -1 : Number(options.currentStep)),
    writeSignedVarInt(options.currentSlotIndex == null ? -1 : Number(options.currentSlotIndex)),
    writeIntList([]),
    writeObjectList([]),
    writeSignedVarInt(0),
    writeNullableObject(buildExploreSelectableItem(0, 0)),
    writeIntList([]),
    writeSignedVarInt(Number(stateValue || 0)),
    writeSignedVarInt(0),
    writeSignedVarLong(0n),
  ]);
}

function buildExploreSelectableItem(id, value) {
  return Buffer.concat([writeSignedVarInt(Number(id || 0)), writeSignedVarInt(Number(value || 0))]);
}

function buildExploreZoneData(zoneId) {
  const catalog = loadMiscStageCatalog();
  const zone = catalog.exploreZoneById.get(positiveInt(zoneId)) || {};
  const stageCount = Math.max(1, positiveInt(zone.ZoneStageCount) || 1);
  const steps = [];
  for (let index = 1; index <= stageCount; index += 1) {
    const groupId = positiveInt(zone[`StageGroupID_${index}`]);
    const slotCount = Math.max(1, positiveInt(zone[`StageSlotCount_${index}`]) || 1);
    const groupStages = catalog.exploreStagesByGroup.get(groupId) || [];
    steps.push(buildExploreStepData(index - 1, groupStages.slice(0, slotCount)));
  }
  return Buffer.concat([
    writeSignedVarInt(positiveInt(zoneId)),
    writeObjectList(steps.map((step) => writeNullableObject(step))),
  ]);
}

function buildExploreStepData(stepIndex, stageRows) {
  const stages = (Array.isArray(stageRows) ? stageRows : []).map((row, slotIndex) =>
    buildExploreStageData(positiveInt(row && row.StageID), slotIndex, 0, false)
  );
  return Buffer.concat([
    writeSignedVarInt(Math.max(0, Number(stepIndex || 0) || 0)),
    writeObjectList(stages.map((stage) => writeNullableObject(stage))),
  ]);
}

function buildExploreStageData(stageId, slotIndex, pathId, isClear) {
  return Buffer.concat([
    writeSignedVarInt(positiveInt(stageId)),
    writeSignedVarInt(Math.max(0, Number(slotIndex || 0) || 0)),
    writeSignedVarInt(Math.max(0, Number(pathId || 0) || 0)),
    writeBool(Boolean(isClear)),
  ]);
}

function extractNullableGameDataFromGameLoadAckPayload(payload) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  if (!raw.length) return writeNullObject();
  try {
    const errorCode = readSignedVarInt(raw, 0);
    let start = errorCode.offset;
    if (start >= raw.length || raw.readUInt8(start) === 0) return writeNullObject();
    let end = raw.length;
    if (end > start + 1 && raw.readUInt8(end - 1) === 0) end -= 1;
    return raw.subarray(start, end);
  } catch (err) {
    console.log(`[dynamic-game-load] failed to extract NKMGameData from 804 payload: ${summarizeErrorLine(err)}`);
    return writeNullObject();
  }
}

function decodeGameLoadReq(payload) {
  return decodeGameLoadRequest(payload, decryptCopy);
}

function decodeGameRespawnReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const unitUID = readSignedVarLong(decrypted, offset);
    offset = unitUID.offset;
    const assistUnitValue = decrypted.readUInt8(offset);
    if (assistUnitValue !== 0 && assistUnitValue !== 1) return null;
    const assistUnit = assistUnitValue === 1;
    offset += 1;
    const respawnPosX = decrypted.readFloatLE(offset);
    offset += 4;
    const gameTime = decrypted.readFloatLE(offset);
    offset += 4;
    if (offset !== decrypted.length || !Number.isFinite(respawnPosX) || !Number.isFinite(gameTime)) return null;
    return {
      unitUID: unitUID.value.toString(),
      assistUnit,
      respawnPosX,
      gameTime,
      decodedBytes: offset,
    };
  } catch (err) {
    console.log(`[GAME_RESPAWN_REQ] decode failed: ${err.message}`);
    return null;
  }
}

function decodeGameUnitSkillReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    const gameUnitUID = readSignedVarInt(decrypted, 0);
    if (gameUnitUID.offset !== decrypted.length || gameUnitUID.value < -32768 || gameUnitUID.value > 32767) return null;
    return {
      gameUnitUID: gameUnitUID.value,
      decodedBytes: gameUnitUID.offset,
    };
  } catch (err) {
    console.log(`[GAME_USE_UNIT_SKILL_REQ] decode failed: ${err.message}`);
    return null;
  }
}

function decodeGameShipSkillReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const gameUnitUID = readSignedVarInt(decrypted, offset);
    offset = gameUnitUID.offset;
    const shipSkillID = readSignedVarInt(decrypted, offset);
    offset = shipSkillID.offset;
    const skillPosX = decrypted.readFloatLE(offset);
    offset += 4;
    if (offset !== decrypted.length || gameUnitUID.value < -32768 || gameUnitUID.value > 32767 || !Number.isFinite(skillPosX)) {
      return null;
    }
    return {
      gameUnitUID: gameUnitUID.value,
      shipSkillID: shipSkillID.value,
      skillPosX,
      decodedBytes: offset,
    };
  } catch (err) {
    console.log(`[GAME_SHIP_SKILL_REQ] decode failed: ${err.message}`);
    return null;
  }
}

function logGameLoadReq(payload) {
  try {
    const req = decodeGameLoadReq(payload);
    if (!req) throw new Error("decode returned null");
    const eventDeckUnits = req.eventDeckData
      ? Object.entries(req.eventDeckData.units || {})
          .filter(([, uid]) => toBigInt(uid || 0) > 0n)
          .map(([slot, uid]) => `${slot}:${uid}`)
          .join(",")
      : "";
    console.log(
      `[GAME_LOAD_REQ] isDev=${req.isDev ? 1 : 0} deck=${req.selectDeckIndex} stageID=${req.stageID} diveStageID=${
        req.diveStageID
      } dungeonID=${req.dungeonID} palaceID=${req.palaceID} fierceBossId=${req.fierceBossId} exploreID=${
        req.exploreID
      } supportingUserUid=${req.supportingUserUid} eventDeck=${req.hasEventDeckData ? 1 : 0} rewardMultiply=${
        req.rewardMultiply
      }${eventDeckUnits ? ` eventDeckUnits=${eventDeckUnits}` : ""}`
    );
  } catch (err) {
    console.log(`[GAME_LOAD_REQ] decode failed: ${err.message}`);
  }
}

function buildContentsVersionAck(sequence, baseTags = CONTENTS_TAGS, version = CONTENTS_VERSION) {
  const tags = getEffectiveContentsTags(baseTags);
  const payload = Buffer.concat([
    writeSignedVarInt(0),
    writeString(version || CONTENTS_VERSION),
    writeStringList(tags),
    writeInt64LE(dateTimeBinaryNow()),
    writeInt64LE(0n),
  ]);

  console.log(`[CONTENTS_VERSION_ACK event-contents-tags] version=${version || CONTENTS_VERSION} tags=${tags.length}`);
  return buildEncryptedPacket(sequence, CONTENTS_VERSION_ACK, payload);
}

function buildLoginAck(sequence, user) {
  const payload = buildLoginLikePayload(user);
  return buildEncryptedPacket(sequence, LOGIN_ACK, payload);
}

function buildCapturedLoginAck(sequence, user) {
  return buildCapturedLoginLikeAck(sequence, LOGIN_ACK, user, "LOGIN_ACK", () => buildLoginAck(sequence, user));
}

function buildCapturedGamebaseLoginAck(sequence, user) {
  return buildCapturedLoginLikeAck(sequence, GAMEBASE_LOGIN_ACK, user, "GAMEBASE_LOGIN_ACK", () => {
    const payload = Buffer.concat([buildLoginLikePayload(user), writeSignedVarInt(0)]);
    return buildEncryptedPacket(sequence, GAMEBASE_LOGIN_ACK, payload);
  });
}

function buildCapturedReconnectAck(sequence, user) {
  return buildCapturedLoginLikeAck(sequence, RECONNECT_ACK, user, "RECONNECT_ACK", () =>
    buildEncryptedPacket(sequence, RECONNECT_ACK, buildLoginLikePayload(user))
  );
}

function buildCapturedLoginLikeAck(sequence, packetId, user, label, fallbackBuilder) {
  const template =
    packetId === GAMEBASE_LOGIN_ACK && capturedTcpProfiles.gamebaseLoginAck
      ? capturedTcpProfiles.gamebaseLoginAck
      : capturedTcpProfiles.loginAck;
  if (!template) {
    console.log(`[${label} official-template] unavailable; using local fallback`);
    return fallbackBuilder();
  }

  const token =
    nonEmpty(process.env.CS_LOGIN_ACCESS_TOKEN) ||
    nonEmpty(user && user.accessToken) ||
    nonEmpty(lastEffectiveAccessToken) ||
    nonEmpty(lastSteamAccessToken) ||
    nonEmpty(template.accessToken) ||
    "local-access-token";
  lastEffectiveAccessToken = token;
  if (user && token) user.accessToken = token;
  const contentsTag = getEffectiveContentsTags(lastAckContentsTags.length ? lastAckContentsTags : template.contentsTag);
  const openTag = getEffectiveOpenTags(template.openTag);
  const contentsVersion = LOCK_CONTENTS_VERSION
    ? CONTENTS_VERSION
    : lastAckContentsVersion || template.contentsVersion || CONTENTS_VERSION;

  const rawPayload = buildLoginAckRaw({
    errorCode: template.errorCode,
    accessToken: token,
    gameServerIP: GAME_SERVER_IP,
    gameServerPort: GAME_SERVER_PORT,
    contentsVersion,
    contentsTag,
    openTag,
    resultCode: packetId === GAMEBASE_LOGIN_ACK ? template.resultCode || 0 : template.resultCode,
  });

  const compressedPayload = lz4StreamWrapUncompressed(rawPayload);
  console.log(
    `[${label} official-template] version=${contentsVersion} tags=${contentsTag.length} openTags=${openTag.length} tokenLen=${token.length} gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT} payloadSize=${compressedPayload.length}`
  );
  return buildFramedPacket(sequence, packetId, compressedPayload, true);
}

function buildLoginAckRaw(fields) {
  const parts = [
    writeSignedVarInt(fields.errorCode || 0),
    writeString(fields.accessToken || ""),
    writeString(fields.gameServerIP || ""),
    writeSignedVarInt(fields.gameServerPort || 0),
    writeString(fields.contentsVersion || ""),
    writeStringList(fields.contentsTag || []),
    writeStringList(fields.openTag || []),
  ];
  if (fields.resultCode != null) parts.push(writeSignedVarInt(fields.resultCode || 0));
  return Buffer.concat(parts);
}

function buildLoginLikePayload(user) {
  const token =
    nonEmpty(process.env.CS_LOGIN_ACCESS_TOKEN) ||
    nonEmpty(user && user.accessToken) ||
    nonEmpty(lastEffectiveAccessToken) ||
    nonEmpty(lastSteamAccessToken) ||
    "local-access-token";
  lastEffectiveAccessToken = token;
  if (user && token) user.accessToken = token;

  const version = LOCK_CONTENTS_VERSION
    ? CONTENTS_VERSION
    : (user && user.contentsVersion) || lastAckContentsVersion || CONTENTS_VERSION;
  const baseTags = lastAckContentsTags.length
    ? lastAckContentsTags
    : user && user.contentsTags && user.contentsTags.length
      ? user.contentsTags
      : CONTENTS_TAGS;
  const tags = getEffectiveContentsTags(baseTags);
  const openTags = getEffectiveOpenTags(user && user.openTags ? user.openTags : OPEN_TAGS);

  console.log(
    `[LOGIN-like payload] uid=${user ? user.userUid : "(none)"} tokenLen=${token.length} gameServer=${GAME_SERVER_IP}:${GAME_SERVER_PORT} version=${version} tags=${tags.length} openTags=${openTags.length}`
  );

  return Buffer.concat([
    writeSignedVarInt(0),
    writeString(token),
    writeString(GAME_SERVER_IP),
    writeSignedVarInt(GAME_SERVER_PORT),
    writeString(version),
    writeStringList(tags),
    writeStringList(openTags),
  ]);
}

function createRuntimeEventManager(manager) {
  return {
    ...manager,
    getSummary(date) {
      return manager.getSummary(date || getServerNowDate());
    },
    getActiveEventState(date) {
      return manager.getActiveEventState(date || getServerNowDate());
    },
    getDiagnostics(date, options) {
      return manager.getDiagnostics(date || getServerNowDate(), options);
    },
    formatDiagnostics(date, options) {
      return manager.formatDiagnostics(date || getServerNowDate(), options);
    },
    selectEntriesForDate(date) {
      return manager.selectEntriesForDate(date || getServerNowDate());
    },
  };
}

function getActiveEventState() {
  return runtimeEventManager.getActiveEventState();
}

function getActiveLoginBackground(state = getActiveEventState()) {
  return loginBackground.resolveLoginBackgroundItem(
    LOGIN_BACKGROUND_CATALOG,
    state,
    LOGIN_BACKGROUND_MODE
  );
}

function getEventContentsTagsForContentsVersion(state = getActiveEventState()) {
  const fierceTags = getCurrentFierceSeasonTags();
  return filterCapturedContentsVersionTags(
    mergeTags(
      EVENT_CONTENTS_TAGS_ENABLED ? state.contentsTags : [],
      EVENT_COUNTER_PASS_CONTENTS_TAGS_ENABLED ? state.counterPassContentsTags : [],
      EVENT_SHOP_CONTENTS_TAGS_ENABLED ? getActiveEventShopTags().contentsTags : [],
      fierceTags.contentsTags
    )
  );
}

function getEffectiveContentsTags(baseTags) {
  const state = getActiveEventState();
  const tags = FROZEN_SOURCE_CONTENTS_VERSION
    ? getFrozenContentsTags(capturedTcpProfiles, CONTENTS_VERSION, CONTENTS_TAGS, REQUIRED_CONTENTS_TAGS)
    : mergeTags(getCapturedContentsVersionTags(), baseTags, REQUIRED_CONTENTS_TAGS, getEventContentsTagsForContentsVersion(state));
  return loginBackground.applyLoginBackgroundTag(tags, getActiveLoginBackground(state));
}

function getCapturedContentsVersionTags() {
  return getCapturedContentsTags(capturedTcpProfiles, LOCK_CONTENTS_VERSION ? CONTENTS_VERSION : "");
}

function getFrozenClientOpenTags() {
  if (!FROZEN_SOURCE_CONTENTS_VERSION) return [];
  return getCapturedOpenTags(capturedTcpProfiles, CONTENTS_VERSION);
}

function filterCapturedContentsVersionTags(tags) {
  const capturedTags = getCapturedContentsVersionTags();
  if (!capturedTags.length) return Array.isArray(tags) ? tags : [];
  const allowed = new Set(
    mergeTags(capturedTags, REQUIRED_CONTENTS_TAGS).map((tag) => String(tag || "").toUpperCase())
  );
  return (Array.isArray(tags) ? tags : []).filter((tag) => allowed.has(String(tag || "").toUpperCase()));
}

function getEffectiveOpenTags(baseTags) {
  const activeEventState = getActiveEventState();
  const openTags = filterInactiveCustomOperatorOpenTags(
    filterSuppressedOpenTags(
      mergeTags(
        baseTags,
        getFrozenClientOpenTags(),
        EXPLICIT_OPEN_TAGS,
        REQUIRED_CORE_OPEN_TAGS,
        REQUIRED_STORY_OPEN_TAGS,
        PRIVATE_PVP_ENABLED ? PRIVATE_PVP_OPEN_TAGS : [],
        activeEventState.openTags,
        EVENT_SHOP_OPEN_TAGS_ENABLED ? getActiveEventShopTags().openTags : [],
        getCurrentFierceSeasonTags().openTags
      )
    ),
    activeEventState.openTags
  );
  return EVENT_SHOP_OPEN_TAGS_ENABLED
    ? filterEventClockShopOpenTags(openTags, runtimeEventManager)
    : openTags;
}

function filterSuppressedOpenTags(tags) {
  return (Array.isArray(tags) ? tags : []).filter((tag) => {
    const key = String(tag || "").toUpperCase();
    return !SUPPRESSED_STORY_OPEN_TAG_SET.has(key) || EXPLICIT_OPEN_TAG_SET.has(key);
  });
}

function filterInactiveCustomOperatorOpenTags(tags, activeOpenTags) {
  const active = new Set((Array.isArray(activeOpenTags) ? activeOpenTags : []).map((tag) => String(tag || "").toUpperCase()));
  return (Array.isArray(tags) ? tags : []).filter((tag) => {
    const key = String(tag || "").toUpperCase();
    if (OBSOLETE_CONTRACT_OPEN_TAG_SET.has(key)) return EXPLICIT_OPEN_TAG_SET.has(key);
    if (!CUSTOM_OPERATOR_OPEN_TAG_SET.has(key)) return true;
    return active.has(key) || EXPLICIT_OPEN_TAG_SET.has(key);
  });
}

function getRequiredContentsTags() {
  if (FROZEN_SOURCE_CONTENTS_VERSION) return getEffectiveContentsTags(CONTENTS_TAGS);
  return mergeTags(getCapturedContentsVersionTags(), REQUIRED_CONTENTS_TAGS, getEventContentsTagsForContentsVersion());
}

function getActiveEventShopTags() {
  try {
    const state = getActiveEventShopState(runtimeEventManager, { includeAllEventShops: false });
    return {
      contentsTags: Array.isArray(state && state.contentsTags) ? state.contentsTags : [],
      openTags: Array.isArray(state && state.openTags) ? state.openTags : [],
      intervalTags: Array.isArray(state && state.intervalTags) ? state.intervalTags : [],
      productIds: Array.isArray(state && state.productIds) ? state.productIds : [],
      priceItemIds: Array.isArray(state && state.priceItemIds) ? state.priceItemIds : [],
      tabCount: Number(state && state.tabCount || 0) || 0,
    };
  } catch (err) {
    console.log(`[event-shop] failed to resolve active tags: ${err.message}`);
    return { contentsTags: [], openTags: [], intervalTags: [], productIds: [], priceItemIds: [], tabCount: 0 };
  }
}

function buildEventIntervalDataList() {
  const state = getActiveEventState();
  return state.enabled ? state.intervalData : [];
}

function buildRequiredIntervalDataList() {
  const startDate = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(2099, 11, 31, 23, 59, 59, 0));
  return REQUIRED_INTERVAL_TAGS.map((strKey, index) =>
    buildIntervalData({
      key: 900000 + index,
      strKey,
      startDate,
      endDate,
      repeatStartDate: 0,
      repeatEndDate: 0,
    })
  );
}

function buildEventShopIntervalDataList(existingKeys = new Set()) {
  const tags = getActiveEventShopTags().intervalTags.filter((tag) => !existingKeys.has(String(tag || "")));
  if (!tags.length) return [];
  const window = getActiveEventShopIntervalWindow();
  return tags.map((strKey, index) =>
    buildIntervalData({
      key: 930000 + index,
      strKey,
      startDate: window.startDate,
      endDate: window.endDate,
      repeatStartDate: 0,
      repeatEndDate: 0,
    })
  );
}

function getActiveEventShopIntervalWindow() {
  const activeState = getActiveEventState();
  const intervals = (Array.isArray(activeState && activeState.intervalData) ? activeState.intervalData : []).filter(
    (interval) => interval && interval.startDate instanceof Date && interval.endDate instanceof Date
  );
  if (intervals.length) {
    return {
      startDate: new Date(Math.min(...intervals.map((interval) => interval.startDate.getTime()))),
      endDate: new Date(Math.max(...intervals.map((interval) => interval.endDate.getTime()))),
    };
  }
  const anchor = getServerNowDate();
  const startDate = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate(), 0, 0, 0, 0));
  const days = Math.max(1, Number(eventManager && eventManager.config && eventManager.config.defaultWindowDays || 28) || 28);
  return {
    startDate,
    endDate: new Date(startDate.getTime() + days * 24 * 60 * 60 * 1000),
  };
}

function buildJoinLobbyIntervalDataList(user) {
  const byStrKey = new Map();
  for (const interval of buildEventIntervalDataList()) {
    const strKey = String((interval && interval.strKey) || "");
    if (!strKey) continue;
    byStrKey.set(strKey, buildIntervalData(interval));
  }
  for (const payload of buildEventShopIntervalDataList(new Set(byStrKey.keys()))) {
    const strKey = readIntervalDataStrKey(payload);
    if (strKey) byStrKey.set(strKey, payload);
  }
  for (const interval of buildFierceSeasonIntervalDataList()) {
    const payload = buildIntervalData(interval);
    const strKey = readIntervalDataStrKey(payload);
    if (strKey) byStrKey.set(strKey, payload);
  }
  for (const payload of buildRequiredIntervalDataList()) {
    const strKey = readIntervalDataStrKey(payload);
    if (strKey) byStrKey.set(strKey, payload);
  }
  const attendanceNow = getServerNowDate();
  for (const payload of buildSerializedAttendanceIntervalDataList(user, { now: attendanceNow, clockNow: attendanceNow })) {
    const strKey = readIntervalDataStrKey(payload) || `__attendance_${byStrKey.size}`;
    byStrKey.set(strKey, payload);
  }
  return Array.from(byStrKey.values());
}

function getActiveEventMissionTabIds() {
  const state = getActiveEventState();
  if (!state || !state.enabled) return [];
  const activeOpenTags = new Set((state.openTags || []).map((tag) => String(tag || "").toUpperCase()));
  const activeIntervals = new Set((state.intervalData || []).map((interval) => String(interval && interval.strKey || "").toUpperCase()));
  if (!activeOpenTags.size && !activeIntervals.size) return [];
  return uniqueMissionTabs(
    getMissionTabTemplets()
      .filter((tab) => {
        const openTag = String(tab && tab.m_OpenTag || "").toUpperCase();
        const dateStrId = String(tab && tab.m_DateStrID || "").toUpperCase();
        if (openTag === "TAG_COMMON_MISSION_EVENT_PASS") return false;
        return (openTag && activeOpenTags.has(openTag)) || (dateStrId && activeIntervals.has(dateStrId));
      })
      .map((tab) => Number(tab && tab.m_TabID) || 0)
  );
}

function getInactiveEventIntervalStrKeys(activeIntervalPayloads = []) {
  if (!eventManager || !eventManager.config || !eventManager.config.enabled) return [];
  if (!eventManager.getKnownIntervalStrKeys) return [];
  const activeKeys = new Set(getIntervalPayloadStrKeys(activeIntervalPayloads).map((key) => key.toUpperCase()));
  return eventManager
    .getKnownIntervalStrKeys()
    .filter((key) => {
      const text = String(key || "");
      return text && !activeKeys.has(text.toUpperCase());
    });
}

function getIntervalPayloadStrKeys(intervalPayloads = []) {
  return (Array.isArray(intervalPayloads) ? intervalPayloads : [])
    .map(readIntervalDataStrKey)
    .filter(Boolean);
}

function isEventMissionIntervalStrKey(strKey) {
  const key = String(strKey || "").trim().toUpperCase();
  return key.startsWith("DATE_") && key.includes("_MISSION_EVENT_");
}

function buildIntervalData(interval) {
  const data = interval || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.key || 0) || 0),
    writeString(data.strKey || ""),
    writeInt64LE(dateTimeBinaryForDate(data.startDate)),
    writeInt64LE(dateTimeBinaryForDate(data.endDate)),
    writeSignedVarInt(Number(data.repeatStartDate || 0) || 0),
    writeSignedVarInt(Number(data.repeatEndDate || 0) || 0),
  ]);
}

function readIntervalDataStrKey(payload) {
  try {
    let offset = readSignedVarInt(payload, 0).offset;
    return readString(payload, offset).value || "";
  } catch (_) {
    return "";
  }
}

function buildMinimalJoinLobbyPayload(user, options = {}) {
  const scrubbedTutorialClears = scrubTutorialEpisodeClearProgress(user);
  if (scrubbedTutorialClears && USE_LOCAL_USER_DB) saveUserDb();
  ensureMainStoryState(user);
  ensureDefaultLineup(user);
  ensureDefaultLineup(user, { deckType: 3, index: 0 });
  const intervalData = buildJoinLobbyIntervalDataList(user);
  const lobbyNow = dateTimeBinaryNow();
  const clockCtx = getServerClockContext();
  const refreshedStamina = stamina.refreshTimedStamina(user, {
    now: lobbyNow,
    initializeMissing: true,
  });
  if (refreshedStamina.changed && USE_LOCAL_USER_DB) saveUserDb();
  const now = writeInt64LE(lobbyNow);
  const lastEterniumSupplyTakeTime = writeInt64LE(
    stamina.getChargeItemLastUpdateDate(user, stamina.ITEM_IDS.ETERNIUM, lobbyNow)
  );
  const pvpPointChargeTime = writeInt64LE(
    stamina.getChargeItemLastUpdateDate(user, stamina.ITEM_IDS.PVP_CHARGE_POINT, lobbyNow)
  );
  const userUid = BigInt(user.userUid || "1000000001");
  const friendCode = BigInt(user.friendCode || "10000001");
  const nickname = user.nickname || "LocalAdmin";
  const miscCount = getMiscItems(user).length;
  const unitCount = getArmyUnits(user).length;
  const shipCount = getArmyShips(user).length;
  const operatorCount = getArmyOperators(user).length;
  const worldMapCityIds = worldMap.getWorldMapCityIds(user, { includeDefaults: true, now: lobbyNow });
  const userData = buildMinimalUserData(user, userUid, friendCode, nickname);
  const stagePlayDataList = buildStagePlayDataList(user);
  const unlockedStageIds = user.unlockedStageIds || [];
  const phaseClearDataList = buildPhaseClearDataList(user);
  const phaseModeState = getSavedPhaseModeState(user);

  console.log(
    `[JOIN_LOBBY_ACK local] uid=${userUid} friendCode=${friendCode} nickname=${JSON.stringify(
      nickname
    )} level=${user.level || 1} reconnectKey=${JSON.stringify(
      user.reconnectKey || ""
    )} inventoryMisc=${miscCount} units=${unitCount} ships=${shipCount} operators=${operatorCount} worldMapCities=${
      worldMapCityIds.join(",") || "-"
    }`
  );
  return Buffer.concat([
    writeSignedVarInt(0), // errorCode
    writeSignedVarLong(friendCode),
    writeNullableObject(userData),
    options.lobbyDataPayload ? writeNullableObject(options.lobbyDataPayload) : writeNullObject(), // lobbyData
    options.gameDataPayload || writeNullObject(), // gameData (payload already includes nullable marker)
    writeNullableObject(buildWarfareGameData()), // warfareGameData
    now, // utcTime
    writeInt64LE(0n), // utcOffset
    now, // lastCreditSupplyTakeTime
    lastEterniumSupplyTakeTime,
    writeDoubleLE(getShopTotalPaidAmount(user)),
    buildShopChainTabNextResetListPayload(clockCtx), // shopChainTabNestResetList
    writeNullableObject(buildPvpBanResultData()), // pvpBanResult
    writeNullableObject(pvpRank.buildPvpStateData(pvpRank.getAsyncPvpState(user))), // asyncPvpState
    writeNullableObject(pvpRank.buildPvpStateData(leaguePvp.getLeaguePvpState(user))), // leaguePvpState
    pvpPointChargeTime,
    writeBool(pvpRank.isRankPvpOpen(user)), // rankPvpOpen
    writeBool(leaguePvp.hasLeaguePvpState(user)), // leaguePvpOpen
    writeObjectList([]), // ReturningUserStates
    writeObjectList(getAllContractStates(user, clockCtx).map((state) => writeNullableObject(buildSerializedContractStateData(state)))), // contractState
    writeObjectList(getAllContractBonusStates(user, clockCtx).map((state) => writeNullableObject(buildSerializedContractBonusStateData(state)))), // contractBonusState
    writeNullableObject(buildSelectableContractStateData(user, clockCtx)), // selectableContractState
    writeObjectList(stagePlayDataList), // stagePlayDataList
    writeNullableObject(buildEventInfoData(user)), // eventInfo
    writeString(user.reconnectKey || ""),
    writeNullableObject(buildZlongUserData()), // zlongUserData
    writeNullableObject(buildBackgroundInfoData(user)), // backGroundInfo
    writeNullableObject(buildGuildPrivateData({ getServerNowDate }, user)), // privateGuildData
    writeInt64LE(getGuildChatMuteEndDate(user)), // blockMuteEndDate
    writeBool(false), // marketReviewCompletion
    writeBool(false), // fierceDailyRewardReceived
    writeNullableObject(guildDungeon.serializeGuildDungeonRewardInfo(
      guildDungeon.buildGuildDungeonRewardInfoData(user, { ctx: { ...clockCtx, userDb } })
    )), // guildDungeonRewardInfo
    writeNullableObject(buildEquipTuningCandidateData(user)), // equipTuningCandidate
    options.leaguePvpRoomDataPayload
      ? writeNullableObject(options.leaguePvpRoomDataPayload)
      : writeNullObject(), // leaguePvpRoomData
    writeObjectList([]), // leaguePvpHistories
    writeObjectList([]), // privatePvpHistories
    writeNullableObject(buildSerializedMyOfficeStateData(user)), // officeState
    writeNullObject(), // kakaoMissionData
    writeIntList(unlockedStageIds),
    writeObjectList(phaseClearDataList), // phaseClearDataList
    phaseModeState
      ? writeNullableObject(
          buildPhaseModeState(
            phaseModeState.stageId,
            phaseModeState.phaseIndex,
            phaseModeState.dungeonId,
            phaseModeState.totalPlayTime,
            phaseModeState.supportingUserUid
          )
        )
      : writeNullObject(), // phaseModeState
    writeObjectList([]), // serverKillCountDataList
    writeObjectList([]), // killCountDataList
    writeObjectList(collection.buildCompletedUnitMissionPayloads(user).map(writeNullableObject)), // completedUnitMissions
    writeObjectList(collection.buildRewardEnableUnitMissionPayloads(user).map(writeNullableObject)), // rewardEnableUnitMissions
    writeNullableObject(draftPvpVotes.buildPvpCastingVoteData(user && user.pvpCastingVoteData)), // pvpCastingVoteData
    writeObjectList(intervalData.map(writeNullableObject)), // intervalData
    writeObjectList(getConsumerPackageList(user).map((data) => writeNullableObject(buildConsumerPackageData(data)))), // consumerPackages
    pvpRank.hasAsyncPvpState(user)
      ? writeNullableObject(pvpRank.buildNpcPvpData(pvpRank.getNpcPvpData(user)))
      : writeNullObject(), // npcPvpData
    writeNullableObject(trim.buildTrimIntervalData(user)), // trimIntervalData
    writeObjectList(trim.buildTrimClearDataList(user).map(writeNullableObject)), // trimClearList
    writeNullableObject(buildShipModuleCandidateData(user)), // shipSlotCandidate
    trim.buildTrimModeState(user)
      ? writeNullableObject(trim.buildTrimModeState(user))
      : writeNullObject(), // trimModeState
    writeBool(false), // enableAccountLink
    writeNullableObject(buildEventCollectionInfoData(user)), // eventCollectionInfo
    writeNullableObject(buildUserProfileData(user, userUid, friendCode, nickname)), // userProfileData
    writeNullableObject(buildShortCutInfoData()), // lastPlayInfo
    writeNullableObject(pvpRank.buildPvpStateData(eventPvp.getEventPvpState(user, eventPvp.getActiveEventPvpSeason(createPacketContext())))), // eventPvpState
    writeObjectList(getAllCustomPickupContracts(user, clockCtx).map((contract) => writeNullableObject(buildSerializedCustomPickupContractData(contract)))), // customPickupContracts
    writeNullableObject(buildPotentialOptionCandidateData(user)), // potentialOptionCandidate
    writeNullableObject(draftPvpVotes.buildPvpCastingVoteData(user && user.pvpDraftVoteData)), // pvpDraftVoteData
    writeNullableObject(buildSupportUnitData(user)), // supportUnitProfileData
    writeBool(eventPass.hasRemainingPassReward(clockCtx, user)), // hasRemainReward
  ]);
}

function buildJoinLobbyAckPayload(user, options = {}) {
  const localPayload = buildMinimalJoinLobbyPayload(user, options);
  const officialPayload = getCapturedServerPayloadTemplate(JOIN_LOBBY_ACK);
  const localIntervalData = buildJoinLobbyIntervalDataList(user);
  const hasGeneratedLobbyIntervals = localIntervalData.length > 0;
  const preserveOfficialContractData = process.env.CS_JOIN_LOBBY_PRESERVE_OFFICIAL_CONTRACTS !== "0";
  const overlayLocalContractData = preserveOfficialContractData && hasLocalContractState(user);
  const activeIntervalStrKeys = getIntervalPayloadStrKeys(localIntervalData);
  const activeEventMissionIntervalStrKeys = activeIntervalStrKeys.filter(isEventMissionIntervalStrKey);
  const eventShopIntervalStrKeys = getActiveEventShopTags().intervalTags;
  const fierceIntervalStrKeys = getFierceSeasonIntervalStrKeys();
  const eventShopMergeIntervalStrKeys =
    process.env.CS_JOIN_LOBBY_MERGE_EVENT_SHOP_INTERVALS !== "0" ? eventShopIntervalStrKeys : [];
  const activeEventState = getActiveEventState();
  const activeEventIntervalStrKeys = (activeEventState.intervalData || [])
    .map((interval) => String(interval && interval.strKey || ""))
    .filter(Boolean);
  const explicitMergeIntervalStrKeys = mergeTags(
    eventShopMergeIntervalStrKeys,
    fierceIntervalStrKeys,
    activeEventMissionIntervalStrKeys,
    activeEventIntervalStrKeys
  );
  const mergeExplicitIntervalsIntoOfficial = preserveOfficialContractData && explicitMergeIntervalStrKeys.length > 0;
  const inactiveEventIntervalStrKeys = getInactiveEventIntervalStrKeys(localIntervalData);
  if (officialPayload && Buffer.isBuffer(officialPayload)) {
    const cacheKey = [
      user && user.userUid ? String(user.userUid) : "ephemeral",
      sha1Buffer(officialPayload),
      sha1Buffer(localPayload),
    ].join(":");
    const cached = joinLobbyAckPayloadCache.get(cacheKey);
    if (cached) return cached;

    const merged = combatHandler.mergeJoinLobbyAck
      ? combatHandler.mergeJoinLobbyAck(officialPayload, localPayload, {
          copyIntervalData: hasGeneratedLobbyIntervals && (!preserveOfficialContractData || mergeExplicitIntervalsIntoOfficial),
          replaceIntervalData: false,
          excludeIntervalStrKeys: preserveOfficialContractData ? [] : inactiveEventIntervalStrKeys,
          preserveIntervalStrKeys: activeIntervalStrKeys,
          mergeIntervalStrKeys: preserveOfficialContractData ? explicitMergeIntervalStrKeys : [],
          filterInactiveEventIntervals: eventManager.config.enabled && !preserveOfficialContractData,
          preserveOfficialContractData,
          overlayLocalContractData,
          overlayLocalPvpRankData: pvpRank.hasPvpRankState(user),
          overlayLocalAsyncPvpData: pvpRank.hasAsyncPvpState(user),
          overlayLocalLeaguePvpData: leaguePvp.hasLeaguePvpState(user),
        })
      : { ok: false, error: "combat handler merge unavailable" };
    if (merged.ok && Buffer.isBuffer(merged.payload)) {
      rememberJoinLobbyAckPayload(cacheKey, merged.payload);
      console.log(
        `[JOIN_LOBBY_ACK merge] official=${officialPayload.length} local=${localPayload.length} merged=${merged.payload.length}`
      );
      return merged.payload;
    }

    console.log(
      `[JOIN_LOBBY_ACK merge] failed; using local ACK without captured overlay: ${summarizeErrorLine(
        merged.error
      )}`
    );
    if (isManagedHostUnavailableError(merged.error)) {
      console.log(
        `[JOIN_LOBBY_ACK merge] managed host unavailable; using captured official template fallback official=${officialPayload.length} local=${localPayload.length}`
      );
      rememberJoinLobbyAckPayload(cacheKey, officialPayload);
      return officialPayload;
    }
    const normalized = combatHandler.normalizeJoinLobbyAck
      ? combatHandler.normalizeJoinLobbyAck(localPayload)
      : { ok: false, error: "combat handler normalize unavailable" };
    if (normalized.ok && Buffer.isBuffer(normalized.payload)) {
      rememberJoinLobbyAckPayload(cacheKey, normalized.payload);
      console.log(
        `[JOIN_LOBBY_ACK normalize-after-merge-fail] local=${localPayload.length} normalized=${normalized.payload.length}`
      );
      return normalized.payload;
    }
    console.log(
      `[JOIN_LOBBY_ACK normalize-after-merge-fail] failed; using pure local ACK: ${summarizeErrorLine(
        normalized.error
      )}`
    );
    return localPayload;
  }

  if (!REPLAY_CAPTURED_GAME_FLOW) {
    const cacheKey = [
      user && user.userUid ? String(user.userUid) : "ephemeral",
      "normalized",
      sha1Buffer(localPayload),
    ].join(":");
    const cached = joinLobbyAckPayloadCache.get(cacheKey);
    if (cached) return cached;
    const normalized = combatHandler.normalizeJoinLobbyAck
      ? combatHandler.normalizeJoinLobbyAck(localPayload)
      : { ok: false, error: "combat handler normalize unavailable" };
    if (normalized.ok && Buffer.isBuffer(normalized.payload)) {
      rememberJoinLobbyAckPayload(cacheKey, normalized.payload);
      console.log(
        `[JOIN_LOBBY_ACK normalize] local=${localPayload.length} normalized=${normalized.payload.length}`
      );
      return normalized.payload;
    }
    console.log(
      `[JOIN_LOBBY_ACK normalize] failed; using pure local ACK: ${summarizeErrorLine(
        normalized.error
      )}`
    );
    return localPayload;
  }
  return localPayload;
}

function rememberJoinLobbyAckPayload(cacheKey, payload) {
  if (joinLobbyAckPayloadCache.size >= 16) {
    const oldestKey = joinLobbyAckPayloadCache.keys().next().value;
    if (oldestKey) joinLobbyAckPayloadCache.delete(oldestKey);
  }
  joinLobbyAckPayloadCache.set(cacheKey, payload);
}

function invalidateJoinLobbyAckPayloadCache(reason = "") {
  const joinCount = joinLobbyAckPayloadCache.size;
  const prewarmCount = prewarmedJoinLobbyAckPayloads.size;
  const preparationCount = lobbySessionPreparationCache.size;
  if (joinCount === 0 && prewarmCount === 0 && preparationCount === 0) return;
  joinLobbyAckPayloadCache.clear();
  prewarmedJoinLobbyAckPayloads.clear();
  lobbySessionPreparationCache.clear();
  console.log(
    `[JOIN_LOBBY_ACK cache] cleared payloads=${joinCount} prewarmed=${prewarmCount} preparations=${preparationCount}${
      reason ? ` reason=${reason}` : ""
    }`
  );
}

function sha1Buffer(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex").slice(0, 16);
}

function summarizeErrorLine(error) {
  return String(error || "unknown error")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0] || "unknown error";
}

function isManagedHostUnavailableError(error) {
  const text = String(error || "").toLowerCase();
  return (
    text.includes("c# combat host disabled") ||
    text.includes("missing combat host dll") ||
    text.includes("dotnet build exited") ||
    text.includes("the command could not be loaded") ||
    text.includes("no .net sdks were found") ||
    text.includes("could not be loaded for source https://api.nuget.org")
  );
}

function hasTutorialProgress(user) {
  const tutorial = ensureTutorialState(user) || {};
  const completedMissions =
    user && user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  if (tutorial.completed || Object.values(tutorial.phases || {}).some((phase) => phase && phase.completed)) return true;
  if (completedMissions["999"]) return true;
  return false;
}

function shouldUseLocalJoinLobbyAck(user) {
  if (USE_LOCAL_JOIN_LOBBY_ACK) return true;
  if (LOCAL_JOIN_LOBBY_ACK_MODE === "0" || LOCAL_JOIN_LOBBY_ACK_MODE === "false" || LOCAL_JOIN_LOBBY_ACK_MODE === "off") {
    return false;
  }
  return hasLocalAccountState(user);
}

function hasLocalAccountState(user) {
  if (!user || typeof user !== "object") return false;
  const inventory = user.inventory && typeof user.inventory === "object" ? user.inventory : {};
  const army = user.army && typeof user.army === "object" ? user.army : {};
  const completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const contractStates = user.contractStates && typeof user.contractStates === "object" ? user.contractStates : {};
  const contractBonusStates =
    user.contractBonusStates && typeof user.contractBonusStates === "object" ? user.contractBonusStates : {};
  const customPickupContracts =
    user.customPickupContracts && typeof user.customPickupContracts === "object" ? user.customPickupContracts : {};
  const dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const persistentCutsceneViews =
    user.persistentCutsceneViews && typeof user.persistentCutsceneViews === "object" ? user.persistentCutsceneViews : {};
  const support = user.support && typeof user.support === "object" ? user.support : {};
  if (user.birthDayData || user.birthdayData || user.m_BirthDayData) return true;
  if (Array.isArray(user.unlockedStageIds) && user.unlockedStageIds.length > 0) return true;
  if (user.mainStory && typeof user.mainStory === "object") return true;
  if (user.episode1 && typeof user.episode1 === "object") return true;
  if (inventory.localTouchedAt) return true;
  if (Object.keys(inventory.equips || {}).length > 0) return true;
  if (Array.isArray(inventory.skins) && inventory.skins.length > 0) return true;
  if (Object.keys(army.units || {}).length > 0) return true;
  if (Object.keys(army.ships || {}).length > 0) return true;
  if (Object.keys(army.trophies || {}).length > 0) return true;
  if (Object.keys(army.operators || {}).length > 0) return true;
  if (Object.keys(army.deckSets || {}).length > 0) return true;
  if (Object.keys(completedMissions).length > 0) return true;
  if (hasLocalContractState(user, { contractStates, contractBonusStates, customPickupContracts })) return true;
  if (Object.keys(dungeonClear).length > 0) return true;
  if (Object.keys(stagePlayData).length > 0) return true;
  if (Object.keys(persistentCutsceneViews).length > 0) return true;
  if (Object.keys(support).length > 0) return true;
  if (pvpRank.hasPvpRankState(user) || pvpRank.hasAsyncPvpState(user)) return true;
  if (hasSavedCombatControls(user)) return true;
  if (lobbyCustomization.hasLobbyCustomization(user)) return true;
  if (simulation.hasSimulationState(user)) return true;
  if (stamina.hasStaminaState(user)) return true;
  if (collection.hasCollectionState(user)) return true;
  if (worldMap.hasWorldMapProgress(user)) return true;
  return Boolean(user.nickname && user.nickname !== "LocalAdmin");
}

function hasLocalContractState(user, stores = {}) {
  if (!user || typeof user !== "object") return false;
  const contractStates =
    stores.contractStates || (user.contractStates && typeof user.contractStates === "object" ? user.contractStates : {});
  const contractBonusStates =
    stores.contractBonusStates ||
    (user.contractBonusStates && typeof user.contractBonusStates === "object" ? user.contractBonusStates : {});
  const customPickupContracts =
    stores.customPickupContracts ||
    (user.customPickupContracts && typeof user.customPickupContracts === "object" ? user.customPickupContracts : {});
  const selectable =
    user.selectableContractState && typeof user.selectableContractState === "object" ? user.selectableContractState : {};

  if (Object.keys(contractStates).length > 0) return true;
  if (Object.keys(contractBonusStates).length > 0) return true;
  if (Object.keys(customPickupContracts).length > 0) return true;
  if (Number(selectable.contractId || 0) > 0) return true;
  if (Array.isArray(selectable.unitIdList) && selectable.unitIdList.length > 0) return true;
  if (Number(selectable.unitPoolChangeCount || 0) > 0) return true;
  return selectable.isActive === false;
}

function getCompletedTutorialStageStates(user) {
  const tutorial = ensureTutorialState(user);
  const phases = tutorial && tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  return TUTORIAL_STAGE_CHAIN.map((stage) => {
    const phase = phases[tutorialPhaseKey(stage)] || phases[String(stage.stageId)];
    if (!phase || phase.completed !== true) return null;
    return {
      ...stage,
      dungeonId: stage.dungeonID,
      completed: true,
      completedAt: phase.completedAt || tutorial.completedAt || "",
      bestClearTimeSec: Number(phase.bestClearTimeSec || 0),
      missionResult1: true,
      missionResult2: true,
    };
  }).filter(Boolean);
}

function buildDungeonClearEntries(user) {
  repairDungeonClearDataFromProgress(user);
  const dungeonClear = user && user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  const entries = new Map();
  const addDungeonClearEntry = (dungeonId, options = {}) => {
    const normalizedDungeonId = Number(dungeonId);
    if (!Number.isFinite(normalizedDungeonId) || normalizedDungeonId <= 0) return;
    entries.set(normalizedDungeonId, buildDungeonClearData(normalizedDungeonId, options));
  };
  for (const [key, clear] of Object.entries(dungeonClear)) {
    const dungeonId = Number((clear && clear.dungeonId) || key);
    const stageId = Number(clear && clear.stageId || stageIdForDungeonId(dungeonId) || 0);
    if (shouldSuppressPostTutorialProgressArtifact(user, dungeonId, stageId)) continue;
    const cutsceneOnly = isCutsceneOnlyDungeon(dungeonId, stageId);
    addDungeonClearEntry(dungeonId, {
      stageId,
      missionResult1: cutsceneOnly ? false : !clear || clear.missionResult1 !== false,
      missionResult2: cutsceneOnly ? false : !clear || clear.missionResult2 !== false,
    });
  }
  for (const stage of getCompletedTutorialStageStates(user)) {
    const dungeonId = Number(stage.dungeonID || stage.dungeonId || 0);
    const stageId = Number(stage.stageId || 0);
    const cutsceneOnly = isCutsceneOnlyDungeon(dungeonId, stageId);
    addDungeonClearEntry(dungeonId, {
      stageId,
      missionResult1: cutsceneOnly ? false : stage.missionResult1 !== false,
      missionResult2: cutsceneOnly ? false : stage.missionResult2 !== false,
    });
  }
  for (const stage of getMainStoryCompletedStageStates(user)) {
    const dungeonId = Number(stage.dungeonID || stage.dungeonId || 0);
    const stageId = Number(stage.stageId || 0);
    const cutsceneOnly = isCutsceneOnlyDungeon(dungeonId, stageId);
    addDungeonClearEntry(dungeonId, {
      stageId,
      missionResult1: cutsceneOnly ? false : stage.missionResult1 !== false,
      missionResult2: cutsceneOnly ? false : stage.missionResult2 !== false,
    });
  }
  return Array.from(entries.entries());
}

function buildStagePlayDataList(user) {
  const stagePlayData = user && user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  const entries = new Map();
  for (const [key, data] of Object.entries(stagePlayData)) {
    const stageId = Number((data && data.stageId) || key);
    if (Number.isFinite(stageId) && stageId > 0) {
      entries.set(stageId, writeNullableObject(buildStagePlayData(stageId, data || {})));
    }
  }
  for (const stage of getCompletedTutorialStageStates(user)) {
    const stageId = Number(stage.stageId || 0);
    if (Number.isFinite(stageId) && stageId > 0) {
      entries.set(stageId, writeNullableObject(buildStagePlayData(stageId, { gameTime: Number(stage.bestClearTimeSec || 0) })));
    }
  }
  for (const stage of getMainStoryCompletedStageStates(user)) {
    const stageId = Number(stage.stageId || 0);
    if (Number.isFinite(stageId) && stageId > 0) {
      entries.set(stageId, writeNullableObject(buildStagePlayData(stageId, { gameTime: Number(stage.bestClearTimeSec || 0) })));
    }
  }
  return Array.from(entries.values());
}

function buildPhaseClearDataList(user) {
  const stages = new Map();
  const persisted = user && user.phaseClearData && typeof user.phaseClearData === "object" ? Object.values(user.phaseClearData) : [];
  for (const data of persisted) {
    const stageId = positiveInt(data && data.stageId);
    const stage = stageId ? getGenericStageForRequest({ stageID: stageId }) : null;
    if (stage && Number(stage.gameType || 0) === NGT_PHASE) stages.set(stageId, data);
  }
  for (const data of getMainStoryCompletedStageStates(user)) {
    const stageId = positiveInt(data && data.stageId);
    if (!stageId || stages.has(stageId)) continue;
    const stage = getGenericStageForRequest({ stageID: stageId });
    if (stage && Number(stage.gameType || 0) === NGT_PHASE) stages.set(stageId, data);
  }
  const stagePlayData = user && user.stagePlayData && typeof user.stagePlayData === "object" ? Object.values(user.stagePlayData) : [];
  for (const data of stagePlayData) {
    const stageId = positiveInt(data && data.stageId);
    if (!stageId || stages.has(stageId)) continue;
    const stage = getGenericStageForRequest({ stageID: stageId });
    if (stage && Number(stage.gameType || 0) === NGT_PHASE) {
      stages.set(stageId, {
        stageId,
        missionResult1: true,
        missionResult2: true,
      });
    }
  }
  return Array.from(stages.values())
    .filter((stage) => Number(stage.stageId || 0) > 0)
    .map((stage) =>
      writeNullableObject(
        buildPhaseClearData(stage.stageId, {
          missionResult1: stage.missionResult1 !== false,
          missionResult2: stage.missionResult2 !== false,
          missionRewardResult: stage.missionRewardResult === true,
          onetimeRewardResults: stage.onetimeRewardResults,
        })
      )
    );
}

function buildEpisodeCompleteEntries(user) {
  repairDungeonClearDataFromProgress(user);
  ensureMainStoryState(user);
  const entries = [];
  const episodeKeys = new Map();
  for (const stage of getMainStoryCompletedStageStates(user)) {
    const episodeId = Number(stage.episodeId || 0);
    if (episodeId <= 0) continue;
    const difficulty = normalizeStoryDifficulty(stage.difficulty);
    episodeKeys.set(`${episodeId}:${difficulty}`, { episodeId, difficulty });
  }
  const groups = Array.from(episodeKeys.values()).sort((left, right) => left.episodeId - right.episodeId || left.difficulty - right.difficulty);
  for (const group of groups) {
    const episodeCompleteData = buildMainStoryEpisodeCompleteData(user, group.episodeId, group.difficulty);
    if (episodeCompleteData) entries.push([episodeCompleteKey(group.episodeId, group.difficulty), episodeCompleteData]);
  }
  return entries;
}

function buildRecallHistoryEntries(user) {
  const history = user && user.recallHistory && typeof user.recallHistory === "object" ? user.recallHistory : {};
  return Object.values(history)
    .map((entry) => ({
      unitId: Number(entry && entry.unitId || 0),
      lastUpdateDate: toBigInt(entry && entry.lastUpdateDate || 0),
    }))
    .filter((entry) => Number.isInteger(entry.unitId) && entry.unitId > 0 && entry.lastUpdateDate > 0n)
    .sort((left, right) => left.unitId - right.unitId)
    .map((entry) => [entry.unitId, Buffer.concat([writeSignedVarInt(entry.unitId), writeInt64LE(entry.lastUpdateDate)])]);
}

function buildMinimalUserData(user, userUid, friendCode, nickname) {
  const userLevel = getJoinLobbyUserLevel(user);
  const userLevelExp = Number(user && user.exp ? user.exp : 0) || 0;
  const now = dateTimeBinaryNow();
  const activeDiveGameData = worldMap.buildActiveDiveGameData(user, { now });
  return Buffer.concat([
    writeSignedVarLong(userUid),
    writeSignedVarLong(friendCode),
    writeString(nickname),
    writeSignedVarInt(userLevel),
    writeSignedVarInt(userLevelExp), // level exp
    writeSignedVarInt(1), // NORMAL_USER
    writeNullableObject(Buffer.concat([writeInt64LE(now), writeInt64LE(now), writeInt64LE(0n)])), // NKMUserDateData
    writeNullableObject(buildMinimalInventoryData(user)),
    writeNullableObject(buildMinimalArmyData(user)),
    writeNullableObject(buildMinimalUserOption(user)),
    writeObjectMapInt(buildDungeonClearEntries(user)), // m_dicNKMDungeonClearData
    writeNullableObject(worldMap.buildWorldMapData(user, { now })), // m_WorldmapData
    writeObjectMapInt([]), // m_dicNKMWarfareClearData
    writeNullableObject(buildMinimalShopData(user)),
    writeNullableObject(buildMinimalMissionData(user)),
    writeObjectMapInt(simulation.buildCounterCaseDataEntries(user)), // m_dicNKMCounterCaseData
    writeNullableObject(buildCraftData(user)), // m_CraftData
    writeObjectMapLong(buildEpisodeCompleteEntries(user)), // m_dicEpisodeCompleteData
    writeNullableObject(pvpRank.buildPvpStateData(pvpRank.getPvpRankState(user))), // m_PvpData
    writeNullObject(), // m_SyncPvpHistory
    writeNullableObject(asyncPvp.buildPvpHistoryListData(user)), // m_AsyncPvpHistory
    writeNullObject(), // m_EventPvpHistory
    activeDiveGameData ? writeNullableObject(activeDiveGameData) : writeNullObject(), // m_DiveGameData
    worldMap.buildDiveClearData(user, { now }), // m_DiveClearData
    worldMap.buildDiveHistoryData(user, { now }), // m_DiveHistoryData
    writeNullableObject(buildAttendanceData(user)), // m_AttendanceData
    writeSignedVarInt(0), // UserState
    buildCompanyBuffList(user, { nowTicks: dateTimeTicksNow() }), // m_companyBuffDataList
    writeNullableObject(buildShadowPalaceDataForUser(user)), // m_ShadowPalace
    writeNullableObject(buildBackgroundInfoData(user)), // backGroundInfo
    writeObjectMapInt(buildRecallHistoryEntries(user)), // m_RecallHistoryData
    buildUserBirthDayData(user), // m_BirthDayData
    writeNullableObject(buildJukeboxData(user)), // m_JukeboxData
  ]);
}

function buildMinimalInventoryData(user) {
  const equipEntries = buildInventoryEquipEntries(user);
  return Buffer.concat([
    writeSignedVarInt(getInventoryCapacity(user, INVENTORY_TYPES.EQUIP)), // m_MaxItemEqipCount
    writeObjectMapInt(buildInventoryMiscEntries(user)), // m_ItemMiscData
    writeObjectMapLong(equipEntries), // m_ItemEquipData
    writeIntList(getSkinIds(user)), // m_ItemSkinData
    writeObjectMapInt(collection.buildMiscCollectionEntries(user)), // m_dicMiscCollectionData
  ]);
}

function buildInventoryMiscEntries(user) {
  return getMiscItems(user).map((item) => [item.itemId, buildItemMiscData(item)]);
}

function buildInventoryEquipEntries(user) {
  return getEquipItems(user).map((equip) => [equip.equipUid, buildSerializedEquipItemData(equip)]);
}

function buildItemMiscData(item) {
  return Buffer.concat([
    writeSignedVarInt(Number(item.itemId) || 0),
    writeSignedVarLong(toBigInt(item.countFree || 0)),
    writeSignedVarLong(toBigInt(item.countPaid || 0)),
    writeSignedVarInt(Number(item.bonusRatio || 0)),
    writeInt64LE(toBigInt(item.regDate || 0)),
  ]);
}

function buildMinimalArmyData(user) {
  const units = getArmyUnits(user);
  const ships = getArmyShips(user);
  const trophies = getArmyTrophies(user);
  const operators = getArmyOperators(user);
  return Buffer.concat([
    writeSignedVarInt(getInventoryCapacity(user, INVENTORY_TYPES.UNIT)), // m_MaxUnitCount
    writeSignedVarInt(getInventoryCapacity(user, INVENTORY_TYPES.SHIP)), // m_MaxShipCount
    writeSignedVarInt(getInventoryCapacity(user, INVENTORY_TYPES.OPERATOR)), // m_MaxOperatorCount
    writeSignedVarInt(getInventoryCapacity(user, INVENTORY_TYPES.TROPHY)), // m_MaxTrophyCount
    buildDefaultDeckSetArray(user), // deckSets
    writeObjectMapLong(ships.map((unit) => [unit.unitUid, buildSerializedUnitData(unit)])), // ships
    writeObjectMapLong(units.map((unit) => [unit.unitUid, buildSerializedUnitData(unit)])), // units
    writeObjectMapLong(operators.map((operator) => [operator.uid || operator.operatorUid, buildSerializedOperatorData(operator)])), // operators
    writeObjectMapLong(trophies.map((unit) => [unit.unitUid, buildSerializedUnitData(unit)])), // trophies
    writeIntList(collection.buildIllustratedUnitIds(user)), // m_illustrateUnit
    writeObjectMapInt(collection.buildTeamCollectionEntries(user)), // team collection
  ]);
}

function buildDefaultDeckSetArray(user) {
  const deckSets = getArmyDeckSets(user);
  return writeObjectList(deckSets.map((deckSet) => writeNullableObject(buildDeckSetData(deckSet.deckType, deckSet.decks))));
}

function buildDeckSetData(deckType, decks = []) {
  return Buffer.concat([
    writeSignedVarInt(deckType),
    writeObjectList((Array.isArray(decks) ? decks : []).map((deck) => writeNullableObject(buildSerializedDeckData(deck)))),
  ]);
}

function buildWarfareGameData() {
  return Buffer.concat([
    writeSignedVarInt(0), // NKM_WARFARE_GAME_STATE.NWGS_STOP
    writeSignedVarInt(0), // warfareTempletID
    writeObjectList([]), // warfareTileDataList
    writeNullableObject(buildWarfareTeamData()),
    writeNullableObject(buildWarfareTeamData()),
    writeBool(false), // isTurnA
    writeSignedVarInt(0), // turnCount
    writeSignedVarInt(0), // firstAttackCount
    writeSignedVarInt(0), // battleAllyUid
    writeSignedVarInt(0), // battleMonsterUid
    writeBool(false), // isWinTeamA
    writeSignedVarLong(0n), // expireTimeTick
    writeSignedVarInt(0), // holdCount
    writeSignedVarInt(0), // containerCount
    writeByte(0), // flagshipDeckIndex
    writeByte(0), // alliesKillCount
    writeByte(0), // enemiesKillCount
    writeByte(0), // targetKillCount
    writeByte(0), // assistCount
    writeByte(0), // supplyUseCount
    writeNullableObject(buildWarfareSupporterListData()),
    writeSignedVarInt(0), // rewardMultiply
  ]);
}

function buildWarfareTeamData() {
  return Buffer.concat([writeSignedVarInt(0), writeObjectMapInt([])]);
}

function buildWarfareSupporterListData() {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(null, 0n, 0n, "")),
    writeNullObject(), // deckData
    writeInt64LE(0n), // lastLoginDate
    writeInt64LE(0n), // lastUsedDate
    writeString(""),
    writeNullableObject(buildGuildSimpleData()),
  ]);
}

function buildPvpBanResultData() {
  return Buffer.concat([
    writeObjectMapInt([]), // unitBanList
    writeObjectMapInt([]), // shipBanList
    writeObjectMapInt([]), // operatorBanList
    writeObjectMapInt([]), // unitUpList
    writeObjectMapInt([]), // unitCastingBanList
    writeObjectMapInt([]), // shipCastingBanList
    writeObjectMapInt([]), // operatorCastingBanList
    writeObjectMapInt([]), // unitFinalBanList
    writeObjectMapInt([]), // shipFinalBanList
    writeObjectMapInt([]), // operatorFinalBanList
    writeNullableObject(buildPvpSeasonBanResultData()),
    writeNullableObject(buildPvpBanOptionStateData()),
  ]);
}

function buildPvpSeasonBanResultData() {
  return Buffer.concat([writeIntList([]), writeIntList([]), writeIntList([])]);
}

function buildPvpBanOptionStateData() {
  return Buffer.concat([writeBool(false), writeBool(false), writeBool(false)]);
}

function buildWorldMapData() {
  return Buffer.concat([writeObjectMapInt([]), writeInt64LE(0n)]);
}

function buildCraftData(user) {
  return Buffer.concat([
    writeObjectMapInt(getMoldItems(user).map((mold) => [mold.moldId, buildSerializedMoldItemData(mold)])), // m_dicMoldItem
    writeObjectMapByte(getCraftSlots(user).map((slot) => [slot.index, buildSerializedCraftSlotData(slot)])), // m_dicSlot
  ]);
}

function buildPvpStateData() {
  return Buffer.concat(Array.from({ length: 13 }, () => writeSignedVarInt(0)));
}

function buildAttendanceData(user) {
  const now = getServerNowDate();
  return buildSerializedAttendanceData(user, { now, clockNow: now });
}

function buildShadowPalaceData() {
  return buildShadowPalaceDataForUser(null);
}

function buildShadowPalaceDataForUser(user) {
  const shadow = user && user.miscStages && user.miscStages.shadow && typeof user.miscStages.shadow === "object" ? user.miscStages.shadow : {};
  const palaces = shadow.palaces && typeof shadow.palaces === "object" ? Object.values(shadow.palaces) : [];
  const currentPalaceId = positiveInt(shadow.currentPalaceId);
  const currentStage = currentPalaceId ? getGenericStageForRequest({ palaceID: currentPalaceId }) : null;
  const palaceList = palaces.length
    ? palaces
    : currentPalaceId
      ? [{ palaceId: currentPalaceId, currentDungeonId: positiveInt(currentStage && currentStage.dungeonID), dungeonDataList: [] }]
      : [];
  return Buffer.concat([
    writeSignedVarInt(currentPalaceId), // currentPalaceId
    writeSignedVarInt(Math.max(0, positiveInt(shadow.life))), // life
    writeObjectList(palaceList.map((palace) => writeNullableObject(buildPalaceProgressData(palace)))), // palaceDataList
    writeSignedVarInt(Math.max(1, positiveInt(shadow.rewardMultiply) || 1)), // rewardMultiply
  ]);
}

function buildPalaceProgressData(palace = {}) {
  const dungeonDataList = Array.isArray(palace.dungeonDataList) ? palace.dungeonDataList : [];
  return Buffer.concat([
    writeSignedVarInt(positiveInt(palace.palaceId)),
    writeSignedVarInt(positiveInt(palace.currentDungeonId)),
    writeObjectList(
      dungeonDataList.map((data) =>
        writeNullableObject(
          buildPalaceDungeonData(
            positiveInt(data && data.dungeonId),
            Math.max(0, Number(data && data.recentTime) || 0),
            Math.max(0, Number(data && data.bestTime) || 0)
          )
        )
      )
    ),
  ]);
}

function buildJukeboxData(user) {
  return lobbyCustomization.buildJukeboxData(user);
}

function buildZlongUserData() {
  return writeString("");
}

function buildBackgroundInfoData(user) {
  return lobbyCustomization.buildBackgroundInfoData(user);
}

function buildSelectableContractStateData(user, ctx) {
  return buildSerializedSelectableContractStateData(getSelectableContractState(user));
}

function buildEventInfoData(user) {
  return eventBingo.buildEventInfoData(user, { eventManager: runtimeEventManager });
}

function buildShortCutInfoData() {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0)]);
}

function buildEquipTuningCandidateData(user) {
  const equip = getEquipItems(user).find((item) => item && item.tuningCandidate);
  return buildSerializedEquipTuningCandidateData(equip && equip.tuningCandidate);
}

function buildPotentialOptionCandidateData(user) {
  const equip = getEquipItems(user).find((item) => item && item.potentialCandidate);
  return buildSerializedPotentialOptionCandidateData(equip && equip.potentialCandidate);
}

function buildShipModuleCandidateData(user) {
  return buildSerializedShipModuleCandidateData(user && user.pendingShipModuleCandidate);
}

function buildEventCollectionInfoData(user) {
  return eventCollection.buildEventCollectionInfoData(user, { eventManager: runtimeEventManager });
}

function buildUserProfileData(user, userUid, friendCode, nickname) {
  ensureAccountProgress(user);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user, userUid, friendCode, nickname)),
    writeString(String((user && user.friendIntro) || "")),
    writeNullableObject(buildPvpProfileData()),
    writeNullableObject(buildPvpProfileData()),
    writeNullableObject(buildPvpProfileData()),
    writeNullObject(), // profileDeck
    writeNullObject(), // leagueDeck
    writeNullableObject(buildAsyncDeckData()),
    writeObjectList(((user && user.profileEmblems) || []).map((emblem) => writeNullableObject(buildProfileEmblemData(emblem)))), // emblems
    writeSignedVarInt(Number((user && (user.selfiFrameId || user.frameId)) || 0)),
    writeNullableObject(buildGuildSimpleData()),
    writeBool(Boolean(user && (user.hasOffice || user.office))),
    writeSignedVarInt(0),
  ]);
}

function buildCommonProfileData(user, userUid, friendCode, nickname) {
  ensureAccountProgress(user);
  const mainUnitId = Number(user && user.mainUnitId) || 0;
  return Buffer.concat([
    writeSignedVarLong(userUid || 0n),
    writeSignedVarLong(friendCode || 0n),
    writeString(nickname || ""),
    writeSignedVarInt(getJoinLobbyUserLevel(user)),
    writeSignedVarInt(mainUnitId),
    writeSignedVarInt(Number((user && user.mainUnitSkinId) || 0)),
    writeSignedVarInt(Number((user && (user.frameId || user.selfiFrameId)) || 0)),
    writeSignedVarInt(Number((user && user.mainUnitTacticLevel) || 0)),
    writeSignedVarInt(Number((user && user.titleId) || 0)),
  ]);
}

function buildProfileEmblemData(emblem = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(emblem.id || 0) || 0),
    writeSignedVarLong(toBigInt(emblem.count || 0)),
  ]);
}

function buildPvpProfileData() {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeSignedVarInt(0)]);
}

function buildUserBirthDayData(user) {
  const data = normalizeUserBirthDayData(user && (user.birthDayData || user.birthdayData || user.m_BirthDayData));
  if (!data) return writeNullObject();
  return writeNullableObject(
    Buffer.concat([
      writeNullableObject(buildBirthDayDateData(data.birthDay)),
      writeSignedVarInt(data.years),
    ])
  );
}

function buildBirthDayDateData(birthDay) {
  const data = normalizeBirthDayDate(birthDay);
  return Buffer.concat([writeSignedVarInt(data.month), writeSignedVarInt(data.day)]);
}

function normalizeUserBirthDayData(data) {
  if (!data || typeof data !== "object") return null;
  const birthDay = normalizeBirthDayDate(data.birthDay || data.BirthDay || data);
  return {
    birthDay,
    years: Math.max(0, Number(data.years != null ? data.years : data.Years || 0) || 0),
  };
}

function normalizeBirthDayDate(value) {
  const data = value && typeof value === "object" ? value : {};
  const rawMonth = data.month != null ? data.month : data.Month;
  const rawDay = data.day != null ? data.day : data.Day;
  const month = Math.max(1, Math.min(12, Math.trunc(Number(rawMonth || 1) || 1)));
  const day = Math.max(1, Math.min(getMaxBirthdayDay(month), Math.trunc(Number(rawDay || 1) || 1)));
  return { month, day };
}

function getMaxBirthdayDay(month) {
  if (month === 2) return 29;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function buildAsyncDeckData() {
  return Buffer.concat([
    writeSignedVarInt(0), // short leaderIndex
    writeNullableObject(buildAsyncUnitData()),
    writeObjectList([]),
    writeObjectList([]),
    writeSignedVarInt(0),
    writeNullObject(),
    writeNullableObject(buildAsyncUnitData()),
    writeObjectMapInt([]),
    writeObjectMapInt([]),
  ]);
}

function buildAsyncUnitData() {
  return Buffer.concat([
    writeSignedVarLong(0n),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
    writeIntList([]),
    writeIntList([]),
    writeObjectList([]),
    writeObjectList([]),
    writeSignedVarInt(0),
    writeSignedVarInt(0),
  ]);
}

function buildGuildSimpleData() {
  return Buffer.concat([writeSignedVarLong(0n), writeString(""), writeSignedVarLong(0n)]);
}

function buildSupportUnitData(user) {
  const supportUnit = ensureSupportUnit(user);
  if (supportUnit) return buildPersistedSupportUnitData(user, supportUnit);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeNullableObject(buildAsyncUnitEquipData()),
    writeSignedVarLong(0n),
  ]);
}

function buildAsyncUnitEquipData() {
  return Buffer.concat([writeNullableObject(buildAsyncUnitData()), writeObjectList([])]);
}

function buildMinimalUserOption(user) {
  const controls = getSavedCombatControls(user);
  const gameOptions = require("../packet-handlers/1636-game-option-change-req").getGameOptions(user);
  const options = user && user.options && typeof user.options === "object" ? user.options : {};
  const invitationOption = Number(user && user.pvp && user.pvp.invitationOption);
  return Buffer.concat([
    writeBool(controls.autoRespawnEnabled), // m_bAutoRespawn
    writeSignedVarInt(gameOptions.actionCameraType),
    writeBool(gameOptions.trackCamera),
    writeBool(gameOptions.viewSkillCutIn),
    writeBool(false), // m_bAutoWarfare
    writeBool(true), // m_bAutoWarfareRepair
    writeBool(Boolean(options.playCutscene)),
    writeBool(Boolean(user && user.worldMap && user.worldMap.dive && user.worldMap.dive.isAuto)), // m_bAutoDive
    writeSignedVarInt(controls.gameSpeedType), // speed
    writeSignedVarInt(controls.autoSkillType), // auto skill off (NKM_GAME_AUTO_SKILL_TYPE.NGST_OFF_HYPER)
    writeBool(gameOptions.autoSyncFriendDeck),
    writeSignedVarInt(gameOptions.defaultPvpAutoRespawn),
    writeSignedVarInt(Number.isInteger(invitationOption) && invitationOption >= 0 && invitationOption <= 3 ? invitationOption : 0),
  ]);
}

function buildMinimalShopData(user) {
  const now = dateTimeBinaryNow();
  return Buffer.concat([
    writeObjectMapInt(buildShopPurchaseHistoryEntries(user)), // histories
    writeNullableObject(buildSerializedRandomShopData(user, { now })), // randomShop
    writeObjectMapInt(buildShopSubscriptionEntries(user)), // subscriptions
  ]);
}

function buildShopPurchaseHistoryEntries(user) {
  return getShopPurchaseHistories(user).map((history) => [history.shopId, buildShopPurchaseHistoryData(history)]);
}

function buildShopPurchaseHistoryData(history) {
  return Buffer.concat([
    writeSignedVarInt(Number(history.shopId) || 0),
    writeSignedVarInt(Number(history.purchaseCount) || 0),
    writeSignedVarInt(Number(history.purchaseTotalCount) || 0),
    writeSignedVarLong(toBigInt(history.nextResetDate || 0)),
  ]);
}

function buildMinimalMissionData(user) {
  const repairedTutorialMissions = CLEAR_ALL_MISSIONS_STATUS ? 0 : repairPostTutorialGuideMissionCompletions(user);
  if (repairedTutorialMissions > 0 && USE_LOCAL_USER_DB) saveUserDb();
  let missionEntries = [];
  let refreshEntries = [];
  if (LOBBY_LOCAL_MISSION_DATA) {
    try {
      refreshEntries = getRandomMissionRefreshEntries(user, getMissionClockOptions());
      missionEntries = buildSerializedMissionDataEntries(user, { ...getMissionClockOptions(), fastLobby: true });
    } catch (error) {
      console.log(`[mission] skipped lobby mission data: ${error && error.message ? error.message : error}`);
    }
  }
  return Buffer.concat([
    writeIntIntMap(refreshEntries), // dicRefreshInfo
    writeObjectMapInt(missionEntries), // dicMissions
    writeSignedVarLong(getAchievePoint(user)), // achievePoint
  ]);
}

function buildSerializedMissionDataEntries(user, options = {}) {
  const entries = options.fastLobby
    ? buildFastLobbyMissionDataEntries(user, options)
    : buildAccountMissionDataEntries(user, options);
  return entries.map(([groupId, mission]) => [
    Number(groupId || (mission && mission.groupId) || (mission && mission.missionID) || 0),
    buildMissionData(Number(mission && mission.missionID) || 0, mission),
  ]);
}

function buildFastLobbyMissionDataEntries(user, options = {}) {
  const result = new Map();
  for (const [groupId, mission] of buildPersistedLobbyMissionEntries(user)) {
    result.set(Number(groupId), [Number(groupId), mission]);
  }
  const tabIds = uniqueMissionTabs([
    ...FAST_LOBBY_MISSION_TABS,
    ...getActiveEventMissionTabIds(),
    ...PAYBACK_MISSION_TABS,
    ...getRandomMissionTabIds(),
  ]);
  for (const tabId of tabIds) {
    for (const [groupId, mission] of buildAccountMissionDataEntries(user, { ...options, fastLobby: false, tabId })) {
      result.set(Number(groupId), [Number(groupId), mission]);
    }
  }
  return Array.from(result.values()).sort((a, b) => Number(a[0]) - Number(b[0]));
}

function buildPersistedLobbyMissionEntries(user) {
  const completedMissions =
    user && user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  const result = new Map();
  for (const [key, mission] of Object.entries(completedMissions)) {
    const snapshot = normalizePersistedMissionSnapshot(key, mission);
    if (!snapshot || shouldSkipPersistedLobbyMission(snapshot) || !hasFrozenMissionTemplet(snapshot)) continue;
    const groupId = Number(snapshot.groupId || snapshot.missionID || 0);
    if (!Number.isInteger(groupId) || groupId <= 0) continue;
    const existing = result.get(groupId);
    if (!existing || shouldPreferMissionSnapshot(snapshot, existing)) result.set(groupId, snapshot);
  }
  return Array.from(result.entries());
}

function hasFrozenMissionTemplet(mission) {
  const tabId = Number(mission && mission.tabId || 0);
  return hasFrozenMissionSnapshot(getMissionTempletsByTabId(tabId), mission);
}

function normalizePersistedMissionSnapshot(key, mission) {
  if (!mission || typeof mission !== "object") return null;
  const numericKey = Number(String(key || "").split(":")[0]);
  const missionID = Number(mission.missionID || mission.missionId || mission.id || numericKey || 0);
  const groupId = Number(mission.groupId || mission.group_id || mission.missionGroupId || missionID || 0);
  if (!Number.isInteger(missionID) || missionID <= 0 || !Number.isInteger(groupId) || groupId <= 0) return null;
  const claimed = mission.rewardClaimed === true || mission.isComplete === true || Boolean(mission.claimedAt);
  return {
    ...mission,
    tabId: Number(mission.tabId || 1) || 1,
    groupId,
    missionID,
    times: Math.max(0, Number(mission.times || mission.targetTimes || (claimed ? 1 : 0)) || 0),
    targetTimes: Math.max(1, Number(mission.targetTimes || mission.times || 1) || 1),
    rewardReady: mission.rewardReady === true || claimed,
    isComplete: claimed || mission.isComplete === true,
    rewardClaimed: claimed,
    lastUpdateDate: mission.lastUpdateDate || dateTimeTicksNow(),
  };
}

function shouldSkipPersistedLobbyMission(mission) {
  const tabId = Number(mission && mission.tabId || 0);
  return tabId === 2 || tabId === 3;
}

function shouldPreferMissionSnapshot(candidate, existing) {
  const candidateMissionId = Number(candidate && candidate.missionID || 0);
  const existingMissionId = Number(existing && existing.missionID || 0);
  if (candidateMissionId !== existingMissionId) return candidateMissionId > existingMissionId;
  const candidateClaimed = candidate && candidate.rewardClaimed === true ? 1 : 0;
  const existingClaimed = existing && existing.rewardClaimed === true ? 1 : 0;
  if (candidateClaimed !== existingClaimed) return candidateClaimed > existingClaimed;
  return Number(candidate && candidate.times || 0) > Number(existing && existing.times || 0);
}

function buildMissionData(missionId, mission = {}) {
  const times = Math.max(0, Math.trunc(Number(mission.times || 0) || 0));
  return Buffer.concat([
    writeSignedVarInt(Number(mission.tabId || 1)),
    writeSignedVarInt(missionId),
    writeSignedVarInt(Number(mission.groupId || missionId)),
    writeSignedVarLong(BigInt(times)),
    writeSignedVarLong(coerceDateTimeTicks(mission.lastUpdateDate)),
    writeBool(mission.rewardClaimed === true || mission.isComplete === true || Boolean(mission.claimedAt)),
  ]);
}

function coerceDateTimeTicks(value) {
  try {
    if (value == null || value === "") return dateTimeTicksNow();
    const parsed = BigInt(String(value));
    return parsed > 9000000000000000n ? parsed & 0x3fffffffffffffffn : parsed;
  } catch (_) {
    return dateTimeTicksNow();
  }
}

function dateTimeTicksNow() {
  if (serverTime && typeof serverTime.dateTimeTicksNow === "function") return serverTime.dateTimeTicksNow();
  return dateTimeTicksForDate(getServerNowDate());
}

function getServerNowDate() {
  return serverTime && typeof serverTime.now === "function" ? serverTime.now() : new Date();
}

function getMissionClockOptions() {
  const nowDate = getServerNowDate();
  return {
    now: dateTimeBinaryForDate(nowDate),
    eventDateKey: getServerEventDateKey(nowDate),
  };
}

function getServerClockContext() {
  return {
    eventManager: runtimeEventManager,
    contentsTags: getEffectiveContentsTags(CONTENTS_TAGS),
    dateTimeBinaryNow,
    dateTimeTicksNow,
    getServerNowDate,
    getServerEventDateKey,
    getMissionClockOptions,
  };
}

function getServerEventDateKey(nowDate = getServerNowDate()) {
  if (serverTime && typeof serverTime.eventDateKey === "function") return serverTime.eventDateKey(nowDate);
  return nowDate instanceof Date && !Number.isNaN(nowDate.getTime()) ? nowDate.toISOString().slice(0, 10) : "";
}

function dateTimeTicksForDate(date) {
  const source = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return BigInt(source.getTime()) * 10000n + 621355968000000000n;
}

function dateTimeBinaryForDate(date) {
  return dateTimeTicksForDate(date) | 0x4000000000000000n;
}

function loadUserDb(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      const starterPath = path.join(path.dirname(filePath), "starter-users.json");
      if (!fs.existsSync(starterPath)) return normalizeUserDb({});
      fs.copyFileSync(starterPath, filePath);
    }
    return normalizeUserDb(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    console.log(`[user-db] failed to load ${filePath}: ${err.message}; starting empty`);
    return normalizeUserDb({});
  }
}

function repairUserDbDeckReferences(db) {
  const users = db && db.users && typeof db.users === "object" ? db.users : {};
  let repairedProfiles = 0;
  for (const user of Object.values(users)) {
    const army = user && user.army && typeof user.army === "object" ? user.army : null;
    if (!army || countInvalidDeckReferences(army) === 0) continue;
    ensureArmy(user);
    repairedProfiles += 1;
  }
  return repairedProfiles;
}

function countInvalidDeckReferences(army) {
  const unitUids = uidKeySet(army.units);
  const shipUids = uidKeySet(army.ships);
  const operatorUids = uidKeySet(army.operators);
  let invalid = 0;
  for (const decks of Object.values(army.deckSets || {})) {
    if (!Array.isArray(decks)) continue;
    for (const deck of decks) {
      if (!deck || typeof deck !== "object") continue;
      const seenUnits = new Set();
      for (const uid of Array.isArray(deck.unitUids) ? deck.unitUids : []) {
        const key = uidKey(uid);
        if (key === "0") continue;
        if (!unitUids.has(key) || seenUnits.has(key)) invalid += 1;
        seenUnits.add(key);
      }
      const shipUid = uidKey(deck.shipUid || 0);
      if (shipUid !== "0" && !shipUids.has(shipUid)) invalid += 1;
      const operatorUid = uidKey(deck.operatorUid || 0);
      if (operatorUid !== "0" && !operatorUids.has(operatorUid)) invalid += 1;
    }
  }
  return invalid;
}

function uidKeySet(map) {
  return new Set(
    Object.keys(map && typeof map === "object" ? map : {})
      .map(uidKey)
      .filter((uid) => uid !== "0")
  );
}

function uidKey(value) {
  return String(toBigInt(value || 0));
}

function loadGameplayUnitStats(filePath) {
  const result = { byId: new Map(), byStrId: new Map(), loaded: false };
  try {
    if (!filePath || !fs.existsSync(filePath)) return loadGameplayUnitStatsFromGameplayJsons(result);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const entries = parsed && parsed.byId && typeof parsed.byId === "object" ? Object.values(parsed.byId) : [];
    for (const entry of entries) {
      const stats = extractGameplayUnitStats(entry);
      if (!stats) continue;
      if (stats.unitID != null) result.byId.set(String(stats.unitID), stats);
      if (stats.unitStrID) result.byStrId.set(String(stats.unitStrID), stats);
    }
    result.loaded = result.byId.size > 0 || result.byStrId.size > 0;
  } catch (err) {
    console.log(`[gameplay-jsons] unit stats load failed: ${err.message}`);
  }
  return result.loaded ? result : loadGameplayUnitStatsFromGameplayJsons(result);
}

function loadGameplayUnitStatsFromGameplayJsons(result = { byId: new Map(), byStrId: new Map(), loaded: false }) {
  const unitsByStrId = new Map();
  for (const fileName of [
    "LUA_UNIT_TEMPLET_BASE.json",
    "LUA_UNIT_TEMPLET_BASE2.json",
    "LUA_UNIT_TEMPLET_BASE_SD.json",
    "LUA_UNIT_TEMPLET_BASE_OPR.json",
  ]) {
    for (const record of readGameplayTableRecords("ab_script_unit_data", fileName, { rootDir: ROOT_DIR, logLabel: "gameplay-jsons" })) {
      const unitStrId = String(record && record.m_UnitStrID ? record.m_UnitStrID : "");
      if (unitStrId && !unitsByStrId.has(unitStrId)) unitsByStrId.set(unitStrId, record);
    }
  }

  for (const fileName of [
    "LUA_UNIT_STAT_TEMPLET.json",
    "LUA_UNIT_STAT_TEMPLET2.json",
    "LUA_UNIT_STAT_TEMPLET_SD.json",
    "LUA_UNIT_STAT_TEMPLET_OPR.json",
  ]) {
    for (const statRecord of readGameplayTableRecords("ab_script_unit_data", fileName, { rootDir: ROOT_DIR, logLabel: "gameplay-jsons" })) {
      const unitStrId = String(statRecord && statRecord.m_UnitStrID ? statRecord.m_UnitStrID : "");
      if (!unitStrId || result.byStrId.has(unitStrId)) continue;
      const unitRecord = unitsByStrId.get(unitStrId) || {};
      const stats = extractGameplayUnitStats({ ...unitRecord, _stat: statRecord });
      if (!stats) continue;
      if (stats.unitID != null) result.byId.set(String(stats.unitID), stats);
      if (stats.unitStrID) result.byStrId.set(stats.unitStrID, stats);
    }
  }

  result.loaded = result.byId.size > 0 || result.byStrId.size > 0;
  return result;
}

function extractGameplayUnitStats(entry) {
  if (!entry || typeof entry !== "object") return null;
  const statRoot = entry._stat && entry._stat.m_StatData && entry._stat.m_StatData.m_Stat;
  if (!statRoot || typeof statRoot !== "object") return null;
  const hp = finiteNumber(statRoot.NST_HP);
  const atk = finiteNumber(statRoot.NST_ATK);
  const moveRate = finiteNumber(statRoot.NST_MOVE_SPEED_RATE);
  const attackSpeedRate = finiteNumber(statRoot.NST_ATTACK_SPEED_RATE);
  return {
    unitID: entry.m_UnitID == null ? null : Number(entry.m_UnitID),
    unitStrID: entry.m_UnitStrID || entry._stat.m_UnitStrID || "",
    hp,
    atk,
    damage: atk > 0 ? Math.max(DEFAULT_COMBAT_STATS.damage, Math.round(atk * 0.2)) : DEFAULT_COMBAT_STATS.damage,
    attackRange: DEFAULT_COMBAT_STATS.attackRange,
    moveSpeed: DEFAULT_COMBAT_STATS.moveSpeed * (1 + clamp(moveRate || 0, -0.5, 1.5)),
    attackCooldown: Math.max(0.45, DEFAULT_COMBAT_STATS.attackCooldown / (1 + clamp(attackSpeedRate || 0, -0.5, 1.5))),
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeUserDb(db) {
  db.schemaVersion = 1;
  db.nextUserUid = String(db.nextUserUid || "1000000001");
  db.nextFriendCode = String(db.nextFriendCode || "10000001");
  db.activeUserUid = nonEmpty(db.activeUserUid);
  db.users = db.users && typeof db.users === "object" ? db.users : {};
  db.usersBySteamAccountId = {};
  db.accessTokens = db.accessTokens && typeof db.accessTokens === "object" ? db.accessTokens : {};
  db.reconnectKeys = db.reconnectKeys && typeof db.reconnectKeys === "object" ? db.reconnectKeys : {};

  for (const user of Object.values(db.users)) {
    indexSteamLoginUser(db, user);
    if (user.accessToken) db.accessTokens[user.accessToken] = user.userUid;
    if (user.reconnectKey) db.reconnectKeys[user.reconnectKey] = user.userUid;
  }
  if (db.activeUserUid && !db.users[db.activeUserUid]) db.activeUserUid = "";
  return db;
}

function saveUserDb(options = {}) {
  fs.mkdirSync(path.dirname(USER_DB_PATH), { recursive: true });
  const tmpPath = `${USER_DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(userDb, jsonUserDbReplacer, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, USER_DB_PATH);
  writeActiveUserSelection(ACTIVE_USER_PATH, userDb.activeUserUid);
  if (options.affectsJoinLobby !== false) userDbRevision += 1;
}

function jsonUserDbReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function getOrCreateUserForSteam(loginReq) {
  const steamAccountId = resolveSteamLoginKey(loginReq);
  const activeUser = getActiveUserForLogin();
  if (activeUser) {
    attachSteamLoginIdentity(activeUser, loginReq, steamAccountId);
    activeUser.lastLoginAt = new Date().toISOString();
    return ensureUserDefaults(activeUser);
  }

  const existingUid = findExistingUserUidForSteamLogin(loginReq, steamAccountId);
  if (existingUid && userDb.users[existingUid]) {
    const user = userDb.users[existingUid];
    attachSteamLoginIdentity(user, loginReq, steamAccountId);
    user.lastLoginAt = new Date().toISOString();
    return ensureUserDefaults(user);
  }

  const userUid = userDb.nextUserUid;
  const friendCode = userDb.nextFriendCode;
  userDb.nextUserUid = String(BigInt(userDb.nextUserUid) + 1n);
  userDb.nextFriendCode = String(BigInt(userDb.nextFriendCode) + 1n);

  const user = ensureUserDefaults({
    userUid,
    friendCode,
    steamAccountId,
    steamLoginKey: steamAccountId,
    steamStableId: extractStableSteamId(loginReq),
    steamLoginTicketHash: hashLoginTicket(loginReq.accessToken),
    deviceUid: loginReq.deviceUid || "",
    nickname: process.env.CS_DEFAULT_NICKNAME || "LocalAdmin",
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });
  const bootstrap = ensureOfficialNewAccountDefaults(user, {
    rosterMode: NEW_ACCOUNT_ROSTER_MODE,
    includeTrophies: SEED_NEW_ACCOUNT_TROPHIES,
  });
  ensureUserDefaults(user);
  if (bootstrap.changed) {
    console.log(
      `[user-db] new-account-defaults uid=${userUid} units=${bootstrap.units} ships=${bootstrap.ships} operators=${bootstrap.operators} trophies=${bootstrap.trophies}`
    );
  }

  userDb.users[userUid] = user;
  indexSteamLoginUser(userDb, user);
  return user;
}

function getOrCreateUserForGuest(loginReq) {
  const guestLoginKey = resolveGuestLoginKey(loginReq);
  const activeUser = getActiveUserForLogin();
  if (activeUser) {
    attachGuestLoginIdentity(activeUser, loginReq, guestLoginKey);
    activeUser.lastLoginAt = new Date().toISOString();
    return ensureUserDefaults(activeUser);
  }

  const existingUid = findExistingUserUidForGuestLogin(loginReq, guestLoginKey);
  if (existingUid && userDb.users[existingUid]) {
    const user = userDb.users[existingUid];
    attachGuestLoginIdentity(user, loginReq, guestLoginKey);
    user.lastLoginAt = new Date().toISOString();
    return ensureUserDefaults(user);
  }

  const userUid = userDb.nextUserUid;
  const friendCode = userDb.nextFriendCode;
  userDb.nextUserUid = String(BigInt(userDb.nextUserUid) + 1n);
  userDb.nextFriendCode = String(BigInt(userDb.nextFriendCode) + 1n);

  const user = ensureUserDefaults({
    userUid,
    friendCode,
    guestLoginKey,
    loginProvider: "gamebase_guest",
    deviceUid: loginReq && loginReq.deviceUid ? loginReq.deviceUid : "",
    mobileUserId: loginReq && loginReq.userId ? loginReq.userId : "",
    mobileIdpCode: loginReq && loginReq.idpCode ? loginReq.idpCode : "guest",
    nickname: process.env.CS_DEFAULT_NICKNAME || "LocalAdmin",
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });
  const bootstrap = ensureOfficialNewAccountDefaults(user, {
    rosterMode: NEW_ACCOUNT_ROSTER_MODE,
    includeTrophies: SEED_NEW_ACCOUNT_TROPHIES,
  });
  ensureUserDefaults(user);
  if (bootstrap.changed) {
    console.log(
      `[user-db] new-account-defaults uid=${userUid} units=${bootstrap.units} ships=${bootstrap.ships} operators=${bootstrap.operators} trophies=${bootstrap.trophies}`
    );
  }

  userDb.users[userUid] = user;
  return user;
}

function getActiveUserForLogin() {
  return getActiveUser(userDb);
}

function findExistingUserUidForSteamLogin(loginReq, steamAccountId) {
  const keys = [steamAccountId, nonEmpty(loginReq.accountId)];
  for (const key of keys) {
    const userUid = key ? userDb.usersBySteamAccountId[key] : "";
    if (userUid && userDb.users[userUid]) return userUid;
  }

  const stableSteamId = extractStableSteamId(loginReq);
  if (stableSteamId) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.steamStableId === stableSteamId)
    );
    if (user) return user.userUid;
  }

  const deviceUid = nonEmpty(loginReq.deviceUid);
  if (deviceUid) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.deviceUid === deviceUid)
    );
    if (user) return user.userUid;
  }

  return "";
}

function attachSteamLoginIdentity(user, loginReq, steamAccountId) {
  const previousKeys = [user.steamAccountId, user.steamLoginKey].filter(Boolean);
  for (const key of previousKeys) {
    if (userDb.usersBySteamAccountId[key] === user.userUid && key !== steamAccountId) {
      delete userDb.usersBySteamAccountId[key];
    }
  }
  user.steamAccountId = steamAccountId;
  user.steamLoginKey = steamAccountId;
  user.steamStableId = extractStableSteamId(loginReq) || user.steamStableId || "";
  user.steamLoginTicketHash = hashLoginTicket(loginReq.accessToken) || user.steamLoginTicketHash || "";
  user.deviceUid = loginReq.deviceUid || user.deviceUid || "";
  indexSteamLoginUser(userDb, user);
}

function findExistingUserUidForGuestLogin(loginReq, guestLoginKey) {
  const key = nonEmpty(guestLoginKey);
  if (key) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.guestLoginKey === key)
    );
    if (user) return user.userUid;
  }

  const userId = nonEmpty(loginReq && loginReq.userId);
  if (userId) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.mobileUserId === userId)
    );
    if (user) return user.userUid;
  }

  const deviceUid = nonEmpty(loginReq && loginReq.deviceUid);
  if (deviceUid) {
    const user = chooseNewestUser(
      Object.values(userDb.users).filter((entry) => entry && entry.deviceUid === deviceUid)
    );
    if (user) return user.userUid;
  }

  return "";
}

function attachGuestLoginIdentity(user, loginReq, guestLoginKey) {
  user.guestLoginKey = guestLoginKey;
  user.loginProvider = "gamebase_guest";
  user.deviceUid = loginReq && loginReq.deviceUid ? loginReq.deviceUid : user.deviceUid || "";
  user.mobileUserId = loginReq && loginReq.userId ? loginReq.userId : user.mobileUserId || "";
  user.mobileIdpCode = loginReq && loginReq.idpCode ? loginReq.idpCode : user.mobileIdpCode || "guest";
}

function indexSteamLoginUser(db, user) {
  if (!db || !user || !user.userUid) return;
  for (const key of [user.steamAccountId, user.steamLoginKey]) {
    if (key) db.usersBySteamAccountId[key] = user.userUid;
  }
}

function resolveSteamLoginKey(loginReq) {
  const forcedIdentity = nonEmpty(process.env.CS_LOCAL_USER_IDENTITY_KEY || process.env.CS_LOCAL_USER_IDENTITY);
  if (forcedIdentity) return `local:${forcedIdentity}`;

  const stableSteamId = extractStableSteamId(loginReq);
  if (stableSteamId) return `steam:${stableSteamId}`;

  const deviceUid = nonEmpty(loginReq && loginReq.deviceUid);
  if (deviceUid) return `device:${deviceUid}`;

  const accountId = nonEmpty(loginReq && loginReq.accountId);
  if (accountId && accountId.length <= 96) return `account:${accountId}`;
  return accountId ? `ticket:${hashLoginTicket(accountId)}` : "local:default";
}

function resolveGuestLoginKey(loginReq) {
  const forcedIdentity = nonEmpty(process.env.CS_LOCAL_USER_IDENTITY_KEY || process.env.CS_LOCAL_USER_IDENTITY);
  if (forcedIdentity) return `local:${forcedIdentity}`;

  const idpCode = nonEmpty(loginReq && loginReq.idpCode).toLowerCase() || "guest";
  const userId = nonEmpty(loginReq && loginReq.userId);
  if (userId && userId.length <= 128) return `gamebase:${idpCode}:${userId}`;

  const deviceUid = nonEmpty(loginReq && loginReq.deviceUid);
  if (deviceUid) return `gamebase:${idpCode}:device:${deviceUid}`;

  return "gamebase:guest:default";
}

function extractStableSteamId(loginReq) {
  const accountId = nonEmpty(loginReq && loginReq.accountId);
  return /^\d{8,20}$/.test(accountId) ? accountId : "";
}

function hashLoginTicket(value) {
  const text = nonEmpty(value);
  return text ? crypto.createHash("sha1").update(text).digest("hex") : "";
}

function chooseNewestUser(users) {
  const validUsers = (Array.isArray(users) ? users : []).filter((user) => user && user.userUid);
  validUsers.sort((a, b) => compareUserRecency(b, a));
  return validUsers[0] || null;
}

function compareUserRecency(a, b) {
  const timeDelta = userRecencyMs(a) - userRecencyMs(b);
  if (timeDelta !== 0) return timeDelta;
  return Number(BigInt(a.userUid || 0) - BigInt(b.userUid || 0));
}

function userRecencyMs(user) {
  return (
    Date.parse(user.lastLoginAt || "") ||
    Date.parse(user.lastJoinAt || "") ||
    Date.parse(user.createdAt || "") ||
    0
  );
}

function ensureUserDefaults(user) {
  user.level = Number(user.level || 1);
  user.exp = String(user.exp || "0");
  ensureAccountProgress(user);
  user.authLevel = Number(user.authLevel || 1);
  user.contentsVersion = LOCK_CONTENTS_VERSION ? CONTENTS_VERSION : user.contentsVersion || CONTENTS_VERSION;
  user.contentsTags = mergeTags(
    Array.isArray(user.contentsTags) && user.contentsTags.length ? user.contentsTags : CONTENTS_TAGS,
    REQUIRED_CONTENTS_TAGS
  );
  user.openTags = filterSuppressedOpenTags(
    mergeTags(
      Array.isArray(user.openTags) && user.openTags.length ? user.openTags : OPEN_TAGS,
      EXPLICIT_OPEN_TAGS,
      REQUIRED_STORY_OPEN_TAGS,
      PRIVATE_PVP_ENABLED ? PRIVATE_PVP_OPEN_TAGS : []
    )
  );
  user.dungeonClear = user.dungeonClear && typeof user.dungeonClear === "object" ? user.dungeonClear : {};
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  user.stagePlayData = user.stagePlayData && typeof user.stagePlayData === "object" ? user.stagePlayData : {};
  ensureStageFavorites(user);
  user.unlockedStageIds = Array.isArray(user.unlockedStageIds) ? user.unlockedStageIds : [];
  ensureInventory(user);
  ensureLocalShopInventory(user);
  ensureArmy(user);
  initializeInventoryCapacities(user);
  ensureDefaultShip(user);
  ensureDefaultLineup(user);
  ensureDefaultLineup(user, { deckType: 3, index: 0 });
  user.tutorial = user.tutorial && typeof user.tutorial === "object"
    ? user.tutorial
    : { enabled: true, firstStageId: 11211, firstDungeonId: 1004 };
  ensureTutorialState(user);
  scrubTutorialEpisodeClearProgress(user);
  ensureMainStoryState(user);
  const repairedDungeonClears = repairDungeonClearDataFromProgress(user);
  if (repairedDungeonClears > 0) {
    console.log(
      `[unlock-progress] repaired dungeon clear unlock data uid=${user.userUid || "(ephemeral)"} entries=${repairedDungeonClears}`
    );
  }
  if (!CLEAR_ALL_MISSIONS_STATUS) repairPostTutorialGuideMissionCompletions(user);
  return user;
}

function ensureDefaultShip(user) {
  if (!user || getArmyShips(user).length > 0) return null;
  const ship = grantUnit(user, DEFAULT_STARTER_SHIP_ID, {
    level: 1,
    exp: 0,
    regDate: dateTimeBinaryNow(),
    fromContract: false,
  });
  if (ship && process.env.CS_DEFAULT_SHIP_REPAIR_LOG !== "0") {
    console.log(`[user-db] repaired missing default ship uid=${user.userUid || "(ephemeral)"} shipId=${DEFAULT_STARTER_SHIP_ID}`);
  }
  return ship;
}

function ensureLocalShopInventory(user) {
  try {
    const catalog = loadShopCatalog();
    const seedCoreCurrencies = process.env.CS_LOCAL_SHOP_SEED_CORE_CURRENCIES === "1";
    const commonResourceIds = new Set(COMMON_RESOURCE_ITEM_IDS.map((id) => Number(id)));
    const seedBalance = toBigInt(
      process.env.CS_LOCAL_SHOP_BALANCE || process.env.CS_LOCAL_SHOP_CURRENCY_BALANCE,
      DEFAULT_LOCAL_SHOP_BALANCE
    );
    const seedItemIds = seedCoreCurrencies
      ? catalog.priceItemIds || []
      : (catalog.priceItemIds || []).filter((itemId) => !commonResourceIds.has(Number(itemId)));
    seedShopCurrency(user, seedItemIds, {
      balance: seedBalance,
      regDate: dateTimeBinaryNow(),
      seedMissingOnly: true,
      includeCommonResources: seedCoreCurrencies,
    });
    const eventShopSeed = ensureActiveEventShopCurrencies(user, runtimeEventManager, {
      balance: seedBalance,
      regDate: dateTimeBinaryNow(),
      seedMissingOnly: true,
      includeAllEventShops: false,
    });
    if (eventShopSeed.seeded.length > 0 && process.env.CS_EVENT_SHOP_LOG !== "0") {
      console.log(
        `[event-shop] active products=${eventShopSeed.active.productIds.length} currencies=${eventShopSeed.seeded.join(",")}`
      );
    }
    if (
      !seedCoreCurrencies &&
      process.env.CS_REPAIR_LOCAL_SHOP_CORE_CURRENCY_SEED !== "0" &&
      !(user.inventory && user.inventory.coreCurrencySeedRepairedV1)
    ) {
      const repaired = removeDebugSeededCommonResources(user, { balance: seedBalance });
      if (repaired.length > 0) {
        user.inventory.coreCurrencySeedRepairedV1 = new Date().toISOString();
        console.log(
          `[inventory] removed debug seed from core currencies uid=${user.userUid || "(ephemeral)"} items=${repaired
            .map((item) => `${item.itemId}:${item.previousFree}->${item.nextFree}`)
            .join(",")}`
        );
        if (USE_LOCAL_USER_DB) saveUserDb();
      }
    }
  } catch (err) {
    console.log(`[inventory] failed to seed shop currencies: ${err.message}`);
  }
}

function issueUserTokens(user, preferredAccessToken) {
  const previousAccessToken = nonEmpty(user.accessToken);
  const previousReconnectKey = nonEmpty(user.reconnectKey);
  removeUserTokenIndexes(user);
  const envToken = nonEmpty(process.env.CS_LOGIN_ACCESS_TOKEN);
  const preferredToken = USE_STEAM_TOKEN_AS_ACCESS_TOKEN ? nonEmpty(preferredAccessToken) : "";
  const existingToken = nonEmpty(user.accessToken && user.accessToken.length >= 32 ? user.accessToken : "");
  const nextAccessToken = envToken || existingToken || preferredToken || makeAccessToken();
  const nextReconnectKey = nonEmpty(user.reconnectKey) || makeToken("rck");
  user.accessToken = nextAccessToken;
  user.reconnectKey = nextReconnectKey;
  if (nextAccessToken !== previousAccessToken || nextReconnectKey !== previousReconnectKey || !user.lastTokenIssuedAt) {
    user.lastTokenIssuedAt = new Date().toISOString();
  }
  userDb.accessTokens[user.accessToken] = user.userUid;
  userDb.reconnectKeys[user.reconnectKey] = user.userUid;
}

function removeUserTokenIndexes(user) {
  if (user.accessToken) delete userDb.accessTokens[user.accessToken];
  if (user.reconnectKey) delete userDb.reconnectKeys[user.reconnectKey];
}

function findUserByAccessToken(token) {
  const user = getActiveOrIndexedUser(userDb, "accessTokens", token);
  return user ? ensureUserDefaults(user) : null;
}

function findUserByReconnectKey(reconnectKey) {
  const user = getActiveOrIndexedUser(userDb, "reconnectKeys", reconnectKey);
  return user ? ensureUserDefaults(user) : null;
}

function createEphemeralUser() {
  return ensureUserDefaults({
    userUid: "1000000001",
    friendCode: "10000001",
    nickname: "LocalAdmin",
    accessToken: lastEffectiveAccessToken || "local-access-token",
    reconnectKey: "",
  });
}

function makeToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

function makeAccessToken() {
  return crypto.randomBytes(16).toString("hex");
}

function parsePacket(raw) {
  if (raw.readUInt32LE(0) !== HEAD_FENCE) throw new Error("invalid head fence");
  const totalLength = raw.readInt32LE(4);
  if (raw.length < totalLength) throw new Error("truncated packet");

  let offset = 8;
  const sequenceRaw = readVarLong(raw, offset);
  offset = sequenceRaw.offset;
  const packetIdRaw = readVarInt(raw, offset);
  offset = packetIdRaw.offset;
  const compressed = raw.readUInt8(offset) !== 0;
  offset += 1;
  const payloadSizeRaw = readSignedVarInt(raw, offset);
  offset = payloadSizeRaw.offset;

  const payloadStart = offset;
  const payloadEnd = payloadStart + payloadSizeRaw.value;
  const tailOffset = totalLength - 4;
  const tail = raw.readUInt32LE(tailOffset);
  if (tail !== TAIL_FENCE) throw new Error(`invalid tail fence 0x${tail.toString(16)}`);
  if (payloadEnd > tailOffset) throw new Error("payload overruns packet");

  return {
    raw,
    totalLength,
    sequence: zigZagDecode64(sequenceRaw.value),
    packetId: packetIdRaw.value,
    compressed,
    payloadSize: payloadSizeRaw.value,
    payload: raw.subarray(payloadStart, payloadEnd),
  };
}

function buildPlainPacket(sequence, packetId, payload) {
  return buildFramedPacket(sequence, packetId, payload, false);
}

function buildEncryptedPacket(sequence, packetId, payload) {
  const encrypted = Buffer.from(payload);
  encryptPayload(encrypted);
  return buildFramedPacket(sequence, packetId, encrypted, false);
}

function buildFramedPacket(sequence, packetId, payload, compressed) {
  const sequenceBytes = writeVarLong(sequence);
  const packetIdBytes = writeVarInt(packetId);
  const compressedBytes = Buffer.from([compressed ? 1 : 0]);
  const payloadSizeBytes = writeSignedVarInt(payload.length);
  const totalLength =
    4 +
    4 +
    sequenceBytes.length +
    packetIdBytes.length +
    compressedBytes.length +
    payloadSizeBytes.length +
    payload.length +
    4;

  const packet = Buffer.alloc(totalLength);
  let offset = 0;
  packet.writeUInt32LE(HEAD_FENCE, offset);
  offset += 4;
  packet.writeInt32LE(totalLength, offset);
  offset += 4;
  offset = copy(sequenceBytes, packet, offset);
  offset = copy(packetIdBytes, packet, offset);
  offset = copy(compressedBytes, packet, offset);
  offset = copy(payloadSizeBytes, packet, offset);
  offset = copy(payload, packet, offset);
  packet.writeUInt32LE(TAIL_FENCE, offset);
  return packet;
}

function decodeSteamLoginReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const protocolVersion = readSignedVarInt(decrypted, offset);
    offset = protocolVersion.offset;
    const deviceUid = readString(decrypted, offset);
    offset = deviceUid.offset;
    const accessToken = readString(decrypted, offset);
    offset = accessToken.offset;
    const accountId = readString(decrypted, offset);
    offset = accountId.offset;

    lastSteamAccessToken = accessToken.value || "";
    if (lastSteamAccessToken) lastEffectiveAccessToken = lastSteamAccessToken;

    console.log(
      `[STEAM_LOGIN_REQ] protocolVersion=${protocolVersion.value} accountId=${JSON.stringify(accountId.value)} steamTicketLen=${lastSteamAccessToken.length}`
    );
    return {
      protocolVersion: protocolVersion.value,
      deviceUid: deviceUid.value || "",
      accountId: accountId.value || "",
      accessToken: accessToken.value || "",
    };
  } catch (err) {
    console.log(`[STEAM_LOGIN_REQ] decode failed: ${err.message}`);
    return {
      protocolVersion: 0,
      deviceUid: "",
      accountId: "",
      accessToken: "",
    };
  }
}

function decodeJoinLobbyReq(payload) {
  try {
    const decrypted = decryptCopy(payload);
    let offset = 0;
    const protocolVersion = readSignedVarInt(decrypted, offset);
    offset = protocolVersion.offset;
    const accessToken = readString(decrypted, offset);
    console.log(
      `[JOIN_LOBBY_REQ] protocolVersion=${protocolVersion.value} tokenLen=${accessToken.value ? accessToken.value.length : 0}`
    );
    return {
      protocolVersion: protocolVersion.value,
      accessToken: accessToken.value || "",
    };
  } catch (err) {
    console.log(`[JOIN_LOBBY_REQ] decode failed: ${err.message}`);
    return {
      protocolVersion: 0,
      accessToken: "",
    };
  }
}

function loadCapturedTcpResponses(captureDir) {
  const manifestPath = path.join(captureDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return new Map();

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const responses = new Map();
    for (const [packetId, entry] of Object.entries(manifest)) {
      const payloadPath = path.join(captureDir, entry.payloadFile);
      if (!fs.existsSync(payloadPath)) continue;
      const rawPath = entry.rawFile ? path.join(captureDir, entry.rawFile) : "";
      responses.set(Number(packetId), {
        sequence: Number(entry.sequence || 0),
        compressed: entry.compressed === true,
        payload: fs.readFileSync(payloadPath),
        raw: rawPath && fs.existsSync(rawPath) ? fs.readFileSync(rawPath) : null,
      });
    }
    return responses;
  } catch (err) {
    console.log(`[capture-replay] load failed: ${err.message}`);
    return new Map();
  }
}

function buildCapturedTcpProfiles(responses, captureDir) {
  return {
    contentsVersionAck: parseCapturedContentsVersionAck(responses.get(CONTENTS_VERSION_ACK)),
    loginAck: parseCapturedLoginAck(responses.get(LOGIN_ACK)) || loadCapturedLoginTemplate(captureDir),
    gamebaseLoginAck: parseCapturedLoginAck(responses.get(GAMEBASE_LOGIN_ACK), "GAMEBASE_LOGIN_ACK", true),
  };
}

function parseCapturedContentsVersionAck(entry) {
  if (!entry) return null;
  try {
    const raw = decodeCapturedPayload(entry);
    let offset = 0;
    const errorCode = readSignedVarInt(raw, offset);
    offset = errorCode.offset;
    const contentsVersion = readString(raw, offset);
    offset = contentsVersion.offset;
    const contentsTag = readStringList(raw, offset);
    offset = contentsTag.offset;
    return {
      errorCode: errorCode.value,
      contentsVersion: contentsVersion.value || "",
      contentsTag: contentsTag.value,
      rawPayload: raw,
    };
  } catch (err) {
    console.log(`[capture-replay] failed to parse official ${CONTENTS_VERSION_ACK}: ${err.message}`);
    return null;
  }
}

function parseCapturedLoginAck(entry, label = "LOGIN_ACK", hasResultCode = false) {
  if (!entry) return null;
  try {
    const raw = decodeCapturedPayload(entry);
    let offset = 0;
    const errorCode = readSignedVarInt(raw, offset);
    offset = errorCode.offset;
    const accessToken = readString(raw, offset);
    offset = accessToken.offset;
    const gameServerIP = readString(raw, offset);
    offset = gameServerIP.offset;
    const gameServerPort = readSignedVarInt(raw, offset);
    offset = gameServerPort.offset;
    const contentsVersion = readString(raw, offset);
    offset = contentsVersion.offset;
    const contentsTag = readStringList(raw, offset);
    offset = contentsTag.offset;
    const openTag = readStringList(raw, offset);
    offset = openTag.offset;
    const resultCode = hasResultCode && offset < raw.length ? readSignedVarInt(raw, offset) : { value: undefined, offset };
    offset = resultCode.offset;
    return {
      errorCode: errorCode.value,
      accessToken: accessToken.value || "",
      gameServerIP: gameServerIP.value || "",
      gameServerPort: gameServerPort.value || 0,
      contentsVersion: contentsVersion.value || "",
      contentsTag: contentsTag.value,
      openTag: openTag.value,
      resultCode: resultCode.value,
      rawPayload: raw,
    };
  } catch (err) {
    console.log(`[capture-replay] failed to parse official ${label}: ${err.message}`);
    return null;
  }
}

function loadCapturedLoginTemplate(captureDir) {
  const templatePath = path.join(captureDir, "official-login-template.json");
  if (!fs.existsSync(templatePath)) return null;
  try {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    const contentsTag = normalizeStringArray(template.contentsTag || template.contentsTags);
    const openTag = normalizeStringArray(template.openTag || template.openTags);
    if (!template.contentsVersion || !contentsTag.length) return null;
    return {
      errorCode: Number(template.errorCode || 0),
      accessToken: "",
      gameServerIP: "",
      gameServerPort: 0,
      contentsVersion: String(template.contentsVersion || ""),
      contentsTag,
      openTag,
      rawPayload: null,
    };
  } catch (err) {
    console.log(`[capture-replay] failed to load official login template: ${err.message}`);
    return null;
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function decodeCapturedPayload(entry) {
  if (entry.compressed) return lz4StreamDecompress(entry.payload);
  return decryptCopy(entry.payload);
}

function lz4StreamDecompress(payload) {
  let offset = 0;
  const chunks = [];
  while (offset < payload.length) {
    const flags = readVarInt(payload, offset);
    offset = flags.offset;
    const outputLength = readVarInt(payload, offset);
    offset = outputLength.offset;
    const compressed = (flags.value & 1) !== 0;
    let inputLength = outputLength.value;
    if (compressed) {
      const rawInputLength = readVarInt(payload, offset);
      offset = rawInputLength.offset;
      inputLength = rawInputLength.value;
    }
    const block = payload.subarray(offset, offset + inputLength);
    offset += inputLength;
    chunks.push(compressed ? lz4BlockDecode(block, outputLength.value) : Buffer.from(block));
  }
  return Buffer.concat(chunks);
}

function lz4StreamWrapUncompressed(rawPayload) {
  return Buffer.concat([writeVarInt(0), writeVarInt(rawPayload.length), rawPayload]);
}

function lz4BlockDecode(input, outputLength) {
  const output = Buffer.alloc(outputLength);
  let inputOffset = 0;
  let outputOffset = 0;

  while (inputOffset < input.length) {
    const token = input[inputOffset++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        literalLength += value;
      } while (value === 255);
    }

    input.copy(output, outputOffset, inputOffset, inputOffset + literalLength);
    inputOffset += literalLength;
    outputOffset += literalLength;
    if (inputOffset >= input.length) break;

    const matchOffset = input[inputOffset] | (input[inputOffset + 1] << 8);
    inputOffset += 2;
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let value;
      do {
        value = input[inputOffset++];
        matchLength += value;
      } while (value === 255);
    }
    matchLength += 4;

    for (let index = 0; index < matchLength; index += 1) {
      output[outputOffset + index] = output[outputOffset - matchOffset + index];
    }
    outputOffset += matchLength;
  }

  if (outputOffset !== outputLength) {
    throw new Error(`lz4 output length mismatch: expected ${outputLength}, decoded ${outputOffset}`);
  }
  return output;
}

function loadCapturedGameFlow(flowDir) {
  const manifestPath = path.join(flowDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const hydrate = (entry) => {
      const rawPath = path.join(flowDir, entry.rawFile);
      const payloadPath = path.join(flowDir, entry.payloadFile);
      return {
        ...entry,
        raw: fs.existsSync(rawPath) ? fs.readFileSync(rawPath) : null,
        payload: fs.existsSync(payloadPath) ? fs.readFileSync(payloadPath) : null,
        sequence: entry.sequence || entry.seq,
      };
    };
    const server = (manifest.server || []).map(hydrate);
    const client = (manifest.client || []).map(hydrate);
    return { server, client };
  } catch (err) {
    console.log(`[capture-game] load failed: ${err.message}`);
    return null;
  }
}

function buildCapturedCombatReplayEntries(flow) {
  if (!flow || !Array.isArray(flow.server)) return [];
  return flow.server
    .map((entry, index) => ({ entry, index: index + 1 }))
    .filter(
      ({ entry, index }) =>
        index >= OFFICIAL_COMBAT_REPLAY_START_INDEX &&
        entry &&
        entry.packetId === NPT_GAME_SYNC_DATA_PACK_NOT &&
        entry.raw &&
        entry.payload
    );
}

function loadCapturedFlowMirror(flowDir) {
  const manifestPath = path.join(flowDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const byPath = new Map();
    for (const entry of manifest) {
      if (!entry || entry.method !== "GET" || !entry.path || !entry.bodyFile) continue;
      byPath.set(entry.path, { ...entry, bodyPath: path.join(flowDir, entry.bodyFile) });
    }
    return { byPath };
  } catch (err) {
    console.log(`[mirror] manifest load failed: ${err.message}`);
    return null;
  }
}

function serveCapturedFlow(req, res, mirror) {
  const requestUrl = new URL(req.url || "/", MIRROR_PUBLIC_BASE_URL);
  const mirrorPath = stripRevivalSideApkPrefix(requestUrl.pathname);
  const entry = mirror.byPath.get(mirrorPath);
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`No captured response for ${requestUrl.pathname}\n`);
    console.log(`[mirror] MISS ${requestUrl.pathname}`);
    return;
  }

  try {
    let body = fs.readFileSync(entry.bodyPath);
    const headers = responseHeaders(entry, body.length);
    if (serverInfoMode === "revivalside" && mirrorPath.endsWith("/ServerInfo_V2.json")) {
      body = rewriteServerInfo(body);
      headers["Content-Length"] = body.length;
    }
    res.writeHead(entry.statusCode || 200, headers);
    res.end(body);
    console.log(`[mirror] HIT ${requestUrl.pathname} ${body.length}b`);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`Failed to serve captured response: ${err.message}\n`);
  }
}

function responseHeaders(entry, bodyLength) {
  const headers = {};
  for (const [name, value] of Object.entries(entry.headers || {})) {
    const lower = name.toLowerCase();
    if (["content-encoding", "transfer-encoding", "connection", "content-length", "alt-svc"].includes(lower)) {
      continue;
    }
    headers[name] = value;
  }
  headers["Content-Length"] = bodyLength;
  headers["Cache-Control"] = "no-store";
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return headers;
}

function rewriteServerInfo(body) {
  const config = JSON.parse(body.toString("utf8"));
  if (config.server && typeof config.server === "object") {
    for (const server of Object.values(config.server)) {
      if (!server || typeof server !== "object") continue;
      server.ip = GAME_SERVER_IP;
      server.port = GAME_SERVER_PORT;
    }
  }
  config.cdn = ANDROID_CLIENT_CDN_BASE_URL;
  return Buffer.from(JSON.stringify(config, null, 2), "utf8");
}

function stripRevivalSideApkPrefix(pathname) {
  return pathname.startsWith("/revivalsideapk/") ? pathname.slice("/revivalsideapk".length) : pathname;
}

function ensureTrailingSlash(value) {
  const text = String(value || "").trim();
  return text.endsWith("/") ? text : `${text}/`;
}

function normalizeServerInfoMode(value) {
  return String(value || "").trim().toLowerCase() === "official" ? "official" : "revivalside";
}

function parseTags(raw) {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function mergeTags(...groups) {
  return Array.from(
    new Set(
      groups
        .flatMap((group) => (Array.isArray(group) ? group : parseTags(String(group || ""))))
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
    )
  );
}

function parseGameUnitGroups(raw) {
  return String(raw || "")
    .split(";")
    .map((group) =>
      group
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
    .filter((group) => group.length > 0);
}

function loadDotEnv(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) line = line.slice("export ".length).trim();
      const equals = line.indexOf("=");
      if (equals <= 0) continue;
      const key = line.slice(0, equals).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) continue;
      let value = line.slice(equals + 1).trim();
      const quote = value[0];
      if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "");
      }
      process.env[key] = value;
    }
  } catch (err) {
    console.log(`[env] failed to load ${filePath}: ${err.message}`);
  }
}

function findDefaultDotnetRuntime() {
  if (process.platform === "win32") {
    const x64Dotnet = path.join(process.env.ProgramFiles || "C:\\Program Files", "dotnet", "x64", "dotnet.exe");
    if (fs.existsSync(x64Dotnet)) return x64Dotnet;
    const nativeDotnet = path.join(process.env.ProgramFiles || "C:\\Program Files", "dotnet", "dotnet.exe");
    if (fs.existsSync(nativeDotnet)) return nativeDotnet;
  }
  return "dotnet";
}

function findDefaultCombatHostExecutable(projectPath) {
  const packagedHost = path.join(ROOT_DIR, "combat-host", process.platform === "win32" ? "CombatHost.exe" : "CombatHost");
  if (fs.existsSync(packagedHost)) return packagedHost;
  return "";
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function decryptCopy(payload) {
  const copy = Buffer.from(payload);
  encryptPayload(copy);
  return copy;
}

function encryptPayload(buffer) {
  let offset = 0;
  let maskIndex = 0;
  while (offset < buffer.length) {
    const mask = CRYPTO_MASKS[maskIndex];
    if (buffer.length - offset >= 8) {
      const value = buffer.readBigUInt64LE(offset) ^ mask;
      buffer.writeBigUInt64LE(value, offset);
      offset += 8;
    } else {
      const key = Number(mask & 0xffn);
      while (offset < buffer.length) {
        buffer[offset] ^= key;
        offset += 1;
      }
    }
    maskIndex = (maskIndex + 1) % CRYPTO_MASKS.length;
  }
}

function writeString(value) {
  if (value == null) return writeSignedVarInt(-1);
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([writeSignedVarInt(bytes.length), bytes]);
}

function readString(buffer, offset) {
  const length = readSignedVarInt(buffer, offset);
  offset = length.offset;
  if (length.value === -1) return { value: "", offset };
  const value = buffer.subarray(offset, offset + length.value).toString("utf8");
  return { value, offset: offset + length.value };
}

function safeReadString(buffer, offset) {
  try {
    return readString(buffer, offset);
  } catch (_) {
    return { value: "", offset };
  }
}

function writeStringList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeString)]);
}

function readStringList(buffer, offset) {
  const count = readVarInt(buffer, offset);
  offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const item = readString(buffer, offset);
    offset = item.offset;
    values.push(item.value || "");
  }
  return { value: values, offset };
}

function writeObjectList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values]);
}

function writeObjectMapLong(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarLong(key), writeNullableObject(payload)]),
  ]);
}

function writeObjectMapInt(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarInt(key), writeNullableObject(payload)]),
  ]);
}

function writeObjectMapByte(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeByte(key), writeNullableObject(payload)]),
  ]);
}

function writeObjectMapShort(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarInt(key), writeNullableObject(payload)]),
  ]);
}

function writeStringIntMap(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, value]) => [writeString(key), writeSignedVarInt(value)]),
  ]);
}

function writeIntIntMap(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, value]) => [writeSignedVarInt(Number(key || 0)), writeSignedVarInt(Number(value || 0))]),
  ]);
}

function writeIntList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeSignedVarInt)]);
}

function writeBoolList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeBool)]);
}

function writeNullableObject(payload) {
  return Buffer.concat([writeBool(true), payload]);
}

function writeNullObject() {
  return writeBool(false);
}

function writeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

function writeByte(value) {
  return Buffer.from([Number(value) & 0xff]);
}

function writeSByte(value) {
  return Buffer.from([Number(value) & 0xff]);
}

function writeInt64LE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value), 0);
  return buffer;
}

function writeDoubleLE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(Number(value), 0);
  return buffer;
}

function writeFloatLE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(Number(value), 0);
  return buffer;
}

function writeHalfFloat(value) {
  return writeVarInt(Math.max(0, Math.trunc(Number(value || 0) * 100)));
}

function floatToHalf(value) {
  const f = Number(value || 0);
  if (!Number.isFinite(f) || f === 0) return 0;
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = Math.max(-50000, Math.min(50000, f));
  const bits = intView[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13);
}

function dateTimeBinaryNow() {
  if (serverTime && typeof serverTime.dateTimeBinaryNow === "function") return serverTime.dateTimeBinaryNow();
  return dateTimeBinaryForDate(getServerNowDate());
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    const b = buffer.readUInt8(offset++);
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("malformed varint32");
}

function readVarLong(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  while (shift < 64n) {
    const b = buffer.readUInt8(offset++);
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, offset };
    shift += 7n;
  }
  throw new Error("malformed varint64");
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: zigZagDecode32(raw.value), offset: raw.offset };
}

function safeReadSignedVarInt(buffer, offset) {
  try {
    return readSignedVarInt(buffer, offset);
  } catch (_) {
    return { value: 0, offset };
  }
}

function safeReadSignedVarLong(buffer, offset) {
  try {
    return readSignedVarLong(buffer, offset);
  } catch (_) {
    return { value: 0n, offset };
  }
}

function readSignedVarLong(buffer, offset) {
  const raw = readVarLong(buffer, offset);
  return { value: zigZagDecode64(raw.value), offset: raw.offset };
}

function writeVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function writeSignedVarInt(value) {
  return writeVarInt(zigZagEncode32(value));
}

function writeVarLong(value) {
  let current = zigZagEncode64(BigInt(value));
  const bytes = [];
  while (current > 0x7fn) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function writeSignedVarLong(value) {
  return writeVarLong(value);
}

function zigZagEncode32(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function zigZagDecode32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagEncode64(value) {
  return (value << 1n) ^ (value >> 63n);
}

function zigZagDecode64(value) {
  return (value >> 1n) ^ -(value & 1n);
}

function copy(source, target, offset) {
  source.copy(target, offset);
  return offset + source.length;
}

function printHex(buffer) {
  console.log(buffer.toString("hex").replace(/(.{2})/g, "$1 ").trim());
}
