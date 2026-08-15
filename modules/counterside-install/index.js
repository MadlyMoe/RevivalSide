const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function normalizeManagedDir(value) {
  if (!value) return "";
  let fullPath;
  try {
    fullPath = path.resolve(String(value).trim().replace(/^"|"$/g, ""));
  } catch (_) {
    return "";
  }

  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    fullPath = path.dirname(fullPath);
  }

  for (const candidate of buildManagedDirCandidates(fullPath)) {
    if (fs.existsSync(path.join(candidate, "Assembly-CSharp.dll"))) return candidate;
  }
  return fullPath;
}

function isManagedDirDiscoveryDisabled(env = process.env) {
  const value = String(env.CS_DISABLE_COUNTERSIDE_MANAGED_DIR || env.CS_DISABLE_MANAGED_DIR_DISCOVERY || "")
    .trim()
    .toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function buildManagedDirCandidates(root) {
  const candidates = [root, path.join(root, "Data", "Managed"), path.join(root, "Managed")];
  if (path.basename(root).toLowerCase() === "data") candidates.push(path.join(root, "Managed"));
  if (path.basename(root).toLowerCase() === "managed") {
    const parent = path.dirname(root);
    candidates.push(path.join(parent, "Managed"));
  }
  return Array.from(new Set(candidates));
}

function findCounterSideManagedDir(options = {}) {
  const env = options.env || process.env;
  if (isManagedDirDiscoveryDisabled(env)) return "";
  for (const candidate of findCounterSideManagedDirCandidates(options)) {
    const managed = normalizeManagedDir(candidate);
    if (managed && fs.existsSync(path.join(managed, "Assembly-CSharp.dll"))) return managed;
  }
  return "";
}

function findCounterSideManagedDirCandidates(options = {}) {
  const env = options.env || process.env;
  if (isManagedDirDiscoveryDisabled(env)) return [];
  const candidates = [
    options.managedDir,
    env.CS_COUNTERSIDE_MANAGED_DIR,
    env.COUNTERSIDE_MANAGED_DIR,
    env.CS_COUNTERSIDE_DIR,
    path.join("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide"),
    path.join(env.ProgramFiles || "C:\\Program Files", "Steam", "steamapps", "common", "CounterSide"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam", "steamapps", "common", "CounterSide"),
  ].filter(Boolean);

  for (const libraryRoot of findSteamLibraryRoots(env)) {
    const commonDir = path.join(libraryRoot, "steamapps", "common");
    for (const knownName of ["CounterSide", "CounterSide Global", "COUNTER SIDE"]) {
      candidates.push(path.join(commonDir, knownName));
    }
    if (!fs.existsSync(commonDir)) continue;
    try {
      for (const name of fs.readdirSync(commonDir)) {
        const gameDir = path.join(commonDir, name);
        if (!fs.statSync(gameDir).isDirectory()) continue;
        if (name.replace(/\s+/g, "").toLowerCase().includes("counterside")) candidates.push(gameDir);
      }
    } catch (_) {
      // Ignore inaccessible Steam libraries.
    }
  }

  return Array.from(new Set(candidates));
}

function findCounterSideDataDir(options = {}) {
  const managedDir = normalizeManagedDir(options.managedDir || findCounterSideManagedDir(options));
  if (!managedDir || !fs.existsSync(path.join(managedDir, "Assembly-CSharp.dll"))) return "";
  const parent = path.dirname(managedDir);
  if (path.basename(managedDir).toLowerCase() === "managed" && path.basename(parent).toLowerCase() === "data") {
    return parent;
  }
  const dataDir = path.join(path.dirname(managedDir), "Data");
  return fs.existsSync(dataDir) ? dataDir : parent;
}

function findCounterSideStreamingAssetsDir(options = {}) {
  const dataDir = findCounterSideDataDir(options);
  if (!dataDir) return "";
  const streamingAssets = path.join(dataDir, "StreamingAssets");
  return fs.existsSync(streamingAssets) ? streamingAssets : "";
}

function findCounterSideScriptBundleRoots(options = {}) {
  const dataDir = findCounterSideDataDir(options);
  const streamingAssets = dataDir ? path.join(dataDir, "StreamingAssets") : "";
  const gameRoot = dataDir && path.basename(dataDir).toLowerCase() === "data" ? path.dirname(dataDir) : "";
  const candidates = [
    { label: "Assetbundles", root: gameRoot ? path.join(gameRoot, "Assetbundles") : "" },
    { label: "StreamingAssets", root: streamingAssets },
    { label: "Assetbundles", root: streamingAssets ? path.join(streamingAssets, "Assetbundles") : "" },
    { label: "Assetbundles", root: dataDir ? path.join(dataDir, "Assetbundles") : "" },
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate.root || !hasScriptBundles(candidate.root)) continue;
    const key = path.normalize(candidate.root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function hasScriptBundles(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isFile() && /^ab_script/i.test(entry.name));
  } catch (_) {
    return false;
  }
}

function findSteamLibraryRoots(env = process.env) {
  const roots = new Set();
  for (const steamRoot of findSteamInstallRoots(env)) {
    addExistingDirectory(roots, steamRoot);
    const libraryFile = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(libraryFile)) continue;
    let text = "";
    try {
      text = fs.readFileSync(libraryFile, "utf8");
    } catch (_) {
      continue;
    }
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
      addExistingDirectory(roots, unescapeSteamPath(match[1]));
    }
  }
  return Array.from(roots);
}

function findSteamInstallRoots(env = process.env) {
  const home = env.HOME || process.env.HOME || "";
  const linuxRoots = home
    ? [
        path.join(home, ".steam", "steam"),
        path.join(home, ".steam", "root"),
        path.join(home, ".local", "share", "Steam"),
        path.join(home, ".steam", "debian-installation"),
      ]
    : [];
  return [
    readRegistryString("HKCU\\Software\\Valve\\Steam", "SteamPath"),
    readRegistryString("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
    readRegistryString("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
    path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam"),
    path.join(env.ProgramFiles || "C:\\Program Files", "Steam"),
    "C:\\Steam",
    "D:\\Steam",
    "E:\\Steam",
    ...linuxRoots,
  ]
    .filter(Boolean)
    .map(unescapeSteamPath);
}

function readRegistryString(key, valueName) {
  if (process.platform !== "win32") return "";
  try {
    const output = execFileSync("reg", ["query", key, "/v", valueName], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = output.split(/\r?\n/).find((item) => new RegExp(`\\s${escapeRegExp(valueName)}\\s+REG_\\w+\\s+`, "i").test(item));
    if (!line) return "";
    return line.replace(new RegExp(`^.*?\\s${escapeRegExp(valueName)}\\s+REG_\\w+\\s+`, "i"), "").trim();
  } catch (_) {
    return "";
  }
}

function addExistingDirectory(set, value) {
  if (!value) return;
  try {
    const fullPath = path.resolve(unescapeSteamPath(value));
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) set.add(fullPath);
  } catch (_) {
    // Ignore malformed paths.
  }
}

function unescapeSteamPath(value) {
  return String(value || "").trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\").replace(/\//g, path.sep);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  findCounterSideDataDir,
  findCounterSideManagedDir,
  findCounterSideManagedDirCandidates,
  findCounterSideScriptBundleRoots,
  findCounterSideStreamingAssetsDir,
  hasScriptBundles,
  isManagedDirDiscoveryDisabled,
  normalizeManagedDir,
};
