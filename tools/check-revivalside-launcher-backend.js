'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createListenerReadinessGate } = require('./revivalside-launcher-backend');
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

async function main() {
  checkGameRootAssetbundlesDiscovery();
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

  console.log('[launcher-backend] PASS game-root bundles and four-service readiness');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
