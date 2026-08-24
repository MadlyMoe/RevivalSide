"use strict";

const assert = require("assert");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { createEventManager } = require("../modules/event-manager");
const {
  getPlayableOperatorIds,
  getPlayableShipIds,
  getPlayableUnitIds,
  getUnitTemplet,
  isCollectionVisibleUnitId,
} = require("../modules/game-data");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readSignedVarInt,
  writeIntList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const {
  ERRORS,
  PACKETS,
  STATE,
  buildTournamentInfos,
  createTournamentHandlers,
  getTournamentById,
  getTournamentState,
  getUserTournamentState,
  loadCatalog,
  validateDeck,
} = require("../modules/tournament");
const { ensureArmy, grantOperator, grantUnit } = require("../modules/unit");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const tournament = getTournamentById(10003);
const catalog = loadCatalog();
assert(tournament, "frozen Tournament 10003 is required");
assert.strictEqual(catalog.tournaments.length, 9);
assert.strictEqual(createTournamentHandlers().length, 11);

const times = {
  vote: midpoint(tournament.CastingBanInterval),
  apply: midpoint(tournament.DeckEnterInterval),
  bet: midpoint(tournament.GroupBettingInterval_01),
  reward: midpoint(tournament.RewardInterval),
};
assert.strictEqual(getTournamentState(tournament, times.vote), STATE.BAN_VOTE);
assert.strictEqual(getTournamentState(tournament, times.apply), STATE.PRE_BOOKING);
assert.strictEqual(getTournamentState(tournament, times.reward), STATE.CLOSING);

const manager = createEventManager({
  rootDir,
  env: { ...process.env, CS_EVENT_MANAGER: "1", CS_EVENT_DATE: times.apply.toISOString(), CS_EVENT_TABLE_SCAN: "known" },
});
const activeEvents = manager.getActiveEventState(times.apply);
assert(activeEvents.openTags.includes(tournament.OpenTag), "historical Tournament open tag must follow CS_EVENT_DATE");
assert(activeEvents.intervalData.some((entry) => entry.strKey === tournament.TournamentInterval), "Tournament main interval must reach JOIN");
assert(activeEvents.intervalData.some((entry) => entry.strKey === tournament.DeckEnterInterval), "Tournament apply interval must reach JOIN");

const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const specialist = "modules\\tournament\\handlers\\0000-000-tournament.js";
for (const packetId of requestIds()) {
  assert.strictEqual(handlers.get(packetId).fileName, specialist, `Tournament specialist precedence for ${packetId}`);
}

const users = Object.fromEntries([1, 2, 3, 4].map((index) => {
  const user = makeUser(index);
  return [String(user.userUid), user];
}));
const mainUser = users[Object.keys(users)[0]];
const mainSocket = socketFor(mainUser);
let clock = times.apply;
let saves = 0;
let invalidations = 0;
const responses = [];
const wireRequests = [];
const ctx = {
  rootDir,
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => mainUser,
  getServerNowDate: () => clock,
  getEffectiveOpenTags: () => [tournament.OpenTag],
  sendGameResponse(socket, packet, packetId, payload) {
    responses.push({ requestId: packet.packetId, packetId, payload: Buffer.from(payload), userUid: String(socket.session.user.userUid) });
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
};

const pristine = JSON.stringify(mainUser);
invoke(mainSocket, PACKETS.INFO_REQ, Buffer.alloc(0));
assertAck(last(), PACKETS.INFO_ACK, ERRORS.OK);
assert.strictEqual(JSON.stringify(mainUser), pristine, "Tournament info must be read-only before registration");
assert.strictEqual(getUserTournamentState(mainUser, tournament, true), null);

for (const user of Object.values(users)) {
  const deck = deckFor(user);
  assert.strictEqual(validateDeck(user, deck), ERRORS.OK);
  invoke(socketFor(user), PACKETS.APPLY_REQ, deckRequest(deck));
  assertAck(last(), PACKETS.APPLY_ACK, ERRORS.OK);
}
assert.strictEqual(saves, 4);
assert.strictEqual(invalidations, 4);

const duplicateDeck = deckRequest(deckFor(mainUser));
invoke(mainSocket, PACKETS.APPLY_REQ, duplicateDeck);
assertAck(last(), PACKETS.APPLY_ACK, ERRORS.DECK_NOT_MODIFIED);
invoke(mainSocket, PACKETS.APPLY_REQ, Buffer.concat([duplicateDeck, Buffer.from([0])]));
assertAck(last(), PACKETS.APPLY_ACK, ERRORS.INVALID_REQUEST);
assert.strictEqual(saves, 4, "duplicate and malformed Tournament apply must not save");

clock = times.bet;
const infos = buildTournamentInfos(ctx, tournament);
const group = infos.find((entry) => entry.groupIndex === 11);
assert(group && group.slotUserUid.length > 0, "unified Tournament group 11 must contain a local applicant");
const predictedUid = BigInt(group.slotUserUid[0]);
invoke(mainSocket, PACKETS.PRIVATE_INFO_REQ, writeSignedVarInt(tournament.TournamentID));
assertAck(last(), PACKETS.PRIVATE_INFO_ACK, ERRORS.OK);
invoke(mainSocket, PACKETS.PREDICTION_REQ, predictionRequest(tournament.TournamentID, 11, [predictedUid]));
assertAck(last(), PACKETS.PREDICTION_ACK, ERRORS.OK, true);
invoke(mainSocket, PACKETS.STATISTICS_REQ, groupRequest(tournament.TournamentID, 11));
assertAck(last(), PACKETS.STATISTICS_ACK, ERRORS.OK);
assert.strictEqual(saves, 5);

clock = times.vote;
const voteIds = eligibleVotes();
invoke(mainSocket, PACKETS.VOTE_UNIT_REQ, voteRequest(tournament.TournamentID, voteIds.units));
assertAck(last(), PACKETS.VOTE_UNIT_ACK, ERRORS.OK);
invoke(mainSocket, PACKETS.VOTE_SHIP_REQ, voteRequest(tournament.TournamentID, voteIds.ships));
assertAck(last(), PACKETS.VOTE_SHIP_ACK, ERRORS.OK);
const savedAfterVotes = saves;
invoke(mainSocket, PACKETS.VOTE_UNIT_REQ, voteRequest(tournament.TournamentID, voteIds.units));
assertAck(last(), PACKETS.VOTE_UNIT_ACK, ERRORS.OK);
assert.strictEqual(saves, savedAfterVotes, "idempotent Tournament vote must not save");
invoke(mainSocket, PACKETS.VOTE_SHIP_REQ, voteRequest(tournament.TournamentID, [voteIds.ships[0], voteIds.ships[0], voteIds.ships[1]]));
assertAck(last(), PACKETS.VOTE_SHIP_ACK, ERRORS.INVALID_ID);
assert.strictEqual(saves, savedAfterVotes);

clock = times.reward;
invoke(mainSocket, PACKETS.INFO_REQ, Buffer.alloc(0));
assertAck(last(), PACKETS.INFO_ACK, ERRORS.OK);
invoke(mainSocket, PACKETS.RANK_REQ, Buffer.alloc(0));
assertAck(last(), PACKETS.RANK_ACK, ERRORS.OK);
invoke(mainSocket, PACKETS.REPLAY_REQ, replayRequest(tournament.TournamentID, 11, 0));
assertAck(last(), PACKETS.REPLAY_ACK, ERRORS.REPLAY_NOT_EXIST);
invoke(mainSocket, PACKETS.REWARD_INFO_REQ, writeSignedVarInt(tournament.TournamentID));
assertAck(last(), PACKETS.REWARD_INFO_ACK, ERRORS.OK);
const inventoryBefore = JSON.stringify(mainUser.inventory);
invoke(mainSocket, PACKETS.REWARD_REQ, writeSignedVarInt(tournament.TournamentID));
assertAck(last(), PACKETS.REWARD_ACK, ERRORS.OK);
assert.notStrictEqual(JSON.stringify(mainUser.inventory), inventoryBefore, "Tournament rank reward must reach inventory");
const savedAfterReward = saves;
const inventoryAfter = JSON.stringify(mainUser.inventory);
invoke(mainSocket, PACKETS.REWARD_REQ, writeSignedVarInt(tournament.TournamentID));
assertAck(last(), PACKETS.REWARD_ACK, ERRORS.ALREADY_REWARDED);
assert.strictEqual(saves, savedAfterReward);
assert.strictEqual(JSON.stringify(mainUser.inventory), inventoryAfter, "duplicate Tournament reward must be pure");

const nonCanonicalOne = Buffer.from([0x82, 0x00]);
invoke(mainSocket, PACKETS.REWARD_INFO_REQ, nonCanonicalOne);
assertAck(last(), PACKETS.REWARD_INFO_ACK, ERRORS.INVALID_REQUEST);
assert.deepStrictEqual(
  getUserTournamentState(JSON.parse(JSON.stringify(mainUser)), tournament, true),
  getUserTournamentState(mainUser, tournament, true),
  "Tournament state must survive JSON restart"
);

const managedPackets = validateManagedSchemas();
console.log(`[tournament-check] PASS templates=${catalog.tournaments.length} applicants=${Object.keys(users).length} saves=${saves} invalidations=${invalidations} packets=${managedPackets} replayCorpus=absent managed=on`);

function invoke(socket, packetId, payload) {
  wireRequests.push({ packetId, payload: Buffer.from(payload) });
  const entry = handlers.get(packetId);
  assert(entry && entry.handle(ctx, socket, { packetId, sequence: packetId, payload }));
}

function last() {
  assert(responses.length > 0, "missing Tournament response");
  return responses[responses.length - 1];
}

function assertAck(response, packetId, errorCode, errorAtEnd = false) {
  assert.strictEqual(response.packetId, packetId);
  const error = readSignedVarInt(response.payload, 0);
  if (errorAtEnd) {
    const expected = writeSignedVarInt(errorCode);
    assert(response.payload.subarray(-expected.length).equals(expected), `wrong trailing Tournament error for ${packetId}`);
  } else {
    assert.strictEqual(error.value, errorCode, `wrong Tournament error for ${packetId}`);
  }
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for Tournament validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  let count = 0;
  try {
    for (const packet of [{ packetId: PACKETS.INFO_NOT, payload: Buffer.alloc(0) }, ...wireRequests, ...responses]) {
      const result = host.request("validatePacket", {
        packetId: packet.packetId,
        payloadBase64: Buffer.from(packet.payload || []).toString("base64"),
      });
      assert(result.ok, result.error || `managed schema rejected Tournament packet ${packet.packetId}`);
      count += 1;
    }
  } finally {
    host.close();
  }
  return count;
}

function midpoint(intervalId) {
  const row = catalog.intervals.get(intervalId);
  assert(row, `missing Tournament interval ${intervalId}`);
  const start = Date.parse(String(row.m_DateStart).replace(/\.(\d{3})\d*$/, ".$1Z"));
  const end = Date.parse(String(row.m_DateEnd).replace(/\.(\d{3})\d*$/, ".$1Z"));
  assert(Number.isFinite(start) && Number.isFinite(end) && end > start);
  return new Date(start + Math.floor((end - start) / 2));
}

function requestIds() {
  return [
    PACKETS.INFO_REQ, PACKETS.APPLY_REQ, PACKETS.PRIVATE_INFO_REQ, PACKETS.PREDICTION_REQ,
    PACKETS.STATISTICS_REQ, PACKETS.REWARD_REQ, PACKETS.REPLAY_REQ, PACKETS.RANK_REQ,
    PACKETS.REWARD_INFO_REQ, PACKETS.VOTE_UNIT_REQ, PACKETS.VOTE_SHIP_REQ,
  ];
}

function socketFor(user) {
  return { destroyed: false, session: { user } };
}

function makeUser(index) {
  const user = {
    userUid: String(8760000 + index),
    friendCode: String(87600000 + index),
    nickname: `Tournament${index}`,
    level: 100,
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: String(8760000000000n + BigInt(index) * 100n),
  };
  ensureArmy(user);
  user._tournamentUnits = uniqueBaseUnitIds(8).map((id) => grantUnit(user, id, { level: 110 }));
  user._tournamentShip = grantUnit(user, getPlayableShipIds()[0], { level: 120 });
  user._tournamentOperator = grantOperator(user, getPlayableOperatorIds()[0], { level: 100 });
  return user;
}

function deckFor(user) {
  return {
    name: "Tournament",
    shipUid: String(user._tournamentShip.unitUid),
    operatorUid: String(user._tournamentOperator.uid),
    unitUids: user._tournamentUnits.map((unit) => String(unit.unitUid)),
    leaderIndex: 0,
    state: 0,
  };
}

function deckRequest(deck) {
  return Buffer.concat([
    Buffer.from([1]),
    writeString(deck.name),
    writeSignedVarLong(BigInt(deck.shipUid)),
    writeSignedVarLong(BigInt(deck.operatorUid)),
    writeLongList(deck.unitUids.map(BigInt)),
    writeSignedVarInt(deck.leaderIndex),
    writeSignedVarInt(deck.state),
  ]);
}

function predictionRequest(id, group, userUids) {
  return Buffer.concat([writeSignedVarInt(id), writeSignedVarInt(group), writeLongList(userUids)]);
}

function groupRequest(id, group) {
  return Buffer.concat([writeSignedVarInt(id), writeSignedVarInt(group)]);
}

function replayRequest(id, group, slot) {
  return Buffer.concat([writeSignedVarInt(id), writeSignedVarInt(group), writeSignedVarInt(slot)]);
}

function voteRequest(id, values) {
  return Buffer.concat([writeSignedVarInt(id), writeIntList(values)]);
}

function writeLongList(values) {
  return Buffer.concat([writeUnsigned(values.length), ...values.map((value) => writeSignedVarLong(BigInt(value)))]);
}

function writeUnsigned(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) { bytes.push((current & 0x7f) | 0x80); current >>>= 7; }
  bytes.push(current);
  return Buffer.from(bytes);
}

function uniqueBaseUnitIds(count) {
  const result = [];
  const bases = new Set();
  for (const unitId of getPlayableUnitIds()) {
    const template = getUnitTemplet(unitId);
    const baseId = Number(template && template.m_BaseUnitID) || unitId;
    if (bases.has(baseId)) continue;
    bases.add(baseId);
    result.push(unitId);
    if (result.length === count) break;
  }
  assert.strictEqual(result.length, count);
  return result;
}

function eligibleVotes() {
  const units = getPlayableUnitIds({ includeNonContractable: true }).filter(isCollectionVisibleUnitId).slice(0, 3);
  const ships = [];
  for (const shipId of getPlayableShipIds({ includeNonContractable: true })) {
    const template = getUnitTemplet(shipId);
    const groupId = Number(template && template.m_ShipGroupID) || 0;
    if (groupId && isCollectionVisibleUnitId(shipId) && String(template.m_NKM_UNIT_GRADE) === "NUG_SSR" && !ships.includes(groupId)) ships.push(groupId);
    if (ships.length === 3) break;
  }
  assert.strictEqual(units.length, 3);
  assert.strictEqual(ships.length, 3);
  return { units, ships };
}
