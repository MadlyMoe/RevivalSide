const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadFrozenClientPatchState,
  resolveFrozenClientPatchResponse,
} = require("../modules/frozen-client-update");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-frozen-update-"));
try {
  const managedDir = path.join(root, "Data", "Managed");
  const streamingAssetsDir = path.join(root, "Data", "StreamingAssets");
  const downloadedAssetsDir = path.join(root, "Assetbundles");
  const gameplayTablesDir = path.join(root, "gameplay-luac");
  const contentsVersionDir = path.join(gameplayTablesDir, "StreamingAssets", "ab_script", "luac");
  fs.mkdirSync(managedDir, { recursive: true });
  fs.mkdirSync(streamingAssetsDir, { recursive: true });
  fs.mkdirSync(downloadedAssetsDir, { recursive: true });
  fs.mkdirSync(contentsVersionDir, { recursive: true });
  fs.writeFileSync(path.join(root, "Version.json"), JSON.stringify({ VersionCode: "LIVE_335238" }));
  fs.writeFileSync(path.join(root, "revivalside-frozen-client.json"), JSON.stringify({ RootDir: root }));
  const patchInfo = Buffer.from("\u0002\u0002\u0000\u0000\u0000\u0007version\u0003\u0019STANDALONE_WINDOWS_335238\u0004data\u0001\u0000\u0000\u0000\u0000", "latin1");
  const downloadedPatchInfo = Buffer.from("\u0002\u0002\u0000\u0000\u0000\u0007version\u0003\u0019STANDALONE_WINDOWS_335570\u0004data\u0001\u0000\u0000\u0000\u0000", "latin1");
  fs.writeFileSync(path.join(streamingAssetsDir, "PatchInfo.json"), patchInfo);
  fs.writeFileSync(path.join(downloadedAssetsDir, "PatchInfo.json"), downloadedPatchInfo);
  fs.writeFileSync(
    path.join(contentsVersionDir, "LUA_CONTENTS_VERSION.luac"),
    Buffer.from("\u001bLua\u0000ContentsVersion\u0000\u00059.2.b\u0000", "latin1")
  );

  const state = loadFrozenClientPatchState(managedDir, { gameplayTablesDir });
  assert(state);
  assert.strictEqual(state.isFrozenClient, true);
  assert.strictEqual(state.standaloneVersion, "STANDALONE_WINDOWS_335570");
  assert.strictEqual(state.extraAssetVersion, "ExtraAsset_335570");
  assert.strictEqual(state.patchInfoPath, path.join(downloadedAssetsDir, "PatchInfo.json"));
  assert.strictEqual(state.contentsVersion, "9.2.b");

  const live = resolveFrozenClientPatchResponse("/patchfiles/StandaloneWindows64/liveVersion.json", state);
  assert.deepStrictEqual(JSON.parse(live.body.toString("utf8")), {
    versionList: [{ version: "STANDALONE_WINDOWS_335570" }],
  });

  const localPatch = resolveFrozenClientPatchResponse(
    "/patchfiles/StandaloneWindows64/STANDALONE_WINDOWS_335570/PatchInfo.json",
    state
  );
  assert(localPatch.body.equals(downloadedPatchInfo));
  assert.strictEqual(
    resolveFrozenClientPatchResponse("/patchfiles/StandaloneWindows64/STANDALONE_WINDOWS_335238/PatchInfo.json", state),
    null
  );

  const extra = resolveFrozenClientPatchResponse("/patchfiles/ExtraAsset/liveVersion.json", state);
  assert.deepStrictEqual(JSON.parse(extra.body.toString("utf8")), {
    versionList: [{ version: "ExtraAsset_335570" }],
  });

  console.log("[frozen-client-update] PASS base=335238 installed-assets=335570 contents=9.2.b frozen-without-downgrade");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
