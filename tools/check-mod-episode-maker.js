const assert = require("assert");
const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildCutsceneRecords, createModEpisodeMaker } = require("../modules/mod-episode-maker");
const { createModRuntime } = require("../modules/mod-loader");
const { createModProjectStore } = require("../modules/mod-projects");
const { findGameplayTableEntry } = require("../modules/gameplay-jsons");
const cutsceneStartHandler = require("../packet-handlers/1200-cutscene-dungeon-start-req");
const cutsceneClearHandler = require("../packet-handlers/1202-cutscene-dungeon-clear-req");
const { createInput } = require("./create-dating-event-mod");

const rootDir = path.join(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-episode-maker-"));
try {
  const luacOnlyRoot = path.join(temporary, "luac-only");
  const luacOnlyStage = path.join(luacOnlyRoot, "Assetbundles", "ab_script", "luac", "LUA_STAGE_TEMPLET.luac");
  fs.mkdirSync(path.dirname(luacOnlyStage), { recursive: true });
  fs.writeFileSync(luacOnlyStage, "fixture");
  assert.strictEqual(findGameplayTableEntry("ab_script", "LUA_STAGE_TEMPLET.json", { rootDir, env: { CS_GAMEPLAY_TABLES_DIR: luacOnlyRoot } }).fileName, "LUA_STAGE_TEMPLET.luac");
  const protectedFiles = [
    "gameplay-jsons/StreamingAssets/ab_script/luac/LUA_STAGE_TEMPLET.json",
    "gameplay-jsons/StreamingAssets/ab_script/luac/LUA_EPISODE_TEMPLET.json",
    "gameplay-jsons/StreamingAssets/ab_script/luac/LUA_EPISODE_TEMPLET_V2.json",
    "gameplay-jsons/StreamingAssets/ab_script/luac/LUA_EPISODE_SUMMARY_TEMPLET.json",
    "gameplay-jsons/StreamingAssets/ab_script/luac/LUA_CUTSCENE_FILE_LIST.json",
    "gameplay-jsons/StreamingAssets/ab_script/luac/LUA_CUTSCENE_CHAR_TEMPLET.json",
    "gameplay-jsons/StreamingAssets/ab_script_dungeon_templet/luac/LUA_DUNGEON_TEMPLET_BASE.json",
  ].map((file) => path.join(rootDir, file));
  const before = Object.fromEntries(protectedFiles.map((file) => [file, sha256(file)]));
  const store = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "mods") });
  const assetRoot = path.join(temporary, "extracted-assets", "all");
  const background = path.join(assetRoot, "Assetbundles", "ab_ui_nkm_ui_cutscen_bg_cafe", "CutsceneBG16x9", "AB_UI_NKM_UI_CUTSCEN_BG_CAFE.png");
  const actor = path.join(assetRoot, "Data", "StreamingAssets", "ab_unit_illust_nkm_unit_c_police_lee_yumi", "Texture2D", "UNIT_ILLUST_C_POLICE_LEE_YUMI.png");
  const administrator = path.join(assetRoot, "Data", "StreamingAssets", "ab_inven_icon_unit", "Texture2D", "AB_INVEN_ICON_NKM_NPC_ADMINISTRATOR.png");
  const music = path.join(assetRoot, "Data", "StreamingAssets", "ab_music", "off_duty", "AudioClip", "OFF_DUTY", "OFF_DUTY.wav");
  for (const file of [background, actor, administrator, music]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); }
  const maker = createModEpisodeMaker({ rootDir, modStore: store, assetRoot });
  const catalog = maker.catalog("Yumi");
  assert.strictEqual(catalog.assetsAvailable, true);
  assert.strictEqual(catalog.episodes.find((episode) => episode.id === 12 && episode.category === "EC_MAINSTREAM").label, "EP. 10 — The Qliphoth Game Part 2");
  assert.strictEqual(catalog.backgrounds.find((item) => item.id === "CAFE").path.endsWith("AB_UI_NKM_UI_CUTSCEN_BG_CAFE.png"), true);
  assert.strictEqual(catalog.music.find((item) => item.id === "OFF_DUTY").type, "audio");
  assert.match(maker.asset("actor", "YUMI_POLICE_NULL_NULL").path, /UNIT_ILLUST_C_POLICE_LEE_YUMI\.png$/);
  assert.match(maker.asset("actor", "USER_ADMIN_NULL_NULL").path, /AB_INVEN_ICON_NKM_NPC_ADMINISTRATOR\.png$/);
  assert.match(maker.catalog("USER_ADMIN_NULL_NULL").previewAssets.USER_ADMIN_NULL_NULL, /AB_INVEN_ICON_NKM_NPC_ADMINISTRATOR\.png/);
  const layout = maker.layout(2, "EC_MAINSTREAM");
  assert.strictEqual(layout.episode.category, "EC_MAINSTREAM");
  assert.strictEqual(layout.readOnly, true);
  assert.strictEqual(layout.stages.filter((stage) => stage.difficulty === "NORMAL").at(-1).stageIndex, 5);
  assert.strictEqual(layout.stages.some((stage) => stage.difficulty === "HARD"), true);
  assert.deepStrictEqual(layout.episode.variants.map((variant) => variant.difficulty).sort(), ["HARD", "NORMAL"]);
  const laterLayouts = [12, 13, 14, 15, 16, 17].map((episodeId) => maker.layout(episodeId, "EC_MAINSTREAM"));
  assert.strictEqual(laterLayouts.every((episode) => episode.stages.some((stage) => stage.difficulty === "NORMAL")), true);
  assert.strictEqual(laterLayouts.every((episode) => episode.stages.some((stage) => stage.difficulty === "HARD")), true);
  const episodeTenLayout = laterLayouts[0];
  const episodeTenStage = maker.inspectStage(episodeTenLayout.stages.find((stage) => stage.difficulty === "NORMAL").stageId, 12, "EC_MAINSTREAM", "NORMAL");
  assert.strictEqual(episodeTenStage.raw.placementTable, "LUA_STAGE_TEMPLET");
  const baseStage = maker.inspectStage(11211, 2, "EC_MAINSTREAM", "NORMAL");
  assert.strictEqual(baseStage.name, "Stage 1");
  assert.strictEqual(baseStage.kind, "COMBAT");
  assert.strictEqual(baseStage.readOnly, true);
  assert.strictEqual(baseStage.ids.dungeonId, 1004);
  assert.strictEqual(baseStage.cutscenes[0].slot, "before");
  assert.strictEqual(baseStage.cutscenes[0].id, "EP1_ACT1_STAGE1_START");
  assert.strictEqual(baseStage.cutscenes[0].registered, true);
  assert.strictEqual(baseStage.cutscenes[0].frames[0].dialogue, "... I often think of our fate.");
  assert.strictEqual(baseStage.raw.placement.m_StageID, 11211);
  assert.strictEqual(baseStage.clientUi.title, "Experienced Recruit");
  assert.strictEqual(baseStage.override.operation, "override");
  assert.strictEqual(baseStage.override.stageId, 11211);
  assert.throws(() => maker.inspectStage(999999999, 2, "EC_MAINSTREAM", "NORMAL"), /was not found/);
  const overrideStage = { ...baseStage.override, title: "Experienced Recruit Remix", stageDescription: "A protected-stage override.", stageCharacter: "NKM_UNIT_C_POLICE_LEE_YUMI", music: "BATTLE_NORMAL_02" };
  const override = maker.create({ projectId: "phase2-stage-override", projectName: "Phase 2 Stage Override", category: "EC_MAINSTREAM", episodeId: 2, stages: [overrideStage] });
  assert.strictEqual(override.authoring.stages[0].operation, "override");
  assert.strictEqual(override.authoring.stages[0].base.objectId, baseStage.objectId);
  assert.strictEqual(override.project.patches.length, 3);
  assert.strictEqual(override.project.tables.length, 0);
  assert.strictEqual(override.project.strings[baseStage.clientUi.titleKey], "Experienced Recruit Remix");
  assert.strictEqual(override.project.strings[baseStage.clientUi.descriptionId], "A protected-stage override.");
  assert.strictEqual(override.project.patches.every((item) => item.key.value === 11211 || item.key.value === 1004), true);
  const overrideRuntime = createModRuntime({ rootDir, modStore: store, runtimeRoot: path.join(temporary, "override-runtime"), profilePath: path.join(temporary, "override-profile.json") });
  overrideRuntime.writeProfile({ enabled: ["phase2-stage-override"] });
  overrideRuntime.build();
  const effectiveStageRows = JSON.parse(fs.readFileSync(path.join(overrideRuntime.currentRoot, "Assetbundles", "ab_script", "luac", "LUA_STAGE_TEMPLET.json"), "utf8")).records;
  assert.strictEqual(effectiveStageRows.length, 2496);
  assert.strictEqual(effectiveStageRows.find((row) => row.m_StageID === 11211).m_StageCharStr, "NKM_UNIT_C_POLICE_LEE_YUMI");
  const effectiveDungeonRows = JSON.parse(fs.readFileSync(path.join(overrideRuntime.currentRoot, "Assetbundles", "ab_script_dungeon_templet", "luac", "LUA_DUNGEON_TEMPLET_BASE.json"), "utf8")).records;
  assert.strictEqual(effectiveDungeonRows.length, 5145);
  assert.strictEqual(effectiveDungeonRows.find((row) => row.m_DungeonID === 1004).m_MusicAssetName, "BATTLE_NORMAL_02");
  assert.strictEqual(fs.readFileSync(path.join(overrideRuntime.currentRoot, "Strings", `${baseStage.clientUi.titleKey}.txt`), "utf8"), "Experienced Recruit Remix");
  assert.throws(() => maker.create({ projectId: "phase2-bad-identity", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...overrideStage, stageId: 11212 }] }), /selected base stage changed/);
  assert.throws(() => maker.create({ projectId: "phase2-bad-slot", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...baseStage.override, stageIndex: 2 }] }), /already reserves stage index/);
  const resetOverride = maker.create({ projectId: "phase2-stage-override", projectName: "Phase 2 Stage Override", category: "EC_MAINSTREAM", episodeId: 2, stages: [baseStage.override] });
  assert.strictEqual(resetOverride.project.patches.length, 0);
  assert.deepStrictEqual(resetOverride.project.strings, {});

  const cloneStore = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "stage-studio-mods") });
  const cloneMaker = createModEpisodeMaker({ rootDir, modStore: cloneStore, assetRoot });
  const cloneBase = cloneMaker.inspectStage(11211, 2, "EC_MAINSTREAM", "NORMAL");
  const cloneSlot = cloneMaker.suggest(2, "EC_MAINSTREAM");
  const cloneInput = {
    ...cloneSlot,
    operation: "clone",
    sourceObjectId: cloneBase.objectId,
    sourceStageId: cloneBase.ids.stageId,
    sourceEpisodeId: cloneBase.placement.episodeId,
    sourceCategory: cloneBase.placement.category,
    sourceDifficulty: cloneBase.placement.difficulty,
    title: "Experienced Recruit Clone",
    stageDescription: "A full-record Stage Studio clone.",
    stageCharacter: cloneBase.clientUi.avatar,
    music: "BATTLE_NORMAL_02",
  };
  const cloned = cloneMaker.create({ projectId: "phase3-stage-clone", projectName: "Phase 3 Stage Clone", category: "EC_MAINSTREAM", episodeId: 2, stages: [cloneInput] });
  assert.strictEqual(cloned.authoring.stages[0].operation, "clone");
  assert.strictEqual(cloned.authoring.stages[0].kind, "stage-clone");
  assert.strictEqual(cloned.authoring.stages[0].base.objectId, cloneBase.objectId);
  assert.strictEqual(cloned.authoring.stages[0].cutsceneReadOnly, true);
  assert.strictEqual(cloned.authoring.stages[0].cutsceneRefs[0].id, "EP1_ACT1_STAGE1_START");
  assert.strictEqual(cloned.project.patches.length, 3);
  assert.strictEqual(cloned.project.tables.length, 0);
  const clonedPlacement = cloned.project.patches.find((item) => item.table.tableName === "LUA_EPISODE_TEMPLET").value;
  const clonedStage = cloned.project.patches.find((item) => item.table.tableName === "LUA_STAGE_TEMPLET").value;
  const clonedDungeon = cloned.project.patches.find((item) => item.table.tableName === "LUA_DUNGEON_TEMPLET_BASE").value;
  assert.strictEqual(clonedPlacement.m_StageID, cloneSlot.stageId);
  assert.strictEqual(clonedStage.m_StageType, cloneBase.raw.stage.m_StageType);
  assert.strictEqual(clonedStage.m_StageBattleStrID, cloneSlot.dungeonStrId);
  assert.strictEqual(clonedDungeon.m_DungeonID, cloneSlot.dungeonId);
  assert.strictEqual(clonedDungeon.m_DungeonType, cloneBase.raw.dungeon.m_DungeonType);
  assert.strictEqual(clonedDungeon.m_CutScenStrIDBefore, cloneBase.raw.dungeon.m_CutScenStrIDBefore);
  assert.strictEqual(cloned.project.strings[`MODSIDE_STAGE_TITLE_${cloneSlot.stageId}`], "Experienced Recruit Clone");
  assert.throws(() => cloneMaker.create({ projectId: "phase3-stale-clone", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...cloneInput, sourceObjectId: "base-stage:changed" }] }), /stage template changed/);
  assert.throws(() => cloneMaker.create({ projectId: "phase3-cross-episode", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...cloneInput, episodeId: 3 }] }), /must belong to the selected episode/);
  const sharedStage = cloneMaker.inspectStage(12211, 2, "EC_MAINSTREAM", "HARD");
  assert.strictEqual(sharedStage.raw.dungeon, null);
  assert.throws(() => cloneMaker.create({ projectId: "phase3-shared-template", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...cloneInput, sourceObjectId: sharedStage.objectId, sourceStageId: sharedStage.ids.stageId, sourceEpisodeId: 2, sourceCategory: "EC_MAINSTREAM", sourceDifficulty: "HARD" }] }), /shared non-dungeon battle template/);

  const forkStore = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "cutscene-studio-mods") });
  const forkMaker = createModEpisodeMaker({ rootDir, modStore: forkStore, assetRoot });
  const forkBase = forkMaker.inspectStage(11211, 2, "EC_MAINSTREAM", "NORMAL");
  const forkScenes = forkBase.cutscenes.flatMap((cutscene) => cutscene.frames.map((frame) => ({ ...frame, cutsceneSlot: cutscene.slot })));
  forkScenes[0].dialogue = "A source-preserving Story:Side edit.";
  forkScenes[0].transition = "CUT";
  const forked = forkMaker.create({ projectId: "phase4-cutscene-fork", projectName: "Phase 4 Cutscene Fork", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...forkBase.override, cutsceneReadOnly: false, forkCutscenes: true, scenes: forkScenes }] });
  const forkAuthoring = forked.authoring.stages[0];
  assert.strictEqual(forkAuthoring.forkCutscenes, true);
  assert.strictEqual(forkAuthoring.cutsceneReadOnly, false);
  assert.strictEqual(forkAuthoring.cutsceneRefs[0].sourceId, "EP1_ACT1_STAGE1_START");
  assert.match(forkAuthoring.cutsceneRefs[0].strId, /^MODSIDE_PHASE4_CUTSCENE_FORK_11211_BEFORE$/);
  assert.strictEqual(forked.project.tables.length, 1);
  const forkRecords = forked.project.tables[0].compiled.records;
  assert.strictEqual(forkRecords.length, forkBase.cutscenes[0].events.length);
  assert.strictEqual(forkRecords[0].m_CutScenStrID, forkAuthoring.cutsceneRefs[0].strId);
  assert.strictEqual(forkRecords[2].m_fWaitTime, forkBase.cutscenes[0].events[2].m_fWaitTime);
  assert.strictEqual(forkRecords.find((row) => row.m_CutScenKey_Talk).m_Talk_ENG, "A source-preserving Story:Side edit.");
  assert.strictEqual(forkRecords.find((row) => row.m_CutScenKey_Talk).m_bFadeIn, false);
  assert.strictEqual(forked.project.patches.find((item) => item.table.tableName === "LUA_DUNGEON_TEMPLET_BASE").value.m_CutScenStrIDBefore, forkAuthoring.cutsceneRefs[0].strId);
  const forkSnapshot = JSON.stringify(forkStore.readProject("phase4-cutscene-fork").tables[0].compiled.records);
  assert.throws(() => forkMaker.create({ projectId: "phase4-cutscene-fork", projectName: "Phase 4 Cutscene Fork", category: "EC_MAINSTREAM", episodeId: 2, stages: [{ ...forkBase.override, cutsceneReadOnly: false, forkCutscenes: true, scenes: forkScenes.slice(1) }] }), /must keep its .* dialogue frames/);
  assert.strictEqual(JSON.stringify(forkStore.readProject("phase4-cutscene-fork").tables[0].compiled.records), forkSnapshot);

  const episodeStore = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "episode-studio-mods") });
  const episodeMaker = createModEpisodeMaker({ rootDir, modStore: episodeStore, assetRoot });
  const episodeLayout = episodeMaker.layout(2, "EC_MAINSTREAM");
  const episodeDefinition = JSON.parse(JSON.stringify(episodeLayout.episode.definition));
  episodeDefinition.title = "Experienced Recruit: Remastered";
  episodeDefinition.backgroundMusic = "OFF_DUTY";
  episodeDefinition.layoutPanX = 1800;
  const episodeOverride = episodeMaker.create({ projectId: "phase5-episode-override", projectName: "Phase 5 Episode Override", category: "EC_MAINSTREAM", episodeId: 2, episode: episodeDefinition, stages: [] });
  assert.strictEqual(episodeOverride.authoring.episode.custom, false);
  assert.strictEqual(episodeOverride.project.patches.filter((item) => item.table.tableName === "LUA_EPISODE_TEMPLET_V2").length, 2);
  const normalBaseEpisode = episodeLayout.episode.variants.find((variant) => variant.difficulty === "NORMAL").raw;
  const normalEpisodePatch = episodeOverride.project.patches.find((item) => item.table.tableName === "LUA_EPISODE_TEMPLET_V2" && item.value.m_Difficulty === "NORMAL");
  assert.strictEqual(normalEpisodePatch.key.field, "__index");
  assert.strictEqual(Number.isSafeInteger(normalEpisodePatch.key.value), true);
  assert.strictEqual(normalEpisodePatch.value.m_EpisodeID, normalBaseEpisode.m_EpisodeID);
  assert.strictEqual(normalEpisodePatch.value.m_EpisodeStrID, normalBaseEpisode.m_EpisodeStrID);
  assert.strictEqual(normalEpisodePatch.value.m_BG_Music, "OFF_DUTY");
  assert.strictEqual(episodeOverride.project.strings[`MODSIDE_EPISODE_TITLE_${normalBaseEpisode.m_EpisodeID}`], "Experienced Recruit: Remastered");
  assert.throws(() => episodeMaker.create({ projectId: "phase5-bad-tag", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, episode: { ...episodeDefinition, openTag: "TAG_CHANGED" }, stages: [] }), /stable base-game identity/);
  assert.throws(() => episodeMaker.create({ projectId: "phase5-bad-hard", projectName: "Bad", category: "EC_MAINSTREAM", episodeId: 2, episode: { ...episodeDefinition, hardMode: { ...episodeDefinition.hardMode, enabled: false } }, stages: [] }), /availability cannot be changed/);
  const episodeRuntime = createModRuntime({ rootDir, modStore: episodeStore, runtimeRoot: path.join(temporary, "episode-runtime"), profilePath: path.join(temporary, "episode-profile.json") });
  episodeRuntime.writeProfile({ enabled: ["phase5-episode-override"] });
  episodeRuntime.build();
  const effectiveEpisodeRows = JSON.parse(fs.readFileSync(path.join(episodeRuntime.currentRoot, "Assetbundles", "ab_script", "luac", "LUA_EPISODE_TEMPLET_V2.json"), "utf8")).records.filter((row) => Number(row.m_EpisodeID) === 2 && row.m_EPCategory === "EC_MAINSTREAM");
  assert.deepStrictEqual(effectiveEpisodeRows.map((row) => row.m_Difficulty).sort(), ["HARD", "NORMAL"]);
  assert.strictEqual(effectiveEpisodeRows.find((row) => row.m_Difficulty === "NORMAL").m_EpisodeTitle, `MODSIDE_EPISODE_TITLE_${normalBaseEpisode.m_EpisodeID}`);
  const resetEpisode = episodeMaker.create({ projectId: "phase5-episode-override", projectName: "Phase 5 Episode Override", category: "EC_MAINSTREAM", episodeId: 2, stages: [] });
  assert.strictEqual(resetEpisode.project.patches.length, 0);
  assert.deepStrictEqual(resetEpisode.project.strings, {});
  const substreamCatalog = episodeMaker.catalog().episodes.find((episode) => episode.category === "EC_SIDESTORY");
  const substreamDefinition = JSON.parse(JSON.stringify(episodeMaker.layout(substreamCatalog.id, substreamCatalog.category).episode.definition));
  substreamDefinition.title += " Story:Side";
  const substreamOverride = episodeMaker.create({ projectId: "phase5-substream-override", projectName: "Phase 5 Substream Override", category: substreamCatalog.category, episodeId: substreamCatalog.id, episode: substreamDefinition, stages: [] });
  const substreamRows = substreamOverride.project.patches.filter((item) => item.table.tableName === "LUA_EPISODE_TEMPLET_V2");
  assert.strictEqual(substreamRows.length, 2);
  assert.strictEqual(substreamRows.every((item) => item.key.field === "__index"), true);
  assert.notStrictEqual(substreamRows[0].key.value, substreamRows[1].key.value);
  assert.strictEqual(maker.suggest(2, "EC_MAINSTREAM").stageIndex, 7);
  assert.throws(() => maker.create({ ...createInput(), projectId: "collision-test", stageId: 11245 }), /already exists in base data/);
  assert.strictEqual(fs.existsSync(path.join(store.modsRoot, "collision-test")), false);
  assert.throws(() => maker.create({ ...createInput(), projectId: "slot-collision-test", stageId: 91246, dungeonId: 90106, cutsceneId: 990011246, stageIndex: 6, stageStrId: "STAGE_MAINSTREAM_COLLISION_TEST", dungeonStrId: "DUNGEON_COLLISION_TEST", cutsceneStrId: "CUTSCENE_COLLISION_TEST" }), /already reserves stage index/);
  assert.throws(() => maker.create({ ...createInput(), unlockDungeonId: 10106 }), /cannot unlock from its own clear state/);
  const result = maker.create(createInput());
  assert.strictEqual(result.authoring.placement.category, "EC_MAINSTREAM");
  assert.strictEqual(result.authoring.placement.episodeId, 2);
  assert.strictEqual(result.authoring.placement.stageIndex, 7);
  assert.strictEqual(result.authoring.unlockDungeonId, 0);
  assert.strictEqual(result.authoring.clientUi.title, createInput().title);
  assert.strictEqual(result.authoring.clientUi.description, createInput().title);
  assert.strictEqual(result.authoring.clientUi.avatar, "NKM_UNIT_C_POLICE_LEE_YUMI");
  assert.strictEqual(result.authoring.clientUi.stageNumber, 3);
  assert.strictEqual(result.authoring.scenes.length, 47);
  assert.strictEqual(result.authoring.scenes[1].speakerName, "Administrator");
  assert.strictEqual(result.authoring.scenes[1].dimActors, true);
  assert.strictEqual(result.authoring.scenes[1].transition, "FADE");
  assert.strictEqual(result.authoring.scenes[46].dialogue, "Better.");
  const talks = result.cutscene.records.filter((record) => record.m_CutScenKey_Talk);
  assert.strictEqual(talks.length, 47);
  assert.strictEqual(talks[0].m_Pos, "C");
  assert.strictEqual(talks[0].m_Face, "UNIT_IDLE");
  assert.strictEqual(result.cutscene.records.some((record) => record.m_Face === "UNIT_NORMAL"), false);
  assert.strictEqual(talks[1].m_Pos, undefined);
  assert.match(talks[1].m_CharStrID, /SPEAKER_ADMINISTRATOR$/);
  const project = store.readProject(result.project.manifest.id);
  assert.strictEqual(project.patches.length, 5);
  assert.strictEqual(project.patches.every((item) => item.table.fileName.endsWith(".json")), true);
  assert.strictEqual(project.tables.length, 1);
  const episodePatch = project.patches.find((item) => item.table.tableName === "LUA_EPISODE_TEMPLET").value;
  const stagePatch = project.patches.find((item) => item.table.tableName === "LUA_STAGE_TEMPLET").value;
  const dungeonPatch = project.patches.find((item) => item.table.tableName === "LUA_DUNGEON_TEMPLET_BASE").value;
  assert.strictEqual(episodePatch.m_EPThumbnail, "MAINSTREAM_EPISODE_01");
  assert.strictEqual(episodePatch.m_ACT_BG_Image, undefined);
  assert.strictEqual(episodePatch.m_bSupportUnit, undefined);
  assert.strictEqual(stagePatch.m_StageReqItemID, undefined);
  assert.strictEqual(stagePatch.m_StageReqItemCount, undefined);
  assert.strictEqual(stagePatch.m_StageBasicUnlockType, "SBUT_OPEN");
  assert.strictEqual(stagePatch.m_UnlockReqType, "SURT_PLAYER_LEVEL");
  assert.strictEqual(stagePatch.m_UnlockReqValue, 1);
  assert.strictEqual(stagePatch.m_StageDesc, "MODSIDE_STAGE_DESCRIPTION_11246");
  assert.strictEqual(stagePatch.m_StageCharStr, "NKM_UNIT_C_POLICE_LEE_YUMI");
  assert.strictEqual(dungeonPatch.m_DungeonName, "MODSIDE_STAGE_TITLE_11246");
  assert.notStrictEqual(stagePatch.m_UnlockReqValue, dungeonPatch.m_DungeonID);
  assert.strictEqual(dungeonPatch.m_DungeonTempletFileName, undefined);
  assert.strictEqual(dungeonPatch.m_DungeonMapStrID, undefined);
  assert.strictEqual(dungeonPatch.m_DGMissionType_1, undefined);
  assert.strictEqual(dungeonPatch.m_DGMissionType_2, undefined);
  assert.ok(fs.existsSync(path.join(project.root, "assets", "source", "episode-maker", "project.json")));
  assert.strictEqual(store.exportProject(project.manifest.id).readUInt32LE(0), 0x04034b50);

  const runtime = createModRuntime({ rootDir, modStore: store, runtimeRoot: path.join(temporary, "runtime"), profilePath: path.join(temporary, "profile.json") });
  runtime.writeProfile({ enabled: [project.manifest.id] });
  const built = runtime.build().built;
  assert.strictEqual(built.patchCount, 5);
  assert.strictEqual(built.fullTableCount, 1);
  const cutscene = JSON.parse(fs.readFileSync(path.join(runtime.currentRoot, "Assetbundles", "ab_script_cutscene", "luac", "EP1_ACT4_DATING_EVENT_1.json"), "utf8"));
  assert.strictEqual(cutscene.records.filter((record) => record.m_CutScenKey_Talk).length, 47);
  const cutsceneLua = fs.readFileSync(path.join(runtime.currentRoot, "Assetbundles", "ab_script_cutscene", "luac", "EP1_ACT4_DATING_EVENT_1.lua"), "utf8");
  assert.doesNotMatch(cutsceneLua, /= nil\s*$/);
  assert.match(cutsceneLua, /m_CutScenProcessKey=1/);
  const stage = JSON.parse(childProcess.execFileSync(process.execPath, ["-e", "const stage=require('./stages/mainStoryStage').getMainStoryStageByStageId(11246);process.stdout.write(JSON.stringify(stage));"], { cwd: rootDir, env: { ...process.env, CS_MOD_TABLES_DIR: runtime.currentRoot } }));
  assert.strictEqual(stage.dungeonID, 10106);
  assert.strictEqual(stage.cutsceneOnly, true);
  const replayAcks = [];
  const replayContext = {
    config: {},
    constants: { CUTSCENE_DUNGEON_START_ACK: 1201 },
    readCutsceneDungeonReq: () => 10106,
    resolveCutsceneDungeonId: (_socket, dungeonId) => dungeonId,
    buildCutsceneDungeonStartAckPayload: (dungeonId) => Buffer.from(String(dungeonId)),
    sendGameResponse: (_socket, _packet, _packetId, payload) => replayAcks.push(payload.toString()),
  };
  const clearedSocket = { session: { user: { dungeonClear: { 10106: { cleared: true } } } } };
  cutsceneStartHandler.handle(replayContext, clearedSocket, { payload: Buffer.alloc(0) });
  cutsceneStartHandler.handle(replayContext, clearedSocket, { payload: Buffer.alloc(0) });
  assert.deepStrictEqual(replayAcks, ["10106", "10106"]);
  const clearCalls = [];
  cutsceneClearHandler.handle({
    config: {},
    constants: { CUTSCENE_DUNGEON_CLEAR_ACK: 1203 },
    readCutsceneDungeonReq: () => 10106,
    resolveCutsceneClearDungeonId: (_socket, dungeonId) => dungeonId,
    recordPersistentCutsceneView: (_socket, dungeonId) => clearCalls.push(["view", dungeonId]),
    recordGameplayUnlockClear: (_socket, dungeonId) => clearCalls.push(["unlock", dungeonId]),
    recordTutorialCutsceneClear: () => false,
    recordMainStoryDungeonClear: (_socket, dungeonId) => clearCalls.push(["clear", dungeonId]),
    buildCutsceneDungeonClearAckPayload: (dungeonId, user) => Buffer.from(`${dungeonId}:${user ? "first" : "replay"}`),
    sendGameResponse: (_socket, _packet, packetId, payload) => clearCalls.push(["ack", packetId, payload.toString()]),
  }, clearedSocket, { payload: Buffer.alloc(0) });
  assert.deepStrictEqual(clearCalls, [["view", 10106], ["ack", 1203, "10106:replay"]]);
  const firstClearCalls = [];
  cutsceneClearHandler.handle({
    config: {},
    constants: { CUTSCENE_DUNGEON_CLEAR_ACK: 1203 },
    readCutsceneDungeonReq: () => 10106,
    resolveCutsceneClearDungeonId: (_socket, dungeonId) => dungeonId,
    recordPersistentCutsceneView: (_socket, dungeonId) => firstClearCalls.push(["view", dungeonId]),
    recordGameplayUnlockClear: (_socket, dungeonId) => firstClearCalls.push(["unlock", dungeonId]),
    recordTutorialCutsceneClear: () => false,
    recordMainStoryDungeonClear: (_socket, dungeonId) => firstClearCalls.push(["clear", dungeonId]),
    buildCutsceneDungeonClearAckPayload: (dungeonId, user) => Buffer.from(`${dungeonId}:${user ? "first" : "replay"}`),
    sendGameResponse: (_socket, _packet, packetId, payload) => firstClearCalls.push(["ack", packetId, payload.toString()]),
  }, { session: { user: {} } }, { payload: Buffer.alloc(0) });
  assert.deepStrictEqual(firstClearCalls, [["view", 10106], ["unlock", 10106], ["clear", 10106], ["ack", 1203, "10106:first"]]);
  assert.deepStrictEqual(Object.fromEntries(protectedFiles.map((file) => [file, sha256(file)])), before);
  const timeline = buildCutsceneRecords({ cutsceneId: 1, cutsceneStrId: "TIMELINE", background: "CAFE", music: "", speakerIds: new Map(), scenes: [
    { speakerName: "A", speakerActorId: "A", dialogue: "One", voiceLine: "", background: "", music: "", transition: "FADE", fadeTime: 1, effects: [], actors: [] },
    { speakerName: "A", speakerActorId: "A", dialogue: "Two", voiceLine: "", background: "OFFICE", music: "BGM_OFFICE", transition: "CUT", fadeTime: 1, effects: [], actors: [] },
  ] });
  assert(timeline.some((record) => record.m_BGFileName === "OFFICE" && record.m_fFadeTime === 0));
  assert(timeline.some((record) => record.m_StartBGMFileName === "BGM_OFFICE"));

  const multiStore = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "multi-mods") });
  const multiMaker = createModEpisodeMaker({ rootDir, modStore: multiStore, assetRoot });
  const stageOne = multiMaker.suggest(2, "EC_MAINSTREAM", 0);
  const stageTwo = multiMaker.suggest(2, "EC_MAINSTREAM", 1);
  const scene = { speakerName: "Lee Yumi", speakerActorId: "YUMI_POLICE_NULL_NULL", dialogue: "Stage dialogue", actors: [{ actorId: "YUMI_POLICE_NULL_NULL", position: "C", animation: "UNIT_IDLE" }] };
  const multi = multiMaker.create({ projectId: "multi-stage-episode", projectName: "Multi-stage Episode", category: "EC_MAINSTREAM", episodeId: 2, stages: [
    { ...stageOne, title: "Stage One", scenes: [scene] },
    { ...stageTwo, title: "Stage Two", unlockDungeonId: stageOne.dungeonId, scenes: [{ ...scene, dialogue: "Second stage" }] },
  ] });
  assert.strictEqual(multi.authoring.stages.length, 2);
  assert.strictEqual(multi.project.tables.length, 2);
  assert.strictEqual(multiMaker.projects()[0].stageCount, 2);
  assert.strictEqual(multiMaker.readProject("multi-stage-episode").authoring.stages[1].title, "Stage Two");
  const nextSuggestion = multiMaker.suggest(2, "EC_MAINSTREAM");
  assert.strictEqual([stageOne.stageId, stageTwo.stageId].includes(nextSuggestion.stageId), false);
  assert.strictEqual([stageOne.dungeonId, stageTwo.dungeonId].includes(nextSuggestion.dungeonId), false);
  const copied = multiMaker.copyProject("multi-stage-episode", { id: "multi-stage-copy", name: "Multi-stage Copy" });
  const copiedStages = copied.authoring.stages;
  assert.strictEqual(copied.project.manifest.name, "Multi-stage Copy");
  assert.deepStrictEqual(copiedStages.map((stage) => stage.ids.stageId).some((id) => [stageOne.stageId, stageTwo.stageId].includes(id)), false);
  assert.deepStrictEqual(copiedStages.map((stage) => stage.ids.dungeonId).some((id) => [stageOne.dungeonId, stageTwo.dungeonId].includes(id)), false);
  assert.strictEqual(copiedStages[1].unlockDungeonId, copiedStages[0].ids.dungeonId);
  assert.strictEqual(copiedStages[0].placement.stageIndex > multi.authoring.stages[1].placement.stageIndex, true);
  assert.strictEqual(copied.remapped.length >= 12, true);
  assert.strictEqual(multiMaker.readProject("multi-stage-episode").authoring.stages[1].unlockDungeonId, stageOne.dungeonId);
  assert.throws(() => multiMaker.create({ projectId: "duplicate-stage-episode", projectName: "Duplicate", category: "EC_MAINSTREAM", episodeId: 2, stages: [stageOne, stageOne] }), /used by more than one stage/);
  assert.strictEqual(fs.existsSync(path.join(multiStore.modsRoot, "duplicate-stage-episode")), false);

  const customStore = createModProjectStore({ rootDir, modsRoot: path.join(temporary, "custom-episode-mods") });
  const customMaker = createModEpisodeMaker({ rootDir, modStore: customStore, assetRoot });
  const customCatalog = customMaker.catalog().episodes.find((episode) => episode.custom);
  assert.strictEqual(customCatalog.id, 18);
  assert.match(customCatalog.label, /Episode 16/);
  assert.strictEqual(customMaker.layout(18, "EC_MAINSTREAM").stages.length, 0);
  const customSuggestion = customMaker.suggest(18, "EC_MAINSTREAM");
  assert.strictEqual(customSuggestion.actId, 1);
  assert.strictEqual(customSuggestion.stageIndex, 1);
  const customDefinition = JSON.parse(JSON.stringify(customCatalog.definition));
  Object.assign(customDefinition, { title: "Episode 16", name: "A New Mainstream", description: "A blank custom episode.", actCount: 2, backgroundMusic: "OFF_DUTY", layoutPanX: 1400, layoutPanY: 700 });
  customDefinition.completionRewards[0] = { completeRate: 100, rewardType: "RT_MISC", rewardId: 101, rewardValue: 250 };
  customDefinition.resourceChange = { missionCondition: "SURT_CLEAR_DUNGEON", missionValue: 1017471, backgroundMusic: "BGM_THEMA_CA_ANAPILIS" };
  Object.assign(customDefinition.hardMode, { enabled: true, actCount: 1, backgroundMusic: "BGM_THEMA_CS_ORCHESTRA", completionRewards: [{ completeRate: 100, rewardType: "RT_MISC", rewardId: 101, rewardValue: 500 }] });
  const blank = customMaker.create({ projectId: "mainstream-episode-16", projectName: "Episode 16", category: "EC_MAINSTREAM", episodeId: 18, episode: customDefinition, stages: [] });
  assert.strictEqual(blank.authoring.schemaVersion, 3);
  assert.strictEqual(blank.authoring.stages.length, 0);
  assert.strictEqual(blank.authoring.episode.layoutPanX, 1400);
  assert.strictEqual(blank.project.patches.length, 3);
  assert.strictEqual(blank.project.tables.length, 0);
  assert.strictEqual(blank.project.patches.filter((item) => item.table.tableName === "LUA_EPISODE_TEMPLET_V2").length, 2);
  const inactiveEpisodeCollision = customMaker.create({ projectId: "episode-16-collision", projectName: "Collision", category: "EC_MAINSTREAM", episodeId: 18, episode: customDefinition, stages: [] });
  assert.strictEqual(inactiveEpisodeCollision.project.manifest.id, "episode-16-collision", "inactive projects should not block Story:Side authoring");
  assert.throws(() => customMaker.create({ projectId: "episode-16-self-link", projectName: "Bad link", category: "EC_MAINSTREAM", episodeId: 18, episode: { ...customDefinition, connectedEpisodeIds: [18] }, stages: [] }), /cannot connect to itself/);
  assert.throws(() => customMaker.create({ projectId: "episode-16-bad-pan", projectName: "Bad pan", category: "EC_MAINSTREAM", episodeId: 18, episode: { ...customDefinition, layoutPanX: 5001 }, stages: [] }), /Horizontal layout pan/);
  assert.throws(() => customMaker.create({ projectId: "episode-16-bad-tags", projectName: "Bad tags", category: "EC_MAINSTREAM", episodeId: 18, episode: { ...customDefinition, hardMode: { ...customDefinition.hardMode, openTag: customDefinition.openTag } }, stages: [] }), /different open tags/);
  assert.throws(() => customMaker.create({ projectId: "episode-16-bad-rewards", projectName: "Bad rewards", category: "EC_MAINSTREAM", episodeId: 18, episode: { ...customDefinition, completionRewards: [{}, { completeRate: 100, rewardType: "RT_MISC", rewardId: 101, rewardValue: 1 }] }, stages: [] }), /cannot contain gaps/);
  assert.throws(() => customMaker.create({ projectId: "episode-16-bad-resource", projectName: "Bad resource", category: "EC_MAINSTREAM", episodeId: 18, episode: { ...customDefinition, resourceChange: { missionCondition: "SURT_CLEAR_DUNGEON", missionValue: 1 } }, stages: [] }), /condition, value, and music together/);
  const customScene = { speakerName: "Lee Yumi", speakerActorId: "YUMI_POLICE_NULL_NULL", dialogue: "Episode 16 begins.", actors: [{ actorId: "YUMI_POLICE_NULL_NULL", position: "C", animation: "UNIT_IDLE" }] };
  assert.throws(() => customMaker.create({ projectId: "mainstream-episode-16", projectName: "Bad act", category: "EC_MAINSTREAM", episodeId: 18, episode: customDefinition, stages: [{ ...customSuggestion, actId: 3, title: "Bad", scenes: [customScene] }] }), /exceeds the configured act count/);
  assert.strictEqual(customStore.readProject("mainstream-episode-16").patches.length, 3);
  const customWithStage = customMaker.create({ projectId: "mainstream-episode-16", projectName: "Episode 16", category: "EC_MAINSTREAM", episodeId: 18, episode: customDefinition, stages: [{ ...customSuggestion, actId: 2, title: "First Stage", scenes: [customScene] }] });
  assert.strictEqual(customWithStage.project.patches.length, 7);
  assert.strictEqual(customWithStage.project.tables.length, 1);
  const customRuntime = createModRuntime({ rootDir, modStore: customStore, runtimeRoot: path.join(temporary, "custom-runtime"), profilePath: path.join(temporary, "custom-profile.json") });
  assert.throws(() => customRuntime.applyProfile({ enabled: ["mainstream-episode-16", "episode-16-collision"] }), /Episode (?:summary )?ID 18 .*enabled mods/);
  assert.deepStrictEqual(customRuntime.readProfile().enabled, [], "failed collision enable must restore the previous profile");
  customRuntime.applyProfile({ enabled: ["mainstream-episode-16"] });
  const effectiveEpisodes = JSON.parse(fs.readFileSync(path.join(customRuntime.currentRoot, "Assetbundles", "ab_script", "luac", "LUA_EPISODE_TEMPLET_V2.json"), "utf8")).records.filter((row) => Number(row.m_EpisodeID) === 18);
  assert.deepStrictEqual(effectiveEpisodes.map((row) => row.m_Difficulty).sort(), ["HARD", "NORMAL"]);
  const effectiveNormalEpisode = effectiveEpisodes.find((row) => row.m_Difficulty === "NORMAL");
  const effectiveHardEpisode = effectiveEpisodes.find((row) => row.m_Difficulty === "HARD");
  assert.strictEqual(effectiveNormalEpisode.m_BG_Music, "OFF_DUTY");
  assert.strictEqual(effectiveNormalEpisode.m_CompleteRate_1, 100);
  assert.strictEqual(effectiveNormalEpisode.m_RewardValue_1, 250);
  assert.strictEqual(effectiveNormalEpisode.Change_Resource_BG_Music, "BGM_THEMA_CA_ANAPILIS");
  assert.strictEqual(effectiveHardEpisode.m_bNoCollectionCutscene, true);
  assert.strictEqual(effectiveHardEpisode.m_CollectionOpenTag, undefined);
  assert.strictEqual(effectiveHardEpisode.m_RewardValue_1, 500);
  const effectiveSummary = JSON.parse(fs.readFileSync(path.join(customRuntime.currentRoot, "Assetbundles", "ab_script", "luac", "LUA_EPISODE_SUMMARY_TEMPLET.json"), "utf8")).records.find((row) => Number(row.EpisodeID) === 18);
  assert.strictEqual(effectiveSummary.m_Shortcut, "EC_MAINSTREAM@18");
  const customRuntimeStage = JSON.parse(childProcess.execFileSync(process.execPath, ["-e", `const stage=require('./stages/mainStoryStage').getMainStoryStageByStageId(${customSuggestion.stageId});process.stdout.write(JSON.stringify(stage));`], { cwd: rootDir, env: { ...process.env, CS_MOD_TABLES_DIR: customRuntime.currentRoot } }));
  assert.strictEqual(customRuntimeStage.episodeId, 18);
  assert.strictEqual(customRuntimeStage.episodeNumber, 16);
  assert.strictEqual(customRuntimeStage.cutsceneOnly, true);
  const customClear = JSON.parse(childProcess.execFileSync(process.execPath, ["-e", `const story=require('./stages/mainStoryStage');const user={};const saved=story.recordMainStoryDungeonClearForUser(user,${customSuggestion.dungeonId},${customSuggestion.stageId},{gameTime:3});process.stdout.write(JSON.stringify({saved,dungeon:user.dungeonClear[String(${customSuggestion.dungeonId})],stage:user.mainStory.stages[String(${customSuggestion.stageId})]}));`], { cwd: rootDir, env: { ...process.env, CS_MOD_TABLES_DIR: customRuntime.currentRoot } }));
  assert.strictEqual(customClear.saved, true);
  assert.strictEqual(customClear.dungeon.stageId, customSuggestion.stageId);
  assert.strictEqual(customClear.stage.completed, true);
  const blankAgain = customMaker.create({ projectId: "mainstream-episode-16", projectName: "Episode 16", category: "EC_MAINSTREAM", episodeId: 18, episode: customDefinition, stages: [] });
  assert.strictEqual(blankAgain.project.patches.length, 3);
  assert.strictEqual(blankAgain.project.tables.length, 0);
  customRuntime.build();
  const removedStage = childProcess.execFileSync(process.execPath, ["-e", `const stage=require('./stages/mainStoryStage').getMainStoryStageByStageId(${customSuggestion.stageId});process.stdout.write(JSON.stringify(stage||null));`], { cwd: rootDir, env: { ...process.env, CS_MOD_TABLES_DIR: customRuntime.currentRoot } }).toString();
  assert.strictEqual(removedStage, "null");
  const summaryPatch = customStore.readProject("mainstream-episode-16").patches.find((item) => item.table.tableName === "LUA_EPISODE_SUMMARY_TEMPLET");
  customStore.removePatch("mainstream-episode-16", summaryPatch.patchId);
  assert.throws(() => customRuntime.build(), /needs exactly one summary registration/);
  const storySource = fs.readFileSync(path.join(rootDir, "modside-ui", "src", "Story.jsx"), "utf8");
  assert.match(storySource, /episode-maker\/create/);
  assert.match(storySource, /mods\/\$\{encodeURIComponent\(result\.project\.manifest\.id\)\}\/validate/);
  assert.match(storySource, /location\.href = `\$\{basePath\}\?view=loader`/);
  console.log("[check-mod-episode-maker] ok");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
