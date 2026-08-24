const {
  writeString,
  writeBool,
  writeVarInt,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeObjectList,
  buildRewardData,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  dateTimeBinaryNow,
  farFutureDateTimeBinary,
  statTypeValue,
  toBigInt,
} = require("../packet-codec");
const { COMMON_RESOURCE_ITEM_IDS, RESOURCE_ITEM_IDS, ensureInventory } = require("../inventory");
const { createEmptyReward, mergeReward, grantRewardByType } = require("../reward");
const {
  getMiscItemTemplet,
  getUnitTemplet,
  getEquipTemplet,
  getAllEquipRandomStatRecords,
  getEquipSetOption,
  getEquipSetOptionIds,
  getAllEquipSetOptionRecords,
  getSkinTemplet,
  getEmoticonTemplet,
  getAllMiscItemIds,
  getPlayableUnitIds,
  getPlayableShipIds,
  getTrophyUnitIds,
  getPlayableOperatorIds,
  getAllEquipIds,
  getAllEquipMoldTemplets,
  getEquipMoldTemplet,
  getAllSkinIds,
  getAllEmoticonIds,
} = require("../game-data");
const { validateEquipCustomSubstats } = require("../equipment");
const {
  INVENTORY_TYPES,
  getInventoryCapacity,
  getInventoryUsage,
} = require("../inventory-capacity");
const { readGameplayTableRecords } = require("../gameplay-jsons");
const worldMap = require("../world-map");

const PACKETS = Object.freeze({
  POST_LIST_REQ: 1614,
  POST_LIST_ACK: 1615,
  POST_RECEIVE_REQ: 1616,
  POST_RECEIVE_ACK: 1617,
  POST_ARRIVE_NOT: 1618,
  POST_LIST_NOT: 1645,
  PRIVATE_CHAT_REQ: 3800,
  PRIVATE_CHAT_ACK: 3801,
  PRIVATE_CHAT_NOT: 3802,
  PRIVATE_CHAT_LIST_REQ: 3803,
  PRIVATE_CHAT_LIST_ACK: 3804,
  PRIVATE_CHAT_ALL_LIST_REQ: 3805,
  PRIVATE_CHAT_ALL_LIST_ACK: 3806,
});

const ADMIN_UID = toBigInt(process.env.CS_ADMIN_CHAT_UID || "999999999001");
const ADMIN_FRIEND_CODE = toBigInt(process.env.CS_ADMIN_FRIEND_CODE || "99999901");
const ADMIN_NICKNAME = process.env.CS_ADMIN_NICKNAME || "Revival Admin";
const ADMIN_MAIN_UNIT_ID = Number(process.env.CS_ADMIN_MAIN_UNIT_ID || 1006);
const ADMIN_MAX_REWARDS_PER_MAIL = Math.max(1, Number(process.env.CS_ADMIN_MAX_REWARDS_PER_MAIL || 80));
const CHAT_HISTORY_LIMIT = Math.max(10, Number(process.env.CS_ADMIN_CHAT_HISTORY_LIMIT || 100));
const ADMIN_POST_ID = Number(process.env.CS_ADMIN_POST_ID || 0);
const PRIVATE_CHAT_MAX_LENGTH = 70;
const PRIVATE_CHAT_ERRORS = Object.freeze({
  INVALID_REQUEST: 20190,
  INVALID_USER_UID: 22100,
  BLOCKED_USER_UID: 22101,
});
const POST_ERRORS = Object.freeze({
  ITEM_FULL: 229,
  INVALID_POST_INDEX: 230,
  EXPIRED: 231,
});
const postAllowReceiveAll = new Map(
  readGameplayTableRecords("ab_script", "LUA_POST_TEMPLET.json")
    .map((row) => [Number(row && row.m_PostID), Boolean(row && row.m_AllowReceiveAll)])
    .filter(([postId]) => Number.isInteger(postId))
);
const trophyUnitIds = new Set(getTrophyUnitIds().map(Number));

const REWARD_TYPE_ENUM = Object.freeze({
  RT_NONE: 0,
  RT_UNIT: 1,
  RT_SHIP: 2,
  RT_MISC: 3,
  RT_RESOURCE: 3,
  RT_ITEM_MISC: 3,
  RT_USER_EXP: 4,
  RT_EQUIP: 5,
  RT_ITEM_EQUIP: 5,
  RT_EQUIP_ITEM: 5,
  RT_MOLD: 6,
  RT_SKIN: 7,
  RT_BUFF: 8,
  RT_EMOTICON: 9,
  RT_MISSION_POINT: 10,
  RT_BINGO_TILE: 11,
  RT_PASS_EXP: 12,
  RT_OPERATOR: 13,
});

const CURRENCY_ALIASES = Object.freeze({
  credit: RESOURCE_ITEM_IDS.CREDIT,
  credits: RESOURCE_ITEM_IDS.CREDIT,
  eternium: RESOURCE_ITEM_IDS.ETERNIUM,
  quartz: RESOURCE_ITEM_IDS.QUARTZ,
  admincoin: RESOURCE_ITEM_IDS.ADMIN_COIN,
  admincoins: RESOURCE_ITEM_IDS.ADMIN_COIN,
  admin_coin: RESOURCE_ITEM_IDS.ADMIN_COIN,
  coin: RESOURCE_ITEM_IDS.ADMIN_COIN,
  coins: RESOURCE_ITEM_IDS.ADMIN_COIN,
});

const CLEAR_INVENTORY_IGNORED_FILTERS = new Set(["", "item", "items", "misc", "inventory", "only"]);
const CLEAR_INVENTORY_TYPE_FILTERS = Object.freeze({
  selector: ["IMT_CHOICE_"],
  selectors: ["IMT_CHOICE_"],
  selectable: ["IMT_CHOICE_"],
  choice: ["IMT_CHOICE_"],
  choices: ["IMT_CHOICE_"],
  box: ["IMT_RANDOMBOX"],
  boxes: ["IMT_RANDOMBOX"],
  random: ["IMT_RANDOMBOX"],
  randombox: ["IMT_RANDOMBOX"],
  randomboxes: ["IMT_RANDOMBOX"],
  package: ["IMT_PACKAGE", "IMT_CUSTOM_PACKAGE"],
  packages: ["IMT_PACKAGE", "IMT_CUSTOM_PACKAGE"],
  pack: ["IMT_PACKAGE", "IMT_CUSTOM_PACKAGE"],
  packs: ["IMT_PACKAGE", "IMT_CUSTOM_PACKAGE"],
  resource: ["IMT_RESOURCE"],
  resources: ["IMT_RESOURCE"],
  currency: ["IMT_RESOURCE"],
  currencies: ["IMT_RESOURCE"],
  consumable: ["IMT_PACKAGE", "IMT_CUSTOM_PACKAGE", "IMT_RANDOMBOX", "IMT_CHOICE_"],
  consumables: ["IMT_PACKAGE", "IMT_CUSTOM_PACKAGE", "IMT_RANDOMBOX", "IMT_CHOICE_"],
  piece: ["IMT_PIECE"],
  pieces: ["IMT_PIECE"],
  title: ["IMT_TITLE"],
  titles: ["IMT_TITLE"],
  background: ["IMT_BACKGROUND"],
  backgrounds: ["IMT_BACKGROUND"],
  emblem: ["IMT_EMBLEM", "IMT_EMBLEM_RANK"],
  emblems: ["IMT_EMBLEM", "IMT_EMBLEM_RANK"],
  contract: ["IMT_CONTRACT"],
  contracts: ["IMT_CONTRACT"],
  normal: ["IMT_MISC"],
});
const CLEAR_INVENTORY_RESOURCE_IDS = new Set([...COMMON_RESOURCE_ITEM_IDS, ...Object.values(RESOURCE_ITEM_IDS)].map(Number));

const DEFAULT_NEWBIE_REWARDS = Object.freeze([
  { rewardType: "RT_MISC", id: RESOURCE_ITEM_IDS.CREDIT, count: envRewardCount("CS_NEWBIE_CREDIT_REWARD", 100000) },
  { rewardType: "RT_MISC", id: RESOURCE_ITEM_IDS.ETERNIUM, count: envRewardCount("CS_NEWBIE_ETERNIUM_REWARD", 3000) },
  { rewardType: "RT_MISC", id: RESOURCE_ITEM_IDS.QUARTZ, count: envRewardCount("CS_NEWBIE_QUARTZ_REWARD", 1000) },
]);

const DEFAULT_SIGN_IN_REWARDS = Object.freeze([
  { rewardType: "RT_MISC", id: RESOURCE_ITEM_IDS.CREDIT, count: envRewardCount("CS_SIGN_IN_CREDIT_REWARD", 30000) },
  { rewardType: "RT_MISC", id: RESOURCE_ITEM_IDS.ETERNIUM, count: envRewardCount("CS_SIGN_IN_ETERNIUM_REWARD", 1000) },
]);
const MAX_MAZE_CDR_SET_OPTION_ID = 241900;
const MAX_MAZE_GEAR_BUNDLE = Object.freeze([
  { id: 561141, count: 1 },
  { id: 561241, count: 1 },
  { id: 561341, count: 2 },
]);
const GEAR_STAT_ALIASES = Object.freeze({
  ATK: "NST_ATK",
  ATTACK: "NST_ATK",
  HP: "NST_HP",
  DEF: "NST_DEF",
  DEFENSE: "NST_DEF",
  HIT: "NST_HIT",
  ACC: "NST_HIT",
  EVADE: "NST_EVADE",
  EVA: "NST_EVADE",
  CRIT: "NST_CRITICAL",
  CRITICAL: "NST_CRITICAL",
  CRIT_DMG: "NST_CRITICAL_DAMAGE_RATE",
  CRITDMG: "NST_CRITICAL_DAMAGE_RATE",
  CRITICAL_DAMAGE: "NST_CRITICAL_DAMAGE_RATE",
  ASPD: "NST_ATTACK_SPEED_RATE",
  ATTACK_SPEED: "NST_ATTACK_SPEED_RATE",
  CDR: "NST_SKILL_COOL_TIME_REDUCE_RATE",
  COOLDOWN: "NST_SKILL_COOL_TIME_REDUCE_RATE",
  SKILL_HASTE: "NST_SKILL_COOL_TIME_REDUCE_RATE",
  SKILL_DAMAGE: "NST_SKILL_DAMAGE_RATE",
  SKILL_DMG: "NST_SKILL_DAMAGE_RATE",
  ULT_DAMAGE: "NST_HYPER_SKILL_DAMAGE_RATE",
  ULT_DMG: "NST_HYPER_SKILL_DAMAGE_RATE",
  DAMAGE_REDUCE: "NST_DAMAGE_REDUCE_RATE",
  DMG_REDUCE: "NST_DAMAGE_REDUCE_RATE",
  DEF_PEN: "NST_DEF_PENETRATE_RATE",
  DEF_PENETRATE: "NST_DEF_PENETRATE_RATE",
});
function createAdminHandler(packetId, name) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      ctx.socket = socket;
      const user = getSessionUser(ctx, socket);
      const request = decodeRequest(ctx, packetId, packet.payload);
      const result = buildResponse(ctx, socket, user, packetId, request);
      console.log(`[admin:${name}] ACK packetId=${result.packetId} ${formatRequest(request)}`);
      if (typeof ctx.sendGameResponse === "function") {
        ctx.sendGameResponse(socket, packet, result.packetId, result.payload, `admin-${name}`);
      } else {
        ctx.sendResponse(socket, packet.sequence, result.packetId, () =>
          ctx.buildEncryptedPacket(packet.sequence, result.packetId, result.payload)
        );
      }
      for (const notice of result.notices || []) sendServerNotice(ctx, socket, notice.packetId, notice.payload, notice.label);
      for (const notice of result.userNotices || []) sendUserNotice(ctx, notice.userUid, notice.packetId, notice.payload, notice.label);
      if (result.worldMapRefresh) {
        worldMap.sendRaidSnapshotData(ctx, socket, user, {
          now: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined,
          includeWorldMap: true,
          worldMapLabel: "admin-world-map-data",
          label: "admin-raid-list",
          detailLabel: "admin-raid-detail",
          coopLabel: "admin-raid-coop-list",
          resultLabel: "admin-raid-results",
          eventCancelLabel: "admin-raid-event-clear",
          cancelCityIds: result.cancelCityIds,
          detailRaidUids: result.raidDetailUids,
          includeEmpty: true,
        });
      }
      if (result.persist !== false) persistUserDb(ctx);
      return true;
    },
  };
}

function buildResponse(ctx, socket, user, packetId, request) {
  switch (packetId) {
    case PACKETS.POST_LIST_REQ:
      return postListAck(ctx, user, request);
    case PACKETS.POST_RECEIVE_REQ:
      return postReceiveAck(ctx, user, request);
    case PACKETS.PRIVATE_CHAT_REQ:
      return privateChatAck(ctx, user, request);
    case PACKETS.PRIVATE_CHAT_LIST_REQ:
      return privateChatListAck(ctx, user, request);
    case PACKETS.PRIVATE_CHAT_ALL_LIST_REQ:
      return privateChatAllListAck(ctx, user);
    default:
      return { packetId: packetId + 1, payload: writeSignedVarInt(0) };
  }
}

function postListAck(ctx, user, request) {
  const lastPostIndex = toBigInt(request.lastPostIndex || 0);
  const errorCode = request.valid === false || lastPostIndex < 0n ? POST_ERRORS.INVALID_POST_INDEX : 0;
  const posts = errorCode === 0 ? listVisiblePosts(ctx, user, lastPostIndex) : [];
  return {
    packetId: PACKETS.POST_LIST_ACK,
    payload: Buffer.concat([
      writeObjectList(posts.map((post) => writeNullableObject(buildPostData(post)))),
      writeSignedVarInt(countPendingPosts(ctx, user)),
      writeSignedVarInt(errorCode),
    ]),
    persist: false,
  };
}

function postReceiveAck(ctx, user, request) {
  const postIndex = toBigInt(request.postIndex || 0);
  if (request.valid === false || postIndex < 0n) return postReceiveResult(ctx, user, postIndex, createEmptyReward(), POST_ERRORS.INVALID_POST_INDEX, false);
  const state = ensureAdminState(user);
  const pending = state.posts.filter((post) => !post.received);
  const candidates = postIndex === 0n
    ? pending.filter((post) => postAllowReceiveAll.get(Number(post.postId || 0)) === true)
    : pending.filter((post) => toBigInt(post.postIndex) === postIndex);
  if (!candidates.length) return postReceiveResult(ctx, user, postIndex, createEmptyReward(), POST_ERRORS.INVALID_POST_INDEX, false);
  if (postIndex !== 0n && isPostExpired(ctx, candidates[0])) {
    return postReceiveResult(ctx, user, postIndex, createEmptyReward(), POST_ERRORS.EXPIRED, false);
  }

  const reward = createEmptyReward();
  let inventoryFull = false;
  let received = 0;
  for (const post of candidates) {
    if (isPostExpired(ctx, post)) continue;
    if (!canReceivePost(user, post)) {
      inventoryFull = true;
      if (postIndex !== 0n) break;
      continue;
    }
    mergeReward(reward, grantPostRewards(ctx, user, post));
    post.received = true;
    post.receivedAt = String(getChatTimestamp(ctx));
    received += 1;
  }
  const errorCode = inventoryFull ? POST_ERRORS.ITEM_FULL : received > 0 ? 0 : POST_ERRORS.INVALID_POST_INDEX;
  return postReceiveResult(ctx, user, postIndex, reward, errorCode, received > 0);
}

function postReceiveResult(ctx, user, postIndex, reward, errorCode, persist) {
  return {
    packetId: PACKETS.POST_RECEIVE_ACK,
    payload: Buffer.concat([
      writeSignedVarLong(postIndex),
      writeNullableObject(buildRewardData(reward)),
      writeSignedVarInt(countPendingPosts(ctx, user)),
      writeSignedVarInt(errorCode),
    ]),
    persist,
  };
}

function privateChatAck(ctx, user, request) {
  const targetUid = toBigInt(request.userUid || 0);
  const target = targetUid === ADMIN_UID ? null : findLocalUser(ctx, targetUid);
  const validationError = validatePrivateChatRequest(user, targetUid, target, request);
  if (validationError !== 0) return privateChatAckError(validationError);

  const messageText = String(request.message || "");
  const messageUid = allocatePrivateChatMessageUid(ctx, user);
  const userMessage = appendChatMessage(
    user,
    targetUid,
    buildUserChatMessage(ctx, user, messageUid, messageText, request.emotionId)
  );
  const notices = [
    { packetId: PACKETS.PRIVATE_CHAT_NOT, payload: buildPrivateChatNot(userMessage), label: "private-chat-self" },
  ];
  const userNotices = [];
  let worldMapRefresh = false;
  let worldMapRefreshOptions = null;
  if (targetUid === ADMIN_UID) {
    const postCountBefore = ensureAdminState(user).posts.length;
    const result = handleAdminCommand(ctx, user, messageText);
    const replyText = result.reply || "Command handled.";
    const adminMessage = appendChatMessage(
      user,
      ADMIN_UID,
      buildAdminChatMessage(replyText, allocatePrivateChatMessageUid(ctx, user), getChatTimestamp(ctx))
    );
    notices.push({ packetId: PACKETS.PRIVATE_CHAT_NOT, payload: buildPrivateChatNot(adminMessage), label: "private-chat-admin" });
    if (result.createdPosts > 0) {
      const createdPosts = ensureAdminState(user).posts.slice(postCountBefore);
      notices.push(result.postListNotify
        ? {
            packetId: PACKETS.POST_LIST_NOT,
            payload: buildPostListNot(ctx, user, createdPosts),
            label: "post-list-not",
          }
        : {
            packetId: PACKETS.POST_ARRIVE_NOT,
            payload: writeSignedVarInt(result.createdPosts),
            label: "post-arrive",
          }
      );
    }
    worldMapRefresh = Boolean(result.worldMapRefresh);
    worldMapRefreshOptions = {
      cancelCityIds: result.cancelCityIds,
      raidDetailUids: result.raidDetailUids,
    };
  } else {
    appendChatMessage(target, toBigInt(user.userUid), userMessage);
    userNotices.push({
      userUid: targetUid,
      packetId: PACKETS.PRIVATE_CHAT_NOT,
      payload: buildPrivateChatNot(userMessage),
      label: "private-chat-recipient",
    });
  }
  return {
    packetId: PACKETS.PRIVATE_CHAT_ACK,
    payload: Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(toBigInt(userMessage.messageUid))]),
    notices,
    userNotices,
    persist: true,
    worldMapRefresh,
    cancelCityIds: worldMapRefreshOptions && worldMapRefreshOptions.cancelCityIds,
    raidDetailUids: worldMapRefreshOptions && worldMapRefreshOptions.raidDetailUids,
  };
}

function privateChatAckError(errorCode) {
  return {
    packetId: PACKETS.PRIVATE_CHAT_ACK,
    payload: Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarLong(0)]),
    persist: false,
  };
}

function privateChatListAck(ctx, user, request) {
  const targetUid = toBigInt(request.userUid || 0);
  const target = targetUid === ADMIN_UID ? null : findLocalUser(ctx, targetUid);
  const errorCode = validatePrivateChatTarget(user, targetUid, target, request.valid);
  const welcomeAdded = errorCode === 0 && targetUid === ADMIN_UID ? ensureAdminWelcome(user) : false;
  const messages = getChatMessages(user, targetUid);
  return {
    packetId: PACKETS.PRIVATE_CHAT_LIST_ACK,
    payload: Buffer.concat([
      writeSignedVarInt(errorCode),
      writeSignedVarLong(targetUid),
      writeObjectList((errorCode === 0 ? messages : []).map((message) => writeNullableObject(buildChatMessageData(message)))),
    ]),
    persist: welcomeAdded,
  };
}

function privateChatAllListAck(ctx, user) {
  const welcomeAdded = ensureAdminWelcome(user);
  const friends = [buildPrivateChatListData(getAdminProfile(), getLastAdminChatMessage(user))];
  const seen = new Set([String(user.userUid || "0"), ADMIN_UID.toString()]);
  for (const target of getFriendUsers(ctx, user)) {
    const uid = String(target.userUid || "0");
    if (seen.has(uid)) continue;
    seen.add(uid);
    friends.push(buildPrivateChatListData(getUserProfile(target), getLastChatMessage(user, uid)));
  }
  const guildMembers = [];
  for (const target of getGuildUsers(ctx, user)) {
    const uid = String(target.userUid || "0");
    if (seen.has(uid)) continue;
    seen.add(uid);
    guildMembers.push(buildPrivateChatListData(getUserProfile(target), getLastChatMessage(user, uid)));
  }
  return {
    packetId: PACKETS.PRIVATE_CHAT_ALL_LIST_ACK,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeObjectList(friends.map((entry) => writeNullableObject(entry))),
      writeObjectList(guildMembers.map((entry) => writeNullableObject(entry))),
    ]),
    persist: welcomeAdded,
  };
}

function validatePrivateChatRequest(user, targetUid, target, request) {
  const targetError = validatePrivateChatTarget(user, targetUid, target, request && request.valid);
  if (targetError !== 0) return targetError;
  const message = String(request.message || "");
  const emotionId = Number(request.emotionId || 0);
  const hasText = !/^\s*$/.test(message);
  if (hasText) {
    return emotionId === 0 && message.length <= PRIVATE_CHAT_MAX_LENGTH ? 0 : PRIVATE_CHAT_ERRORS.INVALID_REQUEST;
  }
  if (!Number.isInteger(emotionId) || emotionId <= 0) return PRIVATE_CHAT_ERRORS.INVALID_REQUEST;
  const templet = getEmoticonTemplet(emotionId);
  const owned = ensureInventory(user).emoticons.includes(emotionId);
  return templet && templet.m_EmoticonType === "NET_ANI" && owned ? 0 : PRIVATE_CHAT_ERRORS.INVALID_REQUEST;
}

function validatePrivateChatTarget(user, targetUid, target, requestValid = true) {
  if (!requestValid) return PRIVATE_CHAT_ERRORS.INVALID_REQUEST;
  const uid = toBigInt(targetUid || 0);
  if (uid <= 0n || uid === toBigInt(user && user.userUid || 0)) return PRIVATE_CHAT_ERRORS.INVALID_USER_UID;
  if (uid !== ADMIN_UID && !target) return PRIVATE_CHAT_ERRORS.INVALID_USER_UID;
  if (uid !== ADMIN_UID && (hasBlockedUser(user, uid) || hasBlockedUser(target, user && user.userUid))) {
    return PRIVATE_CHAT_ERRORS.BLOCKED_USER_UID;
  }
  return 0;
}

function hasBlockedUser(user, userUid) {
  const blocked = user && user.community && Array.isArray(user.community.blocked) ? user.community.blocked : [];
  const target = String(toBigInt(userUid || 0));
  return blocked.some((uid) => String(toBigInt(uid || 0)) === target);
}

function findLocalUser(ctx, userUid) {
  const users = ctx && ctx.userDb && ctx.userDb.users && typeof ctx.userDb.users === "object" ? ctx.userDb.users : {};
  return users[String(toBigInt(userUid || 0))] || null;
}

function getFriendUsers(ctx, user) {
  const friendUids = user && user.community && Array.isArray(user.community.friends) ? user.community.friends : [];
  return friendUids.map((uid) => findLocalUser(ctx, uid)).filter(Boolean);
}

function getGuildUsers(ctx, user) {
  const guildUid = toBigInt(user && user.guildUid || 0);
  if (guildUid <= 0n) return [];
  const users = ctx && ctx.userDb && ctx.userDb.users && typeof ctx.userDb.users === "object"
    ? Object.values(ctx.userDb.users)
    : [];
  return users.filter(
    (target) => target && String(target.userUid || "0") !== String(user.userUid || "0") && toBigInt(target.guildUid || 0) === guildUid
  );
}

function allocatePrivateChatMessageUid(ctx, user) {
  if (!ctx || !ctx.userDb || typeof ctx.userDb !== "object") return allocateMessageUid(ensureAdminState(user));
  ctx.userDb.privateChat = ctx.userDb.privateChat && typeof ctx.userDb.privateChat === "object" ? ctx.userDb.privateChat : {};
  const state = ctx.userDb.privateChat;
  const timestamp = toBigInt(getChatTimestamp(ctx), 1n);
  let next = toBigInt(state.nextMessageUid || timestamp, timestamp);
  if (next < timestamp) next = timestamp;
  state.nextMessageUid = (next + 1n).toString();
  return next;
}

function getChatTimestamp(ctx) {
  return ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
}

function handleAdminCommand(ctx, user, messageText) {
  const tokens = tokenizeCommand(messageText);
  if (!tokens.length) return { reply: adminHelpText(), createdPosts: 0 };
  const pendingResult = maybeHandlePendingGearOverride(user, tokens);
  if (pendingResult) return pendingResult;
  if (!isAdminCommand(tokens[0])) return { reply: adminHelpText(), createdPosts: 0 };
  if (tokens[0].toLowerCase() === "/admin") tokens.shift();
  const command = String(tokens.shift() || "help").toLowerCase().replace(/^\//, "");
  if (command === "help" || command === "commands") {
    const topic = String(tokens.shift() || "").toLowerCase();
    return { reply: topic === "gear" ? gearHelpText() : adminHelpText(), createdPosts: 0 };
  }
  if (command === "clear") {
    const subcommand = String(tokens[0] || "").trim().toLowerCase();
    if (subcommand === "inventory" || subcommand === "invent" || subcommand === "items" || subcommand === "item") {
      tokens.shift();
      return handleClearInventoryCommand(user, tokens);
    }
    return clearAdminInbox(user);
  }
  if (command === "time" || command === "clock" || command === "servertime" || command === "server-time") {
    return handleServerTimeCommand(ctx, user, tokens);
  }
  if (command === "raid" || command === "spawnraid" || command === "raidspawn") {
    return handleRaidSpawnCommand(ctx, user, tokens);
  }
  if (command === "sephira" || command === "spawnsephira") {
    return handleSephiraSpawnCommand(ctx, user, tokens);
  }
  if (command === "killraid" || command === "raidkill") {
    return handleRaidKillCommand(ctx, user, tokens);
  }
  if (command === "spawn" && String(tokens[0] || "").toLowerCase() === "raid") {
    tokens.shift();
    return handleRaidSpawnCommand(ctx, user, tokens);
  }
  if (command === "spawn" && String(tokens[0] || "").toLowerCase() === "sephira") {
    tokens.shift();
    return handleSephiraSpawnCommand(ctx, user, tokens);
  }
  if (command !== "give" && command !== "grant" && command !== "mail") {
    return { reply: `Unknown admin command: ${command}\n${adminHelpText()}`, createdPosts: 0 };
  }

  const parsed = parseGiveCommand(tokens, user);
  if (!parsed.ok) {
    if (parsed.pendingGearOverride) ensureAdminState(user).pendingGearOverride = parsed.pendingGearOverride;
    return { reply: parsed.error, createdPosts: 0 };
  }
  ensureAdminState(user).pendingGearOverride = null;
  const posts = createAdminRewardPosts(user, parsed.rewards, parsed.title, parsed.contents);
  return {
    reply: `Queued ${parsed.rewards.length} reward line${parsed.rewards.length === 1 ? "" : "s"} in ${posts.length} inbox mail${posts.length === 1 ? "" : "s"}. Open Mail to claim.`,
    createdPosts: posts.length,
  };
}

function handleRaidSpawnCommand(ctx, user, tokens) {
  const subcommand = String(tokens && tokens[0] || "").trim().toLowerCase();
  if (subcommand === "clear" || subcommand === "reset" || subcommand === "delete") {
    return handleRaidClearCommand(user, tokens.slice(1));
  }
  if (subcommand === "sephira") {
    return handleSephiraSpawnCommand(ctx, user, tokens.slice(1));
  }
  if (subcommand === "kill" || subcommand === "defeat" || subcommand === "complete") {
    return handleRaidKillCommand(ctx, user, tokens.slice(1));
  }
  const parsed = parseRaidSpawnCommand(tokens);
  if (!parsed.ok) return { reply: parsed.error, createdPosts: 0 };
  const result = worldMap.spawnAdminRaid(user, {
    level: parsed.level,
    branch: parsed.branch,
    durationHours: parsed.durationHours,
    now: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined,
  });
  if (!result.ok) return { reply: result.error || "Raid spawn failed.", createdPosts: 0 };
  const levelText =
    result.actualLevel === result.requestedLevel
      ? `level ${result.actualLevel}`
      : `level ${result.actualLevel} (closest to requested level ${result.requestedLevel})`;
  const familyText = result.raidFamily ? ` ${result.raidFamily}` : "";
  const replacedText = result.replacedRaidUID !== "0" ? ` Replaced raid ${result.replacedRaidUID}.` : "";
  console.log(
    `[admin:raid] spawned raidUID=${result.raid.raidUID} branch=${result.city.cityID} level=${result.actualLevel} family=${result.raidFamily || ""} stageID=${result.stageID} eventID=${result.eventID}`
  );
  return {
    reply: `Spawned ${levelText}${familyText} raid ${result.raid.raidUID} on branch ${result.city.cityID}. Stage ${result.stageID}, event ${result.eventID}.${replacedText}`,
    createdPosts: 0,
    worldMapRefresh: true,
    raidDetailUids: [result.raid.raidUID],
  };
}

function handleSephiraSpawnCommand(ctx, user, tokens) {
  const parsed = parseRaidBranchCommand(tokens, { defaultBranch: 1, allowDuration: true });
  if (!parsed.ok) return { reply: parsed.error, createdPosts: 0 };
  const result = worldMap.spawnSephiraRaid(user, {
    branch: parsed.branch,
    durationHours: parsed.durationHours,
    now: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined,
  });
  if (!result.ok) return { reply: result.error || "Sephira raid spawn failed.", createdPosts: 0 };
  const levelText =
    result.actualLevel === result.requestedLevel
      ? `level ${result.actualLevel}`
      : `level ${result.actualLevel} (Sephira requested level ${result.requestedLevel})`;
  const replacedText = result.replacedRaidUID !== "0" ? ` Replaced raid ${result.replacedRaidUID}.` : "";
  console.log(
    `[admin:raid] spawned sephira raidUID=${result.raid.raidUID} branch=${result.city.cityID} level=${result.actualLevel} stageID=${result.stageID} eventID=${result.eventID}`
  );
  return {
    reply: `Spawned Sephira ${levelText} raid ${result.raid.raidUID} on branch ${result.city.cityID}. Stage ${result.stageID}, event ${result.eventID}.${replacedText}`,
    createdPosts: 0,
    worldMapRefresh: true,
    raidDetailUids: [result.raid.raidUID],
  };
}

function handleRaidKillCommand(ctx, user, tokens) {
  const parsed = parseRaidBranchCommand(tokens, { defaultBranch: 0 });
  if (!parsed.ok) return { reply: parsed.error, createdPosts: 0 };
  const result = worldMap.killRaidInBranch(user, {
    branch: parsed.branch,
    now: ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : undefined,
  });
  if (!result.ok) return { reply: result.error || "Raid kill failed.", createdPosts: 0 };
  console.log(`[admin:raid] killed raidUID=${result.raidUID} branch=${result.branch} stageID=${result.stageID} damage=${result.damage || 0}`);
  return {
    reply: `Killed raid boss ${result.raidUID} on branch ${result.branch}. Stage ${result.stageID}.`,
    createdPosts: 0,
    worldMapRefresh: true,
  };
}

function handleRaidClearCommand(user, tokens) {
  const includeResults = (Array.isArray(tokens) ? tokens : []).some((token) => {
    const value = String(token || "").trim().toLowerCase();
    return value === "all" || value === "results" || value === "completed";
  });
  const result = worldMap.clearActiveRaids(user, { includeResults });
  console.log(`[admin:raid] cleared count=${result.clearedCount} includeResults=${includeResults ? 1 : 0}`);
  return {
    reply: `Cleared ${result.clearedCount} ${includeResults ? "raid" : "active raid"}${result.clearedCount === 1 ? "" : "s"}.`,
    createdPosts: 0,
    worldMapRefresh: true,
    cancelCityIds: result.clearedCityIds,
  };
}

function parseRaidBranchCommand(tokens, options = {}) {
  const values = {};
  const positional = [];
  const input = Array.isArray(tokens) ? tokens : [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = String(input[index] || "").trim();
    if (!raw) continue;
    const eqIndex = raw.indexOf("=");
    if (eqIndex > 0) {
      const key = normalizeRaidSpawnKey(raw.slice(0, eqIndex));
      const value = raw.slice(eqIndex + 1);
      if (key) values[key] = value;
      else positional.push(raw);
      continue;
    }

    const key = normalizeRaidSpawnKey(raw);
    if (key && index + 1 < input.length) {
      values[key] = input[index + 1];
      index += 1;
      continue;
    }
    if (!["help", "?"].includes(raw.toLowerCase())) positional.push(raw);
  }

  if (input.some((token) => ["help", "?"].includes(String(token || "").toLowerCase()))) {
    return { ok: false, error: raidHelpText() };
  }

  const branch = parseAdminPositiveInt(values.branch != null ? values.branch : positional[0]);
  const durationHours = options.allowDuration ? parseAdminPositiveInt(values.duration || values.hours) : 0;
  const defaultBranch = parseAdminPositiveInt(options.defaultBranch);
  if (!branch && !defaultBranch) return { ok: false, error: raidHelpText() };
  return {
    ok: true,
    branch: branch || defaultBranch,
    durationHours: durationHours || undefined,
  };
}

function parseRaidSpawnCommand(tokens) {
  const values = {};
  const positional = [];
  const input = Array.isArray(tokens) ? tokens : [];
  for (let index = 0; index < input.length; index += 1) {
    const raw = String(input[index] || "").trim();
    if (!raw) continue;
    const eqIndex = raw.indexOf("=");
    if (eqIndex > 0) {
      const key = normalizeRaidSpawnKey(raw.slice(0, eqIndex));
      const value = raw.slice(eqIndex + 1);
      if (key) values[key] = value;
      else positional.push(raw);
      continue;
    }

    const key = normalizeRaidSpawnKey(raw);
    if (key && index + 1 < input.length) {
      values[key] = input[index + 1];
      index += 1;
      continue;
    }
    if (!["help", "?"].includes(raw.toLowerCase())) positional.push(raw);
  }

  if (input.some((token) => ["help", "?"].includes(String(token || "").toLowerCase()))) {
    return { ok: false, error: raidHelpText() };
  }

  const level = parseAdminPositiveInt(values.level != null ? values.level : positional[0]);
  const branch = parseAdminPositiveInt(values.branch != null ? values.branch : positional[1]);
  const durationHours = parseAdminPositiveInt(values.duration || values.hours);
  if (!level) return { ok: false, error: raidHelpText() };
  return {
    ok: true,
    level,
    branch: branch || 1,
    durationHours: durationHours || undefined,
  };
}

function normalizeRaidSpawnKey(value) {
  const key = String(value || "").trim().toLowerCase().replace(/^--?/, "").replace(/[_-]/g, "");
  if (["level", "lvl", "lv", "raidlevel"].includes(key)) return "level";
  if (["branch", "branchnumber", "branchid", "city", "cityid"].includes(key)) return "branch";
  if (["duration", "durationhours", "hours", "hour"].includes(key)) return "duration";
  return "";
}

function parseAdminPositiveInt(value) {
  const text = String(value == null ? "" : value).trim().replace(/,/g, "");
  if (!text) return 0;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function parseGiveCommand(tokens, user = null) {
  if (!tokens.length) return { ok: false, error: adminHelpText() };
  let kind = String(tokens.shift() || "").toLowerCase();
  let idText = String(tokens.shift() || "").toLowerCase();
  let countText = tokens.shift();

  if (kind === "everything") {
    countText = idText || countText;
    return buildAllRewards(["items", "molds", "skins", "emoticons", "units", "trophies", "ships", "operators", "gears"], countText);
  }
  if (kind === "maxmaze" || kind === "maze") return buildMaxMazeGearRewards(user);
  if (kind === "all") {
    kind = idText;
    idText = "all";
    countText = tokens.shift() || countText;
  } else if (kind.startsWith("all-")) {
    kind = kind.slice(4);
    countText = idText || countText;
    idText = "all";
  }

  if (idText === "all") return buildAllRewards([kind], normalizeRewardCount(countText || 1));

  const type = rewardTypeForKind(kind);
  if (!type) return { ok: false, error: `Unknown reward kind "${kind}".\n${adminHelpText()}` };
  const id = resolveRewardId(kind, idText);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: `Invalid ${kind} id: ${idText}` };
  if (!rewardIdExists(type, id) && !(normalizeKind(kind) === "currency" && Object.values(RESOURCE_ITEM_IDS).includes(id))) {
    return { ok: false, error: `No ${kind} id ${id} exists in local tables.` };
  }
  if (normalizeKind(kind) === "trophy" && !isTrophyUnitId(id)) {
    return { ok: false, error: `Unit id ${id} is not a NUST_TRAINER trophy unit.` };
  }
  if (normalizeKind(kind) === "gear") return buildGearReward(id, [countText, ...tokens].filter((token) => token != null && token !== ""), user);

  const count = normalizeRewardCount(countText || 1);
  const rewards = [{ rewardType: type, id, count: clampCountForType(type, count) }];
  return {
    ok: true,
    rewards,
    title: "Admin Delivery",
    contents: `Admin queued ${describeReward(rewards[0])}.`,
  };
}

function buildMaxMazeGearRewards(user = null) {
  const rewards = [];
  for (const entry of MAX_MAZE_GEAR_BUNDLE) {
    const gearOptions = buildMaxMazeGearOptions();
    const validation = validateEquipCustomSubstats(entry.id, gearOptions.customSubstats || [], {
      overrideUnsupportedSubstats: gearOptions.overrideUnsupportedSubstats,
    });
    const setValidation = validateGearSetOption(entry.id, gearOptions.setOptionId, {
      overrideUnsupportedSetBonus: gearOptions.overrideUnsupportedSetBonus,
    });
    if (!setValidation.ok && setValidation.error) return setValidation;
    if (!validation.ok && validation.unsupported.length) {
      return { ok: false, error: formatUnsupportedSubstats(validation.unsupported) };
    }
    if (setValidation.unsupported) {
      return { ok: false, error: formatUnsupportedSetBonus(setValidation.unsupported) };
    }
    rewards.push({
      rewardType: "RT_EQUIP",
      id: entry.id,
      count: entry.count,
      gearOptions,
    });
  }

  if (user) ensureAdminState(user).pendingGearOverride = null;
  return {
    ok: true,
    rewards,
    title: "Admin Max Maze Delivery",
    contents: "Admin queued a max Maze CDR set: weapon, armor, and two accessories.",
  };
}

function buildMaxMazeGearOptions() {
  return {
    setOptionId: MAX_MAZE_CDR_SET_OPTION_ID,
    customMainStat: {
      type: "DEFAULT",
      valueKind: "max",
      value: null,
      levelValueKind: "max",
      levelValue: null,
    },
    customSubstats: [
      {
        slot: 2,
        type: "NST_SKILL_COOL_TIME_REDUCE_RATE",
        valueKind: "max",
        value: null,
      },
    ],
  };
}

function buildGearReward(equipId, rawTokens, user = null) {
  const tokens = normalizeGearTokens(rawTokens);
  const count = tokens.length && isCountToken(tokens[0]) ? normalizeRewardCount(tokens.shift()) : 1;
  const parsed = parseGearOptions(tokens);
  if (!parsed.ok) return parsed;

  const reward = {
    rewardType: "RT_EQUIP",
    id: equipId,
    count: clampCountForType("RT_EQUIP", count),
  };
  if (parsed.gearOptions) reward.gearOptions = parsed.gearOptions;

  const validation = validateEquipCustomSubstats(equipId, parsed.gearOptions.customSubstats || [], {
    overrideUnsupportedSubstats: parsed.gearOptions.overrideUnsupportedSubstats,
  });
  const setValidation = validateGearSetOption(equipId, parsed.gearOptions.setOptionId, {
    overrideUnsupportedSetBonus: parsed.gearOptions.overrideUnsupportedSetBonus,
  });
  if (!setValidation.ok && setValidation.error) return setValidation;
  if ((!validation.ok && validation.unsupported.length) || setValidation.unsupported) {
    const overrideReward = {
      ...reward,
      gearOptions: {
        ...parsed.gearOptions,
      },
    };
    if (validation.unsupported.length) overrideReward.gearOptions.overrideUnsupportedSubstats = true;
    if (setValidation.unsupported) overrideReward.gearOptions.overrideUnsupportedSetBonus = true;
    const errors = [];
    if (validation.unsupported.length) errors.push(formatUnsupportedSubstats(validation.unsupported));
    if (setValidation.unsupported) errors.push(formatUnsupportedSetBonus(setValidation.unsupported));
    return {
      ok: false,
      error: `${errors.join("\n")}\nReply Y to override and force the gear option, or N to cancel.`,
      pendingGearOverride: {
        rewards: [overrideReward],
        title: "Admin Gear Delivery",
        contents: `Admin queued ${describeReward(overrideReward)} with forced gear options.`,
      },
    };
  }

  if (user) ensureAdminState(user).pendingGearOverride = null;
  return {
    ok: true,
    rewards: [reward],
    title: "Admin Gear Delivery",
    contents: `Admin queued ${describeReward(reward)}.`,
  };
}

function normalizeGearTokens(tokens) {
  return (Array.isArray(tokens) ? tokens : [])
    .flatMap((token) => String(token || "").split(/[;,]/))
    .map((token) => token.trim())
    .filter(Boolean);
}

function isCountToken(token) {
  return /^\d+$/.test(String(token || "").trim());
}

function parseGearOptions(tokens) {
  const gearOptions = { customSubstats: [] };
  let nextSlot = 1;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (["override", "force", "forced"].includes(lower)) {
      gearOptions.overrideUnsupportedSubstats = true;
      gearOptions.overrideUnsupportedSetBonus = true;
      continue;
    }
    const overrideMatch = lower.match(/^override=(y|yes|true|1|on)$/);
    if (overrideMatch) {
      gearOptions.overrideUnsupportedSubstats = true;
      gearOptions.overrideUnsupportedSetBonus = true;
      continue;
    }
    const setOption = parseGearSetOptionToken(token);
    if (setOption) {
      if (!setOption.ok) return setOption;
      if (gearOptions.setOptionId) return { ok: false, error: "Duplicate gear set bonus. Use set=... once." };
      gearOptions.setOptionId = setOption.setOptionId;
      continue;
    }
    const mainStat = parseGearMainStatToken(token);
    if (mainStat) {
      if (!mainStat.ok) return mainStat;
      if (gearOptions.customMainStat && gearOptions.customMainStat.type) {
        return { ok: false, error: "Duplicate gear main stat. Use main=... once." };
      }
      gearOptions.customMainStat = { ...(gearOptions.customMainStat || {}), ...mainStat.mainStat };
      continue;
    }
    const mainLevel = parseGearMainLevelToken(token);
    if (mainLevel) {
      if (!mainLevel.ok) return mainLevel;
      gearOptions.customMainStat = { ...(gearOptions.customMainStat || {}), ...mainLevel.mainStat };
      continue;
    }
    const substat = parseGearSubstatToken(token, nextSlot);
    if (!substat.ok) return substat;
    if (gearOptions.customSubstats.some((entry) => Number(entry.slot) === Number(substat.substat.slot))) {
      return { ok: false, error: `Duplicate gear substat slot ${substat.substat.slot}. Use sub1=... and sub2=... once each.` };
    }
    gearOptions.customSubstats.push(substat.substat);
    nextSlot = Math.max(nextSlot, Number(substat.substat.slot) + 1);
    if (gearOptions.customSubstats.length > 2) return { ok: false, error: "Gear can only have two custom substats." };
  }
  if (gearOptions.customMainStat && !gearOptions.customMainStat.type) {
    return { ok: false, error: "mainlevel requires a main stat override. Use main=<stat>=<value|max> first." };
  }
  return { ok: true, gearOptions };
}

function parseGearSetOptionToken(token) {
  const match = String(token || "").trim().match(/^(?:set|setbonus|set_bonus|setoption|set_option|bonus)[:=](.+)$/i);
  if (!match) return null;
  const setOptionId = resolveGearSetOptionId(match[1]);
  if (!Number.isInteger(setOptionId) || setOptionId <= 0) {
    return { ok: false, error: `Unknown gear set bonus "${match[1]}". Use /help gear for set bonus ids.` };
  }
  return { ok: true, setOptionId };
}

function parseGearMainStatToken(token) {
  const match = String(token || "").trim().match(/^(?:main|mainstat|main_stat|primary|base)[:=](.+)$/i);
  if (!match) return null;
  const parsed = parseGearStatAssignment(match[1], "main stat", { allowDefaultMainStat: true });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    mainStat: {
      type: parsed.type,
      value: parsed.value,
      valueKind: parsed.valueKind,
    },
  };
}

function parseGearMainLevelToken(token) {
  const match = String(token || "").trim().match(/^(?:mainlevel|mainlvl|main_level|main_level_value|mainlevelvalue)[:=](.+)$/i);
  if (!match) return null;
  const parsed = parseGearStatValue(match[1], "main level");
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    mainStat: {
      levelValue: parsed.value,
      levelValueKind: parsed.valueKind,
    },
  };
}

function parseGearSubstatToken(token, nextSlot) {
  let text = String(token || "").trim();
  let slot = 0;
  const slotMatch = text.match(/^(?:sub|slot)([12])[:=](.+)$/i);
  if (slotMatch) {
    slot = Number(slotMatch[1]);
    text = slotMatch[2];
  }

  const parsed = parseGearStatAssignment(text, "substat");
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    substat: {
      slot: slot || nextSlot,
      type: parsed.type,
      value: parsed.value,
      valueKind: parsed.valueKind,
    },
  };
}

function parseGearStatAssignment(text, label = "substat", options = {}) {
  const separator = text.includes("=") ? "=" : text.includes(":") ? ":" : "";
  if (!separator) {
    return { ok: false, error: `Invalid gear ${label} "${text}". Use <stat>=<value|max>, like atk=max.` };
  }

  const parts = text.split(separator);
  if (parts.length < 2) {
    return { ok: false, error: `Invalid gear ${label} "${text}". Use <stat>=<value|max>.` };
  }
  const statText = parts.shift();
  const valueText = parts.join(separator);
  const statType = options.allowDefaultMainStat && isDefaultGearMainStatType(statText) ? "DEFAULT" : resolveGearStatType(statText);
  if (!statType) return { ok: false, error: `Unknown gear substat type "${statText}". Use /help gear for supported ids.` };
  const value = parseGearStatValue(valueText, label);
  if (!value.ok) return value;

  return {
    ok: true,
    type: statType,
    value: value.value,
    valueKind: value.valueKind,
  };
}

function isDefaultGearMainStatType(value) {
  return ["default", "native", "original"].includes(String(value || "").trim().toLowerCase());
}

function parseGearStatValue(valueText, label = "substat") {
  const text = String(valueText || "").trim().toLowerCase();
  if (text === "max") return { ok: true, valueKind: "max", value: null };
  const percent = text.endsWith("%");
  const number = Number(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(number)) return { ok: false, error: `Invalid gear ${label} value "${valueText}". Use a number or max.` };
  return { ok: true, valueKind: "custom", value: percent ? number / 100 : number };
}

function resolveGearStatType(statText) {
  const text = String(statText || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!text) return "";
  if (/^-?\d+$/.test(text)) return gearStatTypeFromId(Number(text)) || `NST_${text}`;
  const alias = GEAR_STAT_ALIASES[text] || GEAR_STAT_ALIASES[text.replace(/^NST_/, "")];
  if (alias) return alias;
  return text.startsWith("NST_") ? text : `NST_${text}`;
}

function gearStatTypeFromId(id) {
  for (const record of getAllEquipRandomStatRecords()) {
    const type = String(record && record.m_StatType || "").trim().toUpperCase();
    if (type && statTypeValue(type) === id) return type;
  }
  for (const equipId of getAllEquipIds()) {
    const record = getEquipTemplet(equipId);
    const type = String(record && record.STAT_TYPE_1 || "").trim().toUpperCase();
    if (type && statTypeValue(type) === id) return type;
  }
  return "";
}

function formatUnsupportedSubstats(unsupported) {
  const first = unsupported[0] || {};
  const prefix = unsupported.length === 1 ? "Unsupported substat type" : "Unsupported substat types";
  const list = unsupported.map((entry) => `${entry.type} on sub${entry.slot}`).join(", ");
  return `${prefix} ${list || first.type || ""}.`;
}

function validateGearSetOption(equipId, setOptionId, options = {}) {
  const id = Number(setOptionId || 0);
  if (!id) return { ok: true, unsupported: null };
  const setOption = getEquipSetOption(id);
  if (!setOption) return { ok: false, error: `No gear set bonus id ${id} exists in local tables.` };
  const templet = getEquipTemplet(equipId);
  const supported = getEquipSetOptionIds(templet).includes(id);
  return {
    ok: supported || options.overrideUnsupportedSetBonus === true,
    unsupported: supported ? null : { equipId, setOptionId: id, setOption },
  };
}

function formatUnsupportedSetBonus(unsupported) {
  const entry = unsupported || {};
  return `Unsupported set bonus ${describeGearSetOption(entry.setOption || getEquipSetOption(entry.setOptionId))} on gear ${entry.equipId}.`;
}

function resolveGearSetOptionId(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    return getEquipSetOption(id) ? id : 0;
  }
  const target = normalizeGearSetAlias(text);
  if (!target) return 0;
  const matches = getAllEquipSetOptionRecords()
    .filter((record) => gearSetAliases(record).includes(target))
    .sort((a, b) => Number(a.m_EquipSetID) - Number(b.m_EquipSetID));
  return matches.length ? Number(matches[0].m_EquipSetID) : 0;
}

function gearSetAliases(record) {
  const aliases = new Set();
  const part = Number(record && record.m_EquipSetPart) || 0;
  const partText = part ? `${part}p` : "";
  for (const source of [record && record.m_EquipSetStrID, record && record.m_EquipSetName, record && record.m_EquipSetIcon]) {
    const normalized = normalizeGearSetAlias(source);
    if (!normalized) continue;
    aliases.add(normalized);
    aliases.add(normalized.replace(/^si_/, ""));
    aliases.add(normalized.replace(/^icon_/, ""));
    aliases.add(normalized.replace(/^set_/, ""));
    aliases.add(normalized.replace(/^set_normal_/, ""));
  }
  const effects = gearSetEffects(record);
  for (const effect of effects) {
    for (const statAlias of gearStatAliasesForType(effect.type)) {
      aliases.add(statAlias);
      if (partText) {
        aliases.add(`${partText}_${statAlias}`);
        aliases.add(`${statAlias}_${partText}`);
      }
    }
  }
  return Array.from(aliases).filter(Boolean);
}

function normalizeGearSetAlias(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^nst_/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function gearStatAliasesForType(type) {
  const normalized = resolveGearStatType(type);
  const aliases = new Set([normalizeGearSetAlias(normalized)]);
  for (const [alias, target] of Object.entries(GEAR_STAT_ALIASES)) {
    if (target === normalized) aliases.add(normalizeGearSetAlias(alias));
  }
  const shorthand = normalizeGearSetAlias(normalized)
    .replace(/_rate$/, "")
    .replace(/^role_type_/, "")
    .replace(/^unit_type_/, "")
    .replace(/^move_type_/, "")
    .replace(/_damage$/, "_dmg")
    .replace(/_reduce$/, "_res");
  aliases.add(shorthand);
  return Array.from(aliases).filter(Boolean);
}

function maybeHandlePendingGearOverride(user, tokens) {
  const answer = String(tokens[0] || "").trim().toLowerCase();
  if (!["y", "yes", "n", "no"].includes(answer)) return null;
  const state = ensureAdminState(user);
  const pending = state.pendingGearOverride;
  if (!pending || !Array.isArray(pending.rewards) || !pending.rewards.length) return null;
  state.pendingGearOverride = null;
  if (answer === "n" || answer === "no") {
    return { reply: "Cancelled forced gear substat override.", createdPosts: 0 };
  }
  const posts = createAdminRewardPosts(user, pending.rewards, pending.title, pending.contents);
  return {
    reply: `Queued ${pending.rewards.length} forced gear reward line${pending.rewards.length === 1 ? "" : "s"} in ${posts.length} inbox mail${posts.length === 1 ? "" : "s"}. Open Mail to claim.`,
    createdPosts: posts.length,
  };
}

function buildAllRewards(kinds, countText) {
  const count = normalizeRewardCount(countText || 1);
  const rewards = [];
  for (const rawKind of kinds) {
    const kind = normalizeAllKind(rawKind);
    const type = rewardTypeForKind(kind);
    const ids = idsForKind(kind);
    if (!type || !ids.length) return { ok: false, error: `No ids available for "${rawKind}".` };
    for (const id of ids) rewards.push({ rewardType: type, id, count: clampCountForType(type, count) });
  }
  return {
    ok: true,
    rewards,
    title: "Admin Bulk Delivery",
    contents: `Admin queued ${rewards.length} reward line${rewards.length === 1 ? "" : "s"}.`,
  };
}

function createAdminRewardPosts(user, rewards, title, contents) {
  const state = ensureAdminState(user);
  const chunks = [];
  for (let index = 0; index < rewards.length; index += ADMIN_MAX_REWARDS_PER_MAIL) {
    chunks.push(rewards.slice(index, index + ADMIN_MAX_REWARDS_PER_MAIL));
  }
  const posts = [];
  for (const chunk of chunks) {
    const postIndex = allocatePostIndex(state);
    const post = {
      postId: ADMIN_POST_ID,
      postIndex: postIndex.toString(),
      title: title || "Admin Delivery",
      contents: contents || summarizeRewards(chunk),
      sendDate: String(dateTimeBinaryNow()),
      expirationDate: String(farFutureDateTimeBinary()),
      rewards: chunk.map(normalizeRewardSpec).filter(Boolean),
      received: false,
    };
    state.posts.push(post);
    posts.push(post);
  }
  return posts;
}

function createAdminInfoPost(ctx, user, title, contents) {
  const state = ensureAdminState(user);
  const postIndex = allocatePostIndex(state);
  const post = {
    postId: ADMIN_POST_ID,
    postIndex: postIndex.toString(),
    title: title || "Admin Notice",
    contents: contents || "",
    sendDate: String(currentAdminDateTimeBinary(ctx)),
    expirationDate: String(farFutureDateTimeBinary()),
    rewards: [],
    received: false,
  };
  state.posts.push(post);
  return post;
}

function clearAdminInbox(user) {
  const state = ensureAdminState(user);
  let clearedPosts = 0;
  let clearedRewardLines = 0;
  state.posts = state.posts.filter((post) => {
    if (post.received) return true;
    clearedPosts += 1;
    clearedRewardLines += Array.isArray(post.rewards) ? post.rewards.length : 0;
    return false;
  });
  state.pendingGearOverride = null;

  if (!clearedPosts) {
    return { reply: "Inbox is already clear.", createdPosts: 0, clearedPosts: 0, clearedRewardLines: 0 };
  }
  return {
    reply: `Cleared ${clearedRewardLines} reward line${clearedRewardLines === 1 ? "" : "s"} from ${clearedPosts} inbox mail${clearedPosts === 1 ? "" : "s"}.`,
    createdPosts: 0,
    clearedPosts,
    clearedRewardLines,
  };
}

function handleClearInventoryCommand(user, tokens) {
  const parsed = parseClearInventoryCommand(tokens);
  if (!parsed.ok) return { reply: parsed.error, createdPosts: 0 };

  const result = clearInventoryItems(user, parsed);
  const filterText = describeClearInventoryFilters(parsed);
  const untouchedText = "Gear, skins, units, ships, and operators were not touched.";
  console.log(
    `[admin:clear-inventory] filter=${filterText} itemStacks=${result.removedItemStacks} totalCount=${result.removedItemCount}`
  );

  if (!result.removedItemStacks) {
    return {
      reply: `No inventory items matched ${filterText}. ${untouchedText}`,
      createdPosts: 0,
    };
  }

  return {
    reply: `Cleared ${result.removedItemStacks} inventory item stack${result.removedItemStacks === 1 ? "" : "s"} (${result.removedItemCount} total item${result.removedItemCount === "1" ? "" : "s"}). ${untouchedText}`,
    createdPosts: 0,
  };
}

function parseClearInventoryCommand(tokens) {
  const input = Array.isArray(tokens) ? tokens : [];
  const filters = [];
  const itemIds = new Set();
  const labels = [];

  for (let index = 0; index < input.length; index += 1) {
    const raw = String(input[index] || "").trim();
    const normalized = normalizeClearInventoryFilterToken(raw);
    if (normalized === "help" || normalized === "?") return { ok: false, error: clearInventoryHelpText() };
    if (CLEAR_INVENTORY_IGNORED_FILTERS.has(normalized) || normalized === "all" || normalized === "everything") continue;

    const keyValue = splitCommandKeyValue(raw);
    if (keyValue && ["id", "ids", "itemid", "itemids"].includes(normalizeClearInventoryFilterToken(keyValue.key))) {
      const ids = parseClearInventoryIds(keyValue.value);
      if (!ids.length) return { ok: false, error: `No valid item IDs found in "${raw}".\n${clearInventoryHelpText()}` };
      for (const id of ids) itemIds.add(id);
      labels.push(`IDs ${ids.join(", ")}`);
      continue;
    }
    if (["id", "ids", "itemid", "itemids"].includes(normalized)) {
      const ids = parseClearInventoryIds(input[index + 1]);
      if (!ids.length) return { ok: false, error: `No valid item IDs found after "${raw}".\n${clearInventoryHelpText()}` };
      index += 1;
      for (const id of ids) itemIds.add(id);
      labels.push(`IDs ${ids.join(", ")}`);
      continue;
    }

    if (keyValue && ["type", "itemtype", "misctype"].includes(normalizeClearInventoryFilterToken(keyValue.key))) {
      const type = normalizeMiscItemTypeFilter(keyValue.value);
      if (!type) return { ok: false, error: `No valid item type found in "${raw}".\n${clearInventoryHelpText()}` };
      filters.push({ kind: "type", types: [type] });
      labels.push(type);
      continue;
    }
    if (["type", "itemtype", "misctype"].includes(normalized)) {
      const type = normalizeMiscItemTypeFilter(input[index + 1]);
      if (!type) return { ok: false, error: `No valid item type found after "${raw}".\n${clearInventoryHelpText()}` };
      index += 1;
      filters.push({ kind: "type", types: [type] });
      labels.push(type);
      continue;
    }

    const inlineIds = parseClearInventoryIds(raw);
    if (inlineIds.length) {
      for (const id of inlineIds) itemIds.add(id);
      labels.push(`IDs ${inlineIds.join(", ")}`);
      continue;
    }

    if (normalized === "timed" || normalized === "time" || normalized === "temporary" || normalized === "temp") {
      filters.push({ kind: "timed" });
      labels.push("timed items");
      continue;
    }

    const typeFilter = CLEAR_INVENTORY_TYPE_FILTERS[normalized];
    if (typeFilter) {
      filters.push({ kind: "type", types: typeFilter });
      labels.push(typeFilterLabel(normalized));
      continue;
    }

    if (/^imt[a-z0-9_]*$/i.test(normalized)) {
      const type = normalizeMiscItemTypeFilter(raw);
      filters.push({ kind: "type", types: [type] });
      labels.push(type);
      continue;
    }

    return { ok: false, error: `Unknown inventory clear filter: ${raw}\n${clearInventoryHelpText()}` };
  }

  return {
    ok: true,
    filters,
    itemIds,
    labels,
    clearAll: filters.length === 0 && itemIds.size === 0,
  };
}

function clearInventoryItems(user, options = {}) {
  const inventory = ensureInventory(user);
  let removedItemStacks = 0;
  let removedItemCount = 0n;
  const removedItemIds = [];

  for (const [key, item] of Object.entries(inventory.misc || {})) {
    const itemId = Number((item && item.itemId) || key);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    if (!matchesClearInventoryFilter(item, itemId, options)) continue;
    removedItemStacks += 1;
    removedItemCount += inventoryItemTotalCount(item);
    removedItemIds.push(itemId);
    delete inventory.misc[key];
  }

  if (removedItemStacks) inventory.localTouchedAt = new Date().toISOString();
  return {
    removedItemStacks,
    removedItemCount: removedItemCount.toString(),
    removedItemIds,
  };
}

function matchesClearInventoryFilter(item, itemId, options = {}) {
  if (options.clearAll) return true;
  if (options.itemIds && options.itemIds.has(Number(itemId))) return true;
  const templet = getMiscItemTemplet(itemId) || {};
  for (const filter of options.filters || []) {
    if (!filter || typeof filter !== "object") continue;
    if (filter.kind === "timed" && isTimedInventoryItem(item)) return true;
    if (filter.kind === "type" && miscItemTypeMatches(templet, filter.types, itemId)) return true;
  }
  return false;
}

function miscItemTypeMatches(templet, types, itemId) {
  const itemType = String(templet && templet.m_ItemMiscType || "").toUpperCase();
  const normalizedTypes = Array.isArray(types) ? types.map((type) => String(type || "").toUpperCase()).filter(Boolean) : [];
  if (normalizedTypes.includes("IMT_RESOURCE") && CLEAR_INVENTORY_RESOURCE_IDS.has(Number(itemId))) return true;
  return normalizedTypes.some((type) => (type.endsWith("_") ? itemType.startsWith(type) : itemType === type));
}

function isTimedInventoryItem(item) {
  if (!item || typeof item !== "object") return false;
  for (const [key, value] of Object.entries(item)) {
    if (!/expire|expiration|validuntil|enddate|endtime|duration|period/i.test(String(key || ""))) continue;
    if (hasMeaningfulInventoryTimingValue(value)) return true;
  }
  return false;
}

function hasMeaningfulInventoryTimingValue(value) {
  if (value == null || value === false) return false;
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string") {
    const text = value.trim();
    return text !== "" && text !== "0" && text.toLowerCase() !== "false";
  }
  if (Array.isArray(value)) return value.some(hasMeaningfulInventoryTimingValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulInventoryTimingValue);
  return Boolean(value);
}

function inventoryItemTotalCount(item) {
  const total = toBigInt(item && item.countFree) + toBigInt(item && item.countPaid);
  return total > 0n ? total : 0n;
}

function describeClearInventoryFilters(parsed) {
  if (parsed.clearAll) return "all misc inventory items";
  const labels = [];
  for (const label of parsed.labels || []) {
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length ? labels.join(", ") : "matching misc inventory items";
}

function typeFilterLabel(token) {
  switch (normalizeClearInventoryFilterToken(token)) {
    case "selector":
    case "selectors":
    case "selectable":
    case "choice":
    case "choices":
      return "selectors";
    case "box":
    case "boxes":
    case "random":
    case "randombox":
    case "randomboxes":
      return "random boxes";
    case "pack":
    case "packs":
    case "package":
    case "packages":
      return "packages";
    case "resource":
    case "resources":
    case "currency":
    case "currencies":
      return "resources";
    default:
      return normalizeClearInventoryFilterToken(token);
  }
}

function splitCommandKeyValue(value) {
  const text = String(value || "");
  const match = text.match(/^([^=:]+)[:=](.+)$/);
  return match ? { key: match[1], value: match[2] } : null;
}

function parseClearInventoryIds(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(/[,\s]+/g)
        .map((part) => Number(part.trim()))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );
}

function normalizeMiscItemTypeFilter(value) {
  const text = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return /^IMT_[A-Z0-9_]+$/.test(text) ? text : "";
}

function normalizeClearInventoryFilterToken(value) {
  return String(value || "").trim().toLowerCase().replace(/^--?/, "").replace(/[\s_-]+/g, "");
}

function handleServerTimeCommand(ctx, user, tokens) {
  const subcommand = String(tokens && tokens[0] || "").trim().toLowerCase();
  if (subcommand === "reset" || subcommand === "clear" || subcommand === "auto") {
    tokens.shift();
    const restored = clearServerTimeOverride(ctx);
    const contents = formatServerTimeStatus(ctx, restored, "Manual server time override cleared.");
    createAdminInfoPost(ctx, user, "Server Time Reset", contents);
    return {
      reply: "Server time override cleared. I sent the current server time to Mail.",
      createdPosts: 1,
      postListNotify: true,
    };
  }

  if (subcommand === "set" || subcommand === "to" || looksLikeDateToken(subcommand)) {
    const rawTokens = subcommand === "set" || subcommand === "to" ? tokens.slice(1) : tokens;
    const parsed = parseServerTimeInput(rawTokens);
    if (!parsed.ok) {
      return { reply: `${parsed.error}\n${serverTimeHelpText()}`, createdPosts: 0 };
    }
    let updated;
    try {
      updated = setServerTimeOverride(ctx, parsed.date);
    } catch (error) {
      return { reply: `Could not set server time: ${error.message}`, createdPosts: 0 };
    }
    const contents = formatServerTimeStatus(ctx, updated, `Server time set from command input: ${parsed.raw}`);
    createAdminInfoPost(ctx, user, "Server Time Updated", contents);
    return {
      reply: `Server time set to ${updated.toISOString()}. I sent a confirmation to Mail.`,
      createdPosts: 1,
      postListNotify: true,
    };
  }

  const contents = formatServerTimeStatus(ctx, getAdminServerDate(ctx), "Current server clock snapshot.");
  createAdminInfoPost(ctx, user, "Current Server Time", contents);
  return {
    reply: "I sent the current server date and time to Mail.",
    createdPosts: 1,
    postListNotify: true,
  };
}

function currentAdminDateTimeBinary(ctx) {
  if (ctx && typeof ctx.dateTimeBinaryNow === "function") {
    try {
      return ctx.dateTimeBinaryNow();
    } catch (_) {
      // Fall back to the packet-codec real-time helper if the runtime clock is unavailable.
    }
  }
  return dateTimeBinaryNow();
}

function getAdminServerDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const date = ctx.getServerNowDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function setServerTimeOverride(ctx, date) {
  if (ctx && typeof ctx.setServerTime === "function") {
    const updated = ctx.setServerTime(date);
    if (updated instanceof Date && !Number.isNaN(updated.getTime())) return updated;
  }
  if (ctx && ctx.serverTime && typeof ctx.serverTime.setManualTime === "function") {
    return ctx.serverTime.setManualTime(date);
  }
  throw new Error("Server time manager is unavailable.");
}

function clearServerTimeOverride(ctx) {
  if (ctx && typeof ctx.clearServerTime === "function") {
    const restored = ctx.clearServerTime();
    if (restored instanceof Date && !Number.isNaN(restored.getTime())) return restored;
  }
  if (ctx && ctx.serverTime && typeof ctx.serverTime.clearManualTime === "function") {
    return ctx.serverTime.clearManualTime();
  }
  return getAdminServerDate(ctx);
}

function formatServerTimeStatus(ctx, serverDate, prefix) {
  const date = serverDate instanceof Date && !Number.isNaN(serverDate.getTime()) ? serverDate : getAdminServerDate(ctx);
  const summary =
    ctx && ctx.serverTime && typeof ctx.serverTime.getSummary === "function" ? ctx.serverTime.getSummary() : null;
  const eventDateKey =
    ctx && typeof ctx.getServerEventDateKey === "function" ? ctx.getServerEventDateKey() : date.toISOString().slice(0, 10);
  const lines = [];
  if (prefix) lines.push(prefix);
  lines.push(`Server time: ${date.toISOString()}`);
  lines.push(`Date key: ${eventDateKey || date.toISOString().slice(0, 10)}`);
  if (summary && summary.mode) lines.push(`Mode: ${summary.mode}`);
  lines.push(`DateTimeBinary: ${currentAdminDateTimeBinary(ctx)}`);
  return lines.join("\n");
}

function parseServerTimeInput(tokens) {
  const raw = Array.isArray(tokens) ? tokens.join(" ").trim() : String(tokens || "").trim();
  if (!raw) return { ok: false, error: "Missing time value." };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T12:00:00.000Z`);
    return validParsedDate(date) ? { ok: true, date, raw: `${raw} 12:00:00Z` } : { ok: false, error: "Invalid date." };
  }

  const dateTimeMatch = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i
  );
  if (dateTimeMatch) {
    const time = dateTimeMatch[2].length === 5 ? `${dateTimeMatch[2]}:00` : dateTimeMatch[2];
    const zone = dateTimeMatch[3] || "Z";
    const date = new Date(`${dateTimeMatch[1]}T${time}${zone}`);
    return validParsedDate(date) ? { ok: true, date, raw } : { ok: false, error: "Invalid date/time." };
  }

  const normalized = raw.replace(/\s+/, "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const date = new Date(hasZone ? normalized : `${normalized}Z`);
  if (!validParsedDate(date)) return { ok: false, error: `Could not parse server time "${raw}".` };
  return { ok: true, date, raw };
}

function looksLikeDateToken(value) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(value || ""));
}

function validParsedDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function ensureLoginRewardPosts(user, options = {}) {
  if (!user || typeof user !== "object") return 0;
  const state = ensureAdminState(user);
  state.loginRewards =
    state.loginRewards && typeof state.loginRewards === "object" && !Array.isArray(state.loginRewards)
      ? state.loginRewards
      : {};

  const rewardState = state.loginRewards;
  const now = options.now instanceof Date ? options.now : new Date();
  const dateKey = normalizeDateKey(options.dateKey || now);
  let createdPosts = 0;

  if (process.env.CS_DISABLE_NEWBIE_REWARD_MAIL !== "1" && !rewardState.newbieQueued) {
    const rewards = configuredRewardList("CS_NEWBIE_REWARDS", DEFAULT_NEWBIE_REWARDS);
    if (rewards.length) {
      createdPosts += createAdminRewardPosts(
        user,
        rewards,
        process.env.CS_NEWBIE_REWARD_TITLE || "New Administrator Support",
        process.env.CS_NEWBIE_REWARD_CONTENTS || "Welcome aboard. These supplies have been delivered to help your company get started."
      ).length;
      rewardState.newbieQueued = true;
      rewardState.newbieQueuedAt = now.toISOString();
    }
  }

  if (process.env.CS_DISABLE_SIGN_IN_REWARD_MAIL !== "1" && rewardState.lastSignInDate !== dateKey) {
    const rewards = configuredRewardList("CS_SIGN_IN_REWARDS", DEFAULT_SIGN_IN_REWARDS);
    if (rewards.length) {
      createdPosts += createAdminRewardPosts(
        user,
        rewards,
        process.env.CS_SIGN_IN_REWARD_TITLE || "Daily Sign-In Reward",
        process.env.CS_SIGN_IN_REWARD_CONTENTS || "Thanks for checking in today. Your daily supplies are ready to claim."
      ).length;
      rewardState.lastSignInDate = dateKey;
      rewardState.lastSignInQueuedAt = now.toISOString();
    }
  }

  return createdPosts;
}

function grantPostRewards(ctx, user, post) {
  const total = createEmptyReward();
  const regDate = ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow();
  for (const reward of post && Array.isArray(post.rewards) ? post.rewards : []) {
    const options = {
      expandPackages: true,
      regDate,
    };
    const gearOptions = normalizeRewardType(reward.rewardType) === "RT_EQUIP" ? normalizeGearRewardOptions(reward.gearOptions) : null;
    if (gearOptions) Object.assign(options, gearOptions);
    mergeReward(
      total,
      grantRewardByType(ctx, user, reward.rewardType, reward.id, reward.count, reward.count, 0, options)
    );
  }
  return total;
}

function buildPostData(post) {
  const rewards = post.rewards || [];
  return Buffer.concat([
    writeSignedVarInt(Number(post.postId || ADMIN_POST_ID) || 0),
    writeSignedVarLong(toBigInt(post.postIndex || 0)),
    writeString(post.title || "Admin Delivery"),
    writeString(post.contents || summarizeRewards(rewards)),
    writeInt64FromStoredDate(post.sendDate),
    writeObjectList(rewards.map((reward) => writeNullableObject(buildRewardInfoData(reward)))),
    writeInt64FromStoredDate(post.expirationDate || farFutureDateTimeBinary()),
  ]);
}

function buildPostListNot(ctx, user, posts) {
  const visible = (Array.isArray(posts) ? posts : []).filter((post) => post && !post.received && !isPostExpired(ctx, post));
  return Buffer.concat([
    writeObjectList(visible.map((post) => writeNullableObject(buildPostData(post)))),
    writeSignedVarInt(countPendingPosts(ctx, user)),
  ]);
}

function buildRewardInfoData(reward) {
  const spec = normalizeRewardSpec(reward) || {};
  return Buffer.concat([
    writeSignedVarInt(REWARD_TYPE_ENUM[spec.rewardType] != null ? REWARD_TYPE_ENUM[spec.rewardType] : 0),
    writeSignedVarInt(0),
    writeSignedVarInt(Number(spec.id || 0) || 0),
    writeSignedVarInt(Number(spec.count || 1) || 1),
  ]);
}

function buildPrivateChatNot(message) {
  return writeNullableObject(buildChatMessageData(message));
}

function buildPrivateChatListData(profile, lastMessage) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(profile)),
    writeNullableObject(buildChatMessageData(lastMessage || buildEmptyChatMessage(profile))),
  ]);
}

function buildChatMessageData(message) {
  const data = message || buildEmptyChatMessage(getAdminProfile());
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.messageUid || 0)),
    writeSignedVarInt(Number(data.messageType || 0) || 0),
    writeNullableObject(buildCommonProfileData(data.profile || getAdminProfile())),
    writeSignedVarInt(Number(data.emotionId || 0) || 0),
    writeString(data.message || ""),
    writeInt64FromStoredDate(data.createdAt || dateTimeBinaryNow()),
    writeSignedVarLong(toBigInt(data.typeParam || 0)),
    writeBool(Boolean(data.blocked)),
  ]);
}

function buildCommonProfileData(profile) {
  const data = profile || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.userUid || 0)),
    writeSignedVarLong(toBigInt(data.friendCode || 0)),
    writeString(data.nickname || ""),
    writeSignedVarInt(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.mainUnitId || 0) || 0),
    writeSignedVarInt(Number(data.mainUnitSkinId || 0) || 0),
    writeSignedVarInt(Number(data.frameId || 0) || 0),
    writeSignedVarInt(Number(data.mainUnitTacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.titleId || 0) || 0),
  ]);
}

function buildUserChatMessage(ctx, user, messageUid, message, emotionId = 0) {
  return {
    messageUid: String(messageUid),
    messageType: 0,
    profile: getUserProfile(user),
    emotionId: Number(emotionId || 0) || 0,
    message,
    createdAt: String(getChatTimestamp(ctx)),
    typeParam: "0",
    blocked: false,
  };
}

function buildAdminChatMessage(message, messageUid = 0, createdAt = dateTimeBinaryNow()) {
  return {
    messageUid: String(messageUid),
    messageType: 0,
    profile: getAdminProfile(),
    emotionId: 0,
    message,
    createdAt: String(createdAt),
    typeParam: "0",
    blocked: false,
  };
}

function buildEmptyChatMessage(profile) {
  return {
    messageUid: "0",
    messageType: 0,
    profile,
    emotionId: 0,
    message: "",
    createdAt: "0",
    typeParam: "0",
    blocked: false,
  };
}

function appendChatMessage(user, roomUid, message) {
  const state = ensureAdminState(user);
  const roomKey = String(toBigInt(roomUid));
  state.chats[roomKey] = Array.isArray(state.chats[roomKey]) ? state.chats[roomKey] : [];
  const stored = {
    ...message,
    messageUid: message.messageUid === "0" ? allocateMessageUid(state).toString() : String(message.messageUid),
  };
  state.chats[roomKey].push(stored);
  if (state.chats[roomKey].length > CHAT_HISTORY_LIMIT) {
    state.chats[roomKey] = state.chats[roomKey].slice(-CHAT_HISTORY_LIMIT);
  }
  return stored;
}

function getChatMessages(user, roomUid) {
  const state = ensureAdminState(user);
  return (state.chats[String(toBigInt(roomUid))] || []).slice(-CHAT_HISTORY_LIMIT);
}

function getLastAdminChatMessage(user) {
  ensureAdminWelcome(user);
  const messages = getChatMessages(user, ADMIN_UID);
  return messages[messages.length - 1] || buildAdminChatMessage("Admin console ready. Type /help.");
}

function getLastChatMessage(user, roomUid) {
  const messages = getChatMessages(user, roomUid);
  return messages[messages.length - 1] || null;
}

function ensureAdminWelcome(user) {
  const state = ensureAdminState(user);
  const roomKey = ADMIN_UID.toString();
  state.chats[roomKey] = Array.isArray(state.chats[roomKey]) ? state.chats[roomKey] : [];
  if (state.chats[roomKey].length) return false;
  appendChatMessage(user, ADMIN_UID, buildAdminChatMessage("Admin console ready. Type /help for commands."));
  return true;
}

function ensureAdminState(user) {
  if (!user || typeof user !== "object") return { posts: [], chats: {}, nextPostIndex: "1", nextMessageUid: "1" };
  user.admin = user.admin && typeof user.admin === "object" ? user.admin : {};
  user.admin.posts = Array.isArray(user.admin.posts) ? user.admin.posts : [];
  user.admin.chats = user.admin.chats && typeof user.admin.chats === "object" ? user.admin.chats : {};
  user.admin.loginRewards =
    user.admin.loginRewards && typeof user.admin.loginRewards === "object" && !Array.isArray(user.admin.loginRewards)
      ? user.admin.loginRewards
      : {};
  user.admin.nextPostIndex = String(toBigInt(user.admin.nextPostIndex || 1, 1n));
  user.admin.nextMessageUid = String(toBigInt(user.admin.nextMessageUid || 1, 1n));
  user.admin.posts = user.admin.posts.map(normalizePost).filter(Boolean);
  return user.admin;
}

function normalizePost(post) {
  if (!post || typeof post !== "object") return null;
  const postIndex = toBigInt(post.postIndex || 0);
  if (postIndex <= 0n) return null;
  return {
    postId: Number(post.postId || ADMIN_POST_ID) || 0,
    postIndex: postIndex.toString(),
    title: String(post.title || "Admin Delivery"),
    contents: String(post.contents || ""),
    sendDate: String(toBigInt(post.sendDate || dateTimeBinaryNow())),
    expirationDate: String(toBigInt(post.expirationDate || farFutureDateTimeBinary())),
    rewards: (Array.isArray(post.rewards) ? post.rewards : []).map(normalizeRewardSpec).filter(Boolean),
    received: Boolean(post.received),
    receivedAt: post.receivedAt ? String(post.receivedAt) : undefined,
  };
}

function normalizeRewardSpec(reward) {
  if (!reward || typeof reward !== "object") return null;
  const rewardType = normalizeRewardType(reward.rewardType);
  const id = Number(reward.id || reward.rewardId || reward.ID || 0);
  const count = normalizeRewardCount(reward.count || reward.Count || 1);
  if (!rewardType || !Number.isInteger(id) || id <= 0 || count <= 0) return null;
  const spec = { rewardType, id, count };
  if (rewardType === "RT_EQUIP") {
    const gearOptions = normalizeGearRewardOptions(reward.gearOptions || reward.options || reward.equipOptions);
    if (gearOptions) spec.gearOptions = gearOptions;
  }
  return spec;
}

function normalizeGearRewardOptions(options) {
  if (!options || typeof options !== "object") return null;
  const normalized = {};
  const setOptionId = Number(options.setOptionId || options.setId || options.equipSetId || options.setBonusId || 0);
  if (Number.isInteger(setOptionId) && setOptionId > 0) normalized.setOptionId = setOptionId;
  const customMainStat = normalizeGearRewardMainStat(options.customMainStat || options.mainStat);
  if (customMainStat) normalized.customMainStat = customMainStat;
  const customSubstats = (Array.isArray(options.customSubstats) ? options.customSubstats : [])
    .map((substat, index) => normalizeGearRewardSubstat(substat, index + 1))
    .filter(Boolean)
    .slice(0, 2);
  if (customSubstats.length) normalized.customSubstats = customSubstats;
  if (options.overrideUnsupportedSubstats === true || options.forceUnsupportedSubstats === true) {
    normalized.overrideUnsupportedSubstats = true;
  }
  if (options.overrideUnsupportedSetBonus === true || options.forceUnsupportedSetBonus === true) {
    normalized.overrideUnsupportedSetBonus = true;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizeGearRewardMainStat(mainStat) {
  if (!mainStat || typeof mainStat !== "object") return null;
  const rawType = mainStat.type || mainStat.statType || mainStat.m_StatType;
  const type = isDefaultGearMainStatType(rawType) || String(rawType || "").toUpperCase() === "DEFAULT"
    ? "DEFAULT"
    : resolveGearStatType(rawType);
  if (!type) return null;
  const valueKind = String(mainStat.valueKind || "").toLowerCase() === "max" ? "max" : "custom";
  const sourceValue = mainStat.value != null ? mainStat.value : mainStat.statValue;
  const value = valueKind === "max" ? null : Number(sourceValue);
  if (valueKind !== "max" && !Number.isFinite(value)) return null;
  const normalized = { type, valueKind, value };
  const levelValueKind = String(mainStat.levelValueKind || "").toLowerCase() === "max" ? "max" : "custom";
  const sourceLevelValue =
    mainStat.levelValue != null
      ? mainStat.levelValue
      : mainStat.statLevelValue != null
        ? mainStat.statLevelValue
        : mainStat.levelupValue;
  if (levelValueKind === "max") {
    normalized.levelValueKind = "max";
    normalized.levelValue = null;
  } else if (sourceLevelValue != null) {
    const levelValue = Number(sourceLevelValue);
    if (Number.isFinite(levelValue)) {
      normalized.levelValueKind = "custom";
      normalized.levelValue = levelValue;
    }
  }
  return normalized;
}

function normalizeGearRewardSubstat(substat, fallbackSlot) {
  if (!substat || typeof substat !== "object") return null;
  const slot = Number(substat.slot || substat.Slot || fallbackSlot);
  if (slot !== 1 && slot !== 2) return null;
  const type = resolveGearStatType(substat.type || substat.statType || substat.m_StatType);
  if (!type) return null;
  const valueKind = String(substat.valueKind || "").toLowerCase() === "max" ? "max" : "custom";
  const sourceValue = substat.value != null ? substat.value : substat.statValue;
  const value = valueKind === "max" ? null : Number(sourceValue);
  if (valueKind !== "max" && !Number.isFinite(value)) return null;
  const normalized = { slot, type, valueKind, value };
  const levelValue = Number(substat.levelValue != null ? substat.levelValue : substat.statLevelValue);
  if (Number.isFinite(levelValue)) normalized.levelValue = levelValue;
  return normalized;
}

function configuredRewardList(envName, fallback) {
  const parsed = parseConfiguredRewardList(process.env[envName]);
  const source = parsed.length ? parsed : fallback;
  return source.map(normalizeConfiguredReward).filter(Boolean);
}

function parseConfiguredRewardList(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.log(`[admin] ignored ${text.slice(0, 32)} reward config: ${err.message}`);
      return [];
    }
  }
  return text
    .split(/[;,]/)
    .map((entry) => parseRewardToken(entry))
    .filter(Boolean);
}

function parseRewardToken(entry) {
  const parts = String(entry || "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length === 2) return { kind: "currency", id: parts[0], count: parts[1] };
  return { kind: parts[0], id: parts[1], count: parts[2] };
}

function normalizeConfiguredReward(value) {
  const source = value && typeof value === "object" ? value : {};
  if (source.rewardType) return validateConfiguredReward(normalizeRewardSpec(source));

  const kind = source.kind || source.type || "currency";
  const rewardType = normalizeRewardType(kind) || rewardTypeForKind(kind);
  const id = resolveRewardId(kind, source.id || source.rewardId || source.ID);
  return validateConfiguredReward(normalizeRewardSpec({ rewardType, id, count: source.count || source.Count || 1 }));
}

function validateConfiguredReward(reward) {
  if (!reward) return null;
  if (rewardIdExists(reward.rewardType, reward.id)) return reward;
  if (reward.rewardType === "RT_MISC" && Object.values(RESOURCE_ITEM_IDS).includes(reward.id)) return reward;
  console.log(`[admin] skipped configured reward with missing local table entry: ${describeReward(reward)}`);
  return null;
}

function envRewardCount(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function normalizeDateKey(value) {
  if (value instanceof Date) return formatLocalDateKey(value);
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? formatLocalDateKey(new Date()) : formatLocalDateKey(date);
}

function formatLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function listVisiblePosts(ctx, user, lastPostIndex = 0) {
  const last = toBigInt(lastPostIndex || 0);
  return ensureAdminState(user).posts
    .filter((post) => !post.received && !isPostExpired(ctx, post))
    .filter((post) => last <= 0n || toBigInt(post.postIndex) < last)
    .sort((a, b) => Number(toBigInt(b.postIndex) - toBigInt(a.postIndex)))
    .slice(0, 50);
}

function countPendingPosts(ctx, user) {
  return ensureAdminState(user).posts.filter((post) => !post.received && !isPostExpired(ctx, post)).length;
}

function isPostExpired(ctx, post) {
  const expiration = toBigInt(post && post.expirationDate || 0);
  return expiration > 0n && expiration < toBigInt(getChatTimestamp(ctx));
}

function canReceivePost(user, post) {
  const demand = postInventoryDemand(post);
  return Object.entries(demand).every(([inventoryType, count]) =>
    getInventoryUsage(user, Number(inventoryType)) + count <= getInventoryCapacity(user, Number(inventoryType))
  );
}

function postInventoryDemand(post) {
  const demand = {};
  const add = (type, count) => {
    demand[type] = Number(demand[type] || 0) + Math.max(0, Number(count || 0) || 0);
  };
  for (const reward of post && Array.isArray(post.rewards) ? post.rewards : []) {
    const type = normalizeRewardType(reward.rewardType);
    const count = Math.max(0, Number(reward.count || 0) || 0);
    if (type === "RT_EQUIP") add(INVENTORY_TYPES.EQUIP, count);
    if (type === "RT_SHIP") add(INVENTORY_TYPES.SHIP, count);
    if (type === "RT_OPERATOR") add(INVENTORY_TYPES.OPERATOR, count);
    if (type === "RT_UNIT") add(trophyUnitIds.has(Number(reward.id)) ? INVENTORY_TYPES.TROPHY : INVENTORY_TYPES.UNIT, count);
  }
  return demand;
}

function allocatePostIndex(state) {
  let next = toBigInt(state.nextPostIndex || 1, 1n);
  const used = new Set((state.posts || []).map((post) => String(toBigInt(post.postIndex))));
  while (used.has(next.toString())) next += 1n;
  state.nextPostIndex = (next + 1n).toString();
  return next;
}

function allocateMessageUid(state) {
  const next = toBigInt(state.nextMessageUid || 1, 1n);
  state.nextMessageUid = (next + 1n).toString();
  return next;
}

function getAdminProfile() {
  return {
    userUid: ADMIN_UID.toString(),
    friendCode: ADMIN_FRIEND_CODE.toString(),
    nickname: ADMIN_NICKNAME,
    level: 99,
    mainUnitId: ADMIN_MAIN_UNIT_ID,
    mainUnitSkinId: 0,
    frameId: 0,
    mainUnitTacticLevel: 0,
    titleId: 0,
  };
}

function getUserProfile(user) {
  return {
    userUid: String(toBigInt(user && user.userUid || 0)),
    friendCode: String(toBigInt(user && user.friendCode || 0)),
    nickname: String((user && user.nickname) || "LocalAdmin"),
    level: Number((user && user.level) || 1) || 1,
    mainUnitId: Number((user && user.mainUnitId) || 0),
    mainUnitSkinId: Number((user && user.mainUnitSkinId) || 0),
    frameId: Number((user && user.frameId) || 0),
    mainUnitTacticLevel: Number((user && user.mainUnitTacticLevel) || 0),
    titleId: Number((user && user.titleId) || 0),
  };
}

function rewardTypeForKind(kind) {
  switch (normalizeKind(kind)) {
    case "currency":
    case "item":
      return "RT_MISC";
    case "unit":
      return "RT_UNIT";
    case "trophy":
      return "RT_UNIT";
    case "ship":
      return "RT_SHIP";
    case "operator":
      return "RT_OPERATOR";
    case "gear":
      return "RT_EQUIP";
    case "mold":
      return "RT_MOLD";
    case "skin":
      return "RT_SKIN";
    case "emoticon":
      return "RT_EMOTICON";
    default:
      return "";
  }
}

function normalizeKind(kind) {
  const value = String(kind || "").toLowerCase().replace(/[_\s-]+/g, "");
  if (["currency", "curr", "resource", "resources", "money"].includes(value)) return "currency";
  if (["item", "items", "misc", "miscitem", "miscitems"].includes(value)) return "item";
  if (["unit", "units", "character", "characters", "employee", "employees"].includes(value)) return "unit";
  if (["trophy", "trophies", "trainer", "trainers"].includes(value)) return "trophy";
  if (["ship", "ships"].includes(value)) return "ship";
  if (["operator", "operators", "op", "ops"].includes(value)) return "operator";
  if (["gear", "gears", "equip", "equips", "equipment"].includes(value)) return "gear";
  if (["mold", "molds", "craftmold", "craftmolds"].includes(value)) return "mold";
  if (["skin", "skins"].includes(value)) return "skin";
  if (["emoticon", "emoticons", "emote", "emotes"].includes(value)) return "emoticon";
  return value;
}

function normalizeAllKind(kind) {
  return normalizeKind(kind);
}

function resolveRewardId(kind, idText) {
  const normalizedKind = normalizeKind(kind);
  const text = String(idText || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (normalizedKind === "currency" && CURRENCY_ALIASES[text] != null) return CURRENCY_ALIASES[text];
  return Number(idText);
}

function idsForKind(kind) {
  switch (normalizeKind(kind)) {
    case "currency":
      return Object.values(RESOURCE_ITEM_IDS);
    case "item":
      return getAllMiscItemIds();
    case "unit":
      return getPlayableUnitIds();
    case "trophy":
      return getTrophyUnitIds();
    case "ship":
      return getPlayableShipIds();
    case "operator":
      return getPlayableOperatorIds();
    case "gear":
      return getAllEquipIds();
    case "mold":
      return getAllEquipMoldTemplets().map((entry) => Number(entry && entry.m_MoldID)).filter((id) => id > 0);
    case "skin":
      return getAllSkinIds();
    case "emoticon":
      return getAllEmoticonIds();
    default:
      return [];
  }
}

function rewardIdExists(rewardType, id) {
  switch (normalizeRewardType(rewardType)) {
    case "RT_MISC":
      return Boolean(getMiscItemTemplet(id));
    case "RT_UNIT":
    case "RT_SHIP":
    case "RT_OPERATOR":
      return Boolean(getUnitTemplet(id));
    case "RT_EQUIP":
      return Boolean(getEquipTemplet(id));
    case "RT_MOLD":
      return Boolean(getEquipMoldTemplet(id));
    case "RT_SKIN":
      return Boolean(getSkinTemplet(id));
    case "RT_EMOTICON":
      return Boolean(getEmoticonTemplet(id));
    default:
      return false;
  }
}

function isTrophyUnitId(id) {
  const templet = getUnitTemplet(id);
  return Boolean(templet && String(templet.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER");
}

function normalizeRewardType(type) {
  const value = String(type || "").toUpperCase();
  if (value === "RT_ITEM_MISC" || value === "RT_RESOURCE") return "RT_MISC";
  if (value === "RT_ITEM_EQUIP" || value === "RT_EQUIP_ITEM") return "RT_EQUIP";
  return REWARD_TYPE_ENUM[value] != null ? value : "";
}

function clampCountForType(rewardType, count) {
  const value = normalizeRewardCount(count);
  if (rewardType === "RT_SKIN" || rewardType === "RT_EMOTICON") return 1;
  return value;
}

function normalizeRewardCount(value) {
  const count = Number(value == null || value === "" ? 1 : value);
  if (!Number.isFinite(count) || count <= 0) return 1;
  return Math.max(1, Math.min(1000000000, Math.trunc(count)));
}

function describeReward(reward) {
  return `${reward.rewardType}:${reward.id} x${reward.count}`;
}

function summarizeRewards(rewards) {
  const list = Array.isArray(rewards) ? rewards : [];
  const shown = list.slice(0, 8).map(describeReward).join(", ");
  return shown + (list.length > 8 ? `, and ${list.length - 8} more` : "");
}

function gearHelpText() {
  const mainRows = buildGearMainStatHelpRows();
  const rows = buildGearSubstatHelpRows();
  const setRows = buildGearSetBonusHelpRows();
  return [
    "Gear main stats:",
    ...mainRows.map((row) => `${row.id} ${row.type} min=${formatHelpStatValue(row.min)} max=${formatHelpStatValue(row.max)} levelMin=${formatHelpStatValue(row.levelMin)} levelMax=${formatHelpStatValue(row.levelMax)}`),
    "",
    "Gear substats:",
    "Global min/max is across all random-stat groups; each gear can support a narrower range.",
    ...rows.map((row) => `${row.id} ${row.type} min=${formatHelpStatValue(row.min)} max=${formatHelpStatValue(row.max)}`),
    "",
    "Gear set bonuses:",
    ...setRows.map((row) => `${row.id} ${row.name} parts=${row.parts} ${row.effects}`),
    "",
    "Usage:",
    "/give maxmaze",
    "/give gear <gearId> [count] [set=<setId|alias>] [main=<stat>=<value|max>] [mainlevel=<value|max>] [substat=value|max] [substat=value|max]",
    "/give gear <gearId> set=hit main=default=max mainlevel=max sub1=7=max sub2=13=0.10",
    "/give gear <gearId> set=221200 main=NST_HP=2279 sub1=NST_CRITICAL_DAMAGE_RATE=max sub2=NST_SKILL_COOL_TIME_REDUCE_RATE=0.10",
    "Use main=default=max to keep the gear's native main stat type and use its native value.",
    "Aliases include atk, hp, def, crit, crit_dmg, aspd, cdr, skill_dmg, ult_dmg.",
    "Unsupported stats or set bonuses will ask for Y/N; Y forces the gear option.",
  ].join("\n");
}

function buildGearMainStatHelpRows() {
  const rows = new Map();
  for (const equipId of getAllEquipIds()) {
    const record = getEquipTemplet(equipId);
    const type = resolveGearStatType(record && record.STAT_TYPE_1);
    if (!type) continue;
    const min = numberOrNull(record && record.STAT_VALUE_1);
    const max = numberOrNull(record && record.STAT_VALUE_1);
    const levelMin = numberOrNull(record && record.STAT_LEVELUP_VALUE_1);
    const levelMax = numberOrNull(record && record.STAT_LEVELUP_VALUE_1);
    const existing = rows.get(type);
    if (!existing) {
      rows.set(type, { type, id: statTypeValue(type), min, max, levelMin, levelMax });
      continue;
    }
    if (min != null) existing.min = existing.min != null ? Math.min(existing.min, min) : min;
    if (max != null) existing.max = existing.max != null ? Math.max(existing.max, max) : max;
    if (levelMin != null) existing.levelMin = existing.levelMin != null ? Math.min(existing.levelMin, levelMin) : levelMin;
    if (levelMax != null) existing.levelMax = existing.levelMax != null ? Math.max(existing.levelMax, levelMax) : levelMax;
  }
  return Array.from(rows.values()).sort((a, b) => (a.id - b.id) || a.type.localeCompare(b.type));
}

function buildGearSubstatHelpRows() {
  const rows = new Map();
  for (const record of getAllEquipRandomStatRecords()) {
    const type = resolveGearStatType(record && record.m_StatType);
    if (!type) continue;
    const min = recordStatMinValue(record);
    const max = recordStatMaxValue(record);
    const existing = rows.get(type);
    if (!existing) {
      rows.set(type, { type, id: statTypeValue(type), min, max });
      continue;
    }
    if (Number.isFinite(min)) existing.min = Number.isFinite(existing.min) ? Math.min(existing.min, min) : min;
    if (Number.isFinite(max)) existing.max = Number.isFinite(existing.max) ? Math.max(existing.max, max) : max;
  }
  return Array.from(rows.values()).sort((a, b) => (a.id - b.id) || a.type.localeCompare(b.type));
}

function buildGearSetBonusHelpRows() {
  return getAllEquipSetOptionRecords()
    .map((record) => ({
      id: Number(record && record.m_EquipSetID) || 0,
      name: gearSetHelpName(record),
      parts: Number(record && record.m_EquipSetPart) || 0,
      effects: formatGearSetEffects(record),
    }))
    .filter((row) => row.id > 0)
    .sort((a, b) => a.id - b.id);
}

function gearSetHelpName(record) {
  const raw = String(record && (record.m_EquipSetStrID || record.m_EquipSetName || "") || "");
  return raw
    .replace(/^SI_/, "")
    .replace(/^SET_NORMAL_/, "")
    .replace(/^SET_/, "")
    .replace(/_/g, " ");
}

function describeGearSetOption(record) {
  if (!record) return "unknown";
  return `${Number(record.m_EquipSetID) || 0} ${gearSetHelpName(record)} parts=${Number(record.m_EquipSetPart) || 0} ${formatGearSetEffects(record)}`;
}

function formatGearSetEffects(record) {
  const effects = gearSetEffects(record);
  return effects.length ? effects.map((effect) => `${effect.type} ${formatGearSetEffectValue(effect.value)}`).join(", ") : "no effect";
}

function gearSetEffects(record) {
  const effects = [];
  for (let index = 1; index <= 2; index += 1) {
    const type = resolveGearStatType(record && record[`m_StatType_${index}`]);
    if (!type) continue;
    const valueSource = record[`m_StatValue_${index}`] != null ? record[`m_StatValue_${index}`] : record[`m_StatRate_${index}`];
    const value = Number(valueSource);
    if (!Number.isFinite(value)) continue;
    effects.push({ type, value });
  }
  return effects;
}

function formatGearSetEffectValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  if (Math.abs(number) > 0 && Math.abs(number) <= 1) return `${Number((number * 100).toFixed(3))}%`;
  return formatHelpStatValue(number);
}

function recordStatMinValue(record) {
  const value = Number(record && (record.m_MinStatValue != null ? record.m_MinStatValue : record.m_MinStat));
  return Number.isFinite(value) ? value : 0;
}

function recordStatMaxValue(record) {
  const value = Number(record && (record.m_MaxStatValue != null ? record.m_MaxStatValue : record.m_MaxStat));
  return Number.isFinite(value) ? value : recordStatMinValue(record);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatHelpStatValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  if (Number.isInteger(number)) return String(number);
  return String(Number(number.toFixed(6)));
}

function adminHelpText() {
  return [
    "Admin commands:",
    "/give currency <credits|eternium|quartz|admincoins|id> <count>",
    "/give item <id> <count>",
    "/give unit <id> [count]",
    "/give trophy <id> [count]",
    "/give ship <id> [count]",
    "/give operator <id> [count]",
    "/give gear <id> [count] [set=<setId|alias>] [main=<stat>=<value|max>] [substat=value|max] [substat=value|max]",
    "/give mold <id> [count]",
    "/give maxmaze",
    "/help gear",
    "/give skin <id>",
    "/give emoticon <id>",
    "/give all items|molds|units|trophies|ships|operators|gears|skins|emoticons [count]",
    "/give everything [count]",
    "/raid level <level> branch <branch>",
    "/sephira branch <branch>",
    "/raid kill branch <branch>",
    "/raid clear [all]",
    "/time",
    "/time set <YYYY-MM-DD [HH:mm[:ss]]>",
    "/time reset",
    "/clear inventory [timed|selectors|boxes|packages|resources|pieces|titles|id=<id>]",
    "/clear",
    "Rewards are delivered to Mail and granted when claimed.",
  ].join("\n");
}

function clearInventoryHelpText() {
  return [
    "Clear inventory command:",
    "/clear inventory",
    "/clear inventory timed",
    "/clear inventory selectors",
    "/clear inventory boxes",
    "/clear inventory packages",
    "/clear inventory resources",
    "/clear inventory pieces",
    "/clear inventory id=1060,10317",
    "This only clears misc inventory items. Gear, skins, units, ships, and operators are untouched.",
  ].join("\n");
}

function serverTimeHelpText() {
  return [
    "Server time commands:",
    "/time",
    "/time set <YYYY-MM-DD [HH:mm[:ss]]>",
    "/time reset",
    "Examples: /time set 2026-05-13 15:30, /time set 2025-08-10",
  ].join("\n");
}

function raidHelpText() {
  return [
    "Raid command:",
    "/raid level <level> branch <branch>",
    "/raid <level> <branch>",
    "/raid sephira branch <branch>",
    "/sephira branch <branch>",
    "/raid kill branch <branch>",
    "/killraid branch <branch>",
    "/raid clear [all]",
    "Examples: /raid level 30 branch 2, /admin raid lv=70 branch=4, /sephira branch 3, /raid kill branch 3",
  ].join("\n");
}

function isAdminCommand(message) {
  const text = String(message || "").trim().toLowerCase();
  return (
    text.startsWith("/admin") ||
    text.startsWith("/give") ||
    text.startsWith("/grant") ||
    text.startsWith("/mail") ||
    text.startsWith("/raid") ||
    text.startsWith("/spawnraid") ||
    text.startsWith("/raidspawn") ||
    text.startsWith("/sephira") ||
    text.startsWith("/spawnsephira") ||
    text.startsWith("/killraid") ||
    text.startsWith("/raidkill") ||
    text.startsWith("/time") ||
    text.startsWith("/clock") ||
    text.startsWith("/servertime") ||
    text.startsWith("/server-time") ||
    text.startsWith("/clear") ||
    text === "/help"
  );
}

function tokenizeCommand(input) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(String(input || "")))) tokens.push(match[1] || match[2] || match[3] || "");
  if (tokens[0] && tokens[0].toLowerCase() === "/help") return ["/admin", "help", ...tokens.slice(1)];
  return tokens;
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  const payload = safeDecrypt(ctx, encryptedPayload);
  let offset = 0;
  const takeInt = () => {
    const read = readSignedVarInt(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const takeLong = () => {
    const read = readSignedVarLong(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const takeString = () => {
    const read = readString(payload, offset);
    offset = read.offset;
    return read.value;
  };
  try {
    switch (packetId) {
      case PACKETS.POST_LIST_REQ:
        return { valid: true, lastPostIndex: takeLong() };
      case PACKETS.POST_RECEIVE_REQ:
        return { valid: true, postIndex: takeLong() };
      case PACKETS.PRIVATE_CHAT_REQ:
        return { valid: true, userUid: takeLong(), emotionId: takeInt(), message: takeString() };
      case PACKETS.PRIVATE_CHAT_LIST_REQ:
        return { valid: true, userUid: takeLong() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[admin] request decode failed packetId=${packetId}: ${err.message}`);
    return [PACKETS.POST_LIST_REQ, PACKETS.POST_RECEIVE_REQ, PACKETS.PRIVATE_CHAT_REQ, PACKETS.PRIVATE_CHAT_LIST_REQ].includes(packetId)
      ? { valid: false }
      : {};
  }
}

function safeDecrypt(ctx, payload) {
  try {
    return ctx.decryptCopy(payload);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function sendServerNotice(ctx, socket, packetId, payload, label = "admin-not") {
  if (socket && !socket.destroyed && ctx && typeof ctx.sendServerGamePacket === "function") {
    ctx.sendServerGamePacket(socket, packetId, payload || Buffer.alloc(0), label);
    return;
  }
  if (!socket || socket.destroyed || !ctx || typeof ctx.buildEncryptedPacket !== "function") return;
  const session = socket.session || (socket.session = {});
  const replay = session.gameReplay;
  let sequence;
  if (replay && Number.isFinite(Number(replay.nextServerSequence))) {
    sequence = Number(replay.nextServerSequence);
    replay.nextServerSequence = sequence + 1;
  } else {
    sequence = Number(session.adminServerSequence || 1);
    session.adminServerSequence = sequence + 1;
  }
  const packet = ctx.buildEncryptedPacket(sequence, packetId, payload || Buffer.alloc(0));
  socket.write(packet);
  console.log(`[admin:${label}] NOT packetId=${packetId} sequence=${sequence} payloadSize=${(payload || Buffer.alloc(0)).length}`);
}

function sendUserNotice(ctx, userUid, packetId, payload, label) {
  const socket = ctx && typeof ctx.findClientSocketByUserUid === "function" ? ctx.findClientSocketByUserUid(userUid) : null;
  if (socket && !socket.destroyed) sendServerNotice(ctx, socket, packetId, payload, label);
}

function writeInt64FromStoredDate(value) {
  return Buffer.from(writeInt64Buffer(toBigInt(value || dateTimeBinaryNow())));
}

function writeInt64Buffer(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(toBigInt(value), 0);
  return buffer;
}

function getSessionUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function persistUserDb(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function formatRequest(request) {
  if (!request || typeof request !== "object") return "";
  if (request.message) return `message=${JSON.stringify(String(request.message).slice(0, 80))}`;
  if (request.postIndex != null) return `postIndex=${request.postIndex}`;
  if (request.lastPostIndex != null) return `lastPostIndex=${request.lastPostIndex}`;
  if (request.userUid != null) return `userUid=${request.userUid}`;
  return "";
}

module.exports = {
  PACKETS,
  ADMIN_UID,
  createAdminHandler,
  ensureAdminState,
  ensureLoginRewardPosts,
  createAdminRewardPosts,
  clearAdminInbox,
  handleAdminCommand,
  buildPostData,
  buildChatMessageData,
  parseGiveCommand,
  adminHelpText,
};
