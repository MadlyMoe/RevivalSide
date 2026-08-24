const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { getFixedShopProductIds, loadShopCatalog } = require("../modules/shop");
const { createLoginLikeHydratedHandler } = require("../modules/packet-hydration");
const { TUTORIAL_STAGE_CHAIN } = require("../stages/tutorialStage");
const { ensureMainStoryState } = require("../stages/mainStoryStage");

const root = path.resolve(__dirname, "..");
const listener = fs.readFileSync(path.join(root, "server", "listener.js"), "utf8");
const joinLobby = fs.readFileSync(path.join(root, "packet-handlers", "0204-join-lobby-req.js"), "utf8");

assert(listener.includes('/launcher/api/server-info-mode'), "Android cannot switch the shared ServerInfo bridge");
assert(
  listener.includes('serverInfoMode === "revivalside" && mirrorPath.endsWith("/ServerInfo_V2.json")'),
  "Official capture still receives the rewritten RevivalSide ServerInfo",
);
assert(listener.includes("serverInfoMode,"), "Listener health does not expose the selected server");

const tutorialScrub = listener.match(/function scrubTutorialEpisodeClearProgress[\s\S]*?function normalizeTutorialPhaseOrder/);
assert(tutorialScrub, "Tutorial progress scrubber was not found");
assert(
  !tutorialScrub[0].includes('for (const containerName of ["mainStory", "episode1"])'),
  "Tutorial scrubber mutates derived main-story state and invalidates every login warmup",
);

assert(
  listener.includes("CS_PREWARMED_JOIN_LOBBY_ACK_TTL_MS, 1000, 86400000, 14400000"),
  "Android first-install warmup must survive a multi-hour asset download"
);
const cacheInvalidation = listener.match(/function invalidateJoinLobbyAckPayloadCache[\s\S]*?\n}/);
assert(cacheInvalidation, "JOIN_LOBBY cache invalidation was not found");
assert(cacheInvalidation[0].includes("prewarmedJoinLobbyAckPayloads.clear()"), "JOIN_LOBBY invalidation leaves stale warmup payloads");
assert(cacheInvalidation[0].includes("lobbySessionPreparationCache.clear()"), "JOIN_LOBBY invalidation leaves stale preparation state");
assert(
  listener.includes("if (options.consume === true) prewarmedJoinLobbyAckPayloads.delete(cacheKey)"),
  "JOIN_LOBBY warm payload must survive reconnects"
);
assert(
  listener.includes("Number(entry.userDbRevision) !== userDbRevision"),
  "JOIN_LOBBY reconnect cache must reject lobby-affecting saves"
);
assert(
  joinLobby.includes('ctx.rememberPrewarmedJoinLobbyAckPayload(user, payload, "join-lobby")'),
  "A directly built JOIN_LOBBY payload must seed the reconnect cache"
);
const eventPass = fs.readFileSync(path.join(root, "modules", "event-pass", "index.js"), "utf8");
assert(!eventPass.includes("scheduleCounterPassNotificationRetry"), "Counter Pass still schedules duplicate lobby notifications");
const raidBootstrap = joinLobby.match(/function sendJoinLobbyRaidBootstrap[\s\S]*?function sendFierceSeasonBootstrap/);
assert(raidBootstrap, "JOIN_LOBBY raid bootstrap was not found");
assert(raidBootstrap[0].includes("includeWorldMap: false"), "JOIN_LOBBY must not send unsolicited WORLDMAP_INFO_ACK");
assert(!raidBootstrap[0].includes("includeWorldMap: true"), "JOIN_LOBBY still sends unsolicited WORLDMAP_INFO_ACK");
const bootTemplates = joinLobby.match(/function sendJoinLobbyBootTemplates[\s\S]*?function sendJoinLobbyPostBootStart/);
assert(bootTemplates, "JOIN_LOBBY boot template sender was not found");
assert(
  !bootTemplates[0].includes('sendCapturedGameTemplateRange(socket, 1, 1'),
  "JOIN_LOBBY sends a second captured ACK that replaces the active profile",
);

const warmedUser = { userUid: 311426, accessToken: "warmed-token" };
const warmedJoinPayload = Buffer.from("prewarmed-join-lobby");
const loginSaveOptions = [];
const preparationOptions = [];
let cacheLookups = 0;
let cacheBuilds = 0;
const loginContext = {
  capturedTcpResponses: new Map(),
  capturedTcpProfiles: {},
  config: { USE_LOCAL_USER_DB: true, REPLAY_CAPTURED_LOGIN_ACK: false },
  decryptCopy(payload) { return Buffer.from(payload || []); },
  getOrCreateUserForGuest() { return warmedUser; },
  issueUserTokens() {},
  prepareTutorialLogin() {},
  saveUserDb(options) { loginSaveOptions.push(options); },
  prepareUserLobbySession(_user, options) { preparationOptions.push(options); return { skipped: true }; },
  setLastEffectiveAccessToken() {},
  sendResponse(_socket, _sequence, _packetId, build) { build(); },
  buildLoginLikePayload() { return Buffer.alloc(0); },
  buildEncryptedPacket(_sequence, _packetId, payload) { return payload; },
  takePrewarmedJoinLobbyAckPayload(user, options) {
    cacheLookups += 1;
    assert.strictEqual(user, warmedUser);
    assert.deepStrictEqual(options, { consume: false });
    return warmedJoinPayload;
  },
  prewarmJoinLobbyAckPayload() { cacheBuilds += 1; },
};
const loginSocket = { session: {} };
createLoginLikeHydratedHandler(229, { ackPacketId: 230 }).handle(
  loginContext,
  loginSocket,
  { sequence: 1, payload: Buffer.alloc(0) },
);
assert.strictEqual(loginSocket.session.user, warmedUser, "GAMEBASE login did not retain the warmed user");
assert.deepStrictEqual(loginSaveOptions, [{ affectsJoinLobby: false }], "GAMEBASE token save invalidates JOIN_LOBBY warmup");
assert.strictEqual(preparationOptions.length, 1, "GAMEBASE login must prepare the same lobby session once");
assert.notStrictEqual(preparationOptions[0].force, true, "GAMEBASE login forces a duplicate lobby preparation");
assert.strictEqual(cacheLookups, 1, "GAMEBASE login did not reuse the prewarmed JOIN_LOBBY payload");
assert.strictEqual(cacheBuilds, 0, "GAMEBASE login rebuilt an already-warmed JOIN_LOBBY payload");

const postTutorialUser = {
  loginFlow: "post-tutorial",
  tutorial: {
    enabled: true,
    completed: true,
    loginMode: "post-tutorial",
    phases: Object.fromEntries(TUTORIAL_STAGE_CHAIN.map((stage, index) => [
      String(stage.dungeonID),
      { phase: index + 1, stageId: stage.stageId, dungeonId: stage.dungeonID, completed: true },
    ])),
  },
  unlockedStageIds: [],
  dungeonClear: {},
  stagePlayData: {},
  mainStory: { stages: {} },
  episode1: { stages: {} },
};
ensureMainStoryState(postTutorialUser);
for (const stage of TUTORIAL_STAGE_CHAIN) {
  assert(!postTutorialUser.dungeonClear[String(stage.dungeonID)], `Main-story normalization recreated tutorial dungeon ${stage.dungeonID}`);
  assert(!postTutorialUser.stagePlayData[String(stage.stageId)], `Main-story normalization recreated tutorial stage ${stage.stageId}`);
}

const globalProducts = getFixedShopProductIds({
  config: { CONTENTS_TAGS: [] },
  eventManager: {
    getActiveEventState() {
      // The captured event state can carry a region token such as TWN. It is
      // an exclusion selector, not an active shop-content version; it must not
      // suppress the global Admin Coin rows.
      return { intervalData: [], openTags: [], contentsTags: ["TWN"] };
    },
  },
  getEffectiveContentsTags() {
    return [
      "TAG_COMMON_SHOP_TAB_CASH_6_0A_GLOBAL",
      "TAG_COMMON_SHOP_TAB_CASH_7_9A_GLOBAL",
      "TAG_COMMON_PVP_BASIC_DATA",
      "TAG_COMMON_SHOP_TAB_EXCHANGE_RESOURCE",
      "TAG_COMMON_SHOP_TAB_EXCHANGE_RESOURCE_SELL_ETERNIUM",
      "GLOBAL",
    ];
  },
});
assert(globalProducts.includes(2351), "Global Admin Coin SKU 2351 is missing from the fixed shop ACK");
assert(globalProducts.includes(2368), "Global Admin Coin SKU 2368 is missing from the fixed shop ACK");
assert(!globalProducts.includes(2301), "Korean Admin Coin SKU leaked into the Global fixed shop ACK");
assert(!globalProducts.includes(41032), "Developer-only Gauntlet product leaked through its active parent tab");
assert(!globalProducts.includes(44151), "Inactive Gauntlet character product leaked through its active parent tab");
assert(!globalProducts.includes(44103), "Disabled Gauntlet product leaked into the fixed shop ACK");
assert(!globalProducts.includes(3106), "Inactive exchange product leaked through its active parent tab");
assert(!globalProducts.includes(3208), "Client-unregistered exchange product leaked into the fixed shop ACK");

const activeContentsTags = new Set([
  "TAG_COMMON_SHOP_TAB_CASH_6_0A_GLOBAL",
  "TAG_COMMON_SHOP_TAB_CASH_7_9A_GLOBAL",
  "TAG_COMMON_PVP_BASIC_DATA",
  "TAG_COMMON_SHOP_TAB_EXCHANGE_RESOURCE",
  "TAG_COMMON_SHOP_TAB_EXCHANGE_RESOURCE_SELL_ETERNIUM",
  "GLOBAL",
]);
const catalog = loadShopCatalog();
for (const productId of globalProducts) {
  const records = catalog.recordsByProductIdAll.get(productId) || [];
  assert(
    records.some((record) => !(record.listContentsTagIgnore || []).some((tag) => activeContentsTags.has(String(tag).toUpperCase()))),
    `Product ${productId} ignored by the Global client leaked into the fixed shop ACK`
  );
}

console.log(`[android-listener-parity] PASS warmup -> GAMEBASE login -> JOIN reuse and ${globalProducts.length} active fixed products`);
