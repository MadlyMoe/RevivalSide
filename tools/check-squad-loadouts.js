const assert = require("node:assert/strict");
const { ensureArmy, ensureDeck, setDeckOperator, setDeckShip, setDeckUnit } = require("../modules/unit");

const user = {
  userUid: "1",
  army: {
    units: { 101: { unitUid: "101", userUid: "1", unitId: 1001, level: 1 } },
    ships: { 201: { unitUid: "201", userUid: "1", unitId: 21001, level: 1 } },
    operators: { 301: { uid: "301", id: 10001, level: 1 } },
  },
};

ensureArmy(user);

setDeckUnit(user, { deckType: 1, index: 0 }, 0, "101");
setDeckUnit(user, { deckType: 1, index: 1 }, 0, "101");
assert.equal(ensureDeck(user, { deckType: 1, index: 0 }).unitUids[0], "101");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).unitUids[0], "101");
setDeckUnit(user, { deckType: 1, index: 1 }, 1, "101");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).unitUids[0], 0);
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).unitUids[1], "101");

for (const index of [0, 1]) {
  setDeckShip(user, { deckType: 1, index }, "201");
  setDeckOperator(user, { deckType: 1, index }, "301");
}
assert.equal(ensureDeck(user, { deckType: 1, index: 0 }).shipUid, "201");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).shipUid, "201");
assert.equal(ensureDeck(user, { deckType: 1, index: 0 }).operatorUid, "301");
assert.equal(ensureDeck(user, { deckType: 1, index: 1 }).operatorUid, "301");

for (const index of [0, 1]) {
  setDeckUnit(user, { deckType: 8, index }, 0, "101");
  setDeckShip(user, { deckType: 8, index }, "201");
  setDeckOperator(user, { deckType: 8, index }, "301");
}
assert.equal(ensureDeck(user, { deckType: 8, index: 0 }).unitUids[0], 0);
assert.equal(ensureDeck(user, { deckType: 8, index: 0 }).shipUid, 0);
assert.equal(ensureDeck(user, { deckType: 8, index: 0 }).operatorUid, 0);
assert.equal(ensureDeck(user, { deckType: 8, index: 1 }).unitUids[0], "101");
assert.equal(ensureDeck(user, { deckType: 8, index: 1 }).shipUid, "201");
assert.equal(ensureDeck(user, { deckType: 8, index: 1 }).operatorUid, "301");

console.log("Squad loadout checks passed.");
