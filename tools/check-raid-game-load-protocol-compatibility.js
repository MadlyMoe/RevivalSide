"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createWorldMapHandlers, ensureWorldMapState, recordRaidBattleResult } = require("../modules/world-map");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const { ensureInventory, getMiscItem, toBigInt } = require("../modules/inventory");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const {
  readSignedVarInt,
  writeBool,
  writeByte,
  writeIntList,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ROOT = path.resolve(__dirname, "..");
const FIXED_NOW = 638500000000000000n;
const TICKS_PER_DAY = 864000000000n;
const RAID_UID = 986000000000802n;
const ERRORS = Object.freeze({
  OK: 0,
  LOAD_FAILED: 95,
  INSUFFICIENT_RESOURCE: 110,
  RAID_NOT_EXIST: 398,
  TRY_LIMIT: 401,
  INVALID_REQUEST: 20191,
});
const raidTemplets = readGameplayTableRecords("ab_script", "LUA_RAID_TEMPLET.json", { logLabel: "raid-load-check" });
const raidTempletsByStage = new Map(raidTemplets.map((row) => [Number(row.m_StageID || 0), row]));
const raidEvent = readGameplayTableRecords("ab_script", "LUA_WORLDMAP_EVENT_GROUP.json", { logLabel: "raid-load-check" })
  .find((row) => String(row.WORLDMAP_EVENT_TYPE) === "WET_RAID" && raidTempletsByStage.has(Number(row.STAGE_ID || 0)));
const raidTemplet = raidEvent && raidTempletsByStage.get(Number(raidEvent.STAGE_ID));
const buffRows = readGameplayTableRecords("ab_script", "LUA_RAID_BUFF_TEMPLET.json", { logLabel: "raid-load-check" });
assert(raidTemplet && buffRows.length === 20, "frozen Raid game-load tables are incomplete");

const handler = new Map(createWorldMapHandlers().map((entry) => [entry.packetId, entry])).get(802);
assert(handler, "world-map specialist must own RAID_GAME_LOAD_REQ 802");
const user = loadUser();
user.worldMap = null;
const state = ensureWorldMapState(user, { now: FIXED_NOW });
state.cities["1"].buildings["12"] = { id: 12, level: 3 };
state.cities["1"].buildings["13"] = { id: 13, level: 1 };
state.raidSeason = {
  seasonId: 1,
  monthlyPoint: 0,
  tryAssistCount: 0,
  recvRewardRaidPoint: 0,
  highestDamage: 0,
  latestUpdateTime: String(FIXED_NOW),
};
seedRaid();
const costItemId = Number(raidTemplet.m_StageReqItemID);
setMiscCount(costItemId, 1000n);

const socket = { session: { user, gameReplay: {} } };
let response = null;
let pushes = [];
let saves = 0;
let invalidations = 0;
let dynamicSucceeds = false;
let dynamicCalls = 0;
let lastDynamic = null;
const managedWire = [];
const ctx = {
  constants: { GAME_LOAD_ACK: 804 },
  config: { DYNAMIC_BATTLE_MANAGER: true, USE_LOCAL_USER_DB: true },
  dateTimeBinaryNow() { return FIXED_NOW; },
  decryptCopy(payload) { return payload; },
  getGenericStageForRequest() { return null; },
  sendDynamicGameLoadAck(_socket, req, stage) {
    dynamicCalls += 1;
    lastDynamic = { req, stage };
    if (!dynamicSucceeds) return false;
    response = { packetId: 804, payload: gameLoadAck(ERRORS.OK) };
    managedWire.push([804, response.payload]);
    return true;
  },
  buildEncryptedPacket(_sequence, packetId, payload) {
    response = { packetId, payload };
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_socket, _sequence, _packetId, build) { build(); },
  sendServerGamePacket(_socket, packetId, payload) {
    pushes.push({ packetId, payload });
    managedWire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "raid-game-load");
    invalidations += 1;
  },
  trackMissionEvent() { return false; },
};

verifyStrictFailures();
verifyAuthorityFailures();
verifyHostFailureRollback();
verifyManagedSuccessAndSettlement();
verifyFrozenSources();
validateManagedRuntime();

console.log(
  `[raid-game-load-check] PASS buffs=${buffRows.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyStrictFailures() {
  const valid = request();
  const nonCanonicalBool = Buffer.from(valid);
  nonCanonicalBool[nonCanonicalBool.length - 2] = 2;
  for (const payload of [
    Buffer.alloc(0),
    valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.from([0])]),
    nonCanonicalBool,
  ]) {
    expectPureError(payload, ERRORS.INVALID_REQUEST, 0);
  }
}

function verifyAuthorityFailures() {
  expectPureError(request({ raidUID: RAID_UID + 99n }), ERRORS.RAID_NOT_EXIST, 0);
  expectPureError(request({ buffList: [1, 1] }), ERRORS.INVALID_REQUEST, 0);
  expectPureError(request({ buffList: [5] }), ERRORS.INVALID_REQUEST, 0);
  expectPureError(request({ supportingUserUid: 1n }), ERRORS.INVALID_REQUEST, 0);
  expectPureError(request({ isTryAssist: true }), ERRORS.INVALID_REQUEST, 0);
  withMutation(() => {
    raidDeck().shipUid = "0";
  }, () => expectPureError(request(), 57, 0));
  withMutation(() => {
    worldMapState().raids[String(RAID_UID)].tryCount = Number(raidTemplet.m_RaidTryCount || 1);
  }, () => expectPureError(request(), ERRORS.TRY_LIMIT, 0));
  withMutation(() => {
    setMiscCount(costItemId, 0n);
  }, () => expectPureError(request({ buffList: [1, 2, 3, 4] }), ERRORS.INSUFFICIENT_RESOURCE, 0));
}

function verifyHostFailureRollback() {
  dynamicSucceeds = false;
  expectPureError(request({ buffList: [1, 2, 3, 4] }), ERRORS.LOAD_FAILED, 1);
}

function verifyManagedSuccessAndSettlement() {
  dynamicSucceeds = true;
  const beforeBalance = miscCount(costItemId);
  const payload = request({ buffList: [1, 2, 3, 4] });
  managedWire.push([802, payload]);
  const savesBefore = saves;
  const invalidationsBefore = invalidations;
  send(payload);
  assert.strictEqual(response.packetId, 804);
  assertError(ERRORS.OK);
  assert(lastDynamic && lastDynamic.req && lastDynamic.stage, "Raid game load must reach the managed host");
  assert.strictEqual(lastDynamic.stage.playerDeck.deckType, 4);
  assert(lastDynamic.stage.playerDeck.units.length > 0, "Raid game load must serialize the selected physical deck");
  assert.deepStrictEqual(lastDynamic.req.buffList, [1, 2, 3, 4]);
  assert.deepStrictEqual(lastDynamic.stage.raidBuffStrIds, ["RAID_BUFF_ATK_3", "RAID_BUFF_HP_3", "RAID_BUFF_SKILL_COOL_TIME_3"]);
  assert.strictEqual(lastDynamic.stage.raidCostChargeRate, 0.1);
  assert.strictEqual(lastDynamic.req.raidCostCount, 279);
  assert.strictEqual(worldMapState().raids[String(RAID_UID)].tryCount, 1);
  assert.strictEqual(saves - savesBefore, 1);
  assert.strictEqual(invalidations - invalidationsBefore, 1);
  assert(pushes.some((packet) => packet.packetId === 2201), "successful Raid load must refresh Raid state");

  const gameUID = String(lastDynamic.req.gameUID);
  const battleKey = `raid:${RAID_UID}:${gameUID}`;
  const result = recordRaidBattleResult(user, RAID_UID, {
    now: FIXED_NOW,
    win: false,
    damage: 1,
    gameUID,
    battleKey,
    buffList: lastDynamic.req.buffList,
    raidCostItemId: lastDynamic.req.raidCostItemId,
    raidCostCount: lastDynamic.req.raidCostCount,
  });
  assert.strictEqual(result.costItems.length, 1);
  assert.strictEqual(beforeBalance - miscCount(costItemId), 279n);
  const duplicate = recordRaidBattleResult(user, RAID_UID, {
    now: FIXED_NOW,
    win: false,
    damage: 1,
    gameUID,
    battleKey,
    buffList: lastDynamic.req.buffList,
    raidCostItemId: lastDynamic.req.raidCostItemId,
    raidCostCount: lastDynamic.req.raidCostCount,
  });
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(duplicate.costItems.length, 0);
  assert.strictEqual(beforeBalance - miscCount(costItemId), 279n);
  const restarted = snapshot(user);
  assert.strictEqual(restarted.worldMap.raids[String(RAID_UID)].tryCount, 1);
  assert.strictEqual(miscCountFrom(restarted, costItemId), miscCount(costItemId));
}

function verifyFrozenSources() {
  assert.match(read("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_RAID_GAME_LOAD_REQ.cs"), /selectDeckIndex[\s\S]*raidUID[\s\S]*buffList[\s\S]*isTryAssist[\s\S]*supportingUserUid/);
  assert.match(read("Assembly-CSharp", "NKC", "NKCPacketSender.cs"), /Send_NKMPacket_RAID_GAME_LOAD_REQ[\s\S]*buffList = _Buffs[\s\S]*isTryAssist = isTryAssist/);
  const ui = read("Assembly-CSharp", "NKC", "UI", "NKCUIRaidRightSide.cs");
  assert.match(ui, /GetCostByCurrSetting[\s\S]*DeclineStageReqItemCount[\s\S]*m_lbEquip4Cost/);
  assert.match(ui, /GetFinalBuffCost[\s\S]*CBS_RAID_DEFENCE_COST_REDUCE_RATE/);
  const gameData = read("Assembly-CSharp", "NKM", "NKMGameData.cs");
  assert.match(gameData, /m_fRespawnCostMinusPercentForTeamA[\s\S]*m_lstTeamABuffStrIDListForRaid/);
  const listener = read("server", "listener.js");
  assert.match(listener, /raidCostItemId[\s\S]*raidCostCount[\s\S]*maybeRecordRaidBattleResultForReplay/);
}

function validateManagedRuntime() {
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
  let battle = null;
  try {
    for (const [packetId, payload] of managedWire) {
      const checked = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(checked.ok, checked.error || `managed client schema rejected Raid game-load packet ${packetId}`);
    }
    const playerDeck = buildPlayerDeckForGameLoad(user, { selectDeckIndex: 0, raidUID: RAID_UID }, {
      deckIndex: { deckType: 4, index: 0 },
      strictSelection: true,
    });
    battle = host.request("startBattle", {
      req: { ...lastDynamic.req, gameUID: undefined },
      stage: { ...lastDynamic.stage, playerDeck },
      gameUID: lastDynamic.req.gameUID,
      gameLoadAckPayloadBase64: "",
    });
    assert(battle.ok && battle.dynamicGame && battle.dynamicGame.managedCombat && battle.payload, battle.error || "managed Raid battle did not start");
    const inspected = host.request("inspectGameLoadAck", { packetId: 804, payloadBase64: battle.payload.toString("base64") });
    assert(inspected.ok, inspected.error || "managed Raid GAME_LOAD_ACK inspection failed");
    assert.match(inspected.summary || "", /gameType=NGT_RAID/);
    assert.match(inspected.summary || "", /raidCostCharge=0\.1/);
    assert.match(inspected.summary || "", /raidBuffs=\[RAID_BUFF_ATK_3,RAID_BUFF_HP_3,RAID_BUFF_SKILL_COOL_TIME_3\]/);
    const schema = host.request("validatePacket", { packetId: 804, payloadBase64: battle.payload.toString("base64") });
    assert(schema.ok, schema.error || "managed client schema rejected authoritative Raid GAME_LOAD_ACK");
  } finally {
    if (battle && battle.dynamicGame) host.request("disposeBattle", { dynamicGame: battle.dynamicGame, battleState: battle.battleState });
    host.close();
  }
}

function request(options = {}) {
  return Buffer.concat([
    writeByte(options.selectDeckIndex == null ? 0 : options.selectDeckIndex),
    writeSignedVarLong(options.raidUID == null ? RAID_UID : options.raidUID),
    writeIntList(options.buffList || []),
    writeBool(Boolean(options.isTryAssist)),
    writeSignedVarLong(options.supportingUserUid || 0n),
  ]);
}

function gameLoadAck(errorCode) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeNullObject(), writeObjectList([])]);
}

function send(payload) {
  response = null;
  pushes = [];
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 802, sequence: 1, payload }), true);
  assert(response, "RAID_GAME_LOAD_REQ must emit GAME_LOAD_ACK");
}

function expectPureError(payload, errorCode, expectedDynamicCalls) {
  const before = snapshot(user);
  const replayBefore = snapshot(socket.session.gameReplay);
  const savesBefore = saves;
  const invalidationsBefore = invalidations;
  const callsBefore = dynamicCalls;
  send(payload);
  assert.strictEqual(response.packetId, 804);
  assertError(errorCode);
  assert.deepStrictEqual(user, before, "failed Raid game load mutated the profile");
  assert.deepStrictEqual(socket.session.gameReplay, replayBefore, "failed Raid game load mutated replay state");
  assert.strictEqual(saves, savesBefore);
  assert.strictEqual(invalidations, invalidationsBefore);
  assert.strictEqual(pushes.length, 0);
  assert.strictEqual(dynamicCalls - callsBefore, expectedDynamicCalls);
}

function withMutation(mutate, check) {
  const before = snapshot(user);
  try {
    mutate();
    check();
  } finally {
    restore(user, before);
  }
}

function seedRaid() {
  const current = worldMapState();
  current.cities["1"].eventGroup = {
    worldmapEventID: Number(raidEvent.EVENT_ID),
    eventGroupEndDate: String((FIXED_NOW & 0x3fffffffffffffffn) + TICKS_PER_DAY),
    eventUid: String(RAID_UID),
  };
  current.raids = {
    [String(RAID_UID)]: {
      raidUID: String(RAID_UID),
      stageID: Number(raidTemplet.m_StageID),
      cityID: 1,
      curHP: 100000,
      maxHP: 100000,
      isCoop: false,
      isNew: false,
      expireDate: String((FIXED_NOW & 0x3fffffffffffffffn) + TICKS_PER_DAY),
      seasonID: Number(current.raidSeason.seasonId),
      ownerUserUid: String(user.userUid),
      ownerFriendCode: String(user.friendCode || user.userUid),
      tryCount: 0,
      tryLimit: Number(raidTemplet.m_RaidTryCount || 1),
      reservedBattleKeys: [],
      accepted: false,
      worldmapEventID: Number(raidEvent.EVENT_ID),
    },
  };
  current.raidResults = {};
}

function worldMapState() {
  return user.worldMap;
}

function raidDeck() {
  return user.army.deckSets["4"][0];
}

function setMiscCount(itemId, count) {
  const inventory = ensureInventory(user);
  inventory.misc[String(itemId)] = { itemId, countFree: String(count), countPaid: "0", regDate: String(FIXED_NOW) };
}

function miscCount(itemId) {
  return miscCountFrom(user, itemId);
}

function miscCountFrom(owner, itemId) {
  const item = getMiscItem(owner, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function loadUser() {
  const db = JSON.parse(fs.readFileSync(path.join(ROOT, "server-data", "users.json"), "utf8"));
  const source = snapshot(Object.values(db.users || {})[0]);
  assert(source && source.userUid && source.army, "Raid game-load check needs a local physical roster");
  return source;
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function restore(target, snapshotValue) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, snapshotValue);
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
