'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FROZEN_CLIENT_PATCH_REQUIREMENTS,
  createListenerReadinessGate,
  normalizeExistingManagedDir,
  verifyGameplayCacheSource,
} = require('./revivalside-launcher-backend');
const { findCounterSideScriptBundleRoots } = require('../modules/counterside-install');

function checkGameRootAssetbundlesDiscovery() {
  const gameRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revivalside-launcher-'));
  try {
    const managedDir = path.join(gameRoot, 'Data', 'Managed');
    const assetbundles = path.join(gameRoot, 'Assetbundles');
    fs.mkdirSync(managedDir, { recursive: true });
    fs.mkdirSync(assetbundles, { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'Assembly-CSharp.dll'), 'fixture');
    fs.writeFileSync(path.join(assetbundles, 'ab_script'), 'fixture');

    const roots = findCounterSideScriptBundleRoots({ managedDir });
    assert.strictEqual(roots.length, 1, 'game-root Assetbundles should be discovered');
    assert.strictEqual(path.resolve(roots[0].root), path.resolve(assetbundles));
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
}

function checkMissingClientMigration() {
  const gameRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revivalside-client-path-'));
  try {
    const managedDir = path.join(gameRoot, 'Data', 'Managed');
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'Assembly-CSharp.dll'), 'fixture');
    assert.strictEqual(normalizeExistingManagedDir(managedDir), path.resolve(managedDir));
    fs.rmSync(gameRoot, { recursive: true, force: true });
    assert.strictEqual(
      normalizeExistingManagedDir(managedDir),
      '',
      'a removed frozen-client path must become not installed'
    );
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
}

function checkFrozenGameplayCacheSource() {
  const gameRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revivalside-frozen-source-'));
  try {
    const managedDir = path.join(gameRoot, 'Data', 'Managed');
    const scriptRoot = path.join(gameRoot, 'Assetbundles');
    const cacheRoot = path.join(gameRoot, 'cache');
    fs.mkdirSync(managedDir, { recursive: true });
    fs.mkdirSync(scriptRoot, { recursive: true });
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(managedDir, 'Assembly-CSharp.dll'), 'fixture');
    fs.writeFileSync(path.join(cacheRoot, '.revivalside-gameplay-luac-cache.json'), JSON.stringify({
      managedDir,
      scriptRoots: [{ label: 'Assetbundles', root: scriptRoot, files: [] }],
    }));
    const source = verifyGameplayCacheSource(managedDir, cacheRoot);
    assert.strictEqual(source.managedDir, path.resolve(managedDir));
    assert.deepStrictEqual(source.scriptRoots, [path.resolve(scriptRoot)]);

    const officialRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revivalside-official-source-'));
    try {
      fs.writeFileSync(path.join(cacheRoot, '.revivalside-gameplay-luac-cache.json'), JSON.stringify({
        managedDir,
        scriptRoots: [{ label: 'Assetbundles', root: officialRoot, files: [] }],
      }));
      assert.throws(
        () => verifyGameplayCacheSource(managedDir, cacheRoot),
        /outside the selected frozen client/,
      );
    } finally {
      fs.rmSync(officialRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
}

async function main() {
  checkGameRootAssetbundlesDiscovery();
  checkMissingClientMigration();
  checkFrozenGameplayCacheSource();
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('frozen-contents-version-isolation=False'));
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('frozen-login-contents-reconciliation=False'));
  const settings = { GamePort: 22000, HttpPort: 8088 };
  const gate = createListenerReadinessGate(settings, 1000);
  let resolved = false;
  gate.ready.then(() => { resolved = true; });

  gate.observe('[+] Listening on port 22000');
  gate.observe('[+] Captured HTTP mirror listening on http://127.0.0.1:8088');
  gate.observe('[+] Captured HTTP mirror fixtureDir=C:\\RevivalSide\\server-data\\captured-flows');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(resolved, false, 'readiness must wait for User Manager');

  gate.observe('[+] User manager listening on http://127.0.0.1:8088/user-manager');
  await gate.ready;
  assert.strictEqual(resolved, true, 'all four readiness signals should resolve the gate');

  const timeoutGate = createListenerReadinessGate(settings, 20);
  timeoutGate.observe('[+] Listening on port 22000');
  await assert.rejects(timeoutGate.ready, /Missing: captured HTTP mirror, captured fixture directory, User Manager/);

  console.log('[launcher-backend] PASS clean client-table audit, game-root bundles, missing-client handling, and four-service readiness');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
