const assert = require("node:assert/strict");
const {
  INVENTORY_TYPES,
  INVENTORY_DEFINITIONS,
  MAX_INVENTORY_CAPACITY,
  applyInventoryExpansion,
  getInventoryCapacity,
  getInventoryCapacities,
  initializeInventoryCapacities,
} = require("../modules/inventory-capacity");
const { setMiscItemBalance } = require("../modules/inventory");

const defaults = {
  inventory: { misc: {}, equips: {} },
  army: { units: {}, ships: {}, trophies: {}, operators: {} },
};
assert.equal(getInventoryCapacity(defaults, INVENTORY_TYPES.SHIP), 10, "new profiles must start at the frozen default");
for (let index = 0; index < 10; index += 1) {
  defaults.army.ships[String(index + 1)] = { unitUid: String(index + 1), unitId: 26001 };
}
assert.equal(getInventoryCapacity(defaults, INVENTORY_TYPES.SHIP), 10, "usage must not silently grow initialized capacity");
setMiscItemBalance(defaults, 101, 100);
assert.equal(applyInventoryExpansion(defaults, INVENTORY_TYPES.SHIP, 1).expandedCount, 11);

const imported = {
  army: {
    units: Object.fromEntries(
      Array.from({ length: 370 }, (_, index) => [String(index + 1), { unitUid: String(index + 1), unitId: 1001 }])
    ),
    ships: Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [String(index + 1), { unitUid: String(index + 1), unitId: 201 }])
    ),
    operators: Object.fromEntries(
      Array.from({ length: 241 }, (_, index) => [String(index + 1), { uid: String(index + 1), id: 3001 }])
    ),
    trophies: {},
  },
  inventoryExpansion: { unit: 205, ship: 10 },
};
initializeInventoryCapacities(imported);

assert.equal(getInventoryCapacity(imported, INVENTORY_TYPES.UNIT), 375);
assert.equal(getInventoryCapacity(imported, INVENTORY_TYPES.SHIP), 32);
assert.equal(getInventoryCapacity(imported, INVENTORY_TYPES.OPERATOR), 245);

const capacities = getInventoryCapacities(imported);
assert.equal(capacities.unit, 375);
assert.equal(capacities.ship, 32);
assert.ok(capacities.unit > Object.keys(imported.army.units).length);
assert.ok(capacities.ship > Object.keys(imported.army.ships).length);
assert.ok(capacities.operator > Object.keys(imported.army.operators).length);
for (const definition of Object.values(INVENTORY_DEFINITIONS)) {
  assert.equal(definition.max, MAX_INVENTORY_CAPACITY, "every RevivalSide inventory must expand to signed int max");
}
setMiscItemBalance(imported, 101, 100);
const expanded = applyInventoryExpansion(imported, INVENTORY_TYPES.UNIT, 1);
assert.equal(expanded.errorCode, 0);
assert.equal(expanded.expandedCount, 380, "imported capacity must expand from its usage-safe starting size");
assert.equal(getInventoryCapacity(imported, INVENTORY_TYPES.UNIT), 380);

console.log(`imported inventory capacity verified: units=${expanded.expandedCount} ships=${capacities.ship} operators=${capacities.operator} max=${MAX_INVENTORY_CAPACITY}`);
