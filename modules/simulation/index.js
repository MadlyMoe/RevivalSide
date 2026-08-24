const {
  buildItemMiscData,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  toBigInt,
  writeBool,
  writeFloatLE,
  writeInt64LE,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");
const asyncPvp = require("../async-pvp");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const { getMiscItem, spendMiscItem } = require("../inventory");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking } = require("../mission-tracking");
const { getArmyUnits } = require("../unit");

const COUNTERCASE_UNLOCK_REQ = 1204;
const COUNTERCASE_UNLOCK_ACK = 1205;
const DUNGEON_SKIP_REQ = 855;
const DUNGEON_SKIP_ACK = 856;
const START_SIMULATED_PVP_TEST_REQ = 2684;
const START_SIMULATED_PVP_TEST_ACK = 2685;
const NGT_PVE_SIMULATED = 27;
const PVP_RESULT_WIN = 0;
const PROTOCOL_VERSION = 960;
const NEC_OK = 0;
const NEC_FAIL_INVALID_DUNGEON_ID = 64;
const NEC_FAIL_LOCKED_EPISODE = 67;
const NEC_FAIL_INSUFFICIENT_INFORMATION = 99;
const NEC_FAIL_INSUFFICIENT_ITEM = 111;
const NEC_FAIL_COUNTERCASE_ALREADY_UNLOCKED = 292;
const NEC_FAIL_INVALID_REQUEST = 20191;
const NEC_FAIL_REWARD_MULTIPLY_OVER_DAILY_ENTER_LIMIT = 20395;
const NEC_FAIL_SKIP_NOT_SUPPORTED = 20798;
const NEC_FAIL_NEED_DUNGEON_CLEAR = 20799;
const NEC_FAIL_NEED_GOLD_MEDAL = 20800;
const NEC_FAIL_INVALID_SKIP_COUNT = 20805;
const COUNTERCASE_EPISODE_ID = 50;
const MAX_DUNGEON_SKIP_COUNT = 99;
const MAX_DUNGEON_SKIP_UNITS = 32;
let counterCaseCatalog = null;

function createSimulationHandlers() {
  return [
    {
      packetId: DUNGEON_SKIP_REQ,
      name: "DUNGEON_SKIP_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeDungeonSkipReq(ctx, packet.payload);
        const payload =
          ctx && typeof ctx.buildDungeonSkipAckPayload === "function"
            ? ctx.buildDungeonSkipAckPayload(socket, req)
            : buildDungeonSkipAckPayload(NEC_FAIL_INVALID_REQUEST);
        const response = readSignedVarInt(payload, 0);
        console.log(
          `[simulation:DUNGEON_SKIP_REQ] ACK packetId=${DUNGEON_SKIP_ACK} error=${response.value} dungeonID=${req.dungeonId} skip=${req.skip}`
        );
        send(ctx, socket, packet, DUNGEON_SKIP_ACK, payload, "dungeon-skip");
        if (response.value === NEC_OK && ctx && typeof ctx.sendStageClearMissionUpdate === "function") {
          ctx.sendStageClearMissionUpdate(socket, user, { label: "simulation-skip-mission-update" });
        }
        return true;
      },
    },
    {
      packetId: COUNTERCASE_UNLOCK_REQ,
      name: "COUNTERCASE_UNLOCK_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeCounterCaseUnlockReq(ctx, packet.payload);
        const result = unlockCounterCaseFromRequest(user, req);
        const payload = buildCounterCaseUnlockAckPayload(result.errorCode, result.dungeonID, result.costItem);
        console.log(
          `[simulation:COUNTERCASE_UNLOCK_REQ] ACK packetId=${COUNTERCASE_UNLOCK_ACK} error=${result.errorCode} dungeonID=${result.dungeonID}`
        );
        send(ctx, socket, packet, COUNTERCASE_UNLOCK_ACK, payload, "countercase-unlock");
        if (result.errorCode !== NEC_OK) return true;
        const missionTracking = mergeTrackings(
          track(ctx, user, "COUNTER_CASE_OPEN", 1, { dungeonId: result.dungeonID, value: result.dungeonID }),
          track(ctx, user, "COUNTER_CASE_OPENED", 1, { dungeonId: result.dungeonID, value: result.dungeonID })
        );
        completeMissionTracking(ctx, socket, user, missionTracking, { label: "countercase-mission-update" });
        if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
          ctx.invalidateJoinLobbyAckPayloadCache("countercase-unlock");
        }
        persist(ctx);
        return true;
      },
    },
    {
      packetId: START_SIMULATED_PVP_TEST_REQ,
      name: "START_SIMULATED_PVP_TEST_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeStartSimulatedPvpTestReq(ctx, packet.payload);
        const result = ctx && typeof ctx.buildSimulatedPvpTestResult === "function"
          ? ctx.buildSimulatedPvpTestResult(socket, user, req)
          : { errorCode: 20346, changed: false, payload: buildStartSimulatedPvpTestAckPayload(ctx, user, req, { errorCode: 20346 }) };
        console.log(
          `[simulation:START_SIMULATED_PVP_TEST_REQ] ACK packetId=${START_SIMULATED_PVP_TEST_ACK} error=${result.errorCode} a=${String(
            req.playerUserUidA
          )} b=${String(req.playerUserUidB)}`
        );
        send(ctx, socket, packet, START_SIMULATED_PVP_TEST_ACK, result.payload, "simulated-pvp-test");
        if (result.errorCode !== NEC_OK) return true;
        completeMissionTracking(ctx, socket, user, track(ctx, user, "PVP_PLAY_ASYNC", 1, { value: 1 }), {
          label: "simulated-pvp-mission-update",
        });
        if (result.changed && ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
          ctx.invalidateJoinLobbyAckPayloadCache("simulated-pvp-test");
        }
        persist(ctx);
        return true;
      },
    },
  ];
}

function ensureSimulationState(user) {
  if (!user || typeof user !== "object") return { counterCases: {}, simulatedPvpHistory: [] };
  user.simulation = user.simulation && typeof user.simulation === "object" ? user.simulation : {};
  user.simulation.counterCases =
    user.simulation.counterCases && typeof user.simulation.counterCases === "object" ? user.simulation.counterCases : {};
  user.simulation.simulatedPvpHistory = Array.isArray(user.simulation.simulatedPvpHistory)
    ? user.simulation.simulatedPvpHistory
    : [];
  return user.simulation;
}

function hasSimulationState(user) {
  if (!user || typeof user !== "object" || !user.simulation) return false;
  const state = ensureSimulationState(user);
  return Object.keys(state.counterCases || {}).length > 0 || state.simulatedPvpHistory.length > 0;
}

function unlockCounterCase(user, dungeonID) {
  const state = ensureSimulationState(user);
  const resolvedDungeonID = Math.max(0, Number(dungeonID || 0) || 0);
  const key = String(resolvedDungeonID);
  const previous = state.counterCases[key] || {};
  state.counterCases[key] = {
    dungeonID: resolvedDungeonID,
    unlocked: true,
    unlockedAt: previous.unlockedAt || new Date().toISOString(),
  };
  return state.counterCases[key];
}

function unlockCounterCaseFromRequest(user, req = {}) {
  const dungeonID = Number(req.dungeonID || 0) || 0;
  if (!req.valid) return { errorCode: NEC_FAIL_INVALID_REQUEST, dungeonID: 0, costItem: null };
  const stage = getCounterCaseStageByDungeonId(dungeonID);
  if (!stage) return { errorCode: NEC_FAIL_INVALID_DUNGEON_ID, dungeonID, costItem: null };
  if (!isCounterCaseStageUnlocked(user, stage)) {
    return { errorCode: NEC_FAIL_LOCKED_EPISODE, dungeonID, costItem: null };
  }
  if (isCounterCaseUnlocked(user, dungeonID)) {
    return { errorCode: NEC_FAIL_COUNTERCASE_ALREADY_UNLOCKED, dungeonID, costItem: null };
  }

  const itemId = Math.max(0, Number(stage.m_UnlockItemID || 0) || 0);
  const price = BigInt(Math.max(0, Number(stage.m_UnlockItemPrice || 0) || 0));
  let costItem = null;
  if (itemId > 0 && price > 0n) {
    const current = getMiscItem(user, itemId);
    const balance = BigInt(current.countFree || 0) + BigInt(current.countPaid || 0);
    if (balance < price) return { errorCode: NEC_FAIL_INSUFFICIENT_INFORMATION, dungeonID, costItem: null };
    costItem = spendMiscItem(user, itemId, price);
  }
  unlockCounterCase(user, dungeonID);
  return { errorCode: NEC_OK, dungeonID, costItem };
}

function isCounterCaseUnlocked(user, dungeonID) {
  const state = ensureSimulationState(user);
  return normalizeCounterCaseState(state.counterCases[String(Number(dungeonID || 0))]).unlocked;
}

function isCounterCaseStageUnlocked(user, stage) {
  const type = String(stage && stage.m_UnlockReqType || "");
  const value = Number(stage && stage.m_UnlockReqValue || 0) || 0;
  if (type === "SURT_ALWAYS_UNLOCKED") return true;
  if (type === "SURT_CLEAR_DUNGEON") {
    return Boolean(user && user.dungeonClear && user.dungeonClear[String(value)]);
  }
  if (type === "SURT_UNIT_GET") {
    const collected = user && user.collection && Array.isArray(user.collection.units) ? user.collection.units : [];
    return collected.some((unitId) => Number(unitId) === value) || getArmyUnits(user).some((unit) => Number(unit.unitId) === value);
  }
  const match = /^SURT_UNIT_LEVEL_(25|50|80|100)$/.exec(type);
  return Boolean(match && getArmyUnits(user).some((unit) => Number(unit.unitId) === value && Number(unit.level || 0) >= Number(match[1])));
}

function getCounterCaseStageByDungeonId(dungeonID) {
  return loadCounterCaseCatalog().get(Number(dungeonID)) || null;
}

function getAllCounterCaseStages() {
  return Array.from(loadCounterCaseCatalog().values());
}

function loadCounterCaseCatalog() {
  if (counterCaseCatalog) return counterCaseCatalog;
  const dungeonsByStrId = new Map(
    readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json")
      .filter((row) => row && row.m_DungeonStrID)
      .map((row) => [String(row.m_DungeonStrID), row])
  );
  counterCaseCatalog = new Map();
  for (const stage of readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json")) {
    if (!stage || Number(stage.m_EpisodeID) !== COUNTERCASE_EPISODE_ID) continue;
    const dungeon = dungeonsByStrId.get(String(stage.m_StageBattleStrID || ""));
    const dungeonID = Number(dungeon && dungeon.m_DungeonID);
    if (Number.isInteger(dungeonID) && dungeonID > 0) counterCaseCatalog.set(dungeonID, { ...stage, dungeonID });
  }
  return counterCaseCatalog;
}

function buildCounterCaseDataEntries(user) {
  const state = ensureSimulationState(user);
  return Object.values(state.counterCases || {})
    .map(normalizeCounterCaseState)
    .filter((entry) => entry.dungeonID > 0 && entry.unlocked)
    .sort((left, right) => left.dungeonID - right.dungeonID)
    .map((entry) => [entry.dungeonID, buildCounterCaseData(entry)]);
}

function normalizeCounterCaseState(entry) {
  return {
    dungeonID: Number((entry && (entry.dungeonID || entry.dungeonId || entry.m_DungeonID)) || 0) || 0,
    unlocked: entry && (entry.unlocked === true || entry.m_Unlocked === true),
  };
}

function buildCounterCaseData(entry) {
  const data = normalizeCounterCaseState(entry);
  return Buffer.concat([writeSignedVarInt(data.dungeonID), writeBool(data.unlocked)]);
}

function buildCounterCaseUnlockAckPayload(errorCode, dungeonID, costItem) {
  return Buffer.concat([
    writeSignedVarInt(Number(errorCode || 0) || 0),
    writeSignedVarInt(Number(dungeonID || 0) || 0),
    costItem ? writeNullableObject(buildItemMiscData(costItem)) : writeNullObject(),
  ]);
}

function buildDungeonSkipAckPayload(errorCode = NEC_OK, data = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(errorCode || 0) || 0),
    data.stagePlayData ? writeNullableObject(data.stagePlayData) : writeNullObject(),
    writeObjectList(Array.isArray(data.rewardDatas) ? data.rewardDatas.map((entry) => writeNullableObject(entry)) : []),
    writeObjectList(Array.isArray(data.costItems) ? data.costItems.map((entry) => writeNullableObject(entry)) : []),
    writeObjectList(Array.isArray(data.updatedUnits) ? data.updatedUnits.map((entry) => writeNullableObject(entry)) : []),
  ]);
}

function validateDungeonSkipRequest(user, req = {}, options = {}) {
  if (!req.valid) return dungeonSkipFailure(NEC_FAIL_INVALID_REQUEST);
  const dungeonId = Number(req.dungeonId);
  const skip = Number(req.skip);
  if (!Number.isInteger(dungeonId) || dungeonId <= 0) return dungeonSkipFailure(NEC_FAIL_INVALID_DUNGEON_ID);
  if (!Number.isInteger(skip) || skip < 1 || skip > MAX_DUNGEON_SKIP_COUNT) {
    return dungeonSkipFailure(NEC_FAIL_INVALID_SKIP_COUNT);
  }

  const stage = options.stage && typeof options.stage === "object" ? options.stage : null;
  if (!stage || Number(stage.dungeonId || stage.dungeonID) !== dungeonId || Number(stage.stageId || 0) <= 0) {
    return dungeonSkipFailure(NEC_FAIL_INVALID_DUNGEON_ID);
  }
  const rewardMultiplyMax = Math.max(0, Number(stage.rewardMultiplyMax || 0) || 0);
  if (
    stage.activeBattleSkip !== true ||
    stage.noAutoRepeat === true ||
    String(stage.stageType || "") !== "ST_DUNGEON" ||
    rewardMultiplyMax <= 1
  ) {
    return dungeonSkipFailure(NEC_FAIL_SKIP_NOT_SUPPORTED);
  }
  if (skip > Math.min(MAX_DUNGEON_SKIP_COUNT, rewardMultiplyMax)) {
    return dungeonSkipFailure(NEC_FAIL_INVALID_SKIP_COUNT);
  }

  const clear = user && user.dungeonClear && user.dungeonClear[String(dungeonId)];
  if (!clear) return dungeonSkipFailure(NEC_FAIL_NEED_DUNGEON_CLEAR);
  if (clear.missionResult1 !== true || clear.missionResult2 !== true) {
    return dungeonSkipFailure(NEC_FAIL_NEED_GOLD_MEDAL);
  }

  const unitUids = Array.isArray(req.unitUids) ? req.unitUids.map((uid) => String(toBigInt(uid || 0))) : [];
  if (
    unitUids.length > MAX_DUNGEON_SKIP_UNITS ||
    unitUids.some((uid) => toBigInt(uid) <= 0n) ||
    new Set(unitUids).size !== unitUids.length
  ) {
    return dungeonSkipFailure(NEC_FAIL_INVALID_REQUEST);
  }
  const ownedUnits = unitUids.map((uid) => findDungeonSkipOwnedUnit(user, uid)).filter(Boolean);
  if (!Number(stage.eventDeckId || 0) && ownedUnits.length !== unitUids.length) {
    return dungeonSkipFailure(NEC_FAIL_INVALID_REQUEST);
  }

  const play = user && user.stagePlayData && user.stagePlayData[String(stage.stageId)];
  const playCount = Math.max(0, Number(play && play.playCount) || 0);
  const enterLimit = Math.max(0, Number(stage.enterLimit || 0) || 0);
  if (enterLimit > 0 && playCount + skip > enterLimit) {
    return dungeonSkipFailure(NEC_FAIL_REWARD_MULTIPLY_OVER_DAILY_ENTER_LIMIT);
  }

  const cost = normalizeDungeonSkipCost(stage.cost);
  if (cost) {
    const balance = getDungeonSkipItemBalance(user, cost.itemId);
    if (balance < BigInt(cost.count) * BigInt(skip)) return dungeonSkipFailure(NEC_FAIL_INSUFFICIENT_ITEM);
  }

  return {
    errorCode: NEC_OK,
    valid: true,
    dungeonId,
    skip,
    stage,
    cost,
    unitUids,
    ownedUnits,
  };
}

function executeDungeonSkip(user, req = {}, options = {}) {
  const validation = validateDungeonSkipRequest(user, req, options);
  if (!validation.valid) return validation;
  let snapshot;
  try {
    snapshot = cloneUserState(user);
    const costItems = validation.cost && typeof options.spendCost === "function"
      ? options.spendCost(validation)
      : [];
    if (validation.cost && (!Array.isArray(costItems) || costItems.length === 0)) {
      throw new Error("dungeon skip cost was not committed");
    }
    const rewardDatas = [];
    for (let index = 0; index < validation.skip; index += 1) {
      if (typeof options.clearOnce !== "function") throw new Error("dungeon skip clear authority is unavailable");
      const rewardData = options.clearOnce(validation, index);
      if (!rewardData) throw new Error(`dungeon skip clear ${index + 1} did not produce a reward set`);
      rewardDatas.push(rewardData);
    }
    const stagePlayData = typeof options.buildStagePlayData === "function"
      ? options.buildStagePlayData(validation)
      : null;
    if (!stagePlayData) throw new Error("dungeon skip stage play data is unavailable");
    const updatedUnits = typeof options.buildUpdatedUnits === "function"
      ? options.buildUpdatedUnits(validation)
      : [];
    return {
      ...validation,
      rewardDatas,
      costItems: Array.isArray(costItems) ? costItems : [],
      updatedUnits: Array.isArray(updatedUnits) ? updatedUnits : [],
      stagePlayData,
    };
  } catch (err) {
    if (snapshot) restoreUserState(user, snapshot);
    return dungeonSkipFailure(NEC_FAIL_INVALID_REQUEST, err);
  }
}

function normalizeDungeonSkipCost(cost) {
  const itemId = Number(cost && cost.itemId);
  const count = Number(cost && cost.count);
  return Number.isInteger(itemId) && itemId > 0 && Number.isInteger(count) && count > 0 ? { itemId, count } : null;
}

function findDungeonSkipOwnedUnit(user, unitUid) {
  const uid = String(toBigInt(unitUid || 0));
  const army = user && user.army && typeof user.army === "object" ? user.army : {};
  for (const bucketName of ["units", "ships", "trophies"]) {
    const bucket = army[bucketName] && typeof army[bucketName] === "object" ? army[bucketName] : {};
    const direct = bucket[uid];
    if (direct && typeof direct === "object") return direct;
    const matched = Object.values(bucket).find(
      (unit) => unit && String(toBigInt(unit.unitUid != null ? unit.unitUid : unit.m_UnitUID || 0)) === uid
    );
    if (matched) return matched;
  }
  return null;
}

function getDungeonSkipItemBalance(user, itemId) {
  const misc = user && user.inventory && user.inventory.misc && typeof user.inventory.misc === "object"
    ? user.inventory.misc
    : {};
  const item = misc[String(Number(itemId))] || {};
  return BigInt(item.countFree != null ? item.countFree : item.count || 0) + BigInt(item.countPaid || 0);
}

function dungeonSkipFailure(errorCode, error = null) {
  return { errorCode, valid: false, error: error ? String(error.message || error) : "" };
}

function cloneUserState(user) {
  return user && typeof user === "object" ? JSON.parse(JSON.stringify(user)) : null;
}

function restoreUserState(user, snapshot) {
  if (!user || typeof user !== "object" || !snapshot) return;
  for (const key of Object.keys(user)) delete user[key];
  Object.assign(user, snapshot);
}

function buildStartSimulatedPvpTestAckPayload(ctx, user, req = {}, options = {}) {
  const errorCode = Math.max(0, Number(options.errorCode || 0) || 0);
  if (errorCode) {
    return Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeNullObject()]);
  }
  const now = ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNowCompat();
  const history = options.history || {};

  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildReplayData({ now, ...options })),
    writeNullableObject(asyncPvp.buildPvpSingleHistoryData(history)),
  ]);
}

function buildReplayData(options = {}) {
  const now = options.now == null ? dateTimeBinaryNowCompat() : options.now;
  const syncPayloads = (Array.isArray(options.syncPayloads) ? options.syncPayloads : []).filter(Buffer.isBuffer);
  return Buffer.concat([
    writeString(""),
    writeString("9.2.c"),
    Buffer.from([0]), // sbyte streamID
    writeSignedVarInt(PROTOCOL_VERSION),
    writeInt64LE(now),
    Buffer.isBuffer(options.gameDataPayload) ? options.gameDataPayload : writeNullObject(),
    Buffer.isBuffer(options.gameRuntimeDataPayload) ? options.gameRuntimeDataPayload : writeNullObject(),
    writeObjectList(syncPayloads.map((payload) => writeNullableObject(payload))),
    writeSignedVarInt(Number(options.pvpResult == null ? PVP_RESULT_WIN : options.pvpResult)),
    writeFloatLE(Math.max(0, Number(options.gameEndTime || 0) || 0)),
    Buffer.isBuffer(options.gameRecordPayload) ? options.gameRecordPayload : writeNullObject(),
    writeObjectList([]), // emoticonList
  ]);
}

function decodeCounterCaseUnlockReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  try {
    const dungeon = readSignedVarInt(payload, 0);
    return { valid: dungeon.offset === payload.length, dungeonID: dungeon.value };
  } catch (err) {
    console.log(`[simulation:COUNTERCASE_UNLOCK_REQ] request decode failed: ${err.message}`);
    return { valid: false, dungeonID: 0 };
  }
}

function decodeDungeonSkipReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  let offset = 0;
  try {
    const dungeon = readSignedVarInt(payload, offset);
    offset = dungeon.offset;
    const skip = readSignedVarInt(payload, offset);
    offset = skip.offset;
    const units = readSignedVarLongList(payload, offset);
    offset = units.offset;
    return {
      valid: offset === payload.length,
      dungeonId: Number(dungeon.value),
      skip: Number(skip.value),
      unitUids: Array.isArray(units.value) ? units.value.map((uid) => String(toBigInt(uid || 0))) : [],
    };
  } catch (err) {
    console.log(`[simulation:DUNGEON_SKIP_REQ] request decode failed: ${err.message}`);
    return { valid: false, dungeonId: 0, skip: 0, unitUids: [] };
  }
}

function decodeStartSimulatedPvpTestReq(ctx, encryptedPayload) {
  const payload = decryptPayload(ctx, encryptedPayload);
  try {
    const playerA = readSignedVarLong(payload, 0);
    const playerB = readSignedVarLong(payload, playerA.offset);
    const canonical = Buffer.concat([writeSignedVarLong(playerA.value), writeSignedVarLong(playerB.value)]);
    return {
      valid: playerB.offset === payload.length && canonical.equals(payload),
      playerUserUidA: toBigInt(playerA.value || 0),
      playerUserUidB: toBigInt(playerB.value || 0),
    };
  } catch (err) {
    console.log(`[simulation:START_SIMULATED_PVP_TEST_REQ] request decode failed: ${err.message}`);
    return { valid: false, playerUserUidA: 0n, playerUserUidB: 0n };
  }
}

function decryptPayload(ctx, encryptedPayload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(encryptedPayload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
  }
}

function persist(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function track(ctx, user, condition, amount, details = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const now = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  const tracking = makeMissionTracking(now);
  const tracked = ctx.trackMissionEvent(user, condition, amount, { now, ...details });
  addMissionTrackingCondition(tracking, condition, tracked);
  return tracking;
}

function mergeTrackings(...trackings) {
  const merged = makeMissionTracking(trackings.find((tracking) => tracking && tracking.now) && trackings.find((tracking) => tracking && tracking.now).now);
  for (const tracking of trackings) {
    if (!tracking || !tracking.conditions) continue;
    for (const condition of tracking.conditions) merged.conditions.add(condition);
  }
  return merged;
}

function dateTimeBinaryNowCompat() {
  const ticksAtUnixEpoch = 621355968000000000n;
  const localMask = 0x4000000000000000n;
  return ticksAtUnixEpoch + BigInt(Date.now()) * 10000n | localMask;
}

module.exports = {
  createSimulationHandlers,
  buildDungeonSkipAckPayload,
  executeDungeonSkip,
  validateDungeonSkipRequest,
  DUNGEON_SKIP_ERROR_CODES: Object.freeze({
    OK: NEC_OK,
    INVALID_DUNGEON_ID: NEC_FAIL_INVALID_DUNGEON_ID,
    INSUFFICIENT_ITEM: NEC_FAIL_INSUFFICIENT_ITEM,
    INVALID_REQUEST: NEC_FAIL_INVALID_REQUEST,
    OVER_DAILY_ENTER_LIMIT: NEC_FAIL_REWARD_MULTIPLY_OVER_DAILY_ENTER_LIMIT,
    SKIP_NOT_SUPPORTED: NEC_FAIL_SKIP_NOT_SUPPORTED,
    NEED_DUNGEON_CLEAR: NEC_FAIL_NEED_DUNGEON_CLEAR,
    NEED_GOLD_MEDAL: NEC_FAIL_NEED_GOLD_MEDAL,
    INVALID_SKIP_COUNT: NEC_FAIL_INVALID_SKIP_COUNT,
  }),
  ensureSimulationState,
  hasSimulationState,
  unlockCounterCase,
  unlockCounterCaseFromRequest,
  getCounterCaseStageByDungeonId,
  getAllCounterCaseStages,
  buildCounterCaseData,
  buildCounterCaseDataEntries,
  buildStartSimulatedPvpTestAckPayload,
  buildReplayData,
  decodeStartSimulatedPvpTestReq,
  START_SIMULATED_PVP_TEST_REQ,
  START_SIMULATED_PVP_TEST_ACK,
  NGT_PVE_SIMULATED,
};
