const {
  writeSignedVarInt,
  writeNullableObject,
  writeNullableObjectOrNull,
  buildItemMiscData,
  buildRewardData,
  readSignedVarInt,
} = require("../packet-codec");
const { getMiscItemTemplet } = require("../game-data");
const { spendMiscItem } = require("../inventory");
const { grantRewardByType, createEmptyReward, grantChoiceItemReward } = require("../reward");
const { completeMissionTracking, makeMissionTracking, addMissionTrackingCondition } = require("../mission-tracking");

const PACKETS = Object.freeze({
  RANDOM_ITEM_BOX_OPEN_REQ: 1007,
  RANDOM_ITEM_BOX_OPEN_ACK: 1008,
  CHOICE_ITEM_USE_REQ: 1025,
  CHOICE_ITEM_USE_ACK: 1026,
});

function createItemHandler(packetId, name) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      ctx.socket = socket;
      const user = socket && socket.session ? socket.session.user : null;
      const request = decodeItemRequest(ctx, packetId, packet.payload);
      const response =
        packetId === PACKETS.RANDOM_ITEM_BOX_OPEN_REQ
          ? buildRandomItemBoxOpenAck(ctx, user, request)
          : buildChoiceItemUseAck(ctx, user, request);
      const missionTracking = trackItemUseMission(ctx, user, request);
      console.log(`[item:${name}] ACK packetId=${response.packetId} itemId=${request.itemId || request.itemID || 0} count=${request.count || 1}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      completeMissionTracking(ctx, socket, user, missionTracking, { label: "item-mission-update" });
      if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
      return true;
    },
  };
}

function trackItemUseMission(ctx, user, request = {}) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return null;
  const itemId = Number(request.itemId || request.itemID || 0);
  const count = Math.max(1, Number(request.count || 1) || 1);
  if (itemId <= 0 || count <= 0) return null;
  const nowValue = now(ctx);
  const tracking = makeMissionTracking(nowValue);
  const changed = ctx.trackMissionEvent(user, "USE_RESOURCE", count, {
    now: nowValue,
    itemId,
    resourceId: itemId,
    value: itemId,
  });
  addMissionTrackingCondition(tracking, "USE_RESOURCE", changed);
  return tracking;
}

function buildRandomItemBoxOpenAck(ctx, user, request) {
  const itemId = Number(request.itemId || request.itemID || 0);
  const count = Math.max(1, Number(request.count || 1));
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, count, { regDate: now(ctx) }) : null;
  const reward = grantRewardByType(ctx, user, "RT_MISC", itemId, count, count, 0, {
    expandPackages: true,
    openRandomBoxes: true,
    regDate: now(ctx),
  });
  return {
    packetId: PACKETS.RANDOM_ITEM_BOX_OPEN_ACK,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildRewardData(reward)),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
    ]),
  };
}

function buildChoiceItemUseAck(ctx, user, request) {
  const itemId = Number(request.itemId || 0);
  const rewardId = Number(request.rewardId || 0);
  const count = Math.max(1, Number(request.count || 1));
  const costItem = itemId > 0 ? spendMiscItem(user, itemId, count, { regDate: now(ctx) }) : null;
  const reward = itemId > 0
    ? grantChoiceItemReward(ctx, user, itemId, rewardId, count, {
        expandPackages: true,
        regDate: now(ctx),
        rewardId,
        setOptionId: Number(request.setOptionId || 0),
        subSkillId: Number(request.subSkillId || 0),
        statTypes: Array.isArray(request.statTypes) ? request.statTypes : [],
        potentialOptionId: Number(request.potentialOptionId || 0),
        potentialOption2Id: Number(request.potentialOption2Id || 0),
      })
    : createEmptyReward();
  return {
    packetId: PACKETS.CHOICE_ITEM_USE_ACK,
    payload: Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObjectOrNull(costItem ? buildItemMiscData(costItem) : null),
      writeNullableObject(buildRewardData(reward)),
    ]),
  };
}

function getChoiceRewardType(itemId) {
  const templet = getMiscItemTemplet(itemId) || {};
  switch (String(templet.m_ItemMiscType || "")) {
    case "IMT_CHOICE_UNIT":
      return "RT_UNIT";
    case "IMT_CHOICE_SHIP":
      return "RT_SHIP";
    case "IMT_CHOICE_OPERATOR":
      return "RT_OPERATOR";
    case "IMT_CHOICE_EQUIP":
      return "RT_EQUIP";
    case "IMT_CHOICE_SKIN":
      return "RT_SKIN";
    case "IMT_CHOICE_MISC":
      return "RT_MISC";
    default:
      return "RT_MISC";
  }
}

function decodeItemRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  let offset = 0;
  const nextInt = () => {
    const read = readSignedVarInt(payload, offset);
    offset = read.offset;
    return read.value;
  };
  const nextIntOr = (fallback = 0) => {
    if (offset >= payload.length) return fallback;
    return nextInt();
  };
  const nextIntListOrEmpty = () => {
    if (offset >= payload.length) return [];
    const read = readRawVarInt(payload, offset);
    offset = read.offset;
    const count = Math.max(0, Math.min(32, Number(read.value || 0)));
    const values = [];
    for (let index = 0; index < count && offset < payload.length; index += 1) {
      values.push(nextInt());
    }
    return values;
  };
  try {
    if (packetId === PACKETS.RANDOM_ITEM_BOX_OPEN_REQ) return { itemId: nextInt(), count: nextInt() };
    if (packetId === PACKETS.CHOICE_ITEM_USE_REQ) {
      return {
        itemId: nextInt(),
        rewardId: nextInt(),
        count: nextInt(),
        setOptionId: nextIntOr(0),
        subSkillId: nextIntOr(0),
        statTypes: nextIntListOrEmpty(),
        potentialOptionId: nextIntOr(0),
        potentialOption2Id: nextIntOr(0),
      };
    }
  } catch (err) {
    console.log(`[item] request decode failed packetId=${packetId}: ${err.message}`);
  }
  return {};
}

function readRawVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length && shift < 35) {
    const byte = buffer[cursor++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: cursor };
    shift += 7;
  }
  return { value: 0, offset: cursor };
}

function now(ctx) {
  return ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n;
}

module.exports = {
  PACKETS,
  createItemHandler,
};
