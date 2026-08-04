"use strict";

const assert = require("assert");
const { addUnitExp, getUnitMaxLevel, limitBreakUnit } = require("../modules/unit");

function makeUser(rank, level) {
  const unit = { unitUid: "1", userUid: "1", unitId: 1001, limitBreakLevel: rank, level, exp: 0 };
  return { userUid: "1", army: { units: { 1: unit }, ships: {}, trophies: {}, operators: {} } };
}

const ordinary = makeUser(0, 1);
assert.equal(limitBreakUnit(ordinary, "1").limitBreakLevel, 1);

const shipStyle = makeUser(0, 100);
assert.equal(limitBreakUnit(shipStyle, "1", { maxLimitBreakLevel: 6 }).limitBreakLevel, 1);

const fusion = makeUser(0, 100);
for (let rank = 4; rank <= 13; rank += 1) {
  const unit = limitBreakUnit(fusion, "1");
  const expectedCap = 100 + (rank - 3) * 2;
  assert.equal(unit.limitBreakLevel, rank);
  assert.equal(getUnitMaxLevel(unit), expectedCap);
  assert.equal(addUnitExp(fusion, "1", Number.MAX_SAFE_INTEGER).level, expectedCap);
}
assert.equal(limitBreakUnit(fusion, "1").limitBreakLevel, 13);
assert.equal(getUnitMaxLevel(fusion.army.units[1]), 120);

console.log("unit limit break caps verified: 102-110 and fusion 112-120");
