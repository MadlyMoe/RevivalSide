"use strict";

function getCapturedContentsTags(profiles, targetVersion) {
  return mergeTags(
    ...compatibleProfiles(profiles, targetVersion, ["contentsVersionAck", "loginAck", "gamebaseLoginAck"])
      .map((profile) => profile.contentsTag)
  );
}

function getCapturedRequestOpenTags(profiles, targetVersion) {
  return mergeTags(
    ...compatibleProfiles(profiles, targetVersion, ["loginAck", "gamebaseLoginAck"])
      .map((profile) => profile.openTag)
  ).filter(isFrozenRequestOpenTag);
}

function compatibleProfiles(profiles, targetVersion, keys) {
  const expected = normalizeVersion(targetVersion);
  return (Array.isArray(keys) ? keys : [])
    .map((key) => profiles && profiles[key])
    .filter((profile) => {
      if (!profile || typeof profile !== "object") return false;
      const actual = normalizeVersion(profile.contentsVersion);
      return !expected || !actual || actual === expected;
    });
}

function isFrozenRequestOpenTag(value) {
  const tag = String(value || "").trim().toUpperCase();
  return (
    tag === "EPISODE_TAB_SUPPLY" ||
    tag === "EPISODE_TAB_CHALLENGE" ||
    tag === "TAG_COMMON_SCAVENGER_SUPPLY" ||
    tag.startsWith("TAG_COMMON_EPISODE_SUPPLY_") ||
    tag.startsWith("TAG_COMMON_EPISODE_CHALLENGE_")
  );
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
  getCapturedContentsTags,
  getCapturedRequestOpenTags,
  isFrozenRequestOpenTag,
};
