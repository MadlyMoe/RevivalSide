const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const {
  writeBool,
  writeByte,
  writeSignedVarInt,
  writeSignedVarLong,
  writeString,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeNullableObjectList,
  buildDeckIndexData,
  readBool,
  readByte,
  readSignedVarInt,
  readSignedVarLong,
  readString,
} = require("../packet-codec");
const { buildUserProfileData, buildDummyDeckData } = require("../profile");
const { createPrivatePvpRelayClient } = require("./relay-client");

const PACKETS = Object.freeze({
  CREATE_ACK: 4101,
  READY_ACK: 4103,
  INVITE_ACK: 4105,
  CANCEL_INVITE_ACK: 4108,
  ACCEPT_INVITE_ACK: 4111,
  EXIT_ACK: 4114,
  CHANGE_ROLE_ACK: 4116,
  SYNC_DECK_INDEX_ACK: 4118,
  SEARCH_USER_ACK: 4120,
  CHANGE_OPTION_ACK: 4122,
  ACCEPT_CODE_ACK: 4124,
  KICK_ACK: 4126,
  KICK_NOT: 4127,
  CANCEL_NOT: 4128,
  CONFIG_NOT: 4129,
  START_GAME_SETTING_ACK: 4131,
  STATE_NOT: 4132,
  DRAFT_GIVEUP_ACK: 4134,
  DRAFT_GIVEUP_NOT: 4135,
  STATE_ACK: 4137,
});

const ERRORS = Object.freeze({
  OK: 0,
  INVALID_TARGET: 20762,
  NOT_IN_ROOM: 20770,
  NOT_JOINED: 20771,
  ROOM_FULL: 22308,
  CODE_NOT_FOUND: 27301,
});

const LOBBY_MATCHING = 6;
const PLAYER_A = 1;
const PLAYER_B = 3;
const PRIVATE_PVP_OPEN_TAGS = Object.freeze(["PVP_FRIENDLY_MODE", "PVP_PRIVATE_ROOM"]);
const MAX_JOIN_BYTES = 2 * 1024 * 1024;

function createPrivatePvpManager(options = {}) {
  const rooms = new Map();
  const tickets = new Map();
  const enabled = options.enabled !== false;
  const publicHost = String(options.publicHost || "127.0.0.1");
  const publicPort = Number(options.publicPort || 22000) || 22000;
  const peerHostUrl = String(options.peerHostUrl || "").trim();
  const logger = typeof options.logger === "function" ? options.logger : console.log;
  const relayClient = createPrivatePvpRelayClient({
    relayUrl: options.relayUrl,
    secret: options.relaySecret,
    hostId: options.relayHostId,
    role: options.relayRole,
    localGamePort: options.localGamePort || publicPort,
    allowInsecureLoopback: options.allowInsecureRelayLoopback,
    logger,
    async onJoin(code, user) {
      const result = reserveRemote(code, user);
      if (!result.errorCode && typeof options.onRoomChanged === "function") options.onRoomChanged(result.room);
      return result;
    },
  });
  if (relayClient.enabled && relayClient.role === "host") void relayClient.startHost();

  function createRoom(socket, user, request = {}) {
    leave(socket, null, { quiet: true });
    let code;
    do code = crypto.randomBytes(4).toString("hex").toUpperCase(); while (rooms.has(code));
    const room = {
      code,
      config: normalizeConfig(request.config),
      observerMode: false,
      state: LOBBY_MATCHING,
      members: [],
      replay: null,
      matchStarted: false,
      battleStarted: false,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    attachMember(room, socket, user, { host: true, teamType: PLAYER_A });
    logger(`[private-pvp] created room=${code} host=${user && user.userUid || 0}`);
    if (relayClient.enabled && relayClient.role === "host") {
      void relayClient.registerRoom(code).catch((error) => logger(`[private-pvp] relay room registration failed: ${error.message}`));
    }
    return room;
  }

  function attachMember(room, socket, user, memberOptions = {}) {
    if (!room || !user) return null;
    let member = room.members.find((entry) => String(entry.user.userUid) === String(user.userUid));
    if (!member) {
      if (room.members.filter((entry) => !entry.observer).length >= 2) return null;
      member = {
        user,
        socket: null,
        host: Boolean(memberOptions.host),
        observer: Boolean(memberOptions.observer),
        teamType: Number(memberOptions.teamType || nextTeamType(room)),
        ready: false,
        loaded: false,
        playerState: 1,
        deckIndex: normalizeDeckIndex(user.pvp && user.pvp.privateLobbyDeckIndex),
        disconnectedAt: 0,
      };
      room.members.push(member);
    }
    if (socket) {
      member.socket = socket;
      member.disconnectedAt = 0;
      socket.session.privatePvpRoom = room;
      socket.session.privatePvpMember = member;
      socket.session.privatePvpTeamType = member.teamType;
      if (room.replay) socket.session.gameReplay = room.replay;
    }
    return member;
  }

  function reserveRemote(code, projectedUser) {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.matchStarted) return { errorCode: ERRORS.CODE_NOT_FOUND };
    if (room.members.filter((entry) => !entry.observer).length >= 2) return { errorCode: ERRORS.ROOM_FULL };
    const user = remapGuestProjection(projectedUser, room);
    if (!user) return { errorCode: ERRORS.INVALID_TARGET };
    const member = attachMember(room, null, user, { teamType: PLAYER_B });
    if (!member) return { errorCode: ERRORS.ROOM_FULL };
    const ticket = `pvp-${crypto.randomBytes(24).toString("base64url")}`;
    tickets.set(ticket, { room, member, expiresAt: Date.now() + 120000 });
    logger(`[private-pvp] reserved room=${room.code} guest=${user.userUid}`);
    return { errorCode: 0, room, member, accessToken: ticket, serverIp: publicHost, port: publicPort };
  }

  function consumeJoinTicket(accessToken, socket) {
    purgeTickets();
    const ticket = tickets.get(String(accessToken || ""));
    if (!ticket) return null;
    ticket.expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    attachMember(ticket.room, socket, ticket.member.user, { teamType: ticket.member.teamType });
    return ticket;
  }

  function reattachUser(user, socket) {
    if (!user || !socket) return null;
    for (const room of rooms.values()) {
      const member = room.members.find((entry) => String(entry.user.userUid) === String(user.userUid) && !entry.socket);
      if (!member) continue;
      attachMember(room, socket, member.user, { teamType: member.teamType });
      return { room, member };
    }
    return null;
  }

  function joinLocal(code, socket, user) {
    const room = rooms.get(normalizeCode(code));
    if (!room || room.matchStarted) return { errorCode: ERRORS.CODE_NOT_FOUND };
    if (room.members.filter((entry) => !entry.observer).length >= 2) return { errorCode: ERRORS.ROOM_FULL };
    const member = attachMember(room, socket, user, { teamType: PLAYER_B });
    return member ? { errorCode: 0, room, member, serverIp: "", port: 0, accessToken: "" } : { errorCode: ERRORS.ROOM_FULL };
  }

  function leave(socket, ctx, leaveOptions = {}) {
    const room = socket && socket.session && socket.session.privatePvpRoom;
    const member = socket && socket.session && socket.session.privatePvpMember;
    if (!room || !member) return false;
    room.members = room.members.filter((entry) => entry !== member);
    clearSocketRoom(socket);
    if (room.members.length === 0 || member.host) {
      for (const other of room.members) {
        if (ctx && other.socket && !other.socket.destroyed) {
          ctx.sendServerGamePacket(other.socket, PACKETS.CANCEL_NOT, Buffer.concat([
            writeSignedVarLong(BigInt(member.user.userUid || 0)),
            writeSignedVarInt(7),
          ]), "private-pvp-host-left");
          clearSocketRoom(other.socket);
        }
      }
      rooms.delete(room.code);
      for (const [token, ticket] of tickets) if (ticket.room === room) tickets.delete(token);
    } else if (ctx) {
      broadcastState(room, ctx);
    }
    if (!leaveOptions.quiet) logger(`[private-pvp] left room=${room.code} uid=${member.user.userUid}`);
    return true;
  }

  function handleSocketClose(socket, ctx) {
    const room = socket && socket.session && socket.session.privatePvpRoom;
    const member = socket && socket.session && socket.session.privatePvpMember;
    if (!room || !member) return false;
    member.socket = null;
    member.disconnectedAt = Date.now();
    if (!room.matchStarted) return leave(socket, ctx);
    clearSocketRoom(socket);
    logger(`[private-pvp] disconnected room=${room.code} uid=${member.user.userUid} reconnect=available`);
    return true;
  }

  function buildLobbyData(room) {
    // The shipped NKCUIGauntletPrivateRoom always indexes users[0] and users[1].
    // Preserve both nullable slots even while the room has only one player.
    const playerSlots = getPlayerSlots(room);
    return Buffer.concat([
      writeSignedVarInt(Number(room && room.state || LOBBY_MATCHING)),
      writeBool(Boolean(room && room.observerMode)),
      writeNullableObject(buildConfig(room && room.config)),
      writeObjectList(playerSlots.map((member) => member ? writeNullableObject(buildLobbyUserState(member)) : writeNullObject())),
      writeNullableObjectList((room ? room.members : []).filter((entry) => entry.observer).map(buildLobbyUserState)),
      writeString(room && room.code || ""),
    ]);
  }

  function getPlayerSlots(room) {
    const slots = [null, null];
    for (const member of room ? room.members : []) {
      if (member.observer) continue;
      slots[member.teamType === PLAYER_B ? 1 : 0] = member;
    }
    return slots;
  }

  function buildLobbyUserState(member) {
    return Buffer.concat([
      writeNullableObject(buildUserProfileData(member.user)),
      writeBool(Boolean(member.ready)),
      writeBool(Boolean(member.host)),
      writeNullableObject(buildDeckIndexData(member.deckIndex)),
      writeNullableObject(buildDummyDeckData(member.user, member.deckIndex)),
      writeSignedVarInt(Number(member.playerState || 1)),
    ]);
  }

  function broadcastState(room, ctx) {
    if (!room || !ctx) return;
    const payload = writeNullableObject(buildLobbyData(room));
    broadcast(room, ctx, PACKETS.STATE_NOT, payload, "private-pvp-state");
  }

  function broadcast(room, ctx, packetId, payload, label, options = {}) {
    if (!room || !ctx) return 0;
    let count = 0;
    for (const member of room.members) {
      const socket = member.socket;
      if (!socket || socket.destroyed || (options.except && options.except === socket)) continue;
      ctx.sendServerGamePacket(socket, packetId, payload, label);
      count += 1;
    }
    return count;
  }

  async function requestRemoteJoin(code, user) {
    if (relayClient.enabled && relayClient.role === "join") {
      try { return await relayClient.requestJoin(normalizeCode(code), projectUser(user)); }
      catch (error) { return { errorCode: ERRORS.CODE_NOT_FOUND, error: error.message }; }
    }
    if (!peerHostUrl) return { errorCode: ERRORS.CODE_NOT_FOUND, error: "CS_PVP_HOST_URL is not configured" };
    const target = new URL("/private-pvp/join", peerHostUrl);
    const body = Buffer.from(JSON.stringify({ code: normalizeCode(code), user: projectUser(user) }));
    const transport = target.protocol === "https:" ? https : http;
    return new Promise((resolve) => {
      const req = transport.request(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": body.length },
        timeout: 5000,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_JOIN_BYTES) chunks.push(chunk);
          else req.destroy(new Error("private PvP join response is too large"));
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve(parsed && typeof parsed === "object" ? parsed : { errorCode: ERRORS.CODE_NOT_FOUND });
          } catch (error) {
            resolve({ errorCode: ERRORS.CODE_NOT_FOUND, error: error.message });
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("private PvP host timed out")));
      req.on("error", (error) => resolve({ errorCode: ERRORS.CODE_NOT_FOUND, error: error.message }));
      req.end(body);
    });
  }

  async function handleHttpJoin(req, res) {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    if (requestUrl.pathname !== "/private-pvp/join") return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { errorCode: ERRORS.CODE_NOT_FOUND, error: "POST required" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const result = reserveRemote(body.code, body.user);
      sendJson(res, result.errorCode ? 404 : 200, {
        errorCode: result.errorCode,
        serverIp: result.serverIp || "",
        port: result.port || 0,
        accessToken: result.accessToken || "",
      });
      if (!result.errorCode && typeof options.onRoomChanged === "function") options.onRoomChanged(result.room);
    } catch (error) {
      sendJson(res, 400, { errorCode: ERRORS.CODE_NOT_FOUND, error: error.message });
    }
    return true;
  }

  function getRoom(socket) {
    return socket && socket.session && socket.session.privatePvpRoom || null;
  }

  function getMember(socket) {
    return socket && socket.session && socket.session.privatePvpMember || null;
  }

  function setReplay(room, replay) {
    room.replay = replay;
    for (const member of room.members) if (member.socket) member.socket.session.gameReplay = replay;
  }

  function purgeTickets() {
    const now = Date.now();
    for (const [token, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(token);
  }

  return {
    enabled,
    packets: PACKETS,
    errors: ERRORS,
    createRoom,
    joinLocal,
    reserveRemote,
    consumeJoinTicket,
    reattachUser,
    requestRemoteJoin,
    handleHttpJoin,
    handleSocketClose,
    leave,
    attachMember,
    getRoom,
    getMember,
    getPlayerSlots,
    buildLobbyData,
    broadcastState,
    broadcast,
    setReplay,
    normalizeCode,
    normalizeConfig,
    normalizeDeckIndex,
    rooms,
    relayClient,
  };
}

function buildConfig(config) {
  const value = normalizeConfig(config);
  return Buffer.concat([
    writeBool(value.applyEquipStat),
    writeBool(value.applyAllUnitMaxLevel),
    writeBool(value.applyBanUpSystem),
    writeBool(value.draftBanMode),
  ]);
}

function normalizeConfig(config) {
  const value = config && typeof config === "object" ? config : {};
  return {
    applyEquipStat: value.applyEquipStat !== false,
    applyAllUnitMaxLevel: Boolean(value.applyAllUnitMaxLevel),
    applyBanUpSystem: Boolean(value.applyBanUpSystem),
    draftBanMode: Boolean(value.draftBanMode),
  };
}

function normalizeDeckIndex(deckIndex) {
  const value = deckIndex && typeof deckIndex === "object" ? deckIndex : {};
  return { deckType: Number(value.deckType != null ? value.deckType : 1) || 1, index: Number(value.index || 0) & 0xff };
}

function nextTeamType(room) {
  return room.members.some((entry) => entry.teamType === PLAYER_A) ? PLAYER_B : PLAYER_A;
}

function clearSocketRoom(socket) {
  if (!socket || !socket.session) return;
  delete socket.session.privatePvpRoom;
  delete socket.session.privatePvpMember;
  delete socket.session.privatePvpTeamType;
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

function projectUser(user) {
  const source = user && typeof user === "object" ? user : {};
  return JSON.parse(JSON.stringify({
    userUid: String(source.userUid || "0"),
    friendCode: String(source.friendCode || "0"),
    nickname: String(source.nickname || "Guest").slice(0, 32),
    level: Number(source.level || 1),
    mainUnitId: Number(source.mainUnitId || 0),
    mainUnitSkinId: Number(source.mainUnitSkinId || 0),
    mainUnitTacticLevel: Number(source.mainUnitTacticLevel || 0),
    frameId: Number(source.frameId || source.selfiFrameId || 0),
    selfiFrameId: Number(source.selfiFrameId || source.frameId || 0),
    titleId: Number(source.titleId || 0),
    friendIntro: String(source.friendIntro || "").slice(0, 120),
    profileEmblems: Array.isArray(source.profileEmblems) ? source.profileEmblems.slice(0, 20) : [],
    profileDeckIndex: source.profileDeckIndex || null,
    pvp: source.pvp || {},
    army: source.army || {},
    inventory: { equips: source.inventory && source.inventory.equips || {} },
  }));
}

function remapGuestProjection(input, room) {
  if (!input || typeof input !== "object") return null;
  const user = projectUser(input);
  const occupied = new Set(room.members.map((entry) => String(entry.user.userUid)));
  if (occupied.has(String(user.userUid)) || !/^\d+$/.test(String(user.userUid))) {
    user.userUid = String(800000000000n + BigInt(`0x${crypto.randomBytes(5).toString("hex")}`));
  }
  user.friendCode = String(user.friendCode || user.userUid).replace(/\D/g, "").slice(-12) || String(user.userUid).slice(-12);
  const uidMap = new Map();
  let nextUid = BigInt(user.userUid) * 1000n;
  const allocate = (oldUid) => {
    const key = String(oldUid || "0");
    if (key === "0" || key === "-1") return key;
    if (!uidMap.has(key)) uidMap.set(key, String(++nextUid));
    return uidMap.get(key);
  };
  const army = user.army && typeof user.army === "object" ? user.army : {};
  for (const collectionName of ["units", "ships", "operators"]) {
    const collection = army[collectionName] && typeof army[collectionName] === "object" ? army[collectionName] : {};
    const remapped = {};
    for (const [key, value] of Object.entries(collection)) {
      if (!value || typeof value !== "object") continue;
      const uid = allocate(value.unitUid || value.uid || value.operatorUid || key);
      value.unitUid = uid;
      if (value.uid != null) value.uid = uid;
      if (value.operatorUid != null) value.operatorUid = uid;
      remapped[uid] = value;
    }
    army[collectionName] = remapped;
  }
  const equips = user.inventory && user.inventory.equips && typeof user.inventory.equips === "object" ? user.inventory.equips : {};
  const remappedEquips = {};
  for (const [key, value] of Object.entries(equips)) {
    if (!value || typeof value !== "object") continue;
    const uid = allocate(value.itemUid || value.equipUid || value.uid || key);
    if (value.itemUid != null) value.itemUid = uid;
    if (value.equipUid != null) value.equipUid = uid;
    if (value.uid != null) value.uid = uid;
    remappedEquips[uid] = value;
  }
  user.inventory.equips = remappedEquips;
  for (const decks of Object.values(army.deckSets || {})) {
    for (const deck of Array.isArray(decks) ? decks : []) {
      deck.shipUid = allocate(deck.shipUid);
      deck.operatorUid = allocate(deck.operatorUid);
      deck.unitUids = Array.isArray(deck.unitUids) ? deck.unitUids.map(allocate) : [];
    }
  }
  for (const unit of Object.values(army.units || {})) {
    if (Array.isArray(unit.equipItemUids)) unit.equipItemUids = unit.equipItemUids.map(allocate);
    if (Array.isArray(unit.equipUids)) unit.equipUids = unit.equipUids.map(allocate);
  }
  user.army = army;
  return user;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JOIN_BYTES) {
        reject(new Error("request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

function createReader(buffer) {
  let offset = 0;
  return {
    bool() { const result = readBool(buffer, offset); offset = result.offset; return result.value; },
    byte() { const result = readByte(buffer, offset); offset = result.offset; return result.value; },
    int() { const result = readSignedVarInt(buffer, offset); offset = result.offset; return result.value; },
    long() { const result = readSignedVarLong(buffer, offset); offset = result.offset; return result.value; },
    string() { const result = readString(buffer, offset); offset = result.offset; return result.value; },
    deckIndex() {
      if (!this.bool()) return { deckType: 1, index: 0 };
      return { deckType: this.int(), index: this.byte() };
    },
    config() {
      if (!this.bool()) return normalizeConfig();
      return { applyEquipStat: this.bool(), applyAllUnitMaxLevel: this.bool(), applyBanUpSystem: this.bool(), draftBanMode: this.bool() };
    },
  };
}

module.exports = {
  createPrivatePvpManager,
  createReader,
  projectUser,
  buildConfig,
  PACKETS,
  ERRORS,
  PLAYER_A,
  PLAYER_B,
  PRIVATE_PVP_OPEN_TAGS,
};
