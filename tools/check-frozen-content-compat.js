"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  areCompatibleContentsVersions,
  getCapturedOpenTags,
  getCapturedContentsTags,
  getFrozenContentsTags,
  hasFrozenMissionSnapshot,
} = require("../modules/frozen-content-compat");
const { createServerTime } = require("../modules/server-time");
const { getActiveScheduledBannerIntervalTags } = require("../modules/event-manager");

const profiles = {
  contentsVersionAck: {
    contentsVersion: "9.2.c",
    contentsTag: ["GLOBAL", "TAG_COMMON_SHOP_TAB_CASH"],
  },
  loginAck: {
    contentsVersion: "9.2.c",
    contentsTag: ["global", "SYSTEM_TRANSCENDENCE_LV120"],
    openTag: [
      "EPISODE_TAB_SUPPLY",
      "EPISODE_TAB_CHALLENGE",
      "TAG_COMMON_EPISODE_SUPPLY_CREDIT",
      "TAG_COMMON_EPISODE_CHALLENGE_1",
      "TAG_COMMON_EPISODE_MAIN_EP15_NORMAL",
      "TAG_COMMON_SHOP_TAB_EXCHANGE_CHALLENGE_TICKET",
    ],
  },
};

assert.deepStrictEqual(getCapturedContentsTags(profiles, "9.2.c"), [
  "GLOBAL",
  "TAG_COMMON_SHOP_TAB_CASH",
  "SYSTEM_TRANSCENDENCE_LV120",
]);
assert.strictEqual(areCompatibleContentsVersions("9.2.b", "9.2.c"), false);
assert.strictEqual(areCompatibleContentsVersions("9.2.c", "9.2.b"), false);
assert.strictEqual(areCompatibleContentsVersions("9.2.a", "9.2.c"), false);
assert.deepStrictEqual(getCapturedContentsTags(profiles, "9.2.b"), []);
assert.deepStrictEqual(
  getFrozenContentsTags(profiles, "9.2.c", ["GLOBAL", "MULTITASK_DOWNLOAD"], ["SYSTEM_TRANSCENDENCE_LV120"]),
  ["GLOBAL", "TAG_COMMON_SHOP_TAB_CASH", "SYSTEM_TRANSCENDENCE_LV120", "MULTITASK_DOWNLOAD"],
  "the frozen handshake must use one canonical tag list instead of clock or user tags"
);
assert.deepStrictEqual(getCapturedOpenTags(profiles, "9.2.c"), [
  "EPISODE_TAB_SUPPLY",
  "EPISODE_TAB_CHALLENGE",
  "TAG_COMMON_EPISODE_SUPPLY_CREDIT",
  "TAG_COMMON_EPISODE_CHALLENGE_1",
  "TAG_COMMON_EPISODE_MAIN_EP15_NORMAL",
  "TAG_COMMON_SHOP_TAB_EXCHANGE_CHALLENGE_TICKET",
]);
assert.deepStrictEqual(getCapturedOpenTags(profiles, "9.2.b"), []);
assert.strictEqual(
  hasFrozenMissionSnapshot(
    [{ m_MissionTabId: 4, m_MissionID: 1001, m_MissionCounterGroupID: 100 }],
    { tabId: 4, missionID: 1001, groupId: 100 }
  ),
  true
);
assert.deepStrictEqual(
  getActiveScheduledBannerIntervalTags({
    officialScheduleEntries: [
      { raw: { scheduleType: "contract" }, intervalTags: ["DATE_GLOBAL_FIRST_CONTRACT_SKY", "DATE_GLOBAL_PICKUP_CONTRACT_SKY"] },
      { raw: { scheduleType: "contract" }, intervalTags: ["DATE_GLOBAL_CLASSIFIED_CONTRACT_ROSARIA", "DATE_GLOBAL_PICKUP_CONTRACT_ROSARIA"] },
      { raw: { scheduleType: "contract" }, intervalTags: ["DATE_GLOBAL_CONTRACT_OPR_DAIN_PR_V4", "DATE_GLOBAL_CONTRACT_OPR_DAIN_V4"] },
      { raw: { scheduleType: "contract" }, intervalTags: ["DATE_KOR_CLASSIFIED_CONTRACT_FENRIR_INTERN"] },
      { label: "The 6th Prestige Service: Wolf's Wintering", raw: { scheduleType: "event" }, intervalTags: ["DATE_COMMON_EVENT_PAYBACK_003"] },
    ],
  }),
  [
    "DATE_GLOBAL_PICKUP_CONTRACT_SKY",
    "DATE_GLOBAL_CLASSIFIED_CONTRACT_ROSARIA",
    "DATE_GLOBAL_CONTRACT_OPR_DAIN_V4",
    "DATE_KOR_CLASSIFIED_CONTRACT_FENRIR_INTERN",
    "DATE_COMMON_EVENT_PAYBACK_003",
  ]
);
assert.strictEqual(
  hasFrozenMissionSnapshot(
    [{ m_MissionTabId: 4, m_MissionID: 1001, m_MissionCounterGroupID: 100 }],
    { tabId: 4, missionID: 9001, groupId: 9001 }
  ),
  false,
  "mission snapshots missing from the frozen table must not reach the client UI"
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "revivalside-clock-"));
try {
  const clock = createServerTime({
    statePath: path.join(tempDir, "server-time.json"),
    defaultDate: "2025-04-10",
  });
  const localNow = new Date("2026-07-28T12:34:56.000Z");
  assert.strictEqual(clock.eventDateKey(localNow), "2025-04-10");
  assert.strictEqual(clock.getSummary().mode, "event-date");

  clock.setManualTime("2024-01-02T03:04:05.000Z", localNow);
  assert.strictEqual(clock.now(localNow).toISOString(), "2024-01-02T03:04:05.000Z");
  assert.strictEqual(clock.getSummary().mode, "manual");

  clock.clearManualTime(localNow);
  assert.strictEqual(clock.eventDateKey(localNow), "2025-04-10");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("[frozen-content-compat] PASS exact-version tags, full open tags, frozen missions, and Event Date clock");
