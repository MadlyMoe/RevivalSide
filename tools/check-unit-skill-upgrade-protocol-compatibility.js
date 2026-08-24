"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
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
const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.UNIT_SKILL_UPGRADE_REQ);
assert(handler, "unit-skill-upgrade handler must be registered");

const YOO_MINA_ID = 1001;
const YOO_MINA_ATTACK_ID = 10010;
const YOO_MINA_HYPER_ID = 10014;
const FOREIGN_SKILL_ID = 10020;
const managedWire = [];
let fixtureId = 0n;
let response = null;
let saves = 0;
let invalidations = 0;
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "unit-skill-upgrade");
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
failure("trailing", makeFixture, (user) => Buffer.concat([request(user.unit.unitUid, YOO_MINA_ATTACK_ID), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("missing unit", createUser, () => request(999999999, YOO_MINA_ATTACK_ID), ERROR_CODES.UNIT_NOT_EXIST);
failure("ship UID", makeShipFixture, (user) => request(user.ship.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.UNIT_NOT_EXIST);
failure("seized unit", () => makeFixture({ mutate(unit) { unit.isSeized = true; } }), (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.UNIT_IS_SEIZED);
failure("warfare deck", () => makeFixture({ deckState: 2 }), (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.WARFARE_DOING);
failure("dive deck", () => makeFixture({ deckState: 3 }), (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.DIVE_DOING);
failure("foreign skill", makeFixture, (user) => request(user.unit.unitUid, FOREIGN_SKILL_ID), ERROR_CODES.UNIT_SKILL_NOT_EXIST);
failure("missing current skill level", () => makeFixture({ skillLevels: [6, 1, 1, 1, 1] }), (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.UNIT_SKILL_NOT_EXIST);
failure("already maximum", () => makeFixture({ skillLevels: [5, 1, 1, 1, 1], limitBreakLevel: 3 }), (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.UNIT_SKILL_ALREADY_MAX);
failure("locked skill", () => makeFixture({ limitBreakLevel: 0 }), (user) => request(user.unit.unitUid, YOO_MINA_HYPER_ID), ERROR_CODES.UNIT_SKILL_NEED_LIMIT_BREAK);
failure("next level needs limit break", () => makeFixture({ skillLevels: [2, 1, 1, 1, 1], limitBreakLevel: 0 }), (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID), ERROR_CODES.UNIT_SKILL_NEED_LIMIT_BREAK);
failure(
  "insufficient cost",
  () => makeFixture({ balances: { 3: [34, 0], 1018: [4, 0] } }),
  (user) => request(user.unit.unitUid, YOO_MINA_ATTACK_ID),
  ERROR_CODES.UNIT_SKILL_NOT_ENOUGH_ITEM
);
assertNoCommits();

const first = makeFixture({ balances: { 3: [20, 30], 1018: [4, 0] } });
socket.session.user = first;
send(request(first.unit.unitUid, YOO_MINA_ATTACK_ID));
assertSuccess(first.unit.unitUid, YOO_MINA_ATTACK_ID, 2, [
  { itemId: 3, countFree: 0, countPaid: 15 },
  { itemId: 1018, countFree: 0, countPaid: 0 },
]);
assert.strictEqual(getArmyUnitByUid(first, first.unit.unitUid).skillLevels[0], 2);
assertBalances(first, [{ itemId: 3, countFree: 0, countPaid: 15 }, { itemId: 1018, countFree: 0, countPaid: 0 }]);

const second = makeFixture({ skillLevels: [2, 1, 1, 1, 1], limitBreakLevel: 1, balances: { 3: [100, 0], 1018: [10, 0] } });
socket.session.user = second;
send(request(second.unit.unitUid, YOO_MINA_ATTACK_ID));
assertSuccess(second.unit.unitUid, YOO_MINA_ATTACK_ID, 3, [
  { itemId: 3, countFree: 30, countPaid: 0 },
  { itemId: 1018, countFree: 4, countPaid: 0 },
]);
assert.strictEqual(getArmyUnitByUid(second, second.unit.unitUid).skillLevels[0], 3);
assertBalances(second, [{ itemId: 3, countFree: 30, countPaid: 0 }, { itemId: 1018, countFree: 4, countPaid: 0 }]);

assert.strictEqual(saves, 2, "only successful skill upgrades may save");
assert.strictEqual(invalidations, 2, "only successful skill upgrades may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["UNIT_TRAINING", 1, undefined],
    ["UNIT_GROWTH_SKILL_LEVEL_3", 1, undefined],
    ["UNIT_GROWTH_SKILL_LEVEL_MAX", 1, undefined],
    ["USE_RESOURCE", 35, 3],
    ["USE_RESOURCE", 4, 1018],
    ["UNIT_TRAINING", 1, undefined],
    ["UNIT_GROWTH_SKILL_LEVEL_3", 1, undefined],
    ["UNIT_GROWTH_SKILL_LEVEL_MAX", 1, undefined],
    ["USE_RESOURCE", 70, 3],
    ["USE_RESOURCE", 6, 1018],
  ]
);

const restartedFirst = JSON.parse(JSON.stringify(first));
assert.strictEqual(getArmyUnitByUid(restartedFirst, first.unit.unitUid).skillLevels[0], 2);
assertBalances(restartedFirst, [{ itemId: 3, countFree: 0, countPaid: 15 }, { itemId: 1018, countFree: 0, countPaid: 0 }]);
const restartedSecond = JSON.parse(JSON.stringify(second));
assert.strictEqual(getArmyUnitByUid(restartedSecond, second.unit.unitUid).skillLevels[0], 3);

validateManagedSchemas();
console.log(`[unit-skill-upgrade-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(986000000000000n + fixtureId), nickname: "SkillUpgradeCheck" };
  ensureArmy(user);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  user.unit = grantUnit(user, YOO_MINA_ID, {
    level: 100,
    limitBreakLevel: options.limitBreakLevel || 0,
    skillLevels: options.skillLevels || [1, 1, 1, 1, 1],
  });
  assert(user.unit, "skill-upgrade unit fixture must exist");
  for (const [itemId, counts] of Object.entries(options.balances || { 3: [1000, 0], 1018: [100, 0], 1019: [100, 0] })) {
    grantMiscItem(user, Number(itemId), counts[0], counts[1]);
  }
  ensureArmy(user);
  user.unit = user.army.units[String(user.unit.unitUid)];
  if (options.deckState) {
    const deck = user.army.deckSets["1"][0];
    deck.unitUids[0] = user.unit.unitUid;
    deck.leaderIndex = 0;
    deck.state = options.deckState;
  }
  if (options.mutate) options.mutate(user.unit, user);
  return user;
}

function makeShipFixture() {
  const user = createUser();
  user.ship = grantUnit(user, 26001, { level: 1 });
  assert(user.ship, "ship fixture must exist");
  ensureArmy(user);
  user.ship = user.army.ships[String(user.ship.unitUid)];
  return user;
}

function failure(name, makeUser, makePayload, expectedError, validateRequest = true) {
  const user = makeUser();
  socket.session.user = user;
  const before = JSON.parse(JSON.stringify(user));
  send(typeof makePayload === "function" ? makePayload(user) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(user)), before, `${name} must not mutate user state`);
}

function request(unitUid, skillId) {
  return Buffer.concat([writeSignedVarLong(BigInt(unitUid)), writeSignedVarInt(skillId)]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.UNIT_SKILL_UPGRADE_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.UNIT_SKILL_UPGRADE_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(expectedError) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, expectedError);
  assert.deepStrictEqual(ack.costItems, []);
}

function assertSuccess(unitUid, skillId, skillLevel, expectedItems) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.unitUid.toString(), String(unitUid));
  assert.strictEqual(ack.skillId, skillId);
  assert.strictEqual(ack.skillLevel, skillLevel);
  assert.deepStrictEqual(ack.costItems, expectedItems);
}

function readAck() {
  assert(response, "unit-skill-upgrade handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.UNIT_SKILL_UPGRADE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const unitUid = readSignedVarLong(response.payload, error.offset);
  const skillId = readSignedVarInt(response.payload, unitUid.offset);
  const skillLevel = readSignedVarInt(response.payload, skillId.offset);
  const items = readMiscItemList(response.payload, skillLevel.offset);
  assert.strictEqual(items.offset, response.payload.length, "skill-upgrade ACK must contain no trailing fields");
  return { errorCode: error.value, unitUid: unitUid.value, skillId: skillId.value, skillLevel: skillLevel.value, costItems: items.values };
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
      assert(result.ok, `managed client schema rejected skill-upgrade packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
