const syncBuilder = require("./syncBuilder");
const { createTickEngine } = require("./tick");
const { createBattleStateManager, buildCapturedRespawnUnitPools } = require("./battleState");
const { createDeployHandler } = require("./deploy");
const { createCsharpCombatHost } = require("./csharpHost");

// Combat handler facade.
//
// cs-listener.js owns sockets, encryption, packet ordering, and captured-flow
// routing. This facade owns combat state and tells the listener which combat
// payloads to send.

function createCombatHandler(options = {}) {
  const constants = options.constants || {};
  const config = options.config || {};
  const csharpHost = createCsharpCombatHost({
    enabled: Boolean(config.CSHARP_COMBAT_HOST),
    projectPath: config.CSHARP_COMBAT_HOST_PROJECT,
    dllPath: config.CSHARP_COMBAT_HOST_DLL,
    timeoutMs: config.CSHARP_COMBAT_HOST_TIMEOUT_MS,
    managedDir: config.COUNTERSIDE_MANAGED_DIR,
    gameplayTablesDir: config.GAMEPLAY_TABLES_DIR,
    modTablesDir: config.MOD_TABLES_DIR,
    contentsTags: config.CONTENTS_TAGS,
    dotnetPath: config.CSHARP_COMBAT_HOST_DOTNET,
    responseBufferBytes: config.CSHARP_COMBAT_HOST_RESPONSE_BUFFER_BYTES,
    syncIntervalSeconds: Number(config.MANAGED_HOST_TICK_INTERVAL_MS || 33) / 1000,
    defaultUnitDamage: options.defaultCombatStats && options.defaultCombatStats.damage,
    defaultUnitAttackRange: options.defaultCombatStats && options.defaultCombatStats.attackRange,
    defaultUnitMoveSpeed: options.defaultCombatStats && options.defaultCombatStats.moveSpeed,
    defaultUnitAttackCooldown: options.defaultCombatStats && options.defaultCombatStats.attackCooldown,
    staticUnitDamage: options.staticCombatStats && options.staticCombatStats.damage,
    staticUnitAttackRange: options.staticCombatStats && options.staticCombatStats.attackRange,
    staticUnitAttackCooldown: options.staticCombatStats && options.staticCombatStats.attackCooldown,
    defaultDeployedUnitHp: options.defaultDeployedUnitHp,
  });
  let csharpWarningPrinted = false;
  const modUnitIds = String(process.env.CS_MOD_UNIT_IDS || "").split(",").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  if (csharpHost.enabled) {
    const warmup = csharpHost.request("warmup", {});
    if (warmup.ok) {
      console.log(`[combat-host] warmup ok host=${csharpHost.hostPath}`);
      if (modUnitIds.length) {
        const validation = csharpHost.request("validateUnitTemplets", { unitIds: modUnitIds });
        if (!validation.ok) throw new Error(`[combat-host] ${validation.error || "active mod units were not loaded"}`);
        console.log(`[combat-host] ${validation.summary}`);
      }
    } else {
      if (modUnitIds.length) throw new Error(`[combat-host] active unit mods require a working managed host: ${warmup.error || "warmup failed"}`);
      warnCsharpFallback(warmup.error);
    }
  } else if (modUnitIds.length) {
    throw new Error("[combat-host] active unit mods require the managed combat host");
  }
  const tickEngine = createTickEngine({
    combatStateId: options.combatStateId,
    defaultCombatStats: options.defaultCombatStats,
    staticCombatStats: options.staticCombatStats,
    gameplayUnitStats: options.gameplayUnitStats,
  });
  const stateManager = createBattleStateManager({
    tick: tickEngine,
    capturedGameFlow: options.capturedGameFlow,
    capturedRespawnUnitPools: options.capturedRespawnUnitPools,
    parseCapturedGameSyncPayload: options.parseCapturedGameSyncPayload,
    extractGameLoadUnitPools: options.extractGameLoadUnitPools,
    dynamicBattleGameUnitGroups: config.DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
    makeDynamicGameUid: options.makeDynamicGameUid,
    mapIdForStageDungeon: options.mapIdForStageDungeon,
  });
  const deployHandler = createDeployHandler({
    tick: tickEngine,
    syncBuilder,
    combatStateId: options.combatStateId,
    defaultDeployedUnitHp: options.defaultDeployedUnitHp,
    dynamicBattleGameUnitGroups: config.DYNAMIC_BATTLE_GAME_UNIT_GROUPS,
  });

  function startBattle(initialData) {
    const forceJsFallback = shouldUseJsBattleFallback(initialData);
    if (!forceJsFallback && csharpHost.enabled && initialData && initialData.replay && initialData.req) {
      const gameUID =
        initialData.gameUID ||
        (typeof options.makeDynamicGameUid === "function" ? options.makeDynamicGameUid() : BigInt(Date.now()) * 10000n);
      const response = csharpHost.request("startBattle", {
        req: initialData.req,
        stage: initialData.stage || {},
        gameUID: String(gameUID),
        gameLoadAckPayloadBase64: initialData.gameLoadAckPayloadBase64 || "",
      });
      if (response.ok && response.dynamicGame && response.battleState && response.dynamicGame.managedCombat && response.payload) {
        initialData.replay.dynamicGame = response.dynamicGame;
        initialData.replay.battleState = response.battleState;
        initialData.replay.dynamicGame.gameUID = gameUID;
        initialData.replay.dynamicGame.playerDeck = (initialData.stage && initialData.stage.playerDeck) || null;
        initialData.replay.battleState.gameUID = gameUID;
        initialData.replay.tutorialReplayPhase = "dynamic";
        initialData.replay.syntheticGameTime = Number(response.battleState.gameTime || 4);
        initialData.replay.dynamicBattleResultSent = false;
        initialData.replay.managedGameLoadAckPayload = response.payload || null;
        console.log(
          `[combat-host] startBattle ok stageID=${response.dynamicGame.stageID} dungeonID=${response.dynamicGame.dungeonID} session=${response.dynamicGame.managedSessionId || ""} payloadSize=${response.payload.length}`
        );
        return response.dynamicGame;
      }
      warnCsharpFallback(response.error || "managed local server did not return GAME_LOAD_ACK");
    }
    return stateManager.startBattle(initialData);
  }

  function attachGameLoadUnitPools(replay, activeStage, payload) {
    return stateManager.attachGameLoadUnitPools(replay, activeStage, payload);
  }

  function handleDeploy(request) {
    const replay = request && request.replay;
    if (csharpHost.enabled && replay && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat && request.req) {
      const response = csharpHost.request("handleDeploy", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
        req: request.req,
      });
      if (response.ok && response.deployed && response.deployed.handled) {
        applyHostState(replay, response);
        mirrorManagedDeployToBattleState(replay, request.req);
        const ack = (response.packets || []).find((packet) => packet.packetId === 817);
        const sync = (response.packets || []).find((packet) => packet.packetId === 822);
        const packets = (response.packets || [])
          .filter((packet) => packet && packet.packetId && packet.payload)
          .map((packet) => toListenerPacket(packet, "managed-deploy"));
        return {
          handled: true,
          mode: response.deployed.mode || "battleState",
          deployed: response.deployed.unit || null,
          spawned: response.deployed.spawned || null,
          packets,
          ackPayload: ack && ack.payload,
          syncPayload: sync && sync.payload,
        };
      }
      if (replay.dynamicGame && replay.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed deploy failed: ${summarizeHostError(response.error)}`);
        return { handled: false, error: response.error || "managed deploy failed" };
      }
      warnCsharpFallback(response.error);
    }
    return deployHandler.handleDeploy(replay, request && request.req);
  }

  function handlePause(request = {}) {
    const replay = request.replay;
    const req = request.req;
    if (!replay || !req) return { handled: false };
    if (csharpHost.enabled && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request("handlePause", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
        req,
      });
      if (response.ok) {
        applyHostState(replay, response);
        const packets = (response.packets || [])
          .filter((packet) => packet && packet.packetId && packet.payload)
          .map((packet) => toListenerPacket(packet, "managed-pause"));
        return {
          handled: true,
          packets,
          ackPayload: packets.find((packet) => packet.packetId === 813)?.payload || null,
        };
      }
      console.log(`[combat-host] managed pause failed: ${summarizeHostError(response.error)}`);
      return { handled: false };
    }
    return { handled: false };
  }

  function handleUnitSkill(request = {}) {
    return handleManagedSkill("handleUnitSkill", request, "managed-unit-skill");
  }

  function handleShipSkill(request = {}) {
    return handleManagedSkill("handleShipSkill", request, "managed-ship-skill");
  }

  function handleManagedSkill(command, request, fallbackLabel) {
    const replay = request.replay;
    const req = request.req;
    if (!replay || !req) return { handled: false };
    if (csharpHost.enabled && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request(command, {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
        req,
      });
      if (response.ok) {
        applyHostState(replay, response);
        const packets = (response.packets || [])
          .filter((packet) => packet && packet.packetId && packet.payload)
          .map((packet) => toListenerPacket(packet, fallbackLabel));
        return {
          handled: true,
          mode: "managed-local-server",
          packets,
        };
      }
      console.log(`[combat-host] ${command} failed: ${summarizeHostError(response.error)}`);
      return { handled: false, error: response.error || `${command} failed` };
    }
    return { handled: false };
  }

  function tick(delta, battleState) {
    return tickEngine.continueBattleStateUnits(battleState, delta);
  }

  function buildSync(data = {}) {
    const defaultDelta = defaultSyncDelta(data.dynamicGame);
    if (csharpHost.enabled && data.battleState && data.dynamicGame && data.dynamicGame.managedCombat) {
      const response = csharpHost.request("buildSync", {
        dynamicGame: data.dynamicGame,
        battleState: data.battleState,
        delta: data.delta == null ? defaultDelta : Number(data.delta),
        skipSimulation: Boolean(data.skipSimulation),
      });
      if (response.ok) {
        if (response.battleState) replaceMutable(data.battleState, response.battleState);
        return response.payload || null;
      }
      if (data.dynamicGame && data.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed sync failed: ${summarizeHostError(response.error)}`);
        return null;
      }
      warnCsharpFallback(response.error);
    }
    return syncBuilder.buildGameSync(data, { continueBattleStateUnits: tickEngine.continueBattleStateUnits });
  }

  function buildSyncPackets(data = {}) {
    const defaultDelta = defaultSyncDelta(data.dynamicGame);
    if (csharpHost.enabled && data.battleState && data.dynamicGame && data.dynamicGame.managedCombat) {
      const response = csharpHost.request("buildSync", {
        dynamicGame: data.dynamicGame,
        battleState: data.battleState,
        delta: data.delta == null ? defaultDelta : Number(data.delta),
        skipSimulation: Boolean(data.skipSimulation),
      });
      if (response.ok) {
        if (response.battleState) replaceMutable(data.battleState, response.battleState);
        if (Array.isArray(response.packets) && response.packets.length > 0) {
          return response.packets
            .filter((packet) => packet && packet.packetId && packet.payload)
            .map((packet) => toListenerPacket(packet, "managed-sync"));
        }
        if (response.payload) {
          return [{ packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT, payload: response.payload, label: "managed-sync" }];
        }
        return [];
      }
      if (data.dynamicGame && data.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed sync packets failed: ${summarizeHostError(response.error)}`);
        return [];
      }
      warnCsharpFallback(response.error);
    }
    const payload = buildSync(data);
    return payload ? [{ packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT, payload, label: "dynamic-game-sync" }] : [];
  }

  function buildInitialSync(replay) {
    if (csharpHost.enabled && replay && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request("buildInitialSync", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
      });
      if (response.ok && response.payload) {
        applyHostState(replay, response);
        return response.payload;
      }
      warnCsharpFallback(response.error);
    }
    return syncBuilder.buildInitialBattleSync(replay, { continueBattleStateUnits: tickEngine.continueBattleStateUnits });
  }

  function buildInitialPackets(replay) {
    if (csharpHost.enabled && replay && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request("buildInitialSync", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
      });
      if (response.ok) {
        applyHostState(replay, response);
        if (Array.isArray(response.packets) && response.packets.length > 0) {
          return response.packets
            .filter((packet) => packet && packet.packetId && packet.payload)
            .map((packet) => toListenerPacket(packet, "managed-initial"));
        }
        if (response.payload) {
          return [{ packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT, payload: response.payload, label: "managed-initial-sync" }];
        }
      }
      if (replay.dynamicGame && replay.dynamicGame.managedCombat) {
        console.log(`[combat-host] managed initial packets failed: ${summarizeHostError(response.error)}`);
        return [];
      }
      warnCsharpFallback(response.error);
    }
    const payload = buildInitialSync(replay);
    return payload ? [{ packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT, payload, label: "dynamic-game-sync" }] : [];
  }

  function buildRespawnAck(data = {}) {
    if (csharpHost.enabled) {
      const response = csharpHost.request("buildRespawnAck", {
        unitUID: data.unitUID,
        assistUnit: Boolean(data.assistUnit),
      });
      if (response.ok && response.payload) return response.payload;
      warnCsharpFallback(response.error);
    }
    return syncBuilder.buildRespawnAck(data);
  }

  function buildGameRespawnAckPayload(unitUID, assistUnit) {
    return buildRespawnAck({ unitUID, assistUnit });
  }

  function mergeJoinLobbyAck(officialPayload, localPayload, options = {}) {
    if (!csharpHost.enabled) {
      return { ok: false, error: "C# combat host disabled" };
    }
    const response = csharpHost.request("mergeJoinLobbyAck", {
      officialPayloadBase64: Buffer.from(officialPayload || Buffer.alloc(0)).toString("base64"),
      localPayloadBase64: Buffer.from(localPayload || Buffer.alloc(0)).toString("base64"),
      copyIntervalData: Boolean(options.copyIntervalData),
      replaceIntervalData: Boolean(options.replaceIntervalData),
      excludeIntervalStrKeys: Array.isArray(options.excludeIntervalStrKeys)
        ? options.excludeIntervalStrKeys.map((key) => String(key || "")).filter(Boolean)
        : [],
      preserveIntervalStrKeys: Array.isArray(options.preserveIntervalStrKeys)
        ? options.preserveIntervalStrKeys.map((key) => String(key || "")).filter(Boolean)
        : [],
      mergeIntervalStrKeys: Array.isArray(options.mergeIntervalStrKeys)
        ? options.mergeIntervalStrKeys.map((key) => String(key || "")).filter(Boolean)
        : [],
      filterInactiveEventIntervals: Boolean(options.filterInactiveEventIntervals),
      preserveOfficialContractData: Boolean(options.preserveOfficialContractData),
      overlayLocalContractData: Boolean(options.overlayLocalContractData),
    });
    if (!response.ok || !response.payload) {
      return { ok: false, error: response.error || "managed lobby merge failed" };
    }
    return {
      ok: true,
      payload: response.payload,
      packetType: response.packetType,
      serializedPayloadSize: response.serializedPayloadSize,
    };
  }

  function normalizeJoinLobbyAck(localPayload) {
    if (!csharpHost.enabled) {
      return { ok: false, error: "C# combat host disabled" };
    }
    const response = csharpHost.request("normalizeJoinLobbyAck", {
      localPayloadBase64: Buffer.from(localPayload || Buffer.alloc(0)).toString("base64"),
    });
    if (!response.ok || !response.payload) {
      return { ok: false, error: response.error || "managed lobby normalize failed" };
    }
    return {
      ok: true,
      payload: response.payload,
      packetType: response.packetType,
      serializedPayloadSize: response.serializedPayloadSize,
    };
  }

  function extractJoinLobbyProfile(officialPayload) {
    if (!csharpHost.enabled) {
      return { ok: false, error: "C# combat host disabled" };
    }
    const response = csharpHost.request("extractJoinLobbyProfile", {
      packetId: 205,
      payloadBase64: Buffer.from(officialPayload || Buffer.alloc(0)).toString("base64"),
    });
    if (!response.ok || !response.officialProfile) {
      return { ok: false, error: response.error || "managed lobby profile extraction failed" };
    }
    return {
      ok: true,
      profile: response.officialProfile,
      packetType: response.packetType,
      serializedPayloadSize: response.serializedPayloadSize,
      summary: response.summary || "",
    };
  }

  function buildSyntheticGameSyncPayload(gameTime) {
    if (csharpHost.enabled) {
      const response = csharpHost.request("buildSyntheticSync", { gameTime: Number(gameTime || 0) });
      if (response.ok && response.payload) return response.payload;
      warnCsharpFallback(response.error);
    }
    return syncBuilder.buildSyntheticGameSyncPayload(gameTime);
  }

  function startBattleLoop(socket, label, callbacks = {}) {
    const replay = socket.session && socket.session.gameReplay;
    if (!replay || replay.dynamicBattleTimer || !config.DYNAMIC_BATTLE_MANAGER) return false;
    const syncInterval =
      replay.dynamicGame && replay.dynamicGame.managedCombat
        ? Number(config.MANAGED_HOST_TICK_INTERVAL_MS || 33)
        : Number(config.DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
    const managedCombat = Boolean(replay.dynamicGame && replay.dynamicGame.managedCombat);
    const primeFrames = managedCombat ? Math.max(1, Number(config.MANAGED_HOST_PRIME_FRAMES || 1)) : 1;
    console.log(`[battle-manager:${label}] started interval=${syncInterval}ms`);
    let lastPumpAt = Date.now();
    let firstPump = true;

    function sendPumpedPackets(packets, pumpOptions = {}) {
      const endIndex = packets.findIndex((packet) => packet && packet.packetId === constants.GAME_END_NOT);
      const outboundPackets = (endIndex >= 0 ? packets.slice(0, endIndex + 1) : packets).filter(
        (packet) => packet && packet.packetId && packet.payload
      );
      const outboundEndIndex = outboundPackets.findIndex((packet) => packet && packet.packetId === constants.GAME_END_NOT);
      const quietManagedBurst =
        managedCombat && pumpOptions.dropQuietManagedSync && isQuietManagedSyncBurst(outboundPackets, constants);
      if (quietManagedBurst) {
        return { running: true, sent: false, quiet: true };
      }
      const canCork = typeof socket.cork === "function" && typeof socket.uncork === "function";
      if (canCork) socket.cork();
      try {
        for (const packet of outboundPackets) {
          callbacks.sendGamePacket(socket, packet.packetId, packet.payload, packet.label || "battle-manager-sync", packet);
        }
      } finally {
        if (canCork) socket.uncork();
      }
      if (outboundEndIndex >= 0) {
        replay.dynamicBattleResultSent = true;
        if (replay.dynamicBattleTimer) clearTimeout(replay.dynamicBattleTimer);
        replay.dynamicBattleTimer = null;
        if (typeof callbacks.onGameEndPacketSent === "function") {
          callbacks.onGameEndPacketSent(socket);
        }
        console.log("[battle-manager] managed combat emitted GAME_END_NOT; stopped sync loop");
        return { running: false, sent: outboundPackets.length > 0 };
      }
      const finishedState = replay.battleState && replay.battleState.finished ? replay.battleState : null;
      if (finishedState && finishedState.finished && !replay.dynamicBattleResultSent) {
        replay.dynamicBattleResultSent = true;
        if (replay.dynamicBattleTimer) clearTimeout(replay.dynamicBattleTimer);
        replay.dynamicBattleTimer = null;
        const resultSent =
          typeof callbacks.sendBattleResult === "function"
            ? callbacks.sendBattleResult(socket, finishedState) === true
            : false;
        console.log(
          `[battle-manager] result=${finishedState.win ? "win" : "loss"} gameTime=${Number(
            finishedState.gameTime || 0
          ).toFixed(2)}`
        );
        return { running: false, sent: outboundPackets.length > 0 || resultSent };
      }
      return { running: true, sent: outboundPackets.length > 0 };
    }

    const pump = (pumpOptions = {}) => {
      if (socket.destroyed) {
        if (typeof callbacks.stopTimers === "function") callbacks.stopTimers(socket);
        return { running: false, sent: false };
      }
      const now = Date.now();
      const elapsedSeconds = firstPump ? syncInterval / 1000 : (now - lastPumpAt) / 1000;
      firstPump = false;
      lastPumpAt = now;
      // Managed combat uses wall-clock delta so C# reflection/serialization
      // stalls do not make the server simulation trail the client. The host
      // splits this into normal managed frames and drains packets per frame.
      const delta = managedCombat
        ? clampValue(elapsedSeconds, 0.001, defaultSyncDelta(replay.dynamicGame) * 3)
        : clampValue(elapsedSeconds, 0.001, 0.25);
      const packets =
        replay.battleState && replay.dynamicGame
          ? buildSyncPackets({ dynamicGame: replay.dynamicGame, battleState: replay.battleState, delta })
          : [
              {
                packetId: constants.NPT_GAME_SYNC_DATA_PACK_NOT,
                payload: buildBattleSimSyncPayload(replay, delta),
                label: "battle-manager-sync",
              },
            ];
      return sendPumpedPackets(packets, pumpOptions);
    };
    for (let index = 0; index < primeFrames; index += 1) {
      const result = pump({ dropQuietManagedSync: managedCombat && index < primeFrames - 1, sync: true });
      if (!result.running) return true;
      if (result.sent) break;
    }
    const scheduleNextPump = () => {
      if (!replay.dynamicBattleTimer || socket.destroyed) return;
      replay.dynamicBattleTimer = setTimeout(() => {
        const result = pump();
        if (result.running) scheduleNextPump();
      }, syncInterval);
      if (typeof replay.dynamicBattleTimer.unref === "function") replay.dynamicBattleTimer.unref();
    };
    replay.dynamicBattleTimer = true;
    scheduleNextPump();
    return true;
  }

  function defaultSyncDelta(dynamicGame) {
    const intervalMs =
      dynamicGame && dynamicGame.managedCombat
        ? Number(config.MANAGED_HOST_TICK_INTERVAL_MS || 33)
        : Number(config.DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33);
    return clampValue(intervalMs / 1000, 0.001, 0.25);
  }

  function clampValue(value, min, max) {
    return Math.min(max, Math.max(min, Number(value)));
  }

  function isQuietManagedSyncBurst(packets, packetConstants) {
    const outbound = (packets || []).filter((packet) => packet && packet.packetId && packet.payload);
    if (outbound.length === 0) return true;
    return outbound.every(
      (packet) =>
        packet.packetId === packetConstants.NPT_GAME_SYNC_DATA_PACK_NOT &&
        Buffer.isBuffer(packet.payload) &&
        packet.payload.length <= 64
    );
  }

  function transitionTutorialReplayToDynamic(replay, endIndex) {
    return stateManager.transitionTutorialReplayToDynamic(replay, endIndex);
  }

  function isFinished(replayOrState) {
    const state = replayOrState && replayOrState.battleState ? replayOrState.battleState : replayOrState;
    return Boolean(state && state.finished);
  }

  function getResult(replayOrState) {
    const state = replayOrState && replayOrState.battleState ? replayOrState.battleState : replayOrState;
    if (!state || !state.finished) return null;
    return { win: Boolean(state.win), gameTime: Number(state.gameTime || 0), state };
  }

  function buildBattleSimSyncPayload(replay, delta) {
    const sim = deployHandler.initBattleSimulator(replay);
    if (sim.finished && sim.finishSent) {
      return buildSync({ gameTime: sim.gameTime, absoluteGameTime: sim.absoluteGameTime, baseEntries: [] });
    }

    sim.tick += 1;
    sim.gameTime += delta;
    sim.absoluteGameTime += delta;
    sim.remainGameTime = Math.max(0, sim.remainGameTime - delta);
    sim.respawnCostA1 = tickEngine.clamp(sim.respawnCostA1 + delta * 0.8, 0, 10);
    sim.respawnCostB1 = tickEngine.clamp(sim.respawnCostB1 + delta * 0.8, 0, 10);

    const livePlayers = sim.units.filter((unit) => unit.team === 1 && unit.alive);
    for (const unit of livePlayers) advanceBattleUnit(sim, unit, delta);

    settleBattleOutcome(sim);

    const visibleUnits = sim.units
      .filter((unit) => unit.alive || unit.playState === 2)
      .map((unit) => {
        const respawn = unit.respawn;
        unit.respawn = false;
        const speedSign = unit.right ? 1 : -1;
        return {
          ...unit,
          respawn,
          hp: Math.max(0, unit.hp),
          speedX: Math.abs(unit.speedCurrent || 0),
          savedPosX: unit.x,
          right: unit.right,
          targetUID: unit.targetUID || 0,
          playState: unit.playState == null ? 1 : unit.playState,
          damageSpeedXNegative: speedSign < 0,
        };
      });

    for (const unit of sim.units) {
      if (unit.playState === 2) {
        unit.dyingFrames = (unit.dyingFrames || 0) + 1;
        if (unit.dyingFrames >= 2 && !unit.deadSynced) {
          unit.deadSynced = true;
          unit.playState = 0;
          sim.pendingDieUnitUIDs.push(unit.gameUnitUID);
        }
      }
    }

    const base = syncBuilder.buildGameSyncDataBase({
      gameTime: sim.gameTime,
      remainGameTime: sim.remainGameTime,
      respawnCostA1: sim.respawnCostA1,
      respawnCostB1: sim.respawnCostB1,
      respawnCostAssistA1: sim.respawnCostAssistA1,
      respawnCostAssistB1: sim.respawnCostAssistB1,
      usedRespawnCostA1: sim.usedRespawnCostA1,
      usedRespawnCostB1: sim.usedRespawnCostB1,
      dieUnits: sim.pendingDieUnitUIDs.length ? [sim.pendingDieUnitUIDs.splice(0)] : [],
      units: visibleUnits,
      decks: sim.pendingDeckSyncs.splice(0),
      gameStates: sim.pendingGameStates.splice(0),
    });

    if (sim.tick % 10 === 0 && !sim.finished) {
      const players = sim.units.filter((unit) => unit.team === 1 && unit.alive).length;
      console.log(`[battle-manager] t=${sim.gameTime.toFixed(1)} players=${players} targetHp=${sim.targetHp.toFixed(0)}`);
    }

    return buildSync({ gameTime: sim.gameTime, absoluteGameTime: sim.absoluteGameTime, baseEntries: [base] });
  }

  function advanceBattleUnit(sim, unit, delta) {
    if (unit.spawnGrace > 0) {
      unit.spawnGrace = Math.max(0, unit.spawnGrace - delta);
      tickEngine.setBattleUnitState(unit, 13);
      unit.speedCurrent = 0;
      return;
    }

    unit.attackTimer = Math.max(0, Number(unit.attackTimer || 0) - delta);
    unit.attackStateTime = Math.max(0, Number(unit.attackStateTime || 0) - delta);
    const target = sim.targetHp > 0 ? { gameUnitUID: sim.targetUID, x: sim.targetX } : null;
    unit.targetUID = target ? target.gameUnitUID : 0;
    if (!target) {
      unit.speedCurrent = 0;
      tickEngine.setBattleUnitState(unit, 12);
      return;
    }

    const dir = target.x >= unit.x ? 1 : -1;
    unit.right = dir >= 0;
    const distance = Math.abs(target.x - unit.x);
    if (distance > unit.attackRange) {
      const step = Math.min(unit.speedX * delta, distance - unit.attackRange);
      unit.speedCurrent = dir * unit.speedX;
      unit.x += dir * step;
      tickEngine.setBattleUnitState(unit, 13);
      unit.hitDone = false;
      return;
    }

    unit.speedCurrent = 0;
    if (unit.attackTimer <= 0) {
      unit.attackTimer = unit.attackCooldown;
      unit.attackStateTime = Math.max(unit.hitFrame + 0.1, unit.attackCooldown * 0.55);
      unit.hitDone = false;
      tickEngine.setBattleUnitState(unit, 45);
    }

    if (!unit.hitDone && unit.attackCooldown - unit.attackTimer >= unit.hitFrame) {
      unit.hitDone = true;
      sim.targetHp = Math.max(0, sim.targetHp - unit.attackDamage);
    }

    if (unit.attackStateTime <= 0 && unit.attackTimer > 0) {
      tickEngine.setBattleUnitState(unit, 12);
    }
  }

  function settleBattleOutcome(sim) {
    if (sim.finished) return;
    const livePlayers = sim.units.filter((unit) => unit.team === 1 && unit.alive);
    if (livePlayers.some((unit) => unit.x >= 1460) || (sim.targetHp <= 0 && livePlayers.length > 0)) {
      finishBattle(sim, true);
    } else if (sim.remainGameTime <= 0 || (sim.playerUnitCount > 0 && livePlayers.length === 0)) {
      finishBattle(sim, false);
    }
  }

  function finishBattle(sim, win) {
    sim.finished = true;
    sim.finishSent = true;
    sim.win = Boolean(win);
    sim.gameState = 4;
    sim.pendingGameStates.push({ state: 4, winTeam: win ? 1 : 3, waveId: sim.waveId });
  }

  function deployStageLineup(replay) {
    if (csharpHost.enabled && replay && replay.battleState && replay.dynamicGame && replay.dynamicGame.managedCombat) {
      const response = csharpHost.request("deployStageLineup", {
        dynamicGame: replay.dynamicGame,
        battleState: replay.battleState,
      });
      if (response.ok && response.deployed) {
        applyHostState(replay, response);
        return response.deployed.spawned || [];
      }
      warnCsharpFallback(response.error);
    }
    return stateManager.deployStageLineup(replay);
  }

  function applyHostState(replay, response) {
    if (!replay || !response) return;
    if (response.dynamicGame) {
      if (replay.dynamicGame) replaceMutable(replay.dynamicGame, response.dynamicGame);
      else replay.dynamicGame = response.dynamicGame;
    }
    if (response.battleState) {
      if (replay.battleState) replaceMutable(replay.battleState, response.battleState);
      else replay.battleState = response.battleState;
      deployHandler.enrichBattleStateUnitsFromPlayerDeck(replay);
    }
  }

  function toListenerPacket(packet, fallbackLabel) {
    const output = {
      packetId: packet.packetId,
      payload: packet.payload,
      label: packet.label || fallbackLabel,
    };
    const battleWin = packet.battleWin ?? packet.BattleWin;
    const battleWinTeam = packet.battleWinTeam ?? packet.BattleWinTeam;
    const battleRecords = packet.battleRecords || packet.BattleRecords;
    const battlePlayTime = packet.battlePlayTime ?? packet.BattlePlayTime;
    const fiercePoint = packet.fiercePoint ?? packet.FiercePoint;
    const fiercePenaltyPoint = packet.fiercePenaltyPoint ?? packet.FiercePenaltyPoint;
    if (battleWin != null) {
      output.battleWin = battleWin;
    }
    if (battleWinTeam != null) {
      output.battleWinTeam = battleWinTeam;
    }
    if (battlePlayTime != null) {
      output.battlePlayTime = battlePlayTime;
    }
    if (fiercePoint != null) {
      output.fiercePoint = fiercePoint;
    }
    if (fiercePenaltyPoint != null) {
      output.fiercePenaltyPoint = fiercePenaltyPoint;
    }
    if (Array.isArray(battleRecords) && battleRecords.length > 0) {
      output.battleRecords = battleRecords;
    }
    return output;
  }

  function replaceMutable(target, source) {
    if (!target || !source) return source;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, source);
    return target;
  }

  function mirrorManagedDeployToBattleState(replay, req) {
    const battleState = replay && replay.battleState;
    if (!battleState || !req || !Array.isArray(battleState.units)) return;
    const unitUID = String(req.unitUID || "");
    if (unitUID && battleState.units.some((unit) => String(unit.sourceUnitUID || "") === unitUID && !unit.pendingRemove)) return;
    deployHandler.deployRuntimeBattleUnit(replay, req);
  }

  function warnCsharpFallback(error) {
    if (csharpWarningPrinted) return;
    csharpWarningPrinted = true;
    console.log(
      `[combat-host] managed CounterSide local server unavailable; using fallback combat host${
        error ? `: ${summarizeHostError(error)}` : ""
      }`
    );
  }

  function shouldUseJsBattleFallback() {
    return false;
  }

  function summarizeHostError(error) {
    const lines = String(error || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      lines.find((line) => line.startsWith("---> System.")) ||
      lines.find((line) => line.startsWith("System.") && !line.includes("TargetInvocationException")) ||
      lines[0] ||
      "unknown error"
    ).replace(/^---> /, "");
  }

  return {
    startBattle,
    handleDeploy,
    handlePause,
    handleUnitSkill,
    handleShipSkill,
    tick,
    buildSync,
    buildGameSync: buildSync,
    buildGameSyncPackets: buildSyncPackets,
    buildInitialBattleSync: buildInitialSync,
    buildInitialBattlePackets: buildInitialPackets,
    buildRespawnAck,
    buildGameRespawnAckPayload,
    mergeJoinLobbyAck,
    normalizeJoinLobbyAck,
    extractJoinLobbyProfile,
    buildGameEndNot: syncBuilder.buildGameEndNot,
    buildSyntheticGameSyncPayload,
    initBattleSimulator: deployHandler.initBattleSimulator,
    startBattleLoop,
    isFinished,
    getResult,
    deployStageLineup,
    attachGameLoadUnitPools,
    describeRuntimeGameUnitPools: stateManager.describeRuntimeGameUnitPools,
    transitionTutorialReplayToDynamic,
    buildBattleSimSyncPayload,
  };
}

module.exports = {
  createCombatHandler,
  buildCapturedRespawnUnitPools,
};
