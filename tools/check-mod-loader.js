const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createModProjectStore } = require("../modules/mod-projects");
const { createModRuntime } = require("../modules/mod-loader");
const { readGameplayTable } = require("../modules/gameplay-jsons");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-mod-loader-"));
try {
  const modsRoot = path.join(root, "mods");
  const gameplayRoot = path.join(root, "gameplay-jsons");
  const tableDir = path.join(gameplayRoot, "Assetbundles", "ab_script", "luac");
  fs.mkdirSync(tableDir, { recursive: true });
  const baseRecords = [{ id: 1, hp: 10 }, { id: 2, hp: 40 }];
  fs.writeFileSync(path.join(tableDir, "TEST.json"), JSON.stringify({
    rootName: "TEST",
    records: baseRecords,
    root: baseRecords,
    globals: { TEST: baseRecords, TEST_VERSION: 1 },
  }));

  const env = {};
  const store = createModProjectStore({ rootDir: root, modsRoot });
  store.createProject({ id: "alpha", name: "Alpha", version: "1.0.0" });
  store.createProject({ id: "beta", name: "Beta", version: "2.0.0" });
  const table = { directory: "ab_script", fileName: "TEST.json", tableName: "TEST", format: "json" };
  store.writePatch("alpha", { table, key: { field: "id", value: 1 }, value: { id: 1, hp: 20 } });
  store.writePatch("alpha", { table, key: { field: "id", value: 3 }, value: { id: 3, hp: 50 } });
  store.writePatch("beta", { table, key: { field: "id", value: 1 }, value: { id: 1, hp: 30 } });
  store.writePatch("beta", { table, key: { field: "id", value: 2 }, value: null });
  store.writeFullTable("alpha", {
    table: { directory: "ab_script", fileName: "EXTRA.json", tableName: "EXTRA", format: "json" },
    compiled: {
      rootName: "EXTRA",
      root: { speed: 230, seeTarget: true, values: [{ id: 9, value: "added" }] },
    },
  });
  store.writeString("alpha", "MODSIDE_TEST_NAME", "Test Name");
  fs.mkdirSync(path.join(store.readProject("alpha").root, "assets", "bundles"), { recursive: true });
  fs.writeFileSync(path.join(store.readProject("alpha").root, "assets", "bundles", "test.bundle"), "bundle");
  const alphaCopy = store.copyProject("alpha", { id: "alpha-copy", name: "Alpha Copy" });
  assert.strictEqual(alphaCopy.manifest.id, "alpha-copy");
  assert.strictEqual(alphaCopy.manifest.name, "Alpha Copy");
  assert.strictEqual(alphaCopy.patches.length, 2);
  assert.strictEqual(alphaCopy.tables.length, 1);
  assert.strictEqual(alphaCopy.strings.MODSIDE_TEST_NAME, "Test Name");
  assert.strictEqual(store.readProject("alpha").manifest.name, "Alpha");
  assert.throws(() => store.copyProject("alpha", { id: "alpha-copy" }), /already exists/);

  const runtime = createModRuntime({ rootDir: root, env, modStore: store });
  runtime.writeProfile({ enabled: ["alpha", "beta"] });
  const first = runtime.build();
  assert.strictEqual(first.built.tableCount, 2);
  assert.strictEqual(first.built.patchCount, 4);
  assert.strictEqual(first.built.fullTableCount, 1);
  assert.strictEqual(first.built.stringCount, 1);
  assert.strictEqual(first.built.assetBundleCount, 1);
  assert.strictEqual(first.built.conflicts.length, 1);
  const output = path.join(runtime.currentRoot, "Assetbundles", "ab_script", "luac");
  const compiled = JSON.parse(fs.readFileSync(path.join(output, "TEST.json"), "utf8"));
  assert.deepStrictEqual(compiled.records, [{ id: 1, hp: 30 }, { id: 3, hp: 50 }]);
  assert.deepStrictEqual(compiled.globals.TEST, compiled.records);
  assert.match(fs.readFileSync(path.join(output, "TEST.lua"), "utf8"), /hp=30/);
  assert.match(fs.readFileSync(path.join(output, "EXTRA.lua"), "utf8"), /value="added"/);
  const extra = JSON.parse(fs.readFileSync(path.join(output, "EXTRA.json"), "utf8"));
  assert.strictEqual(extra.root.speed, 230);
  assert.strictEqual(extra.root.seeTarget, true);
  assert.deepStrictEqual(extra.root.values, [{ id: 9, value: "added" }]);
  assert.doesNotMatch(fs.readFileSync(path.join(output, "EXTRA.lua"), "utf8"), /values=\{values=/);
  assert.strictEqual(fs.readFileSync(path.join(runtime.currentRoot, "Strings", "MODSIDE_TEST_NAME.txt"), "utf8"), "Test Name");
  assert.strictEqual(fs.readFileSync(path.join(runtime.currentRoot, "ClientAssetBundles", "test.bundle"), "utf8"), "bundle");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runtime.currentRoot, "client", "mod-set.json"))).hash, first.built.hash);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runtime.currentRoot, "server", "mod-set.json"))).hash, first.built.hash);
  assert.deepStrictEqual(readGameplayTable("ab_script", "TEST.json", { rootDir: root, env, noCache: true }).records, compiled.records);

  runtime.writeProfile({ enabled: ["beta", "alpha"] });
  runtime.build();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(output, "TEST.json"))).records[0].hp, 20);
  runtime.rollback();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(output, "TEST.json"))).records[0].hp, 30);
  store.createProject({ id: "invalid", name: "Invalid" });
  store.writePatch("invalid", { table, key: { field: "id", value: 1 }, value: { id: 1, hp: "wrong" } });
  const previousProfile = runtime.readProfile();
  assert.throws(() => runtime.applyProfile({ enabled: ["invalid"] }), /value\.hp must keep type number/);
  assert.deepStrictEqual(runtime.readProfile(), previousProfile);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(output, "TEST.json"))).records[0].hp, 30);
  console.log("[check-mod-loader] ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
