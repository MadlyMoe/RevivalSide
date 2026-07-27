const fs = require("fs");
const path = require("path");

function resolveActiveUserPath(userDbPath, configuredPath = "") {
  if (configuredPath) return path.resolve(configuredPath);
  if (!userDbPath) return "";
  return path.join(path.dirname(path.resolve(userDbPath)), "active-user.json");
}

function readActiveUserUid(activeUserPath) {
  if (!activeUserPath || !fs.existsSync(activeUserPath)) return "";
  try {
    const parsed = JSON.parse(fs.readFileSync(activeUserPath, "utf8"));
    return String(parsed && parsed.activeUserUid || "").trim();
  } catch (error) {
    console.log(`[user-db] active selection read failed: ${error.message}`);
    return "";
  }
}

function applyActiveUserSelection(userDb, activeUserPath) {
  const selectedUid = readActiveUserUid(activeUserPath);
  if (!selectedUid || !userDb || !userDb.users || !userDb.users[selectedUid]) return false;
  userDb.activeUserUid = selectedUid;
  return true;
}

function writeActiveUserSelection(activeUserPath, activeUserUid) {
  if (!activeUserPath) return false;
  const target = path.resolve(activeUserPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  const payload = {
    version: 1,
    activeUserUid: String(activeUserUid || "").trim(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return true;
}

module.exports = {
  applyActiveUserSelection,
  readActiveUserUid,
  resolveActiveUserPath,
  writeActiveUserSelection,
};
