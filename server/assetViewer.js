const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const {
  extractTableRecords,
  listGameplayTableFiles,
  normalizeTableBaseName,
  readGameplayTable,
} = require("../modules/gameplay-jsons");
const { createModProjectStore } = require("../modules/mod-projects");
const { createModRuntime } = require("../modules/mod-loader");
const { createModUnitMaker } = require("../modules/mod-unit-maker");
const { createModEpisodeMaker } = require("../modules/mod-episode-maker");
const { ALLOWED_SOURCE_EXTENSIONS, createUnityBundleCompiler } = require("../modules/unity-bundle-compiler");
const { createAssetCatalog, resolveUnitAssetPreview } = require("../modules/asset-catalog");

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const DEFAULT_TEXT_PREVIEW_BYTES = 512 * 1024;
const MAX_RELATED_RESULTS = 40;
const MAX_FIELD_TABLES = 12;
const MAX_FIELD_RESULTS = 60;
const MAX_MOD_BODY_BYTES = 50 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".atlas", ".bytes", ".csv", ".json", ".log", ".lua", ".md", ".txt", ".xml", ".yaml", ".yml"]);
const UNITY_RESOURCE_TYPES = new Set(["AudioClip", "Sprite", "TextAsset", "Texture2D"]);

function extractedAssetLibraryReady(assetRoot) {
  if (!fs.existsSync(assetRoot)) return false;
  const stack = [assetRoot];
  let hasAsset = false;
  try {
    while (stack.length && !hasAsset) {
      const directory = stack.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) stack.push(path.join(directory, entry.name));
        else if (entry.isFile() && entry.name !== "manifest.json") { hasAsset = true; break; }
      }
    }
  } catch { return false; }
  if (!hasAsset) return false;
  for (const manifestPath of [path.join(path.dirname(assetRoot), "manifest.json"), path.join(assetRoot, "manifest.json")]) {
    let descriptor;
    try {
      descriptor = fs.openSync(manifestPath, "r");
      const header = Buffer.alloc(64 * 1024);
      const length = fs.readSync(descriptor, header, 0, header.length, 0);
      const count = header.subarray(0, length).toString("utf8").match(/"file_count"\s*:\s*(\d+)/);
      if (count && Number(count[1]) > 0) return true;
    } catch { /* extraction manifest is missing or incomplete */ }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  return false;
}
const FIELD_ALIASES = {
  hp: ["health", "nsthp"], health: ["hp", "nsthp"], attack: ["atk", "damage", "nstatk", "atkfactor"], atk: ["attack", "damage", "nstatk", "atkfactor"],
  defense: ["def", "nstdef", "armor"], defence: ["def", "nstdef", "armor"], speed: ["movespeed", "attackspeed"], cooldown: ["cooltime", "cooltimereduce"],
  critical: ["crit", "criticaldamage"], crit: ["critical", "criticaldamage"], evasion: ["evade"], evade: ["evasion"], accuracy: ["hit"],
  deploy: ["respawn", "cost"], cost: ["price", "count", "eternium", "credit", "respawn"], reward: ["drop", "rewardvalue", "rewardid"],
  drop: ["reward", "droprate", "dropid"], level: ["levelup", "perlevel", "maxlevel"], experience: ["exp"], exp: ["experience"],
  duration: ["lifetime", "time", "timemax"], range: ["attackrange", "distance"], stage: ["dungeon", "episode"], unit: ["character"],
};

const GAME_SYSTEMS = [
  system("units", "Units & stats", "Identity, rarity, role, deployment cost, base stats and per-level growth.", ["unit", "character", "soldier", "mech", "counter", "hp", "attack", "defense", "respawn"], ["ab_script_unit_data_unit_templet"], ["LUA_UNIT_", "LUA_REARM_UNIT_", "LUA_LIMITBREAK_", "LUA_TACTIC_"], ["LUA_UNIT_STAT_TEMPLET", "LUA_UNIT_TEMPLET_BASE", "LUA_UNIT_SKILL_TEMPLET"], [
    edit("HP / ATK / DEF", "unit hp attack defense", "LUA_UNIT_STAT_TEMPLET -> m_StatData.m_Stat.NST_HP / NST_ATK / NST_DEF"),
    edit("Per-level growth", "unit stat per level", "LUA_UNIT_STAT_TEMPLET -> m_StatData.m_StatPerLevel.*"),
    edit("Deployment cost", "unit respawn cost", "LUA_UNIT_STAT_TEMPLET -> m_RespawnCost"),
  ]),
  system("combat", "Core combat", "Damage factors, global stat rates, battle conditions and shared combat constants.", ["combat", "damage", "formula", "attack factor", "stat rate", "battle"], [], ["LUA_DAMAGE_TEMPLET", "LUA_GAME_STAT_", "LUA_STAT_INFO_", "LUA_BATTLE_CONDITION_", "LUA_COMMON_CONST"], ["LUA_DAMAGE_TEMPLET_BASE", "LUA_GAME_STAT_RATE", "LUA_BATTLE_CONDITION_TEMPLET"], [
    edit("Damage multiplier", "damage attack factor", "LUA_DAMAGE_TEMPLET_BASE -> m_fAtkFactor"),
    edit("Global stat rates", "game stat rate", "LUA_GAME_STAT_RATE -> NST_*"),
  ]),
  system("skills", "Skills, buffs & effects", "Unit skills, buff lifetime/stat modifiers, damage effects, reactors and animation data.", ["skill", "buff", "debuff", "effect", "reactor", "cooldown", "lifetime"], ["ab_script_effect", "ab_script_anim_data"], ["LUA_UNIT_SKILL_", "LUA_BUFF_", "LUA_DAMAGE_EFFECT_", "LUA_EFFECT_", "LUA_REACTOR_", "LUA_COMMANDMODULE_"], ["LUA_UNIT_SKILL_TEMPLET", "LUA_BUFF_TEMPLET", "LUA_DAMAGE_EFFECT_TEMPLET"], [
    edit("Buff duration", "buff lifetime", "LUA_BUFF_TEMPLET -> m_fLifeTime"),
    edit("Buff stat/value", "buff stat value", "LUA_BUFF_TEMPLET -> m_StatType1 / m_StatValue1"),
  ]),
  system("stages", "Stages & dungeons", "Stage links, dungeon rules, enemy waves, time limits, missions and entry requirements.", ["stage", "dungeon", "enemy", "wave", "time limit", "fight power"], ["ab_script_dungeon_templet", "ab_script_dungeon_templet_all"], ["LUA_STAGE_", "LUA_DUNGEON_", "LUA_PHASE_", "LUA_MAP_TEMPLET"], ["LUA_STAGE_TEMPLET", "LUA_DUNGEON_TEMPLET_BASE", "LUA_PHASE_TEMPLET"], [
    edit("Time limit", "dungeon time limit", "LUA_DUNGEON_TEMPLET_BASE -> m_fDungeonTimeMax"),
    edit("Recommended power", "dungeon recommended fight power", "LUA_DUNGEON_TEMPLET_BASE -> m_DGRecommendFightPower"),
    edit("Stage-to-battle link", "stage battle dungeon", "LUA_STAGE_TEMPLET -> m_StageBattleStrID"),
  ]),
  system("cutscene-scripts", "Cutscene scripts & dialogue", "Every cutscene sequence, including dialogue, speakers, expressions, positions, timing, branching, backgrounds, transitions, music and effects.", ["cutscene", "dialogue", "speaker", "expression", "position", "background", "transition", "branch", "effect"], ["ab_script_cutscene"], [], [], [
    edit("Dialogue text", "cutscene dialogue talk", "ab_script_cutscene/* -> m_Talk_*"),
    edit("Speaker / expression / position", "cutscene speaker face position", "ab_script_cutscene/* -> m_CharStrID / m_Face / m_Pos"),
    edit("Order / timing", "cutscene process wait time", "ab_script_cutscene/* -> m_CutScenProcessKey / m_bWaitClick / m_fWaitTime"),
    edit("Background / transition", "cutscene background fade", "ab_script_cutscene/* -> m_BGFileName / m_bFadeIn / m_bFadeOut / m_fFadeTime"),
  ]),
  system("cutscene-characters", "Cutscene cast & portraits", "Speaker keys, displayed names and the character prefab used for cutscene portraits.", ["cutscene", "actor", "speaker", "cast", "portrait", "prefab", "name"], [], ["LUA_CUTSCENE_CHAR_TEMPLET"], ["LUA_CUTSCENE_CHAR_TEMPLET"], [
    edit("Actor key", "cutscene actor key", "LUA_CUTSCENE_CHAR_TEMPLET -> m_CutsceneSetting_Key / m_CharStrID"),
    edit("Portrait prefab", "cutscene portrait prefab", "LUA_CUTSCENE_CHAR_TEMPLET -> m_PrefabStr"),
    edit("Displayed speaker name", "cutscene speaker name", "LUA_CUTSCENE_CHAR_TEMPLET -> m_CharStr_*"),
  ]),
  system("cutscene-registration", "Cutscene registration & stage links", "File registration, login triggers, episode placement, stage routing and cutscene-only dungeon start links.", ["cutscene", "register", "file list", "login", "trigger", "episode", "stage", "dungeon", "start"], [], ["LUA_CUTSCENE_FILE_LIST", "LUA_LOGIN_CUTSCENE_TEMPLET", "LUA_EPISODE_TEMPLET", "LUA_STAGE_TEMPLET", "LUA_DUNGEON_TEMPLET_BASE"], ["LUA_CUTSCENE_FILE_LIST", "LUA_DUNGEON_TEMPLET_BASE", "LUA_EPISODE_TEMPLET", "LUA_STAGE_TEMPLET", "LUA_LOGIN_CUTSCENE_TEMPLET"], [
    edit("Register a script", "cutscene file registration", "LUA_CUTSCENE_FILE_LIST -> m_CutScenFile / m_CutScenType"),
    edit("Attach a stage", "cutscene stage dungeon link", "LUA_EPISODE_TEMPLET / LUA_STAGE_TEMPLET -> m_StageBattleStrID; LUA_DUNGEON_TEMPLET_BASE -> m_CutScenStrIDBefore / m_CutScenStrIDAfter"),
    edit("Login trigger", "login cutscene condition", "LUA_LOGIN_CUTSCENE_TEMPLET -> m_CutSceneStrID / m_CondType / m_CondValue / m_OrderList"),
  ]),
  system("cutscene-collection", "Cutscene collection & unlocks", "Collection gallery placement, episode grouping, labels, visibility and replay unlock requirements.", ["cutscene", "collection", "gallery", "replay", "unlock", "episode", "subtab"], [], ["LUA_COLLECTION_CUTSCENE_TEMPLET", "LUA_SI_COLLECTION_CUTSCENE_TEMPLET"], ["LUA_COLLECTION_CUTSCENE_TEMPLET", "LUA_COLLECTION_CUTSCENE_TEMPLET2"], [
    edit("Replay unlock", "collection cutscene unlock", "LUA_COLLECTION_CUTSCENE_TEMPLET* -> m_UnlockReqType / m_UnlockReqValue"),
    edit("Gallery placement", "collection cutscene episode tab", "LUA_COLLECTION_CUTSCENE_TEMPLET* -> m_EPCategory / m_EpisodeID / m_actID / m_SubTabId / m_SubIndex"),
  ]),
  system("cutscene-media", "Cutscene audio & animation", "Scene music mappings, BGM metadata, animation-event references and decoded animation data used by presentation commands.", ["cutscene", "music", "bgm", "audio", "animation", "presentation"], ["ab_script_anim_data"], ["LUA_SCEN_MUSIC", "LUA_BGM_INFO_TEMPLETE", "LUA_ANIMATION_EVENT_TEMPLET"], ["LUA_SCEN_MUSIC", "LUA_BGM_INFO_TEMPLETE", "LUA_ANIMATION_EVENT_TEMPLET", "LUA_ANIM_DATA"], [
    edit("Scene music", "cutscene scene music", "LUA_SCEN_MUSIC -> m_NKM_SCEN_ID / m_MusicName"),
    edit("Animation reference", "cutscene animation name bundle", "ab_script_anim_data/LUA_ANIM_DATA -> animName / bundleName"),
  ]),
  system("story", "Episodes & story", "Episodes, acts, stage ordering, cutscene file lists, dialogue scripts and collection scenes.", ["episode", "story", "cutscene", "dialogue", "act", "scene"], ["ab_script_cutscene"], ["LUA_EPISODE_", "LUA_CUTSCENE_", "LUA_COLLECTION_CUTSCENE_"], ["LUA_EPISODE_TEMPLET", "LUA_EPISODE_GROUP_TEMPLET", "LUA_CUTSCENE_FILE_LIST"], [
    edit("Episode/stage ordering", "episode act stage index", "LUA_EPISODE_TEMPLET -> m_EpisodeID / m_ActID / m_StageIndex"),
    edit("Battle/cutscene link", "episode stage battle cutscene", "LUA_EPISODE_TEMPLET -> m_StageBattleStrID; LUA_CUTSCENE_FILE_LIST -> file entries"),
  ]),
  system("items", "Items & equipment", "Gear stats, set options, tiers, enchant growth, molds, materials and consumables.", ["item", "equipment", "gear", "set option", "enchant", "mold", "material"], ["ab_script_item_templet"], ["LUA_ITEM_", "LUA_EQUIP_", "LUA_PIECE_", "LUA_RANDOM_MOLD_", "LUA_CUSTOM_BOX_"], ["LUA_ITEM_EQUIP_TEMPLET", "LUA_ITEM_EQUIP_SET_OPTION", "LUA_ITEM_MISC_TEMPLET"], [
    edit("Main gear stat", "equipment stat value", "LUA_ITEM_EQUIP_TEMPLET -> STAT_TYPE_1 / STAT_VALUE_1"),
    edit("Enchant growth", "equipment levelup stat", "LUA_ITEM_EQUIP_TEMPLET -> STAT_LEVELUP_VALUE_1 / m_MaxEnchantLevel"),
  ]),
  system("rewards", "Rewards & drops", "Reward groups, random boxes, drop lists, score rewards and attendance payouts.", ["reward", "drop", "loot", "box", "payout", "attendance"], [], ["LUA_REWARD_", "LUA_ITEM_DROP_", "LUA_RANDOM_REWARD_", "LUA_ATTENDANCE_", "LUA_SCORE_REWARD_"], ["LUA_REWARD_TEMPLET_CL", "LUA_REWARD_GROUP_TEMPLET", "LUA_ITEM_DROP_LIST"], [
    edit("Reward item/type", "reward id type", "LUA_REWARD_TEMPLET_CL -> m_RewardType / m_RewardID"),
    edit("Reward amount", "reward value count", "Reward-owning table -> m_RewardValue_* / count fields"),
  ]),
  system("progression", "Progression & upgrades", "Experience curves, limit breaks, tactical updates, rearmament and ship growth.", ["progression", "upgrade", "level", "experience", "exp", "limit break", "rearm", "tactical"], [], ["LUA_UNIT_EXP_", "LUA_REARM_", "LUA_LIMITBREAK_", "LUA_TACTIC_UPDATE_", "LUA_SHIP_LEVELUP_", "LUA_SHIP_LIMITBREAK_"], ["LUA_UNIT_EXP_TABLE", "LUA_LIMITBREAK_INFO", "LUA_REARMAMENT_TEMPLET"], [
    edit("Unit EXP curve", "unit experience level", "LUA_UNIT_EXP_TABLE -> level/EXP fields"),
    edit("Limit-break cost", "limit break cost", "LUA_LIMITBREAK_INFO -> item/count fields"),
  ]),
  system("missions", "Missions & achievements", "Mission conditions, counters, reset cadence, completion counts and rewards.", ["mission", "achievement", "objective", "daily", "weekly", "counter"], [], ["LUA_MISSION_", "LUA_ACHIEVE_", "LUA_COUNTER_"], ["LUA_MISSION_TEMPLET", "LUA_MISSION_TAB_TEMPLET"], [
    edit("Completion requirement", "mission times condition", "LUA_MISSION_TEMPLET -> m_MissionCond / m_Times"),
    edit("Mission reward", "mission reward value", "LUA_MISSION_TEMPLET -> m_RewardType_* / m_RewardID_* / m_RewardValue_*"),
  ]),
  system("economy", "Economy & shops", "Currencies, storefront tabs, products, prices, exchange recipes and packages.", ["economy", "shop", "currency", "price", "exchange", "package", "cash"], [], ["LUA_CURRENCY_", "LUA_SHOP_", "LUA_PACKAGE_", "LUA_EXCHANGE_", "LUA_CASH_"], ["LUA_CURRENCY_TEMPLET", "LUA_SHOP_TEMPLET_01", "LUA_SHOP_TAB_TEMPLET"], [
    edit("Shop price", "shop price cost", "LUA_SHOP_* -> price/resource/count fields"),
    edit("Currency definition", "currency item", "LUA_CURRENCY_TEMPLET -> currency identity and display fields"),
  ]),
  system("contracts", "Recruitment & contracts", "Recruit pools, pickup banners, categories, tabs and contract costs.", ["contract", "recruit", "banner", "pickup", "unit pool", "gacha"], [], ["LUA_CONTRACT"], ["LUA_CONTRACT", "LUA_CONTRACT_UNIT_POOL", "LUA_CONTRACT_CUSTOM_PICKUP"], [
    edit("Recruit pool", "contract unit pool", "LUA_CONTRACT_UNIT_POOL -> unit/rate fields"),
    edit("Recruit cost", "contract cost", "LUA_CONTRACT -> item/count fields"),
  ]),
  system("ships", "Ships", "Ship identity, build recipes, stats, skills, level caps and limit breaks.", ["ship", "build", "ship skill", "ship level"], [], ["LUA_SHIP_"], ["LUA_SHIP_BUILD_TEMPLET", "LUA_SHIP_LEVELUP_TEMPLET", "LUA_SHIP_SKILL_TEMPLET"], [
    edit("Level cap/cost", "ship max level cost", "LUA_SHIP_LEVELUP_TEMPLET -> m_ShipMaxLevel / m_Credit / material count"),
  ]),
  system("operators", "Operators", "Operator base stats, active/passive skills, EXP and random passive pools.", ["operator", "operator skill", "passive"], [], ["LUA_OPERATOR_", "LUA_UNIT_STAT_TEMPLET_OPR", "LUA_UNIT_TEMPLET_BASE_OPR"], ["LUA_OPERATOR_SKILL_TEMPLET", "LUA_OPERATOR_RANDOM_PASSIVE_TEMPLET", "LUA_UNIT_STAT_TEMPLET_OPR"], [
    edit("Operator skill", "operator skill level target", "LUA_OPERATOR_SKILL_TEMPLET -> m_OperSkillTarget / m_MaxSkillLevel"),
  ]),
  system("pvp", "PvP", "Ranked/league rules, seasons, maps, rewards, bans and PvP-specific stat scaling.", ["pvp", "ranked", "league", "season", "ban", "arena"], [], ["LUA_PVP_"], ["LUA_PVP_STAT_RATE", "LUA_PVP_SEASON_TEMPLET", "LUA_PVP_RANK_SEASON_REWARD"], [
    edit("PvP stat scaling", "pvp hp attack stat rate", "LUA_PVP_STAT_RATE -> NST_HP / NST_ATK / other NST_*"),
  ]),
  system("raids", "Raids & bosses", "Raid stages, boss levels, damage basis, entry cost, participation and rank rewards.", ["raid", "boss", "fierce", "damage basis", "participation"], [], ["LUA_RAID_", "LUA_FIERCE_", "LUA_BOSS_"], ["LUA_RAID_TEMPLET", "LUA_FIERCE_TEMPLET", "LUA_FIERCE_POINT_REWARD"], [
    edit("Boss tuning", "raid level damage basis", "LUA_RAID_TEMPLET -> m_RaidLevel / Raid_Damage_Basis"),
    edit("Entry cost", "raid item cost", "LUA_RAID_TEMPLET -> m_StageReqItemID / m_StageReqItemCount"),
  ]),
  system("guild", "Guilds", "Guild levels, attendance, raid/dungeon schedules, bosses, currencies and rewards.", ["guild", "consortium", "guild raid", "guild dungeon"], [], ["LUA_GUILD_"], ["LUA_GUILD_LEVEL_TEMPLET", "LUA_GUILD_RAID_TEMPLET", "LUA_GUILD_DUNGEON_TEMPLET"], [
    edit("Guild raid/reward", "guild raid reward", "LUA_GUILD_RAID_* and LUA_GUILD_*_REWARD tables"),
  ]),
  system("warfare", "Warfare", "Warfare maps, nodes, squads, win/loss conditions, missions and container rewards.", ["warfare", "map", "node", "win condition", "container"], ["ab_script_warfare", "ab_script_warfare_map_templet_all"], ["LUA_WARFARE_"], ["LUA_WARFARE_TEMPLET", "LUA_WARFARE_UNIT_TEMPLET"], [
    edit("Win/loss rules", "warfare win condition", "LUA_WARFARE_TEMPLET -> m_WFWinCondition / m_WFWinValue / loss fields"),
    edit("Time/power", "warfare time fight power", "LUA_WARFARE_TEMPLET -> m_fWarfareTimeMax / m_WFRecommendFightPower"),
  ]),
  system("world", "World map & exploration", "Cities, branches, exploration missions, events, dives and world-map rewards.", ["world map", "explore", "branch", "city", "dive", "world"], [], ["LUA_WORLDMAP_", "LUA_EXPLORE_", "LUA_DIVE_"], ["LUA_WORLDMAP_CITY_TEMPLET", "LUA_EXPLORE_TEMPLET", "LUA_DIVE_TEMPLET"], [
    edit("Exploration time/reward", "explore time reward", "LUA_EXPLORE_* -> time/cost/reward fields"),
  ]),
  system("events", "Events", "Event schedules, point shops, missions, passes, stages, drops and temporary rewards.", ["event", "festival", "event pass", "point shop"], [], ["LUA_EVENT_"], ["LUA_EVENT_TEMPLET", "LUA_EVENT_MISSION_TEMPLET", "LUA_EVENT_PASS_TEMPLET"], [
    edit("Event schedule", "event start end time", "LUA_EVENT_* -> date/time fields"),
    edit("Event points/rewards", "event point reward", "LUA_EVENT_* -> point/reward fields"),
  ]),
  system("challenge", "Challenge modes", "Dimension Trimming, Shadow Palace and other scored/penalty combat modes.", ["dimension trimming", "trim", "shadow palace", "challenge", "penalty", "score"], [], ["LUA_TRIM_", "LUA_SHADOW_", "LUA_CHALLENGE_"], ["LUA_TRIM_TEMPLET", "LUA_TRIM_COMBAT_PENALTY", "LUA_SHADOW_PALACE_TEMPLET"], [
    edit("Combat penalty", "trim combat penalty", "LUA_TRIM_COMBAT_PENALTY -> penalty stat/value fields"),
    edit("Mode rewards", "trim shadow reward", "LUA_TRIM_REWARD_CL / LUA_SHADOW_* reward tables"),
  ]),
  system("office", "Office & interactions", "Dorm/office furniture, interiors, NPC interaction data and unit dialogue metadata.", ["office", "interior", "furniture", "npc", "interaction", "dorm"], ["ab_script_npc"], ["LUA_OFFICE_", "LUA_INTERIOR_", "LUA_FURNITURE_", "LUA_UNIT_VOICE_"], ["LUA_OFFICE_INTERACTION_TEMPLET", "LUA_UNIT_VOICE_TEMPLET"], [
    edit("NPC interaction", "npc interaction", "ab_script_npc/* -> interaction conditions and dialogue values"),
  ]),
  system("rules", "Client rules & unlocks", "Feature gates, shared constants, open tags, content unlock requirements and client configuration.", ["unlock", "feature", "content", "client const", "common const", "open tag", "rule"], [], ["LUA_CONTENTS_UNLOCK_", "LUA_CLIENT_CONST", "LUA_COMMON_CONST", "LUA_OPEN_TAG_"], ["LUA_CONTENTS_UNLOCK_TEMPLET", "LUA_CLIENT_CONST", "LUA_COMMON_CONST"], [
    edit("Feature unlock", "contents unlock requirement", "LUA_CONTENTS_UNLOCK_TEMPLET -> unlock type/value fields"),
  ]),
  system("localization", "Text & localization", "String tables used by names, descriptions, dialogue and localized UI text.", ["text", "string", "localization", "name", "description", "dialogue"], ["ab_script_string_table"], ["LUA_STRING_"], [], [
    edit("Displayed text", "string localization text", "ab_script_string_table/* -> string ID and localized text"),
  ]),
  system("all", "All gameplay data", "The complete decoded LUAC catalog, including uncategorized and one-off systems.", ["all", "everything", "raw", "table"], ["*"], [], ["LUA_UNIT_STAT_TEMPLET", "LUA_STAGE_TEMPLET", "LUA_REWARD_TEMPLET_CL"], []),
];

function system(id, title, description, keywords, directories, prefixes, priorityTables, commonEdits) {
  return { id, title, description, keywords, directories, prefixes, priorityTables, commonEdits };
}

function edit(label, query, location) {
  return { label, query, location };
}

function createAssetViewer(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const env = options.env || process.env;
  const assetRoot = path.resolve(options.assetRoot || env.CS_ASSET_VIEWER_ROOT || path.join(rootDir, "extracted-assets", "all"));
  const modStore = options.modRuntime ? options.modRuntime.store : createModProjectStore({ rootDir, modsRoot: options.modsRoot || env.CS_MODS_ROOT });
  const config = {
    rootDir,
    env,
    basePath: normalizeBasePath(options.basePath || "/mod-side"),
    allowRemote: options.allowRemote === true,
    allowRemoteModCreator: options.allowRemoteModCreator === true || env.CS_MOD_CREATOR_ALLOW_REMOTE === "1",
    assetRoot,
    openFileLocation: options.openFileLocation || openFileLocation,
    assetCatalog: options.assetCatalog || createAssetCatalog({ rootDir, env, assetRoot }),
    uiRoot: path.resolve(options.uiRoot || env.CS_MODSIDE_UI_DIST || path.join(rootDir, "server", "modside-ui-dist")),
    spineViewerRoot: path.resolve(options.spineViewerRoot || env.CS_SPINE_VIEWER_DIST || path.join(rootDir, "SpineViewer", "dist")),
    relatedTableIndexPath: path.resolve(options.relatedTableIndexPath || env.CS_ASSET_RELATED_TABLE_INDEX || path.join(rootDir, "wiki", "data", "idIndex.json")),
    maxTextPreviewBytes: positiveInteger(options.maxTextPreviewBytes, DEFAULT_TEXT_PREVIEW_BYTES),
    tableFiles: null,
    tableSchemas: new Map(),
    relatedTableRows: null,
    objectIndexes: new Map(),
    modStore,
    modRuntime: options.modRuntime || createModRuntime({ rootDir, env, modStore }),
    unitMaker: options.unitMaker || createModUnitMaker({ rootDir, env, modStore, assetRoot }),
    episodeMaker: options.episodeMaker || createModEpisodeMaker({ rootDir, env, modStore, assetRoot }),
    cutsceneCafeBackground: path.resolve(options.cutsceneCafeBackground || path.join(rootDir, "launcher", "src", "assets", "revivalside", "bg", "AB_UI_NKM_UI_CUTSCEN_BG_CAFE.webp")),
    unityCompiler: options.unityCompiler || createUnityBundleCompiler({ env }),
  };
  const html = new Map([
    [config.basePath, buildReactUiHtml(config, "mod")],
    [`${config.basePath}/assets`, buildReactUiHtml(config, "assets")],
    [`${config.basePath}/story`, buildReactUiHtml(config, "story")],
    [`${config.basePath}/units`, buildReactUiHtml(config, "units")],
    [`${config.basePath}/combat`, buildReactUiHtml(config, "combat")],
  ]);

  async function handle(req, res) {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (!matchesBasePath(requestUrl.pathname, config.basePath)) {
      if (config.basePath === "/mod-side" && matchesBasePath(requestUrl.pathname, "/asset-viewer")) {
        res.writeHead(308, { Location: `${config.basePath}${requestUrl.pathname.slice("/asset-viewer".length)}${requestUrl.search}` });
        res.end();
        return true;
      }
      return false;
    }

    if (!config.allowRemote && !isLoopback(req.socket && req.socket.remoteAddress)) {
      sendJson(res, 403, { error: "Mod:Side is restricted to loopback requests." });
      return true;
    }

    try {
      await routeRequest(config, html, req, res, requestUrl);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || "Mod:Side request failed." });
    }
    return true;
  }

  return { handle, basePath: config.basePath, assetRoot: config.assetRoot, spineViewerRoot: config.spineViewerRoot };
}

async function routeRequest(config, html, req, res, requestUrl) {
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";
  const apiPath = `${config.basePath}/api`;

  const pagePath = pathname === `${config.basePath}/index.html` ? config.basePath : pathname;
  if ((req.method === "GET" || req.method === "HEAD") && html.has(pagePath)) {
    sendHtml(res, html.get(pagePath), req.method === "HEAD");
    return;
  }

  const spinePath = `${config.basePath}/spine`;
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === spinePath || pathname.startsWith(`${spinePath}/`))) {
    serveStaticFile(config.spineViewerRoot, pathname.slice(spinePath.length), req, res);
    return;
  }

  const uiPath = `${config.basePath}/ui`;
  if ((req.method === "GET" || req.method === "HEAD") && (pathname === uiPath || pathname.startsWith(`${uiPath}/`))) {
    serveStaticFile(config.uiRoot, pathname.slice(uiPath.length), req, res);
    return;
  }

  if (!pathname.startsWith(`${apiPath}/`) && pathname !== apiPath) {
    sendJson(res, 404, { error: "No Mod:Side route found." });
    return;
  }
  if (pathname === `${apiPath}/mods` || pathname.startsWith(`${apiPath}/mods/`) || pathname === `${apiPath}/mod-runtime` || pathname.startsWith(`${apiPath}/mod-runtime/`) || pathname === `${apiPath}/references` || pathname === `${apiPath}/unit-maker` || pathname.startsWith(`${apiPath}/unit-maker/`) || pathname === `${apiPath}/episode-maker` || pathname.startsWith(`${apiPath}/episode-maker/`) || pathname === `${apiPath}/unity-compiler`) {
    await serveModCreatorApi(config, req, res, requestUrl, apiPath);
    return;
  }
  if (pathname === `${apiPath}/open-file-location`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    if (!isLoopback(req.socket && req.socket.remoteAddress)) throw httpError(403, "Opening File Explorer is restricted to loopback requests.");
    const filePath = resolveExistingAssetPath(config.assetRoot, requestUrl.searchParams.get("path"));
    if (!fs.statSync(filePath).isFile()) throw httpError(422, "Select a file to reveal in File Explorer.");
    await config.openFileLocation(filePath);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendJson(res, 405, { error: "This Mod:Side section is read-only." });
    return;
  }

  if (pathname === `${apiPath}/health`) {
    const tableFiles = getTableFiles(config);
    sendJson(res, 200, {
      ok: true,
      readOnly: true,
      modCreator: true,
      tableCount: tableFiles.length,
      assetRootAvailable: extractedAssetLibraryReady(config.assetRoot),
      spineViewerAvailable: fs.existsSync(path.join(config.spineViewerRoot, "index.html")),
    }, req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/objects`) {
    serveObjects(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/object`) {
    serveObject(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/asset-replacement`) {
    sendJson(res, 200, assetReplacementMetadata(config, requestUrl.searchParams.get("path")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/tables`) {
    serveTables(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/systems`) {
    serveSystems(config, req, res);
    return;
  }
  if (pathname === `${apiPath}/system-tables`) {
    serveSystemTables(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/fields`) {
    serveFieldSearch(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/table`) {
    serveTable(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/assets`) {
    serveAssetDirectory(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/asset`) {
    serveAssetFile(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/text`) {
    serveTextPreview(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/spine-set`) {
    serveSpineSet(config, req, res, requestUrl);
    return;
  }
  if (pathname === `${apiPath}/related`) {
    serveRelated(config, req, res, requestUrl);
    return;
  }
  sendJson(res, 404, { error: "No asset viewer API route found." });
}

async function serveModCreatorApi(config, req, res, requestUrl, apiPath) {
  if (!config.allowRemoteModCreator && !isLoopback(req.socket && req.socket.remoteAddress)) throw httpError(403, "Mod creator is restricted to loopback requests.");
  const pathname = requestUrl.pathname.replace(/\/+$/, "");
  if (pathname === `${apiPath}/episode-maker/catalog`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.episodeMaker.catalog(requestUrl.searchParams.get("query")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/projects`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, { projects: typeof config.episodeMaker.projects === "function" ? config.episodeMaker.projects() : [] }, req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/project`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    if (typeof config.episodeMaker.readProject !== "function") throw httpError(404, "Saved Episode Maker projects are unavailable.");
    sendJson(res, 200, config.episodeMaker.readProject(requestUrl.searchParams.get("id")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/suggest`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.episodeMaker.suggest(requestUrl.searchParams.get("episodeId"), requestUrl.searchParams.get("category"), requestUrl.searchParams.get("offset"), requestUrl.searchParams.get("difficulty")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/layout`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.episodeMaker.layout(requestUrl.searchParams.get("episodeId"), requestUrl.searchParams.get("category")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/stage`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    if (typeof config.episodeMaker.inspectStage !== "function") throw httpError(404, "Story:Side stage inspection is unavailable.");
    sendJson(res, 200, config.episodeMaker.inspectStage(requestUrl.searchParams.get("stageId"), requestUrl.searchParams.get("episodeId"), requestUrl.searchParams.get("category"), requestUrl.searchParams.get("difficulty")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/asset`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    if (typeof config.episodeMaker.asset !== "function") throw httpError(404, "Episode asset preview is unavailable.");
    sendJson(res, 200, config.episodeMaker.asset(requestUrl.searchParams.get("kind"), requestUrl.searchParams.get("id")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/episode-maker/create`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const result = config.episodeMaker.create(await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 201, { ...result, runtimeRebuilt: false });
    return;
  }
  if (pathname === `${apiPath}/episode-maker/preview-asset`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    if (requestUrl.searchParams.get("kind") !== "cafe") throw httpError(404, "Preview asset was not found.");
    serveStaticFile(path.dirname(config.cutsceneCafeBackground), path.basename(config.cutsceneCafeBackground), req, res);
    return;
  }
  if (pathname === `${apiPath}/unit-maker/units`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.unitMaker.catalog(requestUrl.searchParams.get("query"), requestUrl.searchParams.get("type")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/unit-maker/projects`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.unitMaker.projects(), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/unit-maker/unit`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.unitMaker.inspect(String(requestUrl.searchParams.get("id") || "")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/unit-maker/project-unit`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.unitMaker.inspectProjectUnit(String(requestUrl.searchParams.get("projectId") || ""), String(requestUrl.searchParams.get("id") || "")), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/unit-maker/asset`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    const field = String(requestUrl.searchParams.get("field") || "");
    const id = String(requestUrl.searchParams.get("id") || "");
    const assetPath = resolveUnitAssetPreview(field, id, config.assetRoot);
    sendJson(res, 200, { found: Boolean(assetPath), field, id, type: "image", path: assetPath }, req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/unit-maker/voices/extract`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const input = await readJsonRequest(req, MAX_MOD_BODY_BYTES);
    sendJson(res, 200, config.unitMaker.extractVoices(input.unitStrId));
    return;
  }
  if (pathname === `${apiPath}/unit-maker/create`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const result = config.unitMaker.create(await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 201, publishActiveProject(config, result.project.manifest.id, result));
    return;
  }
  if (pathname === `${apiPath}/unit-maker/update`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const result = config.unitMaker.update(await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 200, publishActiveProject(config, result.project.manifest.id, result));
    return;
  }
  if (pathname === `${apiPath}/unit-maker/spine`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const result = config.unitMaker.attachSpine(await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 200, publishActiveProject(config, result.project.manifest.id, result));
    return;
  }
  if (pathname === `${apiPath}/unit-maker/voice-bundle`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const prepared = config.unitMaker.prepareVoiceBundle(await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    const project = config.modStore.readProject(prepared.projectId);
    const bundle = await config.unityCompiler.build(project, { bundleName: prepared.bundleName, assets: prepared.assets, encryptHeader: true, target: "windows" });
    const androidBundle = await config.unityCompiler.build(project, { bundleName: prepared.bundleName, assets: prepared.assets, encryptHeader: true, target: "android" });
    const result = { ...prepared, bundle, androidBundle, project: publicModProject(config, config.modStore.readProject(prepared.projectId)) };
    sendJson(res, 201, publishActiveProject(config, prepared.projectId, result));
    return;
  }
  if (pathname === `${apiPath}/unity-compiler`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.unityCompiler.status(), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/mod-runtime`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, config.modRuntime.status(), req.method === "HEAD");
    return;
  }
  if (pathname === `${apiPath}/mod-runtime/profile`) {
    if (req.method !== "PUT") throw methodNotAllowed(res, "PUT");
    const profile = config.modRuntime.writeProfile(await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 200, { ...config.modRuntime.status(), profile });
    return;
  }
  if (pathname === `${apiPath}/mod-runtime/build`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    sendJson(res, 200, config.modRuntime.build());
    return;
  }
  if (pathname === `${apiPath}/mod-runtime/apply`) {
    if (req.method !== "PUT") throw methodNotAllowed(res, "PUT");
    sendJson(res, 200, config.modRuntime.applyProfile(await readJsonRequest(req, MAX_MOD_BODY_BYTES)));
    return;
  }
  if (pathname === `${apiPath}/mod-runtime/rollback`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    sendJson(res, 200, config.modRuntime.rollback());
    return;
  }
  if (pathname === `${apiPath}/references`) {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    const query = String(requestUrl.searchParams.get("query") || "").trim().toLowerCase();
    if (query.length < 2) throw httpError(400, "Reference search needs at least two characters.");
    const normalized = normalizeRelationValue(query);
    const references = getRelatedTableRows(config).filter((row) => {
      const text = [row.id, row.strId, row.name, row.table, row.type, row.source].join(" ").toLowerCase();
      return text.includes(query) || normalizeRelationValue(text).includes(normalized);
    }).slice(0, 60);
    sendJson(res, 200, { query, references }, req.method === "HEAD");
    return;
  }

  if (pathname === `${apiPath}/mods`) {
    if (req.method === "GET" || req.method === "HEAD") {
      sendJson(res, 200, { projects: config.modStore.listProjects() }, req.method === "HEAD");
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonRequest(req, MAX_MOD_BODY_BYTES);
      sendJson(res, 201, publicModProject(config, config.modStore.createProject(body)));
      return;
    }
    throw methodNotAllowed(res, "GET, HEAD, POST");
  }

  if (pathname === `${apiPath}/mods/import`) {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const archive = await readRequestBody(req, MAX_MOD_BODY_BYTES);
    sendJson(res, 201, publicModProject(config, config.modStore.importProject(archive)));
    return;
  }

  const match = pathname.match(new RegExp(`^${escapeRegExp(apiPath)}/mods/([^/]+)(?:/(.+))?$`));
  if (!match) throw httpError(404, "No mod creator route found.");
  const id = decodeURIComponent(match[1]);
  const action = match[2] || "";

  if (!action) {
    if (req.method === "GET" || req.method === "HEAD") {
      sendJson(res, 200, publicModProject(config, config.modStore.readProject(id)), req.method === "HEAD");
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonRequest(req, MAX_MOD_BODY_BYTES);
      sendJson(res, 200, publicModProject(config, config.modStore.updateManifest(id, body)));
      return;
    }
    if (req.method === "DELETE") {
      sendJson(res, 200, config.modRuntime.deleteProject(id));
      return;
    }
    throw methodNotAllowed(res, "GET, HEAD, PUT, DELETE");
  }

  if (action === "copy") {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const body = await readJsonRequest(req, MAX_MOD_BODY_BYTES);
    const source = config.modStore.listProjects().find((project) => project.id === id);
    const copied = source && source.episodeProject && typeof config.episodeMaker.copyProject === "function"
      ? config.episodeMaker.copyProject(id, body)
      : { project: config.modStore.copyProject(id, body), remapped: [] };
    sendJson(res, 201, { ...publicModProject(config, copied.project), copiedFrom: id, remapped: copied.remapped || [] });
    return;
  }

  if (action === "export") {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    const archive = config.modStore.exportProject(id);
    sendBuffer(res, 200, archive, {
      "Content-Disposition": `attachment; filename="${safeDownloadName(id)}.revivalmod.zip"`,
      "Content-Type": "application/zip",
    }, req.method === "HEAD");
    return;
  }
  if (action === "validate") {
    if (req.method !== "GET" && req.method !== "HEAD") throw methodNotAllowed(res, "GET, HEAD");
    sendJson(res, 200, validateModProject(config, config.modStore.readProject(id)), req.method === "HEAD");
    return;
  }
  if (action === "copy-record") {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const body = await readJsonRequest(req, MAX_MOD_BODY_BYTES);
    sendJson(res, 201, copyRecordToMod(config, id, body));
    return;
  }
  if (action === "asset-source") {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const file = config.modStore.writeAssetSource(id, requestUrl.searchParams.get("path"), await readRequestBody(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 201, { file });
    return;
  }
  if (action === "asset-replacement") {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const metadata = assetReplacementMetadata(config, requestUrl.searchParams.get("path"));
    const body = await readRequestBody(req, MAX_MOD_BODY_BYTES);
    validateAssetReplacementUpload(metadata, requestUrl.searchParams.get("fileName"), body);
    const replacement = config.modStore.writeAssetReplacement(id, metadata, body);
    const project = config.modStore.readProject(id);
    sendJson(res, 201, {
      replacement,
      bundleAssets: project.assetReplacements.filter((entry) => entry.bundleName === replacement.bundleName).map((entry) => entry.source.replace(/^assets\/source\//, "")),
      spriteAssets: project.assetReplacements.filter((entry) => entry.bundleName === replacement.bundleName && entry.unityType === "Sprite").map((entry) => entry.source.replace(/^assets\/source\//, "")),
      project: publicModProject(config, project),
    });
    return;
  }
  if (action === "unity-build") {
    if (req.method !== "POST") throw methodNotAllowed(res, "POST");
    const result = await config.unityCompiler.build(config.modStore.readProject(id), await readJsonRequest(req, MAX_MOD_BODY_BYTES));
    sendJson(res, 201, publishActiveProject(config, id, result));
    return;
  }
  if (action === "patch") {
    if (req.method === "GET" || req.method === "HEAD") {
      const patch = getRequiredModPatch(config, id, requestUrl.searchParams.get("patchId"));
      sendJson(res, 200, buildModPatchDetail(config, patch), req.method === "HEAD");
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonRequest(req, MAX_MOD_BODY_BYTES);
      sendJson(res, 200, saveModPatch(config, id, body));
      return;
    }
    if (req.method === "DELETE") {
      config.modStore.removePatch(id, requestUrl.searchParams.get("patchId"));
      sendJson(res, 200, publicModProject(config, config.modStore.readProject(id)));
      return;
    }
    throw methodNotAllowed(res, "GET, HEAD, PUT, DELETE");
  }
  throw httpError(404, "No mod creator route found.");
}

function publicModProject(config, project) {
  return {
    manifest: project.manifest,
    lock: project.lock,
    patches: project.patches.map((patch) => ({
      patchId: patch.patchId,
      table: patch.table,
      key: patch.key,
      removed: patch.value === null,
      label: patch.value === null ? `Remove ${patch.key.value}` : String(patch.key.value),
    })),
    tables: (project.tables || []).map((table) => ({ tableId: table.tableId, table: table.table })),
    stringCount: Object.keys(project.strings || {}).length,
    assetReplacements: (project.assetReplacements || []).map((replacement) => ({
      ...replacement,
      built: fs.existsSync(path.join(project.root, "assets", "bundles", replacement.bundleName)),
      builtAndroid: fs.existsSync(path.join(project.root, "assets", "android-bundles", replacement.bundleName)),
    })),
    validation: validateModProject(config, project),
  };
}

function publishActiveProject(config, projectId, result) {
  if (!config.modRuntime.readProfile().enabled.includes(projectId)) return { ...result, runtimeRebuilt: false };
  const runtime = config.modRuntime.build();
  return { ...result, runtimeRebuilt: true, runtimeHash: runtime.built.hash, combatHostRefresh: "before-next-battle" };
}

function copyRecordToMod(config, id, input) {
  const table = getRequiredTable(config, input.directory, input.fileName);
  const records = readTableRecords(config, table);
  const index = Number(input.recordIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= records.length) throw httpError(404, "Source record was not found.");
  const sourceValue = records[index];
  if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) throw httpError(422, "Source record is not an object.");
  const sourceKey = inferRecordKey(records, sourceValue, index);
  const duplicate = input.duplicate === true;
  const value = cloneJson(sourceValue);
  let key = { ...sourceKey };
  if (duplicate) {
    const project = config.modStore.readProject(id);
    const used = records.map((record, recordIndex) => recordKeyValue(record, sourceKey.field, recordIndex))
      .concat(project.patches.filter((patch) => sameTable(patch.table, table) && patch.key.field === sourceKey.field).map((patch) => patch.key.value));
    key.value = nextRecordKey(config, id, table, sourceKey, used);
    if (sourceKey.field !== "__index") value[sourceKey.field] = key.value;
  }
  const patch = config.modStore.writePatch(id, {
    table: publicTableEntry(table),
    key,
    source: duplicate ? sourceKey : undefined,
    value,
  });
  return buildModPatchDetail(config, patch);
}

function saveModPatch(config, id, input) {
  const tableInput = input.table || {};
  const table = getRequiredTable(config, tableInput.directory, tableInput.fileName);
  const value = input.value === null ? null : input.value;
  if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) throw httpError(400, "Record JSON must be an object or null.");
  const records = readTableRecords(config, table);
  const previous = input.previousPatchId ? getRequiredModPatch(config, id, input.previousPatchId) : null;
  const fallbackIndex = Number(input.recordIndex);
  const key = input.key && input.key.field ? input.key : previous ? previous.key : inferRecordKey(records, value, fallbackIndex);
  if (key.field !== "__index" && value && !Object.prototype.hasOwnProperty.call(value, key.field)) throw httpError(400, `Record is missing its key field ${key.field}.`);
  const normalizedKey = { field: String(key.field), value: key.field === "__index" ? Number(key.value) : value ? value[key.field] : key.value };
  const patch = config.modStore.writePatch(id, {
    table: publicTableEntry(table),
    key: normalizedKey,
    source: input.source || previous && previous.source,
    value: value === null ? null : cloneJson(value),
  }, input.previousPatchId || "");
  return buildModPatchDetail(config, patch);
}

function getRequiredModPatch(config, id, patchId) {
  const project = config.modStore.readProject(id);
  const patch = project.patches.find((entry) => entry.patchId === patchId);
  if (!patch) throw httpError(404, "Mod patch was not found.");
  return patch;
}

function buildModPatchDetail(config, patch) {
  const table = getRequiredTable(config, patch.table.directory, patch.table.fileName);
  const records = readTableRecords(config, table);
  const comparisonKey = patch.source || patch.key;
  const base = findRecordByKey(records, comparisonKey);
  return {
    patch,
    base,
    baseIndex: base ? records.indexOf(base) : -1,
    changes: diffValues(base, patch.value),
    validation: validateModPatch(config, patch, table, records),
  };
}

function validateModProject(config, project) {
  const errors = [];
  const warnings = [];
  for (const patch of project.patches) {
    let table;
    try { table = getRequiredTable(config, patch.table.directory, patch.table.fileName); }
    catch (err) {
      errors.push({ patchId: patch.patchId, path: "table", message: err.message });
      continue;
    }
    const report = validateModPatch(config, patch, table, readTableRecords(config, table));
    for (const issue of report.errors) errors.push({ ...issue, patchId: patch.patchId });
    for (const issue of report.warnings) warnings.push({ ...issue, patchId: patch.patchId });
  }
  for (const replacement of project.assetReplacements || []) {
    if (!fs.existsSync(path.join(project.root, replacement.source))) errors.push({ path: replacement.targetPath, message: "Asset replacement source is missing." });
    else if (!fs.existsSync(path.join(project.root, "assets", "bundles", replacement.bundleName)) ||
      !fs.existsSync(path.join(project.root, "assets", "android-bundles", replacement.bundleName))) {
      warnings.push({ path: replacement.targetPath, message: `Build Windows and Android variants of ${replacement.bundleName} before loading this replacement in-game.` });
    }
  }
  return { ok: errors.length === 0, errors, warnings, patchCount: project.patches.length };
}

function validateModPatch(_config, patch, _table, records) {
  const errors = [];
  const warnings = [];
  const base = findRecordByKey(records, patch.source || patch.key);
  if (patch.value === null && !findRecordByKey(records, patch.key)) errors.push({ path: "value", message: "Cannot remove a record that does not exist in base data." });
  if (patch.value && patch.key.field !== "__index" && patch.value[patch.key.field] !== patch.key.value) {
    errors.push({ path: patch.key.field, message: `Key must match ${JSON.stringify(patch.key.value)}.` });
  }
  if (patch.value && base) compareValueTypes(base, patch.value, "", errors);
  if (!base && patch.value) warnings.push({ path: patch.key.field, message: "New record: verify every required field and reference before loading this mod." });
  return { ok: errors.length === 0, errors, warnings };
}

function inferRecordKey(records, record, recordIndex) {
  if (!record || typeof record !== "object") throw httpError(400, "An object record is required to infer its key.");
  const candidates = Object.keys(record).filter((key) => ["string", "number"].includes(typeof record[key]))
    .map((key) => ({ key, score: key === "__key" ? 1000 : /strid$/i.test(key) ? 900 : /^m_.*id$/i.test(key) ? 800 : /id$/i.test(key) ? 700 : /name$/i.test(key) ? 500 : 0 }))
    .filter((entry) => entry.score)
    .sort((left, right) => right.score - left.score);
  for (const candidate of candidates) {
    const values = records.map((entry) => entry && entry[candidate.key]).filter((value) => value != null);
    if (new Set(values.map((value) => `${typeof value}:${value}`)).size === values.length) return { field: candidate.key, value: record[candidate.key] };
  }
  if (!Number.isSafeInteger(recordIndex) || recordIndex < 0) throw httpError(422, "This table has no stable record key. Select a base record first.");
  return { field: "__index", value: recordIndex };
}

function nextRecordKey(config, id, table, sourceKey, usedValues) {
  if (typeof sourceKey.value === "number" || sourceKey.field === "__index") {
    const numbers = usedValues.map(Number).filter(Number.isSafeInteger);
    const start = numbers.length ? Math.max(...numbers) + 1 : 1;
    return config.modStore.allocateId(id, `${table.directory}/${table.tableName}:${sourceKey.field}`, numbers.concat(start - 1));
  }
  const used = new Set(usedValues.map(String));
  const root = `${sourceKey.value}_MOD`;
  let value = root;
  let suffix = 2;
  while (used.has(value)) value = `${root}_${suffix++}`;
  return value;
}

function getRequiredTable(config, directory, fileName) {
  const normalizedDirectory = normalizeRelativePath(directory || "");
  const name = normalizeTableBaseName(fileName).toLowerCase();
  const table = getTableFiles(config).find((entry) => entry.directory === normalizedDirectory && entry.tableName.toLowerCase() === name);
  if (!table) throw httpError(404, "Gameplay table was not found.");
  return table;
}

function readTableRecords(config, table) {
  const parsed = readGameplayTable(table.directory, table.fileName, { rootDir: config.rootDir, env: config.env });
  let records = extractTableRecords(parsed);
  if (!records.length && parsed && typeof parsed === "object") records = [parsed];
  return records;
}

function findRecordByKey(records, key) {
  if (!key) return null;
  if (key.field === "__index") return records[Number(key.value)] || null;
  return records.find((record) => record && record[key.field] === key.value) || null;
}

function recordKeyValue(record, field, index) {
  return field === "__index" ? index : record && record[field];
}

function sameTable(left, right) {
  return left.directory === right.directory && normalizeTableBaseName(left.fileName) === normalizeTableBaseName(right.fileName);
}

function compareValueTypes(base, value, prefix, errors) {
  if (!base || !value || typeof base !== "object" || typeof value !== "object") return;
  for (const [key, next] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(base, key) || next == null || base[key] == null) continue;
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const expected = valueType(base[key]);
    const actual = valueType(next);
    if (expected !== actual) errors.push({ path: fieldPath, message: `Expected ${expected}, received ${actual}.` });
    else if (actual === "object") compareValueTypes(base[key], next, fieldPath, errors);
    else if (actual === "array" && base[key][0] && next[0]) compareValueTypes(base[key][0], next[0], `${fieldPath}[]`, errors);
  }
}

function valueType(value) {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function diffValues(before, after, prefix = "", changes = []) {
  if (changes.length >= 500 || stringifyJson(before) === stringifyJson(after)) return changes;
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) diffValues(before[key], after[key], prefix ? `${prefix}.${key}` : key, changes);
  } else {
    changes.push({ path: prefix || "$", before, after });
  }
  return changes;
}

function getRelatedTableRows(config) {
  if (config.relatedTableRows == null) {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.relatedTableIndexPath, "utf8"));
      config.relatedTableRows = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      config.relatedTableRows = [];
    }
  }
  return config.relatedTableRows;
}

function cloneJson(value) {
  return JSON.parse(stringifyJson(value));
}

function safeDownloadName(value) {
  return String(value || "mod").replace(/[^A-Za-z0-9._-]+/g, "-") || "mod";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function methodNotAllowed(res, allow) {
  res.setHeader("Allow", allow);
  return httpError(405, "Method is not allowed for this mod creator route.");
}

function serveSystems(config, req, res) {
  const tables = getTableFiles(config);
  sendJson(res, 200, {
    tableCount: tables.length,
    systems: GAME_SYSTEMS.map((entry) => publicSystem(entry, tables)),
  }, req.method === "HEAD");
}

function serveObjects(config, req, res, requestUrl) {
  const { offset, limit } = readPage(requestUrl);
  const result = config.assetCatalog.list(requestUrl.searchParams.get("type"), requestUrl.searchParams.get("query"), offset, limit);
  sendJson(res, 200, { ...result, limit }, req.method === "HEAD");
}

function serveObject(config, req, res, requestUrl) {
  sendJson(res, 200, config.assetCatalog.inspect(requestUrl.searchParams.get("type"), requestUrl.searchParams.get("id")), req.method === "HEAD");
}

function serveSystemTables(config, req, res, requestUrl) {
  const selected = GAME_SYSTEMS.find((entry) => entry.id === requestUrl.searchParams.get("id"));
  if (!selected) throw httpError(404, "Game system was not found.");
  const query = String(requestUrl.searchParams.get("query") || "").trim().toLowerCase();
  const { offset, limit } = readPage(requestUrl);
  const tables = prioritizeTables(selected, getSystemTables(selected, getTableFiles(config))
    .filter((entry) => !query || entry.searchText.includes(query)), query);
  sendJson(res, 200, {
    system: publicSystem(selected, getTableFiles(config)),
    total: tables.length,
    offset,
    limit,
    tables: tables.slice(offset, offset + limit).map(publicTableEntry),
  }, req.method === "HEAD");
}

function serveFieldSearch(config, req, res, requestUrl) {
  const query = String(requestUrl.searchParams.get("query") || "").trim();
  if (query.length < 2) throw httpError(400, "Describe the value you want to change.");
  const tables = getTableFiles(config);
  const terms = fieldSearchTerms(query);
  const queryTokens = tokenize(query);
  const rankedSystems = GAME_SYSTEMS
    .filter((entry) => entry.id !== "all")
    .map((entry) => ({ entry, score: scoreText(systemSearchText(entry), queryTokens) * 10 }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score);

  const candidates = new Map();
  for (const result of rankedSystems.slice(0, 3)) {
    const systemTables = prioritizeTables(result.entry, getSystemTables(result.entry, tables), query);
    for (const table of systemTables.slice(0, 6)) addFieldCandidate(candidates, table, result.entry, result.score);
  }
  const queryText = query.toLowerCase();
  for (const table of tables) {
    const score = (table.searchText.includes(queryText) ? 12 : 0) + scoreText(table.searchText, queryTokens);
    if (score > 0) addFieldCandidate(candidates, table, findTableSystem(table), score);
  }

  const rankedTables = Array.from(candidates.values())
    .sort((left, right) => right.score - left.score || tablePriority(right.table, right.system) - tablePriority(left.table, left.system))
    .slice(0, MAX_FIELD_TABLES);
  const fields = [];
  for (const candidate of rankedTables) {
    for (const field of getTableSchema(config, candidate.table)) {
      const score = scoreText(`${field.path} ${candidate.table.tableName}`, terms);
      if (!score) continue;
      fields.push({
        ...field,
        score: score + candidate.score,
        system: candidate.system ? candidate.system.title : "Gameplay data",
        table: publicTableEntry(candidate.table),
      });
    }
    if (fields.length >= MAX_FIELD_RESULTS * 2) break;
  }
  fields.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  sendJson(res, 200, {
    query,
    systems: rankedSystems.slice(0, 5).map((result) => ({ ...publicSystem(result.entry, tables), score: result.score })),
    tables: rankedTables.map((candidate) => ({ ...publicTableEntry(candidate.table), system: candidate.system ? candidate.system.title : "Gameplay data" })),
    fields: fields.slice(0, MAX_FIELD_RESULTS),
  }, req.method === "HEAD");
}

function publicSystem(entry, tables) {
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    keywords: entry.keywords,
    commonEdits: entry.commonEdits,
    tableCount: getSystemTables(entry, tables).length,
  };
}

function getSystemTables(entry, tables) {
  if (entry.directories.includes("*")) return tables;
  return tables.filter((table) => entry.directories.includes(table.directory)
    || entry.prefixes.some((prefix) => table.tableName.startsWith(prefix)));
}

function prioritizeTables(entry, tables, query) {
  const terms = tokenize(query);
  return tables.slice().sort((left, right) => {
    const score = (tablePriority(right, entry) - tablePriority(left, entry))
      || (scoreText(right.searchText, terms) - scoreText(left.searchText, terms));
    return score || left.tableName.localeCompare(right.tableName);
  });
}

function tablePriority(table, entry) {
  if (!entry) return 0;
  const index = entry.priorityTables.indexOf(table.tableName);
  if (index >= 0) return 100 - index;
  return entry.directories.includes(table.directory) ? 1 : 10;
}

function findTableSystem(table) {
  return GAME_SYSTEMS.find((entry) => entry.id !== "all" && getSystemTables(entry, [table]).length) || null;
}

function addFieldCandidate(candidates, table, systemEntry, score) {
  const key = `${table.directory}/${table.fileName}`;
  const existing = candidates.get(key);
  if (!existing || existing.score < score) candidates.set(key, { table, system: systemEntry, score });
}

function getTableSchema(config, table) {
  const key = `${table.directory}/${table.fileName}`;
  if (config.tableSchemas.has(key)) return config.tableSchemas.get(key);
  const parsed = readGameplayTable(table.directory, table.fileName, { rootDir: config.rootDir, env: config.env });
  let records = extractTableRecords(parsed);
  if (!records.length && parsed && typeof parsed === "object") records = [parsed];
  const fields = new Map();
  for (const record of records.slice(0, 40)) collectFieldSchema(record, "", fields, 0);
  const schema = Array.from(fields.values());
  config.tableSchemas.set(key, schema);
  return schema;
}

function collectFieldSchema(value, prefix, fields, depth) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) collectFieldSchema(item, `${prefix}[]`, fields, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) collectFieldSchema(child, prefix ? `${prefix}.${key}` : key, fields, depth + 1);
    return;
  }
  if (!prefix || fields.has(prefix)) return;
  fields.set(prefix, { path: prefix, type: typeof value, example: value });
}

function fieldSearchTerms(query) {
  const terms = new Set(tokenize(query));
  for (const term of Array.from(terms)) for (const alias of FIELD_ALIASES[term] || []) terms.add(alias);
  terms.add(normalizeSearchToken(query));
  return Array.from(terms).filter(Boolean);
}

function tokenize(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 1);
}

function normalizeSearchToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function scoreText(value, terms) {
  const normalized = normalizeSearchToken(value);
  const lower = String(value || "").toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) || normalized.includes(normalizeSearchToken(term)) ? Math.max(1, term.length) : 0), 0);
}

function systemSearchText(entry) {
  return [entry.title, entry.description, ...entry.keywords, ...entry.commonEdits.flatMap((item) => [item.label, item.query, item.location])].join(" ").toLowerCase();
}

function serveTables(config, req, res, requestUrl) {
  const query = String(requestUrl.searchParams.get("query") || "").trim().toLowerCase();
  const { offset, limit } = readPage(requestUrl);
  const files = getTableFiles(config).filter((entry) => !query || entry.searchText.includes(query));
  sendJson(res, 200, {
    total: files.length,
    offset,
    limit,
    tables: files.slice(offset, offset + limit).map(publicTableEntry),
  }, req.method === "HEAD");
}

function serveTable(config, req, res, requestUrl) {
  const directory = normalizeRelativePath(requestUrl.searchParams.get("directory") || "");
  const fileName = String(requestUrl.searchParams.get("file") || "");
  const tableName = normalizeTableBaseName(fileName).toLowerCase();
  const entry = getTableFiles(config).find((candidate) => candidate.directory === directory && candidate.tableName.toLowerCase() === tableName);
  if (!entry) throw httpError(404, "Gameplay table was not found.");

  const parsed = readGameplayTable(entry.directory, entry.fileName, { rootDir: config.rootDir, env: config.env });
  if (parsed == null) throw httpError(422, "Gameplay table could not be decoded.");
  let records = extractTableRecords(parsed);
  if (records.length === 0 && parsed && typeof parsed === "object") records = [parsed];
  const unfilteredTotal = records.length;
  let indexedRecords = records.map((record, index) => ({ record, index }));
  const query = String(requestUrl.searchParams.get("query") || "").trim().toLowerCase();
  if (query) indexedRecords = indexedRecords.filter((entry) => stringifyJson(entry.record).toLowerCase().includes(query));
  const { offset, limit } = readPage(requestUrl);
  const page = indexedRecords.slice(offset, offset + limit);

  sendJson(res, 200, {
    table: publicTableEntry(entry),
    total: indexedRecords.length,
    unfilteredTotal,
    offset,
    limit,
    records: page.map((entry) => entry.record),
    recordIndexes: page.map((entry) => entry.index),
  }, req.method === "HEAD");
}

function serveAssetDirectory(config, req, res, requestUrl) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") || "");
  const directoryPath = resolveExistingAssetPath(config.assetRoot, relativePath);
  const stat = fs.statSync(directoryPath);
  if (!stat.isDirectory()) throw httpError(400, "Asset path is not a directory.");

  const query = String(requestUrl.searchParams.get("query") || "").trim().toLowerCase();
  const { offset, limit } = readPage(requestUrl);
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .filter((entry) => !query || entry.name.toLowerCase().includes(query))
    .map((entry) => {
      const childRelativePath = normalizeRelativePath(path.posix.join(relativePath, entry.name));
      const item = {
        name: entry.name,
        path: childRelativePath,
        kind: entry.isDirectory() ? "directory" : "file",
      };
      if (entry.isFile()) {
        item.extension = path.extname(entry.name).toLowerCase();
        item.size = fs.statSync(path.join(directoryPath, entry.name)).size;
        item.assetType = assetTypeFor(childRelativePath, item.extension);
      }
      return item;
    })
    .sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory" ? -1 : 1);

  sendJson(res, 200, {
    path: relativePath,
    parentPath: relativePath ? normalizeRelativePath(path.posix.dirname(relativePath)) : null,
    total: entries.length,
    offset,
    limit,
    entries: entries.slice(offset, offset + limit),
  }, req.method === "HEAD");
}

function serveAssetFile(config, req, res, requestUrl) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") || "");
  if (!relativePath) throw httpError(400, "Asset path is required.");
  const filePath = resolveExistingAssetPath(config.assetRoot, relativePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw httpError(400, "Asset path is not a file.");

  const range = parseByteRange(req.headers.range, stat.size);
  const statusCode = range ? 206 : 200;
  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, stat.size - 1);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": stat.size === 0 ? 0 : end - start + 1,
    "Content-Type": contentTypeFor(filePath),
    "X-Content-Type-Options": "nosniff",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(statusCode, headers);
  if (req.method === "HEAD" || stat.size === 0) {
    res.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).on("error", (err) => res.destroy(err)).pipe(res);
}

function assetReplacementMetadata(config, value) {
  const targetPath = normalizeRelativePath(value || "");
  if (!targetPath) throw httpError(400, "Asset path is required.");
  const filePath = resolveExistingAssetPath(config.assetRoot, targetPath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw httpError(400, "Asset path is not a file.");
  const extension = path.extname(filePath).toLowerCase();
  if (!ALLOWED_SOURCE_EXTENSIONS.has(extension)) throw httpError(415, `This asset type cannot be rebuilt by Unity: ${extension || "extensionless file"}.`);
  const parts = targetPath.split("/");
  const streamingIndex = parts.findIndex((part) => part.toLowerCase() === "streamingassets");
  const bundleName = String(streamingIndex >= 0 ? parts[streamingIndex + 1] : parts[0] && parts[0].toLowerCase() === "assetbundles" ? parts[1] : "").toLowerCase();
  if (!bundleName || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(bundleName)) throw httpError(422, "The source AssetBundle name could not be inferred from this extracted path.");
  const dimensions = extension === ".png" ? pngDimensions(fs.readFileSync(filePath)) : null;
  return {
    targetPath,
    bundleName,
    assetName: path.basename(filePath, extension),
    extension,
    unityType: extension === ".png" ? "Sprite" : "Default",
    assetType: assetTypeFor(targetPath, extension),
    contentType: contentTypeFor(filePath),
    originalBytes: stat.size,
    width: dimensions && dimensions.width || 0,
    height: dimensions && dimensions.height || 0,
  };
}

function validateAssetReplacementUpload(metadata, fileName, body) {
  if (!body || !body.length) throw httpError(400, "Choose a replacement file.");
  const extension = path.extname(String(fileName || "")).toLowerCase();
  if (extension !== metadata.extension) throw httpError(415, `Upload a ${metadata.extension} file so Unity keeps the original asset type and ID.`);
  if (metadata.extension !== ".png") return;
  const dimensions = pngDimensions(body);
  if (!dimensions) throw httpError(415, "The uploaded file is not a valid PNG.");
  if (metadata.width && metadata.height && (dimensions.width !== metadata.width || dimensions.height !== metadata.height)) {
    throw httpError(422, `PNG must be exactly ${metadata.width} x ${metadata.height}; received ${dimensions.width} x ${dimensions.height}.`);
  }
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) || buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

function serveTextPreview(config, req, res, requestUrl) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") || "");
  if (!relativePath) throw httpError(400, "Asset path is required.");
  const filePath = resolveExistingAssetPath(config.assetRoot, relativePath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw httpError(400, "Asset path is not a file.");
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) throw httpError(415, "This asset does not have a text preview.");
  const bytesToRead = Math.min(stat.size, config.maxTextPreviewBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const descriptor = fs.openSync(filePath, "r");
  try {
    fs.readSync(descriptor, buffer, 0, bytesToRead, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  sendJson(res, 200, {
    path: relativePath,
    size: stat.size,
    truncated: stat.size > bytesToRead,
    text: buffer.toString("utf8"),
  }, req.method === "HEAD");
}

function serveSpineSet(config, req, res, requestUrl) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") || "");
  if (!relativePath) throw httpError(400, "Spine asset path is required.");
  const selectedPath = resolveExistingAssetPath(config.assetRoot, relativePath);
  if (!fs.statSync(selectedPath).isFile()) throw httpError(400, "Spine asset path is not a file.");

  const extension = path.extname(selectedPath).toLowerCase();
  if (![".atlas", ".bytes", ".json", ".skel"].includes(extension)) {
    throw httpError(415, "This asset is not a Spine source file.");
  }
  if ((extension === ".bytes" || extension === ".json") && !isSpineSkeletonSource(selectedPath)) {
    sendJson(res, 200, { ready: false, notSpine: true, missing: [] }, req.method === "HEAD");
    return;
  }
  const textAssetDir = path.dirname(selectedPath);
  if (path.basename(textAssetDir).toLowerCase() !== "textasset") {
    sendJson(res, 200, { ready: false, missing: ["Spine TextAsset folder"] }, req.method === "HEAD");
    return;
  }

  const sourceFiles = fs.readdirSync(textAssetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(textAssetDir, entry.name));
  const baseName = path.basename(selectedPath, extension);
  const atlasFiles = sourceFiles.filter((filePath) => path.extname(filePath).toLowerCase() === ".atlas");
  const exactAtlas = atlasFiles.find((filePath) => path.basename(filePath, ".atlas").toLowerCase() === baseName.toLowerCase());
  const atlasPath = extension === ".atlas" ? selectedPath : exactAtlas || (atlasFiles.length === 1 ? atlasFiles[0] : null);
  if (!atlasPath) {
    sendJson(res, 200, { ready: false, missing: ["matching .atlas"] }, req.method === "HEAD");
    return;
  }

  const atlasBaseName = path.basename(atlasPath, ".atlas").toLowerCase();
  let skeletonFiles = sourceFiles.filter(isSpineSkeletonSource);
  if (atlasFiles.length > 1) {
    skeletonFiles = skeletonFiles.filter((filePath) => {
      const candidateExtension = path.extname(filePath).toLowerCase();
      const candidateBaseName = path.basename(filePath, candidateExtension).toLowerCase();
      return filePath === selectedPath || candidateBaseName === atlasBaseName;
    });
  }
  if (isSpineSkeletonSource(selectedPath) && !skeletonFiles.includes(selectedPath)) skeletonFiles.unshift(selectedPath);
  if (skeletonFiles.length === 0) {
    sendJson(res, 200, { ready: false, missing: ["matching .skel or Spine JSON"] }, req.method === "HEAD");
    return;
  }

  const pageNames = readSpineAtlasPages(atlasPath);
  if (pageNames.length === 0) {
    sendJson(res, 200, { ready: false, missing: ["atlas PNG page"] }, req.method === "HEAD");
    return;
  }
  const bundleRoot = path.dirname(textAssetDir);
  const pngFiles = findFilesByName(bundleRoot, pageNames);
  const missingPages = pageNames.filter((name) => !pngFiles.has(name.toLowerCase()));
  if (missingPages.length) {
    sendJson(res, 200, { ready: false, missing: missingPages.map((name) => `atlas page ${name}`) }, req.method === "HEAD");
    return;
  }

  const files = [
    ...skeletonFiles.map((filePath) => ({
      path: assetRelativePath(config.assetRoot, filePath),
      name: spineSkeletonFileName(filePath),
      role: "skeleton",
    })),
    { path: assetRelativePath(config.assetRoot, atlasPath), name: path.basename(atlasPath), role: "atlas" },
    ...pageNames.map((name) => ({
      path: assetRelativePath(config.assetRoot, pngFiles.get(name.toLowerCase())),
      name,
      role: "texture",
    })),
  ];
  sendJson(res, 200, { ready: true, files }, req.method === "HEAD");
}

function serveRelated(config, req, res, requestUrl) {
  const relativePath = normalizeRelativePath(requestUrl.searchParams.get("path") || "");
  if (!relativePath) throw httpError(400, "Asset path is required.");
  const selectedPath = resolveExistingAssetPath(config.assetRoot, relativePath);
  const stat = fs.statSync(selectedPath);
  if (!stat.isFile()) throw httpError(400, "Asset path is not a file.");

  const terms = new Set();
  const ids = new Set();
  const pathIds = new Set();
  addRelationTerm(terms, path.basename(selectedPath, path.extname(selectedPath)));
  if (path.extname(selectedPath).toLowerCase() === ".json" && stat.size <= config.maxTextPreviewBytes) {
    try {
      collectRelationValues(JSON.parse(fs.readFileSync(selectedPath, "utf8")), "", terms, ids, pathIds);
    } catch (_) {}
  }

  const bundleRoot = findBundleRoot(config.assetRoot, selectedPath);
  const objectIndex = bundleRoot && readObjectIndex(config, bundleRoot);
  const indexedObjects = objectIndex && Array.isArray(objectIndex.objects) ? objectIndex.objects : [];
  const indexByPathId = new Map(indexedObjects.map((object) => [String(object.path_id), object]));
  const files = [];
  const unityObjects = [];
  const seenFiles = new Set([fs.realpathSync(selectedPath)]);
  const selectedStem = normalizeRelationValue(path.basename(selectedPath, path.extname(selectedPath)));

  if (bundleRoot && selectedStem) {
    for (const match of findBundleFiles(bundleRoot, (filePath) => normalizeRelationValue(path.basename(filePath, path.extname(filePath))) === selectedStem)) {
      addRelatedFile(config, files, seenFiles, match, "Same Unity asset name");
    }
  }

  for (const pathId of pathIds) {
    const object = indexByPathId.get(pathId);
    if (!object) continue;
    if (object.name) addRelationTerm(terms, object.name);
    const filePath = bundleRoot && findObjectFile(bundleRoot, object);
    if (filePath) addRelatedFile(config, files, seenFiles, filePath, `Unity reference · ${object.type}`);
    else unityObjects.push({
      name: object.name || `${object.type} ${pathId}`,
      assetType: `Unity ${object.type}`,
      pathId,
      relation: "Unity object reference",
    });
    if (files.length + unityObjects.length >= MAX_RELATED_RESULTS) break;
  }

  sendJson(res, 200, {
    path: relativePath,
    assets: files.slice(0, MAX_RELATED_RESULTS),
    unityObjects: unityObjects.slice(0, MAX_RELATED_RESULTS),
    tables: findRelatedTables(config, terms, ids),
  }, req.method === "HEAD");
}

function collectRelationValues(value, key, terms, ids, pathIds, depth = 0) {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRelationValues(item, key, terms, ids, pathIds, depth + 1);
    return;
  }
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "m_PathID") && Number(value.m_FileID || 0) === 0 && Number(value.m_PathID) !== 0) {
      pathIds.add(String(value.m_PathID));
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      collectRelationValues(childValue, childKey, terms, ids, pathIds, depth + 1);
    }
    return;
  }
  if (/pathid|fileid/i.test(key)) return;
  const relevantKey = /id|name|str|key|asset|icon|prefab|resource|texture|sprite|audio|stage|unit|item|episode|dungeon/i.test(key);
  if (typeof value === "number" && relevantKey && Number.isSafeInteger(value) && Math.abs(value) >= 10) ids.add(String(value));
  if (typeof value === "string" && (relevantKey || /^[A-Z][A-Z0-9_./-]{3,}$/i.test(value))) addRelationTerm(terms, value);
}

function addRelationTerm(terms, value) {
  const text = String(value || "").trim();
  if (text.length < 3 || text.length > 180 || terms.size >= 48) return;
  terms.add(text);
  const baseName = path.basename(text, path.extname(text));
  if (baseName !== text && baseName.length >= 3) terms.add(baseName);
}

function normalizeRelationValue(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function findBundleRoot(assetRoot, filePath) {
  const realRoot = fs.realpathSync(assetRoot);
  let current = path.dirname(filePath);
  while (isInside(realRoot, current)) {
    if (fs.existsSync(path.join(current, "ObjectIndex", "objects.json"))) return current;
    if (current === realRoot) break;
    current = path.dirname(current);
  }
  const parts = normalizeRelativePath(path.relative(realRoot, filePath)).split("/");
  if (parts.length < 3) return null;
  const candidate = path.join(realRoot, parts[0], parts[1]);
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
}

function readObjectIndex(config, bundleRoot) {
  const indexPath = path.join(bundleRoot, "ObjectIndex", "objects.json");
  if (!fs.existsSync(indexPath)) return null;
  if (!config.objectIndexes.has(indexPath)) {
    try { config.objectIndexes.set(indexPath, JSON.parse(fs.readFileSync(indexPath, "utf8"))); }
    catch (_) { config.objectIndexes.set(indexPath, null); }
  }
  return config.objectIndexes.get(indexPath);
}

function findObjectFile(bundleRoot, object) {
  if (!object.name) return null;
  const wanted = normalizeRelationValue(object.name);
  const directories = [
    path.join(bundleRoot, "TypeTree", object.type),
    path.join(bundleRoot, object.type),
    path.join(bundleRoot, `${object.type}Meta`),
  ];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    const match = fs.readdirSync(directory, { withFileTypes: true }).find((entry) => entry.isFile()
      && normalizeRelationValue(path.basename(entry.name, path.extname(entry.name))) === wanted);
    if (match) return path.join(directory, match.name);
  }
  return null;
}

function findBundleFiles(bundleRoot, predicate) {
  const found = [];
  const stack = [bundleRoot];
  while (stack.length && found.length < MAX_RELATED_RESULTS) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "ObjectIndex") continue;
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && predicate(filePath)) found.push(filePath);
    }
  }
  return found;
}

function addRelatedFile(config, files, seenFiles, filePath, relation) {
  const realPath = fs.realpathSync(filePath);
  if (seenFiles.has(realPath) || files.length >= MAX_RELATED_RESULTS) return;
  seenFiles.add(realPath);
  const extension = path.extname(realPath).toLowerCase();
  const relativePath = assetRelativePath(config.assetRoot, realPath);
  files.push({
    name: path.basename(realPath),
    path: relativePath,
    kind: "file",
    extension,
    size: fs.statSync(realPath).size,
    assetType: assetTypeFor(relativePath, extension),
    relation,
  });
}

function findRelatedTables(config, terms, ids) {
  const normalizedTerms = Array.from(terms, normalizeRelationValue).filter((term) => term.length >= 3);
  const matches = [];
  const seen = new Set();
  for (const row of getRelatedTableRows(config)) {
    let matchedBy = ids.has(String(row.id)) ? `${row.idField || "ID"} ${row.id}` : "";
    if (!matchedBy) {
      for (const field of ["strId", "image", "name", "type"]) {
        const value = normalizeRelationValue(row[field]);
        const term = normalizedTerms.find((candidate) => value === candidate
          || (candidate.length >= 8 && value.length >= 8 && (value.endsWith(candidate) || candidate.endsWith(value))));
        if (term) {
          matchedBy = `${field} ${row[field]}`;
          break;
        }
      }
    }
    if (!matchedBy) continue;
    const key = `${row.source || row.table}|${row.id}|${row.strId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ ...row, matchedBy });
    if (matches.length >= MAX_RELATED_RESULTS) break;
  }
  return matches;
}

function isSpineSkeletonSource(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".skel") return true;
  if (extension !== ".json" && extension !== ".bytes") return false;
  try {
    const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trimStart();
    if (!text.startsWith("{")) return false;
    const parsed = JSON.parse(text);
    return Boolean(parsed && parsed.skeleton && (parsed.bones || parsed.slots || parsed.animations));
  } catch (_) {
    return false;
  }
}

function spineSkeletonFileName(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".bytes" ? `${path.basename(filePath, extension)}.json` : path.basename(filePath);
}

function readSpineAtlasPages(atlasPath) {
  return Array.from(new Set(fs.readFileSync(atlasPath, "utf8")
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes(":") && line.toLowerCase().endsWith(".png"))));
}

function findFilesByName(root, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const found = new Map();
  const stack = [root];
  while (stack.length && found.size < wanted.size) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && wanted.has(entry.name.toLowerCase()) && !found.has(entry.name.toLowerCase())) {
        found.set(entry.name.toLowerCase(), filePath);
      }
    }
  }
  return found;
}

function assetRelativePath(assetRoot, filePath) {
  return normalizeRelativePath(path.relative(fs.realpathSync(assetRoot), fs.realpathSync(filePath)));
}

function assetTypeFor(relativePath, extension) {
  if (extension === ".png") return "Image";
  if (extension === ".wav") return "Audio";
  if (extension === ".skel") return "Spine skeleton";
  if (extension === ".atlas") return "Spine atlas";
  if (extension === ".bytes") return "TextAsset bytes";
  const parts = normalizeRelativePath(relativePath).split("/");
  const typeTreeIndex = parts.indexOf("TypeTree");
  if (typeTreeIndex >= 0 && parts[typeTreeIndex + 1]) return `Unity ${parts[typeTreeIndex + 1]}`;
  const metadataType = parts.find((part) => /^(Sprite|Texture2D)Meta$/.test(part));
  if (metadataType) return `Unity ${metadataType.replace(/Meta$/, "")} metadata`;
  const resourceType = parts.find((part) => UNITY_RESOURCE_TYPES.has(part));
  if (resourceType) return resourceType;
  if (parts.includes("ObjectIndex")) return "Unity object index";
  return extension ? extension.slice(1).toUpperCase() : "File";
}

function serveStaticFile(staticRoot, requestedPath, req, res) {
  const relativePath = normalizeRelativePath(requestedPath) || "index.html";
  const filePath = resolveExistingPath(staticRoot, relativePath, "SpineViewer build");
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw httpError(404, "SpineViewer file was not found.");
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": stat.size,
    "Content-Type": staticContentTypeFor(filePath),
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(filePath).on("error", (err) => res.destroy(err)).pipe(res);
}

function getTableFiles(config) {
  if (!config.tableFiles) {
    config.tableFiles = listGameplayTableFiles({ rootDir: config.rootDir, env: config.env }).map((entry) => ({
      ...entry,
      searchText: `${entry.tableName} ${entry.directory} ${entry.relativePath}`.toLowerCase(),
    }));
  }
  return config.tableFiles;
}

function publicTableEntry(entry) {
  return {
    directory: entry.directory,
    fileName: entry.fileName,
    relativePath: entry.relativePath,
    tableName: entry.tableName,
    format: entry.extension.replace(/^\./, ""),
  };
}

function resolveExistingAssetPath(assetRoot, relativePath) {
  return resolveExistingPath(assetRoot, relativePath, "Extracted asset root");
}

function resolveExistingPath(root, relativePath, label) {
  if (!fs.existsSync(root)) throw httpError(404, `${label} is not available.`);
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, relativePath || ".");
  if (!isInside(realRoot, candidate) || !fs.existsSync(candidate)) throw httpError(404, `${label} path was not found.`);
  const realCandidate = fs.realpathSync(candidate);
  if (!isInside(realRoot, realCandidate)) throw httpError(403, `${label} path leaves its root.`);
  return realCandidate;
}

function openFileLocation(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", ["/select,", filePath], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function readPage(requestUrl) {
  const offset = Math.max(0, Number.parseInt(requestUrl.searchParams.get("offset") || "0", 10) || 0);
  const requestedLimit = Number.parseInt(requestUrl.searchParams.get("limit") || String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedLimit || DEFAULT_PAGE_SIZE));
  return { offset, limit };
}

function parseByteRange(value, size) {
  if (!value || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) throw httpError(416, "Invalid byte range.");
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    throw httpError(416, "Requested byte range is not satisfiable.");
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

function contentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".wav": return "audio/wav";
    case ".mp3": return "audio/mpeg";
    case ".ogg": return "audio/ogg";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".json": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function staticContentTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".map":
    case ".json": return "application/json; charset=utf-8";
    default: return contentTypeFor(filePath);
  }
}

function normalizeBasePath(value) {
  const text = String(value || "/mod-side").trim() || "/mod-side";
  return (text.startsWith("/") ? text : `/${text}`).replace(/\/+$/, "") || "/mod-side";
}

function matchesBasePath(pathname, basePath) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function isLoopback(remoteAddress) {
  const remote = String(remoteAddress || "");
  return remote === "::1" || remote === "127.0.0.1" || remote === "::ffff:127.0.0.1" || /^127\./.test(remote) || /^::ffff:127\./.test(remote);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function stringifyJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function sendHtml(res, html, headOnly = false) {
  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; frame-src 'self' http://127.0.0.1:5185; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(headOnly ? undefined : html);
}

function sendJson(res, statusCode, value, headOnly = false) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(headOnly ? undefined : `${stringifyJson(value)}\n`);
}

function sendBuffer(res, statusCode, buffer, headers = {}, headOnly = false) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": buffer.length,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(headOnly ? undefined : buffer);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(httpError(400, err.message)));
  });
}

async function readJsonRequest(req, maxBytes) {
  const body = await readRequestBody(req, maxBytes);
  try { return JSON.parse(body.toString("utf8") || "null"); }
  catch (err) { throw httpError(400, `Invalid JSON: ${err.message}`); }
}

function buildReactUiHtml(config, product) {
  const indexPath = path.join(config.uiRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mod:Side build required</title></head><body><main><h1>Mod:Side build required</h1><p>Run npm --prefix modside-ui install and npm --prefix modside-ui run build.</p></main></body></html>`;
  }
  const title = { mod: "Mod:Side", assets: "Asset:Side", story: "Story:Side", units: "Unit:Side", combat: "Combat:Side" }[product] || "Mod:Side";
  return fs.readFileSync(indexPath, "utf8")
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replaceAll("/mod-side/ui/", `${config.basePath}/ui/`)
    .replace("</head>", `<meta name="modside-base" content="${config.basePath}"></head>`);
}

function buildLegacyAssetViewerHtml(basePath, product = "mod") {
  const productTitle = { mod: "Mod:Side", assets: "Asset:Side", story: "Story:Side", units: "Unit:Side", combat: "Combat:Side" }[product] || "Mod:Side";
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${productTitle}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#0a1018; color:#e8eef7; }
    * { box-sizing:border-box; }
    body { margin:0; height:100vh; min-height:100vh; overflow:hidden; display:flex; flex-direction:column; background:radial-gradient(circle at 12% -8%,#272049 0,transparent 32%),#090f17; }
    button,input,select { font:inherit; }
    button { color:inherit; }
    header { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin:.75rem 1.25rem 0; padding:.75rem .9rem; border:1px solid #2c3850; border-radius:.9rem; background:radial-gradient(circle at 8% 0,#2e2653 0,transparent 38%),#101824e8; box-shadow:0 12px 36px #0005,inset 0 1px #ffffff0d; backdrop-filter:blur(14px); }
    h1 { margin:0; font-size:1.05rem; letter-spacing:.04em; }
    a { color:inherit; }
    .brand { display:flex; align-items:center; gap:.75rem; color:inherit; text-decoration:none; }
    .brand-mark,.app-icon { display:grid; place-items:center; flex:none; overflow:hidden; border-radius:.65rem; color:white; box-shadow:inset 0 1px #fff3,0 8px 22px #0005; }
    .brand-mark { width:2.25rem; height:2.25rem; background:linear-gradient(145deg,#735cff,#c64ee7); }
    .brand-mark svg { width:1.25rem; height:1.25rem; }
    .header-actions { display:flex; align-items:center; gap:.65rem; }
    .home-link { display:flex; align-items:center; gap:.35rem; padding:.42rem .65rem; border:1px solid #3a4059; border-radius:.55rem; color:#d8d2f7; background:#191b2caa; text-decoration:none; font-size:.78rem; }
    .home-link svg,.tab svg { width:1rem; height:1rem; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    body[data-product="mod"] .home-link { display:none; }
    .subtle { color:#8fa1b7; font-size:.78rem; }
    .badge { padding:.3rem .55rem; border:1px solid #514c70; border-radius:999px; color:#c9c0f8; background:#211d37; font-size:.72rem; font-weight:700; text-transform:uppercase; }
    .tabs { align-self:flex-start; display:flex; gap:.25rem; margin:.55rem 1.25rem 0; padding:.3rem; border:1px solid #2c3850; border-radius:.75rem; background:#101824d9; box-shadow:0 10px 28px #0004; }
    .subtabs { padding-top:.5rem; }
    .tab { display:flex; align-items:center; gap:.42rem; border:1px solid transparent; background:transparent; border-radius:.5rem; padding:.48rem .75rem; color:#aab6c8; cursor:pointer; }
    .pager button { border:1px solid #2a3a4d; background:#111c29; border-radius:.5rem; padding:.5rem .75rem; cursor:pointer; }
    .tab:hover { color:#f3f0ff; background:#ffffff0a; }
    .tab.active { border-color:#6e5ca266; background:linear-gradient(145deg,#322a55,#24203e); color:#ded7ff; box-shadow:inset 0 1px #fff1,0 5px 14px #0003; }
    .workspace { flex:1; min-height:0; padding:.75rem 1.25rem 1.25rem; }
    .panel { height:100%; min-height:0; max-height:100%; border:1px solid #263445; border-radius:.75rem; overflow:hidden; background:#0d151f; box-shadow:0 18px 50px #0006; }
    .hub-panel { height:100%; overflow:auto; padding:clamp(1.25rem,4vw,3.5rem); border:1px solid #263445; border-radius:1rem; background:radial-gradient(circle at 75% 5%,#2d235c88,transparent 34%),linear-gradient(145deg,#111a28,#0b111a 58%); box-shadow:0 18px 50px #0006; }
    .hub-content { width:min(1120px,100%); margin:0 auto; }
    .hub-kicker { margin:0 0 .55rem; color:#a99cff; font-size:.7rem; font-weight:800; letter-spacing:.14em; text-transform:uppercase; }
    .hub-title { max-width:720px; margin:0; font-size:clamp(2rem,5vw,4.2rem); line-height:.96; letter-spacing:-.055em; }
    .hub-copy { max-width:620px; margin:1rem 0 2rem; color:#9babc0; font-size:1rem; line-height:1.55; }
    .hub-heading { display:flex; align-items:end; justify-content:space-between; gap:1rem; margin:1.7rem 0 .7rem; }
    .hub-heading h2 { margin:0; font-size:.92rem; }
    .app-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.85rem; }
    .app-grid.tools { grid-template-columns:repeat(3,minmax(0,1fr)); }
    .app-card { display:flex; align-items:center; gap:1rem; min-width:0; padding:1rem; border:1px solid #303a50; border-radius:.85rem; background:linear-gradient(145deg,#141d2b,#101722); color:inherit; text-align:left; text-decoration:none; cursor:pointer; transition:transform .14s ease,border-color .14s ease,background .14s ease; }
    .app-card:hover,.app-card:focus-visible { transform:translateY(-2px); border-color:#776aa3; background:linear-gradient(145deg,#1b2540,#141c2b); outline:none; }
    .app-card.core { min-height:116px; padding:1.2rem; }
    .app-icon { width:3.2rem; height:3.2rem; padding:.78rem; }
    .app-icon svg { display:block; width:100%; height:100%; max-width:100%; max-height:100%; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
    .app-card.core .app-icon { width:4rem; height:4rem; }
    .app-card.core .app-icon { padding:1rem; }
    .app-icon.creator { background:linear-gradient(145deg,#7b58ff,#b742e4); }
    .app-icon.loader { background:linear-gradient(145deg,#f37c45,#d13e70); }
    .app-icon.assets { background:linear-gradient(145deg,#17a8c7,#2869d8); }
    .app-icon.story { background:linear-gradient(145deg,#e1508e,#8a4bd7); }
    .app-icon.units { background:linear-gradient(145deg,#29a67e,#19718e); }
    .app-icon.combat { background:linear-gradient(145deg,#f1a23f,#d94a45); }
    .combat-panel { height:100%; min-height:0; overflow:hidden; }
    .combat-frame { display:block; width:100%; height:100%; border:0; background:#080d14; }
    .app-card strong,.app-card span { display:block; }
    .app-card strong { font-size:.95rem; }
    .app-card .subtle { margin-top:.25rem; line-height:1.35; }
    .atlas-layout { display:grid; grid-template-columns:minmax(330px,1.05fr) minmax(260px,.75fr) minmax(360px,1.2fr); }
    .tables-grid { display:grid; grid-template-columns:minmax(250px,28%) minmax(260px,30%) minmax(320px,1fr); }
    .assets-layout { display:grid; grid-template-columns:clamp(260px,27vw,340px) minmax(0,1fr); }
    .objects-layout { display:grid; grid-template-columns:clamp(300px,30vw,400px) minmax(0,1fr); }
    .creator-layout { display:grid; grid-template-columns:280px minmax(300px,34%) minmax(420px,1fr); }
    .loader-layout { display:grid; grid-template-columns:minmax(320px,38%) minmax(420px,1fr); }
    .unit-layout { display:grid; grid-template-columns:320px minmax(560px,1fr); }
    .episode-layout { display:block; }
    .episode-studio { height:100%; min-height:0; display:grid; grid-template-columns:minmax(680px,1fr) clamp(430px,26vw,500px); }
    .episode-main { min-width:0; min-height:0; display:flex; flex-direction:column; border-right:1px solid #263445; }
    .episode-topbar { display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; padding:.5rem .75rem; border-bottom:1px solid #223040; background:#0f1823; }
    .episode-topbar .spacer { flex:1; }
    .episode-topbar .tab { border-color:transparent; background:transparent; }
    .episode-topbar .tab.active { border-color:#3b8f82; background:#142c29; }
    .episode-project-strip { display:grid; grid-template-columns:minmax(170px,1.1fr) minmax(105px,.6fr) 125px minmax(170px,1fr) minmax(160px,.9fr) minmax(170px,1fr); gap:.55rem; padding:.6rem .75rem; border-bottom:1px solid #223040; background:#0c141e; }
    .episode-project-strip label,.episode-form-grid label { color:#7f92a8; font-size:.63rem; letter-spacing:.02em; }
    .episode-project-strip input,.episode-project-strip select,.episode-form-grid input,.episode-form-grid select,.episode-form-grid textarea { margin:.2rem 0 0; }
    .episode-project-strip select,.episode-form-grid select { width:100%; padding:.5rem .6rem; border:1px solid #30445a; border-radius:.45rem; background:#09111a; color:#f4f7fb; }
    .episode-project-strip button { width:100%; margin-top:.2rem; }
    .episode-canvas-shell { flex:1; min-height:280px; overflow:hidden; display:flex; align-items:center; justify-content:center; padding:.75rem; background:#070c12; }
    .episode-canvas { position:relative; width:100%; max-height:100%; aspect-ratio:16/9; overflow:hidden; border:1px solid #263445; border-radius:.55rem; background:#05090e; box-shadow:0 14px 42px #0008; }
    .episode-canvas canvas { display:block; width:100%; height:100%; }
    .episode-stage-pan { touch-action:none; cursor:grab; }
    .episode-stage-pan:active { cursor:grabbing; }
    .stage-node-labels { position:absolute; inset:0; pointer-events:none; }
    .stage-node-label { position:absolute; display:grid; place-items:center; padding:.25rem; color:#e8eef7; font-size:.64rem; font-weight:800; text-align:center; text-shadow:0 1px 3px #000; overflow:hidden; }
    .stage-node-label.base { color:#a9bbcf; }
    .stage-node-label.drop-target { color:#fff; outline:2px solid #78e7cf; outline-offset:-2px; border-radius:.35rem; }
    .canvas-selection { position:absolute; border:2px solid #75ead4; border-radius:.35rem; box-shadow:0 0 0 2px #062a24aa,0 0 24px #55ceb977; pointer-events:none; }
    .episode-inspectors { min-width:0; min-height:0; display:grid; grid-template-rows:minmax(250px,.9fr) minmax(320px,1.1fr); background:#0b131d; }
    .episode-inspector { min-height:0; display:flex; flex-direction:column; border-bottom:1px solid #263445; }
    .episode-inspector:last-child { border-bottom:0; }
    .episode-inspector > .toolbar { min-height:48px; padding:.65rem .9rem; display:flex; align-items:center; border-bottom-color:#223040; background:#101923; }
    .episode-inspector > .toolbar .subtle { display:none; }
    .episode-inspector-body { flex:1; min-height:0; overflow:auto; padding:.8rem .9rem; scrollbar-gutter:stable; }
    .episode-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:.7rem .75rem; align-content:start; }
    .episode-form-grid .wide { grid-column:1/-1; }
    .episode-form-grid .button-row { grid-column:1/-1; }
    .episode-form-grid input,.episode-form-grid select,.episode-form-grid textarea { border-color:#293b4e; background:#08111a; }
    .episode-form-grid textarea { min-height:5rem; font:inherit; line-height:1.45; }
    .inspector-group { grid-column:1/-1; border:1px solid #26384a; border-radius:.45rem; background:#0a121b; }
    .inspector-group > summary { padding:.55rem .65rem; color:#b8cadc; font-size:.72rem; font-weight:800; cursor:pointer; list-style-position:inside; }
    .inspector-group > .episode-form-grid { padding:0 .65rem .65rem; }
    .episode-timeline { flex:0 0 132px; min-height:0; border-top:1px solid #263445; background:#0b131d; }
    .timeline-bar { height:36px; display:flex; align-items:center; gap:.45rem; padding:.35rem .65rem; border-bottom:1px solid #263445; }
    .timeline-bar .spacer { flex:1; }
    .scene-list { height:96px; overflow-x:auto; overflow-y:hidden; padding:.55rem; display:flex; gap:.5rem; }
    .scene-card { flex:0 0 190px; min-width:0; border:1px solid #223244; border-radius:.5rem; padding:.55rem; background:#0e1823; cursor:pointer; text-align:left; }
    .scene-card.active { border-color:#43b8a6; box-shadow:0 0 0 1px #43b8a633; }
    .scene-card strong,.scene-card span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .scene-card span { margin-top:.25rem; color:#8093aa; font-size:.65rem; }
    .scene-check { display:flex; align-items:center; gap:.4rem; color:#d7e5f5 !important; }
    .scene-check input { width:auto; margin:0; }
    .cutscene-stage { position:relative; width:100%; height:100%; overflow:hidden; background:#05090e; }
    .cutscene-stage canvas { display:block; width:100%; height:100%; }
    .cutscene-dialogue { position:absolute; left:4%; right:4%; bottom:4%; min-height:28%; padding:1rem 1.15rem 1rem 5rem; border:1px solid #99dacc88; border-radius:.45rem; background:linear-gradient(90deg,#09121aee,#111c29e8); box-shadow:0 10px 35px #000a; }
    .cutscene-avatar { position:absolute; left:.8rem; top:.8rem; width:3.4rem; height:3.4rem; object-fit:cover; border:1px solid #7bcdbc; border-radius:50%; background:#071019; }
    .cutscene-speaker { color:#8de4d3; font-weight:800; letter-spacing:.03em; }
    .cutscene-text { margin-top:.55rem; font-size:clamp(.78rem,1.4vw,1.05rem); line-height:1.45; }
    .cutscene-effects { position:absolute; top:.75rem; right:.75rem; display:flex; flex-wrap:wrap; justify-content:flex-end; gap:.35rem; }
    .cutscene-effect { padding:.25rem .4rem; border:1px solid #56718d; border-radius:999px; background:#09121acc; color:#b9d0e7; font-size:.62rem; }
    .preview-controls { display:flex; align-items:center; justify-content:center; gap:.5rem; padding:.45rem; border-top:1px solid #223040; background:#0c141e; }
    .episode-studio button { display:inline-flex; align-items:center; justify-content:center; gap:.35rem; }
    .episode-studio .icon-only { width:2.35rem; height:2.2rem; padding:0; font-size:1.05rem; }
    .field-asset-preview { grid-column:1/-1; min-height:1.5rem; margin-top:.35rem; display:flex; align-items:center; gap:.45rem; color:#8093aa; font-size:.65rem; overflow:hidden; }
    .field-asset-preview img { width:100%; max-height:9rem; object-fit:contain; object-position:left center; border:1px solid #263445; border-radius:.4rem; background:#05090e; }
    .field-asset-preview audio { width:100%; height:2.1rem; }
    .asset-field-actions { display:flex; gap:.35rem; align-items:center; margin-top:.35rem; }
    .asset-field-actions button { padding:.3rem .5rem; font-size:.65rem; }
    .episode-output { min-height:3rem; max-height:4.5rem; margin-top:.7rem; padding:.5rem .6rem; border:1px solid #223244; border-radius:.45rem; background:#08111a; color:#8fa1b7; font-size:.65rem; white-space:pre-wrap; }
    .unit-form { min-height:0; overflow:auto; padding:.85rem; display:grid; grid-template-columns:1fr 1fr; gap:.65rem; align-content:start; }
    .unit-form label { color:#8093aa; font-size:.7rem; }
    .unit-form input,.unit-form select,.unit-form textarea { margin:.25rem 0 0; }
    .unit-form select { width:100%; padding:.55rem .65rem; border:1px solid #30445a; border-radius:.45rem; background:#09111a; color:#f4f7fb; }
    .unit-form .wide { grid-column:1/-1; }
    .unit-form .check { display:flex; gap:.5rem; align-items:center; color:#d7e5f5; }
    .unit-form .check input { width:auto; margin:0; }
    .unit-spine { border:1px solid #30445a; border-radius:.5rem; padding:.7rem; }
    .unit-spine-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:.6rem; margin:.55rem 0; }
    .unit-output { min-height:6rem; max-height:16rem; border:1px solid #263445; border-radius:.45rem; background:#09111a; }
    .loader-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; gap:.45rem; align-items:center; padding:.65rem .75rem; border-bottom:1px solid #1d2a38; }
    .loader-row input { width:auto; margin:0; }
    .loader-row button { padding:.3rem .45rem; }
    .runtime-summary { padding:1rem; display:grid; gap:.75rem; border-bottom:1px solid #263445; }
    .runtime-summary code { color:#a4f4e6; overflow-wrap:anywhere; }
    .runtime-details { padding:.75rem; display:grid; gap:.55rem; overflow:auto; }
    .asset-focus-section { min-width:0; min-height:0; display:grid; grid-template-columns:230px minmax(0,1fr); }
    .pane { min-width:0; min-height:0; height:100%; border-right:1px solid #263445; display:flex; flex-direction:column; }
    .pane:last-child { border-right:0; }
    .toolbar { padding:.75rem; border-bottom:1px solid #263445; background:#111b27; }
    .toolbar strong { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    input { width:100%; margin-top:.5rem; padding:.55rem .65rem; border:1px solid #30445a; border-radius:.45rem; background:#09111a; color:#f4f7fb; }
    input:focus,button:focus-visible { outline:2px solid #54cdb8; outline-offset:1px; }
    .list { flex:1; min-height:0; overflow:auto; }
    .item { display:block; width:100%; border:0; border-bottom:1px solid #1d2a38; background:transparent; padding:.65rem .75rem; text-align:left; cursor:pointer; }
    .item:hover,.item.active { background:#162536; }
    .item.active { box-shadow:inset 3px 0 #55ceb9; }
    .item-title { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.85rem; }
    .item-meta { display:block; margin-top:.2rem; color:#8093aa; font-size:.69rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .atlas-hero { padding:1rem; border-bottom:1px solid #263445; background:linear-gradient(135deg,#132738,#10211f); }
    .atlas-hero h2 { margin:0 0 .35rem; font-size:1.2rem; }
    .atlas-hero p { margin:0; color:#93a6bc; font-size:.78rem; line-height:1.5; }
    .atlas-search { display:grid; grid-template-columns:1fr auto; gap:.45rem; margin-top:.75rem; }
    .atlas-search input { margin:0; }
    .primary { border:1px solid #43b8a6; border-radius:.45rem; padding:.55rem .75rem; background:#15352f; color:#a4f4e6; cursor:pointer; }
    .system-list { padding:.5rem; }
    .system-card { margin-bottom:.45rem; border:1px solid #263445; border-radius:.55rem; }
    .system-card .item { border-bottom:0; border-radius:.55rem; }
    .system-card .item-title { font-weight:700; }
    .count { float:right; color:#69d6c3; font-size:.7rem; }
    .field-list { padding:.65rem; display:grid; gap:.5rem; align-content:start; }
    .field-result,.edit-target { width:100%; border:1px solid #263445; border-radius:.5rem; padding:.7rem; background:#111b27; color:inherit; text-align:left; cursor:pointer; }
    .field-result:hover,.edit-target:hover { border-color:#43b8a6; background:#15352f; }
    .field-result strong,.field-result span,.field-result code,.edit-target strong,.edit-target span,.edit-target code { display:block; overflow-wrap:anywhere; }
    .field-result strong,.edit-target strong { color:#e8eef7; font-size:.8rem; }
    .field-result span,.edit-target span { margin-top:.22rem; color:#8093aa; font-size:.69rem; }
    .field-result code,.edit-target code { margin-top:.4rem; color:#a4f4e6; font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .system-summary { padding:.8rem; border-bottom:1px solid #263445; }
    .system-summary h2 { margin:0; font-size:1rem; }
    .system-summary p { margin:.35rem 0 0; color:#93a6bc; font-size:.75rem; line-height:1.45; }
    .edit-list { padding:.65rem; display:grid; gap:.45rem; border-bottom:1px solid #263445; max-height:34%; overflow:auto; }
    .section-label { color:#69d6c3; font-size:.68rem; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .compact-form { padding:.65rem; display:grid; gap:.45rem; border-bottom:1px solid #263445; }
    .compact-form input,.compact-form textarea { margin:0; }
    textarea { width:100%; resize:vertical; padding:.6rem; border:1px solid #30445a; border-radius:.45rem; background:#09111a; color:#f4f7fb; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .manifest-form { padding:.75rem; display:grid; grid-template-columns:1fr 1fr; gap:.55rem; border-bottom:1px solid #263445; }
    .manifest-form label { color:#8093aa; font-size:.68rem; }
    .manifest-form input,.manifest-form textarea { margin:.25rem 0 0; font-family:inherit; }
    .manifest-form .wide { grid-column:1/-1; }
    .button-row { display:flex; flex-wrap:wrap; gap:.4rem; }
    .secondary,.danger { border:1px solid #30445a; border-radius:.45rem; padding:.48rem .65rem; background:#111c29; color:inherit; cursor:pointer; }
    .danger { border-color:#75404a; color:#ffb0bb; background:#29151a; }
    .secondary:disabled,.danger:disabled,.primary:disabled { opacity:.4; cursor:default; }
    .creator-editor { flex:1; min-height:0; overflow:auto; padding:.75rem; }
    .editor-fields { display:grid; gap:.5rem; }
    .field-row { display:grid; grid-template-columns:minmax(150px,.8fr) minmax(170px,1fr) auto; gap:.45rem; align-items:center; border-bottom:1px solid #1d2a38; padding:.45rem 0; }
    .field-row label { color:#aebdd0; font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
    .field-row input { margin:0; }
    .field-row.invalid input { border-color:#ff788a; }
    .editor-tabs { display:flex; gap:.4rem; padding:.55rem .75rem; border-bottom:1px solid #263445; background:#111b27; }
    .editor-tabs button.active { border-color:#43b8a6; color:#a4f4e6; }
    .raw-editor { min-height:100%; resize:none; }
    .diff-list,.validation-list { display:grid; gap:.45rem; }
    .diff-entry,.validation-entry { border:1px solid #263445; border-radius:.45rem; padding:.6rem; background:#111b27; }
    .diff-entry code,.validation-entry code { display:block; color:#a4f4e6; font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .validation-entry { width:100%; color:inherit; text-align:left; cursor:pointer; }
    .validation-entry.error { border-color:#75404a; }
    .validation-entry.warning { border-color:#78672d; }
    .reference-picker { position:absolute; inset:3.6rem .75rem .75rem; z-index:4; display:flex; flex-direction:column; border:1px solid #43b8a6; border-radius:.65rem; background:#0d151f; box-shadow:0 20px 60px #000b; overflow:hidden; }
    .reference-results { flex:1; min-height:0; overflow:auto; }
    .relative-pane { position:relative; }
    .record-actions { display:flex; gap:.4rem; margin-top:.55rem; }
    .project-status { padding:.55rem .75rem; border-bottom:1px solid #263445; color:#8fa1b7; font-size:.72rem; }
    .project-status.ok { color:#82e6d2; }
    .project-status.bad { color:#ff9f9f; }
    .pager { display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding:.55rem .75rem; border-top:1px solid #263445; color:#8fa1b7; font-size:.72rem; }
    .pager button:disabled { opacity:.35; cursor:default; }
    pre { flex:1; margin:0; padding:1rem; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; color:#d7e5f5; }
    .empty { display:grid; place-items:center; flex:1; min-height:15rem; padding:2rem; color:#8093aa; text-align:center; }
    .breadcrumbs { display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.5rem; }
    .crumb { border:0; background:transparent; padding:0; color:#69d6c3; cursor:pointer; font-size:.75rem; }
    .preview { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; overflow:auto; padding:1rem; }
    .preview img { max-width:100%; max-height:calc(100vh - 14rem); object-fit:contain; background:#080c12; border-radius:.35rem; }
    .preview audio,.preview video { width:min(760px,100%); }
    .preview pre { align-self:stretch; width:100%; }
    .selected-object { flex:1; min-height:0; overflow:auto; padding:1rem; }
    .selected-card { display:grid; gap:.85rem; align-content:start; }
    .selected-card h2 { margin:0; font-size:1rem; overflow-wrap:anywhere; }
    .selected-type { justify-self:start; padding:.25rem .45rem; border:1px solid #326b64; border-radius:.35rem; color:#82e6d2; background:#102b29; font-size:.7rem; }
    .selected-card dl { display:grid; gap:.75rem; margin:0; }
    .selected-card dt { color:#8093aa; font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; }
    .selected-card dd { margin:.2rem 0 0; font-size:.78rem; overflow-wrap:anywhere; }
    .selected-actions { display:grid; grid-template-columns:1fr 1fr; gap:.45rem; }
    .selected-action { border:1px solid #30445a; border-radius:.45rem; padding:.5rem; background:#111c29; cursor:pointer; }
    .selected-action:hover { border-color:#43b8a6; color:#a4f4e6; }
    .related-preview { align-self:stretch; width:100%; display:grid; gap:1rem; align-content:start; }
    .related-section { display:grid; gap:.5rem; }
    .related-section h3 { margin:0; font-size:.82rem; color:#a4f4e6; }
    .related-entry { display:block; width:100%; border:1px solid #263445; border-radius:.45rem; padding:.65rem; background:#111b27; color:inherit; text-align:left; }
    button.related-entry { cursor:pointer; }
    button.related-entry:hover { border-color:#43b8a6; background:#15352f; }
    .related-entry strong,.related-entry span { display:block; overflow-wrap:anywhere; }
    .related-entry span { margin-top:.2rem; color:#8093aa; font-size:.7rem; }
    .related-entry code { display:block; margin-top:.45rem; color:#d7e5f5; font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
    .object-detail { flex:1; min-height:0; overflow:auto; padding:1rem; }
    .object-summary { display:flex; align-items:center; gap:1rem; margin-bottom:1rem; }
    .object-summary img { width:112px; height:112px; object-fit:contain; border:1px solid #263445; border-radius:.55rem; background:#080c12; }
    .object-summary h2,.object-section h3 { margin:0; }
    .object-section { margin-top:1rem; }
    .object-section h3 { color:#a4f4e6; font-size:.82rem; }
    .object-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:.55rem; margin-top:.55rem; }
    .object-card { border:1px solid #263445; border-radius:.5rem; padding:.7rem; background:#111b27; overflow-wrap:anywhere; }
    .object-card strong,.object-card code,.object-card span { display:block; }
    .object-card code { margin-top:.35rem; color:#d7e5f5; font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; }
    .object-card p { margin:.45rem 0 0; color:#93a6bc; font-size:.72rem; line-height:1.45; }
    .object-card img { max-width:96px; max-height:96px; margin-top:.55rem; object-fit:contain; }
    .object-modbar { flex-wrap:wrap; }
    .object-modbar select { max-width:220px; }
    .object-modbar input[type="text"] { min-width:260px; flex:1; }
    .asset-replacement-editor { margin-bottom:1rem; border:1px solid #43b8a6; border-radius:.55rem; padding:.8rem; background:#10211f; }
    .asset-replacement-editor h3 { margin:0 0 .45rem; }
    .asset-replacement-editor code { display:block; margin:.4rem 0; color:#d7e5f5; font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
    .asset-replacement-editor p { margin:.4rem 0; color:#aebdd0; font-size:.75rem; }
    .spine-frame { align-self:stretch; width:100%; height:100%; min-height:0; border:0; border-radius:.45rem; background:#080c12; }
    .file-link { min-height:0; padding:0; border:0; background:none; color:#69d6c3; text-decoration:underline; }
    .file-link:hover:not(:disabled) { border:0; background:none; }
    .loading-overlay { position:fixed; inset:0; z-index:10000; display:grid; place-items:center; padding:1rem; background:#070a10a8; backdrop-filter:blur(12px) saturate(.7); }
    .loading-dialog { width:min(360px,calc(100vw - 2rem)); padding:1.1rem; border:1px solid #4a426c; border-radius:1rem; background:radial-gradient(circle at 15% 0,#382c65 0,transparent 44%),#111825f2; box-shadow:0 28px 80px #000b,inset 0 1px #ffffff12; }
    .loading-head { display:flex; align-items:center; gap:.8rem; }
    .loading-mark { display:grid; place-items:center; flex:0 0 2.6rem; width:2.6rem; height:2.6rem; border-radius:.7rem; color:white; background:linear-gradient(145deg,#735cff,#c64ee7); box-shadow:inset 0 1px #fff3,0 8px 22px #0006; }
    .loading-mark svg { width:1.25rem; height:1.25rem; }
    .loading-copy { flex:1; min-width:0; }
    .loading-copy strong,.loading-copy span { display:block; }
    .loading-copy strong { overflow:hidden; font-size:.88rem; text-overflow:ellipsis; white-space:nowrap; }
    .loading-copy span { margin-top:.15rem; overflow:hidden; color:#9aa8bd; font-size:.7rem; text-overflow:ellipsis; white-space:nowrap; }
    .loading-percent { flex:none; color:#cfc7fb; font-size:.72rem; font-variant-numeric:tabular-nums; }
    .loading-progress { height:4px; margin-top:1rem; overflow:hidden; border-radius:999px; background:#282c42; }
    .loading-progress span { display:block; width:0; height:100%; border-radius:inherit; background:linear-gradient(90deg,#7560ff,#d04edb); transition:width .12s linear; }
    @media (prefers-reduced-motion:reduce) { .loading-progress span { transition:none; } }
    [hidden] { display:none !important; }
    @media (max-width:900px) {
      .app-grid,.app-grid.tools { grid-template-columns:1fr; }
      .atlas-layout { grid-template-columns:minmax(330px,1fr) minmax(280px,1fr) minmax(380px,1.2fr); overflow-x:auto; }
      .tables-grid { grid-template-columns:1fr; overflow:auto; }
      .tables-grid .pane { min-height:22rem; height:auto; border-right:0; border-bottom:1px solid #263445; }
      .assets-layout { grid-template-columns:260px minmax(590px,1fr); overflow-x:auto; }
      .objects-layout { grid-template-columns:300px minmax(620px,1fr); overflow-x:auto; }
      .creator-layout { grid-template-columns:280px 340px minmax(440px,1fr); overflow-x:auto; }
      .loader-layout { grid-template-columns:340px minmax(520px,1fr); overflow-x:auto; }
      .unit-layout { grid-template-columns:320px minmax(620px,1fr); overflow-x:auto; }
      .episode-studio { grid-template-columns:minmax(680px,1fr) 430px; overflow-x:auto; }
      .episode-project-strip { grid-template-columns:repeat(3,minmax(150px,1fr)); }
      .asset-focus-section { grid-template-columns:210px minmax(380px,1fr); }
    }
  </style>
</head>
<body data-product="${product}">
  <header>
    <a class="brand" href="${basePath}" aria-label="Open Mod:Side hub"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"></rect><rect x="13" y="3" width="8" height="8" rx="2" opacity=".65"></rect><rect x="3" y="13" width="8" height="8" rx="2" opacity=".65"></rect><rect x="13" y="13" width="8" height="8" rx="2"></rect></svg></span><div><h1 id="appTitle">${productTitle}</h1><div id="status" class="subtle">Connecting…</div></div></a>
    <div class="header-actions"><a class="home-link" href="${basePath}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 11 8-7 8 7"></path><path d="M6 10v10h12V10"></path></svg>All apps</a><span class="badge">Base data protected</span></div>
  </header>
  <nav id="modSideTabs" class="tabs" aria-label="Mod:Side workspaces" hidden>
    <button id="homeTab" class="tab active" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 11 8-7 8 7"></path><path d="M6 10v10h12V10"></path></svg>Home</button>
    <button id="creatorTab" class="tab" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"></path><path d="m13.5 6.5 3.5 3.5"></path></svg>Mod creator</button>
    <button id="loaderTab" class="tab" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8 12 4l8 4-8 4z"></path><path d="M4 8v9l8 4 8-4V8"></path><path d="M12 8v9"></path><path d="m9 14 3 3 3-3"></path></svg>Mod loader</button>
  </nav>
  <nav id="assetSideTabs" class="tabs" aria-label="Asset:Side sections" hidden>
    <button id="systemsTab" class="tab active" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="12" cy="18" r="2"></circle><path d="m8 7 3 9M16 7l-3 9M8 6h8"></path></svg>Game systems</button>
    <button id="objectsTab" class="tab" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"></path></svg>Game objects</button>
    <button id="tablesTab" class="tab" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18M9 9v11"></path></svg>Gameplay tables</button>
    <button id="assetsTab" class="tab" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v11H3z"></path><path d="m7 17 3-3 2 2 2-2 3 3"></path></svg>Extracted assets</button>
  </nav>
  <main class="workspace">
    <section id="homePanel" class="hub-panel" hidden>
      <div class="hub-content">
        <p class="hub-kicker">Mod workspace</p>
        <h2 class="hub-title">Build, manage, and launch your mods.</h2>
        <p class="hub-copy">Mod:Side is the home for packaging content and controlling what the private server loads.</p>
        <div class="hub-heading"><h2>Mod:Side</h2><span class="subtle">Core tools</span></div>
        <div class="app-grid">
          <button id="openCreator" class="app-card core" type="button"><span class="app-icon creator" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"></path><path d="m13.5 6.5 3.5 3.5"></path><path d="M5 5h4M7 3v4"></path></svg></span><span><strong>Mod Creator</strong><span class="subtle">Create, validate, and export mod projects</span></span></button>
          <button id="openLoader" class="app-card core" type="button"><span class="app-icon loader" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8 12 4l8 4-8 4z"></path><path d="M4 8v9l8 4 8-4V8"></path><path d="M12 8v9"></path><path d="m9 14 3 3 3-3"></path></svg></span><span><strong>Mod Loader</strong><span class="subtle">Install, activate, and order loaded mods</span></span></button>
        </div>
        <div class="hub-heading"><h2>Side apps</h2><span class="subtle">Specialized workspaces</span></div>
        <div class="app-grid tools">
          <a class="app-card" href="${basePath}/assets"><span class="app-icon assets" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><rect x="14" y="14" width="7" height="7" rx="1.5"></rect></svg></span><span><strong>Asset:Side</strong><span class="subtle">Browse game data and extracted assets</span></span></a>
          <a class="app-card" href="${basePath}/story"><span class="app-icon story" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5.5c3-1 5.5-.5 8 1.5v13c-2.5-2-5-2.5-8-1.5z"></path><path d="M20 5.5c-3-1-5.5-.5-8 1.5v13c2.5-2 5-2.5 8-1.5z"></path></svg></span><span><strong>Story:Side</strong><span class="subtle">Author episodes, stages, and cutscenes</span></span></a>
          <a class="app-card" href="${basePath}/units"><span class="app-icon units" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"></circle><path d="M2.5 21c.5-4 3-6 6.5-6 2 0 3.7.7 4.8 2"></path><path d="M18 13v8M14 17h8"></path></svg></span><span><strong>Unit:Side</strong><span class="subtle">Create complete playable units</span></span></a>
          <a class="app-card" href="${basePath}/combat"><span class="app-icon combat" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 7h14l2 10a2 2 0 0 1-3.4 1.8L15 16H9l-2.6 2.8A2 2 0 0 1 3 17z"></path><path d="M7 11h4M9 9v4"></path><circle cx="16" cy="11" r="1"></circle><circle cx="18" cy="13" r="1"></circle></svg></span><span><strong>Combat:Side</strong><span class="subtle">Build and replay CombatHost battles</span></span></a>
        </div>
      </div>
    </section>
    <section id="systemsPanel" class="panel atlas-layout" hidden>
      <div class="pane">
        <div class="atlas-hero">
          <h2>Game Data Atlas</h2>
          <p>Describe what you want to change. The finder returns the decoded LUAC table, exact nested field, value type, and a real example value.</p>
          <form id="fieldSearchForm" class="atlas-search"><input id="fieldSearch" type="search" placeholder="Try: unit HP, raid entry cost, buff duration" aria-label="Find a gameplay value"><button class="primary" type="submit">Find value</button></form>
        </div>
        <div id="fieldResults" class="list field-list"><div class="empty">Choose a common edit or search for the value you want to change.</div></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong>Systems</strong><span id="systemCount" class="subtle">Loading catalog...</span></div>
        <div id="systemList" class="list system-list"></div>
      </div>
      <div class="pane">
        <div id="systemSummary" class="system-summary"><h2>Select a system</h2><p>Its related LUAC tables and known edit targets appear here.</p></div>
        <div id="systemEdits" class="edit-list"></div>
        <div class="toolbar"><strong id="systemTablesTitle">Related LUAC tables</strong><span class="subtle">Open any decoded table</span></div>
        <div id="systemTableList" class="list"></div>
        <div class="pager"><button id="systemPrev" type="button">Previous</button><span id="systemPage">-</span><button id="systemNext" type="button">Next</button></div>
      </div>
    </section>
    <section id="objectsPanel" class="panel objects-layout" hidden>
      <div class="pane">
        <div class="toolbar"><strong>Game objects</strong><select id="objectType" aria-label="Game object type"><option value="unit">Units</option><option value="ship">Ships</option><option value="operator">Operators</option><option value="gear">Gears</option></select><input id="objectSearch" type="search" placeholder="Search IDs or names" aria-label="Search game objects"></div>
        <div id="objectList" class="list"><div class="empty">Choose an object type.</div></div>
        <div class="pager"><button id="objectPrev" type="button">Previous</button><span id="objectPage">-</span><button id="objectNext" type="button">Next</button></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong id="objectTitle">Object fields and IDs</strong><span id="objectMeta" class="subtle">Select a unit, ship, operator, or gear</span></div>
        <div class="toolbar object-modbar"><select id="objectProject" aria-label="Asset mod project"><option value="">Select asset mod</option></select><button id="objectNewProject" class="secondary" type="button">New mod</button><label class="secondary" style="cursor:pointer">Load mod ZIP<input id="objectImportMod" type="file" accept=".zip,.revivalmod" hidden></label><button id="objectExportMod" class="secondary" type="button" disabled>Export mod ZIP</button><button id="objectBuildAssets" class="secondary" type="button" disabled>Build pending assets</button><input id="objectAssetPath" type="text" placeholder="Extracted asset path for PNG, audio, Spine, or data" aria-label="Extracted asset path"><button id="objectEditAssetPath" class="secondary" type="button">Edit path</button><span id="objectModStatus" class="subtle">Choose or create a mod project.</span></div>
        <div id="objectDetail" class="object-detail"><div class="empty">Every relevant ID appears with its exact field, source table, and purpose.</div></div>
      </div>
    </section>
    <section id="tablesPanel" class="panel tables-grid" hidden>
      <div class="pane">
        <div class="toolbar"><strong>Tables</strong><input id="tableSearch" type="search" placeholder="Search 11,000+ tables" aria-label="Search gameplay tables"></div>
        <div id="tableList" class="list"></div>
        <div class="pager"><button id="tablePrev" type="button">Previous</button><span id="tablePage">—</span><button id="tableNext" type="button">Next</button></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong id="recordTitle">Select a table</strong><span id="recordSource" class="subtle">Records appear here</span><input id="recordSearch" type="search" placeholder="Search selected table" aria-label="Search records" disabled></div>
        <div id="recordList" class="list"><div class="empty">Choose a gameplay table.</div></div>
        <div class="pager"><button id="recordPrev" type="button" disabled>Previous</button><span id="recordPage">—</span><button id="recordNext" type="button" disabled>Next</button></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong id="detailTitle">Record JSON</strong><span class="subtle">Exact decoded value</span><div id="recordActions" class="record-actions" hidden><button id="copyRecord" class="secondary" type="button">Copy to mod</button><button id="duplicateRecord" class="primary" type="button">Add duplicate</button></div></div>
        <pre id="recordJson">Select a record.</pre>
      </div>
    </section>
    <section id="assetsPanel" class="panel assets-layout" hidden>
      <div class="pane">
        <div class="toolbar"><strong>Extracted assets</strong><div id="breadcrumbs" class="breadcrumbs"></div><input id="assetSearch" type="search" placeholder="Filter this folder" aria-label="Filter current asset folder"></div>
        <div id="assetList" class="list"></div>
        <div class="pager"><button id="assetPrev" type="button">Previous</button><span id="assetPage">—</span><button id="assetNext" type="button">Next</button></div>
      </div>
      <section class="asset-focus-section" aria-label="Selected asset workspace">
        <div class="pane">
          <div class="toolbar"><strong>Selected object</strong><span class="subtle">Only the active object</span></div>
          <div id="selectedObject" class="selected-object"><div class="empty">Select an object.</div></div>
        </div>
        <div class="pane">
          <div class="toolbar"><strong id="previewTitle">Asset preview</strong><span id="previewMeta" class="subtle">Select a file</span></div>
          <div id="preview" class="preview"><div class="empty">Images, audio, video, and text metadata can be previewed here.</div></div>
        </div>
      </section>
    </section>
    <section id="episodePanel" class="panel episode-layout" aria-label="Story:Side" hidden>
      <form id="episodeForm" class="episode-studio">
        <div class="episode-main">
          <div class="episode-topbar">
            <button id="episodeDefinitionMode" class="tab" type="button"><span aria-hidden="true">&#9881;</span> Episode</button><button id="episodeStageMode" class="tab active" type="button"><span aria-hidden="true">&#9638;</span> Stages</button><button id="episodeCutsceneMode" class="tab" type="button"><span aria-hidden="true">&#9654;</span> Cutscene</button>
            <span id="episodePreviewMeta" class="subtle">Stage Studio</span><span class="spacer"></span><button id="addEpisodeStage" class="secondary" type="button"><span aria-hidden="true">+</span> Stage</button><button id="sendEpisodeToModside" class="secondary" type="button"><span aria-hidden="true">&#8594;</span> Mod:Side</button><button id="saveEpisode" class="primary" type="submit"><span aria-hidden="true">&#8595;</span> Export ZIP</button>
          </div>
          <div class="episode-project-strip">
            <label>Project<select id="episodeSavedProject"><option value="">New project</option></select></label><label>Open<button id="loadEpisodeProject" class="secondary" type="button"><span aria-hidden="true">&#8599;</span> Open</button></label>
            <label>Category<select id="episodeCategory"><option value="EC_MAINSTREAM">Mainstream</option><option value="EC_SIDESTORY">Substream</option></select></label><label>Episode<select id="episodeSelect"></select></label>
            <label>Project ID<input id="episodeProjectId" required value="my-episode-mod" pattern="[a-z0-9][a-z0-9._-]{1,63}"></label><label>Name<input id="episodeProjectName" required value="My Episode Mod"></label>
          </div>
          <div class="episode-topbar"><span class="section-label">Stage</span><select id="episodeStageSelect" aria-label="Selected stage" style="min-width:220px"></select><span class="spacer"></span><span id="episodeSceneCount" class="subtle">0 frames</span></div>
          <div class="episode-canvas-shell">
            <div id="episodeStageCanvasWrap" class="episode-canvas"><canvas id="episodeStageCanvas" class="episode-stage-pan" width="1280" height="720" aria-label="Stage layout; drag to pan"></canvas><div id="episodeStageLabels" class="stage-node-labels"></div></div>
            <div id="episodeCutsceneCanvasWrap" class="episode-canvas" hidden><div class="cutscene-stage"><canvas id="cutsceneCanvas" width="1280" height="720"></canvas><div id="cutsceneSelection" class="canvas-selection" hidden></div><div id="cutsceneEffects" class="cutscene-effects"></div><div id="cutsceneDialogue" class="cutscene-dialogue"><img id="cutsceneAvatar" class="cutscene-avatar" alt=""><div id="cutsceneSpeaker" class="cutscene-speaker"></div><div id="cutsceneText" class="cutscene-text"></div></div></div></div>
          </div>
          <div class="preview-controls"><button id="episodePrevScene" class="secondary icon-only" type="button" aria-label="Previous" title="Previous">&#8249;</button><button id="episodePlay" class="primary icon-only" type="button" aria-label="Play" title="Play">&#9654;</button><span id="episodeProgress" class="subtle">0 / 0</span><button id="episodeNextScene" class="secondary icon-only" type="button" aria-label="Next" title="Next">&#8250;</button></div>
          <div id="episodeTimeline" class="episode-timeline" hidden><div class="timeline-bar"><strong>Frames</strong><span id="episodeTimelineMeta" class="subtle">0 / 0</span><span class="spacer"></span><button id="addEpisodeScene" class="primary" type="button"><span aria-hidden="true">+</span> Frame</button></div><div id="episodeScenes" class="scene-list"></div></div>
        </div>
        <aside class="episode-inspectors">
          <section class="episode-inspector"><div class="toolbar"><strong id="episodeSelectionTitle">Stage details</strong><span id="episodeSelectionMeta" class="subtle">Select a node or canvas object</span></div><div class="episode-inspector-body">
            <div id="episodeStageDetails" class="episode-form-grid">
              <label class="wide">Title<input id="episodeTitle" required value="New Story Stage"></label><label class="wide">Description<textarea id="episodeDescription" rows="2" required>New Story Stage</textarea></label>
              <label>Difficulty<select id="episodeDifficulty"><option value="NORMAL">Normal</option><option value="HARD">Hard</option></select></label><label>Avatar<input id="episodeStageCharacter" list="episodeStageCharacterOptions" required><div id="episodeStageCharacterPreview" class="field-asset-preview"></div></label>
              <label>Background<input id="episodeBackground" list="episodeBackgrounds" value="CAFE" required><div id="episodeBackgroundPreview" class="field-asset-preview"></div></label><label>Music<input id="episodeMusic" list="episodeMusicOptions" placeholder="Optional BGM asset ID"><div id="episodeMusicPreview" class="field-asset-preview"></div></label>
              <label>Act art<input id="episodeActBackground"><div id="episodeActBackgroundPreview" class="field-asset-preview"></div></label><label>Episode art<input id="episodeThumbnail"><div id="episodeThumbnailPreview" class="field-asset-preview"></div></label><label class="wide">Icon<input id="episodeDungeonIcon" value="NKM_NPC_CUT_SCENE"><div id="episodeDungeonIconPreview" class="field-asset-preview"></div></label>
              <div class="button-row"><button id="insertEpisodeStage" class="secondary" type="button"><span aria-hidden="true">+</span> Insert</button><button id="duplicateEpisodeStage" class="secondary" type="button"><span aria-hidden="true">&#10697;</span> Copy</button><button id="stageEarlier" class="secondary" type="button"><span aria-hidden="true">&#8593;</span> Earlier</button><button id="stageLater" class="secondary" type="button"><span aria-hidden="true">&#8595;</span> Later</button><button id="editEpisodeStage" class="primary" type="button"><span aria-hidden="true">&#9998;</span> Edit</button><button id="deleteEpisodeStage" class="danger" type="button"><span aria-hidden="true">&#215;</span> Delete</button></div>
            </div><div id="episodeSelectionFields" class="episode-form-grid" hidden></div>
          </div></section>
          <section class="episode-inspector"><div class="toolbar"><strong id="episodeFrameTitle">Placement &amp; IDs</strong><span id="episodeFrameMeta" class="subtle">Generated automatically; still editable</span></div><div class="episode-inspector-body">
            <div id="episodeStageFrame" class="episode-form-grid">
              <label>Act<input id="episodeAct" type="number" min="1" required></label><label>Index<input id="episodeIndex" type="number" min="1" required></label><label>Display number<input id="episodeUiNumber" type="number" min="1" required></label><label>Unlock after<input id="episodeUnlock" type="number" min="0" required></label>
              <label>Stage ID<input id="episodeStageId" type="number" min="1" required></label><label>Dungeon ID<input id="episodeDungeonId" type="number" min="1" required></label><label class="wide">Cutscene ID<input id="episodeCutsceneId" type="number" min="1" required></label><label class="wide">Stage string ID<input id="episodeStageStr" required></label><label class="wide">Dungeon string ID<input id="episodeDungeonStr" required></label><label class="wide">Cutscene string ID<input id="episodeCutsceneStr" required></label>
            </div><details id="episodeOverrideChanges" class="inspector-group" hidden><summary id="episodeOverrideSummary">Override changes</summary><pre id="episodeOverrideDiff"></pre><button id="resetEpisodeOverride" class="secondary" type="button">Reset fields</button></details><div id="episodeFrameFields" class="episode-form-grid" hidden></div><pre id="episodeOutput" class="episode-output">Loading Episode Maker…</pre>
          </div></section>
        </aside>
        <datalist id="episodeBackgrounds"></datalist><datalist id="episodeMusicOptions"></datalist><datalist id="episodeActorOptions"></datalist><datalist id="episodeStageCharacterOptions"></datalist><datalist id="episodeVoiceOptions"></datalist><datalist id="episodeEffectOptions"></datalist><datalist id="episodeAnimationOptions"></datalist>
      </form>
    </section>
    <section id="unitPanel" class="panel unit-layout" hidden>
      <div class="pane">
        <div class="toolbar"><strong>Base unit</strong><span class="subtle">Duplicate any normal unit</span><input id="unitSearch" type="search" placeholder="Search unit ID or name" aria-label="Search base units"></div>
        <div id="unitList" class="list"><div class="empty">Search or select a unit.</div></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong id="unitTitle">Unit:Side creator</strong><span id="unitMeta" class="subtle">Select a source unit to populate every editable layer</span></div>
        <form id="unitForm" class="unit-form">
          <label>Project ID<input id="unitProjectId" required pattern="[a-z0-9][a-z0-9._-]{1,63}" placeholder="my-unit-mod"></label>
          <label>Project name<input id="unitProjectName" required placeholder="My unit mod"></label>
          <label>Display name<input id="unitDisplayName" required placeholder="Custom unit"></label>
          <label>Unit ID<input id="unitId" type="number" min="1" required></label>
          <label class="wide">Unit string ID<input id="unitStrId" required pattern="NKM_UNIT_[A-Z0-9_]{3,120}"></label>
          <label>Rarity<input id="unitRarity" placeholder="NUG_SSR"></label>
          <label>Unit tags (comma separated)<input id="unitTags"></label>
          <label class="wide">Runtime tags (comma separated)<input id="unitRuntimeTags"></label>
          <label class="check"><input id="unitCloneSkills" type="checkbox"> Clone skills for custom editing</label>
          <label class="check"><input id="unitCloneSkins" type="checkbox" checked> Clone all skins</label>
          <section class="wide unit-spine">
            <div class="section-label">New Spine2D assets</div>
            <p class="subtle">Each set needs one binary Spine 3.7.x <code>.skel</code>, one <code>.atlas</code>, and every PNG page named by the atlas. PNG dimensions come from the atlas; the page count must match the selected base unit prefab.</p>
            <div class="unit-spine-grid">
              <label>Management / gacha illustration<input id="unitSpineIllust" type="file" accept=".skel,.atlas,.png" multiple></label>
              <label>SD / chibi illustration<input id="unitSpineSd" type="file" accept=".skel,.atlas,.png" multiple></label>
              <label>Live battle model<input id="unitSpineBattle" type="file" accept=".skel,.atlas,.png" multiple></label>
            </div>
            <button id="attachUnitSpine" class="secondary" type="button">Attach / retry selected Spine sets</button>
          </section>
          <label class="wide">Presentation assets JSON<textarea id="unitAssets" rows="5">{}</textarea></label>
          <label class="wide">Base record overrides JSON <span class="subtle">All identity, role, cost, movement, growth and presentation fields</span><textarea id="unitBase" rows="5">{}</textarea></label>
          <label class="wide">Stat overrides JSON<textarea id="unitStats" rows="6">{}</textarea></label>
          <label class="wide">Preexisting skill IDs JSON <span class="subtle">Four slots; ignored when cloning custom skills</span><textarea id="unitSkills" rows="3">[]</textarea></label>
          <label class="wide">Cloned skill overrides JSON <span class="subtle">Map source skill string ID to changed fields</span><textarea id="unitSkillOverrides" rows="4">{}</textarea></label>
          <label class="wide">Cloned skin overrides JSON <span class="subtle">Map source skin ID to changed voice, art, model, or UI fields</span><textarea id="unitSkinOverrides" rows="4">{}</textarea></label>
          <label class="wide">Voice replacements JSON <span class="subtle">Map existing voice asset ID to a preexisting or bundled replacement</span><textarea id="unitVoices" rows="4">{}</textarea></label>
          <div class="button-row wide"><button id="createUnit" class="primary" type="submit" disabled>Create unit mod</button></div>
          <section class="wide">
            <div class="section-label">External Unity AssetBundle compiler</div>
            <p id="unityStatus" class="subtle">Checking Unity Editor...</p>
            <div class="button-row"><input id="bundleName" placeholder="custom-unit-assets" aria-label="AssetBundle name"><label class="secondary" style="text-align:center;cursor:pointer">Choose source assets<input id="bundleAssets" type="file" multiple hidden></label><button id="buildBundle" class="secondary" type="button">Build Windows + Android bundles</button></div>
          </section>
          <pre id="unitOutput" class="unit-output wide">Select a base unit.</pre>
        </form>
      </div>
    </section>
    <section id="combatPanel" class="panel combat-panel" aria-label="Combat:Side" hidden>
      <iframe class="combat-frame" src="http://127.0.0.1:5185/" title="Combat:Side simulator"></iframe>
    </section>
    <section id="creatorPanel" class="panel creator-layout" hidden>
      <div class="pane">
        <div class="toolbar"><strong>Mod projects</strong><span class="subtle">Folder-based, portable projects</span></div>
        <form id="newModForm" class="compact-form">
          <input id="newModId" required pattern="[a-z0-9][a-z0-9._-]{1,63}" placeholder="mod-id" aria-label="New mod ID">
          <input id="newModName" required placeholder="Mod name" aria-label="New mod name">
          <button class="primary" type="submit">Create project</button>
          <label class="secondary" style="text-align:center;cursor:pointer">Import ZIP<input id="importMod" type="file" accept=".zip,.revivalmod" hidden></label>
        </form>
        <div id="modList" class="list"><div class="empty">No mod projects loaded.</div></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong id="projectTitle">Select a mod project</strong><span id="projectMeta" class="subtle">Manifest and patched records</span></div>
        <form id="manifestForm" class="manifest-form" hidden>
          <label>Name<input id="manifestName" required></label>
          <label>Version<input id="manifestVersion" required></label>
          <label class="wide">Author<input id="manifestAuthor"></label>
          <label class="wide">Description<textarea id="manifestDescription" rows="3"></textarea></label>
          <div class="button-row wide"><button class="primary" type="submit">Save manifest</button><button id="validateMod" class="secondary" type="button">Validate</button><button id="exportMod" class="secondary" type="button">Export ZIP</button></div>
        </form>
        <div id="projectStatus" class="project-status">Select a project to begin.</div>
        <div class="toolbar"><strong>Mod records</strong><span class="subtle">Add records from Gameplay tables</span></div>
        <div id="patchList" class="list"><div class="empty">Select a project.</div></div>
      </div>
      <div class="pane relative-pane">
        <div class="toolbar"><strong id="editorTitle">Record editor</strong><span id="editorMeta" class="subtle">Copy or duplicate any base record</span><div class="button-row" style="margin-top:.55rem"><button id="savePatch" class="primary" type="button" disabled>Save patch</button><button id="duplicatePatch" class="secondary" type="button" disabled>Duplicate</button><button id="deleteRecord" class="danger" type="button" disabled>Delete record</button><button id="removePatch" class="secondary" type="button" disabled>Remove from mod</button></div></div>
        <div class="editor-tabs"><button id="formEditorTab" class="secondary active" type="button">Generated form</button><button id="rawEditorTab" class="secondary" type="button">Raw JSON</button><button id="diffEditorTab" class="secondary" type="button">Before / after</button><button id="validationEditorTab" class="secondary" type="button">Validation</button></div>
        <div id="creatorEditor" class="creator-editor"><div class="empty">Select a mod record, or copy one from Gameplay tables.</div></div>
        <section id="referencePicker" class="reference-picker" hidden>
          <div class="toolbar"><strong id="referenceTitle">Select referenced record</strong><div class="button-row"><input id="referenceSearch" type="search" placeholder="Search ID, name, table, or type" aria-label="Search referenced records"><button id="closeReference" class="secondary" type="button">Close</button></div></div>
          <div id="referenceResults" class="reference-results"><div class="empty">Search for a referenced record.</div></div>
        </section>
      </div>
    </section>
    <section id="loaderPanel" class="panel loader-layout" hidden>
      <div class="pane">
        <div class="toolbar"><strong>Runtime load order</strong><span class="subtle">Runtime changes apply immediately; restart the client to reload</span></div>
        <div class="toolbar button-row"><label class="secondary" style="text-align:center;cursor:pointer">Add mod<input id="loaderImportMod" type="file" accept=".zip,.revivalmod" hidden></label><button id="buildRuntime" class="primary" type="button">Apply load order</button><button id="rollbackRuntime" class="danger" type="button">Rollback</button></div>
        <div id="loaderProjectList" class="list"><div class="empty">Loading mod projects...</div></div>
      </div>
      <div class="pane">
        <div class="toolbar"><strong>Effective runtime</strong><span class="subtle">Shared by listener, combat host, and patched client</span></div>
        <div class="runtime-summary"><strong id="runtimeTitle">No runtime built</strong><code id="runtimeHash">No mod-set hash</code><span id="runtimeMeta" class="subtle">Choose mods and build.</span></div>
        <div id="runtimeDetails" class="runtime-details"><div class="empty">Build a profile to inspect effective changes and conflicts.</div></div>
      </div>
    </section>
  </main>
  <div id="loadingOverlay" class="loading-overlay" role="status" aria-live="polite" aria-hidden="true" hidden>
    <div class="loading-dialog">
      <div class="loading-head"><span class="loading-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2"></rect><rect x="13" y="3" width="8" height="8" rx="2" opacity=".65"></rect><rect x="3" y="13" width="8" height="8" rx="2" opacity=".65"></rect><rect x="13" y="13" width="8" height="8" rx="2"></rect></svg></span><span class="loading-copy"><strong id="loadingTitle">Workspace status</strong><span id="loadingMessage">Loading health</span></span><span id="loadingPercent" class="loading-percent">0%</span></div>
      <div id="loadingProgress" class="loading-progress" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="loadingBar"></span></div>
    </div>
  </div>
  <script>
    (function () {
      "use strict";
      var BASE_PATH = ${JSON.stringify(basePath)};
      var PRODUCT = ${JSON.stringify(product)};
      var PAGE_SIZE = 100;
      var state = { systems:[], selectedSystem:null, systemOffset:0, systemTotal:0, fieldQuery:"", objectType:"unit", objectQuery:"", objectOffset:0, objectTotal:0, selectedObjectId:null, selectedObjectDetail:null, objectProjectsLoaded:false, objectProject:null, objectUnity:null, tableOffset:0, tableTotal:0, tableQuery:"", selectedTable:null, selectedRecord:null, selectedRecordIndex:-1, recordOffset:0, recordTotal:0, recordQuery:"", assetPath:"", assetOffset:0, assetTotal:0, assetQuery:"", selectedAsset:null, selectedAssetPath:"", assetView:"", spineViewerAvailable:false, projects:[], selectedProject:null, selectedPatch:null, editorValue:null, editorMode:"form", referencePath:null, runtime:null, loaderEnabled:[], unitCatalogLoaded:false, selectedUnit:null, episodeCatalog:null, episodeDefinition:null, episodeDefinitionActive:false, episodeMode:"stage", episodeBaseStages:[], episodeBaseDetail:null, episodeStages:[], episodeStageIndex:0, episodeSelectedNode:null, episodeSelection:{type:"stage"}, episodeScenes:[], episodeSceneIndex:0, episodePlaying:false, episodeTimer:null, cutsceneGl:null, stageGl:null, stageNodeRects:[], stagePanX:0, stagePanY:0, stagePanDrag:null, stageNodeDrag:null };
      var byId = function (id) { return document.getElementById(id); };
      var els = {
        appTitle:byId("appTitle"), status:byId("status"), loadingOverlay:byId("loadingOverlay"), loadingTitle:byId("loadingTitle"), loadingMessage:byId("loadingMessage"), loadingPercent:byId("loadingPercent"), loadingProgress:byId("loadingProgress"), loadingBar:byId("loadingBar"), modSideTabs:byId("modSideTabs"), homeTab:byId("homeTab"), openCreator:byId("openCreator"), openLoader:byId("openLoader"), assetSideTabs:byId("assetSideTabs"), systemsTab:byId("systemsTab"), objectsTab:byId("objectsTab"), tablesTab:byId("tablesTab"), assetsTab:byId("assetsTab"), creatorTab:byId("creatorTab"), loaderTab:byId("loaderTab"), homePanel:byId("homePanel"), systemsPanel:byId("systemsPanel"), objectsPanel:byId("objectsPanel"), tablesPanel:byId("tablesPanel"), assetsPanel:byId("assetsPanel"), episodePanel:byId("episodePanel"), unitPanel:byId("unitPanel"), combatPanel:byId("combatPanel"), creatorPanel:byId("creatorPanel"), loaderPanel:byId("loaderPanel"),
        fieldSearchForm:byId("fieldSearchForm"), fieldSearch:byId("fieldSearch"), fieldResults:byId("fieldResults"), systemCount:byId("systemCount"), systemList:byId("systemList"), systemSummary:byId("systemSummary"), systemEdits:byId("systemEdits"), systemTablesTitle:byId("systemTablesTitle"), systemTableList:byId("systemTableList"), systemPrev:byId("systemPrev"), systemNext:byId("systemNext"), systemPage:byId("systemPage"),
        objectType:byId("objectType"), objectSearch:byId("objectSearch"), objectList:byId("objectList"), objectPrev:byId("objectPrev"), objectNext:byId("objectNext"), objectPage:byId("objectPage"), objectTitle:byId("objectTitle"), objectMeta:byId("objectMeta"), objectDetail:byId("objectDetail"), objectProject:byId("objectProject"), objectNewProject:byId("objectNewProject"), objectImportMod:byId("objectImportMod"), objectExportMod:byId("objectExportMod"), objectBuildAssets:byId("objectBuildAssets"), objectAssetPath:byId("objectAssetPath"), objectEditAssetPath:byId("objectEditAssetPath"), objectModStatus:byId("objectModStatus"),
        tableSearch:byId("tableSearch"), tableList:byId("tableList"), tablePrev:byId("tablePrev"), tableNext:byId("tableNext"), tablePage:byId("tablePage"),
        recordTitle:byId("recordTitle"), recordSource:byId("recordSource"), recordSearch:byId("recordSearch"), recordList:byId("recordList"), recordPrev:byId("recordPrev"), recordNext:byId("recordNext"), recordPage:byId("recordPage"), recordJson:byId("recordJson"), detailTitle:byId("detailTitle"), recordActions:byId("recordActions"), copyRecord:byId("copyRecord"), duplicateRecord:byId("duplicateRecord"),
        newModForm:byId("newModForm"), newModId:byId("newModId"), newModName:byId("newModName"), importMod:byId("importMod"), modList:byId("modList"), projectTitle:byId("projectTitle"), projectMeta:byId("projectMeta"), manifestForm:byId("manifestForm"), manifestName:byId("manifestName"), manifestVersion:byId("manifestVersion"), manifestAuthor:byId("manifestAuthor"), manifestDescription:byId("manifestDescription"), validateMod:byId("validateMod"), exportMod:byId("exportMod"), projectStatus:byId("projectStatus"), patchList:byId("patchList"), editorTitle:byId("editorTitle"), editorMeta:byId("editorMeta"), savePatch:byId("savePatch"), duplicatePatch:byId("duplicatePatch"), deleteRecord:byId("deleteRecord"), removePatch:byId("removePatch"), formEditorTab:byId("formEditorTab"), rawEditorTab:byId("rawEditorTab"), diffEditorTab:byId("diffEditorTab"), validationEditorTab:byId("validationEditorTab"), creatorEditor:byId("creatorEditor"), referencePicker:byId("referencePicker"), referenceTitle:byId("referenceTitle"), referenceSearch:byId("referenceSearch"), closeReference:byId("closeReference"), referenceResults:byId("referenceResults"),
        breadcrumbs:byId("breadcrumbs"), assetSearch:byId("assetSearch"), assetList:byId("assetList"), assetPrev:byId("assetPrev"), assetNext:byId("assetNext"), assetPage:byId("assetPage"), selectedObject:byId("selectedObject"), preview:byId("preview"), previewTitle:byId("previewTitle"), previewMeta:byId("previewMeta"),
        loaderImportMod:byId("loaderImportMod"), loaderProjectList:byId("loaderProjectList"), buildRuntime:byId("buildRuntime"), rollbackRuntime:byId("rollbackRuntime"), runtimeTitle:byId("runtimeTitle"), runtimeHash:byId("runtimeHash"), runtimeMeta:byId("runtimeMeta"), runtimeDetails:byId("runtimeDetails"),
        unitSearch:byId("unitSearch"), unitList:byId("unitList"), unitForm:byId("unitForm"), unitTitle:byId("unitTitle"), unitMeta:byId("unitMeta"), unitProjectId:byId("unitProjectId"), unitProjectName:byId("unitProjectName"), unitDisplayName:byId("unitDisplayName"), unitId:byId("unitId"), unitStrId:byId("unitStrId"), unitRarity:byId("unitRarity"), unitTags:byId("unitTags"), unitRuntimeTags:byId("unitRuntimeTags"), unitCloneSkills:byId("unitCloneSkills"), unitCloneSkins:byId("unitCloneSkins"), unitSpineIllust:byId("unitSpineIllust"), unitSpineSd:byId("unitSpineSd"), unitSpineBattle:byId("unitSpineBattle"), attachUnitSpine:byId("attachUnitSpine"), unitAssets:byId("unitAssets"), unitBase:byId("unitBase"), unitStats:byId("unitStats"), unitSkills:byId("unitSkills"), unitSkillOverrides:byId("unitSkillOverrides"), unitSkinOverrides:byId("unitSkinOverrides"), unitVoices:byId("unitVoices"), createUnit:byId("createUnit"), unityStatus:byId("unityStatus"), bundleName:byId("bundleName"), bundleAssets:byId("bundleAssets"), buildBundle:byId("buildBundle"), unitOutput:byId("unitOutput"),
        episodeDefinitionMode:byId("episodeDefinitionMode"), episodeStageMode:byId("episodeStageMode"), episodeCutsceneMode:byId("episodeCutsceneMode"), episodeStageCanvasWrap:byId("episodeStageCanvasWrap"), episodeStageCanvas:byId("episodeStageCanvas"), episodeStageLabels:byId("episodeStageLabels"), episodeCutsceneCanvasWrap:byId("episodeCutsceneCanvasWrap"), cutsceneSelection:byId("cutsceneSelection"), cutsceneDialogue:byId("cutsceneDialogue"), episodeTimeline:byId("episodeTimeline"), episodeTimelineMeta:byId("episodeTimelineMeta"), episodeSelectionTitle:byId("episodeSelectionTitle"), episodeSelectionMeta:byId("episodeSelectionMeta"), episodeStageDetails:byId("episodeStageDetails"), episodeSelectionFields:byId("episodeSelectionFields"), episodeFrameTitle:byId("episodeFrameTitle"), episodeFrameMeta:byId("episodeFrameMeta"), episodeStageFrame:byId("episodeStageFrame"), episodeOverrideChanges:byId("episodeOverrideChanges"), episodeOverrideSummary:byId("episodeOverrideSummary"), episodeOverrideDiff:byId("episodeOverrideDiff"), resetEpisodeOverride:byId("resetEpisodeOverride"), episodeFrameFields:byId("episodeFrameFields"), insertEpisodeStage:byId("insertEpisodeStage"), deleteEpisodeStage:byId("deleteEpisodeStage"), editEpisodeStage:byId("editEpisodeStage"), stageEarlier:byId("stageEarlier"), stageLater:byId("stageLater"),
        episodeForm:byId("episodeForm"), episodeSavedProject:byId("episodeSavedProject"), loadEpisodeProject:byId("loadEpisodeProject"), episodeProjectId:byId("episodeProjectId"), episodeProjectName:byId("episodeProjectName"), episodeStageSelect:byId("episodeStageSelect"), addEpisodeStage:byId("addEpisodeStage"), sendEpisodeToModside:byId("sendEpisodeToModside"), duplicateEpisodeStage:byId("duplicateEpisodeStage"), episodeTitle:byId("episodeTitle"), episodeDescription:byId("episodeDescription"), episodeDifficulty:byId("episodeDifficulty"), episodeCategory:byId("episodeCategory"), episodeSelect:byId("episodeSelect"), episodeAct:byId("episodeAct"), episodeIndex:byId("episodeIndex"), episodeUiNumber:byId("episodeUiNumber"), episodeStageCharacter:byId("episodeStageCharacter"), episodeUnlock:byId("episodeUnlock"), episodeStageId:byId("episodeStageId"), episodeDungeonId:byId("episodeDungeonId"), episodeCutsceneId:byId("episodeCutsceneId"), episodeStageStr:byId("episodeStageStr"), episodeDungeonStr:byId("episodeDungeonStr"), episodeCutsceneStr:byId("episodeCutsceneStr"), episodeBackground:byId("episodeBackground"), episodeMusic:byId("episodeMusic"), episodeActBackground:byId("episodeActBackground"), episodeThumbnail:byId("episodeThumbnail"), episodeDungeonIcon:byId("episodeDungeonIcon"), episodeBackgrounds:byId("episodeBackgrounds"), episodeMusicOptions:byId("episodeMusicOptions"), episodeActorOptions:byId("episodeActorOptions"), episodeStageCharacterOptions:byId("episodeStageCharacterOptions"), episodeVoiceOptions:byId("episodeVoiceOptions"), episodeEffectOptions:byId("episodeEffectOptions"), episodeAnimationOptions:byId("episodeAnimationOptions"), episodeBackgroundPreview:byId("episodeBackgroundPreview"), episodeMusicPreview:byId("episodeMusicPreview"), episodeStageCharacterPreview:byId("episodeStageCharacterPreview"), episodeActBackgroundPreview:byId("episodeActBackgroundPreview"), episodeThumbnailPreview:byId("episodeThumbnailPreview"), episodeDungeonIconPreview:byId("episodeDungeonIconPreview"), saveEpisode:byId("saveEpisode"), episodeOutput:byId("episodeOutput"), episodeSceneCount:byId("episodeSceneCount"), addEpisodeScene:byId("addEpisodeScene"), episodeScenes:byId("episodeScenes"), cutsceneCanvas:byId("cutsceneCanvas"), cutsceneEffects:byId("cutsceneEffects"), cutsceneAvatar:byId("cutsceneAvatar"), cutsceneSpeaker:byId("cutsceneSpeaker"), cutsceneText:byId("cutsceneText"), episodePreviewMeta:byId("episodePreviewMeta"), episodePrevScene:byId("episodePrevScene"), episodeNextScene:byId("episodeNextScene"), episodePlay:byId("episodePlay"), episodeProgress:byId("episodeProgress")
      };

      var loadingRequests=0,loadingShowTimer=0,loadingHideTimer=0,loadingSequence=0,loadingDisplayed=0,loadingOperations={};
      function loadingContext(url,options) {
        var parsed=new URL(String(url),window.location.origin),route=decodeURIComponent(parsed.pathname.slice((BASE_PATH+"/api/").length)),query=parsed.searchParams,method=String(options&&options.method||"GET").toUpperCase(),body=null;
        if(typeof options.body==="string"){try{body=JSON.parse(options.body)}catch(_) {}}else if(options&&options.body&&typeof options.body==="object"&&!options.body.name)body=options.body;
        var pathValue=query.get("path")||query.get("fileName")||"",fileName=options&&options.body&&options.body.name||"",bodyName=body&&(body.projectName||body.displayName||body.name||body.unitStrId||body.bundleName||body.projectId)||"",queryName=query.get("file")||query.get("id")||query.get("stageId")||query.get("episodeId")||query.get("query")||"";
        var routeNames={health:"Workspace status",systems:"Game systems","system-tables":"System tables",fields:"Gameplay fields",tables:"Gameplay tables",table:"Gameplay table",objects:"Game objects",object:"Game object",assets:"Extracted assets",asset:"Extracted asset",text:"Text preview",related:"Related data","spine-set":"Spine asset set",references:"Record references","asset-replacement":"Asset replacement","unity-compiler":"Unity compiler","mod-runtime":"Mod load order",mods:"Mod projects"};
        var parts=route.split("/"),routeName=routeNames[parts[0]]||parts.map(function(part){return part.replace(/-/g," ")}).join(" › "),title=fileName||(pathValue?pathValue.split(/[\\/]/).pop():"")||bodyName||queryName||routeName;
        if(parts[0]==="objects"){var objectType=query.get("type")||"game";title=objectType.charAt(0).toUpperCase()+objectType.slice(1)+" objects"+(query.get("query")?" · "+query.get("query"):"")}
        if(parts[0]==="object")title=(query.get("type")||"Object")+" "+(query.get("id")||"");
        if(parts[0]==="system-tables"&&query.get("id"))title="System "+query.get("id")+" tables";
        if((parts[0]==="fields"||parts[0]==="references")&&query.get("query"))title=query.get("query");
        if(parts[0]==="episode-maker"){routeName="Story:Side "+(parts[1]||"workspace").replace(/-/g," ");if(parts[1]==="stage"&&query.get("stageId"))title="Stage "+query.get("stageId");else if(parts[1]==="layout"&&query.get("episodeId"))title="Episode "+query.get("episodeId")+" layout"}
        if(parts[0]==="unit-maker"){routeName="Unit:Side "+(parts[1]||"workspace").replace(/-/g," ");if(parts[1]==="unit"&&query.get("id"))title=query.get("id");else if(parts[1]==="units")title=query.get("query")||"Unit catalog"}
        if(parts[0]==="mods"&&parts[1]){title=fileName||bodyName||decodeURIComponent(parts[1]);routeName="Mod:Side "+(parts[2]||"project").replace(/-/g," ")}
        if(parts[0]==="mod-runtime"&&body&&Array.isArray(body.enabled))title=body.enabled.length+" active mod"+(body.enabled.length===1?"":"s");
        var action=method==="GET"?"Loading":method==="DELETE"?"Deleting":route.indexOf("mod-runtime")===0?"Applying":method==="PUT"?"Updating":"Building";
        return {title:String(title),message:action+" "+routeName+(pathValue?" · "+pathValue:"")};
      }
      function renderLoadingProgress(force) {
        var operations=Object.keys(loadingOperations).map(function(key){return loadingOperations[key]}),average=operations.length?operations.reduce(function(total,item){return total+item.progress},0)/operations.length:0,value=force?100:Math.min(98,Math.max(loadingDisplayed,Math.floor(average)));loadingDisplayed=value;els.loadingPercent.textContent=value+"%";els.loadingBar.style.width=value+"%";els.loadingProgress.setAttribute("aria-valuenow",String(value));
      }
      function beginLoading(context) {
        if(!loadingRequests){loadingOperations={};loadingDisplayed=0}var id=++loadingSequence;loadingRequests+=1;loadingOperations[id]={progress:5};clearTimeout(loadingHideTimer);els.loadingTitle.textContent=context.title;els.loadingMessage.textContent=context.message;renderLoadingProgress(false);
        if(!els.loadingOverlay.hidden||loadingShowTimer)return id;loadingShowTimer=setTimeout(function(){loadingShowTimer=0;if(!loadingRequests)return;els.loadingOverlay.hidden=false;els.loadingOverlay.setAttribute("aria-hidden","false")},160);return id;
      }
      function updateLoading(id,progress) { if(!loadingOperations[id])return;loadingOperations[id].progress=Math.max(loadingOperations[id].progress,Math.min(100,progress));renderLoadingProgress(false); }
      function endLoading(id) {
        updateLoading(id,100);loadingRequests=Math.max(0,loadingRequests-1);if(loadingRequests)return;clearTimeout(loadingShowTimer);loadingShowTimer=0;renderLoadingProgress(true);if(els.loadingOverlay.hidden){loadingOperations={};return}
        loadingHideTimer=setTimeout(function(){if(loadingRequests)return;els.loadingOverlay.hidden=true;els.loadingOverlay.setAttribute("aria-hidden","true");loadingOperations={};loadingDisplayed=0},180);
      }
      function progressResponse(id,response) {
        updateLoading(id,12);if(!response.body||!response.body.getReader||typeof ReadableStream==="undefined"){updateLoading(id,70);return response}
        var total=Number(response.headers.get("content-length"))||0,loaded=0,reader=response.body.getReader(),stream=new ReadableStream({pull:function(controller){return reader.read().then(function(result){if(result.done){updateLoading(id,96);controller.close();return}loaded+=result.value.byteLength;updateLoading(id,total?12+84*Math.min(1,loaded/total):Math.min(92,12+Math.log2(loaded/1024+1)*8));controller.enqueue(result.value)})},cancel:function(reason){return reader.cancel(reason)}});
        return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
      }
      function loadingFetch(url,options,onresponse) {
        var id=beginLoading(loadingContext(url,options||{})),request;try{request=fetch(url,options).then(function(response){return onresponse(progressResponse(id,response))})}catch(err){endLoading(id);throw err}return request.finally(function(){endLoading(id)});
      }

      function api(route, params) {
        var query = new URLSearchParams(params || {});
        return loadingFetch(BASE_PATH + "/api/" + route + (query.toString() ? "?" + query : ""), { cache:"no-store" },function (response) {
          return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || response.statusText); return body; });
        });
      }
      function writeApi(route,method,body) {
        return loadingFetch(BASE_PATH+"/api/"+route,{method:method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"},function (response) {
          return response.json().then(function (value) { if(!response.ok) throw new Error(value.error||response.statusText); return value; });
        });
      }
      function writeRaw(route,body) {
        return loadingFetch(BASE_PATH+"/api/"+route,{method:"POST",body:body,cache:"no-store"},function(response){return response.json().then(function(value){if(!response.ok)throw new Error(value.error||response.statusText);return value})});
      }
      function jsonField(element,label) { try { return JSON.parse(element.value||"null"); } catch(err) { throw new Error(label+" is invalid JSON: "+err.message); } }
      function commaList(value) { return String(value||"").split(",").map(function(item){return item.trim()}).filter(Boolean); }
      function debounce(fn) { var timer; return function () { clearTimeout(timer); timer=setTimeout(fn,180); }; }
      function pageText(offset, total) { return total ? (offset + 1) + "–" + Math.min(offset + PAGE_SIZE, total) + " of " + total.toLocaleString() : "0 items"; }
      function setPager(prefix, offset, total) { els[prefix + "Page"].textContent=pageText(offset,total); els[prefix + "Prev"].disabled=offset<=0; els[prefix + "Next"].disabled=offset+PAGE_SIZE>=total; }
      function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
      function empty(node, text) { clear(node); var div=document.createElement("div"); div.className="empty"; div.textContent=text; node.appendChild(div); }
      function itemButton(title, meta, active) { var button=document.createElement("button"); button.type="button"; button.className="item"+(active?" active":""); var strong=document.createElement("span"); strong.className="item-title"; strong.textContent=title; var small=document.createElement("span"); small.className="item-meta"; small.textContent=meta; button.append(strong,small); return button; }
      function revealClippedText(event) { for(var node=event.target;node&&node!==document.body;node=node.parentElement) { if(node instanceof HTMLElement&&getComputedStyle(node).textOverflow==="ellipsis"&&(node.scrollWidth>node.clientWidth||node.scrollHeight>node.clientHeight)) { if(!node.title)node.title=(node.textContent||"").trim(); return; } } }
      function openFileLocationButton(entry) { var button=document.createElement("button"); button.type="button"; button.className="file-link"; button.textContent="Open File Location"; button.onclick=function () { writeApi("open-file-location?path="+encodeURIComponent(entry.path),"POST").catch(showError); }; return button; }

      function loadObjects() {
        return api("objects",{type:state.objectType,query:state.objectQuery,offset:state.objectOffset,limit:PAGE_SIZE}).then(function(data){
          state.objectTotal=data.total;clear(els.objectList);setPager("object",state.objectOffset,state.objectTotal);
          data.objects.forEach(function(object){var button=itemButton(object.name,"ID "+object.id+(object.strId?" | "+object.strId:"")+(object.meta?" | "+object.meta:""),object.id===state.selectedObjectId);button.dataset.objectId=String(object.id);button.onclick=function(){selectGameObject(object.id).catch(showError)};els.objectList.appendChild(button)});
          if(!data.objects.length)empty(els.objectList,"No "+state.objectType+" objects match this search.");
          else if(state.selectedObjectId==null)selectGameObject(data.objects[0].id).catch(showError);
        });
      }

      function selectGameObject(id) {
        state.selectedObjectId=Number(id);Array.prototype.forEach.call(els.objectList.children,function(button){button.classList.toggle("active",button.dataset.objectId===String(id))});
        els.objectTitle.textContent="Loading object...";els.objectMeta.textContent="Resolving related tables and fields";
        return api("object",{type:state.objectType,id:id}).then(renderGameObject);
      }

      function objectAssetUrl(value) {
        var assetPath=String(value||"");if(assetPath.indexOf("/asset-png/")===0)assetPath=assetPath.slice(11);return assetPath?BASE_PATH+"/api/asset?path="+encodeURIComponent(assetPath):"";
      }

      function loadObjectTools(preferredId) {
        return Promise.all([api("mods"),api("unity-compiler")]).then(function(values){
          var projects=values[0].projects,previous=preferredId||state.objectProject&&state.objectProject.manifest.id||els.objectProject.value;state.objectUnity=values[1];state.objectProjectsLoaded=true;clear(els.objectProject);var blank=document.createElement("option");blank.value="";blank.textContent="Select asset mod";els.objectProject.appendChild(blank);projects.forEach(function(project){var option=document.createElement("option");option.value=project.id;option.textContent=project.name+" ("+(project.assetReplacementCount||0)+" assets)";els.objectProject.appendChild(option)});if(projects.some(function(project){return project.id===previous}))els.objectProject.value=previous;return els.objectProject.value?selectObjectProject(els.objectProject.value):renderObjectProjectStatus();
        });
      }

      function selectObjectProject(id) {
        if(!id){state.objectProject=null;renderObjectProjectStatus();if(state.selectedObjectDetail)renderGameObject(state.selectedObjectDetail);return Promise.resolve()}
        return api("mods/"+encodeURIComponent(id)).then(function(project){state.objectProject=project;els.objectProject.value=id;renderObjectProjectStatus();if(state.selectedObjectDetail)renderGameObject(state.selectedObjectDetail);return project});
      }

      function renderObjectProjectStatus() {
        var project=state.objectProject,replacements=project&&project.assetReplacements||[],pending=replacements.filter(function(item){return !item.built}).length;els.objectExportMod.disabled=!project;els.objectBuildAssets.disabled=!project||!replacements.length||!state.objectUnity||!state.objectUnity.available;els.objectModStatus.textContent=project?replacements.length+" replacements loaded"+(pending?" | "+pending+" need a bundle build":" | bundles ready")+(state.objectUnity&&!state.objectUnity.available?" | "+state.objectUnity.message:""):"Choose or create a mod project.";
      }

      function createObjectProject() {
        var id=window.prompt("New asset mod ID (lowercase letters, numbers, dots, dashes, or underscores):",state.selectedObjectDetail?state.selectedObjectDetail.type+"-"+state.selectedObjectDetail.id+"-assets":"asset-overrides");if(id==null)return Promise.resolve();var name=window.prompt("Mod name:",state.selectedObjectDetail?state.selectedObjectDetail.name+" Assets":"Asset Overrides");if(name==null)return Promise.resolve();return writeApi("mods","POST",{id:id.trim(),name:name.trim()}).then(function(project){return loadObjectTools(project.manifest.id)});
      }

      function openAssetReplacement(value) {
        var targetPath=String(value||"").trim().replace(/^\/asset-png\//,"");if(!targetPath)throw new Error("Enter an extracted asset path.");els.objectAssetPath.value=targetPath;return api("asset-replacement",{path:targetPath}).then(renderAssetReplacementEditor);
      }

      function renderAssetReplacementEditor(metadata) {
        var old=els.objectDetail.querySelector(".asset-replacement-editor");if(old)old.remove();var editor=document.createElement("section"),heading=document.createElement("h3"),target=document.createElement("code"),requirements=document.createElement("p"),status=document.createElement("p"),row=document.createElement("div"),input=document.createElement("input"),save=document.createElement("button"),close=document.createElement("button");editor.className="asset-replacement-editor";heading.textContent="Replace "+metadata.assetName;target.textContent=metadata.targetPath;requirements.textContent=metadata.extension===".png"?"Required PNG: exactly "+metadata.width+" x "+metadata.height+" pixels | original "+formatBytes(metadata.originalBytes)+" | bundle "+metadata.bundleName:"Required type: "+metadata.extension+" | original "+formatBytes(metadata.originalBytes)+" | "+metadata.assetType+" | bundle "+metadata.bundleName;status.className="subtle";var current=state.objectProject&&(state.objectProject.assetReplacements||[]).find(function(item){return item.targetPath.toLowerCase()===metadata.targetPath.toLowerCase()});status.textContent=current?(current.built?"This project already contains a built replacement.":"Replacement source loaded; bundle build pending."):"Choose a replacement file. The original asset ID and bundle name are preserved.";row.className="button-row";input.type="file";input.accept=metadata.extension;save.type="button";save.className="primary";save.textContent=state.objectUnity&&state.objectUnity.available?"Save and build":"Save source";save.disabled=!state.objectProject;save.onclick=function(){var file=input.files&&input.files[0];if(!file){status.textContent="Choose a "+metadata.extension+" file.";return}save.disabled=true;status.textContent="Validating and saving replacement...";saveAssetReplacement(metadata,file,status).catch(function(err){status.textContent=err.message}).finally(function(){save.disabled=!state.objectProject})};close.type="button";close.className="secondary";close.textContent="Close";close.onclick=function(){editor.remove()};row.append(input,save,close);editor.append(heading,target,requirements,status,row);els.objectDetail.insertBefore(editor,els.objectDetail.firstChild&&els.objectDetail.firstChild.nextSibling||els.objectDetail.firstChild);
      }

      function saveAssetReplacement(metadata,file,status) {
        if(!state.objectProject)throw new Error("Choose or create a mod project first.");var id=state.objectProject.manifest.id,route="mods/"+encodeURIComponent(id)+"/asset-replacement?path="+encodeURIComponent(metadata.targetPath)+"&fileName="+encodeURIComponent(file.name);return writeRaw(route,file).then(function(result){state.objectProject=result.project;renderObjectProjectStatus();if(!state.objectUnity||!state.objectUnity.available){status.textContent="Source saved in the mod ZIP. "+(state.objectUnity?state.objectUnity.message:"Install Unity to build the in-game bundle.");return result}status.textContent="Building Windows and Android replacement AssetBundles...";var spec={bundleName:result.replacement.bundleName,assets:result.bundleAssets,spriteAssets:result.spriteAssets};return writeApi("mods/"+encodeURIComponent(id)+"/unity-build","POST",Object.assign({target:"windows"},spec)).then(function(){return writeApi("mods/"+encodeURIComponent(id)+"/unity-build","POST",Object.assign({target:"android"},spec))}).then(function(build){status.textContent="Built Windows and Android "+build.bundleName+" variants. Export the mod ZIP when ready.";return api("mods/"+encodeURIComponent(id)).then(function(project){state.objectProject=project;renderObjectProjectStatus();return build})})});
      }

      function buildObjectProjectAssets() {
        if(!state.objectProject||!state.objectUnity||!state.objectUnity.available)return Promise.resolve();var id=state.objectProject.manifest.id,groups={};(state.objectProject.assetReplacements||[]).forEach(function(item){var group=groups[item.bundleName]||(groups[item.bundleName]={assets:[],spriteAssets:[]}),source=item.source.replace(/^assets\/source\//,"");group.assets.push(source);if(item.unityType==="Sprite")group.spriteAssets.push(source)});els.objectBuildAssets.disabled=true;els.objectModStatus.textContent="Building "+Object.keys(groups).length+" dual-platform replacement bundles...";return Object.keys(groups).reduce(function(promise,bundleName){return promise.then(function(){var spec={bundleName:bundleName,assets:groups[bundleName].assets,spriteAssets:groups[bundleName].spriteAssets};return writeApi("mods/"+encodeURIComponent(id)+"/unity-build","POST",Object.assign({target:"windows"},spec)).then(function(){return writeApi("mods/"+encodeURIComponent(id)+"/unity-build","POST",Object.assign({target:"android"},spec))})})},Promise.resolve()).then(function(){return loadObjectTools(id)}).finally(function(){renderObjectProjectStatus()});
      }

      function addObjectSection(root,title,items,render) {
        if(!items||!items.length)return;var section=document.createElement("section"),heading=document.createElement("h3"),grid=document.createElement("div");section.className="object-section";heading.textContent=title+" ("+items.length+")";grid.className="object-grid";items.forEach(function(item){grid.appendChild(render(item))});section.append(heading,grid);root.appendChild(section);
      }

      function objectCard(title,lines,source,description,preview) {
        var card=document.createElement("article"),heading=document.createElement("strong"),code=document.createElement("code"),meta=document.createElement("span"),text=document.createElement("p");card.className="object-card";heading.textContent=title;code.textContent=lines.filter(Boolean).join("\n");meta.className="subtle";meta.textContent=source||"";text.textContent=description||"";card.append(heading,code,meta,text);if(preview){var image=document.createElement("img");image.alt=title;image.loading="lazy";image.src=objectAssetUrl(preview);card.appendChild(image)}return card;
      }

      function renderGameObject(detail) {
        state.selectedObjectDetail=detail;clear(els.objectDetail);els.objectTitle.textContent=detail.name;els.objectMeta.textContent=detail.type+" ID "+detail.id+(detail.strId?" | "+detail.strId:"");
        var summary=document.createElement("div"),info=document.createElement("div"),heading=document.createElement("h2"),meta=document.createElement("div");summary.className="object-summary";heading.textContent=detail.name;meta.className="subtle";meta.textContent="ID "+detail.id+(detail.strId?" | "+detail.strId:"")+(detail.meta?" | "+detail.meta:"");if(detail.image){var image=document.createElement("img");image.alt=detail.name;image.src=objectAssetUrl(detail.image);summary.appendChild(image)}info.append(heading,meta);summary.appendChild(info);els.objectDetail.appendChild(summary);
        addObjectSection(els.objectDetail,"Relevant IDs and fields",detail.ids,function(item){var card=objectCard(item.label,[item.field+" = "+JSON.stringify(item.value)],item.sourceTable,item.description,item.preview);if(item.preview){var replacement=state.objectProject&&(state.objectProject.assetReplacements||[]).find(function(entry){return entry.targetPath.toLowerCase()===item.preview.toLowerCase()}),button=document.createElement("button");button.type="button";button.className="secondary";button.textContent=replacement?(replacement.built?"Edit built replacement":"Edit pending replacement"):"Replace asset";button.onclick=function(){openAssetReplacement(item.preview).catch(showError)};card.appendChild(button)}return card});
        addObjectSection(els.objectDetail,"Unit stat IDs and fields",detail.stats,function(item){return objectCard(item.name+" | Stat ID "+(item.statId==null?"unknown":item.statId),["Type = "+item.statType,item.fields.base+" = "+item.base,item.fields.perLevel+" = "+item.perLevel],"Unit stat template",item.description)});
        addObjectSection(els.objectDetail,"gear_stat_ids, fields, and ranges",detail.gear_stat_ids,function(item){var fields=Object.keys(item.fields||{}).map(function(key){return key+" field = "+item.fields[key]});return objectCard(item.name+" | Stat ID "+(item.statId==null?"unknown":item.statId),["Type = "+item.statType,"Slot = "+item.slot,"Range = "+item.min+" to "+item.max,item.groupId==null?"":"Group ID = "+item.groupId,item.optionKey==null?"":"OptionKey = "+item.optionKey,item.precisionWeightId==null?"":"PrecisionWeightId = "+item.precisionWeightId].concat(fields),item.sourceTable,item.description)});
      }

      function defaultEpisodeScenes() {
        return [{speakerName:"Speaker",speakerActorId:"USER_ADMIN_NULL_NULL",dialogue:"New dialogue",voiceLine:"",background:"",music:"",transition:"FADE",fadeTime:1,dimActors:false,effects:[],actors:[]}];
      }

      function loadEpisodeMaker() {
        return api("episode-maker/catalog").then(function(catalog){
          state.episodeCatalog=catalog;
          fillEpisodeDatalist(els.episodeBackgrounds,catalog.backgrounds);
          fillEpisodeDatalist(els.episodeMusicOptions,catalog.music||[]);
          fillEpisodeDatalist(els.episodeActorOptions,catalog.actors||[]);
          fillEpisodeDatalist(els.episodeStageCharacterOptions,catalog.stageCharacters||[]);
          fillEpisodeDatalist(els.episodeVoiceOptions,catalog.voices||[]);
          fillEpisodeDatalist(els.episodeEffectOptions,catalog.effects||[]);
          fillEpisodeDatalist(els.episodeAnimationOptions,catalog.animations||[]);
          renderEpisodeOptions();return loadEpisodeProjects().then(loadEpisodeLayout).then(function(){setEpisodeMode(state.episodeDefinition&&state.episodeDefinition.custom&&!state.episodeStages.length?"episode":"stage");previewStaticEpisodeAssets()});
        });
      }

      function fillEpisodeDatalist(list,values) {
        clear(list); values.forEach(function(value){var item=typeof value==="string"?{id:value}:value;var option=document.createElement("option");option.value=item.id;if(item.name)option.label=item.name;list.appendChild(option)});
      }

      function loadEpisodeProjects() {
        return api("episode-maker/projects").then(function(data){clear(els.episodeSavedProject);var blank=document.createElement("option");blank.value="";blank.textContent="New project";els.episodeSavedProject.appendChild(blank);data.projects.forEach(function(project){var option=document.createElement("option");option.value=project.id;option.textContent=project.name+" ("+project.stageCount+" stage"+(project.stageCount===1?"":"s")+")";els.episodeSavedProject.appendChild(option)})});
      }

      function loadEpisodeLayout() {
        if(!els.episodeSelect.value)return Promise.resolve();
        return api("episode-maker/layout",{episodeId:els.episodeSelect.value,category:els.episodeCategory.value}).then(function(layout){state.episodeBaseStages=layout.stages||[];state.episodeBaseDetail=null;if(state.episodeSelectedNode&&state.episodeSelectedNode.source==="base"){state.episodeSelectedNode=null;state.episodeScenes=[];state.episodeSceneIndex=0}state.episodeDefinition=layout.episode&&layout.episode.definition||null;state.episodeDefinitionActive=Boolean(state.episodeDefinition&&state.episodeDefinition.custom);els.episodeDefinitionMode.disabled=!state.episodeDefinition;state.stagePanX=0;state.stagePanY=0;renderEpisodeStageOptions();renderStageLayout();return layout});
      }

      function loadEpisodeLibrary() {
        return loadEpisodeLayout().then(function(){setEpisodeMode(state.episodeDefinition&&state.episodeDefinition.custom&&!state.episodeStages.length?"episode":"stage")});
      }

      function captureEpisodeStage() {
        var previous=state.episodeStages[state.episodeStageIndex]||{},readOnly=previous.cutsceneReadOnly===true;return {operation:previous.operation,baseObjectId:previous.baseObjectId,baseSnapshot:previous.baseSnapshot,sourceObjectId:previous.sourceObjectId,sourceStageId:previous.sourceStageId,sourceEpisodeId:previous.sourceEpisodeId,sourceCategory:previous.sourceCategory,sourceDifficulty:previous.sourceDifficulty,cutsceneReadOnly:readOnly,forkCutscenes:previous.forkCutscenes===true,unlockRequirementType:previous.unlockRequirementType,title:els.episodeTitle.value.trim(),stageDescription:els.episodeDescription.value.trim(),difficulty:els.episodeDifficulty.value,actId:Number(els.episodeAct.value),stageIndex:Number(els.episodeIndex.value),stageUiNumber:Number(els.episodeUiNumber.value),stageCharacter:els.episodeStageCharacter.value.trim(),unlockDungeonId:Number(els.episodeUnlock.value),stageId:Number(els.episodeStageId.value),dungeonId:Number(els.episodeDungeonId.value),cutsceneId:Number(els.episodeCutsceneId.value),stageStrId:els.episodeStageStr.value.trim(),dungeonStrId:els.episodeDungeonStr.value.trim(),cutsceneStrId:els.episodeCutsceneStr.value.trim(),background:els.episodeBackground.value.trim(),music:els.episodeMusic.value.trim(),actBackground:els.episodeActBackground.value.trim(),episodeThumbnail:els.episodeThumbnail.value.trim(),dungeonIcon:els.episodeDungeonIcon.value.trim(),scenes:readOnly?[]:state.episodeScenes,previewScenes:readOnly?state.episodeScenes:undefined};
      }

      function syncEpisodeStage() { if(state.episodeSelectedNode&&state.episodeSelectedNode.source==="mod"&&state.episodeStages[state.episodeStageIndex])state.episodeStages[state.episodeStageIndex]=captureEpisodeStage(); }
      function clearEpisodeStages() { state.episodeStages=[];state.episodeStageIndex=0;state.episodeSelectedNode=null;state.episodeSelection={type:"episode"};state.episodeScenes=[];state.episodeSceneIndex=0;renderEpisodeStageOptions();renderEpisodeScenes();renderEpisodeWorkspace(); }

      function renderEpisodeStageOptions() {
        clear(els.episodeStageSelect);state.episodeStages.forEach(function(stage,index){var option=document.createElement("option");option.value=String(index);option.textContent=(stage.operation==="override"?"Override · ":stage.operation==="clone"?"Clone · ":"")+(stage.difficulty==="HARD"?"Hard · ":"")+"Act "+stage.actId+" · Stage "+stage.stageUiNumber;els.episodeStageSelect.appendChild(option)});els.episodeStageSelect.value=String(state.episodeStageIndex);els.episodeStageSelect.disabled=!state.episodeStages.length;els.episodeCutsceneMode.disabled=!state.episodeScenes.length;
      }

      function applyEpisodeStage(stage,index) {
        if(!stage)return;var override=stage.operation==="override",clone=stage.operation==="clone",readOnly=stage.cutsceneReadOnly===true;state.episodeBaseDetail=null;state.episodeStageIndex=index;state.episodeSelectedNode={source:"mod",index:index};state.episodeSelection={type:"stage"};els.episodeTitle.value=stage.title||"Untitled stage";els.episodeDescription.value=stage.stageDescription||stage.title||"Untitled stage";els.episodeDifficulty.value=stage.difficulty||"NORMAL";els.episodeAct.value=stage.actId;els.episodeIndex.value=stage.stageIndex;els.episodeUiNumber.value=stage.stageUiNumber;els.episodeStageCharacter.value=stage.stageCharacter||"NKM_UNIT_C_POLICE_LEE_YUMI";els.episodeUnlock.value=stage.unlockDungeonId||0;els.episodeStageId.value=stage.stageId;els.episodeDungeonId.value=stage.dungeonId;els.episodeCutsceneId.value=stage.cutsceneId||0;els.episodeStageStr.value=stage.stageStrId;els.episodeDungeonStr.value=stage.dungeonStrId;els.episodeCutsceneStr.value=stage.cutsceneStrId||"";els.episodeBackground.value=stage.background||"CAFE";els.episodeMusic.value=stage.music||"";els.episodeActBackground.value=stage.actBackground||"";els.episodeThumbnail.value=stage.episodeThumbnail||"";els.episodeDungeonIcon.value=stage.dungeonIcon||"";state.episodeScenes=readOnly?(stage.previewScenes||[]):stage.scenes&&stage.scenes.length?stage.scenes:defaultEpisodeScenes();state.episodeSceneIndex=0;[els.episodeDifficulty,els.episodeStageId,els.episodeDungeonId,els.episodeCutsceneId,els.episodeStageStr,els.episodeDungeonStr,els.episodeCutsceneStr,els.episodeBackground].forEach(function(field){field.disabled=false});if(override)[els.episodeDifficulty,els.episodeStageId,els.episodeDungeonId,els.episodeCutsceneId,els.episodeStageStr,els.episodeDungeonStr,els.episodeCutsceneStr,els.episodeBackground].forEach(function(field){field.disabled=true});if(clone)[els.episodeCutsceneId,els.episodeCutsceneStr,els.episodeBackground].forEach(function(field){field.disabled=true});renderEpisodeStageOptions();renderEpisodeScenes();previewStaticEpisodeAssets();renderEpisodeWorkspace();if(readOnly&&!state.episodeScenes.length)hydrateEpisodeOverride(stage,index);
      }

      function stageFromAuthoring(stage) {
        var ui=stage.clientUi||{},base=stage.base||{},readOnly=stage.cutsceneReadOnly===true;return {operation:stage.operation,baseObjectId:base.objectId,baseSnapshot:base.snapshot,sourceObjectId:stage.operation==="clone"?base.objectId:undefined,sourceStageId:base.stageId,sourceEpisodeId:base.episodeId,sourceCategory:base.category,sourceDifficulty:base.difficulty,cutsceneReadOnly:readOnly,forkCutscenes:stage.forkCutscenes===true,unlockRequirementType:stage.unlockRequirementType,title:stage.title,stageDescription:stage.stageDescription||ui.description||stage.title,difficulty:stage.placement.difficulty||"NORMAL",actId:stage.placement.actId,stageIndex:stage.placement.stageIndex,stageUiNumber:stage.placement.stageUiNumber,unlockDungeonId:stage.unlockDungeonId||0,stageId:stage.ids.stageId,dungeonId:stage.ids.dungeonId,cutsceneId:stage.ids.cutsceneId||0,stageStrId:stage.ids.stageStrId,dungeonStrId:stage.ids.dungeonStrId,cutsceneStrId:stage.ids.cutsceneStrId||"",background:stage.background||"CAFE",music:stage.music||"",stageCharacter:stage.stageCharacter||ui.avatar||"NKM_UNIT_C_POLICE_LEE_YUMI",actBackground:ui.actBackground||"",episodeThumbnail:ui.episodeThumbnail||"",dungeonIcon:ui.dungeonIcon||"",scenes:readOnly?[]:stage.scenes||defaultEpisodeScenes()};
      }

      function hydrateEpisodeOverride(stage,index) {
        var clone=stage.operation==="clone";return api("episode-maker/stage",{stageId:clone?stage.sourceStageId:stage.stageId,episodeId:clone?stage.sourceEpisodeId:els.episodeSelect.value,category:clone?stage.sourceCategory:els.episodeCategory.value,difficulty:clone?stage.sourceDifficulty:stage.difficulty}).then(function(detail){if(state.episodeStageIndex!==index||state.episodeStages[index]!==stage)return;stage.previewScenes=detail.cutscenes.reduce(function(frames,cutscene){return frames.concat(cutscene.frames.map(function(frame){return Object.assign({cutsceneId:cutscene.id,cutsceneSlot:cutscene.slot},frame)}))},[]);state.episodeScenes=stage.previewScenes;renderEpisodeStageOptions();renderEpisodeScenes();renderEpisodeWorkspace()}).catch(showError);
      }

      function openEpisodeProject() {
        var id=els.episodeSavedProject.value;if(!id)return Promise.resolve();return api("episode-maker/project",{id:id}).then(function(result){var authoring=result.authoring,sourceStages=Array.isArray(authoring.stages)?authoring.stages:[authoring],first=sourceStages[0];els.episodeProjectId.value=result.manifest.id;els.episodeProjectName.value=result.manifest.name;els.episodeCategory.value=authoring.category||first&&first.placement.category||"EC_MAINSTREAM";renderEpisodeOptions();els.episodeSelect.value=String(authoring.episodeId||first&&first.placement.episodeId||18);state.episodeDefinition=authoring.episode||null;state.episodeStages=sourceStages.map(stageFromAuthoring);if(state.episodeStages.length)applyEpisodeStage(state.episodeStages[0],0);else clearEpisodeStages();els.episodeOutput.textContent="Loaded "+result.manifest.name+" with "+state.episodeStages.length+" stage"+(state.episodeStages.length===1?"":"s")+".";return loadEpisodeLayout().then(function(){if(authoring.episode){state.episodeDefinition=authoring.episode;state.episodeDefinitionActive=true}if(!state.episodeStages.length)setEpisodeMode("episode")})});
      }

      function stageFromSuggestion(value,title,scenes) {
        return {title:title||"New Story Stage",stageDescription:value.stageDescription||title||"New Story Stage",difficulty:value.difficulty||"NORMAL",actId:value.actId,stageIndex:value.stageIndex,stageUiNumber:value.stageUiNumber,unlockDungeonId:value.unlockDungeonId,stageId:value.stageId,dungeonId:value.dungeonId,cutsceneId:value.cutsceneId,stageStrId:value.stageStrId,dungeonStrId:value.dungeonStrId,cutsceneStrId:value.cutsceneStrId,background:value.background||"CAFE",music:"",stageCharacter:value.stageCharacter||"NKM_UNIT_C_POLICE_LEE_YUMI",actBackground:value.actBackground||state.episodeDefinition&&state.episodeDefinition.actBackground||"",episodeThumbnail:value.episodeThumbnail||state.episodeDefinition&&state.episodeDefinition.thumbnail||"",dungeonIcon:value.dungeonIcon||"NKM_NPC_CUT_SCENE",scenes:scenes||defaultEpisodeScenes()};
      }

      function nextEpisodeSuggestion(offset,requestedDifficulty) {
        if(offset>49)return Promise.reject(new Error("An Episode Maker project supports at most 50 generated stage slots."));
        var difficulty=requestedDifficulty||(state.episodeStages.length&&state.episodeStages[state.episodeStageIndex]?state.episodeStages[state.episodeStageIndex].difficulty||"NORMAL":"NORMAL");return api("episode-maker/suggest",{episodeId:els.episodeSelect.value,category:els.episodeCategory.value,offset:offset,difficulty:difficulty}).then(function(value){var collision=state.episodeStages.some(function(stage){return stage.stageId===value.stageId||stage.dungeonId===value.dungeonId||stage.cutsceneId===value.cutsceneId||stage.difficulty===value.difficulty&&stage.actId===value.actId&&stage.stageIndex===value.stageIndex});return collision?nextEpisodeSuggestion(offset+1,difficulty):value});
      }

      function addEpisodeStage(duplicate,insertAt,copySource) {
        syncEpisodeStage();var at=Number.isInteger(insertAt)?insertAt:state.episodeStages.length,source=copySource||(duplicate&&state.episodeStages[state.episodeStageIndex]);
        return nextEpisodeSuggestion(state.episodeStages.length,source&&source.difficulty).then(function(value){var scenes=source&&source.scenes?JSON.parse(JSON.stringify(source.scenes)):defaultEpisodeScenes(),title=source?(source.title+" Copy"):"New Story Stage "+(state.episodeStages.length+1),stage=stageFromSuggestion(value,title,scenes);if(source){stage.stageDescription=source.stageDescription||source.title;stage.stageCharacter=source.stageCharacter;stage.background=source.background||"CAFE";stage.music=source.music||"";stage.actBackground=source.actBackground||"";stage.episodeThumbnail=source.episodeThumbnail||"";stage.dungeonIcon=source.dungeonIcon||"NKM_NPC_CUT_SCENE";if(source.operation==="clone"){stage.operation="clone";stage.sourceObjectId=source.sourceObjectId;stage.sourceStageId=source.sourceStageId;stage.sourceEpisodeId=source.sourceEpisodeId;stage.sourceCategory=source.sourceCategory;stage.sourceDifficulty=source.sourceDifficulty;stage.cutsceneReadOnly=true;stage.cutsceneId=0;stage.cutsceneStrId="";stage.scenes=[];stage.previewScenes=cloneValue(source.previewScenes||[])}}if(at<state.episodeStages.length){var previous=state.episodeStages[Math.max(0,at-1)],index=previous.stageIndex+1,ui=previous.stageUiNumber+1;state.episodeStages.slice(at).forEach(function(item){if(item.operation!=="override"&&item.difficulty===stage.difficulty&&item.actId===stage.actId&&item.stageIndex>=index)item.stageIndex+=1;if(item.operation!=="override"&&item.difficulty===stage.difficulty&&item.actId===stage.actId&&item.stageUiNumber>=ui)item.stageUiNumber+=1});stage.stageIndex=index;stage.stageUiNumber=ui}state.episodeStages.splice(at,0,stage);applyEpisodeStage(stage,at);setEpisodeMode("stage")});
      }

      function cloneEpisodeBaseStage(detail) {
        if(!detail.raw.dungeon)return Promise.reject(new Error("This stage uses a shared non-dungeon battle template. Use an override for it; safe cloning needs a type-specific stage adapter."));
        return nextEpisodeSuggestion(state.episodeStages.length,detail.placement.difficulty).then(function(value){var stage=stageFromSuggestion(value,(detail.clientUi.title||detail.name)+" Copy",[]);stage.operation="clone";stage.sourceObjectId=detail.objectId;stage.sourceStageId=detail.ids.stageId;stage.sourceEpisodeId=detail.placement.episodeId;stage.sourceCategory=detail.placement.category;stage.sourceDifficulty=detail.placement.difficulty;stage.cutsceneReadOnly=true;stage.stageDescription=detail.clientUi.description||detail.clientUi.title||detail.name;stage.stageCharacter=detail.clientUi.avatar||stage.stageCharacter;stage.background=detail.override.background||"CAFE";stage.music=detail.override.music||"";stage.actBackground=detail.clientUi.actBackground||"";stage.episodeThumbnail=detail.clientUi.episodeThumbnail||"";stage.dungeonIcon=detail.clientUi.dungeonIcon||"";stage.cutsceneId=0;stage.cutsceneStrId="";stage.scenes=[];stage.previewScenes=detail.cutscenes.reduce(function(frames,cutscene){return frames.concat(cutscene.frames.map(function(frame){return Object.assign({cutsceneId:cutscene.id,cutsceneSlot:cutscene.slot},frame)}))},[]);state.episodeStages.push(stage);applyEpisodeStage(stage,state.episodeStages.length-1);setEpisodeMode("stage")});
      }

      function beginEpisodeOverride(detail) {
        var existing=state.episodeStages.findIndex(function(stage){return stage.operation==="override"&&stage.baseObjectId===detail.objectId});if(existing>=0){applyEpisodeStage(state.episodeStages[existing],existing);return}
        var stage=cloneValue(detail.override);stage.baseSnapshot=cloneValue(detail.override);stage.previewScenes=detail.cutscenes.reduce(function(frames,cutscene){return frames.concat(cutscene.frames.map(function(frame){return Object.assign({cutsceneId:cutscene.id,cutsceneSlot:cutscene.slot},frame)}))},[]);state.episodeStages.push(stage);applyEpisodeStage(stage,state.episodeStages.length-1);setEpisodeMode("stage");
      }

      function editEpisodeCutscene(detail) {
        if(detail)beginEpisodeOverride(detail);var stage=state.episodeStages[state.episodeStageIndex];if(!stage)return;if(stage.cutsceneReadOnly){stage.forkCutscenes=true;stage.cutsceneReadOnly=false;stage.scenes=cloneValue(stage.previewScenes||state.episodeScenes);delete stage.previewScenes;applyEpisodeStage(stage,state.episodeStageIndex)}setEpisodeMode("cutscene");
      }

      function episodeOverrideDiff(stage) {
        var base=stage&&stage.baseSnapshot;if(!base)return[];return [["Title","title"],["Description","stageDescription"],["Act","actId"],["Index","stageIndex"],["Stage number","stageUiNumber"],["Avatar","stageCharacter"],["Unlock value","unlockDungeonId"],["Act art","actBackground"],["Episode art","episodeThumbnail"],["Icon","dungeonIcon"],["Music","music"]].filter(function(field){return JSON.stringify(base[field[1]])!==JSON.stringify(stage[field[1]])}).map(function(field){return {label:field[0],before:base[field[1]],after:stage[field[1]]}});
      }

      function renderEpisodeOverrideDiff(stage) {
        var override=stage&&stage.operation==="override",changes=override?episodeOverrideDiff(stage):[];els.episodeOverrideChanges.hidden=!override;if(!override)return;els.episodeOverrideSummary.textContent=changes.length+" override change"+(changes.length===1?"":"s");els.episodeOverrideDiff.textContent=changes.length?changes.map(function(change){return change.label+": "+JSON.stringify(change.before)+" → "+JSON.stringify(change.after)}).join("\n"):"No fields differ from the protected base stage.";els.resetEpisodeOverride.disabled=!changes.length;
      }

      function resetEpisodeOverrideFields() {
        var stage=state.episodeStages[state.episodeStageIndex];if(!stage||stage.operation!=="override"||!stage.baseSnapshot)return;var reset=cloneValue(stage.baseSnapshot);reset.baseSnapshot=stage.baseSnapshot;reset.previewScenes=stage.previewScenes||[];state.episodeStages[state.episodeStageIndex]=reset;applyEpisodeStage(reset,state.episodeStageIndex);
      }

      function renderEpisodeOptions() {
        var previous=els.episodeSelect.value; clear(els.episodeSelect);
        (state.episodeCatalog?state.episodeCatalog.episodes:[]).filter(function(episode){return episode.category===els.episodeCategory.value}).forEach(function(episode){var option=document.createElement("option");option.value=episode.id;option.textContent=episode.label+" (ID "+episode.id+")";els.episodeSelect.appendChild(option)});
        if(Array.prototype.some.call(els.episodeSelect.options,function(option){return option.value===previous}))els.episodeSelect.value=previous;
        else if(els.episodeCategory.value==="EC_MAINSTREAM")els.episodeSelect.value="2";
      }

      function loadEpisodeSuggestion() {
        if(!els.episodeSelect.value)return Promise.resolve();
        var selected=(state.episodeCatalog&&state.episodeCatalog.episodes||[]).find(function(episode){return String(episode.id)===els.episodeSelect.value&&episode.category===els.episodeCategory.value});
        if(selected&&selected.custom){state.episodeDefinition=JSON.parse(JSON.stringify(selected.definition));clearEpisodeStages();if(els.episodeProjectId.value==="my-episode-mod")els.episodeProjectId.value="mainstream-episode-16";if(els.episodeProjectName.value==="My Episode Mod")els.episodeProjectName.value="Episode 16";els.episodeOutput.textContent="Blank Episode 16 ready. Configure the episode or add a stage.";setEpisodeMode("episode");return Promise.resolve()}
        els.episodeOutput.textContent="Finding the next stage slot…";
        return api("episode-maker/suggest",{episodeId:els.episodeSelect.value,category:els.episodeCategory.value}).then(function(value){
          var stage=stageFromSuggestion(value,state.episodeStages.length?els.episodeTitle.value:"New Story Stage",state.episodeScenes.length?state.episodeScenes:defaultEpisodeScenes());if(state.episodeStages.length)state.episodeStages[state.episodeStageIndex]=stage;else state.episodeStages.push(stage);applyEpisodeStage(stage,state.episodeStageIndex);
          els.episodeOutput.textContent="Append slot ready. Build one or more stages, then export the mod ZIP.";
        });
      }

      function sceneInput(label,value,oninput,wide,tag) {
        var wrap=document.createElement("label"); if(wide)wrap.className="wide"; wrap.appendChild(document.createTextNode(label)); var input=document.createElement(tag||"input"); input.value=value==null?"":value; input.oninput=function(){oninput(input.value);renderEpisodePreview()}; wrap.appendChild(input); return wrap;
      }

      function episodeAssetInput(label,value,oninput,kind,listId,wide) {
        var wrap=sceneInput(label,value,oninput,wide);var input=wrap.querySelector("input");if(listId)input.setAttribute("list",listId);
        var actions=document.createElement("div");actions.className="asset-field-actions";var preview=document.createElement("button");preview.type="button";preview.className="secondary";preview.textContent="◉ Preview";var output=document.createElement("div");output.className="field-asset-preview";preview.onclick=function(){showEpisodeAssetPreview(output,kind,input.value)};actions.appendChild(preview);wrap.append(actions,output);return wrap;
      }

      function episodeEffectInput(scene) {
        var wrap=sceneInput("FX order",(scene.effects||[]).join("\n"),function(value){scene.effects=value.split(/\r?\n/).map(function(item){return item.trim()}).filter(Boolean);renderEffectButtons()},true,"textarea");
        var actions=document.createElement("div");actions.className="asset-field-actions";var output=document.createElement("div");output.className="field-asset-preview";function renderEffectButtons(){clear(actions);scene.effects.forEach(function(effect){var button=document.createElement("button");button.type="button";button.className="secondary";button.textContent="◉ "+effect;button.title="Preview "+effect;button.onclick=function(){showEpisodeAssetPreview(output,"effect",effect)};actions.appendChild(button)})}renderEffectButtons();wrap.append(actions,output);return wrap;
      }

      function renderEpisodeScenes() {
        var previousScroll=els.episodeScenes.scrollLeft;clear(els.episodeScenes);var currentStage=state.episodeStages[state.episodeStageIndex];els.addEpisodeScene.disabled=Boolean(state.episodeSelectedNode&&state.episodeSelectedNode.source==="base"||currentStage&&(currentStage.cutsceneReadOnly||currentStage.forkCutscenes));els.episodeSceneCount.textContent=state.episodeScenes.length+" frames";els.episodeTimelineMeta.textContent=(state.episodeSceneIndex+1)+" / "+state.episodeScenes.length;
        state.episodeScenes.forEach(function(scene,index){
          var card=document.createElement("button");card.type="button";card.className="scene-card"+(index===state.episodeSceneIndex?" active":"");card.dataset.sceneIndex=String(index);var title=document.createElement("strong");title.textContent=(index+1)+". "+scene.speakerName;var dialogue=document.createElement("span");dialogue.textContent=scene.dialogue;card.append(title,dialogue);card.addEventListener("click",function(){setEpisodeScene(index)});
          els.episodeScenes.appendChild(card);
        });
        if(!state.episodeScenes.length){var message=document.createElement("div");message.className="subtle";message.textContent="Add the first dialogue scene.";els.episodeScenes.appendChild(message)}else els.episodeScenes.scrollLeft=previousScroll;
      }

      function inspectorSelect(label,values,current,onchange) {
        var wrap=document.createElement("label");wrap.appendChild(document.createTextNode(label));var select=document.createElement("select");values.forEach(function(value){var option=document.createElement("option");option.value=value;option.textContent=value;select.appendChild(option)});select.value=current;select.onchange=function(){onchange(select.value);renderEpisodePreview()};wrap.appendChild(select);return wrap;
      }

      function inspectorNumber(label,value,onchange,minimum,maximum) { var wrap=sceneInput(label,value,function(next){onchange(Number(next))});var input=wrap.querySelector("input");input.type="number";input.min=String(minimum);input.max=String(maximum);input.step="1";return wrap; }
      function inspectorCheck(label,checked,onchange) { var wrap=document.createElement("label");wrap.className="scene-check wide";var input=document.createElement("input");input.type="checkbox";input.checked=checked;input.onchange=function(){onchange(input.checked)};wrap.append(input,document.createTextNode(label));return wrap; }

      function inspectorGroup(label,children) { var details=document.createElement("details"),summary=document.createElement("summary"),body=document.createElement("div");details.className="inspector-group";summary.textContent=label;body.className="episode-form-grid";children.forEach(function(child){body.appendChild(child)});details.append(summary,body);return details; }
      function inspectorReadOnly(label,value,wide) { var field=sceneInput(label,value,function(){},wide);field.querySelector("input").disabled=true;return field; }
      function inspectorJson(label,value) { var details=document.createElement("details"),summary=document.createElement("summary"),pre=document.createElement("pre");details.className="inspector-group";summary.textContent=label;pre.textContent=JSON.stringify(value,null,2);details.append(summary,pre);return details; }
      function blankEpisodeRewards() { return [{completeRate:0,rewardType:"",rewardId:0,rewardValue:0},{completeRate:0,rewardType:"",rewardId:0,rewardValue:0},{completeRate:0,rewardType:"",rewardId:0,rewardValue:0}]; }
      function completionRewardsGroup(label,rewards) { var fields=[];for(var index=0;index<3;index+=1){(function(tier){var reward=rewards[tier];fields.push(inspectorNumber("T"+(tier+1)+" clear %",reward.completeRate,function(value){reward.completeRate=value},0,100));fields.push(sceneInput("T"+(tier+1)+" type",reward.rewardType,function(value){reward.rewardType=value},true));fields.push(inspectorNumber("T"+(tier+1)+" item ID",reward.rewardId,function(value){reward.rewardId=value},0,2147483647));fields.push(inspectorNumber("T"+(tier+1)+" quantity",reward.rewardValue,function(value){reward.rewardValue=value},0,2147483647))})(index)}return inspectorGroup("◆ "+label,fields); }
      function resourceChangeGroup(label,resource) { return inspectorGroup("♫ "+label,[sceneInput("Mission condition",resource.missionCondition,function(value){resource.missionCondition=value},true),inspectorNumber("Mission value",resource.missionValue,function(value){resource.missionValue=value},0,2147483647),episodeAssetInput("New music",resource.backgroundMusic,function(value){resource.backgroundMusic=value},"music","episodeMusicOptions",true)]); }

      function inspectorButton(label,className,onclick,disabled) { var button=document.createElement("button");button.type="button";button.className=className||"secondary";button.textContent=label;button.disabled=Boolean(disabled);button.onclick=onclick;return button; }
      function inspectorActions() { var row=document.createElement("div");row.className="button-row";Array.prototype.slice.call(arguments).forEach(function(button){row.appendChild(button)});return row; }

      function addEpisodeActor(scene) { if(scene.actors.length>=6)return;scene.actors.push({actorId:scene.speakerActorId||"YUMI_POLICE_NULL_NULL",position:"C",animation:"UNIT_IDLE",visible:true,previewAsset:""});state.episodeSelection={type:"actor",actorIndex:scene.actors.length-1};renderEpisodeInspectors();renderEpisodePreview(); }

      function renderEpisodeInspectors() {
        var episodeMode=state.episodeMode==="episode",stageMode=state.episodeMode==="stage",node=state.episodeSelectedNode;els.episodeOverrideChanges.hidden=true;
        if(episodeMode){
          els.episodeStageDetails.hidden=true;els.episodeStageFrame.hidden=true;els.episodeSelectionFields.hidden=false;els.episodeFrameFields.hidden=false;clear(els.episodeSelectionFields);clear(els.episodeFrameFields);var definition=state.episodeDefinition;
          els.episodeSelectionTitle.textContent=definition?(definition.custom?"Episode 16":"Episode "+definition.episodeId):"Episode";els.episodeSelectionMeta.textContent=definition&&definition.custom?"New client UI":"Base UI override";els.episodeFrameTitle.textContent="Registration & Hard mode";els.episodeFrameMeta.textContent=definition&&definition.custom?"Validated game data":"Stable base identities";
          if(!definition){var note=document.createElement("div");note.className="subtle wide";note.textContent="Select an episode first.";els.episodeSelectionFields.appendChild(note);return}
          definition.summary=definition.summary||{};definition.hardMode=definition.hardMode||{};definition.completionRewards=definition.completionRewards||blankEpisodeRewards();definition.resourceChange=definition.resourceChange||{missionCondition:"",missionValue:0,backgroundMusic:""};definition.hardMode.completionRewards=definition.hardMode.completionRewards||blankEpisodeRewards();definition.hardMode.resourceChange=definition.hardMode.resourceChange||{missionCondition:"",missionValue:0,backgroundMusic:""};
          els.episodeSelectionFields.appendChild(sceneInput("Title",definition.title,function(value){definition.title=value},false));
          els.episodeSelectionFields.appendChild(sceneInput("Name",definition.name,function(value){definition.name=value},false));
          els.episodeSelectionFields.appendChild(sceneInput("Description",definition.description,function(value){definition.description=value},true,"textarea"));
          els.episodeSelectionFields.appendChild(sceneInput("Extra description",definition.extraDescription,function(value){definition.extraDescription=value},true,"textarea"));
          els.episodeSelectionFields.appendChild(inspectorNumber("Normal acts",definition.actCount,function(value){definition.actCount=value},1,50));
          els.episodeSelectionFields.appendChild(inspectorSelect("Scroll",["HORIZONTAL","VERTICAL"],definition.scrollType,function(value){definition.scrollType=value}));
          els.episodeSelectionFields.appendChild(episodeAssetInput("Stage UI prefab",definition.stageViewerPrefab,function(value){definition.stageViewerPrefab=value},"image",null,true));
          els.episodeSelectionFields.appendChild(episodeAssetInput("Episode art",definition.thumbnail,function(value){definition.thumbnail=value},"image",null,true));
          els.episodeSelectionFields.appendChild(episodeAssetInput("Act background",definition.actBackground||"",function(value){definition.actBackground=value},"image",null,true));
          els.episodeSelectionFields.appendChild(episodeAssetInput("Music",definition.backgroundMusic||"",function(value){definition.backgroundMusic=value},"music","episodeMusicOptions",true));
          els.episodeSelectionFields.appendChild(inspectorCheck("Hide act tabs",definition.hideActTabs,function(value){definition.hideActTabs=value}));
          els.episodeSelectionFields.appendChild(inspectorCheck("No collection cutscene",definition.noCollectionCutscene,function(value){definition.noCollectionCutscene=value}));
          els.episodeSelectionFields.appendChild(completionRewardsGroup("Completion rewards",definition.completionRewards));
          els.episodeSelectionFields.appendChild(resourceChangeGroup("Mid-episode music change",definition.resourceChange));
          els.episodeFrameFields.appendChild(inspectorNumber("Group ID",definition.groupId,function(value){definition.groupId=value},1,999999999));
          els.episodeFrameFields.appendChild(sceneInput("Connected IDs",(definition.connectedEpisodeIds||[]).join(", "),function(value){definition.connectedEpisodeIds=commaList(value).map(Number)}));
          els.episodeFrameFields.appendChild(definition.custom?sceneInput("Normal open tag",definition.openTag,function(value){definition.openTag=value},true):inspectorReadOnly("Normal open tag",definition.openTag,true));
          els.episodeFrameFields.appendChild(definition.custom?sceneInput("Collection tag",definition.collectionOpenTag,function(value){definition.collectionOpenTag=value},true):inspectorReadOnly("Collection tag",definition.collectionOpenTag,true));
          els.episodeFrameFields.appendChild(inspectorNumber("Horizontal pan",definition.layoutPanX,function(value){definition.layoutPanX=value},0,5000));
          els.episodeFrameFields.appendChild(inspectorNumber("Vertical pan",definition.layoutPanY,function(value){definition.layoutPanY=value},0,5000));
          els.episodeFrameFields.appendChild(episodeAssetInput("Summary lobby art",definition.summary.lobbyResourceId,function(value){definition.summary.lobbyResourceId=value},"image",null,true));
          els.episodeFrameFields.appendChild(episodeAssetInput("Summary large art",definition.summary.bigResourceId,function(value){definition.summary.bigResourceId=value},"image",null,true));
          els.episodeFrameFields.appendChild(episodeAssetInput("Summary thumbnail",definition.summary.subResourceId,function(value){definition.summary.subResourceId=value},"image",null,true));
          els.episodeFrameFields.appendChild(sceneInput("Summary caption",definition.summary.dateText,function(value){definition.summary.dateText=value},true));
          els.episodeFrameFields.appendChild(definition.custom?inspectorCheck("Enable Hard mode",definition.hardMode.enabled,function(value){definition.hardMode.enabled=value;renderEpisodeInspectors()}):inspectorReadOnly("Hard mode",definition.hardMode.enabled?"Enabled in base game":"Not present in base game",true));
          if(definition.hardMode.enabled){els.episodeFrameFields.appendChild(inspectorNumber("Hard acts",definition.hardMode.actCount,function(value){definition.hardMode.actCount=value},1,50));els.episodeFrameFields.appendChild(inspectorSelect("Hard scroll",["HORIZONTAL","VERTICAL"],definition.hardMode.scrollType,function(value){definition.hardMode.scrollType=value}));els.episodeFrameFields.appendChild(definition.custom?sceneInput("Hard open tag",definition.hardMode.openTag,function(value){definition.hardMode.openTag=value},true):inspectorReadOnly("Hard open tag",definition.hardMode.openTag,true));els.episodeFrameFields.appendChild(episodeAssetInput("Hard stage UI",definition.hardMode.stageViewerPrefab,function(value){definition.hardMode.stageViewerPrefab=value},"image",null,true));els.episodeFrameFields.appendChild(episodeAssetInput("Hard episode art",definition.hardMode.thumbnail,function(value){definition.hardMode.thumbnail=value},"image",null,true));els.episodeFrameFields.appendChild(episodeAssetInput("Hard music",definition.hardMode.backgroundMusic||"",function(value){definition.hardMode.backgroundMusic=value},"music","episodeMusicOptions",true));els.episodeFrameFields.appendChild(inspectorCheck("Hide Hard act tabs",definition.hardMode.hideActTabs,function(value){definition.hardMode.hideActTabs=value}));els.episodeFrameFields.appendChild(inspectorCheck("No Hard collection cutscene",definition.hardMode.noCollectionCutscene!==false,function(value){definition.hardMode.noCollectionCutscene=value}));els.episodeFrameFields.appendChild(completionRewardsGroup("Hard completion rewards",definition.hardMode.completionRewards));els.episodeFrameFields.appendChild(resourceChangeGroup("Hard music change",definition.hardMode.resourceChange))}
          return;
        }
        els.episodeStageDetails.hidden=!stageMode||!state.episodeStages.length||Boolean(node&&node.source==="base");els.episodeStageFrame.hidden=!stageMode||!state.episodeStages.length||Boolean(node&&node.source==="base");els.episodeSelectionFields.hidden=stageMode&&!node||stageMode&&node&&node.source!=="base";els.episodeFrameFields.hidden=stageMode&&!node||stageMode&&node&&node.source!=="base";clear(els.episodeSelectionFields);clear(els.episodeFrameFields);
        if(stageMode){
          if(node&&node.source==="base"){
            var base=node.stage,detail=state.episodeBaseDetail;els.episodeSelectionFields.hidden=false;els.episodeFrameFields.hidden=false;els.episodeSelectionTitle.textContent=base.title;els.episodeSelectionMeta.textContent="Base game · protected";els.episodeFrameTitle.textContent="Placement & linked data";els.episodeFrameMeta.textContent="Read-only";
            if(!detail){els.episodeSelectionFields.appendChild(inspectorReadOnly("Status","Loading complete stage data…",true));return}
            [["Type",detail.kind],["Stage string ID",detail.ids.stageStrId],["Dungeon string ID",detail.ids.dungeonStrId],["Avatar",detail.clientUi.avatar],["Dungeon icon",detail.clientUi.dungeonIcon],["Cutscenes",detail.cutscenes.length]].forEach(function(field){els.episodeSelectionFields.appendChild(inspectorReadOnly(field[0],field[1],true))});
            var actions=[inspectorButton("Edit override","primary",function(){beginEpisodeOverride(detail)}),inspectorButton("⧉ Clone stage","secondary",function(){cloneEpisodeBaseStage(detail).catch(showError)},!detail.raw.dungeon)];if(state.episodeScenes.length){actions.unshift(inspectorButton("▶ Preview cutscene","secondary",function(){setEpisodeMode("cutscene")}));actions.unshift(inspectorButton("✎ Fork cutscene","primary",function(){editEpisodeCutscene(detail)},!detail.raw.dungeon))}els.episodeSelectionFields.appendChild(inspectorActions.apply(null,actions));
            [["Difficulty",detail.placement.difficulty],["Act",detail.placement.actId],["Placement",detail.placement.stageIndex],["Stage number",detail.placement.stageNumber],["Stage ID",detail.ids.stageId],["Dungeon ID",detail.ids.dungeonId],["Unlock type",detail.unlock.requirementType],["Unlock value",detail.unlock.requirementValue]].forEach(function(field){els.episodeFrameFields.appendChild(inspectorReadOnly(field[0],field[1]))});els.episodeFrameFields.appendChild(inspectorJson("Raw episode, stage and dungeon records",detail.raw));els.episodeFrameFields.appendChild(inspectorJson("Linked cutscene records",detail.cutscenes.map(function(cutscene){return {slot:cutscene.slot,id:cutscene.id,registered:cutscene.registered,registration:cutscene.registration,recordCount:cutscene.recordCount,error:cutscene.error,events:cutscene.events}})));return;
          }
          var current=state.episodeStages[state.episodeStageIndex],override=current&&current.operation==="override",clone=current&&current.operation==="clone",movable=movableEpisodeStageIndexes(current),position=movable.indexOf(state.episodeStageIndex);els.episodeSelectionTitle.textContent=state.episodeStages.length?(els.episodeTitle.value||"Custom stage"):"No custom stage";els.episodeSelectionMeta.textContent=current&&current.forkCutscenes?"Source-preserving cutscene fork":override?"Base override":clone?"Stage clone":"New stage";els.episodeFrameTitle.textContent="Placement & IDs";els.episodeFrameMeta.textContent=override?"Stable base IDs":clone?"Generated IDs · shared cutscenes · forkable":"Generated IDs";els.deleteEpisodeStage.textContent=override?"× Remove override":"× Delete";els.deleteEpisodeStage.disabled=!state.episodeStages.length;els.insertEpisodeStage.disabled=override;els.duplicateEpisodeStage.disabled=override;els.stageEarlier.disabled=override||position<=0;els.stageLater.disabled=override||position<0||position>=movable.length-1;renderEpisodeOverrideDiff(current);return;
        }
        els.episodeStageDetails.hidden=true;els.episodeStageFrame.hidden=true;els.episodeSelectionFields.hidden=false;els.episodeFrameFields.hidden=false;
        if(!state.episodeScenes.length)return;var scene=state.episodeScenes[state.episodeSceneIndex],selection=state.episodeSelection||{type:"scene"},fork=Boolean(state.episodeStages[state.episodeStageIndex]&&state.episodeStages[state.episodeStageIndex].forkCutscenes);scene.actors=scene.actors||[];scene.effects=scene.effects||[];
        var previewOnly=node&&node.source==="base"||state.episodeStages[state.episodeStageIndex]&&state.episodeStages[state.episodeStageIndex].cutsceneReadOnly;
        if(previewOnly){
          els.episodeSelectionTitle.textContent="Frame "+(state.episodeSceneIndex+1);els.episodeSelectionMeta.textContent=(scene.cutsceneSlot||"cutscene")+(node&&node.source==="base"?" · base game":" · override preview");els.episodeFrameTitle.textContent="Source event";els.episodeFrameMeta.textContent="Read-only until Cutscene Studio";
          [["Speaker",scene.speakerName],["Actor ID",scene.speakerActorId],["Dialogue",scene.dialogue],["Voice",scene.voiceLine]].forEach(function(field){els.episodeSelectionFields.appendChild(inspectorReadOnly(field[0],field[1],true))});
          [["Process",scene.processKey],["Transition",scene.transition],["Fade",scene.fadeTime],["Background",scene.background],["Music",scene.music]].forEach(function(field){els.episodeFrameFields.appendChild(inspectorReadOnly(field[0],field[1]))});els.episodeFrameFields.appendChild(inspectorJson("Raw cutscene event",scene.raw));return;
        }
        if(selection.type==="actor"&&scene.actors[selection.actorIndex]){
          var actor=scene.actors[selection.actorIndex],actorIndex=selection.actorIndex;els.episodeSelectionTitle.textContent=actor.actorId||"Actor";els.episodeSelectionMeta.textContent="Layer "+(actorIndex+1)+" of "+scene.actors.length;
          els.episodeSelectionFields.appendChild(episodeAssetInput("Actor ID",actor.actorId,function(value){actor.actorId=value},"actor","episodeActorOptions",true));els.episodeSelectionFields.appendChild(inspectorSelect("Position",["L","C","R"],actor.position||"C",function(value){actor.position=value}));var mood=sceneInput("Mood / face animation",actor.animation||"UNIT_IDLE",function(value){actor.animation=value},false);mood.querySelector("input").setAttribute("list","episodeAnimationOptions");els.episodeSelectionFields.appendChild(mood);els.episodeSelectionFields.appendChild(sceneInput("Custom preview path",actor.previewAsset||"",function(value){actor.previewAsset=value},true));
          var visible=document.createElement("label");visible.className="scene-check wide";var visibleBox=document.createElement("input");visibleBox.type="checkbox";visibleBox.checked=actor.visible!==false;visibleBox.onchange=function(){actor.visible=visibleBox.checked;renderEpisodePreview()};visible.append(visibleBox,document.createTextNode("Visible in this frame"));els.episodeSelectionFields.appendChild(visible);
          els.episodeSelectionFields.appendChild(inspectorActions(inspectorButton("↓ Back","secondary",function(){moveEpisodeActor(actorIndex,-1)},actorIndex===0),inspectorButton("↑ Front","secondary",function(){moveEpisodeActor(actorIndex,1)},actorIndex===scene.actors.length-1),inspectorButton("× Delete","danger",function(){scene.actors.splice(actorIndex,1);state.episodeSelection={type:"scene"};renderEpisodeInspectors();renderEpisodePreview()},fork)));
        }else if(selection.type==="background"){
          els.episodeSelectionTitle.textContent="Background";els.episodeSelectionMeta.textContent="Canvas layer";els.episodeSelectionFields.appendChild(episodeAssetInput("Background",scene.background||els.episodeBackground.value,function(value){scene.background=value},"background","episodeBackgrounds",true));els.episodeSelectionFields.appendChild(episodeAssetInput("Music",scene.music||els.episodeMusic.value,function(value){scene.music=value},"music","episodeMusicOptions",true));els.episodeSelectionFields.appendChild(inspectorActions(inspectorButton("+ Actor","primary",function(){addEpisodeActor(scene)},fork||scene.actors.length>=6)));
        }else{
          state.episodeSelection={type:"scene"};els.episodeSelectionTitle.textContent="Frame "+(state.episodeSceneIndex+1);els.episodeSelectionMeta.textContent=fork?"Preserved source event":scene.actors.length+" actors";els.episodeSelectionFields.appendChild(sceneInput("Speaker",scene.speakerName,function(value){scene.speakerName=value;renderEpisodeScenes()}));els.episodeSelectionFields.appendChild(episodeAssetInput("Actor ID",scene.speakerActorId,function(value){scene.speakerActorId=value},"actor","episodeActorOptions"));els.episodeSelectionFields.appendChild(sceneInput("Dialogue",scene.dialogue,function(value){scene.dialogue=value;renderEpisodeScenes()},true,"textarea"));els.episodeSelectionFields.appendChild(episodeAssetInput("Voice",scene.voiceLine||"",function(value){scene.voiceLine=value},"voice","episodeVoiceOptions",true));
          els.episodeSelectionFields.appendChild(inspectorActions(inspectorButton("+ Actor","primary",function(){addEpisodeActor(scene)},fork||scene.actors.length>=6),inspectorButton("↑ Earlier","secondary",function(){moveEpisodeScene(state.episodeSceneIndex,-1)},state.episodeSceneIndex===0),inspectorButton("↓ Later","secondary",function(){moveEpisodeScene(state.episodeSceneIndex,1)},state.episodeSceneIndex===state.episodeScenes.length-1),inspectorButton("⧉ Copy","secondary",function(){var copy=JSON.parse(JSON.stringify(scene));state.episodeScenes.splice(state.episodeSceneIndex+1,0,copy);setEpisodeScene(state.episodeSceneIndex+1)},fork),inspectorButton("× Delete","danger",function(){deleteEpisodeScene()},fork||state.episodeScenes.length<=1)));
        }
        els.episodeFrameTitle.textContent="Timing & FX";els.episodeFrameMeta.textContent="Frame settings";els.episodeFrameFields.appendChild(inspectorSelect("Transition",["FADE","CUT"],scene.transition||"FADE",function(value){scene.transition=value}));var fade=sceneInput("Fade (seconds)",scene.fadeTime==null?1:scene.fadeTime,function(value){scene.fadeTime=Number(value)});var fadeInput=fade.querySelector("input");fadeInput.type="number";fadeInput.min="0";fadeInput.max="10";fadeInput.step="0.1";els.episodeFrameFields.appendChild(fade);els.episodeFrameFields.appendChild(episodeAssetInput("Background",scene.background||"",function(value){scene.background=value},"background","episodeBackgrounds"));els.episodeFrameFields.appendChild(episodeAssetInput("Music",scene.music||"",function(value){scene.music=value},"music","episodeMusicOptions"));els.episodeFrameFields.appendChild(episodeEffectInput(scene));var dim=document.createElement("label");dim.className="scene-check wide";var dimBox=document.createElement("input");dimBox.type="checkbox";dimBox.checked=scene.dimActors===true;dimBox.onchange=function(){scene.dimActors=dimBox.checked;renderEpisodePreview()};dim.append(dimBox,document.createTextNode("Dim actors"));els.episodeFrameFields.appendChild(dim);
      }

      function moveEpisodeActor(index,direction) { var scene=state.episodeScenes[state.episodeSceneIndex],next=index+direction;if(next<0||next>=scene.actors.length)return;var actor=scene.actors[index];scene.actors[index]=scene.actors[next];scene.actors[next]=actor;state.episodeSelection={type:"actor",actorIndex:next};renderEpisodeInspectors();renderEpisodePreview(); }
      function deleteEpisodeScene() { if(state.episodeScenes.length<=1)return;state.episodeScenes.splice(state.episodeSceneIndex,1);state.episodeSceneIndex=Math.min(state.episodeSceneIndex,state.episodeScenes.length-1);state.episodeSelection={type:"scene"};renderEpisodeScenes();renderEpisodeInspectors();renderEpisodePreview(); }
      function moveEpisodeScene(index,direction) { var next=index+direction;if(next<0||next>=state.episodeScenes.length)return;var scene=state.episodeScenes[index];state.episodeScenes[index]=state.episodeScenes[next];state.episodeScenes[next]=scene;state.episodeSceneIndex=next;state.episodeSelection={type:"scene"};renderEpisodeScenes();renderEpisodeInspectors();renderEpisodePreview(); }
      function setEpisodeScene(index) { if(!state.episodeScenes.length)return;state.episodeSceneIndex=Math.max(0,Math.min(index,state.episodeScenes.length-1));state.episodeSelection={type:"scene"};Array.prototype.forEach.call(els.episodeScenes.children,function(card){card.classList.toggle("active",Number(card.dataset.sceneIndex)===state.episodeSceneIndex)});renderEpisodeScenes();renderEpisodeInspectors();renderEpisodePreview(); }

      function saveEpisodeMod(download) {
        syncEpisodeStage();if(state.episodeStages.some(function(stage){return !stage.cutsceneReadOnly&&(!Array.isArray(stage.scenes)||!stage.scenes.length)}))throw new Error("Every new cutscene stage needs at least one dialogue frame.");
        var exportedStages=state.episodeStages.map(function(stage){var value=Object.assign({},stage);delete value.previewScenes;delete value.baseSnapshot;return value}),body={projectId:els.episodeProjectId.value.trim(),projectName:els.episodeProjectName.value.trim(),category:els.episodeCategory.value,episodeId:Number(els.episodeSelect.value),episode:state.episodeDefinitionActive?state.episodeDefinition:undefined,stages:exportedStages};
        els.saveEpisode.disabled=true;els.sendEpisodeToModside.disabled=true;els.episodeOutput.textContent="Building cutscene tables and mod project…";
        return writeApi("episode-maker/create","POST",body).then(function(result){var sceneCount=result.authoring.stages.reduce(function(total,stage){return total+stage.scenes.length},0),overrideCount=result.authoring.stages.filter(function(stage){return stage.operation==="override"}).length,cloneCount=result.authoring.stages.filter(function(stage){return stage.operation==="clone"}).length,newCount=result.authoring.stages.length-overrideCount-cloneCount;els.episodeOutput.textContent=result.authoring.title+" saved · "+overrideCount+" override"+(overrideCount===1?"":"s")+" · "+cloneCount+" clone"+(cloneCount===1?"":"s")+" · "+newCount+" new · "+sceneCount+" frames"+(download?". Downloading "+result.exportFileName+"…":".");return Promise.all([loadProjects(),loadEpisodeProjects()]).then(function(){if(download)window.location.href=BASE_PATH+"/api/mods/"+encodeURIComponent(result.project.manifest.id)+"/export";return result})}).finally(function(){els.saveEpisode.disabled=false;els.sendEpisodeToModside.disabled=false});
      }

      function sendEpisodeModToLoader() {
        return saveEpisodeMod(false).then(function(result){return api("mods/"+encodeURIComponent(result.project.manifest.id)+"/validate").then(function(report){if(!report.ok)throw new Error((report.errors||[]).join("\n")||"The Story:Side mod did not validate.");window.location.href=BASE_PATH+"?view=loader"})});
      }

      function episodeCatalogAsset(kind,id) {
        var catalog=state.episodeCatalog||{},needle=String(id||"").toUpperCase();
        if(kind==="actor"){var actor=(catalog.actors||[]).find(function(item){return String(item.id).toUpperCase()===needle});if(actor&&actor.previewAsset)return {path:actor.previewAsset,type:"image"}}
        var key=kind==="voice"?"voices":kind==="music"?"music":kind+"s";var item=(catalog[key]||[]).find(function(value){return String(typeof value==="string"?value:value.id).toUpperCase()===needle});return item&&typeof item!=="string"?item:null;
      }

      function episodeAssetRoute(kind,id,custom) {
        if(custom)return custom.indexOf("/")>=0?"asset?path="+encodeURIComponent(custom):custom;
        var found=episodeCatalogAsset(kind,id);if(found&&found.path)return "asset?path="+encodeURIComponent(found.path);
        if(kind==="actor"){var assets=state.episodeCatalog&&state.episodeCatalog.previewAssets||{};return assets[String(id||"").toUpperCase()]||""}return "";
      }

      function showEpisodeAssetPreview(output,kind,id) {
        clear(output);if(!String(id||"").trim()){output.textContent="Optional; no asset selected.";return Promise.resolve()}
        var route=kind==="actor"&&episodeAssetRoute(kind,id,"");if(route){var image=document.createElement("img");image.alt=String(id)+" preview";image.src=BASE_PATH+"/api/"+route;output.appendChild(image);return Promise.resolve()}
        var known=episodeCatalogAsset(kind,id);var request=known?Promise.resolve({found:true,id:id,kind:kind,path:known.path,type:known.type}):api("episode-maker/asset",{kind:kind,id:id});
        output.textContent="Finding extracted asset…";return request.then(function(asset){clear(output);if(!asset.found){output.textContent="No extracted asset match. The game ID is still editable.";return}var media;if(asset.type==="audio"){media=document.createElement("audio");media.controls=true;media.preload="metadata"}else{media=document.createElement("img");media.alt=String(id)+" preview"}media.src=BASE_PATH+"/api/asset?path="+encodeURIComponent(asset.path);output.appendChild(media)}).catch(function(){output.textContent="Extracted preview unavailable."});
      }

      function previewStaticEpisodeAssets() {
        showEpisodeAssetPreview(els.episodeBackgroundPreview,"background",els.episodeBackground.value);showEpisodeAssetPreview(els.episodeMusicPreview,"music",els.episodeMusic.value);showEpisodeAssetPreview(els.episodeStageCharacterPreview,"actor",els.episodeStageCharacter.value);showEpisodeAssetPreview(els.episodeActBackgroundPreview,"image",els.episodeActBackground.value);showEpisodeAssetPreview(els.episodeThumbnailPreview,"image",els.episodeThumbnail.value);showEpisodeAssetPreview(els.episodeDungeonIconPreview,"image",els.episodeDungeonIcon.value);
      }

      function setEpisodeMode(mode) {
        state.episodeMode=mode==="episode"?"episode":mode==="cutscene"?"cutscene":"stage";var episode=state.episodeMode==="episode",stage=state.episodeMode==="stage",cutscene=state.episodeMode==="cutscene";els.episodeDefinitionMode.classList.toggle("active",episode);els.episodeStageMode.classList.toggle("active",stage);els.episodeCutsceneMode.classList.toggle("active",cutscene);els.episodeStageCanvasWrap.hidden=cutscene;els.episodeCutsceneCanvasWrap.hidden=!cutscene;els.episodeTimeline.hidden=!cutscene;if(cutscene&&state.episodeSelection.type==="stage")state.episodeSelection={type:"scene"};renderEpisodeWorkspace();
      }

      function renderEpisodeWorkspace() {
        if(state.episodeMode!=="cutscene"){renderStageLayout();renderEpisodeInspectors();updateEpisodeControls();return}renderEpisodeScenes();renderEpisodeInspectors();renderEpisodePreview();
      }

      function initStageGl() {
        if(state.stageGl)return state.stageGl;var gl=els.episodeStageCanvas.getContext("webgl",{alpha:false});if(!gl)return null;
        function shader(type,source){var value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value));return value}
        var program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}"));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,"precision mediump float;uniform vec4 color;void main(){gl_FragColor=color;}"));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);var buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);var position=gl.getAttribLocation(program,"p"),color=gl.getUniformLocation(program,"color");gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        function rect(x,y,w,h,rgba){var left=x/640-1,right=(x+w)/640-1,top=1-y/360,bottom=1-(y+h)/360;gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([left,bottom,right,bottom,left,top,left,top,right,bottom,right,top]),gl.STREAM_DRAW);gl.uniform4fv(color,rgba);gl.drawArrays(gl.TRIANGLES,0,6)}
        state.stageGl={begin:function(){gl.viewport(0,0,1280,720);gl.clearColor(.025,.05,.075,1);gl.clear(gl.COLOR_BUFFER_BIT)},rect:rect};return state.stageGl;
      }

      function stageLayoutNodes() {
        var overridden=new Set(state.episodeStages.filter(function(stage){return stage.operation==="override"}).map(function(stage){return stage.stageId+":"+stage.difficulty}));return state.episodeBaseStages.filter(function(stage){return !overridden.has(stage.stageId+":"+stage.difficulty)}).map(function(stage){return {source:"base",stage:stage}}).concat(state.episodeStages.map(function(stage,index){return {source:"mod",stage:stage,index:index}})).sort(function(left,right){return Number(left.stage.difficulty==="HARD")-Number(right.stage.difficulty==="HARD")||left.stage.actId-right.stage.actId||left.stage.stageIndex-right.stage.stageIndex||left.source.localeCompare(right.source)});
      }

      function renderStageLayout() {
        if(state.episodeMode==="cutscene")return;var renderer=initStageGl();if(!renderer){els.episodePreviewMeta.textContent="WebGL unavailable";return}renderer.begin();clear(els.episodeStageLabels);var nodes=stageLayoutNodes(),groups=Array.from(new Set(nodes.map(function(node){return (node.stage.difficulty||"NORMAL")+":"+node.stage.actId}))),rects=[],panX=state.stagePanX,panY=state.stagePanY;
        groups.forEach(function(group,row){var actNodes=nodes.filter(function(node){return (node.stage.difficulty||"NORMAL")+":"+node.stage.actId===group}),count=actNodes.length,step=count>1?Math.min(180,1080/(count-1)):0,width=Math.max(72,Math.min(140,step?step-24:140)),y=90+row*Math.min(150,520/Math.max(1,groups.length-1))+panY;actNodes.forEach(function(node,index){var x=(count===1?570:100+index*step)+panX;if(index){var previous=rects[rects.length-1];renderer.rect(previous.x+previous.w,previous.y+previous.h/2-3,Math.max(0,x-(previous.x+previous.w)),6,[.23,.38,.48,1])}var selected=state.episodeSelectedNode&&(node.source==="base"&&state.episodeSelectedNode.source==="base"&&state.episodeSelectedNode.stage.stageId===node.stage.stageId&&state.episodeSelectedNode.stage.difficulty===node.stage.difficulty||node.source==="mod"&&state.episodeSelectedNode.source==="mod"&&state.episodeSelectedNode.index===node.index),drop=state.stageNodeDrag&&state.stageNodeDrag.dropIndex===node.index,color=drop?[.25,.8,.66,1]:selected?[.18,.75,.64,1]:node.source==="mod"?[.08,.42,.37,1]:[.12,.22,.32,1];renderer.rect(x,y,width,72,color);renderer.rect(x,y,width,4,drop||selected?[.65,1,.91,1]:node.source==="mod"?[.35,.82,.72,1]:[.38,.52,.66,1]);var record={source:node.source,stage:node.stage,index:node.index,x:x,y:y,w:width,h:72};rects.push(record);var label=document.createElement("div");label.className="stage-node-label "+node.source+(drop?" drop-target":"");label.style.left=(x/12.8)+"%";label.style.top=(y/7.2)+"%";label.style.width=(width/12.8)+"%";label.style.height="10%";label.textContent=(node.stage.operation==="clone"?"⧉ ":"")+(node.stage.difficulty==="HARD"?"H":"")+node.stage.stageUiNumber;label.title=(node.stage.difficulty||"NORMAL")+" · Act "+node.stage.actId+" · "+(node.stage.stageStrId||node.stage.title)+(node.source==="mod"&&node.stage.operation!=="override"?" · drag to reorder":"");els.episodeStageLabels.appendChild(label)})});
        state.stageNodeRects=rects;var hard=state.episodeBaseStages.filter(function(stage){return stage.difficulty==="HARD"}).length,overrides=state.episodeStages.filter(function(stage){return stage.operation==="override"}).length,clones=state.episodeStages.filter(function(stage){return stage.operation==="clone"}).length;els.episodePreviewMeta.textContent=(state.episodeBaseStages.length-hard)+" Normal · "+hard+" Hard · "+overrides+" override"+(overrides===1?"":"s")+" · "+clones+" clone"+(clones===1?"":"s")+" · "+(state.episodeStages.length-overrides-clones)+" new";
      }

      function stageCanvasPoint(event) { var bounds=els.episodeStageCanvas.getBoundingClientRect();return {x:(event.clientX-bounds.left)*1280/bounds.width,y:(event.clientY-bounds.top)*720/bounds.height}; }
      function stageNodeAtPoint(point) { return state.stageNodeRects.slice().reverse().find(function(rect){return point.x>=rect.x&&point.x<=rect.x+rect.w&&point.y>=rect.y&&point.y<=rect.y+rect.h}); }
      function finishStagePan(event,select) { var drag=state.stagePanDrag;if(!drag||drag.pointerId!==event.pointerId)return;if(els.episodeStageCanvas.hasPointerCapture(event.pointerId))els.episodeStageCanvas.releasePointerCapture(event.pointerId);state.stagePanDrag=null;if(select&&!drag.moved)selectStageNode(stageNodeAtPoint(stageCanvasPoint(event))); }
      function movableEpisodeStageIndexes(stage) { if(!stage||stage.operation==="override")return[];return state.episodeStages.map(function(item,index){return {item:item,index:index}}).filter(function(entry){return entry.item.operation!=="override"&&entry.item.difficulty===stage.difficulty&&entry.item.actId===stage.actId}).sort(function(left,right){return left.item.stageIndex-right.item.stageIndex}).map(function(entry){return entry.index}); }
      function swapEpisodeStagePlacement(leftIndex,rightIndex) { syncEpisodeStage();var left=state.episodeStages[leftIndex],right=state.episodeStages[rightIndex];if(!left||!right||left.operation==="override"||right.operation==="override"||left.difficulty!==right.difficulty||left.actId!==right.actId)return;var stageIndex=left.stageIndex,stageUi=left.stageUiNumber;left.stageIndex=right.stageIndex;left.stageUiNumber=right.stageUiNumber;right.stageIndex=stageIndex;right.stageUiNumber=stageUi;applyEpisodeStage(left,leftIndex); }
      function finishStageNodeDrag(event,commit) { var drag=state.stageNodeDrag;if(!drag||drag.pointerId!==event.pointerId)return;if(els.episodeStageCanvas.hasPointerCapture(event.pointerId))els.episodeStageCanvas.releasePointerCapture(event.pointerId);state.stageNodeDrag=null;if(commit&&drag.moved&&drag.dropIndex!=null)swapEpisodeStagePlacement(drag.sourceIndex,drag.dropIndex);else if(commit&&!drag.moved)selectStageNode({source:"mod",stage:state.episodeStages[drag.sourceIndex],index:drag.sourceIndex});else renderStageLayout(); }

      function selectStageNode(node) { if(!node)return;if(node.source==="mod"){applyEpisodeStage(state.episodeStages[node.index],node.index);return}state.episodeSelectedNode={source:"base",stage:node.stage};state.episodeBaseDetail=null;state.episodeSelection={type:"stage"};state.episodeScenes=[];state.episodeSceneIndex=0;renderStageLayout();renderEpisodeInspectors();updateEpisodeControls();api("episode-maker/stage",{stageId:node.stage.stageId,episodeId:els.episodeSelect.value,category:els.episodeCategory.value,difficulty:node.stage.difficulty}).then(function(detail){if(!state.episodeSelectedNode||state.episodeSelectedNode.source!=="base"||state.episodeSelectedNode.stage.stageId!==node.stage.stageId||state.episodeSelectedNode.stage.difficulty!==node.stage.difficulty)return;state.episodeBaseDetail=detail;state.episodeScenes=detail.cutscenes.reduce(function(frames,cutscene){return frames.concat(cutscene.frames.map(function(frame){return Object.assign({cutsceneId:cutscene.id,cutsceneSlot:cutscene.slot},frame)}))},[]);state.episodeSceneIndex=0;renderEpisodeStageOptions();renderEpisodeScenes();renderEpisodeInspectors();renderEpisodePreview();updateEpisodeControls()}).catch(showError); }
      function navigateStage(direction) { var nodes=stageLayoutNodes(),current=nodes.findIndex(function(node){return state.episodeSelectedNode&&(node.source==="base"&&state.episodeSelectedNode.source==="base"&&node.stage.stageId===state.episodeSelectedNode.stage.stageId||node.source==="mod"&&state.episodeSelectedNode.source==="mod"&&node.index===state.episodeSelectedNode.index)}),next=Math.max(0,Math.min(nodes.length-1,(current<0?0:current)+direction));selectStageNode(nodes[next]); }
      function updateEpisodeControls() { if(state.episodeMode==="cutscene")return;var nodes=stageLayoutNodes(),current=nodes.findIndex(function(node){return state.episodeSelectedNode&&(node.source==="base"&&state.episodeSelectedNode.source==="base"&&node.stage.stageId===state.episodeSelectedNode.stage.stageId||node.source==="mod"&&state.episodeSelectedNode.source==="mod"&&node.index===state.episodeSelectedNode.index)});els.episodeProgress.textContent=state.episodeMode==="episode"?state.episodeStages.length+" stages":(current+1)+" / "+nodes.length;els.episodePrevScene.disabled=state.episodeMode==="episode"||current<=0;els.episodeNextScene.disabled=state.episodeMode==="episode"||current<0||current>=nodes.length-1;els.episodePlay.disabled=state.episodeMode==="episode"||!state.episodeScenes.length;els.episodePlay.textContent="▶";els.episodePlay.title="Play cutscene";els.episodePlay.setAttribute("aria-label","Play cutscene"); }

      function deleteSelectedEpisodeStage() {
        if(!state.episodeStages.length)return;var current=state.episodeStages[state.episodeStageIndex];
        if(current.operation==="override"){
          if(!window.confirm('Remove the override for "'+(current.title||"this stage")+'" and restore the protected base stage?'))return;var stageId=current.stageId,difficulty=current.difficulty;state.episodeStages.splice(state.episodeStageIndex,1);renderEpisodeStageOptions();var base=state.episodeBaseStages.find(function(stage){return stage.stageId===stageId&&stage.difficulty===difficulty});if(base){selectStageNode({source:"base",stage:base});return}if(state.episodeStages.length){var remaining=Math.min(state.episodeStageIndex,state.episodeStages.length-1);applyEpisodeStage(state.episodeStages[remaining],remaining)}else{clearEpisodeStages();setEpisodeMode("stage")}return;
        }
        if(!window.confirm('Delete "'+(current.title||"this stage")+'" from this episode project?'))return;var removed=state.episodeStages.splice(state.episodeStageIndex,1)[0];state.episodeStages.forEach(function(stage){if(stage.operation!=="override"&&stage.difficulty===removed.difficulty&&stage.actId===removed.actId&&stage.stageIndex>removed.stageIndex)stage.stageIndex-=1;if(stage.operation!=="override"&&stage.difficulty===removed.difficulty&&stage.actId===removed.actId&&stage.stageUiNumber>removed.stageUiNumber)stage.stageUiNumber-=1});if(!state.episodeStages.length){clearEpisodeStages();if(state.episodeBaseStages.length)selectStageNode({source:"base",stage:state.episodeBaseStages[0]});else setEpisodeMode("episode");return}var next=Math.min(state.episodeStageIndex,state.episodeStages.length-1);applyEpisodeStage(state.episodeStages[next],next);
      }
      function moveEpisodeStage(direction) { var index=state.episodeStageIndex,stage=state.episodeStages[index],movable=movableEpisodeStageIndexes(stage),position=movable.indexOf(index),next=position+direction;if(position<0||next<0||next>=movable.length)return;swapEpisodeStagePlacement(index,movable[next]); }

      function renderEpisodePreview() {
        if(!state.episodeScenes.length){els.cutsceneSpeaker.textContent="";els.cutsceneText.textContent="Add a scene";return}
        var scene=state.episodeScenes[Math.max(0,Math.min(state.episodeSceneIndex,state.episodeScenes.length-1))];
        scene.actors=scene.actors||[];scene.effects=scene.effects||[];els.cutsceneSpeaker.textContent=scene.speakerName;els.cutsceneText.textContent=scene.dialogue;els.episodeProgress.textContent=(state.episodeSceneIndex+1)+" / "+state.episodeScenes.length;els.episodePrevScene.disabled=state.episodeSceneIndex<=0;els.episodeNextScene.disabled=state.episodeSceneIndex>=state.episodeScenes.length-1;els.episodePlay.textContent=state.episodePlaying?"Ⅱ":"▶";els.episodePlay.title=state.episodePlaying?"Pause":"Play";els.episodePlay.setAttribute("aria-label",els.episodePlay.title);
        clear(els.cutsceneEffects);scene.effects.forEach(function(effect){var chip=document.createElement("span");chip.className="cutscene-effect";chip.textContent=effect;els.cutsceneEffects.appendChild(chip)});
        var avatar=episodeAssetRoute("actor",scene.speakerActorId,"");if(avatar){els.cutsceneAvatar.hidden=false;els.cutsceneAvatar.src=BASE_PATH+"/api/"+avatar}else els.cutsceneAvatar.hidden=true;
        var renderer=initCutsceneGl();if(!renderer){els.episodePreviewMeta.textContent="WebGL unavailable";return}var background=scene.background||els.episodeBackground.value;els.episodePreviewMeta.textContent=background+" · "+scene.actors.length+" actor"+(scene.actors.length===1?"":"s");renderer.render(scene);renderCutsceneSelection(scene);
      }

      function renderCutsceneSelection(scene) { var selection=state.episodeSelection,actor=selection&&selection.type==="actor"&&scene.actors[selection.actorIndex];if(!actor){els.cutsceneSelection.hidden=true;return}var center=actor.position==="L"?270:actor.position==="R"?1010:640;els.cutsceneSelection.hidden=false;els.cutsceneSelection.style.left=((center-180)/12.8)+"%";els.cutsceneSelection.style.top=(245/7.2)+"%";els.cutsceneSelection.style.width=(360/12.8)+"%";els.cutsceneSelection.style.height=(360/7.2)+"%"; }

      function initCutsceneGl() {
        if(state.cutsceneGl)return state.cutsceneGl;var gl=els.cutsceneCanvas.getContext("webgl",{alpha:true,premultipliedAlpha:false});if(!gl)return null;
        function shader(type,source){var value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value));return value}
        var program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,"attribute vec2 p;attribute vec2 t;varying vec2 v;void main(){gl_Position=vec4(p,0.0,1.0);v=t;}"));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,"precision mediump float;uniform sampler2D image;uniform float dim;varying vec2 v;void main(){vec4 c=texture2D(image,v);float g=dot(c.rgb,vec3(.299,.587,.114));c.rgb=mix(c.rgb,vec3(g)*.55,dim);gl_FragColor=c;}"));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
        var buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);var p=gl.getAttribLocation(program,"p"),t=gl.getAttribLocation(program,"t"),dim=gl.getUniformLocation(program,"dim");gl.enableVertexAttribArray(p);gl.enableVertexAttribArray(t);gl.vertexAttribPointer(p,2,gl.FLOAT,false,16,0);gl.vertexAttribPointer(t,2,gl.FLOAT,false,16,8);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        var images={};function load(route){if(!route)return null;if(images[route])return images[route];var img=new Image();images[route]=img;img.onload=function(){renderEpisodePreview()};img.src=route.indexOf("http")===0||route.indexOf("/")===0?route:BASE_PATH+"/api/"+route;return img}
        function draw(img,x,y,w,h,fade){if(!img||!img.complete||!img.naturalWidth)return;if(!img.texture){img.texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,img.texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img)}else gl.bindTexture(gl.TEXTURE_2D,img.texture);var left=x/640-1,right=(x+w)/640-1,top=1-y/360,bottom=1-(y+h)/360;gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([left,bottom,0,0,right,bottom,1,0,left,top,0,1,left,top,0,1,right,bottom,1,0,right,top,1,1]),gl.STREAM_DRAW);gl.uniform1f(dim,fade?1:0);gl.drawArrays(gl.TRIANGLES,0,6)}
        state.cutsceneGl={render:function(scene){gl.viewport(0,0,1280,720);gl.clearColor(.02,.03,.05,1);gl.clear(gl.COLOR_BUFFER_BIT);var background=episodeAssetRoute("background",scene.background||els.episodeBackground.value,"")||(state.episodeCatalog.previewAssets||{}).background;draw(load(background),0,0,1280,720,false);scene.actors.filter(function(actor){return actor.visible!==false}).forEach(function(actor){var center=actor.position==="L"?270:actor.position==="R"?1010:640;draw(load(episodeAssetRoute("actor",actor.actorId,actor.previewAsset)),center-180,245,360,360,scene.dimActors)})}};return state.cutsceneGl;
      }

      function toggleEpisodePlayback() { if(state.episodePlaying){clearInterval(state.episodeTimer);state.episodePlaying=false;els.episodePlay.textContent="▶";els.episodePlay.title="Play";els.episodePlay.setAttribute("aria-label","Play");return}if(state.episodeMode==="stage")setEpisodeMode("cutscene");state.episodePlaying=true;els.episodePlay.textContent="Ⅱ";els.episodePlay.title="Pause";els.episodePlay.setAttribute("aria-label","Pause");state.episodeTimer=setInterval(function(){if(state.episodeSceneIndex>=state.episodeScenes.length-1){toggleEpisodePlayback();return}setEpisodeScene(state.episodeSceneIndex+1)},2600); }

      function loadProjects() {
        return api("mods").then(function (data) {
          state.projects=data.projects; renderProjectList();
          if (state.selectedProject) return selectProject(state.selectedProject.manifest.id);
        });
      }

      function loadUnitCatalog() {
        return api("unit-maker/units",{query:els.unitSearch.value.trim()}).then(function(data){
          state.unitCatalogLoaded=true; clear(els.unitList);
          data.units.forEach(function(unit){
            var button=itemButton(unit.strId,unit.id+" | "+(unit.rarity||"unknown rarity")+" | "+(unit.role||"unknown role"),state.selectedUnit&&state.selectedUnit.base.m_UnitStrID===unit.strId);
            button.onclick=function(){selectUnit(unit.strId).catch(showError)}; els.unitList.appendChild(button);
          });
          if(!data.units.length)empty(els.unitList,"No matching normal units.");
          if(!els.unitId.value)els.unitId.value=data.nextUnitId;
        });
      }

      function selectUnit(strId) {
        els.unitOutput.textContent="Loading "+strId+"...";
        return api("unit-maker/unit",{id:strId}).then(function(unit){
          state.selectedUnit=unit; els.unitTitle.textContent=unit.base.m_UnitStrID; els.unitMeta.textContent=unit.base.m_UnitID+" | "+unit.skills.length+" skill rows | "+unit.skins.length+" skins | "+unit.voices.length+" voice assets";
          var slug=unit.suggestedUnitStrId.toLowerCase().replace(/^nkm_unit_/,"").replace(/_/g,"-");
          els.unitProjectId.value=slug; els.unitProjectName.value=unit.suggestedName; els.unitDisplayName.value=unit.suggestedName; els.unitId.value=unit.nextUnitId; els.unitStrId.value=unit.suggestedUnitStrId; els.unitRarity.value=unit.base.m_NKM_UNIT_GRADE||"";
          els.unitTags.value=Array.isArray(unit.base.m_lstUnitTag)?unit.base.m_lstUnitTag.join(", "):""; els.unitRuntimeTags.value=Array.isArray(unit.base.m_hsUnitTag)?unit.base.m_hsUnitTag.join(", "):"";
          els.unitAssets.value=JSON.stringify(unit.assets,null,2); els.unitBase.value="{}"; els.unitStats.value="{}"; els.unitSkills.value=JSON.stringify([unit.base.m_SkillStrID1,unit.base.m_SkillStrID2,unit.base.m_SkillStrID3,unit.base.m_SkillStrID4],null,2); els.unitSkillOverrides.value="{}"; els.unitSkinOverrides.value="{}"; els.unitVoices.value="{}";
          els.createUnit.disabled=false; els.unitOutput.textContent=JSON.stringify({assets:unit.assets,voices:unit.voices,skins:unit.skins},null,2); return loadUnitCatalog();
        });
      }

      function createUnitMod() {
        if(!state.selectedUnit)throw new Error("Select a source unit first.");
        var body={projectId:els.unitProjectId.value.trim(),projectName:els.unitProjectName.value.trim(),sourceUnitStrId:state.selectedUnit.base.m_UnitStrID,displayName:els.unitDisplayName.value.trim(),unitId:Number(els.unitId.value),unitStrId:els.unitStrId.value.trim(),rarity:els.unitRarity.value.trim(),unitTags:commaList(els.unitTags.value),runtimeTags:commaList(els.unitRuntimeTags.value),cloneSkills:els.unitCloneSkills.checked,cloneSkins:els.unitCloneSkins.checked,assets:jsonField(els.unitAssets,"Presentation assets"),base:jsonField(els.unitBase,"Base overrides"),stat:jsonField(els.unitStats,"Stat overrides"),skills:jsonField(els.unitSkills,"Skill IDs"),skillOverrides:jsonField(els.unitSkillOverrides,"Skill overrides"),skinOverrides:jsonField(els.unitSkinOverrides,"Skin overrides"),voiceMap:jsonField(els.unitVoices,"Voice replacements")};
        els.createUnit.disabled=true; els.unitOutput.textContent="Creating and validating unit mod...";
        return writeApi("unit-maker/create","POST",body).then(function(result){els.unitOutput.textContent=JSON.stringify({unit:result.unit,project:result.project.manifest,clonedSkills:result.clonedSkills,clonedSkins:result.clonedSkins,warnings:result.warnings},null,2);return selectedSpineSets().length?attachSelectedUnitSpine():loadProjects()}).finally(function(){els.createUnit.disabled=false});
      }

      function selectedSpineSets(){
        return [{role:"illustration",input:els.unitSpineIllust},{role:"sd",input:els.unitSpineSd},{role:"battle",input:els.unitSpineBattle}].map(function(group){return {role:group.role,files:Array.prototype.slice.call(group.input.files||[])}}).filter(function(group){return group.files.length});
      }

      function attachSelectedUnitSpine(){
        if(!state.selectedUnit)throw new Error("Select the source unit used to create this mod.");var projectId=els.unitProjectId.value.trim(),unitStrId=els.unitStrId.value.trim(),groups=selectedSpineSets();if(!projectId||!unitStrId)throw new Error("Enter the project and unit string IDs.");if(!groups.length)throw new Error("Choose at least one complete Spine set.");
        groups.forEach(function(group){var extensions=group.files.map(function(file){return file.name.slice(file.name.lastIndexOf(".")).toLowerCase()}),skel=extensions.filter(function(value){return value===".skel"}).length,atlas=extensions.filter(function(value){return value===".atlas"}).length,png=extensions.filter(function(value){return value===".png"}).length;if(skel!==1||atlas!==1||png<1||skel+atlas+png!==extensions.length)throw new Error(group.role+" needs one .skel, one .atlas, and every atlas PNG page.")});
        els.attachUnitSpine.disabled=true;var built=[];return groups.reduce(function(promise,group){return promise.then(function(){els.unitOutput.textContent="Uploading "+group.role+" Spine files...";return Promise.all(group.files.map(function(file){var target="unit-spine/"+unitStrId+"/"+group.role+"/"+file.name;return writeRaw("mods/"+encodeURIComponent(projectId)+"/asset-source?path="+encodeURIComponent(target),file).then(function(result){return result.file})})).then(function(sources){els.unitOutput.textContent="Building "+group.role+" CounterSide Spine bundle...";return writeApi("unit-maker/spine","POST",{projectId:projectId,sourceUnitStrId:state.selectedUnit.base.m_UnitStrID,unitStrId:unitStrId,role:group.role,sources:sources})}).then(function(result){built.push(result.bundle)})})},Promise.resolve()).then(function(){els.unitOutput.textContent=JSON.stringify({unit:unitStrId,spineBundles:built,message:"Spine assets attached. Export or enable the mod, then restart the client."},null,2);return loadProjects()}).finally(function(){els.attachUnitSpine.disabled=false});
      }

      function loadUnityStatus() {
        return api("unity-compiler").then(function(status){els.unityStatus.textContent=status.message;els.buildBundle.disabled=!status.available;return status});
      }

      function buildUnityBundle() {
        var projectId=els.unitProjectId.value.trim(), bundleName=els.bundleName.value.trim(), files=Array.prototype.slice.call(els.bundleAssets.files||[]);
        if(!projectId)throw new Error("Enter an existing project ID."); if(!bundleName)throw new Error("Enter a bundle name."); if(!files.length)throw new Error("Choose at least one source asset.");
        els.buildBundle.disabled=true; els.unitOutput.textContent="Uploading "+files.length+" source assets...";
        return Promise.all(files.map(function(file){var name=(file.webkitRelativePath||file.name).replace(/\\/g,"/");return writeRaw("mods/"+encodeURIComponent(projectId)+"/asset-source?path="+encodeURIComponent(name),file).then(function(){return name})})).then(function(names){
          els.unitOutput.textContent="Building "+bundleName+" for Windows and Android..."; var spec={bundleName:bundleName,assets:names}; return writeApi("mods/"+encodeURIComponent(projectId)+"/unity-build","POST",Object.assign({target:"windows"},spec)).then(function(){return writeApi("mods/"+encodeURIComponent(projectId)+"/unity-build","POST",Object.assign({target:"android"},spec))});
        }).then(function(result){els.unitOutput.textContent=JSON.stringify(result,null,2)}).finally(function(){loadUnityStatus().catch(showError)});
      }

      function loadRuntime() {
        return api("mod-runtime").then(function (runtime) {
          state.runtime=runtime; state.loaderEnabled=runtime.profile.enabled.slice(); renderRuntime(); return runtime;
        });
      }

      function renderRuntime() {
        var runtime=state.runtime; if(!runtime)return;
        clear(els.loaderProjectList);
        var byIdMap={}; runtime.projects.forEach(function(project){byIdMap[project.id]=project});
        var ordered=state.loaderEnabled.map(function(id){return byIdMap[id]}).filter(Boolean).concat(runtime.projects.filter(function(project){return state.loaderEnabled.indexOf(project.id)<0}));
        ordered.forEach(function(project){
          var enabledIndex=state.loaderEnabled.indexOf(project.id); var row=document.createElement("div"); row.className="loader-row";
          var checkbox=document.createElement("input"); checkbox.type="checkbox"; checkbox.checked=enabledIndex>=0; checkbox.setAttribute("aria-label","Enable "+project.name);
          checkbox.onchange=function(){setModEnabled(project.id,checkbox.checked).catch(showError)};
          var label=document.createElement("div"); var title=document.createElement("strong"); title.textContent=(enabledIndex>=0?(enabledIndex+1)+". ":"")+project.name; var meta=document.createElement("span"); meta.className="item-meta"; meta.textContent=project.id+" | "+project.version+" | "+project.patchCount+" patches"; label.append(title,meta);
          var up=document.createElement("button"); up.type="button"; up.className="secondary"; up.textContent="Up"; up.title="Move earlier"; up.disabled=enabledIndex<=0; up.onclick=function(){moveLoaderProject(project.id,-1)};
          var down=document.createElement("button"); down.type="button"; down.className="secondary"; down.textContent="Down"; down.title="Move later"; down.disabled=enabledIndex<0||enabledIndex>=state.loaderEnabled.length-1; down.onclick=function(){moveLoaderProject(project.id,1)};
          var remove=document.createElement("button"); remove.type="button"; remove.className="danger"; remove.textContent="Delete"; remove.setAttribute("aria-label","Delete "+project.name); remove.onclick=function(){deleteModProject(project,remove)};
          row.append(checkbox,label,up,down,remove); els.loaderProjectList.appendChild(row);
        });
        if(!runtime.projects.length)empty(els.loaderProjectList,"Create or import a mod project first.");
        var current=runtime.current; els.rollbackRuntime.disabled=!runtime.previous;
        els.runtimeTitle.textContent=current?current.enabled.length+" mods active":"No runtime built";
        els.runtimeHash.textContent=current?current.hash:"No mod-set hash";
        els.runtimeMeta.textContent=current?current.tableCount+" tables | "+current.patchCount+" patches | "+(current.warnings||[]).length+" reference warnings | restart listener and client after changes":"Choose mods and build.";
        renderRuntimeDetails(current);
      }

      function moveLoaderProject(id,direction) {
        var index=state.loaderEnabled.indexOf(id), next=index+direction; if(index<0||next<0||next>=state.loaderEnabled.length)return;
        var swap=state.loaderEnabled[next]; state.loaderEnabled[next]=id; state.loaderEnabled[index]=swap; renderRuntime();
      }

      function applyLoaderProfile(enabled) {
        var previous=state.loaderEnabled.slice(); state.loaderEnabled=enabled.slice(); renderRuntime();
        return writeApi("mod-runtime/apply","PUT",{enabled:state.loaderEnabled}).then(function(runtime){state.runtime=runtime;state.loaderEnabled=runtime.profile.enabled.slice();renderRuntime();return runtime}).catch(function(err){state.loaderEnabled=previous;renderRuntime();throw err});
      }

      function setModEnabled(id,enabled) {
        var next=state.loaderEnabled.filter(function(value){return value!==id}); if(enabled)next.push(id);
        return applyLoaderProfile(next).then(function(runtime){var project=runtime.projects.find(function(value){return value.id===id});els.status.style.color="";els.status.textContent=(project?project.name:id)+(enabled?" activated":" deactivated")+"; restart the client to reload";return runtime});
      }

      function deleteModProject(project,button) {
        if(!window.confirm('Delete "'+project.name+'" permanently?\n\nIts project files will be removed. This cannot be undone.'))return;
        button.disabled=true;
        writeApi("mods/"+encodeURIComponent(project.id),"DELETE").then(function(runtime){
          state.runtime=runtime;state.loaderEnabled=runtime.profile.enabled.slice();
          if(state.selectedProject&&state.selectedProject.manifest.id===project.id){state.selectedProject=null;state.selectedPatch=null;state.editorValue=null;els.manifestForm.hidden=true;els.projectTitle.textContent="Select a mod project";els.projectMeta.textContent="Manifest and patched records";els.projectStatus.textContent="Select a project to begin.";empty(els.patchList,"Select a project.");clearEditor()}
          renderRuntime();return loadProjects();
        }).then(function(){els.status.style.color="";els.status.textContent=project.name+" deleted; restart the client to reload"}).catch(function(err){button.disabled=false;showError(err)});
      }

      function renderRuntimeDetails(manifest) {
        clear(els.runtimeDetails); if(!manifest){empty(els.runtimeDetails,"Build a profile to inspect effective changes and conflicts.");return}
        var conflicts=manifest.conflicts||[],warnings=manifest.warnings||[],changes=manifest.changes||[];
        var heading=document.createElement("strong"); heading.textContent=conflicts.length?conflicts.length+" resolved conflicts (later mod won)":"No load-order conflicts"; els.runtimeDetails.appendChild(heading);
        conflicts.forEach(function(conflict){var item=document.createElement("article");item.className="diff-entry";var code=document.createElement("code");code.textContent=conflict.table+" | "+conflict.key.field+"="+JSON.stringify(conflict.key.value)+"\n"+conflict.previousModId+" -> "+conflict.winningModId;item.appendChild(code);els.runtimeDetails.appendChild(item)});
        if(warnings.length){var warningHeading=document.createElement("strong");warningHeading.textContent="Reference warnings ("+warnings.length+")";els.runtimeDetails.appendChild(warningHeading);warnings.forEach(function(warning){var item=document.createElement("article");item.className="validation-entry warning";var code=document.createElement("code");code.textContent=warning.table+" | "+warning.path+"="+JSON.stringify(warning.value)+" | "+warning.modId;var message=document.createElement("span");message.textContent=warning.message;item.append(code,message);els.runtimeDetails.appendChild(item)})}
        var changeHeading=document.createElement("strong");changeHeading.textContent="Effective changes ("+changes.length+")";els.runtimeDetails.appendChild(changeHeading);
        changes.forEach(function(change){var item=document.createElement("article");item.className="diff-entry";var code=document.createElement("code");var target=change.table||change.string||change.assetBundle||"runtime";var key=change.key?" | "+change.key.field+"="+JSON.stringify(change.key.value):"";code.textContent=change.action.toUpperCase()+" | "+target+key+" | "+change.modId;item.appendChild(code);els.runtimeDetails.appendChild(item)});
      }

      function importModFile(file) {
        return loadingFetch(BASE_PATH+"/api/mods/import",{method:"POST",body:file,cache:"no-store"},function(response){return response.json().then(function(body){if(!response.ok)throw new Error(body.error||response.statusText);return body})});
      }

      function renderProjectList() {
        clear(els.modList);
        state.projects.forEach(function (project) {
          var active=Boolean(state.selectedProject&&state.selectedProject.manifest.id===project.id);
          var button=itemButton(project.name,project.id+" · "+project.version+" · "+project.patchCount+" patches",active);
          button.onclick=function () { selectProject(project.id).catch(showError); }; els.modList.appendChild(button);
        });
        if (!state.projects.length) empty(els.modList,"Create or import your first mod project.");
      }

      function selectProject(id) {
        return api("mods/"+encodeURIComponent(id)).then(function (project) {
          state.selectedProject=project; state.selectedPatch=null; state.editorValue=null; renderProjectList(); renderProject(project); clearEditor(); return project;
        });
      }

      function renderProject(project) {
        var manifest=project.manifest; els.projectTitle.textContent=manifest.name; els.projectMeta.textContent=manifest.id+" · "+manifest.version; els.manifestForm.hidden=false;
        els.manifestName.value=manifest.name; els.manifestVersion.value=manifest.version; els.manifestAuthor.value=manifest.author||""; els.manifestDescription.value=manifest.description||"";
        renderProjectStatus(project.validation); clear(els.patchList);
        project.patches.forEach(function (patch) {
          var active=state.selectedPatch&&state.selectedPatch.patch.patchId===patch.patchId;
          var button=itemButton((patch.removed?"Remove ":"")+patch.label,patch.table.tableName+" · "+patch.key.field,active);
          button.onclick=function () { openPatch(patch.patchId).catch(showError); }; els.patchList.appendChild(button);
        });
        if (!project.patches.length) empty(els.patchList,"Open Gameplay tables, select a record, then copy or duplicate it into this mod.");
        if(state.selectedRecord){els.copyRecord.disabled=false;els.duplicateRecord.disabled=false}
      }

      function renderProjectStatus(report) {
        els.projectStatus.className="project-status "+(report&&report.ok?"ok":"bad");
        els.projectStatus.textContent=report?(report.ok?"Valid · ":report.errors.length+" errors · ")+report.patchCount+" patches" : "Not validated";
      }

      function openPatch(patchId) {
        if (!state.selectedProject) return Promise.resolve();
        return api("mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/patch",{patchId:patchId}).then(function (detail) {
          state.selectedPatch=detail; state.editorValue=cloneValue(detail.patch.value); state.editorMode="form"; renderProject(state.selectedProject); renderEditor();
        });
      }

      function clearEditor() {
        state.selectedPatch=null; state.editorValue=null; els.editorTitle.textContent="Record editor"; els.editorMeta.textContent="Copy or duplicate any base record"; empty(els.creatorEditor,"Select a mod record, or copy one from Gameplay tables.");
        [els.savePatch,els.duplicatePatch,els.deleteRecord,els.removePatch].forEach(function (button) { button.disabled=true; });
      }

      function renderEditor() {
        var detail=state.selectedPatch;
        if (!detail) { clearEditor(); return; }
        els.editorTitle.textContent=String(detail.patch.key.value); els.editorMeta.textContent=detail.patch.table.tableName+" · "+detail.patch.key.field;
        els.savePatch.disabled=false; els.duplicatePatch.disabled=detail.baseIndex<0; els.deleteRecord.disabled=false; els.removePatch.disabled=false;
        [[els.formEditorTab,"form"],[els.rawEditorTab,"raw"],[els.diffEditorTab,"diff"],[els.validationEditorTab,"validation"]].forEach(function (pair) { pair[0].classList.toggle("active",state.editorMode===pair[1]); });
        if (state.editorMode==="form") renderGeneratedForm();
        else if (state.editorMode==="raw") renderRawEditor();
        else if (state.editorMode==="diff") renderDiff();
        else renderPatchValidation();
      }

      function renderGeneratedForm() {
        clear(els.creatorEditor);
        if (state.editorValue===null) { empty(els.creatorEditor,"This patch removes the record. Use Raw JSON or Save patch to restore it."); return; }
        var root=document.createElement("div"); root.className="editor-fields";
        walkPrimitiveFields(state.editorValue,[],function (path,value) {
          var row=document.createElement("div"); row.className="field-row"; var label=document.createElement("label"); var fieldPath=formatFieldPath(path); label.textContent=fieldPath;
          var input=document.createElement("input"); input.id="mod-field-"+root.children.length; input.dataset.fieldPath=fieldPath; label.htmlFor=input.id;
          if(typeof value==="boolean") { input.type="checkbox"; input.checked=value; input.onchange=function () { setFieldValue(state.editorValue,path,input.checked); }; }
          else { input.type=typeof value==="number"?"number":"text"; if(typeof value==="number") input.step="any"; input.value=value==null?"":String(value); input.oninput=function () { setFieldValue(state.editorValue,path,typeof value==="number"?Number(input.value):input.value); }; }
          var pick=document.createElement("button"); pick.type="button"; pick.className="secondary"; pick.textContent="Pick"; pick.hidden=!/id|key|item|unit|stage|dungeon|reward/i.test(fieldPath); pick.onclick=function () { openReferencePicker(path,value); };
          row.append(label,input,pick); root.appendChild(row);
        });
        els.creatorEditor.appendChild(root);
      }

      function walkPrimitiveFields(value,path,visit) {
        if(value===null||typeof value!=="object") { visit(path,value); return; }
        if(Array.isArray(value)) { value.forEach(function (item,index) { walkPrimitiveFields(item,path.concat(index),visit); }); return; }
        Object.keys(value).forEach(function (key) { walkPrimitiveFields(value[key],path.concat(key),visit); });
      }

      function formatFieldPath(path) { return path.map(function (part,index) { return typeof part==="number"?"["+part+"]":(index?".":"")+part; }).join(""); }
      function setFieldValue(root,path,value) { var target=root; for(var index=0;index<path.length-1;index+=1) target=target[path[index]]; target[path[path.length-1]]=value; }
      function getFieldValue(root,path) { return path.reduce(function (value,key) { return value==null?undefined:value[key]; },root); }

      function renderRawEditor() {
        clear(els.creatorEditor); var textarea=document.createElement("textarea"); textarea.id="rawPatchEditor"; textarea.className="raw-editor"; textarea.setAttribute("aria-label","Raw record JSON"); textarea.value=JSON.stringify(state.editorValue,null,2); els.creatorEditor.appendChild(textarea);
      }

      function parseRawEditor() {
        var textarea=byId("rawPatchEditor");
        if(!textarea) return state.editorValue;
        try { return JSON.parse(textarea.value); } catch(err) { throw new Error("Invalid record JSON: "+err.message); }
      }

      function renderDiff() {
        clear(els.creatorEditor); var root=document.createElement("div"); root.className="diff-list";
        var changes=clientDiff(state.selectedPatch.base,state.editorValue);
        changes.forEach(function (change) { var entry=document.createElement("div"); entry.className="diff-entry"; var path=document.createElement("code"); path.textContent=change.path; var before=document.createElement("pre"); before.textContent="Before: "+JSON.stringify(change.before,null,2)+"\nAfter:  "+JSON.stringify(change.after,null,2); entry.append(path,before); root.appendChild(entry); });
        if(!changes.length) empty(els.creatorEditor,"No differences from the base record."); else els.creatorEditor.appendChild(root);
      }

      function clientDiff(before,after,prefix,changes) {
        prefix=prefix||""; changes=changes||[]; if(changes.length>=500||JSON.stringify(before)===JSON.stringify(after))return changes;
        if(before&&after&&typeof before==="object"&&typeof after==="object"&&!Array.isArray(before)&&!Array.isArray(after)){var keys=new Set(Object.keys(before).concat(Object.keys(after)));keys.forEach(function(key){clientDiff(before[key],after[key],prefix?prefix+"."+key:key,changes)})}
        else changes.push({path:prefix||"$",before:before,after:after}); return changes;
      }

      function renderPatchValidation() {
        clear(els.creatorEditor); var root=document.createElement("div"); root.className="validation-list"; var report=state.selectedPatch.validation||{errors:[],warnings:[]};
        report.errors.forEach(function (issue) { root.appendChild(validationButton(issue,"error")); }); report.warnings.forEach(function (issue) { root.appendChild(validationButton(issue,"warning")); });
        if(!root.children.length) empty(els.creatorEditor,"No validation errors."); else els.creatorEditor.appendChild(root);
      }

      function validationButton(issue,severity) {
        var button=document.createElement("button"); button.type="button"; button.className="validation-entry "+severity; var path=document.createElement("code"); path.textContent=(severity==="error"?"Error · ":"Warning · ")+(issue.path||"record"); var message=document.createElement("span"); message.textContent=issue.message; button.append(path,message);
        button.onclick=function () { state.editorMode="form"; renderEditor(); Array.prototype.some.call(els.creatorEditor.querySelectorAll("input[data-field-path]"),function (input) { if(input.dataset.fieldPath===issue.path){input.focus();input.closest(".field-row").classList.add("invalid");return true} return false; }); };
        return button;
      }

      function setEditorMode(mode) {
        if(state.editorMode==="raw") { try { state.editorValue=parseRawEditor(); } catch(err) { showError(err); return; } }
        state.editorMode=mode; renderEditor();
      }

      function saveCurrentPatch(valueOverride) {
        if(!state.selectedProject||!state.selectedPatch) return Promise.resolve();
        var value=valueOverride===undefined?(state.editorMode==="raw"?parseRawEditor():state.editorValue):valueOverride; var patch=state.selectedPatch.patch;
        return writeApi("mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/patch","PUT",{table:patch.table,key:patch.key,source:patch.source,previousPatchId:patch.patchId,value:value}).then(function (detail) {
          state.selectedPatch=detail; state.editorValue=cloneValue(detail.patch.value); return reloadSelectedProject().then(function () { renderEditor(); });
        });
      }

      function reloadSelectedProject() {
        if(!state.selectedProject) return Promise.resolve(); var patchId=state.selectedPatch&&state.selectedPatch.patch.patchId;
        return api("mods/"+encodeURIComponent(state.selectedProject.manifest.id)).then(function (project) { state.selectedProject=project; renderProjectList(); renderProject(project); if(patchId) return openPatch(patchId); });
      }

      function copySelectedRecord(duplicate) {
        if(!state.selectedProject) { showMode("creator"); throw new Error("Create or select a mod project first."); }
        if(!state.selectedTable||!state.selectedRecord||state.selectedRecordIndex<0) throw new Error("Select a gameplay record first.");
        return writeApi("mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/copy-record","POST",{directory:state.selectedTable.directory,fileName:state.selectedTable.fileName,recordIndex:state.selectedRecordIndex,duplicate:duplicate}).then(function (detail) {
          state.selectedPatch=detail; state.editorValue=cloneValue(detail.patch.value); state.editorMode="form"; return reloadSelectedProject().then(function () { showMode("creator"); return openPatch(detail.patch.patchId); });
        });
      }

      function duplicateCurrentPatch() {
        var detail=state.selectedPatch;
        if(!detail||detail.baseIndex<0) return Promise.resolve();
        return writeApi("mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/copy-record","POST",{directory:detail.patch.table.directory,fileName:detail.patch.table.fileName,recordIndex:detail.baseIndex,duplicate:true}).then(function (next) { state.selectedPatch=next; return reloadSelectedProject().then(function () { return openPatch(next.patch.patchId); }); });
      }

      function removeCurrentPatch() {
        if(!state.selectedProject||!state.selectedPatch) return Promise.resolve();
        var route="mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/patch?patchId="+encodeURIComponent(state.selectedPatch.patch.patchId);
        return writeApi(route,"DELETE").then(function (project) { state.selectedProject=project; clearEditor(); renderProjectList(); renderProject(project); });
      }

      function openReferencePicker(path,currentValue) {
        state.referencePath=path; els.referenceTitle.textContent="Reference for "+formatFieldPath(path); els.referencePicker.hidden=false; els.referenceSearch.value=String(currentValue==null?"":currentValue); empty(els.referenceResults,"Enter at least two characters to search."); els.referenceSearch.focus(); if(els.referenceSearch.value.length>=2) searchReferences();
      }

      function searchReferences() {
        var query=els.referenceSearch.value.trim(); if(query.length<2){empty(els.referenceResults,"Enter at least two characters to search.");return}
        empty(els.referenceResults,"Searching references..."); api("references",{query:query}).then(function (data) { clear(els.referenceResults); data.references.forEach(function (reference) { var button=itemButton(reference.name||reference.strId||String(reference.id),(reference.table||"Table")+" · "+(reference.type||"")+" · ID "+reference.id,false); button.onclick=function () { var current=getFieldValue(state.editorValue,state.referencePath); var value=typeof current==="string"&&reference.strId?reference.strId:reference.id; setFieldValue(state.editorValue,state.referencePath,value); els.referencePicker.hidden=true; renderEditor(); }; els.referenceResults.appendChild(button); }); if(!data.references.length) empty(els.referenceResults,"No matching references."); }).catch(showError);
      }

      function cloneValue(value) { return value===undefined?undefined:JSON.parse(JSON.stringify(value)); }

      function loadSystems() {
        return api("systems").then(function (data) {
          state.systems=data.systems; els.systemCount.textContent=data.systems.length+" systems · "+data.tableCount.toLocaleString()+" decoded tables"; renderSystems();
          return selectSystem(state.selectedSystem || data.systems.find(function (entry) { return entry.id==="units"; }) || data.systems[0]);
        });
      }

      function renderSystems() {
        clear(els.systemList);
        state.systems.forEach(function (entry) {
          var wrap=document.createElement("div"); wrap.className="system-card";
          var button=itemButton(entry.title,entry.description,Boolean(state.selectedSystem&&state.selectedSystem.id===entry.id));
          var count=document.createElement("span"); count.className="count"; count.textContent=entry.tableCount.toLocaleString(); button.firstChild.appendChild(count);
          button.onclick=function () { selectSystem(entry).catch(showError); }; wrap.appendChild(button); els.systemList.appendChild(wrap);
        });
      }

      function selectSystem(entry) {
        if (!entry) return Promise.resolve();
        state.selectedSystem=entry; state.systemOffset=0; renderSystems(); renderSystemSummary(entry); return loadSystemTables();
      }

      function renderSystemSummary(entry) {
        clear(els.systemSummary); var title=document.createElement("h2"); title.textContent=entry.title; var text=document.createElement("p"); text.textContent=entry.description+" "+entry.tableCount.toLocaleString()+" related tables."; els.systemSummary.append(title,text);
        clear(els.systemEdits); var label=document.createElement("div"); label.className="section-label"; label.textContent="Known edit targets"; els.systemEdits.appendChild(label);
        (entry.commonEdits||[]).forEach(function (target) {
          var button=document.createElement("button"); button.type="button"; button.className="edit-target"; var title=document.createElement("strong"); title.textContent=target.label; var code=document.createElement("code"); code.textContent=target.location; button.append(title,code); button.onclick=function () { els.fieldSearch.value=target.query; searchFields().catch(showError); }; els.systemEdits.appendChild(button);
        });
        if (!(entry.commonEdits||[]).length) { var note=document.createElement("span"); note.className="subtle"; note.textContent="Use the finder or open a table below."; els.systemEdits.appendChild(note); }
      }

      function loadSystemTables() {
        if (!state.selectedSystem) return Promise.resolve();
        empty(els.systemTableList,"Loading related tables...");
        return api("system-tables",{id:state.selectedSystem.id,offset:state.systemOffset,limit:PAGE_SIZE}).then(function (data) {
          state.systemTotal=data.total; els.systemTablesTitle.textContent="Related LUAC tables ("+data.total.toLocaleString()+")"; clear(els.systemTableList);
          data.tables.forEach(function (table) { var button=itemButton(table.tableName,table.directory+" · "+table.format,false); button.onclick=function () { openTable(table); }; els.systemTableList.appendChild(button); });
          if (!data.tables.length) empty(els.systemTableList,"No related tables were found in this extraction.");
          els.systemPage.textContent=pageText(state.systemOffset,state.systemTotal); els.systemPrev.disabled=state.systemOffset<=0; els.systemNext.disabled=state.systemOffset+PAGE_SIZE>=state.systemTotal;
        });
      }

      function searchFields() {
        var query=els.fieldSearch.value.trim(); state.fieldQuery=query;
        if (query.length<2) { empty(els.fieldResults,"Describe a value using at least two characters."); return Promise.resolve(); }
        empty(els.fieldResults,"Inspecting likely gameplay tables...");
        return api("fields",{query:query}).then(function (data) {
          if (state.fieldQuery!==query) return; clear(els.fieldResults);
          var label=document.createElement("div"); label.className="section-label"; label.textContent=data.fields.length?"Exact field matches":"Likely tables"; els.fieldResults.appendChild(label);
          data.fields.forEach(function (field) {
            var button=document.createElement("button"); button.type="button"; button.className="field-result"; var title=document.createElement("strong"); title.textContent=field.path; var meta=document.createElement("span"); meta.textContent=field.system+" · "+field.table.tableName+" · "+field.type; var code=document.createElement("code"); code.textContent="Example: "+JSON.stringify(field.example); button.append(title,meta,code); button.onclick=function () { openTable(field.table); }; els.fieldResults.appendChild(button);
          });
          if (!data.fields.length) data.tables.forEach(function (table) { var button=document.createElement("button"); button.type="button"; button.className="field-result"; var title=document.createElement("strong"); title.textContent=table.tableName; var meta=document.createElement("span"); meta.textContent=table.system+" · "+table.relativePath; button.append(title,meta); button.onclick=function () { openTable(table); }; els.fieldResults.appendChild(button); });
          if (!data.fields.length&&!data.tables.length) empty(els.fieldResults,"No field match yet. Try a system noun plus a value, or use the full table browser.");
        });
      }

      function openTable(table) {
        state.selectedTable=table; state.recordOffset=0; state.recordQuery=""; els.recordSearch.value=""; showMode("tables"); loadTables().catch(showError); loadRecords().catch(showError);
      }

      function loadTables() {
        els.tableList.setAttribute("aria-busy","true");
        return api("tables", { query:state.tableQuery, offset:state.tableOffset, limit:PAGE_SIZE }).then(function (data) {
          state.tableTotal=data.total; clear(els.tableList);
          data.tables.forEach(function (table) {
            var active=state.selectedTable && state.selectedTable.directory===table.directory && state.selectedTable.fileName===table.fileName;
            var button=itemButton(table.tableName,table.directory+" · "+table.format,active);
            button.onclick=function () { state.selectedTable=table; state.recordOffset=0; state.recordQuery=""; els.recordSearch.value=""; loadTables(); loadRecords(); };
            els.tableList.appendChild(button);
          });
          if (!data.tables.length) empty(els.tableList,"No matching tables.");
          setPager("table",state.tableOffset,state.tableTotal);
        }).finally(function () { els.tableList.removeAttribute("aria-busy"); });
      }

      function loadRecords() {
        if (!state.selectedTable) return;
        els.recordTitle.textContent=state.selectedTable.tableName;
        els.recordSource.textContent=state.selectedTable.relativePath;
        els.recordSearch.disabled=false;
        empty(els.recordList,"Loading records…");
        return api("table", { directory:state.selectedTable.directory, file:state.selectedTable.fileName, query:state.recordQuery, offset:state.recordOffset, limit:PAGE_SIZE }).then(function (data) {
          state.recordTotal=data.total; state.selectedRecord=null; state.selectedRecordIndex=-1; els.recordActions.hidden=true; clear(els.recordList); els.recordJson.textContent="Select a record."; els.detailTitle.textContent="Record JSON";
          data.records.forEach(function (record,index) {
            var label=recordLabel(record,state.recordOffset+index);
            var button=itemButton(label,shortRecord(record),false);
            button.onclick=function () { Array.prototype.forEach.call(els.recordList.children,function (child) { child.classList.remove("active"); }); button.classList.add("active"); state.selectedRecord=record; state.selectedRecordIndex=data.recordIndexes[index]; els.detailTitle.textContent=label; els.recordJson.textContent=JSON.stringify(record,null,2); els.recordActions.hidden=false; els.copyRecord.disabled=!state.selectedProject; els.duplicateRecord.disabled=!state.selectedProject; };
            els.recordList.appendChild(button);
          });
          if (!data.records.length) empty(els.recordList,"No matching records.");
          setPager("record",state.recordOffset,state.recordTotal);
        });
      }

      function recordLabel(record,index) {
        if (!record || typeof record!=="object") return "Record "+(index+1);
        var keys=Object.keys(record);
        var preferred=keys.find(function (key) { return /strid$|_key$|^id$|name$/i.test(key) && record[key]!==""; }) || keys.find(function (key) { return /id|key|name/i.test(key) && record[key]!==""; });
        return preferred ? String(record[preferred]) : "Record "+(index+1);
      }
      function shortRecord(record) { return JSON.stringify(record); }

      function loadAssets() {
        empty(els.assetList,"Loading folder…");
        return api("assets", { path:state.assetPath, query:state.assetQuery, offset:state.assetOffset, limit:PAGE_SIZE }).then(function (data) {
          state.assetTotal=data.total; state.assetPath=data.path; renderBreadcrumbs(); clear(els.assetList);
          data.entries.forEach(function (entry) {
            var meta=entry.kind==="directory"?"Folder":formatBytes(entry.size)+" · "+(entry.assetType||entry.extension||"file");
            var button=itemButton((entry.kind==="directory"?"▸ ":"")+entry.name,meta,entry.path===state.selectedAssetPath);
            button.onclick=function () {
              if (entry.kind==="directory") { clearAssetSelection(); state.assetPath=entry.path; state.assetOffset=0; state.assetQuery=""; els.assetSearch.value=""; loadAssets(); }
              else { Array.prototype.forEach.call(els.assetList.children,function (child) { child.classList.remove("active"); }); button.classList.add("active"); previewAsset(entry); }
            };
            els.assetList.appendChild(button);
          });
          if (!data.entries.length) empty(els.assetList,"This folder is empty.");
          setPager("asset",state.assetOffset,state.assetTotal);
        });
      }

      function renderBreadcrumbs() {
        clear(els.breadcrumbs); var parts=state.assetPath?state.assetPath.split("/"):[];
        [{name:"Root",path:""}].concat(parts.map(function (name,index) { return {name:name,path:parts.slice(0,index+1).join("/")}; })).forEach(function (crumb,index,array) {
          var button=document.createElement("button"); button.type="button"; button.className="crumb"; button.textContent=crumb.name+(index<array.length-1?" /":""); button.onclick=function () { clearAssetSelection(); state.assetPath=crumb.path; state.assetOffset=0; state.assetQuery=""; els.assetSearch.value=""; loadAssets(); }; els.breadcrumbs.appendChild(button);
        });
      }

      function previewAsset(entry) {
        state.selectedAsset=entry; state.selectedAssetPath=entry.path; renderSelectedObject(entry); showAssetPreview(entry);
      }

      function showAssetPreview(entry) {
        state.assetView="preview";
        clear(els.preview); els.previewTitle.textContent=entry.name; els.previewMeta.textContent=entry.path+" · "+formatBytes(entry.size);
        var url=BASE_PATH+"/api/asset?path="+encodeURIComponent(entry.path); var ext=entry.extension;
        if ([".png",".jpg",".jpeg",".gif",".webp"].indexOf(ext)>=0) { var image=document.createElement("img"); image.src=url; image.alt=entry.name; els.preview.appendChild(image); return; }
        if ([".wav",".mp3",".ogg"].indexOf(ext)>=0) { var audio=document.createElement("audio"); audio.controls=true; audio.src=url; els.preview.appendChild(audio); return; }
        if ([".mp4",".webm"].indexOf(ext)>=0) { var video=document.createElement("video"); video.controls=true; video.src=url; els.preview.appendChild(video); return; }
        var spineCandidate=ext===".skel"||ext===".atlas"||((ext===".bytes"||ext===".json")&&String(entry.assetType||"").indexOf("TextAsset")===0);
        if (spineCandidate) { previewSpine(entry); return; }
        if ([".bytes",".csv",".json",".log",".lua",".md",".txt",".xml",".yaml",".yml"].indexOf(ext)>=0) { previewText(entry); return; }
        previewBinary(entry,"No inline preview is available for this file.");
      }

      function renderSelectedObject(entry) {
        clear(els.selectedObject);
        var card=document.createElement("article"); card.className="selected-card";
        var type=document.createElement("span"); type.className="selected-type"; type.textContent=entry.assetType||entry.extension||"File";
        var title=document.createElement("h2"); title.textContent=entry.name;
        var details=document.createElement("dl");
        [["Size",formatBytes(entry.size)],["Path",entry.path]].forEach(function (detail) { var group=document.createElement("div"); var term=document.createElement("dt"); term.textContent=detail[0]; var value=document.createElement("dd"); value.textContent=detail[1]; group.append(term,value); details.appendChild(group); });
        var link=openFileLocationButton(entry);
        var actions=document.createElement("div"); actions.className="selected-actions";
        var previewButton=document.createElement("button"); previewButton.type="button"; previewButton.className="selected-action"; previewButton.textContent="Preview"; previewButton.onclick=function () { showAssetPreview(entry); };
        var relatedButton=document.createElement("button"); relatedButton.type="button"; relatedButton.className="selected-action"; relatedButton.textContent="Related"; relatedButton.onclick=function () { previewRelated(entry); };
        actions.append(previewButton,relatedButton); card.append(type,title,details,actions,link); els.selectedObject.appendChild(card);
      }

      function clearAssetSelection() {
        state.selectedAsset=null; state.selectedAssetPath=""; state.assetView=""; empty(els.selectedObject,"Select an object."); els.previewTitle.textContent="Asset preview"; els.previewMeta.textContent="Select a file"; empty(els.preview,"Images, audio, video, and text metadata can be previewed here.");
      }

      function previewRelated(entry) {
        state.assetView="related";
        els.previewTitle.textContent="Related to "+entry.name; els.previewMeta.textContent="Unity references and gameplay table matches"; empty(els.preview,"Finding related objects…");
        api("related",{path:entry.path}).then(function (data) {
          if (state.selectedAssetPath!==entry.path || state.assetView!=="related") return;
          clear(els.preview); var root=document.createElement("div"); root.className="related-preview";
          var assetItems=(data.assets||[]).concat(data.unityObjects||[]);
          appendRelatedSection(root,"Assets",assetItems,function (asset) {
            var node=asset.path?document.createElement("button"):document.createElement("div"); node.className="related-entry"; if(asset.path) node.type="button";
            var title=document.createElement("strong"); title.textContent=asset.name; var meta=document.createElement("span"); meta.textContent=(asset.relation||"Related asset")+" · "+(asset.assetType||"Unity object")+(asset.path?" · "+asset.path:""); node.append(title,meta);
            if(asset.path) node.onclick=function () { previewAsset(asset); }; return node;
          });
          appendRelatedSection(root,"Gameplay table values",data.tables||[],function (row) {
            var node=document.createElement("article"); node.className="related-entry"; var title=document.createElement("strong"); title.textContent=(row.table||"Gameplay table")+" · "+(row.idField||"ID")+" "+row.id;
            var meta=document.createElement("span"); meta.textContent="Matched by "+row.matchedBy; var code=document.createElement("code"); code.textContent=JSON.stringify(row,null,2); node.append(title,meta,code); return node;
          });
          if (!root.children.length) empty(els.preview,"No direct Unity references or gameplay table matches were found."); else els.preview.appendChild(root);
        }).catch(function (err) { if(state.selectedAssetPath===entry.path && state.assetView==="related") empty(els.preview,err.message); });
      }

      function appendRelatedSection(root,title,items,renderItem) {
        if (!items.length) return; var section=document.createElement("section"); section.className="related-section"; var heading=document.createElement("h3"); heading.textContent=title+" ("+items.length+")"; section.appendChild(heading);
        items.forEach(function (item) { section.appendChild(renderItem(item)); }); root.appendChild(section);
      }

      function previewSpine(entry) {
        empty(els.preview,"Finding the Spine skeleton, atlas, and texture pages…");
        api("spine-set",{path:entry.path}).then(function (set) {
          if (!set.ready || !state.spineViewerAvailable) {
            var reason=set.notSpine?"":(!state.spineViewerAvailable?"The local SpineViewer build is not available.":"Spine preview needs "+(set.missing||[]).join(", ")+".");
            if (entry.extension===".atlas"||entry.extension===".bytes"||entry.extension===".json") previewText(entry,reason);
            else previewBinary(entry,reason);
            return;
          }
          clear(els.preview);
          var frame=document.createElement("iframe"); frame.className="spine-frame"; frame.title="Spine preview for "+entry.name; frame.src=BASE_PATH+"/spine/?mode=view";
          frame.onload=function () { loadSpineFiles(frame,set.files).catch(function (err) { previewBinary(entry,"SpineViewer could not load this set: "+err.message); }); };
          els.preview.appendChild(frame);
        }).catch(function (err) { previewBinary(entry,err.message); });
      }

      function loadSpineFiles(frame,files) {
        return Promise.all(files.map(function (file) {
          return loadingFetch(BASE_PATH+"/api/asset?path="+encodeURIComponent(file.path),{cache:"no-store"},function (response) {
            if (!response.ok) throw new Error("Could not load "+file.name);
            return response.blob().then(function (blob) { return {blob:blob,name:file.name}; });
          });
        })).then(function (loaded) {
          var win=frame.contentWindow;
          if (!win || !win.DataTransfer || !win.DragEvent || !win.File) throw new Error("Embedded file loading is unavailable in this browser.");
          var transfer=new win.DataTransfer();
          loaded.forEach(function (file) { transfer.items.add(new win.File([file.blob],file.name,{type:file.blob.type})); });
          win.dispatchEvent(new win.DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:transfer}));
        });
      }

      function previewText(entry,reason) {
        clear(els.preview); var pre=document.createElement("pre"); pre.textContent="Loading preview…"; els.preview.appendChild(pre);
        api("text",{path:entry.path}).then(function (data) {
          var text=data.text;
          if ((entry.extension===".json"||entry.extension===".bytes")&&!data.truncated) { try { text=JSON.stringify(JSON.parse(text.replace(/^\uFEFF/,"")),null,2); } catch (_) {} }
          pre.textContent=(reason?reason+"\n\n":"")+text+(data.truncated?"\n\n[Preview truncated]":"");
        }).catch(function (err) { pre.textContent=(reason?reason+"\n\n":"")+err.message; });
      }

      function previewBinary(entry,reason) {
        clear(els.preview); var div=document.createElement("div"); div.className="empty"; var message=document.createElement("div"); message.textContent=reason; div.append(message,document.createElement("br"),openFileLocationButton(entry)); els.preview.appendChild(div);
      }
      function formatBytes(value) { var size=Number(value||0); if (size<1024) return size+" B"; if (size<1048576) return (size/1024).toFixed(1)+" KB"; return (size/1048576).toFixed(1)+" MB"; }

      function showMode(mode) {
        var home=mode==="home",systems=mode==="systems",objects=mode==="objects",tables=mode==="tables",assets=mode==="assets",episodes=mode==="episodes",units=mode==="units",combat=mode==="combat",creator=mode==="creator",loader=mode==="loader"; els.homePanel.hidden=!home; els.systemsPanel.hidden=!systems; els.objectsPanel.hidden=!objects; els.tablesPanel.hidden=!tables; els.assetsPanel.hidden=!assets; els.episodePanel.hidden=!episodes; els.unitPanel.hidden=!units; els.combatPanel.hidden=!combat; els.creatorPanel.hidden=!creator; els.loaderPanel.hidden=!loader; els.modSideTabs.hidden=PRODUCT!=="mod"; els.assetSideTabs.hidden=PRODUCT!=="assets"; els.homeTab.classList.toggle("active",home); els.systemsTab.classList.toggle("active",systems); els.objectsTab.classList.toggle("active",objects); els.tablesTab.classList.toggle("active",tables); els.assetsTab.classList.toggle("active",assets); els.creatorTab.classList.toggle("active",creator); els.loaderTab.classList.toggle("active",loader);
        if (systems && !state.systems.length) loadSystems().catch(showError);
        if (objects && state.selectedObjectId==null) loadObjects().catch(showError);
        if (objects && !state.objectProjectsLoaded) loadObjectTools().catch(showError);
        if (tables && !els.tableList.children.length) loadTables().catch(showError);
        if (assets && !els.assetList.children.length) loadAssets().catch(showError);
        if (episodes && !state.episodeCatalog) loadEpisodeMaker().catch(showError); else if(episodes)requestAnimationFrame(renderEpisodeWorkspace);
        if (units && !state.unitCatalogLoaded) { loadUnitCatalog().catch(showError); loadUnityStatus().catch(showError); }
        if (creator && !state.projects.length) loadProjects().catch(showError);
        if (loader) loadRuntime().catch(showError);
      }
      function showError(err) { els.status.textContent=err.message; els.status.style.color="#ff9f9f"; }

      els.homeTab.onclick=function () { showMode("home"); };
      els.openCreator.onclick=function () { showMode("creator"); };
      els.openLoader.onclick=function () { showMode("loader"); };
      els.systemsTab.onclick=function () { showMode("systems"); };
      els.objectsTab.onclick=function () { showMode("objects"); };
      els.tablesTab.onclick=function () { showMode("tables"); };
      els.assetsTab.onclick=function () { showMode("assets"); };
      els.creatorTab.onclick=function () { showMode("creator"); };
      els.loaderTab.onclick=function () { showMode("loader"); };
      els.fieldSearchForm.onsubmit=function (event) { event.preventDefault(); searchFields().catch(showError); };
      els.tableSearch.oninput=debounce(function () { state.tableQuery=els.tableSearch.value.trim(); state.tableOffset=0; loadTables().catch(showError); });
      els.recordSearch.oninput=debounce(function () { state.recordQuery=els.recordSearch.value.trim(); state.recordOffset=0; loadRecords().catch(showError); });
      els.assetSearch.oninput=debounce(function () { state.assetQuery=els.assetSearch.value.trim(); state.assetOffset=0; loadAssets().catch(showError); });
      els.objectType.onchange=function () { state.objectType=els.objectType.value;state.objectOffset=0;state.selectedObjectId=null;loadObjects().catch(showError); };
      els.objectSearch.oninput=debounce(function () { state.objectQuery=els.objectSearch.value.trim();state.objectOffset=0;state.selectedObjectId=null;loadObjects().catch(showError); });
      els.objectProject.onchange=function(){selectObjectProject(els.objectProject.value).catch(showError)};
      els.objectNewProject.onclick=function(){createObjectProject().catch(showError)};
      els.objectImportMod.onchange=function(){var file=els.objectImportMod.files&&els.objectImportMod.files[0];if(!file)return;importModFile(file).then(function(project){els.objectImportMod.value="";return loadObjectTools(project.manifest.id)}).catch(showError)};
      els.objectExportMod.onclick=function(){if(state.objectProject)window.location.href=BASE_PATH+"/api/mods/"+encodeURIComponent(state.objectProject.manifest.id)+"/export"};
      els.objectBuildAssets.onclick=function(){buildObjectProjectAssets().catch(showError)};
      els.objectEditAssetPath.onclick=function(){openAssetReplacement(els.objectAssetPath.value).catch(showError)};
      els.unitSearch.oninput=debounce(function () { loadUnitCatalog().catch(showError); });
      els.episodeCategory.onchange=function(){renderEpisodeOptions();loadEpisodeLibrary().catch(showError)};
      els.episodeSelect.onchange=function(){loadEpisodeLibrary().catch(showError)};
      els.episodeStageSelect.onchange=function(){var next=Number(els.episodeStageSelect.value);syncEpisodeStage();applyEpisodeStage(state.episodeStages[next],next)};
      els.addEpisodeStage.onclick=function(){addEpisodeStage(false).catch(showError)};
      els.duplicateEpisodeStage.onclick=function(){var node=state.episodeSelectedNode;if(node&&node.source==="base"&&state.episodeBaseDetail)cloneEpisodeBaseStage(state.episodeBaseDetail).catch(showError);else addEpisodeStage(true,state.episodeStageIndex+1).catch(showError)};
      els.insertEpisodeStage.onclick=function(){addEpisodeStage(false,state.episodeStageIndex+1).catch(showError)};
      els.deleteEpisodeStage.onclick=deleteSelectedEpisodeStage;
      els.resetEpisodeOverride.onclick=resetEpisodeOverrideFields;
      els.editEpisodeStage.onclick=function(){editEpisodeCutscene()};
      els.stageEarlier.onclick=function(){moveEpisodeStage(-1)};els.stageLater.onclick=function(){moveEpisodeStage(1)};
      els.episodeDefinitionMode.onclick=function(){if(state.episodeDefinition){state.episodeDefinitionActive=true;setEpisodeMode("episode")}};els.episodeStageMode.onclick=function(){setEpisodeMode("stage")};els.episodeCutsceneMode.onclick=function(){if(state.episodeScenes.length)setEpisodeMode("cutscene")};
      els.loadEpisodeProject.onclick=function(){openEpisodeProject().catch(showError)};
      var updateEpisodeAssets=debounce(function(){syncEpisodeStage();previewStaticEpisodeAssets();renderEpisodeWorkspace()});els.episodeBackground.oninput=updateEpisodeAssets;els.episodeMusic.oninput=updateEpisodeAssets;els.episodeStageCharacter.oninput=updateEpisodeAssets;els.episodeActBackground.oninput=updateEpisodeAssets;els.episodeThumbnail.oninput=updateEpisodeAssets;els.episodeDungeonIcon.oninput=updateEpisodeAssets;
      els.episodeDifficulty.onchange=function(){if(els.episodeDifficulty.value==="HARD"&&state.episodeDefinition&&state.episodeDefinition.custom)state.episodeDefinition.hardMode.enabled=true;syncEpisodeStage();renderEpisodeWorkspace()};
      [els.episodeTitle,els.episodeDescription,els.episodeAct,els.episodeIndex,els.episodeUiNumber,els.episodeUnlock,els.episodeStageId,els.episodeDungeonId,els.episodeCutsceneId,els.episodeStageStr,els.episodeDungeonStr,els.episodeCutsceneStr].forEach(function(input){input.addEventListener("input",debounce(function(){syncEpisodeStage();renderEpisodeWorkspace()}))});
      els.episodeForm.onsubmit=function(event){event.preventDefault();saveEpisodeMod(true).catch(showError)};
      els.sendEpisodeToModside.onclick=function(){sendEpisodeModToLoader().catch(showError)};
      els.addEpisodeScene.onclick=function(){var stage=state.episodeStages[state.episodeStageIndex];if(state.episodeSelectedNode&&state.episodeSelectedNode.source==="base"||stage&&(stage.cutsceneReadOnly||stage.forkCutscenes))return;state.episodeScenes.push({speakerName:"Speaker",speakerActorId:"USER_ADMIN_NULL_NULL",dialogue:"New dialogue",voiceLine:"",background:"",music:"",transition:"FADE",fadeTime:1,dimActors:false,effects:[],actors:[]});state.episodeSceneIndex=state.episodeScenes.length-1;state.episodeSelection={type:"scene"};renderEpisodeWorkspace();els.episodeScenes.scrollLeft=els.episodeScenes.scrollWidth};
      els.episodePrevScene.onclick=function(){if(state.episodeMode==="stage")navigateStage(-1);else setEpisodeScene(state.episodeSceneIndex-1)};
      els.episodeNextScene.onclick=function(){if(state.episodeMode==="stage")navigateStage(1);else setEpisodeScene(state.episodeSceneIndex+1)};
      els.episodePlay.onclick=toggleEpisodePlayback;
      els.episodeStageCanvas.onpointerdown=function(event){if(event.button!==0)return;event.preventDefault();els.episodeStageCanvas.setPointerCapture(event.pointerId);var node=stageNodeAtPoint(stageCanvasPoint(event));if(node&&node.source==="mod"&&node.stage.operation!=="override")state.stageNodeDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,sourceIndex:node.index,dropIndex:null,moved:false};else state.stagePanDrag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,originX:state.stagePanX,originY:state.stagePanY,moved:false}};
      els.episodeStageCanvas.onpointermove=function(event){var nodeDrag=state.stageNodeDrag;if(nodeDrag&&nodeDrag.pointerId===event.pointerId){if(Math.hypot(event.clientX-nodeDrag.startX,event.clientY-nodeDrag.startY)>3)nodeDrag.moved=true;if(nodeDrag.moved){var source=state.episodeStages[nodeDrag.sourceIndex],target=stageNodeAtPoint(stageCanvasPoint(event));nodeDrag.dropIndex=target&&target.source==="mod"&&target.index!==nodeDrag.sourceIndex&&target.stage.operation!=="override"&&target.stage.difficulty===source.difficulty&&target.stage.actId===source.actId?target.index:null;renderStageLayout()}return}var drag=state.stagePanDrag;if(!drag||drag.pointerId!==event.pointerId)return;var bounds=els.episodeStageCanvas.getBoundingClientRect(),dx=(event.clientX-drag.startX)*1280/bounds.width,dy=(event.clientY-drag.startY)*720/bounds.height,limitX=Number(state.episodeDefinition&&state.episodeDefinition.layoutPanX!=null?state.episodeDefinition.layoutPanX:960),limitY=Number(state.episodeDefinition&&state.episodeDefinition.layoutPanY!=null?state.episodeDefinition.layoutPanY:480);if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>3)drag.moved=true;state.stagePanX=Math.max(-limitX,Math.min(limitX,drag.originX+dx));state.stagePanY=Math.max(-limitY,Math.min(limitY,drag.originY+dy));renderStageLayout()};
      els.episodeStageCanvas.onpointerup=function(event){if(state.stageNodeDrag)finishStageNodeDrag(event,true);else finishStagePan(event,true)};
      els.episodeStageCanvas.onpointercancel=function(event){if(state.stageNodeDrag)finishStageNodeDrag(event,false);else finishStagePan(event,false)};
      els.cutsceneCanvas.onclick=function(event){var scene=state.episodeScenes[state.episodeSceneIndex];if(!scene)return;var bounds=els.cutsceneCanvas.getBoundingClientRect(),x=(event.clientX-bounds.left)*1280/bounds.width,y=(event.clientY-bounds.top)*720/bounds.height,index=-1;for(var actorIndex=scene.actors.length-1;actorIndex>=0;actorIndex-=1){var actor=scene.actors[actorIndex],center=actor.position==="L"?270:actor.position==="R"?1010:640;if(actor.visible!==false&&x>=center-180&&x<=center+180&&y>=245&&y<=605){index=actorIndex;break}}state.episodeSelection=index>=0?{type:"actor",actorIndex:index}:{type:"background"};renderEpisodeInspectors();renderEpisodePreview()};
      els.cutsceneDialogue.onclick=function(){state.episodeSelection={type:"scene"};renderEpisodeInspectors();renderEpisodePreview()};
      els.tablePrev.onclick=function () { state.tableOffset=Math.max(0,state.tableOffset-PAGE_SIZE); loadTables().catch(showError); };
      els.tableNext.onclick=function () { state.tableOffset+=PAGE_SIZE; loadTables().catch(showError); };
      els.recordPrev.onclick=function () { state.recordOffset=Math.max(0,state.recordOffset-PAGE_SIZE); loadRecords().catch(showError); };
      els.recordNext.onclick=function () { state.recordOffset+=PAGE_SIZE; loadRecords().catch(showError); };
      els.assetPrev.onclick=function () { state.assetOffset=Math.max(0,state.assetOffset-PAGE_SIZE); loadAssets().catch(showError); };
      els.assetNext.onclick=function () { state.assetOffset+=PAGE_SIZE; loadAssets().catch(showError); };
      els.systemPrev.onclick=function () { state.systemOffset=Math.max(0,state.systemOffset-PAGE_SIZE); loadSystemTables().catch(showError); };
      els.systemNext.onclick=function () { state.systemOffset+=PAGE_SIZE; loadSystemTables().catch(showError); };
      els.objectPrev.onclick=function () { state.objectOffset=Math.max(0,state.objectOffset-PAGE_SIZE);state.selectedObjectId=null;loadObjects().catch(showError); };
      els.objectNext.onclick=function () { state.objectOffset+=PAGE_SIZE;state.selectedObjectId=null;loadObjects().catch(showError); };
      els.newModForm.onsubmit=function (event) { event.preventDefault(); writeApi("mods","POST",{id:els.newModId.value.trim(),name:els.newModName.value.trim()}).then(function (project) { els.newModForm.reset(); state.selectedProject=project; return loadProjects(); }).catch(showError); };
      els.importMod.onchange=function () { var file=els.importMod.files&&els.importMod.files[0]; if(!file)return; importModFile(file).then(function(project){state.selectedProject=project;els.importMod.value="";return loadProjects()}).catch(showError); };
      els.loaderImportMod.onchange=function () { var file=els.loaderImportMod.files&&els.loaderImportMod.files[0]; if(!file)return; importModFile(file).then(function(project){els.loaderImportMod.value="";return loadRuntime().then(function(){els.status.style.color="";els.status.textContent=project.manifest.name+" added; activate it when ready"})}).catch(showError); };
      els.manifestForm.onsubmit=function (event) { event.preventDefault(); if(!state.selectedProject)return; writeApi("mods/"+encodeURIComponent(state.selectedProject.manifest.id),"PUT",{name:els.manifestName.value,version:els.manifestVersion.value,author:els.manifestAuthor.value,description:els.manifestDescription.value}).then(function(project){state.selectedProject=project;renderProject(project);return loadProjects()}).catch(showError); };
      els.validateMod.onclick=function () { if(!state.selectedProject)return; api("mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/validate").then(function(report){state.selectedProject.validation=report;renderProjectStatus(report);if(report.errors.length){state.editorMode="validation";renderEditor()}}).catch(showError); };
      els.exportMod.onclick=function () { if(state.selectedProject) window.location.href=BASE_PATH+"/api/mods/"+encodeURIComponent(state.selectedProject.manifest.id)+"/export"; };
      els.copyRecord.onclick=function () { copySelectedRecord(false).catch(showError); };
      els.duplicateRecord.onclick=function () { copySelectedRecord(true).catch(showError); };
      els.savePatch.onclick=function () { saveCurrentPatch().catch(showError); };
      els.duplicatePatch.onclick=function () { duplicateCurrentPatch().catch(showError); };
      els.deleteRecord.onclick=function () { saveCurrentPatch(null).catch(showError); };
      els.removePatch.onclick=function () { removeCurrentPatch().catch(showError); };
      els.formEditorTab.onclick=function () { setEditorMode("form"); };
      els.rawEditorTab.onclick=function () { setEditorMode("raw"); };
      els.diffEditorTab.onclick=function () { setEditorMode("diff"); };
      els.validationEditorTab.onclick=function () { setEditorMode("validation"); };
      els.referenceSearch.oninput=debounce(searchReferences);
      els.closeReference.onclick=function () { els.referencePicker.hidden=true; };
      els.buildRuntime.onclick=function () { applyLoaderProfile(state.loaderEnabled).catch(showError); };
      els.rollbackRuntime.onclick=function () { writeApi("mod-runtime/rollback","POST").then(function(runtime){state.runtime=runtime;state.loaderEnabled=runtime.profile.enabled.slice();renderRuntime()}).catch(showError); };
      els.unitForm.onsubmit=function(event){event.preventDefault();createUnitMod().catch(showError)};
      els.attachUnitSpine.onclick=function(){attachSelectedUnitSpine().catch(showError)};
      els.buildBundle.onclick=function(){buildUnityBundle().catch(showError)};
      document.addEventListener("mouseover",revealClippedText);
      document.addEventListener("focusin",revealClippedText);
      var initialView=new URLSearchParams(window.location.search).get("view"),legacyRoute=PRODUCT==="mod"&&({systems:"assets",objects:"assets",tables:"assets",assets:"assets",episodes:"story",units:"units"})[initialView];
      if(legacyRoute){window.location.replace(BASE_PATH+"/"+legacyRoute+(legacyRoute==="assets"?"?view="+encodeURIComponent(initialView):""));return}
      var productModes={mod:["home","creator","loader"],assets:["systems","objects","tables","assets"],story:["episodes"],units:["units"],combat:["combat"]},defaultModes={mod:"home",assets:"systems",story:"episodes",units:"units",combat:"combat"},allowed=productModes[PRODUCT]||productModes.mod;
      showMode(allowed.indexOf(initialView)>=0?initialView:defaultModes[PRODUCT]||"home");

      api("health").then(function (health) { state.spineViewerAvailable=health.spineViewerAvailable; els.status.textContent=health.tableCount.toLocaleString()+" tables · "+(health.assetRootAvailable?"assets ready":"asset extraction not found")+" · "+(health.spineViewerAvailable?"Spine ready":"SpineViewer build missing"); }).catch(showError);
    }());
  </script>
</body>
</html>`;
}

module.exports = { createAssetViewer };
