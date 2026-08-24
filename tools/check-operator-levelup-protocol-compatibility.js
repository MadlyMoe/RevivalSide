"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const { getOperatorLevelUpConfig, getPlayableOperatorIds, getUnitTemplet } = require("../modules/game-data");
const { ensureArmy, getArmyOperatorByUid, grantOperator } = require("../modules/unit");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  writeNullObject,
  writeObjectList,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const config = getOperatorLevelUpConfig();
assert.deepStrictEqual(config, {
  maxLevel: 100,
  maxMaterialUsageLimit: 500,
  materials: [
    { itemId: 1044, exp: 200, credit: 1500 },
    { itemId: 1045, exp: 500, credit: 3750 },
    { itemId: 1046, exp: 1200, credit: 9000 },
  ],
}, "operator level-up must use the frozen client negotiation constants");
const operatorId = getPlayableOperatorIds().find((id) => getUnitTemplet(id).m_NKM_UNIT_GRADE === "NUG_SSR");
assert(operatorId, "frozen SSR operator fixture must exist");

const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.OPERATOR_LEVELUP_REQ);
assert(handler, "operator-levelup handler must be registered");
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
    assert.strictEqual(reason, "operator-levelup");
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
failure(
  "trailing",
  makeFixture,
  (state) => Buffer.concat([request(state.operator.uid, [{ itemId: 1044, count: 1 }]), Buffer.from([0])]),
  ERROR_CODES.INVALID_REQUEST,
  false
);
failure("missing operator", () => ({ user: createUser() }), () => request(999999999, [{ itemId: 1044, count: 1 }]), ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
failure("wrong roster type", () => makeFixture({ unitId: 1001 }), (state) => request(state.operator.uid, [{ itemId: 1044, count: 1 }]), ERROR_CODES.OPERATOR_INVALID_UNIT_ID);
failure("maximum level", () => makeFixture({ level: 100 }), (state) => request(state.operator.uid, [{ itemId: 1044, count: 1 }]), ERROR_CODES.UNIT_MAX_LEVEL);
failure("empty materials", makeFixture, (state) => request(state.operator.uid, []), ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL);
failure("null material", makeFixture, (state) => requestWithNull(state.operator.uid), ERROR_CODES.NEGOTIATION_INVALID_MATERIAL);
failure("unknown material", makeFixture, (state) => request(state.operator.uid, [{ itemId: 1047, count: 1 }]), ERROR_CODES.NEGOTIATION_INVALID_MATERIAL);
failure("duplicate material", makeFixture, (state) => request(state.operator.uid, [{ itemId: 1044, count: 1 }, { itemId: 1044, count: 1 }]), ERROR_CODES.NEGOTIATION_INVALID_MATERIAL);
failure("zero count", makeFixture, (state) => request(state.operator.uid, [{ itemId: 1044, count: 0 }]), ERROR_CODES.NEGOTIATION_INVALID_MATERIAL_COUNT);
failure("negative count", makeFixture, (state) => request(state.operator.uid, [{ itemId: 1044, count: -1 }]), ERROR_CODES.NEGOTIATION_INVALID_MATERIAL_COUNT);
failure("over usage cap", makeFixture, (state) => request(state.operator.uid, [{ itemId: 1044, count: 501 }]), ERROR_CODES.NEGOTIATION_INVALID_MATERIAL_COUNT);
failure(
  "insufficient material",
  () => makeFixture({ balances: { 1: [1500, 0], 1044: [0, 0] } }),
  (state) => request(state.operator.uid, [{ itemId: 1044, count: 1 }]),
  ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL
);
failure(
  "insufficient credit",
  () => makeFixture({ balances: { 1: [1499, 0], 1044: [1, 0] } }),
  (state) => request(state.operator.uid, [{ itemId: 1044, count: 1 }]),
  ERROR_CODES.INSUFFICIENT_CREDIT
);
assertNoCommits();

const single = makeFixture({ balances: { 1: [500, 2000], 1044: [1, 0] } });
socket.session.user = single.user;
send(request(single.operator.uid, [{ itemId: 1044, count: 1 }]));
assertSuccess(single.operator.uid, 2, 0, [
  { itemId: 1, countFree: 0, countPaid: 1000 },
  { itemId: 1044, countFree: 0, countPaid: 0 },
]);

const mixed = makeFixture({ balances: { 1: [4250, 20000], 1044: [1, 0], 1045: [0, 2], 1046: [1, 0] } });
socket.session.user = mixed.user;
send(request(mixed.operator.uid, [
  { itemId: 1044, count: 1 },
  { itemId: 1045, count: 1 },
  { itemId: 1046, count: 1 },
]));
assertSuccess(mixed.operator.uid, 8, 180, [
  { itemId: 1, countFree: 0, countPaid: 10000 },
  { itemId: 1044, countFree: 0, countPaid: 0 },
  { itemId: 1045, countFree: 0, countPaid: 1 },
  { itemId: 1046, countFree: 0, countPaid: 0 },
]);

const capped = makeFixture({ level: 99, balances: { 1: [1107000, 0], 1046: [123, 0] } });
socket.session.user = capped.user;
send(request(capped.operator.uid, [{ itemId: 1046, count: 123 }]));
assertSuccess(capped.operator.uid, 100, 0, [
  { itemId: 1, countFree: 0, countPaid: 0 },
  { itemId: 1046, countFree: 0, countPaid: 0 },
]);

assert.strictEqual(saves, 3, "only successful operator level-ups may save");
assert.strictEqual(invalidations, 3, "only successful operator level-ups may invalidate the lobby cache");
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ["USE_RESOURCE", 1500, 1],
    ["USE_RESOURCE", 1, 1044],
    ["USE_RESOURCE", 14250, 1],
    ["USE_RESOURCE", 1, 1044],
    ["USE_RESOURCE", 1, 1045],
    ["USE_RESOURCE", 1, 1046],
    ["USE_RESOURCE", 1107000, 1],
    ["USE_RESOURCE", 123, 1046],
  ]
);

for (const [state, level, exp] of [[single, 2, 0], [mixed, 8, 180], [capped, 100, 0]]) {
  const restarted = JSON.parse(JSON.stringify(state.user));
  const operator = getArmyOperatorByUid(restarted, state.operator.uid);
  assert.strictEqual(operator.level, level);
  assert.strictEqual(operator.exp, exp);
}

validateManagedSchemas();
console.log(`[operator-levelup-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(981000000000000n + fixtureId), nickname: "OperatorLevelupCheck" };
  ensureArmy(user);
  getMiscItem(user, 1);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  const operator = grantOperator(user, options.unitId || operatorId, { level: options.level || 1 });
  assert(operator, "operator level-up fixture must exist");
  ensureArmy(user);
  const stored = user.army.operators[String(operator.uid)];
  stored.level = options.level || 1;
  stored.exp = options.exp || 0;
  for (const [itemId, counts] of Object.entries(options.balances || {})) {
    setMiscItemBalance(user, Number(itemId), counts[0], counts[1]);
  }
  return { user, operator: stored };
}

function failure(name, makeState, makePayload, expectedError, validateRequest = true) {
  const state = normalizeState(makeState());
  socket.session.user = state.user;
  const before = JSON.parse(JSON.stringify(state.user));
  send(typeof makePayload === "function" ? makePayload(state) : makePayload, validateRequest);
  assertFailure(expectedError);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state.user)), before, `${name} must not mutate user state`);
}

function normalizeState(state) {
  return state && state.user ? state : { user: state };
}

function request(operatorUid, materials) {
  const list = Array.isArray(materials) ? materials : [];
  return Buffer.concat([
    writeSignedVarLong(BigInt(operatorUid)),
    writeObjectList(list.map((material) => writeNullableObject(Buffer.concat([
      writeSignedVarInt(material.itemId),
      writeSignedVarInt(material.count),
    ])))),
  ]);
}

function requestWithNull(operatorUid) {
  return Buffer.concat([writeSignedVarLong(BigInt(operatorUid)), writeObjectList([writeNullObject()])]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.OPERATOR_LEVELUP_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.OPERATOR_LEVELUP_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertFailure(expectedError) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, expectedError);
  assert.deepStrictEqual(ack.costItems, []);
  assert.strictEqual(ack.operator, null);
}

function assertSuccess(operatorUid, level, exp, expectedItems) {
  const ack = readAck();
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.operator.uid.toString(), String(operatorUid));
  assert.strictEqual(ack.operator.level, level);
  assert.strictEqual(ack.operator.exp, exp);
  assert.deepStrictEqual(ack.costItems, expectedItems);
  for (const expected of expectedItems) {
    const item = getMiscItem(socket.session.user, expected.itemId);
    assert.strictEqual(item.countFree, String(expected.countFree));
    assert.strictEqual(item.countPaid, String(expected.countPaid));
  }
}

function readAck() {
  assert(response, "operator-levelup handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.OPERATOR_LEVELUP_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const costs = readMiscItemList(response.payload, error.offset);
  const present = readBool(response.payload, costs.offset);
  const operator = present.value ? readOperatorData(response.payload, present.offset) : null;
  const offset = operator ? operator.offset : present.offset;
  assert.strictEqual(offset, response.payload.length, "operator-levelup ACK must contain no trailing fields");
  return { errorCode: error.value, costItems: costs.values, operator };
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

function readOperatorData(payload, startOffset) {
  const id = readSignedVarInt(payload, startOffset);
  const uid = readSignedVarLong(payload, id.offset);
  const level = readSignedVarInt(payload, uid.offset);
  const exp = readSignedVarInt(payload, level.offset);
  const locked = readBool(payload, exp.offset);
  const mainSkill = skipOperatorSkill(payload, locked.offset);
  const subSkill = skipOperatorSkill(payload, mainSkill);
  const fromContract = readBool(payload, subSkill);
  return { id: id.value, uid: uid.value, level: level.value, exp: exp.value, offset: fromContract.offset };
}

function skipOperatorSkill(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return present.offset;
  const id = readSignedVarInt(payload, present.offset);
  const level = readByte(payload, id.offset);
  return readSignedVarInt(payload, level.offset).offset;
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
      assert(result.ok, `managed client schema rejected operator-levelup packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
