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
  const tutorialDungeonResourcesPath = selectExistingFile([
    path.join(rootDir, "Assetbundles", "tutorialDungeonResources.json"),
    path.join(dataDir, "StreamingAssets", "tutorialDungeonResources.json"),
  ]);

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
    tutorialDungeonResources: tutorialDungeonResourcesPath
      ? fs.readFileSync(tutorialDungeonResourcesPath)
      : null,
    tutorialDungeonResourcesPath,
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

function selectExistingFile(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
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
  if (
    cleanPath === `/patchfiles/StandaloneWindows64/${state.standaloneVersion}/tutorialDungeonResources.json` &&
    state.tutorialDungeonResources
  ) {
    return binaryResponse(
      state.tutorialDungeonResources,
      "standalone-tutorial-dungeon-resources",
      "application/json; charset=utf-8"
    );
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
  const version = sourceVersion.replace(/\d+$/, (value) => String(Number(value) + 1));
  const md5 = crypto.createHash("md5").update(bundle).digest("hex");
  const patchInfo = patchAndroidScriptEntry(sourcePatchInfo, sourceVersion, version, md5, bundle.length);
  return Object.freeze({ bundle, md5, patchInfo, sourceVersion, version });
}

function resolveAndroidClientUpdateResponse(pathname, state) {
  if (!state) return null;
  const cleanPath = decodeURIComponent(String(pathname || ""));
  if (cleanPath === "/patchfiles/Android/liveVersion.json") {
    return jsonResponse({ versionList: [{ version: state.version }] }, "android-version");
  }
  if (cleanPath === `/patchfiles/Android/${state.version}/PatchInfo.json`) {
    return binaryResponse(state.patchInfo, "android-patch-info");
  }
  if (cleanPath === `/patchfiles/Android/${state.version}/ab_script`) {
    return binaryResponse(state.bundle, "android-ab-script");
  }
  return null;
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
  extractBuildCode,
  loadAndroidClientUpdateState,
  loadFrozenClientPatchState,
  patchAndroidScriptEntry,
  readAndroidPatchInfoVersion,
  readFrozenContentsVersion,
  readPatchInfoVersion,
  resolveAndroidClientUpdateResponse,
  resolveFrozenClientPatchResponse,
};
