"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers, isShipBuildUnlocked } = require("../modules/unit-growth");
const { getShipBuildCosts } = require("../modules/game-data");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");
const { ensureArmy, getArmyShips, grantUnit } = require("../modules/unit");
const { getMiscItem, grantMiscItem } = require("../modules/inventory");
const { readBool, readSignedVarInt, readSignedVarLong, writeSignedVarInt } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.SHIP_BUILD_REQ);
assert(handler, "ship-build handler must be registered");

const COFFIN_ID = 21001;
const DISABLED_COFFIN_ID = 22001;
const PLAYER_LEVEL_ID = 21004;
const DUNGEON_ID = 21019;
const SHIP_GET_ID = 21020;
const SHIP_LEVEL_ID = 21036;
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
    assert.strictEqual(reason, "ship-build");
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
  sendResponse(_target, _sequence, _packetId, build) { build(); },
};

failure("truncated", createUser, Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure("trailing", () => makeBuildFixture(COFFIN_ID), () => Buffer.concat([request(COFFIN_ID), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false, ["SHIP_A_COFFIN"]);
failure("imported ship capacity blocks until expansion", makeFullFixture, () => request(COFFIN_ID), ERROR_CODES.SHIP_FULL, false, ["SHIP_A_COFFIN"]);
failure("unknown ship", createUser, () => request(999999999), ERROR_CODES.SHIP_INVALID_SHIP_ID);
failure("closed content tag", () => makeBuildFixture(COFFIN_ID), () => request(COFFIN_ID), ERROR_CODES.SHIP_INVALID_SHIP_ID);
failure("disabled build record", () => makeBuildFixture(DISABLED_COFFIN_ID), () => request(DISABLED_COFFIN_ID), ERROR_CODES.SHIP_NOT_UNLOCKED, true, ["SHIP_A_COFFIN"]);
failure("player level locked", () => makeBuildFixture(PLAYER_LEVEL_ID, { level: 14 }), () => request(PLAYER_LEVEL_ID), ERROR_CODES.SHIP_NOT_UNLOCKED, true, ["SHIP_C_ARONDIGHT"]);
failure("dungeon locked", () => makeBuildFixture(DUNGEON_ID), () => request(DUNGEON_ID), ERROR_CODES.SHIP_NOT_UNLOCKED, true, ["SHIP_A_GLEIPNIR"]);
failure("prior ship not collected", () => makeBuildFixture(SHIP_GET_ID), () => request(SHIP_GET_ID), ERROR_CODES.SHIP_NOT_UNLOCKED, true, ["SHIP_H_GLEIPNIR_ARMOR"]);
failure("prerequisite ship below level 100", () => makeBuildFixture(SHIP_LEVEL_ID, { prerequisiteLevel: 99 }), () => request(SHIP_LEVEL_ID), ERROR_CODES.SHIP_NOT_UNLOCKED, true, ["SHIP_X_COFFIN_SIX"]);
failure("insufficient item precedes unlock", () => makeBuildFixture(DUNGEON_ID, { underfund: true }), () => request(DUNGEON_ID), ERROR_CODES.INSUFFICIENT_ITEM, true, ["SHIP_A_GLEIPNIR"]);
assertNoCommits();
validateCanonicalShadowPalaceUnlock();

const coffin = makeBuildFixture(COFFIN_ID, {
  balances: { 1: [50000, 60000], 1009: [300, 0], 1201: [10, 0], 1206: [30, 0] },
});
success(coffin, COFFIN_ID, "SHIP_A_COFFIN", [
  { itemId: 1, countFree: 0, countPaid: 10000 },
  { itemId: 1009, countFree: 0, countPaid: 0 },
  { itemId: 1201, countFree: 0, countPaid: 0 },
  { itemId: 1206, countFree: 0, countPaid: 0 },
]);

const dungeon = makeBuildFixture(DUNGEON_ID, { dungeonClear: 1004441 });
success(dungeon, DUNGEON_ID, "SHIP_A_GLEIPNIR", expectedFundedBalances(DUNGEON_ID));

const collected = makeBuildFixture(SHIP_GET_ID, { collectedShipId: DUNGEON_ID });
success(collected, SHIP_GET_ID, "SHIP_H_GLEIPNIR_ARMOR", expectedFundedBalances(SHIP_GET_ID));

const leveled = makeBuildFixture(SHIP_LEVEL_ID, { prerequisiteLevel: 100 });
success(leveled, SHIP_LEVEL_ID, "SHIP_X_COFFIN_SIX", expectedFundedBalances(SHIP_LEVEL_ID));

assert.strictEqual(saves, 4, "only successful ship builds may save");
assert.strictEqual(invalidations, 4, "only successful ship builds may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  expectedMissionEvents([COFFIN_ID, DUNGEON_ID, SHIP_GET_ID, SHIP_LEVEL_ID])
);

for (const [user, shipId] of [[coffin, COFFIN_ID], [dungeon, DUNGEON_ID], [collected, SHIP_GET_ID], [leveled, SHIP_LEVEL_ID]]) {
  const restarted = JSON.parse(JSON.stringify(user));
  assert(getArmyShips(restarted).some((ship) => Number(ship.unitId) === shipId), `ship ${shipId} must survive restart`);
}

validateManagedSchemas();
console.log(`[ship-build-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(985000000000000n + fixtureId), nickname: "ShipBuildCheck", level: 100 };
  ensureArmy(user);
  return user;
}

function makeBuildFixture(shipId, options = {}) {
  const user = createUser();
  user.level = options.level == null ? 100 : options.level;
  const costs = getShipBuildCosts(shipId) || [];
  const balances = options.balances || Object.fromEntries(costs.map((cost) => [cost.itemId, [cost.count + 1, 0]]));
  if (options.underfund && costs.length) balances[costs[0].itemId] = [Math.max(0, costs[0].count - 1), 0];
  for (const [itemId, counts] of Object.entries(balances)) grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  if (options.dungeonClear) user.dungeonClear = { [String(options.dungeonClear)]: { dungeonId: options.dungeonClear } };
  if (options.collectedShipId) user.collection = { ships: [options.collectedShipId] };
  if (options.prerequisiteLevel) grantUnit(user, 26001, { level: options.prerequisiteLevel, fromContract: false });
  ensureArmy(user);
  return user;
}

function makeFullFixture() {
  const user = createUser();
  for (let index = 0; index < 60; index += 1) grantUnit(user, 26001, { level: 1, fromContract: false });
  ensureArmy(user);
  assert.strictEqual(getArmyShips(user).length, 60);
  return user;
}

function validateCanonicalShadowPalaceUnlock() {
  const palaces = readGameplayTableRecords("ab_script", "LUA_SHADOW_PALACE_TEMPLET.json", { rootDir, logLabel: "ship-build-check" });
  const battles = readGameplayTableRecords("ab_script", "LUA_SHADOW_BATTLE_TEMPLET.json", { rootDir, logLabel: "ship-build-check" });
  const palace = palaces.find((entry) => Number(entry && entry.PALACE_ID) > 0);
  assert(palace, "frozen Shadow Palace table must expose an unlock target");
  const dungeonIds = battles
    .filter((entry) => Number(entry && entry.BATTLE_GROUP) === Number(palace.BATTLE_GROUP_ID))
    .map((entry) => Number(entry.DUNGEON_ID));
  assert(dungeonIds.length > 0, "Shadow Palace unlock target must have required battles");
  const user = createUser();
  user.miscStages = { shadow: { palaces: {
    [String(palace.PALACE_ID)]: {
      palaceId: Number(palace.PALACE_ID),
      dungeonDataList: dungeonIds.map((dungeonId) => ({ dungeonId, bestTime: 1, recentTime: 1 })),
    },
  } } };
  const requirement = { m_ShipBuildUnlockType: "BUT_SHADOW_CLEAR", m_ShipBuildUnlockValue: Number(palace.PALACE_ID) };
  assert.strictEqual(isShipBuildUnlocked(user, requirement), true, "canonical imported miscStages.shadow clears must unlock ships");
  user.miscStages.shadow.palaces[String(palace.PALACE_ID)].dungeonDataList.pop();
  assert.strictEqual(isShipBuildUnlocked(user, requirement), false, "every frozen palace battle must be cleared");
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true, tags = []) {
  const user = makeUser();
  socket.session.user = user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function success(user, shipId, tag, expectedItems) {
  socket.session.user = user;
  runtimeOpenTags = [tag];
  send(request(shipId));
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.ship.unitId, shipId);
  assert.strictEqual(ack.ship.level, 1);
  assert.deepStrictEqual(ack.costItems, expectedItems);
  assertBalances(user, expectedItems);
  assert(getArmyShips(user).some((ship) => String(ship.unitUid) === ack.ship.unitUid.toString() && Number(ship.unitId) === shipId));
}

function request(shipId) {
  return writeSignedVarInt(shipId);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.SHIP_BUILD_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.SHIP_BUILD_REQ, sequence: 1, payload }), true);
}

function assertFailure(expectedError) {
  assert(response, "ship-build handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_BUILD_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const shipPresent = readBool(response.payload, error.offset);
  assert.strictEqual(shipPresent.value, false);
  const items = readMiscItemList(response.payload, shipPresent.offset);
  assert.deepStrictEqual(items.values, []);
  assert.strictEqual(items.offset, response.payload.length, "failed ship-build ACK must contain no trailing fields");
}

function readAck() {
  assert(response, "ship-build handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.SHIP_BUILD_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, true);
  const ship = readUnitData(response.payload, present.offset);
  const items = readMiscItemList(response.payload, ship.offset);
  assert.strictEqual(items.offset, response.payload.length, "successful ship-build ACK must contain no trailing fields");
  return { errorCode: error.value, ship, costItems: items.values };
}

function readUnitData(payload, startOffset) {
  const unitUid = readSignedVarLong(payload, startOffset);
  let offset = readSignedVarLong(payload, unitUid.offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  const level = readSignedVarInt(payload, unitId.offset);
  offset = readSignedVarInt(payload, level.offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 4;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipFloatList(payload, offset);
  offset = skipIntList(payload, offset);
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
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  return { unitUid: unitUid.value, unitId: unitId.value, level: level.value, offset };
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
    const bonusRatio = readSignedVarInt(payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    values.push({ itemId: itemId.value, countFree: Number(countFree.value), countPaid: Number(countPaid.value) });
  }
  return { values, offset };
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

function skipIntList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return offset;
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

function expectedFundedBalances(shipId) {
  return getShipBuildCosts(shipId).map((cost) => ({ itemId: cost.itemId, countFree: 1, countPaid: 0 }));
}

function expectedMissionEvents(shipIds) {
  return shipIds.flatMap((shipId) => [
    ["SHIP_MAKE", 1, undefined],
    ...getShipBuildCosts(shipId).map((cost) => ["USE_RESOURCE", cost.count, cost.itemId]),
  ]);
}

function assertBalances(user, expectedItems) {
  for (const expected of expectedItems) {
    const item = getMiscItem(user, expected.itemId);
    assert.strictEqual(item.countFree, String(expected.countFree));
    assert.strictEqual(item.countPaid, String(expected.countPaid));
  }
}

function assertNoCommits() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.deepStrictEqual(missionEvents, []);
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
      assert(result.ok, `managed client schema rejected ship-build packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
