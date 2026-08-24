const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { createAssetViewer } = require("../server/assetViewer");
const { EDITOR_SCRIPT, normalizeBuildTarget } = require("../modules/unity-bundle-compiler");

async function main() {
  assert.strictEqual(normalizeBuildTarget(), "windows");
  assert.strictEqual(normalizeBuildTarget("android"), "android");
  assert.throws(() => normalizeBuildTarget("ios"), /windows or android/);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-asset-viewer-"));
  const tableDir = path.join(tempDir, "gameplay-jsons", "StreamingAssets", "ab_script", "luac");
  const unitTableDir = path.join(tempDir, "gameplay-jsons", "StreamingAssets", "ab_script_unit_data", "luac");
  const itemTableDir = path.join(tempDir, "gameplay-jsons", "StreamingAssets", "ab_script_item_templet", "luac");
  const assetRoot = path.join(tempDir, "extracted-assets", "all");
  const spineViewerRoot = path.join(tempDir, "SpineViewer", "dist");
  const spineTextDir = path.join(assetRoot, "Assetbundles", "hero", "TextAsset");
  const spineTextureDir = path.join(assetRoot, "Assetbundles", "hero", "Texture2D");
  const audioDir = path.join(assetRoot, "Assetbundles", "sounds", "AudioClip");
  const materialDir = path.join(assetRoot, "Assetbundles", "materials", "TypeTree", "Material");
  const materialTextureDir = path.join(assetRoot, "Assetbundles", "materials", "Texture2D");
  const materialObjectIndexDir = path.join(assetRoot, "Assetbundles", "materials", "ObjectIndex");
  const unitIconDir = path.join(assetRoot, "Data", "StreamingAssets", "ab_inven_icon_unit", "Texture2D");
  const skillIconDir = path.join(assetRoot, "Data", "StreamingAssets", "ab_ui_unit_skill_icon", "Sprite");
  const unitSpineTextureDir = path.join(assetRoot, "Data", "StreamingAssets", "unit_test_illust", "Texture2D");
  const relatedTableIndexPath = path.join(tempDir, "wiki", "data", "idIndex.json");
  const modsRoot = path.join(tempDir, "mods");
  fs.mkdirSync(tableDir, { recursive: true });
  fs.mkdirSync(unitTableDir, { recursive: true });
  fs.mkdirSync(itemTableDir, { recursive: true });
  fs.mkdirSync(path.join(assetRoot, "icons"), { recursive: true });
  fs.mkdirSync(path.join(spineViewerRoot, "assets"), { recursive: true });
  fs.mkdirSync(spineTextDir, { recursive: true });
  fs.mkdirSync(spineTextureDir, { recursive: true });
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(materialDir, { recursive: true });
  fs.mkdirSync(materialTextureDir, { recursive: true });
  fs.mkdirSync(materialObjectIndexDir, { recursive: true });
  fs.mkdirSync(unitIconDir, { recursive: true });
  fs.mkdirSync(skillIconDir, { recursive: true });
  fs.mkdirSync(unitSpineTextureDir, { recursive: true });
  fs.mkdirSync(path.dirname(relatedTableIndexPath), { recursive: true });
  fs.writeFileSync(path.join(tableDir, "LUA_TEST_TABLE.json"), JSON.stringify({ records: [
    { m_ID: 1, m_Name: "Alpha" },
    { m_ID: 2, m_Name: "Beta" },
  ] }));
  fs.writeFileSync(path.join(unitTableDir, "LUA_UNIT_STAT_TEMPLET.json"), JSON.stringify({ records: [
    { m_UnitStrID: "NKM_UNIT_TEST", m_RespawnCost: 4, m_StatData: { m_Stat: { NST_HP: 1603, NST_ATK: 404, NST_DEF: 43 }, m_StatPerLevel: { NST_HP: 206 } } },
  ] }));
  fs.writeFileSync(path.join(unitTableDir, "LUA_UNIT_TEMPLET_BASE.json"), JSON.stringify({ records: [
    { m_UnitID: 1001, m_UnitStrID: "NKM_UNIT_TEST", m_NKM_UNIT_TYPE: "NUT_NORMAL", m_Name: "SI_UNIT_TEST", m_InvenIconName: "UNIT_TEST_ICON", m_FaceCardName: "UNIT_TEST_CARD", m_SpineIllustName: "UNIT_TEST_ILLUST", m_SpineSDName: "UNIT_TEST_SD", m_MiniMapFaceName: "UNIT_TEST_MINIMAP", m_SpriteBundleName: "AB_UNIT_TEST", m_SpriteName: "UNIT_TEST_BATTLE", m_SkillStrID1: "NKM_SKILL_TEST" },
  ] }));
  fs.writeFileSync(path.join(unitTableDir, "LUA_UNIT_SKILL_TEMPLET.json"), JSON.stringify({ records: [
    { m_UnitSkillID: 501, m_UnitSkillStrID: "NKM_SKILL_TEST", m_UnitSkillIcon: "SKILL_TEST_ICON" },
  ] }));
  fs.writeFileSync(path.join(itemTableDir, "LUA_ITEM_EQUIP_TEMPLET.json"), JSON.stringify({ records: [
    { m_ItemEquipID: 7001, m_ItemEquipStrID: "GEAR_TEST", m_ItemEquipName: "SI_GEAR_TEST", m_ItemEquipIconName: "GEAR_TEST", STAT_TYPE_1: "NST_HP", STAT_VALUE_1: 100, STAT_LEVELUP_VALUE_1: 10, m_MaxEnchantLevel: 2, m_StatGroupID: 77, m_PotentialOptionGroupID: 88, m_SetGroup: [99] },
  ] }));
  fs.writeFileSync(path.join(tableDir, "LUA_ITEM_EQUIP_RANDOM_STAT.json"), JSON.stringify({ records: [
    { m_StatGroupID: 77, m_StatType: "NST_ATK", m_MinStatRate: 0.05, m_MaxStatRate: 0.1 },
  ] }));
  fs.writeFileSync(path.join(tableDir, "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json"), JSON.stringify({ records: [
    { m_PotentialOptionGroupID: 88, OptionKey: 3, PrecisionWeightId: 55, Socket1_StatType: "NST_HP", Socket1_MinStatRate: 0.1, Socket1_MaxStatRate: 0.2 },
  ] }));
  fs.writeFileSync(path.join(itemTableDir, "LUA_ITEM_EQUIP_SET_OPTION.json"), JSON.stringify({ records: [
    { m_EquipSetID: 99, m_EquipSetStrID: "SET_TEST" },
  ] }));
  fs.writeFileSync(path.join(assetRoot, "icons", "notes.txt"), "asset preview");
  fs.writeFileSync(path.join(assetRoot, "icons", "pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(unitIconDir, "UNIT_TEST_ICON.png"), pngHeader(32, 48));
  fs.writeFileSync(path.join(skillIconDir, "SKILL_TEST_ICON.png"), pngHeader(48, 48));
  fs.writeFileSync(path.join(unitSpineTextureDir, "UNIT_TEST_ILLUST.png"), pngHeader(64, 96));
  fs.writeFileSync(path.join(spineViewerRoot, "index.html"), '<title>Spine 3.7 Studio</title><script type="module" src="./assets/app.js"></script>');
  fs.writeFileSync(path.join(spineViewerRoot, "assets", "app.js"), "document.body.dataset.ready = 'yes';");
  fs.writeFileSync(path.join(spineTextDir, "HERO.skel"), Buffer.from("spine-binary"));
  fs.writeFileSync(path.join(spineTextDir, "HERO.atlas"), "HERO.png\nsize: 1,1\nformat: RGBA8888\n");
  fs.writeFileSync(path.join(spineTextDir, "FONT.bytes"), "info face=Arial size=32");
  fs.writeFileSync(path.join(spineTextureDir, "HERO.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(audioDir, "CLICK.wav"), Buffer.from("524946460000000057415645", "hex"));
  fs.writeFileSync(path.join(materialDir, "MAT_TEST.json"), JSON.stringify({
    m_Name: "MAT_TEST",
    m_ItemID: 7001,
    m_MainTexture: { m_FileID: 0, m_PathID: 321 },
  }));
  fs.writeFileSync(path.join(materialTextureDir, "MAT_TEX.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  fs.writeFileSync(path.join(materialObjectIndexDir, "objects.json"), JSON.stringify({ objects: [
    { path_id: 111, type: "Material", name: "MAT_TEST" },
    { path_id: 321, type: "Texture2D", name: "MAT_TEX" },
  ] }));
  fs.writeFileSync(relatedTableIndexPath, JSON.stringify([
    { id: 7001, idField: "m_ItemID", table: "LUA_ITEM_TEST.json", name: "Test material", strId: "MAT_TEST", type: "RT_MISC", source: "ab_script/luac/LUA_ITEM_TEST.json" },
  ]));

  let createdEpisode;
  const episodeMaker = {
    catalog: () => ({ episodes: [{ id: 2, category: "EC_MAINSTREAM", label: "Mainstream Episode 1" }], actors: [], backgrounds: ["CAFE"], animations: [], effects: [], previewAssets: { background: "episode-maker/preview-asset?kind=cafe" } }),
    layout: () => ({ schemaVersion: 1, source: "base", readOnly: true, episode: { id: 2, category: "EC_MAINSTREAM", variants: [{ difficulty: "NORMAL", actCount: 4 }, { difficulty: "HARD", actCount: 1 }] }, stages: [{ source: "base", stageId: 11245, stageIndex: 6, stageUiNumber: 3, difficulty: "NORMAL", actId: 4 }] }),
    inspectStage: () => ({ schemaVersion: 1, source: "base", readOnly: true, name: "Stage 3", kind: "CUTSCENE", placement: { category: "EC_MAINSTREAM", episodeId: 2, difficulty: "NORMAL", actId: 4, stageIndex: 6, stageNumber: 3 }, ids: { stageId: 11245, stageStrId: "STAGE_MAINSTREAM_11245", dungeonId: 10105, dungeonStrId: "NKM_DUNGEON_TEST" }, clientUi: { avatar: "NKM_UNIT_C_POLICE_LEE_YUMI", dungeonIcon: "NKM_NPC_CUT_SCENE" }, unlock: { requirementType: "SURT_CLEAR_DUNGEON", requirementValue: 10104 }, cutscenes: [{ slot: "before", id: "TEST_CUTSCENE", recordCount: 1, frames: [{ processKey: 1, speakerName: "Lee Yumi", speakerActorId: "YUMI_POLICE_NULL_NULL", dialogue: "Hello", voiceLine: "", background: "CAFE", music: "", transition: "FADE", fadeTime: 1, actors: [], effects: [], raw: { m_CutScenProcessKey: 1 } }] }], raw: { placement: { m_StageID: 11245 } } }),
    asset: (kind, id) => ({ found: true, kind, id, type: "image", path: "icons/pixel.png" }),
    suggest: () => ({ episodeId: 2, category: "EC_MAINSTREAM", actId: 4, stageIndex: 7, stageUiNumber: 3, stageId: 11246, dungeonId: 10106, cutsceneId: 900011246, unlockDungeonId: 0, stageStrId: "STAGE_MAINSTREAM_MODSIDE_11246", dungeonStrId: "NKM_DUNGEON_EP1_ACT4_DATING_EVENT_1", cutsceneStrId: "EP1_ACT4_DATING_EVENT_1", background: "CAFE" }),
    create: (input) => (createdEpisode = { project: { manifest: { id: input.projectId } }, authoring: input, exportFileName: `${input.projectId}.zip` }),
  };
  let openedFile;
  const viewer = createAssetViewer({ rootDir: tempDir, uiRoot: path.join(__dirname, "..", "server", "modside-ui-dist"), assetRoot, spineViewerRoot, relatedTableIndexPath, modsRoot, env: {}, episodeMaker, cutsceneCafeBackground: path.join(assetRoot, "icons", "pixel.png"), openFileLocation: (filePath) => { openedFile = filePath; } });
  const server = http.createServer(async (req, res) => {
    if (await viewer.handle(req, res)) return;
    res.writeHead(404).end();
  });

  try {
    const port = await listen(server);
    const page = await request(port, "/mod-side");
    const assetsPage = await request(port, "/mod-side/assets");
    const storyPage = await request(port, "/mod-side/story");
    const unitPage = await request(port, "/mod-side/units");
    const combatPage = await request(port, "/mod-side/combat");
    const legacyPage = await request(port, "/asset-viewer?view=loader");
    assert.strictEqual(page.statusCode, 200);
    assert.match(page.body, /<title>Mod:Side<\/title>/);
    assert.match(page.body, /<meta name="modside-base" content="\/mod-side">/);
    assert.match(page.body, /<div id="root"><\/div>/);
    assert.match(page.body, /src="\/mod-side\/ui\/assets\/index-[^"]+\.js"/);
    assert.match(page.body, /href="\/mod-side\/ui\/assets\/index-[^"]+\.css"/);
    assert.match(page.headers["content-security-policy"], /script-src 'self' 'unsafe-inline'/);
    assert.match(page.headers["content-security-policy"], /style-src 'self' 'unsafe-inline'/);
    assert.strictEqual(assetsPage.statusCode, 200);
    assert.match(assetsPage.body, /<title>Asset:Side<\/title>/);
    assert.strictEqual(storyPage.statusCode, 200);
    assert.match(storyPage.body, /<title>Story:Side<\/title>/);
    assert.strictEqual(unitPage.statusCode, 200);
    assert.match(unitPage.body, /<title>Unit:Side<\/title>/);
    assert.strictEqual(combatPage.statusCode, 200);
    assert.match(combatPage.body, /<title>Combat:Side<\/title>/);
    assert.match(combatPage.headers["content-security-policy"], /frame-src 'self' http:\/\/127\.0\.0\.1:5185/);
    assert.strictEqual(legacyPage.statusCode, 308);
    assert.strictEqual(legacyPage.headers.location, "/mod-side?view=loader");
    const uiScriptPath = page.body.match(/src="([^"]+\.js)"/)[1];
    const uiStylePath = page.body.match(/href="([^"]+\.css)"/)[1];
    const uiScript = await request(port, uiScriptPath);
    const uiStyle = await request(port, uiStylePath);
    assert.strictEqual(uiScript.statusCode, 200);
    assert.match(uiScript.headers["content-type"], /javascript/);
    assert.match(uiScript.body, /Mod:Side/);
    assert.match(uiScript.body, /Spine 3\.7 Studio/);
    assert.match(fs.readFileSync(path.join(__dirname, "..", "modside-ui", "src", "App.jsx"), "utf8"), /react-icons\/fi/);
    assert.strictEqual(uiStyle.statusCode, 200);
    assert.match(uiStyle.headers["content-type"], /text\/css/);
    assert.match(uiStyle.body, /loading-overlay/);
    /* Legacy inline-interface assertions removed from execution by the React migration.
    assert.match(page.body, /<title>Mod:Side<\/title>/);
    assert.match(page.body, /data-product="mod"/);
    assert.match(page.body, /id="homePanel"/);
    assert.match(page.body, /id="openCreator"/);
    assert.match(page.body, /id="openLoader"/);
    assert.match(page.body, /class="brand-mark"[^>]*><svg/);
    assert.match(page.body, /class="app-icon creator"[^>]*><svg/);
    assert.match(page.body, /id="loadingOverlay"[^>]*role="status"/);
    assert.match(page.body, /id="loadingTitle"/);
    assert.match(page.body, /id="loadingPercent"[^>]*>0%/);
    assert.match(page.body, /id="loadingProgress"[^>]*aria-valuenow="0"/);
    assert.match(page.body, /backdrop-filter:blur\(12px\)/);
    assert.match(page.body, /function loadingContext/);
    assert.match(page.body, /function progressResponse/);
    assert.match(page.body, /content-length/);
    assert.match(page.body, /function loadingFetch/);
    assert.match(page.body, /href="\/mod-side\/assets"/);
    assert.match(page.body, /href="\/mod-side\/story"/);
    assert.match(page.body, /href="\/mod-side\/units"/);
    assert.match(page.body, /href="\/mod-side\/combat"[^>]*>.*Combat:Side/s);
    assert.match(page.body, /\.app-icon svg \{ display:block; width:100%; height:100%; max-width:100%; max-height:100%;/);
    assert.strictEqual(combatPage.statusCode, 200);
    assert.match(combatPage.body, /<title>Combat:Side<\/title>/);
    assert.match(combatPage.body, /data-product="combat"/);
    assert.match(combatPage.body, /id="combatPanel"[^>]*aria-label="Combat:Side"/);
    assert.match(combatPage.body, /class="combat-frame"[^>]*src="http:\/\/127\.0\.0\.1:5185\/"/);
    assert.match(combatPage.headers["content-security-policy"], /frame-src 'self' http:\/\/127\.0\.0\.1:5185/);
    assert.strictEqual(legacyPage.statusCode, 308);
    assert.strictEqual(legacyPage.headers.location, "/mod-side?view=loader");
    assert.strictEqual(assetsPage.statusCode, 200);
    assert.match(assetsPage.body, /<title>Asset:Side<\/title>/);
    assert.match(assetsPage.body, /data-product="assets"/);
    assert.match(page.body, /id="assetSideTabs"[^>]*aria-label="Asset:Side sections"/);
    assert.match(page.body, /id="objectsTab"[^>]*>.*Game objects<\/button>/);
    assert.match(page.body, /id="objectsPanel"/);
    assert.match(page.body, /Relevant IDs and fields/);
    assert.match(page.body, /gear_stat_ids, fields, and ranges/);
    assert.match(page.body, /id="objectImportMod"/);
    assert.match(page.body, /id="objectExportMod"/);
    assert.match(page.body, /Required PNG: exactly/);
    assert.match(page.body, /id="unitSpineIllust"/);
    assert.match(page.body, /id="attachUnitSpine"/);
    assert.match(page.body, /els\.assetSideTabs\.hidden=PRODUCT!=="assets"/);
    assert.match(page.body, /var productModes=/);
    assert.match(page.body, /Game Data Atlas/);
    assert.match(page.body, /Mod creator/);
    assert.match(page.body, /id="unitPanel"/);
    assert.match(page.body, /External Unity AssetBundle compiler/);
    assert.match(page.body, /id="loaderImportMod"/);
    assert.match(page.body, /mod-runtime\/apply/);
    assert.match(page.body, /deleteModProject/);
    assert.match(page.body, /function revealClippedText/);
    assert.match(page.body, /Open File Location/);
    assert.match(page.body, /frame\.src=BASE_PATH\+"\/spine\/\?mode=view"/);
    assert.strictEqual(storyPage.statusCode, 200);
    assert.match(storyPage.body, /<title>Story:Side<\/title>/);
    assert.match(storyPage.body, /data-product="story"/);
    assert.strictEqual(unitPage.statusCode, 200);
    assert.match(unitPage.body, /<title>Unit:Side<\/title>/);
    assert.match(unitPage.body, /data-product="units"/);
    assert.match(unitPage.body, /Unit:Side creator/);
    assert.match(page.body, /episode-maker\/stage/);
    assert.match(page.body, /Base game · protected/);
    assert.match(page.body, /id="episodeStageCanvas"/);
    assert.match(page.body, /id="episodeCutsceneCanvasWrap"/);
    assert.match(page.body, /id="episodeDefinitionMode"/);
    assert.match(page.body, /id="episodeDifficulty"/);
    assert.match(page.body, /Enable Hard mode/);
    assert.match(page.body, /Horizontal pan/);
    assert.match(page.body, /Completion rewards/);
    assert.match(page.body, /Mid-episode music change/);
    assert.match(page.body, /No Hard collection cutscene/);
    assert.match(page.body, /Edit override/);
    assert.match(page.body, /id="episodeOverrideChanges"/);
    assert.match(page.body, /function beginEpisodeOverride/);
    assert.match(page.body, /function episodeOverrideDiff/);
    assert.match(page.body, /Remove override/);
    assert.match(page.body, /Stage Studio/);
    assert.match(page.body, /Clone stage/);
    assert.match(page.body, /function cloneEpisodeBaseStage/);
    assert.match(page.body, /function movableEpisodeStageIndexes/);
    assert.match(page.body, /stageNodeDrag/);
    assert.match(page.body, /shared cutscenes/);
    assert.match(page.body, /Timing & FX/);
    assert.match(page.body, /function renderStageLayout/);
    assert.match(page.body, /function nextEpisodeSuggestion/);
    assert.match(page.body, /function moveEpisodeActor/);
    assert.match(page.body, />\+<\/span> Insert/);
    assert.match(page.body, /◉ Preview/);
    assert.match(page.body, /episodeStageCanvas\.onpointerdown/);
    assert.match(page.body, /stagePanX=Math\.max/);
    assert.match(page.body, /previousScroll=els\.episodeScenes\.scrollLeft/);
    assert.doesNotMatch(page.body, /card\.onclick=function\(\)\{setEpisodeScene\(index\)/);
    assert.match(page.body, /els\.episodeScenes\.scrollLeft=els\.episodeScenes\.scrollWidth/);
    const browserScript = page.body.match(/<script>([\s\S]*)<\/script>/);
    assert(browserScript, "asset viewer browser script was not found");
    new vm.Script(browserScript[1]);
    const hoverFunction = browserScript[1].match(/function revealClippedText[^\n]+/)[0];
    const hoverSandbox = { HTMLElement: function HTMLElement() {}, document: { body: {} }, getComputedStyle: () => ({ textOverflow: "ellipsis" }) };
    const clipped = new hoverSandbox.HTMLElement();
    Object.assign(clipped, { textContent: "Full clipped text", scrollWidth: 20, clientWidth: 10, scrollHeight: 10, clientHeight: 10, parentElement: hoverSandbox.document.body });
    hoverSandbox.clipped = clipped;
    vm.runInNewContext(`${hoverFunction}; revealClippedText({ target: clipped });`, hoverSandbox);
    assert.strictEqual(clipped.title, "Full clipped text");
    */

    const tables = await requestJson(port, "/mod-side/api/tables?query=test");
    assert.strictEqual(tables.total, 1);
    assert.strictEqual(tables.tables[0].tableName, "LUA_TEST_TABLE");

    const records = await requestJson(port, "/mod-side/api/table?directory=ab_script&file=LUA_TEST_TABLE.json&query=beta");
    assert.strictEqual(records.total, 1);
    assert.strictEqual(records.records[0].m_ID, 2);
    assert.strictEqual(records.recordIndexes[0], 1);

    const systems = await requestJson(port, "/mod-side/api/systems");
    assert(systems.tableCount >= 2);
    assert(systems.systems.find((entry) => entry.id === "units").tableCount >= 1);
    assert.deepStrictEqual(systems.systems.filter((entry) => entry.id.startsWith("cutscene-")).map((entry) => entry.id), [
      "cutscene-scripts",
      "cutscene-characters",
      "cutscene-registration",
      "cutscene-collection",
      "cutscene-media",
    ]);
    const unitTables = await requestJson(port, "/mod-side/api/system-tables?id=units");
    assert.strictEqual(unitTables.tables[0].tableName, "LUA_UNIT_STAT_TEMPLET");
    const fields = await requestJson(port, "/mod-side/api/fields?query=unit%20hp");
    const hp = fields.fields.find((entry) => entry.path === "m_StatData.m_Stat.NST_HP");
    assert(hp, "unit HP field was not found");
    assert.strictEqual(hp.table.tableName, "LUA_UNIT_STAT_TEMPLET");
    assert.strictEqual(hp.example, 1603);

    const units = await requestJson(port, "/mod-side/api/objects?type=unit&query=nkm_unit_test");
    assert.strictEqual(units.total, 1);
    assert.strictEqual(units.objects[0].id, 1001);
    const unit = await requestJson(port, "/mod-side/api/object?type=unit&id=1001");
    assert.match(unit.ids.find((entry) => entry.field === "m_InvenIconName").description, /Management/);
    assert.match(unit.ids.find((entry) => entry.field === "m_FaceCardName").description, /gacha/);
    assert.strictEqual(unit.ids.find((entry) => entry.field === "m_SkillStrID1").value, "NKM_SKILL_TEST");
    assert.strictEqual(unit.ids.find((entry) => entry.field === "m_InvenIconName").preview, "Data/StreamingAssets/ab_inven_icon_unit/Texture2D/UNIT_TEST_ICON.png");
    assert.strictEqual(unit.stats.find((entry) => entry.statType === "NST_HP").fields.base, "m_StatData.m_Stat.NST_HP");
    const gear = await requestJson(port, "/mod-side/api/object?type=gear&id=7001");
    const mainStat = gear.gear_stat_ids.find((entry) => entry.slot === "Main");
    assert.deepStrictEqual([mainStat.statId, mainStat.min, mainStat.max], [0, 100, 120]);
    const randomStat = gear.gear_stat_ids.find((entry) => entry.groupId === 77);
    assert.deepStrictEqual([randomStat.statType, randomStat.min, randomStat.max], ["NST_ATK_FACTOR", 0.05, 0.1]);
    assert(Number.isInteger(randomStat.statId));
    const potential = gear.gear_stat_ids.find((entry) => entry.groupId === 88);
    assert.deepStrictEqual([potential.optionKey, potential.precisionWeightId, potential.min, potential.max], [3, 55, 0.1, 0.2]);
    assert(gear.ids.every((entry) => entry.field && entry.sourceTable && entry.description));
    const unitIllustration = await requestJson(port, "/mod-side/api/unit-maker/asset?field=m_SpineIllustName&id=UNIT_TEST_ILLUST");
    assert.strictEqual(unitIllustration.found, true);
    assert.strictEqual(unitIllustration.path, "Data/StreamingAssets/unit_test_illust/Texture2D/UNIT_TEST_ILLUST.png");
    const skillIcon = await requestJson(port, "/mod-side/api/unit-maker/asset?field=m_UnitSkillIcon&id=SKILL_TEST_ICON");
    assert.strictEqual(skillIcon.found, true);
    assert.strictEqual(skillIcon.path, "Data/StreamingAssets/ab_ui_unit_skill_icon/Sprite/SKILL_TEST_ICON.png");
    const unsafeUnitIllustration = await requestJson(port, "/mod-side/api/unit-maker/asset?field=m_SpineIllustName&id=..%2Fsecret");
    assert.strictEqual(unsafeUnitIllustration.found, false);

    const episodeCatalog = await requestJson(port, "/mod-side/api/episode-maker/catalog");
    assert.strictEqual(episodeCatalog.episodes[0].id, 2);
    const episodeSuggestion = await requestJson(port, "/mod-side/api/episode-maker/suggest?episodeId=2&category=EC_MAINSTREAM");
    assert.strictEqual(episodeSuggestion.stageIndex, 7);
    const episodeLayout = await requestJson(port, "/mod-side/api/episode-maker/layout?episodeId=2&category=EC_MAINSTREAM");
    assert.strictEqual(episodeLayout.stages[0].stageId, 11245);
    assert.strictEqual(episodeLayout.readOnly, true);
    const episodeStage = await requestJson(port, "/mod-side/api/episode-maker/stage?stageId=11245&episodeId=2&category=EC_MAINSTREAM&difficulty=NORMAL");
    assert.strictEqual(episodeStage.kind, "CUTSCENE");
    assert.strictEqual(episodeStage.cutscenes[0].frames[0].dialogue, "Hello");
    const episodeAsset = await requestJson(port, "/mod-side/api/episode-maker/asset?kind=background&id=CAFE");
    assert.strictEqual(episodeAsset.path, "icons/pixel.png");
    const episodeCreated = await requestJson(port, "/mod-side/api/episode-maker/create", { method: "POST", body: JSON.stringify({ projectId: "episode-test", scenes: [{ dialogue: "Hello" }] }), headers: { "Content-Type": "application/json" } });
    assert.strictEqual(episodeCreated.project.manifest.id, "episode-test");
    assert.strictEqual(episodeCreated.runtimeRebuilt, false);
    assert.strictEqual(createdEpisode.authoring.scenes.length, 1);
    const episodePreview = await request(port, "/mod-side/api/episode-maker/preview-asset?kind=cafe");
    assert.strictEqual(episodePreview.headers["content-type"], "image/png");

    const createdMod = await requestJson(port, "/mod-side/api/mods", { method: "POST", body: JSON.stringify({ id: "test-mod", name: "Test Mod" }), headers: { "Content-Type": "application/json" } });
    assert.strictEqual(createdMod.manifest.id, "test-mod");
    assert.strictEqual(createdMod.patches.length, 0);
    const assetPath = "Data/StreamingAssets/ab_inven_icon_unit/Texture2D/UNIT_TEST_ICON.png";
    const assetMetadata = await requestJson(port, `/mod-side/api/asset-replacement?path=${encodeURIComponent(assetPath)}`);
    assert.deepStrictEqual([assetMetadata.bundleName, assetMetadata.assetName, assetMetadata.width, assetMetadata.height, assetMetadata.unityType], ["ab_inven_icon_unit", "UNIT_TEST_ICON", 32, 48, "Sprite"]);
    const replacement = await requestJson(port, `/mod-side/api/mods/test-mod/asset-replacement?path=${encodeURIComponent(assetPath)}&fileName=custom.png`, { method: "POST", body: pngHeader(32, 48) });
    assert.strictEqual(replacement.replacement.source, "assets/source/replacements/ab_inven_icon_unit/Texture2D/UNIT_TEST_ICON.png");
    assert.strictEqual(replacement.project.assetReplacements[0].built, false);
    assert.deepStrictEqual(replacement.bundleAssets, ["replacements/ab_inven_icon_unit/Texture2D/UNIT_TEST_ICON.png"]);
    assert.deepStrictEqual(replacement.spriteAssets, ["replacements/ab_inven_icon_unit/Texture2D/UNIT_TEST_ICON.png"]);
    const wrongDimensions = await request(port, `/mod-side/api/mods/test-mod/asset-replacement?path=${encodeURIComponent(assetPath)}&fileName=custom.png`, { method: "POST", body: pngHeader(16, 16) });
    assert.strictEqual(wrongDimensions.statusCode, 422);
    assert.match(wrongDimensions.body, /exactly 32 x 48/);
    const audioPath = "Assetbundles/sounds/AudioClip/CLICK.wav";
    const audioReplacement = await requestJson(port, `/mod-side/api/mods/test-mod/asset-replacement?path=${encodeURIComponent(audioPath)}&fileName=custom.wav`, { method: "POST", body: Buffer.from("524946460000000057415645", "hex") });
    assert.deepStrictEqual([audioReplacement.replacement.bundleName, audioReplacement.replacement.extension, audioReplacement.replacement.unityType], ["sounds", ".wav", "Default"]);
    const dataPath = "Assetbundles/hero/TextAsset/FONT.bytes";
    const dataReplacement = await requestJson(port, `/mod-side/api/mods/test-mod/asset-replacement?path=${encodeURIComponent(dataPath)}&fileName=custom.bytes`, { method: "POST", body: Buffer.from("replacement data") });
    assert.deepStrictEqual([dataReplacement.replacement.bundleName, dataReplacement.replacement.extension, dataReplacement.replacement.unityType], ["hero", ".bytes", "Default"]);
    const uploaded = await requestJson(port, "/mod-side/api/mods/test-mod/asset-source?path=custom.png", { method: "POST", body: Buffer.from("asset") });
    assert.strictEqual(uploaded.file, "assets/source/custom.png");
    const compiler = await requestJson(port, "/mod-side/api/unity-compiler");
    assert.strictEqual(compiler.requiredVersion, "2022.3.62f2");
    assert.deepStrictEqual(compiler.targets, ["windows", "android"]);
    assert.match(EDITOR_SCRIPT, /TextureImporterType\.Sprite/);
    assert.match(EDITOR_SCRIPT, /BuildTarget\.Android/);
    const copied = await requestJson(port, "/mod-side/api/mods/test-mod/copy-record", { method: "POST", body: JSON.stringify({ directory: "ab_script", fileName: "LUA_TEST_TABLE.json", recordIndex: 1 }), headers: { "Content-Type": "application/json" } });
    assert.strictEqual(copied.patch.key.field, "m_ID");
    assert.strictEqual(copied.patch.key.value, 2);
    assert.strictEqual(copied.base.m_Name, "Beta");
    copied.patch.value.m_Name = "Modded Beta";
    const saved = await requestJson(port, "/mod-side/api/mods/test-mod/patch", { method: "PUT", body: JSON.stringify({ table: copied.patch.table, key: copied.patch.key, previousPatchId: copied.patch.patchId, value: copied.patch.value }), headers: { "Content-Type": "application/json" } });
    assert(saved.changes.find((entry) => entry.path === "m_Name" && entry.after === "Modded Beta"));
    saved.patch.value.m_Name = 42;
    const invalid = await requestJson(port, "/mod-side/api/mods/test-mod/patch", { method: "PUT", body: JSON.stringify({ table: saved.patch.table, key: saved.patch.key, previousPatchId: saved.patch.patchId, value: saved.patch.value }), headers: { "Content-Type": "application/json" } });
    assert(invalid.validation.errors.find((entry) => entry.path === "m_Name"));
    invalid.patch.value.m_Name = "Modded Beta";
    await requestJson(port, "/mod-side/api/mods/test-mod/patch", { method: "PUT", body: JSON.stringify({ table: invalid.patch.table, key: invalid.patch.key, previousPatchId: invalid.patch.patchId, value: invalid.patch.value }), headers: { "Content-Type": "application/json" } });
    const duplicated = await requestJson(port, "/mod-side/api/mods/test-mod/copy-record", { method: "POST", body: JSON.stringify({ directory: "ab_script", fileName: "LUA_TEST_TABLE.json", recordIndex: 0, duplicate: true }), headers: { "Content-Type": "application/json" } });
    assert.strictEqual(duplicated.patch.key.value, 3);
    assert.strictEqual(duplicated.patch.value.m_ID, 3);
    const validation = await requestJson(port, "/mod-side/api/mods/test-mod/validate");
    assert.strictEqual(validation.ok, true);
    assert.strictEqual(validation.patchCount, 2);
    const projectCopy = await requestJson(port, "/mod-side/api/mods/test-mod/copy", { method: "POST", body: JSON.stringify({ id: "test-mod-copy", name: "Test Mod Copy" }), headers: { "Content-Type": "application/json" } });
    assert.strictEqual(projectCopy.manifest.id, "test-mod-copy");
    assert.strictEqual(projectCopy.patches.length, 2);
    assert.deepStrictEqual(projectCopy.remapped, []);
    const references = await requestJson(port, "/mod-side/api/references?query=material");
    assert.strictEqual(references.references[0].id, 7001);
    const exported = await request(port, "/mod-side/api/mods/test-mod/export", { encoding: "binary" });
    assert.strictEqual(exported.statusCode, 200);
    assert.strictEqual(exported.headers["content-type"], "application/zip");
    assert.strictEqual(exported.body.slice(0, 2), "PK");
    const importedProjectPath = path.resolve(modsRoot, "test-mod");
    assert(importedProjectPath.startsWith(path.resolve(modsRoot) + path.sep));
    fs.rmSync(importedProjectPath, { recursive: true, force: true });
    const imported = await requestJson(port, "/mod-side/api/mods/import", { method: "POST", body: Buffer.from(exported.body, "binary"), headers: { "Content-Type": "application/zip" } });
    assert.strictEqual(imported.manifest.id, "test-mod");
    assert.strictEqual(imported.patches.length, 2);
    assert(imported.assetReplacements.find((entry) => entry.targetPath === assetPath));
    assert(imported.assetReplacements.find((entry) => entry.targetPath === audioPath));
    assert(imported.assetReplacements.find((entry) => entry.targetPath === dataPath));
    const activated = await requestJson(port, "/mod-side/api/mod-runtime/apply", { method: "PUT", body: JSON.stringify({ enabled: ["test-mod"] }), headers: { "Content-Type": "application/json" } });
    assert.deepStrictEqual(activated.current.enabled.map((entry) => entry.id), ["test-mod"]);
    const deactivated = await requestJson(port, "/mod-side/api/mod-runtime/apply", { method: "PUT", body: JSON.stringify({ enabled: [] }), headers: { "Content-Type": "application/json" } });
    assert.deepStrictEqual(deactivated.current.enabled, []);
    const afterRemove = await requestJson(port, `/mod-side/api/mods/test-mod/patch?patchId=${encodeURIComponent(duplicated.patch.patchId)}`, { method: "DELETE" });
    assert.strictEqual(afterRemove.patches.length, 1);
    await requestJson(port, "/mod-side/api/mod-runtime/apply", { method: "PUT", body: JSON.stringify({ enabled: ["test-mod"] }), headers: { "Content-Type": "application/json" } });
    const deleted = await requestJson(port, "/mod-side/api/mods/test-mod", { method: "DELETE" });
    assert.strictEqual(deleted.deleted.id, "test-mod");
    assert.deepStrictEqual(deleted.profile.enabled, []);
    assert.deepStrictEqual(deleted.current.enabled, []);
    assert.strictEqual(deleted.previous, null);
    assert.strictEqual(fs.existsSync(importedProjectPath), false);

    const healthWithoutManifest = await requestJson(port, "/mod-side/api/health");
    assert.strictEqual(healthWithoutManifest.assetRootAvailable, false);
    fs.writeFileSync(path.join(tempDir, "extracted-assets", "manifest.json"), JSON.stringify({ file_count: 1 }));
    const health = await requestJson(port, "/mod-side/api/health");
    assert.strictEqual(health.assetRootAvailable, true);
    assert.strictEqual(health.spineViewerAvailable, true);

    const assets = await requestJson(port, "/mod-side/api/assets?path=icons");
    assert.deepStrictEqual(assets.entries.map((entry) => entry.name), ["notes.txt", "pixel.png"]);
    const text = await requestJson(port, "/mod-side/api/text?path=icons%2Fnotes.txt");
    assert.strictEqual(text.text, "asset preview");
    await requestJson(port, "/mod-side/api/open-file-location?path=icons%2Fnotes.txt", { method: "POST" });
    assert.strictEqual(openedFile, fs.realpathSync(path.join(assetRoot, "icons", "notes.txt")));
    const unrelatedRootAsset = await requestJson(port, "/mod-side/api/related?path=icons%2Fnotes.txt");
    assert.deepStrictEqual(unrelatedRootAsset.assets, []);
    const spineAssets = await requestJson(port, "/mod-side/api/assets?path=Assetbundles%2Fhero%2FTextAsset");
    assert.strictEqual(spineAssets.entries.find((entry) => entry.name === "HERO.skel").assetType, "Spine skeleton");
    const bytes = await requestJson(port, "/mod-side/api/text?path=Assetbundles%2Fhero%2FTextAsset%2FFONT.bytes");
    assert.match(bytes.text, /face=Arial/);
    const fontSpineSet = await requestJson(port, "/mod-side/api/spine-set?path=Assetbundles%2Fhero%2FTextAsset%2FFONT.bytes");
    assert.strictEqual(fontSpineSet.notSpine, true);
    const spineSet = await requestJson(port, "/mod-side/api/spine-set?path=Assetbundles%2Fhero%2FTextAsset%2FHERO.skel");
    assert.strictEqual(spineSet.ready, true);
    assert.deepStrictEqual(spineSet.files.map((file) => file.role), ["skeleton", "atlas", "texture"]);
    assert.deepStrictEqual(spineSet.files.map((file) => file.name), ["HERO.skel", "HERO.atlas", "HERO.png"]);
    const audioAssets = await requestJson(port, "/mod-side/api/assets?path=Assetbundles%2Fsounds%2FAudioClip");
    assert.strictEqual(audioAssets.entries[0].assetType, "Audio");
    const audio = await request(port, "/mod-side/api/asset?path=Assetbundles%2Fsounds%2FAudioClip%2FCLICK.wav");
    assert.strictEqual(audio.headers["content-type"], "audio/wav");
    const materialAssets = await requestJson(port, "/mod-side/api/assets?path=Assetbundles%2Fmaterials%2FTypeTree%2FMaterial");
    assert.strictEqual(materialAssets.entries[0].assetType, "Unity Material");
    const related = await requestJson(port, "/mod-side/api/related?path=Assetbundles%2Fmaterials%2FTypeTree%2FMaterial%2FMAT_TEST.json");
    assert.strictEqual(related.assets.find((entry) => entry.name === "MAT_TEX.png").relation, "Unity reference · Texture2D");
    assert.strictEqual(related.tables[0].id, 7001);
    assert.match(related.tables[0].matchedBy, /7001|MAT_TEST/);
    const spinePage = await request(port, "/mod-side/spine/");
    assert.strictEqual(spinePage.statusCode, 200);
    assert.match(spinePage.body, /<title>Spine 3\.7 Studio<\/title>/);
    assert.match(spinePage.body, /assets\/app\.js/);
    const spineScript = await request(port, "/mod-side/spine/assets/app.js");
    assert.strictEqual(spineScript.headers["content-type"], "text/javascript; charset=utf-8");
    const image = await request(port, "/mod-side/api/asset?path=icons%2Fpixel.png", { headers: { Range: "bytes=0-3" } });
    assert.strictEqual(image.statusCode, 206);
    assert.strictEqual(image.headers["content-type"], "image/png");
    assert.strictEqual(Buffer.byteLength(image.body, "binary"), 4);

    const traversal = await request(port, "/mod-side/api/assets?path=..%2F..");
    assert.strictEqual(traversal.statusCode, 404);
    const writeAttempt = await request(port, "/mod-side/api/tables", { method: "POST" });
    assert.strictEqual(writeAttempt.statusCode, 405);
    const unrelated = await request(port, "/user-manager");
    assert.strictEqual(unrelated.statusCode, 404);
    console.log("asset viewer check passed");
  } finally {
    await close(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function requestJson(port, requestPath, options) {
  return request(port, requestPath, options).then((response) => {
    assert(response.statusCode >= 200 && response.statusCode < 300, response.body);
    return JSON.parse(response.body);
  });
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: options.method || "GET", headers: options.headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString(options.encoding || "utf8"),
      }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
