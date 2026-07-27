const fs = require("fs");
const path = require("path");

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
  const versionFile = path.join(
    path.resolve(root),
    "StreamingAssets",
    "ab_script",
    "luac",
    "LUA_CONTENTS_VERSION.luac"
  );
  if (!fs.existsSync(versionFile)) return "";

  const body = fs.readFileSync(versionFile);
  const marker = Buffer.from("ContentsVersion", "ascii");
  const markerOffset = body.indexOf(marker);
  if (markerOffset < 0) return "";
  const nearbyText = body
    .subarray(markerOffset, Math.min(body.length, markerOffset + 128))
    .toString("latin1");
  const match = nearbyText.match(/\b\d{1,4}\.\d{1,4}\.[A-Za-z0-9_-]{1,16}\b/);
  return match ? match[0] : "";
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

function binaryResponse(value, label) {
  return {
    label,
    contentType: "application/octet-stream",
    body: Buffer.from(value),
  };
}

module.exports = {
  EMPTY_PATCH_INFO,
  extractBuildCode,
  loadFrozenClientPatchState,
  readFrozenContentsVersion,
  readPatchInfoVersion,
  resolveFrozenClientPatchResponse,
};
