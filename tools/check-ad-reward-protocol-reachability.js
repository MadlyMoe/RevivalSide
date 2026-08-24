"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const assemblyDir = path.join(rootDir, "Assembly-CSharp");
const adBaseSource = read("NKC/Advertise/NKCAdBase.cs");
const adNoneSource = read("NKC/Advertise/NKCAdNone.cs");
const adManagerSource = read("NKC/NKCAdManager.cs");
const projectSource = read("Assembly-CSharp.csproj");

assert.match(
  adBaseSource,
  /adInstance\s*=\s*[^;]+\.AddComponent<NKCAdNone>\(\);/,
  "the frozen client must still instantiate the no-ad provider"
);
assert.match(
  adBaseSource,
  /public virtual bool IsAdvertiseEnabled\(\)\s*\{\s*return false;\s*\}/s,
  "the frozen no-ad provider must remain disabled"
);
assert.match(
  adNoneSource,
  /public override void WatchRewardedAd\([^)]*\)\s*\{\s*\}/s,
  "the frozen no-ad provider must not invoke a reward callback"
);

const adImplementations = [...projectSource.matchAll(/<Compile Include="NKC\\Advertise\\([^"]+\.cs)"/g)].map(
  (match) => match[1]
);
assert.deepStrictEqual(
  adImplementations.sort(),
  ["NKCAdBase.cs", "NKCAdNone.cs"],
  "the frozen project unexpectedly gained an enabled advertisement provider"
);

for (const senderName of [
  "Send_NKMPacket_AD_ITEM_REWARD_REQ",
  "Send_NKMPacket_AD_INVENTORY_EXPAND_REQ",
]) {
  const references = listFiles(assemblyDir, ".cs")
    .filter((filePath) => fs.readFileSync(filePath, "utf8").includes(senderName))
    .map((filePath) => path.relative(assemblyDir, filePath).replace(/\\/g, "/"));
  assert.deepStrictEqual(
    references.sort(),
    ["NKC/NKCAdManager.cs", "NKC/NKCPacketSender.cs"],
    `${senderName} unexpectedly gained a path outside the disabled advertisement manager`
  );
}

assert.match(
  adManagerSource,
  /return NKMADTemplet\.EnableByTag[^;]+NKCAdBase\.Instance\.IsAdvertiseEnabled\(\);/s,
  "item-ad visibility must remain gated by the disabled provider"
);
assert.match(
  adManagerSource,
  /return NKMADTemplet\.EnableByTag && flag && NKCAdBase\.Instance\.IsAdvertiseEnabled\(\);/,
  "inventory-ad visibility must remain gated by the disabled provider"
);
assert.strictEqual(
  (adManagerSource.match(/WatchRewardedAd\([^;]+Send_NKMPacket_AD_/gs) || []).length,
  2,
  "both ad request families must remain callbacks of the disabled provider"
);
assert.strictEqual(
  (adManagerSource.match(/Send_NKMPacket_AD_(?:ITEM_REWARD|INVENTORY_EXPAND)_REQ/g) || []).length,
  2,
  "the frozen ad manager unexpectedly gained another ad request path"
);

console.log(
  `[ad-reward-reachability-check] PASS providers=${adImplementations.length} requestFamilies=2 requestPaths=0`
);

function read(relativePath) {
  return fs.readFileSync(path.join(assemblyDir, relativePath), "utf8");
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
