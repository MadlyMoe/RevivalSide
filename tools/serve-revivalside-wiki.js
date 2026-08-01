const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");

const ROOT_DIR = path.resolve(__dirname, "..");
const WIKI_DIR = path.join(ROOT_DIR, "wiki");
const EXTRACTED_ASSET_ROOT = path.join(ROOT_DIR, "extracted-assets", "all");
const WIKI_ASSET_CACHE_ROOT = path.join(ROOT_DIR, ".cache", "wiki-assets", "all");
const PREBUILT_WIKI_ASSET_ROOT = path.join(ROOT_DIR, "prebuilt", "wiki-assets", "all");
const DEFAULT_PORT = 5174;

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
  } catch (err) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  if (pathname.startsWith("/asset-png/")) {
    serveAssetPng(pathname.slice("/asset-png/".length), res);
    return;
  }

  // Routing for the "serina_save_editor" dir
  if (pathname.startsWith("/serina_save_editor/")) {
    const SERINA_DIR = path.join(ROOT_DIR, "serina_save_editor");
    let safePath = pathname.slice("/serina_save_editor/".length).replace(/^\/+/, "");
    if (safePath === "") safePath = "shop.html"; 
    
    const target = path.resolve(SERINA_DIR, safePath);
    serveFile(target, SERINA_DIR, res);
    return;
  }

  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(WIKI_DIR, safePath);

  serveFile(target, WIKI_DIR, res);
}
function serveAssetPng(relativePath, res) {
  const roots = getAssetRoots();
  for (const root of roots) {
    const target = path.resolve(root, relativePath);
    if (isPathUnderRoot(target, root) && fs.existsSync(target)) {
      serveFile(target, root, res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function getAssetRoots() {
  const configured = parsePathList(process.env.CS_WIKI_ASSET_ROOT || process.env.CS_WIKI_ASSETS_DIR || "");
  const roots = [...configured, WIKI_ASSET_CACHE_ROOT, EXTRACTED_ASSET_ROOT, PREBUILT_WIKI_ASSET_ROOT]
    .map((item) => path.resolve(ROOT_DIR, item))
    .filter((item) => fs.existsSync(item));
  return Array.from(new Set(roots.map((item) => path.normalize(item).toLowerCase()))).map((key) => roots.find((item) => path.normalize(item).toLowerCase() === key));
}

function serveFile(target, root, res) {
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

    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream";
    const noStore = type.includes("json") || type.includes("html") || type.includes("css") || type.includes("javascript");
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": noStore ? "no-store" : "public, max-age=60",
    });
    fs.createReadStream(target).pipe(res);
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
