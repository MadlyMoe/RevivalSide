const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_SQLITE_PATH = path.join(ROOT_DIR, "server-data", "users.sqlite");
const DEFAULT_JSON_PATH = path.join(ROOT_DIR, "server-data", "users.json");

let dbInstance = null;
let currentSqlitePath = "";

function getSqliteDb(customPath = null) {
  const targetPath = customPath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  if (dbInstance && currentSqlitePath === targetPath) {
    return dbInstance;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  dbInstance = new DatabaseSync(targetPath);
  currentSqlitePath = targetPath;
  initTables(dbInstance);
  return dbInstance;
}

function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_uid TEXT PRIMARY KEY,
      friend_code TEXT,
      nickname TEXT,
      steam_login_key TEXT,
      access_token TEXT,
      reconnect_key TEXT,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS system_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL
    );
  `);
}

function migrateJsonToSqlite(jsonPath = DEFAULT_JSON_PATH, sqlitePath = DEFAULT_SQLITE_PATH) {
  if (!fs.existsSync(jsonPath)) {
    console.log(`[user-storage] source JSON file does not exist: ${jsonPath}`);
    return false;
  }

  console.log(`[user-storage] starting migration ${jsonPath} -> ${sqlitePath}...`);
  const rawData = fs.readFileSync(jsonPath, "utf8");
  const data = JSON.parse(rawData);

  const db = getSqliteDb(sqlitePath);
  const insertMeta = db.prepare("INSERT OR REPLACE INTO system_meta (meta_key, meta_value) VALUES (?, ?)");
  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users (user_uid, friend_code, nickname, steam_login_key, access_token, reconnect_key, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  db.exec("BEGIN TRANSACTION");
  try {
    if (data.schemaVersion) insertMeta.run("schemaVersion", String(data.schemaVersion));
    if (data.nextUserUid) insertMeta.run("nextUserUid", String(data.nextUserUid));
    if (data.nextFriendCode) insertMeta.run("nextFriendCode", String(data.nextFriendCode));
    if (data.activeUserUid) insertMeta.run("activeUserUid", String(data.activeUserUid));

    const users = data.users || {};
    let count = 0;
    for (const [uid, user] of Object.entries(users)) {
      if (!user) continue;
      insertUser.run(
        String(uid),
        String(user.friendCode || ""),
        String(user.nickname || ""),
        String(user.steamLoginKey || user.steamAccountId || ""),
        String(user.accessToken || ""),
        String(user.reconnectKey || ""),
        JSON.stringify(user)
      );
      count++;
    }
    db.exec("COMMIT");
    console.log(`✅ [user-storage] successfully migrated ${count} accounts to SQLite DB!`);
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`❌ [user-storage] data migration failed: ${err.message}`);
    return false;
  }
}

function loadUserDb(options = {}) {
  const jsonPath = options.jsonPath || DEFAULT_JSON_PATH;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;

  // Auto-migrate if SQLite database does not exist but JSON file is present
  if (!fs.existsSync(sqlitePath) && fs.existsSync(jsonPath)) {
    migrateJsonToSqlite(jsonPath, sqlitePath);
  }

  const db = getSqliteDb(sqlitePath);
  const userDb = {
    schemaVersion: 1,
    nextUserUid: "1000000001",
    nextFriendCode: "10000001",
    activeUserUid: "",
    users: {},
    usersBySteamAccountId: {},
    accessTokens: {},
    reconnectKeys: {}
  };

  // Read metadata
  const metaRows = db.prepare("SELECT meta_key, meta_value FROM system_meta").all();
  for (const row of metaRows) {
    if (row.meta_key === "schemaVersion") userDb.schemaVersion = Number(row.meta_value) || 1;
    if (row.meta_key === "nextUserUid") userDb.nextUserUid = row.meta_value;
    if (row.meta_key === "nextFriendCode") userDb.nextFriendCode = row.meta_value;
    if (row.meta_key === "activeUserUid") userDb.activeUserUid = row.meta_value;
  }

  // Read all users into in-memory userDb
  const userRows = db.prepare("SELECT data FROM users").all();
  for (const row of userRows) {
    try {
      const user = JSON.parse(row.data);
      const uid = String(user.userUid);
      userDb.users[uid] = user;

      // Build lookup indexes
      const steamId = user.steamLoginKey || user.steamAccountId;
      if (steamId) userDb.usersBySteamAccountId[steamId] = uid;
      if (user.accessToken) userDb.accessTokens[user.accessToken] = uid;
      if (user.reconnectKey) userDb.reconnectKeys[user.reconnectKey] = uid;
    } catch (err) {
      console.error(`[user-storage] failed to parse user row: ${err.message}`);
    }
  }

  return userDb;
}

function saveUserDb(userDb, targetUserUid = null, options = {}) {
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);

  const insertMeta = db.prepare("INSERT OR REPLACE INTO system_meta (meta_key, meta_value) VALUES (?, ?)");
  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users (user_uid, friend_code, nickname, steam_login_key, access_token, reconnect_key, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  db.exec("BEGIN TRANSACTION");
  try {
    if (userDb.schemaVersion) insertMeta.run("schemaVersion", String(userDb.schemaVersion));
    if (userDb.nextUserUid) insertMeta.run("nextUserUid", String(userDb.nextUserUid));
    if (userDb.nextFriendCode) insertMeta.run("nextFriendCode", String(userDb.nextFriendCode));
    if (userDb.activeUserUid !== undefined) insertMeta.run("activeUserUid", String(userDb.activeUserUid || ""));

    if (targetUserUid) {
      // Save single user
      const u = userDb.users[String(targetUserUid)];
      if (u) {
        insertUser.run(
          String(u.userUid),
          String(u.friendCode || ""),
          String(u.nickname || ""),
          String(u.steamLoginKey || u.steamAccountId || ""),
          String(u.accessToken || ""),
          String(u.reconnectKey || ""),
          JSON.stringify(u)
        );
      }
    } else {
      // Save all users
      for (const [uid, u] of Object.entries(userDb.users || {})) {
        if (!u) continue;
        insertUser.run(
          String(uid),
          String(u.friendCode || ""),
          String(u.nickname || ""),
          String(u.steamLoginKey || u.steamAccountId || ""),
          String(u.accessToken || ""),
          String(u.reconnectKey || ""),
          JSON.stringify(u)
        );
      }
    }
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`❌ [user-storage] failed to save data to SQLite: ${err.message}`);
    return false;
  }
}

function exportSqliteToJson(sqlitePath = DEFAULT_SQLITE_PATH, jsonPath = DEFAULT_JSON_PATH) {
  const userDb = loadUserDb({ sqlitePath });
  const backupPath = `${jsonPath}.bak_${Math.floor(Date.now() / 1000)}`;
  if (fs.existsSync(jsonPath)) {
    fs.copyFileSync(jsonPath, backupPath);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(userDb, null, 2), "utf8");
  console.log(`✅ [user-storage] exported data from SQLite to ${jsonPath} (Backup: ${backupPath})`);
  return true;
}

function closeSqliteDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
    dbInstance = null;
    currentSqlitePath = "";
  }
}

module.exports = {
  getSqliteDb,
  closeSqliteDb,
  migrateJsonToSqlite,
  loadUserDb,
  saveUserDb,
  exportSqliteToJson,
  DEFAULT_SQLITE_PATH,
  DEFAULT_JSON_PATH
};
