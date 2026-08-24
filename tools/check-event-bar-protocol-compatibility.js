"use strict";

const assert = require("assert");
const path = require("path");
const {
  ERRORS,
  MAX_CREATE_COUNT,
  PACKETS,
  activeEventIds,
  createEventBarHandlers,
  getDailyResetKey,
  loadTables,
  readDailyState,
  sendEventBarDailyInfoNotification,
} = require("../modules/event-bar");
const { ensureInventory, getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { createEventManager } = require("../modules/event-manager");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const tables = loadTables();
assert.strictEqual(tables.rowsByRewardItemId.size, 12, "all frozen Event Bar recipes must load");
assert.deepStrictEqual(Array.from(tables.rowsByEventId, ([eventId, rows]) => [eventId, rows.length]), [[6001, 6], [6002, 6]]);
assert.deepStrictEqual(tables.activeCapableIds, [6001, 6002]);
for (const row of tables.rowsByRewardItemId.values()) {
  assert.strictEqual(row.valid, true);
  assert.strictEqual(row.materialItemValue1, 2);
  assert.strictEqual(row.materialItemValue2, 2);
  assert(["stir", "shake"].includes(row.technique));
  assert.strictEqual(row.deliveryLimit, "Day");
  assert.strictEqual(row.deliveryLimitValue, 1);
  assert.strictEqual(row.deliveryValue, 5);
}
assert.strictEqual(ERRORS.INSUFFICIENT_RESOURCE, 109);
assert.strictEqual(ERRORS.INVALID_ITEM_COUNT, 20362);
assert.strictEqual(ERRORS.EVENT_END, 21027);
assert.strictEqual(ERRORS.EVENT_TEMPLET_NOT_EXIST, 21028);
assert.strictEqual(ERRORS.EVENT_NO_DAILY_COCKTAIL, 21029);
assert.strictEqual(ERRORS.EVENT_DAILY_REWARD_END, 21030);
assert.strictEqual(MAX_CREATE_COUNT, 999);

const handlers = new Map(createEventBarHandlers().map((handler) => [handler.packetId, handler]));
assert.deepStrictEqual(Array.from(handlers.keys()), [PACKETS.CREATE_COCKTAIL_REQ, PACKETS.GET_REWARD_REQ]);

let nowDate = new Date("2026-04-10T12:00:00.000Z");
let activeIds = [6002];
let response = null;
let saves = 0;
let invalidations = 0;
let resourceTracks = 0;
let notifications = 0;
let fixtureId = 0;
const managedWire = [];
const socket = { session: { user: null, gameReplay: {} } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getServerNowDate: () => new Date(nowDate),
  eventManager: {
    getActiveEventState() {
      return { entries: activeIds.map((eventId) => ({ raw: { m_EventID: eventId } })) };
    },
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  sendServerGamePacket(_socket, packetId, payload) {
    notifications += 1;
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  saveUserDb() { saves += 1; },
  trackMissionEvent(_user, condition, amount, selectors) {
    assert.strictEqual(condition, "USE_RESOURCE");
    assert(Number(amount) > 0);
    assert.strictEqual(selectors.itemId, selectors.resourceId);
    resourceTracks += 1;
    return true;
  },
  isTutorialCapturedBootstrapActive() { return false; },
  dateTimeBinaryNow: () => 5250083637907387904n,
};

const recipe = tables.rowsByEventId.get(6002)[0];
failure("create truncated", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), Buffer.alloc(0), ERRORS.INVALID_ITEM_COUNT);
failure("create trailing", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), Buffer.concat([createRequest(recipe.rewardItemId, 1), Buffer.from([0])]), ERRORS.INVALID_ITEM_COUNT);
failure("create zero", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), createRequest(recipe.rewardItemId, 0), ERRORS.INVALID_ITEM_COUNT);
failure("create negative", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), createRequest(recipe.rewardItemId, -1), ERRORS.INVALID_ITEM_COUNT);
failure("create over max", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), createRequest(recipe.rewardItemId, 1000), ERRORS.INVALID_ITEM_COUNT);
failure("create unknown", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), createRequest(999999, 1), ERRORS.EVENT_TEMPLET_NOT_EXIST);
failure("create inactive", PACKETS.CREATE_COCKTAIL_REQ, makeUser(), createRequest(31063, 1), ERRORS.EVENT_END);

const insufficient = makeUser();
setMiscItemBalance(insufficient, recipe.materialItemId1, 4);
setMiscItemBalance(insufficient, recipe.materialItemId2, 3);
failure("create atomic insufficient", PACKETS.CREATE_COCKTAIL_REQ, insufficient, createRequest(recipe.rewardItemId, 2), ERRORS.INSUFFICIENT_RESOURCE);

const craftUser = makeUser();
setMiscItemBalance(craftUser, recipe.materialItemId1, 10);
setMiscItemBalance(craftUser, recipe.materialItemId2, 10);
const craftAck = invoke(PACKETS.CREATE_COCKTAIL_REQ, craftUser, createRequest(recipe.rewardItemId, 2));
assert.strictEqual(craftAck.errorCode, ERRORS.OK);
assert.deepStrictEqual(craftAck.reward.miscItems.map(itemSummary), [{ itemId: recipe.rewardItemId, count: 2n }]);
assert.deepStrictEqual(craftAck.costItems.map(itemSummary), [
  { itemId: recipe.materialItemId1, count: 6n },
  { itemId: recipe.materialItemId2, count: 6n },
].sort((left, right) => left.itemId - right.itemId));
assert.strictEqual(totalItem(craftUser, recipe.rewardItemId), 2n);
assert.strictEqual(totalItem(craftUser, recipe.materialItemId1), 6n);
assert.strictEqual(totalItem(craftUser, recipe.materialItemId2), 6n);

const notificationUser = makeUser();
socket.session.user = notificationUser;
socket.session.eventBarDailyInfoKey = "";
const notificationSaves = saves;
assert.strictEqual(sendEventBarDailyInfoNotification(ctx, socket), true);
assert.strictEqual(notifications, 1);
assert.strictEqual(saves, notificationSaves + 1, "initial daily selection must persist once");
const firstDaily = readDailyState(ctx, notificationUser, 6002);
assert.strictEqual(firstDaily.dailyResetKey, "2026-04-10");
assert(tables.rowsByEventId.get(6002).some((row) => row.rewardItemId === firstDaily.dailyCocktailItemId));
assert.strictEqual(firstDaily.remainDeliveryLimitValue, 1);
assert.strictEqual(sendEventBarDailyInfoNotification(ctx, socket), false, "same daily notification must be suppressed");
assert.strictEqual(notifications, 1);

nowDate = new Date("2026-04-11T03:59:59.000Z");
assert.strictEqual(getDailyResetKey(nowDate), "2026-04-10");
assert.strictEqual(sendEventBarDailyInfoNotification(ctx, socket), false, "daily state must not reset before 04:00 UTC");
nowDate = new Date("2026-04-11T04:00:00.000Z");
assert.strictEqual(getDailyResetKey(nowDate), "2026-04-11");
assert.strictEqual(sendEventBarDailyInfoNotification(ctx, socket), true, "daily state must reset at 04:00 UTC");
assert.strictEqual(notifications, 2);
assert.strictEqual(readDailyState(ctx, notificationUser, 6002).remainDeliveryLimitValue, 1);

nowDate = new Date("2026-04-10T12:00:00.000Z");
const deliveryUser = makeUser();
const daily = readDailyState(ctx, deliveryUser, 6002);
const dailyRow = tables.rowsByRewardItemId.get(daily.dailyCocktailItemId);
const wrongRow = tables.rowsByEventId.get(6002).find((row) => row.rewardItemId !== daily.dailyCocktailItemId);
failure("reward truncated", PACKETS.GET_REWARD_REQ, deliveryUser, Buffer.alloc(0), ERRORS.EVENT_TEMPLET_NOT_EXIST);
failure("reward trailing", PACKETS.GET_REWARD_REQ, deliveryUser, Buffer.concat([singleInt(daily.dailyCocktailItemId), Buffer.from([0])]), ERRORS.EVENT_TEMPLET_NOT_EXIST);
failure("reward unknown", PACKETS.GET_REWARD_REQ, deliveryUser, singleInt(999999), ERRORS.EVENT_TEMPLET_NOT_EXIST);
failure("reward inactive", PACKETS.GET_REWARD_REQ, deliveryUser, singleInt(31063), ERRORS.EVENT_END);
failure("reward wrong daily", PACKETS.GET_REWARD_REQ, deliveryUser, singleInt(wrongRow.rewardItemId), ERRORS.EVENT_NO_DAILY_COCKTAIL);
setMiscItemBalance(deliveryUser, dailyRow.rewardItemId, 4);
failure("reward insufficient", PACKETS.GET_REWARD_REQ, deliveryUser, singleInt(dailyRow.rewardItemId), ERRORS.INSUFFICIENT_RESOURCE);

setMiscItemBalance(deliveryUser, dailyRow.rewardItemId, 5);
const beforeDeliveryReward = totalItem(deliveryUser, dailyRow.deliveryRewardItemId);
const deliveryAck = invoke(PACKETS.GET_REWARD_REQ, deliveryUser, singleInt(dailyRow.rewardItemId));
assert.strictEqual(deliveryAck.errorCode, ERRORS.OK);
assert.strictEqual(deliveryAck.remainDeliveryLimitValue, 0);
assert.deepStrictEqual(deliveryAck.costItems.map(itemSummary), [{ itemId: dailyRow.rewardItemId, count: 0n }]);
assert.deepStrictEqual(deliveryAck.reward.miscItems.map(itemSummary), [{ itemId: dailyRow.deliveryRewardItemId, count: BigInt(dailyRow.deliveryRewardValue) }]);
assert.strictEqual(totalItem(deliveryUser, dailyRow.rewardItemId), 0n);
assert.strictEqual(totalItem(deliveryUser, dailyRow.deliveryRewardItemId) - beforeDeliveryReward, BigInt(dailyRow.deliveryRewardValue));
assert.strictEqual(deliveryUser.eventBar["6002"].remainDeliveryLimitValue, 0);
failure("reward exhausted", PACKETS.GET_REWARD_REQ, deliveryUser, singleInt(dailyRow.rewardItemId), ERRORS.EVENT_DAILY_REWARD_END);

const restarted = JSON.parse(JSON.stringify(deliveryUser));
assert.deepStrictEqual(readDailyState(ctx, restarted, 6002), readDailyState(ctx, deliveryUser, 6002), "daily selection and limit must survive restart");

const gremoryManager = createEventManager({ rootDir, env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: "2023-06-25" } });
const stregaManager = createEventManager({ rootDir, env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: "2026-04-10" } });
const endedManager = createEventManager({ rootDir, env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: "2026-08-20" } });
assert.deepStrictEqual(activeEventIds({ eventManager: gremoryManager }), [6001]);
assert.deepStrictEqual(activeEventIds({ eventManager: stregaManager }), [6002]);
assert.deepStrictEqual(activeEventIds({ eventManager: endedManager }), []);
assert.strictEqual(sendEventBarDailyInfoNotification({ ...ctx, eventManager: endedManager }, { session: { user: makeUser() } }), false);

const tutorialSocket = { session: { user: makeUser() } };
assert.strictEqual(sendEventBarDailyInfoNotification({ ...ctx, isTutorialCapturedBootstrapActive: () => true }, tutorialSocket), false);

assert.strictEqual(invalidations, 2, "only craft and delivery successes may invalidate JOIN");
assert.strictEqual(resourceTracks, 3, "two craft materials and one delivered cocktail must track USE_RESOURCE");
assert.strictEqual(saves, 4, "daily init, daily reset, craft, and delivery must save exactly once each");
validateManagedSchemas();
console.log(`[event-bar-protocol-check] PASS recipes=12 events=2 saves=${saves} packets=${managedWire.length} notifications=${notifications} managed=on`);

function invoke(packetId, user, payload) {
  socket.session.user = user;
  response = null;
  handlers.get(packetId).handle(ctx, socket, { packetId, sequence: managedWire.length + 1, payload });
  assert(response, `packet ${packetId} must respond`);
  assert.strictEqual(response.packetId, packetId + 1);
  return parseAck(response.packetId, response.payload);
}

function failure(label, packetId, user, payload, expectedError) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeTracks = resourceTracks;
  const ack = invoke(packetId, user, payload);
  assert.strictEqual(ack.errorCode, expectedError, label);
  assert.strictEqual(ack.reward.present, false, `${label} reward must be null`);
  assert.deepStrictEqual(ack.costItems, [], `${label} costs must be empty`);
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate profile state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
  assert.strictEqual(resourceTracks, beforeTracks, `${label} must not track resources`);
}

function makeUser() {
  const user = { userUid: String(992000000000000n + BigInt(++fixtureId)), nickname: "EventBarCheck" };
  ensureInventory(user);
  return user;
}

function createRequest(itemId, count) {
  return Buffer.concat([writeSignedVarInt(itemId), writeSignedVarInt(count)]);
}

function singleInt(value) {
  return writeSignedVarInt(value);
}

function totalItem(user, itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
}

function itemSummary(item) {
  return { itemId: item.itemId, count: item.free + item.paid };
}

function parseAck(packetId, payload) {
  let offset = 0;
  const error = readSignedVarInt(payload, offset); offset = error.offset;
  const reward = readNullableReward(payload, offset); offset = reward.offset;
  const costItems = readItemList(payload, offset); offset = costItems.offset;
  const result = { errorCode: error.value, reward, costItems: costItems.values };
  if (packetId === PACKETS.GET_REWARD_ACK) {
    const remain = readSignedVarInt(payload, offset); offset = remain.offset;
    result.remainDeliveryLimitValue = remain.value;
  }
  assert.strictEqual(offset, payload.length, `ACK ${packetId} must have no trailing bytes`);
  return result;
}

function readNullableReward(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { present: false, miscItems: [], offset: present.offset };
  let offset = present.offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  const miscItems = readItemList(payload, offset); offset = miscItems.offset;
  for (let index = 0; index < 2; index += 1) offset = readEmptyList(payload, offset);
  offset = readEmptyIntList(payload, offset);
  for (let index = 0; index < 3; index += 1) offset = readEmptyList(payload, offset);
  offset = readEmptyIntList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readEmptyList(payload, offset);
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readEmptyList(payload, offset);
  return { present: true, miscItems: miscItems.values, offset };
}

function readItemList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset); assert.strictEqual(present.value, true); offset = present.offset;
    const itemId = readSignedVarInt(payload, offset); offset = itemId.offset;
    const free = readSignedVarLong(payload, offset); offset = free.offset;
    const paid = readSignedVarLong(payload, offset); offset = paid.offset;
    offset = readSignedVarInt(payload, offset).offset;
    offset += 8;
    assert(offset <= payload.length);
    values.push({ itemId: itemId.value, free: free.value, paid: paid.value });
  }
  return { values, offset };
}

function readEmptyList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0);
  return count.offset;
}

function readEmptyIntList(payload, startOffset) {
  return readEmptyList(payload, startOffset);
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
  assert(managedDir, "CounterSide managed directory is required for Event Bar schema validation");
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
      assert(result.ok, `managed client schema rejected Event Bar packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
