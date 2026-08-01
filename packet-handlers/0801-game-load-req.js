const { getTutorialStageForRequest, isTutorialDungeonId, isTutorialStageId, TUTORIAL_STAGE_CHAIN } = require("../stages/tutorialStage");
const { getMainStoryStageForRequest } = require("../stages/mainStoryStage");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const { eventDeckHasFreeShipSlot, eventDeckHasGivenUnitSlots, getEventDeckPlayerUnitSlots } = require("../modules/game-data");
const worldMap = require("../modules/world-map");

const NGT_DIVE = 5;

module.exports = {
  packetId: 801,
  name: "GAME_LOAD_REQ",
  handle(ctx, socket, packet) {
    ctx.logGameLoadReq(packet.payload);
    const req = ctx.decodeGameLoadReq(packet.payload);
    
    // Dimension Trimming Debug Logging - Start
    const isTrimRequest = req && (req.dungeonID > 0) && !req.stageID && !req.diveStageID && !req.palaceID && !req.fierceBossId && !req.exploreID;
    if (isTrimRequest) {
      console.log(`[TRIM:GAME_LOAD_REQ] === DIMENSION TRIM DUNGEON LOAD ===`);
      console.log(`[TRIM:GAME_LOAD_REQ] selectDeckIndex=${req.selectDeckIndex} dungeonID=${req.dungeonID}`);
      const user = socket.session && socket.session.user;
      if (user && user.army && user.army.decks && user.army.decks.normal) {
        console.log(`[TRIM:GAME_LOAD_REQ] Available decks:`);
        for (let i = 0; i < user.army.decks.normal.length; i++) {
          const deck = user.army.decks.normal[i];
          const unitUids = deck && Array.isArray(deck.unitUids) ? deck.unitUids : [];
          const validUnits = unitUids.filter(uid => {
            const bn = typeof uid === 'bigint' ? uid : (typeof uid === 'string' ? BigInt(uid || '0') : BigInt(uid || 0));
            return bn > 0n;
          });
          console.log(`[TRIM:GAME_LOAD_REQ]   deck[${i}]: hasUnits=${validUnits.length > 0} unitCount=${validUnits.length}/${unitUids.length} leaderIndex=${deck ? deck.leaderIndex : 'N/A'} shipUid=${deck ? deck.shipUid : 'N/A'} operatorUid=${deck ? deck.operatorUid : 'N/A'}`);
        }
        if (user.miscStage && user.miscStage.trim && user.miscStage.trim.current) {
          const trimState = user.miscStage.trim.current;
          console.log(`[TRIM:GAME_LOAD_REQ] Current trim state: trimId=${trimState.trimId} trimLevel=${trimState.trimLevel} nextDungeonId=${trimState.nextDungeonId}`);
        }
      }
    }
    // Dimension Trimming Debug Logging - End
    
    // Stage selection can arrive with a stale/captured dungeonID. Prefer the
    // selected stageID first so Act 2+ does not get pulled back into 1004.
    // Tutorial stages must come from tutorialStage.js, not the main-story catalog
    // wrapper, because that module carries the phase-specific tutorial runtime.
    const user = socket.session && socket.session.user;
    const requestedStageId = Number((req && req.stageID) || 0);
    const requestedDungeonId = Number((req && req.dungeonID) || 0);
    const requestedFierceBossId = Number((req && req.fierceBossId) || 0);
    const explicitTutorial = isTutorialStageId(requestedStageId) || isTutorialDungeonId(requestedDungeonId);
    const diveGameLoad = req && Number(req.diveStageID || 0) > 0 ? worldMap.prepareDiveGameLoad(user, req) : null;
    let stage = null;
    if (diveGameLoad) {
      const diveStage =
        (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest({ dungeonID: diveGameLoad.dungeonID }) : null) ||
        (ctx.getGenericStageForRequest
          ? ctx.getGenericStageForRequest({ stageID: requestedStageId, dungeonID: diveGameLoad.dungeonID })
          : null) ||
        {};
      req.stageID = Number(diveStage.stageId || requestedStageId || diveGameLoad.diveStageID || 0);
      req.dungeonID = diveGameLoad.dungeonID;
      req.gameType = NGT_DIVE;
      stage = {
        ...diveStage,
        stageId: req.stageID,
        dungeonID: diveGameLoad.dungeonID,
        gameType: NGT_DIVE,
        eventDeckId: 0,
        EventDeckId: 0,
        miscMode: "dive",
        diveStageID: diveGameLoad.diveStageID,
        diveDeckIndex: diveGameLoad.deckIndex,
        tutorial: false,
        cutsceneOnly: false,
      };
      console.log(
        `[game-load:dive] diveStageID=${diveGameLoad.diveStageID} dungeonID=${diveGameLoad.dungeonID} deck=${diveGameLoad.deckIndex}`
      );
    } else if (requestedFierceBossId > 0 && ctx.getGenericStageForRequest) {
      stage = ctx.getGenericStageForRequest(req);
    } else {
      stage = (explicitTutorial
        ? getTutorialStageForRequest({ stageID: requestedStageId, dungeonID: requestedDungeonId })
        : getMainStoryStageForRequest({ stageID: requestedStageId, dungeonID: 0 })) ||
        getMainStoryStageForRequest(req) ||
        getTutorialStageForRequest(req) ||
        (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest(req) : null);
    }
    
    // Dimension Trimming Debug Logging - Stage Resolution
    if (isTrimRequest && stage) {
      console.log(`[TRIM:GAME_LOAD_REQ] Stage resolved: stageId=${stage.stageId} dungeonID=${stage.dungeonID} gameType=${stage.gameType} miscMode=${stage.miscMode} eventDeckId=${stage.eventDeckId || 0} trimId=${stage.trimId || 0} trimLevel=${stage.trimLevel || 0} cutsceneOnly=${stage.cutsceneOnly}`);
    }
    
    if (requestedFierceBossId > 0) {
      if (stage) {
        console.log(
          `[game-load:fierce] bossId=${requestedFierceBossId} stageID=${stage.stageId || 0} dungeonID=${
            stage.dungeonID || 0
          } gameType=${stage.gameType || 0} mode=${stage.miscMode || ""} eventDeck=${
            stage.eventDeckId || stage.EventDeckId || 0
          } eventDeckData=${req && req.eventDeckData ? 1 : 0}`
        );
      } else {
        console.log(`[game-load:fierce] unresolved bossId=${requestedFierceBossId} dungeonID=${requestedDungeonId}`);
      }
    }
    if (stage) {
      req.stageID = stage.stageId;
      req.dungeonID = stage.dungeonID;
    }
    if (stage && stage.tutorial && user) {
      const expectedTutorialStage = getExpectedTutorialStageForUser(user);
      if (
        expectedTutorialStage &&
        (Number(stage.stageId) !== Number(expectedTutorialStage.stageId) ||
          Number(stage.dungeonID) !== Number(expectedTutorialStage.dungeonID))
      ) {
        const redirectedStage = getTutorialStageForRequest({
          stageID: expectedTutorialStage.stageId,
          dungeonID: expectedTutorialStage.dungeonID,
        });
        if (redirectedStage) {
          console.log(
            `[game-load:tutorial] redirect stageID=${stage.stageId} dungeonID=${stage.dungeonID} -> stageID=${redirectedStage.stageId} dungeonID=${redirectedStage.dungeonID}`
          );
          stage = redirectedStage;
          req.stageID = stage.stageId;
          req.dungeonID = stage.dungeonID;
        }
      }
    }
    if (socket.session && socket.session.gameReplay) {
      socket.session.gameReplay.lastGameLoadReq = {
        stageID: Number((req && req.stageID) || 0),
        dungeonID: Number((req && req.dungeonID) || 0),
      };
    }
    const eventDeckId = stage ? Number(stage.eventDeckId || stage.EventDeckId || 0) : 0;
    const usesEventDeck = eventDeckId > 0;
    const eventDeckPlayerUnitSlots = usesEventDeck ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
    const eventDeckAllowsPlayerUnits = eventDeckPlayerUnitSlots.length > 0;
    const usesHybridEventDeck = eventDeckAllowsPlayerUnits && eventDeckHasGivenUnitSlots(eventDeckId);
    let playerDeck = null;
    if (stage && !stage.cutsceneOnly) {
      if (stage.tutorial || (usesEventDeck && !eventDeckAllowsPlayerUnits)) {
        playerDeck = buildPlayerIdentityForGameLoad(user);
      } else if (eventDeckAllowsPlayerUnits) {
        const eventDeckSelection = req && req.eventDeckData ? req.eventDeckData : null;
        playerDeck =
          buildPlayerDeckForGameLoad(user, req, {
            allowedUnitSlots: eventDeckPlayerUnitSlots,
            slotUnitUids: eventDeckSelection && eventDeckSelection.units,
            shipUid: eventDeckSelection && eventDeckSelection.shipUid,
            operatorUid: eventDeckSelection && eventDeckSelection.operatorUid,
            leaderIndex: eventDeckSelection && eventDeckSelection.leaderIndex,
          }) || buildPlayerIdentityForGameLoad(user);
      } else {
        // Check if this is a trim dungeon and use trim-specific deck
        if (stage && stage.miscMode === "trim" && user && user.miscStages && user.miscStages.trim && user.miscStages.trim.current) {
          const trimState = user.miscStages.trim.current;
          const eventDeckList = trimState.eventDeckList || [];
          const currentPhaseIndex = trimState.currentPhaseIndex || 0;
          
          if (eventDeckList.length > currentPhaseIndex) {
            const eventDeck = eventDeckList[currentPhaseIndex];
            const unitCount = eventDeck.units ? Object.keys(eventDeck.units).length : 0;
            console.log(`[TRIM:GAME_LOAD_REQ] Using trim eventDeck phase ${currentPhaseIndex}/${eventDeckList.length}: units=${unitCount} shipUid=${eventDeck.shipUid} operatorUid=${eventDeck.operatorUid} leaderIndex=${eventDeck.leaderIndex}`);
            
            playerDeck = buildPlayerDeckForGameLoad(user, req, {
              slotUnitUids: eventDeck.units,
              shipUid: eventDeck.shipUid,
              operatorUid: eventDeck.operatorUid,
              leaderIndex: eventDeck.leaderIndex,
            }) || buildPlayerIdentityForGameLoad(user);
          } else {
            console.log(`[TRIM:GAME_LOAD_REQ] WARNING: No eventDeck for phase ${currentPhaseIndex}/${eventDeckList.length}, falling back to normal deck`);
            playerDeck = buildPlayerDeckForGameLoad(user, req) || buildPlayerIdentityForGameLoad(user);
          }
        } else {
          playerDeck = buildPlayerDeckForGameLoad(user, req) || buildPlayerIdentityForGameLoad(user);
        }
        
        // Dimension Trimming Debug Logging - Deck Building
        if (isTrimRequest) {
          if (playerDeck && playerDeck.units && playerDeck.units.length > 0) {
            console.log(`[TRIM:GAME_LOAD_REQ] PlayerDeck built successfully: deckType=${playerDeck.deckType} deckIndex=${playerDeck.deckIndex} unitCount=${playerDeck.units.length}`);
            console.log(`[TRIM:GAME_LOAD_REQ]   Units: ${playerDeck.units.map(u => `slot${u.slotIndex}:unitId${u.unitId}/uid${u.unitUid}`).join(', ')}`);
            console.log(`[TRIM:GAME_LOAD_REQ]   Leader: slot${playerDeck.leaderIndex} uid${playerDeck.leaderUnitUid}`);
            console.log(`[TRIM:GAME_LOAD_REQ]   Ship: id${playerDeck.shipUnitId}/uid${playerDeck.shipUid}`);
            console.log(`[TRIM:GAME_LOAD_REQ]   Operator: id${playerDeck.operatorId}/uid${playerDeck.operatorUid}`);
          } else {
            console.log(`[TRIM:GAME_LOAD_REQ] PlayerDeck is empty or identity-only (no units)`);
          }
        }
      }
    }
    if (playerDeck && !stage.tutorial && playerDeck.units && playerDeck.units.length) {
      console.log(
        `[game-load] selectedDeck deckType=${playerDeck.deckType} index=${playerDeck.deckIndex} ${
          usesEventDeck
            ? `eventDeck=${eventDeckId} playerSlots=${eventDeckPlayerUnitSlots.join("/") || "none"} source=${
                req && req.eventDeckData ? "eventDeckData" : "deck"
              } `
            : ""
        }units=${playerDeck.units
          .map((unit) => `${unit.slotIndex}:${unit.unitId}/${unit.unitUid}`)
          .join(",")} leader=${playerDeck.leaderIndex}:${playerDeck.leaderUnitUid} ship=${playerDeck.shipUnitId}/${
          playerDeck.shipUid
        } operator=${playerDeck.operatorId}/${playerDeck.operatorUid}`
      );
    } else if (stage && usesEventDeck) {
      console.log(`[game-load] eventDeck=${stage.eventDeckId || stage.EventDeckId} stageID=${stage.stageId} dungeonID=${stage.dungeonID}`);
    }
    const activeStage =
      stage && !stage.cutsceneOnly
        ? {
            ...stage,
            eventDeckFreeUnitSlots: eventDeckPlayerUnitSlots,
            usesHybridEventDeck,
            eventDeckFreeShipSlot: usesEventDeck ? eventDeckHasFreeShipSlot(eventDeckId) : false,
            playerDeck,
          }
        : stage;
    
    // Dimension Trimming Debug Logging - Active Stage
    if (isTrimRequest && activeStage) {
      console.log(`[TRIM:GAME_LOAD_REQ] ActiveStage created with playerDeck: hasPlayerDeck=${!!activeStage.playerDeck} playerDeckUnitCount=${activeStage.playerDeck && activeStage.playerDeck.units ? activeStage.playerDeck.units.length : 0}`);
    }
    
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.logCapturedClientPacketMatch(packet, 10, "game-load");
    }
    if (!activeStage || activeStage.tutorial) ctx.maybeSendTutorialCutsceneClear(socket, packet.payload);
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && activeStage && !activeStage.cutsceneOnly && ctx.sendDynamicGameLoadAck(socket, req, activeStage)) {
      // Dimension Trimming Debug Logging - Dynamic Battle Path
      if (isTrimRequest) {
        console.log(`[TRIM:GAME_LOAD_REQ] Taking DYNAMIC_BATTLE_MANAGER path (managed combat)`);
      }
      return true;
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      // Dimension Trimming Debug Logging - Captured Flow Path
      if (isTrimRequest) {
        console.log(`[TRIM:GAME_LOAD_REQ] Taking REPLAY_CAPTURED_GAME_FLOW path (using captured data) - WARNING: This will NOT use player's selected deck!`);
      }
      ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_LOAD_ACK, "game-load");
      ctx.scheduleCapturedGameAutoAdvance(socket);
      return true;
    }
    
    // Dimension Trimming Debug Logging - No Handler
    if (isTrimRequest) {
      console.log(`[TRIM:GAME_LOAD_REQ] WARNING: No handler processed GAME_LOAD_REQ! Returning false.`);
    }
    return false;
  },
};

function buildPlayerIdentityForGameLoad(user) {
  if (!user) return null;
  return {
    userUid: String(user.userUid || "0"),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    units: [],
  };
}

function getExpectedTutorialStageForUser(user) {
  const tutorial = user && user.tutorial && typeof user.tutorial === "object" ? user.tutorial : null;
  if (!tutorial || tutorial.enabled === false || tutorial.completed === true || tutorial.loginMode === "post-tutorial") return null;
  const phases = tutorial.phases && typeof tutorial.phases === "object" ? tutorial.phases : {};
  for (const stage of TUTORIAL_STAGE_CHAIN) {
    const phase = phases[String(stage.dungeonID)] || phases[String(stage.stageId)];
    if (!phase || phase.completed !== true) return stage;
  }
  return null;
}
