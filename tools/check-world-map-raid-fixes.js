const assert = require("node:assert/strict");
const worldMap = require("../modules/world-map");
const { grantUnit } = require("../modules/unit");

process.env.CS_WORLDMAP_FORCE_RAID = "1";
process.env.CS_WORLDMAP_ALLOW_EARLY_COMPLETE = "1";

const user = { userUid: "1", inventory: {}, army: {} };
worldMap.ensureWorldMapState(user);
const cityId = worldMap.getWorldMapCityIds(user)[0];
const city = user.worldMap.cities[String(cityId)];
const leader = grantUnit(user, 1001, { level: 120 });
city.leaderUnitUID = String(leader.unitUid);

worldMap.startWorldMapMission(user, cityId, city.mission.stMissionIDList[0]);
const first = worldMap.completeWorldMapMission(user, cityId);
const raidUid = String(first.worldMapEventGroup.eventUid);
assert.equal(first.ok, true);
assert.notEqual(raidUid, "0");

worldMap.startWorldMapMission(user, cityId, city.mission.stMissionIDList[0]);
const second = worldMap.completeWorldMapMission(user, cityId);
assert.equal(second.ok, true);
assert.equal(String(second.worldMapEventGroup.eventUid), raidUid);

console.log("world-map raid duplicate guard: ok");
