const path = require("path");
const ROOT_DIR = path.resolve(__dirname, "..");
const { loadUserDb } = require("../modules/user-storage");
const { loadGameData } = require("../modules/game-data");
const { buildRewardEnableUnitMissionPayloads } = require("../modules/collection");
const { makeMissionTracking, addMissionTrackingCondition } = require("../modules/mission-tracking");
const { dateTimeBinaryNow } = require("../modules/packet-codec");

// Require listener to get its internal helper or duplicate its exact logic
async function main() {
  const db = loadUserDb();
  const user = db.users && (db.users[db.activeUserUid] || Object.values(db.users)[0]);
  loadGameData();

  console.log("Testing exact flow in listener.js for unit-growth-mission-update:");
  
  // Look at server/listener.js:
  // getActiveEventMissionTabIds()
  // PAYBACK_MISSION_TABS
  // FAST_LOBBY_MISSION_TABS = [1, 2, 3, 4]
  // resolveGuideMissionTabs()
  
  const accountProgression = require("../modules/account-progression");
  const tracking = makeMissionTracking(dateTimeBinaryNow());
  addMissionTrackingCondition(tracking, "UNIT_LIMITBREAK", true);
  addMissionTrackingCondition(tracking, "UNIT_GROWTH_LIMIT", true);

  // Let's test all tabs that getMissionTabTemplets has!
  const allTabs = require("../modules/game-data").getMissionTabTemplets().map(t => Number(t.m_TabID)).filter(Boolean);
  console.log("Total mission tabs in game-data:", allTabs.length);

  const tStart = performance.now();

  // Step 1: sendUnitMissionCollectionUpdate
  const t_col0 = performance.now();
  const targetUnit = Object.values(user.army?.units || {})[0];
  const colRes = buildRewardEnableUnitMissionPayloads(user, { unitIds: [targetUnit.unitId] });
  const t_col1 = performance.now();
  console.log(`1. Collection check took: ${(t_col1 - t_col0).toFixed(3)}ms`);

  // Step 2: refreshMissionProgress
  const t_ref0 = performance.now();
  accountProgression.refreshMissionProgress(user, {
    now: dateTimeBinaryNow(),
    conditions: tracking.conditions
  });
  const t_ref1 = performance.now();
  console.log(`2. refreshMissionProgress took: ${(t_ref1 - t_ref0).toFixed(3)}ms`);

  // Step 3: sendMissionUpdateForTabs with tabs
  const t_tabs0 = performance.now();
  // In listener:
  // const FAST_LOBBY_MISSION_TABS = Object.freeze([1, 2, 3, 4]);
  // getActiveEventMissionTabIds()
  // PAYBACK_MISSION_TABS
  // Let's measure each tab
  let totalEntries = 0;
  for (const tabId of allTabs) {
    const t_tab = performance.now();
    const entries = accountProgression.buildMissionDataEntries(user, {
      tabId,
      now: dateTimeBinaryNow(),
      conditions: tracking.conditions,
      skipRefresh: true
    });
    const dur = performance.now() - t_tab;
    if (dur > 20 || entries.length > 0) {
      console.log(`   Tab ${tabId} took ${dur.toFixed(2)}ms (found ${entries.length} entries)`);
    }
    totalEntries += entries.length;
  }
  const t_tabs1 = performance.now();
  console.log(`3. Scanning ALL tabs took: ${(t_tabs1 - t_tabs0).toFixed(3)}ms (total entries: ${totalEntries})`);

  console.log(`Total pipeline time: ${(performance.now() - tStart).toFixed(3)}ms`);
}

main().catch(console.error);
