"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const publisherSource = read("NKC/Publisher/NKCPublisherModule.cs");
const tabSource = read("NKM/Event/NKMEventTabTemplet.cs");
const wechatUiSource = read("NKC/UI/Event/NKCUIEventSubUIWechatFollow.cs");

assert.match(
  publisherSource,
  /protected virtual NKCPublisherModule\.NKCPMMarketing MakeMarketingInstance\(\)\s*\{\s*return new NKCPMNone\.MarketingNone\(\);\s*\}/s,
  "the frozen publisher must still default every PC publisher to MarketingNone"
);
assert.match(
  publisherSource,
  /public virtual bool IsEnableWechatFollowEvent\(\)\s*\{\s*return false;\s*\}/s,
  "the frozen marketing provider must keep WeChat Follow disabled"
);
assert.match(
  publisherSource,
  /public virtual string MakeWechatFollowCode\([^)]*\)\s*\{\s*return "";\s*\}/s,
  "the frozen marketing provider must not fabricate a WeChat registration code"
);
assert.match(
  tabSource,
  /m_EventBannerPrefabName == "EVENT_S_FOLLOW_WECHAT_01"\)\s*\{\s*return NKCPublisherModule\.Marketing\.IsEnableWechatFollowEvent\(\);\s*\}/s,
  "the WeChat event tab must remain hidden behind the disabled publisher gate"
);

const sourceFiles = listFiles(assemblyDir, ".cs");
const enableReferences = referencesTo("IsEnableWechatFollowEvent");
assert.deepStrictEqual(
  enableReferences,
  ["NKC/Publisher/NKCPublisherModule.cs", "NKM/Event/NKMEventTabTemplet.cs"],
  "the frozen build unexpectedly gained a WeChat enable override or alternate gate"
);

for (const senderName of [
  "Send_NKMPacket_WECHAT_COUPON_CHECK_REQ",
  "Send_NKMPacket_WECHAT_COUPON_REWARD_REQ",
]) {
  assert.deepStrictEqual(
    referencesTo(senderName),
    ["NKC/NKCPacketSender.cs", "NKC/UI/Event/NKCUIEventSubUIWechatFollow.cs"],
    `${senderName} unexpectedly gained a path outside the publisher-gated event tab`
  );
}
assert.strictEqual(
  (wechatUiSource.match(/Send_NKMPacket_WECHAT_COUPON_(?:CHECK|REWARD)_REQ/g) || []).length,
  2,
  "the disabled WeChat tab must contain the only two request callsites"
);

const tableDir = path.join(rootDir, "gameplay-jsons", "StreamingAssets", "ab_script", "luac");
const couponRows = readJson(path.join(tableDir, "LUA_WECHAT_COUPON_TEMPLET.json")).records || [];
const tabRows = readJson(path.join(tableDir, "LUA_EVENT_TAB_TEMPLET.json")).records || [];
const wechatTabs = tabRows.filter((row) => row && row.m_EventBannerPrefabName === "EVENT_S_FOLLOW_WECHAT_01");
assert.strictEqual(couponRows.length, 1, "the frozen WeChat coupon table must still contain its one retired row");
assert.strictEqual(wechatTabs.length, 1, "every frozen WeChat coupon tab must remain covered by the false publisher gate");
assert.strictEqual(wechatTabs[0].m_EventID, couponRows[0].m_EventID, "the gated tab and retired coupon row must match");

console.log(
  `[wechat-coupon-reachability-check] PASS tabs=${wechatTabs.length} coupons=${couponRows.length} requestFamilies=2 requestPaths=0`
);

function read(relativePath) {
  return fs.readFileSync(path.join(assemblyDir, relativePath), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function referencesTo(symbol) {
  return sourceFiles
    .filter((filePath) => fs.readFileSync(filePath, "utf8").includes(symbol))
    .map((filePath) => path.relative(assemblyDir, filePath).replace(/\\/g, "/"))
    .sort();
}

function listFiles(directory, extension) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(entryPath);
  }
  return files;
}
