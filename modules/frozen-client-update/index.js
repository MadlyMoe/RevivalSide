const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EMPTY_PATCH_INFO = Buffer.from([
  0x02, 0x02, 0x00, 0x00, 0x00,
  0x07, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e,
  0x03, 0x00,
  0x04, 0x64, 0x61, 0x74, 0x61,
  0x01, 0x00, 0x00, 0x00, 0x00,
]);

function loadFrozenClientPatchState(managedDir, options = {}) {
  const normalizedManagedDir = path.resolve(String(managedDir || ""));
  const dataDir = path.dirname(normalizedManagedDir);
  const rootDir = path.dirname(dataDir);
  const versionPath = path.join(rootDir, "Version.json");
  const frozenManifestPath = path.join(rootDir, "revivalside-frozen-client.json");
  if (!managedDir || !fs.existsSync(versionPath)) return null;

  const versionFile = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  const versionCode = String(versionFile.VersionCode || versionFile.versionCode || "").trim();
  const buildCode = extractBuildCode(versionCode);
  if (!buildCode) throw new Error(`CounterSide Version.json has no numeric build code: ${versionCode || "(empty)"}`);

  const patchState = selectInstalledPatchInfo([
    path.join(rootDir, "Assetbundles", "PatchInfo.json"),
    path.join(dataDir, "StreamingAssets", "PatchInfo.json"),
  ]);
  if (!patchState) return null;
  const standaloneVersion = patchState.version;
  const assetBuildCode = extractBuildCode(standaloneVersion) || buildCode;

  return Object.freeze({
    rootDir,
    dataDir,
    managedDir: normalizedManagedDir,
    versionCode,
    buildCode,
    standaloneVersion,
    extraAssetVersion: `ExtraAsset_${assetBuildCode}`,
    patchInfo: patchState.body,
    patchInfoPath: patchState.path,
    frozenManifestPath,
    isFrozenClient: fs.existsSync(frozenManifestPath),
    contentsVersion: readFrozenContentsVersion(
      options.gameplayTablesDir || process.env.CS_GAMEPLAY_TABLES_DIR || ""
    ),
  });
}

function readFrozenContentsVersion(gameplayTablesDir) {
  const root = String(gameplayTablesDir || "").trim();
  if (!root) return "";
  for (const source of ["Assetbundles", "StreamingAssets"]) {
    const versionFile = path.join(path.resolve(root), source, "ab_script", "luac", "LUA_CONTENTS_VERSION.luac");
    if (!fs.existsSync(versionFile)) continue;
    const body = fs.readFileSync(versionFile);
    const markerOffset = body.indexOf(Buffer.from("ContentsVersion", "ascii"));
    if (markerOffset < 0) continue;
    const match = body
      .subarray(markerOffset, Math.min(body.length, markerOffset + 128))
      .toString("latin1")
      .match(/\b\d{1,4}\.\d{1,4}\.[A-Za-z0-9_-]{1,16}\b/);
    if (match) return match[0];
  }
  return "";
}

function selectInstalledPatchInfo(candidates) {
  const states = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const body = fs.readFileSync(candidate);
    const version = readPatchInfoVersion(body);
    const buildCode = Number(extractBuildCode(version));
    if (!version || !Number.isFinite(buildCode)) continue;
    states.push({ path: candidate, body, version, buildCode });
  }
  states.sort((left, right) => right.buildCode - left.buildCode);
  return states[0] || null;
}

function resolveFrozenClientPatchResponse(pathname, state) {
  if (!state) return null;
  const cleanPath = decodeURIComponent(String(pathname || ""));
  if (cleanPath === "/patchfiles/StandaloneWindows64/liveVersion.json") {
    return jsonResponse({ versionList: [{ version: state.standaloneVersion }] }, "standalone-version");
  }
  if (cleanPath === `/patchfiles/StandaloneWindows64/${state.standaloneVersion}/PatchInfo.json`) {
    return binaryResponse(state.patchInfo, "standalone-patch-info");
  }
  if (cleanPath === "/patchfiles/ExtraAsset/liveVersion.json") {
    return jsonResponse({ versionList: [{ version: state.extraAssetVersion }] }, "extra-asset-version");
  }
  if (cleanPath === `/patchfiles/ExtraAsset/${state.extraAssetVersion}/PatchInfo.json`) {
    return binaryResponse(EMPTY_PATCH_INFO, "extra-asset-patch-info");
  }
  return null;
}

function loadAndroidClientUpdateState(updateDir) {
  const root = path.resolve(String(updateDir || ""));
  const bundlePath = path.join(root, "ab_script");
  const patchInfoPath = path.join(root, "LatestPatchInfo.json");
  if (!updateDir || !fs.existsSync(bundlePath) || !fs.existsSync(patchInfoPath)) return null;

  const bundle = fs.readFileSync(bundlePath);
  const sourcePatchInfo = fs.readFileSync(patchInfoPath);
  const sourceVersion = readAndroidPatchInfoVersion(sourcePatchInfo);
  if (!sourceVersion) throw new Error(`Android PatchInfo has no version: ${patchInfoPath}`);
  const version = sourceVersion;
  const md5 = crypto.createHash("md5").update(bundle).digest("hex");
  const patchInfo = patchAndroidScriptEntry(sourcePatchInfo, sourceVersion, version, md5, bundle.length);
  const tutorialPath = path.join(root, "tutorialDungeonResources.json");
  const tutorial = fs.existsSync(tutorialPath) ? fs.readFileSync(tutorialPath) : null;
  const luaCache = loadAndroidLuaCacheState(root);
  return Object.freeze({ bundle, md5, patchInfo, sourceVersion, version, tutorial, luaCache });
}

function resolveAndroidClientUpdateResponse(pathname, state) {
  if (!state) return null;
  const cleanPath = decodeURIComponent(String(pathname || ""));
  for (const prefix of ["/patchfiles", "/android-patchfiles"]) {
    if (cleanPath === `${prefix}/Android/liveVersion.json`) {
      return jsonResponse({ versionList: [{ version: state.version }] }, "android-version");
    }
    if (cleanPath === `${prefix}/Android/${state.version}/PatchInfo.json`) {
      return binaryResponse(state.patchInfo, "android-patch-info");
    }
    if (cleanPath === `${prefix}/Android/${state.version}/ab_script`) {
      return binaryResponse(state.bundle, "android-ab-script");
    }
    if (state.tutorial && cleanPath === `${prefix}/Android/${state.version}/tutorialDungeonResources.json`) {
      return binaryResponse(state.tutorial, "android-tutorial-resources", "application/json; charset=utf-8");
    }
  }
  if (state.luaCache) {
    const prefix = "/android-patchfiles/ExtraAsset";
    if (cleanPath === `${prefix}/liveVersion.json`) {
      return jsonResponse({ versionList: [{ version: state.luaCache.version }] }, "android-lua-cache-version");
    }
    if (cleanPath === `${prefix}/${state.luaCache.version}/PatchInfo.json`) {
      return binaryResponse(state.luaCache.patchInfo, "android-lua-cache-patch-info");
    }
    const relativePath = cleanPath.startsWith(`${prefix}/${state.luaCache.version}/`)
      ? cleanPath.slice(`${prefix}/${state.luaCache.version}/`.length)
      : "";
    const entry = state.luaCache.byPath.get(relativePath);
    if (entry) {
      const body = fs.readFileSync(entry.filePath);
      if (body.length !== entry.size) throw new Error(`Android Lua cache size changed: ${relativePath}`);
      return binaryResponse(body, "android-lua-cache-file");
    }
  }
  return null;
}

function loadAndroidLuaCacheState(updateRoot) {
  const manifestPath = path.join(updateRoot, "lua-cache-manifest.json");
  const cacheRoot = path.join(updateRoot, "lua-cache");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(cacheRoot)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !/^ExtraAsset_\d+$/.test(manifest.version) || !Array.isArray(manifest.files)) {
    throw new Error(`Unsupported Android Lua cache manifest: ${manifestPath}`);
  }
  const byPath = new Map();
  const patchFiles = [];
  for (const raw of manifest.files) {
    const relativePath = normalizePayloadPath(raw && raw.path);
    const size = Number(raw && raw.size);
    const md5 = String((raw && raw.md5) || "").toLowerCase();
    if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{32}$/.test(md5) || byPath.has(relativePath)) {
      throw new Error(`Invalid Android Lua cache entry: ${JSON.stringify(raw)}`);
    }
    const entry = Object.freeze({ filePath: safePayloadFile(cacheRoot, relativePath), relativePath, size, md5 });
    byPath.set(relativePath, entry);
    patchFiles.push(entry);
  }
  return Object.freeze({
    version: manifest.version,
    manifestPath,
    byPath,
    patchInfo: encodePatchInfo(manifest.version, patchFiles),
  });
}

function encodePatchInfo(version, entries) {
  return encodePatchValue({
    version,
    data: entries.map((entry) => [entry.relativePath, entry.md5, String(entry.size)]),
  });
}

function encodePatchValue(value) {
  if (typeof value === "string") return Buffer.concat([Buffer.from([3]), encodePatchString(value)]);
  if (Array.isArray(value)) {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(value.length);
    return Buffer.concat([Buffer.from([1]), count, ...value.map(encodePatchValue)]);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(entries.length);
    return Buffer.concat([
      Buffer.from([2]),
      count,
      ...entries.flatMap(([key, item]) => [encodePatchString(key), encodePatchValue(item)]),
    ]);
  }
  throw new Error(`Unsupported PatchInfo value: ${value}`);
}

function encodePatchString(value) {
  const body = Buffer.from(String(value), "utf8");
  if (body.length > 255) throw new Error(`PatchInfo string is too long: ${value}`);
  return Buffer.concat([Buffer.from([body.length]), body]);
}

function loadAndroidClientPayloadState(payloadDir) {
  const rootDir = path.resolve(String(payloadDir || ""));
  const manifestPath = path.join(rootDir, "payload-manifest.json");
  if (!payloadDir || !fs.existsSync(manifestPath)) return null;

  const manifestBody = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Unsupported Android payload manifest: ${manifestPath}`);
  }

  const byPath = new Map();
  for (const entry of manifest.files) {
    const relativePath = normalizePayloadPath(entry && entry.path);
    const size = Number(entry && entry.size);
    const sha256 = String((entry && entry.sha256) || "").toLowerCase();
    if (!relativePath || !Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Invalid Android payload entry: ${JSON.stringify(entry)}`);
    }
    if (byPath.has(relativePath)) throw new Error(`Duplicate Android payload path: ${relativePath}`);
    const filePath = safePayloadFile(rootDir, relativePath);
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size !== size) {
      throw new Error(`Android payload file is missing or has the wrong size: ${relativePath}`);
    }
    byPath.set(`/${relativePath}`, Object.freeze({ filePath, relativePath, size, sha256 }));
  }

  return Object.freeze({
    rootDir,
    manifestPath,
    manifest,
    manifestBody,
    manifestSha256: crypto.createHash("sha256").update(manifestBody).digest("hex"),
    byPath,
  });
}

function resolveAndroidClientPayloadFile(pathname, state) {
  if (!state) return null;
  const cleanPath = normalizeRequestPath(pathname);
  if (cleanPath === "/android-client/payload-manifest.json") {
    return {
      label: "android-payload-manifest",
      contentType: "application/json; charset=utf-8",
      body: state.manifestBody,
      sha256: state.manifestSha256,
    };
  }
  const payloadPath = cleanPath.startsWith("/android-patchfiles/")
    ? `/patchfiles/${cleanPath.slice("/android-patchfiles/".length)}`
    : cleanPath;
  const entry = state.byPath.get(payloadPath);
  return entry ? { ...entry, label: "android-payload-file", contentType: contentTypeFor(entry.relativePath) } : null;
}

function normalizePayloadPath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe Android payload path: ${value}`);
  }
  return raw;
}

function safePayloadFile(rootDir, relativePath) {
  const filePath = path.resolve(rootDir, ...relativePath.split("/"));
  if (!filePath.startsWith(`${rootDir}${path.sep}`)) throw new Error(`Unsafe Android payload path: ${relativePath}`);
  return filePath;
}

function normalizeRequestPath(value) {
  try {
    const decoded = decodeURIComponent(String(value || ""));
    return decoded.startsWith("/revivalsideapk/") ? decoded.slice("/revivalsideapk".length) : decoded;
  } catch {
    return "";
  }
}

function contentTypeFor(relativePath) {
  if (relativePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (relativePath.endsWith(".apk")) return "application/vnd.android.package-archive";
  return "application/octet-stream";
}

function readAndroidPatchInfoVersion(buffer) {
  const match = buffer.subarray(0, Math.min(buffer.length, 256)).toString("latin1").match(/ANDROID_\d+/);
  return match ? match[0] : "";
}

function patchAndroidScriptEntry(source, sourceVersion, version, md5, size) {
  const output = Buffer.from(source);
  replaceFixedAscii(output, sourceVersion, version, "Android patch version");
  const marker = Buffer.concat([Buffer.from([3, 9]), Buffer.from("ab_script", "ascii"), Buffer.from([3, 32])]);
  const markerOffset = output.indexOf(marker);
  if (markerOffset < 0) throw new Error("Android PatchInfo has no ab_script entry");
  const hashOffset = markerOffset + marker.length;
  const sizeTypeOffset = hashOffset + 32;
  if (output[sizeTypeOffset] !== 3) throw new Error("Android PatchInfo ab_script size is not a string");
  const sizeLength = output[sizeTypeOffset + 1];
  const sizeText = String(size);
  if (sizeLength !== sizeText.length) throw new Error(`Android ab_script size width changed: ${sizeLength} != ${sizeText.length}`);
  output.write(md5, hashOffset, 32, "ascii");
  output.write(sizeText, sizeTypeOffset + 2, sizeLength, "ascii");
  return output;
}

function replaceFixedAscii(buffer, before, after, label) {
  if (before.length !== after.length) throw new Error(`${label} width changed: ${before} -> ${after}`);
  const offset = buffer.indexOf(Buffer.from(before, "ascii"));
  if (offset < 0) throw new Error(`${label} was not found: ${before}`);
  buffer.write(after, offset, after.length, "ascii");
}

function extractBuildCode(versionCode) {
  const match = String(versionCode || "").match(/(\d+)$/);
  return match ? match[1] : "";
}

function readPatchInfoVersion(buffer) {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 256)).toString("latin1");
  const match = prefix.match(/STANDALONE_WINDOWS_\d+/);
  return match ? match[0] : "";
}

function jsonResponse(value, label) {
  return {
    label,
    contentType: "application/json; charset=utf-8",
    body: Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
  };
}

function binaryResponse(value, label, contentType = "application/octet-stream") {
  return {
    label,
    contentType,
    body: Buffer.from(value),
  };
}

module.exports = {
  EMPTY_PATCH_INFO,
  encodePatchInfo,
  extractBuildCode,
  loadAndroidClientPayloadState,
  loadAndroidClientUpdateState,
  loadFrozenClientPatchState,
  patchAndroidScriptEntry,
  readAndroidPatchInfoVersion,
  readFrozenContentsVersion,
  readPatchInfoVersion,
  resolveAndroidClientPayloadFile,
  resolveAndroidClientUpdateResponse,
  resolveFrozenClientPatchResponse,
};
