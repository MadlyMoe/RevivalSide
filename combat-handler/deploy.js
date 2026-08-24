// Deployment handling for GAME_RESPAWN_REQ (816).
//
// The listener parses the request and sends packets. This module decides which
// runtime gameUnitUID to use and updates battleState/deck sync state.

function createDeployHandler(options = {}) {
  const tick = options.tick;
  const syncBuilder = options.syncBuilder;
  const defaultDeployedUnitHp = options.defaultDeployedUnitHp || 1989;
  const combatStateId = options.combatStateId || { IDLE: 12, MOVE: 13, ATTACK: 45, DEAD: 18 };
  const dynamicBattleGameUnitGroups = options.dynamicBattleGameUnitGroups || [];

  function handleDeploy(replay, req) {
    if (!replay || !req) return { handled: false };
    if (replay.battleState || replay.dynamicGame) {
      const deployed = deployRuntimeBattleUnit(replay, req);
      const errorCode = deployed ? 0 : 78;
      return {
        handled: true,
        mode: "battleState",
        deployed,
        errorCode,
        ackPayload: syncBuilder.buildRespawnAck({ unitUID: req.unitUID, assistUnit: req.assistUnit, errorCode }),
        syncPayload:
          deployed && replay.battleState
            ? syncBuilder.buildGameSync(
                {
                  battleState: replay.battleState,
                  delta: 0,
                  skipSimulation: true,
                },
                { continueBattleStateUnits: tick.continueBattleStateUnits }
              )
            : null,
      };
    }

    const sim = initBattleSimulator(replay);
    const group = getBattleSpawnGroup(sim);
    if (group.length === 0) {
      return {
        handled: true,
        mode: "battleSim",
        deployed: null,
        ackPayload: syncBuilder.buildRespawnAck({ unitUID: req.unitUID, assistUnit: req.assistUnit }),
        syncPayload: null,
      };
    }
    const x = tick.clamp(Number(req.respawnPosX || 400), 250, 720);
    const spawned = group.map((gameUnitUID, index) =>
      createBattlePlayerUnit(gameUnitUID, req.unitUID, x + index * 10, index % 2 === 0 ? -180 : -176)
    );
    sim.units.push(...spawned);
    sim.playerUnitCount += 1;
    sim.respawnCostA1 = Math.max(0, sim.respawnCostA1 - spawned[0].cost);
    sim.usedRespawnCostA1 += spawned[0].cost;
    sim.pendingDeckSyncs.push({
      team: 1,
      unitDeckIndex: 0,
      unitDeckUID: req.unitUID,
      deckUsedAddUnitUID: req.unitUID,
    });
    sim.gameTime = Math.max(sim.gameTime, Number(req.gameTime || sim.gameTime));
    sim.absoluteGameTime = Math.max(sim.absoluteGameTime, sim.gameTime);
    return {
      handled: true,
      mode: "battleSim",
      deployed: spawned[0],
      spawned,
      ackPayload: syncBuilder.buildRespawnAck({ unitUID: req.unitUID, assistUnit: req.assistUnit }),
      syncPayload: null,
    };
  }

  function deployRuntimeBattleUnit(replay, req) {
    const battleState = replay && replay.battleState;
    if (!battleState || !req) return null;
    const pooled = consumePooledGameUnitUIDForDeploy(replay, req.unitUID);
    if (!pooled) return null;
    const deckUnit = findPlayerDeckUnit(replay, req.unitUID);
    const gameUnitUID = pooled.gameUnitUID;
    const unitStats = tick.findGameplayUnitStats({
      unitID: pooled.unitID || (deckUnit && deckUnit.unitId) || req.unitID,
      unitStrID: req.unitStrID,
    });
    const hp = Math.max(1, Number(req.hp || (unitStats && unitStats.hp) || defaultDeployedUnitHp));
    const x = tick.clamp(Number(req.respawnPosX || 0), -3000, 3000);
    const unit = {
      sourceUnitUID: req.unitUID,
      unitID: pooled.unitID || (deckUnit && deckUnit.unitId) || req.unitID || 0,
      unitStrID: req.unitStrID || "",
      gameUnitUID,
      team: 1,
      hp,
      maxHp: hp,
      x,
      z: 0,
      savedPosX: x,
      right: true,
      playState: 1,
      respawn: true,
      stateId: combatStateId.IDLE,
      stateChangeCount: 1,
      speedX: 0,
      speedY: 0,
      speedZ: 0,
      targetUID: 0,
      subTargetUID: 0,
      seed: 51 + (gameUnitUID % 40),
      attackTimer: 0,
      deadTicks: 0,
      pendingRemove: false,
    };
    applyPlayerDeckMetadata(unit, deckUnit || pooled.pool);
    applyPlayerDeckLeaderMetadata(unit, replay);
    tick.hydrateBattleUnitStats(unit);
    battleState.units.push(unit);
    battleState.gameTime = Math.max(Number(battleState.gameTime || 0), Number(req.gameTime || 0));
    battleState.absoluteGameTime = Math.max(Number(battleState.absoluteGameTime || battleState.gameTime), battleState.gameTime);
    if (!Array.isArray(battleState.pendingDieUnitUIDs)) battleState.pendingDieUnitUIDs = [];
    if (!Array.isArray(battleState.pendingDeckSyncs)) battleState.pendingDeckSyncs = [];
    battleState.pendingDeckSyncs.push({
      team: 1,
      unitDeckIndex: nextDeckSyncIndexForBattleState(battleState),
      unitDeckUID: req.unitUID,
      deckUsedAddUnitUID: req.unitUID,
    });
    return unit;
  }

  function enrichBattleStateUnitsFromPlayerDeck(replay) {
    const battleState = replay && replay.battleState;
    if (!battleState || !Array.isArray(battleState.units)) return;
    for (const unit of battleState.units) {
      const deckUnit = findPlayerDeckUnit(replay, unit && unit.sourceUnitUID);
      applyPlayerDeckMetadata(unit, deckUnit || findUnitPoolForBattleUnit(replay, unit));
      applyPlayerDeckLeaderMetadata(unit, replay);
    }
  }

  function findPlayerDeckUnit(replay, unitUID) {
    const key = String(unitUID || "");
    if (!key) return null;
    const units =
      replay &&
      replay.dynamicGame &&
      replay.dynamicGame.playerDeck &&
      Array.isArray(replay.dynamicGame.playerDeck.units)
        ? replay.dynamicGame.playerDeck.units
        : [];
    return units.find((unit) => String(unit && (unit.unitUid || unit.unitUID || unit.UnitUid || "")) === key) || null;
  }

  function findUnitPoolForBattleUnit(replay, unit) {
    const dynamicGame = replay && replay.dynamicGame;
    const pools = dynamicGame && dynamicGame.unitPools;
    const ordered = pools && (Array.isArray(pools.ordered) ? pools.ordered : Array.isArray(pools.Ordered) ? pools.Ordered : []);
    const sourceUnitUID = String((unit && unit.sourceUnitUID) || "");
    const gameUnitUID = Number(unit && unit.gameUnitUID);
    return (
      ordered.find((pool) => sourceUnitUID && String(pool.unitUID || pool.UnitUID || "") === sourceUnitUID) ||
      ordered.find((pool) => {
        const gameUnitUIDs = pool.gameUnitUIDs || pool.GameUnitUIDs || [];
        return gameUnitUIDs.map(Number).includes(gameUnitUID);
      }) ||
      null
    );
  }

  function applyPlayerDeckMetadata(unit, source) {
    if (!unit || !source) return unit;
    const previousTacticLevel = readNumber(unit.tacticLevel, unit.TacticLevel, 0);
    const previousTacticGroup = readNumber(unit.tacticGroup, unit.TacticGroup, 0);
    const unitId = readNumber(source.unitId, source.unitID, source.UnitID, 0);
    if (unitId > 0 && !unit.unitID) unit.unitID = unitId;
    unit.unitLevel = Math.max(1, readNumber(source.level, source.Level, source.unitLevel, source.UnitLevel, unit.unitLevel, 1));
    unit.isAssistUnit = Boolean(source.assistUnit ?? source.isAssistUnit ?? source.AssistUnit ?? unit.isAssistUnit ?? false);
    unit.isSummonee = Boolean(source.isSummonee ?? source.IsSummonee ?? unit.isSummonee ?? false);
    unit.isLeader = Boolean(source.isLeader ?? source.IsLeader ?? unit.isLeader ?? false);
    unit.limitBreakLevel = readNumber(source.limitBreakLevel, source.LimitBreakLevel, unit.limitBreakLevel, 0);
    unit.tacticLevel = readNumber(source.tacticLevel, source.TacticLevel, unit.tacticLevel, 0);
    unit.tacticGroup = readNumber(source.tacticGroup, source.TacticGroup, unit.tacticGroup, 0);
    unit.cost = readNumber(source.cost, source.deployCost, source.Cost, source.DeployCost, unit.cost, 0);
    const skillLevels = source.skillLevels || source.SkillLevels;
    if (Array.isArray(skillLevels)) unit.skillLevels = skillLevels.map(Number);
    unit.sourceUnitID = unit.unitID || unit.sourceUnitID || 0;
    if (unit.combatStats && (previousTacticLevel !== unit.tacticLevel || previousTacticGroup !== unit.tacticGroup)) {
      delete unit.combatStats;
    }
    return unit;
  }

  function applyPlayerDeckLeaderMetadata(unit, replay) {
    const playerDeck = replay && replay.dynamicGame && replay.dynamicGame.playerDeck;
    const leaderUnitUid = String(
      (playerDeck && (playerDeck.leaderUnitUid || playerDeck.leaderUnitUID || playerDeck.LeaderUnitUid)) || ""
    );
    if (leaderUnitUid && String((unit && unit.sourceUnitUID) || "") === leaderUnitUid) {
      unit.isLeader = true;
    }
    return unit;
  }

  function readNumber(...values) {
    for (const value of values) {
      if (value == null || value === "") continue;
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return 0;
  }

  function consumePooledGameUnitUIDForDeploy(replay, unitUID) {
    const battleState = replay && replay.battleState;
    const dynamicGame = replay && replay.dynamicGame;
    const pools = dynamicGame && dynamicGame.unitPools;
    if (!battleState || !dynamicGame || !pools) return null;

    if (!dynamicGame.usedPooledGameUnitUIDs) dynamicGame.usedPooledGameUnitUIDs = new Set();
    const used = new Set([
      ...Array.from(dynamicGame.usedPooledGameUnitUIDs),
      ...battleState.units.map((unit) => Number(unit.gameUnitUID || 0)),
    ]);
    const key = String(unitUID || "");
    const preferred = pools.byUnitUID && pools.byUnitUID.get(key);
    const candidates = preferred ? [preferred] : pools.ordered || [];

    for (const pool of candidates) {
      for (const gameUnitUID of pool.gameUnitUIDs || []) {
        const numeric = Number(gameUnitUID);
        if (!Number.isInteger(numeric) || numeric <= 0 || used.has(numeric)) continue;
        dynamicGame.usedPooledGameUnitUIDs.add(numeric);
        return { gameUnitUID: numeric, unitID: pool.unitID || 0, pool };
      }
    }

    for (const gameUnitUID of pools.unassignedGameUnitUIDs || []) {
      const numeric = Number(gameUnitUID);
      if (!Number.isInteger(numeric) || numeric <= 0 || used.has(numeric)) continue;
      dynamicGame.usedPooledGameUnitUIDs.add(numeric);
      return { gameUnitUID: numeric, unitID: 0, pool: null };
    }
    return null;
  }

  function nextDeckSyncIndexForBattleState(battleState) {
    const count = Number(battleState.deployCount || 0);
    battleState.deployCount = count + 1;
    return count % 4;
  }

  function initBattleSimulator(replay) {
    if (replay.battleSim) return replay.battleSim;
    const respawn = replay.lastRespawnReq || {};
    const startTime = Number(respawn.gameTime || replay.syntheticGameTime || 10);
    replay.battleSim = {
      tick: 0,
      gameTime: Math.max(4, startTime),
      absoluteGameTime: Math.max(4, startTime),
      remainGameTime: Math.max(1, 180 - startTime),
      nextPlayerGameUnitUID: 4,
      playerUnitCount: 0,
      waveId: 1,
      gameState: 3,
      finishSent: false,
      resultDelayTicks: 0,
      spawnGroupIndex: 0,
      spawnGroups:
        replay.dynamicGame && replay.dynamicGame.deployableGameUnitUIDGroups
          ? replay.dynamicGame.deployableGameUnitUIDGroups.map((group) => group.slice())
          : dynamicBattleGameUnitGroups.map((group) => group.slice()),
      respawnCostA1: 10,
      respawnCostB1: 10,
      respawnCostAssistA1: 0,
      respawnCostAssistB1: 0,
      usedRespawnCostA1: 0,
      usedRespawnCostB1: 0,
      pendingDeckSyncs: [],
      pendingDieUnitUIDs: [],
      pendingGameStates: [{ state: 3, winTeam: 0, waveId: 1 }],
      finished: false,
      win: false,
      targetHp: 2800,
      targetMaxHp: 2800,
      targetUID: 2,
      targetX: 1180,
      units: [],
    };
    return replay.battleSim;
  }

  function getBattleSpawnGroup(sim) {
    const configured = (sim.spawnGroups || [])[sim.spawnGroupIndex] || [];
    sim.spawnGroupIndex += 1;
    if (configured.length > 0) return configured.filter((uid) => !sim.units.some((unit) => unit.gameUnitUID === uid));
    const first = Math.max(10, sim.nextPlayerGameUnitUID || 10);
    sim.nextPlayerGameUnitUID = first + 1;
    return [first];
  }

  function createBattlePlayerUnit(gameUnitUID, sourceUnitUID, x, z) {
    return {
      gameUnitUID,
      sourceUnitUID,
      hp: defaultDeployedUnitHp,
      maxHp: defaultDeployedUnitHp,
      x,
      z,
      right: true,
      stateId: 13,
      stateChangeCount: 0,
      speedX: 140,
      speedCurrent: 0,
      attackRange: 95,
      attackDamage: 360,
      attackCooldown: 1.05,
      attackTimer: 0.25,
      hitFrame: 0.35,
      hitDone: false,
      attackStateTime: 0,
      cost: 4,
      spawnGrace: 0.35,
      alive: true,
      respawn: true,
      team: 1,
      playState: 1,
      deadSynced: false,
      dyingFrames: 0,
      targetUID: 0,
      subTargetUID: 0,
      seed: 51,
    };
  }

  return {
    handleDeploy,
    deployRuntimeBattleUnit,
    enrichBattleStateUnitsFromPlayerDeck,
    consumePooledGameUnitUIDForDeploy,
    nextDeckSyncIndexForBattleState,
    initBattleSimulator,
    getBattleSpawnGroup,
    createBattlePlayerUnit,
  };
}

module.exports = {
  createDeployHandler,
};
