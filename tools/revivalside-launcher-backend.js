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
const GAMEPLAY_CACHE_MANIFEST_NAME = '.revivalside-gameplay-luac-cache.json';
const GIB = 1024 ** 3;
const MODSIDE_MINIMUM_FREE_BYTES = 32 * GIB;
const FROZEN_CLIENT_PATCH_REQUIREMENTS = Object.freeze([
  'mod-runtime-loader=True',
  'mod-string-loader=True', 'mod-asset-bundle-loader=True', 'mod-episode-ui=True',
  'steam-local-login=True', 'steam-standalone=True', 'steam-runtime-isolated=True',
  'steam-interop-callsites=0', 'frozen-official-update-bypass=True',
  'frozen-patch-download-bypass=True', 'frozen-contents-version-isolation=False',
  'frozen-login-contents-reconciliation=False', 'external-endpoint-references=0',
]);
const DEFAULT_SETTINGS = Object.freeze({
  SettingsVersion: 8,
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
    const subdir = /(?:dumpcap|tshark)/i.test(name) ? 'Wireshark' : /(?:node|npm)/i.test(name) ? 'nodejs' : '';
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
  };
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
    CS_REQUIRE_FROZEN_CLIENT_PATCH: '1',
  };
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
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    log(`Running listener update skipped: ${error.message}`, 'warn');
  }
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

function createListenerReadinessGate(settings, timeoutMs = LISTENER_READINESS_TIMEOUT_MS) {
  const signals = new Map([
    ['game listener', `[+] Listening on port ${settings.GamePort}`],
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
  const readiness = createListenerReadinessGate(settings);
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
  createListenerReadinessGate,
  estimateModSideRequiredBytes,
  normalizeExistingManagedDir,
  progressFromLine,
  verifyGameplayCacheSource,
};
