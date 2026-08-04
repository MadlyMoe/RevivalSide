const http = require("http");
const path = require("path");
const { createAssetViewer } = require("../server/assetViewer");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_PORT = 5175;
const port = parsePort(process.argv) || parsePort(process.env.REVIVALSIDE_MODSIDE_PORT) || DEFAULT_PORT;
const viewer = createAssetViewer({
  rootDir: ROOT_DIR,
  basePath: "/mod-side",
  allowRemote: process.env.CS_ASSET_VIEWER_ALLOW_REMOTE === "1",
  allowRemoteModCreator: process.env.CS_MOD_CREATOR_ALLOW_REMOTE === "1",
});

const server = http.createServer(async (req, res) => {
  if ((req.url === "/" || req.url === "") && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(302, { Location: "/mod-side" });
    res.end();
    return;
  }
  if (await viewer.handle(req, res)) return;
  res.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Mod:Side running at http://127.0.0.1:${port}/mod-side`);
});

function parsePort(value) {
  const args = Array.isArray(value) ? value : [value];
  const index = args.indexOf("--port");
  const number = Number(index >= 0 ? args[index + 1] : args[0]);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : 0;
}
