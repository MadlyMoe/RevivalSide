const { readGameplayTableRecords } = require("../gameplay-jsons");

const AUTO = "auto";

function getLoginBackgroundCatalog(options = {}) {
  return readGameplayTableRecords("ab_script", "LUA_LOGIN_BACKGROUND.json", options)
    .filter((record) => String(record.m_type || "").toUpperCase() === "BACKGROUND")
    .map((record) => {
      const contentTag = (record.listContentsTagAllow || []).find((tag) => /^LOGIN_/i.test(String(tag || "")));
      return {
        id: Number(record.ID) || 0,
        contentTag: String(contentTag || ""),
        label: humanizeLoginTag(contentTag),
        assetName: String(record.AssetName || ""),
        bundleName: String(record.BundleName || ""),
        music: String(record.m_MusicName || ""),
      };
    })
    .filter((item) => item.id > 0 && item.contentTag)
    .sort((left, right) => left.id - right.id);
}

function resolveLoginBackgroundItem(catalog, eventState = {}, setting = AUTO) {
  const items = Array.isArray(catalog) ? catalog : [];
  const mode = String(setting || AUTO).trim();
  if (mode.toLowerCase() !== AUTO) {
    const key = canonical(mode);
    const selected = items.find((item) =>
      String(item.id) === mode ||
      canonical(item.contentTag) === key ||
      canonical(item.assetName) === key
    );
    if (selected) return selected;
  }

  for (const entries of prioritizedEventEntries(eventState)) {
    const explicit = resolveExplicitEntryBackground(items, entries);
    if (explicit) return explicit;
    const matched = items
      .map((item) => ({ item, score: scoreEventMatch(item, entries) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.item.id - left.item.id)[0];
    if (matched) return matched.item;
  }
  return items.find((item) => item.id === 1) || items[0] || null;
}

function applyLoginBackgroundTag(tags, background) {
  const result = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || "").trim())
    .filter((tag) => tag && !/^LOGIN_/i.test(tag));
  if (background && background.contentTag) result.push(background.contentTag);
  return result;
}

function prioritizedEventEntries(state) {
  const seeds = Array.isArray(state.seedEntries) ? state.seedEntries : [];
  const profiles = seeds.filter((entry) => entry.source && entry.source.category === "profile");
  const schedules = Array.isArray(state.officialScheduleEntries) ? state.officialScheduleEntries : [];
  const remaining = [
    ...seeds.filter((entry) => !profiles.includes(entry) && !schedules.includes(entry)),
    ...(Array.isArray(state.entries) ? state.entries : []),
  ];
  return [profiles, schedules, remaining].filter((entries) => entries.length);
}

function resolveExplicitEntryBackground(items, entries) {
  for (const entry of entries) {
    const value = entry && entry.raw && (entry.raw.loginBackgroundId || entry.raw.loginBackground);
    if (value == null) continue;
    const key = canonical(value);
    const selected = items.find((item) => String(item.id) === String(value) || canonical(item.contentTag) === key);
    if (selected) return selected;
  }
  return null;
}

function scoreEventMatch(item, entries) {
  const stem = item.contentTag.replace(/^LOGIN_/i, "");
  if (!stem || canonical(stem) === "DEFAULT") return 0;
  const text = entries.map(eventEntryText).join(" ");
  const compactText = canonical(text);
  const compactStem = canonical(stem);
  if (compactStem.length >= 4 && compactText.includes(compactStem)) return 1000 + compactStem.length;
  const tokens = stem.split(/[^A-Za-z0-9]+/).map(canonical).filter((token) => token.length >= 4 && !/^20\d\d$/.test(token));
  return tokens.reduce((score, token) => score + (compactText.includes(token) ? token.length : 0), 0);
}

function eventEntryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  return [entry.id, entry.label, ...(entry.openTags || []), ...(entry.intervalTags || []), ...(entry.contentsTagAllow || [])].join(" ");
}

function humanizeLoginTag(tag) {
  const acronyms = new Set(["CA", "CLB", "EP", "ESPR", "JPN", "MA", "PR", "SA", "XMAS"]);
  return String(tag || "")
    .replace(/^LOGIN_/i, "")
    .split("_")
    .filter(Boolean)
    .map((word) => acronyms.has(word.toUpperCase()) || /\d/.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(" ") || "Default";
}

function canonical(value) {
  return String(value == null ? "" : value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

module.exports = {
  AUTO,
  applyLoginBackgroundTag,
  getLoginBackgroundCatalog,
  resolveLoginBackgroundItem,
};
