const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const entry = path.join(root, "cs-listener.js");
assert.ok(fs.existsSync(entry), `listener entry is missing: ${entry}`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function main() {
  const [gamePort, httpPort] = await Promise.all([reservePort(), reservePort()]);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-listener-startup-"));
  const expected = new Set([
    `[+] Listening on 127.0.0.1:${gamePort}`,
    `[+] HTTP services listening on 127.0.0.1:${httpPort}`,
  ]);
  let stdout = "";
  let stderr = "";
  let settled = false;
  let child;

  try {
    child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        CS_PORT: String(gamePort),
        CS_HTTP_MIRROR_PORT: String(httpPort),
        CS_GAME_LISTEN_HOST: "127.0.0.1",
        CS_HTTP_LISTEN_HOST: "127.0.0.1",
        CS_PVP_LISTEN_HOST: "",
        CS_PRIVATE_PVP: "0",
        CS_USER_MANAGER: "1",
        CS_USER_MANAGER_ALLOW_REMOTE: "0",
        CS_CSHARP_COMBAT_HOST: "0",
        CS_REQUIRE_COMBAT_HOST: "0",
        CS_REQUIRE_FROZEN_CLIENT_PATCH: "0",
        CS_MODS_ROOT: path.join(stateRoot, "mods"),
        CS_COUNTERSIDE_MANAGED_DIR: stateRoot,
        CS_GAMEPLAY_TABLES_DIR: path.join(stateRoot, "gameplay-tables"),
        CS_USER_DB_PATH: path.join(stateRoot, "users.json"),
        CS_ACTIVE_USER_PATH: path.join(stateRoot, "active-user.json"),
        CS_SERVER_TIME_STATE_PATH: path.join(stateRoot, "server-time.json"),
        CS_CAPTURED_FLOW_DIR: path.join(stateRoot, "captured-flows"),
        CS_CAPTURED_TCP_DIR: path.join(stateRoot, "captured-tcp"),
        CS_CAPTURED_GAME_FLOW_DIR: path.join(stateRoot, "captured-game-flow"),
        CS_ANDROID_CLIENT_UPDATE_DIR: path.join(stateRoot, "android-client-update"),
        CS_ANDROID_CLIENT_PAYLOAD_DIR: path.join(stateRoot, "android-client-payload"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("listener startup timed out")), 20_000);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };
      const inspect = () => {
        for (const marker of [...expected]) {
          if (stdout.includes(marker)) expected.delete(marker);
        }
        if (!expected.size) finish(resolve);
      };
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        inspect();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code) => {
        if (expected.size) finish(() => reject(new Error(`listener exited with code ${code} before readiness`)));
      });
    });

    await ready;
    assert.strictEqual(stderr.trim(), "", `listener wrote to stderr:\n${stderr.trim()}`);
    console.log(`[listener-runtime-startup] PASS ${root}`);
  } catch (error) {
    const output = [error.message, stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    throw new Error(output);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[listener-runtime-startup] FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
