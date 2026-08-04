const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-host-refresh-"));
  const runtimeRoot = path.join(temporary, "current");
  const fakeHost = path.join(temporary, "fake-host.js");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(fakeHost, `
const fs = require("fs");
const path = require("path");
const readline = require("readline");
let validatedHash = "";
let validatedUnitIds = [];
function manifest() { return JSON.parse(fs.readFileSync(path.join(process.env.CS_MOD_TABLES_DIR, "mod-set.json"), "utf8")); }
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line);
  const current = manifest();
  if (input.command === "validateUnitTemplets") {
    validatedHash = current.hash;
    validatedUnitIds = input.data.unitIds;
    process.stdout.write(JSON.stringify({ ok: true, summary: "validated" }) + "\\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, hash: current.hash, validatedHash, validatedUnitIds }) + "\\n");
  }
});
`, "utf8");

  const writeManifest = (hash, unitIds, builtAt) => fs.writeFileSync(path.join(runtimeRoot, "mod-set.json"), JSON.stringify({ hash, unitIds, builtAt }), "utf8");
  writeManifest("runtime", [26055], "build-one");
  const host = createCsharpCombatHost({ enabled: true, dllPath: fakeHost, dotnetPath: process.execPath, modTablesDir: runtimeRoot, timeoutMs: 10000 });
  try {
    const first = host.request("startBattle", {});
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.validatedHash, "runtime");
    assert.deepStrictEqual(first.validatedUnitIds, [26055]);

    writeManifest("runtime", [26055, 26056, 26057, 26058, 26059, 26060, 26061], "build-two");
    const second = host.request("startBattle", {});
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.validatedHash, "runtime");
    assert.deepStrictEqual(second.validatedUnitIds, [26055, 26056, 26057, 26058, 26059, 26060, 26061]);
    assert.notStrictEqual(second.pid, first.pid);
    console.log("[check-csharp-host-runtime-refresh] ok");
  } finally {
    await host.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
