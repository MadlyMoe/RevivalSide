const assert = require("node:assert/strict");
const { createEventManager } = require("../modules/event-manager");
const { getActiveEventShopState, loadShopCatalog } = require("../modules/shop");
const { getAcqPackageRewards } = require("../modules/game-data");
const { grantRewardByType } = require("../modules/reward");

const manager = createEventManager({
  rootDir: process.cwd(),
  env: { ...process.env, CS_EVENT_MANAGER: "1" },
});
const catalog = loadShopCatalog();
const hololiveProductIds = new Set(
  catalog.records
    .filter((record) => String(record.m_TabID || "").toUpperCase() === "TAB_PACKAGE_CLB_003")
    .map((record) => Number(record.m_ProductID))
);

function activeHololiveProducts(date) {
  return getActiveEventShopState(manager.getActiveEventState(date)).productIds.filter((id) => hololiveProductIds.has(id));
}

for (const date of ["2022-12-09T12:00:00Z", "2023-06-01T12:00:00Z", "2024-02-27T12:00:00Z", "2024-03-28T12:00:00Z"]) {
  assert.deepEqual(activeHololiveProducts(date), [], `Hololive shop leaked into ${date}`);
}
const activeHololive = activeHololiveProducts("2024-02-29T12:00:00Z");
assert.ok(activeHololive.includes(160609), "Hololive activity package is missing during the 2024 collaboration");
assert.ok(activeHololive.includes(170095), "IRyS fan package is missing during the 2024 collaboration");

assert.equal(getAcqPackageRewards(160609).length, 4, "Hololive pledge milestones are missing from the source table");
const purchaseReward = grantRewardByType({}, { userUid: "shop-package-check" }, "RT_MISC", 160609, 1, 1, 0, {
  expandPackages: true,
});
assert.equal(purchaseReward.miscItems.length, 1, "Pledge milestones were granted immediately at purchase");
assert.equal(purchaseReward.miscItems[0].countFree, "1950", "Hololive base package reward changed");

console.log(`event shop package checks passed (${activeHololive.length} Hololive products active in 2024)`);
