"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const {
  getActiveRecallTemplet,
  getFirstLevelShipId,
  getLimitBreakInfo,
  getMiscItemTemplet,
  getRecallExchangeUnitIds,
  getRecallRewardUnitPieceToPoint,
  getShipBuildCosts,
  getShipBuildTemplet,
  getShipLevelUpCosts,
  getShipLimitBreakCosts,
  getShipLimitBreakTemplet,
  getShipUpgradeCosts,
  getTotalExpForUnitLevel,
  getUnitLimitBreakSubstituteRecord,
  getUnitRearmamentCosts,
  getUnitSkillUpgradeCosts,
  getUnitTemplet,
  loadGameData,
} = require("../modules/game-data");
const { getMiscItem } = require("../modules/inventory");
const { ensureArmy, ensureDeck, grantUnit } = require("../modules/unit");
const { readSignedVarInt, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.RECALL_UNIT_REQ);
assert(handler, "unit-recall handler must be registered");
assert.strictEqual(Array.from(loadGameData().recallTempletsByUnitId.values()).flat().length, 48, "all frozen recall rows must load");

const latestNow = new Date("2026-04-10T12:00:00.000Z");
const waveNow = new Date("2024-11-01T12:00:00.000Z");
const latestRecall = getActiveRecallTemplet(1283, latestNow);
const tacticRecall = getActiveRecallTemplet(1098, waveNow);
const rearmRecall = getActiveRecallTemplet(2098, waveNow);
const shipRecall = getActiveRecallTemplet(21047, waveNow);
assert(latestRecall && tacticRecall && rearmRecall && shipRecall, "normal, tactic, rearm, and ship recall windows must resolve");
const latestTargets = getRecallExchangeUnitIds(latestRecall.UnitExchangeGroupID);
const tacticTarget = getRecallExchangeUnitIds(tacticRecall.UnitExchangeGroupID)[0];
const rearmTarget = getRecallExchangeUnitIds(rearmRecall.UnitExchangeGroupID)[0];
const shipBaseTarget = getRecallExchangeUnitIds(shipRecall.UnitExchangeGroupID)[0];
assert(latestTargets.length >= 2 && tacticTarget && rearmTarget && shipBaseTarget);

const socket = { session: { user: null } };
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
let sequence = 1;
let currentNow = latestNow;
let runtimeOpenTags = [];
let stateAfterNormal = null;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getServerNowDate: () => new Date(currentNow.getTime()),
  dateTimeBinaryNow: () => dateTimeBinaryForDate(currentNow),
  getEffectiveOpenTags(tags) { return [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags]; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-recall");
    invalidations += 1;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

failure("truncated", () => makeFixture(), Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure("trailing", () => makeFixture(), (state) => Buffer.concat([request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("missing uid", () => ({ user: createUser() }), request(999999999, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.UNIT_NOT_EXIST);
failure("non-recall unit", () => makeFixture({ unitId: 1001 }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.RECALL_NOT_AVAILABLE);
failure("expired window", () => makeFixture({ now: new Date("2026-05-01T12:00:00Z") }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.RECALL_PERIOD_EXPIRED);
failure("acquired during window", () => makeFixture({ regDate: new Date("2026-04-05T12:00:00Z") }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.RECALL_INVALID_ACQUIRE_TIME);
failure("already recalled", () => makeFixture({ mutate(_source, user) { user.recallHistory = { 1283: { unitId: 1283, lastUpdateDate: String(dateTimeBinaryForDate(latestNow)) } }; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.RECALL_ALREADY_USED);
failure("locked", () => makeFixture({ mutate(source) { source.locked = true; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.UNIT_LOCKED);
failure("decked", () => makeFixture({ mutate(source, user) { ensureDeck(user, { deckType: 1, index: 0 }).unitUids[0] = source.unitUid; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.UNIT_IN_DECK);
failure("equipped", () => makeFixture({ mutate(source) { source.equipItemUids[0] = "9900000000000001"; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.RECALL_UNIT_UNEQUIP_ITEM);
failure("seized", () => makeFixture({ mutate(source) { source.isSeized = true; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.UNIT_IS_SEIZED);
failure("lobby", () => makeFixture({ mutate(source, user) { user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: source.unitUid }] } }; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.UNIT_IS_LOBBY_UNIT);
failure("world map", () => makeFixture({ mutate(source, user) { user.worldMap = { cities: { 1: { leaderUnitUID: source.unitUid } } }; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.UNIT_IS_WORLDMAP_LEADER);
failure("office", () => makeFixture({ mutate(source) { source.officeRoomId = 1; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.OFFICE_UNIT_DELETE_IN_ROOM);
failure("support", () => makeFixture({ mutate(source, user) { user.support = { mySupportUnitUid: source.unitUid }; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }]), ERROR_CODES.CONTAIN_SUPPORT_UNIT);
failure("empty exchange", () => makeFixture(), (state) => request(state.source.unitUid, []), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);
failure("duplicate exchange key", () => makeFixture({ mutate(source) { source.tacticLevel = 1; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 1 }, { unitId: latestTargets[0], count: 1 }]), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA, false);
failure("invalid exchange id", () => makeFixture(), (state) => request(state.source.unitUid, [{ unitId: 1001, count: 1 }]), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);
failure("zero exchange count", () => makeFixture(), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 0 }]), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);
failure("under tactic count", () => makeFixture({ mutate(source) { source.tacticLevel = 2; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 2 }]), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);
failure("over tactic count", () => makeFixture({ mutate(source) { source.tacticLevel = 2; } }), (state) => request(state.source.unitUid, [{ unitId: latestTargets[0], count: 4 }]), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);
failure("tactic condition count", () => makeFixture({ unitId: 1098, now: waveNow, mutate(source) { source.tacticLevel = 3; } }), (state) => request(state.source.unitUid, [{ unitId: tacticTarget, count: 4 }]), ERROR_CODES.RECALL_INVALID_EXCHANGE_DATA);

normalSuccess();
tacticSuccess();
rearmSuccess();
shipSuccess();
restartHistoryFailure();
validateManagedSchemas();

console.log(`[unit-recall-protocol-check] PASS saves=${saves} packets=${managedWire.length} recallRows=48 managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "off"}`);

function normalSuccess() {
  const state = makeFixture({
    mutate(source) {
      source.level = 10;
      source.exp = 123;
      source.limitBreakLevel = 2;
      source.skillLevels = [3, 2, 1, 1, 1];
      source.isPermanentContract = true;
      source.tacticLevel = 2;
    },
  });
  const expected = expectedNormalRewards(state.source, getUnitTemplet(state.source.unitId));
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(state, request(state.source.unitUid, [
    { unitId: latestTargets[0], count: 2 },
    { unitId: latestTargets[1], count: 1 },
  ]));
  assert.strictEqual(errorCode(), ERROR_CODES.OK);
  assert.strictEqual(saves, beforeSaves + 1);
  assert.strictEqual(invalidations, beforeInvalidations + 1);
  assert(!ensureArmy(state.user).units[state.source.unitUid], "source unit must be removed");
  const replacements = Object.values(ensureArmy(state.user).units);
  assert.strictEqual(replacements.length, 3);
  assert.deepStrictEqual(replacements.map((unit) => unit.unitId).sort((a, b) => a - b), [latestTargets[0], latestTargets[0], latestTargets[1]].sort((a, b) => a - b));
  assert(replacements.every((unit) => unit.level === 1 && unit.limitBreakLevel === 0 && unit.fromContract === true));
  assert.strictEqual(state.user.recallHistory[1283].unitId, 1283);
  assertInventoryEquals(state.user, expected);
  stateAfterNormal = JSON.parse(JSON.stringify(state.user));
}

function tacticSuccess() {
  const state = makeFixture({ unitId: 1098, now: waveNow, mutate(source) { source.tacticLevel = 3; } });
  runtimeOpenTags = [getUnitTemplet(1098).m_BasicOpenTag];
  invoke(state, request(state.source.unitUid, [{ unitId: tacticTarget, count: 1 }]));
  assert.strictEqual(errorCode(), ERROR_CODES.OK);
  assert.strictEqual(BigInt(getMiscItem(state.user, 401).countFree), 6000n, "TACTIC_UPDATE recall must refund 2000 points per tactic level");
  assert.strictEqual(Object.values(ensureArmy(state.user).units).length, 1);
}

function rearmSuccess() {
  const state = makeFixture({ unitId: 2098, now: waveNow, mutate(source) { source.tacticLevel = 2; } });
  runtimeOpenTags = [getUnitTemplet(2098).m_BasicOpenTag];
  invoke(state, request(state.source.unitUid, [{ unitId: rearmTarget, count: 1 }]));
  assert.strictEqual(errorCode(), ERROR_CODES.OK);
  const rearmCosts = new Map(getUnitRearmamentCosts(2098).map((cost) => [cost.itemId, BigInt(cost.count)]));
  for (const [itemId, count] of rearmCosts) assert(BigInt(getMiscItem(state.user, itemId).countFree) >= count, `rearm cost ${itemId} must be refunded`);
  assert.strictEqual(BigInt(getMiscItem(state.user, 401).countFree), 4000n);
  const negotiationCount = BigInt(Math.ceil(getTotalExpForUnitLevel(110) / 2100));
  assert.strictEqual(BigInt(getMiscItem(state.user, 1033).countFree), negotiationCount, "rearm recall must include base level-110 EXP");
}

function shipSuccess() {
  const sourceId = 26047;
  const targetId = Number(String(shipBaseTarget).split("").map((char, index) => index === 1 ? String(sourceId)[1] : char).join(""));
  const state = makeFixture({
    unitId: sourceId,
    now: waveNow,
    mutate(source) {
      source.level = 110;
      source.limitBreakLevel = 1;
      source.shipCommandModules = [{ slots: [{
        targetStyleType: [],
        targetRoleType: [],
        statType: "NST_HP",
        statValue: 91,
        isLock: false,
      }, null] }];
    },
  });
  runtimeOpenTags = [getUnitTemplet(shipBaseTarget).m_FirstOpenTag];
  const expected = expectedShipRewards(state.source);
  invoke(state, request(state.source.unitUid, [{ unitId: targetId, count: 1 }]));
  assert.strictEqual(errorCode(), ERROR_CODES.OK);
  assert(!ensureArmy(state.user).ships[state.source.unitUid]);
  const replacement = Object.values(ensureArmy(state.user).ships)[0];
  assert(replacement && replacement.unitId === targetId);
  assert.strictEqual(replacement.level, 110);
  assert.strictEqual(replacement.limitBreakLevel, 1);
  assert.strictEqual(replacement.shipCommandModules[0].slots[0].statValue, 91);
  assert.strictEqual(state.user.recallHistory[getFirstLevelShipId(sourceId)].unitId, 21047);
  assertInventoryEquals(state.user, expected);
}

function restartHistoryFailure() {
  assert(stateAfterNormal, "normal success must establish restart fixture");
  const user = JSON.parse(JSON.stringify(stateAfterNormal));
  const source = grantUnit(user, 1283, { regDate: dateTimeBinaryForDate(new Date("2020-01-01T00:00:00Z")) });
  currentNow = latestNow;
  runtimeOpenTags = [];
  ensureArmy(user);
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  invoke({ user, source }, request(source.unitUid, [{ unitId: latestTargets[0], count: 1 }]));
  assert.strictEqual(errorCode(), ERROR_CODES.RECALL_ALREADY_USED);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(JSON.stringify(user), before, "persisted recall history must reject after restart without mutation");
}

function failure(label, factory, payloadOrBuild, expectedError, validateRequest = true) {
  const state = factory();
  const payload = typeof payloadOrBuild === "function" ? payloadOrBuild(state) : payloadOrBuild;
  ensureArmy(state.user);
  const before = JSON.stringify(state.user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(state, payload, validateRequest);
  assert.strictEqual(errorCode(), expectedError, label);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate`);
  assert.strictEqual(JSON.stringify(state.user), before, `${label} must be atomic`);
}

function invoke(state, payload, validateRequest = true) {
  socket.session.user = state.user;
  response = null;
  if (validateRequest) managedWire.push([PACKETS.RECALL_UNIT_REQ, payload]);
  handler.handle(ctx, socket, { sequence: sequence++, payload });
  assert(response && response.packetId === PACKETS.RECALL_UNIT_ACK);
}

function errorCode() {
  return readSignedVarInt(response.payload, 0).value;
}

function makeFixture(options = {}) {
  currentNow = options.now || latestNow;
  runtimeOpenTags = [];
  const user = createUser();
  const source = grantUnit(user, options.unitId || 1283, {
    regDate: dateTimeBinaryForDate(options.regDate || new Date("2020-01-01T00:00:00.000Z")),
  });
  assert(source, "recall source fixture must exist");
  if (typeof options.mutate === "function") options.mutate(source, user);
  return { user, source };
}

function createUser() {
  return {
    userUid: "70001",
    nextUnitUid: "9800000000000001",
    openTags: [],
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [], molds: {}, craftSlots: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    collection: { units: [], ships: [], trophies: [], operators: [] },
  };
}

function request(unitUid, exchanges) {
  const entries = Array.isArray(exchanges) ? exchanges : [];
  return Buffer.concat([
    writeSignedVarLong(BigInt(unitUid || 0)),
    writeRawVarInt(entries.length),
    ...entries.flatMap((entry) => [writeSignedVarInt(entry.unitId), writeSignedVarInt(entry.count)]),
  ]);
}

function expectedNormalRewards(source, templet) {
  const rewards = [];
  const exp = getTotalExpForUnitLevel(source.level) + Number(source.exp || 0);
  if (exp > 0) {
    const count = Math.ceil(exp / 2100);
    rewards.push({ itemId: 1033, count }, { itemId: 1, count: count * 14000 });
  }
  for (let rank = Number(source.limitBreakLevel || 0); rank > 0; rank -= 1) {
    const info = getLimitBreakInfo(rank);
    const substitute = getUnitLimitBreakSubstituteRecord(source.unitId, rank);
    for (let index = 1; info && substitute && index <= 2; index += 1) {
      const itemId = Number(substitute[`m_ItemID_${index}`] || 0);
      const count = Number(substitute[`m_ItemCount_${index}`] || 0) * Number(info.m_iUnitRequirement || 0);
      if (itemId > 0 && count > 0) rewards.push({ itemId, count });
    }
    if (substitute && Number(substitute.m_CreditReq) > 0) rewards.push({ itemId: 1, count: Number(substitute.m_CreditReq) });
  }
  let pieces = 0;
  for (let index = 1; index <= 5; index += 1) {
    const skill = templet[`m_SkillStrID${index}`];
    for (let level = Number(source.skillLevels[index - 1] || 1); skill && level > 1; level -= 1) {
      for (const cost of getUnitSkillUpgradeCosts(skill, level) || []) {
        if (getMiscItemTemplet(cost.itemId).m_ItemMiscType === "IMT_PIECE") pieces += cost.count;
        else rewards.push(cost);
      }
    }
  }
  if (pieces > 0) rewards.push({ itemId: 401, count: Math.ceil(pieces * getRecallRewardUnitPieceToPoint()) });
  if (source.isPermanentContract) rewards.push({ itemId: 1024, count: 1 });
  return mergeRewards(rewards);
}

function expectedShipRewards(source) {
  const rewards = [];
  for (let shipId = Number(source.unitId); getShipBuildTemplet(shipId); shipId -= 1000) rewards.push(...getShipUpgradeCosts(shipId));
  rewards.push(...getShipLevelUpCosts(source, 1, source.level, { limitBreakLevel: source.limitBreakLevel }));
  for (let rank = 1; rank <= Number(source.limitBreakLevel || 0); rank += 1) {
    const record = getShipLimitBreakTemplet(source.unitId, rank);
    rewards.push(...getShipLimitBreakCosts(record));
    const materialId = record.ListMaterialShipID.map(Number).sort((a, b) => a - b)[0];
    rewards.push(...getShipBuildCosts(getFirstLevelShipId(materialId)));
  }
  return mergeRewards(rewards);
}

function mergeRewards(rewards) {
  const result = new Map();
  for (const reward of rewards) {
    const itemId = Number(reward && reward.itemId);
    const count = BigInt(Math.max(0, Math.trunc(Number(reward && reward.count) || 0)));
    if (itemId > 0 && count > 0n) result.set(itemId, (result.get(itemId) || 0n) + count);
  }
  return result;
}

function assertInventoryEquals(user, expected) {
  const misc = user.inventory && user.inventory.misc || {};
  assert.strictEqual(Object.keys(misc).length, expected.size, "recall reward item set must be exact");
  for (const [itemId, count] of expected) {
    assert.strictEqual(BigInt(getMiscItem(user, itemId).countFree), count, `recall reward ${itemId} must be exact`);
  }
}

function writeRawVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const combatHost = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected unit-recall packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
