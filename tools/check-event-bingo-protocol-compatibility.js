"use strict";

const assert = require("assert");
const path = require("path");
const {
  ERRORS,
  PACKETS,
  buildEventInfoData,
  createEventBingoHandlers,
  loadTables,
  readBingoState,
} = require("../modules/event-bingo");
const { ensureInventory, getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { readBool, readSignedVarInt, readSignedVarLong, writeIntList, writeSignedVarInt } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createEventManager } = require("../modules/event-manager");

const rootDir = path.resolve(__dirname, "..");
const tables = loadTables();
assert.strictEqual(tables.bingoById.size, 14, "all frozen Bingo templates must load");
assert.strictEqual(tables.activeCapableIds.length, 12, "two retired Bingo rows must remain unavailable");
for (const row of tables.bingoById.values()) {
  if (!row.valid) continue;
  assert.strictEqual(row.size, 6);
  assert.strictEqual(row.tileCount, 36);
  assert.deepStrictEqual(row.missionTiles, [14, 15, 20, 21]);
  assert.strictEqual(row.rewardRows.length, 18);
}
assert.strictEqual(ERRORS.EVENT_INVALID_ID, 20365);
assert.strictEqual(ERRORS.EVENT_INVALID_REWARD_ID, 20366);
assert.strictEqual(ERRORS.EVENT_NOT_ALL_CLEARED, 20368);
assert.strictEqual(ERRORS.EVENT_END, 20371);
assert.strictEqual(ERRORS.EVENT_BINGO_ALREADY_MARKED, 20372);
assert.strictEqual(ERRORS.EVENT_BINGO_ALREADY_REWARD, 20373);
assert.strictEqual(ERRORS.EVENT_BINGO_NOT_ENOUGH_MILEAGE, 20374);
assert.strictEqual(ERRORS.EVENT_BINGO_NOT_ENOUGH_ITEM, 20375);
assert.strictEqual(ERRORS.EVENT_BINGO_INVALID_DATA, 20376);
assert.strictEqual(ERRORS.EVENT_BINGO_NO_EXIST_UPDATABLE_REWARD, 20377);
assert.strictEqual(ERRORS.EVENT_BINGO_INVALID_TILE_INDEX, 20905);

const EVENT_ID = 3147;
const row = tables.bingoById.get(EVENT_ID);
const handlers = new Map(createEventBingoHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [3000, 3002, 3004, 3006]) assert(handlers.has(packetId));

let activeEventIds = [EVENT_ID];
let response = null;
let saves = 0;
let invalidations = 0;
let resourceTracks = 0;
const managedWire = [];
const socket = { session: { user: null, gameReplay: {} } };
let fixtureId = 1;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  randomInt: () => 0,
  dateTimeBinaryNow: () => 5250083637907387904n,
  eventManager: {
    getActiveEventState() {
      return { entries: activeEventIds.map((eventId) => ({ raw: { m_EventID: eventId } })) };
    },
  },
  sendGameResponse(_socket, _packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  saveUserDb() { saves += 1; },
  trackMissionEvent(_user, condition, amount, selectors) {
    assert.strictEqual(condition, "USE_RESOURCE");
    assert.strictEqual(amount, row.tryItemValue);
    assert.strictEqual(selectors.itemId, row.tryItemId);
    resourceTracks += 1;
    return true;
  },
};

failure("random truncated", PACKETS.RANDOM_MARK_REQ, makeUser(1), Buffer.alloc(0), ERRORS.EVENT_BINGO_INVALID_DATA);
failure(
  "random trailing",
  PACKETS.RANDOM_MARK_REQ,
  makeUser(1),
  Buffer.concat([writeSignedVarInt(EVENT_ID), Buffer.from([0])]),
  ERRORS.EVENT_BINGO_INVALID_DATA
);
failure("random zero event", PACKETS.RANDOM_MARK_REQ, makeUser(1), writeSignedVarInt(0), ERRORS.EVENT_BINGO_INVALID_DATA);
failure("random unknown event", PACKETS.RANDOM_MARK_REQ, makeUser(1), writeSignedVarInt(999999), ERRORS.EVENT_INVALID_ID);
activeEventIds = [];
failure("random ended event", PACKETS.RANDOM_MARK_REQ, makeUser(1), writeSignedVarInt(EVENT_ID), ERRORS.EVENT_END);
activeEventIds = [EVENT_ID];
failure("random insufficient item", PACKETS.RANDOM_MARK_REQ, makeUser(0), writeSignedVarInt(EVENT_ID), ERRORS.EVENT_BINGO_NOT_ENOUGH_ITEM);
failure(
  "random completed board",
  PACKETS.RANDOM_MARK_REQ,
  makeUser(1, { marks: allTiles() }),
  writeSignedVarInt(EVENT_ID),
  ERRORS.EVENT_ALREADY_CLEARED
);

const randomUser = makeUser(3);
const randomAck = invoke(PACKETS.RANDOM_MARK_REQ, randomUser, writeSignedVarInt(EVENT_ID));
assert.strictEqual(randomAck.errorCode, ERRORS.OK);
assert.strictEqual(randomAck.eventId, EVENT_ID);
assert.strictEqual(randomAck.mileage, 1);
assert.strictEqual(randomAck.costItem.present, true);
assert.strictEqual(randomAck.costItem.itemId, row.tryItemId);
assert.strictEqual(randomAck.costItem.free + randomAck.costItem.paid, 2n);
assert.strictEqual(randomAck.reward.present, true);
assert.strictEqual(randomAck.reward.bingoTiles.length, 1);
assert.strictEqual(randomAck.reward.bingoTiles[0].eventId, EVENT_ID);
assert(!row.missionTiles.includes(randomAck.reward.bingoTiles[0].tileIndex));
assert.deepStrictEqual(randomUser.eventBingo[String(EVENT_ID)].markTileIndexList, [randomAck.reward.bingoTiles[0].tileIndex]);
assert.strictEqual(totalItem(randomUser, row.tryItemId), 2n);

failure("index truncated", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 10 }), Buffer.alloc(0), ERRORS.EVENT_BINGO_INVALID_DATA);
failure("index empty", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 10 }), indexRequest([]), ERRORS.EVENT_BINGO_INVALID_DATA);
failure("index duplicate", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 20 }), indexRequest([0, 0]), ERRORS.EVENT_BINGO_INVALID_DATA);
failure(
  "index trailing",
  PACKETS.INDEX_MARK_REQ,
  makeUser(1, { mileage: 10 }),
  Buffer.concat([indexRequest([0]), Buffer.from([0])]),
  ERRORS.EVENT_BINGO_INVALID_DATA
);
failure("index negative", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 10 }), indexRequest([-1]), ERRORS.EVENT_BINGO_INVALID_TILE_INDEX);
failure("index out of range", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 10 }), indexRequest([36]), ERRORS.EVENT_BINGO_INVALID_TILE_INDEX);
failure("index mission tile", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 10 }), indexRequest([14]), ERRORS.EVENT_BINGO_INVALID_TILE_INDEX);
failure("index already marked", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 10, marks: [0] }), indexRequest([0]), ERRORS.EVENT_BINGO_ALREADY_MARKED);
failure("index insufficient mileage", PACKETS.INDEX_MARK_REQ, makeUser(1, { mileage: 19 }), indexRequest([0, 1]), ERRORS.EVENT_BINGO_NOT_ENOUGH_MILEAGE);

const indexUser = makeUser(1, { mileage: 20 });
const indexAck = invoke(PACKETS.INDEX_MARK_REQ, indexUser, indexRequest([0, 1]));
assert.strictEqual(indexAck.errorCode, ERRORS.OK);
assert.strictEqual(indexAck.mileage, 0);
assert.strictEqual(indexAck.reward.present, true);
assert.deepStrictEqual(indexAck.reward.bingoTiles.map((tile) => tile.tileIndex), [0, 1]);
assert.deepStrictEqual(indexUser.eventBingo[String(EVENT_ID)].markTileIndexList, [0, 1]);

failure("reward truncated", PACKETS.REWARD_REQ, makeUser(1), Buffer.alloc(0), ERRORS.EVENT_BINGO_INVALID_DATA);
failure("reward negative", PACKETS.REWARD_REQ, makeUser(1), rewardRequest(-1), ERRORS.EVENT_BINGO_INVALID_DATA);
failure("reward unknown", PACKETS.REWARD_REQ, makeUser(1), rewardRequest(99), ERRORS.EVENT_INVALID_REWARD_ID);
failure("reward incomplete", PACKETS.REWARD_REQ, makeUser(1), rewardRequest(0), ERRORS.EVENT_NOT_ALL_CLEARED);

const rewardUser = makeUser(1, { marks: [0, 1, 2, 3, 4, 5] });
const beforeReward = totalItem(rewardUser, 2);
const rewardAck = invoke(PACKETS.REWARD_REQ, rewardUser, rewardRequest(0));
assert.strictEqual(rewardAck.errorCode, ERRORS.OK);
assert.strictEqual(rewardAck.rewardIndex, 0);
assert.strictEqual(rewardAck.rewardPresent, true);
assert.strictEqual(totalItem(rewardUser, 2) - beforeReward, 15000n);
assert.deepStrictEqual(rewardUser.eventBingo[String(EVENT_ID)].rewardList, [0]);
failure("reward duplicate", PACKETS.REWARD_REQ, rewardUser, rewardRequest(0), ERRORS.EVENT_BINGO_ALREADY_REWARD);

failure("reward-all truncated", PACKETS.REWARD_ALL_REQ, makeUser(1), Buffer.alloc(0), ERRORS.EVENT_BINGO_INVALID_DATA);
failure(
  "reward-all none eligible",
  PACKETS.REWARD_ALL_REQ,
  makeUser(1),
  writeSignedVarInt(EVENT_ID),
  ERRORS.EVENT_BINGO_NO_EXIST_UPDATABLE_REWARD
);
const allUser = makeUser(1, { marks: allTiles() });
const rewardAllAck = invoke(PACKETS.REWARD_ALL_REQ, allUser, writeSignedVarInt(EVENT_ID));
assert.strictEqual(rewardAllAck.errorCode, ERRORS.OK);
assert.deepStrictEqual(rewardAllAck.rewardIndexes, Array.from({ length: 18 }, (_, index) => index));
assert.strictEqual(rewardAllAck.rewardPresent, true);
assert.deepStrictEqual(allUser.eventBingo[String(EVENT_ID)].rewardList, Array.from({ length: 18 }, (_, index) => index));
failure(
  "reward-all duplicate",
  PACKETS.REWARD_ALL_REQ,
  allUser,
  writeSignedVarInt(EVENT_ID),
  ERRORS.EVENT_BINGO_NO_EXIST_UPDATABLE_REWARD
);

const restarted = JSON.parse(JSON.stringify(randomUser));
const restartState = readBingoState(restarted, row);
assert.deepStrictEqual(restartState, readBingoState(randomUser, row), "Bingo state must survive JSON restart");
const eventInfo = parseEventInfo(buildEventInfoData(restarted, ctx));
assert.strictEqual(eventInfo.length, 1);
assert.strictEqual(eventInfo[0].eventId, EVENT_ID);
assert.deepStrictEqual(eventInfo[0].markTileIndexList, restartState.markTileIndexList);
assert.deepStrictEqual(eventInfo[0].tileValueList, restartState.tileValueList);
assert.strictEqual(eventInfo[0].mileage, restartState.mileage);
activeEventIds = [];
assert.deepStrictEqual(parseEventInfo(buildEventInfoData(restarted, ctx)), [], "ended Bingo must not be sent in JOIN");
activeEventIds = [EVENT_ID];
const missionUser = makeUser(1);
missionUser.bingoTiles = { [String(EVENT_ID)]: [14] };
assert.deepStrictEqual(parseEventInfo(buildEventInfoData(missionUser, ctx))[0].markTileIndexList, [14]);
const frozenSummer2025 = createEventManager({
  rootDir,
  env: { ...process.env, CS_EVENT_DATE: "2025-06-20" },
});
assert.deepStrictEqual(
  parseEventInfo(buildEventInfoData(makeUser(1), { eventManager: frozenSummer2025 })).map((entry) => entry.eventId),
  [EVENT_ID],
  "the real frozen interval resolver must activate the Summer 2025 Bingo"
);

assert.strictEqual(saves, 4, "only four successful mutations may save");
assert.strictEqual(invalidations, 4, "only four successful mutations may invalidate JOIN");
assert.strictEqual(resourceTracks, 1, "only random item spend may track USE_RESOURCE");
validateManagedSchemas();
console.log(`[event-bingo-protocol-check] PASS templates=12 rewards=18 saves=${saves} packets=${managedWire.length} managed=on`);

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
  const ack = invoke(packetId, user, payload);
  assert.strictEqual(ack.errorCode, expectedError, label);
  assert.strictEqual(ack.rewardPresent, false, `${label} reward must be null`);
  if (packetId === PACKETS.RANDOM_MARK_REQ) assert.strictEqual(ack.costItem.present, false, `${label} cost item must be null`);
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate profile state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
}

function makeUser(itemCount, options = {}) {
  const user = { userUid: String(991000000000000n + BigInt(fixtureId++)), nickname: "EventBingoCheck" };
  ensureInventory(user);
  setMiscItemBalance(user, row.tryItemId, itemCount, 0, { regDate: 5250083637907387904n });
  if (options.marks || options.rewards || options.mileage) {
    const state = readBingoState(user, row);
    state.markTileIndexList = (options.marks || []).slice().sort((a, b) => a - b);
    state.rewardList = (options.rewards || []).slice().sort((a, b) => a - b);
    state.mileage = Number(options.mileage || 0);
    user.eventBingo = { [String(EVENT_ID)]: state };
  }
  return user;
}

function indexRequest(tileIndexes) {
  return Buffer.concat([writeSignedVarInt(EVENT_ID), writeIntList(tileIndexes)]);
}

function rewardRequest(rewardIndex) {
  return Buffer.concat([writeSignedVarInt(EVENT_ID), writeSignedVarInt(rewardIndex)]);
}

function allTiles() {
  return Array.from({ length: 36 }, (_, index) => index);
}

function parseAck(packetId, payload) {
  let offset = 0;
  const error = readSignedVarInt(payload, offset); offset = error.offset;
  const eventId = readSignedVarInt(payload, offset); offset = eventId.offset;
  const result = { errorCode: error.value, eventId: eventId.value, rewardPresent: false };
  if (packetId === PACKETS.RANDOM_MARK_ACK) {
    result.costItem = readNullableItem(payload, offset); offset = result.costItem.offset;
    const mileage = readSignedVarInt(payload, offset); offset = mileage.offset; result.mileage = mileage.value;
    result.reward = readNullableBingoReward(payload, offset); offset = result.reward.offset;
    result.rewardPresent = result.reward.present;
  } else if (packetId === PACKETS.INDEX_MARK_ACK) {
    const mileage = readSignedVarInt(payload, offset); offset = mileage.offset; result.mileage = mileage.value;
    result.reward = readNullableBingoReward(payload, offset); offset = result.reward.offset;
    result.rewardPresent = result.reward.present;
  } else if (packetId === PACKETS.REWARD_ACK) {
    const rewardIndex = readSignedVarInt(payload, offset); offset = rewardIndex.offset; result.rewardIndex = rewardIndex.value;
    const present = readBool(payload, offset); offset = present.offset; result.rewardPresent = present.value;
  } else if (packetId === PACKETS.REWARD_ALL_ACK) {
    const rewardIndexes = readIntList(payload, offset); offset = rewardIndexes.offset; result.rewardIndexes = rewardIndexes.values;
    const present = readBool(payload, offset); offset = present.offset; result.rewardPresent = present.value;
  }
  if (!result.rewardPresent) assert.strictEqual(offset, payload.length, `failure ACK ${packetId} must have no trailing bytes`);
  return result;
}

function readNullableItem(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { present: false, offset: present.offset };
  const itemId = readSignedVarInt(payload, present.offset);
  const free = readSignedVarLong(payload, itemId.offset);
  const paid = readSignedVarLong(payload, free.offset);
  const bonus = readSignedVarInt(payload, paid.offset);
  return { present: true, itemId: itemId.value, free: free.value, paid: paid.value, offset: bonus.offset + 8 };
}

function readNullableBingoReward(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { present: false, bingoTiles: [], offset: present.offset };
  let offset = present.offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  for (let index = 0; index < 9; index += 1) offset = readEmptyList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  const bingoTiles = readBingoTileList(payload, offset); offset = bingoTiles.offset;
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = readEmptyList(payload, offset);
  return { present: true, bingoTiles: bingoTiles.values, offset };
}

function readBingoTileList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset); assert.strictEqual(present.value, true); offset = present.offset;
    const eventId = readSignedVarInt(payload, offset); offset = eventId.offset;
    const tileIndex = readSignedVarInt(payload, offset); offset = tileIndex.offset;
    values.push({ eventId: eventId.value, tileIndex: tileIndex.value });
  }
  return { values, offset };
}

function parseEventInfo(payload) {
  const count = readRawVarInt(payload, 0);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset); assert.strictEqual(present.value, true); offset = present.offset;
    const eventId = readSignedVarInt(payload, offset); offset = eventId.offset;
    const tileValueList = readIntList(payload, offset); offset = tileValueList.offset;
    const markTileIndexList = readIntList(payload, offset); offset = markTileIndexList.offset;
    const rewardList = readIntList(payload, offset); offset = rewardList.offset;
    const mileage = readSignedVarInt(payload, offset); offset = mileage.offset;
    values.push({ eventId: eventId.value, tileValueList: tileValueList.values, markTileIndexList: markTileIndexList.values, rewardList: rewardList.values, mileage: mileage.value });
  }
  assert.strictEqual(offset, payload.length, "EventInfo must have no trailing bytes");
  return values;
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

function readEmptyList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0);
  return count.offset;
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

function totalItem(user, itemId) {
  const item = getMiscItem(user, itemId);
  return BigInt(item && item.countFree || 0) + BigInt(item && item.countPaid || 0);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Bingo schema validation");
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
      assert(result.ok, `managed client schema rejected Event Bingo packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
