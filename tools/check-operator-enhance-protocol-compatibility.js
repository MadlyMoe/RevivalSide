"use strict";

const assert = require("assert");
const path = require("path");
const { ERROR_CODES, PACKETS, createUnitGrowthHandlers } = require("../modules/unit-growth");
const {
  getOperatorEnhanceCost,
  getOperatorEnhanceRates,
  getOperatorMainSkillId,
  getOperatorPassiveToken,
  getOperatorSkillTemplet,
  getPlayableOperatorIds,
  getUnitTemplet,
} = require("../modules/game-data");
const { ensureArmy, ensureDeck, getArmyOperatorByUid, grantOperator } = require("../modules/unit");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const idsByGrade = Object.fromEntries(["NUG_SSR", "NUG_SR", "NUG_R", "NUG_N"].map((grade) => [
  grade,
  getPlayableOperatorIds().find((id) => getUnitTemplet(id).m_NKM_UNIT_GRADE === grade),
]));
assert(Object.values(idsByGrade).every(Boolean), "frozen operator table must provide every grade fixture");
assert.deepStrictEqual(getOperatorEnhanceCost(idsByGrade.NUG_SSR), { itemId: 3, count: 2000 });
assert.deepStrictEqual(getOperatorEnhanceRates("NUG_SR"), {
  commandLevelUpPercent: 100,
  levelUpSuccessRatePercent: 75,
  transportSuccessRatePercent: 38,
});
assert.deepStrictEqual(getOperatorPassiveToken(100101), {
  itemId: 100101,
  itemGrade: "NIG_SSR",
  skillId: 1001,
  levelUpSuccessRatePercent: 100,
  transportSuccessRatePercent: 50,
});
assert.strictEqual(getOperatorMainSkillId(idsByGrade.NUG_SSR), idsByGrade.NUG_SSR);
assert.strictEqual(getOperatorSkillTemplet(idsByGrade.NUG_SSR).m_MaxSkillLevel, 8);
assert.strictEqual(getOperatorSkillTemplet(1001).m_MaxSkillLevel, 11);

const socket = { session: { user: null } };
const handler = createUnitGrowthHandlers().find((entry) => entry.packetId === PACKETS.OPERATOR_ENHANCE_REQ);
assert(handler, "operator-enhance handler must be registered");
const managedWire = [];
let fixtureId = 0n;
let response = null;
let saves = 0;
let invalidations = 0;
let rolls = [];
const missionEvents = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => Array.isArray(tags) ? tags.slice() : [],
  randomInt(max) {
    assert.strictEqual(max, 100);
    assert(rolls.length > 0, "a probabilistic enhancement roll must be supplied by the fixture");
    return rolls.shift();
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "operator-enhance");
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
failure("trailing", () => makeFixture({ source: true }), (state) => Buffer.concat([operatorRequest(state, false), Buffer.from([0])]), ERROR_CODES.INVALID_REQUEST, false);
failure("missing target", () => ({ user: createUser() }), () => request(999999999, 1, 0, false), ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
failure("wrong target type", () => makeFixture({ targetId: 1001, source: true }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_INVALID_UNIT_ID);
failure("no material", makeFixture, (state) => request(state.target.uid, 0, 0, false), ERROR_CODES.INVALID_REQUEST);
failure("ambiguous material", () => makeFixture({ source: true }), (state) => request(state.target.uid, state.source.uid, 100101, false), ERROR_CODES.INVALID_REQUEST);
failure("self material", makeFixture, (state) => request(state.target.uid, state.target.uid, 0, false), ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
failure("missing source", makeFixture, (state) => request(state.target.uid, 999999999, 0, false), ERROR_CODES.OPERATOR_INVALID_UNIT_UID);
failure("wrong source type", () => makeFixture({ source: true, sourceId: 1001 }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_INVALID_UNIT_ID);
failure("locked source", () => makeFixture({ source: true, mutateSource(source) { source.locked = true; } }), (state) => operatorRequest(state, false), ERROR_CODES.UNIT_LOCKED);
failure("decked source", () => makeFixture({ source: true, mutateSource(source, user) { ensureDeck(user, { deckType: 1, index: 0 }).operatorUid = source.uid; } }), (state) => operatorRequest(state, false), ERROR_CODES.UNIT_IN_DECK);
failure("lobby source", () => makeFixture({ source: true, mutateSource(source, user) { user.lobbyCustomization = { backgroundInfo: { unitInfoList: [{ unitUid: source.uid }] } }; } }), (state) => operatorRequest(state, false), ERROR_CODES.UNIT_IS_LOBBY_UNIT);
failure("invalid target skill", () => makeFixture({ source: true, targetSubSkillId: 999999 }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
failure("invalid source skill", () => makeFixture({ source: true, sourceSubSkillId: 999999 }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
failure("invalid token", makeFixture, (state) => request(state.target.uid, 0, 999999, false), ERROR_CODES.OPERATOR_ENHANCE_TOKEN_INVALID_ITEM_ID);
failure("no matching skills", () => makeFixture({ source: true, sourceId: idsByGrade.NUG_SR, sourceSubSkillId: 1002 }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
failure("transfer grade too low", () => makeFixture({ source: true, sourceId: idsByGrade.NUG_N, sourceSubSkillId: 1002 }), (state) => operatorRequest(state, true), ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
failure("skills already maximum", () => makeFixture({ source: true, targetMainLevel: 8, targetSubLevel: 11 }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_INVALID_SKILL_ID);
failure("insufficient host material", () => makeFixture({ source: true }), (state) => operatorRequest(state, false), ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL);
failure("insufficient token", () => makeFixture({ balances: { 3: [2000, 0] } }), (state) => request(state.target.uid, 0, 100101, false), ERROR_CODES.OPERATOR_NOT_ENOUGH_MATERIAL);
assertNoCommits();

const same = successSource({
  sourceId: idsByGrade.NUG_SSR,
  sourceSubSkillId: 1001,
  targetSubSkillId: 1001,
}, [], false, { mainLevel: 2, subSkillId: 1001, subLevel: 2 });

const keepLevel = successSource({
  sourceId: idsByGrade.NUG_SSR,
  sourceMainLevel: 3,
  sourceSubSkillId: 1001,
  targetSubSkillId: 1001,
  openTags: ["LIMITBREAK_KEEP_LEVEL"],
}, [], false, { mainLevel: 4, subSkillId: 1001, subLevel: 2 });

const srSub = successSource({ sourceId: idsByGrade.NUG_SR, sourceSubSkillId: 1001, targetSubSkillId: 1001 }, [74], false, {
  mainLevel: 1, subSkillId: 1001, subLevel: 2,
});
const nSubFail = successSource({ sourceId: idsByGrade.NUG_N, sourceSubSkillId: 1001, targetSubSkillId: 1001 }, [8], false, {
  mainLevel: 1, subSkillId: 1001, subLevel: 1,
});
const sourceTransfer = successSource({ sourceId: 30201, sourceSubSkillId: 1002, targetSubSkillId: 1001 }, [49], true, {
  mainLevel: 1, subSkillId: 1002, subLevel: 1,
});
const sourceTransferFail = successSource({ sourceId: 30201, sourceSubSkillId: 1002, targetSubSkillId: 1001 }, [50], true, {
  mainLevel: 1, subSkillId: 1001, subLevel: 1,
});

const tokenEnhance = successToken({ targetSubSkillId: 1001 }, 100101, [], false, { subSkillId: 1001, subLevel: 2 });
const tokenEnhanceFail = successToken({ targetSubSkillId: 1001 }, 100104, [8], false, { subSkillId: 1001, subLevel: 1 });
const tokenTransfer = successToken({ targetSubSkillId: 1002 }, 100101, [49], true, { subSkillId: 1001, subLevel: 1 });
const tokenTransferFail = successToken({ targetSubSkillId: 1002 }, 100101, [50], true, { subSkillId: 1002, subLevel: 1 });

assert.strictEqual(saves, 10, "every valid enhancement attempt must save its consumed material and outcome");
assert.strictEqual(invalidations, 10, "every valid enhancement attempt must invalidate the lobby cache");
assert.deepStrictEqual(rolls, []);
assert.deepStrictEqual(
  missionEvents.map(({ condition, amount, details }) => [condition, amount, details && details.itemId]),
  [
    ...Array.from({ length: 6 }, () => [["USE_RESOURCE", 2000, 3]]).flat(),
    ["USE_RESOURCE", 2000, 3], ["USE_RESOURCE", 1, 100101],
    ["USE_RESOURCE", 2000, 3], ["USE_RESOURCE", 1, 100104],
    ["USE_RESOURCE", 2000, 3], ["USE_RESOURCE", 1, 100101],
    ["USE_RESOURCE", 2000, 3], ["USE_RESOURCE", 1, 100101],
  ]
);

for (const state of [same, keepLevel, srSub, nSubFail, sourceTransfer, sourceTransferFail]) {
  const restarted = JSON.parse(JSON.stringify(state.user));
  assert.strictEqual(getArmyOperatorByUid(restarted, state.sourceUid), null);
  assert(getArmyOperatorByUid(restarted, state.target.uid));
}
for (const state of [tokenEnhance, tokenEnhanceFail, tokenTransfer, tokenTransferFail]) {
  const restarted = JSON.parse(JSON.stringify(state.user));
  assert(getArmyOperatorByUid(restarted, state.target.uid));
}

validateManagedSchemas();
console.log(`[operator-enhance-protocol-check] PASS saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser() {
  fixtureId += 1n;
  const user = { userUid: String(980000000000000n + fixtureId), nickname: "OperatorEnhanceCheck" };
  ensureArmy(user);
  getMiscItem(user, 1);
  return user;
}

function makeFixture(options = {}) {
  const user = createUser();
  user.openTags = Array.isArray(options.openTags) ? options.openTags.slice() : [];
  const target = grantOperator(user, options.targetId || idsByGrade.NUG_SSR, {
    mainSkillId: options.targetMainSkillId,
    subSkillId: options.targetSubSkillId || 1001,
  });
  assert(target);
  target.mainSkill.level = options.targetMainLevel || 1;
  target.subSkill.level = options.targetSubLevel || 1;
  let source = null;
  if (options.source) {
    source = grantOperator(user, options.sourceId || options.targetId || idsByGrade.NUG_SSR, {
      mainSkillId: options.sourceMainSkillId,
      subSkillId: options.sourceSubSkillId || options.targetSubSkillId || 1001,
    });
    assert(source);
    source.mainSkill.level = options.sourceMainLevel || 1;
    source.subSkill.level = options.sourceSubLevel || 1;
    if (options.mutateSource) options.mutateSource(source, user);
  }
  for (const [itemId, counts] of Object.entries(options.balances || {})) {
    setMiscItemBalance(user, Number(itemId), counts[0], counts[1]);
  }
  ensureArmy(user);
  return {
    user,
    target: getArmyOperatorByUid(user, target.uid),
    source: source && getArmyOperatorByUid(user, source.uid),
  };
}

function failure(name, makeState, makePayload, expectedError, validateRequest = true) {
  const state = normalizeState(makeState());
  socket.session.user = state.user;
  rolls = [];
  const before = JSON.parse(JSON.stringify(state.user));
  send(typeof makePayload === "function" ? makePayload(state) : makePayload, validateRequest);
  const ack = readAck();
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.strictEqual(ack.operator, null);
  assert.deepStrictEqual(ack.costItems, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state.user)), before, `${name} must not mutate user state`);
  assert.deepStrictEqual(rolls, []);
}

function successSource(options, randomRolls, transSkill, expected) {
  const state = makeFixture({ ...options, source: true, balances: { 3: [500, 2500] } });
  const sourceUid = state.source.uid;
  socket.session.user = state.user;
  rolls = randomRolls.slice();
  send(operatorRequest(state, transSkill));
  const ack = readAck();
  assertSuccess(ack, state.target.uid, expected, [{ itemId: 3, countFree: 0, countPaid: 1000 }]);
  assert.strictEqual(ack.sourceUid.toString(), sourceUid);
  assert.strictEqual(ack.transSkill, transSkill);
  assert.strictEqual(ack.tokenItemId, 0);
  assert.strictEqual(getArmyOperatorByUid(state.user, sourceUid), null, "source operator must be consumed on success or failed roll");
  state.sourceUid = sourceUid;
  return state;
}

function successToken(options, tokenItemId, randomRolls, transSkill, expected) {
  const state = makeFixture({ ...options, balances: { 3: [2000, 500], [tokenItemId]: [1, 1] } });
  socket.session.user = state.user;
  rolls = randomRolls.slice();
  send(request(state.target.uid, 0, tokenItemId, transSkill));
  const ack = readAck();
  assertSuccess(ack, state.target.uid, { mainLevel: 1, ...expected }, [
    { itemId: 3, countFree: 0, countPaid: 500 },
    { itemId: tokenItemId, countFree: 0, countPaid: 1 },
  ]);
  assert.strictEqual(ack.sourceUid, 0n);
  assert.strictEqual(ack.transSkill, transSkill);
  assert.strictEqual(ack.tokenItemId, tokenItemId);
  return state;
}

function normalizeState(state) {
  return state && state.user ? state : { user: state };
}

function operatorRequest(state, transSkill) {
  return request(state.target.uid, state.source.uid, 0, transSkill);
}

function request(targetUid, sourceUid, tokenItemId, transSkill) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(targetUid)),
    writeSignedVarLong(BigInt(sourceUid)),
    writeSignedVarInt(tokenItemId),
    writeBool(Boolean(transSkill)),
  ]);
}

function send(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([PACKETS.OPERATOR_ENHANCE_REQ, payload]);
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, {
    packetId: PACKETS.OPERATOR_ENHANCE_REQ,
    sequence: 1,
    payload,
  }), true);
}

function assertSuccess(ack, targetUid, expected, costItems) {
  assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
  assert.strictEqual(ack.operator.uid.toString(), String(targetUid));
  assert.strictEqual(ack.operator.mainSkill.level, expected.mainLevel);
  assert.strictEqual(ack.operator.subSkill.id, expected.subSkillId);
  assert.strictEqual(ack.operator.subSkill.level, expected.subLevel);
  assert.deepStrictEqual(ack.costItems, costItems);
  for (const cost of costItems) {
    const item = getMiscItem(socket.session.user, cost.itemId);
    assert.strictEqual(item.countFree, String(cost.countFree));
    assert.strictEqual(item.countPaid, String(cost.countPaid));
  }
  assert.deepStrictEqual(rolls, []);
}

function readAck() {
  assert(response, "operator-enhance handler must send an ACK");
  assert.strictEqual(response.packetId, PACKETS.OPERATOR_ENHANCE_ACK);
  const error = readSignedVarInt(response.payload, 0);
  const present = readBool(response.payload, error.offset);
  const operator = present.value ? readOperatorData(response.payload, present.offset) : null;
  const costs = readMiscItemList(response.payload, operator ? operator.offset : present.offset);
  const sourceUid = readSignedVarLong(response.payload, costs.offset);
  const transSkill = readBool(response.payload, sourceUid.offset);
  const tokenItemId = readSignedVarInt(response.payload, transSkill.offset);
  assert.strictEqual(tokenItemId.offset, response.payload.length, "operator-enhance ACK must contain no trailing fields");
  return {
    errorCode: error.value,
    operator,
    costItems: costs.values,
    sourceUid: sourceUid.value,
    transSkill: transSkill.value,
    tokenItemId: tokenItemId.value,
  };
}

function readOperatorData(payload, startOffset) {
  const id = readSignedVarInt(payload, startOffset);
  const uid = readSignedVarLong(payload, id.offset);
  const level = readSignedVarInt(payload, uid.offset);
  const exp = readSignedVarInt(payload, level.offset);
  const locked = readBool(payload, exp.offset);
  const mainSkill = readOperatorSkill(payload, locked.offset);
  const subSkill = readOperatorSkill(payload, mainSkill.offset);
  const fromContract = readBool(payload, subSkill.offset);
  return { id: id.value, uid: uid.value, mainSkill, subSkill, offset: fromContract.offset };
}

function readOperatorSkill(payload, startOffset) {
  const present = readBool(payload, startOffset);
  assert.strictEqual(present.value, true);
  const id = readSignedVarInt(payload, present.offset);
  const level = readByte(payload, id.offset);
  const exp = readSignedVarInt(payload, level.offset);
  return { id: id.value, level: level.value, exp: exp.value, offset: exp.offset };
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
      assert(result.ok, `managed client schema rejected operator-enhance packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
