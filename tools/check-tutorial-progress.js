const assert = require("assert");
const { buildMissionDataEntries } = require("../modules/account-progression");
const { applyOfficialSnapshotToLocalProfile } = require("../modules/official-profile-import");
const { hasTutorialCompletionMission } = require("../stages/tutorialStage");

assert.strictEqual(hasTutorialCompletionMission({ completedMissions: {} }), false);
assert.strictEqual(
  hasTutorialCompletionMission({ completedMissions: { "999:999": { missionID: 999, isComplete: false } } }),
  false
);
assert.strictEqual(
  hasTutorialCompletionMission({ completedMissions: { "999:999": { missionID: 999, isComplete: true } } }),
  true
);
assert.strictEqual(
  hasTutorialCompletionMission({ completedMissions: { "100:100": { missionID: 100, rewardClaimed: true } } }),
  true
);

const imported = {
  officialSnapshot: { packet: { userData: { m_UserLevel: 379, m_lUserLevelEXP: 17266, m_MissionData: { completeFlag: [999] } } } },
};
applyOfficialSnapshotToLocalProfile(imported);
assert.strictEqual(hasTutorialCompletionMission(imported), true);
assert.strictEqual(imported.level, 379);
assert.strictEqual(imported.exp, "17266");

const guideImport = {
  officialSnapshot: {
    packet: {
      userData: {
        m_MissionData: {
          dicMissions: {
            2000101: {
              tabId: 20001,
              mission_id: 2000101,
              group_id: 2000101,
              times: "1",
              isComplete: false,
            },
          },
        },
      },
    },
  },
};
applyOfficialSnapshotToLocalProfile(guideImport);
assert.strictEqual(guideImport.completedMissions["2000101"].times, 1);
const guideMission = buildMissionDataEntries(guideImport, { tabId: 20001 }).find(([groupId]) => groupId === 2000101);
assert(guideMission, "imported guide mission was not serialized");
assert.strictEqual(guideMission[1].times, 1);
assert.strictEqual(guideImport.completedMissions["2000101"].source, "official-join-lobby");

console.log("official tutorial and guide progress checks passed");
