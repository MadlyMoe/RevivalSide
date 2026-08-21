const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadAndroidClientUpdateState,
  loadFrozenClientPatchState,
  readFrozenContentsVersion,
  resolveAndroidClientUpdateResponse,
  resolveFrozenClientPatchResponse,
} = require("../modules/frozen-client-update");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-frozen-update-"));
try {
  const managedDir = path.join(root, "Data", "Managed");
  const streamingAssetsDir = path.join(root, "Data", "StreamingAssets");
  const downloadedAssetsDir = path.join(root, "Assetbundles");
  const androidUpdateDir = path.join(root, "android-client-update");
  const gameplayTablesDir = path.join(root, "gameplay-luac");
  const streamingContentsVersionDir = path.join(gameplayTablesDir, "StreamingAssets", "ab_script", "luac");
  const downloadedContentsVersionDir = path.join(gameplayTablesDir, "Assetbundles", "ab_script", "luac");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(streamingAssetsDir, { recursive: true });
  fs.mkdirSync(downloadedAssetsDir, { recursive: true });
  fs.mkdirSync(androidUpdateDir, { recursive: true });
  fs.mkdirSync(streamingContentsVersionDir, { recursive: true });
  fs.mkdirSync(downloadedContentsVersionDir, { recursive: true });
  fs.writeFileSync(path.join(root, "Version.json"), JSON.stringify({ VersionCode: "LIVE_335238" }));
  fs.writeFileSync(path.join(root, "revivalside-frozen-client.json"), JSON.stringify({ RootDir: root }));
  const patchInfo = Buffer.from("\u0002\u0002\u0000\u0000\u0000\u0007version\u0003\u0019STANDALONE_WINDOWS_335238\u0004data\u0001\u0000\u0000\u0000\u0000", "latin1");
  const downloadedPatchInfo = Buffer.from("\u0002\u0002\u0000\u0000\u0000\u0007version\u0003\u0019STANDALONE_WINDOWS_335570\u0004data\u0001\u0000\u0000\u0000\u0000", "latin1");
  fs.writeFileSync(path.join(streamingAssetsDir, "PatchInfo.json"), patchInfo);
  fs.writeFileSync(path.join(downloadedAssetsDir, "PatchInfo.json"), downloadedPatchInfo);
  const tutorialDungeonResources = Buffer.from('[{"dungeonId":1001}]\n', "utf8");
  const tutorialDungeonResourcesPath = path.join(streamingAssetsDir, "tutorialDungeonResources.json");
  fs.writeFileSync(tutorialDungeonResourcesPath, tutorialDungeonResources);
  fs.writeFileSync(
    path.join(streamingContentsVersionDir, "LUA_CONTENTS_VERSION.luac"),
    Buffer.from("\u001bLua\u0000ContentsVersion\u0000\u00059.2.b\u0000", "latin1")
  );
  const downloadedContentsVersionPath = path.join(downloadedContentsVersionDir, "LUA_CONTENTS_VERSION.luac");
  fs.writeFileSync(
    downloadedContentsVersionPath,
    Buffer.from("\u001bLua\u0000ContentsVersion\u0000\u00059.2.c\u0000", "latin1")
  );

  const state = loadFrozenClientPatchState(managedDir, { gameplayTablesDir });
  assert(state);
  assert.strictEqual(state.isFrozenClient, true);
  assert.strictEqual(state.standaloneVersion, "STANDALONE_WINDOWS_335570");
  assert.strictEqual(state.extraAssetVersion, "ExtraAsset_335570");
  assert.strictEqual(state.patchInfoPath, path.join(downloadedAssetsDir, "PatchInfo.json"));
  assert.strictEqual(state.tutorialDungeonResourcesPath, tutorialDungeonResourcesPath);
  assert(state.tutorialDungeonResources.equals(tutorialDungeonResources));
  assert.strictEqual(state.contentsVersion, "9.2.c");
  fs.rmSync(downloadedContentsVersionPath);
  assert.strictEqual(readFrozenContentsVersion(gameplayTablesDir), "9.2.b");

  const live = resolveFrozenClientPatchResponse("/patchfiles/StandaloneWindows64/liveVersion.json", state);
  assert.deepStrictEqual(JSON.parse(live.body.toString("utf8")), {
    versionList: [{ version: "STANDALONE_WINDOWS_335570" }],
  });

  const localPatch = resolveFrozenClientPatchResponse(
    "/patchfiles/StandaloneWindows64/STANDALONE_WINDOWS_335570/PatchInfo.json",
    state
  );
  assert(localPatch.body.equals(downloadedPatchInfo));
  const tutorialResources = resolveFrozenClientPatchResponse(
    "/patchfiles/StandaloneWindows64/STANDALONE_WINDOWS_335570/tutorialDungeonResources.json",
    state
  );
  assert(tutorialResources.body.equals(tutorialDungeonResources));
  assert.strictEqual(tutorialResources.contentType, "application/json; charset=utf-8");
  assert.strictEqual(tutorialResources.label, "standalone-tutorial-dungeon-resources");
  assert.strictEqual(
    resolveFrozenClientPatchResponse("/patchfiles/StandaloneWindows64/STANDALONE_WINDOWS_335238/PatchInfo.json", state),
    null
  );

  const extra = resolveFrozenClientPatchResponse("/patchfiles/ExtraAsset/liveVersion.json", state);
  assert.deepStrictEqual(JSON.parse(extra.body.toString("utf8")), {
    versionList: [{ version: "ExtraAsset_335570" }],
  });

  const androidPatchInfo = Buffer.concat([
    Buffer.from("\u0002\u0002\u0000\u0000\u0000\u0007version\u0003\u000eANDROID_335570\u0004data\u0001\u0001\u0000\u0000\u0000\u0001\u0003\u0000\u0000\u0000\u0003\u0009ab_script\u0003\u0020", "latin1"),
    Buffer.from("10bc66034d78fd8dcaa78cbcc5e0a2f9\u0003\u000211", "latin1"),
  ]);
  fs.writeFileSync(path.join(androidUpdateDir, "LatestPatchInfo.json"), androidPatchInfo);
  fs.writeFileSync(path.join(androidUpdateDir, "ab_script"), Buffer.alloc(10, 7));
  const android = loadAndroidClientUpdateState(androidUpdateDir);
  assert.strictEqual(android.version, "ANDROID_335571");
  assert(android.patchInfo.includes(Buffer.from("10", "ascii")));
  assert.deepStrictEqual(
    JSON.parse(resolveAndroidClientUpdateResponse("/patchfiles/Android/liveVersion.json", android).body.toString("utf8")),
    { versionList: [{ version: "ANDROID_335571" }] }
  );
  assert.strictEqual(resolveAndroidClientUpdateResponse("/patchfiles/Android/ANDROID_335571/ab_script", android).body.length, 10);

  console.log("[frozen-client-update] PASS PC and Android asset updates with aligned contents metadata");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
