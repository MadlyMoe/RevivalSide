const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const root = process.argv[2] ? path.resolve(process.argv[2]) : "";
const originArg = argument("--origin");
const versionNameArg = argument("--version-name");
const versionCodeArg = Number(argument("--version-code"));
const packageNameArg = argument("--package-name") || "com.studiobside.CounterSide";
const scriptBundleArg = argument("--script-bundle");
const patchVersionArg = argument("--patch-version");
const androidModBundleArgs = argumentsFor("--android-mod-bundles");
const { encodePatchInfo, patchAndroidScriptEntry } = require("../modules/frozen-client-update");

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Usage: node tools/package-android-client-payload.js <payload-root> --version-name <name> --version-code <code> [--origin <patchfiles-url>] [--script-bundle <ab_script>] [--android-mod-bundles <directory>] [--patch-version <ANDROID_n>]");
  }
  if (!versionNameArg || !Number.isSafeInteger(versionCodeArg) || versionCodeArg <= 0) {
    throw new Error("--version-name and a positive integer --version-code are required; client compatibility must not be guessed.");
  }

  const sourcePatchInfo = path.join(root, "source-manifests", "LatestPatchInfo.json");
  if (!fs.existsSync(sourcePatchInfo)) throw new Error(`Missing native Android manifest: ${sourcePatchInfo}`);
  const sourcePatchInfoBody = fs.readFileSync(sourcePatchInfo);
  let patchInfoBody = sourcePatchInfoBody;
  let patch = decodePatchInfo(sourcePatchInfoBody);
  const sourcePatchVersion = patch.version;
  const patchVersion = patchVersionArg || sourcePatchVersion;
  if (!/^ANDROID_\d+$/.test(patchVersion) || patchVersion.length !== sourcePatchVersion.length) {
    throw new Error(`Invalid fixed-width Android patch version: ${sourcePatchVersion} -> ${patchVersion}`);
  }
  const sourceVersionRoot = path.join(root, "patchfiles", "Android", sourcePatchVersion);
  const versionRoot = path.join(root, "patchfiles", "Android", patchVersion);
  const existingManifest = readOptionalJson(path.join(root, "payload-manifest.json"));
  const existingVersionRoot = existingManifest && /^ANDROID_\d+$/.test(existingManifest.patchVersion || "")
    ? path.join(root, "patchfiles", "Android", existingManifest.patchVersion)
    : "";
  if (!fs.existsSync(versionRoot) && existingVersionRoot && fs.existsSync(existingVersionRoot)) {
    fs.renameSync(existingVersionRoot, versionRoot);
    console.log(`[android-payload] realigned existing payload ${existingManifest.patchVersion} -> ${patchVersion}`);
  }
  if (patchVersion !== sourcePatchVersion && !fs.existsSync(versionRoot) && fs.existsSync(sourceVersionRoot)) {
    fs.renameSync(sourceVersionRoot, versionRoot);
  }
  fs.mkdirSync(versionRoot, { recursive: true });
  const sourceScriptEntry = patch.entries.find((entry) => entry.path === "ab_script");
  if (!sourceScriptEntry) throw new Error("Native Android PatchInfo has no ab_script entry.");
  let scriptMd5 = sourceScriptEntry.md5;
  let scriptSize = sourceScriptEntry.size;
  if (scriptBundleArg) {
    const scriptBundle = path.resolve(scriptBundleArg);
    const stat = fs.statSync(scriptBundle, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Android script bundle was not found: ${scriptBundle}`);
    const bundle = fs.readFileSync(scriptBundle);
    scriptMd5 = crypto.createHash("md5").update(bundle).digest("hex");
    scriptSize = bundle.length;
    fs.copyFileSync(scriptBundle, safeTarget(versionRoot, "ab_script"));
    console.log(`[android-payload] injected ab_script at ${patchVersion} without changing the content version`);
  }
  patchInfoBody = patchAndroidScriptEntry(sourcePatchInfoBody, sourcePatchVersion, patchVersion, scriptMd5, scriptSize);
  patch = decodePatchInfo(patchInfoBody);
  for (const sourceArg of androidModBundleArgs) {
    const sourceRoot = path.resolve(sourceArg);
    if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Android mod bundle directory was not found: ${sourceRoot}`);
    }
    for (const sourceFile of walk(sourceRoot)) {
      const bundlePath = relative(sourceRoot, sourceFile);
      const target = safeTarget(versionRoot, bundlePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(sourceFile, target);
      const hashes = await hashFile(target);
      const replacement = { path: bundlePath, md5: hashes.md5, size: fs.statSync(target).size };
      const index = patch.entries.findIndex((entry) => entry.path.toLowerCase() === bundlePath.toLowerCase());
      if (index >= 0) patch.entries[index] = replacement;
      else patch.entries.push(replacement);
      console.log(`[android-payload] injected Android mod bundle ${bundlePath}`);
    }
  }
  patch.entries.sort((left, right) => left.path.localeCompare(right.path));
  patchInfoBody = encodePatchInfo(patch.version, patch.entries.map((entry) => ({
    relativePath: entry.path,
    md5: entry.md5,
    size: entry.size,
  })));
  fs.writeFileSync(path.join(versionRoot, "PatchInfo.json"), patchInfoBody);
  fs.writeFileSync(
    path.join(root, "patchfiles", "Android", "liveVersion.json"),
    `${JSON.stringify({ versionList: [{ version: patch.version }] })}\n`
  );

  const records = new Map();
  const missing = [];
  for (const entry of patch.entries) {
    const file = safeTarget(versionRoot, entry.path);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== entry.size) missing.push(entry);
    else records.set(relative(root, file), await hashFile(file));
  }

  const corrupt = [];
  for (const entry of patch.entries) {
    const key = relative(root, safeTarget(versionRoot, entry.path));
    const hashes = records.get(key);
    if (hashes && hashes.md5 !== entry.md5) {
      records.delete(key);
      corrupt.push(entry);
    }
  }

  const needed = [...missing, ...corrupt];
  const auxiliaryPaths = ["tutorialDungeonResources.json"];
  const missingAuxiliary = auxiliaryPaths.filter((filePath) => !fs.statSync(safeTarget(versionRoot, filePath), { throwIfNoEntry: false })?.isFile());
  if ((needed.length || missingAuxiliary.length) && !originArg) {
    throw new Error(`${needed.length} native patch files and ${missingAuxiliary.length} auxiliary files are missing; rerun with --origin <patchfiles-url>.`);
  }
  const origin = originArg ? new URL(originArg.endsWith("/") ? originArg : `${originArg}/`) : null;
  if (needed.length) {
    console.log(`[android-payload] fetching ${needed.length} missing/corrupt files`);
    await pool(needed, 6, async (entry, index) => {
      const file = safeTarget(versionRoot, entry.path);
      const url = new URL(`Android/${patch.version}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, origin);
      const hashes = await download(url, file, entry);
      records.set(relative(root, file), hashes);
      if ((index + 1) % 100 === 0 || index + 1 === needed.length) {
        console.log(`[android-payload] downloaded ${index + 1}/${needed.length}`);
      }
    });
  }
  for (const filePath of missingAuxiliary) {
    const file = safeTarget(versionRoot, filePath);
    const url = new URL(`Android/${patch.version}/${filePath}`, origin);
    records.set(relative(root, file), await downloadUnchecked(url, file));
    console.log(`[android-payload] downloaded auxiliary ${filePath}`);
  }

  const files = [];
  for (const file of walk(root)) {
    const filePath = relative(root, file);
    if (filePath === "payload-manifest.json" || filePath === "android-client/payload-manifest.json" || filePath.endsWith(".part")) continue;
    const hashes = records.get(filePath) || await hashFile(file);
    files.push({ path: filePath, size: fs.statSync(file).size, sha256: hashes.sha256 });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const apk = Object.fromEntries(files.filter((file) => file.path.startsWith("apk/")).map((file) => [path.posix.basename(file.path), file]));
  const manifest = {
    schemaVersion: 1,
    id: `counterside-android-${patch.version.toLowerCase()}`,
    packageName: packageNameArg,
    versionName: versionNameArg,
    versionCode: versionCodeArg,
    patchVersion: patch.version,
    patchBasePath: "patchfiles/",
    apk,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    files,
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(root, "payload-manifest.json"), manifestBody);
  fs.mkdirSync(path.join(root, "android-client"), { recursive: true });
  fs.writeFileSync(path.join(root, "android-client", "payload-manifest.json"), manifestBody);
  console.log(`[android-payload] ready ${manifest.id} files=${manifest.fileCount} bytes=${manifest.totalBytes}`);
}

function decodePatchInfo(buffer) {
  let offset = 0;
  function readValue() {
    const type = buffer[offset++];
    if (type === 3) return readString();
    if (type === 1) return Array.from({ length: readUInt32() }, readValue);
    if (type === 2) {
      const value = {};
      for (let count = readUInt32(); count > 0; count -= 1) value[readString()] = readValue();
      return value;
    }
    throw new Error(`Unsupported PatchInfo value type ${type} at ${offset - 1}`);
  }
  function readString() {
    const length = buffer[offset++];
    const value = buffer.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return value;
  }
  function readUInt32() {
    const value = buffer.readUInt32LE(offset);
    offset += 4;
    return value;
  }
  const value = readValue();
  if (offset !== buffer.length) throw new Error(`PatchInfo has ${buffer.length - offset} trailing bytes.`);
  if (!/^ANDROID_\d+$/.test(value.version) || !Array.isArray(value.data)) throw new Error("Invalid Android PatchInfo root.");
  return {
    version: value.version,
    entries: value.data.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 3 || !/^[a-f0-9]{32}$/i.test(entry[1])) {
        throw new Error("Invalid Android PatchInfo file entry.");
      }
      const size = Number(entry[2]);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid size for ${entry[0]}`);
      return { path: String(entry[0]).replace(/\\/g, "/"), md5: entry[1].toLowerCase(), size };
    }),
  };
}

async function download(url, file, expected) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url} returned HTTP ${response.status}`);
  const md5 = crypto.createHash("md5");
  const sha256 = crypto.createHash("sha256");
  let size = 0;
  const input = Readable.fromWeb(response.body);
  input.on("data", (chunk) => { size += chunk.length; md5.update(chunk); sha256.update(chunk); });
  await require("stream/promises").pipeline(input, fs.createWriteStream(temporary));
  const actualMd5 = md5.digest("hex");
  if (size !== expected.size || actualMd5 !== expected.md5) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Hash mismatch for ${expected.path}: ${size}/${actualMd5}`);
  }
  fs.renameSync(temporary, file);
  return { md5: actualMd5, sha256: sha256.digest("hex") };
}

async function downloadUnchecked(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.part`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url} returned HTTP ${response.status}`);
  await require("stream/promises").pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
  fs.renameSync(temporary, file);
  return hashFile(file);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const md5 = crypto.createHash("md5");
    const sha256 = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", (chunk) => { md5.update(chunk); sha256.update(chunk); });
    input.on("error", reject);
    input.on("end", () => resolve({ md5: md5.digest("hex"), sha256: sha256.digest("hex") }));
  });
}

async function pool(items, concurrency, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  }));
}

function safeTarget(parent, child) {
  const target = path.resolve(parent, ...String(child).split("/"));
  if (target !== parent && !target.startsWith(`${path.resolve(parent)}${path.sep}`)) throw new Error(`Unsafe patch path: ${child}`);
  return target;
}

function *walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield *walk(file);
    else if (entry.isFile()) yield file;
  }
}

function relative(parent, child) { return path.relative(parent, child).replace(/\\/g, "/"); }
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] || "" : ""; }
function argumentsFor(name) { return process.argv.flatMap((value, index) => value === name && process.argv[index + 1] ? [process.argv[index + 1]] : []); }
function readOptionalJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function selfTest() {
  const fixture = Buffer.concat([
    Buffer.from([2, 2, 0, 0, 0, 7]), Buffer.from("version"), Buffer.from([3, 14]), Buffer.from("ANDROID_335570"),
    Buffer.from([4]), Buffer.from("data"), Buffer.from([1, 1, 0, 0, 0, 1, 3, 0, 0, 0, 3, 9]), Buffer.from("ab_script"),
    Buffer.from([3, 32]), Buffer.from("10bc66034d78fd8dcaa78cbcc5e0a2f9"), Buffer.from([3, 2]), Buffer.from("10"),
  ]);
  const patch = decodePatchInfo(fixture);
  assert.strictEqual(patch.version, "ANDROID_335570");
  assert.deepStrictEqual(patch.entries[0], { path: "ab_script", md5: "10bc66034d78fd8dcaa78cbcc5e0a2f9", size: 10 });
  assert.strictEqual(
    decodePatchInfo(patchAndroidScriptEntry(fixture, patch.version, "ANDROID_335571", patch.entries[0].md5, patch.entries[0].size)).version,
    "ANDROID_335571"
  );
  assert.throws(() => safeTarget("C:\\payload", "../escape"), /Unsafe patch path/);
  console.log("[android-payload] self-test PASS");
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
