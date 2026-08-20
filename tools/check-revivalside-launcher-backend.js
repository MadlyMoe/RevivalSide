'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FROZEN_CLIENT_PATCH_REQUIREMENTS,
  applyClientSettings,
  buildListenerEnvironment,
  createListenerReadinessGate,
  estimateModSideRequiredBytes,
  isTailscaleIpv4,
  normalizeExistingManagedDir,
  normalizeTailscaleGuestAddress,
  progressFromLine,
  relayUrlFromSettings,
  settingsToClient,
  validatePrivatePvpSettings,
  validateRelayDeployment,
  verifyGameplayCacheSource,
} = require('./revivalside-launcher-backend');
const { findCounterSideScriptBundleRoots } = require('../modules/counterside-install');
const { ensureGameplayLuaCache, LUA_CACHE_MANIFEST_NAME } = require('../modules/gameplay-jsons');
const {
  applyLoginBackgroundTag,
  getLoginBackgroundCatalog,
  resolveLoginBackgroundItem,
} = require('../modules/login-background');

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

function checkGameplayCacheRelocation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revivalside-cache-relocation-'));
  try {
    const sourceRoot = path.join(root, 'source');
    const frozenRoot = path.join(root, 'frozen');
    const cacheRoot = path.join(root, 'cache');
    const timestamp = new Date('2026-01-01T00:00:00Z');
    for (const gameRoot of [sourceRoot, frozenRoot]) {
      const managedDir = path.join(gameRoot, 'Data', 'Managed');
      const bundleRoot = path.join(gameRoot, 'Assetbundles');
      fs.mkdirSync(managedDir, { recursive: true });
      fs.mkdirSync(bundleRoot, { recursive: true });
      fs.writeFileSync(path.join(managedDir, 'Assembly-CSharp.dll'), 'fixture');
      const bundle = path.join(bundleRoot, 'ab_script');
      fs.writeFileSync(bundle, 'same bundle');
      fs.utimesSync(bundle, timestamp, timestamp);
    }
    const requiredLua = path.join(cacheRoot, 'Assetbundles', 'ab_script', 'luac', 'LUA_STAGE_TEMPLET.luac');
    fs.mkdirSync(path.dirname(requiredLua), { recursive: true });
    fs.writeFileSync(requiredLua, 'cached');
    const sourceBundle = path.join(sourceRoot, 'Assetbundles', 'ab_script');
    const stat = fs.statSync(sourceBundle);
    fs.writeFileSync(path.join(cacheRoot, LUA_CACHE_MANIFEST_NAME), JSON.stringify({
      version: 2,
      generatedAt: 'fixture',
      managedDir: path.join(sourceRoot, 'Data', 'Managed'),
      scriptRoots: [{ label: 'Assetbundles', root: path.join(sourceRoot, 'Assetbundles'), files: [{ name: 'ab_script', size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) }] }],
      luacCount: 1,
    }));

    const frozenManaged = path.join(frozenRoot, 'Data', 'Managed');
    assert.strictEqual(ensureGameplayLuaCache({ rootDir: root, managedDir: frozenManaged, cacheRoot, quiet: true }), cacheRoot);
    const migrated = JSON.parse(fs.readFileSync(path.join(cacheRoot, LUA_CACHE_MANIFEST_NAME), 'utf8'));
    assert.strictEqual(path.resolve(migrated.managedDir), path.resolve(frozenManaged));
    assert.strictEqual(path.resolve(migrated.scriptRoots[0].root), path.resolve(path.join(frozenRoot, 'Assetbundles')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const launcherSettingsPath = path.join(__dirname, '..', 'launcher-settings.json');
  const hadLauncherSettings = fs.existsSync(launcherSettingsPath);
  const launcherSettingsBackup = hadLauncherSettings ? fs.readFileSync(launcherSettingsPath) : null;
  try {
  const backgrounds = getLoginBackgroundCatalog({ rootDir: path.join(__dirname, '..') });
  assert.strictEqual(resolveLoginBackgroundItem(backgrounds, {
    seedEntries: [{ source: { category: 'profile' }, intervalTags: ['DATE_GLOBAL_CLASSIFIED_CONTRACT_BORDER_HORSE'] }],
  }).id, 91, 'automatic login background should follow the active event interval');
  const selected = resolveLoginBackgroundItem(backgrounds, {}, '126');
  assert.strictEqual(selected.id, 126, 'launcher override should select the requested login background');
  assert.deepStrictEqual(
    applyLoginBackgroundTag(['GLOBAL', 'LOGIN_DEFAULT', 'LOGIN_OLD'], selected),
    ['GLOBAL', 'LOGIN_CLB004'],
    'only the selected pre-login background tag should remain'
  );
  assert.strictEqual(estimateModSideRequiredBytes(7 * 1024 ** 3), 32 * 1024 ** 3);
  assert.strictEqual(estimateModSideRequiredBytes(10 * 1024 ** 3), 45 * 1024 ** 3);
  assert.strictEqual(progressFromLine('[50/100] bundle', 5, 95), 53);
  assert.strictEqual(progressFromLine('not progress', 5, 95), null);
  assert.strictEqual(isTailscaleIpv4('100.64.0.10'), true);
  assert.strictEqual(isTailscaleIpv4('100.127.255.254'), true);
  assert.strictEqual(isTailscaleIpv4('100.128.0.1'), false);
  assert.deepStrictEqual(
    normalizeTailscaleGuestAddress('100.64.0.10', 8088),
    { hostname: '100.64.0.10', hostUrl: 'http://100.64.0.10:8088' },
  );
  assert.deepStrictEqual(
    normalizeTailscaleGuestAddress('http://host.example-tailnet.ts.net:9000'),
    { hostname: 'host.example-tailnet.ts.net', hostUrl: 'http://host.example-tailnet.ts.net:9000' },
  );
  assert.throws(() => normalizeTailscaleGuestAddress('203.0.113.10'), /100.x Tailscale code/);
  assert.throws(() => normalizeTailscaleGuestAddress('http://100.64.0.10:8088/path'), /without credentials or a path/);
  const pvpSettings = applyClientSettings({
    GamePort: 22000,
    HttpPort: 8088,
    WikiPort: 5174,
    ModSidePort: 5175,
  }, {
    privatePvpMode: 'legacy-host',
    privatePvpPublicHost: ' 100.64.0.10 ',
  });
  assert.deepStrictEqual(
    {
      privatePvpMode: settingsToClient(pvpSettings).privatePvpMode,
      privatePvpPublicHost: settingsToClient(pvpSettings).privatePvpPublicHost,
    },
    { privatePvpMode: 'legacy-host', privatePvpPublicHost: '100.64.0.10' },
  );
  const hostEnvironment = buildListenerEnvironment(pvpSettings);
  assert.strictEqual(hostEnvironment.CS_PRIVATE_PVP, '1');
  assert.strictEqual(hostEnvironment.CS_PVP_PUBLIC_HOST, '100.64.0.10');
  assert.strictEqual(hostEnvironment.CS_PVP_HOST_URL, '');
  assert.strictEqual(hostEnvironment.CS_GAME_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(hostEnvironment.CS_HTTP_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(hostEnvironment.CS_PVP_LISTEN_HOST, '100.64.0.10');
  const joinEnvironment = buildListenerEnvironment({
    ...pvpSettings,
    PrivatePvpMode: 'legacy-join',
    PrivatePvpHostUrl: 'http://100.64.0.10:8088',
  });
  assert.strictEqual(joinEnvironment.CS_PVP_PUBLIC_HOST, '');
  assert.strictEqual(joinEnvironment.CS_PVP_HOST_URL, 'http://100.64.0.10:8088');
  assert.strictEqual(joinEnvironment.CS_GAME_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(joinEnvironment.CS_HTTP_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(joinEnvironment.CS_PVP_LISTEN_HOST, '');
  const legacyWithStaleRelay = buildListenerEnvironment({
    ...pvpSettings,
    PrivatePvpRelayUrl: 'https://relay.example.com',
    PrivatePvpRelaySecret: 'a'.repeat(43),
    PrivatePvpRelayHostId: 'host-12345678',
  });
  assert.strictEqual(legacyWithStaleRelay.CS_PVP_RELAY_URL, '');
  assert.strictEqual(legacyWithStaleRelay.CS_PVP_RELAY_ROLE, 'off');
  assert.strictEqual(legacyWithStaleRelay.CS_GAME_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(legacyWithStaleRelay.CS_PVP_LISTEN_HOST, '100.64.0.10');
  const disabledEnvironment = buildListenerEnvironment({ ...pvpSettings, PrivatePvpMode: 'off' });
  assert.strictEqual(disabledEnvironment.CS_PRIVATE_PVP, '0');
  assert.strictEqual(disabledEnvironment.CS_PVP_PUBLIC_HOST, '');
  assert.strictEqual(disabledEnvironment.CS_PVP_HOST_URL, '');
  const relayEnvironment = buildListenerEnvironment({
    ...pvpSettings,
    PrivatePvpMode: 'host',
    PrivatePvpRelayUrl: 'https://relay.example.com',
    PrivatePvpRelaySecret: 'a'.repeat(43),
    PrivatePvpRelayHostId: 'host-12345678',
  });
  assert.strictEqual(relayEnvironment.CS_PVP_RELAY_ROLE, 'host');
  assert.strictEqual(relayEnvironment.CS_PVP_RELAY_URL, 'https://relay.example.com');
  assert.strictEqual(relayEnvironment.CS_PVP_RELAY_SECRET, 'a'.repeat(43));
  assert.strictEqual(relayEnvironment.CS_PVP_RELAY_HOST_ID, 'host-12345678');
  assert.strictEqual(relayEnvironment.CS_GAME_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(relayEnvironment.CS_HTTP_LISTEN_HOST, '127.0.0.1');
  assert.strictEqual(relayEnvironment.CS_PVP_PUBLIC_HOST, '127.0.0.1');
  assert.strictEqual(relayEnvironment.CS_PVP_LISTEN_HOST, '');
  assert.doesNotThrow(() => validatePrivatePvpSettings(pvpSettings));
  assert.doesNotThrow(() => validatePrivatePvpSettings({
    ...pvpSettings,
    PrivatePvpMode: 'legacy-join',
    PrivatePvpHostUrl: 'http://100.64.0.10:8088',
  }));
  assert.doesNotThrow(() => validatePrivatePvpSettings({
    ...pvpSettings,
    PrivatePvpMode: 'host',
    PrivatePvpRelayUrl: 'https://relay.example.com',
    PrivatePvpRelaySecret: 'a'.repeat(43),
    PrivatePvpRelayHostId: 'host-12345678',
  }));
  assert.throws(() => validatePrivatePvpSettings({ ...pvpSettings, PrivatePvpMode: 'host' }), /HTTPS relay URL/);
  assert.throws(() => validatePrivatePvpSettings({
    ...pvpSettings,
    PrivatePvpMode: 'legacy-join',
    PrivatePvpHostUrl: 'ftp://100.64.0.10',
  }), /HTTP or HTTPS/);
  assert.strictEqual(relayUrlFromSettings({ RelayHostname: 'relay.example.com', RelayPort: 443 }), 'https://relay.example.com');
  assert.strictEqual(relayUrlFromSettings({ RelayHostname: 'relay.example.com', RelayPort: 8443 }), 'https://relay.example.com:8443');
  assert.throws(() => validateRelayDeployment({
    RelaySshHost: 'relay.example.com', RelaySshPort: 22, RelaySshUser: 'deploy', RelaySshKeyPath: 'missing',
    RelaySshHostKeyFingerprint: 'accept-new', RelayHostname: 'relay.example.com', RelayPort: 443,
    RelayTlsCertificatePath: 'missing', RelayTlsPrivateKeyPath: 'missing', RelayInstallPath: '/opt/revivalside-relay',
    PrivatePvpRelaySecret: 'a'.repeat(43),
  }), /fingerprint/);
  checkGameRootAssetbundlesDiscovery();
  checkMissingClientMigration();
  checkFrozenGameplayCacheSource();
  checkGameplayCacheRelocation();
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('frozen-contents-version-isolation=False'));
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('frozen-login-contents-reconciliation=False'));
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('mod-string-loader=True'));
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('mod-asset-bundle-loader=True'));
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('mod-episode-ui=True'));
  assert(FROZEN_CLIENT_PATCH_REQUIREMENTS.includes('friendly-pvp-ui-fix=True'));
  const settings = { GamePort: 22000, HttpPort: 8088 };
  const gate = createListenerReadinessGate(settings, 1000);
  let resolved = false;
  gate.ready.then(() => { resolved = true; });

  gate.observe('[+] Listening on 127.0.0.1:22000');
  gate.observe('[+] HTTP services listening on 127.0.0.1:8088');
  gate.observe('[+] Captured HTTP mirror listening on http://127.0.0.1:8088');
  gate.observe('[+] Captured HTTP mirror fixtureDir=C:\\RevivalSide\\server-data\\captured-flows');
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(resolved, false, 'readiness must wait for User Manager');

  gate.observe('[+] User manager listening on http://127.0.0.1:8088/user-manager');
  await gate.ready;
  assert.strictEqual(resolved, true, 'all readiness signals should resolve the gate');

  const timeoutGate = createListenerReadinessGate(settings, 20);
  timeoutGate.observe('[+] Listening on 127.0.0.1:22000');
  await assert.rejects(timeoutGate.ready, /Missing: HTTP services 127\.0\.0\.1, captured HTTP mirror/);

  const tailscaleGate = createListenerReadinessGate(settings, 1000, {
    CS_GAME_LISTEN_HOST: '127.0.0.1',
    CS_HTTP_LISTEN_HOST: '127.0.0.1',
    CS_PVP_LISTEN_HOST: '100.64.0.10',
  });
  for (const line of [
    '[+] Listening on 127.0.0.1:22000',
    '[+] Listening on 100.64.0.10:22000',
    '[+] HTTP services listening on 127.0.0.1:8088',
    '[+] HTTP services listening on 100.64.0.10:8088',
    '[+] Captured HTTP mirror listening on http://127.0.0.1:8088',
    '[+] Captured HTTP mirror fixtureDir=C:\\RevivalSide\\server-data\\captured-flows',
    '[+] User manager listening on http://127.0.0.1:8088/user-manager',
  ]) tailscaleGate.observe(line);
  await tailscaleGate.ready;

  const backendSource = fs.readFileSync(require.resolve('./revivalside-launcher-backend'), 'utf8');
  assert.match(backendSource, /function snapshot\(\) \{[\s\S]*?ensureRuntimeLayout\(settings\)/);
  const listenerService = backendSource.match(/async function startListenerService\(\)[\s\S]+?(?=async function startWikiService)/)[0];
  const modSideService = backendSource.match(/async function startModSideService\(\)[\s\S]+?(?=async function startCaptureService)/)[0];
  assert.doesNotMatch(listenerService, /combat-simulator|combatSide/);
  assert.match(listenerService, /waitForChildren\(\[child\]\)/);
  assert.match(modSideService, /combat-simulator[^\r\n]+server\.js/);
  assert.match(modSideService, /waitForChildren\(\[child, combatSide\]\)/);
  assert.match(backendSource, /serve-modside\.js/);
  assert.match(backendSource, /emitService\('modside', 'running'/);
  assert.match(backendSource, /launcher\/api\/warmup/);
  assert.match(backendSource, /A frozen client already exists at/);
  const launcherHome = fs.readFileSync(path.join(__dirname, '..', 'launcher', 'src', 'games', 'revivalside', 'pages', 'Home', 'index.tsx'), 'utf8');
  assert.match(launcherHome, /cancelLabel: "Core tools only"/);
  assert.match(launcherHome, /!!snapshot\?\.frozenClientRoot/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'launcher', 'src', 'games', 'revivalside', 'pages', 'Home', 'ActionButton.tsx'), 'utf8'), /disabled=\{disabled\}/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'server', 'listener.js'), 'utf8'), /createAssetViewer|assetViewer\.handle/);
    console.log('[launcher-backend] PASS launcher settings, private PvP environment mapping, login backgrounds, client handling, service lifecycle, and readiness');
  } finally {
    if (hadLauncherSettings) fs.writeFileSync(launcherSettingsPath, launcherSettingsBackup);
    else fs.rmSync(launcherSettingsPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
