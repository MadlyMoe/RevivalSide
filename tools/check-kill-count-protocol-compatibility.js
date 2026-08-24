"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const {
  PACKETS,
  ERROR_CODES,
  buildServerKillCountNotPayload,
  createKillCountHandlers,
  getBattleKillDelta,
  getServerKillCount,
  getUserKillCountData,
  loadCatalog,
  recordBattleKillCount,
} = require("../modules/kill-count");
const { ensureInventory, getMiscItem } = require("../modules/inventory");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = new Map(createKillCountHandlers().map((handler) => [handler.packetId, handler]));
const alice = makeUser("1001");
const bob = makeUser("1002");
const userDb = { users: { [alice.userUid]: alice, [bob.userUid]: bob } };
const socket = { session: { user: alice } };
const managedPackets = [];
let response = null;
let saves = 0;
let invalidations = 0;

const ctx = {
  userDb,
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  dateTimeBinaryNow() { return 0n; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert(["kill-count-user-reward", "kill-count-server-reward"].includes(reason));
    invalidations += 1;
  },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 1);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
};

const catalog = loadCatalog();
const event = catalog.eventsById.get(5001);
assert(event, "frozen Kill Count event 5001 must exist");
assert.deepStrictEqual(event.targetStageIds, [6123611, 6123612, 6123613]);
assert.strictEqual(event.userSteps.length, 6);
assert.strictEqual(event.serverSteps.length, 20);
assert.deepStrictEqual(event.userSteps[0], {
  stepId: 1,
  killCount: 60,
  rewardType: "RT_MISC",
  rewardId: 31059,
  rewardQuantity: 1,
});
assert.deepStrictEqual(event.serverSteps[0], {
  stepId: 1,
  killCount: 1000000,
  rewardType: "RT_MISC",
  rewardId: 101,
  rewardQuantity: 30,
});

failure("truncated user request", PACKETS.KILL_COUNT_USER_REWARD_REQ, Buffer.alloc(0), ERROR_CODES.INVALID_TEMPLET);
failure(
  "trailing user request",
  PACKETS.KILL_COUNT_USER_REWARD_REQ,
  Buffer.concat([request(5001, 1), Buffer.from([0])]),
  ERROR_CODES.INVALID_TEMPLET
);
failure("unknown template", PACKETS.KILL_COUNT_USER_REWARD_REQ, request(999999, 1), ERROR_CODES.INVALID_TEMPLET);
failure("locked reward", PACKETS.KILL_COUNT_USER_REWARD_REQ, request(5001, 1), ERROR_CODES.REWARD_LOCKED);

unlock(alice);
failure("out-of-order user step", PACKETS.KILL_COUNT_USER_REWARD_REQ, request(5001, 2), ERROR_CODES.INVALID_STEP);
failure("insufficient personal count", PACKETS.KILL_COUNT_USER_REWARD_REQ, request(5001, 1), ERROR_CODES.NOT_ENOUGH_COUNT);
assert.strictEqual(saves, 0);
assert.strictEqual(invalidations, 0);

alice.killCount = { "5001": { killCountId: 5001, killCount: 60, userCompleteStep: 0, serverCompleteStep: 0 } };
send(PACKETS.KILL_COUNT_USER_REWARD_REQ, request(5001, 1));
let ack = parseRewardAck(response.payload);
assert.strictEqual(response.packetId, PACKETS.KILL_COUNT_USER_REWARD_ACK);
assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
assert.deepStrictEqual(ack.killCountData, [{ killCountId: 5001, killCount: 60n, userCompleteStep: 1, serverCompleteStep: 0 }]);
assert.strictEqual(itemCount(alice, 31059), 1n, "personal reward must come from the frozen table");
assert.strictEqual(saves, 1);
assert.strictEqual(invalidations, 1);
failure("duplicate personal reward", PACKETS.KILL_COUNT_USER_REWARD_REQ, request(5001, 1), ERROR_CODES.REWARD_ALREADY_GIVEN);

alice.killCount["5001"].killCount = 120;
send(PACKETS.KILL_COUNT_USER_REWARD_REQ, request(5001, 2));
ack = parseRewardAck(response.payload);
assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
assert.strictEqual(itemCount(alice, 2), 5000n);
assert.strictEqual(alice.killCount["5001"].userCompleteStep, 2);

alice.killCount["5001"].killCount = 600000;
bob.killCount = { "5001": { killCountId: 5001, killCount: 400000, userCompleteStep: 0, serverCompleteStep: 0 } };
assert.strictEqual(getServerKillCount(ctx, 5001), 1000000);
failure("out-of-order server step", PACKETS.KILL_COUNT_SERVER_REWARD_REQ, request(5001, 2), ERROR_CODES.INVALID_STEP);
send(PACKETS.KILL_COUNT_SERVER_REWARD_REQ, request(5001, 1));
ack = parseRewardAck(response.payload);
assert.strictEqual(response.packetId, PACKETS.KILL_COUNT_SERVER_REWARD_ACK);
assert.strictEqual(ack.errorCode, ERROR_CODES.OK);
assert.deepStrictEqual(ack.killCountData, [{ killCountId: 5001, killCount: 600000n, userCompleteStep: 2, serverCompleteStep: 1 }]);
assert.strictEqual(itemCount(alice, 101), 30n, "server reward must come from the frozen table");
failure("duplicate server reward", PACKETS.KILL_COUNT_SERVER_REWARD_REQ, request(5001, 1), ERROR_CODES.REWARD_ALREADY_GIVEN);
assert.strictEqual(saves, 3, "three successful claims must each save exactly once");
assert.strictEqual(invalidations, 3, "three successful claims must each invalidate exactly once");

const battleUser = makeUser("2001");
unlock(battleUser);
userDb.users[battleUser.userUid] = battleUser;
const replay = {};
const battleState = {
  unitRecords: [
    { teamType: 2, recordKillCount: 37 },
    { teamType: 2, recordKillCount: 23 },
    { teamType: 4, recordKillCount: 8 },
  ],
};
assert.strictEqual(getBattleKillDelta(battleState), 60);
const battle = recordBattleKillCount(ctx, battleUser, {
  stageId: 6123611,
  battleState,
  replay,
});
assert.strictEqual(battle.eligible, true);
assert.strictEqual(battle.delta, 60);
assert.deepStrictEqual(battle.data, { killCountId: 5001, killCount: 60, userCompleteStep: 0, serverCompleteStep: 0 });
assert.strictEqual(recordBattleKillCount(ctx, battleUser, { stageId: 6123611, battleState, replay }), battle);
assert.strictEqual(getUserKillCountData(battleUser, 5001).killCount, 60, "replayed GAME_END must not double count");
const unrelated = makeUser("2002");
assert.strictEqual(recordBattleKillCount(ctx, unrelated, { stageId: 1, battleState, replay: {} }).eligible, false);
assert.strictEqual(unrelated.killCount, undefined, "unrelated battles must not create Kill Count state");

const pushPayload = buildServerKillCountNotPayload(ctx);
managedPackets.push([PACKETS.SERVER_KILL_COUNT_NOT, pushPayload]);
assert.deepStrictEqual(parseServerNot(pushPayload), [{ killCountId: 5001, killCount: 1000060n }]);

const restarted = JSON.parse(JSON.stringify(userDb));
assert.strictEqual(restarted.users[alice.userUid].killCount["5001"].userCompleteStep, 2);
assert.strictEqual(restarted.users[alice.userUid].killCount["5001"].serverCompleteStep, 1);
assert.strictEqual(restarted.users[battleUser.userUid].killCount["5001"].killCount, 60);

const listenerSource = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
assert(listenerSource.includes("killCount.recordBattleKillCount("), "listener GAME_END must record Kill Count progress");
assert(listenerSource.includes("killCount.buildKillCountData(killCountResult.data)"), "listener GAME_END must serialize Kill Count data");
assert(listenerSource.includes("killCount.buildServerKillCountNotPayload({ userDb })"), "listener must emit the server total push");

validateManagedSchemas();
console.log(
  `[kill-count-protocol-check] PASS saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function makeUser(userUid) {
  const user = {
    userUid,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [] },
    stagePlayData: {},
    dungeonClear: {},
  };
  ensureInventory(user);
  return user;
}

function unlock(user) {
  user.stagePlayData["6123611"] = { stageId: 6123611, playCount: 1, totalPlayCount: 1 };
}

function request(templetId, stepId) {
  return Buffer.concat([writeSignedVarInt(templetId), writeSignedVarInt(stepId)]);
}

function send(packetId, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing Kill Count handler ${packetId}`);
  response = null;
  if (validateRequest) managedPackets.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `handler ${packetId} must send an ACK`);
}

function failure(name, packetId, payload, expectedError) {
  const before = JSON.stringify(alice);
  const savesBefore = saves;
  const invalidationsBefore = invalidations;
  send(packetId, payload, payload.length > 0 && name !== "trailing user request");
  const parsed = parseRewardAck(response.payload);
  assert.strictEqual(parsed.errorCode, expectedError, name);
  assert.strictEqual(parsed.rewardPresent, false, `${name} must not return a reward`);
  assert.deepStrictEqual(parsed.killCountData, [], `${name} must not replace client state`);
  assert.strictEqual(JSON.stringify(alice), before, `${name} must not mutate state`);
  assert.strictEqual(saves, savesBefore, `${name} must not save`);
  assert.strictEqual(invalidations, invalidationsBefore, `${name} must not invalidate`);
}

function parseRewardAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const rewardPresent = readBool(payload, error.offset);
  let offset = rewardPresent.offset;
  if (rewardPresent.value) offset = skipRewardData(payload, offset);
  const list = readObjectList(payload, offset, readKillCountData);
  assert.strictEqual(list.offset, payload.length, "Kill Count ACK must contain no trailing fields");
  return { errorCode: error.value, rewardPresent: rewardPresent.value, killCountData: list.values };
}

function parseServerNot(payload) {
  const list = readObjectList(payload, 0, (buffer, offset) => {
    const eventId = readSignedVarInt(buffer, offset);
    const count = readSignedVarLong(buffer, eventId.offset);
    return { value: { killCountId: eventId.value, killCount: count.value }, offset: count.offset };
  });
  assert.strictEqual(list.offset, payload.length, "server Kill Count push must contain no trailing fields");
  return list.values;
}

function readKillCountData(payload, startOffset) {
  const eventId = readSignedVarInt(payload, startOffset);
  const count = readSignedVarLong(payload, eventId.offset);
  const userStep = readSignedVarInt(payload, count.offset);
  const serverStep = readSignedVarInt(payload, userStep.offset);
  return {
    value: {
      killCountId: eventId.value,
      killCount: count.value,
      userCompleteStep: userStep.value,
      serverCompleteStep: serverStep.value,
    },
    offset: serverStep.offset,
  };
}

function readObjectList(payload, startOffset, readValue) {
  const count = readUnsignedVarInt(payload, startOffset);
  const values = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true, "Kill Count lists must not contain null entries");
    const parsed = readValue(payload, present.offset);
    values.push(parsed.value);
    offset = parsed.offset;
  }
  return { values, offset };
}

function skipRewardData(payload, startOffset) {
  let offset = readSignedVarInt(payload, startOffset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = skipObjectList(payload, offset);
  offset = readObjectList(payload, offset, skipItem).offset;
  for (let index = 0; index < 7; index += 1) offset = skipObjectList(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  offset = skipObjectList(payload, offset);
  offset = readSignedVarLong(payload, offset).offset;
  for (let index = 0; index < 3; index += 1) offset = skipObjectList(payload, offset);
  return offset;
}

function skipItem(payload, startOffset) {
  const itemId = readSignedVarInt(payload, startOffset);
  const countFree = readSignedVarLong(payload, itemId.offset);
  const countPaid = readSignedVarLong(payload, countFree.offset);
  const bonus = readSignedVarInt(payload, countPaid.offset);
  return { value: null, offset: bonus.offset + 8 };
}

function skipObjectList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  assert.strictEqual(count.value, 0, "checker only expects empty nested reward lists");
  return count.offset;
}

function readUnsignedVarInt(payload, startOffset) {
  let offset = startOffset;
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    assert(offset < payload.length, "truncated list count");
    const byte = payload[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("list count varint too long");
}

function itemCount(user, itemId) {
  const item = getMiscItem(user, itemId);
  return item ? BigInt(item.countFree || 0) + BigInt(item.countPaid || 0) : 0n;
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Kill Count packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
