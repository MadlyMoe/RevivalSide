"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PACKETS, ERRORS, decodeCouponRequest } = require("../modules/bside-coupon");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");
const { readSignedVarInt, writeSignedVarInt, writeString } = require("../modules/packet-codec");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const rootDir = path.resolve(__dirname, "..");
const handlerPath = "modules\\bside-coupon\\handlers\\0000-3051-bside-coupon-use-req.js";
const handlers = loadPacketHandlers(
  [path.join(rootDir, "packet-handlers"), path.join(rootDir, "modules")],
  { rootDir }
);
const handler = handlers.get(PACKETS.USE_REQ);
assert(handler, "BSIDE coupon specialist must be registered");
assert.strictEqual(handler.fileName, handlerPath, "BSIDE coupon specialist must win handler precedence");
assert.strictEqual(ERRORS.INVALID_CODE, 22001, "frozen invalid-coupon error changed");

const user = { userUid: "3051001", inventory: { misc: { 1: 999999 } }, inbox: [] };
const originalUser = JSON.stringify(user);
const socket = { session: { user } };
const managedPackets = [];
let response = null;
let saves = 0;
const ctx = {
  decryptCopy(payload) { return payload; },
  sendGameResponse(_socket, packet, packetId, payload) {
    assert.strictEqual(packet.sequence, 51);
    response = { packetId, payload };
    managedPackets.push([packetId, payload]);
  },
  saveUserDb() { saves += 1; },
  invalidateJoinLobbyAckPayloadCache() { throw new Error("coupon rejection must not invalidate JOIN"); },
};

const validRequest = writeString("REVIVALSIDE-UNKNOWN-CODE");
assert.deepStrictEqual(decodeCouponRequest(ctx, validRequest), {
  valid: true,
  couponCode: "REVIVALSIDE-UNKNOWN-CODE",
});
managedPackets.push([PACKETS.USE_REQ, validRequest]);
rejects("unknown external code", validRequest);
rejects("empty code", writeString(""));
rejects("null code", writeString(null));
rejects("truncated string", Buffer.concat([writeSignedVarInt(5), Buffer.from("A")]));
rejects("trailing data", Buffer.concat([writeString("CODE"), Buffer.from([0])]));
rejects("non-canonical length", Buffer.from([0x80, 0x00]));

assert.strictEqual(saves, 0, "external coupon rejection must not save");
assert.strictEqual(JSON.stringify(user), originalUser, "external coupon rejection must not mutate profile or inbox");
verifyFrozenBoundary();
validateManagedSchemas();

console.log(
  `[bside-coupon-check] PASS externalCatalog=absent saves=${saves} packets=${managedPackets.length} managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`
);

function rejects(name, payload) {
  response = null;
  assert.strictEqual(handler.handle(ctx, socket, { packetId: PACKETS.USE_REQ, sequence: 51, payload }), true);
  assert(response, `${name} must return an ACK`);
  assert.strictEqual(response.packetId, PACKETS.USE_ACK, `${name} ACK id`);
  const error = readSignedVarInt(response.payload, 0);
  assert.strictEqual(error.value, ERRORS.INVALID_CODE, `${name} error`);
  assert.strictEqual(error.offset, response.payload.length, `${name} ACK must not contain fabricated reward fields`);
}

function verifyFrozenBoundary() {
  const readSource = (...segments) => fs.readFileSync(path.join(rootDir, ...segments), "utf8");
  assert.match(
    readSource("Assembly-CSharp", "ClientPacket", "Event", "NKMPacket_BSIDE_COUPON_USE_REQ.cs"),
    /PutOrGet\(ref this\.couponCode\)/,
    "frozen request must remain a single coupon string"
  );
  const ackSource = readSource("Assembly-CSharp", "ClientPacket", "Event", "NKMPacket_BSIDE_COUPON_USE_ACK.cs");
  assert.match(ackSource, /PutOrGetEnum<NKM_ERROR_CODE>\(ref this\.errorCode\)/);
  assert.doesNotMatch(ackSource, /rewardData|postData|couponCode/, "frozen ACK must not carry rewards or catalog data");
  assert.match(
    readSource("Assembly-CSharp", "NKM", "NKM_ERROR_CODE.cs"),
    /NEC_FAIL_COUPON_ALREADY_USED\s*=\s*22000,[\s\S]*NEC_FAIL_COUPON_INVALID_CODE,[\s\S]*NEC_FAIL_COUPON_EXPIRED,[\s\S]*NEC_DB_FAIL_COUPON_USE_INSERT/,
    "frozen coupon error block changed"
  );
  assert.match(
    readSource("Assembly-CSharp", "NKC", "Publisher", "NKCPublisherModule.cs"),
    /IsSystemOpened\(SystemOpenTagType\.INTERNAL_COUPON_SYSTEM\)[\s\S]*Send_NKMPacket_BSIDE_COUPON_USE_REQ\(code\)/,
    "internal coupon request must remain reachable behind the system open tag"
  );
  assert.match(
    readSource("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs"),
    /OnRecv\(NKMPacket_BSIDE_COUPON_USE_ACK sPacket\)[\s\S]*Check_NKM_ERROR_CODE\(sPacket\.errorCode/,
    "frozen client must continue routing failures through the standard error UI"
  );

  const postTable = JSON.parse(readSource("gameplay-jsons", "StreamingAssets", "ab_script", "luac", "LUA_POST_TEMPLET.json"));
  const bsidePost = postTable.records.find((row) => row && row.m_PostType === "BSIDE_COUPON");
  assert.deepStrictEqual(bsidePost, { m_PostID: 9, m_PostType: "BSIDE_COUPON", m_AllowReceiveAll: true });
  const couponFiles = listFiles(path.join(rootDir, "gameplay-jsons"))
    .map((file) => path.basename(file).toUpperCase())
    .filter((name) => name.includes("BSIDE") && name.includes("COUPON"));
  assert.deepStrictEqual(couponFiles, [], "frozen client unexpectedly gained a server-owned BSIDE coupon catalog");
}

function validateManagedSchemas() {
  const managedDir = findCounterSideManagedDir({ env: process.env });
  if (!managedDir) return;
  const host = createCsharpCombatHost({
    enabled: true,
    projectPath: path.join(rootDir, "combat-host", "CombatHost.csproj"),
    dllPath: process.env.CS_COMBAT_HOST_PATH || undefined,
    managedDir,
    gameplayTablesDir: getDefaultGameplayTablesDir({ rootDir, env: process.env }),
    timeoutMs: 30000,
  });
  try {
    for (const [packetId, payload] of managedPackets) {
      const result = host.request("validatePacket", { packetId, payloadBase64: payload.toString("base64") });
      assert(result.ok, `managed client schema rejected BSIDE coupon packet ${packetId}: ${result.error || "unknown error"}`);
    }
  } finally {
    host.close();
  }
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}
