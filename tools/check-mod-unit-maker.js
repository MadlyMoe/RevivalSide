const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { createModRuntime } = require("../modules/mod-loader");
const { createModProjectStore } = require("../modules/mod-projects");
const { createModUnitMaker } = require("../modules/mod-unit-maker");
const { transformCounterSideBundleHeader } = require("../modules/unity-bundle-compiler");
const { grantUserExp } = require("../modules/account-progression");
const { ensureArmy } = require("../modules/unit");

const rootDir = path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-unit-maker-"));
try {
  const env = {};
  const clientRoot = path.join(temporary, "client");
  fs.mkdirSync(path.join(clientRoot, "Data", "Managed"), { recursive: true });
  fs.mkdirSync(path.join(clientRoot, "Data", "StreamingAssets"), { recursive: true });
  fs.writeFileSync(path.join(clientRoot, "Data", "Managed", "Assembly-CSharp.dll"), "fixture");
  const patchedSpine = [];
  let extractedVoiceId = "";
  const assetRoot = path.join(temporary, "extracted-assets", "all");
  const store = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "mods") });
  const maker = createModUnitMaker({ rootDir, env, modStore: store, clientRoot, assetRoot, extractVoiceBundle: (input) => {
    const output = path.join(input.assetRoot, path.relative(input.clientRoot, input.source), "AudioClip");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `${extractedVoiceId}.wav`), "wave");
  }, patchSpineBundle: (input) => {
    patchedSpine.push(input);
    fs.mkdirSync(path.dirname(input.destination), { recursive: true });
    fs.writeFileSync(input.destination, "spine-bundle");
    return { bytes: 12, spineVersion: "3.7.93", pages: ["custom.png"], kind: input.kind };
  } });
  const catalog = maker.catalog("lee yumi");
  assert(catalog.units.some((unit) => unit.strId === "NKM_UNIT_C_POLICE_LEE_YUMI" && unit.displayName === "Lee Yumi"));
  const eveCatalog = maker.catalog("eve meitner");
  assert.strictEqual(eveCatalog.units[0].strId, "NKM_UNIT_ESPR_CA_SHADOW");
  assert.strictEqual(eveCatalog.units[0].displayName, "Eve Meitner");
  assert.strictEqual(eveCatalog.units[0].rarity, "NUG_SSR");
  assert.strictEqual(eveCatalog.units[0].awakened, true);
  assert(catalog.options.rarities.includes("NUG_SSR"));
  assert(catalog.options.roles.includes("NURT_DEFENDER"));
  const completeCatalog = maker.catalog();
  assert(completeCatalog.total > 100);
  assert(completeCatalog.units.length > 100);
  assert(completeCatalog.counts.NUT_NORMAL > 0);
  assert(completeCatalog.counts.NUT_SHIP > 0);
  assert(completeCatalog.counts.NUT_SYSTEM > 0);
  assert(maker.catalog("", "NUT_SHIP").units.every((unit) => unit.unitType === "NUT_SHIP"));
  const bossCatalog = maker.catalog("230461");
  assert(bossCatalog.units.some((unit) => unit.id === 230461 && unit.sourceTable === "LUA_UNIT_TEMPLET_BASE2" && unit.sourceCategory === "ENEMY"));
  assert(maker.catalog("", "ENEMY").units.some((unit) => unit.id === 230461));
  const source = maker.inspect("NKM_UNIT_C_POLICE_LEE_YUMI");
  assert.strictEqual(source.base.m_UnitID, 1099);
  assert.strictEqual(source.nextUnitId, 26048);
  assert.strictEqual(source.skillSlots.length, 4);
  assert.strictEqual(source.skillSlots[0].rows.length, 5);
  assert(source.skillSlots.every((skill) => skill.name && skill.icon && skill.rows.every((row) => row.description)));
  assert(source.voiceGroups.length > 0);
  assert.strictEqual(source.collection.raw.m_UnitID, 1099);
  assert.strictEqual(source.profile.birthMonth, "9");
  assert.strictEqual(source.profile.birthDay, "29");
  assert.strictEqual(source.profile.height, "163");
  assert.strictEqual(source.profile.speciality, "Subduing criminals");
  assert.strictEqual(source.details.title, "Police SWAT 4");
  assert.strictEqual(source.details.description, "A melee tanker who fights on the front lines, using high EVA.");
  assert.strictEqual(source.details.resultLines.length, 4);
  assert.strictEqual(source.details.negotiationLines.length, 4);
  assert.strictEqual(source.details.reactor.levels.length, 2);
  assert.strictEqual(source.details.associations.length, 2);
  const eve = maker.inspect("NKM_UNIT_ESPR_CA_SHADOW");
  assert.strictEqual(eve.summary.displayName, "Eve Meitner");
  assert.strictEqual(eve.suggestedName, "Eve Meitner 2");
  assert.deepStrictEqual(eve.skillSlots.map((skill) => skill.name), ["Basic attack", "Manifestation of Shub-Niggurath", "Black Goat", "Palingenesis"]);
  const sourceVoiceBundleName = `AB_UI_UNIT_VOICE_${source.base.m_UnitStrID}`;
  const voiceDirectory = path.join(clientRoot, "Data", "StreamingAssets", "voice");
  const sourceVoiceBundlePath = path.join(voiceDirectory, `${sourceVoiceBundleName.toLowerCase()}.vkor`);
  fs.mkdirSync(voiceDirectory, { recursive: true });
  fs.writeFileSync(sourceVoiceBundlePath, "voice-bundle");

  const results = [];
  for (let suffix = 2; suffix <= 8; suffix += 1) {
    results.push(maker.create({
      projectId: "lee-yumi-2-test",
      projectName: "Full Squad Lee Yumi",
      sourceUnitStrId: source.base.m_UnitStrID,
      unitId: source.nextUnitId + suffix - 2,
      unitStrId: `NKM_UNIT_C_POLICE_LEE_YUMI_${suffix}`,
      displayName: `Lee Yumi ${suffix}`,
      cloneSkills: false,
      cloneSkins: true,
    }));
  }
  const result = results[0];
  const sourceBundle = `${source.base.m_SpineIllustName.toLowerCase()}.asset`;
  fs.writeFileSync(path.join(clientRoot, "Data", "StreamingAssets", sourceBundle), "source-bundle");
  const spineSources = [
    store.writeAssetSource("lee-yumi-2-test", "unit-spine/custom/illustration/custom.skel", Buffer.from("skel")),
    store.writeAssetSource("lee-yumi-2-test", "unit-spine/custom/illustration/custom.atlas", Buffer.from("custom.png\nsize: 1,1\n")),
    store.writeAssetSource("lee-yumi-2-test", "unit-spine/custom/illustration/custom.png", Buffer.from("png")),
  ];
  const attached = maker.attachSpine({ projectId: "lee-yumi-2-test", sourceUnitStrId: source.base.m_UnitStrID, unitStrId: result.unit.strId, role: "illustration", sources: spineSources });
  const project = store.readProject("lee-yumi-2-test");
  const clonedBase = project.patches.find((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE" && patch.value.m_UnitID === result.unit.id).value;
  assert.strictEqual(clonedBase.m_CommonVoiceBundle, source.base.m_UnitStrID);
  assert.strictEqual(clonedBase.m_FirstOpenTag, source.base.m_FirstOpenTag);
  assert.strictEqual(clonedBase.m_BasicOpenTag, source.base.m_BasicOpenTag);
  const sharedVoiceAliasName = `ab_ui_unit_voice_${result.unit.strId.toLowerCase()}.vkor`;
  const sharedVoiceAlias = path.join(project.root, "assets", "bundles", sharedVoiceAliasName);
  assert(fs.existsSync(sharedVoiceAlias));
  assert.deepStrictEqual(
    transformCounterSideBundleHeader(transformCounterSideBundleHeader(fs.readFileSync(sharedVoiceAlias), sharedVoiceAliasName), sourceVoiceBundlePath),
    fs.readFileSync(sourceVoiceBundlePath)
  );
  assert.strictEqual(patchedSpine[0].kind, "graphic");
  assert.strictEqual(attached.bundle.name, `AB_UNIT_ILLUST_${result.unit.strId}`);
  assert.strictEqual(patchedSpine[0].sourceAssetName, source.base.m_SpineIllustName);
  assert.strictEqual(attached.bundle.assetName, `AB_UNIT_ILLUST_${result.unit.strId}`);
  assert.strictEqual(project.patches.find((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE" && patch.value.m_UnitID === result.unit.id).value.m_SpineIllustName, `AB_UNIT_ILLUST_${result.unit.strId}`);
  assert.strictEqual(result.unit.id, 26048);
  assert.strictEqual(result.clonedSkins, 3);
  assert.deepStrictEqual(result.registrations, {
    LUA_COLLECTION_TEAMUP_TEMPLET: 1,
    LUA_UNIT_EQUIP_RECOMMEND: 1,
    LUA_VOICE_ACTOR_NAME_TEMPLET_V2: 1,
    LUA_DESC_TEMPLET: 4,
    LUA_NEGOTIATE_SPEECH: 4,
    LUA_REACTOR_SKILL_TEMPLET: 2,
    LUA_REACTOR_TEMPLET: 1,
    LUA_INTERACTION_UNIT_TEMPLET: 2,
  });
  assert.strictEqual(project.tables.length, 7);
  assert.strictEqual(project.strings.MODSIDE_UNIT_NAME_26048, "Lee Yumi 2");
  assert.strictEqual(project.strings.MODSIDE_UNIT_NAME_26054, "Lee Yumi 8");
  assert.deepStrictEqual(project.patches.filter((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE").map((patch) => patch.value.m_UnitID).sort((a, b) => a - b), [26048, 26049, 26050, 26051, 26052, 26053, 26054]);
  const skinIds = project.patches.filter((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET").map((patch) => patch.value.m_SkinID);
  assert.strictEqual(skinIds.length, 21);
  assert.strictEqual(new Set(skinIds).size, 21);
  const collectionIndexes = project.patches.filter((patch) => patch.table.tableName === "LUA_COLLECTION_UNIT_TEMPLET").map((patch) => patch.value.Idx);
  assert.strictEqual(new Set(collectionIndexes).size, 7);
  for (const tableName of ["LUA_COLLECTION_TEAMUP_TEMPLET", "LUA_UNIT_EQUIP_RECOMMEND", "LUA_VOICE_ACTOR_NAME_TEMPLET_V2"]) {
    assert.strictEqual(project.patches.filter((patch) => patch.table.tableName === tableName).length, 7);
  }
  assert.strictEqual(project.patches.filter((patch) => patch.table.tableName === "LUA_DESC_TEMPLET").length, 28);
  assert.strictEqual(project.patches.filter((patch) => patch.table.tableName === "LUA_NEGOTIATE_SPEECH").length, 28);
  assert.strictEqual(project.patches.filter((patch) => patch.table.tableName === "LUA_REACTOR_SKILL_TEMPLET").length, 14);
  assert.strictEqual(project.patches.filter((patch) => patch.table.tableName === "LUA_REACTOR_TEMPLET").length, 7);
  assert.strictEqual(project.patches.filter((patch) => patch.table.tableName === "LUA_INTERACTION_UNIT_TEMPLET").length, 14);
  const packs = maker.projects().projects;
  assert.strictEqual(packs.find((pack) => pack.id === project.manifest.id).unitCount, 7);
  assert.strictEqual(packs.find((pack) => pack.id === project.manifest.id).units.length, 7);
  const patchCount = project.patches.length;
  assert.strictEqual(maker.syncProject(project.manifest.id).project.patches.length, patchCount);

  const editableSkill = source.base.m_SkillStrID1;
  const editableVoiceGroup = source.voiceGroups.find((group) => !group.skin && group.lines.length);
  const editableVoice = editableVoiceGroup.lines[0];
  extractedVoiceId = editableVoice;
  const extractedVoices = maker.extractVoices(source.base.m_UnitStrID);
  assert.strictEqual(extractedVoices.extractedCount, 1);
  assert(extractedVoices.assets.KOR[editableVoice].endsWith(`${editableVoice}.wav`));
  const addedVoice = `${editableVoiceGroup.key}_99`;
  const replacedVoice = "VOICE_MODSIDE_LEE_YUMI_BATTLE_LINE_1";
  const studioResult = maker.create({
    projectId: "unit-studio-test",
    projectName: "Unit Studio Test",
    sourceUnitStrId: source.base.m_UnitStrID,
    unitId: source.nextUnitId + 7,
    unitStrId: "NKM_UNIT_C_POLICE_LEE_YUMI_STUDIO",
    displayName: "Studio Yumi",
    rarity: "NUG_SR",
    base: { m_NKM_UNIT_ROLE_TYPE: "NURT_RANGER", m_bAirUnit: true },
    stat: { m_RespawnCost: 5, m_StatData: { m_Stat: { NST_HP: 9999 } } },
    cloneSkills: true,
    cloneSkins: true,
    skinIds: [source.skins[0].m_SkinID],
    skillOverrides: { [editableSkill]: { common: { m_NKM_SKILL_TYPE: "NST_ATTACK" }, levels: { 1: { m_fEmpowerFactor: 9.9 } } } },
    skillText: { [editableSkill]: { name: "Studio Strike", descriptions: { 1: "A creator-authored basic attack." } } },
    voiceMap: { [editableVoice]: replacedVoice },
    voiceAdditions: { [editableVoiceGroup.key]: [addedVoice] },
    collection: { intro: "A custom Collection introduction." },
    profile: {
      biography: "A custom employee biography.", teamTitle: "Special investigator", teamName: "Custom Police", gender: "Female",
      birthMonth: 4, birthDay: 12, height: 171, speciality: "Case analysis", likes: "Coffee", dislikes: "Cold cases",
      combatLevel: "Exceptional", commandLevel: "Excellent", crf: { maxPower: 91, resistance: 82, dependence: 73, reinforced: 64, control: 55 },
    },
    details: {
      title: "Studio Officer", description: "A completely creator-authored unit description.", teamName: "Studio Team", voiceActors: { KOR: "Studio Actor" },
      skins: [{ sourceSkinId: source.skins[0].m_SkinID, title: "Studio Uniform", description: "A creator-authored skin description." }],
      resultLines: [{ sourceSkinId: 0, fields: { m_ResultWinDesc: "A creator-authored victory line." } }],
      negotiationLines: [{ sourceSkinId: 0, fields: { m_NegoStanby: "A creator-authored negotiation line." } }],
      reactor: { name: "Studio Reactor", description: "A creator-authored Reactor description.", levels: [{ sourceIdx: 109901, title: "Studio level", description: "A creator-authored Reactor level." }] },
      associations: [source.details.associations[0]],
    },
  });
  const studioProject = store.readProject(studioResult.project.manifest.id);
  const studioBase = studioProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE").value;
  const studioStat = studioProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_STAT_TEMPLET").value;
  const studioSkillRows = studioProject.patches.filter((patch) => patch.table.tableName === "LUA_UNIT_SKILL_TEMPLET" && patch.value.m_UnitSkillStrID === studioBase.m_SkillStrID1).map((patch) => patch.value);
  assert.strictEqual(studioBase.m_NKM_UNIT_GRADE, "NUG_SR");
  assert.strictEqual(studioBase.m_NKM_UNIT_ROLE_TYPE, "NURT_RANGER");
  assert.strictEqual(studioBase.m_bAirUnit, true);
  assert.strictEqual(studioStat.m_RespawnCost, 5);
  assert.strictEqual(studioStat.m_StatData.m_Stat.NST_HP, 9999);
  assert.strictEqual(studioStat.m_StatData.m_Stat.NST_DEF, source.stat.m_StatData.m_Stat.NST_DEF);
  assert.deepStrictEqual(studioStat.m_StatData.m_StatPerLevel, source.stat.m_StatData.m_StatPerLevel);
  assert.strictEqual(studioProject.patches.filter((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET").length, 1);
  assert.strictEqual(studioSkillRows.length, 5);
  assert.strictEqual(studioSkillRows.find((row) => row.m_Level === 1).m_fEmpowerFactor, 9.9);
  assert.strictEqual(studioSkillRows.find((row) => row.m_Level === 2).m_fEmpowerFactor, 1.05);
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_SKILL_NAME_26055_1, "Studio Strike");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_SKILL_DESC_26055_1_1, "A creator-authored basic attack.");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_COLLECTION_INTRO_26055, "A custom Collection introduction.");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_PROFILE_BIO_26055, "A custom employee biography.");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_TITLE_26055, "Studio Officer");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_DESC_26055, "A completely creator-authored unit description.");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_TEAM_NAME_26055, "Studio Team");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_VOICE_ACTOR_KOR_26055, "Studio Actor");
  assert.strictEqual(studioProject.strings[`MODSIDE_UNIT_SKIN_TITLE_26055_${source.skins[0].m_SkinID}`], "Studio Uniform");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_RESULT_26055_0_m_ResultWinDesc, "A creator-authored victory line.");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_NEGOTIATION_26055_0_m_NegoStanby, "A creator-authored negotiation line.");
  assert.strictEqual(studioProject.strings.MODSIDE_UNIT_REACTOR_NAME_26055, "Studio Reactor");
  assert.strictEqual(studioProject.patches.filter((patch) => patch.table.tableName === "LUA_DESC_TEMPLET").length, 2);
  assert.strictEqual(studioProject.patches.filter((patch) => patch.table.tableName === "LUA_NEGOTIATE_SPEECH").length, 2);
  assert.strictEqual(studioProject.patches.filter((patch) => patch.table.tableName === "LUA_INTERACTION_UNIT_TEMPLET").length, 1);
  const studioCollection = studioProject.patches.find((patch) => patch.table.tableName === "LUA_COLLECTION_UNIT_TEMPLET").value;
  const studioProfile = studioProject.patches.find((patch) => patch.table.tableName === "LUA_COLLECTION_V2_EMPLOYEE").value;
  assert.strictEqual(studioCollection.m_UnitID, studioBase.m_UnitID);
  assert.strictEqual(studioProfile.UnitID, studioBase.m_UnitID);
  assert.strictEqual(studioProfile.BirthValueStrID, "SI_COLLECTION_PROFILE_VALUE_BIRTH@@SI_DATE_MONTH_4@@12");
  assert.strictEqual(studioProfile.HeightValueStrID, "SI_COLLECTION_PROFILE_VALUE_HEIGHT@@171");
  assert.strictEqual(studioProfile.CRFSubAmount_5, 55);
  const studioBattle = JSON.stringify(studioProject.tables.find((table) => table.table.tableName === studioBase.m_UnitStrID).compiled.root);
  assert(studioBattle.includes(replacedVoice));
  assert(studioBattle.includes(addedVoice));
  assert(!studioBattle.includes(`\"${editableVoice}\"`));
  const editableStudio = maker.inspectProjectUnit(studioResult.project.manifest.id, studioBase.m_UnitStrID);
  assert.strictEqual(editableStudio.edit.displayName, "Studio Yumi");
  assert.strictEqual(editableStudio.edit.cloneSkills, true);
  assert.strictEqual(editableStudio.edit.collection.intro, "A custom Collection introduction.");
  assert.strictEqual(editableStudio.edit.profile.biography, "A custom employee biography.");
  assert.strictEqual(editableStudio.edit.profile.birthDay, "12");
  assert.strictEqual(editableStudio.edit.details.title, "Studio Officer");
  assert.strictEqual(editableStudio.edit.details.skins[0].title, "Studio Uniform");
  assert.strictEqual(editableStudio.edit.details.resultLines.find((line) => !line.sourceSkinId).fields.m_ResultWinDesc, "A creator-authored victory line.");
  assert.strictEqual(editableStudio.edit.details.associations.length, 1);
  assert.strictEqual(editableStudio.edit.skillSlots[0].customName, "Studio Strike");
  assert.strictEqual(editableStudio.edit.voiceGroups.find((group) => group.key === editableVoiceGroup.key).lines.find((line) => line.source === editableVoice).value, replacedVoice);
  const studioPatchCount = studioProject.patches.length;
  const updatedStudio = maker.update({
    projectId: studioResult.project.manifest.id,
    sourceUnitStrId: source.base.m_UnitStrID,
    unitId: studioBase.m_UnitID,
    unitStrId: studioBase.m_UnitStrID,
    displayName: "Studio Yumi Updated",
    rarity: "NUG_SSR",
    base: { m_NKM_UNIT_ROLE_TYPE: "NURT_SNIPER", m_UnitID: 999, m_UnitStrID: "NKM_UNIT_BROKEN" },
    stat: { m_RespawnCost: 6, m_StatData: { m_Stat: { NST_HP: 12345 } } },
    cloneSkills: true,
    cloneSkins: true,
    skinIds: [source.skins[0].m_SkinID],
    skillOverrides: { [editableSkill]: { common: { m_NKM_SKILL_TYPE: "NST_ATTACK", m_UnitSkillID: 999 }, levels: { 1: { m_fEmpowerFactor: 8.8, IDX: 999 } } } },
    skillText: { [editableSkill]: { name: "Updated Studio Strike", descriptions: { 1: "An updated creator-authored attack." } } },
    skinOverrides: { [source.skins[0].m_SkinID]: { m_SkinID: 999, m_SkinStrID: "BROKEN_SKIN" } },
    voiceMap: { [editableVoice]: replacedVoice },
    voiceAdditions: { [editableVoiceGroup.key]: [addedVoice] },
    collection: { intro: "Updated Collection introduction.", raw: { Idx: 999, m_UnitID: 999, m_UnitStrID: "BROKEN_COLLECTION_ID" } },
    profile: { biography: "Updated employee biography.", height: 172, raw: { UnitID: 999, OpenTag: "BROKEN_TAG", NameValue: "BROKEN_NAME" } },
    details: {
      title: "Updated Studio Officer", description: "Updated creator-authored unit description.",
      skins: [{ sourceSkinId: source.skins[0].m_SkinID, title: "Updated Studio Uniform", description: "Updated skin description." }],
      resultLines: [{ sourceSkinId: 0, fields: { m_ResultWinDesc: "Updated victory line." } }],
      negotiationLines: [{ sourceSkinId: 0, fields: { m_NegoStanby: "Updated negotiation line." } }],
      reactor: { name: "Updated Studio Reactor", levels: [{ sourceIdx: 109901, description: "Updated Reactor level." }] }, associations: [],
    },
  });
  assert.strictEqual(updatedStudio.project.patches.length, studioPatchCount - 1);
  const updatedProject = store.readProject(studioResult.project.manifest.id);
  const updatedBase = updatedProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE").value;
  const updatedSkill = updatedProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_SKILL_TEMPLET" && patch.value.m_Level === 1).value;
  const updatedSkin = updatedProject.patches.find((patch) => patch.table.tableName === "LUA_SKIN_TEMPLET").value;
  assert.strictEqual(updatedBase.m_UnitID, studioBase.m_UnitID);
  assert.strictEqual(updatedBase.m_UnitStrID, studioBase.m_UnitStrID);
  assert.notStrictEqual(updatedSkill.m_UnitSkillID, 999);
  assert.notStrictEqual(updatedSkill.IDX, 999);
  assert.notStrictEqual(updatedSkin.m_SkinID, 999);
  assert.notStrictEqual(updatedSkin.m_SkinStrID, "BROKEN_SKIN");
  assert.strictEqual(updatedProject.strings[studioBase.m_Name], "Studio Yumi Updated");
  assert.strictEqual(updatedProject.strings.MODSIDE_UNIT_SKILL_NAME_26055_1, "Updated Studio Strike");
  const updatedCollection = updatedProject.patches.find((patch) => patch.table.tableName === "LUA_COLLECTION_UNIT_TEMPLET").value;
  const updatedProfile = updatedProject.patches.find((patch) => patch.table.tableName === "LUA_COLLECTION_V2_EMPLOYEE").value;
  assert.strictEqual(updatedCollection.Idx, studioCollection.Idx);
  assert.strictEqual(updatedCollection.m_UnitID, studioBase.m_UnitID);
  assert.strictEqual(updatedCollection.m_UnitStrID, studioBase.m_UnitStrID);
  assert.strictEqual(updatedProfile.UnitID, studioBase.m_UnitID);
  assert.strictEqual(updatedProfile.OpenTag, updatedBase.m_FirstOpenTag);
  assert.strictEqual(updatedProfile.NameValue, updatedBase.m_Name);
  assert.strictEqual(updatedProfile.HeightValueStrID, "SI_COLLECTION_PROFILE_VALUE_HEIGHT@@172");
  assert.strictEqual(updatedProject.strings.MODSIDE_UNIT_COLLECTION_INTRO_26055, "Updated Collection introduction.");
  assert.strictEqual(updatedProject.strings.MODSIDE_UNIT_PROFILE_BIO_26055, "Updated employee biography.");
  assert.strictEqual(updatedProject.strings.MODSIDE_UNIT_TITLE_26055, "Updated Studio Officer");
  assert.strictEqual(updatedProject.strings[`MODSIDE_UNIT_SKIN_TITLE_26055_${source.skins[0].m_SkinID}`], "Updated Studio Uniform");
  assert.strictEqual(updatedProject.strings.MODSIDE_UNIT_RESULT_26055_0_m_ResultWinDesc, "Updated victory line.");
  assert.strictEqual(updatedProject.strings.MODSIDE_UNIT_NEGOTIATION_26055_0_m_NegoStanby, "Updated negotiation line.");
  assert.strictEqual(updatedProject.patches.filter((patch) => patch.table.tableName === "LUA_INTERACTION_UNIT_TEMPLET").length, 0);
  assert.strictEqual(updatedProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_STAT_TEMPLET").value.m_StatData.m_Stat.NST_HP, 12345);
  assert.strictEqual(maker.inspectProjectUnit(studioResult.project.manifest.id, studioBase.m_UnitStrID).edit.skillSlots[0].customName, "Updated Studio Strike");
  const replacementSource = store.writeAssetSource(studioResult.project.manifest.id, "unit-voice/uploads/replacement.mp3", Buffer.from("mp3"));
  const preparedVoice = maker.prepareVoiceBundle({
    projectId: studioResult.project.manifest.id,
    sourceUnitStrId: source.base.m_UnitStrID,
    unitStrId: studioBase.m_UnitStrID,
    sourceBundleName: sourceVoiceBundleName,
    language: "KOR",
    voiceMap: { [editableVoice]: replacedVoice },
    replacements: [{ voiceId: replacedVoice, source: replacementSource }],
  });
  assert.strictEqual(preparedVoice.bundleName, `ab_ui_unit_voice_${studioBase.m_UnitStrID.toLowerCase()}.vkor`);
  assert(preparedVoice.assets.some((asset) => asset.endsWith(`${replacedVoice}.mp3`)));
  const header = Buffer.from("UnityFS fixture bundle bytes");
  const encryptedHeader = transformCounterSideBundleHeader(header, preparedVoice.bundleName);
  assert.notDeepStrictEqual(encryptedHeader, header);
  assert.deepStrictEqual(transformCounterSideBundleHeader(encryptedHeader, preparedVoice.bundleName), header);

  const shipSource = maker.inspect("NKM_SHIP_A_GLEIPNIR_T_1");
  const shipResult = maker.create({
    projectId: "ship-template-test",
    projectName: "Ship Template Test",
    sourceUnitStrId: shipSource.base.m_UnitStrID,
    unitId: shipSource.nextUnitId,
    unitStrId: "NKM_SHIP_A_GLEIPNIR_TEMPLATE",
    displayName: "Template Gleipnir",
    cloneSkills: false,
    cloneSkins: false,
  });
  assert.strictEqual(shipResult.unit.unitType, "NUT_SHIP");
  assert.strictEqual(shipResult.unit.strId, "NKM_SHIP_A_GLEIPNIR_TEMPLATE");
  assert(store.readProject(shipResult.project.manifest.id).tables.some((table) => table.table.tableName === "NKM_SHIP_A_GLEIPNIR_TEMPLATE"));

  const sharedSkillId = maker.catalog().nextUnitId;
  const sharedSkillResult = maker.create({
    projectId: "shared-skill-edit-test",
    projectName: "Shared Skill Edit Test",
    sourceUnitStrId: source.base.m_UnitStrID,
    unitId: sharedSkillId,
    unitStrId: "NKM_UNIT_C_POLICE_LEE_YUMI_SHARED_EDIT",
    displayName: "Shared Skill Yumi",
    cloneSkills: false,
    cloneSkins: false,
  });
  assert.strictEqual(maker.inspectProjectUnit(sharedSkillResult.project.manifest.id, sharedSkillResult.unit.strId).edit.cloneSkills, false);
  const clonedSharedSkills = maker.update({
    projectId: sharedSkillResult.project.manifest.id,
    sourceUnitStrId: source.base.m_UnitStrID,
    unitId: sharedSkillId,
    unitStrId: sharedSkillResult.unit.strId,
    displayName: "Shared Skill Yumi",
    cloneSkills: true,
    cloneSkins: false,
    skinIds: [],
  });
  const sharedSkillProject = store.readProject(clonedSharedSkills.project.manifest.id);
  const sharedSkillBase = sharedSkillProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE").value;
  assert.strictEqual(clonedSharedSkills.clonedSkills, true);
  assert.strictEqual(maker.inspectProjectUnit(clonedSharedSkills.project.manifest.id, sharedSkillBase.m_UnitStrID).edit.cloneSkills, true);
  assert.strictEqual(sharedSkillProject.patches.filter((patch) => patch.table.tableName === "LUA_UNIT_SKILL_TEMPLET").length, 20);
  assert(["m_SkillStrID1", "m_SkillStrID2", "m_SkillStrID3", "m_SkillStrID4"].every((field) => sharedSkillBase[field] !== source.base[field]));

  const unitUi = fs.readFileSync(path.join(rootDir, "modside-ui", "src", "Units.jsx"), "utf8");
  assert.match(unitUi, /Base stats/);
  assert.match(unitUi, /Growth per level/);
  assert.match(unitUi, /Skill setup/);
  assert.match(unitUi, /Battle voice lines/);
  assert.match(unitUi, /Add line/);
  assert.match(unitUi, /Awakened unit/);
  assert.match(unitUi, /Collection information/);
  assert.match(unitUi, /Employee profile/);
  assert.match(unitUi, /Profile evaluation/);
  assert.match(unitUi, /m_UnitSkillIcon/);
  assert.match(unitUi, /Clone selected skins/);
  assert.match(unitUi, /Expert overrides/);
  assert.match(unitUi, /Every CounterSide employee, NPC, enemy, and boss template is available/);
  assert.match(unitUi, /Enemies & bosses/);
  assert.match(unitUi, /All unit text/);
  assert.match(unitUi, /Office associations/);
  assert.match(unitUi, /IntersectionObserver/);
  assert.match(unitUi, /loading="lazy"/);
  assert.match(unitUi, /AppearanceAssetPreview/);
  assert.match(unitUi, /unit-maker\/voices\/extract/);
  assert.match(unitUi, /accept="\.mp3,audio\/mpeg"/);
  assert.match(unitUi, /Build selected MP3 voice bundles/);
  assert.match(unitUi, /unit-maker\/projects/);
  assert.match(unitUi, /unit-maker\/project-unit/);
  assert.match(unitUi, /Add unit to pack/);
  assert.match(unitUi, /Add another unit/);
  assert.match(unitUi, /Save unit/);
  assert.match(unitUi, /CombatHost will load and validate every unit before the next battle/);
  const assetViewer = fs.readFileSync(path.join(rootDir, "server", "assetViewer.js"), "utf8");
  assert.match(assetViewer, /unit-maker\/voice-bundle/);
  assert.match(assetViewer, /encryptHeader: true/);
  assert.match(assetViewer, /unit-maker\/update/);
  assert.match(assetViewer, /publishActiveProject/);

  const inactiveCollision = maker.create({
    projectId: "lee-yumi-collision-test",
    projectName: "Inactive collision",
    sourceUnitStrId: source.base.m_UnitStrID,
    unitId: result.unit.id,
    unitStrId: "NKM_UNIT_C_POLICE_LEE_YUMI_INACTIVE_COLLISION",
    displayName: "Inactive Lee Yumi",
    cloneSkills: false,
    cloneSkins: false,
  });
  assert.strictEqual(inactiveCollision.unit.id, result.unit.id, "inactive projects should not block Unit:Side authoring");
  const runtime = createModRuntime({ rootDir, env, modStore: store });
  assert.throws(() => runtime.applyProfile({ enabled: [project.manifest.id, inactiveCollision.project.manifest.id] }), /Unit ID 26048 .*enabled mods/);
  assert.deepStrictEqual(runtime.readProfile().enabled, [], "failed collision enable must restore the previous profile");
  const applied = runtime.applyProfile({ enabled: [project.manifest.id] });
  assert.strictEqual(applied.built.fullTableCount, 7);
  assert.strictEqual(applied.built.stringCount, 7);
  assert.deepStrictEqual(applied.built.unitIds, [26048, 26049, 26050, 26051, 26052, 26053, 26054]);
  assert.strictEqual(env.CS_MOD_UNIT_IDS, "26048,26049,26050,26051,26052,26053,26054");
  assert(fs.existsSync(path.join(runtime.currentRoot, "Assetbundles", "ab_script_unit_data_unit_templet", "luac", `${result.unit.strId}.lua`)));
  assert(fs.existsSync(path.join(runtime.currentRoot, "ClientAssetBundles", `ab_unit_illust_${result.unit.strId.toLowerCase()}`)));
  assert(fs.existsSync(path.join(runtime.currentRoot, "ClientAssetBundles", sharedVoiceAliasName)));
  assert.strictEqual(fs.readFileSync(path.join(runtime.currentRoot, "Strings", "MODSIDE_UNIT_NAME_26048.txt"), "utf8"), "Lee Yumi 2");

  const boss = maker.inspect("NKM_MOB_BOSS_EVENT_ESPR2_NEPHILIM_ESPR2");
  assert.strictEqual(boss.base.m_UnitID, 230461);
  assert.deepStrictEqual(boss.sourceTables, { base: "LUA_UNIT_TEMPLET_BASE2", stat: "LUA_UNIT_STAT_TEMPLET2" });
  const bossResult = maker.create({
    projectId: "chillingchaser-test",
    projectName: "ChillingChaser",
    sourceUnitStrId: boss.base.m_UnitStrID,
    unitId: maker.catalog().nextUnitId,
    unitStrId: "NKM_UNIT_CHILLING_CHASER_TEST",
    displayName: "The Chilling Chaser",
    cloneSkills: false,
    cloneSkins: false,
  });
  const bossProject = store.readProject(bossResult.project.manifest.id);
  const playableBoss = bossProject.patches.find((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE" && patch.value?.m_UnitID === bossResult.unit.id)?.value;
  assert(playableBoss, "boss clones must register in the playable base table");
  assert.strictEqual(playableBoss.m_bMonster, false);
  assert.strictEqual(playableBoss.m_bContractable, true);
  assert.strictEqual(playableBoss.m_SpriteBundleName, boss.base.m_SpriteBundleName);
  assert(bossProject.patches.some((patch) => patch.table.tableName === "LUA_UNIT_STAT_TEMPLET" && patch.value?.m_UnitStrID === bossResult.unit.strId));
  assert(!bossProject.patches.some((patch) => patch.table.tableName === "LUA_UNIT_TEMPLET_BASE2" || patch.table.tableName === "LUA_UNIT_STAT_TEMPLET2"));
  assert(bossProject.patches.some((patch) => patch.table.tableName === "LUA_COLLECTION_UNIT_TEMPLET" && patch.value?.m_UnitID === bossResult.unit.id));
  assert(bossProject.patches.some((patch) => patch.table.tableName === "LUA_COLLECTION_V2_EMPLOYEE" && patch.value?.UnitID === bossResult.unit.id));
  assert(bossProject.patches.some((patch) => patch.table.tableName === "LUA_MONSTER_TAG_TEMPLET" && patch.value?.m_UnitID === bossResult.unit.id));
  const bossRuntime = runtime.applyProfile({ enabled: [bossProject.manifest.id] });
  assert.deepStrictEqual(bossRuntime.built.unitIds, [bossResult.unit.id]);
  assert(fs.existsSync(path.join(runtime.currentRoot, "Assetbundles", "ab_script_unit_data_unit_templet", "luac", `${bossResult.unit.strId}.lua`)));
  const squadCheck = spawnSync(process.execPath, ["-e", `
    const assert = require("assert");
    const { grantUnit, setDeckUnit } = require("./modules/unit");
    const user = { userUid: "1" };
    const unit = grantUnit(user, ${bossResult.unit.id});
    assert(unit, "playable boss was rejected by the roster");
    const result = setDeckUnit(user, { deckType: 1, index: 0 }, 0, unit.unitUid);
    assert.strictEqual(result.deck.unitUids[0], unit.unitUid);
  `], { cwd: rootDir, env: { ...process.env, CS_MOD_TABLES_DIR: runtime.currentRoot }, encoding: "utf8" });
  assert.strictEqual(squadCheck.status, 0, squadCheck.stderr || squadCheck.stdout);

  const imported = { army: { units: { "1": { unitUid: "1", unitId: 999999, level: 130, exp: 17 } } } };
  ensureArmy(imported);
  assert.strictEqual(imported.army.units["1"].level, 130);
  assert.strictEqual(imported.army.units["1"].exp, 17);
  const account = { level: 999, exp: "10", totalExp: "10" };
  grantUserExp(account, 5);
  assert.strictEqual(account.level, 999);
  assert.strictEqual(account.exp, "15");
  console.log("[check-mod-unit-maker] ok");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
