"use strict";

const assert = require("assert");
const path = require("path");
const { createMissionHandlers } = require("../modules/mission");
const { getRandomMissionDataForTab, trackMissionEvent } = require("../modules/account-progression");
const { setMiscItemBalance, getMiscItem } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "930000000000001",
  friendCode: "7854321",
  nickname: "MissionCheck",
  level: 1,
  exp: "0",
  totalExp: "0",
  completedMissions: {},
  missionCounters: {},
  contentsTags: [],
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  stagePlayData: { "11315": { completed: true } },
};
const socket = { session: { user, gameReplay: { nextServerSequence: 1 } } };
const handlers = new Map(createMissionHandlers().map((handler) => [handler.packetId, handler]));
const pushes = [];
const wireByPacket = new Map();
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
  sendResponse(target, sequence, packetId, builder) {
    const payload = builder();
    target.response = { sequence, packetId, payload };
    wireByPacket.set(packetId, payload);
  },
  sendServerGamePacket(target, packetId, payload) {
    pushes.push({ target, packetId, payload });
    wireByPacket.set(packetId, payload);
  },
  saveUserDb() { saves += 1; },
  getMissionClockOptions() { return {}; },
};

send(1620, ints(1, 100, 100));
assertAck(1621, 0);
assert.strictEqual(user.completedMissions["100"].rewardClaimed, true, "single claim must persist completion state");
const restart = JSON.parse(JSON.stringify(user));
assert.strictEqual(restart.completedMissions["100"].rewardClaimed, true, "claimed mission must survive serialization");

send(1620, ints(1, 100, 100));
assertAck(1621, 272);
send(1620, ints(2, 100, 100));
assertAck(1621, 269);
send(1620, ints(1, 99999999, 99999999));
assertAck(1621, 270);
send(1620, ints(2, 10220, 10220));
assertAck(1621, 271);

trackMissionEvent(user, "USE_RESOURCE", 100000000, { value: 102, resourceId: 102 });
send(1622, ints(40041));
assertAck(1623, 0);
assert.strictEqual(user.completedMissions["40041"].rewardClaimed, false, "on-complete mission must remain repeatable");
assert.strictEqual(user.completedMissions["40041"].times, 0, "on-complete progress must reset after reward");
send(1622, ints(40041));
assertAck(1623, 271);

send(1624, ints(1));
assertAck(1625, 0);
const claimedByAll = Object.values(user.completedMissions).filter((mission) => mission.rewardClaimed === true);
assert(claimedByAll.length >= 3, "complete-all must claim the eligible tutorial-stage mission");
send(1624, ints(1));
assertAck(1625, 20711);
send(1624, ints(999999));
assertAck(1625, 269);

user.contentsTags = ["MISSION_EVENT_PASS"];
setMiscItemBalance(user, 1074, 20);
send(1650, ints(16102, 0));
assertAck(1651, 20362);
send(1650, ints(16102, 25));
assertAck(1651, 20331);
assert.strictEqual(getMiscItem(user, 1074).countFree, "20", "failed donation must not spend inventory");
send(1650, ints(99999999, 1));
assertAck(1651, 270);
send(1650, ints(16102, 5));
assertAck(1651, 0);
assert.strictEqual(getMiscItem(user, 1074).countFree, "15", "successful donation must spend the exact count");
assert(pushes.some((entry) => entry.packetId === 1619), "successful mission mutations must push MISSION_UPDATE_NOT");

user.contentsTags = [];
setMiscItemBalance(user, 101, 40);
let activeRandom = getRandomMissionDataForTab(user, 28);
assert.strictEqual(activeRandom.length, 4, "guild random mission tab must expose its configured display count");
for (let index = 0; index < 3; index += 1) {
  const beforeId = activeRandom[0].missionID;
  send(1626, ints(28, beforeId));
  assertAck(1627, 0);
  activeRandom = getRandomMissionDataForTab(user, 28);
  assert(!activeRandom.some((mission) => mission.missionID === beforeId), "random change must replace the requested mission");
}
assert.strictEqual(user.randomMissions["28"].remainRefreshCount, 0, "free random refreshes must decrement to zero");
const paidBeforeId = activeRandom[0].missionID;
send(1626, ints(28, paidBeforeId));
assertAck(1627, 0);
assert.strictEqual(getMiscItem(user, 101).countFree, "20", "paid random refresh must spend the configured item cost");
setMiscItemBalance(user, 101, 0);
activeRandom = getRandomMissionDataForTab(user, 28);
send(1626, ints(28, activeRandom[0].missionID));
assertAck(1627, 20331);
send(1626, ints(999999, 1));
assertAck(1627, 269);
user.randomMissions["28"].resetKey = "stale-week";
send(1626, ints(28, activeRandom[0].missionID));
assertAck(1627, 22200);
assert(pushes.some((entry) => entry.packetId === 1628), "weekly rollover must push RANDOM_MISSION_REFRESH_NOT");
assert.strictEqual(saves, 9, "only successful claims, donations, rotations, and weekly reset may persist");

validateManagedSchemas();
console.log(`[mission-protocol-check] PASS saves=${saves} pushes=${pushes.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing mission handler ${packetId}`);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(socket.response.packetId, packetId, `unexpected ACK for ${packetId}`);
  assert.strictEqual(readSignedVarInt(socket.response.payload, 0).value, errorCode, `packet ${packetId} error code`);
}

function ints(...values) {
  return Buffer.concat(values.map(writeSignedVarInt));
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
    const requests = new Map([
      [1620, ints(1, 100, 100)],
      [1622, ints(40041)],
      [1624, ints(1)],
      [1626, ints(28, getRandomMissionDataForTab(user, 28)[0].missionID)],
      [1650, ints(16102, 5)],
    ]);
    for (const [packetId, payload] of [...requests, ...wireByPacket].filter(([id]) => [1619, 1620, 1621, 1622, 1623, 1624, 1625, 1626, 1627, 1628, 1650, 1651].includes(id))) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected mission packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
