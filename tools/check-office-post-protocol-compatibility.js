"use strict";

const assert = require("assert");
const path = require("path");
const { createOfficeHandlers, ensureOfficeState } = require("../modules/office");
const { getMiscItem } = require("../modules/inventory");
const {
  farFutureDateTimeBinary,
  readSignedVarInt,
  writeSignedVarLong,
} = require("../modules/packet-codec");
const { dateTimeBinaryForDate, rawTicksFromDateTime } = require("../modules/server-time");
const { readGameplayTable, getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");

const rootDir = path.resolve(__dirname, "..");
const nowDate = new Date("2026-08-20T12:00:00.000Z");
const NOW = dateTimeBinaryForDate(nowDate);
const handlers = new Map(createOfficeHandlers().map((handler) => [handler.packetId, handler]));
for (const packetId of [3626, 3628, 3630, 3632]) assert(handlers.has(packetId), `missing Office post handler ${packetId}`);

const common = readGameplayTable("ab_script", "LUA_COMMON_CONST.json");
assert.deepStrictEqual(common.globals.Office.OfficeHostNameCard, { ItemId: 8, ItemValue: 10, DayLimit: 50 });

const wire = [];
let saves = 0;
let invalidations = 0;
let failures = 0;
let successes = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb: { users: {} },
  getServerNowDate: () => new Date(nowDate),
  dateTimeBinaryNow: () => NOW,
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { invalidations += 1; },
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { packetId, payload };
    wire.push([packetId, payload, true]);
  },
};
const socket = { session: { user: null } };

const sender = addUser(makeUser("9880000000003632", []));
const targets = Array.from({ length: 6 }, (_, index) => addUser(makeUser(String(9880000000003700n + BigInt(index)), [])));

failure(3628, Buffer.from([0]), 20191, sender, false);
failure(3630, Buffer.from([0]), 20191, sender, false);
failure(3632, Buffer.alloc(0), 20191, sender, false);
failure(3632, Buffer.concat([sendRequest(targets[0]), Buffer.from([0])]), 20191, sender, false);
failure(3632, sendRequest(sender), 20907, sender);
failure(3632, writeSignedVarLong(999999999999n), 20893, sender);

success(3632, sendRequest(targets[0]), sender);
assert.strictEqual(sender.office.postState.sendCount, 1);
assert.deepStrictEqual(sender.office.postState.sentTargetUserUids, [targets[0].userUid]);
assert.strictEqual(targets[0].office.posts.length, 1);
assert.strictEqual(targets[0].office.posts[0].senderProfile.nickname, sender.nickname);
assert.strictEqual(targets[0].office.posts[0].expirationDate, String(farFutureDateTimeBinary()));
failure(3632, sendRequest(targets[0]), 20895, sender);
for (const target of targets.slice(1, 5)) success(3632, sendRequest(target), sender);
assert.strictEqual(sender.office.postState.sendCount, 5);
failure(3632, sendRequest(targets[5]), 20896, sender);

const targetBeforeList = JSON.stringify(targets[0]);
success(3626, writeSignedVarLong(0n), targets[0], false);
success(3626, writeSignedVarLong(1n), targets[0], false);
assert.strictEqual(JSON.stringify(targets[0]), targetBeforeList, "post-list reads must remain profile-pure");

success(3628, Buffer.alloc(0), targets[0]);
assert.strictEqual(targets[0].office.posts.length, 0);
assert.strictEqual(targets[0].office.postState.recvCount, 1);
assert.strictEqual(getMiscItem(targets[0], 8).countFree, "10");
failure(3628, Buffer.alloc(0), 20903, targets[0]);

const receiveCapUser = addUser(makeUser("9880000000003800", []));
receiveCapUser.office.postState.recvCount = 50;
receiveCapUser.office.postState.dailyResetKey = "2026-08-20";
receiveCapUser.office.postState.nextResetDate = String(dateTimeBinaryForDate(new Date("2026-08-21T04:00:00.000Z")));
seedPost(receiveCapUser, sender, 1);
failure(3628, Buffer.alloc(0), 20902, receiveCapUser);

const limitedReceive = addUser(makeUser("9880000000003801", []));
limitedReceive.office.postState.recvCount = 49;
limitedReceive.office.postState.dailyResetKey = "2026-08-20";
limitedReceive.office.postState.nextResetDate = String(dateTimeBinaryForDate(new Date("2026-08-21T04:00:00.000Z")));
for (let uid = 1; uid <= 3; uid += 1) seedPost(limitedReceive, sender, uid);
success(3628, Buffer.alloc(0), limitedReceive);
assert.strictEqual(limitedReceive.office.postState.recvCount, 50);
assert.strictEqual(limitedReceive.office.posts.length, 2);
assert.strictEqual(getMiscItem(limitedReceive, 8).countFree, "10");

const noFriends = addUser(makeUser("9880000000003900", []));
failure(3630, Buffer.alloc(0), 20909, noFriends);

const broadcastSender = addUser(makeUser("9880000000003901", [targets[0].userUid, targets[1].userUid]));
success(3632, sendRequest(targets[0]), broadcastSender);
const target0BeforeBroadcast = targets[0].office.posts.length;
const target1BeforeBroadcast = targets[1].office.posts.length;
success(3630, Buffer.alloc(0), broadcastSender);
assert.strictEqual(broadcastSender.office.postState.broadcastExecution, true);
assert.strictEqual(broadcastSender.office.postState.sendCount, 1, "broadcast must not spend the five direct-send slots");
assert.strictEqual(targets[0].office.posts.length, target0BeforeBroadcast, "broadcast must not duplicate a card already sent today");
assert.strictEqual(targets[1].office.posts.length, target1BeforeBroadcast + 1);
failure(3630, Buffer.alloc(0), 20905, broadcastSender);

const resetSender = addUser(makeUser("9880000000003902", []));
resetSender.office.postState = {
  broadcastExecution: true,
  sendCount: 5,
  recvCount: 50,
  nextResetDate: String(dateTimeBinaryForDate(new Date("2026-08-20T04:00:00.000Z"))),
  dailyResetKey: "2026-08-19",
  sentTargetUserUids: [targets[5].userUid],
};
success(3632, sendRequest(targets[5]), resetSender);
assert.deepStrictEqual(
  [resetSender.office.postState.broadcastExecution, resetSender.office.postState.sendCount, resetSender.office.postState.recvCount],
  [false, 1, 0]
);
assert.deepStrictEqual(resetSender.office.postState.sentTargetUserUids, [targets[5].userUid]);
assert(rawTicksFromDateTime(resetSender.office.postState.nextResetDate) > rawTicksFromDateTime(NOW));

const restarted = JSON.parse(JSON.stringify({ sender, targets, receiveCapUser, limitedReceive, broadcastSender, resetSender }));
for (const user of [restarted.sender, ...restarted.targets, restarted.receiveCapUser, restarted.limitedReceive, restarted.broadcastSender, restarted.resetSender]) {
  ensureOfficeState(user);
}
assert.strictEqual(restarted.targets[1].office.posts.some((post) => post.senderProfile.userUid === broadcastSender.userUid), true);
assert.strictEqual(restarted.limitedReceive.office.posts.length, 2);
assert.strictEqual(restarted.resetSender.office.postState.sendCount, 1);

assert.strictEqual(saves, successes - 2, "only the two post-list reads must be save-free");
assert.strictEqual(invalidations, saves);
validateManagedSchemas();
console.log(`[office-post-protocol-check] PASS failures=${failures} successes=${successes} saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function makeUser(userUid, friends) {
  const user = {
    userUid,
    friendCode: String(BigInt(userUid) % 100000000n),
    nickname: `Office ${userUid.slice(-4)}`,
    level: 50,
    mainUnitId: 1001,
    hasOffice: true,
    community: { friends: friends.slice(), outgoingRequests: [], incomingRequests: [], blocked: [] },
    inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  };
  ensureOfficeState(user);
  return user;
}

function addUser(user) {
  ctx.userDb.users[user.userUid] = user;
  return user;
}

function seedPost(target, from, postUid) {
  target.office.posts.push({
    postUid: String(postUid),
    senderProfile: {
      userUid: from.userUid,
      friendCode: from.friendCode,
      nickname: from.nickname,
      level: from.level,
      mainUnitId: from.mainUnitId,
    },
    senderGuildData: { guildUid: "0", guildName: "", badgeId: "0" },
    expirationDate: String(farFutureDateTimeBinary()),
  });
  target.office.nextPostUid = String(Math.max(Number(target.office.nextPostUid || 1), postUid + 1));
}

function sendRequest(target) {
  return writeSignedVarLong(BigInt(target.userUid));
}

function dispatch(packetId, payload, user, schemaValid = true) {
  socket.session.user = user;
  wire.push([packetId, payload, schemaValid]);
  assert.strictEqual(handlers.get(packetId).handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
  return readSignedVarInt(socket.response.payload, 0).value;
}

function success(packetId, payload, user, persist = true) {
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(dispatch(packetId, payload, user), 0);
  assert.strictEqual(saves, beforeSaves + (persist ? 1 : 0));
  assert.strictEqual(invalidations, beforeInvalidations + (persist ? 1 : 0));
  successes += 1;
}

function failure(packetId, payload, expectedError, user, schemaValid = true) {
  const before = JSON.stringify(ctx.userDb.users);
  const beforeSaves = saves;
  const beforeInvalidations = invalidations;
  assert.strictEqual(dispatch(packetId, payload, user, schemaValid), expectedError);
  assert.strictEqual(JSON.stringify(ctx.userDb.users), before, `Office post error ${expectedError} mutated the user database`);
  assert.strictEqual(saves, beforeSaves);
  assert.strictEqual(invalidations, beforeInvalidations);
  failures += 1;
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
    for (const [packetId, payload, schemaValid] of wire) {
      if (!schemaValid) continue;
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected Office post packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
