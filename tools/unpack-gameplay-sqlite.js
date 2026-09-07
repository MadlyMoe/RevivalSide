"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_SQLITE_PATH = path.join(ROOT_DIR, "gameplay-jsons", "gameplay_tables.sqlite");

function unpackGameplaySqlite(options = {}) {
  const sqlitePath = options.sqlitePath || DEFAULT_SQLITE_PATH;
  const outputDir = options.outputDir || path.join(ROOT_DIR, "gameplay-jsons-unpacked");
  const startTime = performance.now();

  if (!fs.existsSync(sqlitePath)) {
    console.error(`[!] SQLite database file not found: ${sqlitePath}`);
    return;
  }

  console.log(`=== STARTING SQLITE TO JSON EXTRACTION (UNPACK) ===`);
  console.log(`Input: ${sqlitePath}`);
  console.log(`Output: ${outputDir}`);

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  db.exec("PRAGMA query_only = 1;");

  const queryStmt = db.prepare("SELECT root_name, directory, file_name, data FROM gameplay_files");
  const rows = queryStmt.all();

  let count = 0;
  for (const row of rows) {
    const targetDir = path.join(outputDir, row.root_name, row.directory, "luac");
    fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, row.file_name);
    fs.writeFileSync(targetFile, row.data, "utf8");
    count += 1;
  }

  db.close();
  const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`=== EXTRACTION COMPLETE ===`);
  console.log(`Exported ${count} JSON files to: ${outputDir}`);
  console.log(`Execution time: ${totalTime} seconds`);
}

if (require.main === module) {
  unpackGameplaySqlite();
}

module.exports = { unpackGameplaySqlite };
