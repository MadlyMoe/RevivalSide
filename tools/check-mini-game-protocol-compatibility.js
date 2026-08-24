"use strict";

const assert = require("assert");
const path = require("path");
const {
  PACKETS,
  MINI_GAME_TYPES,
  ERROR_CODES,
  createMiniGameHandlers,
  loadCatalog,
} = require("../modules/mini-game");
const { CONTENT, getContentScore } = require("../modules/score-reward");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const catalog = loadCatalog();
assert.deepStrictEqual([...catalog.templetsById.keys()], [1101, 1102, 1103]);
assert.deepStrictEqual([...catalog.templetsById.values()].map((entry) => entry.type), [20, 20, 20]);

const user = { userUid: "3073001", scoreRewards: { miniGame: [11011, 11012] } };
let socket = { session: { user } };
const handlers = new Map(createMiniGameHandlers().map((handler) => [handler.packetId, handler]));
const managedPackets = [];
let responses = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return payload; },
  saveUserDb() { saves += 1; },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 1);
    responses.push({ packetId, payload });
    managedPackets.push([packetId, payload]);
  },
};

infoFailure("truncated", Buffer.alloc(0), ERROR_CODES.TEMPLET_IS_NULL, false);
infoFailure("trailing", Buffer.concat([infoRequest(20, 1101), Buffer.from([0])]), ERROR_CODES.TEMPLET_IS_NULL, false);
infoFailure("unknown type", infoRequest(10, 1101), ERROR_CODES.TEMPLET_IS_NULL);
infoFailure("unknown template", infoRequest(20, 999999), ERROR_CODES.TEMPLET_IS_NULL);
resultFailure("truncated result", Buffer.alloc(0), ERROR_CODES.INVALID_GAME_INFO, false);
resultFailure("null result", writeBool(false), ERROR_CODES.INVALID_GAME_INFO);
resultFailure(
  "trailing result",
  Buffer.concat([resultRequest(20, 1101, 1, ""), Buffer.from([0])]),
  ERROR_CODES.INVALID_GAME_INFO,
  false
);
resultFailure("null game info", resultRequest(20, 1101, 1, null), ERROR_CODES.INVALID_GAME_INFO);
resultFailure("unknown result template", resultRequest(20, 999999, 1, ""), ERROR_CODES.TEMPLET_IS_NULL);
resultFailure("result type mismatch", resultRequest(10, 1101, 1, ""), ERROR_CODES.TEMPLET_IS_NULL);
resultFailure("game info maximum", resultRequest(20, 1101, 1, "x".repeat(100)), ERROR_CODES.INVALID_GAME_INFO);
resultFailure("zero score", resultRequest(20, 1101, 0, ""), ERROR_CODES.INVALID_SCORE);
resultFailure("missing play history", resultRequest(20, 1101, 1, ""), ERROR_CODES.NOT_PLAYING_HISTORY);
assert.strictEqual(saves, 0, "failures must not save");

send(PACKETS.MINI_GAME_INFO_REQ, infoRequest(MINI_GAME_TYPES.SWORD_TRAINING, 1101));
assert.deepStrictEqual(responses.map((entry) => entry.packetId), [PACKETS.MINI_GAME_INFO_ACK, PACKETS.MINI_GAME_LIST_NOT]);
assert.deepStrictEqual(parseIntList(responses[1].payload, 0).values, [1101, 1102, 1103]);
let info = parseInfoAck(responses[0].payload);
assert.strictEqual(info.errorCode, 0);
assert.deepStrictEqual(info.data, { type: 20, templetId: 1101, score: 0n, gameInfo: "" });
assert.deepStrictEqual(info.rewardIds, [11011, 11012]);
assert.deepStrictEqual(socket.session.miniGamePlaying, { type: 20, templetId: 1101 });
assert.strictEqual(user.miniGames, undefined, "read-only info must not invent persistent state");

send(PACKETS.MINI_GAME_RESULT_REQ, resultRequest(20, 1101, 10, "seed"));
assertResultAck(0);
assert.deepStrictEqual(user.miniGames["1101"], { type: 20, templetId: 1101, score: 10, gameInfo: "seed" });
assert.strictEqual(getContentScore(user, CONTENT.MINI_GAME, 1101), 10, "Score Reward must use the persisted best score");
assert.strictEqual(saves, 1);

resultFailure("equal score", resultRequest(20, 1101, 10, "same"), ERROR_CODES.INVALID_SCORE);
resultFailure("lower score", resultRequest(20, 1101, 9, "lower"), ERROR_CODES.INVALID_SCORE);
send(PACKETS.MINI_GAME_RESULT_REQ, resultRequest(20, 1101, 20, "new-best"));
assertResultAck(0);
assert.strictEqual(user.miniGames["1101"].score, 20);
assert.strictEqual(user.miniGames["1101"].gameInfo, "new-best");

resultFailure("different template history", resultRequest(20, 1102, 5, ""), ERROR_CODES.NOT_PLAYING_HISTORY);
send(PACKETS.MINI_GAME_INFO_REQ, infoRequest(20, 1102));
info = parseInfoAck(responses[0].payload);
assert.deepStrictEqual(info.data, { type: 20, templetId: 1102, score: 0n, gameInfo: "" });
send(PACKETS.MINI_GAME_RESULT_REQ, resultRequest(20, 1102, 5, "round-two"));
assertResultAck(0);
assert.strictEqual(saves, 3, "three higher-score writes must each save once");

const restarted = JSON.parse(JSON.stringify(user));
socket = { session: { user: restarted } };
send(PACKETS.MINI_GAME_INFO_REQ, infoRequest(20, 1101));
info = parseInfoAck(responses[0].payload);
assert.deepStrictEqual(info.data, { type: 20, templetId: 1101, score: 20n, gameInfo: "new-best" });
assert.deepStrictEqual(info.rewardIds, [11011, 11012]);
assert.strictEqual(saves, 3, "restart reconstruction must remain read-only");

validateManagedSchemas();
console.log(
  `[mini-game-protocol-check] PASS saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function infoRequest(type, templetId) {
  return Buffer.concat([writeSignedVarInt(type), writeSignedVarInt(templetId)]);
}

function resultRequest(type, templetId, score, gameInfo) {
  return Buffer.concat([
    writeBool(true),
    writeSignedVarInt(type),
    writeSignedVarInt(templetId),
    writeSignedVarLong(BigInt(score)),
    writeString(gameInfo),
  ]);
}

function send(packetId, payload, validateRequest = true) {
  const handler = handlers.get(packetId);
  assert(handler, `missing Mini Game handler ${packetId}`);
  responses = [];
  if (validateRequest) managedPackets.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(responses.length > 0, `handler ${packetId} must send a response`);
}

function infoFailure(name, payload, expectedError, validateRequest = true) {
  const before = JSON.stringify(user);
  const saveBefore = saves;
  send(PACKETS.MINI_GAME_INFO_REQ, payload, validateRequest);
  assert.strictEqual(responses.length, 1, `${name} must not send the active-list push`);
  const parsed = parseInfoAck(responses[0].payload);
  assert.strictEqual(parsed.errorCode, expectedError, name);
  assert.strictEqual(parsed.data, null, `${name} must return null data`);
  assert.deepStrictEqual(parsed.rewardIds, [], `${name} must return no reward IDs`);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate user state`);
  assert.strictEqual(saves, saveBefore, `${name} must not save`);
}

function resultFailure(name, payload, expectedError, validateRequest = true) {
  const before = JSON.stringify(user);
  const saveBefore = saves;
  send(PACKETS.MINI_GAME_RESULT_REQ, payload, validateRequest);
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(parseResultAck(responses[0].payload), expectedError, name);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate user state`);
  assert.strictEqual(saves, saveBefore, `${name} must not save`);
}

function assertResultAck(expectedError) {
  assert.strictEqual(responses.length, 1);
  assert.strictEqual(responses[0].packetId, PACKETS.MINI_GAME_RESULT_ACK);
  assert.strictEqual(parseResultAck(responses[0].payload), expectedError);
}

function parseInfoAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const present = readBool(payload, error.offset);
  let offset = present.offset;
  let data = null;
  if (present.value) {
    const type = readSignedVarInt(payload, offset);
    const templet = readSignedVarInt(payload, type.offset);
    const score = readSignedVarLong(payload, templet.offset);
    const gameInfo = readString(payload, score.offset);
    offset = gameInfo.offset;
    data = { type: type.value, templetId: templet.value, score: score.value, gameInfo: gameInfo.value };
  }
  const rewards = parseIntList(payload, offset);
  assert.strictEqual(rewards.offset, payload.length, "Mini Game info ACK must have no trailing fields");
  return { errorCode: error.value, data, rewardIds: rewards.values };
}

function parseResultAck(payload) {
  const error = readSignedVarInt(payload, 0);
  assert.strictEqual(error.offset, payload.length, "Mini Game result ACK must have no trailing fields");
  return error.value;
}

function parseIntList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  const values = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const item = readSignedVarInt(payload, offset);
    values.push(item.value);
    offset = item.offset;
  }
  return { values, offset };
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
      assert(result.ok, `managed client schema rejected Mini Game packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
