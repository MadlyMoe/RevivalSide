const assert = require("assert");
const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { loadAndroidClientPayloadState, loadFrozenClientPatchState } = require("../modules/frozen-client-update");

const ROOT = path.resolve(__dirname, "..");
const payloadRoot = path.resolve(argument("--android-payload") || path.join(ROOT, "dist", "CounterSide-Android-9.21.3352381-host"));
const luaManifestPath = path.resolve(argument("--lua-manifest") || path.join(ROOT, "prebuilt", "android-lua-cache-9.21.3352381.json"));
const gameplayRoot = path.resolve(argument("--gameplay-tables") || path.join(ROOT, "gameplay-tables"));
const modRoot = path.resolve(argument("--mod-tables") || path.join(ROOT, "mods", ".runtime", "current"));
const contractPath = path.resolve(argument("--contract") || path.join(ROOT, "kmp", "app", "src", "main", "assets", "revivalside-android-client-contract.json"));

const managedDir = findCounterSideManagedDir({ env: process.env });
assert(managedDir, "CounterSide Data/Managed was not found.");
const pc = loadFrozenClientPatchState(managedDir, { gameplayTablesDir: gameplayRoot });
assert(pc, "CounterSide PC patch state was not found.");
const payloadState = loadAndroidClientPayloadState(payloadRoot);
assert(payloadState, `Android payload was not found: ${payloadRoot}`);
const payload = payloadState.manifest;
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const lua = JSON.parse(fs.readFileSync(luaManifestPath, "utf8"));

const pcSuffix = suffix(pc.standaloneVersion);
assert.strictEqual(suffix(payload.patchVersion), pcSuffix, `PC ${pc.standaloneVersion} and Android ${payload.patchVersion} content versions differ.`);
assert.strictEqual(contract.patchVersion, payload.patchVersion, "Android client contract and hosted payload versions differ.");
assert.strictEqual(contract.payloadId, payload.id, "Android client contract and payload IDs differ.");
assert.strictEqual(Number(contract.payloadFileCount), payload.fileCount, "Android client contract and payload file counts differ.");
assert.strictEqual(Number(contract.payloadTotalBytes), payload.totalBytes, "Android client contract and payload byte counts differ.");
assert.strictEqual(
  contract.payloadManifestSha256,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(payloadRoot, "payload-manifest.json"))).digest("hex"),
  "Android client contract payload manifest hash differs."
);
assert.strictEqual(lua.version, `ExtraAsset_${pcSuffix}`, "Android ExtraAsset and PC content versions differ.");

const pcResources = effectiveFiles([
  path.join(pc.dataDir, "StreamingAssets"),
  path.join(pc.rootDir, "Assetbundles"),
]);
for (const metadata of ["csconfigserveraddress.txt", "patchinfo.json", "standalonewindows64", "tutorialdungeonresources.json"]) {
  pcResources.delete(metadata);
}
const androidPrefix = `patchfiles/Android/${payload.patchVersion}/`.toLowerCase();
const androidResources = new Set(payload.files
  .map((entry) => String(entry.path).replace(/\\/g, "/"))
  .filter((entry) => entry.toLowerCase().startsWith(androidPrefix))
  .map((entry) => entry.slice(androidPrefix.length).toLowerCase())
  .filter((entry) => entry !== "patchinfo.json" && entry !== "tutorialdungeonresources.json"));
const missingResources = [...pcResources.keys()].filter((file) => !androidResources.has(file));
assert.deepStrictEqual(missingResources, [], `Android payload is missing PC resources: ${missingResources.slice(0, 20).join(", ")}`);

const effectiveLua = effectiveLuaFiles(gameplayRoot, fs.existsSync(modRoot) ? modRoot : "");
assert(Array.isArray(lua.files) && lua.files.length > 0, "Android Lua cache manifest is empty.");
const androidLua = new Set(lua.files.map((entry) => String(entry.logicalPath || "").toLowerCase()).filter(Boolean));
assert.strictEqual(androidLua.size, lua.files.length, "Android Lua cache has missing or duplicate logicalPath records.");
const missingLua = [...effectiveLua].filter((file) => !androidLua.has(file));
assert.deepStrictEqual(missingLua, [], `Android ExtraAsset is missing effective PC Lua: ${missingLua.slice(0, 20).join(", ")}`);
const luaCheckArgs = [
  path.join(ROOT, "tools", "check-android-lua-cache.py"),
  "--archive", path.join(ROOT, "prebuilt", "android-lua-cache-9.21.3352381.zip"),
  "--manifest", luaManifestPath,
  "--gameplay-tables", gameplayRoot,
];
if (fs.existsSync(modRoot)) luaCheckArgs.push("--mod-tables", modRoot);
childProcess.execFileSync("py", luaCheckArgs, { cwd: ROOT, stdio: "inherit" });

const enabledMods = readJson(path.join(ROOT, "mods", "profile.json"), { enabled: [] }).enabled || [];
for (const modId of enabledMods) {
  const projectRoot = path.join(ROOT, "mods", modId, "assets");
  const windows = listFiles(path.join(projectRoot, "bundles"));
  const android = new Set(listFiles(path.join(projectRoot, "android-bundles")));
  const missingVariants = windows.filter((file) => !android.has(file));
  assert.deepStrictEqual(missingVariants, [], `${modId} is missing Android AssetBundle variants: ${missingVariants.join(", ")}`);
  for (const file of android) {
    assert(androidResources.has(file.toLowerCase()), `${modId} Android AssetBundle is absent from payload PatchInfo: ${file}`);
  }
}

console.log(`[android-resource-parity] PASS pcResources=${pcResources.size} androidResources=${androidResources.size} effectiveLua=${effectiveLua.size} cacheLua=${androidLua.size} version=${pcSuffix}`);

function effectiveFiles(roots) {
  const files = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) files.set(relative(root, file).toLowerCase(), file);
  }
  return files;
}

function effectiveLuaFiles(root, overlay) {
  const files = new Set();
  for (const source of ["StreamingAssets", "Assetbundles"]) {
    const sourceRoot = path.join(root, source);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const file of walk(sourceRoot)) {
      const rel = relative(sourceRoot, file);
      if (/^[^/]+\/luac\/[^/]+\.luac$/i.test(rel)) files.add(rel.replace(/\/luac\//i, "/").toLowerCase());
    }
  }
  if (overlay) {
    const sourceRoot = path.join(overlay, "Assetbundles");
    if (fs.existsSync(sourceRoot)) for (const file of walk(sourceRoot)) {
      const rel = relative(sourceRoot, file);
      if (/^[^/]+\/luac\/[^/]+\.luac$/i.test(rel)) files.add(rel.replace(/\/luac\//i, "/").toLowerCase());
    }
  }
  return files;
}

function listFiles(root) { return fs.existsSync(root) ? [...walk(root)].map((file) => relative(root, file)) : []; }
function *walk(root) { for (const entry of fs.readdirSync(root, { withFileTypes: true })) { const file = path.join(root, entry.name); if (entry.isDirectory()) yield *walk(file); else if (entry.isFile()) yield file; } }
function relative(root, file) { return path.relative(root, file).replace(/\\/g, "/"); }
function suffix(value) { const match = String(value || "").match(/(\d+)$/); assert(match, `Version has no numeric suffix: ${value}`); return match[1]; }
function readJson(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] || "" : ""; }
