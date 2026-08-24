"use strict";

const { createAdminRewardPosts } = require("../admin");
const { getEmoticonTemplet } = require("../game-data");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");
const { grantMiscItem, spendMiscItem, toBigInt } = require("../inventory");
const { buildCommonProfileData, buildGuildSimpleData } = require("../leaderboard");
const { dateFromDateTime } = require("../server-time");
const {
  buildItemMiscData,
  buildRewardData,
  readBool,
  readString,
  readSignedVarInt,
  readSignedVarLong,
  writeBool,
  writeInt64LE,
  writeNullableObject,
  writeNullableObjectList,
  writeNullObject,
  writeObjectList,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
} = require("../packet-codec");

const PACKETS = Object.freeze({
  ADD_NOT: 1649,
  CREATE_REQ: 3400,
  CREATE_ACK: 3401,
  CLOSE_REQ: 3402,
  CLOSE_ACK: 3403,
  CLOSE_CANCEL_REQ: 3404,
  CLOSE_CANCEL_ACK: 3405,
  SEARCH_REQ: 3406,
  SEARCH_ACK: 3407,
  LIST_REQ: 3408,
  LIST_ACK: 3409,
  JOIN_REQ: 3410,
  JOIN_ACK: 3411,
  CANCEL_JOIN_REQ: 3412,
  CANCEL_JOIN_ACK: 3413,
  DATA_REQ: 3414,
  DATA_ACK: 3415,
  DATA_UPDATED_NOT: 3416,
  ACCEPT_JOIN_REQ: 3417,
  ACCEPT_JOIN_ACK: 3418,
  ACCEPT_JOIN_NOT: 3419,
  INVITE_REQ: 3420,
  INVITE_ACK: 3421,
  INVITE_NOT: 3422,
  CANCEL_INVITE_REQ: 3423,
  CANCEL_INVITE_ACK: 3424,
  CANCEL_REQUEST_NOT: 3425,
  ACCEPT_INVITE_REQ: 3426,
  ACCEPT_INVITE_ACK: 3427,
  EXIT_REQ: 3428,
  EXIT_ACK: 3429,
  SET_MEMBER_GRADE_REQ: 3430,
  SET_MEMBER_GRADE_ACK: 3431,
  MEMBER_GRADE_UPDATED_NOT: 3432,
  BAN_REQ: 3433,
  BAN_ACK: 3434,
  BAN_NOT: 3435,
  MASTER_MIGRATION_REQ: 3436,
  MASTER_MIGRATION_ACK: 3437,
  MASTER_SPECIFIED_MIGRATION_REQ: 3438,
  MASTER_SPECIFIED_MIGRATION_ACK: 3439,
  MASTER_SPECIFIED_MIGRATION_NOT: 3440,
  UPDATE_DATA_REQ: 3441,
  UPDATE_DATA_ACK: 3442,
  UPDATE_NOTICE_REQ: 3443,
  UPDATE_NOTICE_ACK: 3444,
  UPDATE_MEMBER_GREETING_REQ: 3445,
  UPDATE_MEMBER_GREETING_ACK: 3446,
  ATTENDANCE_REQ: 3447,
  ATTENDANCE_ACK: 3448,
  LEVEL_UP_NOT: 3449,
  CHAT_REQ: 3451,
  CHAT_ACK: 3452,
  CHAT_NOT: 3453,
  CHAT_LIST_REQ: 3454,
  CHAT_LIST_ACK: 3455,
  CHAT_LIST_NOT: 3456,
  USER_PROFILE_UPDATED_NOT: 3457,
  JOIN_DISABLETIME_UPDATED_NOT: 3458,
  DELETED_NOT: 3450,
  RECOMMEND_INVITE_LIST_REQ: 3459,
  RECOMMEND_INVITE_LIST_ACK: 3460,
  DONATION_REQ: 3461,
  DONATION_ACK: 3462,
  UPDATE_NOTICE_NOT: 3463,
  BUY_REQ: 3464,
  BUY_ACK: 3465,
  WELFARE_POINT_REQ: 3466,
  WELFARE_POINT_ACK: 3467,
  CHAT_COMPLAIN_REQ: 3468,
  CHAT_COMPLAIN_ACK: 3469,
  BLOCK_MUTE_NOT: 3470,
  CHAT_TRANSLATE_REQ: 3488,
  CHAT_TRANSLATE_ACK: 3489,
  RENAME_REQ: 3500,
  RENAME_ACK: 3501,
  RENAME_NOT: 3502,
});

const ERRORS = Object.freeze({
  OK: 0,
  INSUFFICIENT_RESOURCE: 110,
  INVALID_REQUEST: 20191,
  ALREADY_JOINED: 20431,
  INVALID_GUILD_UID: 20432,
  INVALID_MEMBER_UID: 20433,
  INVALID_GRADE: 20434,
  CREATION_INVALID_UID: 20435,
  CREATION_INVALID_NAME: 20436,
  CREATION_USER_LEVEL: 20437,
  CREATION_DUPLICATED_NAME: 20442,
  NOT_A_MEMBER: 20443,
  INVITE_DATA_NOT_FOUND: 20444,
  INVITE_USER_IN_OTHER_GUILD: 20445,
  SET_GRADE_INVALID_TARGET: 20448,
  SET_GRADE_INVALID_VALUE: 20449,
  SET_GRADE_MAX_STAFF_COUNT: 20450,
  BAN_INVALID_TARGET: 20451,
  MASTER_MIGRATION_INVALID_TARGET: 20452,
  MASTER_MIGRATION_INVALID_GUILD_STATE: 20453,
  MASTER_NOT_FOUND: 20454,
  MASTER_MIGRATION_DB_FAIL: 20455,
  MASTER_MIGRATION_INVALID_TARGET_GRADE: 20457,
  MAX_REQUEST_COUNT: 20466,
  MAX_MEMBER_COUNT: 20467,
  MAX_REQUEST_RECEIVE_COUNT: 20468,
  MAX_INVITE_COUNT: 20469,
  ALREADY_JOIN_REQUESTED: 20470,
  ALREADY_INVITED: 20471,
  NOT_JOIN_REQUESTED: 20472,
  JOIN_DISABLED: 20473,
  ACCEPT_NO_PERMISSION: 20476,
  CLOSE_INVALID_STATE: 20477,
  JOIN_REQUEST_EXIST: 20478,
  ATTENDANCE_DUPLICATE_REQUEST: 20479,
  NOT_ENOUGH_GRADE: 20480,
  NOT_ENOUGH_UNION_POINT: 20481,
  BUFF_STILL_ACTIVATING: 20482,
  JOIN_DISABLE_PENALTY: 20522,
  INVALID_DONATION_ID: 20528,
  INVALID_WELFARE_ID: 20529,
  DONATION_DAILY_LIMIT: 20530,
  DONATION_JOIN_DATE_LIMIT: 20531,
  DATA_NOT_EXISTS: 20536,
  WELFARE_POINT_LIMIT: 20587,
  NOT_MASTER: 20616,
  GUILD_GREETING_MUTE: 20614,
  GUILD_MEMBER_GREETING_MUTE: 20615,
  GUILD_UPDATE_NOTICE: 20617,
  GUILD_NOTICE_MUTE: 20618,
  PERSONAL_BUFF_ALREADY_ACTIVATING: 20707,
  INVALID_DONATION_COUNT: 24100,
  EMOTICON_NOT_OWNED: 20583,
  CHAT_MESSAGE_UID_NOT_FOUND: 20584,
  CHAT_COMPLAIN_DUPLICATED: 20586,
  CHAT_COMPLAIN_INVALID_TYPE: 20588,
  CHAT_COMPLAIN_ALREADY_BLOCKED: 20589,
  GUILD_CHAT_BLOCK_MUTE: 20592,
  GUILD_TRANSLATE_MESSAGE_NOT_FOUND: 20721,
  GUILD_TRANSLATE_MESSAGE_NOT_INITIALIZED: 20722,
  GUILD_TRANSLATE_MESSAGE_API_EXCEPTION: 20723,
  RENAME_FAILED: 27000,
  RENAME_INVALID_NAME: 27001,
  RENAME_SAME_NAME: 27002,
  RENAME_NO_PERMISSION: 27003,
  RENAME_CHANGE_COUNT: 27004,
  RENAME_LIMIT_DAY: 27005,
  RENAME_INSUFFICIENT_RESOURCE: 27006,
  RENAME_ALREADY_EXISTS_NAME: 27007,
});

const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MINUTE = 600000000n;
let cachedTables = null;
const guildDeletionTimers = new WeakMap();

function createCompanyBuffHandlers() {
  return [
    {
      packetId: PACKETS.CREATE_REQ,
      name: "GUILD_CREATE_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildCreateRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? createGuild(ctx, user, request)
          : guildLifecycleFailure(ERRORS.INVALID_REQUEST);
        sendResponse(ctx, socket, packet, PACKETS.CREATE_ACK, buildGuildCreateAckPayload(ctx, user, result), "guild-create");
        if (result.changed) {
          trackResourceSpend(ctx, user, result.resourceSpend);
          persistAndInvalidate(ctx, "guild-create");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CLOSE_REQ,
      name: "GUILD_CLOSE_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? closeGuild(ctx, user, request.guildUid)
          : guildLifecycleFailure(ERRORS.INVALID_REQUEST);
        sendResponse(ctx, socket, packet, PACKETS.CLOSE_ACK, buildGuildCloseAckPayload(result), "guild-close");
        if (result.changed) {
          notifyGuildData(ctx, socket, result.guildUid, "guild-close-data");
          scheduleGuildDeletion(ctx, result.guildUid, result.closingTime);
          persistAndInvalidate(ctx, "guild-close");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CLOSE_CANCEL_REQ,
      name: "GUILD_CLOSE_CANCEL_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? cancelGuildClosure(ctx, user, request.guildUid)
          : guildLifecycleFailure(ERRORS.INVALID_REQUEST);
        sendResponse(ctx, socket, packet, PACKETS.CLOSE_CANCEL_ACK, buildGuildCloseCancelAckPayload(result), "guild-close-cancel");
        if (result.changed) {
          cancelScheduledGuildDeletion(ctx, result.guildUid);
          notifyGuildData(ctx, socket, result.guildUid, "guild-close-cancel-data");
          persistAndInvalidate(ctx, "guild-close-cancel");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.SEARCH_REQ,
      name: "GUILD_SEARCH_REQ",
      handle(ctx, socket, packet) {
        const request = decodeGuildSearchRequest(ctx, packet && packet.payload);
        const user = socket && socket.session && socket.session.user;
        const guilds = request.valid ? searchGuilds(ctx, user, request.keyword) : [];
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.SEARCH_ACK,
          buildGuildListAckPayload(request.valid ? ERRORS.OK : ERRORS.INVALID_REQUEST, guilds),
          "guild-search"
        );
        return true;
      },
    },
    {
      packetId: PACKETS.LIST_REQ,
      name: "GUILD_LIST_REQ",
      handle(ctx, socket, packet) {
        const request = decodeGuildListRequest(ctx, packet && packet.payload);
        const user = socket && socket.session && socket.session.user;
        const guilds = request.valid ? listRelatedGuilds(ctx, user, request.guildListType) : [];
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.LIST_ACK,
          buildGuildListAckPayload(request.valid ? ERRORS.OK : ERRORS.INVALID_REQUEST, guilds),
          "guild-list"
        );
        return true;
      },
    },
    {
      packetId: PACKETS.JOIN_REQ,
      name: "GUILD_JOIN_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildJoinRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? joinGuild(ctx, user, request)
          : guildJoinFailure(ctx, user, ERRORS.INVALID_REQUEST, 0n);
        sendResponse(ctx, socket, packet, PACKETS.JOIN_ACK, buildGuildJoinAckPayload(ctx, user, result), "guild-join");
        if (result.changed) {
          notifyGuildData(ctx, socket, result.guildUid, "guild-join-data");
          persistAndInvalidate(ctx, "guild-join");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CANCEL_JOIN_REQ,
      name: "GUILD_CANCEL_JOIN_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? cancelGuildJoin(user, request.guildUid)
          : { changed: false, errorCode: ERRORS.INVALID_REQUEST, guildUid: 0n };
        sendResponse(ctx, socket, packet, PACKETS.CANCEL_JOIN_ACK, buildGuildCancelJoinAckPayload(result), "guild-cancel-join");
        if (result.changed) {
          notifyGuildData(ctx, socket, result.guildUid, "guild-cancel-join-data", user);
          persistAndInvalidate(ctx, "guild-cancel-join");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.DATA_REQ,
      name: "GUILD_DATA_REQ",
      handle(ctx, socket, packet) {
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const guildData = request.valid ? getGuildData(ctx, request.guildUid) : null;
        const errorCode = !request.valid
          ? ERRORS.INVALID_REQUEST
          : request.guildUid <= 0n
            ? ERRORS.INVALID_GUILD_UID
            : guildData
              ? ERRORS.OK
              : ERRORS.DATA_NOT_EXISTS;
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.DATA_ACK,
          buildGuildDataAckPayload({ errorCode, guildUid: request.guildUid, guildData }),
          "guild-data"
        );
        return true;
      },
    },
    {
      packetId: PACKETS.ACCEPT_JOIN_REQ,
      name: "GUILD_ACCEPT_JOIN_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildAcceptJoinRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? acceptGuildJoin(ctx, actor, request)
          : membershipFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.ACCEPT_JOIN_ACK,
          buildGuildAcceptJoinAckPayload(result),
          "guild-accept-join"
        );
        if (result.changed) {
          const targetSocket = findSocketForUser(ctx, socket, result.targetUser);
          if (targetSocket) {
            sendPush(
              ctx,
              targetSocket,
              PACKETS.ACCEPT_JOIN_NOT,
              buildGuildAcceptJoinNotPayload(ctx, result.targetUser, result),
              "guild-accept-join-result"
            );
          }
          notifyGuildData(ctx, socket, result.guildUid, "guild-accept-join-data");
          persistAndInvalidate(ctx, "guild-accept-join");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.INVITE_REQ,
      name: "GUILD_INVITE_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildInviteRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? inviteGuildMember(ctx, actor, request)
          : membershipFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(ctx, socket, packet, PACKETS.INVITE_ACK, buildGuildInviteAckPayload(result), "guild-invite");
        if (result.changed) {
          const targetSocket = findSocketForUser(ctx, socket, result.targetUser);
          if (targetSocket) {
            sendPush(ctx, targetSocket, PACKETS.INVITE_NOT, buildGuildInviteNotPayload(result.guildUid), "guild-invite-not");
          }
          notifyGuildData(ctx, socket, result.guildUid, "guild-invite-data");
          persistAndInvalidate(ctx, "guild-invite");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CANCEL_INVITE_REQ,
      name: "GUILD_CANCEL_INVITE_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildInviteRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? cancelGuildInvite(ctx, actor, request)
          : membershipFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.CANCEL_INVITE_ACK,
          buildGuildCancelInviteAckPayload(result),
          "guild-cancel-invite"
        );
        if (result.changed) {
          const targetSocket = findSocketForUser(ctx, socket, result.targetUser);
          if (targetSocket) {
            sendPush(
              ctx,
              targetSocket,
              PACKETS.CANCEL_REQUEST_NOT,
              buildGuildCancelRequestNotPayload(result.guildUid, false),
              "guild-cancel-invite-not"
            );
          }
          notifyGuildData(ctx, socket, result.guildUid, "guild-cancel-invite-data");
          persistAndInvalidate(ctx, "guild-cancel-invite");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.ACCEPT_INVITE_REQ,
      name: "GUILD_ACCEPT_INVITE_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildAcceptInviteRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? acceptGuildInvite(ctx, user, request)
          : membershipFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.ACCEPT_INVITE_ACK,
          buildGuildAcceptInviteAckPayload(ctx, user, result),
          "guild-accept-invite"
        );
        if (result.changed) {
          notifyGuildData(ctx, socket, result.guildUid, "guild-accept-invite-data");
          persistAndInvalidate(ctx, "guild-accept-invite");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.EXIT_REQ,
      name: "GUILD_EXIT_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? exitGuild(ctx, user, request.guildUid)
          : guildAdminFailure(ERRORS.INVALID_REQUEST, { guildUid: 0n });
        sendResponse(ctx, socket, packet, PACKETS.EXIT_ACK, buildGuildExitAckPayload(result), "guild-exit");
        if (result.changed) {
          sendPush(
            ctx,
            socket,
            PACKETS.JOIN_DISABLETIME_UPDATED_NOT,
            buildGuildJoinDisableTimeUpdatedNotPayload(result.joinDisableTime),
            "guild-exit-join-disable-time"
          );
          notifyGuildData(ctx, socket, result.guildUid, "guild-exit-data", user);
          persistAndInvalidate(ctx, "guild-exit");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.SET_MEMBER_GRADE_REQ,
      name: "GUILD_SET_MEMBER_GRADE_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildSetMemberGradeRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? setGuildMemberGrade(ctx, actor, request)
          : guildAdminFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.SET_MEMBER_GRADE_ACK,
          buildGuildSetMemberGradeAckPayload(result),
          "guild-set-member-grade"
        );
        if (result.changed) {
          const targetSocket = findSocketForUser(ctx, socket, result.targetUser);
          if (targetSocket) {
            sendPush(
              ctx,
              targetSocket,
              PACKETS.MEMBER_GRADE_UPDATED_NOT,
              buildGuildMemberGradeUpdatedNotPayload(result),
              "guild-member-grade-updated"
            );
          }
          notifyGuildData(ctx, socket, result.guildUid, "guild-set-member-grade-data");
          persistAndInvalidate(ctx, "guild-set-member-grade");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.BAN_REQ,
      name: "GUILD_BAN_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildBanRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? banGuildMember(ctx, actor, request)
          : guildAdminFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(ctx, socket, packet, PACKETS.BAN_ACK, buildGuildBanAckPayload(result), "guild-ban");
        if (result.changed) {
          const targetSocket = findSocketForUser(ctx, socket, result.targetUser);
          if (targetSocket) {
            sendPush(ctx, targetSocket, PACKETS.BAN_NOT, buildGuildBanNotPayload(result), "guild-ban-not");
          }
          notifyGuildData(ctx, socket, result.guildUid, "guild-ban-data", result.targetUser);
          persistAndInvalidate(ctx, "guild-ban");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.MASTER_MIGRATION_REQ,
      name: "GUILD_MASTER_MIGRATION_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildMasterMigrationRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? migrateGuildMaster(ctx, actor, request.guildUid)
          : guildMasterMigrationFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.MASTER_MIGRATION_ACK,
          buildGuildMasterMigrationAckPayload(result),
          "guild-master-migration"
        );
        if (result.changed) {
          cancelScheduledGuildDeletion(ctx, result.guildUid);
          notifyGuildData(ctx, socket, result.guildUid, "guild-master-migration-data");
          persistAndInvalidate(ctx, "guild-master-migration");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.MASTER_SPECIFIED_MIGRATION_REQ,
      name: "GUILD_MASTER_SPECIFIED_MIGRATION_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildMasterSpecifiedMigrationRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? migrateGuildMasterSpecified(ctx, actor, request)
          : guildMasterMigrationFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.MASTER_SPECIFIED_MIGRATION_ACK,
          buildGuildMasterMigrationAckPayload(result),
          "guild-master-specified-migration"
        );
        if (result.changed) {
          notifyGuildMasterSpecifiedMigration(ctx, socket, result);
          notifyGuildData(ctx, socket, result.guildUid, "guild-master-specified-migration-data");
          persistAndInvalidate(ctx, "guild-master-specified-migration");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.UPDATE_DATA_REQ,
      name: "GUILD_UPDATE_DATA_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildUpdateDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? updateGuildData(ctx, actor, request)
          : guildUpdateDataFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.UPDATE_DATA_ACK,
          buildGuildUpdateDataAckPayload(result),
          "guild-update-data"
        );
        if (result.changed) {
          notifyGuildData(ctx, socket, result.guildUid, "guild-update-data-not");
          persistAndInvalidate(ctx, "guild-update-data");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.UPDATE_NOTICE_REQ,
      name: "GUILD_UPDATE_NOTICE_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildTextRequest(ctx, packet && packet.payload, "notice");
        const result = request.valid
          ? updateGuildNotice(ctx, actor, request)
          : guildTextUpdateFailure(ERRORS.INVALID_REQUEST, request, "notice");
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.UPDATE_NOTICE_ACK,
          buildGuildUpdateNoticeAckPayload(result),
          "guild-update-notice"
        );
        if (result.changed) {
          notifyGuildNoticeUpdated(ctx, socket, actor, result);
          notifyGuildData(ctx, socket, result.guildUid, "guild-update-notice-data");
          persistAndInvalidate(ctx, "guild-update-notice");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.UPDATE_MEMBER_GREETING_REQ,
      name: "GUILD_UPDATE_MEMBER_GREETING_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildTextRequest(ctx, packet && packet.payload, "greeting");
        const result = request.valid
          ? updateGuildMemberGreeting(ctx, actor, request)
          : guildTextUpdateFailure(ERRORS.INVALID_REQUEST, request, "greeting");
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.UPDATE_MEMBER_GREETING_ACK,
          buildGuildUpdateMemberGreetingAckPayload(result),
          "guild-update-member-greeting"
        );
        if (result.changed) {
          notifyGuildData(ctx, socket, result.guildUid, "guild-update-member-greeting-data");
          persistAndInvalidate(ctx, "guild-update-member-greeting");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.ATTENDANCE_REQ,
      name: "GUILD_ATTENDANCE_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeAttendanceRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? attendGuild(ctx, user, request)
          : attendanceFailure(ctx, user, ERRORS.INVALID_REQUEST, 0n);
        sendResponse(ctx, socket, packet, PACKETS.ATTENDANCE_ACK, buildAttendanceAckPayload(result), "guild-attendance");
        if (result.changed) {
          if (result.levelUp) notifyGuildLevelUp(ctx, socket, result);
          if (ctx && typeof ctx.trackMissionEvent === "function") {
            ctx.trackMissionEvent(user, "GUILD_ATTENDANCE", 1, { guildUid: String(result.guildUid) });
          }
          persistAndInvalidate(ctx, "guild-attendance");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CHAT_REQ,
      name: "GUILD_CHAT_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildChatRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? sendGuildChat(ctx, actor, request)
          : guildChatFailure(ERRORS.INVALID_REQUEST);
        sendResponse(ctx, socket, packet, PACKETS.CHAT_ACK, buildGuildChatAckPayload(result), "guild-chat");
        if (result.changed) {
          notifyGuildChat(ctx, socket, result.guildUid, result.message);
          persist(ctx);
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CHAT_LIST_REQ,
      name: "GUILD_CHAT_LIST_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? listGuildChat(ctx, actor, request.guildUid)
          : { errorCode: ERRORS.INVALID_REQUEST, guildUid: 0n, messages: [] };
        sendResponse(ctx, socket, packet, PACKETS.CHAT_LIST_ACK, buildGuildChatListAckPayload(ctx, result), "guild-chat-list");
        return true;
      },
    },
    {
      packetId: PACKETS.CHAT_COMPLAIN_REQ,
      name: "GUILD_CHAT_COMPLAIN_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildChatComplainRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? complainGuildChat(ctx, actor, request)
          : guildChatComplaintFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(ctx, socket, packet, PACKETS.CHAT_COMPLAIN_ACK, buildGuildChatComplainAckPayload(result), "guild-chat-complain");
        if (result.changed) {
          if (result.mutedUser) notifyGuildChatMute(ctx, socket, result.mutedUser, result.muteEndDate);
          if (result.mutedUser) persistAndInvalidate(ctx, "guild-chat-complain");
          else persist(ctx);
        }
        return true;
      },
    },
    {
      packetId: PACKETS.CHAT_TRANSLATE_REQ,
      name: "GUILD_CHAT_TRANSLATE_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildChatTranslateRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? translateGuildChat(ctx, actor, request)
          : guildChatTranslateFailure(ERRORS.INVALID_REQUEST, request);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.CHAT_TRANSLATE_ACK,
          buildGuildChatTranslateAckPayload(result),
          "guild-chat-translate"
        );
        return true;
      },
    },
    {
      packetId: PACKETS.RECOMMEND_INVITE_LIST_REQ,
      name: "GUILD_RECOMMEND_INVITE_LIST_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildDataRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? listRecommendedGuildInvites(ctx, actor, request.guildUid)
          : { errorCode: ERRORS.INVALID_REQUEST, list: [] };
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.RECOMMEND_INVITE_LIST_ACK,
          buildGuildRecommendInviteListAckPayload(result),
          "guild-recommend-invite-list"
        );
        return true;
      },
    },
    {
      packetId: PACKETS.DONATION_REQ,
      name: "GUILD_DONATION_REQ",
      handle(ctx, socket, packet) {
        const user = socket && socket.session && socket.session.user;
        const request = decodeDonationRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? donateToGuild(ctx, user, request)
          : donationFailure(ctx, user, ERRORS.INVALID_REQUEST, 0);
        sendResponse(ctx, socket, packet, PACKETS.DONATION_ACK, buildDonationAckPayload(result), "guild-donation");
        if (result.changed) {
          if (result.levelUp) notifyGuildLevelUp(ctx, socket, result);
          trackDonationMissions(ctx, user, result);
          persistAndInvalidate(ctx, "guild-donation");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.BUY_REQ,
      name: "GUILD_BUY_BUFF_REQ",
      handle(ctx, socket, packet) {
        const request = decodeBuyRequest(ctx, packet && packet.payload);
        const user = socket && socket.session && socket.session.user;
        const result = request.valid
          ? purchaseCompanyBuff(ctx, user, request)
          : failure(ERRORS.INVALID_REQUEST, 0n, 0, 0n);

        sendResponse(ctx, socket, packet, PACKETS.BUY_ACK, buildBuyAckPayload(result), "guild-buy-buff");
        if (!result.changed) return true;

        for (const target of result.notifyTargets) {
          const targetSocket = String(target.userUid || "") === String(user && user.userUid || "")
            ? socket
            : ctx && typeof ctx.findClientSocketByUserUid === "function"
              ? ctx.findClientSocketByUserUid(target.userUid)
              : null;
          if (targetSocket) sendPush(ctx, targetSocket, PACKETS.ADD_NOT, buildCompanyBuffAddNotPayload(result.buff), "company-buff-add");
        }
        trackResourceSpend(ctx, user, result.resourceSpend);
        persistAndInvalidate(ctx, "company-buff-purchase");
        return true;
      },
    },
    {
      packetId: PACKETS.WELFARE_POINT_REQ,
      name: "GUILD_BUY_WELFARE_POINT_REQ",
      handle(ctx, socket, packet) {
        const request = decodeWelfarePointRequest(ctx, packet && packet.payload);
        const user = socket && socket.session && socket.session.user;
        const result = request.valid
          ? purchaseWelfarePoints(ctx, user, request)
          : welfarePointFailure(ERRORS.INVALID_REQUEST, 0n);
        sendResponse(
          ctx,
          socket,
          packet,
          PACKETS.WELFARE_POINT_ACK,
          buildWelfarePointAckPayload(result),
          "guild-buy-welfare-point"
        );
        if (result.changed) {
          trackResourceSpend(ctx, user, result.resourceSpend);
          persistAndInvalidate(ctx, "guild-welfare-point-purchase");
        }
        return true;
      },
    },
    {
      packetId: PACKETS.RENAME_REQ,
      name: "GUILD_RENAME_REQ",
      handle(ctx, socket, packet) {
        const actor = socket && socket.session && socket.session.user;
        const request = decodeGuildRenameRequest(ctx, packet && packet.payload);
        const result = request.valid
          ? renameGuild(ctx, actor, request.newName)
          : guildRenameFailure(ERRORS.INVALID_REQUEST, "", "");
        sendResponse(ctx, socket, packet, PACKETS.RENAME_ACK, buildGuildRenameAckPayload(result), "guild-rename");
        if (result.changed) {
          notifyGuildRename(ctx, socket, result);
          notifyGuildData(ctx, socket, result.guildUid, "guild-rename-data");
          persistAndInvalidate(ctx, "guild-rename");
        }
        return true;
      },
    },
  ];
}

function decodeGuildCreateRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    let field = readString(payload, 0);
    const guildName = field.value;
    if (!writeString(guildName).equals(payload.subarray(0, field.offset))) return invalidGuildCreateRequest();
    const joinTypeOffset = field.offset;
    field = readSignedVarInt(payload, joinTypeOffset);
    const guildJoinType = field.value;
    if (!writeSignedVarInt(guildJoinType).equals(payload.subarray(joinTypeOffset, field.offset))) return invalidGuildCreateRequest();
    const badgeOffset = field.offset;
    field = readSignedVarLong(payload, badgeOffset);
    const badgeId = field.value;
    if (!writeSignedVarLong(badgeId).equals(payload.subarray(badgeOffset, field.offset))) return invalidGuildCreateRequest();
    const greetingOffset = field.offset;
    field = readString(payload, greetingOffset);
    const greeting = field.value;
    if (!writeString(greeting).equals(payload.subarray(greetingOffset, field.offset))) return invalidGuildCreateRequest();
    if (field.offset !== payload.length || guildJoinType < 0 || guildJoinType > 2) return invalidGuildCreateRequest();
    return { valid: true, guildName, guildJoinType, badgeId, greeting };
  } catch (_) {
    return invalidGuildCreateRequest();
  }
}

function invalidGuildCreateRequest() {
  return { valid: false, guildName: "", guildJoinType: 0, badgeId: 0n, greeting: "" };
}

function decodeGuildSearchRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const keyword = readString(payload, 0);
    if (!writeString(keyword.value).equals(payload.subarray(0, keyword.offset))) return invalidGuildSearchRequest();
    if (keyword.offset !== payload.length) return invalidGuildSearchRequest();
    return { valid: true, keyword: keyword.value };
  } catch (_) {
    return invalidGuildSearchRequest();
  }
}

function invalidGuildSearchRequest() {
  return { valid: false, keyword: "" };
}

function decodeGuildListRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildListType = readSignedVarInt(payload, 0);
    if (!writeSignedVarInt(guildListType.value).equals(payload.subarray(0, guildListType.offset))) return invalidGuildListRequest();
    if (guildListType.offset !== payload.length || guildListType.value < 0 || guildListType.value > 1) return invalidGuildListRequest();
    return { valid: true, guildListType: guildListType.value };
  } catch (_) {
    return invalidGuildListRequest();
  }
}

function invalidGuildListRequest() {
  return { valid: false, guildListType: 0 };
}

function decodeGuildJoinRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readSignedVarLong(payload, 0);
    if (!writeSignedVarLong(guildUid.value).equals(payload.subarray(0, guildUid.offset))) return invalidGuildJoinRequest();
    const guildJoinType = readSignedVarInt(payload, guildUid.offset);
    if (!writeSignedVarInt(guildJoinType.value).equals(payload.subarray(guildUid.offset, guildJoinType.offset))) return invalidGuildJoinRequest();
    if (guildJoinType.offset !== payload.length || guildJoinType.value < 0 || guildJoinType.value > 2) return invalidGuildJoinRequest();
    return { valid: true, guildUid: guildUid.value, guildJoinType: guildJoinType.value };
  } catch (_) {
    return invalidGuildJoinRequest();
  }
}

function invalidGuildJoinRequest() {
  return { valid: false, guildUid: 0n, guildJoinType: 0 };
}

function decodeGuildAcceptJoinRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const joinUserUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    const isAllow = readCanonicalBool(payload, joinUserUid.offset);
    if (isAllow.offset !== payload.length) return invalidMembershipRequest();
    return { valid: true, guildUid: guildUid.value, userUid: joinUserUid.value, isAllow: isAllow.value };
  } catch (_) {
    return invalidMembershipRequest();
  }
}

function decodeGuildInviteRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const userUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    if (userUid.offset !== payload.length) return invalidMembershipRequest();
    return { valid: true, guildUid: guildUid.value, userUid: userUid.value, isAllow: false };
  } catch (_) {
    return invalidMembershipRequest();
  }
}

function decodeGuildAcceptInviteRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const isAllow = readCanonicalBool(payload, guildUid.offset);
    if (isAllow.offset !== payload.length) return invalidMembershipRequest();
    return { valid: true, guildUid: guildUid.value, userUid: 0n, isAllow: isAllow.value };
  } catch (_) {
    return invalidMembershipRequest();
  }
}

function decodeGuildSetMemberGradeRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const targetUserUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    const grade = readCanonicalSignedVarInt(payload, targetUserUid.offset);
    if (grade.offset !== payload.length) return invalidGuildAdminRequest();
    return { valid: true, guildUid: guildUid.value, userUid: targetUserUid.value, grade: grade.value, banReason: 0 };
  } catch (_) {
    return invalidGuildAdminRequest();
  }
}

function decodeGuildBanRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const targetUserUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    const banReason = readCanonicalSignedVarInt(payload, targetUserUid.offset);
    if (banReason.offset !== payload.length) return invalidGuildAdminRequest();
    return { valid: true, guildUid: guildUid.value, userUid: targetUserUid.value, grade: 0, banReason: banReason.value };
  } catch (_) {
    return invalidGuildAdminRequest();
  }
}

function decodeGuildMasterMigrationRequest(ctx, encryptedPayload) {
  const request = decodeGuildDataRequest(ctx, encryptedPayload);
  return request.valid
    ? { valid: true, guildUid: request.guildUid, targetUserUid: 0n }
    : { valid: false, guildUid: 0n, targetUserUid: 0n };
}

function decodeGuildMasterSpecifiedMigrationRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const targetUserUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    if (targetUserUid.offset !== payload.length) return invalidGuildMasterSpecifiedMigrationRequest();
    return { valid: true, guildUid: guildUid.value, targetUserUid: targetUserUid.value };
  } catch (_) {
    return invalidGuildMasterSpecifiedMigrationRequest();
  }
}

function invalidGuildMasterSpecifiedMigrationRequest() {
  return { valid: false, guildUid: 0n, targetUserUid: 0n };
}

function decodeGuildUpdateDataRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    let field = readString(payload, guildUid.offset);
    const greeting = field.value;
    if (!writeString(greeting).equals(payload.subarray(guildUid.offset, field.offset))) return invalidGuildUpdateDataRequest();
    const joinTypeOffset = field.offset;
    field = readCanonicalSignedVarInt(payload, joinTypeOffset);
    const guildJoinType = field.value;
    const badgeId = readCanonicalSignedVarLong(payload, field.offset);
    field = readCanonicalSignedVarInt(payload, badgeId.offset);
    const chatNoticeType = field.value;
    if (field.offset !== payload.length || guildJoinType < 0 || guildJoinType > 2 || chatNoticeType < 0 || chatNoticeType > 1) {
      return invalidGuildUpdateDataRequest();
    }
    return { valid: true, guildUid: guildUid.value, greeting, guildJoinType, badgeId: badgeId.value, chatNoticeType };
  } catch (_) {
    return invalidGuildUpdateDataRequest();
  }
}

function invalidGuildUpdateDataRequest() {
  return { valid: false, guildUid: 0n, greeting: "", guildJoinType: 0, badgeId: 0n, chatNoticeType: 0 };
}

function decodeGuildTextRequest(ctx, encryptedPayload, fieldName) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const field = readString(payload, guildUid.offset);
    if (!writeString(field.value).equals(payload.subarray(guildUid.offset, field.offset)) || field.offset !== payload.length) {
      return invalidGuildTextRequest(fieldName);
    }
    return { valid: true, guildUid: guildUid.value, [fieldName]: field.value };
  } catch (_) {
    return invalidGuildTextRequest(fieldName);
  }
}

function invalidGuildTextRequest(fieldName) {
  return { valid: false, guildUid: 0n, [fieldName]: "" };
}

function decodeGuildRenameRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const field = readString(payload, 0);
    if (!writeString(field.value).equals(payload.subarray(0, field.offset)) || field.offset !== payload.length) {
      return { valid: false, newName: "" };
    }
    return { valid: true, newName: field.value };
  } catch (_) {
    return { valid: false, newName: "" };
  }
}

function decodeGuildChatRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const messageType = readCanonicalSignedVarInt(payload, guildUid.offset);
    const emotionId = readCanonicalSignedVarInt(payload, messageType.offset);
    const message = readString(payload, emotionId.offset);
    if (!writeString(message.value).equals(payload.subarray(emotionId.offset, message.offset)) || message.offset !== payload.length) {
      return invalidGuildChatRequest();
    }
    if (messageType.value < 0 || messageType.value > 10 || emotionId.value < 0) return invalidGuildChatRequest();
    return {
      valid: true,
      guildUid: guildUid.value,
      messageType: messageType.value,
      emotionId: emotionId.value,
      message: message.value,
    };
  } catch (_) {
    return invalidGuildChatRequest();
  }
}

function invalidGuildChatRequest() {
  return { valid: false, guildUid: 0n, messageType: 0, emotionId: 0, message: "" };
}

function decodeGuildChatComplainRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const messageUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    if (messageUid.offset !== payload.length) return invalidGuildChatComplaintRequest();
    return { valid: true, guildUid: guildUid.value, messageUid: messageUid.value };
  } catch (_) {
    return invalidGuildChatComplaintRequest();
  }
}

function invalidGuildChatComplaintRequest() {
  return { valid: false, guildUid: 0n, messageUid: 0n };
}

function decodeGuildChatTranslateRequest(ctx, encryptedPayload) {
  try {
    const payload = decryptPayload(ctx, encryptedPayload);
    const guildUid = readCanonicalSignedVarLong(payload, 0);
    const messageUid = readCanonicalSignedVarLong(payload, guildUid.offset);
    const targetLanguage = readString(payload, messageUid.offset);
    if (!writeString(targetLanguage.value).equals(payload.subarray(messageUid.offset, targetLanguage.offset))) {
      return invalidGuildChatTranslateRequest();
    }
    if (targetLanguage.offset !== payload.length || targetLanguage.value.length < 2 || targetLanguage.value.length > 16) {
      return invalidGuildChatTranslateRequest();
    }
    return {
      valid: true,
      guildUid: guildUid.value,
      messageUid: messageUid.value,
      targetLanguage: targetLanguage.value,
    };
  } catch (_) {
    return invalidGuildChatTranslateRequest();
  }
}

function invalidGuildChatTranslateRequest() {
  return { valid: false, guildUid: 0n, messageUid: 0n, targetLanguage: "" };
}

function readCanonicalSignedVarLong(payload, offset) {
  const value = readSignedVarLong(payload, offset);
  if (!writeSignedVarLong(value.value).equals(payload.subarray(offset, value.offset))) {
    throw new Error("noncanonical signed varlong");
  }
  return value;
}

function readCanonicalSignedVarInt(payload, offset) {
  const value = readSignedVarInt(payload, offset);
  if (!writeSignedVarInt(value.value).equals(payload.subarray(offset, value.offset))) {
    throw new Error("noncanonical signed varint");
  }
  return value;
}

function readCanonicalBool(payload, offset) {
  if (offset >= payload.length || payload.readUInt8(offset) > 1) throw new Error("noncanonical bool");
  return readBool(payload, offset);
}

function invalidMembershipRequest() {
  return { valid: false, guildUid: 0n, userUid: 0n, isAllow: false };
}

function invalidGuildAdminRequest() {
  return { valid: false, guildUid: 0n, userUid: 0n, grade: 0, banReason: 0 };
}

function decryptPayload(ctx, encryptedPayload) {
  return ctx && typeof ctx.decryptCopy === "function"
    ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
    : Buffer.from(encryptedPayload || Buffer.alloc(0));
}

function createGuild(ctx, user, request) {
  const tables = loadTables();
  if (!user) return guildLifecycleFailure(ERRORS.INVALID_REQUEST);
  if (getGuildUid(user) > 0n) return guildLifecycleFailure(ERRORS.ALREADY_JOINED);
  if (getUserLevel(user) < tables.guildConfig.creationUserMinLevel) {
    return guildLifecycleFailure(ERRORS.CREATION_USER_LEVEL);
  }
  if (!isValidGuildName(request.guildName, tables)) {
    return guildLifecycleFailure(ERRORS.CREATION_INVALID_NAME);
  }
  if (!isValidGuildGreeting(request.greeting)) return guildLifecycleFailure(ERRORS.INVALID_REQUEST);
  if (!isValidGuildBadge(request.badgeId, tables)) return guildLifecycleFailure(ERRORS.CREATION_INVALID_UID);
  if (getGuildDirectory(ctx).some((guild) => guild.name.toUpperCase() === request.guildName.toUpperCase())) {
    return guildLifecycleFailure(ERRORS.CREATION_DUPLICATED_NAME);
  }
  if (tables.guildConfig.creationCosts.some((cost) => getMiscBalance(user, cost.itemId) < BigInt(cost.count))) {
    return guildLifecycleFailure(ERRORS.INSUFFICIENT_RESOURCE);
  }

  const guildUid = allocateGuildUid(ctx);
  const costItems = tables.guildConfig.creationCosts.map((cost) => spendMiscItem(user, cost.itemId, cost.count));
  const guild = {
    guildUid,
    name: request.guildName,
    badgeId: request.badgeId,
    guildLevel: 1,
    guildLevelExp: 0n,
    unionPoint: 0n,
    guildJoinType: request.guildJoinType,
    guildState: 1,
    closingTime: 0n,
    greeting: request.greeting,
    notice: "",
    dungeonNotice: "",
    chatNoticeType: 0,
    renameCount: 0,
    latestRenameDate: 0n,
  };
  setGuildMembership(ctx, user, guild);
  user.guildMemberGrade = 0;
  setGuildMetadata(user, guild);
  const guildData = getGuildData(ctx, guildUid);
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid,
    guildData,
    costItems,
    resourceSpend: tables.guildConfig.creationCosts[0] || null,
  };
}

function closeGuild(ctx, user, guildUid) {
  const state = validateGuildMaster(ctx, user, guildUid);
  if (state.errorCode !== ERRORS.OK) return guildLifecycleFailure(state.errorCode, guildUid);
  if (state.guild.guildState !== 1) return guildLifecycleFailure(ERRORS.CLOSE_INVALID_STATE, guildUid);
  const closingDate = new Date(currentServerDate(ctx).getTime() + loadTables().guildConfig.closingDelayHours * 60 * 60 * 1000);
  const closingTime = dateTimeBinaryForDateLocal(closingDate);
  for (const member of state.guild.members) {
    member.guildState = 2;
    member.guildClosingTime = String(closingTime);
    if (member.guild && typeof member.guild === "object") {
      member.guild.state = 2;
      member.guild.closingTime = String(closingTime);
    }
  }
  return { changed: true, errorCode: ERRORS.OK, guildUid: toBigInt(guildUid), closingTime };
}

function cancelGuildClosure(ctx, user, guildUid) {
  const state = validateGuildMaster(ctx, user, guildUid);
  if (state.errorCode !== ERRORS.OK) return guildLifecycleFailure(state.errorCode, guildUid);
  if (state.guild.guildState !== 2 || state.guild.closingTime <= 0n) {
    return guildLifecycleFailure(ERRORS.CLOSE_INVALID_STATE, guildUid);
  }
  if (isGuildClosureDue(ctx, state.guild.closingTime)) {
    deleteClosedGuild(ctx, guildUid, null, true);
    return guildLifecycleFailure(ERRORS.CLOSE_INVALID_STATE, guildUid);
  }
  for (const member of state.guild.members) {
    member.guildState = 1;
    member.guildClosingTime = "0";
    if (member.guild && typeof member.guild === "object") {
      member.guild.state = 1;
      member.guild.closingTime = "0";
    }
  }
  return { changed: true, errorCode: ERRORS.OK, guildUid: toBigInt(guildUid), closingTime: 0n };
}

function validateGuildMaster(ctx, user, guildUid) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  if (normalizedGuildUid <= 0n) return { errorCode: ERRORS.INVALID_GUILD_UID, guild: null };
  if (!user || getGuildUid(user) <= 0n) return { errorCode: ERRORS.NOT_A_MEMBER, guild: null };
  if (getGuildUid(user) !== normalizedGuildUid) return { errorCode: ERRORS.INVALID_GUILD_UID, guild: null };
  const guild = getGuildData(ctx, normalizedGuildUid);
  if (!guild) return { errorCode: ERRORS.INVALID_GUILD_UID, guild: null };
  if (getGuildGrade(user) !== 0) return { errorCode: ERRORS.NOT_MASTER, guild };
  return { errorCode: ERRORS.OK, guild };
}

function guildLifecycleFailure(errorCode, guildUid = 0n) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(guildUid || 0),
    closingTime: 0n,
    guildData: null,
    costItems: [],
    resourceSpend: null,
  };
}

function setGuildMetadata(user, guild) {
  user.guildName = guild.name;
  user.guildBadgeId = String(guild.badgeId);
  user.guildJoinType = guild.guildJoinType;
  user.guildState = guild.guildState;
  user.guildClosingTime = String(guild.closingTime || 0);
  user.guildGreeting = guild.greeting;
  user.guildNotice = guild.notice;
  user.guildDungeonNotice = guild.dungeonNotice;
  user.guildChatNoticeType = guild.chatNoticeType;
  user.guildRenameCount = guild.renameCount;
  user.guildLatestRenameDate = String(guild.latestRenameDate || 0);
}

function allocateGuildUid(ctx) {
  const userDb = ctx && ctx.userDb && typeof ctx.userDb === "object" ? ctx.userDb : {};
  let next = toBigInt(userDb.nextGuildUid || 1);
  if (next <= 0n) next = 1n;
  for (const user of Object.values(userDb.users || {})) {
    const guildUid = getGuildUid(user);
    if (guildUid >= next) next = guildUid + 1n;
  }
  userDb.nextGuildUid = String(next + 1n);
  return next;
}

function getUserLevel(user) {
  const raw = user && (user.level != null ? user.level : user.userLevel != null ? user.userLevel : user.m_UserLevel);
  const level = Number(raw == null ? 1 : raw);
  return Number.isFinite(level) ? Math.max(0, Math.trunc(level)) : 0;
}

function isValidGuildName(value, tables = loadTables()) {
  if (typeof value !== "string") return false;
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    length += code <= 0xff ? 1 : 2;
    if (!isValidGlobalGuildNameCode(code)) return false;
  }
  if (length < 2 || length > 16) return false;
  const upper = value.toUpperCase();
  return !tables.guildNameFilterWords.some((word) => upper.includes(word));
}

function isValidGlobalGuildNameCode(code) {
  return (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x4e00 && code <= 0x9fa5)
    || (code >= 0xac00 && code <= 0xd7a3);
}

function isValidGuildGreeting(value) {
  if (typeof value !== "string" || value.length > 40) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0xd800 && code <= 0xdfff) || code < 0x20 && code !== 0x09) return false;
  }
  return true;
}

function isValidGuildBadge(value, tables = loadTables()) {
  const badgeId = toBigInt(value || 0);
  if (badgeId <= 0n) return false;
  const text = String(badgeId);
  if (text.length <= 9 || text.length > 12) return false;
  const ids = [
    Number(text.slice(0, -9)),
    Number(text.slice(-9, -6)),
    Number(text.slice(-6, -3)),
    Number(text.slice(-3)),
  ];
  return tables.guildBadgeFrameIds.has(ids[0])
    && tables.guildBadgeColorIds.has(ids[1])
    && tables.guildBadgeMarkIds.has(ids[2])
    && tables.guildBadgeColorIds.has(ids[3]);
}

function searchGuilds(ctx, user, keyword) {
  const needle = String(keyword || "").trim().toLocaleLowerCase();
  const ownGuildUid = getGuildUid(user);
  return getGuildDirectory(ctx)
    .filter((guild) => guild.guildUid !== ownGuildUid && guild.guildJoinType !== 2)
    .filter((guild) => !needle || guild.name.toLocaleLowerCase().includes(needle));
}

function listRelatedGuilds(ctx, user, guildListType) {
  const guilds = new Map(getGuildDirectory(ctx).map((guild) => [String(guild.guildUid), guild]));
  return getRelatedGuildUids(user, guildListType)
    .map((guildUid) => guilds.get(String(guildUid)))
    .filter(Boolean);
}

function listRecommendedGuildInvites(ctx, actor, guildUid) {
  const state = validateGuildActor(ctx, actor, guildUid, ERRORS.NOT_ENOUGH_GRADE);
  if (state.errorCode !== ERRORS.OK) return { errorCode: state.errorCode, list: [] };
  const normalizedGuildUid = toBigInt(guildUid || 0);
  const nowBinary = binaryNow(ctx);
  const list = Object.values(ctx && ctx.userDb && ctx.userDb.users || {})
    .filter((user) => user && getUserUid(user) > 0n && getGuildUid(user) <= 0n)
    .filter((user) => getGuildJoinDisableTime(user) <= nowBinary)
    .filter((user) => !getRelatedGuildUids(user, 0).some((value) => value === normalizedGuildUid))
    .filter((user) => !getRelatedGuildUids(user, 1).some((value) => value === normalizedGuildUid))
    .sort((left, right) => {
      const leftLogin = firstStoredDateTime(left, guildObjects(left), ["lastLoginDateBinary", "lastLoginDate", "lastJoinDate", "lastLoginAt", "lastJoinAt", "createdAt"]);
      const rightLogin = firstStoredDateTime(right, guildObjects(right), ["lastLoginDateBinary", "lastLoginDate", "lastJoinDate", "lastLoginAt", "lastJoinAt", "createdAt"]);
      return compareBigInts(rightLogin, leftLogin) || compareBigInts(getUserUid(left), getUserUid(right));
    });
  return { errorCode: ERRORS.OK, list };
}

function sendGuildChat(ctx, actor, request) {
  const guildUid = toBigInt(request && request.guildUid || 0);
  if (guildUid <= 0n) return guildChatFailure(ERRORS.INVALID_GUILD_UID, guildUid);
  if (!actor || getGuildUid(actor) <= 0n) return guildChatFailure(ERRORS.NOT_A_MEMBER, guildUid);
  if (getGuildUid(actor) !== guildUid || !getGuildData(ctx, guildUid)) {
    return guildChatFailure(ERRORS.INVALID_GUILD_UID, guildUid);
  }
  if (getGuildChatMuteEndDate(actor) > binaryNow(ctx)) return guildChatFailure(ERRORS.GUILD_CHAT_BLOCK_MUTE, guildUid);
  if (request.messageType !== 0) return guildChatFailure(ERRORS.INVALID_REQUEST, guildUid);
  if (request.emotionId > 0) {
    if (request.message !== "" || !ownsGuildChatEmoticon(actor, request.emotionId)) {
      return guildChatFailure(ERRORS.EMOTICON_NOT_OWNED, guildUid);
    }
  } else if (!isValidGuildChatMessage(request.message)) {
    return guildChatFailure(ERRORS.INVALID_REQUEST, guildUid);
  }

  const message = {
    messageUid: String(allocateGuildChatMessageUid(ctx)),
    messageType: 0,
    author: snapshotChatAuthor(actor),
    emotionId: request.emotionId,
    message: request.message,
    createdAt: String(binaryNow(ctx)),
    typeParam: "0",
    blocked: false,
  };
  const messages = ensureGuildChatMessages(ctx, guildUid);
  messages.push(message);
  if (messages.length > 100) messages.splice(0, messages.length - 100);
  return { changed: true, errorCode: ERRORS.OK, guildUid, messageUid: toBigInt(message.messageUid), message };
}

function guildChatFailure(errorCode, guildUid = 0n) {
  return { changed: false, errorCode, guildUid: toBigInt(guildUid || 0), messageUid: 0n, message: null };
}

function listGuildChat(ctx, actor, guildUid) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  if (normalizedGuildUid <= 0n) return { errorCode: ERRORS.INVALID_GUILD_UID, guildUid: normalizedGuildUid, messages: [] };
  if (!actor || getGuildUid(actor) <= 0n) return { errorCode: ERRORS.NOT_A_MEMBER, guildUid: normalizedGuildUid, messages: [] };
  if (getGuildUid(actor) !== normalizedGuildUid || !getGuildData(ctx, normalizedGuildUid)) {
    return { errorCode: ERRORS.INVALID_GUILD_UID, guildUid: normalizedGuildUid, messages: [] };
  }
  return { errorCode: ERRORS.OK, guildUid: normalizedGuildUid, messages: getGuildChatMessages(ctx, normalizedGuildUid).slice(-100) };
}

function complainGuildChat(ctx, actor, request) {
  const guildUid = toBigInt(request && request.guildUid || 0);
  if (guildUid <= 0n) return guildChatComplaintFailure(ERRORS.INVALID_GUILD_UID, request);
  if (!actor || getGuildUid(actor) <= 0n) return guildChatComplaintFailure(ERRORS.NOT_A_MEMBER, request);
  if (getGuildUid(actor) !== guildUid || !getGuildData(ctx, guildUid)) {
    return guildChatComplaintFailure(ERRORS.INVALID_GUILD_UID, request);
  }
  const message = getGuildChatMessages(ctx, guildUid).find((entry) => toBigInt(entry && entry.messageUid || 0) === request.messageUid);
  if (!message) return guildChatComplaintFailure(ERRORS.CHAT_MESSAGE_UID_NOT_FOUND, request);
  const targetUserUid = toBigInt(message.author && message.author.userUid || 0);
  if (message.messageType !== 0 || message.emotionId > 0 || targetUserUid <= 0n || targetUserUid === getUserUid(actor)) {
    return guildChatComplaintFailure(ERRORS.CHAT_COMPLAIN_INVALID_TYPE, request);
  }
  const targetUser = findUserByUid(ctx, targetUserUid);
  if (!targetUser) return guildChatComplaintFailure(ERRORS.CHAT_MESSAGE_UID_NOT_FOUND, request);
  if (getGuildChatMuteEndDate(targetUser) > binaryNow(ctx)) {
    return guildChatComplaintFailure(ERRORS.CHAT_COMPLAIN_ALREADY_BLOCKED, request);
  }

  const existing = getGuildChatComplaintRecords(ctx);
  const record = existing[String(request.messageUid)];
  const reporterUid = String(getUserUid(actor));
  if (record && Array.isArray(record.reporterUids) && record.reporterUids.includes(reporterUid)) {
    return guildChatComplaintFailure(ERRORS.CHAT_COMPLAIN_DUPLICATED, request);
  }
  const records = ensureGuildChatComplaintRecords(ctx);
  const nextRecord = records[String(request.messageUid)] || {
    guildUid: String(guildUid),
    messageUid: String(request.messageUid),
    targetUserUid: String(targetUserUid),
    reporterUids: [],
  };
  nextRecord.reporterUids.push(reporterUid);
  records[String(request.messageUid)] = nextRecord;

  const complaintCount = Object.values(records)
    .filter((entry) => String(entry && entry.targetUserUid || "") === String(targetUserUid))
    .reduce((count, entry) => count + new Set(Array.isArray(entry.reporterUids) ? entry.reporterUids.map(String) : []).size, 0);
  let muteEndDate = 0n;
  if (complaintCount >= loadTables().guildChatConfig.complainCountToBlock) {
    muteEndDate = dateTimeBinaryForDateLocal(new Date(
      currentServerDate(ctx).getTime() + loadTables().guildChatConfig.autoBlockHours * 60 * 60 * 1000
    ));
    targetUser.guildChatMuteEndDate = String(muteEndDate);
    if (targetUser.guild && typeof targetUser.guild === "object") targetUser.guild.chatMuteEndDate = String(muteEndDate);
  }
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid,
    messageUid: request.messageUid,
    mutedUser: muteEndDate > 0n ? targetUser : null,
    muteEndDate,
  };
}

function guildChatComplaintFailure(errorCode, request) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(request && request.guildUid || 0),
    messageUid: toBigInt(request && request.messageUid || 0),
    mutedUser: null,
    muteEndDate: 0n,
  };
}

function translateGuildChat(ctx, actor, request) {
  const guildUid = toBigInt(request && request.guildUid || 0);
  const messageUid = toBigInt(request && request.messageUid || 0);
  if (guildUid <= 0n || messageUid <= 0n) return guildChatTranslateFailure(ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_FOUND, request);
  if (!actor || getGuildUid(actor) <= 0n) return guildChatTranslateFailure(ERRORS.NOT_A_MEMBER, request);
  if (getGuildUid(actor) !== guildUid || !getGuildData(ctx, guildUid)) {
    return guildChatTranslateFailure(ERRORS.INVALID_GUILD_UID, request);
  }
  const message = getGuildChatMessages(ctx, guildUid)
    .find((entry) => toBigInt(entry && entry.messageUid || 0) === messageUid);
  if (!message || message.emotionId > 0 || !message.message) {
    return guildChatTranslateFailure(ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_FOUND, request);
  }
  return guildChatTranslateFailure(ERRORS.GUILD_TRANSLATE_MESSAGE_NOT_INITIALIZED, request);
}

function guildChatTranslateFailure(errorCode, request) {
  return {
    errorCode,
    messageUid: toBigInt(request && request.messageUid || 0),
    textTranslated: "",
  };
}

function getGuildChatMessages(ctx, guildUid) {
  const store = ctx && ctx.userDb && ctx.userDb.guildChats;
  const messages = store && store[String(toBigInt(guildUid || 0))];
  return Array.isArray(messages) ? messages : [];
}

function ensureGuildChatMessages(ctx, guildUid) {
  if (!ctx.userDb.guildChats || typeof ctx.userDb.guildChats !== "object" || Array.isArray(ctx.userDb.guildChats)) {
    ctx.userDb.guildChats = {};
  }
  const key = String(toBigInt(guildUid || 0));
  if (!Array.isArray(ctx.userDb.guildChats[key])) ctx.userDb.guildChats[key] = [];
  return ctx.userDb.guildChats[key];
}

function getGuildChatComplaintRecords(ctx) {
  const records = ctx && ctx.userDb && ctx.userDb.guildChatComplaints;
  return records && typeof records === "object" && !Array.isArray(records) ? records : {};
}

function ensureGuildChatComplaintRecords(ctx) {
  if (!ctx.userDb.guildChatComplaints || typeof ctx.userDb.guildChatComplaints !== "object" || Array.isArray(ctx.userDb.guildChatComplaints)) {
    ctx.userDb.guildChatComplaints = {};
  }
  return ctx.userDb.guildChatComplaints;
}

function allocateGuildChatMessageUid(ctx) {
  let next = toBigInt(ctx && ctx.userDb && ctx.userDb.nextGuildChatMessageUid || 1);
  if (next <= 0n) next = 1n;
  for (const messages of Object.values(ctx && ctx.userDb && ctx.userDb.guildChats || {})) {
    for (const message of Array.isArray(messages) ? messages : []) {
      const uid = toBigInt(message && message.messageUid || 0);
      if (uid >= next) next = uid + 1n;
    }
  }
  ctx.userDb.nextGuildChatMessageUid = String(next + 1n);
  return next;
}

function snapshotChatAuthor(user) {
  return {
    userUid: String(getUserUid(user)),
    friendCode: String(toBigInt(user && user.friendCode || 0)),
    nickname: String(user && user.nickname || ""),
    level: Math.max(1, Number(user && user.level || 1)),
    mainUnitId: Number(user && user.mainUnitId || 0),
    mainUnitSkinId: Number(user && user.mainUnitSkinId || 0),
    frameId: Number(user && (user.frameId || user.selfiFrameId) || 0),
    mainUnitTacticLevel: Number(user && user.mainUnitTacticLevel || 0),
    titleId: Number(user && user.titleId || 0),
  };
}

function ownsGuildChatEmoticon(user, emotionId) {
  if (!getEmoticonTemplet(emotionId)) return false;
  const inventory = user && user.inventory && Array.isArray(user.inventory.emoticons) ? user.inventory.emoticons : [];
  const collection = user && user.community && user.community.emoticons && Array.isArray(user.community.emoticons.collections)
    ? user.community.emoticons.collections
    : [];
  return [...inventory, ...collection].some((value) => Number(value) === Number(emotionId));
}

function isValidGuildChatMessage(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 70 && isGuildTextSafe(value, false);
}

function getGuildChatMuteEndDate(user) {
  return firstStoredDateTime(user, guildObjects(user), ["guildChatMuteEndDate", "chatMuteEndDate", "blockMuteEndDate"]);
}

function getGuildDirectory(ctx) {
  const guildUids = new Set();
  for (const user of Object.values(ctx && ctx.userDb && ctx.userDb.users || {})) {
    const guildUid = getGuildUid(user);
    if (guildUid > 0n) guildUids.add(String(guildUid));
  }
  return [...guildUids]
    .map((guildUid) => getGuildData(ctx, BigInt(guildUid)))
    .filter(Boolean)
    .sort((left, right) => right.guildLevel - left.guildLevel
      || left.name.localeCompare(right.name)
      || compareBigInts(left.guildUid, right.guildUid));
}

function getRelatedGuildUids(user, guildListType) {
  const nested = guildObjects(user);
  const fields = guildListType === 0
    ? ["guildJoinRequestUids", "guildJoinRequests", "joinRequestUids", "joinRequests"]
    : ["guildInviteUids", "guildInvites", "inviteUids", "invites"];
  const source = firstStoredValue(user, nested, fields);
  const values = Array.isArray(source) ? source : [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const guildUid = toBigInt(value && typeof value === "object" ? value.guildUid : value || 0);
    const key = String(guildUid);
    if (guildUid <= 0n || seen.has(key)) continue;
    seen.add(key);
    result.push(guildUid);
  }
  return result;
}

function setRelatedGuildUids(user, guildListType, values) {
  if (!user || typeof user !== "object") return;
  const normalized = [];
  const seen = new Set();
  for (const value of values || []) {
    const guildUid = toBigInt(value && typeof value === "object" ? value.guildUid : value || 0);
    const key = String(guildUid);
    if (guildUid <= 0n || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  if (guildListType === 0) user.guildJoinRequests = normalized;
  else user.guildInvites = normalized;
}

function getGuildRelationshipUsers(ctx, guildUid, guildListType) {
  return Object.values(ctx && ctx.userDb && ctx.userDb.users || {})
    .filter((user) => getGuildUid(user) !== guildUid && getRelatedGuildUids(user, guildListType).some((value) => value === guildUid))
    .sort((left, right) => compareBigInts(getUserUid(left), getUserUid(right)));
}

function findUserByUid(ctx, userUid) {
  const normalized = toBigInt(userUid || 0);
  if (normalized <= 0n) return null;
  const users = ctx && ctx.userDb && ctx.userDb.users || {};
  const direct = users[String(normalized)];
  if (direct && getUserUid(direct) === normalized) return direct;
  return Object.values(users).find((user) => getUserUid(user) === normalized) || null;
}

function validateGuildActor(ctx, actor, guildUid, permissionError) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  if (normalizedGuildUid <= 0n) return { errorCode: ERRORS.INVALID_GUILD_UID, guild: null };
  if (!actor || getGuildUid(actor) <= 0n) return { errorCode: ERRORS.NOT_A_MEMBER, guild: null };
  if (getGuildUid(actor) !== normalizedGuildUid) return { errorCode: ERRORS.INVALID_GUILD_UID, guild: null };
  const guild = getGuildData(ctx, normalizedGuildUid);
  if (!guild) return { errorCode: ERRORS.INVALID_GUILD_UID, guild: null };
  if (getGuildGrade(actor) > 1) return { errorCode: permissionError, guild };
  return { errorCode: ERRORS.OK, guild };
}

function acceptGuildJoin(ctx, actor, request) {
  const actorState = validateGuildActor(ctx, actor, request.guildUid, ERRORS.ACCEPT_NO_PERMISSION);
  if (actorState.errorCode !== ERRORS.OK) return membershipFailure(actorState.errorCode, request);
  if (request.userUid <= 0n || request.userUid === getUserUid(actor)) {
    return membershipFailure(ERRORS.INVALID_MEMBER_UID, request);
  }
  const targetUser = findUserByUid(ctx, request.userUid);
  if (!targetUser) return membershipFailure(ERRORS.INVALID_MEMBER_UID, request);
  const requests = getRelatedGuildUids(targetUser, 0);
  if (!requests.some((guildUid) => guildUid === request.guildUid)) {
    return membershipFailure(ERRORS.NOT_JOIN_REQUESTED, request, targetUser);
  }
  if (request.isAllow && getGuildUid(targetUser) > 0n) {
    return membershipFailure(ERRORS.ALREADY_JOINED, request, targetUser);
  }
  if (request.isAllow && actorState.guild.members.length >= getGuildMaxMemberCount(actorState.guild.guildLevel)) {
    return membershipFailure(ERRORS.MAX_MEMBER_COUNT, request, targetUser);
  }

  if (request.isAllow) setGuildMembership(ctx, targetUser, actorState.guild);
  else setRelatedGuildUids(targetUser, 0, requests.filter((guildUid) => guildUid !== request.guildUid));
  return membershipSuccess(request, targetUser, actorState.guild);
}

function inviteGuildMember(ctx, actor, request) {
  const actorState = validateGuildActor(ctx, actor, request.guildUid, ERRORS.NOT_ENOUGH_GRADE);
  if (actorState.errorCode !== ERRORS.OK) return membershipFailure(actorState.errorCode, request);
  if (request.userUid <= 0n || request.userUid === getUserUid(actor)) {
    return membershipFailure(ERRORS.INVALID_MEMBER_UID, request);
  }
  const targetUser = findUserByUid(ctx, request.userUid);
  if (!targetUser) return membershipFailure(ERRORS.INVALID_MEMBER_UID, request);
  if (getGuildUid(targetUser) > 0n) return membershipFailure(ERRORS.INVITE_USER_IN_OTHER_GUILD, request, targetUser);
  if (getRelatedGuildUids(targetUser, 0).some((guildUid) => guildUid === request.guildUid)) {
    return membershipFailure(ERRORS.JOIN_REQUEST_EXIST, request, targetUser);
  }
  const invites = getRelatedGuildUids(targetUser, 1);
  if (invites.some((guildUid) => guildUid === request.guildUid)) {
    return membershipFailure(ERRORS.ALREADY_INVITED, request, targetUser);
  }
  if (actorState.guild.members.length >= getGuildMaxMemberCount(actorState.guild.guildLevel)) {
    return membershipFailure(ERRORS.MAX_MEMBER_COUNT, request, targetUser);
  }
  if (getGuildRelationshipUsers(ctx, request.guildUid, 1).length >= loadTables().guildConfig.maxInviteCount) {
    return membershipFailure(ERRORS.MAX_INVITE_COUNT, request, targetUser);
  }
  setRelatedGuildUids(targetUser, 1, [...invites, request.guildUid]);
  return membershipSuccess(request, targetUser, actorState.guild);
}

function cancelGuildInvite(ctx, actor, request) {
  const actorState = validateGuildActor(ctx, actor, request.guildUid, ERRORS.NOT_ENOUGH_GRADE);
  if (actorState.errorCode !== ERRORS.OK) return membershipFailure(actorState.errorCode, request);
  if (request.userUid <= 0n || request.userUid === getUserUid(actor)) {
    return membershipFailure(ERRORS.INVALID_MEMBER_UID, request);
  }
  const targetUser = findUserByUid(ctx, request.userUid);
  if (!targetUser) return membershipFailure(ERRORS.INVALID_MEMBER_UID, request);
  const invites = getRelatedGuildUids(targetUser, 1);
  if (!invites.some((guildUid) => guildUid === request.guildUid)) {
    return membershipFailure(ERRORS.INVITE_DATA_NOT_FOUND, request, targetUser);
  }
  setRelatedGuildUids(targetUser, 1, invites.filter((guildUid) => guildUid !== request.guildUid));
  return membershipSuccess(request, targetUser, actorState.guild);
}

function acceptGuildInvite(ctx, user, request) {
  if (!user) return membershipFailure(ERRORS.INVALID_REQUEST, request);
  if (request.guildUid <= 0n) return membershipFailure(ERRORS.INVALID_GUILD_UID, request, user);
  const invites = getRelatedGuildUids(user, 1);
  if (!invites.some((guildUid) => guildUid === request.guildUid)) {
    return membershipFailure(ERRORS.INVITE_DATA_NOT_FOUND, request, user);
  }
  const guild = getGuildData(ctx, request.guildUid);
  if (!guild) return membershipFailure(ERRORS.INVALID_GUILD_UID, request, user);
  if (request.isAllow && getGuildUid(user) > 0n) {
    return membershipFailure(ERRORS.INVITE_USER_IN_OTHER_GUILD, request, user);
  }
  if (request.isAllow && getGuildJoinDisableTime(user) > binaryNow(ctx)) {
    return membershipFailure(ERRORS.JOIN_DISABLE_PENALTY, request, user);
  }
  if (request.isAllow && guild.members.length >= getGuildMaxMemberCount(guild.guildLevel)) {
    return membershipFailure(ERRORS.MAX_MEMBER_COUNT, request, user);
  }

  if (request.isAllow) setGuildMembership(ctx, user, guild);
  else setRelatedGuildUids(user, 1, invites.filter((guildUid) => guildUid !== request.guildUid));
  return membershipSuccess(request, user, guild);
}

function membershipFailure(errorCode, request, targetUser = null) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(request && request.guildUid || 0),
    userUid: toBigInt(request && request.userUid || 0),
    isAllow: Boolean(request && request.isAllow),
    targetUser,
    guild: null,
  };
}

function membershipSuccess(request, targetUser, guild) {
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: toBigInt(request.guildUid || 0),
    userUid: getUserUid(targetUser),
    isAllow: Boolean(request.isAllow),
    targetUser,
    guild,
  };
}

function exitGuild(ctx, user, guildUid) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  if (normalizedGuildUid <= 0n) return guildAdminFailure(ERRORS.INVALID_GUILD_UID, { guildUid: normalizedGuildUid });
  if (!user || getGuildUid(user) <= 0n) return guildAdminFailure(ERRORS.NOT_A_MEMBER, { guildUid: normalizedGuildUid });
  if (getGuildUid(user) !== normalizedGuildUid) return guildAdminFailure(ERRORS.INVALID_GUILD_UID, { guildUid: normalizedGuildUid });
  if (!getGuildData(ctx, normalizedGuildUid)) return guildAdminFailure(ERRORS.INVALID_GUILD_UID, { guildUid: normalizedGuildUid });
  if (getGuildGrade(user) === 0) return guildAdminFailure(ERRORS.INVALID_GRADE, { guildUid: normalizedGuildUid });

  const config = loadTables().guildConfig;
  const disableUntil = new Date(currentServerDate(ctx).getTime() + config.exitPenaltyHours * 60 * 60 * 1000);
  const joinDisableTime = dateTimeBinaryForDateLocal(disableUntil);
  clearGuildMembership(user);
  user.guildJoinDisableTime = String(joinDisableTime);
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: normalizedGuildUid,
    userUid: getUserUid(user),
    grade: 2,
    gradeBefore: 2,
    banReason: 0,
    joinDisableTime,
    targetUser: user,
  };
}

function setGuildMemberGrade(ctx, actor, request) {
  const normalizedGuildUid = toBigInt(request.guildUid || 0);
  if (normalizedGuildUid <= 0n) return guildAdminFailure(ERRORS.INVALID_GUILD_UID, request);
  if (!actor || getGuildUid(actor) <= 0n) return guildAdminFailure(ERRORS.NOT_A_MEMBER, request);
  if (getGuildUid(actor) !== normalizedGuildUid) return guildAdminFailure(ERRORS.INVALID_GUILD_UID, request);
  if (getGuildGrade(actor) !== 0) return guildAdminFailure(ERRORS.NOT_MASTER, request);
  const guild = getGuildData(ctx, normalizedGuildUid);
  if (!guild) return guildAdminFailure(ERRORS.INVALID_GUILD_UID, request);
  const targetUser = findUserByUid(ctx, request.userUid);
  if (!targetUser || targetUser === actor || getGuildUid(targetUser) !== normalizedGuildUid || getGuildGrade(targetUser) === 0) {
    return guildAdminFailure(ERRORS.SET_GRADE_INVALID_TARGET, request, targetUser);
  }
  if (request.grade !== 1 && request.grade !== 2) {
    return guildAdminFailure(ERRORS.SET_GRADE_INVALID_VALUE, request, targetUser);
  }
  const gradeBefore = getGuildGrade(targetUser);
  if (gradeBefore === request.grade) return guildAdminFailure(ERRORS.SET_GRADE_INVALID_VALUE, request, targetUser);
  if (request.grade === 1) {
    const staffCount = guild.members.filter((member) => getGuildGrade(member) === 1).length;
    if (staffCount >= loadTables().guildConfig.maxStaffCount) {
      return guildAdminFailure(ERRORS.SET_GRADE_MAX_STAFF_COUNT, request, targetUser);
    }
  }
  targetUser.guildMemberGrade = request.grade;
  return guildAdminSuccess(request, targetUser, { gradeBefore, grade: request.grade });
}

function banGuildMember(ctx, actor, request) {
  const actorState = validateGuildActor(ctx, actor, request.guildUid, ERRORS.NOT_ENOUGH_GRADE);
  if (actorState.errorCode !== ERRORS.OK) return guildAdminFailure(actorState.errorCode, request);
  if (request.banReason < 1 || request.banReason > 4) return guildAdminFailure(ERRORS.INVALID_REQUEST, request);
  const targetUser = findUserByUid(ctx, request.userUid);
  if (
    !targetUser
    || targetUser === actor
    || getGuildUid(targetUser) !== request.guildUid
    || getGuildGrade(targetUser) <= getGuildGrade(actor)
  ) {
    return guildAdminFailure(ERRORS.BAN_INVALID_TARGET, request, targetUser);
  }
  const gradeBefore = getGuildGrade(targetUser);
  clearGuildMembership(targetUser);
  targetUser.guildLastBan = {
    guildUid: String(request.guildUid),
    reason: request.banReason,
    at: currentServerDate(ctx).toISOString(),
  };
  return guildAdminSuccess(request, targetUser, { gradeBefore, grade: 2 });
}

function migrateGuildMaster(ctx, actor, guildUid) {
  const request = { guildUid: toBigInt(guildUid || 0), targetUserUid: getUserUid(actor) };
  if (request.guildUid <= 0n) return guildMasterMigrationFailure(ERRORS.INVALID_GUILD_UID, request);
  if (!actor || getGuildUid(actor) <= 0n) return guildMasterMigrationFailure(ERRORS.NOT_A_MEMBER, request);
  if (getGuildUid(actor) !== request.guildUid) return guildMasterMigrationFailure(ERRORS.INVALID_GUILD_UID, request);
  const guild = getGuildData(ctx, request.guildUid);
  if (!guild) return guildMasterMigrationFailure(ERRORS.INVALID_GUILD_UID, request);
  if (getGuildGrade(actor) === 0) {
    return guildMasterMigrationFailure(ERRORS.MASTER_MIGRATION_INVALID_TARGET, request);
  }
  if (guild.guildState !== 2 || guild.closingTime <= 0n || isGuildClosureDue(ctx, guild.closingTime)) {
    return guildMasterMigrationFailure(ERRORS.MASTER_MIGRATION_INVALID_GUILD_STATE, request);
  }
  const oldMaster = guild.members.find((member) => getGuildGrade(member) === 0);
  if (!oldMaster) return guildMasterMigrationFailure(ERRORS.MASTER_NOT_FOUND, request);

  const actorGrade = getGuildGrade(actor);
  oldMaster.guildMemberGrade = actorGrade;
  actor.guildMemberGrade = 0;
  for (const member of guild.members) setGuildLifecycleState(member, 1, 0n);
  return guildMasterMigrationSuccess(request.guildUid, oldMaster, actor, false);
}

function migrateGuildMasterSpecified(ctx, actor, request) {
  const normalizedGuildUid = toBigInt(request && request.guildUid || 0);
  const normalizedTargetUid = toBigInt(request && request.targetUserUid || 0);
  const normalizedRequest = { guildUid: normalizedGuildUid, targetUserUid: normalizedTargetUid };
  if (normalizedGuildUid <= 0n) return guildMasterMigrationFailure(ERRORS.INVALID_GUILD_UID, normalizedRequest);
  if (!actor || getGuildUid(actor) <= 0n) return guildMasterMigrationFailure(ERRORS.NOT_A_MEMBER, normalizedRequest);
  if (getGuildUid(actor) !== normalizedGuildUid) {
    return guildMasterMigrationFailure(ERRORS.INVALID_GUILD_UID, normalizedRequest);
  }
  const guild = getGuildData(ctx, normalizedGuildUid);
  if (!guild) return guildMasterMigrationFailure(ERRORS.INVALID_GUILD_UID, normalizedRequest);
  if (getGuildGrade(actor) !== 0) return guildMasterMigrationFailure(ERRORS.NOT_MASTER, normalizedRequest);
  if (guild.guildState !== 1) {
    return guildMasterMigrationFailure(ERRORS.MASTER_MIGRATION_INVALID_GUILD_STATE, normalizedRequest);
  }
  const targetUser = findUserByUid(ctx, normalizedTargetUid);
  if (!targetUser || targetUser === actor || getGuildUid(targetUser) !== normalizedGuildUid) {
    return guildMasterMigrationFailure(ERRORS.MASTER_MIGRATION_INVALID_TARGET, normalizedRequest);
  }
  if (getGuildGrade(targetUser) !== 1) {
    return guildMasterMigrationFailure(ERRORS.MASTER_MIGRATION_INVALID_TARGET_GRADE, normalizedRequest);
  }

  actor.guildMemberGrade = 1;
  targetUser.guildMemberGrade = 0;
  return guildMasterMigrationSuccess(normalizedGuildUid, actor, targetUser, true);
}

function setGuildLifecycleState(user, state, closingTime) {
  user.guildState = state;
  user.guildClosingTime = String(toBigInt(closingTime || 0));
  if (user.guild && typeof user.guild === "object") {
    user.guild.state = state;
    user.guild.closingTime = String(toBigInt(closingTime || 0));
  }
}

function guildMasterMigrationFailure(errorCode, request) {
  return {
    changed: false,
    specified: false,
    errorCode,
    guildUid: toBigInt(request && request.guildUid || 0),
    oldMasterUserUid: 0n,
    newMasterUserUid: toBigInt(request && request.targetUserUid || 0),
  };
}

function guildMasterMigrationSuccess(guildUid, oldMaster, newMaster, specified) {
  return {
    changed: true,
    specified: Boolean(specified),
    errorCode: ERRORS.OK,
    guildUid: toBigInt(guildUid || 0),
    oldMasterUserUid: getUserUid(oldMaster),
    newMasterUserUid: getUserUid(newMaster),
  };
}

function updateGuildData(ctx, actor, request) {
  const state = validateGuildMaster(ctx, actor, request.guildUid);
  if (state.errorCode !== ERRORS.OK) return guildUpdateDataFailure(state.errorCode, request);
  if (!isValidGuildGreeting(request.greeting)) return guildUpdateDataFailure(ERRORS.INVALID_REQUEST, request);
  if (isGuildMuteActive(ctx, actor, ["guildGreetingMuteUntil", "guildGreetingMuteEndDate", "guildGreetingMutedUntil"], "guildGreetingMuted")) {
    return guildUpdateDataFailure(ERRORS.GUILD_GREETING_MUTE, request);
  }
  if (!isValidGuildBadge(request.badgeId)) return guildUpdateDataFailure(ERRORS.CREATION_INVALID_UID, request);
  if (request.guildJoinType !== state.guild.guildJoinType
      && request.guildJoinType !== 1
      && state.guild.joinWaitingList.length > 0) {
    return guildUpdateDataFailure(ERRORS.JOIN_REQUEST_EXIST, request);
  }

  const greetingBefore = state.guild.greeting;
  const changed = greetingBefore !== request.greeting
    || state.guild.guildJoinType !== request.guildJoinType
    || state.guild.badgeId !== request.badgeId
    || state.guild.chatNoticeType !== request.chatNoticeType;
  if (changed) {
    for (const member of state.guild.members) {
      member.guildGreeting = request.greeting;
      member.guildJoinType = request.guildJoinType;
      member.guildBadgeId = String(request.badgeId);
      member.guildChatNoticeType = request.chatNoticeType;
      if (member.guild && typeof member.guild === "object") {
        member.guild.greeting = request.greeting;
        member.guild.joinType = request.guildJoinType;
        member.guild.badgeId = String(request.badgeId);
        member.guild.chatNoticeType = request.chatNoticeType;
      }
    }
  }
  return {
    changed,
    errorCode: ERRORS.OK,
    guildUid: request.guildUid,
    greetingBefore,
    greeting: request.greeting,
    guildJoinType: request.guildJoinType,
    badgeId: request.badgeId,
    chatNoticeType: request.chatNoticeType,
  };
}

function guildUpdateDataFailure(errorCode, request) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(request && request.guildUid || 0),
    greetingBefore: "",
    greeting: String(request && request.greeting || ""),
    guildJoinType: Number(request && request.guildJoinType || 0),
    badgeId: toBigInt(request && request.badgeId || 0),
    chatNoticeType: Number(request && request.chatNoticeType || 0),
  };
}

function updateGuildNotice(ctx, actor, request) {
  const state = validateGuildActor(ctx, actor, request.guildUid, ERRORS.NOT_ENOUGH_GRADE);
  if (state.errorCode !== ERRORS.OK) return guildTextUpdateFailure(state.errorCode, request, "notice");
  if (!isValidGuildNotice(request.notice)) return guildTextUpdateFailure(ERRORS.INVALID_REQUEST, request, "notice");
  if (isGuildMuteActive(ctx, actor, ["guildNoticeMuteUntil", "guildNoticeMuteEndDate", "guildNoticeMutedUntil"], "guildNoticeMuted")) {
    return guildTextUpdateFailure(ERRORS.GUILD_NOTICE_MUTE, request, "notice");
  }
  const noticeBefore = state.guild.notice;
  const lastChangedAt = getGuildNoticeChangedAt(state.guild.members);
  if (noticeBefore === request.notice || lastChangedAt && currentServerDate(ctx).getTime() - lastChangedAt.getTime() < 60000) {
    return guildTextUpdateFailure(ERRORS.GUILD_UPDATE_NOTICE, request, "notice", noticeBefore);
  }
  const changedAt = currentServerDate(ctx).toISOString();
  for (const member of state.guild.members) {
    member.guildNotice = request.notice;
    member.guildNoticeChangedAt = changedAt;
    if (member.guild && typeof member.guild === "object") {
      member.guild.notice = request.notice;
      member.guild.noticeChangedAt = changedAt;
    }
  }
  return { changed: true, errorCode: ERRORS.OK, guildUid: request.guildUid, noticeBefore, notice: request.notice };
}

function updateGuildMemberGreeting(ctx, actor, request) {
  const normalizedGuildUid = toBigInt(request && request.guildUid || 0);
  if (normalizedGuildUid <= 0n) return guildTextUpdateFailure(ERRORS.INVALID_GUILD_UID, request, "greeting");
  if (!actor || getGuildUid(actor) <= 0n) return guildTextUpdateFailure(ERRORS.NOT_A_MEMBER, request, "greeting");
  if (getGuildUid(actor) !== normalizedGuildUid) {
    return guildTextUpdateFailure(ERRORS.INVALID_GUILD_UID, request, "greeting");
  }
  if (!getGuildData(ctx, normalizedGuildUid)) return guildTextUpdateFailure(ERRORS.INVALID_GUILD_UID, request, "greeting");
  if (!isValidGuildMemberGreeting(request.greeting)) {
    return guildTextUpdateFailure(ERRORS.INVALID_REQUEST, request, "greeting");
  }
  if (isGuildMuteActive(ctx, actor, ["guildMemberGreetingMuteUntil", "guildMemberGreetingMuteEndDate", "guildMemberGreetingMutedUntil"], "guildMemberGreetingMuted")) {
    return guildTextUpdateFailure(ERRORS.GUILD_MEMBER_GREETING_MUTE, request, "greeting");
  }
  const before = firstStoredString(actor, guildObjects(actor), ["guildMemberGreeting", "memberGreeting"], "");
  const changed = before !== request.greeting;
  if (changed) {
    actor.guildMemberGreeting = request.greeting;
    if (actor.guild && typeof actor.guild === "object") actor.guild.memberGreeting = request.greeting;
  }
  return { changed, errorCode: ERRORS.OK, guildUid: normalizedGuildUid, greeting: request.greeting };
}

function renameGuild(ctx, actor, newName) {
  const guildUid = getGuildUid(actor);
  const state = validateGuildMaster(ctx, actor, guildUid);
  const previousName = state.guild ? state.guild.name : "";
  if (state.errorCode !== ERRORS.OK) {
    const errorCode = state.errorCode === ERRORS.NOT_MASTER ? ERRORS.RENAME_NO_PERMISSION : ERRORS.RENAME_FAILED;
    return guildRenameFailure(errorCode, previousName, newName, guildUid);
  }
  if (state.guild.guildState !== 1) return guildRenameFailure(ERRORS.RENAME_FAILED, previousName, newName, guildUid);
  if (!isValidGuildName(newName)) return guildRenameFailure(ERRORS.RENAME_INVALID_NAME, previousName, newName, guildUid);
  if (previousName.toUpperCase() === newName.toUpperCase()) {
    return guildRenameFailure(ERRORS.RENAME_SAME_NAME, previousName, newName, guildUid);
  }
  if (getGuildDirectory(ctx).some((guild) => guild.guildUid !== guildUid && guild.name.toUpperCase() === newName.toUpperCase())) {
    return guildRenameFailure(ERRORS.RENAME_ALREADY_EXISTS_NAME, previousName, newName, guildUid);
  }

  const config = loadTables().guildRenameConfig;
  const lastRenameDate = parseStoredDate(state.guild.latestRenameDate);
  if (lastRenameDate && currentServerDate(ctx).getTime() < lastRenameDate.getTime() + config.limitDays * 24 * 60 * 60 * 1000) {
    return guildRenameFailure(ERRORS.RENAME_LIMIT_DAY, previousName, newName, guildUid);
  }
  const requiresPayment = state.guild.renameCount >= config.freeCount;
  if (requiresPayment && state.guild.unionPoint < BigInt(config.resourceValue)) {
    return guildRenameFailure(ERRORS.RENAME_INSUFFICIENT_RESOURCE, previousName, newName, guildUid);
  }

  const renamedAt = binaryNow(ctx);
  const renameCount = state.guild.renameCount + 1;
  const unionPoint = requiresPayment ? state.guild.unionPoint - BigInt(config.resourceValue) : state.guild.unionPoint;
  for (const member of state.guild.members) {
    member.guildName = newName;
    member.guildRenameCount = renameCount;
    member.guildLatestRenameDate = String(renamedAt);
    setGuildUnionPoint(member, unionPoint);
    if (member.guild && typeof member.guild === "object") {
      member.guild.name = newName;
      member.guild.renameCount = renameCount;
      member.guild.latestRenameDate = String(renamedAt);
    }
  }
  return { changed: true, errorCode: ERRORS.OK, guildUid, prevName: previousName, newName };
}

function guildRenameFailure(errorCode, prevName, newName, guildUid = 0n) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(guildUid || 0),
    prevName: String(prevName || ""),
    newName: String(newName || ""),
  };
}

function guildTextUpdateFailure(errorCode, request, fieldName, previous = "") {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(request && request.guildUid || 0),
    [`${fieldName}Before`]: previous,
    [fieldName]: String(request && request[fieldName] || ""),
  };
}

function isValidGuildNotice(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 36 && isGuildTextSafe(value, false);
}

function isValidGuildMemberGreeting(value) {
  return typeof value === "string" && value.length <= 13 && isGuildTextSafe(value, false);
}

function isGuildTextSafe(value, allowTab) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdfff) return false;
    if (code < 0x20 && (!allowTab || code !== 0x09)) return false;
  }
  return true;
}

function isGuildMuteActive(ctx, user, dateFields, booleanField) {
  if (!user || typeof user !== "object") return false;
  if (user[booleanField] === true || user.guild && user.guild[booleanField] === true) return true;
  const value = firstStoredValue(user, guildObjects(user), dateFields);
  if (value == null || value === "") return false;
  const date = parseStoredDate(value) || dateFromDateTime(value);
  return Boolean(date && date.getTime() > currentServerDate(ctx).getTime());
}

function getGuildNoticeChangedAt(members) {
  let latest = null;
  for (const member of members || []) {
    const value = firstStoredValue(member, guildObjects(member), ["guildNoticeChangedAt", "noticeChangedAt"]);
    const date = parseStoredDate(value) || dateFromDateTime(value);
    if (date && (!latest || date > latest)) latest = date;
  }
  return latest;
}

function clearGuildMembership(user) {
  if (!user || typeof user !== "object") return;
  user.guildUid = "0";
  user.guildName = "";
  user.guildBadgeId = "0";
  user.guildLevel = 1;
  user.guildLevelExp = "0";
  user.guildUnionPoint = "0";
  user.guildJoinType = 0;
  user.guildState = 1;
  user.guildClosingTime = "0";
  user.guildGreeting = "";
  user.guildNotice = "";
  user.guildDungeonNotice = "";
  user.guildChatNoticeType = 0;
  user.guildRenameCount = 0;
  user.guildLatestRenameDate = "0";
  user.guildMemberGrade = 2;
  user.guildMemberCreatedAt = "";
  user.guildLastAttendanceDate = "0";
  user.guildAttendanceHistory = [];
  user.guildWeeklyContributionPoint = 0;
  user.guildTotalContributionPoint = 0;
  setRelatedGuildUids(user, 0, []);
  setRelatedGuildUids(user, 1, []);
}

function guildAdminFailure(errorCode, request, targetUser = null) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(request && request.guildUid || 0),
    userUid: toBigInt(request && request.userUid || 0),
    grade: Number(request && request.grade || 0),
    gradeBefore: Number(targetUser ? getGuildGrade(targetUser) : 0),
    banReason: Number(request && request.banReason || 0),
    joinDisableTime: 0n,
    targetUser,
  };
}

function guildAdminSuccess(request, targetUser, overrides = {}) {
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: toBigInt(request.guildUid || 0),
    userUid: getUserUid(targetUser),
    grade: Number(overrides.grade == null ? request.grade : overrides.grade),
    gradeBefore: Number(overrides.gradeBefore == null ? 0 : overrides.gradeBefore),
    banReason: Number(request.banReason || 0),
    joinDisableTime: 0n,
    targetUser,
  };
}

function joinGuild(ctx, user, request) {
  if (!user) return guildJoinFailure(ctx, user, ERRORS.INVALID_REQUEST, request.guildUid);
  if (request.guildUid <= 0n) return guildJoinFailure(ctx, user, ERRORS.INVALID_GUILD_UID, request.guildUid);
  if (getGuildUid(user) > 0n) return guildJoinFailure(ctx, user, ERRORS.ALREADY_JOINED, request.guildUid);
  const guild = getGuildData(ctx, request.guildUid);
  if (!guild) return guildJoinFailure(ctx, user, ERRORS.INVALID_GUILD_UID, request.guildUid);
  if (request.guildJoinType !== guild.guildJoinType) return guildJoinFailure(ctx, user, ERRORS.INVALID_REQUEST, request.guildUid);
  if (guild.guildJoinType === 2 || guild.guildState !== 1) return guildJoinFailure(ctx, user, ERRORS.JOIN_DISABLED, request.guildUid);
  if (getGuildJoinDisableTime(user) > binaryNow(ctx)) return guildJoinFailure(ctx, user, ERRORS.JOIN_DISABLE_PENALTY, request.guildUid);

  const outgoing = getRelatedGuildUids(user, 0);
  const invites = getRelatedGuildUids(user, 1);
  if (outgoing.some((guildUid) => guildUid === request.guildUid)) {
    return guildJoinFailure(ctx, user, ERRORS.ALREADY_JOIN_REQUESTED, request.guildUid);
  }
  if (invites.some((guildUid) => guildUid === request.guildUid)) {
    return guildJoinFailure(ctx, user, ERRORS.ALREADY_INVITED, request.guildUid);
  }
  if (guild.members.length >= getGuildMaxMemberCount(guild.guildLevel)) {
    return guildJoinFailure(ctx, user, ERRORS.MAX_MEMBER_COUNT, request.guildUid);
  }

  if (guild.guildJoinType === 1) {
    const config = loadTables().guildConfig;
    if (outgoing.length >= config.maxJoinRequestCount) {
      return guildJoinFailure(ctx, user, ERRORS.MAX_REQUEST_COUNT, request.guildUid);
    }
    if (getGuildRelationshipUsers(ctx, request.guildUid, 0).length >= config.maxRequestReceiveCount) {
      return guildJoinFailure(ctx, user, ERRORS.MAX_REQUEST_RECEIVE_COUNT, request.guildUid);
    }
    setRelatedGuildUids(user, 0, [...outgoing, request.guildUid]);
    return { changed: true, joined: false, errorCode: ERRORS.OK, needApproval: true, guildUid: request.guildUid };
  }

  setGuildMembership(ctx, user, guild);
  return { changed: true, joined: true, errorCode: ERRORS.OK, needApproval: false, guildUid: request.guildUid };
}

function cancelGuildJoin(user, guildUid) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  if (normalizedGuildUid <= 0n) return { changed: false, errorCode: ERRORS.INVALID_GUILD_UID, guildUid: normalizedGuildUid };
  const outgoing = getRelatedGuildUids(user, 0);
  if (!outgoing.some((value) => value === normalizedGuildUid)) {
    return { changed: false, errorCode: ERRORS.NOT_JOIN_REQUESTED, guildUid: normalizedGuildUid };
  }
  setRelatedGuildUids(user, 0, outgoing.filter((value) => value !== normalizedGuildUid));
  return { changed: true, errorCode: ERRORS.OK, guildUid: normalizedGuildUid };
}

function guildJoinFailure(ctx, user, errorCode, guildUid) {
  return {
    changed: false,
    joined: false,
    errorCode,
    needApproval: false,
    guildUid: toBigInt(guildUid || 0),
    privateGuildData: buildPrivateGuildData(ctx, user),
  };
}

function setGuildMembership(ctx, user, guild) {
  const now = currentServerDate(ctx);
  user.guildUid = String(guild.guildUid);
  user.guildName = guild.name;
  user.guildBadgeId = String(guild.badgeId);
  user.guildLevel = guild.guildLevel;
  user.guildLevelExp = String(guild.guildLevelExp);
  user.guildUnionPoint = String(guild.unionPoint);
  user.guildJoinType = guild.guildJoinType;
  user.guildState = guild.guildState;
  user.guildMemberGrade = 2;
  user.guildMemberCreatedAt = now.toISOString();
  user.guildLastAttendanceDate = "0";
  user.guildAttendanceHistory = [];
  user.guildWeeklyContributionPoint = 0;
  user.guildTotalContributionPoint = 0;
  setRelatedGuildUids(user, 0, []);
  setRelatedGuildUids(user, 1, []);
  queueFirstGuildJoinReward(ctx, user);
}

function queueFirstGuildJoinReward(ctx, user) {
  if (!user || user.guildFirstJoinRewardQueued) return 0;
  const reward = loadTables().guildConfig.firstJoinReward;
  if (!reward || reward.itemId <= 0 || reward.count <= 0) return 0;
  const posts = createAdminRewardPosts(
    user,
    [{ rewardType: "RT_MISC", id: reward.itemId, count: reward.count }],
    reward.title,
    reward.contents
  );
  const now = currentServerDate(ctx);
  const expiration = new Date(now.getTime() + reward.expireDays * 24 * 60 * 60 * 1000);
  for (const post of posts) {
    post.sendDate = String(dateTimeBinaryForDateLocal(now));
    post.expirationDate = String(dateTimeBinaryForDateLocal(expiration));
  }
  user.guildFirstJoinRewardQueued = true;
  user.guildFirstJoinRewardQueuedAt = now.toISOString();
  return posts.length;
}

function getGuildJoinDisableTime(user) {
  return firstStoredDateTime(user, guildObjects(user), ["guildJoinDisableTime", "joinDisableTime"]);
}

function getGuildMaxMemberCount(guildLevel) {
  const row = loadTables().guildExpRows.find((entry) => entry.level === Number(guildLevel));
  return Math.max(1, Number(row && row.maxMemberCount || 30));
}

function buildPrivateGuildData(ctx, user) {
  const daily = getDonationState(user, currentServerDate(ctx));
  return Buffer.concat([
    writeSignedVarLong(getGuildUid(user)),
    writeSignedVarInt(daily.donationCount),
    writeInt64LE(daily.lastDailyResetDate),
    writeInt64LE(getGuildJoinDisableTime(user)),
  ]);
}

function buildGuildJoinAckPayload(ctx, user, result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeBool(Boolean(value.needApproval)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeNullableObject(value.privateGuildData || buildPrivateGuildData(ctx, user)),
  ]);
}

function buildGuildCancelJoinAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
  ]);
}

function buildGuildAcceptJoinAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeBool(Boolean(value.isAllow)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarLong(toBigInt(value.userUid || 0)),
  ]);
}

function buildGuildAcceptJoinNotPayload(ctx, user, result) {
  const value = result || {};
  return Buffer.concat([
    writeBool(Boolean(value.isAllow)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeString(value.guild && value.guild.name || ""),
    writeNullableObject(buildPrivateGuildData(ctx, user)),
  ]);
}

function buildGuildInviteAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.userUid || 0)),
  ]);
}

function buildGuildInviteNotPayload(guildUid) {
  return writeSignedVarLong(toBigInt(guildUid || 0));
}

function buildGuildCancelInviteAckPayload(result) {
  return buildGuildInviteAckPayload(result);
}

function buildGuildCancelRequestNotPayload(guildUid, isRequest) {
  return Buffer.concat([writeSignedVarLong(toBigInt(guildUid || 0)), writeBool(Boolean(isRequest))]);
}

function buildGuildAcceptInviteAckPayload(ctx, user, result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeBool(Boolean(value.isAllow)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeNullableObject(buildPrivateGuildData(ctx, user)),
  ]);
}

function buildGuildExitAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeInt64LE(toBigInt(value.joinDisableTime || 0)),
  ]);
}

function buildGuildSetMemberGradeAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarLong(toBigInt(value.userUid || 0)),
    writeSignedVarInt(Number(value.grade || 0)),
  ]);
}

function buildGuildMemberGradeUpdatedNotPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarInt(Number(value.gradeBefore || 0)),
    writeSignedVarInt(Number(value.grade || 0)),
  ]);
}

function buildGuildBanAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarLong(toBigInt(value.userUid || 0)),
  ]);
}

function buildGuildBanNotPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarInt(Number(value.banReason || 0)),
  ]);
}

function buildGuildMasterMigrationAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarLong(toBigInt(value.oldMasterUserUid || 0)),
    writeSignedVarLong(toBigInt(value.newMasterUserUid || 0)),
  ]);
}

function buildGuildMasterSpecifiedMigrationNotPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarLong(toBigInt(value.oldMasterUserUid || 0)),
    writeSignedVarLong(toBigInt(value.newMasterUserUid || 0)),
  ]);
}

function buildGuildUpdateDataAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeString(value.greetingBefore || ""),
    writeString(value.greeting || ""),
    writeSignedVarInt(Number(value.guildJoinType || 0)),
    writeSignedVarLong(toBigInt(value.badgeId || 0)),
    writeSignedVarInt(Number(value.chatNoticeType || 0)),
  ]);
}

function buildGuildUpdateNoticeAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeString(value.noticeBefore || ""),
    writeString(value.notice || ""),
  ]);
}

function buildGuildUpdateMemberGreetingAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeString(value.greeting || ""),
  ]);
}

function buildGuildUpdateNoticeNotPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeString(value.notice || ""),
  ]);
}

function buildGuildRenameAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeString(value.prevName || ""),
    writeString(value.newName || ""),
  ]);
}

function buildGuildRenameNotPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeString(value.newName || ""),
  ]);
}

function notifyGuildRename(ctx, requestSocket, result) {
  const guildData = getGuildData(ctx, result && result.guildUid);
  if (!guildData) return;
  const payload = buildGuildRenameNotPayload(result);
  for (const target of guildData.members) {
    const socket = findSocketForUser(ctx, requestSocket, target);
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.RENAME_NOT, payload, "guild-rename-not");
  }
}

function notifyGuildChat(ctx, requestSocket, guildUid, message) {
  const guildData = getGuildData(ctx, guildUid);
  if (!guildData) return;
  const payload = buildGuildChatNotPayload(ctx, message);
  for (const target of guildData.members) {
    const socket = findSocketForUser(ctx, requestSocket, target);
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.CHAT_NOT, payload, "guild-chat-not");
  }
}

function notifyGuildChatMute(ctx, requestSocket, user, muteEndDate) {
  const socket = findSocketForUser(ctx, requestSocket, user);
  if (socket && !socket.destroyed) {
    sendPush(ctx, socket, PACKETS.BLOCK_MUTE_NOT, buildGuildChatBlockMuteNotPayload(user, muteEndDate), "guild-chat-block-mute-not");
  }
}

function notifyGuildNoticeUpdated(ctx, requestSocket, actor, result) {
  const guildData = getGuildData(ctx, result && result.guildUid);
  if (!guildData) return;
  const payload = buildGuildUpdateNoticeNotPayload(result);
  for (const target of guildData.members) {
    if (getUserUid(target) === getUserUid(actor)) continue;
    const socket = findSocketForUser(ctx, requestSocket, target);
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.UPDATE_NOTICE_NOT, payload, "guild-update-notice-not");
  }
}

function notifyGuildMasterSpecifiedMigration(ctx, requestSocket, result) {
  const guildData = getGuildData(ctx, result && result.guildUid);
  if (!guildData) return;
  const payload = buildGuildMasterSpecifiedMigrationNotPayload(result);
  for (const target of guildData.members) {
    const socket = findSocketForUser(ctx, requestSocket, target);
    if (socket && !socket.destroyed) {
      sendPush(ctx, socket, PACKETS.MASTER_SPECIFIED_MIGRATION_NOT, payload, "guild-master-specified-migration-not");
    }
  }
}

function buildGuildDataUpdatedNotPayload(guildData) {
  return guildData ? writeNullableObject(buildGuildData(guildData)) : writeNullObject();
}

function buildGuildLevelUpNotPayload(result) {
  const value = result || {};
  const progress = value.guildProgress || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarInt(Number(progress.level || 1)),
    writeSignedVarLong(toBigInt(progress.exp || 0)),
    writeSignedVarLong(toBigInt(progress.totalExp || 0)),
    writeInt64LE(toBigInt(value.levelUpTime || 0)),
  ]);
}

function buildGuildUserProfileUpdatedNotPayload(user, lastOnlineTime) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user || {})),
    writeInt64LE(toBigInt(lastOnlineTime || 0)),
  ]);
}

function buildGuildJoinDisableTimeUpdatedNotPayload(joinDisableTime) {
  return writeInt64LE(toBigInt(joinDisableTime || 0));
}

function notifyGuildLevelUp(ctx, requestSocket, result) {
  const guildData = getGuildData(ctx, result && result.guildUid);
  if (!guildData) return;
  const payload = buildGuildLevelUpNotPayload(result);
  for (const target of guildData.members) {
    const socket = findSocketForUser(ctx, requestSocket, target);
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.LEVEL_UP_NOT, payload, "guild-level-up-not");
  }
}

function notifyGuildUserProfileUpdated(ctx, requestSocket, user, label) {
  const guildData = getGuildData(ctx, getGuildUid(user));
  if (!guildData) return;
  const payload = buildGuildUserProfileUpdatedNotPayload(user, binaryNow(ctx));
  for (const target of guildData.members) {
    if (getUserUid(target) === getUserUid(user)) continue;
    const socket = findSocketForUser(ctx, requestSocket, target);
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.USER_PROFILE_UPDATED_NOT, payload, label);
  }
}

function notifyGuildData(ctx, requestSocket, guildUid, label, excludedUser = null) {
  const guildData = getGuildData(ctx, guildUid);
  if (!guildData) return;
  const payload = buildGuildDataUpdatedNotPayload(guildData);
  for (const target of guildData.members) {
    if (excludedUser && getUserUid(excludedUser) === getUserUid(target)) continue;
    const socket = requestSocket && requestSocket.session && requestSocket.session.user === target
      ? requestSocket
      : ctx && typeof ctx.findClientSocketByUserUid === "function"
        ? ctx.findClientSocketByUserUid(target.userUid)
        : null;
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.DATA_UPDATED_NOT, payload, label);
  }
}

function findSocketForUser(ctx, requestSocket, user) {
  if (!user) return null;
  if (requestSocket && requestSocket.session && requestSocket.session.user === user) return requestSocket;
  return ctx && typeof ctx.findClientSocketByUserUid === "function"
    ? ctx.findClientSocketByUserUid(getUserUid(user))
    : null;
}

function sendGuildLobbyBootstrap(ctx, socket, user, label = "join-lobby-guild-data") {
  const guildUid = getGuildUid(user);
  if (guildUid <= 0n || !socket || socket.destroyed) return false;
  const guildData = getGuildData(ctx, guildUid);
  if (!guildData) return false;
  if (guildData.guildState === 2 && guildData.closingTime > 0n) {
    if (isGuildClosureDue(ctx, guildData.closingTime)) return deleteClosedGuild(ctx, guildUid, socket, true);
    scheduleGuildDeletion(ctx, guildUid, guildData.closingTime);
  }
  sendPush(ctx, socket, PACKETS.DATA_UPDATED_NOT, buildGuildDataUpdatedNotPayload(guildData), label);
  notifyGuildUserProfileUpdated(ctx, socket, user, `${label}-profile`);
  const messages = getGuildChatMessages(ctx, guildUid).slice(-100);
  if (messages.length > 0) {
    sendPush(ctx, socket, PACKETS.CHAT_LIST_NOT, buildGuildChatListNotPayload(ctx, guildUid, messages), `${label}-chat`);
  }
  return true;
}

function scheduleGuildDeletion(ctx, guildUid, closingTime) {
  if (!ctx || typeof ctx !== "object") return false;
  cancelScheduledGuildDeletion(ctx, guildUid);
  const dueDate = dateFromDateTime(closingTime);
  if (!dueDate) return false;
  const delay = dueDate.getTime() - currentServerDate(ctx).getTime();
  if (delay <= 0) return deleteClosedGuild(ctx, guildUid, null, true);
  let timers = guildDeletionTimers.get(ctx);
  if (!timers) {
    timers = new Map();
    guildDeletionTimers.set(ctx, timers);
  }
  const key = String(toBigInt(guildUid || 0));
  const timer = setTimeout(() => {
    timers.delete(key);
    deleteClosedGuild(ctx, guildUid, null, true);
  }, Math.min(delay, 2147483647));
  if (timer && typeof timer.unref === "function") timer.unref();
  timers.set(key, timer);
  return true;
}

function cancelScheduledGuildDeletion(ctx, guildUid) {
  const timers = ctx && typeof ctx === "object" ? guildDeletionTimers.get(ctx) : null;
  if (!timers) return false;
  const key = String(toBigInt(guildUid || 0));
  const timer = timers.get(key);
  if (!timer) return false;
  clearTimeout(timer);
  timers.delete(key);
  return true;
}

function deleteClosedGuild(ctx, guildUid, requestSocket = null, requireDue = false) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  const guild = getGuildData(ctx, normalizedGuildUid);
  if (!guild || guild.guildState !== 2 || guild.closingTime <= 0n) return false;
  if (requireDue && !isGuildClosureDue(ctx, guild.closingTime)) return false;
  const members = guild.members.slice();
  cancelScheduledGuildDeletion(ctx, normalizedGuildUid);
  for (const member of members) clearGuildMembership(member);
  for (const target of Object.values(ctx && ctx.userDb && ctx.userDb.users || {})) {
    setRelatedGuildUids(target, 0, getRelatedGuildUids(target, 0).filter((value) => value !== normalizedGuildUid));
    setRelatedGuildUids(target, 1, getRelatedGuildUids(target, 1).filter((value) => value !== normalizedGuildUid));
  }
  const payload = buildGuildDeletedNotPayload(normalizedGuildUid);
  for (const member of members) {
    const socket = requestSocket && requestSocket.session && requestSocket.session.user === member
      ? requestSocket
      : findSocketForUser(ctx, null, member);
    if (socket && !socket.destroyed) sendPush(ctx, socket, PACKETS.DELETED_NOT, payload, "guild-deleted");
  }
  persistAndInvalidate(ctx, "guild-deleted");
  return true;
}

function isGuildClosureDue(ctx, closingTime) {
  const closingDate = dateFromDateTime(closingTime);
  return Boolean(closingDate && closingDate.getTime() <= currentServerDate(ctx).getTime());
}

function buildGuildListAckPayload(errorCode, guilds) {
  return Buffer.concat([
    writeSignedVarInt(Number(errorCode || 0)),
    writeNullableObjectList((guilds || []).map(buildGuildListData)),
  ]);
}

function buildGuildRecommendInviteListAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeObjectList((value.list || []).map((user) => writeNullableObject(buildFriendListData(user)))),
  ]);
}

function buildGuildChatAckPayload(result) {
  return Buffer.concat([
    writeSignedVarInt(Number(result && result.errorCode || 0)),
    writeSignedVarLong(toBigInt(result && result.messageUid || 0)),
  ]);
}

function buildGuildChatNotPayload(ctx, message) {
  return writeNullableObject(buildGuildChatMessageData(ctx, message));
}

function buildGuildChatListAckPayload(ctx, result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    buildGuildChatMessageList(ctx, value.messages),
  ]);
}

function buildGuildChatListNotPayload(ctx, guildUid, messages) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(guildUid || 0)),
    buildGuildChatMessageList(ctx, messages),
  ]);
}

function buildGuildChatComplainAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    writeSignedVarLong(toBigInt(value.messageUid || 0)),
  ]);
}

function buildGuildChatBlockMuteNotPayload(user, endDate) {
  return Buffer.concat([
    writeSignedVarLong(getUserUid(user)),
    writeInt64LE(toBigInt(endDate || 0)),
  ]);
}

function buildGuildChatTranslateAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.messageUid || 0)),
    writeString(value.textTranslated || ""),
  ]);
}

function buildGuildChatMessageList(ctx, messages) {
  return writeObjectList((messages || []).map((message) => writeNullableObject(buildGuildChatMessageData(ctx, message))));
}

function buildGuildChatMessageData(ctx, message) {
  const value = message || {};
  const author = findUserByUid(ctx, value.author && value.author.userUid) || value.author || {};
  const muted = getGuildChatMuteEndDate(author) > binaryNow(ctx);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(value.messageUid || 0)),
    writeSignedVarInt(Number(value.messageType || 0)),
    writeNullableObject(buildCommonProfileData(author)),
    writeSignedVarInt(Number(value.emotionId || 0)),
    writeString(value.message || ""),
    writeInt64LE(toBigInt(value.createdAt || 0)),
    writeSignedVarLong(toBigInt(value.typeParam || 0)),
    writeBool(Boolean(value.blocked || muted)),
  ]);
}

function buildGuildListData(guild) {
  const data = guild || {};
  const master = (data.members || []).find((member) => getGuildGrade(member) === 0);
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.guildUid || 0)),
    writeString(data.name || ""),
    writeSignedVarLong(toBigInt(data.badgeId || 0)),
    writeSignedVarInt(Number(data.guildLevel || 1)),
    writeSignedVarInt(Number(data.guildJoinType || 0)),
    writeString(master && master.nickname || ""),
    writeSignedVarInt((data.members || []).length),
    writeString(data.greeting || ""),
  ]);
}

function decodeGuildDataRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.from(encryptedPayload || Buffer.alloc(0));
    const guildUid = readSignedVarLong(payload, 0);
    if (!writeSignedVarLong(guildUid.value).equals(payload.subarray(0, guildUid.offset))) return invalidGuildDataRequest();
    if (guildUid.offset !== payload.length) return invalidGuildDataRequest();
    return { valid: true, guildUid: guildUid.value };
  } catch (_) {
    return invalidGuildDataRequest();
  }
}

function invalidGuildDataRequest() {
  return { valid: false, guildUid: 0n };
}

function getGuildData(ctx, guildUid) {
  const normalizedGuildUid = toBigInt(guildUid || 0);
  const members = getGuildMembers(ctx, normalizedGuildUid, null)
    .slice()
    .sort((left, right) => compareGuildMembers(left, right));
  if (normalizedGuildUid <= 0n || !members.length) return null;

  const metadataSources = members.slice().sort((left, right) => {
    const gradeOrder = getGuildGrade(left) - getGuildGrade(right);
    return gradeOrder || compareBigInts(getUserUid(left), getUserUid(right));
  });
  const progress = members
    .map((member) => getGuildProgress(member))
    .sort((left, right) => right.totalExp - left.totalExp)[0] || { level: 1, exp: 0 };
  const attendanceHistory = getAuthoritativeAttendanceHistory(members);

  return {
    guildUid: normalizedGuildUid,
    name: firstGuildString(metadataSources, ["guildName", "name"], ""),
    badgeId: firstGuildBigInt(metadataSources, ["guildBadgeId", "badgeId"], 0n),
    guildLevel: progress.level,
    guildLevelExp: BigInt(progress.exp),
    guildJoinType: firstGuildEnum(metadataSources, ["guildJoinType", "joinType"], 0, 2, 0),
    guildState: firstGuildEnum(metadataSources, ["guildState", "state"], 0, 2, 1),
    closingTime: firstGuildDateTime(metadataSources, ["guildClosingTime", "closingTime"]),
    greeting: firstGuildString(metadataSources, ["guildGreeting", "greeting"], ""),
    notice: firstGuildString(metadataSources, ["guildNotice", "notice"], ""),
    inviteList: getGuildRelationshipUsers(ctx, normalizedGuildUid, 1),
    joinWaitingList: getGuildRelationshipUsers(ctx, normalizedGuildUid, 0),
    members,
    attendanceList: Object.entries(attendanceHistory)
      .filter(([key, count]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number(count) >= 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => ({
        date: dateTimeBinaryForDateLocal(new Date(`${key}T00:00:00.000Z`)),
        count: Math.max(0, Math.trunc(Number(count) || 0)),
      })),
    unionPoint: getAuthoritativeUnionPoint(ctx, normalizedGuildUid, members[0]),
    dungeonNotice: firstGuildString(metadataSources, ["guildDungeonNotice", "dungeonNotice"], ""),
    chatNoticeType: firstGuildEnum(metadataSources, ["guildChatNoticeType", "chatNoticeType"], 0, 1, 0),
    renameCount: firstGuildInt(metadataSources, ["guildRenameCount", "renameCount"], 0),
    latestRenameDate: firstGuildDateTime(metadataSources, ["guildLatestRenameDate", "latestRenameDate"]),
  };
}

function buildGuildDataAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeSignedVarLong(toBigInt(value.guildUid || 0)),
    value.guildData ? writeNullableObject(buildGuildData(value.guildData)) : writeNullObject(),
  ]);
}

function buildGuildCreateAckPayload(ctx, user, result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeObjectList((value.costItems || []).filter(Boolean).map((item) => writeNullableObject(buildItemMiscData(item)))),
    writeNullableObject(buildGuildData(value.guildData || {})),
    writeNullableObject(buildPrivateGuildData(ctx, user)),
  ]);
}

function buildGuildCloseAckPayload(result) {
  const value = result || {};
  return Buffer.concat([
    writeSignedVarInt(Number(value.errorCode || 0)),
    writeInt64LE(toBigInt(value.closingTime || 0)),
  ]);
}

function buildGuildCloseCancelAckPayload(result) {
  return writeSignedVarInt(Number(result && result.errorCode || 0));
}

function buildGuildDeletedNotPayload(guildUid) {
  return writeSignedVarLong(toBigInt(guildUid || 0));
}

function buildGuildData(value) {
  const data = value || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.guildUid || 0)),
    writeString(data.name || ""),
    writeSignedVarLong(toBigInt(data.badgeId || 0)),
    writeSignedVarInt(Number(data.guildLevel || 1)),
    writeSignedVarLong(toBigInt(data.guildLevelExp || 0)),
    writeSignedVarInt(Number(data.guildJoinType || 0)),
    writeSignedVarInt(Number(data.guildState || 0)),
    writeInt64LE(toBigInt(data.closingTime || 0)),
    writeString(data.greeting || ""),
    writeString(data.notice || ""),
    writeObjectList((data.inviteList || []).map((entry) => writeNullableObject(buildFriendListData(entry)))),
    writeObjectList((data.joinWaitingList || []).map((entry) => writeNullableObject(buildFriendListData(entry)))),
    writeNullableObjectList((data.members || []).map(buildGuildMemberData)),
    writeNullableObjectList((data.attendanceList || []).map(buildGuildAttendanceData)),
    writeSignedVarLong(toBigInt(data.unionPoint || 0)),
    writeString(data.dungeonNotice || ""),
    writeSignedVarInt(Number(data.chatNoticeType || 0)),
    writeSignedVarInt(Number(data.renameCount || 0)),
    writeInt64LE(toBigInt(data.latestRenameDate || 0)),
  ]);
}

function buildGuildMemberData(user) {
  const nested = guildObjects(user);
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeInt64LE(getMemberJoinDate(user, 0n)),
    writeSignedVarInt(getGuildGrade(user)),
    writeInt64LE(firstStoredDateTime(user, nested, ["lastLoginDateBinary", "lastLoginDate", "lastJoinDate", "lastLoginAt", "lastJoinAt", "createdAt"])),
    writeString(firstStoredString(user, nested, ["guildMemberGreeting", "memberGreeting"], "")),
    writeInt64LE(getMemberLastAttendanceDate(user)),
    writeSignedVarLong(firstStoredBigInt(user, nested, ["guildWeeklyContributionPoint", "weeklyContributionPoint"], 0n)),
    writeSignedVarLong(firstStoredBigInt(user, nested, ["guildTotalContributionPoint", "totalContributionPoint"], 0n)),
    writeBool(Boolean(user && (user.hasOffice || user.office))),
  ]);
}

function buildGuildAttendanceData(value) {
  const data = value || {};
  return Buffer.concat([
    writeInt64LE(toBigInt(data.date || 0)),
    writeSignedVarInt(Math.max(0, Number(data.count || 0))),
  ]);
}

function buildFriendListData(user) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeInt64LE(firstStoredDateTime(user, guildObjects(user), ["lastLoginDateBinary", "lastLoginDate", "lastJoinDate", "lastLoginAt", "lastJoinAt", "createdAt"])),
    writeNullableObject(buildGuildSimpleData(user)),
    writeBool(Boolean(user && (user.hasOffice || user.office))),
  ]);
}

function compareGuildMembers(left, right) {
  const gradeOrder = getGuildGrade(left) - getGuildGrade(right);
  return gradeOrder || compareBigInts(getUserUid(left), getUserUid(right));
}

function compareBigInts(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function getUserUid(user) {
  return toBigInt(user && (user.userUid != null ? user.userUid : user.uid) || 0);
}

function guildObjects(user) {
  return [
    user && user.guild && typeof user.guild === "object" ? user.guild : {},
    user && user.guildData && typeof user.guildData === "object" ? user.guildData : {},
  ];
}

function firstGuildString(users, fields, fallback) {
  for (const user of users || []) {
    const value = firstStoredString(user, guildObjects(user), fields, null);
    if (value != null && value !== "") return value;
  }
  return fallback;
}

function firstGuildBigInt(users, fields, fallback) {
  for (const user of users || []) {
    const value = firstStoredValue(user, guildObjects(user), fields);
    if (value != null && toBigInt(value || 0) > 0n) return toBigInt(value);
  }
  return toBigInt(fallback || 0);
}

function firstGuildEnum(users, fields, minimum, maximum, fallback) {
  for (const user of users || []) {
    const value = firstStoredValue(user, guildObjects(user), fields);
    const number = Number(value);
    if (Number.isInteger(number) && number >= minimum && number <= maximum) return number;
  }
  return fallback;
}

function firstGuildInt(users, fields, fallback) {
  for (const user of users || []) {
    const value = firstStoredValue(user, guildObjects(user), fields);
    const number = Number(value);
    if (Number.isInteger(number) && number >= 0) return number;
  }
  return fallback;
}

function firstGuildDateTime(users, fields) {
  for (const user of users || []) {
    const value = firstStoredDateTime(user, guildObjects(user), fields);
    if (value > 0n) return value;
  }
  return 0n;
}

function firstStoredString(user, nestedObjects, fields, fallback) {
  const value = firstStoredValue(user, nestedObjects, fields);
  return value == null ? fallback : String(value);
}

function firstStoredBigInt(user, nestedObjects, fields, fallback) {
  const value = firstStoredValue(user, nestedObjects, fields);
  return nonNegativeBigInt(value == null ? fallback : value);
}

function firstStoredDateTime(user, nestedObjects, fields) {
  const value = firstStoredValue(user, nestedObjects, fields);
  if (value == null || value === "") return 0n;
  if (typeof value === "bigint" || typeof value === "number" || /^\d+$/.test(String(value))) return toBigInt(value);
  const parsed = parseStoredDate(value);
  return parsed ? dateTimeBinaryForDateLocal(parsed) : 0n;
}

function firstStoredValue(user, nestedObjects, fields) {
  for (const field of fields || []) {
    if (user && user[field] != null) return user[field];
    for (const nested of nestedObjects || []) {
      if (nested && nested[field] != null) return nested[field];
    }
  }
  return null;
}

function decodeAttendanceRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.from(encryptedPayload || Buffer.alloc(0));
    const guildUid = readSignedVarLong(payload, 0);
    if (!writeSignedVarLong(guildUid.value).equals(payload.subarray(0, guildUid.offset))) return invalidAttendanceRequest();
    if (guildUid.offset !== payload.length) return invalidAttendanceRequest();
    return { valid: true, guildUid: guildUid.value };
  } catch (_) {
    return invalidAttendanceRequest();
  }
}

function invalidAttendanceRequest() {
  return { valid: false, guildUid: 0n };
}

function decodeDonationRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.from(encryptedPayload || Buffer.alloc(0));
    const guildUid = readSignedVarLong(payload, 0);
    if (!writeSignedVarLong(guildUid.value).equals(payload.subarray(0, guildUid.offset))) return invalidDonationRequest();
    const donationId = readSignedVarInt(payload, guildUid.offset);
    if (!writeSignedVarInt(donationId.value).equals(payload.subarray(guildUid.offset, donationId.offset))) return invalidDonationRequest();
    const donationCount = readSignedVarInt(payload, donationId.offset);
    if (!writeSignedVarInt(donationCount.value).equals(payload.subarray(donationId.offset, donationCount.offset))) return invalidDonationRequest();
    if (donationCount.offset !== payload.length) return invalidDonationRequest();
    return { valid: true, guildUid: guildUid.value, donationId: donationId.value, donationCount: donationCount.value };
  } catch (_) {
    return invalidDonationRequest();
  }
}

function invalidDonationRequest() {
  return { valid: false, guildUid: 0n, donationId: 0, donationCount: 0 };
}

function decodeBuyRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.from(encryptedPayload || Buffer.alloc(0));
    const guildUid = readSignedVarLong(payload, 0);
    if (!writeSignedVarLong(guildUid.value).equals(payload.subarray(0, guildUid.offset))) return invalidBuyRequest();
    const welfareId = readSignedVarInt(payload, guildUid.offset);
    if (!writeSignedVarInt(welfareId.value).equals(payload.subarray(guildUid.offset, welfareId.offset))) return invalidBuyRequest();
    if (welfareId.offset !== payload.length || guildUid.value <= 0n || welfareId.value <= 0) return invalidBuyRequest();
    return { valid: true, guildUid: guildUid.value, welfareId: welfareId.value };
  } catch (_) {
    return invalidBuyRequest();
  }
}

function invalidBuyRequest() {
  return { valid: false, guildUid: 0n, welfareId: 0 };
}

function decodeWelfarePointRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.from(encryptedPayload || Buffer.alloc(0));
    const guildUid = readSignedVarLong(payload, 0);
    if (!writeSignedVarLong(guildUid.value).equals(payload.subarray(0, guildUid.offset))) return invalidWelfarePointRequest();
    const buyCount = readSignedVarInt(payload, guildUid.offset);
    if (!writeSignedVarInt(buyCount.value).equals(payload.subarray(guildUid.offset, buyCount.offset))) return invalidWelfarePointRequest();
    if (buyCount.offset !== payload.length || guildUid.value <= 0n || buyCount.value <= 0) return invalidWelfarePointRequest();
    return { valid: true, guildUid: guildUid.value, buyCount: buyCount.value };
  } catch (_) {
    return invalidWelfarePointRequest();
  }
}

function invalidWelfarePointRequest() {
  return { valid: false, guildUid: 0n, buyCount: 0 };
}

function isStrictEmptyRequest(ctx, encryptedPayload) {
  try {
    const payload = ctx && typeof ctx.decryptCopy === "function"
      ? ctx.decryptCopy(encryptedPayload || Buffer.alloc(0))
      : Buffer.from(encryptedPayload || Buffer.alloc(0));
    return payload.length === 0;
  } catch (_) {
    return false;
  }
}

function purchaseCompanyBuff(ctx, user, request) {
  const ownGuildUid = getGuildUid(user);
  const currentUnionPoint = getAuthoritativeUnionPoint(ctx, ownGuildUid, user);
  if (!user || ownGuildUid <= 0n) return failure(ERRORS.NOT_A_MEMBER, request.guildUid, request.welfareId, currentUnionPoint);
  if (request.guildUid !== ownGuildUid) {
    return failure(ERRORS.INVALID_GUILD_UID, request.guildUid, request.welfareId, currentUnionPoint);
  }

  const tables = loadTables();
  const welfare = tables.welfareById.get(request.welfareId);
  if (!welfare) return failure(ERRORS.INVALID_WELFARE_ID, request.guildUid, request.welfareId, currentUnionPoint);
  if (getGuildLevel(user) < welfare.unlockGuildLevel) {
    return failure(ERRORS.INVALID_WELFARE_ID, request.guildUid, request.welfareId, currentUnionPoint);
  }

  const buffTemplate = tables.buffById.get(welfare.companyBuffId);
  if (!buffTemplate || buffTemplate.enabled === false || buffTemplate.durationMinutes <= 0) {
    return failure(ERRORS.INVALID_WELFARE_ID, request.guildUid, request.welfareId, currentUnionPoint);
  }

  const nowTicks = ticksNow(ctx);
  const guildMembers = getGuildMembers(ctx, ownGuildUid, user);
  const notifyTargets = welfare.category === "GUILD" ? guildMembers : [user];
  if (welfare.category === "GUILD" && getGuildGrade(user) >= 2) {
    return failure(ERRORS.NOT_ENOUGH_GRADE, request.guildUid, request.welfareId, currentUnionPoint);
  }
  if (notifyTargets.some((target) => hasActiveBuffGroup(target, welfare.companyBuffGroupId, tables, nowTicks))) {
    const errorCode = welfare.category === "PERSONAL"
      ? ERRORS.PERSONAL_BUFF_ALREADY_ACTIVATING
      : ERRORS.BUFF_STILL_ACTIVATING;
    return failure(errorCode, request.guildUid, request.welfareId, currentUnionPoint);
  }

  let costItems = [];
  let resourceSpend = null;
  let nextUnionPoint = currentUnionPoint;
  if (welfare.category === "PERSONAL") {
    const balance = getMiscBalance(user, welfare.costItemId);
    if (balance < BigInt(welfare.costValue)) {
      return failure(ERRORS.INSUFFICIENT_RESOURCE, request.guildUid, request.welfareId, currentUnionPoint);
    }
    costItems = [spendMiscItem(user, welfare.costItemId, welfare.costValue)].filter(Boolean);
    resourceSpend = { itemId: welfare.costItemId, count: welfare.costValue };
  } else {
    if (currentUnionPoint < BigInt(welfare.costValue)) {
      return failure(ERRORS.NOT_ENOUGH_UNION_POINT, request.guildUid, request.welfareId, currentUnionPoint);
    }
    nextUnionPoint = currentUnionPoint - BigInt(welfare.costValue);
    for (const target of guildMembers) setGuildUnionPoint(target, nextUnionPoint);
  }

  const buff = {
    companyBuffId: welfare.companyBuffId,
    companyBuffGroupId: welfare.companyBuffGroupId,
    sourceWelfareId: welfare.id,
    expireTicks: String(nowTicks + BigInt(buffTemplate.durationMinutes) * TICKS_PER_MINUTE),
  };
  for (const target of notifyTargets) upsertCompanyBuff(target, buff, tables, nowTicks);

  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: request.guildUid,
    welfareId: request.welfareId,
    costItems,
    unionPoint: nextUnionPoint,
    buff,
    notifyTargets,
    resourceSpend,
  };
}

function donateToGuild(ctx, user, request) {
  const ownGuildUid = getGuildUid(user);
  if (!user || ownGuildUid <= 0n) return donationFailure(ctx, user, ERRORS.NOT_A_MEMBER, request.donationId);
  if (request.guildUid !== ownGuildUid) return donationFailure(ctx, user, ERRORS.INVALID_GUILD_UID, request.donationId);

  const tables = loadTables();
  if (!Number.isInteger(request.donationCount) || request.donationCount <= 0 || request.donationCount > tables.guildConfig.dailyDonationCount) {
    return donationFailure(ctx, user, ERRORS.INVALID_DONATION_COUNT, request.donationId);
  }
  const donation = tables.donationById.get(request.donationId);
  if (!donation) return donationFailure(ctx, user, ERRORS.INVALID_DONATION_ID, request.donationId);

  const nowDate = currentServerDate(ctx);
  const daily = getDonationState(user, nowDate);
  if (isFirstGuildDay(user, nowDate)) {
    return donationFailure(ctx, user, ERRORS.DONATION_JOIN_DATE_LIMIT, request.donationId, daily);
  }
  if (daily.donationCount + request.donationCount > tables.guildConfig.dailyDonationCount) {
    return donationFailure(ctx, user, ERRORS.DONATION_DAILY_LIMIT, request.donationId, daily);
  }

  const totalCost = donation.costValue * request.donationCount;
  if (getMiscBalance(user, donation.costItemId) < BigInt(totalCost)) {
    return donationFailure(ctx, user, ERRORS.INSUFFICIENT_RESOURCE, request.donationId, daily);
  }

  const costItem = spendMiscItem(user, donation.costItemId, totalCost);
  const rewardItems = [];
  for (const reward of donation.rewards) {
    if (reward.itemId === 24 || reward.itemId === 503) continue;
    const item = grantMiscItem(user, reward.itemId, reward.count * request.donationCount);
    if (item) rewardItems.push(item);
  }

  const guildExpDelta = donation.guildExp * request.donationCount;
  const unionPointDelta = donation.unionPoint * request.donationCount;
  const members = getGuildMembers(ctx, ownGuildUid, user);
  const nextUnionPoint = getAuthoritativeUnionPoint(ctx, ownGuildUid, user) + BigInt(unionPointDelta);
  const nextGuildProgress = addGuildExperience(ctx, ownGuildUid, user, guildExpDelta, tables);
  for (const member of members) {
    setGuildUnionPoint(member, nextUnionPoint);
    setGuildProgress(member, nextGuildProgress);
  }
  addGuildContribution(user, guildExpDelta);

  const lastDailyResetDate = binaryNow(ctx);
  const donationCount = daily.donationCount + request.donationCount;
  setDonationState(user, {
    donationCount,
    lastDailyResetDate,
    resetKey: guildDailyResetKey(nowDate),
  });

  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: ownGuildUid,
    donationId: request.donationId,
    donationCount,
    donationCountDelta: request.donationCount,
    lastDailyResetDate,
    costItems: [costItem].filter(Boolean),
    rewardItems,
    guildExpDelta,
    unionPointDelta,
    resourceSpend: { itemId: donation.costItemId, count: totalCost },
    guildProgress: nextGuildProgress,
    unionPoint: nextUnionPoint,
    levelUp: nextGuildProgress.level > nextGuildProgress.previousLevel,
    levelUpTime: binaryNow(ctx),
  };
}

function attendGuild(ctx, user, request) {
  const ownGuildUid = getGuildUid(user);
  if (!user || ownGuildUid <= 0n) return attendanceFailure(ctx, user, ERRORS.NOT_A_MEMBER, request.guildUid);
  if (request.guildUid !== ownGuildUid) return attendanceFailure(ctx, user, ERRORS.INVALID_GUILD_UID, request.guildUid);

  const nowDate = currentServerDate(ctx);
  const nowKey = guildDailyResetKey(nowDate);
  const lastAttendanceDate = getMemberLastAttendanceDate(user);
  if (guildDailyResetKey(parseStoredDate(lastAttendanceDate)) === nowKey) {
    return attendanceFailure(ctx, user, ERRORS.ATTENDANCE_DUPLICATE_REQUEST, request.guildUid);
  }

  const tables = loadTables();
  const members = getGuildMembers(ctx, ownGuildUid, user);
  const history = getAuthoritativeAttendanceHistory(members);
  const yesterdayKey = shiftDateKey(nowKey, -1);
  const yesterdayAttendanceCount = Math.max(0, Number(history[yesterdayKey] || 0));
  const todayAttendanceCount = Math.max(0, Number(history[nowKey] || 0)) + 1;
  history[nowKey] = todayAttendanceCount;
  const prunedHistory = pruneAttendanceHistory(history, nowKey);
  for (const member of members) setGuildAttendanceHistory(member, prunedHistory);

  const rewards = [...tables.attendanceBasicRewards];
  let additional = null;
  for (const row of tables.attendanceAdditionalRewards) {
    if (row.attendanceCount > yesterdayAttendanceCount) break;
    additional = row;
  }
  if (additional) rewards.push(additional);
  const rewardTotals = new Map();
  for (const reward of rewards) rewardTotals.set(reward.itemId, Number(rewardTotals.get(reward.itemId) || 0) + reward.count);
  const rewardItems = [...rewardTotals.entries()]
    .map(([itemId, count]) => grantMiscItem(user, itemId, count))
    .filter(Boolean);

  const guildExpDelta = tables.guildConfig.attendanceExp;
  const nextGuildProgress = addGuildExperience(ctx, ownGuildUid, user, guildExpDelta, tables);
  for (const member of members) setGuildProgress(member, nextGuildProgress);
  addGuildContribution(user, guildExpDelta);

  const attendanceDate = binaryNow(ctx);
  setMemberLastAttendanceDate(user, attendanceDate);
  const memberJoinDate = getMemberJoinDate(user, attendanceDate);
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: request.guildUid,
    lastAttendanceDate: attendanceDate,
    memberJoinDate,
    rewardItems,
    guildExpDelta,
    yesterdayAttendanceCount,
    todayAttendanceCount,
    guildProgress: nextGuildProgress,
    levelUp: nextGuildProgress.level > nextGuildProgress.previousLevel,
    levelUpTime: attendanceDate,
  };
}

function attendanceFailure(ctx, user, errorCode, guildUid) {
  const nowDate = currentServerDate(ctx);
  const nowKey = guildDailyResetKey(nowDate);
  const members = getGuildMembers(ctx, getGuildUid(user), user);
  const history = getAuthoritativeAttendanceHistory(members);
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(guildUid || 0),
    lastAttendanceDate: getMemberLastAttendanceDate(user),
    memberJoinDate: getMemberJoinDate(user, 0n),
    rewardItems: [],
    guildExpDelta: 0,
    yesterdayAttendanceCount: Math.max(0, Number(history[shiftDateKey(nowKey, -1)] || 0)),
    todayAttendanceCount: Math.max(0, Number(history[nowKey] || 0)),
  };
}

function donationFailure(ctx, user, errorCode, donationId, state = null) {
  const daily = state || getDonationState(user, currentServerDate(ctx));
  return {
    changed: false,
    errorCode,
    donationId: Number(donationId || 0),
    donationCount: daily.donationCount,
    donationCountDelta: 0,
    lastDailyResetDate: daily.lastDailyResetDate,
    costItems: [],
    rewardItems: [],
    guildExpDelta: 0,
    unionPointDelta: 0,
    resourceSpend: null,
  };
}

function failure(errorCode, guildUid, welfareId, unionPoint) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(guildUid || 0),
    welfareId: Number(welfareId || 0),
    costItems: [],
    unionPoint: toBigInt(unionPoint || 0),
    buff: null,
    notifyTargets: [],
    resourceSpend: null,
  };
}

function purchaseWelfarePoints(ctx, user, request) {
  const ownGuildUid = getGuildUid(user);
  if (!user || ownGuildUid <= 0n) return welfarePointFailure(ERRORS.NOT_A_MEMBER, request.guildUid);
  if (request.guildUid !== ownGuildUid) return welfarePointFailure(ERRORS.INVALID_GUILD_UID, request.guildUid);
  const config = loadTables().guildConfig;
  if (request.buyCount !== config.welfarePointBuyAmount) {
    return welfarePointFailure(ERRORS.INVALID_REQUEST, request.guildUid);
  }
  const currentPoints = getMiscBalance(user, 23);
  if (currentPoints + BigInt(request.buyCount) > BigInt(config.welfarePointBuyLimit)) {
    return welfarePointFailure(ERRORS.WELFARE_POINT_LIMIT, request.guildUid);
  }
  if (getMiscBalance(user, 101) < BigInt(config.welfarePointPrice)) {
    return welfarePointFailure(ERRORS.INSUFFICIENT_RESOURCE, request.guildUid);
  }
  const costItem = spendMiscItem(user, 101, config.welfarePointPrice);
  const rewardItem = grantMiscItem(user, 23, request.buyCount);
  return {
    changed: true,
    errorCode: ERRORS.OK,
    guildUid: request.guildUid,
    costItems: [costItem].filter(Boolean),
    rewardItems: [rewardItem].filter(Boolean),
    resourceSpend: { itemId: 101, count: config.welfarePointPrice },
  };
}

function welfarePointFailure(errorCode, guildUid) {
  return {
    changed: false,
    errorCode,
    guildUid: toBigInt(guildUid || 0),
    costItems: [],
    rewardItems: [],
    resourceSpend: null,
  };
}

function buildBuyAckPayload(result) {
  const value = result || failure(ERRORS.INVALID_REQUEST, 0n, 0, 0n);
  return Buffer.concat([
    writeSignedVarInt(value.errorCode),
    writeSignedVarLong(value.guildUid),
    writeSignedVarInt(value.welfareId),
    writeNullableObjectList((value.costItems || []).map(buildItemMiscData)),
    value.errorCode === ERRORS.OK ? writeNullableObject(buildRewardData({})) : writeNullObject(),
    writeSignedVarLong(value.unionPoint),
  ]);
}

function buildAttendanceAckPayload(result) {
  const value = result || attendanceFailure(null, null, ERRORS.INVALID_REQUEST, 0n);
  return Buffer.concat([
    writeSignedVarInt(value.errorCode),
    writeSignedVarLong(value.guildUid),
    writeInt64LE(toBigInt(value.lastAttendanceDate || 0)),
    writeInt64LE(toBigInt(value.memberJoinDate || 0)),
    value.errorCode === ERRORS.OK
      ? writeNullableObject(buildRewardData({ miscItems: value.rewardItems || [] }))
      : writeNullObject(),
    writeNullableObject(Buffer.concat([
      writeSignedVarLong(toBigInt(value.guildExpDelta || 0)),
      writeSignedVarLong(0n),
      writeSignedVarLong(0n),
    ])),
    writeSignedVarInt(value.yesterdayAttendanceCount),
    writeSignedVarInt(value.todayAttendanceCount),
  ]);
}

function buildDonationAckPayload(result) {
  const value = result || {
    errorCode: ERRORS.INVALID_REQUEST,
    donationId: 0,
    donationCount: 0,
    lastDailyResetDate: 0n,
    costItems: [],
    rewardItems: [],
    guildExpDelta: 0,
    unionPointDelta: 0,
  };
  return Buffer.concat([
    writeSignedVarInt(value.errorCode),
    writeSignedVarInt(value.donationId),
    writeNullableObjectList((value.costItems || []).map(buildItemMiscData)),
    value.errorCode === ERRORS.OK
      ? writeNullableObject(buildRewardData({ miscItems: value.rewardItems || [] }))
      : writeNullObject(),
    writeNullableObject(Buffer.concat([
      writeSignedVarLong(toBigInt(value.guildExpDelta || 0)),
      writeSignedVarLong(toBigInt(value.unionPointDelta || 0)),
      writeSignedVarLong(0n),
    ])),
    writeSignedVarInt(value.donationCount),
    writeInt64LE(toBigInt(value.lastDailyResetDate || 0)),
  ]);
}

function buildWelfarePointAckPayload(result) {
  const value = result || welfarePointFailure(ERRORS.INVALID_REQUEST, 0n);
  return Buffer.concat([
    writeSignedVarInt(value.errorCode),
    writeSignedVarLong(value.guildUid),
    writeNullableObjectList((value.costItems || []).map(buildItemMiscData)),
    value.errorCode === ERRORS.OK
      ? writeNullableObject(buildRewardData({ miscItems: value.rewardItems || [] }))
      : writeNullObject(),
  ]);
}

function buildCompanyBuffData(buff) {
  return Buffer.concat([
    writeSignedVarInt(Number(buff && buff.companyBuffId || 0)),
    writeSignedVarLong(toBigInt(buff && buff.expireTicks || 0)),
  ]);
}

function buildCompanyBuffAddNotPayload(buff) {
  return writeNullableObject(buildCompanyBuffData(buff));
}

function buildCompanyBuffList(user, options = {}) {
  return writeNullableObjectList(getActiveCompanyBuffs(user, options).map(buildCompanyBuffData));
}

function buildRefreshCompanyBuffAckPayload(user, errorCode = ERRORS.OK, options = {}) {
  return Buffer.concat([
    writeSignedVarInt(errorCode),
    errorCode === ERRORS.OK ? buildCompanyBuffList(user, options) : writeNullableObjectList([]),
  ]);
}

function getActiveCompanyBuffs(user, options = {}) {
  const nowTicks = toBigInt(options.nowTicks != null ? options.nowTicks : ticksNow(options.ctx));
  const source = getStoredCompanyBuffs(user);
  const tables = loadTables();
  return source
    .map(normalizeCompanyBuff)
    .filter((buff) => {
      const template = tables.buffById.get(buff.companyBuffId);
      return template && template.enabled !== false && toBigInt(buff.expireTicks) > nowTicks;
    })
    .sort((left, right) => left.companyBuffId - right.companyBuffId);
}

function pruneExpiredCompanyBuffs(user, options = {}) {
  if (!user || typeof user !== "object") return false;
  const source = getStoredCompanyBuffs(user);
  if (!source.length) return false;
  const active = getActiveCompanyBuffs(user, options);
  if (active.length === source.length && active.every((buff, index) => sameStoredBuff(buff, source[index]))) return false;
  user.companyBuffs = active;
  if (Array.isArray(user.companyBuffDataList)) user.companyBuffDataList = active.map((buff) => ({ ...buff }));
  return true;
}

function upsertCompanyBuff(user, buff, tables = loadTables(), nowTicks = ticksNow()) {
  if (!user || typeof user !== "object") return;
  const next = getActiveCompanyBuffs(user, { nowTicks })
    .filter((entry) => getBuffGroupId(entry, tables) !== Number(buff.companyBuffGroupId));
  next.push(normalizeCompanyBuff(buff));
  next.sort((left, right) => left.companyBuffId - right.companyBuffId);
  user.companyBuffs = next;
  if (Array.isArray(user.companyBuffDataList)) user.companyBuffDataList = next.map((entry) => ({ ...entry }));
}

function hasActiveBuffGroup(user, groupId, tables = loadTables(), nowTicks = ticksNow()) {
  return getActiveCompanyBuffs(user, { nowTicks }).some((buff) => getBuffGroupId(buff, tables) === Number(groupId));
}

function getBuffGroupId(buff, tables) {
  const direct = Number(buff && (buff.companyBuffGroupId || buff.groupId) || 0);
  if (direct > 0) return direct;
  return Number(tables.groupByBuffId.get(Number(buff && buff.companyBuffId || 0)) || 0);
}

function getStoredCompanyBuffs(user) {
  if (!user || typeof user !== "object") return [];
  if (Array.isArray(user.companyBuffs)) return user.companyBuffs;
  if (Array.isArray(user.companyBuffDataList)) return user.companyBuffDataList;
  return [];
}

function normalizeCompanyBuff(value) {
  const buff = value && typeof value === "object" ? value : {};
  return {
    companyBuffId: Number(buff.companyBuffId != null ? buff.companyBuffId : buff.id || buff.Id || 0),
    companyBuffGroupId: Number(buff.companyBuffGroupId != null ? buff.companyBuffGroupId : buff.groupId || 0),
    sourceWelfareId: Number(buff.sourceWelfareId || buff.welfareId || 0),
    expireTicks: String(toBigInt(buff.expireTicks != null ? buff.expireTicks : buff.ExpireTicks || 0)),
  };
}

function sameStoredBuff(left, right) {
  const normalized = normalizeCompanyBuff(right);
  return left.companyBuffId === normalized.companyBuffId &&
    left.companyBuffGroupId === normalized.companyBuffGroupId &&
    left.sourceWelfareId === normalized.sourceWelfareId &&
    left.expireTicks === normalized.expireTicks;
}

function loadTables() {
  if (cachedTables) return cachedTables;
  const donationById = new Map();
  const welfareById = new Map();
  const buffById = new Map();
  const groupByBuffId = new Map();
  const attendanceBasicRewards = [];
  const attendanceAdditionalRewards = [];
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_ATTENDANCE_TEMPLET.json")) {
    const condition = String(row && row.m_RewardCond || "");
    const type = String(row && row.m_RewardType || "");
    const itemId = Number(row && row.m_RewardID || 0);
    const count = Number(row && row.m_RewardValue || 0);
    if (type !== "RT_MISC" || itemId <= 0 || !Number.isInteger(count) || count <= 0) continue;
    if (condition === "ATTENDANCE_GUILD_GENERAL") attendanceBasicRewards.push({ itemId, count });
    if (condition === "ATEENDANCE_GUILD_MEMBER_CNT") {
      const attendanceCount = Number(row && row.m_RewardCondValue || 0);
      if (Number.isInteger(attendanceCount) && attendanceCount > 0) attendanceAdditionalRewards.push({ attendanceCount, itemId, count });
    }
  }
  attendanceAdditionalRewards.sort((left, right) => left.attendanceCount - right.attendanceCount);
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_DONATION_TEMPLET.json")) {
    const id = Number(row && row.ID || 0);
    const costItemId = Number(row && row.m_DonateRequireItemID || 0);
    const costValue = Number(row && row.m_DonateRequireItemValue || 0);
    const rewards = [];
    for (let index = 1; index <= 10; index += 1) {
      const type = String(row && row[`m_RewardType_${index}`] || "");
      const itemId = Number(row && row[`m_RewardID_${index}`] || 0);
      const count = Number(row && row[`m_RewardValue_${index}`] || 0);
      if (!type) break;
      if (type === "RT_MISC" && itemId > 0 && Number.isInteger(count) && count > 0) rewards.push({ itemId, count });
    }
    const guildExp = Number(rewards.find((reward) => reward.itemId === 503)?.count || 0);
    const unionPoint = Number(rewards.find((reward) => reward.itemId === 24)?.count || 0);
    if (id > 0 && costItemId > 0 && Number.isInteger(costValue) && costValue > 0 && guildExp > 0 && unionPoint > 0) {
      donationById.set(id, { id, costItemId, costValue, rewards, guildExp, unionPoint });
    }
  }
  for (const row of readGameplayTableRecords("ab_script", "LUA_COMPANY_BUFF_TEMPLET.json")) {
    const id = Number(row && row.m_CompanyBuffID || 0);
    if (id <= 0 || buffById.has(id)) continue;
    buffById.set(id, {
      id,
      durationMinutes: Math.max(0, Number(row.m_CompanyBuffTime || 0)),
      enabled: row.m_Enabled !== false,
    });
  }
  for (const row of readGameplayTableRecords("ab_script", "LUA_GUILD_WELFARE_TEMPLET.json")) {
    const id = Number(row && row.ID || 0);
    const category = String(row && row.m_WelfareCategory || "").toUpperCase();
    const companyBuffId = Number(row && row.m_CompanyBuffID || 0);
    const companyBuffGroupId = Number(row && row.m_CompanyBuffGroupID || 0);
    const costItemId = Number(row && row.m_WelfareRequireItemID || 0);
    const costValue = Number(row && row.m_WelfareRequireItemValue || 0);
    if (id <= 0 || !["PERSONAL", "GUILD"].includes(category) || companyBuffId <= 0 || companyBuffGroupId <= 0 || costItemId <= 0 || costValue <= 0) continue;
    welfareById.set(id, {
      id,
      category,
      companyBuffId,
      companyBuffGroupId,
      costItemId,
      costValue,
      unlockGuildLevel: String(row.m_UnlockReqType || "") === "SURT_GUILD_LEVEL"
        ? Math.max(1, Number(row.m_UnlockReqValue || 1))
        : 1,
    });
    groupByBuffId.set(companyBuffId, companyBuffGroupId);
  }
  const guildBadgeFrameIds = visibleGuildBadgeIds("LUA_GUILD_BADGE_FRAME_TEMPLET.json");
  const guildBadgeColorIds = visibleGuildBadgeIds("LUA_GUILD_BADGE_COLOR_TEMPLET.json");
  const guildBadgeMarkIds = visibleGuildBadgeIds("LUA_GUILD_BADGE_MARK_TEMPLET.json");
  const guildNameFilterWords = [...new Set([
    ...readGameplayTableRecords("ab_script", "LUA_BAD_CHAT_FILTER_TEMPLET.json"),
    ...readGameplayTableRecords("ab_script", "LUA_BAD_GUILD_NAME_FILTER_TEMPLET.json"),
  ]
    .filter((row) => !Array.isArray(row && row.listContentsTagAllow)
      || row.listContentsTagAllow.includes("GLOBAL")
      || row.listContentsTagAllow.includes("NAEU"))
    .map((row) => String(row && row.WORD || "").toUpperCase())
    .filter((word) => word && word.length <= 16 && Array.from(word).every((character) => isValidGlobalGuildNameCode(character.charCodeAt(0)))))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const common = readGameplayTable("ab_script", "LUA_COMMON_CONST.json");
  const guild = common && common.globals && common.globals.Guild || {};
  const creation = guild.Creation && typeof guild.Creation === "object" ? guild.Creation : {};
  const guildConfig = {
    creationUserMinLevel: Math.max(1, Number(creation.UserMinLevel || 0)),
    creationCosts: (Array.isArray(creation.ReqMiscItems) ? creation.ReqMiscItems : [])
      .map((cost) => ({ itemId: Number(cost && cost.ItemId || 0), count: Number(cost && cost.ItemCount || 0) }))
      .filter((cost) => Number.isInteger(cost.itemId) && cost.itemId > 0 && Number.isInteger(cost.count) && cost.count > 0),
    closingDelayHours: Math.max(0, Number(guild.ClosingDelayHour || 0)),
    attendanceExp: Math.max(1, Number(guild.AttendanceExp || 0)),
    dailyDonationCount: Math.max(1, Number(guild.DailyDonationCount || 0)),
    exitPenaltyHours: Math.max(0, Number(guild.ExitPenaltyHour || 0)),
    maxJoinRequestCount: Math.max(1, Number(guild.MaxJoinRequestCount || 0)),
    maxInviteCount: Math.max(1, Number(guild.MaxInviteCount || 0)),
    maxRequestReceiveCount: Math.max(1, Number(guild.MaxInviteCount || 0)),
    maxStaffCount: Math.max(1, Number(guild.MaxStaffCount || 0)),
    firstJoinReward: {
      itemId: Math.max(0, Number(guild.FirstJoinReward && guild.FirstJoinReward.MiscItemId || 0)),
      count: Math.max(0, Number(guild.FirstJoinReward && guild.FirstJoinReward.MiscItemCount || 0)),
      title: String(guild.FirstJoinReward && guild.FirstJoinReward.PostTitle || ""),
      contents: String(guild.FirstJoinReward && guild.FirstJoinReward.PostContent || ""),
      expireDays: Math.max(1, Number(guild.FirstJoinReward && guild.FirstJoinReward.PostExpireDay || 1)),
    },
    welfarePointBuyAmount: Math.max(1, Number(guild.WelfarePointBuyAmount || 0)),
    welfarePointBuyLimit: Math.max(1, Number(guild.WelfarePointBuyLimit || 0)),
    welfarePointPrice: Math.max(1, Number(guild.WelfarePointPrice || 0)),
  };
  const guildRenameConfig = {
    freeCount: Math.max(0, Number(guild.ConsortiumNameChangeFree || 0)),
    limitDays: Math.max(1, Number(guild.ConsortiumNameChangeLimitDay || 1)),
    resourceItemId: Math.max(1, Number(guild.ConsortiumNameChangeResourceItemID || 0)),
    resourceValue: Math.max(1, Number(guild.ConsortiumNameChangeResourceValue || 0)),
  };
  const guildChatConfig = {
    complainCountToBlock: Math.max(1, Number(guild.ChatComplainCountToBlock || 0)),
    autoBlockHours: Math.max(1, Number(guild.ChatAutoBlockHour || 0)),
  };
  const guildExpRows = readGameplayTableRecords("ab_script", "LUA_GUILD_EXP_TEMPLET.json")
    .map((row) => ({
      level: Number(row && row.m_GuildLv || 0),
      required: Math.max(0, Number(row && row.m_GuildExpRequired || 0)),
      maxMemberCount: Math.max(1, Number(row && row.m_GuildLvPersonCapacity || 0)),
    }))
    .filter((row) => Number.isInteger(row.level) && row.level > 0 && Number.isInteger(row.required) && row.required > 0)
    .sort((left, right) => left.level - right.level);
  cachedTables = {
    attendanceBasicRewards,
    attendanceAdditionalRewards,
    donationById,
    welfareById,
    buffById,
    groupByBuffId,
    guildExpRows,
    guildConfig,
    guildRenameConfig,
    guildChatConfig,
    guildBadgeFrameIds,
    guildBadgeColorIds,
    guildBadgeMarkIds,
    guildNameFilterWords,
  };
  return cachedTables;
}

function visibleGuildBadgeIds(fileName) {
  return new Set(readGameplayTableRecords("ab_script", fileName)
    .filter((row) => row && row.m_LockbVisible !== false)
    .map((row) => Number(row && row.ID || 0))
    .filter((id) => Number.isInteger(id) && id > 0));
}

function getGuildUid(user) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  return toBigInt(user && user.guildUid != null ? user.guildUid : nested.guildUid || 0);
}

function getGuildLevel(user) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  return Math.max(1, Number(user && user.guildLevel != null ? user.guildLevel : nested.guildLevel || nested.level || 1));
}

function getGuildGrade(user) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  const raw = user && user.guildMemberGrade != null
    ? user.guildMemberGrade
    : nested.memberGrade != null
      ? nested.memberGrade
      : nested.grade;
  if (typeof raw === "string") {
    const value = raw.toUpperCase();
    if (value === "MASTER") return 0;
    if (value === "STAFF") return 1;
    return 2;
  }
  const grade = Number(raw);
  return Number.isInteger(grade) && grade >= 0 && grade <= 2 ? grade : 2;
}

function getGuildMembers(ctx, guildUid, fallbackUser) {
  const users = Object.values(ctx && ctx.userDb && ctx.userDb.users || {});
  const members = users.filter((target) => target && getGuildUid(target) === guildUid);
  if (fallbackUser && !members.includes(fallbackUser)) members.push(fallbackUser);
  return members;
}

function getAuthoritativeUnionPoint(ctx, guildUid, fallbackUser) {
  if (guildUid <= 0n) return getGuildUnionPoint(fallbackUser);
  return getGuildMembers(ctx, guildUid, fallbackUser)
    .reduce((highest, user) => {
      const value = getGuildUnionPoint(user);
      return value > highest ? value : highest;
    }, 0n);
}

function getGuildUnionPoint(user) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  return nonNegativeBigInt(user && user.guildUnionPoint != null ? user.guildUnionPoint : nested.unionPoint || 0);
}

function setGuildUnionPoint(user, value) {
  if (!user || typeof user !== "object") return;
  const normalized = String(nonNegativeBigInt(value));
  user.guildUnionPoint = normalized;
  if (user.guild && typeof user.guild === "object") user.guild.unionPoint = normalized;
}

function getDonationState(user, nowDate = new Date()) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  const stored = user && user.guildDonation && typeof user.guildDonation === "object" ? user.guildDonation : {};
  const storedCount = Math.max(0, Number(
    stored.donationCount != null
      ? stored.donationCount
      : user && user.guildDonationCount != null
        ? user.guildDonationCount
        : nested.donationCount || 0
  ));
  const storedDate = stored.lastDailyResetDate != null
    ? stored.lastDailyResetDate
    : user && user.guildDonationLastDailyResetDate != null
      ? user.guildDonationLastDailyResetDate
      : nested.lastDailyResetDate || 0;
  const currentKey = guildDailyResetKey(nowDate);
  const storedKey = String(stored.resetKey || "") || guildDailyResetKey(parseStoredDate(storedDate));
  return {
    donationCount: storedKey && storedKey === currentKey ? storedCount : 0,
    lastDailyResetDate: toBigInt(storedDate || 0),
    resetKey: storedKey,
  };
}

function setDonationState(user, state) {
  if (!user || typeof user !== "object") return;
  const value = {
    donationCount: Math.max(0, Number(state && state.donationCount || 0)),
    lastDailyResetDate: String(toBigInt(state && state.lastDailyResetDate || 0)),
    resetKey: String(state && state.resetKey || ""),
  };
  user.guildDonation = value;
  user.guildDonationCount = value.donationCount;
  user.guildDonationLastDailyResetDate = value.lastDailyResetDate;
  if (user.guild && typeof user.guild === "object") {
    user.guild.donationCount = value.donationCount;
    user.guild.lastDailyResetDate = value.lastDailyResetDate;
  }
}

function isFirstGuildDay(user, nowDate) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  const joinedAt = user && (user.guildMemberCreatedAt || user.guildJoinedAt) || nested.memberCreatedAt || nested.joinedAt || "";
  const joinedDate = parseStoredDate(joinedAt);
  return Boolean(joinedDate && guildDailyResetKey(joinedDate) === guildDailyResetKey(nowDate));
}

function addGuildExperience(ctx, guildUid, fallbackUser, delta, tables = loadTables()) {
  const members = getGuildMembers(ctx, guildUid, fallbackUser);
  let source = members
    .map((member) => getGuildProgress(member, tables))
    .sort((left, right) => right.totalExp - left.totalExp)[0] || getGuildProgress(fallbackUser, tables);
  let level = source.level;
  let exp = source.exp + Math.max(0, Number(delta || 0));
  const maxLevel = tables.guildExpRows.length ? tables.guildExpRows[tables.guildExpRows.length - 1].level : level;
  while (level < maxLevel) {
    const row = tables.guildExpRows.find((entry) => entry.level === level);
    if (!row || exp < row.required) break;
    exp -= row.required;
    level += 1;
  }
  const maxRow = tables.guildExpRows.find((entry) => entry.level === level);
  if (level >= maxLevel && maxRow) exp = Math.min(exp, maxRow.required);
  return { level, exp, totalExp: absoluteGuildExp(level, exp, tables), previousLevel: source.level };
}

function getGuildProgress(user, tables = loadTables()) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  const level = Math.max(1, Number(user && user.guildLevel != null ? user.guildLevel : nested.guildLevel || nested.level || 1));
  const exp = Math.max(0, Number(user && user.guildLevelExp != null ? user.guildLevelExp : nested.guildLevelExp || nested.exp || 0));
  return { level, exp, totalExp: absoluteGuildExp(level, exp, tables) };
}

function absoluteGuildExp(level, exp, tables = loadTables()) {
  let total = Math.max(0, Number(exp || 0));
  for (const row of tables.guildExpRows) {
    if (row.level >= level) break;
    total += row.required;
  }
  return total;
}

function setGuildProgress(user, progress) {
  if (!user || typeof user !== "object") return;
  user.guildLevel = progress.level;
  user.guildLevelExp = String(progress.exp);
  if (user.guild && typeof user.guild === "object") {
    user.guild.guildLevel = progress.level;
    user.guild.guildLevelExp = String(progress.exp);
  }
}

function addGuildContribution(user, amount) {
  if (!user || typeof user !== "object") return;
  const nested = user.guild && typeof user.guild === "object" ? user.guild : {};
  const weekly = nonNegativeBigInt(user.guildWeeklyContributionPoint != null ? user.guildWeeklyContributionPoint : nested.weeklyContributionPoint || 0) + BigInt(amount);
  const total = nonNegativeBigInt(user.guildTotalContributionPoint != null ? user.guildTotalContributionPoint : nested.totalContributionPoint || 0) + BigInt(amount);
  user.guildWeeklyContributionPoint = String(weekly);
  user.guildTotalContributionPoint = String(total);
  if (user.guild && typeof user.guild === "object") {
    user.guild.weeklyContributionPoint = String(weekly);
    user.guild.totalContributionPoint = String(total);
  }
}

function getMemberLastAttendanceDate(user) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  return toBigInt(
    user && user.guildLastAttendanceDate != null
      ? user.guildLastAttendanceDate
      : nested.lastAttendanceDate || 0
  );
}

function setMemberLastAttendanceDate(user, value) {
  if (!user || typeof user !== "object") return;
  const normalized = String(toBigInt(value || 0));
  user.guildLastAttendanceDate = normalized;
  if (user.guild && typeof user.guild === "object") user.guild.lastAttendanceDate = normalized;
}

function getMemberJoinDate(user, fallback) {
  const nested = user && user.guild && typeof user.guild === "object" ? user.guild : {};
  const stored = user && (user.guildMemberCreatedAt || user.guildJoinedAt) || nested.memberCreatedAt || nested.joinedAt || user && user.createdAt;
  const date = parseStoredDate(stored);
  if (date) return toBigInt(dateTimeBinaryForDateLocal(date));
  return toBigInt(fallback || 0);
}

function getAuthoritativeAttendanceHistory(members) {
  const result = {};
  const derived = {};
  for (const member of members || []) {
    const nested = member && member.guild && typeof member.guild === "object" ? member.guild : {};
    const source = member && member.guildAttendanceHistory && typeof member.guildAttendanceHistory === "object"
      ? member.guildAttendanceHistory
      : nested.attendanceHistory && typeof nested.attendanceHistory === "object"
        ? nested.attendanceHistory
        : {};
    for (const [key, value] of Object.entries(source)) {
      const count = Math.max(0, Number(value || 0));
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) result[key] = Math.max(Number(result[key] || 0), count);
    }
    const attendanceKey = guildDailyResetKey(parseStoredDate(getMemberLastAttendanceDate(member)));
    if (attendanceKey) derived[attendanceKey] = Number(derived[attendanceKey] || 0) + 1;
  }
  for (const [key, count] of Object.entries(derived)) result[key] = Math.max(Number(result[key] || 0), count);
  return result;
}

function setGuildAttendanceHistory(user, history) {
  if (!user || typeof user !== "object") return;
  user.guildAttendanceHistory = { ...history };
  if (user.guild && typeof user.guild === "object") user.guild.attendanceHistory = { ...history };
}

function pruneAttendanceHistory(history, currentKey) {
  const minimum = shiftDateKey(currentKey, -14);
  return Object.fromEntries(Object.entries(history || {}).filter(([key]) => key >= minimum && key <= currentKey));
}

function getMiscBalance(user, itemId) {
  const inventory = user && user.inventory && typeof user.inventory === "object" ? user.inventory : {};
  const misc = inventory.misc && typeof inventory.misc === "object" ? inventory.misc : {};
  const value = misc[String(itemId)];
  if (value && typeof value === "object") {
    return nonNegativeBigInt(value.countFree != null ? value.countFree : value.count) + nonNegativeBigInt(value.countPaid);
  }
  return nonNegativeBigInt(value);
}

function nonNegativeBigInt(value) {
  const result = toBigInt(value || 0);
  return result > 0n ? result : 0n;
}

function ticksNow(ctx) {
  if (ctx && typeof ctx.dateTimeTicksNow === "function") return toBigInt(ctx.dateTimeTicksNow());
  return BigInt(Date.now()) * 10000n + DOTNET_TICKS_AT_UNIX_EPOCH;
}

function binaryNow(ctx) {
  if (ctx && typeof ctx.dateTimeBinaryNow === "function") return toBigInt(ctx.dateTimeBinaryNow());
  return ticksNow(ctx) | 0x4000000000000000n;
}

function currentServerDate(ctx) {
  if (ctx && typeof ctx.getServerNowDate === "function") {
    const value = ctx.getServerNowDate();
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  }
  return new Date();
}

function guildDailyResetKey(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
  if (!date) return "";
  const shifted = new Date(date.getTime() - 4 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function parseStoredDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value && !/^\d+$/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return dateFromDateTime(value);
}

function dateTimeBinaryForDateLocal(date) {
  return BigInt(date.getTime()) * 10000n + DOTNET_TICKS_AT_UNIX_EPOCH | 0x4000000000000000n;
}

function shiftDateKey(key, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ""))) return "";
  const date = new Date(`${key}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function sendResponse(ctx, socket, packet, packetId, payload, label) {
  if (ctx && typeof ctx.sendGameResponse === "function") ctx.sendGameResponse(socket, packet, packetId, payload, label);
}

function sendPush(ctx, socket, packetId, payload, label) {
  if (ctx && typeof ctx.sendServerGamePacket === "function") ctx.sendServerGamePacket(socket, packetId, payload, label);
}

function persist(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function persistAndInvalidate(ctx, label) {
  persist(ctx);
  if (ctx && typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") {
    ctx.invalidateJoinLobbyAckPayloadCache(label);
  }
}

function trackResourceSpend(ctx, user, spend) {
  if (!spend || !ctx || typeof ctx.trackMissionEvent !== "function") return;
  ctx.trackMissionEvent(user, "USE_RESOURCE", spend.count, {
    itemId: spend.itemId,
    resourceId: spend.itemId,
    value: spend.itemId,
  });
}

function trackDonationMissions(ctx, user, result) {
  trackResourceSpend(ctx, user, result && result.resourceSpend);
  if (!result || !ctx || typeof ctx.trackMissionEvent !== "function") return;
  ctx.trackMissionEvent(user, "GUILD_DONATE", result.donationCountDelta, {
    donationId: result.donationId,
    value: result.donationId,
  });
}

module.exports = {
  PACKETS,
  ERRORS,
  attendGuild,
  buildAttendanceAckPayload,
  buildDonationAckPayload,
  buildBuyAckPayload,
  buildCompanyBuffAddNotPayload,
  buildCompanyBuffData,
  buildCompanyBuffList,
  buildGuildCloseAckPayload,
  buildGuildCloseCancelAckPayload,
  buildGuildCreateAckPayload,
  buildGuildData,
  buildGuildDataAckPayload,
  buildGuildDataUpdatedNotPayload,
  buildGuildLevelUpNotPayload,
  buildGuildUserProfileUpdatedNotPayload,
  buildGuildJoinDisableTimeUpdatedNotPayload,
  buildGuildDeletedNotPayload,
  buildGuildBanAckPayload,
  buildGuildBanNotPayload,
  buildGuildCancelJoinAckPayload,
  buildGuildAcceptInviteAckPayload,
  buildGuildAcceptJoinAckPayload,
  buildGuildAcceptJoinNotPayload,
  buildGuildCancelInviteAckPayload,
  buildGuildCancelRequestNotPayload,
  buildGuildJoinAckPayload,
  buildGuildInviteAckPayload,
  buildGuildInviteNotPayload,
  buildGuildExitAckPayload,
  buildGuildListAckPayload,
  buildGuildListData,
  buildGuildRecommendInviteListAckPayload,
  buildGuildChatAckPayload,
  buildGuildChatNotPayload,
  buildGuildChatListAckPayload,
  buildGuildChatListNotPayload,
  buildGuildChatComplainAckPayload,
  buildGuildChatBlockMuteNotPayload,
  buildGuildChatTranslateAckPayload,
  buildGuildChatMessageData,
  buildGuildMemberGradeUpdatedNotPayload,
  buildGuildSetMemberGradeAckPayload,
  buildGuildMasterMigrationAckPayload,
  buildGuildMasterSpecifiedMigrationNotPayload,
  buildGuildUpdateDataAckPayload,
  buildGuildUpdateNoticeAckPayload,
  buildGuildUpdateMemberGreetingAckPayload,
  buildGuildUpdateNoticeNotPayload,
  buildGuildRenameAckPayload,
  buildGuildRenameNotPayload,
  buildPrivateGuildData,
  buildRefreshCompanyBuffAckPayload,
  buildWelfarePointAckPayload,
  createCompanyBuffHandlers,
  createGuild,
  closeGuild,
  cancelGuildClosure,
  decodeBuyRequest,
  decodeAttendanceRequest,
  decodeDonationRequest,
  decodeGuildCreateRequest,
  decodeGuildDataRequest,
  decodeGuildAcceptInviteRequest,
  decodeGuildAcceptJoinRequest,
  decodeGuildBanRequest,
  decodeGuildInviteRequest,
  decodeGuildJoinRequest,
  decodeGuildListRequest,
  decodeGuildSearchRequest,
  decodeGuildSetMemberGradeRequest,
  decodeGuildMasterMigrationRequest,
  decodeGuildMasterSpecifiedMigrationRequest,
  decodeGuildUpdateDataRequest,
  decodeGuildTextRequest,
  decodeGuildRenameRequest,
  decodeGuildChatRequest,
  decodeGuildChatComplainRequest,
  decodeGuildChatTranslateRequest,
  decodeWelfarePointRequest,
  getActiveCompanyBuffs,
  getGuildData,
  getGuildDirectory,
  hasActiveBuffGroup,
  isStrictEmptyRequest,
  listRelatedGuilds,
  listRecommendedGuildInvites,
  listGuildChat,
  loadTables,
  pruneExpiredCompanyBuffs,
  purchaseCompanyBuff,
  acceptGuildInvite,
  acceptGuildJoin,
  cancelGuildJoin,
  cancelGuildInvite,
  donateToGuild,
  deleteClosedGuild,
  joinGuild,
  inviteGuildMember,
  migrateGuildMaster,
  migrateGuildMasterSpecified,
  updateGuildData,
  updateGuildNotice,
  updateGuildMemberGreeting,
  renameGuild,
  sendGuildChat,
  complainGuildChat,
  translateGuildChat,
  getGuildChatMuteEndDate,
  banGuildMember,
  exitGuild,
  purchaseWelfarePoints,
  searchGuilds,
  setGuildMemberGrade,
  sendGuildLobbyBootstrap,
};
