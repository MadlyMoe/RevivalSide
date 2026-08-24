"use strict";

const assert = require("assert");
const path = require("path");
const { ADMIN_UID, createAdminHandler, createAdminRewardPosts } = require("../modules/admin");
const { getMiscItem } = require("../modules/inventory");
const { grantUnit, getArmyShips } = require("../modules/unit");
const {
  dateTimeBinaryNow,
  farFutureDateTimeBinary,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const now = dateTimeBinaryNow();
const user = {
  userUid: "980000000000001",
  nickname: "InboxCheck",
  friendCode: "98000001",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  inventoryExpansion: { ship: 60, "3": 60 },
  army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [] },
  admin: { posts: [], chats: {}, nextPostIndex: "1", nextMessageUid: "1" },
};
for (let index = 0; index < 60; index += 1) assert(grantUnit(user, 26001));
assert.strictEqual(getArmyShips(user).length, 60, "ship inventory fixture must be full");

const [post1] = createAdminRewardPosts(user, [{ rewardType: "RT_MISC", id: 1, count: 100 }], "Credits 1", "First");
const [post2] = createAdminRewardPosts(user, [{ rewardType: "RT_MISC", id: 1, count: 200 }], "Credits 2", "Second");
const [post3] = createAdminRewardPosts(user, [{ rewardType: "RT_SHIP", id: 26001, count: 1 }], "Full ship", "Blocked by capacity");
const [expired] = createAdminRewardPosts(user, [{ rewardType: "RT_MISC", id: 1, count: 999 }], "Expired", "Expired");
expired.expirationDate = String(now - 1n);

const socket = { session: { user }, name: "inbox" };
const userDb = { users: { [user.userUid]: user } };
const handlers = new Map([1614, 1616, 3800].map((packetId) => [packetId, createAdminHandler(packetId, `CHECK_${packetId}`)]));
const pushes = [];
const wire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  userDb,
  decryptCopy: (payload) => payload,
  dateTimeBinaryNow: () => now,
  getServerNowDate: () => new Date("2021-01-05T12:00:00Z"),
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { sequence: packet.sequence, packetId, payload };
    wire.push([packetId, payload]);
  },
  sendServerGamePacket(target, packetId, payload) {
    pushes.push({ target: target.name, packetId, payload });
    wire.push([packetId, payload]);
  },
  findClientSocketByUserUid: (userUid) => String(userUid) === user.userUid ? socket : null,
  saveUserDb() { saves += 1; },
};
const currentPost = (post) => user.admin.posts.find((entry) => entry.postIndex === post.postIndex);

send(1614, writeSignedVarLong(0));
let list = parsePostListAck(socket.response.payload);
assert.deepStrictEqual(list.postIndexes, [3n, 2n, 1n], "first page must be newest first and omit expired mail");
assert.strictEqual(list.postCount, 3);
assert.strictEqual(list.errorCode, 0);
send(1614, writeSignedVarLong(3));
list = parsePostListAck(socket.response.payload);
assert.deepStrictEqual(list.postIndexes, [2n, 1n], "pagination must continue toward smaller post indexes");
assert.strictEqual(saves, 0, "mail list reads must not persist");

send(1616, writeSignedVarLong(999));
assertPostReceive(230);
send(1616, writeSignedVarLong(expired.postIndex));
assertPostReceive(231);
assert.strictEqual(saves, 0, "missing and expired claims must not persist");

send(1616, writeSignedVarLong(post2.postIndex));
assertPostReceive(0);
assert.strictEqual(getMiscItem(user, 1).countFree, "200");
assert.strictEqual(currentPost(post2).received, true);
send(1616, writeSignedVarLong(post2.postIndex));
assertPostReceive(230);
assert.strictEqual(saves, 1, "duplicate claim must not persist");

send(1616, writeSignedVarLong(0));
assertPostReceive(229);
assert.strictEqual(currentPost(post1).received, true, "receive-all must retain successful rewards before a full-inventory result");
assert.strictEqual(currentPost(post3).received, false, "full-inventory mail must remain pending");
assert.strictEqual(getMiscItem(user, 1).countFree, "300");
assert.strictEqual(getArmyShips(user).length, 60);
send(1616, writeSignedVarLong(0));
assertPostReceive(229);
assert.strictEqual(saves, 2, "a fully blocked receive-all must not save");

const post100 = {
  postId: 100,
  postIndex: "5",
  title: "Manual only",
  contents: "Not receive-all eligible",
  sendDate: String(now),
  expirationDate: String(farFutureDateTimeBinary()),
  rewards: [{ rewardType: "RT_MISC", id: 1, count: 50 }],
  received: false,
};
user.admin.posts.push(post100);
user.admin.nextPostIndex = "6";
send(1616, writeSignedVarLong(0));
assertPostReceive(229);
assert.strictEqual(currentPost(post100).received, false, "receive-all must honor the frozen post template flag");
send(1616, writeSignedVarLong(post100.postIndex));
assertPostReceive(0);
assert.strictEqual(getMiscItem(user, 1).countFree, "350");

send(3800, chatRequest(ADMIN_UID, "/give currency quartz 10"));
assert.strictEqual(socket.response.packetId, 3801);
assert(pushes.some((push) => push.packetId === 1618), "reward mail creation must emit POST_ARRIVE_NOT");
const arrive = pushes.find((push) => push.packetId === 1618);
assert.strictEqual(readSignedVarInt(arrive.payload, 0).value, 1);

send(3800, chatRequest(ADMIN_UID, "/time"));
const listNot = pushes.find((push) => push.packetId === 1645);
assert(listNot, "direct informational mail must emit POST_LIST_NOT");
const pushedList = parsePostListNot(listNot.payload);
assert.strictEqual(pushedList.postIndexes.length, 1);
assert.strictEqual(pushedList.postCount, 3, "push must carry the exact pending non-expired count");

const restarted = JSON.parse(JSON.stringify(userDb));
assert.strictEqual(restarted.users[user.userUid].admin.posts.find((post) => post.postIndex === post2.postIndex).received, true);
assert.strictEqual(restarted.users[user.userUid].admin.posts.find((post) => post.postIndex === post3.postIndex).received, false);

validateManagedSchemas();
console.log(`[inbox-protocol-check] PASS saves=${saves} pushes=${pushes.length} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing inbox handler ${packetId}`);
  wire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function chatRequest(userUid, message) {
  return Buffer.concat([writeSignedVarLong(userUid), writeSignedVarInt(0), writeString(message)]);
}

function assertPostReceive(errorCode) {
  assert.strictEqual(socket.response.packetId, 1617);
  assert.strictEqual(parsePostReceiveAck(socket.response.payload).errorCode, errorCode);
}

function parsePostListAck(payload) {
  const parsed = parsePostList(payload);
  const error = readSignedVarInt(payload, parsed.offset);
  return { ...parsed, errorCode: error.value, offset: error.offset };
}

function parsePostListNot(payload) {
  return parsePostList(payload);
}

function parsePostList(payload) {
  const count = readUnsignedVarInt(payload, 0);
  let offset = count.offset;
  const postIndexes = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    offset = present.offset;
    assert(present.value, "post list entries must be non-null");
    let read = readSignedVarInt(payload, offset);
    offset = read.offset;
    read = readSignedVarLong(payload, offset);
    postIndexes.push(read.value);
    offset = read.offset;
    for (let field = 0; field < 2; field += 1) {
      read = readString(payload, offset);
      offset = read.offset;
    }
    offset += 8;
    const rewards = readUnsignedVarInt(payload, offset);
    offset = rewards.offset;
    for (let reward = 0; reward < rewards.value; reward += 1) {
      const rewardPresent = readBool(payload, offset);
      offset = rewardPresent.offset;
      assert(rewardPresent.value);
      for (let field = 0; field < 4; field += 1) {
        read = readSignedVarInt(payload, offset);
        offset = read.offset;
      }
    }
    offset += 8;
  }
  const postCount = readSignedVarInt(payload, offset);
  return { postIndexes, postCount: postCount.value, offset: postCount.offset };
}

function parsePostReceiveAck(payload) {
  let read = readSignedVarLong(payload, 0);
  let offset = read.offset;
  const rewardPresent = readBool(payload, offset);
  offset = rewardPresent.offset;
  assert(rewardPresent.value, "post reward payload must be non-null");
  for (let field = 0; field < 2; field += 1) {
    read = readSignedVarInt(payload, offset);
    offset = read.offset;
  }
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipObjectList(payload, offset, skipMiscItem);
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipIntList(payload, offset);
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipIntList(payload, offset);
  read = readSignedVarInt(payload, offset); offset = read.offset;
  read = readSignedVarInt(payload, offset); offset = read.offset;
  offset = skipObjectList(payload, offset, skipNoObjects);
  read = readSignedVarLong(payload, offset); offset = read.offset;
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipObjectList(payload, offset, skipNoObjects);
  offset = skipObjectList(payload, offset, skipNoObjects);
  const postCount = readSignedVarInt(payload, offset);
  const error = readSignedVarInt(payload, postCount.offset);
  return { postCount: postCount.value, errorCode: error.value };
}

function skipObjectList(payload, offset, skipObject) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    offset = present.offset;
    assert(present.value);
    offset = skipObject(payload, offset);
  }
  return offset;
}

function skipNoObjects() {
  assert.fail("unexpected populated reward object list in inbox fixture");
}

function skipMiscItem(payload, offset) {
  let read = readSignedVarInt(payload, offset); offset = read.offset;
  read = readSignedVarLong(payload, offset); offset = read.offset;
  read = readSignedVarLong(payload, offset); offset = read.offset;
  read = readSignedVarInt(payload, offset); offset = read.offset;
  return offset + 8;
}

function skipIntList(payload, offset) {
  const count = readUnsignedVarInt(payload, offset);
  offset = count.offset;
  for (let index = 0; index < count.value; index += 1) offset = readSignedVarInt(payload, offset).offset;
  return offset;
}

function readUnsignedVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (shift < 32) {
    const byte = buffer.readUInt8(offset++);
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
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
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected inbox packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
