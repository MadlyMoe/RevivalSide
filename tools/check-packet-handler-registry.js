"use strict";

const assert = require("assert");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");
const { createLoginLikeHydratedHandler } = require("../modules/packet-hydration");

const rootDir = path.resolve(__dirname, "..");
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);

assert(handlers.size >= 495, `expected at least 495 implemented request handlers, found ${handlers.size}`);
for (const [packetId, handler] of handlers) {
  assert(Number.isInteger(packetId) && packetId >= 0, `invalid packet id ${packetId}`);
  assert.strictEqual(typeof handler.handle, "function", `packet ${packetId} has no handler`);
  assert(handler.fileName, `packet ${packetId} has no source file`);
}

const specialistOwners = new Map([
  [820, "packet-handlers\\0000-combat-control-reqs.js"],
  [823, "packet-handlers\\0823-game-giveup-req.js"],
  [825, "packet-handlers\\0000-combat-control-reqs.js"],
  [827, "packet-handlers\\0000-combat-control-reqs.js"],
  [814, "packet-handlers\\0000-battle-actions.js"],
  [835, "packet-handlers\\0000-battle-actions.js"],
  [838, "packet-handlers\\0000-battle-actions.js"],
  [842, "packet-handlers\\0000-battle-actions.js"],
  [861, "packet-handlers\\0000-battle-actions.js"],
  [882, "packet-handlers\\0000-battle-actions.js"],
  [889, "packet-handlers\\0000-0889-ingame-skip.js"],
  [226, "modules\\profile\\handlers\\"],
  [844, "modules\\misc-stages\\handlers\\"],
  [855, "modules\\simulation\\handlers\\"],
  [1219, "modules\\stage-play-reset\\handlers\\"],
  [1221, "modules\\shadow-palace\\handlers\\"],
  [1223, "modules\\shadow-palace\\handlers\\"],
  [1251, "modules\\shadow-palace\\handlers\\"],
  [2697, "modules\\pvp-pick-rate\\handlers\\"],
  [3073, "modules\\mini-game\\handlers\\"],
  [3075, "modules\\mini-game\\handlers\\"],
  [3081, "modules\\score-reward\\handlers\\"],
  [3083, "modules\\score-reward\\handlers\\"],
  [1000, "modules\\equipment-pipeline\\handlers\\"],
  [1400, "modules\\unit-growth\\handlers\\"],
  [1438, "modules\\collection\\handlers\\"],
  [1600, "modules\\deck-pipeline\\handlers\\"],
  [1614, "modules\\admin\\handlers\\"],
  [1620, "modules\\mission\\handlers\\"],
  [1646, "modules\\lobby\\handlers\\"],
  [2000, "modules\\world-map\\handlers\\"],
  [2400, "modules\\shop\\handlers\\"],
  [2608, "modules\\stamina\\handlers\\"],
  [2800, "modules\\contract\\handlers\\"],
  [3008, "modules\\event-pass\\handlers\\"],
  [3600, "modules\\office\\handlers\\"],
  [3800, "modules\\admin\\handlers\\"],
  [4100, "modules\\private-pvp\\handlers\\"],
  [4117, "modules\\private-pvp\\handlers\\"],
  [4123, "modules\\private-pvp\\handlers\\"],
]);

for (const [packetId, expectedPrefix] of specialistOwners) {
  const handler = handlers.get(packetId);
  assert(handler, `missing specialist request handler ${packetId}`);
  assert(
    String(handler.fileName).startsWith(expectedPrefix),
    `packet ${packetId} is owned by ${handler.fileName}; expected ${expectedPrefix}`
  );
}

let gamebaseAck = null;
createLoginLikeHydratedHandler(229, { ackPacketId: 230 }).handle(
  {
    capturedTcpResponses: new Map(),
    capturedTcpProfiles: { loginAck: {} },
    config: { REPLAY_CAPTURED_LOGIN_ACK: true },
    sendResponse(_socket, _sequence, _packetId, build) {
      gamebaseAck = build();
    },
    buildCapturedGamebaseLoginAck() {
      return "official-gamebase-ack";
    },
  },
  { session: { user: { userUid: 1, accessToken: "token" } } },
  { sequence: 1 }
);
assert.strictEqual(gamebaseAck, "official-gamebase-ack", "GAMEBASE login must reuse the official login template");

console.log(`[packet-handler-registry] PASS handlers=${handlers.size} specialist precedence and GAMEBASE template fallback verified`);
