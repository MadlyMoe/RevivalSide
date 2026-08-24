"use strict";

const assert = require("assert");
const path = require("path");
const { createDeckPipelineHandlers } = require("../modules/deck-pipeline");
const { ensureArmy, grantOperator, grantUnit } = require("../modules/unit");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  buildDeckIndexData,
  readBool,
  readByte,
  readSignedVarInt,
  writeByte,
  writeLongArray,
  writeNullableObject,
  writeSByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "940000000000001",
  nickname: "DeckCheck",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
};
const unitA = grantUnit(user, 1001);
const unitB = grantUnit(user, 1002);
const ship = grantUnit(user, 21001);
const operator = grantOperator(user, 30101);
assert(unitA && unitB && ship && operator, "deck check roster templates must be available");
setMiscItemBalance(user, 101, 1200);

const socket = { session: { user } };
const handlers = new Map(createDeckPipelineHandlers().map((handler) => [handler.packetId, handler]));
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
  sendResponse(target, sequence, packetId, builder) {
    const payload = builder();
    target.response = { sequence, packetId, payload };
    wire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(1606, setReq({ deckType: 1, index: 9 }, 0, unitA.unitUid));
assertAck(1607, 54);
send(1604, int(7));
assertAck(1605, 62);
assert.strictEqual(saves, 0, "failed deck requests must not persist");

send(1604, int(1));
assertAck(1605, 0);
assert.strictEqual(getMiscItem(user, 101).countFree, "600", "deck unlock must spend the displayed resource cost");

send(1606, setReq(deck(0), 0, unitA.unitUid));
assertAck(1607, 0);
send(1606, setReq(deck(1), 0, unitA.unitUid));
assertAck(1607, 0);
let army = ensureArmy(user);
assert.strictEqual(String(army.deckSets["1"][0].unitUids[0]), "0", "normal deck units must move out of their old deck");
assert.strictEqual(String(army.deckSets["1"][1].unitUids[0]), String(unitA.unitUid));

send(1606, setReq(deck(0), 0, 999999999999n));
assertAck(1607, 131);
send(1606, setReq(deck(0), 99, unitB.unitUid));
assertAck(1607, 55);

send(1610, memberReq(deck(0), ship.unitUid));
assertAck(1611, 0);
send(1610, memberReq(deck(1), ship.unitUid));
assertAck(1611, 0);
army = ensureArmy(user);
assert.strictEqual(String(army.deckSets["1"][0].shipUid), "0", "normal deck ships must move out of their old deck");

send(1612, memberReq(deck(0), operator.uid));
assertAck(1613, 0);
send(1612, memberReq(deck(1), operator.uid));
assertAck(1613, 0);
army = ensureArmy(user);
assert.strictEqual(String(army.deckSets["1"][0].operatorUid), "0", "normal deck operators must move out of their old deck");

send(1610, memberReq(deck(0), 999999999999n));
assertAck(1611, 239);
send(1612, memberReq(deck(0), 999999999999n));
assertAck(1613, 20700);

send(1608, autoReq(deck(0), [unitA.unitUid, unitA.unitUid], ship.unitUid, operator.uid));
assertAck(1609, 102);
send(1608, autoReq(deck(0), [unitA.unitUid, unitB.unitUid], ship.unitUid, operator.uid));
assertAck(1609, 0);
army = ensureArmy(user);
assert.deepStrictEqual(army.deckSets["1"][0].unitUids.slice(0, 2).map(String), [String(unitA.unitUid), String(unitB.unitUid)]);
assert.strictEqual(String(army.deckSets["1"][1].unitUids[0]), "0", "auto-set must preserve normal-deck uniqueness");

send(1602, leaderReq(deck(0), 0));
assertAck(1603, 0);
send(1602, leaderReq(deck(0), 7));
assertAck(1603, 57);
send(1600, swapReq(deck(0), 0, 1));
assertAck(1601, 0);

send(1652, nameReq(deck(0), "bad\nname"));
assertAck(1653, 20928);
send(1652, nameReq(deck(0), "Alpha"));
assertAck(1653, 0);

army.deckSets["1"][0].state = 1;
send(1600, swapReq(deck(0), 0, 1));
assertAck(1601, 449);
army.deckSets["1"][0].state = 0;

send(1604, int(1));
assertAck(1605, 0);
send(1604, int(1));
assertAck(1605, 109);
assert.strictEqual(getMiscItem(user, 101).countFree, "0");
assert.strictEqual(saves, 12, "only the twelve successful deck mutations may persist");

const restarted = JSON.parse(JSON.stringify(user));
const restartedArmy = ensureArmy(restarted);
assert.strictEqual(restartedArmy.deckSets["1"].length, 3, "unlocked decks must survive restart serialization");
assert.strictEqual(restartedArmy.deckSets["1"][0].name, "Alpha", "deck names must survive restart serialization");
assert.deepStrictEqual(restartedArmy.deckSets["1"][0].unitUids.slice(0, 2).map(String), [String(unitB.unitUid), String(unitA.unitUid)]);

validateManagedSchemas();
console.log(`[deck-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing deck handler ${packetId}`);
  wire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, expected) {
  assert.strictEqual(socket.response.packetId, packetId, `unexpected ACK for ${packetId}`);
  assert.strictEqual(readErrorCode(packetId, socket.response.payload), expected, `packet ${packetId} error code`);
}

function readErrorCode(packetId, payload) {
  let offset = 0;
  if (packetId === 1609) {
    const present = readBool(payload, offset);
    offset = present.offset;
    if (present.value) {
      offset = readSignedVarInt(payload, offset).offset;
      offset = readByte(payload, offset).offset;
    }
  }
  return readSignedVarInt(payload, offset).value;
}

function deck(index) { return { deckType: 1, index }; }
function int(value) { return writeSignedVarInt(value); }
function deckWire(value) { return writeNullableObject(buildDeckIndexData(value)); }
function setReq(index, slot, uid) { return Buffer.concat([deckWire(index), writeByte(slot), writeSignedVarLong(BigInt(uid))]); }
function memberReq(index, uid) { return Buffer.concat([deckWire(index), writeSignedVarLong(BigInt(uid))]); }
function leaderReq(index, slot) { return Buffer.concat([deckWire(index), writeSByte(slot)]); }
function swapReq(index, from, to) { return Buffer.concat([deckWire(index), writeByte(from), writeByte(to)]); }
function nameReq(index, name) { return Buffer.concat([deckWire(index), writeString(name)]); }
function autoReq(index, units, shipUid, operatorUid) {
  return Buffer.concat([
    deckWire(index), writeLongArray(units), writeSignedVarLong(BigInt(shipUid)), writeSignedVarLong(BigInt(operatorUid)),
  ]);
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
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected deck packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
