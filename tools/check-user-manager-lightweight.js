const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

const { createUserManager } = require("../server/userManager");
const { readActiveUserUid } = require("../modules/user-db-selection");

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-user-manager-"));
  const userDbPath = path.join(tempDir, "users.json");
  const activeUserPath = path.join(tempDir, "active-user.json");
  const largeMarker = "profile-payload-marker-" + "x".repeat(2 * 1024 * 1024);
  const userDb = {
    schemaVersion: 1,
    nextUserUid: "3",
    nextFriendCode: "10000003",
    activeUserUid: "1",
    users: {
      "1": { userUid: "1", friendCode: "10000001", nickname: "One", level: 1 },
      "2": { userUid: "2", friendCode: "10000002", nickname: "Two", level: 2, officialSnapshot: largeMarker },
    },
  };
  fs.writeFileSync(userDbPath, JSON.stringify(userDb), "utf8");
  const originalDb = fs.readFileSync(userDbPath, "utf8");
  let fullSaveCount = 0;

  const manager = createUserManager({
    allowRemote: true,
    userDb,
    userDbPath,
    activeUserPath,
    saveUserDb() {
      fullSaveCount += 1;
      fs.writeFileSync(userDbPath, JSON.stringify(userDb), "utf8");
    },
  });
  const server = http.createServer((req, res) => {
    manager.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    }).catch((error) => {
      res.writeHead(500);
      res.end(error.stack || error.message);
    });
  });

  try {
    await listen(server);
    const port = server.address().port;

    const page = await request(port, "GET", "/user-manager");
    assert.strictEqual(page.statusCode, 200);
    assert(page.text.includes('id="loadJsonBtn"'), "user manager is missing the explicit JSON load button");
    const clientScript = page.text.match(/<script>([\s\S]*?)<\/script>/);
    assert(clientScript, "user manager client script was not found");
    new vm.Script(clientScript[1], { filename: "user-manager-client.js" });

    const list = await request(port, "GET", "/user-manager/api/users");
    assert.strictEqual(list.statusCode, 200);
    assert.strictEqual(list.json.db, undefined, "profile list must not include the database");
    assert.strictEqual(list.text.includes("profile-payload-marker"), false, "profile list leaked heavyweight JSON");
    assert(list.text.length < 10_000, `profile list response was unexpectedly large: ${list.text.length}`);
    assert.strictEqual(list.text.includes("\n  \"users\""), false, "API response should use compact JSON");

    const switched = await request(port, "POST", "/user-manager/api/users/2/switch", "{}");
    assert.strictEqual(switched.statusCode, 200);
    assert.strictEqual(switched.json.meta.activeUserUid, "2");
    assert.strictEqual(switched.text.includes("profile-payload-marker"), false, "switch response leaked heavyweight JSON");
    assert(switched.text.length < 10_000, `switch response was unexpectedly large: ${switched.text.length}`);
    assert.strictEqual(fullSaveCount, 0, "switching must not save the full users.json database");
    assert.strictEqual(fs.readFileSync(userDbPath, "utf8"), originalDb, "switching changed users.json");
    assert.strictEqual(readActiveUserUid(activeUserPath), "2", "active selection sidecar was not written");
    assert(fs.statSync(activeUserPath).size < 256, "active selection sidecar should remain tiny");

    const switchedBack = await request(port, "POST", "/user-manager/api/users/1/switch", "{}");
    assert.strictEqual(switchedBack.statusCode, 200);
    assert.strictEqual(readActiveUserUid(activeUserPath), "1", "active selection sidecar was not replaced");
    assert.strictEqual(fullSaveCount, 0, "repeated switching must not save the full database");

    const editorProfile = await request(port, "GET", "/user-manager/api/users/2?view=editor");
    assert.strictEqual(editorProfile.statusCode, 200);
    assert.deepStrictEqual(editorProfile.json.omittedFields, ["officialSnapshot"]);
    assert.strictEqual(editorProfile.text.includes("profile-payload-marker"), false, "editor view leaked archived profile JSON");
    editorProfile.json.user.nickname = "Two edited";
    const savedEditorProfile = await request(port, "PUT", "/user-manager/api/users/2", JSON.stringify({
      user: editorProfile.json.user,
      preserveArchivedFields: true,
    }));
    assert.strictEqual(savedEditorProfile.statusCode, 200);
    assert.strictEqual(userDb.users["2"].nickname, "Two edited");
    assert.strictEqual(userDb.users["2"].officialSnapshot, largeMarker, "editor save discarded archived profile JSON");
    assert.strictEqual(savedEditorProfile.text.includes("profile-payload-marker"), false, "save response leaked archived profile JSON");
    assert.strictEqual(fullSaveCount, 1, "editing a profile should perform one full database save");

    const explicitProfile = await request(port, "GET", "/user-manager/api/users/2");
    assert.strictEqual(explicitProfile.statusCode, 200);
    assert.strictEqual(explicitProfile.text.includes("profile-payload-marker"), true, "explicit profile load omitted profile JSON");

    const reload = await request(port, "POST", "/user-manager/api/reload", "{}");
    assert.strictEqual(reload.statusCode, 200);
    assert.strictEqual(reload.json.db, undefined, "reload response must not echo the database");
    assert.strictEqual(reload.text.includes("profile-payload-marker"), false, "reload response leaked heavyweight JSON");

    console.log("user manager lightweight checks passed");
  } finally {
    await close(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, method, requestPath, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
        }
        resolve({ statusCode: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
