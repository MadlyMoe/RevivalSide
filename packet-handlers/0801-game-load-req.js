const { getTutorialStageForRequest, isTutorialDungeonId, isTutorialStageId, TUTORIAL_STAGE_CHAIN } = require("../stages/tutorialStage");
const { getMainStoryStageForRequest } = require("../stages/mainStoryStage");
const {
  buildAssistUnitForGameLoad,
  buildPlayerDeckForGameLoad,
  validatePlayerDeckForGameLoad,
} = require("../modules/unit");
const { getAvailableSupportUsers } = require("../modules/combat-roster");
const { validateGameLoadRewardMultiply } = require("../modules/game-load/authority");
const { eventDeckHasFreeShipSlot, eventDeckHasGivenUnitSlots, getEventDeckPlayerUnitSlots } = require("../modules/game-data");
const {
  buildShadowPalaceGameLoadFailurePayload,
  validateShadowPalaceBattleSelection,
} = require("../modules/shadow-palace");
const worldMap = require("../modules/world-map");
const trim = require("../modules/trim");
const explore = require("../modules/explore");
const guildDungeon = require("../modules/guild-dungeon");
const { writeNullObject, writeObjectList, writeSignedVarInt } = require("../modules/packet-codec");

const NGT_DIVE = 5;
const NGT_PHASE = 15;
const GAME_LOAD_ACK = 804;
const GAME_LOAD_FAILED = 95;
const DECK_DATA_INVALID = 56;
const INVALID_REQUEST = 20191;
const SUPPORT_UNIT_SEARCH_FAILED = 27803;

module.exports = {
  packetId: 801,
  name: "GAME_LOAD_REQ",
  handle(ctx, socket, packet) {
    ctx.logGameLoadReq(packet.payload);
    const req = ctx.decodeGameLoadReq(packet.payload);
    if (!req) return sendGameLoadFailure(ctx, socket, INVALID_REQUEST, "game-load-invalid");
    if (req.isDev) return sendGameLoadFailure(ctx, socket, INVALID_REQUEST, "game-load-network-dev-invalid");
    // Stage selection can arrive with a stale/captured dungeonID. Prefer the
    // selected stageID first so Act 2+ does not get pulled back into 1004.
    // Tutorial stages must come from tutorialStage.js, not the main-story catalog
    // wrapper, because that module carries the phase-specific tutorial runtime.
    const user = socket.session && socket.session.user;
    const requestedStageId = Number((req && req.stageID) || 0);
    const requestedDungeonId = Number((req && req.dungeonID) || 0);
    const requestedFierceBossId = Number((req && req.fierceBossId) || 0);
    const requestedPalaceId = Number((req && req.palaceID) || 0);
    if (requestedPalaceId > 0) {
      const selection = validateShadowPalaceBattleSelection(user, requestedPalaceId, requestedDungeonId);
      if (!selection.valid) {
        ctx.sendServerGamePacket(
          socket,
          (ctx.constants && ctx.constants.GAME_LOAD_ACK) || GAME_LOAD_ACK,
          buildShadowPalaceGameLoadFailurePayload(selection.errorCode),
          "shadow-palace-game-load-rejected"
        );
        console.log(
          `[game-load:shadow-palace] rejected palaceID=${requestedPalaceId} dungeonID=${requestedDungeonId} expected=${selection.dungeonId} error=${selection.errorCode}`
        );
        return true;
      }
      req.dungeonID = selection.dungeonId;
    }
    const explicitTutorial = isTutorialStageId(requestedStageId) || isTutorialDungeonId(requestedDungeonId);
    const diveGameLoad = req && Number(req.diveStageID || 0) > 0 ? worldMap.prepareDiveGameLoad(user, req) : null;
    let stage = null;
    let trimEventDeckData = null;
    let explorePlayerDeck = null;
    let guildArenaLoad = null;
    let phaseDeckValidation = null;
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
        teamBLevelAdd: diveGameLoad.teamBLevelAdd,
        tutorial: false,
        cutsceneOnly: false,
      };
      console.log(
        `[game-load:dive] diveStageID=${diveGameLoad.diveStageID} dungeonID=${diveGameLoad.dungeonID} deck=${diveGameLoad.deckIndex} teamBLevelAdd=${diveGameLoad.teamBLevelAdd}`
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
      const requestedPhaseStage = ctx.getGenericStageForRequest
        ? ctx.getGenericStageForRequest({ stageID: requestedStageId, dungeonID: requestedDungeonId })
        : null;
      if (requestedPhaseStage && Number(requestedPhaseStage.gameType || 0) === NGT_PHASE) stage = requestedPhaseStage;
      const phaseLoad = ctx.preparePhaseGameLoad ? ctx.preparePhaseGameLoad(user, req, stage) : null;
      if (phaseLoad && !phaseLoad.valid) {
        return sendGameLoadFailure(ctx, socket, phaseLoad.errorCode, "game-load-phase-invalid");
      }
      if (phaseLoad) {
        Object.assign(req, phaseLoad.req);
        stage = phaseLoad.stage;
        phaseDeckValidation = phaseLoad.deckValidation;
      }
      const exploreLoad = explore.prepareExploreGameLoad(user, req, stage);
      if (exploreLoad && !exploreLoad.valid) {
        ctx.sendServerGamePacket(
          socket,
          (ctx.constants && ctx.constants.GAME_LOAD_ACK) || GAME_LOAD_ACK,
          explore.buildExploreGameLoadFailurePayload(exploreLoad.errorCode),
          "explore-game-load-rejected"
        );
        console.log(`[game-load:explore] rejected dungeonID=${requestedDungeonId} error=${exploreLoad.errorCode}`);
        return true;
      }
      if (exploreLoad) {
        stage = exploreLoad.stage;
        explorePlayerDeck = exploreLoad.playerDeck;
      }
      const trimLoad = trim.prepareTrimGameLoad(user, req, stage);
      if (trimLoad && !trimLoad.valid) {
        ctx.sendServerGamePacket(
          socket,
          (ctx.constants && ctx.constants.GAME_LOAD_ACK) || GAME_LOAD_ACK,
          trim.buildTrimGameLoadFailurePayload(trimLoad.errorCode),
          "trim-game-load-rejected"
        );
        console.log(`[game-load:trim] rejected dungeonID=${requestedDungeonId} error=${trimLoad.errorCode}`);
        return true;
      }
      if (trimLoad) {
        stage = trimLoad.stage;
        req.eventDeckData = trimLoad.eventDeckData;
        trimEventDeckData = trimLoad.eventDeckData;
      }
      guildArenaLoad = guildDungeon.prepareArenaGameLoad(ctx, user, req, stage);
      if (guildArenaLoad && !guildArenaLoad.valid) {
        ctx.sendServerGamePacket(
          socket,
          (ctx.constants && ctx.constants.GAME_LOAD_ACK) || GAME_LOAD_ACK,
          guildDungeon.buildGameLoadFailurePayload(guildArenaLoad.errorCode),
          "guild-dungeon-arena-load-rejected"
        );
        return true;
      }
      if (guildArenaLoad) stage = guildArenaLoad.stage;
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
    const support = resolveSelectedSupport(ctx, user, req);
    if (!support.valid) {
      return sendGameLoadFailure(ctx, socket, SUPPORT_UNIT_SEARCH_FAILED, "game-load-support-user-invalid");
    }
    const eventDeckId = stage ? Number(stage.eventDeckId || stage.EventDeckId || 0) : 0;
    const usesEventDeck = eventDeckId > 0;
    const eventDeckPlayerUnitSlots = usesEventDeck ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
    const eventDeckAllowsPlayerUnits = eventDeckPlayerUnitSlots.length > 0;
    const usesHybridEventDeck = eventDeckAllowsPlayerUnits && eventDeckHasGivenUnitSlots(eventDeckId);
    const rewardValidation = validateGameLoadRewardMultiply(
      user,
      req,
      ctx.getGameLoadStageAuthorityDescriptor ? ctx.getGameLoadStageAuthorityDescriptor(stage) : {}
    );
    if (!rewardValidation.valid) {
      return sendGameLoadFailure(ctx, socket, rewardValidation.errorCode, "game-load-reward-multiply-invalid");
    }
    req.rewardMultiply = rewardValidation.rewardMultiply;
    const usesStandardDailyDeck =
      stage &&
      !stage.cutsceneOnly &&
      !stage.tutorial &&
      !explorePlayerDeck &&
      !trimEventDeckData &&
      !usesEventDeck &&
      Number(req.diveStageID || 0) === 0 &&
      requestedFierceBossId === 0 &&
      requestedPalaceId === 0 &&
      !String(stage.miscMode || "");
    const deckValidation = phaseDeckValidation || (usesStandardDailyDeck
      ? validatePlayerDeckForGameLoad(user, req, { deckType: 3, requiredState: 0 })
      : null);
    if (deckValidation && !deckValidation.valid) {
      return sendGameLoadFailure(ctx, socket, deckValidation.errorCode, "game-load-deck-invalid");
    }
    let playerDeck = null;
    if (stage && !stage.cutsceneOnly) {
      if (explorePlayerDeck) {
        playerDeck = explorePlayerDeck;
      } else if (trimEventDeckData) {
        playerDeck = buildPlayerDeckForGameLoad(user, req, {
          slotUnitUids: trimEventDeckData.units,
          shipUid: trimEventDeckData.shipUid,
          operatorUid: trimEventDeckData.operatorUid,
          leaderIndex: trimEventDeckData.leaderIndex,
        });
      } else if (stage.tutorial || (usesEventDeck && !eventDeckAllowsPlayerUnits)) {
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
        playerDeck =
          buildPlayerDeckForGameLoad(user, req, deckValidation
            ? { deckIndex: deckValidation.deckIndex, strictSelection: true }
            : {}) || buildPlayerIdentityForGameLoad(user);
      }
    }
    if (deckValidation && !playerDeck) {
      return sendGameLoadFailure(ctx, socket, DECK_DATA_INVALID, "game-load-deck-serialization-failed");
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
    if (support.data && playerDeck) {
      playerDeck.supportingUserUid = String(support.data.userUid);
      playerDeck.assistUnits = [support.data.unit];
      playerDeck.equipItems = mergeEquipItems(playerDeck.equipItems, support.data.equipItems);
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
    if (!activeStage) return sendGameLoadFailure(ctx, socket, GAME_LOAD_FAILED, "game-load-stage-unresolved");
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.logCapturedClientPacketMatch(packet, 10, "game-load");
    }
    if (!activeStage || activeStage.tutorial) ctx.maybeSendTutorialCutsceneClear(socket, packet.payload);
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && !activeStage.cutsceneOnly) {
      if (ctx.sendDynamicGameLoadAck(socket, req, activeStage)) {
        if (guildArenaLoad) guildDungeon.commitBattleStart(ctx, socket, activeStage);
        return true;
      }
      return sendGameLoadFailure(ctx, socket, GAME_LOAD_FAILED, "game-load-host-failure");
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_LOAD_ACK, "game-load");
      ctx.scheduleCapturedGameAutoAdvance(socket);
      return true;
    }
    return sendGameLoadFailure(ctx, socket, GAME_LOAD_FAILED, "game-load-bootstrap-unavailable");
  },
};

function sendGameLoadFailure(ctx, socket, errorCode, label) {
  ctx.sendServerGamePacket(
    socket,
    (ctx.constants && ctx.constants.GAME_LOAD_ACK) || GAME_LOAD_ACK,
    Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeObjectList([])]),
    label
  );
  return true;
}

function buildPlayerIdentityForGameLoad(user) {
  if (!user) return null;
  return {
    userUid: String(user.userUid || "0"),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    supportingUserUid: "0",
    assistUnits: [],
    equipItems: [],
    units: [],
  };
}

function resolveSelectedSupport(ctx, user, req) {
  const requestedUserUid = req && req.supportingUserUid != null ? BigInt(req.supportingUserUid) : 0n;
  if (requestedUserUid === 0n) return { valid: true, data: null };
  const selected = getAvailableSupportUsers(ctx, user).find(
    (entry) => BigInt(entry && entry.user && entry.user.userUid || 0) === requestedUserUid
  );
  if (!selected || !selected.unit) return { valid: false, data: null };
  const serialized = buildAssistUnitForGameLoad(selected.user, selected.unit);
  if (!serialized) return { valid: false, data: null };
  return {
    valid: true,
    data: {
      userUid: requestedUserUid.toString(),
      unit: serialized.unit,
      equipItems: serialized.equipItems,
    },
  };
}

function mergeEquipItems(first, second) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]) {
    const uid = String(item && item.equipUid || "0");
    if (uid === "0" || seen.has(uid)) continue;
    seen.add(uid);
    merged.push(item);
  }
  return merged;
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
