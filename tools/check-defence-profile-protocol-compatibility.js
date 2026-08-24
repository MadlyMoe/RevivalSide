"use strict";

const assert = require("assert");
const path = require("path");
const { createDefenceProfileHandler, PROFILE_NOT_EXISTS } = require("../modules/defence");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeBool,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const alice = makeUser("1001", "Alice", 100);
const bob = makeUser("1002", "Bob", 200);
const carol = makeUser("1003", "Carol", 300);
bob.friendIntro = "Defence specialist";
bob.profileEmblems = [{ id: 1000001, count: "1" }];
bob.profileDeckIndex = { deckType: 1, index: 0 };
bob.army = {
  units: { "5001": { unitUid: "5001", unitId: 1100, level: 100, skillLevels: [5, 5, 5, 5], equipItemUids: [] } },
  ships: { "6001": { unitUid: "6001", unitId: 26000, level: 100, skillLevels: [] } },
  deckSets: { "1": [{ deckType: 1, index: 0, shipUid: "6001", unitUids: ["5001"], leaderIndex: 0 }] },
};

const userDb = { users: { [alice.userUid]: alice, [bob.userUid]: bob, [carol.userUid]: carol } };
const handler = createDefenceProfileHandler();
const socket = { session: { user: alice } };
const managedPackets = [];
let saves = 0;
const ctx = {
  userDb,
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
  sendResponse(target, _sequence, packetId, build) {
    target.response = { packetId, payload: build() };
    managedPackets.push([packetId, target.response.payload]);
  },
  saveUserDb() { saves += 1; },
};

const before = JSON.stringify(userDb);
send(request("1002", true), true);
const profile = parseSuccess(socket.response.payload);
assert.equal(profile.errorCode, 0);
assert.equal(profile.userUid, "1002");
assert.equal(profile.nickname, "Bob");
assert.equal(profile.friendIntro, "Defence specialist");
assert.equal(profile.defenceId, 1);
assert.equal(profile.bestPoint, 200);
assert.equal(profile.shipId, 26000);
assert.deepStrictEqual(profile.unitIds, [1100]);
assert.equal(profile.operationPower, 100000);
assert.deepStrictEqual(profile.emblems, [{ id: 1000001, count: 1n }]);
assert.equal(profile.rank, 2);
assert.equal(profile.rankPercent, 67);

send(writeSignedVarLong(1002n), false);
assert.equal(readSignedVarInt(socket.response.payload, 0).value, PROFILE_NOT_EXISTS, "truncated request must fail");
send(Buffer.concat([request("9999", false)]), true);
assert.equal(readSignedVarInt(socket.response.payload, 0).value, PROFILE_NOT_EXISTS, "unknown profile must fail");

assert.equal(JSON.stringify(userDb), before, "profile reads must not mutate target or requester");
assert.equal(saves, 0, "profile reads must never save");
validateManagedSchemas();
console.log(`[defence-profile-protocol-check] PASS saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, nickname, bestScore) {
  return {
    userUid,
    friendCode: String(9000 + Number(userUid)),
    nickname,
    level: 50,
    miscStages: { defence: { "1": { defenceTempletId: 1, bestScore } } },
    army: { units: {}, ships: {}, deckSets: {} },
  };
}

function request(userUid, isForce) {
  return Buffer.concat([writeSignedVarLong(BigInt(userUid)), writeBool(isForce)]);
}

function send(payload, validateRequest) {
  if (validateRequest) managedPackets.push([3909, payload]);
  assert.equal(handler.handle(ctx, socket, { packetId: 3909, sequence: 3909, payload }), true);
  assert.equal(socket.response.packetId, 3910);
}

function parseSuccess(payload) {
  const error = readSignedVarInt(payload, 0);
  let offset = error.offset;
  const commonPresent = readBool(payload, offset);
  assert.equal(commonPresent.value, true);
  const common = readCommonProfile(payload, commonPresent.offset);
  offset = common.offset;
  const guildPresent = readBool(payload, offset);
  assert.equal(guildPresent.value, true);
  offset = skipGuildSimple(payload, guildPresent.offset);
  const intro = readString(payload, offset);
  offset = intro.offset;
  const profilePresent = readBool(payload, offset);
  assert.equal(profilePresent.value, true);
  const defenceId = readSignedVarInt(payload, profilePresent.offset);
  const bestPoint = readSignedVarInt(payload, defenceId.offset);
  const deckPresent = readBool(payload, bestPoint.offset);
  assert.equal(deckPresent.value, true);
  const deck = readAsyncDeck(payload, deckPresent.offset);
  const emblems = readObjectList(payload, deck.offset, readEmblem);
  const rank = readSignedVarInt(payload, emblems.offset);
  const percent = readSignedVarInt(payload, rank.offset);
  assert.equal(percent.offset, payload.length, "defence profile ACK must not contain trailing bytes");
  return {
    errorCode: error.value,
    userUid: common.userUid,
    nickname: common.nickname,
    friendIntro: intro.value,
    defenceId: defenceId.value,
    bestPoint: bestPoint.value,
    shipId: deck.shipId,
    unitIds: deck.unitIds,
    operationPower: deck.operationPower,
    emblems: emblems.value,
    rank: rank.value,
    rankPercent: percent.value,
  };
}

function readCommonProfile(payload, startOffset) {
  const uid = readSignedVarLong(payload, startOffset);
  let offset = readSignedVarLong(payload, uid.offset).offset;
  const nickname = readString(payload, offset);
  offset = nickname.offset;
  for (let index = 0; index < 6; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return { userUid: String(uid.value), nickname: nickname.value, offset };
}

function skipGuildSimple(payload, startOffset) {
  let offset = readSignedVarLong(payload, startOffset).offset;
  offset = readString(payload, offset).offset;
  return readSignedVarLong(payload, offset).offset;
}

function readAsyncDeck(payload, startOffset) {
  let offset = readSignedVarInt(payload, startOffset).offset;
  const ship = readAsyncUnit(payload, offset);
  offset = ship.offset;
  const units = readObjectList(payload, offset, readAsyncUnit);
  offset = units.offset;
  const equips = readUnsignedVarInt(payload, offset);
  assert.equal(equips.value, 0, "fixture defence deck has no equipment");
  const power = readSignedVarInt(payload, equips.offset);
  const operatorPresent = readBool(payload, power.offset);
  assert.equal(operatorPresent.value, false);
  const banished = readAsyncUnit(payload, operatorPresent.offset);
  offset = banished.offset;
  offset = readEmptyCollection(payload, offset);
  offset = readEmptyCollection(payload, offset);
  return { shipId: ship.value ? ship.value.unitId : 0, unitIds: units.value.map((unit) => unit.unitId), operationPower: power.value, offset };
}

function readAsyncUnit(payload, startOffset) {
  const present = readBool(payload, startOffset);
  if (!present.value) return { value: null, offset: present.offset };
  let offset = readSignedVarLong(payload, present.offset).offset;
  const unitId = readSignedVarInt(payload, offset);
  offset = unitId.offset;
  for (let index = 0; index < 3; index += 1) offset = readSignedVarInt(payload, offset).offset;
  offset = skipIntList(payload, offset);
  offset = skipIntList(payload, offset);
  offset = skipLongList(payload, offset);
  offset = readEmptyCollection(payload, offset);
  offset = readSignedVarInt(payload, offset).offset;
  offset = readSignedVarInt(payload, offset).offset;
  return { value: { unitId: unitId.value }, offset };
}

function readEmblem(payload, startOffset) {
  const present = readBool(payload, startOffset);
  assert.equal(present.value, true);
  const id = readSignedVarInt(payload, present.offset);
  const count = readSignedVarLong(payload, id.offset);
  return { value: { id: id.value, count: count.value }, offset: count.offset };
}

function readObjectList(payload, startOffset, readEntry) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  const value = [];
  for (let index = 0; index < count.value; index += 1) {
    const entry = readEntry(payload, offset);
    value.push(entry.value);
    offset = entry.offset;
  }
  return { value, offset };
}

function skipIntList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return offset;
}

function skipLongList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarLong(payload, offset).offset;
  return offset;
}

function readEmptyCollection(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  assert.equal(count.value, 0, "fixture nested collection must be empty");
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
      assert(result.ok, `managed client schema rejected Defence profile packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
