const assert = require("assert");
const fs = require("fs");

const BASE_MODE = 'const REWRITE_CAPTURED_SERVER_INFO = process.env.CS_REWRITE_CAPTURED_SERVER_INFO !== "0";';
const PATCHED_MODE = 'let rewriteCapturedServerInfo = process.env.CS_REWRITE_CAPTURED_SERVER_INFO !== "0";';
const BASE_MIRROR = 'if (REWRITE_CAPTURED_SERVER_INFO && requestUrl.pathname.endsWith("/ServerInfo_V2.json")) {';
const PATCHED_MIRROR = 'if (rewriteCapturedServerInfo && requestUrl.pathname.endsWith("/ServerInfo_V2.json")) {';
const WARMUP = '  if ((req.method === "POST" || req.method === "GET") && url.pathname === "/launcher/api/warmup") {';
const ROUTE_MARKER = 'url.pathname === "/launcher/api/server-info-mode"';

function routeBlock(eol) {
  return [
    '  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/launcher/api/server-info-mode") {',
    '    const requestedMode = url.searchParams.get("mode");',
    '    const serverInfoMode = requestedMode == null',
    '      ? (rewriteCapturedServerInfo ? "revivalside" : "official")',
    '      : String(requestedMode).trim().toLowerCase();',
    '    if (serverInfoMode !== "revivalside" && serverInfoMode !== "official") {',
    '      sendJsonResponse(res, 400, { ok: false, error: "mode must be revivalside or official" });',
    '      return true;',
    '    }',
    '    rewriteCapturedServerInfo = serverInfoMode === "revivalside";',
    '    console.log(`[server-info] mode=${serverInfoMode}`);',
    '    sendJsonResponse(res, 200, { ok: true, serverInfoMode });',
    '    return true;',
    '  }',
    '',
  ].join(eol);
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  assert(first >= 0, `Missing ${label} anchor`);
  assert(source.indexOf(before, first + before.length) < 0, `Duplicate ${label} anchor`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchAndroidOfficialBridge(source) {
  if (source.includes(ROUTE_MARKER)) {
    assert(source.includes(PATCHED_MODE) && source.includes(PATCHED_MIRROR), "Android bridge patch is incomplete");
    return source;
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let patched = replaceExactlyOnce(source, BASE_MODE, PATCHED_MODE, "server-info mode");
  patched = replaceExactlyOnce(patched, WARMUP, `${routeBlock(eol)}${WARMUP}`, "launcher warmup route");
  patched = replaceExactlyOnce(patched, BASE_MIRROR, PATCHED_MIRROR, "ServerInfo rewrite");
  return patched;
}

function removeAndroidOfficialBridge(source) {
  if (!source.includes(ROUTE_MARKER)) {
    assert(source.includes(BASE_MODE) && source.includes(BASE_MIRROR), "Listener is neither baseline nor Android bridge patched");
    return source;
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  let baseline = replaceExactlyOnce(source, `${routeBlock(eol)}${WARMUP}`, WARMUP, "Android bridge route");
  baseline = replaceExactlyOnce(baseline, PATCHED_MODE, BASE_MODE, "patched server-info mode");
  baseline = replaceExactlyOnce(baseline, PATCHED_MIRROR, BASE_MIRROR, "patched ServerInfo rewrite");
  return baseline;
}

function selfTest() {
  const fixture = [
    BASE_MODE,
    "async function serveLauncherApi(req, res) {",
    WARMUP,
    "    return true;",
    "  }",
    "}",
    "function serveMirror(requestUrl) {",
    `  ${BASE_MIRROR}`,
    "    return true;",
    "  }",
    "}",
    "",
  ].join("\n");
  const patched = patchAndroidOfficialBridge(fixture);
  assert(patched.includes(ROUTE_MARKER));
  assert(patched.includes('rewriteCapturedServerInfo = serverInfoMode === "revivalside";'));
  assert(patched.includes('error: "mode must be revivalside or official"'));
  assert.strictEqual(removeAndroidOfficialBridge(patched), fixture);
  assert.strictEqual(patchAndroidOfficialBridge(patched), patched);
  console.log("[android-official-bridge] self-test PASS");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
  } else {
    const reverse = args.includes("--reverse");
    const paths = args.filter((value) => value !== "--reverse");
    assert(paths.length === 1 || paths.length === 2, "Usage: node patch-android-official-server-bridge.js [--reverse] <input> [output]");
    const input = paths[0];
    const output = paths[1] || input;
    const source = fs.readFileSync(input, "utf8");
    fs.writeFileSync(output, reverse ? removeAndroidOfficialBridge(source) : patchAndroidOfficialBridge(source), "utf8");
    console.log(`[android-official-bridge] ${reverse ? "restored baseline" : "patched"} ${output}`);
  }
}

module.exports = { patchAndroidOfficialBridge, removeAndroidOfficialBridge };
