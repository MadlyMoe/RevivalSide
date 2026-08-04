const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir, readGameplayTableRecords } = require("../modules/gameplay-jsons");
const {
  eventDeckHasFreeShipSlot,
  eventDeckHasGivenUnitSlots,
  getEventDeckPlayerUnitSlots,
} = require("../modules/game-data");
const { getTutorialStageForRequest } = require("../stages/tutorialStage");
const { getMainStoryStageForRequest } = require("../stages/mainStoryStage");

const ROOT_DIR = path.resolve(__dirname, "..");
const UNIT_DATA = path.join(ROOT_DIR, "wiki", "data", "units.json");
const MAP_DATA = ["ab_script", "LUA_MAP_TEMPLET"];
const STAGE_DATA = ["ab_script", "LUA_STAGE_TEMPLET"];
const DUNGEON_DATA = ["ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE"];
const SKIN_DATA = ["ab_script", "LUA_SKIN_TEMPLET"];
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "application/javascript; charset=utf-8"]],
  ["/stage-webgl.js", ["stage-webgl.js", "application/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const DEFAULT_PORT = 5185;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UNITS = 24;
let combatHost;
let editableCombatHost;
let stageCatalog;
let skinBundles;
let musicAssets;
const unitRenderMetadata = new Map();

function startServer(port = DEFAULT_PORT, attempts = 0) {
  const server = http.createServer(handleRequest);
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE" && attempts < 20) {
      startServer(port + 1, attempts + 1);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Combat:Side running at http://127.0.0.1:${port}/`);
  });
  return server;
}

async function handleRequest(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || "/", "http://127.0.0.1").pathname);
  } catch {
    sendJson(req, res, 400, { error: "Bad request" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/units") {
    serveFile(req, res, UNIT_DATA, "application/json; charset=utf-8", "public, max-age=0, must-revalidate");
    return;
  }
  if (req.method === "GET" && pathname === "/api/stages") {
    try {
      sendJson(req, res, 200, { stages: getStageCatalog() });
    } catch (error) {
      sendJson(req, res, 500, { error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "POST" && pathname === "/api/simulate") {
    try {
      const scenario = await readJsonBody(req);
      sendJson(req, res, 200, simulateScenario(scenario));
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, { error: error.message || String(error) });
    }
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/asset-png/")) {
    serveAsset(req, res, pathname.slice("/asset-png/".length));
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/stage-asset/")) {
    serveStageAsset(req, res, pathname.slice("/stage-asset/".length));
    return;
  }
  if (req.method === "GET" && STATIC_FILES.has(pathname)) {
    const [file, type] = STATIC_FILES.get(pathname);
    serveFile(req, res, path.join(__dirname, file), type, "public, max-age=0, must-revalidate");
    return;
  }
  sendJson(req, res, 404, { error: "Not found" });
}

function simulateScenario(input) {
  const scenario = sanitizeScenario(input);
  return scenario.mode === "editable" ? simulateEditableScenario(scenario) : simulateManagedScenario(scenario);
}

function simulateManagedScenario(scenario) {
  const host = getCombatHost(true);
  const selectedStage = getStageCatalog().find((stage) => stage.stageId === scenario.stageId);
  if (!selectedStage) throw statusError(400, `stage ${scenario.stageId} is unavailable`);
  const playerUnits = scenario.units.filter((unit) => unit.team === 1).slice(0, 8);
  if (!playerUnits.length) throw statusError(400, "live stage mode needs at least one Team A unit");

  const stage = buildManagedStage(selectedStage, playerUnits);
  const start = host.request("startBattle", {
    req: { stageID: stage.stageId, dungeonID: stage.dungeonID, gameType: stage.gameType || 1 },
    stage,
    gameUID: String(Date.now() * 10000),
  });
  if (!start.ok || !start.battleState || !start.dynamicGame) {
    throw statusError(500, start.error || "CombatHost could not start the live stage");
  }
  if (!start.dynamicGame.managedCombat) {
    throw statusError(503, start.error || "The installed CounterSide managed runtime is unavailable");
  }

  const dynamicGame = {
    ...start.dynamicGame,
    gameSpeedType: 0,
    autoSkillType: 0,
    autoRespawnEnabled: true,
  };
  let battleState = start.battleState;
  const initial = host.request("buildInitialSync", { dynamicGame, battleState });
  if (!initial.ok) throw statusError(500, initial.error || "CounterSide stage initialization failed");
  battleState = initial.battleState || battleState;

  const frames = [];
  let records = [];
  const maxFrames = Math.ceil(scenario.duration / scenario.delta);
  // ponytail: synchronous chunks reuse CombatHost's existing worker; split the HTTP job only if concurrent simulator users matter.
  while (frames.length < maxFrames) {
    const response = host.request("buildTimeline", {
      dynamicGame,
      battleState,
      delta: scenario.delta,
      maxFrames: Math.min(300, maxFrames - frames.length),
      startIndex: frames.length,
    });
    if (!response.ok || !response.timeline || !response.timeline.frames.length) {
      throw statusError(500, response.error || `CombatHost timeline failed at frame ${frames.length}`);
    }
    battleState = response.battleState || battleState;
    frames.push(...response.timeline.frames.map(decorateManagedFrame));
    if (response.timeline.records?.length) records = response.timeline.records;
    if (response.timeline.finished) break;
  }

  const last = frames[frames.length - 1];
  const unitAssets = buildUnitAssets(frames);
  const effectAssets = buildEffectAssets(frames);
  return {
    engine: "CounterSide NKCGameServerLocal",
    mode: "live",
    managedDir: findCounterSideManagedDir(),
    delta: scenario.delta,
    stage: selectedStage,
    units: scenario.units,
    unitAssets,
    effectAssets,
    autoUltimateEnabled: frames.some((frame) => frame.autoUltimateEnabled),
    frames,
    result: {
      finished: Boolean(last && last.finished),
      winner: Number(last && last.winTeam) || 0,
      gameTime: round(last && last.gameTime),
      records,
    },
  };
}

function simulateEditableScenario(scenario) {
  const host = getCombatHost(false);
  const initialUnits = scenario.units.map((unit, index) => ({
    sourceUnitUID: String(unit.editorId),
    unitID: unit.unitId,
    unitStrID: unit.strId,
    changeUnitName: unit.name,
    unitLevel: unit.level,
    gameUnitUID: index + 1,
    team: unit.team,
    hp: unit.hp,
    maxHp: unit.hp,
    x: unit.x,
    z: unit.z,
    savedPosX: unit.x,
    right: unit.team === 1,
    playState: 1,
    stateId: 12,
    stateChangeCount: 1,
    seed: unit.seed,
    attackDamage: unit.damage,
    attackRange: unit.range,
    moveSpeed: unit.speed,
    attackCooldown: unit.cooldown,
    damageReduceRate: unit.damageReduceRate,
    tacticLevel: unit.tacticLevel,
    tacticGroup: unit.tacticGroup,
    cost: unit.cost,
    role: unit.role,
  }));
  const start = host.request("startBattle", {
    req: { stageID: scenario.stageId, dungeonID: scenario.dungeonId, gameType: 1 },
    stage: {
      stageId: scenario.stageId,
      dungeonID: scenario.dungeonId,
      mapID: scenario.mapId,
      gameType: 1,
      initialGameTime: 4,
      initialRemainGameTime: scenario.duration,
      initialUnits,
    },
    gameUID: String(Date.now() * 10000),
  });
  if (!start.ok || !start.battleState || !start.dynamicGame) {
    throw statusError(500, start.error || "CombatHost could not start the battle");
  }
  if (start.dynamicGame.managedCombat) {
    throw statusError(500, "Combat:Side requires the editable CombatHost simulation mode");
  }

  let battleState = start.battleState;
  const dynamicGame = start.dynamicGame;
  const frames = [captureFrame(0, battleState)];
  const maxFrames = Math.ceil(scenario.duration / scenario.delta) + 2;
  // ponytail: one synchronous run keeps the protocol tiny; move this loop to a worker if concurrent users matter.
  for (let index = 1; index <= maxFrames && !battleState.finished; index += 1) {
    const response = host.request("buildSync", {
      dynamicGame,
      battleState,
      delta: scenario.delta,
      skipSimulation: false,
    });
    if (!response.ok || !response.battleState) {
      throw statusError(500, response.error || `CombatHost failed at frame ${index}`);
    }
    battleState = response.battleState;
    frames.push(captureFrame(index, battleState));
  }

  return {
    engine: "CombatHost editable simulation",
    mode: "editable",
    delta: scenario.delta,
    stage: { stageId: scenario.stageId, dungeonId: scenario.dungeonId, mapId: scenario.mapId },
    units: scenario.units,
    frames,
    result: {
      finished: Boolean(battleState.finished),
      winner: battleState.finished ? (battleState.win ? 1 : 3) : 0,
      gameTime: round(battleState.gameTime),
      records: Object.values(battleState.unitRecords || {}),
    },
  };
}

function buildManagedStage(selectedStage, units) {
  const req = { stageID: selectedStage.stageId, dungeonID: selectedStage.dungeonId };
  const resolved = getTutorialStageForRequest(req) || getMainStoryStageForRequest(req) || {
    stageId: selectedStage.stageId,
    dungeonID: selectedStage.dungeonId,
    mapID: selectedStage.mapId,
    gameType: selectedStage.gameType || 1,
    eventDeckId: selectedStage.eventDeckId || 0,
    initialUnits: [],
    autoDeployUnits: [],
  };
  const eventDeckId = Number(resolved.eventDeckId || resolved.EventDeckId || selectedStage.eventDeckId || 0);
  const freeSlots = eventDeckId > 0 ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
  const tutorial = selectedStage.stageId >= 11211 && selectedStage.stageId <= 11214;
  return {
    ...resolved,
    stageId: selectedStage.stageId,
    dungeonID: selectedStage.dungeonId,
    mapID: selectedStage.mapId,
    gameType: Number(resolved.gameType || selectedStage.gameType || 1),
    eventDeckId,
    eventDeckFreeUnitSlots: freeSlots,
    usesHybridEventDeck: eventDeckId > 0 && freeSlots.length > 0 && eventDeckHasGivenUnitSlots(eventDeckId),
    eventDeckFreeShipSlot: eventDeckId > 0 && eventDeckHasFreeShipSlot(eventDeckId),
    playerDeck: tutorial && eventDeckId > 0 ? buildPlayerIdentity() : buildPlayerDeck(units, freeSlots),
  };
}

function buildPlayerIdentity() {
  return { userUid: "9000000001", nickname: "Combat:Side", userLevel: 110, units: [] };
}

function buildPlayerDeck(units, allowedSlots) {
  const slots = allowedSlots.length ? allowedSlots : units.map((_unit, index) => index);
  const deckUnits = units.slice(0, slots.length).map((unit, index) => ({
    slotIndex: slots[index],
    unitUid: String(9100000000 + index),
    unitId: unit.unitId,
    level: unit.level,
    skinId: unit.skinId,
    limitBreakLevel: unit.limitBreakLevel,
    tacticLevel: unit.tacticLevel,
    tacticGroup: unit.tacticGroup,
    skillLevels: unit.skillLevels,
    equipItemUids: [],
  }));
  return {
    ...buildPlayerIdentity(),
    deckType: 1,
    deckIndex: 0,
    leaderIndex: deckUnits[0] ? deckUnits[0].slotIndex : -1,
    leaderUnitUid: deckUnits[0] ? deckUnits[0].unitUid : "0",
    shipUid: "9199999999",
    shipUnitId: 21001,
    shipLevel: 110,
    shipSkinId: 0,
    operatorUid: "0",
    operatorId: 0,
    operatorLevel: 1,
    equipItems: [],
    units: deckUnits,
  };
}

function decorateManagedFrame(frame) {
  return {
    ...frame,
    gameTime: round(frame.gameTime),
    playTime: round(frame.playTime),
    remainGameTime: round(frame.remainGameTime),
    units: (frame.units || []).map((unit) => {
      const skin = getSkinBundles().get(Number(unit.skinId));
      return {
        ...unit,
        id: unit.gameUnitUid,
        sourceId: String(unit.unitUid || ""),
        spriteBundleName: skin && skin.bundle || unit.spriteBundleName,
        spriteName: skin && skin.sprite || unit.spriteName,
        hp: round(unit.hp),
        maxHp: round(unit.maxHp),
        x: round(unit.x),
        z: round(unit.z),
        jumpY: round(unit.jumpY),
        gaugeOffsetX: round(unit.gaugeOffsetX),
        gaugeOffsetY: round(unit.gaugeOffsetY),
        skillCooldown: round(unit.skillCooldown),
        hyperSkillCooldown: round(unit.hyperSkillCooldown),
        hyperSkillCooldownMax: round(unit.hyperSkillCooldownMax),
      };
    }),
    effects: (frame.effects || []).map((effect) => ({
      ...effect,
      x: round(effect.x),
      z: round(effect.z),
      jumpY: round(effect.jumpY),
      animationTime: round(effect.animationTime),
      animationTimeMax: round(effect.animationTimeMax),
      scaleFactor: round(effect.scaleFactor),
      offsetX: round(effect.offsetX),
      offsetY: round(effect.offsetY),
      offsetZ: round(effect.offsetZ),
      effectBundleName: String(effect.effectBundleName || effect.mainEffectName || "").toLowerCase(),
    })),
  };
}

function getSkinBundles() {
  if (skinBundles) return skinBundles;
  skinBundles = new Map(readRecords(SKIN_DATA).map((row) => [Number(row.m_SkinID || 0), {
    bundle: String(row.m_SpriteBundleName || ""),
    sprite: String(row.m_SpriteName || ""),
  }]));
  return skinBundles;
}

function buildUnitAssets(frames) {
  const bundles = new Set();
  for (const frame of frames) {
    for (const unit of frame.units || []) {
      if (unit.spriteBundleName) bundles.add(String(unit.spriteBundleName).toLowerCase());
    }
  }
  loadUnitRenderMetadata(bundles);
  return Object.fromEntries(Array.from(bundles).map((bundle) => {
    const files = findSpineAssetSet(bundle);
    return [bundle, files && { ...files, unity: unitRenderMetadata.get(bundle) }];
  }).filter((entry) => entry[1] && entry[1].unity));
}

function buildEffectAssets(frames) {
  const bundles = new Set();
  for (const frame of frames) {
    for (const effect of frame.effects || []) {
      if (effect.effectBundleName) bundles.add(String(effect.effectBundleName).toLowerCase());
    }
  }
  return Object.fromEntries(Array.from(bundles).map((bundle) => [bundle, findEffectAssetSet(bundle)]).filter((entry) => entry[1]));
}

function loadUnitRenderMetadata(bundles) {
  const missing = Array.from(bundles).filter((bundle) => !unitRenderMetadata.has(bundle));
  if (!missing.length) return;
  const managedDir = findCounterSideManagedDir();
  const streaming = managedDir && path.join(path.dirname(managedDir), "StreamingAssets");
  const assets = missing.map((bundle) => path.join(streaming || "", `${bundle}.asset`)).filter(fs.existsSync);
  if (!assets.length) return;
  const helper = path.join(__dirname, "unity-unit-metadata.py");
  const candidates = [process.env.REVIVALSIDE_PYTHON, process.env.PYTHON, path.join(ROOT_DIR, "runtime", "python", "python.exe"), "python"].filter(Boolean);
  for (const executable of candidates) {
    const result = spawnSync(executable, [helper, ...assets], { cwd: ROOT_DIR, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) continue;
    const metadata = JSON.parse(result.stdout);
    for (const [bundle, value] of Object.entries(metadata)) unitRenderMetadata.set(bundle, value);
    return;
  }
}

function sanitizeScenario(input) {
  if (!input || !Array.isArray(input.units)) throw statusError(400, "units must be an array");
  if (input.units.length < 1 || input.units.length > MAX_UNITS) {
    throw statusError(400, `choose between 1 and ${MAX_UNITS} units`);
  }
  const units = input.units.map((unit, index) => sanitizeUnit(unit, index));
  const mode = input.mode === "editable" ? "editable" : "live";
  if (mode === "editable" && (!units.some((unit) => unit.team === 1) || !units.some((unit) => unit.team === 3))) {
    throw statusError(400, "both teams need at least one unit");
  }
  if (mode === "live" && !units.some((unit) => unit.team === 1)) throw statusError(400, "Team A needs at least one unit");
  return {
    mode,
    units,
    delta: clamp(
      finite(input.delta, mode === "live" ? 1 / 30 : 0.1),
      mode === "live" ? 1 / 120 : 0.05,
      mode === "live" ? 0.1 : 0.5
    ),
    duration: clamp(finite(input.duration, 180), 5, 240),
    stageId: integer(input.stage && input.stage.stageId, 1, 1, 999999999),
    dungeonId: integer(input.stage && input.stage.dungeonId, 1, 1, 999999999),
    mapId: integer(input.stage && input.stage.mapId, 0, 0, 999999999),
  };
}

function getStageCatalog() {
  if (stageCatalog) return stageCatalog;
  const maps = readRecords(MAP_DATA);
  const stages = readRecords(STAGE_DATA);
  const dungeons = readRecords(DUNGEON_DATA);
  const mapByStrId = new Map(maps.map((row) => [String(row.m_MapStrID || ""), row]));
  const dungeonByStrId = new Map(dungeons.map((row) => [String(row.m_DungeonStrID || ""), row]));
  const assetSets = findStageAssetSets();
  const musicSets = findMusicAssetSets();

  stageCatalog = stages.flatMap((stage) => {
    const dungeon = dungeonByStrId.get(String(stage.m_StageBattleStrID || ""));
    const map = dungeon && mapByStrId.get(String(dungeon.m_DungeonMapStrID || ""));
    const assetName = map && firstText(map.m_MapAssetName, map.m_MapStrID);
    const assets = assetName && assetSets.get(assetName.toLowerCase());
    if (!dungeon || !map || !assets) return [];
    const stageId = Number(stage.m_StageID || 0);
    const mapName = titleCaseAsset(assetName);
    const episode = Number(stage.m_EpisodeID || 0);
    const act = Number(stage.m_ActID || 0);
    const index = Number(stage.m_StageUINum || stage.m_StageIndex || 0);
    const descriptor = episode && act ? `EP${episode} ${String(stage.m_Difficulty || "")} ${act}-${index}` : String(stage.m_StageStrID || "Stage");
    return [{
      stageId,
      dungeonId: Number(dungeon.m_DungeonID || 0),
      mapId: Number(map.m_MapID || 0),
      label: `${stageId} · ${descriptor} · ${mapName}`,
      stageStrId: String(stage.m_StageStrID || ""),
      dungeonStrId: String(dungeon.m_DungeonStrID || ""),
      mapStrId: String(map.m_MapStrID || ""),
      stageType: String(stage.m_StageType || ""),
      dungeonType: String(dungeon.m_DungeonType || ""),
      gameType: 1,
      eventDeckId: Number(dungeon.m_UseEventDeck || 0),
      music: String(dungeon.m_MusicAssetName || ""),
      musicUrl: musicSets.get(String(dungeon.m_MusicAssetName || "").toLowerCase()) || "",
      assetName,
      mapName,
      renderer: assets.spine ? "Spine WebGL" : "Layered WebGL",
      layers: assets.layers.map((layer) => {
        const key = path.basename(layer.name, path.extname(layer.name)).toLowerCase();
        const source = (Array.isArray(map.m_listMapLayer) ? map.m_listMapLayer : []).find((item) => {
          const name = String(item.m_LayerName || "").toLowerCase();
          return name && (key.includes(name) || name.includes(key));
        });
        return { ...layer, moveFactor: finite(source && source.m_fMoveFactor, 0) };
      }),
      spine: assets.spine,
      camera: {
        virtualWidth: 1920,
        virtualHeight: 1080,
        minX: finite(map.m_fCamMinX, finite(map.m_fMinX, 0)),
        maxX: finite(map.m_fCamMaxX, finite(map.m_fMaxX, 1500)),
        minY: finite(map.m_fCamMinY, 0),
        maxY: finite(map.m_fCamMaxY, 0),
        size: finite(map.m_fCamSize, 500),
        sizeMax: finite(map.m_fCamSizeMax, 512),
      },
      bounds: {
        minX: finite(map.m_fMinX, 0), maxX: finite(map.m_fMaxX, 1500),
        minZ: finite(map.m_fMinZ, -270), maxZ: finite(map.m_fMaxZ, -110),
      },
    }];
  });
  return stageCatalog;
}

function findStageAssetSets() {
  const sets = new Map();
  for (const root of assetRoots()) {
    const streaming = path.join(root, "Data", "StreamingAssets");
    if (!fs.existsSync(streaming)) continue;
    for (const entry of fs.readdirSync(streaming, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith("ab_map_game_")) continue;
      const folder = path.join(streaming, entry.name);
      const prefix = path.posix.join("Data", "StreamingAssets", entry.name);
      const layers = listFiles(path.join(folder, "Sprite"), ".png")
        .sort(naturalCompare)
        .map((name) => ({ name, url: stageAssetUrl(path.posix.join(prefix, "Sprite", name)) }));
      const atlas = listFiles(path.join(folder, "TextAsset"), ".atlas")[0];
      const skeleton = listFiles(path.join(folder, "TextAsset"), ".skel")[0];
      const textures = listFiles(path.join(folder, "Texture2D"), ".png");
      const spine = atlas && skeleton && textures.length ? {
        atlas: stageAssetUrl(path.posix.join(prefix, "TextAsset", atlas)),
        skeleton: stageAssetUrl(path.posix.join(prefix, "TextAsset", skeleton)),
        textures: textures.map((name) => ({ name, url: stageAssetUrl(path.posix.join(prefix, "Texture2D", name)) })),
      } : null;
      if ((layers.length || spine) && !sets.has(entry.name.toLowerCase())) sets.set(entry.name.toLowerCase(), { layers, spine });
    }
  }
  return sets;
}

function findSpineAssetSet(bundleName) {
  const key = String(bundleName || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (!key) return null;
  for (const root of assetRoots()) {
    const streaming = path.join(root, "Data", "StreamingAssets");
    if (!fs.existsSync(streaming)) continue;
    const folder = findExtractedBundleFolder(streaming, key);
    if (!folder) continue;
    const prefix = path.relative(root, folder).split(path.sep).join("/");
    const atlas = listFiles(path.join(folder, "TextAsset"), ".atlas")[0];
    const skeleton = listFiles(path.join(folder, "TextAsset"), ".skel")[0];
    const textures = listFiles(path.join(folder, "Texture2D"), ".png");
    if (!atlas || !skeleton || !textures.length) continue;
    return {
      atlas: stageAssetUrl(path.posix.join(prefix, "TextAsset", atlas)),
      skeleton: stageAssetUrl(path.posix.join(prefix, "TextAsset", skeleton)),
      textures: textures.map((name) => ({ name, url: stageAssetUrl(path.posix.join(prefix, "Texture2D", name)) })),
    };
  }
  return null;
}

function findEffectAssetSet(bundleName) {
  const spine = findSpineAssetSet(bundleName);
  if (spine) return spine;
  const key = String(bundleName || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (!key) return null;
  for (const root of assetRoots()) {
    const streaming = path.join(root, "Data", "StreamingAssets");
    if (!fs.existsSync(streaming)) continue;
    const folder = findExtractedBundleFolder(streaming, key);
    if (!folder) continue;
    const sourceFolder = listFiles(path.join(folder, "Sprite"), ".png").length ? "Sprite" : "Texture2D";
    const prefix = path.posix.join(path.relative(root, folder).split(path.sep).join("/"), sourceFolder);
    const frames = listFiles(path.join(folder, sourceFolder), ".png").sort(naturalCompare)
      .map((name) => stageAssetUrl(path.posix.join(prefix, name)));
    if (frames.length) return { frames };
  }
  return null;
}

function findExtractedBundleFolder(streaming, key) {
  for (const candidate of [path.join(streaming, key), path.join(streaming, "fx", key)]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

function findMusicAssetSets() {
  if (musicAssets) return musicAssets;
  musicAssets = new Map();
  for (const root of assetRoots()) {
    const musicRoot = path.join(root, "Data", "StreamingAssets", "ab_music");
    if (!fs.existsSync(musicRoot)) continue;
    const pending = [musicRoot];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".wav")) {
          const key = path.basename(entry.name, ".wav").toLowerCase();
          if (!musicAssets.has(key)) musicAssets.set(key, stageAssetUrl(path.relative(root, target).split(path.sep).join("/")));
        }
      }
    }
  }
  return musicAssets;
}

function readRecords([directory, fileName]) {
  const records = readGameplayTableRecords(directory, fileName, { rootDir: ROOT_DIR, logLabel: "combat-simulator" });
  if (!records.length) throw new Error(`Gameplay table failed to load: ${directory}/luac/${fileName}`);
  return records;
}

function listFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => entry.name);
}

function stageAssetUrl(relativePath) {
  return `/stage-asset/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function firstText(value, fallback) {
  if (Array.isArray(value)) return String(value.find(Boolean) || fallback || "");
  return String(value || fallback || "");
}

function titleCaseAsset(value) {
  return String(value || "Stage").replace(/^AB_MAP_GAME_/i, "").replace(/_/g, " ").toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sanitizeUnit(unit, index) {
  if (!unit || typeof unit !== "object") throw statusError(400, `unit ${index + 1} is invalid`);
  const team = Number(unit.team) === 3 ? 3 : 1;
  return {
    editorId: text(unit.editorId, `unit-${index + 1}`, 80),
    unitId: integer(unit.unitId, 0, 0, 999999999),
    strId: text(unit.strId, "", 160),
    name: text(unit.name, `Unit ${index + 1}`, 160),
    image: safeAssetUrl(unit.image),
    assetName: text(unit.assetName, "", 260),
    sourceTable: text(unit.sourceTable, "", 160),
    tableHp: finite(unit.tableHp, 0),
    tableAtk: finite(unit.tableAtk, 0),
    tableDef: finite(unit.tableDef, 0),
    grade: text(unit.grade, "", 80),
    role: text(unit.role, "", 80),
    cost: clamp(finite(unit.cost, 0), 0, 100),
    level: integer(unit.level, 110, 1, 200),
    team,
    hp: clamp(finite(unit.hp, 1000), 1, 1000000000),
    damage: clamp(finite(unit.damage, 100), 1, 1000000),
    range: clamp(finite(unit.range, 130), 1, 6000),
    speed: clamp(finite(unit.speed, 55), 0, 1000),
    cooldown: clamp(finite(unit.cooldown, 1.2), 0.2, 30),
    damageReduceRate: clamp(finite(unit.damageReduceRate, 0), 0, 9000),
    tacticLevel: integer(unit.tacticLevel, 0, 0, 6),
    tacticGroup: integer(unit.tacticGroup, 0, 0, 1000000),
    skinId: integer(unit.skinId, 0, 0, 999999999),
    limitBreakLevel: integer(unit.limitBreakLevel, 5, 0, 20),
    skillLevels: (Array.isArray(unit.skillLevels) ? unit.skillLevels : [5, 5, 5, 5, 5])
      .slice(0, 5)
      .map((value) => integer(value, 5, 1, 10)),
    seed: integer(unit.seed, 51 + index, 1, 2147483647),
    x: clamp(finite(unit.x, team === 1 ? 180 + index * 45 : 1320 - index * 45), 0, 1500),
    z: clamp(finite(unit.z, 0), -500, 500),
  };
}

function captureFrame(index, state) {
  return {
    index,
    gameTime: round(state.gameTime),
    remainGameTime: round(state.remainGameTime),
    finished: Boolean(state.finished),
    win: Boolean(state.win),
    units: (state.units || []).map((unit) => ({
      id: unit.gameUnitUID,
      sourceId: String(unit.sourceUnitUID || ""),
      team: unit.team,
      hp: round(unit.hp),
      maxHp: round(unit.maxHp),
      x: round(unit.x),
      z: round(unit.z),
      right: Boolean(unit.right),
      stateId: unit.stateId,
      playState: unit.playState,
      targetId: unit.targetUID || 0,
    })),
  };
}

function getCombatHost(managed = true) {
  if (!managed) {
    if (!editableCombatHost) {
      editableCombatHost = createCsharpCombatHost({
        enabled: true,
        managedDir: "",
        timeoutMs: 30000,
        responseBufferBytes: 32 * 1024 * 1024,
        syncIntervalSeconds: 0.1,
      });
    }
    return editableCombatHost;
  }
  if (!combatHost) {
    const managedDir = findCounterSideManagedDir();
    combatHost = createCsharpCombatHost({
      enabled: true,
      managedDir,
      gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT_DIR, managedDir }),
      timeoutMs: 120000,
      responseBufferBytes: 64 * 1024 * 1024,
      syncIntervalSeconds: 0.1,
    });
  }
  return combatHost;
}

function serveAsset(req, res, relativePath) {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.includes("..")) {
    sendJson(req, res, 400, { error: "Invalid asset path" });
    return;
  }
  for (const root of assetRoots()) {
    const target = path.resolve(root, ...parts);
    if (isUnder(target, root) && fs.existsSync(target)) {
      serveFile(req, res, target, "image/png", "public, max-age=86400");
      return;
    }
  }
  sendJson(req, res, 404, { error: "Asset is not cached" });
}

function serveStageAsset(req, res, relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const types = { ".png": "image/png", ".atlas": "text/plain; charset=utf-8", ".skel": "application/octet-stream", ".wav": "audio/wav" };
  if (!types[extension]) {
    sendJson(req, res, 400, { error: "Unsupported stage asset" });
    return;
  }
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.includes("..")) {
    sendJson(req, res, 400, { error: "Invalid stage asset path" });
    return;
  }
  for (const root of assetRoots()) {
    const target = path.resolve(root, ...parts);
    if (isUnder(target, root) && fs.existsSync(target)) {
      serveFile(req, res, target, types[extension], "public, max-age=86400");
      return;
    }
  }
  sendJson(req, res, 404, { error: "Stage asset is not cached" });
}

function assetRoots() {
  return [
    process.env.CS_COMBAT_SIMULATOR_ASSET_ROOT,
    path.join(ROOT_DIR, ".cache", "wiki-assets", "all"),
    path.join(ROOT_DIR, "extracted-assets", "all"),
    path.join(ROOT_DIR, "prebuilt", "wiki-assets", "all"),
  ]
    .filter(Boolean)
    .map((item) => path.resolve(item))
    .filter((item, index, roots) => fs.existsSync(item) && roots.indexOf(item) === index);
}

function serveFile(req, res, target, type, cacheControl) {
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) {
      sendJson(req, res, 404, { error: "Not found" });
      return;
    }
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const headers = { "Content-Type": type, "Cache-Control": cacheControl, ETag: etag };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(target).pipe(res);
  });
}

function sendJson(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const gzip = body.length > 1024 && /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
  const output = gzip ? zlib.gzipSync(body) : body;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": output.length,
    ...(gzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
  });
  res.end(output);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      reject(statusError(415, "Content-Type must be application/json"));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(statusError(413, "Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(statusError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function safeAssetUrl(value) {
  const url = String(value || "");
  return /^\/asset-png\/[A-Za-z0-9%_./-]+$/.test(url) && !url.includes("..") ? url : "";
}

function text(value, fallback, maxLength) {
  const output = String(value == null ? fallback : value).trim();
  return (output || fallback).slice(0, maxLength);
}

function finite(value, fallback) {
  const output = Number(value);
  return Number.isFinite(output) ? output : fallback;
}

function integer(value, fallback, minimum, maximum) {
  return Math.round(clamp(finite(value, fallback), minimum, maximum));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function isUnder(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

if (require.main === module) {
  const requested = Number(process.argv[process.argv.indexOf("--port") + 1]);
  startServer(Number.isInteger(requested) && requested > 0 && requested < 65536 ? requested : DEFAULT_PORT);
}

module.exports = { getStageCatalog, sanitizeScenario, simulateScenario, startServer };
