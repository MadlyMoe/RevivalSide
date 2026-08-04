const { ensureLoginRewardPosts } = require("../modules/admin");
const { ensureAttendanceRewardPosts } = require("../modules/attendance");
const { applyLocalAccountCleanup } = require("../modules/local-cleanup");

module.exports = {
  packetId: 231,
  name: "STEAM_LOGIN_REQ",
  handle(ctx, socket, packet) {
    const loginReq = ctx.decodeSteamLoginReq(packet.payload);
    socket.session.steamLogin = loginReq;

    if (ctx.config.USE_LOCAL_USER_DB) {
      const user = ctx.getOrCreateUserForSteam(loginReq);
      ctx.issueUserTokens(user, loginReq.accessToken);
      socket.session.user = user;
      ctx.setLastEffectiveAccessToken(user.accessToken || "");
      ctx.prepareTutorialLogin(user);
      const cleanup = applyLocalAccountCleanup(user, ctx.config);
      let rewardPosts = 0;
      let attendancePosts = 0;
      if (typeof ctx.prepareUserLobbySession === "function") {
        const prepared = ctx.prepareUserLobbySession(user, { source: "steam-login" });
        rewardPosts = Number(prepared.rewardPosts || 0);
        attendancePosts = Number(prepared.attendancePosts || 0);
      } else {
        const missionClock = ctx.getMissionClockOptions
          ? ctx.getMissionClockOptions()
          : { now: ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined };
        try {
          ctx.recordMissionLogin(user, missionClock);
        } catch (error) {
          console.log(`[mission-login] skipped steam login update: ${error && error.message ? error.message : error}`);
        }
        const serverNow = ctx.getServerNowDate ? ctx.getServerNowDate() : new Date();
        rewardPosts = ensureLoginRewardPosts(user, { now: serverNow });
        attendancePosts = ensureAttendanceRewardPosts(user, { now: serverNow, clockNow: serverNow });
        ctx.saveUserDb();
      }
      if (cleanup.changed) {
        console.log(
          `[user-db] cleanup uid=${user.userUid} missionStatus=${cleanup.missionStatus || 0} unitsLevel1=${cleanup.unitsLevel1} gearUnenhanced=${cleanup.gearUnenhanced} shipsLevel1=${cleanup.shipsLevel1} operatorsLevel1=${cleanup.operatorsLevel1}`
        );
      }
      console.log(
        `[user-db] login uid=${user.userUid} friendCode=${user.friendCode} nickname=${JSON.stringify(user.nickname)} loginKey=${JSON.stringify(user.steamLoginKey || user.steamAccountId || "")} tokenLen=${(user.accessToken || "").length} inboxRewardPosts=${rewardPosts + attendancePosts}`
      );
    }

    ctx.sendResponse(socket, packet.sequence, ctx.constants.LOGIN_ACK, () => {
      const captured = ctx.capturedTcpResponses.get(ctx.constants.LOGIN_ACK);
      const officialTemplate = ctx.capturedTcpProfiles && ctx.capturedTcpProfiles.loginAck;
      if (ctx.config.REPLAY_CAPTURED_LOGIN_ACK && (captured || officialTemplate)) {
        return ctx.buildCapturedLoginAck(packet.sequence, socket.session.user);
      }
      if (captured) {
        console.log(`[official-compare] packetId=${ctx.constants.LOGIN_ACK} using local payload instead of captured official payloadSize=${captured.payload.length}`);
      }
      return ctx.buildLoginAck(packet.sequence, socket.session.user);
    });
    if (socket.session.user && typeof ctx.prewarmJoinLobbyAckPayload === "function") {
      try {
        const cached = typeof ctx.takePrewarmedJoinLobbyAckPayload === "function"
          ? ctx.takePrewarmedJoinLobbyAckPayload(socket.session.user, { consume: false })
          : null;
        if (!cached) ctx.prewarmJoinLobbyAckPayload(socket.session.user, { source: "steam-login" });
      } catch (error) {
        console.log(`[JOIN_LOBBY_ACK warm-cache] steam login skipped: ${error && error.message ? error.message : error}`);
      }
    }
    return true;
  },
};
