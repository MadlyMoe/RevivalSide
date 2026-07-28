"use strict";

function getCapturedContentsTags(profiles, targetVersion) {
  return mergeTags(
    ...compatibleProfiles(profiles, targetVersion, ["contentsVersionAck", "loginAck", "gamebaseLoginAck"])
      .map((profile) => profile.contentsTag)
  );
}

function getCapturedOpenTags(profiles, targetVersion) {
  return mergeTags(
    ...compatibleProfiles(profiles, targetVersion, ["loginAck", "gamebaseLoginAck"])
      .map((profile) => profile.openTag)
  );
}

function compatibleProfiles(profiles, targetVersion, keys) {
  const expected = normalizeVersion(targetVersion);
  return (Array.isArray(keys) ? keys : [])
    .map((key) => profiles && profiles[key])
    .filter((profile) => {
      if (!profile || typeof profile !== "object") return false;
      const actual = normalizeVersion(profile.contentsVersion);
      return !expected || !actual || areCompatibleContentsVersions(actual, expected);
    });
}

function areCompatibleContentsVersions(left, right) {
  const actual = normalizeVersion(left);
  const expected = normalizeVersion(right);
  return !actual || !expected || actual === expected;
}

function hasFrozenMissionSnapshot(rows, mission) {
  const tabId = Number(mission && mission.tabId || 0);
  const missionID = Number(mission && mission.missionID || 0);
  const groupId = Number(mission && mission.groupId || missionID || 0);
  if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(missionID) || missionID <= 0) return false;
  return (Array.isArray(rows) ? rows : []).some((row) => {
    const rowTabId = Number(row && row.m_MissionTabId || 0);
    const rowMissionID = Number(row && row.m_MissionID || 0);
    const rowGroupId = Number(row && (row.m_MissionCounterGroupID || row.m_MissionID) || 0);
    return rowTabId === tabId && rowMissionID === missionID && rowGroupId === groupId;
  });
}

function normalizeVersion(value) {
  return String(value || "").trim().toLowerCase();
}

function mergeTags(...groups) {
  const result = [];
  const seen = new Set();
  for (const group of groups) {
    for (const value of Array.isArray(group) ? group : []) {
      const tag = String(value || "").trim();
      const key = tag.toUpperCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

module.exports = {
  areCompatibleContentsVersions,
  getCapturedOpenTags,
  getCapturedContentsTags,
  hasFrozenMissionSnapshot,
};
