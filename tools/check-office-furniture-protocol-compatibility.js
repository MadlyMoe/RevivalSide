"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { ensureArmy } = require("../modules/unit");
const {
  readSignedVarInt,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir, readGameplayTableRecords } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const ADD_REQ = 3614;
const UPDATE_REQ = 3616;
const REMOVE_REQ = 3618;
const CLEAR_REQ = 3620;
const handlers = new Map(createOfficeHandlers().map((handler) => [handler.packetId, handler]));
const wire = [];
let saves = 0;
let invalidations = 0;
let failures = 0;
let successes = 0;
const socket = { session: { user: makeUser() } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

const roomRows = readGameplayTableRecords("ab_script", "LUA_OFFICE_ROOM_TEMPLET.json");
const interiorRows = readGameplayTableRecords("ab_script", "LUA_ITEM_INTERIOR_TEMPLET.json");
const room = roomRows.find((row) => row.ID === 1);
const floor = interiorRows.find((row) => row.m_ItemMiscID === 800104);
const wall = interiorRows.find((row) => row.m_ItemMiscID === 800105);
const tile = interiorRows.find((row) => row.m_ItemMiscID === 800111);
assert.deepStrictEqual([room.CellX, room.CellY, room.CellZ], [20, 20, 6]);
assert.deepStrictEqual([floor.Target, floor.CellX, floor.CellY], ["Floor", 4, 2]);
assert.deepStrictEqual([wall.Target, wall.CellX, wall.CellY], ["Wall", 3, 4]);
assert.deepStrictEqual([tile.Target, tile.CellX, tile.CellY], ["Tile", 2, 1]);
for (const packetId of [ADD_REQ, UPDATE_REQ, REMOVE_REQ, CLEAR_REQ]) assert(handlers.has(packetId), `missing Office handler ${packetId}`);

assertFailure(ADD_REQ, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(ADD_REQ, Buffer.from([0x80]), 20191, makeUser(), false);
assertFailure(ADD_REQ, Buffer.concat([addRequest(1, 800104, 0, 0, 0, false), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(ADD_REQ, addRequest(999999, 800104, 0, 0, 0, false), 20847);
assertFailure(ADD_REQ, addRequest(1, 999999, 0, 0, 0, false), 20877);
assertFailure(ADD_REQ, addRequest(1, 800103, 0, 0, 0, false), 20877);
assertFailure(ADD_REQ, addRequest(1, 800104, 0, 0, 0, false), 20878, makeUser({ floorCount: 0 }));
assertFailure(ADD_REQ, addRequest(1, 800104, 1, 0, 0, false), 20795);
assertFailure(ADD_REQ, addRequest(1, 800104, 12, 0, 0, false), 20795);
assertFailure(ADD_REQ, addRequest(1, 800104, 0, -1, 0, false), 20792);
assertFailure(ADD_REQ, addRequest(1, 800104, 0, 17, 0, false), 20792);
assertFailure(ADD_REQ, addRequest(1, 800104, 0, 2, 0, false), 20791, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));
assertFailure(ADD_REQ, addRequest(1, 800104, 0, 0, 0, false), 20793, floorFullUser());

const lifecycle = makeUser();
const beforeAddSaves = saves;
assertSuccess(ADD_REQ, addRequest(1, 800104, 0, 0, 0, false), lifecycle);
let state = ensureOfficeState(lifecycle);
let targetRoom = state.rooms.find((entry) => entry.id === 1);
assert.deepStrictEqual(targetRoom.furnitures, [furniture(1, 800104, 0, 0, 0)]);
assert.strictEqual(interiorCount(lifecycle, 800104), 19n);
assert.strictEqual(state.nextFurnitureUid, "2");
assert.strictEqual(saves, beforeAddSaves + 1);

assertFailure(UPDATE_REQ, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(UPDATE_REQ, Buffer.from([0x80]), 20191, makeUser(), false);
assertFailure(UPDATE_REQ, Buffer.concat([updateRequest(1, 1, 0, 0, 0, false), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(UPDATE_REQ, updateRequest(999999, 1, 0, 0, 0, false), 20847);
assertFailure(UPDATE_REQ, updateRequest(1, 0, 0, 0, 0, false), 20885, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));
assertFailure(UPDATE_REQ, updateRequest(1, 999999, 0, 0, 0, false), 20885, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));
assertFailure(UPDATE_REQ, updateRequest(1, 1, 1, 0, 0, false), 20795, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));
assertFailure(UPDATE_REQ, updateRequest(1, 1, 0, 17, 0, false), 20792, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));
assertFailure(
  UPDATE_REQ,
  updateRequest(1, 1, 0, 5, 0, false),
  20791,
  makeUser({ placements: [furniture(1, 800104, 0, 0, 0), furniture(2, 800104, 0, 6, 0)] })
);

const beforeUpdateSaves = saves;
assertSuccess(UPDATE_REQ, updateRequest(1, 1, 0, 10, 10, true), lifecycle);
state = ensureOfficeState(lifecycle);
targetRoom = state.rooms.find((entry) => entry.id === 1);
assert.deepStrictEqual(targetRoom.furnitures[0], furniture(1, 800104, 0, 10, 10, true));
assert.strictEqual(interiorCount(lifecycle, 800104), 19n);
assert.strictEqual(saves, beforeUpdateSaves + 1);
const beforeNoopSaves = saves;
const beforeNoopInvalidations = invalidations;
assertSuccess(UPDATE_REQ, updateRequest(1, 1, 0, 10, 10, true), lifecycle);
assert.strictEqual(saves, beforeNoopSaves, "an authoritative no-op move must not rewrite the profile");
assert.strictEqual(invalidations, beforeNoopInvalidations, "an authoritative no-op move must not invalidate JOIN");

assertFailure(REMOVE_REQ, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(REMOVE_REQ, Buffer.from([0x80]), 20191, makeUser(), false);
assertFailure(REMOVE_REQ, Buffer.concat([removeRequest(1, 1), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(REMOVE_REQ, removeRequest(999999, 1), 20847);
assertFailure(REMOVE_REQ, removeRequest(1, 0), 20885, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));
assertFailure(REMOVE_REQ, removeRequest(1, 999999), 20885, makeUser({ placements: [furniture(1, 800104, 0, 0, 0)] }));

const beforeRemoveSaves = saves;
assertSuccess(REMOVE_REQ, removeRequest(1, 1), lifecycle);
state = ensureOfficeState(lifecycle);
assert.deepStrictEqual(state.rooms.find((entry) => entry.id === 1).furnitures, []);
assert.strictEqual(interiorCount(lifecycle, 800104), 20n);
assert.strictEqual(saves, beforeRemoveSaves + 1);

assertFailure(CLEAR_REQ, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(CLEAR_REQ, Buffer.from([0x80]), 20191, makeUser(), false);
assertFailure(CLEAR_REQ, Buffer.concat([clearRequest(1), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(CLEAR_REQ, clearRequest(999999), 20847);
const empty = makeUser();
const beforeEmptySaves = saves;
const beforeEmptyInvalidations = invalidations;
assertSuccess(CLEAR_REQ, clearRequest(1), empty);
assert.strictEqual(saves, beforeEmptySaves);
assert.strictEqual(invalidations, beforeEmptyInvalidations);

const clearUser = makeUser({
  placements: [
    furniture(1, 800104, 0, 0, 0),
    furniture(2, 800104, 0, 5, 0),
    furniture(3, 800111, 1, 0, 0),
  ],
});
const beforeClearSaves = saves;
assertSuccess(CLEAR_REQ, clearRequest(1), clearUser);
state = ensureOfficeState(clearUser);
assert.deepStrictEqual(state.rooms.find((entry) => entry.id === 1).furnitures, []);
assert.strictEqual(interiorCount(clearUser, 800104), 20n);
assert.strictEqual(interiorCount(clearUser, 800111), 20n);
assert.strictEqual(saves, beforeClearSaves + 1);

const collision = makeUser({ placements: [furniture(1, 800104, 0, 0, 0)], nextFurnitureUid: "1" });
assertSuccess(ADD_REQ, addRequest(1, 800104, 0, 10, 0, false), collision);
assert.deepStrictEqual(
  ensureOfficeState(collision).rooms.find((entry) => entry.id === 1).furnitures.map((entry) => entry.uid),
  ["1", "2"],
  "server furniture UIDs must remain unique even after legacy next-UID drift"
);

const wallUser = makeUser();
assertSuccess(ADD_REQ, addRequest(1, 800105, 10, 17, 2, true), wallUser);
assert.deepStrictEqual(
  ensureOfficeState(wallUser).rooms.find((entry) => entry.id === 1).furnitures[0],
  furniture(1, 800105, 10, 17, 2, true),
  "wall furniture must use CellX by CellY without inversion"
);
const restarted = JSON.parse(JSON.stringify(wallUser));
ensureArmy(restarted);
ensureOfficeState(restarted);
assert.deepStrictEqual(restarted.office.rooms.find((entry) => entry.id === 1).furnitures, wallUser.office.rooms.find((entry) => entry.id === 1).furnitures);
assert.strictEqual(interiorCount(restarted, 800105), 19n);

assert.strictEqual(saves, invalidations, "every persisted furniture transition must invalidate JOIN exactly once");
validateManagedSchemas();
console.log(`[office-furniture-protocol-check] PASS failures=${failures} successes=${successes} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(options = {}) {
  const user = {
    userUid: "9880000000003614",
    nickname: "Office Owner",
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, squads: {} },
  };
  ensureArmy(user);
  const state = ensureOfficeState(user);
  const targetRoom = state.rooms.find((entry) => entry.id === 1);
  targetRoom.furnitures = (options.placements || []).map((entry) => ({ ...entry }));
  state.nextFurnitureUid = options.nextFurnitureUid || String(Math.max(0, ...targetRoom.furnitures.map((entry) => Number(entry.uid))) + 1);
  const used = new Map();
  for (const entry of targetRoom.furnitures) used.set(entry.itemId, (used.get(entry.itemId) || 0) + 1);
  for (const [itemId, count] of used) setInteriorCount(user, itemId, 20 - count);
  if (options.floorCount != null) setInteriorCount(user, 800104, options.floorCount);
  return user;
}

function floorFullUser() {
  const placements = [];
  for (let index = 0; index < 360; index += 1) {
    placements.push(furniture(index + 1, 800106, 0, index % 20, Math.floor(index / 20)));
  }
  return makeUser({ placements });
}

function furniture(uid, itemId, planeType, positionX, positionY, inverted = false) {
  return { uid: String(uid), itemId, planeType, positionX, positionY, inverted };
}

function setInteriorCount(user, itemId, count) {
  const state = ensureOfficeState(user);
  const interior = state.interiors.find((entry) => entry.itemId === itemId);
  assert(interior, `missing frozen interior ${itemId}`);
  interior.count = String(count);
}

function interiorCount(user, itemId) {
  const interior = ensureOfficeState(user).interiors.find((entry) => entry.itemId === itemId);
  return BigInt(interior && interior.count || 0);
}

function addRequest(roomId, itemId, planeType, positionX, positionY, inverted) {
  return Buffer.concat([
    writeSignedVarInt(roomId),
    writeSignedVarInt(itemId),
    writeSignedVarInt(planeType),
    writeSignedVarInt(positionX),
    writeSignedVarInt(positionY),
    writeBool(inverted),
  ]);
}

function updateRequest(roomId, furnitureUid, planeType, positionX, positionY, inverted) {
  return Buffer.concat([
    writeSignedVarInt(roomId),
    writeSignedVarLong(BigInt(furnitureUid)),
    writeSignedVarInt(planeType),
    writeSignedVarInt(positionX),
    writeSignedVarInt(positionY),
    writeBool(inverted),
  ]);
}

function removeRequest(roomId, furnitureUid) {
  return Buffer.concat([writeSignedVarInt(roomId), writeSignedVarLong(BigInt(furnitureUid))]);
}

function clearRequest(roomId) {
  return writeSignedVarInt(roomId);
}

function send(packetId, payload, user, schemaValid = true) {
  const handler = handlers.get(packetId);
  socket.session.user = user;
  wire.push([packetId, payload, schemaValid]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert.strictEqual(socket.response.packetId, packetId + 1);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function assertFailure(packetId, payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(send(packetId, payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office furniture error ${expectedError} mutated the profile`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  failures += 1;
}

function assertSuccess(packetId, payload, user) {
  assert.strictEqual(send(packetId, payload, user), 0);
  successes += 1;
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
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Office furniture packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
