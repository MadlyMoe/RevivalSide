"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const {
  getOperatorExtractTokenItemId,
  getPlayableOperatorIds,
  getUnitRemoveRewards,
  getUnitTemplet,
} = require("../modules/game-data");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const { ensureArmy, ensureDeck, getArmyOperatorByUid, grantOperator } = require("../modules/unit");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong } = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const operatorIds = getPlayableOperatorIds();
assert(operatorIds.length >= 7, "frozen operator table must provide extract fixtures");
const SSR_OPERATOR_ID = operatorIds.find((id) => getUnitTemplet(id).m_NKM_UNIT_GRADE === "NUG_SSR");
const SR_OPERATOR_ID = operatorIds.find((id) => getUnitTemplet(id).m_NKM_UNIT_GRADE === "NUG_SR");
assert(SSR_OPERATOR_ID && SR_OPERATOR_ID, "frozen SSR and SR operator fixtures must exist");

const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.OPERATOR_EXTRACT_REQ);
assert(handler, "operator-extract handler must be registered");
const managedWire = [];
let fixtureId = 0n;
let runtimeOpenTags = ["OPERATOR_EXTRACT"];
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
    assert.strictEqual(reason, "operator-extract");
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

failure("truncated", () => ({ user: createUser() }), Buffer.alloc(0), ERROR_CODES.INVALID_REQUEST, false);
failure("trailing", makeFixture, (state) => Buffer.concat([request([state.operator.uid]), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("empty", makeFixture, () => request([]), ERROR_CODES.INVALID_REQUEST);
failure("duplicate", makeFixture, (state) => request([state.operator.uid, state.operator.uid]), ERROR_CODES.INVALID_REQUEST);
failure("zero uid", makeFixture, () => request([0]), ERROR_CODES.INVALID_REQUEST);
failure("over client maximum", makeFixture, () => request(Array.from({ length: 1001 }, (_, index) => 1000000 + index)), ERROR_CODES.INVALID_REQUEST);
failure("system tag closed", makeFixture, (state) => request([state.operator.uid]), ERROR_CODES.OPENTAG_CLOSED, true, []);
failure("missing operator atomicity", makeTwoFixture, (state) => request([state.first.uid, 999999999]), ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
failure("wrong roster type", () => makeFixture({ unitId: 1001 }), (state) => request([state.operator.uid]), ERROR_CODES.OPERATOR_EXTRACT_INVALID_DATA);
failure("missing passive skill", () => makeFixture({ subSkillId: 999999 }), (state) => request([state.operator.uid]), ERROR_CODES.OPERATOR_SKILL_TEMPLET_NOT_EXISTS);
failure("locked", () => makeFixture({ mutate(operator) { operator.locked = true; } }), (state) => request([state.operator.uid]), ERROR_CODES.UNIT_LOCKED);
failure(
  "lobby background",
  () => makeFixture({ mutate(operator, user) { user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: operator.uid }] } }; } }),
  (state) => request([state.operator.uid]),
  ERROR_CODES.UNIT_IS_LOBBY_UNIT
);
failure(
  "decked",
  () => makeFixture({ mutate(operator, user) { ensureDeck(user, { deckType: 1, index: 0 }).operatorUid = operator.uid; } }),
  (state) => request([state.operator.uid]),
  ERROR_CODES.UNIT_IN_DECK
);
failure("insufficient extraction price", () => makeFixture({ information: 499 }), (state) => request([state.operator.uid]), ERROR_CODES.INSUFFICIENT_ITEM);
assertNoMutations();

const user = createUser();
const first = grantOperator(user, SSR_OPERATOR_ID, { subSkillId: 1002, fromContract: true });
const second = grantOperator(user, SR_OPERATOR_ID, { subSkillId: 1003, fromContract: false });
assert(first && second);
ensureArmy(user);
setMiscItemBalance(user, 3, 500, 500);
const expectedRewards = mergeRewards([
  ...getUnitRemoveRewards(first.id, { fromContract: true }),
  ...getUnitRemoveRewards(second.id, { fromContract: false }),
  { itemId: getOperatorExtractTokenItemId(first.id, first.subSkill.id), count: 1 },
  { itemId: getOperatorExtractTokenItemId(second.id, second.subSkill.id), count: 1 },
]);
for (const itemId of Object.keys(expectedRewards)) setMiscItemBalance(user, itemId, 10);

runtimeOpenTags = ["OPERATOR_EXTRACT"];
socket.session.user = user;
send(request([first.uid, second.uid]));
assertAck(ERROR_CODES.OK, [BigInt(first.uid), BigInt(second.uid)], { 3: { free: 0, paid: 200 } }, expectedRewards);
assert.strictEqual(getArmyOperatorByUid(user, first.uid), null);
assert.strictEqual(getArmyOperatorByUid(user, second.uid), null);
assert.strictEqual(getMiscItem(user, 3).countFree, "0");
assert.strictEqual(getMiscItem(user, 3).countPaid, "200");
for (const [itemId, count] of Object.entries(expectedRewards)) {
  assert.strictEqual(getMiscItem(user, itemId).countFree, String(10 + count));
}
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [["USE_RESOURCE", 800, 3]]
);

const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(getArmyOperatorByUid(restarted, first.uid), null);
assert.strictEqual(getArmyOperatorByUid(restarted, second.uid), null);
assert.strictEqual(getMiscItem(restarted, 3).countPaid, "200");
for (const [itemId, count] of Object.entries(expectedRewards)) {
  assert.strictEqual(getMiscItem(restarted, itemId).countFree, String(10 + count));
}

validateManagedSchemas();
console.log(`[operator-extract-protocol-check] PASS rewards=${Object.keys(expectedRewards).length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  return { userUid: String(988000000000000n + fixtureId), nickname: "OperatorExtractCheck" };
}

function makeFixture(options = {}) {
  const user = createUser();
  const operator = grantOperator(user, options.unitId || SSR_OPERATOR_ID, {
    subSkillId: options.subSkillId || 1002,
    fromContract: options.fromContract !== false,
  });
  assert(operator);
  ensureArmy(user);
  const stored = user.army.operators[String(operator.uid)];
  setMiscItemBalance(user, 3, options.information == null ? 5000 : options.information);
  if (options.mutate) options.mutate(stored, user);
  return { user, operator: stored };
}

function makeTwoFixture() {
  const state = makeFixture();
  state.first = state.operator;
  state.second = grantOperator(state.user, SR_OPERATOR_ID, { subSkillId: 1003 });
  ensureArmy(state.user);
  return state;
}

function failure(name, makeState, makePayload, expectedError, validateRequest = true, tags = ["OPERATOR_EXTRACT"]) {
  const state = makeState();
  ensureArmy(state.user);
  socket.session.user = state.user;
  runtimeOpenTags = tags.slice();
  const before = JSON.parse(JSON.stringify(state.user));
  send(typeof makePayload === "function" ? makePayload(state) : makePayload, validateRequest);
  assertAck(expectedError, [], {}, {});
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state.user)), before, `${name} must not mutate user state`);
}

function request(uids) {
  const values = Array.isArray(uids) ? uids : [];
  return Buffer.concat([writeRawVarInt(values.length), ...values.map((uid) => writeSignedVarLong(BigInt(uid)))]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.OPERATOR_EXTRACT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.OPERATOR_EXTRACT_REQ, sequence: 1, payload }), true);
}

function assertAck(expectedError, expectedRemoved, expectedCosts, expectedRewards) {
  assert(response, "operator-extract handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.OPERATOR_EXTRACT_ACK);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, expectedError);
  const removed = readLongList(response.payload, error.offset);
  assert.deepStrictEqual(removed.values, expectedRemoved);
  const costs = readItemList(response.payload, removed.offset, false);
  assert.deepStrictEqual(costs.values, normalizeCostExpectation(expectedCosts));
  const rewards = readItemList(response.payload, costs.offset, true);
  assert.deepStrictEqual(rewards.values, Object.fromEntries(Object.entries(expectedRewards).map(([id, count]) => [id, String(count)])));
  assert.strictEqual(rewards.offset, response.payload.length, "operator-extract ACK must contain no trailing fields");
}

function readLongList(payload, startOffset) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const uid = readSignedVarLong(payload, offset);
    values.push(uid.value);
    offset = uid.offset;
  }
  return { values, offset };
}

function readItemList(payload, startOffset, additive) {
  const count = readRawVarInt(payload, startOffset);
  let offset = count.offset;
  const values = {};
  for (let index = 0; index < count.value; index += 1) {
    assert.strictEqual(payload[offset++], 1);
    const itemId = readSignedVarInt(payload, offset);
    const countFree = readSignedVarLong(payload, itemId.offset);
    const countPaid = readSignedVarLong(payload, countFree.offset);
    const bonusRatio = readSignedVarInt(payload, countPaid.offset);
    offset = bonusRatio.offset + 8;
    values[String(itemId.value)] = additive
      ? String(BigInt(countFree.value) + BigInt(countPaid.value))
      : { free: Number(countFree.value), paid: Number(countPaid.value) };
  }
  return { values, offset };
}

function normalizeCostExpectation(costs) {
  return Object.fromEntries(Object.entries(costs).map(([id, value]) => [id, { free: value.free, paid: value.paid }]));
}

function mergeRewards(rewards) {
  const result = {};
  for (const reward of rewards) {
    assert(reward.itemId > 0 && reward.count > 0, "frozen operator extraction rewards must resolve");
    result[String(reward.itemId)] = (result[String(reward.itemId)] || 0) + reward.count;
  }
  return result;
}

function assertNoMutations() {
  assert.strictEqual(saves, 0);
  assert.strictEqual(invalidations, 0);
  assert.deepStrictEqual(missionEvents, []);
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
      assert(result.ok, `managed client schema rejected operator-extract packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
