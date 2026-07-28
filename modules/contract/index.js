const { randomInt } = require("crypto");
const {
  writeSignedVarInt,
  writeInt64LE,
  writeNullableObject,
  writeNullObject,
  writeNullableObjectList,
  buildItemMiscData,
  buildUnitData,
  buildOperatorData,
  buildRewardData,
  buildContractStateData,
  buildContractBonusStateData,
  buildSelectableContractStateData,
  farFutureDateTimeBinary,
  readSignedVarInt,
} = require("../packet-codec");
const {
  getContractRecord,
  getVisibleContractIds,
  getContractPoolUnitIds,
  getContractPoolUnitEntries,
  getContractTabRecord,
  getSelectableContractRecord,
  getSelectableContractRecords,
  getSelectableContractPoolSlotEntries,
  getMiscContractRecord,
  getMiscItemTemplet,
  getCustomPickupContractRecords,
  getRandomGradeTable,
  getUnitTemplet,
  resolveUnitId,
} = require("../game-data");
const { grantUnit, grantOperator, grantUnitFromPiece, getPieceRequirement } = require("../unit");
const { grantRewardByType, createEmptyReward, mergeReward } = require("../reward");
const { spendMiscItem, toBigInt } = require("../inventory");
const { addMissionTrackingCondition, completeMissionTracking, makeMissionTracking, queueMissionTracking } = require("../mission-tracking");
const { dateFromDateTime, dateTimeBinaryForDate, utcDateKey } = require("../server-time");

const PACKETS = Object.freeze({
  CONTRACT_REQ: 2800,
  CONTRACT_ACK: 2801,
  SELECTABLE_CONTRACT_CHANGE_POOL_REQ: 2802,
  SELECTABLE_CONTRACT_CHANGE_POOL_ACK: 2803,
  SELECTABLE_CONTRACT_CONFIRM_REQ: 2804,
  SELECTABLE_CONTRACT_CONFIRM_ACK: 2805,
  CONTRACT_STATE_LIST_REQ: 2806,
  CONTRACT_STATE_LIST_ACK: 2807,
  MISC_CONTRACT_OPEN_REQ: 2808,
  MISC_CONTRACT_OPEN_ACK: 2809,
  INSTANT_CONTRACT_LIST_REQ: 2810,
  INSTANT_CONTRACT_LIST_ACK: 2811,
  CUSTOM_PICKUP_REQ: 2812,
  CUSTOM_PICKUP_ACK: 2813,
  CUSTOM_PICUP_SELECT_TARGET_REQ: 2814,
  CUSTOM_PICUP_SELECT_TARGET_ACK: 2815,
  EXCHANGE_PIECE_TO_UNIT_REQ: 1422,
  EXCHANGE_PIECE_TO_UNIT_ACK: 1423,
});

const CUSTOM_PICKUP_CATEGORY = 6;
const SELECTABLE_CONTRACT_SLOT_COUNT = 10;
const CUSTOM_PICKUP_TYPE_ORDER = Object.freeze({
  AWAKEN: 0,
  BASIC: 1,
  OPERATOR: 2,
});
const CONTRACT_COST_TYPE = Object.freeze({
  FREE_CHANCE: 0,
  TICKET: 1,
  MONEY: 2,
});
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTRACT_DAILY_RESET_HOUR_UTC = clampHour(process.env.CS_CONTRACT_DAILY_RESET_HOUR_UTC, 4);

function createContractHandler(packetId, name) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      ctx.socket = socket;
      const user = getSessionUser(ctx);
      const request = decodeRequest(ctx, packetId, packet.payload);
      const response = buildContractResponse(ctx, user, packetId, request);
      if (!response) return false;
      const missionTracking = trackContractMission(ctx, user, packetId, request);
      console.log(`[contract:${name}] ACK packetId=${response.packetId} ${formatRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "contract-mission-update" });
      persistUserDb(ctx);
      return true;
    },
  };
}

function trackContractMission(ctx, user, packetId, request = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const nowValue = now(ctx);
  const tracking = makeMissionTracking(nowValue);
  const track = (condition, amount = 1, details = {}) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, { now: nowValue, ...details });
    addMissionTrackingCondition(tracking, condition, tracked);
  };
  switch (packetId) {
    case PACKETS.CONTRACT_REQ:
    case PACKETS.CUSTOM_PICKUP_REQ:
    case PACKETS.MISC_CONTRACT_OPEN_REQ:
      track("UNIT_CONTRACT", Math.max(1, Number(request.count || 1) || 1));
      break;
    case PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ:
      track("UNIT_CONTRACT", 1, { contractId: request.contractId });
      break;
    default:
      break;
  }
  return tracking;
}

function trackResourceSpend(ctx, user, itemId, amount) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const numericItemId = Number(itemId || 0);
  const numericAmount = Math.max(0, Math.trunc(Number(amount || 0) || 0));
  if (numericItemId <= 0 || numericAmount <= 0) return;
  const nowValue = now(ctx);
  const tracking = makeMissionTracking(nowValue);
  const changed = ctx.trackMissionEvent(user, "USE_RESOURCE", numericAmount, {
    now: nowValue,
    itemId: numericItemId,
    resourceId: numericItemId,
    value: numericItemId,
  });
  addMissionTrackingCondition(tracking, "USE_RESOURCE", changed);
  queueMissionTracking(ctx, tracking);
}

function buildContractResponse(ctx, user, packetId, request) {
  switch (packetId) {
    case PACKETS.CONTRACT_STATE_LIST_REQ:
      return { packetId: PACKETS.CONTRACT_STATE_LIST_ACK, payload: buildContractStateListAck(user, ctx) };
    case PACKETS.INSTANT_CONTRACT_LIST_REQ:
      return { packetId: PACKETS.INSTANT_CONTRACT_LIST_ACK, payload: buildInstantContractListAck(user, ctx) };
    case PACKETS.CONTRACT_REQ:
      return { packetId: PACKETS.CONTRACT_ACK, payload: buildContractAck(ctx, user, request) };
    case PACKETS.CUSTOM_PICKUP_REQ:
      return { packetId: PACKETS.CUSTOM_PICKUP_ACK, payload: buildCustomPickupAck(ctx, user, request) };
    case PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ:
      return { packetId: PACKETS.CUSTOM_PICUP_SELECT_TARGET_ACK, payload: buildCustomPickupSelectTargetAck(user, request) };
    case PACKETS.MISC_CONTRACT_OPEN_REQ:
      return { packetId: PACKETS.MISC_CONTRACT_OPEN_ACK, payload: buildMiscContractOpenAck(ctx, user, request) };
    case PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ:
      return { packetId: PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_ACK, payload: buildSelectableChangePoolAck(ctx, user, request) };
    case PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ:
      return { packetId: PACKETS.SELECTABLE_CONTRACT_CONFIRM_ACK, payload: buildSelectableConfirmAck(ctx, user, request) };
    case PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ:
      return { packetId: PACKETS.EXCHANGE_PIECE_TO_UNIT_ACK, payload: buildPieceExchangeAck(ctx, user, request) };
    default:
      return null;
  }
}

function buildContractAck(ctx, user, request) {
  const contractId = resolveContractId(request.contractId);
  const count = Math.max(1, Number(request.count || 1));
  const costItems = spendContractCost(ctx, user, contractId, count, request.costType);
  const reward = rollContract(ctx, user, contractId, count, { fromContract: true });
  applyContractRewards(ctx, user, contractId, count, reward, { costType: request.costType });

  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(request.costType || 0)),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(reward.units.map(buildUnitData)),
    writeNullableObjectList(reward.operators.map(buildOperatorData)),
    writeNullableObject(buildRewardData(reward)),
    writeNullableObject(buildContractStateData(getContractState(user, contractId, ctx))),
    writeNullableObject(buildContractBonusStateData(getContractBonusState(user, contractId))),
    writeSignedVarInt(contractId),
    writeSignedVarInt(count),
  ]);
}

function buildCustomPickupAck(ctx, user, request) {
  const customPickupId = Number(request.customPickupId || 0);
  const count = Math.max(1, Number(request.count || 1));
  const pickup = getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === customPickupId) || {};
  const customState = getCustomPickupContractState(user, customPickupId);
  const poolId = pickup.m_UnitPoolID || customPickupId;
  const costItems = spendCostFromRecord(ctx, user, pickup, count, request.costType);
  const reward = createEmptyReward();
  if (String(pickup.m_ContractType || "") === "OPERATOR") {
    reward.operators.push(
      ...rollPoolOperators(user, poolId, count, {
        fromContract: true,
        regDate: now(ctx),
        sourceRecord: pickup,
        customPickupTargetUnitId: customState.customPickupTargetUnitId,
      })
    );
  } else {
    reward.units.push(
      ...rollPoolUnits(user, poolId, count, {
        fromContract: true,
        regDate: now(ctx),
        sourceRecord: pickup,
        customPickupTargetUnitId: customState.customPickupTargetUnitId,
      })
    );
  }
  applyRecordResultRewards(ctx, user, pickup, count, reward);
  customState.totalUseCount = getContractBonusState(user, pickup).useCount;
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(Number(request.costType || 0)),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(reward.units.map(buildUnitData)),
    writeNullableObjectList(reward.operators.map(buildOperatorData)),
    writeNullableObject(buildRewardData(reward)),
    writeNullableObject(buildCustomPickupContractData(customState)),
    writeSignedVarInt(customPickupId),
    writeSignedVarInt(count),
    writeNullableObject(buildContractBonusStateData(getContractBonusState(user, pickup))),
  ]);
}

function buildCustomPickupSelectTargetAck(user, request) {
  const customPickupId = Number(request.customPickupId || 0);
  const targetUnitId = Number(request.targetUnitId || 0);
  const pickup = getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === customPickupId) || {};
  const state = getCustomPickupContractState(user, customPickupId);
  const resolvedTargetId = normalizeCustomPickupTarget(pickup, targetUnitId, {
    includeOperators: String(pickup.m_ContractType || "") === "OPERATOR",
  });
  if (resolvedTargetId > 0) {
    const previousTargetId = Number(state.customPickupTargetUnitId || 0);
    const maxSelectCount = getCustomPickupMaxSelectCount(pickup);
    if (resolvedTargetId !== previousTargetId && (!maxSelectCount || state.currentSelectCount < maxSelectCount)) {
      state.customPickupTargetUnitId = resolvedTargetId;
      state.currentSelectCount += 1;
    }
  }
  if (String(pickup.m_ContractType || "") !== "AWAKEN") {
    const bonus = getContractBonusState(user, pickup);
    bonus.useCount = 0;
  }
  state.totalUseCount = getContractBonusState(user, pickup).useCount;
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildCustomPickupContractData(state)),
    writeNullableObject(buildContractBonusStateData(getContractBonusState(user, pickup))),
  ]);
}

function buildMiscContractOpenAck(ctx, user, request) {
  const count = Math.max(1, Number(request.count || 1));
  const sourceItemId = Number(request.miscItemId || 0);
  const costItem = sourceItemId > 0 ? spendMiscItem(user, sourceItemId, count, { regDate: now(ctx) }) : null;
  if (costItem) trackResourceSpend(ctx, user, sourceItemId, count);
  const contractId = resolveMiscContractId(sourceItemId);
  const result = openMiscContract(ctx, user, contractId, { count, sourceMiscItemId: sourceItemId }).result;

  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(costItem ? [buildItemMiscData(costItem)] : []),
    writeNullableObjectList(result.map(buildMiscContractResultData)),
  ]);
}

function openMiscContract(ctx, user, contractId, options = {}) {
  const record = getMiscContractRecord(contractId) || {};
  const count = Math.max(1, Number(options.count || record.m_UnitCount || 1));
  const poolId = record.m_UnitPoolID || contractId;
  const units = rollPoolUnits(user, poolId, count, {
    fromContract: true,
    regDate: options.regDate || now(ctx),
    sourceRecord: record,
  });
  const reward = createEmptyReward();
  reward.units.push(...units);
  return {
    reward,
    result: [
      {
        miscItemId: Number(options.sourceMiscItemId || contractId || 0),
        units,
      },
    ],
  };
}

function buildSelectableChangePoolAck(ctx, user, request) {
  const contractId = resolveSelectableContractId(request.contractId);
  const state = changeSelectableContractPool(user, contractId);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObject(buildSelectableContractStateData(state)),
  ]);
}

function buildSelectableConfirmAck(ctx, user, request) {
  const contractId = resolveSelectableContractId(request.contractId);
  const state = getSelectableContractState(user, contractId);
  let costItems = [];
  let units = [];
  if (state.isActive !== false) {
    if (state.unitIdList.length < SELECTABLE_CONTRACT_SLOT_COUNT) {
      changeSelectableContractPool(user, contractId);
    }
    costItems = spendSelectableContractCost(ctx, user, contractId);
    const unitIds = getSelectableContractState(user, contractId).unitIdList.slice(0, SELECTABLE_CONTRACT_SLOT_COUNT);
    units = unitIds
      .map((unitId) => grantUnit(user, unitId, { fromContract: true, regDate: now(ctx) }))
      .filter(Boolean);
    const contractState = getContractState(user, contractId, ctx);
    contractState.totalUseCount += units.length > 0 ? 1 : 0;
    contractState.dailyUseCount += units.length > 0 ? 1 : 0;
  }
  const finalState = closeSelectableContractState(user, contractId);
  return Buffer.concat([
    writeSignedVarInt(0),
    writeSignedVarInt(contractId),
    writeNullableObjectList(costItems.map(buildItemMiscData)),
    writeNullableObjectList(units.map(buildUnitData)),
    writeNullableObject(buildSelectableContractStateData(finalState)),
  ]);
}

function buildPieceExchangeAck(ctx, user, request) {
  const itemId = Number(request.itemId || 0);
  const count = Math.max(1, Number(request.count || 1));
  const alreadyOwned = false;
  const spendCount = getPieceRequirement(itemId, alreadyOwned) * count;
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, spendCount, { regDate: now(ctx) }) : null;
  if (costItem) trackResourceSpend(ctx, user, itemId, spendCount);
  const units = grantUnitFromPiece(user, itemId, count, { regDate: now(ctx), fromContract: false });
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(units.map(buildUnitData)),
    costItem ? writeNullableObject(buildItemMiscData(costItem)) : writeNullObject(),
  ]);
}

function buildContractStateListAck(user, ctx) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList(getAllContractStates(user, ctx).map(buildContractStateData)),
  ]);
}

function buildInstantContractListAck(user, ctx) {
  const activeCustom = getAllCustomPickupContracts(user, ctx).find((contract) => Number(contract.customPickupTargetUnitId) > 0);
  const activeRecord =
    activeCustom &&
    getActiveCustomPickupContractRecords(ctx).find((record) => Number(record.customPickupId) === Number(activeCustom.customPickupId));
  return Buffer.concat([
    writeSignedVarInt(0),
    writeNullableObjectList([]),
    writeSignedVarInt(Number(activeCustom && activeCustom.customPickupTargetUnitId) || 0),
    writeNullableObject(buildContractBonusStateData(activeRecord ? getContractBonusState(user, activeRecord) : { bonusGroupId: 0 })),
  ]);
}

function getAllContractStates(user, ctx) {
  const clockState = getActiveContractClockState(ctx);
  const contractIds = new Set(getActiveContractRecords(clockState).map((entry) => Number(entry.contractId) || 0));
  for (const contractId of getStoredContractStateIds(user)) contractIds.add(contractId);
  return Array.from(contractIds)
    .filter((contractId) => contractId > 0)
    .map((contractId) => getContractState(user, contractId, ctx));
}

function getAllContractBonusStates(user, ctx) {
  const clockState = getActiveContractClockState(ctx);
  const seen = new Set();
  const states = [];
  for (const record of [
    ...getActiveContractRecords(clockState).map((entry) => entry.record),
    ...getActiveCustomPickupContractRecords(ctx),
  ]) {
    const state = getContractBonusState(user, record);
    if (seen.has(state.bonusGroupId)) continue;
    seen.add(state.bonusGroupId);
    states.push(state);
  }
  for (const bonusGroupId of getStoredContractBonusGroupIds(user)) {
    if (seen.has(bonusGroupId)) continue;
    const state = getContractBonusState(user, bonusGroupId);
    if (seen.has(state.bonusGroupId)) continue;
    seen.add(state.bonusGroupId);
    states.push(state);
  }
  return states;
}

function getStoredContractStateIds(user) {
  const states = user && user.contractStates && typeof user.contractStates === "object" ? user.contractStates : {};
  return Object.keys(states)
    .map((key) => Number(key))
    .filter((contractId) => Number.isInteger(contractId) && contractId > 0);
}

function getStoredContractBonusGroupIds(user) {
  const states = user && user.contractBonusStates && typeof user.contractBonusStates === "object" ? user.contractBonusStates : {};
  return Object.keys(states)
    .map((key) => Number(key))
    .filter((bonusGroupId) => Number.isInteger(bonusGroupId) && bonusGroupId > 0);
}

function getActiveContractRecords(clockState) {
  const records = getVisibleContractIds()
    .map((contractId) => ({ contractId, record: resolveContractRecord(contractId) }))
    .filter((entry) => isContractRecordActiveForClock(entry.record, clockState, "contract"))
    .filter((entry) => !isRetiredContractRecord(entry.record, entry.contractId));
  const bestByKey = new Map();
  for (const entry of records) {
    const key = contractDisplayKey(entry.record, entry.contractId);
    if (!key) continue;
    const current = bestByKey.get(key);
    if (!current || scoreContractRecord(entry, clockState) > scoreContractRecord(current, clockState)) {
      bestByKey.set(key, entry);
    }
  }
  return records.filter((entry) => {
    const key = contractDisplayKey(entry.record, entry.contractId);
    return !key || bestByKey.get(key) === entry;
  });
}

function resolveContractRecord(contractId) {
  const baseRecord = getContractRecord(contractId);
  const tabRecord = getContractTabRecord(contractId);
  if (baseRecord && tabRecord) return { ...baseRecord, ...tabRecord };
  return tabRecord || baseRecord;
}

function getActiveContractClockState(ctx) {
  const empty = {
    enabled: false,
    contractIds: new Set(),
    customPickupIds: new Set(),
    openTags: new Set(),
    intervalTags: new Set(),
    intervalsByTag: new Map(),
  };
  const manager = ctx && ctx.eventManager;
  if (!manager || typeof manager.getActiveEventState !== "function") return empty;
  let state = null;
  try {
    const nowDate = ctx && typeof ctx.getServerNowDate === "function" ? ctx.getServerNowDate() : undefined;
    state = manager.getActiveEventState(nowDate);
  } catch (_) {
    state = null;
  }
  if (!state || !state.enabled) return empty;

  const result = {
    enabled: true,
    contractIds: new Set(),
    customPickupIds: new Set(),
    openTags: new Set(),
    intervalTags: new Set(),
    intervalsByTag: new Map(),
  };
  for (const interval of Array.isArray(state.intervalData) ? state.intervalData : []) {
    const tag = normalizeTag(interval && interval.strKey);
    if (!tag) continue;
    result.intervalTags.add(tag);
    result.intervalsByTag.set(tag, interval);
  }
  for (const entry of Array.isArray(state.entries) ? state.entries : []) {
    if (!isContractClockEntry(entry)) continue;
    for (const tag of normalizeTags(entry.openTags || [])) result.openTags.add(tag);
    for (const tag of normalizeTags(entry.intervalTags || [])) result.intervalTags.add(tag);

    const tableName = String(entry && entry.source && entry.source.tableName || "").toUpperCase();
    const raw = entry && entry.raw && typeof entry.raw === "object" ? entry.raw : {};
    if (tableName.includes("CONTRACT_CUSTOM_PICKUP")) {
      const id = Number(raw.customPickupId || raw.m_CustomPickupID || raw.CustomPickupID || entry.id || 0);
      if (Number.isInteger(id) && id > 0) result.customPickupIds.add(id);
    } else if (tableName.includes("CONTRACT")) {
      const id = Number(raw.m_ContractID || raw.ContractID || raw.contractId || entry.id || 0);
      if (Number.isInteger(id) && id > 0) result.contractIds.add(id);
    }
  }
  return result;
}

function isContractClockEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const tableName = String(entry.source && entry.source.tableName || "").toUpperCase();
  const raw = entry.raw && typeof entry.raw === "object" ? entry.raw : {};
  if (tableName === "OFFICIAL_EVENT_SCHEDULE") {
    const scheduleType = String(raw.scheduleType || raw.type || "").toUpperCase();
    return /CONTRACT|PICKUP|CLASSIFIED/.test(scheduleType);
  }
  if (tableName.includes("CONTRACT_CUSTOM_PICKUP")) return !isShopInheritedEventEntry(entry);
  if (tableName === "CONTRACT_TAB" || (tableName.includes("CONTRACT") && Number(raw.m_ContractID || raw.ContractID || 0) > 0)) {
    return !isShopInheritedEventEntry(entry);
  }
  return false;
}

function isShopInheritedEventEntry(entry) {
  const inherited = entry && entry.inheritedWindowSource ? entry.inheritedWindowSource : null;
  const inheritedTable = String(inherited && inherited.tableName || "").toUpperCase();
  const inheritedPath = String(inherited && inherited.relativePath || "").toUpperCase();
  return /SHOP/.test(inheritedTable) || /SHOP/.test(inheritedPath);
}

function isContractRecordActiveForClock(record, clockState, kind = "contract") {
  if (!record || !clockState || !clockState.enabled) return true;
  const contractId = Number(record.m_ContractID || record.ContractID || record.contractId || 0);
  const customPickupId = Number(record.customPickupId || record.m_CustomPickupID || record.CustomPickupID || 0);
  if (kind === "custom" && isAlwaysOnCustomPickupRecord(record)) return true;
  if (kind === "custom" && customPickupId > 0 && clockState.customPickupIds.has(customPickupId)) return true;
  if (contractId > 0 && clockState.contractIds.has(contractId)) return true;
  if (hasActiveClockTag(record, clockState)) return true;
  return !isClockGatedContractRecord(record, kind);
}

function hasActiveClockTag(record, clockState) {
  for (const tag of getRecordOpenTags(record)) {
    if (clockState.openTags.has(tag)) return true;
  }
  for (const tag of getRecordIntervalTags(record)) {
    if (clockState.intervalTags.has(tag)) return true;
  }
  return false;
}

function isClockGatedContractRecord(record, kind = "contract") {
  if (!record) return false;
  if (kind === "custom" || Number(record.customPickupId || 0) > 0) return true;
  if (record.m_bPickUp === true || record.m_bPickUp === "true") return true;
  const category = Number(record.m_ContractCategory || 0);
  if (category === CUSTOM_PICKUP_CATEGORY) return true;
  const tags = [...getRecordOpenTags(record), ...getRecordIntervalTags(record)];
  if (!tags.length) return false;
  if (tags.some(isAlwaysOnContractTag)) return false;
  return tags.some((tag) => /20\d{2}|PICKUP|AWAKEN|CLASSIFIED|CUSTOM|LIMITED|SPECIAL|EVENT|ADMIN|FIRST_UNIT|UNIT_/i.test(tag));
}

function isAlwaysOnContractTag(tag) {
  const key = String(tag || "").toUpperCase();
  return (
    key === "TAG_GLOBAL_CONTRACT_BASIC" ||
    key === "TAG_GLOBAL_CONTRACT_BASIC_V2" ||
    key === "TAG_GLOBAL_CONTRACT_BASIC_DISPATCH" ||
    key === "DATE_GLOBAL_CONTRACT_BASIC" ||
    key === "DATE_GLOBAL_CONTRACT_BASIC_V2" ||
    key === "DATE_GLOBAL_CONTRACT_BASIC_DISPATCH" ||
    key === "DATE_GLOBAL_CONTRACT_SELECTABLE" ||
    key === "TAG_GLOBAL_CONTRACT_SELECTABLE" ||
    key.includes("CONTRACT_NEWBIE")
  );
}

function isAlwaysOnCustomPickupRecord(record) {
  if (getCustomPickupType(record) === "OPERATOR") return false;
  const tags = [...getRecordOpenTags(record), ...getRecordIntervalTags(record)];
  return tags.some((tag) => tag.includes("CONTRACT_CUSTOM") && !/20\d{2}|LIMITED|EVENT/.test(tag));
}

function getContractNextResetDate(contractId, ctx) {
  const record = resolveContractRecord(contractId) || {};
  if (getContractFreeTryCount(record) > 0 || getContractDailyLimit(record) > 0) {
    return dateTimeBinaryForDate(getNextContractDailyResetDate(getContractNowDate(ctx)));
  }
  const window = getContractIntervalWindow(record, ctx);
  return window && window.endDate ? dateTimeBinaryForDate(window.endDate) : farFutureDateTimeBinary();
}

function getContractIntervalWindow(record, ctx) {
  const clockState = getActiveContractClockState(ctx);
  for (const tag of getRecordIntervalTags(record)) {
    const interval = clockState.intervalsByTag.get(tag);
    const startDate = coerceDate(interval && interval.startDate);
    const endDate = coerceDate(interval && interval.endDate);
    if (startDate || endDate) return { tag, startDate, endDate };
  }
  return null;
}

function getContractNowDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const date = coerceDate(ctx.getServerNowDate());
    if (date) return date;
  }
  if (ctx && ctx.serverTime && typeof ctx.serverTime.now === "function") {
    const date = coerceDate(ctx.serverTime.now());
    if (date) return date;
  }
  return new Date();
}

function getNextContractDailyResetDate(date) {
  const source = coerceDate(date) || new Date();
  const resetToday = new Date(
    Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth(),
      source.getUTCDate(),
      CONTRACT_DAILY_RESET_HOUR_UTC,
      0,
      0,
      0
    )
  );
  if (source.getTime() < resetToday.getTime()) return resetToday;
  return new Date(resetToday.getTime() + DAY_MS);
}

function getContractDailyResetKey(date) {
  const source = coerceDate(date) || new Date();
  return utcDateKey(new Date(source.getTime() - CONTRACT_DAILY_RESET_HOUR_UTC * 60 * 60 * 1000));
}

function getContractFreeTryCount(record) {
  return Math.max(0, Math.trunc(Number(firstDefined(record && record.m_FreeTryCnt, record && record.m_FreeTryEventCnt, 0)) || 0));
}

function getContractFreeCountDays(record) {
  return Math.max(0, Math.trunc(Number(record && record.m_freeCountDays) || 0));
}

function getContractDailyLimit(record) {
  return Math.max(0, Math.trunc(Number(record && record.m_DailyLimit) || 0));
}

function getContractTotalLimit(record) {
  return Math.max(0, Math.trunc(Number(record && record.m_TotalLimit) || 0));
}

function hasResettingFreeChance(record) {
  const value = record && record.m_resetFreeCount;
  if (value == null || value === "") return getContractFreeTryCount(record) > 0 && getContractFreeCountDays(record) <= 0;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y)$/i.test(String(value).trim());
}

function calculateAccumulatedFreeGrant(record, existing, ctx, nowDate) {
  const freeTryCount = getContractFreeTryCount(record);
  const freeCountDays = getContractFreeCountDays(record);
  if (freeTryCount <= 0) return { grantCount: 0, grantDays: 0, grantStartDate: null };

  const window = getContractIntervalWindow(record, ctx);
  const storedStartDate = coerceDate(existing && existing.freeGrantStartIso);
  const grantStartDate = window && window.startDate ? window.startDate : storedStartDate || nowDate;
  if (!grantStartDate || nowDate.getTime() < grantStartDate.getTime()) {
    return { grantCount: 0, grantDays: 0, grantStartDate };
  }

  if (freeCountDays <= 0) return { grantCount: freeTryCount, grantDays: 1, grantStartDate };

  let grantDays = 1;
  const firstResetDate = getNextContractDailyResetDate(grantStartDate);
  if (nowDate.getTime() >= firstResetDate.getTime()) {
    grantDays += Math.floor((nowDate.getTime() - firstResetDate.getTime()) / DAY_MS) + 1;
  }
  grantDays = Math.max(0, Math.min(freeCountDays, grantDays));
  return { grantCount: freeTryCount * grantDays, grantDays, grantStartDate };
}

function getContractWindowKey(record, ctx) {
  const window = getContractIntervalWindow(record, ctx);
  if (!window || !window.tag) return "";
  const start = window.startDate ? window.startDate.toISOString() : "";
  const end = window.endDate ? window.endDate.toISOString() : "";
  return `${window.tag}|${start}|${end}`;
}

function coerceDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "bigint") return dateFromDateTime(value);
  if (typeof value === "number" || typeof value === "string") {
    const dateTime = dateFromDateTime(value);
    if (dateTime) return dateTime;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function clampHour(value, fallback) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return fallback;
  return Math.max(0, Math.min(23, Math.trunc(hour)));
}

function getRecordOpenTags(record) {
  return normalizeTags([
    record && record.m_OpenTag,
    record && record.OpenTag,
    record && record.openTag,
    ...(Array.isArray(record && record.listOpenTag) ? record.listOpenTag : []),
    ...(Array.isArray(record && record.listOpenTags) ? record.listOpenTags : []),
  ]);
}

function getRecordIntervalTags(record) {
  return normalizeTags([
    record && record.m_DateStrID,
    record && record.m_DateStrId,
    record && record.DateStrID,
    record && record.m_IntervalStrID,
    record && record.m_EventDateStrID,
    record && record.EventRateDateStrID,
  ]);
}

function normalizeTags(values) {
  return (Array.isArray(values) ? values : [values])
    .flatMap((value) => (Array.isArray(value) ? value : String(value || "").split(/[,|;\s]+/)))
    .map(normalizeTag)
    .filter(Boolean);
}

function normalizeTag(value) {
  const tag = String(value || "").trim().toUpperCase();
  return tag && tag !== "NONE" && tag !== "NULL" ? tag : "";
}

function contractDisplayKey(record, contractId = 0) {
  if (!record) return "";
  const id = Number(record.m_ContractID || record.ContractID || record.contractId || contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  const category = Number(record.m_ContractCategory || baseRecord.m_ContractCategory || 0) || 0;
  const unitKey = normalizeContractIdentity(record.m_addUnitStrId || baseRecord.m_addUnitStrId || record.addUnitStrId || "");
  const nameKey = normalizeContractIdentity(record.m_ContractName || baseRecord.m_ContractName || record.m_ContractStrID || "");
  const bannerKey = normalizeContractIdentity(record.m_MainBannerFileName || baseRecord.m_MainBannerFileName || record.m_ContractBannerName || "");
  const identity = unitKey || nameKey || bannerKey;
  return identity ? `${category}:${identity}` : "";
}

function scoreContractRecord(entry, clockState) {
  const record = entry && entry.record || {};
  const contractId = Number(entry && entry.contractId || record.m_ContractID || 0) || 0;
  const tags = [...getRecordOpenTags(record), ...getRecordIntervalTags(record)];
  let score = contractId;
  if (hasActiveClockTag(record, clockState)) score += 1_000_000_000;
  for (const tag of tags) {
    const text = String(tag || "").toUpperCase();
    if (text.includes("GLOBAL")) score += 1_000_000;
    const version = text.match(/_V(\d+)\b/);
    if (version) score += Number(version[1] || 0) * 100_000;
    if (text.includes("TUTORIAL")) score -= 200_000_000;
    if (text.includes("OLD_VERSION")) score -= 1_000_000_000;
  }
  score += Math.max(0, Number(record.m_Priority || 0) || 0);
  return score;
}

function isRetiredContractRecord(record, contractId = 0) {
  const id = Number(record && (record.m_ContractID || record.ContractID || record.contractId)) || Number(contractId) || 0;
  const baseRecord = getContractRecord(id) || {};
  const text = [
    ...getRecordOpenTags(record),
    ...getRecordOpenTags(baseRecord),
    ...getRecordIntervalTags(record),
    ...getRecordIntervalTags(baseRecord),
    String(record && (record.m_ContractName || record.m_ContractStrID) || ""),
    String(baseRecord && (baseRecord.m_ContractName || baseRecord.m_ContractStrID) || ""),
  ].join("|").toUpperCase();
  return (
    text.includes("TAG_KOR_CONTRACT_OLD_VERSION") ||
    text.includes("DATE_KOR_CONTRACT_OLD_VERSION") ||
    text.includes("DATE_GLOBAL_CLASSIFIED_OLD_VERSION") ||
    text.includes("SI_NAME_CONTRACT_OLD")
  );
}

function normalizeContractIdentity(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^NKM_UNIT_/, "")
    .replace(/^SI_NAME_UNIT_/, "")
    .replace(/^SI_UNIT_NAME_/, "")
    .replace(/^SI_UNIT_TITLE_/, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getContractState(user, contractId, ctx) {
  ensureContractStateStore(user);
  const record = resolveContractRecord(contractId) || {};
  const resetDate = getContractNextResetDate(contractId, ctx);
  if (!user) {
    return normalizeContractState(
      {},
      record,
      {
        contractId: Number(contractId) || 0,
        remainFreeChance: getContractFreeTryCount(record),
        nextResetDate: String(resetDate),
        isActive: true,
        totalUseCount: 0,
        dailyUseCount: 0,
        bonusCandidate: [],
      },
      ctx
    );
  }
  const key = String(contractId);
  const existing = user.contractStates[key] || {};
  const state = normalizeContractState(
    existing,
    record,
    {
      contractId: Number(contractId) || 0,
      remainFreeChance:
        existing.remainFreeChance != null ? existing.remainFreeChance : getContractFreeTryCount(record),
      nextResetDate: String(resetDate),
      isActive: existing.isActive !== false,
      totalUseCount: Number(existing.totalUseCount || 0),
      dailyUseCount: Number(existing.dailyUseCount || 0),
      bonusCandidate: Array.isArray(existing.bonusCandidate) ? existing.bonusCandidate : [],
    },
    ctx
  );
  user.contractStates[key] = state;
  return state;
}

function normalizeContractState(existing, record, baseState, ctx) {
  const nowDate = getContractNowDate(ctx);
  const dailyResetKey = getContractDailyResetKey(nowDate);
  const freeTryCount = getContractFreeTryCount(record);
  const freeCountDays = getContractFreeCountDays(record);
  const hasFreeChance = freeTryCount > 0;
  const hasDailyReset = hasFreeChance || getContractDailyLimit(record) > 0;
  const nextDailyResetDate = getNextContractDailyResetDate(nowDate);
  const windowKey = getContractWindowKey(record, ctx);
  const previousWindowKey = String(existing && existing.contractWindowKey || "");
  const changedWindow = previousWindowKey && windowKey && previousWindowKey !== windowKey;
  const previousDailyResetKey = String(existing && existing.dailyResetKey || "");
  const changedDay = previousDailyResetKey && previousDailyResetKey !== dailyResetKey;
  const accumulated = calculateAccumulatedFreeGrant(record, existing, ctx, nowDate);
  let totalUseCount = Math.max(0, Math.trunc(Number(baseState.totalUseCount || 0) || 0));
  let dailyUseCount = Math.max(0, Math.trunc(Number(baseState.dailyUseCount || 0) || 0));
  let freeUseCount = Math.max(0, Math.trunc(Number(existing && existing.freeUseCount || 0) || 0));
  let dailyFreeUseCount = Math.max(0, Math.trunc(Number(existing && existing.dailyFreeUseCount || 0) || 0));
  let remainFreeChance = Math.max(0, Math.trunc(Number(baseState.remainFreeChance || 0) || 0));
  let nextResetDate = baseState.nextResetDate;

  if (changedWindow) {
    totalUseCount = 0;
    dailyUseCount = 0;
    freeUseCount = 0;
    dailyFreeUseCount = 0;
    remainFreeChance = freeTryCount;
  } else if (changedDay) {
    dailyUseCount = 0;
    dailyFreeUseCount = 0;
  }

  if (hasDailyReset) nextResetDate = String(dateTimeBinaryForDate(nextDailyResetDate));

  if (hasFreeChance) {
    if (hasResettingFreeChance(record)) {
      if (existing && existing.dailyFreeUseCount == null && existing.remainFreeChance != null && !changedDay) {
        dailyFreeUseCount = Math.max(0, freeTryCount - Math.max(0, Number(existing.remainFreeChance) || 0));
      }
      remainFreeChance = Math.max(0, freeTryCount - dailyFreeUseCount);
    } else {
      if (existing && existing.freeUseCount == null && existing.remainFreeChance != null && !changedWindow) {
        freeUseCount = Math.max(0, accumulated.grantCount - Math.max(0, Number(existing.remainFreeChance) || 0));
      }
      remainFreeChance = Math.max(0, accumulated.grantCount - freeUseCount);
      if (freeCountDays > 0 && accumulated.grantDays >= freeCountDays) {
        const intervalWindow = getContractIntervalWindow(record, ctx);
        nextResetDate =
          intervalWindow && intervalWindow.endDate
            ? String(dateTimeBinaryForDate(intervalWindow.endDate))
            : String(farFutureDateTimeBinary());
      }
    }
  }

  const totalLimit = getContractTotalLimit(record);
  if (totalLimit > 0) totalUseCount = Math.min(totalUseCount, totalLimit);

  return {
    contractId: Number(baseState.contractId || 0) || 0,
    remainFreeChance,
    nextResetDate: String(nextResetDate || farFutureDateTimeBinary()),
    isActive: baseState.isActive !== false,
    totalUseCount,
    dailyUseCount,
    bonusCandidate: Array.isArray(baseState.bonusCandidate) ? baseState.bonusCandidate : [],
    freeUseCount,
    dailyFreeUseCount,
    dailyResetKey,
    freeGrantStartIso: accumulated.grantStartDate ? accumulated.grantStartDate.toISOString() : existing && existing.freeGrantStartIso,
    contractWindowKey: windowKey || previousWindowKey,
  };
}

function getContractBonusState(user, contractId) {
  ensureContractStateStore(user);
  const bonusGroupId = getBonusGroupId(contractId);
  if (!user) return { bonusGroupId, useCount: 0, resetCount: 0 };
  const key = String(bonusGroupId);
  const legacyKey = String(Number(contractId && (contractId.m_ContractID || contractId.customPickupId)) || Number(contractId) || bonusGroupId);
  const existing = user.contractBonusStates[key] || user.contractBonusStates[legacyKey] || {};
  const state = {
    bonusGroupId,
    useCount: Number(existing.useCount || 0),
    resetCount: Number(existing.resetCount || 0),
  };
  user.contractBonusStates[key] = state;
  return state;
}

function applyContractRewards(ctx, user, contractId, count, reward, options = {}) {
  const state = getContractState(user, contractId, ctx);
  const requestCount = Math.max(1, Number(count) || 1);
  state.totalUseCount += requestCount;
  state.dailyUseCount += requestCount;
  if (Number(options.costType) === CONTRACT_COST_TYPE.FREE_CHANCE) {
    state.freeUseCount = Math.max(0, Number(state.freeUseCount || 0) || 0) + requestCount;
    state.dailyFreeUseCount = Math.max(0, Number(state.dailyFreeUseCount || 0) || 0) + requestCount;
    state.remainFreeChance = Math.max(0, state.remainFreeChance - requestCount);
  }
  if (!options.skipResultRewards && reward && Array.isArray(reward.miscItems)) {
    applyRecordResultRewards(ctx, user, getContractRecord(contractId) || {}, count, reward);
  }
  getContractState(user, contractId, ctx);
}

function applyRecordResultRewards(ctx, user, record, count, reward) {
  for (let index = 1; index <= 4; index += 1) {
    const type = record[`m_ContractResultRewardType_${index}`];
    const id = record[`m_ContractResultRewardID_${index}`];
    if (!type || !id) continue;
    mergeReward(
      reward,
      grantRewardByType(ctx, user, type, id, Number(record[`m_ContractResultRewardValue_${index}`] || 1) * count, null, 0, {
        expandPackages: false,
        regDate: now(ctx),
      })
    );
  }
}

function rollContract(ctx, user, contractId, count, options = {}) {
  const reward = createEmptyReward();
  const record = getContractRecord(contractId) || {};
  if (String(record.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR") {
    const operators = rollPoolOperators(user, contractId, count, { ...options, regDate: now(ctx), sourceRecord: record });
    reward.operators.push(...operators);
    return reward;
  }
  const unitIds = rollPoolUnits(user, contractId, count, { ...options, regDate: now(ctx), sourceRecord: record });
  for (const unit of unitIds) reward.units.push(unit);
  return reward;
}

function rollPoolUnits(user, poolId, count, options = {}) {
  const record = options.sourceRecord || getContractRecord(poolId) || getMiscContractRecord(poolId) || {};
  let entries = getContractPoolUnitEntries(poolId);
  if (!entries.length) entries = getContractPoolUnitEntries(resolveContractId(poolId));
  if (!entries.length) entries = [buildSyntheticPoolEntry(1001)];
  const units = [];
  const bonus = createBonusTracker(user, record, entries, { ...options, includeOperators: false });
  for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
    const entry = advanceBonusAndPickEntry(bonus) || pickContractEntry(entries, record, { ...options, includeOperators: false });
    const unit = grantUnit(user, entry && entry.unitId, options);
    noteBonusRollResult(bonus, entry);
    if (unit) units.push(unit);
  }
  return units;
}

function rollPoolOperators(user, poolId, count, options = {}) {
  const record = options.sourceRecord || getContractRecord(poolId) || getMiscContractRecord(poolId) || {};
  let entries = getContractPoolUnitEntries(poolId, { includeOperators: true });
  if (!entries.length) entries = [buildSyntheticPoolEntry(30101)];
  const operators = [];
  const bonus = createBonusTracker(user, record, entries, { ...options, includeOperators: true });
  for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
    const entry = advanceBonusAndPickEntry(bonus) || pickContractEntry(entries, record, { ...options, includeOperators: true });
    const operator = grantOperator(user, entry && entry.unitId, options);
    noteBonusRollResult(bonus, entry);
    if (operator) operators.push(operator);
  }
  return operators;
}

function pickContractEntry(entries, record, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry && Number(entry.unitId) > 0) : [];
  if (!list.length) return buildSyntheticPoolEntry(options.includeOperators ? 30101 : 1001);

  const gradeRoll = rollGradeCategory(record && record.m_RandomGradeID);
  const gradeCandidates = filterEntriesByGrade(list, gradeRoll.grade);
  if (gradeRoll.pickup) {
    const pickupCandidates = filterEntriesByGrade(getPickupEntries(record, list, options), gradeRoll.grade);
    if (pickupCandidates.length) return pickWeighted(pickupCandidates, (entry) => entry.ratio);
    if (gradeCandidates.length) return pickWeighted(gradeCandidates, (entry) => entry.ratio);
  }
  return pickWeighted(gradeCandidates.length ? gradeCandidates : list, (entry) => entry.ratio);
}

function rollGradeCategory(randomGradeId) {
  const table = getRandomGradeTable(randomGradeId);
  if (!table) return { grade: "", pickup: false };
  const entries = [
    ["SSR", "Rate_SSR", false],
    ["SSR", "Rate_Pick_SSR", true],
    ["SR", "Rate_SR", false],
    ["SR", "Rate_Pick_SR", true],
    ["R", "Rate_R", false],
    ["R", "Rate_Pick_R", true],
    ["N", "Rate_N", false],
    ["N", "Rate_Pick_N", true],
  ]
    .map(([grade, key, pickup]) => ({ grade, pickup, weight: Math.max(0, Number(table[key] || 0)) }))
    .filter((entry) => entry.weight > 0);
  if (!entries.length) return { grade: "", pickup: false };
  return pickWeighted(entries, (entry) => entry.weight);
}

function getPickupEntries(record, poolEntries, options = {}) {
  const entries = [];
  const customTarget = buildCustomPickupTargetEntry(record, poolEntries, options);
  if (customTarget) entries.push(customTarget);
  const additional = buildAdditionalPickupEntry(record, options);
  if (additional && !isAdminPlaceholderUnit(additional.unitId)) entries.push(additional);
  if (!entries.length && record && (Number(record.customPickupId) > 0 || (additional && isAdminPlaceholderUnit(additional.unitId)))) {
    entries.push(...poolEntries.filter((entry) => entry.pickupTarget === true));
  }
  return entries;
}

function buildCustomPickupTargetEntry(record, poolEntries, options = {}) {
  if (!record || Number(record.customPickupId) <= 0) return null;
  const targetUnitId = Number(options.customPickupTargetUnitId || 0);
  if (!Number.isInteger(targetUnitId) || targetUnitId <= 0) return null;
  return (
    (Array.isArray(poolEntries) ? poolEntries : []).find((entry) => Number(entry && entry.unitId) === targetUnitId) ||
    buildSyntheticPoolEntry(targetUnitId)
  );
}

function buildAdditionalPickupEntry(record, options = {}) {
  if (!record || !record.m_addUnitStrId) return null;
  const unitId = resolveUnitId(record.m_addUnitStrId);
  if (!Number.isInteger(unitId) || unitId <= 0) return null;
  const templet = getUnitTemplet(unitId) || {};
  const isOperator = String(templet.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR";
  if (options.includeOperators === true ? !isOperator : isOperator) return null;
  return {
    unitId,
    ratio: Math.max(1, Number(record.m_addUnitRatio || 1)),
    grade: normalizeGrade(templet.m_NKM_UNIT_GRADE),
    pickupTarget: true,
    record,
  };
}

function filterEntriesByGrade(entries, grade) {
  if (!grade) return entries.slice();
  return entries.filter((entry) => entry.grade === grade);
}

function pickWeighted(entries, weightFn) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return null;
  const weights = list.map((entry) => Math.floor(Math.max(0, Number(weightFn(entry) || 0))));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return list[randomInt(list.length)];
  let roll = randomInt(total);
  for (let index = 0; index < list.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return list[index];
  }
  return list[list.length - 1];
}

function createBonusTracker(user, record, entries, options = {}) {
  const threshold = getBonusThreshold(record);
  const bonusGroupId = getBonusGroupId(record);
  if (!threshold || !bonusGroupId) return null;
  const targets = getBonusTargetEntries(record, entries, options);
  if (!targets.length) return null;
  return {
    state: getContractBonusState(user, record),
    threshold,
    targets,
    targetIds: new Set(targets.map((entry) => Number(entry.unitId)).filter((unitId) => unitId > 0)),
  };
}

function advanceBonusAndPickEntry(tracker) {
  if (!tracker || !tracker.state) return null;
  tracker.state.useCount += 1;
  if (tracker.state.useCount < tracker.threshold) return null;
  return pickWeighted(tracker.targets, (entry) => entry.ratio);
}

function noteBonusRollResult(tracker, entry) {
  if (!tracker || !tracker.state || !entry) return;
  if (!tracker.targetIds.has(Number(entry.unitId))) return;
  tracker.state.useCount = 0;
  tracker.state.resetCount += 1;
}

function getBonusTargetEntries(record, poolEntries, options = {}) {
  const customTargetId = Number(options.customPickupTargetUnitId || 0);
  if (customTargetId > 0) {
    const existing = poolEntries.find((entry) => Number(entry.unitId) === customTargetId);
    return [existing || buildSyntheticPoolEntry(customTargetId)];
  }

  const additional = buildAdditionalPickupEntry(record, options);
  if (additional && !isAdminPlaceholderUnit(additional.unitId)) return [additional];

  const pickupTargets = getPickupEntries(record, poolEntries, options).filter((entry) => entry && Number(entry.unitId) > 0);
  if (pickupTargets.length) return pickupTargets;
  return additional ? [additional] : [];
}

function getBonusGroupId(contractIdOrRecord) {
  const record = normalizeContractLikeRecord(contractIdOrRecord);
  const groupId = Number(
    (record && (record.m_ContractBonusCountGroupID || record.ContractBonusCountGroupID)) ||
      (record && (record.m_ContractID || record.customPickupId)) ||
      Number(contractIdOrRecord) ||
      0
  );
  return Number.isInteger(groupId) && groupId > 0 ? groupId : 0;
}

function getBonusThreshold(record) {
  const threshold = Number(record && record.m_ContractBounsItemReqireCount);
  return Number.isInteger(threshold) && threshold > 0 ? threshold : 0;
}

function normalizeContractLikeRecord(contractIdOrRecord) {
  if (contractIdOrRecord && typeof contractIdOrRecord === "object") return contractIdOrRecord;
  const id = Number(contractIdOrRecord);
  if (!Number.isInteger(id) || id <= 0) return {};
  return (
    getContractRecord(id) ||
    getCustomPickupContractRecords().find((record) => Number(record.customPickupId) === id) ||
    {}
  );
}

function isAdminPlaceholderUnit(unitId) {
  const templet = getUnitTemplet(unitId) || {};
  return Number(unitId) === 1000 || String(templet.m_UnitStrID || "") === "NKM_NPC_ADMINISTRATOR";
}

function buildSyntheticPoolEntry(unitId) {
  const templet = getUnitTemplet(unitId) || {};
  return {
    unitId: Number(unitId) || 0,
    ratio: 1,
    grade: normalizeGrade(templet.m_NKM_UNIT_GRADE),
    pickupTarget: false,
    record: {},
  };
}

function normalizeGrade(value) {
  const text = String(value || "").toUpperCase();
  if (text.includes("SSR")) return "SSR";
  if (text.includes("SR")) return "SR";
  if (text.includes("R")) return "R";
  if (text.includes("N")) return "N";
  return "";
}

function spendContractCost(ctx, user, contractId, count, costType) {
  return spendCostFromRecord(ctx, user, getContractRecord(contractId) || {}, count, costType);
}

function spendCostFromRecord(ctx, user, record, count, costType) {
  const slot = getCostSlot(costType);
  if (slot <= 0) return [];

  const requestCount = Math.max(1, Math.trunc(Number(count) || 1));
  const cost = getTryCost(record, slot, requestCount);
  if (!cost) return [];

  const updated = spendMiscItem(user, cost.itemId, cost.amount, { regDate: now(ctx) });
  if (!updated) return [];
  trackResourceSpend(ctx, user, cost.itemId, cost.amount);
  return [updated];
}

function getCostSlot(costType) {
  const value = Number(costType);
  if (value === CONTRACT_COST_TYPE.FREE_CHANCE) return 0;
  if (value === CONTRACT_COST_TYPE.TICKET) return 1;
  if (value === CONTRACT_COST_TYPE.MONEY) return 2;
  return 0;
}

function getTryCost(record, slot, count) {
  const singleItemId = Number(record[`m_SingleTryRequireItemID_${slot}`] || 0);
  const singleValue = toBigInt(record[`m_SingleTryRequireItemValue_${slot}`] || 0, 0n);
  if (Number.isInteger(singleItemId) && singleItemId > 0 && singleValue > 0n) {
    return { itemId: singleItemId, amount: singleValue * BigInt(count) };
  }

  const multiItemId = Number(record[`m_MultiTryRequireItemID_${slot}`] || 0);
  const multiValue = toBigInt(record[`m_MultiTryRequireItemValue_${slot}`] || 0, 0n);
  if (count >= 10 && Number.isInteger(multiItemId) && multiItemId > 0 && multiValue > 0n) {
    return { itemId: multiItemId, amount: multiValue };
  }

  return null;
}

function buildMiscContractResultData(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.miscItemId || 0) || 0),
    writeNullableObjectList((result.units || []).map(buildUnitData)),
  ]);
}

function buildCustomPickupContractData(customPickupId, targetUnitId) {
  const state =
    customPickupId && typeof customPickupId === "object"
      ? customPickupId
      : {
          customPickupId,
          totalUseCount: 0,
          customPickupTargetUnitId: targetUnitId,
          currentSelectCount: 0,
        };
  return Buffer.concat([
    writeSignedVarInt(Number(state.customPickupId || 0) || 0),
    writeSignedVarInt(Number(state.totalUseCount || 0) || 0),
    writeSignedVarInt(Number(state.customPickupTargetUnitId || 0) || 0),
    writeSignedVarInt(Number(state.currentSelectCount || 0) || 0),
  ]);
}

function getAllCustomPickupContracts(user, ctx) {
  return getActiveCustomPickupContractRecords(ctx)
    .map((record) => getCustomPickupContractState(user, Number(record.customPickupId)));
}

function getCustomPickupContractState(user, customPickupId) {
  ensureContractStateStore(user);
  const record = getCustomPickupContractRecords().find((entry) => Number(entry.customPickupId) === Number(customPickupId)) || {};
  const includeOperators = String(record.m_ContractType || "") === "OPERATOR";
  const defaultTarget = normalizeCustomPickupTarget(record, 0, { includeOperators });
  if (!user) {
    return {
      customPickupId: Number(customPickupId) || 0,
      totalUseCount: 0,
      customPickupTargetUnitId: defaultTarget,
      currentSelectCount: 0,
    };
  }
  const key = String(Number(customPickupId) || 0);
  const existing = user.customPickupContracts[key] || findCustomPickupStateByType(user, record) || {};
  const maxSelectCount = getCustomPickupMaxSelectCount(record);
  const currentSelectCount = Math.max(0, Number(existing.currentSelectCount || 0));
  const state = {
    customPickupId: Number(customPickupId) || 0,
    totalUseCount: Number(existing.totalUseCount || 0),
    customPickupTargetUnitId: normalizeCustomPickupTarget(record, existing.customPickupTargetUnitId || defaultTarget, {
      includeOperators,
    }),
    currentSelectCount: maxSelectCount > 0 ? Math.min(currentSelectCount, maxSelectCount) : currentSelectCount,
  };
  user.customPickupContracts[key] = state;
  return state;
}

function getActiveCustomPickupContractRecords(ctx) {
  const clockState = getActiveContractClockState(ctx);
  const selectedByType = new Map();
  for (const record of getCustomPickupContractRecords()) {
    if (!isMainCustomPickupRecord(record)) continue;
    if (!isContractRecordActiveForClock(record, clockState, "custom")) continue;
    const type = getCustomPickupType(record);
    const current = selectedByType.get(type);
    if (!current || scoreCustomPickupRecord(record) > scoreCustomPickupRecord(current)) {
      selectedByType.set(type, record);
    }
  }
  return Object.keys(CUSTOM_PICKUP_TYPE_ORDER)
    .map((type) => selectedByType.get(type))
    .filter(Boolean);
}

function isMainCustomPickupRecord(record) {
  if (!record || Number(record.customPickupId) <= 0) return false;
  const type = getCustomPickupType(record);
  if (!(type in CUSTOM_PICKUP_TYPE_ORDER)) return false;
  if (Number(record.m_ContractCategory || 0) !== CUSTOM_PICKUP_CATEGORY) return false;
  const openTag = String(record.m_OpenTag || "").toUpperCase();
  if (!openTag.includes("CONTRACT_CUSTOM")) return false;
  return !["DUMMY", "RETURN", "STARTER", "COMEBACK"].some((token) => openTag.includes(token));
}

function scoreCustomPickupRecord(record) {
  const maxSelectCount = getCustomPickupMaxSelectCount(record);
  const openTag = String(record && record.m_OpenTag || "").toUpperCase();
  return (
    (maxSelectCount >= 999 ? 100000 : 0) +
    (openTag.endsWith("_V2") ? 10000 : 0) +
    Math.max(0, Number(record && record.customPickupId) || 0)
  );
}

function getCustomPickupType(record) {
  return String(record && record.m_ContractType || "").toUpperCase();
}

function getCustomPickupMaxSelectCount(record) {
  return Math.max(0, Number(record && (record.maxSelectTargetCount || record.m_MaxSelectTargetCount || record.m_maxSelectTargetCount)) || 0);
}

function findCustomPickupStateByType(user, record) {
  if (!user || !record || !user.customPickupContracts) return null;
  const type = getCustomPickupType(record);
  const fallbackRecord = getCustomPickupContractRecords()
    .filter((entry) => Number(entry && entry.customPickupId) > 0 && getCustomPickupType(entry) === type)
    .sort((a, b) => scoreCustomPickupRecord(b) - scoreCustomPickupRecord(a))
    .find((entry) => user.customPickupContracts[String(Number(entry.customPickupId) || 0)]);
  return fallbackRecord ? user.customPickupContracts[String(Number(fallbackRecord.customPickupId) || 0)] : null;
}

function normalizeCustomPickupTarget(record, targetUnitId, options = {}) {
  const entries = getContractPoolUnitEntries(record && record.m_UnitPoolID, options).filter((entry) => entry.pickupTarget);
  const requested = Number(targetUnitId || 0);
  if (requested > 0 && entries.some((entry) => Number(entry.unitId) === requested)) return requested;
  if (requested > 0 && isValidCustomPickupFallbackTarget(record, requested, options)) return requested;
  return Number(entries[0] && entries[0].unitId) || 0;
}

function isValidCustomPickupFallbackTarget(record, unitId, options = {}) {
  if (!record || Number(record.customPickupId) <= 0) return false;
  if (options.includeOperators === true) return false;
  if (getCustomPickupType(record) !== "AWAKEN") return false;

  const unit = getUnitTemplet(unitId);
  if (!unit || unit.m_bMonster === true || unit.m_bAwaken !== true || unit.m_bContractable !== true) return false;
  const type = String(unit.m_NKM_UNIT_TYPE || "");
  const style = String(unit.m_NKM_UNIT_STYLE_TYPE || "");
  return type !== "NUT_SYSTEM" && type !== "NUT_SHIP" && type !== "NUT_OPERATOR" && style !== "NUST_TRAINER";
}

function getSelectableContractState(user, requestedContractId = 0) {
  const contractId = resolveSelectableContractId(requestedContractId);
  const config = getSelectableContractConfig(contractId);
  if (!user) {
    return createSelectableState(config.contractId, [], 0, config.isActive);
  }

  ensureContractStateStore(user);
  const existing = user.selectableContractState && typeof user.selectableContractState === "object" ? user.selectableContractState : {};
  const existingContractId = Number(existing.contractId || 0);
  if (existingContractId > 0 && existingContractId !== config.contractId && requestedContractId) {
    const state = createSelectableState(config.contractId, [], 0, config.isActive);
    user.selectableContractState = state;
    return state;
  }

  const state = createSelectableState(
    existingContractId || config.contractId,
    existing.unitIdList,
    existing.unitPoolChangeCount,
    existing.isActive !== false && config.isActive
  );
  user.selectableContractState = state;
  return state;
}

function changeSelectableContractPool(user, requestedContractId = 0) {
  const contractId = resolveSelectableContractId(requestedContractId);
  const config = getSelectableContractConfig(contractId);
  const state = getSelectableContractState(user, contractId);
  if (state.isActive === false) return state;

  const atLimit = config.maxChangeCount > 0 && state.unitPoolChangeCount >= config.maxChangeCount;
  if (atLimit && state.unitIdList.length === SELECTABLE_CONTRACT_SLOT_COUNT) return state;

  state.contractId = config.contractId;
  state.unitIdList = rollSelectableUnitIdList(config);
  state.unitPoolChangeCount = config.maxChangeCount > 0
    ? Math.min(config.maxChangeCount, state.unitPoolChangeCount + 1)
    : state.unitPoolChangeCount + 1;
  state.isActive = true;
  if (user) user.selectableContractState = state;
  return state;
}

function closeSelectableContractState(user, requestedContractId = 0) {
  const state = getSelectableContractState(user, requestedContractId);
  state.isActive = false;
  if (user) user.selectableContractState = state;
  return state;
}

function createSelectableState(contractId, unitIdList, unitPoolChangeCount, isActive) {
  return {
    contractId: Number(contractId) || 0,
    unitIdList: normalizeSelectableUnitIdList(unitIdList),
    unitPoolChangeCount: Math.max(0, Math.trunc(Number(unitPoolChangeCount || 0) || 0)),
    isActive: isActive !== false && Number(contractId) > 0,
  };
}

function rollSelectableUnitIdList(config) {
  const slotGroups = getSelectableContractPoolSlotEntries(config.poolId);
  const bySlot = new Map(slotGroups.map((group) => [Number(group.slotNumber), group.entries || []]));
  const fallbackEntries = slotGroups.flatMap((group) => group.entries || []);
  if (!fallbackEntries.length) {
    fallbackEntries.push(...getContractPoolUnitIds(config.poolId).map(buildSyntheticPoolEntry));
  }
  if (!fallbackEntries.length) fallbackEntries.push(buildSyntheticPoolEntry(1001));

  const unitIds = [];
  for (let slot = 1; slot <= SELECTABLE_CONTRACT_SLOT_COUNT; slot += 1) {
    const entries = bySlot.get(slot);
    const entry = pickWeighted(entries && entries.length ? entries : fallbackEntries, (candidate) => candidate.ratio);
    unitIds.push(Number(entry && entry.unitId) || 1001);
  }
  return unitIds;
}

function normalizeSelectableUnitIdList(unitIdList) {
  return (Array.isArray(unitIdList) ? unitIdList : [])
    .map((unitId) => Number(unitId))
    .filter((unitId) => Number.isInteger(unitId) && unitId > 0)
    .slice(0, SELECTABLE_CONTRACT_SLOT_COUNT);
}

function getSelectableContractConfig(requestedContractId = 0) {
  const contractId = resolveSelectableContractId(requestedContractId);
  const record = getSelectableContractRecord(contractId) || {};
  const poolId = record.m_SelectableUnitPoolId || record.m_UnitPoolID || contractId;
  return {
    contractId,
    poolId,
    maxChangeCount: Math.max(0, Math.trunc(Number(record.m_UnitPoolChangeCount || 0) || 0)),
    requireItemId: Number(record.m_RequireItemID || 0) || 0,
    requireItemCount: toBigInt(record.m_RequireItemValue || 0, 0n),
    isActive: contractId > 0,
  };
}

function spendSelectableContractCost(ctx, user, requestedContractId = 0) {
  const config = getSelectableContractConfig(requestedContractId);
  if (!config.requireItemId || config.requireItemCount <= 0n) return [];
  const updated = spendMiscItem(user, config.requireItemId, config.requireItemCount, { regDate: now(ctx) });
  if (!updated) return [];
  trackResourceSpend(ctx, user, config.requireItemId, config.requireItemCount);
  return [updated];
}

function resolveSelectableContractId(contractId) {
  const id = Number(contractId);
  if (Number.isInteger(id) && id > 0 && getSelectableContractRecord(id)) return id;
  const first = getSelectableContractRecords()
    .map((record) => Number(record && record.m_ContractID))
    .find((candidate) => Number.isInteger(candidate) && candidate > 0);
  if (first) return first;
  return resolveContractId(contractId);
}

function resolveContractId(contractId) {
  const id = Number(contractId);
  if (Number.isInteger(id) && id > 0 && (getContractRecord(id) || getContractTabRecord(id))) return id;
  return getVisibleContractIds()[0] || 4000;
}

function resolveMiscContractId(itemIdOrContractId) {
  const id = Number(itemIdOrContractId);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const misc = getMiscItemTemplet(id);
  if (misc && String(misc.m_ItemMiscType || "") === "IMT_CONTRACT") return Number(misc.m_typeValue || 0) || id;
  return id;
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  let offset = 0;
  try {
    const nextInt = () => {
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    };
    switch (packetId) {
      case PACKETS.CONTRACT_REQ:
        return { contractId: nextInt(), count: nextInt(), costType: nextInt() };
      case PACKETS.CUSTOM_PICKUP_REQ:
        return { customPickupId: nextInt(), count: nextInt(), costType: nextInt() };
      case PACKETS.CUSTOM_PICUP_SELECT_TARGET_REQ:
        return { customPickupId: nextInt(), targetUnitId: nextInt() };
      case PACKETS.SELECTABLE_CONTRACT_CHANGE_POOL_REQ:
      case PACKETS.SELECTABLE_CONTRACT_CONFIRM_REQ:
        return { contractId: nextInt() };
      case PACKETS.MISC_CONTRACT_OPEN_REQ:
        return { miscItemId: nextInt(), count: nextInt() };
      case PACKETS.EXCHANGE_PIECE_TO_UNIT_REQ:
        return { itemId: nextInt(), count: nextInt() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[contract] request decode failed packetId=${packetId}: ${err.message}`);
    return {};
  }
}

function ensureContractStateStore(user) {
  if (!user || typeof user !== "object") return;
  user.contractStates = user.contractStates && typeof user.contractStates === "object" ? user.contractStates : {};
  user.contractBonusStates =
    user.contractBonusStates && typeof user.contractBonusStates === "object" ? user.contractBonusStates : {};
  user.contractCursors = user.contractCursors && typeof user.contractCursors === "object" ? user.contractCursors : {};
  user.selectableContractState =
    user.selectableContractState && typeof user.selectableContractState === "object" ? user.selectableContractState : {};
  user.customPickupContracts =
    user.customPickupContracts && typeof user.customPickupContracts === "object" ? user.customPickupContracts : {};
}

function getSessionUser(ctx) {
  return ctx && ctx.socket && ctx.socket.session ? ctx.socket.session.user : null;
}

function persistUserDb(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function now(ctx) {
  return ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : farFutureDateTimeBinary();
}

function formatRequest(request) {
  const fields = [];
  for (const key of ["contractId", "customPickupId", "targetUnitId", "miscItemId", "itemId", "count", "costType"]) {
    if (request && request[key] != null) fields.push(`${key}=${request[key]}`);
  }
  return fields.join(" ");
}

module.exports = {
  PACKETS,
  createContractHandler,
  getAllContractStates,
  getAllContractBonusStates,
  getContractState,
  getContractBonusState,
  getSelectableContractState,
  buildContractStateData,
  buildContractBonusStateData,
  buildCustomPickupContractData,
  getAllCustomPickupContracts,
  openMiscContract,
};
