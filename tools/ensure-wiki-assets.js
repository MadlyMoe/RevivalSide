const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  findCounterSideDataDir,
  findCounterSideManagedDir,
  normalizeManagedDir,
} = require("../modules/counterside-install");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, ".cache", "wiki-assets");
const DEFAULT_ASSETS_JSON = path.join(ROOT_DIR, "wiki", "data", "assets.json");
const MANIFEST_NAME = ".revivalside-wiki-assets-cache.json";
const PNG_ROUTE_PREFIX = "/asset-png/";
const EXTRACTED_TYPE_DIRS = new Set(["Texture2D", "Sprite", "CutsceneBG16x9"]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const managedDir = normalizeManagedDir(
    args.managedDir || env.CS_COUNTERSIDE_MANAGED_DIR || env.COUNTERSIDE_MANAGED_DIR || env.CS_COUNTERSIDE_DIR || findCounterSideManagedDir({ env })
  );
  if (!managedDir || !fs.existsSync(path.join(managedDir, "Assembly-CSharp.dll"))) {
    throw new Error("CounterSide Data\\Managed\\Assembly-CSharp.dll was not found");
  }

  const dataDir = findCounterSideDataDir({ managedDir });
  if (!dataDir) throw new Error(`CounterSide Data directory was not found from ${managedDir}`);
  const gameRoot = path.dirname(dataDir);
  const assetsJson = path.resolve(ROOT_DIR, args.assetsJson || env.CS_WIKI_ASSETS_JSON || DEFAULT_ASSETS_JSON);
  if (!fs.existsSync(assetsJson)) throw new Error(`wiki assets.json was not found: ${assetsJson}`);

  const cacheRoot = path.resolve(ROOT_DIR, args.cacheDir || env.CS_WIKI_ASSET_CACHE_DIR || DEFAULT_CACHE_ROOT);
  const finalRoot = path.join(cacheRoot, "all");
  const requests = collectWikiAssetRequests(assetsJson, { gameRoot, dataDir });
  if (!requests.length) throw new Error(`no ${PNG_ROUTE_PREFIX} image URLs were found in ${assetsJson}`);
  if (args.assetUrl) {
    const outputRel = decodeAssetRoute(args.assetUrl);
    const request = requests.find((item) => item.outputRel === outputRel);
    if (!request) throw new Error(`unknown wiki image URL: ${args.assetUrl}`);
    buildWikiAssetBundle({ args, cacheRoot, finalRoot, requests, request });
    return;
  }
  const inventory = buildInventory(requests, { assetsJson, managedDir });

  if (!args.force && isCacheFresh(cacheRoot, finalRoot, inventory, requests)) {
    log(args, `[wiki-assets] cache ready: ${countFiles(finalRoot, /\.png$/i)} PNGs at ${finalRoot}`);
    return;
  }

  buildWikiAssetCache({
    args,
    cacheRoot,
    finalRoot,
    requests,
    inventory,
    gameRoot,
    dataDir,
  });
}

function collectWikiAssetRequests(assetsJson, roots) {
  const urls = new Set();
  for (const payload of readWikiDataFiles(assetsJson)) {
    walkValues(payload, (value) => {
      if (typeof value === "string" && value.startsWith(PNG_ROUTE_PREFIX)) urls.add(value);
    });
  }

  const byOutputRel = new Map();
  for (const url of urls) {
    const outputRel = decodeAssetRoute(url);
    const bundleRel = bundleRelFromOutputRel(outputRel);
    if (!bundleRel) continue;
    const source = resolveInstalledBundle(bundleRel, roots);
    if (!source || !fs.existsSync(source)) continue;
    if (!byOutputRel.has(outputRel)) {
      byOutputRel.set(outputRel, {
        url,
        outputRel,
        bundleRel,
        source,
        sourceRoot: sourceRootForBundleRel(bundleRel, roots),
      });
    }
  }
  return [...byOutputRel.values()].sort((left, right) => left.outputRel.localeCompare(right.outputRel));
}

function readWikiDataFiles(assetsJson) {
  const dataRoot = path.dirname(assetsJson);
  const manifest = JSON.parse(fs.readFileSync(assetsJson, "utf8"));
  const payloads = [manifest];
  for (const file of Object.values(manifest.sections || {})) {
    const target = path.resolve(dataRoot, String(file));
    if (!target.startsWith(`${dataRoot}${path.sep}`)) throw new Error(`wiki section escaped data root: ${file}`);
    payloads.push(JSON.parse(fs.readFileSync(target, "utf8")));
  }
  return payloads;
}

function buildWikiAssetBundle({ args, cacheRoot, finalRoot, requests, request }) {
  const bundleRequests = requests.filter((item) => item.bundleRel === request.bundleRel);
  if (bundleRequests.every((item) => fs.existsSync(path.join(finalRoot, item.outputRel)))) return;

  const decryptScript = path.join(ROOT_DIR, "tools", "cs_asset_decrypt.py");
  const extractScript = path.join(ROOT_DIR, "tools", "cs_extract_decrypted_assets.py");
  if (!fs.existsSync(decryptScript)) throw new Error(`missing asset decrypt helper: ${decryptScript}`);
  if (!fs.existsSync(extractScript)) throw new Error(`missing asset extract helper: ${extractScript}`);

  fs.mkdirSync(path.dirname(cacheRoot), { recursive: true });
  const workRoot = fs.mkdtempSync(path.join(path.dirname(cacheRoot), ".wiki-bundle-"));
  const decryptedRoot = path.join(workRoot, "decrypted");
  const extractedRoot = path.join(workRoot, "extracted");
  const groupLabel = safeLabel(path.basename(request.sourceRoot) || "assets");
  const decryptedOut = path.join(decryptedRoot, groupLabel);
  const extractedOut = path.join(extractedRoot, groupLabel);
  try {
    fs.mkdirSync(decryptedRoot, { recursive: true });
    fs.mkdirSync(extractedRoot, { recursive: true });
    runPython([
      decryptScript,
      "decrypt-header",
      request.source,
      "--root",
      request.sourceRoot,
      "--out-dir",
      decryptedOut,
      "--overwrite",
    ], args);
    runPython([
      extractScript,
      "--root",
      decryptedOut,
      "--out-dir",
      extractedOut,
      "--pattern",
      "*.asset.dec",
      "--types",
      "Texture2D,Sprite",
      "--type-tree",
      "none",
      "--overwrite-manifest",
    ], args);

    const extractedRoots = listExtractedRoots(extractedRoot);
    let copied = 0;
    for (const item of bundleRequests) {
      const source = findExtractedOutput(extractedRoots, item.outputRel);
      if (!source) continue;
      const target = path.join(finalRoot, item.outputRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied += 1;
    }
    if (!fs.existsSync(path.join(finalRoot, request.outputRel))) {
      throw new Error(`wiki image was not extracted: ${request.outputRel}`);
    }
    log(args, `[wiki-assets] cached ${copied} image(s) from ${request.bundleRel}`);
  } finally {
    removePathWithRetries(workRoot, { bestEffort: true });
  }
}

function buildWikiAssetCache({ args, cacheRoot, finalRoot, requests, inventory, gameRoot, dataDir }) {
  const decryptScript = path.join(ROOT_DIR, "tools", "cs_asset_decrypt.py");
  const extractScript = path.join(ROOT_DIR, "tools", "cs_extract_decrypted_assets.py");
  if (!fs.existsSync(decryptScript)) throw new Error(`missing asset decrypt helper: ${decryptScript}`);
  if (!fs.existsSync(extractScript)) throw new Error(`missing asset extract helper: ${extractScript}`);

  cleanupStaleCacheSiblings(cacheRoot);
  const buildRoot = createBuildRoot(cacheRoot);
  const workRoot = path.join(buildRoot, "work");
  const decryptedRoot = path.join(workRoot, "decrypted");
  const extractedRoot = path.join(workRoot, "extracted");
  const buildFinalRoot = path.join(buildRoot, "all");
  let installed = false;

  try {
    fs.mkdirSync(decryptedRoot, { recursive: true });
    fs.mkdirSync(extractedRoot, { recursive: true });
    fs.mkdirSync(buildFinalRoot, { recursive: true });

    const bundles = uniqueBundles(requests, args.limitBundles);
    log(args, `[wiki-assets] extracting ${bundles.length} installed image bundle(s) for ${requests.length} wiki image URL(s)`);

    for (const group of groupBundlesByRoot(bundles, { gameRoot, dataDir })) {
      const decryptOut = path.join(decryptedRoot, group.label);
      const extractOut = path.join(extractedRoot, group.label);
      runPython(
        [
          decryptScript,
          "decrypt-header",
          ...group.bundles.map((item) => item.source),
          "--root",
          group.sourceRoot,
          "--out-dir",
          decryptOut,
          "--overwrite",
        ],
        args
      );
      runPython(
        [
          extractScript,
          "--root",
          decryptOut,
          "--out-dir",
          extractOut,
          "--pattern",
          "*.asset.dec",
          "--types",
          "Texture2D,Sprite",
          "--type-tree",
          "none",
          "--overwrite-manifest",
        ],
        args
      );
      removePathWithRetries(decryptOut);
    }
    removePathWithRetries(decryptedRoot, { bestEffort: true, attempts: 2 });

    const extractedRoots = listExtractedRoots(extractedRoot);
    let copied = 0;
    const missing = [];
    for (const request of requests) {
      const source = findExtractedOutput(extractedRoots, request.outputRel);
      if (!source) {
        missing.push(request.outputRel);
        continue;
      }
      const target = path.join(buildFinalRoot, request.outputRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied += 1;
    }

    if (copied <= 0) {
      throw new Error(`installed wiki asset extraction copied no PNGs; first missing: ${missing[0] || "(none)"}`);
    }

    removePathWithRetries(workRoot);

    const manifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      managedDir: inventory.managedDir,
      assetsJson: inventory.assetsJson,
      bundleCount: bundles.length,
      requestedCount: requests.length,
      copiedCount: copied,
      missingCount: missing.length,
      missing: missing.slice(0, 200),
      bundles: inventory.bundles,
    };
    fs.writeFileSync(path.join(buildRoot, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    installBuildRoot(buildRoot, cacheRoot);
    installed = true;
    log(args, `[wiki-assets] cache ready: ${copied} PNGs at ${finalRoot}${missing.length ? ` (${missing.length} missing)` : ""}`);
  } finally {
    if (!installed) removePathWithRetries(buildRoot, { bestEffort: true });
  }
}

function buildInventory(requests, { assetsJson, managedDir }) {
  const assetsStat = fs.statSync(assetsJson);
  const bundles = uniqueBundles(requests).map((item) => {
    const stat = fs.statSync(item.source);
    return {
      bundleRel: item.bundleRel,
      source: item.source,
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    };
  });
  return {
    managedDir,
    assetsJson: {
      path: assetsJson,
      size: assetsStat.size,
      mtimeMs: Math.trunc(assetsStat.mtimeMs),
    },
    bundles,
  };
}

function isCacheFresh(cacheRoot, finalRoot, expected, requests) {
  const manifestPath = path.join(cacheRoot, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(finalRoot)) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (_) {
    return false;
  }
  if (!parsed || parsed.version !== 1) return false;
  if (path.normalize(parsed.managedDir || "").toLowerCase() !== path.normalize(expected.managedDir || "").toLowerCase()) return false;
  if (JSON.stringify(parsed.assetsJson || {}) !== JSON.stringify(expected.assetsJson)) return false;
  if (JSON.stringify(parsed.bundles || []) !== JSON.stringify(expected.bundles)) return false;
  return requests.every((request) => fs.existsSync(path.join(finalRoot, request.outputRel)));
}

function walkValues(value, visit) {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, visit);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) walkValues(item, visit);
  }
}

function decodeAssetRoute(url) {
  return url
    .slice(PNG_ROUTE_PREFIX.length)
    .split("/")
    .map((part) => decodeURIComponent(part))
    .filter(Boolean)
    .join("/");
}

function bundleRelFromOutputRel(outputRel) {
  const parts = outputRel.split(/[\\/]+/).filter(Boolean);
  const marker = parts.findIndex((part) => EXTRACTED_TYPE_DIRS.has(part));
  if (marker <= 0) return "";
  return parts.slice(0, marker).join("/");
}

function resolveInstalledBundle(bundleRel, roots) {
  const sourceRoot = sourceRootForBundleRel(bundleRel, roots);
  const relative = relativeBundlePath(bundleRel);
  if (!sourceRoot || !relative) return "";
  const raw = path.join(sourceRoot, ...relative.split("/"));
  if (fs.existsSync(raw)) return raw;
  if (fs.existsSync(`${raw}.asset`)) return `${raw}.asset`;
  return raw;
}

function sourceRootForBundleRel(bundleRel, { gameRoot, dataDir }) {
  const normalized = bundleRel.replace(/\\/g, "/");
  if (normalized.toLowerCase().startsWith("data/")) return gameRoot;
  return dataDir;
}

function relativeBundlePath(bundleRel) {
  const normalized = bundleRel.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized;
}

function uniqueBundles(requests, limit = 0) {
  const seen = new Set();
  const result = [];
  for (const request of requests) {
    const key = path.normalize(request.source).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      bundleRel: request.bundleRel,
      source: request.source,
      sourceRoot: request.sourceRoot,
    });
  }
  const max = Number(limit || 0);
  return max > 0 ? result.slice(0, max) : result;
}

function groupBundlesByRoot(bundles) {
  const groups = new Map();
  for (const bundle of bundles) {
    const key = path.normalize(bundle.sourceRoot).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, {
        sourceRoot: bundle.sourceRoot,
        label: safeLabel(path.basename(bundle.sourceRoot) || "assets"),
        bundles: [],
      });
    }
    groups.get(key).bundles.push(bundle);
  }
  return [...groups.values()];
}

function listExtractedRoots(extractedRoot) {
  if (!fs.existsSync(extractedRoot)) return [];
  return fs
    .readdirSync(extractedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extractedRoot, entry.name));
}

function findExtractedOutput(extractedRoots, outputRel) {
  for (const root of extractedRoots) {
    const candidate = path.join(root, outputRel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function runPython(args, options = {}) {
  const configured = parsePathList(process.env.CS_PYTHON_PATH || process.env.PYTHON || "");
  const commands = uniquePaths([...configured, process.platform === "win32" ? "py" : "", "python", "python3"].filter(Boolean));
  const failures = [];
  for (const command of commands) {
    const finalArgs = path.basename(command).toLowerCase() === "py" ? ["-3", ...args] : args;
    const result = spawnSync(command, finalArgs, {
      cwd: ROOT_DIR,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
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

function createBuildRoot(cacheRoot) {
  const parent = path.dirname(cacheRoot);
  const baseName = path.basename(cacheRoot);
  fs.mkdirSync(parent, { recursive: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = path.join(parent, `.${baseName}.tmp-${process.pid}-${Date.now()}-${attempt}`);
    if (fs.existsSync(candidate)) continue;
    fs.mkdirSync(candidate, { recursive: true });
    return candidate;
  }
  throw new Error(`could not create temporary wiki asset cache under ${parent}`);
}

function installBuildRoot(buildRoot, cacheRoot) {
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
        // Preserve the backup and rethrow the original swap failure.
      }
    }
    throw err;
  }
  if (backupCreated) removePathWithRetries(backupRoot, { bestEffort: true });
}

function cleanupStaleCacheSiblings(cacheRoot) {
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

function parsePathList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return raw.map((entry) => String(entry || "").trim()).filter(Boolean);
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

function safeLabel(value) {
  return String(value || "assets").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text}"` : text;
}

function log(args, message) {
  if (!args.quiet) console.log(message);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--managed-dir") args.managedDir = argv[++index];
    else if (arg === "--assets-json") args.assetsJson = argv[++index];
    else if (arg === "--cache-dir") args.cacheDir = argv[++index];
    else if (arg === "--asset-url") args.assetUrl = argv[++index];
    else if (arg === "--limit-bundles") args.limitBundles = Number(argv[++index]);
    else if (arg === "--force") args.force = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log(
    [
      "Usage: node tools/ensure-wiki-assets.js [options]",
      "",
      "Options:",
      "  --managed-dir <dir>   CounterSide Data/Managed directory or Assembly-CSharp.dll path",
      "  --assets-json <path>  wiki data JSON with /asset-png/ image URLs",
      "  --cache-dir <dir>     output cache (default: .cache/wiki-assets)",
      "  --asset-url <url>     cache only the encrypted bundle needed by one wiki image",
      "  --force               rebuild even when the installed asset inventory is unchanged",
      "  --quiet               suppress extractor output",
    ].join("\n")
  );
  process.exit(0);
}

if (require.main === module) main();

module.exports = { bundleRelFromOutputRel, collectWikiAssetRequests, readWikiDataFiles };
