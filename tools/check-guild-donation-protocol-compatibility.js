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
const { dateTimeBinaryForDate } = require("../modules/server-time");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const handler = handlers.get(PACKETS.DONATION_REQ);
assert(handler, "guild donation specialist must be registered");
assert.strictEqual(handler.fileName, "modules\\company-buff\\handlers\\0000-3461-guild-donation-req.js");

const NOW = new Date("2026-08-20T12:00:00.000Z");
let now = new Date(NOW);
const managedPackets = [];
const missionEvents = [];
let saves = 0;
let invalidations = 0;
const users = {
  "8101": makeUser("8101", { guildUid: 77, guildLevel: 1, guildLevelExp: 1995, unionPoint: 100, item1: 100000, item21: 1000, item101: 500 }),
  "8102": makeUser("8102", { guildUid: 77, guildLevel: 1, guildLevelExp: 1995, unionPoint: 100 }),
  "8201": makeUser("8201", { guildUid: 88, guildLevel: 4, guildLevelExp: 700, unionPoint: 900 }),
};
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  getServerNowDate() { return new Date(now); },
  dateTimeBinaryNow() { return dateTimeBinaryForDate(now); },
  sendGameResponse(socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 68);
    socket.response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(label) {
    assert.strictEqual(label, "guild-donation");
    invalidations += 1;
  },
  trackMissionEvent(user, condition, amount, details) {
    missionEvents.push({ userUid: user.userUid, condition, amount, details });
    return true;
  },
};

verifyFrozenSources();
verifyTables();
verifyFailures();
verifyDonationLifecycle();
validateManagedSchemas();

console.log(
  `[guild-donation-check] PASS rows=${loadTables().donationById.size} saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyTables() {
  const tables = loadTables();
  assert.strictEqual(tables.guildConfig.dailyDonationCount, 8);
  assert.strictEqual(tables.donationById.size, 3);
  assert.deepStrictEqual(
    [...tables.donationById.values()].map((row) => [row.id, row.costItemId, row.costValue, row.guildExp, row.unionPoint]),
    [[1, 21, 100, 10, 10], [2, 1, 30000, 20, 20], [3, 101, 100, 50, 40]]
  );
  assert.strictEqual(tables.guildExpRows.length, 20);
  assert.deepStrictEqual(tables.guildExpRows.slice(0, 2), [
    { level: 1, required: 2000, maxMemberCount: 20 },
    { level: 2, required: 3500, maxMemberCount: 20 },
  ]);
  assert.strictEqual(ERRORS.INSUFFICIENT_RESOURCE, 110);
}

function verifyFailures() {
  const normal = makeUser("8301", { guildUid: 77, item1: 100000 });
  rejects("truncated", normal, Buffer.concat([writeSignedVarLong(77n), writeSignedVarInt(2)]), ERRORS.INVALID_REQUEST, false);
  rejects("trailing", normal, Buffer.concat([request(77n, 2, 1), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  rejects("noncanonical guild", normal, Buffer.concat([Buffer.from([0x9a, 0x81, 0x00]), writeSignedVarInt(2), writeSignedVarInt(1)]), ERRORS.INVALID_REQUEST, false);
  rejects("guild mismatch", normal, request(88n, 2, 1), ERRORS.INVALID_GUILD_UID);
  rejects("not a member", makeUser("8302", { guildUid: 0, item1: 100000 }), request(77n, 2, 1), ERRORS.NOT_A_MEMBER);
  rejects("invalid donation id", normal, request(77n, 999, 1), ERRORS.INVALID_DONATION_ID);
  rejects("zero count", normal, request(77n, 2, 0), ERRORS.INVALID_DONATION_COUNT);
  rejects("negative count", normal, request(77n, 2, -1), ERRORS.INVALID_DONATION_COUNT);
  rejects("above daily bound", normal, request(77n, 2, 9), ERRORS.INVALID_DONATION_COUNT);
  rejects("insufficient resource", makeUser("8303", { guildUid: 77, item1: 29999 }), request(77n, 2, 1), ERRORS.INSUFFICIENT_RESOURCE);
  rejects(
    "same-day guild join",
    makeUser("8304", { guildUid: 77, item1: 100000, guildMemberCreatedAt: "2026-08-20T05:00:00.000Z" }),
    request(77n, 2, 1),
    ERRORS.DONATION_JOIN_DATE_LIMIT
  );
  const limited = makeUser("8305", { guildUid: 77, item1: 100000, donationCount: 7, donationDate: dateTimeBinaryForDate(now), donationResetKey: "2026-08-20" });
  rejects("daily limit", limited, request(77n, 2, 2), ERRORS.DONATION_DAILY_LIMIT);
}

function verifyDonationLifecycle() {
  const user = users["8101"];
  const mate = users["8102"];
  let ack = succeeds(user, request(77n, 2, 2), {
    rewardItems: [{ itemId: 21, countFree: 100n, countPaid: 0n }],
    guildExpDelta: 40n,
    unionPointDelta: 40n,
  });
  assert.strictEqual(ack.donationCount, 2);
  assert.strictEqual(ack.lastDailyResetDate, dateTimeBinaryForDate(now));
  assert.deepStrictEqual(ack.costItems.map(itemTuple), [[1, 40000n, 0n]]);
  assert.strictEqual(user.inventory.misc[1].countFree, "40000");
  assert.strictEqual(user.inventory.misc[21].countFree, "1100");
  assert.strictEqual(user.guildUnionPoint, "140");
  assert.strictEqual(mate.guildUnionPoint, "140");
  assert.deepStrictEqual([user.guildLevel, user.guildLevelExp], [2, "35"]);
  assert.deepStrictEqual([mate.guildLevel, mate.guildLevelExp], [2, "35"]);
  assert.deepStrictEqual([user.guildWeeklyContributionPoint, user.guildTotalContributionPoint], ["40", "40"]);
  assert.deepStrictEqual(missionEvents.slice(-2).map((event) => [event.condition, event.amount, event.details.value]), [
    ["USE_RESOURCE", 60000, 1],
    ["GUILD_DONATE", 2, 2],
  ]);

  ack = succeeds(user, request(77n, 1, 6), {
    rewardItems: [],
    guildExpDelta: 60n,
    unionPointDelta: 60n,
  });
  assert.strictEqual(ack.donationCount, 8);
  assert.deepStrictEqual(ack.costItems.map(itemTuple), [[21, 500n, 0n]]);
  assert.strictEqual(user.guildUnionPoint, "200");
  assert.strictEqual(user.guildLevelExp, "95");
  rejects("exhausted day", user, request(77n, 3, 1), ERRORS.DONATION_DAILY_LIMIT);

  const restarted = JSON.parse(JSON.stringify(user));
  assert.deepStrictEqual(restarted.guildDonation, user.guildDonation);
  assert.strictEqual(restarted.guildDonation.donationCount, 8);

  now = new Date("2026-08-21T12:00:00.000Z");
  ack = succeeds(user, request(77n, 3, 1), {
    rewardItems: [{ itemId: 21, countFree: 120n, countPaid: 0n }],
    guildExpDelta: 50n,
    unionPointDelta: 40n,
  });
  assert.strictEqual(ack.donationCount, 1, "4 a.m. service-day rollover must reset the daily counter");
  assert.deepStrictEqual(ack.costItems.map(itemTuple), [[101, 400n, 0n]]);
  assert.strictEqual(user.guildUnionPoint, "240");
  assert.strictEqual(mate.guildUnionPoint, "240");
  assert.strictEqual(user.guildLevelExp, "145");
  assert.strictEqual(saves, 3);
  assert.strictEqual(invalidations, 3);
}

function succeeds(user, payload, expected) {
  const socket = { session: { user } };
  managedPackets.push([PACKETS.DONATION_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true);
  assert.strictEqual(socket.response.packetId, PACKETS.DONATION_ACK);
  const ack = decodeAck(socket.response.payload, expected);
  assert.strictEqual(ack.errorCode, ERRORS.OK);
  return ack;
}

function rejects(name, user, payload, expectedError, canonical = true) {
  const socket = { session: { user } };
  const before = JSON.stringify(user);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeMissions = missionEvents.length;
  if (canonical) managedPackets.push([PACKETS.DONATION_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, packet(payload)), true, name);
  assert.strictEqual(socket.response.packetId, PACKETS.DONATION_ACK, name);
  const ack = decodeAck(socket.response.payload, null);
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.deepStrictEqual(ack.costItems, [], `${name} cost list`);
  assert.strictEqual(JSON.stringify(user), before, `${name} must not mutate`);
  assert.strictEqual(saves, beforeSaves, `${name} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${name} must not invalidate JOIN`);
  assert.strictEqual(missionEvents.length, beforeMissions, `${name} must not track missions`);
  return ack;
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_DONATION_REQ.cs"), /guildUid[\s\S]*donationId[\s\S]*donationCount/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_DONATION_ACK.cs"), /errorCode[\s\S]*donationId[\s\S]*costItemDataList[\s\S]*rewardData[\s\S]*additionalReward[\s\S]*donationCount[\s\S]*lastDailyResetDate/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCPacketSender.cs"), /Send_NKMPacket_GUILD_DONATION_REQ[\s\S]*guildUid[\s\S]*donationId[\s\S]*donationCount/);
  assert.match(source("Assembly-CSharp", "NKC", "NKCGuildManager.cs"), /GetRemainDonationCount[\s\S]*IsFirstDay[\s\S]*DailyDonationCount[\s\S]*donationCount/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_DONATION_ACK[\s\S]*donationCount[\s\S]*lastDailyResetDate[\s\S]*UpdateItemInfo[\s\S]*GetReward[\s\S]*additionalReward/);
  assert.match(source("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"), /NEC_FAIL_GUILD_INVALID_DONATION_ID[\s\S]*NEC_FAIL_GUILD_DONATION_DAILY_LIMIT[\s\S]*NEC_FAIL_GUILD_DONATION_JOIN_DATE_LIMIT[\s\S]*NEC_FAIL_GUILD_INVALID_DONATION_COUNT\s*=\s*24100/);
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
      assert(result.ok, `managed client schema rejected guild donation packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, options = {}) {
  const user = {
    userUid,
    guildUid: String(options.guildUid || 0),
    guildLevel: Number(options.guildLevel || 1),
    guildLevelExp: String(options.guildLevelExp || 0),
    guildUnionPoint: String(options.unionPoint || 0),
    guildWeeklyContributionPoint: String(options.weeklyContributionPoint || 0),
    guildTotalContributionPoint: String(options.totalContributionPoint || 0),
    inventory: { misc: {}, equips: {}, skins: [] },
  };
  for (const [itemId, value] of [[1, options.item1], [21, options.item21], [101, options.item101]]) {
    user.inventory.misc[itemId] = { itemId, countFree: String(value || 0), countPaid: "0", bonusRatio: 0, regDate: "0" };
  }
  if (options.guildMemberCreatedAt) user.guildMemberCreatedAt = options.guildMemberCreatedAt;
  if (options.donationCount != null) {
    user.guildDonation = {
      donationCount: options.donationCount,
      lastDailyResetDate: String(options.donationDate || 0),
      resetKey: String(options.donationResetKey || ""),
    };
  }
  return user;
}

function request(guildUid, donationId, donationCount) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarInt(donationId), writeSignedVarInt(donationCount)]);
}

function packet(payload) {
  return { packetId: PACKETS.DONATION_REQ, sequence: 68, payload };
}

function decodeAck(payload, expected) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarInt(payload, field.offset);
  const donationId = field.value;
  const costList = readItemList(payload, field.offset);
  let offset = costList.offset;
  const rewardBytes = expected
    ? writeNullableObject(buildRewardData({ miscItems: expected.rewardItems }))
    : Buffer.from([0]);
  assert(payload.subarray(offset, offset + rewardBytes.length).equals(rewardBytes), "guild donation rewardData schema");
  offset += rewardBytes.length;
  assert.strictEqual(payload.readUInt8(offset++), 1, "additionalReward must be non-null");
  const guildExp = readSignedVarLong(payload, offset); offset = guildExp.offset;
  const unionPoint = readSignedVarLong(payload, offset); offset = unionPoint.offset;
  const eventPass = readSignedVarLong(payload, offset); offset = eventPass.offset;
  assert.strictEqual(guildExp.value, expected ? expected.guildExpDelta : 0n);
  assert.strictEqual(unionPoint.value, expected ? expected.unionPointDelta : 0n);
  assert.strictEqual(eventPass.value, 0n);
  const donationCount = readSignedVarInt(payload, offset); offset = donationCount.offset;
  const lastDailyResetDate = payload.readBigInt64LE(offset); offset += 8;
  assert.strictEqual(offset, payload.length);
  return { errorCode, donationId, costItems: costList.items, donationCount: donationCount.value, lastDailyResetDate };
}

function readItemList(payload, startOffset) {
  const count = readUnsignedVarInt(payload, startOffset);
  let offset = count.offset;
  const items = [];
  for (let index = 0; index < count.value; index += 1) {
    assert.strictEqual(payload.readUInt8(offset++), 1);
    const itemId = readSignedVarInt(payload, offset); offset = itemId.offset;
    const countFree = readSignedVarLong(payload, offset); offset = countFree.offset;
    const countPaid = readSignedVarLong(payload, offset); offset = countPaid.offset;
    const bonusRatio = readSignedVarInt(payload, offset); offset = bonusRatio.offset;
    const regDate = payload.readBigInt64LE(offset); offset += 8;
    items.push({ itemId: itemId.value, countFree: countFree.value, countPaid: countPaid.value, bonusRatio: bonusRatio.value, regDate });
  }
  return { items, offset };
}

function itemTuple(item) {
  return [item.itemId, item.countFree, item.countPaid];
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
