const fs = require("fs");
const path = require("path");
const {
  writeString,
  writeBool,
  writeByte,
  writeInt64LE,
  writeDoubleLE,
  writeFloatLE,
  writeVarInt,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  buildRewardData,
  dateTimeBinaryNow,
  readSignedVarInt,
  readString,
  toBigInt,
} = require("../packet-codec");
const { buildMissionDataEntries, ensureAccountProgress } = require("../account-progression");
const { MISSION_UPDATE_NOT, buildMissionUpdateNotPayload } = require("../mission");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const schemaPath = path.join(ROOT_DIR, "packet-schema.json");
let cachedSchema = null;

function createHydratedAckHandler(packetId, options = {}) {
  const schema = loadSchema();
  const requestPacket = getPacket(schema, packetId);
  const ackPacket = getPacket(schema, options.ackPacketId || packetId + 1);
  if (!requestPacket) throw new Error(`missing packet schema for request packetId=${packetId}`);
  if (!ackPacket) throw new Error(`missing packet schema for ack packetId=${options.ackPacketId || packetId + 1}`);

  const name = normalizePacketName(requestPacket.name);
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      const payload = buildHydratedAckPayload(ctx, socket, ackPacket);
      console.log(`[hydrate:${name}] ACK packetId=${ackPacket.id} payloadSize=${payload.length}`);
      ctx.sendResponse(socket, packet.sequence, ackPacket.id, () =>
        ctx.buildEncryptedPacket(packet.sequence, ackPacket.id, payload)
      );
      if (typeof options.onHandled === "function") {
        try {
          options.onHandled(ctx, socket, packet, { requestPacket, ackPacket, name });
        } catch (err) {
          console.log(`[hydrate:${name}] onHandled failed: ${err.message}`);
        }
      }
      return true;
    },
  };
}

function createHydratedAckHandlers(packetIds) {
  return packetIds.map((packetId) => createHydratedAckHandler(packetId));
}

function createMissionTrackingHydratedAckHandler(packetId, conditions, options = {}) {
  return createHydratedAckHandler(packetId, {
    ...options,
    onHandled(ctx, socket, packet, meta) {
      trackHydratedMissionConditions(ctx, socket, conditions);
      if (typeof options.onHandled === "function") options.onHandled(ctx, socket, packet, meta);
    },
  });
}

function trackHydratedMissionConditions(ctx, socket, conditions) {
  const user = socket && socket.session && socket.session.user;
  if (!user || !ctx || typeof ctx.trackMissionEvent !== "function") return;
  const clock = ctx.getMissionClockOptions ? ctx.getMissionClockOptions() : { now: ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow() };
  const now = clock.now;
  const eventDateKey = clock.eventDateKey || "";
  const changedConditions = new Set();
  for (const condition of Array.isArray(conditions) ? conditions : [conditions]) {
    const normalized = String(condition || "").trim();
    if (!normalized) continue;
    if (ctx.trackMissionEvent(user, normalized, 1, { now })) changedConditions.add(normalized);
  }
  if (changedConditions.size > 0 && typeof ctx.refreshMissionProgress === "function") {
    ctx.refreshMissionProgress(user, { now, eventDateKey, conditions: Array.from(changedConditions) });
    sendHydratedMissionUpdate(ctx, socket, user, now, Array.from(changedConditions), eventDateKey);
    if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  }
}

function sendHydratedMissionUpdate(ctx, socket, user, now, conditions = [], eventDateKey = "") {
  if (ctx && typeof ctx.sendMissionUpdateForTabs === "function") {
    ctx.sendMissionUpdateForTabs(socket, user, [2, 3], { now, eventDateKey, conditions, label: "mission-update" });
    return;
  }
  if (!ctx || typeof ctx.sendServerGamePacket !== "function" || !socket || !socket.session || !socket.session.gameReplay) return;
  const seen = new Set();
  const missions = [];
  for (const tabId of [2, 3]) {
    for (const [, mission] of buildMissionDataEntries(user, { tabId, now, eventDateKey, conditions })) {
      const key = `${Number(mission.groupId || 0)}:${Number(mission.missionID || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      missions.push(mission);
    }
  }
  if (missions.length > 0) {
    ctx.sendServerGamePacket(socket, MISSION_UPDATE_NOT, buildMissionUpdateNotPayload(missions), "mission-update");
  }
}

function createLoginLikeHydratedHandler(packetId, options = {}) {
  const schema = loadSchema();
  const requestPacket = getPacket(schema, packetId);
  const ackPacketId = options.ackPacketId || 203;
  const ackPacket = getPacket(schema, ackPacketId);
  if (!requestPacket) throw new Error(`missing packet schema for request packetId=${packetId}`);
  if (!ackPacket) throw new Error(`missing packet schema for login ack packetId=${ackPacketId}`);

  const name = normalizePacketName(requestPacket.name);
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      const user = getOrCreateHydratedLoginUser(ctx, socket, packet, { ...options, name, ackPacketId });
      ctx.setLastEffectiveAccessToken && ctx.setLastEffectiveAccessToken(user.accessToken || "");
      if (typeof ctx.prepareUserLobbySession === "function") {
        ctx.prepareUserLobbySession(user, { source: name, force: true });
      }
      console.log(`[hydrate:${name}] login-like ACK packetId=${ackPacketId} uid=${user.userUid || "(ephemeral)"}`);
      ctx.sendResponse(socket, packet.sequence, ackPacketId, () => {
        const capturedAck =
          ctx.capturedTcpResponses && typeof ctx.capturedTcpResponses.get === "function"
            ? ctx.capturedTcpResponses.get(ackPacketId)
            : null;
        const officialLoginTemplate =
          ackPacketId === 230
            ? ctx.capturedTcpProfiles && ctx.capturedTcpProfiles.gamebaseLoginAck
            : ctx.capturedTcpProfiles && ctx.capturedTcpProfiles.loginAck;
        if (
          ackPacketId === 230 &&
          ctx.config &&
          ctx.config.REPLAY_CAPTURED_LOGIN_ACK &&
          (capturedAck || officialLoginTemplate) &&
          typeof ctx.buildCapturedGamebaseLoginAck === "function"
        ) {
          return ctx.buildCapturedGamebaseLoginAck(packet.sequence, user);
        }
        if (ackPacketId === 203 && ctx.config && ctx.config.REPLAY_CAPTURED_LOGIN_ACK && (capturedAck || officialLoginTemplate)) {
          return ctx.buildCapturedLoginAck(packet.sequence, user);
        }
        const payload = ctx.buildLoginLikePayload ? ctx.buildLoginLikePayload(user) : buildHydratedAckPayload(ctx, socket, ackPacket);
        const finalPayload = ackPacketId === 230 ? Buffer.concat([payload, writeSignedVarInt(0)]) : payload;
        return ctx.buildEncryptedPacket(packet.sequence, ackPacketId, finalPayload);
      });
      return true;
    },
  };
}

function buildHydratedAckPayload(ctx, socket, ackPacket) {
  const fields = Array.isArray(ackPacket.fields) ? ackPacket.fields : [];
  return Buffer.concat(fields.map((field) => writeFieldDefault(ctx, socket, field)));
}

function writeFieldDefault(ctx, socket, field) {
  if (field.name === "errorCode") return writeSignedVarInt(0);
  return writeWireDefault(ctx, socket, field.wire, field.name);
}

function writeWireDefault(ctx, socket, wire, fieldName) {
  if (!wire || !wire.kind) return Buffer.alloc(0);
  switch (wire.kind) {
    case "primitive":
      return writePrimitiveDefault(ctx, wire.type);
    case "enum":
      return writeSignedVarInt(0);
    case "list":
    case "hashSet":
    case "dictionary":
    case "array":
    case "byteArray":
      return writeVarInt(0);
    case "object":
      return writeObjectDefault(ctx, socket, wire.type, fieldName);
    default:
      return Buffer.alloc(0);
  }
}

function writePrimitiveDefault(ctx, type) {
  switch (type) {
    case "bool":
      return writeBool(false);
    case "sbyte":
    case "byte":
      return writeByte(0);
    case "short":
    case "int":
      return writeSignedVarInt(0);
    case "long":
      return writeSignedVarLong(0n);
    case "float":
      return writeFloatLE(0);
    case "double":
      return writeDoubleLE(0);
    case "string":
      return writeString("");
    case "DateTime":
      return writeInt64LE(toBigInt(ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : dateTimeBinaryNow()));
    case "TimeSpan":
      return writeInt64LE(0n);
    default:
      return writeSignedVarInt(0);
  }
}

function writeObjectDefault(ctx, socket, type, fieldName) {
  const builder = OBJECT_BUILDERS[type];
  if (!builder) return writeNullObject();
  return writeNullableObject(builder(ctx, socket, fieldName));
}

const OBJECT_BUILDERS = {
  NKMRewardData() {
    return buildRewardData({});
  },
  NKMUserProfileData(ctx, socket) {
    const user = getSocketUser(ctx, socket);
    return buildUserProfileData(user);
  },
  NKMSupportUnitData() {
    return Buffer.concat([writeSignedVarLong(0n), writeNullObject(), writeSignedVarLong(0n)]);
  },
};

function getSocketUser(ctx, socket) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  return ctx && typeof ctx.createEphemeralUser === "function" ? ctx.createEphemeralUser() : {};
}

function getOrCreateHydratedLoginUser(ctx, socket, packet, options = {}) {
  if (socket && socket.session && socket.session.user) return socket.session.user;
  let user = null;
  const isGamebaseLogin = options.ackPacketId === 230 || options.authSource === "guest";
  if (ctx.config && ctx.config.USE_LOCAL_USER_DB && isGamebaseLogin && typeof ctx.getOrCreateUserForGuest === "function") {
    const loginReq = decodeGamebaseLoginReq(ctx, packet && packet.payload);
    user = ctx.getOrCreateUserForGuest(loginReq);
    if (typeof ctx.issueUserTokens === "function") ctx.issueUserTokens(user, loginReq.accessToken || "");
    if (typeof ctx.prepareTutorialLogin === "function") ctx.prepareTutorialLogin(user);
    if (typeof ctx.saveUserDb === "function") ctx.saveUserDb();
    console.log(
      `[hydrate:${options.name || "GAMEBASE_LOGIN_REQ"}] guest login deviceUid=${JSON.stringify(
        loginReq.deviceUid || ""
      )} userId=${JSON.stringify(loginReq.userId || "")} idp=${JSON.stringify(loginReq.idpCode || "guest")}`
    );
  } else if (ctx.config && ctx.config.USE_LOCAL_USER_DB && typeof ctx.getOrCreateUserForSteam === "function") {
    user = ctx.getOrCreateUserForSteam({
      accountId: "hydrated-login:default",
      deviceUid: "hydrated-login:default",
      accessToken: "",
    });
    if (typeof ctx.issueUserTokens === "function") ctx.issueUserTokens(user, "");
    if (typeof ctx.prepareTutorialLogin === "function") ctx.prepareTutorialLogin(user);
    if (typeof ctx.saveUserDb === "function") ctx.saveUserDb();
  } else {
    user = ctx.createEphemeralUser ? ctx.createEphemeralUser() : {};
  }
  if (socket && socket.session) socket.session.user = user;
  return user;
}

function decodeGamebaseLoginReq(ctx, payload) {
  const fallback = {
    protocolVersion: 0,
    mobileData: {},
    deviceUid: "gamebase-guest:default",
    userId: "",
    accessToken: "",
    idpCode: "guest",
  };
  try {
    const decrypted = ctx && typeof ctx.decryptCopy === "function" ? ctx.decryptCopy(payload) : Buffer.from(payload || []);
    let offset = 0;
    const protocolVersion = readSignedVarInt(decrypted, offset);
    offset = protocolVersion.offset;
    const mobileData = readNkmUserMobileData(decrypted, offset);
    offset = mobileData.offset;
    const deviceUid = readString(decrypted, offset);
    offset = deviceUid.offset;
    const userId = readString(decrypted, offset);
    offset = userId.offset;
    const accessToken = readString(decrypted, offset);
    offset = accessToken.offset;
    const idpCode = readString(decrypted, offset);
    return {
      protocolVersion: protocolVersion.value,
      mobileData: mobileData.value,
      deviceUid: deviceUid.value || fallback.deviceUid,
      userId: userId.value || "",
      accessToken: accessToken.value || "",
      idpCode: idpCode.value || "guest",
    };
  } catch (err) {
    console.log(`[hydrate:GAMEBASE_LOGIN_REQ] decode failed: ${err.message}`);
    return fallback;
  }
}

function readNkmUserMobileData(buffer, offset) {
  const hasValue = offset < buffer.length ? buffer.readUInt8(offset) !== 0 : false;
  offset += 1;
  if (!hasValue) return { value: {}, offset };
  const names = ["marketId", "country", "language", "authPlatform", "platform", "osVersion", "adId", "clientVersion"];
  const value = {};
  for (const name of names) {
    const field = readString(buffer, offset);
    offset = field.offset;
    value[name] = field.value || "";
  }
  return { value, offset };
}

function buildUserProfileData(user) {
  user = ensureAccountProgress(user || {}) || {};
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeString(String(user.friendIntro || "")),
    writeNullObject(),
    writeNullObject(),
    writeNullObject(),
    writeNullObject(),
    writeNullObject(),
    writeNullObject(),
    writeObjectList([]),
    writeSignedVarInt(Number(user.selfiFrameId || user.frameId || 0) || 0),
    writeNullObject(),
    writeBool(false),
    writeSignedVarInt(0),
  ]);
}

function buildCommonProfileData(user) {
  user = ensureAccountProgress(user || {}) || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeSignedVarLong(toBigInt(user.friendCode || 0)),
    writeString(user.nickname || "LocalAdmin"),
    writeSignedVarInt(Number(user.level || 1) || 1),
    writeSignedVarInt(Number(user.mainUnitId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitSkinId || 0) || 0),
    writeSignedVarInt(Number(user.frameId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitTacticLevel || 0) || 0),
    writeSignedVarInt(Number(user.titleId || 0) || 0),
  ]);
}

function normalizePacketName(name) {
  return String(name || "")
    .replace(/^NKMPacket_/, "")
    .replace(/^NKMPacket/i, "")
    .toUpperCase();
}

function loadSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  return cachedSchema;
}

function getPacket(schema, packetId) {
  return schema.packets && schema.packets[String(packetId)];
}

module.exports = {
  createHydratedAckHandler,
  createHydratedAckHandlers,
  createMissionTrackingHydratedAckHandler,
  createLoginLikeHydratedHandler,
  buildHydratedAckPayload,
};
