"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createWorldMapHandlers, ensureWorldMapState } = require("../modules/world-map");
const { getMiscItem, setMiscItemBalance, toBigInt } = require("../modules/inventory");
const { readSignedVarInt, readSignedVarLong, writeSignedVarLong, writeBool } = require("../modules/packet-codec");
const { readGameplayTableRecords, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const ROOT = path.resolve(__dirname, "..");
const FIXED_NOW = 638500000000000000n;
const TICKS_PER_DAY = 864000000000n;
const RAID_UID = 986000000000885n;
const ERRORS = Object.freeze({
  OK: 0,
  RAID_NOT_EXIST: 398,
  RAID_EXCEEDED_TRY_COUNT: 401,
  INSUFFICIENT_RESOURCE: 110,
  INVALID_REQUEST: 20191,
  BELOW_BASIS_DAMAGE: 27600,
  RAID_SEASON_END: 27602,
});

const raidTemplet = readGameplayTableRecords("ab_script", "LUA_RAID_TEMPLET.json", { logLabel: "raid-sweep-check" })
  .find((row) => Number(row.m_StageReqItemID) > 0 && Number(row.m_StageReqItemCount) > 0 && Number(row.Raid_Damage_Basis) > 0);
assert(raidTemplet, "frozen raid table must expose a sweep-capable stage");
const seasonId = readGameplayTableRecords("ab_script", "LUA_RAID_SEASON_TEMPLET.json", { logLabel: "raid-sweep-check" })
  .map((row) => Number(row.Raid_Season_ID || 0))
  .filter((id) => id > 0)
  .sort((a, b) => a - b)[0];
assert(seasonId > 0, "frozen raid table must expose a season");

const handler = createWorldMapHandlers().find((entry) => entry.packetId === 885);
assert(handler, "RAID_SWEEP specialist handler must exist");
const user = { userUid: "986000000000085", friendCode: "986000085", nickname: "RaidSweepCheck", level: 100 };
const socket = { session: { user } };
let response = null;
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
  sendResponse(_socket, _sequence, _packetId, build) { build(); },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(reason) {
    assert.strictEqual(reason, "raid-sweep");
    invalidations += 1;
  },
  trackMissionEvent() { return false; },
};

seedRaid();
for (const payload of [Buffer.alloc(0), Buffer.from([0x80]), Buffer.concat([request(false), Buffer.from([0])]), Buffer.concat([writeSignedVarLong(RAID_UID), Buffer.from([2])])]) {
  const before = snapshot(user);
  send(payload, false);
  assertError(ERRORS.INVALID_REQUEST);
  assert.deepStrictEqual(user, before, "malformed sweep requests must be pure");
}
assertWrites(0);

send(Buffer.concat([writeSignedVarLong(999999999999n), writeBool(false)]));
assertError(ERRORS.RAID_NOT_EXIST);
assertWrites(0);

user.worldMap.raids[String(RAID_UID)].seasonID = seasonId + 1;
send(request(false));
assertError(ERRORS.RAID_SEASON_END);
assertWrites(0);
user.worldMap.raids[String(RAID_UID)].seasonID = seasonId;

send(request(true));
assertError(ERRORS.INVALID_REQUEST);
assertWrites(0);

user.worldMap.raidSeason.highestDamage = Number(raidTemplet.Raid_Damage_Basis) - 1;
send(request(false));
assertError(ERRORS.BELOW_BASIS_DAMAGE);
assertWrites(0);

user.worldMap.raidSeason.highestDamage = Number(raidTemplet.Raid_Damage_Basis);
setMiscItemBalance(user, Number(raidTemplet.m_StageReqItemID), 0);
send(request(false));
assertError(ERRORS.INSUFFICIENT_RESOURCE);
assertWrites(0);

const cost = Number(raidTemplet.m_StageReqItemCount);
setMiscItemBalance(user, Number(raidTemplet.m_StageReqItemID), cost + 10);
send(request(false));
assertError(ERRORS.OK);
assert.strictEqual(response.packetId, 886);
const uid = readSignedVarLong(response.payload, readSignedVarInt(response.payload, 0).offset);
assert.strictEqual(uid.value, RAID_UID);
assert.strictEqual(response.payload.readUInt8(uid.offset), 1, "raid result must be non-null");
const initHp = response.payload.readFloatLE(uid.offset + 1);
const curHp = response.payload.readFloatLE(uid.offset + 5);
const damage = response.payload.readFloatLE(uid.offset + 13);
assert.strictEqual(damage, Number(raidTemplet.Raid_Damage_Basis));
assert.strictEqual(curHp, initHp - damage);
assert.strictEqual(Number(user.worldMap.raids[String(RAID_UID)].curHP), curHp);
assert.strictEqual(Number(user.worldMap.raids[String(RAID_UID)].tryCount), 1);
assert.strictEqual(itemCount(Number(raidTemplet.m_StageReqItemID)), 10n);
assertWrites(1);

const successSnapshot = snapshot(user);
send(request(false));
assertError(ERRORS.RAID_EXCEEDED_TRY_COUNT);
assert.deepStrictEqual(user, successSnapshot, "repeat sweep beyond the frozen try limit must be pure");
assertWrites(1);

const restarted = snapshot(user);
assert.strictEqual(Number(restarted.worldMap.raids[String(RAID_UID)].curHP), curHp);
assert.strictEqual(itemCountFrom(restarted, Number(raidTemplet.m_StageReqItemID)), 10n);

validateFrozenSources();
validateManagedSchemas();
console.log(`[raid-sweep-protocol-check] PASS stage=${raidTemplet.m_StageID} season=${seasonId} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function seedRaid() {
  const state = ensureWorldMapState(user, { now: FIXED_NOW });
  const basis = Number(raidTemplet.Raid_Damage_Basis);
  state.raids[String(RAID_UID)] = {
    raidUID: String(RAID_UID),
    stageID: Number(raidTemplet.m_StageID),
    cityID: 1,
    curHP: basis * 3,
    maxHP: basis * 3,
    isCoop: false,
    isNew: false,
    expireDate: String((FIXED_NOW & 0x3fffffffffffffffn) + TICKS_PER_DAY),
    seasonID: seasonId,
    ownerUserUid: user.userUid,
    ownerFriendCode: user.friendCode,
    tryCount: 0,
  };
  state.raidSeason = {
    seasonId,
    monthlyPoint: 0,
    tryAssistCount: 0,
    recvRewardRaidPoint: 0,
    highestDamage: basis,
    latestUpdateTime: String(FIXED_NOW),
  };
}

function request(isTryAssist) {
  return Buffer.concat([writeSignedVarLong(RAID_UID), writeBool(isTryAssist)]);
}

function send(payload, validateRequest = true) {
  response = null;
  if (validateRequest) managedWire.push([885, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: 885, sequence: 1, payload }), true);
  assert(response, "RAID_SWEEP must respond");
}

function assertError(expected) {
  assert.strictEqual(readSignedVarInt(response.payload, 0).value, expected);
}

function assertWrites(expected) {
  assert.strictEqual(saves, expected);
  assert.strictEqual(invalidations, expected);
}

function itemCount(itemId) {
  return itemCountFrom(user, itemId);
}

function itemCountFrom(owner, itemId) {
  const item = getMiscItem(owner, itemId);
  return toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateFrozenSources() {
  const req = read("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_RAID_SWEEP_REQ.cs");
  assert.match(req, /PutOrGet\(ref this\.raidUid\)[\s\S]*PutOrGet\(ref this\.isTryAssist\)/);
  const ack = read("Assembly-CSharp", "ClientPacket", "Game", "NKMPacket_RAID_SWEEP_ACK.cs");
  assert.match(ack, /errorCode[\s\S]*raidUid[\s\S]*raidResultData[\s\S]*costItemDataList[\s\S]*raidDetailData/);
  const ui = read("Assembly-CSharp", "NKC", "UI", "NKCUIRaidRightSide.cs");
  assert.match(ui, /highestDamage < nkmraidTemplet\.RaidDamageBasis[\s\S]*Send_NKMPacket_RAID_SWEEP_REQ/);
  const errors = read("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs");
  assert.match(errors, /NEC_FAIL_RAID_SWEEP_BELOW_BASIS_DAMAGE = 27600,[\s\S]*NEC_FAIL_RAID_SWEEP_RAID_SEASON_END/);
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
      assert(result.ok, `managed schema rejected raid-sweep packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), "utf8");
}
