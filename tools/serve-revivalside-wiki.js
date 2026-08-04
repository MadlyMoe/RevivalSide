const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");
const zlib = require("zlib");

const ROOT_DIR = path.resolve(__dirname, "..");
const WIKI_DIR = path.join(ROOT_DIR, "wiki");
const EXTRACTED_ASSET_ROOT = path.join(ROOT_DIR, "extracted-assets", "all");
const WIKI_ASSET_CACHE_ROOT = path.join(ROOT_DIR, ".cache", "wiki-assets", "all");
const PREBUILT_WIKI_ASSET_ROOT = path.join(ROOT_DIR, "prebuilt", "wiki-assets", "all");
const WIKI_ASSET_SCRIPT = path.join(ROOT_DIR, "tools", "ensure-wiki-assets.js");
const DEFAULT_PORT = 5174;
const assetBuilds = new Map();
let assetBuildQueue = Promise.resolve();

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const requestedPort = parsePort(process.argv) || parsePort(process.env.REVIVALSIDE_WIKI_PORT) || DEFAULT_PORT;
startServer(requestedPort, 0);

function startServer(port, attempts) {
  const server = http.createServer(handleRequest);
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE" && attempts < 20) {
      startServer(port + 1, attempts + 1);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`RevivalSide Wiki running at http://127.0.0.1:${port}/`);
  });
}

function handleRequest(req, res) {
  const parsed = url.parse(req.url || "/");
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || "/");
  } catch {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  if (pathname.startsWith("/asset-png/")) {
    serveAssetPng(pathname.slice("/asset-png/".length), req, res);
    return;
  }

  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(WIKI_DIR, safePath);

  serveFile(target, WIKI_DIR, req, res);
}

async function serveAssetPng(relativePath, req, res) {
  if (serveAssetFromDisk(relativePath, req, res)) return;
  try {
    await cacheAssetBundle(relativePath);
  } catch (error) {
    console.error(`[wiki-assets] ${error.message || error}`);
  }
  if (res.destroyed || serveAssetFromDisk(relativePath, req, res)) return;
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function serveAssetFromDisk(relativePath, req, res) {
  const roots = getAssetRoots();
  for (const root of roots) {
    const target = path.resolve(root, relativePath);
    if (isPathUnderRoot(target, root) && fs.existsSync(target)) {
      serveFile(target, root, req, res);
      return true;
    }
  }
  return false;
}

function cacheAssetBundle(relativePath) {
  const bundle = bundlePath(relativePath);
  if (!bundle || !fs.existsSync(WIKI_ASSET_SCRIPT)) return Promise.resolve();
  if (assetBuilds.has(bundle)) return assetBuilds.get(bundle);

  const job = assetBuildQueue.then(() => runAssetBuild(relativePath));
  assetBuildQueue = job.catch(() => {});
  const tracked = job.finally(() => assetBuilds.delete(bundle));
  assetBuilds.set(bundle, tracked);
  return tracked;
}

function bundlePath(relativePath) {
  const parts = String(relativePath || "").split(/[\\/]+/).filter(Boolean);
  const marker = parts.findIndex((part) => part === "Texture2D" || part === "Sprite" || part === "CutsceneBG16x9");
  return marker > 0 ? parts.slice(0, marker).join("/") : "";
}

function runAssetBuild(relativePath) {
  const assetUrl = `/asset-png/${String(relativePath).split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join("/")}`;
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [WIKI_ASSET_SCRIPT, "--asset-url", assetUrl, "--quiet"], {
      cwd: ROOT_DIR,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText = `${errorText}${chunk}`.slice(-8192);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.trim() || `image bundle extraction exited with code ${code}`));
    });
  });
}

function getAssetRoots() {
  const configured = parsePathList(process.env.CS_WIKI_ASSET_ROOT || process.env.CS_WIKI_ASSETS_DIR || "");
  const roots = [...configured, WIKI_ASSET_CACHE_ROOT, EXTRACTED_ASSET_ROOT, PREBUILT_WIKI_ASSET_ROOT]
    .map((item) => path.resolve(ROOT_DIR, item))
    .filter((item) => fs.existsSync(item));
  return Array.from(new Set(roots.map((item) => path.normalize(item).toLowerCase()))).map((key) => roots.find((item) => path.normalize(item).toLowerCase() === key));
}

function serveFile(target, root, req, res) {
  if (!isPathUnderRoot(target, root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(target, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const extension = path.extname(target).toLowerCase();
    const type = CONTENT_TYPES[extension] || "application/octet-stream";
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
    const compressible = [".html", ".css", ".js", ".json", ".svg"].includes(extension);
    const compress = compressible && /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
    const headers = {
      "Content-Type": type,
      "Cache-Control": extension === ".png" ? "public, max-age=86400" : "public, max-age=0, must-revalidate",
      ETag: etag,
      "Last-Modified": stat.mtime.toUTCString(),
    };
    if (compressible) headers.Vary = "Accept-Encoding";
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (compress) {
      headers["Content-Encoding"] = "gzip";
    } else {
      headers["Content-Length"] = stat.size;
    }
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs.createReadStream(target);
    stream.on("error", (error) => res.destroy(error));
    if (compress) stream.pipe(zlib.createGzip()).pipe(res);
    else stream.pipe(res);
  });
}

function isPathUnderRoot(target, root) {
  const fullRoot = path.resolve(root);
  const fullTarget = path.resolve(target);
  return fullTarget === fullRoot || fullTarget.startsWith(`${fullRoot}${path.sep}`);
}

function parsePort(value) {
  const args = Array.isArray(value) ? value : [value];
  const portFlagIndex = args.indexOf("--port");
  const raw = portFlagIndex >= 0 ? args[portFlagIndex + 1] : args[0];
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

function parsePathList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
