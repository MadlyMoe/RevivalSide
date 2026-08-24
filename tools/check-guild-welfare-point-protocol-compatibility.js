"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, ERRORS, loadTables } = require("../modules/company-buff");
const {
  buildRewardData,
  readSignedVarInt,
  readSignedVarLong,
  writeNullableObject,
  writeSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.WELFARE_POINT_REQ);
assert(handler, "guild welfare-point specialist must be registered");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3466-guild-buy-welfare-point-req.js");

const managedPackets = [];
let saves = 0;
let invalidations = 0;
const missionTracks = [];
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 67);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(label) {
    assert.strictEqual(label, "guild-welfare-point-purchase");
    invalidations += 1;
  },
  trackMissionEvent(user, condition, count, details) {
    missionTracks.push({ userUid: user.userUid, condition, count, details });
    return true;
  },
};

verifyFrozenSources();
verifyConfiguration();
verifyFailures();
verifyPurchasesAndRestart();
validateManagedSchemas();

console.log(
  `[guild-welfare-point-check] PASS amount=${loadTables().guildConfig.welfarePointBuyAmount} saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyFailures() {
  const normal = makeUser("6001", { guildUid: 77, points: 0, quartzFree: 100 });
  rejects("truncated", normal, writeSignedVarLong(77n), ERRORS.INVALID_REQUEST, false);
  rejects("trailing", normal, Buffer.concat([request(77n, 5), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  rejects("noncanonical guild", normal, Buffer.concat([Buffer.from([0x9a, 0x81, 0x00]), writeSignedVarInt(5)]), ERRORS.INVALID_REQUEST, false);
  rejects("wrong bundle", normal, request(77n, 10), ERRORS.INVALID_REQUEST);
  rejects("guild mismatch", normal, request(88n, 5), ERRORS.INVALID_GUILD_UID);
  rejects("not a member", makeUser("6002", { guildUid: 0, points: 0, quartzFree: 100 }), request(77n, 5), ERRORS.NOT_A_MEMBER);
  rejects("point cap", makeUser("6003", { guildUid: 77, points: 99996, quartzFree: 100 }), request(77n, 5), ERRORS.WELFARE_POINT_LIMIT);
  rejects("quartz cost", makeUser("6004", { guildUid: 77, points: 0, quartzFree: 29 }), request(77n, 5), ERRORS.INSUFFICIENT_RESOURCE);
}

function verifyPurchasesAndRestart() {
  const user = makeUser("7001", { guildUid: 77, points: 99990, quartzFree: 20, quartzPaid: 40 });
  const socket = { session: { user } };

  managedPackets.push([PACKETS.WELFARE_POINT_REQ, request(77n, 5)]);
  assert.strictEqual(handler.handle(ctx, socket, packet(request(77n, 5))), true);
  let ack = decodeAck(socket.response.payload, true);
  assert.strictEqual(socket.response.packetId, PACKETS.WELFARE_POINT_ACK);
  assert.strictEqual(ack.errorCode, 0);
  assert.strictEqual(ack.guildUid, 77n);
  assert.deepStrictEqual(ack.costItems.map((item) => [item.itemId, item.countFree, item.countPaid]), [[101, 0n, 30n]]);
  assert.strictEqual(user.inventory.misc[23].countFree, "99995");
  assert.strictEqual(user.inventory.misc[101].countFree, "0");
  assert.strictEqual(user.inventory.misc[101].countPaid, "30");
  assert.strictEqual(saves, 1);
  assert.strictEqual(invalidations, 1);
  assert.deepStrictEqual(missionTracks[0], {
    userUid: user.userUid,
    condition: "USE_RESOURCE",
    count: 30,
    details: { itemId: 101, resourceId: 101, value: 101 },
  });

  const restarted = JSON.parse(JSON.stringify(user));
  assert.strictEqual(restarted.inventory.misc[23].countFree, "99995");
  assert.strictEqual(restarted.inventory.misc[101].countPaid, "30");

  managedPackets.push([PACKETS.WELFARE_POINT_REQ, request(77n, 5)]);
  assert.strictEqual(handler.handle(ctx, socket, packet(request(77n, 5))), true);
  ack = decodeAck(socket.response.payload, true);
  assert.deepStrictEqual(ack.costItems.map((item) => [item.itemId, item.countFree, item.countPaid]), [[101, 0n, 0n]]);
  assert.strictEqual(user.inventory.misc[23].countFree, "100000");
  assert.strictEqual(saves, 2);
  assert.strictEqual(invalidations, 2);
  assert.strictEqual(missionTracks.length, 2);

  rejects("post-success cap", user, request(77n, 5), ERRORS.WELFARE_POINT_LIMIT);
}

function rejects(name, user, payload, expectedError, canonical = true) {
  const socket = { session: { user } };
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeTracks = missionTracks.length;
  if (canonical) managedPackets.push([PACKETS.WELFARE_POINT_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true, name);
  assert.strictEqual(socket.response.packetId, PACKETS.WELFARE_POINT_ACK, name);
  const ack = decodeAck(socket.response.payload, false);
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.deepStrictEqual(ack.costItems, [], `${name} cost list`);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate`);
  assert.strictEqual(saves, beforeSaves, `${name} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${name} must not invalidate JOIN`);
  assert.strictEqual(missionTracks.length, beforeTracks, `${name} must not track missions`);
  return ack;
}

function verifyConfiguration() {
  assert.deepStrictEqual(loadTables().guildConfig, {
    creationUserMinLevel: 15,
    creationCosts: [{ itemId: 101, count: 1000 }],
    closingDelayHours: 48,
    attendanceExp: 50,
    dailyDonationCount: 8,
    exitPenaltyHours: 24,
    maxJoinRequestCount: 3,
    maxInviteCount: 30,
    maxRequestReceiveCount: 30,
    maxStaffCount: 5,
    firstJoinReward: {
      itemId: 101,
      count: 100,
      title: "SI_PF_CONSORTIUM_FIRST_JOIN_REWARD_POST_TITLE_TEXT",
      contents: "SI_PF_CONSORTIUM_FIRST_JOIN_REWARD_POST_CONTENTS_TEXT",
      expireDays: 30,
    },
    welfarePointBuyAmount: 5,
    welfarePointBuyLimit: 100000,
    welfarePointPrice: 30,
  });
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BUY_WELFARE_POINT_REQ.cs"), /guildUid[\s\S]*buyCount/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BUY_WELFARE_POINT_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*costItemDataList[\s\S]*rewardData/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyWelfare.cs"), /GetCountMiscItem\(23, true\)[\s\S]*WelfarePointBuyLimit[\s\S]*WelfarePointBuyAmount[\s\S]*WelfarePointPrice[\s\S]*Send_NKMPacket_GUILD_BUY_WELFARE_POINT_REQ/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_BUY_WELFARE_POINT_ACK[\s\S]*UpdateItemInfo[\s\S]*GetReward/);
  assert.match(source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_GUILD_WELFARE_POINT_LIMIT/);
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
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected guild welfare-point packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, options = {}) {
  return {
    userUid,
    guildUid: String(options.guildUid || 0),
    inventory: {
      misc: {
        23: { itemId: 23, countFree: String(options.points || 0), countPaid: "0", bonusRatio: 0, regDate: "0" },
        101: { itemId: 101, countFree: String(options.quartzFree || 0), countPaid: String(options.quartzPaid || 0), bonusRatio: 0, regDate: "0" },
      },
      equips: {},
      skins: [],
    },
  };
}

function request(guildUid, buyCount) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarInt(buyCount)]);
}

function packet(payload) {
  return { packetId: PACKETS.WELFARE_POINT_REQ, sequence: 67, payload };
}

function decodeAck(payload, success) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  const count = readUnsignedVarInt(payload, field.offset);
  let offset = count.offset;
  const costItems = [];
  for (let index = 0; index < count.value; index += 1) {
    assert.strictEqual(payload.readUInt8(offset++), 1);
    const itemId = readSignedVarInt(payload, offset); offset = itemId.offset;
    const countFree = readSignedVarLong(payload, offset); offset = countFree.offset;
    const countPaid = readSignedVarLong(payload, offset); offset = countPaid.offset;
    const bonusRatio = readSignedVarInt(payload, offset); offset = bonusRatio.offset;
    const regDate = payload.readBigInt64LE(offset); offset += 8;
    costItems.push({ itemId: itemId.value, countFree: countFree.value, countPaid: countPaid.value, bonusRatio: bonusRatio.value, regDate });
  }
  const reward = success
    ? writeNullableObject(buildRewardData({ miscItems: [{ itemId: 23, countFree: "5", countPaid: "0", bonusRatio: 0, regDate: "0" }] }))
    : Buffer.from([0]);
  assert(payload.subarray(offset, offset + reward.length).equals(reward), "welfare-point rewardData schema");
  offset += reward.length;
  assert.strictEqual(offset, payload.length);
  return { errorCode, guildUid, costItems };
}

function readUnsignedVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (shift < 35) {
    assert(offset < buffer.length, "truncated unsigned varint");
    const byte = buffer.readUInt8(offset++);
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("unsigned varint too long");
}
