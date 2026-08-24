"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const tableDir = path.join(rootDir, "gameplay-jsons", "StreamingAssets", "ab_script", "luac");
const tournamentSource = readSource("NKM/Templet/NKMTournamentTemplet.cs");
const loginSource = readSource("NKC/NKC_SCEN_LOGIN.cs");
const collectionSource = readSource("NKM/Event/NKMEventCollectionIndexTemplet.cs");
const moduleSource = readSource("NKC/UI/Module/NKCUIModuleSubUITournament.cs");

assert.match(
  tournamentSource,
  /Find\(\(NKMTournamentTemplet x\) => x\.intervalTemplet\.IsValidTime\(current\)\)/,
  "login-time tournament lookup must remain bounded by the frozen main interval"
);
assert.match(
  loginSource,
  /if \(NKMTournamentTemplet\.Find\(ServiceTime\.Now\) != null\)\s*\{\s*NKCPacketSender\.Send_NKMPacket_TOURNAMENT_INFO_REQ\(\);\s*\}/s,
  "login must not request Tournament info without an active frozen template"
);
assert.match(
  collectionSource,
  /nkmintervalTemplet != null && nkmintervalTemplet\.IsValidTime\(serviceTime\)/,
  "event-module discovery must remain bounded by the collection interval"
);
assert.match(
  moduleSource,
  /this\.m_NKMTournamentTemplet = NKMTournamentTemplet\.Find\(intValue\);\s*if \(this\.m_NKMTournamentTemplet == null\)\s*\{[\s\S]*?ScenChangeFade\(NKM_SCEN_ID\.NSI_HOME, true\);\s*return;\s*\}[\s\S]*?Send_NKMPacket_TOURNAMENT_INFO_REQ\(\);/,
  "test event modules with missing Tournament templates must return home before requesting info"
);

const tournamentRows = readRows("LUA_TOURNAMENT_TEMPLET.json");
const intervalRows = readRows("LUA_INTERVAL_TEMPLET.json");
const collectionRows = readRows("LUA_EVENT_COLLECTION_INDEX_TEMPLET.json");
const expectedTournamentIds = [1001, 1002, 1003, 1004, 1005, 1006, 10001, 10002, 10003];
assert.deepStrictEqual(
  tournamentRows.map((row) => row.TournamentID).sort((a, b) => a - b),
  expectedTournamentIds,
  "the frozen build unexpectedly gained another real Tournament template"
);

const intervalsById = new Map(intervalRows.map((row) => [row && row.m_DateStrID, row]));
let latestEnd = 0;
for (const tournament of tournamentRows) {
  const interval = intervalsById.get(tournament.TournamentInterval);
  assert(interval, `missing main interval for Tournament ${tournament.TournamentID}`);
  assert.strictEqual(interval.m_RepeatDateStart, 0, `Tournament ${tournament.TournamentID} unexpectedly repeats`);
  assert.strictEqual(interval.m_RepeatDateEnd, 0, `Tournament ${tournament.TournamentID} unexpectedly repeats`);
  const end = parseFrozenDate(interval.m_DateEnd);
  assert(Number.isFinite(end), `invalid frozen end date for Tournament ${tournament.TournamentID}`);
  latestEnd = Math.max(latestEnd, end);
}
assert(
  Date.now() > latestEnd,
  `the last frozen Tournament interval has not expired yet: ${new Date(latestEnd).toISOString()}`
);

const tournamentModules = collectionRows.filter((row) => String(row && row.EventPrefabID || "").includes("TOURNAMENT"));
const realIdSet = new Set(expectedTournamentIds);
const realModules = [];
const testModules = [];
for (const module of tournamentModules) {
  const templateId = Number(String(module.m_Option || "").match(/TournamentTempletID\s*=\s*(\d+)/)?.[1] || 0);
  if (realIdSet.has(templateId)) realModules.push({ module, templateId });
  else testModules.push({ module, templateId });
}
assert.strictEqual(realModules.length, tournamentRows.length, "every real Tournament must have exactly one event module");
assert.strictEqual(testModules.length, 11, "the frozen Tournament test-module set changed");
assert(
  testModules.every(({ module, templateId }) =>
    module.OpenTag === "TAG_COMMON_TOURNAMENT_TEST" && templateId >= 101 && templateId <= 111 && !realIdSet.has(templateId)
  ),
  "a Tournament test module unexpectedly gained a real template"
);
for (const { module, templateId } of realModules) {
  const tournament = tournamentRows.find((row) => row.TournamentID === templateId);
  assert.strictEqual(module.DateStrID, tournament.TournamentInterval, `event interval mismatch for Tournament ${templateId}`);
  assert(parseFrozenDate(intervalsById.get(module.DateStrID).m_DateEnd) < Date.now(), `Tournament module ${templateId} is active`);
}

const expectedReferences = {
  Send_NKMPacket_TOURNAMENT_INFO_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/NKC_SCEN_LOGIN.cs",
    "NKC/PacketHandler/NKCPacketHandlersLobby.cs",
    "NKC/UI/Module/NKCUIModuleSubUITournament.cs",
    "NKC/UI/NKCUIModuleSubUITournamentLobby.cs",
  ],
  Send_NKMPacket_TOURNAMENT_APPLY_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Module/NKCUIModuleSubUITournament.cs",
  ],
  Send_NKMPacket_TOURNAMENT_PREDICTION_PRIVATE_INFO_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/NKCUIModuleSubUITournamentLobby.cs",
  ],
  Send_NKMPacket_TOURNAMENT_PREDICTION_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Event/NKCUITournamentPlayoff.cs",
  ],
  Send_NKMPacket_TOURNAMENT_PREDICTION_STATISTICS_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Event/NKCUITournamentPlayoff.cs",
  ],
  Send_NKMPacket_TOURNAMENT_REWARD_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Module/NKCUIModuleSubUITournament.cs",
  ],
  Send_kNKMPacket_TOURNAMENT_REPLAY_LINK_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletAsyncReady.cs",
  ],
  Send_NKMPacket_TOURNAMENT_RANK_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Module/NKCUIModuleSubUITournament.cs",
  ],
  Send_NKMPacket_TOURNAMENT_REWARD_INFO_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Module/NKCUIModuleSubUITournament.cs",
  ],
  Send_NKMPacket_TOURNAMENT_CASTING_VOTE_UNIT_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/NKCPopupTournamentBan.cs",
  ],
  Send_NKMPacket_TOURNAMENT_CASTING_VOTE_SHIP_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/NKCPopupTournamentBan.cs",
  ],
};
const sourceFiles = listFiles(assemblyDir, ".cs");
for (const [symbol, expected] of Object.entries(expectedReferences)) {
  assert.deepStrictEqual(referencesTo(symbol), expected.slice().sort(), `${symbol} unexpectedly gained a path outside retired Tournament UI`);
}

console.log(
  `[tournament-retired-reachability-check] PASS templates=${tournamentRows.length} modules=${realModules.length} tests=${testModules.length} requestFamilies=${Object.keys(expectedReferences).length} requestPaths=0 latestEnd=${new Date(latestEnd).toISOString()}`
);

function readSource(relativePath) {
  return fs.readFileSync(path.join(assemblyDir, relativePath), "utf8");
}

function readRows(fileName) {
  const value = JSON.parse(fs.readFileSync(path.join(tableDir, fileName), "utf8"));
  return Array.isArray(value.records) ? value.records : [];
}

function parseFrozenDate(value) {
  const normalized = String(value || "").replace(/\.(\d{3})\d*$/, ".$1Z");
  return Date.parse(normalized);
}

function referencesTo(symbol) {
  return sourceFiles
    .filter((filePath) => fs.readFileSync(filePath, "utf8").includes(symbol))
    .map((filePath) => path.relative(assemblyDir, filePath).replace(/\\/g, "/"))
    .sort();
}

function listFiles(directory, extension) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
  }
  return files;
}
