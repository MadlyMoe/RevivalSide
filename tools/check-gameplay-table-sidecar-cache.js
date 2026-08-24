const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readGameplayJsonSidecar, writeGameplayJsonSidecar } = require("../modules/gameplay-jsons");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-table-cache-"));
try {
  const directory = path.join(root, "StreamingAssets", "ab_script", "luac");
  fs.mkdirSync(directory, { recursive: true });
  const luacPath = path.join(directory, "TEST_TABLE.luac");
  fs.writeFileSync(luacPath, "bytecode", "utf8");

  const expected = { records: [{ id: 1, value: "cached" }] };
  const sidecar = writeGameplayJsonSidecar(luacPath, "TEST_TABLE.luac", JSON.stringify(expected));
  assert.strictEqual(sidecar, path.join(directory, "TEST_TABLE.json"));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")), expected);
  assert.deepStrictEqual(readGameplayJsonSidecar(luacPath), expected);

  writeGameplayJsonSidecar(luacPath, "TEST_TABLE.luac", JSON.stringify({ records: [] }));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")), expected, "versioned cache entries must be immutable");
  console.log("[gameplay-table-sidecar-cache] PASS atomic immutable JSON sidecars");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
