const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createCombatHandler } = require("../combat-handler");
const counterSideInstall = require("../modules/counterside-install");
const gameplayJsons = require("../modules/gameplay-jsons");
const { createOfficialProfileImporter } = require("../modules/official-profile-import");
const {
  applyActiveUserSelection,
  resolveActiveUserPath,
  writeActiveUserSelection,
} = require("../modules/user-db-selection");
const { rebuildUserDbIndexes } = require("../server/userManager");

const ROOT_DIR = path.resolve(__dirname, "..");

function usage() {
  console.error(
    [
      "usage: node tools/import-official-join-lobby-profile.js --capture-dir <dir> [options]",
      "",
      "Options:",
      "  --user-db <path>                  users.json path (default: server-data/users.json)",
      "  --copy-to <path>                  copy updated users.json to this path after import",
      "  --switch-active                   make imported profile active",
      "  --update-existing                 update the matching official profile instead of adding a new one",
      "  --preserve-official-uid           use the official UID when it does not conflict",
      "  --preserve-official-friend-code   use the official friend code when it does not conflict",
      "  --source-id <id>                  import a specific source from manifest",
      "  --combat-host <path>              prebuilt CombatHost.exe or CombatHost.dll",
      "  --managed-dir <path>              CounterSide Data/Managed directory",
      "  --gameplay-tables-dir <path>      override resolved gameplay table directory",
    ].join("\n")
  );
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!args.captureDir) usage();

const captureDir = path.resolve(args.captureDir);
const userDbPath = path.resolve(args.userDb || path.join(ROOT_DIR, "server-data", "users.json"));
const activeUserPath = resolveActiveUserPath(userDbPath, process.env.CS_ACTIVE_USER_PATH || "");
const copyToPath = args.copyTo ? path.resolve(args.copyTo) : "";
const combatHostPath = resolveOptionalPath(args.combatHost || process.env.CS_COMBAT_HOST_PATH || findDefaultCombatHostPath());
const managedDir = counterSideInstall.normalizeManagedDir(
  args.managedDir ||
    process.env.CS_COUNTERSIDE_MANAGED_DIR ||
    process.env.COUNTERSIDE_MANAGED_DIR ||
    process.env.CS_COUNTERSIDE_DIR ||
    counterSideInstall.findCounterSideManagedDir({ env: process.env })
);
const gameplayTablesDir = path.resolve(
  args.gameplayTablesDir ||
    gameplayJsons.getDefaultGameplayTablesDir({
      rootDir: ROOT_DIR,
      env: process.env,
      managedDir,
    })
);

if (combatHostPath && !fs.existsSync(combatHostPath)) throw new Error(`Combat host was not found: ${combatHostPath}`);
if (!managedDir || !fs.existsSync(path.join(managedDir, "Assembly-CSharp.dll"))) {
  throw new Error("CounterSide Data/Managed directory with Assembly-CSharp.dll was not found. Use --managed-dir <CounterSide\\Data\\Managed> or set CS_COUNTERSIDE_MANAGED_DIR.");
}
if (!fs.existsSync(captureDir)) throw new Error(`Capture extract directory was not found: ${captureDir}`);
if (!fs.existsSync(userDbPath)) throw new Error(`users.json was not found: ${userDbPath}`);

const originalLog = console.log;
console.log = (...items) => console.error(...items);

const userDb = JSON.parse(stripBom(fs.readFileSync(userDbPath, "utf8")));
applyActiveUserSelection(userDb, activeUserPath);
const backupPath = backupUserDb(userDbPath);
const combatHostConfig = {
  CSHARP_COMBAT_HOST: true,
  CSHARP_COMBAT_HOST_PROJECT: path.join(ROOT_DIR, "combat-host", "CombatHost.csproj"),
  CSHARP_COMBAT_HOST_TIMEOUT_MS: Number(process.env.CS_CSHARP_COMBAT_HOST_TIMEOUT_MS || 60000),
  CSHARP_COMBAT_HOST_RESPONSE_BUFFER_BYTES: Number(process.env.CS_CSHARP_COMBAT_HOST_RESPONSE_BUFFER_BYTES || 128 * 1024 * 1024),
  CSHARP_COMBAT_HOST_DOTNET: process.env.CS_DOTNET_PATH || findDefaultDotnetRuntime(),
  COUNTERSIDE_MANAGED_DIR: managedDir,
  GAMEPLAY_TABLES_DIR: gameplayTablesDir,
};
if (combatHostPath) combatHostConfig.CSHARP_COMBAT_HOST_DLL = combatHostPath;

const combatHandler = createCombatHandler({
  config: {
    ...combatHostConfig,
  },
});
const importer = createOfficialProfileImporter({
  rootDir: ROOT_DIR,
  captureDir,
  userDb,
  combatHandler,
  makeAccessToken: () => crypto.randomBytes(16).toString("hex"),
  makeToken: (prefix) => `${prefix}_${crypto.randomBytes(24).toString("hex")}`,
});

const importOptions = {
  sourceId: args.sourceId || "",
  switchActive: args.switchActive === true,
  preserveOfficialUid: args.preserveOfficialUid === true,
  preserveOfficialFriendCode: args.preserveOfficialFriendCode === true,
  updateExisting: args.updateExisting === true,
};
const result = importOptions.sourceId ? importer.importSource(importOptions) : importer.importLatest(importOptions);
rebuildUserDbIndexes(userDb);
fs.writeFileSync(userDbPath, `${JSON.stringify(userDb, null, 2)}\n`);
writeActiveUserSelection(activeUserPath, userDb.activeUserUid);

let copiedUsersJsonPath = "";
if (copyToPath) {
  fs.mkdirSync(path.dirname(copyToPath), { recursive: true });
  fs.copyFileSync(userDbPath, copyToPath);
  copiedUsersJsonPath = copyToPath;
}

console.log = originalLog;
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      user: {
        userUid: result.user.userUid,
        officialUserUid: result.user.officialImport && result.user.officialImport.officialUserUid,
        friendCode: result.user.friendCode,
        nickname: result.user.nickname,
        level: result.user.level,
      },
      activeUserUid: userDb.activeUserUid || "",
      nextUserUid: userDb.nextUserUid,
      nextFriendCode: userDb.nextFriendCode,
      counts: result.counts,
      source: result.source,
      usersJsonPath: userDbPath,
      copiedUsersJsonPath,
      backupPath,
    },
    null,
    2
  )}\n`
);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--capture-dir") parsed.captureDir = values[++index];
    else if (arg === "--user-db") parsed.userDb = values[++index];
    else if (arg === "--copy-to") parsed.copyTo = values[++index];
    else if (arg === "--source-id") parsed.sourceId = values[++index];
    else if (arg === "--combat-host") parsed.combatHost = values[++index];
    else if (arg === "--managed-dir") parsed.managedDir = values[++index];
    else if (arg === "--gameplay-tables-dir") parsed.gameplayTablesDir = values[++index];
    else if (arg === "--switch-active") parsed.switchActive = true;
    else if (arg === "--update-existing") parsed.updateExisting = true;
    else if (arg === "--preserve-official-uid") parsed.preserveOfficialUid = true;
    else if (arg === "--preserve-official-friend-code") parsed.preserveOfficialFriendCode = true;
    else if (arg === "--help" || arg === "-h") usage();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function resolveOptionalPath(value) {
  return value ? path.resolve(value) : "";
}

function stripBom(text) {
  return String(text || "").replace(/^\uFEFF/, "");
}

function findDefaultCombatHostPath() {
  const rid = currentWindowsRuntimeIdentifier();
  const candidates = [
    rid ? path.join(ROOT_DIR, "prebuilt", `official-profile-capture-app-${rid}`, "app", "combat-host", "CombatHost.exe") : "",
    path.join(ROOT_DIR, "prebuilt", "combat-host", "CombatHost.exe"),
    path.join(ROOT_DIR, "prebuilt", "combat-host", "CombatHost.dll"),
    path.join(ROOT_DIR, "combat-host", "bin", "Release", "net8.0", rid || "", "CombatHost.exe"),
    path.join(ROOT_DIR, "combat-host", "bin", "Debug", "net8.0", rid || "", "CombatHost.exe"),
    path.join(ROOT_DIR, "combat-host", "CombatHost.exe"),
    path.join(ROOT_DIR, "combat-host", "CombatHost.dll"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function currentWindowsRuntimeIdentifier() {
  if (process.platform !== "win32") return "";
  if (process.arch === "x64") return "win-x64";
  if (process.arch === "ia32") return "win-x86";
  if (process.arch === "arm64") return "win-arm64";
  return "";
}

function backupUserDb(filePath) {
  const backupDir = path.join(path.dirname(filePath), "users.backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `users-${stamp}-import-official-profile.json`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function findDefaultDotnetRuntime() {
  if (process.platform === "win32") {
    const bundledDotnet = path.join(ROOT_DIR, "runtime", "dotnet", "dotnet.exe");
    if (fs.existsSync(bundledDotnet)) return bundledDotnet;
    const x64Dotnet = path.join(process.env.ProgramFiles || "C:\\Program Files", "dotnet", "x64", "dotnet.exe");
    if (fs.existsSync(x64Dotnet)) return x64Dotnet;
  }
  return "dotnet";
}
