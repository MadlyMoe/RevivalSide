"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  writeBool,
  writeIntList,
  writeNullableObject,
  writeObjectMapInt,
} = require("../modules/packet-codec");
const { createCsharpCombatHost } = require("../combat-handler/csharpHost");
const { findCounterSideManagedDir } = require("../modules/counterside-install");
const { getDefaultGameplayTablesDir } = require("../modules/gameplay-jsons");

const rootDir = path.resolve(__dirname, "..");
const manifest = JSON.parse(read("protocol", "manifest.json"));
const packet = manifest.packets.find((entry) => entry.id === 2614);
assert(packet, "PVP_BAN_LIST_UPDATED_NOT manifest entry");
assert.strictEqual(packet.name, "NKMPacket_PVP_BAN_LIST_UPDATED_NOT");
assert.deepStrictEqual(packet.clientSendLocations, [], "global ban-result notification must have no client request path");
assert(packet.clientReceiveLocations.length > 0, "global ban-result notification must retain its frozen receiver");

const notification = read("Assembly-CSharp", "ClientPacket", "Pvp", "NKMPacket_PVP_BAN_LIST_UPDATED_NOT.cs");
const result = read("Assembly-CSharp", "ClientPacket", "Common", "NKMPvpBanResult.cs");
const receiver = read("Assembly-CSharp", "NKC", "PacketHandler", "NKCPacketHandlersLobby.cs");
const listener = read("server", "listener.js");
const bridge = read("combat-host", "ManagedCombatBridge.cs");
const votes = read("modules", "pvp-votes", "index.js");

assert.match(notification, /PutOrGet<NKMPvpBanResult>\(ref this\.pvpBanResult\)/);
for (const field of [
  "unitBanList", "shipBanList", "operatorBanList", "unitUpList",
  "unitCastingBanList", "shipCastingBanList", "operatorCastingBanList",
  "unitFinalBanList", "shipFinalBanList", "operatorFinalBanList",
  "unitSeasonBanResult", "seasonBanState",
]) {
  assert(result.includes(`this.${field}`), `frozen global ban result field ${field}`);
}
assert.match(receiver, /OnRecv\(NKMPacket_PVP_BAN_LIST_UPDATED_NOT not\)[\s\S]*NKCBanManager\.UpdatePVPBanData\(not\.pvpBanResult\)/);
assert.match(listener, /writeNullableObject\(buildPvpBanResultData\(\)\), \/\/ pvpBanResult/);
assert.match(listener, /function buildPvpBanResultData\(\)[\s\S]*writeObjectMapInt\(\[\]\), \/\/ unitBanList[\s\S]*buildPvpBanOptionStateData/);
assert(!/"pvpBanResult"/.test(localJoinFieldBlock(bridge)), "managed official payload must remain authoritative for pvpBanResult");
assert.match(votes, /updateVote\(user, "pvpCastingVoteData"/);
assert.doesNotMatch(votes, /pvpBanResult|unitFinalBanList|shipFinalBanList|operatorFinalBanList/,
  "one user's ballot must not be promoted into a fabricated server-wide ban result");

const emptyResult = Buffer.concat([
  ...Array.from({ length: 10 }, () => writeObjectMapInt([])),
  writeNullableObject(Buffer.concat([writeIntList([]), writeIntList([]), writeIntList([])])),
  writeNullableObject(Buffer.concat([writeBool(false), writeBool(false), writeBool(false)])),
]);
const payload = writeNullableObject(emptyResult);
validateManagedSchema(payload);

console.log(`[pvp-ban-aggregation-check] PASS fields=12 requestPaths=0 globalCorpus=absent managed=${findCounterSideManagedDir({ env: process.env }) ? "on" : "SKIP"}`);

function read(...segments) {
  return fs.readFileSync(path.join(rootDir, ...segments), "utf8");
}

function localJoinFieldBlock(source) {
  const match = source.match(/LocalJoinLobbyFields\s*=\s*\[([\s\S]*?)\];/);
  assert(match, "managed local JOIN field list");
  return match[1];
}

function validateManagedSchema(payload) {
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
    const validation = host.request("validatePacket", { packetId: 2614, payloadBase64: payload.toString("base64") });
    assert(validation.ok, `managed client schema rejected PVP_BAN_LIST_UPDATED_NOT: ${validation.error || "unknown error"}`);
  } finally {
    host.close();
  }
}
