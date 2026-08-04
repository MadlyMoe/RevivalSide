const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { extractTableRecords, findGameplayTableEntry, readGameplayTable } = require("../gameplay-jsons");
const { createModProjectStore } = require("../mod-projects");
const { transformCounterSideBundleHeader } = require("../unity-bundle-compiler");

const UNIT_DIRECTORY = "ab_script_unit_data";
const TEMPLATE_DIRECTORY = "ab_script_unit_data_unit_templet";
const COMMON_DIRECTORY = "ab_script";
const UNIT_TABLE_SPECS = [
  { base: "LUA_UNIT_TEMPLET_BASE", stat: "LUA_UNIT_STAT_TEMPLET", category: "PLAYABLE" },
  { base: "LUA_UNIT_TEMPLET_BASE2", stat: "LUA_UNIT_STAT_TEMPLET2", category: "ENEMY" },
];
const UNIT_BASE_TABLES = new Set(UNIT_TABLE_SPECS.map((spec) => spec.base));
const ASSET_FIELDS = ["m_SpriteBundleName", "m_SpriteName", "m_FaceCardName", "m_SpineIllustName", "m_SpineSDName", "m_MiniMapFaceName", "m_InvenIconName"];
const SKILL_FIELDS = ["m_SkillStrID1", "m_SkillStrID2", "m_SkillStrID3", "m_SkillStrID4"];
const RESULT_TEXT_FIELDS = ["m_ResultWinDesc", "m_ResultWinLifeDesc", "m_ResultLoseDesc", "m_ResultLoseLifeDesc", "m_GetUnitDesc", "m_SuperDesc"];
const NEGOTIATION_TEXT_FIELDS = ["m_NegoStanby", "m_NegoOffered", "m_NegoGood", "m_NegoBad", "m_NegoFury", "m_NegoThink", "m_NegoGreatSuccess", "m_NegoSuccess", "m_NegoFail", "m_NegoGreatGreatSuccess"];
const VOICE_ACTOR_FIELDS = ["Actor_Name_VKOR", "Actor_Name_VJPN", "Actor_Name_VCHN"];
const STRING_CORRECTIONS = { SI_UNIT_SKILL_NAME_ESPR_CA_SHADOW_HYPER: "Palingenesis" };
const SPINE_ROLES = {
  illustration: { bundleField: "m_SpineIllustName", assetField: "m_SpineIllustName", prefix: "AB_UNIT_ILLUST_", kind: "graphic" },
  sd: { bundleField: "m_SpineSDName", assetField: "m_SpineSDName", prefix: "AB_UNIT_SD_SPINE_", kind: "graphic" },
  battle: { bundleField: "m_SpriteBundleName", assetField: "m_SpriteName", prefix: "AB_UNIT_GAME_SPINE_", kind: "battle" },
};

function createModUnitMaker(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const env = options.env || process.env;
  const store = options.modStore || createModProjectStore({ rootDir, modsRoot: options.modsRoot || env.CS_MODS_ROOT });
  const clientRoot = resolveClientRoot(rootDir, env, options.clientRoot);
  const assetRoot = path.resolve(options.assetRoot || env.CS_ASSET_VIEWER_ROOT || path.join(rootDir, "extracted-assets", "all"));
  const patchSpineBundle = options.patchSpineBundle || ((input) => runSpineBundlePatcher(rootDir, env, input));
  const extractVoiceBundle = options.extractVoiceBundle || ((input) => runVoiceBundleExtractor(rootDir, env, input));
  const tableCache = new Map();
  const tableEntryCache = new Map();
  const wikiUnits = indexUnits(readJson(path.join(rootDir, "wiki", "data", "units.json")) || []);
  let strings;

  function unitStrings() {
    if (!strings) strings = (readJson(path.join(rootDir, "server-data", "strings.json")) || {}).ENG?.strings || {};
    return strings;
  }

  function summarizeUnit(record, displayName = "") {
    return unitSummary(record, wikiUnits, unitStrings, displayName);
  }

  function baseEnv() {
    const value = { ...env };
    delete value.CS_MOD_TABLES_DIR;
    return value;
  }

  function catalog(query = "", unitType = "") {
    const records = UNIT_TABLE_SPECS.flatMap((spec) => recordsFor(UNIT_DIRECTORY, `${spec.base}.json`).map((record) => ({ record, spec })));
    const needle = String(query || "").trim().toLowerCase();
    const normalizedNeedle = needle.replace(/[^a-z0-9]+/g, " ").trim();
    const allUnits = records.filter(({ record }) => record && Number.isSafeInteger(record.m_UnitID) && record.m_UnitStrID);
    const summarized = allUnits.map(({ record, spec }) => ({ record, spec, summary: { ...summarizeUnit(record), sourceTable: spec.base, sourceCategory: spec.category } }));
    const selectedType = String(unitType || "").trim();
    const units = summarized
      .filter(({ record, spec }) => {
        if (!selectedType) return true;
        if (selectedType === "ENEMY") return spec.category === "ENEMY";
        if (selectedType === "PLAYABLE") return spec.category === "PLAYABLE" && record.m_NKM_UNIT_TYPE === "NUT_NORMAL";
        return record.m_NKM_UNIT_TYPE === selectedType;
      })
      .filter(({ record, summary }) => {
        const text = [record.m_UnitID, record.m_UnitStrID, record.m_Name, summary.displayName].join(" ").toLowerCase();
        return !needle || text.includes(needle) || text.replace(/[^a-z0-9]+/g, " ").includes(normalizedNeedle);
      })
      .map(({ summary }) => summary);
    return {
      units,
      total: allUnits.length,
      counts: {
        PLAYABLE: allUnits.filter(({ record, spec }) => spec.category === "PLAYABLE" && record.m_NKM_UNIT_TYPE === "NUT_NORMAL").length,
        ENEMY: allUnits.filter(({ spec }) => spec.category === "ENEMY").length,
        ...Object.fromEntries(uniqueFieldValues(allUnits.map(({ record }) => record), "m_NKM_UNIT_TYPE").map((type) => [type, allUnits.filter(({ record }) => record.m_NKM_UNIT_TYPE === type).length])),
      },
      nextUnitId: nextUnitId(),
      options: {
        unitTypes: ["PLAYABLE", "ENEMY", "NUT_SHIP", "NUT_SYSTEM"],
        rarities: uniqueFieldValues(allUnits.map(({ record }) => record), "m_NKM_UNIT_GRADE"),
        roles: uniqueFieldValues(allUnits.map(({ record }) => record), "m_NKM_UNIT_ROLE_TYPE"),
        sources: uniqueFieldValues(allUnits.map(({ record }) => record), "m_NKM_UNIT_SOURCE_TYPE"),
        styles: uniqueFieldValues(allUnits.map(({ record }) => record), "m_NKM_UNIT_STYLE_TYPE"),
        targetTypes: uniqueFieldValues(allUnits.map(({ record }) => record), "m_NKM_FIND_TARGET_TYPE"),
        teams: uniqueFieldValues(allUnits.map(({ record }) => record), "m_TeamUp"),
      },
    };
  }

  function inspect(unitStrId) {
    const baseGroups = UNIT_TABLE_SPECS.map((spec) => ({ spec, records: recordsFor(UNIT_DIRECTORY, `${spec.base}.json`) }));
    const group = baseGroups.find(({ records }) => records.some((record) => record && record.m_UnitStrID === unitStrId));
    const base = group?.records.find((record) => record && record.m_UnitStrID === unitStrId);
    if (!base) throw httpError(404, `Unit was not found: ${unitStrId}`);
    const stat = recordsFor(UNIT_DIRECTORY, `${group.spec.stat}.json`).find((record) => record && record.m_UnitStrID === unitStrId);
    if (!stat) throw httpError(422, `${unitStrId} has no stat record.`);
    const skillIds = SKILL_FIELDS.map((field) => base[field]).filter(Boolean);
    const skillRows = recordsFor(UNIT_DIRECTORY, "LUA_UNIT_SKILL_TEMPLET.json").filter((record) => record && skillIds.includes(record.m_UnitSkillStrID));
    const templateFile = `${base.m_UnitTempletFileName || unitStrId}.json`;
    const template = readBaseTable(TEMPLATE_DIRECTORY, templateFile);
    if (!template) throw httpError(422, `${unitStrId} battle template ${templateFile} could not be decoded.`);
    const skins = recordsFor(COMMON_DIRECTORY, "LUA_SKIN_TEMPLET.json").filter((record) => record && record.m_SkinEquipUnitID === base.m_UnitID);
    const collectionRow = recordsFor(COMMON_DIRECTORY, "LUA_COLLECTION_UNIT_TEMPLET.json").find((record) => record && record.m_UnitID === base.m_UnitID);
    const profileRow = recordsFor(COMMON_DIRECTORY, "LUA_COLLECTION_V2_EMPLOYEE.json").find((record) => record && record.UnitID === base.m_UnitID);
    const summary = { ...summarizeUnit(base), sourceTable: group.spec.base, sourceCategory: group.spec.category };
    const localized = unitStrings();
    return {
      summary,
      base: cloneJson(base),
      stat: cloneJson(stat),
      skills: cloneJson(skillRows),
      skins: cloneJson(skins),
      collection: describeCollection(collectionRow),
      profile: describeProfile(profileRow),
      details: describeDetails(base, skins),
      voices: Array.from(collectStrings(template.root, (value) => value.startsWith("VOICE_"))).sort(),
      voiceGroups: collectVoiceGroups(template.root, base.m_UnitStrID, skins),
      assets: Object.fromEntries(ASSET_FIELDS.filter((field) => base[field]).map((field) => [field, base[field]])),
      skillSlots: SKILL_FIELDS.map((field, index) => {
        const skillId = base[field];
        const rows = skillRows.filter((record) => record.m_UnitSkillStrID === skillId).sort((left, right) => Number(left.m_Level) - Number(right.m_Level));
        const first = rows[0] || {};
        return skillId ? {
          field,
          slot: index + 1,
          skillId,
          type: first.m_NKM_SKILL_TYPE,
          icon: first.m_UnitSkillIcon || "",
          name: resolveString(localized, first.m_SkillName) || skillLabel(first.m_NKM_SKILL_TYPE, index),
          nameId: first.m_SkillName || "",
          rows: rows.map((row) => ({
            ...cloneJson(row),
            description: resolveString(localized, row.m_SkillDesc),
            descriptionId: row.m_SkillDesc || "",
          })),
        } : null;
      }).filter(Boolean),
      sourceTables: { base: group.spec.base, stat: group.spec.stat },
      nextUnitId: nextUnitId(),
      suggestedUnitStrId: `${unitStrId}_2`,
      suggestedName: `${summary.displayName} 2`,
    };
  }

  function projects() {
    return {
      projects: store.listProjects().map((summary) => {
        const project = store.readProject(summary.id);
        const units = projectUnitPatches(project).map((patch) => ({
          id: patch.value.m_UnitID,
          strId: patch.value.m_UnitStrID,
          displayName: project.strings[patch.value.m_Name] || summarizeUnit(patch.value).displayName,
          sourceUnitStrId: patch.source.value,
          rarity: patch.value.m_NKM_UNIT_GRADE,
          role: patch.value.m_NKM_UNIT_ROLE_TYPE,
        })).sort((left, right) => left.id - right.id);
        return { ...summary, unitCount: units.length, units };
      }),
    };
  }

  function inspectProjectUnit(projectId, unitStrId) {
    const project = store.readProject(String(projectId || ""));
    const basePatch = projectUnitPatches(project).find((patch) => patch.value.m_UnitStrID === unitStrId);
    if (!basePatch) throw httpError(404, `Editable Unit:Side unit was not found in ${project.manifest.id}: ${unitStrId}`);
    const source = inspect(basePatch.source.value);
    const base = cloneJson(basePatch.value);
    const targetTables = unitTableSpecForBase(basePatch.table.tableName);
    const statPatch = project.patches.find((patch) => patch.table.tableName === targetTables.stat && patch.value?.m_UnitStrID === unitStrId);
    if (!statPatch) throw httpError(422, `${unitStrId} has no editable stat patch.`);
    const skillSlots = source.skillSlots.map((sourceSkill) => {
      const skillId = base[sourceSkill.field] || sourceSkill.skillId;
      const rows = project.patches.filter((patch) => patch.table.tableName === "LUA_UNIT_SKILL_TEMPLET" && patch.value?.m_UnitSkillStrID === skillId).map((patch) => patch.value).sort((left, right) => Number(left.m_Level) - Number(right.m_Level));
      const currentRows = rows.length ? rows : sourceSkill.rows;
      const first = currentRows[0] || {};
      return {
        ...sourceSkill,
        sourceSkillId: sourceSkill.skillId,
        skillId,
        type: first.m_NKM_SKILL_TYPE || sourceSkill.type,
        icon: first.m_UnitSkillIcon || sourceSkill.icon,
        customName: project.strings[first.m_SkillName] || "",
        rows: currentRows.map((row) => {
          const original = sourceSkill.rows.find((item) => item.m_Level === row.m_Level) || {};
          return { ...cloneJson(row), sourceDescription: original.description || original.descriptionId || "", description: project.strings[row.m_SkillDesc] || "" };
        }),
      };
    });
    const skins = project.patches.filter((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET" && patch.value?.m_SkinEquipUnitID === base.m_UnitID);
    const sourceTemplate = readBaseTable(TEMPLATE_DIRECTORY, `${source.base.m_UnitTempletFileName || source.base.m_UnitStrID}.json`);
    const currentTemplate = project.tables.find((table) => table.table.tableName === unitStrId);
    const voice = deriveVoiceChanges(sourceTemplate.root, currentTemplate?.compiled?.root || sourceTemplate.root, source.voiceGroups, source.voices);
    const collectionPatch = project.patches.find((patch) => patch.table.tableName === "LUA_COLLECTION_UNIT_TEMPLET" && patch.value?.m_UnitStrID === unitStrId);
    const profilePatch = project.patches.find((patch) => patch.table.tableName === "LUA_COLLECTION_V2_EMPLOYEE" && patch.value?.UnitID === base.m_UnitID);
    return {
      ...source,
      edit: {
        project: { id: project.manifest.id, name: project.manifest.name },
        base,
        stat: cloneJson(statPatch.value),
        displayName: project.strings[base.m_Name] || summarizeUnit(base).displayName,
        assets: Object.fromEntries(ASSET_FIELDS.filter((field) => base[field]).map((field) => [field, base[field]])),
        skillSlots,
        cloneSkills: skillSlots.some((skill) => skill.skillId !== skill.sourceSkillId),
        cloneSkins: skins.length > 0,
        skinIds: skins.map((patch) => Number(patch.source?.value)).filter(Number.isSafeInteger),
        voiceGroups: source.voiceGroups.map((group) => ({ ...group, lines: group.lines.map((line) => ({ source: line, value: voice.voiceMap[line] || line })).concat((voice.voiceAdditions[group.key] || []).map((line) => ({ source: "", value: line }))) })),
        collection: describeCollection(collectionPatch?.value || source.collection.raw, project.strings),
        profile: describeProfile(profilePatch?.value || source.profile.raw, project.strings),
        details: describeDetails(base, skins.map((patch) => patch.value), project, source.base),
      },
    };
  }

  function create(input = {}) {
    const source = inspect(String(input.sourceUnitStrId || ""));
    const projectId = String(input.projectId || "");
    let project;
    try { project = store.readProject(projectId); }
    catch (err) {
      if (err.statusCode !== 404) throw err;
      project = store.createProject({ id: projectId, name: input.projectName || input.displayName || projectId, author: input.author, description: input.description });
    }
    const targetId = Number(input.unitId);
    const targetStrId = validateUnitStrId(input.unitStrId);
    const displayName = String(input.displayName || targetStrId).trim();
    if (!Number.isSafeInteger(targetId) || targetId <= 0) throw httpError(400, "Unit ID must be a positive integer.");
    assertUnitAvailable(targetId, targetStrId, projectId);

    const targetTables = source.sourceTables.base === UNIT_TABLE_SPECS[1].base ? UNIT_TABLE_SPECS[0] : unitTableSpecForBase(source.sourceTables.base);
    const base = { ...source.base, ...(plainObject(input.base) ? input.base : {}) };
    base.m_UnitID = targetId;
    base.m_UnitStrID = targetStrId;
    base.m_BaseUnitID = targetId;
    base.m_UnitTempletFileName = targetStrId;
    base.m_Name = `MODSIDE_UNIT_NAME_${targetId}`;
    if (source.sourceTables.base === UNIT_TABLE_SPECS[1].base) makeSquadUsable(base);
    applyCloneFallbacks(source.base, base);
    if (input.rarity) base.m_NKM_UNIT_GRADE = String(input.rarity);
    if (Array.isArray(input.unitTags)) base.m_lstUnitTag = uniqueStrings(input.unitTags);
    if (Array.isArray(input.runtimeTags)) base.m_hsUnitTag = uniqueStrings(input.runtimeTags);
    if (plainObject(input.assets)) for (const field of ASSET_FIELDS) if (input.assets[field] != null) base[field] = String(input.assets[field]);
    const detailChanges = plainObject(input.details) ? input.details : {};
    writeProfileText(projectId, detailChanges, "title", base, "m_Title", source.base, `MODSIDE_UNIT_TITLE_${targetId}`);
    writeProfileText(projectId, detailChanges, "description", base, "m_UnitDesc", source.base, `MODSIDE_UNIT_DESC_${targetId}`);

    const skillTable = tableEntry(UNIT_DIRECTORY, "LUA_UNIT_SKILL_TEMPLET.json");
    const allSkillRows = recordsFor(UNIT_DIRECTORY, "LUA_UNIT_SKILL_TEMPLET.json");
    let nextSkillId = nextPatchedNumber("LUA_UNIT_SKILL_TEMPLET", "m_UnitSkillID", allSkillRows);
    let nextSkillIndex = nextPatchedNumber("LUA_UNIT_SKILL_TEMPLET", "IDX", allSkillRows);
    const skillMap = {};
    for (let slot = 0; slot < SKILL_FIELDS.length; slot += 1) {
      const field = SKILL_FIELDS[slot];
      const sourceSkill = source.base[field];
      if (!sourceSkill) continue;
      const selected = Array.isArray(input.skills) && input.skills[slot] ? String(input.skills[slot]) : sourceSkill;
      if (input.cloneSkills === true) {
        const customSkill = sourceSkill.startsWith(source.base.m_UnitStrID) ? sourceSkill.replace(source.base.m_UnitStrID, targetStrId) : `${targetStrId}_SKILL_${slot + 1}`;
        const rows = source.skills.filter((record) => record.m_UnitSkillStrID === sourceSkill);
        if (!rows.length) throw httpError(422, `Source skill rows were not found: ${sourceSkill}`);
        const rawOverride = plainObject(input.skillOverrides) && plainObject(input.skillOverrides[sourceSkill]) ? input.skillOverrides[sourceSkill] : {};
        const structuredOverride = plainObject(rawOverride.common) || plainObject(rawOverride.levels);
        const commonOverride = structuredOverride && plainObject(rawOverride.common) ? rawOverride.common : structuredOverride ? {} : rawOverride;
        const levelOverrides = structuredOverride && plainObject(rawOverride.levels) ? rawOverride.levels : {};
        const text = plainObject(input.skillText) && plainObject(input.skillText[sourceSkill]) ? input.skillText[sourceSkill] : {};
        const customName = String(text.name || "").trim();
        const customNameId = customName ? `MODSIDE_UNIT_SKILL_NAME_${targetId}_${slot + 1}` : "";
        if (customNameId) store.writeString(projectId, customNameId, customName);
        for (const row of rows) {
          const levelOverride = plainObject(levelOverrides[row.m_Level]) ? levelOverrides[row.m_Level] : {};
          const descriptions = plainObject(text.descriptions) ? text.descriptions : {};
          const customDescription = String(descriptions[row.m_Level] || "").trim();
          const customDescriptionId = customDescription ? `MODSIDE_UNIT_SKILL_DESC_${targetId}_${slot + 1}_${row.m_Level}` : "";
          if (customDescriptionId) store.writeString(projectId, customDescriptionId, customDescription);
          store.writePatch(projectId, {
            table: skillTable,
            key: { field: "IDX", value: nextSkillIndex },
            source: { field: "IDX", value: row.IDX },
            value: {
              ...cloneJson(row),
              ...commonOverride,
              ...levelOverride,
              ...(customNameId ? { m_SkillName: customNameId } : {}),
              ...(customDescriptionId ? { m_SkillDesc: customDescriptionId } : {}),
              IDX: nextSkillIndex++,
              m_UnitSkillID: nextSkillId,
              m_UnitSkillStrID: customSkill,
            },
          });
        }
        nextSkillId += 1;
        base[field] = customSkill;
        skillMap[sourceSkill] = customSkill;
      } else {
        base[field] = selected;
        skillMap[sourceSkill] = selected;
      }
    }

    const skinTable = tableEntry(COMMON_DIRECTORY, "LUA_SKIN_TEMPLET.json");
    const allSkins = recordsFor(COMMON_DIRECTORY, "LUA_SKIN_TEMPLET.json");
    let nextSkinId = nextPatchedNumber("LUA_SKIN_TEMPLET", "m_SkinID", allSkins);
    const skinMap = {};
    const requestedSkinIds = Array.isArray(input.skinIds) ? new Set(input.skinIds.map(Number)) : null;
    if (requestedSkinIds && Array.from(requestedSkinIds).some((skinId) => !source.skins.some((skin) => skin.m_SkinID === skinId))) throw httpError(400, "Selected skin does not belong to the source unit.");
    if (input.cloneSkins !== false) {
      for (const sourceSkin of source.skins.filter((skin) => !requestedSkinIds || requestedSkinIds.has(skin.m_SkinID))) {
        const skinId = nextSkinId++;
        skinMap[sourceSkin.m_SkinID] = skinId;
        const override = plainObject(input.skinOverrides) && plainObject(input.skinOverrides[sourceSkin.m_SkinID]) ? input.skinOverrides[sourceSkin.m_SkinID] : {};
        const skin = { ...sourceSkin, ...override, m_SkinID: skinId, m_SkinEquipUnitID: targetId, m_SkinStrID: `${sourceSkin.m_SkinStrID}_MOD_${targetId}` };
        const skinText = Array.isArray(detailChanges.skins) ? detailChanges.skins.find((item) => Number(item?.sourceSkinId) === sourceSkin.m_SkinID) || {} : {};
        writeProfileText(projectId, skinText, "title", skin, "m_Title", sourceSkin, `MODSIDE_UNIT_SKIN_TITLE_${targetId}_${sourceSkin.m_SkinID}`);
        writeProfileText(projectId, skinText, "description", skin, "m_SkinDesc", sourceSkin, `MODSIDE_UNIT_SKIN_DESC_${targetId}_${sourceSkin.m_SkinID}`);
        store.writePatch(projectId, { table: skinTable, key: { field: "m_SkinID", value: skinId }, source: { field: "m_SkinID", value: sourceSkin.m_SkinID }, value: skin });
      }
    }

    const templateFile = `${source.base.m_UnitTempletFileName || source.base.m_UnitStrID}.json`;
    const template = readBaseTable(TEMPLATE_DIRECTORY, templateFile);
    const warnings = [];
    let battleRoot = normalizeDecodedValue(cloneJson(template.root), warnings);
    const voiceMap = normalizeVoiceMap(input.voiceMap, source.voices);
    const voiceAdditions = normalizeVoiceAdditions(input.voiceAdditions, source.voiceGroups, source.voices);
    battleRoot = appendVoiceLines(battleRoot, voiceAdditions);
    battleRoot = replaceExactValues(battleRoot, { ...skillMap, ...voiceMap, ...skinMap });
    store.writeFullTable(projectId, {
      table: { directory: TEMPLATE_DIRECTORY, fileName: `${targetStrId}.json`, tableName: targetStrId, format: "json" },
      compiled: { source: "revivalside-unit-maker", rootName: template.rootName || "NKMUnitTemplet", root: battleRoot },
    });

    const statOverride = plainObject(input.stat) ? input.stat : {};
    const stat = {
      ...source.stat,
      ...statOverride,
      m_StatData: {
        ...(plainObject(source.stat.m_StatData) ? source.stat.m_StatData : {}),
        ...(plainObject(statOverride.m_StatData) ? statOverride.m_StatData : {}),
        m_Stat: {
          ...(plainObject(source.stat.m_StatData && source.stat.m_StatData.m_Stat) ? source.stat.m_StatData.m_Stat : {}),
          ...(plainObject(statOverride.m_StatData && statOverride.m_StatData.m_Stat) ? statOverride.m_StatData.m_Stat : {}),
        },
        m_StatPerLevel: {
          ...(plainObject(source.stat.m_StatData && source.stat.m_StatData.m_StatPerLevel) ? source.stat.m_StatData.m_StatPerLevel : {}),
          ...(plainObject(statOverride.m_StatData && statOverride.m_StatData.m_StatPerLevel) ? statOverride.m_StatData.m_StatPerLevel : {}),
        },
      },
      m_UnitStrID: targetStrId,
    };
    store.writePatch(projectId, { table: tableEntry(UNIT_DIRECTORY, `${targetTables.base}.json`), key: { field: "m_UnitStrID", value: targetStrId }, source: { field: "m_UnitStrID", value: source.base.m_UnitStrID }, value: base });
    store.writePatch(projectId, { table: tableEntry(UNIT_DIRECTORY, `${targetTables.stat}.json`), key: { field: "m_UnitStrID", value: targetStrId }, source: { field: "m_UnitStrID", value: source.base.m_UnitStrID }, value: stat });
    cloneCollectionRows(projectId, source.base, base, input);
    const registrations = cloneRelatedRows(projectId, source.base, base, skillMap, skinMap, detailChanges);
    store.writeString(projectId, base.m_Name, displayName);
    ensureSharedVoiceBundles(projectId, source, base);

    return {
      project: store.readProject(projectId),
      unit: summarizeUnit(base, displayName),
      sourceUnit: summarizeUnit(source.base),
      clonedSkills: input.cloneSkills === true,
      clonedSkins: Object.keys(skinMap).length,
      registrations,
      warnings,
    };
  }

  function update(input = {}) {
    const projectId = String(input.projectId || "");
    const targetStrId = validateUnitStrId(input.unitStrId);
    const targetId = Number(input.unitId);
    const project = store.readProject(projectId);
    const basePatch = projectUnitPatches(project).find((patch) => patch.value.m_UnitStrID === targetStrId);
    if (!basePatch) throw httpError(404, `Editable Unit:Side unit was not found in ${projectId}: ${targetStrId}`);
    if (targetId !== basePatch.value.m_UnitID) throw httpError(400, "An existing unit's numeric and string IDs cannot be changed. Add a new unit instead.");
    const source = inspect(basePatch.source.value);
    const targetTables = unitTableSpecForBase(basePatch.table.tableName);
    const statPatch = project.patches.find((patch) => patch.table.tableName === targetTables.stat && patch.value?.m_UnitStrID === targetStrId);
    if (!statPatch) throw httpError(422, `${targetStrId} has no editable stat patch.`);
    const base = { ...basePatch.value, ...(plainObject(input.base) ? input.base : {}) };
    base.m_UnitID = targetId;
    base.m_UnitStrID = targetStrId;
    base.m_BaseUnitID = targetId;
    base.m_UnitTempletFileName = targetStrId;
    base.m_Name = basePatch.value.m_Name;
    applyCloneFallbacks(source.base, base);
    if (input.rarity) base.m_NKM_UNIT_GRADE = String(input.rarity);
    if (Array.isArray(input.unitTags)) base.m_lstUnitTag = uniqueStrings(input.unitTags);
    if (Array.isArray(input.runtimeTags)) base.m_hsUnitTag = uniqueStrings(input.runtimeTags);
    if (plainObject(input.assets)) for (const field of ASSET_FIELDS) if (input.assets[field] != null) base[field] = String(input.assets[field]);
    const detailChanges = plainObject(input.details) ? input.details : {};
    writeProfileText(projectId, detailChanges, "title", base, "m_Title", source.base, `MODSIDE_UNIT_TITLE_${targetId}`);
    writeProfileText(projectId, detailChanges, "description", base, "m_UnitDesc", source.base, `MODSIDE_UNIT_DESC_${targetId}`);

    const clonedSkills = SKILL_FIELDS.some((field) => source.base[field] && basePatch.value[field] !== source.base[field]);
    if (clonedSkills && input.cloneSkills !== true) throw httpError(400, "Cloned skills cannot be changed back to shared skills while editing an existing unit.");
    const skillTable = tableEntry(UNIT_DIRECTORY, "LUA_UNIT_SKILL_TEMPLET.json");
    const allSkillRows = recordsFor(UNIT_DIRECTORY, "LUA_UNIT_SKILL_TEMPLET.json");
    let nextSkillId = nextPatchedNumber("LUA_UNIT_SKILL_TEMPLET", "m_UnitSkillID", allSkillRows);
    let nextSkillIndex = nextPatchedNumber("LUA_UNIT_SKILL_TEMPLET", "IDX", allSkillRows);
    const skillMap = {};
    for (let slot = 0; slot < SKILL_FIELDS.length; slot += 1) {
      const field = SKILL_FIELDS[slot];
      const sourceSkillId = source.base[field];
      let skillId = basePatch.value[field];
      if (!sourceSkillId || !skillId) continue;
      const rawOverride = plainObject(input.skillOverrides) && plainObject(input.skillOverrides[sourceSkillId]) ? input.skillOverrides[sourceSkillId] : {};
      const structuredOverride = plainObject(rawOverride.common) || plainObject(rawOverride.levels);
      const commonOverride = structuredOverride && plainObject(rawOverride.common) ? rawOverride.common : structuredOverride ? {} : rawOverride;
      const levelOverrides = structuredOverride && plainObject(rawOverride.levels) ? rawOverride.levels : {};
      const text = plainObject(input.skillText) && plainObject(input.skillText[sourceSkillId]) ? input.skillText[sourceSkillId] : {};
      const customName = String(text.name || "").trim();
      const customNameId = `MODSIDE_UNIT_SKILL_NAME_${targetId}_${slot + 1}`;
      if (skillId === sourceSkillId && input.cloneSkills === true) {
        skillId = sourceSkillId.startsWith(source.base.m_UnitStrID) ? sourceSkillId.replace(source.base.m_UnitStrID, targetStrId) : `${targetStrId}_SKILL_${slot + 1}`;
        if (customName) store.writeString(projectId, customNameId, customName);
        for (const sourceRow of source.skills.filter((row) => row.m_UnitSkillStrID === sourceSkillId)) {
          const customDescription = String(plainObject(text.descriptions) ? text.descriptions[sourceRow.m_Level] || "" : "").trim();
          const customDescriptionId = `MODSIDE_UNIT_SKILL_DESC_${targetId}_${slot + 1}_${sourceRow.m_Level}`;
          if (customDescription) store.writeString(projectId, customDescriptionId, customDescription);
          store.writePatch(projectId, {
            table: skillTable,
            key: { field: "IDX", value: nextSkillIndex },
            source: { field: "IDX", value: sourceRow.IDX },
            value: {
              ...cloneJson(sourceRow),
              ...commonOverride,
              ...(plainObject(levelOverrides[sourceRow.m_Level]) ? levelOverrides[sourceRow.m_Level] : {}),
              ...(customName ? { m_SkillName: customNameId } : {}),
              ...(customDescription ? { m_SkillDesc: customDescriptionId } : {}),
              IDX: nextSkillIndex++,
              m_UnitSkillID: nextSkillId,
              m_UnitSkillStrID: skillId,
            },
          });
        }
        nextSkillId += 1;
        skillMap[sourceSkillId] = skillId;
        base[field] = skillId;
        continue;
      }
      skillMap[sourceSkillId] = skillId;
      base[field] = skillId;
      if (skillId === sourceSkillId) continue;
      const patches = project.patches.filter((patch) => patch.table.tableName === "LUA_UNIT_SKILL_TEMPLET" && patch.value?.m_UnitSkillStrID === skillId);
      if (customName) store.writeString(projectId, customNameId, customName); else store.removeString(projectId, customNameId);
      for (const patch of patches) {
        const sourceRow = source.skills.find((row) => row.m_UnitSkillStrID === sourceSkillId && row.m_Level === patch.value.m_Level) || {};
        const customDescription = String(plainObject(text.descriptions) ? text.descriptions[patch.value.m_Level] || "" : "").trim();
        const customDescriptionId = `MODSIDE_UNIT_SKILL_DESC_${targetId}_${slot + 1}_${patch.value.m_Level}`;
        if (customDescription) store.writeString(projectId, customDescriptionId, customDescription); else store.removeString(projectId, customDescriptionId);
        store.writePatch(projectId, {
          table: patch.table,
          key: patch.key,
          source: patch.source,
          value: {
            ...patch.value,
            ...commonOverride,
            ...(plainObject(levelOverrides[patch.value.m_Level]) ? levelOverrides[patch.value.m_Level] : {}),
            m_SkillName: customName ? customNameId : sourceRow.m_SkillName,
            m_SkillDesc: customDescription ? customDescriptionId : sourceRow.m_SkillDesc,
            IDX: patch.value.IDX,
            m_Level: patch.value.m_Level,
            m_UnitSkillID: patch.value.m_UnitSkillID,
            m_UnitSkillStrID: patch.value.m_UnitSkillStrID,
          },
        });
      }
    }
    for (const patch of project.patches.filter((entry) => entry.table.tableName === "LUA_REACTOR_SKILL_TEMPLET" && entry.value?.ReactorID === targetId)) {
      store.writePatch(projectId, { table: patch.table, key: patch.key, source: patch.source, value: { ...patch.value, BaseSkillStrID: skillMap[patch.value.BaseSkillStrID] || patch.value.BaseSkillStrID, UnitSkillIconStrID: skillMap[patch.value.UnitSkillIconStrID] || patch.value.UnitSkillIconStrID } });
    }

    const skinPatches = project.patches.filter((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET" && patch.value?.m_SkinEquipUnitID === targetId);
    const selectedSkinIds = new Set((Array.isArray(input.skinIds) ? input.skinIds : []).map(Number));
    const existingSkinIds = new Set(skinPatches.map((patch) => Number(patch.source?.value)).filter(Number.isSafeInteger));
    if ((input.cloneSkins === true) !== (skinPatches.length > 0) || selectedSkinIds.size !== existingSkinIds.size || Array.from(selectedSkinIds).some((id) => !existingSkinIds.has(id))) throw httpError(400, "Cloned skin selection cannot be changed while editing an existing unit.");
    const skinMap = {};
    for (const patch of skinPatches) {
      const sourceSkinId = Number(patch.source.value);
      const override = plainObject(input.skinOverrides) && plainObject(input.skinOverrides[sourceSkinId]) ? input.skinOverrides[sourceSkinId] : {};
      skinMap[sourceSkinId] = patch.value.m_SkinID;
      const sourceSkin = source.skins.find((skin) => skin.m_SkinID === sourceSkinId) || {};
      const skin = { ...patch.value, ...override, m_SkinID: patch.value.m_SkinID, m_SkinStrID: patch.value.m_SkinStrID, m_SkinEquipUnitID: targetId };
      const skinText = Array.isArray(detailChanges.skins) ? detailChanges.skins.find((item) => Number(item?.sourceSkinId) === sourceSkinId) || {} : {};
      writeProfileText(projectId, skinText, "title", skin, "m_Title", sourceSkin, `MODSIDE_UNIT_SKIN_TITLE_${targetId}_${sourceSkinId}`);
      writeProfileText(projectId, skinText, "description", skin, "m_SkinDesc", sourceSkin, `MODSIDE_UNIT_SKIN_DESC_${targetId}_${sourceSkinId}`);
      store.writePatch(projectId, { table: patch.table, key: patch.key, source: patch.source, value: skin });
    }

    const template = readBaseTable(TEMPLATE_DIRECTORY, `${source.base.m_UnitTempletFileName || source.base.m_UnitStrID}.json`);
    const warnings = [];
    let battleRoot = normalizeDecodedValue(cloneJson(template.root), warnings);
    const voiceMap = normalizeVoiceMap(input.voiceMap, source.voices);
    const voiceAdditions = normalizeVoiceAdditions(input.voiceAdditions, source.voiceGroups, source.voices);
    battleRoot = appendVoiceLines(battleRoot, voiceAdditions);
    battleRoot = replaceExactValues(battleRoot, { ...skillMap, ...voiceMap, ...skinMap });
    store.writeFullTable(projectId, {
      table: { directory: TEMPLATE_DIRECTORY, fileName: `${targetStrId}.json`, tableName: targetStrId, format: "json" },
      compiled: { source: "revivalside-unit-maker", rootName: template.rootName || "NKMUnitTemplet", root: battleRoot },
    });

    const statOverride = plainObject(input.stat) ? input.stat : {};
    const stat = {
      ...statPatch.value,
      ...statOverride,
      m_StatData: {
        ...(plainObject(statPatch.value.m_StatData) ? statPatch.value.m_StatData : {}),
        ...(plainObject(statOverride.m_StatData) ? statOverride.m_StatData : {}),
        m_Stat: { ...(statPatch.value.m_StatData?.m_Stat || {}), ...(statOverride.m_StatData?.m_Stat || {}) },
        m_StatPerLevel: { ...(statPatch.value.m_StatData?.m_StatPerLevel || {}), ...(statOverride.m_StatData?.m_StatPerLevel || {}) },
      },
      m_UnitStrID: targetStrId,
    };
    store.writePatch(projectId, { table: basePatch.table, key: basePatch.key, source: basePatch.source, value: base });
    store.writePatch(projectId, { table: statPatch.table, key: statPatch.key, source: statPatch.source, value: stat });
    cloneCollectionRows(projectId, source.base, base, input);
    const registrations = cloneRelatedRows(projectId, source.base, base, skillMap, skinMap, detailChanges);
    const displayName = String(input.displayName || project.strings[base.m_Name] || targetStrId).trim();
    store.writeString(projectId, base.m_Name, displayName);
    ensureSharedVoiceBundles(projectId, source, base);
    return { project: store.readProject(projectId), unit: summarizeUnit(base, displayName), sourceUnit: source.summary, clonedSkills: input.cloneSkills === true, clonedSkins: skinPatches.length, registrations, warnings, updated: true };
  }

  function describeCollection(record, customStrings = {}) {
    return { raw: cloneJson(record || {}), intro: profileString(record?.m_UnitIntro, customStrings) };
  }

  function describeProfile(record, customStrings = {}) {
    const birth = String(record?.BirthValueStrID || "").match(/^SI_COLLECTION_PROFILE_VALUE_BIRTH@@SI_DATE_MONTH_(\d{1,2})@@(\d{1,2})$/);
    const height = String(record?.HeightValueStrID || "").match(/^SI_COLLECTION_PROFILE_VALUE_HEIGHT@@([0-9.]+)$/);
    return {
      raw: cloneJson(record || {}),
      biography: profileString(record?.ProfileValue_1, customStrings),
      teamTitle: profileString(record?.TeamConceptStrID, customStrings),
      teamName: profileString(record?.TeamUpStrID, customStrings),
      gender: profileString(record?.GenderValueStrID, customStrings),
      birthMonth: birth?.[1] || "",
      birthDay: birth?.[2] || "",
      height: height?.[1] || "",
      speciality: profileString(record?.SpecialityValueStrID, customStrings),
      likes: profileString(record?.LikeValueStrID, customStrings),
      dislikes: profileString(record?.DisLikeValueStrID, customStrings),
      combatLevel: profileString(record?.CombatLevelValue, customStrings),
      commandLevel: profileString(record?.CommandLevelValue, customStrings),
      crf: {
        maxPower: record?.CRFSubAmount_1 ?? "", resistance: record?.CRFSubAmount_2 ?? "", dependence: record?.CRFSubAmount_3 ?? "",
        reinforced: record?.CRFSubAmount_4 ?? "", control: record?.CRFSubAmount_5 ?? "",
      },
    };
  }

  function describeDetails(base, skins, project = null, sourceBase = base) {
    const stringsForProject = project?.strings || {};
    const targetId = base.m_UnitID;
    const sourceId = sourceBase.m_UnitID;
    const currentRows = (tableName, targetPredicate, sourcePredicate = targetPredicate) => {
      const patched = project?.patches.filter((patch) => patch.table.tableName === tableName && patch.value && targetPredicate(patch.value)).map((patch) => patch.value) || [];
      return patched.length ? patched : recordsFor(COMMON_DIRECTORY, `${tableName}.json`).filter(sourcePredicate);
    };
    const currentRow = (tableName, targetPredicate, sourcePredicate = targetPredicate) => currentRows(tableName, targetPredicate, sourcePredicate)[0] || null;
    const skinSourceByTarget = new Map((project?.patches || []).filter((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET" && patch.value?.m_SkinEquipUnitID === targetId).map((patch) => [Number(patch.value.m_SkinID), Number(patch.source?.value)]));
    const sourceSkinId = (skinId) => skinId ? skinSourceByTarget.get(Number(skinId)) || Number(skinId) : 0;
    const textFields = (row, fields) => Object.fromEntries(fields.map((field) => [field, profileString(row?.[field], stringsForProject)]));
    const team = currentRow("LUA_COLLECTION_TEAMUP_TEMPLET", (row) => row.m_UnitID === targetId, (row) => row.m_UnitID === sourceId);
    const voiceActor = currentRow("LUA_VOICE_ACTOR_NAME_TEMPLET_V2", (row) => row.VOICE_ACTOR_NAME_StrID === base.m_UnitStrID, (row) => row.VOICE_ACTOR_NAME_StrID === sourceBase.m_UnitStrID);
    const results = currentRows("LUA_DESC_TEMPLET", (row) => row.m_UnitID === targetId, (row) => row.m_UnitID === sourceId);
    const negotiations = currentRows("LUA_NEGOTIATE_SPEECH", (row) => row.m_UnitID === targetId, (row) => row.m_UnitID === sourceId);
    const reactor = currentRow("LUA_REACTOR_TEMPLET", (row) => row.ReactorID === targetId, (row) => row.ReactorID === sourceId);
    const reactorLevels = currentRows("LUA_REACTOR_SKILL_TEMPLET", (row) => row.ReactorID === targetId, (row) => row.ReactorID === sourceId);
    const targetAssociationIds = new Set([String(targetId), ...(skins || []).map((skin) => String(skin.m_SkinID))]);
    const sourceAssociationIds = new Set([String(sourceId), ...(project ? Array.from(skinSourceByTarget.values()) : (skins || []).map((skin) => Number(skin.m_SkinID))).map(String)]);
    const includesAnyId = (row, ids) => [row.UnitID1, row.UnitID2].some((values) => Array.isArray(values) && values.some((value) => ids.has(String(value))));
    const associations = currentRows("LUA_INTERACTION_UNIT_TEMPLET", (row) => includesAnyId(row, targetAssociationIds), (row) => includesAnyId(row, sourceAssociationIds));
    return {
      title: profileString(base.m_Title, stringsForProject),
      description: profileString(base.m_UnitDesc, stringsForProject),
      teamName: profileString(team?.m_TeamName, stringsForProject),
      voiceActors: { KOR: profileString(voiceActor?.Actor_Name_VKOR, stringsForProject), JPN: profileString(voiceActor?.Actor_Name_VJPN, stringsForProject), CHN: profileString(voiceActor?.Actor_Name_VCHN, stringsForProject) },
      skins: (skins || []).map((skin) => ({ sourceSkinId: sourceSkinId(skin.m_SkinID), skinId: skin.m_SkinID, strId: skin.m_SkinStrID, title: profileString(skin.m_Title, stringsForProject), description: profileString(skin.m_SkinDesc, stringsForProject), raw: cloneJson(skin) })),
      resultLines: results.map((row) => ({ sourceSkinId: sourceSkinId(row.m_SkinID), skinId: row.m_SkinID || 0, fields: textFields(row, RESULT_TEXT_FIELDS), raw: cloneJson(row) })),
      negotiationLines: negotiations.map((row) => ({ sourceSkinId: sourceSkinId(row.m_SkinID), skinId: row.m_SkinID || 0, fields: textFields(row, NEGOTIATION_TEXT_FIELDS), raw: cloneJson(row) })),
      reactor: reactor ? { name: profileString(reactor.ReactorName, stringsForProject), description: profileString(reactor.ReactorDesc, stringsForProject), raw: cloneJson(reactor), levels: reactorLevels.map((row) => ({ sourceIdx: Number(project?.patches.find((patch) => patch.table.tableName === "LUA_REACTOR_SKILL_TEMPLET" && patch.value?.IDX === row.IDX)?.source?.value) || row.IDX, idx: row.IDX, title: profileString(row.ReactorLevelTitle, stringsForProject), description: profileString(row.ReactorLevelDesc, stringsForProject), raw: cloneJson(row) })) } : null,
      associations: associations.map((row) => ({
        sourceActId: Number(project?.patches.find((patch) => patch.table.tableName === "LUA_INTERACTION_UNIT_TEMPLET" && patch.value?.UnitActID === row.UnitActID)?.source?.value) || row.UnitActID,
        actId: row.UnitActID, action1: row.UnitActStrID || "", action2: row.UnitActStrID2 || "", align: row.AlignUnit === true, range: row.ActRange ?? 400,
        type1: row.UnitType1 || "Unit", ids1: Array.isArray(row.UnitID1) ? row.UnitID1.map(String) : [], type2: row.UnitType2 || "Unit", ids2: Array.isArray(row.UnitID2) ? row.UnitID2.map(String) : [], raw: cloneJson(row),
      })),
      raw: { team: cloneJson(team || {}), voiceActor: cloneJson(voiceActor || {}) },
    };
  }

  function profileString(stringId, customStrings = {}) {
    const key = String(stringId || "").split("@@")[0];
    const value = Object.prototype.hasOwnProperty.call(customStrings, key) ? customStrings[key] : unitStrings()[key];
    if (typeof value !== "string" || value.includes("__unparsed_expr")) return "";
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").trim();
  }

  function writeProfileText(projectId, changes, inputField, value, recordField, source, stringId) {
    if (!Object.prototype.hasOwnProperty.call(changes, inputField)) return;
    const text = String(changes[inputField] || "").trim();
    if (text && text !== profileString(source[recordField])) {
      store.writeString(projectId, stringId, text);
      value[recordField] = stringId;
    } else {
      store.removeString(projectId, stringId);
      if (Object.prototype.hasOwnProperty.call(source, recordField)) value[recordField] = source[recordField];
      else delete value[recordField];
    }
  }

  function applyProfileMeasurements(changes, value, source) {
    if (Object.prototype.hasOwnProperty.call(changes, "birthMonth") || Object.prototype.hasOwnProperty.call(changes, "birthDay")) {
      const month = Number(changes.birthMonth);
      const day = Number(changes.birthDay);
      if (!String(changes.birthMonth || "").trim() && !String(changes.birthDay || "").trim()) value.BirthValueStrID = source.BirthValueStrID;
      else {
        const date = new Date(Date.UTC(2000, month - 1, day));
        if (!Number.isInteger(month) || !Number.isInteger(day) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw httpError(400, "Profile birthday must be a valid month and day.");
        value.BirthValueStrID = `SI_COLLECTION_PROFILE_VALUE_BIRTH@@SI_DATE_MONTH_${month}@@${day}`;
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, "height")) {
      const raw = String(changes.height || "").trim();
      const height = Number(raw);
      if (!raw) value.HeightValueStrID = source.HeightValueStrID;
      else {
        if (!Number.isFinite(height) || height <= 0 || height > 999) throw httpError(400, "Profile height must be between 0 and 999 cm.");
        value.HeightValueStrID = `SI_COLLECTION_PROFILE_VALUE_HEIGHT@@${height}`;
      }
    }
    if (plainObject(changes.crf)) for (const [field, recordField] of Object.entries({ maxPower: "CRFSubAmount_1", resistance: "CRFSubAmount_2", dependence: "CRFSubAmount_3", reinforced: "CRFSubAmount_4", control: "CRFSubAmount_5" })) {
      if (!Object.prototype.hasOwnProperty.call(changes.crf, field)) continue;
      const amount = Number(changes.crf[field]);
      if (!Number.isFinite(amount) || amount < 0 || amount > 9999) throw httpError(400, "CRF profile values must be between 0 and 9999.");
      value[recordField] = amount;
    }
  }

  function cloneCollectionRows(projectId, sourceBase, targetBase, input = {}) {
    const collectionTable = tableEntry(COMMON_DIRECTORY, "LUA_COLLECTION_UNIT_TEMPLET.json");
    const collectionRows = recordsFor(COMMON_DIRECTORY, "LUA_COLLECTION_UNIT_TEMPLET.json");
    const sourceCollection = collectionRows.find((record) => record && record.m_UnitID === sourceBase.m_UnitID);
    const collection = sourceCollection || (sourceBase.m_bMonster === true && targetBase.m_bMonster === false ? {
      m_UnitID: sourceBase.m_UnitID,
      m_UnitStrID: sourceBase.m_UnitStrID,
      m_NKM_UNIT_TYPE: targetBase.m_NKM_UNIT_TYPE,
      m_UnitIntro: sourceBase.m_UnitDesc || "SI_BLANK",
    } : null);
    if (collection) {
      const existing = findProjectPatch(projectId, "LUA_COLLECTION_UNIT_TEMPLET", "m_UnitStrID", targetBase.m_UnitStrID);
      const changes = plainObject(input.collection) ? input.collection : {};
      const value = {
        ...collection,
        ...(existing?.value || {}),
        ...(plainObject(changes.raw) ? changes.raw : {}),
        Idx: Number(existing?.value?.Idx) || nextPatchedNumber("LUA_COLLECTION_UNIT_TEMPLET", "Idx", collectionRows),
        m_UnitID: targetBase.m_UnitID,
        m_UnitStrID: targetBase.m_UnitStrID,
        m_NKM_UNIT_TYPE: targetBase.m_NKM_UNIT_TYPE,
      };
      writeProfileText(projectId, changes, "intro", value, "m_UnitIntro", collection, `MODSIDE_UNIT_COLLECTION_INTRO_${targetBase.m_UnitID}`);
      store.writePatch(projectId, { table: collectionTable, key: { field: "m_UnitStrID", value: targetBase.m_UnitStrID }, ...(sourceCollection ? { source: { field: "m_UnitStrID", value: sourceBase.m_UnitStrID } } : {}), value });
    }
    const profileTable = tableEntry(COMMON_DIRECTORY, "LUA_COLLECTION_V2_EMPLOYEE.json");
    const profileRows = recordsFor(COMMON_DIRECTORY, "LUA_COLLECTION_V2_EMPLOYEE.json");
    const sourceProfile = profileRows.find((record) => record && record.UnitID === sourceBase.m_UnitID);
    const profile = sourceProfile || (sourceBase.m_bMonster === true && targetBase.m_bMonster === false ? squadProfile(sourceBase, targetBase) : null);
    if (profile) {
      const existing = findProjectPatch(projectId, "LUA_COLLECTION_V2_EMPLOYEE", "UnitID", targetBase.m_UnitID);
      const changes = plainObject(input.profile) ? input.profile : {};
      const value = { ...profile, ...(existing?.value || {}), ...(plainObject(changes.raw) ? changes.raw : {}) };
      for (const [inputField, recordField, suffix] of [
        ["biography", "ProfileValue_1", "BIO"], ["teamTitle", "TeamConceptStrID", "TEAM_TITLE"], ["teamName", "TeamUpStrID", "TEAM_NAME"],
        ["gender", "GenderValueStrID", "GENDER"], ["speciality", "SpecialityValueStrID", "SPECIALITY"], ["likes", "LikeValueStrID", "LIKE"],
        ["dislikes", "DisLikeValueStrID", "DISLIKE"], ["combatLevel", "CombatLevelValue", "COMBAT_LEVEL"], ["commandLevel", "CommandLevelValue", "COMMAND_LEVEL"],
      ]) writeProfileText(projectId, changes, inputField, value, recordField, profile, `MODSIDE_UNIT_PROFILE_${suffix}_${targetBase.m_UnitID}`);
      applyProfileMeasurements(changes, value, profile);
      value.UnitID = targetBase.m_UnitID;
      value.OpenTag = targetBase.m_FirstOpenTag;
      value.NameValue = targetBase.m_Name;
      store.writePatch(projectId, { table: profileTable, key: { field: "UnitID", value: targetBase.m_UnitID }, ...(sourceProfile ? { source: { field: "UnitID", value: sourceBase.m_UnitID } } : {}), value });
    }
  }

  function cloneRelatedRows(projectId, sourceBase, targetBase, skillMap = {}, skinMap = {}, details = {}) {
    const counts = {};

    const teamRows = recordsFor(COMMON_DIRECTORY, "LUA_COLLECTION_TEAMUP_TEMPLET.json");
    const team = teamRows.find((record) => record && record.m_UnitID === sourceBase.m_UnitID);
    if (team) {
      const tableName = "LUA_COLLECTION_TEAMUP_TEMPLET";
      const existing = findProjectPatch(projectId, tableName, "m_UnitID", targetBase.m_UnitID);
      const value = {
        ...team,
        ...(existing?.value || {}),
        ...(plainObject(details.raw?.team) ? details.raw.team : {}),
        Idx: Number(existing?.value?.Idx) || nextPatchedNumber(tableName, "Idx", teamRows),
        m_UnitID: targetBase.m_UnitID,
        m_UnitStrID: targetBase.m_UnitStrID,
      };
      writeProfileText(projectId, details, "teamName", value, "m_TeamName", team, `MODSIDE_UNIT_TEAM_NAME_${targetBase.m_UnitID}`);
      store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${tableName}.json`), key: { field: "m_UnitID", value: targetBase.m_UnitID }, source: { field: "m_UnitID", value: sourceBase.m_UnitID }, value });
      counts[tableName] = 1;
    }

    const equipRows = recordsFor(COMMON_DIRECTORY, "LUA_UNIT_EQUIP_RECOMMEND.json");
    const equip = equipRows.find((record) => record && record.m_UnitID === sourceBase.m_UnitID);
    if (equip) {
      const tableName = "LUA_UNIT_EQUIP_RECOMMEND";
      const existing = findProjectPatch(projectId, tableName, "m_UnitID", targetBase.m_UnitID);
      store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${tableName}.json`), key: { field: "m_UnitID", value: targetBase.m_UnitID }, source: { field: "m_UnitID", value: sourceBase.m_UnitID }, value: { ...equip, ...(existing?.value || {}), ...(plainObject(details.raw?.equipment) ? details.raw.equipment : {}), m_UnitID: targetBase.m_UnitID } });
      counts[tableName] = 1;
    }

    for (const [tableName, keyField, sourceValue, targetValue, rawField] of [
      ["LUA_MONSTER_TAG_TEMPLET", "m_UnitID", sourceBase.m_UnitID, targetBase.m_UnitID, "monsterTags"],
      ["LUA_TACTICAL_COMMAND_TEMPLET", "m_UnitStrID", sourceBase.m_UnitStrID, targetBase.m_UnitStrID, "tacticalCommand"],
    ]) {
      const sourceRow = recordsFor(COMMON_DIRECTORY, `${tableName}.json`).find((row) => row && row[keyField] === sourceValue);
      if (!sourceRow) continue;
      const existing = findProjectPatch(projectId, tableName, keyField, targetValue);
      const value = { ...sourceRow, ...(existing?.value || {}), ...(plainObject(details.raw?.[rawField]) ? details.raw[rawField] : {}), [keyField]: targetValue };
      store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${tableName}.json`), key: { field: keyField, value: targetValue }, source: { field: keyField, value: sourceValue }, value });
      counts[tableName] = 1;
    }

    const voiceRows = recordsFor(COMMON_DIRECTORY, "LUA_VOICE_ACTOR_NAME_TEMPLET_V2.json");
    const voice = voiceRows.find((record) => record && record.VOICE_ACTOR_NAME_StrID === sourceBase.m_UnitStrID);
    if (voice) {
      const tableName = "LUA_VOICE_ACTOR_NAME_TEMPLET_V2";
      const existing = findProjectPatch(projectId, tableName, "VOICE_ACTOR_NAME_StrID", targetBase.m_UnitStrID);
      const value = { ...voice, ...(existing?.value || {}), ...(plainObject(details.raw?.voiceActor) ? details.raw.voiceActor : {}) };
      const actors = plainObject(details.voiceActors) ? details.voiceActors : {};
      VOICE_ACTOR_FIELDS.forEach((field) => writeProfileText(projectId, actors, field.replace("Actor_Name_V", ""), value, field, voice, `MODSIDE_UNIT_VOICE_ACTOR_${field.replace("Actor_Name_V", "")}_${targetBase.m_UnitID}`));
      value.VOICE_ACTOR_NAME_StrID = targetBase.m_UnitStrID;
      store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${tableName}.json`), key: { field: "VOICE_ACTOR_NAME_StrID", value: targetBase.m_UnitStrID }, source: { field: "VOICE_ACTOR_NAME_StrID", value: sourceBase.m_UnitStrID }, value });
      counts[tableName] = 1;
    }

    for (const [tableName, fields, inputField, prefix] of [
      ["LUA_DESC_TEMPLET", RESULT_TEXT_FIELDS, "resultLines", "RESULT"],
      ["LUA_NEGOTIATE_SPEECH", NEGOTIATION_TEXT_FIELDS, "negotiationLines", "NEGOTIATION"],
    ]) {
      for (const sourceRow of recordsFor(COMMON_DIRECTORY, `${tableName}.json`).filter((row) => row && row.m_UnitID === sourceBase.m_UnitID)) {
        const sourceSkinId = Number(sourceRow.m_SkinID) || 0;
        const targetSkinId = sourceSkinId ? Number(skinMap[sourceSkinId]) : 0;
        if (sourceSkinId && !targetSkinId) continue;
        const key = targetSkinId ? { field: "m_SkinID", value: targetSkinId } : { field: "m_UnitID", value: targetBase.m_UnitID };
        const existing = findProjectPatch(projectId, tableName, key.field, key.value);
        const change = Array.isArray(details[inputField]) ? details[inputField].find((item) => Number(item?.sourceSkinId) === sourceSkinId) || {} : {};
        const value = { ...sourceRow, ...(existing?.value || {}), ...(plainObject(change.raw) ? change.raw : {}), m_UnitID: targetBase.m_UnitID };
        if (targetSkinId) value.m_SkinID = targetSkinId; else delete value.m_SkinID;
        for (const field of fields) writeProfileText(projectId, plainObject(change.fields) ? change.fields : {}, field, value, field, sourceRow, `MODSIDE_UNIT_${prefix}_${targetBase.m_UnitID}_${sourceSkinId}_${field}`);
        store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${tableName}.json`), key, source: { field: sourceSkinId ? "m_SkinID" : "m_UnitID", value: sourceSkinId || sourceBase.m_UnitID }, value });
        counts[tableName] = (counts[tableName] || 0) + 1;
      }
    }

    const reactorRows = recordsFor(COMMON_DIRECTORY, "LUA_REACTOR_SKILL_TEMPLET.json")
      .filter((record) => record && record.ReactorID === sourceBase.m_UnitID);
    const reactorIdMap = {};
    reactorRows.forEach((row, index) => {
      const targetIdx = remapChildId(row.IDX, sourceBase.m_UnitID, targetBase.m_UnitID, index + 1);
      const existing = findProjectPatch(projectId, "LUA_REACTOR_SKILL_TEMPLET", "IDX", targetIdx);
      const change = Array.isArray(details.reactor?.levels) ? details.reactor.levels.find((item) => Number(item?.sourceIdx) === row.IDX) || {} : {};
      const value = replaceExactValues({
        ...row,
        ...(existing?.value || {}),
        ...(plainObject(change.raw) ? change.raw : {}),
        IDX: targetIdx,
        ReactorID: targetBase.m_UnitID,
      }, skillMap);
      value.IDX = targetIdx;
      value.ReactorID = targetBase.m_UnitID;
      writeProfileText(projectId, change, "title", value, "ReactorLevelTitle", row, `MODSIDE_UNIT_REACTOR_LEVEL_TITLE_${targetBase.m_UnitID}_${row.IDX}`);
      writeProfileText(projectId, change, "description", value, "ReactorLevelDesc", row, `MODSIDE_UNIT_REACTOR_LEVEL_DESC_${targetBase.m_UnitID}_${row.IDX}`);
      store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, "LUA_REACTOR_SKILL_TEMPLET.json"), key: { field: "IDX", value: value.IDX }, source: { field: "IDX", value: row.IDX }, value });
      reactorIdMap[row.IDX] = targetIdx;
      counts.LUA_REACTOR_SKILL_TEMPLET = (counts.LUA_REACTOR_SKILL_TEMPLET || 0) + 1;
    });

    const reactor = recordsFor(COMMON_DIRECTORY, "LUA_REACTOR_TEMPLET.json").find((row) => row && row.ReactorID === sourceBase.m_UnitID);
    if (reactor) {
      const tableName = "LUA_REACTOR_TEMPLET";
      const existing = findProjectPatch(projectId, tableName, "ReactorID", targetBase.m_UnitID);
      const value = replaceExactValues({ ...reactor, ...(existing?.value || {}), ...(plainObject(details.reactor?.raw) ? details.reactor.raw : {}) }, reactorIdMap);
      value.ReactorID = targetBase.m_UnitID;
      writeProfileText(projectId, details.reactor || {}, "name", value, "ReactorName", reactor, `MODSIDE_UNIT_REACTOR_NAME_${targetBase.m_UnitID}`);
      writeProfileText(projectId, details.reactor || {}, "description", value, "ReactorDesc", reactor, `MODSIDE_UNIT_REACTOR_DESC_${targetBase.m_UnitID}`);
      store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${tableName}.json`), key: { field: "ReactorID", value: targetBase.m_UnitID }, source: { field: "ReactorID", value: sourceBase.m_UnitID }, value });
      counts[tableName] = 1;
    }

    const associationTable = "LUA_INTERACTION_UNIT_TEMPLET";
    const associationRows = recordsFor(COMMON_DIRECTORY, `${associationTable}.json`);
    const sourceIds = new Set([String(sourceBase.m_UnitID), ...Object.keys(skinMap).map(String)]);
    const targetIds = new Set([String(targetBase.m_UnitID), ...Object.values(skinMap).map(String)]);
    const includesAny = (row, ids) => [row.UnitID1, row.UnitID2].some((values) => Array.isArray(values) && values.some((value) => ids.has(String(value))));
    const sourceAssociations = associationRows.filter((row) => row && includesAny(row, sourceIds));
    const existingAssociations = store.readProject(projectId).patches.filter((patch) => patch.table.tableName === associationTable && patch.value && includesAny(patch.value, targetIds));
    const requestedAssociations = Array.isArray(details.associations) ? details.associations : sourceAssociations.map((row) => ({ sourceActId: row.UnitActID, raw: row }));
    const kept = new Set();
    for (let index = 0; index < requestedAssociations.length; index += 1) {
      const change = requestedAssociations[index] || {};
      const sourceActId = Number(change.sourceActId) || 0;
      const sourceRow = sourceAssociations.find((row) => row.UnitActID === sourceActId);
      const existing = existingAssociations.find((patch) => Number(patch.source?.value) === sourceActId || Number(patch.value.UnitActID) === Number(change.actId));
      const targetActId = Number(existing?.value?.UnitActID) || nextPatchedNumber(associationTable, "UnitActID", associationRows);
      const replaceIds = (values) => uniqueStrings((Array.isArray(values) ? values : []).map((value) => skinMap[value] || (String(value) === String(sourceBase.m_UnitID) ? targetBase.m_UnitID : value)));
      const value = { ...(sourceRow || {}), ...(existing?.value || {}), ...(plainObject(change.raw) ? change.raw : {}) };
      value.UnitActID = targetActId;
      value.UnitActStrID = String(change.action1 ?? value.UnitActStrID ?? `OFFICE_UNIT_ACT_${targetActId}_01`).trim();
      value.UnitActStrID2 = String(change.action2 ?? value.UnitActStrID2 ?? `OFFICE_UNIT_ACT_${targetActId}_02`).trim();
      value.AlignUnit = change.align == null ? value.AlignUnit === true : change.align === true;
      value.ActRange = Number.isFinite(Number(change.range)) ? Number(change.range) : Number(value.ActRange) || 400;
      value.UnitType1 = String(change.type1 || value.UnitType1 || "Unit");
      value.UnitType2 = String(change.type2 || value.UnitType2 || "Unit");
      value.UnitID1 = replaceIds(change.ids1 ?? value.UnitID1);
      value.UnitID2 = replaceIds(change.ids2 ?? value.UnitID2);
      if (!value.UnitActStrID || !value.UnitActStrID2 || !value.UnitID1.length || !value.UnitID2.length) throw httpError(400, "Office associations need two action IDs and at least one unit or skin on each side.");
      if (!includesAny(value, targetIds)) continue;
      const written = store.writePatch(projectId, { table: tableEntry(COMMON_DIRECTORY, `${associationTable}.json`), key: { field: "UnitActID", value: targetActId }, ...(sourceRow ? { source: { field: "UnitActID", value: sourceRow.UnitActID } } : {}), value }, existing?.patchId || "");
      kept.add(written.patchId);
      counts[associationTable] = (counts[associationTable] || 0) + 1;
    }
    if (Array.isArray(details.associations)) for (const patch of existingAssociations) if (!kept.has(patch.patchId)) store.removePatch(projectId, patch.patchId, { optional: true });

    return counts;
  }

  function syncProject(projectId) {
    let project = store.readProject(projectId);
    const units = [];
    for (const patch of project.patches.filter((entry) => UNIT_BASE_TABLES.has(entry.table.tableName) && entry.value)) {
      const sourceStrId = patch.source && typeof patch.source === "object" ? patch.source.value : "";
      if (!sourceStrId || sourceStrId === patch.value.m_UnitStrID) continue;
      const source = inspect(sourceStrId);
      const targetBase = applyCloneFallbacks(source.base, cloneJson(patch.value));
      if (JSON.stringify(targetBase) !== JSON.stringify(patch.value)) {
        store.writePatch(projectId, { table: patch.table, key: patch.key, source: patch.source, value: targetBase });
      }
      ensureSharedVoiceBundles(projectId, source, targetBase);
      const skillMap = Object.fromEntries(SKILL_FIELDS
        .map((field) => [source.base[field], targetBase[field]])
        .filter(([sourceSkill, targetSkill]) => sourceSkill && targetSkill));
      const skinMap = Object.fromEntries(project.patches
        .filter((entry) => entry.table.tableName === "LUA_SKIN_TEMPLET" && entry.value?.m_SkinEquipUnitID === targetBase.m_UnitID && Number.isSafeInteger(Number(entry.source?.value)))
        .map((entry) => [Number(entry.source.value), Number(entry.value.m_SkinID)]));
      cloneCollectionRows(projectId, source.base, targetBase);
      units.push({ unitId: targetBase.m_UnitID, unitStrId: targetBase.m_UnitStrID, registrations: cloneRelatedRows(projectId, source.base, targetBase, skillMap, skinMap) });
      project = store.readProject(projectId);
    }
    return { project, units };
  }

  function ensureSharedVoiceBundles(projectId, source, targetBase) {
    if (!targetBase.m_bExistVoiceBundle) return [];
    const project = store.readProject(projectId);
    const output = [];
    for (const spec of findVoiceBundleSpecs(clientRoot, source).filter((item) => item.kind === "unit")) {
      const extension = path.extname(spec.file).toLowerCase();
      const bundleName = `ab_ui_unit_voice_${targetBase.m_UnitStrID.toLowerCase()}${extension}`;
      const destination = path.join(project.root, "assets", "bundles", bundleName);
      if (!fs.existsSync(destination)) {
        const sourceBundle = fs.readFileSync(spec.file);
        const decrypted = transformCounterSideBundleHeader(sourceBundle, path.basename(spec.file));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, transformCounterSideBundleHeader(decrypted, bundleName));
      }
      output.push(bundleName);
    }
    return output;
  }

  function attachSpine(input = {}) {
    const projectId = String(input.projectId || "");
    const targetStrId = validateUnitStrId(input.unitStrId);
    const role = String(input.role || "").toLowerCase();
    const spec = SPINE_ROLES[role];
    if (!spec) throw httpError(400, "Spine role must be illustration, sd, or battle.");
    const project = store.readProject(projectId);
    const targetPatch = project.patches.find((patch) => UNIT_BASE_TABLES.has(patch.table.tableName) && patch.value && patch.value.m_UnitStrID === targetStrId);
    if (!targetPatch) throw httpError(404, `Custom unit was not found in ${projectId}: ${targetStrId}`);
    const source = inspect(String(input.sourceUnitStrId || targetPatch.source && targetPatch.source.value || ""));
    const sourceBundleName = String(source.base[spec.bundleField] || "").split("@")[0];
    const sourceAssetName = String(source.base[spec.assetField] || "").split("@").pop();
    if (!sourceBundleName || !sourceAssetName) throw httpError(422, `The source unit has no ${role} Spine prefab.`);
    const sourceBundle = findSourceBundle(clientRoot, sourceBundleName);
    if (!sourceBundle) throw httpError(422, `Source client bundle was not found: ${sourceBundleName}. Select/freeze CounterSide in the launcher first.`);

    const sourceRoot = path.join(project.root, "assets", "source");
    const files = (Array.isArray(input.sources) ? input.sources : []).map((value) => resolveProjectSource(sourceRoot, value));
    const skeletons = files.filter((file) => path.extname(file).toLowerCase() === ".skel");
    const atlases = files.filter((file) => path.extname(file).toLowerCase() === ".atlas");
    const textures = files.filter((file) => path.extname(file).toLowerCase() === ".png");
    if (files.length !== skeletons.length + atlases.length + textures.length || skeletons.length !== 1 || atlases.length !== 1 || !textures.length) {
      throw httpError(400, "Select one binary .skel, one .atlas, and every PNG page named by that atlas.");
    }

    const bundleName = `${spec.prefix}${targetStrId}`;
    const assetName = role === "battle" ? `SPINE_${targetStrId}` : bundleName;
    const destination = path.join(project.root, "assets", "bundles", bundleName.toLowerCase());
    const built = patchSpineBundle({ sourceBundle, sourceAssetName, bundleName, assetName, skeleton: skeletons[0], atlas: atlases[0], textures, kind: spec.kind, destination });
    const base = cloneJson(targetPatch.value);
    if (role === "battle") {
      base.m_SpriteBundleName = bundleName;
      base.m_SpriteName = assetName;
    } else {
      base[spec.assetField] = bundleName;
    }
    store.writePatch(projectId, { table: targetPatch.table, key: targetPatch.key, source: targetPatch.source, value: base });
    return { project: store.readProject(projectId), role, bundle: { name: bundleName, assetName, path: path.relative(project.root, destination).replace(/\\/g, "/"), ...built } };
  }

  function extractVoices(unitStrId) {
    const source = inspect(String(unitStrId || ""));
    const specs = findVoiceBundleSpecs(clientRoot, source);
    if (!clientRoot) throw httpError(422, "CounterSide client assets are unavailable. Select or freeze a client in the launcher first.");
    if (!specs.length) throw httpError(404, `No Korean or Japanese voice bundles were found for ${source.summary.displayName}.`);
    const bundles = specs.map((spec) => ensureVoiceBundle(spec));
    const assets = { KOR: {}, JPN: {} };
    for (const bundle of bundles) for (const file of bundle.files) {
      const id = path.basename(file, path.extname(file)).toUpperCase();
      assets[bundle.language][id] ||= path.relative(assetRoot, file).replace(/\\/g, "/");
    }
    return {
      unit: source.summary,
      assets,
      bundles: bundles.map(({ files, ...bundle }) => ({ ...bundle, fileCount: files.length })),
      extractedCount: bundles.filter((bundle) => bundle.extracted).length,
      audioCount: Object.values(assets).reduce((count, values) => count + Object.keys(values).length, 0),
    };
  }

  function prepareVoiceBundle(input = {}) {
    const projectId = String(input.projectId || "");
    const targetStrId = validateUnitStrId(input.unitStrId);
    const source = inspect(String(input.sourceUnitStrId || ""));
    const project = store.readProject(projectId);
    const targetBase = project.patches.find((patch) => UNIT_BASE_TABLES.has(patch.table.tableName) && patch.value?.m_UnitStrID === targetStrId);
    if (!targetBase) throw httpError(404, `Custom unit was not found in ${projectId}: ${targetStrId}`);
    const language = String(input.language || "KOR").trim().toUpperCase();
    if (!["KOR", "JPN"].includes(language)) throw httpError(400, "Voice language must be KOR or JPN.");
    const sourceBundleName = String(input.sourceBundleName || "").trim().toUpperCase();
    const spec = findVoiceBundleSpecs(clientRoot, source).find((item) => item.bundleName === sourceBundleName && item.language === language);
    if (!spec) throw httpError(404, `${language} source voice bundle was not found: ${sourceBundleName}`);
    const extracted = ensureVoiceBundle(spec);
    const voiceMap = normalizeVoiceMap(input.voiceMap, source.voices);
    const replacements = new Map((Array.isArray(input.replacements) ? input.replacements : []).map((entry) => {
      if (!plainObject(entry)) throw httpError(400, "Voice replacement entries must contain a voice ID and uploaded MP3 source.");
      const voiceId = validateVoiceId(entry.voiceId);
      const file = resolveProjectSource(path.join(project.root, "assets", "source"), entry.source);
      if (path.extname(file).toLowerCase() !== ".mp3") throw httpError(415, `Voice replacement must be an MP3: ${entry.source}`);
      return [voiceId, file];
    }));
    const targetBundleName = targetVoiceBundleName(projectId, source, targetBase.value, spec);
    const destinationRoot = `unit-voice/generated/${targetStrId}/${language.toLowerCase()}/${targetBundleName.toLowerCase()}`;
    const assets = [];
    const written = new Set();
    for (const file of extracted.files) {
      const sourceId = path.basename(file, path.extname(file)).toUpperCase();
      const targetId = voiceMap[sourceId] || sourceId;
      if (replacements.has(targetId) || written.has(targetId)) continue;
      const saved = store.writeAssetSource(projectId, `${destinationRoot}/${targetId}${path.extname(file).toLowerCase()}`, fs.readFileSync(file));
      assets.push(saved.replace(/^assets\/source\//, ""));
      written.add(targetId);
    }
    for (const [voiceId, file] of replacements) {
      const saved = store.writeAssetSource(projectId, `${destinationRoot}/${voiceId}.mp3`, fs.readFileSync(file));
      assets.push(saved.replace(/^assets\/source\//, ""));
      written.add(voiceId);
    }
    if (!assets.length) throw httpError(422, `${sourceBundleName} did not contain extractable audio.`);
    return {
      projectId,
      sourceBundleName,
      targetBundleName,
      language,
      bundleName: `${targetBundleName.toLowerCase()}.${language === "JPN" ? "vjpn" : "vkor"}`,
      assets,
      replacementCount: replacements.size,
    };
  }

  function ensureVoiceBundle(spec) {
    let files = listExtractedAudio(assetRoot, spec.relativePath);
    let extracted = false;
    if (!files.length) {
      extractVoiceBundle({ source: spec.file, clientRoot, assetRoot });
      files = listExtractedAudio(assetRoot, spec.relativePath);
      extracted = true;
    }
    if (!files.length) throw httpError(422, `Voice bundle produced no playable audio: ${path.basename(spec.file)}`);
    return { ...spec, files, extracted };
  }

  function targetVoiceBundleName(projectId, source, targetBase, spec) {
    if (spec.kind === "unit") return `AB_UI_UNIT_VOICE_${targetBase.m_UnitStrID}`;
    const sourceSkin = source.skins.find((skin) => String(skin.m_VoiceBundleName || "").toUpperCase() === spec.bundleName);
    const skinPatch = sourceSkin && store.readProject(projectId).patches.find((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET" && patch.source?.value === sourceSkin.m_SkinID && patch.value?.m_SkinEquipUnitID === targetBase.m_UnitID);
    if (!skinPatch) throw httpError(422, `Clone the matching source skin before building ${spec.bundleName}.`);
    const targetBundleName = `AB_UI_SKIN_VOICE_${skinPatch.value.m_SkinStrID}`;
    store.writePatch(projectId, { table: skinPatch.table, key: skinPatch.key, source: skinPatch.source, value: { ...skinPatch.value, m_VoiceBundleName: targetBundleName } });
    return targetBundleName;
  }

  function nextUnitId() {
    const primary = recordsFor(UNIT_DIRECTORY, `${UNIT_TABLE_SPECS[0].base}.json`);
    const occupied = new Set(UNIT_TABLE_SPECS.flatMap((spec) => recordsFor(UNIT_DIRECTORY, `${spec.base}.json`)).map((record) => Number(record?.m_UnitID)).filter(Number.isSafeInteger));
    for (const summary of store.listProjects()) {
      const project = store.readProject(summary.id);
      for (const patch of project.patches) if (UNIT_BASE_TABLES.has(patch.table.tableName) && patch.value && Number.isSafeInteger(Number(patch.value.m_UnitID))) occupied.add(Number(patch.value.m_UnitID));
    }
    let candidate = Math.max(0, ...primary.map((record) => Number(record?.m_UnitID) || 0)) + 1;
    while (occupied.has(candidate)) candidate += 1;
    return candidate;
  }

  function assertUnitAvailable(unitId, unitStrId, projectId) {
    const records = UNIT_TABLE_SPECS.flatMap((spec) => recordsFor(UNIT_DIRECTORY, `${spec.base}.json`));
    if (records.some((record) => record && (record.m_UnitID === unitId || record.m_UnitStrID === unitStrId))) throw httpError(409, "Unit ID or string ID already exists in base data.");
    if (store.readProject(projectId).patches.some((patch) => UNIT_BASE_TABLES.has(patch.table.tableName) && patch.value && (patch.value.m_UnitID === unitId || patch.value.m_UnitStrID === unitStrId))) throw httpError(409, "Unit ID or string ID already exists in this project.");
  }

  function nextPatchedNumber(tableName, field, baseRecords) {
    let max = Math.max(0, ...baseRecords.map((record) => Number(record && record[field]) || 0));
    for (const summary of store.listProjects()) {
      for (const patch of store.readProject(summary.id).patches) {
        if (patch.table.tableName === tableName && patch.value) max = Math.max(max, Number(patch.value[field]) || 0);
      }
    }
    return max + 1;
  }

  function recordsFor(directory, fileName) {
    const parsed = readBaseTable(directory, fileName);
    if (!parsed) throw httpError(422, `Required unit table was not found: ${directory}/${fileName}`);
    return extractTableRecords(parsed);
  }

  function readBaseTable(directory, fileName) {
    const key = `${directory}/${fileName}`.toLowerCase();
    if (!tableCache.has(key)) tableCache.set(key, readGameplayTable(directory, fileName, { rootDir, env: baseEnv(), noCache: true }));
    return tableCache.get(key);
  }

  function tableEntry(directory, fileName) {
    const key = `${directory}/${fileName}`.toLowerCase();
    if (tableEntryCache.has(key)) return tableEntryCache.get(key);
    const entry = findGameplayTableEntry(directory, fileName, { rootDir, env: baseEnv() });
    const tableName = entry?.tableName || path.basename(fileName, path.extname(fileName));
    const value = { directory: entry?.directory || directory, fileName: `${tableName}.json`, tableName, format: "json" };
    tableEntryCache.set(key, value);
    return value;
  }

  function findProjectPatch(projectId, tableName, field, value) {
    return store.readProject(projectId).patches.find((patch) => patch.table.tableName === tableName && patch.key.field === field && patch.key.value === value) || null;
  }

  return { catalog, inspect, projects, inspectProjectUnit, create, update, attachSpine, extractVoices, prepareVoiceBundle, syncProject };
}

function resolveClientRoot(rootDir, env, override) {
  const configured = [override, env.CS_COUNTERSIDE_DIR, env.CS_COUNTERSIDE_MANAGED_DIR && path.resolve(env.CS_COUNTERSIDE_MANAGED_DIR, "..", "..")].filter(Boolean);
  for (const value of configured) if (fs.existsSync(path.join(path.resolve(value), "Data", "Managed", "Assembly-CSharp.dll"))) return path.resolve(value);
  const archive = path.join(rootDir, "frozen-client");
  if (fs.existsSync(archive)) {
    for (const name of fs.readdirSync(archive).sort().reverse()) {
      const candidate = path.join(archive, name);
      if (fs.existsSync(path.join(candidate, "Data", "Managed", "Assembly-CSharp.dll"))) return candidate;
    }
  }
  return "";
}

function findSourceBundle(clientRoot, bundleName) {
  if (!clientRoot) return "";
  const name = bundleName.toLowerCase();
  const candidates = [
    path.join(clientRoot, "Data", "StreamingAssets", `${name}.asset`),
    path.join(clientRoot, "Assetbundles", `${name}.asset`),
    path.join(clientRoot, "Data", "StreamingAssets", name),
    path.join(clientRoot, "Assetbundles", name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || "";
}

function resolveProjectSource(root, value) {
  const relative = String(value || "").replace(/\\/g, "/").replace(/^assets\/source\//, "").replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  if (!relative || !isInside(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, `Spine source was not found: ${relative}`);
  return file;
}

function runSpineBundlePatcher(rootDir, env, input) {
  const python = pythonExecutable(rootDir, env);
  const script = path.join(rootDir, "tools", "cs_asset_decrypt.py");
  const args = [script, "patch-spine", "--bundle", input.sourceBundle, "--skeleton", input.skeleton, "--atlas", input.atlas, "--textures", ...input.textures, "--kind", input.kind, "--source-asset-name", input.sourceAssetName, "--bundle-name", input.bundleName, "--asset-name", input.assetName, "--out", input.destination];
  const result = spawnSync(python, args, { encoding: "utf8", timeout: 2 * 60 * 1000, windowsHide: true });
  if (result.error) throw httpError(422, result.error.message);
  if (result.status !== 0) throw httpError(422, String(result.stderr || result.stdout || "Spine bundle import failed.").trim().slice(-8000));
  const line = String(result.stdout || "").trim().split(/\r?\n/).pop();
  try { return JSON.parse(line); }
  catch { throw httpError(500, `Spine bundle importer returned invalid output: ${line}`); }
}

function runVoiceBundleExtractor(rootDir, env, input) {
  const python = pythonExecutable(rootDir, env);
  const decryptScript = path.join(rootDir, "tools", "cs_asset_decrypt.py");
  const extractScript = path.join(rootDir, "tools", "cs_extract_decrypted_assets.py");
  if (!fs.existsSync(decryptScript) || !fs.existsSync(extractScript)) throw httpError(422, "Voice extraction tools are missing from this RevivalSide installation.");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-unit-voice-"));
  const decrypted = path.join(temporary, "decrypted");
  try {
    runPython(python, [decryptScript, "decrypt-header", input.source, "--root", input.clientRoot, "--out-dir", decrypted, "--overwrite", "--quiet"], "Voice bundle decryption");
    runPython(python, [extractScript, "--root", decrypted, "--out-dir", input.assetRoot, "--pattern", "*.dec", "--types", "AudioClip", "--manifest", path.join(temporary, "manifest.json"), "--overwrite-manifest", "--quiet"], "Voice audio extraction");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function runPython(python, args, label) {
  const finalArgs = path.basename(python).toLowerCase() === "py.exe" ? ["-3", ...args] : args;
  const result = spawnSync(python, finalArgs, { encoding: "utf8", timeout: 2 * 60 * 1000, windowsHide: true });
  if (result.error) throw httpError(422, `${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw httpError(422, `${label} failed: ${String(result.stderr || result.stdout || "Unknown Python error").trim().slice(-8000)}`);
}

function pythonExecutable(rootDir, env) {
  const packagedPython = path.join(rootDir, "runtime", "python", "python.exe");
  return env.CS_PYTHON_PATH || (fs.existsSync(packagedPython) ? packagedPython : "python");
}

function findVoiceBundleSpecs(clientRoot, source) {
  if (!clientRoot) return [];
  const definitions = [{ kind: "unit", bundleName: `AB_UI_UNIT_VOICE_${source.base.m_UnitStrID}` }]
    .concat(source.skins.filter((skin) => skin.m_VoiceBundleName).map((skin) => ({ kind: "skin", bundleName: String(skin.m_VoiceBundleName) })));
  const output = [];
  const seen = new Set();
  for (const definition of definitions) for (const [language, extension] of [["KOR", ".vkor"], ["JPN", ".vjpn"]]) for (const root of ["Data/StreamingAssets/voice", "Assetbundles/voice"]) {
    const relativePath = `${root}/${definition.bundleName.toLowerCase()}${extension}`;
    const file = path.join(clientRoot, ...relativePath.split("/"));
    const key = `${definition.bundleName.toUpperCase()}:${language}`;
    if (seen.has(key) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    seen.add(key);
    output.push({ ...definition, bundleName: definition.bundleName.toUpperCase(), language, file, relativePath });
  }
  return output;
}

function listExtractedAudio(assetRoot, relativePath) {
  const directory = path.join(assetRoot, ...relativePath.split("/"));
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && /\.(wav|ogg|mp3|m4a)$/i.test(entry.name)) files.push(file);
    }
  }
  return files.sort();
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unitSummary(record, wikiUnits, loadStrings, displayName = "") {
  const wiki = wikiUnits.get(String(record.m_UnitID)) || wikiUnits.get(String(record.m_UnitStrID));
  const localizedName = displayName || wiki?.name || resolveString(loadStrings(), record.m_Name);
  return {
    id: record.m_UnitID,
    strId: record.m_UnitStrID,
    name: record.m_Name,
    displayName: localizedName || humanizeUnitStrId(record.m_UnitStrID),
    image: wiki?.image || "",
    unitType: record.m_NKM_UNIT_TYPE,
    rarity: record.m_NKM_UNIT_GRADE,
    awakened: record.m_bAwaken === true,
    role: record.m_NKM_UNIT_ROLE_TYPE,
    style: record.m_NKM_UNIT_STYLE_TYPE,
    contractable: record.m_bContractable,
  };
}

function uniqueFieldValues(records, field) {
  return Array.from(new Set(records.map((record) => record[field]).filter((value) => typeof value === "string" && value))).sort();
}

function humanizeUnitStrId(value) {
  return String(value || "").replace(/^NKM_(?:UNIT|SHIP|MOB)_/, "").split("_").filter(Boolean).map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" ");
}

function validateUnitStrId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!/^NKM_(?:UNIT|SHIP|MOB)_[A-Z0-9_]{3,120}$/.test(id)) throw httpError(400, "Unit string ID must start with NKM_UNIT_, NKM_SHIP_, or NKM_MOB_ and contain uppercase letters, numbers, or underscores.");
  return id;
}

function collectStrings(value, predicate, output = new Set()) {
  if (Array.isArray(value)) value.forEach((child) => collectStrings(child, predicate, output));
  else if (value && typeof value === "object") Object.values(value).forEach((child) => collectStrings(child, predicate, output));
  else if (typeof value === "string" && predicate(value)) output.add(value);
  return output;
}

function collectVoiceGroups(value, unitStrId, skins = []) {
  const groups = new Map();
  for (const voice of collectStrings(value, (item) => item.startsWith("VOICE_"))) {
    const key = voiceStem(voice);
    if (!key) continue;
    const lines = groups.get(key) || [];
    lines.push(voice);
    groups.set(key, lines);
  }
  const unitPrefix = String(unitStrId || "").replace(/^NKM_/, "");
  const skinPrefixes = skins.filter((skin) => skin.m_SkinStrID).map((skin) => ({
    prefix: String(skin.m_SkinStrID).replace(/^NKM_/, ""),
    bundleName: String(skin.m_VoiceBundleName || `AB_UI_SKIN_VOICE_${skin.m_SkinStrID}`).toUpperCase(),
  })).sort((left, right) => right.prefix.length - left.prefix.length);
  return Array.from(groups, ([key, lines]) => {
    const skin = skinPrefixes.find((item) => key.startsWith(`VOICE_${item.prefix}_`));
    return {
      key,
      label: humanizeWords(key.replace(/^VOICE_/, "").replace(new RegExp(`^${escapeRegex(unitPrefix)}_?`), "")),
      sourceBundleName: skin?.bundleName || `AB_UI_UNIT_VOICE_${unitStrId}`,
      skin: Boolean(skin),
      lines: Array.from(new Set(lines)).sort((left, right) => voiceLineNumber(left) - voiceLineNumber(right) || left.localeCompare(right)),
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
}

function projectUnitPatches(project) {
  return project.patches.filter((patch) => UNIT_BASE_TABLES.has(patch.table.tableName) && patch.value?.m_UnitStrID && patch.source?.field === "m_UnitStrID" && typeof patch.source.value === "string");
}

function deriveVoiceChanges(sourceRoot, currentRoot, sourceGroups, sourceVoices) {
  const voiceMap = {};
  function compare(source, current) {
    if (Array.isArray(source) && Array.isArray(current)) {
      for (let index = 0; index < Math.min(source.length, current.length); index += 1) compare(source[index], current[index]);
    } else if (source && current && typeof source === "object" && typeof current === "object") {
      for (const key of Object.keys(source)) if (Object.hasOwn(current, key)) compare(source[key], current[key]);
    } else if (typeof source === "string" && source.startsWith("VOICE_") && typeof current === "string" && current.startsWith("VOICE_") && source !== current) voiceMap[source] = current;
  }
  compare(sourceRoot, currentRoot);
  const mapped = new Set(Object.values(voiceMap));
  const sourceSet = new Set(sourceVoices);
  const extras = Array.from(collectStrings(currentRoot, (value) => value.startsWith("VOICE_"))).filter((voice) => !sourceSet.has(voice) && !mapped.has(voice));
  const voiceAdditions = Object.fromEntries(sourceGroups.map((group) => [group.key, extras.filter((voice) => voiceStem(voice) === group.key)]).filter(([, lines]) => lines.length));
  return { voiceMap, voiceAdditions };
}

function normalizeVoiceMap(value, sourceVoices) {
  if (value == null) return {};
  if (!plainObject(value)) throw httpError(400, "Voice replacements must be an object of source and replacement sound IDs.");
  const allowed = new Set(sourceVoices);
  const output = {};
  for (const [source, replacement] of Object.entries(value)) {
    if (!allowed.has(source)) throw httpError(400, `Voice replacement is not used by the source unit: ${source}`);
    output[source] = validateVoiceId(replacement);
  }
  return output;
}

function normalizeVoiceAdditions(value, sourceGroups, sourceVoices) {
  if (value == null) return {};
  if (!plainObject(value)) throw httpError(400, "Voice additions must be grouped by source voice category.");
  const allowed = new Set(sourceGroups.map((group) => group.key));
  const used = new Set(sourceVoices);
  const output = {};
  for (const [group, additions] of Object.entries(value)) {
    if (!allowed.has(group)) throw httpError(400, `Unknown source voice category: ${group}`);
    if (!Array.isArray(additions)) throw httpError(400, `Voice additions for ${group} must be an array.`);
    output[group] = additions.map(validateVoiceId).filter((voice) => {
      if (used.has(voice)) throw httpError(409, `Voice sound ID is already used by this unit: ${voice}`);
      used.add(voice);
      return true;
    });
  }
  return output;
}

function appendVoiceLines(value, additions) {
  if (Array.isArray(value)) {
    const expanded = value.slice();
    const stems = new Set(value.filter((item) => typeof item === "string").map(voiceStem).filter(Boolean));
    for (const stem of stems) for (const voice of additions[stem] || []) if (!expanded.includes(voice)) expanded.push(voice);
    return expanded.map((child) => appendVoiceLines(child, additions));
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, appendVoiceLines(child, additions)]));
  return value;
}

function voiceStem(value) {
  const match = String(value || "").match(/^(VOICE_[A-Z0-9_]+)_\d+$/);
  return match ? match[1] : "";
}

function voiceLineNumber(value) {
  const match = String(value || "").match(/_(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function validateVoiceId(value) {
  const id = String(value || "").trim().toUpperCase();
  if (!/^VOICE_[A-Z0-9_]{3,160}$/.test(id)) throw httpError(400, "Voice sound IDs must start with VOICE_ and contain uppercase letters, numbers, or underscores.");
  return id;
}

function resolveString(strings, value) {
  const raw = String(value || "");
  if (!raw) return "";
  const [key, ...parameters] = raw.split("@@");
  let result = String(STRING_CORRECTIONS[key] || strings[key] || "");
  parameters.forEach((parameter, index) => { result = result.replaceAll(`{${index}}`, parameter); });
  return result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
}

function skillLabel(type, index) {
  return ({ NST_ATTACK: "Basic attack", NST_PASSIVE: "Passive skill", NST_SKILL: "Special skill", NST_HYPER: "Ultimate skill", NST_LEADER: "Leader skill" })[type]
    || ["Basic attack", "Passive skill", "Special skill", "Ultimate skill"][index]
    || humanizeWords(type);
}

function humanizeWords(value) {
  return String(value || "").split("_").filter(Boolean).map((word) => word.charAt(0) + word.slice(1).toLowerCase()).join(" ");
}

function indexUnits(units) {
  const output = new Map();
  for (const unit of Array.isArray(units) ? units : []) {
    if (unit.id != null) output.set(String(unit.id), unit);
    if (unit.strId) output.set(String(unit.strId), unit);
  }
  return output;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function replaceExactValues(value, replacements) {
  if (Array.isArray(value)) return value.map((child) => replaceExactValues(child, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceExactValues(child, replacements)]));
  return Object.prototype.hasOwnProperty.call(replacements, value) ? replacements[value] : value;
}

function normalizeDecodedValue(value, warnings, pathName = "root") {
  if (Array.isArray(value)) return value.map((child, index) => normalizeDecodedValue(child, warnings, `${pathName}[${index}]`));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.__unparsed_expr === "string") {
      // ponytail: decoded temporary expressions are rare; expose zero and warn until the LUAC decoder preserves their evaluated value.
      warnings.push(`Normalized decoded expression at ${pathName}: ${value.__unparsed_expr}`);
      return 0;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeDecodedValue(child, warnings, `${pathName}.${key}`)]));
  }
  return value;
}

function remapString(value, sourceStrId, targetStrId) {
  const source = String(sourceStrId || "").replace(/^NKM_/, "");
  const target = String(targetStrId || "").replace(/^NKM_/, "");
  return String(value || "").replace(source, target);
}

function applyCloneFallbacks(sourceBase, targetBase) {
  for (const field of ["m_FirstOpenTag", "m_BasicOpenTag"]) {
    const generated = remapString(sourceBase[field], sourceBase.m_UnitStrID, targetBase.m_UnitStrID);
    if (!targetBase[field] || targetBase[field] === generated) targetBase[field] = sourceBase[field];
  }
  if (targetBase.m_bExistVoiceBundle && !targetBase.m_CommonVoiceBundle) {
    targetBase.m_CommonVoiceBundle = sourceBase.m_CommonVoiceBundle || sourceBase.m_UnitStrID;
  }
  return targetBase;
}

function unitTableSpecForBase(tableName) {
  const spec = UNIT_TABLE_SPECS.find((item) => item.base === tableName);
  if (!spec) throw httpError(422, `Unsupported unit base table: ${tableName}`);
  return spec;
}

function makeSquadUsable(base) {
  base.m_NKM_UNIT_TYPE = "NUT_NORMAL";
  base.m_bMonster = false;
  base.m_bContractable = true;
  base.m_NKM_UNIT_SOURCE_TYPE ||= "NUST_CONFLICT";
  base.m_UnitDesc ||= "SI_BLANK";
  base.m_TacticGroup ??= 0;
  for (const field of ["m_OnRemoveItemID_1", "m_OnRemoveItemCount_1", "m_OnRemoveItemID_2", "m_OnRemoveItemCount_2", "m_OnRemoveItemID_Contract", "m_OnRemoveItemCount_Contract"]) base[field] ??= 0;
  return base;
}

function squadProfile(sourceBase, targetBase) {
  return {
    UnitID: targetBase.m_UnitID,
    OpenTag: targetBase.m_FirstOpenTag || "",
    CharacterType: "SI_COLLECTION_PROFILE_TYPE_CHARACTER",
    NameType: "SI_COLLECTION_PROFILE_TYPE_NAME",
    NameValue: targetBase.m_Name,
    TeamConceptStrID: targetBase.m_Title || "SI_BLANK",
    TeamUpStrID: "SI_BLANK",
    GenderType: "SI_COLLECTION_PROFILE_TYPE_GENDER",
    GenderValueStrID: "SI_BLANK",
    BirthType: "SI_COLLECTION_PROFILE_TYPE_BIRTH",
    BirthValueStrID: "SI_BLANK",
    HeightType: "SI_COLLECTION_PROFILE_TYPE_HEIGHT",
    HeightValueStrID: "SI_BLANK",
    SpecialityType: "SI_COLLECTION_PROFILE_TYPE_SPECIALITY",
    SpecialityValueStrID: "SI_BLANK",
    LikeType: "SI_COLLECTION_PROFILE_TYPE_LIKE",
    LikeValueStrID: "SI_BLANK",
    DisLikeType: "SI_COLLECTION_PROFILE_TYPE_DISLIKE",
    DisLikeValueStrID: "SI_BLANK",
    CombatLevelType: "SI_COLLECTION_PROFILE_TYPE_LEVEL_COMBAT",
    CombatLevelValue: "SI_BLANK",
    CommandLevelType: "SI_COLLECTION_PROFILE_TYPE_LEVEL_COMMAND",
    CommandLevelValue: "SI_BLANK",
    ProfileType_1: "SI_COLLECTION_PROFILE_TYPE_PROFILE_PROFILE",
    ProfileValue_1: sourceBase.m_UnitDesc || "SI_BLANK",
  };
}

function remapChildId(value, sourceId, targetId, fallbackSuffix) {
  const source = String(sourceId);
  const text = String(value || "");
  const suffix = text.startsWith(source) && text.length > source.length ? text.slice(source.length) : String(fallbackSuffix);
  const remapped = Number(`${targetId}${suffix}`);
  if (!Number.isSafeInteger(remapped) || remapped <= 0) throw httpError(422, `Could not allocate related record ID for unit ${targetId}.`);
  return remapped;
}

function uniqueStrings(values) { return Array.from(new Set(values.map(String).map((value) => value.trim()).filter(Boolean))); }
function plainObject(value) { return value && typeof value === "object" && !Array.isArray(value); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

module.exports = { ASSET_FIELDS, SKILL_FIELDS, createModUnitMaker };
