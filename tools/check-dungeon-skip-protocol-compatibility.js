"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  DUNGEON_SKIP_ERROR_CODES: ERRORS,
  buildDungeonSkipAckPayload,
  createSimulationHandlers,
  executeDungeonSkip,
  validateDungeonSkipRequest,
} = require("../modules/simulation");
const { getMiscItem, spendMiscItem } = require("../modules/inventory");
const {
  readSignedVarInt,
  writeInt64LE,
  writeLongArray,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir, readGameplayTableRecords } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const stages = readGameplayTableRecords("ab_script", "LUA_STAGE_TEMPLET.json", { rootDir });
const dungeons = readGameplayTableRecords("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json", { rootDir });
const stageRow = stages.find(
  (row) => row && row.m_bActiveBattleSkip === true && Number(row.m_StageReqItemID) > 0 && Number(row.m_StageReqItemCount) > 0
);
assert(stageRow, "frozen client must expose an active-battle skip stage");
const dungeonRow = dungeons.find((row) => row && String(row.m_DungeonStrID) === String(stageRow.m_StageBattleStrID));
assert(dungeonRow, "skip stage must resolve its frozen dungeon table row");
assert(Number(dungeonRow.m_RewardMultiplyMax) > 1, "skip stage must support repeated rewards");

const stage = {
  stageId: Number(stageRow.m_StageID),
  dungeonId: Number(dungeonRow.m_DungeonID),
  stageType: String(stageRow.m_StageType),
  activeBattleSkip: stageRow.m_bActiveBattleSkip === true,
  noAutoRepeat: stageRow.m_bNoAutoRepeat === true,
  rewardMultiplyMax: Number(dungeonRow.m_RewardMultiplyMax),
  enterLimit: 0,
  eventDeckId: 0,
  cost: { itemId: Number(stageRow.m_StageReqItemID), count: Number(stageRow.m_StageReqItemCount) },
};
const goodReq = { valid: true, dungeonId: stage.dungeonId, skip: 2, unitUids: ["7001"] };

failure("malformed", createUser(), { ...goodReq, valid: false }, ERRORS.INVALID_REQUEST);
failure("invalid dungeon", createUser(), { ...goodReq, dungeonId: 0 }, ERRORS.INVALID_DUNGEON_ID);
failure("zero count", createUser(), { ...goodReq, skip: 0 }, ERRORS.INVALID_SKIP_COUNT);
failure("over wire maximum", createUser(), { ...goodReq, skip: 100 }, ERRORS.INVALID_SKIP_COUNT);
failure("unsupported stage", createUser(), goodReq, ERRORS.SKIP_NOT_SUPPORTED, { ...stage, activeBattleSkip: false });
failure("uncleared stage", createUser({ cleared: false }), goodReq, ERRORS.NEED_DUNGEON_CLEAR);
failure("missing gold medal", createUser({ missionResult2: false }), goodReq, ERRORS.NEED_GOLD_MEDAL);
failure("duplicate units", createUser(), { ...goodReq, unitUids: ["7001", "7001"] }, ERRORS.INVALID_REQUEST);
failure("foreign units", createUser(), { ...goodReq, unitUids: ["9999"] }, ERRORS.INVALID_REQUEST);
failure("insufficient entry cost", createUser({ balance: stage.cost.count * 2 - 1 }), goodReq, ERRORS.INSUFFICIENT_ITEM);
failure(
  "daily entry limit",
  createUser({ playCount: 2 }),
  goodReq,
  ERRORS.OVER_DAILY_ENTER_LIMIT,
  { ...stage, enterLimit: 3 }
);

const eventDeckUser = createUser();
assert.strictEqual(
  validateDungeonSkipRequest(eventDeckUser, { ...goodReq, unitUids: ["9999"] }, { stage: { ...stage, eventDeckId: 77 } }).errorCode,
  ERRORS.OK,
  "event-deck unit UIDs are server-created and need not exist in the user roster"
);

const user = createUser();
const success = executeDungeonSkip(user, goodReq, {
  stage,
  spendCost(validation) {
    return [spendMiscItem(user, validation.cost.itemId, validation.cost.count * validation.skip)];
  },
  clearOnce(validation, index) {
    user.localSkipClears = Number(user.localSkipClears || 0) + 1;
    const play = user.stagePlayData[String(validation.stage.stageId)];
    play.playCount += 1;
    play.totalPlayCount += 1;
    user.persistedRewards = Array.isArray(user.persistedRewards) ? user.persistedRewards : [];
    user.persistedRewards.push(index + 1);
    return { index: index + 1 };
  },
  buildStagePlayData(validation) {
    return { ...user.stagePlayData[String(validation.stage.stageId)] };
  },
  buildUpdatedUnits(validation) {
    return validation.ownedUnits.map((unit) => ({ unitUid: unit.unitUid, loyalty: unit.loyalty }));
  },
});
assert.strictEqual(success.errorCode, ERRORS.OK);
assert.strictEqual(success.rewardDatas.length, 2);
assert.strictEqual(success.stagePlayData.playCount, 3);
assert.strictEqual(success.stagePlayData.totalPlayCount, 3);
assert.deepStrictEqual(success.updatedUnits, [{ unitUid: "7001", loyalty: 42 }]);
assert.strictEqual(BigInt(getMiscItem(user, stage.cost.itemId).countFree), BigInt(stage.cost.count * 2));
assert.deepStrictEqual(JSON.parse(JSON.stringify(user)).persistedRewards, [1, 2], "skip rewards must survive serialization/restart");

const rollbackUser = createUser();
const rollbackBefore = JSON.parse(JSON.stringify(rollbackUser));
const rollback = executeDungeonSkip(rollbackUser, goodReq, {
  stage,
  spendCost(validation) {
    return [spendMiscItem(rollbackUser, validation.cost.itemId, validation.cost.count * validation.skip)];
  },
  clearOnce(_validation, index) {
    rollbackUser.localSkipClears = index + 1;
    if (index === 1) throw new Error("forced second-clear failure");
    return { index };
  },
  buildStagePlayData() { return {}; },
});
assert.strictEqual(rollback.errorCode, ERRORS.INVALID_REQUEST);
assert.deepStrictEqual(rollbackUser, rollbackBefore, "failed multi-skip must roll back cost and earlier rewards atomically");

checkHandlerDecoding();
checkListenerAuthority();
validateManagedSchemas();
console.log(`[dungeon-skip-protocol-check] PASS managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function createUser(options = {}) {
  const cleared = options.cleared !== false;
  return {
    userUid: "855001",
    inventory: {
      misc: {
        [String(stage.cost.itemId)]: {
          itemId: stage.cost.itemId,
          countFree: String(options.balance == null ? stage.cost.count * 4 : options.balance),
          countPaid: "0",
          regDate: "0",
        },
      },
      equips: {},
      skins: [],
    },
    army: {
      units: {
        "7001": {
          unitUid: "7001",
          userUid: "855001",
          unitId: 1001,
          level: 1,
          exp: 0,
          loyalty: 42,
          statExp: [0, 0, 0, 0, 0, 0],
          skillLevels: [1, 1, 1, 1, 1],
          equipItemUids: [0, 0, 0, 0],
          regDate: "0",
        },
      },
      ships: {},
      trophies: {},
      operators: {},
      decks: [],
      deckSets: {},
    },
    dungeonClear: cleared
      ? {
          [String(stage.dungeonId)]: {
            dungeonId: stage.dungeonId,
            stageId: stage.stageId,
            missionResult1: options.missionResult1 !== false,
            missionResult2: options.missionResult2 !== false,
          },
        }
      : {},
    stagePlayData: {
      [String(stage.stageId)]: {
        stageId: stage.stageId,
        playCount: Number(options.playCount == null ? 1 : options.playCount),
        totalPlayCount: Number(options.playCount == null ? 1 : options.playCount),
      },
    },
  };
}

function failure(label, user, req, errorCode, stageOverride = stage) {
  const before = JSON.parse(JSON.stringify(user));
  const result = executeDungeonSkip(user, req, {
    stage: stageOverride,
    spendCost() { throw new Error(`${label} spent cost`); },
    clearOnce() { throw new Error(`${label} granted rewards`); },
  });
  assert.strictEqual(result.errorCode, errorCode, label);
  assert.deepStrictEqual(user, before, `${label} must not mutate user state`);
}

function checkHandlerDecoding() {
  const handler = createSimulationHandlers().find((entry) => entry.packetId === 855);
  assert(handler, "DUNGEON_SKIP_REQ handler must be registered");
  const socket = { session: { user: createUser() } };
  let sent = null;
  let missionUpdates = 0;
  let decoded = null;
  const ctx = {
    decryptCopy(payload) { return payload; },
    buildDungeonSkipAckPayload(_socket, req) {
      decoded = req;
      return buildDungeonSkipAckPayload(req.valid ? ERRORS.OK : ERRORS.INVALID_REQUEST);
    },
    sendGameResponse(_socket, _packet, packetId, payload) { sent = { packetId, payload }; },
    sendStageClearMissionUpdate() { missionUpdates += 1; },
  };
  const request = Buffer.concat([
    writeSignedVarInt(stage.dungeonId),
    writeSignedVarInt(2),
    writeLongArray([7001n]),
  ]);
  assert.strictEqual(handler.handle(ctx, socket, { sequence: 1, payload: request }), true);
  assert.deepStrictEqual(decoded, { valid: true, dungeonId: stage.dungeonId, skip: 2, unitUids: ["7001"] });
  assert.strictEqual(sent.packetId, 856);
  assert.strictEqual(readSignedVarInt(sent.payload, 0).value, ERRORS.OK);
  assert.strictEqual(missionUpdates, 1);

  handler.handle(ctx, socket, { sequence: 2, payload: Buffer.concat([request, Buffer.from([0])]) });
  assert.strictEqual(decoded.valid, false, "trailing request bytes must be rejected");
  assert.strictEqual(readSignedVarInt(sent.payload, 0).value, ERRORS.INVALID_REQUEST);
  assert.strictEqual(missionUpdates, 1, "failed skip must not emit a mission update");
}

function checkListenerAuthority() {
  const source = fs.readFileSync(path.join(rootDir, "server", "listener.js"), "utf8");
  const start = source.indexOf("function buildDungeonSkipAckPayload");
  const end = source.indexOf("function buildDungeonRewardSet", start);
  assert(start >= 0 && end > start, "listener dungeon-skip authority must exist");
  const body = source.slice(start, end);
  for (const required of [
    "simulation.executeDungeonSkip",
    "spendStageReqItemCost",
    "grantStageClearLoot",
    "grantStageClearExp",
    "recordMainStoryDungeonClearForUser",
    "recordGenericDungeonClearForUser",
    "recordGameplayUnlockClearForUser",
    "trackStageClearMissionProgress",
    "invalidateJoinLobbyAckPayloadCache(\"dungeon-skip\")",
  ]) {
    assert(body.includes(required), `listener dungeon skip must use ${required}`);
  }
  assert.strictEqual((body.match(/saveUserDb\(\)/g) || []).length, 1, "successful skip must persist exactly once");
  assert(!body.includes("clamp(Number(req.skip"), "listener must reject invalid skip counts instead of clamping them");
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    const request = Buffer.concat([
      writeSignedVarInt(stage.dungeonId),
      writeSignedVarInt(2),
      writeLongArray([7001n]),
    ]);
    const stagePlayData = Buffer.concat([
      writeSignedVarInt(stage.stageId),
      writeSignedVarLong(3n),
      writeSignedVarLong(0n),
      writeSignedVarLong(0n),
      writeInt64LE(0n),
      writeSignedVarInt(0),
      writeSignedVarLong(3n),
    ]);
    const packets = [
      [855, request],
      [856, buildDungeonSkipAckPayload(ERRORS.INVALID_REQUEST)],
      [856, buildDungeonSkipAckPayload(ERRORS.OK, { stagePlayData })],
    ];
    for (const [packetId, payload] of packets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected dungeon-skip packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
