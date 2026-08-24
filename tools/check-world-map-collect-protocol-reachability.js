"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { createWorldMapHandlers } = require("../modules/world-map");

const ROOT = path.resolve(__dirname, "..");
const sceneSource = fs.readFileSync(path.join(ROOT, "Assembly-CSharp", "NKC", "NKC_SCEN_WORLDMAP.cs"), "utf8");
assert.match(sceneSource, /Send_NKMPacket_WORLDMAP_COLLECT_REQ\(int cityID\)\s*\{\s*\}/);

const requestReferences = spawnSync(
  "rg",
  ["-l", "new NKMPacket_WORLDMAP_COLLECT_REQ|NKMPacket_WORLDMAP_COLLECT_REQ\\s+[A-Za-z_]", "Assembly-CSharp/NKC"],
  { cwd: ROOT, encoding: "utf8" }
);
assert([0, 1].includes(requestReferences.status), requestReferences.stderr || "frozen source search failed");
const requestPaths = String(requestReferences.stdout || "").trim().split(/\r?\n/).filter(Boolean);
assert.deepStrictEqual(requestPaths, [], "frozen NKC client must not construct or send WORLDMAP_COLLECT_REQ");

const handlerIds = new Set(createWorldMapHandlers().map((entry) => entry.packetId));
assert(!handlerIds.has(2016), "retired WORLDMAP_COLLECT_REQ must not have a local handler");

console.log(`[world-map-collect-reachability] PASS packets=2 requestPaths=${requestPaths.length} handlers=${handlerIds.has(2016) ? 1 : 0}`);
