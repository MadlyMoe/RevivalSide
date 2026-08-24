"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PACKETS,
  ERRORS,
  getActiveCompanyBuffs,
  loadTables,
} = require("../modules/company-buff");
const { buildRewardData, readSignedVarInt, readSignedVarLong, writeNullableObject, writeSignedVarInt, writeSignedVarLong } = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers([path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")], { rootDir });
const buyHandler = handlers.get(PACKETS.BUY_REQ);
const refreshHandler = handlers.get(1643);
assert(buyHandler && buyHandler.fileName === "modules\\company-buff\\handlers\\0000-3464-guild-buy-buff-req.js");
assert(refreshHandler && refreshHandler.fileName === "packet-handlers\\1643-refresh-company-buff-req.js");

const NOW = 638913312000000000n; // 2026-08-20T12:00:00Z
const TICKS_PER_MINUTE = 600000000n;
const users = {
  "1001": makeUser("1001", { grade: 1, item23: 100, unionPoint: 200000 }),
  "1002": makeUser("1002", { grade: 2, item23: 0, unionPoint: 200000 }),
  "2001": makeUser("2001", { guildUid: 88, grade: 0, item23: 100, unionPoint: 900000 }),
  "3001": makeUser("3001", { guildUid: 0, grade: 2, item23: 100, unionPoint: 0 }),
};
const sockets = Object.fromEntries(Object.values(users).map((user) => [user.userUid, { session: { user }, packets: [] }]));
const managedPackets = [];
let saves = 0;
let invalidations = 0;
const missionTracks = [];

const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users },
  decryptCopy(payload) { return Buffer.from(payload || Buffer.alloc(0)); },
  dateTimeTicksNow() { return NOW; },
  sendGameResponse(socket, packet, packetId, payload) {
    socket.response = { packetId, payload };
    socket.packets.push([packetId, payload]);
    managedPackets.push([packetId, payload]);
    assert.strictEqual(packet.sequence, 64);
  },
  sendServerGamePacket(socket, packetId, payload) {
    socket.response = { packetId, payload };
    socket.packets.push([packetId, payload]);
    managedPackets.push([packetId, payload]);
  },
  findClientSocketByUserUid(userUid) { return sockets[String(userUid)] || null; },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache(label) {
    assert.match(label, /^company-buff-/);
    invalidations += 1;
  },
  trackMissionEvent(user, condition, count, details) {
    missionTracks.push({ userUid: user.userUid, condition, count, details });
    return true;
  },
};

verifyFrozenSources();
verifyTables();
verifyFailuresArePure();
verifyPersonalPurchaseAndRefresh();
verifyGuildPurchaseAndRestart();
validateManagedSchemas();

console.log(
  `[company-buff-purchase-check] PASS welfare=${loadTables().welfareById.size} saves=${saves} invalidations=${invalidations} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function verifyFailuresArePure() {
  rejects("trailing data", users["1001"], Buffer.concat([request(77n, 1), Buffer.from([0])]), ERRORS.INVALID_REQUEST, false);
  rejects("truncated request", users["1001"], writeSignedVarLong(77n), ERRORS.INVALID_REQUEST, false);
  rejects("noncanonical guild uid", users["1001"], Buffer.concat([Buffer.from([0x9a, 0x81, 0x00]), writeSignedVarInt(1)]), ERRORS.INVALID_REQUEST, false);
  rejects("not a guild member", users["3001"], request(77n, 1), ERRORS.NOT_A_MEMBER);
  rejects("guild mismatch", users["1001"], request(88n, 1), ERRORS.INVALID_GUILD_UID);
  rejects("invalid welfare", users["1001"], request(77n, 999999), ERRORS.INVALID_WELFARE_ID);

  const locked = makeUser("4001", { grade: 1, guildLevel: 2, item23: 100, unionPoint: 200000 });
  ctx.userDb.users[locked.userUid] = locked;
  sockets[locked.userUid] = { session: { user: locked }, packets: [] };
  rejects("locked welfare", locked, request(77n, 3), ERRORS.INVALID_WELFARE_ID);
  rejects("guild member grade", users["1002"], request(77n, 101), ERRORS.NOT_ENOUGH_GRADE);

  const poorPersonal = makeUser("4002", { grade: 1, item23: 24, unionPoint: 200000 });
  ctx.userDb.users[poorPersonal.userUid] = poorPersonal;
  sockets[poorPersonal.userUid] = { session: { user: poorPersonal }, packets: [] };
  rejects("personal item cost", poorPersonal, request(77n, 1), ERRORS.INSUFFICIENT_RESOURCE);

  const poorGuild = makeUser("5001", { guildUid: 99, grade: 1, item23: 100, unionPoint: 1999 });
  ctx.userDb.users[poorGuild.userUid] = poorGuild;
  sockets[poorGuild.userUid] = { session: { user: poorGuild }, packets: [] };
  const ack = rejects("guild union cost", poorGuild, request(99n, 101), ERRORS.NOT_ENOUGH_UNION_POINT);
  assert.strictEqual(ack.unionPoint, 1999n, "insufficient union-point ACK must refresh the authoritative balance");
}

function verifyPersonalPurchaseAndRefresh() {
  const user = users["1001"];
  const mate = users["1002"];
  const beforeMate = JSON.stringify(mate);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeTracks = missionTracks.length;
  const socket = sockets[user.userUid];
  socket.packets = [];
  managedPackets.push([PACKETS.BUY_REQ, request(77n, 1)]);
  assert.strictEqual(buyHandler.handle(ctx, socket, packet(PACKETS.BUY_REQ, request(77n, 1))), true);
  const ack = decodeBuyAck(socket.packets[0][1]);
  assert.deepStrictEqual(
    { errorCode: ack.errorCode, guildUid: ack.guildUid, welfareId: ack.welfareId, costItemId: ack.costItems[0].itemId, countFree: ack.costItems[0].countFree, unionPoint: ack.unionPoint },
    { errorCode: 0, guildUid: 77n, welfareId: 1, costItemId: 23, countFree: 75n, unionPoint: 200000n }
  );
  assert.strictEqual(socket.packets[1][0], PACKETS.ADD_NOT, "purchase ACK must be followed by the company-buff grant push");
  assert.deepStrictEqual(decodeCompanyBuffPush(socket.packets[1][1]), {
    companyBuffId: 1911,
    expireTicks: NOW + 60n * TICKS_PER_MINUTE,
  });
  assert.strictEqual(getActiveCompanyBuffs(user, { nowTicks: NOW }).length, 1);
  assert.strictEqual(JSON.stringify(mate), beforeMate, "personal welfare must not grant another member's profile");
  assert.strictEqual(saves, beforeSaves + 1);
  assert.strictEqual(invalidations, beforeInvalidations + 1);
  assert.deepStrictEqual(missionTracks[beforeTracks], {
    userUid: user.userUid,
    condition: "USE_RESOURCE",
    count: 25,
    details: { itemId: 23, resourceId: 23, value: 23 },
  });

  rejects("active personal group", user, request(77n, 2), ERRORS.PERSONAL_BUFF_ALREADY_ACTIVATING);

  socket.packets = [];
  managedPackets.push([1643, Buffer.alloc(0)]);
  assert.strictEqual(refreshHandler.handle(ctx, socket, packet(1643, Buffer.alloc(0))), true);
  const refresh = decodeRefreshAck(socket.packets[0][1]);
  assert.strictEqual(refresh.errorCode, 0);
  assert.deepStrictEqual(refresh.buffs, [{ companyBuffId: 1911, expireTicks: NOW + 60n * TICKS_PER_MINUTE }]);

  const saved = JSON.parse(JSON.stringify(user));
  assert.deepStrictEqual(getActiveCompanyBuffs(saved, { nowTicks: NOW }), getActiveCompanyBuffs(user, { nowTicks: NOW }), "personal buff must survive JSON restart");

  const expiryCtx = { ...ctx, dateTimeTicksNow() { return NOW + 61n * TICKS_PER_MINUTE; } };
  socket.packets = [];
  const saveBeforeExpiry = saves;
  const invalidationBeforeExpiry = invalidations;
  assert.strictEqual(refreshHandler.handle(expiryCtx, socket, packet(1643, Buffer.alloc(0))), true);
  assert.deepStrictEqual(decodeRefreshAck(socket.packets[0][1]).buffs, []);
  assert.strictEqual(user.companyBuffs.length, 0, "expired refresh must prune durable state");
  assert.strictEqual(saves, saveBeforeExpiry + 1);
  assert.strictEqual(invalidations, invalidationBeforeExpiry + 1);
  socket.packets = [];
  assert.strictEqual(refreshHandler.handle(expiryCtx, socket, packet(1643, Buffer.alloc(0))), true);
  assert.strictEqual(saves, saveBeforeExpiry + 1, "duplicate expired refresh must be pure");

  socket.packets = [];
  const beforeMalformed = JSON.stringify(user);
  assert.strictEqual(refreshHandler.handle(ctx, socket, packet(1643, Buffer.from([0]))), true);
  assert.strictEqual(decodeRefreshAck(socket.packets[0][1]).errorCode, ERRORS.INVALID_REQUEST);
  assert.strictEqual(JSON.stringify(user), beforeMalformed);
}

function verifyGuildPurchaseAndRestart() {
  const buyer = users["1001"];
  const mate = users["1002"];
  const outsider = users["2001"];
  const outsiderBefore = JSON.stringify(outsider);
  const tracksBefore = missionTracks.length;
  const buyerSocket = sockets[buyer.userUid];
  const mateSocket = sockets[mate.userUid];
  buyerSocket.packets = [];
  mateSocket.packets = [];
  managedPackets.push([PACKETS.BUY_REQ, request(77n, 101)]);
  assert.strictEqual(buyHandler.handle(ctx, buyerSocket, packet(PACKETS.BUY_REQ, request(77n, 101))), true);
  const ack = decodeBuyAck(buyerSocket.packets[0][1]);
  assert.strictEqual(ack.errorCode, 0);
  assert.strictEqual(ack.unionPoint, 198000n);
  assert.strictEqual(buyer.guildUnionPoint, "198000");
  assert.strictEqual(mate.guildUnionPoint, "198000");
  assert.strictEqual(outsider.guildUnionPoint, "900000");
  assert.strictEqual(buyerSocket.packets[1][0], PACKETS.ADD_NOT);
  assert.strictEqual(mateSocket.packets[0][0], PACKETS.ADD_NOT, "online guild member must receive the grant push");
  assert.strictEqual(getActiveCompanyBuffs(buyer, { nowTicks: NOW }).some((buff) => buff.companyBuffId === 1811), true);
  assert.strictEqual(getActiveCompanyBuffs(mate, { nowTicks: NOW }).some((buff) => buff.companyBuffId === 1811), true);
  assert.strictEqual(JSON.stringify(outsider), outsiderBefore, "guild welfare must not escape its guild");
  assert.strictEqual(missionTracks.length, tracksBefore, "shared union-point spending must not fabricate personal resource progress");

  const restarted = JSON.parse(JSON.stringify({ buyer, mate }));
  assert.strictEqual(getActiveCompanyBuffs(restarted.buyer, { nowTicks: NOW }).some((buff) => buff.companyBuffId === 1811), true);
  assert.strictEqual(getActiveCompanyBuffs(restarted.mate, { nowTicks: NOW }).some((buff) => buff.companyBuffId === 1811), true);
  rejects("active guild group", buyer, request(77n, 102), ERRORS.BUFF_STILL_ACTIVATING);
}

function rejects(name, user, payload, expectedError, canonical = true) {
  const socket = sockets[user.userUid];
  socket.packets = [];
  const before = JSON.stringify(ctx.userDb.users);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  const beforeTracks = missionTracks.length;
  if (canonical) managedPackets.push([PACKETS.BUY_REQ, payload]);
  assert.strictEqual(buyHandler.handle(ctx, socket, packet(PACKETS.BUY_REQ, payload)), true, name);
  assert.strictEqual(socket.packets.length, 1, `${name} must only return the ACK`);
  const ack = decodeBuyAck(socket.packets[0][1]);
  assert.strictEqual(ack.errorCode, expectedError, name);
  assert.strictEqual(JSON.stringify(ctx.userDb.users), before, `${name} must not mutate any profile`);
  assert.strictEqual(saves, beforeSaves, `${name} must not save`);
  assert.strictEqual(invalidations, beforeInvalidations, `${name} must not invalidate JOIN`);
  assert.strictEqual(missionTracks.length, beforeTracks, `${name} must not track missions`);
  return ack;
}

function verifyTables() {
  const tables = loadTables();
  assert.strictEqual(tables.welfareById.size, 17);
  assert.strictEqual(tables.buffById.size, 491);
  assert.deepStrictEqual(tables.welfareById.get(1), {
    id: 1,
    category: "PERSONAL",
    companyBuffId: 1911,
    companyBuffGroupId: 191,
    costItemId: 23,
    costValue: 25,
    unlockGuildLevel: 1,
  });
  assert.deepStrictEqual(tables.welfareById.get(107), {
    id: 107,
    category: "GUILD",
    companyBuffId: 1817,
    companyBuffGroupId: 181,
    costItemId: 24,
    costValue: 135000,
    unlockGuildLevel: 20,
  });
  assert.strictEqual(tables.buffById.get(1911).durationMinutes, 60);
  assert.strictEqual(tables.buffById.get(1817).durationMinutes, 10080);
}

function verifyFrozenSources() {
  const source = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BUY_BUFF_REQ.cs"), /guildUid[\s\S]*welfareId/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "Guild", "NKMPacket_GUILD_BUY_BUFF_ACK.cs"), /errorCode[\s\S]*guildUid[\s\S]*welfareId[\s\S]*costItemDataList[\s\S]*rewardData[\s\S]*unionPoint/);
  assert.match(source("Assembly-CSharp", "ClientPacket", "User", "NKMPacket_COMPANY_BUFF_ADD_NOT.cs"), /companyBuffData/);
  assert.match(source("Assembly-CSharp", "NKM", "NKMCompanyBuffData.cs"), /companyBuffId[\s\S]*expireTicks/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_GUILD_BUY_BUFF_ACK[\s\S]*UpdateItemInfo[\s\S]*GetReward[\s\S]*unionPoint/);
  assert.match(source("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), /OnRecv\(NKMPacket_COMPANY_BUFF_ADD_NOT[\s\S]*UpsertCompanyBuffData/);
  assert.match(source("Assembly-CSharp", "NKC", "UI", "Guild", "NKCUIGuildLobbyWelfareSlot.cs"), /HasBuffGroup[\s\S]*GuildMemberGrade\.Member[\s\S]*Send_NKMPacket_GUILD_BUY_BUFF_REQ/);
  assert.match(source("server", "listener.js"), /buildCompanyBuffList\(user,[^\n]*m_companyBuffDataList/);
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
      assert(result.ok, `managed client schema rejected company-buff packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function makeUser(userUid, options = {}) {
  const guildUid = options.guildUid == null ? 77 : options.guildUid;
  return {
    userUid,
    guildUid: String(guildUid),
    guildLevel: Number(options.guildLevel || 20),
    guildMemberGrade: Number(options.grade == null ? 2 : options.grade),
    guildUnionPoint: String(options.unionPoint || 0),
    inventory: {
      misc: {
        23: { itemId: 23, countFree: String(options.item23 || 0), countPaid: "0", bonusRatio: 0, regDate: "0" },
      },
      equips: {},
      skins: [],
    },
  };
}

function request(guildUid, welfareId) {
  return Buffer.concat([writeSignedVarLong(guildUid), writeSignedVarInt(welfareId)]);
}

function packet(packetId, payload) {
  return { packetId, sequence: 64, payload };
}

function decodeBuyAck(payload) {
  let field = readSignedVarInt(payload, 0);
  const errorCode = field.value;
  field = readSignedVarLong(payload, field.offset);
  const guildUid = field.value;
  field = readSignedVarInt(payload, field.offset);
  const welfareId = field.value;
  let list = readUnsignedVarInt(payload, field.offset);
  const costItems = [];
  let offset = list.offset;
  for (let index = 0; index < list.value; index += 1) {
    assert.strictEqual(payload.readUInt8(offset++), 1);
    const itemId = readSignedVarInt(payload, offset); offset = itemId.offset;
    const countFree = readSignedVarLong(payload, offset); offset = countFree.offset;
    const countPaid = readSignedVarLong(payload, offset); offset = countPaid.offset;
    const bonusRatio = readSignedVarInt(payload, offset); offset = bonusRatio.offset;
    const regDate = payload.readBigInt64LE(offset); offset += 8;
    costItems.push({ itemId: itemId.value, countFree: countFree.value, countPaid: countPaid.value, bonusRatio: bonusRatio.value, regDate });
  }
  const reward = errorCode === 0 ? writeNullableObject(buildRewardData({})) : Buffer.from([0]);
  assert(payload.subarray(offset, offset + reward.length).equals(reward), "ACK rewardData schema");
  offset += reward.length;
  const unionPoint = readSignedVarLong(payload, offset);
  assert.strictEqual(unionPoint.offset, payload.length);
  return { errorCode, guildUid, welfareId, costItems, unionPoint: unionPoint.value };
}

function decodeCompanyBuffPush(payload) {
  assert.strictEqual(payload.readUInt8(0), 1);
  const id = readSignedVarInt(payload, 1);
  const expiry = readSignedVarLong(payload, id.offset);
  assert.strictEqual(expiry.offset, payload.length);
  return { companyBuffId: id.value, expireTicks: expiry.value };
}

function decodeRefreshAck(payload) {
  const error = readSignedVarInt(payload, 0);
  const count = readUnsignedVarInt(payload, error.offset);
  const buffs = [];
  let offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    assert.strictEqual(payload.readUInt8(offset++), 1);
    const id = readSignedVarInt(payload, offset); offset = id.offset;
    const expiry = readSignedVarLong(payload, offset); offset = expiry.offset;
    buffs.push({ companyBuffId: id.value, expireTicks: expiry.value });
  }
  assert.strictEqual(offset, payload.length);
  return { errorCode: error.value, buffs };
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
