"use strict";

const assert = require("assert");
const path = require("path");
const {
  createLobbyCustomizationHandlers,
  buildBackgroundInfoData,
} = require("../modules/lobby");
const { setMiscItemBalance, getMiscItem } = require("../modules/inventory");
const { grantUnit } = require("../modules/unit");
const {
  readSignedVarInt,
  writeBool,
  writeNullableObject,
  writeSignedVarInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const user = {
  userUid: "960000000000001",
  nickname: "LobbyCheck",
  inventory: { misc: {}, equips: {}, skins: [], emoticons: [] },
  army: { units: {}, ships: {}, trophies: {}, operators: {}, decks: [] },
};
setMiscItemBalance(user, 101, 1000);
const unit = grantUnit(user, 1001);
assert(unit, "fixture unit must exist in the frozen unit table");

const socket = { session: { user } };
const handlers = new Map(createLobbyCustomizationHandlers().map((handler) => [handler.packetId, handler]));
const wire = [];
let saves = 0;
let now = new Date("2021-01-05T12:00:00Z");
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  getServerNowDate: () => now,
  sendGameResponse(target, packet, packetId, payload) {
    target.response = { sequence: packet.sequence, packetId, payload };
    wire.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
};

send(1634, writeBool(true));
assertAck(1635, 0);
assert.strictEqual(user.options.playCutscene, true);

send(1638, ints(0, 1));
assertAck(1639, 333);
send(1638, ints(2, 0));
assertAck(1639, 334);
send(1638, ints(2, 2));
assertAck(1639, 0);
assert.strictEqual(user.inventoryExpansion.unit, 210);
assert.strictEqual(getMiscItem(user, 101).countFree, "800");
send(1638, Buffer.concat([ints(2, 1), Buffer.from([0])]));
assertAck(1639, 20190);
assert.strictEqual(user.inventoryExpansion.unit, 210, "malformed expansion must not change capacity");
assert.strictEqual(getMiscItem(user, 101).countFree, "800", "malformed expansion must not consume currency");
setMiscItemBalance(user, 101, 0);
send(1638, ints(2, 1));
assertAck(1639, 111);

send(1646, writeBool(false));
assertAck(1647, 21072);
send(1646, backgroundRequest({ backgroundItemId: 9002, backgroundBgmId: 1, unitInfoList: [] }));
assertAck(1647, 21072);
setMiscItemBalance(user, 9002, 1);
send(1646, backgroundRequest({ backgroundItemId: 9002, backgroundBgmId: 1, unitInfoList: [backgroundUnit("999999")] }));
assertAck(1647, 21072);
send(1646, backgroundRequest({ backgroundItemId: 9002, backgroundBgmId: 1, unitInfoList: [backgroundUnit(unit.unitUid)] }));
assertAck(1647, 0);
assert.strictEqual(user.lobbyCustomization.backgroundInfo.backgroundItemId, 9002);
assert.strictEqual(user.lobbyCustomization.backgroundInfo.unitInfoList[0].unitUid, unit.unitUid);

send(1654, writeSignedVarInt(4));
assertAck(1655, 20190);
send(1654, writeSignedVarInt(3));
assertAck(1655, 0);
assert.strictEqual(user.pvp.invitationOption, 3);

send(1660, ints(1, 1));
assertAck(1661, 20190);
send(1660, ints(0, 999999));
assertAck(1661, 20190);
send(1660, ints(0, 1));
assertAck(1661, 0);
send(1660, ints(0, 2));
assertAck(1661, 26602);
now = new Date(now.getTime() + 1000);
send(1660, ints(0, 2));
assertAck(1661, 0);

assert.strictEqual(saves, 6, "only successful lobby mutations may persist");
const restarted = JSON.parse(JSON.stringify(user));
assert.strictEqual(restarted.options.playCutscene, true);
assert.strictEqual(restarted.inventoryExpansion.unit, 210);
assert.strictEqual(restarted.lobbyCustomization.backgroundInfo.backgroundItemId, 9002);
assert.strictEqual(restarted.lobbyCustomization.jukeboxBgmIds["0"], 2);
assert.strictEqual(restarted.pvp.invitationOption, 3);

validateManagedSchemas();
console.log(`[lobby-customization-protocol-check] PASS saves=${saves} packets=${wire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function send(packetId, payload) {
  const handler = handlers.get(packetId);
  assert(handler, `missing lobby handler ${packetId}`);
  wire.push([packetId, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId, sequence: packetId, payload }), true);
}

function assertAck(packetId, errorCode) {
  assert.strictEqual(socket.response.packetId, packetId, `unexpected ACK for ${packetId}`);
  assert.strictEqual(readSignedVarInt(socket.response.payload, 0).value, errorCode, `packet ${packetId} error code`);
}

function ints(...values) {
  return Buffer.concat(values.map(writeSignedVarInt));
}

function backgroundRequest(info) {
  return writeNullableObject(buildBackgroundInfoData(info));
}

function backgroundUnit(unitUid) {
  return {
    unitUid,
    unitType: 2,
    unitSize: 1,
    unitFace: 0,
    unitPosX: 0,
    unitPosY: 0,
    backImage: true,
    skinOption: 0,
    rotation: 0,
    flip: false,
    animTime: -1,
  };
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const combatHost = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of wire) {
      const result = combatHost.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected lobby packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    combatHost.close();
  }
}
