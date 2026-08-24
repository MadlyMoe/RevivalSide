const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../../combat-handler/csharpHost");
const {
  findCounterSideManagedDir,
  findCounterSideScriptBundleRoots,
  normalizeManagedDir,
} = require("../counterside-install");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_GAMEPLAY_TABLE_ROOT = path.join(ROOT_DIR, "gameplay-jsons");
const DEFAULT_GAMEPLAY_LUA_CACHE_ROOT = path.join(ROOT_DIR, ".cache", "gameplay-luac");
const LUA_CACHE_SCHEMA_VERSION = 2;
const DEFAULT_GAMEPLAY_TABLE_HOST_RESPONSE_BUFFER_BYTES = 256 * 1024 * 1024;
const LUA_CACHE_MANIFEST_NAME = ".revivalside-gameplay-luac-cache.json";
const TABLE_ROOT_NAMES = new Set(["assetbundles", "streamingassets"]);
const DEFAULT_REQUIRED_LUA = {
  directory: "ab_script",
  fileName: "LUA_STAGE_TEMPLET.luac",
};

const luaCacheAttempts = new Map();
const gameplayTableCache = new Map();
let gameplayTableHost = null;
let gameplayTableHostKey = "";

function getGameplayTableRoots(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  const roots = collectGameplayRootValues(options, env);
  const baseRoots = roots.length ? roots : [path.join(rootDir, "gameplay-jsons")];
  return expandTableRoots([...parsePathList(env.CS_MOD_TABLES_DIR), ...baseRoots], rootDir);
}

function getGameplayTableFileCandidates(directory, fileName, options = {}) {
  const jsonFileName = normalizeJsonTableFileName(fileName);
  const luacFileName = normalizeLuacTableFileName(fileName);
  return getGameplayTableRoots(options).flatMap((root) => {
    const dir = path.join(root, directory, "luac");
    return jsonFileName === luacFileName
      ? [path.join(dir, jsonFileName)]
      : [path.join(dir, jsonFileName), path.join(dir, luacFileName)];
  });
}

function findGameplayTableFile(directory, fileName, options = {}) {
  const candidates = getGameplayTableFileCandidates(directory, fileName, options);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || "";
}

function listGameplayTableFiles(options = {}) {
  const entries = new Map();
  for (const root of getGameplayTableRoots(options)) {
    for (const filePath of listTableFiles(root)) {
      const parsed = parseGameplayTableFilePath(root, filePath);
      if (!parsed) continue;
      const key = `${parsed.directory.toLowerCase()}/${normalizeTableBaseName(parsed.fileName).toLowerCase()}`;
      const existing = entries.get(key);
      if (!existing || tableFilePreference(parsed) > tableFilePreference(existing)) entries.set(key, parsed);
    }
  }
  return Array.from(entries.values()).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function findGameplayTableEntry(directory, fileName, options = {}) {
  const tableName = normalizeTableBaseName(fileName).toLowerCase();
  return listGameplayTableFiles(options).find((entry) => entry.directory === directory && entry.tableName.toLowerCase() === tableName);
}

function readGameplayTable(directory, fileName, options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  const cacheKey = buildGameplayTableCacheKey(rootDir, env, directory, fileName, options);
  if (!options.noCache && gameplayTableCache.has(cacheKey)) return gameplayTableCache.get(cacheKey);

  const parsedJson = readGameplayJsonTable(directory, fileName, { ...options, rootDir, env });
  if (parsedJson) {
    if (!options.noCache) gameplayTableCache.set(cacheKey, parsedJson);
    return parsedJson;
  }

  const parsedLuac = readGameplayLuacTable(directory, fileName, { ...options, rootDir, env });
  if (parsedLuac) {
    if (!options.noCache) gameplayTableCache.set(cacheKey, parsedLuac);
    return parsedLuac;
  }

  if (!options.noCache) gameplayTableCache.set(cacheKey, null);
  return null;
}

function readGameplayTableRecords(directory, fileName, options = {}) {
  return extractTableRecords(readGameplayTable(directory, fileName, options));
}

function readGameplayJsonTable(directory, fileName, options = {}) {
  const label = options.logLabel || "gameplay-jsons";
  const jsonFileName = normalizeJsonTableFileName(fileName);
  for (const root of getGameplayTableRoots(options)) {
    const filePath = path.join(root, directory, "luac", jsonFileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch (err) {
      console.log(`[${label}] failed to load ${filePath}: ${err.message}`);
    }
  }
  return null;
}

function readGameplayLuacTable(directory, fileName, options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  if (gameplayAssetSourceMode(options, env) === "packaged" && !options.allowLuacWhenPackaged && !env.CS_GAMEPLAY_TABLES_DIR) {
    return null;
  }

  const label = options.logLabel || "gameplay-luac";
  const managedDir = normalizeManagedDir(
    options.managedDir || env.CS_COUNTERSIDE_MANAGED_DIR || env.COUNTERSIDE_MANAGED_DIR || env.CS_COUNTERSIDE_DIR || findCounterSideManagedDir({ env })
  );
  if (!managedDir || !fs.existsSync(path.join(managedDir, "Assembly-CSharp.dll"))) {
    if (options.verbose) console.log(`[${label}] CounterSide Data\\Managed was not found`);
    return null;
  }

  const gameplayTablesDir = getDefaultGameplayTablesDir({
    rootDir,
    env,
    managedDir,
    logLabel: label,
  });
  if (!gameplayTablesDir || !hasCachedLua(gameplayTablesDir, { directory, fileName: normalizeLuacTableFileName(fileName) })) {
    if (options.verbose) console.log(`[${label}] ${directory}\\luac\\${normalizeLuacTableFileName(fileName)} was not found`);
    return null;
  }

  const luacPath = path.join(gameplayTablesDir, directory, "luac", normalizeLuacTableFileName(fileName));
  const sidecar = readGameplayJsonSidecar(luacPath);
  if (sidecar) return sidecar;

  const host = getGameplayTableHost({ rootDir, env, managedDir, gameplayTablesDir, options });
  const response = host.request("exportLuaTable", {
    directory,
    fileName,
    rootName: options.rootName || "",
  });
  if (!response.ok) {
    if (!options.optional) {
      console.log(`[${label}] failed to load ${directory}\\luac\\${normalizeLuacTableFileName(fileName)}: ${response.error || "managed host failed"}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(response.tableJson || "null");
    if (parsed && typeof parsed === "object") {
      writeGameplayJsonSidecar(luacPath, fileName, response.tableJson);
    }
    return parsed;
  } catch (err) {
    console.log(`[${label}] failed to parse managed table ${directory}\\luac\\${normalizeLuacTableFileName(fileName)}: ${err.message}`);
    return null;
  }
}

function readGameplayJsonSidecar(luacPath) {
  const sidecar = path.join(path.dirname(luacPath), `${path.basename(luacPath, path.extname(luacPath))}.json`);
  if (!fs.existsSync(sidecar)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeGameplayJsonSidecar(luacPath, fileName, tableJson) {
  const destination = path.join(path.dirname(luacPath), path.basename(normalizeJsonTableFileName(fileName)));
  if (fs.existsSync(destination)) return destination;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${String(tableJson || "").trim()}\n`, "utf8");
    try {
      fs.renameSync(temporary, destination);
    } catch (err) {
      if (!fs.existsSync(destination)) throw err;
    }
    return destination;
  } catch {
    return "";
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

function closeGameplayTableHost() {
  const host = gameplayTableHost;
  gameplayTableHost = null;
  gameplayTableHostKey = "";
  return host ? host.close() : Promise.resolve();
}

function getGameplayTableHost({ rootDir, env, managedDir, gameplayTablesDir, options = {} }) {
  const projectPath = env.CS_CSHARP_COMBAT_HOST_PROJECT || path.join(rootDir, "combat-host", "CombatHost.csproj");
  const dllPath = env.CS_GAMEPLAY_TABLE_HOST_PATH || env.CS_CSHARP_COMBAT_HOST_DLL || env.CS_COMBAT_HOST_PATH || "";
  const dotnetPath = env.CS_CSHARP_COMBAT_HOST_DOTNET || env.CS_DOTNET_PATH || undefined;
  const timeoutMs = Number(env.CS_GAMEPLAY_TABLE_HOST_TIMEOUT_MS || env.CS_CSHARP_COMBAT_HOST_TIMEOUT_MS || options.timeoutMs || 60000);
  const responseBufferBytes = Number(
    env.CS_GAMEPLAY_TABLE_RESPONSE_BUFFER_BYTES || options.responseBufferBytes || DEFAULT_GAMEPLAY_TABLE_HOST_RESPONSE_BUFFER_BYTES
  );
  const key = [
    path.normalize(projectPath).toLowerCase(),
    path.normalize(dllPath || "").toLowerCase(),
    path.normalize(managedDir || "").toLowerCase(),
    path.normalize(gameplayTablesDir || "").toLowerCase(),
    dotnetPath || "",
    timeoutMs,
    responseBufferBytes,
  ].join("|");
  if (gameplayTableHost && gameplayTableHostKey === key) return gameplayTableHost;
  gameplayTableHost = createCsharpCombatHost({
    enabled: true,
    projectPath,
    dllPath,
    managedDir,
    gameplayTablesDir,
    dotnetPath,
    timeoutMs,
    responseBufferBytes,
  });
  gameplayTableHostKey = key;
  return gameplayTableHost;
}

function getDefaultGameplayTablesDir(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  if (env.CS_GAMEPLAY_TABLES_DIR) return path.resolve(rootDir, env.CS_GAMEPLAY_TABLES_DIR);

  if (gameplayAssetSourceMode(options, env) !== "packaged") {
    const cacheRoot = ensureGameplayLuaCache({
      rootDir,
      env,
      managedDir: options.managedDir,
      optional: true,
      logLabel: options.logLabel,
    });
    if (cacheRoot) return cacheRoot;
  }

  return path.join(rootDir, "gameplay-jsons");
}

function ensureGameplayLuaCache(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  if (env.CS_GAMEPLAY_ASSET_CACHE === "0" || env.CS_GAMEPLAY_LUA_CACHE === "0") {
    return handleCacheFailure(options, "installed gameplay asset cache is disabled");
  }

  const cacheRoot = getGameplayLuaCacheRoot({ rootDir, env, cacheRoot: options.cacheRoot });
  const managedDir = normalizeManagedDir(
    options.managedDir || env.CS_COUNTERSIDE_MANAGED_DIR || env.COUNTERSIDE_MANAGED_DIR || env.CS_COUNTERSIDE_DIR || findCounterSideManagedDir({ env })
  );
  const scriptRoots = findCounterSideScriptBundleRoots({ env, managedDir });
  if (!scriptRoots.length) {
    return handleCacheFailure(options, "no installed CounterSide ab_script bundles were found from Data\\Managed");
  }

  const inventory = buildScriptRootInventory(scriptRoots);
  const manifestPath = path.join(cacheRoot, LUA_CACHE_MANIFEST_NAME);
  const requiredLua = options.requiredLua || DEFAULT_REQUIRED_LUA;
  const attemptKey = `${path.normalize(rootDir).toLowerCase()}|${path.normalize(cacheRoot).toLowerCase()}|${path.normalize(managedDir).toLowerCase()}`;
  const previousAttempt = luaCacheAttempts.get(attemptKey);
  if (!options.force && previousAttempt && previousAttempt.ok && hasCachedLua(cacheRoot, requiredLua)) return cacheRoot;
  if (!options.force && isLuaCacheFresh(manifestPath, { managedDir, inventory, requiredLua })) {
    luaCacheAttempts.set(attemptKey, { ok: true });
    return cacheRoot;
  }
  if (!options.force && previousAttempt && previousAttempt.error && options.optional) return "";

  try {
    buildGameplayLuaCache({
      rootDir,
      env,
      cacheRoot,
      managedDir,
      scriptRoots,
      inventory,
      requiredLua,
      quiet: options.quiet,
      logLabel: options.logLabel,
      progress: options.progress,
    });
    luaCacheAttempts.set(attemptKey, { ok: true });
    return cacheRoot;
  } catch (err) {
    luaCacheAttempts.set(attemptKey, { ok: false, error: err.message });
    return handleCacheFailure(options, err.message);
  }
}

function buildGameplayLuaCache(options) {
  const {
    rootDir,
    env,
    cacheRoot,
    managedDir,
    scriptRoots,
    inventory,
    requiredLua,
    quiet,
    logLabel = "gameplay-assets",
    progress,
  } = options;
  const decryptScript = path.join(rootDir, "tools", "cs_asset_decrypt.py");
  if (!fs.existsSync(decryptScript)) throw new Error(`missing gameplay asset tool: ${decryptScript}`);

  logCache(quiet, `[${logLabel}] extracting installed encrypted script assets from ${managedDir}`);
  cleanupStaleGameplayCacheSiblings(cacheRoot);
  const buildRoot = createGameplayCacheBuildRoot(cacheRoot);
  const totalBundles = inventory.reduce((sum, entry) => sum + (Array.isArray(entry.files) ? entry.files.length : 0), 0);
  let processedBundles = 0;
  let installed = false;

  try {
    fs.mkdirSync(path.join(buildRoot, "manifests"), { recursive: true });
    emitCacheProgress(progress, {
      phase: "prepare",
      current: 0,
      total: totalBundles,
      message: "Preparing gameplay asset cache",
    });

    for (let index = 0; index < scriptRoots.length; index += 1) {
      const source = scriptRoots[index];
      const sourceInventory = inventory.find(
        (entry) =>
          entry.label === source.label &&
          path.normalize(entry.root || "").toLowerCase() === path.normalize(source.root || "").toLowerCase()
      );
      const files = sourceInventory && Array.isArray(sourceInventory.files) ? sourceInventory.files : listScriptBundleFiles(source.root);
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        const fileName = file.name || "";
        emitCacheProgress(progress, {
          phase: "extract",
          current: processedBundles,
          total: totalBundles,
          message: `Extracting ${fileName || "script bundle"}`,
        });
        runPython(
          [
            decryptScript,
            "dump-scripts",
            "--root",
            source.root,
            "--out-dir",
            path.join(buildRoot, source.label),
            "--manifest",
            path.join(buildRoot, "manifests", `dump-${index + 1}-${safeCacheName(source.label)}-${fileIndex + 1}.json`),
            "--pattern",
            fileName,
            "--overwrite",
          ],
          { rootDir, env, quiet }
        );
        processedBundles += 1;
        emitCacheProgress(progress, {
          phase: "extract",
          current: processedBundles,
          total: totalBundles,
          message: `Extracted ${fileName || "script bundle"}`,
        });
      }
    }

    if (!hasCachedLua(buildRoot, requiredLua)) {
      throw new Error(`installed gameplay asset cache did not produce ${requiredLua.directory}\\luac\\${requiredLua.fileName}`);
    }

    const luacCount = countFiles(buildRoot, /\.luac$/i);
    fs.writeFileSync(
      path.join(buildRoot, LUA_CACHE_MANIFEST_NAME),
      `${JSON.stringify(
        {
          version: LUA_CACHE_SCHEMA_VERSION,
          generatedAt: new Date().toISOString(),
          managedDir,
          scriptRoots: inventory,
          luacCount,
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    emitCacheProgress(progress, {
      phase: "install",
      current: totalBundles,
      total: totalBundles,
      message: "Installing gameplay asset cache",
    });
    installGameplayCacheBuildRoot(buildRoot, cacheRoot);
    installed = true;
    logCache(quiet, `[${logLabel}] installed encrypted asset cache ready: ${luacCount} Lua bytecode files at ${cacheRoot}`);
    emitCacheProgress(progress, {
      phase: "complete",
      current: totalBundles,
      total: totalBundles,
      message: `${luacCount} Lua bytecode files ready`,
    });
  } finally {
    if (!installed) removePathWithRetries(buildRoot, { bestEffort: true });
  }
}

function runPython(args, options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const env = options.env || process.env;
  const configured = parsePathList(env.CS_PYTHON_PATH || env.PYTHON || "");
  const commands = uniquePaths([...configured, process.platform === "win32" ? "py" : "", "python", "python3"].filter(Boolean));
  const failures = [];
  for (const command of commands) {
    const finalArgs = path.basename(command).toLowerCase() === "py" ? ["-3", ...args] : args;
    const result = spawnSync(command, finalArgs, {
      cwd: rootDir,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
    if ((result.error && result.error.code === "ENOENT") || isPythonNotFoundResult(result, output)) {
      failures.push(`${command}: not found`);
      continue;
    }
    if (result.status === 0) {
      if (!options.quiet) {
        if (output) console.log(output);
      }
      return;
    }
    throw new Error(`${command} ${finalArgs.map(quoteArg).join(" ")} failed${result.status == null ? "" : ` (${result.status})`}${output ? `: ${output}` : ""}`);
  }
  throw new Error(`Python was not found (${failures.join("; ")})`);
}

function isPythonNotFoundResult(result, output) {
  if (process.platform !== "win32") return false;
  if (result.status !== 9009) return false;
  return /python was not found|microsoft store|app execution aliases/i.test(output || "");
}

function isLuaCacheFresh(manifestPath, expected) {
  if (!fs.existsSync(manifestPath)) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_) {
    return false;
  }
  if (!parsed || parsed.version !== LUA_CACHE_SCHEMA_VERSION) return false;
  const inventorySignature = (inventory) => JSON.stringify((inventory || []).map(({ label, files }) => ({ label, files })));
  if (inventorySignature(parsed.scriptRoots) !== inventorySignature(expected.inventory)) return false;
  if (!hasCachedLua(path.dirname(manifestPath), expected.requiredLua || DEFAULT_REQUIRED_LUA)) return false;
  if (path.normalize(parsed.managedDir || "").toLowerCase() !== path.normalize(expected.managedDir || "").toLowerCase()
      || JSON.stringify(parsed.scriptRoots || []) !== JSON.stringify(expected.inventory)) {
    parsed.managedDir = expected.managedDir;
    parsed.scriptRoots = expected.inventory;
    fs.writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return true;
}

function buildScriptRootInventory(scriptRoots) {
  return scriptRoots.map((scriptRoot) => ({
    label: scriptRoot.label,
    root: scriptRoot.root,
    files: listScriptBundleFiles(scriptRoot.root),
  }));
}

function listScriptBundleFiles(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^ab_script/i.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(root, entry.name);
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (_) {
    return [];
  }
}

function hasCachedLua(cacheRoot, lua = DEFAULT_REQUIRED_LUA) {
  for (const root of expandTableRoots([cacheRoot], path.dirname(cacheRoot))) {
    if (fs.existsSync(path.join(root, lua.directory, "luac", lua.fileName))) return true;
  }
  return false;
}

function getGameplayLuaCacheRoot(options = {}) {
  const rootDir = path.resolve(options.rootDir || ROOT_DIR);
  const env = options.env || process.env;
  return path.resolve(rootDir, options.cacheRoot || env.CS_GAMEPLAY_LUA_CACHE_DIR || env.CS_GAMEPLAY_ASSET_CACHE_DIR || DEFAULT_GAMEPLAY_LUA_CACHE_ROOT);
}

function createGameplayCacheBuildRoot(cacheRoot) {
  const parent = path.dirname(cacheRoot);
  const baseName = path.basename(cacheRoot);
  fs.mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = path.join(parent, `.${baseName}.tmp-${process.pid}-${Date.now()}-${attempt}`);
    if (fs.existsSync(candidate)) continue;
    fs.mkdirSync(candidate, { recursive: true });
    return candidate;
  }
  throw new Error(`could not create temporary gameplay asset cache under ${parent}`);
}

function installGameplayCacheBuildRoot(buildRoot, cacheRoot) {
  const parent = path.dirname(cacheRoot);
  const baseName = path.basename(cacheRoot);
  const backupRoot = fs.existsSync(cacheRoot)
    ? path.join(parent, `.${baseName}.old-${process.pid}-${Date.now()}`)
    : "";
  let backupCreated = false;
  let buildInstalled = false;
  try {
    if (backupRoot) {
      renamePathWithRetries(cacheRoot, backupRoot);
      backupCreated = true;
    }
    renamePathWithRetries(buildRoot, cacheRoot);
    buildInstalled = true;
  } catch (err) {
    if (!buildInstalled && fs.existsSync(buildRoot)) removePathWithRetries(buildRoot, { bestEffort: true });
    if (backupCreated && !fs.existsSync(cacheRoot) && fs.existsSync(backupRoot)) {
      try {
        renamePathWithRetries(backupRoot, cacheRoot);
      } catch (_) {
        // Keep the backup in place rather than hiding the original swap failure.
      }
    }
    throw err;
  }
  if (backupCreated) removePathWithRetries(backupRoot, { bestEffort: true });
}

function cleanupStaleGameplayCacheSiblings(cacheRoot) {
  const parent = path.dirname(cacheRoot);
  const baseName = path.basename(cacheRoot);
  if (!fs.existsSync(parent)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(`.${baseName}.tmp-`) && !entry.name.startsWith(`.${baseName}.old-`)) continue;
    removePathWithRetries(path.join(parent, entry.name), { bestEffort: true, attempts: 2 });
  }
}

function renamePathWithRetries(from, to, attempts = 8) {
  withFileSystemRetries(() => fs.renameSync(from, to), `rename ${from} -> ${to}`, attempts);
}

function removePathWithRetries(target, options = {}) {
  const attempts = options.attempts || 8;
  try {
    withFileSystemRetries(() => fs.rmSync(target, { recursive: true, force: true }), `remove ${target}`, attempts);
  } catch (err) {
    if (options.bestEffort) return false;
    throw err;
  }
  return true;
}

function withFileSystemRetries(action, label, attempts = 8) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return action();
    } catch (err) {
      lastError = err;
      const retryable = ["EBUSY", "ENOTEMPTY", "EPERM", "EACCES"].includes(err && err.code);
      if (!retryable || attempt + 1 >= attempts) break;
      sleepSync(Math.min(1000, 50 * (attempt + 1) * (attempt + 1)));
    }
  }
  const detail = lastError && lastError.message ? lastError.message : String(lastError);
  throw new Error(`${label} failed after ${attempts} attempts: ${detail}`);
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function gameplayAssetSourceMode(options = {}, env = process.env) {
  const value = String(options.source || env.CS_GAMEPLAY_ASSET_SOURCE || env.CS_GAMEPLAY_TABLE_SOURCE || "auto").trim().toLowerCase();
  if (["packaged", "repo", "checked-in", "checkedin"].includes(value)) return "packaged";
  return "auto";
}

function handleCacheFailure(options, message) {
  if (options.optional) {
    const label = options.logLabel || "gameplay-assets";
    if (options.verbose) console.log(`[${label}] ${message}`);
    return "";
  }
  throw new Error(message);
}

function buildGameplayTableCacheKey(rootDir, env, directory, fileName, options = {}) {
  const explicitRoots = collectGameplayRootValues(options, env).join(";");
  const managedDir = normalizeManagedDir(
    options.managedDir || env.CS_COUNTERSIDE_MANAGED_DIR || env.COUNTERSIDE_MANAGED_DIR || env.CS_COUNTERSIDE_DIR || findCounterSideManagedDir({ env })
  );
  return [
    path.normalize(rootDir).toLowerCase(),
    String(env.CS_MOD_TABLES_DIR || ""),
    String(explicitRoots || ""),
    String(env.CS_GAMEPLAY_TABLES_DIR || ""),
    String(env.CS_GAMEPLAY_ASSET_SOURCE || env.CS_GAMEPLAY_TABLE_SOURCE || ""),
    path.normalize(managedDir || "").toLowerCase(),
    String(directory || "").toLowerCase(),
    normalizeJsonTableFileName(fileName).toLowerCase(),
    String(options.rootName || ""),
  ].join("|");
}

function collectGameplayRootValues(options = {}, env = process.env) {
  return uniquePaths([
    ...parsePathList(options.explicitRoots),
    ...parsePathList(options.explicitEnvName ? env[options.explicitEnvName] : ""),
    ...parsePathList(env.CS_GAMEPLAY_JSON_ROOTS),
    ...parsePathList(env.CS_GAMEPLAY_TABLE_ROOTS),
    ...parsePathList(env.CS_GAMEPLAY_TABLES_DIR),
  ]);
}

function normalizeJsonTableFileName(fileName) {
  return normalizeTableBaseName(fileName) + ".json";
}

function normalizeLuacTableFileName(fileName) {
  return normalizeTableBaseName(fileName) + ".luac";
}

function normalizeTableBaseName(fileName) {
  let value = path.basename(String(fileName || "").replace(/\\/g, "/"));
  while (/\.(json|luac|lua|bytes)$/i.test(value)) value = value.replace(/\.(json|luac|lua|bytes)$/i, "");
  return value;
}

function extractTableRecords(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed.records)) return parsed.records;
  if (Array.isArray(parsed.root)) return parsed.root;
  if (parsed.root && typeof parsed.root === "object") {
    return Object.entries(parsed.root)
      .map(([key, entry]) => Array.isArray(entry)
        ? { __key: key, values: entry }
        : entry && typeof entry === "object"
          ? { __key: key, ...entry }
          : { __key: key, value: entry });
  }
  return [];
}

function listTableFiles(root) {
  if (!root || !fs.existsSync(root)) return [];
  const result = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && /\.(json|luac)$/i.test(entry.name)) result.push(filePath);
    }
  }
  return result;
}

function parseGameplayTableFilePath(root, filePath) {
  const relativeParts = path.relative(root, filePath).split(/[\\/]+/).filter(Boolean);
  const luacIndex = relativeParts.findIndex((part) => part.toLowerCase() === "luac");
  if (luacIndex <= 0 || luacIndex >= relativeParts.length - 1) return null;
  const fileName = relativeParts[relativeParts.length - 1];
  const extension = path.extname(fileName).toLowerCase();
  if (extension !== ".json" && extension !== ".luac") return null;
  const directory = relativeParts.slice(0, luacIndex).join("/");
  const relativePath = [...relativeParts.slice(0, luacIndex), "luac", fileName].join("/");
  return {
    root,
    filePath,
    directory,
    fileName,
    relativePath,
    extension,
    tableName: normalizeTableBaseName(fileName),
  };
}

function tableFilePreference(entry) {
  return entry && entry.extension === ".json" ? 2 : 1;
}

function expandTableRoots(roots, rootDir = ROOT_DIR) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const resolved = path.resolve(rootDir, root);
    const basename = path.basename(resolved).toLowerCase();
    const candidates = TABLE_ROOT_NAMES.has(basename)
      ? [resolved]
      : [path.join(resolved, "Assetbundles"), path.join(resolved, "StreamingAssets")];
    for (const candidate of candidates) {
      const key = path.normalize(candidate).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

function parsePathList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return raw
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function countFiles(root, pattern) {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && pattern.test(entry.name)) count += 1;
    }
  }
  return count;
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = path.normalize(String(value)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text}"` : text;
}

function logCache(quiet, message) {
  if (!quiet) console.log(message);
}

function emitCacheProgress(progress, event) {
  if (typeof progress !== "function") return;
  progress({
    ...event,
    current: Math.max(0, Number(event.current) || 0),
    total: Math.max(0, Number(event.total) || 0),
    generatedAt: new Date().toISOString(),
  });
}

function safeCacheName(value) {
  return String(value || "cache")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "cache";
}

module.exports = {
  DEFAULT_GAMEPLAY_LUA_CACHE_ROOT,
  DEFAULT_GAMEPLAY_TABLE_ROOT,
  LUA_CACHE_MANIFEST_NAME,
  closeGameplayTableHost,
  ensureGameplayLuaCache,
  expandTableRoots,
  extractTableRecords,
  findGameplayTableEntry,
  findGameplayTableFile,
  getDefaultGameplayTablesDir,
  getGameplayLuaCacheRoot,
  getGameplayTableFileCandidates,
  getGameplayTableRoots,
  listGameplayTableFiles,
  normalizeTableBaseName,
  parsePathList,
  readGameplayJsonSidecar,
  readGameplayTable,
  readGameplayTableRecords,
  writeGameplayJsonSidecar,
};
