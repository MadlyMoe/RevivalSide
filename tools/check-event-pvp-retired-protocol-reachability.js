"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const tableDir = path.join(rootDir, "gameplay-jsons", "StreamingAssets", "ab_script", "luac");
const currentFrozenServiceDate = Date.parse("2026-08-20T00:00:00.000Z");

const managerSource = readSource("NKC/NKCEventPvpMgr.cs");
const lobbySource = readSource("NKC/UI/Gauntlet/NKCUIGauntletLobby.cs");
const shortcutSource = readSource("NKC/NKCContentManager.cs");
const readySource = readSource("NKC/NKC_SCEN_GAUNTLET_EVENT_READY.cs");
const matchSource = readSource("NKC/UI/Gauntlet/NKCUIGauntletMatch.cs");
const rewardSource = readSource("NKC/UI/Gauntlet/NKCUIGauntletEventReward.cs");

assert.match(
  managerSource,
  /GetEventPvpSeasonTemplet\(\)[\s\S]*?nkmintervalTemplet != null && nkmintervalTemplet\.IsValidTime\(ServiceTime\.Recent\)/,
  "Event PvP lookup must remain bounded by the frozen synchronized interval"
);
assert.match(
  managerSource,
  /CanAccessEventPvp\(\)[\s\S]*?eventPvpSeasonTemplet != null && eventPvpSeasonTemplet\.EnableByTag/,
  "Event PvP access must require an active tagged season"
);
assert.match(
  lobbySource,
  /SetGameobjectActive\(this\.m_ctglEvent, NKMOpenTagManager\.IsSystemOpened\(SystemOpenTagType\.PVP_ARCADE_MODE\) && NKCEventPvpMgr\.CanAccessEventPvp\(\)\)/,
  "the Event PvP lobby tab must stay hidden without an active season"
);
assert.match(
  shortcutSource,
  /SHORTCUT_PVP_EVENT[\s\S]*?!NKCEventPvpMgr\.CanAccessEventPvp\(\)[\s\S]*?return;/,
  "shortcuts must reject Event PvP when its active-season gate is closed"
);
assert.match(
  readySource,
  /GetEventPvpSeasonTemplet\(\);\s*if \(eventPvpSeasonTemplet == null\)[\s\S]*?ScenChangeFade\(NKM_SCEN_ID\.NSI_GAUNTLET_LOBBY, true\);[\s\S]*?return;/,
  "the ready scene must return to the lobby before opening a deck without an active season"
);
assert.match(
  matchSource,
  /eNKM_GAME_TYPE == NKM_GAME_TYPE\.NGT_PVP_EVENT[\s\S]*?Send_NKMPacket_EVENT_PVP_GAME_MATCH_REQ\(NKCUtil\.FindPVPSeasonIDForEvent\(\)/,
  "Event PvP matchmaking must remain downstream of the gated Event PvP scene"
);
assert.match(
  rewardSource,
  /GetEventPvpSeasonTemplet\(\);\s*if \(eventPvpSeasonTemplet != null\)[\s\S]*?Send_NKMPacket_EVENT_PVP_REWARD_REQ\(eventPvpSeasonTemplet\.SeasonId\)/,
  "reward requests must require an active Event PvP season"
);

const seasons = readRows("LUA_PVP_EVENTMATCH_SEASON.json");
const intervals = readRows("LUA_INTERVAL_TEMPLET.json");
assert.strictEqual(seasons.length, 86, "the frozen Event PvP season set changed");
assert.strictEqual(new Set(seasons.map((row) => row.seasonID)).size, seasons.length, "Event PvP season IDs must be unique");
assert.strictEqual(new Set(seasons.map((row) => row.Interval)).size, seasons.length, "every Event PvP season must own one interval");

const intervalsByKey = new Map(intervals.map((row) => [row && row.m_DateStrID, row]));
let latestEnd = 0;
let latestSeasonId = 0;
for (const season of seasons) {
  const interval = intervalsByKey.get(season.Interval);
  assert(interval, `missing frozen interval for Event PvP season ${season.seasonID}`);
  assert.strictEqual(interval.m_RepeatDateStart, 0, `Event PvP season ${season.seasonID} unexpectedly repeats`);
  assert.strictEqual(interval.m_RepeatDateEnd, 0, `Event PvP season ${season.seasonID} unexpectedly repeats`);
  const end = parseFrozenDate(interval.m_DateEnd);
  assert(Number.isFinite(end), `invalid Event PvP end date for season ${season.seasonID}`);
  if (end > latestEnd) {
    latestEnd = end;
    latestSeasonId = season.seasonID;
  }
}
assert(
  currentFrozenServiceDate > latestEnd,
  `the final frozen Event PvP season is not retired: ${latestSeasonId} ends ${new Date(latestEnd).toISOString()}`
);

const dateProfiles = fs.readFileSync(path.join(rootDir, "modules", "event-manager", "date-profiles.json"), "utf8");
const officialSchedules = fs.readFileSync(path.join(rootDir, "modules", "event-manager", "official-event-schedules.json"), "utf8");
assert.strictEqual(/PVP_EVENTMATCH/.test(dateProfiles), false, "a local date profile unexpectedly revives Event PvP");
assert.strictEqual(/PVP_EVENTMATCH/.test(officialSchedules), false, "an official schedule override unexpectedly revives Event PvP");

const expectedReferences = {
  Send_NKMPacket_EVENT_PVP_GAME_MATCH_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletMatch.cs",
  ],
  Send_NKMPacket_EVENT_PVP_GAME_MATCH_CANCEL_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletMatch.cs",
  ],
  Send_NKMPacket_EVENT_PVP_SEASON_INFO_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletLobbyEvent.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletLobbyRightSideEvent.cs",
  ],
  Send_NKMPacket_EVENT_PVP_REWARD_REQ: [
    "NKC/NKCPacketSender.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletEventReward.cs",
  ],
  Send_NKMPacket_EVENT_PVP_EXIT_REQ: [
    "NKC/NKCLeaguePVPMgr.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletLeagueGlobalBan.cs",
    "NKC/UI/Gauntlet/NKCUIGauntletLeagueMain.cs",
  ],
};
const sourceFiles = listFiles(assemblyDir, ".cs");
for (const [symbol, expected] of Object.entries(expectedReferences)) {
  assert.deepStrictEqual(referencesTo(symbol), expected.slice().sort(), `${symbol} unexpectedly gained a path outside retired Event PvP UI`);
}

const packetNames = [
  "EVENT_PVP_GAME_MATCH_REQ",
  "EVENT_PVP_GAME_MATCH_ACK",
  "EVENT_PVP_GAME_MATCH_CANCEL_REQ",
  "EVENT_PVP_GAME_MATCH_CANCEL_ACK",
  "EVENT_PVP_GAME_MATCH_COMPLETE_NOT",
  "EVENT_PVP_GAME_MATCH_FAIL_NOT",
  "EVENT_PVP_SEASON_INFO_REQ",
  "EVENT_PVP_SEASON_INFO_ACK",
  "EVENT_PVP_REWARD_REQ",
  "EVENT_PVP_REWARD_ACK",
  "EVENT_PVP_EXIT_REQ",
  "EVENT_PVP_EXIT_ACK",
  "EVENT_PVP_CANCEL_NOT",
];
const packetIdSource = readSource("Protocol/ClientPacketId.cs");
for (const name of packetNames) assert(packetIdSource.includes(`kNKMPacket_${name}`), `missing frozen packet ${name}`);

console.log(
  `[event-pvp-retired-reachability-check] PASS seasons=${seasons.length} requestFamilies=${Object.keys(expectedReferences).length} requestPaths=0 latestSeason=${latestSeasonId} latestEnd=${new Date(latestEnd).toISOString()}`
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
