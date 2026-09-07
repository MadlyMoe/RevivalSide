const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_SQLITE_PATH = path.join(ROOT_DIR, "server-data", "users.sqlite");
const DEFAULT_JSON_PATH = path.join(ROOT_DIR, "server-data", "users.json");

let dbInstance = null;
let currentSqlitePath = "";
const statementCaches = new WeakMap();
const cachedMetaValues = new Map();
const savedUserHashes = new Map();

function hashData(dataStr) {
  return crypto.createHash("md5").update(dataStr).digest("hex");
}

const SQL_INSERT_META = "INSERT OR REPLACE INTO system_meta (meta_key, meta_value) VALUES (?, ?)";
const SQL_INSERT_USER = `
  INSERT OR REPLACE INTO users (
    user_uid, friend_code, nickname, steam_login_key, access_token, reconnect_key,
    device_uid, guest_login_key, mobile_user_id, steam_stable_id,
    data, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
`;
const SQL_DELETE_USER = "DELETE FROM users WHERE user_uid = ?";
const SQL_SELECT_USER_BY_UID = "SELECT data FROM users WHERE user_uid = ?";
const SQL_SELECT_USER_BY_STEAM = "SELECT data FROM users WHERE steam_login_key = ? LIMIT 1";
const SQL_SELECT_USER_BY_TOKEN = "SELECT data FROM users WHERE access_token = ? LIMIT 1";
const SQL_SELECT_USER_BY_RECONNECT = "SELECT data FROM users WHERE reconnect_key = ? LIMIT 1";
const SQL_SELECT_USER_BY_DEVICE = "SELECT data FROM users WHERE device_uid = ? ORDER BY updated_at DESC LIMIT 1";
const SQL_SELECT_USER_BY_GUEST = "SELECT data FROM users WHERE guest_login_key = ? ORDER BY updated_at DESC LIMIT 1";
const SQL_SELECT_USER_BY_MOBILE = "SELECT data FROM users WHERE mobile_user_id = ? ORDER BY updated_at DESC LIMIT 1";
const SQL_SELECT_USER_BY_STEAM_STABLE = "SELECT data FROM users WHERE steam_stable_id = ? ORDER BY updated_at DESC LIMIT 1";
const SQL_SELECT_USER_KEYS = "SELECT user_uid, friend_code, nickname, steam_login_key, access_token, reconnect_key FROM users";
const SQL_SELECT_ALL_USER_DATA = "SELECT data FROM users";
const SQL_SELECT_ALL_META = "SELECT meta_key, meta_value FROM system_meta";
const SQL_SELECT_META_BY_KEY = "SELECT meta_value FROM system_meta WHERE meta_key = ? LIMIT 1";
const SQL_SELECT_SUMMARIES = "SELECT user_uid, friend_code, nickname, steam_login_key, access_token, reconnect_key, updated_at FROM users ORDER BY updated_at DESC";

function getCachedStatement(db, sql) {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

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
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -32000;
    PRAGMA mmap_size = 268435456;
    PRAGMA wal_autocheckpoint = 1000;

    CREATE TABLE IF NOT EXISTS users (
      user_uid TEXT PRIMARY KEY,
      friend_code TEXT,
      nickname TEXT,
      steam_login_key TEXT,
      access_token TEXT,
      reconnect_key TEXT,
      device_uid TEXT,
      guest_login_key TEXT,
      mobile_user_id TEXT,
      steam_stable_id TEXT,
      data TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS system_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL
    );
  `);

  // Auto-migration: check and add columns if missing in older schema
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const existingCols = new Set(tableInfo.map((col) => col.name));
    const newCols = [
      ["device_uid", "TEXT"],
      ["guest_login_key", "TEXT"],
      ["mobile_user_id", "TEXT"],
      ["steam_stable_id", "TEXT"],
    ];
    for (const [colName, colType] of newCols) {
      if (!existingCols.has(colName)) {
        db.exec(`ALTER TABLE users ADD COLUMN ${colName} ${colType};`);
      }
    }
  } catch (err) {
    console.warn("[user-storage] column migration notice:", err.message);
  }

  // Initialize B-Tree Indexes (Compound index to optimize ORDER BY updated_at DESC)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_steam_login_key ON users(steam_login_key);
    CREATE INDEX IF NOT EXISTS idx_users_access_token ON users(access_token);
    CREATE INDEX IF NOT EXISTS idx_users_reconnect_key ON users(reconnect_key);
    CREATE INDEX IF NOT EXISTS idx_users_device_uid_updated ON users(device_uid, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_guest_key_updated ON users(guest_login_key, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_mobile_id_updated ON users(mobile_user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_steam_stable_updated ON users(steam_stable_id, updated_at DESC);
  `);

  // Auto-backfill indexes for older user records missing new column values
  try {
    const unindexedRows = db.prepare(
      "SELECT user_uid, data FROM users WHERE (device_uid IS NULL OR device_uid = '') AND (guest_login_key IS NULL OR guest_login_key = '') AND (mobile_user_id IS NULL OR mobile_user_id = '') AND (steam_stable_id IS NULL OR steam_stable_id = '')"
    ).all();
    if (unindexedRows.length > 0) {
      const updateStmt = db.prepare(`
        UPDATE users
        SET device_uid = ?, guest_login_key = ?, mobile_user_id = ?, steam_stable_id = ?
        WHERE user_uid = ?
      `);
      db.exec("BEGIN IMMEDIATE");
      for (const row of unindexedRows) {
        try {
          const user = JSON.parse(row.data);
          updateStmt.run(
            String(user.deviceUid || ""),
            String(user.guestLoginKey || ""),
            String(user.mobileUserId || ""),
            String(user.steamStableId || ""),
            String(row.user_uid)
          );
        } catch (_) {}
      }
      db.exec("COMMIT");
    }
  } catch (_) {}
}

function syncMetaValue(db, key, val) {
  if (val === undefined || val === null) return;
  const strVal = String(val);
  if (cachedMetaValues.get(key) === strVal) return;
  const stmt = getCachedStatement(db, SQL_INSERT_META);
  stmt.run(key, strVal);
  cachedMetaValues.set(key, strVal);
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
  const insertUser = getCachedStatement(db, SQL_INSERT_USER);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (data.schemaVersion) syncMetaValue(db, "schemaVersion", data.schemaVersion);
    if (data.nextUserUid) syncMetaValue(db, "nextUserUid", data.nextUserUid);
    if (data.nextFriendCode) syncMetaValue(db, "nextFriendCode", data.nextFriendCode);
    if (data.activeUserUid) syncMetaValue(db, "activeUserUid", data.activeUserUid);

    const users = data.users || {};
    let count = 0;
    for (const [uid, user] of Object.entries(users)) {
      if (!user) continue;
      const serialized = JSON.stringify(user);
      insertUser.run(
        String(uid),
        String(user.friendCode || ""),
        String(user.nickname || ""),
        String(user.steamLoginKey || user.steamAccountId || ""),
        String(user.accessToken || ""),
        String(user.reconnectKey || ""),
        String(user.deviceUid || ""),
        String(user.guestLoginKey || ""),
        String(user.mobileUserId || ""),
        String(user.steamStableId || ""),
        serialized
      );
      savedUserHashes.set(String(uid), hashData(serialized));
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
    reconnectKeys: {},
    usersByDeviceUid: {},
    usersByGuestLoginKey: {},
    usersByMobileUserId: {},
    usersBySteamStableId: {},
  };

  const metaRows = getCachedStatement(db, SQL_SELECT_ALL_META).all();
  for (const row of metaRows) {
    cachedMetaValues.set(row.meta_key, String(row.meta_value));
    if (row.meta_key === "schemaVersion") userDb.schemaVersion = Number(row.meta_value) || 1;
    if (row.meta_key === "nextUserUid") userDb.nextUserUid = row.meta_value;
    if (row.meta_key === "nextFriendCode") userDb.nextFriendCode = row.meta_value;
    if (row.meta_key === "activeUserUid") userDb.activeUserUid = row.meta_value;
  }

  const userRows = getCachedStatement(db, SQL_SELECT_ALL_USER_DATA).all();
  for (const row of userRows) {
    try {
      const user = JSON.parse(row.data);
      const uid = String(user.userUid);
      userDb.users[uid] = user;
      savedUserHashes.set(uid, hashData(row.data));

      const steamId = user.steamLoginKey || user.steamAccountId;
      if (steamId) userDb.usersBySteamAccountId[steamId] = uid;
      if (user.accessToken) userDb.accessTokens[user.accessToken] = uid;
      if (user.reconnectKey) userDb.reconnectKeys[user.reconnectKey] = uid;
      if (user.deviceUid) userDb.usersByDeviceUid[user.deviceUid] = uid;
      if (user.guestLoginKey) userDb.usersByGuestLoginKey[user.guestLoginKey] = uid;
      if (user.mobileUserId) userDb.usersByMobileUserId[user.mobileUserId] = uid;
      if (user.steamStableId) userDb.usersBySteamStableId[user.steamStableId] = uid;
    } catch (err) {
      console.error(`[user-storage] failed to parse user row: ${err.message}`);
    }
  }

  return userDb;
}

function saveUserDb(userDb, targetUserUid = null, options = {}) {
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const insertUser = getCachedStatement(db, SQL_INSERT_USER);
  const deleteUser = getCachedStatement(db, SQL_DELETE_USER);

  let targetUids = null;
  if (targetUserUid != null) {
    if (Array.isArray(targetUserUid)) {
      targetUids = targetUserUid.map(String);
    } else if (targetUserUid instanceof Set) {
      targetUids = Array.from(targetUserUid).map(String);
    } else {
      targetUids = [String(targetUserUid)];
    }
  }

  const usersToInsert = [];
  const uidsToDelete = [];

  if (targetUids !== null) {
    for (const targetKey of targetUids) {
      const u = userDb.users && userDb.users[targetKey];
      if (u) {
        const serialized = JSON.stringify(u);
        const hash = hashData(serialized);
        if (savedUserHashes.get(targetKey) !== hash) {
          usersToInsert.push({ u, serialized, hash });
        }
      } else {
        uidsToDelete.push(targetKey);
      }
    }
  } else {
    for (const [uid, u] of Object.entries(userDb.users || {})) {
      if (!u) continue;
      const serialized = JSON.stringify(u);
      const hash = hashData(serialized);
      if (savedUserHashes.get(uid) !== hash) {
        usersToInsert.push({ u, serialized, hash });
      }
    }
  }

  let metaChanged = false;
  if (userDb.schemaVersion && cachedMetaValues.get("schemaVersion") !== String(userDb.schemaVersion)) metaChanged = true;
  if (userDb.nextUserUid && cachedMetaValues.get("nextUserUid") !== String(userDb.nextUserUid)) metaChanged = true;
  if (userDb.nextFriendCode && cachedMetaValues.get("nextFriendCode") !== String(userDb.nextFriendCode)) metaChanged = true;
  if (userDb.activeUserUid !== undefined && cachedMetaValues.get("activeUserUid") !== String(userDb.activeUserUid || "")) metaChanged = true;

  // Dirty state check: Skip if no records changed (0ms, 0 I/O)
  if (usersToInsert.length === 0 && uidsToDelete.length === 0 && !metaChanged) {
    return true;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    if (userDb.schemaVersion) syncMetaValue(db, "schemaVersion", userDb.schemaVersion);
    if (userDb.nextUserUid) syncMetaValue(db, "nextUserUid", userDb.nextUserUid);
    if (userDb.nextFriendCode) syncMetaValue(db, "nextFriendCode", userDb.nextFriendCode);
    if (userDb.activeUserUid !== undefined) syncMetaValue(db, "activeUserUid", userDb.activeUserUid || "");

    if (targetUids !== null) {
      for (const { u, serialized } of usersToInsert) {
        insertUser.run(
          String(u.userUid),
          String(u.friendCode || ""),
          String(u.nickname || ""),
          String(u.steamLoginKey || u.steamAccountId || ""),
          String(u.accessToken || ""),
          String(u.reconnectKey || ""),
          String(u.deviceUid || ""),
          String(u.guestLoginKey || ""),
          String(u.mobileUserId || ""),
          String(u.steamStableId || ""),
          serialized
        );
      }
      for (const targetKey of uidsToDelete) {
        deleteUser.run(targetKey);
      }
    } else {
      const activeUids = Object.keys(userDb.users || {});
      if (activeUids.length > 0) {
        const placeholders = activeUids.map(() => "?").join(",");
        db.prepare(`DELETE FROM users WHERE user_uid NOT IN (${placeholders})`).run(...activeUids);
      } else {
        db.exec("DELETE FROM users");
      }

      for (const { u, serialized } of usersToInsert) {
        insertUser.run(
          String(u.userUid),
          String(u.friendCode || ""),
          String(u.nickname || ""),
          String(u.steamLoginKey || u.steamAccountId || ""),
          String(u.accessToken || ""),
          String(u.reconnectKey || ""),
          String(u.deviceUid || ""),
          String(u.guestLoginKey || ""),
          String(u.mobileUserId || ""),
          String(u.steamStableId || ""),
          serialized
        );
      }
    }

    db.exec("COMMIT");

    for (const { u, hash } of usersToInsert) {
      savedUserHashes.set(String(u.userUid), hash);
    }
    for (const targetKey of uidsToDelete) {
      savedUserHashes.delete(targetKey);
    }

    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`❌ [user-storage] failed to save data to SQLite: ${err.message}`);
    return false;
  }
}

function getUserByUid(userUid, options = {}) {
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_UID);
  const row = stmt.get(String(userUid));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (err) {
    console.error(`[user-storage] failed to parse user data for uid ${userUid}:`, err.message);
    return null;
  }
}

function getUserSummariesFromDb(options = {}) {
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_SUMMARIES);
  return stmt.all();
}

function saveSingleUser(user, options = {}) {
  if (!user || !user.userUid) return false;
  const uid = String(user.userUid);
  const serialized = JSON.stringify(user);
  const hash = hashData(serialized);

  // Dirty state check
  if (savedUserHashes.get(uid) === hash) {
    return true;
  }

  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const insertUser = getCachedStatement(db, SQL_INSERT_USER);

  db.exec("BEGIN IMMEDIATE");
  try {
    insertUser.run(
      uid,
      String(user.friendCode || ""),
      String(user.nickname || ""),
      String(user.steamLoginKey || user.steamAccountId || ""),
      String(user.accessToken || ""),
      String(user.reconnectKey || ""),
      String(user.deviceUid || ""),
      String(user.guestLoginKey || ""),
      String(user.mobileUserId || ""),
      String(user.steamStableId || ""),
      serialized
    );
    db.exec("COMMIT");
    savedUserHashes.set(uid, hash);
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    console.error(`[user-storage] saveSingleUser failed for uid ${user.userUid}:`, err.message);
    return false;
  }
}

function getUserBySteamKey(steamKey, options = {}) {
  if (!steamKey) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_STEAM);
  const row = stmt.get(String(steamKey));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function getUserByAccessToken(token, options = {}) {
  if (!token) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_TOKEN);
  const row = stmt.get(String(token));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function getUserByReconnectKey(reconnectKey, options = {}) {
  if (!reconnectKey) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_RECONNECT);
  const row = stmt.get(String(reconnectKey));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function getUserByDeviceUid(deviceUid, options = {}) {
  if (!deviceUid) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_DEVICE);
  const row = stmt.get(String(deviceUid));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function getUserByGuestKey(guestKey, options = {}) {
  if (!guestKey) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_GUEST);
  const row = stmt.get(String(guestKey));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function getUserByMobileUserId(mobileUserId, options = {}) {
  if (!mobileUserId) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_MOBILE);
  const row = stmt.get(String(mobileUserId));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function getUserBySteamStableId(steamStableId, options = {}) {
  if (!steamStableId) return null;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_USER_BY_STEAM_STABLE);
  const row = stmt.get(String(steamStableId));
  if (!row || !row.data) return null;
  try {
    return JSON.parse(row.data);
  } catch (_) {
    return null;
  }
}

function deleteUserByUid(userUid, options = {}) {
  if (!userUid) return false;
  const uid = String(userUid);
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_DELETE_USER);
  try {
    stmt.run(uid);
    savedUserHashes.delete(uid);
    return true;
  } catch (err) {
    console.error(`[user-storage] deleteUserByUid failed for uid ${uid}:`, err.message);
    return false;
  }
}

function getSystemMetaValue(key, options = {}) {
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const stmt = getCachedStatement(db, SQL_SELECT_META_BY_KEY);
  const row = stmt.get(String(key));
  return row ? row.meta_value : null;
}

function getWalFileSize(sqlitePath = DEFAULT_SQLITE_PATH) {
  const walPath = `${sqlitePath}-wal`;
  try {
    if (fs.existsSync(walPath)) {
      return fs.statSync(walPath).size;
    }
  } catch (_) {}
  return 0;
}

let periodicCheckpointTimer = null;
function startPeriodicCheckpoint(options = {}) {
  if (periodicCheckpointTimer) return periodicCheckpointTimer;
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const intervalMs = Number(options.intervalMs || process.env.CS_WAL_CHECKPOINT_INTERVAL_MS || 300000); // 5 minutes
  const thresholdBytes = Number(options.thresholdBytes || process.env.CS_WAL_CHECKPOINT_THRESHOLD_BYTES || 10 * 1024 * 1024); // 10MB

  periodicCheckpointTimer = setInterval(() => {
    try {
      const walSize = getWalFileSize(sqlitePath);
      if (walSize >= thresholdBytes) {
        const sizeMb = (walSize / (1024 * 1024)).toFixed(2);
        const result = checkpointSqliteDb({ sqlitePath, mode: "PASSIVE" });
        console.log(`[user-storage:checkpoint] Automatic WAL checkpoint (size: ${sizeMb}MB >= threshold ${(thresholdBytes / 1024 / 1024).toFixed(0)}MB):`, result);
      }
    } catch (err) {
      console.error("[user-storage:checkpoint] Periodic checkpoint failed:", err.message);
    }
  }, intervalMs);

  if (periodicCheckpointTimer.unref) periodicCheckpointTimer.unref();
  return periodicCheckpointTimer;
}

function stopPeriodicCheckpoint() {
  if (periodicCheckpointTimer) {
    clearInterval(periodicCheckpointTimer);
    periodicCheckpointTimer = null;
  }
}

function checkpointSqliteDb(options = {}) {
  const sqlitePath = options.sqlitePath || process.env.CS_USER_DB_SQLITE_PATH || DEFAULT_SQLITE_PATH;
  const db = getSqliteDb(sqlitePath);
  const mode = String(options.mode || "PASSIVE").toUpperCase();
  try {
    const result = db.prepare(`PRAGMA wal_checkpoint(${mode})`).all();
    if (options.verbose || process.env.CS_LOG_SQLITE_CHECKPOINT === "1") {
      console.log(`[user-storage:checkpoint] wal_checkpoint(${mode}) completed:`, result);
    }
    return result;
  } catch (err) {
    console.error(`[user-storage] wal_checkpoint(${mode}) failed:`, err.message);
    return null;
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
  stopPeriodicCheckpoint();
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
    dbInstance = null;
    currentSqlitePath = "";
    cachedMetaValues.clear();
    savedUserHashes.clear();
  }
}

module.exports = {
  getSqliteDb,
  closeSqliteDb,
  migrateJsonToSqlite,
  loadUserDb,
  saveUserDb,
  getUserByUid,
  getUserBySteamKey,
  getUserByAccessToken,
  getUserByReconnectKey,
  getUserByDeviceUid,
  getUserByGuestKey,
  getUserByMobileUserId,
  getUserBySteamStableId,
  deleteUserByUid,
  getSystemMetaValue,
  getUserSummariesFromDb,
  saveSingleUser,
  checkpointSqliteDb,
  getWalFileSize,
  startPeriodicCheckpoint,
  stopPeriodicCheckpoint,
  exportSqliteToJson,
  DEFAULT_SQLITE_PATH,
  DEFAULT_JSON_PATH,
};
