"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, createOfficeHandlers, ensureOfficeState } = require("../modules/office");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const officeSource = fs.readFileSync(path.join(rootDir, "modules", "office", "index.js"), "utf8");
const packetNames = [
  "NKMPacket_OFFICE_CHAT_REQ",
  "NKMPacket_OFFICE_CHAT_ACK",
  "NKMPacket_OFFICE_CHAT_NOT",
  "NKMPacket_OFFICE_CHAT_LIST_REQ",
  "NKMPacket_OFFICE_CHAT_LIST_ACK",
];
const allowedSources = new Set([
  "Protocol/ClientPacketId.cs",
  ...packetNames.map((name) => `ClientPacket/Office/${name}.cs`),
]);

const sourceFiles = listFiles(assemblyDir, ".cs");
for (const packetName of packetNames) {
  const references = sourceFiles
    .filter((filePath) => fs.readFileSync(filePath, "utf8").includes(packetName))
    .map((filePath) => path.relative(assemblyDir, filePath).replace(/\\/g, "/"));
  assert(references.includes("Protocol/ClientPacketId.cs"), `${packetName} must remain in the frozen packet ID enum`);
  assert(references.includes(`ClientPacket/Office/${packetName}.cs`), `${packetName} frozen DTO is missing`);
  assert(
    references.every((relativePath) => allowedSources.has(relativePath)),
    `${packetName} unexpectedly became reachable from ${references.filter((entry) => !allowedSources.has(entry)).join(", ")}`
  );
}

const handlerIds = createOfficeHandlers().map((entry) => entry.packetId);
assert(!handlerIds.includes(3637), "unreachable OFFICE_CHAT_REQ must not have a server handler");
assert(!handlerIds.includes(3640), "unreachable OFFICE_CHAT_LIST_REQ must not have a server handler");
assert(!Object.keys(PACKETS).some((name) => name.startsWith("OFFICE_CHAT")), "dead Office chat constants must not advertise local support");
assert(!/handleChat|buildOfficeChat|chatMessages|nextOfficeMessageUid/.test(officeSource), "invented Office chat behavior remains locally");

const freshState = ensureOfficeState({});
assert(!Object.hasOwn(freshState, "chatMessages"));
assert(!Object.hasOwn(freshState, "nextMessageUid"));

console.log(`[office-chat-reachability-check] PASS packets=${packetNames.length} requestPaths=0 handlers=0`);

function listFiles(directory, extension) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
  }
  return files;
}
