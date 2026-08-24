"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { buildEquipPresetNotPayload, createEquipmentPipelineHandlers } = require("../modules/equipment-pipeline");
const { getEquipItem, getEquipPresets, grantEquipItem, registerEquipPreset } = require("../modules/equipment");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { getMiscItem, setMiscItemBalance } = require("../modules/inventory");
const {
  buildChargeItemNotPayload,
  getChargeItemNotifications,
  getTimedStaminaRoutes,
  refreshTimedStamina,
} = require("../modules/stamina");
const {
  readBool,
  readSignedVarInt,
  readSignedVarLong,
  readString,
  writeLongArray,
} = require("../modules/packet-codec");

const ROOT_DIR = path.resolve(__dirname, "..");
const EQUIP_REMOVE_REQ = 1006;
const EQUIP_REMOVE_ACK = 1007;
const EQUIP_PRESET_NOT = 1050;
const CHARGE_ITEM_NOT = 1051;
const ETERNIUM = 2;
const ASYNC_TICKET = 13;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const TICKS_PER_MILLISECOND = 10000n;
const TICKS_PER_SECOND = 10000000n;
const NOW = dateTimeBinary("2026-08-20T12:00:00.000Z");

const user = { userUid: "9860000000001050", nickname: "EquipNotificationCheck" };
const presetEquip = grantEquipItem(user, 101004);
const ordinaryEquip = grantEquipItem(user, 101001);
assert(presetEquip && ordinaryEquip, "frozen equipment fixtures must exist");
assert(registerEquipPreset(user, 0, 0, presetEquip.equipUid), "equipment fixture must register in preset zero");

const handler = createEquipmentPipelineHandlers().find((entry) => entry.packetId === EQUIP_REMOVE_REQ);
assert(handler, "equipment removal handler must be registered");
const socket = { session: { user } };
const responses = [];
const notifications = [];
const managedWire = [];
let saves = 0;
const ctx = {
  config: { USE_LOCAL_USER_DB: true },
  decryptCopy: (payload) => payload,
  saveUserDb() { saves += 1; },
  buildEncryptedPacket(_sequence, packetId, payload) {
    responses.push({ packetId, payload });
    managedWire.push([packetId, payload]);
    return payload;
  },
  sendResponse(_target, _sequence, _packetId, build) { build(); },
  sendServerGamePacket(_target, packetId, payload) {
    notifications.push({ packetId, payload });
    managedWire.push([packetId, payload]);
  },
};

sendRemove(Buffer.alloc(0), false);
assert.strictEqual(readSignedVarInt(lastResponse().payload, 0).value, 247);
assert.strictEqual(notifications.length, 0, "failed equipment mutations must not notify presets");
assert.strictEqual(saves, 0);

sendRemove(writeLongArray([BigInt(ordinaryEquip.equipUid)]));
assert.strictEqual(readSignedVarInt(lastResponse().payload, 0).value, 0);
assert.strictEqual(notifications.length, 0, "unreferenced equipment removal must not notify presets");
assert.strictEqual(saves, 1);

sendRemove(writeLongArray([BigInt(presetEquip.equipUid)]));
assert.strictEqual(readSignedVarInt(lastResponse().payload, 0).value, 0);
assert.strictEqual(notifications.length, 1, "removing preset equipment must emit one authoritative repair push");
assert.strictEqual(notifications[0].packetId, EQUIP_PRESET_NOT);
assert.strictEqual(saves, 2, "ACK and preset repair must share the equipment mutation save");
assert.strictEqual(getEquipItem(user, presetEquip.equipUid), null);
const repairedPresets = parsePresetList(notifications[0].payload);
assert.strictEqual(repairedPresets.length, 1);
assert.deepStrictEqual(repairedPresets[0].equipUids, [0n, 0n, 0n, 0n]);
assert.strictEqual(repairedPresets[0].presetType, 1);

const restarted = JSON.parse(JSON.stringify(user));
assert.deepStrictEqual(parsePresetList(buildEquipPresetNotPayload(restarted)), repairedPresets);
assert.deepStrictEqual(getEquipPresets(restarted)[0].equipUids.map(BigInt), [0n, 0n, 0n, 0n]);

const staminaUser = { userUid: "9860000000001051", level: 1 };
const eterniumRoute = getTimedStaminaRoutes(staminaUser).find((route) => route.itemId === ETERNIUM);
const asyncRoute = getTimedStaminaRoutes(staminaUser).find((route) => route.itemId === ASYNC_TICKET);
assert(eterniumRoute && asyncRoute, "frozen charge routes 2 and 13 must exist");
setMiscItemBalance(staminaUser, ETERNIUM, eterniumRoute.max - eterniumRoute.amount * 2);
setMiscItemBalance(staminaUser, ASYNC_TICKET, asyncRoute.max - 1);
staminaUser.stamina = {
  chargeItems: {
    [ETERNIUM]: { lastUpdateDate: String(NOW - BigInt(eterniumRoute.intervalSeconds * 2) * TICKS_PER_SECOND) },
    [ASYNC_TICKET]: { lastUpdateDate: String(NOW - BigInt(asyncRoute.intervalSeconds) * TICKS_PER_SECOND) },
  },
};
const refreshed = refreshTimedStamina(staminaUser, { now: NOW, itemIds: [ETERNIUM, ASYNC_TICKET], initializeMissing: false });
assert.strictEqual(refreshed.changed, true);
assert.strictEqual(getMiscItem(staminaUser, ETERNIUM).countFree, String(eterniumRoute.max));
assert.strictEqual(getMiscItem(staminaUser, ASYNC_TICKET).countFree, String(asyncRoute.max));
const chargeUpdates = getChargeItemNotifications(staminaUser, { now: NOW, itemIds: [ETERNIUM, ASYNC_TICKET] });
assert.deepStrictEqual(chargeUpdates.map((entry) => entry.itemId), [ETERNIUM, ASYNC_TICKET]);
for (const update of chargeUpdates) {
  const payload = buildChargeItemNotPayload(update);
  const decoded = parseChargeItem(payload);
  assert.strictEqual(decoded.lastUpdateDate, BigInt(update.lastUpdateDate));
  assert.strictEqual(decoded.itemId, update.itemId);
  assert.strictEqual(decoded.countFree, BigInt(getMiscItem(staminaUser, update.itemId).countFree));
  managedWire.push([CHARGE_ITEM_NOT, payload]);
}

assertFrozenSources();
validateManagedSchemas();
console.log(
  `[equip-notifications-protocol-check] PASS presets=${repairedPresets.length} charges=${chargeUpdates.length} saves=${saves} packets=${managedWire.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function sendRemove(payload, validateRequest = true) {
  if (validateRequest) managedWire.push([EQUIP_REMOVE_REQ, payload]);
  assert.strictEqual(handler.handle(ctx, socket, { packetId: EQUIP_REMOVE_REQ, sequence: responses.length + 1, payload }), true);
}

function lastResponse() {
  assert(responses.length > 0, "equipment handler must return an ACK");
  const response = responses[responses.length - 1];
  assert.strictEqual(response.packetId, EQUIP_REMOVE_ACK);
  return response;
}

function parsePresetList(payload) {
  const count = readUnsignedVarInt(payload, 0);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const present = readBool(payload, offset);
    assert.strictEqual(present.value, true);
    const presetIndex = readSignedVarInt(payload, present.offset);
    const presetType = readSignedVarInt(payload, presetIndex.offset);
    const presetName = readString(payload, presetType.offset);
    const equipUids = readLongList(payload, presetName.offset);
    values.push({ presetIndex: presetIndex.value, presetType: presetType.value, presetName: presetName.value, equipUids: equipUids.values });
    offset = equipUids.offset;
  }
  assert.strictEqual(offset, payload.length, "equipment preset notification must have no trailing bytes");
  return values;
}

function parseChargeItem(payload) {
  assert(payload.length >= 9, "charge notification must contain date and item marker");
  const lastUpdateDate = payload.readBigInt64LE(0);
  const present = readBool(payload, 8);
  assert.strictEqual(present.value, true);
  const itemId = readSignedVarInt(payload, present.offset);
  const countFree = readSignedVarLong(payload, itemId.offset);
  const countPaid = readSignedVarLong(payload, countFree.offset);
  const bonusRatio = readSignedVarInt(payload, countPaid.offset);
  const offset = bonusRatio.offset + 8;
  assert.strictEqual(offset, payload.length, "charge notification must have no trailing bytes");
  return { lastUpdateDate, itemId: itemId.value, countFree: countFree.value, countPaid: countPaid.value };
}

function readLongList(payload, start) {
  const count = readUnsignedVarInt(payload, start);
  let offset = count.offset;
  const values = [];
  for (let index = 0; index < count.value; index += 1) {
    const value = readSignedVarLong(payload, offset);
    values.push(value.value);
    offset = value.offset;
  }
  return { values, offset };
}

function readUnsignedVarInt(payload, start) {
  let offset = start;
  let value = 0;
  let shift = 0;
  while (shift < 35) {
    assert(offset < payload.length, "truncated unsigned varint");
    const byte = payload[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  throw new Error("unsigned varint too long");
}

function dateTimeBinary(iso) {
  return (TICKS_AT_UNIX_EPOCH + BigInt(new Date(iso).getTime()) * TICKS_PER_MILLISECOND) | DATE_TIME_LOCAL_MASK;
}

function assertFrozenSources() {
  const presetPacket = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_EQUIP_PRESET_NOT.cs"), "utf8");
  const chargePacket = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "ClientPacket", "Item", "NKMPacket_CHARGE_ITEM_NOT.cs"), "utf8");
  const receiver = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"), "utf8");
  const userData = fs.readFileSync(path.join(ROOT_DIR, "Assembly-CSharp", "NKM", "NKMUserData.cs"), "utf8");
  const joinSource = fs.readFileSync(path.join(ROOT_DIR, "packet-handlers", "0204-join-lobby-req.js"), "utf8");
  assert(presetPacket.includes("PutOrGet<NKMEquipPresetData>(ref this.presetDatas);"));
  assert(chargePacket.includes("stream.PutOrGet(ref this.lastUpdateDate);") && chargePacket.includes("stream.PutOrGet<NKMItemMiscData>(ref this.itemData);"));
  assert(receiver.includes("NKCEquipPresetDataManager.ListEquipPresetData = cPacket.presetDatas;") && receiver.includes("NKCEquipPresetDataManager.RefreshEquipUidHash();"));
  assert(userData.includes("sPacket.itemData.ItemID == 2") && userData.includes("sPacket.itemData.ItemID == 13"));
  assert(joinSource.includes('itemIds: [2, 13]'));
  assert(joinSource.includes('sendCapturedGameTemplateRange(socket, 9, 9, "tutorial-join-lobby-post-boot"'));
  assert(joinSource.includes('sendCapturedGameTemplateRange(socket, 12, 12, "tutorial-join-lobby-post-boot"'));
  for (const name of ["server_010_1051.payload.bin", "server_011_1051.payload.bin"]) {
    assert(fs.existsSync(path.join(ROOT_DIR, "server-data", "captured-game-flow", name)), `missing frozen ${name}`);
  }
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(ROOT_DIR, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir: ROOT_DIR, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedWire) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed schema rejected equipment notification packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}
