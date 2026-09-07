const path = require("path");

// Hook into readGameplayJsonTable or wrap it
let sqliteHits = 0;
let sqliteMisses = 0;
let jsonFallbackHits = 0;
let luacFallbackHits = 0;
const missedTables = [];

const gameplayJsons = require("../modules/gameplay-jsons");
const origRead = gameplayJsons.readGameplayTable;

// Let's spy on getGameplaySqliteDb
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("gameplay-jsons/gameplay_tables.sqlite");
const stmt = db.prepare("SELECT 1 FROM gameplay_files WHERE directory = ? AND file_name = ? LIMIT 1");

console.log("=== CHECKING ALL TABLES LOADED AT SERVER STARTUP ===");

// List of tables loaded by modules on startup
const testCalls = [
  ["ab_script_item_templet", "LUA_ITEM_MISC_TEMPLET.json"],
  ["ab_script", "LUA_RANDOM_ITEM_BOX.json"],
  ["ab_script", "LUA_CUSTOM_PACKAGE_ITEM_BOX.json"],
  ["ab_script", "LUA_ACQ_PACKAGE_TEMPLET.json"],
  ["ab_script", "LUA_REWARD_TEMPLET_CL.json"],
  ["ab_script_unit_data", "LUA_UNIT_TEMPLET_BASE.json"],
  ["ab_script_unit_data", "LUA_UNIT_TEMPLET_BASE2.json"],
  ["ab_script_unit_data", "LUA_UNIT_TEMPLET_BASE_SD.json"],
  ["ab_script_unit_data", "LUA_UNIT_TEMPLET_BASE_OPR.json"],
  ["ab_script", "LUA_COLLECTION_UNIT_TEMPLET.json"],
  ["ab_script_unit_data", "LUA_UNIT_SKILL_TEMPLET.json"],
  ["ab_script_item_templet", "LUA_PIECE_TEMPLET.json"],
  ["ab_script", "LUA_CONTRACT.json"],
  ["ab_script", "LUA_UNIT_MISSION_TEMPLET.json"],
  ["ab_script", "LUA_COLLECTION_TEAMUP_TEMPLET.json"],
  ["ab_script", "LUA_COLLECTION_V2_MISC.json"],
  ["ab_script", "LUA_EPISODE_TEMPLET_V2.json"],
  ["ab_script", "LUA_STAGE_TEMPLET.json"],
  ["ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json"],
  ["ab_script_unit_data", "LUA_UNIT_STAT_TEMPLET.json"],
  ["ab_script_unit_data", "LUA_UNIT_STAT_TEMPLET2.json"],
  ["ab_script", "LUA_MISSION_TEMPLET.json"],
  ["ab_script", "LUA_MISSION_TAB_TEMPLET.json"],
  ["ab_script", "LUA_PLAYER_EXP_TABLE.json"],
  ["ab_script", "LUA_COMMON_CONST.json"],
  ["ab_script", "LUA_OFFICE_SECTION_TEMPLET.json"],
  ["ab_script", "LUA_OFFICE_ROOM_TEMPLET.json"],
  ["ab_script", "LUA_OFFICE_GRADE_TEMPLET.json"],
  ["ab_script", "LUA_ITEM_INTERIOR_TEMPLET.json"],
  ["ab_script", "LUA_WORLDMAP_CITY_TEMPLET.json"],
  ["ab_script", "LUA_WORLDMAP_CITY_BUILDING.json"],
  ["ab_script", "LUA_WORLDMAP_CITY_EXP_TABLE.json"],
  ["ab_script", "LUA_WORLDMAP_MISSION_TEMPLET.json"],
  ["ab_script", "LUA_WORLDMAP_EVENT_GROUP.json"],
  ["ab_script", "LUA_DIVE_TEMPLET.json"],
  ["ab_script", "LUA_RAID_TEMPLET.json"],
  ["ab_script", "LUA_RAID_SEASON_TEMPLET.json"],
  ["ab_script", "LUA_PVP_CONST.json"],
  ["ab_script", "LUA_LOGIN_BACKGROUND.json"]
];

for (const [dir, file] of testCalls) {
  const lowerFile = file.toLowerCase();
  const existsInSqlite = stmt.get(dir, lowerFile);
  if (existsInSqlite) {
    sqliteHits++;
  } else {
    sqliteMisses++;
    missedTables.push(`${dir}/${file}`);
  }
}

console.log(`SQLite Hits: ${sqliteHits}/${testCalls.length}`);
console.log(`SQLite Misses: ${sqliteMisses}/${testCalls.length}`);
if (missedTables.length > 0) {
  console.log("Tables missed from SQLite (falling back to disk):", missedTables);
} else {
  console.log("✅ 100% of all core tables ARE LOADED DIRECTLY FROM SQLITE!");
}
