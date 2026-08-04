const fs = require("fs");
const path = require("path");
const { extractTableRecords, findGameplayTableFile, readGameplayTable } = require("../gameplay-jsons");
const { statTypeValue } = require("../packet-codec");

const TYPES = new Set(["unit", "ship", "operator", "gear"]);
const UNIT_ASSETS = [
  ["m_InvenIconName", "Management/list icon PNG ID", "Loaded from AB_INVEN_ICON_UNIT for Management roster slots, deck slots, rewards, and other compact unit icons."],
  ["m_FaceCardName", "Recruitment/card PNG ID", "Loaded from AB_UNIT_FACE_CARD for recruitment banners, gacha cards, deck ship cards, and other large card portraits."],
  ["m_SpineIllustName", "Management/gacha illustration ID", "Large animated Spine illustration used by Management details, collection profiles, recruitment banners, and character showcases."],
  ["m_SpineSDName", "SD/chibi illustration ID", "Small Spine illustration used by office, collection, and event views that request the SD presentation."],
  ["m_MiniMapFaceName", "Battle minimap portrait ID", "Portrait loaded from AB_UNIT_MINI_MAP_FACE for battle, dive, and warfare minimaps."],
  ["m_SpriteBundleName", "Battle Spine bundle ID", "AssetBundle containing the live combat Spine object."],
  ["m_SpriteName", "Battle Spine object ID", "Object name opened from m_SpriteBundleName for the live combat model and animations."],
];

function createAssetCatalog(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const assetRoot = path.resolve(options.assetRoot || path.join(rootDir, "extracted-assets", "all"));
  const env = { ...(options.env || process.env) };
  delete env.CS_MOD_TABLES_DIR;
  let cache;

  function data() {
    if (cache) return cache;
    const wikiUnits = indexById(readJson(path.join(rootDir, "wiki", "data", "units.json")) || []);
    const wikiGears = indexById(readJson(path.join(rootDir, "wiki", "data", "gears.json")) || []);
    const units = loadUnits(rootDir, env);
    const gears = records("ab_script_item_templet", "LUA_ITEM_EQUIP_TEMPLET.json");
    cache = {
      unit: units.filter((row) => String(row.m_NKM_UNIT_TYPE || "") !== "NUT_SHIP" && String(row.m_NKM_UNIT_TYPE || "") !== "NUT_OPERATOR" && String(row.m_NKM_UNIT_TYPE || "") !== "NUT_SYSTEM"),
      ship: units.filter((row) => String(row.m_NKM_UNIT_TYPE || "") === "NUT_SHIP"),
      operator: units.filter((row) => String(row.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR"),
      gear: gears,
      wikiUnits,
      wikiGears,
      unitSkills: groupBy(records("ab_script_unit_data", "LUA_UNIT_SKILL_TEMPLET.json"), "m_UnitSkillStrID"),
      shipSkills: groupBy(records("ab_script", "LUA_SHIP_SKILL_TEMPLET.json"), "m_ShipSkillStrID"),
      operatorSkillsByStr: groupBy(records("ab_script_unit_data", "LUA_OPERATOR_SKILL_TEMPLET.json"), "m_OperSkillStrID"),
      operatorSkillsById: groupBy(records("ab_script_unit_data", "LUA_OPERATOR_SKILL_TEMPLET.json"), "m_OperSkillID"),
      operatorPassives: groupBy(records("ab_script_unit_data", "LUA_OPERATOR_RANDOM_PASSIVE_TEMPLET.json"), "m_OprPassiveGroupID"),
      skins: groupBy(records("ab_script", "LUA_SKIN_TEMPLET.json"), "m_SkinEquipUnitID"),
      collections: groupBy(records("ab_script", "LUA_COLLECTION_UNIT_TEMPLET.json"), "m_UnitID"),
      shipBuilds: groupBy(records("ab_script", "LUA_SHIP_BUILD_TEMPLET.json"), "m_ShipID"),
      randomStats: groupBy(records("ab_script", "LUA_ITEM_EQUIP_RANDOM_STAT.json"), "m_StatGroupID"),
      potentials: groupBy(records("ab_script", "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json"), "m_PotentialOptionGroupID"),
      setOptions: indexBy(records("ab_script_item_templet", "LUA_ITEM_EQUIP_SET_OPTION.json"), "m_EquipSetID"),
      statInfo: indexBy(records("ab_script", "LUA_STAT_INFO_TEMPLET.json"), "Stat_ID"),
    };
    for (const type of TYPES) cache[type].sort((left, right) => objectId(type, left) - objectId(type, right));
    return cache;
  }

  function records(directory, fileName) {
    if (!fs.existsSync(findGameplayTableFile(directory, fileName, { rootDir, env }))) return [];
    const parsed = readGameplayTable(directory, fileName, { rootDir, env, noCache: true });
    return parsed ? extractTableRecords(parsed) : [];
  }

  function list(type, query = "", offset = 0, limit = 100) {
    type = normalizeType(type);
    const needle = String(query || "").trim().toLowerCase();
    const all = data()[type].filter((record) => {
      const summary = summarize(type, record, data());
      return !needle || [summary.id, summary.name, summary.strId, summary.meta].join(" ").toLowerCase().includes(needle);
    });
    offset = Math.max(0, Number(offset) || 0);
    limit = Math.max(1, Math.min(250, Number(limit) || 100));
    return { type, total: all.length, offset, objects: all.slice(offset, offset + limit).map((record) => summarize(type, record, data())) };
  }

  function inspect(type, id) {
    type = normalizeType(type);
    const record = data()[type].find((row) => objectId(type, row) === Number(id));
    if (!record) throw httpError(404, `${type} was not found: ${id}`);
    return type === "gear" ? inspectGear(record, data()) : inspectUnit(type, record, data());
  }

  function inspectUnit(type, record, loaded) {
    const source = record._sourceTable || "LUA_UNIT_TEMPLET_BASE.json";
    const result = { ...summarize(type, record, loaded), ids: [], stats: unitStats(record, loaded), gear_stat_ids: [] };
    addId(result.ids, "Unit ID", "m_UnitID", record.m_UnitID, "Primary numeric identity used by inventory data, squads, rewards, contracts, skins, and network packets.", source);
    addId(result.ids, "Unit string ID", "m_UnitStrID", record.m_UnitStrID, "Canonical string key joining the base template to stats, battle templates, collection data, and other gameplay tables.", source);
    addId(result.ids, "Base unit ID", "m_BaseUnitID", record.m_BaseUnitID, "Links variants, rearms, and alternate presentations back to their base character.", source);
    addId(result.ids, "Ship group ID", "m_ShipGroupID", record.m_ShipGroupID, "Groups upgrade stages and related versions of the same ship line.", source);
    addId(result.ids, "Operator passive group ID", "m_OprPassiveGroupID", record.m_OprPassiveGroupID, "Selects the pool of passive skill IDs this operator can roll.", source);
    addId(result.ids, "Tactical-update group ID", "m_TacticGroup", record.m_TacticGroup, "Groups units that share tactical-update progression rules.", source);
    addId(result.ids, "Team-up ID", "m_TeamUp", record.m_TeamUp, "Links this character to its collection/team affiliation.", source);
    addId(result.ids, "Name localization ID", "m_Name", record.m_Name, "Looks up the displayed unit name in the active language string table.", source);
    addId(result.ids, "Title localization ID", "m_Title", record.m_Title, "Looks up the displayed title or affiliation text.", source);
    addId(result.ids, "Description localization ID", "m_UnitDesc", record.m_UnitDesc, "Looks up the unit description shown by profile and collection UIs.", source);
    addId(result.ids, "Battle template ID", "m_UnitTempletFileName", record.m_UnitTempletFileName, "Names the decoded battle-template file that defines states, attacks, animation events, and combat behavior.", source);
    for (const [field, label, description] of UNIT_ASSETS) {
      addId(result.ids, label, field, record[field], description, source, assetPreview(field, record[field], assetRoot));
    }

    const skills = type === "ship" ? loaded.shipSkills : type === "operator" ? loaded.operatorSkillsByStr : loaded.unitSkills;
    for (let slot = 1; slot <= 4; slot += 1) {
      const strId = record[`m_SkillStrID${slot}`];
      if (!strId) continue;
      addId(result.ids, `Skill ${slot} string ID`, `m_SkillStrID${slot}`, strId, `Selects skill slot ${slot} and joins to its skill template.`, source);
      const rows = uniqueBy(skills.get(String(strId)) || [], type === "ship" ? "m_ShipSkillID" : type === "operator" ? "m_OperSkillID" : "m_UnitSkillID");
      for (const skill of rows) {
        const idField = type === "ship" ? "m_ShipSkillID" : type === "operator" ? "m_OperSkillID" : "m_UnitSkillID";
        const iconField = type === "ship" ? "m_ShipSkillIcon" : type === "operator" ? "m_OperSkillIcon" : "m_UnitSkillIcon";
        const skillTable = type === "ship" ? "LUA_SHIP_SKILL_TEMPLET.json" : type === "operator" ? "LUA_OPERATOR_SKILL_TEMPLET.json" : "LUA_UNIT_SKILL_TEMPLET.json";
        addId(result.ids, `Skill ${slot} numeric ID`, idField, skill[idField], "Numeric skill identity used by skill levels, upgrades, combat state, and packets.", skillTable);
        addId(result.ids, `Skill ${slot} icon asset ID`, iconField, skill[iconField], "Selects the icon displayed by skill panels and tooltips.", skillTable);
      }
    }

    for (const skin of loaded.skins.get(String(record.m_UnitID)) || []) {
      addId(result.ids, "Skin ID", "m_SkinID", skin.m_SkinID, `Selects the alternate ${skin.m_SkinStrID || "skin"} presentation; equipped skin fields override the unit art IDs above.`, "LUA_SKIN_TEMPLET.json");
      addId(result.ids, "Skin string ID", "m_SkinStrID", skin.m_SkinStrID, "Canonical string key for this alternate skin and its asset names.", "LUA_SKIN_TEMPLET.json");
    }
    for (const collection of loaded.collections.get(String(record.m_UnitID)) || []) {
      addId(result.ids, "Collection row ID", "Idx", collection.Idx, "Places this unit in the collection/profile catalog.", "LUA_COLLECTION_UNIT_TEMPLET.json");
    }
    if (type === "operator") for (const passive of loaded.operatorPassives.get(String(record.m_OprPassiveGroupID)) || []) {
      const skill = (loaded.operatorSkillsById.get(String(passive.m_OperSkillID)) || [])[0];
      addId(result.ids, "Passive skill numeric ID", "m_OperSkillID", passive.m_OperSkillID, `A rollable passive in group ${record.m_OprPassiveGroupID}${skill && skill.m_OperSkillStrID ? ` (${skill.m_OperSkillStrID})` : ""}.`, "LUA_OPERATOR_RANDOM_PASSIVE_TEMPLET.json");
    }
    if (type === "ship") for (const build of loaded.shipBuilds.get(String(record.m_UnitID)) || []) {
      addId(result.ids, "Ship build ID", "m_ShipID", build.m_ShipID, "Joins this ship to its construction and upgrade recipe.", "LUA_SHIP_BUILD_TEMPLET.json");
      addId(result.ids, "Ship upgrade target ID", "m_ShipUpgradeTarget1", build.m_ShipUpgradeTarget1, "Unit ID produced by the next ship upgrade stage.", "LUA_SHIP_BUILD_TEMPLET.json");
      for (let slot = 1; slot <= 4; slot += 1) addId(result.ids, `Build material ${slot} item ID`, `m_ShipBuildMaterialID_${slot}`, build[`m_ShipBuildMaterialID_${slot}`], "Item/currency ID consumed by the ship construction recipe.", "LUA_SHIP_BUILD_TEMPLET.json");
    }
    for (const [field, label] of [["m_OnRemoveItemID_1", "Dismissal reward item ID 1"], ["m_OnRemoveItemID_2", "Dismissal reward item ID 2"], ["m_OnRemoveItemID_Contract", "Contract-dismissal reward item ID"], ["m_OnExtractItemID_1", "Extraction reward item ID"], ["m_OnExtractItemID_Contract", "Contract extraction item ID"]]) {
      addId(result.ids, label, field, record[field], "References the item granted when this unit is dismissed or extracted under the matching rule.", source);
    }
    return result;
  }

  function inspectGear(record, loaded) {
    const source = "LUA_ITEM_EQUIP_TEMPLET.json";
    const result = { ...summarize("gear", record, loaded), ids: [], stats: [], gear_stat_ids: [] };
    addId(result.ids, "Gear ID", "m_ItemEquipID", record.m_ItemEquipID, "Primary numeric identity used by inventory instances, rewards, crafting, upgrades, and packets.", source);
    addId(result.ids, "Gear string ID", "m_ItemEquipStrID", record.m_ItemEquipStrID, "Canonical string key for this gear template.", source);
    addId(result.ids, "Name localization ID", "m_ItemEquipName", record.m_ItemEquipName, "Looks up the displayed gear name.", source);
    addId(result.ids, "Description localization ID", "m_ItemEquipDesc", record.m_ItemEquipDesc, "Looks up the displayed gear description.", source);
    addId(result.ids, "Inventory icon PNG ID", "m_ItemEquipIconName", record.m_ItemEquipIconName, "Selects the gear PNG shown in inventory, equipment, reward, and crafting slots.", source, assetPreview("m_ItemEquipIconName", record.m_ItemEquipIconName, assetRoot));
    addId(result.ids, "Random stat group ID 1", "m_StatGroupID", record.m_StatGroupID, "Selects every allowed first tuning substat and its minimum/maximum roll.", source);
    addId(result.ids, "Random stat group ID 2", "m_StatGroupID_2", record.m_StatGroupID_2, "Selects every allowed second tuning substat and its minimum/maximum roll.", source);
    addId(result.ids, "Primary potential group ID", "m_PotentialOptionGroupID", record.m_PotentialOptionGroupID, "Selects relic potential options and per-socket ranges.", source);
    addId(result.ids, "Secondary potential group ID", "m_SubPotentialOptionGroupID", record.m_SubPotentialOptionGroupID, "Selects the secondary relic potential option pool.", source);
    for (const setId of arrayValue(record.m_SetGroup)) {
      const set = loaded.setOptions.get(String(setId));
      addId(result.ids, "Allowed set-option ID", "m_SetGroup[]", setId, `Allows this gear to roll the ${set && (set.m_EquipSetStrID || set.m_EquipSetName) || "referenced"} set bonus.`, "LUA_ITEM_EQUIP_SET_OPTION.json");
    }
    for (const [field, label] of [["m_OnRemoveItemID_1", "Dismantle reward item ID 1"], ["m_OnRemoveItemID_2", "Dismantle reward item ID 2"], ["m_RandomSetReqItemID", "Set reroll material item ID"], ["m_RelicRerollReqItemID", "Relic reroll material item ID"], ["Socket1_OpenItemID", "Socket 1 unlock item ID"], ["Socket2_OpenItemID", "Socket 2 unlock item ID"], ["Socket3_OpenItemID", "Socket 3 unlock item ID"]]) {
      addId(result.ids, label, field, record[field], "References the item consumed or granted by the matching gear operation.", source);
    }
    addMainGearStat(result.gear_stat_ids, record, loaded);
    addRandomGearStats(result.gear_stat_ids, record, loaded);
    addPotentialGearStats(result.gear_stat_ids, record, loaded);
    return result;
  }

  return { list, inspect };
}

function loadUnits(rootDir, env) {
  const stored = readJson(path.join(rootDir, "server-data", "units.json"));
  if (stored && stored.byId) return Object.values(stored.byId);
  const files = [
    ["LUA_UNIT_TEMPLET_BASE.json", "LUA_UNIT_STAT_TEMPLET.json"],
    ["LUA_UNIT_TEMPLET_BASE2.json", "LUA_UNIT_STAT_TEMPLET2.json"],
    ["LUA_UNIT_TEMPLET_BASE_SD.json", "LUA_UNIT_STAT_TEMPLET_SD.json"],
    ["LUA_UNIT_TEMPLET_BASE_OPR.json", "LUA_UNIT_STAT_TEMPLET_OPR.json"],
  ];
  const byId = new Map();
  for (const [baseFile, statFile] of files) {
    const base = readRows(rootDir, env, "ab_script_unit_data", baseFile);
    const stats = indexBy(readRows(rootDir, env, "ab_script_unit_data", statFile), "m_UnitStrID");
    for (const row of base) if (Number(row && row.m_UnitID) > 0) byId.set(Number(row.m_UnitID), { ...row, _sourceTable: baseFile, _stat: stats.get(String(row.m_UnitStrID)) || null });
  }
  return Array.from(byId.values());
}

function readRows(rootDir, env, directory, fileName) {
  if (!fs.existsSync(findGameplayTableFile(directory, fileName, { rootDir, env }))) return [];
  const parsed = readGameplayTable(directory, fileName, { rootDir, env, noCache: true });
  return parsed ? extractTableRecords(parsed) : [];
}

function summarize(type, record, loaded) {
  const id = objectId(type, record);
  const wiki = type === "gear" ? loaded.wikiGears.get(String(id)) : loaded.wikiUnits.get(String(id));
  const strId = type === "gear" ? record.m_ItemEquipStrID : record.m_UnitStrID;
  const rawName = type === "gear" ? record.m_ItemEquipName : record.m_Name;
  return {
    type,
    id,
    strId: String(strId || ""),
    name: String(wiki && wiki.name || rawName || strId || `${type} ${id}`),
    image: String(wiki && wiki.image || ""),
    meta: type === "gear"
      ? [record.m_NKM_ITEM_GRADE, `T${record.m_NKM_ITEM_TIER || "?"}`, record.m_ItemEquipPosition, record.m_EquipUnitStyleType].filter(Boolean).join(" | ")
      : [record.m_NKM_UNIT_GRADE, record.m_NKM_UNIT_STYLE_TYPE, record.m_NKM_UNIT_ROLE_TYPE, record.m_bMonster ? "Monster" : ""].filter(Boolean).join(" | "),
  };
}

function unitStats(record, loaded) {
  const statData = record && record._stat && record._stat.m_StatData || {};
  const base = statData.m_Stat || {};
  const perLevel = statData.m_StatPerLevel || {};
  return Array.from(new Set([...Object.keys(base), ...Object.keys(perLevel)])).map((statType) => ({
    statId: statTypeValue(statType),
    statType,
    name: statName(statType, loaded),
    base: base[statType] == null ? null : base[statType],
    perLevel: perLevel[statType] == null ? null : perLevel[statType],
    fields: { base: `m_StatData.m_Stat.${statType}`, perLevel: `m_StatData.m_StatPerLevel.${statType}` },
    description: "The numeric stat ID is the client enum value; the two fields control the level-1 base and growth added per level.",
  }));
}

function addMainGearStat(output, gear, loaded) {
  const type = String(gear.STAT_TYPE_1 || "");
  if (!type) return;
  const min = numberOrNull(gear.STAT_VALUE_1);
  const perLevel = numberOrNull(gear.STAT_LEVELUP_VALUE_1) || 0;
  const maxLevel = numberOrNull(gear.m_MaxEnchantLevel) || 0;
  output.push({
    statId: statTypeValue(type), statType: type, name: statName(type, loaded), slot: "Main", groupId: null, optionKey: null, precisionWeightId: null,
    min, max: min == null ? null : min + perLevel * maxLevel,
    fields: { type: "STAT_TYPE_1", min: "STAT_VALUE_1", perLevel: "STAT_LEVELUP_VALUE_1", maxLevel: "m_MaxEnchantLevel" },
    sourceTable: "LUA_ITEM_EQUIP_TEMPLET.json",
    description: `Main stat range from enhancement +0 through +${maxLevel}; max = base + per-level value times max enchant level.`,
  });
}

function addRandomGearStats(output, gear, loaded) {
  for (const [field, slot] of [["m_StatGroupID", "Substat 1"], ["m_StatGroupID_2", "Substat 2"]]) {
    const groupId = numberOrNull(gear[field]);
    if (!groupId) continue;
    for (const row of loaded.randomStats.get(String(groupId)) || []) {
      const type = normalizeRateStat(row.m_StatType, row);
      output.push({
        statId: statTypeValue(type), statType: type, name: statName(type, loaded), slot, groupId, optionKey: null, precisionWeightId: null,
        min: numberOrNull(firstPresent(row.m_MinStatValue, row.m_MinStatRate, row.m_MinStat)),
        max: numberOrNull(firstPresent(row.m_MaxStatValue, row.m_MaxStatRate, row.m_MaxStat)),
        fields: { group: field, type: "m_StatType", min: firstField(row, ["m_MinStatValue", "m_MinStatRate", "m_MinStat"]), max: firstField(row, ["m_MaxStatValue", "m_MaxStatRate", "m_MaxStat"]) },
        sourceTable: "LUA_ITEM_EQUIP_RANDOM_STAT.json",
        description: `${field} selects group ${groupId}; this row defines one stat ID that slot may roll and its raw tuning range.`,
      });
    }
  }
}

function addPotentialGearStats(output, gear, loaded) {
  for (const [field, label] of [["m_PotentialOptionGroupID", "Primary potential"], ["m_SubPotentialOptionGroupID", "Secondary potential"]]) {
    const groupId = numberOrNull(gear[field]);
    if (!groupId) continue;
    for (const row of loaded.potentials.get(String(groupId)) || []) for (let socket = 1; socket <= 3; socket += 1) {
      const minField = firstField(row, [`Socket${socket}_MinStat`, `Socket${socket}_MinStatRate`]);
      const maxField = firstField(row, [`Socket${socket}_MaxStat`, `Socket${socket}_MaxStatRate`]);
      if (!minField && !maxField) continue;
      const type = normalizeRateStat(row.Socket1_StatType, row);
      output.push({
        statId: statTypeValue(type), statType: type, name: statName(type, loaded), slot: `${label} | Socket ${socket}`, groupId,
        optionKey: numberOrNull(row.OptionKey), precisionWeightId: numberOrNull(row.PrecisionWeightId),
        min: numberOrNull(row[minField]), max: numberOrNull(row[maxField]),
        fields: { group: field, option: "OptionKey", precisionWeight: "PrecisionWeightId", type: "Socket1_StatType", min: minField, max: maxField },
        sourceTable: "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json",
        description: `${field} selects group ${groupId}; OptionKey identifies the potential and PrecisionWeightId controls precision-roll weighting.`,
      });
    }
  }
}

function addId(output, label, field, value, description, sourceTable, preview = "") {
  if (value == null || value === "" || value === 0 || value === "0") return;
  output.push({ label, field, value, description, sourceTable, preview });
}

function assetPreview(field, value, assetRoot) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(String(value))) return "";
  const candidates = field === "m_UnitSkillIcon"
    ? [
      `Data/StreamingAssets/ab_ui_unit_skill_icon/Sprite/${value}.png`,
      `Assetbundles/ab_ui_unit_skill_icon/Sprite/${value}.png`,
    ]
    : field === "m_InvenIconName"
    ? [`Data/StreamingAssets/ab_inven_icon_unit/Texture2D/${value}.png`]
    : field === "m_FaceCardName"
      ? [`Data/StreamingAssets/ab_unit_face_card_loc/Texture2D/${value}.png`, `Data/StreamingAssets/ab_unit_face_card/Texture2D/${value}.png`]
      : field === "m_MiniMapFaceName"
        ? [`Data/StreamingAssets/ab_unit_mini_map_face/Texture2D/${value}.png`]
        : field === "m_ItemEquipIconName"
          ? [`Data/StreamingAssets/ab_inven_icon_item_equip/Texture2D/AB_INVEN_ICON_${value}.png`, `Data/StreamingAssets/ab_inven_icon_item_equip/Texture2D/${value}.png`]
          : [];
  const direct = candidates.find((candidate) => fs.existsSync(path.join(assetRoot, ...candidate.split("/"))));
  if (direct) return direct;
  if (!["m_SpineIllustName", "m_SpineSDName", "m_SpriteBundleName"].includes(field)) return "";
  for (const root of ["Data/StreamingAssets", "Assetbundles"]) {
    const relativeDirectory = `${root}/${String(value).toLowerCase()}/Texture2D`;
    const directory = path.join(assetRoot, ...relativeDirectory.split("/"));
    if (!fs.existsSync(directory)) continue;
    const image = fs.readdirSync(directory).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).sort()[0];
    if (image) return `${relativeDirectory}/${image}`;
  }
  return "";
}

function statName(type, loaded) {
  const base = String(type || "").replace(/_FACTOR$/, "");
  const info = loaded.statInfo.get(base);
  return humanize(info && info.Stat_ID || base);
}

function normalizeRateStat(type, row) {
  type = String(type || "");
  if (!(row && Object.keys(row).some((key) => /StatRate$/.test(key)))) return type;
  return { NST_HP: "NST_HP_FACTOR", NST_ATK: "NST_ATK_FACTOR", NST_DEF: "NST_DEF_FACTOR", NST_CRITICAL: "NST_CRITICAL_FACTOR", NST_HIT: "NST_HIT_FACTOR", NST_EVADE: "NST_EVADE_FACTOR" }[type] || type;
}

function normalizeType(value) {
  const type = String(value || "unit").toLowerCase();
  if (!TYPES.has(type)) throw httpError(400, `Unknown object type: ${type}`);
  return type;
}

function objectId(type, record) { return Number(type === "gear" ? record.m_ItemEquipID : record.m_UnitID) || 0; }
function groupBy(rows, field) { const map = new Map(); for (const row of rows) { const key = row && row[field]; if (key == null || key === "") continue; const values = map.get(String(key)) || []; values.push(row); map.set(String(key), values); } return map; }
function indexBy(rows, field) { const map = new Map(); for (const row of rows) if (row && row[field] != null && !map.has(String(row[field]))) map.set(String(row[field]), row); return map; }
function indexById(rows) { return indexBy(Array.isArray(rows) ? rows : [], "id"); }
function uniqueBy(rows, field) { const seen = new Set(); return rows.filter((row) => { const value = row && row[field]; if (value == null || seen.has(String(value))) return false; seen.add(String(value)); return true; }); }
function arrayValue(value) { return Array.isArray(value) ? value : value == null || value === "" ? [] : [value]; }
function firstPresent(...values) { return values.find((value) => value != null && value !== ""); }
function firstField(record, fields) { return fields.find((field) => record[field] != null && record[field] !== "") || ""; }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function humanize(value) { return String(value || "").replace(/^NST_/, "").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

module.exports = { createAssetCatalog, resolveUnitAssetPreview: assetPreview };
