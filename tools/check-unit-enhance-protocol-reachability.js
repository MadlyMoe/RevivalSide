"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const statDataSource = read("NKM/NKMStatData.cs");
const statManagerSource = read("NKM/NKMUnitStatManager.cs");
const enhanceManagerSource = read("NKM/NKMEnhanceManager.cs");
const labSource = read("NKC/UI/NKCUILab.cs");
const enhanceUiSource = read("NKC/UI/NKCUILabUnitEnhance.cs");

assert.match(statDataSource, /public float GetStatEXP\([^)]*\)\s*\{\s*return 0f;\s*\}/s);
assert.match(statDataSource, /public float GetStatEnhanceFeedEXP\([^)]*\)\s*\{\s*return 0f;\s*\}/s);
assert.match(statDataSource, /public bool HasEnchantFeedExp\s*\{\s*get\s*\{\s*return false;\s*\}\s*\}/s);
assert.match(
  statManagerSource,
  /CalculateStat\([^)]*List<int> lstStatExp[^)]*\)\s*\{\s*return NKMUnitStatManager\.CalculateStat\([^;]+\);\s*\}/s
);
assert.match(enhanceManagerSource, /if \(NKMEnhanceManager\.CheckUnitFullEnhance\(targetEnhancedUnit\)\)/);
assert.match(enhanceManagerSource, /if \(!NKMUnitManager\.GetUnitStatTemplet\([^;]+\.m_StatData\.HasEnchantFeedExp\)/s);
assert.match(labSource, /NKMEnhanceManager\.CheckUnitFullEnhance\(list\[i\]\)/);
assert.match(enhanceUiSource, /AdditionalExcludeFilterFunc\s*=\s*new [^(]+\(this\.IsUnitHaveEnhanceExp\)/);
assert.match(enhanceUiSource, /GetStatEnhanceFeedEXP\(num\) > 0f/);
assert.match(enhanceUiSource, /this\.m_currentSlotUIDList\.Count > 0/);
assert.match(enhanceUiSource, /private void Send_ENHANCE_UNIT_REQ\(\)/);
assert.strictEqual(
  (enhanceUiSource.match(/\.Send_ENHANCE_UNIT_REQ\(\);/g) || []).length,
  2,
  "the retired request must only be emitted from the guarded Enhance flow"
);

const statTableDir = path.join(
  rootDir,
  "gameplay-jsons",
  "StreamingAssets",
  "ab_script_unit_data",
  "luac"
);
const statFiles = [
  "LUA_UNIT_STAT_TEMPLET.json",
  "LUA_UNIT_STAT_TEMPLET2.json",
  "LUA_UNIT_STAT_TEMPLET_SD.json",
  "LUA_UNIT_STAT_TEMPLET_OPR.json",
];
let recordCount = 0;
for (const fileName of statFiles) {
  const table = JSON.parse(fs.readFileSync(path.join(statTableDir, fileName), "utf8"));
  for (const record of table.records || []) {
    recordCount += 1;
    const maxPerLevel = record && record.m_StatData && record.m_StatData.m_StatMaxPerLevel;
    assert(
      !maxPerLevel || Object.values(maxPerLevel).every((value) => Number(value) === 0),
      `${fileName}:${record && record.m_UnitStrID} unexpectedly restores retired enhancement stat growth`
    );
  }
}
assert(recordCount > 0, "frozen unit-stat tables must be present");

console.log(`[unit-enhance-reachability-check] PASS statRecords=${recordCount} requestPaths=0`);

function read(relativePath) {
  return fs.readFileSync(path.join(assemblyDir, relativePath), "utf8");
}
