const { randomInt } = require("crypto");
const { grantMiscItem, grantSkin, grantEmoticon, toBigInt } = require("../inventory");
const {
  getMiscItemTemplet,
  getCustomBoxTemplet,
  getRandomBoxRewards,
  getCustomPackageRewards,
  getUnitTemplet,
  getMaxLimitBreakRank,
} = require("../game-data");
const { grantUnit, grantOperator } = require("../unit");
const { grantEquipItem, grantMoldItem } = require("../equipment");

const FALLBACK_RESOURCE_ITEM_ID = Number(process.env.CS_SHOP_FALLBACK_REWARD_ITEM_ID || 1);
const FALLBACK_RESOURCE_COUNT = BigInt(process.env.CS_SHOP_FALLBACK_REWARD_COUNT || 1000);
const MAX_REWARD_EXPANSION_DEPTH = 8;
const UNIT_LEVEL_CAP = 120;
const SHIP_LEVEL_CAP = 130;

function createEmptyReward() {
  return {
    miscItems: [],
    skinIds: [],
    emoticonIds: [],
    units: [],
    operators: [],
    equips: [],
    moldItems: [],
    interiors: [],
  };
}

function mergeReward(target, source) {
  const result = target || createEmptyReward();
  const incoming = source || createEmptyReward();
  for (const key of ["miscItems", "skinIds", "emoticonIds", "units", "operators", "equips", "moldItems", "interiors"]) {
    if (!Array.isArray(result[key])) result[key] = [];
    if (Array.isArray(incoming[key])) result[key].push(...incoming[key]);
  }
  return result;
}

function grantRewardByType(ctx, user, rewardType, rewardId, value = 1, freeValue = null, paidValue = 0, options = {}) {
  const reward = createEmptyReward();
  const type = String(rewardType || "");
  const id = Number(rewardId);
  const count = toBigInt(value == null ? 1 : value, 1n);
  const free = freeValue == null ? count : toBigInt(freeValue, count);
  const paid = toBigInt(paidValue || 0, 0n);
  const regDate = options.regDate || (ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n);

  if (!Number.isInteger(id) || id <= 0) return reward;

  if (type === "RT_MISC" || type === "RT_ITEM_MISC" || type === "RT_RESOURCE") {
    if (options.expandPackages !== false) {
      const expanded = expandMiscItemReward(ctx, user, id, Number(count > 0n ? count : 1n), {
        ...options,
        depth: Number(options.depth || 0),
        regDate,
      });
      if (expanded) return expanded;
    }
    const { isOfficeInteriorItem, grantOfficeInterior } = require("../office");
    if (isOfficeInteriorItem(id)) {
      const interior = grantOfficeInterior(user, id, count);
      if (interior) reward.interiors.push(interior);
      return reward;
    }
    const granted = grantMiscItem(user, id, free, paid, { regDate });
    if (granted) reward.miscItems.push(granted);
  } else if (type === "RT_UNIT" || type === "RT_SHIP") {
    const unitOptions = buildSelectorUnitGrantOptions(type, id, options);
    for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
      const unit = grantUnit(user, id, { regDate, fromContract: options.fromContract !== false, ...unitOptions });
      if (unit) reward.units.push(unit);
    }
  } else if (type === "RT_OPERATOR") {
    const operatorOptions = buildSelectorOperatorGrantOptions(id, options);
    for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
      const operator = grantOperator(user, id, { ...options, ...operatorOptions, regDate, fromContract: options.fromContract !== false });
      if (operator) reward.operators.push(operator);
    }
  } else if (type === "RT_EQUIP" || type === "RT_ITEM_EQUIP" || type === "RT_EQUIP_ITEM") {
    for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
      const equip = grantEquipItem(user, id, { ...options, regDate, cursor: index });
      if (equip) reward.equips.push(equip);
    }
  } else if (type === "RT_MOLD") {
    const mold = grantMoldItem(user, id, count);
    if (mold) reward.moldItems.push(mold);
  } else if (type === "RT_SKIN") {
    const skinId = grantSkin(user, id);
    if (skinId) reward.skinIds.push(skinId);
  } else if (type === "RT_EMOTICON") {
    const emoticonId = grantEmoticon(user, id);
    if (emoticonId) reward.emoticonIds.push(emoticonId);
  } else if (type === "RT_INTERIOR" || type === "RT_ITEM_INTERIOR") {
    const { grantOfficeInterior } = require("../office");
    const interior = grantOfficeInterior(user, id, count);
    if (interior) reward.interiors.push(interior);
  } else {
    const granted = grantMiscItem(user, FALLBACK_RESOURCE_ITEM_ID, FALLBACK_RESOURCE_COUNT, 0n, { regDate });
    if (granted) reward.miscItems.push(granted);
  }

  return reward;
}

function expandMiscItemReward(ctx, user, itemId, count = 1, options = {}) {
  const depth = Number(options.depth || 0);
  if (depth >= MAX_REWARD_EXPANSION_DEPTH) return null;

  const item = getMiscItemTemplet(itemId);
  if (!item) return null;

  const type = String(item.m_ItemMiscType || "");
  const groupId = Number(item.m_RewardGroupID || 0);
  const regDate = options.regDate || (ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n);
  const total = createEmptyReward();

  if (type === "IMT_CONTRACT") {
    const contractId = Number(item.m_typeValue || item.m_RewardGroupID || 0);
    const { openMiscContract } = require("../contract");
    for (let index = 0; index < Math.max(1, count); index += 1) {
      mergeReward(total, openMiscContract(ctx, user, contractId || itemId, { sourceMiscItemId: itemId, regDate }).reward);
    }
    return total;
  }

  if (type === "IMT_CUSTOM_PACKAGE") {
    const selected = Array.isArray(options.selectedCustomPackageRewards)
      ? options.selectedCustomPackageRewards
      : null;
    const groups = normalizeNumberList(item.m_CustomRewardGroupID);
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const records = selected || groups.flatMap((customGroupId) => getCustomPackageRewards(customGroupId));
      for (const record of records) {
        mergeReward(total, grantRewardRecord(ctx, user, record, { ...options, depth: depth + 1, regDate, sourceItem: item }));
      }
    }
    return total;
  }

  if (type === "IMT_PACKAGE" && groupId > 0) {
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const records = getRandomBoxRewards(groupId);
      for (const record of records) {
        mergeReward(total, grantRewardRecord(ctx, user, record, { ...options, depth: depth + 1, regDate, sourceItem: item }));
      }
    }
    return total;
  }

  if (type === "IMT_RANDOMBOX" && groupId > 0) {
    if (options.openRandomBoxes !== true || depth > 0) return null;
    for (let index = 0; index < Math.max(1, count); index += 1) {
      const selected = pickWeightedRecord(getRandomBoxRewards(groupId), options.randomInt);
      if (selected) {
        mergeReward(
          total,
          grantRewardRecord(ctx, user, selected, {
            ...options,
            depth: depth + 1,
            regDate,
            rollRewardRanges: true,
            sourceItem: item,
          })
        );
      }
    }
    return total;
  }

  if (type.startsWith("IMT_CHOICE_") && groupId > 0) {
    if (!options.openChoiceItems) return null;
    const selected = resolveChoiceRewardRecord(itemId, options.rewardId || options.choiceRewardId || 0);
    if (!selected) return null;
    for (let index = 0; index < Math.max(1, count); index += 1) {
      mergeReward(total, grantRewardRecord(ctx, user, selected, { ...options, depth: depth + 1, regDate, sourceItem: item }));
    }
    return total;
  }

  return null;
}

function resolveCustomPackageRewardSelection(item, selectIndices, options = {}) {
  if (!item || String(item.m_ItemMiscType || "") !== "IMT_CUSTOM_PACKAGE") return [];
  const groups = normalizeNumberList(item.m_CustomRewardGroupID);
  const selections = Array.isArray(selectIndices) ? selectIndices.map(Number) : [];
  if (selections.length !== groups.length) return null;
  const countryTag = String(options.countryTag || "KOR").trim().toUpperCase();
  const selected = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const selectionIndex = selections[groupIndex];
    if (!Number.isInteger(selectionIndex) || selectionIndex < 0) return null;
    const records = getCustomPackageRewards(groups[groupIndex])
      .filter((record) => isRewardRecordForCountry(record, countryTag))
      .sort((left, right) => Number(left.m_Index || 0) - Number(right.m_Index || 0));
    const record = records[selectionIndex];
    if (!record || Number(record.m_Index) !== selectionIndex) return null;
    if (typeof options.isRecordEnabled === "function" && !options.isRecordEnabled(record)) return null;
    selected.push(record);
  }
  return selected;
}

function isRewardRecordForCountry(record, countryTag) {
  const aliases = countryTag === "KOR" || countryTag === "KR"
    ? new Set(["KOR", "KR", "GLOBAL"])
    : countryTag === "TW" || countryTag === "TWN"
      ? new Set(["TW", "TWN", "GLOBAL"])
      : new Set([countryTag, "GLOBAL"]);
  const countryTags = new Set(["GLOBAL", "KOR", "KR", "JPN", "CHN", "SEA", "TW", "TWN"]);
  const allow = normalizeStringList(record && record.listContentsTagAllow);
  const ignore = normalizeStringList(record && record.listContentsTagIgnore);
  if (ignore.some((tag) => aliases.has(tag))) return false;
  const regionalAllow = allow.filter((tag) => countryTags.has(tag));
  return regionalAllow.length === 0 || regionalAllow.some((tag) => aliases.has(tag));
}

function normalizeStringList(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter(Boolean);
}

function grantChoiceItemReward(ctx, user, itemId, rewardId, count = 1, options = {}) {
  const total = createEmptyReward();
  const selected = resolveChoiceRewardRecord(itemId, rewardId);
  if (!selected) return total;
  const sourceItem = getMiscItemTemplet(itemId);
  const regDate = options.regDate || (ctx && ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : 0n);
  for (let index = 0; index < Math.max(1, Number(count) || 1); index += 1) {
    mergeReward(
      total,
      grantRewardRecord(ctx, user, selected, {
        ...options,
        depth: Number(options.depth || 0),
        regDate,
        cursor: index,
        sourceItem,
      })
    );
  }
  return total;
}

function resolveChoiceRewardRecord(itemId, rewardId = 0) {
  const requestedId = Number(rewardId || 0);
  const records = getChoiceRewardRecords(itemId);
  if (!records.length) return null;
  if (requestedId > 0) {
    const matched = records.find((record) => Number(record && record.m_RewardID) === requestedId);
    if (matched) return matched;
  }
  return records[0];
}

function getChoiceRewardRecords(itemId) {
  const item = getMiscItemTemplet(itemId);
  if (!item) return [];
  const type = String(item.m_ItemMiscType || "");
  if (!type.startsWith("IMT_CHOICE_")) return [];
  const expectedTypes = getChoiceRewardTypes(type);
  const groupIds = Array.from(
    new Set([
      ...normalizeNumberList(item.m_RewardGroupID),
      ...normalizeNumberList(item.m_CustomRewardGroupID),
    ])
  );
  const records = [];
  for (const groupId of groupIds) {
    records.push(...getRandomBoxRewards(groupId));
    records.push(...getCustomPackageRewards(groupId));
  }
  return records
    .filter((record) => {
      if (!record || !record.m_RewardID) return false;
      if (!expectedTypes.length) return true;
      return expectedTypes.includes(normalizeRewardType(record.m_RewardType));
    })
    .sort(compareChoiceRecords);
}

function getChoiceRewardTypes(itemMiscType) {
  switch (String(itemMiscType || "")) {
    case "IMT_CHOICE_UNIT":
      return ["RT_UNIT"];
    case "IMT_CHOICE_SHIP":
      return ["RT_SHIP"];
    case "IMT_CHOICE_OPERATOR":
      return ["RT_OPERATOR"];
    case "IMT_CHOICE_EQUIP":
      return ["RT_EQUIP"];
    case "IMT_CHOICE_SKIN":
      return ["RT_SKIN"];
    case "IMT_CHOICE_MISC":
      return ["RT_MISC", "RT_RESOURCE"];
    default:
      return [];
  }
}

function normalizeRewardType(rewardType) {
  const type = String(rewardType || "");
  if (type === "RT_ITEM_MISC") return "RT_MISC";
  if (type === "RT_ITEM_EQUIP" || type === "RT_EQUIP_ITEM") return "RT_EQUIP";
  return type;
}

function compareChoiceRecords(left, right) {
  const leftOrder = Number(left && (left.m_OrderList || left.m_Order || left.m_Index || 0)) || 0;
  const rightOrder = Number(right && (right.m_OrderList || right.m_Order || right.m_Index || 0)) || 0;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return Number(left && left.m_RewardID) - Number(right && right.m_RewardID);
}

function grantRewardRecord(ctx, user, record, options = {}) {
  if (!record) return createEmptyReward();
  const amounts = options.rollRewardRanges ? rollRewardAmounts(record, options.randomInt) : null;
  return grantRewardByType(
    ctx,
    user,
    record.m_RewardType,
    record.m_RewardID,
    amounts ? amounts.total : record.m_RewardValue != null ? record.m_RewardValue : record.m_Quantity_Min || record.m_FreeQuantity_Min || 1,
    amounts ? amounts.free : record.m_FreeValue != null ? record.m_FreeValue : record.m_FreeQuantity_Min,
    amounts ? amounts.paid : record.m_PaidValue != null ? record.m_PaidValue : record.m_PaidQuantity_Min || 0,
    {
      ...options,
      enchantExp: options.rollRewardRanges ? rollRecordRange(record, "m_EquipExp", 0, options.randomInt) : options.enchantExp,
      rewardRecord: record,
    }
  );
}

function pickWeightedRecord(records, random = randomInt) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return null;
  const totalWeight = list.reduce((sum, record) => sum + Math.max(0, Math.trunc(Number(record.m_Ratio) || 0)), 0);
  if (totalWeight <= 0) return list[0];

  let target = random(totalWeight);
  for (const record of list) {
    target -= Math.max(0, Math.trunc(Number(record.m_Ratio) || 0));
    if (target < 0) return record;
  }
  return list[0];
}

function rollRewardAmounts(record, random) {
  const total = rollRecordRange(record, "m_Quantity", 1, random);
  const paid = rollRecordRange(record, "m_PaidQuantity", 0, random);
  const free = hasRecordRange(record, "m_FreeQuantity")
    ? sameRecordRange(record, "m_Quantity", "m_FreeQuantity")
      ? total
      : rollRecordRange(record, "m_FreeQuantity", Math.max(0, total - paid), random)
    : Math.max(0, total - paid);
  return { total, free, paid };
}

function rollRecordRange(record, prefix, fallback, random = randomInt) {
  if (!hasRecordRange(record, prefix)) return fallback;
  const min = Math.max(0, Math.trunc(Number(record[`${prefix}_Min`]) || 0));
  const max = Math.max(min, Math.trunc(Number(record[`${prefix}_Max`]) || min));
  return min === max ? min : min + random(max - min + 1);
}

function hasRecordRange(record, prefix) {
  return record[`${prefix}_Min`] != null || record[`${prefix}_Max`] != null;
}

function sameRecordRange(record, left, right) {
  return Number(record[`${left}_Min`]) === Number(record[`${right}_Min`]) && Number(record[`${left}_Max`]) === Number(record[`${right}_Max`]);
}

function normalizeNumberList(value) {
  if (Array.isArray(value)) return value.map(Number).filter((entry) => Number.isInteger(entry) && entry > 0);
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? [number] : [];
}

function buildSelectorUnitGrantOptions(rewardType, rewardId, options = {}) {
  const sourceItem = options.sourceItem || getMiscItemTemplet(options.sourceItemId || options.itemId || 0) || {};
  const customBox = getCustomBoxTemplet(sourceItem.m_CustomBoxID);
  if (customBox) {
    const level = Math.max(1, Number(customBox.Level || 1));
    const skillLevel = Math.max(1, Number(customBox.SkillLevel || 1));
    return {
      level,
      maxLevelOverride: level,
      limitBreakLevel: Math.max(0, Number(customBox.LimitBreak || 0)),
      tacticLevel: Math.max(0, Number(customBox.TacticUpdate || 0)),
      reactorLevel: Math.max(0, Number(customBox.ReactorLevel || 0)),
      loyalty: Math.max(0, Number(customBox.Loyalty || 0)),
      skillLevels: [skillLevel, skillLevel, skillLevel, skillLevel, skillLevel],
    };
  }
  const rewardRecord = options.rewardRecord || {};
  const text = [
    sourceItem.m_ItemMiscType,
    sourceItem.m_ItemMiscStrID,
    sourceItem.m_ItemMiscName,
    sourceItem.m_ItemMiscDesc,
    rewardRecord.m_RewardGroupStrID,
    rewardRecord.m_RewardStrID,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
  const type = String(rewardType || "");
  const unitTemplet = getUnitTemplet(rewardId) || {};
  const isShip = type === "RT_SHIP" || String(unitTemplet.m_NKM_UNIT_TYPE || "") === "NUT_SHIP";
  const isAwakenedSelector = !isShip && (unitTemplet.m_bAwaken === true || /\bASSR\b|AWAKEN|CLASSIFIED/.test(text));
  const level = inferSelectorLevel(text, isShip);
  const hasMaxMarker = /\bMAX\b|_MAX|MAX_/.test(text);
  const shouldMaxGrowth = hasMaxMarker || isAwakenedSelector || (isShip ? level >= 130 : level >= 110);
  if (level <= 0 && !hasMaxMarker && !isAwakenedSelector) return {};

  const grantOptions = {};
  if (level > 0) {
    grantOptions.level = level;
    grantOptions.maxLevelOverride = level;
  } else if (isShip) {
    grantOptions.level = SHIP_LEVEL_CAP;
    grantOptions.maxLevelOverride = SHIP_LEVEL_CAP;
  } else {
    const selectorCap = isAwakenedSelector ? UNIT_LEVEL_CAP : 110;
    grantOptions.level = selectorCap;
    grantOptions.maxLevelOverride = selectorCap;
  }
  if (shouldMaxGrowth) {
    grantOptions.limitBreakLevel = isShip
      ? 6
      : getUnitLimitBreakRankForLevel(grantOptions.maxLevelOverride || UNIT_LEVEL_CAP);
    grantOptions.skillLevels = [5, 5, 5, 5, 5];
  }
  return grantOptions;
}

function buildSelectorOperatorGrantOptions(_rewardId, options = {}) {
  const sourceItem = options.sourceItem || getMiscItemTemplet(options.sourceItemId || options.itemId || 0) || {};
  const customBox = getCustomBoxTemplet(sourceItem.m_CustomBoxID);
  if (!customBox) return {};
  return {
    level: Math.max(1, Number(customBox.Level || 1)),
    mainSkillLevel: Math.max(1, Number(customBox.TacticUpdate || 1)),
    subSkillLevel: Math.max(1, Number(customBox.SkillLevel || 1)),
  };
}

function getUnitLimitBreakRankForLevel(level) {
  const maxLevel = Math.max(1, Number(level) || UNIT_LEVEL_CAP);
  if (maxLevel < 100) return 0;
  return getMaxLimitBreakRank({ maxLevel });
}

function inferSelectorLevel(text, isShip) {
  const levelMatch = String(text || "").match(/(?:LV|LEVEL)[^0-9]{0,8}([0-9]{2,3})/);
  if (levelMatch) return Number(levelMatch[1]) || 0;
  return 0;
}

module.exports = {
  FALLBACK_RESOURCE_ITEM_ID,
  FALLBACK_RESOURCE_COUNT,
  createEmptyReward,
  mergeReward,
  grantRewardByType,
  grantRewardRecord,
  grantChoiceItemReward,
  resolveChoiceRewardRecord,
  getChoiceRewardRecords,
  resolveCustomPackageRewardSelection,
  expandMiscItemReward,
};
