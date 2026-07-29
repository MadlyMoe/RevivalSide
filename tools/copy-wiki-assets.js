const fs = require("fs");
const path = require("path");
const { readWikiDataFiles } = require("./ensure-wiki-assets");

const ROOT_DIR = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const assetsJsonPath = path.resolve(args.assetsJson || path.join(ROOT_DIR, "wiki", "data", "assets.json"));
const sourceRoot = path.resolve(args.source || path.join(ROOT_DIR, "extracted-assets", "all"));
const outputRoot = path.resolve(args.output || path.join(ROOT_DIR, "prebuilt", "wiki-assets", "all"));

main();

function main() {
  if (!fs.existsSync(assetsJsonPath)) throw new Error(`Missing wiki asset data: ${assetsJsonPath}`);
  if (!fs.existsSync(sourceRoot)) throw new Error(`Missing extracted asset root: ${sourceRoot}`);

  const urls = new Set();
  for (const data of readWikiDataFiles(assetsJsonPath)) collectAssetUrls(data, urls);

  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  let copied = 0;
  let bytes = 0;
  const missing = [];
  for (const url of Array.from(urls).sort()) {
    const relativePath = decodeAssetUrl(url);
    const sourcePath = path.resolve(sourceRoot, relativePath);
    if (!sourcePath.startsWith(sourceRoot + path.sep)) {
      missing.push(`${url} (escaped source root)`);
      continue;
    }
    if (!fs.existsSync(sourcePath)) {
      missing.push(url);
      continue;
    }

    const targetPath = path.resolve(outputRoot, relativePath);
    if (!targetPath.startsWith(outputRoot + path.sep)) {
      missing.push(`${url} (escaped output root)`);
      continue;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied += 1;
    bytes += fs.statSync(sourcePath).size;
  }

  const manifest = {
    source: path.relative(ROOT_DIR, assetsJsonPath).replace(/\\/g, "/"),
    copied,
    missing,
    bytes,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outputRoot, "revivalside-wiki-assets-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (missing.length) {
    throw new Error(`Missing ${missing.length} wiki asset(s); first missing: ${missing[0]}`);
  }
  console.log(`[wiki-assets] copied ${copied} PNG assets (${formatBytes(bytes)}) to ${outputRoot}`);
}

function collectAssetUrls(value, urls) {
  if (!value) return;
  if (typeof value === "string") {
    if (value.startsWith("/asset-png/")) urls.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAssetUrls(item, urls);
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectAssetUrls(item, urls);
  }
}

function decodeAssetUrl(url) {
  return url
    .slice("/asset-png/".length)
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join(path.sep);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--assets-json") result.assetsJson = argv[++index];
    else if (arg === "--source") result.source = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/copy-wiki-assets.js [--assets-json <path>] [--source <dir>] [--output <dir>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function formatBytes(value) {
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  return `${value} B`;
}
