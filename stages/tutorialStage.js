// Tutorial stage definitions.
//
// Stage/dungeon/map/event-deck values come from the decrypted gameplay tables:
// - LUA_STAGE_TEMPLET: 11211..11214 are SST_TUTORIAL.
// - server-data/dungeons.json: dungeons 1004..1007 and cutscene IDs.
// - LUA_EVENTDECK_TEMPLET: event decks 1004..1007.
//
// Phase 1 also keeps captured GAME_SYNC state because the lightweight fallback
// simulator still needs a known-good bootstrap. Phases 2-4 are intentionally
// metadata-only here; the managed combat host hydrates their actual teams and
// dungeon events from the client tables.

const TUTORIAL_STAGE_CHAIN = Object.freeze([
  Object.freeze({
    stageId: 11211,
    stageStrID: "STAGE_MAINSTREAM_11211",
    dungeonID: 1004,
    dungeonStrID: "NKM_DUNGEON_EP_1_ACT_1_1",
    mapID: 1064,
    mapStrID: "AB_MAP_GAME_STREET_OPS_NIGHT_SHORT",
    eventDeckId: 1004,
    beforeCutscene: "EP1_ACT1_STAGE1_START",
    afterCutscene: "",
  }),
  Object.freeze({
    stageId: 11212,
    stageStrID: "STAGE_MAINSTREAM_11212",
    dungeonID: 1005,
    dungeonStrID: "NKM_DUNGEON_EP_1_ACT_1_2",
    mapID: 1065,
    mapStrID: "AB_MAP_GAME_NEWTOWN_NIGHT_SHORT",
    eventDeckId: 1005,
    beforeCutscene: "EP1_ACT1_STAGE2_START",
    afterCutscene: "",
  }),
  Object.freeze({
    stageId: 11213,
    stageStrID: "STAGE_MAINSTREAM_11213",
    dungeonID: 1006,
    dungeonStrID: "NKM_DUNGEON_EP_1_ACT_1_3",
    mapID: 1065,
    mapStrID: "AB_MAP_GAME_NEWTOWN_NIGHT_SHORT",
    eventDeckId: 1006,
    beforeCutscene: "EP1_ACT1_STAGE3_START",
    afterCutscene: "",
  }),
  Object.freeze({
    stageId: 11214,
    stageStrID: "STAGE_MAINSTREAM_11214",
    dungeonID: 1007,
    dungeonStrID: "NKM_DUNGEON_EP_1_ACT_1_4",
    mapID: 1066,
    mapStrID: "AB_MAP_GAME_NEWTOWN_NIGHT_MIDDLE",
    eventDeckId: 1007,
    beforeCutscene: "EP1_ACT1_STAGE4_START",
    afterCutscene: "EP1_ACT1_STAGE4_END",
  }),
]);

const TUTORIAL_COMPLETION_MISSION_IDS = Object.freeze([999, 100]);

function hasTutorialCompletionMission(user) {
  const missions = user && user.completedMissions && typeof user.completedMissions === "object"
    ? Object.values(user.completedMissions)
    : [];
  return missions.some(
    (mission) =>
      TUTORIAL_COMPLETION_MISSION_IDS.includes(Number(mission && mission.missionID)) &&
      (mission.isComplete === true || mission.rewardClaimed === true)
  );
}

const TUTORIAL_STAGE_BY_STAGE_ID = new Map(TUTORIAL_STAGE_CHAIN.map((stage) => [stage.stageId, stage]));
const TUTORIAL_STAGE_BY_DUNGEON_ID = new Map(TUTORIAL_STAGE_CHAIN.map((stage) => [stage.dungeonID, stage]));

const TUTORIAL_STAGE = Object.freeze({
  ...TUTORIAL_STAGE_CHAIN[0],
  gameUnitUIDIndex: 18,
  initialGameTime: 4,
  initialRemainGameTime: 180,
  respawnCostA1: 10,
  respawnCostB1: 10,
  gameState: {
    state: 3,
    winTeam: 0,
    waveId: 1,
  },
  teamA: Object.freeze({
    units: Object.freeze([
      // Captured first ship/core sync from server_031_822.payload.bin.
      Object.freeze({
        role: "ship",
        gameUnitUID: 1,
        hp: 23712,
        x: -200,
        z: -110,
        right: true,
        playState: 1,
        respawn: true,
        stateId: 11,
        stateChangeCount: 1,
        seed: 84,
      }),
    ]),
  }),
  teamB: Object.freeze({
    units: Object.freeze([
      // Captured early enemy/core sync from server_038_822.payload.bin.
      Object.freeze({
        role: "enemy",
        gameUnitUID: 4,
        hp: 1989,
        x: 1300,
        z: -110,
        right: false,
        playState: 1,
        respawn: false,
        stateId: 12,
        stateChangeCount: 2,
        seed: 10,
      }),
    ]),
  }),
  deployableGameUnitUIDGroups: Object.freeze([
    Object.freeze([5, 6]),
    Object.freeze([8, 9]),
  ]),
  autoDeployUnits: Object.freeze([
    // Captured tutorial GAME_RESPAWN_REQ used unitUID=1000807049. The server ACKs this long
    // unit UID with 817, then the generated 822 sync instantiates the assigned game-unit UIDs.
    Object.freeze({
      unitUID: "1000807049",
      assistUnit: false,
      gameUnitUIDs: Object.freeze([5, 6]),
      x: 400,
      z: -180,
      hp: 1989,
      right: true,
      playState: 1,
      stateId: 13,
      stateChangeCount: 1,
      seed: 51,
    }),
  ]),
});

const DEFAULT_TUTORIAL_RUNTIME = Object.freeze({
  gameUnitUIDIndex: 18,
  initialGameTime: 4,
  initialRemainGameTime: 180,
  respawnCostA1: 10,
  respawnCostB1: 10,
  gameState: Object.freeze({
    state: 3,
    winTeam: 0,
    waveId: 1,
  }),
  teamA: Object.freeze({
    units: Object.freeze([]),
  }),
  teamB: Object.freeze({
    units: Object.freeze([]),
  }),
  deployableGameUnitUIDGroups: Object.freeze([]),
  autoDeployUnits: Object.freeze([]),
});

function cloneUnit(unit, team) {
  return {
    ...unit,
    team,
    maxHp: unit.hp,
    targetUID: 0,
    subTargetUID: 0,
    speedX: 0,
    speedY: 0,
    speedZ: 0,
    savedPosX: unit.x,
  };
}

function cloneStage(stage) {
  return {
    ...DEFAULT_TUTORIAL_RUNTIME,
    ...stage,
    tutorial: true,
    gameState: { ...(stage.gameState || DEFAULT_TUTORIAL_RUNTIME.gameState) },
    teamA: {
      units: (stage.teamA && stage.teamA.units ? stage.teamA.units : []).map((unit) => ({ ...unit })),
    },
    teamB: {
      units: (stage.teamB && stage.teamB.units ? stage.teamB.units : []).map((unit) => ({ ...unit })),
    },
    deployableGameUnitUIDGroups: (stage.deployableGameUnitUIDGroups || []).map((group) => group.slice()),
    autoDeployUnits: (stage.autoDeployUnits || []).map((unit) => ({
      ...unit,
      gameUnitUIDs: unit.gameUnitUIDs.slice(),
    })),
    initialUnits: [
      ...(stage.teamA && stage.teamA.units ? stage.teamA.units : []).map((unit) => cloneUnit(unit, 1)),
      ...(stage.teamB && stage.teamB.units ? stage.teamB.units : []).map((unit) => cloneUnit(unit, 3)),
    ],
  };
}

function getTutorialStage(stageId = 11211) {
  return getTutorialStageByStageId(stageId) || cloneStage(TUTORIAL_STAGE);
}

function getTutorialStageByStageId(stageId) {
  const numeric = Number(stageId);
  if (numeric === 11211) return cloneStage(TUTORIAL_STAGE);
  const stage = TUTORIAL_STAGE_BY_STAGE_ID.get(numeric);
  return stage ? cloneStage(stage) : null;
}

function getTutorialStageByDungeonId(dungeonId) {
  const stage = TUTORIAL_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  if (!stage) return null;
  return getTutorialStageByStageId(stage.stageId);
}

function getTutorialStageForRequest(req) {
  if (!req) return null;
  return getTutorialStageByStageId(req.stageID) || getTutorialStageByDungeonId(req.dungeonID);
}

function isTutorialStageId(stageId) {
  return TUTORIAL_STAGE_BY_STAGE_ID.has(Number(stageId));
}

function isTutorialDungeonId(dungeonId) {
  return TUTORIAL_STAGE_BY_DUNGEON_ID.has(Number(dungeonId));
}

function mapIdForStageDungeon(stageId, dungeonId) {
  const stage = TUTORIAL_STAGE_BY_STAGE_ID.get(Number(stageId)) || TUTORIAL_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return stage ? stage.mapID : 1064;
}

function stageIdForDungeonId(dungeonId) {
  const stage = TUTORIAL_STAGE_BY_DUNGEON_ID.get(Number(dungeonId));
  return stage ? stage.stageId : 0;
}

module.exports = {
  getTutorialStage,
  getTutorialStageByStageId,
  getTutorialStageByDungeonId,
  getTutorialStageForRequest,
  isTutorialStageId,
  isTutorialDungeonId,
  mapIdForStageDungeon,
  stageIdForDungeonId,
  hasTutorialCompletionMission,
  TUTORIAL_COMPLETION_MISSION_IDS,
  TUTORIAL_STAGE_CHAIN,
};
