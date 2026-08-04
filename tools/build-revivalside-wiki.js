const fs = require("fs");
const path = require("path");
const { statTypeValue } = require("../modules/packet-codec");
const { listGameplayTableFiles, readGameplayTableRecords } = require("../modules/gameplay-jsons");

const ROOT_DIR = path.resolve(__dirname, "..");
const WIKI_DATA_DIR = path.join(ROOT_DIR, "wiki", "data");
const OUTPUT_PATH = path.join(WIKI_DATA_DIR, "assets.json");
const EXTRACTED_ASSET_ROOT = path.join(ROOT_DIR, "extracted-assets", "all");
const WIKI_ASSET_CACHE_ROOT = path.join(ROOT_DIR, ".cache", "wiki-assets", "all");
const PREBUILT_WIKI_ASSET_ROOT = path.join(ROOT_DIR, "prebuilt", "wiki-assets", "all");

const ID_FIELD_PRIORITY = [
  "ID",
  "IDX",
  "id",
  "m_UnitID",
  "m_ItemEquipID",
  "m_ItemMiscID",
  "m_PieceID",
  "m_MoldID",
  "m_SkinID",
  "m_ContractID",
  "customPickupId",
  "m_EquipSetID",
  "m_StatGroupID",
  "m_RewardGroupID",
  "m_RewardID",
  "m_MissionID",
  "m_EpisodeID",
  "m_DungeonID",
  "m_StageID",
  "m_ShopID",
  "m_TabID",
  "m_CategoryID",
  "m_EmoticonID",
];

function main() {
  fs.mkdirSync(WIKI_DATA_DIR, { recursive: true });

  const strings = loadStrings();
  const statInfo = buildStatInfo(strings);
  const imageIndex = buildImageIndex();
  const units = buildUnits(strings, imageIndex);
  const gears = buildGears(strings, imageIndex);
  const gearStats = buildGearStats(gears, statInfo);
  const gearSetBonuses = buildGearSetBonuses(strings);
  const items = buildItems(strings, imageIndex, units);
  const skins = buildSkins(strings, imageIndex, units);
  const contracts = buildContracts(strings, imageIndex);
  const idIndex = buildIdIndex(strings, imageIndex);
  const tables = { units, gears, gearStats, gearSetBonuses, items, skins, contracts, idIndex };
  const serializedTables = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, `${JSON.stringify(rows)}\n`])
  );
  const metadata = {
    title: "RevivalSide Wiki",
    source: {
      units: "server-data/units.json",
      gears: "LUA_ITEM_EQUIP_TEMPLET.json",
      gearStats: "LUA_ITEM_EQUIP_TEMPLET.json, LUA_ITEM_EQUIP_RANDOM_STAT.json, LUA_ITEM_EQUIP_POTENTIAL_OPTION.json",
      gearSetBonuses: "LUA_ITEM_EQUIP_SET_OPTION.json",
      items: "LUA_ITEM_MISC_TEMPLET.json, LUA_PIECE_TEMPLET.json, LUA_ITEM_MOLD_TEMPLET.json, LUA_ITEM_EMOTICON_TEMPLET.json, LUA_ITEM_BACKGROUND_PREFAB.json",
      skins: "LUA_SKIN_TEMPLET.json",
      contracts: "LUA_CONTRACT.json, LUA_CONTRACT_TAB_TABLE.json, LUA_CONTRACT_CUSTOM_PICKUP.json",
      idIndex: "All gameplay table records with a detected primary ID field",
      images: imageIndex.source,
    },
    counts: {
      units: units.length,
      gears: gears.length,
      gearStats: gearStats.length,
      gearSetBonuses: gearSetBonuses.length,
      items: items.length,
      skins: skins.length,
      contracts: contracts.length,
      idIndex: idIndex.length,
      images: imageIndex.count,
    },
    sections: Object.fromEntries(Object.keys(tables).map((name) => [name, `${name}.json`])),
  };
  const previous = readJsonIfPresent(OUTPUT_PATH);
  const previousMetadata = previous && { ...previous };
  if (previousMetadata) delete previousMetadata.generatedAt;
  const unchanged = previousMetadata && JSON.stringify(previousMetadata) === JSON.stringify(metadata)
    && Object.entries(serializedTables).every(([name, json]) => readTextIfPresent(path.join(WIKI_DATA_DIR, `${name}.json`)) === json);
  const payload = {
    title: metadata.title,
    generatedAt: unchanged ? previous.generatedAt : new Date().toISOString(),
    source: metadata.source,
    counts: metadata.counts,
    sections: metadata.sections,
  };

  for (const [name, json] of Object.entries(serializedTables)) {
    fs.writeFileSync(path.join(WIKI_DATA_DIR, `${name}.json`), json);
  }
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload)}\n`);
  console.log(`Wrote ${path.relative(ROOT_DIR, OUTPUT_PATH)}`);
  console.log(
    [
      `${units.length} units`,
      `${gears.length} gears`,
      `${gearStats.length} gear stat rows`,
      `${gearSetBonuses.length} set bonuses`,
      `${items.length} items`,
      `${skins.length} skins`,
      `${contracts.length} contracts`,
      `${idIndex.length} ID index rows`,
      `${imageIndex.count} PNGs indexed`,
    ].join(", ")
  );
}

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function readTextIfPresent(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return null; }
}

function buildUnits(strings, imageIndex) {
  const unitsPath = path.join(ROOT_DIR, "server-data", "units.json");
  const unitData = readJson(unitsPath);
  const records = Object.values(unitData.byId || {});
  return records
    .map((record) => {
      const stats = (((record || {})._stat || {}).m_StatData || {}).m_Stat || {};
      return {
        image: imageFor(imageIndex, record.m_InvenIconName, record.m_FaceCardName, `AB_INVEN_ICON_${record.m_UnitStrID}`),
        id: numberOrNull(record.m_UnitID),
        name: resolveString(strings, record.m_Name),
        strId: text(record.m_UnitStrID),
        grade: text(record.m_NKM_UNIT_GRADE),
        type: text(record.m_NKM_UNIT_TYPE),
        style: text(record.m_NKM_UNIT_STYLE_TYPE),
        role: text(record.m_NKM_UNIT_ROLE_TYPE),
        sourceType: text(record.m_NKM_UNIT_SOURCE_TYPE),
        baseUnitId: numberOrNull(record.m_BaseUnitID),
        cost: numberOrNull(((record || {})._stat || {}).m_RespawnCost),
        hp: numberOrNull(stats.NST_HP),
        atk: numberOrNull(stats.NST_ATK),
        def: numberOrNull(stats.NST_DEF),
        air: Boolean(record.m_bAirUnit),
        monster: Boolean(record.m_bMonster),
        contractable: Boolean(record.m_bContractable),
        sourceTable: text(record._sourceTable),
      };
    })
    .filter((record) => Number.isInteger(record.id) && record.id > 0)
    .sort((a, b) => a.id - b.id);
}

function buildGears(strings, imageIndex) {
  const records = readRecords("ab_script_item_templet", "LUA_ITEM_EQUIP_TEMPLET.json");
  return records
    .map((record) => {
      const mainStatType = text(record.STAT_TYPE_1);
      return {
        image: imageFor(imageIndex, record.m_ItemEquipIconName, `AB_INVEN_ICON_${record.m_ItemEquipIconName}`, `AB_INVEN_ICON_${record.m_ItemEquipStrID}`),
        id: numberOrNull(record.m_ItemEquipID),
        name: resolveString(strings, record.m_ItemEquipName),
        strId: text(record.m_ItemEquipStrID),
        tier: numberOrNull(record.m_NKM_ITEM_TIER),
        grade: text(record.m_NKM_ITEM_GRADE),
        position: text(record.m_ItemEquipPosition),
        style: text(record.m_EquipUnitStyleType),
        mainStatType,
        mainStatTypeId: statTypeValue(mainStatType),
        mainValue: numberOrNull(record.STAT_VALUE_1),
        mainLevelValue: numberOrNull(record.STAT_LEVELUP_VALUE_1),
        statGroup1: numberOrNull(record.m_StatGroupID),
        statGroup2: numberOrNull(record.m_StatGroupID_2),
        potentialGroup1: numberOrNull(record.m_PotentialOptionGroupID),
        potentialGroup2: numberOrNull(record.m_SubPotentialOptionGroupID),
        setGroup: text(record.m_SetGroup),
        maxEnchantLevel: numberOrNull(record.m_MaxEnchantLevel),
        relic: Boolean(record.m_bRelic),
        icon: text(record.m_ItemEquipIconName),
      };
    })
    .filter((record) => Number.isInteger(record.id) && record.id > 0)
    .sort((a, b) => a.id - b.id);
}

function buildGearStats(gears, statInfo) {
  const randomUsage = buildGearGroupUsage(gears, [
    ["m_StatGroupID", "statGroup1", "Sub 1"],
    ["m_StatGroupID_2", "statGroup2", "Sub 2"],
  ]);
  const potentialUsage = buildGearGroupUsage(gears, [
    ["m_PotentialOptionGroupID", "potentialGroup1", "Primary potential"],
    ["m_SubPotentialOptionGroupID", "potentialGroup2", "Secondary potential"],
  ]);

  const rows = [];
  rows.push(...buildMainStatRows(gears, statInfo));
  rows.push(...buildRandomSubstatRows(randomUsage, statInfo));
  rows.push(...buildPotentialStatRows(potentialUsage, statInfo));

  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return (Number(a.statTypeId) - Number(b.statTypeId)) || compareId(a.groupId, b.groupId) || compareId(a.optionKey, b.optionKey) || String(a.id).localeCompare(String(b.id));
  });
}

function buildMainStatRows(gears, statInfo) {
  const groups = new Map();
  for (const gear of gears) {
    if (!gear.mainStatType) continue;
    const key = [
      gear.mainStatType,
      gear.position,
      gear.tier,
      gear.grade,
      gear.mainValue,
      gear.mainLevelValue,
      gear.maxEnchantLevel,
    ].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        statType: gear.mainStatType,
        position: gear.position,
        tier: gear.tier,
        grade: gear.grade,
        baseValue: gear.mainValue,
        levelValue: gear.mainLevelValue,
        maxEnchantLevel: gear.maxEnchantLevel,
        gears: [],
      });
    }
    groups.get(key).gears.push(gear);
  }

  return Array.from(groups.values()).map((group) => {
    const statTypeId = statTypeValue(group.statType);
    const meta = statMeta(statInfo, group.statType);
    const maxValue = addNumbers(group.baseValue, multiplyNumber(group.levelValue, group.maxEnchantLevel));
    const midValue = addNumbers(group.baseValue, multiplyNumber(group.levelValue, Math.floor(Number(group.maxEnchantLevel || 0) / 2)));
    const valueSummary = `Base ${formatNumber(group.baseValue)} | +${group.maxEnchantLevel || 0} ${formatNumber(maxValue)} | +/level ${formatNumber(group.levelValue)}`;
    return {
      id: `main:${statTypeId}:${group.position}:${group.tier}:${group.grade}:${idNumber(group.baseValue)}:${idNumber(group.levelValue)}:${group.maxEnchantLevel || 0}`,
      kind: "Main Stat",
      source: "Main stat template",
      sourceTable: "LUA_ITEM_EQUIP_TEMPLET.json",
      groupId: null,
      optionKey: null,
      slot: "Main",
      position: group.position,
      tier: group.tier,
      grade: group.grade,
      statTypeId,
      statType: group.statType,
      statName: meta.name,
      statCategory: meta.category,
      statDisplay: formatStatDisplay(meta, group.statType, statTypeId),
      value0: formatNumber(group.baseValue),
      value50: formatNumber(midValue),
      value100: formatNumber(maxValue),
      valueSummary,
      rawMin: formatNumber(group.baseValue),
      rawMax: formatNumber(maxValue),
      levelValue: formatNumber(group.levelValue),
      maxEnchantLevel: group.maxEnchantLevel,
      socket1: "",
      socket2: "",
      socket3: "",
      socketSummary: "",
      precisionWeightId: null,
      gearCount: group.gears.length,
      gearScope: formatGearScope(group.position, group.tier, group.grade),
      gearExamples: gearExamples(group.gears),
    };
  });
}

function buildRandomSubstatRows(randomUsage, statInfo) {
  return readRecords("ab_script", "LUA_ITEM_EQUIP_RANDOM_STAT.json")
    .map((record, index) => {
      const statType = normalizePotentialStatType(text(record.m_StatType), record);
      const groupId = numberOrNull(record.m_StatGroupID);
      const minValue = numberOrNull(firstPresent(record.m_MinStatValue, record.m_MinStatRate, record.m_MinStat));
      const maxValue = numberOrNull(firstPresent(record.m_MaxStatValue, record.m_MaxStatRate, record.m_MaxStat));
      const usage = randomUsage.get(Number(groupId));
      const details = usageDetails(usage);
      const meta = statMeta(statInfo, statType);
      const value0 = formatNumber(calcPrecisionValue(statType, minValue, maxValue, 0, "truncate"));
      const value50 = formatNumber(calcPrecisionValue(statType, minValue, maxValue, 50, "truncate"));
      const value100 = formatNumber(calcPrecisionValue(statType, minValue, maxValue, 100, "truncate"));
      return {
        id: `sub:${groupId || 0}:${statTypeValue(statType)}:${index}`,
        kind: "Tuning Substat",
        source: "Random substat group",
        sourceTable: "LUA_ITEM_EQUIP_RANDOM_STAT.json",
        groupId,
        optionKey: null,
        slot: details.slot || "Unused",
        position: details.position,
        tier: details.tier,
        grade: details.grade,
        statTypeId: statTypeValue(statType),
        statType,
        statName: meta.name,
        statCategory: meta.category,
        statDisplay: formatStatDisplay(meta, statType, statTypeValue(statType)),
        value0,
        value50,
        value100,
        valueSummary: `P0 ${value0} | P50 ${value50} | P100 ${value100}`,
        rawMin: formatNumber(minValue),
        rawMax: formatNumber(maxValue),
        levelValue: "",
        maxEnchantLevel: null,
        socket1: "",
        socket2: "",
        socket3: "",
        socketSummary: "",
        precisionWeightId: null,
        gearCount: details.gearCount,
        gearScope: formatGearScope(details.position, details.tier, details.grade),
        gearExamples: details.gearExamples,
      };
    })
    .filter((record) => record.statType);
}

function buildPotentialStatRows(potentialUsage, statInfo) {
  return readRecords("ab_script", "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json")
    .map((record, index) => {
      const statType = normalizePotentialStatType(text(record.Socket1_StatType), record);
      const groupId = numberOrNull(record.m_PotentialOptionGroupID);
      const optionKey = numberOrNull(record.OptionKey);
      const usage = potentialUsage.get(Number(groupId));
      const details = usageDetails(usage);
      const meta = statMeta(statInfo, statType);
      const socket1 = potentialSocketRange(record, statType, 1);
      const socket2 = potentialSocketRange(record, statType, 2);
      const socket3 = potentialSocketRange(record, statType, 3);
      const precisionWeightId = numberOrNull(record.PrecisionWeightId);
      return {
        id: `potential:${groupId || 0}:${optionKey || 0}:${index}`,
        kind: "Relic Potential",
        source: "Potential option",
        sourceTable: "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json",
        groupId,
        optionKey,
        slot: details.slot || "Unused",
        position: details.position,
        tier: details.tier,
        grade: details.grade,
        statTypeId: statTypeValue(statType),
        statType,
        statName: meta.name,
        statCategory: meta.category,
        statDisplay: formatStatDisplay(meta, statType, statTypeValue(statType)),
        value0: "",
        value50: "",
        value100: "",
        valueSummary: precisionWeightId ? `Precision weight ${precisionWeightId}` : "",
        rawMin: "",
        rawMax: "",
        levelValue: "",
        maxEnchantLevel: null,
        socket1,
        socket2,
        socket3,
        socketSummary: formatSocketSummary(socket1, socket2, socket3),
        precisionWeightId,
        gearCount: details.gearCount,
        gearScope: formatGearScope(details.position, details.tier, details.grade),
        gearExamples: details.gearExamples,
      };
    })
    .filter((record) => record.statType);
}

function buildGearGroupUsage(gears, fields) {
  const usage = new Map();
  for (const gear of gears) {
    for (const [, field, slotName] of fields) {
      const groupId = Number(gear[field]);
      if (!Number.isInteger(groupId) || groupId <= 0) continue;
      if (!usage.has(groupId)) {
        usage.set(groupId, {
          slots: new Set(),
          positions: new Set(),
          tiers: new Set(),
          grades: new Set(),
          gears: new Map(),
        });
      }
      const entry = usage.get(groupId);
      entry.slots.add(slotName);
      if (gear.position) entry.positions.add(gear.position);
      if (gear.tier != null) entry.tiers.add(gear.tier);
      if (gear.grade) entry.grades.add(gear.grade);
      entry.gears.set(gear.id, gear);
    }
  }
  return usage;
}

function usageDetails(usage) {
  if (!usage) {
    return {
      slot: "",
      position: "",
      tier: "",
      grade: "",
      gearCount: 0,
      gearExamples: "",
    };
  }
  const gears = Array.from(usage.gears.values()).sort((a, b) => a.id - b.id);
  return {
    slot: summarizeSet(usage.slots),
    position: summarizeSet(usage.positions),
    tier: summarizeSet(usage.tiers),
    grade: summarizeSet(usage.grades),
    gearCount: gears.length,
    gearExamples: gearExamples(gears),
  };
}

function gearExamples(gears) {
  const list = (Array.isArray(gears) ? gears : []).slice().sort((a, b) => a.id - b.id);
  const examples = list.slice(0, 4).map((gear) => `${gear.id} ${gear.name || gear.strId || ""}`.trim());
  if (list.length > examples.length) examples.push(`+${list.length - examples.length} more`);
  return examples.join("; ");
}

function formatStatDisplay(meta, statType, statTypeId) {
  const name = (meta && meta.name) || statType || "";
  return `${name} (${statType || ""}, ${statTypeId})`;
}

function formatGearScope(position, tier, grade) {
  const parts = [];
  if (position) parts.push(position);
  if (tier != null && tier !== "") parts.push(`T${tier}`);
  if (grade) parts.push(grade);
  return parts.join(" | ");
}

function formatSocketSummary(socket1, socket2, socket3) {
  return [
    socket1 ? `S1 ${socket1}` : "",
    socket2 ? `S2 ${socket2}` : "",
    socket3 ? `S3 ${socket3}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

function summarizeSet(values) {
  const list = Array.from(values || []).filter((value) => value != null && value !== "").sort(compareId);
  if (list.length <= 4) return list.join(", ");
  return `${list.slice(0, 4).join(", ")} +${list.length - 4}`;
}

function buildGearSetBonuses(strings) {
  const records = readRecords("ab_script_item_templet", "LUA_ITEM_EQUIP_SET_OPTION.json");
  return records
    .map((record) => {
      const effects = [];
      for (let index = 1; index <= 4; index += 1) {
        const statType = text(record[`m_StatType_${index}`]);
        if (!statType) continue;
        const value = numberOrNull(record[`m_StatValue_${index}`] != null ? record[`m_StatValue_${index}`] : record[`m_StatRate_${index}`]);
        effects.push({ statType, statTypeId: statTypeValue(statType), value });
      }
      return {
        id: numberOrNull(record.m_EquipSetID),
        name: resolveString(strings, record.m_EquipSetName),
        strId: text(record.m_EquipSetStrID),
        parts: numberOrNull(record.m_EquipSetPart),
        effect: effects.map((entry) => `${entry.statType} ${formatNumber(entry.value)}`).join(", "),
        statType: effects.map((entry) => entry.statType).join(", "),
        icon: text(record.m_EquipSetIcon),
      };
    })
    .filter((record) => Number.isInteger(record.id) && record.id > 0)
    .sort((a, b) => a.id - b.id);
}

function buildItems(strings, imageIndex, units) {
  const unitNames = new Map(units.map((unit) => [unit.id, unit.name]));
  const miscItems = readRecords("ab_script_item_templet", "LUA_ITEM_MISC_TEMPLET.json").map((record) => ({
    image: imageFor(imageIndex, record.m_ItemMiscIconName, `AB_INVEN_ICON_${record.m_ItemMiscIconName}`, record.m_ItemMiscStrID),
    id: numberOrNull(record.m_ItemMiscID),
    category: "Misc Item",
    name: resolveString(strings, record.m_ItemMiscName),
    strId: text(record.m_ItemMiscStrID),
    type: text(record.m_ItemMiscType),
    grade: text(record.m_NKM_ITEM_GRADE),
    rewardGroupId: numberOrNull(record.m_RewardGroupID),
    relatedId: null,
    icon: text(record.m_ItemMiscIconName),
    sourceTable: "LUA_ITEM_MISC_TEMPLET.json",
  }));

  const pieces = readRecords("ab_script_item_templet", "LUA_PIECE_TEMPLET.json").map((record) => {
    const unitId = numberOrNull(record.m_PieceGetUnitID);
    return {
      image: imageFor(imageIndex, record.m_PieceStrID, `AB_INVEN_ICON_${record.m_PieceStrID}`, `AB_INVEN_ICON_UNIT_PIECE_${unitId}`),
      id: numberOrNull(record.m_PieceID),
      category: "Unit Piece",
      name: unitNames.get(unitId) ? `${unitNames.get(unitId)} Piece` : `Unit Piece ${record.m_PieceID}`,
      strId: text(record.m_PieceStrID),
      type: "PIECE",
      grade: "",
      rewardGroupId: null,
      relatedId: unitId,
      icon: "",
      sourceTable: "LUA_PIECE_TEMPLET.json",
    };
  });

  const molds = readRecords("ab_script_item_templet", "LUA_ITEM_MOLD_TEMPLET.json").map((record) => ({
    image: imageFor(imageIndex, record.m_MoldIconName, `AB_INVEN_ICON_${record.m_MoldIconName}`, record.m_MoldStrID),
    id: numberOrNull(record.m_MoldID),
    category: "Mold",
    name: resolveString(strings, record.m_MoldName),
    strId: text(record.m_MoldStrID),
    type: text(record.m_ContentType || record.m_MoldTabID),
    grade: text(record.m_Grade),
    rewardGroupId: numberOrNull(record.m_RewardGroupID),
    relatedId: null,
    icon: text(record.m_MoldIconName),
    sourceTable: "LUA_ITEM_MOLD_TEMPLET.json",
  }));

  const emoticons = readRecords("ab_script_item_templet", "LUA_ITEM_EMOTICON_TEMPLET.json").map((record) => ({
    image: imageFor(imageIndex, record.m_EmoticonaIconName, `AB_UI_NKM_UI_EMOTICON_ICON_${record.m_EmoticonaIconName}`),
    id: numberOrNull(record.m_EmoticonID),
    category: "Emoticon",
    name: resolveString(strings, record.m_EmoticonName),
    strId: text(record.m_EmoticonStrID),
    type: text(record.m_EmoticonType),
    grade: text(record.m_EmoticonGrade),
    rewardGroupId: null,
    relatedId: null,
    icon: text(record.m_EmoticonaIconName),
    sourceTable: "LUA_ITEM_EMOTICON_TEMPLET.json",
  }));

  const backgrounds = readRecords("ab_script_item_templet", "LUA_ITEM_BACKGROUND_PREFAB.json").map((record) => ({
    image: imageFor(imageIndex, record.m_Background_Prefab, record.m_ItemMiscStrID),
    id: numberOrNull(record.m_ItemMiscID),
    category: "Lobby Background",
    name: text(record.m_Background_Prefab) || text(record.m_ItemMiscStrID),
    strId: text(record.m_ItemMiscStrID),
    type: "BACKGROUND",
    grade: "",
    rewardGroupId: null,
    relatedId: null,
    icon: text(record.m_Background_Prefab),
    sourceTable: "LUA_ITEM_BACKGROUND_PREFAB.json",
  }));

  return [...miscItems, ...pieces, ...molds, ...emoticons, ...backgrounds]
    .filter((record) => Number.isInteger(record.id) && record.id > 0)
    .sort((a, b) => (a.category.localeCompare(b.category) || a.id - b.id));
}

function buildSkins(strings, imageIndex, units) {
  const unitNames = new Map(units.map((unit) => [unit.id, unit.name]));
  return readRecords("ab_script", "LUA_SKIN_TEMPLET.json")
    .map((record) => {
      const unitId = numberOrNull(record.m_SkinEquipUnitID);
      return {
        image: imageFor(imageIndex, record.m_InvenIconName, record.m_FaceCardName, record.m_SpineIllustName, `AB_INVEN_ICON_${record.m_SkinStrID}`),
        id: numberOrNull(record.m_SkinID),
        name: resolveString(strings, record.m_Title) || text(record.m_SkinStrID),
        strId: text(record.m_SkinStrID),
        unitId,
        unitName: unitNames.get(unitId) || "",
        grade: text(record.m_SkinGrade),
        limited: Boolean(record.m_bLimited),
        collab: Boolean(record.m_Collabo),
        cubism: Boolean(record.m_bCubismIllust),
        icon: text(record.m_InvenIconName),
      };
    })
    .filter((record) => Number.isInteger(record.id) && record.id > 0)
    .sort((a, b) => a.id - b.id);
}

function buildContracts(strings, imageIndex) {
  const baseById = new Map();
  for (const record of readRecords("ab_script", "LUA_CONTRACT.json")) {
    const contractId = numberOrNull(record.m_ContractID);
    if (contractId) baseById.set(contractId, record);
  }

  const tabs = readRecords("ab_script", "LUA_CONTRACT_TAB_TABLE.json").map((record) => {
    const base = baseById.get(numberOrNull(record.m_ContractID)) || {};
    return {
      image: imageFor(imageIndex, record.m_MainBannerFileName, record.m_Image, `AB_${record.m_MainBannerFileName}`),
      id: numberOrNull(record.m_ContractID),
      category: "Contract",
      name: resolveString(strings, record.m_ContractName) || text(record.m_ContractStrID),
      strId: text(record.m_ContractStrID),
      type: text(record.m_NKM_UNIT_TYPE || base.m_NKM_UNIT_TYPE),
      poolId: text(record.m_UnitPoolID || base.m_UnitPoolID),
      randomGradeId: text(record.m_RandomGradeID || base.m_RandomGradeID),
      banner: text(record.m_MainBannerFileName),
      sourceTable: "LUA_CONTRACT_TAB_TABLE.json",
    };
  });

  const custom = readRecords("ab_script", "LUA_CONTRACT_CUSTOM_PICKUP.json").map((record) => ({
    image: imageFor(imageIndex, record.m_MainBannerFileName, record.m_Image, `AB_${record.m_MainBannerFileName}`),
    id: numberOrNull(record.customPickupId),
    category: "Custom Pickup",
    name: resolveString(strings, record.m_ContractName) || text(record.m_ContractStrID),
    strId: text(record.m_ContractStrID),
    type: text(record.m_ContractType),
    poolId: text(record.m_UnitPoolID),
    randomGradeId: text(record.m_RandomGradeID),
    banner: text(record.m_MainBannerFileName),
    sourceTable: "LUA_CONTRACT_CUSTOM_PICKUP.json",
  }));

  return [...tabs, ...custom]
    .filter((record) => Number.isInteger(record.id) && record.id > 0)
    .sort((a, b) => (a.category.localeCompare(b.category) || a.id - b.id));
}

function buildIdIndex(strings, imageIndex) {
  const rows = [];
  for (const file of listGameplayTableFiles({ rootDir: ROOT_DIR })) {
    const rel = file.relativePath.replace(/\\/g, "/");
    if (rel.includes("ab_script_string_table/") || rel.includes("ab_script_cutscene/")) continue;
    const records = readRecords(file.directory, file.fileName);
    if (!records.length) continue;
    const table = file.fileName;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const idField = findPrimaryIdField(record);
      if (!idField) continue;
      const id = idValue(record[idField]);
      if (id == null || id === "") continue;
      const nameKey = firstMatchingValue(record, /(?:name|title)$/i);
      const strId = firstMatchingValue(record, /(?:strid|str_id|code)$/i);
      rows.push({
        image: imageFor(imageIndex, ...imageCandidates(record)),
        id,
        idField,
        table,
        name: resolveString(strings, nameKey) || text(nameKey),
        strId: text(strId),
        type: idTypeSummary(record),
        source: rel,
      });
    }
  }
  return rows.sort((a, b) => a.table.localeCompare(b.table) || compareId(a.id, b.id));
}

function buildStatInfo(strings) {
  const info = new Map();
  for (const record of readRecords("ab_script", "LUA_STAT_INFO_TEMPLET.json")) {
    const statType = text(record.Stat_ID);
    if (!statType || info.has(statType)) continue;
    info.set(statType, {
      name: resolveString(strings, record.Stat_Name) || statType,
      category: resolveString(strings, record.Stat_Category_Name) || text(record.Category_Type),
      categoryType: text(record.Category_Type),
      description: resolveString(strings, record.Stat_Desc),
    });
  }
  return info;
}

function statMeta(statInfo, statType) {
  const meta = statInfo.get(statType) || {};
  return {
    name: meta.name || statType || "",
    category: meta.category || meta.categoryType || "",
  };
}

function normalizePotentialStatType(statType, record) {
  const normalized = text(statType);
  if (!normalized) return "";
  if (
    record &&
    (record.Socket1_MinStatRate != null ||
      record.Socket1_MaxStatRate != null ||
      record.m_MinStatRate != null ||
      record.m_MaxStatRate != null)
  ) {
    return factorStatType(normalized) || normalized;
  }
  return normalized;
}

function factorStatType(statType) {
  return {
    NST_HP: "NST_HP_FACTOR",
    NST_ATK: "NST_ATK_FACTOR",
    NST_DEF: "NST_DEF_FACTOR",
    NST_CRITICAL: "NST_CRITICAL_FACTOR",
    NST_HIT: "NST_HIT_FACTOR",
    NST_EVADE: "NST_EVADE_FACTOR",
  }[statType] || "";
}

function potentialSocketRange(record, statType, socketNumber) {
  const minValue = numberOrNull(firstPresent(record[`Socket${socketNumber}_MinStat`], record[`Socket${socketNumber}_MinStatRate`]));
  const maxValue = numberOrNull(firstPresent(record[`Socket${socketNumber}_MaxStat`], record[`Socket${socketNumber}_MaxStatRate`]));
  if (minValue == null && maxValue == null) return "";
  const precision0 = calcPrecisionValue(statType, minValue, maxValue, 0, "round");
  const precision100 = calcPrecisionValue(statType, minValue, maxValue, 100, "round");
  return `${formatNumber(precision0)} -> ${formatNumber(precision100)}`;
}

function calcPrecisionValue(statType, minValue, maxValue, precision, percentMode = "truncate") {
  const min = Number(minValue);
  const max = Number(maxValue);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  if (!Number.isFinite(min)) return max;
  if (!Number.isFinite(max)) return min;
  const ratio = Math.max(0, Math.min(100, Number(precision) || 0)) / 100;
  const interpolated = max < 0 && min < 0 ? (min - max) * ratio + max : (max - min) * ratio + min;
  if (isFractionalStat(statType, min, max)) {
    const scaled = interpolated * 10000;
    const normalized = percentMode === "round" ? Math.round(scaled) / 10000 : Math.trunc(scaled) / 10000;
    return normalized;
  }
  return Math.trunc(interpolated);
}

function isFractionalStat(statType, minValue, maxValue) {
  const id = statTypeValue(statType);
  if (id >= 10000) return true;
  if (String(statType || "").includes("RATE") || String(statType || "").includes("FACTOR")) return true;
  return Math.abs(Number(minValue) || 0) < 1 && Math.abs(Number(maxValue) || 0) < 1;
}

function firstPresent(...values) {
  return values.find((value) => value != null && value !== "");
}

function multiplyNumber(value, multiplier) {
  const left = Number(value);
  const right = Number(multiplier);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return left * right;
}

function addNumbers(...values) {
  let result = 0;
  let found = false;
  for (const value of values) {
    const number = Number(value);
    if (!Number.isFinite(number)) continue;
    result += number;
    found = true;
  }
  return found ? result : null;
}

function idNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(number).replace(/[^0-9.-]/g, "_");
}

function loadStrings() {
  const records = readRecords("ab_script_string_table", "LUA_STRING_ENG.json");
  const strings = new Map();
  for (const record of records) {
    if (!Array.isArray(record) || record.length < 2) continue;
    if (!strings.has(String(record[0]))) strings.set(String(record[0]), record[1]);
  }
  return strings;
}

function readRecords(folderName, fileName) {
  return readGameplayTableRecords(folderName, fileName, {
    rootDir: ROOT_DIR,
    logLabel: "wiki",
    optional: true,
    allowLuacWhenPackaged: true,
  });
}

function buildImageIndex() {
  const byName = new Map();
  let count = 0;
  const root = resolveImageAssetRoot();
  if (!root) return { byName, count, root: "", source: "installed CounterSide encrypted assets (cache pending)" };
  for (const filePath of listFiles(root, (file) => file.toLowerCase().endsWith(".png"))) {
    count += 1;
    const name = normalizeAssetKey(path.basename(filePath, ".png"));
    if (!byName.has(name)) byName.set(name, toAssetUrl(filePath, root));
  }
  return { byName, count, root, source: describeImageAssetRoot(root) };
}

function imageFor(imageIndex, ...candidates) {
  if (!imageIndex || !imageIndex.byName) return "";
  for (const candidate of candidates.flat().filter(Boolean)) {
    for (const key of expandedImageKeys(candidate)) {
      const found = imageIndex.byName.get(key);
      if (found) return found;
    }
  }
  return "";
}

function expandedImageKeys(value) {
  const raw = text(value);
  if (!raw) return [];
  const clean = raw.split("@").pop().replace(/\.[a-z0-9]+$/i, "");
  const keys = [
    clean,
    `AB_${clean}`,
    `AB_INVEN_ICON_${clean}`,
    `AB_INVEN_ICON_IQI_EQUIP_${clean}`,
    `AB_INVEN_ICON_ITEM_${clean}`,
    `AB_UI_NKM_UI_EMOTICON_ICON_${clean}`,
    `AB_INVEN_ICON_${clean.replace(/^ICON_/, "")}`,
    clean.replace(/^AB_/, ""),
  ];
  return Array.from(new Set(keys.map(normalizeAssetKey).filter(Boolean)));
}

function normalizeAssetKey(value) {
  return text(value)
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function resolveImageAssetRoot() {
  const configured = parsePathList(process.env.CS_WIKI_ASSET_ROOT || process.env.CS_WIKI_ASSETS_DIR || "");
  for (const candidate of [...configured, WIKI_ASSET_CACHE_ROOT, EXTRACTED_ASSET_ROOT, PREBUILT_WIKI_ASSET_ROOT]) {
    const root = path.resolve(ROOT_DIR, candidate);
    if (fs.existsSync(root)) return root;
  }
  return "";
}

function describeImageAssetRoot(root) {
  const relative = path.relative(ROOT_DIR, root).replace(/\\/g, "/");
  if (path.normalize(root).toLowerCase() === path.normalize(WIKI_ASSET_CACHE_ROOT).toLowerCase()) {
    return `${relative}/**/*.png (derived from installed CounterSide encrypted assets)`;
  }
  return `${relative}/**/*.png`;
}

function toAssetUrl(filePath, root) {
  const rel = path.relative(root, filePath).replace(/\\/g, "/");
  return `/asset-png/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

function parsePathList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function imageCandidates(record) {
  const candidates = [];
  for (const [key, value] of Object.entries(record)) {
    if (!/(icon|image|banner|face|illust|prefab|sprite|file)$/i.test(key)) continue;
    if (typeof value === "string") candidates.push(value);
  }
  return candidates.slice(0, 8);
}

function findPrimaryIdField(record) {
  for (const field of ID_FIELD_PRIORITY) {
    if (record[field] != null && idValue(record[field]) != null) return field;
  }
  return Object.keys(record).find((field) => /(?:^id$|^idx$|id$|_id$)/i.test(field) && idValue(record[field]) != null) || "";
}

function idValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function firstMatchingValue(record, pattern) {
  const key = Object.keys(record).find((field) => pattern.test(field) && text(record[field]));
  return key ? record[key] : "";
}

function idTypeSummary(record) {
  return Object.keys(record)
    .filter((key) => /(type|grade|category|position|tab|style)$/i.test(key))
    .map((key) => text(record[key]))
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
}

function listFiles(root, predicate) {
  const results = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (!predicate || predicate(fullPath)) results.push(fullPath);
    }
  }
  return results;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveString(strings, key) {
  const raw = text(key);
  if (!raw) return "";
  if (strings.has(raw)) return normalizeString(strings.get(raw));
  if (!raw.includes("@@")) return raw;
  return raw
    .split("@@")
    .map((part) => normalizeString(strings.get(part) || part))
    .filter(Boolean)
    .join(" ");
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "object") return "";
  return String(value).trim();
}

function normalizeString(value) {
  if (value == null || typeof value === "object") return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function minNumber(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxNumber(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return Math.max(a, b);
}

function compareId(a, b) {
  const numberA = Number(a);
  const numberB = Number(b);
  if (Number.isFinite(numberA) && Number.isFinite(numberB)) return numberA - numberB;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function formatNumber(value) {
  return value == null ? "" : Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

main();
