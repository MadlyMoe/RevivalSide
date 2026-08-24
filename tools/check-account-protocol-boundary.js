"use strict";

process.env.CS_LISTENER_TEST_MODE = "1";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { handleFallbackPacket } = require("../server/listener");

const rootDir = path.resolve(__dirname, "..");
const protectedHydrationPath = path.join(rootDir, "modules", "packet-hydration", "handlers", "0000-4136-hydrated-remaining-reqs.js");
const protectedHydrationHash = "5a30449a86478bc7fad027b023fc523d3037709a7dadd8a6ac73cd906cb029af";
const expectedOwners = new Map(Object.entries({
  200: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  201: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  202: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  204: "packet-handlers/0204-join-lobby-req.js",
  206: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  209: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  211: "modules/profile/handlers/0211-change-nickname-req.js",
  213: "packet-handlers/0213-reconnect-req.js",
  216: "packet-handlers/0216-contents-version-req.js",
  219: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  221: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  226: "modules/profile/handlers/0000-000-account-profile-reqs.js",
  229: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  231: "packet-handlers/0231-steam-login-req.js",
  232: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  235: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  238: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  241: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  244: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  246: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  248: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  250: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  252: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
  254: "modules/packet-hydration/handlers/0000-4136-hydrated-remaining-reqs.js",
}).map(([packetId, fileName]) => [Number(packetId), fileName]));

const actualHash = crypto.createHash("sha256").update(fs.readFileSync(protectedHydrationPath)).digest("hex");
assert.strictEqual(actualHash, protectedHydrationHash, "protected hydrated Account handlers changed");

const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
for (let packetId = 200; packetId <= 254; packetId += 1) {
  const handler = handlers.get(packetId);
  const expected = expectedOwners.get(packetId);
  assert.strictEqual(normalize(handler && handler.fileName), expected, `protected Account owner changed for packet ${packetId}`);
}

const responses = [];
const ctx = {
  sendGameResponse(_socket, packet, packetId) {
    responses.push({ requestId: packet.packetId, packetId });
  },
};
for (let packetId = 200; packetId <= 254; packetId += 1) {
  if (handlers.has(packetId)) continue;
  assert.strictEqual(handleFallbackPacket(ctx, {}, { packetId, sequence: packetId, payloadSize: 0 }), true);
}
assert.deepStrictEqual(responses, [], "unsupported Account packets must not receive a synthetic fallback");

const frozenReq = read("Assembly-CSharp", "ClientPacket", "Account", "NKMPacket_JOIN_LOBBY_REQ.cs");
const frozenAck = read("Assembly-CSharp", "ClientPacket", "Account", "NKMPacket_JOIN_LOBBY_ACK.cs");
const listener = read("server", "listener.js");
const joinHandler = read("packet-handlers", "0204-join-lobby-req.js");
assert(frozenReq.indexOf("ref this.protocolVersion") < frozenReq.indexOf("ref this.accessToken"));
const decodeStart = listener.indexOf("function decodeJoinLobbyReq(payload)");
const protocolRead = listener.indexOf("readSignedVarInt(decrypted, offset)", decodeStart);
const tokenRead = listener.indexOf("readString(decrypted, offset)", decodeStart);
assert(decodeStart >= 0 && protocolRead > decodeStart && tokenRead > protocolRead, "JOIN request decode order changed");
assert.strictEqual((frozenAck.match(/stream\.PutOrGet/g) || []).length, 63, "frozen JOIN ACK schema changed");
assert(joinHandler.includes("const joinReq = ctx.decodeJoinLobbyReq(packet.payload);"), "JOIN handler must retain the shared Account decoder");
assert(joinHandler.includes("ctx.constants.JOIN_LOBBY_ACK"), "JOIN handler must retain the frozen ACK packet");

console.log(`[account-boundary-check] PASS protected=55 owned=${expectedOwners.size} fallbackResponses=${responses.length} joinAckFields=63`);

function read(...parts) {
  return fs.readFileSync(path.join(rootDir, ...parts), "utf8");
}

function normalize(fileName) {
  return fileName ? String(fileName).replace(/\\/g, "/") : undefined;
}
