const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractTableRecords, findGameplayTableEntry, listGameplayTableFiles, readGameplayTable } = require("../gameplay-jsons");
const { createModProjectStore } = require("../mod-projects");

const COMMON_DIRECTORY = "ab_script";
const DUNGEON_DIRECTORY = "ab_script_dungeon_templet";
const CUTSCENE_DIRECTORY = "ab_script_cutscene";
const CATEGORIES = new Set(["EC_MAINSTREAM", "EC_SIDESTORY"]);
const POSITIONS = new Set(["L", "C", "R", "L_D", "C_D", "R_D"]);
const LANGUAGES = ["KOREA", "JPN", "ENG", "TWN", "THA", "VTN", "SCN", "DEU", "FRA"];
const REWARD_FIELD = /^(m_FirstReward|m_Complete|m_Reward(Type|ID|Value))/;
const CUSTOM_MAINSTREAM_EPISODE = Object.freeze({ episodeId: 18, episodeNumber: 16, sourceEpisodeId: 17 });
const SCROLL_TYPES = new Set(["HORIZONTAL", "VERTICAL"]);
const ACTOR_PREVIEW_IMAGE_IDS = Object.freeze({
  YUMI_POLICE_NULL_NULL: "AB_UNIT_FACE_CARD_NKM_UNIT_C_POLICE_LEE_YUMI",
  USER_ADMIN_NULL_NULL: "AB_INVEN_ICON_NKM_NPC_ADMINISTRATOR",
});

function createModEpisodeMaker(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const env = options.env || process.env;
  const store = options.modStore || createModProjectStore({ rootDir, modsRoot: options.modsRoot || env.CS_MODS_ROOT });
  const assetRoot = path.resolve(options.assetRoot || env.CS_ASSET_VIEWER_ROOT || path.join(rootDir, "extracted-assets", "all"));
  let cachedAssets;
  let cachedStrings;
  let cachedBaseCutsceneIds;
  let cachedBaseStagePlacements;

  function baseEnv() {
    const value = { ...env };
    delete value.CS_MOD_TABLES_DIR;
    return value;
  }

  function recordsFor(directory, fileName) {
    const parsed = readGameplayTable(directory, fileName, { rootDir, env: baseEnv(), noCache: true });
    if (!parsed) throw httpError(422, `Required episode table was not found: ${directory}/${fileName}`);
    return extractTableRecords(parsed);
  }

  function tableEntry(directory, fileName) {
    const entry = findGameplayTableEntry(directory, fileName, { rootDir, env: baseEnv() });
    const tableName = entry?.tableName || path.basename(fileName, path.extname(fileName));
    return { directory: entry?.directory || directory, fileName: `${tableName}.json`, tableName, format: "json" };
  }

  function localizedString(key) {
    if (!key) return "";
    if (!cachedStrings) cachedStrings = new Map(recordsFor("ab_script_string_table", "LUA_STRING_ENG.json").filter(Array.isArray).map((row) => [String(row[0] || ""), row[1]]));
    const value = cachedStrings.get(String(key));
    return typeof value === "string" ? stripColor(value) : "";
  }

  function baseStagePlacements() {
    if (cachedBaseStagePlacements) return cachedBaseStagePlacements;
    const legacy = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET.json");
    const legacyEpisodes = new Set(legacy.filter(Boolean).map((row) => `${row.m_EpisodeID}:${row.m_Difficulty}`));
    const episodes = new Map(recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json")
      .filter((row) => row && row.m_EPCategory === "EC_MAINSTREAM")
      .map((row) => [`${row.m_EpisodeID}:${row.m_Difficulty}`, row]));
    const newer = recordsFor(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json").flatMap((stage) => {
      const key = stage && `${stage.m_EpisodeID}:${stage.m_Difficulty}`;
      const episode = key && !legacyEpisodes.has(key) && String(stage.m_StageStrID || "").startsWith("STAGE_MAINSTREAM_") ? episodes.get(key) : null;
      if (!episode) return [];
      const placement = { ...episode, ...stage, m_EPCategory: episode.m_EPCategory };
      Object.defineProperty(placement, "__sourceTable", { value: "LUA_STAGE_TEMPLET" });
      return [placement];
    });
    cachedBaseStagePlacements = legacy.concat(newer);
    return cachedBaseStagePlacements;
  }

  function catalog(query = "") {
    const needle = String(query || "").trim().toLowerCase();
    const episodeRows = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json");
    const episodes = episodeRows
      .filter((row) => row && CATEGORIES.has(row.m_EPCategory) && row.m_Difficulty === "NORMAL")
      .map((row) => {
        const title = localizedString(row.m_EpisodeTitle) || episodeLabel(row);
        const displayName = localizedString(row.m_EpisodeName);
        return {
          id: row.m_EpisodeID,
          strId: row.m_EpisodeStrID,
          category: row.m_EPCategory,
          categoryLabel: row.m_EPCategory === "EC_MAINSTREAM" ? "Mainstream" : "Substream",
          label: displayName && displayName !== title ? `${title} — ${displayName}` : title,
          title,
          displayName,
          actCount: row.m_ActCount,
          custom: false,
        };
      });
    if (!episodeRows.some((row) => row && (Number(row.m_EpisodeID) === CUSTOM_MAINSTREAM_EPISODE.episodeId || String(row.m_EpisodeStrID) === `ESI_MAINSTREAM_EP_${CUSTOM_MAINSTREAM_EPISODE.episodeNumber}`))) {
      const custom = customEpisodeTemplate(episodeRows, "NORMAL");
      episodes.push({ id: custom.m_EpisodeID, strId: custom.m_EpisodeStrID, category: custom.m_EPCategory, categoryLabel: "Mainstream", label: `Mainstream Episode ${CUSTOM_MAINSTREAM_EPISODE.episodeNumber} (new)`, actCount: custom.m_ActCount, custom: true, definition: defaultEpisodeDefinition(custom, episodeRows) });
    }
    const actorRows = recordsFor(COMMON_DIRECTORY, "LUA_CUTSCENE_CHAR_TEMPLET.json");
    const assets = extractedAssetIndex();
    const allActors = actorRows
      .filter((row) => row && row.m_CharStrID)
      .map((row) => ({ id: row.m_CharStrID, name: stripColor(row.m_CharStr_ENG || row.m_CharStrID), prefab: row.m_PrefabStr || "", previewAsset: actorAsset(assets, row.m_PrefabStr || row.m_CharStrID, row.m_CharStrID)?.path || "" }));
    const actors = allActors
      .filter((actor) => !needle || [actor.id, actor.name, actor.prefab].join(" ").toLowerCase().includes(needle))
      .slice(0, 150);
    const actorPreviews = Object.fromEntries(allActors.filter((actor) => actor.previewAsset).map((actor) => [actor.id, `asset?path=${encodeURIComponent(actor.previewAsset)}`]));
    const stageCharacters = [...new Set(recordsFor(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json").map((row) => String(row && row.m_StageCharStr || "").trim()).filter(Boolean))]
      .map((id) => ({ id, previewAsset: actorAsset(assets, id, id)?.path || "" }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return {
      episodes,
      actors,
      stageCharacters,
      assetsAvailable: assets.available,
      backgrounds: assets.backgrounds.length ? assets.backgrounds : ["CAFE", "CAFE_STREGA", "CLASS", "CITY_NIGHT", "OFFICE", "COUNTERSIDE_GRAVE"],
      music: assets.music.slice(0, 600),
      voices: assets.voices.slice(0, 600),
      animations: ["UNIT_IDLE", "UNIT_SERIOUS", "UNIT_SURPRISE", "UNIT_HATE", "UNIT_DESPAIR", "UNIT_LAUGH", "UNIT_PRIDE"],
      effects: assets.effects.length ? assets.effects.slice(0, 600) : ["FX_CUTSCEN_PHONE", "FX_COMBAT_ALL_FOOT_STEP_LANDING_SMALL"],
      previewAssets: {
        background: "episode-maker/preview-asset?kind=cafe",
        ...actorPreviews,
      },
    };
  }

  function asset(kind, value) {
    const id = String(value || "").trim().toUpperCase();
    if (!id) return { found: false, id, kind };
    const assets = extractedAssetIndex();
    let found;
    if (kind === "actor") {
      const row = recordsFor(COMMON_DIRECTORY, "LUA_CUTSCENE_CHAR_TEMPLET.json").find((item) => item && String(item.m_CharStrID).toUpperCase() === id);
      found = actorAsset(assets, row && (row.m_PrefabStr || row.m_CharStrID) || id, id);
    } else {
      found = assets[`${kind}ById`] && assets[`${kind}ById`].get(id);
    }
    return found ? { found: true, kind, ...found, id } : { found: false, id, kind };
  }

  function extractedAssetIndex() {
    if (cachedAssets) return cachedAssets;
    cachedAssets = buildAssetIndex(assetRoot);
    return cachedAssets;
  }

  function modPatchRows(tableName, excludedProjectId = "") {
    return store.listProjects().filter((summary) => summary.id !== excludedProjectId).flatMap((summary) => store.readProject(summary.id).patches.filter((item) => item.table.tableName === tableName && item.value).map((item) => item.value));
  }

  function usedCutsceneIds(excludedProjectId = "") {
    if (!cachedBaseCutsceneIds) {
      cachedBaseCutsceneIds = new Set();
      for (const entry of listGameplayTableFiles({ rootDir, env: baseEnv() }).filter((item) => item.directory === CUTSCENE_DIRECTORY && item.extension === ".json")) {
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(entry.filePath, "utf8")); }
        catch (err) { throw httpError(422, `Cutscene table ${entry.fileName} is invalid JSON: ${err.message}`); }
        for (const row of extractTableRecords(parsed)) if (Number.isSafeInteger(Number(row && row.m_CutScenID))) cachedBaseCutsceneIds.add(Number(row.m_CutScenID));
      }
    }
    const ids = new Set(cachedBaseCutsceneIds);
    for (const summary of store.listProjects()) {
      if (summary.id === excludedProjectId) continue;
      for (const table of store.readProject(summary.id).tables.filter((item) => item.table.directory === CUTSCENE_DIRECTORY)) {
        for (const row of extractTableRecords(table.compiled)) if (Number.isSafeInteger(Number(row && row.m_CutScenID))) ids.add(Number(row.m_CutScenID));
      }
    }
    return ids;
  }

  function suggest(episodeId, category, offset = 0, difficulty = "NORMAL") {
    const slotOffset = Math.min(49, nonNegativeInteger(offset, "Stage offset"));
    const normalizedDifficulty = episodeDifficulty(difficulty);
    const episode = requireEpisode(episodeId, category, normalizedDifficulty);
    const baseStageRows = baseStagePlacements();
    const stageRows = baseStageRows.concat(modPatchRows("LUA_EPISODE_TEMPLET"));
    const dungeonRows = recordsFor(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json").concat(modPatchRows("LUA_DUNGEON_TEMPLET_BASE"));
    const visible = stageRows.filter((row) => row && row.m_EpisodeID === episode.m_EpisodeID && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === normalizedDifficulty && row.m_OpenTag !== "TAG_COMMON_EPISODE_NO_USE");
    if (!visible.length && !episode.__custom) throw httpError(422, `Episode ${episode.m_EpisodeID} has no visible ${normalizedDifficulty.toLowerCase()} stages to append after.`);
    const sourceRows = visible.length ? visible : baseStageRows.filter((row) => row && Number(row.m_EpisodeID) === CUSTOM_MAINSTREAM_EPISODE.sourceEpisodeId && row.m_EPCategory === "EC_MAINSTREAM" && row.m_Difficulty === normalizedDifficulty && row.m_OpenTag !== "TAG_COMMON_EPISODE_NO_USE");
    const actId = visible.length ? Math.max(...visible.map((row) => Number(row.m_ActID) || 0)) : 1;
    const actRows = visible.filter((row) => Number(row.m_ActID) === actId);
    const reservedActRows = stageRows.filter((row) => row && row.m_EpisodeID === episode.m_EpisodeID && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === normalizedDifficulty && Number(row.m_ActID) === actId);
    const previous = (actRows.length ? actRows : sourceRows).reduce((best, row) => !best || Number(row.m_StageIndex) > Number(best.m_StageIndex) ? row : best, null) || {};
    const usedStageIds = new Set(stageRows.concat(modPatchRows("LUA_STAGE_TEMPLET")).map((row) => Number(row && row.m_StageID)).filter(Number.isSafeInteger));
    const cutsceneIds = usedCutsceneIds();
    let stageId = (visible.length ? Math.max(...visible.map((row) => Number(row.m_StageID) || 0)) : Math.max(...usedStageIds, 0)) + 1;
    while (usedStageIds.has(stageId) || cutsceneIds.has(900000000 + stageId)) stageId += 1;
    for (let index = 0; index < slotOffset; index += 1) { stageId += 1; while (usedStageIds.has(stageId) || cutsceneIds.has(900000000 + stageId)) stageId += 1; }
    const relatedDungeonIds = visible.map((row) => dungeonRows.find((dungeon) => dungeon && dungeon.m_DungeonStrID === row.m_StageBattleStrID)).filter(Boolean).map((row) => Number(row.m_DungeonID) || 0);
    const previousDungeon = dungeonRows.find((row) => row && row.m_DungeonStrID === previous.m_StageBattleStrID) || {};
    const usedDungeonIds = new Set(dungeonRows.map((row) => Number(row && row.m_DungeonID)).filter(Number.isSafeInteger));
    let dungeonId = (relatedDungeonIds.length ? Math.max(...relatedDungeonIds) : Math.max(...usedDungeonIds, 0)) + 1;
    while (usedDungeonIds.has(dungeonId)) dungeonId += 1;
    for (let index = 0; index < slotOffset; index += 1) { dungeonId += 1; while (usedDungeonIds.has(dungeonId)) dungeonId += 1; }
    return {
      episodeId: episode.m_EpisodeID,
      category: episode.m_EPCategory,
      difficulty: normalizedDifficulty,
      actId,
      stageIndex: (reservedActRows.length ? Math.max(...reservedActRows.map((row) => Number(row.m_StageIndex) || 0)) : 0) + 1 + slotOffset,
      stageUiNumber: (visible.length ? Number(previous.m_StageUINum || previous.m_StageIndex) : 0) + 1 + slotOffset,
      stageId,
      dungeonId,
      cutsceneId: 900000000 + stageId,
      unlockDungeonId: 0,
      stageStrId: episode.m_EPCategory === "EC_MAINSTREAM" ? `STAGE_MAINSTREAM_MODSIDE_${stageId}` : `STAGE_SUBSTREAM_MODSIDE_${stageId}`,
      dungeonStrId: `NKM_DUNGEON_MODSIDE_${stageId}`,
      cutsceneStrId: `MODSIDE_CUTSCENE_${stageId}`,
      background: "CAFE",
      stageDescription: "New Story Stage",
      stageCharacter: String(previous.m_StageCharStr || "NKM_UNIT_C_POLICE_LEE_YUMI"),
      actBackground: String(previous.m_ACT_BG_Image || ""),
      episodeThumbnail: String(previous.m_EPThumbnail || ""),
      dungeonIcon: String(previousDungeon.m_DungeonIcon || "NKM_NPC_CUT_SCENE"),
    };
  }

  function layout(episodeId, category) {
    const episodeRows = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json");
    const episode = requireEpisode(episodeId, category, "NORMAL");
    const dungeons = recordsFor(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json");
    const dungeonByStrId = new Map(dungeons.map((row) => [String(row && row.m_DungeonStrID || ""), row]));
    const stages = baseStagePlacements()
      .filter((row) => row && row.m_EpisodeID === episode.m_EpisodeID && row.m_EPCategory === episode.m_EPCategory && row.m_OpenTag !== "TAG_COMMON_EPISODE_NO_USE")
      .map((row) => {
        const dungeon = dungeonByStrId.get(String(row.m_StageBattleStrID || "")) || {};
        const cutsceneIds = [dungeon.m_CutScenStrIDBefore, dungeon.m_CutScenStrIDAfter].filter(Boolean);
        return {
          source: "base",
          title: `Stage ${Number(row.m_StageUINum || row.m_StageIndex)}`,
          stageId: Number(row.m_StageID),
          stageStrId: String(row.m_StageStrID || ""),
          difficulty: String(row.m_Difficulty || "NORMAL"),
          actId: Number(row.m_ActID),
          stageIndex: Number(row.m_StageIndex),
          stageUiNumber: Number(row.m_StageUINum || row.m_StageIndex),
          stageCharacter: String(row.m_StageCharStr || ""),
          actBackground: String(row.m_ACT_BG_Image || ""),
          episodeThumbnail: String(row.m_EPThumbnail || ""),
          dungeonId: Number(dungeon.m_DungeonID || 0),
          dungeonStrId: String(row.m_StageBattleStrID || ""),
          dungeonIcon: String(dungeon.m_DungeonIcon || ""),
          dungeonType: String(dungeon.m_DungeonType || ""),
          kind: stageKind(row, dungeon),
          cutsceneCount: cutsceneIds.length,
          cutsceneIds,
        };
      })
      .sort((left, right) => Number(left.difficulty === "HARD") - Number(right.difficulty === "HARD") || left.actId - right.actId || left.stageIndex - right.stageIndex);
    const variants = episodeRows.filter((row) => row && Number(row.m_EpisodeID) === Number(episode.m_EpisodeID) && row.m_EPCategory === episode.m_EPCategory).map((row) => ({ difficulty: row.m_Difficulty, actCount: Number(row.m_ActCount || 0), raw: row }));
    return { schemaVersion: 1, source: "base", readOnly: true, episode: { id: episode.m_EpisodeID, strId: episode.m_EpisodeStrID, category: episode.m_EPCategory, label: episode.__custom ? `Mainstream Episode ${CUSTOM_MAINSTREAM_EPISODE.episodeNumber}` : episodeLabel(episode), custom: Boolean(episode.__custom), variants, definition: defaultEpisodeDefinition(episode, episodeRows) }, stages };
  }

  function inspectStage(stageId, episodeId, category, difficulty) {
    const id = positiveInteger(stageId, "Stage ID");
    const episodeFilter = episodeId == null || episodeId === "" ? 0 : positiveInteger(episodeId, "Episode ID");
    const difficultyFilter = difficulty ? episodeDifficulty(difficulty) : "";
    const placements = baseStagePlacements();
    const placement = placements.find((row) => row && Number(row.m_StageID) === id && (!episodeFilter || Number(row.m_EpisodeID) === episodeFilter) && (!category || row.m_EPCategory === category) && (!difficultyFilter || row.m_Difficulty === difficultyFilter));
    if (!placement) throw httpError(404, `Stage ${id} was not found in the selected episode.`);
    const stage = recordsFor(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json").find((row) => row && Number(row.m_StageID) === id) || null;
    const dungeon = recordsFor(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json").find((row) => row && String(row.m_DungeonStrID) === String(placement.m_StageBattleStrID)) || null;
    const episode = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json").find((row) => row && Number(row.m_EpisodeID) === Number(placement.m_EpisodeID) && row.m_EPCategory === placement.m_EPCategory && row.m_Difficulty === placement.m_Difficulty) || null;
    const registrations = new Map(recordsFor(COMMON_DIRECTORY, "LUA_CUTSCENE_FILE_LIST.json").map((row) => [String(row && row.m_CutScenFile || "").toUpperCase(), row]));
    const characters = new Map(recordsFor(COMMON_DIRECTORY, "LUA_CUTSCENE_CHAR_TEMPLET.json").map((row) => [String(row && row.m_CharStrID || "").toUpperCase(), stripColor(row && row.m_CharStr_ENG || row && row.m_CharStrID || "Speaker")]));
    const cutscenes = dungeon ? [["before", dungeon.m_CutScenStrIDBefore], ["after", dungeon.m_CutScenStrIDAfter]].filter((entry) => entry[1]).map(([slot, cutsceneId]) => readBaseCutscene(slot, cutsceneId, registrations, characters)) : [];
    const titleKey = String(dungeon && dungeon.m_DungeonName || "");
    const descriptionKey = String(placement.m_StageDesc || stage && stage.m_StageDesc || dungeon && dungeon.m_DungeonDesc || "");
    const result = {
      schemaVersion: 1,
      source: "base",
      readOnly: true,
      objectId: `base-stage:${placement.m_EPCategory}:${placement.m_EpisodeID}:${placement.m_Difficulty}:${id}`,
      name: `Stage ${Number(placement.m_StageUINum || placement.m_StageIndex)}`,
      kind: stageKind(placement, dungeon),
      placement: {
        category: placement.m_EPCategory,
        episodeId: Number(placement.m_EpisodeID),
        episodeStrId: String(placement.m_EpisodeStrID || ""),
        difficulty: String(placement.m_Difficulty || "NORMAL"),
        actId: Number(placement.m_ActID || 0),
        stageIndex: Number(placement.m_StageIndex || 0),
        stageNumber: Number(placement.m_StageUINum || placement.m_StageIndex || 0),
      },
      ids: {
        stageId: id,
        stageStrId: String(placement.m_StageStrID || ""),
        dungeonId: Number(dungeon && dungeon.m_DungeonID || 0),
        dungeonStrId: String(placement.m_StageBattleStrID || ""),
      },
      clientUi: {
        titleId: String(placement.m_StageStrID || ""),
        titleKey,
        title: localizedString(titleKey) || `Stage ${Number(placement.m_StageUINum || placement.m_StageIndex)}`,
        descriptionId: descriptionKey,
        description: localizedString(descriptionKey),
        avatar: String(placement.m_StageCharStr || stage && stage.m_StageCharStr || ""),
        episodeThumbnail: String(placement.m_EPThumbnail || ""),
        actBackground: String(stage && stage.m_ACT_BG_Image || ""),
        dungeonIcon: String(dungeon && dungeon.m_DungeonIcon || ""),
      },
      unlock: {
        basicType: String(placement.m_StageBasicUnlockType || stage && stage.m_StageBasicUnlockType || ""),
        requirementType: String(placement.m_UnlockReqType || stage && stage.m_UnlockReqType || ""),
        requirementValue: Number(placement.m_UnlockReqValue || stage && stage.m_UnlockReqValue || 0),
      },
      cutscenes,
      raw: { episode, placement, placementTable: placement.__sourceTable || "LUA_EPISODE_TEMPLET", stage, dungeon },
    };
    result.override = stageOverrideSource(result);
    return result;
  }

  function readBaseCutscene(slot, cutsceneId, registrations, characters) {
    const id = String(cutsceneId || "").trim();
    const parsed = readGameplayTable(CUTSCENE_DIRECTORY, `${id}.json`, { rootDir, env: baseEnv(), noCache: true });
    const events = parsed ? extractTableRecords(parsed).slice().sort((left, right) => Number(left.m_CutScenProcessKey || 0) - Number(right.m_CutScenProcessKey || 0)) : [];
    return {
      slot,
      id,
      registered: registrations.has(id.toUpperCase()),
      registration: registrations.get(id.toUpperCase()) || null,
      recordCount: events.length,
      frames: baseCutsceneFrames(events, characters),
      events,
      error: parsed ? "" : `Cutscene table ${id} was not found.`,
    };
  }

  function createOverride(input = {}) {
    const projectId = String(input.projectId || "").trim();
    store.readProject(projectId);
    const difficulty = episodeDifficulty(input.difficulty);
    const source = inspectStage(input.stageId, input.episodeId, input.category, difficulty);
    if (input.baseObjectId && input.baseObjectId !== source.objectId) throw httpError(409, "The selected base stage changed. Reopen it before saving the override.");
    const base = source.override;
    for (const [field, label] of [["stageId", "Stage ID"], ["dungeonId", "Dungeon ID"], ["cutsceneId", "Cutscene ID"]]) {
      if (input[field] != null && Number(input[field]) !== Number(base[field])) throw httpError(400, `${label} cannot change in an override.`);
    }
    for (const [field, label] of [["stageStrId", "Stage string ID"], ["dungeonStrId", "Dungeon string ID"], ["cutsceneStrId", "Cutscene string ID"]]) {
      if (input[field] != null && String(input[field]) !== String(base[field])) throw httpError(400, `${label} cannot change in an override.`);
    }
    const episode = requireEpisode(input.episodeId, input.category, difficulty);
    const current = {
      ...base,
      title: requiredText(input.title == null ? base.title : input.title, "Title", 180),
      stageDescription: limitedText(input.stageDescription == null ? base.stageDescription : input.stageDescription, "Stage preview description", 500, false),
      actId: positiveInteger(input.actId == null ? base.actId : input.actId, "Act ID"),
      stageIndex: positiveInteger(input.stageIndex == null ? base.stageIndex : input.stageIndex, "Stage index"),
      stageUiNumber: positiveInteger(input.stageUiNumber == null ? base.stageUiNumber : input.stageUiNumber, "Stage UI number"),
      stageCharacter: gameId(input.stageCharacter == null ? base.stageCharacter : input.stageCharacter, "Stage avatar ID"),
      unlockDungeonId: nonNegativeInteger(input.unlockDungeonId == null ? base.unlockDungeonId : input.unlockDungeonId, "Unlock value"),
      actBackground: optionalGameId(input.actBackground == null ? base.actBackground : input.actBackground, "Act background image"),
      episodeThumbnail: optionalGameId(input.episodeThumbnail == null ? base.episodeThumbnail : input.episodeThumbnail, "Episode thumbnail"),
      dungeonIcon: optionalGameId(input.dungeonIcon == null ? base.dungeonIcon : input.dungeonIcon, "Dungeon icon"),
      music: optionalGameId(input.music == null ? base.music : input.music, "Stage music"),
    };
    if (current.actId > Number(episode.m_ActCount || 1)) throw httpError(400, `Stage act ${current.actId} exceeds the episode act count ${Number(episode.m_ActCount || 1)}.`);
    assertOverridePlacementAvailable(projectId, source, current, input.ignoreProjectId);

    const placement = cloneJson(source.raw.placement);
    const stage = source.raw.stage ? cloneJson(source.raw.stage) : null;
    const dungeon = source.raw.dungeon ? cloneJson(source.raw.dungeon) : null;
    for (const row of [placement, stage].filter(Boolean)) {
      row.m_ActID = current.actId;
      row.m_StageIndex = current.stageIndex;
      row.m_StageUINum = current.stageUiNumber;
      row.m_StageCharStr = current.stageCharacter;
      row.m_UnlockReqValue = current.unlockDungeonId;
    }
    if (stage) {
      if (current.actBackground) stage.m_ACT_BG_Image = current.actBackground;
      else delete stage.m_ACT_BG_Image;
    }
    if (current.episodeThumbnail) placement.m_EPThumbnail = current.episodeThumbnail;
    else delete placement.m_EPThumbnail;
    if (dungeon) {
      dungeon.m_DungeonIcon = current.dungeonIcon;
      if (current.music) {
        dungeon.m_MusicAssetName = current.music;
        dungeon.m_MusicAssetBundleName = `AB_MUSIC/${current.music}`;
      } else {
        delete dungeon.m_MusicAssetName;
        delete dungeon.m_MusicAssetBundleName;
      }
    }
    const cutsceneForks = input.forkCutscenes ? writeCutsceneForks(projectId, input, source, dungeon) : [];

    const changes = [];
    if (source.raw.placementTable === "LUA_EPISODE_TEMPLET") writeOverrideRecord(projectId, tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET.json"), "m_StageID", source.ids.stageId, source.raw.placement, placement, changes, input.ignoreProjectId);
    if (stage) writeOverrideRecord(projectId, tableEntry(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json"), "m_StageID", source.ids.stageId, source.raw.stage, stage, changes, input.ignoreProjectId);
    if (dungeon) writeOverrideRecord(projectId, tableEntry(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json"), "m_DungeonID", source.ids.dungeonId, source.raw.dungeon, dungeon, changes, input.ignoreProjectId);
    const generatedStrings = [];
    for (const [field, key] of [["title", source.clientUi.titleKey], ["stageDescription", source.clientUi.descriptionId]]) {
      if (current[field] === base[field]) continue;
      if (!key) throw httpError(422, `${field === "title" ? "Title" : "Description"} cannot be overridden because the base stage has no string key.`);
      store.writeString(projectId, key, current[field]);
      generatedStrings.push(key);
      changes.push({ string: key, before: base[field], after: current[field] });
    }
    const authoring = {
      schemaVersion: 2,
      kind: "stage-override",
      operation: "override",
      title: current.title,
      placement: { category: source.placement.category, episodeId: source.placement.episodeId, difficulty, actId: current.actId, stageIndex: current.stageIndex, stageUiNumber: current.stageUiNumber },
      ids: { stageId: source.ids.stageId, stageStrId: source.ids.stageStrId, dungeonId: source.ids.dungeonId, dungeonStrId: source.ids.dungeonStrId, cutsceneId: base.cutsceneId, cutsceneStrId: base.cutsceneStrId },
      base: { objectId: source.objectId, snapshot: base },
      unlockDungeonId: current.unlockDungeonId,
      unlockRequirementType: base.unlockRequirementType,
      background: base.background,
      music: current.music,
      stageDescription: current.stageDescription,
      stageCharacter: current.stageCharacter,
      clientUi: { title: current.title, description: current.stageDescription, avatar: current.stageCharacter, stageNumber: current.stageUiNumber, actBackground: current.actBackground, episodeThumbnail: current.episodeThumbnail, dungeonIcon: current.dungeonIcon },
      cutsceneReadOnly: !cutsceneForks.length,
      forkCutscenes: Boolean(cutsceneForks.length),
      cutsceneRefs: cutsceneForks.length ? cutsceneForks.map(({ slot, sourceId, id, strId, recordCount }) => ({ slot, sourceId, id, strId, recordCount })) : source.cutscenes.map((cutscene) => ({ slot: cutscene.slot, id: cutscene.id, recordCount: cutscene.recordCount })),
      scenes: cutsceneForks.length ? cutsceneForks.flatMap((fork) => fork.scenes) : [],
      generatedStrings,
      changes,
    };
    const forkRecords = cutsceneForks.flatMap((fork) => fork.records);
    return { project: store.readProject(projectId), authoring, cutscene: { recordCount: forkRecords.length, records: forkRecords }, exportFileName: `${projectId}.zip` };
  }

  function writeOverrideRecord(projectId, table, field, value, before, after, changes, ignoreProjectId = "") {
    const fields = changedRecordFields(before, after);
    if (!fields.length) return;
    store.writePatch(projectId, patch(table, field, value, after));
    changes.push({ table: table.tableName, key: { field, value }, fields });
  }

  function createClone(input = {}, episodeDefinition = null) {
    const projectId = String(input.projectId || "").trim();
    store.readProject(projectId);
    const source = inspectStage(input.sourceStageId, input.sourceEpisodeId, input.sourceCategory, input.sourceDifficulty);
    if (input.sourceObjectId && input.sourceObjectId !== source.objectId) throw httpError(409, "The stage template changed. Reopen it before saving the clone.");
    if (!source.raw.dungeon) throw httpError(422, "This stage uses a shared non-dungeon battle template. It can be viewed or overridden, but cannot be cloned safely yet.");
    const difficulty = episodeDifficulty(input.difficulty);
    const episode = requireEpisode(input.episodeId, input.category, difficulty);
    if (episode.__custom && !episodeDefinition) throw httpError(400, "A custom Episode 16 definition is required before adding stages.");
    const stageId = positiveInteger(input.stageId, "Stage ID");
    const dungeonId = positiveInteger(input.dungeonId, "Dungeon ID");
    const unlockDungeonId = nonNegativeInteger(input.unlockDungeonId, "Unlock dungeon ID");
    if (unlockDungeonId === dungeonId) throw httpError(400, "A cloned stage cannot unlock from its own clear state.");
    const actId = positiveInteger(input.actId, "Act ID");
    const actLimit = episodeDefinition ? (difficulty === "HARD" ? episodeDefinition.hardMode.actCount : episodeDefinition.actCount) : Number(episode.m_ActCount || 1);
    if (difficulty === "HARD" && episodeDefinition && !episodeDefinition.hardMode.enabled) throw httpError(400, "Enable Hard mode before adding Hard stages.");
    if (actId > actLimit) throw httpError(400, `${difficulty === "HARD" ? "Hard" : "Normal"} stage act ${actId} exceeds the configured act count ${actLimit}.`);
    const stageIndex = positiveInteger(input.stageIndex, "Stage index");
    const stageUiNumber = positiveInteger(input.stageUiNumber || stageIndex, "Stage UI number");
    const stageStrId = gameId(input.stageStrId, "Stage string ID");
    const dungeonStrId = gameId(input.dungeonStrId, "Dungeon string ID");
    const title = requiredText(input.title, "Title", 180);
    const stageDescription = requiredText(input.stageDescription || title, "Stage preview description", 500);
    const stageCharacter = gameId(input.stageCharacter || source.clientUi.avatar || "NKM_UNIT_C_POLICE_LEE_YUMI", "Stage avatar ID");
    const actBackground = optionalGameId(input.actBackground == null ? source.clientUi.actBackground : input.actBackground, "Act background image");
    const episodeThumbnail = optionalGameId(input.episodeThumbnail == null ? source.clientUi.episodeThumbnail : input.episodeThumbnail, "Episode thumbnail");
    const dungeonIcon = optionalGameId(input.dungeonIcon == null ? source.clientUi.dungeonIcon : input.dungeonIcon, "Dungeon icon");
    const music = optionalGameId(input.music == null ? source.override.music : input.music, "Stage music");
    if (episode.m_EPCategory === "EC_MAINSTREAM" && !stageStrId.startsWith("STAGE_MAINSTREAM_")) throw httpError(400, "Mainstream stage string IDs must start with STAGE_MAINSTREAM_.");
    assertAvailable("LUA_EPISODE_TEMPLET", "m_StageID", stageId, projectId);
    assertAvailable("LUA_EPISODE_TEMPLET", "m_StageStrID", stageStrId, projectId);
    assertAvailable("LUA_STAGE_TEMPLET", "m_StageID", stageId, projectId);
    assertAvailable("LUA_STAGE_TEMPLET", "m_StageStrID", stageStrId, projectId);
    assertAvailable("LUA_DUNGEON_TEMPLET_BASE", "m_DungeonID", dungeonId, projectId);
    assertAvailable("LUA_DUNGEON_TEMPLET_BASE", "m_DungeonStrID", dungeonStrId, projectId);
    assertPlacementAvailable(projectId, episode, actId, stageIndex);

    const stageTitleKey = `MODSIDE_STAGE_TITLE_${stageId}`;
    const stageDescriptionKey = `MODSIDE_STAGE_DESCRIPTION_${stageId}`;
    const placement = cloneJson(source.raw.placement);
    const stage = source.raw.stage ? cloneJson(source.raw.stage) : null;
    const dungeon = cloneJson(source.raw.dungeon);
    for (const row of [placement, stage].filter(Boolean)) {
      row.m_StageID = stageId;
      row.m_StageStrID = stageStrId;
      row.m_EpisodeID = episode.m_EpisodeID;
      row.m_EPCategory = episode.m_EPCategory;
      row.m_Difficulty = difficulty;
      row.m_ActID = actId;
      row.m_StageIndex = stageIndex;
      row.m_StageUINum = stageUiNumber;
      row.m_StageBattleStrID = dungeonStrId;
      row.m_StageDesc = stageDescriptionKey;
      row.m_StageCharStr = stageCharacter;
      row.m_StageBasicUnlockType = "SBUT_OPEN";
      row.m_UnlockReqType = unlockDungeonId > 0 ? "SURT_CLEAR_DUNGEON" : "SURT_PLAYER_LEVEL";
      row.m_UnlockReqValue = unlockDungeonId || 1;
      row.m_OpenTag = episodeDefinition ? (difficulty === "HARD" ? episodeDefinition.hardMode.openTag : episodeDefinition.openTag) : episode.m_OpenTag;
    }
    if (stage) {
      if (actBackground) stage.m_ACT_BG_Image = actBackground;
      else delete stage.m_ACT_BG_Image;
    }
    if (episodeThumbnail) placement.m_EPThumbnail = episodeThumbnail;
    else delete placement.m_EPThumbnail;
    dungeon.m_DungeonID = dungeonId;
    dungeon.m_DungeonStrID = dungeonStrId;
    dungeon.m_DungeonName = stageTitleKey;
    if (dungeonIcon) dungeon.m_DungeonIcon = dungeonIcon;
    else delete dungeon.m_DungeonIcon;
    if (music) {
      dungeon.m_MusicAssetName = music;
      dungeon.m_MusicAssetBundleName = `AB_MUSIC/${music}`;
    } else {
      delete dungeon.m_MusicAssetName;
      delete dungeon.m_MusicAssetBundleName;
    }
    const cutsceneForks = input.forkCutscenes ? writeCutsceneForks(projectId, input, source, dungeon) : [];

    store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET.json"), "m_StageID", stageId, placement));
    if (stage) store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json"), "m_StageID", stageId, stage));
    store.writePatch(projectId, patch(tableEntry(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json"), "m_DungeonID", dungeonId, dungeon));
    store.writeString(projectId, stageTitleKey, title);
    store.writeString(projectId, stageDescriptionKey, stageDescription);
    const authoring = {
      schemaVersion: 3,
      kind: "stage-clone",
      operation: "clone",
      title,
      placement: { category: episode.m_EPCategory, episodeId: episode.m_EpisodeID, difficulty, actId, stageIndex, stageUiNumber },
      ids: { stageId, stageStrId, dungeonId, dungeonStrId, cutsceneId: 0, cutsceneStrId: "" },
      base: { objectId: source.objectId, stageId: source.ids.stageId, episodeId: source.placement.episodeId, category: source.placement.category, difficulty: source.placement.difficulty },
      unlockDungeonId,
      background: source.override.background,
      music,
      stageDescription,
      stageCharacter,
      clientUi: { title, description: stageDescription, avatar: stageCharacter, stageNumber: stageUiNumber, actBackground, episodeThumbnail, dungeonIcon },
      cutsceneReadOnly: !cutsceneForks.length,
      forkCutscenes: Boolean(cutsceneForks.length),
      cutsceneRefs: cutsceneForks.length ? cutsceneForks.map(({ slot, sourceId, id, strId, recordCount }) => ({ slot, sourceId, id, strId, recordCount })) : source.cutscenes.map((cutscene) => ({ slot: cutscene.slot, id: cutscene.id, recordCount: cutscene.recordCount })),
      scenes: cutsceneForks.length ? cutsceneForks.flatMap((fork) => fork.scenes) : [],
      generatedStrings: [stageTitleKey, stageDescriptionKey],
    };
    const forkRecords = cutsceneForks.flatMap((fork) => fork.records);
    return { project: store.readProject(projectId), authoring, cutscene: { recordCount: forkRecords.length, records: forkRecords }, exportFileName: `${projectId}.zip` };
  }

  function createStage(input = {}, episodeDefinition = null) {
    const projectId = String(input.projectId || "").trim();
    const difficulty = episodeDifficulty(input.difficulty);
    const episode = requireEpisode(input.episodeId, input.category, difficulty);
    if (episode.__custom && !episodeDefinition) throw httpError(400, "A custom Episode 16 definition is required before adding stages.");
    const stageId = positiveInteger(input.stageId, "Stage ID");
    const dungeonId = positiveInteger(input.dungeonId, "Dungeon ID");
    const unlockDungeonId = nonNegativeInteger(input.unlockDungeonId, "Unlock dungeon ID");
    if (unlockDungeonId === dungeonId) throw httpError(400, "A cutscene stage cannot unlock from its own clear state.");
    const cutsceneId = positiveInteger(input.cutsceneId, "Cutscene ID");
    const actId = positiveInteger(input.actId, "Act ID");
    const actLimit = episodeDefinition ? (difficulty === "HARD" ? episodeDefinition.hardMode.actCount : episodeDefinition.actCount) : Number(episode.m_ActCount || 1);
    if (difficulty === "HARD" && episodeDefinition && !episodeDefinition.hardMode.enabled) throw httpError(400, "Enable Hard mode before adding Hard stages.");
    if (actId > actLimit) throw httpError(400, `${difficulty === "HARD" ? "Hard" : "Normal"} stage act ${actId} exceeds the configured act count ${actLimit}.`);
    const stageIndex = positiveInteger(input.stageIndex, "Stage index");
    const stageUiNumber = positiveInteger(input.stageUiNumber || stageIndex, "Stage UI number");
    const stageStrId = gameId(input.stageStrId, "Stage string ID");
    const dungeonStrId = gameId(input.dungeonStrId, "Dungeon string ID");
    const cutsceneStrId = gameId(input.cutsceneStrId, "Cutscene string ID");
    const title = requiredText(input.title, "Title", 180);
    const stageDescription = requiredText(input.stageDescription || title, "Stage preview description", 500);
    const stageCharacter = gameId(input.stageCharacter || "NKM_UNIT_C_POLICE_LEE_YUMI", "Stage avatar ID");
    const background = gameId(input.background || "CAFE", "Background");
    if (episode.m_EPCategory === "EC_MAINSTREAM" && !stageStrId.startsWith("STAGE_MAINSTREAM_")) throw httpError(400, "Mainstream stage string IDs must start with STAGE_MAINSTREAM_.");
    const scenes = normalizeScenes(input.scenes);
    assertAvailable("LUA_EPISODE_TEMPLET", "m_StageID", stageId, projectId);
    assertAvailable("LUA_EPISODE_TEMPLET", "m_StageStrID", stageStrId, projectId);
    assertAvailable("LUA_STAGE_TEMPLET", "m_StageID", stageId, projectId);
    assertAvailable("LUA_STAGE_TEMPLET", "m_StageStrID", stageStrId, projectId);
    assertAvailable("LUA_DUNGEON_TEMPLET_BASE", "m_DungeonID", dungeonId, projectId);
    assertAvailable("LUA_DUNGEON_TEMPLET_BASE", "m_DungeonStrID", dungeonStrId, projectId);
    assertAvailable("LUA_CUTSCENE_FILE_LIST", "m_CutScenFile", cutsceneStrId, projectId);
    assertPlacementAvailable(projectId, episode, actId, stageIndex);
    assertFullTableAvailable(projectId, cutsceneStrId);
    assertCutsceneIdAvailable(projectId, cutsceneId);
    let project;
    try { project = store.readProject(projectId); }
    catch (err) {
      if (err.statusCode !== 404) throw err;
      project = store.createProject({ id: projectId, name: input.projectName || title, version: input.version || "0.1.0", author: input.author, description: input.description || `Cutscene-only stage: ${title}` });
    }
    const episodeRows = baseStagePlacements();
    const stageRows = recordsFor(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json");
    const dungeonRows = recordsFor(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json");
    const episodeSource = sourceStage(episodeRows, episode, actId, difficulty);
    const stageSource = stageRows.find((row) => row && row.m_StageID === episodeSource.m_StageID) || episodeSource;
    const stageTitleKey = `MODSIDE_STAGE_TITLE_${stageId}`;
    const stageDescriptionKey = `MODSIDE_STAGE_DESCRIPTION_${stageId}`;
    const actBackground = optionalGameId(input.actBackground == null ? episodeDefinition && episodeDefinition.actBackground || stageSource.m_ACT_BG_Image : input.actBackground, "Act background image");
    const episodeThumbnail = optionalGameId(input.episodeThumbnail == null ? episodeDefinition && episodeDefinition.thumbnail || episodeSource.m_EPThumbnail : input.episodeThumbnail, "Episode thumbnail");
    const dungeonIcon = gameId(input.dungeonIcon || "NKM_NPC_CUT_SCENE", "Dungeon icon");
    const stage = cleanRewards({
      ...stageSource,
      m_StageID: stageId,
      m_StageStrID: stageStrId,
      m_EpisodeID: episode.m_EpisodeID,
      m_Difficulty: difficulty,
      m_ActID: actId,
      m_StageIndex: stageIndex,
      m_StageUINum: stageUiNumber,
      m_StageType: "ST_DUNGEON",
      m_StageBattleStrID: dungeonStrId,
      m_StageDesc: stageDescriptionKey,
      m_StageCharStr: stageCharacter,
      m_StageBasicUnlockType: "SBUT_OPEN",
      m_UnlockReqType: unlockDungeonId > 0 ? "SURT_CLEAR_DUNGEON" : "SURT_PLAYER_LEVEL",
      m_UnlockReqValue: unlockDungeonId || 1,
      m_OpenTag: episodeDefinition ? (difficulty === "HARD" ? episodeDefinition.hardMode.openTag : episodeDefinition.openTag) : episode.m_OpenTag,
      ...(actBackground ? { m_ACT_BG_Image: actBackground } : {}),
    });
    const episodeStage = cleanRewards({
      ...episodeSource,
      m_StageID: stage.m_StageID,
      m_StageStrID: stage.m_StageStrID,
      m_EpisodeID: stage.m_EpisodeID,
      m_Difficulty: stage.m_Difficulty,
      m_ActID: stage.m_ActID,
      m_StageIndex: stage.m_StageIndex,
      m_StageUINum: stage.m_StageUINum,
      m_StageType: stage.m_StageType,
      m_StageBattleStrID: stage.m_StageBattleStrID,
      m_StageDesc: stage.m_StageDesc,
      m_StageCharStr: stage.m_StageCharStr,
      m_StageBasicUnlockType: stage.m_StageBasicUnlockType,
      m_UnlockReqType: stage.m_UnlockReqType,
      m_UnlockReqValue: stage.m_UnlockReqValue,
      m_OpenTag: stage.m_OpenTag,
      ...(episodeThumbnail ? { m_EPThumbnail: episodeThumbnail } : {}),
    });
    const dungeon = {
      m_DungeonID: dungeonId,
      m_DungeonStrID: dungeonStrId,
      m_DungeonType: "NDT_CUTSCENE",
      m_DungeonName: stageTitleKey,
      m_DungeonIcon: dungeonIcon,
      m_DungeonLevel: 1,
      m_fDungeonTimeMax: 0,
      m_DGRecommendFightPower: 0,
      m_DGLimitUserLevel: 1,
      m_CutScenStrIDBefore: cutsceneStrId,
      m_bBonus_Resource: false,
      m_RewardUserEXP: 0,
      m_RewardUnitEXP: 0,
      m_RewardCredit_Min: 0,
      m_RewardCredit_Max: 0,
      m_RewardEternium_Min: 0,
      m_RewardEternium_Max: 0,
      m_RewardInformation_Min: 0,
      m_RewardInformation_Max: 0,
      m_RewardMultiplyMax: 99,
    };

    store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_STAGE_TEMPLET.json"), "m_StageID", stageId, stage));
    store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET.json"), "m_StageID", stageId, episodeStage));
    store.writePatch(projectId, patch(tableEntry(DUNGEON_DIRECTORY, "LUA_DUNGEON_TEMPLET_BASE.json"), "m_DungeonID", dungeonId, dungeon));
    store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_CUTSCENE_FILE_LIST.json"), "m_CutScenFile", cutsceneStrId, { m_CutScenFile: cutsceneStrId, m_CutScenType: "NCT_MAIN" }));

    const characterRows = recordsFor(COMMON_DIRECTORY, "LUA_CUTSCENE_CHAR_TEMPLET.json");
    const speakerIds = writeSpeakerNames(projectId, cutsceneStrId, scenes, characterRows);
    const records = buildCutsceneRecords({ cutsceneId, cutsceneStrId, background, music: input.music, scenes, speakerIds });
    store.writeFullTable(projectId, {
      table: { directory: CUTSCENE_DIRECTORY, fileName: `${cutsceneStrId}.json`, tableName: cutsceneStrId, format: "json" },
      compiled: { source: "revivalside-episode-maker", rootName: "m_dicNKCCutScenTempletByID", records },
    });
    store.writeString(projectId, stageTitleKey, title);
    store.writeString(projectId, stageDescriptionKey, stageDescription);
    const authoring = {
      schemaVersion: 1,
      kind: "cutscene-stage",
      title,
      placement: { category: episode.m_EPCategory, episodeId: episode.m_EpisodeID, difficulty, actId, stageIndex, stageUiNumber },
      ids: { stageId, stageStrId, dungeonId, dungeonStrId, cutsceneId, cutsceneStrId },
      unlockDungeonId,
      background,
      music: String(input.music || ""),
      stageDescription,
      stageCharacter,
      clientUi: { title, description: stageDescription, avatar: stageCharacter, stageNumber: stageUiNumber, actBackground, episodeThumbnail, dungeonIcon },
      scenes,
      generatedStrings: [stageTitleKey, stageDescriptionKey],
    };
    store.writeAssetSource(projectId, "episode-maker/project.json", Buffer.from(`${JSON.stringify(authoring, null, 2)}\n`, "utf8"));
    return { project: store.readProject(projectId), authoring, cutscene: { recordCount: records.length, records }, exportFileName: `${projectId}.zip` };
  }

  function requireEpisode(episodeId, category, difficulty = "NORMAL") {
    const id = Number(episodeId);
    const normalizedDifficulty = episodeDifficulty(difficulty);
    const rows = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json");
    const episode = rows.find((row) => row && row.m_EpisodeID === id && row.m_Difficulty === normalizedDifficulty && CATEGORIES.has(row.m_EPCategory) && (!category || row.m_EPCategory === category));
    if (!episode && id === CUSTOM_MAINSTREAM_EPISODE.episodeId && (!category || category === "EC_MAINSTREAM")) return customEpisodeTemplate(rows, normalizedDifficulty);
    if (!episode) throw httpError(404, `Mainstream or Substream episode was not found: ${episodeId}`);
    return episode;
  }

  function sourceStage(rows, episode, actId, difficulty = "NORMAL") {
    let candidates = rows.filter((row) => row && row.m_EpisodeID === episode.m_EpisodeID && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === difficulty && row.m_OpenTag !== "TAG_COMMON_EPISODE_NO_USE");
    if (!candidates.length && episode.__custom) candidates = rows.filter((row) => row && row.m_EPCategory === "EC_MAINSTREAM" && row.m_Difficulty === difficulty && row.m_OpenTag !== "TAG_COMMON_EPISODE_NO_USE").sort((left, right) => Number(right.m_EpisodeID || 0) - Number(left.m_EpisodeID || 0) || Number(right.m_ActID || 0) - Number(left.m_ActID || 0));
    const act = candidates.filter((row) => Number(row.m_ActID) === actId);
    return act.find((row) => row.m_StageCharStr) || act.at(-1) || candidates[0] || (() => { throw httpError(422, "The selected episode has no source stage."); })();
  }

  function assertAvailable(tableName, field, value, projectId) {
    const table = tableName === "LUA_DUNGEON_TEMPLET_BASE" ? recordsFor(DUNGEON_DIRECTORY, `${tableName}.json`) : recordsFor(COMMON_DIRECTORY, `${tableName}.json`);
    if (table.some((row) => row && row[field] === value)) throw httpError(409, `${field} ${value} already exists in base data.`);
  }

  function assertPlacementAvailable(projectId, episode, actId, stageIndex) {
    const difficulty = episodeDifficulty(episode.m_Difficulty);
    const collides = (row) => row && row.m_EpisodeID === episode.m_EpisodeID && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === difficulty && Number(row.m_ActID) === actId && Number(row.m_StageIndex) === stageIndex;
    if (baseStagePlacements().some(collides)) throw httpError(409, `Episode ${episode.m_EpisodeID} act ${actId} already reserves stage index ${stageIndex}.`);
  }

  function assertOverridePlacementAvailable(projectId, source, current, ignoreProjectId = "") {
    const collides = (row) => row && Number(row.m_StageID) !== source.ids.stageId && Number(row.m_EpisodeID) === source.placement.episodeId && row.m_EPCategory === source.placement.category && row.m_Difficulty === source.placement.difficulty && Number(row.m_ActID) === current.actId && Number(row.m_StageIndex) === current.stageIndex;
    if (baseStagePlacements().some(collides)) throw httpError(409, `Episode ${source.placement.episodeId} act ${current.actId} already reserves stage index ${current.stageIndex}.`);
  }

  function assertFullTableAvailable(projectId, cutsceneStrId) {
    if (listGameplayTableFiles({ rootDir, env: baseEnv() }).some((entry) => entry.directory === CUTSCENE_DIRECTORY && entry.tableName === cutsceneStrId)) throw httpError(409, `Cutscene table ${cutsceneStrId} already exists in base data.`);
  }

  function assertCutsceneIdAvailable(projectId, cutsceneId) {
    const files = listGameplayTableFiles({ rootDir, env: baseEnv() }).filter((entry) => entry.directory === CUTSCENE_DIRECTORY && entry.extension === ".json");
    for (const entry of files) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(entry.filePath, "utf8")); }
      catch (err) { throw httpError(422, `Cutscene table ${entry.fileName} is invalid JSON: ${err.message}`); }
      if (extractTableRecords(parsed).some((row) => row && row.m_CutScenID === cutsceneId)) throw httpError(409, `Cutscene ID ${cutsceneId} already exists in base data.`);
    }
  }

  function writeSpeakerNames(projectId, cutsceneStrId, scenes, characterRows) {
    const ids = new Map();
    for (const scene of scenes) {
      const base = characterRows.find((row) => row && row.m_CharStrID === scene.speakerActorId);
      if (!base || stripColor(base.m_CharStr_ENG || "") === scene.speakerName) {
        ids.set(`${scene.speakerActorId}\0${scene.speakerName}`, scene.speakerActorId);
        continue;
      }
      const customId = `${cutsceneStrId}_SPEAKER_${slug(scene.speakerName)}`.slice(0, 180);
      const value = { ...base, m_CutsceneSetting_Key: `${customId}@CSETTINGKEY`, m_CharStrID: customId };
      for (const language of LANGUAGES) value[`m_CharStr_${language}`] = scene.speakerName;
      store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_CUTSCENE_CHAR_TEMPLET.json"), "m_CharStrID", customId, value));
      ids.set(`${scene.speakerActorId}\0${scene.speakerName}`, customId);
    }
    return ids;
  }

  function writeCutsceneForks(projectId, input, source, dungeon) {
    if (!dungeon || !source.cutscenes.length) throw httpError(422, "This stage has no dungeon-backed cutscene to fork.");
    const scenes = normalizeScenes(input.scenes, { allowEmptyActor: true });
    const characterRows = recordsFor(COMMON_DIRECTORY, "LUA_CUTSCENE_CHAR_TEMPLET.json");
    const occupiedIds = usedCutsceneIds(projectId);
    return source.cutscenes.map((cutscene, index) => {
      const selected = scenes.filter((scene) => scene.cutsceneSlot === cutscene.slot || source.cutscenes.length === 1 && !scene.cutsceneSlot);
      if (selected.length !== cutscene.frames.length) throw httpError(400, `The ${cutscene.slot} cutscene fork must keep its ${cutscene.frames.length} dialogue frames; add and delete are only available for new cutscenes.`);
      if (selected.some((scene) => scene.effects.length > 2)) throw httpError(400, "A base cutscene fork can place at most two FX values on each preserved event.");
      let cutsceneId = 910000000 + positiveInteger(input.stageId, "Stage ID") * 2 + index;
      while (occupiedIds.has(cutsceneId)) cutsceneId += 1;
      occupiedIds.add(cutsceneId);
      if (cutsceneId > 2147483647) throw httpError(400, "The generated cutscene ID exceeds the client integer range.");
      const cutsceneStrId = gameId(`MODSIDE_${slug(projectId)}_${input.stageId}_${cutscene.slot}`, "Forked cutscene string ID");
      assertAvailable("LUA_CUTSCENE_FILE_LIST", "m_CutScenFile", cutsceneStrId, projectId);
      assertFullTableAvailable(projectId, cutsceneStrId);
      assertCutsceneIdAvailable(projectId, cutsceneId);
      const speakerIds = writeSpeakerNames(projectId, cutsceneStrId, selected, characterRows);
      const records = forkCutsceneRecords(cutscene, selected, cutsceneId, cutsceneStrId, speakerIds);
      const field = cutscene.slot === "after" ? "m_CutScenStrIDAfter" : "m_CutScenStrIDBefore";
      dungeon[field] = cutsceneStrId;
      store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_CUTSCENE_FILE_LIST.json"), "m_CutScenFile", cutsceneStrId, { m_CutScenFile: cutsceneStrId, m_CutScenType: String(cutscene.registration && cutscene.registration.m_CutScenType || "NCT_MAIN") }));
      store.writeFullTable(projectId, {
        table: { directory: CUTSCENE_DIRECTORY, fileName: `${cutsceneStrId}.json`, tableName: cutsceneStrId, format: "json" },
        compiled: { source: "revivalside-episode-maker", rootName: "m_dicNKCCutScenTempletByID", records },
      });
      return { slot: cutscene.slot, sourceId: cutscene.id, id: cutsceneId, strId: cutsceneStrId, recordCount: records.length, records, scenes: selected };
    });
  }

  function customEpisodeTemplate(rows, difficulty) {
    const expectedStrId = `ESI_MAINSTREAM_EP_${CUSTOM_MAINSTREAM_EPISODE.episodeNumber}`;
    const collision = rows.find((row) => row && (Number(row.m_EpisodeID) === CUSTOM_MAINSTREAM_EPISODE.episodeId || String(row.m_EpisodeStrID) === expectedStrId));
    if (collision) throw httpError(409, `Episode ${CUSTOM_MAINSTREAM_EPISODE.episodeNumber} collides with existing episode ID ${collision.m_EpisodeID}.`);
    const source = rows.find((row) => row && Number(row.m_EpisodeID) === CUSTOM_MAINSTREAM_EPISODE.sourceEpisodeId && row.m_EPCategory === "EC_MAINSTREAM" && row.m_Difficulty === difficulty)
      || rows.filter((row) => row && row.m_EPCategory === "EC_MAINSTREAM" && row.m_Difficulty === difficulty).at(-1);
    if (!source) throw httpError(422, `A ${difficulty.toLowerCase()} Mainstream episode template was not found.`);
    return {
      ...source,
      __custom: true,
      m_EpisodeID: CUSTOM_MAINSTREAM_EPISODE.episodeId,
      m_EpisodeStrID: expectedStrId,
      m_EPCategory: "EC_MAINSTREAM",
      m_Difficulty: difficulty,
      m_ActCount: 1,
      m_OpenTag: `TAG_COMMON_EPISODE_MAIN_EP${CUSTOM_MAINSTREAM_EPISODE.episodeNumber}_${difficulty}`,
      m_CollectionOpenTag: `TAG_COMMON_COLLECTION_MAIN_EP${CUSTOM_MAINSTREAM_EPISODE.episodeNumber}_NORMAL`,
    };
  }

  function defaultEpisodeDefinition(episode, episodeRows) {
    const custom = Boolean(episode.__custom);
    const sourceId = custom ? CUSTOM_MAINSTREAM_EPISODE.sourceEpisodeId : Number(episode.m_EpisodeID);
    const normal = episodeRows.find((row) => row && Number(row.m_EpisodeID) === sourceId && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === "NORMAL") || episode;
    const hard = episodeRows.find((row) => row && Number(row.m_EpisodeID) === sourceId && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === "HARD") || normal;
    const summaryRows = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_SUMMARY_TEMPLET.json");
    const summary = summaryRows.find((row) => row && Number(row.EpisodeID) === sourceId) || {};
    const stageSource = baseStagePlacements().find((row) => row && Number(row.m_EpisodeID) === sourceId && row.m_Difficulty === "NORMAL") || {};
    const number = custom ? CUSTOM_MAINSTREAM_EPISODE.episodeNumber : (parseEpisodeNumber(normal.m_EpisodeStrID) || Number(normal.m_EpisodeID));
    return {
      custom,
      episodeId: Number(episode.m_EpisodeID),
      episodeNumber: number,
      episodeStrId: String(episode.m_EpisodeStrID),
      groupId: Number(normal.GroupID || 11001),
      title: custom ? `Episode ${number}` : localizedString(normal.m_EpisodeTitle) || episodeLabel(normal),
      name: custom ? `Episode ${number}` : localizedString(normal.m_EpisodeName) || episodeLabel(normal),
      description: custom ? "" : localizedString(normal.m_EpisodeDesc_1),
      extraDescription: custom ? "" : localizedString(normal.m_EpisodeDesc_2),
      actCount: custom ? 1 : Number(normal.m_ActCount || 1),
      stageViewerPrefab: String(normal.m_Stage_Viewer_Prefab || "UI_MAINSTREAM_EP_15"),
      thumbnail: String(normal.m_EPThumbnail || "BG_MAINSTREAM_EP_15_01"),
      actBackground: String(stageSource.m_ACT_BG_Image || ""),
      backgroundMusic: String(normal.m_BG_Music || ""),
      scrollType: SCROLL_TYPES.has(normal.m_Scroll_Type) ? normal.m_Scroll_Type : "HORIZONTAL",
      hideActTabs: Boolean(normal.m_bHideActTab),
      noCollectionCutscene: custom ? false : Boolean(normal.m_bNoCollectionCutscene),
      completionRewards: defaultCompletionRewards(normal, custom),
      resourceChange: defaultResourceChange(normal, custom),
      openTag: custom ? `TAG_COMMON_EPISODE_MAIN_EP${number}_NORMAL` : String(normal.m_OpenTag || ""),
      collectionOpenTag: custom ? `TAG_COMMON_COLLECTION_MAIN_EP${number}_NORMAL` : String(normal.m_CollectionOpenTag || ""),
      connectedEpisodeIds: Array.isArray(normal.Connect_EpisodeID) ? normal.Connect_EpisodeID.map(Number).filter(Number.isSafeInteger) : [],
      layoutPanX: 960,
      layoutPanY: 480,
      summary: {
        lobbyResourceId: String(summary.LobbyResourceID || "LOBBY_THUMB_EPISODE_MAINSTREAM_EP_15"),
        bigResourceId: String(summary.BigResourceID || "SHORTCUT_BIG_MAINSTREAM_EP_15"),
        subResourceId: String(summary.SubResourceID || "THUMB_SUMMARY_MAINSTREAM_EP_15"),
        dateText: custom ? `Episode ${number}` : localizedString(summary.DateStrID) || episodeLabel(normal),
      },
      hardMode: {
        enabled: !custom && Boolean(episodeRows.find((row) => row && Number(row.m_EpisodeID) === sourceId && row.m_Difficulty === "HARD")),
        actCount: Number(hard.m_ActCount || 1),
        openTag: custom ? `TAG_COMMON_EPISODE_MAIN_EP${number}_HARD` : String(hard.m_OpenTag || ""),
        stageViewerPrefab: String(hard.m_Stage_Viewer_Prefab || normal.m_Stage_Viewer_Prefab || "UI_MAINSTREAM_EP_15"),
        thumbnail: String(hard.m_EPThumbnail || normal.m_EPThumbnail || "BG_MAINSTREAM_EP_15_01"),
        backgroundMusic: String(hard.m_BG_Music || normal.m_BG_Music || ""),
        scrollType: SCROLL_TYPES.has(hard.m_Scroll_Type) ? hard.m_Scroll_Type : "HORIZONTAL",
        hideActTabs: Boolean(hard.m_bHideActTab),
        noCollectionCutscene: custom ? true : Boolean(hard.m_bNoCollectionCutscene),
        completionRewards: defaultCompletionRewards(hard, custom),
        resourceChange: defaultResourceChange(hard, custom),
      },
    };
  }

  function normalizeEpisodeDefinition(value, episode) {
    const defaults = defaultEpisodeDefinition(episode, recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json"));
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const summary = input.summary && typeof input.summary === "object" && !Array.isArray(input.summary) ? input.summary : {};
    const hard = input.hardMode && typeof input.hardMode === "object" && !Array.isArray(input.hardMode) ? input.hardMode : {};
    const connectedEpisodeIds = uniquePositiveIntegers(input.connectedEpisodeIds == null ? defaults.connectedEpisodeIds : input.connectedEpisodeIds, "Connected episode IDs", 50);
    if (connectedEpisodeIds.includes(episode.m_EpisodeID)) throw httpError(400, "An episode cannot connect to itself.");
    const knownEpisodeIds = new Set(recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json").map((row) => Number(row && row.m_EpisodeID)).filter(Number.isSafeInteger));
    const missingConnections = connectedEpisodeIds.filter((id) => !knownEpisodeIds.has(id));
    if (missingConnections.length) throw httpError(400, `Connected episode IDs were not found: ${missingConnections.join(", ")}.`);
    const groupId = positiveInteger(input.groupId == null ? defaults.groupId : input.groupId, "Episode group ID");
    const group = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_GROUP_TEMPLET.json").find((row) => row && Number(row.GroupID) === groupId);
    if (!group || group.m_EPCategory !== episode.m_EPCategory) throw httpError(400, `Episode group ${groupId} does not belong to ${episode.m_EPCategory}.`);
    const hardEnabled = hard.enabled === true;
    if (!episode.__custom && hardEnabled !== defaults.hardMode.enabled) throw httpError(400, "Existing episode Normal and Hard mode availability cannot be changed.");
    for (const [label, actual, expected] of [
      ["Normal open tag", input.openTag, defaults.openTag],
      ["Collection open tag", input.collectionOpenTag, defaults.collectionOpenTag],
      ["Hard open tag", hard.openTag, defaults.hardMode.openTag],
    ]) if (!episode.__custom && actual != null && String(actual) !== String(expected)) throw httpError(400, `${label} is a stable base-game identity and cannot be changed.`);
    const definition = {
      ...defaults,
      groupId,
      title: limitedText(input.title == null ? defaults.title : input.title, "Episode title", 180, true),
      name: limitedText(input.name == null ? defaults.name : input.name, "Episode name", 180, true),
      description: limitedText(input.description == null ? defaults.description : input.description, "Episode description", 1000, false),
      extraDescription: limitedText(input.extraDescription == null ? defaults.extraDescription : input.extraDescription, "Episode extra description", 1000, false),
      actCount: boundedInteger(input.actCount, defaults.actCount, 1, 50, "Normal act count"),
      stageViewerPrefab: gameId(input.stageViewerPrefab == null ? defaults.stageViewerPrefab : input.stageViewerPrefab, "Stage viewer prefab"),
      thumbnail: gameId(input.thumbnail == null ? defaults.thumbnail : input.thumbnail, "Episode thumbnail"),
      actBackground: optionalGameId(input.actBackground == null ? defaults.actBackground : input.actBackground, "Default act background"),
      backgroundMusic: optionalGameId(input.backgroundMusic == null ? defaults.backgroundMusic : input.backgroundMusic, "Episode music"),
      scrollType: scrollType(input.scrollType, defaults.scrollType, "Episode scroll type"),
      hideActTabs: input.hideActTabs === true,
      noCollectionCutscene: input.noCollectionCutscene === true,
      completionRewards: normalizeCompletionRewards(input.completionRewards, defaults.completionRewards, "Normal completion rewards"),
      resourceChange: normalizeResourceChange(input.resourceChange, defaults.resourceChange, "Normal resource change"),
      openTag: gameId(input.openTag == null ? defaults.openTag : input.openTag, "Normal open tag"),
      collectionOpenTag: episode.__custom ? gameId(input.collectionOpenTag == null ? defaults.collectionOpenTag : input.collectionOpenTag, "Collection open tag") : optionalGameId(input.collectionOpenTag == null ? defaults.collectionOpenTag : input.collectionOpenTag, "Collection open tag"),
      connectedEpisodeIds,
      layoutPanX: boundedInteger(input.layoutPanX, defaults.layoutPanX, 0, 5000, "Horizontal layout pan"),
      layoutPanY: boundedInteger(input.layoutPanY, defaults.layoutPanY, 0, 5000, "Vertical layout pan"),
      summary: {
        lobbyResourceId: gameId(summary.lobbyResourceId == null ? defaults.summary.lobbyResourceId : summary.lobbyResourceId, "Summary lobby art"),
        bigResourceId: gameId(summary.bigResourceId == null ? defaults.summary.bigResourceId : summary.bigResourceId, "Summary large art"),
        subResourceId: gameId(summary.subResourceId == null ? defaults.summary.subResourceId : summary.subResourceId, "Summary thumbnail"),
        dateText: limitedText(summary.dateText == null ? defaults.summary.dateText : summary.dateText, "Summary date text", 180, true),
      },
      hardMode: {
        enabled: hardEnabled,
        actCount: boundedInteger(hard.actCount, defaults.hardMode.actCount, 1, 50, "Hard act count"),
        openTag: episode.__custom || hardEnabled ? gameId(hard.openTag == null ? defaults.hardMode.openTag : hard.openTag, "Hard open tag") : optionalGameId(hard.openTag == null ? defaults.hardMode.openTag : hard.openTag, "Hard open tag"),
        stageViewerPrefab: gameId(hard.stageViewerPrefab == null ? defaults.hardMode.stageViewerPrefab : hard.stageViewerPrefab, "Hard stage viewer prefab"),
        thumbnail: gameId(hard.thumbnail == null ? defaults.hardMode.thumbnail : hard.thumbnail, "Hard episode thumbnail"),
        backgroundMusic: optionalGameId(hard.backgroundMusic == null ? defaults.hardMode.backgroundMusic : hard.backgroundMusic, "Hard episode music"),
        scrollType: scrollType(hard.scrollType, defaults.hardMode.scrollType, "Hard scroll type"),
        hideActTabs: hard.hideActTabs === true,
        noCollectionCutscene: hard.noCollectionCutscene !== false,
        completionRewards: normalizeCompletionRewards(hard.completionRewards, defaults.hardMode.completionRewards, "Hard completion rewards"),
        resourceChange: normalizeResourceChange(hard.resourceChange, defaults.hardMode.resourceChange, "Hard resource change"),
      },
    };
    if (episode.__custom && definition.hardMode.enabled && definition.hardMode.openTag === definition.openTag) throw httpError(400, "Normal and Hard mode must use different open tags.");
    return definition;
  }

  function writeEpisodeDefinition(projectId, episode, definition, ignoreProjectId = "") {
    if (!episode.__custom) return writeEpisodeOverride(projectId, episode, definition, ignoreProjectId);
    assertEpisodeDefinitionAvailable(projectId, episode, definition, ignoreProjectId);
    const titleKey = `MODSIDE_EPISODE_TITLE_${episode.m_EpisodeID}`;
    const nameKey = `MODSIDE_EPISODE_NAME_${episode.m_EpisodeID}`;
    const descriptionKey = `MODSIDE_EPISODE_DESCRIPTION_${episode.m_EpisodeID}`;
    const extraDescriptionKey = `MODSIDE_EPISODE_DESCRIPTION_EXTRA_${episode.m_EpisodeID}`;
    const dateKey = `MODSIDE_EPISODE_DATE_${episode.m_EpisodeID}`;
    const row = (difficulty, values) => ({
      m_EpisodeID: episode.m_EpisodeID,
      m_EpisodeStrID: episode.m_EpisodeStrID,
      GroupID: definition.groupId,
      m_EPCategory: "EC_MAINSTREAM",
      m_OpenTag: values.openTag,
      ...(difficulty === "NORMAL" ? { m_CollectionOpenTag: definition.collectionOpenTag } : {}),
      ...(values.noCollectionCutscene ? { m_bNoCollectionCutscene: true } : {}),
      m_Difficulty: difficulty,
      m_ActCount: values.actCount,
      m_EpisodeTitle: titleKey,
      m_EpisodeName: nameKey,
      m_EpisodeDesc_1: descriptionKey,
      ...(definition.extraDescription ? { m_EpisodeDesc_2: extraDescriptionKey } : {}),
      m_Stage_Viewer_Prefab: values.stageViewerPrefab,
      m_EPThumbnail: values.thumbnail,
      m_Scroll_Type: values.scrollType,
      ...(values.backgroundMusic ? { m_BG_Music: values.backgroundMusic } : {}),
      ...(values.hideActTabs ? { m_bHideActTab: true } : {}),
      ...(definition.connectedEpisodeIds.length ? { Connect_EpisodeID: definition.connectedEpisodeIds } : {}),
      ...completionRewardFields(values.completionRewards),
      ...(values.resourceChange.missionCondition ? {
        Change_Resource_MissonCond: values.resourceChange.missionCondition,
        Change_Resource_MissonValue: values.resourceChange.missionValue,
        Change_Resource_BG_Music: values.resourceChange.backgroundMusic,
      } : {}),
    });
    const normal = row("NORMAL", definition);
    store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json"), "m_OpenTag", normal.m_OpenTag, normal));
    if (definition.hardMode.enabled) {
      const hard = row("HARD", definition.hardMode);
      store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json"), "m_OpenTag", hard.m_OpenTag, hard));
    }
    const summary = {
      INDEX: CUSTOM_MAINSTREAM_EPISODE.episodeNumber + 1,
      LobbyResourceID: definition.summary.lobbyResourceId,
      BigResourceID: definition.summary.bigResourceId,
      SubResourceID: definition.summary.subResourceId,
      m_ShortcutType: "SHORTCUT_OPERATION",
      m_Shortcut: `EC_MAINSTREAM@${episode.m_EpisodeID}`,
      m_SortIndex: CUSTOM_MAINSTREAM_EPISODE.episodeNumber + 1,
      m_EPCategory: "EC_MAINSTREAM",
      EpisodeID: episode.m_EpisodeID,
      DateStrID: dateKey,
    };
    store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_SUMMARY_TEMPLET.json"), "INDEX", summary.INDEX, summary));
    for (const [key, value] of [[titleKey, definition.title], [nameKey, definition.name], [descriptionKey, definition.description], [dateKey, definition.summary.dateText]]) store.writeString(projectId, key, value);
    if (definition.extraDescription) store.writeString(projectId, extraDescriptionKey, definition.extraDescription);
    return { normal, summary, generatedStrings: [titleKey, nameKey, descriptionKey, dateKey, ...(definition.extraDescription ? [extraDescriptionKey] : [])] };
  }

  function writeEpisodeOverride(projectId, episode, definition, ignoreProjectId = "") {
    const rows = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json");
    const normalBase = rows.find((row) => row && Number(row.m_EpisodeID) === Number(episode.m_EpisodeID) && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === "NORMAL");
    const hardBase = rows.find((row) => row && Number(row.m_EpisodeID) === Number(episode.m_EpisodeID) && row.m_EPCategory === episode.m_EPCategory && row.m_Difficulty === "HARD");
    if (!normalBase) throw httpError(422, "The base episode Normal record was not found.");
    const titleKey = `MODSIDE_EPISODE_TITLE_${episode.m_EpisodeID}`;
    const nameKey = `MODSIDE_EPISODE_NAME_${episode.m_EpisodeID}`;
    const descriptionKey = `MODSIDE_EPISODE_DESCRIPTION_${episode.m_EpisodeID}`;
    const extraDescriptionKey = `MODSIDE_EPISODE_DESCRIPTION_EXTRA_${episode.m_EpisodeID}`;
    const dateKey = `MODSIDE_EPISODE_DATE_${episode.m_EpisodeID}`;
    const apply = (base, values) => {
      const row = cloneJson(base);
      for (const key of Object.keys(row)) if (/^m_(CompleteRate|RewardType|RewardID|RewardValue)_\d+$/.test(key)) delete row[key];
      Object.assign(row, {
        GroupID: definition.groupId,
        m_ActCount: values.actCount,
        m_EpisodeTitle: titleKey,
        m_EpisodeName: nameKey,
        m_EpisodeDesc_1: descriptionKey,
        m_Stage_Viewer_Prefab: values.stageViewerPrefab,
        m_EPThumbnail: values.thumbnail,
        m_Scroll_Type: values.scrollType,
        ...completionRewardFields(values.completionRewards),
      });
      if (definition.extraDescription) row.m_EpisodeDesc_2 = extraDescriptionKey; else delete row.m_EpisodeDesc_2;
      if (values.backgroundMusic) row.m_BG_Music = values.backgroundMusic; else delete row.m_BG_Music;
      if (values.hideActTabs) row.m_bHideActTab = true; else delete row.m_bHideActTab;
      if (values.noCollectionCutscene) row.m_bNoCollectionCutscene = true; else delete row.m_bNoCollectionCutscene;
      if (definition.connectedEpisodeIds.length) row.Connect_EpisodeID = definition.connectedEpisodeIds; else delete row.Connect_EpisodeID;
      for (const key of ["Change_Resource_MissonCond", "Change_Resource_MissonValue", "Change_Resource_BG_Music"]) delete row[key];
      if (values.resourceChange.missionCondition) Object.assign(row, {
        Change_Resource_MissonCond: values.resourceChange.missionCondition,
        Change_Resource_MissonValue: values.resourceChange.missionValue,
        Change_Resource_BG_Music: values.resourceChange.backgroundMusic,
      });
      return row;
    };
    const table = tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json");
    const normal = apply(normalBase, definition);
    const normalIndex = rows.indexOf(normalBase);
    store.writePatch(projectId, patch(table, "__index", normalIndex, normal));
    let hard = null;
    if (hardBase) {
      hard = apply(hardBase, definition.hardMode);
      const hardIndex = rows.indexOf(hardBase);
      store.writePatch(projectId, patch(table, "__index", hardIndex, hard));
    }
    const summaryBase = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_SUMMARY_TEMPLET.json").find((row) => row && Number(row.EpisodeID) === Number(episode.m_EpisodeID));
    let summary = null;
    if (summaryBase) {
      summary = { ...summaryBase, LobbyResourceID: definition.summary.lobbyResourceId, BigResourceID: definition.summary.bigResourceId, SubResourceID: definition.summary.subResourceId, DateStrID: dateKey };
      store.writePatch(projectId, patch(tableEntry(COMMON_DIRECTORY, "LUA_EPISODE_SUMMARY_TEMPLET.json"), "INDEX", summaryBase.INDEX, summary));
    }
    const generatedStrings = [titleKey, nameKey, descriptionKey, ...(definition.extraDescription ? [extraDescriptionKey] : []), ...(summary ? [dateKey] : [])];
    for (const [key, value] of [[titleKey, definition.title], [nameKey, definition.name], [descriptionKey, definition.description], [extraDescriptionKey, definition.extraDescription], [dateKey, definition.summary.dateText]]) if (generatedStrings.includes(key)) store.writeString(projectId, key, value);
    return { normal, hard, summary, generatedStrings };
  }

  function assertEpisodeDefinitionAvailable(projectId, episode, definition, ignoreProjectId = "") {
    const rows = recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_TEMPLET_V2.json");
    if (rows.some((row) => row && (Number(row.m_EpisodeID) === episode.m_EpisodeID || String(row.m_EpisodeStrID) === episode.m_EpisodeStrID || String(row.m_OpenTag) === definition.openTag || definition.hardMode.enabled && String(row.m_OpenTag) === definition.hardMode.openTag))) throw httpError(409, "Episode 16 IDs or open tags already exist in base data.");
    const summaryIndex = CUSTOM_MAINSTREAM_EPISODE.episodeNumber + 1;
    if (recordsFor(COMMON_DIRECTORY, "LUA_EPISODE_SUMMARY_TEMPLET.json").some((row) => row && (Number(row.EpisodeID) === episode.m_EpisodeID || Number(row.INDEX) === summaryIndex))) throw httpError(409, "Episode 16 summary slot already exists in base data.");
  }

  function clearGeneratedEpisodeContent(projectId) {
    const project = store.readProject(projectId);
    const authoringFile = path.join(project.root, "assets", "source", "episode-maker", "project.json");
    if (fs.existsSync(authoringFile)) {
      try {
        const previous = JSON.parse(fs.readFileSync(authoringFile, "utf8"));
        const stages = Array.isArray(previous.stages) ? previous.stages : [previous];
        for (const key of Array.isArray(previous.generatedStrings) ? previous.generatedStrings : []) store.removeString(projectId, key);
        for (const stage of stages) {
          const keys = Array.isArray(stage && stage.generatedStrings) ? stage.generatedStrings : stage && stage.kind === "cutscene-stage" ? [`MODSIDE_STAGE_TITLE_${stage.ids.stageId}`, `MODSIDE_STAGE_DESCRIPTION_${stage.ids.stageId}`] : [];
          for (const key of keys) store.removeString(projectId, key);
        }
      } catch (_) { /* invalid authoring is reported when the project is opened */ }
    }
    for (const item of project.patches.filter((entry) => entry.source === "revivalside-episode-maker")) store.removePatch(projectId, item.patchId);
    for (const item of project.tables.filter((entry) => entry.compiled && entry.compiled.source === "revivalside-episode-maker")) {
      if (!/^tables\/[A-Za-z0-9._/-]+\.json$/.test(item.tableId)) throw httpError(422, `Unsafe generated table path: ${item.tableId}`);
      const file = path.resolve(project.root, item.tableId);
      if (!file.startsWith(`${project.root}${path.sep}`)) throw httpError(422, `Generated table leaves the mod project: ${item.tableId}`);
      fs.unlinkSync(file);
    }
  }

  function create(input = {}) {
    if (!Array.isArray(input.stages)) return input.operation === "override" || input.operation === "clone" ? create({ ...input, stages: [input] }) : createStage(input);
    if (input.stages.length > 50) throw httpError(400, "An episode project can contain at most 50 stages.");
    const projectId = String(input.projectId || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(projectId)) throw httpError(400, "Mod ID must be 2-64 lowercase letters, numbers, dots, dashes, or underscores.");
    const episode = requireEpisode(input.episodeId, input.category, "NORMAL");
    const definition = input.episode ? normalizeEpisodeDefinition(input.episode, episode) : null;
    if (episode.__custom && !definition) throw httpError(400, "Episode 16 requires episode-level client UI settings.");
    const stages = input.stages.map((stage) => ({ ...input, ...stage, projectId, stages: undefined }));
    if (stages.some((stage) => Number(stage.episodeId) !== Number(episode.m_EpisodeID) || stage.category !== episode.m_EPCategory)) throw httpError(400, "Every stage in a Story:Side project must belong to the selected episode.");
    assertDistinctStages(stages);
    const target = path.join(store.modsRoot, projectId);
    const existed = fs.existsSync(path.join(target, "mod.json"));
    const backupRoot = existed ? fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-episode-backup-")) : "";
    if (existed) fs.cpSync(target, path.join(backupRoot, projectId), { recursive: true });
    try {
      if (!existed) store.createProject({ id: projectId, name: input.projectName || definition && definition.title || "Episode Mod", version: input.version || "0.1.0", author: input.author, description: input.description || `Episode project: ${definition ? definition.title : projectId}` });
      else {
        const manifest = store.readProject(projectId).manifest;
        store.updateManifest(projectId, { name: input.projectName || manifest.name, version: input.version || manifest.version, author: input.author == null ? manifest.author : input.author, description: input.description == null ? manifest.description : input.description });
      }
      clearGeneratedEpisodeContent(projectId);
      const episodeResult = definition ? writeEpisodeDefinition(projectId, episode, definition, input.ignoreProjectId) : null;
      const results = stages.map((stage) => stage.operation === "override" ? createOverride(stage) : stage.operation === "clone" ? createClone(stage, definition) : createStage(stage, definition));
      const authoring = {
        schemaVersion: definition ? 3 : 2,
        kind: "cutscene-episode",
        title: String(input.projectName || definition && definition.title || results[0] && results[0].authoring.title || "Story Mod"),
        category: episode.m_EPCategory,
        episodeId: episode.m_EpisodeID,
        ...(definition ? { episode: definition } : {}),
        ...(episodeResult ? { generatedStrings: episodeResult.generatedStrings } : {}),
        stages: results.map((result) => result.authoring),
      };
      store.writeAssetSource(projectId, "episode-maker/project.json", Buffer.from(`${JSON.stringify(authoring, null, 2)}\n`, "utf8"));
      return { project: store.readProject(projectId), authoring, cutscenes: results.map((result) => result.cutscene), exportFileName: `${projectId}.zip` };
    } catch (error) {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      if (existed) fs.cpSync(path.join(backupRoot, projectId), target, { recursive: true });
      throw error;
    } finally {
      if (backupRoot) fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }

  function projects() {
    return store.listProjects().map((summary) => {
      try {
        const project = store.readProject(summary.id);
        const file = path.join(project.root, "assets", "source", "episode-maker", "project.json");
        if (!fs.existsSync(file)) return null;
        const authoring = JSON.parse(fs.readFileSync(file, "utf8"));
        return { id: summary.id, name: summary.name, version: summary.version, stageCount: Array.isArray(authoring.stages) ? authoring.stages.length : 1 };
      } catch (_) { return null; }
    }).filter(Boolean);
  }

  function readProject(projectId) {
    const project = store.readProject(projectId);
    const file = path.join(project.root, "assets", "source", "episode-maker", "project.json");
    if (!fs.existsSync(file)) throw httpError(404, `Mod ${projectId} does not contain an Episode Maker project.`);
    let authoring;
    try { authoring = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { throw httpError(422, `Episode Maker project is invalid JSON: ${error.message}`); }
    return { manifest: project.manifest, authoring };
  }

  function copyProject(sourceProjectId, input = {}) {
    const source = readProject(sourceProjectId);
    const targetId = String(input.id || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(targetId)) throw httpError(400, "Mod ID must be 2-64 lowercase letters, numbers, dots, dashes, or underscores.");
    if (fs.existsSync(path.join(store.modsRoot, targetId, "mod.json"))) throw httpError(409, `Mod project ${targetId} already exists.`);
    const authoring = source.authoring;
    const sourceStages = Array.isArray(authoring.stages) ? authoring.stages : [authoring];
    const placementRows = baseStagePlacements().concat(modPatchRows("LUA_EPISODE_TEMPLET"));
    const nextPlacements = new Map();
    const dungeonIds = new Map();
    const remapped = [];
    let suggestionOffset = 0;
    const stages = sourceStages.map((stage) => {
      const value = stageInputFromAuthoring(stage);
      if (value.operation === "override") return value;
      const suggested = suggest(value.episodeId, value.category, suggestionOffset++, value.difficulty);
      const group = `${value.category}:${value.episodeId}:${value.difficulty}:${value.actId}`;
      if (!nextPlacements.has(group)) {
        const rows = placementRows.filter((row) => row && row.m_EPCategory === value.category && Number(row.m_EpisodeID) === Number(value.episodeId) && row.m_Difficulty === value.difficulty && Number(row.m_ActID) === Number(value.actId));
        nextPlacements.set(group, {
          index: Math.max(0, ...rows.map((row) => Number(row.m_StageIndex) || 0)),
          ui: Math.max(0, ...rows.map((row) => Number(row.m_StageUINum || row.m_StageIndex) || 0)),
        });
      }
      const placement = nextPlacements.get(group);
      placement.index += 1;
      placement.ui += 1;
      for (const [kind, before, after] of [
        ["stage ID", value.stageId, suggested.stageId], ["dungeon ID", value.dungeonId, suggested.dungeonId],
        ["stage string ID", value.stageStrId, suggested.stageStrId], ["dungeon string ID", value.dungeonStrId, suggested.dungeonStrId],
        ...(value.operation === "clone" ? [] : [["cutscene ID", value.cutsceneId, suggested.cutsceneId], ["cutscene string ID", value.cutsceneStrId, suggested.cutsceneStrId]]),
      ]) if (before !== after) remapped.push({ kind, from: before, to: after });
      dungeonIds.set(Number(value.dungeonId), suggested.dungeonId);
      return {
        ...value,
        stageId: suggested.stageId,
        dungeonId: suggested.dungeonId,
        cutsceneId: value.operation === "clone" ? 0 : suggested.cutsceneId,
        stageStrId: suggested.stageStrId,
        dungeonStrId: suggested.dungeonStrId,
        cutsceneStrId: value.operation === "clone" ? "" : suggested.cutsceneStrId,
        stageIndex: placement.index,
        stageUiNumber: placement.ui,
      };
    }).map((stage) => ({ ...stage, unlockDungeonId: dungeonIds.get(Number(stage.unlockDungeonId)) || stage.unlockDungeonId }));
    const definition = authoring.episode ? cloneJson(authoring.episode) : undefined;
    for (const change of [definition && definition.resourceChange, definition && definition.hardMode && definition.hardMode.resourceChange].filter(Boolean)) {
      change.missionValue = dungeonIds.get(Number(change.missionValue)) || change.missionValue;
    }
    const result = create({
      projectId: targetId,
      projectName: input.name || `${source.manifest.name} Copy`,
      version: input.version || source.manifest.version,
      author: input.author == null ? source.manifest.author : input.author,
      description: input.description == null ? source.manifest.description : input.description,
      category: authoring.category || stages[0] && stages[0].category,
      episodeId: authoring.episodeId || stages[0] && stages[0].episodeId,
      episode: definition,
      stages,
      ignoreProjectId: sourceProjectId,
    });
    return { ...result, remapped };
  }

  return { asset, catalog, suggest, layout, inspectStage, create, projects, readProject, copyProject };
}

function stageInputFromAuthoring(stage = {}) {
  const placement = stage.placement || {};
  const ids = stage.ids || {};
  const base = stage.base || {};
  const ui = stage.clientUi || {};
  return {
    operation: stage.operation,
    baseObjectId: base.objectId,
    sourceObjectId: base.objectId,
    sourceStageId: base.stageId,
    sourceEpisodeId: base.episodeId,
    sourceCategory: base.category,
    sourceDifficulty: base.difficulty,
    episodeId: placement.episodeId,
    category: placement.category,
    difficulty: placement.difficulty || "NORMAL",
    actId: placement.actId,
    stageIndex: placement.stageIndex,
    stageUiNumber: placement.stageUiNumber,
    stageId: ids.stageId,
    dungeonId: ids.dungeonId,
    cutsceneId: ids.cutsceneId || 0,
    stageStrId: ids.stageStrId,
    dungeonStrId: ids.dungeonStrId,
    cutsceneStrId: ids.cutsceneStrId || "",
    unlockDungeonId: stage.unlockDungeonId || 0,
    unlockRequirementType: stage.unlockRequirementType,
    title: stage.title,
    stageDescription: stage.stageDescription || ui.description || stage.title,
    stageCharacter: stage.stageCharacter || ui.avatar,
    background: stage.background,
    music: stage.music,
    actBackground: ui.actBackground,
    episodeThumbnail: ui.episodeThumbnail,
    dungeonIcon: ui.dungeonIcon,
    cutsceneReadOnly: stage.cutsceneReadOnly === true,
    forkCutscenes: stage.forkCutscenes === true,
    scenes: stage.scenes || [],
  };
}

function stageOverrideSource(detail) {
  const firstCutscene = detail.cutscenes[0];
  const firstEvent = firstCutscene && firstCutscene.events.find((event) => Number(event && event.m_CutScenID) > 0);
  const firstFrame = firstCutscene && firstCutscene.frames[0];
  return {
    operation: "override",
    baseObjectId: detail.objectId,
    title: detail.clientUi.title || detail.name,
    stageDescription: detail.clientUi.description || detail.clientUi.descriptionId || "",
    difficulty: detail.placement.difficulty,
    actId: detail.placement.actId,
    stageIndex: detail.placement.stageIndex,
    stageUiNumber: detail.placement.stageNumber,
    stageCharacter: detail.clientUi.avatar,
    unlockDungeonId: detail.unlock.requirementValue,
    unlockRequirementType: detail.unlock.requirementType,
    stageId: detail.ids.stageId,
    dungeonId: detail.ids.dungeonId,
    cutsceneId: Number(firstEvent && firstEvent.m_CutScenID || 0),
    stageStrId: detail.ids.stageStrId,
    dungeonStrId: detail.ids.dungeonStrId,
    cutsceneStrId: String(firstCutscene && firstCutscene.id || ""),
    background: String(firstFrame && firstFrame.background || "CAFE"),
    music: String(detail.raw.dungeon && detail.raw.dungeon.m_MusicAssetName || firstFrame && firstFrame.music || ""),
    actBackground: detail.clientUi.actBackground,
    episodeThumbnail: detail.clientUi.episodeThumbnail,
    dungeonIcon: detail.clientUi.dungeonIcon,
    cutsceneReadOnly: true,
    scenes: [],
  };
}

function changedRecordFields(before, after) {
  return Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})])).filter((key) => JSON.stringify(before && before[key]) !== JSON.stringify(after && after[key])).sort();
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function stageKind(placement, dungeon) {
  if (String(dungeon && dungeon.m_DungeonType) === "NDT_CUTSCENE") return "CUTSCENE";
  if (String(placement && placement.m_StageType) === "ST_PHASE") return "PHASE";
  return "COMBAT";
}

function baseCutsceneFrames(events, characters) {
  let background = "";
  let music = "";
  return events.flatMap((event) => {
    if (event.m_BGFileName) background = String(event.m_BGFileName);
    if (event.m_StartBGMFileName) music = String(event.m_StartBGMFileName);
    if (!event.m_CutScenKey_Talk && !event.m_Talk_ENG) return [];
    const actorId = String(event.m_CharStrID || "");
    return [{
      processKey: Number(event.m_CutScenProcessKey || 0),
      speakerName: characters.get(actorId.toUpperCase()) || actorId || "Speaker",
      speakerActorId: actorId,
      dialogue: String(event.m_Talk_ENG || event.m_Talk_KOREA || ""),
      voiceLine: String(event.m_VoiceFileName || ""),
      background,
      music,
      transition: event.m_bFadeIn || Number(event.m_fFadeTime || 0) > 0 ? "FADE" : "CUT",
      fadeTime: Number(event.m_fFadeTime || 0),
      dimActors: false,
      effects: [event.m_StartFXSoundName, event.m_StartFXSoundControl].filter(Boolean).map(String),
      actors: actorId ? [{ actorId, position: POSITIONS.has(String(event.m_Pos || "").toUpperCase()) ? String(event.m_Pos).toUpperCase() : "C", animation: String(event.m_Face || ""), visible: true, previewAsset: "" }] : [],
      raw: event,
    }];
  });
}

function forkCutsceneRecords(source, scenes, cutsceneId, cutsceneStrId, speakerIds) {
  let sceneIndex = 0;
  return source.events.map((event) => {
    const record = replaceStringValue(cloneJson(event), source.id, cutsceneStrId);
    record.m_CutScenID = cutsceneId;
    record.m_CutScenStrID = cutsceneStrId;
    if (!record.m_CutScenKey_Talk && !record.m_Talk_ENG) return record;
    const scene = scenes[sceneIndex++];
    const speakerId = speakerIds.get(`${scene.speakerActorId}\0${scene.speakerName}`) || scene.speakerActorId;
    record.m_CharStrID = speakerId;
    record.m_bWaitClick = true;
    for (const language of LANGUAGES) record[`m_Talk_${language}`] = scene.dialogue;
    if (scene.voiceLine) record.m_VoiceFileName = scene.voiceLine; else delete record.m_VoiceFileName;
    if (scene.background) record.m_BGFileName = scene.background;
    if (scene.music) record.m_StartBGMFileName = scene.music; else delete record.m_StartBGMFileName;
    record.m_bFadeIn = scene.transition !== "CUT";
    record.m_fFadeTime = scene.transition === "CUT" ? 0 : scene.fadeTime;
    delete record.m_StartFXSoundName;
    delete record.m_StartFXSoundControl;
    if (scene.effects[0]) record.m_StartFXSoundName = scene.effects[0];
    if (scene.effects[1]) record.m_StartFXSoundControl = scene.effects[1];
    const actor = scene.actors.find((item) => item.visible !== false && item.actorId === scene.speakerActorId);
    if (actor) {
      record.m_Pos = actor.position;
      if (actor.animation) record.m_Face = actor.animation; else delete record.m_Face;
    }
    return record;
  });
}

function replaceStringValue(value, before, after) {
  if (typeof value === "string") return value.split(before).join(after);
  if (Array.isArray(value)) return value.map((item) => replaceStringValue(item, before, after));
  if (value && typeof value === "object") for (const key of Object.keys(value)) value[key] = replaceStringValue(value[key], before, after);
  return value;
}

function assertDistinctStages(stages) {
  for (const [label, value, optional] of [
    ["Stage ID", (stage) => Number(stage.stageId)], ["Dungeon ID", (stage) => Number(stage.dungeonId), true],
    ["Cutscene ID", (stage) => Number(stage.cutsceneId), true], ["Stage string ID", (stage) => String(stage.stageStrId || "").toUpperCase()],
    ["Dungeon string ID", (stage) => String(stage.dungeonStrId || "").toUpperCase(), true], ["Cutscene string ID", (stage) => String(stage.cutsceneStrId || "").toUpperCase(), true],
    ["Episode placement", (stage) => `${stage.category}:${stage.episodeId}:${episodeDifficulty(stage.difficulty)}:${stage.actId}:${stage.stageIndex}`],
  ]) {
    const seen = new Set();
    for (const stage of stages) {
      const key = value(stage);
      if (optional && !key) continue;
      if (seen.has(key)) throw httpError(409, `${label} ${key} is used by more than one stage in this episode project.`);
      seen.add(key);
    }
  }
}

function buildAssetIndex(assetRoot) {
  const index = {
    available: fs.existsSync(assetRoot), backgrounds: [], music: [], voices: [], effects: [],
    backgroundById: new Map(), musicById: new Map(), voiceById: new Map(), effectById: new Map(), imageById: new Map(), actorImageByKey: new Map(),
  };
  if (!index.available) return index;
  const stack = [assetRoot];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(fullPath); continue; }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const relative = path.relative(assetRoot, fullPath).replace(/\\/g, "/");
      const id = path.basename(entry.name, extension).toUpperCase();
      if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
        const image = { id, path: relative, type: "image" };
        const score = assetScore(relative);
        remember(index.imageById, id, image, score);
        const actorKey = actorImageKey(id);
        if (actorKey) remember(index.actorImageByKey, actorKey, image, score);
        if (id.startsWith("AB_UI_NKM_UI_CUTSCEN_BG_")) {
          const backgroundId = id.slice("AB_UI_NKM_UI_CUTSCEN_BG_".length);
          remember(index.backgroundById, backgroundId, { id: backgroundId, path: relative, type: "image" }, assetScore(relative));
        }
      } else if ([".wav", ".ogg", ".mp3", ".m4a"].includes(extension)) {
        const item = { id, path: relative, type: "audio" };
        const normalized = `/${relative.toLowerCase()}/`;
        if (normalized.includes("/ab_music/")) remember(index.musicById, id, item, 1);
        if (normalized.includes("voice") || id.startsWith("VOICE_")) remember(index.voiceById, id, item, 1);
        if (id.startsWith("FX_")) remember(index.effectById, id, item, 1);
      }
    }
  }
  index.backgrounds = [...index.backgroundById.values()].sort((left, right) => left.id.localeCompare(right.id));
  index.music = [...index.musicById.values()].sort((left, right) => left.id.localeCompare(right.id));
  index.voices = [...index.voiceById.values()].sort((left, right) => left.id.localeCompare(right.id));
  index.effects = [...index.effectById.values()].sort((left, right) => left.id.localeCompare(right.id));
  return index;
}

function remember(map, key, value, score) {
  const current = map.get(key);
  if (!current || score > current.score) map.set(key, { ...value, score });
}

function assetScore(relative) {
  const value = relative.toLowerCase();
  if (value.includes("/cutscenebg16x9/")) return 10;
  if (value.includes("/ab_unit_illust_") && value.includes("/texture2d/")) return 9;
  if (value.includes("/ab_unit_face_card_loc/") && value.includes("/texture2d/")) return 8;
  if (value.includes("/sprite/")) return 5;
  return 1;
}

function actorAsset(assets, value, actorId = "") {
  const id = String(value || "").trim().toUpperCase();
  const override = assets.imageById.get(ACTOR_PREVIEW_IMAGE_IDS[String(actorId).toUpperCase()]);
  if (override) return override;
  const unit = id.replace(/^NKM_UNIT_/, "");
  for (const candidate of [
    `UNIT_ILLUST_${unit}`, `AB_UNIT_FACE_CARD_${id}`, `AB_INVEN_ICON_${id}`, id, `UNIT_${unit}`,
  ]) {
    const found = assets.imageById.get(candidate);
    if (found) return found;
  }
  return assets.actorImageByKey.get(actorImageKey(id)) || null;
}

function actorImageKey(value) {
  let id = String(value || "").trim().toUpperCase();
  const portrait = id.match(/^(?:UNIT_ILLUST_|AB_UNIT_FACE_CARD_|AB_INVEN_ICON_|AB_SHADOW_FACE_CARD_)(.+)$/);
  if (portrait) id = portrait[1];
  else if (!id.startsWith("NKM_")) return "";
  return id
    .replace(/^NKM_(?:PLAYER|NPC|UNIT|MONSTER|MOB|SHADOW)_/, "")
    .replace(/^(?:(?:SSR|SR|SD|C|S|R|N|A|B)_)+/, "");
}

function buildCutsceneRecords(input) {
  let key = 1;
  const base = () => ({ m_CutScenProcessKey: key++, m_CutScenID: input.cutsceneId, m_CutScenStrID: input.cutsceneStrId, m_bWaitClick: false, m_fWaitTime: 0 });
  const records = [{ ...base(), m_BGFileName: input.background, m_bFadeIn: true, m_fFadeTime: 1.5, ...(input.music ? { m_StartBGMFileName: String(input.music) } : {}) }];
  const visible = new Map();
  let currentBackground = input.background;
  let currentMusic = String(input.music || "");
  for (const scene of input.scenes) {
    if (scene.background && scene.background !== currentBackground) {
      records.push({ ...base(), m_BGFileName: scene.background, m_bFadeIn: scene.transition !== "CUT", m_fFadeTime: scene.transition === "CUT" ? 0 : scene.fadeTime });
      currentBackground = scene.background;
    }
    if (scene.music && scene.music !== currentMusic) {
      records.push({ ...base(), m_StartBGMFileName: scene.music });
      currentMusic = scene.music;
    }
    const desired = new Map(scene.actors.filter((actor) => actor.visible !== false).map((actor) => [actor.actorId, actor]));
    for (const [actorId, actor] of visible) if (!desired.has(actorId)) records.push({ ...base(), m_CharStrID: actorId, m_Pos: `${actor.position}_D` });
    for (const [actorId, actor] of desired) {
      const previous = visible.get(actorId);
      if (!previous || previous.position !== actor.position || previous.animation !== actor.animation) records.push({ ...base(), m_CharStrID: actorId, m_Pos: actor.position, ...(actor.animation ? { m_Face: actor.animation } : {}) });
    }
    for (const effect of scene.effects) records.push({ ...base(), m_StartFXSoundName: effect });
    const speakerId = input.speakerIds.get(`${scene.speakerActorId}\0${scene.speakerName}`) || scene.speakerActorId;
    const speakerActor = scene.actors.find((actor) => actor.visible !== false && actor.actorId === scene.speakerActorId);
    const talk = {
      ...base(),
      m_CutScenKey_Talk: `${input.cutsceneStrId}@${key - 1}#Talk`,
      m_bWaitClick: true,
      m_CharStrID: speakerId,
      ...(speakerActor ? { m_Pos: speakerActor.position, ...(speakerActor.animation ? { m_Face: speakerActor.animation } : {}) } : {}),
      ...(scene.voiceLine ? { m_VoiceFileName: scene.voiceLine } : {}),
      m_fTalkTime: 0.03,
    };
    for (const language of LANGUAGES) talk[`m_Talk_${language}`] = scene.dialogue;
    records.push(talk);
    visible.clear();
    for (const [actorId, actor] of desired) visible.set(actorId, actor);
  }
  records.push({ ...base(), m_bFadeIn: false, m_fFadeTime: 1.5 });
  return records;
}

function normalizeScenes(value, options = {}) {
  if (!Array.isArray(value) || !value.length || value.length > 500) throw httpError(400, "Scenes must contain 1-500 ordered dialogue entries.");
  return value.map((scene, index) => {
    if (!scene || typeof scene !== "object" || Array.isArray(scene)) throw httpError(400, `Scene ${index + 1} must be an object.`);
    const actors = Array.isArray(scene.actors) ? scene.actors : [];
    if (actors.length > 6) throw httpError(400, `Scene ${index + 1} can show at most six actors.`);
    return {
      speakerName: requiredText(scene.speakerName, `Scene ${index + 1} speaker name`, 120),
      speakerActorId: options.allowEmptyActor && !String(scene.speakerActorId || "").trim() ? "" : gameId(scene.speakerActorId, `Scene ${index + 1} speaker actor ID`),
      dialogue: requiredText(scene.dialogue, `Scene ${index + 1} dialogue`, 4000),
      voiceLine: optionalGameId(scene.voiceLine, `Scene ${index + 1} voice line`),
      background: optionalGameId(scene.background, `Scene ${index + 1} background`),
      music: optionalGameId(scene.music, `Scene ${index + 1} music`),
      transition: String(scene.transition || "FADE").toUpperCase() === "CUT" ? "CUT" : "FADE",
      fadeTime: boundedNumber(scene.fadeTime, 1, 0, 10, `Scene ${index + 1} fade time`),
      dimActors: scene.dimActors === true,
      effects: (Array.isArray(scene.effects) ? scene.effects : []).map((effect) => gameId(effect, `Scene ${index + 1} effect`)).slice(0, 20),
      actors: actors.map((actor, actorIndex) => {
        const position = String(actor && actor.position || "C").toUpperCase();
        if (!POSITIONS.has(position)) throw httpError(400, `Scene ${index + 1} actor ${actorIndex + 1} has an unsupported position.`);
        return {
          actorId: gameId(actor && actor.actorId, `Scene ${index + 1} actor ${actorIndex + 1} ID`),
          position,
          animation: optionalGameId(actor && actor.animation, `Scene ${index + 1} actor ${actorIndex + 1} animation`),
          visible: actor && actor.visible !== false,
          previewAsset: String(actor && actor.previewAsset || "").trim().slice(0, 500),
        };
      }),
      cutsceneSlot: ["before", "after"].includes(String(scene.cutsceneSlot || "").toLowerCase()) ? String(scene.cutsceneSlot).toLowerCase() : "",
      processKey: Number(scene.processKey || 0),
    };
  });
}

function defaultCompletionRewards(row, blank) {
  return Array.from({ length: 3 }, (_, index) => blank ? { completeRate: 0, rewardType: "", rewardId: 0, rewardValue: 0 } : {
    completeRate: Number(row[`m_CompleteRate_${index + 1}`] || 0),
    rewardType: String(row[`m_RewardType_${index + 1}`] || ""),
    rewardId: Number(row[`m_RewardID_${index + 1}`] || 0),
    rewardValue: Number(row[`m_RewardValue_${index + 1}`] || 0),
  });
}

function normalizeCompletionRewards(value, defaults, label) {
  if (value != null && !Array.isArray(value)) throw httpError(400, `${label} must be an array.`);
  if (Array.isArray(value) && value.length > 3) throw httpError(400, `${label} can contain at most three tiers.`);
  const source = Array.isArray(value) ? value : defaults;
  const rewards = Array.from({ length: 3 }, (_, index) => {
    const item = source[index] && typeof source[index] === "object" && !Array.isArray(source[index]) ? source[index] : {};
    const fallback = defaults[index] || {};
    const reward = {
      completeRate: boundedInteger(item.completeRate, Number(fallback.completeRate || 0), 0, 100, `${label} tier ${index + 1} rate`),
      rewardType: optionalGameId(item.rewardType == null ? fallback.rewardType : item.rewardType, `${label} tier ${index + 1} type`),
      rewardId: boundedInteger(item.rewardId, Number(fallback.rewardId || 0), 0, 2147483647, `${label} tier ${index + 1} ID`),
      rewardValue: boundedInteger(item.rewardValue, Number(fallback.rewardValue || 0), 0, 2147483647, `${label} tier ${index + 1} value`),
    };
    const configured = reward.completeRate || reward.rewardType || reward.rewardId || reward.rewardValue;
    if (configured && (!reward.completeRate || !reward.rewardType || !reward.rewardId || !reward.rewardValue)) throw httpError(400, `${label} tier ${index + 1} must set rate, type, ID, and value together.`);
    return reward;
  });
  const configured = rewards.filter((reward) => reward.completeRate);
  if (configured.some((reward, index) => reward !== rewards[index])) throw httpError(400, `${label} tiers cannot contain gaps.`);
  if (configured.some((reward, index) => index && reward.completeRate <= configured[index - 1].completeRate)) throw httpError(400, `${label} rates must increase by tier.`);
  return rewards;
}

function completionRewardFields(rewards) {
  return Object.assign({}, ...rewards.map((reward, index) => reward.completeRate ? {
    [`m_CompleteRate_${index + 1}`]: reward.completeRate,
    [`m_RewardType_${index + 1}`]: reward.rewardType,
    [`m_RewardID_${index + 1}`]: reward.rewardId,
    [`m_RewardValue_${index + 1}`]: reward.rewardValue,
  } : {}));
}

function defaultResourceChange(row, blank) {
  return blank ? { missionCondition: "", missionValue: 0, backgroundMusic: "" } : {
    missionCondition: String(row.Change_Resource_MissonCond || ""),
    missionValue: Number(row.Change_Resource_MissonValue || 0),
    backgroundMusic: String(row.Change_Resource_BG_Music || ""),
  };
}

function normalizeResourceChange(value, defaults, label) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {
    missionCondition: optionalGameId(input.missionCondition == null ? defaults.missionCondition : input.missionCondition, `${label} mission condition`),
    missionValue: boundedInteger(input.missionValue, Number(defaults.missionValue || 0), 0, 2147483647, `${label} mission value`),
    backgroundMusic: optionalGameId(input.backgroundMusic == null ? defaults.backgroundMusic : input.backgroundMusic, `${label} music`),
  };
  const configured = result.missionCondition || result.missionValue || result.backgroundMusic;
  if (configured && (!result.missionCondition || !result.missionValue || !result.backgroundMusic)) throw httpError(400, `${label} must set condition, value, and music together.`);
  return result;
}

function patch(table, field, value, record) { return { table, key: { field, value }, value: record, source: "revivalside-episode-maker" }; }
function cleanRewards(value) { return Object.fromEntries(Object.entries(value).filter(([key]) => !REWARD_FIELD.test(key))); }
function positiveInteger(value, label) { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw httpError(400, `${label} must be a positive integer.`); return number; }
function nonNegativeInteger(value, label) { const number = Number(value || 0); if (!Number.isSafeInteger(number) || number < 0) throw httpError(400, `${label} must be a non-negative integer.`); return number; }
function boundedInteger(value, fallback, minimum, maximum, label) { const number = value == null || value === "" ? fallback : Number(value); if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw httpError(400, `${label} must be an integer between ${minimum} and ${maximum}.`); return number; }
function boundedNumber(value, fallback, minimum, maximum, label) { const number = value == null || value === "" ? fallback : Number(value); if (!Number.isFinite(number) || number < minimum || number > maximum) throw httpError(400, `${label} must be between ${minimum} and ${maximum}.`); return number; }
function gameId(value, label) { const id = String(value || "").trim().toUpperCase(); if (!/^[A-Z0-9_@.-]{1,180}$/.test(id)) throw httpError(400, `${label} contains unsupported characters.`); return id; }
function optionalGameId(value, label) { return value == null || String(value).trim() === "" ? "" : gameId(value, label); }
function requiredText(value, label, max) { const text = String(value || "").trim(); if (!text) throw httpError(400, `${label} is required.`); return text.slice(0, max); }
function limitedText(value, label, max, required) { const text = String(value || "").trim(); if (required && !text) throw httpError(400, `${label} is required.`); if (text.length > max) throw httpError(400, `${label} cannot exceed ${max} characters.`); return text; }
function episodeDifficulty(value) { const difficulty = String(value || "NORMAL").trim().toUpperCase(); if (!new Set(["NORMAL", "HARD"]).has(difficulty)) throw httpError(400, "Episode difficulty must be NORMAL or HARD."); return difficulty; }
function scrollType(value, fallback, label) { const type = String(value || fallback || "HORIZONTAL").trim().toUpperCase(); if (!SCROLL_TYPES.has(type)) throw httpError(400, `${label} must be HORIZONTAL or VERTICAL.`); return type; }
function uniquePositiveIntegers(value, label, max) { if (value == null || value === "") return []; if (!Array.isArray(value)) throw httpError(400, `${label} must be an array.`); if (value.length > max) throw httpError(400, `${label} can contain at most ${max} values.`); const values = value.map((item) => positiveInteger(item, label)); if (new Set(values).size !== values.length) throw httpError(400, `${label} cannot contain duplicates.`); return values; }
function stripColor(value) { return String(value || "").replace(/<[^>]+>/g, "").trim(); }
function slug(value) { return String(value || "SPEAKER").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "SPEAKER"; }
function parseEpisodeNumber(value) { const match = String(value || "").match(/EP_(\d+)$/); return match ? Number(match[1]) : 0; }
function episodeLabel(row) { const match = String(row.m_EpisodeStrID || "").match(/EP_(\d+)$/); return `${row.m_EPCategory === "EC_MAINSTREAM" ? "Mainstream" : "Substream"}${match ? ` Episode ${Number(match[1])}` : ` ${row.m_EpisodeID}`}`; }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

module.exports = { buildCutsceneRecords, createModEpisodeMaker };
