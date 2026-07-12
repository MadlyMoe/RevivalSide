const {
  writeString,
  writeBool,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeInt64LE,
  writeFloatLE,
  writeNullableObject,
  writeNullableObjectOrNull,
  writeNullObject,
  writeObjectList,
  writeObjectMapInt,
  writeIntList,
  buildItemMiscData,
  buildRewardData,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarIntList,
  readSignedVarLong,
  toBigInt,
} = require("../packet-codec");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getRewardGroupRecords } = require("../game-data");
const { grantMiscItem, getMiscItem, spendMiscItem } = require("../inventory");
const { ensureArmy, getArmyUnits, buildPlayerDeckForGameLoad } = require("../unit");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");
const { createEmptyReward, grantRewardRecord, mergeReward } = require("../reward");

const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DATE_TIME_TICK_MASK = 0x3fffffffffffffffn;
const TICKS_PER_SECOND = 10000000n;
const TICKS_PER_MINUTE = TICKS_PER_SECOND * 60n;
const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60n;
const TICKS_PER_DAY = TICKS_PER_HOUR * 24n;

const ITEM_ID_CREDIT = 1;
const ITEM_ID_ETERNIUM = 2;
const ITEM_ID_INFORMATION = 5;
const ITEM_ID_QUARTZ = 101;
const ITEM_ID_DIVE_PERMIT = 1065;

const NEC_OK = 0;
const NEC_FAIL_INSUFFICIENT_CASH = 91;
const NEC_FAIL_INSUFFICIENT_CREDIT = 93;
const NEC_FAIL_WORLDMAP_INVALID_CITY_ID = 149;
const NEC_FAIL_WORLDMAP_FULL_AREA = 151;
const NEC_FAIL_WORLDMAP_CITY_ALREADY_OPENED = 153;
const NEC_FAIL_WORLDMAP_MISSION_DOING = 157;
const NEC_FAIL_WORLDMAP_MISSION_NOT_DOING = 158;
const NEC_FAIL_WORLDMAP_INVALID_MISSION_ID = 160;
const NEC_FAIL_RAID_NOT_EXIST = 398;
const NEC_FAIL_RAID_HAS_BEEN_DEFEATED = 399;
const NEC_FAIL_RAID_EXCEEDED_TRY_COUNT = 401;
const NEC_FAIL_RAID_NOT_ENDED = 404;

const CITY_OPEN_CASH_COSTS = Object.freeze([0, 800, 2400, 4500, 8000, 12500]);
const CITY_OPEN_CREDIT_COSTS = Object.freeze([0, 100000, 200000, 400000, 800000, 1600000]);
const CITY_UNLOCK_LEVELS = Object.freeze([0, 1, 10, 25, 35, 45, 55]);
const STRICT_BRANCH_UNLOCK_ERRORS = envFlagDefault(false, "CS_WORLDMAP_STRICT_BRANCH_UNLOCK");
const RAID_FACILITY_BUILDING_ID = 21;
const DECK_TYPE_RAID = 4;
const DIVE_PLAYER_STATE = Object.freeze({
  EXPLORING: 0,
  BATTLE_READY: 1,
  BATTLE_LOAD: 2,
  BATTLE: 3,
  SELECT_ARTIFACT: 4,
  ANNIHILATION: 5,
  CLEAR: 6,
});
const DIVE_SECTOR_TYPE = Object.freeze({
  START: 1,
  BOSS: 2,
  POINCARE: 4,
  REIMANN: 6,
  GAUNTLET: 8,
  EUCLID: 10,
});
const DIVE_EVENT_TYPE = Object.freeze({
  NONE: 0,
  DUNGEON: 1,
  DUNGEON_BOSS: 2,
  BLANK: 5,
});
const DIVE_DUNGEON_PREFIX_BY_SECTOR = Object.freeze({
  [DIVE_SECTOR_TYPE.POINCARE]: "POINCARE",
  [DIVE_SECTOR_TYPE.REIMANN]: "REIMANN",
  [DIVE_SECTOR_TYPE.GAUNTLET]: "GAUNTLET",
});

const WORLD_MAP_PACKET_IDS = [2000, 2002, 2004, 2006, 2008, 2010, 2012, 2014, 2016, 2018, 2020, 2022, 2024];
const DIVE_PACKET_IDS = [1206, 1208, 1210, 1212, 1215, 1217, 1249];
const RAID_PACKET_IDS = [802, 885, 2200, 2202, 2204, 2206, 2208, 2210, 2212, 2214, 2217, 2219];
const RAID_SNAPSHOT_PACKET_IDS = new Set([2000, 2012, 2014, 2024, 885, 2200, 2202, 2204, 2206, 2210, 2212, 2214, 2217, 2219]);
const RAID_DISMISS_HISTORY_LIMIT = 200;

let tableCache = null;

function createWorldMapHandlers() {
  return [...WORLD_MAP_PACKET_IDS, ...DIVE_PACKET_IDS, ...RAID_PACKET_IDS].map((packetId) => ({
    packetId,
    name: `WORLD_MAP_${packetId}`,
    handle(ctx, socket, packet) {
      const user = getSocketUser(ctx, socket);
      const now = getContextNow(ctx);
      const req = decodeRequest(ctx, packetId, packet.payload);
      if (packetId === 802) return handleRaidGameLoad(ctx, socket, packet, user, req, { now });
      const response = buildPacketResponse(user, packetId, req, { now });
      const missionTracking = trackWorldMapMissionEvents(ctx, user, response.missionEvents, { now });
      console.log(`[world-map:${packetId}] ${describeRequest(packetId, req)} ACK packetId=${response.packetId}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "world-map-mission-update" });
      if ((response.raidStateRefresh || RAID_SNAPSHOT_PACKET_IDS.has(packetId)) && typeof ctx.sendServerGamePacket === "function") {
        sendRaidSnapshotData(ctx, socket, user, {
          now,
          includeWorldMap: packetId === 2200,
          worldMapLabel: `world-map-${packetId}-world-map-data`,
          label: `world-map-${packetId}-my-raid-list`,
          detailLabel: `world-map-${packetId}-raid-detail`,
          coopLabel: `world-map-${packetId}-raid-coop-list`,
          resultLabel: `world-map-${packetId}-raid-result-list`,
          eventCancelLabel: `world-map-${packetId}-raid-event-clear`,
          includeEmpty: true,
        });
      }
      if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
      return true;
    },
  }));
}

function buildPacketResponse(user, packetId, req, options = {}) {
  switch (packetId) {
    case 2000:
      return ack(2001, [writeSignedVarInt(0), writeNullableObject(buildWorldMapData(user, options))]);
    case 2002: {
      const result = unlockCity(user, req.cityID, { ...options, isCash: req.isCash });
      return ack(2003, [
        writeSignedVarInt(result.errorCode || NEC_OK),
        result.city ? writeNullableObject(buildWorldMapCityData(result.city)) : writeNullObject(),
        result.costItem ? writeNullableObject(buildItemMiscData(result.costItem)) : writeNullObject(),
      ]);
    }
    case 2004: {
      const city = setCityLeader(user, req.cityID, req.leaderUID, options);
      return ack(2005, [writeSignedVarInt(0), writeSignedVarInt(city.cityID), writeSignedVarLong(toBigInt(city.leaderUnitUID))]);
    }
    case 2006: {
      const result = startWorldMapMission(user, req.cityID, req.missionID, options);
      return ack(2007, [
        writeSignedVarInt(0),
        writeSignedVarInt(result.city.cityID),
        writeSignedVarInt(result.missionID),
        writeSignedVarLong(result.completeTime),
      ]);
    }
    case 2008: {
      const city = cancelWorldMapMission(user, req.cityID, options);
      return ack(2009, [writeSignedVarInt(0), writeSignedVarInt(city.cityID)]);
    }
    case 2010: {
      const city = refreshWorldMapMissionList(user, req.cityID, { ...options, force: true });
      return ack(2011, [writeSignedVarInt(0), writeSignedVarInt(city.cityID), writeIntList(city.mission.stMissionIDList), writeNullObject()]);
    }
    case 2012: {
      const result = completeWorldMapMission(user, req.cityID, options);
      return ack(
        2013,
        [
          writeSignedVarInt(result.errorCode || NEC_OK),
          writeSignedVarInt(result.city.cityID),
          writeSignedVarInt(result.clearedMissionID),
          writeSignedVarInt(result.city.level),
          writeSignedVarInt(result.city.exp),
          writeIntList(result.city.mission.stMissionIDList),
          writeNullableObject(buildRewardData(result.reward || {})),
          writeBool(result.isSuccess),
          writeNullableObject(buildWorldMapEventGroupData(result.worldMapEventGroup || null)),
        ],
        {
          missionEvents: result.isSuccess
            ? [
                {
                  condition: "WORLDMAP_MISSION_CLEAR",
                  details: { cityId: result.city.cityID, missionId: result.clearedMissionID, value: result.clearedMissionID },
                },
                {
                  condition: "WORLDMAP_MISSION_CLEARED",
                  details: { cityId: result.city.cityID, missionId: result.clearedMissionID, value: result.clearedMissionID },
                },
              ]
            : [],
        }
      );
    }
    case 2014: {
      const city = clearWorldMapEvent(user, req.cityID, options);
      return ack(2015, [writeSignedVarInt(0), writeSignedVarInt(city.cityID)]);
    }
    case 2016: {
      const result = collectWorldMapIncome(user, options);
      return ack(2017, [writeSignedVarInt(0), writeMiscItemList(result.items)]);
    }
    case 2018: {
      const result = buildCityBuilding(user, req.cityID, req.buildID, options);
      return ack(2019, [
        writeSignedVarInt(0),
        writeSignedVarInt(result.city.cityID),
        writeSignedVarInt(result.building.id),
        writeMiscItemList(result.costItems),
      ]);
    }
    case 2020: {
      const result = levelUpCityBuilding(user, req.cityID, req.buildID, options);
      return ack(2021, [
        writeSignedVarInt(0),
        writeSignedVarInt(result.city.cityID),
        writeNullableObject(buildWorldMapBuildingData(result.building)),
        writeMiscItemList(result.costItems),
      ]);
    }
    case 2022: {
      const result = expireCityBuilding(user, req.cityID, req.buildID, options);
      return ack(2023, [
        writeSignedVarInt(0),
        writeSignedVarInt(result.city.cityID),
        writeSignedVarInt(req.buildID),
        writeNullableObjectOrNull(result.item ? buildItemMiscData(result.item) : null),
      ]);
    }
    case 2024: {
      const city = clearWorldMapEvent(user, req.cityID, options);
      return ack(2025, [writeSignedVarInt(0), writeSignedVarInt(city.cityID)]);
    }
    case 1206: {
      const result = startDive(user, req, options);
      return ack(1207, [
        writeSignedVarInt(0),
        writeSignedVarInt(result.cityID),
        writeNullableObject(buildDiveGameData(result.dive)),
        writeMiscItemList(result.costItems),
      ]);
    }
    case 1208: {
      const result = moveDiveForward(user, req.slotIndex, options);
      return ack(1209, [writeSignedVarInt(0), writeNullableObject(buildDiveSyncData(result.syncData))]);
    }
    case 1210:
      giveUpDive(user);
      return ack(1211, [writeSignedVarInt(0)]);
    case 1212:
      setDiveAuto(user, req.isAuto);
      return ack(1213, [writeSignedVarInt(0), writeBool(Boolean(req.isAuto))]);
    case 1215: {
      const result = selectDiveArtifact(user, req.artifactID);
      return ack(1216, [writeSignedVarInt(0), writeNullableObject(buildDiveSyncData(result.syncData))]);
    }
    case 1217: {
      const result = suicideDiveSquad(user, req.selectDeckIndex);
      return ack(1218, [writeSignedVarInt(0), writeNullableObject(buildDiveSyncData(result.syncData))]);
    }
    case 1249: {
      const result = skipDive(user, req, options);
      return ack(
        1250,
        [
          writeSignedVarInt(0),
          writeObjectList(result.rewards.map((reward) => writeNullableObject(buildRewardData(reward)))),
          writeMiscItemList(result.costItems),
          writeSignedVarInt(result.deletedEventCityId),
        ],
        {
          missionEvents: [
            { condition: "DIVE_CLEAR", amount: result.skipCount, details: { stageId: result.stageID, value: result.stageID } },
            { condition: "DIVE_PLAY_RECORD", amount: result.skipCount, details: { stageId: result.stageID, value: result.stageID } },
          ],
        }
      );
    }
    case 885: {
      const result = sweepRaid(user, req.raidUid, options);
      if (!result.ok) {
        return ack(886, [
          writeSignedVarInt(result.errorCode || NEC_FAIL_RAID_NOT_EXIST),
          writeSignedVarLong(toBigInt(req.raidUid || 0)),
          writeNullObject(),
          writeObjectList([]),
          writeNullObject(),
        ]);
      }
      return ack(
        886,
        [
          writeSignedVarInt(0),
          writeSignedVarLong(result.raidUid),
          writeNullableObject(buildRaidBossResultData(result.bossResult)),
          writeMiscItemList(result.costItems),
          writeNullableObject(buildRaidDetailData(user, result.raid)),
        ],
        {
          missionEvents: raidMissionEvents(result.raid),
        }
      );
    }
    case 2200:
      return ack(2201, [writeSignedVarInt(0), writeObjectList(getActiveRaids(user, options).map((raid) => writeNullableObject(buildMyRaidData(raid))))]);
    case 2202:
      return ack(2203, [writeSignedVarInt(0), writeObjectList(getCoopRaids(user, options).map((raid) => writeNullableObject(buildCoopRaidData(user, raid))))]);
    case 2204: {
      const raid = getActiveRaidByUid(user, req.raidUID, options);
      if (!raid) {
        const errorCode = getRaidResultByUid(user, req.raidUID, options) ? NEC_FAIL_RAID_HAS_BEEN_DEFEATED : NEC_FAIL_RAID_NOT_EXIST;
        return ack(2205, [writeSignedVarInt(errorCode), writeSignedVarLong(toBigInt(req.raidUID || 0)), writeObjectList([])], {
          raidStateRefresh: true,
        });
      }
      const updated = setRaidCoop(user, raid.raidUID, true, options);
      if (!updated) {
        return ack(2205, [writeSignedVarInt(NEC_FAIL_RAID_NOT_EXIST), writeSignedVarLong(toBigInt(req.raidUID || 0)), writeObjectList([])], {
          raidStateRefresh: true,
        });
      }
      return ack(2205, [
        writeSignedVarInt(0),
        writeSignedVarLong(toBigInt(updated.raidUID)),
        writeObjectList([writeNullableObject(buildRaidJoinData(user, updated))]),
      ], {
        raidStateRefresh: true,
      });
    }
    case 2206:
      return ack(2207, [
        writeSignedVarInt(0),
        writeObjectList(setAllRaidsCoop(user, options).map((raid) => writeNullableObject(buildRaidDetailData(user, raid)))),
      ]);
    case 2208: {
      const raid = getRaidByUid(user, req.raidUID, options);
      if (!raid) {
        const result = getRaidResultByUid(user, req.raidUID, options);
        if (result) return ack(2209, [writeSignedVarInt(0), writeNullableObject(buildRaidDetailData(user, result))]);
        return ack(2209, [writeSignedVarInt(NEC_FAIL_RAID_NOT_EXIST), writeNullObject()]);
      }
      const state = ensureWorldMapState(user, options);
      state.raids[String(toBigInt(raid.raidUID))] = normalizeRaidState(raid);
      return ack(2209, [writeSignedVarInt(0), writeNullableObject(buildRaidDetailData(user, raid))]);
    }
    case 2210:
      return ack(2211, [writeSignedVarInt(0), writeObjectList(getRaidResults(user, options).map((raid) => writeNullableObject(buildRaidResultData(user, raid))))]);
    case 2212: {
      const result = acceptRaidResult(user, req.raidUID, options);
      return ack(2213, [
        writeSignedVarInt(0),
        writeSignedVarLong(result.raidUid),
        writeNullableObject(buildRewardData(result.reward || {})),
        writeSignedVarInt(result.rewardRaidPoint),
      ]);
    }
    case 2214: {
      const result = acceptAllRaidResults(user, options);
      return ack(2215, [
        writeSignedVarInt(0),
        writeObjectList(result.raidUids.map((raidUid) => writeSignedVarLong(raidUid))),
        writeNullableObject(buildRewardData(result.reward || {})),
        writeSignedVarInt(result.rewardRaidPoint),
      ]);
    }
    case 2217:
      return ack(2218, [writeSignedVarInt(0), writeNullableObject(buildRewardData({}))]);
    case 2219:
      return ack(2220, [writeSignedVarInt(0), writeNullableObject(buildRewardData({})), writeNullableObject(buildRaidSeasonData(user, options))]);
    default:
      return ack(packetId + 1, [writeSignedVarInt(0)]);
  }
}

function ack(packetId, parts, metadata = {}) {
  return { packetId, payload: Buffer.concat(parts), ...metadata };
}

function handleRaidGameLoad(ctx, socket, packet, user, req, options = {}) {
  const raid = resolveRaidForGameLoad(user, req.raidUID, options);
  if (!raid) {
    console.log(`[world-map:802] raidUID=${String(req.raidUID || 0)} not found; refusing default raid load`);
    return sendRaidGameLoadError(ctx, socket, packet, req.raidUID, NEC_FAIL_RAID_NOT_EXIST, "not-found");
  }
  const raidTemplet = findRaidTemplet(raid.stageID);
  if (!raidTemplet) {
    console.log(`[world-map:802] raidUID=${raid.raidUID} stageID=${raid.stageID} has no client raid templet`);
    return sendRaidGameLoadError(ctx, socket, packet, raid.raidUID, NEC_FAIL_RAID_NOT_EXIST, "missing-templet");
  }
  const dungeonID = positiveInt(raidTemplet && raidTemplet.m_DungeonID) || raid.stageID;
  const raidLevel = positiveInt(raidTemplet && raidTemplet.m_RaidLevel);
  const gameUID = makeRaidGameUid();
  const battleKey = makeRaidBattleKey(raid.raidUID, gameUID, raid.stageID, dungeonID);
  const reservedAttempt = reserveRaidAttempt(user, raid.raidUID, { ...options, battleKey, gameUID });
  if (!reservedAttempt.ok) {
    console.log(`[world-map:802] raidUID=${raid.raidUID} attempt rejected error=${reservedAttempt.errorCode}`);
    return sendRaidGameLoadError(ctx, socket, packet, raid.raidUID, reservedAttempt.errorCode || NEC_FAIL_RAID_EXCEEDED_TRY_COUNT, "attempt-rejected");
  }
  const stageFromTables =
    ctx && typeof ctx.getGenericStageForRequest === "function"
      ? ctx.getGenericStageForRequest({ stageID: raid.stageID, dungeonID })
      : null;
  const gameType = raidGameTypeForTemplet(raidTemplet, stageFromTables);
  const gameReq = {
    stageID: Number(raid.stageID),
    dungeonID,
    gameType,
    selectDeckIndex: Number(req.selectDeckIndex || 0) || 0,
    deckIndex: { deckType: DECK_TYPE_RAID, index: Number(req.selectDeckIndex || 0) || 0 },
    raidUID: toBigInt(raid.raidUID),
    raidLevel,
    gameUID: String(gameUID),
    buffList: Array.isArray(req.buffList) ? req.buffList : [],
    isTryAssist: Boolean(req.isTryAssist),
    supportingUserUid: toBigInt(req.supportingUserUid || 0),
    raidCurHP: Number(raid.curHP),
    raidMaxHP: Number(raid.maxHP),
  };
  const playerDeck = buildPlayerDeckForGameLoad(user, gameReq);
  const stage = {
    ...(stageFromTables || {}),
    stageId: gameReq.stageID,
    dungeonID,
    mapID: Number(stageFromTables && stageFromTables.mapID) || 0,
    gameType,
    tutorial: false,
    cutsceneOnly: false,
    worldmapEventID: Number(raid.worldmapEventID || 0) || 0,
    raidLevel,
    initialUnits: [],
    autoDeployUnits: [],
    initialRemainGameTime: 180,
    playerDeck,
    raidUID: String(raid.raidUID),
    gameUID: String(gameUID),
  };
  if (socket.session && socket.session.gameReplay) {
    socket.session.gameReplay.lastGameLoadReq = {
      stageID: gameReq.stageID,
      dungeonID,
      raidUID: String(raid.raidUID),
    };
  }
  if (ctx.config && ctx.config.DYNAMIC_BATTLE_MANAGER && typeof ctx.sendDynamicGameLoadAck === "function") {
    if (ctx.sendDynamicGameLoadAck(socket, gameReq, stage)) {
      console.log(`[world-map:802] raidUID=${raid.raidUID} stageID=${gameReq.stageID} dungeonID=${dungeonID} dynamic GAME_LOAD_ACK`);
      sendRaidStateData(ctx, socket, user, {
        now: options.now,
        label: "raid-attempt-my-raid-list",
        detailLabel: "raid-attempt-raid-detail",
        coopLabel: "raid-attempt-raid-coop-list",
        resultLabel: "raid-attempt-raid-result-list",
        eventCancelLabel: "raid-attempt-raid-event-clear",
        includeEmpty: true,
      });
      completeMissionTracking(ctx, socket, user, trackWorldMapMissionEvents(ctx, user, raidMissionEvents(raid), options), {
        label: "raid-mission-update",
      });
      return true;
    }
  }
  const payload =
    typeof ctx.buildGameLoadAck === "function"
      ? ctx.buildGameLoadAck({
          stageID: gameReq.stageID,
          dungeonID,
          mapID: stage.mapID,
          raidUID: toBigInt(raid.raidUID),
          gameUID,
          gameType,
          raidLevel,
          teamBLevelFix: raidLevel,
        })
      : Buffer.concat([writeSignedVarInt(0), writeNullObject(), writeObjectList([])]);
  const ackPacketId = (ctx.constants && ctx.constants.GAME_LOAD_ACK) || 804;
  console.log(`[world-map:802] raidUID=${raid.raidUID} stageID=${gameReq.stageID} dungeonID=${dungeonID} ACK packetId=${ackPacketId}`);
  ctx.sendResponse(socket, packet.sequence, ackPacketId, () => ctx.buildEncryptedPacket(packet.sequence, ackPacketId, payload));
  sendRaidStateData(ctx, socket, user, {
    now: options.now,
    label: "raid-attempt-my-raid-list",
    detailLabel: "raid-attempt-raid-detail",
    coopLabel: "raid-attempt-raid-coop-list",
    resultLabel: "raid-attempt-raid-result-list",
    eventCancelLabel: "raid-attempt-raid-event-clear",
    includeEmpty: true,
  });
  completeMissionTracking(ctx, socket, user, trackWorldMapMissionEvents(ctx, user, raidMissionEvents(raid), options), {
    label: "raid-mission-update",
  });
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  return true;
}

function raidGameTypeForTemplet(raidTemplet, stageFromTables = null) {
  const dungeonType = String(stageFromTables && stageFromTables.dungeonType || "").toUpperCase();
  if (dungeonType === "NDT_RAID") return 8;
  if (dungeonType === "NDT_SOLO_RAID") return 12;
  const stageID = positiveInt(raidTemplet && raidTemplet.m_StageID);
  const dungeonID = positiveInt(raidTemplet && raidTemplet.m_DungeonID);
  return stageID > 0 && dungeonID > 0 && stageID !== dungeonID ? 8 : 12;
}

function sendRaidGameLoadError(ctx, socket, packet, raidUID, errorCode, reason) {
  const payload = Buffer.concat([writeSignedVarInt(errorCode || NEC_FAIL_RAID_NOT_EXIST), writeNullObject(), writeObjectList([])]);
  const ackPacketId = (ctx.constants && ctx.constants.GAME_LOAD_ACK) || 804;
  console.log(`[world-map:802] raidUID=${String(raidUID || 0)} ${reason || "error"} ACK packetId=${ackPacketId} error=${errorCode}`);
  ctx.sendResponse(socket, packet.sequence, ackPacketId, () => ctx.buildEncryptedPacket(packet.sequence, ackPacketId, payload));
  return true;
}

function trackWorldMapMissionEvents(ctx, user, events, options = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const eventList = Array.isArray(events) ? events : [];
  if (!eventList.length) return null;
  const now = options.now;
  const tracking = makeMissionTracking(now);
  for (const event of eventList) {
    const condition = String(event && event.condition || "").trim();
    if (!condition) continue;
    const amount = Math.max(1, Number(event.amount || 1) || 1);
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now, ...((event && event.details) || {}) });
    addMissionTrackingCondition(tracking, condition, tracked);
  }
  return tracking;
}

function raidMissionEvents(raid = {}) {
  const stageId = positiveInt(raid.stageID);
  const raidTemplet = getRaidTemplet(stageId);
  const raidLevel = positiveInt(raidTemplet && raidTemplet.m_RaidLevel);
  const details = { stageId, value: stageId, raidUid: raid.raidUID };
  return [
    { condition: "RAID_PLAY", details },
    { condition: "RAID_PLAY_LEVEL_HIGH", details: { ...details, value: raidLevel || stageId } },
  ];
}

function buildWorldMapData(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const cityEntries = Object.values(state.cities)
    .sort((a, b) => a.cityID - b.cityID)
    .map((city) => [city.cityID, buildWorldMapCityData(city)]);
  return Buffer.concat([writeObjectMapInt(cityEntries), writeInt64LE(toBigInt(state.collectLastResetDate || binaryNow(options)))]);
}

function getWorldMapCityIds(user, options = {}) {
  const state = options.includeDefaults ? ensureWorldMapState(user, options) : ensureBareWorldMapState(user, options);
  return uniquePositiveIntsInOrder(
    Object.entries(state.cities || {}).map(([key, city]) => positiveInt(city && city.cityID) || positiveInt(key))
  ).sort((a, b) => a - b);
}

function buildWorldMapCityData(city) {
  const normalized = normalizeCityState(city || {}, Number(city && city.cityID) || 1);
  const buildingEntries = Object.values(normalized.buildings)
    .sort((a, b) => a.id - b.id)
    .map((building) => [building.id, buildWorldMapBuildingData(building)]);
  return Buffer.concat([
    writeSignedVarInt(normalized.cityID),
    writeSignedVarLong(toBigInt(normalized.leaderUnitUID || 0)),
    writeSignedVarInt(normalized.exp),
    writeSignedVarInt(normalized.level),
    writeNullableObject(buildWorldMapMissionData(normalized.mission)),
    writeNullableObject(buildWorldMapEventGroupData(normalized.eventGroup)),
    writeObjectMapInt(buildingEntries),
  ]);
}

function buildWorldMapMissionData(mission) {
  const data = normalizeMissionState(mission || {});
  return Buffer.concat([
    writeSignedVarInt(data.currentMissionID),
    writeSignedVarLong(toBigInt(data.completeTime || 0)),
    writeInt64LE(toBigInt(data.startDate || 0)),
    writeIntList(data.stMissionIDList),
  ]);
}

function buildWorldMapEventGroupData(group) {
  const data = normalizeEventGroup(group || {});
  return Buffer.concat([
    writeSignedVarInt(data.worldmapEventID),
    writeInt64LE(toBigInt(data.eventGroupEndDate || 0)),
    writeSignedVarLong(toBigInt(data.eventUid || 0)),
  ]);
}

function buildWorldMapBuildingData(building) {
  const data = normalizeBuildingState(building || {}, Number(building && building.id) || 1);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.buildUID || 0)),
    writeSignedVarInt(data.id),
    writeSignedVarInt(data.level),
  ]);
}

function buildActiveDiveGameData(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  const dive = state.dive && state.dive.active ? normalizeDiveState(state.dive.active, options) : null;
  return dive ? buildDiveGameData(dive) : null;
}

function buildDiveClearData(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  return writeIntList(state.diveClearStages);
}

function buildDiveHistoryData(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  return writeIntList(state.diveHistoryStages);
}

function hasWorldMapProgress(user) {
  if (envFlagDefault(false, "CS_WORLDMAP_UNLOCK_ALL_BRANCHES")) return true;
  const state = user && user.worldMap && typeof user.worldMap === "object" ? user.worldMap : null;
  if (!state) return false;

  const cities = state.cities && typeof state.cities === "object" ? Object.entries(state.cities) : [];
  const defaultCityIds = new Set(getDefaultCityIds().map(String));
  let cityCount = 0;
  for (const [key, city] of cities) {
    if (!city || typeof city !== "object") continue;
    cityCount += 1;
    const cityID = positiveInt(city.cityID) || positiveInt(key);
    if (cityID && !defaultCityIds.has(String(cityID))) return true;
    if (positiveInt(city.level) > 1 || positiveInt(city.exp) > 0) return true;
    if (toBigInt(city.leaderUnitUID || city.leaderUID || 0) > 0n) return true;

    const mission = city.mission && typeof city.mission === "object" ? city.mission : {};
    if (positiveInt(mission.currentMissionID) > 0) return true;
    if (toBigInt(mission.completeTime || 0) > 0n || toBigInt(mission.startDate || 0) > 0n) return true;
    if (positiveInt(mission.refreshNonce) > 0) return true;

    const eventGroup = city.eventGroup && typeof city.eventGroup === "object" ? city.eventGroup : {};
    if (positiveInt(eventGroup.worldmapEventID) > 0 || toBigInt(eventGroup.eventUid || 0) > 0n) return true;

    const buildings = city.buildings && typeof city.buildings === "object" ? Object.entries(city.buildings) : [];
    for (const [buildingKey, building] of buildings) {
      const buildID = positiveInt(building && building.id) || positiveInt(buildingKey);
      if (buildID && buildID !== 1) return true;
      if (positiveInt(building && building.level) > 1) return true;
      if (toBigInt(building && (building.buildUID || building.uid) || 0) > 0n) return true;
    }
  }
  if (cityCount > defaultCityIds.size) return true;
  if (state.raids && typeof state.raids === "object" && Object.keys(state.raids).length > 0) return true;
  if (state.raidResults && typeof state.raidResults === "object" && Object.keys(state.raidResults).length > 0) return true;
  if (state.dive && typeof state.dive === "object" && state.dive.active) return true;
  if (Array.isArray(state.diveClearStages) && state.diveClearStages.length > 0) return true;
  if (Array.isArray(state.diveHistoryStages) && state.diveHistoryStages.length > 0) return true;
  return false;
}

function ensureWorldMapState(user, options = {}) {
  if (!user || typeof user !== "object") {
    return {
      schemaVersion: 1,
      cities: {},
      raids: {},
      raidResults: {},
      dismissedRaidUids: [],
      diveClearStages: [],
      diveHistoryStages: [],
      collectLastResetDate: String(binaryNow(options)),
      nextUid: "900000000001",
    };
  }

  user.worldMap = user.worldMap && typeof user.worldMap === "object" ? user.worldMap : {};
  const state = user.worldMap;
  state.schemaVersion = 1;
  state.cities = state.cities && typeof state.cities === "object" ? state.cities : {};
  state.raids = state.raids && typeof state.raids === "object" ? state.raids : {};
  state.raidResults = state.raidResults && typeof state.raidResults === "object" ? state.raidResults : {};
  state.dismissedRaidUids = normalizeRaidUidList(state.dismissedRaidUids);
  state.dive = state.dive && typeof state.dive === "object" ? state.dive : {};
  state.diveClearStages = uniquePositiveInts(state.diveClearStages);
  state.diveHistoryStages = uniquePositiveInts(state.diveHistoryStages);
  state.pendingRaidEventClearCityIds = uniquePositiveInts(state.pendingRaidEventClearCityIds);
  state.collectLastResetDate = String(state.collectLastResetDate || binaryNow(options));
  state.nextUid = String(state.nextUid || defaultNextUid(user));

  const cityIds = getDefaultCityIds();
  for (const cityID of cityIds) ensureCityState(user, cityID, options);
  refreshWorldMapState(user, options);
  return state;
}

function refreshWorldMapState(user, options = {}) {
  const state = ensureBareWorldMapState(user, options);
  const now = ticksNow(options);
  for (const city of Object.values(state.cities)) {
    normalizeCityState(city, city.cityID || 1);
    const eventRaidUid = toBigInt(city.eventGroup && city.eventGroup.eventUid);
    const eventRaidKey = String(eventRaidUid);
    if (eventRaidUid > 0n && isRaidDismissed(state, eventRaidKey)) {
      queueRaidEventClearCity(state, city.cityID);
      city.eventGroup = normalizeEventGroup(null);
      continue;
    }
    if (eventRaidUid > 0n && state.raidResults[eventRaidKey]) {
      queueRaidEventClearCity(state, city.cityID);
      city.eventGroup = normalizeEventGroup(null);
      continue;
    }
    const eventRaid = eventRaidUid > 0n && state.raids[eventRaidKey] ? normalizeRaidState(state.raids[eventRaidKey]) : null;
    if (eventRaid && Number(eventRaid.curHP || 0) <= 0) {
      state.raidResults[eventRaidKey] = normalizeRaidState({ ...eventRaid, accepted: false });
      delete state.raids[eventRaidKey];
      queueRaidEventClearCity(state, city.cityID);
      city.eventGroup = normalizeEventGroup(null);
      continue;
    }
    if (
      isActiveEventGroup(city.eventGroup) &&
      ticksFromDateTimeBinary(city.eventGroup.eventGroupEndDate) <= now &&
      !state.raids[String(eventRaidUid)]
    ) {
      if (isUsableWorldMapRaidEvent(getWorldMapEventById(city.eventGroup.worldmapEventID))) queueRaidEventClearCity(state, city.cityID);
      city.eventGroup = normalizeEventGroup(null);
    }
    refreshCityMissionList(user, city, options);
  }
  for (const raidUid of Object.keys(state.raidResults || {})) {
    if (isRaidDismissed(state, raidUid)) delete state.raidResults[raidUid];
  }
  for (const [raidUid, raid] of Object.entries(state.raids)) {
    if (isRaidDismissed(state, raidUid)) {
      delete state.raids[raidUid];
      clearRaidEventGroupForUid(state, raidUid);
      continue;
    }
    const normalized = normalizeRaidState(raid);
    if (toBigInt(normalized.expireDate) <= now && !isRaidReferencedByCity(state, raidUid)) {
      delete state.raids[raidUid];
    } else {
      state.raids[raidUid] = normalized;
    }
  }
  repairMissingRaidEventGroups(state, options);
  repairRaidEventLinks(state);
  return state;
}

function ensureBareWorldMapState(user, options = {}) {
  if (!user || typeof user !== "object") return ensureWorldMapState(null, options);
  user.worldMap = user.worldMap && typeof user.worldMap === "object" ? user.worldMap : {};
  const state = user.worldMap;
  state.cities = state.cities && typeof state.cities === "object" ? state.cities : {};
  state.raids = state.raids && typeof state.raids === "object" ? state.raids : {};
  state.raidResults = state.raidResults && typeof state.raidResults === "object" ? state.raidResults : {};
  state.dismissedRaidUids = normalizeRaidUidList(state.dismissedRaidUids);
  state.dive = state.dive && typeof state.dive === "object" ? state.dive : {};
  state.pendingRaidEventClearCityIds = uniquePositiveInts(state.pendingRaidEventClearCityIds);
  return state;
}

function unlockCity(user, cityID, options = {}) {
  const requestedCityID = positiveInt(cityID) || firstCityId();
  if (!isKnownCityId(requestedCityID)) {
    return { errorCode: NEC_FAIL_WORLDMAP_INVALID_CITY_ID, city: null, costItem: null, established: false };
  }

  const state = ensureWorldMapState(user, options);
  if (state.cities[String(requestedCityID)]) {
    return {
      errorCode: STRICT_BRANCH_UNLOCK_ERRORS ? NEC_FAIL_WORLDMAP_CITY_ALREADY_OPENED : NEC_OK,
      city: ensureCityState(user, requestedCityID, options),
      costItem: null,
      established: false,
    };
  }

  const unlockedCityCount = getUnlockedCityCount(state);
  if (STRICT_BRANCH_UNLOCK_ERRORS && !options.isCash && unlockedCityCount >= getPossibleCityCount(user)) {
    return { errorCode: NEC_FAIL_WORLDMAP_FULL_AREA, city: null, costItem: null, established: false };
  }

  const itemId = options.isCash ? ITEM_ID_QUARTZ : ITEM_ID_CREDIT;
  const cost = getCityOpenCost(unlockedCityCount, Boolean(options.isCash));
  if (STRICT_BRANCH_UNLOCK_ERRORS && cost > 0 && getMiscItemBalance(user, itemId) < BigInt(cost)) {
    return {
      errorCode: options.isCash ? NEC_FAIL_INSUFFICIENT_CASH : NEC_FAIL_INSUFFICIENT_CREDIT,
      city: null,
      costItem: null,
      established: false,
    };
  }

  const costItem = cost > 0 ? spendMiscItem(user, itemId, cost, { regDate: String(binaryNow(options)) }) : null;
  const city = ensureCityState(user, requestedCityID, options);
  refreshCityMissionList(user, city, options);
  return { errorCode: NEC_OK, city, costItem, established: true };
}

function ensureCityState(user, cityID, options = {}) {
  const state = ensureBareWorldMapState(user, options);
  const id = positiveInt(cityID) || firstCityId();
  const key = String(id);
  state.cities[key] = normalizeCityState(state.cities[key] || {}, id);
  if (!state.cities[key].mission.stMissionIDList.length) refreshCityMissionList(user, state.cities[key], { ...options, force: true });
  return state.cities[key];
}

function normalizeCityState(city, cityID) {
  const data = city && typeof city === "object" ? city : {};
  data.cityID = positiveInt(data.cityID) || positiveInt(cityID) || 1;
  data.leaderUnitUID = String(data.leaderUnitUID || data.leaderUID || "0");
  data.exp = Math.max(0, Number(data.exp || 0) || 0);
  data.level = clampPositiveInt(data.level, 1, getCityMaxLevel(data.cityID));
  data.mission = normalizeMissionState(data.mission);
  data.eventGroup = normalizeEventGroup(data.eventGroup);
  data.buildings = data.buildings && typeof data.buildings === "object" ? data.buildings : {};
  for (const [key, value] of Object.entries(data.buildings)) {
    const id = positiveInt((value && value.id) || key);
    if (!id) {
      delete data.buildings[key];
      continue;
    }
    if (String(key) !== String(id)) delete data.buildings[key];
    data.buildings[String(id)] = normalizeBuildingState(value, id);
  }
  if (!data.buildings["1"]) data.buildings["1"] = normalizeBuildingState({ id: 1, level: 1 }, 1);
  applyCityMissionExp(data, 0);
  return data;
}

function normalizeMissionState(mission) {
  const data = mission && typeof mission === "object" ? mission : {};
  return {
    currentMissionID: positiveInt(data.currentMissionID) || 0,
    completeTime: String(toBigInt(data.completeTime || 0)),
    startDate: String(toBigInt(data.startDate || 0)),
    stMissionIDList: uniquePositiveInts(data.stMissionIDList),
    refreshToken: String(data.refreshToken || ""),
    refreshNonce: Math.max(0, Number(data.refreshNonce || 0) || 0),
    officialImported: data.officialImported === true,
  };
}

function normalizeEventGroup(group) {
  const data = group && typeof group === "object" ? group : {};
  return {
    worldmapEventID: positiveInt(data.worldmapEventID) || 0,
    eventGroupEndDate: String(toBigInt(data.eventGroupEndDate || 0)),
    eventUid: String(toBigInt(data.eventUid || 0)),
  };
}

function normalizeBuildingState(building, buildID) {
  const data = building && typeof building === "object" ? building : {};
  return {
    buildUID: String(toBigInt(data.buildUID || data.uid || 0)),
    id: positiveInt(data.id) || positiveInt(buildID) || 1,
    level: clampPositiveInt(data.level, 1, 10),
  };
}

function setCityLeader(user, cityID, leaderUID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  city.leaderUnitUID = String(toBigInt(leaderUID || 0));
  return city;
}

function startWorldMapMission(user, cityID, missionID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  refreshCityMissionList(user, city, options);
  const selectedMissionID = positiveInt(missionID) || city.mission.stMissionIDList[0] || firstMissionId();
  if (!city.mission.stMissionIDList.includes(selectedMissionID)) {
    city.mission.stMissionIDList = [selectedMissionID, ...city.mission.stMissionIDList].slice(0, 4);
  }
  const mission = getMissionById(selectedMissionID);
  const nowBinary = binaryNow(options);
  const completeTime = ticksNow(options) + BigInt(Math.max(1, Number(mission && mission.m_MissionTime) || 60)) * TICKS_PER_MINUTE;
  city.mission.currentMissionID = selectedMissionID;
  city.mission.startDate = String(nowBinary);
  city.mission.completeTime = String(completeTime);
  return { city, missionID: selectedMissionID, completeTime };
}

function cancelWorldMapMission(user, cityID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  city.mission.currentMissionID = 0;
  city.mission.completeTime = "0";
  city.mission.startDate = "0";
  return city;
}

function refreshWorldMapMissionList(user, cityID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  city.mission.refreshNonce += options.force ? 1 : 0;
  refreshCityMissionList(user, city, { ...options, force: true });
  return city;
}

function refreshCityMissionList(user, city, options = {}) {
  const mission = normalizeMissionState(city.mission);
  if (!options.force && mission.officialImported && mission.stMissionIDList.length > 0) {
    city.mission = mission;
    return city;
  }
  const token = `${dayKeyFromTicks(ticksNow(options))}:${mission.refreshNonce}`;
  if (!options.force && mission.refreshToken === token && mission.stMissionIDList.length >= 4) {
    city.mission = mission;
    return city;
  }
  const ids = chooseMissionIds(user, city, token, 4);
  if (mission.currentMissionID > 0 && !ids.includes(mission.currentMissionID)) ids[0] = mission.currentMissionID;
  mission.stMissionIDList = uniquePositiveIntsInOrder(ids).slice(0, 4);
  mission.refreshToken = token;
  mission.officialImported = false;
  city.mission = mission;
  return city;
}

function completeWorldMapMission(user, cityID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  const missionID = positiveInt(city.mission.currentMissionID);
  const mission = getMissionById(missionID);
  const now = ticksNow(options);
  const completeTime = toBigInt(city.mission.completeTime || 0);
  if (!missionID) {
    return {
      errorCode: NEC_FAIL_WORLDMAP_MISSION_NOT_DOING,
      city,
      clearedMissionID: 0,
      reward: {},
      isSuccess: false,
      worldMapEventGroup: city.eventGroup,
    };
  }
  if (!mission) {
    return {
      errorCode: NEC_FAIL_WORLDMAP_INVALID_MISSION_ID,
      city,
      clearedMissionID: missionID,
      reward: {},
      isSuccess: false,
      worldMapEventGroup: city.eventGroup,
    };
  }
  const canComplete = missionID > 0 && (completeTime <= now || envFlagDefault(false, "CS_WORLDMAP_ALLOW_EARLY_COMPLETE"));
  if (!canComplete) {
    return {
      errorCode: NEC_FAIL_WORLDMAP_MISSION_DOING,
      city,
      clearedMissionID: missionID,
      reward: {},
      isSuccess: false,
      worldMapEventGroup: city.eventGroup,
    };
  }

  const reward = grantMissionReward(user, mission, options);
  applyCityMissionExp(city, Number(mission && mission.m_RewardCityEXP) || 0);
  city.mission.currentMissionID = 0;
  city.mission.completeTime = "0";
  city.mission.startDate = "0";
  refreshWorldMapMissionList(user, city.cityID, { ...options, force: true });
  const worldMapEventGroup = maybeSpawnRaidEvent(user, city, mission, options);
  return {
    city,
    clearedMissionID: missionID,
    reward,
    isSuccess: true,
    worldMapEventGroup: worldMapEventGroup || city.eventGroup,
  };
}

function grantMissionReward(user, mission, options = {}) {
  const miscItems = [];
  const now = String(binaryNow(options));
  const rows = [
    [ITEM_ID_CREDIT, Number(mission && mission.m_RewardCredit) || 0],
    [ITEM_ID_ETERNIUM, Number(mission && mission.m_RewardEternium) || 0],
    [ITEM_ID_INFORMATION, Number(mission && mission.m_RewardInformation) || 0],
  ];
  for (const [itemId, count] of rows) {
    const item = grantMiscItem(user, itemId, count, 0, { regDate: now });
    if (item) miscItems.push(item);
  }
  const rewardType = String((mission && mission.m_CompleteReward_Type) || "").toUpperCase();
  const rewardId = positiveInt(mission && mission.m_CompleteReward_ID);
  const rewardQuantity = Math.max(0, Number(mission && mission.m_CompleteRewardQuantity) || 0);
  if (rewardType === "RT_MISC" && rewardId > 0 && rewardQuantity > 0) {
    const item = grantMiscItem(user, rewardId, rewardQuantity, 0, { regDate: now });
    if (item) miscItems.push(item);
  }
  return { miscItems };
}

function maybeSpawnRaidEvent(user, city, mission, options = {}) {
  // Check if city already has an active raid event
  const existingEventUid = toBigInt(city.eventGroup && city.eventGroup.eventUid);
  if (existingEventUid > 0n) {
    const state = ensureBareWorldMapState(user, options);
    const existingRaid = state.raids[String(existingEventUid)];
    if (existingRaid && Number(existingRaid.curHP || 0) > 0) {
      // City already has an active raid, don't spawn a new one
      return city.eventGroup;
    }
  }

  const chanceFromEnv = process.env.CS_WORLDMAP_RAID_CHANCE;
  const tableChance = Number(mission && mission.m_WorldmapEventRatio) || 0;
  const searchBonus = getCityBuildingStatValue(city, "CBS_RAID_SEARCH_RATE");
  const chance = chanceFromEnv == null ? clampNumber(tableChance + searchBonus, 0, 100) : clampNumber(Number(chanceFromEnv) || 0, 0, 100);
  if (chance <= 0 && !envFlag("CS_WORLDMAP_FORCE_RAID")) return null;
  const seed = `${city.cityID}:${mission && mission.m_WorldmapMissionID}:${city.exp}:${dayKeyFromTicks(ticksNow(options))}`;
  const roll = hashString(seed) % 100;
  if (!envFlag("CS_WORLDMAP_FORCE_RAID") && roll >= chance) return null;

  const selection = selectWorldMapRaidEvent(city, mission, seed);
  const event = selection.event;
  const durationHours = Math.max(1, Number(event && event.EVENT_DURATION_TIME) || 6);
  const expireTicks = ticksNow(options) + BigInt(durationHours) * TICKS_PER_HOUR;
  const raid = ensureSoloRaid(user, city.cityID, {
    ...options,
    expireTicks,
    stageID: selection.stageID,
    worldmapEventID: selection.eventID,
  });
  city.eventGroup = {
    worldmapEventID: selection.eventID,
    eventGroupEndDate: String(binaryFromTicks(expireTicks)),
    eventUid: String(raid.raidUID),
  };
  return city.eventGroup;
}

function spawnAdminRaid(user, options = {}) {
  const requestedLevel = positiveInt(options.level || options.raidLevel || options.raidLvl || options.lv);
  if (!requestedLevel) {
    return { ok: false, error: "Raid level is required." };
  }

  const cityID = positiveInt(options.branch || options.branchID || options.cityID || options.city) || firstCityId();
  if (!isKnownCityId(cityID)) {
    return { ok: false, error: `Unknown world-map branch ${cityID}.` };
  }
  const state = ensureWorldMapState(user, options);
  const city = ensureCityState(user, cityID, options);
  const selection = selectWorldMapRaidEventByLevel(
    requestedLevel,
    `${cityID}:${requestedLevel}:${ticksNow(options)}:admin-raid`,
    positiveInt(options.groupID || options.eventGroupID)
  );
  if (!selection.eventID || !selection.stageID) {
    return { ok: false, error: `No usable raid event exists for level ${requestedLevel}.` };
  }

  const previousRaidUID = toBigInt(city.eventGroup && city.eventGroup.eventUid);
  if (previousRaidUID > 0n) deleteRaidState(state, previousRaidUID);

  const eventDurationHours = Math.max(1, Number(selection.event && selection.event.EVENT_DURATION_TIME) || 6);
  const durationHours = Math.max(1, Number(options.durationHours || eventDurationHours) || eventDurationHours);
  const expireTicks = ticksNow(options) + BigInt(durationHours) * TICKS_PER_HOUR;
  const raid = ensureSoloRaid(user, cityID, {
    ...options,
    expireTicks,
    stageID: selection.stageID,
    worldmapEventID: selection.eventID,
    adminSpawned: true,
    requestedRaidLevel: requestedLevel,
    raidFamily: selection.raidFamily || "",
  });
  raid.adminSpawned = true;
  state.raids[String(toBigInt(raid.raidUID))] = normalizeRaidState(raid);
  city.eventGroup = {
    worldmapEventID: selection.eventID,
    eventGroupEndDate: String(binaryFromTicks(expireTicks)),
    eventUid: String(raid.raidUID),
  };

  return {
    ok: true,
    city,
    raid: state.raids[String(toBigInt(raid.raidUID))],
    event: selection.event,
    eventID: selection.eventID,
    stageID: selection.stageID,
    requestedLevel,
    actualLevel: selection.raidLevel,
    exactLevel: selection.exactLevel,
    raidFamily: selection.raidFamily || "",
    replacedRaidUID: previousRaidUID > 0n ? String(previousRaidUID) : "0",
    expireDate: city.eventGroup.eventGroupEndDate,
  };
}

function spawnSephiraRaid(user, options = {}) {
  return spawnAdminRaid(user, {
    ...options,
    level: positiveInt(options.level || options.raidLevel || options.raidLvl || options.lv) || 666,
  });
}

function killRaidInBranch(user, options = {}) {
  const cityID = positiveInt(options.branch || options.branchID || options.cityID || options.city);
  if (!cityID) return { ok: false, error: "Branch is required." };
  if (!isKnownCityId(cityID)) return { ok: false, error: `Unknown world-map branch ${cityID}.` };

  const state = ensureWorldMapState(user, options);
  const city = ensureCityState(user, cityID, options);
  const eventRaidUid = toBigInt(city.eventGroup && city.eventGroup.eventUid);
  let raid = eventRaidUid > 0n ? getActiveRaidByUid(user, eventRaidUid, options) : null;
  if (!raid) {
    raid = getActiveRaids(user, options)
      .filter((entry) => positiveInt(entry && entry.cityID) === cityID)
      .sort((left, right) => Number(toBigInt(right.expireDate || 0) - toBigInt(left.expireDate || 0)))[0] || null;
  }
  if (!raid) return { ok: false, error: `No active raid boss exists on branch ${cityID}.` };

  const raidKey = String(toBigInt(raid.raidUID));
  const result = recordRaidBattleResult(user, raid.raidUID, {
    ...options,
    win: true,
    bossKilled: true,
    damageRatio: 1,
    skipRaidCost: true,
    battleKey: `admin-kill:${cityID}:${raidKey}:${ticksNow(options)}`,
  });
  if (result.notFound) return { ok: false, error: `Raid ${raidKey} no longer exists on branch ${cityID}.` };

  const resultRaid = state.raidResults && state.raidResults[raidKey] ? normalizeRaidState(state.raidResults[raidKey]) : normalizeRaidState(result.raid);
  return {
    ok: true,
    city,
    raid: resultRaid,
    raidUID: raidKey,
    stageID: resultRaid.stageID,
    branch: cityID,
    completed: Boolean(result.completed || Number(resultRaid.curHP || 0) <= 0),
    win: Boolean(resultRaid.win || Number(resultRaid.curHP || 0) <= 0),
    damage: result.bossResult && result.bossResult.damage,
  };
}

function clearActiveRaids(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  const includeResults = Boolean(options.includeResults);
  const clearedRaidUids = new Set();
  const clearedCityIds = new Set();
  for (const [raidUid, raid] of Object.entries(state.raids || {})) {
    const normalized = normalizeRaidState(raid);
    const isResult = Boolean(state.raidResults && state.raidResults[raidUid]);
    if (Number(normalized.curHP || 0) <= 0 || isResult) {
      if (!includeResults) continue;
      if (state.raidResults) delete state.raidResults[raidUid];
    }
    delete state.raids[raidUid];
    markRaidDismissed(state, raidUid);
    clearedRaidUids.add(String(toBigInt(raidUid)));
  }
  if (includeResults) {
    for (const raidUid of Object.keys(state.raidResults || {})) {
      delete state.raidResults[raidUid];
      markRaidDismissed(state, raidUid);
      clearedRaidUids.add(String(toBigInt(raidUid)));
    }
  }
  for (const city of Object.values(state.cities || {})) {
    const eventUid = String(toBigInt(city && city.eventGroup && city.eventGroup.eventUid));
    if (clearedRaidUids.has(eventUid)) {
      clearedCityIds.add(positiveInt(city && city.cityID));
      queueRaidEventClearCity(state, city && city.cityID);
      city.eventGroup = normalizeEventGroup(null);
    }
  }
  return { clearedCount: clearedRaidUids.size, clearedRaidUids: Array.from(clearedRaidUids), clearedCityIds: Array.from(clearedCityIds).filter(Boolean) };
}

function clearWorldMapEvent(user, cityID, options = {}) {
  const state = ensureWorldMapState(user, options);
  const city = ensureCityState(user, cityID, options);
  const eventUid = toBigInt(city.eventGroup && city.eventGroup.eventUid);
  if (eventUid > 0n) deleteRaidState(state, eventUid);
  else queueRaidEventClearCity(state, city.cityID);
  city.eventGroup = normalizeEventGroup(null);
  return city;
}

function collectWorldMapIncome(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  const now = ticksNow(options);
  const last = ticksFromDateTimeBinary(state.collectLastResetDate || 0) || now;
  const elapsedHours = Number(clampBigInt((now - last) / TICKS_PER_HOUR, 1n, 168n));
  const cityPower = Object.values(state.cities).reduce((sum, city) => sum + Math.max(1, Number(city.level || 1)), 0);
  const credit = Math.max(0, cityPower * elapsedHours * 250);
  const info = Math.max(0, cityPower * elapsedHours * 5);
  const items = [];
  const regDate = String(binaryNow(options));
  const creditItem = grantMiscItem(user, ITEM_ID_CREDIT, credit, 0, { regDate });
  const infoItem = grantMiscItem(user, ITEM_ID_INFORMATION, info, 0, { regDate });
  if (creditItem) items.push(creditItem);
  if (infoItem) items.push(infoItem);
  state.collectLastResetDate = String(binaryNow(options));
  return { items };
}

function buildCityBuilding(user, cityID, buildID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  const id = positiveInt(buildID) || 1;
  const existing = city.buildings[String(id)];
  const costItems = [];
  if (!existing) {
    const row = getBuildingRow(id, 1);
    const costCredit = Math.max(0, Number(row && row.COST_CREDIT) || 0);
    const spent = costCredit > 0 ? spendMiscItem(user, ITEM_ID_CREDIT, costCredit, { regDate: String(binaryNow(options)) }) : null;
    if (spent) costItems.push(spent);
    city.buildings[String(id)] = {
      buildUID: String(nextWorldMapUid(user, options)),
      id,
      level: 1,
    };
  }
  return { city, building: city.buildings[String(id)], costItems };
}

function levelUpCityBuilding(user, cityID, buildID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  const id = positiveInt(buildID) || 1;
  if (!city.buildings[String(id)]) city.buildings[String(id)] = { buildUID: String(nextWorldMapUid(user, options)), id, level: 1 };
  const building = city.buildings[String(id)];
  const nextLevel = building.level + 1;
  const row = getBuildingRow(id, nextLevel);
  const costItems = [];
  if (row) {
    const costCredit = Math.max(0, Number(row.COST_CREDIT) || 0);
    const spent = costCredit > 0 ? spendMiscItem(user, ITEM_ID_CREDIT, costCredit, { regDate: String(binaryNow(options)) }) : null;
    if (spent) costItems.push(spent);
    building.level = nextLevel;
  }
  return { city, building, costItems };
}

function expireCityBuilding(user, cityID, buildID, options = {}) {
  const city = ensureCityState(user, cityID, options);
  const id = positiveInt(buildID) || 0;
  const building = city.buildings[String(id)];
  let item = null;
  if (building && id !== 1) {
    const row = getBuildingRow(id, building.level);
    const clearCredit = Math.max(0, Number(row && row.CLEAR_CREDIT) || 0);
    delete city.buildings[String(id)];
    if (clearCredit > 0) item = grantMiscItem(user, ITEM_ID_CREDIT, clearCredit, 0, { regDate: String(binaryNow(options)) });
  }
  return { city, item };
}

function startDive(user, req, options = {}) {
  const state = ensureWorldMapState(user, options);
  const city = ensureCityState(user, req.cityID || firstCityId(), options);
  const stageID = positiveInt(req.stageID) || firstDiveStageId();
  const dive = createDiveState(user, {
    stageID,
    deckIndexes: req.deckIndexeList,
    cityID: city.cityID,
    now: options.now,
  });
  state.dive.active = dive;
  const templet = getDiveTemplet(stageID);
  const costItems = [];
  const costItemId = positiveInt(templet && templet.STAGE_REQ_ITEM_ID) || ITEM_ID_DIVE_PERMIT;
  const costCount = Math.max(0, Number(templet && templet.STAGE_REQ_ITEM_COUNT) || 1);
  const spent = spendMiscItem(user, costItemId, costCount, { regDate: String(binaryNow(options)) });
  if (spent) costItems.push(spent);
  return { cityID: city.cityID, dive, costItems };
}

function createDiveState(user, options = {}) {
  const stageID = positiveInt(options.stageID) || firstDiveStageId();
  const templet = getDiveTemplet(stageID);
  const slotCount = Math.max(1, Math.min(5, Number(templet && templet.SLOT_COUNT) || 3));
  const randomSetCount = Math.max(1, Number(templet && templet.RANDOM_SET_COUNT) || 2);
  const slotSets = createDiveSlotSets(stageID, randomSetCount, slotCount);
  const deckIndexes = uniqueNonNegativeInts(options.deckIndexes).slice(0, Math.max(1, Number(templet && templet.SQUAD_COUNT) || 4));
  if (!deckIndexes.length) deckIndexes.push(0);
  const squads = {};
  for (const deckIndex of deckIndexes) squads[String(deckIndex)] = { state: 0, deckIndex, curHp: 100000, maxHp: 100000, supply: 2 };
  const leaderDeckIndex = deckIndexes[0] || 0;
  return normalizeDiveState(
    {
      diveUid: String(nextWorldMapUid(user, options)),
      cityID: positiveInt(options.cityID) || firstCityId(),
      isAuto: false,
      floor: {
        stageID,
        slotSets,
        expireDate: String(ticksNow(options) + TICKS_PER_DAY),
        randomSetCount,
      },
      player: {
        base: {
          state: DIVE_PLAYER_STATE.EXPLORING,
          prevSlotSetIndex: -1,
          prevSlotIndex: 0,
          slotSetIndex: -1,
          slotIndex: 0,
          distance: 0,
          leaderDeckIndex,
          reservedDungeonID: 0,
          reservedDeckIndex: -1,
          artifacts: [],
          reservedArtifacts: [],
        },
        squads,
      },
    },
    options
  );
}

function createDiveSlotSets(stageID, randomSetCount, slotCount) {
  const count = Math.max(1, Number(randomSetCount || 1) || 1);
  const size = Math.max(1, Math.min(5, Number(slotCount || 3) || 3));
  const slotSets = [];
  for (let setIndex = 0; setIndex < count; setIndex += 1) {
    slotSets.push({ slots: Array.from({ length: size }, (_, slotIndex) => createDiveSlot(stageID, slotIndex, false, setIndex)) });
  }
  slotSets.push({ slots: [createDiveSlot(stageID, 0, true, count)] });
  return slotSets;
}

function createDiveSlot(stageID, index, boss, setIndex = 0) {
  const sectorType = boss ? DIVE_SECTOR_TYPE.BOSS : getDivePathSectorType(index, setIndex);
  const eventType = boss ? DIVE_EVENT_TYPE.DUNGEON_BOSS : DIVE_EVENT_TYPE.DUNGEON;
  const eventValue = boss ? getDiveBossDungeonId(stageID, index, setIndex) : getDiveDungeonId(stageID, sectorType, index, setIndex);
  return { sectorType, eventType, eventValue };
}

function getDivePathSectorType(index, setIndex = 0) {
  return [DIVE_SECTOR_TYPE.POINCARE, DIVE_SECTOR_TYPE.REIMANN, DIVE_SECTOR_TYPE.GAUNTLET][(Number(index || 0) + Number(setIndex || 0)) % 3];
}

function normalizeDiveState(dive, options = {}) {
  const data = dive && typeof dive === "object" ? dive : {};
  const stageID = positiveInt(data.stageID || data.floor && data.floor.stageID) || firstDiveStageId();
  const templet = getDiveTemplet(stageID);
  const randomSetCount = Math.max(1, Number((data.floor && data.floor.randomSetCount) || (templet && templet.RANDOM_SET_COUNT)) || 2);
  const slotCount = Math.max(1, Math.min(5, Number(templet && templet.SLOT_COUNT) || 3));
  const floor = data.floor && typeof data.floor === "object" ? data.floor : {};
  const slotSets = normalizeDiveSlotSets(floor.slotSets, stageID, randomSetCount, slotCount);
  const player = data.player && typeof data.player === "object" ? data.player : {};
  const base = player.base && typeof player.base === "object" ? player.base : {};
  const distance = Math.max(0, Number(base.distance || 0) || 0);
  const slotSetIndex = distance === 0 ? -1 : Math.max(0, Number(base.slotSetIndex != null ? base.slotSetIndex : 0) || 0);
  return {
    diveUid: String(toBigInt(data.diveUid || data.DiveUid || 0)),
    cityID: positiveInt(data.cityID) || firstCityId(),
    isAuto: Boolean(data.isAuto),
    floor: {
      stageID,
      randomSetCount,
      slotSets: slotSets.map((set) => ({
        slots: (Array.isArray(set && set.slots) ? set.slots : []).map((slot) => ({
          sectorType: Math.max(0, Number(slot && slot.sectorType) || 0),
          eventType: Math.max(0, Number(slot && slot.eventType) || 0),
          eventValue: Math.max(0, Number(slot && slot.eventValue) || 0),
        })),
      })),
      expireDate: String(toBigInt(floor.expireDate || ticksNow(options) + TICKS_PER_DAY)),
    },
    player: {
      base: {
        state: Math.max(0, Number(base.state || 0) || 0),
        prevSlotSetIndex: Number(base.prevSlotSetIndex != null ? base.prevSlotSetIndex : -1),
        prevSlotIndex: Number(base.prevSlotIndex || 0) || 0,
        slotSetIndex,
        slotIndex: Number(base.slotIndex || 0) || 0,
        distance,
        leaderDeckIndex: Number(base.leaderDeckIndex || 0) || 0,
        reservedDungeonID: Number(base.reservedDungeonID || 0) || 0,
        reservedDeckIndex: Number(base.reservedDeckIndex != null ? base.reservedDeckIndex : -1),
        artifacts: uniquePositiveInts(base.artifacts),
        reservedArtifacts: uniquePositiveInts(base.reservedArtifacts),
      },
      squads: normalizeDiveSquads(player.squads),
    },
  };
}

function normalizeDiveSlotSets(sourceSlotSets, stageID, randomSetCount, slotCount) {
  const needed = Math.max(1, Number(randomSetCount || 1) || 1) + 1;
  const rawSlotSets = (Array.isArray(sourceSlotSets) ? sourceSlotSets : [])
    .map((set) => ({
      slots: (Array.isArray(set && set.slots) ? set.slots : []).filter(Boolean),
    }))
    .filter((set) => set.slots.length > 0);

  if (
    rawSlotSets.length > 0 &&
    rawSlotSets[0].slots.length === 1 &&
    (Number(rawSlotSets[0].slots[0].sectorType || 0) === DIVE_SECTOR_TYPE.START || Number(rawSlotSets[0].slots[0].sectorType || 0) === 0)
  ) {
    rawSlotSets.shift();
  }

  const slotSets = rawSlotSets
    .map((set, setIndex) => ({
      slots: (Array.isArray(set && set.slots) ? set.slots : []).map((slot, slotIndex) =>
        normalizeDiveSlot(slot, stageID, slotIndex, setIndex, setIndex >= needed - 1)
      ),
    }))
    .filter((set) => set.slots.length > 0);

  for (let index = slotSets.length; index < needed; index += 1) {
    const boss = index >= needed - 1;
    slotSets.push({
      slots: boss
        ? [createDiveSlot(stageID, 0, true, index)]
        : Array.from({ length: slotCount }, (_, slotIndex) => createDiveSlot(stageID, slotIndex, false, index)),
    });
  }
  return slotSets.slice(0, needed);
}

function normalizeDiveSlot(slot, stageID, slotIndex, setIndex, boss = false) {
  const sectorType = Math.max(0, Number(slot && slot.sectorType) || 0);
  const eventType = Math.max(0, Number(slot && slot.eventType) || 0);
  const eventValue = Math.max(0, Number(slot && slot.eventValue) || 0);
  const isBoss =
    boss ||
    sectorType === DIVE_SECTOR_TYPE.BOSS ||
    eventType === DIVE_EVENT_TYPE.DUNGEON_BOSS;
  if (isBoss) return createDiveSlot(stageID, 0, true, setIndex);

  const playableSectorType = DIVE_DUNGEON_PREFIX_BY_SECTOR[sectorType] ? sectorType : getDivePathSectorType(slotIndex, setIndex);
  if (eventType === DIVE_EVENT_TYPE.DUNGEON && getKnownDungeonId(eventValue)) {
    return { sectorType: playableSectorType, eventType, eventValue };
  }
  return createDiveSlot(stageID, slotIndex, false, setIndex);
}

function normalizeDiveSquads(squads) {
  const result = {};
  const source = squads && typeof squads === "object" ? squads : {};
  for (const [key, squad] of Object.entries(source)) {
    const deckIndex = Number((squad && squad.deckIndex) || key) || 0;
    result[String(deckIndex)] = {
      state: Math.max(0, Number(squad && squad.state) || 0),
      deckIndex,
      curHp: Math.max(0, Number(squad && squad.curHp != null ? squad.curHp : 100000) || 0),
      maxHp: Math.max(1, Number(squad && squad.maxHp != null ? squad.maxHp : 100000) || 1),
      supply: Math.max(0, Number(squad && squad.supply != null ? squad.supply : 2) || 0),
    };
  }
  return result;
}

function moveDiveForward(user, slotIndex, options = {}) {
  const dive = getActiveDive(user, options) || createDiveState(user, options);
  const base = dive.player.base;
  const nextSetIndex = Math.min(dive.floor.slotSets.length - 1, base.distance === 0 ? 0 : base.slotSetIndex + 1);
  const slots = dive.floor.slotSets[nextSetIndex] ? dive.floor.slotSets[nextSetIndex].slots : [];
  const nextSlotIndex = Math.max(0, Math.min(Math.max(0, slots.length - 1), Number(slotIndex || 0) || 0));
  const selectedSlot = slots[nextSlotIndex] || createDiveSlot(dive.floor.stageID, nextSlotIndex, false, nextSetIndex);
  base.prevSlotSetIndex = base.slotSetIndex;
  base.prevSlotIndex = base.slotIndex;
  base.slotSetIndex = nextSetIndex;
  base.slotIndex = nextSlotIndex;
  base.distance += 1;
  base.reservedDeckIndex = -1;
  base.reservedArtifacts = [];
  if (isDiveBattleEvent(selectedSlot.eventType)) {
    base.state = DIVE_PLAYER_STATE.BATTLE_READY;
    base.reservedDungeonID =
      positiveInt(selectedSlot.eventValue) ||
      (Number(selectedSlot.eventType || 0) === DIVE_EVENT_TYPE.DUNGEON_BOSS
        ? getDiveBossDungeonId(dive.floor.stageID, nextSlotIndex, nextSetIndex)
        : getDiveDungeonId(dive.floor.stageID, selectedSlot.sectorType, nextSlotIndex, nextSetIndex));
  } else {
    base.state = DIVE_PLAYER_STATE.EXPLORING;
    base.reservedDungeonID = 0;
  }
  setActiveDive(user, dive, options);
  return { dive, syncData: { updatedPlayer: cloneDivePlayerBase(base) } };
}

function giveUpDive(user) {
  if (user && user.worldMap && user.worldMap.dive) user.worldMap.dive.active = null;
}

function setDiveAuto(user, isAuto, options = {}) {
  const dive = getActiveDive(user, options);
  if (dive) {
    dive.isAuto = Boolean(isAuto);
    setActiveDive(user, dive, options);
  } else {
    const state = ensureWorldMapState(user, options);
    state.dive.isAuto = Boolean(isAuto);
  }
}

function selectDiveArtifact(user, artifactID, options = {}) {
  const dive = getActiveDive(user, options) || createDiveState(user, options);
  const id = positiveInt(artifactID);
  if (id > 0 && !dive.player.base.artifacts.includes(id)) dive.player.base.artifacts.push(id);
  dive.player.base.state = 0;
  setActiveDive(user, dive, options);
  return { dive, syncData: { updatedPlayer: dive.player.base } };
}

function suicideDiveSquad(user, deckIndex, options = {}) {
  const dive = getActiveDive(user, options) || createDiveState(user, options);
  const key = String(Number(deckIndex || 0) || 0);
  if (dive.player.squads[key]) {
    dive.player.squads[key].state = 1;
    dive.player.squads[key].curHp = 0;
  }
  setActiveDive(user, dive, options);
  return { dive, syncData: { updatedSquads: dive.player.squads[key] ? [dive.player.squads[key]] : [] } };
}

function prepareDiveGameLoad(user, req = {}, options = {}) {
  const dive = getActiveDive(user, options);
  if (!dive) return null;
  const base = dive.player.base;
  const selectedSlot = getDivePlayerSlot(dive);
  const dungeonID =
    positiveInt(base.reservedDungeonID) ||
    positiveInt(selectedSlot && selectedSlot.eventValue) ||
    (Number(selectedSlot && selectedSlot.eventType) === DIVE_EVENT_TYPE.DUNGEON_BOSS
      ? getDiveBossDungeonId(dive.floor.stageID, base.slotIndex, base.slotSetIndex)
      : getDiveDungeonId(dive.floor.stageID, selectedSlot && selectedSlot.sectorType, base.slotIndex, base.slotSetIndex));
  if (!dungeonID) return null;
  const deckIndex = Math.max(0, Number(req.selectDeckIndex != null ? req.selectDeckIndex : base.leaderDeckIndex) || 0);
  base.state = DIVE_PLAYER_STATE.BATTLE_LOAD;
  base.reservedDungeonID = dungeonID;
  base.reservedDeckIndex = deckIndex;
  base.leaderDeckIndex = deckIndex;
  setActiveDive(user, dive, options);
  return {
    dive,
    diveStageID: dive.floor.stageID,
    dungeonID,
    deckIndex,
    selectedSlot,
  };
}

function completeDiveBattle(user, dynamicGame = {}, battleState = {}, options = {}) {
  const diveStageID = positiveInt(dynamicGame.diveStageID || dynamicGame.diveStageId || dynamicGame.diveID || dynamicGame.diveId);
  if (!diveStageID) return null;
  const dive = getActiveDive(user, options);
  if (!dive || positiveInt(dive.floor.stageID) !== diveStageID) return null;

  const base = dive.player.base;
  const selectedSlot = getDivePlayerSlot(dive);
  const deckIndex = Math.max(0, Number(base.reservedDeckIndex != null ? base.reservedDeckIndex : dynamicGame.deckIndex || 0) || 0);
  const syncData = {
    updatedPlayer: null,
    updatedSquads: [],
    rewardData: null,
    artifactRewardData: null,
    stormMiscReward: null,
  };

  const squad = dive.player.squads[String(deckIndex)];
  if (squad) {
    squad.supply = Math.max(0, Number(squad.supply || 0) - 1);
    syncData.updatedSquads.push({ ...squad });
  }

  const win = options.win !== false && !isDiveBattleLoss(battleState);
  if (!win) {
    base.state = Object.values(dive.player.squads).some((item) => item && Number(item.curHp || 0) > 0) ? DIVE_PLAYER_STATE.BATTLE_READY : DIVE_PLAYER_STATE.ANNIHILATION;
    base.reservedDeckIndex = -1;
    syncData.updatedPlayer = cloneDivePlayerBase(base);
    setActiveDive(user, dive, options);
    return { dive, syncData, cleared: false };
  }

  const clearDive =
    Number(selectedSlot && selectedSlot.eventType) === DIVE_EVENT_TYPE.DUNGEON_BOSS ||
    base.distance >= Number(dive.floor.randomSetCount || 1) + 1;
  base.reservedDungeonID = 0;
  base.reservedDeckIndex = -1;
  base.reservedArtifacts = [];
  if (clearDive) {
    base.state = DIVE_PLAYER_STATE.CLEAR;
    syncData.rewardData = grantDiveReward(user, getDiveTemplet(dive.floor.stageID), String(binaryNow(options)));
    markDiveCleared(user, dive.floor.stageID, options);
    syncData.updatedPlayer = cloneDivePlayerBase(base);
    giveUpDive(user);
    return { dive, syncData, cleared: true };
  }

  base.state = DIVE_PLAYER_STATE.EXPLORING;
  syncData.updatedPlayer = cloneDivePlayerBase(base);
  setActiveDive(user, dive, options);
  return { dive, syncData, cleared: false };
}

function isDiveBattleEvent(eventType) {
  return Number(eventType || 0) === DIVE_EVENT_TYPE.DUNGEON || Number(eventType || 0) === DIVE_EVENT_TYPE.DUNGEON_BOSS;
}

function isDiveBattleLoss(battleState = {}) {
  if (!battleState || typeof battleState !== "object") return false;
  if (battleState.giveup === true || battleState.Giveup === true) return true;
  if (battleState.win === false || battleState.Win === false) return true;
  if (battleState.gameState && Number(battleState.gameState.winTeam || 0) === 3) return true;
  return false;
}

function getDivePlayerSlot(dive) {
  if (!dive || !dive.floor || !dive.player || !dive.player.base) return null;
  const base = dive.player.base;
  const slotSet = dive.floor.slotSets[Number(base.slotSetIndex || 0)];
  if (!slotSet || !Array.isArray(slotSet.slots)) return null;
  return slotSet.slots[Number(base.slotIndex || 0)] || null;
}

function cloneDivePlayerBase(base = {}) {
  return {
    state: Number(base.state || 0) || 0,
    prevSlotSetIndex: Number(base.prevSlotSetIndex != null ? base.prevSlotSetIndex : -1),
    prevSlotIndex: Number(base.prevSlotIndex || 0) || 0,
    slotSetIndex: Number(base.slotSetIndex != null ? base.slotSetIndex : -1),
    slotIndex: Number(base.slotIndex || 0) || 0,
    distance: Math.max(0, Number(base.distance || 0) || 0),
    leaderDeckIndex: Number(base.leaderDeckIndex || 0) || 0,
    reservedDungeonID: Number(base.reservedDungeonID || 0) || 0,
    reservedDeckIndex: Number(base.reservedDeckIndex != null ? base.reservedDeckIndex : -1),
    artifacts: Array.isArray(base.artifacts) ? base.artifacts.slice() : [],
    reservedArtifacts: Array.isArray(base.reservedArtifacts) ? base.reservedArtifacts.slice() : [],
  };
}

function skipDive(user, req, options = {}) {
  const stageID = positiveInt(req.stageId) || firstDiveStageId();
  const skipCount = Math.max(1, Math.min(99, Number(req.skipCount || 1) || 1));
  const templet = getDiveTemplet(stageID);
  const rewards = [];
  const costItems = [];
  const regDate = String(binaryNow(options));
  for (let index = 0; index < skipCount; index += 1) {
    rewards.push(grantDiveReward(user, templet, regDate));
  }
  const costItemId = positiveInt(templet && templet.STAGE_REQ_ITEM_ID) || ITEM_ID_DIVE_PERMIT;
  const costCount = Math.max(0, Number(templet && templet.STAGE_REQ_ITEM_COUNT) || 1) * skipCount;
  const spent = spendMiscItem(user, costItemId, costCount, { regDate });
  if (spent) costItems.push(spent);
  markDiveCleared(user, stageID, options);
  giveUpDive(user);
  return { rewards, costItems, deletedEventCityId: 0, skipCount, stageID };
}

function grantDiveReward(user, templet, regDate) {
  const miscItems = [];
  for (let index = 1; index <= 3; index += 1) {
    const type = String((templet && templet[`FIRSTREWARD_TYPE_${index}`]) || "").toUpperCase();
    const id = positiveInt(templet && templet[`FIRSTREWARD_ID_${index}`]);
    const quantity = Math.max(0, Number(templet && templet[`FIRSTREWARD_QUANTITY_${index}`]) || 0);
    if (type === "RT_MISC" && id > 0 && quantity > 0) {
      const item = grantMiscItem(user, id, quantity, 0, { regDate });
      if (item) miscItems.push(item);
    }
  }
  if (!miscItems.length) {
    const item = grantMiscItem(user, ITEM_ID_CREDIT, 10000, 0, { regDate });
    if (item) miscItems.push(item);
  }
  return { miscItems };
}

function markDiveCleared(user, stageID, options = {}) {
  const state = ensureWorldMapState(user, options);
  state.diveClearStages = uniquePositiveInts([...state.diveClearStages, stageID]);
  state.diveHistoryStages = uniquePositiveInts([...state.diveHistoryStages, stageID]);
}

function getActiveDive(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  if (!state.dive || !state.dive.active) return null;
  const dive = normalizeDiveState(state.dive.active, options);
  state.dive.active = dive;
  return dive;
}

function setActiveDive(user, dive, options = {}) {
  const state = ensureWorldMapState(user, options);
  state.dive.active = normalizeDiveState(dive, options);
}

function buildDiveGameData(dive) {
  const data = normalizeDiveState(dive || {});
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.diveUid || 0)),
    writeNullableObject(buildDiveFloorData(data.floor)),
    writeNullableObject(buildDivePlayerData(data.player)),
  ]);
}

function buildDiveFloorData(floor) {
  const data = floor || {};
  return Buffer.concat([
    writeSignedVarInt(positiveInt(data.stageID) || firstDiveStageId()),
    writeObjectList((Array.isArray(data.slotSets) ? data.slotSets : []).map((slotSet) => writeNullableObject(buildDiveSlotSetData(slotSet)))),
    writeSignedVarLong(toBigInt(data.expireDate || 0)),
  ]);
}

function buildDiveSlotSetData(slotSet) {
  return writeObjectList((Array.isArray(slotSet && slotSet.slots) ? slotSet.slots : []).map((slot) => writeNullableObject(buildDiveSlotData(slot))));
}

function buildDiveSlotData(slot) {
  const data = slot || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.sectorType || 0) || 0),
    writeSignedVarInt(Number(data.eventType || 0) || 0),
    writeSignedVarInt(Number(data.eventValue || 0) || 0),
  ]);
}

function buildDivePlayerData(player) {
  const data = player || {};
  const squads = normalizeDiveSquads(data.squads);
  const entries = Object.values(squads)
    .sort((a, b) => a.deckIndex - b.deckIndex)
    .map((squad) => [squad.deckIndex, buildDiveSquadData(squad)]);
  return Buffer.concat([writeNullableObject(buildDivePlayerBaseData(data.base || {})), writeObjectMapInt(entries)]);
}

function buildDivePlayerBaseData(base) {
  const data = base || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.state || 0) || 0),
    writeSignedVarInt(Number(data.prevSlotSetIndex || 0) || 0),
    writeSignedVarInt(Number(data.prevSlotIndex || 0) || 0),
    writeSignedVarInt(Number(data.slotSetIndex != null ? data.slotSetIndex : 0) || 0),
    writeSignedVarInt(Number(data.slotIndex || 0) || 0),
    writeSignedVarInt(Number(data.distance || 0) || 0),
    writeSignedVarInt(Number(data.leaderDeckIndex || 0) || 0),
    writeSignedVarInt(Number(data.reservedDungeonID || 0) || 0),
    writeSignedVarInt(Number(data.reservedDeckIndex != null ? data.reservedDeckIndex : -1)),
    writeIntList(data.artifacts || []),
    writeIntList(data.reservedArtifacts || []),
  ]);
}

function buildDiveSquadData(squad) {
  const data = squad || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.state || 0) || 0),
    writeSignedVarInt(Number(data.deckIndex || 0) || 0),
    writeFloatLE(Number(data.curHp || 0) || 0),
    writeFloatLE(Number(data.maxHp || 0) || 0),
    writeSignedVarInt(Number(data.supply || 0) || 0),
  ]);
}

function buildDiveSyncData(syncData) {
  const data = syncData || {};
  return Buffer.concat([
    writeNullableObjectOrNull(data.updatedPlayer ? buildDivePlayerBaseData(data.updatedPlayer) : null),
    writeObjectList((Array.isArray(data.updatedSquads) ? data.updatedSquads : []).map((squad) => writeNullableObject(buildDiveSquadData(squad)))),
    writeObjectList((Array.isArray(data.addedSlotSets) ? data.addedSlotSets : []).map((slotSet) => writeNullableObject(buildDiveSlotSetData(slotSet)))),
    writeObjectList((Array.isArray(data.updatedSlots) ? data.updatedSlots : []).map((slot) => writeNullableObject(buildDiveSlotWithIndexesData(slot)))),
    writeNullableObjectOrNull(data.rewardData ? buildRewardData(data.rewardData) : null),
    writeNullableObjectOrNull(data.artifactRewardData ? buildRewardData(data.artifactRewardData) : null),
    writeNullableObjectOrNull(data.stormMiscReward ? buildItemMiscData(data.stormMiscReward) : null),
  ]);
}

function buildDiveSlotWithIndexesData(slotWithIndexes) {
  const data = slotWithIndexes || {};
  return Buffer.concat([
    writeNullableObject(buildDiveSlotData(data.slot || {})),
    writeSignedVarInt(Number(data.slotSetIndex || 0) || 0),
    writeSignedVarInt(Number(data.slotIndex || 0) || 0),
  ]);
}

function ensureSoloRaid(user, cityID, options = {}) {
  const state = ensureWorldMapState(user, options);
  const raidUid = String(options.raidUid ? toBigInt(options.raidUid) : nextWorldMapUid(user, options));
  forgetDismissedRaid(state, raidUid);
  const existing = state.raids[raidUid];
  if (existing) {
    const normalized = normalizeRaidState(existing);
    const selectedStageID = positiveInt(options.stageID);
    const selectedEventID = positiveInt(options.worldmapEventID);
    if (selectedStageID || selectedEventID) applyRaidEventLink(normalized, selectedEventID || normalized.worldmapEventID, selectedStageID || normalized.stageID);
    if (options.adminSpawned != null) normalized.adminSpawned = Boolean(options.adminSpawned);
    if (options.requestedRaidLevel != null) normalized.requestedRaidLevel = positiveInt(options.requestedRaidLevel);
    if (options.raidFamily != null) normalized.raidFamily = String(options.raidFamily || "");
    state.raids[raidUid] = normalized;
    return normalized;
  }
  const stageID = positiveInt(options.stageID) || chooseSoloRaidStage(cityID, options);
  const raidTemplet = getRaidTemplet(stageID);
  const maxHP = getRaidMaxHpForStage(stageID);
  const expireTicks = toBigInt(options.expireTicks || ticksNow(options) + 6n * TICKS_PER_HOUR);
  const city = state.cities[String(positiveInt(cityID) || firstCityId())] || { cityID };
  const raid = normalizeRaidState({
    raidUID: raidUid,
    stageID,
    cityID: positiveInt(cityID) || firstCityId(),
    curHP: maxHP,
    maxHP,
    isCoop: false,
    isNew: true,
    expireDate: String(expireTicks),
    seasonID: currentRaidSeasonId(options),
    worldmapEventID: positiveInt(options.worldmapEventID) || selectWorldMapRaidEvent(city, null, "", stageID).eventID,
    adminSpawned: Boolean(options.adminSpawned),
    requestedRaidLevel: positiveInt(options.requestedRaidLevel),
    raidFamily: String(options.raidFamily || ""),
  });
  state.raids[raidUid] = raid;
  return raid;
}

function normalizeRaidState(raid) {
  const data = raid && typeof raid === "object" ? raid : {};
  const stageID = positiveInt(data.stageID) || chooseSoloRaidStage(1);
  const raidTemplet = getRaidTemplet(stageID);
  const computedMaxHP = getRaidMaxHpForStage(stageID);
  const basisMaxHP = Math.max(1, Number(raidTemplet && raidTemplet.Raid_Damage_Basis) || 100000);
  const storedMaxHP = Math.max(0, Number(data.maxHP || data.maxHp || 0) || 0);
  const shouldRescaleLegacyHp =
    computedMaxHP > 0 &&
    storedMaxHP > 0 &&
    Math.abs(storedMaxHP - computedMaxHP) > 0.5 &&
    (Math.abs(storedMaxHP - basisMaxHP) <= 0.5 || Math.abs(storedMaxHP - 100000) <= 0.5);
  const maxHP = shouldRescaleLegacyHp || !storedMaxHP ? computedMaxHP : storedMaxHP;
  const hpScale = shouldRescaleLegacyHp && storedMaxHP > 0 ? maxHP / storedMaxHP : 1;
  const rawCurHP = data.curHP != null ? Number(data.curHP) : maxHP;
  const curHP = Number.isFinite(rawCurHP) ? clampNumber(Math.round(rawCurHP * hpScale), 0, maxHP) : maxHP;
  const damage = Math.round(Math.max(0, Number(data.damage || 0) || 0) * hpScale);
  const lastBattleDamage = Math.round(Math.max(0, Number(data.lastBattleDamage || 0) || 0) * hpScale);
  const battleHistory = shouldRescaleLegacyHp ? scaleRaidBattleHistory(data.battleHistory, hpScale) : normalizeRaidBattleHistory(data.battleHistory);
  const inferredTryCount = Math.max(
    0,
    Number(data.tryCount || 0) || 0,
    battleHistory.filter((entry) => entry && (entry.battleKey || entry.damage > 0)).length,
    damage > 0 || lastBattleDamage > 0 ? 1 : 0
  );
  return {
    raidUID: String(toBigInt(data.raidUID || data.raidUid || 0)),
    stageID,
    cityID: positiveInt(data.cityID) || firstCityId(),
    curHP,
    maxHP,
    isCoop: Boolean(data.isCoop),
    isNew: data.isNew !== false,
    expireDate: String(toBigInt(data.expireDate || 0)),
    seasonID: positiveInt(data.seasonID) || currentRaidSeasonId(),
    damage,
    lastBattleDamage,
    battleHistory,
    tryCount: inferredTryCount,
    reservedBattleKeys: normalizeRaidBattleKeys(data.reservedBattleKeys || data.attemptBattleKeys),
    lastAttemptKey: String(data.lastAttemptKey || ""),
    accepted: Boolean(data.accepted),
    worldmapEventID: positiveInt(data.worldmapEventID) || 0,
    lastBattleKey: String(data.lastBattleKey || ""),
    adminSpawned: Boolean(data.adminSpawned),
    requestedRaidLevel: positiveInt(data.requestedRaidLevel || data.requestedLevel),
    raidFamily: String(data.raidFamily || ""),
    win: data.win != null ? Boolean(data.win) : curHP <= 0 && !Boolean(data.giveup),
    giveup: Boolean(data.giveup),
  };
}

function getActiveRaids(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  if (envFlagDefault(false, "CS_WORLDMAP_DEFAULT_SOLO_RAID") && !Object.keys(state.raids).length) {
    ensureSoloRaid(user, firstCityId(), options);
  }
  const now = ticksNow(options);
  return Object.values(state.raids)
    .map(normalizeRaidState)
    .filter((raid) => Number(raid.curHP || 0) > 0)
    .filter((raid) => !isRaidDismissed(state, raid.raidUID))
    .filter((raid) => !(state.raidResults && state.raidResults[String(toBigInt(raid.raidUID))]))
    .filter((raid) => toBigInt(raid.expireDate) > now || isRaidReferencedByCity(state, raid.raidUID));
}

function getRaidByUid(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const key = String(toBigInt(raidUID || 0));
  if (isRaidDismissed(state, key)) return null;
  if (state.raidResults && state.raidResults[key]) return null;
  return state.raids[key] ? normalizeRaidState(state.raids[key]) : null;
}

function getActiveRaidByUid(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const key = String(toBigInt(raidUID || 0));
  if (isRaidDismissed(state, key)) return null;
  if (state.raidResults && state.raidResults[key]) return null;
  const raid = state.raids[key] ? normalizeRaidState(state.raids[key]) : null;
  return raid && Number(raid.curHP || 0) > 0 ? raid : null;
}

function getRaidResultByUid(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  const key = String(toBigInt(raidUID || 0));
  if (isRaidDismissed(state, key)) return null;
  return state.raidResults && state.raidResults[key] ? normalizeRaidState(state.raidResults[key]) : null;
}

function resolveRaidForGameLoad(user, raidUID, options = {}) {
  const requestedUid = toBigInt(raidUID || 0);
  const requested = requestedUid > 0n ? getActiveRaidByUid(user, requestedUid, options) : null;
  if (requested) return requested;

  if (requestedUid > 0n) {
    const repaired = repairRaidFromCityEvent(user, requestedUid, options);
    if (repaired && Number(repaired.curHP || 0) > 0) return repaired;
    return null;
  }

  const activeRaids = getActiveRaids(user, options).filter((raid) => Number(raid.curHP || 0) > 0);
  if (activeRaids.length === 1) return activeRaids[0];
  if (activeRaids.length > 1) {
    return activeRaids
      .slice()
      .sort((left, right) => Number(toBigInt(right.expireDate || 0) - toBigInt(left.expireDate || 0)))[0];
  }
  return null;
}

function repairRaidFromCityEvent(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  const key = String(toBigInt(raidUID || 0));
  if (isRaidDismissed(state, key)) {
    clearRaidEventGroupForUid(state, key);
    return null;
  }
  for (const city of Object.values(state.cities || {})) {
    const eventGroup = city && city.eventGroup;
    if (String(toBigInt(eventGroup && eventGroup.eventUid)) !== key) continue;
    const event = getWorldMapEventById(eventGroup.worldmapEventID);
    if (!isUsableWorldMapRaidEvent(event)) continue;
    return ensureSoloRaid(user, city.cityID, {
      ...options,
      raidUid: key,
      stageID: positiveInt(event.STAGE_ID),
      worldmapEventID: positiveInt(event.EVENT_ID),
      expireTicks: ticksFromDateTimeBinary(eventGroup.eventGroupEndDate) || ticksNow(options) + 3n * TICKS_PER_HOUR,
    });
  }
  return null;
}

function sweepRaid(user, raidUID, options = {}) {
  const raid = getActiveRaidByUid(user, raidUID, options);
  if (!raid) {
    return {
      ok: false,
      errorCode: getRaidResultByUid(user, raidUID, options) ? NEC_FAIL_RAID_HAS_BEEN_DEFEATED : NEC_FAIL_RAID_NOT_EXIST,
      raidUid: toBigInt(raidUID || 0),
    };
  }
  const result = recordRaidBattleResult(user, raidUID, { ...options, win: true, damageRatio: 1, battleKey: `sweep:${raidUID}:${ticksNow(options)}` });
  const updatedRaid = result.raid;
  return {
    ok: true,
    raidUid: toBigInt(updatedRaid.raidUID),
    raid: updatedRaid,
    costItems: result.costItems,
    bossResult: result.bossResult,
  };
}

function reserveRaidAttempt(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const raidKey = String(toBigInt(raidUID || 0));
  if (toBigInt(raidUID || 0) <= 0n || state.raidResults[raidKey]) {
    return { ok: false, errorCode: getRaidResultByUid(user, raidUID, options) ? NEC_FAIL_RAID_HAS_BEEN_DEFEATED : NEC_FAIL_RAID_NOT_EXIST };
  }
  const raid = state.raids[raidKey] ? normalizeRaidState(state.raids[raidKey]) : null;
  if (!raid || Number(raid.curHP || 0) <= 0) {
    return { ok: false, errorCode: NEC_FAIL_RAID_NOT_EXIST };
  }
  const battleKey = String(options.battleKey || makeRaidBattleKey(raidKey, options.gameUID || options.gameUid, raid.stageID, raid.stageID));
  if (battleKey && isRaidAttemptReserved(raid, battleKey)) {
    return { ok: true, raid, duplicate: true };
  }
  const tryLimit = getRaidTryLimit(raid);
  if (tryLimit > 0 && Number(raid.tryCount || 0) >= tryLimit) {
    return { ok: false, errorCode: NEC_FAIL_RAID_EXCEEDED_TRY_COUNT, raid };
  }
  raid.tryCount = Math.max(0, Number(raid.tryCount || 0) || 0) + 1;
  raid.lastAttemptKey = battleKey;
  raid.reservedBattleKeys = appendRaidBattleKey(raid.reservedBattleKeys, battleKey);
  raid.isNew = false;
  state.raids[raidKey] = normalizeRaidState(raid);
  return { ok: true, raid: state.raids[raidKey], duplicate: false };
}

function recordRaidBattleResult(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const requestedRaidUid = toBigInt(raidUID || 0);
  const requestedRaidKey = String(requestedRaidUid);
  if (requestedRaidUid > 0n && state.raidResults[requestedRaidKey]) {
    const resultRaid = normalizeRaidState(state.raidResults[requestedRaidKey]);
    clearRaidEventGroupForUid(state, requestedRaidKey);
    delete state.raids[requestedRaidKey];
    return {
      raid: resultRaid,
      costItems: [],
      bossResult: buildRaidBossResultForState(resultRaid, 0),
      completed: true,
      duplicate: true,
    };
  }
  let raid = requestedRaidUid > 0n ? getActiveRaidByUid(user, requestedRaidUid, options) : null;
  if (!raid && requestedRaidUid <= 0n) {
    const activeRaids = getActiveRaids(user, options).filter((activeRaid) => Number(activeRaid.curHP || 0) > 0);
    if (activeRaids.length === 1) raid = activeRaids[0];
  }
  if (!raid) {
    return {
      raid: normalizeRaidState({ raidUID: requestedRaidUid, stageID: chooseSoloRaidStage(firstCityId()), curHP: 0, maxHP: 1 }),
      costItems: [],
      bossResult: { initHp: 0, curHP: 0, maxHp: 0, damage: 0 },
      completed: false,
      duplicate: true,
      notFound: true,
      errorCode: NEC_FAIL_RAID_NOT_EXIST,
    };
  }
  const raidKey = String(toBigInt(raid.raidUID));
  const battleKey = String(options.battleKey || options.gameUID || options.gameUid || "");
  const existing = state.raids[raidKey] ? normalizeRaidState(state.raids[raidKey]) : raid;
  const hpScale = applyRaidCombatHpScale(existing, options.battleState || options);
  if (hpScale.changed) state.raids[raidKey] = normalizeRaidState(existing);
  const win = options.win !== false && options.giveup !== true;
  const duplicateBattle = Boolean(battleKey && existing.lastBattleKey === battleKey);
  const reservedAttempt = Boolean(battleKey && isRaidAttemptReserved(existing, battleKey));
  if (duplicateBattle) {
    return {
      raid: existing,
      costItems: [],
      bossResult: buildRaidBossResultForState(existing, 0),
      completed: Number(existing.curHP || 0) <= 0,
      duplicate: true,
    };
  }

  const initHp = Math.max(0, Number(existing.curHP != null ? existing.curHP : existing.maxHP) || 0);
  const maxHp = Math.max(1, Number(existing.maxHP || initHp || 100000) || 100000);
  const damageInfo = resolveRaidBattleDamage(existing, options, { initHp, maxHp, win });
  const damage = clampNumber(damageInfo.damage, 0, initHp);

  existing.curHP = Math.max(0, initHp - damage);
  existing.win = Boolean(win && existing.curHP <= 0);
  existing.giveup = Boolean(options.giveup);
  existing.damage = Math.max(0, Number(existing.damage || 0) || 0) + damage;
  existing.lastBattleDamage = damage;
  existing.tryCount = Math.max(0, Number(existing.tryCount || 0) || 0) + (reservedAttempt ? 0 : 1);
  existing.isNew = false;
  if (battleKey) existing.lastBattleKey = battleKey;
  existing.battleHistory = appendRaidBattleHistory(existing.battleHistory, {
    battleKey,
    gameUID: String(options.gameUID || options.gameUid || ""),
    at: String(binaryNow(options)),
    damage,
    initHp,
    curHP: existing.curHP,
    maxHp,
    damageRatio: damageInfo.damageRatio,
    combatDamage: damageInfo.combatDamage,
    combatMaxHp: damageInfo.combatMaxHp,
    combatCurHp: damageInfo.combatCurHp,
    bossKilled: damageInfo.bossKilled,
    tryAssist: Boolean(options.tryAssist),
  });
  const costItems = duplicateBattle ? [] : spendRaidAttemptCost(user, existing, options);
  const normalized = normalizeRaidState(existing);
  state.raids[raidKey] = normalized;
  if (normalized.curHP <= 0) {
    state.raidResults[raidKey] = normalizeRaidState({ ...normalized, accepted: false });
    delete state.raids[raidKey];
    clearRaidEventGroupForUid(state, raidKey);
  }
  updateRaidSeasonFromBattle(user, normalized, { ...options, damage });
  return {
    raid: normalized,
    costItems,
    completed: normalized.curHP <= 0,
    bossResult: {
      initHp,
      curHP: Number(normalized.curHP || 0),
      maxHp,
      damage,
    },
  };
}

function normalizeRaidBattleHistory(history) {
  return (Array.isArray(history) ? history : [])
    .map((entry) => {
      const data = entry && typeof entry === "object" ? entry : {};
      const damage = Math.max(0, Number(data.damage || 0) || 0);
      return {
        battleKey: String(data.battleKey || ""),
        gameUID: String(data.gameUID || data.gameUid || ""),
        at: String(data.at || data.regDate || "0"),
        damage,
        initHp: Math.max(0, Number(data.initHp || data.initHP || 0) || 0),
        curHP: Math.max(0, Number(data.curHP || data.curHp || 0) || 0),
        maxHp: Math.max(0, Number(data.maxHp || data.maxHP || 0) || 0),
        damageRatio: clampNumber(data.damageRatio, 0, 1),
        combatDamage: Math.max(0, Number(data.combatDamage || 0) || 0),
        combatMaxHp: Math.max(0, Number(data.combatMaxHp || data.combatMaxHP || 0) || 0),
        combatCurHp: Math.max(0, Number(data.combatCurHp || data.combatCurHP || 0) || 0),
        bossKilled: Boolean(data.bossKilled),
        tryAssist: Boolean(data.tryAssist),
      };
    })
    .filter((entry) => entry.damage > 0 || entry.battleKey)
    .slice(-25);
}

function appendRaidBattleHistory(history, entry) {
  const normalized = normalizeRaidBattleHistory(history);
  if (entry.battleKey && normalized.some((item) => item.battleKey === entry.battleKey)) return normalized;
  return normalizeRaidBattleHistory([...normalized, entry]);
}

function normalizeRaidBattleKeys(keys) {
  return (Array.isArray(keys) ? keys : [])
    .map((key) => String(key || ""))
    .filter(Boolean)
    .slice(-25);
}

function appendRaidBattleKey(keys, battleKey) {
  const key = String(battleKey || "");
  const normalized = normalizeRaidBattleKeys(keys);
  if (!key || normalized.includes(key)) return normalized;
  return normalizeRaidBattleKeys([...normalized, key]);
}

function isRaidAttemptReserved(raid, battleKey) {
  const key = String(battleKey || "");
  if (!key || !raid || typeof raid !== "object") return false;
  if (String(raid.lastAttemptKey || "") === key) return true;
  return normalizeRaidBattleKeys(raid.reservedBattleKeys).includes(key);
}

function makeRaidBattleKey(raidUID, gameUID, stageID = 0, dungeonID = 0) {
  const raidKey = String(toBigInt(raidUID || 0));
  const gameKey = String(gameUID || "");
  return `raid:${raidKey}:${gameKey || `${Number(stageID || 0)}:${Number(dungeonID || 0)}`}`;
}

function makeRaidGameUid() {
  return BigInt(Date.now()) * 10000n + BigInt(process.pid % 10000);
}

function getRaidTryLimit(raid) {
  const raidTemplet = getRaidTemplet(raid && raid.stageID);
  return Math.max(0, Number(raidTemplet && raidTemplet.m_RaidTryCount) || 0);
}

function resolveRaidBattleDamage(raid, options = {}, context = {}) {
  const battleState = options.battleState && typeof options.battleState === "object" ? options.battleState : {};
  const initHp = Math.max(0, Number(context.initHp || raid.curHP || 0) || 0);
  const maxHp = Math.max(1, Number(context.maxHp || raid.maxHP || initHp || 100000) || 100000);
  const directDamage = firstFiniteNumber(options.damage, battleState.raidDamage, battleState.RaidDamage);
  if (directDamage != null) {
    const damage = clampNumber(directDamage, 0, initHp);
    return {
      damage,
      damageRatio: maxHp > 0 ? damage / maxHp : 0,
      bossKilled: damage >= initHp,
    };
  }

  const combatDamage = firstFiniteNumber(
    options.combatDamage,
    battleState.raidBossDamage,
    battleState.RaidBossDamage,
    battleState.raidBoss && battleState.raidBoss.damage
  );
  const combatMaxHp = firstFiniteNumber(
    options.combatMaxHp,
    options.combatMaxHP,
    battleState.raidBossMaxHp,
    battleState.RaidBossMaxHp,
    battleState.raidBossInitHp,
    battleState.RaidBossInitHp,
    battleState.raidBoss && (battleState.raidBoss.maxHp || battleState.raidBoss.maxHP)
  );
  const combatCurHp = firstFiniteNumber(
    options.combatCurHp,
    options.combatCurHP,
    battleState.raidBossCurHp,
    battleState.RaidBossCurHp,
    battleState.raidBoss && (battleState.raidBoss.curHp || battleState.raidBoss.curHP)
  );
  let damageRatio = firstFiniteNumber(options.damageRatio, battleState.raidBossDamageRatio, battleState.RaidBossDamageRatio);
  if (damageRatio == null && combatDamage != null && combatMaxHp != null && combatMaxHp > 0) {
    damageRatio = combatDamage / combatMaxHp;
  } else if (damageRatio == null && combatCurHp != null && combatMaxHp != null && combatMaxHp > 0) {
    damageRatio = (combatMaxHp - combatCurHp) / combatMaxHp;
  }

  const bossKilled =
    Boolean(options.bossKilled || battleState.raidBossKilled || battleState.RaidBossKilled) ||
    (combatCurHp != null && combatCurHp <= 0);
  if (damageRatio != null) {
    const ratio = clampNumber(damageRatio, 0, 1);
    const damage = bossKilled ? initHp : clampNumber(Math.round(maxHp * ratio), 0, initHp);
    return { damage, damageRatio: ratio, combatDamage: combatDamage || 0, combatMaxHp: combatMaxHp || 0, combatCurHp: combatCurHp || 0, bossKilled };
  }

  if (bossKilled || (context.win && options.giveup !== true && options.legacyWinKills === true)) {
    return { damage: initHp, damageRatio: maxHp > 0 ? initHp / maxHp : 1, bossKilled: true };
  }

  return { damage: 0, damageRatio: 0, bossKilled: false };
}

function syncRaidCombatHpFromBattleState(user, raidUID, battleState, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const raidKey = String(toBigInt(raidUID || 0));
  if (toBigInt(raidUID || 0) <= 0n) return { changed: false, raid: null, error: "invalid-raid-uid" };
  if (state.raidResults && state.raidResults[raidKey]) {
    return { changed: false, raid: normalizeRaidState(state.raidResults[raidKey]), result: true };
  }
  if (!state.raids || !state.raids[raidKey]) return { changed: false, raid: null, error: "raid-not-found" };

  const raid = normalizeRaidState(state.raids[raidKey]);
  const applied = applyRaidCombatHpScale(raid, battleState || options);
  if (!applied.changed) return { changed: false, raid, snapshot: applied.snapshot };

  state.raids[raidKey] = normalizeRaidState(raid);
  return { changed: true, raid: state.raids[raidKey], snapshot: applied.snapshot };
}

function applyRaidCombatHpScale(raid, source = {}) {
  const snapshot = readRaidCombatHpSnapshot(source);
  const combatMaxHp = Math.max(0, Number(snapshot.maxHp || snapshot.initHp || 0) || 0);
  if (!raid || combatMaxHp <= 0) return { changed: false, snapshot };

  const previousMaxHp = Math.max(0, Number(raid.maxHP || raid.maxHp || 0) || 0);
  const previousCurHp = Math.max(0, Number(raid.curHP != null ? raid.curHP : previousMaxHp) || 0);
  const scale = previousMaxHp > 0 ? combatMaxHp / previousMaxHp : 1;
  const currentRatio = previousMaxHp > 0 ? clampNumber(previousCurHp / previousMaxHp, 0, 1) : 1;
  let changed = false;

  if (Math.abs(previousMaxHp - combatMaxHp) > 0.5) {
    raid.maxHP = combatMaxHp;
    raid.curHP = clampNumber(Math.round(combatMaxHp * currentRatio), 0, combatMaxHp);
    raid.damage = Math.round(Math.max(0, Number(raid.damage || 0) || 0) * scale);
    raid.lastBattleDamage = Math.round(Math.max(0, Number(raid.lastBattleDamage || 0) || 0) * scale);
    raid.battleHistory = scaleRaidBattleHistory(raid.battleHistory, scale);
    changed = true;
  } else if (Math.abs(Number(raid.maxHP || 0) - combatMaxHp) > 0.001) {
    raid.maxHP = combatMaxHp;
    changed = true;
  }

  if (raid.curHP > raid.maxHP) {
    raid.curHP = raid.maxHP;
    changed = true;
  }

  return { changed, snapshot };
}

function readRaidCombatHpSnapshot(source = {}) {
  const data = source && typeof source === "object" ? source : {};
  const battleState = data.battleState && typeof data.battleState === "object" ? data.battleState : data;
  const nested = battleState.raidBoss && typeof battleState.raidBoss === "object" ? battleState.raidBoss : {};
  const maxHp = firstFiniteNumber(
    data.combatMaxHp,
    data.combatMaxHP,
    battleState.raidBossMaxHp,
    battleState.RaidBossMaxHp,
    nested.maxHp,
    nested.maxHP
  );
  const initHp = firstFiniteNumber(
    data.combatInitHp,
    data.combatInitHP,
    battleState.raidBossInitHp,
    battleState.RaidBossInitHp,
    nested.initHp,
    nested.initHP,
    maxHp
  );
  const curHp = firstFiniteNumber(
    data.combatCurHp,
    data.combatCurHP,
    battleState.raidBossCurHp,
    battleState.RaidBossCurHp,
    nested.curHp,
    nested.curHP
  );
  const damage = firstFiniteNumber(
    data.combatDamage,
    battleState.raidBossDamage,
    battleState.RaidBossDamage,
    nested.damage
  );
  const damageRatio = firstFiniteNumber(
    data.damageRatio,
    battleState.raidBossDamageRatio,
    battleState.RaidBossDamageRatio,
    nested.damageRatio
  );
  const killed = Boolean(data.bossKilled || battleState.raidBossKilled || battleState.RaidBossKilled || nested.killed);
  return { maxHp, initHp, curHp, damage, damageRatio, killed };
}

function scaleRaidBattleHistory(history, scale) {
  if (!Array.isArray(history) || !Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) <= 0.0001) {
    return normalizeRaidBattleHistory(history);
  }
  return normalizeRaidBattleHistory(
    history.map((entry) => ({
      ...entry,
      damage: Math.round(Math.max(0, Number(entry && entry.damage || 0) || 0) * scale),
      initHp: Math.round(Math.max(0, Number(entry && (entry.initHp || entry.initHP) || 0) || 0) * scale),
      curHP: Math.round(Math.max(0, Number(entry && (entry.curHP || entry.curHp) || 0) || 0) * scale),
      maxHp: Math.round(Math.max(0, Number(entry && (entry.maxHp || entry.maxHP) || 0) || 0) * scale),
      combatDamage: Math.round(Math.max(0, Number(entry && entry.combatDamage || 0) || 0) * scale),
      combatMaxHp: Math.round(Math.max(0, Number(entry && (entry.combatMaxHp || entry.combatMaxHP) || 0) || 0) * scale),
      combatCurHp: Math.round(Math.max(0, Number(entry && (entry.combatCurHp || entry.combatCurHP) || 0) || 0) * scale),
    }))
  );
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function buildRaidBossResultForState(raid, damage = 0) {
  const data = normalizeRaidState(raid);
  return {
    initHp: Number(data.curHP || 0),
    curHP: Number(data.curHP || 0),
    maxHp: Number(data.maxHP || 0),
    damage: Math.max(0, Number(damage || 0) || 0),
  };
}

function spendRaidAttemptCost(user, raid, options = {}) {
  if (options.skipRaidCost || options.skipCost || options.adminKill) return [];
  const raidTemplet = getRaidTemplet(raid.stageID);
  const costItems = [];
  const costItemId = positiveInt(raidTemplet && raidTemplet.m_StageReqItemID);
  const rawCostCount = Math.max(0, Number(raidTemplet && raidTemplet.m_StageReqItemCount) || 0);
  const city = getCityStateForRaid(user, raid, options);
  const costReduction = getCityBuildingStatValue(city, "CBS_RAID_DEFENCE_COST_REDUCE_RATE");
  const costCount = Math.max(0, Math.ceil(rawCostCount * Math.max(0, 100 - costReduction) / 100));
  if (costItemId > 0 && costCount > 0) {
    const spent = spendMiscItem(user, costItemId, costCount, { regDate: String(binaryNow(options)) });
    if (spent) costItems.push(spent);
  }
  return costItems;
}

function updateRaidSeasonFromBattle(user, raid, options = {}) {
  const season = ensureRaidSeasonState(user, options);
  const damage = Math.max(0, Number(options.damage || raid.damage || 0) || 0);
  season.highestDamage = Math.max(Number(season.highestDamage || 0) || 0, damage);
  season.latestUpdateTime = String(binaryNow(options));
  if (options.tryAssist) season.tryAssistCount += 1;
}

function getRaidResults(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  return Object.values(state.raidResults || {})
    .map(normalizeRaidState)
    .filter((raid) => !raid.accepted && !isRaidDismissed(state, raid.raidUID));
}

function getCoopRaids(user, options = {}) {
  return getActiveRaids(user, options).filter((raid) => raid.isCoop && Number(raid.curHP || 0) > 0);
}

function setRaidCoop(user, raidUID, isCoop = true, options = {}) {
  const state = ensureWorldMapState(user, options);
  const key = String(toBigInt(raidUID || 0));
  if (isRaidDismissed(state, key)) return null;
  const raid = state.raids[key] ? normalizeRaidState(state.raids[key]) : null;
  if (!raid || Number(raid.curHP || 0) <= 0 || getRaidResultByUid(user, key, options)) return null;
  raid.isCoop = Boolean(isCoop);
  raid.isNew = false;
  state.raids[String(raid.raidUID)] = raid;
  return raid;
}

function setAllRaidsCoop(user, options = {}) {
  return getActiveRaids(user, options)
    .filter((raid) => Number(raid.curHP || 0) > 0)
    .map((raid) => setRaidCoop(user, raid.raidUID, true, options))
    .filter(Boolean);
}

function acceptRaidResult(user, raidUID, options = {}) {
  const state = ensureWorldMapState(user, options);
  const key = String(toBigInt(raidUID || 0));
  const raid = state.raidResults[key] ? normalizeRaidState(state.raidResults[key]) : null;
  if (!raid) {
    deleteRaidState(state, key);
    return { raidUid: toBigInt(raidUID || 0), reward: {}, rewardRaidPoint: 0 };
  }
  const result = grantRaidReward(user, raid, options);
  const season = ensureRaidSeasonState(user, options);
  season.monthlyPoint += Math.max(0, Number(result.rewardRaidPoint || 0) || 0);
  season.latestUpdateTime = String(binaryNow(options));
  deleteRaidState(state, key);
  return { raidUid: toBigInt(raid.raidUID), ...result };
}

function acceptAllRaidResults(user, options = {}) {
  const results = getRaidResults(user, options);
  const reward = createEmptyReward();
  let rewardRaidPoint = 0;
  const raidUids = [];
  for (const raid of results) {
    const accepted = acceptRaidResult(user, raid.raidUID, options);
    raidUids.push(toBigInt(raid.raidUID));
    rewardRaidPoint += accepted.rewardRaidPoint;
    mergeReward(reward, accepted.reward);
  }
  return { raidUids, reward, rewardRaidPoint };
}

function grantRaidReward(user, raid, options = {}) {
  const raidTemplet = getRaidTemplet(raid.stageID);
  const victory = Number(raid.curHP || 0) <= 0;
  const rewardRaidPoint = Math.max(
    0,
    Number(raidTemplet && (victory ? raidTemplet.m_RewardRaidPoint_Victory : raidTemplet.m_RewardRaidPoint_Fail)) || Number(raid.stageID) || 0
  );
  const reward = createEmptyReward();
  const regDate = binaryNow(options);
  const ctx = { dateTimeBinaryNow: () => regDate };
  for (const groupId of raidRewardGroupIds(raidTemplet, victory)) {
    const record = pickRaidRewardRecord(user, groupId);
    if (!record) continue;
    mergeReward(reward, grantRewardRecord(ctx, user, record, { regDate, source: "raid" }));
  }

  if (!hasRewardPayload(reward)) {
    const credit = grantMiscItem(user, ITEM_ID_CREDIT, Math.max(10000, Math.round(Number(raid.maxHP || 100000) / 5)), 0, { regDate: String(regDate) });
    const info = grantMiscItem(user, ITEM_ID_INFORMATION, Math.max(25, Math.round(Number(raid.maxHP || 100000) / 2000)), 0, { regDate: String(regDate) });
    if (credit) reward.miscItems.push(credit);
    if (info) reward.miscItems.push(info);
  }

  return { reward, rewardRaidPoint };
}

function raidRewardGroupIds(raidTemplet, victory) {
  const prefix = victory ? "m_RewardRaidGroupID_Victory_" : "m_RewardRaidGroupID_Fail_";
  const ids = [];
  for (let index = 1; index <= 3; index += 1) {
    const id = positiveInt(raidTemplet && raidTemplet[`${prefix}${index}`]);
    if (id) ids.push(id);
  }
  return uniquePositiveIntsInOrder(ids);
}

function pickRaidRewardRecord(user, groupId) {
  const rows = getRewardGroupRecords(groupId);
  if (!rows.length) return null;
  const totalWeight = rows.reduce((sum, row) => sum + Math.max(0, Number(row.m_Ratio || 1)), 0);
  if (totalWeight <= 0) return rows[0];
  const cursor = nextRaidRewardCursor(user, groupId) % totalWeight;
  let target = cursor;
  for (const row of rows) {
    target -= Math.max(0, Number(row.m_Ratio || 1));
    if (target < 0) return row;
  }
  return rows[0];
}

function nextRaidRewardCursor(user, groupId) {
  const state = ensureBareWorldMapState(user);
  state.rewardCursors = state.rewardCursors && typeof state.rewardCursors === "object" ? state.rewardCursors : {};
  const key = `raid:${groupId}`;
  const cursor = Math.max(0, Number(state.rewardCursors[key] || 0) || 0);
  state.rewardCursors[key] = cursor + 1;
  return cursor;
}

function hasRewardPayload(reward) {
  if (!reward || typeof reward !== "object") return false;
  return ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "moldItems"].some(
    (key) => Array.isArray(reward[key]) && reward[key].length > 0
  );
}

function buildMyRaidData(raid) {
  const data = normalizeRaidState(raid);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.raidUID)),
    writeSignedVarInt(data.stageID),
    writeSignedVarInt(data.cityID),
    writeFloatLE(data.curHP),
    writeFloatLE(data.maxHP),
    writeBool(Boolean(data.isCoop)),
    writeBool(shouldShowRaidInWorldMapEventList(data)),
    writeSignedVarLong(toBigInt(data.expireDate)),
    writeSignedVarInt(data.seasonID),
  ]);
}

function buildRaidDetailData(user, raid) {
  const data = normalizeRaidState(raid);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.raidUID)),
    writeSignedVarInt(data.stageID),
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeSignedVarLong(toBigInt(user && user.friendCode ? user.friendCode : user && user.userUid ? user.userUid : 0)),
    writeSignedVarInt(data.cityID),
    writeFloatLE(data.curHP),
    writeFloatLE(data.maxHP),
    writeBool(Boolean(data.isCoop)),
    writeBool(shouldShowRaidInWorldMapEventList(data)),
    writeSignedVarLong(toBigInt(data.expireDate)),
    writeObjectList([writeNullableObject(buildRaidJoinData(user, data))]),
    writeSignedVarInt(data.seasonID),
  ]);
}

function shouldShowRaidInWorldMapEventList(raid) {
  const data = raid && typeof raid === "object" ? raid : {};
  if (data.accepted) return false;
  if (Number(data.curHP || 0) <= 0) return false;
  return true;
}

function buildMyRaidListAckPayload(user, options = {}) {
  return buildMyRaidListAckPayloadFromRaids(getActiveRaids(user, options));
}

function buildMyRaidListAckPayloadFromRaids(raids) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeObjectList((Array.isArray(raids) ? raids : []).map((raid) => writeNullableObject(buildMyRaidData(raid)))),
  ]);
}

function buildRaidDetailInfoAckPayload(user, raid) {
  return Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildRaidDetailData(user, raid))]);
}

function buildRaidResultListAckPayload(user, options = {}) {
  return buildRaidResultListAckPayloadFromRaids(user, getRaidResults(user, options));
}

function buildRaidResultListAckPayloadFromRaids(user, raids) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeObjectList((Array.isArray(raids) ? raids : []).map((raid) => writeNullableObject(buildRaidResultData(user, raid)))),
  ]);
}

function buildCoopRaidListAckPayloadFromRaids(user, raids) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeObjectList((Array.isArray(raids) ? raids : []).map((raid) => writeNullableObject(buildCoopRaidData(user, raid)))),
  ]);
}

function buildWorldMapDataAckPayload(user, options = {}) {
  return Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildWorldMapData(user, options))]);
}

function buildWorldMapEventCancelAckPayload(cityID) {
  return Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(positiveInt(cityID))]);
}

function sendWorldMapData(ctx, socket, user, options = {}) {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  ctx.sendServerGamePacket(socket, 2001, buildWorldMapDataAckPayload(user, options), options.label || "world-map-data");
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  return true;
}

function sendActiveRaidData(ctx, socket, user, options = {}) {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  const raids = getActiveRaids(user, options);
  if (!raids.length && !options.includeEmpty) return false;
  ctx.sendServerGamePacket(socket, 2201, buildMyRaidListAckPayloadFromRaids(raids), options.label || "my-raid-list");
  if (options.includeRaidDetails === true) {
    for (const raid of raids) {
      ctx.sendServerGamePacket(socket, 2209, buildRaidDetailInfoAckPayload(user, raid), options.detailLabel || "raid-detail-info");
    }
  }
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  return true;
}

function sendRaidResultData(ctx, socket, user, options = {}) {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  const results = getRaidResults(user, options);
  if (!results.length && !options.includeEmpty) return false;
  ctx.sendServerGamePacket(socket, 2211, buildRaidResultListAckPayloadFromRaids(user, results), options.label || "raid-result-list");
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  return true;
}

function sendRaidStateData(ctx, socket, user, options = {}) {
  return sendRaidSnapshotData(ctx, socket, user, options);
}

function getRaidSnapshot(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  refreshWorldMapState(user, options);
  const activeRaids = getActiveRaids(user, options);
  const resultRaids = getRaidResults(user, options);
  const coopRaids = activeRaids.filter((raid) => raid.isCoop && Number(raid.curHP || 0) > 0);
  return { state, activeRaids, coopRaids, resultRaids };
}

function sendRaidSnapshotData(ctx, socket, user, options = {}) {
  if (!ctx || typeof ctx.sendServerGamePacket !== "function") return false;
  const snapshot = getRaidSnapshot(user, options);
  const includeEmpty = options.includeEmpty !== false;
  const sent = [];

  if (options.includeWorldMap) {
    ctx.sendServerGamePacket(socket, 2001, buildWorldMapDataAckPayload(user, options), options.worldMapLabel || "raid-snapshot-world-map-data");
    sent.push(2001);
  }

  const activeRaidCityIds = new Set(snapshot.activeRaids.map((raid) => positiveInt(raid && raid.cityID)).filter(Boolean));
  const completedRaidCityIds = snapshot.resultRaids
    .map((raid) => positiveInt(raid && raid.cityID))
    .filter((cityID) => cityID && !activeRaidCityIds.has(cityID));
  const requestedClearCityIds = Array.isArray(options.cancelCityIds) ? options.cancelCityIds : [options.cancelCityIds];
  const raidEventClearCityIds = takePendingRaidEventClearCityIds(snapshot.state, [...completedRaidCityIds, ...requestedClearCityIds])
    .filter((cityID) => !activeRaidCityIds.has(cityID));
  for (const cityID of raidEventClearCityIds) {
    ctx.sendServerGamePacket(socket, 2015, buildWorldMapEventCancelAckPayload(cityID), options.eventCancelLabel || "raid-event-clear");
    sent.push(2015);
  }

  if (includeEmpty || snapshot.activeRaids.length) {
    ctx.sendServerGamePacket(socket, 2201, buildMyRaidListAckPayloadFromRaids(snapshot.activeRaids), options.label || "my-raid-list");
    sent.push(2201);
  }

  const detailRaids = selectRaidDetailsForSnapshot(snapshot, options);
  for (const raid of detailRaids) {
    ctx.sendServerGamePacket(socket, 2209, buildRaidDetailInfoAckPayload(user, raid), options.detailLabel || "raid-detail-info");
    sent.push(2209);
  }

  if (includeEmpty || snapshot.coopRaids.length) {
    ctx.sendServerGamePacket(socket, 2203, buildCoopRaidListAckPayloadFromRaids(user, snapshot.coopRaids), options.coopLabel || "raid-coop-list");
    sent.push(2203);
  }

  if (includeEmpty || snapshot.resultRaids.length) {
    ctx.sendServerGamePacket(socket, 2211, buildRaidResultListAckPayloadFromRaids(user, snapshot.resultRaids), options.resultLabel || "raid-result-list");
    sent.push(2211);
  }

  if (sent.length && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  return sent.length > 0;
}

function uniqueRaidsByUid(raids) {
  const seen = new Set();
  const result = [];
  for (const raid of Array.isArray(raids) ? raids : []) {
    const key = String(toBigInt(raid && raid.raidUID));
    if (key === "0" || seen.has(key)) continue;
    seen.add(key);
    result.push(raid);
  }
  return result;
}

function selectRaidDetailsForSnapshot(snapshot, options = {}) {
  if (options.includeRaidDetails === true) return uniqueRaidsByUid([...(snapshot.activeRaids || []), ...(snapshot.coopRaids || [])]);

  const requested = normalizeDetailRaidUidList(options.detailRaidUids, options.detailRaidUid);
  if (!requested.length) return [];

  const requestedSet = new Set(requested);
  return uniqueRaidsByUid([
    ...(snapshot.activeRaids || []),
    ...(snapshot.coopRaids || []),
    ...(snapshot.resultRaids || []),
  ]).filter((raid) => requestedSet.has(String(toBigInt(raid && raid.raidUID))));
}

function normalizeDetailRaidUidList(...values) {
  const seen = new Set();
  const result = [];
  const queue = [];
  for (const value of values) {
    if (Array.isArray(value)) queue.push(...value);
    else queue.push(value);
  }
  for (const value of queue) {
    const key = String(toBigInt(value || 0));
    if (key === "0" || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function buildRaidJoinData(user, raid) {
  const mainUnit = getMainUnitForProfile(user);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeSignedVarLong(toBigInt(user && user.friendCode ? user.friendCode : user && user.userUid ? user.userUid : 0)),
    writeString(String((user && user.nickname) || "LocalAdmin")),
    writeSignedVarInt(Number(mainUnit.unitId || 0) || 0),
    writeSignedVarInt(Number(mainUnit.skinId || 0) || 0),
    writeFloatLE(Number(raid.damage || 0) || 0),
    writeBool(true),
    writeSignedVarInt(Number(raid.tryCount || 0) || 0),
    writeNullObject(),
    writeBool(false),
    writeSignedVarInt(Math.max(1, Number(user && user.level) || 1)),
    writeSignedVarInt(Number(user && (user.titleId || user.titleID) || 0) || 0),
  ]);
}

function buildRaidResultData(user, raid) {
  const data = normalizeRaidState(raid);
  const mainUnit = getMainUnitForProfile(user);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.raidUID)),
    writeSignedVarInt(data.stageID),
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeSignedVarLong(toBigInt(user && user.friendCode ? user.friendCode : user && user.userUid ? user.userUid : 0)),
    writeString(String((user && user.nickname) || "LocalAdmin")),
    writeSignedVarInt(Number(mainUnit.unitId || 0) || 0),
    writeSignedVarInt(Number(mainUnit.skinId || 0) || 0),
    writeSignedVarInt(Number(mainUnit.tacticLevel || 0) || 0),
    writeSignedVarInt(data.cityID),
    writeFloatLE(data.curHP),
    writeFloatLE(data.maxHP),
    writeBool(Boolean(data.isCoop)),
    writeSignedVarLong(toBigInt(data.expireDate)),
    writeBool(true),
    writeSignedVarInt(Number(data.tryCount || 0) || 0),
    writeFloatLE(Number(data.damage || data.maxHP) || 0),
    writeBool(false),
    writeSignedVarInt(data.seasonID),
    writeNullObject(),
    writeObjectList([writeNullableObject(buildRaidJoinData(user, data))]),
  ]);
}

function buildCoopRaidData(user, raid) {
  const data = normalizeRaidState(raid);
  const mainUnit = getMainUnitForProfile(user);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.raidUID)),
    writeSignedVarInt(data.stageID),
    writeSignedVarLong(toBigInt(user && user.userUid ? user.userUid : 0)),
    writeSignedVarLong(toBigInt(user && user.friendCode ? user.friendCode : user && user.userUid ? user.userUid : 0)),
    writeString(String((user && user.nickname) || "LocalAdmin")),
    writeSignedVarInt(Number(mainUnit.unitId || 0) || 0),
    writeSignedVarInt(Number(mainUnit.skinId || 0) || 0),
    writeSignedVarInt(Number(mainUnit.tacticLevel || 0) || 0),
    writeFloatLE(data.curHP),
    writeFloatLE(data.maxHP),
    writeSignedVarLong(toBigInt(data.expireDate)),
    writeSignedVarInt(data.seasonID),
    writeSignedVarInt(data.cityID),
    writeNullObject(),
    writeObjectList([writeNullableObject(buildRaidJoinData(user, data))]),
  ]);
}

function buildRaidBossResultData(result) {
  const data = result || {};
  return Buffer.concat([
    writeFloatLE(Number(data.initHp || 0) || 0),
    writeFloatLE(Number(data.curHP || 0) || 0),
    writeFloatLE(Number(data.maxHp || 0) || 0),
    writeFloatLE(Number(data.damage || 0) || 0),
  ]);
}

function buildRaidSeasonData(user, options = {}) {
  const season = ensureRaidSeasonState(user, options);
  return Buffer.concat([
    writeSignedVarInt(season.seasonId),
    writeSignedVarInt(season.monthlyPoint),
    writeSignedVarInt(season.tryAssistCount),
    writeSignedVarInt(season.recvRewardRaidPoint),
    writeFloatLE(Number(season.highestDamage || 0) || 0),
    writeInt64LE(toBigInt(season.latestUpdateTime || binaryNow(options))),
  ]);
}

function ensureRaidSeasonState(user, options = {}) {
  const state = ensureWorldMapState(user, options);
  state.raidSeason = state.raidSeason && typeof state.raidSeason === "object" ? state.raidSeason : {};
  state.raidSeason.seasonId = positiveInt(state.raidSeason.seasonId) || currentRaidSeasonId(options);
  state.raidSeason.monthlyPoint = Math.max(0, Number(state.raidSeason.monthlyPoint || 0) || 0);
  state.raidSeason.tryAssistCount = Math.max(0, Number(state.raidSeason.tryAssistCount || 0) || 0);
  state.raidSeason.recvRewardRaidPoint = Math.max(0, Number(state.raidSeason.recvRewardRaidPoint || 0) || 0);
  state.raidSeason.highestDamage = Math.max(0, Number(state.raidSeason.highestDamage || 0) || 0);
  state.raidSeason.latestUpdateTime = String(state.raidSeason.latestUpdateTime || binaryNow(options));
  return state.raidSeason;
}

function getMainUnitForProfile(user) {
  try {
    const units = getArmyUnits(user);
    const unit = units.find((entry) => entry && Number(entry.unitId || 0) > 0) || {};
    return {
      unitId: Number(unit.unitId || 0) || 0,
      skinId: Number(unit.skinId || 0) || 0,
      tacticLevel: Number(unit.tacticLevel || 0) || 0,
    };
  } catch (_) {
    return { unitId: 0, skinId: 0, tacticLevel: 0 };
  }
}

function writeMiscItemList(items) {
  return writeObjectList((Array.isArray(items) ? items : []).filter(Boolean).map((item) => writeNullableObject(buildItemMiscData(item))));
}

function chooseMissionIds(user, city, token, count) {
  const candidates = missionCandidatesForCity(user, city);
  const ids = uniquePositiveInts(candidates.map((row) => positiveInt(row.m_WorldmapMissionID)));
  if (ids.length <= 1) return ids.slice(0, count);
  const ordered = ids.slice().sort((a, b) => a - b);
  const parts = String(token || "").split(":");
  const nonce = Math.max(0, Number(parts[1] || 0) || 0);
  const offset = (dayNumberFromKey(parts[0]) + nonce) % ordered.length;
  return ordered.slice(offset).concat(ordered.slice(0, offset)).slice(0, count);
}

function missionCandidatesForCity(user, city) {
  const tables = getTables();
  const poolID = missionPoolForCity(city.cityID);
  const managerLevel = Math.max(Number(user && user.level) || 1, Number(city.level || 1) * 10);
  const enabled = tables.worldMapMissionsEnabled.length ? tables.worldMapMissionsEnabled : tables.worldMapMissions;
  let candidates = enabled.filter(
    (row) =>
      Number(row.m_WorldmapMissionPoolID || 0) === poolID &&
      Number(row.m_ReqManagerLevel || 0) <= managerLevel &&
      Number(row.m_WorldMapMissionLevel || 1) <= Math.max(1, Number(city.level || 1))
  );
  if (candidates.length < 4) {
    candidates = enabled.filter((row) => Number(row.m_WorldmapMissionPoolID || 0) === poolID && Number(row.m_ReqManagerLevel || 0) <= managerLevel);
  }
  if (candidates.length < 4) candidates = enabled.filter((row) => Number(row.m_WorldmapMissionPoolID || 0) === poolID);
  if (candidates.length < 4) candidates = enabled;
  return candidates.length ? candidates : [{ m_WorldmapMissionID: 1104101, m_MissionTime: 60 }];
}

function getTables() {
  if (tableCache) return tableCache;
  const worldMapCities = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_CITY_TEMPLET.json", { logLabel: "world-map" });
  const worldMapBuildings = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_CITY_BUILDING.json", { logLabel: "world-map" });
  const worldMapExp = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_CITY_EXP_TABLE.json", { logLabel: "world-map" });
  const worldMapMissions = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_MISSION_TEMPLET.json", { logLabel: "world-map" });
  const worldMapEventGroups = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_EVENT_GROUP.json", { logLabel: "world-map" });
  const dungeonTemplets = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", { logLabel: "world-map" });
  const diveTemplets = readGameplayTableRecords("ab_script", "LUA_DIVE_TEMPLET.json", { logLabel: "world-map" });
  const raidTemplets = readGameplayTableRecords("ab_script", "LUA_RAID_TEMPLET.json", { logLabel: "world-map" });
  const raidSeasons = readGameplayTableRecords("ab_script", "LUA_RAID_SEASON_TEMPLET.json", { logLabel: "world-map" });
  const unitStats = [
    ...readGameplayTableRecords("ab_script_unit_data", "LUA_UNIT_STAT_TEMPLET.json", { logLabel: "world-map" }),
    ...readGameplayTableRecords("ab_script_unit_data", "LUA_UNIT_STAT_TEMPLET2.json", { logLabel: "world-map" }),
  ];
  tableCache = {
    worldMapCities,
    worldMapBuildings,
    worldMapExp,
    worldMapMissions,
    worldMapMissionsEnabled: worldMapMissions.filter((row) => row && row.m_bEnableMission === true),
    worldMapEventGroups,
    dungeonTemplets,
    diveTemplets,
    raidTemplets,
    raidSeasons,
    missionsById: new Map(worldMapMissions.map((row) => [Number(row.m_WorldmapMissionID || 0), row])),
    dungeonsById: new Map(dungeonTemplets.map((row) => [Number(row.m_DungeonID || 0), row])),
    dungeonsByStrId: new Map(dungeonTemplets.map((row) => [String(row.m_DungeonStrID || ""), row]).filter(([key]) => key)),
    divesByStageId: new Map(diveTemplets.map((row) => [Number(row.STAGE_ID || 0), row])),
    raidsByStageId: new Map(raidTemplets.map((row) => [Number(row.m_StageID || 0), row])),
    unitStatsByStrId: new Map(unitStats.map((row) => [String(row.m_UnitStrID || ""), row]).filter(([key]) => key)),
    dungeonTempletRowsByFile: new Map(),
  };
  return tableCache;
}

function getDefaultCityIds() {
  const cities = getTables().worldMapCities.map((row) => positiveInt(row.m_CityID)).filter(Boolean).sort((a, b) => a - b);
  if (!cities.length) return [1];
  if (envFlagDefault(false, "CS_WORLDMAP_UNLOCK_ALL_BRANCHES")) return cities;
  return [cities[0]];
}

function isKnownCityId(cityID) {
  const id = positiveInt(cityID);
  return id > 0 && getTables().worldMapCities.some((row) => positiveInt(row.m_CityID) === id);
}

function getUnlockedCityCount(state) {
  const cities = state && state.cities && typeof state.cities === "object" ? state.cities : {};
  return Object.values(cities).filter((city) => city && positiveInt(city.cityID)).length;
}

function getCityOpenCost(unlockedCityCount, isCash) {
  const costs = parseCityOpenCostsEnv(isCash ? "CS_WORLDMAP_CITY_OPEN_CASH_COSTS" : "CS_WORLDMAP_CITY_OPEN_CREDIT_COSTS") ||
    (isCash ? CITY_OPEN_CASH_COSTS : CITY_OPEN_CREDIT_COSTS);
  const index = Math.max(0, Number(unlockedCityCount || 0) || 0);
  return Math.max(0, Number(costs[index] || 0) || 0);
}

function parseCityOpenCostsEnv(key) {
  const raw = process.env[key];
  if (raw == null || String(raw).trim() === "") return null;
  const costs = String(raw)
    .split(",")
    .map((value) => Math.max(0, Number(String(value).trim()) || 0));
  return costs.length ? costs : null;
}

function getPossibleCityCount(user) {
  const override = positiveInt(process.env.CS_WORLDMAP_MAX_BRANCHES);
  if (override) return Math.min(override, Math.max(1, getTables().worldMapCities.length || override));

  const userLevel = Math.max(0, Number((user && (user.level || user.m_UserLevel || user.userLevel)) || 1) || 1);
  if (userLevel <= 0) return 0;
  for (let index = 0; index < CITY_UNLOCK_LEVELS.length; index += 1) {
    if (userLevel < CITY_UNLOCK_LEVELS[index]) return Math.max(0, index - 1);
  }
  return Math.max(1, getTables().worldMapCities.length || 6);
}

function getMiscItemBalance(user, itemId) {
  const item = getMiscItem(user, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function firstCityId() {
  const city = getTables().worldMapCities.find((row) => positiveInt(row.m_CityID));
  return positiveInt(city && city.m_CityID) || 1;
}

function firstMissionId() {
  const mission = (getTables().worldMapMissionsEnabled[0] || getTables().worldMapMissions[0] || {}).m_WorldmapMissionID;
  return positiveInt(mission) || 1104101;
}

function firstDiveStageId() {
  const templet = getTables().diveTemplets.find((row) => positiveInt(row.STAGE_ID));
  return positiveInt(templet && templet.STAGE_ID) || 1010;
}

function getMissionById(missionID) {
  return getTables().missionsById.get(Number(missionID || 0)) || null;
}

function getDiveTemplet(stageID) {
  return getTables().divesByStageId.get(Number(stageID || 0)) || getTables().diveTemplets[0] || null;
}

function findRaidTemplet(stageID) {
  return getTables().raidsByStageId.get(Number(stageID || 0)) || null;
}

function getRaidTemplet(stageID) {
  return findRaidTemplet(stageID) || getTables().raidTemplets[0] || null;
}

function getBuildingRow(buildID, level) {
  return getTables().worldMapBuildings.find((row) => Number(row.ID || 0) === Number(buildID || 0) && Number(row.LEVEL || 0) === Number(level || 0)) || null;
}

function getCityBuildingStatValue(city, statType) {
  if (!city || !city.buildings || typeof city.buildings !== "object") return 0;
  let total = 0;
  for (const [key, building] of Object.entries(city.buildings)) {
    const buildID = positiveInt(building && building.id) || positiveInt(key);
    const level = positiveInt(building && building.level);
    const row = getBuildingRow(buildID, level);
    if (row && String(row.CITY_STAT_TYPE || "").toUpperCase() === String(statType || "").toUpperCase()) {
      total += Number(row.CITY_STAT_VALUE || 0) || 0;
    }
  }
  return total;
}

function getCityStateForRaid(user, raid, options = {}) {
  const state = ensureWorldMapState(user, options);
  const cityID = positiveInt(raid && raid.cityID);
  return (cityID && state.cities && state.cities[String(cityID)]) || null;
}

function isRaidReferencedByCity(state, raidUID) {
  const key = String(toBigInt(raidUID || 0));
  const cities = state && state.cities && typeof state.cities === "object" ? state.cities : {};
  return Object.values(cities).some((city) => String(toBigInt(city && city.eventGroup && city.eventGroup.eventUid)) === key);
}

function normalizeRaidUidList(values) {
  const list = Array.isArray(values) ? values : [];
  const seen = new Set();
  const normalized = [];
  for (const value of list) {
    const key = String(toBigInt(value || 0));
    if (key === "0" || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized.slice(-RAID_DISMISS_HISTORY_LIMIT);
}

function isRaidDismissed(state, raidUID) {
  const key = String(toBigInt(raidUID || 0));
  if (!state || key === "0") return false;
  state.dismissedRaidUids = normalizeRaidUidList(state.dismissedRaidUids);
  return state.dismissedRaidUids.includes(key);
}

function markRaidDismissed(state, raidUID) {
  const key = String(toBigInt(raidUID || 0));
  if (!state || key === "0") return false;
  state.dismissedRaidUids = normalizeRaidUidList([...(state.dismissedRaidUids || []), key]);
  return true;
}

function forgetDismissedRaid(state, raidUID) {
  const key = String(toBigInt(raidUID || 0));
  if (!state || key === "0") return false;
  state.dismissedRaidUids = normalizeRaidUidList((state.dismissedRaidUids || []).filter((value) => String(toBigInt(value || 0)) !== key));
  return true;
}

function deleteRaidState(state, raidUID) {
  const key = String(toBigInt(raidUID || 0));
  if (!state || key === "0") return false;
  const hadRaid = Boolean((state.raids && state.raids[key]) || (state.raidResults && state.raidResults[key]) || isRaidReferencedByCity(state, key));
  if (state.raids) delete state.raids[key];
  if (state.raidResults) delete state.raidResults[key];
  clearRaidEventGroupForUid(state, key);
  markRaidDismissed(state, key);
  return hadRaid;
}

function clearRaidEventGroupForUid(state, raidUID) {
  const key = String(toBigInt(raidUID || 0));
  const cities = state && state.cities && typeof state.cities === "object" ? state.cities : {};
  for (const city of Object.values(cities)) {
    if (String(toBigInt(city && city.eventGroup && city.eventGroup.eventUid)) === key) {
      queueRaidEventClearCity(state, city && city.cityID);
      city.eventGroup = normalizeEventGroup(null);
    }
  }
}

function queueRaidEventClearCity(state, cityID) {
  if (!state || typeof state !== "object") return;
  const id = positiveInt(cityID);
  if (!id) return;
  state.pendingRaidEventClearCityIds = uniquePositiveInts([...(state.pendingRaidEventClearCityIds || []), id]);
}

function takePendingRaidEventClearCityIds(state, extraCityIds = []) {
  if (!state || typeof state !== "object") return uniquePositiveInts(extraCityIds);
  const result = uniquePositiveInts([...(state.pendingRaidEventClearCityIds || []), ...uniquePositiveInts(extraCityIds)]);
  state.pendingRaidEventClearCityIds = [];
  return result;
}

function getCityMaxLevel(cityID) {
  const row = getTables().worldMapCities.find((entry) => Number(entry.m_CityID || 0) === Number(cityID || 0));
  return Math.max(1, Number(row && row.m_MaxLevel) || 10);
}

function applyCityMissionExp(city, addedExp) {
  if (!city || typeof city !== "object") return city;
  const maxLevel = getCityMaxLevel(city.cityID);
  let level = clampPositiveInt(city.level, 1, maxLevel);
  let exp = Math.max(0, Number(city.exp || 0) || 0) + Math.max(0, Number(addedExp || 0) || 0);

  while (level < maxLevel) {
    const required = getCityLevelExpRequired(level);
    if (required <= 0 || exp < required) break;
    exp -= required;
    level += 1;
  }

  if (level >= maxLevel && getCityLevelExpRequired(level) <= 0) exp = 0;
  city.level = level;
  city.exp = exp;
  return city;
}

function getCityLevelExpRequired(level) {
  const row = getTables().worldMapExp.find((entry) => Number(entry.m_iLevel || 0) === Number(level || 0));
  return Math.max(0, Number(row && row.m_iExpRequired) || 0);
}

function missionPoolForCity(cityID) {
  return ((Math.max(1, Number(cityID || 1)) - 1) % 3) + 1;
}

function chooseSoloRaidStage(cityID) {
  const eventSelection = selectWorldMapRaidEvent(cityID);
  if (eventSelection.stageID) return eventSelection.stageID;
  const raids = getTables().raidTemplets
    .filter((row) => Array.isArray(row.listContentsTagAllow) && row.listContentsTagAllow.includes("SINGLE_RAID"))
    .sort((a, b) => Number(a.m_StageID || 0) - Number(b.m_StageID || 0));
  if (!raids.length) return 11015;
  const index = Math.min(raids.length - 1, Math.max(0, Number(cityID || 1) - 1));
  return positiveInt(raids[index].m_StageID) || 11015;
}

function repairRaidEventLinks(state) {
  if (!state || typeof state !== "object") return 0;
  let repaired = 0;
  const raids = state.raids && typeof state.raids === "object" ? state.raids : {};
  const cities = state.cities && typeof state.cities === "object" ? state.cities : {};
  for (const city of Object.values(cities)) {
    const eventGroup = city && city.eventGroup;
    if (!isActiveEventGroup(eventGroup)) continue;
    const raidUid = String(toBigInt(eventGroup.eventUid || 0));
    if (isRaidDismissed(state, raidUid)) {
      delete raids[raidUid];
      queueRaidEventClearCity(state, city && city.cityID);
      city.eventGroup = normalizeEventGroup(null);
      repaired += 1;
      continue;
    }
    const raid = raids[raidUid] ? normalizeRaidState(raids[raidUid]) : null;
    if (!raid) continue;
    const event = getWorldMapEventById(eventGroup.worldmapEventID);
    if (isCompatibleRaidEvent(event, raid.stageID) && (raid.adminSpawned || isRaidEventForBranchFacility(event, city))) {
      raid.worldmapEventID = positiveInt(eventGroup.worldmapEventID);
      raids[raidUid] = raid;
      continue;
    }
    if (raid.adminSpawned) continue;
    if (isUsableWorldMapRaidEvent(event) && isRaidEventForBranchFacility(event, city)) {
      applyRaidEventLink(raid, eventGroup.worldmapEventID, event.STAGE_ID);
      raids[raidUid] = raid;
      repaired += 1;
      continue;
    }

    const selection = selectWorldMapRaidEvent(city, null, `${city.cityID}:${raidUid}:repair`, raid.stageID);
    if (!selection.eventID || !selection.stageID) continue;
    eventGroup.worldmapEventID = selection.eventID;
    applyRaidEventLink(raid, selection.eventID, selection.stageID);
    raids[raidUid] = raid;
    repaired += 1;
  }
  return repaired;
}

function repairMissingRaidEventGroups(state, options = {}) {
  if (!state || typeof state !== "object") return 0;
  let repaired = 0;
  const raids = state.raids && typeof state.raids === "object" ? state.raids : {};
  const cities = state.cities && typeof state.cities === "object" ? state.cities : {};
  const now = ticksNow(options);

  for (const [raidUid, raidState] of Object.entries(raids)) {
    if (isRaidDismissed(state, raidUid)) {
      delete raids[raidUid];
      continue;
    }
    const raid = normalizeRaidState(raidState);
    if (Number(raid.curHP || 0) <= 0) continue;
    if (state.raidResults && state.raidResults[String(toBigInt(raidUid))]) continue;
    if (isRaidReferencedByCity(state, raidUid)) continue;

    // Skip expired raids - they should not be resurrected
    if (toBigInt(raid.expireDate) <= now) {
      delete raids[raidUid];
      continue;
    }

    const city = cities[String(positiveInt(raid.cityID))];
    if (!city) continue;
    const currentEventGroup = city.eventGroup || {};
    if (isActiveEventGroup(currentEventGroup)) {
      const currentEvent = getWorldMapEventById(currentEventGroup.worldmapEventID);
      const currentRaidUid = String(toBigInt(currentEventGroup.eventUid));
      if (!isUsableWorldMapRaidEvent(currentEvent) || raids[currentRaidUid]) continue;
    }
    const savedEvent = getWorldMapEventById(raid.worldmapEventID);
    const selection =
      isCompatibleRaidEvent(savedEvent, raid.stageID)
        ? { eventID: positiveInt(raid.worldmapEventID), stageID: positiveInt(raid.stageID) }
        : selectWorldMapRaidEvent(city, null, `${city.cityID}:${raidUid}:missing-event`, raid.stageID);
    if (!selection.eventID) continue;
    city.eventGroup = {
      worldmapEventID: selection.eventID,
      eventGroupEndDate: String(binaryFromTicks(toBigInt(raid.expireDate))),
      eventUid: String(toBigInt(raid.raidUID)),
    };
    applyRaidEventLink(raid, selection.eventID, selection.stageID || raid.stageID);
    raids[String(toBigInt(raid.raidUID))] = raid;
    repaired += 1;
  }
  return repaired;
}

function applyRaidEventLink(raid, eventID, stageID) {
  const selectedStageID = positiveInt(stageID);
  const previousStageID = positiveInt(raid && raid.stageID);
  raid.worldmapEventID = positiveInt(eventID);
  if (!selectedStageID) return raid;
  raid.stageID = selectedStageID;
  if (previousStageID !== selectedStageID) {
    const previousMaxHP = Math.max(0, Number(raid.maxHP || raid.maxHp || 0) || 0);
    const currentHP = Number(raid.curHP);
    const currentRatio = previousMaxHP > 0 && Number.isFinite(currentHP) ? clampNumber(currentHP / previousMaxHP, 0, 1) : 1;
    const maxHP = getRaidMaxHpForStage(selectedStageID);
    raid.maxHP = maxHP;
    raid.curHP = Number.isFinite(currentHP) && currentHP <= 0 ? 0 : Math.max(1, Math.round(maxHP * currentRatio));
  }
  return raid;
}

function getRaidMaxHpForStage(stageID) {
  const raidTemplet = getRaidTemplet(stageID);
  const basisMaxHP = Math.max(100000, Number(raidTemplet && raidTemplet.Raid_Damage_Basis) || 100000);
  const raidLevel = positiveInt(raidTemplet && raidTemplet.m_RaidLevel);
  const bossUnitStrId = getRaidBossUnitStrId(raidTemplet);
  const unitStat = bossUnitStrId ? getTables().unitStatsByStrId.get(bossUnitStrId) : null;
  const baseHP = Number(unitStat && unitStat.m_StatData && unitStat.m_StatData.m_Stat && unitStat.m_StatData.m_Stat.NST_HP);
  const perLevelHP = Number(unitStat && unitStat.m_StatData && unitStat.m_StatData.m_StatPerLevel && unitStat.m_StatData.m_StatPerLevel.NST_HP);
  if (raidLevel > 0 && Number.isFinite(baseHP) && baseHP > 0) {
    return Math.max(1, Math.round(baseHP + Math.max(0, raidLevel - 1) * (Number.isFinite(perLevelHP) ? perLevelHP : 0)));
  }
  return basisMaxHP;
}

function getRaidBossUnitStrId(raidTemplet) {
  if (!raidTemplet || typeof raidTemplet !== "object") return "";
  const tables = getTables();
  const dungeonID = positiveInt(raidTemplet.m_DungeonID);
  const dungeonStrID = String(raidTemplet.m_DungeonStrID || "");
  const dungeon = (dungeonID > 0 && tables.dungeonsById.get(dungeonID)) || (dungeonStrID && tables.dungeonsByStrId.get(dungeonStrID)) || null;
  const templetFileName = String(dungeon && dungeon.m_DungeonTempletFileName || "");
  if (!templetFileName) return "";
  const rows = getDungeonTempletRows(templetFileName);
  const boss = rows.find((row) => row && row.__key === "m_BossUnitStrID");
  return String((boss && boss.value) || "");
}

function getDungeonTempletRows(templetFileName) {
  const name = String(templetFileName || "").trim();
  if (!name) return [];
  const tables = getTables();
  const fileName = name.toLowerCase().endsWith(".json") ? name : `${name}.json`;
  if (tables.dungeonTempletRowsByFile.has(fileName)) return tables.dungeonTempletRowsByFile.get(fileName);
  let rows = [];
  for (const directory of ["ab_script_dungeon_templet_all", "ab_script_dungeon_templet"]) {
    rows = readGameplayTableRecords(directory, fileName, { logLabel: "world-map" });
    if (rows.length) break;
  }
  tables.dungeonTempletRowsByFile.set(fileName, rows);
  return rows;
}

function selectWorldMapRaidEvent(cityOrId = 1, mission = null, seed = "", preferredStageID = 0) {
  const city = cityOrId && typeof cityOrId === "object" ? cityOrId : { cityID: cityOrId };
  const cityID = positiveInt(city.cityID) || firstCityId();
  const candidates = getWorldMapRaidEventCandidates(positiveInt(mission && mission.m_WorldmapEventGroup));
  if (!candidates.length) {
    return {
      event: null,
      eventID: 2001001,
      stageID: positiveInt(preferredStageID) || 11015,
    };
  }

  const preferred = positiveInt(preferredStageID);
  const facilityLevel = getRaidFacilityLevel(city);
  let pool = candidates.filter((row) => getRaidEventRequiredBuildingLevel(row, RAID_FACILITY_BUILDING_ID) === facilityLevel);
  if (preferred && pool.length) {
    const preferredPool = pool.filter((row) => positiveInt(row.STAGE_ID) === preferred);
    if (preferredPool.length) pool = preferredPool;
  }
  if (!pool.length && facilityLevel > 0) {
    pool = candidates.filter((row) => getRaidEventRequiredBuildingLevel(row, RAID_FACILITY_BUILDING_ID) <= facilityLevel);
    if (preferred && pool.length) {
      const preferredPool = pool.filter((row) => positiveInt(row.STAGE_ID) === preferred);
      if (preferredPool.length) pool = preferredPool;
    }
  }
  if (!pool.length) pool = candidates;
  const event = pickWeightedRaidEvent(pool, seed || `${cityID}:${facilityLevel}:world-map-raid-event`);
  return {
    event,
    eventID: positiveInt(event && event.EVENT_ID) || 2001001,
    stageID: positiveInt(event && event.STAGE_ID) || preferred || 11015,
  };
}

function selectWorldMapRaidEventByLevel(level, seed = "", groupID = 0) {
  const requestedLevel = positiveInt(level);
  if (requestedLevel >= 666) {
    const sephira = selectSephiraRaidEvent(seed || `${requestedLevel}:sephira-raid-level`, groupID);
    if (sephira.eventID && sephira.stageID) return sephira;
    return { event: null, eventID: 0, stageID: 0, raidLevel: 0, exactLevel: false, raidFamily: "sephira" };
  }

  const candidates = getWorldMapRaidEventCandidates(groupID)
    .map((event) => {
      const stageID = positiveInt(event && event.STAGE_ID);
      const raidTemplet = getRaidTemplet(stageID);
      return {
        event,
        eventID: positiveInt(event && event.EVENT_ID),
        stageID,
        raidLevel: positiveInt(raidTemplet && raidTemplet.m_RaidLevel),
      };
    })
    .filter((entry) => entry.eventID > 0 && entry.stageID > 0 && entry.raidLevel > 0);

  if (!candidates.length) {
    return { event: null, eventID: 0, stageID: 0, raidLevel: 0, exactLevel: false };
  }

  let pool = requestedLevel > 0 ? candidates.filter((entry) => entry.raidLevel === requestedLevel) : candidates;
  let exactLevel = pool.length > 0;
  if (!pool.length) {
    const closestDelta = candidates.reduce(
      (best, entry) => Math.min(best, Math.abs(entry.raidLevel - requestedLevel)),
      Number.MAX_SAFE_INTEGER
    );
    pool = candidates.filter((entry) => Math.abs(entry.raidLevel - requestedLevel) === closestDelta);
    exactLevel = false;
  }

  const event = pickWeightedRaidEvent(
    pool.map((entry) => entry.event),
    seed || `${requestedLevel}:admin-raid-level`
  );
  const selected = pool.find((entry) => entry.event === event) || pool[0];
  return { ...selected, exactLevel };
}

function selectSephiraRaidEvent(seed = "", groupID = 0) {
  const candidates = getWorldMapRaidEventCandidates(groupID)
    .filter(isSephiraRaidEvent)
    .map((event) => {
      const stageID = positiveInt(event && event.STAGE_ID);
      const raidTemplet = getRaidTemplet(stageID);
      return {
        event,
        eventID: positiveInt(event && event.EVENT_ID),
        stageID,
        raidLevel: positiveInt(raidTemplet && raidTemplet.m_RaidLevel) || 666,
        exactLevel: true,
        raidFamily: "sephira",
      };
    })
    .filter((entry) => entry.eventID > 0 && entry.stageID > 0);
  if (!candidates.length) return { event: null, eventID: 0, stageID: 0, raidLevel: 0, exactLevel: false, raidFamily: "sephira" };
  const event = pickWeightedRaidEvent(
    candidates.map((entry) => entry.event),
    seed || "sephira-raid"
  );
  return candidates.find((entry) => entry.event === event) || candidates[0];
}

function isSephiraRaidEvent(event) {
  const stageID = positiveInt(event && event.STAGE_ID);
  if (stageID >= 700000 && stageID < 701000) return true;
  const text = [
    event && event.WORLDMAP_EVENT_SD,
    event && event.EVENT_PREFAB,
    event && event.EVENT_BUNDLE,
    getRaidTemplet(stageID) && getRaidTemplet(stageID).m_StageStrID,
    getRaidTemplet(stageID) && getRaidTemplet(stageID).m_DungeonStrID,
    getRaidTemplet(stageID) && getRaidTemplet(stageID).m_FaceCardName,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  return text.includes("RAID_BOSS_4") || text.includes("SEPHIRA");
}

function getWorldMapRaidEventCandidates(groupID = 0) {
  const rows = getTables().worldMapEventGroups
    .filter(isUsableWorldMapRaidEvent)
    .filter((row) => {
      const rowGroupID = positiveInt(row.GROUP_ID);
      return groupID > 0 ? rowGroupID === groupID : rowGroupID === 1 || rowGroupID === 0;
    })
    .sort((left, right) => Number(left.EVENT_ID || 0) - Number(right.EVENT_ID || 0));
  if (rows.length || groupID <= 0) return rows;
  return getWorldMapRaidEventCandidates(0);
}

function getWorldMapEventById(eventID) {
  const id = positiveInt(eventID);
  if (!id) return null;
  return getTables().worldMapEventGroups.find((row) => Number(row.EVENT_ID || 0) === id) || null;
}

function isCompatibleRaidEvent(event, stageID) {
  if (!isUsableWorldMapRaidEvent(event)) return false;
  if (positiveInt(event.STAGE_ID) !== positiveInt(stageID)) return false;
  return true;
}

function isUsableWorldMapRaidEvent(event) {
  if (!event || String(event.WORLDMAP_EVENT_TYPE || "").toUpperCase() !== "WET_RAID") return false;
  if (Array.isArray(event.listContentsTagAllow) && event.listContentsTagAllow.includes("SINGLE_RAID")) return false;
  if (Array.isArray(event.listContentsTagAllow) && event.listContentsTagAllow.includes("RAID_SEASON_DUMMY")) return false;
  if (!String(event.WORLDMAP_EVENT_SD || "").startsWith("AB_UNIT_SD")) return false;
  return Boolean(getTables().raidsByStageId.get(positiveInt(event.STAGE_ID)));
}

function isRaidEventForBranchFacility(event, city) {
  return getRaidEventRequiredBuildingLevel(event, RAID_FACILITY_BUILDING_ID) === getRaidFacilityLevel(city);
}

function getRaidFacilityLevel(city) {
  const explicit = positiveInt(process.env.CS_WORLDMAP_RAID_FACILITY_LEVEL);
  if (explicit) return explicit;
  const building = city && city.buildings && city.buildings[String(RAID_FACILITY_BUILDING_ID)];
  return Math.max(0, Number(building && building.level) || 0);
}

function getRaidEventRequiredBuildingLevel(event, buildingID) {
  const ids = parseCsvInts(event && event.REQ_BUILDING_ID);
  const levels = parseCsvInts(event && event.REQ_BUILDING_LEVEL);
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] === Number(buildingID)) return Math.max(0, Number(levels[index] || 0) || 0);
  }
  return 0;
}

function pickWeightedRaidEvent(rows, seed) {
  const candidates = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, row) => sum + Math.max(1, Number(row.RATIO || row.ratio || 0) || 1), 0);
  let roll = hashString(`${seed}:weighted-raid-event`) % Math.max(1, total);
  for (const row of candidates) {
    roll -= Math.max(1, Number(row.RATIO || row.ratio || 0) || 1);
    if (roll < 0) return row;
  }
  return candidates[candidates.length - 1];
}

function parseCsvInts(value) {
  if (Array.isArray(value)) return value.map(positiveInt).filter((entry) => entry >= 0);
  const text = String(value == null ? "" : value).trim();
  if (!text) return [];
  return text.split(",").map((entry) => Math.max(0, Number(String(entry).trim()) || 0));
}

function currentRaidSeasonId() {
  const explicit = positiveInt(process.env.CS_RAID_SEASON_ID);
  if (explicit) return explicit;
  const seasons = getTables().raidSeasons.map((row) => positiveInt(row.Raid_Season_ID)).filter(Boolean).sort((a, b) => a - b);
  return seasons[0] || 10001;
}

function getDiveDungeonId(stageID, sectorType = DIVE_SECTOR_TYPE.POINCARE, slotIndex = 0, setIndex = 0) {
  const templet = getDiveTemplet(stageID);
  return findDiveBattleDungeonId(templet, DIVE_DUNGEON_PREFIX_BY_SECTOR[sectorType] || "POINCARE", slotIndex, setIndex);
}

function getDiveBossDungeonId(stageID, slotIndex = 0, setIndex = 0) {
  const templet = getDiveTemplet(stageID);
  return findDiveBattleDungeonId(templet, "BOSS", slotIndex, setIndex);
}

function findDiveBattleDungeonId(templet, role, slotIndex = 0, setIndex = 0) {
  const tables = getTables();
  const depth = Math.max(1, Number(templet && templet.DEPTH) || 1);
  const variant = Math.max(1, Math.min(3, ((Number(slotIndex || 0) + Number(setIndex || 0)) % 3) + 1));
  const difficulty = isHardDiveTemplet(templet) ? "HARD" : "EASY";
  const candidates = [
    `NKM_DIVE_BATTLE_${role}_${difficulty}_${depth}${variant}`,
    `NKM_DIVE_BATTLE_${role}_${difficulty}_${depth}1`,
    `NKM_DIVE_BATTLE_${role}_${difficulty}_${depth}`,
    `NKM_DIVE_BATTLE_${role}_${difficulty}_11`,
  ];
  if (role === "BOSS") {
    candidates.push(`NKM_DIVE_BATTLE_SECTORBOSS_${Math.max(1, Math.min(10, depth))}`, "NKM_DIVE_BATTLE_SECTORBOSS_1");
  }
  for (const strId of candidates) {
    const direct = tables.dungeonsByStrId.get(strId);
    if (direct && positiveInt(direct.m_DungeonID)) return positiveInt(direct.m_DungeonID);
  }

  const prefix = `NKM_DIVE_BATTLE_${role}_${difficulty}_${depth}`;
  const fallback = tables.dungeonTemplets.find((row) => String(row && row.m_DungeonStrID || "").startsWith(prefix));
  if (fallback && positiveInt(fallback.m_DungeonID)) return positiveInt(fallback.m_DungeonID);

  const loosePrefix = `NKM_DIVE_BATTLE_${role}_`;
  const looseFallback = tables.dungeonTemplets.find((row) => String(row && row.m_DungeonStrID || "").startsWith(loosePrefix));
  if (looseFallback && positiveInt(looseFallback.m_DungeonID)) return positiveInt(looseFallback.m_DungeonID);

  const anyDive = tables.dungeonTemplets.find((row) => /^NKM_DIVE_BATTLE_/.test(String(row && row.m_DungeonStrID || "")));
  return positiveInt(anyDive && anyDive.m_DungeonID) || positiveInt(templet && templet.STAGE_ID) || 1010;
}

function isHardDiveTemplet(templet) {
  return /HARD/i.test(String(templet && (templet.DIVE_STAGE_TYPE || templet.STAGE_TYPE || "")));
}

function getKnownDungeonId(dungeonID) {
  const id = positiveInt(dungeonID);
  return id > 0 && getTables().dungeonsById.has(id) ? id : 0;
}

function defaultNextUid(user) {
  return String(toBigInt(user && user.userUid ? user.userUid : 1000000000n) * 1000000n + 500000n);
}

function nextWorldMapUid(user, options = {}) {
  const state = ensureBareWorldMapState(user, options);
  state.nextUid = String(state.nextUid || defaultNextUid(user));
  const next = toBigInt(state.nextUid || 0);
  state.nextUid = String(next + 1n);
  return next;
}

function getSocketUser(ctx, socket) {
  const user = (socket.session && socket.session.user) || (typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {});
  if (socket.session) socket.session.user = user;
  try {
    ensureArmy(user);
  } catch (_) {
    // Army seeding is best-effort here; world-map packets can still serialize without a roster.
  }
  return user;
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : encryptedPayload || Buffer.alloc(0);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case 802:
        return {
          selectDeckIndex: reader.byte(),
          raidUID: reader.long(),
          buffList: reader.intList(),
          isTryAssist: reader.bool(),
          supportingUserUid: reader.long(),
        };
      case 2002:
        return { cityID: reader.int(), isCash: reader.bool() };
      case 2004:
        return { cityID: reader.int(), leaderUID: reader.long() };
      case 2006:
      case 2008:
        return { cityID: reader.int(), missionID: reader.int() };
      case 2010:
      case 2012:
      case 2014:
      case 2024:
        return { cityID: reader.int() };
      case 2018:
      case 2020:
      case 2022:
        return { cityID: reader.int(), buildID: reader.int() };
      case 1206:
        return { cityID: reader.int(), stageID: reader.int(), deckIndexeList: reader.intList(), isDiveStorm: reader.bool() };
      case 1208:
        return { slotIndex: reader.int() };
      case 1212:
        return { isAuto: reader.bool() };
      case 1215:
        return { artifactID: reader.int() };
      case 1217:
        return { selectDeckIndex: reader.byte() };
      case 1249:
        return { stageId: reader.int(), skipCount: reader.int(), cityId: reader.int() };
      case 885:
        return { raidUid: reader.long(), isTryAssist: reader.bool() };
      case 2204:
      case 2208:
      case 2212:
        return { raidUID: reader.long() };
      case 2217:
        return { raidPointReward: reader.int() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[world-map:${packetId}] request decode failed: ${err.message}`);
    return {};
  }
}

function createReader(payload) {
  let offset = 0;
  return {
    int() {
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    },
    long() {
      const read = readSignedVarLong(payload, offset);
      offset = read.offset;
      return read.value;
    },
    bool() {
      const read = readBool(payload, offset);
      offset = read.offset;
      return read.value;
    },
    byte() {
      const read = readByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    intList() {
      const read = readSignedVarIntList(payload, offset);
      offset = read.offset;
      return read.value;
    },
  };
}

function describeRequest(packetId, req) {
  if (!req || !Object.keys(req).length) return "req={}";
  return Object.entries(req)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("/") : String(value)}`)
    .join(" ");
}

function getContextNow(ctx) {
  try {
    if (ctx && typeof ctx.dateTimeBinaryNow === "function") return ctx.dateTimeBinaryNow();
  } catch (_) {
    // fall through to local clock
  }
  return binaryNow();
}

function binaryNow(options = {}) {
  if (options && options.now != null) return toBigInt(options.now);
  return binaryFromTicks(BigInt(Date.now()) * 10000n + TICKS_AT_UNIX_EPOCH);
}

function ticksNow(options = {}) {
  return ticksFromDateTimeBinary(binaryNow(options));
}

function binaryFromTicks(ticks) {
  return (toBigInt(ticks) & DATE_TIME_TICK_MASK) | DATE_TIME_LOCAL_MASK;
}

function ticksFromDateTimeBinary(value) {
  const raw = toBigInt(value || 0);
  return raw > 0n ? raw & DATE_TIME_TICK_MASK : 0n;
}

function dayKeyFromTicks(ticks) {
  const unixMs = Number((toBigInt(ticks) - TICKS_AT_UNIX_EPOCH) / 10000n);
  const date = Number.isFinite(unixMs) ? new Date(unixMs) : new Date();
  return Number.isNaN(date.getTime()) ? "1970-01-01" : date.toISOString().slice(0, 10);
}

function dayNumberFromKey(dayKey) {
  const time = Date.parse(`${String(dayKey || "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(time)) return 0;
  return Math.floor(time / 86400000);
}

function positiveInt(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function clampPositiveInt(value, min, max) {
  const number = positiveInt(value) || min;
  return Math.max(min, Math.min(max, number));
}

function clampBigInt(value, min, max) {
  let result = toBigInt(value);
  if (result < min) result = min;
  if (result > max) result = max;
  return result;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function uniquePositiveInts(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => positiveInt(value)).filter(Boolean))).sort((a, b) => a - b);
}

function uniqueNonNegativeInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Math.trunc(Number(value)))
        .filter((value) => Number.isFinite(value) && value >= 0)
    )
  ).sort((a, b) => a - b);
}

function uniquePositiveIntsInOrder(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = positiveInt(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function isActiveEventGroup(group) {
  return positiveInt(group && group.worldmapEventID) > 0 && toBigInt(group && group.eventUid) > 0n;
}

function envFlag(...keys) {
  return keys.some((key) => {
    const value = process.env[key];
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
  });
}

function envFlagDefault(defaultValue, ...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value == null) continue;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return Boolean(defaultValue);
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

module.exports = {
  createWorldMapHandlers,
  ensureWorldMapState,
  buildWorldMapData,
  getWorldMapCityIds,
  buildWorldMapCityData,
  buildActiveDiveGameData,
  buildDiveClearData,
  buildDiveHistoryData,
  buildDiveSyncData,
  prepareDiveGameLoad,
  completeDiveBattle,
  sendActiveRaidData,
  sendRaidResultData,
  sendRaidStateData,
  sendRaidSnapshotData,
  getRaidSnapshot,
  sendWorldMapData,
  recordRaidBattleResult,
  syncRaidCombatHpFromBattleState,
  reserveRaidAttempt,
  spawnAdminRaid,
  spawnSephiraRaid,
  killRaidInBranch,
  clearActiveRaids,
  hasWorldMapProgress,
  refreshWorldMapState,
  unlockCity,
  startWorldMapMission,
  completeWorldMapMission,
};
