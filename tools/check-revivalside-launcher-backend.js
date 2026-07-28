'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FROZEN_CLIENT_PATCH_REQUIREMENTS,
  createListenerReadinessGate,
  normalizeExistingManagedDir,
  resolveFrozenAdvertisedContentsVersion,
  validateClientManifest,
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

function checkClientManifestValidation() {
  const hash = 'a'.repeat(64);
  const manifest = validateClientManifest({
    schemaVersion: 1,
    clientVersion: 'LIVE_335238',
    rootDirName: 'CounterSide-LIVE_335238',
    archiveName: 'RevivalSideClient-LIVE_335238.zip',
    archiveSize: 18,
    archiveSha256: hash,
    installedSize: 32,
    fileCount: 3,
    chunks: Array.from({ length: 9 }, (_, index) => ({
      name: `RevivalSideClient-LIVE_335238.zip.${String(index + 1).padStart(3, '0')}`,
      size: 2,
      sha256: hash,
    })),
  });
  assert.strictEqual(manifest.chunks.length, 9);
  assert.strictEqual(manifest.archiveSize, 18);
  assert.throws(() => validateClientManifest({ ...manifest, rootDirName: '..' }), /rootDirName/);
  assert.throws(() => validateClientManifest({ ...manifest, archiveSize: 19 }), /chunk total/);
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
      'a removed frozen-client path must become not installed so Start can download it'
    );
  } finally {
    fs.rmSync(gameRoot, { recursive: true, force: true });
  }
}

async function main() {
  checkGameRootAssetbundlesDiscovery();
  checkClientManifestValidation();
  checkMissingClientMigration();
  assert.strictEqual(resolveFrozenAdvertisedContentsVersion({}, '9.2.b'), '9.2.c');
  assert.strictEqual(
    resolveFrozenAdvertisedContentsVersion({ CS_FROZEN_MASQUERADE_CONTENTS_VERSION: '10.0.a' }, '9.2.b'),
    '10.0.a'
  );
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('frozen-login-contents-reconciliation=True'));
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

  console.log('[launcher-backend] PASS client manifest, content-version audit, game-root bundles, and four-service readiness');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
