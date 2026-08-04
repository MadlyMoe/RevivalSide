"use strict";

const assert = require("assert");
const joinLobby = require("../packet-handlers/0204-join-lobby-req");
const steamLogin = require("../packet-handlers/0231-steam-login-req");
const { buildAttendanceNotifyPayload, claimDailyAttendance } = require("../modules/attendance");

function readVarInt(buffer, start) {
  let offset = start;
  while (offset < buffer.length && (buffer[offset++] & 0x80) !== 0) {}
  assert(offset <= buffer.length, "truncated varint");
  return offset;
}

const user = { userUid: "1", tutorial: { enabled: true, completed: false } };
const replay = {};
let prepared = 0;
let cacheTakes = 0;
let builds = 0;
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true, REPLAY_CAPTURED_GAME_FLOW: true, SEND_FIERCE_SEASON_BOOTSTRAP: false },
  constants: { JOIN_LOBBY_ACK: 205 },
  capturedGameFlow: {},
  decodeJoinLobbyReq: () => ({ accessToken: "token" }),
  findUserByAccessToken: () => user,
  createEphemeralUser: () => ({}),
  prepareUserLobbySession: () => { prepared += 1; return { skipped: true }; },
  shouldUseLocalJoinLobbyAck: () => true,
  takePrewarmedJoinLobbyAckPayload: () => { cacheTakes += 1; return Buffer.from("cached"); },
  buildJoinLobbyAckPayload: () => { builds += 1; return Buffer.from("built"); },
  saveUserDb: () => { saves += 1; },
  sendCapturedGameTemplateRange: () => {},
  sendServerGamePacket: (_socket, packetId, payload) => {
    if (packetId === 205) assert.strictEqual(payload.toString(), "cached");
  },
};

assert.strictEqual(joinLobby.handle(ctx, { session: { gameReplay: replay } }, { payload: Buffer.alloc(0) }), true);
assert.deepStrictEqual({ prepared, cacheTakes, builds, saves }, { prepared: 1, cacheTakes: 1, builds: 0, saves: 0 });

let prewarms = 0;
let loginPreparation;
const loginCtx = {
  config: { USE_LOCAL_USER_DB: true, REPLAY_CAPTURED_LOGIN_ACK: false },
  constants: { LOGIN_ACK: 203 },
  capturedTcpResponses: new Map(),
  capturedTcpProfiles: {},
  decodeSteamLoginReq: () => ({ accessToken: "token" }),
  getOrCreateUserForSteam: () => user,
  issueUserTokens: () => {},
  setLastEffectiveAccessToken: () => {},
  prepareTutorialLogin: () => {},
  prepareUserLobbySession: (_user, options) => { loginPreparation = options; return { skipped: true }; },
  buildLoginAck: () => Buffer.from("login"),
  sendResponse: (_socket, _sequence, _packetId, build) => build(),
  takePrewarmedJoinLobbyAckPayload: () => Buffer.from("cached"),
  prewarmJoinLobbyAckPayload: () => { prewarms += 1; },
};
assert.strictEqual(steamLogin.handle(loginCtx, { session: {} }, { payload: Buffer.alloc(0), sequence: 1 }), true);
assert.strictEqual(prewarms, 0, "Steam login must reuse the launcher-warmed lobby ACK");
assert.strictEqual(loginPreparation.force, undefined, "Steam login must not force a second profile save after launcher warmup");

const attendanceUser = { registeredAt: "2023-06-01T00:00:00.000Z" };
const attendanceNow = new Date("2023-06-01T12:00:00.000Z");
claimDailyAttendance(attendanceUser, { now: attendanceNow, clockNow: attendanceNow });
const attendance = buildAttendanceNotifyPayload(attendanceUser, { now: attendanceNow, clockNow: attendanceNow, force: true });
let offset = readVarInt(attendance, 0); // errorCode
offset = readVarInt(attendance, offset); // lastUpdateDate is a protocol varlong, not a fixed DateTime
const countOffset = offset;
offset = readVarInt(attendance, offset);
assert(attendance[countOffset] > 0, "attendance notification must contain a claimed entry");
for (let index = 0; index < attendance[countOffset]; index += 1) {
  assert.strictEqual(attendance[offset++], 1);
  offset = readVarInt(attendance, offset);
  offset = readVarInt(attendance, offset);
  const date = attendance.readBigInt64LE(offset) & 0x3fffffffffffffffn;
  assert(date <= 3155378975999999999n, "attendance EventEndDate must be a valid DateTime binary");
  offset += 8;
}
assert.strictEqual(offset, attendance.length, "attendance notification must match the frozen packet schema");
console.log("[join-lobby-fast-path] PASS cached JOIN, no duplicate saves, and valid attendance notification framing");
