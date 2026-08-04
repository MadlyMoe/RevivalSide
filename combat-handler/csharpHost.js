const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");

// Thin process bridge to the C# combat host.
//
// The listener is still synchronous, so this bridge intentionally uses a
// blocking request API. Combat runtime traffic now requires the managed host;
// callers decide whether a non-combat helper can use a lightweight fallback.

function createCsharpCombatHost(options = {}) {
  const enabled = Boolean(options.enabled);
  const projectPath = path.resolve(options.projectPath || path.join(__dirname, "..", "combat-host", "CombatHost.csproj"));
  const explicitDllPath = options.dllPath ? path.resolve(options.dllPath) : "";
  const projectDir = path.dirname(projectPath);
  const timeoutMs = Number(options.timeoutMs || 5000);
  const managedDir = options.managedDir || "";
  const gameplayTablesDir = options.gameplayTablesDir || "";
  const modTablesDir = String(options.modTablesDir || process.env.CS_MOD_TABLES_DIR || "").split(path.delimiter).find(Boolean) || "";
  const contentsTags = Array.isArray(options.contentsTags) ? options.contentsTags.map(String).filter(Boolean) : [];
  const dotnetPath = options.dotnetPath || findPreferredDotnetRuntime(managedDir);
  const buildDotnetPath = options.buildDotnetPath || process.env.CS_DOTNET_BUILD_PATH || "dotnet";
  const responseBufferBytes = Number(options.responseBufferBytes || 16 * 1024 * 1024);
  let ready = false;
  let lastError = "";
  let worker = null;
  let workerDllPath = "";
  let workerRuntimeHash = "";
  let validatedRuntimeHash = "";

  function ensureReady() {
    if (!enabled) return false;
    const dllPath = resolveHostDllPath();
    if (ready && worker && workerDllPath === dllPath && fs.existsSync(dllPath)) return true;
    if (worker && workerDllPath !== dllPath) stopWorker();
    if (needsHostPublish(dllPath)) {
      const outDir = path.dirname(dllPath);
      fs.mkdirSync(outDir, { recursive: true });
      const buildArgs = explicitDllPath
        ? ["build", projectPath, "--nologo"]
        : [
            "publish",
            projectPath,
            "-c",
            "Release",
            "--self-contained",
            "false",
            "--nologo",
            "-o",
            outDir,
            "-p:DebugType=None",
            "-p:DebugSymbols=false",
          ];
      const build = spawnSync(buildDotnetPath, buildArgs, {
        encoding: "utf8",
        timeout: Math.max(timeoutMs, 30000),
      });
      if (build.status !== 0) {
        lastError = (build.stderr || build.stdout || "").trim() || `dotnet build exited ${build.status}`;
        return false;
      }
    }
    ready = fs.existsSync(dllPath);
    if (!ready) lastError = `missing combat host dll: ${dllPath}`;
    if (ready && !worker) {
      const runDirectly = /\.exe$/i.test(dllPath);
      const hostWorker = new Worker(path.join(__dirname, "csharpHostWorker.js"), {
        workerData: { hostPath: dllPath, dotnetPath, runDirectly, modTablesDir },
      });
      worker = hostWorker;
      workerDllPath = dllPath;
      workerRuntimeHash = readModRuntime().hash;
      if (typeof hostWorker.unref === "function") hostWorker.unref();
      hostWorker.on("error", (err) => {
        if (worker !== hostWorker) return;
        lastError = err.stack || err.message;
        ready = false;
        worker = null;
        workerDllPath = "";
        workerRuntimeHash = "";
        validatedRuntimeHash = "";
      });
      hostWorker.on("exit", (code) => {
        if (worker !== hostWorker) return;
        if (code !== 0) lastError = `C# combat host worker exited ${code}`;
        ready = false;
        worker = null;
        workerDllPath = "";
        workerRuntimeHash = "";
        validatedRuntimeHash = "";
      });
    }
    return ready;
  }

  function stopWorker() {
    const current = worker;
    worker = null;
    ready = false;
    workerDllPath = "";
    workerRuntimeHash = "";
    validatedRuntimeHash = "";
    if (!current) return Promise.resolve();
    const sharedBuffer = new SharedArrayBuffer(4);
    const header = new Int32Array(sharedBuffer);
    try {
      current.postMessage({ shutdown: true, sharedBuffer });
      Atomics.wait(header, 0, 0, Math.min(timeoutMs, 2000));
    } catch (_) {}
    return current.terminate();
  }

  function resolveHostDllPath() {
    if (explicitDllPath) return explicitDllPath;
    const stamp = computeCombatHostStamp(projectDir);
    return path.join(projectDir, "bin", "host-cache", stamp, "CombatHost.dll");
  }

  function needsHostPublish(dllPath) {
    if (!fs.existsSync(dllPath)) return true;
    if (explicitDllPath) return false;
    const baseName = dllPath.replace(/\.dll$/i, "");
    return !fs.existsSync(`${baseName}.runtimeconfig.json`) || !fs.existsSync(`${baseName}.deps.json`);
  }

  function request(command, data, requestOptions = {}) {
    const runtime = readModRuntime();
    const needsCurrentRuntime = command === "startBattle" || command === "validateUnitTemplets";
    if (needsCurrentRuntime && worker && runtime.hash !== workerRuntimeHash) stopWorker();
    if (!ensureReady()) {
      return { ok: false, error: lastError || "C# combat host disabled" };
    }
    if (command === "startBattle" && runtime.hash && validatedRuntimeHash !== runtime.hash && runtime.unitIds.length) {
      const validation = sendRequest("validateUnitTemplets", { unitIds: runtime.unitIds });
      if (!validation.ok) return { ok: false, error: `active mod units were not loaded: ${validation.error || "validation failed"}` };
      validatedRuntimeHash = runtime.hash;
    }
    const response = sendRequest(command, data, requestOptions);
    if (command === "validateUnitTemplets" && response.ok && runtime.hash) validatedRuntimeHash = runtime.hash;
    return response;
  }

  function sendRequest(command, data, requestOptions = {}) {
    const input = buildHostInput(command, data, requestOptions);
    const sharedBuffer = new SharedArrayBuffer(8 + responseBufferBytes);
    const header = new Int32Array(sharedBuffer, 0, 2);
    worker.postMessage({ input, sharedBuffer });
    const waitResult = Atomics.wait(header, 0, 0, timeoutMs);
    if (waitResult === "timed-out") {
      lastError = `combat host request timed out after ${timeoutMs}ms`;
      return { ok: false, error: lastError };
    }
    const length = Atomics.load(header, 1);
    const stdout = Buffer.from(sharedBuffer, 8, length).toString("utf8");
    return parseHostResponse(stdout);
  }

  function readModRuntime() {
    if (!modTablesDir) return { hash: "", unitIds: [] };
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.resolve(modTablesDir), "mod-set.json"), "utf8"));
      return {
        hash: [manifest.hash, manifest.builtAt].filter(Boolean).join(":"),
        unitIds: Array.isArray(manifest.unitIds) ? manifest.unitIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [],
      };
    } catch {
      return { hash: "", unitIds: [] };
    }
  }

  function buildHostInput(command, data, requestOptions = {}) {
    return JSON.stringify(
      {
        command,
        options: {
          managedDir,
          gameplayTablesDir,
          contentsTags,
          syncIntervalSeconds: Number(options.syncIntervalSeconds || 0.25),
          defaultUnitDamage: Number(options.defaultUnitDamage || 10),
          defaultUnitAttackRange: Number(options.defaultUnitAttackRange || 130),
          defaultUnitMoveSpeed: Number(options.defaultUnitMoveSpeed || 55),
          defaultUnitAttackCooldown: Number(options.defaultUnitAttackCooldown || 1.2),
          staticUnitDamage: Number(options.staticUnitDamage || 8),
          staticUnitAttackRange: Number(options.staticUnitAttackRange || 180),
          staticUnitAttackCooldown: Number(options.staticUnitAttackCooldown || 1.6),
          defaultDeployedUnitHp: Number(options.defaultDeployedUnitHp || 1989),
          ...requestOptions,
        },
        data: normalizeForHost(data),
      },
      jsonReplacer
    );
  }

  function parseHostResponse(stdout) {
    try {
      const response = JSON.parse(stdout);
      reviveFromHost(response);
      if (!response.ok) lastError = response.error || "combat host request failed";
      return response;
    } catch (err) {
      lastError = `combat host returned invalid JSON: ${err.message}`;
      return { ok: false, error: lastError };
    }
  }

  return {
    enabled,
    ensureReady,
    request,
    close: stopWorker,
    get hostPath() {
      return resolveHostDllPath();
    },
    get lastError() {
      return lastError;
    },
  };
}

function findPreferredDotnetRuntime(managedDir) {
  if (process.env.CS_DOTNET_PATH) return process.env.CS_DOTNET_PATH;
  if (managedDir && process.platform === "win32") {
    const x64Dotnet = "C:\\Program Files\\dotnet\\x64\\dotnet.exe";
    if (fs.existsSync(x64Dotnet)) return x64Dotnet;
  }
  if (process.platform === "win32") {
    const nativeDotnet = "C:\\Program Files\\dotnet\\dotnet.exe";
    if (fs.existsSync(nativeDotnet)) return nativeDotnet;
  }
  return "dotnet";
}

function computeCombatHostStamp(projectDir) {
  const hash = crypto.createHash("sha1");
  for (const fileName of fs
    .readdirSync(projectDir)
    .filter((name) => name.endsWith(".cs") || name.endsWith(".csproj"))
    .sort()) {
    const filePath = path.join(projectDir, fileName);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    hash.update(fileName);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function normalizeForHost(value) {
  if (!value || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values()).map(normalizeForHost);
  if (Array.isArray(value)) return value.map(normalizeForHost);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "function") continue;
    output[key] = normalizeForHost(item);
  }
  if (output.unitUID != null) output.unitUID = String(output.unitUID);
  if (output.sourceUnitUID != null) output.sourceUnitUID = String(output.sourceUnitUID);
  if (output.unitDeckUID != null) output.unitDeckUID = String(output.unitDeckUID);
  if (output.deckUsedAddUnitUID != null) output.deckUsedAddUnitUID = String(output.deckUsedAddUnitUID);
  if (output.deckTombAddUnitUID != null) output.deckTombAddUnitUID = String(output.deckTombAddUnitUID);
  if (output.nextDeckUnitUID != null) output.nextDeckUnitUID = String(output.nextDeckUnitUID);
  return output;
}

function reviveFromHost(response) {
  if (response.dynamicGame) {
    const pools = response.dynamicGame.unitPools || {};
    pools.ordered = pools.ordered || [];
    pools.unassignedGameUnitUIDs = pools.unassignedGameUnitUIDs || [];
    pools.byUnitUID = new Map(pools.ordered.map((pool) => [String(pool.unitUID || ""), pool]));
    response.dynamicGame.unitPools = pools;
    response.dynamicGame.usedPooledGameUnitUIDs = new Set(response.dynamicGame.usedPooledGameUnitUIDs || []);
  }
  if (response.battleState) {
    response.battleState.deployedUnitUIDs = new Set(response.battleState.deployedUnitUIDs || []);
    response.battleState.removedUnitUIDs = new Set(response.battleState.removedUnitUIDs || []);
  }
  if (response.payloadBase64 != null) response.payload = Buffer.from(response.payloadBase64, "base64");
  if (Array.isArray(response.packets)) {
    for (const packet of response.packets) {
      if (packet.payloadBase64 != null) packet.payload = Buffer.from(packet.payloadBase64, "base64");
    }
  }
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Set) return Array.from(value);
  if (value instanceof Map) return Array.from(value.values());
  return value;
}

module.exports = {
  createCsharpCombatHost,
};
