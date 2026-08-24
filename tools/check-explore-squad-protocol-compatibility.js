"use strict";

const assert = require("assert");
const path = require("path");
const {
  ERRORS,
  PACKETS,
  STATE,
  createExploreHandlers,
  enterExplore,
  getTables,
} = require("../modules/explore");
const {
  readSignedVarInt,
  writeBool,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const tables = getTables();
assert.strictEqual(tables.enhanceGroups.size, 20);
assert.strictEqual([...tables.enhanceGroups.values()].reduce((sum, rows) => sum + rows.length, 0), 80);
assert.deepStrictEqual(tables.templetsById.get(3).shipUpgradeGroups, [100000, 100001]);
assert.deepStrictEqual(tables.rewardGroups.get(100000).rows.map((row) => row.rewardId), [26008, 26019]);
assert.deepStrictEqual(
  tables.rewardGroups.get(100001).rows.map((row) => row.rewardId),
  [26006, 26020, 26021, 26024, 26025, 26027, 26014, 26036, 26044, 26041, 26026, 26039, 26040, 26045, 26046, 26047]
);

const handlers = new Map(createExploreHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [
  PACKETS.UNIT_CHANGE_REQ,
  PACKETS.OPERATOR_CHANGE_REQ,
  PACKETS.SHIP_UPGRADE_REQ,
  PACKETS.ENHANCE_REQ,
  PACKETS.ENHANCE_RESET_REQ,
]) assert(handlers.has(packetId), `missing Explore squad handler ${packetId}`);

let response = null;
let saves = 0;
let invalidations = 0;
let sequence = 1;
const managedWire = [];
const socket = { session: { user: null } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  randomInt: () => 0,
  eventManager: {
    getActiveEventState() {
      return { entries: [{ raw: { m_Option: "ExploreTempletID = 3;" } }] };
    },
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(reason.startsWith("explore-"));
    invalidations += 1;
  },
  saveUserDb() { saves += 1; },
};

const unitReward = firstReward("RT_UNIT");
const unitUser = makeEnteredUser();
const targetUid = Object.keys(unitUser.explore.squad.units)[0];
const oldUnit = unitUser.explore.squad.units[targetUid];
oldUnit.level = 107;
oldUnit.exp = 55;
oldUnit.limitBreakLevel = 3;
oldUnit.reactorLevel = 2;
oldUnit.tacticLevel = 4;
oldUnit.loyalty = 7777;
setPending(unitUser, STATE.SET_UNIT, unitReward);
failure("truncated unit change", PACKETS.UNIT_CHANGE_REQ, unitUser, Buffer.alloc(0), ERRORS.INVALID_REQUEST);
failure(
  "foreign unit reward",
  PACKETS.UNIT_CHANGE_REQ,
  unitUser,
  unitChangeRequest({ id: unitReward.id + 1, value: unitReward.value }, targetUid, false),
  ERRORS.REWARD_VALUE_NOT_MATCHED,
  true
);
failure(
  "missing unit target",
  PACKETS.UNIT_CHANGE_REQ,
  unitUser,
  unitChangeRequest(unitReward, "999999999999", false),
  ERRORS.UNIT_UPDATE,
  true
);
failure(
  "skip with target",
  PACKETS.UNIT_CHANGE_REQ,
  unitUser,
  unitChangeRequest(unitReward, targetUid, true),
  ERRORS.INVALID_SELECTION_ITEM,
  true
);
invoke(PACKETS.UNIT_CHANGE_REQ, unitUser, unitChangeRequest(unitReward, targetUid, false), true);
assertAck(PACKETS.UNIT_CHANGE_ACK, ERRORS.OK);
const replacedUnit = unitUser.explore.squad.units[targetUid];
assert.deepStrictEqual(
  [replacedUnit.unitUid, replacedUnit.unitId, replacedUnit.level, replacedUnit.exp, replacedUnit.limitBreakLevel,
    replacedUnit.reactorLevel, replacedUnit.tacticLevel, replacedUnit.loyalty],
  [targetUid, unitReward.id, 107, 55, 3, 2, 4, 7777]
);
assert.deepStrictEqual(replacedUnit.skillLevels, [5, 5, 5, 5, 5]);
assert.strictEqual(unitUser.explore.state, STATE.EXPLORING);
assert.deepStrictEqual(unitUser.explore.rewardValue, { id: 0, value: 0 });
assert.strictEqual(JSON.stringify(JSON.parse(JSON.stringify(unitUser)).explore), JSON.stringify(unitUser.explore));

const unitSkipUser = makeEnteredUser();
setPending(unitSkipUser, STATE.SET_UNIT, unitReward);
const unitSkipBefore = JSON.stringify(unitSkipUser.explore.squad);
invoke(PACKETS.UNIT_CHANGE_REQ, unitSkipUser, unitChangeRequest(unitReward, 0, true), true);
assertAck(PACKETS.UNIT_CHANGE_ACK, ERRORS.OK);
assert.strictEqual(JSON.stringify(unitSkipUser.explore.squad), unitSkipBefore);

const operatorReward = firstReward("RT_OPERATOR");
const operatorUser = makeEnteredUser();
operatorUser.explore.squad.operator = {
  id: 31301,
  uid: "8700000000000999",
  level: 91,
  exp: 14,
  locked: false,
  mainSkill: { id: 6001, level: 8, exp: 0 },
  subSkill: { id: 1002, level: 8, exp: 0 },
  fromContract: false,
};
setPending(operatorUser, STATE.SET_OPERATOR, operatorReward);
failure(
  "foreign operator reward",
  PACKETS.OPERATOR_CHANGE_REQ,
  operatorUser,
  operatorChangeRequest({ id: operatorReward.id, value: operatorReward.value + 1 }, false),
  ERRORS.REWARD_VALUE_NOT_MATCHED,
  true
);
invoke(PACKETS.OPERATOR_CHANGE_REQ, operatorUser, operatorChangeRequest(operatorReward, false), true);
assertAck(PACKETS.OPERATOR_CHANGE_ACK, ERRORS.OK);
assert.deepStrictEqual(
  [operatorUser.explore.squad.operator.id, operatorUser.explore.squad.operator.uid,
    operatorUser.explore.squad.operator.level, operatorUser.explore.squad.operator.exp,
    operatorUser.explore.squad.operator.subSkill.id],
  [operatorReward.id, "8700000000000999", 91, 14, operatorReward.value]
);

const operatorSkipUser = makeEnteredUser();
operatorSkipUser.explore.squad.operator = JSON.parse(JSON.stringify(operatorUser.explore.squad.operator));
setPending(operatorSkipUser, STATE.SET_OPERATOR, operatorReward);
const operatorSkipBefore = JSON.stringify(operatorSkipUser.explore.squad.operator);
invoke(PACKETS.OPERATOR_CHANGE_REQ, operatorSkipUser, operatorChangeRequest(operatorReward, true), true);
assertAck(PACKETS.OPERATOR_CHANGE_ACK, ERRORS.OK);
assert.strictEqual(JSON.stringify(operatorSkipUser.explore.squad.operator), operatorSkipBefore);

const shipUser = makeEnteredUser();
shipUser.explore.currentHp = 63;
shipUser.explore.maxHp = 100;
setPending(shipUser, STATE.UPGRADE_SHIP, { id: 0, value: 1 });
failure(
  "wrong ship grade",
  PACKETS.SHIP_UPGRADE_REQ,
  shipUser,
  shipUpgradeRequest(26006, false),
  ERRORS.INVALID_SELECTION_ITEM,
  true
);
failure(
  "ship skip with choice",
  PACKETS.SHIP_UPGRADE_REQ,
  shipUser,
  shipUpgradeRequest(26008, true),
  ERRORS.INVALID_SELECTION_ITEM,
  true
);
const shipUid = shipUser.explore.squad.ship.unitUid;
invoke(PACKETS.SHIP_UPGRADE_REQ, shipUser, shipUpgradeRequest(26008, false), true);
assertAck(PACKETS.SHIP_UPGRADE_ACK, ERRORS.OK);
assert.deepStrictEqual(
  [shipUser.explore.squad.ship.unitUid, shipUser.explore.squad.ship.unitId, shipUser.explore.currentHp, shipUser.explore.maxHp],
  [shipUid, 26008, 63, 100]
);
setPending(shipUser, STATE.UPGRADE_SHIP, { id: 0, value: 1 });
invoke(PACKETS.SHIP_UPGRADE_REQ, shipUser, shipUpgradeRequest(26006, false), true);
assertAck(PACKETS.SHIP_UPGRADE_ACK, ERRORS.OK);
setPending(shipUser, STATE.UPGRADE_SHIP, { id: 0, value: 1 });
failure(
  "maximum ship grade",
  PACKETS.SHIP_UPGRADE_REQ,
  shipUser,
  shipUpgradeRequest(26020, false),
  ERRORS.SHIP_INVALID_GRADE,
  true
);

const shipSkipUser = makeEnteredUser();
setPending(shipSkipUser, STATE.UPGRADE_SHIP, { id: 0, value: 1 });
const shipSkipBefore = JSON.stringify(shipSkipUser.explore.squad.ship);
invoke(PACKETS.SHIP_UPGRADE_REQ, shipSkipUser, shipUpgradeRequest(0, true), true);
assertAck(PACKETS.SHIP_UPGRADE_ACK, ERRORS.OK);
assert.strictEqual(JSON.stringify(shipSkipUser.explore.squad.ship), shipSkipBefore);

const enhanceUser = makeEnteredUser();
enhanceUser.explore.state = STATE.CLEAR;
enhanceUser.explore.enhancePoint = 100;
failure("trailing enhance", PACKETS.ENHANCE_REQ, enhanceUser, Buffer.concat([intRequest(101), Buffer.from([0])]), ERRORS.INVALID_REQUEST);
failure("unknown enhance group", PACKETS.ENHANCE_REQ, enhanceUser, intRequest(999), ERRORS.INVALID_ENHANCE_GROUP_ID, true);
for (const expected of [
  { level: 1, templet: 1, point: 90 },
  { level: 2, templet: 2, point: 70 },
  { level: 3, templet: 3, point: 40 },
  { level: 4, templet: 4, point: 0 },
]) {
  invoke(PACKETS.ENHANCE_REQ, enhanceUser, intRequest(101), true);
  assertAck(PACKETS.ENHANCE_ACK, ERRORS.OK);
  assertEnhanceAck(101, expected.level, expected.templet, expected.point);
}
failure("maximum enhance", PACKETS.ENHANCE_REQ, enhanceUser, intRequest(101), ERRORS.ENHANCE_MAX_LEVEL, true);
failure("insufficient enhance points", PACKETS.ENHANCE_REQ, enhanceUser, intRequest(102), ERRORS.ENHANCE_NOT_ENOUGH_POINT, true);
invoke(PACKETS.ENHANCE_RESET_REQ, enhanceUser, Buffer.alloc(0), true);
assertAck(PACKETS.ENHANCE_RESET_ACK, ERRORS.OK);
assert.deepStrictEqual(enhanceUser.explore.enhance, {});
assert.strictEqual(enhanceUser.explore.enhancePoint, 100);
const noOpSaves = saves;
invoke(PACKETS.ENHANCE_RESET_REQ, enhanceUser, Buffer.alloc(0), true);
assertAck(PACKETS.ENHANCE_RESET_ACK, ERRORS.OK);
assert.strictEqual(saves, noOpSaves, "empty enhancement reset must not save");

const blockedEnhanceUser = makeEnteredUser();
blockedEnhanceUser.explore.enhancePoint = 100;
failure("enhance during run", PACKETS.ENHANCE_REQ, blockedEnhanceUser, intRequest(101), ERRORS.IN_PROGRESS, true);
failure("reset during run", PACKETS.ENHANCE_RESET_REQ, blockedEnhanceUser, Buffer.alloc(0), ERRORS.IN_PROGRESS, true);

assert.strictEqual(invalidations, saves, "each successful Explore squad mutation must invalidate JOIN exactly once");
validateManagedSchemas();
console.log(
  `[explore-squad-protocol-check] PASS enhancementRows=80 shipChoices=18 saves=${saves} packets=${managedWire.length} managed=on`
);

function makeEnteredUser() {
  const user = { userUid: "1000000001", nickname: "ExploreSquadCheck" };
  assert.strictEqual(enterExplore(ctx, user, { valid: true, templetId: 3 }, false).errorCode, ERRORS.OK);
  return user;
}

function firstReward(type) {
  const group = [...tables.rewardGroups.values()].find((candidate) => candidate.rewardType === type);
  assert(group && group.rows.length, `missing ${type} reward rows`);
  const row = group.rows[0];
  return { id: row.rewardId, value: row.randomOperatorSkills[0] || 0 };
}

function setPending(user, state, rewardValue) {
  user.explore.state = state;
  user.explore.rewardValue = { ...rewardValue };
  user.explore.selectionList = [];
}

function selectable(item) {
  return writeNullableObject(Buffer.concat([writeSignedVarInt(item.id), writeSignedVarInt(item.value)]));
}

function unitChangeRequest(item, targetUid, skip) {
  return Buffer.concat([selectable(item), writeSignedVarLong(BigInt(targetUid)), writeBool(skip)]);
}

function operatorChangeRequest(item, skip) {
  return Buffer.concat([selectable(item), writeBool(skip)]);
}

function shipUpgradeRequest(shipId, skip) {
  return Buffer.concat([writeSignedVarInt(shipId), writeBool(skip)]);
}

function intRequest(value) {
  return writeSignedVarInt(value);
}

function invoke(packetId, user, payload, validateRequest = false) {
  socket.session.user = user;
  response = null;
  if (validateRequest) managedWire.push([packetId, payload]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: sequence++, payload }), true);
  assert(response, `packet ${packetId} must respond`);
  return response;
}

function failure(label, packetId, user, payload, expectedError, validateRequest = false) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(packetId, user, payload, validateRequest);
  assertAck(PACKETS[`${handlers.get(packetId).name.replace("_REQ", "_ACK")}`] || packetId + 1, expectedError);
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate user state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(response.packetId, packetId);
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, errorCode);
}

function assertEnhanceAck(group, level, templet, point) {
  let read = readSignedVarInt(response.payload, 0);
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    read = readSignedVarInt(response.payload, read.offset);
    values.push(read.value);
  }
  assert.deepStrictEqual(values, [group, level, templet, point]);
  assert.strictEqual(read.offset, response.payload.length);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Explore squad schema validation");
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
      assert(result.ok, `managed client schema rejected Explore packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
