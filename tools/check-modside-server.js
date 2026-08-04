"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const net = require("net");
const path = require("path");

async function main() {
  const port = await availablePort();
  const child = childProcess.spawn(process.execPath, [path.join(__dirname, "serve-modside.js"), "--port", String(port)], {
    cwd: path.resolve(__dirname, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitForReady(child);
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.strictEqual(root.status, 302);
    assert.strictEqual(root.headers.get("location"), "/mod-side");
    const page = await fetch(`http://127.0.0.1:${port}/mod-side`);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'self' 'unsafe-inline'/);
    assert.match(page.headers.get("content-security-policy"), /style-src 'self' 'unsafe-inline'/);
    assert.match(await page.text(), /<div id="root"><\/div>/);
    const health = await fetch(`http://127.0.0.1:${port}/mod-side/api/health`);
    assert.strictEqual(health.status, 200);
    assert(Number.isInteger((await health.json()).tableCount));
  } finally {
    child.kill();
  }
  assert.strictEqual(stderr, "");
  console.log("[modside-server] PASS standalone React page and API health");
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mod:Side did not start within 20 seconds.")), 20000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Mod:Side exited before startup (${code}).`)); });
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("Mod:Side running")) { clearTimeout(timer); resolve(); } });
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
