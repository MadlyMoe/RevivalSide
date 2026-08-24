const path = require("path");
const { readGameplayTable, readGameplayTableRecords } = require("../gameplay-jsons");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_COUNTER_PASS_UNLOCK_DUNGEON_IDS = Object.freeze([1001421]);

let cachedData = null;

function loadGameData() {
  if (cachedData) return cachedData;

  const miscItems = new Map();
  const miscItemsByStrId = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_ITEM_MISC_TEMPLET.json")) {
    const itemId = Number(record && record.m_ItemMiscID);
    if (!Number.isInteger(itemId) || itemId <= 0 || miscItems.has(itemId)) continue;
    miscItems.set(itemId, record);
    if (record.m_ItemMiscStrID) miscItemsByStrId.set(String(record.m_ItemMiscStrID), record);
  }

  const randomItemBoxes = groupByNumber(readRecords("ab_script", "LUA_RANDOM_ITEM_BOX.json"), "m_RewardGroupID");
  const customPackageBoxes = groupByNumber(readRecords("ab_script", "LUA_CUSTOM_PACKAGE_ITEM_BOX.json"), "m_CustomRewardGroupID");
  const customBoxes = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_CUSTOM_BOX_TEMPLET.json")) {
    const customBoxId = Number(record && record.CustomBoxID);
    if (Number.isInteger(customBoxId) && customBoxId > 0 && !customBoxes.has(customBoxId)) customBoxes.set(customBoxId, record);
  }
  const acqPackages = groupByNumber(readRecords("ab_script", "LUA_ACQ_PACKAGE_TEMPLET.json"), "m_PackageID");
  const rewardGroups = groupByNumber(readRecords("ab_script", "LUA_REWARD_TEMPLET_CL.json"), "m_RewardGroupID");

  const unitById = new Map();
  const unitByStrId = new Map();
  const collectionUnitById = new Map();
  const collectionUnitByStrId = new Map();
  for (const fileName of [
    "LUA_UNIT_TEMPLET_BASE.json",
    "LUA_UNIT_TEMPLET_BASE2.json",
    "LUA_UNIT_TEMPLET_BASE_SD.json",
    "LUA_UNIT_TEMPLET_BASE_OPR.json",
  ]) {
    for (const record of readRecords("ab_script_unit_data", fileName)) {
      const unitId = Number(record && record.m_UnitID);
      if (!Number.isInteger(unitId) || unitId <= 0 || unitById.has(unitId)) continue;
      unitById.set(unitId, record);
      if (record.m_UnitStrID) unitByStrId.set(String(record.m_UnitStrID), record);
    }
  }

  const collectionUnits = readRecords("ab_script", "LUA_COLLECTION_UNIT_TEMPLET.json");
  for (const record of collectionUnits) {
    const unitId = Number(record && record.m_UnitID);
    if (!Number.isInteger(unitId) || unitId <= 0) continue;
    if (!collectionUnitById.has(unitId)) collectionUnitById.set(unitId, record);
    if (record.m_UnitStrID && !collectionUnitByStrId.has(String(record.m_UnitStrID))) {
      collectionUnitByStrId.set(String(record.m_UnitStrID), record);
    }
    if (!unitById.has(unitId)) unitById.set(unitId, record);
    if (record.m_UnitStrID && !unitByStrId.has(String(record.m_UnitStrID))) {
      unitByStrId.set(String(record.m_UnitStrID), record);
    }
  }

  const unitSkillsById = new Map();
  const unitSkillsByStrId = new Map();
  const unitSkillStrIdById = new Map();
  for (const record of readRecords("ab_script_unit_data", "LUA_UNIT_SKILL_TEMPLET.json")) {
    const skillId = Number(record && record.m_UnitSkillID);
    const level = Number(record && record.m_Level);
    if (!Number.isInteger(skillId) || skillId <= 0 || !Number.isInteger(level) || level <= 0) continue;
    if (!unitSkillsById.has(skillId)) unitSkillsById.set(skillId, new Map());
    const byLevel = unitSkillsById.get(skillId);
    if (!byLevel.has(level)) byLevel.set(level, record);
    if (record.m_UnitSkillStrID && !unitSkillStrIdById.has(skillId)) {
      unitSkillStrIdById.set(skillId, String(record.m_UnitSkillStrID));
    }
    const skillStrId = String(record.m_UnitSkillStrID || "");
    if (skillStrId) {
      if (!unitSkillsByStrId.has(skillStrId)) unitSkillsByStrId.set(skillStrId, new Map());
      const byStrLevel = unitSkillsByStrId.get(skillStrId);
      if (!byStrLevel.has(level)) byStrLevel.set(level, record);
    }
  }

  const operatorSkillsById = new Map();
  const operatorSkillsByStrId = new Map();
  for (const record of readRecords("ab_script_unit_data", "LUA_OPERATOR_SKILL_TEMPLET.json")) {
    const skillId = Number(record && record.m_OperSkillID);
    const skillStrId = String(record && record.m_OperSkillStrID || "");
    if (!Number.isInteger(skillId) || skillId <= 0) continue;
    if (!operatorSkillsById.has(skillId)) operatorSkillsById.set(skillId, record);
    if (skillStrId && !operatorSkillsByStrId.has(skillStrId)) operatorSkillsByStrId.set(skillStrId, record);
  }

  const unitReactorsById = new Map();
  for (const record of readRecords("ab_script", "LUA_REACTOR_TEMPLET.json")) {
    const reactorId = Number(record && record.ReactorID);
    if (Number.isInteger(reactorId) && reactorId > 0 && !unitReactorsById.has(reactorId)) {
      unitReactorsById.set(reactorId, record);
    }
  }
  const reactorSkillsById = new Map();
  for (const record of readRecords("ab_script", "LUA_REACTOR_SKILL_TEMPLET.json")) {
    const skillId = Number(record && record.IDX);
    if (Number.isInteger(skillId) && skillId > 0 && !reactorSkillsById.has(skillId)) {
      reactorSkillsById.set(skillId, record);
    }
  }
  const rearmamentByUnitId = new Map();
  for (const record of readRecords("ab_script", "LUA_REARMAMENT_TEMPLET.json")) {
    const unitId = Number(record && record.m_RearmUnitID);
    if (Number.isInteger(unitId) && unitId > 0 && !rearmamentByUnitId.has(unitId)) {
      rearmamentByUnitId.set(unitId, record);
    }
  }
  const operatorRandomPassiveByKey = new Map();
  const operatorPassiveSkillByTokenId = new Map();
  for (const record of readRecords("ab_script_unit_data", "LUA_OPERATOR_RANDOM_PASSIVE_TEMPLET.json")) {
    const groupId = Number(record && record.m_OprPassiveGroupID);
    const skillId = Number(record && record.m_OperSkillID);
    if (groupId > 0 && skillId > 0) operatorRandomPassiveByKey.set(`${groupId}|${skillId}`, record);
    for (const suffix of ["SSR", "SR", "R", "N"]) {
      const itemId = Number(record && record[`m_ExtractItemID_${suffix}`]);
      if (itemId > 0 && skillId > 0 && !operatorPassiveSkillByTokenId.has(itemId)) {
        operatorPassiveSkillByTokenId.set(itemId, { itemId, skillId, itemGrade: `NIG_${suffix}` });
      }
    }
  }

  const pieceByItemId = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_PIECE_TEMPLET.json")) {
    const itemId = Number(record && record.m_PieceID);
    if (Number.isInteger(itemId) && itemId > 0) pieceByItemId.set(itemId, record);
  }

  const contracts = new Map();
  for (const record of readRecords("ab_script", "LUA_CONTRACT.json")) {
    const contractId = Number(record && record.m_ContractID);
    if (Number.isInteger(contractId) && contractId > 0 && !contracts.has(contractId)) contracts.set(contractId, record);
  }

  const selectableContracts = new Map();
  for (const record of readRecords("ab_script", "LUA_SELECTABLE_CONTRACT.json")) {
    const contractId = Number(record && record.m_ContractID);
    if (Number.isInteger(contractId) && contractId > 0 && !selectableContracts.has(contractId)) {
      selectableContracts.set(contractId, record);
    }
  }

  const contractTabs = new Map();
  for (const record of readRecords("ab_script", "LUA_CONTRACT_TAB_TABLE.json")) {
    const contractId = Number(record && record.m_ContractID);
    if (!Number.isInteger(contractId) || contractId <= 0 || contractTabs.has(contractId)) continue;
    contractTabs.set(contractId, record);
  }

  const contractUnitPools = readRecords("ab_script", "LUA_CONTRACT_UNIT_POOL.json");
  const selectableContractUnitPools = readRecords("ab_script", "LUA_SELECTABLE_CONTRACT_UNIT_POOL.json");
  const customPickupContracts = readRecords("ab_script", "LUA_CONTRACT_CUSTOM_PICKUP.json");
  const randomGradeTables = new Map();
  for (const record of readRecords("ab_script", "LUA_RANDOM_GRADE_TABLE.json")) {
    const id = Number(record && record.m_RandomGradeID);
    if (Number.isInteger(id) && id > 0 && !randomGradeTables.has(id)) randomGradeTables.set(id, record);
    if (record && record.m_RandomGradeStrID && !randomGradeTables.has(String(record.m_RandomGradeStrID))) {
      randomGradeTables.set(String(record.m_RandomGradeStrID), record);
    }
  }
  const miscContracts = new Map();
  for (const record of readRecords("ab_script", "LUA_MISC_CONTRACT.json")) {
    const contractId = Number(record && record.m_ContractID);
    if (Number.isInteger(contractId) && contractId > 0) miscContracts.set(contractId, record);
  }

  const equipById = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_ITEM_EQUIP_TEMPLET.json")) {
    const equipId = Number(record && record.m_ItemEquipID);
    if (Number.isInteger(equipId) && equipId > 0 && !equipById.has(equipId)) equipById.set(equipId, record);
  }
  const equipRandomStats = groupByNumber(readRecords("ab_script", "LUA_ITEM_EQUIP_RANDOM_STAT.json"), "m_StatGroupID");
  const equipPrecisionWeights = groupByNumber(
    readRecords("ab_script_item_templet", "LUA_ITEM_EQUIP_PRECISION_WEIGHT.json"),
    "PrecisionWeightId"
  );
  const equipSetOptions = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_ITEM_EQUIP_SET_OPTION.json")) {
    const setId = Number(record && record.m_EquipSetID);
    if (Number.isInteger(setId) && setId > 0 && !equipSetOptions.has(setId)) equipSetOptions.set(setId, record);
  }
  const equipEnchantExp = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_EQUIP_ENCHANT_EXP_TABLE.json")) {
    const tier = Number(record && record.m_EquipTier);
    const level = Number(record && record.m_EquipEnchantLevel);
    if (Number.isInteger(tier) && tier > 0 && Number.isInteger(level) && level >= 0) {
      equipEnchantExp.set(makeEquipEnchantExpKey(tier, level), record);
    }
  }
  const equipMolds = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_ITEM_MOLD_TEMPLET.json")) {
    const moldId = Number(record && record.m_MoldID);
    if (Number.isInteger(moldId) && moldId > 0 && !equipMolds.has(moldId)) equipMolds.set(moldId, record);
  }
  const resetCounterGroups = new Map();
  for (const record of readRecords("ab_script", "LUA_RESET_COUNT_TEMPLET.json")) {
    const groupId = Number(record && record.GroupID);
    if (Number.isInteger(groupId) && groupId > 0 && !resetCounterGroups.has(groupId)) {
      resetCounterGroups.set(groupId, record);
    }
  }
  const moldRewardGroups = groupByNumber(readRecords("ab_script_item_templet", "LUA_RANDOM_MOLD_BOX_CL.json"), "m_RewardGroupID");
  const equipUpgradeByCoreId = new Map();
  for (const record of readRecords("ab_script", "LUA_ITEM_EQUIP_UPGRADE.json")) {
    const coreEquipId = Number(record && record.CoreEquipID);
    if (Number.isInteger(coreEquipId) && coreEquipId > 0 && !equipUpgradeByCoreId.has(coreEquipId)) {
      equipUpgradeByCoreId.set(coreEquipId, record);
    }
  }
  const equipPotentialOptions = groupByNumber(readRecords("ab_script", "LUA_ITEM_EQUIP_POTENTIAL_OPTION.json"), "m_PotentialOptionGroupID");
  const commonConst = readTableObject("ab_script", "LUA_COMMON_CONST.json");
  const operatorLevelUpConfig = normalizeOperatorLevelUpConfig(
    commonConst && commonConst.globals && commonConst.globals.Operater
  );
  const extractBonus = commonConst && commonConst.globals && commonConst.globals.EXTRACT_BONUS || {};
  const unitExtractConfig = {
    awakenRatePercent: Math.max(0, Math.trunc(Number(extractBonus.ExtractBonusRatePercent_Awaken) || 0)),
    ssrRatePercent: Math.max(0, Math.trunc(Number(extractBonus.ExtractBonusRatePercent_SSR) || 0)),
    srRatePercent: Math.max(0, Math.trunc(Number(extractBonus.ExtractBonusRatePercent_SR) || 0)),
    maxUnitSelect: Math.max(1, Math.trunc(Number(extractBonus.MaxExtractUnitSelect) || 1)),
  };
  const unitExtractBonusRewards = readRecords("ab_script", "LUA_EXTRACT_BONUS_TEMPLET.json")
    .map((record) => ({
      itemId: Number(record && record.m_ExtractBonusItemID),
      count: Math.max(0, Math.trunc(Number(record && record.m_ExtractBonusItemCount) || 0)),
      weight: Math.max(0, Math.trunc(Number(record && record.m_Ratio) || 0)),
    }))
    .filter((reward) => Number.isInteger(reward.itemId) && reward.itemId > 0 && reward.count > 0 && reward.weight > 0);
  const recallRewardUnitPieceToPoint = Math.max(
    0,
    Number(commonConst && commonConst.globals && commonConst.globals.RECALL &&
      commonConst.globals.RECALL.RECALL_REWARD_UNIT_PIECE_TO_POINT) || 0
  );
  const recallIntervalsByStrId = new Map();
  for (const record of readRecords("ab_script", "LUA_INTERVAL_TEMPLET.json")) {
    const strId = String(record && record.m_DateStrID || "");
    if (strId && !recallIntervalsByStrId.has(strId)) recallIntervalsByStrId.set(strId, record);
  }
  const recallTempletsByUnitId = new Map();
  for (const record of readRecords("ab_script", "LUA_RECALL_TEMPLET.json")) {
    const unitId = Number(record && record.UnitID);
    const interval = recallIntervalsByStrId.get(String(record && record.ExchangeDateStrID || ""));
    const startDate = parseGameTableDate(interval && interval.m_DateStart);
    const endDate = parseGameTableDate(interval && interval.m_DateEnd);
    if (!Number.isInteger(unitId) || unitId <= 0 || !startDate || !endDate || endDate <= startDate) continue;
    if (!recallTempletsByUnitId.has(unitId)) recallTempletsByUnitId.set(unitId, []);
    recallTempletsByUnitId.get(unitId).push({ ...record, startDate, endDate });
  }
  const recallExchangeByGroupId = groupByNumber(
    readRecords("ab_script", "LUA_RECALL_EXCHANGE_UNIT_LIST.json"),
    "UnitExchangeGroupID"
  );
  const operatorExtractHostByGrade = new Map();
  const operatorHostUnits =
    commonConst && commonConst.globals && commonConst.globals.Operater && commonConst.globals.Operater.HostUnit;
  for (const record of Array.isArray(operatorHostUnits) ? operatorHostUnits : []) {
    const grade = normalizeUnitGrade(record && record.m_NKM_UNIT_GRADE);
    if (grade && !operatorExtractHostByGrade.has(grade)) operatorExtractHostByGrade.set(grade, record);
  }
  const operatorEnhanceRatesByGrade = new Map();
  const operatorMaterialUnits =
    commonConst && commonConst.globals && commonConst.globals.Operater && commonConst.globals.Operater.MaterialUnit;
  for (const record of Array.isArray(operatorMaterialUnits) ? operatorMaterialUnits : []) {
    const grade = normalizeUnitGrade(record && record.m_NKM_UNIT_GRADE);
    if (!grade || operatorEnhanceRatesByGrade.has(grade)) continue;
    operatorEnhanceRatesByGrade.set(grade, {
      commandLevelUpPercent: Math.max(0, Math.trunc(Number(record.CommandLevelUpPercent) || 0)),
      levelUpSuccessRatePercent: Math.max(0, Math.trunc(Number(record.LevelUpSuccessRatePercent) || 0)),
      transportSuccessRatePercent: Math.max(0, Math.trunc(Number(record.TransportSuccessRatePercent) || 0)),
    });
  }
  const operatorPassiveTokenByItemId = new Map();
  const operatorPassiveMaterials =
    commonConst && commonConst.globals && commonConst.globals.Operater &&
    commonConst.globals.Operater.PassiveToken && commonConst.globals.Operater.PassiveToken.Materials;
  for (const record of Array.isArray(operatorPassiveMaterials) ? operatorPassiveMaterials : []) {
    const itemGrade = String(record && record.m_NKM_ITEM_GRADE || "");
    const levelUpSuccessRatePercent = Math.max(0, Math.trunc(Number(record && record.LevelUpSuccessRatePercent) || 0));
    const transportSuccessRatePercent = Math.max(0, Math.trunc(Number(record && record.TransportSuccessRatePercent) || 0));
    for (const itemIdValue of Array.isArray(record && record.ItemID) ? record.ItemID : []) {
      const itemId = Number(itemIdValue);
      const skill = operatorPassiveSkillByTokenId.get(itemId);
      if (!skill || !itemGrade || operatorPassiveTokenByItemId.has(itemId)) continue;
      operatorPassiveTokenByItemId.set(itemId, {
        itemId,
        itemGrade,
        skillId: skill.skillId,
        levelUpSuccessRatePercent,
        transportSuccessRatePercent,
      });
    }
  }
  const equipEnchantMaterials = normalizeEquipEnchantMaterials(
    commonConst && commonConst.globals && commonConst.globals.EquipEnchantModule
  );
  const relicRerollCountFactor = Number(
    commonConst && commonConst.globals && commonConst.globals.RelicReroll && commonConst.globals.RelicReroll.RelicRerollCountFactor
  ) || 1.63;

  const eventDecks = new Map();
  for (const record of readRecords("ab_script", "LUA_EVENTDECK_TEMPLET.json")) {
    const eventDeckId = Number(record && record.ID);
    if (Number.isInteger(eventDeckId) && eventDeckId > 0 && !eventDecks.has(eventDeckId)) {
      eventDecks.set(eventDeckId, record);
    }
  }

  const skinById = new Map();
  for (const record of readRecords("ab_script", "LUA_SKIN_TEMPLET.json")) {
    const skinId = Number(record && record.m_SkinID);
    if (Number.isInteger(skinId) && skinId > 0 && !skinById.has(skinId)) skinById.set(skinId, record);
  }

  const emoticonById = new Map();
  for (const record of readRecords("ab_script_item_templet", "LUA_ITEM_EMOTICON_TEMPLET.json")) {
    const emoticonId = Number(record && record.m_EmoticonID);
    if (Number.isInteger(emoticonId) && emoticonId > 0 && !emoticonById.has(emoticonId)) emoticonById.set(emoticonId, record);
  }

  const unitExpTable = new Map();
  for (const record of readRecords("ab_script_unit_data", "LUA_UNIT_EXP_TABLE.json")) {
    const level = Number(record && record.m_iLevel);
    if (!Number.isInteger(level) || level <= 0 || unitExpTable.has(level)) continue;
    unitExpTable.set(level, record);
  }

  const shipLevelUpByKey = new Map();
  for (const record of readRecords("ab_script", "LUA_SHIP_LEVELUP_TEMPLET.json")) {
    const starGrade = Number(record && record.m_ShipStarGrade);
    const grade = normalizeUnitGrade(record && record.m_ShipRareGrade);
    const maxLevel = Number(record && record.m_ShipMaxLevel);
    if (!Number.isInteger(starGrade) || starGrade <= 0 || !grade || !Number.isInteger(maxLevel) || maxLevel <= 0) continue;
    const normalized = {
      ...record,
      m_ShipStarGrade: starGrade,
      m_ShipRareGrade: grade,
      m_ShipLimitBreakGrade: Math.max(0, Math.trunc(Number(record.m_ShipLimitBreakGrade || 0) || 0)),
      m_ShipMaxLevel: maxLevel,
    };
    const key = makeShipLevelUpKey(grade, starGrade);
    if (!shipLevelUpByKey.has(key)) shipLevelUpByKey.set(key, []);
    shipLevelUpByKey.get(key).push(normalized);
  }
  for (const records of shipLevelUpByKey.values()) {
    records.sort(
      (left, right) =>
        Number(left.m_ShipLimitBreakGrade || 0) - Number(right.m_ShipLimitBreakGrade || 0) ||
        Number(left.m_ShipMaxLevel || 0) - Number(right.m_ShipMaxLevel || 0)
    );
  }

  const shipBuildById = new Map();
  for (const record of readRecords("ab_script", "LUA_SHIP_BUILD_TEMPLET.json")) {
    const shipId = Number(record && record.m_ShipID);
    if (Number.isInteger(shipId) && shipId > 0 && !shipBuildById.has(shipId)) shipBuildById.set(shipId, record);
  }

  const shipLimitBreakByKey = new Map();
  for (const record of readRecords("ab_script", "LUA_SHIP_LIMITBREAK_TEMPLET.json")) {
    const shipId = Number(record && record.ShipID);
    const grade = Number(record && record.ShipLimitBreakGrade);
    if (!Number.isInteger(shipId) || shipId <= 0 || !Number.isInteger(grade) || grade <= 0) continue;
    const key = makeShipLimitBreakKey(shipId, grade);
    if (!shipLimitBreakByKey.has(key)) shipLimitBreakByKey.set(key, record);
  }

  const playerExpTable = new Map();
  for (const record of readRecords("ab_script", "LUA_PLAYER_EXP_TABLE.json")) {
    const level = Number(record && record.m_iLevel);
    if (!Number.isInteger(level) || level <= 0 || playerExpTable.has(level)) continue;
    playerExpTable.set(level, record);
  }

  const operatorExpTable = new Map();
  for (const record of readRecords("ab_script_unit_data", "LUA_OPERATOR_EXP_TEMPLET.json")) {
    const level = Number(record && record.m_iLevel);
    const grade = normalizeOperatorGrade(record && record.m_NKM_UNIT_GRADE);
    if (!Number.isInteger(level) || level <= 0 || !grade) continue;
    if (!operatorExpTable.has(grade)) operatorExpTable.set(grade, new Map());
    const byLevel = operatorExpTable.get(grade);
    if (!byLevel.has(level)) byLevel.set(level, record);
  }

  const limitBreakInfoByRank = new Map();
  for (const record of readRecords("ab_script", "LUA_LIMITBREAK_INFO.json")) {
    const rank = Number(record && record.m_iLBRank);
    if (Number.isInteger(rank) && rank >= 0 && !limitBreakInfoByRank.has(rank)) limitBreakInfoByRank.set(rank, record);
  }

  const limitBreakSubstituteByKey = new Map();
  for (const record of readRecords("ab_script", "LUA_LIMITBREAK_SUBSTITUTE_ITEM.json")) {
    const targetRank = Number(record && record.m_TargetLimitbreakLevel);
    if (!Number.isInteger(targetRank) || targetRank <= 0) continue;
    const key = makeLimitBreakSubstituteKey(record.m_NKM_UNIT_STYLE_TYPE, record.m_NKM_UNIT_GRADE, targetRank);
    if (!limitBreakSubstituteByKey.has(key)) limitBreakSubstituteByKey.set(key, record);
  }

  const contentUnlockRecords = readRecords("ab_script", "LUA_CONTENTS_UNLOCK_TEMPLET.json");
  const hasCounterPassContentUnlock = contentUnlockRecords.some((record) => getContentUnlockType(record) === "COUNTER_PASS");
  const dungeonContentUnlockRecords = contentUnlockRecords.filter(
    (record) => String(record && record.m_UnlockReqType) === "SURT_CLEAR_DUNGEON"
  );
  const contentUnlocksByDungeonId = groupByNumber(dungeonContentUnlockRecords, "m_UnlockReqValue");
  const counterPassUnlockDungeonIds = uniquePositiveInts(
    dungeonContentUnlockRecords
      .filter((record) => getContentUnlockType(record) === "COUNTER_PASS")
      .map((record) => record && record.m_UnlockReqValue)
  );

  const missions = [];
  const missionById = new Map();
  const missionsByTabId = new Map();
  const missionsByCounterGroupId = new Map();
  const missionTabs = [];
  const missionTabById = new Map();
  const missionTabRecords = readMissionRecords("ab_script", "LUA_MISSION_TAB_TEMPLET.json");
  const missionRecords = readMissionRecords("ab_script", "LUA_MISSION_TEMPLET.json");
  for (const record of missionTabRecords) {
    const tabId = Number(record && record.m_TabID);
    if (!Number.isInteger(tabId) || tabId <= 0 || missionTabById.has(tabId)) continue;
    missionTabs.push(record);
    missionTabById.set(tabId, record);
  }
  for (const record of missionRecords) {
    const missionId = Number(record && record.m_MissionID);
    if (!Number.isInteger(missionId) || missionId <= 0) continue;
    if (record.m_Enabled === false) continue;
    missions.push(record);
    if (!missionById.has(missionId)) missionById.set(missionId, record);
    const tabId = Number(record.m_MissionTabId || 0);
    if (Number.isInteger(tabId) && tabId > 0) {
      if (!missionsByTabId.has(tabId)) missionsByTabId.set(tabId, []);
      missionsByTabId.get(tabId).push(record);
    }
    const groupId = Number(record.m_MissionCounterGroupID || missionId);
    if (Number.isInteger(groupId) && groupId > 0) {
      if (!missionsByCounterGroupId.has(groupId)) missionsByCounterGroupId.set(groupId, []);
      missionsByCounterGroupId.get(groupId).push(record);
    }
  }

  cachedData = {
    miscItems,
    miscItemsByStrId,
    randomItemBoxes,
    customPackageBoxes,
    customBoxes,
    acqPackages,
    rewardGroups,
    unitById,
    unitByStrId,
    collectionUnitById,
    collectionUnitByStrId,
    unitSkillsById,
    unitSkillsByStrId,
    unitSkillStrIdById,
    operatorSkillsById,
    operatorSkillsByStrId,
    unitReactorsById,
    reactorSkillsById,
    rearmamentByUnitId,
    operatorRandomPassiveByKey,
    operatorEnhanceRatesByGrade,
    operatorPassiveTokenByItemId,
    operatorLevelUpConfig,
    operatorExtractHostByGrade,
    unitExtractConfig,
    unitExtractBonusRewards,
    recallRewardUnitPieceToPoint,
    recallIntervalsByStrId,
    recallTempletsByUnitId,
    recallExchangeByGroupId,
    pieceByItemId,
    contracts,
    selectableContracts,
    contractTabs,
    contractUnitPools,
    selectableContractUnitPools,
    customPickupContracts,
    randomGradeTables,
    miscContracts,
    equipById,
    equipRandomStats,
    equipPrecisionWeights,
    equipSetOptions,
    equipEnchantExp,
    equipEnchantMaterials,
    equipMolds,
    resetCounterGroups,
    moldRewardGroups,
    equipUpgradeByCoreId,
    equipPotentialOptions,
    relicRerollCountFactor,
    eventDecks,
    skinById,
    emoticonById,
    unitExpTable,
    shipLevelUpByKey,
    shipBuildById,
    shipLimitBreakByKey,
    playerExpTable,
    operatorExpTable,
    limitBreakInfoByRank,
    limitBreakSubstituteByKey,
    contentUnlocksByDungeonId,
    hasCounterPassContentUnlock,
    counterPassUnlockDungeonIds,
    missions,
    missionById,
    missionsByTabId,
    missionsByCounterGroupId,
    missionTabs,
    missionTabById,
  };
  return cachedData;
}

function getMiscItemTemplet(itemId) {
  return loadGameData().miscItems.get(Number(itemId)) || null;
}

function getAllMiscItemIds() {
  return Array.from(loadGameData().miscItems.keys()).sort((a, b) => a - b);
}

function getUnitTemplet(unitIdOrStrId) {
  const data = loadGameData();
  if (typeof unitIdOrStrId === "string" && !/^\d+$/.test(unitIdOrStrId)) {
    return data.unitByStrId.get(unitIdOrStrId) || null;
  }
  return data.unitById.get(Number(unitIdOrStrId)) || null;
}

function getUnitRemoveRewards(unitIdOrStrId, options = {}) {
  const record = getUnitTemplet(unitIdOrStrId);
  if (!record) return [];
  const rewards = [];
  for (let index = 1; index <= 2; index += 1) {
    const itemId = Number(record[`m_OnRemoveItemID_${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`m_OnRemoveItemCount_${index}`] || 0)));
    if (itemId > 0 && count > 0) rewards.push({ itemId, count });
  }
  if (options.fromContract === true) {
    const itemId = Number(record.m_OnRemoveItemID_Contract || 0);
    const count = Math.max(0, Math.trunc(Number(record.m_OnRemoveItemCount_Contract || 0)));
    if (itemId > 0 && count > 0) rewards.push({ itemId, count });
  }
  return mergeItemCosts(rewards);
}

function getUnitExtractRewards(unitIdOrStrId, options = {}) {
  const record = getUnitTemplet(unitIdOrStrId);
  if (!record) return [];
  const rewards = [];
  for (let index = 1; index <= 2; index += 1) {
    const itemId = Number(record[`m_OnExtractItemID_${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`m_OnExtractItemCount_${index}`] || 0)));
    if (itemId > 0 && count > 0) rewards.push({ itemId, count });
  }
  if (options.fromContract === true) {
    const itemId = Number(record.m_OnExtractItemID_Contract || 0);
    const count = Math.max(0, Math.trunc(Number(record.m_OnExtractItemCount_Contract || 0)));
    if (itemId > 0 && count > 0) rewards.push({ itemId, count });
  }
  return mergeItemCosts(rewards);
}

function getUnitExtractConfig() {
  return { ...loadGameData().unitExtractConfig };
}

function getUnitExtractBonusRewards() {
  return loadGameData().unitExtractBonusRewards.map((reward) => ({ ...reward }));
}

function getCollectionUnitTemplet(unitIdOrStrId) {
  const data = loadGameData();
  if (typeof unitIdOrStrId === "string" && !/^\d+$/.test(unitIdOrStrId)) {
    return data.collectionUnitByStrId.get(unitIdOrStrId) || null;
  }
  return data.collectionUnitById.get(Number(unitIdOrStrId)) || null;
}

function isCollectionVisibleUnitId(unitIdOrStrId) {
  const record = getCollectionUnitTemplet(unitIdOrStrId);
  if (!record) return false;
  return record.m_bExclude !== true && record.m_bExclude !== "true" && record.m_bExclude !== 1;
}

function getUnitSkillStrId(skillId) {
  return loadGameData().unitSkillStrIdById.get(Number(skillId)) || "";
}

function getUnitSkillTemplet(skillId, level) {
  const byLevel = loadGameData().unitSkillsById.get(Number(skillId));
  return byLevel ? byLevel.get(Number(level)) || null : null;
}

function getUnitSkillMaxLevel(skillId) {
  const byLevel = loadGameData().unitSkillsById.get(Number(skillId));
  if (!byLevel) return 0;
  return Array.from(byLevel.keys()).reduce((max, level) => Math.max(max, Number(level) || 0), 0);
}

function getUnitSkillMaxLevelFromLimitBreakLevel(skillId, limitBreakLevel) {
  const byLevel = loadGameData().unitSkillsById.get(Number(skillId));
  if (!byLevel) return 0;
  const nextLimitBreakLevel = Math.max(0, Math.trunc(Number(limitBreakLevel || 0))) + 1;
  for (const [level, record] of Array.from(byLevel.entries()).sort((left, right) => left[0] - right[0])) {
    if (Number(record && record.m_UnlockReqUpgrade || 0) === nextLimitBreakLevel) return level - 1;
  }
  return getUnitSkillMaxLevel(skillId);
}

function getUnitSkillMaxLevelByStrId(skillStrId) {
  const byLevel = loadGameData().unitSkillsByStrId.get(String(skillStrId || ""));
  if (!byLevel) return 0;
  return Array.from(byLevel.keys()).reduce((max, level) => Math.max(max, Number(level) || 0), 0);
}

function getUnitReactorTemplet(unitIdOrTemplet) {
  const templet =
    unitIdOrTemplet && typeof unitIdOrTemplet === "object"
      ? unitIdOrTemplet
      : getUnitTemplet(unitIdOrTemplet);
  if (!templet) return null;
  const unitId = Number(templet.m_UnitID || 0);
  const reactorId = Number(templet.m_ReactorID || templet.m_ReactorId || unitId || 0);
  return loadGameData().unitReactorsById.get(reactorId) || null;
}

function getReactorSkillTemplet(skillId) {
  return loadGameData().reactorSkillsById.get(Number(skillId)) || null;
}

function getUnitRearmamentTemplet(unitIdOrTemplet) {
  if (unitIdOrTemplet && typeof unitIdOrTemplet === "object" && Number(unitIdOrTemplet.m_RearmID || 0) > 0) {
    return unitIdOrTemplet;
  }
  const templet = unitIdOrTemplet && typeof unitIdOrTemplet === "object" ? unitIdOrTemplet : getUnitTemplet(unitIdOrTemplet);
  const unitId = Number(templet && templet.m_UnitID || unitIdOrTemplet || 0);
  return loadGameData().rearmamentByUnitId.get(unitId) || null;
}

function getUnitRearmamentCosts(unitIdOrTemplet) {
  const record = getUnitRearmamentTemplet(unitIdOrTemplet);
  if (!record) return [];
  const costs = [];
  for (let index = 1; index <= 4; index += 1) {
    const itemId = Number(record[`m_RearmUseItemID${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`m_RearmUseItemValue${index}`] || 0)));
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return mergeItemCosts(costs);
}

function getRecallTemplets(unitId) {
  return (loadGameData().recallTempletsByUnitId.get(Number(unitId)) || []).slice();
}

function getActiveRecallTemplet(unitId, now = new Date()) {
  const timestamp = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return null;
  return getRecallTemplets(unitId).find((record) => timestamp >= record.startDate.getTime() && timestamp < record.endDate.getTime()) || null;
}

function getRecallExchangeUnitIds(groupId) {
  return uniquePositiveInts(
    (loadGameData().recallExchangeByGroupId.get(Number(groupId)) || []).map((record) => record && record.UnitID)
  );
}

function getFirstLevelShipId(shipId) {
  let current = Number(shipId);
  let first = current;
  if (!Number.isInteger(current) || current <= 0) return 0;
  while (getShipBuildTemplet(current)) {
    first = current;
    current -= 1000;
  }
  return first;
}

function getRecallRewardUnitPieceToPoint() {
  return loadGameData().recallRewardUnitPieceToPoint;
}

function getOperatorSkillTemplet(skillIdOrStrId) {
  const data = loadGameData();
  if (typeof skillIdOrStrId === "string" && !/^\d+$/.test(skillIdOrStrId)) {
    return data.operatorSkillsByStrId.get(skillIdOrStrId) || null;
  }
  return data.operatorSkillsById.get(Number(skillIdOrStrId)) || null;
}

function getOperatorMainSkillId(unitIdOrTemplet) {
  const templet = unitIdOrTemplet && typeof unitIdOrTemplet === "object" ? unitIdOrTemplet : getUnitTemplet(unitIdOrTemplet);
  const skill = getOperatorSkillTemplet(templet && templet.m_SkillStrID1);
  return Number(skill && skill.m_OperSkillID) || 0;
}

function getOperatorEnhanceCost(unitIdOrGrade) {
  const templet = unitIdOrGrade && typeof unitIdOrGrade === "object" ? unitIdOrGrade : getUnitTemplet(unitIdOrGrade);
  const grade = normalizeUnitGrade(templet ? templet.m_NKM_UNIT_GRADE : unitIdOrGrade);
  const record = loadGameData().operatorExtractHostByGrade.get(grade);
  const itemId = Number(record && record.ItemId);
  const count = Math.max(0, Math.trunc(Number(record && record.ItemCount) || 0));
  return itemId > 0 && count > 0 ? { itemId, count } : null;
}

function getOperatorEnhanceRates(unitIdOrGrade) {
  const templet = unitIdOrGrade && typeof unitIdOrGrade === "object" ? unitIdOrGrade : getUnitTemplet(unitIdOrGrade);
  const grade = normalizeUnitGrade(templet ? templet.m_NKM_UNIT_GRADE : unitIdOrGrade);
  const rates = loadGameData().operatorEnhanceRatesByGrade.get(grade);
  return rates ? { ...rates } : null;
}

function getOperatorPassiveToken(itemId) {
  const token = loadGameData().operatorPassiveTokenByItemId.get(Number(itemId));
  return token ? { ...token } : null;
}

function getOperatorExtractTokenItemId(unitIdOrTemplet, subSkillId) {
  const templet =
    unitIdOrTemplet && typeof unitIdOrTemplet === "object"
      ? unitIdOrTemplet
      : getUnitTemplet(unitIdOrTemplet);
  if (!templet) return 0;
  const groupId = Number(templet.m_OprPassiveGroupID || 0);
  const passive = loadGameData().operatorRandomPassiveByKey.get(`${groupId}|${Number(subSkillId || 0)}`);
  if (!passive) return 0;
  const grade = normalizeUnitGrade(templet.m_NKM_UNIT_GRADE).replace(/^NUG_/, "");
  return Number(passive[`m_ExtractItemID_${grade}`] || 0);
}

function getOperatorExtractPrice(unitIdOrGrade) {
  const templet =
    unitIdOrGrade && typeof unitIdOrGrade === "object"
      ? unitIdOrGrade
      : getUnitTemplet(unitIdOrGrade);
  const grade = normalizeUnitGrade(templet ? templet.m_NKM_UNIT_GRADE : unitIdOrGrade);
  const record = loadGameData().operatorExtractHostByGrade.get(grade);
  if (!record) return null;
  const itemId = Number(record.m_ExtractPriceItemID || 0);
  const count = Math.max(0, Math.trunc(Number(record.m_ExtractPrice || 0)));
  return itemId > 0 && count > 0 ? { itemId, count } : null;
}

function getUnitSkillIndex(unitId, skillId) {
  const skillStrId = getUnitSkillStrId(skillId);
  if (!skillStrId) return -1;
  const templets = [getUnitTemplet(unitId), getBaseUnitTemplet(unitId)].filter(Boolean);
  for (const templet of templets) {
    for (let index = 1; index <= 5; index += 1) {
      if (String(templet[`m_SkillStrID${index}`] || "") === skillStrId) return index - 1;
    }
  }
  return -1;
}

function getUnitSkillUpgradeCosts(skillId, targetLevel) {
  const record = getUnitSkillTemplet(skillId, targetLevel);
  if (!record) return null;
  const costs = [];
  for (let index = 1; index <= 4; index += 1) {
    const itemId = Number(record[`m_UpgradeReqtemID_${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`m_UpgradeReqtemValue_${index}`] || 0)));
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return mergeItemCosts(costs);
}

function getShipMaxLevel(unitOrShipId, options = {}) {
  const record = getShipLevelUpRecordForUnit(unitOrShipId, options);
  return Number(record && record.m_ShipMaxLevel) || Number(options.fallbackMaxLevel || 100) || 100;
}

function getShipBuildTemplet(shipId) {
  return loadGameData().shipBuildById.get(Number(shipId)) || null;
}

function getShipBuildCosts(shipIdOrTemplet) {
  const record = shipIdOrTemplet && typeof shipIdOrTemplet === "object" ? shipIdOrTemplet : getShipBuildTemplet(shipIdOrTemplet);
  if (!record) return null;
  const costs = [];
  for (let index = 1; index <= 4; index += 1) {
    const itemId = Number(record[`m_ShipBuildMaterialID_${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`m_ShipBuildMaterialValue_${index}`] || 0)));
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return mergeItemCosts(costs);
}

function getShipUpgradeCosts(shipIdOrTemplet) {
  const record = shipIdOrTemplet && typeof shipIdOrTemplet === "object" ? shipIdOrTemplet : getShipBuildTemplet(shipIdOrTemplet);
  if (!record) return null;
  const costs = [];
  const credit = Math.max(0, Math.trunc(Number(record.m_ShipUpgradeCredit || 0)));
  if (credit > 0) costs.push({ itemId: 1, count: credit });
  for (let index = 1; index <= 4; index += 1) {
    const itemId = Number(record[`m_ShipUpgradeMaterial${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`m_ShipUpgradeMaterialCount${index}`] || 0)));
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return mergeItemCosts(costs);
}

function getShipLimitBreakTemplet(shipId, grade) {
  return loadGameData().shipLimitBreakByKey.get(makeShipLimitBreakKey(shipId, grade)) || null;
}

function getShipLimitBreakCosts(shipIdOrTemplet, grade) {
  const record =
    shipIdOrTemplet && typeof shipIdOrTemplet === "object"
      ? shipIdOrTemplet
      : getShipLimitBreakTemplet(shipIdOrTemplet, grade);
  if (!record) return null;
  const costs = [];
  for (let index = 1; index <= 4; index += 1) {
    const itemId = Number(record[`ShipLimitBreakItemID${index}`] || 0);
    const count = Math.max(0, Math.trunc(Number(record[`ShipLimitBreakItemValue${index}`] || 0)));
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return mergeItemCosts(costs);
}

function getShipLevelUpCosts(unitOrShipId, startLevel, endLevel, options = {}) {
  const templet = getShipTemplet(unitOrShipId);
  const grade = getShipGrade(unitOrShipId, templet);
  if (!grade) return [];

  const limitBreakLevel = getShipLimitBreakLevel(unitOrShipId, options);
  const maxLevel = getShipMaxLevel(unitOrShipId, { ...options, limitBreakLevel });
  const from = Math.max(1, Math.trunc(Number(startLevel || 1) || 1));
  const to = Math.min(Math.max(1, Math.trunc(Number(endLevel || from) || from)), maxLevel);
  if (to <= from) return [];

  const costs = [];
  for (let level = from; level < to; level += 1) {
    const record = getShipLevelUpRecordByLevel(grade, limitBreakLevel, level);
    if (!record) continue;
    const credit = Math.max(0, Math.trunc(Number(record.m_Credit || 0) || 0));
    if (credit > 0) costs.push({ itemId: 1, count: credit });
    for (let index = 1; index <= 3; index += 1) {
      const itemId = Number(record[`m_LevelupMaterialItemID${index}`] || 0);
      const count = Math.max(0, Math.trunc(Number(record[`m_LevelupMaterialCount${index}`] || 0) || 0));
      if (itemId > 0 && count > 0) costs.push({ itemId, count });
    }
  }
  return mergeItemCosts(costs);
}

function getShipLevelUpRecordForUnit(unitOrShipId, options = {}) {
  const templet = getShipTemplet(unitOrShipId);
  return getShipLevelUpRecord(
    getShipStarGrade(unitOrShipId, templet),
    getShipGrade(unitOrShipId, templet),
    getShipLimitBreakLevel(unitOrShipId, options)
  );
}

function getShipLevelUpRecordByLevel(grade, limitBreakLevel, currentLevel) {
  const records = getShipLevelUpRecordsForGrade(grade);
  const requestedLimitBreak = Math.max(0, Math.trunc(Number(limitBreakLevel || 0) || 0));
  return (
    records.find(
      (record) =>
        Number(record.m_ShipLimitBreakGrade || 0) === requestedLimitBreak &&
        Number(record.m_ShipMaxLevel || 0) > Number(currentLevel || 0)
    ) ||
    records[records.length - 1] ||
    null
  );
}

function getShipLevelUpRecord(starGrade, grade, limitBreakLevel = 0) {
  const records = getShipLevelUpRecords(starGrade, grade);
  if (!records.length) return null;
  const requestedLimitBreak = Math.max(0, Math.trunc(Number(limitBreakLevel || 0) || 0));
  const exact = records.find((record) => Number(record.m_ShipLimitBreakGrade || 0) === requestedLimitBreak);
  if (exact) return exact;
  return (
    records
      .filter((record) => Number(record.m_ShipLimitBreakGrade || 0) <= requestedLimitBreak)
      .sort((left, right) => Number(right.m_ShipLimitBreakGrade || 0) - Number(left.m_ShipLimitBreakGrade || 0))[0] ||
    records[0] ||
    null
  );
}

function getShipLevelUpRecords(starGrade, grade) {
  const key = makeShipLevelUpKey(normalizeUnitGrade(grade), Number(starGrade));
  return (loadGameData().shipLevelUpByKey.get(key) || []).slice();
}

function getShipLevelUpRecordsForGrade(grade) {
  const normalizedGrade = normalizeUnitGrade(grade);
  const records = [];
  for (const values of loadGameData().shipLevelUpByKey.values()) {
    for (const record of values) {
      if (normalizeUnitGrade(record.m_ShipRareGrade) === normalizedGrade) records.push(record);
    }
  }
  return records.sort(
    (left, right) =>
      Number(left.m_ShipMaxLevel || 0) - Number(right.m_ShipMaxLevel || 0) ||
      Number(left.m_ShipLimitBreakGrade || 0) - Number(right.m_ShipLimitBreakGrade || 0)
  );
}

function getShipTemplet(unitOrShipId) {
  const unitId =
    unitOrShipId && typeof unitOrShipId === "object"
      ? Number(unitOrShipId.unitId != null ? unitOrShipId.unitId : unitOrShipId.m_UnitID || 0)
      : Number(unitOrShipId || 0);
  return getUnitTemplet(unitId);
}

function getShipStarGrade(unitOrShipId, templet = getShipTemplet(unitOrShipId)) {
  if (unitOrShipId && typeof unitOrShipId === "object") {
    const direct = Number(unitOrShipId.starGrade != null ? unitOrShipId.starGrade : unitOrShipId.m_StarGrade || 0);
    if (Number.isInteger(direct) && direct > 0) return direct;
  }
  return Number(templet && (templet.m_StarGradeMax || templet.m_StarGrade || 0)) || 0;
}

function getShipGrade(unitOrShipId, templet = getShipTemplet(unitOrShipId)) {
  if (unitOrShipId && typeof unitOrShipId === "object") {
    const direct = normalizeUnitGrade(unitOrShipId.grade || unitOrShipId.unitGrade || unitOrShipId.m_NKM_UNIT_GRADE);
    if (direct) return direct;
  }
  return normalizeUnitGrade(templet && templet.m_NKM_UNIT_GRADE);
}

function getShipLimitBreakLevel(unitOrShipId, options = {}) {
  if (options.limitBreakLevel != null) return Math.max(0, Math.trunc(Number(options.limitBreakLevel || 0) || 0));
  if (unitOrShipId && typeof unitOrShipId === "object") {
    return Math.max(0, Math.trunc(Number(unitOrShipId.limitBreakLevel != null ? unitOrShipId.limitBreakLevel : unitOrShipId.m_LimitBreakLevel || 0) || 0));
  }
  return 0;
}

function makeShipLevelUpKey(grade, starGrade) {
  return `${normalizeUnitGrade(grade)}|${Number(starGrade) || 0}`;
}

function makeShipLimitBreakKey(shipId, grade) {
  return `${Number(shipId) || 0}|${Number(grade) || 0}`;
}

function resolveUnitId(unitIdOrStrId) {
  const templet = getUnitTemplet(unitIdOrStrId);
  return Number(templet && templet.m_UnitID) || Number(unitIdOrStrId) || 0;
}

function getPlayableUnitIds(options = {}) {
  const includeOperators = options.includeOperators === true;
  const includeNonContractable = options.includeNonContractable === true;
  return Array.from(loadGameData().unitById.values())
    .filter((record) => {
      if (!record || record.m_bMonster === true) return false;
      if (!includeNonContractable && record.m_bContractable !== true) return false;
      const type = String(record.m_NKM_UNIT_TYPE || "");
      const style = String(record.m_NKM_UNIT_STYLE_TYPE || "");
      if (type === "NUT_SYSTEM" || type === "NUT_SHIP") return false;
      if (type === "NUT_OPERATOR" && !includeOperators) return false;
      if (style === "NUST_TRAINER") return false;
      if (!isCollectionVisibleUnitId(record.m_UnitID || record.m_UnitStrID)) return false;
      return Number(record.m_UnitID) > 0;
    })
    .map((record) => Number(record.m_UnitID))
    .sort((a, b) => a - b);
}

function getPlayableShipIds(options = {}) {
  const includeNonContractable = options.includeNonContractable === true;
  return Array.from(loadGameData().unitById.values())
    .filter((record) => {
      if (!record || record.m_bMonster === true) return false;
      if (!includeNonContractable && record.m_bContractable !== true) return false;
      return String(record.m_NKM_UNIT_TYPE || "") === "NUT_SHIP" && Number(record.m_UnitID) > 0;
    })
    .map((record) => Number(record.m_UnitID))
    .sort((a, b) => a - b);
}

function getTrophyUnitIds() {
  return Array.from(loadGameData().unitById.values())
    .filter((record) => {
      if (!record || record.m_bMonster === true) return false;
      return String(record.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER" && Number(record.m_UnitID) > 0;
    })
    .map((record) => Number(record.m_UnitID))
    .sort((a, b) => a - b);
}

function getPlayableOperatorIds() {
  return Array.from(loadGameData().unitById.values())
    .filter((record) => {
      if (!record || record.m_bMonster === true) return false;
      return (
        String(record.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR" &&
        Number(record.m_UnitID) > 0 &&
        isCollectionVisibleUnitId(record.m_UnitID || record.m_UnitStrID)
      );
    })
    .map((record) => Number(record.m_UnitID))
    .sort((a, b) => a - b);
}

function getContractRecord(contractId) {
  return loadGameData().contracts.get(Number(contractId)) || null;
}

function getContractTabRecord(contractId) {
  return loadGameData().contractTabs.get(Number(contractId)) || null;
}

function getSelectableContractRecord(contractId) {
  return loadGameData().selectableContracts.get(Number(contractId)) || null;
}

function getSelectableContractRecords() {
  return Array.from(loadGameData().selectableContracts.values());
}

function getVisibleContractIds() {
  const data = loadGameData();
  const ids = new Set([...data.contracts.keys(), ...data.contractTabs.keys()]);
  return Array.from(ids)
    .filter((id) => {
      const tab = data.contractTabs.get(id);
      if (!tab) return true;
      if (tab.m_bEnabled === false || tab.m_bVisible === false) return false;
      return true;
    })
    .sort((a, b) => {
      const aTab = data.contractTabs.get(a) || {};
      const bTab = data.contractTabs.get(b) || {};
      return Number(aTab.m_Priority || 0) - Number(bTab.m_Priority || 0) || a - b;
    });
}

function getContractPoolUnitIds(contractIdOrPoolId) {
  const contract = getContractRecord(contractIdOrPoolId);
  const entries = getContractPoolUnitEntries(contractIdOrPoolId);
  return uniquePositiveInts([
    ...(contract ? getContractAdditionalUnitIds(contract) : []),
    ...entries.map((entry) => entry.unitId),
  ]).filter(isContractRewardUnitId);
}

function getContractPoolUnitEntries(contractIdOrPoolId, options = {}) {
  const data = loadGameData();
  const contract = getContractRecord(contractIdOrPoolId);
  const poolId = contract && contract.m_UnitPoolID != null ? contract.m_UnitPoolID : contractIdOrPoolId;
  let records = data.contractUnitPools.filter((record) => matchesPool(record, poolId));
  if (!records.length) records = data.selectableContractUnitPools.filter((record) => matchesPool(record, poolId));
  const includeOperators = options.includeOperators === true;
  const seen = new Set();
  const entries = [];
  for (const record of records) {
    const unitId = resolveUnitId(record.m_UnitStrId || record.m_UnitID || record.m_UnitId);
    if (!Number.isInteger(unitId) || unitId <= 0 || seen.has(unitId)) continue;
    if (includeOperators ? !isContractRewardOperatorId(unitId) : !isContractRewardUnitId(unitId)) continue;
    seen.add(unitId);
    const unitRecord = getUnitTemplet(unitId) || {};
    entries.push({
      unitId,
      ratio: Math.max(1, Number(record.m_Ratio || 1)),
      grade: normalizeUnitGrade(unitRecord.m_NKM_UNIT_GRADE),
      pickupTarget: record.m_PickupTarget === true || record.m_CustomPickupTarget === true,
      record,
    });
  }
  return entries;
}

function getSelectableContractPoolSlotEntries(contractIdOrPoolId) {
  const data = loadGameData();
  const records = data.selectableContractUnitPools.filter((record) => matchesPool(record, contractIdOrPoolId));
  const bySlot = new Map();
  for (const record of records) {
    const slotNumber = Number(record && record.m_SlotNumber);
    if (!Number.isInteger(slotNumber) || slotNumber <= 0) continue;
    const unitId = resolveUnitId(record.m_UnitStrId || record.m_UnitID || record.m_UnitId);
    if (!Number.isInteger(unitId) || unitId <= 0 || !isContractRewardUnitId(unitId)) continue;
    const unitRecord = getUnitTemplet(unitId) || {};
    const entries = bySlot.get(slotNumber) || [];
    if (entries.some((entry) => Number(entry.unitId) === unitId)) continue;
    entries.push({
      unitId,
      ratio: Math.max(1, Number(record.m_Ratio || 1)),
      grade: normalizeUnitGrade(unitRecord.m_NKM_UNIT_GRADE),
      pickupTarget: record.m_PickupTarget === true || record.m_CustomPickupTarget === true,
      slotNumber,
      record,
    });
    bySlot.set(slotNumber, entries);
  }
  return Array.from(bySlot.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([slotNumber, entries]) => ({ slotNumber, entries }));
}

function isContractRewardUnitId(unitId) {
  const record = getUnitTemplet(unitId);
  if (!record || record.m_bMonster === true) return false;
  const type = String(record.m_NKM_UNIT_TYPE || "");
  const style = String(record.m_NKM_UNIT_STYLE_TYPE || "");
  return type !== "NUT_SYSTEM" && type !== "NUT_SHIP" && type !== "NUT_OPERATOR" && style !== "NUST_TRAINER";
}

function isContractRewardOperatorId(unitId) {
  const record = getUnitTemplet(unitId);
  if (!record || record.m_bMonster === true) return false;
  return String(record.m_NKM_UNIT_TYPE || "") === "NUT_OPERATOR";
}

function normalizeUnitGrade(value) {
  const text = String(value || "").toUpperCase();
  if (text.includes("SSR")) return "SSR";
  if (text.includes("SR")) return "SR";
  if (text.includes("R")) return "R";
  if (text.includes("N")) return "N";
  return "";
}

function getRandomGradeTable(randomGradeIdOrStrId) {
  const data = loadGameData();
  if (randomGradeIdOrStrId == null) return null;
  const asNumber = Number(randomGradeIdOrStrId);
  if (Number.isInteger(asNumber) && data.randomGradeTables.has(asNumber)) return data.randomGradeTables.get(asNumber);
  return data.randomGradeTables.get(String(randomGradeIdOrStrId)) || null;
}

function getMiscContractRecord(contractId) {
  return loadGameData().miscContracts.get(Number(contractId)) || null;
}

function getCustomPickupContractRecords() {
  return loadGameData().customPickupContracts.slice();
}

function getPieceTemplet(itemId) {
  return loadGameData().pieceByItemId.get(Number(itemId)) || null;
}

function getRandomBoxRewards(groupId) {
  return (loadGameData().randomItemBoxes.get(Number(groupId)) || []).slice();
}

function getCustomPackageRewards(groupId) {
  return (loadGameData().customPackageBoxes.get(Number(groupId)) || []).slice();
}

function getCustomBoxTemplet(customBoxId) {
  return loadGameData().customBoxes.get(Number(customBoxId)) || null;
}

function getAcqPackageRewards(packageId) {
  return (loadGameData().acqPackages.get(Number(packageId)) || []).slice();
}

function getRewardGroupRecords(groupId) {
  return (loadGameData().rewardGroups.get(Number(groupId)) || []).slice();
}

function getEquipTemplet(equipId) {
  return loadGameData().equipById.get(Number(equipId)) || null;
}

function getAllEquipIds(options = {}) {
  const includeEnchantModules = options.includeEnchantModules === true;
  return Array.from(loadGameData().equipById.values())
    .filter((record) => includeEnchantModules || String(record.m_ItemEquipPosition || "") !== "IEP_ENCHANT")
    .map((record) => Number(record.m_ItemEquipID))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

function getRandomEquipId(seed = 0, options = {}) {
  const ids = getAllEquipIds(options);
  if (!ids.length) return 0;
  return ids[Math.abs(Number(seed) || 0) % ids.length];
}

function getEquipRandomStatRecords(groupId) {
  return (loadGameData().equipRandomStats.get(Number(groupId)) || []).slice();
}

function getEquipPrecisionWeightRecords(weightId) {
  return (loadGameData().equipPrecisionWeights.get(Number(weightId)) || []).slice();
}

function getAllEquipRandomStatRecords() {
  return Array.from(loadGameData().equipRandomStats.values()).flat().slice();
}

function getEquipSetOptionIds(equipTemplet = null) {
  const explicit = Array.isArray(equipTemplet && equipTemplet.m_SetGroup)
    ? equipTemplet.m_SetGroup.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (explicit.length) return explicit;
  return Array.from(loadGameData().equipSetOptions.keys()).sort((a, b) => a - b);
}

function getEquipSetOption(setOptionId) {
  return loadGameData().equipSetOptions.get(Number(setOptionId)) || null;
}

function getAllEquipSetOptionRecords() {
  return Array.from(loadGameData().equipSetOptions.values()).slice();
}

function getEquipEnchantExpRecord(tier, level) {
  return loadGameData().equipEnchantExp.get(makeEquipEnchantExpKey(tier, level)) || null;
}

function getEquipEnchantRequiredExp(tier, level, grade) {
  const record = getEquipEnchantExpRecord(tier, level);
  if (!record) return -1;
  const suffix = normalizeEquipGradeSuffix(grade);
  const direct = Number(record[`m_ReqLevelupEXP_${suffix}`]);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  return Number(record.m_ReqLevelupEXP_SSR || record.m_ReqLevelupEXP_SR || record.m_ReqLevelupEXP_R || record.m_ReqLevelupEXP_N || -1);
}

function getEquipEnchantFeedExp(equipId, enchantLevel = 0) {
  const templet = getEquipTemplet(equipId);
  if (!templet) return 0;
  const expRecord = getEquipEnchantExpRecord(templet.m_NKM_ITEM_TIER, enchantLevel);
  const bonusRate = Number(expRecord && expRecord.m_ReqEnchantFeedEXPBonusRate);
  const feedExp = Number(templet.m_FeedEXP || 0);
  return Math.max(0, Math.trunc(feedExp * (Number.isFinite(bonusRate) && bonusRate > 0 ? bonusRate : 1)));
}

function getMaxEquipEnchantLevel(tier) {
  let level = 0;
  while (getEquipEnchantExpRecord(tier, level)) level += 1;
  return Math.max(0, level - 1);
}

function getEquipEnchantMaterials() {
  return loadGameData().equipEnchantMaterials.slice();
}

function getEquipMoldTemplet(moldId) {
  return loadGameData().equipMolds.get(Number(moldId)) || null;
}

function getAllEquipMoldTemplets() {
  return Array.from(loadGameData().equipMolds.values()).slice();
}

function getResetCounterGroupTemplet(groupId) {
  return loadGameData().resetCounterGroups.get(Number(groupId)) || null;
}

function getAllResetCounterGroupTemplets() {
  return Array.from(loadGameData().resetCounterGroups.values()).slice();
}

function getIntervalTemplet(strId) {
  return loadGameData().recallIntervalsByStrId.get(String(strId || "")) || null;
}

function getMoldRewardRecords(groupId) {
  return (loadGameData().moldRewardGroups.get(Number(groupId)) || []).slice();
}

function getEquipUpgradeTemplet(coreEquipId) {
  return loadGameData().equipUpgradeByCoreId.get(Number(coreEquipId)) || null;
}

function getEquipPotentialOptionRecords(groupId) {
  return (loadGameData().equipPotentialOptions.get(Number(groupId)) || []).slice();
}

function getRelicRerollCountFactor() {
  return Number(loadGameData().relicRerollCountFactor || 1.63) || 1.63;
}

function getEventDeckTemplet(eventDeckId) {
  return loadGameData().eventDecks.get(Number(eventDeckId)) || null;
}

function getEventDeckUnitSlotTypes(eventDeckId) {
  const eventDeck = getEventDeckTemplet(eventDeckId);
  if (!eventDeck) return [];
  return Array.from({ length: 8 }, (_, index) => String(eventDeck[`SLOT_TYPE_UNIT_${index + 1}`] || "").trim());
}

const EVENT_DECK_OWNED_UNIT_SLOT_TYPES = new Set(["ST_FREE", "ST_FIXED", "ST_FREE_COUNTER", "ST_FREE_SOLDIER", "ST_FREE_MECHANIC"]);

function getEventDeckFreeUnitSlots(eventDeckId) {
  return getEventDeckUnitSlotTypes(eventDeckId)
    .map((slotType, index) => (slotType === "ST_FREE" ? index : -1))
    .filter((index) => index >= 0);
}

function getEventDeckPlayerUnitSlots(eventDeckId) {
  const slotTypes = getEventDeckUnitSlotTypes(eventDeckId);
  const ownedSlots = slotTypes
    .map((slotType, index) => (EVENT_DECK_OWNED_UNIT_SLOT_TYPES.has(slotType) ? index : -1))
    .filter((index) => index >= 0);
  if (!ownedSlots.length) return [];

  const guestReplacementSlots = slotTypes
    .map((slotType, index) => (slotType === "ST_GUEST" ? index : -1))
    .filter((index) => index >= 0);
  return Array.from(new Set([...ownedSlots, ...guestReplacementSlots])).sort((a, b) => a - b);
}

function eventDeckHasGivenUnitSlots(eventDeckId) {
  return getEventDeckUnitSlotTypes(eventDeckId).some((slotType) => slotType === "ST_NPC" || slotType === "ST_GUEST" || slotType === "ST_FIXED");
}

function eventDeckHasFreeShipSlot(eventDeckId) {
  const eventDeck = getEventDeckTemplet(eventDeckId);
  return String(eventDeck && eventDeck.SLOT_TYPE_SHIP).trim() === "ST_FREE";
}

function getSkinTemplet(skinId) {
  return loadGameData().skinById.get(Number(skinId)) || null;
}

function getAllSkinIds() {
  return Array.from(loadGameData().skinById.keys()).sort((a, b) => a - b);
}

function getEmoticonTemplet(emoticonId) {
  return loadGameData().emoticonById.get(Number(emoticonId)) || null;
}

function getAllEmoticonIds() {
  return Array.from(loadGameData().emoticonById.keys()).sort((a, b) => a - b);
}

function getLimitBreakInfo(rank) {
  return loadGameData().limitBreakInfoByRank.get(Number(rank)) || null;
}

function getLimitBreakMaxLevel(rank, fallback = 100) {
  const record = getLimitBreakInfo(rank);
  return Number(record && record.m_iMaxLevel) || Number(fallback) || 100;
}

function getMaxLimitBreakRank(options = {}) {
  const data = loadGameData();
  const maxLevel = Math.max(1, Number(options.maxLevel || 120) || 120);
  let result = 0;
  for (const [rank, record] of data.limitBreakInfoByRank.entries()) {
    const level = Number(record && record.m_iMaxLevel) || 0;
    if (level > 0 && level <= maxLevel && rank > result) result = rank;
  }
  return result || 13;
}

function getLimitBreakSubstituteRecord(style, grade, targetRank) {
  const key = makeLimitBreakSubstituteKey(style, grade, targetRank);
  return loadGameData().limitBreakSubstituteByKey.get(key) || null;
}

function getUnitLimitBreakSubstituteRecord(unitId, targetRank) {
  const templet = getBaseUnitTemplet(unitId) || getUnitTemplet(unitId);
  if (!templet) return null;
  return getLimitBreakSubstituteRecord(templet.m_NKM_UNIT_STYLE_TYPE, templet.m_NKM_UNIT_GRADE, targetRank);
}

function getUnitLimitBreakCosts(unitId, targetRank) {
  const rank = Number(targetRank);
  const info = getLimitBreakInfo(rank);
  const substitute = getUnitLimitBreakSubstituteRecord(unitId, rank);
  if (!info || !substitute) return [];
  const costs = [];
  const credit = Math.max(0, Number(substitute.m_CreditReq) || 0);
  if (credit > 0) costs.push({ itemId: 1, count: credit });
  for (let index = 1; index <= 2; index += 1) {
    const itemId = Number(substitute[`m_ItemID_${index}`] || 0);
    const count = Math.max(0, Number(substitute[`m_ItemCount_${index}`] || 0) || 0);
    if (itemId > 0 && count > 0) costs.push({ itemId, count });
  }
  return mergeItemCosts(costs);
}

function getUnitExpRecord(level) {
  return loadGameData().unitExpTable.get(Number(level)) || null;
}

function getTotalExpForUnitLevel(level) {
  const record = getUnitExpRecord(level);
  return Number(record && record.m_iExpCumulated) || 0;
}

function getUnitLevelByTotalExp(totalExp, maxLevel = 120) {
  const data = loadGameData();
  const exp = Math.max(0, Number(totalExp) || 0);
  const cap = Math.max(1, Number(maxLevel) || 1);
  let result = 1;
  for (const level of Array.from(data.unitExpTable.keys()).sort((a, b) => a - b)) {
    if (level > cap) break;
    const record = data.unitExpTable.get(level);
    const cumulated = Number(record && record.m_iExpCumulated) || 0;
    if (cumulated <= exp) result = level;
    else break;
  }
  if (data.unitExpTable.size > 0) return Math.max(1, Math.min(cap, result));
  return Math.max(1, Math.min(cap, 1 + Math.floor(exp / 100)));
}

function getPlayerExpRecord(level) {
  return loadGameData().playerExpTable.get(Number(level)) || null;
}

function getPlayerTotalExpForLevel(level) {
  const record = getPlayerExpRecord(level);
  return Number(record && record.m_lExpCumulated) || 0;
}

function getPlayerRequiredExpForLevel(level) {
  const record = getPlayerExpRecord(level);
  return Number(record && record.m_lExpRequired) || 0;
}

function getPlayerMaxLevel() {
  const levels = Array.from(loadGameData().playerExpTable.keys());
  if (!levels.length) return 120;
  return Math.max(...levels);
}

function getPlayerLevelByTotalExp(totalExp, maxLevel = getPlayerMaxLevel()) {
  const data = loadGameData();
  const exp = Math.max(0, Number(totalExp) || 0);
  const cap = Math.max(1, Number(maxLevel) || 1);
  let result = 1;
  for (const level of Array.from(data.playerExpTable.keys()).sort((a, b) => a - b)) {
    if (level > cap) break;
    const record = data.playerExpTable.get(level);
    const cumulated = Number(record && record.m_lExpCumulated) || 0;
    if (cumulated <= exp) result = level;
    else break;
  }
  if (data.playerExpTable.size > 0) return Math.max(1, Math.min(cap, result));
  return Math.max(1, Math.min(cap, 1 + Math.floor(exp / 100)));
}

function getOperatorExpRecord(grade, level) {
  const byLevel = loadGameData().operatorExpTable.get(normalizeOperatorGrade(grade));
  return (byLevel && byLevel.get(Number(level))) || null;
}

function getOperatorTotalExpForLevel(grade, level) {
  const record = getOperatorExpRecord(grade, level);
  return Number(record && record.m_iExpCumulatedOpr) || 0;
}

function getOperatorRequiredExpForLevel(grade, level) {
  const record = getOperatorExpRecord(grade, level);
  return Number(record && record.m_iExpRequiredOpr) || 0;
}

function getOperatorMaxLevel(grade) {
  const byLevel = loadGameData().operatorExpTable.get(normalizeOperatorGrade(grade));
  if (!byLevel || byLevel.size <= 0) return 100;
  return Math.max(...Array.from(byLevel.keys()));
}

function getOperatorLevelUpConfig() {
  const config = loadGameData().operatorLevelUpConfig;
  if (!config) return null;
  return {
    maxLevel: config.maxLevel,
    maxMaterialUsageLimit: config.maxMaterialUsageLimit,
    materials: config.materials.map((material) => ({ ...material })),
  };
}

function getOperatorLevelByTotalExp(grade, totalExp, maxLevel = getOperatorMaxLevel(grade)) {
  const byLevel = loadGameData().operatorExpTable.get(normalizeOperatorGrade(grade));
  const exp = Math.max(0, Number(totalExp) || 0);
  const cap = Math.max(1, Number(maxLevel) || 1);
  if (!byLevel || byLevel.size <= 0) return Math.max(1, Math.min(cap, 1 + Math.floor(exp / 100)));

  let result = 1;
  for (const level of Array.from(byLevel.keys()).sort((a, b) => a - b)) {
    if (level > cap) break;
    const record = byLevel.get(level);
    const cumulated = Number(record && record.m_iExpCumulatedOpr) || 0;
    if (cumulated <= exp) result = level;
    else break;
  }
  return Math.max(1, Math.min(cap, result));
}

function getContentUnlocksForDungeon(dungeonId) {
  return (loadGameData().contentUnlocksByDungeonId.get(Number(dungeonId)) || []).slice();
}

function getCounterPassUnlockDungeonIds() {
  const data = loadGameData();
  const ids = data.counterPassUnlockDungeonIds;
  if ((!ids || ids.length === 0) && data.hasCounterPassContentUnlock) return [];
  return (ids && ids.length ? ids : DEFAULT_COUNTER_PASS_UNLOCK_DUNGEON_IDS).slice();
}

function getMissionTemplet(missionId) {
  return loadGameData().missionById.get(Number(missionId)) || null;
}

function getMissionTemplets() {
  return loadGameData().missions.slice();
}

function getMissionTempletsByTabId(tabId) {
  return (loadGameData().missionsByTabId.get(Number(tabId)) || []).slice();
}

function getMissionTempletsByCounterGroupId(groupId) {
  return (loadGameData().missionsByCounterGroupId.get(Number(groupId)) || []).slice();
}

function getMissionTabTemplet(tabId) {
  return loadGameData().missionTabById.get(Number(tabId)) || null;
}

function getMissionTabTemplets() {
  return loadGameData().missionTabs.slice();
}

function getContractAdditionalUnitIds(contract) {
  if (!contract || !contract.m_addUnitStrId) return [];
  const unitId = resolveUnitId(contract.m_addUnitStrId);
  return unitId > 0 ? [unitId] : [];
}

function matchesPool(record, poolId) {
  if (!record || poolId == null) return false;
  const poolText = String(poolId);
  return String(record.m_UnitPoolStrId || "") === poolText || Number(record.m_UnitPoolId) === Number(poolId);
}

function uniquePositiveInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function getContentUnlockType(record) {
  return String(
    (record && (record.eContentsType || record.m_eContentsType || record.m_ContentsType || record.contentsType)) || ""
  ).trim();
}

function normalizeOperatorGrade(grade) {
  return String(grade || "").trim().toUpperCase();
}

function getBaseUnitTemplet(unitId) {
  let current = getUnitTemplet(unitId);
  const seen = new Set();
  while (current && current.m_BaseUnitID != null) {
    const baseId = Number(current.m_BaseUnitID);
    if (!Number.isInteger(baseId) || baseId <= 0 || baseId === Number(current.m_UnitID) || seen.has(baseId)) break;
    seen.add(baseId);
    const base = getUnitTemplet(baseId);
    if (!base) break;
    current = base;
  }
  return current || null;
}

function makeLimitBreakSubstituteKey(style, grade, targetRank) {
  return `${String(style || "").trim()}|${String(grade || "").trim()}|${Number(targetRank) || 0}`;
}

function mergeItemCosts(costs) {
  const byItem = new Map();
  for (const cost of Array.isArray(costs) ? costs : []) {
    const itemId = Number(cost && cost.itemId);
    const count = Math.max(0, Math.trunc(Number(cost && cost.count) || 0));
    if (!Number.isInteger(itemId) || itemId <= 0 || count <= 0) continue;
    byItem.set(itemId, (byItem.get(itemId) || 0) + count);
  }
  return Array.from(byItem.entries())
    .map(([itemId, count]) => ({ itemId, count }))
    .sort((a, b) => a.itemId - b.itemId);
}

function makeEquipEnchantExpKey(tier, level) {
  return `${Number(tier) || 0}:${Number(level) || 0}`;
}

function normalizeEquipGradeSuffix(grade) {
  const text = String(grade || "").toUpperCase();
  if (text.includes("SSR")) return "SSR";
  if (text.includes("SR")) return "SR";
  if (text.includes("R")) return "R";
  return "N";
}

function normalizeEquipEnchantMaterials(moduleConst) {
  const materials = Array.isArray(moduleConst && moduleConst.Materials) ? moduleConst.Materials : [];
  return materials
    .map((entry, index) => ({
      index,
      itemId: Number(entry && entry.ItemId) || 0,
      exp: Math.max(0, Math.trunc(Number(entry && entry.Exp) || 0)),
    }))
    .filter((entry) => entry.itemId > 0 && entry.exp > 0);
}

function normalizeOperatorLevelUpConfig(operatorConst) {
  const negotiation = operatorConst && operatorConst.Negotiation;
  const maxLevel = Math.trunc(Number(operatorConst && operatorConst.Const && operatorConst.Const.MaximumLevel));
  const maxMaterialUsageLimit = Math.trunc(Number(negotiation && negotiation.MaxMaterialUsageLimit));
  const materials = (Array.isArray(negotiation && negotiation.Materials) ? negotiation.Materials : [])
    .map((entry) => ({
      itemId: Number(entry && entry.ItemId),
      exp: Math.trunc(Number(entry && entry.Exp)),
      credit: Math.trunc(Number(entry && entry.Credit)),
    }))
    .filter(
      (entry) =>
        Number.isInteger(entry.itemId) && entry.itemId > 0 &&
        Number.isInteger(entry.exp) && entry.exp > 0 &&
        Number.isInteger(entry.credit) && entry.credit > 0
    );
  if (maxLevel <= 0 || maxMaterialUsageLimit <= 0 || materials.length <= 0) return null;
  return { maxLevel, maxMaterialUsageLimit, materials };
}

function groupByNumber(records, key) {
  const map = new Map();
  for (const record of records) {
    const value = Number(record && record[key]);
    if (!Number.isInteger(value) || value <= 0) continue;
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(record);
  }
  return map;
}

function readRecords(directory, fileName) {
  return readGameplayTableRecords(directory, fileName, { rootDir: ROOT_DIR, logLabel: "game-data" });
}

function readTableObject(directory, fileName) {
  return readGameplayTable(directory, fileName, { rootDir: ROOT_DIR, logLabel: "game-data" });
}

function readMissionRecords(directory, fileName) {
  return readGameplayTableRecords(directory, fileName, { rootDir: ROOT_DIR, logLabel: "game-data" });
}

function parseGameTableDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/);
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number((match[7] || "").slice(0, 3).padEnd(3, "0") || 0)
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

module.exports = {
  loadGameData,
  getMiscItemTemplet,
  getAllMiscItemIds,
  getUnitTemplet,
  getUnitRemoveRewards,
  getUnitExtractRewards,
  getUnitExtractConfig,
  getUnitExtractBonusRewards,
  getCollectionUnitTemplet,
  isCollectionVisibleUnitId,
  getUnitSkillStrId,
  getUnitSkillTemplet,
  getUnitSkillMaxLevel,
  getUnitSkillMaxLevelFromLimitBreakLevel,
  getUnitSkillMaxLevelByStrId,
  getUnitSkillIndex,
  getUnitSkillUpgradeCosts,
  getUnitReactorTemplet,
  getReactorSkillTemplet,
  getUnitRearmamentTemplet,
  getUnitRearmamentCosts,
  getRecallTemplets,
  getActiveRecallTemplet,
  getRecallExchangeUnitIds,
  getFirstLevelShipId,
  getRecallRewardUnitPieceToPoint,
  getOperatorSkillTemplet,
  getOperatorMainSkillId,
  getOperatorEnhanceCost,
  getOperatorEnhanceRates,
  getOperatorPassiveToken,
  getOperatorExtractTokenItemId,
  getOperatorExtractPrice,
  getShipMaxLevel,
  getShipLevelUpCosts,
  getShipBuildTemplet,
  getShipBuildCosts,
  getShipUpgradeCosts,
  getShipLimitBreakTemplet,
  getShipLimitBreakCosts,
  resolveUnitId,
  getPlayableUnitIds,
  getPlayableShipIds,
  getTrophyUnitIds,
  getPlayableOperatorIds,
  getContractRecord,
  getContractTabRecord,
  getSelectableContractRecord,
  getSelectableContractRecords,
  getVisibleContractIds,
  getContractPoolUnitIds,
  getContractPoolUnitEntries,
  getSelectableContractPoolSlotEntries,
  getMiscContractRecord,
  getCustomPickupContractRecords,
  getRandomGradeTable,
  getPieceTemplet,
  getRandomBoxRewards,
  getCustomPackageRewards,
  getCustomBoxTemplet,
  getAcqPackageRewards,
  getRewardGroupRecords,
  getEquipTemplet,
  getAllEquipIds,
  getRandomEquipId,
  getEquipRandomStatRecords,
  getEquipPrecisionWeightRecords,
  getAllEquipRandomStatRecords,
  getEquipSetOptionIds,
  getEquipSetOption,
  getAllEquipSetOptionRecords,
  getEquipEnchantExpRecord,
  getEquipEnchantRequiredExp,
  getEquipEnchantFeedExp,
  getMaxEquipEnchantLevel,
  getEquipEnchantMaterials,
  getEquipMoldTemplet,
  getAllEquipMoldTemplets,
  getResetCounterGroupTemplet,
  getAllResetCounterGroupTemplets,
  getIntervalTemplet,
  parseGameTableDate,
  getMoldRewardRecords,
  getEquipUpgradeTemplet,
  getEquipPotentialOptionRecords,
  getRelicRerollCountFactor,
  getEventDeckTemplet,
  getEventDeckUnitSlotTypes,
  getEventDeckFreeUnitSlots,
  getEventDeckPlayerUnitSlots,
  eventDeckHasGivenUnitSlots,
  eventDeckHasFreeShipSlot,
  getSkinTemplet,
  getAllSkinIds,
  getEmoticonTemplet,
  getAllEmoticonIds,
  getLimitBreakInfo,
  getLimitBreakMaxLevel,
  getMaxLimitBreakRank,
  getLimitBreakSubstituteRecord,
  getUnitLimitBreakSubstituteRecord,
  getUnitLimitBreakCosts,
  getUnitExpRecord,
  getTotalExpForUnitLevel,
  getUnitLevelByTotalExp,
  getPlayerExpRecord,
  getPlayerTotalExpForLevel,
  getPlayerRequiredExpForLevel,
  getPlayerMaxLevel,
  getPlayerLevelByTotalExp,
  getOperatorExpRecord,
  getOperatorTotalExpForLevel,
  getOperatorRequiredExpForLevel,
  getOperatorMaxLevel,
  getOperatorLevelUpConfig,
  getOperatorLevelByTotalExp,
  getContentUnlocksForDungeon,
  getCounterPassUnlockDungeonIds,
  getMissionTemplet,
  getMissionTemplets,
  getMissionTempletsByTabId,
  getMissionTempletsByCounterGroupId,
  getMissionTabTemplet,
  getMissionTabTemplets,
};
