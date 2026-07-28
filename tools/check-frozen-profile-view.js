"use strict";

const assert = require("assert");

process.env.CS_GAMEPLAY_ASSET_SOURCE = "packaged";

const gameData = require("../modules/game-data");
const collection = require("../modules/collection");
const lobby = require("../modules/lobby");
const contract = require("../modules/contract");
const admin = require("../modules/admin");
const { filterFrozenInventoryMiscItems } = require("../modules/frozen-content-compat");

const data = gameData.loadGameData();
const unitId = gameData.getPlayableUnitIds()[0];
const titleId = Array.from(data.userTitleById.keys())[0];
const miscId = Array.from(data.miscItems.keys())[0];
const contractId = Array.from(data.contracts.keys())[0];
const missingId = 2147483647;

assert(unitId > 0, "packaged unit table is empty");
assert(titleId > 0, "packaged title table is empty");
assert(miscId > 0, "packaged misc table is empty");
assert(contractId > 0, "packaged contract table is empty");

const user = {
  userUid: "1000000001",
  friendCode: "10000001",
  nickname: "FrozenTest",
  army: {
    units: {
      "9000000000000001": { unitUid: "9000000000000001", unitId },
    },
    ships: {},
    trophies: {},
    operators: {},
    deckSets: {},
    decks: [],
  },
  collection: {
    units: [unitId, missingId],
    ships: [],
    trophies: [],
    operators: [],
    skins: [],
  },
  lobbyCustomization: {
    backgroundInfo: {
      backgroundItemId: 0,
      backgroundBgmId: 0,
      unitInfoList: [
        { unitUid: "9000000000000001", unitType: 0 },
        { unitUid: "9000000000000999", unitType: 0 },
      ],
    },
    jukeboxBgmIds: {},
  },
  contractStates: {
    [contractId]: { contractId },
    [missingId]: { contractId: missingId },
  },
  contractBonusStates: {
    [missingId]: { bonusGroupId: missingId },
  },
  customPickupContracts: {},
};

const illustratedIds = collection.buildIllustratedUnitIds(user);
assert(illustratedIds.includes(unitId), "known illustrated unit was removed");
assert(!illustratedIds.includes(missingId), "unknown illustrated unit reached the frozen client");

const background = lobby.getCompatibleBackgroundInfo(user);
assert.deepStrictEqual(background.unitInfoList.map((entry) => String(entry.unitUid)), ["9000000000000001"]);

assert.strictEqual(gameData.getCompatibleUserTitleId(titleId), titleId);
assert.strictEqual(gameData.getCompatibleUserTitleId(missingId), 0);

const contractStates = contract.getAllContractStates(user, {});
assert(contractStates.some((state) => Number(state.contractId) === contractId), "known contract state was removed");
assert(!contractStates.some((state) => Number(state.contractId) === missingId), "unknown contract state reached the frozen client");
assert(!contract.getAllContractBonusStates(user, {}).some((state) => Number(state.bonusGroupId) === missingId));

assert.strictEqual(admin.isFrozenRewardSpec({ rewardType: "RT_MISC", id: miscId, count: 1 }), true);
assert.strictEqual(admin.isFrozenRewardSpec({ rewardType: "RT_MISC", id: missingId, count: 1 }), false);

assert.deepStrictEqual(
  filterFrozenInventoryMiscItems(
    [{ itemId: miscId }, { itemId: missingId }],
    gameData.getMiscItemTemplet
  ).map((item) => item.itemId),
  [miscId]
);

console.log("[frozen-profile-view] PASS missions/inventory/profile/collection/contracts/mail/lobby compatibility guards");
