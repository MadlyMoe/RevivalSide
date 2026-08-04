const assert = require("node:assert/strict");
const { getAllMiscItemIds, getMiscItemTemplet, getRandomBoxRewards } = require("../modules/game-data");
const { grantRewardByType } = require("../modules/reward");

const boxes = getAllMiscItemIds().map(getMiscItemTemplet).filter((item) => item && item.m_ItemMiscType === "IMT_RANDOMBOX");
assert.ok(boxes.length > 0);
for (const box of boxes) assert.ok(getRandomBoxRewards(box.m_RewardGroupID).length > 0, `${box.m_ItemMiscID} has no reward table`);

const rolls = [70, 5];
const reward = grantRewardByType({}, { userUid: "1" }, "RT_MISC", 30002, 1, 1, 0, {
  expandPackages: true,
  openRandomBoxes: true,
  randomInt(max) {
    const value = rolls.shift();
    assert.ok(Number.isInteger(value) && value >= 0 && value < max, `${value} is outside 0..${max - 1}`);
    return value;
  },
});
assert.equal(reward.miscItems.length, 1);
assert.equal(reward.miscItems[0].itemId, 1014, "Type D weight boundary ignored");
assert.equal(reward.miscItems[0].countFree, "15", "Type D quantity maximum ignored");
assert.equal(rolls.length, 0);

console.log(`random box reward checks passed (${boxes.length} item tables)`);
