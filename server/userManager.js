const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 25;

function createUserManager(options) {
  const config = {
    basePath: normalizeBasePath(options.basePath || "/user-manager"),
    allowRemote: options.allowRemote === true,
    maxBodyBytes: Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES),
    maxBackups: Number(options.maxBackups || DEFAULT_MAX_BACKUPS),
    userDb: options.userDb,
    userDbPath: options.userDbPath,
    saveUserDb: options.saveUserDb,
    ensureUserDefaults: options.ensureUserDefaults || ((user) => user),
    makeAccessToken: options.makeAccessToken || (() => crypto.randomBytes(16).toString("hex")),
    makeToken: options.makeToken || ((prefix) => `${prefix}_${crypto.randomBytes(24).toString("hex")}`),
    invalidateJoinLobbyAckPayloadCache:
      typeof options.invalidateJoinLobbyAckPayloadCache === "function" ? options.invalidateJoinLobbyAckPayloadCache : null,
  };
  const html = buildUserManagerHtml(config.basePath);

  async function handle(req, res) {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    if (!matchesBasePath(pathname, config.basePath)) return false;

    if (!config.allowRemote && !isLoopback(req.socket && req.socket.remoteAddress)) {
      sendJson(res, 403, { error: "User manager is restricted to loopback requests." });
      return true;
    }

    if (req.method === "OPTIONS") {
      sendJson(res, 204, null);
      return true;
    }

    try {
      await routeRequest(config, html, req, res, requestUrl);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || "User manager request failed." });
    }
    return true;
  }

  return { handle, basePath: config.basePath };
}

async function routeRequest(config, html, req, res, requestUrl) {
  const pathname = requestUrl.pathname.replace(/\/+$/, "") || "/";
  const basePath = config.basePath;
  const apiPath = `${basePath}/api`;

  if (req.method === "GET" && (pathname === basePath || pathname === `${basePath}/index.html`)) {
    sendHtml(res, html);
    return;
  }

  if (!pathname.startsWith(`${apiPath}/`) && pathname !== apiPath) {
    sendJson(res, 404, { error: "No user manager route found." });
    return;
  }

  if (req.method === "GET" && pathname === `${apiPath}/health`) {
    sendJson(res, 200, buildHealth(config));
    return;
  }

  if (pathname === `${apiPath}/users`) {
    if (req.method === "GET") {
      sendJson(res, 200, { users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonBody(req, config.maxBodyBytes, { allowEmpty: true });
      const user = createUser(config, body || {});
      persist(config, "create");
      sendJson(res, 201, { user, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
  }

  if (req.method === "POST" && pathname === `${apiPath}/users/delete-selected`) {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const deletedUserUids = deleteUsers(config.userDb, body && body.userUids);
    rebuildUserDbIndexes(config.userDb);
    persist(config, "delete-users");
    sendJson(res, 200, {
      deletedUserUids,
      users: buildUserSummaries(config.userDb),
      meta: buildDbMeta(config.userDb, config.userDbPath),
    });
    return;
  }

  if (req.method === "POST" && pathname === `${apiPath}/users/import-json-profile`) {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const imported = importUserFromJsonDb(config, body && body.db ? body.db : body);
    rebuildUserDbIndexes(config.userDb);
    persist(config, "import-json-profile");
    sendJson(res, 201, {
      user: imported.user,
      sourceUserUid: imported.sourceUserUid,
      users: buildUserSummaries(config.userDb),
      meta: buildDbMeta(config.userDb, config.userDbPath),
    });
    return;
  }

  if (pathname === `${apiPath}/db`) {
    if (req.method === "GET") {
      sendJson(res, 200, { db: config.userDb, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
    if (req.method === "PUT") {
      const nextDb = await readJsonBody(req, config.maxBodyBytes);
      replaceUserDb(config.userDb, nextDb);
      rebuildUserDbIndexes(config.userDb);
      persist(config, "replace-db");
      sendJson(res, 200, { db: config.userDb, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
  }

  if (req.method === "POST" && pathname === `${apiPath}/reload`) {
    reloadUserDb(config);
    sendJson(res, 200, { db: config.userDb, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
    return;
  }

  const userMatch = pathname.match(new RegExp(`^${escapeRegExp(apiPath)}/users/([^/]+)(?:/([^/]+))?$`));
  if (!userMatch) {
    sendJson(res, 404, { error: "No user manager route found." });
    return;
  }

  const uid = decodeURIComponent(userMatch[1]);
  const action = userMatch[2] ? decodeURIComponent(userMatch[2]) : "";

  if (!action) {
    if (req.method === "GET") {
      const user = getRequiredUser(config.userDb, uid);
      sendJson(res, 200, { user, meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req, config.maxBodyBytes);
      const user = replaceUser(config.userDb, uid, body && body.user && typeof body.user === "object" ? body.user : body);
      rebuildUserDbIndexes(config.userDb);
      persist(config, "save-user");
      sendJson(res, 200, { user, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
    if (req.method === "DELETE") {
      deleteUser(config.userDb, uid);
      rebuildUserDbIndexes(config.userDb);
      persist(config, "delete-user");
      sendJson(res, 200, { deletedUserUid: uid, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
      return;
    }
  }

  if (req.method === "GET" && action === "export-json") {
    sendJson(res, 200, buildSingleUserExport(config.userDb, uid));
    return;
  }

  if (req.method === "POST" && action === "clone") {
    const body = await readJsonBody(req, config.maxBodyBytes, { allowEmpty: true });
    const user = cloneUser(config, uid, body || {});
    rebuildUserDbIndexes(config.userDb);
    persist(config, "clone-user");
    sendJson(res, 201, { user, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
    return;
  }

  if (req.method === "POST" && action === "switch") {
    const user = switchActiveUser(config.userDb, uid);
    rebuildUserDbIndexes(config.userDb);
    persist(config, "switch-user");
    sendJson(res, 200, { user, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
    return;
  }

  if (req.method === "POST" && action === "tokens") {
    const user = getRequiredUser(config.userDb, uid);
    user.accessToken = config.makeAccessToken();
    user.reconnectKey = config.makeToken("rck");
    user.lastTokenIssuedAt = new Date().toISOString();
    rebuildUserDbIndexes(config.userDb);
    persist(config, "tokens");
    sendJson(res, 200, { user, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
    return;
  }

  if (req.method === "POST" && action === "repair") {
    const user = getRequiredUser(config.userDb, uid);
    config.ensureUserDefaults(user);
    rebuildUserDbIndexes(config.userDb);
    persist(config, "repair-user");
    sendJson(res, 200, { user, users: buildUserSummaries(config.userDb), meta: buildDbMeta(config.userDb, config.userDbPath) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
}

function createUser(config, body) {
  const userUid = allocateNumericId(config.userDb, "nextUserUid", "1000000001", (candidate) => config.userDb.users[String(candidate)]);
  const friendCode = allocateNumericId(config.userDb, "nextFriendCode", "10000001", (candidate) =>
    Object.values(config.userDb.users || {}).some((user) => user && String(user.friendCode || "") === String(candidate))
  );
  const now = new Date().toISOString();
  const user = {
    userUid,
    friendCode,
    nickname: nonEmpty(body.nickname) || "LocalAdmin",
    createdAt: now,
    lastLoginAt: "",
    level: 1,
    exp: "0",
    authLevel: 1,
    accessToken: config.makeAccessToken(),
    reconnectKey: config.makeToken("rck"),
    lastTokenIssuedAt: now,
  };
  config.ensureUserDefaults(user);
  config.userDb.users[userUid] = user;
  if (!nonEmpty(config.userDb.activeUserUid)) config.userDb.activeUserUid = userUid;
  rebuildUserDbIndexes(config.userDb);
  return user;
}

function cloneUser(config, uid, body) {
  const source = getRequiredUser(config.userDb, uid);
  const clone = deepClone(source);
  clone.userUid = allocateNumericId(config.userDb, "nextUserUid", "1000000001", (candidate) => config.userDb.users[String(candidate)]);
  clone.friendCode = allocateNumericId(config.userDb, "nextFriendCode", "10000001", (candidate) =>
    Object.values(config.userDb.users || {}).some((user) => user && String(user.friendCode || "") === String(candidate))
  );
  clone.nickname = nonEmpty(body.nickname) || `${source.nickname || "LocalAdmin"} Copy`;
  clone.createdAt = new Date().toISOString();
  clone.lastLoginAt = "";
  clone.lastJoinAt = "";
  clone.accessToken = config.makeAccessToken();
  clone.reconnectKey = config.makeToken("rck");
  clone.lastTokenIssuedAt = clone.createdAt;
  delete clone.steamAccountId;
  delete clone.steamLoginKey;
  delete clone.steamStableId;
  delete clone.steamLoginTicketHash;
  delete clone.deviceUid;
  config.userDb.users[clone.userUid] = clone;
  return clone;
}

function importUserFromJsonDb(config, incomingDb) {
  const sourceUid = chooseImportSourceUserUid(incomingDb);
  const source = incomingDb.users[sourceUid];
  const imported = deepClone(source);
  const originalUserUid = nonEmpty(imported.userUid) || sourceUid;
  const originalFriendCode = nonEmpty(imported.friendCode);
  const now = new Date().toISOString();
  const userUid = allocateNumericId(config.userDb, "nextUserUid", "1000000001", (candidate) => config.userDb.users[String(candidate)]);
  const friendCode = allocateNumericId(config.userDb, "nextFriendCode", "10000001", (candidate) =>
    Object.values(config.userDb.users || {}).some((user) => user && String(user.friendCode || "") === String(candidate))
  );

  imported.userUid = userUid;
  imported.friendCode = friendCode;
  imported.nickname = nonEmpty(imported.nickname) || "ImportedProfile";
  imported.createdAt = now;
  imported.lastLoginAt = "";
  imported.lastJoinAt = "";
  imported.accessToken = config.makeAccessToken();
  imported.reconnectKey = config.makeToken("rck");
  imported.lastTokenIssuedAt = now;
  imported.importedFromUsersJson = {
    importedAt: now,
    sourceUserUid: originalUserUid,
    sourceFriendCode: originalFriendCode,
    sourceActiveUserUid: nonEmpty(incomingDb.activeUserUid),
    localUserUid: userUid,
    localFriendCode: friendCode,
  };
  if (imported.officialImport && typeof imported.officialImport === "object") {
    imported.officialImport = {
      ...imported.officialImport,
      copiedJsonImportedAt: now,
      copiedJsonSourceUserUid: originalUserUid,
      localUserUid: userUid,
      localFriendCode: friendCode,
    };
  }
  delete imported.steamAccountId;
  delete imported.steamLoginKey;
  delete imported.steamStableId;
  delete imported.steamLoginTicketHash;
  delete imported.deviceUid;

  retargetUnitOwnership(imported, userUid);
  config.ensureUserDefaults(imported);
  retargetUnitOwnership(imported, userUid);

  config.userDb.users[userUid] = imported;
  config.userDb.activeUserUid = userUid;
  return { user: imported, sourceUserUid: sourceUid };
}

function chooseImportSourceUserUid(incomingDb) {
  if (!incomingDb || typeof incomingDb !== "object" || Array.isArray(incomingDb)) {
    throw httpError(400, "Imported JSON must be a users.json database object.");
  }
  const users = incomingDb.users && typeof incomingDb.users === "object" && !Array.isArray(incomingDb.users) ? incomingDb.users : null;
  if (!users) throw httpError(400, "Imported JSON is missing a users object.");

  const activeUid = nonEmpty(incomingDb.activeUserUid);
  if (activeUid && users[activeUid]) return activeUid;

  const entries = Object.entries(users).filter(([, user]) => user && typeof user === "object" && !Array.isArray(user));
  if (entries.length === 1) return entries[0][0];
  if (entries.length === 0) throw httpError(400, "Imported users.json does not contain any profiles.");
  throw httpError(400, "Imported users.json has multiple profiles and no activeUserUid; switch to the profile you want before copying it.");
}

function replaceUser(userDb, currentUid, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw httpError(400, "User profile must be a JSON object.");
  }
  
  const existing = getRequiredUser(userDb, currentUid);
  const user = deepClone(incoming);
  const nextUid = nonEmpty(user.userUid) || currentUid;
  user.userUid = nextUid;
  if (nextUid !== currentUid && userDb.users[nextUid]) {
    throw httpError(409, `User UID ${nextUid} already exists.`);
  }

  // In-place update directly to running memory
  // Ensure the game's TCP socket receives data immediately from the Serina save editor
  if (nextUid === currentUid) {
    for (const key of Object.keys(existing)) delete existing[key];
    Object.assign(existing, user);
    return existing;
  }

  delete userDb.users[currentUid];
  userDb.users[nextUid] = user;
  if (String(userDb.activeUserUid || "") === currentUid) userDb.activeUserUid = nextUid;
  bumpNextNumericId(userDb, "nextUserUid", nextUid);
  bumpNextNumericId(userDb, "nextFriendCode", user.friendCode);
  return user;
}

function deleteUser(userDb, uid) {
  getRequiredUser(userDb, uid);
  delete userDb.users[uid];
  if (String(userDb.activeUserUid || "") === String(uid)) userDb.activeUserUid = "";
}

function deleteUsers(userDb, userUids) {
  const uniqueUids = Array.from(
    new Set((Array.isArray(userUids) ? userUids : []).map(nonEmpty).filter(Boolean))
  );
  if (uniqueUids.length === 0) throw httpError(400, "Select at least one profile to delete.");

  const deletedUserUids = [];
  for (const uid of uniqueUids) {
    if (!userDb.users || !userDb.users[uid]) continue;
    delete userDb.users[uid];
    deletedUserUids.push(uid);
  }
  if (deletedUserUids.length === 0) throw httpError(404, "None of the selected profiles were found.");
  if (deletedUserUids.includes(String(userDb.activeUserUid || ""))) userDb.activeUserUid = "";
  return deletedUserUids;
}

function switchActiveUser(userDb, uid) {
  const user = getRequiredUser(userDb, uid);
  userDb.activeUserUid = String(user.userUid || uid);
  return user;
}

function getRequiredUser(userDb, uid) {
  const user = userDb && userDb.users && userDb.users[uid];
  if (!user) throw httpError(404, `User ${uid} was not found.`);
  return user;
}

function buildSingleUserExport(userDb, uid) {
  const source = getRequiredUser(userDb, uid);
  const exported = deepClone(source);
  const userUid = nonEmpty(exported.userUid) || String(uid);
  exported.userUid = userUid;
  const db = {
    schemaVersion: Number(userDb.schemaVersion || 1),
    nextUserUid: String(userDb.nextUserUid || "1000000001"),
    nextFriendCode: String(userDb.nextFriendCode || "10000001"),
    activeUserUid: userUid,
    users: {
      [userUid]: exported,
    },
  };
  return {
    userUid,
    fileName: `users-${sanitizeFilePart(exported.nickname || userUid)}-${sanitizeFilePart(userUid)}.json`,
    db,
  };
}

function replaceUserDb(target, incoming) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw httpError(400, "User database must be a JSON object.");
  }
  const next = {
    schemaVersion: Number(incoming.schemaVersion || 1),
    nextUserUid: String(incoming.nextUserUid || "1000000001"),
    nextFriendCode: String(incoming.nextFriendCode || "10000001"),
    activeUserUid: nonEmpty(incoming.activeUserUid),
    users: incoming.users && typeof incoming.users === "object" && !Array.isArray(incoming.users) ? incoming.users : {},
  };

  for (const [key, user] of Object.entries(next.users)) {
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      throw httpError(400, `User entry ${key} must be a JSON object.`);
    }
    user.userUid = nonEmpty(user.userUid) || key;
    if (user.userUid !== key) {
      delete next.users[key];
      if (next.users[user.userUid]) throw httpError(409, `Duplicate user UID ${user.userUid}.`);
      next.users[user.userUid] = user;
    }
    bumpNextNumericId(next, "nextUserUid", user.userUid);
    bumpNextNumericId(next, "nextFriendCode", user.friendCode);
  }

  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

function reloadUserDb(config) {
  let parsed = {};
  if (config.userDbPath && fs.existsSync(config.userDbPath)) {
    parsed = JSON.parse(fs.readFileSync(config.userDbPath, "utf8"));
  }
  replaceUserDb(config.userDb, parsed);
  rebuildUserDbIndexes(config.userDb);
}

function rebuildUserDbIndexes(userDb) {
  userDb.schemaVersion = Number(userDb.schemaVersion || 1);
  userDb.nextUserUid = String(userDb.nextUserUid || "1000000001");
  userDb.nextFriendCode = String(userDb.nextFriendCode || "10000001");
  userDb.activeUserUid = nonEmpty(userDb.activeUserUid);
  userDb.users = userDb.users && typeof userDb.users === "object" && !Array.isArray(userDb.users) ? userDb.users : {};
  userDb.usersBySteamAccountId = {};
  userDb.accessTokens = {};
  userDb.reconnectKeys = {};

  for (const [key, user] of Object.entries(userDb.users)) {
    if (!user || typeof user !== "object") continue;
    user.userUid = nonEmpty(user.userUid) || key;
    if (user.userUid !== key) {
      delete userDb.users[key];
      userDb.users[user.userUid] = user;
    }
    for (const loginKey of [user.steamAccountId, user.steamLoginKey]) {
      if (loginKey) userDb.usersBySteamAccountId[String(loginKey)] = user.userUid;
    }
    if (user.accessToken) userDb.accessTokens[String(user.accessToken)] = user.userUid;
    if (user.reconnectKey) userDb.reconnectKeys[String(user.reconnectKey)] = user.userUid;
    bumpNextNumericId(userDb, "nextUserUid", user.userUid);
    bumpNextNumericId(userDb, "nextFriendCode", user.friendCode);
  }
  if (userDb.activeUserUid && !userDb.users[userDb.activeUserUid]) userDb.activeUserUid = "";
}

function buildUserSummaries(userDb) {
  return Object.values((userDb && userDb.users) || {})
    .filter((user) => user && typeof user === "object")
    .map((user) => ({
      userUid: String(user.userUid || ""),
      isActive: String(user.userUid || "") === String(userDb && userDb.activeUserUid || ""),
      friendCode: String(user.friendCode || ""),
      nickname: String(user.nickname || ""),
      level: Number(user.level || 0),
      authLevel: Number(user.authLevel || 0),
      createdAt: String(user.createdAt || ""),
      lastLoginAt: String(user.lastLoginAt || ""),
      lastJoinAt: String(user.lastJoinAt || ""),
      steamStableId: String(user.steamStableId || ""),
      deviceUid: String(user.deviceUid || ""),
      importedOfficialProfile: Boolean(user.importedOfficialProfile || user.officialImport),
      officialUserUid: String(user.officialImport && user.officialImport.officialUserUid || ""),
      accessTokenPreview: previewSecret(user.accessToken),
      reconnectKeyPreview: previewSecret(user.reconnectKey),
      units: countObject(user.army && user.army.units),
      ships: countObject(user.army && user.army.ships),
      operators: countObject(user.army && user.army.operators),
      equips: countObject(user.inventory && user.inventory.equips),
      miscItems: countObject(user.inventory && user.inventory.misc),
      stages: countObject(user.stagePlayData),
      missions: countObject(user.completedMissions),
    }))
    .sort((a, b) => {
      const newest = Date.parse(b.lastLoginAt || b.lastJoinAt || b.createdAt || "") - Date.parse(a.lastLoginAt || a.lastJoinAt || a.createdAt || "");
      if (newest) return newest;
      return a.userUid.localeCompare(b.userUid, undefined, { numeric: true });
    });
}

function buildHealth(config) {
  return {
    ok: true,
    basePath: config.basePath,
    users: buildUserSummaries(config.userDb),
    meta: buildDbMeta(config.userDb, config.userDbPath),
  };
}

function buildDbMeta(userDb, userDbPath) {
  let sizeBytes = 0;
  let modifiedAt = "";
  try {
    const stat = userDbPath && fs.existsSync(userDbPath) ? fs.statSync(userDbPath) : null;
    if (stat) {
      sizeBytes = stat.size;
      modifiedAt = stat.mtime.toISOString();
    }
  } catch (_) {
    sizeBytes = 0;
    modifiedAt = "";
  }
  return {
    userDbPath,
    schemaVersion: Number(userDb && userDb.schemaVersion || 1),
    nextUserUid: String(userDb && userDb.nextUserUid || ""),
    nextFriendCode: String(userDb && userDb.nextFriendCode || ""),
    activeUserUid: String(userDb && userDb.activeUserUid || ""),
    userCount: Object.keys(userDb && userDb.users || {}).length,
    sizeBytes,
    modifiedAt,
  };
}

function persist(config, reason) {
  createBackup(config, reason);
  if (typeof config.saveUserDb !== "function") throw httpError(500, "User database save function is unavailable.");
  config.saveUserDb();
  if (typeof config.invalidateJoinLobbyAckPayloadCache === "function") {
    config.invalidateJoinLobbyAckPayloadCache(`user-manager:${reason || "edit"}`);
  }
}

function createBackup(config, reason) {
  if (!config.userDbPath || !fs.existsSync(config.userDbPath)) return;
  try {
    const backupDir = path.join(path.dirname(config.userDbPath), "users.backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `users-${stamp}-${sanitizeFilePart(reason || "edit")}.json`;
    fs.copyFileSync(config.userDbPath, path.join(backupDir, name));
    pruneBackups(backupDir, config.maxBackups);
  } catch (err) {
    console.log(`[user-manager] backup failed: ${err.message}`);
  }
}

function pruneBackups(backupDir, maxBackups) {
  const limit = Math.max(1, Number(maxBackups || DEFAULT_MAX_BACKUPS));
  const backups = fs
    .readdirSync(backupDir)
    .filter((name) => /^users-.+\.json$/.test(name))
    .map((name) => ({ name, fullPath: path.join(backupDir, name), mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const backup of backups.slice(limit)) {
    fs.unlinkSync(backup.fullPath);
  }
}

function allocateNumericId(db, field, fallback, exists) {
  let current = safeBigInt(db[field], fallback);
  while (exists(current)) current += 1n;
  db[field] = String(current + 1n);
  return String(current);
}

function bumpNextNumericId(db, field, value) {
  if (!value || !/^\d+$/.test(String(value))) return;
  const current = safeBigInt(db[field], field === "nextFriendCode" ? "10000001" : "1000000001");
  const next = BigInt(String(value)) + 1n;
  if (next > current) db[field] = String(next);
}

function safeBigInt(value, fallback) {
  try {
    return BigInt(String(value || fallback));
  } catch (_) {
    return BigInt(fallback);
  }
}

function countObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function previewSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function nonEmpty(value) {
  const text = value == null ? "" : String(value).trim();
  return text;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
}

function retargetUnitOwnership(profile, userUid) {
  const army = profile && profile.army && typeof profile.army === "object" ? profile.army : null;
  if (!army) return;
  for (const bucket of ["units", "ships", "trophies"]) {
    const units = army[bucket] && typeof army[bucket] === "object" && !Array.isArray(army[bucket]) ? army[bucket] : {};
    for (const unit of Object.values(units)) {
      if (unit && typeof unit === "object") unit.userUid = userUid;
    }
  }
}

function normalizeBasePath(value) {
  const text = String(value || "/user-manager").trim() || "/user-manager";
  const prefixed = text.startsWith("/") ? text : `/${text}`;
  return prefixed.replace(/\/+$/, "") || "/user-manager";
}

function matchesBasePath(pathname, basePath) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function isLoopback(remoteAddress) {
  const remote = String(remoteAddress || "");
  return (
    remote === "::1" ||
    remote === "127.0.0.1" ||
    remote === "::ffff:127.0.0.1" ||
    /^127\./.test(remote) ||
    /^::ffff:127\./.test(remote)
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeFilePart(value) {
  return String(value || "edit").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "edit";
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function readJsonBody(req, maxBodyBytes, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text && options.allowEmpty) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text || "null"));
      } catch (err) {
        reject(httpError(400, `Invalid JSON: ${err.message}`));
      }
    });
    req.on("error", (err) => reject(httpError(400, err.message)));
  });
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

function sendJson(res, statusCode, value) {
  const headers = {
    "Access-Control-Allow-Origin": "*", //my stupid ass dont know how to bypass cors header check on browser
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  if (statusCode === 204 || value == null) {
    res.writeHead(statusCode, headers);
    res.end();
    return;
  }
  res.writeHead(statusCode, headers);
  res.end(`${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`);
}

function buildUserManagerHtml(basePath) {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>RevivalSide User Manager</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --panel: #171a1d;
      --panel-2: #1f2428;
      --line: #30373d;
      --text: #edf1f3;
      --muted: #9aa7ad;
      --accent: #62b987;
      --accent-2: #d4b45f;
      --danger: #e06f6f;
      --focus: #7cc7ff;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--text);
    }

    button, input, textarea {
      font: inherit;
    }

    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #20262a;
      color: var(--text);
      min-height: 34px;
      min-width: 0;
      padding: 0 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    button:hover { border-color: #53616a; background: #283036; }
    button:focus, input:focus, textarea:focus {
      outline: 2px solid var(--focus);
      outline-offset: 1px;
    }
    button.primary { border-color: #3b7d59; background: #235139; }
    button.danger { border-color: #754040; background: #4b2525; }
    button.ghost { background: transparent; }
    button[disabled] { opacity: .45; cursor: default; }

    .shell {
      height: 100vh;
      height: 100dvh;
      display: grid;
      grid-template-rows: 54px minmax(0, 1fr);
    }

    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 16px;
      border-bottom: 1px solid var(--line);
      background: #131619;
    }

    h1 {
      font-size: 16px;
      line-height: 1;
      margin: 0;
      font-weight: 700;
      letter-spacing: 0;
      white-space: nowrap;
    }

    .header-meta {
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header-actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .main {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(250px, 330px) minmax(0, 1fr);
    }

    aside {
      min-height: 0;
      border-right: 1px solid var(--line);
      background: var(--panel);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .search {
      padding: 12px;
      display: grid;
      gap: 8px;
      border-bottom: 1px solid var(--line);
    }

    .search > input, .field input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      min-height: 34px;
      padding: 7px 9px;
      color: var(--text);
      background: #111518;
    }

    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--accent);
    }

    .counts {
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .selection-tools {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .selection-tools button {
      min-height: 28px;
      padding: 0 8px;
      font-size: 12px;
    }

    .check-control {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      cursor: pointer;
      white-space: nowrap;
    }

    .user-list {
      min-height: 0;
      overflow: auto;
      padding: 8px;
    }

    .user-entry {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      align-items: start;
      gap: 6px;
      margin-bottom: 4px;
    }

    .delete-check {
      margin-top: 25px;
      justify-self: center;
    }

    .user-row {
      width: 100%;
      text-align: left;
      height: auto;
      min-height: 68px;
      padding: 9px;
      display: grid;
      gap: 5px;
      background: transparent;
      border-color: transparent;
      border-radius: 6px;
    }

    .user-row.active {
      border-color: #4f6d5d;
      background: #202a25;
    }

    .user-row.login-active {
      border-color: #6f927d;
    }

    .user-entry.selected-delete .user-row {
      border-color: #755b40;
      background: #29231a;
    }

    .user-name {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-weight: 700;
      min-width: 0;
    }

    .user-name span:first-child,
    .user-line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .user-line {
      color: var(--muted);
      font-size: 12px;
    }

    .workspace {
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      background: #111315;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(130px, 1fr));
      gap: 10px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    .field {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    .field label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    .tabs {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      background: #15191c;
    }

    .tabs button {
      min-height: 30px;
    }

    .tabs button.active {
      border-color: #4f6d5d;
      background: #223429;
    }

    .state {
      margin-left: auto;
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .editor-wrap {
      min-height: 0;
      padding: 12px 16px 16px;
      display: grid;
    }

    textarea {
      width: 100%;
      height: 100%;
      resize: none;
      min-height: 280px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      background: #0c0e10;
      color: #edf1f3;
      font-family: "Cascadia Code", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.45;
      tab-size: 2;
      white-space: pre;
      overflow: auto;
    }

    .footer {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      background: #15191c;
    }

    .footer .spacer {
      flex: 1 1 auto;
    }

    .export-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .status {
      min-width: min(420px, 100%);
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .invalid { color: var(--danger); }
    .ok { color: var(--accent); }
    .warn { color: var(--accent-2); }

    @media (max-width: 900px) {
      .main { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 34vh) minmax(0, 1fr); }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .summary { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
      header { align-items: flex-start; height: auto; min-height: 54px; padding: 10px 12px; }
      .shell { grid-template-rows: auto minmax(0, 1fr); }
    }

    @media (max-width: 900px), (pointer: coarse) {
      html,
      body {
        height: auto;
        min-height: 100%;
        overflow: auto;
      }

      body {
        min-width: 0;
      }

      button,
      .search > input,
      .field input {
        min-height: 42px;
      }

      button {
        padding: 0 10px;
      }

      .shell {
        display: block;
        height: auto;
        min-height: 100vh;
        min-height: 100dvh;
      }

      header {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
        gap: 8px;
        min-height: 0;
        padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
      }

      h1 {
        font-size: 15px;
      }

      .header-meta {
        font-size: 11px;
        white-space: normal;
        line-height: 1.35;
      }

      .header-actions {
        margin-left: 0;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }

      .header-actions button {
        width: 100%;
        white-space: normal;
        line-height: 1.1;
      }

      #importJsonBtn {
        grid-column: span 2;
      }

      .main {
        display: block;
        min-width: 0;
      }

      aside {
        border-right: 0;
        border-bottom: 1px solid var(--line);
        display: block;
      }

      .search {
        padding: 10px;
        gap: 7px;
      }

      .selection-tools,
      .counts {
        gap: 6px;
      }

      .counts {
        flex-wrap: wrap;
      }

      .user-list {
        max-height: 24vh;
        max-height: 24dvh;
        padding: 6px 8px 8px;
      }

      .user-row {
        min-height: 58px;
        padding: 8px;
      }

      .delete-check {
        margin-top: 21px;
      }

      .workspace {
        display: block;
        min-height: 0;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        padding: 10px;
      }

      .field {
        gap: 4px;
      }

      .field label {
        font-size: 10px;
      }

      .tabs {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        padding: 8px 10px;
      }

      .tabs button {
        width: 100%;
      }

      .state {
        grid-column: 1 / -1;
        margin-left: 0;
        white-space: normal;
        line-height: 1.3;
      }

      .editor-wrap {
        height: 46vh;
        height: 46dvh;
        min-height: 260px;
        padding: 10px;
      }

      textarea {
        height: 100%;
        min-height: 230px;
        font-size: 13px;
        line-height: 1.42;
      }

      .footer {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        padding: 10px 10px calc(10px + env(safe-area-inset-bottom));
      }

      .footer button {
        width: 100%;
      }

      .footer .spacer {
        display: none;
      }

      .export-actions {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .status {
        grid-column: 1 / -1;
        order: -1;
        min-width: 0;
        line-height: 1.3;
        white-space: normal;
      }
    }

    @media (max-width: 520px), (pointer: coarse) and (max-width: 1440px) {
      .summary {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <h1>RevivalSide User Manager</h1>
      <div class="header-meta" id="dbMeta">Loading</div>
      <div class="header-actions">
        <button id="reloadBtn" title="Reload from disk">Reload</button>
        <button id="importJsonBtn" title="Add one profile from a copied users.json clipboard value or file">Import copied JSON</button>
        <input id="importJsonFileInput" type="file" accept="application/json,.json" hidden>
        <button id="newBtn" class="primary" title="Create profile">New</button>
      </div>
    </header>

    <div class="main">
      <aside>
        <div class="search">
          <input id="searchInput" type="search" autocomplete="off" placeholder="Search profiles">
          <div class="selection-tools">
            <label class="check-control"><input id="selectVisibleInput" type="checkbox">Select shown</label>
            <button id="clearDeleteSelectionBtn" class="ghost" type="button">Clear</button>
          </div>
          <div class="counts"><span id="userCount">0 profiles</span><span id="deleteCount">0 selected</span><span id="dirtyFlag"></span></div>
        </div>
        <div class="user-list" id="userList"></div>
      </aside>

      <section class="workspace">
        <div class="summary">
          <div class="field"><label for="nicknameInput">Nickname</label><input id="nicknameInput" autocomplete="off"></div>
          <div class="field"><label for="uidInput">User UID</label><input id="uidInput" autocomplete="off"></div>
          <div class="field"><label for="friendInput">Friend Code</label><input id="friendInput" autocomplete="off"></div>
          <div class="field"><label for="levelInput">Level</label><input id="levelInput" inputmode="numeric" autocomplete="off"></div>
        </div>
        <div class="tabs">
          <button id="profileTab" class="active">Profile JSON</button>
          <button id="dbTab">Database JSON</button>
          <div class="state" id="jsonState">Ready</div>
        </div>
        <div class="editor-wrap">
          <textarea id="jsonEditor" spellcheck="false" autocomplete="off"></textarea>
        </div>
        <div class="footer">
          <button id="saveBtn" class="primary" title="Persist JSON">Save</button>
          <button id="repairBtn" title="Apply game defaults">Repair</button>
          <button id="tokensBtn" title="Regenerate tokens">Tokens</button>
          <button id="cloneBtn" title="Clone selected profile">Clone</button>
          <div class="export-actions">
            <button id="copyProfileBtn" title="Copy selected profile as a one-profile users.json">Copy JSON</button>
            <button id="downloadProfileBtn" title="Download selected profile as a one-profile users.json">Export file</button>
          </div>
          <button id="switchBtn" title="Use selected profile on next login">Switch</button>
          <button id="deleteBtn" class="danger" title="Delete checked profiles">Delete selected</button>
          <div class="spacer"></div>
          <div class="status" id="statusLine">Ready</div>
        </div>
      </section>
    </div>
  </div>

  <script>
    const BASE_PATH = ${JSON.stringify(basePath)};
    const API = BASE_PATH + "/api";
    const state = {
      users: [],
      selectedUid: "",
      activeUid: "",
      profile: null,
      db: null,
      visibleUids: [],
      deleteSelectedUids: new Set(),
      mode: "profile",
      dirty: false,
      saving: false
    };

    const els = {
      dbMeta: document.getElementById("dbMeta"),
      reloadBtn: document.getElementById("reloadBtn"),
      importJsonBtn: document.getElementById("importJsonBtn"),
      importJsonFileInput: document.getElementById("importJsonFileInput"),
      newBtn: document.getElementById("newBtn"),
      searchInput: document.getElementById("searchInput"),
      selectVisibleInput: document.getElementById("selectVisibleInput"),
      clearDeleteSelectionBtn: document.getElementById("clearDeleteSelectionBtn"),
      userCount: document.getElementById("userCount"),
      deleteCount: document.getElementById("deleteCount"),
      dirtyFlag: document.getElementById("dirtyFlag"),
      userList: document.getElementById("userList"),
      nicknameInput: document.getElementById("nicknameInput"),
      uidInput: document.getElementById("uidInput"),
      friendInput: document.getElementById("friendInput"),
      levelInput: document.getElementById("levelInput"),
      profileTab: document.getElementById("profileTab"),
      dbTab: document.getElementById("dbTab"),
      jsonState: document.getElementById("jsonState"),
      jsonEditor: document.getElementById("jsonEditor"),
      saveBtn: document.getElementById("saveBtn"),
      repairBtn: document.getElementById("repairBtn"),
      tokensBtn: document.getElementById("tokensBtn"),
      cloneBtn: document.getElementById("cloneBtn"),
      copyProfileBtn: document.getElementById("copyProfileBtn"),
      downloadProfileBtn: document.getElementById("downloadProfileBtn"),
      switchBtn: document.getElementById("switchBtn"),
      deleteBtn: document.getElementById("deleteBtn"),
      statusLine: document.getElementById("statusLine")
    };

    function setStatus(text, kind) {
      els.statusLine.textContent = text || "";
      els.statusLine.className = "status " + (kind || "");
    }

    function setJsonState(text, kind) {
      els.jsonState.textContent = text || "";
      els.jsonState.className = "state " + (kind || "");
    }

    function setDirty(value) {
      state.dirty = Boolean(value);
      els.dirtyFlag.textContent = state.dirty ? "Unsaved" : "";
      els.saveBtn.disabled = state.saving || !state.dirty;
    }

    function formatDate(value) {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function formatBytes(value) {
      const number = Number(value || 0);
      if (number < 1024) return number + " B";
      if (number < 1024 * 1024) return (number / 1024).toFixed(1) + " KB";
      return (number / 1024 / 1024).toFixed(1) + " MB";
    }

    async function requestJson(path, options) {
      const response = await fetch(API + path, Object.assign({
        headers: { "Content-Type": "application/json" }
      }, options || {}));
      if (response.status === 204) return null;
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(payload && payload.error ? payload.error : response.statusText);
      }
      return payload;
    }

    async function boot() {
      bindEvents();
      await refreshUsers();
      const activeUser = state.users.find(function (user) { return user.userUid === state.activeUid; });
      if (activeUser || state.users[0]) await selectUser((activeUser || state.users[0]).userUid);
      setStatus("Ready", "ok");
    }

    function bindEvents() {
      els.searchInput.addEventListener("input", renderUsers);
      els.reloadBtn.addEventListener("click", reloadFromDisk);
      els.importJsonBtn.addEventListener("click", importCopiedJson);
      els.newBtn.addEventListener("click", createProfile);
      els.profileTab.addEventListener("click", function () { switchMode("profile"); });
      els.dbTab.addEventListener("click", function () { switchMode("db"); });
      els.jsonEditor.addEventListener("input", function () {
        setDirty(true);
        validateEditor();
      });
      els.saveBtn.addEventListener("click", saveCurrent);
      els.repairBtn.addEventListener("click", repairProfile);
      els.tokensBtn.addEventListener("click", regenerateTokens);
      els.cloneBtn.addEventListener("click", cloneProfile);
      els.copyProfileBtn.addEventListener("click", copyProfileJson);
      els.downloadProfileBtn.addEventListener("click", downloadProfileJson);
      els.switchBtn.addEventListener("click", switchProfile);
      els.deleteBtn.addEventListener("click", deleteProfile);
      els.selectVisibleInput.addEventListener("change", function () {
        for (const uid of state.visibleUids) {
          setDeleteSelection(uid, els.selectVisibleInput.checked);
        }
        renderUsers();
      });
      els.clearDeleteSelectionBtn.addEventListener("click", function () {
        state.deleteSelectedUids.clear();
        renderUsers();
      });
      for (const input of [els.nicknameInput, els.uidInput, els.friendInput, els.levelInput]) {
        input.addEventListener("input", applyQuickFields);
      }
    }

    async function refreshUsers() {
      const payload = await requestJson("/users");
      state.users = payload.users || [];
      pruneDeleteSelection();
      renderMeta(payload.meta);
      renderUsers();
    }

    function renderMeta(meta) {
      if (!meta) return;
      state.activeUid = meta.activeUserUid || "";
      const activeText = state.activeUid ? "active " + state.activeUid : "no active profile";
      els.dbMeta.textContent = meta.userCount + " profiles | " + activeText + " | " + formatBytes(meta.sizeBytes) + " | " + (meta.modifiedAt ? formatDate(meta.modifiedAt) : meta.userDbPath || "");
    }

    function getFilteredUsers() {
      const query = els.searchInput.value.trim().toLowerCase();
      return state.users.filter(function (user) {
        const haystack = [user.userUid, user.friendCode, user.nickname, user.steamStableId, user.deviceUid, user.officialUserUid].join(" ").toLowerCase();
        return !query || haystack.indexOf(query) !== -1;
      });
    }

    function renderUsers() {
      const filtered = getFilteredUsers();
      state.visibleUids = filtered.map(function (user) { return user.userUid; });
      els.userCount.textContent = filtered.length + " / " + state.users.length + " profiles";
      els.userList.innerHTML = "";
      for (const user of filtered) {
        const entry = document.createElement("div");
        entry.className = "user-entry" + (state.deleteSelectedUids.has(user.userUid) ? " selected-delete" : "");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "delete-check";
        checkbox.checked = state.deleteSelectedUids.has(user.userUid);
        checkbox.setAttribute("aria-label", "Select " + (user.nickname || user.userUid) + " for deletion");
        checkbox.addEventListener("click", function (event) { event.stopPropagation(); });
        checkbox.addEventListener("change", function () {
          setDeleteSelection(user.userUid, checkbox.checked);
          renderUsers();
        });

        const row = document.createElement("button");
        const isLoginActive = user.isActive || user.userUid === state.activeUid;
        row.className = "user-row" + (user.userUid === state.selectedUid ? " active" : "") + (isLoginActive ? " login-active" : "");
        row.type = "button";
        row.title = user.nickname || user.userUid;
        row.innerHTML =
          '<div class="user-name"><span></span><span></span></div>' +
          '<div class="user-line"></div>' +
          '<div class="user-line"></div>';
        row.querySelector(".user-name span:first-child").textContent = user.nickname || "(unnamed)";
        row.querySelector(".user-name span:last-child").textContent = (isLoginActive ? "Active | " : "") + "Lv " + (user.level || 0);
        const lines = row.querySelectorAll(".user-line");
        lines[0].textContent = user.userUid + " | " + user.friendCode + (user.importedOfficialProfile ? " | Official" : "");
        lines[1].textContent = "U " + user.units + " S " + user.ships + " O " + user.operators + " E " + user.equips;
        row.addEventListener("click", function () { selectUser(user.userUid); });
        entry.appendChild(checkbox);
        entry.appendChild(row);
        els.userList.appendChild(entry);
      }
      renderDeleteSelectionControls();
    }

    function setDeleteSelection(uid, selected) {
      if (!uid) return;
      if (selected) state.deleteSelectedUids.add(uid);
      else state.deleteSelectedUids.delete(uid);
    }

    function pruneDeleteSelection() {
      const liveUids = new Set(state.users.map(function (user) { return user.userUid; }));
      for (const uid of Array.from(state.deleteSelectedUids)) {
        if (!liveUids.has(uid)) state.deleteSelectedUids.delete(uid);
      }
    }

    function renderDeleteSelectionControls() {
      pruneDeleteSelection();
      const selectedCount = state.deleteSelectedUids.size;
      const visibleCount = state.visibleUids.length;
      const selectedVisibleCount = state.visibleUids.filter(function (uid) { return state.deleteSelectedUids.has(uid); }).length;
      els.deleteCount.textContent = selectedCount + " selected";
      els.deleteBtn.disabled = selectedCount === 0;
      els.clearDeleteSelectionBtn.disabled = selectedCount === 0;
      els.selectVisibleInput.disabled = visibleCount === 0;
      els.selectVisibleInput.checked = visibleCount > 0 && selectedVisibleCount === visibleCount;
      els.selectVisibleInput.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleCount;
    }

    async function selectUser(uid) {
      if (state.dirty && !window.confirm("Discard unsaved edits?")) return;
      const payload = await requestJson("/users/" + encodeURIComponent(uid));
      state.selectedUid = uid;
      state.profile = payload.user;
      state.mode = "profile";
      renderProfile();
      renderUsers();
      setStatus("Loaded " + uid, "ok");
    }

    function renderProfile() {
      els.profileTab.classList.toggle("active", state.mode === "profile");
      els.dbTab.classList.toggle("active", state.mode === "db");
      const profileMode = state.mode === "profile";
      for (const input of [els.nicknameInput, els.uidInput, els.friendInput, els.levelInput]) input.disabled = !profileMode || !state.profile;
      els.repairBtn.disabled = !profileMode || !state.selectedUid;
      els.tokensBtn.disabled = !profileMode || !state.selectedUid;
      els.cloneBtn.disabled = !profileMode || !state.selectedUid;
      els.copyProfileBtn.disabled = !profileMode || !state.selectedUid;
      els.downloadProfileBtn.disabled = !profileMode || !state.selectedUid;
      els.switchBtn.disabled = !profileMode || !state.selectedUid || state.selectedUid === state.activeUid;
      renderDeleteSelectionControls();
      if (profileMode && state.profile) {
        els.nicknameInput.value = state.profile.nickname || "";
        els.uidInput.value = state.profile.userUid || "";
        els.friendInput.value = state.profile.friendCode || "";
        els.levelInput.value = state.profile.level == null ? "" : String(state.profile.level);
        els.jsonEditor.value = JSON.stringify(state.profile, null, 2);
      } else {
        els.nicknameInput.value = "";
        els.uidInput.value = "";
        els.friendInput.value = "";
        els.levelInput.value = "";
        els.jsonEditor.value = state.db ? JSON.stringify(state.db, null, 2) : "";
      }
      validateEditor();
      setDirty(false);
    }

    async function switchMode(mode) {
      if (state.mode === mode) return;
      if (state.dirty && !window.confirm("Discard unsaved edits?")) return;
      state.mode = mode;
      if (mode === "db" && !state.db) {
        const payload = await requestJson("/db");
        state.db = payload.db;
        renderMeta(payload.meta);
      }
      renderProfile();
    }

    function parseEditor() {
      return JSON.parse(els.jsonEditor.value);
    }

    function validateEditor() {
      try {
        const parsed = parseEditor();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setJsonState("JSON object required", "invalid");
          return false;
        }
        setJsonState(state.mode === "profile" ? "Profile JSON valid" : "Database JSON valid", "ok");
        return true;
      } catch (err) {
        setJsonState(err.message, "invalid");
        return false;
      }
    }

    function applyQuickFields() {
      if (state.mode !== "profile" || !state.profile) return;
      let parsed;
      try {
        parsed = parseEditor();
      } catch (_) {
        return;
      }
      parsed.nickname = els.nicknameInput.value;
      parsed.userUid = els.uidInput.value.trim();
      parsed.friendCode = els.friendInput.value.trim();
      const level = Number(els.levelInput.value);
      parsed.level = Number.isFinite(level) ? level : els.levelInput.value;
      els.jsonEditor.value = JSON.stringify(parsed, null, 2);
      setDirty(true);
      validateEditor();
    }

    async function saveCurrent() {
      if (!validateEditor()) return;
      state.saving = true;
      els.saveBtn.disabled = true;
      try {
        const parsed = parseEditor();
        if (state.mode === "profile") {
          const payload = await requestJson("/users/" + encodeURIComponent(state.selectedUid), {
            method: "PUT",
            body: JSON.stringify(parsed)
          });
          state.profile = payload.user;
          state.selectedUid = state.profile.userUid;
          state.users = payload.users || state.users;
          renderMeta(payload.meta);
          renderProfile();
          renderUsers();
          setStatus("Saved " + state.selectedUid, "ok");
        } else {
          const payload = await requestJson("/db", {
            method: "PUT",
            body: JSON.stringify(parsed)
          });
          state.db = payload.db;
          state.users = payload.users || [];
          renderMeta(payload.meta);
          renderProfile();
          renderUsers();
          setStatus("Saved database", "ok");
        }
      } catch (err) {
        setStatus(err.message, "invalid");
      } finally {
        state.saving = false;
        els.saveBtn.disabled = !state.dirty;
      }
    }

    async function reloadFromDisk() {
      if (state.dirty && !window.confirm("Discard unsaved edits?")) return;
      const payload = await requestJson("/reload", { method: "POST", body: "{}" });
      state.db = payload.db;
      state.users = payload.users || [];
      renderMeta(payload.meta);
      renderUsers();
      if (state.selectedUid && state.db.users && state.db.users[state.selectedUid]) {
        state.profile = state.db.users[state.selectedUid];
      } else if (state.users[0]) {
        state.selectedUid = state.users[0].userUid;
        state.profile = state.db.users[state.selectedUid];
      } else {
        state.selectedUid = "";
        state.profile = null;
      }
      renderProfile();
      setStatus("Reloaded from disk", "ok");
    }

    async function createProfile() {
      const payload = await requestJson("/users", {
        method: "POST",
        body: JSON.stringify({ nickname: "LocalAdmin" })
      });
      state.users = payload.users || [];
      renderMeta(payload.meta);
      renderUsers();
      await selectUser(payload.user.userUid);
      setStatus("Created " + payload.user.userUid, "ok");
    }

    async function importCopiedJson() {
      if (state.dirty && !window.confirm("Discard unsaved edits before adding the copied profile?")) return;
      els.importJsonBtn.disabled = true;
      setStatus("Reading copied users.json", "warn");
      try {
        const imported = await readImportedUsersJson();
        const payload = await requestJson("/users/import-json-profile", {
          method: "POST",
          body: JSON.stringify(imported.db)
        });
        state.db = null;
        state.users = payload.users || [];
        state.deleteSelectedUids.clear();
        renderMeta(payload.meta);
        renderUsers();
        if (payload.user && payload.user.userUid) await selectUser(payload.user.userUid);
        else renderProfile();
        setStatus("Added profile from " + imported.source, "ok");
      } catch (err) {
        if (err && err.message !== "import-cancelled") setStatus(err.message, "invalid");
      } finally {
        els.importJsonBtn.disabled = false;
      }
    }

    async function readImportedUsersJson() {
      const clipboard = await tryReadClipboardUsersJson();
      if (clipboard) return clipboard;
      setStatus("Choose the copied users.json file", "warn");
      return readUsersJsonFile();
    }

    async function tryReadClipboardUsersJson() {
      if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") return null;
      try {
        const text = await navigator.clipboard.readText();
        if (!text || !text.trim()) return null;
        return { db: parseUsersJsonText(text), source: "clipboard" };
      } catch (_) {
        return null;
      }
    }

    function readUsersJsonFile() {
      return new Promise(function (resolve, reject) {
        els.importJsonFileInput.value = "";
        els.importJsonFileInput.onchange = function () {
          const file = els.importJsonFileInput.files && els.importJsonFileInput.files[0];
          if (!file) {
            reject(new Error("import-cancelled"));
            return;
          }
          const reader = new FileReader();
          reader.onload = function () {
            try {
              resolve({ db: parseUsersJsonText(String(reader.result || "")), source: file.name || "file" });
            } catch (err) {
              reject(err);
            }
          };
          reader.onerror = function () { reject(new Error("Failed to read users.json.")); };
          reader.readAsText(file);
        };
        els.importJsonFileInput.click();
      });
    }

    function parseUsersJsonText(text) {
      let db;
      try {
        db = JSON.parse(normalizeImportedJsonText(text));
      } catch (err) {
        throw new Error("Clipboard/file does not contain valid JSON: " + err.message);
      }
      if (!db || typeof db !== "object" || Array.isArray(db) || !db.users || typeof db.users !== "object" || Array.isArray(db.users)) {
        throw new Error("Clipboard/file JSON is not a users.json database.");
      }
      return db;
    }

    function normalizeImportedJsonText(text) {
      return String(text || "").replace(/^\uFEFF/, "").replace(/(?:\\n)+\s*$/, "");
    }

    async function getSelectedProfileExport() {
      if (!state.selectedUid) throw new Error("Select a profile first.");
      if (state.mode !== "profile") throw new Error("Switch to Profile JSON before exporting.");
      if (!validateEditor()) throw new Error("Profile JSON must be valid before exporting.");
      const payload = await requestJson("/users/" + encodeURIComponent(state.selectedUid) + "/export-json");
      const profile = parseEditor();
      const userUid = String(profile.userUid || payload.userUid || state.selectedUid);
      profile.userUid = userUid;
      payload.userUid = userUid;
      payload.fileName = "users-" + sanitizeFileNamePart(profile.nickname || userUid) + "-" + sanitizeFileNamePart(userUid) + ".json";
      payload.db.activeUserUid = userUid;
      payload.db.users = {};
      payload.db.users[userUid] = profile;
      return payload;
    }

    async function copyProfileJson() {
      if (!state.selectedUid) return;
      els.copyProfileBtn.disabled = true;
      setStatus("Copying profile users.json", "warn");
      try {
        const payload = await getSelectedProfileExport();
        await writeClipboardText(JSON.stringify(payload.db, null, 2));
        setStatus("Copied " + payload.userUid + " as users.json", "ok");
      } catch (err) {
        setStatus(err.message, "invalid");
      } finally {
        els.copyProfileBtn.disabled = false;
      }
    }

    async function downloadProfileJson() {
      if (!state.selectedUid) return;
      els.downloadProfileBtn.disabled = true;
      setStatus("Preparing profile export", "warn");
      try {
        const payload = await getSelectedProfileExport();
        downloadText(payload.fileName || "users-" + payload.userUid + ".json", JSON.stringify(payload.db, null, 2));
        setStatus("Exported " + payload.userUid + " as users.json", "ok");
      } catch (err) {
        setStatus(err.message, "invalid");
      } finally {
        els.downloadProfileBtn.disabled = false;
      }
    }

    async function writeClipboardText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch (_) {
        }
      }
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      area.style.top = "0";
      document.body.appendChild(area);
      area.focus();
      area.select();
      try {
        if (!document.execCommand("copy")) throw new Error("Clipboard copy failed.");
      } finally {
        document.body.removeChild(area);
      }
    }

    function downloadText(fileName, text) {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }

    function sanitizeFileNamePart(value) {
      return String(value || "profile").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
    }

    async function cloneProfile() {
      if (!state.selectedUid) return;
      const payload = await requestJson("/users/" + encodeURIComponent(state.selectedUid) + "/clone", {
        method: "POST",
        body: "{}"
      });
      state.users = payload.users || [];
      renderMeta(payload.meta);
      renderUsers();
      await selectUser(payload.user.userUid);
      setStatus("Cloned " + payload.user.userUid, "ok");
    }

    async function deleteProfile() {
      const liveUids = new Set(state.users.map(function (user) { return user.userUid; }));
      const targetUids = Array.from(state.deleteSelectedUids).filter(function (uid) { return liveUids.has(uid); });
      if (targetUids.length === 0) {
        renderDeleteSelectionControls();
        return;
      }
      const preview = targetUids.slice(0, 6).join(", ") + (targetUids.length > 6 ? ", ..." : "");
      if (!window.confirm("Delete " + targetUids.length + " selected profile" + (targetUids.length === 1 ? "" : "s") + "?\\n" + preview)) return;
      const selectedOpenProfile = targetUids.indexOf(state.selectedUid) !== -1;
      if (state.dirty && (state.mode === "db" || selectedOpenProfile) && !window.confirm("Discard unsaved edits before deleting selected profiles?")) return;
      const payload = await requestJson("/users/delete-selected", {
        method: "POST",
        body: JSON.stringify({ userUids: targetUids })
      });
      const deletedUserUids = payload.deletedUserUids || [];
      state.users = payload.users || [];
      state.db = null;
      for (const uid of deletedUserUids) state.deleteSelectedUids.delete(uid);
      const nextUid = selectedOpenProfile ? (state.users[0] && state.users[0].userUid) || "" : state.selectedUid;
      if (selectedOpenProfile) {
        state.selectedUid = "";
        state.profile = null;
      }
      renderMeta(payload.meta);
      renderUsers();
      if (nextUid) await selectUser(nextUid);
      else renderProfile();
      setStatus("Deleted " + deletedUserUids.length + " profile" + (deletedUserUids.length === 1 ? "" : "s"), "warn");
    }

    async function switchProfile() {
      if (!state.selectedUid || state.selectedUid === state.activeUid) return;
      if (state.dirty && !window.confirm("Discard unsaved edits before switching active profile?")) return;
      const payload = await requestJson("/users/" + encodeURIComponent(state.selectedUid) + "/switch", {
        method: "POST",
        body: "{}"
      });
      state.profile = payload.user;
      state.users = payload.users || state.users;
      state.db = null;
      renderMeta(payload.meta);
      renderProfile();
      renderUsers();
      setStatus("Switched active profile to " + state.selectedUid, "ok");
    }

    async function regenerateTokens() {
      if (!state.selectedUid) return;
      const payload = await requestJson("/users/" + encodeURIComponent(state.selectedUid) + "/tokens", {
        method: "POST",
        body: "{}"
      });
      state.profile = payload.user;
      state.users = payload.users || state.users;
      renderMeta(payload.meta);
      renderProfile();
      renderUsers();
      setStatus("Regenerated tokens", "ok");
    }

    async function repairProfile() {
      if (!state.selectedUid) return;
      const payload = await requestJson("/users/" + encodeURIComponent(state.selectedUid) + "/repair", {
        method: "POST",
        body: "{}"
      });
      state.profile = payload.user;
      state.users = payload.users || state.users;
      renderMeta(payload.meta);
      renderProfile();
      renderUsers();
      setStatus("Repaired defaults", "ok");
    }

    boot().catch(function (err) {
      setStatus(err.message, "invalid");
      setJsonState("Offline", "invalid");
    });
  </script>
</body>
</html>`;
}

module.exports = {
  createUserManager,
  rebuildUserDbIndexes,
};
