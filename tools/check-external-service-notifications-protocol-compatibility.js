"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { writeObjectList, writeSignedVarInt, writeVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const manifest = JSON.parse(read("protocol", "manifest.json"));
const packetIds = [611, 615, 618, 619, 620, 621];
const expectedNames = new Map([
  [611, "NKMPacket_INQUIRY_RESPONDED_NOT"],
  [615, "NKMPacket_SURVEY_UPSERT_NOT"],
  [618, "NKMPacket_SURVEY_RESET_NOT"],
  [619, "NKMPacket_EXIT_APP_NOT"],
  [620, "NKMPacket_MARQUEE_MESSAGE_NOT"],
  [621, "NKMPacket_MESSAGE_NOT"],
]);

for (const packetId of packetIds) {
  const entry = manifest.packets.find((packet) => packet.id === packetId);
  assert(entry, `manifest packet ${packetId}`);
  assert.strictEqual(entry.name, expectedNames.get(packetId));
  assert.deepStrictEqual(entry.clientSendLocations, [], `server notification ${packetId} must have no client request path`);
  assert(entry.clientReceiveLocations.length > 0, `server notification ${packetId} must retain its frozen receiver`);
}

const lobby = read("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
assert.match(lobby, /OnRecv\(NKMPacket_INQUIRY_RESPONDED_NOT[\s\S]*GET_STRING_TOY_CUSTOMER_CENTER_RESPOND/);
assert.match(lobby, /OnRecv\(NKMPacket_SURVEY_UPSERT_NOT[\s\S]*GetNKCSurveyMgr\(\)\.UpdaterOrAdd/);
assert.match(lobby, /OnRecv\(NKMPacket_SURVEY_RESET_NOT[\s\S]*GetNKCSurveyMgr\(\)\.Clear/);
assert.match(lobby, /OnRecv\(NKMPacket_EXIT_APP_NOT[\s\S]*SetErrorCodeForNGS/);
assert.match(lobby, /OnRecv\(NKMPacket_MARQUEE_MESSAGE_NOT[\s\S]*GetTranslationIfJson/);
assert.match(lobby, /OnRecv\(NKMPacket_MESSAGE_NOT[\s\S]*AddPopupMessage/);

const survey = read("Assembly-CSharp", "ClientPacket", "Common", "SurveyInfo.cs");
assert.match(survey, /PutOrGet\(ref this\.surveyId\)[\s\S]*PutOrGet\(ref this\.userLevel\)[\s\S]*PutOrGet\(ref this\.startDate\)[\s\S]*PutOrGet\(ref this\.endDate\)/);
assert.match(read("Assembly-CSharp", "ClientPacket", "Service", "NKMPacket_SURVEY_UPSERT_NOT.cs"), /PutOrGet<SurveyInfo>\(ref this\.surveyInfos\)/);
assert.match(read("Assembly-CSharp", "ClientPacket", "Service", "NKMPacket_EXIT_APP_NOT.cs"), /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)/);
assert.match(read("Assembly-CSharp", "ClientPacket", "Service", "NKMPacket_MARQUEE_MESSAGE_NOT.cs"), /PutOrGet\(ref this\.message\)/);
assert.match(read("Assembly-CSharp", "ClientPacket", "Service", "NKMPacket_MESSAGE_NOT.cs"), /PutOrGet\(ref this\.message\)/);

const runtimeSource = ["modules", "packet-handlers", "server", "combat-host"]
  .flatMap((directory) => listFiles(path.join(rootDir, directory)))
  .filter((file) => /\.(?:js|cs)$/.test(file))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
for (const name of expectedNames.values()) {
  assert(!runtimeSource.includes(name), `${name} unexpectedly gained a fabricated local operator feed`);
}

const neutralPackets = [
  [611, Buffer.alloc(0)],
  [615, writeObjectList([])],
  [618, Buffer.alloc(0)],
  [619, writeSignedVarInt(20136)],
  [620, writeVarInt(0)],
  [621, writeVarInt(0)],
];
validateManagedSchemas(neutralPackets);

console.log(`[external-service-notifications-check] PASS packets=${packetIds.length} requestPaths=0 localFeeds=0 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function read(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function validateManagedSchemas(packets) {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of packets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected external service packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
