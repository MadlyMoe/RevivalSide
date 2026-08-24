"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const {
  DEFENCE_DECK_ERROR,
  decodeDefenceDeckRequest,
} = require("../modules/combat-roster");
const {
  buildDeckData,
  readBool,
  readSignedVarInt,
  writeBool,
  writeNullableObject,
  writeNullObject,
} = require("../modules/packet-codec");
const { ensureArmy, ensureDeck, grantOperator, grantUnit } = require("../modules/unit");
const { getPlayableOperatorIds, getPlayableShipIds, getPlayableUnitIds, getUnitTemplet } = require("../modules/game-data");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(2621);
assert(handler, "UPDATE_DEFENCE_DECK_REQ handler missing");
assert.strictEqual(handler.fileName, "modules\\combat-roster\\handlers\\0000-000-combat-roster-reqs.js");
assert.deepStrictEqual(
  DEFENCE_DECK_ERROR,
  {
    OK: 0,
    NO_SHIP: 57,
    UNIT_INVALID: 58,
    DUPLICATE_UNIT: 59,
    INVALID_GAME_TYPE: 62,
    SEIZED_SHIP: 20319,
    SEIZED_UNIT: 20320,
    NOT_EXIST: 20326,
    NOT_MODIFIED: 20327,
    EMPTY_SLOT: 20328,
    OPERATOR_INVALID: 20700,
    INVALID_REQUEST: 20191,
  },
  "frozen defence-deck error values changed"
);

const user = makeUser();
const socket = { session: { user } };
const managedWire = [];
let response = null;
let saves = 0;
let invalidations = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  createEphemeralUser: () => user,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(_socket, packet, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
  },
};

const army = ensureArmy(user);
const normalDeck = ensureDeck(user, { deckType: 1, index: 0 });
normalDeck.name = "untouched-normal-deck";
const unitIds = uniqueBaseUnitIds(8);
const units = unitIds.map((unitId) => grantUnit(user, unitId, { level: 100 }));
const duplicateBaseUnit = grantUnit(user, unitIds[0], { level: 100 });
const ship = grantUnit(user, getPlayableShipIds()[0], { level: 100 });
const operator = grantOperator(user, getPlayableOperatorIds()[0], { level: 100 });
const deck = {
  deckType: 6,
  index: 0,
  name: "Async Defence",
  shipUid: ship.unitUid,
  operatorUid: operator.uid,
  unitUids: units.map((unit) => unit.unitUid),
  leaderIndex: 2,
  state: 0,
};
const validRequest = writeNullableObject(buildDeckData(deck));

assert.deepStrictEqual(decodeDefenceDeckRequest(validRequest), { valid: true, deck: decodeDefenceDeckRequest(validRequest).deck });
assert.strictEqual(decodeDefenceDeckRequest(Buffer.concat([validRequest, Buffer.from([0])])).valid, false, "trailing data must fail");
assert.strictEqual(decodeDefenceDeckRequest(Buffer.concat([Buffer.from([2]), validRequest.subarray(1)])).valid, false, "noncanonical nullable marker must fail");

failure("truncated deck", validRequest.subarray(0, validRequest.length - 1), DEFENCE_DECK_ERROR.INVALID_REQUEST, false);
failure("trailing deck", Buffer.concat([validRequest, Buffer.from([0])]), DEFENCE_DECK_ERROR.INVALID_REQUEST, false);
failure("noncanonical nullable", Buffer.concat([Buffer.from([2]), validRequest.subarray(1)]), DEFENCE_DECK_ERROR.INVALID_REQUEST, false);
failure("missing deck", writeNullObject(), DEFENCE_DECK_ERROR.NOT_EXIST, true);
failure("empty slot", request({ ...deck, unitUids: [...deck.unitUids.slice(0, 7), 0] }), DEFENCE_DECK_ERROR.EMPTY_SLOT, true);
failure("missing ship", request({ ...deck, shipUid: 999999999n }), DEFENCE_DECK_ERROR.NO_SHIP, true);
failure("missing unit", request({ ...deck, unitUids: [...deck.unitUids.slice(0, 7), 999999998n] }), DEFENCE_DECK_ERROR.UNIT_INVALID, true);
failure("duplicate unit", request({ ...deck, unitUids: [...deck.unitUids.slice(0, 7), deck.unitUids[0]] }), DEFENCE_DECK_ERROR.DUPLICATE_UNIT, true);
failure("duplicate base unit", request({ ...deck, unitUids: [...deck.unitUids.slice(0, 7), duplicateBaseUnit.unitUid] }), DEFENCE_DECK_ERROR.DUPLICATE_UNIT, true);
failure("missing operator", request({ ...deck, operatorUid: 999999997n }), DEFENCE_DECK_ERROR.OPERATOR_INVALID, true);
failure("invalid leader", request({ ...deck, leaderIndex: -1 }), DEFENCE_DECK_ERROR.UNIT_INVALID, true);
failure("busy deck state", request({ ...deck, state: 1 }), DEFENCE_DECK_ERROR.INVALID_GAME_TYPE, true);

user.army.ships[String(deck.shipUid)].isSeized = true;
failure("seized ship", validRequest, DEFENCE_DECK_ERROR.SEIZED_SHIP, true);
delete user.army.ships[String(deck.shipUid)].isSeized;
user.army.units[String(deck.unitUids[3])].isSeized = true;
failure("seized unit", validRequest, DEFENCE_DECK_ERROR.SEIZED_UNIT, true);
delete user.army.units[String(deck.unitUids[3])].isSeized;

invoke(validRequest, true);
assertAck(DEFENCE_DECK_ERROR.OK, validRequest);
assert.deepStrictEqual([saves, invalidations], [1, 1], "successful defence update must save and invalidate JOIN once");
const stored = user.army.deckSets["6"][0];
assert.deepStrictEqual(
  [stored.deckType, stored.index, stored.name, stored.shipUid, stored.operatorUid, stored.leaderIndex, stored.state],
  [6, 0, deck.name, String(deck.shipUid), String(deck.operatorUid), 2, 0]
);
assert.deepStrictEqual(stored.unitUids, deck.unitUids.map(String), "authoritative defence units must persist in order");
assert.strictEqual(user.army.deckSets["1"][0].name, "untouched-normal-deck", "ordinary decks must remain untouched");

failure("not modified", validRequest, DEFENCE_DECK_ERROR.NOT_MODIFIED, true);
assert.deepStrictEqual([saves, invalidations], [1, 1], "no-op defence update must remain save-free");
const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(
  buildDeckData({ ...restarted.army.deckSets["6"][0], deckType: 6 }),
  buildDeckData(stored),
  "defence deck must survive JSON restart"
);

assertFrozenSources();
validateManagedSchemas();
console.log(`[pvp-defence-deck-check] PASS units=${unitIds.length} saves=${saves} packets=${managedWire.length} managed=on`);

function makeUser() {
  const value = {
    userUid: "2621001",
    friendCode: "26210001",
    nickname: "DefenceTester",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [], deckSets: {} },
    nextUnitUid: "2621000000001",
  };
  ensureArmy(value);
  return value;
}

function uniqueBaseUnitIds(count) {
  const selected = [];
  const baseIds = new Set();
  for (const unitId of getPlayableUnitIds()) {
    const templet = getUnitTemplet(unitId);
    const baseId = Number(templet && templet.m_BaseUnitID) || unitId;
    if (baseIds.has(baseId)) continue;
    baseIds.add(baseId);
    selected.push(unitId);
    if (selected.length === count) break;
  }
  assert.strictEqual(selected.length, count, "eight unique-base frozen units are required");
  return selected;
}

function request(value) {
  return writeNullableObject(buildDeckData(value));
}

function invoke(payload, validateRequest) {
  response = null;
  if (validateRequest) managedWire.push([2621, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 2621, sequence: 2621, payload }), true);
  assert(response, "UPDATE_DEFENCE_DECK_REQ must respond");
}

function failure(label, payload, errorCode, validateRequest) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  invoke(payload, validateRequest);
  assertAck(errorCode, writeNullObject());
  assert.strictEqual(JSON.stringify(user), before, `${label} must not mutate profile state`);
  assert.strictEqual(saves, beforeSaves, `${label} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${label} must not invalidate JOIN`);
}

function assertAck(errorCode, deckPayload) {
  assert.strictEqual(response.packetId, 2622);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, errorCode, "defence ACK errorCode");
  assert.deepStrictEqual(response.payload.subarray(error.offset), deckPayload, "defence ACK deckData");
  const present = readBool(response.payload, error.offset);
  assert.strictEqual(present.value, errorCode === DEFENCE_DECK_ERROR.OK, "defence ACK nullability");
}

function assertFrozenSources() {
  const requestSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_UPDATE_DEFENCE_DECK_REQ.cs"), "utf8");
  const ackSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_UPDATE_DEFENCE_DECK_ACK.cs"), "utf8");
  const senderSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "NKCPacketSender.cs"), "utf8");
  const receiverSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  const deckSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKM", "NKMDeckData.cs"), "utf8");
  const validationSource = fs.readFileSync(path.join(rootDir, "Assembly-CSharp", "NKM", "NKMMain.cs"), "utf8");
  assert.match(requestSource, /PutOrGet<NKMDeckData>\(ref this\.deckData\)/);
  assert.match(ackSource, /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)[\s\S]*PutOrGet<NKMDeckData>\(ref this\.deckData\)/);
  assert.match(senderSource, /Send_NKMPacket_UPDATE_DEFENCE_DECK_REQ\(NKMDeckData deckData\)/);
  assert.match(receiverSource, /GetDeckData\(new NKMDeckIndex\(NKM_DECK_TYPE\.NDT_PVP_DEFENCE, 0\)\)[\s\S]*DeepCopyFrom\(sPacket\.deckData\)/);
  assert.match(deckSource, /m_DeckName[\s\S]*m_ShipUID[\s\S]*m_OperatorUID[\s\S]*m_listDeckUnitUID[\s\S]*m_LeaderIndex[\s\S]*m_DeckState/);
  assert.match(validationSource, /CheckHasDuplicateUnit[\s\S]*NEC_FAIL_DECK_DUPLICATE_UNIT[\s\S]*NEC_FAIL_DECK_NO_SHIP[\s\S]*num != 8/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  assert(managedDir, "CounterSide managed directory is required for defence-deck schema validation");
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected defence packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
