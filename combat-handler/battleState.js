// Battle state ownership.
//
// This module creates and mutates the in-memory combat state used by deploy,
// tick, and syncBuilder. It intentionally does not send network packets.

function createBattleStateManager(options = {}) {
  const tick = options.tick;
  const extractGameLoadUnitPools = options.extractGameLoadUnitPools || (() => emptyPools());
  const capturedRespawnUnitPools = options.capturedRespawnUnitPools || emptyPools();
  const parseCapturedGameSyncPayload = options.parseCapturedGameSyncPayload;
  const capturedGameFlow = options.capturedGameFlow || null;
  const dynamicBattleGameUnitGroups = options.dynamicBattleGameUnitGroups || [];
  const makeDynamicGameUid = options.makeDynamicGameUid || (() => BigInt(Date.now()) * 10000n);
  const mapIdForStageDungeon = options.mapIdForStageDungeon || (() => 1064);

  function startBattle(initialData = {}) {
    const replay = initialData.replay;
    const req = initialData.req;
    if (!replay || !req) return null;
    const activeStage = initialData.stage || {};
    const gameUnitGroups =
      activeStage.deployableGameUnitUIDGroups && activeStage.deployableGameUnitUIDGroups.length
        ? activeStage.deployableGameUnitUIDGroups
        : dynamicBattleGameUnitGroups.length
          ? dynamicBattleGameUnitGroups
          : [[5, 6]];
    const assignedGameUnitUIDs = gameUnitGroups.flat();
    const gameUID = initialData.gameUID || makeDynamicGameUid();

    replay.dynamicGame = {
      stageID: Number(activeStage.stageId || req.stageID || 0),
      dungeonID: Number(activeStage.dungeonID || req.dungeonID || 0),
      mapID: Number(activeStage.mapID || mapIdForStageDungeon(req.stageID, req.dungeonID)),
      teamBLevelAdd: Number(activeStage.teamBLevelAdd || 0),
      teamBLevelFix: Number(activeStage.teamBLevelFix || 0),
      gameUID,
      gameUnitUIDIndex: Number(activeStage.gameUnitUIDIndex || 18),
      rewardMultiply: Math.max(0, Number(req.rewardMultiply || 0) || 0),
      deployableGameUnitUIDGroups: gameUnitGroups.map((group) => group.slice()),
      assignedGameUnitUIDs,
      initialUnitsSent: false,
      tutorial: isTutorialStageId(activeStage.stageId || req.stageID),
    };

    replay.battleState = {
      stageId: replay.dynamicGame.stageID,
      gameUID,
      units: (activeStage.initialUnits || []).map((unit) => ({ ...unit })),
      startTime: Date.now(),
      gameTime: Number(activeStage.initialGameTime || 4),
      absoluteGameTime: Number(activeStage.initialGameTime || 4),
      remainGameTime: Number(activeStage.initialRemainGameTime || 180),
      respawnCostA1: activeStage.respawnCostA1 == null ? 10 : Number(activeStage.respawnCostA1),
      respawnCostB1: activeStage.respawnCostB1 == null ? 10 : Number(activeStage.respawnCostB1),
      gameState: activeStage.gameState || { state: 3, winTeam: 0, waveId: 1 },
      autoDeployUnits: (activeStage.autoDeployUnits || []).map((unit) => ({ ...unit, gameUnitUIDs: unit.gameUnitUIDs.slice() })),
      deployedUnitUIDs: new Set(),
      pendingDieUnitUIDs: [],
      pendingDeckSyncs: [],
      pendingGameStates: [],
      pendingDungeonEvents: [],
      deployCount: 0,
    };

    for (const unit of replay.battleState.units) tick.hydrateBattleUnitStats(unit);
    replay.dynamicGame.gameUID = gameUID;
    replay.tutorialReplayPhase = replay.dynamicGame.tutorial ? "captured-bootstrap" : "dynamic";
    replay.syntheticGameTime = replay.battleState.gameTime;
    replay.battleSim = null;
    replay.dynamicBattleResultSent = false;
    replay.managedGameLoadAckPayload = null;
    return replay.dynamicGame;
  }

  function attachGameLoadUnitPools(replay, activeStage, gameLoadAckPayload) {
    if (!replay || !replay.dynamicGame) return emptyPools();
    replay.dynamicGame.unitPools = buildRuntimeGameUnitPools(activeStage || {}, gameLoadAckPayload);
    replay.dynamicGame.usedPooledGameUnitUIDs = new Set((replay.battleState.units || []).map((unit) => Number(unit.gameUnitUID || 0)));
    return replay.dynamicGame.unitPools;
  }

  function buildRuntimeGameUnitPools(activeStage, gameLoadAckPayload) {
    const pools = extractGameLoadUnitPools(gameLoadAckPayload);
    mergeExtractedUnitPools(pools, capturedRespawnUnitPools);

    for (const unit of activeStage.autoDeployUnits || []) {
      mergeExtractedUnitPools(pools, {
        unitUID: unit.unitUID,
        gameUnitUIDs: unit.gameUnitUIDs || [],
      });
    }

    const fallbackUIDs = new Set(pools.allGameUnitUIDs);
    for (const group of activeStage.deployableGameUnitUIDGroups || []) {
      for (const uid of group || []) {
        const numeric = Number(uid);
        if (Number.isInteger(numeric) && numeric > 0) fallbackUIDs.add(numeric);
      }
    }
    pools.unassignedGameUnitUIDs = Array.from(fallbackUIDs).filter((uid) => uid > 4).sort((a, b) => a - b);
    return pools;
  }

  function describeRuntimeGameUnitPools(pools) {
    if (!pools || !pools.ordered || pools.ordered.length === 0) return "";
    return pools.ordered.map((pool) => `${pool.unitUID}:${pool.gameUnitUIDs.join("/")}`).join(";");
  }

  function deployStageLineup(replay) {
    const battleState = replay && replay.battleState;
    if (!battleState || !Array.isArray(battleState.autoDeployUnits)) return [];
    const dynamicGame = replay.dynamicGame || {};
    if (!dynamicGame.usedPooledGameUnitUIDs) dynamicGame.usedPooledGameUnitUIDs = new Set();
    const deployed = [];
    for (const unit of battleState.autoDeployUnits) {
      const unitUID = String(unit.unitUID || "");
      if (!unitUID || battleState.deployedUnitUIDs.has(unitUID)) continue;
      battleState.deployedUnitUIDs.add(unitUID);
      for (const gameUnitUID of unit.gameUnitUIDs || []) {
        const deployedUnit = {
          sourceUnitUID: unitUID,
          gameUnitUID,
          team: 1,
          hp: unit.hp,
          maxHp: unit.hp,
          x: unit.x,
          z: unit.z,
          savedPosX: unit.x,
          right: unit.right !== false,
          playState: unit.playState == null ? 1 : unit.playState,
          respawn: true,
          stateId: unit.stateId || 13,
          stateChangeCount: unit.stateChangeCount == null ? 1 : unit.stateChangeCount,
          speedX: 0,
          speedY: 0,
          speedZ: 0,
          targetUID: 0,
          subTargetUID: 0,
          seed: unit.seed == null ? 51 : unit.seed,
        };
        tick.hydrateBattleUnitStats(deployedUnit);
        battleState.units.push(deployedUnit);
        dynamicGame.usedPooledGameUnitUIDs.add(Number(gameUnitUID));
      }
      deployed.push(unit);
    }
    replay.dynamicGame = dynamicGame;
    return deployed;
  }

  function transitionTutorialReplayToDynamic(replay, endIndex) {
    if (!replay || !replay.tutorialReplayPhase || replay.tutorialReplayPhase === "dynamic") return false;
    const capturedState = extractCapturedBattleStateBeforeIndex(endIndex);
    replay.tutorialReplayPhase = "dynamic";
    if (replay.dynamicGame) replay.dynamicGame.initialUnitsSent = true;
    if (replay.battleState && capturedState.units.length > 0) {
      replay.battleState.units = mergeCapturedBattleUnits(capturedState.units, replay.battleState.units, replay);
      replay.battleState.gameTime = capturedState.gameTime;
      replay.battleState.absoluteGameTime = capturedState.absoluteGameTime;
      replay.battleState.remainGameTime = capturedState.remainGameTime;
      replay.battleState.continuationMode = true;
      replay.battleState.pendingDieUnitUIDs = [];
    } else if (replay.battleState) {
      replay.battleState.gameTime = Math.max(Number(replay.battleState.gameTime || 0), Number(replay.syntheticGameTime || 0), 14);
      replay.battleState.absoluteGameTime = Math.max(Number(replay.battleState.absoluteGameTime || 0), replay.battleState.gameTime);
      replay.battleState.continuationMode = true;
      replay.battleState.pendingDieUnitUIDs = replay.battleState.pendingDieUnitUIDs || [];
    }
    return true;
  }

  function mergeCapturedBattleUnits(capturedUnits, previousUnits, replay) {
    const previousByUid = new Map();
    for (const unit of previousUnits || []) {
      if (!unit || unit.gameUnitUID == null) continue;
      previousByUid.set(Number(unit.gameUnitUID), unit);
    }
    return capturedUnits.map((unit) => {
      const previous = previousByUid.get(Number(unit.gameUnitUID)) || {};
      const merged = {
        ...previous,
        ...unit,
        role: unit.role || previous.role || "",
        unitID: unit.unitID || previous.unitID || previous.baseUnitID || 0,
        unitStrID: unit.unitStrID || previous.unitStrID || "",
        sourceUnitUID: unit.sourceUnitUID || previous.sourceUnitUID || "",
        maxHp: Math.max(1, Number(previous.maxHp || 0), Number(unit.maxHp || 0), Number(unit.hp || 0)),
        pendingRemove: false,
        deadTicks: 0,
      };
      if (!merged.sourceUnitUID && replay && replay.lastRespawnReq && merged.team === 1 && Number(merged.gameUnitUID) > 4) {
        merged.sourceUnitUID = replay.lastRespawnReq.unitUID;
      }
      tick.hydrateBattleUnitStats(merged);
      return merged;
    });
  }

  function extractCapturedBattleStateBeforeIndex(endIndex) {
    const latestUnits = new Map();
    let gameTime = 14;
    let absoluteGameTime = 14;
    let remainGameTime = 166;
    if (!capturedGameFlow || !Array.isArray(capturedGameFlow.server) || typeof parseCapturedGameSyncPayload !== "function") {
      return { units: [], gameTime, absoluteGameTime, remainGameTime };
    }

    const limit = Math.min(Math.max(1, Number(endIndex || 1)) - 1, capturedGameFlow.server.length);
    for (let index = 1; index <= limit; index += 1) {
      const entry = capturedGameFlow.server[index - 1];
      if (!entry || entry.packetId !== 822 || !entry.payload) continue;
      try {
        const sync = parseCapturedGameSyncPayload(entry);
        gameTime = Math.max(gameTime, sync.gameTime || 0);
        absoluteGameTime = Math.max(absoluteGameTime, sync.absoluteGameTime || gameTime);
        if (sync.remainGameTime != null) remainGameTime = sync.remainGameTime;
        for (const unit of sync.units) {
          latestUnits.set(unit.gameUnitUID, {
            ...(latestUnits.get(unit.gameUnitUID) || {}),
            ...unit,
            respawn: false,
            continuation: true,
          });
        }
      } catch (_) {
        // Lightweight sync parsing is best-effort; failed nested payloads stay on captured replay.
      }
    }

    return {
      units: Array.from(latestUnits.values()).sort((a, b) => a.gameUnitUID - b.gameUnitUID),
      gameTime,
      absoluteGameTime,
      remainGameTime,
    };
  }

  return {
    startBattle,
    attachGameLoadUnitPools,
    buildRuntimeGameUnitPools,
    describeRuntimeGameUnitPools,
    deployStageLineup,
    transitionTutorialReplayToDynamic,
    mergeCapturedBattleUnits,
    extractCapturedBattleStateBeforeIndex,
  };
}

function emptyPools() {
  return { byUnitUID: new Map(), ordered: [], allGameUnitUIDs: [], unassignedGameUnitUIDs: [] };
}

function isTutorialStageId(stageId) {
  return [11211, 11212, 11213, 11214].includes(Number(stageId));
}

function buildCapturedRespawnUnitPools(flow, options = {}) {
  const byUnitUID = new Map();
  const ordered = [];
  const decodeGameRespawnReq = options.decodeGameRespawnReq;
  const parseCapturedGameSyncPayload = options.parseCapturedGameSyncPayload;
  const gameRespawnAck = options.gameRespawnAck || 817;
  const gameSync = options.gameSync || 822;
  if (
    !flow ||
    !Array.isArray(flow.client) ||
    !Array.isArray(flow.server) ||
    typeof decodeGameRespawnReq !== "function" ||
    typeof parseCapturedGameSyncPayload !== "function"
  ) {
    return { byUnitUID, ordered };
  }

  const requests = flow.client
    .filter((entry) => entry && entry.packetId === 816 && entry.payload)
    .map((entry) => {
      const req = decodeGameRespawnReq(entry.payload);
      return req ? { ...req, time: Number(entry.time || 0), sequence: entry.sequence || entry.seq || 0 } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  for (let reqIndex = 0; reqIndex < requests.length; reqIndex += 1) {
    const req = requests[reqIndex];
    const nextReq = requests[reqIndex + 1];
    const ack = flow.server.find(
      (entry) =>
        entry &&
        entry.packetId === gameRespawnAck &&
        Number(entry.time || 0) >= req.time &&
        (!nextReq || Number(entry.time || 0) < nextReq.time)
    );
    const startTime = ack ? Number(ack.time || req.time) : req.time;
    const endTime = nextReq ? nextReq.time : Infinity;
    const gameUnitUIDs = [];
    const seen = new Set();
    for (const entry of flow.server) {
      if (!entry || entry.packetId !== gameSync || !entry.payload) continue;
      const entryTime = Number(entry.time || 0);
      if (entryTime < startTime || entryTime >= endTime) continue;
      try {
        const sync = parseCapturedGameSyncPayload(entry);
        for (const unit of sync.units || []) {
          const uid = Number(unit.gameUnitUID || 0);
          if (!unit.respawn || uid <= 4 || unit.team !== 1 || seen.has(uid)) continue;
          seen.add(uid);
          gameUnitUIDs.push(uid);
        }
      } catch (_) {
        // Some 822 packets contain nested fields this lightweight parser intentionally skips.
      }
    }
    if (gameUnitUIDs.length > 0) {
      const pool = { unitUID: String(req.unitUID), gameUnitUIDs, cursor: 0 };
      byUnitUID.set(pool.unitUID, pool);
      ordered.push(pool);
    }
  }

  return { byUnitUID, ordered };
}

function mergeExtractedUnitPools(target, source, team) {
  if (!target || !source) return;
  const entries = source.ordered
    ? source.ordered
    : source.gameUnitUIDs
      ? [{ unitUID: String(source.unitUID || ""), unitID: source.unitID || 0, gameUnitUIDs: source.gameUnitUIDs }]
      : [];
  if (!target.byUnitUID) target.byUnitUID = new Map();
  if (!target.ordered) target.ordered = [];
  if (!target.allGameUnitUIDs) target.allGameUnitUIDs = [];
  for (const entry of entries) {
    const gameUnitUIDs = (entry.gameUnitUIDs || []).map(Number).filter((value) => Number.isInteger(value) && value > 0);
    for (const uid of gameUnitUIDs) {
      if (!target.allGameUnitUIDs.includes(uid)) target.allGameUnitUIDs.push(uid);
    }
    if (!entry.unitUID || gameUnitUIDs.length === 0) continue;
    const key = String(entry.unitUID);
    if (!target.byUnitUID.has(key)) {
      target.byUnitUID.set(key, { unitUID: key, unitID: entry.unitID || 0, team, gameUnitUIDs: [], cursor: 0 });
      target.ordered.push(target.byUnitUID.get(key));
    }
    const pool = target.byUnitUID.get(key);
    for (const uid of gameUnitUIDs) {
      if (!pool.gameUnitUIDs.includes(uid)) pool.gameUnitUIDs.push(uid);
    }
  }
}

module.exports = {
  createBattleStateManager,
  buildCapturedRespawnUnitPools,
  emptyPools,
  mergeExtractedUnitPools,
};
