const assert = require("node:assert/strict");
const worldMap = require("../modules/world-map");

process.env.CS_WORLDMAP_FORCE_RAID = "1";
process.env.CS_WORLDMAP_ALLOW_EARLY_COMPLETE = "1";

const user = { userUid: "1", inventory: {}, army: {} };
worldMap.ensureWorldMapState(user);
const cityId = worldMap.getWorldMapCityIds(user)[0];

worldMap.startWorldMapMission(user, cityId, 0);
const first = worldMap.completeWorldMapMission(user, cityId);
const raidUid = String(first.worldMapEventGroup.eventUid);
assert.equal(first.isSuccess, true);
assert.notEqual(raidUid, "0");

worldMap.startWorldMapMission(user, cityId, 0);
const second = worldMap.completeWorldMapMission(user, cityId);
assert.equal(second.isSuccess, true);
assert.equal(String(second.worldMapEventGroup.eventUid), raidUid);

const state = worldMap.ensureWorldMapState(user);
assert.equal(String(state.cities[String(cityId)].eventGroup.eventUid), raidUid);
assert.equal(worldMap.getRaidSnapshot(user).activeRaids.some((raid) => String(raid.raidUID) === raidUid), true);

state.raids[raidUid].expireDate = "1";
worldMap.refreshWorldMapState(user);

assert.equal(state.raids[raidUid], undefined);
assert.equal(String(state.cities[String(cityId)].eventGroup.eventUid), "0");
assert.equal(state.pendingRaidEventClearCityIds.includes(cityId), true);
const expiredSnapshot = worldMap.getRaidSnapshot(user);
assert.equal(expiredSnapshot.activeRaids.some((raid) => String(raid.raidUID) === raidUid), false);
assert.equal(expiredSnapshot.resultRaids.some((raid) => String(raid.raidUID) === raidUid), false);

console.log("world-map raid duplicate and linked-expiry guards: ok");
