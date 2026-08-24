"use strict";

const {
  getPlayableOperatorIds,
  getPlayableShipIds,
  getPlayableUnitIds,
  getUnitTemplet,
  isCollectionVisibleUnitId,
} = require("../game-data");
const {
  readSignedVarIntList,
  writeIntList,
  writeNullableObject,
  writeSignedVarInt,
} = require("../packet-codec");

const PACKETS = Object.freeze({
  UNIT_REQ: 2690,
  UNIT_ACK: 2691,
  SHIP_REQ: 2692,
  SHIP_ACK: 2693,
  CASTING_UNIT_REQ: 2661,
  CASTING_UNIT_ACK: 2662,
  CASTING_SHIP_REQ: 2663,
  CASTING_SHIP_ACK: 2664,
  CASTING_OPERATOR_REQ: 2667,
  CASTING_OPERATOR_ACK: 2668,
});

const ERRORS = Object.freeze({
  OK: 0,
  INVALID_REQUEST: 20191,
  INVALID_VOTE_COUNT: 20977,
  DUPLICATED_VOTE: 20978,
  INVALID_UNIT_ID: 20979,
});

const UNIT_VOTE_COUNT = 2;
const SHIP_VOTE_COUNT = 1;
const CASTING_VOTE_COUNT = 3;
let cachedEligibility = null;

function createDraftPvpVoteHandlers() {
  return [
    { packetId: PACKETS.UNIT_REQ, name: "DRAFT_PVP_CASTING_VOTE_UNIT_REQ", handle: handleUnitVote },
    { packetId: PACKETS.SHIP_REQ, name: "DRAFT_PVP_CASTING_VOTE_SHIP_REQ", handle: handleShipVote },
  ];
}

function createPvpCastingVoteHandlers() {
  return [
    { packetId: PACKETS.CASTING_UNIT_REQ, name: "PVP_CASTING_VOTE_UNIT_REQ", handle: handleCastingUnitVote },
    { packetId: PACKETS.CASTING_SHIP_REQ, name: "PVP_CASTING_VOTE_SHIP_REQ", handle: handleCastingShipVote },
    { packetId: PACKETS.CASTING_OPERATOR_REQ, name: "PVP_CASTING_VOTE_OPERATOR_REQ", handle: handleCastingOperatorVote },
  ];
}

function handleUnitVote(ctx, socket, packet) {
  return handleVote(ctx, socket, packet, "unitIdList", UNIT_VOTE_COUNT, PACKETS.UNIT_ACK, "draft-pvp-unit-vote");
}

function handleShipVote(ctx, socket, packet) {
  return handleVote(ctx, socket, packet, "shipGroupIdList", SHIP_VOTE_COUNT, PACKETS.SHIP_ACK, "draft-pvp-ship-vote");
}

function handleCastingUnitVote(ctx, socket, packet) {
  return handleCastingVote(ctx, socket, packet, "unitIdList", PACKETS.CASTING_UNIT_ACK, "pvp-casting-unit-vote");
}

function handleCastingShipVote(ctx, socket, packet) {
  return handleCastingVote(ctx, socket, packet, "shipGroupIdList", PACKETS.CASTING_SHIP_ACK, "pvp-casting-ship-vote");
}

function handleCastingOperatorVote(ctx, socket, packet) {
  return handleCastingVote(ctx, socket, packet, "operatorIdList", PACKETS.CASTING_OPERATOR_ACK, "pvp-casting-operator-vote");
}

function handleCastingVote(ctx, socket, packet, field, ackId, label) {
  const request = decodeVoteRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = updatePvpCastingVote(ctx, user, field, request);
  send(ctx, socket, packet, ackId, buildVoteAckPayload(result), label);
  persistChangedVote(ctx, result, label);
  return true;
}

function handleVote(ctx, socket, packet, field, count, ackId, label) {
  const request = decodeVoteRequest(ctx, packet.payload);
  const user = getSocketUser(ctx, socket);
  const result = updateDraftPvpVote(user, field, count, request);
  send(ctx, socket, packet, ackId, buildVoteAckPayload(result), label);
  persistChangedVote(ctx, result, label);
  return true;
}

function updateDraftPvpVote(user, field, expectedCount, request) {
  return updateVote(user, "pvpDraftVoteData", field, expectedCount, request, getEligibility());
}

function updatePvpCastingVote(ctx, user, field, request) {
  return updateVote(user, "pvpCastingVoteData", field, CASTING_VOTE_COUNT, request, getStandardEligibility(ctx, user));
}

function updateVote(user, stateField, field, expectedCount, request, eligibility) {
  if (!request || !request.valid) return voteResult(ERRORS.INVALID_REQUEST);
  const ids = request.ids;
  if (ids.length !== expectedCount) return voteResult(ERRORS.INVALID_VOTE_COUNT);
  if (new Set(ids).size !== ids.length) return voteResult(ERRORS.DUPLICATED_VOTE);
  const allowed = field === "unitIdList"
    ? eligibility.unitIds
    : field === "shipGroupIdList"
      ? eligibility.shipGroupIds
      : eligibility.operatorIds;
  if (ids.some((id) => !allowed.has(id))) return voteResult(ERRORS.INVALID_UNIT_ID);

  const current = normalizePvpCastingVoteData(user && user[stateField]);
  if (sameList(current[field], ids)) return voteResult(ERRORS.OK, current, false);
  const next = { ...current, [field]: ids.slice() };
  if (user) user[stateField] = next;
  return voteResult(ERRORS.OK, next, true);
}

function decodeVoteRequest(ctx, payload) {
  let buffer;
  try {
    buffer = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
    const ids = readSignedVarIntList(buffer, 0);
    return { valid: ids.offset === buffer.length && writeIntList(ids.value).equals(buffer), ids: ids.value };
  } catch (_) {
    return { valid: false, ids: [] };
  }
}

function buildVoteAckPayload(result = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(result.errorCode) || 0),
    writeNullableObject(buildPvpCastingVoteData(result.data)),
  ]);
}

function buildPvpCastingVoteData(value) {
  const data = normalizePvpCastingVoteData(value);
  return Buffer.concat([
    writeIntList(data.unitIdList),
    writeIntList(data.shipGroupIdList),
    writeIntList(data.operatorIdList),
  ]);
}

function normalizePvpCastingVoteData(value) {
  const data = value && typeof value === "object" ? value : {};
  return {
    unitIdList: normalizeIds(data.unitIdList),
    shipGroupIdList: normalizeIds(data.shipGroupIdList),
    operatorIdList: normalizeIds(data.operatorIdList),
  };
}

function getEligibility() {
  if (cachedEligibility) return cachedEligibility;
  const unitIds = new Set(
    getPlayableUnitIds({ includeNonContractable: false }).filter((unitId) => isDraftVoteGrade(getUnitTemplet(unitId)))
  );
  const shipGroupIds = new Set();
  for (const shipId of getPlayableShipIds({ includeNonContractable: false })) {
    const templet = getUnitTemplet(shipId);
    const groupId = positiveInt(templet && templet.m_ShipGroupID);
    if (groupId && isDraftVoteGrade(templet)) shipGroupIds.add(groupId);
  }
  cachedEligibility = { unitIds, shipGroupIds, operatorIds: new Set() };
  return cachedEligibility;
}

function getStandardEligibility(ctx, user) {
  const openTags = getOpenTags(ctx, user);
  const tagOpen = (templet) => {
    const tag = String(templet && templet.m_FirstOpenTag || "").toUpperCase();
    return !tag || !openTags || openTags.has(tag);
  };
  const unitIds = new Set(
    getPlayableUnitIds({ includeNonContractable: true }).filter((unitId) => tagOpen(getUnitTemplet(unitId)))
  );
  const shipGroupIds = new Set();
  for (const shipId of getPlayableShipIds({ includeNonContractable: true })) {
    const templet = getUnitTemplet(shipId);
    const groupId = positiveInt(templet && templet.m_ShipGroupID);
    if (groupId && isCollectionVisibleUnitId(shipId) && tagOpen(templet)) shipGroupIds.add(groupId);
  }
  const operatorIds = new Set(
    getPlayableOperatorIds().filter((operatorId) => tagOpen(getUnitTemplet(operatorId)))
  );
  return { unitIds, shipGroupIds, operatorIds };
}

function getOpenTags(ctx, user) {
  if (!ctx || typeof ctx.getEffectiveOpenTags !== "function") return null;
  const own = Array.isArray(user && user.openTags) ? user.openTags : [];
  const tags = ctx.getEffectiveOpenTags(own);
  return new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").toUpperCase()));
}

function isDraftVoteGrade(templet) {
  return ["NUG_SR", "NUG_SSR"].includes(String(templet && templet.m_NKM_UNIT_GRADE || "").toUpperCase());
}

function voteResult(errorCode, data = null, changed = false) {
  return { errorCode, data: data || normalizePvpCastingVoteData(null), changed };
}

function persistChangedVote(ctx, result, label) {
  if (!result.changed) return;
  if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache(label);
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeIds(value) {
  return (Array.isArray(value) ? value : []).map(positiveInt).filter(Boolean);
}

function positiveInt(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

function send(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, packetId, payload, label);
    return;
  }
  ctx.sendResponse(socket, packet.sequence, packetId, () => ctx.buildEncryptedPacket(packet.sequence, packetId, payload));
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

module.exports = {
  PACKETS,
  ERRORS,
  UNIT_VOTE_COUNT,
  SHIP_VOTE_COUNT,
  CASTING_VOTE_COUNT,
  createDraftPvpVoteHandlers,
  createPvpCastingVoteHandlers,
  updateDraftPvpVote,
  updatePvpCastingVote,
  decodeVoteRequest,
  buildVoteAckPayload,
  buildPvpCastingVoteData,
  normalizePvpCastingVoteData,
  getEligibility,
  getStandardEligibility,
};
