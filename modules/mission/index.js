const {
  writeBool,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullObject,
  writeNullableObject,
  writeNullableObjectList,
  writeObjectList,
  writeIntList,
  readSignedVarInt,
  buildItemMiscData,
  buildRewardData,
} = require("../packet-codec");
const {
  buildMissionDataEntries,
  completeAllMissionsForTab,
  completeMission,
  completeRepeatableMission,
  changeRandomMission,
  donateMissionItem,
  updateMissionProgress,
} = require("../account-progression");

const MISSION_COMPLETE_REQ = 1620;
const MISSION_COMPLETE_ACK = 1621;
const MISSION_GET_COMPLETE_REWARD_REQ = 1622;
const MISSION_GET_COMPLETE_REWARD_ACK = 1623;
const MISSION_COMPLETE_ALL_REQ = 1624;
const MISSION_COMPLETE_ALL_ACK = 1625;
const RANDOM_MISSION_CHANGE_REQ = 1626;
const RANDOM_MISSION_CHANGE_ACK = 1627;
const RANDOM_MISSION_REFRESH_NOT = 1628;
const MISSION_GIVE_ITEM_REQ = 1650;
const MISSION_GIVE_ITEM_ACK = 1651;
const MISSION_UPDATE_NOT = 1619;

function createMissionHandlers() {
  return [
    {
      packetId: MISSION_COMPLETE_REQ,
      name: "MISSION_COMPLETE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeMissionCompleteReq(ctx, packet.payload);
        const clock = getMissionClockOptions(ctx);
        const result = completeMission(user, req, { ...clock, ctx });
        console.log(
          `[mission] complete uid=${user.userUid || "(ephemeral)"} missionID=${result.missionID} tabId=${result.tabId} groupId=${result.groupId} exp=${result.reward.userExp} achievePoint=${result.reward.achievePoint} eventPassExp=${result.reward.eventPassExpDelta || 0}`
        );
        send(ctx, socket, packet, MISSION_COMPLETE_ACK, buildMissionCompleteAckPayload(req, result));
        if (result.changed) {
          sendPostClaimMissionUpdate(ctx, socket, user, result, clock);
          persist(ctx);
        }
        return true;
      },
    },
    {
      packetId: MISSION_GET_COMPLETE_REWARD_REQ,
      name: "MISSION_GET_COMPLETE_REWARD_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeMissionGetCompleteRewardReq(ctx, packet.payload);
        const clock = getMissionClockOptions(ctx);
        const result = completeRepeatableMission(user, req, { ...clock, ctx });
        console.log(
          `[mission] get-complete-reward uid=${user.userUid || "(ephemeral)"} missionID=${result.missionID} tabId=${result.tabId} groupId=${result.groupId} exp=${result.reward.userExp} achievePoint=${result.reward.achievePoint} eventPassExp=${result.reward.eventPassExpDelta || 0}`
        );
        send(ctx, socket, packet, MISSION_GET_COMPLETE_REWARD_ACK, buildMissionGetCompleteRewardAckPayload(req, result));
        if (result.changed) {
          sendPostClaimMissionUpdate(ctx, socket, user, result, clock);
          persist(ctx);
        }
        return true;
      },
    },
    {
      packetId: MISSION_COMPLETE_ALL_REQ,
      name: "MISSION_COMPLETE_ALL_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const tabId = decodeMissionCompleteAllReq(ctx, packet.payload).tabId;
        const clock = getMissionClockOptions(ctx);
        const result = completeAllMissionsForTab(user, tabId, { ...clock, ctx });
        console.log(
          `[mission] complete-all uid=${user.userUid || "(ephemeral)"} tabId=${tabId} missions=${result.missionIDs.length} exp=${result.reward.userExp} achievePoint=${result.reward.achievePoint} eventPassExp=${result.reward.eventPassExpDelta || 0}`
        );
        send(ctx, socket, packet, MISSION_COMPLETE_ALL_ACK, buildMissionCompleteAllAckPayload(result));
        if (result.missionIDs.length) {
          sendPostClaimMissionUpdate(ctx, socket, user, result, { ...clock, tabId });
          persist(ctx);
        }
        return true;
      },
    },
    {
      packetId: RANDOM_MISSION_CHANGE_REQ,
      name: "RANDOM_MISSION_CHANGE_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeRandomMissionChangeReq(ctx, packet.payload);
        const result = changeRandomMission(user, req, getMissionClockOptions(ctx));
        console.log(
          `[mission] random-change uid=${user.userUid || "(ephemeral)"} tabId=${req.tabId} missionID=${req.missionId} after=${result.mission ? result.mission.missionID : 0} errorCode=${result.errorCode}`
        );
        send(ctx, socket, packet, RANDOM_MISSION_CHANGE_ACK, buildRandomMissionChangeAckPayload(result));
        if (result.refreshed && result.missions) {
          sendRandomMissionRefreshNot(ctx, socket, result.tabId, result.missions);
        }
        if (result.changed || result.refreshed) persist(ctx);
        return true;
      },
    },
    {
      packetId: MISSION_GIVE_ITEM_REQ,
      name: "MISSION_GIVE_ITEM_REQ",
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const req = decodeMissionGiveItemReq(ctx, packet.payload);
        const result = donateMissionItem(user, req, { ...getMissionClockOptions(ctx), ctx });
        console.log(
          `[mission] give-item uid=${user.userUid || "(ephemeral)"} missionID=${result.missionID} itemId=${result.itemId} count=${result.count}`
        );
        send(ctx, socket, packet, MISSION_GIVE_ITEM_ACK, buildMissionGiveItemAckPayload(result));
        if (result.count > 0) {
          if (result.mission) sendMissionUpdateNot(ctx, socket, [result.mission]);
          persist(ctx);
        }
        return true;
      },
    },
  ];
}

function buildMissionCompleteAckPayload(req, result = {}) {
  const missionID = Number((result && result.missionID) || (req && req.missionID) || 0);
  const errorCode = Number(result.errorCode || 0);
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(missionID),
    errorCode ? writeNullObject() : writeNullableObject(buildRewardData(result.reward || {})),
    errorCode ? writeNullObject() : writeNullableObject(buildAdditionalRewardData(result.reward || {})),
  ]);
}

function buildMissionGetCompleteRewardAckPayload(req, result = {}) {
  const errorCode = Number(result.errorCode || 0);
  const mission = result.mission || {
    missionID: Number((result && result.missionID) || (req && req.missionID) || 0),
    tabId: Number((result && result.tabId) || 1),
    groupId: Number((result && result.groupId) || (result && result.missionID) || (req && req.missionID) || 0),
    times: 0,
    isComplete: false,
  };
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    errorCode ? writeNullObject() : writeNullableObject(buildRewardData(result.reward || {})),
    errorCode ? writeNullObject() : writeNullableObject(buildMissionData(mission)),
  ]);
}

function buildMissionCompleteAllAckPayload(result = {}) {
  const errorCode = Number(result.errorCode || 0);
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeIntList(errorCode ? [] : result.missionIDs || []),
    errorCode ? writeNullObject() : writeNullableObject(buildRewardData(result.reward || {})),
    errorCode ? writeNullObject() : writeNullableObject(buildAdditionalRewardData(result.reward || {})),
  ]);
}

function buildRandomMissionChangeAckPayload(result = {}) {
  const errorCode = Number(result.errorCode || 0);
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    writeSignedVarInt(errorCode ? 0 : Number(result.beforeGroupId || 0)),
    errorCode || !result.mission ? writeNullObject() : writeNullableObject(buildMissionData(result.mission)),
    writeSignedVarInt(errorCode ? 0 : Number(result.remainRefreshCount || 0)),
    errorCode || !result.costItem ? writeNullObject() : writeNullableObject(buildItemMiscData(result.costItem)),
  ]);
}

function buildRandomMissionRefreshNotPayload(tabId, missions = []) {
  return Buffer.concat([
    writeSignedVarInt(Number(tabId || 0)),
    writeObjectList(missions.map((mission) => writeNullableObject(buildMissionData(mission)))),
  ]);
}

function buildMissionGiveItemAckPayload(result = {}) {
  const errorCode = Number(result.errorCode || 0);
  const costItems = Array.isArray(result.costItems) ? result.costItems : [];
  return Buffer.concat([writeSignedVarInt(errorCode), writeNullableObjectList((errorCode ? [] : costItems).map(buildItemMiscData))]);
}

function buildMissionUpdateNotPayload(missions = []) {
  return writeObjectList(missions.map((mission) => writeNullableObject(buildMissionData(mission))));
}

function buildMissionData(mission = {}) {
  return Buffer.concat([
    writeSignedVarInt(Number(mission.tabId || 1)),
    writeSignedVarInt(Number(mission.missionID || mission.mission_id || 0)),
    writeSignedVarInt(Number(mission.groupId || mission.group_id || mission.missionID || 0)),
    writeSignedVarLong(BigInt(Math.max(0, Number(mission.times || 0)))),
    writeSignedVarLong(coerceDateTimeTicks(mission.lastUpdateDate)),
    writeBool(mission.rewardClaimed === true || mission.isComplete === true || Boolean(mission.claimedAt)),
  ]);
}

function coerceDateTimeTicks(value) {
  try {
    if (value == null || value === "") return BigInt(Date.now()) * 10000n + 621355968000000000n;
    const parsed = BigInt(String(value));
    return parsed > 9000000000000000n ? parsed & 0x3fffffffffffffffn : parsed;
  } catch (_) {
    return BigInt(Date.now()) * 10000n + 621355968000000000n;
  }
}

function buildAdditionalRewardData(reward = {}) {
  return Buffer.concat([
    writeSignedVarLong(BigInt(Math.max(0, Number(reward.guildExpDelta || 0)))),
    writeSignedVarLong(BigInt(Math.max(0, Number(reward.unionPointDelta || 0)))),
    writeSignedVarLong(BigInt(Math.max(0, Number(reward.eventPassExpDelta || 0)))),
  ]);
}

function decodeMissionCompleteReq(ctx, encryptedPayload) {
  if (ctx && typeof ctx.decodeMissionCompleteReq === "function") return ctx.decodeMissionCompleteReq(encryptedPayload);
  const payload = decrypt(ctx, encryptedPayload);
  let offset = 0;
  const tabId = readSignedVarInt(payload, offset);
  offset = tabId.offset;
  const groupId = readSignedVarInt(payload, offset);
  offset = groupId.offset;
  const missionID = readSignedVarInt(payload, offset);
  return { tabId: tabId.value, groupId: groupId.value, missionID: missionID.value };
}

function decodeMissionCompleteAllReq(ctx, encryptedPayload) {
  const payload = decrypt(ctx, encryptedPayload);
  try {
    const tabId = readSignedVarInt(payload, 0);
    return { tabId: tabId.value };
  } catch (_) {
    return { tabId: 0 };
  }
}

function decodeMissionGetCompleteRewardReq(ctx, encryptedPayload) {
  const payload = decrypt(ctx, encryptedPayload);
  try {
    const missionID = readSignedVarInt(payload, 0);
    return { missionID: missionID.value };
  } catch (_) {
    return { missionID: 0 };
  }
}

function decodeRandomMissionChangeReq(ctx, encryptedPayload) {
  const payload = decrypt(ctx, encryptedPayload);
  let offset = 0;
  try {
    const tabId = readSignedVarInt(payload, offset);
    offset = tabId.offset;
    const missionId = readSignedVarInt(payload, offset);
    return { tabId: tabId.value, missionId: missionId.value, missionID: missionId.value };
  } catch (_) {
    return { tabId: 0, missionId: 0, missionID: 0 };
  }
}

function decodeMissionGiveItemReq(ctx, encryptedPayload) {
  const payload = decrypt(ctx, encryptedPayload);
  let offset = 0;
  try {
    const missionId = readSignedVarInt(payload, offset);
    offset = missionId.offset;
    const count = readSignedVarInt(payload, offset);
    return { missionId: missionId.value, missionID: missionId.value, count: count.value };
  } catch (_) {
    return { missionId: 0, missionID: 0, count: 0 };
  }
}

function decrypt(ctx, payload) {
  try {
    return ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.alloc(0);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function send(ctx, socket, packet, packetId, payload) {
  ctx.sendResponse(socket, packet.sequence, packetId, () => ctx.buildEncryptedPacket(packet.sequence, packetId, payload));
}

function sendMissionUpdateNot(ctx, socket, missions) {
  const payload = buildMissionUpdateNotPayload(missions);
  if (ctx && typeof ctx.sendServerGamePacket === "function" && socket && socket.session && socket.session.gameReplay) {
    ctx.sendServerGamePacket(socket, MISSION_UPDATE_NOT, payload, "mission-update");
  }
}

function sendRandomMissionRefreshNot(ctx, socket, tabId, missions) {
  if (ctx && typeof ctx.sendServerGamePacket === "function" && socket && socket.session && socket.session.gameReplay) {
    ctx.sendServerGamePacket(socket, RANDOM_MISSION_REFRESH_NOT, buildRandomMissionRefreshNotPayload(tabId, missions), "random-mission-refresh");
  }
}

function sendPostClaimMissionUpdate(ctx, socket, user, result = {}, options = {}) {
  const missions = buildPostClaimMissionUpdates(user, result, options);
  if (missions.length > 0) sendMissionUpdateNot(ctx, socket, missions);
}

function buildPostClaimMissionUpdates(user, result = {}, options = {}) {
  const tabIds = new Set();
  const baseTabId = Number((result && result.tabId) || options.tabId || 0);
  if (baseTabId > 0) tabIds.add(baseTabId);
  const reward = (result && result.reward) || {};
  if (Number(reward.dailyMissionPoint || 0) > 0 || baseTabId === 2) tabIds.add(2);
  if (Number(reward.weeklyMissionPoint || 0) > 0 || baseTabId === 3) tabIds.add(3);
  if (Number(reward.achievePoint || 0) > 0 || baseTabId === 4) tabIds.add(4);

  const seen = new Set();
  const missions = [];
  for (const tabId of tabIds) {
    for (const [, mission] of buildMissionDataEntries(user, {
      tabId,
      now: options.now,
      eventDateKey: options.eventDateKey,
    })) {
      const key = `${Number(mission.groupId || 0)}:${Number(mission.missionID || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      missions.push(mission);
    }
  }
  return missions;
}

function getMissionClockOptions(ctx) {
  if (ctx && typeof ctx.getMissionClockOptions === "function") return ctx.getMissionClockOptions();
  return { now: ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined, eventDateKey: "" };
}

function persist(ctx) {
  if (ctx && ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  const user = ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
  if (socket && socket.session) socket.session.user = user;
  return user;
}

module.exports = {
  MISSION_COMPLETE_REQ,
  MISSION_COMPLETE_ACK,
  MISSION_GET_COMPLETE_REWARD_REQ,
  MISSION_GET_COMPLETE_REWARD_ACK,
  MISSION_COMPLETE_ALL_REQ,
  MISSION_COMPLETE_ALL_ACK,
  RANDOM_MISSION_CHANGE_REQ,
  RANDOM_MISSION_CHANGE_ACK,
  RANDOM_MISSION_REFRESH_NOT,
  MISSION_GIVE_ITEM_REQ,
  MISSION_GIVE_ITEM_ACK,
  MISSION_UPDATE_NOT,
  createMissionHandlers,
  buildMissionCompleteAckPayload,
  buildMissionGetCompleteRewardAckPayload,
  buildMissionCompleteAllAckPayload,
  buildRandomMissionChangeAckPayload,
  buildRandomMissionRefreshNotPayload,
  buildMissionGiveItemAckPayload,
  buildMissionUpdateNotPayload,
  buildMissionData,
  buildPostClaimMissionUpdates,
  completeMission,
  completeRepeatableMission,
  completeAllMissionsForTab,
  donateMissionItem,
  updateMissionProgress,
};
