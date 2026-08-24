"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const {
  getLimitBreakMaxLevel,
  getTotalExpForUnitLevel,
  getUnitRearmamentCosts,
  getUnitRearmamentTemplet,
} = require("../modules/game-data");
const { ensureArmy, getArmyUnitByUid, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const rawTable = require("../gameplay-jsons/StreamingAssets/ab_script/luac/LUA_REARMAMENT_TEMPLET.json");
const rearmRows = Array.isArray(rawTable)
  ? rawTable
  : rawTable.records || rawTable.data || Object.values(rawTable).find(Array.isArray) || [];
assert.strictEqual(rearmRows.length, 23, "all frozen rearmament rows must load");
assert.strictEqual(ERROR_CODES.REARMAMENT_INVALID_ID, 20953, "frozen invalid rearmament ID error");
assert.strictEqual(ERROR_CODES.REARMAMENT_CONDITION_LIMITBREAK, 20954, "frozen rearmament limit-break error");
assert.strictEqual(ERROR_CODES.REARMAMENT_CONDITION_LEVEL, 20955, "frozen rearmament level error");

const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.REARMAMENT_UNIT_REQ);
assert(handler, "unit-rearmament handler must be registered");

const socket = { session: { user: null } };
const managedWire = [];
let fixtureId = 0n;
let runtimeOpenTags = [];
let response = null;
let saves = 0;
let invalidations = 0;
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => [...(Array.isArray(tags) ? tags : []), ...runtimeOpenTags],
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-rearmament");
    invalidations += 1;
  },
  trackMissionEvent(_user, condition, amount, details) {
    missionEvents.push({ condition, amount, details });
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_socket, _sequence, _packetId, build) { build(); },
};

const primaryRow = rearmRows.find((row) => Number(row.m_RearmID) === 2006);
assert(primaryRow, "frozen Xiao Lin rearmament fixture must exist");
const primaryTags = tagsFor(primaryRow);

failure("truncated", () => createUser(), Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false, primaryTags);
failure("trailing", () => makeFixture(primaryRow), (user) => Buffer.concat([request(user.unit.unitUid, primaryRow.m_RearmID), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false, primaryTags);
failure("zero uid", () => makeFixture(primaryRow), () => request(0, primaryRow.m_RearmID), ERROR_CODES.INVALID_REQUEST, true, primaryTags);
failure("zero id", () => makeFixture(primaryRow), (user) => request(user.unit.unitUid, 0), ERROR_CODES.INVALID_REQUEST, true, primaryTags);
failure("global system closed", () => makeFixture(primaryRow), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.OPENTAG_CLOSED, true, []);
failure("unknown target", () => makeFixture(primaryRow), (user) => request(user.unit.unitUid, 999999999), ERROR_CODES.REARMAMENT_INVALID_ID, true, ["REARMAMENT_BASE"]);
failure("target release tag closed", () => makeFixture(primaryRow), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.REARMAMENT_INVALID_ID, true, ["REARMAMENT_BASE"]);
failure("missing unit", createUser, () => request(999999999, primaryRow.m_RearmID), ERROR_CODES.UNIT_NOT_EXIST, true, primaryTags);
failure("ship source", () => makeFixture(primaryRow, { sourceUnitId: 21001 }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.UNIT_NOT_EXIST, true, primaryTags);
failure("wrong source family", () => makeFixture(primaryRow, { sourceUnitId: 1001 }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.REARMAMENT_INVALID_ID, true, primaryTags);
failure("already rearmed", () => makeFixture(primaryRow, { sourceUnitId: primaryRow.m_RearmUnitID }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.REARMAMENT_INVALID_ID, true, primaryTags);
failure("seized source", () => makeFixture(primaryRow, { mutate(unit) { unit.isSeized = true; } }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.UNIT_IS_SEIZED, true, primaryTags);
failure("tier one not complete", () => makeFixture(primaryRow, { limitBreakLevel: 7 }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.REARMAMENT_CONDITION_LIMITBREAK, true, primaryTags);
failure("below level 110", () => makeFixture(primaryRow, { level: 109 }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.REARMAMENT_CONDITION_LEVEL, true, primaryTags);
failure("equipped source", () => makeFixture(primaryRow, { mutate(unit) { unit.equipItemUids = ["8000001", "0", "0", "0"]; } }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.UNIT_EQUIP_ITEM, true, primaryTags);
failure("insufficient item", () => makeFixture(primaryRow, { underfund: true }), (user) => request(user.unit.unitUid, primaryRow.m_RearmID), ERROR_CODES.INSUFFICIENT_ITEM, true, primaryTags);

assert.strictEqual(saves, 0, "failed rearmaments must not save");
assert.strictEqual(invalidations, 0, "failed rearmaments must not invalidate JOIN");
assert.deepStrictEqual(missionEvents, [], "failed rearmaments must not track missions");

for (const row of rearmRows) {
  const detailed = Number(row.m_RearmID) === 2006;
  const user = makeFixture(row, detailed ? {
    level: 112,
    exp: 123,
    limitBreakLevel: 9,
    mutate(unit) {
      unit.skinId = 777;
      unit.skillLevels = [5, 4, 3, 2, 1];
      unit.statExp = [1, 2, 3, 4, 5, 6];
      unit.loyalty = 9876;
      unit.tacticLevel = 3;
      unit.isPermanentContract = true;
      unit.locked = true;
      unit.isFavorite = true;
      unit.officeRoomId = 2;
    },
  } : {});
  const uid = String(user.unit.unitUid);
  const oldRegDate = user.unit.regDate;
  const oldTotalExp = getTotalExpForUnitLevel(user.unit.level) + Number(user.unit.exp || 0);
  const expectedCarriedExp = Math.max(0, oldTotalExp - getTotalExpForUnitLevel(110));
  const expectedCosts = getUnitRearmamentCosts(row);
  const beforeBalances = expectedCosts.map((cost) => ({ itemId: cost.itemId, count: totalItem(user, cost.itemId) }));

  socket.session.user = user;
  runtimeOpenTags = tagsFor(row);
  send(request(uid, row.m_RearmID));

  const unit = getArmyUnitByUid(user, uid);
  assert(unit, `rearmed unit ${row.m_RearmID} must remain stored under the same UID`);
  assert.strictEqual(String(unit.unitUid), uid);
  assert.strictEqual(unit.previousUnitId, Number(row.m_RearmTargetUnitID));
  assert.strictEqual(unit.unitId, Number(row.m_RearmUnitID));
  assert.strictEqual(unit.limitBreakLevel, detailed ? 9 : 8);
  assert.strictEqual(getTotalExpForUnitLevel(unit.level) + Number(unit.exp || 0), expectedCarriedExp);
  assert.deepStrictEqual(unit.skillLevels, [1, 1, 1, 1, 1]);
  assert.strictEqual(unit.skinId, 0);
  assert.strictEqual(unit.reactorLevel, 0);
  assert.strictEqual(unit.regDate, oldRegDate);
  assert(user.collection.units.includes(Number(row.m_RearmUnitID)));
  for (let index = 0; index < expectedCosts.length; index += 1) {
    assert.strictEqual(totalItem(user, expectedCosts[index].itemId), beforeBalances[index].count - expectedCosts[index].count);
  }
  assertSuccess(unit, expectedCosts.map((cost) => {
    const item = getMiscItem(user, cost.itemId);
    return { itemId: cost.itemId, countFree: Number(item.countFree), countPaid: Number(item.countPaid) };
  }));
  if (detailed) {
    assert.deepStrictEqual(unit.statExp, [1, 2, 3, 4, 5, 6]);
    assert.strictEqual(unit.loyalty, 9876);
    assert.strictEqual(unit.tacticLevel, 3);
    assert.strictEqual(unit.isPermanentContract, true);
    assert.strictEqual(unit.locked, true);
    assert.strictEqual(unit.isFavorite, true);
    assert.strictEqual(unit.officeRoomId, 2);
  }

  const restarted = JSON.parse(JSON.stringify(user));
  const restartedUnit = getArmyUnitByUid(restarted, uid);
  assert.strictEqual(restartedUnit.unitId, Number(row.m_RearmUnitID));
  assert.strictEqual(getTotalExpForUnitLevel(restartedUnit.level) + Number(restartedUnit.exp || 0), expectedCarriedExp);
}

assert.strictEqual(saves, rearmRows.length, "each successful frozen rearmament row must save exactly once");
assert.strictEqual(invalidations, rearmRows.length, "each successful frozen rearmament row must invalidate JOIN exactly once");
assert.strictEqual(missionEvents.filter((event) => event.condition === "UNIT_USE_GO_UNIT_ID").length, rearmRows.length);
assert.strictEqual(
  missionEvents.filter((event) => event.condition === "USE_RESOURCE").length,
  rearmRows.reduce((sum, row) => sum + getUnitRearmamentCosts(row).length, 0)
);

validateManagedSchemas();
console.log(`[unit-rearmament-protocol-check] PASS saves=${saves} packets=${managedWire.length} rows=${rearmRows.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  return { userUid: String(986000000000000n + fixtureId), nickname: "RearmamentCheck" };
}

function makeFixture(row, options = {}) {
  const user = createUser();
  const sourceUnitId = Number(options.sourceUnitId || row.m_RearmTargetUnitID);
  user.unit = grantUnit(user, sourceUnitId, {
    level: options.level == null ? 110 : options.level,
    exp: options.exp || 0,
    limitBreakLevel: options.limitBreakLevel == null ? 8 : options.limitBreakLevel,
    skillLevels: [5, 5, 5, 5, 5],
  });
  assert(user.unit, `source fixture ${sourceUnitId} must exist`);
  const costs = getUnitRearmamentCosts(row);
  assert(costs.length > 0, `rearmament ${row.m_RearmID} must have frozen costs`);
  for (let index = 0; index < costs.length; index += 1) {
    const cost = costs[index];
    const underfunded = options.underfund && index === 0;
    const count = underfunded ? Math.max(0, cost.count - 1) : cost.count + 7;
    const free = cost.itemId === 1 && !underfunded ? Math.floor(cost.count / 2) : count;
    grantMiscItem(user, cost.itemId, free, count - free);
  }
  ensureArmy(user);
  const uid = String(user.unit.unitUid);
  user.unit = user.army.units[uid] || user.army.ships[uid] || user.army.trophies[uid];
  if (options.mutate) options.mutate(user.unit, user);
  return user;
}

function failure(name, makeUser, makePayload, expectedError, validateRequest, tags) {
  const user = makeUser();
  ensureArmy(user);
  socket.session.user = user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate state`);
}

function tagsFor(row) {
  return ["REARMAMENT_BASE", String(row.m_OpenTag || "")].filter(Boolean);
}

function request(unitUid, rearmamentId) {
  return Buffer.concat([writeSignedVarLong(BigInt(unitUid)), writeSignedVarInt(Number(rearmamentId))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.REARMAMENT_UNIT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.REARMAMENT_UNIT_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(expectedError) {
  assert(response, "unit-rearmament handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.REARMAMENT_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const unitPresent = readBool(response.payload, error.offset);
  assert.strictEqual(unitPresent.value, false);
  const count = readRawVarInt(response.payload, unitPresent.offset);
  assert.strictEqual(count.value, 0);
  assert.strictEqual(count.offset, response.payload.length);
}

function assertSuccess(expectedUnit, expectedItems) {
  assert.strictEqual(response.packetId, PACKETS.REARMAMENT_UNIT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, ERROR_CODES.OK);
  const unitPresent = readBool(response.payload, error.offset);
  assert.strictEqual(unitPresent.value, true);
  const unit = readUnitData(response.payload, unitPresent.offset);
  assert.strictEqual(String(unit.unitUid), String(expectedUnit.unitUid));
  assert.strictEqual(unit.unitId, expectedUnit.unitId);
  assert.strictEqual(unit.level, expectedUnit.level);
  assert.strictEqual(unit.exp, expectedUnit.exp);
  assert.strictEqual(unit.limitBreakLevel, expectedUnit.limitBreakLevel);
  assert.deepStrictEqual(unit.skillLevels, expectedUnit.skillLevels);
  assert.strictEqual(unit.tacticLevel, expectedUnit.tacticLevel);
  assert.strictEqual(unit.reactorLevel, expectedUnit.reactorLevel);
  const items = readMiscItemList(response.payload, unit.offset);
  assert.deepStrictEqual(items.values, expectedItems);
  assert.strictEqual(items.offset, response.payload.length, "successful rearmament ACK must contain no trailing fields");
}

function totalItem(user, itemId) {
  const item = getMiscItem(user, itemId);
  return item ? Number(item.countFree) + Number(item.countPaid) : 0;
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = readSignedVarLong(payload, unitUid.offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  const level = readSignedVarInt(payload, unitId.offset);
  const exp = readSignedVarInt(payload, level.offset);
  offset = readSignedVarInt(payload, exp.offset).offset;
  offset += 4;
  const limitBreakLevel = readSignedVarInt(payload, offset);
  offset = limitBreakLevel.offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipFloatList(payload, offset);
  const skills = readIntList(payload, offset);
  offset = skills.offset;
  offset = skipLongList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipShipModuleList(payload, offset);
  const tacticLevel = readSignedVarInt(payload, offset);
  const reactorLevel = readSignedVarInt(payload, tacticLevel.offset);
  return {
    unitUid: unitUid.value,
    unitId: unitId.value,
    level: level.value,
    exp: exp.value,
    limitBreakLevel: limitBreakLevel.value,
    skillLevels: skills.values,
    tacticLevel: tacticLevel.value,
    reactorLevel: reactorLevel.value,
    offset: reactorLevel.offset,
  };
}

function readMiscItemList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const itemId = readSignedVarInt(payload, present.offset);
    const countFree = readSignedVarLong(payload, itemId.offset);
    const countPaid = readSignedVarLong(payload, countFree.offset);
    offset = readSignedVarInt(payload, countPaid.offset).offset + 8;
    values.push({ itemId: itemId.value, countFree: Number(countFree.value), countPaid: Number(countPaid.value) });
  }
  return { values, offset };
}

function readIntList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readSignedVarInt(payload, offset);
    values.push(value.value);
    offset = value.offset;
  }
  return { values, offset };
}

function skipIntList(payload, startOffset) {
  return readIntList(payload, startOffset).offset;
}

function skipLongList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(payload, offset).offset;
  return offset;
}

function skipFloatList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  return count.offset + count.value * 4;
}

function skipShipModuleList(payload, startOffset) {
  const modules = readRawVarInt(payload, startOffset);
  let offset = modules.offset;
  for (let moduleIndex = 0; moduleIndex < modules.value; moduleIndex += 1) {
    const modulePresent = readBool(payload, offset);
    offset = modulePresent.offset;
    if (!modulePresent.value) continue;
    const slots = readRawVarInt(payload, offset);
    offset = slots.offset;
    for (let slotIndex = 0; slotIndex < slots.value; slotIndex += 1) {
      const slotPresent = readBool(payload, offset);
      offset = slotPresent.offset;
      if (!slotPresent.value) continue;
      offset = skipIntList(payload, offset);
      offset = skipIntList(payload, offset);
      offset = readSignedVarInt(payload, offset).offset + 4;
      offset = readBool(payload, offset).offset;
    }
  }
  return offset;
}

function readRawVarInt(buffer, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (shift < 32) {
    assert(offset < buffer.length, "truncated unsigned varint");
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("unsigned varint too long");
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
      assert(result.ok, `managed client schema rejected rearmament packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
