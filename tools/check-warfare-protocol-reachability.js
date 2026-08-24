"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const stageTable = require(path.join(
  rootDir,
  "gameplay-jsons",
  "StreamingAssets",
  "ab_script",
  "luac",
  "LUA_STAGE_TEMPLET.json"
));
const listener = read("server/listener.js");
const warfareUi = read("Assembly-CSharp/NKC/UI/Warfare/NKCWarfareGame.cs");
const warfareHud = read("Assembly-CSharp/NKC/NKCWarfareGameHUD.cs");
const shadowUi = read("Assembly-CSharp/NKC/UI/NKCUIShadowBattle.cs");
const guildUi = read("Assembly-CSharp/NKC/UI/Guild/NKCUIGuildCoop.cs");

const stages = Array.isArray(stageTable.records) ? stageTable.records : [];
const activeWarfareStages = stages.filter((stage) => stage && stage.m_StageType === "ST_WARFARE");
assert.deepStrictEqual(
  activeWarfareStages,
  [],
  "the frozen stage catalog now exposes a network Warfare stage; the unreachable exception must be removed"
);

const joinFields = listener.match(/const LocalJoinLobbyFields =?[\s\S]*?\];/) ||
  read("combat-host/ManagedCombatBridge.cs").match(/private static readonly string\[\] LocalJoinLobbyFields[\s\S]*?\];/);
assert(joinFields && joinFields[0].includes('"warfareGameData"'), "JOIN merge must replace captured Warfare state with local state");

const stopBuilder = listener.match(/function buildWarfareGameData\(\)[\s\S]*?\n}/);
assert(stopBuilder, "local JOIN Warfare state builder is missing");
assert(
  stopBuilder[0].includes("writeSignedVarInt(0), // NKM_WARFARE_GAME_STATE.NWGS_STOP"),
  "local JOIN no longer pins Warfare state to NWGS_STOP"
);
assert(stopBuilder[0].includes("writeSignedVarInt(0), // warfareTempletID"), "local JOIN exposes an active Warfare template");

for (const requestName of [
  "WARFARE_GAME_START_REQ",
  "WARFARE_GAME_MOVE_REQ",
  "WARFARE_GAME_TURN_FINISH_REQ",
  "WARFARE_GAME_NEXT_ORDER_REQ",
  "WARFARE_GAME_AUTO_REQ",
  "WARFARE_GAME_USE_SERVICE_REQ",
  "WARFARE_RECOVER_REQ",
]) {
  assert(
    warfareUi.includes(requestName) || warfareHud.includes(requestName),
    `${requestName} is no longer confined to the frozen Warfare UI`
  );
}

for (const source of [shadowUi, guildUi]) {
  assert(source.includes("WARFARE_GAME_GIVE_UP_REQ"), "expected legacy cross-mode Warfare give-up reference is missing");
  assert(
    source.includes("warfareGameState != NKM_WARFARE_GAME_STATE.NWGS_STOP"),
    "legacy cross-mode give-up is no longer gated by an active Warfare session"
  );
}

console.log(
  `[warfare-protocol-reachability-check] PASS stages=${stages.length} warfareStages=${activeWarfareStages.length} joinState=STOP`
);

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, ...relativePath.split("/")), "utf8");
}
