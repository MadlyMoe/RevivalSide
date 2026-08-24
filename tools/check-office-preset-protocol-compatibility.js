"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const {
  readSignedVarInt,
  writeSignedVarInt,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir, readGameplayTable, readGameplayTableRecords } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const PACKETS = Object.freeze({
  REGISTER: 3644,
  APPLY: 3646,
  ADD: 3648,
  NAME: 3650,
  RESET: 3652,
  THEME: 3654,
});
const handlers = new Map(createOfficeHandlers().map((handler) => [handler.packetId, handler]));
const wire = [];
let saves = 0;
let invalidations = 0;
let failures = 0;
let successes = 0;
const socket = { session: { user: null } };
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getEffectiveOpenTags: (tags) => tags,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};

const commonConst = readGameplayTable("ab_script", "LUA_COMMON_CONST.json").globals.Office.OfficeUserPreset;
assert.deepStrictEqual(commonConst, { FREE_PRESET: 3, MAX_PRESET: 20, PRESET_PRICE_QUARTZ: 200 });
const themes = readGameplayTableRecords("ab_script", "LUA_OFFICE_THEMA_PRESET_TEMPLET.json");
assert.strictEqual(themes.length, 19);
for (const packetId of Object.values(PACKETS)) assert(handlers.has(packetId), `missing Office preset handler ${packetId}`);

assertFailure(PACKETS.REGISTER, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(PACKETS.REGISTER, Buffer.concat([pair(1, 0), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(PACKETS.REGISTER, pair(1, 3), 21053);
assertFailure(PACKETS.REGISTER, pair(999999, 0), 20847);
assertFailure(PACKETS.REGISTER, pair(1, 0), 21054);

assertFailure(PACKETS.APPLY, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(PACKETS.APPLY, pair(1, 3), 21053);
assertFailure(PACKETS.APPLY, pair(999999, 0), 20847);
assertFailure(PACKETS.APPLY, pair(1, 0), 21054);

assertFailure(PACKETS.ADD, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(PACKETS.ADD, Buffer.concat([writeSignedVarInt(1), Buffer.from([0])]), 20191, makeUser(), false);
assertFailure(PACKETS.ADD, writeSignedVarInt(0), 21056);
assertFailure(PACKETS.ADD, writeSignedVarInt(18), 21056);
assertFailure(PACKETS.ADD, writeSignedVarInt(1), 96, makeUser({ quartz: 199n }));

assertFailure(PACKETS.NAME, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(PACKETS.NAME, nameRequest(3, "name"), 21053);
assertFailure(PACKETS.NAME, nameRequest(0, "123456789012345678901"), 21055);
assertFailure(PACKETS.NAME, nameRequest(0, "bad\nname"), 21055);
assertFailure(PACKETS.NAME, Buffer.concat([nameRequest(0, "name"), Buffer.from([0])]), 20191, makeUser(), false);

assertFailure(PACKETS.RESET, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(PACKETS.RESET, writeSignedVarInt(3), 21053);
assertFailure(PACKETS.RESET, Buffer.concat([writeSignedVarInt(0), Buffer.from([0])]), 20191, makeUser(), false);

assertFailure(PACKETS.THEME, Buffer.alloc(0), 20191, makeUser(), false);
assertFailure(PACKETS.THEME, pair(999999, 1), 20847, makeUser({ openTags: ["OFFICE_ROOM"] }));
assertFailure(PACKETS.THEME, pair(1, 999999), 21057, makeUser({ openTags: ["OFFICE_ROOM"] }));
assertFailure(PACKETS.THEME, pair(1, 3), 21057, makeUser());

const lifecycle = makeUser({
  placements: [furniture(40, 800104, 0, 0, 0)],
  floorId: 800201,
  wallId: 800205,
  backgroundId: 800801,
});
assertSuccess(PACKETS.NAME, nameRequest(0, "12345678901234567890"), lifecycle);
assert.strictEqual(ensureOfficeState(lifecycle).presets[0].name, "12345678901234567890");
assertSuccess(PACKETS.REGISTER, pair(1, 0), lifecycle);
let preset = ensureOfficeState(lifecycle).presets[0];
assert.strictEqual(preset.name, "12345678901234567890");
assert.deepStrictEqual(preset.furnitures, [furniture(40, 800104, 0, 0, 0)]);
assert.deepStrictEqual([preset.floorInteriorId, preset.wallInteriorId, preset.backgroundId], [800201, 800205, 800801]);

const applyUser = makeUser({
  placements: [furniture(9, 800111, 1, 0, 0)],
  otherPlacements: [furniture(1, 800104, 0, 10, 10)],
  nextFurnitureUid: "1",
});
let state = ensureOfficeState(applyUser);
state.presets[0] = presetData(0, "Full", [
  furniture(90, 800104, 0, 0, 0),
  furniture(91, 800105, 10, 2, 0),
], 800201, 800205, 800801);
setInteriorCount(applyUser, 800104, 1);
setInteriorCount(applyUser, 800105, 1);
setInteriorCount(applyUser, 800111, 19);
assertSuccess(PACKETS.APPLY, pair(1, 0), applyUser);
state = ensureOfficeState(applyUser);
let room = state.rooms.find((entry) => entry.id === 1);
assert.deepStrictEqual(room.furnitures.map((entry) => entry.uid), ["2", "3"], "preset apply must allocate physical collision-free UIDs");
assert.deepStrictEqual(room.furnitures.map((entry) => entry.itemId), [800104, 800105]);
assert.deepStrictEqual([room.floorInteriorId, room.wallInteriorId, room.backgroundId], [800201, 800205, 800801]);
assert.strictEqual(interiorCount(applyUser, 800104), 0n);
assert.strictEqual(interiorCount(applyUser, 800105), 0n);
assert.strictEqual(interiorCount(applyUser, 800111), 20n);

const partial = makeUser();
state = ensureOfficeState(partial);
state.presets[0] = presetData(0, "Partial", [
  furniture(1, 800104, 0, 0, 0),
  furniture(2, 800104, 0, 6, 0),
], 800201, 800205, 800801);
setInteriorCount(partial, 800104, 1);
assertSuccess(PACKETS.APPLY, pair(1, 0), partial);
assert.deepStrictEqual(ensureOfficeState(partial).rooms.find((entry) => entry.id === 1).furnitures.map((entry) => entry.itemId), [800104]);

const expansion = makeUser({ quartzFree: 100n, quartzPaid: 500n });
assertSuccess(PACKETS.ADD, writeSignedVarInt(2), expansion);
assert.strictEqual(ensureOfficeState(expansion).presets.length, 5);
assert.deepStrictEqual(expansion.inventory.misc["101"], {
  itemId: 101,
  countFree: "0",
  countPaid: "200",
  bonusRatio: 0,
  regDate: String(expansion.inventory.misc["101"].regDate),
});

const beforeNoopSaves = saves;
const beforeNoopInvalidations = invalidations;
assertSuccess(PACKETS.NAME, nameRequest(0, ""), expansion);
assert.strictEqual(saves, beforeNoopSaves);
assert.strictEqual(invalidations, beforeNoopInvalidations);

state = ensureOfficeState(lifecycle);
assertSuccess(PACKETS.RESET, writeSignedVarInt(0), lifecycle);
preset = ensureOfficeState(lifecycle).presets[0];
assert.strictEqual(preset.name, "12345678901234567890", "reset must preserve the client-owned slot name");
assert.deepStrictEqual(preset.furnitures, []);
assert.deepStrictEqual([preset.floorInteriorId, preset.wallInteriorId, preset.backgroundId], [0, 0, 0]);

const themeUser = makeUser({ openTags: ["OFFICE_ROOM"] });
assertSuccess(PACKETS.THEME, pair(1, 1), themeUser);
room = ensureOfficeState(themeUser).rooms.find((entry) => entry.id === 1);
assert.deepStrictEqual([room.floorInteriorId, room.wallInteriorId, room.backgroundId], [800402, 800401, 800101]);
assert.strictEqual(room.furnitures.length, 30);
assert.strictEqual(new Set(room.furnitures.map((entry) => entry.uid)).size, 30);

const partialTheme = makeUser({ openTags: ["OFFICE_ROOM"] });
setInteriorCount(partialTheme, 800408, 0);
assertSuccess(PACKETS.THEME, pair(1, 1), partialTheme);
room = ensureOfficeState(partialTheme).rooms.find((entry) => entry.id === 1);
assert.strictEqual(room.furnitures.some((entry) => entry.itemId === 800408), false);
assert(room.furnitures.length < 30 && room.furnitures.length > 0);

const restarted = JSON.parse(JSON.stringify(applyUser));
ensureOfficeState(restarted);
assert.deepStrictEqual(restarted.office.presets, applyUser.office.presets);
assert.deepStrictEqual(restarted.office.rooms, applyUser.office.rooms);
assert.strictEqual(interiorCount(restarted, 800104), 0n);

assert.strictEqual(saves, invalidations, "every persisted Office preset mutation must invalidate JOIN once");
validateManagedSchemas();
console.log(`[office-preset-protocol-check] PASS failures=${failures} successes=${successes} saves=${saves} packets=${wire.length} themes=${themes.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(options = {}) {
  const user = {
    userUid: "9880000000003644",
    nickname: "Office Preset Owner",
    openTags: options.openTags || [],
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
    army: { units: {}, ships: {}, trophies: {}, operators: {}, squads: {} },
  };
  const state = ensureOfficeState(user);
  const room = state.rooms.find((entry) => entry.id === 1);
  room.furnitures = (options.placements || []).map((entry) => ({ ...entry }));
  room.floorInteriorId = options.floorId || room.floorInteriorId;
  room.wallInteriorId = options.wallId || room.wallInteriorId;
  room.backgroundId = options.backgroundId || room.backgroundId;
  const otherRoom = state.rooms.find((entry) => entry.id === 10201);
  otherRoom.furnitures = (options.otherPlacements || []).map((entry) => ({ ...entry }));
  state.nextFurnitureUid = options.nextFurnitureUid || "100";
  for (const placed of [...room.furnitures, ...otherRoom.furnitures]) {
    setInteriorCount(user, placed.itemId, interiorCount(user, placed.itemId) - 1n);
  }
  const quartzFree = options.quartzFree != null ? options.quartzFree : options.quartz != null ? options.quartz : 1000n;
  const quartzPaid = options.quartzPaid != null ? options.quartzPaid : 0n;
  user.inventory.misc["101"] = { itemId: 101, countFree: String(quartzFree), countPaid: String(quartzPaid), bonusRatio: 0, regDate: "0" };
  return user;
}

function presetData(presetId, name, furnitures, floorInteriorId, wallInteriorId, backgroundId) {
  return { presetId, name, furnitures, floorInteriorId, wallInteriorId, backgroundId };
}

function furniture(uid, itemId, planeType, positionX, positionY, inverted = false) {
  return { uid: String(uid), itemId, planeType, positionX, positionY, inverted };
}

function setInteriorCount(user, itemId, count) {
  const state = ensureOfficeState(user);
  const interior = state.interiors.find((entry) => entry.itemId === itemId);
  assert(interior, `missing frozen interior ${itemId}`);
  interior.count = String(BigInt(count));
}

function interiorCount(user, itemId) {
  const interior = ensureOfficeState(user).interiors.find((entry) => entry.itemId === itemId);
  return BigInt(interior && interior.count || 0);
}

function pair(left, right) {
  return Buffer.concat([writeSignedVarInt(left), writeSignedVarInt(right)]);
}

function nameRequest(presetId, name) {
  return Buffer.concat([writeSignedVarInt(presetId), writeString(name)]);
}

function send(packetId, payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([packetId, payload, schemaValid]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  assert.strictEqual(socket.response.packetId, packetId + 1);
  return readSignedVarInt(socket.response.payload).value;
}

function assertFailure(packetId, payload, expectedError, user = makeUser(), schemaValid = true) {
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(send(packetId, payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(user), before, `Office preset error ${expectedError} mutated the profile`);
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
      assert(result.ok, `managed client schema rejected Office preset packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
