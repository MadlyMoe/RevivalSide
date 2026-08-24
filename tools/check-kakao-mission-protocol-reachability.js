"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const tableDir = path.join(rootDir, "gameplay-jsons", "StreamingAssets", "ab_script", "luac");
const tabSource = readSource("NKM/Event/NKMEventTabTemplet.cs");
const eventUiSource = readSource("NKC/UI/Event/NKCUIEvent.cs");
const kakaoUiSource = readSource("NKC/UI/Event/NKCUIEventSubUIKakao.cs");

const tabRows = readRows("LUA_EVENT_TAB_TEMPLET.json");
const intervalRows = readRows("LUA_INTERVAL_TEMPLET.json");
const kakaoTabs = tabRows.filter((row) => row && row.m_EventType === "KAKAOEMOTE");
assert.strictEqual(kakaoTabs.length, 1, "the frozen client unexpectedly gained another Kakao mission tab");

const kakaoTab = kakaoTabs[0];
assert.strictEqual(kakaoTab.m_EventID, 3218, "the frozen Kakao mission event ID changed");
assert.strictEqual(kakaoTab.m_DateStrID, "DATE_EVENT_KAKAO_MISSION_2021_08", "the Kakao tab interval changed");

const kakaoIntervals = intervalRows.filter((row) => row && row.m_DateStrID === kakaoTab.m_DateStrID);
assert.strictEqual(kakaoIntervals.length, 1, "the frozen Kakao mission must have exactly one interval");
assert.deepStrictEqual(
  {
    start: kakaoIntervals[0].m_DateStart,
    end: kakaoIntervals[0].m_DateEnd,
    repeatStart: kakaoIntervals[0].m_RepeatDateStart,
    repeatEnd: kakaoIntervals[0].m_RepeatDateEnd,
  },
  {
    start: "1999-01-01T04:00:00.0000000",
    end: "2000-01-01T04:00:00.0000000",
    repeatStart: 0,
    repeatEnd: 0,
  },
  "the retired Kakao mission interval unexpectedly became current or repeating"
);

assert.match(
  tabSource,
  /else if \(!NKCSynchronizedTime\.IsEventTime\(this\.intervalId, this\.EventDateStartUtc, this\.EventDateEndUtc\)\)\s*\{\s*return false;\s*\}/s,
  "event tabs must remain unavailable outside their frozen synchronized interval"
);
assert.match(
  eventUiSource,
  /if \(nkmeventTabTemplet\.IsAvailable && nkmeventTabTemplet\.ShowEventBanner\(\)\)/,
  "the Event UI must continue filtering tabs through IsAvailable"
);
assert.strictEqual(
  (kakaoUiSource.match(/Send_NKMPacket_KAKAO_MISSION_REFRESH_STATE_REQ/g) || []).length,
  1,
  "the retired Kakao sub-UI must contain the only request callsite outside the sender definition"
);

const senderReferences = listFiles(assemblyDir, ".cs")
  .filter((filePath) => fs.readFileSync(filePath, "utf8").includes("Send_NKMPacket_KAKAO_MISSION_REFRESH_STATE_REQ"))
  .map((filePath) => path.relative(assemblyDir, filePath).replace(/\\/g, "/"))
  .sort();
assert.deepStrictEqual(
  senderReferences,
  ["NKC/NKCPacketSender.cs", "NKC/UI/Event/NKCUIEventSubUIKakao.cs"],
  "the frozen build unexpectedly gained a Kakao refresh path outside the expired event tab"
);

console.log(
  `[kakao-mission-reachability-check] PASS tabs=${kakaoTabs.length} intervals=${kakaoIntervals.length} requestFamilies=1 requestPaths=0`
);

function readSource(relativePath) {
  return fs.readFileSync(path.join(assemblyDir, relativePath), "utf8");
}

function readRows(fileName) {
  const value = JSON.parse(fs.readFileSync(path.join(tableDir, fileName), "utf8"));
  return Array.isArray(value.records) ? value.records : [];
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
