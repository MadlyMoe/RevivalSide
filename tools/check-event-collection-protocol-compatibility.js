"use strict";

const assert = require("assert");
const path = require("path");
const {
  ERRORS,
  PACKETS,
  buildEventCollectionInfoData,
  buildEventPointPayload,
  createEventCollectionHandlers,
  getActiveCollectionIndex,
  getCollectedGoods,
  loadTables,
  sendEventPointNotification,
} = require("../modules/event-collection");
const { createEmptyReward } = require("../modules/reward");
const { getTrophyUnitIds } = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureArmy, grantUnit } = require("../modules/unit");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createEventManager } = require("../modules/event-manager");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const tables = loadTables();
assert.strictEqual(tables.indexes.length, 1, "frozen client must expose one merge-capable Event Collection index");
assert.strictEqual(tables.recipes.length, 5, "all five frozen merge recipes must load");
assert.strictEqual(tables.details.length, 50, "all 50 frozen collection trophies must load");
assert.deepStrictEqual(Array.from(tables.detailsByGradeGroup, ([groupId, rows]) => [groupId, rows.length]), [
  [100101, 5], [100102, 5], [100103, 10], [100104, 15], [100105, 15],
]);
assert.deepStrictEqual(tables.recipes.map((row) => [row.recipeGroupId, row.inputValue, row.outputGradeGroupId, row.outputValue]), [
  [100101, 10, 100102, 1],
  [100102, 10, 100103, 1],
  [100103, 8, 100104, 1],
  [100104, 5, 100105, 1],
  [100105, 3, 100105, 1],
]);
assert.deepStrictEqual(
  [ERRORS.EVENT_END, ERRORS.INVALID_INDEX_TEMPLET, ERRORS.INVALID_MERGE_TEMPLET, ERRORS.INVALID_MERGE_GROUP_ID,
    ERRORS.MERGE_RECIPE_TEMPLET, ERRORS.MERGE_INVALID_INPUT_VALUE, ERRORS.MERGE_NOT_IN_COLLECTION_TEMPLET,
    ERRORS.MERGE_INVALID_INPUT_GROUP_ID, ERRORS.DB_FAIL_DELETE_TROPHY],
  [23000, 23001, 23002, 23003, 23004, 23005, 23006, 23007, 23008]
);

const activeManager = createEventManager({
  rootDir,
  env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: "2024-03-10" },
});
const endedManager = createEventManager({
  rootDir,
  env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: "2026-08-20" },
});
assert.strictEqual(getActiveCollectionIndex({ eventManager: activeManager }).collectionMergeId, 202201);
assert.strictEqual(getActiveCollectionIndex({ eventManager: endedManager }), null);

const handler = createEventCollectionHandlers().find((entry) => entry.packetId === PACKETS.MERGE_REQ);
assert(handler, "Event Collection merge specialist must be registered");
const socket = { session: { user: null } };
const managedWire = [];
const randomRolls = [];
let active = true;
let response = null;
let saves = 0;
let invalidations = 0;
let notifications = 0;
let fixtureId = 0n;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  eventManager: {
    getActiveEventState() {
      return active
        ? { entries: [{ raw: { EventID: 1, OpenTag: tables.indexes[0].openTag, DateStrID: tables.indexes[0].intervalTag } }] }
        : { entries: [], openTags: [], intervalTags: [] };
    },
  },
  randomInt(max) {
    assert(randomRolls.length > 0, `unexpected Event Collection random roll max=${max}`);
    const value = randomRolls.shift();
    assert(value >= 0 && value < max, `queued roll ${value} must be below ${max}`);
    return value;
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  sendServerGamePacket(_socket, packetId, payload) {
    notifications += 1;
    managedWire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "event-collection-merge");
    invalidations += 1;
  },
  dateTimeBinaryNow: () => 5250083637907387904n,
};

failure("truncated", () => makeFixture(tables.recipes[0]), Buffer.alloc(0), ERRORS.MERGE_INVALID_INPUT_VALUE, false);
failure("trailing", () => makeFixture(tables.recipes[0]), (state) => Buffer.concat([request(state.recipe, state.trophies.map(uid)), Buffer.from([0])]), ERRORS.MERGE_INVALID_INPUT_VALUE, false);

active = false;
failure("ended event", () => makeFixture(tables.recipes[0]), (state) => request(state.recipe, state.trophies.map(uid)), ERRORS.EVENT_END);
active = true;

failure(
  "unknown merge",
  () => makeFixture(tables.recipes[0]),
  (state) => request({ ...state.recipe, collectionMergeId: 999999 }, state.trophies.map(uid)),
  ERRORS.INVALID_MERGE_TEMPLET
);
failure(
  "unknown recipe group",
  () => makeFixture(tables.recipes[0]),
  (state) => request({ ...state.recipe, recipeGroupId: 999999 }, state.trophies.map(uid)),
  ERRORS.MERGE_RECIPE_TEMPLET
);
failure("wrong count", () => makeFixture(tables.recipes[0]), (state) => request(state.recipe, state.trophies.slice(1).map(uid)), ERRORS.MERGE_INVALID_INPUT_VALUE);
failure(
  "duplicate uid",
  () => makeFixture(tables.recipes[0]),
  (state) => request(state.recipe, Array(state.recipe.inputValue).fill(uid(state.trophies[0]))),
  ERRORS.MERGE_INVALID_INPUT_VALUE
);
failure(
  "missing trophy",
  () => makeFixture(tables.recipes[0]),
  (state) => request(state.recipe, [...state.trophies.slice(0, -1).map(uid), 999999999999999n]),
  ERRORS.MERGE_NOT_IN_COLLECTION_TEMPLET
);

const unrelatedTrophyId = getTrophyUnitIds().find((unitId) => !tables.detailByGoodsId.has(unitId));
assert(unrelatedTrophyId, "a non-collection trainer fixture must exist");
failure(
  "trophy outside collection",
  () => makeFixture(tables.recipes[0], { replaceLastWith: unrelatedTrophyId }),
  (state) => request(state.recipe, state.trophies.map(uid)),
  ERRORS.MERGE_NOT_IN_COLLECTION_TEMPLET
);
failure(
  "wrong input group",
  () => makeFixture(tables.recipes[0], { replaceLastWith: tables.detailsByGradeGroup.get(100102)[0].goodsId }),
  (state) => request(state.recipe, state.trophies.map(uid)),
  ERRORS.MERGE_INVALID_INPUT_GROUP_ID
);
failure("locked trophy", () => makeFixture(tables.recipes[0], { mutateLast: (trophy) => { trophy.locked = true; } }), (state) => request(state.recipe, state.trophies.map(uid)), ERRORS.UNIT_LOCKED);
failure(
  "lobby trophy",
  () => makeFixture(tables.recipes[0], { mutateLast(trophy, user) { user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: trophy.unitUid }] } }; } }),
  (state) => request(state.recipe, state.trophies.map(uid)),
  ERRORS.UNIT_IS_LOBBY_UNIT
);
failure(
  "office trophy",
  () => makeFixture(tables.recipes[0], { mutateLast(trophy) { trophy.officeRoomId = 1; } }),
  (state) => request(state.recipe, state.trophies.map(uid)),
  ERRORS.OFFICE_UNIT_DELETE_IN_ROOM
);

let persistedUser = null;
for (const recipe of tables.recipes) {
  const state = makeFixture(recipe);
  const outputRows = tables.detailsByGradeGroup.get(recipe.outputGradeGroupId);
  randomRolls.push(outputRows.reduce((sum, row) => sum + row.ratio, 0) - 1);
  const expectedOutputId = outputRows[outputRows.length - 1].goodsId;
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeNotifications = notifications;
  invoke(state.user, request(recipe, state.trophies.map(uid)));
  const ack = parseAck(response.payload);
  assert.strictEqual(ack.errorCode, ERRORS.OK);
  assert.strictEqual(ack.collectionMergeId, recipe.collectionMergeId);
  assert.deepStrictEqual(ack.consumedUids, state.trophies.map((trophy) => BigInt(trophy.unitUid)));
  assert.deepStrictEqual(ack.rewardUnitIds, [expectedOutputId]);
  assert.strictEqual(saves, beforeSaves + 1, "each real merge must persist once");
  assert.strictEqual(invalidations, beforeInvalidations + 1, "each real merge must invalidate JOIN once");
  assert.strictEqual(notifications, beforeNotifications + 1, "each real merge must publish collection state once");
  const army = ensureArmy(state.user);
  for (const trophy of state.trophies) assert.strictEqual(army.trophies[trophy.unitUid], undefined, "consumed trophy must be deleted");
  const outputs = Object.values(army.trophies);
  assert.strictEqual(outputs.length, 1);
  assert.strictEqual(outputs[0].unitId, expectedOutputId);
  assert.strictEqual(outputs[0].fromContract, false);
  const collected = getCollectedGoods(state.user, tables.indexes[0]);
  assert(collected.includes(state.trophies[0].unitId), "consumed trophy discovery must remain durable");
  assert(collected.includes(expectedOutputId), "output trophy discovery must be recorded");
  assert.deepStrictEqual(randomRolls, [], "merge must consume one bounded weighted roll per output");
  persistedUser = state.user;
}

const restarted = JSON.parse(JSON.stringify(persistedUser));
assert.deepStrictEqual(getCollectedGoods(restarted, tables.indexes[0]), getCollectedGoods(persistedUser, tables.indexes[0]));
const joinInfo = parseCollectionInfo(buildEventCollectionInfoData(restarted, ctx));
assert.strictEqual(joinInfo.eventId, 1);
assert.deepStrictEqual(joinInfo.goodsIds, getCollectedGoods(restarted, tables.indexes[0]));
assert.deepStrictEqual(parseCollectionInfo(buildEventCollectionInfoData(restarted, { eventManager: endedManager })), { eventId: 0, goodsIds: [] });

const eventPointUser = makeUser();
setMiscItemBalance(eventPointUser, 650, 25);
const pointReward = createEmptyReward();
pointReward.miscItems.push(getMiscItem(eventPointUser, 650));
const pointBefore = JSON.stringify(eventPointUser);
assert.strictEqual(sendEventPointNotification(ctx, socket, 25n, pointReward), true);
assert.strictEqual(JSON.stringify(eventPointUser), pointBefore, "event-point push must report an already-applied reward without duplicating it");
const pointPayload = managedWire[managedWire.length - 1][1];
const pointTotal = readSignedVarLong(pointPayload, 0);
assert.strictEqual(pointTotal.value, 25n);
assert.strictEqual(readBool(pointPayload, pointTotal.offset).value, true);
assert.deepStrictEqual(buildEventPointPayload(-1, null), Buffer.from([0, 0]));

assert.strictEqual(saves, 5, "only the five successful recipe merges may save");
assert.strictEqual(invalidations, 5, "only the five successful recipe merges may invalidate JOIN");
assert.strictEqual(notifications, 6, "five collection updates plus one event-point reward must be sent");
validateManagedSchemas();
console.log(`[event-collection-protocol-check] PASS recipes=${tables.recipes.length} trophies=${tables.details.length} saves=${saves} packets=${managedWire.length} managed=on`);

function makeUser() {
  fixtureId += 1n;
  return { userUid: String(994000000000000n + fixtureId), nickname: "EventCollectionCheck" };
}

function makeFixture(recipe, options = {}) {
  const user = makeUser();
  const inputRows = tables.detailsByGradeGroup.get(recipe.inputGradeGroupId);
  const trophies = [];
  for (let index = 0; index < recipe.inputValue; index += 1) {
    const replacement = index === recipe.inputValue - 1 ? Number(options.replaceLastWith || 0) : 0;
    const unit = grantUnit(user, replacement || inputRows[index % inputRows.length].goodsId, { fromContract: false });
    assert(unit, "collection trophy fixture must resolve");
    trophies.push(unit);
  }
  const army = ensureArmy(user);
  const storedTrophies = trophies.map((trophy) => army.trophies[String(trophy.unitUid)]);
  if (options.mutateLast) options.mutateLast(storedTrophies[storedTrophies.length - 1], user);
  return { user, recipe, trophies: storedTrophies };
}

function failure(label, factory, payloadOrBuild, expectedError, validateRequest = true) {
  const state = factory();
  const before = JSON.stringify(state.user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeNotifications = notifications;
  const beforeRolls = randomRolls.slice();
  invoke(state.user, typeof payloadOrBuild === "function" ? payloadOrBuild(state) : payloadOrBuild, validateRequest);
  const ack = parseAck(response.payload);
  assert.strictEqual(ack.errorCode, expectedError, label);
  assert.strictEqual(ack.rewardPresent, false, `${label} reward must be null`);
  assert.deepStrictEqual(ack.consumedUids, [], `${label} consumed list must be empty`);
  assert.strictEqual(JSON.stringify(state.user), before, `${label} must not mutate profile state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
  assert.strictEqual(notifications, beforeNotifications, `${label} must not publish`);
  assert.deepStrictEqual(randomRolls, beforeRolls, `${label} must not consume randomness`);
}

function invoke(user, payload, validateRequest = true) {
  socket.session.user = user;
  response = null;
  if (validateRequest) managedWire.push([PACKETS.MERGE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.MERGE_REQ, sequence: managedWire.length + 1, payload }), true);
  assert(response, "Event Collection handler must respond");
  assert.strictEqual(response.packetId, PACKETS.MERGE_ACK);
}

function request(recipe, trophyUids) {
  const values = Array.isArray(trophyUids) ? trophyUids : [];
  return Buffer.concat([
    writeSignedVarInt(recipe.collectionMergeId),
    writeSignedVarInt(recipe.recipeGroupId),
    writeRawVarInt(values.length),
    ...values.map((value) => writeSignedVarLong(BigInt(value))),
  ]);
}

function uid(trophy) {
  return BigInt(trophy.unitUid);
}

function parseAck(payload) {
  let offset = 0;
  const error = readSignedVarInt(payload, offset); offset = error.offset;
  const mergeId = readSignedVarInt(payload, offset); offset = mergeId.offset;
  const reward = readReward(payload, offset); offset = reward.offset;
  const consumed = readLongList(payload, offset); offset = consumed.offset;
  assert.strictEqual(offset, payload.length, "merge ACK must have no trailing bytes");
  return {
    errorCode: error.value,
    collectionMergeId: mergeId.value,
    rewardPresent: reward.present,
    rewardUnitIds: reward.unitIds,
    consumedUids: consumed.values,
  };
}

function readReward(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { present: false, unitIds: [], offset: present.offset };
  let offset = present.offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  const units = readRawVarInt(payload, offset); offset = units.offset;
  const unitIds = [];
  for (let index = 0; index < units.value; index += 1) {
    const unitPresent = readBool(payload, offset); assert.strictEqual(unitPresent.value, true); offset = unitPresent.offset;
    const unit = skipUnit(payload, offset); offset = unit.offset; unitIds.push(unit.unitId);
  }
  for (let index = 0; index < 7; index += 1) offset = readEmptyList(payload, offset);
  offset = readEmptyList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readEmptyList(payload, offset);
  return { present: true, unitIds, offset };
}

function skipUnit(payload, startOffset) {
  let offset = startOffset;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readSignedVarLong(payload, offset).offset;
  const unitId = readSignedVarInt(payload, offset); offset = unitId.offset;
  for (let index = 0; index < 3; index += 1) offset = readSignedVarInt(payload, offset).offset;
  offset += 4;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = skipIntList(payload, offset);
  offset = skipFloatList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipLongList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readBool(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarInt(payload, offset).offset;
  offset += 8;
  offset = readSignedVarLong(payload, offset).offset;
  offset = readBool(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  assert(offset <= payload.length, "unit payload must stay within ACK boundary");
  return { unitId: unitId.value, offset };
}

function parseCollectionInfo(payload) {
  let offset = 0;
  const eventId = readSignedVarInt(payload, offset); offset = eventId.offset;
  const goods = readIntList(payload, offset); offset = goods.offset;
  assert.strictEqual(offset, payload.length);
  return { eventId: eventId.value, goodsIds: goods.values };
}

function readIntList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readSignedVarInt(payload, offset); offset = value.offset; values.push(value.value);
  }
  return { values, offset };
}

function readLongList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readSignedVarLong(payload, offset); offset = value.offset; values.push(value.value);
  }
  return { values, offset };
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
  const offset = count.offset + count.value * 4;
  assert(offset <= payload.length);
  return offset;
}

function readEmptyList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0, "unused reward list must be empty");
  return count.offset;
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

function readRawVarInt(payload, startOffset) {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < payload.length && shift <= 28) {
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("invalid raw varint");
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Event Collection schema validation");
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
      assert(result.ok, `managed client schema rejected Event Collection packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
