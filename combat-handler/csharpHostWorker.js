const { parentPort, workerData } = require("worker_threads");
const { spawn } = require("child_process");

let child = null;
let stdoutBuffer = "";
let stderrBuffer = "";
const pending = [];

startChild();

parentPort.on("message", (message) => {
  if (!message || !message.sharedBuffer) return;
  if (message.shutdown) {
    stopChild();
    const header = new Int32Array(message.sharedBuffer);
    Atomics.store(header, 0, 1);
    Atomics.notify(header, 0, 1);
    parentPort.close();
    return;
  }
  if (!child || child.killed || !child.stdin.writable) {
    complete(message.sharedBuffer, JSON.stringify({ ok: false, error: "C# combat host process is not running" }));
    return;
  }
  pending.push(message.sharedBuffer);
  child.stdin.write(`${message.input}\n`);
});
parentPort.on("close", stopChild);
process.on("exit", stopChild);

function startChild() {
  const runDirectly = Boolean(workerData.runDirectly);
  const fileName = runDirectly ? workerData.hostPath : workerData.dotnetPath || "dotnet";
  const args = runDirectly ? ["--stdio"] : [workerData.hostPath, "--stdio"];
  child = spawn(fileName, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: workerData.modTablesDir ? { ...process.env, CS_MOD_TABLES_DIR: workerData.modTablesDir } : process.env,
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const sharedBuffer = pending.shift();
      if (sharedBuffer) complete(sharedBuffer, line || JSON.stringify({ ok: false, error: "empty host response" }));
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    if (stderrBuffer.length > 8192) stderrBuffer = stderrBuffer.slice(-8192);
  });

  child.on("exit", (code, signal) => {
    const error = `C# combat host exited code=${code} signal=${signal || ""} ${stderrBuffer.trim()}`.trim();
    while (pending.length) complete(pending.shift(), JSON.stringify({ ok: false, error }));
  });
}

function complete(sharedBuffer, text) {
  const header = new Int32Array(sharedBuffer, 0, 2);
  const bytes = Buffer.from(sharedBuffer, 8);
  const payload = Buffer.from(String(text), "utf8");
  if (payload.length > bytes.length) {
    const error = Buffer.from(JSON.stringify({ ok: false, error: "C# combat host response exceeded shared buffer" }), "utf8");
    error.copy(bytes, 0, 0, Math.min(error.length, bytes.length));
    Atomics.store(header, 1, Math.min(error.length, bytes.length));
  } else {
    payload.copy(bytes, 0);
    Atomics.store(header, 1, payload.length);
  }
  Atomics.store(header, 0, 1);
  Atomics.notify(header, 0, 1);
}

function stopChild() {
  if (child && !child.killed) child.kill();
  child = null;
}
