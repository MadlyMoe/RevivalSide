const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_PAYLOAD = path.join(ROOT_DIR, "server-data", "captured-game-flow", "server_008_205.payload.bin");
const INTERVAL_TABLE_RELATIVE = path.join("ab_script", "luac", "LUA_INTERVAL_TEMPLET.json");
const COUNTRY_SUFFIXES = [""];

function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));

  const args = parseArgs(process.argv.slice(2));
  const payloadPath = path.resolve(args.payload || DEFAULT_PAYLOAD);
  if (!fs.existsSync(payloadPath)) throw new Error(`missing JOIN_LOBBY_ACK payload: ${payloadPath}`);

  const managedDir = args.managed || process.env.CS_COUNTERSIDE_MANAGED_DIR || findCounterSideManagedDir({ env: process.env });
  if (!managedDir || !fs.existsSync(path.join(managedDir, "Assembly-CSharp.dll"))) {
    throw new Error("missing CounterSide managed dir; set CS_COUNTERSIDE_MANAGED_DIR or pass --managed");
  }
  const gameplayTablesDir =
    args.tables ||
    getDefaultGameplayTablesDir({
      rootDir: ROOT_DIR,
      env: process.env,
      managedDir,
    });

  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT_DIR, "combat-host", "CombatHost.csproj"),
    managedDir,
    gameplayTablesDir,
    dotnetPath: process.env.CS_CSHARP_COMBAT_HOST_DOTNET || process.env.CS_DOTNET_PATH || undefined,
    timeoutMs: Number(process.env.CS_CSHARP_COMBAT_HOST_TIMEOUT_MS || 30000),
    responseBufferBytes: 32 * 1024 * 1024,
  });

  const response = host.request("extractJoinLobbyIntervals", {
    packetId: 205,
    payloadBase64: fs.readFileSync(payloadPath).toString("base64"),
  });
  const userDbPath = path.resolve(args["user-db"] || path.join(ROOT_DIR, "server-data", "users.json"));
  const intervals = response.ok
    ? (Array.isArray(response.intervals) ? response.intervals : [])
    : readOfficialSnapshotIntervals(userDbPath);
  if (!response.ok && !intervals.length) throw new Error(response.error || "failed to extract JOIN_LOBBY_ACK intervals");
  if (!intervals.length) throw new Error("JOIN_LOBBY_ACK did not contain intervalData rows");

  const sourcePath = response.ok ? payloadPath : userDbPath;
  const table = buildIntervalTable(intervals, path.relative(ROOT_DIR, sourcePath));
  const outputPaths = intervalOutputPaths();
  for (const outputPath of outputPaths) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(table, null, 2)}\n`, "utf8");
  }

  console.log(`[interval-templet] wrote ${table.recordCount} official captured interval row(s)`);
  for (const outputPath of outputPaths) console.log(`- ${path.relative(ROOT_DIR, outputPath)}`);
}

function readOfficialSnapshotIntervals(userDbPath) {
  if (!fs.existsSync(userDbPath)) return [];
  const db = JSON.parse(fs.readFileSync(userDbPath, "utf8"));
  return Object.values(db.users || {})
    .map((user) => user && user.officialSnapshot && user.officialSnapshot.intervalData)
    .filter(Array.isArray)
    .sort((left, right) => right.length - left.length)[0] || [];
}

function buildIntervalTable(intervals, sourceLabel) {
  const records = intervals
    .map(toIntervalRecord)
    .filter((record) => record && record.m_DateID && record.m_DateStrID)
    .sort((left, right) => Number(left.m_DateID || 0) - Number(right.m_DateID || 0) || String(left.m_DateStrID).localeCompare(String(right.m_DateStrID)));
  return {
    source: `<project-root>\\${sourceLabel.replace(/\//g, "\\")}`,
    rootName: "INTERVAL_TEMPLET",
    recordCount: records.length,
    records,
    root: Object.fromEntries(records.map((record) => [String(record.m_DateID), record])),
    unsupportedCount: 0,
    unsupported: [],
  };
}

function toIntervalRecord(interval) {
  const record = {
    m_DateID: Number(interval.key || interval.Key || 0) || 0,
    m_DateStrID: String(interval.strKey || interval.StrKey || "").trim(),
    m_RepeatDateStart: Number(interval.repeatStartDate || interval.RepeatStartDate || 0) || 0,
    m_RepeatDateEnd: Number(interval.repeatEndDate || interval.RepeatEndDate || 0) || 0,
  };
  const startDate = String(interval.startDate || interval.StartDate || "").trim();
  const endDate = String(interval.endDate || interval.EndDate || "").trim();
  for (const suffix of COUNTRY_SUFFIXES) {
    record[`m_DateStart${suffix}`] = startDate;
    record[`m_DateEnd${suffix}`] = endDate;
  }
  return record;
}

function intervalOutputPaths() {
  const roots = [
    path.join(ROOT_DIR, "gameplay-jsons", "Assetbundles"),
    path.join(ROOT_DIR, "gameplay-jsons", "StreamingAssets"),
  ];
  return roots.map((root) => path.join(root, INTERVAL_TABLE_RELATIVE));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] != null) continue;
    let value = line.slice(equals + 1).trim();
    const quote = value[0];
    if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[key] = value;
  }
}

function findDefaultCounterSideManagedDir() {
  const candidates = [
    path.join("C:", "Main", "Gaming", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam", "steamapps", "common", "CounterSide", "Data", "Managed"),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "Assembly-CSharp.dll"))) || "";
}

main();
