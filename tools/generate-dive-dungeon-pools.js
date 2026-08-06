#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(
  ROOT_DIR,
  "gameplay-jsons",
  "generated",
  "dive-dungeon-pool-generated-test.json"
);
const ACTIVE_DIVE_DUNGEON_ID_MIN = 9_500_000;
const MIN_DIVE_NUMBER = 1;
const MAX_DIVE_NUMBER = 80;

const SOURCE_PATHS = Object.freeze({
  dives: path.join(
    ROOT_DIR,
    "gameplay-jsons",
    "StreamingAssets",
    "ab_script",
    "luac",
    "LUA_DIVE_TEMPLET.json"
  ),
  dungeons: path.join(
    ROOT_DIR,
    "gameplay-jsons",
    "StreamingAssets",
    "ab_script_dungeon_templet",
    "luac",
    "LUA_DUNGEON_TEMPLET_BASE.json"
  ),
  assetbundleDives: path.join(
    ROOT_DIR,
    "gameplay-jsons",
    "Assetbundles",
    "ab_script",
    "luac",
    "LUA_DIVE_TEMPLET.json"
  ),
  assetbundleDungeons: path.join(
    ROOT_DIR,
    "gameplay-jsons",
    "Assetbundles",
    "ab_script_dungeon_templet",
    "luac",
    "LUA_DUNGEON_TEMPLET_BASE.json"
  ),
});

const POOL_CATEGORIES = Object.freeze([
  "SECTOR_BOSS",
  "POINCARE_EASY",
  "POINCARE_HARD",
  "REIMANN_EASY",
  "REIMANN_HARD",
  "GAUNTLET_EASY",
  "GAUNTLET_HARD",
]);

function readRecords(filePath) {
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!document || !Array.isArray(document.records)) {
    throw new Error(`${path.relative(ROOT_DIR, filePath)} does not contain a records array`);
  }
  return { document, records: document.records };
}

function diveNumberFromStage(row, kind) {
  const value = String(row && row.STAGE_STR_ID || "");
  const pattern = kind === "standard" ? /^DIVE_SEARCH_(\d+)$/ : /^DIVE_EVENT_(\d+)(?:_H)?$/;
  const match = pattern.exec(value);
  return match ? Number(match[1]) : 0;
}

function indexStagesByDiveNumber(rows, kind) {
  const result = new Map();
  for (const row of rows) {
    const diveNumber = diveNumberFromStage(row, kind);
    if (diveNumber < MIN_DIVE_NUMBER || diveNumber > MAX_DIVE_NUMBER) continue;
    if (result.has(diveNumber)) {
      throw new Error(`Duplicate ${kind} stage for dive ${diveNumber}`);
    }
    result.set(diveNumber, row);
  }
  return result;
}

function classifyDungeon(row) {
  const nameKey = String(row && row.m_DungeonName || "").toUpperCase();
  if (nameKey.includes("NKM_DIVE_BATTLE_SECTORBOSS_")) return "SECTOR_BOSS";

  const match = /NKM_DIVE_BATTLE_(POINCARE|REIMANN|GAUNTLET)_(EASY|HARD)_/.exec(nameKey);
  return match ? `${match[1]}_${match[2]}` : "UNCLASSIFIED";
}

function isActiveDiveDungeon(row) {
  return (
    Number(row && row.m_DungeonID) >= ACTIVE_DIVE_DUNGEON_ID_MIN &&
    String(row && row.m_DungeonStrID || "").startsWith("NKM_DIVE_BATTLE_")
  );
}

function sortedDungeonIds(rows) {
  return rows.map((row) => Number(row.m_DungeonID)).sort((left, right) => left - right);
}

function buildPool(rows, effectiveDungeonLevel) {
  const levelRows = rows
    .filter((row) => Number(row && row.m_DungeonLevel) === effectiveDungeonLevel)
    .sort((left, right) => Number(left.m_DungeonID) - Number(right.m_DungeonID));

  const byCategory = Object.fromEntries(POOL_CATEGORIES.map((category) => [category, []]));
  for (const row of levelRows) {
    const category = classifyDungeon(row);
    if (!Object.hasOwn(byCategory, category)) {
      throw new Error(
        `Dungeon ${row.m_DungeonID} (${row.m_DungeonStrID}) at level ${effectiveDungeonLevel} is ${category}`
      );
    }
    byCategory[category].push(Number(row.m_DungeonID));
  }

  const pool = {
    all: sortedDungeonIds(levelRows),
    sectorBoss: byCategory.SECTOR_BOSS,
    poincare: {
      easy: byCategory.POINCARE_EASY,
      hard: byCategory.POINCARE_HARD,
    },
    reimann: {
      easy: byCategory.REIMANN_EASY,
      hard: byCategory.REIMANN_HARD,
    },
    gauntlet: {
      easy: byCategory.GAUNTLET_EASY,
      hard: byCategory.GAUNTLET_HARD,
    },
    byCategory,
  };

  const categorizedIds = POOL_CATEGORIES.flatMap((category) => byCategory[category]).sort((a, b) => a - b);
  if (JSON.stringify(categorizedIds) !== JSON.stringify(pool.all)) {
    throw new Error(`Pool partition does not cover every dungeon at level ${effectiveDungeonLevel}`);
  }
  if (!pool.all.length || !pool.sectorBoss.length) {
    throw new Error(`Incomplete dungeon pool at level ${effectiveDungeonLevel}`);
  }

  return { pool, rows: levelRows };
}

function calculateEffectiveFightLevels(diveNumber, standardStage, poolDungeonLevel) {
  if (diveNumber > 50) {
    return {
      hallway: poolDungeonLevel,
      boss: poolDungeonLevel,
    };
  }

  const stageLevel = Number(standardStage && standardStage.STAGE_LEVEL || 0);
  const setLevelScale = Number(standardStage && standardStage.SET_LEVEL_SCALE || 0);
  return {
    hallway: stageLevel,
    boss: stageLevel + setLevelScale,
  };
}

function effectiveFightLevelsByCategory(effectiveFightLevels) {
  return Object.fromEntries(
    POOL_CATEGORIES.map((category) => [
      category,
      category === "SECTOR_BOSS" ? effectiveFightLevels.boss : effectiveFightLevels.hallway,
    ])
  );
}

function effectiveFightLevelsByDungeonId(pool, levelsByCategory) {
  return Object.fromEntries(
    POOL_CATEGORIES.flatMap((category) =>
      pool.byCategory[category].map((dungeonId) => [String(dungeonId), levelsByCategory[category]])
    )
  );
}

function relativeSourcePath(filePath) {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join("/");
}

function assertMirroredSourcesAgree(streamingDives, streamingDungeons, assetbundleDives, assetbundleDungeons) {
  if (JSON.stringify(streamingDives) !== JSON.stringify(assetbundleDives)) {
    throw new Error("StreamingAssets and Assetbundles dive records differ");
  }

  const activeRowsById = (rows) => Object.fromEntries(
    rows
      .filter(isActiveDiveDungeon)
      .sort((left, right) => Number(left.m_DungeonID) - Number(right.m_DungeonID))
      .map((row) => [String(row.m_DungeonID), row])
  );
  if (
    JSON.stringify(activeRowsById(streamingDungeons)) !==
    JSON.stringify(activeRowsById(assetbundleDungeons))
  ) {
    throw new Error("StreamingAssets and Assetbundles active dive-dungeon records differ");
  }
}

function outputPathFromArguments(argv) {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex === -1) return DEFAULT_OUTPUT;
  const value = argv[outputIndex + 1];
  if (!value) throw new Error("--output requires a path");
  return path.resolve(ROOT_DIR, value);
}

function main() {
  const outputPath = outputPathFromArguments(process.argv.slice(2));
  const diveSource = readRecords(SOURCE_PATHS.dives);
  const dungeonSource = readRecords(SOURCE_PATHS.dungeons);
  const assetbundleDiveSource = readRecords(SOURCE_PATHS.assetbundleDives);
  const assetbundleDungeonSource = readRecords(SOURCE_PATHS.assetbundleDungeons);
  assertMirroredSourcesAgree(
    diveSource.records,
    dungeonSource.records,
    assetbundleDiveSource.records,
    assetbundleDungeonSource.records
  );
  const standardStages = indexStagesByDiveNumber(diveSource.records, "standard");
  const eventStages = indexStagesByDiveNumber(diveSource.records, "event");
  const activeDiveDungeons = dungeonSource.records.filter(isActiveDiveDungeon);

  const divesByNumber = {};
  const poolGroupsByEffectiveDungeonLevel = {};
  const dungeonsById = {};

  for (let diveNumber = MIN_DIVE_NUMBER; diveNumber <= MAX_DIVE_NUMBER; diveNumber += 1) {
    const standardStage = standardStages.get(diveNumber);
    const eventStage = eventStages.get(diveNumber);
    if (!standardStage || !eventStage) {
      throw new Error(`Missing ${!standardStage ? "standard" : "event"} stage for dive ${diveNumber}`);
    }

    const effectiveDungeonLevel =
      Number(standardStage.STAGE_LEVEL || 0) - Number(standardStage.STAGE_LEVEL_SCALE || 0);
    const eventEffectiveLevel = Number(eventStage.STAGE_LEVEL || 0) - Number(eventStage.STAGE_LEVEL_SCALE || 0);
    if (effectiveDungeonLevel <= 0 || eventEffectiveLevel !== effectiveDungeonLevel) {
      throw new Error(`Standard/event effective-level mismatch for dive ${diveNumber}`);
    }

    const groupKey = String(effectiveDungeonLevel);
    if (!poolGroupsByEffectiveDungeonLevel[groupKey]) {
      const built = buildPool(activeDiveDungeons, effectiveDungeonLevel);
      poolGroupsByEffectiveDungeonLevel[groupKey] = {
        effectiveDungeonLevel,
        diveNumbers: [],
        dungeonCount: built.pool.all.length,
        pools: built.pool,
      };

      for (const row of built.rows) {
        const dungeonId = Number(row.m_DungeonID);
        dungeonsById[String(dungeonId)] = {
          dungeonId,
          dungeonStrId: String(row.m_DungeonStrID || ""),
          poolCategory: classifyDungeon(row),
          dungeonLevel: Number(row.m_DungeonLevel || 0),
          dungeonType: String(row.m_DungeonType || ""),
          dungeonNameKey: String(row.m_DungeonName || ""),
          dungeonDescriptionKey: String(row.m_DungeonDesc || ""),
          dungeonTempletFileName: String(row.m_DungeonTempletFileName || ""),
          dungeonMapStrId: String(row.m_DungeonMapStrID || ""),
          sourceRecord: row,
        };
      }
    }

    const group = poolGroupsByEffectiveDungeonLevel[groupKey];
    const effectiveFightLevels = calculateEffectiveFightLevels(
      diveNumber,
      standardStage,
      effectiveDungeonLevel
    );
    const fightLevelsByCategory = effectiveFightLevelsByCategory(effectiveFightLevels);
    group.diveNumbers.push(diveNumber);
    divesByNumber[String(diveNumber)] = {
      diveNumber,
      effectiveDungeonLevel,
      poolGroupKey: groupKey,
      dungeonCount: group.dungeonCount,
      effectiveFightLevels,
      effectiveFightLevelByPoolCategory: fightLevelsByCategory,
      effectiveFightLevelByDungeonId: effectiveFightLevelsByDungeonId(
        group.pools,
        fightLevelsByCategory
      ),
      dungeonPools: group.pools,
      standardStage,
      eventStage,
    };
  }

  const expectedDiveNumbers = Array.from(
    { length: MAX_DIVE_NUMBER - MIN_DIVE_NUMBER + 1 },
    (_, index) => index + MIN_DIVE_NUMBER
  );
  const actualDiveNumbers = Object.keys(divesByNumber).map(Number);
  if (JSON.stringify(actualDiveNumbers) !== JSON.stringify(expectedDiveNumbers)) {
    throw new Error("Generated dive keys are not the complete ordered range 1-80");
  }

  const output = {
    schemaVersion: 2,
    description:
      "Comprehensive mapping of CounterSide dive numbers 1-80 to active dungeon pools and effective fight levels.",
    generatedBy: relativeSourcePath(__filename),
    sources: {
      diveTemplets: {
        path: relativeSourcePath(SOURCE_PATHS.dives),
        rootName: diveSource.document.rootName,
        recordCount: diveSource.records.length,
      },
      dungeonTemplets: {
        path: relativeSourcePath(SOURCE_PATHS.dungeons),
        rootName: dungeonSource.document.rootName,
        recordCount: dungeonSource.records.length,
      },
      verifiedMirrors: {
        diveTemplets: {
          path: relativeSourcePath(SOURCE_PATHS.assetbundleDives),
          rootName: assetbundleDiveSource.document.rootName,
          recordCount: assetbundleDiveSource.records.length,
        },
        dungeonTemplets: {
          path: relativeSourcePath(SOURCE_PATHS.assetbundleDungeons),
          rootName: assetbundleDungeonSource.document.rootName,
          recordCount: assetbundleDungeonSource.records.length,
        },
        note:
          "All dive records and all active dive-dungeon records are identical to the StreamingAssets sources.",
      },
    },
    derivation: {
      diveNumber: "Numeric suffix of DIVE_SEARCH_<n> and DIVE_EVENT_<n>[_H].",
      effectiveDungeonLevel: "STAGE_LEVEL - STAGE_LEVEL_SCALE from the matching dive stage.",
      effectiveFightLevelDives1To50: {
        hallway: "STAGE_LEVEL.",
        boss: "STAGE_LEVEL + SET_LEVEL_SCALE.",
      },
      effectiveFightLevelDives51To80:
        "The confirmed existing mapping is retained: both hallway and boss use effectiveDungeonLevel.",
      activeDungeonFilter:
        "m_DungeonID >= 9500000, m_DungeonStrID starts with NKM_DIVE_BATTLE_, and m_DungeonLevel equals the effective dungeon level.",
      poolCategory:
        "Derived from m_DungeonName: SECTORBOSS, or POINCARE/REIMANN/GAUNTLET plus EASY/HARD.",
    },
    counts: {
      dives: Object.keys(divesByNumber).length,
      effectiveDungeonLevels: Object.keys(poolGroupsByEffectiveDungeonLevel).length,
      uniqueDungeons: Object.keys(dungeonsById).length,
    },
    poolGroupsByEffectiveDungeonLevel,
    dungeonsById,
    divesByNumber,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${relativeSourcePath(outputPath)}: ${output.counts.dives} dives, ` +
      `${output.counts.effectiveDungeonLevels} effective levels, ${output.counts.uniqueDungeons} dungeons.\n`
  );
}

main();
