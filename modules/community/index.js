"use strict";

const fs = require("fs");
const path = require("path");
const {
  dateTimeBinaryNow,
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  toBigInt,
  writeBool,
  writeFloatLE,
  writeInt64LE,
  writeIntList,
  writeNullObject,
  writeNullableObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  writeByte,
} = require("../packet-codec");
const { buildCommonProfileData } = require("../profile");
const { ensureInventory } = require("../inventory");

const OK = 0;
const ERR = Object.freeze({
  REVIEW_PAGE: 365,
  REVIEW_LENGTH: 366,
  REVIEW_EXISTS: 367,
  REVIEW_MISSING: 368,
  REVIEW_SELF_VOTE: 369,
  REVIEW_ALREADY_VOTED: 370,
  REVIEW_NOT_VOTED: 371,
  REVIEW_SCORE: 373,
  REVIEW_TAG: 375,
  REVIEW_TAG_LIMIT: 376,
  REVIEW_TAG_ALREADY_VOTED: 377,
  REVIEW_TAG_NOT_VOTED: 379,
  REVIEW_BAN_EXISTS: 380,
  REVIEW_BAN_MISSING: 381,
  REVIEW_BAN_LIMIT: 382,
  FRIEND_SELF: 20151,
  FRIEND_BLOCK_SELF: 20152,
  FRIEND_RELATED: 20153,
  FRIEND_ALREADY_REQUESTED: 20154,
  FRIEND_HAS_RECEIVED: 20155,
  FRIEND_BLOCKED: 20156,
  FRIEND_NOT_REQUESTED: 20158,
  FRIEND_MISSING: 20160,
  FRIEND_NOT_BLOCKED: 20165,
  FRIEND_ACCEPT_MISSING: 20167,
  FRIEND_CODE: 20248,
  FRIEND_SEARCH_EMPTY: 20266,
  EMOTICON_INDEX: 20285,
  EMOTICON_ID: 20286,
  EMOTICON_TYPE: 20287,
  EMOTICON_NOT_OWNED: 20583,
});
const REVIEW_PAGE_SIZE = 10;
const REVIEW_MAX_LENGTH = 100;
const REVIEW_TAG_MAX_VOTES = 7;
const REVIEW_BAN_MAX = 100;
const EMOTICON_PRESET_SIZE = 6;
const FRIEND_LIST = Object.freeze({ FRIEND: 0, BLOCKER: 1, SEND_REQUEST: 2, RECEIVE_REQUEST: 3 });

const emoticonTemplates = loadRecords("ab_script_item_templet/luac/LUA_ITEM_EMOTICON_TEMPLET.json");
const emoticonById = new Map(emoticonTemplates.map((row) => [Number(row.m_EmoticonID), row]));
const allEmoticonIds = [...emoticonById.keys()].filter(Number.isFinite);
const defaultTextIds = emoticonTemplates
  .filter((row) => row.m_EmoticonType === "NET_TEXT")
  .map((row) => Number(row.m_EmoticonID))
  .slice(0, EMOTICON_PRESET_SIZE);
const defaultAnimationIds = emoticonTemplates
  .filter((row) => row.m_EmoticonType === "NET_ANI")
  .map((row) => Number(row.m_EmoticonID))
  .slice(0, EMOTICON_PRESET_SIZE);
const validReviewTags = new Set(
  loadRecords("ab_script/luac/LUA_COLLECTION_TAG_TEMPLET.json").map((row) => Number(row.Idx)).filter(Number.isFinite)
);

const HANDLER_NAMES = Object.freeze({
  402: "FRIEND_RECOMMEND_REQ",
  404: "FRIEND_SEARCH_REQ",
  406: "FRIEND_REQUEST_REQ",
  409: "FRIEND_DELETE_REQ",
  412: "FRIEND_BLOCK_REQ",
  414: "FRIEND_CANCEL_REQUEST_REQ",
  417: "FRIEND_ACCEPT_REQ",
  431: "UNIT_REVIEW_COMMENT_LIST_REQ",
  433: "UNIT_REVIEW_COMMENT_WRITE_REQ",
  435: "UNIT_REVIEW_COMMENT_DELETE_REQ",
  437: "UNIT_REVIEW_COMMENT_VOTE_REQ",
  439: "UNIT_REVIEW_COMMENT_VOTE_CANCEL_REQ",
  441: "UNIT_REVIEW_SCORE_VOTE_REQ",
  443: "UNIT_REVIEW_TAG_LIST_REQ",
  445: "UNIT_REVIEW_TAG_VOTE_REQ",
  447: "UNIT_REVIEW_TAG_VOTE_CANCEL_REQ",
  449: "UNIT_REVIEW_COMMENT_AND_SCORE_REQ",
  457: "EMOTICON_ANI_CHANGE_REQ",
  459: "EMOTICON_TEXT_CHANGE_REQ",
  461: "UNIT_REVIEW_USER_BAN_REQ",
  463: "UNIT_REVIEW_USER_BAN_CANCEL_REQ",
  465: "UNIT_REVIEW_USER_BAN_LIST_REQ",
  497: "EMOTICON_FAVORITES_SET_REQ",
});

function createCommunityHandlers() {
  return Object.keys(HANDLER_NAMES).map((packetIdText) => {
    const packetId = Number(packetIdText);
    return {
      packetId,
      name: HANDLER_NAMES[packetId],
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeRequest(packetId, packet.payload || Buffer.alloc(0));
        const result = handleRequest(ctx, user, packetId, req);
        ctx.sendResponse(socket, packet.sequence, result.packetId, () =>
          ctx.buildEncryptedPacket(packet.sequence, result.packetId, result.payload)
        );
        if (result.persist) persist(ctx);
        for (const push of result.pushes || []) sendPush(ctx, push);
        console.log(`[community:${HANDLER_NAMES[packetId]}] ACK packetId=${result.packetId} errorCode=${result.errorCode}`);
        return true;
      },
    };
  });
}

function handleFriendList(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const read = readSignedVarInt(packet.payload || Buffer.alloc(0), 0);
  const payload = buildFriendListAckPayload(ctx, user, read.value);
  ctx.sendResponse(socket, packet.sequence, 401, () => ctx.buildEncryptedPacket(packet.sequence, 401, payload));
  return true;
}

function handleEmoticonData(ctx, socket, packet) {
  const user = getSocketUser(ctx, socket);
  const payload = buildEmoticonDataAckPayload(user);
  ctx.sendResponse(socket, packet.sequence, 456, () => ctx.buildEncryptedPacket(packet.sequence, 456, payload));
  return true;
}

function handleRequest(ctx, user, packetId, req) {
  switch (packetId) {
    case 402:
      return result(403, Buffer.concat([writeSignedVarInt(OK), writeFriendDataList(recommendedUsers(ctx, user))]));
    case 404:
      return friendSearch(ctx, user, req);
    case 406:
      return friendRequest(ctx, user, req);
    case 409:
      return friendDelete(ctx, user, req);
    case 412:
      return friendBlock(ctx, user, req);
    case 414:
      return friendCancel(ctx, user, req);
    case 417:
      return friendAccept(ctx, user, req);
    case 431:
      return reviewCommentList(ctx, user, req);
    case 433:
      return reviewCommentWrite(ctx, user, req);
    case 435:
      return reviewCommentDelete(ctx, user, req);
    case 437:
      return reviewCommentVote(ctx, user, req, true);
    case 439:
      return reviewCommentVote(ctx, user, req, false);
    case 441:
      return reviewScoreVote(ctx, user, req);
    case 443:
      return reviewTagList(ctx, user, req);
    case 445:
      return reviewTagVote(ctx, user, req, true);
    case 447:
      return reviewTagVote(ctx, user, req, false);
    case 449:
      return reviewCombined(ctx, user, req);
    case 457:
      return emoticonPresetChange(user, req, true);
    case 459:
      return emoticonPresetChange(user, req, false);
    case 461:
      return reviewBan(user, req, true);
    case 463:
      return reviewBan(user, req, false);
    case 465:
      return reviewBanList(user);
    case 497:
      return emoticonFavorite(user, req);
    default:
      throw new Error(`unsupported community packet ${packetId}`);
  }
}

function friendSearch(ctx, user, req) {
  const keyword = String(req.searchKeyword || "").trim().toLowerCase();
  const matches = allUsers(ctx)
    .filter((target) => target !== user && (
      String(target.friendCode || "").toLowerCase() === keyword ||
      String(target.nickname || "").toLowerCase().includes(keyword)
    ))
    .slice(0, 20);
  const errorCode = matches.length ? OK : ERR.FRIEND_SEARCH_EMPTY;
  return result(405, Buffer.concat([writeSignedVarInt(errorCode), writeFriendDataList(matches)]), errorCode);
}

function friendRequest(ctx, user, req) {
  const target = findUserByFriendCode(ctx, req.friendCode);
  let errorCode = validateFriendTarget(user, target, false);
  const own = ensureCommunityUser(user);
  if (!errorCode && own.friends.includes(uid(target))) errorCode = ERR.FRIEND_RELATED;
  if (!errorCode && own.outgoingRequests.includes(uid(target))) errorCode = ERR.FRIEND_ALREADY_REQUESTED;
  if (!errorCode && own.incomingRequests.includes(uid(target))) errorCode = ERR.FRIEND_HAS_RECEIVED;
  if (!errorCode && (own.blocked.includes(uid(target)) || ensureCommunityUser(target).blocked.includes(uid(user)))) {
    errorCode = ERR.FRIEND_BLOCKED;
  }
  if (errorCode) return simpleFriendAck(407, errorCode, req.friendCode);
  addUnique(own.outgoingRequests, uid(target));
  addUnique(ensureCommunityUser(target).incomingRequests, uid(user));
  return result(
    407,
    Buffer.concat([writeSignedVarInt(OK), writeSignedVarLong(req.friendCode)]),
    OK,
    true,
    [{ userUid: uid(target), packetId: 408, payload: writeNullableObject(buildFriendListData(user)), label: "friend-request" }]
  );
}

function friendDelete(ctx, user, req) {
  const target = findUserByFriendCode(ctx, req.friendCode);
  let errorCode = validateFriendTarget(user, target, false);
  if (!errorCode && !ensureCommunityUser(user).friends.includes(uid(target))) errorCode = ERR.FRIEND_MISSING;
  if (errorCode) return simpleFriendAck(410, errorCode, req.friendCode);
  removeValue(ensureCommunityUser(user).friends, uid(target));
  removeValue(ensureCommunityUser(target).friends, uid(user));
  return result(
    410,
    Buffer.concat([writeSignedVarInt(OK), writeSignedVarLong(req.friendCode)]),
    OK,
    true,
    [{
      userUid: uid(target),
      packetId: 411,
      payload: Buffer.concat([writeSignedVarLong(toBigInt(user.userUid)), writeSignedVarLong(toBigInt(user.friendCode))]),
      label: "friend-delete",
    }]
  );
}

function friendBlock(ctx, user, req) {
  const target = findUserByFriendCode(ctx, req.friendCode);
  let errorCode = validateFriendTarget(user, target, true);
  const own = ensureCommunityUser(user);
  const wasFriend = target && own.friends.includes(uid(target));
  if (!errorCode && req.isCancel && !own.blocked.includes(uid(target))) errorCode = ERR.FRIEND_NOT_BLOCKED;
  if (errorCode) return result(413, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarLong(req.friendCode), writeBool(req.isCancel),
  ]), errorCode);
  if (req.isCancel) {
    removeValue(own.blocked, uid(target));
  } else {
    addUnique(own.blocked, uid(target));
    removeRelationship(user, target);
  }
  const pushes = !req.isCancel && wasFriend ? [{
    userUid: uid(target),
    packetId: 411,
    payload: Buffer.concat([writeSignedVarLong(toBigInt(user.userUid)), writeSignedVarLong(toBigInt(user.friendCode))]),
    label: "friend-block-delete",
  }] : [];
  return result(413, Buffer.concat([
    writeSignedVarInt(OK), writeSignedVarLong(req.friendCode), writeBool(req.isCancel),
  ]), OK, true, pushes);
}

function friendCancel(ctx, user, req) {
  const target = findUserByFriendCode(ctx, req.friendCode);
  let errorCode = validateFriendTarget(user, target, false);
  if (!errorCode && !ensureCommunityUser(user).outgoingRequests.includes(uid(target))) errorCode = ERR.FRIEND_NOT_REQUESTED;
  if (errorCode) return simpleFriendAck(415, errorCode, req.friendCode);
  removeValue(ensureCommunityUser(user).outgoingRequests, uid(target));
  removeValue(ensureCommunityUser(target).incomingRequests, uid(user));
  return result(
    415,
    Buffer.concat([writeSignedVarInt(OK), writeSignedVarLong(req.friendCode)]),
    OK,
    true,
    [{
      userUid: uid(target),
      packetId: 416,
      payload: Buffer.concat([writeSignedVarLong(toBigInt(user.userUid)), writeSignedVarLong(toBigInt(user.friendCode))]),
      label: "friend-cancel",
    }]
  );
}

function friendAccept(ctx, user, req) {
  const target = findUserByFriendCode(ctx, req.friendCode);
  let errorCode = validateFriendTarget(user, target, false);
  if (!errorCode && !ensureCommunityUser(user).incomingRequests.includes(uid(target))) errorCode = ERR.FRIEND_ACCEPT_MISSING;
  if (!errorCode && req.isAllow && ensureCommunityUser(user).friends.includes(uid(target))) errorCode = ERR.FRIEND_RELATED;
  if (errorCode) return result(418, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarLong(req.friendCode), writeBool(req.isAllow),
  ]), errorCode);
  removeValue(ensureCommunityUser(user).incomingRequests, uid(target));
  removeValue(ensureCommunityUser(target).outgoingRequests, uid(user));
  if (req.isAllow) {
    addUnique(ensureCommunityUser(user).friends, uid(target));
    addUnique(ensureCommunityUser(target).friends, uid(user));
  }
  return result(
    418,
    Buffer.concat([writeSignedVarInt(OK), writeSignedVarLong(req.friendCode), writeBool(req.isAllow)]),
    OK,
    true,
    [{
      userUid: uid(target),
      packetId: 419,
      payload: Buffer.concat([
        writeBool(req.isAllow), writeNullableObject(buildFriendListData(user)), writeInt64LE(dateTimeBinaryNow()),
      ]),
      label: "friend-accept",
    }]
  );
}

function reviewCommentList(ctx, user, req) {
  if (req.pageNumber < 1) return result(432, Buffer.concat([writeSignedVarInt(ERR.REVIEW_PAGE), writeObjectList([])]), ERR.REVIEW_PAGE);
  const list = pageComments(ctx, user, req.unitID, req.isOrderByVotedCount, req.pageNumber);
  return result(432, Buffer.concat([writeSignedVarInt(OK), writeCommentList(list, user)]));
}

function reviewCommentWrite(ctx, user, req) {
  const store = ensureReviewStore(ctx);
  const comments = ensureObject(store.comments, String(req.unitID));
  const existing = Object.values(comments).find((comment) => uidValue(comment.userUid) === uid(user));
  const content = String(req.content || "").trim();
  let errorCode = OK;
  if (!content || content.length > REVIEW_MAX_LENGTH) errorCode = ERR.REVIEW_LENGTH;
  else if (existing && !req.isRewrite) errorCode = ERR.REVIEW_EXISTS;
  else if (!existing && req.isRewrite) errorCode = ERR.REVIEW_MISSING;
  if (errorCode) return result(434, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarInt(req.unitID), writeNullObject(),
  ]), errorCode);
  const comment = existing || {
    commentUid: String(store.nextCommentUid++),
    userUid: uid(user),
    votes: [],
    regDate: String(rawUtcTicks()),
  };
  comment.nickname = String(user.nickname || "LocalAdmin");
  comment.level = Number(user.level || 1);
  comment.content = content;
  comment.regDate = String(rawUtcTicks());
  comments[comment.commentUid] = comment;
  return result(434, Buffer.concat([
    writeSignedVarInt(OK), writeSignedVarInt(req.unitID), writeNullableObject(buildReviewComment(comment, user)),
  ]), OK, true);
}

function reviewCommentDelete(ctx, user, req) {
  const comments = ensureObject(ensureReviewStore(ctx).comments, String(req.unitID));
  const existing = Object.values(comments).find((comment) => uidValue(comment.userUid) === uid(user));
  if (!existing) return result(436, writeSignedVarInt(ERR.REVIEW_MISSING), ERR.REVIEW_MISSING);
  delete comments[existing.commentUid];
  return result(436, writeSignedVarInt(OK), OK, true);
}

function reviewCommentVote(ctx, user, req, isVote) {
  const comments = ensureObject(ensureReviewStore(ctx).comments, String(req.unitID));
  const comment = comments[String(req.commentUID)];
  let errorCode = OK;
  if (!comment) errorCode = ERR.REVIEW_MISSING;
  else if (uidValue(comment.userUid) === uid(user)) errorCode = ERR.REVIEW_SELF_VOTE;
  else if (isVote && comment.votes.includes(uid(user))) errorCode = ERR.REVIEW_ALREADY_VOTED;
  else if (!isVote && !comment.votes.includes(uid(user))) errorCode = ERR.REVIEW_NOT_VOTED;
  if (!errorCode) (isVote ? addUnique : removeValue)(comment.votes, uid(user));
  return result(isVote ? 438 : 440, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarInt(req.unitID),
    comment ? writeNullableObject(buildReviewComment(comment, user)) : writeNullObject(),
  ]), errorCode, !errorCode);
}

function reviewScoreVote(ctx, user, req) {
  const scores = ensureObject(ensureReviewStore(ctx).scores, String(req.unitID));
  const errorCode = req.score < 1 || req.score > 5 ? ERR.REVIEW_SCORE : OK;
  if (!errorCode) scores[uid(user)] = Math.trunc(req.score);
  return result(442, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarInt(req.unitID), writeNullableObject(buildReviewScore(scores, user)),
  ]), errorCode, !errorCode);
}

function reviewTagList(ctx, user, req) {
  const tags = ensureObject(ensureReviewStore(ctx).tags, String(req.unitID));
  return result(444, Buffer.concat([writeSignedVarInt(OK), writeTagList(tags, user)]));
}

function reviewTagVote(ctx, user, req, isVote) {
  const tags = ensureObject(ensureReviewStore(ctx).tags, String(req.unitID));
  const tagKey = String(req.tagType);
  const voters = Array.isArray(tags[tagKey]) ? tags[tagKey] : (tags[tagKey] = []);
  const ownVotes = Object.values(tags).filter((list) => Array.isArray(list) && list.includes(uid(user))).length;
  let errorCode = OK;
  if (!validReviewTags.has(req.tagType)) errorCode = ERR.REVIEW_TAG;
  else if (isVote && voters.includes(uid(user))) errorCode = ERR.REVIEW_TAG_ALREADY_VOTED;
  else if (isVote && ownVotes >= REVIEW_TAG_MAX_VOTES) errorCode = ERR.REVIEW_TAG_LIMIT;
  else if (!isVote && !voters.includes(uid(user))) errorCode = ERR.REVIEW_TAG_NOT_VOTED;
  if (!errorCode) (isVote ? addUnique : removeValue)(voters, uid(user));
  return result(isVote ? 446 : 448, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarInt(req.unitID), writeNullableObject(buildReviewTag(req.tagType, voters, user)),
  ]), errorCode, !errorCode);
}

function reviewCombined(ctx, user, req) {
  if (req.pageNumber < 1) return result(450, Buffer.concat([
    writeSignedVarInt(ERR.REVIEW_PAGE), writeSignedVarInt(req.unitID), writeObjectList([]), writeObjectList([]),
    writeNullObject(), writeNullableObject(buildReviewScore({}, user)),
  ]), ERR.REVIEW_PAGE);
  const store = ensureReviewStore(ctx);
  const all = visibleComments(ctx, user, req.unitID);
  const best = all.slice().sort(sortByVotes).slice(0, 3);
  const page = pageComments(ctx, user, req.unitID, req.isOrderByVotedCount, req.pageNumber);
  const mine = all.find((comment) => uidValue(comment.userUid) === uid(user));
  const scores = ensureObject(store.scores, String(req.unitID));
  return result(450, Buffer.concat([
    writeSignedVarInt(OK),
    writeSignedVarInt(req.unitID),
    writeCommentList(best, user),
    writeCommentList(page, user),
    mine ? writeNullableObject(buildReviewComment(mine, user)) : writeNullObject(),
    writeNullableObject(buildReviewScore(scores, user)),
  ]));
}

function reviewBan(user, req, isBan) {
  const state = ensureCommunityUser(user);
  const target = String(req.targetUserUid);
  let errorCode = OK;
  if (isBan && state.reviewBans.includes(target)) errorCode = ERR.REVIEW_BAN_EXISTS;
  else if (isBan && state.reviewBans.length >= REVIEW_BAN_MAX) errorCode = ERR.REVIEW_BAN_LIMIT;
  else if (!isBan && !state.reviewBans.includes(target)) errorCode = ERR.REVIEW_BAN_MISSING;
  if (!errorCode) (isBan ? addUnique : removeValue)(state.reviewBans, target);
  return result(isBan ? 462 : 464, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarLong(toBigInt(target)),
  ]), errorCode, !errorCode);
}

function reviewBanList(user) {
  const bans = ensureCommunityUser(user).reviewBans;
  return result(466, Buffer.concat([
    writeSignedVarInt(OK),
    writeObjectList(bans.map((value) => writeSignedVarLong(toBigInt(value)))),
  ]));
}

function emoticonPresetChange(user, req, animation) {
  const state = ensureCommunityUser(user).emoticons;
  const list = animation ? state.animationList : state.textList;
  const template = emoticonById.get(req.emoticonId);
  const expectedType = animation ? "NET_ANI" : "NET_TEXT";
  let errorCode = OK;
  if (req.presetIndex < 0 || req.presetIndex >= list.length) errorCode = ERR.EMOTICON_INDEX;
  else if (!template) errorCode = ERR.EMOTICON_ID;
  else if (template.m_EmoticonType !== expectedType) errorCode = ERR.EMOTICON_TYPE;
  else if (!state.collections.includes(req.emoticonId)) errorCode = ERR.EMOTICON_NOT_OWNED;
  if (!errorCode) list[req.presetIndex] = req.emoticonId;
  return result(animation ? 458 : 460, Buffer.concat([
    writeSignedVarInt(errorCode), writeSignedVarInt(req.presetIndex), writeSignedVarInt(req.emoticonId),
  ]), errorCode, !errorCode);
}

function emoticonFavorite(user, req) {
  const state = ensureCommunityUser(user).emoticons;
  let errorCode = OK;
  if (!emoticonById.has(req.emoticonId)) errorCode = ERR.EMOTICON_ID;
  else if (!state.collections.includes(req.emoticonId)) errorCode = ERR.EMOTICON_NOT_OWNED;
  if (!errorCode) (req.favoritesOption ? addUnique : removeValue)(state.favorites, req.emoticonId);
  return result(498, Buffer.concat([
    writeSignedVarInt(errorCode), writeNullableObject(buildEmoticonData(req.emoticonId, state.favorites)),
  ]), errorCode, !errorCode);
}

function buildFriendListAckPayload(ctx, user, listType) {
  const state = ensureCommunityUser(user);
  const key = listType === FRIEND_LIST.BLOCKER ? "blocked"
    : listType === FRIEND_LIST.SEND_REQUEST ? "outgoingRequests"
      : listType === FRIEND_LIST.RECEIVE_REQUEST ? "incomingRequests"
        : "friends";
  const users = state[key].map((userUid) => findUserByUid(ctx, userUid)).filter(Boolean);
  return Buffer.concat([writeSignedVarInt(OK), writeSignedVarInt(listType), writeFriendDataList(users)]);
}

function buildEmoticonDataAckPayload(user) {
  const state = ensureCommunityUser(user).emoticons;
  const preset = Buffer.concat([writeIntList(state.animationList), writeIntList(state.textList)]);
  return Buffer.concat([
    writeSignedVarInt(OK),
    writeNullableObject(preset),
    writeIntList(state.collections),
    writeObjectList(state.collections.map((id) => writeNullableObject(buildEmoticonData(id, state.favorites)))),
  ]);
}

function buildFriendListData(user) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeInt64LE(lastLoginDate(user)),
    writeNullObject(),
    writeBool(Boolean(user.hasOffice || user.office)),
  ]);
}

function writeFriendDataList(users) {
  return writeObjectList(users.map((user) => writeNullableObject(buildFriendListData(user))));
}

function buildReviewComment(comment, viewer) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(comment.commentUid)),
    writeSignedVarLong(toBigInt(comment.userUid)),
    writeString(comment.nickname || ""),
    writeSignedVarInt(Number(comment.level || 1)),
    writeString(comment.content || ""),
    writeSignedVarInt(Array.isArray(comment.votes) ? comment.votes.length : 0),
    writeBool(Array.isArray(comment.votes) && comment.votes.includes(uid(viewer))),
    writeSignedVarLong(toBigInt(comment.regDate)),
  ]);
}

function writeCommentList(comments, viewer) {
  return writeObjectList(comments.map((comment) => writeNullableObject(buildReviewComment(comment, viewer))));
}

function buildReviewScore(scores, user) {
  const values = Object.values(scores).map(Number).filter((score) => score >= 1 && score <= 5);
  const average = values.length ? values.reduce((sum, score) => sum + score, 0) / values.length : 0;
  return Buffer.concat([writeFloatLE(average), writeSignedVarInt(values.length), writeByte(Number(scores[uid(user)] || 0))]);
}

function buildReviewTag(tagType, voters, user) {
  return Buffer.concat([
    writeSignedVarInt(tagType), writeSignedVarInt(voters.length), writeBool(voters.includes(uid(user))),
  ]);
}

function writeTagList(tags, user) {
  return writeObjectList([...validReviewTags].map((tagType) =>
    writeNullableObject(buildReviewTag(tagType, Array.isArray(tags[String(tagType)]) ? tags[String(tagType)] : [], user))
  ));
}

function buildEmoticonData(id, favorites) {
  return Buffer.concat([writeSignedVarInt(id), writeBool(favorites.includes(id))]);
}

function decodeRequest(packetId, payload) {
  const cursor = { offset: 0 };
  const int = () => read(cursor, payload, readSignedVarInt);
  const long = () => read(cursor, payload, readSignedVarLong);
  const bool = () => read(cursor, payload, readBool);
  const string = () => read(cursor, payload, readString);
  switch (packetId) {
    case 404: return { searchKeyword: string() };
    case 406:
    case 409:
    case 414: return { friendCode: long() };
    case 412: return { friendCode: long(), isCancel: bool() };
    case 417: return { friendCode: long(), isAllow: bool() };
    case 431:
    case 449: return { unitID: int(), isOrderByVotedCount: bool(), pageNumber: int() };
    case 433: return { unitID: int(), content: string(), isRewrite: bool() };
    case 435:
    case 443: return { unitID: int() };
    case 437:
    case 439: return { unitID: int(), commentUID: long() };
    case 441: return { unitID: int(), score: int() };
    case 445:
    case 447: return { unitID: int(), tagType: int() };
    case 457:
    case 459: return { presetIndex: int(), emoticonId: int() };
    case 461:
    case 463: return { targetUserUid: long() };
    case 497: return { emoticonId: int(), favoritesOption: bool() };
    default: return {};
  }
}

function read(cursor, payload, reader) {
  const value = reader(payload, cursor.offset);
  cursor.offset = value.offset;
  return value.value;
}

function ensureCommunityUser(user) {
  if (!user.community || typeof user.community !== "object") user.community = {};
  const state = user.community;
  for (const key of ["friends", "outgoingRequests", "incomingRequests", "blocked", "reviewBans"]) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  if (!state.emoticons || typeof state.emoticons !== "object") state.emoticons = {};
  const emoticons = state.emoticons;
  const inventoryEmoticons = ensureInventory(user).emoticons.filter((id) => emoticonById.has(id));
  if (!Array.isArray(emoticons.collections)) emoticons.collections = inventoryEmoticons.slice();
  for (const id of inventoryEmoticons) addUnique(emoticons.collections, id);
  emoticons.collections = emoticons.collections.filter((id) => emoticonById.has(id));
  const owned = new Set(emoticons.collections);
  if (!Array.isArray(emoticons.animationList)) {
    emoticons.animationList = padPresets(defaultAnimationIds.filter((id) => owned.has(id)));
  }
  if (!Array.isArray(emoticons.textList)) {
    emoticons.textList = padPresets(defaultTextIds.filter((id) => owned.has(id)));
  }
  emoticons.animationList = padPresets(emoticons.animationList.map(Number).filter((id) =>
    id === 0 || owned.has(id) && emoticonById.get(id).m_EmoticonType === "NET_ANI"
  ));
  emoticons.textList = padPresets(emoticons.textList.map(Number).filter((id) =>
    id === 0 || owned.has(id) && emoticonById.get(id).m_EmoticonType === "NET_TEXT"
  ));
  if (!Array.isArray(emoticons.favorites)) emoticons.favorites = [];
  return state;
}

function ensureReviewStore(ctx) {
  if (!ctx.userDb.community || typeof ctx.userDb.community !== "object") ctx.userDb.community = {};
  const store = ctx.userDb.community;
  if (!Number.isSafeInteger(store.nextCommentUid) || store.nextCommentUid < 1) store.nextCommentUid = 1;
  for (const key of ["comments", "scores", "tags"]) ensureObject(store, key);
  return store;
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) parent[key] = {};
  return parent[key];
}

function visibleComments(ctx, user, unitId) {
  const comments = Object.values(ensureObject(ensureReviewStore(ctx).comments, String(unitId)));
  const bans = ensureCommunityUser(user).reviewBans;
  return comments.filter((comment) => !bans.includes(uidValue(comment.userUid)));
}

function pageComments(ctx, user, unitId, byVotes, pageNumber) {
  const comments = visibleComments(ctx, user, unitId).sort(byVotes ? sortByVotes : sortByNewest);
  const start = (pageNumber - 1) * REVIEW_PAGE_SIZE;
  return comments.slice(start, start + REVIEW_PAGE_SIZE);
}

function sortByVotes(a, b) {
  return (b.votes || []).length - (a.votes || []).length || Number(toBigInt(b.regDate) - toBigInt(a.regDate));
}

function sortByNewest(a, b) {
  return Number(toBigInt(b.regDate) - toBigInt(a.regDate));
}

function recommendedUsers(ctx, user) {
  const state = ensureCommunityUser(user);
  const excluded = new Set([uid(user), ...state.friends, ...state.outgoingRequests, ...state.incomingRequests, ...state.blocked]);
  return allUsers(ctx).filter((target) => !excluded.has(uid(target))).slice(0, 20);
}

function allUsers(ctx) {
  return Object.values(ctx && ctx.userDb && ctx.userDb.users || {});
}

function findUserByUid(ctx, userUid) {
  return allUsers(ctx).find((user) => uid(user) === String(userUid));
}

function findUserByFriendCode(ctx, friendCode) {
  const code = String(friendCode);
  return allUsers(ctx).find((user) => String(user.friendCode || "") === code);
}

function validateFriendTarget(user, target, block) {
  if (!target) return ERR.FRIEND_CODE;
  if (uid(target) === uid(user)) return block ? ERR.FRIEND_BLOCK_SELF : ERR.FRIEND_SELF;
  return OK;
}

function removeRelationship(a, b) {
  const aState = ensureCommunityUser(a);
  const bState = ensureCommunityUser(b);
  for (const key of ["friends", "outgoingRequests", "incomingRequests"]) {
    removeValue(aState[key], uid(b));
    removeValue(bState[key], uid(a));
  }
}

function simpleFriendAck(packetId, errorCode, friendCode) {
  return result(packetId, Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarLong(friendCode)]), errorCode);
}

function result(packetId, payload, errorCode = OK, persistState = false, pushes = []) {
  return { packetId, payload, errorCode, persist: persistState, pushes };
}

function sendPush(ctx, push) {
  const socket = ctx && typeof ctx.findClientSocketByUserUid === "function"
    ? ctx.findClientSocketByUserUid(push.userUid)
    : null;
  if (socket && !socket.destroyed) ctx.sendServerGamePacket(socket, push.packetId, push.payload, push.label);
}

function persist(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache("community-update");
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function addUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function removeValue(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
}

function uid(user) {
  return String(user && user.userUid || "0");
}

function uidValue(value) {
  return String(value == null ? "0" : value);
}

function padPresets(values) {
  const list = values.slice(0, EMOTICON_PRESET_SIZE);
  while (list.length < EMOTICON_PRESET_SIZE) list.push(0);
  return list;
}

function lastLoginDate(user) {
  const value = user && (user.lastLoginDate || user.lastJoinDate);
  return value ? toBigInt(value, dateTimeBinaryNow()) : dateTimeBinaryNow();
}

function rawUtcTicks() {
  return BigInt(Date.now()) * 10000n + 621355968000000000n;
}

function loadRecords(relativePath) {
  const file = path.resolve(__dirname, "..", "..", "gameplay-jsons", "StreamingAssets", relativePath);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch (_) {
    return [];
  }
}

module.exports = {
  ERR,
  FRIEND_LIST,
  createCommunityHandlers,
  handleFriendList,
  handleEmoticonData,
  buildFriendListAckPayload,
  writeFriendDataList,
  buildEmoticonDataAckPayload,
  ensureCommunityUser,
  ensureReviewStore,
};
