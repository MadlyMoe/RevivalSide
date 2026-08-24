"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createWorldMapHandlers, ensureWorldMapState } = require("../modules/world-map");
const { ensureArmy, grantUnit } = require("../modules/unit");
const { grantMiscItem, getMiscItem, toBigInt } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ROOT = path.resolve(__dirname, "..");
const FIXED_NOW = 638500000000000000n;
const TICKS_PER_HOUR = 36000000000n;
const ERRORS = Object.freeze({
  OK: 0,
  CASH: 96,
  CREDIT: 98,
  UNIT_NOT_EXIST: 133,
  UNIT_ALREADY_USE: 138,
  INVALID_CITY: 154,
  CITY_ALREADY_OPEN: 158,
  NO_LEADER: 161,
  MISSION_DOING: 162,
  INVALID_MISSION: 165,
  NO_EVENT: 174,
  BUILD_EXISTS: 387,
  BUILD_MISSING: 388,
  EVENT_NOT_ENDED: 395,
  INVALID_REQUEST: 20191,
  UNIT_SEIZED: 20316,
});

const cityRows = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_CITY_TEMPLET.json", { logLabel: "world-map-check" });
const missionRows = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_MISSION_TEMPLET.json", { logLabel: "world-map-check" });
const buildingRows = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_CITY_BUILDING.json", { logLabel: "world-map-check" });
assert(cityRows.length >= 2, "frozen World Map city table must expose at least two branches");
assert(missionRows.length > 0, "frozen World Map mission table must be loaded");
assert(buildingRows.length > 0, "frozen World Map building table must be loaded");

const handlers = new Map(createWorldMapHandlers().map((entry) => [entry.packetId, entry]));
const packetIds = [2000, 2002, 2004, 2006, 2008, 2010, 2012, 2014, 2018, 2020, 2022, 2024];
for (const packetId of packetIds) assert(handlers.has(packetId), `World Map specialist missing packet ${packetId}`);
assert(!handlers.has(2016), "retired WORLDMAP_COLLECT_REQ must not have a fabricated handler");

const user = {
  userUid: "986000000000099",
  nickname: "WorldMapCheck",
  level: 100,
};
ensureArmy(user);
const leader = grantUnit(user, 1001, { level: 120 });
assert(leader, "World Map checker requires a physical leader unit");
grantMiscItem(user, 1, 10000000, 0, { regDate: String(FIXED_NOW) });
grantMiscItem(user, 3, 1000, 0, { regDate: String(FIXED_NOW) });
grantMiscItem(user, 101, 100000, 0, { regDate: String(FIXED_NOW) });
ensureWorldMapState(user, { now: FIXED_NOW });
const firstCityID = Number(cityRows[0].m_CityID);
const secondCityID = Number(cityRows[1].m_CityID);
const firstCity = () => user.worldMap.cities[String(firstCityID)];
firstCity().level = 10;

const socket = { session: { user } };
let response = null;
let pushes = [];
let saves = 0;
let invalidations = 0;
const managedWire = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow: () => FIXED_NOW,
  decryptCopy: (payload) => payload,
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_socket, _sequence, _packetId, build) {
    build();
  },
  sendServerGamePacket(_socket, packetId, payload) {
    pushes.push({ packetId, payload });
    managedWire.push([packetId, payload]);
  },
  saveUserDb() {
    saves += 1;
  },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.match(reason, /^world-map-\d+$/);
    invalidations += 1;
  },
  trackMissionEvent() {
    return false;
  },
};

verifyStrictFraming();
verifyReadAndBranchLifecycle();
verifyLeaderAndMissionLifecycle();
verifyBuildingLifecycle();
verifyEventLifecycle();
verifyRestart();
validateFrozenSources();
validateManagedSchemas();

console.log(
  `[world-map-check] PASS cities=${cityRows.length} missions=${missionRows.length} buildings=${buildingRows.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFraming() {
  expectPureError(2000, Buffer.from([0]), ERRORS.INVALID_REQUEST);
  expectPureError(2002, Buffer.concat([writeSignedVarInt(secondCityID), Buffer.from([2])]), ERRORS.INVALID_REQUEST);
  for (const [packetId, payload] of [
    [2004, writeSignedVarInt(firstCityID)],
    [2006, writeSignedVarInt(firstCityID)],
    [2008, writeSignedVarInt(firstCityID)],
    [2010, Buffer.concat([writeSignedVarInt(firstCityID), Buffer.from([0])])],
    [2012, Buffer.alloc(0)],
    [2014, Buffer.alloc(0)],
    [2018, writeSignedVarInt(firstCityID)],
    [2020, writeSignedVarInt(firstCityID)],
    [2022, writeSignedVarInt(firstCityID)],
    [2024, Buffer.alloc(0)],
  ]) expectPureError(packetId, payload, ERRORS.INVALID_REQUEST);
  assertWrites(0);
}

function verifyReadAndBranchLifecycle() {
  const before = snapshot(user);
  send(2000, Buffer.alloc(0));
  assertError(ERRORS.OK);
  assert.deepStrictEqual(user, before, "WORLDMAP_INFO_REQ must be read-only");
  assertWrites(0);

  expectPureError(2002, setCityReq(999999, false), ERRORS.INVALID_CITY);
  expectPureError(2002, setCityReq(firstCityID, false), ERRORS.CITY_ALREADY_OPEN);
  send(2002, setCityReq(secondCityID, false));
  assertError(ERRORS.OK);
  assert(user.worldMap.cities[String(secondCityID)], "successful branch opening must persist the exact requested city");
  assertWrites(1);
}

function verifyLeaderAndMissionLifecycle() {
  expectPureError(2004, setLeaderReq(999999, BigInt(leader.unitUid)), ERRORS.INVALID_CITY);
  expectPureError(2004, setLeaderReq(firstCityID, 999999999n), ERRORS.UNIT_NOT_EXIST);
  user.army.units[String(leader.unitUid)].isSeized = true;
  expectPureError(2004, setLeaderReq(firstCityID, BigInt(leader.unitUid)), ERRORS.UNIT_SEIZED);
  user.army.units[String(leader.unitUid)].isSeized = false;

  send(2004, setLeaderReq(firstCityID, BigInt(leader.unitUid)));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().leaderUnitUID, String(leader.unitUid));
  assertWrites(2);
  expectPureError(2004, setLeaderReq(secondCityID, BigInt(leader.unitUid)), ERRORS.UNIT_ALREADY_USE);

  const missionID = Number(firstCity().mission.stMissionIDList[0]);
  assert(missionID > 0 && missionRows.some((row) => Number(row.m_WorldmapMissionID) === missionID));
  expectPureError(2006, missionReq(firstCityID, 999999999), ERRORS.INVALID_MISSION);
  send(2006, missionReq(firstCityID, missionID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().mission.currentMissionID, missionID);
  assertWrites(3);
  expectPureError(2006, missionReq(firstCityID, missionID), ERRORS.MISSION_DOING);
  expectPureError(2008, missionReq(firstCityID, missionID + 1), ERRORS.INVALID_MISSION);

  send(2008, missionReq(firstCityID, missionID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().mission.currentMissionID, 0);
  assertWrites(4);

  const cashBefore = miscCount(3);
  send(2010, writeSignedVarInt(firstCityID));
  assertError(ERRORS.OK);
  assert.strictEqual(cashBefore - miscCount(3), 50n);
  assertWrites(5);

  const completionMissionID = Number(firstCity().mission.stMissionIDList[0]);
  send(2006, missionReq(firstCityID, completionMissionID));
  assertError(ERRORS.OK);
  assertWrites(6);
  firstCity().mission.completeTime = String(FIXED_NOW - 1n);
  send(2012, writeSignedVarInt(firstCityID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().mission.currentMissionID, 0);
  assert(pushes.some((entry) => entry.packetId === 2201), "mission completion must refresh Raid state");
  assertWrites(7);
}

function verifyBuildingLifecycle() {
  const buildRow = buildingRows.find((row) =>
    Number(row.LEVEL) === 1 &&
    Number(row.ID) !== 1 &&
    !Array.isArray(row.listContentsTagAllow) &&
    !Array.isArray(row.listContentsTagIgnore) &&
    !Number(row.REQ_BUILDING_ID || 0) &&
    !Number(row.DIVE_HIGHEST_CLEARED || 0) &&
    !Number(row.NOT_BUILDING_TOGETHER || 0) &&
    Number(row.COST_BUILDING_POINT || 0) <= 1 &&
    buildingRows.some((next) => Number(next.ID) === Number(row.ID) && Number(next.LEVEL) === 2)
  );
  assert(buildRow, "frozen World Map table must expose a basic level-two building path");
  const buildID = Number(buildRow.ID);

  send(2018, buildingReq(firstCityID, buildID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().buildings[String(buildID)].level, 1);
  assertWrites(8);
  expectPureError(2018, buildingReq(firstCityID, buildID), ERRORS.BUILD_EXISTS);

  send(2020, buildingReq(firstCityID, buildID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().buildings[String(buildID)].level, 2);
  assertWrites(9);

  const creditBefore = miscCount(1);
  send(2022, buildingReq(firstCityID, buildID));
  assertError(ERRORS.OK);
  assert(!firstCity().buildings[String(buildID)]);
  assert(miscCount(1) < creditBefore, "building expiry must spend the frozen clear cost instead of granting it");
  assertWrites(10);
  expectPureError(2022, buildingReq(firstCityID, buildID), ERRORS.BUILD_MISSING);
}

function verifyEventLifecycle() {
  firstCity().eventGroup = { worldmapEventID: 1001, eventGroupEndDate: String(FIXED_NOW + TICKS_PER_HOUR), eventUid: "0" };
  expectPureError(2024, writeSignedVarInt(firstCityID), ERRORS.EVENT_NOT_ENDED);
  send(2014, writeSignedVarInt(firstCityID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().eventGroup.worldmapEventID, 0);
  assertWrites(11);
  expectPureError(2014, writeSignedVarInt(firstCityID), ERRORS.NO_EVENT);

  firstCity().eventGroup = { worldmapEventID: 1001, eventGroupEndDate: String(FIXED_NOW - 1n), eventUid: "0" };
  send(2024, writeSignedVarInt(firstCityID));
  assertError(ERRORS.OK);
  assert.strictEqual(firstCity().eventGroup.worldmapEventID, 0);
  assertWrites(12);
}

function verifyRestart() {
  const restarted = snapshot(user);
  assert(restarted.worldMap.cities[String(secondCityID)]);
  assert.strictEqual(restarted.worldMap.cities[String(firstCityID)].leaderUnitUID, String(leader.unitUid));
  assert.strictEqual(restarted.worldMap.cities[String(firstCityID)].mission.currentMissionID, 0);
  assert(!Object.values(restarted.worldMap.cities[String(firstCityID)].buildings).some((entry) => Number(entry.id) !== 1));
}

function send(packetId, payload, validateRequest = true) {
  response = null;
  pushes = [];
  if (validateRequest) managedWire.push([packetId, payload]);
  const handler = handlers.get(packetId);
  assert(handler, `missing World Map handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: 1, payload }), true);
  assert(response, `World Map packet ${packetId} must respond`);
  return response;
}

function expectPureError(packetId, payload, errorCode) {
  const before = snapshot(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  send(packetId, payload, false);
  assertError(errorCode);
  assert.deepStrictEqual(user, before, `failed World Map packet ${packetId} mutated state`);
  assert.strictEqual(saves, beforeSaves, `failed World Map packet ${packetId} saved state`);
  assert.strictEqual(invalidations, beforeInvalidations, `failed World Map packet ${packetId} invalidated JOIN`);
  assert.strictEqual(pushes.length, 0, `failed World Map packet ${packetId} emitted a push`);
  managedWire.push([response.packetId, response.payload]);
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function setCityReq(cityID, isCash) {
  return Buffer.concat([writeSignedVarInt(cityID), writeBool(isCash)]);
}

function setLeaderReq(cityID, unitUID) {
  return Buffer.concat([writeSignedVarInt(cityID), writeSignedVarLong(unitUID)]);
}

function missionReq(cityID, missionID) {
  return Buffer.concat([writeSignedVarInt(cityID), writeSignedVarInt(missionID)]);
}

function buildingReq(cityID, buildID) {
  return Buffer.concat([writeSignedVarInt(cityID), writeSignedVarInt(buildID)]);
}

function miscCount(itemId) {
  const item = getMiscItem(user, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateFrozenSources() {
  assert.match(read("Assembly-CSharp", "NKM", "NKMWorldMapDataEx.cs"), /CanOpenCity[\s\S]*NEC_FAIL_WORLDMAP_CITY_ALREADY_OPENED[\s\S]*NEC_FAIL_WORLDMAP_FULL_AREA/);
  assert.match(read("Assembly-CSharp", "NKM", "NKMWorldMapManager.cs"), /CanSetLeader[\s\S]*NEC_FAIL_UNIT_NOT_EXIST[\s\S]*NEC_FAIL_UNIT_ALREADY_USE/);
  assert.match(read("Assembly-CSharp", "NKM", "NKMWorldMapMissionEx.cs"), /CanStartMission[\s\S]*m_ReqManagerLevel[\s\S]*stMissionIDList\.Contains/);
  assert.match(read("Assembly-CSharp", "NKM", "NKMWorldMapManager.cs"), /CanBuild[\s\S]*reqBuildingPoint[\s\S]*GetUsableBuildPoint/);
  assert.match(read("Assembly-CSharp", "NKM", "NKMWorldMapManager.cs"), /CanExpireBuilding[\s\S]*ClearCostItem\.Count/);
  assert.match(read("Assembly-CSharp", "NKC", "NKC_SCEN_WORLDMAP.cs"), /CheckPrice\(50L, 3\)[\s\S]*WORLDMAP_MISSION_REFRESH_REQ/);
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected World Map packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
