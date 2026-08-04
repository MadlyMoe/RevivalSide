const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { extractTableRecords, listGameplayTableFiles, readGameplayTable } = require("../gameplay-jsons");
const { createModProjectStore } = require("../mod-projects");

const SCHEMA_VERSION = 1;
const RUNTIME_COMPILER_VERSION = 3;
const LUA_RESERVED = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"]);
const REQUIRED_UNIT_RUNTIME_TABLES = [
  ["ab_script", "LUA_LIMITBREAK_INFO.json"],
  ["ab_script", "LUA_PLAYER_EXP_TABLE.json"],
  ["ab_script_unit_data", "LUA_UNIT_EXP_TABLE.json"],
];
const UNIT_BASE_TABLES = new Set(["LUA_UNIT_TEMPLET_BASE", "LUA_UNIT_TEMPLET_BASE2"]);

function createModRuntime(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, "..", ".."));
  const env = options.env || process.env;
  const store = options.modStore || createModProjectStore({ rootDir, modsRoot: options.modsRoot || env.CS_MODS_ROOT });
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(store.modsRoot, ".runtime"));
  const profilePath = path.resolve(options.profilePath || path.join(store.modsRoot, "profile.json"));
  const currentRoot = path.join(runtimeRoot, "current");
  const previousRoot = path.join(runtimeRoot, "previous");

  function readProfile() {
    if (!fs.existsSync(profilePath)) return { schemaVersion: SCHEMA_VERSION, enabled: [] };
    const profile = readJson(profilePath, "mod profile");
    return normalizeProfile(profile, store.listProjects().map((project) => project.id));
  }

  function writeProfile(input) {
    const profile = normalizeProfile(input, store.listProjects().map((project) => project.id));
    writeJsonAtomic(profilePath, profile);
    return profile;
  }

  function status() {
    const current = readOptionalManifest(currentRoot);
    return {
      profile: readProfile(),
      projects: store.listProjects(),
      current,
      previous: readOptionalManifest(previousRoot),
      runtimeRoot,
      active: Boolean(current),
      restartRequired: Boolean(current),
    };
  }

  function build() {
    const profile = readProfile();
    const projects = profile.enabled.map((id) => store.readProject(id));
    const baseEnv = { ...env };
    delete baseEnv.CS_MOD_TABLES_DIR;
    validateEnabledAuthoringCollisions(projects);
    if (projects.some((project) => project.patches.some((patch) => UNIT_BASE_TABLES.has(String(patch.table.tableName).toUpperCase()) && patch.value))) {
      validateUnitRuntimeTables(rootDir, baseEnv);
    }
    validateCustomEpisodeRuntime(projects, rootDir, baseEnv);
    const tables = listGameplayTableFiles({ rootDir, env: baseEnv });
    const tableByKey = new Map(tables.map((table) => [tableKey(table), table]));
    const decodedTables = new Map();
    const grouped = new Map();
    const changes = [];
    const conflicts = [];
    const warnings = [];
    const owners = new Map();
    const fullTables = new Map();
    const stringOwners = new Map();
    const strings = new Map();
    const bundleOwners = new Map();
    const bundles = new Map();
    const referenceIds = loadReferenceIds(options.referenceIndexPath || path.join(rootDir, "wiki", "data", "idIndex.json"));

    for (const project of projects) {
      for (const entry of project.tables || []) {
        const key = tableKey(entry.table);
        if (fullTables.has(key)) conflicts.push({ type: "table", table: key, previousModId: fullTables.get(key).modId, winningModId: project.manifest.id });
        fullTables.set(key, { modId: project.manifest.id, ...entry });
      }
      for (const [key, value] of Object.entries(project.strings || {})) {
        if (stringOwners.has(key)) conflicts.push({ type: "string", key, previousModId: stringOwners.get(key), winningModId: project.manifest.id });
        stringOwners.set(key, project.manifest.id);
        strings.set(key, String(value));
      }
      for (const file of listRelativeFiles(path.join(project.root, "assets", "bundles"))) {
        const key = file.relativePath.toLowerCase();
        if (bundleOwners.has(key)) conflicts.push({ type: "asset-bundle", file: file.relativePath, previousModId: bundleOwners.get(key), winningModId: project.manifest.id });
        bundleOwners.set(key, project.manifest.id);
        bundles.set(key, { ...file, modId: project.manifest.id });
      }
      for (const patch of project.patches) {
        referenceIds.add(String(patch.key.value));
        const key = tableKey(patch.table);
        if (!tableByKey.has(key) && !fullTables.has(key)) {
          const parsed = readGameplayTable(patch.table.directory, patch.table.fileName, { rootDir, env: baseEnv, noCache: true });
          if (!parsed) throw httpError(422, `${project.manifest.id}: gameplay table ${patch.table.directory}/${patch.table.fileName} was not found.`);
          tableByKey.set(key, patch.table);
          decodedTables.set(key, parsed);
        }
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push({ modId: project.manifest.id, patch });
        const identity = `${key}\0${patch.key.field}\0${JSON.stringify(patch.key.value)}`;
        if (owners.has(identity)) conflicts.push({ table: key, key: patch.key, previousModId: owners.get(identity), winningModId: project.manifest.id });
        owners.set(identity, project.manifest.id);
      }
    }

    const buildRoot = path.join(runtimeRoot, `.build-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      const buildKeys = new Set([...grouped.keys(), ...fullTables.keys()]);
      for (const key of buildKeys) {
        const fullTable = fullTables.get(key);
        const table = fullTable ? fullTable.table : tableByKey.get(key);
        const parsed = fullTable ? cloneJson(fullTable.compiled) : decodedTables.get(key) || readGameplayTable(table.directory, table.fileName, { rootDir, env: baseEnv, noCache: true });
        if (!parsed || typeof parsed !== "object") throw httpError(422, `Gameplay table ${key} could not be decoded.`);
        const entries = grouped.get(key) || [];
        const compiled = fullTable || entries.length ? compileTable(parsed, entries, changes, warnings, referenceIds) : parsed;
        if (fullTable) changes.push({ modId: fullTable.modId, table: key, action: tableByKey.has(key) ? "replace-table" : "add-table" });
        const outputDir = path.join(buildRoot, "Assetbundles", table.directory, "luac");
        const baseName = table.tableName || path.basename(table.fileName, path.extname(table.fileName));
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, `${baseName}.json`), `${JSON.stringify(compiled, null, 2)}\n`, "utf8");
        fs.writeFileSync(path.join(outputDir, `${baseName}.lua`), buildLua(compiled), "utf8");
      }

      for (const [key, value] of strings) {
        const filePath = path.join(buildRoot, "Strings", `${key}.txt`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, value, "utf8");
        changes.push({ modId: stringOwners.get(key), string: key, action: "add-string" });
      }
      for (const bundle of bundles.values()) {
        const filePath = path.join(buildRoot, "ClientAssetBundles", bundle.relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.copyFileSync(bundle.filePath, filePath);
        changes.push({ modId: bundle.modId, assetBundle: bundle.relativePath, action: "add-asset-bundle" });
      }

      const hashInput = {
        compilerVersion: RUNTIME_COMPILER_VERSION,
        projects: projects.map((project) => ({
          id: project.manifest.id,
          version: project.manifest.version,
          patches: project.patches.map(stripRuntimePatch),
          tables: (project.tables || []).map((entry) => ({ table: entry.table, compiled: entry.compiled })),
          strings: project.strings || {},
          bundles: listRelativeFiles(path.join(project.root, "assets", "bundles")).map((file) => ({ path: file.relativePath, hash: file.hash })),
        })),
      };
      const hash = crypto.createHash("sha256").update(stableJson(hashInput)).digest("hex");
      const unitIds = Array.from(new Set(projects.flatMap((project) => project.patches
        .filter((patch) => UNIT_BASE_TABLES.has(String(patch.table.tableName).toUpperCase()) && patch.value)
        .map((patch) => Number(patch.value.m_UnitID))
        .filter((value) => Number.isSafeInteger(value) && value > 0)))).sort((left, right) => left - right);
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        hash,
        builtAt: new Date().toISOString(),
        enabled: projects.map((project) => ({ id: project.manifest.id, name: project.manifest.name, version: project.manifest.version })),
        tableCount: buildKeys.size,
        patchCount: projects.reduce((count, project) => count + project.patches.length, 0),
        fullTableCount: fullTables.size,
        stringCount: strings.size,
        assetBundleCount: bundles.size,
        unitIds,
        conflicts,
        warnings,
        changes,
      };
      writeJsonAtomic(path.join(buildRoot, "mod-set.json"), manifest);
      writeJsonAtomic(path.join(buildRoot, "client", "mod-set.json"), manifest);
      writeJsonAtomic(path.join(buildRoot, "server", "mod-set.json"), manifest);
      installBuild(buildRoot, currentRoot, previousRoot, runtimeRoot);
      activateEnvironment(env, currentRoot);
      return { ...status(), built: manifest };
    } catch (err) {
      if (isInside(runtimeRoot, buildRoot) && fs.existsSync(buildRoot)) fs.rmSync(buildRoot, { recursive: true, force: true });
      throw err;
    }
  }

  function applyProfile(input) {
    const previous = readProfile();
    writeProfile(input);
    try { return build(); }
    catch (err) { writeProfile(previous); throw err; }
  }

  function deleteProject(id) {
    const project = store.readProject(id);
    const profile = readProfile();
    const current = readOptionalManifest(currentRoot);
    if (profile.enabled.includes(id) || current && current.enabled.some((entry) => entry.id === id)) {
      applyProfile({ enabled: profile.enabled.filter((enabledId) => enabledId !== id) });
    }
    const deleted = store.deleteProject(id);
    const previous = readOptionalManifest(previousRoot);
    if (previous && previous.enabled.some((entry) => entry.id === id)) fs.rmSync(previousRoot, { recursive: true });
    return { ...status(), deleted: { ...deleted, name: project.manifest.name } };
  }

  function rollback() {
    if (!fs.existsSync(previousRoot)) throw httpError(409, "No previous mod runtime is available.");
    const swap = path.join(runtimeRoot, `.rollback-${process.pid}-${crypto.randomBytes(5).toString("hex")}`);
    if (fs.existsSync(currentRoot)) fs.renameSync(currentRoot, swap);
    fs.renameSync(previousRoot, currentRoot);
    if (fs.existsSync(swap)) fs.renameSync(swap, previousRoot);
    activateEnvironment(env, currentRoot);
    return status();
  }

  function activate() {
    if (!readOptionalManifest(currentRoot)) return false;
    activateEnvironment(env, currentRoot);
    return true;
  }

  return { store, runtimeRoot, profilePath, currentRoot, previousRoot, readProfile, writeProfile, status, build, applyProfile, deleteProject, rollback, activate };
}

function validateUnitRuntimeTables(rootDir, env) {
  for (const [directory, fileName] of REQUIRED_UNIT_RUNTIME_TABLES) {
    const parsed = readGameplayTable(directory, fileName, { rootDir, env, noCache: true });
    if (!parsed || extractTableRecords(parsed).length === 0) throw httpError(422, `Required unit progression table could not be decoded: ${directory}/${fileName}`);
  }
}

function validateEnabledAuthoringCollisions(projects) {
  const claims = new Map();
  const claim = (type, value, modId) => {
    if (value == null || value === "") return;
    const key = `${type}\0${JSON.stringify(value)}`;
    const previous = claims.get(key);
    if (previous && previous !== modId) throw httpError(409, `${type} ${JSON.stringify(value)} collides between enabled mods ${previous} and ${modId}.`);
    claims.set(key, modId);
  };
  const number = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const text = (value) => String(value || "").trim().toUpperCase() || null;

  for (const project of projects) {
    const modId = project.manifest.id;
    for (const patch of project.patches) {
      const table = String(patch.table.tableName || "").toUpperCase();
      const value = patch.value;
      if (!value) continue;
      if (UNIT_BASE_TABLES.has(table)) {
        claim("Unit ID", number(value.m_UnitID), modId);
        claim("Unit string ID", text(value.m_UnitStrID), modId);
      } else if (table === "LUA_UNIT_SKILL_TEMPLET") {
        claim("Unit skill ID", number(value.m_UnitSkillID), modId);
        claim("Unit skill string ID", text(value.m_UnitSkillStrID), modId);
      } else if (table === "LUA_SKIN_TEMPLET") {
        claim("Skin ID", number(value.m_SkinID), modId);
        claim("Skin string ID", text(value.m_SkinStrID), modId);
      } else if (table === "LUA_EPISODE_TEMPLET" || table === "LUA_STAGE_TEMPLET") {
        claim("Stage ID", number(value.m_StageID), modId);
        claim("Stage string ID", text(value.m_StageStrID), modId);
        if (table === "LUA_EPISODE_TEMPLET") claim("Episode stage slot", [text(value.m_EPCategory), number(value.m_EpisodeID), text(value.m_Difficulty), number(value.m_ActID), number(value.m_StageIndex)], modId);
      } else if (table === "LUA_DUNGEON_TEMPLET_BASE") {
        claim("Dungeon ID", number(value.m_DungeonID), modId);
        claim("Dungeon string ID", text(value.m_DungeonStrID), modId);
      } else if (table === "LUA_CUTSCENE_FILE_LIST") {
        claim("Cutscene file", text(value.m_CutScenFile), modId);
      } else if (table === "LUA_CUTSCENE_CHAR_TEMPLET") {
        claim("Cutscene character ID", text(value.m_CharStrID), modId);
      } else if (table === "LUA_EPISODE_TEMPLET_V2") {
        claim("Episode ID", number(value.m_EpisodeID), modId);
        claim("Episode string ID", text(value.m_EpisodeStrID), modId);
        claim("Episode open tag", text(value.m_OpenTag), modId);
      } else if (table === "LUA_EPISODE_SUMMARY_TEMPLET") {
        claim("Episode summary ID", number(value.EpisodeID), modId);
        claim("Episode summary index", number(value.INDEX), modId);
      }
    }
    for (const entry of project.tables || []) {
      const directory = String(entry.table.directory || "").toLowerCase();
      if (directory === "ab_script_cutscene") {
        claim("Cutscene table", text(entry.table.tableName), modId);
        for (const row of extractTableRecords(entry.compiled)) claim("Cutscene ID", number(row && row.m_CutScenID), modId);
      } else if (directory === "ab_script_unit_data_unit_templet") {
        claim("Unit template table", text(entry.table.tableName), modId);
      }
    }
  }
}

function validateCustomEpisodeRuntime(projects, rootDir, env) {
  const candidateRows = projectValues(projects, "LUA_EPISODE_TEMPLET_V2");
  if (!candidateRows.length) return;
  const baseEpisodes = extractTableRecords(readGameplayTable("ab_script", "LUA_EPISODE_TEMPLET_V2.json", { rootDir, env, noCache: true }) || {});
  const baseEpisodeIds = new Set(baseEpisodes.map((row) => Number(row && row.m_EpisodeID)).filter(Number.isSafeInteger));
  const episodeRows = candidateRows.filter((entry) => !baseEpisodeIds.has(Number(entry.value.m_EpisodeID)));
  if (!episodeRows.length) return;
  const groups = new Set(extractTableRecords(readGameplayTable("ab_script", "LUA_EPISODE_GROUP_TEMPLET.json", { rootDir, env, noCache: true }) || {}).map((row) => Number(row && row.GroupID)).filter(Number.isSafeInteger));
  const summaries = projectValues(projects, "LUA_EPISODE_SUMMARY_TEMPLET");
  const placements = projectValues(projects, "LUA_EPISODE_TEMPLET");
  const stages = projectValues(projects, "LUA_STAGE_TEMPLET");
  const dungeons = projectValues(projects, "LUA_DUNGEON_TEMPLET_BASE");
  const cutsceneFiles = new Set(projectValues(projects, "LUA_CUTSCENE_FILE_LIST").map((entry) => String(entry.value.m_CutScenFile || "").toUpperCase()));
  const fullTables = new Set(projects.flatMap((project) => (project.tables || []).map((entry) => String(entry.table.tableName || "").toUpperCase())));
  const strings = new Set(projects.flatMap((project) => Object.keys(project.strings || {})));
  const byId = new Map();
  for (const entry of episodeRows) {
    const id = Number(entry.value.m_EpisodeID);
    if (!Number.isSafeInteger(id) || id <= 0) throw httpError(422, `${entry.modId}: custom episode ID must be a positive integer.`);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(entry);
  }
  for (const [episodeId, entries] of byId) {
    const owners = new Set(entries.map((entry) => entry.modId));
    if (owners.size > 1) throw httpError(422, `Custom episode ${episodeId} is defined by more than one active mod: ${Array.from(owners).join(", ")}.`);
    const normal = entries.filter((entry) => String(entry.value.m_Difficulty) === "NORMAL");
    const hard = entries.filter((entry) => String(entry.value.m_Difficulty) === "HARD");
    if (normal.length !== 1 || hard.length > 1) throw httpError(422, `${entries[0].modId}: custom episode ${episodeId} needs exactly one Normal definition and at most one Hard definition.`);
    const normalRow = normal[0].value;
    if (normalRow.m_EPCategory !== "EC_MAINSTREAM") throw httpError(422, `${normal[0].modId}: custom episode ${episodeId} must stay in EC_MAINSTREAM.`);
    if (!groups.has(Number(normalRow.GroupID))) throw httpError(422, `${normal[0].modId}: custom episode ${episodeId} references missing group ${normalRow.GroupID}.`);
    for (const field of ["m_EpisodeStrID", "m_OpenTag", "m_EpisodeTitle", "m_EpisodeName", "m_EpisodeDesc_1", "m_Stage_Viewer_Prefab", "m_EPThumbnail", "m_Scroll_Type"]) if (!String(normalRow[field] || "").trim()) throw httpError(422, `${normal[0].modId}: custom episode ${episodeId} is missing ${field}.`);
    if (!strings.has(String(normalRow.m_EpisodeTitle)) || !strings.has(String(normalRow.m_EpisodeName)) || !strings.has(String(normalRow.m_EpisodeDesc_1))) throw httpError(422, `${normal[0].modId}: custom episode ${episodeId} is missing title, name, or description strings.`);
    if (!Number.isSafeInteger(Number(normalRow.m_ActCount)) || Number(normalRow.m_ActCount) < 1) throw httpError(422, `${normal[0].modId}: custom episode ${episodeId} has an invalid Normal act count.`);
    if (hard.length) {
      const hardRow = hard[0].value;
      if (hardRow.m_EpisodeStrID !== normalRow.m_EpisodeStrID || hardRow.m_EPCategory !== normalRow.m_EPCategory || hardRow.m_OpenTag === normalRow.m_OpenTag) throw httpError(422, `${hard[0].modId}: custom episode ${episodeId} has incompatible Hard mode identity.`);
      if (!Number.isSafeInteger(Number(hardRow.m_ActCount)) || Number(hardRow.m_ActCount) < 1) throw httpError(422, `${hard[0].modId}: custom episode ${episodeId} has an invalid Hard act count.`);
    }
    if (summaries.filter((entry) => Number(entry.value.EpisodeID) === episodeId).length !== 1) throw httpError(422, `${normal[0].modId}: custom episode ${episodeId} needs exactly one summary registration.`);
    const episodeStages = placements.filter((entry) => Number(entry.value.m_EpisodeID) === episodeId);
    for (const placement of episodeStages) {
      const difficulty = String(placement.value.m_Difficulty || "NORMAL");
      const definition = difficulty === "HARD" ? hard[0] : normal[0];
      if (!definition) throw httpError(422, `${placement.modId}: custom episode ${episodeId} has a Hard stage without a Hard episode definition.`);
      if (Number(placement.value.m_ActID) > Number(definition.value.m_ActCount)) throw httpError(422, `${placement.modId}: custom episode ${episodeId} stage act exceeds its ${difficulty} act count.`);
      const stage = stages.find((entry) => Number(entry.value.m_StageID) === Number(placement.value.m_StageID));
      if (!stage) throw httpError(422, `${placement.modId}: custom episode ${episodeId} stage ${placement.value.m_StageID} is missing LUA_STAGE_TEMPLET.`);
      const dungeon = dungeons.find((entry) => String(entry.value.m_DungeonStrID) === String(placement.value.m_StageBattleStrID));
      if (!dungeon) throw httpError(422, `${placement.modId}: custom episode ${episodeId} stage ${placement.value.m_StageID} is missing its dungeon.`);
      const cutscene = String(dungeon.value.m_CutScenStrIDBefore || "").toUpperCase();
      if (String(dungeon.value.m_DungeonType) === "NDT_CUTSCENE" && (!cutscene || !cutsceneFiles.has(cutscene) || !fullTables.has(cutscene))) throw httpError(422, `${placement.modId}: custom episode ${episodeId} stage ${placement.value.m_StageID} is missing its cutscene registration or table.`);
    }
  }
}

function projectValues(projects, tableName) {
  return projects.flatMap((project) => project.patches.filter((patch) => patch.value && String(patch.table.tableName).toUpperCase() === tableName).map((patch) => ({ modId: project.manifest.id, value: patch.value })));
}

function activateInstalledModRuntime(options = {}) {
  const runtime = createModRuntime(options);
  runtime.activate();
  return runtime;
}

function compileTable(parsed, entries, changes, warnings, referenceIds) {
  const records = cloneJson(extractTableRecords(parsed));
  const root = parsed.root == null ? records : cloneJson(parsed.root);
  for (const { modId, patch } of entries) {
    const index = findRecordIndex(records, patch.key);
    validatePatchAgainstRecords(modId, patch, records, index);
    if (patch.value === null) {
      if (index < 0) throw httpError(422, `${modId}: cannot remove missing ${patch.key.field}=${JSON.stringify(patch.key.value)}.`);
      records.splice(index, 1);
    } else if (index < 0) {
      records.push(cloneJson(patch.value));
      collectReferenceWarnings(patch, modId, warnings, referenceIds);
    } else {
      records[index] = cloneJson(patch.value);
    }
    changes.push({ modId, table: tableKey(patch.table), key: patch.key, action: patch.value === null ? "remove" : index < 0 ? "add" : "replace" });
  }
  const effectiveRoot = rebuildRoot(root, records);
  const compiled = {
    source: "revivalside-mod-loader",
    rootName: parsed.rootName || "TABLE",
    recordCount: records.length,
    records,
    root: effectiveRoot,
  };
  if (parsed.globals && typeof parsed.globals === "object" && !Array.isArray(parsed.globals)) {
    compiled.globals = cloneJson(parsed.globals);
    compiled.globals[compiled.rootName] = effectiveRoot;
  }
  return compiled;
}

function validatePatchAgainstRecords(modId, patch, records, index) {
  if (patch.value && patch.key.field !== "__index" && patch.value[patch.key.field] !== patch.key.value) {
    throw httpError(422, `${modId}: record key ${patch.key.field} must equal ${JSON.stringify(patch.key.value)}.`);
  }
  if (patch.key.field === "__index" && index < 0 && patch.value !== null) {
    throw httpError(422, `${modId}: an index patch cannot add a new record.`);
  }
  if (patch.value && index >= 0) assertCompatibleTypes(records[index], patch.value, modId, "value");
}

function assertCompatibleTypes(base, value, modId, fieldPath) {
  if (base == null || value == null) return;
  if (Array.isArray(base) !== Array.isArray(value) || typeof base !== typeof value) {
    throw httpError(422, `${modId}: ${fieldPath} must keep type ${Array.isArray(base) ? "array" : typeof base}.`);
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(base, key)) assertCompatibleTypes(base[key], child, modId, `${fieldPath}.${key}`);
  }
}

function rebuildRoot(baseRoot, records) {
  if (Array.isArray(baseRoot)) return records;
  if (!baseRoot || typeof baseRoot !== "object") return records;
  const output = {};
  for (const record of records) {
    if (record && typeof record === "object" && !Array.isArray(record) && Object.prototype.hasOwnProperty.call(record, "__key")) {
      const { __key, ...value } = record;
      output[__key] = Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, "value")
        ? value.value
        : Array.isArray(baseRoot[__key]) && Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, "values")
          ? value.values
          : value;
    }
  }
  return Object.keys(output).length === records.length ? output : records;
}

function findRecordIndex(records, key) {
  if (key.field === "__index") {
    const index = Number(key.value);
    return Number.isSafeInteger(index) && index >= 0 && index < records.length ? index : -1;
  }
  return records.findIndex((record) => record && typeof record === "object" && record[key.field] === key.value);
}

function collectReferenceWarnings(patch, modId, warnings, referenceIds) {
  walk(patch.value, "", (field, value, fieldPath) => {
    if (field !== patch.key.field && /(?:str)?id$/i.test(field) && typeof value === "string" && value && !/^\d+$/.test(value) && !referenceIds.has(value)) {
      warnings.push({ modId, table: tableKey(patch.table), path: fieldPath, value, message: "Reference was not found in the game-data index; verify the target mod also adds it." });
    }
  });
}

function loadReferenceIds(filePath) {
  if (!fs.existsSync(filePath)) return new Set();
  try {
    const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const values = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && row.id !== "" && row.id != null) values.add(String(row.id));
      if (row && row.strId) values.add(String(row.strId));
    }
    return values;
  } catch (_) {
    return new Set();
  }
}

function walk(value, prefix, visit) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") walk(child, fieldPath, visit);
    else visit(key, child, fieldPath);
  }
}

function buildLua(compiled) {
  let text = "";
  if (compiled.globals) {
    for (const [name, value] of Object.entries(compiled.globals)) text += `${luaGlobal(name)} = ${luaValue(value)}\n`;
  } else {
    text = `${luaGlobal(compiled.rootName)} = ${luaValue(compiled.root)}\n`;
  }
  return text;
}

function luaValue(value) {
  if (value == null) return "nil";
  if (typeof value === "string") return luaString(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw httpError(422, "Lua tables cannot contain non-finite numbers.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `{${value.map(luaValue).join(",")}}`;
  if (typeof value === "object") return `{${Object.entries(value).map(([key, child]) => `${luaKey(key)}=${luaValue(child)}`).join(",")}}`;
  throw httpError(422, `Lua tables cannot contain ${typeof value}.`);
}

function luaGlobal(name) {
  return luaIdentifier(name) ? name : `_G[${luaString(name)}]`;
}

function luaKey(name) {
  return luaIdentifier(name) ? name : `[${luaString(name)}]`;
}

function luaIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && !LUA_RESERVED.has(value);
}

function luaString(value) {
  let output = '"';
  for (const character of String(value)) {
    if (character === "\\") output += "\\\\";
    else if (character === '"') output += '\\"';
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (character.charCodeAt(0) < 32) output += `\\${character.charCodeAt(0).toString().padStart(3, "0")}`;
    else output += character;
  }
  return output + '"';
}

function normalizeProfile(input, availableIds) {
  const available = new Set(availableIds);
  const enabled = Array.isArray(input && input.enabled) ? input.enabled.map(String) : [];
  if (new Set(enabled).size !== enabled.length) throw httpError(400, "Enabled mods must not contain duplicates.");
  const missing = enabled.filter((id) => !available.has(id));
  if (missing.length) throw httpError(400, `Unknown mod project: ${missing.join(", ")}`);
  return { schemaVersion: SCHEMA_VERSION, enabled };
}

function installBuild(buildRoot, currentRoot, previousRoot, runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  if (fs.existsSync(previousRoot)) fs.rmSync(previousRoot, { recursive: true, force: true });
  if (fs.existsSync(currentRoot)) fs.renameSync(currentRoot, previousRoot);
  fs.renameSync(buildRoot, currentRoot);
}

function readOptionalManifest(root) {
  const filePath = path.join(root, "mod-set.json");
  return fs.existsSync(filePath) ? readJson(filePath, "mod runtime manifest") : null;
}

function stripRuntimePatch(patch) {
  return { table: patch.table, key: patch.key, source: patch.source, value: patch.value };
}

function listRelativeFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile()) files.push({ filePath, relativePath: path.relative(root, filePath).replace(/\\/g, "/"), hash: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function activateEnvironment(env, currentRoot) {
  env.CS_MOD_TABLES_DIR = currentRoot;
  const manifest = readOptionalManifest(currentRoot);
  const strings = path.join(currentRoot, "Strings");
  const bundles = path.join(currentRoot, "ClientAssetBundles");
  if (fs.existsSync(strings)) env.CS_MOD_STRINGS_DIR = strings;
  else delete env.CS_MOD_STRINGS_DIR;
  if (fs.existsSync(bundles)) env.CS_MOD_ASSET_BUNDLES_DIR = bundles;
  else delete env.CS_MOD_ASSET_BUNDLES_DIR;
  if (manifest && Array.isArray(manifest.unitIds) && manifest.unitIds.length) env.CS_MOD_UNIT_IDS = manifest.unitIds.join(",");
  else delete env.CS_MOD_UNIT_IDS;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function tableKey(table) {
  return `${String(table.directory || "").replace(/\\/g, "/").toLowerCase()}/${String(table.fileName || "").replace(/\.(json|luac|lua|bytes)$/i, "").toLowerCase()}`;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${crypto.randomBytes(5).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (err) { throw httpError(422, `${label} is invalid JSON: ${err.message}`); }
}

function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = { SCHEMA_VERSION, activateInstalledModRuntime, buildLua, createModRuntime };
