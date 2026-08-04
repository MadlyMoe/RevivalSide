const assert = require("node:assert/strict");
const { grantRewardByType } = require("../modules/reward");

const testimonialIds = [10301, 10302, 10303, 10304, 10310, 10311, 10312, 10313];

for (const itemId of testimonialIds) {
  const user = { userUid: "1" };
  const delivered = grantRewardByType({}, user, "RT_MISC", itemId, 1, 1, 0, { expandPackages: true });
  assert.equal(delivered.miscItems.length, 1, `${itemId} should enter inventory`);
  assert.equal(delivered.miscItems[0].itemId, itemId);
  assert.equal(delivered.units.length + delivered.operators.length, 0, `${itemId} opened during delivery`);

  const opened = grantRewardByType({}, { userUid: "2" }, "RT_MISC", itemId, 1, 1, 0, {
    expandPackages: true,
    openRandomBoxes: true,
  });
  assert.equal(opened.miscItems.length, 0, `${itemId} was not opened explicitly`);
  assert.equal(opened.units.length + opened.operators.length, 1, `${itemId} returned no testimonial reward`);
}

console.log("testimonial inventory checks passed");
