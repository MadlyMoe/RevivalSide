#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { loadGameData } = require("../modules/game-data");
const { loadShopCatalog } = require("../modules/shop");
const { readGameplayTableRecords } = require("../modules/gameplay-jsons");
const { hasFrozenMissionSnapshot } = require("../modules/frozen-content-compat");

const DEFAULT_USERS_PATH = path.join(
  process.env.LOCALAPPDATA || "",
  "RevivalSide",
  "server-data",
  "users.json"
);
const SAMPLE_LIMIT = 12;

function parseArgs(argv) {
  const args = { usersPath: DEFAULT_USERS_PATH, uid: "", json: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--users") args.usersPath = path.resolve(argv[++index]);
    else if (value === "--uid") args.uid = String(argv[++index] || "");
    else if (value === "--json") args.json = true;
    else if (value === "--strict") args.strict = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function printHelp() {
  console.log("Usage: node tools/audit-frozen-profile-compat.js [--users PATH] [--uid UID] [--json] [--strict]");
  console.log("Scans live serialized profile references against the currently selected frozen gameplay tables.");
}

function records(directory, fileName) {
  try {
    return readGameplayTableRecords(directory, fileName);
  } catch (_error) {
    return [];
  }
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function idSet(rows, ...fields) {
  const result = new Set();
  for (const row of rows) {
    for (const field of fields) {
      const id = positiveInt(row && row[field]);
      if (id) {
        result.add(id);
        break;
      }
    }
  }
  return result;
}

function values(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function entries(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value);
  return [];
}

function buildCatalogs() {
  const game = loadGameData();
  const shop = loadShopCatalog();
  const raw = {
    stages: records("ab_script", "LUA_STAGE_TEMPLET.json"),
    dungeons: records("ab_script_dungeon_templet", "LUA_DUNGEON_TEMPLET_BASE.json"),
    officeSections: records("ab_script", "LUA_OFFICE_SECTION_TEMPLET.json"),
    officeRooms: records("ab_script", "LUA_OFFICE_ROOM_TEMPLET.json"),
    interiors: records("ab_script", "LUA_ITEM_INTERIOR_TEMPLET.json"),
    attendanceTabs: records("ab_script", "LUA_ATTENDANCE_TAB_TEMPLET.json"),
    worldMapCities: records("ab_script", "LUA_WORLDMAP_CITY_TEMPLET.json"),
    worldMapMissions: records("ab_script", "LUA_WORLDMAP_MISSION_TEMPLET.json"),
    worldMapBuildings: records("ab_script", "LUA_WORLDMAP_CITY_BUILDING.json"),
    dives: records("ab_script", "LUA_DIVE_TEMPLET.json"),
    raids: records("ab_script", "LUA_RAID_TEMPLET.json"),
    eventPasses: records("ab_script", "LUA_EVENT_PASS_TEMPLET.json"),
    eventPassMissions: records("ab_script", "LUA_EVENT_PASS_MISSION_GROUP_TEMPLET.json"),
    titles: records("ab_script", "LUA_USER_TITLE_TEMPLET.json"),
    bgms: records("ab_script", "LUA_BGM_INFO_TEMPLETE.json"),
    collectionMisc: records("ab_script", "LUA_COLLECTION_V2_MISC.json"),
    collectionTeams: records("ab_script", "LUA_COLLECTION_TEAMUP_TEMPLET.json"),
    episodes: [
      ...records("ab_script", "LUA_EPISODE_TEMPLET.json"),
      ...records("ab_script", "LUA_EPISODE_TEMPLET_V2.json"),
    ],
  };

  const passMissionIds = new Set();
  for (const row of raw.eventPassMissions) {
    for (const id of values(row && row.MissionID)) {
      const normalized = positiveInt(id);
      if (normalized) passMissionIds.add(normalized);
    }
  }
  const contractBonusGroups = new Set();
  for (const record of [...game.contracts.values(), ...game.contractTabs.values(), ...game.customPickupContracts]) {
    const id = positiveInt(
      record && (record.m_ContractBonusCountGroupID || record.ContractBonusCountGroupID || record.m_ContractID || record.customPickupId)
    );
    if (id) contractBonusGroups.add(id);
  }

  return {
    game,
    shop,
    raw,
    sets: {
      misc: new Set(game.miscItems.keys()),
      units: new Set(game.unitById.keys()),
      collectionUnits: new Set(game.collectionUnitById.keys()),
      equips: new Set(game.equipById.keys()),
      equipSets: new Set(game.equipSetOptions.keys()),
      equipMolds: new Set(game.equipMolds.keys()),
      skins: new Set(game.skinById.keys()),
      emoticons: new Set(game.emoticonById.keys()),
      contracts: new Set([...game.contracts.keys(), ...game.selectableContracts.keys(), ...game.contractTabs.keys()]),
      customPickupContracts: idSet(game.customPickupContracts, "customPickupId"),
      contractBonusGroups,
      missionTabs: new Set(game.missionTabById.keys()),
      stages: idSet(raw.stages, "m_StageID"),
      dungeons: idSet(raw.dungeons, "m_DungeonID"),
      officeSections: idSet(raw.officeSections, "SectionID"),
      officeRooms: idSet(raw.officeRooms, "ID"),
      interiors: idSet(raw.interiors, "m_ItemMiscID"),
      attendanceTabs: idSet(raw.attendanceTabs, "IDX"),
      worldMapCities: idSet(raw.worldMapCities, "m_CityID"),
      worldMapMissions: idSet(raw.worldMapMissions, "m_WorldmapMissionID"),
      worldMapBuildings: idSet(raw.worldMapBuildings, "m_BuildingID", "BuildingID", "ID"),
      dives: idSet(raw.dives, "STAGE_ID"),
      raids: idSet(raw.raids, "m_StageID"),
      eventPasses: idSet(raw.eventPasses, "EventPassID"),
      passMissionIds,
      titles: idSet(raw.titles, "UserTitleID"),
      bgms: idSet(raw.bgms, "IDX"),
      collectionMisc: idSet(raw.collectionMisc, "CollectionItemID"),
      collectionTeams: idSet(raw.collectionTeams, "m_TeamID"),
      episodes: idSet(raw.episodes, "m_EpisodeID"),
      shopProducts: new Set(Array.from(shop.recordsByProductIdAll.keys()).map(positiveInt).filter(Boolean)),
    },
  };
}

function createReporter(userUid) {
  const checks = new Map();
  const mismatches = [];

  function check(category, profilePath, rawId, set, options = {}) {
    const id = positiveInt(rawId);
    if (!id && options.allowZero !== false) return;
    const key = `${category}:${options.classification || "persisted-reference"}`;
    if (!checks.has(key)) checks.set(key, { category, classification: options.classification || "persisted-reference", checked: 0, mismatched: 0 });
    const stat = checks.get(key);
    stat.checked += 1;
    if (id && set.has(id)) return;
    stat.mismatched += 1;
    mismatches.push({
      userUid,
      category,
      classification: options.classification || "persisted-reference",
      path: profilePath,
      id: id || Number(rawId) || rawId,
      expected: options.expected || "frozen gameplay table entry",
    });
  }

  function internal(category, profilePath, rawId, set, options = {}) {
    const id = String(rawId == null ? "" : rawId);
    if (!id || id === "0") return;
    const classification = options.classification || "persisted-internal-reference";
    const key = `${category}:${classification}`;
    if (!checks.has(key)) checks.set(key, { category, classification, checked: 0, mismatched: 0 });
    const stat = checks.get(key);
    stat.checked += 1;
    if (set.has(id)) return;
    stat.mismatched += 1;
    mismatches.push({
      userUid,
      category,
      classification,
      path: profilePath,
      id,
      expected: options.expected || "owned serialized object UID",
    });
  }

  return { checks, mismatches, check, internal };
}

function auditReward(reporter, reward, profilePath, sets) {
  if (!reward || typeof reward !== "object") return;
  const type = String(reward.rewardType || reward.type || reward.itemType || reward.m_RewardType || "").toUpperCase();
  const id = reward.rewardId || reward.itemId || reward.id || reward.m_RewardID;
  if (type.includes("MISC")) reporter.check("reward.misc", profilePath, id, sets.misc);
  else if (type.includes("EQUIP")) reporter.check("reward.equip", profilePath, id, sets.equips);
  else if (type.includes("SKIN")) reporter.check("reward.skin", profilePath, id, sets.skins);
  else if (type.includes("OPERATOR") || type.includes("UNIT") || type.includes("SHIP")) {
    reporter.check("reward.unit", profilePath, id, sets.units);
  }
}

function auditUser(user, catalogs) {
  const { game, sets } = catalogs;
  const userUid = String(user.userUid || user.uid || "unknown");
  const reporter = createReporter(userUid);
  const { check, internal } = reporter;

  check("profile.mainUnit", "mainUnitId", user.mainUnitId, sets.units);
  check("profile.mainSkin", "mainUnitSkinId", user.mainUnitSkinId, sets.skins);
  check("profile.frame", "frameId", user.frameId, sets.misc);
  check("profile.selfiFrame", "selfiFrameId", user.selfiFrameId, sets.misc);
  check("profile.title", "titleId", user.titleId, sets.titles);
  values(user.profileEmblems).forEach((emblem, index) =>
    check("profile.emblem", `profileEmblems[${index}].id`, emblem && emblem.id, sets.collectionMisc)
  );

  const inventory = user.inventory || {};
  values(inventory.misc).forEach((item, index) => check("inventory.misc", `inventory.misc[${index}].itemId`, item && item.itemId, sets.misc));
  const equips = values(inventory.equips);
  const equipUids = new Set(equips.map((item) => String(item && (item.equipUid || item.uid) || "")).filter(Boolean));
  equips.forEach((item, index) => {
    check("inventory.equip", `inventory.equips[${index}].itemEquipId`, item && item.itemEquipId, sets.equips);
    check("inventory.equipSet", `inventory.equips[${index}].setOptionId`, item && item.setOptionId, sets.equipSets);
    check("inventory.equipImprintUnit", `inventory.equips[${index}].imprintUnitId`, item && item.imprintUnitId, sets.units);
  });
  values(inventory.skins).forEach((id, index) => check("inventory.skin", `inventory.skins[${index}]`, id, sets.skins));
  values(inventory.emoticons).forEach((id, index) => check("inventory.emoticon", `inventory.emoticons[${index}]`, id, sets.emoticons));
  values(inventory.equipPresets).forEach((preset, presetIndex) =>
    values(preset && preset.equipUids).forEach((uid, index) =>
      internal("inventory.equipPresetUid", `inventory.equipPresets[${presetIndex}].equipUids[${index}]`, uid, equipUids)
    )
  );

  const army = user.army || {};
  const units = values(army.units);
  const ships = values(army.ships);
  const trophies = values(army.trophies);
  const operators = values(army.operators);
  const unitUids = new Set([...units, ...ships, ...trophies].map((unit) => String(unit && unit.unitUid || "")).filter(Boolean));
  const operatorUids = new Set(operators.map((operator) => String(operator && (operator.uid || operator.operatorUid) || "")).filter(Boolean));
  for (const [kind, list] of [["unit", units], ["ship", ships], ["trophy", trophies]]) {
    list.forEach((unit, index) => {
      check(`army.${kind}`, `army.${kind}s[${index}].unitId`, unit && unit.unitId, sets.units);
      check(`army.${kind}Skin`, `army.${kind}s[${index}].skinId`, unit && unit.skinId, sets.skins);
      values(unit && (unit.equipUids || unit.equipItemUids)).forEach((uid, slot) =>
        internal(`army.${kind}EquipUid`, `army.${kind}s[${index}].equipUids[${slot}]`, uid, equipUids)
      );
    });
  }
  operators.forEach((operator, index) => check("army.operator", `army.operators[${index}].id`, operator && operator.id, sets.units));
  values(army.deckSets).flatMap(values).concat(values(army.decks)).forEach((deck, index) => {
    internal("army.deckShipUid", `army.decks[${index}].shipUid`, deck && (deck.shipUid || deck.m_ShipUID), unitUids);
    internal("army.deckOperatorUid", `army.decks[${index}].operatorUid`, deck && (deck.operatorUid || deck.m_OperatorUID), operatorUids);
    values(deck && (deck.unitUids || deck.m_listDeckUnitUID)).forEach((uid, slot) =>
      internal("army.deckUnitUid", `army.decks[${index}].unitUids[${slot}]`, uid, unitUids)
    );
  });

  const progressSources = [
    ["unlockedStage", values(user.unlockedStageIds).map((id) => ({ stageId: id }))],
    ["stagePlay", values(user.stagePlayData)],
    ["mainStory", values(user.mainStory && user.mainStory.stages)],
    ["episode1", values(user.episode1 && user.episode1.stages)],
    ["clearStage", values(user.clearConditions && user.clearConditions.stages)],
  ];
  for (const [kind, list] of progressSources) {
    list.forEach((entry, index) => {
      check(`progress.${kind}.stage`, `${kind}[${index}].stageId`, entry && (entry.stageId || entry.stageID), sets.stages);
      check(`progress.${kind}.dungeon`, `${kind}[${index}].dungeonId`, entry && (entry.dungeonId || entry.dungeonID), sets.dungeons);
    });
  }
  values(user.dungeonClear).forEach((entry, index) => {
    check("progress.dungeonClear.dungeon", `dungeonClear[${index}].dungeonId`, entry && entry.dungeonId, sets.dungeons);
    check("progress.dungeonClear.stage", `dungeonClear[${index}].stageId`, entry && entry.stageId, sets.stages);
  });
  values(user.clearConditions && user.clearConditions.dungeons).forEach((entry, index) => {
    check("progress.clearDungeon.dungeon", `clearConditions.dungeons[${index}].dungeonId`, entry && entry.dungeonId, sets.dungeons);
    check("progress.clearDungeon.stage", `clearConditions.dungeons[${index}].stageId`, entry && entry.stageId, sets.stages);
  });
  values(user.stageFavorites).forEach((id, index) => check("progress.stageFavorite", `stageFavorites[${index}]`, id, sets.stages));
  entries(user.persistentCutsceneViews).forEach(([id], index) =>
    check("progress.cutsceneDungeon", `persistentCutsceneViews[${index}]`, id, sets.dungeons)
  );
  const tutorial = user.tutorial || {};
  check("tutorial.firstStage", "tutorial.firstStageId", tutorial.firstStageId, sets.stages);
  check("tutorial.firstDungeon", "tutorial.firstDungeonId", tutorial.firstDungeonId, sets.dungeons);
  check("tutorial.nextStage", "tutorial.nextStageId", tutorial.nextStageId, sets.stages);
  check("tutorial.nextDungeon", "tutorial.nextDungeonId", tutorial.nextDungeonId, sets.dungeons);
  values(tutorial.phases).forEach((phase, index) => {
    check("tutorial.phaseStage", `tutorial.phases[${index}].stageId`, phase && phase.stageId, sets.stages);
    check("tutorial.phaseDungeon", `tutorial.phases[${index}].dungeonId`, phase && phase.dungeonId, sets.dungeons);
  });
  values(user.gameplayUnlocks && user.gameplayUnlocks.byKey).forEach((unlock, index) => {
    check("gameplayUnlock.stage", `gameplayUnlocks.byKey[${index}].stageId`, unlock && unlock.stageId, sets.stages);
    if (String(unlock && unlock.reqType || "").includes("DUNGEON")) {
      check("gameplayUnlock.dungeon", `gameplayUnlocks.byKey[${index}].reqValue`, unlock && unlock.reqValue, sets.dungeons);
    }
  });

  entries(user.completedMissions).forEach(([key, mission]) => {
    const tabId = positiveInt(mission && (mission.tabId || mission.missionTabId)) || 1;
    const missionId = positiveInt(mission && (mission.missionID || mission.missionId || mission.id)) || positiveInt(String(key).split(":")[0]);
    const groupId = positiveInt(mission && (mission.groupId || mission.group_id || mission.missionGroupId)) || missionId;
    check("mission.tab", `completedMissions.${key}.tabId`, tabId, sets.missionTabs);
    const exact = hasFrozenMissionSnapshot(game.missionsByTabId.get(tabId) || [], { tabId, missionID: missionId, groupId });
    const syntheticSet = exact ? new Set([missionId]) : new Set();
    check("mission.snapshot", `completedMissions.${key}`, missionId, syntheticSet, { expected: "exact frozen mission tab/id/group tuple" });
  });

  entries(user.contractStates).forEach(([key, state]) =>
    check("contract.state", `contractStates.${key}`, state && (state.contractId || state.id) || key, sets.contracts)
  );
  entries(user.contractBonusStates).forEach(([key, state]) =>
    check("contract.bonus", `contractBonusStates.${key}`, state && state.bonusGroupId || key, sets.contractBonusGroups)
  );
  check("contract.selectable", "selectableContractState.contractId", user.selectableContractState && user.selectableContractState.contractId, sets.contracts);
  entries(user.customPickupContracts).forEach(([key, state]) =>
    check("contract.customPickup", `customPickupContracts.${key}`, state && state.customPickupId || key, sets.customPickupContracts)
  );

  entries(user.shopPurchaseHistory).forEach(([key, history]) =>
    check("shop.purchaseHistory", `shopPurchaseHistory.${key}`, history && history.shopId || key, sets.shopProducts)
  );
  values(user.randomShop && user.randomShop.slots).forEach((slot, index) => {
    const type = String(slot && slot.itemType || "").toUpperCase();
    if (type.includes("MISC")) check("shop.randomItem.misc", `randomShop.slots[${index}].itemId`, slot.itemId, sets.misc);
    else if (type.includes("EQUIP")) check("shop.randomItem.equip", `randomShop.slots[${index}].itemId`, slot.itemId, sets.equips);
    else if (type.includes("SKIN")) check("shop.randomItem.skin", `randomShop.slots[${index}].itemId`, slot.itemId, sets.skins);
    else if (type.includes("UNIT") || type.includes("SHIP") || type.includes("OPERATOR")) {
      check("shop.randomItem.unit", `randomShop.slots[${index}].itemId`, slot.itemId, sets.units);
    }
    check("shop.randomPrice", `randomShop.slots[${index}].priceItemId`, slot && slot.priceItemId, sets.misc);
  });

  const office = user.office || {};
  values(office.openedSectionIds).forEach((id, index) => check("office.section", `office.openedSectionIds[${index}]`, id, sets.officeSections));
  values(office.rooms).forEach((room, index) => {
    check("office.room", `office.rooms[${index}].id`, room && room.id, sets.officeRooms);
    for (const field of ["floorInteriorId", "wallInteriorId", "backgroundId"]) {
      check("office.interior", `office.rooms[${index}].${field}`, room && room[field], sets.interiors);
    }
    values(room && room.furnitures).forEach((furniture, furnitureIndex) =>
      check("office.furniture", `office.rooms[${index}].furnitures[${furnitureIndex}].itemId`, furniture && furniture.itemId, sets.interiors)
    );
    values(room && room.unitUids).forEach((uid, unitIndex) =>
      internal("office.unitUid", `office.rooms[${index}].unitUids[${unitIndex}]`, uid, unitUids)
    );
  });
  values(office.interiors).forEach((item, index) => check("office.interiorInventory", `office.interiors[${index}].itemId`, item && item.itemId, sets.interiors));

  const worldMap = user.worldMap || {};
  values(worldMap.cities).forEach((city, index) => {
    check("worldMap.city", `worldMap.cities[${index}].cityID`, city && city.cityID, sets.worldMapCities);
    internal("worldMap.leaderUid", `worldMap.cities[${index}].leaderUnitUID`, city && city.leaderUnitUID, unitUids);
    const mission = city && city.mission || {};
    check("worldMap.currentMission", `worldMap.cities[${index}].mission.currentMissionID`, mission.currentMissionID, sets.worldMapMissions);
    values(mission.stMissionIDList).forEach((id, missionIndex) =>
      check("worldMap.missionPool", `worldMap.cities[${index}].mission.stMissionIDList[${missionIndex}]`, id, sets.worldMapMissions)
    );
    values(city && (city.buildings || city.buildingDataMap)).forEach((building, buildingIndex) =>
      check("worldMap.building", `worldMap.cities[${index}].buildings[${buildingIndex}]`, building && (building.id || building.buildingID), sets.worldMapBuildings)
    );
  });
  values(worldMap.diveClearStages).forEach((id, index) => check("worldMap.diveClear", `worldMap.diveClearStages[${index}]`, id, sets.dives));
  values(worldMap.diveHistoryStages).forEach((id, index) => check("worldMap.diveHistory", `worldMap.diveHistoryStages[${index}]`, id, sets.dives));
  values(worldMap.raids).forEach((raid, index) => check("worldMap.raid", `worldMap.raids[${index}].stageId`, raid && (raid.stageId || raid.raidId), sets.raids));

  entries(user.attendance && user.attendance.tabs).forEach(([key, tab]) =>
    check("attendance.tab", `attendance.tabs.${key}.idx`, tab && tab.idx || key, sets.attendanceTabs)
  );
  check("attendance.activeTab", "attendance.activeTabIdx", user.attendance && user.attendance.activeTabIdx, sets.attendanceTabs);

  entries(user.counterPass && user.counterPass.passes).forEach(([key, pass]) => {
    check("counterPass.pass", `counterPass.passes.${key}`, key, sets.eventPasses);
    for (const [kind, missions] of entries(pass && pass.missions)) {
      values(missions).forEach((mission, index) =>
        check("counterPass.mission", `counterPass.passes.${key}.missions.${kind}[${index}].missionId`, mission && mission.missionId, sets.passMissionIds)
      );
    }
  });

  entries(user.craft && user.craft.molds).forEach(([key, mold]) =>
    check("craft.mold", `craft.molds.${key}.moldId`, mold && mold.moldId || key, sets.equipMolds)
  );
  values(user.craft && user.craft.slots).forEach((slot, index) =>
    check("craft.slotMold", `craft.slots[${index}].moldId`, slot && slot.moldId, sets.equipMolds)
  );

  const collection = user.collection || {};
  for (const kind of ["units", "ships", "trophies", "operators"]) {
    values(collection[kind]).forEach((id, index) => check(`collection.${kind}`, `collection.${kind}[${index}]`, id, sets.collectionUnits));
  }
  values(collection.skins).forEach((id, index) => check("collection.skins", `collection.skins[${index}]`, id, sets.skins));
  entries(collection.teamRewards).forEach(([key, reward]) =>
    check("collection.teamReward", `collection.teamRewards.${key}`, reward && reward.teamId || key, sets.collectionTeams)
  );
  entries(collection.miscRewards).forEach(([key, reward]) =>
    check("collection.miscReward", `collection.miscRewards.${key}`, reward && reward.miscId || key, sets.collectionMisc)
  );
  entries(collection.episodeRewards).forEach(([key]) =>
    check("collection.episodeReward", `collection.episodeRewards.${key}`, String(key).split(":")[0], sets.episodes)
  );

  const background = user.lobbyCustomization && user.lobbyCustomization.backgroundInfo || {};
  check("lobby.background", "lobbyCustomization.backgroundInfo.backgroundItemId", background.backgroundItemId, sets.misc);
  check("lobby.bgm", "lobbyCustomization.backgroundInfo.backgroundBgmId", background.backgroundBgmId, sets.bgms);
  values(background.unitInfoList).forEach((info, index) =>
    internal("lobby.unitUid", `lobbyCustomization.backgroundInfo.unitInfoList[${index}].unitUid`, info && info.unitUid, unitUids)
  );
  internal("support.unitUid", "support.mySupportUnitUid", user.support && user.support.mySupportUnitUid, unitUids);
  entries(user.stamina && user.stamina.chargeItems).forEach(([key], index) =>
    check("stamina.item", `stamina.chargeItems[${index}]`, key, sets.misc)
  );
  values(user.lobbyCustomization && user.lobbyCustomization.jukeboxBgmIds).forEach((id, index) =>
    check("lobby.jukeboxBgm", `lobbyCustomization.jukeboxBgmIds[${index}]`, id, sets.bgms)
  );

  values(user.admin && user.admin.posts).forEach((post, postIndex) =>
    values(post && (post.rewards || post.rewardItems || post.items)).forEach((reward, rewardIndex) =>
      auditReward(reporter, reward, `admin.posts[${postIndex}].rewards[${rewardIndex}]`, sets)
    )
  );

  return {
    userUid,
    nickname: String(user.nickname || ""),
    checks: Array.from(reporter.checks.values()).sort((left, right) => left.category.localeCompare(right.category)),
    mismatches: reporter.mismatches,
  };
}

function summarizeResults(results, usersPath) {
  const checks = new Map();
  const mismatches = [];
  for (const result of results) {
    mismatches.push(...result.mismatches);
    for (const stat of result.checks) {
      const key = `${stat.category}:${stat.classification}`;
      const current = checks.get(key) || { ...stat, checked: 0, mismatched: 0 };
      current.checked += stat.checked;
      current.mismatched += stat.mismatched;
      checks.set(key, current);
    }
  }
  const categories = Array.from(checks.values()).sort(
    (left, right) => right.mismatched - left.mismatched || left.category.localeCompare(right.category)
  );
  return {
    generatedAt: new Date().toISOString(),
    usersPath,
    gameplayTablesDir: process.env.CS_GAMEPLAY_TABLES_DIR || "",
    userCount: results.length,
    checkedReferences: categories.reduce((sum, item) => sum + item.checked, 0),
    mismatchCount: mismatches.length,
    mismatchedCategories: categories.filter((item) => item.mismatched > 0),
    allCategories: categories,
    samples: mismatches.slice(0, SAMPLE_LIMIT),
    users: results.map((result) => ({
      userUid: result.userUid,
      nickname: result.nickname,
      mismatchCount: result.mismatches.length,
      samples: result.mismatches.slice(0, SAMPLE_LIMIT),
    })),
  };
}

function printText(report) {
  console.log(`Frozen profile compatibility: users=${report.userCount} checked=${report.checkedReferences} mismatches=${report.mismatchCount}`);
  console.log(`tables=${report.gameplayTablesDir || "<default discovery>"}`);
  if (!report.mismatchedCategories.length) {
    console.log("No live profile/template mismatches found.");
    return;
  }
  console.log("Mismatched categories:");
  for (const item of report.mismatchedCategories) {
    console.log(`  ${item.category} [${item.classification}] ${item.mismatched}/${item.checked}`);
  }
  console.log("Samples:");
  for (const item of report.samples) {
    console.log(`  uid=${item.userUid} ${item.category} ${item.path} id=${item.id} expected=${item.expected}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (!fs.existsSync(args.usersPath)) throw new Error(`Users database not found: ${args.usersPath}`);
  const database = JSON.parse(fs.readFileSync(args.usersPath, "utf8"));
  const allUsers = Array.isArray(database.users) ? database.users : Object.values(database.users || {});
  const users = args.uid ? allUsers.filter((user) => String(user.userUid || user.uid) === args.uid) : allUsers;
  if (!users.length) throw new Error(args.uid ? `User ${args.uid} was not found` : "No users found in database");
  const catalogs = buildCatalogs();
  const report = summarizeResults(users.map((user) => auditUser(user, catalogs)), args.usersPath);
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printText(report);
  if (args.strict && report.mismatchCount > 0) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = { auditUser, buildCatalogs, summarizeResults };
