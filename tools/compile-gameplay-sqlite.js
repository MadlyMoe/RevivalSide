"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.resolve(__dirname, "..");
const GAMEPLAY_DIR = path.join(ROOT_DIR, "gameplay-jsons");
const DEFAULT_SQLITE_PATH = path.join(GAMEPLAY_DIR, "gameplay_tables.sqlite");

// List of core directories to compile into SQLite
const CORE_DIRECTORIES = [
  "ab_script",
  "ab_script_dungeon_templet",
  "ab_script_dungeon_templet_all",
  "ab_script_unit_data",
  "ab_script_unit_data_unit_templet",
  "ab_script_item_templet",
  "ab_script_warfare",
  "ab_script_warfare_map_templet_all",
  "ab_script_string_table",
  "ab_script_npc"
];

function extractRecordKeys(tableName, record) {
  if (!record || typeof record !== "object") return null;

  // Special case for LUA_UNIT_MISSION_TEMPLET (composite key: MissionID + StepID)
  if (tableName.includes("UNIT_MISSION")) {
    const mId = record.MissionID != null ? record.MissionID : record.m_MissionID;
    const sId = record.StepID != null ? record.StepID : record.m_StepID;
    if (mId != null && sId != null) {
      return {
        recordId: `${mId}_${sId}`,
        secondaryId: Number(sId) || 0,
        stringKey: String(record.Unit_Grade || record.Mission_Condition || "").trim() || null,
      };
    }
  }

  // 1. Find Primary Key
  let recordId = null;
  const pkCandidates = [
    "m_MissionID", "MissionID",
    "m_StageID", "StageID",
    "m_DungeonID", "DungeonID",
    "m_UnitID", "UnitID",
    "m_ItemMiscID", "m_ItemEquipID", "m_PieceID", "m_ContractID",
    "m_OperatorID", "m_SkinID", "m_WarfareID", "m_WarfareMapID",
    "m_EpisodeID", "m_TabID", "m_TeamID", "m_ID", "ID"
  ];

  for (const field of pkCandidates) {
    if (record[field] != null) {
      recordId = String(record[field]);
      break;
    }
  }

  // Fallback: search for field ending with "ID" or "Id"
  if (!recordId) {
    for (const [key, val] of Object.entries(record)) {
      if ((key.endsWith("ID") || key.endsWith("Id")) && val != null && (typeof val === "number" || typeof val === "string")) {
        recordId = String(val);
        break;
      }
    }
  }

  if (!recordId) return null;

  // 2. Find Secondary Key (numeric)
  let secondaryId = null;
  const secCandidates = [
    "m_MissionTabId", "m_StageType", "m_DungeonType",
    "StepID", "m_StepID", "m_RewardGroupID", "m_PackageID",
    "m_CustomRewardGroupID", "m_Level"
  ];
  for (const field of secCandidates) {
    if (record[field] != null && !isNaN(Number(record[field]))) {
      secondaryId = Number(record[field]);
      break;
    }
  }

  // 3. Find String Key (classification/condition string)
  let stringKey = null;
  const strCandidates = [
    "m_MissionCond", "Mission_Condition",
    "Unit_Grade", "m_NKM_UNIT_GRADE",
    "m_UnitStrID", "m_StageStrID", "m_DungeonStrID", "m_ItemMiscStrID", "m_OpenTag"
  ];
  for (const field of strCandidates) {
    if (record[field] != null && typeof record[field] === "string" && record[field].trim()) {
      stringKey = String(record[field]).trim();
      break;
    }
  }

  return { recordId, secondaryId, stringKey };
}

function compileGameplaySqlite(options = {}) {
  const sqlitePath = options.sqlitePath || DEFAULT_SQLITE_PATH;
  const includeAll = Boolean(options.all);
  const startTime = performance.now();

  console.log(`=== STARTING GAMEPLAY DATA SQLITE COMPILATION (INDEXED ARCHITECTURE) ===`);
  console.log(`Output: ${sqlitePath}`);

  // Remove existing database file if present for clean compilation
  if (fs.existsSync(sqlitePath)) {
    try {
      fs.unlinkSync(sqlitePath);
      console.log(" -> Removed old database for fresh compilation.");
    } catch (_) {}
  }

  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA journal_mode = MEMORY;");
  db.exec("PRAGMA synchronous = OFF;");
  db.exec("PRAGMA temp_store = MEMORY;");

  // Table 1: gameplay_files (Preserves 100% backward compatibility and Modding)
  db.exec(`
    CREATE TABLE IF NOT EXISTS gameplay_files (
      root_name TEXT NOT NULL,
      directory TEXT NOT NULL,
      file_name TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (root_name, directory, file_name)
    );
    CREATE INDEX IF NOT EXISTS idx_gameplay_lookup ON gameplay_files (directory, file_name);
  `);

  // Table 2: gameplay_records (Ultra-fast point queries via B-Tree index)
  db.exec(`
    CREATE TABLE IF NOT EXISTS gameplay_records (
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      secondary_id INTEGER,
      string_key TEXT,
      data TEXT NOT NULL,
      PRIMARY KEY (table_name, record_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gr_lookup ON gameplay_records (table_name, record_id);
    CREATE INDEX IF NOT EXISTS idx_gr_sec ON gameplay_records (table_name, secondary_id);
    CREATE INDEX IF NOT EXISTS idx_gr_str ON gameplay_records (table_name, string_key);
  `);

  const insertFileStmt = db.prepare(`
    INSERT OR REPLACE INTO gameplay_files (root_name, directory, file_name, data)
    VALUES (?, ?, ?, ?)
  `);

  const insertRecordStmt = db.prepare(`
    INSERT OR REPLACE INTO gameplay_records (table_name, record_id, secondary_id, string_key, data)
    VALUES (?, ?, ?, ?, ?)
  `);

  let totalFiles = 0;
  let totalRecords = 0;
  let totalBytes = 0;

  const rootNames = ["Assetbundles", "StreamingAssets"];
  for (const rootName of rootNames) {
    const rootPath = path.join(GAMEPLAY_DIR, rootName);
    if (!fs.existsSync(rootPath)) continue;

    const dirEntries = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isDirectory()) continue;
      const directory = dirEntry.name;

      if (!includeAll && !CORE_DIRECTORIES.includes(directory)) {
        continue;
      }

      const luacDir = path.join(rootPath, directory, "luac");
      if (!fs.existsSync(luacDir)) continue;

      const files = fs.readdirSync(luacDir).filter((f) => f.endsWith(".json"));
      if (files.length === 0) continue;

      db.exec("BEGIN TRANSACTION;");
      let dirFileCount = 0;
      let dirRecordCount = 0;
      for (const file of files) {
        const filePath = path.join(luacDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const lowerFileName = file.toLowerCase();
          insertFileStmt.run(rootName, directory, lowerFileName, content);
          totalBytes += content.length;
          dirFileCount += 1;

          // Extract records into gameplay_records
          const tableName = file.replace(/\.json$/i, "").toUpperCase();
          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch (_) {}

          if (parsed) {
            let recordList = null;
            if (Array.isArray(parsed)) {
              recordList = parsed;
            } else if (parsed.records && Array.isArray(parsed.records)) {
              recordList = parsed.records;
            }

            if (recordList && recordList.length > 0) {
              for (const r of recordList) {
                const keys = extractRecordKeys(tableName, r);
                if (keys && keys.recordId) {
                  insertRecordStmt.run(
                    tableName,
                    keys.recordId,
                    keys.secondaryId,
                    keys.stringKey,
                    JSON.stringify(r)
                  );
                  dirRecordCount += 1;
                }
              }
            }
          }
        } catch (err) {
          console.error(`[!] Failed to read file ${filePath}:`, err.message);
        }
      }
      db.exec("COMMIT;");
      totalFiles += dirFileCount;
      totalRecords += dirRecordCount;
      console.log(` [+] ${rootName}/${directory}: ${dirFileCount} files, ${dirRecordCount} indexed records.`);
    }
  }

  console.log(" -> Optimizing database structure (VACUUM)...");
  db.exec("VACUUM;");
  db.close();

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
  const sizeMb = (fs.statSync(sqlitePath).size / (1024 * 1024)).toFixed(2);
  console.log(`=== COMPILATION COMPLETE ===`);
  console.log(`Total files: ${totalFiles}`);
  console.log(`Total indexed records: ${totalRecords}`);
  console.log(`SQLite database size: ${sizeMb} MB`);
  console.log(`Execution time: ${totalTime} seconds`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  compileGameplaySqlite({ all });
}

module.exports = { compileGameplaySqlite, DEFAULT_SQLITE_PATH };
