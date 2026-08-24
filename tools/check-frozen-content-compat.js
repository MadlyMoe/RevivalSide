"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  REQUIRED_CORE_OPEN_TAGS,
  areCompatibleContentsVersions,
  getCapturedOpenTags,
  getCapturedContentsTags,
  getFrozenContentsTags,
  hasFrozenMissionSnapshot,
} = require("../modules/frozen-content-compat");
const { createServerTime } = require("../modules/server-time");
const { createEventManager } = require("../modules/event-manager");
const { filterEventClockShopOpenTags, getActiveEventShopState } = require("../modules/shop");
const dateProfiles = require("../modules/event-manager/date-profiles.json");
const ROOT_DIR = path.resolve(__dirname, "..");

assert.deepStrictEqual(REQUIRED_CORE_OPEN_TAGS, [
  "EPISODE_TAB_SUPPLY",
  "EPISODE_TAB_CHALLENGE",
  "TAG_COMMON_EPISODE_SUPPLY_RESOURCE_1",
  "TAG_COMMON_EPISODE_SUPPLY_UNIT",
  "TAG_COMMON_EPISODE_SUPPLY_RESOURCE_3",
  "TAG_COMMON_EPISODE_CHALLENGE_1",
]);

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
const october2022 = dateProfiles.profiles.find((profile) => profile.id === "2022-10-20-employee-banners");
assert(october2022 && october2022.intervalTags.includes("DATE_GLOBAL_PICKUP_CONTRACT_ADMIN_ARTILLERY_V4"));
assert(october2022.intervalTags.includes("DATE_GLOBAL_PICKUP_CONTRACT_ADMIN_GREATSWORD_V4"));
const ministra2022 = dateProfiles.profiles.find((profile) => profile.id === "2022-10-20-ministra-banner");
assert(ministra2022 && ministra2022.intervalTags.includes("DATE_GLOBAL_CLASSIFIED_CONTRACT_MINISTRA_V1"));
const ironKnight = dateProfiles.profiles.find((profile) => profile.id === "2023-05-17-iron-knight");
assert(ironKnight && new Date(ironKnight.startDate) <= new Date("2023-06-01T12:00:00Z"));
assert(new Date("2023-06-01T12:00:00Z") < new Date(ironKnight.endDate));
assert(ironKnight.intervalTags.includes("DATE_GLOBAL_CLASSIFIED_CONTRACT_BORDER_HORSE"));
assert(ironKnight.intervalTags.includes("DATE_GLOBAL_CLASSIFIED_CONTRACTBANNER_AWAKEN_019"));
const octoberState = createEventManager({ rootDir: ROOT_DIR, env: process.env }).getActiveEventState("2022-10-21");
const octoberIntervals = new Set(octoberState.intervalData.map((interval) => interval.strKey));
for (const tag of [
  "DATE_COMMON_EPISODE_EVENT_SHADE_02",
  "DATE_COMMON_MISSION_EVENT_SHADE_2",
  "DATE_COMMON_SHOP_EVENT_SHADE",
  "DATE_GLOBAL_EVENT_PASS_UNIT_CORRUPTED_C_SHADOW",
  "DATE_GLOBAL_PICKUP_CONTRACT_ADMIN_ARTILLERY_V4",
  "DATE_GLOBAL_PICKUP_CONTRACT_ADMIN_GREATSWORD_V4",
  "DATE_GLOBAL_CLASSIFIED_CONTRACT_MINISTRA_V1",
]) assert(octoberIntervals.has(tag), `missing 2022-10-21 interval ${tag}`);
assert(octoberState.counterPasses.some((pass) => pass.eventPassId === 505), "Spira Counter Pass is not active");
assert.strictEqual(octoberState.counterPasses.find((pass) => pass.eventPassId === 505).startDate, "2022-10-20T16:00:00.000Z");
assert(octoberState.counterPassContentsTags.includes("GLOBAL_EVENT_PASS_UNIT_CORRUPTED_C_SHADOW"));
for (const tag of [
  "TAG_COMMON_MISSION_EVENT_SHADE_1",
  "TAG_GLOBAL_PICKUP_CONTRACT_ADMIN_ARTILLERY_V4",
  "TAG_CONTRACT_GLOBAL_PICKUP_ADMIN_GREATSWORD_V4",
  "TAG_FIRST_UNIT_CORRUPTED_CA_MINISTRA",
]) assert(octoberState.openTags.includes(tag), `missing 2022-10-21 open tag ${tag}`);
const octoberShops = getActiveEventShopState(octoberState, { includeAllEventShops: false });
assert(octoberShops.intervalTags.includes("DATE_COMMON_SHOP_EVENT_SHADE"), "Bottom of the Shade shop is not active");
assert(!octoberShops.intervalTags.includes("SHOP_CASH_PACKAGE_2025_SUMMER"), "future shop leaked into 2022");
assert(
  octoberShops.intervalTags.every((tag) => octoberIntervals.has(tag)),
  "shop emitted an interval outside the event clock"
);
assert.deepStrictEqual(
  filterEventClockShopOpenTags(
    ["TAG_COMMON_SHOP_EVENT_SHADE_1", "TAG_COMMON_SHOP_EVENT_ANNIVERSARY_3YEAR", "UNRELATED_TAG"],
    octoberState
  ),
  ["TAG_COMMON_SHOP_EVENT_SHADE_1", "UNRELATED_TAG"],
  "login open tags must keep only event-clock-active shops"
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
