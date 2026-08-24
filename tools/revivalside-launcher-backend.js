'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const readline = require('readline');
const { findCounterSideScriptBundleRoots } = require('../modules/counterside-install');
const { getLoginBackgroundCatalog } = require('../modules/login-background');

const EVENT_PREFIX = '@@REVIVALSIDE_EVENT@@';
const GAME_PORTS = new Set(['20001', '20002', '20003', '20004', '22000']);
const LISTENER_READINESS_TIMEOUT_MS = 120_000;
const COMBAT_SIDE_PORT = 5185;
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download/windows';
const GAMEPLAY_CACHE_MANIFEST_NAME = '.revivalside-gameplay-luac-cache.json';
const GIB = 1024 ** 3;
const MODSIDE_MINIMUM_FREE_BYTES = 32 * GIB;
const FROZEN_CLIENT_PATCH_REQUIREMENTS = Object.freeze([
  'mod-runtime-loader=True',
  'mod-string-loader=True', 'mod-asset-bundle-loader=True', 'mod-episode-ui=True',
  'friendly-pvp-ui-fix=True', 'inventory-expansion-int-max=True',
  'steam-local-login=True', 'steam-standalone=True', 'steam-runtime-isolated=True',
  'steam-interop-callsites=0', 'frozen-official-update-bypass=True',
  'frozen-patch-download-bypass=True', 'frozen-contents-version-isolation=False',
  'frozen-login-contents-reconciliation=False', 'external-endpoint-references=0',
]);
const DEFAULT_SETTINGS = Object.freeze({
  SettingsVersion: 11,
  GamePort: 22000,
  HttpPort: 8088,
  WikiPort: 5174,
  ModSidePort: 5175,
  CounterSideManagedDir: '',
  CounterSideSourceManagedDir: '',
  CrossSaveCaptureDir: '',
  EventDate: '2025-04-10',
  LoginBackground: 'auto',
  JoinLobbyAckMode: 'auto',
  UserManagerAllowRemote: false,
  VerboseCapture: false,
  ReplayCapturedGameFlow: false,
  SkipTutorialToWin: false,
  ResetTutorialOnLogin: false,
  PrivatePvpMode: 'off',
  PrivatePvpPublicHost: '',
  PrivatePvpHostUrl: '',
  PrivatePvpRelayUrl: '',
  PrivatePvpRelaySecret: '',
  PrivatePvpRelayHostId: '',
  RelaySshHost: '',
  RelaySshPort: 22,
  RelaySshUser: '',
  RelaySshKeyPath: '',
  RelaySshHostKeyFingerprint: '',
  RelayHostname: '',
  RelayPort: 443,
  RelayTlsCertificatePath: '',
  RelayTlsPrivateKeyPath: '',
  RelayInstallPath: '/opt/revivalside-relay',
  MinimizeToTrayOnClose: true,
  NotifyTrayWhenServiceStops: true,
  AdvancedEnvText: '',
  CrossSaveSwitchActive: true,
  CrossSaveUpdateExisting: true,
  CrossSavePreserveUid: false,
  CrossSavePreserveFriendCode: false,
});
const root = resolveAppRoot();
const settingsPath = path.join(root, 'launcher-settings.json');
const installedRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'RevivalSide') : '';
const installedSettingsPath = installedRoot ? path.join(installedRoot, 'launcher-settings.json') : '';

function resolveAppRoot() {
  const configured = process.env.REVIVALSIDE_ROOT;
  if (configured && isAppRoot(configured)) return path.resolve(configured);
  const seeds = [process.cwd(), __dirname, path.dirname(process.execPath)];
  for (const seed of seeds) {
    let current = path.resolve(seed);
    while (true) {
      if (isAppRoot(current)) return current;
      const payloadApp = path.join(current, 'app');
      if (isAppRoot(payloadApp)) return payloadApp;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error('Could not locate the RevivalSide app root.');
}

function isAppRoot(directory) {
  return !!directory
    && fs.existsSync(path.join(directory, 'cs-listener.js'))
    && fs.existsSync(path.join(directory, 'package.json'));
}

function log(message, level = 'info') {
  process.stderr.write(`[${level}] ${String(message)}\n`);
}

function emitService(service, state, details = '') {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: 'service', service, state, details })}\n`);
}

function emitActionProgress(action, phase, progress) {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type: 'action-progress', action, phase, progress })}\n`);
}

function output(value) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...value })}\n`);
}

function clampPort(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : fallback;
}

function normalizeLobbyMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (['1', 'true', 'on', 'local'].includes(mode)) return 'on';
  if (['0', 'false', 'off', 'official'].includes(mode)) return 'off';
  return 'auto';
}

function normalizeLoginBackground(value) {
  const background = String(value || 'auto').trim();
  if (background.toLowerCase() === 'auto') return 'auto';
  return /^\d+$/.test(background) && Number(background) > 0 ? background : 'auto';
}

function normalizePrivatePvpMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return ['host', 'join', 'legacy-host', 'legacy-join'].includes(mode) ? mode : 'off';
}

function loadSettings() {
  let saved = {};
  let installed = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    // First launch or malformed legacy settings: use safe defaults.
  }
  try {
    if (installedSettingsPath && path.resolve(installedSettingsPath) !== path.resolve(settingsPath)) installed = JSON.parse(fs.readFileSync(installedSettingsPath, 'utf8'));
  } catch { /* installed launcher settings are optional */ }
  const savedSettingsVersion = Number(saved.SettingsVersion || 0);
  const settings = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [
    key,
    Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : value,
  ]));
  settings.SettingsVersion = DEFAULT_SETTINGS.SettingsVersion;
  settings.GamePort = clampPort(settings.GamePort, DEFAULT_SETTINGS.GamePort);
  settings.HttpPort = clampPort(settings.HttpPort, DEFAULT_SETTINGS.HttpPort);
  settings.WikiPort = clampPort(settings.WikiPort, DEFAULT_SETTINGS.WikiPort);
  settings.ModSidePort = clampPort(settings.ModSidePort, DEFAULT_SETTINGS.ModSidePort);
  settings.LoginBackground = normalizeLoginBackground(saved.LoginBackground);
  settings.JoinLobbyAckMode = normalizeLobbyMode(settings.JoinLobbyAckMode);
  settings.CounterSideManagedDir = normalizeExistingManagedDir(settings.CounterSideManagedDir) || normalizeExistingManagedDir(installed.CounterSideManagedDir);
  settings.CounterSideSourceManagedDir = normalizeExistingManagedDir(settings.CounterSideSourceManagedDir) || normalizeExistingManagedDir(installed.CounterSideSourceManagedDir);
  // A frozen client can be removed outside the launcher while its Managed
  // path remains in launcher-settings.json. Treat that stale path as not
  // installed and retain a valid official install as the next freeze source.
  if (!settings.CounterSideSourceManagedDir && settings.CounterSideManagedDir && !isFrozenManagedDir(settings.CounterSideManagedDir)) {
    settings.CounterSideSourceManagedDir = settings.CounterSideManagedDir;
  }
  settings.CrossSaveCaptureDir = String(settings.CrossSaveCaptureDir || '');
  settings.EventDate = String(settings.EventDate || '');
  settings.AdvancedEnvText = String(settings.AdvancedEnvText || '');
  settings.PrivatePvpMode = normalizePrivatePvpMode(settings.PrivatePvpMode);
  settings.PrivatePvpPublicHost = String(settings.PrivatePvpPublicHost || '').trim();
  settings.PrivatePvpHostUrl = String(settings.PrivatePvpHostUrl || '').trim();
  settings.PrivatePvpRelayUrl = String(settings.PrivatePvpRelayUrl || '').trim();
  settings.PrivatePvpRelaySecret = String(settings.PrivatePvpRelaySecret || '');
  settings.PrivatePvpRelayHostId = String(settings.PrivatePvpRelayHostId || '').trim();
  if (savedSettingsVersion < 11 && !settings.PrivatePvpRelayUrl && ['host', 'join'].includes(settings.PrivatePvpMode)) {
    settings.PrivatePvpMode = `legacy-${settings.PrivatePvpMode}`;
  }
  settings.RelaySshHost = String(settings.RelaySshHost || '').trim();
  settings.RelaySshPort = clampPort(settings.RelaySshPort, DEFAULT_SETTINGS.RelaySshPort);
  settings.RelaySshUser = String(settings.RelaySshUser || '').trim();
  settings.RelaySshKeyPath = String(settings.RelaySshKeyPath || '').trim();
  settings.RelaySshHostKeyFingerprint = String(settings.RelaySshHostKeyFingerprint || '').trim();
  settings.RelayHostname = String(settings.RelayHostname || '').trim();
  settings.RelayPort = clampPort(settings.RelayPort, DEFAULT_SETTINGS.RelayPort);
  settings.RelayTlsCertificatePath = String(settings.RelayTlsCertificatePath || '').trim();
  settings.RelayTlsPrivateKeyPath = String(settings.RelayTlsPrivateKeyPath || '').trim();
  settings.RelayInstallPath = String(settings.RelayInstallPath || DEFAULT_SETTINGS.RelayInstallPath).trim();
  for (const key of [
    'UserManagerAllowRemote', 'VerboseCapture', 'ReplayCapturedGameFlow',
    'SkipTutorialToWin', 'ResetTutorialOnLogin', 'MinimizeToTrayOnClose',
    'NotifyTrayWhenServiceStops', 'CrossSaveSwitchActive', 'CrossSaveUpdateExisting',
    'CrossSavePreserveUid', 'CrossSavePreserveFriendCode',
  ]) settings[key] = !!settings[key];
  applyDotEnvDefaults(settings, saved);
  return settings;
}

function applyDotEnvDefaults(settings, saved) {
  const values = readDotEnv(path.join(root, '.env'));
  const assignIfUnsaved = (field, envKey, map = (value) => value) => {
    if (Object.prototype.hasOwnProperty.call(saved, field) || values[envKey] == null) return;
    settings[field] = map(values[envKey]);
  };
  assignIfUnsaved('GamePort', 'CS_PORT', (value) => clampPort(value, settings.GamePort));
  assignIfUnsaved('HttpPort', 'CS_HTTP_MIRROR_PORT', (value) => clampPort(value, settings.HttpPort));
  assignIfUnsaved('EventDate', 'CS_EVENT_DATE', String);
  assignIfUnsaved('LoginBackground', 'CS_LOGIN_BACKGROUND', normalizeLoginBackground);
  assignIfUnsaved('JoinLobbyAckMode', 'CS_USE_LOCAL_JOIN_LOBBY_ACK', normalizeLobbyMode);
  assignIfUnsaved('UserManagerAllowRemote', 'CS_USER_MANAGER_ALLOW_REMOTE', parseBoolean);
  assignIfUnsaved('VerboseCapture', 'CS_VERBOSE_CAPTURE', parseBoolean);
  assignIfUnsaved('ReplayCapturedGameFlow', 'CS_REPLAY_CAPTURED_GAME_FLOW', parseBoolean);
  assignIfUnsaved('SkipTutorialToWin', 'CS_SKIP_TUTORIAL_TO_WIN', parseBoolean);
  assignIfUnsaved('ResetTutorialOnLogin', 'CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN', parseBoolean);
  assignIfUnsaved('PrivatePvpPublicHost', 'CS_PVP_PUBLIC_HOST', (value) => String(value).trim());
  assignIfUnsaved('PrivatePvpHostUrl', 'CS_PVP_HOST_URL', (value) => String(value).trim());
  assignIfUnsaved('PrivatePvpRelayUrl', 'CS_PVP_RELAY_URL', (value) => String(value).trim());
  assignIfUnsaved('PrivatePvpRelaySecret', 'CS_PVP_RELAY_SECRET', String);
  assignIfUnsaved('PrivatePvpRelayHostId', 'CS_PVP_RELAY_HOST_ID', (value) => String(value).trim());
  if (!Object.prototype.hasOwnProperty.call(saved, 'PrivatePvpMode')) {
    if (values.CS_PRIVATE_PVP === '0') settings.PrivatePvpMode = 'off';
    else if (values.CS_PVP_RELAY_URL && ['host', 'join'].includes(String(values.CS_PVP_RELAY_ROLE || '').toLowerCase())) settings.PrivatePvpMode = String(values.CS_PVP_RELAY_ROLE).toLowerCase();
    else if (values.CS_PVP_HOST_URL) settings.PrivatePvpMode = 'legacy-join';
    else if (parseBoolean(values.CS_PRIVATE_PVP) || values.CS_PVP_PUBLIC_HOST) settings.PrivatePvpMode = 'legacy-host';
  }
}

function settingsToClient(settings) {
  return {
    clientPath: settings.CounterSideManagedDir,
    sourceClientPath: settings.CounterSideSourceManagedDir,
    capturePath: crossSaveCaptureDir(settings),
    tcpPort: settings.GamePort,
    httpPort: settings.HttpPort,
    wikiPort: settings.WikiPort,
    modSidePort: settings.ModSidePort,
    eventDate: settings.EventDate,
    loginBackground: settings.LoginBackground,
    lobbyAck: settings.JoinLobbyAckMode,
    allowLanAccess: settings.UserManagerAllowRemote,
    verboseLogging: settings.VerboseCapture,
    replayCapturedGameFlow: settings.ReplayCapturedGameFlow,
    skipTutorial: settings.SkipTutorialToWin,
    resetTutorialOnLogin: settings.ResetTutorialOnLogin,
    privatePvpMode: settings.PrivatePvpMode,
    privatePvpPublicHost: settings.PrivatePvpPublicHost,
    privatePvpHostUrl: settings.PrivatePvpHostUrl,
    privatePvpRelayUrl: settings.PrivatePvpRelayUrl,
    privatePvpRelaySecret: settings.PrivatePvpRelaySecret,
    privatePvpRelayHostId: settings.PrivatePvpRelayHostId,
    relaySshHost: settings.RelaySshHost,
    relaySshPort: settings.RelaySshPort,
    relaySshUser: settings.RelaySshUser,
    relaySshKeyPath: settings.RelaySshKeyPath,
    relaySshHostKeyFingerprint: settings.RelaySshHostKeyFingerprint,
    relayHostname: settings.RelayHostname,
    relayPort: settings.RelayPort,
    relayTlsCertificatePath: settings.RelayTlsCertificatePath,
    relayTlsPrivateKeyPath: settings.RelayTlsPrivateKeyPath,
    relayInstallPath: settings.RelayInstallPath,
    minimizeToTray: settings.MinimizeToTrayOnClose,
    notifyServiceStops: settings.NotifyTrayWhenServiceStops,
    advancedEnvironment: settings.AdvancedEnvText,
    switchToImportedSave: settings.CrossSaveSwitchActive,
    updateMatchingImport: settings.CrossSaveUpdateExisting,
    keepOfficialUid: settings.CrossSavePreserveUid,
    keepOfficialFriendCode: settings.CrossSavePreserveFriendCode,
  };
}

function applyClientSettings(settings, client) {
  settings.GamePort = clampPort(client.tcpPort, settings.GamePort);
  settings.HttpPort = clampPort(client.httpPort, settings.HttpPort);
  settings.WikiPort = clampPort(client.wikiPort, settings.WikiPort);
  settings.ModSidePort = clampPort(client.modSidePort, settings.ModSidePort);
  settings.EventDate = String(client.eventDate || '').trim();
  settings.LoginBackground = normalizeLoginBackground(client.loginBackground);
  settings.JoinLobbyAckMode = normalizeLobbyMode(client.lobbyAck);
  settings.UserManagerAllowRemote = !!client.allowLanAccess;
  settings.VerboseCapture = !!client.verboseLogging;
  settings.ReplayCapturedGameFlow = !!client.replayCapturedGameFlow;
  settings.SkipTutorialToWin = !!client.skipTutorial;
  settings.ResetTutorialOnLogin = !!client.resetTutorialOnLogin;
  settings.PrivatePvpMode = normalizePrivatePvpMode(client.privatePvpMode);
  settings.PrivatePvpPublicHost = String(client.privatePvpPublicHost || '').trim();
  settings.PrivatePvpHostUrl = String(client.privatePvpHostUrl || '').trim();
  settings.PrivatePvpRelayUrl = String(client.privatePvpRelayUrl || '').trim();
  settings.PrivatePvpRelaySecret = String(client.privatePvpRelaySecret || '');
  settings.PrivatePvpRelayHostId = String(client.privatePvpRelayHostId || '').trim();
  settings.RelaySshHost = String(client.relaySshHost || '').trim();
  settings.RelaySshPort = clampPort(client.relaySshPort, settings.RelaySshPort || 22);
  settings.RelaySshUser = String(client.relaySshUser || '').trim();
  settings.RelaySshKeyPath = String(client.relaySshKeyPath || '').trim();
  settings.RelaySshHostKeyFingerprint = String(client.relaySshHostKeyFingerprint || '').trim();
  settings.RelayHostname = String(client.relayHostname || '').trim();
  settings.RelayPort = clampPort(client.relayPort, settings.RelayPort || 443);
  settings.RelayTlsCertificatePath = String(client.relayTlsCertificatePath || '').trim();
  settings.RelayTlsPrivateKeyPath = String(client.relayTlsPrivateKeyPath || '').trim();
  settings.RelayInstallPath = String(client.relayInstallPath || '/opt/revivalside-relay').trim();
  settings.MinimizeToTrayOnClose = !!client.minimizeToTray;
  settings.NotifyTrayWhenServiceStops = !!client.notifyServiceStops;
  settings.AdvancedEnvText = String(client.advancedEnvironment || '');
  settings.CrossSaveSwitchActive = client.switchToImportedSave !== false;
  settings.CrossSaveUpdateExisting = client.updateMatchingImport !== false;
  settings.CrossSavePreserveUid = !!client.keepOfficialUid;
  settings.CrossSavePreserveFriendCode = !!client.keepOfficialFriendCode;
  if (client.capturePath != null) settings.CrossSaveCaptureDir = String(client.capturePath).trim();
  if (client.clientPath != null) {
    const requested = String(client.clientPath).trim();
    if (!requested) {
      settings.CounterSideManagedDir = '';
    } else {
      const managed = normalizeManagedDir(requested);
      if (!isManagedDir(managed)) throw new Error('Select CounterSide Data\\Managed\\Assembly-CSharp.dll.');
      settings.CounterSideManagedDir = managed;
    }
  }
  if (client.sourceClientPath != null) {
    const source = String(client.sourceClientPath).trim();
    if (!source) settings.CounterSideSourceManagedDir = '';
    else settings.CounterSideSourceManagedDir = normalizeManagedDir(source);
  }
  saveSettings(settings);
  return settings;
}

function saveSettings(settings) {
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function readDotEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const raw of fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s+/i.test(line)) line = line.replace(/^export\s+/i, '');
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = unquote(line.slice(separator + 1).trim());
  }
  return values;
}

function parseBoolean(value) {
  return ['1', 'true', 'on', 'yes'].includes(String(value).trim().toLowerCase());
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeManagedDir(value) {
  if (!value) return '';
  try {
    let full = path.resolve(String(value).trim().replace(/^"|"$/g, ''));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) full = path.dirname(full);
    for (const candidate of [full, path.join(full, 'Data', 'Managed'), path.join(full, 'Managed')]) {
      if (isManagedDir(candidate)) return path.resolve(candidate);
    }
    return full;
  } catch {
    return '';
  }
}

function isManagedDir(directory) {
  return !!directory && fs.existsSync(path.join(directory, 'Assembly-CSharp.dll'));
}

function normalizeExistingManagedDir(value) {
  const managed = normalizeManagedDir(value);
  return isManagedDir(managed) ? managed : '';
}

function gameRootFromManaged(managed) {
  if (!managed) return '';
  const full = path.resolve(managed);
  if (path.basename(full).toLowerCase() === 'managed' && path.basename(path.dirname(full)).toLowerCase() === 'data') {
    return path.dirname(path.dirname(full));
  }
  return '';
}

function frozenArchiveRoot() {
  return path.join(root, 'frozen-client');
}

function isPathInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isFrozenRoot(directory) {
  const trustedArchives = [frozenArchiveRoot(), installedRoot && path.join(installedRoot, 'frozen-client')].filter(Boolean);
  return !!directory
    && trustedArchives.some((archive) => isPathInside(archive, directory))
    && fs.existsSync(path.join(directory, 'CounterSide.exe'))
    && isManagedDir(path.join(directory, 'Data', 'Managed'));
}

function isFrozenManagedDir(managed) {
  return isManagedDir(managed) && isFrozenRoot(gameRootFromManaged(managed));
}

function findInstalledClientManagedDir(settings = {}) {
  const configured = normalizeManagedDir(settings.CounterSideManagedDir);
  if (isFrozenManagedDir(configured)) return configured;
  const archiveRoot = frozenArchiveRoot();
  if (!fs.existsSync(archiveRoot)) return '';
  let candidates = [];
  try {
    candidates = fs.readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.install-'))
      .map((entry) => path.join(archiveRoot, entry.name))
      .filter(isFrozenRoot)
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  } catch {
    return '';
  }
  return candidates.length ? path.join(candidates[0], 'Data', 'Managed') : '';
}

function selectInstalledClient(settings, persist = false) {
  const managed = findInstalledClientManagedDir(settings);
  if (!managed) return '';
  if (path.resolve(settings.CounterSideManagedDir || '.') !== path.resolve(managed)) {
    settings.CounterSideManagedDir = managed;
    if (persist) saveSettings(settings);
  }
  return managed;
}

function crossSaveCaptureDir(settings) {
  const configured = String(settings.CrossSaveCaptureDir || '').trim().replace(/^"|"$/g, '');
  if (!configured || configured.toLowerCase().endsWith(path.join('server-data', 'captured-game-flow').toLowerCase())) {
    return path.join(root, 'captures');
  }
  return path.resolve(root, configured);
}

function findOnPath(name) {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const extensions = path.extname(name) ? [''] : String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name + extension);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function runtimeRoots() {
  const roots = [root, path.dirname(process.execPath), process.cwd()];
  const local = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'RevivalSide');
  if (local) roots.push(local);
  return [...new Set(roots.filter(Boolean).map((item) => path.resolve(item)))];
}

function resolveTool(name, relativeCandidates = []) {
  for (const base of runtimeRoots()) {
    for (const relative of relativeCandidates) {
      const candidate = path.join(base, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  const programRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  for (const base of programRoots) {
    const subdir = /(?:dumpcap|tshark)/i.test(name) ? 'Wireshark'
      : /tailscale/i.test(name) ? 'Tailscale'
        : /(?:node|npm)/i.test(name) ? 'nodejs' : '';
    const candidate = path.join(base, subdir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function toolPaths() {
  const arch = process.arch === 'arm64' ? 'win-arm64' : process.arch === 'ia32' ? 'win-x86' : 'win-x64';
  return {
    node: resolveTool('node.exe', [path.join('runtime', 'node', 'node.exe'), path.join('runtime-node', arch, 'node.exe')]) || process.execPath,
    npm: resolveTool('npm.cmd', [path.join('runtime', 'node', 'npm.cmd'), path.join('runtime-node', arch, 'npm.cmd')]),
    dotnet: resolveTool('dotnet.exe'),
    python: resolveTool('python.exe', [path.join('runtime', 'python', 'python.exe'), path.join('runtime-python', arch, 'python.exe')]) || resolveTool('py.exe'),
    dumpcap: resolveTool('dumpcap.exe', [path.join('runtime', 'Wireshark', 'dumpcap.exe'), path.join('runtime-wireshark', arch, 'dumpcap.exe')]),
    tshark: resolveTool('tshark.exe', [path.join('runtime', 'Wireshark', 'tshark.exe'), path.join('runtime-wireshark', arch, 'tshark.exe')]),
    ssh: resolveTool(process.platform === 'win32' ? 'ssh.exe' : 'ssh'),
    scp: resolveTool(process.platform === 'win32' ? 'scp.exe' : 'scp'),
    sshKeyscan: resolveTool(process.platform === 'win32' ? 'ssh-keyscan.exe' : 'ssh-keyscan'),
    sshKeygen: resolveTool(process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'),
    tailscale: resolveTool(process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'),
  };
}

function isTailscaleIpv4(value) {
  const parts = String(value || '').trim().split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127;
}

function normalizeTailscaleGuestAddress(value, defaultPort = 8088) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Paste the host code from the other RevivalSide launcher.');
  let target;
  try { target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); }
  catch { throw new Error('The Tailscale host code is not valid.'); }
  if (target.protocol !== 'http:' || target.username || target.password || (target.pathname && target.pathname !== '/') || target.search || target.hash) {
    throw new Error('The Tailscale host code must be a plain Tailscale IP or HTTP URL without credentials or a path.');
  }
  const hostname = target.hostname.toLowerCase();
  const magicDnsName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/i.test(hostname);
  if (!isTailscaleIpv4(hostname) && !magicDnsName) {
    throw new Error('Use the 100.x Tailscale code copied by the host, or a full .ts.net MagicDNS name.');
  }
  const port = clampPort(target.port || defaultPort, defaultPort);
  return { hostname, hostUrl: `http://${hostname}:${port}` };
}

function applyAdvancedEnvironment(environment, text) {
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^export\s+/i.test(line)) line = line.replace(/^export\s+/i, '');
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Invalid advanced env line: ${raw}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid advanced env key: ${key}`);
    environment[key] = unquote(line.slice(separator + 1).trim());
  }
}

function buildListenerEnvironment(settings) {
  const tools = toolPaths();
  const managed = normalizeManagedDir(settings.CounterSideManagedDir);
  const privatePvpMode = normalizePrivatePvpMode(settings.PrivatePvpMode);
  const relayRole = privatePvpMode === 'host' || privatePvpMode === 'join' ? privatePvpMode : 'off';
  const legacyHost = privatePvpMode === 'legacy-host';
  const legacyJoin = privatePvpMode === 'legacy-join';
  const legacyHostAddress = String(settings.PrivatePvpPublicHost || '').trim();
  const tailscaleHostAddress = legacyHost && isTailscaleIpv4(legacyHostAddress) ? legacyHostAddress : '';
  const environment = {
    ...process.env,
    CS_PORT: String(settings.GamePort),
    CS_HTTP_MIRROR_PORT: String(settings.HttpPort),
    CS_EVENT_DATE: String(settings.EventDate || '').trim(),
    CS_LOGIN_BACKGROUND: normalizeLoginBackground(settings.LoginBackground),
    CS_USE_LOCAL_JOIN_LOBBY_ACK: normalizeLobbyMode(settings.JoinLobbyAckMode),
    CS_USER_MANAGER_ALLOW_REMOTE: settings.UserManagerAllowRemote ? '1' : '0',
    CS_VERBOSE_CAPTURE: settings.VerboseCapture ? '1' : '0',
    CS_REPLAY_CAPTURED_GAME_FLOW: settings.ReplayCapturedGameFlow ? '1' : '0',
    CS_SKIP_TUTORIAL_TO_WIN: settings.SkipTutorialToWin ? '1' : '0',
    CS_RESET_TUTORIAL_PROGRESS_ON_LOGIN: settings.ResetTutorialOnLogin ? '1' : '0',
    CS_PRIVATE_PVP: privatePvpMode === 'off' ? '0' : '1',
    CS_PVP_PUBLIC_HOST: legacyHost ? legacyHostAddress : '',
    CS_PVP_HOST_URL: legacyJoin ? String(settings.PrivatePvpHostUrl || '').trim() : '',
    CS_PVP_RELAY_URL: relayRole === 'off' ? '' : String(settings.PrivatePvpRelayUrl || '').trim(),
    CS_PVP_RELAY_SECRET: relayRole === 'off' ? '' : String(settings.PrivatePvpRelaySecret || ''),
    CS_PVP_RELAY_HOST_ID: relayRole === 'host' ? String(settings.PrivatePvpRelayHostId || '').trim() : '',
    CS_PVP_RELAY_ROLE: relayRole,
    CS_GAME_LISTEN_HOST: legacyHost && !tailscaleHostAddress ? '0.0.0.0' : '127.0.0.1',
    CS_HTTP_LISTEN_HOST: legacyHost && !tailscaleHostAddress ? '0.0.0.0' : settings.UserManagerAllowRemote && !tailscaleHostAddress ? '0.0.0.0' : '127.0.0.1',
    CS_PVP_LISTEN_HOST: tailscaleHostAddress,
    CS_REQUIRE_FROZEN_CLIENT_PATCH: '1',
  };
  if (environment.CS_PVP_RELAY_URL) {
    environment.CS_GAME_LISTEN_HOST = '127.0.0.1';
    environment.CS_HTTP_LISTEN_HOST = '127.0.0.1';
    environment.CS_PVP_PUBLIC_HOST = '127.0.0.1';
    environment.CS_PVP_HOST_URL = '';
    environment.CS_PVP_LISTEN_HOST = '';
  }
  if (environment.CS_EVENT_DATE) environment.CS_EVENT_MANAGER = 'auto';
  if (tools.python) environment.CS_PYTHON_PATH = tools.python;
  const packagedCombat = path.join(root, 'combat-host', 'CombatHost.exe');
  if (fs.existsSync(packagedCombat)) {
    environment.CS_CSHARP_COMBAT_HOST_DLL = packagedCombat;
    environment.CS_COMBAT_HOST_PATH = packagedCombat;
  }
  applyAdvancedEnvironment(environment, settings.AdvancedEnvText);
  environment.CS_HTTP_MIRROR_HOST = '127.0.0.1';
  environment.CS_HTTP_MIRROR_BASE_URL = `http://127.0.0.1:${settings.HttpPort}`;
  for (const key of [
    'CS_COUNTERSIDE_MANAGED_DIR', 'COUNTERSIDE_MANAGED_DIR', 'CS_COUNTERSIDE_DIR',
    'CS_GAMEPLAY_TABLES_DIR', 'CS_GAMEPLAY_JSON_ROOTS', 'CS_GAMEPLAY_ASSET_SOURCE', 'CS_GAMEPLAY_TABLE_SOURCE',
    'CS_STAGE_TABLE_PATH', 'CS_MAP_TABLE_PATH',
  ]) {
    delete environment[key];
  }
  const gameplayOverridesDir = path.join(root, 'gameplay-jsons');
  if (fs.existsSync(gameplayOverridesDir)) environment.CS_GAMEPLAY_JSON_ROOTS = gameplayOverridesDir;
  if (isManagedDir(managed)) {
    environment.CS_COUNTERSIDE_MANAGED_DIR = managed;
    environment.COUNTERSIDE_MANAGED_DIR = managed;
    environment.CS_COUNTERSIDE_DIR = gameRootFromManaged(managed) || managed;
    const gameplayTablesDir = path.join(root, '.cache', 'gameplay-luac');
    environment.CS_GAMEPLAY_TABLES_DIR = gameplayTablesDir;
    environment.CS_GAMEPLAY_ASSET_SOURCE = 'installed';
    environment.CS_GAMEPLAY_TABLE_SOURCE = 'installed';
    if (isFrozenManagedDir(managed)) {
      environment.CS_REPLAY_CAPTURED_CONTENTS_VERSION = '0';
      environment.CS_REPLAY_CAPTURED_LOGIN_ACK = '0';
    }
  }
  return environment;
}

function validatePrivatePvpSettings(settings) {
  const mode = normalizePrivatePvpMode(settings.PrivatePvpMode);
  if (mode === 'off') return;
  if (mode === 'legacy-host') {
    if (!String(settings.PrivatePvpPublicHost || '').trim()) {
      throw new Error('Legacy P2P host mode requires the LAN or private-VPN guest address.');
    }
    return;
  }
  if (mode === 'legacy-join') {
    let target;
    try { target = new URL(String(settings.PrivatePvpHostUrl || '').trim()); }
    catch { throw new Error('Legacy P2P join mode requires a valid host URL.'); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Legacy P2P host URL must use HTTP or HTTPS without embedded credentials.');
    }
    return;
  }
  const relayUrl = String(settings.PrivatePvpRelayUrl || '').trim();
  if (!/^https:\/\//i.test(relayUrl)) throw new Error('Relay PvP mode requires an HTTPS relay URL.');
  if (String(settings.PrivatePvpRelaySecret || '').length < 32) {
    throw new Error('Relay PvP mode requires an access secret with at least 32 characters.');
  }
  if (mode === 'host' && !/^[A-Za-z0-9_-]{8,80}$/.test(String(settings.PrivatePvpRelayHostId || '').trim())) {
    throw new Error('Relay host mode requires an 8-80 character host relay ID.');
  }
}

function ensureRuntimeLayout(settings) {
  for (const directory of [
    'server-data', path.join('server-data', 'captured-flows'), path.join('server-data', 'captured-tcp'),
    path.join('server-data', 'captured-game-flow'), path.join('server-data', 'capture-extracts'),
    'exports', 'logs',
  ]) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.mkdirSync(crossSaveCaptureDir(settings), { recursive: true });
  const users = path.join(root, 'server-data', 'users.json');
  if (!fs.existsSync(users)) {
    const starter = path.join(root, 'server-data', 'starter-users.json');
    if (fs.existsSync(starter)) fs.copyFileSync(starter, users);
    else fs.writeFileSync(users, '{\n  "schemaVersion": 1,\n  "nextUserUid": "1000000001",\n  "nextFriendCode": "10000001",\n  "activeUserUid": "",\n  "users": {}\n}\n');
  }
}

function requireFile(relative, description) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`${description} was not found: ${file}`);
  return file;
}

function countFiles(directory, predicate, limit = Number.MAX_SAFE_INTEGER) {
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  const stack = [directory];
  while (stack.length && count < limit) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && predicate(full, entry.name)) count += 1;
      if (count >= limit) break;
    }
  }
  return count;
}

function assetInventory(directory) {
  let files = 0;
  let bytes = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.asset')) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  }
  return { files, bytes };
}

function estimateModSideRequiredBytes(sourceBytes) {
  return Math.max(MODSIDE_MINIMUM_FREE_BYTES, Math.ceil(Number(sourceBytes || 0) * 4.5));
}

function progressFromLine(line, start, span) {
  const match = String(line).match(/^\[(\d+)\/(\d+)\]/);
  if (!match || Number(match[2]) < 1) return null;
  return Math.min(99, Math.round(start + span * Math.min(Number(match[1]), Number(match[2])) / Number(match[2])));
}

function actionProgressReporter(phase, start, span) {
  let last = -1;
  return (line) => {
    const progress = progressFromLine(line, start, span);
    if (progress == null || progress <= last) return;
    last = progress;
    emitActionProgress('extract-modside-assets', phase, progress);
  };
}

function modSideAssetsReady() {
  const extractedRoot = path.join(root, 'extracted-assets', 'all');
  for (const manifestFile of [path.join(root, 'extracted-assets', 'manifest.json'), path.join(extractedRoot, 'manifest.json')]) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (Number(manifest.file_count || 0) > 0 && countFiles(extractedRoot, () => true, 1)) {
        return { ready: true, extractedRoot, fileCount: Number(manifest.file_count) };
      }
    } catch { /* missing or incomplete extraction */ }
  }
  return { ready: false, extractedRoot, fileCount: 0 };
}

function modSideAssetPreflight(settings) {
  const cached = modSideAssetsReady();
  if (cached.ready) return { ...cached, requiredGiB: 0, availableGiB: 0, hasSpace: true };
  const preferredManaged = normalizeManagedDir(settings.CounterSideSourceManagedDir);
  const managed = isManagedDir(preferredManaged) ? preferredManaged : normalizeManagedDir(settings.CounterSideManagedDir);
  if (!isManagedDir(managed)) throw new Error('Select an official CounterSide client before preparing Mod:Side assets.');
  const sourceRoot = gameRootFromManaged(managed);
  const inventory = assetInventory(sourceRoot);
  if (!inventory.files) throw new Error(`No Unity .asset bundles were found under ${sourceRoot}.`);
  const requiredBytes = estimateModSideRequiredBytes(inventory.bytes);
  const stats = fs.statfsSync(root);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  return {
    ...cached,
    sourceRoot,
    bundleCount: inventory.files,
    sourceGiB: Number((inventory.bytes / GIB).toFixed(1)),
    requiredGiB: Math.ceil(requiredBytes / GIB),
    availableGiB: Number((availableBytes / GIB).toFixed(1)),
    hasSpace: availableBytes >= requiredBytes,
  };
}

function pythonInvocation(python, args) {
  return path.basename(python).toLowerCase() === 'py.exe' ? { file: python, args: ['-3', ...args] } : { file: python, args };
}

async function extractModSideAssets(settings, confirmed) {
  if (!confirmed) throw new Error('Asset extraction requires confirmation after the free-space warning.');
  const preflight = modSideAssetPreflight(settings);
  if (preflight.ready) return preflight;
  if (!preflight.hasSpace) {
    throw new Error(`Mod:Side needs at least ${preflight.requiredGiB} GB free; only ${preflight.availableGiB} GB is available.`);
  }
  const tools = toolPaths();
  if (!tools.python) throw new Error('Python is required to extract Mod:Side assets.');
  const decryptScript = requireFile(path.join('tools', 'cs_asset_decrypt.py'), 'CounterSide asset decrypt helper');
  const extractScript = requireFile(path.join('tools', 'cs_extract_decrypted_assets.py'), 'CounterSide asset extract helper');
  const extractedParent = path.join(root, 'extracted-assets');
  const extractedRoot = path.join(extractedParent, 'all');
  const decryptedRoot = path.join(root, '.cache', 'modside-assets', 'decrypted');
  if (!isPathInside(root, extractedRoot) || !isPathInside(root, decryptedRoot)) throw new Error('Unsafe Mod:Side asset output path.');
  const environment = buildListenerEnvironment(settings);
  const probe = pythonInvocation(tools.python, ['-c', 'import UnityPy; from PIL import Image']);
  await runChecked(probe.file, probe.args, { env: environment, description: 'UnityPy asset support', logStdout: false });
  emitActionProgress('extract-modside-assets', 'decrypting', 0);
  fs.rmSync(extractedRoot, { recursive: true, force: true });
  fs.rmSync(decryptedRoot, { recursive: true, force: true });
  fs.mkdirSync(extractedParent, { recursive: true });
  fs.mkdirSync(decryptedRoot, { recursive: true });
  try {
    log(`Preparing ${preflight.bundleCount.toLocaleString()} Unity bundles for Mod:Side (${preflight.sourceGiB} GB source).`);
    const decrypt = pythonInvocation(tools.python, [
      '-u', decryptScript, 'decrypt-header', '--all-assets', '--root', preflight.sourceRoot,
      '--out-dir', decryptedRoot, '--overwrite',
    ]);
    await runChecked(decrypt.file, decrypt.args, {
      env: environment,
      description: 'CounterSide bundle decryption',
      logStdout: false,
      onStdoutLine: actionProgressReporter('decrypting', 0, 5),
    });
    const extract = pythonInvocation(tools.python, [
      '-u', extractScript, '--root', decryptedRoot, '--out-dir', extractedRoot,
      '--manifest', path.join(extractedParent, 'manifest.json'), '--overwrite-manifest',
    ]);
    await runChecked(extract.file, extract.args, {
      env: environment,
      description: 'CounterSide asset extraction',
      logStdout: false,
      onStdoutLine: actionProgressReporter('extracting', 5, 95),
    });
  } finally {
    fs.rmSync(path.join(root, '.cache', 'modside-assets'), { recursive: true, force: true });
  }
  const ready = modSideAssetsReady();
  if (!ready.ready) throw new Error('Mod:Side extraction finished without a valid extracted asset manifest.');
  emitActionProgress('extract-modside-assets', 'complete', 100);
  log(`Mod:Side assets ready: ${ready.fileCount.toLocaleString()} exported assets at ${ready.extractedRoot}.`);
  return { ...ready, requiredGiB: preflight.requiredGiB, availableGiB: preflight.availableGiB, hasSpace: true };
}

function gameplayStatus(settings) {
  const managed = normalizeManagedDir(settings.CounterSideManagedDir);
  if (!isManagedDir(managed)) return { ready: false, bundleCount: 0, cachedLuaCount: 0, description: 'Needs CounterSide' };
  const scriptRoots = findCounterSideScriptBundleRoots({ managedDir: managed });
  const bundleCount = scriptRoots.reduce(
    (count, candidate) => count + countFiles(candidate.root, (_file, name) => /^ab_script/i.test(name), 100000),
    0,
  );
  const cachedLuaCount = countFiles(path.join(root, '.cache', 'gameplay-luac'), (_file, name) => /\.(?:luac|lua)$/i.test(name));
  return {
    ready: bundleCount > 0,
    bundleCount,
    cachedLuaCount,
    description: bundleCount > 0 ? `${bundleCount.toLocaleString()} bundles / ${cachedLuaCount ? `${cachedLuaCount.toLocaleString()} luac` : 'cache pending'}` : 'No encrypted script bundles found',
  };
}

function verifyGameplayCacheSource(managedDir, cacheRoot) {
  const managed = normalizeManagedDir(managedDir);
  if (!isManagedDir(managed)) throw new Error('The frozen client Data\\Managed directory is unavailable.');
  const manifestFile = path.join(cacheRoot, GAMEPLAY_CACHE_MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    throw new Error(`Frozen gameplay cache manifest could not be read: ${error.message}`);
  }
  const recordedManaged = normalizeManagedDir(manifest && manifest.managedDir);
  if (path.resolve(recordedManaged || '.') !== path.resolve(managed)) {
    throw new Error(`Gameplay cache belongs to a different client: ${recordedManaged || '(missing Managed path)'}`);
  }
  const frozenRoot = gameRootFromManaged(managed);
  const scriptRoots = (Array.isArray(manifest.scriptRoots) ? manifest.scriptRoots : [])
    .map((entry) => path.resolve(String(entry && entry.root || '')))
    .filter(Boolean);
  if (!scriptRoots.length || scriptRoots.some((scriptRoot) => !isPathInside(frozenRoot, scriptRoot))) {
    throw new Error('Gameplay cache contains script assets outside the selected frozen client.');
  }
  return { managedDir: managed, frozenRoot, scriptRoots };
}

function routingStatus(settings) {
  const managed = selectInstalledClient(settings);
  if (!isFrozenManagedDir(managed)) return { state: 'missing', message: 'No frozen client installed. Select an official CounterSide client and freeze it first.' };
  const manifestFile = path.join(gameRootFromManaged(managed), 'revivalside-frozen-client.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* pending first patch */ }
  if (manifest.SteamRuntimeIsolated && manifest.PatchedAssemblySha256) {
    return { state: 'ready', message: `Frozen client ready for verified local routing on port ${settings.HttpPort}.` };
  }
  return { state: 'pending', message: 'Frozen client selected. Start will patch, isolate, and verify it.' };
}

function dependencyStatus() {
  const tools = toolPaths();
  let captureDriver = { available: false, path: 'Install Npcap from npcap.com' };
  if (tools.dumpcap && fs.existsSync(tools.dumpcap)) {
    const probe = childProcess.spawnSync(tools.dumpcap, ['-D'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    const detail = firstLine(probe.stderr) || (probe.error ? probe.error.message : 'No capture interfaces found');
    captureDriver = probe.status === 0 && String(probe.stdout || '').trim()
      ? { available: true, path: 'Detected by bundled dumpcap' }
      : { available: false, path: detail };
  }
  return {
    node: { available: !!tools.node && fs.existsSync(tools.node), path: tools.node || '' },
    npm: { available: !!tools.npm && fs.existsSync(tools.npm), path: tools.npm || '' },
    dotnet: { available: !!tools.dotnet && fs.existsSync(tools.dotnet), path: tools.dotnet || '' },
    python: { available: !!tools.python && fs.existsSync(tools.python), path: tools.python || '' },
    wireshark: { available: !!tools.dumpcap && !!tools.tshark, path: tools.dumpcap ? path.dirname(tools.dumpcap) : '' },
    captureDriver,
  };
}

function snapshot() {
  const settings = loadSettings();
  ensureRuntimeLayout(settings);
  selectInstalledClient(settings, true);
  const captureDir = crossSaveCaptureDir(settings);
  const captures = fs.existsSync(captureDir)
    ? fs.readdirSync(captureDir).filter((name) => /^counterside-all-.+\.pcapng$/i.test(name)).sort().reverse().slice(0, 20)
    : [];
  return {
    appRoot: root,
    settings: settingsToClient(settings),
    loginBackgrounds: getLoginBackgroundCatalog({ rootDir: root }).map(({ id, label, assetName, music, contentTag }) => ({ id, label, assetName, music, contentTag })),
    gameplay: gameplayStatus(settings),
    routing: routingStatus(settings),
    dependencies: dependencyStatus(),
    frozenClientRoot: isFrozenManagedDir(settings.CounterSideManagedDir) ? gameRootFromManaged(settings.CounterSideManagedDir) : '',
    captures,
  };
}

function commandDisplay(file, args) {
  return [file, ...args].map((item) => /\s/.test(item) ? `"${item}"` : item).join(' ');
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    log(`Running ${commandDisplay(file, args)}`, 'debug');
    const child = childProcess.spawn(file, args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (options.onStdoutLine) {
      readline.createInterface({ input: child.stdout }).on('line', options.onStdoutLine);
    }
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.logStdout !== false) {
        for (const line of text.replace(/\r/g, '').split('\n').filter(Boolean)) log(line, options.level || 'info');
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.replace(/\r/g, '').split('\n').filter(Boolean)) log(line, options.errorLevel || 'warn');
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

async function runChecked(file, args, options = {}) {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
    throw new Error(`${options.description || path.basename(file)} failed: ${detail}`);
  }
  return result;
}

async function getTailscaleStatus() {
  const tailscale = toolPaths().tailscale;
  if (!tailscale) {
    return {
      installed: false,
      connected: false,
      ip: '',
      state: 'NotInstalled',
      downloadUrl: TAILSCALE_DOWNLOAD_URL,
      message: 'Tailscale is not installed. The official Windows download page is ready to open.',
    };
  }
  const ipResult = await run(tailscale, ['ip', '-4'], { logStdout: false, errorLevel: 'debug' });
  const ip = String(ipResult.stdout || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).find(isTailscaleIpv4) || '';
  let state = ip ? 'Running' : 'Unknown';
  if (!ip) {
    const statusResult = await run(tailscale, ['status', '--json', '--peers=false'], { logStdout: false, errorLevel: 'debug' });
    try { state = String(JSON.parse(statusResult.stdout).BackendState || state); } catch { /* older or unavailable CLI */ }
  }
  return {
    installed: true,
    connected: !!ip,
    ip,
    state,
    downloadUrl: TAILSCALE_DOWNLOAD_URL,
    message: ip ? `Tailscale is connected as ${ip}.` : state === 'NeedsLogin'
      ? 'Tailscale is installed but needs you to sign in.'
      : 'Tailscale is installed but is not connected.',
  };
}

function tailscaleLoginUrl(output) {
  const match = String(output || '').match(/https:\/\/login\.tailscale\.com\/[A-Za-z0-9_?&=./%-]+/i);
  return match ? match[0] : '';
}

async function ensureTailscaleConnected() {
  let status = await getTailscaleStatus();
  if (!status.installed || status.connected) return status;
  const tailscale = toolPaths().tailscale;
  const command = status.state === 'NeedsLogin' ? 'login' : 'up';
  const connected = await run(tailscale, [command, '--timeout=20s'], { logStdout: false, errorLevel: 'debug' });
  const loginUrl = tailscaleLoginUrl(`${connected.stdout}\n${connected.stderr}`);
  status = await getTailscaleStatus();
  if (status.connected) return status;
  return {
    ...status,
    loginUrl,
    message: loginUrl
      ? 'Finish the Tailscale sign-in in your browser, then click the same launcher button again.'
      : 'Tailscale could not connect. Open Tailscale, sign in, then click the same launcher button again.',
  };
}

async function configureTailscaleLegacyHost() {
  const status = await ensureTailscaleConnected();
  if (!status.connected) return status;
  const settings = loadSettings();
  settings.PrivatePvpMode = 'legacy-host';
  settings.PrivatePvpPublicHost = status.ip;
  settings.PrivatePvpHostUrl = '';
  saveSettings(settings);
  const shareCode = `http://${status.ip}:${settings.HttpPort}`;
  return {
    ...status,
    configured: true,
    shareCode,
    settings: settingsToClient(settings),
    message: `Legacy P2P host is ready. Share code copied: ${shareCode}`,
  };
}

async function configureTailscaleLegacyGuest(value) {
  const status = await ensureTailscaleConnected();
  if (!status.connected) return status;
  const settings = loadSettings();
  const target = normalizeTailscaleGuestAddress(value, settings.HttpPort);
  const reachable = await run(toolPaths().tailscale, ['ping', '--c=1', '--timeout=5s', target.hostname], {
    logStdout: false,
    errorLevel: 'debug',
  });
  if (reachable.code !== 0) {
    throw new Error('That host is not reachable through Tailscale. Make sure both PCs are signed into the same tailnet and the host PC is online.');
  }
  settings.PrivatePvpMode = 'legacy-join';
  settings.PrivatePvpHostUrl = target.hostUrl;
  settings.PrivatePvpPublicHost = '';
  saveSettings(settings);
  return {
    ...status,
    configured: true,
    hostUrl: target.hostUrl,
    settings: settingsToClient(settings),
    message: `Legacy P2P guest is ready for ${target.hostUrl}.`,
  };
}

function firstLine(value) {
  return String(value || '').replace(/\r/g, '').split('\n').find((line) => line.trim()) || '';
}

function createClientPatcher(settings, status = false) {
  const managed = normalizeManagedDir(settings.CounterSideManagedDir);
  if (!isManagedDir(managed)) throw new Error('CounterSide Data\\Managed\\Assembly-CSharp.dll is not selected.');
  const packaged = path.join(root, 'tools', 'CounterPassClientPatcher', 'CounterPassClientPatcher.exe');
  const project = path.join(root, 'tools', 'CounterPassClientPatcher', 'CounterPassClientPatcher.csproj');
  const args = ['--managed-dir', managed, '--include-steam-local-login'];
  if (isFrozenManagedDir(managed)) {
    args.push('--include-frozen-official-update-bypass', '--frozen-server-info-url', `http://127.0.0.1:${settings.HttpPort}/server_config/live/ServerInfo_V2.json`);
  }
  if (status) args.push('--status');
  if (fs.existsSync(packaged)) return { file: packaged, args };
  const tools = toolPaths();
  if (fs.existsSync(project) && tools.dotnet) return { file: tools.dotnet, args: ['run', '--project', project, '--', ...args] };
  throw new Error('CounterSide client patcher was not found.');
}

async function ensureClientPatch(settings, requireFrozen = true) {
  if (requireFrozen && !isFrozenManagedDir(settings.CounterSideManagedDir)) {
    throw new Error('No frozen client is installed. Select an official CounterSide client and use Freeze Selected CounterSide Client first.');
  }
  log('Checking CounterSide client patch...');
  const patch = createClientPatcher(settings, false);
  await runChecked(patch.file, patch.args, { env: buildListenerEnvironment(settings), description: 'Client patch' });
  if (isFrozenManagedDir(settings.CounterSideManagedDir)) {
    const status = createClientPatcher(settings, true);
    const result = await runChecked(status.file, status.args, { env: buildListenerEnvironment(settings), description: 'Client routing audit' });
    const missing = FROZEN_CLIENT_PATCH_REQUIREMENTS.filter((value) => !result.stdout.includes(value));
    if (missing.length) throw new Error(`Frozen client routing verification failed. Missing status: ${missing.join(', ')}`);
    log('Controlled frozen-client routing verified.');
  }
}

async function ensureGameplayCache(settings, force) {
  const status = gameplayStatus(settings);
  if (!status.ready) throw new Error(status.description);
  const script = requireFile(path.join('tools', 'ensure-gameplay-assets.js'), 'Gameplay asset cache helper');
  const tools = toolPaths();
  const args = [script, '--managed-dir', normalizeManagedDir(settings.CounterSideManagedDir), '--progress-json'];
  if (force) args.push('--force');
  await runChecked(tools.node, args, { env: buildListenerEnvironment(settings), description: 'Gameplay asset cache' });
  const verified = gameplayStatus(settings);
  if (!verified.cachedLuaCount) throw new Error('Gameplay asset cache completed without producing Lua files.');
  return verified;
}

async function ensureWikiCache(settings, force) {
  const managed = normalizeManagedDir(settings.CounterSideManagedDir);
  if (!isManagedDir(managed)) throw new Error('Select CounterSide before opening the wiki.');
  const script = requireFile(path.join('tools', 'ensure-wiki-assets.js'), 'Wiki asset cache helper');
  const args = [script, '--managed-dir', managed];
  if (force) args.push('--force');
  await runChecked(toolPaths().node, args, { env: buildListenerEnvironment(settings), description: 'Wiki asset cache' });
  return countFiles(path.join(root, '.cache', 'wiki-assets', 'all'), (_file, name) => name.toLowerCase().endsWith('.png'));
}

function findSteamRoots() {
  const roots = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const full = path.resolve(String(candidate).trim().replace(/^"|"$/g, '').replace(/\\\\/g, '\\'));
    if (fs.existsSync(full)) roots.add(full);
  };
  for (const candidate of [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    'C:\\Steam', 'D:\\Steam', 'E:\\Steam',
  ]) add(candidate);
  if (process.platform === 'win32') {
    for (const query of [
      ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
      ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
      ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
    ]) {
      try {
        const text = childProcess.execFileSync('reg.exe', ['query', query[0], '/v', query[1]], { encoding: 'utf8', windowsHide: true });
        const match = text.match(/REG_SZ\s+(.+)$/im);
        if (match) add(match[1]);
      } catch { /* registry key absent */ }
    }
  }
  for (const steamRoot of [...roots]) {
    const libraries = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(libraries)) continue;
    const text = fs.readFileSync(libraries, 'utf8');
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) add(match[1]);
  }
  return [...roots];
}

function detectManagedDir() {
  const settings = loadSettings();
  const candidates = [
    settings.CounterSideSourceManagedDir,
    isFrozenManagedDir(settings.CounterSideManagedDir) ? '' : settings.CounterSideManagedDir,
    process.env.CS_COUNTERSIDE_MANAGED_DIR,
    process.env.COUNTERSIDE_MANAGED_DIR,
    process.env.CS_COUNTERSIDE_DIR,
    'C:\\Main\\Gaming\\Steam\\steamapps\\common\\CounterSide',
  ];
  for (const library of findSteamRoots()) {
    const common = path.join(library, 'steamapps', 'common');
    for (const known of ['CounterSide', 'CounterSide Global', 'COUNTER SIDE']) candidates.push(path.join(common, known));
    try {
      for (const entry of fs.readdirSync(common, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.replace(/\s/g, '').toLowerCase().includes('counterside')) candidates.push(path.join(common, entry.name));
      }
    } catch { /* missing library */ }
  }
  for (const candidate of candidates) {
    const managed = normalizeManagedDir(candidate);
    if (!isManagedDir(managed)) continue;
    if (isFrozenManagedDir(managed)) continue;
    settings.CounterSideSourceManagedDir = managed;
    saveSettings(settings);
    return managed;
  }
  throw new Error('CounterSide Data\\Managed\\Assembly-CSharp.dll was not found automatically.');
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function ensureClientAvailable(settings) {
  const managed = selectInstalledClient(settings, true);
  if (managed) {
    return { frozenRoot: gameRootFromManaged(managed), managedDir: managed };
  }
  throw new Error('No frozen client is installed. Select an official CounterSide client and use Freeze Selected CounterSide Client first.');
}

async function enumerateFiles(directory) {
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

async function isolateSteamRuntime(frozenRoot) {
  const disabled = path.join(frozenRoot, 'revivalside-disabled', 'steam-runtime');
  let quarantined = 0;
  for (const file of await enumerateFiles(frozenRoot)) {
    if (isPathInside(disabled, file)) continue;
    const name = path.basename(file).toLowerCase();
    if (name === 'steam_appid.txt') await fsp.rm(file, { force: true });
    else if (/^steam_api.*\.dll$/i.test(name)) {
      const destination = path.join(disabled, `${path.relative(frozenRoot, file)}.revivalside-disabled`);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await fsp.rename(file, destination).catch(async () => {
        await fsp.copyFile(file, destination);
        await fsp.rm(file, { force: true });
      });
      quarantined += 1;
    }
  }
  const active = (await enumerateFiles(frozenRoot)).filter((file) => {
    if (isPathInside(disabled, file)) return false;
    const name = path.basename(file).toLowerCase();
    return name === 'steam_appid.txt' || /^steam_api.*\.dll$/i.test(name);
  });
  if (active.length) throw new Error('Frozen client Steam runtime isolation failed; active Steam bootstrap files remain.');
  const executable = path.join(frozenRoot, 'CounterSide.exe');
  const executableText = (await fsp.readFile(executable)).toString('latin1');
  const marker = ['steam_api.dll', 'steam_api64.dll', 'SteamAPI_RestartAppIfNecessary', 'steam://run/']
    .find((value) => executableText.toLowerCase().includes(value.toLowerCase()));
  if (marker) throw new Error(`Frozen CounterSide.exe contains a native Steam bootstrap marker: ${marker}`);
  return quarantined;
}

function writeLaunchFiles(targetRoot) {
  fs.rmSync(path.join(targetRoot, 'steam_appid.txt'), { force: true });
  fs.writeFileSync(path.join(targetRoot, 'Launch Offline CounterSide.bat'), '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0CounterSide.exe"\r\n', 'ascii');
}

async function updateFrozenClientManifest(frozenRoot, managed) {
  const manifestFile = path.join(frozenRoot, 'revivalside-frozen-client.json');
  let manifest = {};
  try { manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8')); } catch { /* create a repair manifest */ }
  manifest.RootDir = frozenRoot;
  manifest.ManagedDir = managed;
  manifest.PatchedAtUtc = new Date().toISOString();
  manifest.PatchedAssemblySha256 = await hashFile(path.join(managed, 'Assembly-CSharp.dll'));
  manifest.SteamRuntimeIsolated = true;
  await fsp.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function freezeClient() {
  const settings = loadSettings();
  const existingManaged = findInstalledClientManagedDir(settings);
  if (existingManaged) throw new Error(`A frozen client already exists at ${gameRootFromManaged(existingManaged)}. Remove it before freezing another.`);
  const sourceManaged = normalizeManagedDir(settings.CounterSideSourceManagedDir || settings.CounterSideManagedDir);
  const sourceRoot = gameRootFromManaged(sourceManaged);
  if (!isManagedDir(sourceManaged) || !fs.existsSync(path.join(sourceRoot, 'CounterSide.exe'))) {
    throw new Error('Select or detect CounterSide Data\\Managed\\Assembly-CSharp.dll before freezing the client.');
  }
  if (isFrozenManagedDir(sourceManaged)) throw new Error('That client is already frozen. Select an official CounterSide install as the source.');
  if (isPathInside(sourceRoot, frozenArchiveRoot())) throw new Error('Refusing to archive into a folder below the source game root.');
  await fsp.mkdir(frozenArchiveRoot(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const targetRoot = path.join(frozenArchiveRoot(), `CounterSide-${stamp}`);
  if (fs.existsSync(targetRoot)) throw new Error(`Frozen archive already exists: ${targetRoot}`);
  log(`Freezing CounterSide client from ${sourceRoot}`);
  const files = await enumerateFiles(sourceRoot);
  let copied = 0;
  let bytes = 0;
  for (const source of files) {
    const destination = path.join(targetRoot, path.relative(sourceRoot, source));
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    const stat = await fsp.stat(destination);
    copied += 1;
    bytes += stat.size;
    if (copied % 250 === 0) log(`Freeze copy: ${copied.toLocaleString()} / ${files.length.toLocaleString()} files (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  const managed = path.join(targetRoot, path.relative(sourceRoot, sourceManaged));
  if (!isManagedDir(managed)) throw new Error(`Frozen client is missing Assembly-CSharp.dll: ${managed}`);
  writeLaunchFiles(targetRoot);
  const manifest = {
    ArchivedAtUtc: new Date().toISOString(),
    SourceRoot: sourceRoot,
    RootDir: targetRoot,
    ManagedDir: managed,
    FileCount: copied,
    ByteCount: bytes,
    AssemblySha256: await hashFile(path.join(managed, 'Assembly-CSharp.dll')),
    PatchedAtUtc: null,
    PatchedAssemblySha256: '',
    SteamRuntimeIsolated: false,
  };
  fs.writeFileSync(path.join(targetRoot, 'revivalside-frozen-client.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  settings.CounterSideManagedDir = managed;
  settings.CounterSideSourceManagedDir = sourceManaged;
  saveSettings(settings);
  await ensureClientPatch(settings, true);
  const quarantined = await isolateSteamRuntime(targetRoot);
  await updateFrozenClientManifest(targetRoot, managed);
  log(`Frozen client ready: ${targetRoot}`);
  return { frozenRoot: targetRoot, managedDir: managed, fileCount: copied, byteCount: bytes, quarantined };
}

async function launchClient({ clientPatchVerified = false } = {}) {
  const settings = loadSettings();
  selectInstalledClient(settings, true);
  const managed = normalizeManagedDir(settings.CounterSideManagedDir);
  const frozenRoot = gameRootFromManaged(managed);
  if (!isFrozenRoot(frozenRoot)) throw new Error('No frozen client is installed. Freeze a CounterSide client first.');
  if (!clientPatchVerified) await ensureClientPatch(settings, true);
  const quarantined = await isolateSteamRuntime(frozenRoot);
  writeLaunchFiles(frozenRoot);
  await updateFrozenClientManifest(frozenRoot, managed);
  const executable = path.join(frozenRoot, 'CounterSide.exe');
  const environment = { ...process.env };
  for (const key of ['SteamAppId', 'SteamGameId', 'SteamClientLaunch', 'SteamEnv', 'SteamPath']) delete environment[key];
  const modRuntimeDir = path.join(root, 'mods', '.runtime', 'current');
  if (fs.existsSync(path.join(modRuntimeDir, 'mod-set.json'))) {
    environment.CS_MOD_TABLES_DIR = modRuntimeDir;
    environment.CS_MOD_STRINGS_DIR = path.join(modRuntimeDir, 'Strings');
    environment.CS_MOD_ASSET_BUNDLES_DIR = path.join(modRuntimeDir, 'ClientAssetBundles');
  } else {
    for (const key of ['CS_MOD_TABLES_DIR', 'CS_MOD_STRINGS_DIR', 'CS_MOD_ASSET_BUNDLES_DIR']) delete environment[key];
  }
  const child = childProcess.spawn(executable, [], { cwd: frozenRoot, env: environment, detached: true, windowsHide: false, stdio: 'ignore' });
  child.unref();
  log(`Launched Steam-isolated frozen CounterSide (${quarantined} files newly quarantined).`);
  return { executable, pid: child.pid };
}

function writeServerTime(iso) {
  const server = new Date(iso);
  if (Number.isNaN(server.valueOf())) throw new Error('Server time must be a valid date and time.');
  const now = new Date();
  const day = (date) => date.toISOString().slice(0, 10);
  const state = {
    version: 1,
    eventDateKey: day(server),
    anchorServerDateKey: day(server),
    anchorLocalDayKey: day(now),
    lastLocalDayKey: day(now),
    lastServerDateKey: day(server),
    manualServerIso: server.toISOString(),
    manualLocalIso: now.toISOString(),
    manualSetAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const file = path.join(root, 'server-data', 'server-time.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

async function postJson(url, value, timeoutMs = 3000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Listener request failed: HTTP ${response.status} ${url}`);
  if (!body || body.ok !== true) throw new Error((body && body.error) || `Listener returned an invalid response for ${url}`);
  return body;
}

async function listCaptureInterfaces(dumpcap) {
  const result = await runChecked(dumpcap, ['-D'], { description: 'dumpcap interface scan' });
  const interfaces = [];
  for (const line of result.stdout.replace(/\r/g, '').split('\n')) {
    const match = line.trim().match(/^(\d+)\.\s+(.+?)(?:\s+\((.+)\))?\s*$/);
    if (match) interfaces.push({ id: match[1], name: match[3] || match[2] });
  }
  return interfaces;
}

function pipeServiceChild(child, prefix = '', onLine = null) {
  const forward = (stream, target, level) => {
    const lines = readline.createInterface({ input: stream });
    lines.on('line', (line) => {
      target.write(`${prefix}${level ? `[${level}] ` : ''}${line}\n`);
      if (onLine) onLine(line);
    });
  };
  if (child.stdout) forward(child.stdout, process.stdout, '');
  if (child.stderr) forward(child.stderr, process.stderr, 'warn');
}

function stopChildProcess(child) {
  if (!child || !child.pid || child.exitCode != null) return;
  try {
    if (process.platform === 'win32') childProcess.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch { /* best effort */ }
}

function createListenerReadinessGate(settings, timeoutMs = LISTENER_READINESS_TIMEOUT_MS, environment = buildListenerEnvironment(settings)) {
  const gameHosts = [...new Set([environment.CS_GAME_LISTEN_HOST, environment.CS_PVP_LISTEN_HOST].filter(Boolean))];
  const httpHosts = [...new Set([environment.CS_HTTP_LISTEN_HOST, environment.CS_PVP_LISTEN_HOST].filter(Boolean))];
  const signals = new Map([
    ...gameHosts.map((host) => [`game listener ${host}`, `[+] Listening on ${host}:${settings.GamePort}`]),
    ...httpHosts.map((host) => [`HTTP services ${host}`, `[+] HTTP services listening on ${host}:${settings.HttpPort}`]),
    ['captured HTTP mirror', `[+] Captured HTTP mirror listening on http://127.0.0.1:${settings.HttpPort}`],
    ['captured fixture directory', '[+] Captured HTTP mirror fixtureDir='],
    ['User Manager', `[+] User manager listening on http://127.0.0.1:${settings.HttpPort}/user-manager`],
  ]);
  const observed = new Set();
  let settled = false;
  let resolveReady;
  let rejectReady;
  const missing = () => [...signals.keys()].filter((name) => !observed.has(name));
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error(`Listener did not become ready within ${Math.round(timeoutMs / 1000)} seconds. Missing: ${missing().join(', ') || 'none'}.`));
  }, timeoutMs);

  const complete = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectReady(error);
    else resolveReady();
  };
  return {
    ready,
    observe(line) {
      for (const [name, marker] of signals) {
        if (String(line).includes(marker)) observed.add(name);
      }
      if (missing().length === 0) complete();
    },
    fail(error) {
      complete(error instanceof Error ? error : new Error(String(error)));
    },
    missing,
  };
}

async function waitForChildren(children) {
  const stop = () => {
    for (const child of children) stopChildProcess(child);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  const code = await new Promise((resolve) => {
    let remaining = children.length;
    let firstCode = 0;
    const exited = (value) => {
      if (value && !firstCode) firstCode = value;
      remaining -= 1;
      if (remaining === 0) resolve(firstCode);
    };
    for (const child of children) {
      if (child.exitCode != null) exited(child.exitCode);
      else child.once('exit', exited);
    }
  });
  process.exitCode = code;
}

async function startListenerService() {
  const settings = loadSettings();
  validatePrivatePvpSettings(settings);
  ensureRuntimeLayout(settings);
  for (const [relative, description] of [
    ['cs-listener.js', 'Listener entry'], ['packet-schema.json', 'Packet schema'],
    [path.join('tools', 'ensure-gameplay-assets.js'), 'Gameplay cache helper'],
    [path.join('server-data', 'captured-flows', 'manifest.json'), 'Captured mirror manifest'],
  ]) requireFile(relative, description);
  emitService('listener', 'starting', 'Checking RevivalSide client');
  const client = ensureClientAvailable(settings);
  emitService('listener', 'starting', 'Preparing offline client');
  await ensureGameplayCache(settings, false);
  const gameplaySource = verifyGameplayCacheSource(client.managedDir, path.join(root, '.cache', 'gameplay-luac'));
  const environment = buildListenerEnvironment(settings);
  log(`Frozen Managed runtime source: ${gameplaySource.managedDir}`);
  log(`Frozen gameplay script roots: ${gameplaySource.scriptRoots.join('; ')}`);
  emitService('listener', 'starting', 'Patching and auditing client');
  await ensureClientPatch(settings, true);
  const tools = toolPaths();
  const child = childProcess.spawn(tools.node, [path.join(root, 'cs-listener.js')], {
    cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const readiness = createListenerReadinessGate(settings, LISTENER_READINESS_TIMEOUT_MS, environment);
  const onExitBeforeReady = (code) => readiness.fail(new Error(`Listener exited with code ${code ?? 'unknown'} before reporting ready.`));
  const onErrorBeforeReady = (error) => readiness.fail(error);
  child.once('exit', onExitBeforeReady);
  child.once('error', onErrorBeforeReady);
  pipeServiceChild(child, '', readiness.observe);
  emitService('listener', 'starting', 'Waiting for local services');
  try {
    await readiness.ready;
  } catch (error) {
    stopChildProcess(child);
    throw error;
  } finally {
    child.removeListener('exit', onExitBeforeReady);
    child.removeListener('error', onErrorBeforeReady);
  }

  log('Listener ready: game port, captured HTTP mirror, fixture directory, and User Manager are listening.');
  emitService('listener', 'starting', 'Optimizing lobby');
  await postJson(`http://127.0.0.1:${settings.HttpPort}/launcher/api/warmup`, {}, LISTENER_READINESS_TIMEOUT_MS);
  emitService('listener', 'starting', 'Launching frozen client');
  await launchClient({ clientPatchVerified: true });
  emitService('listener', 'running', `Offline client launched | TCP ${settings.GamePort} / HTTP ${settings.HttpPort}`);
  await waitForChildren([child]);
}

async function startWikiService() {
  const settings = loadSettings();
  ensureRuntimeLayout(settings);
  const script = requireFile(path.join('tools', 'serve-revivalside-wiki.js'), 'Wiki server');
  const child = childProcess.spawn(toolPaths().node, [script, '--port', String(settings.WikiPort)], {
    cwd: root, env: buildListenerEnvironment(settings), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeServiceChild(child);
  emitService('wiki', 'running', `http://127.0.0.1:${settings.WikiPort}/`);
  await waitForChildren([child]);
}

async function startModSideService() {
  const settings = loadSettings();
  ensureRuntimeLayout(settings);
  const script = requireFile(path.join('tools', 'serve-modside.js'), 'Mod:Side server');
  const combatScript = requireFile(path.join('combat-simulator', 'server.js'), 'Combat:Side server');
  const environment = buildListenerEnvironment(settings);
  const child = childProcess.spawn(toolPaths().node, [script, '--port', String(settings.ModSidePort)], {
    cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const combatSide = childProcess.spawn(toolPaths().node, [combatScript, '--port', String(COMBAT_SIDE_PORT)], {
    cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeServiceChild(child);
  pipeServiceChild(combatSide, '[Combat:Side] ');
  emitService('modside', 'running', `http://127.0.0.1:${settings.ModSidePort}/mod-side`);
  await waitForChildren([child, combatSide]);
}

async function startCaptureService() {
  const settings = loadSettings();
  ensureRuntimeLayout(settings);
  const dumpcap = toolPaths().dumpcap;
  if (!dumpcap || !fs.existsSync(dumpcap)) throw new Error('Bundled dumpcap.exe was not found. Reinstall RevivalSide.');
  let interfaces;
  try {
    interfaces = await listCaptureInterfaces(dumpcap);
  } catch (error) {
    throw new Error(`Packet capture is unavailable. Install Npcap, then retry. ${error.message}`);
  }
  if (!interfaces.length) throw new Error('No capture interfaces were found. Install Npcap, then retry.');
  const captureDir = crossSaveCaptureDir(settings);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(captureDir, `counterside-all-interfaces-${stamp}.pcapng`);
  const args = ['-s', '0', '-f', 'tcp'];
  for (const iface of interfaces) args.push('-i', iface.id);
  args.push('-Q', '-w', file);
  const child = childProcess.spawn(dumpcap, args, {
    cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  pipeServiceChild(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`dumpcap exited during startup (${code ?? 'unknown'}). See Logs for details.`)); });
  });
  emitService('capture', 'running', `${interfaces.length} interfaces / ${path.basename(file)}`);
  await waitForChildren([child]);
}

function newestCaptureStamp(captureDir) {
  if (!fs.existsSync(captureDir)) return '';
  const matches = fs.readdirSync(captureDir).map((name) => ({ name, match: name.match(/^counterside-all-.+-(\d{8}-?\d{6})\.pcapng$/i) }))
    .filter((item) => item.match)
    .sort((a, b) => fs.statSync(path.join(captureDir, b.name)).mtimeMs - fs.statSync(path.join(captureDir, a.name)).mtimeMs);
  return matches[0] ? matches[0].match[1] : '';
}

async function candidateStreams(tshark, pcap) {
  const result = await run(tshark, [
    '-r', pcap, '-Y', 'tcp.len > 0', '-T', 'fields', '-E', 'separator=\t',
    '-e', 'tcp.stream', '-e', 'tcp.srcport', '-e', 'tcp.dstport', '-e', 'tcp.len',
  ], { description: 'tshark stream scan', logStdout: false });
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(`tshark stream scan failed: ${firstLine(result.stderr) || `exit code ${result.code}`}`);
  }
  const streams = new Map();
  for (const line of result.stdout.replace(/\r/g, '').split('\n')) {
    const parts = line.split('\t');
    const id = Number(parts[0]);
    if (!Number.isInteger(id) || parts.length < 4) continue;
    const current = streams.get(id) || { id, bytes: 0, gamePort: false };
    current.bytes += Math.max(0, Number(parts[3]) || 0);
    current.gamePort ||= GAME_PORTS.has(parts[1]) || GAME_PORTS.has(parts[2]);
    streams.set(id, current);
  }
  return [...streams.values()].filter((item) => item.bytes >= 64)
    .sort((a, b) => Number(b.gamePort) - Number(a.gamePort) || b.bytes - a.bytes).slice(0, 1000);
}

function loadCrossSaveSources(captureDir) {
  const manifestFile = path.join(captureDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return [];
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const result = [];
  let index = 0;
  for (const entry of Array.isArray(manifest.server) ? manifest.server : []) {
    index += 1;
    if (Number(entry.packetId) !== 205 || !entry.payloadFile) continue;
    const payload = path.resolve(captureDir, entry.payloadFile);
    if (!isPathInside(captureDir, payload) || !fs.existsSync(payload)) continue;
    result.push({
      id: `server:${index}`,
      index,
      payloadFile: entry.payloadFile,
      compressed: entry.compressed === true,
      payloadSize: Number(entry.payloadSize) || fs.statSync(payload).size,
      packetSha256: String(entry.sha256 || ''),
      stream: Number(entry.stream) || 0,
      frame: Number(entry.frame) || 0,
      time: Number(entry.time) || 0,
    });
  }
  return result.sort((a, b) => b.index - a.index);
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  try { return JSON.parse(trimmed); } catch { /* scan mixed output */ }
  for (let start = trimmed.lastIndexOf('{'); start >= 0; start = trimmed.lastIndexOf('{', start - 1)) {
    for (let end = trimmed.length; end > start; end = trimmed.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* keep scanning */ }
    }
  }
  throw new Error('Cross Save importer did not return JSON.');
}

async function importCrossSaveSource(settings, captureDir, source, copyTo) {
  const tools = toolPaths();
  const script = requireFile(path.join('tools', 'import-official-join-lobby-profile.js'), 'Official profile importer');
  const managed = normalizeManagedDir(settings.CounterSideSourceManagedDir || settings.CounterSideManagedDir);
  if (!isManagedDir(managed)) throw new Error('Select or detect the official CounterSide client before importing the captured profile.');
  const args = [
    script, '--capture-dir', captureDir, '--user-db', path.join(root, 'server-data', 'users.json'),
    '--managed-dir', managed,
    '--source-id', source.id,
  ];
  if (copyTo) args.push('--copy-to', copyTo);
  if (settings.CrossSaveSwitchActive) args.push('--switch-active');
  if (settings.CrossSaveUpdateExisting) args.push('--update-existing');
  if (settings.CrossSavePreserveUid) args.push('--preserve-official-uid');
  if (settings.CrossSavePreserveFriendCode) args.push('--preserve-official-friend-code');
  for (const combat of [path.join(root, 'combat-host', 'CombatHost.exe'), path.join(root, 'combat-host', 'CombatHost.dll')]) {
    if (fs.existsSync(combat)) { args.push('--combat-host', combat); break; }
  }
  const environment = buildListenerEnvironment(settings);
  if (tools.tshark) environment.CS_TSHARK_PATH = tools.tshark;
  const result = await runChecked(tools.node, args, { env: environment, description: 'Cross Save import' });
  return extractJsonObject(result.stdout);
}

async function findLatestCrossSave() {
  const settings = loadSettings();
  ensureRuntimeLayout(settings);
  const tools = toolPaths();
  if (!tools.tshark || !fs.existsSync(tools.tshark)) throw new Error('Bundled tshark.exe was not found. Reinstall RevivalSide.');
  const captureDir = crossSaveCaptureDir(settings);
  const stamp = newestCaptureStamp(captureDir);
  if (!stamp) throw new Error('No Cross Save capture files were found.');
  const pcaps = fs.readdirSync(captureDir)
    .filter((name) => name.endsWith(`${stamp}.pcapng`))
    .map((name) => path.join(captureDir, name))
    .filter((file) => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const extractRoot = path.join(root, 'server-data', 'capture-extracts');
  for (const pcap of pcaps) {
    log(`Scanning ${path.basename(pcap)}...`);
    let streams;
    try {
      streams = await candidateStreams(tools.tshark, pcap);
    } catch (error) {
      log(`Skipping unreadable capture: ${error.message}`, 'warn');
      continue;
    }
    for (const stream of streams) {
      const destination = path.join(extractRoot, `${path.basename(pcap, '.pcapng')}-stream-${stream.id}`);
      await fsp.rm(destination, { recursive: true, force: true });
      await fsp.mkdir(destination, { recursive: true });
      const extraction = await run(tools.node, [
        path.join(root, 'tools', 'extract-cs-pcap-fixtures.js'), pcap, destination, 'game', String(stream.id),
      ], { env: { ...buildListenerEnvironment(settings), CS_TSHARK_PATH: tools.tshark }, level: 'debug' });
      if (extraction.code !== 0) continue;
      const sources = loadCrossSaveSources(destination);
      if (!sources.length) continue;
      return { settings, captureDir: destination, source: sources[0], capture: pcap };
    }
  }
  throw new Error('No JOIN_LOBBY_ACK packet was found in the latest Cross Save capture.');
}

async function exportCrossSave() {
  const found = await findLatestCrossSave();
  const payload = fs.readFileSync(path.resolve(found.captureDir, found.source.payloadFile));
  const packet = {
    format: 'revivalside.join-lobby-ack.v1',
    exportedAt: new Date().toISOString(),
    packetId: 205,
    compressed: found.source.compressed,
    payloadSize: payload.length,
    packetSha256: found.source.packetSha256,
    payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    stream: found.source.stream,
    frame: found.source.frame,
    payloadBase64: payload.toString('base64'),
  };
  const packetPath = path.join(root, 'exports', `JOIN_LOBBY_ACK-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`);
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);
  const { payloadBase64, ...summary } = packet;
  return { packetPath, packet: summary, source: found.source, capture: found.capture };
}

async function extractCrossSave() {
  const found = await findLatestCrossSave();
  const copyTo = path.join(root, 'exports', `users-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`);
  const imported = await importCrossSaveSource(found.settings, found.captureDir, found.source, copyTo);
  try {
    await postJson(`http://127.0.0.1:${found.settings.HttpPort}/user-manager/api/reload`, {});
  } catch (error) {
    log(`User Manager reload skipped: ${error.message}`, 'warn');
  }
  return { imported, copyPath: copyTo, source: found.source, capture: found.capture };
}

function generateRelayCredentials() {
  const settings = loadSettings();
  settings.PrivatePvpRelaySecret = crypto.randomBytes(32).toString('base64url');
  if (!settings.PrivatePvpRelayHostId) settings.PrivatePvpRelayHostId = `host-${crypto.randomBytes(12).toString('hex')}`;
  saveSettings(settings);
  return { settings: settingsToClient(settings) };
}

function relayUrlFromSettings(settings) {
  const host = String(settings.RelayHostname || '').trim();
  const port = clampPort(settings.RelayPort, 443);
  return `https://${host}${port === 443 ? '' : `:${port}`}`;
}

function validateRelayDeployment(settings) {
  const required = [
    ['SSH host', settings.RelaySshHost], ['SSH user', settings.RelaySshUser],
    ['SSH private key', settings.RelaySshKeyPath], ['SSH host-key fingerprint', settings.RelaySshHostKeyFingerprint],
    ['Relay hostname', settings.RelayHostname],
    ['TLS certificate', settings.RelayTlsCertificatePath], ['TLS private key', settings.RelayTlsPrivateKeyPath],
    ['Install path', settings.RelayInstallPath], ['Relay secret', settings.PrivatePvpRelaySecret],
  ];
  for (const [label, value] of required) if (!String(value || '').trim()) throw new Error(`${label} is required.`);
  if (!/^[A-Za-z0-9.-]+$/.test(settings.RelaySshHost)) throw new Error('SSH host must be a hostname or IPv4 address.');
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(settings.RelaySshUser)) throw new Error('SSH user contains unsupported characters.');
  if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/.test(settings.RelaySshHostKeyFingerprint)) {
    throw new Error('SSH host-key fingerprint must use the SHA256:... format shown by ssh-keygen.');
  }
  if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(settings.RelayHostname)) {
    throw new Error('Relay hostname must be the DNS name covered by the TLS certificate.');
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(settings.RelayInstallPath) || settings.RelayInstallPath.split('/').includes('..')) {
    throw new Error('Relay install path must be a simple absolute Linux path without .. segments.');
  }
  if (String(settings.PrivatePvpRelaySecret).length < 32) throw new Error('Relay secret must contain at least 32 characters.');
  for (const [label, file] of [['SSH private key', settings.RelaySshKeyPath], ['TLS certificate', settings.RelayTlsCertificatePath], ['TLS private key', settings.RelayTlsPrivateKeyPath]]) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} was not found: ${file}`);
  }
  const tools = toolPaths();
  if (!tools.ssh || !tools.scp || !tools.sshKeyscan || !tools.sshKeygen) {
    throw new Error('Windows OpenSSH (ssh, scp, ssh-keyscan, and ssh-keygen) is required for one-click relay setup.');
  }
  return tools;
}

async function resolveRelayBinary() {
  const candidates = [
    path.join(root, 'relay-host', 'linux-x64', 'RevivalSideRelay'),
    path.join(root, 'relay-host', 'publish', 'linux-x64', 'RevivalSideRelay'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const project = path.join(root, 'relay-host', 'RevivalSideRelay.csproj');
  const dotnet = toolPaths().dotnet;
  if (!fs.existsSync(project) || !dotnet) throw new Error('The packaged Linux relay binary is missing. Reinstall or rebuild RevivalSide.');
  const outputDir = path.join(root, '.cache', 'relay-host', 'linux-x64');
  await fsp.mkdir(outputDir, { recursive: true });
  await runChecked(dotnet, [
    'publish', project, '-c', 'Release', '-r', 'linux-x64', '--self-contained', 'true', '--nologo',
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-p:DebugType=None', '-p:DebugSymbols=false', '-o', outputDir,
  ], { description: 'Linux relay build' });
  const built = path.join(outputDir, 'RevivalSideRelay');
  if (!fs.existsSync(built)) throw new Error('Linux relay build completed without producing RevivalSideRelay.');
  return built;
}

function sshConnectionArgs(settings, knownHostsPath, scp = false) {
  return [
    scp ? '-P' : '-p', String(settings.RelaySshPort),
    '-i', settings.RelaySshKeyPath,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHostsPath}`,
  ];
}

async function createPinnedKnownHosts(settings, tools, stage) {
  const scan = await runChecked(tools.sshKeyscan, [
    '-T', '10', '-p', String(settings.RelaySshPort), settings.RelaySshHost,
  ], { description: 'SSH host-key scan', logStdout: false });
  const lines = String(scan.stdout || '').replace(/\r/g, '').split('\n').filter((line) => line && !line.startsWith('#'));
  const accepted = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = path.join(stage, `known-host-${index}`);
    await fsp.writeFile(candidate, `${lines[index]}\n`, 'utf8');
    const fingerprint = await runChecked(tools.sshKeygen, ['-lf', candidate, '-E', 'sha256'], {
      description: 'SSH host-key fingerprint', logStdout: false,
    });
    const match = String(fingerprint.stdout || '').match(/\b(SHA256:[A-Za-z0-9+/]+={0,2})\b/);
    if (match && match[1] === settings.RelaySshHostKeyFingerprint) accepted.push(lines[index]);
  }
  if (!accepted.length) throw new Error('The VPS SSH host key does not match the pinned fingerprint. Nothing was uploaded.');
  const knownHostsPath = path.join(stage, 'known_hosts');
  await fsp.writeFile(knownHostsPath, `${accepted.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  return knownHostsPath;
}

async function testRelay(settings = loadSettings()) {
  const relayUrl = String(settings.PrivatePvpRelayUrl || relayUrlFromSettings(settings)).replace(/\/$/, '');
  if (!/^https:\/\//i.test(relayUrl)) throw new Error('Relay URL must use HTTPS.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${relayUrl}/health`, { signal: controller.signal });
    const health = await response.json();
    if (!response.ok || !health || health.ok !== true || health.service !== 'revivalside-relay' || health.tls !== true) {
      throw new Error(`Unexpected relay health response (${response.status}).`);
    }
    return { relayUrl, health };
  } finally {
    clearTimeout(timeout);
  }
}

async function deployRelay() {
  const settings = loadSettings();
  const tools = validateRelayDeployment(settings);
  const relayBinary = await resolveRelayBinary();
  const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'revivalside-relay-'));
  const remoteStage = `/tmp/revivalside-relay-${crypto.randomBytes(8).toString('hex')}`;
  const target = `${settings.RelaySshUser}@${settings.RelaySshHost}`;
  const installPath = settings.RelayInstallPath.replace(/\/$/, '');
  const serviceName = 'revivalside-relay.service';
  emitActionProgress('deploy-relay', 'build', 10);
  try {
    const files = {
      relay: path.join(stage, 'RevivalSideRelay'),
      certificate: path.join(stage, 'certificate.pem'),
      privateKey: path.join(stage, 'private-key.pem'),
      environment: path.join(stage, 'revivalside-relay.env'),
      service: path.join(stage, serviceName),
      install: path.join(stage, 'install.sh'),
    };
    await fsp.copyFile(relayBinary, files.relay);
    await fsp.copyFile(settings.RelayTlsCertificatePath, files.certificate);
    await fsp.copyFile(settings.RelayTlsPrivateKeyPath, files.privateKey);
    await fsp.writeFile(files.environment, [
      `REVIVALSIDE_RELAY_SECRET=${settings.PrivatePvpRelaySecret}`,
      `REVIVALSIDE_RELAY_PORT=${settings.RelayPort}`,
      `REVIVALSIDE_RELAY_CERTIFICATE=${installPath}/tls/certificate.pem`,
      `REVIVALSIDE_RELAY_PRIVATE_KEY=${installPath}/tls/private-key.pem`,
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o600 });
    await fsp.writeFile(files.service, [
      '[Unit]',
      'Description=RevivalSide encrypted PvP relay',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=revivalside-relay',
      'Group=revivalside-relay',
      `WorkingDirectory=${installPath}`,
      `EnvironmentFile=${installPath}/revivalside-relay.env`,
      'Environment=DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/revivalside-relay-bundle',
      'Environment=DOTNET_CLI_TELEMETRY_OPTOUT=1',
      'Environment=DOTNET_NOLOGO=1',
      `ExecStart=${installPath}/RevivalSideRelay`,
      'Restart=on-failure',
      'RestartSec=3',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'PrivateDevices=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'ProtectKernelTunables=true',
      'ProtectKernelModules=true',
      'ProtectControlGroups=true',
      'RestrictNamespaces=true',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
      'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
      'LockPersonality=true',
      'UMask=0077',
      'LimitNOFILE=4096',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'), 'utf8');
    await fsp.writeFile(files.install, [
      '#!/bin/sh',
      'set -eu',
      'umask 077',
      'SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'if ! id -u revivalside-relay >/dev/null 2>&1; then',
      '  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin revivalside-relay',
      'fi',
      `install -d -o root -g revivalside-relay -m 0750 '${installPath}' '${installPath}/tls'`,
      `install -o root -g root -m 0755 "$SOURCE_DIR/RevivalSideRelay" '${installPath}/RevivalSideRelay'`,
      `install -o root -g revivalside-relay -m 0640 "$SOURCE_DIR/certificate.pem" '${installPath}/tls/certificate.pem'`,
      `install -o root -g revivalside-relay -m 0640 "$SOURCE_DIR/private-key.pem" '${installPath}/tls/private-key.pem'`,
      `install -o root -g revivalside-relay -m 0640 "$SOURCE_DIR/revivalside-relay.env" '${installPath}/revivalside-relay.env'`,
      `install -o root -g root -m 0644 "$SOURCE_DIR/${serviceName}" '/etc/systemd/system/${serviceName}'`,
      'systemctl daemon-reload',
      `systemctl enable '${serviceName}' >/dev/null`,
      `systemctl restart '${serviceName}'`,
      `systemctl is-active --quiet '${serviceName}'`,
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o700 });

    const knownHostsPath = await createPinnedKnownHosts(settings, tools, stage);
    const sshArgs = sshConnectionArgs(settings, knownHostsPath);
    emitActionProgress('deploy-relay', 'connect', 30);
    await runChecked(tools.ssh, [...sshArgs, target, `mkdir -m 700 -- '${remoteStage}'`], { description: 'Relay SSH connection' });
    emitActionProgress('deploy-relay', 'upload', 50);
    await runChecked(tools.scp, [
      ...sshConnectionArgs(settings, knownHostsPath, true),
      files.relay, files.certificate, files.privateKey, files.environment, files.service, files.install,
      `${target}:${remoteStage}/`,
    ], { description: 'Relay upload' });
    emitActionProgress('deploy-relay', 'install', 75);
    await runChecked(tools.ssh, [...sshArgs, target, `if [ "$(id -u)" -eq 0 ]; then /bin/sh '${remoteStage}/install.sh'; else sudo -n /bin/sh '${remoteStage}/install.sh'; fi`], {
      description: 'Relay service installation',
    });
    settings.PrivatePvpRelayUrl = relayUrlFromSettings(settings);
    if (!settings.PrivatePvpRelayHostId) settings.PrivatePvpRelayHostId = `host-${crypto.randomBytes(12).toString('hex')}`;
    saveSettings(settings);
    emitActionProgress('deploy-relay', 'health', 90);
    const verified = await testRelay(settings);
    emitActionProgress('deploy-relay', 'complete', 100);
    return { ...verified, settings: settingsToClient(settings) };
  } finally {
    if (tools.ssh) {
      const knownHostsPath = path.join(stage, 'known_hosts');
      if (fs.existsSync(knownHostsPath)) {
        await run(tools.ssh, [...sshConnectionArgs(settings, knownHostsPath), target, `rm -rf -- '${remoteStage}'`], { logStdout: false, errorLevel: 'debug' }).catch(() => {});
      }
    }
    await fsp.rm(stage, { recursive: true, force: true });
  }
}

async function readPayload() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) return {};
  return JSON.parse(text);
}

async function runAction(command, payload) {
  switch (command) {
    case 'snapshot': return snapshot();
    case 'save-settings': return { settings: settingsToClient(applyClientSettings(loadSettings(), payload.settings || payload)) };
    case 'set-client': {
      const managed = normalizeManagedDir(payload.path);
      if (!isManagedDir(managed)) throw new Error('That file is not CounterSide Data\\Managed\\Assembly-CSharp.dll.');
      const settings = loadSettings();
      settings.CounterSideManagedDir = managed;
      saveSettings(settings);
      return { managedDir: managed };
    }
    case 'set-source-client': {
      const managed = normalizeManagedDir(payload.path);
      if (!isManagedDir(managed)) throw new Error('That file is not CounterSide Data\\Managed\\Assembly-CSharp.dll.');
      if (isFrozenManagedDir(managed)) throw new Error('Select an official CounterSide install as the freeze source, not an existing frozen client.');
      const settings = loadSettings();
      settings.CounterSideSourceManagedDir = managed;
      saveSettings(settings);
      return { managedDir: managed };
    }
    case 'detect-client': return { managedDir: detectManagedDir() };
    case 'freeze-client': return freezeClient();
    case 'launch-client': return launchClient();
    case 'verify-assets': return { gameplay: gameplayStatus(loadSettings()) };
    case 'build-cache': return { gameplay: await ensureGameplayCache(loadSettings(), true) };
    case 'prepare-modside-assets': return { assets: modSideAssetPreflight(loadSettings()) };
    case 'extract-modside-assets': return { assets: await extractModSideAssets(loadSettings(), payload.confirmed === true) };
    case 'set-server-time': {
      const state = writeServerTime(payload.iso);
      const settings = loadSettings();
      await postJson(`http://127.0.0.1:${settings.HttpPort}/launcher/api/server-time`, { iso: state.manualServerIso });
      return { serverTime: state.manualServerIso };
    }
    case 'clear-server-time': {
      const file = path.join(root, 'server-data', 'server-time.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}\n');
      const settings = loadSettings();
      await postJson(`http://127.0.0.1:${settings.HttpPort}/launcher/api/server-time/clear`, {});
      return { cleared: true };
    }
    case 'export-cross-save': return exportCrossSave();
    case 'extract-cross-save': return extractCrossSave();
    case 'generate-relay-credentials': return generateRelayCredentials();
    case 'test-relay': return testRelay();
    case 'deploy-relay': return deployRelay();
    case 'tailscale-status': return ensureTailscaleConnected();
    case 'configure-tailscale-host': return configureTailscaleLegacyHost();
    case 'configure-tailscale-guest': return configureTailscaleLegacyGuest(payload.hostCode);
    case 'refresh-wiki-cache': return { pngCount: await ensureWikiCache(loadSettings(), true) };
    case 'refresh-cutscene-cache': {
      const settings = loadSettings();
      const script = requireFile(path.join('tools', 'ensure-cutscene-backgrounds.js'), 'Cutscene background helper');
      await runChecked(toolPaths().node, [script, '--managed-dir', settings.CounterSideManagedDir, '--max-bundles', '24', '--force'], { env: buildListenerEnvironment(settings), description: 'Cutscene background cache' });
      return { refreshed: true };
    }
    default: throw new Error(`Unsupported launcher action: ${command}`);
  }
}

async function main() {
  const command = process.argv[2] || 'snapshot';
  if (command === 'service') {
    const service = process.argv[3];
    if (service === 'listener') return startListenerService();
    if (service === 'wiki') return startWikiService();
    if (service === 'modside') return startModSideService();
    if (service === 'capture') return startCaptureService();
    throw new Error(`Unsupported launcher service: ${service}`);
  }
  const payload = await readPayload();
  output(await runAction(command, payload));
}

if (require.main === module) {
  main().catch((error) => {
    log(error && error.stack ? error.stack : error, 'error');
    if (process.argv[2] !== 'service') process.stdout.write(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
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
};
