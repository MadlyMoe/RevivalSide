"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server", "listener.js"), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert(start >= 0 && end > start, `missing ${name}`);
  return source.slice(start, end);
}

assert(functionSource("buildDynamicGameEndNotPayload", "buildBattleGameRecordState").includes("{ save: false }"));
assert(functionSource("getOrGrantStageClearLoot", "maybeGrantBattleStageClearLoot").includes("{ ...options, replay, multiplier }"));
assert(functionSource("maybeGrantBattleStageClearLoot", "grantStageClearLoot").includes("{ save: false }"));
assert(functionSource("grantStageClearLoot", "grantStageFirstClearReward").includes("options.save !== false"));
assert.equal((functionSource("recordMainStoryDungeonClear", "recordGenericDungeonClear").match(/saveUserDb\(\)/g) || []).length, 1);
assert.equal((functionSource("recordGenericDungeonClear", "recordGenericDungeonClearForUser").match(/saveUserDb\(\)/g) || []).length, 1);
assert.equal((functionSource("buildDungeonSkipAckPayload", "buildDungeonRewardSet").match(/saveUserDb\(\)/g) || []).length, 1);

console.log("stage clear persistence verified: one database save per clear flow");
